/**
 * proxy.js - 代理核心
 *
 * 处理 /v1/chat/completions 请求，转发到上游 WorkBuddy API。
 * 集成提示词清洗、流式转发、工具调用模拟、非流式聚合。
 *
 * 关键实现说明：
 *  - 上游 SSE 采用「增量行缓冲」解析，避免 JSON 行被 TCP 分片切断导致内容丢失
 *  - 工具调用模式下先增量下推正文（真流式），工具调用块单独缓冲，流结束统一解析
 *  - 解析后强制清理残留标记，任何情况下都不会把 <tool_call> / DSML 泄漏给用户
 */
const https = require('https');
const fs = require('fs');
const identity = require('./identity');
const accountMgr = require('./account');
const modelsMgr = require('./models');
const sanitizer = require('./sanitizer');
const toolcall = require('./toolcall');
const logger = require('./logger');
const config = require('./config');

// 统计
const stats = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  totalTokens: 0,
  sanitizedPrompts: 0,
  startTime: Date.now(),
};

// ---------- 长连接 / 断联相关配置 ----------

// 上游 socket 空闲超时（完全收不到任何字节才判定超时）。
// 长时间任务里模型可能思考很久而暂时没有输出，这里给足余量避免误杀。
const UPSTREAM_IDLE_TIMEOUT = parseInt(process.env.UPSTREAM_IDLE_TIMEOUT || '600000', 10); // 10 分钟

// 向下游客户端发送 SSE 心跳注释行的间隔。
// 大量客户端（Cherry Studio / Cline / 各类 OpenAI SDK / 网关）在 N 秒内收不到
// 任何字节时会判定连接超时并主动断开 —— 这是长时间任务「跑一半断联」的首要原因。
// SSE 规范里以 ':' 开头的行是注释，客户端会忽略，但能重置其空闲计时器。
const DOWNSTREAM_HEARTBEAT_INTERVAL = parseInt(process.env.DOWNSTREAM_HEARTBEAT_INTERVAL || '15000', 10);

// 上游失败时的最大尝试次数（含首次），重试时会换一个账号
const MAX_UPSTREAM_ATTEMPTS = parseInt(process.env.MAX_UPSTREAM_ATTEMPTS || '3', 10);

// SSE chunkId 自增计数：保证同毫秒下多次响应 / 多次重试的 chunkId 不冲突。
// 同毫秒下 Date.now() 相同，OpenCode / Claude Code 等客户端会把相同 id 的
// chunk 当成同一个响应吞掉，导致内容/工具调用丢失。
let chunkSeq = 0;

// 值得重试的上游状态码
//   401/403：单个账号 token 失效 —— 换账号即可继续，不该让整个任务断掉
//   429/5xx：限流 / 网关 / 服务端临时故障
const RETRYABLE_STATUS = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524]);

/**
 * 判断上游 stream error 是否是「预期的关闭」而非真实故障
 *
 * 这些错误码/消息在以下场景是正常的，不应当作上游故障处理：
 *  - 客户端提前断开 → 我们主动 destroy 上游 socket → 触发 'aborted'
 *  - 上游主动断开（finish_reason=stop 后正常关闭）→ 触发 ECONNRESET
 *  - Node socket 在 destroy 后的尾随事件
 *
 * 判定为「预期」时：(1) 不打 ERROR 日志；(2) 不当成真错误处理；
 * 区分 down/up 错误能给日志带来真正的诊断价值。
 *
 * @param {Error|null} e
 * @param {boolean} clientGone - 客户端是否已经断开（res.writableEnded）
 * @returns {boolean}
 */
function isExpectedSocketClose(e, clientGone) {
  if (!e) return true;
  // 客户端已经断开 → 上游的任何错误都是预期内的
  if (clientGone) return true;
  // 我们主动 destroy() 后触发的 aborted
  if (e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  if (e.message === 'aborted' || e.message === 'socket hang up' || e.message === 'premature close') return true;
  return false;
}

/**
 * 启动向下游的 SSE 心跳，返回停止函数
 */
function startDownstreamHeartbeat(res) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* 连接已断，静默忽略 */
    }
  }, DOWNSTREAM_HEARTBEAT_INTERVAL);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * 设置 SSE 响应头
 */
function applySseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);
}

/**
 * 发起上游流式请求
 */
function upstreamStreamRequest(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: UPSTREAM_IDLE_TIMEOUT,
    }, (res) => resolve({ res, req }));
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`上游空闲超时（${Math.round(UPSTREAM_IDLE_TIMEOUT / 1000)}s 无任何数据）`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * SSE 行读取器
 *
 * 上游 SSE 的每一个 `data: {...}` 行都可能被 TCP 分片切断。
 * 这里做跨 chunk 的行缓冲，只有遇到完整换行才解析，从根本上避免内容丢失。
 *
 * @param {(obj: any) => void} onEvent - 收到一个已解析的 JSON 事件时回调
 * @param {() => void} [onDone] - 收到 [DONE] 时回调
 */
function createSseReader(onEvent, onDone) {
  let buf = '';

  function handleLine(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.startsWith('data:')) return; // 忽略 `: heartbeat` 等注释行
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      if (onDone) onDone();
      return;
    }
    try {
      onEvent(JSON.parse(payload));
    } catch {
      /* 非 JSON 数据行，忽略 */
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    },
    flush() {
      if (buf.length) {
        handleLine(buf);
        buf = '';
      }
    },
  };
}

/**
 * 规范化单个多模态 content 分片
 *
 * 上游支持 OpenAI 标准多模态格式（实测 image_url + data URL 可用），
 * 这里同时把 Anthropic / Responses API 的图片写法统一转换成上游认的 image_url，
 * 避免各客户端格式差异导致「图片丢失、模型说看不到图」。
 *
 * @returns {Object|null} 规范化后的分片，无法识别时返回 null（丢弃）
 */
function normalizeContentPart(part) {
  if (part === null || part === undefined) return null;

  // 纯字符串分片
  if (typeof part === 'string') {
    return part ? { type: 'text', text: part } : null;
  }
  if (typeof part !== 'object') {
    return { type: 'text', text: String(part) };
  }

  const type = part.type;

  // 文本
  if (type === 'text' || type === 'input_text') {
    const text = part.text !== undefined ? part.text : part.content;
    return typeof text === 'string' && text ? { type: 'text', text } : null;
  }

  // OpenAI 标准：{ type: 'image_url', image_url: { url } } 或 image_url 直接是字符串
  if (type === 'image_url' || type === 'input_image') {
    const iu = part.image_url !== undefined ? part.image_url : part.url;
    const url = typeof iu === 'string' ? iu : (iu && iu.url);
    if (!url || typeof url !== 'string') return null;
    const out = { type: 'image_url', image_url: { url } };
    if (iu && typeof iu === 'object' && iu.detail) out.image_url.detail = iu.detail;
    return out;
  }

  // Anthropic 风格：{ type: 'image', source: { type: 'base64'|'url', media_type, data } }
  if (type === 'image') {
    const src = part.source || {};
    if (src.type === 'base64' && src.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${src.media_type || 'image/jpeg'};base64,${src.data}` },
      };
    }
    if (src.type === 'url' && src.url) {
      return { type: 'image_url', image_url: { url: src.url } };
    }
    if (typeof part.url === 'string') {
      return { type: 'image_url', image_url: { url: part.url } };
    }
    if (typeof part.data === 'string') {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.media_type || 'image/jpeg'};base64,${part.data}` },
      };
    }
    return null;
  }

  // 其他未知分片：能取出文本就保留为文本，否则丢弃
  if (typeof part.text === 'string' && part.text) {
    return { type: 'text', text: part.text };
  }
  return null;
}

/**
 * 规范化即将发往上游的消息列表
 *
 * 两件事：
 *  1. 剥离上游不接受的工具字段 —— 上游一旦看到 tool_calls / tool_call_id
 *     而没有配对的工具记录，会直接返回 400「工具记录不完整」。
 *  2. 保留多模态 content —— 数组型 content 必须原样保留图片分片，
 *     只做格式归一化，绝不能拍平成纯文本（否则模型会「看不到图」）。
 */
function normalizeOutgoingMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    const role = m.role === 'developer' ? 'system' : m.role;
    let content = m.content;

    if (content === null || content === undefined) {
      content = '';
    } else if (Array.isArray(content)) {
      const parts = content.map(normalizeContentPart).filter(Boolean);
      // 全是文本时合并为字符串，兼容性更好；含图片则保留数组
      if (parts.length === 0) {
        content = '';
      } else if (parts.every(p => p.type === 'text')) {
        content = parts.map(p => p.text).join('\n');
      } else {
        content = parts;
      }
    } else if (typeof content !== 'string') {
      try { content = JSON.stringify(content); } catch { content = String(content); }
    }

    return { role, content };
  });
}

/**
 * 从上游 SSE 事件中取出增量信息
 */
function extractDelta(obj) {
  return {
    delta: obj && obj.choices && obj.choices[0] ? obj.choices[0].delta : null,
    finishReason: obj && obj.choices && obj.choices[0] ? obj.choices[0].finish_reason : null,
    usage: obj ? obj.usage : null,
  };
}

/**
 * 工具调用模式的响应处理（流式 / 非流式统一走这里）
 *
 * 流程：
 *  1. 正文增量：一旦确认不是工具调用标记，立刻下推（真流式，不再等全文）
 *  2. 工具块：转入缓冲，流结束后统一解析为 OpenAI tool_calls
 *  3. 残留标记：由 toolcall 模块统一清理，确保不泄漏
 */
function handleToolCallResponse(upstreamRes, upstreamReq, res, { model, stream, startTime, account, onSettled }) {
  const filter = toolcall.createStreamFilter();
  const modelName = (model || 'default-model');
  // chunkId 用 36 进制时间戳 + 进程内自增计数 + 随机后缀，避免同毫秒下
  // 多次重试 / 多次分块产生相同 id（OpenCode 会把相同 id 当成同一个响应 chunk 吞掉）。
  const chunkId = `chatcmpl-${Date.now().toString(36)}-${(chunkSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const created = Math.floor(Date.now() / 1000);

  let usage = null;
  let upstreamFinish = '';
  let contentAcc = '';       // 非流式用：累积正文
  let rawAcc = '';           // 调试用：上游工具模式的原始文本
  let ended = false;

  // 流式：立刻下发响应头，避免客户端长时间等不到首字节而超时
  if (stream) applySseHeaders(res);

  // 长时间生成期间持续发心跳注释行，防止客户端「空闲超时」主动断连
  const stopHeartbeat = stream ? startDownstreamHeartbeat(res) : () => {};

  // 客户端提前断开 → 立刻中止上游，避免连接 / 配额 / 账号统计被污染
  const onClientClose = () => {
    if (!res.writableEnded) {
      logger.warn(`客户端提前断开，中止上游请求 (账号=${account.nickname})`);
      try { upstreamReq.destroy(); } catch { /* ignore */ }
    }
  };
  res.on('close', onClientClose);

  const finish = (ok) => {
    stopHeartbeat();
    res.off('close', onClientClose);
    if (onSettled) onSettled(ok);
  };

  function writeChunk(delta, finishReason = null) {
    if (!stream || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({
      id: chunkId,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  }

  const reader = createSseReader((obj) => {
    const { delta, finishReason, usage: u } = extractDelta(obj);
    if (u) usage = u;
    if (finishReason) upstreamFinish = finishReason;

    if (!delta) return;

    // 思考内容透传（与无工具模式保持一致）
    if (delta.reasoning_content) {
      if (stream) writeChunk({ reasoning_content: delta.reasoning_content });
      else contentAcc += '';
    }

    if (typeof delta.content === 'string' && delta.content) {
      rawAcc += delta.content;
      const result = filter.push(delta.content);
      if (result.content) {
        contentAcc += result.content;
        if (stream) writeChunk({ content: result.content });
      }
      if (result.dropped) {
        // 模型自模仿 / 递归异常：流式路径下检测到「闭合标签风暴」，
        // 整段丢弃（不下发）。但 rawAcc 仍保留原始文本以供 DEBUG 排查。
        logger.warn(
          `工具调用风暴防御触发: 丢弃 ${result.droppedLen} 字符（reason=${result.reason}，账号=${account.nickname}）`,
        );
      }
    }
  });

  upstreamRes.on('data', (chunk) => reader.push(chunk));

  upstreamRes.on('end', () => {
    if (ended) return;
    ended = true;
    reader.flush();

    // 调试：把工具模式下上游返回的原始文本落盘，便于排查参数丢失等问题
    if (process.env.DEBUG_TOOLCALL_DUMP) {
      try {
        fs.appendFileSync(
          process.env.DEBUG_TOOLCALL_DUMP,
          `\n===== ${new Date().toISOString()} model=${modelName} =====\n${rawAcc}\n`,
        );
      } catch { /* ignore */ }
    }

    const fin = filter.finish();
    if (fin.dropped) {
      logger.warn(
        `工具调用风暴防御（finish）: 丢弃 ${fin.droppedLen} 字符（reason=${fin.reason}，账号=${account.nickname}）`,
      );
    }
    if (fin.content) {
      contentAcc += fin.content;
      if (stream) writeChunk({ content: fin.content });
    }

    if (usage && usage.completion_tokens) stats.totalTokens += usage.completion_tokens;
    const duration = Date.now() - startTime;
    logger.request('POST', '/v1/chat/completions', 200, duration, account.id);

    if (fin.hasToolCall) {
      logger.info(`工具调用解析成功: ${fin.toolCalls.map(t => t.function.name).join(', ')}`);
    }

    if (stream) {
      if (fin.hasToolCall) {
        // 按 OpenAI 规范分两步下发：先声明 name，再补 arguments
        for (let i = 0; i < fin.toolCalls.length; i++) {
          const tc = fin.toolCalls[i];
          writeChunk({
            tool_calls: [{
              index: i,
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: '' },
            }],
          });
          writeChunk({
            tool_calls: [{
              index: i,
              function: { arguments: tc.function.arguments },
            }],
          });
        }
        writeChunk({}, 'tool_calls');
      } else {
        writeChunk({}, upstreamFinish || 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
      finish(true);
      return;
    }

    // 非流式
    const response = {
      id: chunkId,
      object: 'chat.completion',
      created,
      model: modelName,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fin.hasToolCall ? (contentAcc || null) : contentAcc,
        },
        finish_reason: fin.hasToolCall ? 'tool_calls' : (upstreamFinish || 'stop'),
      }],
      usage: usage || {
        prompt_tokens: 0,
        completion_tokens: contentAcc.length,
        total_tokens: contentAcc.length,
      },
    };
    if (fin.hasToolCall) response.choices[0].message.tool_calls = fin.toolCalls;
    res.json(response);
    finish(true);
  });

  upstreamRes.on('error', (e) => {
    if (ended) return;
    ended = true;
    const clientGone = res.writableEnded || res.destroyed;
    const expected = isExpectedSocketClose(e, clientGone);

    if (expected) {
      // 客户端已断开 / 我们主动 destroy / 上游正常关闭后的尾随事件
      // → 这些都不是真正的上游故障，不打 ERROR（避免日志噪音）
      logger.info(`上游流关闭（预期）: ${e.message}（账号=${account.nickname}）`);
    } else {
      logger.error(`上游流错误: ${e.message}（账号=${account.nickname}，code=${e.code || '-'}）`);
    }

    if (!res.headersSent) {
      // 还没开始流式输出（响应头未下发）→ 客户端仍能收到 JSON 错误
      // 但只有真正错误才回 502；预期关闭就回 499（Client Closed Request）
      finish(false);
      res.status(expected ? 499 : 502).json({
        error: { message: expected ? '客户端已断开' : `上游连接错误: ${e.message}` },
      });
    } else if (!res.writableEnded) {
      // 流式响应已开始：补发结束帧 + [DONE] 让客户端能正常收尾
      // 关键：用 finish_reason='length' 表示「异常终止」（OpenAI 规范允许的合法值），
      // 不要再用 'stop'——客户端会以为对话正常完成，但实际上内容可能残缺。
      try {
        writeChunk({}, 'length');
        res.write('data: [DONE]\n\n');
      } catch { /* ignore */ }
      res.end();
      finish(false);
    } else {
      // 客户端已经断开且响应头已下发 → 不需要任何输出
      finish(false);
    }
  });
}

/**
 * 处理 chat completions 请求
 */
/**
 * 无工具 · 流式透传（保留上游原始 SSE 帧，含上游自己的心跳）
 */
function streamPassthrough(upstreamRes, upstreamReq, res, { startTime, account, onSettled }) {
  applySseHeaders(res);
  const stopHeartbeat = startDownstreamHeartbeat(res);

  const onClientClose = () => {
    if (!res.writableEnded) {
      logger.warn(`客户端提前断开，中止上游请求（账号=${account.nickname}）`);
      try { upstreamReq.destroy(); } catch { /* ignore */ }
    }
  };
  res.on('close', onClientClose);

  const finish = (ok) => {
    stopHeartbeat();
    res.off('close', onClientClose);
    if (onSettled) onSettled(ok);
  };

  upstreamRes.on('data', chunk => {
    if (res.writableEnded) return;
    res.write(chunk);
    const match = chunk.toString().match(/"completion_tokens":\s*(\d+)/);
    if (match) stats.totalTokens += parseInt(match[1], 10);
  });

  upstreamRes.on('end', () => {
    if (!res.writableEnded) res.end();
    finish(true);
  });

  upstreamRes.on('error', (e) => {
    const clientGone = res.writableEnded || res.destroyed;
    const expected = isExpectedSocketClose(e, clientGone);
    if (expected) {
      logger.info(`上游流关闭（预期）: ${e.message}（账号=${account.nickname}）`);
    } else {
      logger.error(`上游流错误: ${e.message}（账号=${account.nickname}，code=${e.code || '-'}）`);
    }
    if (!res.writableEnded) {
      // 透传模式下补一个 [DONE]，避免客户端一直挂着等结束帧
      try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
      res.end();
    }
    finish(false);
  });
}

/**
 * 无工具 · 非流式聚合（走增量行缓冲，避免分片丢内容）
 */
function streamAggregate(upstreamRes, upstreamReq, res, { model, account, onSettled }) {
  let contentAcc = '';
  let finishReason = '';
  let usage = null;

  const onClientClose = () => {
    if (!res.writableEnded) {
      try { upstreamReq.destroy(); } catch { /* ignore */ }
    }
  };
  res.on('close', onClientClose);

  const finish = (ok) => {
    res.off('close', onClientClose);
    if (onSettled) onSettled(ok);
  };

  const reader = createSseReader((obj) => {
    const { delta, finishReason: fr, usage: u } = extractDelta(obj);
    if (u) usage = u;
    if (fr) finishReason = fr;
    if (delta && typeof delta.content === 'string') contentAcc += delta.content;
  });

  upstreamRes.on('data', chunk => reader.push(chunk));

  upstreamRes.on('end', () => {
    reader.flush();
    if (usage && usage.completion_tokens) stats.totalTokens += usage.completion_tokens;
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'default-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: contentAcc },
        finish_reason: finishReason || 'stop',
      }],
      usage: usage || {
        prompt_tokens: 0,
        completion_tokens: contentAcc.length,
        total_tokens: contentAcc.length,
      },
    });
    finish(true);
  });

  upstreamRes.on('error', (e) => {
    const clientGone = res.writableEnded || res.destroyed;
    const expected = isExpectedSocketClose(e, clientGone);
    if (expected) {
      logger.info(`上游流关闭（预期）: ${e.message}（账号=${account.nickname}）`);
    } else {
      logger.error(`上游流错误: ${e.message}（账号=${account.nickname}，code=${e.code || '-'}）`);
    }
    // 非流式：响应头未下发时还能回 JSON 错误；已下发则不处理
    if (!res.headersSent) {
      res.status(expected ? 499 : 502).json({
        error: { message: expected ? '客户端已断开' : `上游连接错误: ${e.message}` },
      });
    }
    finish(false);
  });
}

/**
 * 处理 chat completions 请求
 *
 * 长任务稳定性要点：
 *  - 上游连接层失败 / 返回可重试状态码时，自动换账号重试（最多 MAX_UPSTREAM_ATTEMPTS 次）
 *  - 流式响应期间持续发送心跳，避免客户端空闲超时断连
 *  - 客户端提前断开时立刻中止上游请求，避免连接与账号统计被污染
 *  - 上游中途出错时补发结束帧 + [DONE]，让客户端能正常收尾而不是卡死
 */
async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  stats.totalRequests++;

  const { model, messages, stream = false, max_tokens, temperature, top_p, tools, tool_choice } = req.body || {};

  // 提示词清洗
  let processedMessages = messages;
  if (config.PROMPT_SANITIZE_ENABLED) {
    const result = sanitizer.sanitizeMessages(messages);
    if (result.sanitized) {
      processedMessages = result.messages;
      stats.sanitizedPrompts++;
      logger.info(`提示词已清洗 (${result.reason}): 模型=${model}`);
    }
  }

  // 工具调用处理：tool_choice=none 时不注入；否则注入工具定义到 system prompt
  const hasTools = !!(tools && tools.length > 0) && tool_choice !== 'none';
  let finalMessages = processedMessages;
  if (hasTools) {
    const result = toolcall.processMessagesForToolCall(processedMessages, tools);
    finalMessages = result.messages;
    logger.info(`工具调用模式: 注入 ${tools.length} 个工具定义到 prompt`);
  }

  // 确保第一条是 system，并剥离上游不接受的字段
  finalMessages = sanitizer.ensureSystemPrompt(finalMessages);
  finalMessages = normalizeOutgoingMessages(finalMessages);

  // 构造上游 body（不包含 tools，上游会忽略）
  const upstreamBody = {
    model: model || 'default-model',
    messages: finalMessages,
    stream: true, // 上游只支持流式
  };
  if (max_tokens) upstreamBody.max_tokens = max_tokens;
  if (temperature !== undefined) upstreamBody.temperature = temperature;
  if (top_p !== undefined) upstreamBody.top_p = top_p;

  const tried = [];
  let lastError = '';
  let lastStatus = 502;

  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt++) {
    // 客户端已经断开，不必再试
    if (res.writableEnded || res.destroyed) return;

    const account = accountMgr.getAvailableAccount(undefined, tried);
    if (!account) {
      if (tried.length) {
        lastError = `已尝试 ${tried.length} 个账号均失败`;
        lastStatus = 502;
      } else {
        lastError = '没有可用账号，请先添加账号';
        lastStatus = 400;
      }
      break;
    }
    tried.push(account.id);

    if (attempt > 1) {
      logger.warn(`第 ${attempt}/${MAX_UPSTREAM_ATTEMPTS} 次尝试，切换账号: ${account.nickname}`);
    }

    const headers = identity.buildIdentityHeaders({
      realm: account.realm,
      uid: account.uid,
      token: account.accessToken,
    });
    const { baseUrl } = identity.endpointFor(account.realm, 'workbuddy');
    const url = `${baseUrl}/v2/chat/completions`;

    // ---- 建立上游连接 ----
    let upstreamRes;
    let upstreamReq;
    try {
      const r = await upstreamStreamRequest(url, headers, upstreamBody);
      upstreamRes = r.res;
      upstreamReq = r.req;
    } catch (e) {
      accountMgr.updateAccountStats(account.id, false);
      lastError = `连接上游失败: ${e.message}`;
      lastStatus = 502;
      logger.error(`${lastError}（账号=${account.nickname}）`);
      continue; // 换账号重试
    }

    // ---- 上游返回非 200 ----
    if (upstreamRes.statusCode !== 200) {
      let errBody = '';
      upstreamRes.on('data', c => errBody += c);
      await new Promise((resolve) => {
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', resolve);
      });
      accountMgr.updateAccountStats(account.id, false);
      lastStatus = upstreamRes.statusCode;
      lastError = `上游错误 ${upstreamRes.statusCode}: ${errBody.slice(0, 400)}`;
      logger.error(`${lastError}（账号=${account.nickname}）`);

      if (RETRYABLE_STATUS.has(upstreamRes.statusCode) && attempt < MAX_UPSTREAM_ATTEMPTS) {
        continue; // 限流 / 网关故障 → 换账号重试
      }
      break;
    }

    // ---- 建立成功，开始转发 ----
    accountMgr.updateAccountStats(account.id, true);

    // successRequests 在转发真正完成后再累加（onSettled 里）
    // —— 之前的实现写在「开始转发」处，导致失败的请求也被算成 success。
    let upstreamOk = false;
    await new Promise((resolve) => {
      const onSettled = (ok) => {
        upstreamOk = ok;
        resolve();
      };
      if (hasTools) {
        handleToolCallResponse(upstreamRes, upstreamReq, res, {
          model, stream, startTime, account, onSettled,
        });
      } else if (stream) {
        streamPassthrough(upstreamRes, upstreamReq, res, { startTime, account, onSettled });
      } else {
        streamAggregate(upstreamRes, upstreamReq, res, { model, account, onSettled });
      }
    });

    if (upstreamOk) {
      stats.successRequests++;
    } else {
      stats.failedRequests++;
    }

    const duration = Date.now() - startTime;
    // 请求日志写入真实状态：success → 200；error handler 走 finish(false) → 上游失败
    // 但 HTTP 层返回给客户端的 status 是 200（headers 已下发），所以这里区分日志状态与 HTTP 状态
    logger.request(
      'POST', '/v1/chat/completions',
      upstreamOk ? 200 : 502,
      duration, account.id,
    );
    return;
  }

  // ---- 全部尝试失败 ----
  stats.failedRequests++;
  const duration = Date.now() - startTime;
  logger.request('POST', '/v1/chat/completions', lastStatus, duration, tried[tried.length - 1]);
  logger.error(`请求最终失败（已尝试 ${tried.length} 个账号）: ${lastError}`);
  if (!res.headersSent) {
    res.status(lastStatus).json({ error: { message: lastError || '所有上游尝试均失败' } });
  } else if (!res.writableEnded) {
    res.end();
  }
}

/**
 * 处理 /v1/models 请求
 */
async function handleModels(req, res) {
  const account = accountMgr.getAvailableAccount();
  if (!account) {
    return res.json({ object: 'list', data: [] });
  }
  const models = await modelsMgr.getModels(account);
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: m.created,
      owned_by: m.owned_by,
    })),
  });
}

/**
 * 健康检查
 */
function handleHealth(req, res) {
  const accounts = accountMgr.loadAccounts();
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - stats.startTime) / 1000),
    accounts: accounts.length,
    enabledAccounts: accounts.filter(a => a.enabled).length,
    healthyAccounts: accounts.filter(a => a.healthStatus === 'healthy').length,
    configDir: config.CONFIG_DIR,
    stats: {
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      totalTokens: stats.totalTokens,
      sanitizedPrompts: stats.sanitizedPrompts,
    },
  });
}

function getStats() {
  return { ...stats, accounts: accountMgr.loadAccounts() };
}

module.exports = {
  handleChatCompletions,
  handleModels,
  handleHealth,
  getStats,
  createSseReader,
  extractDelta,
};
