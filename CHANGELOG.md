# 版本记录 / Changelog

本文件记录面向用户的版本变化。每节先给出完整中文段，再给出完整英文段。

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