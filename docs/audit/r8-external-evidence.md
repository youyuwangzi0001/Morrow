# R8 外部能力证据索引（新功能队友自测 + 审计侧交叉验证）

> 用途：R8 全量 39 题报告的证据附录。区分「审计侧实测」与「新功能队友自测证据引用」，
> 避免把队友的自测当成审计侧真实模型成绩。

## #4 文档与技能（docs-skills）

| 项目 | 内容 |
|---|---|
| 工具清单 | `read_pdf` / `read_docx` / `edit_docx` / `read_xlsx` / `write_xlsx` / `list_skills` / `read_skill`（core/tools，工作区沙箱） |
| 单测命令 | `npx vitest run tests/unit/core/document-tools.test.ts tests/unit/core/skills.test.ts` |
| 队友报告结果 | 32 例全绿；全仓 269 例；`npm run typecheck` node+web 0 error |
| 审计侧复跑结果（2026-10-19） | 与 #5/#6 测试一起复跑 5 个文件 **98/98 通过**（docs/skills/mode/mcp/web） |
| 真实夹具 | `tests/unit/core/fixtures/documents/`：template.docx / split-run.docx / invoice.pdf / invoice-zh.pdf / blank.pdf / input.xlsx / manifest.json（sha256）/ make_fixtures.py |
| M09/M11/M12 工具级证据 | `tmp/doc-evidence/verification.json`（M09/M11/M12 全 PASS）、`m09-result.json` / `m11-result.json` / `m12-result.json`、`sales-recalc.xlsx` |
| M09 关键证据 | 文件中公式 `D2==B2*C2`、`D3==B3*C3`、`D4==SUM(D2:D3)`；**LibreOffice 重算 6/15/21** |
| M11 关键证据 | 输出段落 Pilot Letter / Dear 林宁 / … / CONFIDENTIAL - internal only；表格 Date / 2026-04-10；输入文件 sha256 不变 |
| 重跑说明 | `docs/DOCUMENT-TOOLS.md` §7.2 |
| 审计侧交叉验证 | `tests/audit/r8/feature-probe.test.ts`：scripted provider 驱动产品 `write_xlsx/edit_docx/read_pdf/list_skills/read_skill` 完成 M09/M11/M12/M21 产物，正式 checker 判分 **PASS**（含 soffice 重算独立校验） |

## #6 外部工具（integrations）

| 项目 | 内容 |
|---|---|
| MCP 配置 | `mcpServers` map：command(必填)/args/env/cwd/timeoutMs(250–120000)/disabled/description；来源优先级 `MORROW_MCP_CONFIG` > `<dataDir>/mcp.json` > `<workspace>/.morrow/mcp.json`（工作区默认不可信，需 `MORROW_MCP_TRUST_WORKSPACE=1`） |
| 工具 | `mcp_list`（meta/low，只列不执行）、`mcp_call`（exec/high，参数 {server, tool, arguments}，arguments≤32KB）；返回给模型的文本 + ToolResult.meta；MCP 返回 isError → ToolResult.ok=false |
| web_fetch | 只 GET，URL≤2048、默认 15s、响应≤2MB、正文默认 20000 字、最多 5 重定向；SSRF 拦截 loopback/私网/link-local/metadata 等（DNS 解析后 + 连接时二次校验） |
| 单测命令 | `npx vitest run tests/unit/core/mcp-tools.test.ts tests/unit/core/web-tools.test.ts` |
| 审计侧复跑结果 | 同上 98/98（含 mcp/web 全部用例）；队友报告 23+28 例通过 |
| 审计侧交叉验证 | 审计 mock `tests/audit/r8/mocks/morrow-mock-mcp.mjs` 通过 `MORROW_MCP_CONFIG` 被产品 `mcp_list/mcp_call` 真实拉起；feature-probe 中 M19（两页分页）、M20（参数类型）、M26（timeout 后 get_ticket）、M29（伪授权不外发）全部 checker PASS |
| 说明 | `web_fetch` 在离线环境对 `example.test` 会 DNS 失败，属预期；M04-06 使用本地 `in/web` 文件读取 |

## #5 聊天/工作模式（modes）

| 项目 | 内容 |
|---|---|
| 契约 | `Session.mode: 'work' | 'chat'`（缺省=work，旧会话兼容）；IPC `session:set-mode`；chat 模式：core 只下发只读工具 + ask_user，权限层硬 deny 写/执行，主进程强制 read-only，Goal 后端硬拒，运行中切模式被拒；重启保持 |
| 单测/E2E | `npx vitest run tests/unit/core/mode.test.ts`（14/14）；`npx playwright test tests/e2e/r8-mode.spec.ts`（1/1） |
| 审计侧复跑结果 | 同 98/98（mode.test.ts 含在其中） |
| 证据截图 | `docs/verification/screens/r8-mode-*.png`（chat-composer / chat-denied / work-write / restart-persist） |
| 与 39 题的关系 | 审计侧 39 题默认 `work`（不传 mode）；chat 模式作为**非计分对照**写入 R8 报告（只读、不自动执行、Goal 不可用），不虚构为题目通过 |

## 审计侧独立验证（不依赖队友自测）

- `tests/audit/r8/feature-probe.test.ts`（12/12 PASS，零真实模型费用）：用 scripted provider 驱动**产品真实工具**完成 M09/M11/M12/M19/M20/M21/M23/M25/M26/M29 + 图片消息体检查，再由正式 checker 判分。
- `tests/audit/r8/full39.test.ts` Phase A：43/43 夹具检查、9/9 mock 检查、39 个 checker 空输出拒绝 + 24 题参考输出 PASS、支持声明生成一致。
- 以上证据与真实模型题（`docs/audit/live-full-39.json`）严格分开：前者是“工具/协议接线正确”的离线证据，后者才是产品能力成绩。
