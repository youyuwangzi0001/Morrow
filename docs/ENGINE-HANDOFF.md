# Morrow 内核（src/core）交接说明

> 维护者：engine · 2026-10-19
> 适用版本：Morrow 1.0.0 / M1 内核验收通过（131+ 单元测试 + 双协议 Mock HTTP 集成 + 真实 PowerShell 工具）

`src/core/` 是纯 TypeScript 的 Agent 运行时：**不 import electron / react / DOM**，只依赖 Node 内置模块与
`src/shared/**` 契约，可以脱离桌面独立测试。主进程只通过 `src/core/index.ts` 一个入口使用它。

---

## 1. 公共出口契约（`src/core/index.ts`）

### 1.1 runAgent —— 一次用户输入触发的完整 Agent 循环

```ts
import {
  runAgent, createProvider, testProviderConnection, buildSystemPrompt,
  TOOL_DEFINITIONS, estimateTokens, compactSession,
  clearSessionPermissionGrants
} from '@core/index'

const provider = createProvider(providerConfig, apiKey, modelId)   // demo kind 自动走离线剧本
const result = await runAgent({
  runId, sessionId, provider, model,
  systemPrompt,                  // 传空串则 core 用 buildSystemPrompt 自动生成
  history,                       // 已持久化历史（含此前的 tool_use + result）
  userMessage,                   // 本次用户消息（attachments 已拼成文本）
  workspace,                     // 绝对路径；null = 未绑定（文件工具会给出明确错误）
  permissionMode,                // 'read-only' | 'ask' | 'auto'
  projectMemory,                 // 可选：已包含在 systemPrompt 里时 core 不重复追加
  snapshotDir,                   // 写文件前备份到 <snapshotDir>/<toolUseId>/<filename>
  signal,                        // AbortSignal：中断时优雅收尾
  emit,                          // seq/runId/sessionId/at 由 core 生成
  onPermission,                  // (request) => Promise<'once'|'always'|'deny'>
  onAskUser,                     // (request) => Promise<{value,label,custom?}>
  maxSteps,                      // 默认 60
  demo,                          // true = 演示模式：权限强制 auto、不弹审批
  autoCompact,                   // 默认 true；false 关闭自动压缩（仍可手动 compactSession）
  compactThreshold,              // 自动压缩阈值，0.5–0.98，默认 0.8
  keepRecent,                    // 压缩后保留最近消息数，默认 8
  initialTodos,                  // 可选：会话已有计划（结果合并后回写）
  initialArtifacts,              // 可选：会话已有产物
  goal                           // Goal 模式：Goal | null；仅 status=active 时注入目标提示与 update_goal
})
// result: { reason: 'complete'|'cancelled'|'error'|'max-steps',
//           messages: ChatMessage[]（本轮新增 assistant，tool_use.result 已回填）,
//           usage, todos, artifacts, goal?（更新后的 Goal）, error? }
```

### 1.2 Provider

```ts
interface Provider { stream(req: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent> }

interface ProviderStreamRequest {
  system: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  signal: AbortSignal
  workspace?: string | null   // 仅 DemoProvider 使用
  maxTokens?: number
  temperature?: number
}

type ProviderStreamEvent =
  | { type: 'text_delta'; text }
  | { type: 'thinking_delta'; text }
  | { type: 'tool_call_start'; index; id; name }
  | { type: 'tool_call_delta'; index; argsDelta }
  | { type: 'tool_call_end'; index; id; name; input }
  | { type: 'usage'; usage }
  | { type: 'notice'; level; message }
  | { type: 'demo_step'; index; total; caption }
```

- `createProvider(config, apiKey, modelId?)`：按 `config.kind` 选择 OpenAI 兼容 / Anthropic / Demo。
- `testProviderConnection(config, apiKey?, modelId?, { timeoutMs? })`：短流式探测，返回
  `{ ok, latencyMs, modelCount, message }`（message 是给新手看的中文人话）。
- 重试：429 / 5xx / 网络错误按 0.8s / 2s / 5s 退避，最多 3 次；**只有尚未产出任何内容时才重试**，
  重试前发 `notice` 事件。401/400/404 不重试。
- **工具参数被截断的自修复**：模型输出触达 max_tokens 导致 tool_call 的 JSON 参数不完整时，
  Provider 不再抛错终止整轮，而是以 `tool_call_end.parseError` 返回；Agent 生成一条
  「参数不完整，请拆小内容重试」的工具错误（带 hint）回灌给模型，模型可在下一回合拆分写入。
  System prompt 也引导「大文件分步写（write_file 骨架 + edit_file/run_command 追加）」。
- OpenAI 兼容：支持 `tool_calls` 增量拼接、DeepSeek `reasoning_content`、
  `stream_options.include_usage`；Anthropic：`x-api-key` + `anthropic-version: 2023-06-01`，
  完整 content_block 事件流。
- 内部消息模型把 tool_result 内嵌在 `assistant.tool_use.result` 里；请求转换时再展开成
  协议要求的位置（OpenAI `role:'tool'` / Anthropic `user.tool_result`），**不会产生孤立 tool 消息**。

### 1.3 其它导出

| 导出 | 用途 |
|---|---|
| `TOOL_DEFINITIONS` | 12 个工具的模型 schema（顺序固定，利于 prompt cache），主进程也可用于 UI |
| `READ_ONLY_TOOL_DEFINITIONS` | 子代理可用工具（read_file / list_dir / glob / grep） |
| `toolDefinitionsForRun(goalMode)` | 按运行模式返回工具列表（goal 模式追加 `update_goal`） |
| `GOAL_TOOL_DEFINITION` | `update_goal` 的模型 schema（仅 Goal 模式暴露） |
| `buildSystemPrompt(opts)` | 中文系统提示词；`opts.tools` 缺省时列全部内置工具 |
| `estimateTokens(text)` / `estimateMessagesTokens(...)` | CJK 1 字≈1 token，其它 4 字符≈1 token |
| `compactSession(opts)` | **手动 /compact 入口**（见 §5） |
| `executeTool(name, input, ctx)` | 工具执行统一入口（错误归一化、子代理只读拦截） |
| `evaluatePermission(target, policy)` | 纯函数权限判定（allow / ask / deny） |
| `detectOutsidePathInCommand(command, workspace)` | 识别命令中的工作区外绝对路径（工作区沙箱对 run_command 的补充） |
| `clearSessionPermissionGrants(sessionId)` | 清空某会话的「始终允许」记忆 |
| `collectDemoMetrics(workspace)` / `renderDemoReportHtml(metrics, date)` | 演示数据计算与报告模板 |

---

## 2. 事件时序（RuntimeEvent）

所有事件带 `seq`（每个 run 从 1 递增）、`runId`、`sessionId`、`at`。事件对象是**发出时的快照**
（tool block / message 是拷贝），主进程可安全地延迟序列化或入 JSONL。

```
run_started { userMessage, assistantMessageId }
  ├─ 每个模型回合：
  │   message_started { messageId, role:'assistant' }
  │   message_delta* { textDelta? / thinkingDelta? }
  │   message_completed { messageId, message }        // 含 tool_use block（status='waiting'）
  ├─ 每个工具调用（按模型给出的顺序串行）：
  │   tool_started { block.status='waiting' }
  │   permission_requested { request }                // 仅需要审批时
  │   （await onPermission）
  │   permission_resolved { decision }
  │   tool_progress { status:'running' }              // 允许执行后
  │   tool_finished { result } 或 tool_finished { denied:true } 或 { interrupted:true }
  ├─ todos_updated / artifacts_updated / usage_updated / question_asked / question_answered
  ├─ goal_updated { goal: Goal }                     // 仅 Goal 模式：update_goal 合并后的完整 Goal
  ├─ compaction { phase:'started'|'finished' }        // 自动压缩时
  └─ run_finished { reason, message?, usage }
```

- **审批模式差异**：`read-only` 下写/执行不发审批，直接 `tool_started → tool_finished(denied)`
  （result.error 是人话 + hint 提示切换模式）；`ask`/`auto` 按 §4 规则决定是否弹审批。
- **中断**：AbortSignal 触发后立即停止读取模型流（不依赖 Provider 自觉），给未完成的
  tool_use 回填 `{ok:false, error:'执行已中断', meta:{interrupted:true}}`、status='interrupted'，
  并把当前 assistant 消息标记 `interrupted:true` 后**重发同 id 的 message_completed**
  （渲染层按 id upsert 即可带出状态）。最后 `run_finished(reason:'cancelled')`。
  中断后历史消息仍然合法（每个 tool_use 都有 result），下一轮可直接继续。
- **tool_use id 唯一性**：provider 返回的 tool id 若与历史/本 run 重复（网关复用、剧本回放）或为空，
  Agent 会自动重映射成新的 `call_xxx`。这是**硬保证**，因为快照目录名（`<toolUseId>`）与渲染层
  定位都依赖它；新增 provider/剧本时不要假设 id 天然唯一。
- **max-steps**：最后一轮的工具有效执行完才结束（保证历史合法），并 emit 一条 notice；
  随后再发一次**无工具收尾请求**，让模型基于已完成工作给出最终答复（run_finished.reason 仍是
  `max-steps`，但会话里有一条可读结论，用户可回复「继续」）。
- **usage 与上下文占用（精确口径）**：每次 provider 请求结束时记录该次请求的真实 usage
  （`inputTokens=prompt_tokens`、`outputTokens=completion_tokens`、`cacheReadTokens`）。
  `Usage.contextUsed` 优先取「最近一次请求的 inputTokens + outputTokens」，与 API 账单口径一致；
  只有在 Provider 完全不返回 usage（例如本地模型）时才回退到 `estimateMessagesTokens` 估算。
  流式 usage 可能分多次到达（OpenAI 在末尾一次给；Anthropic `message_start` 给 input、
  `message_delta` 给 output），两种协议均由 Provider 归一化后发给 Agent。
  `usage_updated` 的累计 `inputTokens/outputTokens` 与 `run_finished.usage` 一致；
  run 结束前 Core 会再发一条最终 `usage_updated`，**与 `run_finished.usage` 数值完全相同**。
- **错误**：Provider 错误归一化为 `error` 事件 + assistant 消息的 `error` 字段；run 以 `error` 结束。
  单个工具失败不会终止 run，失败结果会回灌给模型自修复。

---

## 3. 工具（`src/core/tools/`）

| 工具 | category | 要点 |
|---|---|---|
| `read_file` | read | 行号输出、offset/limit、≤256KB、二进制/UTF-16 检测 |
| `write_file` | write | 自动建目录、写前快照、meta 带 beforeHash/afterHash/diff；`append=true` 追加（同样快照 + diff），用于大文件分段写 |
| `edit_file` | write | old_string 必须唯一（或 replace_all）；失败返回可自修复 hint（先 read_file / 加长上下文） |
| `list_dir` | read | 树形（depth≤3），跳过 node_modules/.git/.morrow |
| `glob` | read | 纯 JS；`**`、`*`、`?`、`{a,b}`；无 `/` 的模式按文件名任意层级匹配；≤200 条 |
| `grep` | read | 纯 JS 正则；include 过滤；跳过二进制/>1MB；≤100 命中 |
| `run_command` | exec | Windows PowerShell（UTF-8 输出前缀）、默认 120s/上限 300s、32KB 截断、中断杀进程树、清理敏感 env |
| `todo_write` | meta | 计划面板数据源；id 按位置稳定复用 |
| `ask_user` | meta | 阻塞等待（可被中断），走 `question_asked/answered` |
| `remember` | meta | 追加到 `<workspace>/.morrow/MEMORY.md`；主进程下次运行注入 projectMemory |
| `task` | meta | 子代理：只读工具、深度 1、进度走 `tool_progress`、结果为摘要 |
| `open_artifact` | meta | 注册画布产物；HTML/Markdown/SVG 默认内联内容，emit `artifacts_updated` |
| `update_goal` | meta | **仅 Goal 模式**：active/completed/blocked，合并补丁后 emit `goal_updated`（完整 Goal） |

**沙箱**：所有路径工具走 `resolveWorkspacePath` → `realpath` 后必须位于工作区根内
（Windows 大小写不敏感）；目标不存在时对最近存在祖先 realpath 再拼回，允许 `write_file` 建新文件/子目录。
越界抛 `WorkspaceEscapeError`，由权限层触发「越界审批」；批准后本次调用 `ctx.escapeApproved=true`
才允许访问。**新工具涉及路径必须复用这套逻辑，不要自己拼路径。**

**快照/撤销**：写/编辑前把旧文件复制到 `<snapshotDir>/<toolUseId>/<basename>`，
`ToolResult.meta = { snapshotId: toolUseId, snapshotPath, path, beforeHash, afterHash, diff, ... }`。
撤销 = 主进程按 toolUseId 找到快照还原；core 不负责清理快照（生命周期归主进程）。

**危险命令**：`permissions.detectDangerousCommand()` 覆盖格式化磁盘、关机/重启、注册表写入、
递归删除、`curl|iex`、Base64 隐藏命令、`git push -f`/`reset --hard`、账户/计划任务修改、
凭据目录读取等。命中 → risk=high：read-only 拒绝；ask/auto 强询问，且**不受「始终允许」记忆影响**。

---

## 4. 权限模型（`src/core/permissions.ts`）

| 模式 | 读工具 | 工作区内写/执行 | 越界访问 | 高危命令 |
|---|---|---|---|---|
| `read-only` | 自动 | **拒绝**（提示切换模式） | 询问 | 拒绝 |
| `ask`（默认） | 自动 | 询问 | 询问（high） | 询问（high） |
| `auto` | 自动 | 自动 | 询问（high） | 询问（high） |
| demo | 自动 | 自动 | 自动 | 自动 |
| 子代理 | 自动 | 拦截（registry 兜底） | 拦截 | — |

- 「始终允许」由 `agent.ts` 按 `sessionId + signature` 记忆（进程内 Map），signature 规则：
  路径工具 = `工具名 + 绝对路径`；`run_command` = `工具名 + cwd + 命令首词`。
- 审批卡数据（PermissionRequest）包含：工具名、人类可读 title、summary、risk、完整 input、
  preview（write/edit 是 diff、命令是命令原文、越界是绝对路径）。
- **命令里的工作区外绝对路径**：`run_command` 的 cwd 沙箱挡不住命令本身读全盘
  （例如 `Get-Content C:\Windows\win.ini` 的 cwd 在工作区内）。`detectOutsidePathInCommand()`
  会识别命令中的盘符路径 / Unix 系统目录，命中即提升为高风险审批，auto 模式也不再直接放行。

---

## 5. Goal 模式（多轮自动续跑的内核侧）

多轮循环由主进程负责，内核提供「目标上下文 + update_goal 工具」：

- `RunAgentOptions.goal?: Goal | null`：只有 `status === 'active'` 时启用目标模式；
  paused/completed/blocked 不注入提示段与工具（`RunAgentResult.goal` 仍回显传入值）。
- **系统提示**：`buildSystemPrompt({ goal })` 注入 `## 目标模式` 段（目标、第 x/y 轮、上一轮 summary、
  nextStep、每轮行为规范）。主进程若自己构建了 systemPrompt 且缺少该段，Agent 会自动补上
  （`buildGoalPromptSection(goal)` 也可单独调用）。
- **工具列表**：`TOOL_DEFINITIONS` 仍是 12 个基础工具；Goal 模式通过
  `toolDefinitionsForRun(true)` 追加 `update_goal`（category=meta，不触发审批）。
- **update_goal 工具**：input `{ status: 'active'|'completed'|'blocked', summary?, nextStep?, blockedReason? }`，
  required `['status']`。执行时用当前 goal 合并补丁（updatedAt、completed 时 completedAt；
  blocked 记录 blockedReason、非 blocked 清除），emit `goal_updated` 完整 Goal，
  返回「目标状态已更新：进行中（第 2/5 轮）」这类可读结果。非法 status / blocked 缺原因返回错误结果
  （不抛异常、不打断本轮）。max-steps 的收尾请求同样暴露 update_goal 并应用补丁。
- **ToolContext 扩展**：`goal: Goal | null`、`emit(eventPayload)`、`updateGoal(patch)`；
  普通工具不受影响，permissions 对 meta 工具依旧自动放行。
- **事件形态**：`{ type: 'goal_updated', goal: Goal, seq, runId, sessionId, at }`（shared 契约，
  goal 永远是完整 Goal 快照；清空目标由主进程自行处理）。
- 主进程职责：把 `goal` 传入 RunAgentOptions、在 goal_updated 后落库、按 `result.reason` 与
  goal.status 决定是否继续下一轮（续跑用户消息以「（目标模式 · 第 N/M 轮续跑）」开头）。

## 6. 上下文压缩

- 自动压缩开关与参数：`RunAgentOptions.autoCompact`（默认 true）、`compactThreshold`（0.5–0.98，默认 0.8）、
  `keepRecent`（默认 8，会被 clamp 到 2–50）；`autoCompact=false` 时完全跳过自动压缩（手动仍可用）。
- 估算超过 `model.contextWindow * compactThreshold` 时自动压缩；切割点只选 user 消息边界
  （Anthropic 要求首条 user；内部 tool_result 内嵌在 assistant 里，按消息边界切割天然安全）。
  保留最近 8 条，向前扩展到最近的 user 消息；若当前轮太长找不到安全切割点，只 emit notice 不压缩。
- 摘要用同一个 Provider 额外发一次「压缩器」请求（不带工具、max_tokens≈1200）；失败则用
  `localExtractSummary` 本地兜底，对话继续。
- **手动 /compact**：主进程可直接调用

  ```ts
  const result = await compactSession({
    provider, model, systemPrompt,
    messages: session.messages,     // 完整历史
    signal,
    force: true,                    // 手动压缩：未到阈值也压
    keepRecent: 8,                  // 可选：默认 8
    threshold: 0.8                  // 可选：0.5–0.98，默认 0.8（force=true 时不影响）
  })
  // result: { messages（替换后的完整数组）, compacted, savedTokens, summary?, error?, reason? }
  ```

  主进程拿到 `result.messages` 后自行持久化（写回 session），并可按需 emit
  `compaction started/finished` 事件给渲染层。core 不修改传入的 messages。

---

## 7. 演示引擎（`src/core/providers/demo.ts`）

- `DemoProvider` 实现同一 Provider 接口；Agent 循环普通地消费流事件，不知道是剧本。
- 9 个剧本回合、12 次**真实**工具调用（list_dir / read_file / run_command×3 / grep / write_file /
  todo_write×3 / open_artifact），报告数字由 `collectDemoMetrics()` 读取工作区 CSV 真实计算，
  与 PowerShell 聚合结果一致；数据文件缺失时退回内置基准数据（演示不会失败）。
- 播放速度：`MORROW_DEMO_SPEED`（1 = 约 36 秒，0.05 = E2E 秒播，0 = 测试不等待）。
- 报告 `分析报告.html`：单文件自包含（内联 CSS/SVG，无外链、无 `<script>`、无 `@import`），
  石墨底 + 香槟金 + 衬线标题 + KPI 卡 + SVG 条形图 + 数据问题清单 + 3 条建议。
- 演示工作区文件名与口径见 `docs/PLAN.md` / delivery 的基准；口径：去重、剔除退款、按金额列汇总。
  环比的精确值是 +18.4453%，报告四舍五入显示 **+18.45%**。

---

## 8. 已知限制

1. **压缩历史不写回会话**：自动压缩只影响本 run 内的模型上下文；会话持久化历史保持原样。
   如需「压缩后永久变短」，主进程调用 `compactSession` 后写回。
2. **手动 /compact 需要主进程接 IPC**：core 已提供 `compactSession`，桌面端入口由 Lead 决定是否接。
3. **子代理 usage 不并入父 run**：`task` 的 meta 里返回子代理 steps/usage，父 run 的 usage 只统计主回合。
4. **上下文条**：有真实 usage 时精确（最近一次请求 input+output）；Provider 不返回 usage 时是估算，
   两者会在 UI 上通过 `contextUsed` 体现，不额外区分来源。
5. **`open_artifact` 是追加语义**：每次调用产生新 artifact id；同标题多次调用会出现多条产物。
   主进程做去重/更新时按 title 或 path 合并。
6. **SSE 坏帧容错为「跳过」**：单帧 JSON 解析失败会丢弃该帧（防止整条流崩掉），极端情况下可能丢一小段文本。
7. **模型单次输出长度仍是硬限制**：超长内容触达 max_tokens 时工具参数会不完整；现在 Agent 会
   返回可自修复错误并提示拆分重试，但需要模型配合（prompt 已引导分步写文件）。真·超大单文件产物
   仍建议由 run_command 脚本生成，而不是让模型一次输出。
8. **Anthropic 未启用 extended thinking**：thinking block 不会回传给 API（当前请求参数未开启 thinking，无影响）。
9. **run_command 只适合非交互命令**：PowerShell 5.1 下没有 TTY；需要交互的工具请改用脚本参数化。
10. **快照无保留策略**：快照目录会随会话增长，清理/过期由主进程决定。
   `write_file` 的 append 与覆盖都会生成快照（按 toolUseId 目录），撤销语义一致。
11. **审批「始终允许」记忆在进程内**：Morrow 重启后清空；如需持久化由主进程接 settings 存储。

---

## 9. 测试与验证

```bash
npm run typecheck   # node + web 全仓 0 error
npm run test:unit   # tests/unit/**（engine 的 core 测试在 tests/unit/core）
npm run test:e2e    # delivery 的 Playwright 旅程（演示/权限/中断/恢复/主题）
```

- 单元测试覆盖：SSE 解析、双协议请求体/流事件、重试、权限规则（36 例）、12 个工具（含真实
  PowerShell 执行/超时/截断/快照）、Agent 循环（审批允许/拒绝/始终允许、中断、max-steps、
  子代理、自动压缩 + 本地兜底）、Demo 全剧本、公共出口契约。
- 协议集成：`tests/unit/core/agent-http.test.ts` 用 `tests/unit/core/helpers/mock-llm.ts`
  起本地 HTTP SSE，跑通 OpenAI/Anthropic 两套「带工具调用的完整 run」，日志写到
  `tmp/verify/mock-run-*.log`。
- 演示数据库测试用 `assets/demo-workspace/` 的副本跑真实工具链（不改源资产）。

新增测试约定：
- 单测放 `tests/unit/core/*.test.ts`，禁止依赖 Electron；
- Provider 测试优先用 `tests/fixtures/mock-llm.mjs`（delivery 维护）或
  `tests/unit/core/helpers/mock-llm.ts`（engine 的精简版）；
- 工具测试用 `helpers/workspace.ts` 的临时目录/快照目录，用完 `cleanup()`。

---

## 10. 给后续维护者的注意事项

1. **改事件契约要三处同步**：`src/shared/types.ts`（Lead 作用域）→ `src/core/agent.ts` 发射点 →
   `src/renderer/src/state/store.ts` 归约。core 里 `EmitPayload` 类型会在编译期兜住事件字段。
2. **新工具**：在 `tools/*.ts` 实现 `ToolImpl`（definition + execute）→ 加到 `tools/registry.ts`
   的 `ALL_TOOLS`（顺序影响 prompt cache）→ 契约测试 `tests/unit/core/index.test.ts` 会校验工具清单；
   涉及路径必须用 `resolveWorkspacePath`，写操作必须 `snapshotFile`。
3. **新 Provider 协议**：实现 `Provider`，用 `streamWithRetry` 包一层（未产出内容才重试），
   把 token 用量映射成 `Usage`（input/output/cacheRead），在 `providers/index.ts` 的 `createProvider` 注册。
4. **不要破坏的边界**：core 不 import electron/react；工具执行统一走 `executeTool`（否则丢失错误归一化
   与子代理只读拦截）；事件必须是快照（`cloneMessage`）而不是活对象。
5. **演示报告数字**：必须来自 `collectDemoMetrics`（或与 delivery 基准对齐），修改剧本时同步更新
   `tests/unit/core/demo.test.ts` 的基准断言；报告禁止引入外链资源（E2E 会检查自包含性）。
6. **性能**：grep/glob 有扫描上限，新增遍历逻辑记得带上限与二进制/大文件跳过；
   run_command 输出硬上限 32KB，不要在 UI 侧期待更多。
7. **新会话状态**：如果 core 需要新的会话级输入（比如附件图片），走 `RunAgentOptions` 的附加可选字段，
   并同步本文件与 `src/main/services/agent-service.ts`。

---

## 11. R8 新增：文档工具与技能发现（2026-10-19）

详细设计/限制/证据见 **`docs/DOCUMENT-TOOLS.md`**，这里只记维护者需要知道的内容。

### 11.1 新增工具（7 个，core → registry 自动生效）

| 工具 | category | 说明 |
| --- | --- | --- |
| `read_pdf` | read | PDF 文本抽取（分页/页码），无文字/扫描件明确报错，不做 OCR |
| `read_docx` | read | Word 正文（标题/段落/表格）+ `{{占位符}}` 清单 |
| `edit_docx` | write | 复制 DOCX 并替换占位符（跨 run），输入文件不动；输出必须为新 `.docx` |
| `read_xlsx` | read | Excel 表格 + 公式/缓存值，支持 sheet/range |
| `write_xlsx` | write | 生成 XLSX；`"="` 开头字符串写真公式 `<f>` + 缓存值 + `fullCalcOnLoad` |
| `list_skills` / `read_skill` | read | 工作区技能发现/读取（SKILL.md） |

- 文件：`src/core/tools/pdf-tools.ts`、`docx-tools.ts`、`xlsx-tools.ts`、`xlsx-formula.ts`（保守公式求值器，
  只用于写缓存值，不参与业务计算）、`skills.ts` / `skills-tools.ts`；
- `registry.ts`：`BASE_TOOLS` 里按「文件 → 文档 → 搜索 → 命令 → 技能 → meta」顺序插入，`update_goal` 逻辑未动；
  读工具自动进 `READ_ONLY_TOOL_DEFINITIONS`（子代理/聊天模式可用），写工具被 `readOnly` 拦截；
- `executeTool` 现在也会透传 `ToolExecutionError.hint`（此前只透传 `ToolInputError`），文档解析失败时模型能看到
  「可能损坏/加密/扫描件」这类可行动提示；
- `prompt.ts`：新增「文档类文件用专用工具」两条工具指引 + 自动追加「## 可用技能（工作区发现）」段
  （只列 name/description/路径，正文要求模型先 `read_skill`，且声明技能正文不是授权）。

### 11.2 依赖（生产依赖，Lead 打包时注意）

- `dependencies` 新增 `jszip@^3.10.1`、`pdf-parse@^1.1.1`（均为纯 JS，`externalizeDepsPlugin` 只外部化
  production deps，electron-builder 自动打包 node_modules；`npx electron-vite build` 已验证
  `out/main/index.js` 保留 `require("jszip")` / `require("pdf-parse/lib/pdf-parse.js")`）；
- 从 `pdf-parse/lib/pdf-parse.js` 导入（不要用包入口 `index.js`：其 `!module.parent` 调试分支会读测试 PDF）；
- **体积**：pdf-parse 内置 4 个 pdf.js 版本共 ≈31.8MB，运行时只用 `v1.10.100`；建议 Lead 在 `build.files`
  排除 `v1.9.426 / v1.10.88 / v2.0.550`（≈省 21MB 解包体积），规则见 DOCUMENT-TOOLS.md §2。

### 11.3 测试（R8 当前全仓 267 例通过）

- `tests/unit/core/document-tools.test.ts`（22 例）+ `tests/unit/core/skills.test.ts`（10 例）；
- 真实二进制夹具 `tests/unit/core/fixtures/documents/`（python-docx/openpyxl 生成 + LibreOffice 导出 PDF，
  含 `manifest.json` sha256 校验与 `make_fixtures.py` 再生成脚本）；**不要手改夹具二进制**，改脚本后重跑生成；
- 离线证据：`npx vite-node tests/unit/core/fixtures/documents/make_evidence.ts` 生成
  `tmp/doc-evidence/`（M09/M11/M12 工具结果与产物），再用
  `tests/unit/core/fixtures/documents/verify_evidence.py` 以 openpyxl/python-docx + LibreOffice 重算独立校验
  （M09 D4=21、M11 结构/输入不变、M12 37≠38 全 PASS）。

### 11.4 已知限制（不要当已支持）

PDF 无 OCR/加密不支持；DOCX 仅 `.docx`（不支持旧 `.doc`、文本框复杂结构会安全报错）；XLSX 仅 `.xlsx`
（不支持旧格式/宏/图表/样式还原，日期按序列值，跨表公式无缓存值但公式保真）；技能只发现「目录 + SKILL.md」，
不执行技能脚本、无应用内置技能包。完整清单见 `docs/DOCUMENT-TOOLS.md` §6。

