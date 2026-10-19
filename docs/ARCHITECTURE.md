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
  - `ContentBlock`：`text` | `thinking` | `tool_use { id,name,input,status }` | `tool_result { toolUseId, ok, content, meta }` | `image`（二期）
- `Run`：一次用户输入触发的 Agent 执行；状态 `running | waiting_permission | waiting_user | done | cancelled | error`。
- `RuntimeEvent`（有序，带 runId/seq）：
  - `run_started` / `run_finished`
  - `message_started {messageId, role}` / `message_delta {textDelta, thinkingDelta}` / `message_completed {message}`
  - `tool_started {toolUseId,name,input}` / `tool_progress` / `tool_finished {result}`
  - `permission_requested {requestId, toolName, summary, risk, options}` / `permission_resolved`
  - `question_asked {requestId, question, options}` / `question_answered`
  - `todo_updated {todos}` / `usage {inputTokens,outputTokens,contextUsed,contextLimit}`
  - `compaction_started/finished`
  - `artifact_created {id,title,kind,path}`
  - `error {code, message, retryable}`
- `Session`：`{id,title,workspace,model,createdAt,updatedAt,messages[],todos[],artifacts[],usage,permissionMode}`。
- 会话目录：`<userData>/sessions/<id>.jsonl`（事件追加）+ `<id>.json`（元数据）。项目 = 工作区绝对路径，`<userData>/projects.json` 维护最近项目。

## 4. IPC 契约（`src/shared/ipc.ts`）

- `invoke`（渲染 → 主，均返回 `Result<T> = {ok:true,data}|{ok:false,error}`）：
  - `app.bootstrap` → `{settings, sessions, projects, demo, platform, versions}`
  - `chat.send {sessionId, text, attachments?}`、`chat.cancel {runId}`、`chat.retry {sessionId}`
  - `permission.respond {requestId, decision: 'once'|'always'|'deny'}`、`question.respond {requestId, answer}`
  - `session.create/list/load/rename/delete`、`session.setModel/setPermissionMode`
  - `settings.get/update`、`settings.testProvider {providerConfig}`、`settings.saveKey`
  - `workspace.pick/validate/recent`、`workspace.createDemo`
  - `artifact.open {sessionId, artifactId}`、`artifact.revealInFolder`、`artifact.export`
  - `file.search {root, query}`（@ 引用）、`file.attach`
  - `app.openExternal`、`app.about`、`app.quit`
- `events`（主 → 渲染）：单一通道 `morrow:event`，载荷 `RuntimeEvent`；渲染层以 `runId` 分流。

## 5. Agent 循环（`core/agent.ts`）

```
run(userInput):
  append user message; emit run_started
  loop (maxSteps=60):
    messages = compactIfNeeded(session.messages)
    stream = provider.stream({ system, messages, tools, signal })
    for event in stream:
      text_delta → emit message_delta
      tool_call_start/args_delta/end → accumulate
      usage → emit usage
    if no toolCalls: emit message_completed; break
    append assistant message(with tool calls)
    for call in toolCalls (sequential):
      gate = permissions.check(call, mode)
      if gate == ask: emit permission_requested; await respond (with timeout/cancel)
      emit tool_started; result = tools.execute(call, ctx); emit tool_finished
      append tool_result
  emit run_finished
```

- **中断**：AbortController 贯穿网络与工具；中断时补齐 assistant tool_use 与 tool_result（`[interrupted]`），保证下一轮消息合法。
- **重试**：429/5xx/网络错误指数退避（0.8s/2s/5s，最多 3 次），UI 显示「正在重试」而非报错死亡。
- **压缩**：估算 token（CJK 1 char≈1 token，ASCII 4 chars≈1 token，图片略），超过 `contextLimit * 0.8` 时把较早消息摘要为一条 `system/compact_summary`，保留最近 8 条与所有工具配对完整性。手动 `/compact` 同路径。
- **工具配对完整性**：裁剪只允许在 assistant(tool_use)+tool_result 完整交界处切割，绝不产生孤立 tool 消息（多数 API 会拒绝）。
- **子代理**：`task` 工具创建子 AgentRuntime（共享 provider/tools，`depth+1`，最大 2），执行只读+受限写入，返回摘要；UI 以嵌套活动条展示。
- **演示模式**：`DemoProvider` 实现同一 `Provider` 接口，按剧本逐字流式输出（含工具调用参数），工具真实执行在复制后的 `demo-workspace/`；剧本中的数值由 `collectDemoMetrics()` 从真实 CSV 计算。**演示模式强制 auto 权限**（不弹审批，避免打断首次体验），时长可用 `MORROW_DEMO_SPEED` 调整。
- **手动压缩**：主进程 `chat:compact` 调用 core 的 `compactSession({force:true})`，把返回的 messages 写回会话并 emit `compaction` 事件，UI 的 `/compact` 即此路径。
- **撤销**：写/编辑工具把旧文件备份到 `<userData>/snapshots/<sessionId>/<toolUseId>/<basename>`，`ToolResult.meta` 带 `snapshotPath`；主进程 `file:restore-snapshot` 校验快照在工作区外不可写后还原文件，UI 的「撤销这次修改」即此路径。

## 6. 工具规范（v1）

| 工具 | 参数 | 安全 | 说明 |
|---|---|---|---|
| `read_file` | path, offset?, limit? | 工作区内；二进制检测；≤256KB | 返回带行号内容 |
| `write_file` | path, content | 需审批（询问/自动按模式） | 创建目录；快照旧内容用于撤销 |
| `edit_file` | path, old_string, new_string, replace_all? | 同上；必须唯一匹配 | 返回 diff 摘要 |
| `list_dir` | path, depth? | 只读 | 目录树，跳过 node_modules/.git |
| `glob` | pattern, path? | 只读 | 最多 200 条 |
| `grep` | pattern, path?, include?, ignore_case? | 只读 | JS 实现，跳过二进制/大文件，最多 100 命中 |
| `run_command` | command, cwd?, timeout_ms? | 询问；危险模式拒绝；≤120s；输出≤32KB | Windows 用 PowerShell，其它 bash；sanitized env |
| `todo_write` | todos[] | 无 | 计划面板数据源 |
| `ask_user` | question, options? | 无 | 阻塞等待用户选择，超时/取消安全退出 |
| `remember` | text | 无 | 写入项目 `MEMORY.md`，下次会话注入系统提示 |
| `task` | description, prompt | 子代理规则 | 嵌套 Agent，只读优先 |
| `remember` | text | 无 | 写入 `<workspace>/.morrow/MEMORY.md`，下次运行注入系统提示 |
| `open_artifact` | title, kind, path?/content? | 无 | 注册画布条目（HTML/MD/SVG/代码） |

工具结果统一包成：成功 `{ok:true, output, meta?}`；失败 `{ok:false, error, hint?}`，失败也会回灌给模型自修复。每个工具声明 `category: 'read'|'write'|'exec'|'meta'` 与 `titleFor(input)` 供 UI 展示。

## 7. 权限模型

- 模式：`read-only`（只读工具自动，写/执行直接拒绝并提示切换）｜`ask`（默认；读自动，写/执行询问）｜`auto`（工作区内自动，工作区外与高危命令仍询问）。
- 工作区边界：`realpath` 后必须位于工作区根内；工作区外访问触发「越界审批」，批准仅本次运行有效。
- 危险命令规则：破坏性删除、磁盘格式化、关机/重启、注册表写入、远程脚本执行（curl|iex）、`git push --force`、读取凭据目录等 → 拒绝或强询问（红色风险）。
- 审批请求按 `sessionId + signature` 记忆「本次会话总是允许」。
- 审批卡片必须展示：工具名、人类可读摘要、完整参数（可展开）、风险等级、影响路径。

## 8. 持久化与安全

- `settings.json`：非敏感设置明文；API Key 单条 `safeStorage.encryptString` 后存 base64，按 provider id 区分；若系统不支持则退化为仅本次会话内存保存并明确提示。
- 会话以 JSON 原子写（tmp + rename）持久化；写入失败不会破坏旧文件。
- 文件快照：写/编辑前把旧内容存 `<userData>/snapshots/<sessionId>/<toolUseId>/<basename>`，撤销时还原；本轮结束可「撤销全部文件改动」。
- 测试模式（`--test-mode`）：渲染层暴露 `window.__morrowStore`；provider 指向 `http://127.0.0.1:*` 时允许空 API Key（本地 Mock LLM 专用）；`--skip-onboarding` 可跳过首启引导用于截图/E2E。生产构建不改变行为。
- 路径与密钥不打印日志；日志只写 `<userData>/logs/main.log`，滚动 5MB×3。
- 渲染层：CSP 收紧（connect-src 允许用户配置的模型 API 域名 + `http://127.0.0.1:*` 用于 Mock/本地模型），外部链接一律系统浏览器打开；HTML 产物在 `<iframe sandbox="allow-scripts allow-forms">`（无 same-origin）中预览。

## 8.5 启动器与兼容模式（2026-10-19 补充）

- 本机/受限环境的 Chromium 渲染沙箱会在初始化阶段崩溃（0x80000003）：进程秒退、无窗口，
  连主进程 JS 都不会执行（不会创建数据目录、没有日志），因此无法在应用代码里兜底。
- 交付物通过**启动器**规避：文件夹版的 `Morrow.exe` 是 C# 启动器，启动 `Morrow-app.exe` 时
  自动追加 `--no-sandbox`；单文件版的启动器还会先解压内嵌 zip 到 exe 同级 `.morrow-runtime-<ver>`。
- 安全边界不变：工具工作区沙箱、权限审批、危险命令拦截均在主进程/内核层，与 Chromium 沙箱无关；
  应用只渲染本地内容且无远程页面加载。
- 若未来在沙箱可用的机器上希望重新开启 Chromium 沙箱，可直接运行 `Morrow-app.exe`（兼容入口保留）。

## 9. 构建与打包

- `npm run dev`：electron-vite dev（renderer HMR）。
- `npm run build`：typecheck → electron-vite build。
- `npm run dist:portable`：build → electron-builder `--win portable`，输出 `release/Morrow-<ver>-portable.exe`。
- Electron 二进制镜像：`.npmrc`/脚本设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；electron-builder 二进制镜像 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- 数据目录：`app.setPath('userData', path.join(PORTABLE_EXECUTABLE_DIR, 'Morrow Data'))`（存在该环境变量时），支持 `--data-dir=` 覆盖。
- 版本号：`package.json` + 关于页 + 窗口标题一致；构建时注入 git short sha 与构建时间。

## 10. 测试策略

1. **单元（vitest，无 Electron）**：SSE 解析、Provider 双协议、token 估算与裁剪配对、权限规则、工具（临时目录）、Agent 循环（脚本化 Provider）、会话序列化。
2. **协议集成**：本地 HTTP Mock 同时实现 OpenAI/Anthropic SSE，断言请求体与解析结果。
3. **E2E（Playwright `_electron.launch`）**：`tests/e2e` 共 8 条旅程：窗口骨架、主题、演示模式全流程、权限拒绝、权限允许一次、中断、会话关闭重启恢复、键盘/主题。真实渲染进程 + 真实主进程 + Mock LLM 双协议。
4. **真实冒烟**：`scripts/probe-live.mjs` 用本机 DeepSeek Key 跑 1 轮真实流式 + 1 次工具调用（结果只打印状态与耗时，不打印密钥）。
5. **打包冒烟**：启动便携 exe（Playwright electron 或窗口存活检查 + 截图），完成一次演示。
6. **截图基线**：`docs/verification/screens/` 归档明暗主题关键界面。

## 11. 性能预算

- 冷启动到可交互 < 1.5s（中端 Windows）；首条 token < 1.5s（网络决定，UI 立即出现）。
- 流式渲染 60fps：增量文本按 16ms 合并；代码高亮惰性（完成后或折叠展开时）。
- 500 条消息会话滚动不掉帧：窗口化渲染 + 惰性 Markdown。
- 主进程内存稳态 < 300MB；单个工具输出硬上限截断。
