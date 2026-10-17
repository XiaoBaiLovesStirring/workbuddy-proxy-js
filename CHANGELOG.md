# 更新日志

本项目版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

所有值得注意的变更都会记录在此文件。

---

## [2.2.0] - 2026-10-17

> 本版本修复 4 个稳定性 bug：
> - 流式路径下「闭合标签风暴」会让孤立 `</invoke>` 泄漏给客户端
> - 上游 error 被一律打成 `[ERROR]`，误把客户端主动断开的预期事件当成故障
> - 流式响应中途出错时仍发 `finish_reason=stop`，客户端以为正常完成
> - chunkId 同毫秒冲突 / 统计指标位置错误 / 请求日志写死 200

### 修复

- **工具调用：流式路径下的「闭合标签风暴」防御**
  旧 `createStreamFilter.push` 只检测工具调用**起始**标记（`<tool_call>` /
  `<invoke...>` / DSML），不检测**孤立闭合标签**。当模型在长上下文里进入
  「自模仿」状态、反复复制历史 `</invoke>` 时，这些闭合标签被当成正文流式
  下发到客户端，OpenCode / Claude Code 渲染成一长串空白行 + 闭合标签。
  `parseToolCalls`（一次性解析）的 `cleanupResidual` 兜底能清掉，**但流式
  push 已经把内容发出去了**。单元测试覆盖不足是漏测根因。
  现新增 `countUnmatchedCloseTags(text)`，push/finish 时实时检测孤立 `</invoke>`，
  阈值 1 即触发整段丢弃（不动 STREAM_HOLD_BACK 切片窗口，避免前 2 个泄漏），
  finish 兜底 `cleanupResidual` 清理零散残留。新增 21 个单元测试覆盖此路径。

- **proxy：区分「预期关闭」与「真上游错误」**
  旧 `upstreamRes.on('error')` 一律打 `[ERROR]`，但 `aborted`（来自
  `destroy()`）、`ECONNRESET`、`socket hang up` 都是**预期的 socket 关闭
  信号**——客户端主动断开、我们主动 destroy 上游、上游正常收尾都会触发。
  现新增 `isExpectedSocketClose(e, clientGone)` 工具函数：
  - 客户端已断开（clientGone=true）→ 任何 error 都视为预期
  - `aborted` / `ECONNRESET` / `socket hang up` → 预期
  - 其余 → 真错误
  预期关闭改打 `[INFO]`（不再是 ERROR），避免误导排查；headersSent=false 时
  真错误回 502、预期关闭回 **499**（Client Closed Request，HTTP 标准状态码）。

- **proxy：流式错误帧语义修复**
  原 error handler 给客户端发 `finish_reason=stop + [DONE]`，客户端以为对话
  正常完成，但实际流被腰斩——上游真崩溃时内容残缺用户却看不见告警。
  现改发 `finish_reason=length + [DONE]`（OpenAI 规范允许的合法 finish_reason，
  表示「异常终止 / 长度限制导致截断」），客户端可识别为异常收尾。
  注：`streamPassthrough` 透传模式不动（上游 SSE 帧原样转发，无 finish_reason
  帧时客户端会自然识别为中断）。

- **proxy：chunkId 同毫秒冲突修复**
  旧 `chatcmpl-${Date.now()}` 在同毫秒下会产生相同 id（OpenCode / Claude Code
  会把相同 id 的 chunk 当成同一个响应吞掉，导致内容 / 工具调用丢失）。
  现改为 `chatcmpl-{Date.now().36}-{chunkSeq++}-{rand}` 形式：
  36 进制时间戳 + 进程内自增序号 + 4 字符随机后缀，全局唯一。

- **proxy：successRequests 累加位置修正**
  旧逻辑在「转发开始」时累加 `stats.successRequests++`，失败的请求也被
  算成 success。现改为在 `await new Promise` 转发完成后根据 `upstreamOk` 判断：
  - `onSettled(true)` → `successRequests++`
  - `onSettled(false)` → `failedRequests++`
  失败率统计能反映真实情况。

- **proxy：请求日志写入真实状态**
  旧 `logger.request(...200...)` 写死 200，无论上游是否真挂。
  现根据 `upstreamOk` 写 200 或 502（仅 requests.log 文件，HTTP 给客户端的
  200 不变——headers 已下发，回不了别的状态码）。

### 新增

- 工具调用 / 错误处理 / bug 修复 共 **38 个单元回归测试**：
  - `test/toolcall_unit_test.js` — 21 个（含闭合标签风暴防御）
  - `test/proxy_error_unit_test.js` — 9 个（isExpectedSocketClose）
  - `test/proxy_bugfix_test.js` — 8 个（4 个新 bug 的源码级断言）

---

> 本版本聚焦「工具调用」与「多模态输入」的兼容性修复，是 2.0.0 之后的一次功能性修复发布。

### 修复

- **工具调用：新增 Anthropic `<invoke>` / `<function_calls>` 格式解析**
  Claude Code / OpenCode / Cline 这类客户端会在 system prompt 里教模型使用
  `<invoke name="…"><parameter name="…">…</parameter></invoke>` 格式。模型偶尔
  真的按这个格式输出时，旧解析器完全不认识 —— 既不转成 tool_calls，也不清理，
  于是原始标记直接泄漏到回答里，客户端看到一堆空 `<invoke></invoke>` 会误判为
  「正在调用工具」而卡死。
  现完整支持：`<function_calls>` 包裹块、裸 `<invoke>`、`antml:` 前缀、
  未闭合的 `</invoke`、无 name 的空标签（清理但不产生调用）。
  同时对 `<function_calls>` / `<invoke>` / `<parameter>` 做兜底清理，确保零泄漏。

- **提示词清洗：新增「宽松模式」（现为默认）**
  旧逻辑命中 Agent 指纹后，会把整条 system prompt **替换**成
  `You are a helpful assistant.`。但第三方 Agent 的 system prompt 里包含大量
  **工具调用规范、参数格式说明、skill 定义**，整条替换会让模型丢掉这些规范，
  进而乱吐工具标记、反复调用同一个工具 —— 这正是「AI 被迫停下」的根因。
  宽松模式改为**只定向改写身份声明**（`You are Claude Code…` → `You are a helpful
  assistant.`）并抹掉品牌链接，**完整保留工具规范 / skill 说明 / 行为准则**。
  实测同一份 Claude Code system prompt：身份句被替换，`<invoke>` 用法说明、
  工具规则、TodoWrite 说明全部保留（保留约 75% 内容）。
  可用 `SANITIZE_MODE` 环境变量切换：`loose`（默认）/ `strict`（旧行为）/ `off`。

- **调试：新增工具调用原文落盘开关**
  设置 `DEBUG_TOOLCALL_DUMP=/path/to/file.log` 后，工具模式下上游返回的原始文本
  会追加写入该文件，便于排查参数丢失、格式异常等问题。

- **长任务：修复长时间运行中途断联（不能完整跑完）**
  由三个叠加原因造成，逐一修复：
  1. **流式响应期间不向下游发送任何心跳** —— 大量客户端（Cherry Studio / Cline /
     各类 OpenAI SDK / 网关）在空闲若干秒收不到字节时会主动断连，这是长任务
     被腰斩的首要原因。现每 15 秒发送一条 SSE 注释行 `: keep-alive` 保活
     （注释行客户端会忽略，但会重置其空闲计时器）。
  2. **超时配置过紧** —— Node 默认 `server.requestTimeout = 300s` 会掐断慢请求；
     上游 socket 空闲超时仅 120s，模型长时间思考时会被误杀。
     现分别设为 `0`（不限单请求总时长）与 `600s`。
  3. **上游单次失败即终止整个任务** —— 现自动**换账号重试**，最多 3 次；
     可重试状态码覆盖 `401/403`（单账号 token 失效）、`429`（限流）与
     `5xx`（网关 / 服务端故障）。

- **客户端提前断开时未中止上游请求**
  导致上游连接、配额与账号统计被持续污染，长时间运行会累积。现监听
  `res.close` 并立即 `destroy()` 上游请求。

- **上游流中途出错时不下发结束帧**
  客户端会一直挂着等 `[DONE]`，表现为「卡死」。现补发结束帧 + `data: [DONE]`
  优雅收尾，让客户端能正常结束本轮。

- **工具调用：新增 DSML 原生格式解析**
  模型（DeepSeek 系）原生输出的 DSML 格式工具调用
  （`<｜｜DSML｜｜ invoke name="…">` / `<｜｜DSML｜｜ parameter …>`）此前无法识别，
  会被当作正文直接吐给客户端。现新增完整解析，兼容全角竖线 `｜`（U+FF5C）与半角竖线 `|`、
  `invoke` / `parameter` 结构、`arguments` 与 `name` 参数变体、无 `calls` 外层包裹、
  混用闭标签、流式截断等场景。

- **工具调用：新增残留标记兜底清理**
  无论解析成功与否，`<tool_call>` / DSML 原始标记都不会出现在用户可见的 `content` 中。

- **工具调用：改为真流式输出**
  旧实现在工具模式下等上游整段响应结束才一次性返回，客户端生成期间长时间无输出（表现为白屏/卡死）。
  现改为正文增量下推（实测首字节约 1.0s），工具调用块单独缓冲，流结束后统一解析为
  OpenAI `tool_calls` 并按规范分两步下发。

- **SSE 解析：修复跨 chunk 断行导致内容静默丢失**
  旧实现使用 `chunk.toString().split('\n')` 解析 SSE，一条 JSON 行被 TCP 分片切断时
  `JSON.parse` 失败并被静默忽略。现新增跨 chunk 增量行缓冲，并正确处理 `\r\n`、
  `: heartbeat` 注释行与 `[DONE]`。

- **多轮对话：修复上游 400「工具记录不完整」**
  发往上游的消息残留 `tool_calls` / `tool_call_id` 字段，上游校验工具记录配对后直接拒绝
  （`400 code=11148 tool calls and tool results do not match`）。现只保留 `role` + `content`。

- **多模态：修复图片输入被丢弃**
  消息规范化逻辑曾把数组型 `content` 拍平为纯文本，导致 `image_url` 分片被整体丢弃，
  模型回复「我看不到图片」。现保留数组结构，并统一归一化各家客户端写法。

- **模型列表**：同时请求 `/v2/enterprises/personal/models` 与 `/v3/config`，
  合并取并集，修复模型列表不全的问题。

- **启动**：修复端口被占用时进程崩溃的问题，改为友好提示并退出。

### 新增

- 兼容并自动转换多种图片写法：OpenAI `image_url`（对象/字符串）、
  OpenAI Responses API `input_image`、Anthropic `image` + `source`（base64 / url），
  统一转换为上游可识别的 `image_url` 分片。
- 透传上游 `reasoning_content`（思考内容）。
- 支持 `tool_choice: "none"`（不注入工具定义）。
- 工具模式下立即下发 SSE 响应头（`flushHeaders`），避免客户端等待首字节超时。
- 回归测试脚本：
  - `test/full_stream_test.py` — 流式/非流式全量回归、Agent 循环、`tool_choice`
  - `test/long_chain_test.py` — 长链 Agent 多轮工具调用压测
  - `test/vision_test.py` — 图片多模态输入回归

---

## [2.0.0] - 2026-10-17

### 新增

- **配置目录标准化**：`~/.config/workbuddyaip/`（`API/` 账号、`logs/` 日志）
- **自动注册安装脚本**：Linux/macOS `install.sh` + Windows `install.bat`，注册系统命令
- **官方格式账号导入**：支持从 WorkBuddy 客户端导出的 `.json` 文件自动识别导入
- **保活机制**：定时刷新 token、查询额度、健康检查（默认 5 分钟）
- **提示词清洗**：自动移除 OpenCode / Claude Code / Codex / Cline 等第三方 Agent 注入的 system prompt
- **日志系统**：按日期分割的日志文件 + 请求日志
- **工具调用模拟**：通过 Prompt 注入 + 响应解析，让不支持原生工具调用的上游具备工具调用能力
- **多账号轮询**：支持多账号，自动轮询调度
- **模型自动发现**：从上游动态获取模型列表，缓存 1 小时
- **Web 管理面板**：账号管理、模型列表、对话测试、设置、实时统计

### 变更

- 双区域支持：国际版（workbuddy.ai）+ 国内版（copilot.tencent.com）
- 出站身份头按 5.8.4 抓包对齐（UA、会话头族、trace 头族）

---

## [1.0.0]

- 初始版本：OpenAI 兼容接口（`/v1/chat/completions`、`/v1/models`），单账号转发。

---

[2.2.0]: https://github.com/XiaoBaiLovesStirring/workbuddy-proxy-js/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/XiaoBaiLovesStirring/workbuddy-proxy-js/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/XiaoBaiLovesStirring/workbuddy-proxy-js/releases/tag/v2.0.0
