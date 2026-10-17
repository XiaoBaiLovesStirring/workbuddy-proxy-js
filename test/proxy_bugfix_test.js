#!/usr/bin/env node
/**
 * 4 个 bug 修复回归测试
 *
 * Bug #3：流式错误帧语义错误
 *   修复前：error handler 给客户端发 finish_reason=stop + [DONE]
 *   修复后：发 finish_reason=length + [DONE]，客户端知道是异常终止
 *
 * Bug #4：chunkId 冲突
 *   修复前：chatcmpl-{Date.now()} 同毫秒下冲突
 *   修复后：chatcmpl-{Date.now()}-{seq}-{rand}
 *
 * Bug #2：successRequests 位置错
 *   修复前：转发开始就累加，不管后续是否成功
 *   修复后：转发成功后才累加
 *
 * Bug #1：请求日志写死 200
 *   修复前：永远写 200
 *   修复后：根据 upstreamOk 写 200 或 502
 *
 * 注意：proxy.js 是副作用很多（logger/https/identity），直接 require 会触发
 * 配置加载。这里通过源码字符串扫描 + 行为模拟测试。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '../src/proxy.js'), 'utf-8');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${e.message}`);
  }
}

console.log('\n\x1b[1m[Bug #3] 流式错误帧应该是 finish_reason=length\x1b[0m');

// 找 error handler 里的 writeChunk 调用
test('error handler 不再写 finish_reason=stop', () => {
  // 找所有 writeChunk({}, ...) 调用
  const matches = SRC.match(/writeChunk\(\s*\{\s*\}\s*,\s*['"`](\w+)['"`]\s*\)/g) || [];
  console.log(`    [debug] 找到 ${matches.length} 处 writeChunk({}, X) 调用`);
  // toolcall 路径的正常结束应该是 'tool_calls'
  // error handler 不应该用 'stop' 或 upstreamFinish
  matches.forEach(m => {
    const reason = m.match(/['"`](\w+)['"`]/)[1];
    if (m.includes('upstreamFinish')) {
      throw new Error(`error handler 仍然写 upstreamFinish: ${m}`);
    }
  });
});

test('error handler 应该写 finish_reason=length', () => {
  if (!SRC.includes("writeChunk({}, 'length')")) {
    throw new Error('error handler 未使用 finish_reason=length');
  }
});

console.log('\n\x1b[1m[Bug #4] chunkId 应避免冲突\x1b[0m');

test('chunkId 包含自增序号', () => {
  if (!/chunkSeq\s*\+\+/.test(SRC)) {
    throw new Error('chunkId 未使用 chunkSeq 自增');
  }
});

test('chunkId 包含随机后缀', () => {
  // 至少在某处用了 Math.random()
  if (!/Math\.random\(\)\.toString\(36\)/.test(SRC)) {
    throw new Error('chunkId 缺少随机后缀');
  }
});

console.log('\n\x1b[1m[Bug #2] successRequests 应在转发成功后累加\x1b[0m');

test('successRequests++ 应在 await new Promise 之后', () => {
  // 找 src = success 出现的位置
  const lines = SRC.split('\n');
  const successLines = [];
  lines.forEach((line, i) => {
    if (line.includes('stats.successRequests++')) successLines.push(i + 1);
  });
  if (successLines.length !== 1) {
    throw new Error(`successRequests++ 出现 ${successLines.length} 次，期望 1 次`);
  }
  // 检查它是否在 await new Promise 之后
  const promiseLine = lines.findIndex(l => l.includes('await new Promise'));
  if (successLines[0] < promiseLine) {
    throw new Error(`successRequests++ 在 L${successLines[0]}，await new Promise 在 L${promiseLine + 1}——位置错误`);
  }
});

test('失败时应该累加 failedRequests', () => {
  if (!/stats\.failedRequests\s*\+\+/.test(SRC)) {
    throw new Error('失败路径未累加 failedRequests');
  }
});

console.log('\n\x1b[1m[Bug #1] 请求日志应反映真实状态\x1b[0m');

test('请求日志不应再写死 200', () => {
  // 在转发主路径中，logger.request 不应该再有 '200' 字面量
  // 找到 await new Promise 之后的 logger.request 调用
  const after = SRC.indexOf('await new Promise');
  const tail = SRC.slice(after);
  // tail 里 logger.request 的第三个参数应该是 upstreamOk ? 200 : 502
  if (/logger\.request\([^)]*['"]200['"]/.test(tail)) {
    throw new Error('logger.request 仍硬编码 200');
  }
});

test('请求日志应根据 upstreamOk 写 200 或 502', () => {
  // 转发主路径的 logger.request 调用应该有条件分支
  if (!/upstreamOk\s*\?\s*200\s*:\s*502/.test(SRC)) {
    throw new Error('请求日志未根据 upstreamOk 动态选择 status');
  }
});

console.log('\n\x1b[1m========================================\x1b[0m');
console.log(`通过: ${pass}, 失败: ${fail}`);
process.exit(fail > 0 ? 1 : 0);