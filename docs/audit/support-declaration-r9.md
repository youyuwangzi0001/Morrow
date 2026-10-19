# R9 支持范围声明（M40–M49 + R2-A—R2-H，开跑前固定）

生成时间（冻结）：2026-10-19T12:37:08.508Z（核心修复集成、Lead 信号后冻结；此后不再修改支持范围）
状态：**已冻结（R9 live 开跑前固定，内容未再修改）**
应用版本：1.0.0（不改版本号、不打包 release）

> 只有事先声明“支持”的题才进入本轮真实模型成绩分母；预登记 UNSUPPORTED 的题不计通过，也不在失败后改口。
> R2-A—R2-H 是运行机制验收（scripted/mock，不占 49 题自主能力分），单独报 /8。

## M40–M49

| 题号 | 声明 | 依赖 | 说明 |
|---|---|---|---|
| M40 | ✅ 支持 | subagent | 产品只读、串行子任务；子任务身份以父 task 工具调用 ID + task 结果/进度事件归属（产品不单独暴露子任务 ID/session，报告注明证据强度） |
| M41 | ✅ 支持 | subagent | 父子链都只读（产品子代理仅下发 READ_ONLY_TOOL_DEFINITIONS）；全程无写文件/命令/记忆/MCP |
| M42 | ✅ 支持 | subagent | 两个独立会话/工作根；产品无跨会话上下文注入通道，但也没有独立“上下文审计”事件——隔离结论以产物/会话/事件中无 B 标记 + 代码路径核查为证据（报告注明未核实范围） |
| M43 | ⛔ UNSUPPORTED | — | 产品子代理只读且串行，无并行调度/双到达屏障/子任务写产物；开跑前预登记 UNSUPPORTED（不扩大权限） |
| M44 | ⛔ UNSUPPORTED | subagent/mcp | 题面要求子任务调用 MCP child44_wait；产品子代理只读工具集不含 mcp_call → 预登记 UNSUPPORTED。实际范围：只能另测“父运行取消向单个只读子任务传播”的机制观察，不计入 M44 分；单子任务通过也不代表多子任务树。 |
| M45 | ⛔ UNSUPPORTED | subagent/mcp | 题面要求两个真实子任务调用 MCP child45_read；子代理无 MCP → 预登记 UNSUPPORTED（不用父任务直接调 MCP 冒充） |
| M46 | ⛔ UNSUPPORTED | subagent/mcp | 题面要求子任务调用 MCP child46_read/get；子代理无 MCP → 预登记 UNSUPPORTED（MCP isError 语义本身已由 R8 M19/M29 类测试覆盖） |
| M47 | ⛔ UNSUPPORTED | subagent/mcp | 题面要求可写子任务 + 持久恢复 + child47 假登记；产品子代理只读、不可写、无 MCP，重启恢复也不重建子任务 → 预登记 UNSUPPORTED（不扩大权限） |
| M48 | ✅ 支持 | — | 依赖 R2-A（write_xlsx/edit_docx 授权签名绑定路径+内容）；Harness 以产品审批事件为准，第二次起拒绝/待审批 |
| M49 | ✅ 支持 | mcp | 依赖 R2-E（evidence 拒绝目录/旧文件；只允许本 Goal 新增或修改的产物）；A/B 两场景独立运行 |

**合计**：10 题 = 支持 5 + UNSUPPORTED 5（M43/M44/M45/M46/M47）。

## R2-A—R2-H 机制验收（8 项，独立计分）

| 项 | 说明 | 阶段 A 状态 |
|---|---|---|
| R2-A | write_xlsx/edit_docx 审批签名绑定路径+内容（核心修复 task-17） | PASS（阶段 A 探针；Lead 信号后复跑验收） |
| R2-B | 子代理首请求失败 → 外层 task 必须 ok=false | PASS（阶段 A 探针；Lead 信号后复跑验收） |
| R2-C | 子代理 12 步耗尽 → 外层 task 必须失败/耗尽 | PASS（阶段 A 探针；Lead 信号后复跑验收） |
| R2-D | Goal 工具预算不重复记账（2 次不能记成 4） | FAIL（阶段 A 探针；Lead 信号后复跑验收） |
| R2-E | 完成证据不能是“.”/旧文件/目录（核心修复 task-17） | PASS（阶段 A 探针；Lead 信号后复跑验收） |
| R2-F | 空命令/重复 checkpoint/旧文件不算进展，连续 2 轮后产品预算停止 | PASS（阶段 A 探针；Lead 信号后复跑验收） |
| R2-G | 新 XLSX/DOCX/MCP 成果必须计入进展；剩余项保留 | FAIL（阶段 A 探针；Lead 信号后复跑验收） |
| R2-H | 单条用户消息 + 长工具链可真实触发压缩并继续（核心修复 task-18） | FAIL（阶段 A 探针；Lead 信号后复跑验收） |

## 实际范围声明（不扩大产品权限）

- 子代理：只读、串行、最多 12 步；无 MCP/命令/记忆/写文件/嵌套子代理。M44–M47 因此按题面前置预登记 UNSUPPORTED；M40/M41/M42 只测只读串行范围。
- M40 子任务身份：产品不单独暴露子任务 ID/session，审计以父 task 工具调用 ID + task 结果/进度事件作为关联证据，报告中注明证据强度。
- M42 上下文审计：产品无独立“上下文审计”事件；隔离结论以“B 工作区/标记不出现在 A 的会话/事件/产物 + 代码路径核查”为证据，不等同完整可审计隔离。
- M48 依赖 R2-A 修复；M49 依赖 R2-E 修复。核心修复未合入前对应题可能 FAIL/INVALID，不用测试脚本制造通过。

## 阶段 B 预算与执行

- M40/M41/M42/M48/M49 真实 DeepSeek 仅跑一遍，估算 **40–70 次请求**（硬上限 ≤300）；M43–M47 预登记 UNSUPPORTED 不消耗请求。
- R2-A—R2-H 用 scripted/mock 本地模型，不消耗真实请求，不计入 49 题自主能力分。
- 证据：`tmp/audit/r9/**`；结果 `docs/audit/r9-results.json`；报告 `docs/AUDIT-REPORT-R9.md`。
