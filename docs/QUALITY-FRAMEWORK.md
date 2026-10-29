# 底层提示词与质检

**结论：创作台不再内嵌自己的创作手法库或质量门禁。** 所有创作判断只来自三套内嵌的大师方法；本地只保留可计算的质量指标、连续性检查与交付检查，用来发现硬问题，不冒充文学判断。

## 1. 三套大师方法

| 套组 | 负责 | 入口 |
|---|---|---|
| 写作大师 | 中短篇/长篇的蓝图、大纲、章节、改写、审稿 | 非漫剧任务；漫剧的章节改编按任务选择 |
| 编剧大师 | 改编、剧本、漫剧蓝图与大纲 | `adaptation` / `screenplay`；漫剧 blueprint/outline 或当前页为 blueprint/outline |
| 导演大师 | 分镜、画面、视频、配音、音乐、时间线、漫剧助手 | `storyboard` / `image` / `video` / `music` / `voice`；漫剧其余页面 |

同一时刻只加载一套，避免三套方法互相打架。选择逻辑在 `src/main/creative-masters.ts`。

![蓝图由大师方法驱动](guide/screens/29-studio-blueprint-dark.png)

### 1.1 主文件与方法论

- 主文件按任务选段：蓝图取输入兼容/任务路由/前两步；大纲取第二步/第三步；章节取第三/四/五步；改写取第五/六步与自检；审稿取第六步/自检/长篇检查点；助手取任务路由/第一步/第五步/自检。
- 方法论按任务取 1–2 份：例如写作用 `story-structure.md` + `character-design.md`，章节用 `scene-dialogue.md` + `prose-craft.md`，分镜用 `shot-design.md` + `storyboard-format.md`。
- 编剧大师当前是单文件，不附方法论。

### 1.2 内嵌与预算

- 三套内容编译在 `src/main/creative-prompts.generated.ts`：gzip + base64，运行时由 `creative-masters.ts` 解压到内存。
- 不再读取桌面文件夹、`resources/prompts`、`MORROW_CREATIVE_PROMPTS` 或 `process.resourcesPath/prompts`；`package.json` 的 `extraResources` 只有 pdf-ocr、studio-demo、tts。
- 默认预算 22,000 字符，夹在 4,000–60,000；按模型上下文窗口给 34k/27k/20k/13k/7k。主文件最多约 70%，方法论吃剩余预算，超长时在段落边界截断并注明。
- 重新生成脚本 `scripts/embed-creative-prompts.mjs` 只供维护者使用；`npm run build` 不调用它，运行时不依赖外部提示词文件。

## 2. 协作者契约

协作者是创作台唯一的“用自然语言改作品”入口。每次请求包含：

![协作者计划](guide/screens/18-studio-assistant-dark.png)

- 当前步骤（`focusedStage`）与当前页可用选中项（章节/镜头/片段）；
- 作品快照：故事核、人物、地点、风格、大纲、章节摘要、分镜/台词/声线、声音素材、当前选中项；
- 一套大师方法；
- 输出契约：只输出 `{"reply":string,"actions":[...]}`，不输出方法步骤，不声称已经修改。

### 2.1 动作集合

| 类别 | 动作 |
|---|---|
| 蓝图 | `update-blueprint` |
| 大纲 | `replace-outline`（支持局部单元） |
| 章节 | `update-chapter` / `rewrite-chapter` / `move-chapter` |
| 镜头 | `update-shot` / `move-shot` / `append-shots` / `regenerate-shot-image` / `regenerate-shot-video` |
| 人物/地点 | `update-character` / `update-place` / `rename-entity` |
| 声音 | `regenerate-voice`（单镜或 `scope: all`）/ `generate-sfx` / `remove-sfx` / `generate-music` / `remove-music` |
| 时间线 | 本地 `set-clip-speed` / `set-clip-volume` / `set-clip-duration` / `set-subtitle-position` / `set-transition` / `set-track-volume` |

模型不生成 `set-clip-*`；这些由本地 `draftEditPlan` 处理，避免简单时间线指令花模型费用或被模型改错。

### 2.2 确认、应用与撤销

- 计划卡先展示影响与费用；用户点「用这套方案」才应用。
- 应用前写整项目快照；应用后可整体撤销。应用后若有新修改或排队任务，整体撤销不可用，需用章节版本或作品版本。
- 修改动作只改用户要求的部分；未提到的人物、事实、素材和正文保留。
- 改台词/说话人/声线会清旧配音并排队重配；改人物声线会重配该人物所有台词；改章序/镜序会重编号并同步蓝图单元，检查/交付标过期。

### 2.3 各页面覆盖

| 页面 | 可理解的需求示例 | 结果 |
|---|---|---|
| 蓝图 | 改故事核、语气、人物、地点、风格 | 更新蓝图，下游过期 |
| 大纲 | 改第 3 章梗概、加一章、调顺序 | 局部替换/重排，正文保留 |
| 写作 | 改第 2 章结尾、重写第 5 章、把第 3 章移到前面 | 模型重写或直接替换/重排 |
| 分镜 | 改第 1 镜台词、把第 3 镜移到第 1 镜前、补 5 镜 | 镜头/分镜/蓝图同步 |
| 声音 | 第 1 镜换声线、全片重配、加雨声、换配乐 | 声线写回并排队重配/音效配乐任务 |
| 时间线 | 镜 03 慢 20%、雨声压低、字幕上移 | 本地时间线动作 |
| 检查/交付 | 按问题修改、改名、改结构 | 同对应步骤，并重新核对交付 |

## 3. 本地确定性检查

本地检查只做可计算的事，不做文学评分。

### 3.1 正文指标（`measureProseQuality()`）

- 字数、句数、平均句长、段落最长长度、对话占比、问句占比。
- AI 腔信号：虚词/情绪标签密度、抽象词比例、被动句、比喻密度。
- 开篇钩子：第一段是否直接进入事件/冲突。
- 这些指标用于提醒，不直接判“好/坏”；模型审稿负责解释。

### 3.2 漫剧镜头检查（`dramaQualityChecks()`）

- 镜头数量是否足够、每镜是否有画面提示词、景别/运镜是否连续、台词是否有说话人、分镜是否覆盖蓝图场景、参考锁定是否保留。
- 缺失项标错误/提醒；未配置视觉模型时视觉审稿记录“未检查”，不冒充通过。

### 3.3 交付闸门

- 小说：正文是否为空、章节是否缺交付格式、目标字数偏差、封面/字体/目录状态。
- 漫剧：时间线是否有片段、配音是否覆盖台词、字幕是否存在、FFmpeg 是否就绪、输出格式与分辨率。
- 交付前预检把硬问题列出来；有错误时阻止导出，提醒由用户确认。

![检查页](guide/screens/31-studio-review-dark.png)

## 4. 模型审稿

- 剧情审稿：读章节/镜头证据，按结构、人物动机、因果、时间线、伏笔、分镜覆盖给问题。
- 模型审稿：按章节/镜头引用证据，输出“问题 + 位置 + 建议”，不凭感觉打分。
- 审稿结果写入作品检查项，可在检查页逐条处理；不自动改稿。

## 5. 代码落点

| 文件 | 职责 |
|---|---|
| `src/main/creative-masters.ts` | 解压内嵌三套方法、路由、选段、方法论预算、输出契约 |
| `src/main/creative-prompts.generated.ts` | gzip+base64 的三套方法（自动生成，不手改） |
| `scripts/embed-creative-prompts.mjs` | 维护者重新生成内嵌包 |
| `src/main/studio.ts` | 协作者计划、动作归一化/应用、本地检查、模型审稿、阶段状态 |
| `src/shared/studio.ts` | 阶段、动作、作品数据结构 |
| `src/shared/studio-assistant.ts` | 当前页面/选中项到协作者上下文的纯函数 |
| `src/renderer/features/studio.tsx` / `studio-core.ts` | 协作者面板、计划卡、阶段导航、设置 |

## 6. 验证

- `tests/unit/studio-intent.test.ts`：26 条协作者用例，覆盖章序/镜序、局部大纲、人物/镜头声线、全片重配、逐步上下文。
- `tests/unit/studio-runtime.test.ts`：大师路由、方法论预算、内嵌提示词、正文/镜头检查。
- `tests/e2e/studio.spec.ts` 的 `35-studio-collaborator`：真实 UI 跑通声音页改配音、中短篇局部改大纲、长篇调章节顺序，以及原有的台词替换、整章重写、改名。
- 运行 `npm run typecheck`、`npm run audit:ui`、`npm run test:unit`；完整 E2E 只在发布门禁跑。

## 7. 边界

- 本地指标与检查不是文学判断；最终创作质量由模型按大师方法完成。
- 没有可用文本模型时，蓝图/大纲/正文/分镜/模型审稿明确失败；协作者只给本地规则计划或回答，不伪造正文改写。
- 没有 ComfyUI / ACE-Step / FFmpeg / 本机 TTS 时，对应步骤明确失败；`local` 配乐只是草稿，不算完成。
- 三套大师方法的内嵌包是运行时的唯一来源；不要重新引入桌面读取、`resources/prompts` 或旧创作手法库。
