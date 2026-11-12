<p align="center"><img src="docs/cover.png" alt="Morrow 0.1.0 封面：深色主界面，包含会话侧栏、欢迎语与右侧成品画布" width="100%"></p>

<h1 align="center">Morrow</h1>
<p align="center">住在 Windows 电脑里的本地 AI 工作伙伴：读你的文件、执行命令，把结果放回你选择的文件夹。</p>
<p align="center"><a href="README.md">English</a></p>

<p align="center">
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-44.9-47848F?style=flat-square&amp;logo=electron&amp;logoColor=white" alt="Electron 44.9"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&amp;logo=react&amp;logoColor=black" alt="React 19"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5.9"></a>
  <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/Windows-10%2F11%20x64-0078D6?style=flat-square&amp;logo=windows&amp;logoColor=white" alt="Windows 10 与 11 x64"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=flat-square" alt="MIT 许可证"></a>
  <a href="https://github.com/youyuwangzi0001/Morrow/releases"><img src="https://img.shields.io/badge/Release-v0.1.0-C8AE7D?style=flat-square" alt="v0.1.0 版本"></a>
</p>

## 简介

Morrow 是一个 Windows 桌面应用，把 AI Agent 放进你自己的文件夹。你说清想要的结果，Morrow 读取相关文件、给出计划、在风险动作前询问你、执行工作，并把成品留在工作区。对话、代码编辑器、成品画布、真实终端、Git、内置浏览器、项目记忆、技能、MCP 连接器与本机多媒体引擎在同一个窗口里，而不是分散在十几个标签页。

它面向在本地文件上工作的人：写作与改稿、数据分析、前端与脚本、报告与文档、图片与视频生成。模型可以来自 API Key、已有的官方 Agent 订阅，或本机的 llama.cpp / Ollama / LM Studio 服务。会话、快照、日志、记忆与凭据都留在本机，API Key 通过 Electron `safeStorage` 交由 Windows DPAPI 加密保存。

## 核心能力

### 说清结果，再逐项审阅

- 五种工作方式：聊天（只读）、工作、计划（`/plan`）、深度研究（`/research`）、长期目标（`/goal`）。计划与研究在动手前等待批准；长期目标按同一套权限规则跨轮推进。
- 只读、询问、完全访问三档权限，审批卡写明工具、目标、影响与风险。危险命令、越界路径和外部副作用逐次确认，不能获得永久“始终允许”。
- 每个用户轮次生成检查点，写文件前自动快照。可以回退代码、对话或两者；文件冲突时拒绝覆盖，而不是悄悄写入。
- 运行中可排队下一条消息、立即插话或停止；`/btw` 侧聊不写入主会话，`/swarm` 把独立任务分给 1–10 个集群成员，成员与主代理共用同一套工作区规则。

### 文件、终端、Git 与浏览器在同一个工作区

- 工作区文件树、支持多标签的 CodeMirror 编辑器（保存、查找、版本历史），以及可预览 HTML、Markdown、SVG、图片、PDF、Office、音频和视频的成品画布。
- 真实 PTY 终端，支持多标签与后台任务；默认 Shell 是 Git Bash，可切换 PowerShell 7 与 WSL。Git 工作台覆盖 diff、暂存、提交、分支、历史与放弃改动。
- 多标签内置浏览器，用来检查刚做好的页面。网页、MCP 资源与搜索结果一律按不可信数据处理，不能当作 Agent 指令。
- 项目保存背景、资料、会话与文件夹范围；记忆中心管理项目记忆、全局长期记忆与任务经验，并提供注入预览。技能、MCP、钩子、自定义命令、自定义角色与定时任务扩展同一个 Agent，但不扩大它的权限。

### 模型、订阅与本机多媒体引擎

- 内置 DeepSeek、Kimi、Qwen、GLM、MiniMax、MiMo、Anthropic Claude、OpenAI、Gemini、Grok、Meta Muse 预设，也支持任意 OpenAI 兼容端点与本机 llama.cpp / Ollama / LM Studio。
- 官方 Agent 订阅覆盖 ChatGPT/Codex、Qoder、Kimi Code、GLM Coding Plan、MiniMax Code、Step Plan、Command Code、Cline Pass、Google Antigravity、OpenCode，以及第三方 coding plan。凭据加密保存在本机，请求经过回环代理。
- 模型能力是运行时元数据：选择器显示真实模型名，思考档位只列出模型声明的级别，上下文档位（例如 Qoder 的 200K / 400K / 1M）可按会话选择。

<p align="center"><img src="docs/guide/screens/06-subscriptions-dark.png" alt="设置 · 订阅：ChatGPT / Codex 账号连接选项" width="100%"></p>
- 通过 ComfyUI、llama.cpp、Ollama、LM Studio 使用本机多媒体：图片与视频生成、短片、动画、基于 ffmpeg 的剪辑与检查，以及 `describe_media` 审看；审看优先当前对话模型，只回退到声明视觉能力的模型。

## 安装

Morrow 0.1.0 以两个 Windows x64 可执行文件和一份源码包发布，见 [Releases](https://github.com/youyuwangzi0001/Morrow/releases) 页面。

| 文件 | 适用场景 |
|---|---|
| `Morrow-0.1.0-portable.exe` | 想要单文件、不安装。首次启动在 exe 同级解压运行时；数据默认放在同级的 `Morrow Data`。 |
| `Morrow-0.1.0-setup.exe` | 想要开始菜单与桌面快捷方式、按当前用户安装。数据默认在 `%APPDATA%\Morrow`。 |
| `Morrow-0.1.0-source.zip` | 想阅读或构建这一版的完整源码。 |

<p align="center"><img src="docs/guide/screens/01-onboarding-dark.png" alt="首次启动引导：认识 Morrow、连接模型、选择文件夹，以及离线演示入口" width="100%"></p>

可执行文件未做代码签名，首次运行可能触发 Windows SmartScreen：核对下载后选择 **更多信息 → 仍要运行**。请与 Release 附带的 `SHA256SUMS.txt` 比对文件哈希：

```powershell
Get-FileHash .\Morrow-0.1.0-portable.exe -Algorithm SHA256
```

从源码运行需要 Windows 10/11 x64 与 Node.js 22 或更新版本：

```powershell
npm install
npm run dev
```

构建并运行生产包：

```powershell
npm run build
npm run preview
```

## 使用方式

1. 打开 **设置 → 模型**，为内置服务商填入 API Key、启用本机服务，或在 **设置 → 订阅** 中连接订阅账号。
2. 选择一个工作文件夹。文件工具、终端、媒体输入与输出都留在这个文件夹内。
3. 在输入框描述想要的结果并按 Enter。需要计划、研究报告或长任务时先切换对应模式。
4. 出现审批卡与文件 diff 时逐项审阅。完成的成品在画布中打开，命令在终端面板执行。

<p align="center"><img src="docs/guide/screens/02-chat-home-dark.png" alt="主界面：会话侧栏、模式与权限控件，以及底部输入框" width="100%"></p>

包括三步首次启动引导在内的完整流程见 [快速开始](docs/GETTING-STARTED.md)。

## 配置

设置共 15 个分页：模型、订阅、多媒体、联网搜索、上下文、回答、用量、归档、权限、自动化、功能与工具、终端、外观、快捷键、关于。数据目录可在 **关于** 中查看或迁移：便携版数据在 exe 同级，安装版在 `%APPDATA%\Morrow`。

只有特定场景才需要环境变量：`MORROW_ANTIGRAVITY_CLIENT_SECRET` 用于启用 Antigravity 登录（应用不内置 OAuth secret），`MORROW_MCP_CONFIG` 指定 MCP 配置文件。数据位置、全部支持的环境变量、快捷键与内置技能清单见 [参考手册](docs/REFERENCE.md)。

## 项目结构

```text
src/main/      Electron 主进程、服务、IPC、订阅、终端、媒体
src/core/      Agent 循环、工具、权限、Provider、上下文管理
src/preload/   白名单 contextBridge API，暴露为 window.morrow
src/renderer/  React 19 界面与 Zustand store
src/shared/    共享类型、模型目录、命令与协议常量
docs/          用户、参考、架构、开发与验收文档
scripts/       构建、打包、截图与审计脚本
tests/         Vitest 单元套件与 Playwright Electron 套件
```

## 版本发布

已发布的构建与资产校验值在 [Releases](https://github.com/youyuwangzi0001/Morrow/releases) 页面。每个版本面向用户的变化记录在 [CHANGELOG.md](CHANGELOG.md)，本构建的交付证据见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 安全

- Morrow 没有接收工作区内容的服务器。请求直接发往你配置的模型服务或本机引擎。
- API Key 与订阅 token 使用系统凭据存储加密，从不下发渲染层；日志与工具输出会脱敏。
- 文件、终端与媒体路径必须落在已登记工作区内；外部 URL 只允许 `http(s)`；内置浏览器与 MCP 内容不能发出 Agent 指令。
- 危险命令与外部副作用逐次确认。无人值守的定时任务直接拒绝审批，不会无限挂起。
- 可执行文件未签名，Antigravity 需要你自己的 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 已知限制

- 唯一正式交付目标是 Windows 10/11 x64。WSL 需要系统已安装发行版。
- 便携版与安装包都没有代码签名；在核对 SHA-256 之前，SmartScreen 可能提示。
- 受限令牌或低完整性环境下 Git Bash 可能启动失败。可在 **设置 → 终端** 把默认 Shell 换成 PowerShell 7。
- 本机多媒体生成需要正在运行的 ComfyUI / llama.cpp / Ollama / LM Studio、合适的显卡，以及 `PATH` 中或已配置的 ffmpeg。引擎缺失时 Morrow 返回真实错误，不会编造结果。
- 订阅端点由各厂商控制，可能变化；Morrow 会显示真实的登录或额度错误，而不是假装已连接。本机仅用 Qoder 与 Codex 真实账号做过验证。

## 许可证

MIT。见 [LICENSE](LICENSE)。