# Morrow 架构说明

> 与 `PLAN.md` 配套。所有跨模块契约以 `src/shared/` 为准，本文件描述意图，代码是最终事实。

## 1. 进程模型

```
┌─────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                        │
│  app lifecycle / BrowserWindow / menu / dialogs / safeStorage        │
│  ┌────────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │ AgentService       │  │ SessionStore     │  │ SettingsStore    │ │
│  │ (core AgentRuntime)│  │ JSONL + meta     │  │ safeStorage key  │ │
│  └─────────┬──────────┘  └──────────────────┘  └──────────────────┘ │
│            │ emits RuntimeEvent (ordered, per runId)                 │
│  ┌─────────┴──────────────────────────────────────────────────────┐  │
│  │ ipc.ts : invoke handlers + event push (webContents.send)       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ contextBridge (narrow)
┌───────────────────────────────┴─────────────────────────────────────┐
│ Preload: window.morrow = { invoke, onEvent, platform, versions }     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────┴─────────────────────────────────────┐
│ Renderer (React 19 + Zustand + Vite)                                │
│  state/  ← events → reducer/store                                    │
│  features/shell · composer · chat · activity · artifacts · settings  │
└─────────────────────────────────────────────────────────────────────┘
```

为什么 Agent 跑在主进程：需要无限制文件/进程能力、崩溃隔离、窗口关闭时的生命周期管理；渲染层只做展示，避免 Node 注入面。

## 2. 目录

```
src/
  shared/
    types.ts        # 会话/消息/工具/设置/模型等全部领域类型
    ipc.ts          # 通道名常量 + 请求/响应类型 + RuntimeEvent 联合类型
    models.ts       # 模型预设（上下文窗口、能力、UI 名称）
  core/             # 纯 TS，无 electron/react 依赖
    providers/      # openai-compat.ts, anthropic.ts, demo.ts, types.ts, sse.ts
    agent.ts        # AgentRuntime：循环、事件、中断、压缩
    tools/          # 各工具实现 + registry + 参数校验 + 结果截断
    permissions.ts  # 权限模式/规则/工作区边界
    context.ts      # token 估算、历史裁剪、压缩摘要
    prompt.ts       # 系统提示词（含工具说明与行为规范）
    session.ts      # 会话数据结构与序列化（纯函数）
  main/
    index.ts        # app 生命周期、窗口、菜单、协议、安全
    ipc.ts          # IPC 注册与事件转发
    services/agent-service.ts   # run 管理、审批挂起、事件缓冲
    services/session-store.ts   # 磁盘持久化
    services/settings-store.ts  # 加密 key、主题等
    services/workspace.ts       # 工作区选择、最近目录
    tray.ts / menu.ts
  preload/index.ts
  renderer/
    index.html
    src/main.tsx, App.tsx
    src/styles/tokens.css, base.css, fonts.css
    src/ui/          # 基础组件（Button/Input/Modal/Select/Toast/ScrollArea…）
    src/state/       # zustand store + selectors + ipc bridge
    src/features/…   # shell / composer / chat / activity / artifacts / settings / onboarding / palette / demo
```

## 3. 领域模型（要点）

- `Message`：`{ id, role: 'user'|'assistant'|'tool'|'system', content: ContentBlock[], createdAt, meta }`
  - `ContentBlock`：`text` | `thinking` | `tool_use { id,name,input,status }` | `tool_result { toolUseId, ok, content, meta }`
  - 图片输入存放在 `ChatMessage.images`（多模态 image content）；用户消息用 `displayText` + `attachments` 元数据渲染气泡，附件正文只进入模型上下文
  - 附件由渲染层读取/归一化：文本按 UTF-8 → UTF-16 BOM → GB18030 解码；BMP 与超过 5MB 的图片在本地转成 PNG/JPEG，最长边 1568px，避免上游视觉接口拒绝；主进程再次钳制 8 个附件、单文件 120k 字符，并限制单条消息全部文本合计 80k 字符、全部图片合计 20MB；普通 file 附件只传元数据，正文必须走带审批的文件工具。剪贴板/拖入拿不到真实路径时不再伪造文件名作为路径，同名同尺寸的不同剪贴板图片按附件 id 区分。只发附件不写字也能发送。`@相对路径` 为工作区文件引用，模型需先 `read_file` 再回答
- `Run`：一次用户输入触发的 Agent 执行；状态 `running | waiting_permission | waiting_user | done | cancelled | error`。
- `RuntimeEvent`（有序，带 runId/seq）：
  - `run_started` / `run_finished`
  - `message_started {messageId, role}` / `message_delta {textDelta, thinkingDelta}` / `message_completed {message}`
  - `tool_started {toolUseId,name,input}` / `tool_progress` / `tool_finished {result}`
  - `permission_requested {requestId, toolName, summary, risk, options}` / `permission_resolved`
  - `question_asked {requestId, question, options}` / `question_answered`
  - `todos_updated {todos}` / `usage_updated {usage}` / `session_updated {meta}`
  - `plan_updated {plan, planMode}`（计划模式提交/批准/拒绝/完成后同步）
  - `queue_updated {queue}`（运行中排队消息增删改/自动发送）
  - `compaction {phase: 'started'|'finished', savedTokens?}` / `messages_replaced {messages}`（自动压缩结束同步历史）
  - `artifact_created {id,title,kind,path}`
  - `error {code, message, retryable}`
- `Session`：`{id,title,workspace,model,createdAt,updatedAt,messages[],todos[],artifacts[],usage,permissionMode,mode?,planMode?,plan?,pinned?,archived?}`。
  运行中的消息与 `todos` 会增量落盘：切换会话或崩溃恢复时，计划不会退回上一轮的旧状态；`PlanTray` 只在运行中脉冲，停止后保留金色「未完成」标记但不再闪动。
- `SessionPlan`：`{id,title,summary,steps[],risks?,status:'pending'|'executing'|'completed'|'rejected',feedback?,artifactId?}`。计划模式只读探索后由 `submit_plan` 提交，用户批准后自动切执行并按步骤建立 todos；所有步骤完成才落为 completed。
- `TurnCheckpoint`：每轮用户消息创建，记录消息位置、todos/artifactIds/plan 快照与 `CheckpointFile[]`（写前快照、before/after hash、是否新建）。回退时按目标轮及之后检查点的最早写前状态恢复文件，并用最后 afterHash 检测外部修改冲突。
- 消息操作：`regenerate` 删除最后一条用户消息之后的内容并重放该消息；`editResend` 用新文本替换目标用户消息并截断其后全部内容，保留原消息里的附件/图片块（只替换用户输入前缀）；`deleteAfter` 保留目标消息、删除其后内容；`branch` 复制到目标消息为止的历史到新会话（原会话不变，不复制 goal/plan/planMode/固定/归档）。运行或压缩期间不能执行这些操作（含跨会话运行检查）；分支的 usage 从 0 开始，只保留 contextLimit，避免费用在分支间重复累计。删改后渲染层只在目标会话仍为当前会话时更新，避免异步返回覆盖用户刚切换的会话。截断结果统一以 `messages_replaced` 事件在 `run_started` 之前下发；渲染层不再按 IPC 返回值回写运行状态，避免极快的本地模型出现「已结束又被标记为运行中」。
- 会话目录：`<userData>/sessions/<id>.jsonl`（事件追加）+ `<id>.json`（元数据）。项目 = 工作区绝对路径，`<userData>/projects.json` 维护最近项目。

## 4. IPC 契约（`src/shared/ipc.ts`）

- `invoke`（渲染 → 主，均返回 `Result<T> = {ok:true,data}|{ok:false,error}`）：
  - `app.bootstrap` → `{settings, sessions, projects, demo, platform, versions}`
  - `chat.send {sessionId, text, attachments?}`、`chat.cancel {runId}`、`chat.retry {sessionId}`
  - `permission.respond {requestId, decision: 'once'|'always'|'deny'}`、`question.respond {requestId, answer}`
  - `session.create/list/load/rename/delete`、`session.setModel/setPermissionMode/setMode/setPinned/setArchived`
  - `session.branch {sessionId, messageId, title?}`、`session.export {sessionId, format: 'markdown'|'json'}`（原生保存对话框；序列化后超过 32MB 直接拒绝，写盘使用异步 `writeFile`，避免大 JSON 阻塞主进程）
  - `chat.regenerate {sessionId}`、`chat.editResend {sessionId, messageId, text}`、`chat.deleteAfter {sessionId, messageId}`
  - `plan.setMode/approve/revise/reject {sessionId}`（批准会自动启动执行运行）
  - `checkpoint.list/preview/rewind {sessionId, checkpointId, scope}`（scope: both/code/conversation）
  - `queue.list/add/update/remove {sessionId, queueId?, text, attachments?}`（运行中排队，主进程内存态）
  - `settings.get/update`、`settings.testProvider {providerConfig}`、`settings.saveKey`
  - `workspace.pick/validate/recent`、`workspace.createDemo`
  - `artifact.open {sessionId, artifactId}`、`artifact.revealInFolder`、`artifact.export`
  - `file.search {root, query}`（@ 引用）、`file.attach`
  - `app.openExternal`、`app.about`、`app.quit`
- `feature:<name>:<action>`（R10 窄通道，preload 统一暴露 `features.invoke`）：文件树/编辑器历史/浏览器/记忆/项目/MCP/技能/搜索/终端/Git/自定义命令；主进程只接受已注册的精确频道并返回 `Result`。
- `events`（主 → 渲染）：单一通道 `morrow:event`，载荷 `RuntimeEvent`；渲染层以 `runId` 分流。

## 5. Agent 循环（`core/agent.ts`）

```
run(userInput):
  append user message; emit run_started
  loop (no fixed max steps; only explicit caller caps):
    messages = compactIfNeeded(session.messages)
    stream = provider.stream({ system, messages, tools, signal })
    for event in stream:
      text_delta → emit message_delta
      tool_call_start/args_delta/end → accumulate
      usage → emit usage
    if no toolCalls:
      if open todos: inject hidden system check (max 2 rounds) and continue
      if visual intent + HTML/SVG artifact: inject one hidden visual-polish round and continue
      emit message_completed; break
    append assistant message(with tool calls)
    for call in toolCalls (sequential):
      gate = permissions.check(call, mode)
      if gate == ask: emit permission_requested; await respond (with timeout/cancel)
      emit tool_started; result = tools.execute(call, ctx); emit tool_finished
      append tool_result
  emit run_finished
```

- **收尾闭环**：模型直接给出最终答复时，若计划里仍有未完成 todo，内核先注入隐藏的系统检查（最多两轮），要求用 `todo_write` 同步真实状态；若用户明确要求「惊艳/高级感」等画面质量且本轮产出了 HTML/SVG 画布成品，再注入一次隐藏的视觉打磨轮，要求按 frontend-art-direction 真正修改构图与工艺。隐藏检查消息带 `hidden:true`，不进入可见对话，但会保留在上下文里供后续轮次参考。
- **中断**：AbortController 贯穿网络与工具；中断时补齐 assistant tool_use 与 tool_result（`[interrupted]`），保证下一轮消息合法。
- **重试**：429/5xx/网络错误指数退避（0.8s/2s/5s，最多 3 次），UI 显示「正在重试」而非报错死亡。200 响应内的限流/过载错误帧同样按可重试处理；SSE 按行解析，CRLF/LF/CR 混用与跨 chunk 切分都不会丢帧。
- **空流/断流**：200 但没有任何内容且无收尾标记（OpenAI `finish_reason`/`[DONE]`、Anthropic `message_stop`）视为可重试空流；已收到文本却中途断流时明确报错，不再把半截回答当完整回复；已收到工具调用时保留给 Agent 自修复。`finish_reason=length`/`stop_reason=max_tokens` 与内容拦截会给出可见警告。错误响应体最多读取 64KB。
- **压缩**：估算 token（CJK 1 char≈1 token，ASCII 4 chars≈1 token，历史图片每张按约 1100 tokens），超过 `contextLimit * threshold`（默认 80%）时把较早消息摘要为一条 `system/compact_summary`，保留最近 8 条、原始用户约束与所有工具配对完整性；摘要输入按模型窗口限长（`contextWindow × 0.35`，最多 24k 字符）。自动压缩返回**压缩后的完整历史**，主进程替换会话并同步 UI，重启后不会复活旧消息；摘要请求自身的 token 也计入用量。手动 `/compact` 同路径，但额外有 90s 超时、消息签名校验和摘要脱敏。
- **工具配对完整性**：裁剪只允许在 assistant(tool_use)+tool_result 完整交界处切割，绝不产生孤立 tool 消息（多数 API 会拒绝）。
- **推理强度与费用**：模型可声明 `reasoningStyle`；内置模型装载与模型同步都会为 `supportsReasoning` 的模型补齐风格——OpenAI 兼容（含 DeepSeek/Kimi/Qwen 等）映射 `reasoning_effort`，Anthropic 映射 `thinking.budget_tokens`，缺失风格时界面不会显示选择器。会话可覆盖推理强度；用量按会话累计，参考价格表估算 `costUsd`，无价格模型显示 —。
- **多会话后台运行**：普通运行按会话并行（目标循环仍全局串行）；渲染层按会话维护 `runs`，侧栏与输入区「运行中心」列出后台运行、等待确认与队列条数，并可切换/停止。关闭窗口默认隐藏到托盘，任务不中断；窗口不在前台时完成/失败/审批/提问发系统通知（审批/提问不受「完成时通知」开关影响，正文不包含命令、路径或问题原文），点击聚焦并切到对应会话。任务栏在运行期间显示不确定进度。
- **终端与后台任务**：`TerminalManager` 用 node-pty（Windows ConPTY）提供真实伪终端，自动检测 PowerShell 7、Windows PowerShell、命令提示符、Git Bash、WSL；默认 Shell 在「设置 → 终端」选择，终端界面不再放类型选择。该选择同时作用于终端面板、Agent 的 `run_command`、`terminal(run/start)` 与后台任务；系统提示会注入当前 Shell 及对应语法（PowerShell/cmd/POSIX），避免用户选了 cmd/Git Bash 后仍按 PowerShell 写命令。渲染层用 xterm 还原 ANSI/交互程序，支持标签页、尺寸同步、历史回放与明暗主题。终端停靠在主区域底部（左侧让出侧栏，默认 240px），顶栏按钮打开/隐藏，关闭面板后进程继续运行。后台任务仍用独立子进程（流式日志、stdin、停止/重启、400KB 环缓冲，最多 32 个进程）。Agent `terminal` 工具与面板共用管理器；cwd 必须位于已登记工作区。terminal 的 run/start 复用危险命令/越界检查，stdin 写入按高风险逐次确认。重启时旧进程事件不会覆盖新进程；一次性命令超时会返回已收集输出；应用退出时结束所有进程。
- **运行中排队**：同一会话运行中发送的消息进入主进程内存队列（最多 20 条，退出应用会丢失），`complete`/`max-steps` 后自动发送队首；取消/出错保留队列。用户可编辑/删除，或选择「打断并发送」先取消当前运行再立即发送；发送失败时保留队列条目并把内容放回输入框。自动发送前重新检查会话占用、压缩与全局目标占用，繁忙时保留队首并定时重试；等待取消期间切换会话时消息仍发回原会话。
- **检查点**：每轮 `startRun` 创建检查点；`tool_finished` 成功后按 `meta.absolutePath/afterHash/snapshotPath/created` 登记（子代理通过 `task`/`swarm` meta.changedFiles 批量上报，失败子任务的文件改动也登记）。回退服务在写文件前做路径/快照边界校验、快照 beforeHash 校验、当前哈希冲突校验，冲突整体拒绝；快照目录使用清洗后的 toolUseId，`.restore.json` 目标不会覆盖撤销清单。代码回退保留对话与目标检查点，对话回退同步恢复 todos/artifacts/plan 及 planMode；回退成功后刷新文件树。
- **计划模式**：`planMode=true` 时工具集切换为只读 + `ask_user`/`todo_write`/`submit_plan`，权限层固定 read-only，执行层再做一次白名单兜底（未暴露的 task/swarm/update_goal 等 meta 工具也会被拒绝）；模型只探索并提交计划，批准由主进程处理（切 work、重置 todos、启动执行运行）。只有每个计划步骤都有对应已完成 todo 才落为 completed；只读权限下批准会被明确拒绝并提示先切权限。计划待批准时 `run_finished` 仍走普通 complete，不写工作区。
- **子代理与集群（Agent Swarm）**：`task` 创建单个子 AgentRuntime，`swarm` 工具把 2–8 个独立子任务按角色并行派发（每批最多 8 个）；子代理共享 provider/tools 与主代理同权限链（排除嵌套 `task`/`swarm`、`update_goal` 与 `todo_write`），角色可进一步限制工具白名单与只读。写文件/命令/MCP 走同一权限链；「询问」档下危险/越界/外部动作审批，「完全访问」直接执行；审批/提问按会话串行呈现；子代理上下文过长时用本地摘要折叠早期步骤；工具 id 与主代理统一分配，避免快照目录冲突。UI 以嵌套活动条展示，进度前缀显示角色，显示任务名、子代理标签与步数。
- **演示模式**：`DemoProvider` 实现同一 `Provider` 接口，按剧本逐字流式输出（含工具调用参数），工具真实执行在复制后的 `demo-workspace/`；剧本中的数值由 `collectDemoMetrics()` 从真实 CSV 计算。**演示模式强制 auto 权限**（不弹审批，避免打断首次体验），时长可用 `MORROW_DEMO_SPEED` 调整。
- **手动压缩**：主进程 `chat:compact` 调用 core 的 `compactSession({force:true})`，把返回的 messages 写回会话并 emit `compaction` 事件，UI 的 `/compact` 即此路径。压缩期间该会话拒绝发送/建目标/切模式；结束时校验消息未变化，避免摘要覆盖新内容；摘要以折叠的系统标记展示，可展开查看。
- **撤销**：写/编辑工具把旧文件备份到 `<userData>/snapshots/<sessionId>/<toolUseId>/<basename>`，`ToolResult.meta` 带 `snapshotPath`；主进程 `file:restore-snapshot` 校验快照在工作区外不可写后还原文件，UI 的「撤销这次修改」即此路径。
- **自定义命令与钩子（P1-12）**：`send()` 在启动运行前顺序执行最多 5 个 `user_prompt_submit` 钩子，退出码 2 阻止发送并返回输出；工具结束与每轮结束分别触发 `post_tool_use` / `run_finished` 观察型钩子，不阻塞调度。钩子仅来自用户在设置中显式启用的命令，通过系统 shell 运行，15s 超时、16KB 输出上限，JSON 载荷经 stdin 传入。自定义命令从 `.morrow/commands/*.md` 发现，发送时展开模板。

## 6. 工具规范（v1）

| 工具 | 参数 | 安全 | 说明 |
|---|---|---|---|
| `read_file` | path, offset?, limit? | 工作区内；二进制检测；≤256KB | 返回带行号内容 |
| `write_file` | path, content | 需审批（询问/自动按模式） | 创建目录；快照旧内容用于撤销 |
| `edit_file` | path, old_string, new_string, replace_all? | 同上；必须唯一匹配 | 返回 diff 摘要 |
| `delete_file` | path | 同上；文件级删除，删除前备份 | 返回删除 diff 摘要；本轮新建后删除按净零处理 |
| `list_dir` | path, depth? | 只读 | 目录树，跳过 node_modules/.git |
| `glob` | pattern, path? | 只读 | 最多 200 条 |
| `grep` | pattern, path?, include?, ignore_case? | 只读 | JS 实现，跳过二进制/大文件，最多 100 命中 |
| `run_command` | command, cwd?, timeout_ms? | 只读拒绝；高危命令强审批；≤120s；输出≤32KB | Windows 用 PowerShell，其它 bash；sanitized env |
| `todo_write` | todos[] | 无 | 计划面板数据源 |
| `ask_user` | question, options? | 无 | 阻塞等待用户选择，超时/取消安全退出 |
| `remember` | text | 只读拒绝；其余模式按权限审批 | 写入 `<workspace>/.morrow/MEMORY.md`，下次运行注入系统提示 |
| `submit_plan` | title, summary, steps[], risks? | 仅计划模式 | 提交执行计划，登记 Markdown 产物并等待批准；不执行任何步骤 |
| `task` | description, prompt | 同主代理权限链 | 嵌套 Agent，排除嵌套 task、update_goal 与 todo_write；交互卡串行 |
| `open_artifact` | title, kind, path?/content? | 无 | 注册画布条目（HTML/MD/SVG/代码） |
| `web_search` | query, max_results? | 已配置搜索服务时暴露；结果不可信 | Tavily/Brave/Serper/SearXNG 搜索，默认条数取设置，meta.sources 分组进入来源面板；响应按字节流 2MB 上限；限流 10 次/分钟、缓存 5 分钟（键含 SearXNG 实例） |
| `terminal` | action, command?, id?, data? | 工作区内；exec 审批 | 真实 PTY 终端/后台任务的启动、日志、输入、调整尺寸、停止、重启；后台任务无 TTY |

工具结果统一包成：成功 `{ok:true, output, meta?}`；失败 `{ok:false, error, hint?}`，失败也会回灌给模型自修复。每个工具声明 `category: 'read'|'write'|'exec'|'meta'` 与 `titleFor(input)` 供 UI 展示。

## 7. 权限模型

- 模式：`read-only`（只读工具自动，写/执行直接拒绝并提示切换）｜`ask`（默认；读自动，写/执行询问）｜`auto`（工作区内自动，工作区外与高危命令仍询问）。计划模式内核固定使用 `read-only`，与提示词和工具白名单三重约束。
- 工作区边界：`realpath` 后必须位于工作区根内；工作区外访问触发「越界审批」，批准仅本次运行有效。
- 危险命令规则：破坏性删除、磁盘格式化、关机/重启、注册表写入、远程脚本执行（curl|iex）、`git push --force`、读取凭据目录等 → 拒绝或强询问（红色风险）。
- 审批请求按 `sessionId + signature` 记忆「本次会话总是允许」；「询问」档的工作区写入自动执行，「完全访问」不弹审批。工作区 deny 规则优先；allow 规则不越过危险命令、越界、外部动作与只读模式。
- 审批卡片必须展示：工具名、人类可读摘要、完整参数（可展开）、风险等级、影响路径。
- 项目规则文件：按 `.morrow/` → 工作区根 → 上级目录（最多 6 层）→ 用户目录的顺序发现 AGENTS.md / CLAUDE.md / MORROW.md，realpath 去重后按优先级注入系统提示，默认 3000 tokens、单文件 128KB / 24k 字符。项目与上级规则不允许通过符号链接逃逸作用域；二进制与超大文件跳过并记录日志；`feature:rules:list` 只读取已登记工作区。`/init` 仅在可写模式下可用，并会先列出已有规则文件要求在其上更新。

## 8. 持久化与安全

- `settings.json`：非敏感设置明文；API Key 单条 `safeStorage.encryptString` 后存 base64，按 provider id / `websearch:<provider>` 区分。系统加密不可用时**拒绝保存**，不做 base64/内存降级；历史 `b64:` 降级数据只读兼容并告警。设置与密钥文件原子写入（0600），Provider 配置在写入前校验（ID、协议、http(s) 地址、模型/请求头范围），删除 Provider 或模型同步导致默认模型失效时自动回退。
- 会话以 JSON 原子写（tmp + rename）持久化；写入失败不会破坏旧文件。
- 文件快照：写/编辑前把旧内容存 `<userData>/snapshots/<sessionId>/<toolUseId>/<basename>`，撤销时还原；本轮结束可「撤销全部文件改动」。
- 检查点：`<userData>/checkpoints/<sessionId>/<id>.json` 保存每轮检查点（最多 30 轮），引用上述写前快照，不重复复制文件；删除会话时一并清理。只跟踪写/编辑工具，`run_command` 的未登记副作用不在回退范围，若改到已登记文件会被哈希冲突拦截。
- 会话删除：先写墓碑阻止迟到回调/目标续跑写回，停止运行、审批、提问与目标循环并等待工具收尾（最多 5 秒），再删除会话 JSON 与 `<userData>/snapshots/<sessionId>`；工作区文件与编辑器文件历史不删除。
- 测试模式（`--test-mode`）：渲染层暴露 `window.__morrowStore`；provider 指向 `http://127.0.0.1:*` 时允许空 API Key（本地 Mock LLM 专用）；`--skip-onboarding` 可跳过首启引导用于截图/E2E。生产构建不改变行为。
- 路径与密钥不打印日志；日志只写 `<userData>/logs/main.log`，滚动 5MB×3。
- 渲染层：BrowserWindow 使用 `contextIsolation` + `nodeIntegration=false` + `sandbox=true`，preload 仅通过 contextBridge 暴露窄接口；核心 IPC 在 preload 统一归一化为 `Result`，主进程异常不会把 Electron 原始拒绝抛给 UI。生产 CSP 只允许 `self` / `data:` / `blob:` / `morrow-file:` / 本地回环，`connect-src` 不再放行任意 https，`object-src`/`base-uri` 关闭。主窗口只能停留在应用自身页面，任意 `file://` 与其他页面导航被拦截，外部 http(s) 交给系统浏览器。
- HTML 产物：不能再用 `srcDoc`（会继承主窗口 CSP、拦掉内联脚本），改为主进程登记内容并签发 `morrow-artifact://preview/<token>`；文档自带 CSP（允许内联脚本/样式与 https 资源，禁止嵌入/表单/本机服务），iframe 无 `allow-same-origin`，外链经 postMessage 交宿主用系统浏览器打开。预览 token 1 小时过期，单条上限 10MB、总量 64MB。
- 画布产物：HTML/Markdown/SVG/代码/文本内联渲染；图片、PDF、Office、音视频产物自动进入只读文件预览。文件读取按需只读前缀：HTML 8MB、其它文本 2MB，超出时显示截断提示。
- IPC 路径边界：产物读取/打开/另存与文件搜索只接受已登记工作区 realpath 内的文件/目录；搜索不跟随 junction/符号链接，避免枚举工作区外文件。会话创建/切换会校验权限模式、会话模式与模型是否仍可用。
- 文件预览：`feature:files:*` 的显式 workspace 也必须属于已登记工作区；主进程校验后签发 `morrow-file://preview/<token>`（6 小时过期，每次请求重新 realpath 校验，支持 Range）；CSP 仅放行该协议的 `img-src` / `media-src` / `connect-src`。PDF 用 PDF.js 逐页渲染，DOCX 用 Mammoth 转 HTML 后放进无脚本 sandbox iframe；XLSX 解析多工作表为表格，PPTX 提取幻灯片文本，RTF/ODT/ODS/ODP/EPUB 转安全 HTML，ZIP/JAR 列出目录；CSV/TSV 在编辑器内提供表格预览，SVG 提供图形预览。旧版 doc/xls/ppt 与 7z/RAR/TAR 等明确降级为系统应用打开。图片预览上限 50MB；转换输出有行列/条目/字节上限，文档 HTML 只输出转义文本；本地 HTML 预览禁用脚本与表单。

## 8.5 启动器、清单与签名（2026-10-22 更新）

- 本机/受限环境的 Chromium 渲染沙箱会在初始化阶段崩溃（0x80000003）：进程秒退、无窗口，
  连主进程 JS 都不会执行（不会创建数据目录、没有日志），因此无法在应用代码里兜底。
- 交付物通过**启动器**规避：默认交付的单文件 exe 是 C# 启动器，先解压内嵌 zip 到 exe 同级
  `.morrow-runtime-<ver>`，再启动 `Morrow-app.exe` 并自动追加 `--no-sandbox`；内部 `--all` 的文件夹版保留
  `Morrow.exe` 轻量启动器，逻辑相同。
- 启动器 Win32 清单：`build/launcher/MorrowLauncher.manifest` 通过 csc `/win32manifest:` 嵌入
  文件夹版和单文件版启动器，包含 `asInvoker`、Windows 7/8/8.1/10/11 supportedOS、
  `dpiAware=true/pm` + `PerMonitorV2`、`longPathAware`、Common-Controls v6。它解决 DPI、
  兼容性与 UAC 语义问题；**不改变** SmartScreen 的发布者/信誉判断。
- 安全边界不变：工具工作区沙箱、权限审批、危险命令拦截均在主进程/内核层，与 Chromium 沙箱无关；
  主应用渲染进程只加载本地内容；远程网页仅出现在独立的内置浏览器 WebContentsView（无 preload、无 Node）。
- 双击入口：正式路径是直接双击单文件 `Morrow-0.1.0-portable.exe`。未签名时首次运行可能被
  SmartScreen 拦截，需要「更多信息 → 仍要运行」；如果 exe 是下载来的，还可能先遇到
  MOTW「打开文件 - 安全警告」，右键 exe → 属性 → 解除锁定即可去掉。
- `启动 Morrow.cmd` / `创建桌面快捷方式.cmd` 是**可选**入口：用系统自带的 PowerShell 以
  `UseShellExecute=false` 启动，并同步解除本文件夹文件的下载标记，减少资源管理器的重复拦截。
  这只是启动方式，不是代码签名，安全软件仍可能拦截；不能把它描述成“消除警告”。
- 代码签名：`scripts/dist-portable.mjs` 支持 `MORROW_SIGN_PFX` + `MORROW_SIGN_PFX_PASSWORD`、
  `MORROW_SIGN_THUMBPRINT`、`MORROW_SIGN_SUBJECT`、`MORROW_SIGN_AUTO=1`；对 `Morrow-app.exe`、
  文件夹版 `Morrow.exe`、单文件 exe 依次做 SHA-256 + RFC3161 时间戳签名，并用 `signtool verify /pa`
  与 PowerShell `Get-AuthenticodeSignature` 双重校验，失败即打包失败。无证书时产物记录
  `signed:false` 与原因，不生成/安装自签名证书；签名状态写入 `docs/verification/packaging.json`。
- 单实例锁在 `app.setPath('userData', dataDir)` 之后申请：同一份数据目录只开一个窗口，不同便携副本互不抢占。
- 若未来在沙箱可用的机器上希望重新开启 Chromium 沙箱，可从单文件运行时直接运行 `Morrow-app.exe`（兼容入口保留）。

## 8.6 Git 工作台（P1-8）

- 窄 IPC：`feature:git:status/init/diff/stage/unstage/discard/commit/branches/checkout/create-branch/log/show`，渲染层复用 `window.morrow.features.invoke`；实现位于 `main/services/git-service.ts` + `main/features/git.ts`。
- 工作区边界：先经统一 `resolveWorkspaceDir` 校验登记目录；`git rev-parse --show-toplevel` 得到的仓库根必须仍在该工作区 realpath 内，否则拒绝（避免在「更大仓库的子目录」里误操作仓库外文件）。路径只接受仓库内相对路径，拒绝绝对路径、`..` 与 NUL，并统一使用 `--literal-pathspecs` + `--`。子进程环境会剔除继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_CEILING_DIRECTORIES` 等变量，防止外部环境把命令重定向到工作区之外的仓库；暂存/取消暂存只有完全省略 `path` 才代表「全部」，非法值直接报错。
- 只提供本地操作：状态、差异、暂存/取消暂存、放弃改动、提交、分支创建/切换、最近 80 条历史与提交详情；不提供 push/pull/凭据操作，界面明确提示用终端完成。子进程无 shell，带超时、8MB 输出上限；提交禁用 GPG 签名避免 pinentry 阻塞；提交信息 1–5000 字。
- Windows 兼容：`index.lock` 短暂占用会退避重试；安全软件阻止 git 子进程覆盖工作区文件时，主进程从索引经 smudge 过滤器取回内容写回并刷新 stat 缓存（符号链接/子模块直接报错），随后 `git status` 确认干净。
- UI：工作台「Git」卡片与 `/git` 命令；变更页左侧提交框 + 已暂存/更改分组，右侧 unified diff；历史页左侧提交列表、右侧详情与补丁。支持一键 init、分支菜单、ahead/behind、刷新与 15s 轮询（窗口可见且空闲时）。面板高度按视口收缩，页脚与操作区始终落在模态可视区内；切换分支会同时失效并重载历史，差异/提交详情用请求序号丢弃过期响应。删除工作区文件由「放弃改动」二次确认触发；渲染层不直接接触文件系统。
- 已知边界：合并提交默认不显示补丁；二进制文件只显示 Git 摘要；超大差异（>400KB）截断展示；子模块与符号链接的还原请使用终端。

## 8.7 自定义命令与运行钩子（P1-12）

- 自定义命令：扫描 `<workspace>/.morrow/commands/*.md` 与 `~/.morrow/commands/*.md`，文件名（小写）即命令名，项目覆盖同名用户命令。项目命令目录必须 realpath 落在工作区内，`.morrow` 链接到外部时整目录忽略。简单 frontmatter 支持 `description` / `argument-hint`；正文为提示词模板，发送时展开 `$ARGUMENTS` 与 `$1..$9`，无占位符时把参数附在末尾。只读取普通文件（跳过符号链接与非 `.md`），单文件 64KB、正文 16KB、最多 100 条；达到上限后项目命令仍可覆盖同名用户命令。渲染层通过 `feature:commands:list` 读取，斜杠菜单按需刷新；`new/demo/plan/settings/btw/swarm/goal/init/clear/rewind/export/export-json/usage/compact/git` 为内置保留名（`shared/commands.ts`），重名文件在设置页标为「重名」且不会进入菜单；未知 `/命令` 与「保留名 + 参数」只提示，不会当作普通消息发给模型。
- 钩子：仅来自 `Settings.hooks`（设置 → 自动化），不读取项目文件，避免打开陌生仓库即执行代码。用户显式启用后才运行，事件为 `user_prompt_submit`（发送前，退出码 2 阻止并显示输出，顺序执行，遇到退出码 2 立即停止后续发送前钩子）、`post_tool_use`（工具完成，带工具名/入参/结果摘要）、`run_finished`（每轮结束，带结束原因与最终文本）。每个事件最多 5 个启用钩子，设置保存时校验、执行时兜底截断，界面提示该上限。命令通过系统 shell 执行（`spawn(command, {shell:true})`），cwd 为当前工作区，JSON 载荷写入 stdin（≤200KB），环境变量 `MORROW_HOOK_EVENT`/`MORROW_WORKSPACE`；15s 超时、stdout/stderr 各 16KB 上限；Windows 超时通过 `taskkill /T /F` 结束整棵进程树，避免 shell 子进程残留。
- 失败处理：`user_prompt_submit` 只有退出码 2 阻止发送，崩溃/其它非零码记录后继续；`run_finished` 钩子失败以轻量通知提示；`post_tool_use` 失败只写日志，避免打断运行。设置保存时严格校验 id/事件/命令（最多 20 个、每事件最多 5 个启用），磁盘加载时宽松归一化。自动化页把命令读取错误与钩子保存错误分开显示；模态正文不产生第二层滚动条，仅右侧面板滚动。

## 8.8 MCP 资源、提示词与 OAuth（P1-14）

- 客户端能力：`initialize` 后记录 server 声明的 capabilities；`resources/list`、`resources/templates/list`、`resources/read`、`prompts/list`、`prompts/get` 已接入 stdio / Streamable HTTP / 旧版 SSE 三种传输。资源文本单条 8KB、二进制只保留 64KB base64 预览；提示词消息非文本块折叠为占位符。
- Agent 工具：新增 `mcp_resources`（list/read）与 `mcp_prompt`（list/get），均为 `exec` 外部动作——只读模式拒绝，ask/auto 逐次审批；返回内容标注为不可信数据，不构成授权。非法 action 直接报错，不静默退化为 list；提示词参数限制 64 个、键名 128 字符、值 4000 字符。连接器「测试连接」会同时列出工具/资源/模板/提示词数量与目录，可复制 URI 或提示词名，实际读取仍走对话审批。
- OAuth 2.0：为 HTTP/SSE 连接器提供授权码 + PKCE（S256）公共客户端流程。端点在连接器面板填写（authorizationUrl / tokenUrl / clientId / scopes），不做动态注册、不支持 client_secret；点击「开始授权」会先保存当前表单，再由主进程在 `127.0.0.1` 随机端口启动一次性回调，校验 state（5 分钟超时），换取 access/refresh token。重新授权会关闭同一连接器的旧回调服务并清除旧定时器，避免旧超时误删新流程。
- 令牌作用域：`createMcpConnection` 从配置来源（用户级 / 具体工作区）获得上下文，resolver 以「作用域 realpath + OAuth 端点与 Client ID 指纹」为键读取令牌；同名连接器在不同工作区、或 OAuth 端点变化后不会复用旧令牌。改名保留授权，删除连接器会同时删除对应令牌；旧版按名称保存的令牌作为过渡回退。后台每 60 秒检查一次，在过期前 5 分钟用 refresh_token 刷新；刷新失败只发事件/保留旧令牌，不打印令牌内容。面板区分正常、未授权、已过期（可自动刷新/需重新授权）状态。
- 安全：OAuth 端点与 MCP URL 同样经过协议与 SSRF 校验（本机/内网需显式 allowPrivateNetwork）；回调只监听回环地址并校验 state；错误页使用严格 CSP、无脚本；令牌与授权码不写日志。连接器 IPC 的 workspace 参数统一经 `resolveWorkspaceDir` 校验已登记工作区；`mcp.json` / `mcp-secrets.json` 解析失败时拒绝保存而不是按空配置覆盖；配置、密钥与令牌写入统一使用临时文件 + 重命名（Windows 占用时退避重试）。面板外层模态不滚动，配置路径/提示固定，左右两栏与编辑区内部滚动，底部操作条吸底。

## 8.9 子代理角色与集群（Agent Swarm，可选能力）

- 内置角色：`general`（全工具）、`explore`（只读检索）、`plan`（只读规划）、`review`（只读审查）、`test`（读 + 运行命令/终端）、`docs`（读 + 写 Markdown）。角色只做「工具白名单 + 专属系统提示 + 可选只读」；权限链、审批、工作区边界与父代理完全一致，只读角色即使父级 auto 也按只读执行。
- 自定义角色：`<workspace>/.morrow/agents/*.md` 与 `~/.morrow/agents/*.md`，frontmatter 支持 `title/description/tools/read-only`，正文为角色系统提示；项目覆盖同名用户角色，内置名保留不可覆盖。单文件 32KB、正文 8KB、最多 32 个自定义角色；只读普通文件。项目目录必须 realpath 落在工作区内（`.morrow` 链接到外部时整目录忽略）；达到上限后项目角色仍可覆盖同名用户角色。工具名统一小写去重；显式写 `tools:` 但为空/全部无效时保留空数组，表示不允许任何工具，而不是退化成全部工具；`read-only` 接受 true/yes/1。
- `task` 工具新增 `agent` 字段；`swarm` 工具接收 `{goal, tasks:[{title,prompt,agent?,context?}]}`，2–8 个任务并行分批执行（最多 8 个同时推进），返回每个子任务的摘要/步数/失败信息；任一子任务未完成时工具返回 `ok=false`（保留成功摘要），不计为全部完成。子代理工具集排除 `task/swarm/update_goal/todo_write`；`task` 的 context 限 4000 字符，角色名限 80 字符。
- 行动轨迹对 `swarm` 展示结构化的「任务拆分」列表（序号、标题、角色），不再以原始 JSON 为主视图；结果区仍显示每个子任务的状态与摘要，暗/亮主题均沿用黑金样式。
- 系统提示在工作模式列出可用角色与使用建议；聊天模式/计划模式不注入角色段，也不暴露 `task/swarm`。输入框 `/swarm 目标` 会生成拆解指令；`/swarm` 在聊天/计划/运行中禁用并说明原因。
- 设置 → 自动化展示内置与自定义角色（名字、说明、只读、来源），便于发现；UI 子代理进度以「角色 · 步骤」展示。

## 8.10 侧边聊天 /btw

- 入口：输入框旁「侧边聊天」按钮或 `/btw [问题]`；右侧固定抽屉，可在主对话运行时使用。
- 只读问答：主进程 `runSideChat` 直接使用当前会话选定的模型（模型被删除时明确报错，不静默回退到同提供方的第一个模型），`tools=[]`，不能改文件/跑命令/联网；默认把主对话最近 12 条文字（≤12k 字符）作为只读上下文附在系统提示中，可在抽屉里关闭「带上主对话」。侧边聊天自己的历史由渲染层保留（≤12 条、总额 12k 字符；关闭不清空，切换主对话时清空）。
- 不写入主对话：不创建消息/检查点、不进入会话 usage、不触发审批；仅通过 `feature:sidechat:ask/cancel` 与 `feature:sidechat:event` 流式返回（delta/notice/done/cancelled/error）。requestId 由渲染层在 invoke 前生成并保存，避免极快模型的 delta/done 早于 IPC 返回值；每个会话只允许一个进行中的侧边聊天，全局最多 8 个，新请求会取消同会话旧请求。
- 停止与异常：取消会中止 provider 流并返回 `cancelled`，保留已经生成的部分回答并标注「已停止」，不会误发 `done`；空回答视为错误；服务商的输出截断/内容拦截提示以 `notice` 显示。切换主对话时取消并清空，避免旧回答写入新会话。
- 边界：演示模型不支持侧边聊天（避免复用演示剧本）；不支持工具与附件；抽屉打开时通知栈移到抽屉左侧，避免遮挡停止/发送控件。

## 8.11 内置技能与技能提示词

- 首次启动由 `ensureBuiltinSkills(dataDir)` 把 13 个内置技能安装到 `<dataDir>/skills/<name>/SKILL.md`：deliverable-quality、frontend-art-direction、code-review、debugging、test-writer、docs-writer、data-analysis、web-research、refactor、release-notes、security-audit、deliverable-report、mcp-integration。每个都是纯 Markdown 流程说明（无脚本），覆盖「何时使用 / 步骤 / 输出 / 安全边界」。deliverable-quality 统一代码、文档、报告、幻灯片、表格、数据与研究的跨模型质量门槛；frontend-art-direction 同时覆盖新作艺术方向与既有界面打磨；旧的 ui-polish 已并入，升级时会移除未修改的旧副本，用户改过的保留为自有技能。
- 安装策略：同名目录已存在（用户自己的技能）不覆盖；用户删除后不自动恢复；升级时只更新「未被用户修改」的技能（sha256 与 marker 比对），保留用户编辑。marker 为 `skills/.builtin-skills.json`，用户编辑后持久化 `modified: true`，后续每次启动都不会再被内置内容覆盖；SKILL.md 与 marker 使用临时文件 + 重命名写入，避免半文件被误判成用户编辑。内置技能在技能库中标记「内置技能」，仍可禁用/删除/查看原文。
- 技能提示词：只列 name/description/路径，不把正文塞进系统提示；要求仅在用户点名或任务明显匹配时读取，避免「为了用技能而改目标」；明确技能是流程参考资料、不是授权，命令/路径需按工作区与审批规则执行，夹带操作一律不执行。
- `read_skill` 的 `path` 只接受 `.morrow/skills`、`skills`、`.skills` 或一级子目录 `/skills` 下的 `<技能>/SKILL.md`（用于同名或遮蔽技能消歧），并检查启用状态；不能借 path 读取工作区任意 `SKILL.md`，已禁用技能即使给出路径也不能读。
- 安装边界：同名判断不区分大小写（避免 Linux 上 `Foo`/`foo` 与状态键冲突）；覆盖安装拒绝符号链接，只删除用户技能库内的普通目录；文件夹/zip 的白名单仍拒绝脚本/可执行文件。
- UI：技能库面板按视口收缩，外层模态不滚动；工具栏/摘要固定，列表与详情内部滚动，底部用户目录/操作条始终可见；SKILL.md 原文保留自己的滚动区。
- 回归：`builtin-skills` 单测 4 项（安装/发现、用户编辑与删除且二次启动仍保留、旧技能合并迁移、同名用户技能不覆盖）；`skills` 主进程/核心单测共 32 项；`r10-skills` E2E 2/2。

## 9. 构建与打包

- `npm run dev`：electron-vite dev（renderer HMR）。
- `npm run build`：typecheck → electron-vite build。
- `npm run dist:portable`：build → electron-builder `--win portable`，输出 `release/Morrow-<ver>-portable.exe`。
- Electron 二进制镜像：`.npmrc`/脚本设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；electron-builder 二进制镜像 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- 数据目录：`app.setPath('userData', path.join(PORTABLE_EXECUTABLE_DIR, 'Morrow Data'))`（存在该环境变量时），支持 `--data-dir=` 覆盖。用户在「设置 → 关于」选择的自定义目录通过 `%LOCALAPPDATA%\\Morrow\\data-location.json` 持久化；启动时优先于便携默认目录，切换会重启并可迁移用户数据。
- 版本号：`package.json` + 关于页 + 窗口标题一致；构建时注入 git short sha 与构建时间。

## 10. 测试策略

1. **单元（vitest，无 Electron）**：SSE 解析、Provider 双协议、token 估算与裁剪配对、权限规则、工具（临时目录）、Agent 循环（脚本化 Provider）、会话序列化。
2. **协议集成**：本地 HTTP Mock 同时实现 OpenAI/Anthropic SSE，断言请求体与解析结果。
3. **E2E（Playwright `_electron.launch`）**：覆盖窗口/主题、演示全流程、权限审批与中断、会话恢复、快捷键与光标、编辑器与文件预览、记忆/项目/技能/连接器、内置浏览器、IPC 边界与全局搜索等旅程。真实渲染进程 + 真实主进程 + Mock LLM 双协议。
4. **真实冒烟**：`scripts/probe-live.mjs` 用本机 DeepSeek Key 跑 1 轮真实流式 + 1 次工具调用（结果只打印状态与耗时，不打印密钥）。
5. **打包冒烟**：启动便携 exe（Playwright electron 或窗口存活检查 + 截图），完成一次演示。
6. **截图基线**：`docs/verification/screens/` 归档明暗主题关键界面。

## 11. 性能预算

- 冷启动到可交互 < 1.5s（中端 Windows）；首条 token < 1.5s（网络决定，UI 立即出现）。
- 流式渲染 60fps：增量文本按 16ms 合并；代码高亮惰性（完成后或折叠展开时）。
- 长会话渲染：消息组件 memo，流式增量只重渲染当前消息；流式 Markdown 按 16–64ms 节流，代码高亮在进入视口且流式结束后才执行。当前历史消息仍完整挂载（未做列表窗口化），超长会话性能留待后续版本评估。
- 主进程内存稳态 < 300MB；单个工具输出硬上限截断。
