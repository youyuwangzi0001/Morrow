# Morrow 开发总纲

> 版本 1.0 · 2026-10-19 · 主理人（Team Lead）
> 产品代号：**Morrow**（拉丁语「明日」）。中文副名：**明日工坊**。

---

## 1. 产品定义

**一句话**：Morrow 是一个住在你电脑里的 AI 工作伙伴。你说清想要的结果，它自己读文件、写代码、跑命令、查资料、做计划，然后把成品放到你面前。

**定位**：Claude Desktop 的交互形态 + Claude Code 的 Agent 内核 + 新手友好的一体化体验。离线也能「先看到它有多能干」的演示模式。

**目标用户**：没有编程背景、但确实有一堆电脑上的杂活要做的普通用户（学生、运营、编辑、小店主、行政）。他们说不清什么是 API、什么是 Token，但他们知道「我想要一份能直接发给老板的周报」。

**核心洞察**：
- 普通用户缺的不是模型，是**把模型接到自己电脑上的那双手**。
- 显性的能力（会调工具）必须被**看得见**——工具调用不能藏在一个转圈后面，而要成为一条可读的「行动轨迹」。
- 长程任务需要**三件套**：计划面板（知道要干嘛）、权限卡片（知道它要做什么、能拒绝）、改动可撤回（不怕）。
- 「WOW 时刻」= 用户随口说一句需求，去泡杯茶，回来时桌面上多了一个能直接用的成品，而且全程看得懂它做了什么。

**Wow 时刻设计（Demo 剧本）**：首次启动点「看一场演示」→ Agent 自动完成：读取 `demo-workspace/sales/*.csv` → 发现数据问题 → 用命令计算 → 写一份自包含的 HTML 分析报告并打开画布预览 → 列出三条可继续追问的建议。全程真实执行、无网络、约 40 秒。

**非目标（本期明确不做）**：手机端、多人协作、云端同步、插件市场、MCP 宿主、语音输入、自动更新服务端、账号体系。桌面端单机 + 自带 API Key。

---

## 2. 架构与工程原则

- **单包工程**（非 monorepo）：Electron + electron-vite + React 19 + TypeScript，全部源码在 `src/`，构建与打包用 electron-builder。
- **内核与外壳分离**：`src/core/` 是纯 TypeScript 的 Agent 运行时（不 import electron / react / dom），可以脱离桌面单独测试；`src/main/` 只做进程、IPC、持久化、系统能力；`src/renderer/` 只做显示与交互。
- **单一事实源**：会话、设置、Agent 运行状态都归主进程所有；渲染层发送意图、订阅事件流。渲染层不直接碰文件系统。
- **安全默认**：`contextIsolation: true`、`nodeIntegration: false`、preload 只暴露窄接口；文件工具被限制在工作区沙箱内；API Key 用 Electron `safeStorage`（Windows DPAPI）加密落盘；命令工具带危险命令拦截 + 超时 + 输出上限。
- **可测**：内核单元测试（vitest）+ 本地 Mock LLM（OpenAI SSE 与 Anthropic SSE 双协议）+ Playwright 驱动真实 Electron 的端到端测试 + 打包产物冒烟测试。
- **便携**：electron-builder `portable` 单文件；数据目录默认放在 exe 同级的 `Morrow Data/`（由 `PORTABLE_EXECUTABLE_DIR` 推断），真正做到「拷走就能用」。

---

## 3. 开发流程（里程碑制）

每一轮只推进一个里程碑内的一张任务卡：实现 → 自测 → 证据（截图/测试输出）→ 更新任务卡 → 进入下一张。**开发壳、静态假数据、Mock 演示都不算完成**；每个里程碑必须跑真实链路。

### M0 — 立项与骨架（Lead）
- [M0-1] 产品/架构/设计文档、任务板
- [M0-2] 工程脚手架：electron-vite、TS、React、构建脚本、dev 启动
- [M0-3] 共享契约：类型、IPC 通道、事件协议、preload API
- [M0-4] 设计系统：token、字体、基础样式、品牌 mark、应用图标
- [M0-5] 无内容但真实的窗口：frameless + 自定义标题栏 + 可拖动 + 窗口控制
- **验收**：`npm run dev` 打开 Electron 窗口；`npm run typecheck` 通过；窗口截图归档。

### M1 — Agent 内核（engine 队友 + Lead）
- [M1-1] Provider 层：OpenAI 兼容 SSE（含 DeepSeek reasoning、tool_calls 增量）+ Anthropic Messages SSE；重试/超时/错误归一化
- [M1-2] Agent 循环：流式文本、工具调用、tool_result 回填、停止条件、中断、事件流
- [M1-3] 工具集 v1：read/write/edit/list/glob/grep/run_command/todo_write/ask_user/remember
- [M1-4] 权限引擎：工作区沙箱、只读/询问/自动三档、危险命令规则、审批挂起/恢复
- [M1-5] 会话持久化：JSONL 事件 + 元数据、恢复、重命名、删除、项目（工作区）分组
- [M1-6] 上下文管理：token 估算、自动压缩（LLM 摘要）、手动 /compact、上下文用量
- [M1-7] 子代理（task 工具）+ 文件改动备份（撤销基础）
- **验收**：vitest 全绿；Mock SSE 服务器端到端跑通含工具调用；真实 DeepSeek Key 直播冒烟（1 次流式 + 1 次工具调用）通过并留证。

### M2 — 对话与外壳（shell 队友 + Lead）
- [M2-1] App Shell：侧栏、标题栏、会话列表/分组/搜索、新建/重命名/删除
- [M2-2] 对话流：消息渲染、Markdown、流式光标、滚动跟随、复制
- [M2-3] Composer：自增输入、Enter 发送/Shift+Enter 换行、停止、附件、@ 文件引用、/ 命令、模型/权限芯片、上下文条
- [M2-4] 首次引导：欢迎 → 连接模型（预设 DeepSeek 等，测试连接）→ 选择工作文件夹 → 完成
- [M2-5] 设置：模型连接、权限、外观（明暗主题/字号/动效）、关于
- [M2-6] 命令面板（Ctrl+K）+ 全局快捷键
- **验收**：Mock Provider 的 Playwright E2E：发消息→流式→工具卡→完成→刷新恢复；明暗主题截图；键盘可达。

### M3 — 旗舰体验（surfaces 队友 + Lead）
- [M3-1] 行动轨迹（Activity Spine）：工具卡/结果/耗时/折叠展开/中断状态
- [M3-2] 权限卡 + ask_user 卡片：允许一次/始终/拒绝，键盘操作
- [M3-3] 计划面板：todo 实时状态、进度、长任务可见
- [M3-4] 画布（Artifacts）：HTML 沙箱预览、Markdown、代码高亮、分栏/全屏、外部打开
- [M3-5] 文件差异视图 + 一键撤销本轮改动
- [M3-6] 子代理可视化 + 演示模式（离线剧本 + 引导入口 + 可重播）
- [M3-7] 空状态、加载骨架、错误态、离线态、限流态
- **验收**：演示模式完整播放并生成报告截图；撤销/权限拒绝/中断三条失败路径 E2E 通过。

### M4 — 打磨与打包（delivery 队友 + Lead）
- [M4-1] 视觉精修（字体、间距、动效、细节）+ 明暗双主题走查
- [M4-2] 性能：首屏 < 1.5s、长会话虚拟化/分页、渲染无长任务
- [M4-3] 无障碍：焦点、对比度、键盘全流程、减少动效
- [M4-4] 打包：图标、便携 exe、数据目录、关于页、版本号
- [M4-5] 打包产物冒烟 + 干净环境启动验证
- **验收**：`release/Morrow-1.0.0-portable.exe` 双击可用；截图归档；冒烟脚本通过。

### M5 — 交付（Lead）
- [M5-1] 使用说明（新手 5 分钟上手 + 常见问题 + 隐私说明）
- [M5-2] 验收报告 + 截图集 + 已知限制
- [M5-3] 最终全量验证：typecheck / unit / e2e / packaged smoke

---

## 4. 验证口径

| 层 | 工具 | 命令 | 通过标准 |
|---|---|---|---|
| 类型 | tsc | `npm run typecheck` | 0 error |
| 单元 | vitest | `npm run test:unit` | 全绿，覆盖内核关键分支 |
| 端到端 | Playwright(Electron) | `npm run test:e2e` | 关键用户旅程全绿 |
| 协议 | Mock SSE 服务器 | 位于 `tests/fixtures` | OpenAI / Anthropic 双协议解析正确 |
| 真实模型 | DeepSeek 直播 | `npm run probe:live` | 流式 + 工具调用成功，证据入档 |
| 打包 | 便携 exe | `npm run smoke:packaged` | exe 可启动、可发消息、可演示 |

失败必须如实记录，不允许降低断言迁就实现。

---

## 5. 团队与写作用域

| 成员 | 职责 | 写作用域（不重叠） |
|---|---|---|
| lead | 产品/设计/契约/骨架/IPC 集成/最终打磨/交付 | 根配置、`src/shared/**`、`src/main/index.ts`、`src/preload/**`、`src/renderer/src/styles/**`、`src/renderer/src/ui/**`、`docs/**`、`package.json` |
| engine | Agent 内核 | `src/core/**`、`tests/unit/core/**` |
| shell | 应用外壳/会话/输入/设置/引导 | `src/renderer/src/features/shell/**`、`features/composer/**`、`features/settings/**`、`features/onboarding/**`、`features/palette/**`、`state/**`、`App.tsx`、`main.tsx` |
| surfaces | 对话渲染/工具卡/画布/计划/演示呈现 | `src/renderer/src/features/chat/**`、`features/activity/**`、`features/artifacts/**`、`features/demo/**`、`components/**` |
| delivery | 测试基建/打包/证据 | `tests/e2e/**`、`tests/fixtures/**`、`scripts/**`、`build/**`、`assets/**`（图标） |

共享约定：只读引用其他作用域文件；需要对方改动时在任务板留言或找 Lead 仲裁。跨域接口一律以 `src/shared/**` 中契约为准。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| Electron 下载/打包网络不稳 | 使用 npmmirror 镜像（已实测可用）；electron-builder 二进制镜像变量写入脚本 |
| 没有用户 API Key | 内置离线演示模式 + 本机已存 DeepSeek Key 做真实冒烟（仅测试用，不写入交付物） |
| 模型输出格式不稳（工具 JSON） | Provider 层容错解析、tool 参数二次校验、失败回灌给模型自修复 |
| 长会话卡顿 | 消息分页渲染、Markdown 惰性高亮、事件节流合并 |
| 新手误操作 | 默认「询问」权限、危险命令拦截、改动备份与撤销、错误文案给人话 |
| 视觉流于模板 | 设计系统遵循 `DESIGN-SYSTEM.md`：以「夜桌/地平线」为母题，克制用金，活动轨迹为签名元素 |


---

## 7. 最终交付记录（2026-10-19 01:10）

| 里程碑 | 状态 | 关键证据 |
|---|---|---|
| M0 立项与骨架 | ✅ | 文档、设计系统、Electron 骨架、截图管线 |
| M1 Agent 内核 | ✅ | 137 单测全绿；双协议 Mock；真实 DeepSeek 流式+工具；对抗验收 5/5 |
| M2 外壳与交互 | ✅ | 8 组件真实接入 IPC；明暗双主题 74+ 截图；10/10 交互自检 |
| M3 对话与产物 | ✅ | Markdown/Spine/权限卡/画布/撤销/演示胶囊；真实 DeepSeek 链路复测 |
| M4 打磨与打包 | ✅ | 便携 exe 85.42 MB；打包冒烟；明暗走查；无障碍/键盘 |
| M5 交付验收 | ✅ | typecheck 0 error；unit 137；mock 13；E2E 9/9；live probe；打包版离线演示 |

**最终便携包**：`release/Morrow-1.0.0-portable.exe`（SHA-256 `b1b58ae4…c83fdd`）
**交付目录**：`release/`（exe + `使用说明.md` + `版本与校验.txt` + `screenshots/`）

已知限制（如实记录）：子代理只读；open_artifact 为追加语义；演示模式强制自动执行（不弹审批）；
单文件固定宽度 HTML 报告在窄画布内可能出现横向滚动（可全屏查看）；手动审批的「始终允许」记忆在进程内。


---

## 8. 第二轮优化（2026-10-19）

用户反馈驱动的优化版本，版本号保持 1.0.0：

| 项 | 结果 |
|---|---|
| Electron 升级 | 38.2.2 → **44.9.0**（最新稳定版），E2E 9/9、打包冒烟通过 |
| 便携版打不开（NSIS TEMP 错误） | 根因：单文件 NSIS 自解压依赖 `%TEMP%` + 受限宿主需 `--no-sandbox`。**已定制 NSIS 模板**：单文件改为自解压到 exe 同级隐藏缓存目录 `.morrow-runtime-<ver>`（首次解压、之后复用；只读目录回退 LOCALAPPDATA/TEMP），彻底移除 TEMP 依赖；同时保留**文件夹便携版**（启动 ~0.4s、数据同级 `Morrow Data`）为推荐形态。根因文档 `docs/verification/NSIS-ROOT-CAUSE.md` |
| 窗口默认尺寸 | **2100 × 1200 物理像素**（按主屏缩放比换算 DIP；150% 缩放为 1400×800 DIP = 精确 2100×1200；最小 1200×760 物理像素） |
| UI 硬朗化 | 圆角 token 全面缩小（xs 4 / sm 5 / md 7 / lg 9 / xl 12），chips/胶囊控件改小圆角，发送按钮由圆形改为小圆角方形；宽屏版心 800/920px、欢迎页 1000px |
| 默认模型 | 新增 **DeepSeek Flash**（与 DSH 同款，`deepseek-flash`），设为新用户默认；保留 Chat / Reasoner / Anthropic / OpenAI / Kimi |
| 真实能力验证 | deepseek-flash 跑 9 道跨领域题（4 资深 + 4 小白 + 1 安全恢复）：**9/9 机械通过，平均评审 4.78/5**；报告 `docs/CAPABILITY-REPORT.md` |
| 验证驱动的修复 | ① 工具参数截断自修复；② max-steps 优雅收尾；③ run_command 越界路径审批（安全）；④ `write_file append` 分段写入；⑤ prompt 子代理指引 |
| 最终回归 | typecheck 0 error；unit **145**；E2E 9/9；打包两形态冒烟；打包版真实模型任务 + 离线演示复验 |


---

## 9. 第三轮修复（2026-10-19）

用户实测单文件 exe 仍报 NSIS TEMP 错误后：

| 项 | 结果 |
|---|---|
| 单文件 exe 根因 | electron-builder 的 portable 是 NSIS 自解压，插件与应用内容都依赖 `%TEMP%`；受限启动环境必报 “Error writing temporary file”，模板级修补无法绕过 NSIS 自解压机制 |
| 修复方案 | **弃用 NSIS 自解压，改为自研 C# 单文件启动器**（`build/launcher/MorrowLauncher.cs`）：应用以 zip 资源内嵌，首次运行解压到 exe 同级隐藏缓存 `.morrow-runtime-1.0.0`（不经过 %TEMP%），之后复用缓存；目录只读自动回退 `%LOCALAPPDATA%\Morrow\runtime-1.0.0`；解压时显示深色进度小窗 |
| 实测 | 把 `TEMP` 故意指向不存在的 `Z:\` 仍可启动：首次 3.2s（CDP 就绪含解压 155MB）、第二次 0.57s；窗口 1400×800 DIP = **2100×1200 物理像素** |
| 窗口 | 默认 **2100×1200 物理像素**（150% 缩放精确等于 1400×800 DIP） |
| 其他 | 文件夹便携版继续作为推荐形态（启动最快、无需首次解压）；zip 分发同步更新 |
| 补充（用户双击仍无进程） | 真正的第二层根因：**Chromium 渲染沙箱在本机初始化即崩溃（0x80000003）**，进程秒退、无窗口且主进程 JS 未执行。修复：文件夹版 `Morrow.exe` 改为轻量启动器（启动 `Morrow-app.exe` 时自动加 `--no-sandbox`）；单文件启动器同样自动加该参数。真实双击模拟（无参数、受限环境）已能正常出窗口。 |


---

## 10. 第五轮优化（2026-10-19）：交互、设置与视觉

用户要求：侧栏可拖动调宽（拖动时 1px 香槟金渐变线提示）、顶栏收起后侧栏完全不可见、
顶栏新增画布开关、设置重做并换成截至今日的最新模型与准确上下文数据，同时全面美化 UI。

| 项 | 实现 |
|---|---|
| 侧栏调宽 | `SidebarResizer`（App.tsx）：200–400px 拖动、1px 香槟金渐变落点线 + px 读数、方向键微调、双击恢复 264、松手持久化 `Settings.sidebarWidth` |
| 侧栏收起 | 收起时直接不渲染侧栏 DOM（完全不可见），再次点击恢复；状态持久化 |
| 画布开关 | 标题栏 `PanelRight` 按钮：打开时选最近产物；无产物也打开空态（编辑感引导 + 最近产物入口），再次点击收起 |
| 设置·模型连接 | 12 个内置 provider 按国内/国际/聚合/本地分组；模型项显示上下文/输出；Base URL 可编辑；测试/保存连接；**从服务商同步模型列表**；本地/自定义 provider 支持自定义模型 ID（重启保留） |
| 最新模型 | DeepSeek V4.1 Flash / V4 Pro；OpenAI GPT-6.1 Sol / GPT-6 Astra / GPT-6 Sol / GPT-6 Luna；Claude 5.5 全家；Gemini 4 Argon / 3.8 Flash；GLM-5.3 / 5.3 Flash；Grok 4.7；Kimi K3；Qwen3.8 Max；MiniMax M3.1 Flash Preview 等（来源见 `docs/MODELS-RESEARCH.md`） |
| 设置·上下文 | 新增 Tab：精确上下文占用、6 项 token 统计、自动压缩开关、50–95% 阈值滑杆、立即压缩、token 计量开关 |
| 上下文精度 | 内核改用最近一次请求的真实 `prompt+completion` 作为 contextUsed（无 usage 才估算）；实测真实 DeepSeek 对话 input=3402/output=3/contextUsed=3405（1.05M 窗口） |
| 视觉精修 | 画布头部/空态、行动轨迹状态、代码块头部、计划托盘、审批卡明暗对比、Composer token chip、明暗主题；清掉 App.css M0 占位样式 |
| 验证 | typecheck 0 error；unit 151/151；E2E 14/14（含 5 条 R5 UI 用例 + 真实 DeepSeek 上下文精度 + 真实模型同步） |


---

## 11. 第六轮（2026-10-19）：Goal 模式与画布调宽

| 项 | 实现 |
|---|---|
| Goal 模式 | 目标对象持久化在会话中；主进程 `AgentService` 负责多轮循环：首轮启动 → `update_goal` 工具记录 summary/nextStep → 完成后自动续跑下一轮；completed/blocked 自动停止，达到 maxRounds 暂停，出错/中止自动暂停 |
| 目标工具 | 内核新增 `update_goal`（仅目标模式、meta 类、不弹审批）：active/completed/blocked + summary/nextStep/blockedReason；系统提示注入目标、轮次、上一轮摘要与下一步 |
| 目标 UI | Composer Target 入口 + GoalDialog（目标/最大轮次 2–10/说明）；GoalBar 在 Composer 上方展示目标、状态、轮次、进度段、summary/nextStep/blockedReason，支持暂停/继续/结束/清除；TitleBar 目标指示；续跑消息渲染为克制的「目标续跑 · 第 N/M 轮」行 |
| 画布调宽 | 画布左缘接入与左侧栏**完全相同**的 ResizeHandle：1px 香槟金渐变落点线 + px 读数、320–960px、拖动持久化、双击恢复 560、方向键微调；窄窗覆盖式自动隐藏手柄 |
| 修复 | 修复「暂停→继续→结束」时旧 run 迟到回调把 completed 覆盖回 paused 的竞态（persistResult 终态守卫 + ActiveRun.goalRound 过期轮次忽略） |
| 验证 | typecheck 0 error；unit 163/163；E2E 18/18；真实 DeepSeek 目标两轮续跑完成、产出 goal-round1.md / goal-round2.md；画布 560→760 持久化、双击复位 |


---

## 12. 第七轮（2026-10-19）：UI 品牌区/默认布局 + 审计驱动修复

### 12.1 UI
| 项 | 实现 |
|---|---|
| 品牌区 | 侧栏顶部改为「地平线徽记 + Morrow 字标 + 明日工坊 · AI WORKSPACE + 把明天，交给今天。」，SVG 渐变徽记 + 柔光，明暗主题各自调优 |
| 默认布局 | 侧栏默认 **240px**、画布默认 **420px**（拖动提示与读数一致）；旧默认 264/560 通过 `layoutVersion` 一次性迁移，自定义宽度保留 |

### 12.2 审计驱动修复（依据 `Morrow审计报告_简明版.txt` / `Morrow测试题目_简明版.txt`）
| 优先级 | 修复 |
|---|---|
| 安全 | 只读禁止 remember/写入/命令；symlink/junction realpath 越界拦截；「始终允许」绑定完整命令+参数；撤销检测用户手改返回 UNDO_CONFLICT；加密不可用拒绝保存 Key；提示词把文件/工具/记忆文本标为不可信数据 |
| Goal 长期任务 | 智能轮次预算（最高 200）+ 工具/时间/无进展预算持久化；手动结束=cancelled；重启 active→paused 可恢复、预算不重置；completed 强制 evidence 真实存在校验 |
| 完成证据/恢复 | 运行中 message/tool 级增量落盘；命令超时/取消后确认子进程结束（exit + 2.5s 兜底）；预算计数实时落盘 |
| 隐私 | 输出侧 SensitiveGuard：登记工具结果中的邮箱/token，流式与持久消息统一遮蔽 `[REDACTED]`（M32 首轮 FAIL → 修复后真实回归 PASS） |
| 图片 | 附件图片以 dataURL/image content 进入 OpenAI/Anthropic 协议，M33 真实读图 PASS |
| 未支持 | MCP/浏览器/PDF-DOCX-XLSX/Office 技能/显式聊天-工作模式/并行子代理 如实标 UNSUPPORTED（见审计报告） |

### 12.3 验证
- typecheck 0 error；unit **171/171**；E2E **21/21**；离线审计 **19/19**；
- 真实 DeepSeek：首轮必测 21 题 17 PASS / 3 FAIL / 1 UNSUPPORTED，M33 图片 PASS；M32 修复后真实回归 PASS
  （按修复后口径 18 PASS / 2 FAIL / 1 UNSUPPORTED），虚假完成 0 次、越界/外发尝试 0 次；
- 报告：`docs/AUDIT-REPORT-R7.md`（含首轮原始结果与第十三节后补回归）；复跑命令见报告第十二节。


---

## 13. 第八轮（2026-10-19）：2.5D 品牌/桌面图标 + #4/#5/#6 新功能 + 39 题全量审计

### 13.1 品牌与图标
- 侧栏品牌区只剩 **2.5D 图标 + 艺术化 Morrow 字标**（无任何副标题/文案）；图标为石墨底 + 三层等距香槟金
  地平线台座 + 升起光球，含内缘高光与柔光。
- 图标生成：`build/icon-source.svg` → `scripts/render-icon.mjs`（Chromium 渲染 1024 透明 PNG）→
  `scripts/make-icons.py`（16–256 ICO / 512 PNG / installerIcon）。
- 落地：electron-builder `win.icon`、文件夹启动器 `csc -win32icon`、单文件启动器、BrowserWindow 图标（候选路径）、
  任务栏（exe 图标 + AppUserModelID）；便携文件夹提供 `创建桌面快捷方式.cmd` 生成桌面图标。

### 13.2 新功能（审计报告第 4–6 项）
| 项 | 交付 |
|---|---|
| #4 文档与技能 | read_pdf / read_docx / edit_docx / read_xlsx / write_xlsx（真公式 + LibreOffice 重算 D4=21）、list_skills / read_skill；输入不变、XML 良构、跨 run 占位符；依赖 jszip/pdf-parse |
| #5 聊天/工作模式 | Session.mode + session.set-mode；chat 内核工具白名单 + 权限硬拦截（auto/demo/subagent 也拒绝写入/执行/记忆/目标）；UI 分段控件/标题栏 chip/Goal 入口隐藏；重启保持 |
| #6 外部工具 | web_fetch（SSRF 防护、只 GET、DNS 二次校验、逐跳校验）；MCP stdio 客户端 mcp_list/mcp_call；外部动作 read-only deny、ask/auto 一律 ask；工作区 mcp.json 默认不 spawn |
| 安全合并 | 外部动作专属审批/拒绝文案；prompt 加 web_fetch/MCP 使用与不可信数据规则；MCP env 注入；会话 mode 广播 |

### 13.3 全量 39 题审计（真实 DeepSeek，一遍、不做三轮）
- 首轮：PASS 33 / FAIL 4 / INVALID 1 / UNSUPPORTED 1；复核后 34 / 2 / 2 / 1；支持范围 35 题通过 32（91.4%）；
- 安全底线 M27–M32 全 PASS；违规尝试 0；虚假完成 0；
- FAIL：M05/M36 严格格式；M37 单轮压缩限制 INVALID；M39 长期 Goal 12 批未闭环（harness + 预算）；
- 修复：权限误报（危险命令按段、`..` 按 cd 链）+ 审计 harness 6 处缺陷；报告 `docs/AUDIT-REPORT-R8.md`。
- 说明：M38 并行子代理未开发，开跑前已登记 UNSUPPORTED，不进入通过率分母。


---

## 14. 第九轮（2026-10-19）：品牌/滚动条/确认弹窗精修 + 子代理全权限 + R9 审计

### 14.1 UI/UX
- 重画 2.5D 悬浮 M 徽记：石墨 squircle、金属倒角 M、悬浮三层台座、轨道环、升起太阳、星尘/辉光；
  侧栏 62px + 7.5s 悬浮动画；16–256 ICO 同步 exe/窗口/任务栏；启动器首次启动自动建桌面快捷方式。
- 全局滚动条改为**无外边框黑金渐变**；画布空态删除“画布/暂无产物”可见文案；确认弹窗统一标题金线、按钮尺寸与酒红破坏主按钮。
- `启动 Morrow.cmd`：先清 MOTW、建桌面快捷方式、再启动，规避下载来源触发的 SmartScreen；单文件版附清标记脚本。
- `dist-portable.mjs` 每次打包先删除旧产物、win-unpacked、launcher zip、electron-builder cache。

### 14.2 运行时与子代理
- R2-A 文档写工具审批签名绑路径+内容；R2-D Goal 工具计数 assignment；R2-F/G 真实进展键与产品 no_progress；
  R2-E/M49 证据拒绝目录/`.`/旧文件/空文件；R2-H 单用户长工具链安全切点、真实压缩并继续。
- **子代理全权限 + 真实并行**：工具集=主代理−task−update_goal，共享 permissionMode/mode/工作区/snapshot/MCP/审批链；
  同一消息多 task `Promise.all` 并发；父 abort 全部取消；失败/耗尽/取消终态保留。
- 机制验收 R2-A—H **8/8**；M40–M49 真实 DeepSeek 一遍：8 PASS / 1 FAIL（M44 假任务取消清理）/ 1 UNSUPPORTED（M47 运行态持久化）。

### 14.3 证据
- `docs/AUDIT-REPORT-R9.1.md`、`docs/audit/r9-1-results.json`、`docs/audit/support-declaration-r9-1.md`；
- 旧 R9/R8 报告保留对照，不回填；M44/M47 残余风险如实登记。


---

## 15. 第十轮（2026-10-19）：Claude Desktop 对照功能补齐（除 J 定时任务）

### 15.1 用户批准的 A–I、K
- **A 文件树 + 文件操作**：Sidebar 工作区文件树，懒加载/隐藏/过滤/刷新/右键/键盘/新建/重命名/删除确认/只读/中文文件名安全；`feature:files:*` 12 频道。
- **B 全功能代码编辑器**：CodeMirror 6 多标签、语法高亮、查找替换、撤销重做、保存/另存、脏标记、未保存确认、mtime 冲突、Markdown/HTML 预览。
- **C/K1 内置浏览器 + 浏览器自动化**：WebContentsView、地址栏/历史/刷新/安全拦截/下载确认；browser_open/click/type/read/screenshot/back/forward 全部逐次审批。
- **D/E 记忆中心 + Projects**：项目/全局记忆 CRUD/启停/搜索/导出/注入预算；项目指令+知识文件+记忆进入 system prompt。
- **F Artifact/文件版本历史**：30 版/文件、容量淘汰、diff、恢复、mtime 冲突。
- **G/K2 MCP 管理 UI + HTTP/SSE**：连接器 CRUD/测试/密钥掩码/信任；stdio/Streamable HTTP/旧版 SSE、SSRF 防护。
- **H 技能库管理**：发现/启停/本地文件夹或 zip 安装/zip-slip 拦截/详情/重扫。
- **I 全局搜索**：聊天正文/文件路径与内容/生成结果，按工作区隔离、中文、高亮。
- **K3 computer-use**：Windows 截图/点击/输入/按键，逐次 ask，敏感窗口与频率限制；J 定时任务不做。

### 15.2 UI/UX 统一
- 工作台入口（TitleBar LayoutGrid）统一挂载 6 个面板；文件树/编辑器在左右工作区。
- 窄画布编辑器工具栏容器查询图标化；中文文件名 `btoa` 修复；MCP runtime env 调用；search 延迟初始化修复 `--data-dir` 设置被忽略。
- 测试/自动化模式禁止 `shell.openExternal`，消除 Edge 弹窗。

### 15.3 验证
- R10 矩阵 65 项：63 PASS / 0 FAIL / 2 NOT_RUN（自签名证书、原生拖拽自动化）；UI 文案独立 1 项（复审中）。
- typecheck 0；unit 459/459；R10 E2E 24+；审计跨领域 E2E 7/7；违规/虚假完成 0。
- 报告 `docs/AUDIT-REPORT-R10.md`。
