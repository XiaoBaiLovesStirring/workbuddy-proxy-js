/**
 * toolcall.js - 工具调用模拟
 *
 * WorkBuddy 的 /v2/chat/completions 不支持标准 OpenAI 工具调用
 * （上游会忽略 tools 字段，delta.tool_calls 恒为空数组）。
 * 此模块通过 Prompt 注入让模型用标签输出工具调用，
 * 再由代理解析转换为标准 OpenAI tool_calls 格式。
 *
 * 支持解析的格式（按优先级）：
 *   1. 标准注入格式（所有模型通用）：
 *        <tool_call>{"name":"fn","arguments":{...}}</tool_call>
 *   2. 模型原生 DSML 格式（DeepSeek 系模型常见，标记中的竖线可能是
 *      半角 "|" 或全角 "｜" U+FF5C）：
 *        <｜｜DSML｜｜ calls>
 *        <｜｜DSML｜｜ invoke name="search_web">
 *        <｜｜DSML｜｜ parameter name="query" string="true">蓝色大肥鱼</｜｜DSML｜｜ parameter>
 *        </｜｜DSML｜｜ invoke>
 *        </｜｜DSML｜｜ calls>
 *   3. 混杂/截断格式：<tool_call> 开标签 + DSML 闭标签（模型偶发混用），
 *      通过「平衡 JSON 提取」兜底。
 *
 * 关键保证：解析后一定会清理残留标记，任何情况下都不会把
 * <tool_call> / DSML 原始标记泄漏到用户可见的 content 中。
 */

// ---------- 常量 ----------

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';

// 全角竖线 U+FF5C，用于统一 DSML 标记
const FULLWIDTH_BAR = '\uFF5C';

// 单次解析时最多接受的工具调用数量，防止模型幻觉刷屏
const MAX_TOOL_CALLS = 32;

// 流式过滤时需要在尾部保留的字符数，避免标记被 chunk 边界截断
const STREAM_HOLD_BACK = 16;

// 触发「闭合标签风暴」防御的阈值：连续多少个孤立的闭合标签
// （找不到对应开标签的）就视为模型自模仿/递归异常，整段丢弃。
// 真实事故中模型会一次性吐 50+ 个 </invoke>，阈值取 1 保证零泄漏。
// （push 里只需要 textBuf 累积 1 个孤立闭合标签就触发丢弃）
const CLOSE_TAG_STORM_THRESHOLD = 1;

/**
 * 统计文本中"找不到对应开标签的孤立闭合标签"数量
 *
 * 用途：检测模型自模仿/递归异常（长上下文里看到历史 tool_call 文本后
 * 疯狂复制闭合标签 </invoke>）。这种输出对客户端毫无意义且会污染 UI。
 *
 * 用简单计数即可：开标签只能由"工具调用解析路径"消耗，
 * 出现在普通文本流的闭合标签 99% 是模型自模仿。
 */
function countUnmatchedCloseTags(text) {
  if (!text) return 0;
  // 仅检测 invoke 风格的闭合（这是 OpenCode / Claude Code 的主流格式）
  // tool_call / DSML 风格的闭合会被 findToolCallStart 触发转入 toolBuf，
  // 不会出现在这里。
  const re = /<\/invoke>/gi;
  const opens = (text.match(/<invoke\b/gi) || []).length;
  const closes = (text.match(/<\/invoke>/gi) || []).length;
  return Math.max(0, closes - opens);
}

/**
 * 将 OpenAI tools 定义转换为文本描述（注入到 system prompt）
 */
function toolsToText(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';

  const lines = [];
  lines.push('## Tool Use');
  lines.push('');
  lines.push('You can call the following tools. To call a tool you MUST reply with ONLY a `<tool_call>` block containing a JSON object, in exactly this format:');
  lines.push('');
  lines.push('<tool_call>');
  lines.push('{"name": "tool_name", "arguments": {"arg_name": "arg_value"}}');
  lines.push('</tool_call>');
  lines.push('');
  lines.push('Rules:');
  lines.push('1. Call at most one tool per reply.');
  lines.push('2. When calling a tool, output the `<tool_call>` block and NOTHING else.');
  lines.push('3. `arguments` MUST be a valid JSON object matching the tool schema.');
  lines.push('4. Use the exact tag `<tool_call>` / `</tool_call>`. Do NOT use any other tag, marker, DSML notation or special token.');
  lines.push('5. If no tool is needed, just answer the user normally.');
  lines.push('');
  lines.push('### Available tools');
  lines.push('');

  for (const tool of tools) {
    const fn = tool && (tool.function || (tool.type === 'function' ? tool : null));
    if (!fn || !fn.name) continue;
    lines.push(`#### ${fn.name}`);
    if (fn.description) lines.push(`Description: ${fn.description}`);
    if (fn.parameters) {
      lines.push('Parameters (JSON Schema):');
      lines.push('```json');
      lines.push(JSON.stringify(fn.parameters, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 处理消息：将 tool 角色消息转换为文本，注入工具定义到 system prompt
 */
function processMessagesForToolCall(messages, tools) {
  if (!tools || tools.length === 0) {
    return { messages, hasTools: false };
  }

  const toolText = toolsToText(tools);
  const result = [];
  let systemInjected = false;

  for (const msg of messages) {
    if (msg.role === 'system') {
      // 在 system prompt 中追加工具定义
      let base = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n')
          : '');
      result.push({ ...msg, content: base ? `${base}\n\n${toolText}` : toolText });
      systemInjected = true;
    } else if (msg.role === 'tool') {
      // 将 tool 结果转换为 user 消息格式
      const toolName = msg.name || msg.tool_call_id || 'tool';
      const toolResult = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      result.push({
        role: 'user',
        content: `Tool \`${toolName}\` returned:\n\`\`\`\n${toolResult}\n\`\`\`\n\nContinue based on the tool result above.`,
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      // 将历史 tool_calls 还原为文本格式，保持多轮上下文一致
      let content = typeof msg.content === 'string' ? msg.content : '';
      for (const tc of msg.tool_calls) {
        if (tc && tc.function) {
          let args = tc.function.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* 保持字符串 */ }
          }
          content += `${content ? '\n' : ''}${TOOL_CALL_OPEN}\n${JSON.stringify({ name: tc.function.name, arguments: args ?? {} })}\n${TOOL_CALL_CLOSE}\n`;
        }
      }
      result.push({ role: 'assistant', content });
    } else {
      result.push(msg);
    }
  }

  // 如果没有 system 消息，在开头插入一个
  if (!systemInjected) {
    result.unshift({
      role: 'system',
      content: `You are a helpful assistant.\n\n${toolText}`,
    });
  }

  return { messages: result, hasTools: true };
}

// ---------- 解析工具 ----------

/**
 * 统一标记：把全角竖线（U+FF5C）替换为半角竖线，便于统一匹配
 */
function normalizeMarkers(text) {
  return String(text).replace(/\uFF5C/g, '|');
}

/**
 * 解析标签属性，如 name="query" string="true"
 */
function parseAttrs(str) {
  const attrs = {};
  if (!str) return attrs;
  const re = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

/**
 * 构造标准 OpenAI tool_call 对象
 */
let callSeq = 0;
function makeToolCall(name, args) {
  let argStr;
  if (typeof args === 'string') {
    argStr = args;
  } else if (args === undefined || args === null) {
    argStr = '{}';
  } else {
    try {
      argStr = JSON.stringify(args);
    } catch {
      argStr = '{}';
    }
  }
  return {
    id: `call_${Date.now().toString(36)}${(callSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    type: 'function',
    function: { name: String(name), arguments: argStr },
  };
}

/**
 * 从任意结构解析出 { name, arguments }
 */
function normalizeCallShape(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
  const name = obj.name || obj.tool_name || obj.tool || (fn && fn.name) || obj.function_name;
  if (!name || typeof name !== 'string') return null;

  let args = obj.arguments;
  if (args === undefined) args = obj.parameters;
  if (args === undefined) args = obj.args;
  if (args === undefined) args = obj.input;
  if (args === undefined && fn) args = fn.arguments;
  if (args === undefined) args = {};

  if (typeof args === 'string') {
    const t = args.trim();
    if (t) {
      try { args = JSON.parse(t); } catch { /* 保留原始字符串 */ }
    }
  }
  return { name, arguments: args };
}

/**
 * 从文本中提取第一个「平衡」的 JSON 对象（考虑字符串与转义）
 * @returns {string|null} 原始 JSON 子串
 */
function extractBalancedJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 未闭合
}

/**
 * 解析单个 JSON 字符串为 tool_call
 */
function parseJsonCall(jsonStr) {
  if (!jsonStr) return null;
  try {
    const obj = JSON.parse(jsonStr.trim());
    const shaped = normalizeCallShape(obj);
    return shaped ? makeToolCall(shaped.name, shaped.arguments) : null;
  } catch {
    return null;
  }
}

/**
 * 解析 DSML invoke 块内部的参数，生成 tool_call
 */
function parseDsmlInvokes(block, out) {
  const invokeRe = /<dsml_invoke\b([^>]*)>([\s\S]*?)(?=<\/dsml_invoke>|$)/g;
  let m;
  while ((m = invokeRe.exec(block))) {
    if (out.length >= MAX_TOOL_CALLS) break;
    const invokeAttrs = parseAttrs(m[1]);
    const body = m[2] || '';

    const params = {};
    let argsRaw;
    let argsRawType = '';
    let nameFromParam = null;

    const paramRe = /<dsml_parameter\b([^>]*)>([\s\S]*?)(?=<\/dsml_parameter>|<dsml_parameter\b|$)/g;
    let p;
    while ((p = paramRe.exec(body))) {
      const attrs = parseAttrs(p[1]);
      const key = attrs.name;
      if (!key) continue;
      const isString = attrs.string !== 'false';
      const rawValue = p[2] || '';
      let value;

      if (isString) {
        value = rawValue.trim();
      } else {
        const t = rawValue.trim();
        try { value = JSON.parse(t); } catch { value = t; }
      }

      if (key === 'arguments' || key === 'parameters' || key === 'args') {
        argsRaw = value;
        argsRawType = typeof value;
      } else if (key === 'name' || key === 'tool_name') {
        nameFromParam = String(value);
      } else {
        params[key] = value;
      }
    }

    const name = invokeAttrs.name || invokeAttrs.tool || nameFromParam;
    if (!name) continue;

    let args;
    if (argsRaw !== undefined) {
      if (argsRawType === 'object') {
        args = argsRaw;
      } else {
        // 字符串形态的 arguments，尝试当作 JSON 解析
        try {
          args = JSON.parse(String(argsRaw));
        } catch {
          // 无法解析时，若还有其它参数则合并，否则退化为 { value }
          args = Object.keys(params).length ? { ...params, value: argsRaw } : { value: argsRaw };
        }
      }
    } else {
      args = params;
    }

    out.push(makeToolCall(name, args));
  }
}

/**
 * 提取 DSML 格式的工具调用，并从文本中移除
 */
function extractDsmlCalls(text, out) {
  // 把 DSML 标记规范化为常规 XML 标签
  let s = text.replace(/<(\/?)\|+DSML\|+\s*([A-Za-z_]+)/g, '<$1dsml_$2');

  if (!/dsml_/i.test(s)) return s;

  // 1) 完整 calls 包裹块
  s = s.replace(/<dsml_calls>([\s\S]*?)<\/dsml_calls>/g, (match, inner) => {
    parseDsmlInvokes(inner, out);
    return '';
  });

  // 2) 未被 calls 包裹（或 calls 未闭合）的 invoke
  s = s.replace(/<dsml_invoke\b[\s\S]*?(?:<\/dsml_invoke>|$)/g, (match) => {
    parseDsmlInvokes(match, out);
    return '';
  });

  // 3) 清理任何残留的 DSML 标签
  s = s.replace(/<\/?dsml_[A-Za-z_]+[^>]*>/g, '');

  return s;
}

/**
 * 解码 XML 实体（工具参数值里的 &lt; &amp; 等）
 */
function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 参数值：能当 JSON 解析就解析（对象 / 数组 / 数字 / 布尔 / null），否则保留字符串
 */
function coerceParamValue(v) {
  const t = String(v).trim();
  if (!t) return '';
  if (!/^[\[{"\d\-tfn]/.test(t)) return t;   // 快速排除普通文本
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/**
 * 解析 Anthropic 风格的 invoke 块
 *
 *   <function_calls>
 *   <invoke name="search_web">
 *   <parameter name="query">关键词</parameter>
 *   </invoke>
 *   </function_calls>
 *
 * 注意：没有 name 属性的 invoke（模型残留的空标签）不产生工具调用，
 * 但会被后续的清理规则移除，不会泄漏给用户。
 */
function parseAnthropicInvokes(block, out) {
  const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)(?=<\/invoke>|$)/gi;
  let m;
  while ((m = invokeRe.exec(block))) {
    const attrs = parseAttrs(m[1]);
    const name = attrs.name || attrs.tool || attrs.tool_name;
    if (!name) continue;                       // 无 name → 不是有效调用
    if (out.length >= MAX_TOOL_CALLS) break;

    const body = m[2] || '';
    const params = {};
    const paramRe = /<parameter\b([^>]*)>([\s\S]*?)(?=<\/parameter>|<parameter\b|$)/gi;
    let p;
    while ((p = paramRe.exec(body))) {
      const pa = parseAttrs(p[1]);
      if (!pa.name) continue;
      params[pa.name] = coerceParamValue(decodeEntities(p[2] || ''));
    }

    // 单参数装整个 JSON 的写法：<parameter name="arguments">{"a":1}</parameter>
    const keys = Object.keys(params);
    let args;
    if (keys.length === 1 && ['arguments', 'parameters', 'args', 'input'].includes(keys[0])) {
      const only = params[keys[0]];
      args = (only && typeof only === 'object') ? only : { value: only };
    } else {
      args = params;
    }

    out.push(makeToolCall(name, args));
  }
}

/**
 * 提取 Anthropic 风格的工具调用（<function_calls> / <invoke> / <parameter>），
 * 支持 antml: 前缀；无论是否解析成功都会移除这些标记，避免泄漏给客户端。
 */
function extractAnthropicCalls(text, out) {
  // 先归一化 antml: 前缀，<antml:invoke> → <invoke>
  let s = String(text).replace(/<(\/?)(?:antml|antml2):/gi, '<$1');

  if (!/<(?:function_calls|invoke)\b/i.test(s)) return s;

  // 1) <function_calls> 完整包裹块
  s = s.replace(/<function_calls>([\s\S]*?)<\/function_calls>/gi, (match, inner) => {
    parseAnthropicInvokes(inner, out);
    return '';
  });

  // 2) 裸 invoke（未被 function_calls 包裹，或 function_calls 未闭合）
  s = s.replace(/<invoke\b([^>]*)>([\s\S]*?)(?=<\/invoke>|$)/gi, (match, attrs, body) => {
    parseAnthropicInvokes(match, out);
    // 无 name 的残留块直接丢弃，避免空 <invoke></invoke> 泄漏
    const a = parseAttrs(attrs);
    const hasName = a.name || a.tool || a.tool_name;
    return hasName ? '' : '';
  });

  // 3) 清理残留标签（含未闭合的 </invoke、空标签对）
  s = s.replace(/<\/?(?:function_calls|function_call|invoke|parameter)\b[^>]*>/gi, '');
  s = s.replace(/<\/(?:invoke|parameter|function_calls)\b/gi, '');

  return s;
}

/**
 * 提取 <tool_call>…</tool_call> JSON 格式的工具调用，并从文本中移除
 */function extractXmlJsonCalls(text, out) {
  let s = text;

  // 1) 完整配对
  s = s.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (match, inner) => {
    if (out.length >= MAX_TOOL_CALLS) return '';
    const call = parseJsonCall(inner);
    if (call) out.push(call);
    return '';
  });

  // 2) 出现 <tool_call> 但没有正常闭合（混用标记 / 流式截断）
  if (s.includes(TOOL_CALL_OPEN)) {
    s = s.replace(/<tool_call>\s*([\s\S]*)$/, (match, inner) => {
      const json = extractBalancedJson(inner);
      if (!json) return '';
      if (out.length < MAX_TOOL_CALLS) {
        const call = parseJsonCall(json);
        if (call) {
          out.push(call);
          const idx = inner.indexOf(json);
          return inner.slice(idx + json.length);
        }
      }
      return '';
    });
  }

  return s;
}

/**
 * 清理残留标记，保证不会泄漏给用户
 */
function cleanupResidual(text) {
  if (!text) return '';
  return String(text)
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<\/?tool_calls>/gi, '')
    .replace(/<\/?(?:antml:)?(?:function_calls|function_call|invoke|parameter)\b[^>]*>/gi, '')
    .replace(/<\/(?:antml:)?(?:invoke|parameter|function_calls)\b/gi, '')
    .replace(/<\/?dsml_[A-Za-z_]+[^>]*>/gi, '')
    .replace(/<\/?\|+DSML\|+[^>]*>/gi, '')
    .replace(/\|+DSML\|+/gi, '')
    .replace(/^\s*```(?:json)?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * 从文本中解析工具调用
 * @param {string} text - 上游模型完整输出
 * @returns {{ toolCalls: Array, content: string, hasToolCall: boolean }}
 */
function parseToolCalls(text) {
  if (!text || typeof text !== 'string') {
    return { toolCalls: [], content: text || '', hasToolCall: false };
  }

  const toolCalls = [];
  let s = normalizeMarkers(text);

  s = extractDsmlCalls(s, toolCalls);
  s = extractAnthropicCalls(s, toolCalls);
  s = extractXmlJsonCalls(s, toolCalls);

  // 兜底：文本（去壳后）是一个裸的 JSON 工具调用对象
  if (toolCalls.length === 0) {
    const bare = s.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    if (bare.startsWith('{') && bare.endsWith('}')) {
      const call = parseJsonCall(bare);
      if (call) {
        toolCalls.push(call);
        s = '';
      }
    }
  }

  s = cleanupResidual(s).trim();

  return { toolCalls, content: s, hasToolCall: toolCalls.length > 0 };
}

/**
 * 判断文本中是否包含工具调用起始标记
 */
function hasToolCallMarker(text) {
  if (!text) return false;
  const s = normalizeMarkers(text);
  return s.includes(TOOL_CALL_OPEN) || /<\|+DSML\|+/i.test(s) || /<(?:antml:)?(?:function_calls|invoke)\b/i.test(s);
}

/**
 * 查找工具调用起始标记的下标（无则返回 -1）
 */
function findToolCallStart(buf) {
  if (!buf) return -1;
  const s = normalizeMarkers(buf);
  let idx = -1;
  for (const re of [/<tool_call>/, /<\|+DSML\|+/i, /<(?:antml:)?(?:function_calls|invoke)\b/i]) {
    const m = re.exec(s);
    if (m && (idx === -1 || m.index < idx)) idx = m.index;
  }
  return idx;
}

/**
 * 检查文本中是否有未闭合的 tool_call 标签（流式输出中）
 */
function hasUnclosedToolCall(text) {
  if (!text) return false;
  const openIdx = text.lastIndexOf(TOOL_CALL_OPEN);
  if (openIdx === -1) {
    return findToolCallStart(text) !== -1 && !/<\/\|+DSML\|+\s*calls>/i.test(normalizeMarkers(text));
  }
  const closeIdx = text.indexOf(TOOL_CALL_CLOSE, openIdx);
  return closeIdx === -1;
}

/**
 * 创建流式过滤/解析器
 *
 * 作用：
 *  - 正文文本一旦确认不是工具调用标记，立即增量吐出（真正的流式）
 *  - 尾部保留 STREAM_HOLD_BACK 个字符，避免标记被 chunk 边界切断而提前泄漏
 *  - 命中工具调用标记后转入缓冲，直到流结束再统一解析
 */
function createStreamFilter() {
  let textBuf = '';   // 尚未确认可输出的正文缓冲
  let toolBuf = '';   // 工具调用缓冲
  let inTool = false;

  return {
    /**
     * 推入一个增量片段
     * @returns {{ content: string, dropped: boolean }} 本次可以立即下发的正文；
     *                                            dropped=true 表示触发了兜底丢弃
     */
    push(chunk) {
      if (!chunk) return { content: '' };

      if (inTool) {
        toolBuf += chunk;
        return { content: '' };
      }

      textBuf += chunk;
      const idx = findToolCallStart(textBuf);

      if (idx === -1) {
        // 未出现工具调用起始标记：先检查「闭合标签风暴」
        // —— 模型在长上下文里自模仿，会持续输出孤立 </invoke>
        // 一旦累积到阈值就立刻整段丢弃并静默后续，
        // 不再走 STREAM_HOLD_BACK 切窗口路径，避免前 2 个闭合标签泄漏。
        // 注意：textBuf 长度可能 < STREAM_HOLD_BACK，所以不能依赖切片判断。
        const unmatched = countUnmatchedCloseTags(textBuf);
        if (unmatched >= CLOSE_TAG_STORM_THRESHOLD) {
          const droppedLen = textBuf.length;
          textBuf = '';
          return { content: '', dropped: true, droppedLen, reason: 'close_tag_storm' };
        }

        // 未达阈值：安全吐出除尾部保留区外的内容
        if (textBuf.length > STREAM_HOLD_BACK) {
          const cut = textBuf.length - STREAM_HOLD_BACK;
          const out = textBuf.slice(0, cut);
          textBuf = textBuf.slice(cut);
          return { content: out };
        }
        return { content: '' };
      }

      // 命中工具调用起始标记：标记前的内容立即下发，其余转入工具缓冲
      const out = textBuf.slice(0, idx);
      toolBuf += textBuf.slice(idx);
      textBuf = '';
      inTool = true;
      return { content: out };
    },

    /**
     * 流结束，返回剩余正文与解析出的工具调用
     * @returns {{ content: string, toolCalls: Array, hasToolCall: boolean, dropped: boolean }}
     */
    finish() {
      if (!inTool) {
        const idx = findToolCallStart(textBuf);
        if (idx === -1) {
          // 防御：检查闭合标签风暴
          const storm = countUnmatchedCloseTags(textBuf);
          if (storm >= CLOSE_TAG_STORM_THRESHOLD) {
            const tail = textBuf;
            textBuf = '';
            return {
              content: '',
              toolCalls: [],
              hasToolCall: false,
              dropped: true,
              droppedLen: tail.length,
              reason: 'close_tag_storm',
            };
          }
          const tail = textBuf;
          textBuf = '';
          // 兜底清理：清掉任何零散的孤立闭合标签，避免泄漏给客户端
          return { content: cleanupResidual(tail), toolCalls: [], hasToolCall: false };
        }
        toolBuf += textBuf.slice(idx);
        textBuf = '';
        inTool = true;
      }

      const { toolCalls, content, hasToolCall } = parseToolCalls(toolBuf);
      toolBuf = '';
      return { content: content || '', toolCalls, hasToolCall };
    },

    get isInTool() {
      return inTool;
    },
  };
}

module.exports = {
  toolsToText,
  processMessagesForToolCall,
  parseToolCalls,
  hasUnclosedToolCall,
  hasToolCallMarker,
  findToolCallStart,
  extractBalancedJson,
  createStreamFilter,
  normalizeMarkers,
  countUnmatchedCloseTags,
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
};
