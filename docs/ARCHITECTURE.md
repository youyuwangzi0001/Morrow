# 架构说明

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页描述 Morrow 0.1.0 的实际实现：进程怎么分工、一次对话如何变成工具调用、数据写到哪里、哪些边界不能越过。它面向要改代码的人，不重复用户操作步骤；环境与打包见 [开发指南](DEVELOPMENT.md)。

## 目录

- [进程模型](#进程模型)
- [启动与窗口生命周期](#启动与窗口生命周期)
- [IPC 与运行时事件](#ipc-与运行时事件)
- [Agent 循环](#agent-循环)
- [模式与工具注册](#模式与工具注册)
- [权限模型](#权限模型)
- [上下文、压缩与恢复](#上下文压缩与恢复)
- [Provider 层](#provider-层)
- [持久化](#持久化)
- [订阅与回环代理](#订阅与回环代理)
- [终端、Git、浏览器与媒体](#终端git浏览器与媒体)
- [安全边界](#安全边界)

## 进程模型

```text
┌─────────────────────────────── main (Electron) ───────────────────────────────┐
│ index.ts        启动、单实例、窗口/桌面伙伴/托盘、安全策略、崩溃处理           │
│ ipc.ts          基础 IPC（chat/session/settings/window/archive）              │
│ feature-ipc.ts  feature:* 白名单注册与 Result 包装                            │
│ services/       AgentService、订阅代理、终端、Git、媒体、记忆、项目、MCP…     │
│ core/           Agent 循环、工具、权限、上下文、Provider                      │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ contextBridge / ipcRenderer.invoke
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ preload（contextIsolation + sandbox）                                         │
│ 只暴露 window.morrow 白名单；所有 invoke 返回 Result<T>，不暴露 ipcRenderer   │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ renderer（React 19 + Zustand）                                                │
│ TitleBar · Sidebar · Transcript · Composer · Canvas · Workbench · Settings    │
└───────────────────────────────────────────────────────────────────────────────┘
```

主窗口与桌面伙伴窗口都启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，禁用 `<webview>`。渲染层不能直接读文件、执行命令或访问密钥。

## 启动与窗口生命周期

1. 解析数据目录：`--data-dir` → `%LOCALAPPDATA%\Morrow\data-location.json` → `portable.marker` → `PORTABLE_EXECUTABLE_DIR` → `%APPDATA%\Morrow`。
2. 在单实例锁之前执行 `app.setPath('userData', dataDir)`，否则多个便携副本会互相顶掉。
3. 获取单实例锁；第二个实例只唤醒已有主窗。
4. 注册 `morrow-file` 与 `morrow-artifact` 私有协议。
5. `whenReady` 后依次初始化安全策略、协议处理器、空菜单、基础 IPC、feature 模块、订阅恢复、Token 账本、主窗、桌面伙伴、托盘、定时任务与全局快捷键。
6. 打包版启动本地 crashReporter；主进程安装未捕获异常、未处理 Promise 与子进程消失日志。

- 主窗默认按 2100×1200 物理像素换算 DIP，最小约 1200×760。
- 关闭动作由 `settings.closeAction` 决定：每次询问、最小化到任务栏、完全退出。
- `window-all-closed` 不退出进程；托盘与桌面伙伴仍可运行后台任务。
- 退出时清理终端、Agent、订阅代理、定时任务与托盘；4 秒未完成强制 `app.exit(0)`。
- 主窗口渲染进程崩溃后 800ms 自动 reload，60 秒内最多两次；无响应事件写入日志。

## IPC 与运行时事件

- 基础 IPC 覆盖 chat/send、会话 CRUD、设置、窗口、数据目录与归档。
- feature IPC 只挂载已注册的精确 `feature:*` 频道，返回值统一为 `{ ok: true, data }` 或 `{ ok: false, error }`，避免 Electron 原始异常泄漏。
- 渲染层通过 preload 的 `window.morrow` 调用，没有裸 `ipcRenderer`。
- Agent 运行产生 `RuntimeEvent`（started / delta / tool / permission / usage / compaction / notice / finished 等），带 `seq`、`runId`、`sessionId` 与时间戳；主进程先脱敏、持久化、登记检查点、更新桌面伙伴，再广播 `morrow:event`。
- 设置变更只广播给主窗；网页、浏览器与 MCP 内容按不可信数据处理，不作为系统指令。

## Agent 循环

一次 `chat:send` 的主路径：

1. 执行 `user_prompt_submit` 钩子（返回码 2 可阻断发送）。
2. 检查同会话互斥；已有运行则拒绝或排队。
3. 创建本轮检查点与快照目录。
4. 解析 Provider、Model、Key、权限与上下文覆盖。
5. 写入用户消息与自动标题（首条可见消息截 26 字，仅在标题仍是默认值时）。
6. `runAgent`：构建 system prompt、历史与工具列表；流式调用 Provider；聚合文本、思考与工具调用；执行工具；回填 `tool_result`；循环到完成、步数、预算或中止。
7. 每次工具调用前做权限判断；审批与提问按 run 串行。
8. 运行结束持久化消息、usage、todo、artifact、goal/plan/research；执行 `run_finished` 钩子与队列、目标、研究后续。
9. 清理临时状态；迟到事件不覆盖新运行。

## 模式与工具注册

| 模式 | 行为 |
|---|---|
| `chat` | 只读工具集合加 `ask_user` / `web_search`；内核拒绝写、命令、记忆与集群 |
| `work` | 默认；完整工具 |
| `plan` | 仅工作模式；固定只读加 `submit_plan`；最多 2 步；批准后转执行 |
| `research` | 固定只读权限 `auto`，带研究白名单；计划阶段不暴露工具；检索轮以隐藏消息续跑 |
| `goal` | 仅工作模式；2–256 轮；预算含工具调用、有效时间与连续无进展；完成需证据文件；全局同时一个目标 |
| `temporary` | 不写项目记忆、不持久化；不提供回退与成品版本 |
| `demo` | 一次性演示工作区，跳过审批但真实执行工具，约 35–50 秒 |

工具按固定顺序注册：文件、PDF/DOCX/XLSX/PPTX、搜索、命令、技能、元工具、联网、终端、MCP、浏览器、computer-use、多媒体。`submit_plan` 与 `update_goal` 按模式注入。

- 主代理工具调用串行执行；单个工具异常转成 `ToolResult`，不会炸掉整轮。
- 连续 4 次完全相同的工具调用判为死循环。
- 工具结果、参数与 MCP 配置都有大小上限；文件、终端与媒体路径必须在工作区内。

## 权限模型

实现位于 `src/core/permissions.ts`，持久化在 `src/main/services/permission-rules.ts`。

| 档位 | 工作区内普通写与命令 | 危险命令 | 越界路径 | 外部副作用 |
|---|---|---|---|---|
| 只读 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 询问 | 放行 | 询问 | 询问 | 询问 |
| 完全访问 | 放行 | 询问 | 询问 | 询问 |

- “始终允许”按工具 + 目标 + 参数哈希形成会话 grant，并落为工作区 allow 规则。
- deny 规则优先；allow 不能越过危险、越界与外部动作限制。
- 危险命令、越界路径与终端 stdin 始终逐次确认，不提供“始终允许”。
- 审批日志在 `permissions/approval-log.jsonl`，规则在 `permissions.json`。
- 无人值守运行与定时任务自动拒绝审批和提问，不会挂起。

## 上下文、压缩与恢复

- 自动压缩默认阈值 0.8、保留最近 8 条；可配 0.5–0.98 与 2–50。
- 只在完整消息边界切分；保留首条用户锚点与当前请求；有未回填的 `tool_use` 时拒绝压缩。
- 优先模型摘要；失败退本地摘要；仍超目标再 `aggressiveTrim`。
- 上下文溢出最多强制压缩重试 2 次。手动 `/compact` 需要空闲、至少 4 条消息、90 秒超时，并在压缩前后校验消息签名。
- 每轮检查点最多 100 个，回退范围分 code / conversation / both。命令副作用不可通用追踪。
- 写文件前快照记录 before/after 哈希；恢复前校验会话根、清单哈希与当前文件哈希，冲突拒绝。

## Provider 层

| 类型 | 协议 |
|---|---|
| `demo` | 离线剧本，真实执行工具 |
| `anthropic` | Anthropic Messages，system 顶层，`tool_use` / `tool_result` 块 |
| 其他 | OpenAI 兼容 Chat Completions，`/chat/completions` + SSE + `stream_options.include_usage` |

- 真实 Provider 外包 `ToolProtocolProvider`：剔除正文中的文本工具协议，缺失结构化 `tool_calls` 时解析为工具事件，未知工具忽略并提示。
- OpenAI 兼容层按 index 拼接 `tool_calls`，把 `reasoning_content` / `reasoning` 转为 `thinking_delta`，透传 `reasoning_effort`。
- DeepSeek 直接 Provider 的 `off` 映射为 `none`；Qoder 代理保持 `off`。Anthropic 的档位映射为 `thinking.budget_tokens` 并强制 `temperature=1`。
- 图片消息使用 content 数组加 `image_url` data URL。
- 408 / 409 / 425 / 429 / 5xx 与网络错误可重试，最多 3 次，退避 800 / 2000 / 5000ms；只有尚未产出内容时重试，abort 立即停止。

## 持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| 会话 | `sessions/<id>.json` | 整份 JSON，临时文件 + rename；临时会话仅内存；列表最多 300 |
| 设置 | `settings.json` | 脱敏配置；内置 Provider 每次启动与代码预设合并 |
| 密钥 | `secrets.json` | safeStorage 加密；加密不可用时拒绝保存；旧 `b64:` 只读兼容 |
| 项目 | `projects/projects.json` | 背景、资料、会话与范围 |
| 记忆 | 工作区 `.morrow/memories.json` / `memories/global.json` | 项目与全局长期记忆 |
| 任务经验 | `.morrow/episodes.json` / `episodes/global.json` | 任务复盘 |
| 成品版本 | `artifact-versions/<session>/<artifact>/` | 最多 30 版、单版 8MB |
| 技能 | `skills/` / 工作区 `.morrow/skills` | 用户与工作区技能 |
| MCP | `mcp.json` / 工作区 `.morrow/mcp.json` | 工作区需 `mcp-trust.json` |
| 定时任务 | `schedules/tasks.json` | 最多 50 |
| Token 账 | `usage/token-activity.json` | 日账 |
| 日志 | `logs/main.log` | 主进程 JSON 行日志 |

数据目录解析与工作区目录结构见 [参考手册](REFERENCE.md#数据目录)。

## 订阅与回环代理

订阅服务位于 `src/main/services/*-subscription.ts`，协议在 `*-protocol.ts`，共同结构是：

```text
登录/导入 → 凭据加密落盘 → 账号/额度校验 → 模型目录 → 本地回环代理 → Provider
```

- 回环代理只绑 `127.0.0.1` 的随机端口，要求随机本地 Bearer；上游 token 不进入渲染层。
- 401/403 只刷新一次后重试；刷新先落盘再使用。
- 官方接口变化时返回真实错误，不假装已连接。
- 各渠道的模型目录、额度接口与限制见 [模型与订阅](MODELS.md#订阅渠道)。

## 终端、Git、浏览器与媒体

- `TerminalManager` 使用 node-pty / ConPTY；默认 Git Bash，可选 PowerShell 7 与 WSL；Windows PowerShell 5.1 与 CMD 已移除（CMD 仅在没有其他 Shell 时兼容回退）。
- `git-service` 封装工作区仓库操作：拒绝越界路径与父仓库根操作，diff 超长时截断。
- `BrowserService` 管理多标签与原生视图；普通页面与登录 session 分离，导航白名单、下载、权限与错误页各有独立处理。
- `MediaService` 与 `media-catalog` 管理引擎、模型、下载与启动；ffmpeg 由系统或设置提供，产物写入工作区 `media/`。

## 安全边界

- 文件 IPC 必须 realpath 后位于最近工作区或会话工作区。
- 外部 URL 仅允许 `http(s)`；`window.open` 拒绝；`<webview>` 禁止。
- 打包版启用 CSP；画布 HTML 走独立 `morrow-artifact` 协议与独立 CSP。
- 密钥永不下发渲染层；日志脱敏；输出守卫遮蔽邮箱、用户名与 token。
- 网页、MCP 与浏览器内容不可信，不执行页面指令。
- Antigravity 不内置 OAuth secret，需要 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。
- 未签名构建可能触发 SmartScreen；交付校验以 `SHA256SUMS.txt` 为准。

构建、测试与打包入口见 [开发指南](DEVELOPMENT.md)；本版实测结果与边界见 [交付验证](VERIFICATION.md)。