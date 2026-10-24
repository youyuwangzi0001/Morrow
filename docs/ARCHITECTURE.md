# Morrow 架构说明

> 面向贡献者与维护者。所有跨模块契约以 `src/shared/` 为准，本文件描述意图与边界，代码是最终事实。
> 先读 [README](../README.md) 了解产品，再按本文的进程模型、代码地图与模块边界阅读源码。

## 1. 进程模型

```
┌─────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                        │
│  app lifecycle / BrowserWindow / menu / dialogs / safeStorage        │
│  ┌────────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │ AgentService       │  │ SessionStore     │  │ SettingsStore    │ │
│  │ (core AgentRuntime)│  │ JSONL + meta     │  │ safeStorage key  │ │
│  └─────────┬──────────┘  └──────────────────┘  └──────────────────┘ │
│  ┌─────────┴──────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │ MediaService       │  │ Browser/Terminal │  │ MCP/Skills/API   │ │
│  │ Catalog / ffmpeg   │  │ PTY / Git        │  │ Memory/Projects  │ │
│  └────────────────────┘  └──────────────────┘  └──────────────────┘ │
│            │ emits RuntimeEvent (ordered, per runId)                 │
│  ┌─────────┴──────────────────────────────────────────────────────┐  │
│  │ ipc.ts : invoke handlers + event push (webContents.send)       │  │
│  │ feature:<name>:<action> : 功能面板窄 IPC 注册中心              │  │
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
│  files · browser · terminal · git · skills · connectors · projects   │
└─────────────────────────────────────────────────────────────────────┘
```

为什么 Agent 跑在主进程：需要文件/进程能力、崩溃隔离、窗口关闭时的生命周期管理；渲染层只做展示，避免 Node 注入面。媒体生成、浏览器原生视图、PTY 与 MCP 也都在主进程，渲染层只绘制 chrome 与结果。

## 2. 目录

```
src/
  shared/            # 领域类型、IPC 契约、模型/媒体清单、纯函数
    types.ts         # 会话/消息/工具/设置/命令/媒体等领域类型
    ipc.ts           # 通道名常量 + 请求/响应类型 + RuntimeEvent
    models.ts        # 模型预设 + 推理强度校验
    media-models.ts  # 引擎/模型清单 schema 与内置预设
    usage.ts         # 费用估算 + Token 热力图日期工具
    file-path.ts     # 对话内文件路径识别（相对/绝对/行号）
  core/              # 纯 TS，无 electron/react 依赖
    providers/       # openai-compat / anthropic / demo / sse / tool-result-text
    agent.ts         # AgentRuntime：循环、事件、中断、压缩、子代理
    tools/           # 文件/命令/浏览器/Office/媒体/MCP/计划/元工具 + registry
    permissions.ts   # 权限模式、规则、工作区边界
    context.ts       # token 估算、历史裁剪、压缩摘要
    prompt.ts        # 系统提示词（模式、目标、计划、工具规范）
    types.ts / util.ts / shell.ts / agent-roles.ts / browser-bridge.ts
  main/
    index.ts         # app 生命周期、窗口、菜单、协议、安全
    ipc.ts           # 主 IPC 注册与事件转发
    services/        # agent/session/settings/workspace/media/browser/terminal/git/mcp…
    features/        # feature:<name>:<action> 窄 IPC 注册（含 media）
    builtin-skill-content/ # 内置技能 Markdown（构建时内联）
  preload/index.ts   # contextBridge 窄接口
  renderer/
    index.html
    src/main.tsx, App.tsx
    src/styles/tokens.css, base.css
    src/ui/          # Button/Input/Modal/Select/Toast/ScrollArea…
    src/store.ts     # zustand store + selectors + IPC bridge
    src/components/  # Markdown/CodeBlock/DiffView/CodeEditor/BrandMark/FilePathLink
    src/features/    # shell/composer/chat/activity/artifacts/files/settings…
tests/
  unit/{core,main,shared}/  # 13 个领域套件（订阅协议/代理已合并）
  e2e/                      # 17 个主题套件（01–17，设置/媒体小 spec 已并入）+ launch/store helpers
  fixtures/                 # Mock LLM / ComfyUI、媒体与文档样本
```

### 代码地图（新贡献者）

1. **入口与状态**：`src/main/index.ts` → `src/main/ipc.ts` → `src/preload/index.ts` → `src/renderer/src/store.ts`。
2. **一次运行**：`core/agent.ts`（循环/事件）→ `core/providers/*`（模型协议）→ `core/tools/*`（工具）→ `main/services/agent-service.ts`（审批/持久化/窗口事件）。
3. **界面**：`App.tsx` 组合 shell 与 dock；`features/composer` 负责输入与模式；`features/chat|activity|artifacts` 负责对话、执行过程与成品。
4. **本地媒体**：`main/services/media-service.ts`（ComfyUI/ffmpeg/渲染）→ `media-catalog.ts`（模型/引擎生命周期）→ `core/tools/media-tools.ts`（工具参数/边界）→ `settings/MediaTab.tsx`。
5. **测试**：每个领域套件保留原文件的独立 `describe`；E2E 的 `launch.ts`/`store.ts` 提供真实 Electron 启动与状态驱动。

### 扁平化约定

- 不再使用仅做转发的 `features/*/index.ts` barrel；组件直接从实现文件导入。
- 宽度相近、语义内聚的小模块优先合并：`file-probe`→`workspace-files`、`docx-preview`→`office-preview`、`reasoning`→`models`、`comfyui-locate`→`media-service`、`app-icon`→`lifecycle`。
- Provider 的工具结果文本统一走 `providers/tool-result-text.ts`，OpenAI 兼容与 Anthropic 不各写一份。
- 测试按领域组织为少量套件；每个原测试文件保留独立 `describe`，hooks 随原作用域隔离。订阅协议/代理合并为 `subscription-protocols.test.ts` / `subscriptions.test.ts`，设置标题/UI token/订阅 E2E 并入 `08-settings.spec.ts`，模型表单并入 `16-media.spec.ts`。
- 目录只保留真实边界：`services`、`features`、`components`、`tools` 单层平铺，不为 2–4 个文件新增子目录。

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
- `MediaEngineSettings` / `MediaEngineStatus` / `MediaModelManifest`：本机引擎地址、安装目录、ffmpeg、超时与输出目录；模型/引擎清单定义 detect/install/service/modelDir 与 ComfyUI workflow；媒体成品以 `kind:'file'` artifact 登记，`meta.media` 只带路径、尺寸、时长与封面，不回灌模型上下文。
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
- `feature:<name>:<action>`（窄通道，preload 统一暴露 `features.invoke`）：文件树/编辑器历史/浏览器/记忆/自进化建议/项目/定时任务/连接器/MCP/技能/搜索/终端/Git/媒体目录/自定义命令/权限规则；主进程只接受已注册的精确频道并返回 `Result`。媒体相关频道包括 `feature:media:status|start|probe|pick` 与 `feature:media:catalog|catalog-action|pick-manifest`；自进化相关频道为 `feature:evolution:list|review|apply|ignore`；记忆相关频道包含 `feature:memory:list|add|update|toggle|remove|clear|export|injection` 与 `feature:memory:episodes|episodeToggle|episodeRemove|episodeClear|episodeInjection`。
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
- **压缩**：估算 token（CJK 1 char≈1 token，ASCII 4 chars≈1 token，历史图片每张按约 1100 tokens），**每次**超过 `contextLimit * threshold`（默认 80%）都触发，不设压缩次数上限、不使用冷却跳过。切点按 token 预算选择（目标压到窗口约 45%），优先保留最近消息、整个工具对、最早的用户任务锚点与当前用户请求；只压旧摘要时返回 no-safe-cut，但若只剩摘要+超大工具结果，会直接折叠工具输出/过老消息而不是放弃。摘要使用结构化交接模板（目标、硬约束、已完成、文件与改动、命令与测试、错误与修复、当前状态、未完成、必须保留的数据），按窗口给足输入（`contextWindow × 0.5`，12k–60k 字符，块级限长 + 中段省略），输出最多 4000 tokens；重复压缩会把上一份摘要作为“已有摘要”合并，而不是摘要的摘要。压缩后若仍高于阈值，立即用 `aggressiveTrim` 折叠工具输出并丢弃过老消息；摘要失败退回本地摘要。自动压缩立即下发 `messages_replaced`，对话里出现「上下文已压缩 · 节省 N tokens · 任务继续」标记，重启后仍是折叠摘要。手动 `/compact` 同路径（force 允许短对话），额外有 90s 超时、消息签名校验和摘要脱敏。
- **压缩溢出兜底**：如果 provider 返回上下文超限，主循环不结束任务：丢弃失败回合、强制压缩并重试（每步最多 2 次），恢复过程不弹错误；重试耗尽才报告。集群成员使用同一套压缩/兜底，不再用本地摘要作为唯一通道。
- **权限接缝**：默认「询问」= 工作区内自动、风险前询问。外部副作用命令识别（git push、npm publish、scp/ssh、docker push、kubectl apply、云 CLI 变更、curl 上传/POST、发邮件等），在询问档逐次确认（完全访问放行）；web_fetch 可按站点记住到本会话，减少查资料打断；内置浏览器的非交互动作（open/read/screenshot/reload/scroll/close）直接放行，click/type/upload 仍逐次确认；MCP 与 computer-use 保持一致逐次审批。工作区 allow/deny 规则、危险命令与越界审批仍在规则之前优先判定。
- **工具配对完整性**：裁剪只允许在 assistant(tool_use)+tool_result 完整交界处切割，绝不产生孤立 tool 消息（多数 API 会拒绝）。
- **推理强度与费用**：模型可声明 `reasoningStyle`；内置模型装载与模型同步都会为 `supportsReasoning` 的模型补齐风格——OpenAI 兼容（含 DeepSeek/Kimi/Qwen 等）映射 `reasoning_effort`，Anthropic 映射 `thinking.budget_tokens`，缺失风格时界面不会显示选择器。会话可覆盖推理强度；用量按会话累计，参考价格表估算 `costUsd`，无价格模型显示 —。
- **多会话后台运行**：普通运行按会话并行（目标循环仍全局串行）；渲染层按会话维护 `runs`，侧栏与输入区「运行中心」列出后台运行、等待确认与队列条数，并可切换/停止。关闭窗口默认隐藏到托盘，任务不中断；窗口不在前台时完成/失败/审批/提问发系统通知（审批/提问不受「完成时通知」开关影响，正文不包含命令、路径或问题原文），点击聚焦并切到对应会话。任务栏在运行期间显示不确定进度。
- **终端与后台任务**：`TerminalManager` 用 node-pty（Windows ConPTY）提供真实伪终端，自动检测 PowerShell 7、Windows PowerShell、命令提示符、Git Bash、WSL；默认 Shell 在「设置 → 终端」选择，终端界面不再放类型选择。该选择同时作用于终端面板、Agent 的 `run_command`、`terminal(run/start)` 与后台任务；系统提示会注入当前 Shell 及对应语法（PowerShell/cmd/POSIX），避免用户选了 cmd/Git Bash 后仍按 PowerShell 写命令。渲染层用 xterm 还原 ANSI/交互程序，支持标签页、尺寸同步、历史回放与明暗主题。终端停靠在主区域底部（左侧让出侧栏，默认 240px），顶栏按钮打开/隐藏，关闭面板后进程继续运行。后台任务仍用独立子进程（流式日志、stdin、停止/重启、400KB 环缓冲，最多 32 个进程）。Agent `terminal` 工具与面板共用管理器；cwd 必须位于已登记工作区。terminal 的 run/start 复用危险命令/越界检查，stdin 写入按高风险逐次确认。重启时旧进程事件不会覆盖新进程；一次性命令超时会返回已收集输出；应用退出时结束所有进程。
- **运行中排队**：同一会话运行中发送的消息进入主进程内存队列（最多 20 条，退出应用会丢失），`complete`/`max-steps` 后自动发送队首；取消/出错保留队列。用户可编辑/删除，或选择「打断并发送」先取消当前运行再立即发送；发送失败时保留队列条目并把内容放回输入框。自动发送前重新检查会话占用、压缩与全局目标占用，繁忙时保留队首并定时重试；等待取消期间切换会话时消息仍发回原会话。
- **检查点**：每轮 `startRun` 创建检查点；`tool_finished` 成功后按 `meta.absolutePath/afterHash/snapshotPath/created` 登记（集群成员通过 `swarm` meta.changedFiles 批量上报，失败子任务的文件改动也登记）。回退服务在写文件前做路径/快照边界校验、快照 beforeHash 校验、当前哈希冲突校验，冲突整体拒绝；快照目录使用清洗后的 toolUseId，`.restore.json` 目标不会覆盖撤销清单。代码回退保留对话与目标检查点，对话回退同步恢复 todos/artifacts/plan 及 planMode；回退成功后刷新文件树。
- **深度研究入口**：输入框只暴露聊天/工作两种 `SessionMode`；研究工作流仍使用内部 `research` 子状态（只读工具白名单、web_search、计划确认、自动续研），由 `/research` 命令从工作会话启动。研究计划确认/检索期间保持内部 research 模式；完成、停止或出错后自动切回 work 并保留 `research` 报告/来源；会话持久化允许 work + research 同时存在，研究条在 work 下继续展示报告。
- **计划模式**：`planMode=true` 时工具集切换为只读 + `ask_user`/`todo_write`/`submit_plan`，权限层固定 read-only，执行层再做一次白名单兜底（未暴露的 swarm/update_goal 等 meta 工具也会被拒绝）；模型只探索并提交计划，批准由主进程处理（切 work、重置 todos、启动执行运行）。只有每个计划步骤都有对应已完成 todo 才落为 completed；只读权限下批准会被明确拒绝并提示先切权限。计划待批准时 `run_finished` 仍走普通 complete，不写工作区。
- **集群（Agent Swarm）**：`swarm` 工具把 1–10 个独立子任务并行派发给集群成员（每批最多 10 个）；成员共享 provider/tools 与主代理同权限链（排除嵌套 `swarm`、`update_goal` 与 `todo_write`），拥有与主代理相同的工作区访问权限，不再有角色工具白名单或只读限制；角色只改变工作重点。写文件/命令/MCP 走同一权限链；「询问」档下危险/越界/外部动作审批，「完全访问」直接执行；审批/提问按会话串行呈现；成员上下文过长时用本地摘要折叠早期步骤；工具 id 与主代理统一分配，避免快照目录冲突。UI 以嵌套活动条展示，进度前缀显示成员类型，显示任务名、状态与步数。
- **演示模式**：`DemoProvider` 实现同一 `Provider` 接口，按剧本逐字流式输出（含工具调用参数），工具真实执行在复制后的 `demo-workspace/`；剧本中的数值由 `collectDemoMetrics()` 从真实 CSV 计算。**演示模式强制 auto 权限**（不弹审批，避免打断首次体验），时长可用 `MORROW_DEMO_SPEED` 调整。
- **手动压缩**：主进程 `chat:compact` 调用 core 的 `compactSession({force:true})`，把返回的 messages 写回会话并 emit `compaction` 事件，UI 的 `/compact` 即此路径。压缩期间该会话拒绝发送/建目标/切模式；结束时校验消息未变化，避免摘要覆盖新内容；摘要以折叠的系统标记展示，可展开查看。
- **撤销**：写/编辑工具把旧文件备份到 `<userData>/snapshots/<sessionId>/<toolUseId>/<basename>`，`ToolResult.meta` 带 `snapshotPath`；主进程 `file:restore-snapshot` 校验快照在工作区外不可写后还原文件，UI 的「撤销这次修改」即此路径。
- **自定义命令与钩子**：`send()` 在启动运行前顺序执行最多 5 个 `user_prompt_submit` 钩子，退出码 2 阻止发送并返回输出；工具结束与每轮结束分别触发 `post_tool_use` / `run_finished` 观察型钩子，不阻塞调度。钩子仅来自用户在设置中显式启用的命令，通过系统 shell 运行，15s 超时、16KB 输出上限，JSON 载荷经 stdin 传入。自定义命令从 `.morrow/commands/*.md` 发现，发送时展开模板。

## 6. 工具规范（v1）

当前注册 57 个工具（含 12 个媒体工具：生图、生视频、短片、代码渲染、剪辑、探测、视觉审看、媒体状态、通用模型/引擎目录与管理、指定模型调用）；下表列出通用工具，媒体工具见 8.12/8.13。

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
| `remember` | text, scope?, tags? | 只读拒绝；其余模式按权限审批 | 写入记忆中心的结构化项目/全局记忆；临时对话不写，旧 MEMORY.md 仍可迁移 |
| `submit_plan` | title, summary, steps[], risks? | 仅计划模式 | 提交执行计划，登记 Markdown 产物并等待批准；不执行任何步骤 |
| `swarm` | goal, tasks[]（1–10） | 元工具；成员与主代理同权限链 | 每个成员拥有完整工作区工具（排除嵌套 swarm/update_goal/todo_write）；交互卡串行 |
| `open_artifact` | title, kind, path?/content? | 无 | 注册画布条目（HTML/MD/SVG/代码） |
| `web_search` | query, max_results? | 默认使用内置 Bing 搜索（无需配置）时也暴露；结果不可信 | 内置 Bing 搜索或 Tavily/Brave/Serper/SearXNG 补充服务，默认条数取设置，meta.sources 分组进入搜索卡与来源面板；响应按字节流 2MB 上限；限流 10 次/分钟、缓存 5 分钟 |
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
- 画布产物：HTML/Markdown/SVG/代码/文本内联渲染；图片、PDF、Office、音视频产物自动进入只读文件预览。文件读取按需只读前缀：统一 8MB，超出时显示截断提示。
- IPC 路径边界：产物读取/打开/另存与文件搜索只接受已登记工作区 realpath 内的文件/目录；搜索不跟随 junction/符号链接，避免枚举工作区外文件。会话创建/切换会校验权限模式、会话模式与模型是否仍可用。
- 文件预览：`feature:files:*` 的显式 workspace 也必须属于已登记工作区；主进程校验后签发 `morrow-file://preview/<token>`（6 小时过期，每次请求重新 realpath 校验，支持 Range）；CSP 仅放行该协议的 `img-src` / `media-src` / `connect-src`。PDF 用 PDF.js 逐页渲染，DOCX 用 Mammoth 转 HTML 后放进无脚本 sandbox iframe；XLSX 解析多工作表为表格，PPTX 提取幻灯片文本，RTF/ODT/ODS/ODP/EPUB 转安全 HTML，ZIP/JAR 列出目录；CSV/TSV 在编辑器内提供表格预览，SVG 提供图形预览。旧版 doc/xls/ppt 与 7z/RAR/TAR 等明确降级为系统应用打开。图片预览上限 50MB；转换输出有行列/条目/字节上限，文档 HTML 只输出转义文本；本地 HTML 预览禁用脚本与表单。

## 8.5 启动器、清单与签名

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

## 8.6 Git 工作台

- 窄 IPC：`feature:git:status/init/diff/stage/unstage/discard/commit/branches/checkout/create-branch/log/show`，渲染层复用 `window.morrow.features.invoke`；实现位于 `main/services/git-service.ts`，频道统一注册在 `main/features/index.ts`。
- 工作区边界：先经统一 `resolveWorkspaceDir` 校验登记目录；`git rev-parse --show-toplevel` 得到的仓库根必须仍在该工作区 realpath 内，否则拒绝（避免在「更大仓库的子目录」里误操作仓库外文件）。路径只接受仓库内相对路径，拒绝绝对路径、`..` 与 NUL，并统一使用 `--literal-pathspecs` + `--`。子进程环境会剔除继承的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_CEILING_DIRECTORIES` 等变量，防止外部环境把命令重定向到工作区之外的仓库；暂存/取消暂存只有完全省略 `path` 才代表「全部」，非法值直接报错。
- 只提供本地操作：状态、差异、暂存/取消暂存、放弃改动、提交、分支创建/切换、最近 80 条历史与提交详情；不提供 push/pull/凭据操作，界面明确提示用终端完成。子进程无 shell，带超时、8MB 输出上限；提交禁用 GPG 签名避免 pinentry 阻塞；提交信息 1–5000 字。
- Windows 兼容：`index.lock` 短暂占用会退避重试；安全软件阻止 git 子进程覆盖工作区文件时，主进程从索引经 smudge 过滤器取回内容写回并刷新 stat 缓存（符号链接/子模块直接报错），随后 `git status` 确认干净。
- UI：工作台「Git」卡片与 `/git` 命令；变更页左侧提交框 + 已暂存/更改分组，右侧 unified diff；历史页左侧提交列表、右侧详情与补丁。支持一键 init、分支菜单、ahead/behind、刷新与 15s 轮询（窗口可见且空闲时）。面板高度按视口收缩，页脚与操作区始终落在模态可视区内；切换分支会同时失效并重载历史，差异/提交详情用请求序号丢弃过期响应。删除工作区文件由「放弃改动」二次确认触发；渲染层不直接接触文件系统。
- 已知边界：合并提交默认不显示补丁；二进制文件只显示 Git 摘要；超大差异（>400KB）截断展示；子模块与符号链接的还原请使用终端。

## 8.7 自定义命令与运行钩子

- 自定义命令：扫描 `<workspace>/.morrow/commands/*.md` 与 `~/.morrow/commands/*.md`，文件名（小写）即命令名，项目覆盖同名用户命令。项目命令目录必须 realpath 落在工作区内，`.morrow` 链接到外部时整目录忽略。简单 frontmatter 支持 `description` / `argument-hint`；正文为提示词模板，发送时展开 `$ARGUMENTS` 与 `$1..$9`，无占位符时把参数附在末尾。只读取普通文件（跳过符号链接与非 `.md`），单文件 64KB、正文 16KB、最多 100 条；达到上限后项目命令仍可覆盖同名用户命令。渲染层通过 `feature:commands:list` 读取，斜杠菜单按需刷新；`new/demo/plan/settings/btw/swarm/goal/init/clear/rewind/export/export-json/usage/compact/git` 为内置保留名（`shared/commands.ts`），重名文件在设置页标为「重名」且不会进入菜单；未知 `/命令` 与「保留名 + 参数」只提示，不会当作普通消息发给模型。
- 钩子：仅来自 `Settings.hooks`（设置 → 自动化），不读取项目文件，避免打开陌生仓库即执行代码。用户显式启用后才运行，事件为 `user_prompt_submit`（发送前，退出码 2 阻止并显示输出，顺序执行，遇到退出码 2 立即停止后续发送前钩子）、`post_tool_use`（工具完成，带工具名/入参/结果摘要）、`run_finished`（每轮结束，带结束原因与最终文本）。每个事件最多 5 个启用钩子，设置保存时校验、执行时兜底截断，界面提示该上限。命令通过系统 shell 执行（`spawn(command, {shell:true})`），cwd 为当前工作区，JSON 载荷写入 stdin（≤200KB），环境变量 `MORROW_HOOK_EVENT`/`MORROW_WORKSPACE`；15s 超时、stdout/stderr 各 16KB 上限；Windows 超时通过 `taskkill /T /F` 结束整棵进程树，避免 shell 子进程残留。
- 失败处理：`user_prompt_submit` 只有退出码 2 阻止发送，崩溃/其它非零码记录后继续；`run_finished` 钩子失败以轻量通知提示；`post_tool_use` 失败只写日志，避免打断运行。设置保存时严格校验 id/事件/命令（最多 20 个、每事件最多 5 个启用），磁盘加载时宽松归一化。自动化页把命令读取错误与钩子保存错误分开显示；模态正文不产生第二层滚动条，仅右侧面板滚动。

## 8.8 MCP 资源、提示词与 OAuth

- 客户端能力：`initialize` 后记录 server 声明的 capabilities；`resources/list`、`resources/templates/list`、`resources/read`、`prompts/list`、`prompts/get` 已接入 stdio / Streamable HTTP / 旧版 SSE 三种传输。资源文本单条 8KB、二进制只保留 64KB base64 预览；提示词消息非文本块折叠为占位符。
- Agent 工具：新增 `mcp_resources`（list/read）与 `mcp_prompt`（list/get），均为 `exec` 外部动作——只读模式拒绝，ask/auto 逐次审批；返回内容标注为不可信数据，不构成授权。非法 action 直接报错，不静默退化为 list；提示词参数限制 64 个、键名 128 字符、值 4000 字符。连接器「测试连接」会同时列出工具/资源/模板/提示词数量与目录，可复制 URI 或提示词名，实际读取仍走对话审批。
- OAuth 2.0：为 HTTP/SSE 连接器提供授权码 + PKCE（S256）公共客户端流程。端点在连接器面板填写（authorizationUrl / tokenUrl / clientId / scopes），不做动态注册、不支持 client_secret；点击「开始授权」会先保存当前表单，再由主进程在 `127.0.0.1` 随机端口启动一次性回调，校验 state（5 分钟超时），换取 access/refresh token。重新授权会关闭同一连接器的旧回调服务并清除旧定时器，避免旧超时误删新流程。
- 令牌作用域：`createMcpConnection` 从配置来源（用户级 / 具体工作区）获得上下文，resolver 以「作用域 realpath + OAuth 端点与 Client ID 指纹」为键读取令牌；同名连接器在不同工作区、或 OAuth 端点变化后不会复用旧令牌。改名保留授权，删除连接器会同时删除对应令牌；旧版按名称保存的令牌作为过渡回退。后台每 60 秒检查一次，在过期前 5 分钟用 refresh_token 刷新；刷新失败只发事件/保留旧令牌，不打印令牌内容。面板区分正常、未授权、已过期（可自动刷新/需重新授权）状态。
- 安全：OAuth 端点与 MCP URL 同样经过协议与 SSRF 校验（本机/内网需显式 allowPrivateNetwork）；回调只监听回环地址并校验 state；错误页使用严格 CSP、无脚本；令牌与授权码不写日志。连接器 IPC 的 workspace 参数统一经 `resolveWorkspaceDir` 校验已登记工作区；`mcp.json` / `mcp-secrets.json` 解析失败时拒绝保存而不是按空配置覆盖；配置、密钥与令牌写入统一使用临时文件 + 重命名（Windows 占用时退避重试）。面板外层模态不滚动，配置路径/提示固定，左右两栏与编辑区内部滚动，底部操作条吸底。

## 8.9 集群成员与 Agent Swarm（可选能力）

- 内置角色：20 种成员类型（general/explore/plan/architect/review/test/debug/frontend/backend/fullstack/data/ml/research/security/performance/devops/integration/docs/design/specialist），每种只提供「工作重点 + 交付要求 + 边界」的专属提示；成员工具集与主代理一致（排除嵌套 `swarm`、`update_goal`、`todo_write`），不再有工具白名单或只读角色。权限链、审批、工作区边界完全由父代理当前档位决定，角色不能扩大也不能缩小权限。
- 自定义角色：`<workspace>/.morrow/agents/*.md` 与 `~/.morrow/agents/*.md`，frontmatter 使用 `title/description`，正文为角色系统提示；旧版 `tools/read-only` 会被解析但忽略（不参与权限）。项目覆盖同名用户角色，内置名保留不可覆盖。单文件 32KB、正文 8KB、最多 32 个自定义角色；只读普通文件。项目目录必须 realpath 落在工作区内（`.morrow` 链接到外部时整目录忽略）；达到上限后项目角色仍可覆盖同名用户角色。
- 角色与技能的关系：角色（`agent`）回答「负责什么、边界、交付什么」，技能（`list_skills/read_skill`）回答「用什么方法做」。成员系统提示固定注入「角色与技能的关系」段：任务要求 > 角色分工与安全边界 > 技能方法细节；技能不能改变分工、交付对象、验收标准或权限；冲突时按任务与角色执行并在结论中说明。主提示词与 `swarm` 工具说明同样要求「用 agent 选分工，不要把技能名当角色，也不要把技能正文塞进子任务」。
- `swarm` 工具接收 `{goal, tasks:[{title,prompt,agent?,context?}]}`，1–10 个任务并行分批执行（最多 10 个同时推进），返回每个成员的摘要/步数/失败信息；任一子任务未完成时工具返回 `ok=false`（保留成功摘要），不计为全部完成。成员工具集排除 `swarm/update_goal/todo_write`，其余工具与主代理一致；context 限 4000 字符，成员类型名限 80 字符。
- 行动轨迹对 `swarm` 展示结构化的「任务拆分」列表（序号、标题、角色），不再以原始 JSON 为主视图；结果区仍显示每个子任务的状态与摘要，暗/亮主题均沿用黑金样式。
- 系统提示在工作模式列出可用成员类型与使用建议；聊天模式/计划模式不注入成员段，也不暴露 `swarm`。输入框 `/swarm 目标` 会生成拆解指令；`/swarm` 在聊天/计划/运行中禁用并说明原因。
- 设置 → 自动化展示内置与自定义成员类型（名字、说明、来源），便于发现；成员与主代理同工作区权限，不再显示或限制只读。UI 成员进度以「类型 · 步骤」展示。

## 8.10 侧边聊天 /btw

- 入口：输入框旁「侧边聊天」按钮或 `/btw [问题]`；右侧固定抽屉，可在主对话运行时使用。
- 只读问答：主进程 `runSideChat` 直接使用当前会话选定的模型（模型被删除时明确报错，不静默回退到同提供方的第一个模型），`tools=[]`，不能改文件/跑命令/联网；默认把主对话最近 12 条文字（≤12k 字符）作为只读上下文附在系统提示中，可在抽屉里关闭「带上主对话」。侧边聊天自己的历史由渲染层保留（≤12 条、总额 12k 字符；关闭不清空，切换主对话时清空）。
- 不写入主对话：不创建消息/检查点、不进入会话 usage、不触发审批；仅通过 `feature:sidechat:ask/cancel` 与 `feature:sidechat:event` 流式返回（delta/notice/done/cancelled/error）。requestId 由渲染层在 invoke 前生成并保存，避免极快模型的 delta/done 早于 IPC 返回值；每个会话只允许一个进行中的侧边聊天，全局最多 8 个，新请求会取消同会话旧请求。
- 停止与异常：取消会中止 provider 流并返回 `cancelled`，保留已经生成的部分回答并标注「已停止」，不会误发 `done`；空回答视为错误；服务商的输出截断/内容拦截提示以 `notice` 显示。切换主对话时取消并清空，避免旧回答写入新会话。
- 边界：演示模型不支持侧边聊天（避免复用演示剧本）；不支持工具与附件；抽屉打开时通知栈移到抽屉左侧，避免遮挡停止/发送控件。

## 8.11 内置技能与技能提示词

- 首次启动由 `ensureBuiltinSkills(dataDir)` 把 18 个内置技能安装到 `<dataDir>/skills/<name>/SKILL.md`，分为四层：
  - 工作方法：brainstorm-and-scope、plan-and-execute、verify-before-delivery、parallel-work；
  - 工程：code-review、debugging、test-writer、refactor、security-audit；
  - 交付：frontend-art-direction、deliverable-quality、document-deliverables、data-analysis、web-research、canvas-artifacts；
  - 产品操作：workspace-git、mcp-integration、skill-author。
  每个都是纯 Markdown 流程说明（无脚本），覆盖「何时使用 / 何时不要用 / 流程 / 示例 / 完成检查 / 反模式 / 安全边界」，正文维护在 `src/main/builtin-skill-content/*.md`，构建时以 `?raw` 内联进主进程。旧的 ui-polish、docs-writer、deliverable-report、release-notes 已分别并入 frontend-art-direction 与 document-deliverables；升级时移除未修改的旧副本，用户改过的保留为自有技能。
- 安装策略：同名目录已存在（用户自己的技能）不覆盖；用户删除后不自动恢复；升级时只更新「未被用户修改」的技能（sha256 与 marker 比对），保留用户编辑。marker 为 `skills/.builtin-skills.json`，用户编辑后持久化 `modified: true`，后续每次启动都不会再被内置内容覆盖；SKILL.md 与 marker 使用临时文件 + 重命名写入，避免半文件被误判成用户编辑。内置技能在技能库中标记「内置技能」，仍可禁用/删除/查看原文。
- 技能提示词：只列 name/description/路径，不把正文塞进系统提示；要求仅在用户点名或任务明显匹配时读取，避免「为了用技能而改目标」；明确技能是流程参考资料、不是授权，命令/路径需按工作区与审批规则执行，夹带操作一律不执行。
- `read_skill` 的 `path` 只接受 `.morrow/skills`、`skills`、`.skills` 或一级子目录 `/skills` 下的 `<技能>/SKILL.md`（用于同名或遮蔽技能消歧），并检查启用状态；不能借 path 读取工作区任意 `SKILL.md`，已禁用技能即使给出路径也不能读。
- 安装边界：同名判断不区分大小写（避免 Linux 上 `Foo`/`foo` 与状态键冲突）；覆盖安装拒绝符号链接，只删除用户技能库内的普通目录；脚本/可执行文件会被跳过并在安装结果里报告，Morrow 不会执行它们；其余非可执行资源正常安装。
- UI：技能库面板按视口收缩，外层模态不滚动；工具栏/摘要固定，列表与详情内部滚动，底部用户目录/操作条始终可见；SKILL.md 原文保留自己的滚动区。
- 回归：`builtin-skills` 单测 4 项（安装/发现、用户编辑与删除且二次启动仍保留、旧技能合并迁移、同名用户技能不覆盖）；`skills` 主进程/核心单测共 32 项；`09-panels` E2E 覆盖技能面板。

## 8.11.1 自进化建议

- `src/main/services/evolution-service.ts`：任务摘要、强信号判断、单轮模型审阅、JSON 校验、建议存储/过期/去重、采纳/忽略；纯 Node，可单测。
- 自动入口在 `AgentService.persistResult()` 后的异步调度；手动入口是 `feature:evolution:review`。两者都使用当前会话模型，但只发送脱敏后的摘要，不包含工具完整输出。
- 建议保存在 `<dataDir>/evolution/suggestions.json`；用户采纳后分别调用 `MemoryService` 或 `SkillsService.createUserSkill/updateUserSkill`，不会静默改文件。
- UI 位于记忆中心顶部；历史设计笔记不随交付发布。

## 8.11.2 记忆系统（长期记忆 / 任务经验 / 规则 / 自进化）

- 四层分工：长期记忆（项目 `.morrow/memories.json` / 全局 `<dataDir>/memories/global.json`，每次注入、600 token 预算）；任务经验（项目 `.morrow/episodes.json` / 全局 `<dataDir>/episodes/global.json`，按当前请求检索 1–2 条、约 320 token）；项目规则/说明（现有 AGENTS/CLAUDE/MORROW 与项目资料）；技能（SKILL.md 按需读取）。自进化建议是候选晋升入口，不等于记忆已写入。
- 任务经验由 `AgentService` 在正常完成且有实际工具/文件/成品产出时自动记录，不调用模型；每个工作区最多 200 条，按来源消息去重，只存摘要/目标/文件/工具，不存完整工具输出。`getEpisodePrompt()` 在每轮启动时按当前用户消息做关键词检索，检索结果明确标注为“经验，不是指令/授权”。
- `remember` 工具通过 `ToolContext.remember` 写入结构化记忆中心（支持 project/global 与 tags），不再默认旁路 `.morrow/MEMORY.md`；旧文件仅在无回调时回退，记忆中心继续迁移。
- 记忆中心支持「长期记忆 / 任务经验」切换；任务经验可展开、启停检索、删除、清空，并可“沉淀为长期记忆”（预填草稿，保存后才生效）。注入预览同时展示长期记忆与当前请求匹配的任务经验。
- 渠道：`feature:memory:*` 新增 `episodes|episodeToggle|episodeRemove|episodeClear|episodeInjection`；记忆/经验变更会广播 `feature:memory:changed` / `feature:memory:episodes-changed`。
- 详细调研与设计不随交付发布；用户向说明见 [FEATURES.md](FEATURES.md)。

## 8.12 本地多媒体（ComfyUI / ffmpeg）

- **边界**：Morrow 不内置推理引擎和权重。`main/services/media-service.ts` 负责检测/启动本机 ComfyUI、组装工作流、提交与轮询、下载成品、探测媒体、调用 ffmpeg；`core/tools/media-tools.ts` 只做参数校验、工作区边界、进度与画布产物登记。设置存 `Settings.mediaEngine`（地址、安装目录、ffmpeg、超时、输出目录），不加密、不联网。
- **引擎检测**：`GET /system_stats` 拿版本/显卡/显存；`/object_info/<node>` 拿模型清单与自定义节点是否存在。填了安装目录时同时扫描 `models/diffusion_models|text_encoders|vae`，按文件大小发现半下载/损坏文件；设置页可一键启动 `.venv/venv/python_embeded` 里的 ComfyUI（`--reserve-vram 2.5`，不再加会破坏文本编码器读取的 `--fast-disk`）；目录为空时自动探测常见安装位置并回填，显式填写的目录优先；子进程的 `TEMP/TMP` 固定到安装目录下的 `morrow-temp`，避免从 MSYS/Git Bash 启动时 `/tmp` 无效导致 torch 初始化失败。模型状态区分“已核对但缺失”和“未核对（没有安装目录）”，不会把未配置误报成缺文件。
- **工作流**：Qwen-Image 2.1 Turbo 文生图（`UnetLoaderGGUF` + `QwenImage21Cache` + `TextEncodeQwenImage21` + 8 步 `ManualSigmas` + `SaveImage`）；图像编辑用同一模型，参考图通过 **Autogrow 扁平键** `images.image_1` 传入，`resolution=0` 保留参考图尺寸。MiniMax-H3 使用官方 Fast 预设（Sol-Attn、Fused Modulation、Chunk FFN、EasyCache）：Ref2VA 走 `MiniMaxH3ReferenceToVideo`（`ref_images.ref_image_0/1`），FL2VA 走 `MiniMaxH3ImageToVideo`（`first_frame`/`last_frame`）；两者都用 24fps、124 帧约 5 秒、原生音频 VAE，最后 `CreateVideo` + `SaveVideo`。动态输入必须用扁平键，写成嵌套对象会被 ComfyUI 静默忽略，参考图不生效。
- **进度与取消**：提交前连 `/ws?clientId=` 收 `progress`/`executing` 事件，映射到 `tool_progress.percent`；`chat.cancel` → abort → `/queue` 删除或 `/interrupt`。工具把进度写进工具行标题与 2px 进度条；完成后标题回到「图片已生成 / 视频已生成 / 短片已完成 / 剪辑完成」。
- **成品**：ComfyUI 输出先下载到工作区 `media/images|videos|films`；图片/视频探测用 ffprobe，缩略图用 ffmpeg；产物以 `kind:'file'` 登记，画布直接用 `FilePreviewPane` 播放，聊天里用 `MediaResultCard` 显示缩略图/内联视频。工具结果 `meta.media` 只带路径、尺寸、时长、模型、封面等，不回灌模型上下文。
- **代码镜头**：`render_animation` 用隐藏的离屏 `BrowserWindow` 加载工作区内的自包含 HTML，按 fps 逐帧调用 `window.renderAt(t)` 并 `capturePage`，再把帧序列用 ffmpeg 合成带静音音轨的 MP4；支持 `time_unit=seconds|milliseconds`，捕获帧会强制重采样到目标尺寸，避免高 DPI 下出现奇数宽高。
- **剪辑**：`edit_media` 用参数数组直接 spawn ffmpeg（不拼 shell），支持 trim/crop/resize/rotate/flip/speed/mute/volume/extract_audio/extract_frame/gif/convert/concat；输入输出都经工作区 realpath 校验，输出已存在则拒绝；`extract_frame` 的 `fromEnd` 用 `-sseof` 取尾帧，供跨镜接龙。
- **跨模型短片**：`generate_film` 逐镜执行「Qwen 首帧 → MiniMax 视频 → 取尾帧 → 下一镜」，默认用上一镜尾帧作为下一镜首帧（FL2VA 首帧锚定；未装 FL2VA 时退回 Ref2VA 身份参考）；所有镜头同分辨率/帧率，最后 ffmpeg concat 重编码成 `media/films/film-*.mp4`。代码镜头可由本地 coder390 写 HTML 后经 `render_animation` 生成，再用 `edit_media(concat)` 与生成镜头拼成最终片。16GB 显卡下 coder390（约 12.4GiB）与 MiniMax 不能同时驻留，需分阶段执行；Morrow 暂不自动切换两套引擎。镜头数 2–6，单镜 5–10 秒；全程受同一个 abort 控制，进度按分镜归一化到 0–100%。
- **视觉审看**：`describe_media` 复用现有 llama.cpp provider（如 coder390 + mmproj），图片直接发送，视频抽取 1–4 帧后附带文字问题流式返回；只读风险，不写入工作区。审看结果回到聊天工具卡，供后续修改提示词或重生成。
- **长任务可靠性**：运行中的 `artifacts_updated` 现在写入增量会话快照（`active.liveArtifacts`），视频/短片生成中崩溃或退出后，重启仍能看到已登记的成品卡片。
- **权限**：媒体工具属 `exec`，只读模式拒绝、聊天/计划模式不暴露（`inspect_media`/`media_status`/`list_local_models` 为只读）；参考图/末帧/输出路径都走 `resolveWorkspacePath`，工作区外需审批；ComfyUI 地址只能由用户配置，模型无法改。

## 8.13 通用模型/引擎目录

- **清单**：`shared/media-models.ts` 定义引擎清单（detect/install/service/modelDir）和模型清单（engine/kind/capabilities/install/comfy workflow）。Qwen/MiniMax/coder390 只是 `BUILTIN_MODELS`，用户/Agent 的清单存 `<userData>/media-models.json` 与 `media-engines.json`。
- **生命周期**：`main/services/media-catalog.ts` 统一 status/install/uninstall/start/stop/register/remove；ComfyUI 与 llama.cpp 走模型文件下载（断点续传、大小/SHA 校验、路径沙箱），Ollama/LM Studio 走 CLI 拉取/删除，provider 类型不重复下载。安装/卸载/启停是高影响工具，走权限审批。
- **调用路由**：`run_local_model` 按模型 id 交给原生 Qwen/MiniMax 适配器，或执行清单里的 ComfyUI 工作流（bindings 注入 prompt/negative/宽高/seed/参考图/末帧）；Ollama/LM Studio/provider 类多模态模型用于理解，不冒充媒体生成。
- **引擎适配**：ComfyUI 填目录后启动；llama.cpp 检测 PATH/本地目录，按模型清单启动并可停止 Morrow 自己启动的进程；Ollama/LM Studio 支持 winget 安装、CLI 启停与 pull/rm；自定义引擎通过清单命令接入。
- **UI**：设置 → 多媒体不再写死模型卡片，动态列出引擎/模型、安装/卸载/启停、应用内添加本机模型与导入 JSON 清单；ComfyUI 表单可直接粘贴 API 工作流，llama.cpp/Ollama/LM Studio 走文件或引擎内 ID；Qwen/MiniMax 显示为内置预设。模型文件在引擎目录外时自动复制进目录。
- **边界**：ComfyUI 自定义节点不静默安装，`requiredNodes` 只作提示；当前未在本机真实验证 Ollama/LM Studio 的 winget 安装与 pull（两引擎未安装），llama.cpp 启停已真实验证。详见 [MEDIA-MODELS.md](MEDIA-MODELS.md)。

## 8.14 模型订阅（独立设置页）

- **入口**：设置独立 Tab「订阅」，不并入「模型」页；官方账号、额度与第三方 coding plan 都在这里管理。Provider 仍写入现有 `Settings.providers`，对话、工具、权限、压缩全部复用原链路。
- **总控**：`main/services/subscriptions.ts` 负责 Codex、Qoder、第三方订阅和总状态；`agent-subscriptions.ts` 是 8 个 Agent 渠道的统一注册表，按 `AgentSubscriptionId` 分派 status/login/token/import/refresh/remove/test/enable。
- **Codex 官方线路**：`~/.codex/auth.json` 只读导入或 PKCE 浏览器 OAuth；`codex-proxy.ts` 在 `127.0.0.1` 起回环代理，把 OpenAI Chat Completions（流式、工具调用、工具结果回放）转换为 Codex Responses，再把 SSE 转回 OpenAI chunk；额度读 `/backend-api/wham/usage`。
- **Qoder**：`qoder-subscription.ts` + `qoder-proxy.ts` 处理 PAT/设备流/qodercli 导入、COSY 签名、请求体编码与信封 SSE。
- **Agent 渠道**：每个渠道一个 service + 一个纯协议模块。协议模块只做常量、请求改写、额度解析与事件解析，可独立单测；service 负责登录、加密存储、刷新、回环 Provider 的注册/启停/移除与重启恢复。
  - OpenAI wire：Kimi、Step、OpenCode；Cline 额外做 `cline-pass/` 前缀与 `{success,data}` JSON 解包。
  - Anthropic wire：GLM、MiniMax；GLM 兑换 Coding Plan Key 并同时注入 `x-api-key` 与 Bearer。
  - 双 wire：Command Code 按模型目录把 Claude 路由到 `/messages`，其余路由到 `/chat/completions`，两个 Provider 共用一个回环代理。
  - 专用协议：Antigravity 把 OpenAI Chat Completions 翻译成 Gemini `streamGenerateContent` 信封，再把 Gemini SSE 的文本、思考、工具调用与 usage 转回 OpenAI chunk。
- **共用工具**：`agent-subscription-common.ts` 统一 `safeStorage` 加密文件、Provider 注册/移除/启停、测活与本机凭据读取；`subscription-relay.ts` 统一鉴权注入、401/403 刷新重试、请求体改写与 JSON 响应解包。
- **凭据**：每个渠道独立加密文件（如 `kimi-subscription.json`、`glm-subscription.json`）；access/refresh token 与长期 Key 都不进入 Provider 配置、日志或渲染层。Codex/Qoder/MiniMax/Step/OpenCode 的本机凭据只读导入。
- **恢复**：启动时遍历注册表调用 `restore()`，解密凭据、重启回环代理并重写 Provider baseUrl；退出时关闭所有本地代理。
- **安全边界**：代理只绑定回环并要求随机本地 token；浏览器回调校验 state；不代充、不共享账号、不绕过服务商限制。

## 8.15 设置页标题

所有 15 个设置子页共用 `SettingsModal` 顶部的 `.st-page-head` / `.st-page-title`：`var(--font-display)`、20px、500、1.2 行高、`-0.01em` 字距；说明文字 12px、`var(--text-3)`。子页内部只保留分区标题，不重复页面级标题。`tests/e2e/08-settings.spec.ts`（合并后的设置域）逐页校验字号、字重、字体一致，并输出深浅色截图。

## 9. 构建与打包

- `npm run dev`：electron-vite dev（renderer HMR）。
- `npm run build`：typecheck → electron-vite build。
- `npm run dist`：build → electron-builder `--win portable` → 自研单文件启动器，并生成 NSIS 安装包，输出 `deliver/Morrow-<ver>-portable.exe` 与 `deliver/Morrow-<ver>-setup.exe`；便携运行时缓存 `.morrow-runtime-<ver>-r<版本数字>`（0.1.0 为 `r010`）。
- `npm run dist:all` / `node scripts/dist-portable.mjs --portable`：内部文件夹 + zip + 单文件/安装包检查。
- Electron 二进制镜像：`.npmrc`/脚本设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；electron-builder 二进制镜像 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- 数据目录：`app.setPath('userData', path.join(PORTABLE_EXECUTABLE_DIR, 'Morrow Data'))`（存在该环境变量时），支持 `--data-dir=` 覆盖。用户在「设置 → 关于」选择的自定义目录通过 `%LOCALAPPDATA%\\Morrow\\data-location.json` 持久化；启动时优先于便携默认目录，切换会重启并可迁移用户数据。
- 版本号单一来源：`package.json`；打包脚本据此生成启动器程序集版本与运行时目录名，关于页与窗口标题读取同一版本。构建时间与 git 状态写入 `docs/verification/packaging.json`。

## 10. 测试策略

当前门禁：**14 个单元套件 / 943 个用例**，**17 个 E2E 套件 / 208 个用例**；每个原始测试文件保留独立 `describe`。

1. **单元（vitest，无 Electron）**：SSE 解析、Provider 双协议与工具结果文本、token 估算与裁剪配对、权限规则、工具（临时目录）、Agent 循环（脚本化 Provider）、会话序列化、媒体目录/工具、输出隐私守卫。
2. **协议集成**：本地 HTTP Mock 同时实现 OpenAI/Anthropic SSE，断言请求体与解析结果。
3. **E2E（Playwright `_electron.launch`）**：覆盖窗口/主题、演示全流程、权限审批与中断、会话恢复、快捷键与光标、编辑器与文件预览、记忆/项目/技能/连接器、内置浏览器、IPC 边界与全局搜索等旅程。`16-media` 用本地 ComfyUI mock（真实 PNG/MP4 fixture）验证设置检测、生图/改图、视频播放、ffmpeg 剪辑、两镜短片与画布预览，并吸收代码镜头渲染与音视频拼接用例；`15-local-model` 还包含真实本地模型的 11 项通用能力代理评测（`MORROW_AGENT_EVAL=1`）。
4. **Agent 质量评测（vitest，离线确定性）**：四项指标——工具首次/重试成功率、60 轮长任务漂移、压缩后关键决定保留、80 轮 Token 曲线；结果写 `docs/verification/eval-results.json`，实机本地模型摘要写 `eval-live-results.json`。规范见 [EVALUATION.md](EVALUATION.md)。
5. **通用模型目录与媒体**：`tests/unit/main/media.test.ts` 覆盖清单校验、路径安全、共享文件卸载、真实 llama.cpp 启停、媒体设置与工具路由；`tests/unit/core/tools.test.ts` 中的 media-tools 覆盖参数/边界/调用路由。
6. **真实冒烟**：`scripts/probe-live.mjs` 用本机 DeepSeek Key 跑 1 轮真实流式 + 1 次工具调用（结果只打印状态与耗时，不打印密钥）。
7. **打包冒烟**：`scripts/smoke-packaged.mjs` 启动便携 exe，检查窗口、预加载 API、渲染与截图。
8. **真实多媒体集成（可选）**：`MORROW_MEDIA_INTEGRATION=1` 时，`tests/unit/main/media.test.ts` 的集成用例直连本机 ComfyUI，真实跑文生图、参考图编辑、5 秒 MiniMax 视频、抽尾帧、trim、提取音频与缩放；验证参考图尺寸/身份保留，而不是只测 mock。
9. **截图**：用户界面图文见 `docs/guide/screens/`；打包冒烟证据见 `docs/verification/packaged-smoke.png`，不再堆积历史轮次截图。

## 11. 性能预算

- 冷启动到可交互 < 1.5s（中端 Windows）；首条 token < 1.5s（网络决定，UI 立即出现）。
- 流式渲染 60fps：增量文本按 16ms 合并；代码高亮惰性（完成后或折叠展开时）。
- 长会话渲染：消息组件 memo，流式增量只重渲染当前消息；流式 Markdown 按 16–64ms 节流，代码高亮在进入视口且流式结束后才执行。当前历史消息仍完整挂载（未做列表窗口化），超长会话性能留待后续版本评估。
- 主进程内存稳态 < 300MB；单个工具输出硬上限截断。
