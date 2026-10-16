#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图片(多模态)输入回归测试 —— 走本地代理解析，验证图片不再被丢弃"""
import json, base64, urllib.request, re, sys

BASE = 'http://127.0.0.1:8788/v1/chat/completions'
MODEL = 'deepseek-v4.1-flash'
IMG = '/root/.codebuddy/blobs/53/53eaae2fb55e4efb1d7e89fe943ed98dc02a472e77ff932191e7f55bfdc05983.jpg'
DATA_URL = 'data:image/jpeg;base64,' + base64.b64encode(open(IMG, 'rb').read()).decode()
RAW_B64 = DATA_URL.split(',', 1)[1]

ONLY = sys.argv[1] if len(sys.argv) > 1 else None

TOOLS = [{"type": "function", "function": {"name": "search_web", "description": "搜索网络信息",
          "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}}]

fails = []
calls = 0


def request(body):
    global calls
    calls += 1
    req = urllib.request.Request(BASE, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    if body.get('stream'):
        content = ''
        tcm = {}
        finish = None
        for raw in urllib.request.urlopen(req, timeout=180):
            line = raw.decode('utf-8', 'replace').rstrip('\n')
            if not line.startswith('data:'):
                continue
            p = line[5:].strip()
            if p == '[DONE]':
                break
            try:
                o = json.loads(p)
            except Exception:
                continue
            ch = o['choices'][0]
            d = ch.get('delta') or {}
            if d.get('content'):
                content += d['content']
            for t in (d.get('tool_calls') or []):
                i = t.get('index', 0)
                e = tcm.setdefault(i, {'name': '', 'args': ''})
                f = t.get('function') or {}
                if f.get('name'):
                    e['name'] = f['name']
                if f.get('arguments'):
                    e['args'] += f['arguments']
            if ch.get('finish_reason'):
                finish = ch['finish_reason']
        tcs = [{'function': e} for e in tcm.values()]
        return content, tcs, finish
    d = json.loads(urllib.request.urlopen(req, timeout=180).read())
    if 'error' in d:
        return '', [], f"ERROR: {d['error'].get('message','')[:120]}"
    m = d['choices'][0]['message']
    return (m.get('content') or ''), (m.get('tool_calls') or []), d['choices'][0]['finish_reason']


def check(tag, content, tcs, finish):
    print(f"\n\033[1m【{tag}】\033[0m")
    print(f"  finish={finish}")
    print(f"  正文: {content.strip()[:220]!r}")
    if tcs:
        print(f"  tool_calls: {[t['function'].get('name') for t in tcs]}")
    # 模型选择调用工具时 content 为空是正常行为
    if finish == 'tool_calls' and tcs:
        args = tcs[0]['function'].get('arguments') or '{}'
        try:
            parsed = json.loads(args)
        except Exception:
            parsed = None
        if parsed is None:
            fails.append(f"{tag}: tool_calls arguments 非法 JSON")
            print("  \033[31m✗ arguments 非法\033[0m")
            return
        print("  \033[32m✓ 正确转为工具调用（content 为空属预期）\033[0m")
        return
    miss = re.search(r'看不到|没有收到图片|没收到图片|无法查看图片|can.?t see|no image', content, re.I)
    if miss:
        fails.append(f"{tag}: 模型报告看不到图片 -> {content[:80]!r}")
        print("  \033[31m✗ 图片被丢弃\033[0m")
    elif not content.strip():
        fails.append(f"{tag}: 空回复")
        print("  \033[31m✗ 空回复\033[0m")
    else:
        print("  \033[32m✓ 模型成功读到图片\033[0m")


if ONLY in (None, '1'):
        # 1. OpenAI 标准格式 + 流式
    c, t, f = request({"model": MODEL, "stream": True, "messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "这张图片里显示了什么？用一句话概括。"},
            {"type": "image_url", "image_url": {"url": DATA_URL}}]}]})
    check("1. OpenAI 格式 · SSE 流式", c, t, f)

if ONLY in (None, '2'):
        # 2. OpenAI 标准格式 + 非流式
    c, t, f = request({"model": MODEL, "stream": False, "messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "图片里出现了什么程序界面？一句话。"},
            {"type": "image_url", "image_url": {"url": DATA_URL}}]}]})
    check("2. OpenAI 格式 · 非流式", c, t, f)

if ONLY in (None, '3'):
        # 3. Anthropic 风格 image/source.base64（验证格式转换）
    c, t, f = request({"model": MODEL, "stream": True, "messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "这张图里有什么？一句话。"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": RAW_B64}}]}]})
    check("3. Anthropic 风格 image 分片", c, t, f)

if ONLY in (None, '4'):
        # 4. 图片 + 工具（Agent 场景，验证两者不互相干扰）
    c, t, f = request({"model": MODEL, "stream": True, "tools": TOOLS, "messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "看这张图，然后用 search_web 搜索图里提到的关键词。"},
            {"type": "image_url", "image_url": {"url": DATA_URL}}]}]})
    check("4. 图片 + 工具调用", c, t, f)

print("\n" + "=" * 70)
print(f" 总请求数: {calls}")
if fails:
    print(f" \033[31m失败 {len(fails)} 项:\033[0m")
    for x in fails:
        print("   -", x)
    sys.exit(1)
print(" \033[32m全部通过：图片未被丢弃，多模态格式转换正确\033[0m")
print("=" * 70)
