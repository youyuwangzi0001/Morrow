# Morrow 0.2.0 验收记录（r049）

> 日期：2026-10-28 · 版本：0.2.0 · 运行时：r049 · 平台：Windows 10/11 x64
>
> 交付形态：单文件便携版 + NSIS 安装包 + 源码包
>
> 结构说明（2026-10-28 扁平化后）：本文件较早段落中的 `src/main/services/*`、`src/main/studio/*`、`src/renderer/src/*` 等路径是历史记录；当前源码已扁平为 `src/main/*`、`src/core/*`、`src/renderer/features/<功能域>.tsx`。当前规模：生产源码 104 个代码文件 / 8 个目录；单元 14 套件 / 1020 用例；E2E 7 个领域 spec / 221 用例（201 passed + 20 skipped，0 failed）。

## 0.2 当前工作区回归（2026-10-28，r050 候选）

| 范围 | 实现 | 结果 |
|---|---|---|
| 无工作区终端 | 请求目录不存在时回退到 HOME；Git Bash 受限令牌退出后按 pwsh → cmd 依次回退；用户主动停止/重启不触发回退；Windows 始终保留 cmd 兜底 | 单元终端 8/8；E2E `真实终端…` 与 `没有工作区时终端回退…` 2/2 |
| 40 秒创作台演示 | 六幕线性播放（一句话 → 蓝图 → 分镜 → 声音 → 剪辑 → 交付），真实 12 镜头样例、暂停/重播/关闭与结尾 CTA；无上一步/下一步跳转 | `19-studio-ux` + `demo-enter-sample` 通过；1280/1920、明暗主题逐幕截图无遮挡 |
| 生产/测试扁平化 | 生产代码收敛到 `src/main`、`src/core`、`src/renderer/features`；测试合并为 7 个领域 spec + 共享启动器 | `typecheck` 0 error；单元 14 套件 / 1020 用例（1011 passed + 9 skipped） |
| 全量 E2E | 7 个 spec 依次执行，未并发重建 `out` | **201 passed + 20 skipped，0 failed**；打包版专项 6/6（win-unpacked 与 deliver 文件夹各复跑一次） |
| 画布/交付/检查页布局 | 画布操作条上限 960px、按钮不收缩；交付视频按容器高度填充、信息层移至顶部，原生控件不再被裁切；检查页页脚整项换行、短语不断词 | `31-studio-layout` 2/2；1360/1680/2100 实图核对 |
| 打包冒烟 | `dist:all` 重建便携 exe、安装包、文件夹版；`smoke-packaged --all` 真实启动两种形态 | 单文件便携 **通过**、文件夹版 **通过**；源码包已按当前工作树重打 |
| E2E 启动弹窗 | 启动前预检 `out/main/index.js`，缺失时直接给出可读错误，不再让 Electron 弹「Unable to find Electron app」并挂起 | 7 个 spec 全程无启动弹窗 |
| 创作台排版统一 | 演示区取消 `ui-token-audit:off` 豁免；字号/字重/行高/字距全部映射到 Agent 令牌；新增 `--lh-reading-tight/reading/loose` 供长文纸页使用 | `npm run audit:ui` 通过：27 CSS + 29 TSX，0 处裸排版值 |
| 工具条重叠与超框 | 新增顶层 `--bar-height/--bar-pad-x/--bar-gap/--bar-control-h`；时间线工具条禁止换行、按钮不收缩，中栏 <760px 折叠为图标模式，<620px 收起交付入口 | 1280–2100 六档宽度、两份样例、九个阶段（含协作者展开）自动审计 0 处文字越界/重叠；新增 `31-studio-layout` 回归用例 |

回归口径：`npm run typecheck && npm run audit:ui && npm run test:unit`，随后 `npx playwright test tests/e2e/studio.spec.ts`、`workspace.spec.ts`、`chat.spec.ts`、`journey.spec.ts`、`ui.spec.ts`、`packaged.spec.ts`、`real.spec.ts` 依次执行。E2E 合计约 14 分钟。

## 0.1 r047 历史改动与验证

## 0. r049 本轮改动与验证

| 需求 | 实现 | 结果 |
|---|---|---|
| 创作层 × 质检层融合 | 新增 `src/main/studio/quality.ts`：七维定义、通用六条门禁、分形态硬门禁、本地可计算指标；`prompt-library.ts` 升级到 29 组手法，并把 `creativePromptContext()` 与 `qualityPromptContext()` 拼进蓝图/大纲/正文/分镜/助手全部生成调用 | `prompt-quality.test.ts` 7/7；`quality.test.ts` 指标与门禁用例通过 |
| 质检提示词参考排查 | 排查 `D:\AI资料\超无穹科技`：Agent 阵法中 polish/narrative-engine/outline/storyboard/script-creator 有实质量化规则；大量 `*-agent` 与 checklist 是空壳；截图中的 craft-os/十段链/49-novel-gate 等当前文件未找到，未编造引用。来源与阈值写入 `docs/QUALITY-FRAMEWORK.md` | 文档完成；框架可核对到来源 |
| 漫剧 9 步真实链路 | 素材入库自动让时间线过期；合成前强制核对“有素材的镜头都有片段”；音频失败写入 error 并让成片降级为需核对；空字幕拒绝导出空 SRT；无成片拒绝发布套组；新增“一键做到草稿”；配音/音乐/画面阶段点选后落到分镜板或对应片段；本地配乐草稿入口可见 | `18-studio` 2/2、`20-studio-workspace` 3/3、`21-studio-responsive` 3/3（合入交付页）、`19-studio-ux` 2/2；全量 E2E 结果见下 |
| 中短篇 5 步真实链路 | 首页新增 3/5/8 万字目标选择并真正写入 brief；蓝图/章纲提示词消费题材、受众、语气、风格、硬约束；蓝图校验总字数≥目标 60% 与最少章数；章正文低于目标 55% 自动补写一次；目标字数/时长保存读回不再丢失 | `service-model.test.ts` 4/4；`store.test.ts` 目标保留用例通过 |
| 长篇 6 步真实链路 | 章数由目标字数推导（36–240 章），每章目标 2000–5000 字；分批生成少返回即失败；卷区间自动对齐总章数；每章写前带卷目标、前 3 章摘要、上一章结尾、全局人物事实；事实不再全部绑到第 1 章；配图采用后更新画面阶段 | `service-model.test.ts` 长篇 36 章/3 卷断言通过；模型审稿用例通过 |
| 模型审稿与导出闸门 | 新增 `model-review` 真实文本模型任务：七维评分 + 章节证据 + 问题写回检查；导出最终稿前拦截未解决 error；非最终格式只标“草稿或中间文件”；`model-review` 后交付页可见七维摘要 | `service-model.test.ts` 模型审稿用例通过；`18/19/29` 回归通过 |
| 测试套组整合 | 5 个纯函数单测合并为 2 个，`22-studio-delivery-responsive` 并入 `21-studio-responsive`；删除重复 about 断言与重复 pageerror；用例零删除 | 单测 32 套件 / 1030 用例（1021 passed + 9 skipped）；E2E 33 套件 / 232 用例 |
| UI 错位与重叠 | 剧本页工具条与场景卡之间补 14px 间距；≤1320 镜头详情保留 366px 内容避让；素材抽屉按协作者状态偏移；交付画幅默认读项目比例；检查页未运行检查时不再显示 6/6 就绪；字幕开关/添加分成两个明确按钮 | `21-studio-responsive` 新增 1280/3840 间距断言；18/19/20/21/29 11/11 通过 |
| 交付与渲染断链 | 发布套组校验成片/字幕文件真实存在；成片占位、缺配音、音频失败都让交付降级为需核对；导出前重跑过期检查并拦截 error；合成前拦截缺配音的正式成片 | `service-model`、`timeline` 通过；18/19/21/29 回归通过 |
| 长篇字数规格 | 长篇每章改为 2000–5000 字；章数按目标字数推导（36–240 章）；单章目标与手动改章都夹在同一区间 | `service-model` 长篇 36 章断言与 2000–5000 区间断言通过 |
| 三项交付 | 清理 tmp、release、旧便携文件夹、zip、使用说明、SHA256SUMS、LICENSE、源码侧车与运行时缓存；`deliver/` 只保留便携包、安装包、源码包；用户数据移出工作区备份 | 交付目录 3 个文件；便携/文件夹冒烟通过 |
| 冗余代码精简 | 删除未引用 `isoStamp`、`resetStudioServiceForTest`、`timelineSnapshotForUndo`、4 个未接入 IPC 的 request 类型、未使用组件/hooks、重复 `formatBytes`/`copyToClipboard`/`clipTrackKind` 等，约 160 行 | `npm run typecheck` 0 error；`npm run audit:ui` 通过 |



| 需求 | 实现 | 结果 |
|---|---|---|
| Agent 首页回退，删除“进入创作台” | 移除欢迎页的进入卡片与配套样式；创作台从顶栏按钮进入，首页不再重复放入口 | `19-studio-ux` 通过，断言 `.welcome-studio` 为 0 且顶栏按钮可见 |
| 删除作品后的回收站 | 创作台设置新增「回收站」子页：列出已删除作品、恢复到作品库、彻底删除（二次确认）；页头仅保留一行完整说明 | `28-studio-trash` 通过；`tests/unit/studio/trash.test.ts` 覆盖删除/列出/恢复/彻底删除与非法条目拒绝 |
| 交付页与大纲页挤压 | 交付/检查/蓝图/大纲在主区变窄时改为纵向排布，按钮与操作不再竖排或单字成列；三档窗口统一为 1280×720 / 2100×1200 / 3840×2160 | `21-studio-responsive` 通过（已并入交付页与大纲页响应式：三档无横向溢出、无竖排按钮、交付主区单/双列与页头断言；1280 大纲页纵向排列截图） |
| 写作台精简 Office 体验 | 文档工具条：撤销/重做、查找替换（Ctrl+F）、字号/行距/页宽、字数统计（字数/字符/段落/阅读时间/目标进度）、导出 Word；排版只改视图不改正文 | `29-writing-desk` 通过：替换后撤销、大/宽松/宽排版、字数统计与 Word 任务完成 |
| 仅跑受影响 E2E | 本轮按改动范围执行 18/19/20/21/22/27/28/29，不重跑全量 | **13/13 通过**（18: 2、19: 2、20: 3、21: 2、22: 1、27: 1、28: 1、29: 1） |

### 0.1 r046 三形态真实链路复验（本轮未改文本/媒体引擎，沿用）

| 模块 | 步骤与真实引擎 | 结果 |
|---|---|---|
| 漫剧 9 步 | 蓝图（文本模型）→ 大纲（文本模型）→ 分镜（文本模型）→ 画面（ComfyUI Qwen-Image）→ 配音（Windows 声线/云端 TTS）→ 配乐（ComfyUI ACE-Step）→ 时间线（真实计算）→ 检查（规则+视觉模型）→ 草稿成片（FFmpeg） | `98-real-drama` 通过（3.4m）：5 场/14 镜，首镜 Qwen 图 2.1MB，ACE-Step 12s 配乐入库，时间线 16 片段，107s 草稿 MP4 2.9MB。配音在自动化 Electron 令牌下被系统语音拒绝，测试用随包真实录音继续验证下游；同一 `synthesizeSpeech` 在 Node 单元测试生成真实 WAV 通过（`local-tts.test.ts`）。 |
| 中短篇 5 步 | 蓝图 → 大纲 → 写作（模型候选）→ 检查 → TXT 交付 | `94-real-short` 通过（2.5m）：12 章骨架、章纲模型、首章 2190 字候选、润色候选、检查记录、TXT 7086B。 |
| 长篇 6 步 | 分卷蓝图（每卷每批 4 章）→ 分批章纲（每批 12 章）→ 写作 → 章节配图（ComfyUI）→ 检查 → EPUB | `93-real-long` 通过（6.8m）：3 卷 36 章、36 章章纲、首章 2761 字、Qwen 配图 1.8MB、EPUB 21KB。 |
| 小说改编漫剧 | 文本模型读已写章节 → 场景/镜头 → 保留 `sourceChapterId` | `95-real-adapt` 通过（1.8m）：12 场/30 镜，12 个来源章节全部映射。 |
| 配乐单独链路 | ComfyUI ACE-Step 1.5 Base | `96-real-music` 通过（18s）：8s MP3 325KB，`origin.source=comfyui`，阶段完成。 |
| ComfyUI 端口回退 | 8188 被 Windows 保留区占用 → 自动选 8288 并写回设置 | `91-comfy-port` 通过（33s）：引擎在线，模型清单含图片/视频/配乐。 |

真实链路测试共 6 个（含 98 的配音边界说明），另有长篇导出复核 `92-real-export` 通过（EPUB 24KB）。

## 1. 结论

- 类型检查：`npm run typecheck` **0 error**。
- UI 令牌审计：`npm run audit:ui` **通过**，27 个 CSS + 29 个 TSX，0 处裸排版值。
- 单元测试：**14 个套件 / 1020 个用例**（1011 passed + 9 skipped）。
- E2E（当前工作区全量）：**7 个领域 spec / 221 个用例，201 passed + 20 skipped，0 failed**（约 14 分钟）。跳过项为真实账号、本机模型、真实短片与打包版环境边界；打包版专项 6/6 通过。
- 真实模型联调（`MORROW_REAL_MODEL=1`）：r046 已验证漫剧/中短篇/长篇/改编四条链路全部通过；r047 仅涉及界面、回收站与写作台工具，未改模型/媒体链路。
- 本地创作引擎：`src/main/studio/local-creative.ts` 及其测试**已删除**；蓝图、大纲、正文、润色全部只调用真实文本模型，未连接模型时明确报错并引导去设置连接，不再回退结构稿。
- 三份内置样例：随包冻结数据，演示与样例不依赖本地引擎；E2E 27 验证三份样例都能打开并继续手改保存。
- 右栏分隔线：悬浮单线高亮、按住并移开指针保持同一条线、松开移开后熄灭；Studio 协作者栏与 Agent 右侧聊天栏均通过真实指针测试。
- 三档响应式：1280×720 / 2100×1200 / 3840×2160 与页面边距、1px 分隔线均提取到顶层令牌；交付页、大纲页、检查页与蓝图页在窄主区不再挤压。
- 交付：**3 个分发文件**（便携包 / 安装包 / 源码包；大小与哈希见第 5 节）；运行时 `.morrow-runtime-0.2.0-r049`。

## 2. r046 需求与结果

| 需求 | 结果 |
|---|---|
| 蓝图必须根据用户灵感调用已配置模型 | 通过；首次生成即调用模型，长篇按骨架/人物/每卷章节分批生成 |
| 清除默认都市奇幻/雨伞模板 | 通过；新作品默认类型留空、标题先显示“未命名作品”，模型返回后写入正式标题；下游镜头/正文无雨伞默认 |
| 漫剧、中短篇、长篇下游假实现 | 正文/润色/连续写作/分镜/改编必须模型；画面与配图走 ComfyUI，配乐走 ACE-Step，配音走系统/云端 TTS，合成走 FFmpeg；引擎未就绪时明确失败，不用本地模板或程序化草稿冒充正式内容 |
| 完全删除本地创作引擎 | 通过；`local-creative` 已删除，Agent 工具也不再有 `useModel:false` 的本地回退入口 |
| 清理不再使用的提示词 | 通过；随本地引擎删除章纲/正文模板与雨伞专用提示；保留 Agent 阵法创作手法库 |
| 底层提示词内嵌真实引擎并智能适配 | 通过；蓝图、长篇骨架/人物/章节、大纲、正文、润色、助手回答、插图/分镜/视频按任务和用户原话打分调取 |
| 右侧分隔线与终端顶部分隔线 | 通过；均为 1px 香槟金线，悬浮/按住提亮，移开恢复；Studio、Agent 侧聊与终端均有真实指针断言 |
| 三份样例可继续创作 | 通过；E2E 27 打开三份样例并验证短篇手改保存；E2E 18/19 验证长篇写作与演示 |
| 清理三份样例之外测试项目 | 通过；代码与测试只引用三份样例；`deliver/Morrow Data` 中测试项目已移入 `tmp/quarantine-r045`，仅保留三份样例 |
| 全局 token 预算提示 | 通过；超频模式长文案替换为唯一一句「你的token预算无上限」，provider 工厂对 Agent、子代理、创作台、侧聊、订阅回环统一注入 |

## 3. 关键实现

### 3.1 模型优先的创作链路

- `StudioService.generateBlueprint`：没有可用文本模型或明确 `useModel:false` 时直接抛错；模型调用失败不让任务假装成功。
- 长篇使用 `generateLongNovelBlueprint`：骨架、人物、每卷章节（每批 4 个单元，JSON 语法失败自动重试一次）分别调用模型，再合并卷范围、章节索引与总费用。
- `generateOutline` 对超过 16 章的作品按每批 12 章分批细化，避免一次输出 36 章被截断；`generateChapter`、`polishChapter`、`batchWrite` 均要求模型；本地不再生成正文模板。
- 漫剧分镜由 `generateStoryboard` 调用模型生成场景/镜头/台词；已有素材时只更新无素材镜头；`adapt-to-drama` 用模型读取已写章节并保留来源章节。
- 模型 JSON 容错：`extractJson` 会修复漏键名引号、裸键名、多逗号与裸换行，减少推理模型偶发手误导致的整批失败。
- `normalizeModelBlueprint` 只在模型给出标题时更新作品名；不再从灵感截取本地标题。

### 3.2 本地引擎删除与样例冻结

- 删除 `local-creative.ts`：本地蓝图、章节草稿、改写、雨伞/历史/通用镜头计划与样例生成器全部移除。
- 新增 `blueprint-apply.ts`：只做结构落地（蓝图→章节/镜头、场景分组、提示词拼装），不发明故事内容；漫剧缺少场景时直接报错要求重新生成蓝图。
- 新增 `demo-data.ts` + `demo-fixtures.json`：三份样例的蓝图、人物、章节标题与正文、示例候选冻结为随包数据，演示仍走真实界面。
- `deliver/Morrow Data` 只保留《雨停之前》《雨伞铺的第七个夏天》《逆行的伞》；非样例测试项目已隔离。

### 3.3 提示词库

- `prompt-library.ts` 保留 22 组 Agent 阵法创作手法。
- 蓝图调用按灵感选择故事核、人物、世界规则、场景发动机、开头钩子等模块。
- 长篇骨架/人物/章节调用分别选择故事、人物、结构模块；大纲、正文、润色、助手、插图、分镜、视频继续使用同一评分器。
- 删除本地引擎特有的章纲模板、雨伞专用镜头和“本地结构稿”提示。
- 超频模式改为唯一一句「你的token预算无上限」；`UnlimitedBudgetProvider` 在 `createProvider` 出口统一前置注入，并去重。

### 3.4 全局预算提示与分隔线

- `ResizeHandle` 用 `is-hovered` / `is-dragging` 状态驱动一条 1px 香槟金线；手柄 `z-index:199` 高于可停靠面板与侧聊浮层。
- 高亮时面板自身边框透明，保证只有一条线；拖动中指针移开手柄，`body[data-resize-target]` 保持高亮；松手并移开后熄灭。
- Studio E2E 断言 hover/held/away/afterUp 的 `::after` opacity 与面板边框；Agent 侧聊 E2E 同样验证。
- 终端顶部分隔线独立实现：基准为 1px 香槟金（`--gold`，0.45 不透明度），悬浮/按住变为 `--gold-bright` 并带微光，移开且未按住恢复基准；E2E 11 验证三态与截图。

### 3.5 三档响应式、回收站与写作台（r047）

- 顶层令牌：`tokens.css` 增加 `--app-viewport-min/default/max`（1280/2100/3840）、`--app-page-gutter`、`--divider-size/-idle/-active/-glow/-transition`，ResizeHandle、终端顶线与画布拖拽线共用同一组 1px 香槟金分隔线。
- 响应式：`.studio-center` 声明 `container-name: studio-center`；交付/检查在 ≤1500 收为单列、≤1200 页头纵向、≤720 隐藏幽灵标签；蓝图 ≤1200 页头纵向、操作换行、主体单列；大纲/剧本 ≤1100 页头纵向、说明占满整行、操作位于说明下方。
- 回收站：主进程 `StudioStore` 新增 `listTrash/restoreTrash/purgeTrash`，条目名严格校验 `id-时间戳`；恢复前检查同 ID 作品不存在，恢复后重建索引并广播作品库；设置子页提供恢复与彻底删除（确认弹窗），页头只有一行说明。
- 写作台：文档工具条接入 CodeMirror 的 undo/redo、查找替换（全量匹配与循环定位）、字号/行距/页宽（写入 `data-paper-*`，只改视图）、字数/字符/段落/阅读时间/目标进度与导出 Word；Ctrl+F、Ctrl+S 快捷键与排版偏好按本机记忆。

## 4. 验证门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 58 CSS + 84 TSX，0 裸排版值 |
| `npm run test:unit` | 34 文件（33 passed + 1 skipped）/ 1023 用例；1014 passed + 9 skipped |
| E2E 18 创作台核心 | 2/2（r047 复跑） |
| E2E 19 创作台 UX | 2/2（r047 复跑，含首页无重复入口） |
| E2E 20 画布/布局/协作栏 | 3/3（r047 复跑，设置五页） |
| E2E 21 响应式三档 | 2/2（r047，1280×720/2100×1200/3840×2160） |
| E2E 22 交付页/大纲页响应式 | 1/1（r047；三档无竖排、无溢出，1280 大纲纵向） |
| E2E 27 三份样例继续创作 | 1/1（r047 复跑） |
| E2E 28 回收站 | 1/1（r047；恢复、彻底删除、单行说明） |
| E2E 29 写作台 | 1/1（r047；查找替换、撤销、排版、字数、导出 Word） |
| r047 受影响 E2E 合计 | **13/13 passed，0 failed** |
| 全量 E2E（r046 基线） | **209 passed + 20 skipped，0 failed**（15.4m；r047 按用户要求只跑受影响套件） |
| E2E 01 UI 冒烟（r046） | 20/20（含侧栏拖动金色提示线） |
| E2E 02 聊天与侧聊（r046） | 含右侧栏三态高亮断言，通过 |
| E2E 11 终端分隔线（r047 期间复跑） | 1/1（悬浮/按住/移开三态与截图） |
| 真实漫剧 9 步（98） | 1/1（3.4m；蓝图/大纲/分镜模型，Qwen 图，ACE-Step 配乐，FFmpeg 草稿） |
| 真实中短篇 5 步（94） | 1/1（2.5m；12 章、首章 2190 字、润色候选、TXT） |
| 真实长篇 6 步（93） | 1/1（6.8m；3 卷 36 章、分批章纲、首章 2761 字、Qwen 配图、EPUB） |
| 真实小说改编（95） | 1/1（1.8m；12 场/30 镜，来源章节保留） |
| 真实配乐（96） | 1/1（18s；ACE-Step MP3 入库，阶段完成） |
| 真实导出（92） | 1/1（EPUB 24KB） |
| ComfyUI 端口回退（91） | 1/1（8188 被占用 → 8288，设置写回） |
| 本机配音引擎（单元） | 1/1（真实 WAV；Electron 自动化令牌受限，见第 7 节） |
| 便携版冒烟（r047） | 1/1（真实 exe 启动、渲染、截图，见 smoke-packaged.json） |
| 文件夹版冒烟（r047） | 1/1（原地运行、portable.marker 数据目录，见 smoke-packaged-folder.json） |

## 5. 交付物

交付主产物为三项：便携包、安装包、源码包。内部构建同时保留便携文件夹、zip、使用说明、SHA256SUMS 与 LICENSE，供打包冒烟与便携副本测试；用户数据独立保存在 `C:\交付成品\Morrow-user-data-backup-r048`，不计入分发。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 220,408,832 B / 210.19 MiB | `15ca7437e90a7ebe5b0530bef33e09fce285165d6115dd4fcede75727d9f9912` |
| `Morrow-0.2.0-setup.exe` | 168,273,799 B / 160.48 MiB | `13e44572f4ffdb706dc8a5ebbb94d5c9220efd515e34328b793080c08f262714` |
| `Morrow-0.2.0-source.zip` | 约 45 MiB | 见同目录 `.sha256` 侧车 |
| **交付合计** | **约 416 MiB** | 未签名（signed:false） |

便携版运行时为 `.morrow-runtime-0.2.0-r020`；单文件便携版与文件夹版冒烟均通过。

## 6. 源码包

`Morrow-0.2.0-source.zip`：由当前工作树的临时 Git index 生成（`git read-tree` + `git add -A` + `git write-tree` + `git archive`），包含全部未提交改动与最终文档；大小与 SHA-256 以打包时生成的 `.sha256` 侧车为准。

## 7. 验证边界

- r049 跑全量 E2E：33 个套件 / 232 用例，212 passed + 20 skipped，0 failed（14.6m）。跳过项为真实账号、本机模型、真实短片与打包版环境边界；真实模型联调未在本轮重跑，r046 结果沿用。
- 全量 E2E 的聊天历史滚动跟随用例在满载并行时偶发失败，单独运行通过；不是创作台链路回归。
- 打包版冒烟：本轮用真实便携 exe 与便携文件夹启动验证窗口/渲染/截图及 portable.marker；未重新执行系统级安装/卸载流程。
- 本机未配置代码签名证书，便携版与安装包未签名；首次运行可能触发 SmartScreen，请用第 5 节的 SHA-256 校验。
- 分镜画面、云端 TTS、云端文本模型仍需要用户自己的 ComfyUI/服务商 Key 与额度；未就绪时任务明确失败，不伪造结果。ACE-Step 配乐同样需要本机 ComfyUI 模型；设置页可检测/下载。
- 本机配音脚本在 Node 直调下生成真实 WAV（`local-tts` 单元测试）；Playwright/Electron 受限令牌下 SAPI/WinRT 会拒绝，E2E 98 因此用随包真实录音验证下游。正常桌面启动的打包版沿用同一脚本，云端 TTS 仍作为可选路径。
- ComfyUI 默认 8188 在部分 Windows 上落入系统保留区；本轮增加自动端口回退并写回设置（E2E 91）。首次启动可能多等一次端口探测。
- FFmpeg 检测与本地配音依赖本机环境；干净机器字体与无 FFmpeg 导出矩阵沿用上一轮边界。

## 8. 维护

- 新功能合并前更新 `STUDIO-TASKS.md`、`USER-GUIDE.md`、`STUDIO.md`。
- 模型/协议变化更新 `MODELS.md`、`SUBSCRIPTIONS.md`、`MEDIA-MODELS.md`。
- 视觉变化更新 `DESIGN-SYSTEM.md` 与 `docs/guide/screens/`（重新跑截图用例，运行 `python scripts/optimize-guide-screens.py` 压缩，并更新 manifest）。
- 每次发布更新本文件的规模表、门禁结果与交付哈希。
