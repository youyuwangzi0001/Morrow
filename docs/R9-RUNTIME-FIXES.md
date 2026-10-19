# R9 核心运行时修复报告（授权范围 / Goal 记账·进展·证据 / 子代理终态）

> 执行：engine · 2026-10-19
> 基线：HEAD `2c7be77`（R8）。本轮按《Morrow审计报告_整理版.txt》第 1–5 项与
> 《Morrow测试题目_整理版.txt》的 R2-A—R2-G、M40–M46/M48/M49 修复。
> 注意：R2-H（单用户长工具链压缩）由 context-compaction 队友负责，本轮**未改** `src/core/context.ts`。

## 1. 修复清单

| 项 | 缺陷（基线行为） | 修复 | 主要文件 |
|---|---|---|---|
| R2-A / M48 | `permissionSignature` 对 `write_xlsx` / `edit_docx` 落到 `${tool}:default`，一次「始终允许」后可换文件/换内容复用 | 文档写工具签名 =「输出绝对路径 + 输入路径 + 参数指纹（stable stringify 后 sha256）」。换路径/单元格/替换文字/输入文档都会重新 ask；预览/越界判断也识别文档工具路径 | `src/core/permissions.ts` |
| R2-D | `flushIncremental` 写入 `base+round`，`afterRun` 又 `+= round` → 2 次变 4 次，预算 3 提前停 | 统一改为 assignment：`mergeGoalUsage(base, round)` 纯函数；flush/轮末/保存/暂停/恢复都走它，同一 base/round 调用任意次结果一致 | `src/main/services/goal-budget.ts`、`agent-service.ts` |
| R2-F | 任何 PRODUCTIVE 工具成功 / checkpoint 重复写 / 引用旧文件都刷新 no_progress | 新增 `GoalProgressTracker`：文件类按「路径 + 内容哈希（afterHash 或 sha256 文件）」首次出现计进展；重复写相同 checkpoint 不计；mtime 早于 Goal 创建时间的旧文件不计；空命令 / 失败 / 只读工具不计 | `goal-budget.ts`、`agent-service.ts`、`src/shared/types.ts`（`Goal.progressKeys`） |
| R2-G | 新 XLSX/DOCX/MCP 成果因工具名不在 PRODUCTIVE_TOOLS 而漏记；所有 MCP 调用又可能被当进展 | 文件类覆盖 `write_xlsx` / `edit_docx` 等（内容哈希变化即进展）；MCP 只对**首次成功的写/登记类**（server+tool+参数签名）计进展，读取/查询类（get/read/list/wait…）与失败不计；web_fetch 按 URL 首次成功计 | 同上 |
| R2-E / M49 | 完成证据只校验「存在」：目录、工作区根 / `.`、Goal 创建前的旧文件、空文件都能通过 | `validateGoalEvidence` 现在拒绝：目录、`.`/工作区根、非普通文件、空文件（0 字节）、mtime 早于 Goal.createdAt 的旧文件；要求本 Goal 期间真实新增或被覆盖更新的非空文件。收尾（max-steps）通道同样校验，不能成为假完成后门 | `src/core/tools/meta-tools.ts`、`agent.ts` |
| R2-B / R2-C / M40–M46 | 子代理首步模型报错或 12 步耗尽时，`runSubagentLoop` 仍返回 summary 占位文本 → task 工具恒 `ok=true` | `SubagentResult` 增加终态 `status: completed/failed/cancelled/exhausted`；首步/中途模型错误=failed，12 步无最终结论=exhausted，空回答=failed；task 工具对非 completed 返回 `ok=false` + 真实原因；子代理工具失败保留在 `failedTools` 并在输出中提示父任务「结论可能不完整」 | `src/core/types.ts`、`agent.ts`、`meta-tools.ts` |
| M43 / M47 | 并行子代理 / 可写子代理 | **UNSUPPORTED（预登记，不扩大权限）**：子代理保持只读、串行、深度 1、最多 12 步；不实现并行与可写子任务 | — |

## 2. 不可变的安全边界

- 子代理仍是**只读 + 串行**：只能 read_file/list_dir/glob/grep/read_pdf/read_docx/read_xlsx/list_skills/read_skill，
  不能写文件、跑命令、写记忆、调用 MCP、再创建子代理。父任务 abort 会传入子循环（`opts.signal` 贯穿 provider/tool）。
- 完成只能靠证据：`update_goal(completed)` 必须给出本 Goal 期间新增/更新的非空文件；目录/旧文件/空文件/`.` 一律拒绝，错误可读且**不更新目标状态**。
- 预算停止不依赖模型自觉：连续无进展达到 `maxNoProgressRounds` 由主进程 `checkBudgets` 暂停并写 `stopReason='no_progress'`，绝不标 completed。
- 授权范围不扩大：文档写工具的一次批准只对「同一路径 + 同一内容/替换参数」有效。

## 3. 单测证据（tests/unit/core）

| 文件 | 覆盖 | 数量 |
|---|---|---|
| `permissions-doc-auth.test.ts` | R2-A：write_xlsx/edit_docx 路径+内容签名稳定/变更；「始终允许」只对完全相同操作生效；换输出/输入/替换文字必须重新 ask | 4 |
| `goal-progress.test.ts` | R2-D：base+round 不翻倍（模拟 flush+afterRun 两次合并）；R2-F：重复 checkpoint、旧文件、空命令、失败、目录不算进展；R2-G：新 XLSX/DOCX 各计一次、MCP 写/登记首次成功计进展而读取/失败不计、web_fetch 去重、持久化恢复不重复计数 | 8 |
| `subagent-terminal.test.ts` | R2-B：首步模型请求报错 → task ok=false 且原因透传；R2-C：12 步耗尽 → exhausted/ok=false/不称成功；M46：工具失败不被“完成”文字覆盖；父 abort 传播 → run cancelled、task interrupted | 4 |
| `goal-evidence.test.ts` | R2-E/M49：目录/`.`/工作区根/旧文件/空文件/缺失文件拒绝；覆盖更新后的旧路径可通过；工具层 update_goal(completed) 同样拒绝；新产物通过并写入 evidence | 5 |

（全部测试文件位于 `tests/unit/core/`，可 `npx vitest run tests/unit/core` 单独复跑。）

## 4. 与 M40–M49 的对应关系（核心侧保证）

- M40 子代理真实执行：existing（只读串行子代理 + tool_progress），本轮修复只在「无结果/失败」时不再假装成功。
- M41 只读限制传入子任务：子代理工具集固定只读；task 工具拒绝在子代理内再嵌套。
- M42 会话隔离：子代理 systemPrompt/prompt 只携带显式传入的上下文，不带其它会话。
- M44/M45/M46：父任务能看到子任务失败终态与失败工具清单（不再被“子助手已完成”文字覆盖）。
- M48：一次批准只绑定具体文档路径+内容。
- M49：旧文件/旧结果不能作为完成证据（A/B 场景的产品侧机制）。

## 5. 已知限制 / 残余风险

1. **run_command 的真实文件变化不计进展**：无法可靠区分「空命令」与「命令确实生成了文件」，为避免空操作续命，本轮选择不计（保守方向：可能让 no_progress 更早触发）。后续可通过命令执行前后工作区快照 diff 增强。
2. **完成证据只验证「真实、新鲜、非空文件」**，不通用校验内容正确性（例如 JSON 字段/报告数值）。M49-A 的 `count/sum` 正确性仍需模型自检；产品无法通用断言任意格式内容。
3. **审批 UI 未改**：本轮只在 core/main 层确保签名细粒度；设置/审批卡如何展示「具体路径与内容范围」由渲染层呈现（不影响拦截正确性）。
4. **agent-service 调度**：`mergeGoalUsage` 与 `GoalProgressTracker` 有纯函数单测；完整「flush→afterRun→续跑→暂停/恢复」需要 auditor 用真实 Goal 链路复测（本轮未跑真实模型/IPC）。
5. **子代理 cancelled 终态**：父任务取消时通常以 AbortError 冒泡 → task 工具结果标记 interrupted；`SubagentResult.status='cancelled'` 的独立返回路径保留给未来「子任务级取消」使用。
6. **M43/M47 UNSUPPORTED**：并行子代理、可写子代理及重启后子任务副作用复用均不实现，不通过扩大权限绕过。
7. **R2-H 不在本轮范围**：由 context-compaction 队友修改 `src/core/context.ts`；与本轮 agent.ts 改动不重叠。
8. **子代理身份不是一等事件**：task 工具只有父消息里的 tool_use id + `tool_progress` note；没有独立的子任务 ID/父子关系事件。
   M40/M42 的「两个真实子任务 ID、按执行者归属的工具记录」可能被审计记为部分支持/UNSUPPORTED，属于契约层设计，
   本轮不扩 shared 事件；M44/M45/M46 的失败/取消/超时终态在父任务结果中可核实。
9. **子代理无独立超时**：依赖父 AbortSignal 与单次模型/工具请求超时；M45 的「子任务 30 秒超时」由本地假工具自身返回
   工具错误来体现，产品没有「子任务级 timeout 预算」参数。

## 6. 验证结果（2026-10-19 R9 收尾时）

```bash
npm run typecheck   # ✅ node + web 0 error
npm run test:unit   # ✅ 22 文件 / 305 tests 全绿（含本轮新增 4 文件 21 例）
```

本轮新增测试可单独复跑：

```bash
npx vitest run tests/unit/core/permissions-doc-auth.test.ts tests/unit/core/goal-progress.test.ts \
  tests/unit/core/subagent-terminal.test.ts tests/unit/core/goal-evidence.test.ts   # 21 passed
```

> 说明：`src/core/context.ts` 与 `compaction-agent.test.ts` 由 context-compaction 队友并行修改
> （R2-H 单用户长工具链），本轮未改它；最终全量单测已包含其最新版本并通过。
