# Changelog · 版本记录

Morrow 的版本按发布线记录。每节先给完整中文，再给完整英文；两段内容对应，但不逐句对照。

## v0.2.0

发布：2026-10-27（GitHub Release）。2026-11-12 修复 issue 后重新打包并替换发布资产；随后的文档重构仅改文档，未再次打包。

### 中文

这一版把 Morrow 从“能干的 Agent”扩展成“能交付作品的工坊”：新增创作台、云端多媒体与成员协作，并把模型与订阅的控制权交回使用者。

**变更概览**：新增 3 项 · 优化 3 项 · 修复 4 项

**新增**

- **创作台**：中短篇、长篇与漫剧三条链路，从一句话生成蓝图，经大纲、分镜、画面、声音、时间线、检查到交付；没有模型或引擎时明确失败。
- **云端多媒体与“模型 / 本地”分栏**：设置中接入 17 个国内与海外图片、视频、配音、配乐服务；本地模型与 ComfyUI、FFmpeg、TTS 集中到“本地”页。
- **成员协作**：主代理按需派发成员，支持独立工作副本、成果版本、独立验收、重试、并发上限与卡住提醒；进度直接显示在主对话的成员卡片里。

**优化**

- **模型与订阅控制**：每个模型可选上下文档位与最大输出，支持思考档位、OpenAI / Anthropic 协议切换与重试策略；能按模型目录识别图片输入能力。
- **界面可读性**：字号下限统一到 11px，输入框、文本域与下拉改为微圆角与内嵌焦点环；移除并排对话，协作并入工作模式。
- **稳定性改进（含修复）**：修复任务栏空白图标、8.3 短路径误判与大工作区副本上限误拦；断流、空回合与空闲超时不再静默停止。

**修复**

- 危险命令识别先归一化再匹配：PowerShell 别名、编码命令、续行、cmd 删除开关等九类绕过写法现在都会被拦截。
- 只读档改为按功能域登记读动作，未登记的动作默认拒绝；文件、Git、终端、媒体与创作台的写操作返回 `READ_ONLY` 且无副作用。
- 窄窗口下协作者面板不再遮挡正文，查找与替换按钮恢复可点。
- “全部替换”按编辑器真实文档重算区间，避免虚拟化渲染窗口造成的错误测量。

**重要说明**

- 两个 exe 均未签名，首次运行可能触发 SmartScreen；请先用 `SHA256SUMS.txt` 校验。
- ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg、ACE-Step、TTS 与订阅账号由用户环境决定，缺失时相关动作会明确失败。
- 只读档读取的是全局设置；会话级 `permissionMode` 与全局设置的统一、Git 面板按钮置灰仍是后续项。
- 本版文档体系于 2026-11-12 重构，仅文档变更；当日修复轮已重新打包并替换资产，本次文档重构未再次打包。

### English

This release turns Morrow from a capable agent into a workshop that ships work: a Studio, cloud media and member collaboration, with model and subscription control back in your hands.

**Summary**: Added 3 · Improved 3 · Fixed 4

**Added**

- **Studio**: short story, novel and comic-film pipelines from a one-line premise through blueprint, outline, storyboard, frames, voice, timeline, review and delivery. It fails explicitly when no model or engine is available.
- **Cloud media and a model/local split**: seventeen domestic and overseas image, video, voice and music services in Settings, with local models, ComfyUI, FFmpeg and TTS grouped on a separate Local page.
- **Member collaboration**: the main agent dispatches members when work needs isolation, parallel copies or independent acceptance, with artifact versions, retries, concurrency limits and stuck alerts. Progress is shown in member cards inside the main conversation.

**Improved**

- **Model and subscription control**: per-model context tiers and maximum output, thinking levels, OpenAI/Anthropic protocol switching and retry policies; image-input capability is read from model catalogues.
- **Interface readability**: an 11px minimum type size, consistent micro-radius controls and inset focus rings, no side-by-side chat, and collaboration folded into work mode.
- **Stability fixes**: fixed the blank taskbar icon, 8.3 short-path misdetection and a false limit on large workspace copies; stream breaks, empty turns and idle timeouts no longer stop silently.

**Fixed**

- Dangerous-command detection now normalizes input before matching: PowerShell aliases, encoded commands, line continuations and cmd delete switches are covered, closing nine bypass paths.
- Read-only mode registers read actions per feature domain and rejects anything unregistered; file, Git, terminal, media and Studio writes return `READ_ONLY` without side effects.
- The collaborator panel no longer covers content in narrow windows, and find/replace buttons are clickable again.
- Replace-all now recomputes ranges from the real editor document instead of the virtualized render window.

**Important Notes**

- Both executables are unsigned and may trigger SmartScreen on first run; verify them with `SHA256SUMS.txt` first.
- ComfyUI, llama.cpp, Ollama, LM Studio, FFmpeg, ACE-Step, TTS and subscription accounts come from your environment; missing pieces fail with an explanation.
- Read-only mode reads the global setting. Unifying session `permissionMode` with the global setting and disabling Git panel buttons are still follow-ups.
- The documentation set was rebuilt on 2026-11-12; that change touched documentation only, after the fix round had already rebuilt and replaced the release assets.

## v0.1.0

发布：2026-10-24（GitHub Release；2026-11-05 清理死代码与空行后重发，功能不变）。

### 中文

首个公开版本：把对话、计划、文件编辑、画布、终端、Git、浏览器、模型订阅与本机多媒体放进同一个 Windows 工作区。所有新增条目按用户可感知的能力归并。

**变更概览**：新增 11 项 · 优化 0 项 · 修复 0 项

**新增**

- 五种工作方式：聊天（只读）、工作、计划、深度研究、长期目标；计划与研究在动手前等待批准，目标模式按同一套权限规则跨轮推进。
- 只读、询问、完全访问三档权限，审批卡写明工具、目标、影响与风险；危险命令、越界路径与外部副作用逐次确认。
- 工作区文件树、CodeMirror 多标签编辑器、成品画布（HTML/Markdown/SVG/图片/PDF/Office/音视频预览）、版本历史与导出。
- 每个用户轮次的检查点与写前快照，可回退代码、对话或两者，文件冲突时拒绝覆盖。
- 真实 PTY 终端（默认 Git Bash，可选 PowerShell 7 / WSL）、后台任务、Git 工作台与多标签内置浏览器。
- 11 个模型族的 API 预设、自定义 OpenAI 兼容端点、本机 llama.cpp / Ollama / LM Studio；模型能力按运行时元数据展示，思考档位与上下文档位只列出模型真实支持的选项。
- 10 个官方 Agent 订阅渠道与第三方 coding plan，凭据本机加密，请求经回环代理转发。
- 本机多媒体：ComfyUI / llama.cpp / Ollama / LM Studio 的图片与视频生成、短片、动画、剪辑与检查；`describe_media` 优先当前对话模型，只回退到声明视觉能力的模型。
- 项目、记忆中心、技能库（18 个内置技能）、MCP 连接器、自定义命令、自定义角色、钩子与定时任务。
- `/btw` 侧聊不写主会话；`/swarm` 把独立任务分给 1–10 个集群成员，成员与主代理共用工作区与权限规则。
- 打包版本地崩溃日志与渲染进程自动恢复；订阅凭据、审批日志与数据目录均可在设置中查看或管理。

**重要说明**

- 本版仅交付 Windows 10/11 x64；便携版与安装包均未签名，首次运行可能触发 SmartScreen，请用 Release 附带的 `SHA256SUMS.txt` 校验。
- 便携版首次运行会在 exe 同级解压运行时缓存，之后启动更快；运行中不要删除该缓存或 `Morrow Data`。
- 本机只用 Qoder 与 Codex 真实账号验证过订阅链路，其余渠道只验证登录页、协议与端点，不提供虚构额度。
- 本机多媒体依赖用户自己的引擎、显卡与 ffmpeg；缺失时返回真实错误。Antigravity 登录需要自行提供 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。
- 2026-11-05 的重发包只清理死代码与空行，功能与文件结构不变；发布资产已替换，旧哈希作废。
- 源码包内的文档是打包时快照；源码包哈希以同名 `.sha256` 侧车为准。

### English

The first public release: conversation, planning, file editing, an artifact canvas, a terminal, Git, a browser, model subscriptions, and local media engines in one Windows workspace. Items below are grouped by what a user can do.

**Summary**: Added 11 · Improved 0 · Fixed 0

**Added**

- Five work modes — chat (read-only), work, plan, deep research, and long-running goals — where plan and research runs wait for approval before acting, and goals advance under the same permission rules.
- Read-only, ask, and full-access permission tiers with approval cards naming the tool, target, impact, and risk; dangerous commands, out-of-workspace paths, and external side effects are confirmed per call.
- A workspace file tree, a multi-tab CodeMirror editor, an artifact canvas for HTML, Markdown, SVG, images, PDF, Office files, audio, and video, plus version history and export.
- A checkpoint per user turn and a snapshot before every write, with rewind for code, conversation, or both and conflict-safe restore that refuses to overwrite changed files.
- A real PTY terminal (Git Bash by default, PowerShell 7 and WSL available), background tasks, a Git workbench, and a multi-tab built-in browser.
- API presets for 11 model families, any OpenAI-compatible endpoint, and local llama.cpp, Ollama, and LM Studio servers; capabilities come from runtime metadata, so thinking effort and context tiers only show what the model declares.
- Ten official agent subscription channels and third-party coding plans, with credentials encrypted locally and requests forwarded through a loopback proxy.
- Local media through ComfyUI, llama.cpp, Ollama, and LM Studio: image and video generation, short films, animations, editing, and inspection, with `describe_media` preferring the current chat model and falling back only to a model that declares vision.
- Projects, a memory center, a skill library with 18 built-in skills, MCP connectors, custom commands, custom agent roles, hooks, and scheduled tasks.
- `/btw` side chats that never write to the main session, and `/swarm` runs that split independent work across 1–10 members sharing the main agent's workspace and permission rules.
- Local crash logging and renderer auto-recovery in packaged builds, plus in-app access to subscription credentials, the approval log, and the data directory.

**Important Notes**

- This release targets Windows 10/11 x64 only. The portable and installed executables are unsigned, so SmartScreen may warn on first launch; verify the download against the `SHA256SUMS.txt` attached to the Release.
- The portable build unpacks a runtime cache next to the executable on first launch and starts faster afterwards. Do not delete that cache or `Morrow Data` while the app is running.
- Only Qoder and Codex were verified with real accounts on the build machine. Other channels were checked at the login page, protocol, and endpoint level, and no quota numbers are invented.
- Local media requires your own engines, GPU, and ffmpeg, and reports a real error when they are missing. Antigravity login requires you to supply `MORROW_ANTIGRAVITY_CLIENT_SECRET`.
- The 2026-11-05 repack only removed dead code and blank lines; behavior and file structure are unchanged, the release assets were replaced, and old hashes are obsolete.
- Documentation inside the source archive is a snapshot taken at packaging time; the archive hash is the sidecar `.sha256` file next to it.
