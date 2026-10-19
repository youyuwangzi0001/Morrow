# R9.1 子代理全权限 + 真实并行（交付说明）

> 执行：engine · 2026-10-19 · 任务：task-20（用户明确纠正：子代理权限必须与主代理完全一致）
> 基线：R9 工作树（R9 报告见 `docs/R9-RUNTIME-FIXES.md`）
> 写作用域：`src/core/agent.ts`、`src/core/tools/meta-tools.ts`、`tests/unit/core/**`、本文件；未改 main/renderer/UI/scripts/package.json/release/tests/audit。

## 1. 改动摘要

| 能力 | 实现 |
|---|---|
| **全权限子代理** | 子代理工具集 = 父 RunContext 当前工具集 **减去 `task`**（防嵌套）**减去 `update_goal`**（防篡改父 Goal）；其余工具（read/write/edit/list/glob/grep/run_command/read_pdf/read_docx/read_xlsx/write_xlsx/edit_docx/MCP/web_fetch/todo/ask_user/remember/open_artifact）全部可用 |
| **同一权限链** | 子代理工具调用与主代理共用 `runToolCallWithPermissions`：同一 `evaluatePermission`、`permissionMode`、session mode、工作区沙箱、`snapshotDir`、`sessionGrants`、`onPermission`。子代理的 `permission_requested/resolved` 原样发到父级 UI，用户在主界面审批 |
| **read-only / chat 仍只读** | read-only 权限模式或 chat 会话模式下：子代理写入/命令/MCP 会被权限层拒绝（read-only）或工具集已过滤（chat）；只读/引用旧文件不产生副作用 |
| **真正并行** | 同一 assistant 消息中**连续的多个 `task` 调用**用 `Promise.all` 并发执行；普通工具仍按原顺序串行；任一子任务失败不阻断其他；父 AbortSignal 触发时所有子循环同时取消 |
| **审批串行化** | RunContext 增加 `permissionChain`：并行的多个子代理不会同时挂起多个审批卡（`onPermission` 一次只调一个），通过后再并发执行 |
| **事件归属** | 父 task 调用仍发 `tool_started/tool_finished`（每任务独立 id/计时/结果）；子代理内部工具只发 `tool_progress`（挂到对应父 task 卡片），但权限事件（requested/resolved）保持全局事件流，供父级 UI 审批 |
| **终态与错误** | R9 的 `SubagentResult.status=completed/failed/cancelled/exhausted` 保留；task 工具对非 completed 返回 `ok=false`；子代理内部工具失败/超时/MCP isError 进入 `failedTools` 并出现在父任务结果里，不被文字“完成”覆盖 |
| **系统提示** | 子代理提示词包含「与主代理相同工具与权限、写入/命令/MCP 按父权限审批、不能创建子代理、不能更新父目标」；不再声明“只能只读” |

## 2. 新增/修改测试（tests/unit/core/subagent-parity.test.ts，8 例）

| 用例 | 断言 |
|---|---|
| 工具集一致 | 子代理 provider 收到的 tools 含 read_file/write_file/run_command/mcp_call；不含 task、update_goal |
| 只读父→子只读 | 父 `permission-mode=read-only`；子代理 write_file 被拒、文件不存在、无审批事件、failedTools 保留「只读」原因 |
| ask 父→子写文件 | 子代理写文件触发 1 次 `permission_requested`（toolUseId=子调用 id），允许后真实落盘，父 task success |
| auto 父→子命令 | 子代理 run_command 直接执行（无审批），父 task success |
| 两个 task 并行 | 两个 task 的 `tool_started` 都发生在任一 task `tool_finished` 之前；两个子代理各自写入独立文件（out/a.txt、out/b.txt） |
| 并行审批串行 | 两个子代理同时写文件：`maxActive`（并发 onPermission）恒为 1，两个文件都落盘 |
| 并行审批拒绝 | 两个子代理写文件全部拒绝：文件都不落盘，两个 failedTools 都含拒绝原因 |
| 父 abort 传播 | 两个子代理执行 run_command 长任务，父 abort → run=cancelled，两个 task block 都是 interrupted |

既有 R9 子代理终态测试（`subagent-terminal.test.ts`，4 例）继续覆盖：首步报错 failed、12 步耗尽 exhausted、工具失败保留、父 abort 单任务传播。

## 3. 全量验证

```bash
npm run typecheck    # node + web 0 error
npm run test:unit    # 23 文件 / 313 tests 全绿
npm run build        # 构建成功（E2E 前置）
npm run test:e2e     # 回归结果见交付消息（本轮未改 E2E 用例）
```

## 4. M40–M47 支持面（供 auditor 判分）

| 题 | 结论 | 依据 / 说明 |
|---|---|---|
| M40 子代理真正执行 | **支持（身份证据有限）** | 两个子任务可并行真实调用工具；父任务结果包含两个 task block（父 assistant 的 tool_use id 可作子任务 id）与各自 failedTools。但没有独立子任务事件/child run id，若审计要求「原生子任务 ID + 父子关系事件」可能记部分/INVALID |
| M41 只读限制传播 | **支持** | 只读父任务下子代理写/命令/MCP 被同一权限层拒绝，文件不变；测试覆盖 |
| M42 会话隔离 | **支持（机制）** | 子代理 prompt/systemPrompt 只含显式传入上下文与父工作区；不自动注入其他会话；测试覆盖工具集/工作区，跨会话注入需 auditor 用真实会话核验 |
| M43 并行汇总 | **支持** | 并行子代理可分别写不同产物；测试验证时间线重叠与两个独立文件；同文件覆盖冲突仍由模型分工决定（产品不做锁） |
| M44 取消传播 | **支持（机制）** | 父 abort → signal 贯穿所有子 provider/工具；run_command/MCP 子进程按 signal 终止；测试用 run_command 长任务验证两个子任务同时 interrupted；MCP 取消由工具层 kill，auditor 可用 child44_wait/cancel 复核 |
| M45 超时/部分结果 | **部分支持** | 子代理可调 MCP/命令，工具有自身 timeout（run_command 默认 120s、MCP 工具超时）；子代理终态 failed/exhausted 会带给父任务 failedTools/原因。但**没有「子任务级 2 分钟/20 次调用」独立预算参数**，也没有「子任务已完成部分结果」结构化回传（只有模型文本 summary） |
| M46 MCP isError 传播 | **支持（机制）** | MCP 工具失败以 `ok=false + error` 进入子代理工具结果，并汇总到父 task 的 failedTools；父任务可据此判断失败。最终是否把失败当业务成功仍取决于父模型 |
| M47 重启持久化 | **UNSUPPORTED** | 子代理运行态、授权副作用与中间产物身份不落库；应用重启后不会重放/恢复子任务，也不会把子任务注册状态恢复。可写子代理本身支持，但「重启后副作用一致/可继续」不支持 |

## 5. 残余风险

1. **子代理身份不是一等事件**：只有父 assistant 里的 `tool_use.id` + `tool_progress` note；没有独立 child run id/父子关系事件。M40/M42 若严格要求原生 child id，会被判部分/INVALID。
2. **Goal 预算不统计子代理内部工具调用**：主进程按父级 `tool_started` 计数，一个 task 调用只计 1 次；子代理内部 12 步工具调用不会进入 Goal `toolCalls` 预算（R2 审计「子代理消耗可能没计入」仍部分存在）。父任务 2 分钟/20 次预算同理不含子代理内部步数。
3. **无子任务级超时/预算**：只有父 AbortSignal、provider 请求与工具自身 timeout；M45 的「固定 2 分钟」需审计通过工具 timeout 观察，不能保证产品级硬超时。
4. **M47 重启持久化不支持**：无子任务状态落库、无审计日志可恢复；重启后子代理副作用（若已写入文件）由快照/文件系统保留，但无任务身份可追踪。
5. **并行审批会串行**：`permissionChain` 保证一次只问一个审批；并行任务的工具执行仍并行，但多子任务都需审批时会有排队延迟（安全优先）。
6. **UI 展示**：审批事件使用子调用 toolUseId；渲染层按通用审批卡展示即可。子代理内部工具细节只出现在父 task 卡片的 tool_progress，不单独生成消息气泡（renderer 未改，按现有组件兼容）。
7. **MCP 子进程取消**：MCP 工具层已有 abort/timeout kill 逻辑，但本轮单测用 run_command 长任务代替真实 MCP 取消链路；auditor 仍需用 child44_wait/cancel 实测。

## 6. 兼容性

- `RunAgentOptions` / shared 契约无新增字段；`SubagentResult` 的 status/failedTools 来自 R9。
- 现有单测 313 全绿；E2E 未改用例（回归见交付消息）。
- 子代理工具集在 goal 模式下不含 update_goal，不会篡改父目标；`task` 内不允许再嵌套 task。
