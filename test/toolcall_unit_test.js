#!/usr/bin/env node
/**
 * toolcall 单元测试 - 覆盖流式 + 非流式下的边缘场景
 *
 * 重点：闭合标签风暴防御（用户截图场景）
 *   模型在长上下文里自模仿，疯狂吐孤立 </invoke>
 *   解析器必须：(1) 不让它泄漏给客户端 (2) 不误伤正常工具调用
 */

const assert = require('assert');
const {
  parseToolCalls,
  createStreamFilter,
  countUnmatchedCloseTags,
  hasToolCallMarker,
  findToolCallStart,
} = require('../src/toolcall.js');

let pass = 0;
let fail = 0;
const fails = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    fails.push({ name, error: e.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

console.log('\n\x1b[1m[1] countUnmatchedCloseTags\x1b[0m');
test('空字符串返回 0', () => assert.strictEqual(countUnmatchedCloseTags(''), 0));
test('普通文本返回 0', () => assert.strictEqual(countUnmatchedCloseTags('hello world'), 0));
test('单个 </invoke> 返回 1', () => assert.strictEqual(countUnmatchedCloseTags('</invoke>'), 1));
test('平衡的 <invoke>...</invoke> 返回 0', () => assert.strictEqual(countUnmatchedCloseTags('<invoke name="x">a</invoke>'), 0));
test('不平衡的开标签返回 0', () => assert.strictEqual(countUnmatchedCloseTags('<invoke name="x">a'), 0));
test('配对 + 额外闭合 返回 1', () => assert.strictEqual(countUnmatchedCloseTags('<invoke>x</invoke></invoke>'), 1));
test('50 个孤立闭合返回 50', () => assert.strictEqual(countUnmatchedCloseTags('</invoke>\n'.repeat(50)), 50));

console.log('\n\x1b[1m[2] parseToolCalls 闭合标签清理\x1b[0m');
test('纯闭合标签链 - content 应为空', () => {
  const r = parseToolCalls('正文。\n' + '</invoke>\n'.repeat(80));
  assert.strictEqual(r.toolCalls.length, 0);
  assert.ok(!r.content.includes('</invoke>'), 'content 不应包含 </invoke>');
});
test('混杂格式 - 只解析有效调用', () => {
  const r = parseToolCalls(
    '<invoke name="bash"><parameter name="command">ls</parameter></invoke>\n' +
    '</invoke>\n</invoke>\n</invoke>\n'
  );
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].function.name, 'bash');
});

console.log('\n\x1b[1m[3] createStreamFilter 风暴防御（关键）\x1b[0m');
test('流式路径不泄漏孤立闭合标签（用户截图场景）', () => {
  const filter = createStreamFilter();
  filter.push('继续执行。\n');
  let downContent = '';
  for (let i = 0; i < 80; i++) {
    const r = filter.push('</invoke>\n');
    if (r.content) downContent += r.content;
  }
  // 关键断言：客户端不应该收到任何 </invoke>
  assert.ok(!downContent.includes('</invoke>'),
    `客户端不应收到 </invoke>，但实际收到: ${downContent.length} chars`);
});
test('风暴触发后下发内容应为空', () => {
  const filter = createStreamFilter();
  filter.push('继续。\n');
  const r = filter.push('</invoke>\n</invoke>\n</invoke>\n');
  assert.strictEqual(r.content, '');
  assert.strictEqual(r.dropped, true);
  assert.strictEqual(r.reason, 'close_tag_storm');
});
test('finish 也走清理', () => {
  const filter = createStreamFilter();
  filter.push('分析中。\n');
  filter.push('</invoke>\n');
  filter.push('</invoke>\n');
  const fin = filter.finish();
  assert.ok(!fin.content.includes('</invoke>'));
});

console.log('\n\x1b[1m[4] 正常工具调用不应被误伤\x1b[0m');
test('完整 <invoke> 工具调用正常解析', () => {
  const filter = createStreamFilter();
  filter.push('思考中。\n');
  filter.push('<invoke name="bash">\n');
  filter.push('<parameter name="command">ls -la</parameter>\n');
  filter.push('</invoke>\n');
  const fin = filter.finish();
  assert.strictEqual(fin.toolCalls.length, 1);
  assert.strictEqual(fin.toolCalls[0].function.name, 'bash');
});
test('完整 <tool_call> JSON 工具调用正常解析', () => {
  const filter = createStreamFilter();
  filter.push('思考中。\n');
  filter.push('<tool_call>\n');
  filter.push('{"name":"search","arguments":{"q":"test"}}\n');
  filter.push('</tool_call>\n');
  const fin = filter.finish();
  assert.strictEqual(fin.toolCalls.length, 1);
  assert.strictEqual(fin.toolCalls[0].function.name, 'search');
  assert.strictEqual(fin.toolCalls[0].function.arguments, '{"q":"test"}');
});
test('开标签出现后转入 toolBuf 解析', () => {
  const filter = createStreamFilter();
  filter.push('分析问题。\n');
  filter.push('<function_calls>\n');
  filter.push('<invoke name="web_search">\n');
  filter.push('<parameter name="query">test</parameter>\n');
  filter.push('</invoke>\n');
  filter.push('</function_calls>\n');
  const fin = filter.finish();
  assert.strictEqual(fin.toolCalls.length, 1);
  assert.strictEqual(fin.toolCalls[0].function.name, 'web_search');
});

console.log('\n\x1b[1m[5] 真实场景模拟（OpenCode 长上下文）\x1b[0m');
test('OpenCode 长上下文自模仿 - 累积输出闭合', () => {
  // 模拟 OpenCode 在跑了 30 轮工具调用后，模型进入自模仿状态
  const filter = createStreamFilter();
  filter.push('继续。\n');
  // 模型吐出 200 个孤立闭合标签
  for (let i = 0; i < 200; i++) {
    const r = filter.push('</invoke>\n');
    assert.strictEqual(r.content, '', `第 ${i + 1} 次推送不应下发任何内容`);
    if (i === 0) {
      // 第一次推送就开始丢弃（阈值 = 1）
      assert.strictEqual(r.dropped, true);
    }
  }
});
test('嵌套 <invoke> 不被误判为孤立闭合', () => {
  // <invoke>x</invoke> 是配对的，不应该被当作"风暴"
  const filter = createStreamFilter();
  filter.push('<invoke name="x">a</invoke>\n');
  const fin = filter.finish();
  assert.strictEqual(fin.toolCalls.length, 1);
  assert.ok(!fin.content.includes('</invoke>'));
});

console.log('\n\x1b[1m[6] 边界情况\x1b[0m');
test('空 push', () => {
  const filter = createStreamFilter();
  assert.strictEqual(filter.push('').content, '');
  assert.strictEqual(filter.push(null).content, '');
  assert.strictEqual(filter.push(undefined).content, '');
});
test('只有 STREAM_HOLD_BACK 字符时不切', () => {
  const filter = createStreamFilter();
  // 短文本不足以触发切片
  const r = filter.push('hello');
  assert.strictEqual(r.content, '');
});
test('hasToolCallMarker', () => {
  assert.strictEqual(hasToolCallMarker('<tool_call>'), true);
  assert.strictEqual(hasToolCallMarker('<|DSML|>'), true);
  assert.strictEqual(hasToolCallMarker('<invoke name="x">'), true);
  assert.strictEqual(hasToolCallMarker('plain text'), false);
});
test('findToolCallStart', () => {
  assert.strictEqual(findToolCallStart('hello <invoke'), 6);
  assert.strictEqual(findToolCallStart('nothing here'), -1);
});

console.log('\n\x1b[1m========================================\x1b[0m');
console.log(`通过: ${pass}, 失败: ${fail}`);
if (fail > 0) {
  console.log('\n失败的测试:');
  fails.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
  process.exit(1);
}
process.exit(0);