# WorkBuddy Proxy (Node.js) v2.1

腾讯 WorkBuddy / CodeBuddy 反代 — 将原生服务封装为标准 OpenAI 兼容接口。

> [!WARNING]
> **本项目为非官方、第三方技术研究项目**，与腾讯、WorkBuddy、CodeBuddy、DeepSeek 及其运营方
> **无任何关联、合作、授权、认可或背书关系**。
>
> **仅供个人学习与技术研究使用 —— 禁止任何商业用途，禁止对外提供服务，禁止公开部署。**
>
> **使用者自行承担全部风险与法律责任**；作者与贡献者不承担任何责任，
> 并保留就违规使用所造成损失向使用者**追偿**的权利。
>
> 📖 完整条款见 **[DISCLAIMER.md](DISCLAIMER.md)** ——
> 下载、运行、修改或分发本项目，即视为已完整阅读并不可撤销地接受全部条款。

> **当前版本 v2.1** · [更新日志](CHANGELOG.md) · [开源协议](#开源协议)：PolyForm Noncommercial 1.0.0（禁止商用） · [免责声明](#免责声明)

## v2.1 新特性

- **工具调用兼容 DSML 原生格式**：识别 DeepSeek 系模型原生的 `<｜｜DSML｜｜ invoke>` 格式，不再把原始标记吐到聊天框
- **工具调用改为真流式**：正文增量下推（首字节约 1s），不再等整段响应生成完毕才返回
- **多模态图片输入**：支持 OpenAI / Anthropic 等多种图片写法，修复图片被丢弃、模型「看不到图」的问题
- **多轮 Agent 对话**：修复上游 400「工具记录不完整，请新建任务」
- **SSE 解析**：修复跨 chunk 断行导致的内容静默丢失

## v2.0 特性（回顾）

- **配置目录标准化**：`~/.config/workbuddyaip/`（API/ 账号、logs/ 日志）
- **自动注册安装脚本**：Linux/macOS `install.sh` + Windows `install.bat`，注册系统命令
- **官方格式账号导入**：支持从 WorkBuddy 客户端导出的 .json 文件自动识别导入
- **保活机制**：定时刷新 token、查询额度、健康检查（默认 5 分钟）
- **提示词清洗**：自动移除 OpenCode/Claude Code/Codex/Cline 等第三方 Agent 注入的 system prompt
- **日志系统**：按日期分割的日志文件 + 请求日志

## 功能

- **OpenAI 兼容**：`/v1/chat/completions`（流式/非流式）、`/v1/models`
- **双区域支持**：国际版 (workbuddy.ai) + 国内版 (copilot.tencent.com)
- **免 API Key**：本地使用，无需验证
- **模型自动发现**：从上游动态获取模型列表，缓存 1 小时
- **多账号轮询**：支持多账号，自动轮询调度
- **Web 管理面板**：账号管理、模型列表、对话测试、设置、实时统计

## 快速开始

### 方式一：自动安装（推荐）

```bash
# Linux / macOS
chmod +x install.sh
./install.sh

# Windows
install.bat
```

安装后即可使用系统命令：
```bash
workbuddy-proxy          # 启动
workbuddy-proxy-stop     # 停止
workbuddy-proxy-status   # 状态
```

### 方式二：手动运行

```bash
npm install
npm start
```

## 配置目录结构

```
~/.config/workbuddyaip/
├── API/                    # 账号文件目录
│   ├── accounts.json       # 代理内部格式（自动生成）
│   └── *.json              # 官方导出的账号文件（自动扫描导入）
├── logs/                   # 日志目录
│   ├── proxy-YYYY-MM-DD.log
│   └── requests.log
└── app/                    # 程序文件（安装脚本自动复制）
```

## 添加账号

### 方式一：官方格式文件导入（推荐）

1. 从 WorkBuddy 客户端导出账号 JSON 文件
2. 将文件放到 `~/.config/workbuddyaip/API/` 目录
3. 重启代理，或在管理页点击"扫描 API 目录导入"

### 方式二：管理页手动添加

打开 `http://127.0.0.1:8788/` → 账号管理 → 填入 UID 和 Access Token

## 使用

在任何支持 OpenAI 兼容接口的客户端中配置：

- **Base URL**: `http://127.0.0.1:8788/v1`
- **API Key**: 任意填写（或留空）
- **模型**: 从管理页查看可用模型列表

## 提示词清洗

自动检测并移除以下 Agent 注入的 system prompt：
- OpenCode / OhMyOpenCode
- Claude Code
- Codex CLI
- Cline / Roo Code
- Cola Code
- Aider
- Cursor / Windsurf / Continue / Zed
- 通用 "coding agent" 身份指纹

清洗后替换为干净的默认 prompt：`You are a helpful assistant.`

可在管理页"设置"中测试清洗效果。

## 工具调用模拟

上游 `/v2/chat/completions` 不原生支持 OpenAI 工具调用（会忽略 `tools`，`delta.tool_calls` 恒为空）。
代理通过 **Prompt 注入 + 响应解析** 实现兼容：

```
客户端 tools 定义  →  注入 system prompt  →  上游纯文本输出  →  代理解析  →  标准 OpenAI tool_calls
```

### 支持的输出格式

模型不总是老老实实按注入的格式输出，代理对以下格式做了兼容解析：

| 格式 | 示例 | 说明 |
|------|------|------|
| 标准注入格式 | `<tool_call>{"name":"fn","arguments":{...}}</tool_call>` | 所有模型通用 |
| DSML 原生格式 | `<｜｜DSML｜｜ invoke name="fn">…</｜｜DSML｜｜ invoke>` | DeepSeek 系模型原生格式 |
| 混用/截断 | `<tool_call>` 开标签 + DSML 闭标签 | 模型偶发混用，靠平衡 JSON 提取兜底 |

> DSML 标记的竖线可能是**半角 `|`** 也可能是**全角 `｜`（U+FF5C）**，两种都能识别。

### 关键保证

1. **绝不泄漏**：解析后会强制清理残留标记，`<tool_call>` / DSML 原始标记不会出现在用户可见的 `content` 里。
2. **真流式**：正文增量下推（不再等全文生成完），工具调用块单独缓冲、流结束后统一解析。
3. **不丢字**：SSE 采用跨 chunk 增量行缓冲，避免 JSON 行被 TCP 分片切断导致静默丢内容。
4. **多轮可用**：发往上游的消息会剥离 `tool_calls` / `tool_call_id` 字段，否则上游会返回 400「工具记录不完整，请新建任务」。

## 多模态（图片）输入

上游支持 OpenAI 标准多模态格式（`content` 为数组 + `image_url`），代理**原样保留**图片分片，不会拍平。

各客户端写法差异会由代理自动归一：

| 客户端写法 | 转换后 |
|------------|--------|
| `{type:"image_url", image_url:{url}}` | 原样透传 |
| `{type:"image_url", image_url:"data:..."}` | 包装为 `{url}` |
| `{type:"input_image", image_url}`（Responses API） | 转为 `image_url` |
| `{type:"image", source:{type:"base64", media_type, data}}`（Anthropic） | 转为 `image_url` + data URL |
| `{type:"image", source:{type:"url", url}}`（Anthropic） | 转为 `image_url` |

> 全部为文本分片时会自动合并成字符串；含图片时保留数组结构。
> 回归脚本：`test/vision_test.py`（流式/非流式、OpenAI/Anthropic 格式、图片+工具混合）。

## 保活机制

默认每 5 分钟执行一次：
1. **Token 刷新**：检测到 token 即将过期（前 1 小时）自动刷新
2. **健康检查**：验证每个账号的 token 是否有效
3. **额度查询**：更新账号余额/积分信息

可通过环境变量 `KEEPALIVE_INTERVAL` 调整间隔（毫秒）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8788 | 监听端口 |
| `HOST` | 127.0.0.1 | 监听地址 |
| `WB_CONFIG_DIR` | ~/.config/workbuddyaip | 配置目录 |
| `KEEPALIVE_INTERVAL` | 300000 | 保活间隔（毫秒） |
| `PROMPT_SANITIZE` | true | 提示词清洗开关 |

## API 端点

### OpenAI 兼容
| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 对话补全（支持流式） |
| `/v1/models` | GET | 模型列表 |
| `/health` | GET | 健康检查 |

### 管理 API
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/accounts` | GET/POST | 账号列表/添加 |
| `/api/accounts/:id` | DELETE | 删除账号 |
| `/api/accounts/:id/toggle` | PATCH | 切换启用 |
| `/api/accounts/:id/test` | POST | 测试连通性 |
| `/api/accounts/rescan` | POST | 重新扫描 API 目录 |
| `/api/models` | GET | 模型列表（含元数据） |
| `/api/models/refresh` | POST | 强制刷新模型 |
| `/api/keepalive/run` | POST | 立即执行保活 |
| `/api/keepalive/status` | GET | 保活状态 |
| `/api/sanitizer/test` | POST | 提示词清洗测试 |
| `/api/stats` | GET | 统计信息 |
| `/api/config` | GET | 配置信息 |

## 项目结构

```
workbuddy-proxy-js/
├── src/
│   ├── server.js       # 主入口，HTTP 服务器
│   ├── proxy.js        # 代理核心，chat 转发
│   ├── identity.js     # 身份头构造（5.8.4 抓包对齐）
│   ├── fingerprint.js  # 设备指纹派生（UUIDv7）
│   ├── account.js      # 账号管理（官方格式导入）
│   ├── models.js       # 模型自动发现
│   ├── keepalive.js    # 保活机制（token 刷新/额度查询）
│   ├── sanitizer.js    # 提示词清洗
│   ├── logger.js       # 日志系统
│   └── config.js       # 配置管理
├── public/
│   └── index.html      # 管理面板
├── test/
│   ├── full_stream_test.py   # 流式/非流式全量回归（需本地代理已启动）
│   ├── long_chain_test.py    # 长链 Agent 多轮工具调用压测
│   └── vision_test.py        # 图片多模态输入回归
├── install.sh          # Linux/macOS 安装脚本
├── install.bat         # Windows 安装脚本
├── package.json
├── LICENSE             # PolyForm Noncommercial 1.0.0
├── DISCLAIMER.md       # 免责声明（必读）
├── CHANGELOG.md        # 更新日志
└── README.md
```

## 开源协议

本项目采用 **[PolyForm Noncommercial License 1.0.0](LICENSE)**（非商业许可，专为软件设计）。

选它是因为它恰好对应本项目想要的两条边界：**放开二次创作，锁死商业用途**。

### ✅ 你可以自由

- **使用**：个人研究、实验、测试、学习、业余爱好项目
- **修改 / 翻版 / 二次创作**：任意改写、重构、生成衍生版本，**包括由 AI 工具（AI 翻版）来完成**
- **分发**：转载、分享、再发布原始版本或修改后的版本
- **非商业组织使用**：慈善机构、教育机构、公共研究机构、公共安全与卫生机构、环保组织、政府机构

### ❌ 你不可以

- **任何商业行为**：不得用于营利、商业产品、付费服务、企业内部生产环境，或任何具有商业目的的场景
- **转授权 / 转让许可**给第三方

### 📌 你需要遵守

- **保留声明**：分发时（含修改版）必须一并提供本协议全文或协议链接，并保留 `Required Notice` 行
- **保留署名**：不得移除原作者信息

> 商业授权请联系作者。

完整法律条款见 [LICENSE](LICENSE)。

---

## 声明

> **本项目使用 WorkBuddy + DeepSeek_v4.1_flash 完成，含人量 0%。**

需求澄清 → Bug 复现 → 代码编写 → 调试排错 → 回归测试 → 文档撰写 → 提交推送，全部由 AI 独立完成。

---

## 免责声明

> ⚠️ **使用本项目前，请务必完整阅读 [DISCLAIMER.md](DISCLAIMER.md)。**
> 下载、运行、修改或分发本项目，即视为已完整阅读并不可撤销地接受其全部条款。

### 一句话总结

本项目**仅供个人学习与技术研究**。禁止任何商业用途，禁止对外提供服务，
使用者**自行承担全部风险与法律责任**，作者与贡献者**不承担任何责任**。

### 关键条款速览

| 条款 | 内容 |
| --- | --- |
| **非官方** | 与腾讯 / WorkBuddy / CodeBuddy / DeepSeek **无任何关联、合作、授权或背书关系**；所有商标归各自所有者 |
| **禁止商用** | 不得销售、收费、内置到商业产品、用于企业生产环境或任何营利活动 |
| **禁止对外服务** | 不得部署为第三方可访问的公开 API，仅限个人私有环境使用 |
| **风险自担** | 账号封禁、服务中断、违反第三方协议、数据泄露、法律风险等一律自负 |
| **无担保** | 以「现状（AS IS）」提供，不含任何明示或暗示担保 |
| **责任限制** | 任何直接 / 间接损失（含利润、数据、商誉、律师费）作者概不负责 |
| **赔偿义务** | 因你的使用引起的索赔，你须为作者**抗辩、赔偿并使其免受损害**（含律师费） |
| **凭据安全** | 凭据仅存本地、无遥测；请勿在公开场合粘贴真实 token |
| **侵权处理** | 权利人可联系作者，核实后依法尽快删除相关内容 |
| **变更与接受** | 作者可随时修改本声明，无需通知；继续使用即视为接受 |

### 建议

- 有长期 / 生产环境需求 —— **请使用官方正规服务与授权渠道**。
- 完成学习研究后 —— **建议及时删除本地副本**。
- 对合法性有任何疑虑 —— **请咨询专业律师**。

> **效力边界提示**：免责声明约束的是「使用者与作者之间」的权利义务关系。
> 它**不能**免除任何一方对第三方服务提供方应负的义务，
> 也**不能**阻止第三方依据其自身协议或法律主张权利。

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — 允许任意非商业使用与二次创作（含 AI 翻版），**禁止任何商业用途**。
