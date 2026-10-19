# R7/R8 审计证据与可复跑 Harness

本目录保存 **R7 安全/Goal 审计**与 **R8 全量 39 题审计**的可复跑测试与真实运行证据。
总报告：`docs/AUDIT-REPORT-R7.md`（R7）、`docs/AUDIT-REPORT-R8.md`（R8，阶段 B 后生成）。

## R8 全量 39 题（阶段 A 已就绪）

| 路径 | 内容 |
|---|---|
| `../../tests/audit/r8/specs.ts` | 39 题唯一事实来源：prompt / ask_user 答案 / 依赖能力 / fixtures / checker / 长期任务编排 |
| `../../tests/audit/r8/runner.ts` | Phase A 离线自检（fixtures/mock/spec/checker/支持声明）+ Phase B live 入口（Lead 信号后解锁） |
| `../../tests/audit/r8/full39.test.ts` | 一键入口：`npx vitest run --config tests/audit/vitest.config.ts tests/audit/r8/full39.test.ts` |
| `../../tests/audit/r8/live-runner.ts` | 阶段 B live runner（AgentService 真实运行路径、fetch 请求硬上限 400、逐题证据落盘、结果增量写 `live-full-39.json`） |
| `../../tests/audit/r8/plumbing.test.ts` | 阶段 B 管路自检（本地 mock SSE，零真实请求）：验证 AgentService→产品工具→checker→结果 JSON 全链路 |
| `../../tests/audit/r8/feature-probe.test.ts` | 新功能离线联调探针（scripted provider 驱动产品真实工具完成 12 题检查） |
| `../../tests/audit/r8/py/` | 夹具生成/校验、DOCX/XLSX 校验、M13 隐藏测试（DSH 自带 Python） |
| `../../tests/audit/r8/mocks/morrow-mock-mcp.mjs` | 标准 MCP JSON-RPC stdio 假服务（list_items/温度转换/工单/慢任务/伪授权/goal39 等） |
| `support-declaration-r8.md` | **开跑前固定**的支持范围声明（39 题逐题声明 + 能力声明 + live 前置条件） |
| `logs/r8-phase-a.json` / `logs/r8-phase-a.log` | 阶段 A 自检结果与日志 |
| `live-full-39.json` | 阶段 B 真实 39 题结果（待 Lead 信号后生成） |

R8 阶段 A 命令（零真实费用、不读 Key）：

```bash
npx vitest run --config tests/audit/vitest.config.ts tests/audit/r8/full39.test.ts
```

## R10 功能验收（A–I、K；J 不做）

| 路径 | 内容 |
|---|---|
| `r10-verification-matrix.md` | 65 条功能/安全验收矩阵（文件树/编辑器/浏览器/MCP/技能/记忆/Projects/搜索/computer-use + 跨领域） |
| `r10-preparation.md` | 准备阶段报告（fixtures/mock/自检/执行计划/预计时间/依赖） |
| `../../tests/audit/r10/py/build_fixtures.py` | 中文/二进制/大文件/只读/冲突/旧记忆/恶意 zip/跨工作区 fixtures |
| `../../tests/audit/r10/mocks/browser-server.mjs` / `mcp-http-sse.mjs` | 本地浏览器 HTTP / MCP HTTP+SSE mock |
| `../../tests/audit/r10/phase-a.test.ts` | 一键零费用准备自检 |
| `../../tests/e2e/r10-audit.spec.ts` | 跨领域 E2E 骨架（`R10_ACCEPTANCE=1` 后执行） |
| `logs/r10-phase-a.json` / `.log` | 准备自检证据 |
| `AUDIT-REPORT-R10.md` | R10 最终验收报告（功能 63 PASS/2 NOT_RUN；UI 文案最终复审 PASS；完整 64 PASS/2 NOT_RUN） |
| `logs/r10-final.log`、`r10-full-e2e.log`、`r10-audit-e2e.log` | 最终验证/全量 E2E/审计独立 E2E 日志 |

准备自检命令（零费用）：
```bash
npx vitest run --config tests/audit/vitest.config.ts tests/audit/r10/phase-a.test.ts
```

## R9.1 子代理全权限 + 并行（M40–M49 补测准备）

| 路径 | 内容 |
|---|---|
| `../../tests/audit/r9-1/specs.ts` | M40–M49（全部支持；M43–M47 新 checker：并行时间线/取消传播/超时部分结果/isError/重启幂等） |
| `../../tests/audit/r9-1/phase-a.test.ts` | 零费用自检：reference checker + mock child44/45/46/47 语义 + 声明草案 |
| `../../tests/audit/r9-1/live-runner.ts` / `live.test.ts` | R9.1 真实 M40–M49 单遍（等 Lead 信号；M44 特殊取消、M47 重启恢复） |
| `support-declaration-r9-1.md` | R9.1 开跑前支持声明草案（全部支持；M47 实测持久恢复，不提前缩分母） |
| `logs/r9-1-phase-a.json` / `.log` | 阶段 A 自检 |
| `r9-1-results.json` / `AUDIT-REPORT-R9.1.md` | R9.1 真实单遍结果与报告（M40–M49；旧 R9 保留对照） |
| `logs/r9-1-live.log` / `logs/r9-1-mechanism.json` | R9.1 真实运行日志与机制 8/8 回归 |

阶段 A 命令（零真实费用）：
```bash
npx vitest run --config tests/audit/vitest.config.ts tests/audit/r9-1/phase-a.test.ts
```

## R9 新增能力题 M40–M49 + 机制验收 R2-A—R2-H

| 路径 | 内容 |
|---|---|
| `../../tests/audit/r9/specs.ts` | M40–M49 十题 spec（5 支持 / 5 预登记 UNSUPPORTED：M43–M47），fixtures/prompt/checker |
| `../../tests/audit/r9/mechanisms.ts` | R2-A—R2-H 八项机制探针（scripted / 本地 mock SSE 驱动真实产品调度，不占自主能力分） |
| `../../tests/audit/r9/phase-a.test.ts` | 阶段 A 一键离线自检（零费用）：spec/fixtures/checker/mock/支持声明/机制状态 |
| `../../tests/audit/r8/mocks/morrow-mock-mcp.mjs` | 扩展 child44_wait/cancel、child45_read、child46_read/get、child47_register/get、child49_build |
| `support-declaration-r9.md` | R9 开跑前固定的支持范围（草案，核心修复完成/Lead 信号后冻结） |
| `logs/r9-phase-a.json` / `.log` / `r9-mechanism-probe.json` | 阶段 A 自检与机制探针状态 |
| `r9-results.json` / `AUDIT-REPORT-R9.md` | 阶段 B 产出（待 Lead 信号） |

阶段 A 命令（零真实费用）：
```bash
npx vitest run --config tests/audit/vitest.config.ts tests/audit/r9/phase-a.test.ts
```

## R7 审计

| 路径 | 内容 |
|---|---|
| `../../tests/audit/security.test.ts` | 离线安全审计（只读 remember/写入/命令、符号链接越界、命令参数授权、撤销冲突、secrets 不降级、提示词不可信内容） |
| `../../tests/audit/goal-long-run.test.ts` | Goal 长期任务最小复现（本地 mock SSE 模型 + 产品原生 AgentService 循环：>10 轮、暂停/重启恢复、cancelled、no_progress、谎报完成被拒、智能轮次预算） |
| `../../tests/audit/live-capabilities.test.ts` | R7 真实 DeepSeek 能力题（**默认 skip**，需 `MORROW_LIVE=1`，会产生真实费用） |
| `../../tests/audit/helpers.ts` | 隔离目录、工具上下文、本地 mock SSE 服务、假窗口/设置、等待工具 |
| `../../tests/audit/mocks/electron.ts` | 审计环境 electron 替身（只提供 app.getPath，数据目录指向 tmp/audit） |
| `live-capabilities-final.json` | R7 真实模型逐题最终结果（状态/请求数/耗时/证据路径） |
| `live-capabilities.json`、`live-capabilities-batch2.json`、`live-capabilities-batch3.json`、`live-capabilities-batch4.json` | 分批真实运行原始记录 |
| `live-m28-smoke.json` | M28 首轮真实运行原始记录（验证脚本误判为 FAIL 的原始证据） |
| `live-m28-verified.json` | M28 修正验证逻辑后的离线复核记录 |
| `logs/` | typecheck / unit / 离线 audit / Goal 专项的运行日志 |

真实模型题的实际产物、产品工具事件与会话消息在 `Morrow/tmp/audit/live/<题号>/`
（`ws/` 工作区产物、`audit-events.json`、`audit-messages.json`）。

## 复跑命令

```bash
cd C:\交付成品\Morrow

# 产品回归（离线，不花钱）
npm run typecheck
npm run test:unit

# R7 离线审计（安全 + Goal，零真实费用）
npx vitest run --config tests/audit/vitest.config.ts

# Goal 专项
npx vitest run --config tests/audit/vitest.config.ts tests/audit/goal-long-run.test.ts

# 真实模型能力题（默认 skip；会产生真实 DeepSeek 费用）
# 默认单次最多 28 次请求，可用 MORROW_LIVE_MAX_REQUESTS 调整；输出文件可用 MORROW_LIVE_OUT 改名。
# Key 从 %USERPROFILE%\.dsh\.credentials.yaml 的 refs.DEEPSEEK_API_KEY 读取，全程不打印。
MORROW_LIVE=1 npx vitest run --config tests/audit/vitest.config.ts tests/audit/live-capabilities.test.ts
# 只跑指定题：
MORROW_LIVE=1 MORROW_LIVE_IDS=M01,M02 npx vitest run --config tests/audit/vitest.config.ts tests/audit/live-capabilities.test.ts
```

## 约束

- 所有临时工作目录在 `Morrow/tmp/audit/**`，不读写真实用户数据；
- 安全题使用 scripted/mock provider，真实模型只用于能力题；
- 真实请求预算本轮批准 130 次，实际使用 127 次（明细见 `live-capabilities-final.json` 的 `budget`）；
- 真实模型题里如果出现权限请求（工作区外访问等），审计脚本会拒绝并记为失败信号——正常任务不应触发。
