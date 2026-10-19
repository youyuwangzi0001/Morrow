# R10 验收准备报告（A–I、K；J 不做）

日期：2026-10-19 · 状态：**准备完成，未做功能验收**（等 Lead「功能可验收」信号）
性质：功能/安全验收，不冒充模型自主能力分，不并入 M01–M49。

## 一、已交付

| 内容 | 路径 |
|---|---|
| 验收矩阵（65 条，A/B/F/C/K1/G/K2/H/D/E/I/K3 + 跨领域） | `docs/audit/r10-verification-matrix.md` |
| fixtures 构建器（中文/二进制/大文件/只读/冲突/旧记忆/技能/恶意 zip/跨工作区标记） | `tests/audit/r10/py/build_fixtures.py` |
| 浏览器本地 HTTP mock（页面/重定向/慢响应/下载/权限页） | `tests/audit/r10/mocks/browser-server.mjs` |
| MCP HTTP+SSE mock（initialize/tools/list/call、slow/big/bad、SSE endpoint） | `tests/audit/r10/mocks/mcp-http-sse.mjs` |
| 零费用准备自检 | `tests/audit/r10/phase-a.test.ts` |
| E2E 骨架（`R10_ACCEPTANCE=1` 才运行） | `tests/e2e/r10-audit.spec.ts` |
| 自检日志 | `docs/audit/logs/r10-phase-a.json` / `.log` |

## 二、准备自检结果（零真实费用）

- 矩阵：**65 行**，关键安全项（zip-slip、跨工作区、中文、ask、证书、只读、冲突）齐全。
- fixtures：**21 个文件**；`skill-zip-slip.zip` 含 `../` 与绝对路径条目；跨工作区标记 `CROSS_WS_R10_SECRET` 只放在 ws-b。
- 浏览器 mock：5/5 路由通过（首页/第二页/302/slow/download）。
- MCP HTTP+SSE mock：6/6 检查通过（initialize/tools 列表/echo/慢调用/isError/SSE endpoint）。
- 功能模块落地扫描：当前 **25 个预期文件/目录缺失**（A/B/F/C/K1/G/K2/H/D/E/I/K3 多数仍在开发，符合“先准备”阶段）；集成后此数字应下降。
- 命令：`npx vitest run --config tests/audit/vitest.config.ts tests/audit/r10/phase-a.test.ts` → 1 passed。
- E2E 骨架可被 Playwright 列出（2 tests，默认 skip，等信号才执行）。

## 三、阶段 B 执行计划（收到「功能可验收」后）

1. **基线**：`npm run typecheck`、`npm run test:unit`、`npm run build`、`npx playwright test`（按 Lead 门槛）；记录版本/工作树。
2. **API 级安全/边界探针**（优先）：文件路径边界/symlink/只读/冲突、history 恢复、浏览器 URL/证书/权限、MCP SSRF/超时、zip-slip、memory/projects 隔离、中文搜索、computer-use 权限。能直接调用 service/feature handler 的不依赖 UI。
3. **E2E**：各功能队友的 `r10-files/editor/browser/connectors/skills/memory-projects/search` + 本审计的 `r10-audit.spec.ts` 跨领域检查；补齐面板选择器后跑。
4. **矩阵填表**：每条给 PASS/FAIL/UNSUPPORTED/INVALID/NOT_RUN + 证据路径；不允许把“未跑”写 PASS。
5. **报告**：`docs/AUDIT-REPORT-R10.md`，含范围、环境、逐项表、typecheck/unit/e2e、违规/未授权尝试、残余风险；旧 R9/R9.1 成绩保留对照，不回填。
6. **预计时间**：编写/补齐 API 探针 20–30 分钟 + 8 个领域 E2E 联调 40–60 分钟 + 全量回归 10–15 分钟 ≈ **70–110 分钟**（取决于功能集成完成度和 E2E 选择器稳定性）。

## 四、依赖与风险

- 需要各 feature 模块注册到 `src/main/features/index.ts` 且面板挂载、`window.morrow.features.invoke` 可用；频道/参数契约以队友交付为准。
- 浏览器证书用例需要自签名 HTTPS fixture（正在评估本机 openssl；若不可行，证书项记 M/UNSUPPORTED 并说明）。
- MCP HTTP/SSE mock 按通用 JSON-RPC/SSE fixture 编写；若产品采用特定 Streamable HTTP 语义，需按实现调整 fixture（不改产品）。
- computer-use 涉及真实桌面；验收以权限/参数/平台守卫为主，不做真实点击/输入；需要真机 GUI 的项目记 M/未核实。
- 不修改产品代码/UI/版本号/打包；测试与文档仅改 `tests/audit/r10`、`tests/e2e/r10-audit.spec.ts`、`docs/audit/**`、`docs/AUDIT-REPORT-R10.md`。
