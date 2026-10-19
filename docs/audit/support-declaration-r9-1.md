# R9.1 支持范围声明（子代理全权限 + 并行，开跑前固定）

生成时间（冻结）：2026-10-19T12:51:33.718Z（engine 全权限+并行完成、Lead 信号后冻结；此后不再修改支持范围）
状态：**已冻结（R9.1 live 开跑前固定，内容未再修改）**
应用版本：1.0.0（不改版本号、不打包 release）

> 用户明确纠正：子代理必须与主代理权限完全一致，不能只读/串行。R9.1 不再把 M43–M47 预登记 UNSUPPORTED；
> M47 的“重启持久恢复”以实际证据为准，若实现缺失，运行后如实记 UNSUPPORTED/INVALID 并说明，不在开跑前缩分母。
> 旧 R9 支持声明/报告保留，作为“只读子代理”旧口径对照，不回填旧成绩。

## M40–M49（10 题，全部支持）

| 题号 | 声明 | 依赖 | 说明 |
|---|---|---|---|
| M40 | ✅ 支持 | subagent | R9.1 子代理与主代理同工具集/权限/审批链；本题由真实子任务读取各自输入，父任务只做汇总写 result；子任务身份以父 task 调用 ID+结果/进度事件归属（产品不单独暴露独立子任务 ID/session） |
| M41 | ✅ 支持 | subagent | 父会话设为只读时，R9.1 子代理权限不得高于父（只读传播）；本题全程无写文件/命令/记忆/MCP |
| M42 | ✅ 支持 | subagent | 两个独立会话/工作根；R9.1 子代理与主代理同权限但不得跨会话注入上下文。产品无独立“上下文审计”事件，隔离结论以产物/会话/事件无 B 标记 + 代码路径核查为证据 |
| M43 | ✅ 支持 | subagent | R9.1 子代理与主代理同权限 + 同消息多 task 并发；本题要求真实并行、子任务各自写 out 文件、父任务写最终 result |
| M44 | ✅ 支持 | subagent/mcp | R9.1 子代理全权限可调用 MCP；父取消必须向在途子任务/工具传播。本题按题库要求只测一个正在运行的真实子任务（产品支持多个时再补 B） |
| M45 | ✅ 支持 | subagent/mcp | 部分支持：子代理可调用 MCP child45_read，B 在 30s 后返回标准 timeout；产品只有工具级 timeout，没有子任务级 2min/20 次预算（题面预算未实现，报告中注明） |
| M46 | ✅ 支持 | subagent/mcp | R9.1 子代理可调用 MCP；child46_read 返回传输成功但 isError=true（validation_error），父子链必须保留真实错误、不重试、不换参数 |
| M47 | ✅ 支持 | subagent/mcp | R9.1 子代理全权限可写 + 可调 MCP；但 engine 已明确子代理运行态不落库（无子任务级持久恢复）。运行后按实际证据记 UNSUPPORTED，不提前缩分母；可另测会话级恢复/幂等查询作为证据，不等同题面中断恢复。 |
| M48 | ✅ 支持 | — | 依赖 R2-A（write_xlsx/edit_docx 授权签名绑定路径+内容）；Harness 以产品审批事件为准，第二次起拒绝/待审批 |
| M49 | ✅ 支持 | mcp | 依赖 R2-E（evidence 拒绝目录/旧文件；只允许本 Goal 新增或修改的产物）；A/B 两场景独立运行 |

**合计**：10 题全部进入支持范围；M47 若实测无持久恢复，按实际证据记 UNSUPPORTED/INVALID，不提前缩分母。

## 实际范围（不扩大权限）

- 子代理：与主代理同工具集（排除嵌套 task；update_goal 仍只主代理），同 permissionMode/mode/工作区/snapshot/MCP/审批链；只读父或 chat 模式子代理仍只读。
- M43：两个真实 task 并行，时间线重叠；子任务各自写 out/a.json / out/b.json；父任务写最终 result。
- M44：父取消向在途子任务/工具传播；t0 后观察 10s/30s 无新 child44_wait、无孤儿；父任务不标完成。单子任务通过不代表多子任务树全部验证。
- M45：child45_read B 在 30s 后返回标准 timeout；父保留 A=7、B=null、total=null，不补 0、不重试。
- M46：子代理保留 child46_read 的真实 isError（validation_error）；父结果 failed/0/validation_error，不重试、不换参数。
- M47：真实中断/重开同一账户，恢复原任务后先查询再幂等登记；只有实际实现持久恢复并通过检查才计 PASS，否则按证据记录。
- 旧 M01–M39 本轮不重跑，不合并成 49 题总分；R2-A—R2-H 机制回归单独计分（8 项，不计入自主能力）。

## 阶段 B 预算与产出

- 真实 DeepSeek：M40–M49 仅一遍，估算 **80–150 次请求**（硬上限另行确认）；M43–M47 若实际能力具备全部消耗请求。
- R2-A—R2-H 用 scripted/本地 mock（0 真实请求），单独报 /8。
- 证据：`tmp/audit/r9-1/live/**`；结果 `docs/audit/r9-1-results.json`；报告 `docs/AUDIT-REPORT-R9.1.md`。
- 需要的 mock 配置：`MORROW_MCP_CONFIG` 指向本地 `morrow_mock`（child44/45/46/47/49）；M45 live 设 `MORROW_MOCK_CHILD45_TIMEOUT_MS=30000`（阶段 A 自检用 50ms）。
