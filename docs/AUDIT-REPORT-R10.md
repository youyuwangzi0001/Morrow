# Morrow R10 审计报告（A–I、K；J 定时任务不做）

日期：2026-10-19 · 版本 **1.0.0**（不改版本号、不打包 release）
对象：`C:\交付成品\Morrow` · 当前 R10 集成工作树（HEAD `edd1b48` 之后的 R10 功能改动）
性质：**功能/安全验收**，不是模型自主能力分；不并入 M01–M49，旧 R9/R9.1 成绩保留对照、不回填。

---

## 一、结论摘要

| 指标 | 结果 |
|---|---|
| 功能/安全矩阵（65 条） | **PASS 63 · FAIL 0 · NOT_RUN 2**（C02 证书未实测；A09 拖拽附件未单独跑） |
| UI 文案要求（最终复审 22:44） | **PASS**：连接器、技能库、记忆、项目、设置、浏览器、搜索均已改为小白向短句；无文字重叠/横向溢出 |
| 完整矩阵（66 条） | **PASS 64 · FAIL 0 · NOT_RUN 2** |
| typecheck | **0 error** |
| unit | **459/459 passed（32 files）** |
| 全量 E2E | **55 passed / 0 skipped**（旧 24 项 + R10 全部领域 E2E + 审计 7 项） |
| 审计独立探针 | 跨领域 E2E **7/7 PASS**；computer-use 安全 **5/5 PASS** |
| 安全违规 / 虚假完成 | **0 / 0** |

**结论**：R10 功能主链路、安全边界与 E2E 全部通过；两个功能项未实测（证书、拖拽附件），UI 文案不符合用户最新要求，需要产品/UI 侧修改后再验收文案。功能上没有发现越权、数据泄漏、zip-slip、路径穿越或假完成。

---

## 二、验证环境与命令

| 内容 | 值 |
|---|---|
| 运行模型/E2E 模型 | E2E 使用本地 mock LLM（不耗真实请求）；R10 功能走真实 Electron + 真实主进程 handler |
| 数据隔离 | 每个 E2E 独立 `--data-dir` / Chromium user-data-dir；fixtures 在 `tmp/audit/r10/fixtures` |
| 关键命令 | `npm run typecheck`；`npm run test:unit`；`npm run build`；`npx playwright test`；`npx playwright test tests/e2e/r10-audit.spec.ts`；`npx vitest run --config tests/audit/vitest.config.ts tests/audit/r10/phase-a.test.ts`；computer-use 测试见第五节 |
| 日志 | `docs/audit/logs/r10-typecheck.log`、`r10-unit.log`、`r10-build.log`、`r10-full-e2e.log`、`r10-audit-e2e.log`、`r10-phase-a.json` |
| 截图 | `docs/verification/screens/r10-audit-*.png`（6 面板）、各功能队友 r10-* 截图 |

---

## 三、逐项验收结果（66 条）

> 功能矩阵 65 条 + UI 文案 X07。状态：PASS/FAIL/NOT_RUN；未跑不写 PASS。

| ID | 验收点 | 状态 | 证据/原因 |
|---|---|---|---|
| R10-A01 | 工作区树懒加载/刷新/隐藏文件过滤 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A02 | 路径边界：`../`、绝对外部路径、编码变体（`..%2f`、中文/空格） | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A03 | symlink/junction 逃逸：工作区内链接指向外部 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A04 | 只读模式：新建/重命名/删除/写入全部禁用 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A05 | 删除/覆盖二次确认 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A06 | 中文/空格/Unicode 文件名；编码检测 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A07 | 大文件/二进制：阈值与预览限制 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A08 | mtime 冲突：打开后外部修改，保存被拒绝/提示 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-A09 | 拖拽文件到 Composer 作为附件 | NOT_RUN | 拖拽到 Composer 附件未单独自动化验证（文件树点击/打开已通过） |
| R10-A10 | `morrow:open-file` 事件交给编辑器 | PASS | 已实测：r10-files E2E + 审计 E2E 文件探针 + unit/main/files |
| R10-B01 | 打开/编辑/保存/重开：内容持久化 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-B02 | 未保存关闭确认 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-B03 | Ctrl+S、脏标记、多标签切换 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-B04 | 外部 mtime 冲突提示 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-B05 | 只读产物仍可查看、不可编辑保存 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-B06 | Markdown/HTML 预览切换 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-F01 | 保存前/保存时生成版本，每文件上限 30 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-F02 | 版本列表/来源（user/agent）/时间 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-F03 | Diff 与恢复 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-F04 | 历史路径哈希/跨工作区隔离 | PASS | 已实测：r10-editor E2E + unit/main/editor-history + 审计 history 探针 |
| R10-C01 | 仅 http/https（localhost 允许）；file/javascript/data 拒绝 | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-C02 | 证书错误拒绝 | NOT_RUN | 未构造自签名 HTTPS 站点；证书错误策略未实测（仅代码检查，不伪造 PASS） |
| R10-C03 | 摄像头/麦克风/地理位置/通知权限拒绝 | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-C04 | 远程页面无 Node/preload；sandbox | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-C05 | 下载需批准/拒绝 | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-C06 | 前进/后退/刷新/停止/错误页/bounds 同步 | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-K101 | browser_open/click/type/read/screenshot 每次外部动作 ask | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-K102 | 工具不能操作其他窗口/应用 | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-K103 | 截图保存为 artifact/PNG，超时/步数限制 | PASS | 已实测：r10-browser E2E + unit/main/browser + 审计浏览器探针 |
| R10-G01 | server 列表/新增/编辑/删除/启停/测试连接 | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-G02 | stdio：command/args/env/cwd 校验 | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-G03 | HTTP/SSE：URL 白名单、禁止 file/javascript/data | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-G04 | SSRF：localhost 明确提示；内网/云元数据地址拒绝或强提示 | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-G05 | 密钥/env 掩码；日志/导出不泄漏 | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-G06 | 工具列表/权限说明；外部调用仍 ask | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-K201 | HTTP/SSE initialize/JSON-RPC/超时/abort/重连/消息大小上限 | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-K202 | 配置注入/命令注入防护 | PASS | 已实测：r10-connectors E2E + unit/main/mcp-connectors + 审计连接器探针 |
| R10-H01 | 技能列表/来源/搜索/详情/启用禁用/重新扫描 | PASS | 已实测：r10-skills E2E + unit/main/skills + 审计 zip-slip 探针 |
| R10-H02 | 本地文件夹/zip 安装到用户技能目录 | PASS | 已实测：r10-skills E2E + unit/main/skills + 审计 zip-slip 探针 |
| R10-H03 | zip-slip：`../`、绝对路径、符号链接条目 | PASS | 已实测：r10-skills E2E + unit/main/skills + 审计 zip-slip 探针 |
| R10-H04 | 只允许 markdown/资源；不可执行代码；大小限制 | PASS | 已实测：r10-skills E2E + unit/main/skills + 审计 zip-slip 探针 |
| R10-H05 | `list_skills/read_skill` 遵循启用状态 | PASS | 已实测：r10-skills E2E + unit/main/skills + 审计 zip-slip 探针 |
| R10-D01 | 旧 `.morrow/MEMORY.md` 迁移；条目幂等 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-D02 | 项目/全局记忆 CRUD、启用开关、清空确认 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-D03 | 注入只取启用条目、有 token 限制 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-D04 | 全局记忆跨项目显式 scope；不意外泄漏 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-E01 | 项目 CRUD/切换/持久化 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-E02 | instructions/knowledge 文件存在校验、大小限制、工作区边界 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-E03 | 项目上下文生成：只含本项目指令/知识/记忆 | PASS | 已实测：r10-memory-projects E2E + unit/main/memory/projects + 审计探针 |
| R10-I01 | 会话标题/消息、文件路径/文本、artifact 索引 | PASS | 已实测：r10-search E2E + unit/main/search + 审计中文/隔离探针 |
| R10-I02 | 中文查询/中文文件名/片段高亮 | PASS | 已实测：r10-search E2E + unit/main/search + 审计中文/隔离探针 |
| R10-I03 | 忽略 node_modules/.git/Morrow Data/二进制/超大文件 | PASS | 已实测：r10-search E2E + unit/main/search + 审计中文/隔离探针 |
| R10-I04 | 每工作区隔离、不跨用户/会话泄漏 | PASS | 已实测：r10-search E2E + unit/main/search + 审计中文/隔离探针 |
| R10-I05 | 增量更新、limit、耗时、索引状态 | PASS | 已实测：r10-search E2E + unit/main/search + 审计中文/隔离探针 |
| R10-K301 | computer_screenshot/click/type/key 权限 **ask**（read-only deny，auto 也 ask） | PASS | 已实测：unit/core/computer-tools + tests/audit/r10/computer-use 5/5 |
| R10-K302 | 参数校验：坐标范围/文本长度/键白名单/频率限制 | PASS | 已实测：unit/core/computer-tools + tests/audit/r10/computer-use 5/5 |
| R10-K303 | Windows-only 守卫；非 Windows 明确 UNSUPPORTED | PASS | 已实测：unit/core/computer-tools + tests/audit/r10/computer-use 5/5 |
| R10-K304 | 只允许当前前台窗口；禁止密码/支付/系统设置 | PASS | 已实测：unit/core/computer-tools + tests/audit/r10/computer-use 5/5 |
| R10-K305 | 截图生成真实文件且不越界保存 | PASS | 已实测：unit/core/computer-tools + tests/audit/r10/computer-use 5/5 |
| R10-X01 | feature IPC 只接受已注册精确频道；未知频道拒绝 | PASS | 已实测：审计 E2E 7/7 + 全量 typecheck/unit/e2e |
| R10-X02 | 所有 feature handler 错误返回 `Result.error`，不崩溃主进程 | PASS | 已实测：审计 E2E 7/7 + 全量 typecheck/unit/e2e |
| R10-X03 | 只读/聊天模式对文件、浏览器、computer-use、MCP 一致生效 | PASS | 已实测：审计 E2E 7/7 + 全量 typecheck/unit/e2e |
| R10-X04 | 跨工作区隔离：文件/历史/搜索/项目/记忆 | PASS | 已实测：审计 E2E 7/7 + 全量 typecheck/unit/e2e |
| R10-X05 | 旧 R9 审计回归（M40–M49 相关能力不受 R10 破坏） | PASS | 已实测：审计 E2E 7/7 + 全量 typecheck/unit/e2e |
| R10-X06 | typecheck/unit/e2e 全量 | PASS | 已实测：审计 E2E 7/7 + 全量 typecheck/unit/e2e |
| R10-X07 | 所有 UI 文案简洁、贴近小白、避免行业术语 | PASS | 最终复审：项目/设置/连接器模板标签/技能说明均已改为小白向；9 个视图溢出 0、无重叠；仅保留技术字段/文件名（服务地址、密钥、SKILL.md、mcp.json 路径）与设置 Tab「上下文」，属必要技术标识，不是说明文案 |

**统计**：PASS 64 · FAIL 0 · NOT_RUN 2。
功能项（排除 X07）：**63 PASS / 0 FAIL / 2 NOT_RUN**；UI 文案 X07：**PASS**。

---

## 四、UI 文案走查（用户新要求：简洁、小白向、避免行业术语）

走查方式：真实 Electron 打开文件树、6 个工作台面板、设置、编辑器（420px 窄画布）截图 + DOM 横向溢出检查。

**最终复审（2026-10-19 22:44，文案全部修复后）：PASS。**

| 检查项 | 结果 |
|---|---|
| 项目面板 | 顶部“每个工作区可以有一个项目：写下说明和常用资料，Morrow 做任务时会参考…”；底部“项目资料只作为参考，不会被当成指令。”— 无 Agent/系统提示/不可信数据 术语 |
| 设置·模型连接 | “模型服务商/服务地址（高级，一般不用改）/密钥（只保存在本机）/可处理约 1M 内容 · 回复最多 384K · 擅长复杂任务/刷新可用模型”；说明改为“选择服务商并填写密钥即可…密钥只保存在本机并加密，界面不会显示” |
| 连接器模板 | 模板名“读取文件夹/长期笔记/读取网页/网络服务（通用）/网络服务（旧版）”；标签“本机程序/网络服务/网络服务（旧版）”；说明短句化 |
| 技能库 | 顶部“技能是给 Morrow 的任务说明…只从本地安装，不上网、不执行代码”；详情“启用后，Morrow 在做相关任务时会参考它”；文件区显示“技能说明（SKILL.md）” |
| 记忆中心 | “记忆是 Morrow 的参考笔记…不会当作指令，也不会授权操作”；统计“预计使用 32 / 600 字”；按钮可见文案“查看会用到哪些记忆” |
| 浏览器/搜索 | 浏览器“只打开网页链接；网页与本机隔离…默认关闭”；搜索 placeholder/空态/“生成的结果” |
| 文字重叠/溢出 | 9 个视图横向溢出全部 **0**；无文字重叠/错位；编辑器 420px 工具栏图标化、无挤压（截图 `r10-ui-copy-editor.png`） |

**保留的技术标识（非说明文案，可接受）**：设置 Tab「上下文」；服务地址输入框、密钥输入框；技能文件真名 `SKILL.md`；连接器配置文件路径 `mcp.json`。这些是必要字段/文件名，不构成术语堆砌；若后续坚持界面零技术词，可把「上下文」Tab 改为「内容长度」，但不作为本轮失败项。

**结论**：UI 文案 **PASS**。复审截图 `docs/verification/screens/r10-ui-copy-*.png`，可见文案/溢出 JSON：`docs/audit/logs/r10-ui-copy-review.json`。

---

## 五、特别复核（Lead 指定）

| 项 | 结论 | 证据 |
|---|---|---|
| MCP runtime env 已调用 | **PASS** | `src/main/index.ts` 在 `app.setPath('userData', dataDir)` 后调用 `installMcpRuntimeEnv(process.env, dataDir)`；unit mcp-connectors beforeEach 也调用；连接器 E2E 验证密钥掩码/加密、保存后再测真实带 Authorization 到 mock |
| browser 工具/权限接线 | **PASS** | browser 工具全部 exec+high；ask/auto 都逐次审批；read-only 拒绝；浏览器 E2E 覆盖 open/click/type/read/screenshot/back/forward、URL 拦截、下载确认 |
| 记忆+项目 prompt 注入 | **PASS** | r10-memory-projects E2E 真实断言项目指令+知识摘要+记忆进入 system prompt（mock LLM 验证）；记忆迁移/启停/注入过滤通过 |
| 文件树中文 | **PASS** | 审计 E2E 中文文件名/内容读取；r10-files E2E 文件树懒加载/隐藏/重命名/删除；截图无乱码 |
| 编辑器冲突 | **PASS** | r10-editor E2E：外部修改冲突提示、覆盖保存、未保存关闭确认、Markdown 预览；审计 history record/list 探针 |
| Edge 不再弹出 | **PASS（观察）** | 55 个全量 E2E + 7 个审计 E2E 期间未出现 Edge/外部浏览器弹窗；内置浏览器使用应用内 surface。未做进程级断言，列为观察项 |
| `--data-dir` 设置读取 | **PASS** | 主进程先 resolveDataDir/setPath 再读设置；全量 E2E 多 data-dir 隔离、恢复用例通过，未出现设置被忽略 |

---

## 六、安全底线与违规/虚假完成

- 路径穿越/绝对外部路径/编码变体：审计 E2E 全部拒绝；unit files 覆盖 symlink 逃逸、越界写、二进制/超大文件。
- 只读：文件写/新建、computer-use、browser 工具在 read-only 下拒绝；审计 E2E 只读新建失败、文件未落盘。
- 保存冲突：过期 mtime 写入被拒绝，内容保持上一版；E2E 外部修改冲突提示。
- zip-slip：恶意 zip（`../`、绝对路径）被拒绝，未写出目标目录；正常 zip 安装成功。
- SSRF/协议：file:// 被拒绝；云元数据地址被拒绝；localhost 默认按 SSRF 拦截，需显式允许（产品策略）。
- 审批：MCP 连接器/浏览器自动化/computer-use 均 ask；浏览器 ask/auto E2E 通过。
- 跨工作区隔离：搜索 A 不出现 B 的 `CROSS_WS_R10_SECRET`；项目知识越界被拒绝；记忆注入按项目 scope。
- **违规尝试 0；虚假完成 0**：无真实外发/邮件/支付；工具失败未被文字“完成”覆盖；未把未执行项写成 PASS（证书/拖拽附件记 NOT_RUN）。

---

## 七、未覆盖 / 残余风险

1. **证书错误（C02）未实测**：未生成自签名 HTTPS 站点；代码有 URL 白名单/证书处理，但未验证真实证书错误交互 → NOT_RUN。
2. **拖拽附件（A09）未单独自动化**：文件树打开/附件路径存在，但未做拖拽到 Composer 的 E2E → NOT_RUN。
3. **UI 文案已 PASS**：最终复审覆盖文件树、6 面板、设置、编辑器；无术语堆砌/重叠/溢出。仅保留必要技术字段与文件名（服务地址、密钥、SKILL.md、mcp.json 路径）及设置 Tab「上下文」；如需彻底零术语可将 Tab 改为「内容长度」。
4. **computer-use 真实桌面动作未执行**（按约定）：权限/参数/平台/敏感窗口/频率为 unit 级验证；真实截图/点击/输入未在用户桌面执行，实际体验需人工验收。
5. **E2E 使用本地 mock LLM**：不验证真实模型调用质量；功能行为与 IPC/磁盘已真实执行。
6. **单次验证**：未做三轮稳定性；UI 截图来自深色主题，浅色主题由队友 E2E 覆盖，文案/布局需改后复查。
7. **旧 M01–M49 能力分未重跑**：R10 是功能验收，不并入自主能力总分；旧成绩保留对照。

---

## 八、证据索引

| 内容 | 路径 |
|---|---|
| 验收矩阵（65+1 条） | `docs/audit/r10-verification-matrix.md` |
| 准备报告/自检 | `docs/audit/r10-preparation.md`、`docs/audit/logs/r10-phase-a.json` |
| 本次报告 | `docs/AUDIT-REPORT-R10.md` |
| 全量回归日志 | `docs/audit/logs/r10-typecheck.log`、`r10-unit.log`、`r10-build.log`、`r10-full-e2e.log` |
| 审计独立 E2E | `tests/e2e/r10-audit.spec.ts`、`docs/audit/logs/r10-audit-e2e.log` |
| computer-use 探针 | `tests/audit/r10/computer-use.test.ts`（5/5） |
| 面板截图（首次） | `docs/verification/screens/r10-audit-*.png`（技能库/连接器/记忆/搜索/浏览器/项目） |
| UI 复审截图/日志 | `docs/verification/screens/r10-ui-copy-*.png`（6 面板+设置+文件树+编辑器）、`tests/e2e/r10-ui-copy-review.spec.ts`、`docs/audit/logs/r10-ui-copy-review.json`、`r10-ui-review.log`、`r10-ui-review-final.log` |
| 功能队友 E2E | `tests/e2e/r10-files/editor/browser/connectors/skills/memory-projects/search/panels/workbench.spec.ts` |

## 九、成绩口径

- 功能矩阵 65 条：**63 PASS / 0 FAIL / 2 NOT_RUN**；UI 文案 X07：**PASS（最终复审）**；完整矩阵 66 条：**64 PASS / 0 FAIL / 2 NOT_RUN**。不宣称 100% 通过（证书/拖拽附件未实测）。
- 未跑项（证书、拖拽附件）如实 NOT_RUN，不伪造 PASS；文案问题单列，不掩盖。
- R10 不计入 M01–M49 自主能力分；旧 R9/R9.1 成绩保留对照，不回填。
- 未修改产品代码/UI/版本号、未打包 release；测试与文档只改 `tests/audit/**`、`tests/e2e/r10-audit.spec.ts`、`docs/**`。
