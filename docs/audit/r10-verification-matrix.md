# R10 功能验收矩阵（A–I、K；J 定时任务不做）

版本：1.0.0 · 基线：R9.1 之后工作树
性质：**功能/安全验收矩阵**，不是模型自主能力分，不并入 M01–M49；结果单列 PASS/FAIL/UNSUPPORTED/INVALID/NOT_RUN。
原则：只用本地 fixture/mock，不接触真实账号/支付/外网；prepare 阶段所有项为 `PENDING`，等 Lead「功能可验收」后执行并填真实状态。

## 执行方式

| 方法 | 含义 |
|---|---|
| **U/API** | 直接调用主进程 service/feature handler（`invokeFeatureForTest`）或 core 工具，验证边界/权限/返回 |
| **E2E** | Playwright Electron 启动真实应用，验证 UI + IPC + 磁盘/服务状态 |
| **M** | 仅能人工观察/平台相关，需注明未自动化原因 |

- 一键离线自检（零费用，准备阶段）：`npx vitest run --config tests/audit/vitest.config.ts tests/audit/r10/phase-a.test.ts`
- 功能验收 E2E（集成后）：`R10_ACCEPTANCE=1 npx playwright test tests/e2e/r10-audit.spec.ts`
- 全量回归：`npm run typecheck` + `npm run test:unit` + `npx playwright test`（以 Lead 指定为准）
- Fixtures：`tmp/audit/r10/fixtures/**`；证据：`tmp/audit/r10/evidence/**`、`docs/audit/logs/r10-*.json`

## 状态图例

`PENDING` 未执行（准备阶段） · `PASS` 实测通过 · `FAIL` 实测失败 · `UNSUPPORTED` 产品未实现/平台不具备 · `INVALID` 测试准备/环境错误 · `NOT_RUN` 未执行

---

## A. 文件树与文件操作

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-A01 | 工作区树懒加载/刷新/隐藏文件过滤 | E2E | 目录层级正确、刷新反映磁盘变化 | 不显示工作区外内容 | PENDING |
| R10-A02 | 路径边界：`../`、绝对外部路径、编码变体（`..%2f`、中文/空格） | U/API | 全部拒绝并返回可读错误 | 防目录穿越 | PENDING |
| R10-A03 | symlink/junction 逃逸：工作区内链接指向外部 | U/API | realpath 判定为越界并拒绝读/写/删 | 防 symlink 绕过 | PENDING |
| R10-A04 | 只读模式：新建/重命名/删除/写入全部禁用 | U/API + E2E | 无副作用；UI 禁用/报错 | 只读不可被 IPC 绕过 | PENDING |
| R10-A05 | 删除/覆盖二次确认 | E2E | 取消则文件不变；确认才执行 | 防误删 | PENDING |
| R10-A06 | 中文/空格/Unicode 文件名；编码检测 | U/API | 正确读写 UTF-8/UTF-8 BOM；非法编码有提示 | 不损坏原文件 | PENDING |
| R10-A07 | 大文件/二进制：阈值与预览限制 | U/API | 超限拒绝或只读提示，不把二进制当文本写回 | 内存/损坏保护 | PENDING |
| R10-A08 | mtime 冲突：打开后外部修改，保存被拒绝/提示 | U/API + E2E | 返回冲突错误，不静默覆盖 | 数据保护 | PENDING |
| R10-A09 | 拖拽文件到 Composer 作为附件 | E2E | 附件出现且路径在允许范围 | 不附带工作区外文件 | PENDING |
| R10-A10 | `morrow:open-file` 事件交给编辑器 | E2E | 事件 detail.path 正确、编辑器打开 | 事件不越权 | PENDING |

## B/F. 编辑器与版本历史

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-B01 | 打开/编辑/保存/重开：内容持久化 | E2E | 保存后磁盘一致，重开正确 | 无静默截断 | PENDING |
| R10-B02 | 未保存关闭确认 | E2E | 取消保持窗口与内容；确认才丢弃 | 防数据丢失 | PENDING |
| R10-B03 | Ctrl+S、脏标记、多标签切换 | E2E | 状态正确、无交叉污染 | — | PENDING |
| R10-B04 | 外部 mtime 冲突提示 | E2E | 提示冲突，提供覆盖/放弃/另存，不静默覆盖 | 数据保护 | PENDING |
| R10-B05 | 只读产物仍可查看、不可编辑保存 | E2E | 编辑器只读态 | 只读传播 | PENDING |
| R10-B06 | Markdown/HTML 预览切换 | E2E | 预览正确，脚本隔离（HTML sandbox iframe） | XSS/沙箱 | PENDING |
| R10-F01 | 保存前/保存时生成版本，每文件上限 30 | U/API | 版本数/容量上限生效 | 磁盘上限 | PENDING |
| R10-F02 | 版本列表/来源（user/agent）/时间 | U/API | 字段真实，无伪造来源 | 审计可追溯 | PENDING |
| R10-F03 | Diff 与恢复 | U/API + E2E | 恢复内容正确、恢复前留档 | 不丢当前版本 | PENDING |
| R10-F04 | 历史路径哈希/跨工作区隔离 | U/API | 其他工作区历史不可见 | 隔离 | PENDING |

## C/K1. 浏览器与浏览器自动化

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-C01 | 仅 http/https（localhost 允许）；file/javascript/data 拒绝 | U/API + E2E | 导航前拒绝并说明 | 协议白名单 | PENDING |
| R10-C02 | 证书错误拒绝 | E2E（自签名 HTTPS fixture） | 不提供“继续访问”绕过 | TLS | PENDING |
| R10-C03 | 摄像头/麦克风/地理位置/通知权限拒绝 | U/API + E2E | 拒绝且不弹真实权限 | 权限最小化 | PENDING |
| R10-C04 | 远程页面无 Node/preload；sandbox | E2E | `window.require`/preload 不可用 | 沙箱 | PENDING |
| R10-C05 | 下载需批准/拒绝 | E2E | 未批准不落盘 | 下载边界 | PENDING |
| R10-C06 | 前进/后退/刷新/停止/错误页/bounds 同步 | E2E | 状态真实、无越界绘制 | UI 边界 | PENDING |
| R10-K101 | browser_open/click/type/read/screenshot 每次外部动作 ask | U/API | read-only deny；auto 也 ask；被拒后不执行 | 审批 | PENDING |
| R10-K102 | 工具不能操作其他窗口/应用 | U/API | 目标被限制为内置浏览器 | 越权 | PENDING |
| R10-K103 | 截图保存为 artifact/PNG，超时/步数限制 | U/API | 文件真实存在；超时/超步终止 | 资源限制 | PENDING |

## G/K2. MCP 管理 UI 与 HTTP/SSE

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-G01 | server 列表/新增/编辑/删除/启停/测试连接 | E2E | 操作持久化；错误可见 | 配置完整性 | PENDING |
| R10-G02 | stdio：command/args/env/cwd 校验 | U/API | 不合法配置拒绝；spawn 失败可读 | 注入/路径 | PENDING |
| R10-G03 | HTTP/SSE：URL 白名单、禁止 file/javascript/data | U/API | 非法协议拒绝 | SSRF/协议 | PENDING |
| R10-G04 | SSRF：localhost 明确提示；内网/云元数据地址拒绝或强提示 | U/API | 与产品策略一致且可审计 | SSRF | PENDING |
| R10-G05 | 密钥/env 掩码；日志/导出不泄漏 | U/API | 无明文密钥出现 | 凭据 | PENDING |
| R10-G06 | 工具列表/权限说明；外部调用仍 ask | E2E + U/API | 未审批不调用 | 审批 | PENDING |
| R10-K201 | HTTP/SSE initialize/JSON-RPC/超时/abort/重连/消息大小上限 | U/API | 本地 mock 全通过；超时/超限终止 | 稳定性/DoS | PENDING |
| R10-K202 | 配置注入/命令注入防护 | U/API | 特殊字符/换行不能改变命令结构 | 注入 | PENDING |

## H. 技能库

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-H01 | 技能列表/来源/搜索/详情/启用禁用/重新扫描 | E2E + U/API | 状态持久化；禁用技能不注入 Agent | 能力边界 | PENDING |
| R10-H02 | 本地文件夹/zip 安装到用户技能目录 | U/API | 安装成功、文件完整 | 路径边界 | PENDING |
| R10-H03 | zip-slip：`../`、绝对路径、符号链接条目 | U/API | 拒绝/安全解压，不写出目标目录 | 目录穿越 | PENDING |
| R10-H04 | 只允许 markdown/资源；不可执行代码；大小限制 | U/API | 非法内容拒绝/隔离 | 代码执行 | PENDING |
| R10-H05 | `list_skills/read_skill` 遵循启用状态 | U/API | 禁用技能不可读/不注入 | 越权 | PENDING |

## D/E. 记忆中心与 Projects

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-D01 | 旧 `.morrow/MEMORY.md` 迁移；条目幂等 | U/API | 无重复、无丢失；失败可回滚 | 数据迁移 | PENDING |
| R10-D02 | 项目/全局记忆 CRUD、启用开关、清空确认 | U/API + E2E | 操作真实持久化；禁用不注入 | 作用域 | PENDING |
| R10-D03 | 注入只取启用条目、有 token 限制 | U/API | 禁用/超限不注入 | 注入边界 | PENDING |
| R10-D04 | 全局记忆跨项目显式 scope；不意外泄漏 | U/API | 作用域隔离 | 隐私 | PENDING |
| R10-E01 | 项目 CRUD/切换/持久化 | U/API + E2E | 与工作区一一对应；重启保持 | 跨项目隔离 | PENDING |
| R10-E02 | instructions/knowledge 文件存在校验、大小限制、工作区边界 | U/API | 非法路径拒绝；不发散读取 | 路径边界 | PENDING |
| R10-E03 | 项目上下文生成：只含本项目指令/知识/记忆 | U/API | 无其他项目标记 | 隔离 | PENDING |

## I/K3. 全局搜索与 computer-use

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-I01 | 会话标题/消息、文件路径/文本、artifact 索引 | U/API | 分组结果正确、ranking 合理 | 数据范围 | PENDING |
| R10-I02 | 中文查询/中文文件名/片段高亮 | U/API | 能命中并高亮 | 编码 | PENDING |
| R10-I03 | 忽略 node_modules/.git/Morrow Data/二进制/超大文件 | U/API | 不出现在结果；索引状态可见 | 性能/泄漏 | PENDING |
| R10-I04 | 每工作区隔离、不跨用户/会话泄漏 | U/API | B 标记不出现在 A 结果 | 隔离 | PENDING |
| R10-I05 | 增量更新、limit、耗时、索引状态 | U/API | 新增文件可搜；删除后不残留 | 一致性 | PENDING |
| R10-K301 | computer_screenshot/click/type/key 权限 **ask**（read-only deny，auto 也 ask） | U/API | 未审批绝不执行 | 审批 | PENDING |
| R10-K302 | 参数校验：坐标范围/文本长度/键白名单/频率限制 | U/API | 非法参数拒绝 | 防误操作 | PENDING |
| R10-K303 | Windows-only 守卫；非 Windows 明确 UNSUPPORTED | U/API | 平台不符清晰报错 | 平台 | PENDING |
| R10-K304 | 只允许当前前台窗口；禁止密码/支付/系统设置 | U/API + M | 不能绕过限制；风险提示 | 隐私/越权 | PENDING |
| R10-K305 | 截图生成真实文件且不越界保存 | U/API | PNG 存在、位于允许目录 | 文件边界 | PENDING |

## 跨领域回归（不重复功能项）

| ID | 验收点 | 方法 | 预期 | 状态 |
|---|---|---|---|---|
| R10-X01 | feature IPC 只接受已注册精确频道；未知频道拒绝 | U/API | 无动态任意调用 | PENDING |
| R10-X02 | 所有 feature handler 错误返回 `Result.error`，不崩溃主进程 | U/API | 可读错误，进程存活 | PENDING |
| R10-X03 | 只读/聊天模式对文件、浏览器、computer-use、MCP 一致生效 | U/API + E2E | 全部拒绝外动作 | PENDING |
| R10-X04 | 跨工作区隔离：文件/历史/搜索/项目/记忆 | U/API | B 标记不进入 A | PENDING |
| R10-X05 | 旧 R9 审计回归（M40–M49 相关能力不受 R10 破坏） | U/API | R2 8/8、关键路径不回归 | PENDING |
| R10-X06 | typecheck/unit/e2e 全量 | 命令 | 0 error / 全绿（以 Lead 指定门槛） | PENDING |

---

## 最终结果

- 2026-10-19 已完成验收：功能 65 条 **63 PASS / 0 FAIL / 2 NOT_RUN**；新增 UI 文案 X07 **FAIL**。逐项状态、证据、UI 文案修改建议见 `docs/AUDIT-REPORT-R10.md`。

## 准备阶段已交付（不冒充验收）

- 本矩阵：覆盖 A/B/F/C/K1/G/K2/H/D/E/I/K3 与 8 项跨领域安全检查。
- Fixtures 构建器：`tests/audit/r10/py/build_fixtures.py`（中文/二进制/大文件/冲突/旧记忆/技能/恶意 zip/跨工作区标记）。
- 本地 mock：`tests/audit/r10/mocks/browser-server.mjs`（HTTP 页面/重定向/下载/slow），`tests/audit/r10/mocks/mcp-http-sse.mjs`（HTTP JSON-RPC + SSE）。
- 零费用自检：`tests/audit/r10/phase-a.test.ts`（fixtures/mock/矩阵完整性/功能模块存在性检测）。
- E2E 骨架：`tests/e2e/r10-audit.spec.ts`（`R10_ACCEPTANCE=1` 才运行；集成后补 UI 断言）。
- 结果与证据：集成后填 `docs/AUDIT-REPORT-R10.md`、`docs/audit/logs/r10-phase-a.json`。

## UI 文案（小白向）额外验收

| ID | 验收点 | 方法 | 预期 | 安全重点 | 状态 |
|---|---|---|---|---|---|
| R10-X07 | 所有 UI 文案简洁、贴近小白、避免行业术语 | E2E 走查 | 无术语堆砌/长段说明；关键操作一看就懂 | 可理解性 | PASS（最终复审；仅保留必要技术字段/文件名） |
