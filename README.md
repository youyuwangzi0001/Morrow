# Morrow · 明日工坊

> 住在你电脑里的 AI 工作伙伴。说清想要的结果，Morrow 会读文件、写代码、运行命令、检查成品，并把结果放回你的工作区。

Morrow 是一个面向 Windows 10/11 x64 的本地桌面 AI Agent：Electron 44 + React 19 + TypeScript。它把对话、工作、计划、深度研究、长期目标、文件编辑、画布、真实终端、Git、内置浏览器、项目记忆、技能、MCP、定时任务、本机多媒体与**创作台**放进同一个应用。模型可以来自 API Key、官方 Agent 订阅，或本机 llama.cpp / Ollama / LM Studio；所有数据默认留在本机。

![Morrow 主界面](docs/guide/screens/02-chat-home-dark.png)

## 核心能力

### 创作台：从一句话到可交付作品

- **一个作品底座**：中短篇、长篇与漫剧共用同一份作品文件，保存蓝图、章节、分镜、素材、剪辑表、任务与交付物；随时退出再继续。
- **先看蓝图再生产**：故事主线、人物、结构、风格与预算一次说清；蓝图确认前不批量生成正文或画面。蓝图、大纲、正文、分镜与模型审稿都只走真实文本模型，未连接时明确报错，不用本地模板冒充。
- **三条完整链路**：小说从大纲、纸页、候选稿、事实连续性到成书；长篇按分卷与章节批次推进；漫剧从分镜、画面、声音、五轨时间线、检查到成片。
- **改编覆盖全部章节**：小说改编漫剧读取全部非空章节；超过 12 章自动分批调用模型生成分镜，不再只取前 12 章。
- **协作者按当前步骤改**：在蓝图、大纲、写作、分镜、声音、时间线、检查、交付页直接说人话。协作者会带上当前页面与选中项，先给出可审阅的修改计划；确认后才写回，并能整体撤销。
- **重排与替换是一等动作**：章节顺序、镜头顺序、局部大纲、人物/地点局部修改、单镜或全片配音、声线、音效、配乐、画面与视频都能按真实意图落到对应步骤；受影响的画面、配音、时间线、检查与交付会标记过期。
- **三套大师方法已内嵌**：写作、编剧、导演三套提示词以压缩资源编译进主进程，按形态/任务/当前页面只选一套；不再读取桌面文件夹、`resources/prompts` 或旧的内嵌手法库。
- **候选不覆盖手改**：用户改过的章节只接受手动采纳，模型候选不会自动写回；每章保留最近 30 个版本。
- **精简 Office 写作台**：撤销/重做、查找与替换（Ctrl+F / Ctrl+H）、字号/行距/页宽、字数统计与导出 Word，排版只改视图不改正文。
- **回收站**：删除的作品先进入创作台设置 → 回收站，可恢复到作品库或彻底删除。
- **本机引擎**：Qwen-Image 2.1 Turbo、MiniMax 图生视频、Windows 本机语音 / Qwen3-TTS 与 ffmpeg；未就绪时明确失败，不伪造结果。
- **数据可自定义**：创作台作品目录可在设置 → 数据与安全单独更换并迁移，Agent 对话与设置不移动。

![创作台](docs/guide/screens/13-studio-home-dark.png)

![协作者修改计划](docs/guide/screens/18-studio-assistant-dark.png)

### Agent：从一句话到可验收的成品

- **聊天 / 工作 / 计划 / 深度研究 / 长期目标**五种工作方式。聊天模式只读；工作模式可以写文件和执行命令；计划模式先给出可审阅的计划；研究模式会查证并保留来源；目标模式可以跨轮持续推进，直到交付可验证的结果。
- **审批卡**把“它想做什么、会影响什么”写清楚。只读、询问、完全访问三档权限；询问档下危险命令、越界路径与外部副作用动作逐次确认，完全访问档直接执行。
- **代码与成品**：文件树、CodeMirror 编辑器、多标签画布、HTML/Markdown/PDF/Office/图片/音视频预览、版本历史、导出与另存为。
- **可恢复**：每个用户轮次有检查点，写文件前有快照；支持会话回退、文件回退和冲突校验。

### 真实终端、Git 与浏览器

- **真实 PTY 终端**：多标签、后台任务、复制粘贴、拖动调高。默认终端是 **Git Bash**；系统里其他权限级别的 Git Bash 占用 MSYS 共享内存时，会自动启用独立兼容运行环境，仍保持 Git Bash（优先硬链接，无权限时复制约 400MB）；也可选择 PowerShell 7 / WSL。
- **Git 工作台**：变更、diff、暂存、提交、分支、历史、放弃改动；diff 超长时截断展示。
- **内置浏览器**：多标签、地址栏、前进后退、真实网页内容；登录窗口与普通浏览共用同一套安全边界。

![终端与主界面](docs/guide/screens/10-terminal-dark.png)

### 模型、订阅与账号元信息

- 内置 OpenAI 兼容（DeepSeek、Kimi、Qwen、GLM、MiniMax、MiMo、Gemini、Grok、Meta Muse 等）、Anthropic 原生，以及 Ollama / llama.cpp / LM Studio 本机服务；也支持任意 OpenAI 兼容网关。
- **官方 Agent 订阅**：ChatGPT/Codex、Qoder、Kimi Code、GLM Coding Plan、MiniMax Code、Step Plan、Command Code、Cline Pass、Google Antigravity、OpenCode，以及第三方 coding plan。
- **Qoder 账号驱动目录**：登录后读取账号接口返回的模型、上下文档位与真实思考档位；Morrow 不维护 Qoder 静态模型表。
- **模型能力契约**：选择器只显示原始模型名；思考强度只列模型真实支持的档位；不支持时显示“不支持思考”；未知模型只保留“自动”。
- **本机多媒体**：ComfyUI、llama.cpp、Ollama、LM Studio；图片/视频生成、编辑、抽帧、拼接、审看。媒体审看始终优先当前对话模型，当前模型不支持或失败后才回退到声明视觉能力的本地模型。

![模型设置](docs/guide/screens/05-settings-models-dark.png)

### 项目、记忆与自动化

- **项目主页**：项目背景、说明与资料、项目内会话、当前文件夹范围。
- **记忆中心**：项目记忆、全局长期记忆、任务经验、注入预览与自进化建议。
- **技能库**：内置技能与工作区 `.morrow/skills`；支持 Markdown 技能包与安全安装。
- **MCP**：stdio / Streamable HTTP / 旧版 SSE；工具、资源、提示词、OAuth 与工作区信任。
- **定时任务**：一次/每天/每周，只读或可改文件；无人值守时自动拒绝需要审批的动作。
- **集群与侧聊**：1–10 个集群成员并行处理独立子任务；`/btw` 侧聊不写主会话。
- **灵动岛与 Token Activity**：桌面常驻进度、最近对话与快捷入口；每日/每周/累计 token 热力图。

![记忆中心](docs/guide/screens/11-memory-center-dark.png)

### 本地优先与稳定性

- 数据、会话、快照、日志与密钥都在本机；密钥用系统加密（Windows DPAPI / safeStorage）保存，渲染层永远拿不到明文。
- 打包版启用本地崩溃转储；主进程未捕获异常、未处理 Promise、子进程消失与渲染进程崩溃都会记录；主窗口渲染进程崩溃会自动恢复（有频率上限），并记录无响应事件。
- 应用不内置 Antigravity OAuth secret；使用 Antigravity 订阅时需自行设置 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。

![审批卡](docs/guide/screens/03-permission-card-dark.png)

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
npm run preview
```

### 使用发布包

本轮交付只提供两个单文件产物：

- `Morrow-0.2.0-portable.exe`：单文件便携版。首次运行会在 exe 同级解压 `.morrow-runtime-0.2.0-<修订>`，之后启动更快；运行中不要删除该目录。
- `Morrow-0.2.0-setup.exe`：NSIS 安装包，按提示选择安装目录，创建开始菜单/桌面快捷方式。

便携版数据默认在 exe 同级的 `Morrow Data`；安装版默认在 `%APPDATA%\Morrow`。可在「设置 → 关于」更改数据目录。当前构建未配置代码签名，首次运行可能触发 SmartScreen；请以验收记录中的 SHA-256 为准。交付目录不再包含文件夹版、zip 或源码包。

### 首次使用

1. 连接一个模型：设置 → 模型，填 API Key 或选择本地服务；也可以先在设置 → 订阅接入已有账号。
2. 选择一个工作文件夹；Morrow 只在这个文件夹范围内读写。
3. 在输入框描述结果，按 Enter 发送。需要审批的动作会显示审批卡。
4. 需要精确编辑或预览时，使用右侧画布；需要命令时打开底部终端。

## 文档地图

| 文档 | 适合谁 | 内容 |
|---|---|---|
| [用户指南](docs/USER-GUIDE.md) | 所有用户 | 从安装、首次启动到日常任务的操作手册、排障与功能速查 |
| [创作台](docs/STUDIO.md) | 写作/漫剧创作者 | 一句话到成书/成片的完整工作流、协作者与工具边界 |
| [创作能力对照](docs/STUDIO-TASKS.md) | 产品/验收 | 56 项能力卡、真实链路、剩余缺口 |
| [底层提示词与质检](docs/QUALITY-FRAMEWORK.md) | 产品/研发 | 三套大师方法的内嵌、路由、预算、协作者契约与本地检查 |
| [模型、订阅与多媒体](docs/MODELS.md) | 配置模型/账号/媒体的人 | 内置模型、上下文与思考档位、官方订阅、本机媒体引擎 |
| [架构说明](docs/ARCHITECTURE.md) | 开发者 | 进程、IPC、Agent 循环、权限、持久化、Provider、测试 |
| [测试说明](docs/TESTING.md) | 开发/测试 | 唯一核心套组、功能覆盖矩阵、精简记录与实测结果 |
| [设计系统](docs/DESIGN-SYSTEM.md) | 设计与前端 | 色彩、字体、间距、圆角、组件与可访问性 |
| [安全与隐私](docs/SECURITY-PRIVACY.md) | 谨慎的用户/审计者 | 数据位置、密钥、权限、网络与已知边界 |
| [验收记录](docs/verification/VERIFICATION.md) | 发布/验收 | 质量方法、门禁结果、证据、交付哈希与边界 |
| [贡献指南](CONTRIBUTING.md) | 贡献者 | 开发环境、边界、提交规范 |
| [安全策略](SECURITY.md) | 安全研究者 | 漏洞报告与支持范围 |

指南截图集中在 [`docs/guide/screens/`](docs/guide/screens/manifest.json)（40+ 张，含创作台指引、演示、蓝图、大纲、协作者计划、漫剧画布、人物语气与真实波形）。

## 架构一览

```text
┌──────────────────────────── renderer (React 19) ────────────────────────────┐
│ TitleBar · Sidebar · Transcript · Composer · Canvas · Workbench · Island    │
│ Zustand store ── window.morrow 白名单 API ── preload（contextIsolation）     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ IPC / feature:*
┌───────────────────────────────────▼─────────────────────────────────────────┐
│ main (Electron)                                                             │
│ AgentService ─ core/agent ─ providers（OpenAI 兼容 / Anthropic / 本机）      │
│ tools（文件/命令/终端/搜索/技能/MCP/浏览器/媒体） · permissions · snapshots  │
│ StudioService/Store · creative-masters（内嵌三套大师） · media · exports     │
│ session/settings/secrets/projects/memory/skills/schedules · 订阅代理        │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                  工作区文件 / 本机引擎 / 模型 API / 本机数据目录
```

更细的进程边界、事件流、数据格式和重要不变量见 [架构说明](docs/ARCHITECTURE.md)。

## 项目规模

> 统计口径：`wc -l`；代码包含 `src/`（TS/TSX/CSS/HTML）、`tests/`（含夹具与 E2E）、`scripts/`；文档为根目录与 `docs/` 下的 Markdown；不含 `node_modules`、构建产物、JSON 清单与图片。

| 范围 | 行数（约） |
|---|---:|
| 生产源码 `src/` | 167,480 |
| 测试 `tests/`（含 E2E 与夹具） | 21,500 |
| 构建脚本 `scripts/` | 3,436 |

## 测试与质量

```powershell
npm run typecheck     # 主进程 + 渲染层
npm run audit:ui      # 设计 token / 裸排版值审计
npm run test:unit     # 日常核心单元测试
npm run test:e2e      # 核心界面流程；自动重新构建
npm run verify       # 类型、UI 规则、覆盖清单与核心回归
npm run smoke:packaged # 打包后验证实际交付物启动与渲染
```

仓库仅保留 **38 个功能域的核心套组：366 项单元测试 + 46 条 Electron 集成流程**。所有现存用例直接运行，无需标题筛选；其余套组及专用夹具已删除。覆盖矩阵、执行结果与维护规则见 [测试说明](docs/TESTING.md)，交付与打包证据见 [验收记录](docs/verification/VERIFICATION.md)。r056 已通过 [最终验收并获准内测](docs/MORROW-BETA-ACCEPTANCE-2026-10-30.md)。

## 开发与打包

```powershell
npm run build          # 类型检查 + electron-vite build
npm run dist           # 单文件便携版
npm run dist:final     # 最终交付：只保留便携 exe + 安装包 exe
npm run dist:all       # 内部构建检查：文件夹版 + zip + 便携 + 安装包
```

最终交付目录只保留 `Morrow-0.2.0-portable.exe` 与 `Morrow-0.2.0-setup.exe`。文件夹版、zip、源码包和旧的运行时缓存都属于中间产物，不进入交付目录；若构建机宿主占用了旧缓存，`deliver-clean/` 是干净的双文件副本。详细约定见 [贡献指南](CONTRIBUTING.md)。

## 安全与隐私

- 默认不把工作区内容上传到 Morrow 服务器；模型请求直接发往你选择的模型服务。
- API Key 与订阅凭据使用系统加密保存；渲染层只看到“已保存”状态。
- 文件路径必须落在已登记工作区内；外部 URL 只允许 http(s)；网页、MCP 与浏览器内容按不可信数据处理。
- 不内置第三方 OAuth secret；Antigravity 需要 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。
- 详细威胁模型与已知边界见 [安全与隐私](docs/SECURITY-PRIVACY.md)。

## 已知限制

- Windows 10/11 x64 是唯一正式交付平台；WSL 需系统已安装发行版。
- 便携版/安装包未签名，SmartScreen 可能提示。
- 终端默认 Git Bash；受限令牌/低完整性环境会先为 Git Bash 启用独立兼容运行环境（同一份系统 Git；硬链接优先，无权限时复制约 400MB），仍不可用时才回退 PowerShell 7。
- 真实本地模型、ffmpeg、ComfyUI 与视频生成依赖本机硬件和模型是否就绪；未配置时会如实报错，不会伪造结果。
- 创作台配音可使用 Qwen3-TTS 本机声线或云端 TTS；受限令牌/无语音环境会失败，可改用“导入配音”。
- 订阅渠道的服务端接口可能变化；Morrow 会在登录/额度/模型目录失败时明确提示，不伪造已连通或额度。

## License

MIT。见 [LICENSE](LICENSE)。
