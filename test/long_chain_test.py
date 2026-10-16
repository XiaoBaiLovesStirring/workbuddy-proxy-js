#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
长链 Agent 循环验证（SSE 流式）
模拟真实 Agent（Cline / Claude Code 风格）的连续多步工具调用，
目标：把调用量打到十余次，重点压测流式下工具调用的稳定性与不泄漏。
仅使用 deepseek-v4.1-flash。
"""
import json, time, urllib.request, re, sys

BASE = 'http://127.0.0.1:8788/v1/chat/completions'
MODEL = 'deepseek-v4.1-flash'
LEAK_RE = re.compile(r'DSML|<tool_call|</tool_call|<\/?\|+DSML', re.I)

TOOLS = [
    {"type": "function", "function": {"name": "search_web", "description": "搜索网络信息",
     "parameters": {"type": "object", "properties": {
         "query": {"type": "string"}, "topic": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "read_file", "description": "读取文件",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "write_file", "description": "写入文件",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "run_command", "description": "执行命令",
     "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]}}},
]

calls = 0
fails = []
stats = {'content_chunks': 0, 'tool_calls': 0, 'rounds': 0, 'ttfb': []}


def sse(body):
    global calls
    body = dict(body); body['stream'] = True
    req = urllib.request.Request(BASE, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    calls += 1
    t0 = time.time(); ttfb = None; content = ''; tcm = {}; finish = None; done = False
    for raw in urllib.request.urlopen(req, timeout=180):
        line = raw.decode('utf-8', 'replace').rstrip('\n')
        if not line.startswith('data:'):
            continue
        p = line[5:].strip()
        if p == '[DONE]':
            done = True; break
        try:
            o = json.loads(p)
        except Exception:
            continue
        ch = o['choices'][0]; d = ch.get('delta') or {}
        if d.get('content'):
            if ttfb is None:
                ttfb = time.time() - t0
            content += d['content']; stats['content_chunks'] += 1
        for t in (d.get('tool_calls') or []):
            i = t.get('index', 0)
            e = tcm.setdefault(i, {'id': None, 'name': '', 'args': ''})
            if t.get('id'): e['id'] = t['id']
            f = t.get('function') or {}
            if f.get('name'): e['name'] = f['name']
            if f.get('arguments'): e['args'] += f['arguments']
        if ch.get('finish_reason'):
            finish = ch['finish_reason']
    tcs = [{'id': e['id'] or f'call_{i}', 'type': 'function',
            'function': {'name': e['name'], 'arguments': e['args']}}
           for i, e in sorted(tcm.items())]
    return content, tcs, finish, {'ttfb': ttfb, 'done': done, 'elapsed': time.time() - t0}


def audit(tag, c, tcs, finish, meta):
    ok = True
    if c and LEAK_RE.search(c):
        fails.append(f"{tag}: 泄漏 {c[:100]!r}"); ok = False
    if not meta['done']:
        fails.append(f"{tag}: 无 [DONE]"); ok = False
    for t in tcs:
        if not t['function']['name']:
            fails.append(f"{tag}: 缺 tool name"); ok = False
        try:
            a = json.loads(t['function']['arguments'] or '{}')
            if not isinstance(a, dict):
                fails.append(f"{tag}: arguments 非对象"); ok = False
        except Exception:
            fails.append(f"{tag}: arguments 非法 -> {t['function']['arguments'][:60]!r}"); ok = False
    return ok


def run_tool(name, a):
    if name == 'search_web':
        return json.dumps({"results": [f"「{a.get('query','')}」的相关资料"], "count": 1}, ensure_ascii=False)
    if name == 'read_file':
        return json.dumps({"path": a.get('path'), "content": "file body here"}, ensure_ascii=False)
    if name == 'write_file':
        return json.dumps({"ok": True, "path": a.get('path')}, ensure_ascii=False)
    if name == 'run_command':
        return json.dumps({"stdout": "command finished", "code": 0}, ensure_ascii=False)
    return json.dumps({"error": "unknown"})


def long_chain(task, max_rounds=10):
    print(f"\n\033[1m【长链 Agent 循环】{task}\033[0m")
    msgs = [{"role": "system", "content": "You are a coding agent. Use the provided tools to complete the task step by step."},
            {"role": "user", "content": task}]
    for r in range(max_rounds):
        c, tcs, fr, meta = sse({"model": MODEL, "messages": msgs, "tools": TOOLS})
        stats['rounds'] += 1
        if meta['ttfb']:
            stats['ttfb'].append(meta['ttfb'])
        names = [t['function']['name'] for t in tcs]
        stats['tool_calls'] += len(tcs)
        audit(f"{task}#{r+1}", c, tcs, fr, meta)
        tb = f"{meta['ttfb']:.2f}s" if meta['ttfb'] else "—"
        print(f"  轮{r+1}: finish={fr} tools={names} ttfb={tb} 耗时={meta['elapsed']:.2f}s")
        if c:
            print(f"         正文: {c.strip()[:80]!r}")
        if fr != 'tool_calls' or not tcs:
            print(f"  \033[32m✓ 结束于第 {r+1} 轮\033[0m")
            return
        msgs.append({"role": "assistant", "content": c or None, "tool_calls": tcs})
        for t in tcs:
            try:
                a = json.loads(t['function']['arguments'] or '{}')
            except Exception:
                a = {}
            msgs.append({"role": "tool", "tool_call_id": t['id'],
                         "name": t['function']['name'], "content": run_tool(t['function']['name'], a)})
    fails.append(f"{task}: 超过 {max_rounds} 轮")


t0 = time.time()
agent_tasks = [
    "请依次完成：1) 读取 /tmp/proj/main.py；2) 搜索 'python asyncio 超时'; 3) 把结论写入 /tmp/proj/notes.md；4) 运行 pytest；最后总结你做了什么。",
    "帮我调研 '蓝色大肥鱼'：先搜索它是什么，再搜索它的别称，然后把结果写入 /tmp/report.md。",
    "依次：搜索 '杭州天气'，读取 /tmp/a.txt，运行 `ls -la`，最后汇总。",
]
for task in agent_tasks:
    long_chain(task)

# 流式单轮工具调用若干次（捕捉格式随机性）
print(f"\n\033[1m【流式单轮工具调用 x4】\033[0m")
for i in range(4):
    c, tcs, fr, meta = sse({"model": MODEL, "messages": [{"role": "user", "content": f"搜索一下 {i} 号关键词"}], "tools": TOOLS})
    audit(f"single{i}", c, tcs, fr, meta)
    print(f"  #{i}: finish={fr} tools={[t['function']['name'] for t in tcs]} 正文={c.strip()[:50]!r}")

print("\n" + "=" * 70)
avg = sum(stats['ttfb'])/len(stats['ttfb']) if stats['ttfb'] else 0
print(f" 总请求数: {calls} | Agent 轮次: {stats['rounds']} | 工具调用次数: {stats['tool_calls']}")
print(f" 正文增量 chunk: {stats['content_chunks']} | 平均首字节(TTFB): {avg:.2f}s | 总耗时: {time.time()-t0:.1f}s")
if fails:
    print(f" \033[31m失败 {len(fails)} 项:\033[0m")
    for f in fails:
        print("   -", f)
    sys.exit(1)
print(" \033[32m全部通过：无标记泄漏 / arguments 全为合法 JSON / 流式增量正常\033[0m")
print("=" * 70)
