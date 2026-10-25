# Morrow v0.1.0 验收记录

> 日期：2026-10-25 · 版本：0.1.0 · 平台：Windows 10/11 x64 · 交付形态：单文件便携版 + NSIS 安装包
>
> 本轮主题：UI/UX 令牌收口（权限卡、订阅详情、统一页签）、字号与字体默认值、代码库扁平化、真实用户卡点修复、文档与包体重建。

## 1. 结论

- 类型检查：`npm run typecheck` **0 error**（主进程 + 渲染层）。
- UI 令牌审计：`npm run audit:ui` **通过**，50 个 CSS + 66 个 TSX，0 处裸字号/字重/行高/字距（文档预览 iframe 白名单除外）。
- 单元测试：**14 个套件 / 945 个用例**（按环境跳过真实引擎/本地模型集成）。
- 端到端：**17 个套件 / 208 个用例**；非打包 **192 passed + 11 skipped**，打包版 **5/5 passed**。真实 Electron + 主进程，默认 Mock LLM/ComfyUI。
- 真实断点：真实项目测试发现的 **6 个阻断点**全部修复并补回归（Codex 工具参数、登录端口复用、灵动岛跟随会话、当前模型视觉、登录按钮可重试、assistant 历史消息协议），见 §4。
- 打包冒烟：**通过（4.8s）**；单文件便携版首次解压 `.morrow-runtime-0.1.0-r010`，CDP、预加载 API、渲染与截图均正常。
- 交付包：**5 个分发文件 / 345.80 MiB**；便携版 196.41 MiB，安装包 149.39 MiB，未签名。

## 2. 本轮 UI/UX 收口

| 项目 | 结果 | 证据 |
|---|---|---|
| 权限卡令牌 | 字体族、字号、字重、行距全部提取为 `--font-permission*` / `--text-permission-*`；真实审批卡断言 14px/600/18.9px、说明 12.5px/450/21.5px、风险 10px、按钮 12.5px/500/34px | `tokens.css`、`activity.css`、`DESIGN-SYSTEM.md` §3.4；`14-journey` 权限卡用例 |
| 应用字号 | 可选 **12–15，默认 14**；`--fs-ui` 最低 12px | `SettingsModal.tsx`、`settings-store.ts`、`models.ts`；`01-ui-smoke` 外观用例 |
| 代码字号 | 可选 **11–14，默认 12**；代码、终端、diff、等宽数字共用 `--fs-code` | 同上；`CODE_FONT_FAMILY` 默认 JetBrains Mono |
| 代码字体 | 默认 **JetBrains Mono**，可切 IBM Plex Mono / 系统等宽；`data-code-font` 默认 `jetbrains` | `tokens.css`、`base.css`、外观设置；编辑器 E2E 断言 |
| 浏览器页签 | 24px 高、5px 微圆角、金色选中边框、surface 底，取消顶部圆角与下划线 | `browser.css`；`07-browser` 多标签用例断言 24px/5px |
| 画布页签 | 与终端/浏览器同款；取消方形贴顶与金色下划线 | `Canvas.css`；`10-rounds` 画布页签用例断言 24px/5px/金色边框 |
| 其它页签 | Git 视图、项目视图、Office 工作表全部统一到同一组 `--tab-*` token | `git.css`、`ProjectsPanel.css`、`preview.css`；对应 E2E 断言 |
| 订阅详情 | 以 ChatGPT/Codex 页为基准：标题 20px/500、说明 12.5px、正文 12.5px、连接项标题 13px、主按钮 34px/13px、面板内小按钮 28px/12px；Qoder/Kimi/GLM 等全部共用 | `tokens.css`、`SettingsSubscriptions.css`、`DESIGN-SYSTEM.md` §6.11；`08-settings` 订阅排版用例 + 双主题截图 |
| 默认模型卡 | 从内容区移入页面标题栏，与说明文字同一行顶部对齐，减少空白 | `SettingsModal.tsx`、`SettingsModal.css`；`settings-title-models-*.png` |
| 改动卡 | 长路径改为单行省略，展开箭头固定在同一行，不再被挤到第二行 | `Transcript.css`；`10-rounds` 超长路径用例 |
| 上下文浮层 | 紧贴圆环按钮上浮，宽度、圆角、背景与字号对齐模型上拉菜单 | `ContextMeter.tsx`、`Composer.css`；`10-rounds` 上下文用例 |
| 开关 | 设置、记忆中心、任务经验、技能卡全部改为 34×20px 微圆角矩形；轨道 5px、滑钮 4px，统一 `--toggle-*` token | `tokens.css`、`ui.css`、`EvolutionSuggestions.css`、`MemoryCenter.css`、`SkillsPanel.css`；`08-settings` 外观 token 用例 |
| WSL 终端 | 设置 → 终端检测 WSL 与发行版；无发行版时显示灰色说明，支持「重新检测」；有发行版时使用真实 PTY | `terminal-manager.ts`、`SettingsModal.tsx`；`11-terminal-git` 终端用例 |

截图：

- [设置 · 模型](../guide/screens/05-settings-models-dark.png)
- [设置 · 订阅 · ChatGPT/Codex](../guide/screens/06-subscriptions-dark.png)
- [权限卡](../guide/screens/03-permission-card-dark.png)
- [画布与页签](../guide/screens/04-editor-canvas-dark.png)
- 订阅详情：[ChatGPT/Codex](../guide/screens/06-subscriptions-dark.png)；浅色主题截图在 E2E 中生成，未纳入交付图集。

## 3. 真实用户卡点修复

| 卡点 | 修复 | 证据 |
|---|---|---|
| 本机/局域网 Ollama、LM Studio、网关被误判为「缺少 API Key」 | 统一 `isLoopbackHost` / `isPrivateNetworkHost` / `isLocalServiceUrl`；回环、`10.x`、`172.16–31.x`、`192.168.x`、`.local` 允许空 Key；错误文案改为「公网服务需 Key，本机/局域网可留空」 | `shared/models.ts`、`core/providers/index.ts`、`model-sync.ts`、`SettingsModal.tsx`；`shared.test.ts` 本机/私网分类用例 |
| 模型文件在下载目录时只能手动搬进引擎目录 | `resolve-model-files` 自动复制到引擎模型目录，重名自动加序号，返回 `copied`；表单提示同步更新 | `main/features/media.ts`、`MediaTab.tsx`；`16-media` 应用内模型用例 |
| 只有 ComfyUI 时「添加本机模型」永久禁用，被迫离开应用准备 JSON | 应用内表单支持 ComfyUI：粘贴 API 工作流 JSON、输出节点、输出类型、可选提示词节点；无可用引擎时给出明确出口提示 | `MediaTab.tsx`；`16-media` ComfyUI 工作流用例 |
| 真实技能包带 `scripts/` 时整包拒绝 | 脚本/可执行文件改为跳过并在安装结果中报告，Markdown/资源正常安装；SKILL.md 与大小/数量/zip-slip 安全限制保留 | `skills-service.ts`、`SkillsPanel.tsx`；`reveal.test.ts` 文件夹/zip 安装用例 |
| 长报告 >2MB 无法上画布 | 画布文本上限提高到 8MB，读取端同步 8MB 并保留截断提示 | `meta-tools.ts`、`ipc.ts`、内置技能说明 |
| 订阅页各渠道字号/按钮不一致 | 统一顶层 token 与详情面板布局（见 §2） | `SettingsSubscriptions.css`、`08-settings` 用例 |

## 4. R33 真实使用断点修复

本轮用真实项目跑通「新建站点 → 开发 → 预览 → 修改」链路，并追加订阅协议热修复，共修复 6 个阻断点：

| 断点 | 根因 | 修复 | 证据 |
|---|---|---|---|
| 连接 ChatGPT/Codex 订阅后，任务卡在「请补上 name 参数后重试」，`read_skill` 实际收到 `{}` | 代理只在 `response.output_item.done` 读取工具参数；部分响应把完整参数放在 `response.function_call_arguments.done`，流式增量组装时丢失 | 流式/非流式都消费 `function_call_arguments.done`；以 `output_item.added` 的增量为底，done 作为权威参数；`read_skill` 缺 `name` 时返回可用技能清单与重试提示，而不是直接失败 | `codex-proxy.ts`、`skills-tools.ts`；`subscriptions.test.ts` 的 done 事件参数用例、`tools.test.ts` 的缺少 name 回退用例 |
| 首次点击「浏览器登录 ChatGPT」不弹浏览器；再次点击提示 `address already in use`（127.0.0.1:1455） | 首次登录在弹窗前中断，回调服务器未复用，第二次重复 `listen` 同一端口 | 登录流程改为单例：保存授权 URL 与同一个 Promise，重复点击重开同一授权页而不是重开端口；端口被占用时返回明确文案 | `subscriptions.ts`；`08-settings` 订阅连接用例 |
| 多对话切换后，灵动岛不显示当前任务计划、耗时与进度条，只显示「随时待命」 | 灵动岛仅在开始运行或收到运行事件时更新，未跟随主窗口当前会话 | 新增 `island:sync-session`；渲染层在启动、切换、新建、切换工作区/演示/分支后同步；主进程按当前会话生成运行中/等待/待命快照，非当前会话事件不再覆盖 | `island.ts`、`ipc.ts`、`preload/index.ts`、`store.ts`、`agent-service.ts`；`01-ui-smoke` 灵动岛实时跟随、删除会话后跟随用例 |
| 当前使用 DeepSeek 或 ChatGPT 订阅开发时，审看媒体仍优先调用已配置的本地视觉模型 | `describe_media` 固定走 `visionProvider` 本地配置；Codex 订阅模型目录未声明 `supportsVision` | 当前模型声明 `supportsVision` 时直接用当前 Provider 处理图片；失败才回退本地并标注 fallback；为 Codex 订阅模型补齐视觉标记 | `media-service.ts`、`media-tools.ts`、`models.ts`、`subscriptions.ts`；`16-media` 当前模型视觉用例 |
| 点击「浏览器登录 ChatGPT / Qoder」后浏览器无反应，按钮随即变灰或不可重试 | Windows 系统 URL 处理链在受限环境会静默失败；Qoder 每次点击都会新建设备流，UI 在整个等待期禁用按钮 | 登录授权页改为直接拉起已安装浏览器（优先默认浏览器，系统处理器兜底）；Qoder 增加单例复用与「重新打开登录页面」，其他 Agent 登录共用直连打开 | `external-open.ts`、`SubscriptionTab.tsx`、`subscriptions.ts`、`qoder-subscription.ts`；`external-open.test.ts`、`08-settings` 登录重试用例 |
| ChatGPT 订阅首轮回复后立刻 HTTP 400：`Invalid value: 'input_text'`，要求 `output_text` | `contentToInput` 对所有角色都发送 `input_text`；Responses 要求 assistant 历史内容使用 `output_text` | 按角色映射：user/system 用 `input_text`，assistant 用 `output_text`，refusal 保留 `refusal`；补协议单测 | `codex-proxy.ts`；`subscriptions.test.ts` 的 assistant 历史内容用例 |

修复后重新执行门禁并重打包：单元 **945**、非打包 E2E **192 passed + 11 skipped**、打包 E2E **5/5**、便携版冒烟 **4.8s**；交付包哈希见 §7。

## 5. 代码库扁平化

| 项目 | 变化 |
|---|---|
| 单元测试 | 22 → **14 个文件**：8 个订阅协议 + qoder/relay 合并为 `subscription-protocols.test.ts` / `subscriptions.test.ts`，另新增 `external-open.test.ts`；用例数 934 → **945** |
| E2E | 21 → **17 个文件**：设置标题/UI token/订阅并入 `08-settings`，模型表单并入 `16-media`；用例数 204 → **208** |
| Feature 注册 | `discovery` / `permissions` / `git` / `subscriptions` / `schedules` 五个只被注册表引用的模块并入 `main/features/index.ts`，统一复用 `payloadOf` |
| 死代码 | 删除 17 个无引用导出、5 个死频道常量、死常量/死兼容分支 |
| 重复实现 | 统一 13 处 `errorText`、画布版本时间/大小格式化、`formatBytes`（core/project/renderer）、本机/私网 URL 判定、4 处 feature payload 解析 |
| 规模 | 源码 **313 个文件**（其中 292 个 ts/tsx/css，**124,999 行**：ts 70,832 / tsx 29,174 / css 24,993）；测试 **66 个文件**（14 单元 + 17 E2E + helpers/fixtures）；文档 31 个文件（10 个 Markdown + 12 张指南图 + manifest/验收 JSON） |

## 6. 验证门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 50 CSS + 66 TSX，0 裸排版值 |
| `npm run test:unit` | 14 文件；945 用例；**937 passed + 8 skipped** |
| `npx playwright test`（全量） | 17 文件；208 用例；**197 passed + 11 skipped + 0 failed**（11.1m） |
| 打包版 E2E | 5 用例；**5/5 passed**（18.2s） |
| `scripts/smoke-packaged.mjs` | 便携版 **4.8s 通过**；首次解压 `.morrow-runtime-0.1.0-r010`，预加载/渲染/截图正常 |
| 单元/打包耗时 | 单元 13.2s；全量 E2E 11.1m；打包 E2E 18.2s；打包 smoke 4.8s |

## 7. 交付物

| 产物 | 大小 | SHA-256 |
|---|---|---|
| `Morrow-0.1.0-portable.exe` | 205,946,880 B / 196.41 MiB | `cc3b832e9d94766adbada79e089460e94af3de1710bd83d442705d8c452da577` |
| `Morrow-0.1.0-setup.exe` | 156,644,089 B / 149.39 MiB | `afa5176ac893b553f01191bb7dd38f58d9cb775883c1585c459c01451f57547d` |
| `使用说明.txt` | 3,138 B | `cf6d00ce1b9d2f2ebd96ad26dbb1199dcbbf8a0e57807e06c9749221226db302` |
| `SHA256SUMS.txt` | 338 B | `58d3eb924ce53a3479e341c86aaf31d631afe94d4dd4e655ff63afb4b7ab93b6` |
| `LICENSE` | 1,070 B | `5a147a0421a711a0b44a5ecab6f6b0e8f0002dca17a8ecccef1599faaf70aa97` |
| **分发合计** | **5 文件 / 362,595,515 B / 345.8 MiB** | 未签名（signed:false） |

安装包载荷：**331 个文件 / 55 个目录**，包含 `Morrow-app.exe`、`resources/app.asar`、`node-pty` 原生模块；与便携版共用同一份 `win-unpacked`。

旧运行时缓存 `.morrow-runtime-0.1.0-r29` / `-r31` 的 `app.asar` 被当前 IDE 进程占用，已截断为 0B 并登记重启时删除；它们不属于分发文件，也未计入 `SHA256SUMS.txt`。`deliver/Morrow Data` 为用户数据，打包脚本保留但从不计入交付统计。

分发文件不包含用户数据、`.morrow-runtime-*` 缓存、日志或密钥；`deliver/Morrow Data` 是用户数据，打包脚本会保留但不会计入交付统计。

## 8. 验证边界（如实记录）

- Kimi、GLM、MiniMax、Step、Command Code、Cline、Antigravity、OpenCode 在本机没有真实账号；本轮验证的是真实端点实现、协议单测、设置页 UI 与重启恢复路径，没有把未连接显示成已连接，也没有编造额度。
- 真实 Codex 订阅用例默认跳过（`MORROW_SUBSCRIPTION_REAL=1` 开启）；真实本地模型/多媒体用例默认跳过，需要自备引擎、模型与 ffmpeg。
- 多媒体高分辨率/长视频依赖 NVIDIA 显卡与显存；16GB 显存下代码模型与视频模型需分阶段执行。
- 终端使用真实 PTY；应用退出时终端与后台任务会结束。
- 回退只覆盖 Morrow 通过写文件工具修改的文件；命令直接生成的文件不在范围内。
- 便携版/安装包未签名，首次运行可能触发 SmartScreen；彻底消除需要受信任的代码签名证书。
- 更改数据目录需要重启；迁移不包含浏览器缓存/登录状态，恢复默认目录不会自动合并两边数据。

## 9. 历史

R1–R32 的详细轮次记录已归档，不随交付发布。本轮以本文件为准。
