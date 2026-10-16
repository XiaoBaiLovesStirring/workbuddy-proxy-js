#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全量验证：以 SSE 流式为主，模拟真实 Agent 多轮工具调用循环
仅使用 deepseek-v4.1-flash（低成本模型）
"""
import json, time, urllib.request, sys, re

BASE = 'http://127.0.0.1:8788/v1/chat/completions'
MODEL = 'deepseek-v4.1-flash'

TOOLS = [
    {"type": "function", "function": {
        "name": "search_web", "description": "搜索网络信息",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "topic": {"type": "string", "description": "主题分类"}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "get_weather", "description": "查询指定城市天气",
        "parameters": {"type": "object", "properties": {
            "city": {"type": "string", "description": "城市名"}},
            "required": ["city"]}}},
    {"type": "function", "function": {
        "name": "read_file", "description": "读取本地文件内容",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "文件路径"}},
            "required": ["path"]}}},
]

LEAK_RE = re.compile(r'DSML|<tool_call|</tool_call|<\/?\|+DSML', re.I)

class Result:
    def __init__(self):
        self.calls = 0
        self.fails = []
        self.rounds = 0
    def fail(self, msg):
        self.fails.append(msg)
        print(f"   \033[31m✗ {msg}\033[0m")

R = Result()


def sse_stream(body):
    """SSE 流式请求，返回 (content, tool_calls, finish, meta)"""
    body = dict(body); body['stream'] = True
    req = urllib.request.Request(BASE, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    R.calls += 1
    t0 = time.time()
    first_bytes_at = None
    content = ''
    tc_map = {}
    finish = None
    n_chunks = 0
    done = False
    resp = urllib.request.urlopen(req, timeout=180)
    for raw in resp:
        line = raw.decode('utf-8', 'replace').rstrip('\n')
        if not line.startswith('data:'):
            continue
        payload = line[5:].strip()
        if payload == '[DONE]':
            done = True
            break
        try:
            obj = json.loads(payload)
        except Exception:
            continue
        choice = obj['choices'][0]
        delta = choice.get('delta') or {}
        if delta.get('content'):
            if first_bytes_at is None:
                first_bytes_at = time.time() - t0
            content += delta['content']
            n_chunks += 1
        for tc in (delta.get('tool_calls') or []):
            i = tc.get('index', 0)
            e = tc_map.setdefault(i, {'id': None, 'name': '', 'args': ''})
            if tc.get('id'):
                e['id'] = tc['id']
            f = tc.get('function') or {}
            if f.get('name'):
                e['name'] = f['name']
            if f.get('arguments'):
                e['args'] += f['arguments']
        if choice.get('finish_reason'):
            finish = choice['finish_reason']
    meta = {'ttfb': first_bytes_at, 'n_content_chunks': n_chunks,
            'elapsed': time.time() - t0, 'done': done}
    tool_calls = [{'id': e['id'] or f'call_{i}', 'type': 'function',
                   'function': {'name': e['name'], 'arguments': e['args']}}
                  for i, e in sorted(tc_map.items())]
    return content, tool_calls, finish, meta


def nonstream(body):
    body = dict(body); body['stream'] = False
    req = urllib.request.Request(BASE, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    R.calls += 1
    d = json.loads(urllib.request.urlopen(req, timeout=180).read())
    if 'error' in d:
        return '', [], None, {'error': d['error'].get('message', '')}
    m = d['choices'][0]['message']
    return (m.get('content') or ''), (m.get('tool_calls') or []), d['choices'][0]['finish_reason'], {}


def audit(tag, content, tool_calls, finish, meta, expect_stream=True):
    bad = False
    if content and LEAK_RE.search(content):
        R.fail(f"{tag}: 正文泄漏工具标记 -> {content[:120]!r}"); bad = True
    for tc in tool_calls:
        if not tc['function']['name']:
            R.fail(f"{tag}: tool_call 缺 name"); bad = True
        try:
            args = json.loads(tc['function']['arguments'] or '{}')
            if not isinstance(args, dict):
                R.fail(f"{tag}: arguments 不是对象"); bad = True
        except Exception:
            R.fail(f"{tag}: arguments 非法 JSON -> {tc['function']['arguments'][:80]!r}"); bad = True
    if finish not in ('stop', 'tool_calls', None):
        R.fail(f"{tag}: 异常 finish_reason = {finish}"); bad = True
    if expect_stream:
        if not meta.get('done'):
            R.fail(f"{tag}: 未收到 [DONE]"); bad = True
        if 'error' in meta:
            R.fail(f"{tag}: {meta['error']}"); bad = True
    return not bad


# ---------- 假工具执行 ----------
def run_tool(name, args):
    if name == 'search_web':
        return json.dumps({"results": [f"关于「{args.get('query','')}」的资料：蓝色大肥鱼是网友给 AI 起的昵称。"],
                           "count": 1}, ensure_ascii=False)
    if name == 'get_weather':
        return json.dumps({"city": args.get('city', '?'), "temp": 22, "desc": "晴"}, ensure_ascii=False)
    if name == 'read_file':
        return json.dumps({"path": args.get('path', '?'), "content": "hello world"}, ensure_ascii=False)
    return json.dumps({"error": f"unknown tool {name}"})


def agent_loop(task, max_rounds=8, sys_prompt=None):
    print(f"\n\033[1m【Agent 循环 · SSE 流式】任务: {task}\033[0m")
    msgs = []
    if sys_prompt:
        msgs.append({"role": "system", "content": sys_prompt})
    msgs.append({"role": "user", "content": task})
    for rnd in range(max_rounds):
        content, tcs, finish, meta = sse_stream({"model": MODEL, "messages": msgs, "tools": TOOLS})
        R.rounds += 1
        ok = audit(f"轮{rnd+1}", content, tcs, finish, meta)
        names = [t['function']['name'] for t in tcs]
        ttfb = f"{meta.get('ttfb'):.2f}s" if meta.get('ttfb') else "—"
        print(f"  轮{rnd+1}: finish={finish} tools={names} chunks={meta.get('n_content_chunks')} "
              f"ttfb={ttfb} 耗时={meta.get('elapsed',0):.2f}s")
        if content:
            print(f"         正文: {content.strip()[:90]!r}")
        if not ok:
            return False
        if finish != 'tool_calls' or not tcs:
            print(f"  \033[32m✓ 循环结束（{rnd+1} 轮）\033[0m")
            return True
        # 回填 tool 结果，继续下一轮
        msgs.append({"role": "assistant", "content": content or None, "tool_calls": tcs})
        for tc in tcs:
            try:
                args = json.loads(tc['function']['arguments'] or '{}')
            except Exception:
                args = {}
            out = run_tool(tc['function']['name'], args)
            msgs.append({"role": "tool", "tool_call_id": tc['id'],
                         "name": tc['function']['name'], "content": out})
    R.fail(f"任务「{task}」超过 {max_rounds} 轮仍未结束")
    return False


# ==================== 开跑 ====================
t_start = time.time()
print("=" * 70)
print(" 全量验证开始 · 模型: %s · 模式: SSE 流式优先" % MODEL)
print("=" * 70)

# 1. Agent 循环（带工具）
agent_loop("搜索一下 蓝色大肥鱼 是什么，然后告诉我它的别称")

# 2. Agent 循环 + 第三方 Agent system prompt（触发提示词清洗，验证清洗与工具共存）
agent_loop("查一下北京天气", sys_prompt="You are Claude Code, Anthropic's official CLI for Claude.\nYou are a coding agent running in the Codex CLI, a terminal-based coding assistant.")

# 3. Agent 循环 + 多工具混合
agent_loop("先读取 /tmp/a.txt，再搜索 '蓝色大肥鱼'，最后总结")

# 4. 无工具纯对话（流式）
print(f"\n\033[1m【无工具 · SSE 流式】\033[0m")
c, tc, fr, meta = sse_stream({"model": MODEL, "messages": [{"role": "user", "content": "用两句话介绍杭州"}]})
audit("无工具流式", c, tc, fr, meta)
print(f"  finish={fr} chunks={meta.get('n_content_chunks')} ttfb={meta.get('ttfb') and round(meta['ttfb'],2)}s")
print(f"  正文: {c.strip()[:120]!r}")

# 5. tool_choice=none（不应注入工具）
print(f"\n\033[1m【tool_choice=none · SSE 流式】\033[0m")
c, tc, fr, meta = sse_stream({"model": MODEL, "messages": [{"role": "user", "content": "你好"}],
                              "tools": TOOLS, "tool_choice": "none"})
audit("tool_choice=none", c, tc, fr, meta)
print(f"  finish={fr} tools={len(tc)} 正文: {c.strip()[:80]!r}")

# 6. 非流式回退：工具调用
print(f"\n\033[1m【非流式回退 · 工具调用】\033[0m")
c, tc, fr, meta = nonstream({"model": MODEL, "messages": [{"role": "user", "content": "搜索 蓝色大肥鱼"}], "tools": TOOLS})
audit("非流式工具", c, tc, fr, meta, expect_stream=False)
print(f"  finish={fr} tools={[t['function']['name'] for t in tc]} 正文={c.strip()[:80]!r}")

# 7. 非流式回退：多轮 tool 结果回传
print(f"\n\033[1m【非流式回退 · 多轮 tool 回传】\033[0m")
msgs = [{"role": "user", "content": "北京天气怎么样"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_x", "type": "function",
             "function": {"name": "get_weather", "arguments": '{"city":"北京"}'}}]},
        {"role": "tool", "tool_call_id": "call_x", "name": "get_weather",
         "content": '{"temp":22,"desc":"晴"}'}]
c, tc, fr, meta = nonstream({"model": MODEL, "messages": msgs, "tools": TOOLS})
audit("非流式多轮", c, tc, fr, meta, expect_stream=False)
print(f"  finish={fr} 正文={c.strip()[:100]!r}")

# ==================== 汇总 ====================
print("\n" + "=" * 70)
print(f" 总请求数: {R.calls} | Agent 轮次: {R.rounds} | 耗时: {time.time()-t_start:.1f}s")
if R.fails:
    print(f" \033[31m失败 {len(R.fails)} 项:\033[0m")
    for f in R.fails:
        print("   -", f)
    print("=" * 70)
    sys.exit(1)
print(" \033[32m全部通过：无标记泄漏 / 工具调用格式合法 / 流式正常\033[0m")
print("=" * 70)
