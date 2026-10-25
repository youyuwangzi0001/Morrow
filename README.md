# Morrow · 明日工坊

> 住在你电脑里的 AI 工作伙伴。说清想要的结果，Morrow 会读文件、写代码、运行命令、检查成品，并把结果放回你的工作区。

Morrow 是一个面向 Windows 10/11 x64 的本地桌面 AI Agent：Electron 44 + React 19 + TypeScript。它把对话、工作模式、计划、深度研究、长期目标、文件编辑、画布、真实终端、Git、内置浏览器、项目记忆、技能、MCP、定时任务和本机多媒体放在同一个工作台里。模型可以来自 API Key、官方 Agent 订阅，或本机 llama.cpp / Ollama / LM Studio；所有数据默认留在本机。

![Morrow 主界面](docs/guide/screens/02-chat-home-dark.png)

## 核心能力

### 从一句话到可验收的成品

- **聊天 / 工作 / 计划 / 深度研究 / 长期目标**五种工作方式。聊天模式只读；工作模式可以写文件和执行命令；计划模式先给出可审阅的计划；研究模式会查证并保留来源；目标模式可以跨轮持续推进，直到交付可验证的结果。
- **审批卡**把“它想做什么、会影响什么”写清楚。只读、询问、完全访问三档权限；危险命令、越界路径和外部副作用动作始终逐次确认。
- **代码与成品**：文件树、CodeMirror 编辑器、多标签画布、HTML/Markdown/PDF/Office/图片/音视频预览、版本历史、导出与另存为。
- **可恢复**：每个用户轮次有检查点，写文件前有快照；支持会话回退、文件回退和冲突校验。

### 真实终端、Git 与浏览器

- **真实 PTY 终端**：多标签、后台任务、复制粘贴、拖动调高。默认终端是 **Git Bash**；旧版 Windows PowerShell 5.1 和 CMD 选项已移除，仍可选择 PowerShell 7 / WSL。
- **Git 工作台**：变更、diff、暂存、提交、分支、历史、放弃改动；diff 超长时截断展示。
- **内置浏览器**：多标签、地址栏、前进后退、真实网页内容；登录窗口与普通浏览共用同一套安全边界。

![终端与工作台](docs/guide/screens/10-terminal-dark.png)

### 模型、订阅与账号元信息

- 内置 OpenAI 兼容（DeepSeek、Kimi、Qwen、GLM、MiniMax、MiMo、Gemini、Grok、Meta 等）与 Anthropic Claude 接入；也支持任意 OpenAI 兼容网关和本机服务。
- **官方 Agent 订阅**：ChatGPT/Codex、Qoder、Kimi Code、GLM Coding Plan、MiniMax Code、Step Plan、Command Code、Cline Pass、Google Antigravity、OpenCode，以及第三方 coding plan。
- **Qoder 账号驱动目录**：登录后读取账号接口返回的模型、200K/400K/1M 上下文档位与真实思考档位；设置页可按模型调整默认上下文。Morrow 不维护 Qoder 静态模型表。
- **模型能力契约**：选择器只显示原始模型名；思考强度只列模型真实支持的档位；不支持时显示“不支持思考”；未知模型只保留“自动”。DeepSeek 的关闭思考在请求层映射为官方 `none`，Qoder 代理保持自己的 `off`。
- **本机多媒体**：ComfyUI、llama.cpp、Ollama、LM Studio；图片/视频生成、编辑、抽帧、拼接、审看。媒体审看始终优先当前对话模型，当前模型不支持或失败后才回退到声明视觉能力的本地模型。

### 项目、记忆与自动化

- **项目主页**：项目背景、说明与资料、项目内会话、当前文件夹范围。
- **记忆中心**：项目记忆、全局长期记忆、任务经验、注入预览与自进化建议。
- **技能库**：内置技能与工作区 `.morrow/skills`；支持 Markdown 技能包与安全安装。
- **MCP**：stdio / Streamable HTTP / 旧版 SSE；工具、资源、提示词、OAuth 与工作区信任。
- **定时任务**：一次/每天/每周，只读或可改文件；无人值守时自动拒绝需要审批的动作。
- **集群与侧聊**：1–10 个集群成员并行处理独立子任务；`/btw` 侧聊不写主会话。

### 本地优先与稳定性

- 数据、会话、快照、日志与密钥都在本机；密钥用系统加密（Windows DPAPI / safeStorage）保存，渲染层永远拿不到明文。
- 打包版启用本地崩溃转储；主进程未捕获异常、未处理 Promise、子进程消失与渲染进程崩溃都会记录；主窗口渲染进程崩溃会自动恢复（有频率上限），并记录无响应事件。
- 应用不内置 Antigravity OAuth secret；使用 Antigravity 订阅时需自行设置 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。

## 快速开始

### 环境

- Windows 10/11 x64
- Node.js 22+（开发）
- Git（推荐；默认终端使用 Git Bash）
- 可选：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、ffmpeg

### 从源码运行

```powershell
npm install
npm run dev
```

构建并运行构建产物：

```powershell
npm run build
npm start
```

### 使用发布包

发布包提供单文件便携版与 NSIS 安装包：

- 便携版首次运行会在 exe 同级解压 `.morrow-runtime-0.1.0-r019`；之后启动更快，运行中不要删除。
- 便携版数据默认在 exe 同级的 `Morrow Data`；安装版默认在 `%APPDATA%\Morrow`。可在「设置 → 关于」更改数据目录。
- 当前构建未配置代码签名，首次运行可能触发 SmartScreen；请用 `SHA256SUMS.txt` 校验。

### 首次使用

1. 连接一个模型：设置 → 模型，填 API Key 或选择本地服务；也可以先在设置 → 订阅接入已有账号。
2. 选择一个工作文件夹；Morrow 只在这个文件夹范围内读写。
3. 在输入框描述结果，按 Enter 发送。需要审批的动作会显示审批卡。
4. 需要精确编辑或预览时，使用右侧画布；需要命令时打开底部终端。

## 文档地图

| 文档 | 适合谁 | 内容 |
|---|---|---|
| [用户指南](docs/USER-GUIDE.md) | 所有用户 | 从安装、首次启动到日常任务的完整操作手册 |
| [功能参考](docs/FEATURES.md) | 所有用户 | 功能清单、入口、限制与状态 |
| [模型与思考档位](docs/MODELS.md) | 配置模型的人 | 内置模型、上下文、思考档位、Qoder 账号目录、同步规则 |
| [订阅接入](docs/SUBSCRIPTIONS.md) | 使用官方账号的人 | 10 个 Agent 渠道与第三方 plan 的登录、代理、额度和边界 |
| [多媒体与本地模型](docs/MEDIA-MODELS.md) | 做图片/视频的人 | 引擎、模型目录、生成/编辑/审看、ffmpeg 与显存 |
| [架构说明](docs/ARCHITECTURE.md) | 开发者 | 进程、IPC、Agent 循环、权限、持久化、Provider、测试 |
| [设计系统](docs/DESIGN-SYSTEM.md) | 设计与前端 | 色彩、字体、间距、圆角、组件与可访问性 |
| [安全与隐私](docs/SECURITY-PRIVACY.md) | 谨慎的用户/审计者 | 数据位置、密钥、权限、网络与已知边界 |
| [排障指南](docs/TROUBLESHOOTING.md) | 遇到问题的人 | 启动、模型、订阅、媒体、终端、数据恢复 |
| [评测规范](docs/EVALUATION.md) | 想复现质量的人 | 单测、E2E、Agent 质量指标与真实任务 |
| [验收记录](docs/verification/VERIFICATION.md) | 发布/验收 | 当前版本的门禁、证据、交付哈希与边界 |
| [贡献指南](CONTRIBUTING.md) | 贡献者 | 开发环境、边界、提交规范 |
| [安全策略](SECURITY.md) | 安全研究者 | 漏洞报告与支持范围 |

指南截图集中在 [`docs/guide/screens/`](docs/guide/screens/manifest.json)；截图由 E2E 在真实 Electron 窗口中生成，记录在 manifest 中。

## 架构一览

```text
┌──────────────────────────── renderer (React 19) ────────────────────────────┐
│ TitleBar · Sidebar · Transcript · Composer · Canvas · Workbench · Island    │
│ Zustand store ── window.morrow 白名单 API ── preload（contextIsolation）     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ IPC / feature:*
┌───────────────────────────────────▼─────────────────────────────────────────┐
│ main (Electron)                                                             │
│ AgentService ─ core/agent ─ providers（OpenAI 兼容 / Anthropic / demo）      │
│ tools（文件/命令/终端/搜索/技能/MCP/浏览器/媒体） · permissions · snapshots  │
│ session/settings/secrets/projects/memory/skills/schedules · 订阅代理        │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                  工作区文件 / 本机引擎 / 模型 API / 本机数据目录
```

更细的进程边界、事件流、数据格式和重要不变量见 [架构说明](docs/ARCHITECTURE.md)。

## 项目规模

> 统计口径：`wc -l`；代码包含 `src/`、`tests/`（含 E2E）、`scripts/`、`build/`；文档为根目录与 `docs/` 下的 Markdown；不含 `node_modules`、构建产物、JSON 清单与图片。

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 314 | 125,812 |
| 测试 `tests/`（含 E2E） | 66 | 43,456 |
| 其中 E2E 套组 `tests/e2e/` | 20 | 19,236 |
| 构建脚本 `scripts/` + `build/` | 11 | 2,896 |
| **代码合计** | **391** | **172,164** |
| Markdown 文档 | 15 | 2,142 |

## 测试与质量

```powershell
npm run typecheck     # 主进程 + 渲染层
npm run audit:ui      # 设计 token / 裸排版值审计
npm run test:unit     # Vitest
npm run test:e2e      # Playwright（完整套件约 11 分钟）
```

当前基线：单元 **14 个套件 / 952 个用例**（944 passed + 8 skipped）；E2E **17 个套件 / 209 个用例**。打包版冒烟与真实账号登录、媒体链路、订阅代理另有专项用例。Agent 质量评测定义与结果见 [评测规范](docs/EVALUATION.md)。

## 开发与打包

```powershell
npm run build          # 类型检查 + electron-vite build
npm run dist           # 单文件便携版
npm run dist:all       # 便携版 + 安装包
npm run pack:source    # 从当前提交生成源码包
```

打包脚本会把 Electron 缓存、临时解包目录与交付暂存放到可清理目录；交付目录保留五个分发文件、源码包和用户数据 `Morrow Data`。详细约定见 [贡献指南](CONTRIBUTING.md)。

## 安全与隐私

- 默认不把工作区内容上传到 Morrow 服务器；模型请求直接发往你选择的模型服务。
- API Key 与订阅凭据使用系统加密保存；渲染层只看到“已保存”状态。
- 文件路径必须落在已登记工作区内；外部 URL 只允许 http(s)；网页、MCP 与浏览器内容按不可信数据处理。
- 不内置第三方 OAuth secret；Antigravity 需要 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。
- 详细威胁模型与已知边界见 [安全与隐私](docs/SECURITY-PRIVACY.md)。

## 已知限制

- Windows 10/11 x64 是唯一正式交付平台；WSL 需系统已安装发行版。
- 便携版/安装包未签名，SmartScreen 可能提示。
- 终端默认 Git Bash；在受限令牌/低完整性环境中 Git Bash 的 MSYS 共享内存可能不可用，可在设置里切 PowerShell 7。
- 真实本地模型、ffmpeg、ComfyUI 与视频生成依赖本机硬件和模型是否就绪；未配置时会如实报错，不会伪造结果。
- 订阅渠道的服务端接口可能变化；Morrow 会在登录/额度/模型目录失败时明确提示。

## License

MIT。见 [LICENSE](LICENSE)。
