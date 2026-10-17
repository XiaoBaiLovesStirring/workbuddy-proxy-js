#!/usr/bin/env node
/**
 * proxy 错误处理单元测试 - 验证上游 error 区分预期 vs 真错误
 */

const assert = require('assert');
const path = require('path');

// 通过 require proxy.js 拿到 isExpectedSocketClose
// 但 proxy.js 直接 require 会触发大量副作用（logger、https...）
// 所以这里直接复制函数测试 —— 接受一点代码重复以换取测试独立
function isExpectedSocketClose(e, clientGone) {
  if (!e) return true;
  if (clientGone) return true;
  if (e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  if (e.message === 'aborted' || e.message === 'socket hang up' || e.message === 'premature close') return true;
  return false;
}

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

console.log('\n\x1b[1m[1] isExpectedSocketClose - 区分预期关闭 vs 真错误\x1b[0m');

test('null error → true', () => assert.strictEqual(isExpectedSocketClose(null, false), true));
test('undefined error → true', () => assert.strictEqual(isExpectedSocketClose(undefined, false), true));

test('aborted + 客户端在 → true (我们主动 destroy 触发的)', () => {
  const e = new Error('aborted');
  assert.strictEqual(isExpectedSocketClose(e, false), true);
});

test('ECONNRESET → true (上游正常关闭)', () => {
  const e = new Error('read ECONNRESET');
  e.code = 'ECONNRESET';
  assert.strictEqual(isExpectedSocketClose(e, false), true);
});

test('socket hang up → true', () => {
  const e = new Error('socket hang up');
  assert.strictEqual(isExpectedSocketClose(e, false), true);
});

test('任何 error + clientGone → true (客户端已断，啥都是预期)', () => {
  const e = new Error('some random error');
  e.code = 'EBUSY';
  assert.strictEqual(isExpectedSocketClose(e, true), true);
});

test('unknown error + 客户端在 → false (真错误)', () => {
  const e = new Error('something weird');
  assert.strictEqual(isExpectedSocketClose(e, false), false);
});

test('真错误：TLS 握手失败', () => {
  const e = new Error('unable to verify the first certificate');
  e.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  assert.strictEqual(isExpectedSocketClose(e, false), false);
});

test('真错误：上游 5xx 但 socket 阶段触发 error', () => {
  const e = new Error('Response code 502');
  e.code = 'BAD_RESPONSE';
  assert.strictEqual(isExpectedSocketClose(e, false), false);
});

console.log('\n\x1b[1m========================================\x1b[0m');
console.log(`通过: ${pass}, 失败: ${fail}`);
process.exit(fail > 0 ? 1 : 0);