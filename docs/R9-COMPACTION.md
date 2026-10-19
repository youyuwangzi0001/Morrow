# R9 上下文压缩修复：单用户长工具链安全切点（R2-H / 审计报告第 5 项）

> 执行：delivery（代 context-compaction）· 2026-10-19 · 基线 HEAD `2c7be77`
> 写作用域：`src/core/context.ts`、`tests/unit/core/**`、本文件。**未修改 `src/core/agent.ts`**（core-runtime 队友正在改，避免冲突；现有调用签名保持兼容）。

## 1. 问题（审计报告第 5 项 / 题库 R2-H / M37）

旧 `planCompaction` 只允许在 **user 消息边界**切割：

```ts
let cutIndex = Math.max(0, messages.length - keepRecent)
while (cutIndex > 0 && messages[cutIndex]?.role !== 'user') cutIndex -= 1
if (cutIndex <= 0) return { reason: 'no-safe-cut' }
```

当会话是「**单条用户消息 + 多轮工具调用/结果**」时，数组中只有一个 user（index 0），
向回找边界会一路退到 0 → 永远 `no-safe-cut`，即使 token 已远超阈值也无法压缩（M37 INVALID、R2-H 无法真实触发）。

## 2. 修复（`src/core/context.ts`）

### 2.1 安全切点：完整「模型动作 + 工具结果」之后即可切

内部消息模型把 `tool_result` 内嵌在 `assistant.tool_use.result`（provider 层再展开成 OpenAI tool 消息 / Anthropic tool_result block），
因此**按整条消息切割天然不会切出孤立的 tool_use / tool_result**。新的切点：

- 目标位置 = `messages.length - keepRecent`；
- 从目标位置向前找最近的整消息边界（`user` 或 `assistant` 均可，`system` 摘要消息不作为切点）；
- 返回 `cutKind: 'user' | 'tool-pair'` 便于观测与断言；
- 存在未回填结果的 `tool_use`（动作进行中）→ 拒绝压缩（防御）；
- 保留段若含 dangling tool_use → 拒绝压缩（二次防御）；
- 被裁掉的全是历史摘要（没有新消息）→ 拒绝「摘要的摘要」；
- 省不下 token（`savedTokens <= 0`）→ `no-safe-cut`。

### 2.2 保留原始用户约束与当前请求

`applyCompaction` 现在会把以下消息放在 system 摘要之后、保留段之前（时间顺序）：

1. `messages[0]` 若是 user：**始终保留**（任务目标、禁止外发、预算等约束不应被摘要掉）；
2. 若切点落在某个工具回合中途（保留段以 assistant 开头）：把被裁掉段的**最后一个 user 消息**也保留，
   保证压缩后模型仍知道「当前在做什么」。

新增 `CompactionPlan.preserveCount` 记录额外保留条数；`keepCount` 含这部分。
`agent.ts` 调用 `applyCompaction(messages, plan.cutIndex, summary)` 无需改动，自动获得上述行为。

### 2.3 与 provider 协议的兼容

- OpenAI：`toOpenAIMessages` 由 assistant.tool_use 生成 `tool_calls` + 紧随其后的 `tool` 消息；整消息切割后配对完整；
- Anthropic：首条消息必须是 user；`applyCompaction` 保证摘要后第一条是保留下来的原始 user 消息；
  provider 侧原本就有「合并同类角色 + 补首条 user」的规范化（`toAnthropicMessages`）；
- 摘要 system 消息在两种协议下都会被并入 system prompt（provider 既有逻辑）。

## 3. 实测证据（R2-H 端到端）

测试：`tests/unit/core/compaction-agent.test.ts`（真实 `runAgent` + 真实 `read_file` 工具 + 脚本化 provider）。

场景：一条用户消息（含「只读 / 不写文件 / 禁止外发」约束）→ 真实读取 3 组长文本（value=4/7/9）→ 触发压缩 → 继续读 notes.txt → 最终合计 20。

关键指标（一次完整运行，脚本输出 `R2H_EVIDENCE_JSON`）：

| 指标 | 值 |
|---|---|
| 模型上下文窗口 / 压缩阈值（80%） | 2400 / **1920 tokens** |
| 初始请求估算 tokens | 62 |
| 压缩前「下一步请求」若未压缩的估算 | **7838 tokens**（> 阈值 1920） |
| 压缩后下一步请求估算 | **5336 tokens**（比未压缩 ↓ 31.9%） |
| 压缩事件 | **2 次真实压缩**（started+finished 各 2，savedTokens = **2502 / 2592**） |
| 压缩后消息结构 | `system(text)`（摘要）→ `user(text)`（原始约束原文）→ `assistant(tool_use)` → `assistant(tool_use)` |
| 保留的最近工具结果 | `value=7`、`value=9` 的真实 `read_file` 结果仍在保留段 |
| 原始约束原文 | 「逐段只读 in/m1.txt、…；不写文件、不保存记忆、禁止外发。」完整保留 |
| dangling tool_use | false（压缩后无未回填工具） |
| OpenAI / Anthropic 序列校验 | 均通过（tool_calls ↔ tool 配对；首条 user；无孤立 tool） |
| 压缩后继续执行 | 继续调用 `read_file(in/notes.txt)` 成功回填（发生在第一次压缩之后） |
| 真实读取值 / 最终答案 | 观察到 4、7、9；最终「value 合计 **20**」 |
| 全程工具 | 仅 `read_file`（无写文件/记忆/命令/外发） |
| provider 调用次数 | 7（5 次主请求 + 2 次摘要请求） |

> 说明：本场景 keepRecent=2 且最近工具结果本身很大，因此第二次请求仍超过阈值 → 触发第二次真实压缩（自限：被裁掉段只剩摘要时会被拒绝）。这验证了「压缩后可继续」，也暴露了「连续压缩」的边界，见 §5。

## 4. 测试与回归

新增：

- `tests/unit/core/compaction.test.ts`（6 例，直接验证 plan/apply）：
  单用户长工具链切分（cutKind=tool-pair）；压缩后约束/最近结果保留 + token 变短 + 双协议合法；
  切点落在后续回合中途时同时保留首条约束与当前用户请求；dangling 拒绝；历史过短拒绝；keepRecent=1 合法。
- `tests/unit/core/compaction-agent.test.ts`（1 例，R2-H 端到端，见 §3）。
- `tests/unit/core/helpers/compaction-validators.ts`（OpenAI/Anthropic 序列合法性断言，供复用）。

更新旧测试（行为变化：压缩后多保留原始用户消息）：

- `context.test.ts`：「在 user 边界切割」断言补充 `cutKind/preserveCount`；
  「历史全在当前轮拒绝压缩」改为「单用户长工具链可以在 assistant 边界切」；
  `applyCompaction` 期望长度 2 → 3（摘要 + 原始 user + 保留段）。
- `agent.test.ts`：keepRecent 压缩后消息数 4 → 5（摘要 + 原始用户消息 + 保留 2 条）。

**验收命令（本机真实结果，2026-10-19 20:34）**：

```bash
npm run typecheck   # exit 0（tsc node + web 均无错）
npm run test:unit   # exit 0：22 files / 305 tests 全绿
```

本任务相关子集：

```bash
npx vitest run tests/unit/core/compaction.test.ts tests/unit/core/compaction-agent.test.ts
# 2 files / 7 tests passed
npx vitest run tests/unit/core/context.test.ts tests/unit/core/agent.test.ts
# 2 files / 40 tests passed
```

## 5. 残余风险与限制

1. **连续压缩**：若 keepRecent 条最近消息本身的体量仍超阈值，会在后续步再次压缩；实现上有「全摘要不压」与「省不下不算」护栏，不会无限空转，但可能出现多次摘要（R2-H 场景实测 2 次，均为真实压缩、每次减小）。若需要更强抑制，可在产品层加「压缩后 N 步冷却」，本轮未做（避免改 agent.ts）。
2. **单条超大 assistant 消息不可再分**：切点只能落在消息之间；若单条消息自身超过窗口，压缩无法把它变小（内部模型一条 assistant 消息可能含多个 tool_use）。这是模型输出上限问题，不是切点问题。
3. **摘要质量依赖摘要模型**：摘要失败时回退本地摘要；原始用户消息仍被保留，故约束不丢，但细节可能简化。
4. **保留原始用户消息会增加少量 token**：极端情况下（首条 user 极长）可能导致 `savedTokens<=0` 而不压缩；行为保守（宁可不压也不丢约束）。
5. **估算口径**：阈值判断使用本地 token 估算（CJK≈1/字符、ASCII≈1/4），与 API usage 有偏差；`currentUsage` 展示仍优先真实 usage，压缩判定本轮未改为真实 usage（避免依赖 provider usage 时序）。
6. **R2-H 产品级验收未跑真实模型**：本次是「脚本化 provider + 真实 Agent 调度/工具执行」的机制验证（符合 R2 附录规则）；真实模型能力验证由 auditor/Lead 后续按 R2-H 题面执行，本文件不把它计入自主能力分。
7. **未修改 agent.ts**：压缩调用点、摘要 prompt、事件均保持原样；下游 `session.compact` IPC / main 持久化未在本任务验证（超出写作用域）。
