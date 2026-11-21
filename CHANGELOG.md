# Changelog · 版本记录

Morrow 的版本按发布线记录。每节先给完整中文，再给完整英文；两段内容对应，但不逐句对照。

## 源码扁平化合并（2026-11-21）

版本号仍为 0.2.0。这一轮不改功能，只按 [ARCHITECTURE.md](docs/ARCHITECTURE.md#扁平源码结构) 的「扁平源码结构」把生产源码与测试源码按功能域合并，然后重新出包。

### 中文

**变更概览**：合并 3 个功能域 · 删除 1 个顶层目录 · 单测入口 15→6 · 用例数不变

- **远程通道域**：`src/relay/`（16 个文件，含嵌套 `net/` 子目录）收进 `src/main/relay.ts`、`relay-channel.ts`、`relay-crypto.ts`、`relay-pairing.ts`、`relay-server.ts` 五个扁平文件；不再保留第五个顶层源码目录，也不再有嵌套子目录。
- **搜索域**：`native-search.ts` 与 `builtin-search.ts` 合为 `src/main/search.ts`；厂商原生搜索与内置多引擎检索的先后关系、超时与相关性核对都不变。
- **云媒体域**：官方音色目录并入 `src/shared/media-cloud.ts`；`SafeStorageLike` 只保留一处定义（`relay-crypto` 定义、`relay-pairing` 再导出）。
- **测试入口**：`tests/unit` 的 15 个 relay 测试文件合并为 6 个域入口，259 项用例逐条保留；`relay-lifecycle` 与 `relay-settings` 因 mock 隔离单独保留（见 ARCHITECTURE「为什么保留少数分文件」）。
- **界面细化**：进展视图改为右上角浮窗（可收起为胶囊，不再占用侧栏竖轨），成员协作卡片补充状态与产出提示；`shared/progress.ts` 的聚合逻辑配套 7 项单测。
- **验证与产物**：985 项单测、96 条 Electron 流程、43 个功能域；E2E 95 passed / 1 skipped；便携版与安装包重新出包，哈希见 [VERIFICATION.md](docs/VERIFICATION.md)。

### English

**Summary**: three domains merged · one top-level directory removed · unit-test entries 15→6 · case count unchanged

- **Relay domain**: the 16-file `src/relay/` tree (including the nested `net/` folder) is folded into five flat files under `src/main/` — `relay.ts`, `relay-channel.ts`, `relay-crypto.ts`, `relay-pairing.ts`, `relay-server.ts`. No fifth top-level source root and no nested folder.
- **Search domain**: `native-search.ts` and `builtin-search.ts` become `src/main/search.ts`; provider-native search still falls back to the built-in engines with the same timeout and relevance checks.
- **Cloud media**: the official voice catalogue moves into `src/shared/media-cloud.ts`; `SafeStorageLike` is declared once (`relay-crypto`) and re-exported by `relay-pairing`.
- **Test entries**: the 15 relay unit-test files become six domain entries with all 259 cases kept; `relay-lifecycle` and `relay-settings` stay separate because they mock different modules.
- **Interface polish**: the progress view is now a top-right floating card that collapses into a pill instead of holding a sidebar rail, and collaboration member cards show status and output hints; seven unit cases cover the new `shared/progress.ts` aggregation helpers.
- **Verification**: 985 unit cases, 96 Electron flows, 43 domains; E2E 95 passed / 1 skipped. Portable and installer rebuilt; hashes in [VERIFICATION.md](docs/VERIFICATION.md).

## v0.2.0

发布：2026-10-27（GitHub Release）。2026-11-12 修复 issue 后重新打包并替换发布资产；随后两轮加固（见下）重新打包，版本号沿用 0.2.0。

### 中文

这一版把 Morrow 从“能干的 Agent”扩展成“能交付作品的工坊”：新增创作台、云端多媒体与成员协作，并把模型与订阅的控制权交回使用者。

后续两轮加固没有引入新的功能模块，只把创作台的「成片能不能播」变成可自动判定的产线，并修掉几处影响日常使用的问题。版本号仍为 0.2.0。

**变更概览**：新增 3 项 · 优化 12 项 · 修复 7 项

**新增**

- **创作台**：中短篇、长篇与漫剧三条链路，从一句话生成蓝图，经大纲、分镜、画面、声音、时间线、检查到交付；没有模型或引擎时明确失败。
- **云端多媒体与“模型 / 本地”分栏**：设置中接入 17 个国内与海外图片、视频、配音、配乐服务；本地模型与 ComfyUI、FFmpeg、TTS 集中到“本地”页。
- **成员协作**：主代理按需派发成员，支持独立工作副本、成果版本、独立验收、重试、并发上限与卡住提醒；进度直接显示在主对话的成员卡片里。

**创作产线加固**

这一轮的主线是**把主观判断换成机器判定**。v0.2.0 的创作台能跑通全链路，但「这一镜帧数够不够」「成片有没有静帧」「配乐里有没有人声」全靠人眼看。这一轮把这些都变成了检查项与门禁。

- **帧数契约**：有实测帧数就只信实测，不足缩短、超额截断、无实测回退计划值。剪辑不再补帧或放慢；老项目与随包样例自动补齐 `frames`/`fps`。镜头详情显示「帧数@fps / 实测 / 计划 / 差值」。
- **参考图归一化**：上传前把参考图统一到目标尺寸（向下对齐 32，避免顶爆显存），已合格的原样复用不重编码。
- **时长规划器**：按「段数 = 台词句数 ÷ 3」与情绪四节拍（憋/反转/爆发/爽）分配时长；全等长会构成催眠效应，直接阻断出包。
- **接缝与静帧审计**：每镜抽首/中/末帧算 MD5 + PSNR，相邻镜末帧↔首帧比对；PSNR > 30dB 判近似静帧或接缝重复，报错带镜号与时间点。采样失败时降级为 warn 并写明「疑似但无法确认」——静帧误报的成本远高于漏报。
- **画音分离**：画面轨只提供像素，视频自带音轨一律丢弃；声音只来自重建的四层（对白/环境床/音效/配乐），loudnorm 改双遍稳定到 −18dB 附近。
- **配乐纯器乐校验**：配乐提示词改为正向描述乐器编制替代「无人声」否定式；生成后比语音频段与全频段的响度差，判疑似有人声即阻断出包。
- **提示词 v4 基座**：视频提示词改为固定骨架——SPATIAL LOCK → ENTRY STATE → 四镜时间码 → EXIT STATE → 音频三行；中文边界扫描会拦下 `<d>[Chinese]</d>` 之外会被模型当台词念出来的汉字。
- **导演层**：导演四问（目的/看谁/情绪走向/结尾感受）、景别链 WS→CU→MS→MCU 禁连续同景别、首镜禁空镜、出彩镜占比 25–35%、动作-反应镜配对。
- **门禁与基线**：14 项 ERROR/WARN 汇总成统一门禁，**ERROR > 0 阻断出包**，一次性收齐所有问题而非逐项抛出。
- **启动护栏**：拦截会导致 OOM 的引擎参数（含已在运行的实例），给出可执行的替代参数。
- **手部规避构图器**：连语义一起改写（不只是删「手」字），让动作不再需要手被执行。
- **任务归属校验**：用「请求参数 vs 实测特征」核对取回的素材是否属于该镜，存疑则不挂载。
- **断点续跑**：断电后凭任务号取回结果而不重新提交；无任务号的明确标为中断，不假装能恢复。

**优化**

- **模型与订阅控制**：每个模型可选上下文档位与最大输出，支持思考档位、OpenAI / Anthropic 协议切换与重试策略；能按模型目录识别图片输入能力。
- **界面可读性**：字号下限统一到 11px，输入框、文本域与下拉改为微圆角与内嵌焦点环；移除并排对话，协作并入工作模式。
- **终端槽位**：同时运行上限降为 16，且只统计**运行中**的进程。一次性后台任务结束后自动收起终端窗口；记录只保留 10 分钟供 Agent 回读最终输出，不占名额。已退出的记录不再占名额；`stop` / `close` 结束后立刻释放，新增 `close` 动作供显式回收。这正是「终端满了、停止成功却仍报满、只能回退 run_command」的根因。
- **终端布局**：终端停靠层改为贴在 Agent 对话列底部，不再横跨窗口；画布或侧聊打开时，终端随对话列收窄，不会伸到画布下方。
- **素纸主题**：浅色主题的金色文字由浅褐金压到更深的暗金（`#7a5418` / `#86602a`），正文仍是原来的墨黑；金色填充按钮单独保留较亮的底色，黑字对比度不被牺牲。金色文字对纸底的 WCAG 对比度从 4.27:1 / 2.96:1 提升到 5.78:1 / 4.83:1。
- **订阅浏览器授权**：登录窗口对本次授权的 HTTPS 来源放行 Local Network Access / loopback 回环权限，回环回调补齐 CORS 凭据与预检头；Command Code 这类“授权完成后把 Key POST 回 127.0.0.1”的流程不再被 Chromium 默认拒绝。登录窗口同时提供“在系统浏览器中打开”菜单，作为企业策略/浏览器策略仍拦截时的可靠出口。
- **设置分页**：删除“更多功能”聚合页，把记忆、技能、外部工具、全部功能、全局搜索和版本记录拆成左侧一级分页，并按“接入 → 扩展 → 工作 → 系统 → 应用”重排。项目、定时任务和浏览器只保留在主页入口，不再在设置里重复出现；这些功能面板直接嵌入设置页，不再叠一层模态。
- **右侧进展更新**：右栏未展开时，Agent 对话右侧常驻一列进展挂窗，实时显示会话状态、耗时、待办完成度、计划、协作成员和工具/成果/审批动态。它直接消费真实 `RuntimeEvent` 与主进程 `IslandSnapshot`，可收起成细轨；画布或侧聊展开时自动让位，避免盖住内容。
- **长任务完成质量**：联网搜索的结果现在会和查询关键词做相关性核对：多词查询至少命中两个不同关键词，Bing 在部分网络返回的无关缓存结果不会再被当成答案；内置引擎超时从 9s 收到 6s，先失败快、再提示换 Tavily/Brave/Serper/SearXNG。原生搜索返回答案却没有来源时，会自动再走一次内置搜索补来源。深度研究结束前把报告引用 URL 与真实搜索/读取记录交叉核对，编造链接不再能完成；协作成员简报自动带上计划里的 `deliverable` 和下游验收文件/命令。Super-Agent 的系统提示新增长任务触发条件（三个以上独立方向、跨三个以上文件/模块、深度调研、多方案比较、独立验收或预计超过 8 次工具调用），默认先拆分派发，不再一个人串行做到底。
- **手机配对**：桌面“设置 → 手机配对”提供远程通道开关、手机配对请求、90 秒一次性配对码与已配对设备撤销；安卓版修复 hello 通道字面量与桌面实际校验不一致的问题，真实 Ktor ↔ Node `DirectChannel` 配对链路跑通。APK 随后随交付包提供，实体机扫码仍需一台安卓设备。
- **文件读取上限**：`read_file` 单次读取上限从 256KB 放宽到 4MB，默认一页（2000 行）的输出上限从 64K 提到 256K。Morrow 自己的 `studio.ts` 等文件早已超过 256KB，旧上限让读源码只能看到开头；仍保留 `offset`/`limit` 分页与二进制判定。
- **稳定性改进（含修复）**：修复任务栏空白图标、8.3 短路径误判与大工作区副本上限误拦；断流、空回合与空闲超时不再静默停止。

**修复**

- 危险命令识别先归一化再匹配：PowerShell 别名、编码命令、续行、cmd 删除开关等九类绕过写法现在都会被拦截。
- 只读档改为按功能域登记读动作，未登记的动作默认拒绝；文件、Git、终端、媒体与创作台的写操作返回 `READ_ONLY` 且无副作用。
- 窄窗口下协作者面板不再遮挡正文，查找与替换按钮恢复可点。
- “全部替换”按编辑器真实文档重算区间，避免虚拟化渲染窗口造成的错误测量。
- 分镜卡的「候选」徽标与「时长」徽标不再重叠：两者原本各自绝对定位在右下角，实测每张卡都有 25×9px 交叠；改为同一底栏横向排布，`视频 / 候选 / 时长` 依次右对齐，窄卡下候选可省略号收缩。
- 分镜板只让主区域滚动：滚动条移到分镜区与右侧镜头详情的交界处并覆盖主区域全高，详情面板自己的滚动条留在窗口右缘；头部、工具栏与底栏不再滚出视口，滚到底部时面板底部不再露出空白。
- 单文件便携包冒烟后不再在 `deliver/` 留下 502MB 运行时缓存；清理失败会如实记录而不是静默。
- 出包断言从逐项 `throw` 改为统一门禁，修掉一类问题不会再撞上下一类。

**重要说明**

- 两个 exe 均未签名，首次运行可能触发 SmartScreen；请先用 `SHA256SUMS.txt` 校验。
- ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg、ACE-Step、TTS 与订阅账号由用户环境决定，缺失时相关动作会明确失败。
- 只读档读取的是全局设置；会话级 `permissionMode` 与全局设置的统一、Git 面板按钮置灰仍是后续项。
- 本轮把 0.3.0 的框架加固并入 0.2.0：升级内容集中在底层判定与稳定性，没有真正接入大的新功能，因此不单列版本号。

### English

This release turns Morrow from a capable agent into a workshop that ships work: a Studio, cloud media and member collaboration, with model and subscription control back in your hands.

Two follow-up hardening rounds added no new feature modules. They turn "can this cut actually be broadcast" into an automatically decidable pipeline and fix several day-to-day issues. The version stays 0.2.0.

**Summary**: Added 3 · Improved 12 · Fixed 7

**Added**

- **Studio**: short story, novel and comic-film pipelines from a one-line premise through blueprint, outline, storyboard, frames, voice, timeline, review and delivery. It fails explicitly when no model or engine is available.
- **Cloud media and a model/local split**: seventeen domestic and overseas image, video, voice and music services in Settings, with local models, ComfyUI, FFmpeg and TTS grouped on a separate Local page.
- **Member collaboration**: the main agent dispatches members when work needs isolation, parallel copies or independent acceptance, with artifact versions, retries, concurrency limits and stuck alerts. Progress is shown in member cards inside the main conversation.

**Production pipeline hardening**

- **Frame contract**: trust measured frame counts only; shorten when short, truncate when long, fall back to planned only when unmeasured. No frame padding or slow-down; legacy projects and bundled samples are backfilled.
- **Reference image normalization**: unify reference images to the target size before upload (align down to 32), reuse compliant files without re-encoding.
- **Duration planner**: derive segment count from dialogue sentence count and allocate durations by emotional beat, so the whole film is never uniformly paced — a uniform timeline blocks export.
- **Seam and still-frame audit**: sample first/middle/last frames per shot, compare MD5 + PSNR, flag seams above 30 dB with shot number and timecode. Sampling failures degrade to a warning instead of a false accusation.
- **Audio/picture separation**: the picture track provides pixels only; all sound comes from four rebuilt layers with two-pass loudnorm.
- **Instrumental music check**: describe instrumentation positively instead of "no vocals", then compare voice-band versus full-band loudness and block the export when vocals are suspected.
- **Prompt v4 base**: fixed skeleton with spatial lock, entry/exit state, four-shot timecodes and three audio lines; a Chinese-boundary scanner rejects Han characters outside dialogue tags.
- **Director layer**: four director questions, shot-size chain, non-static opening, reaction-shot pairing.
- **Gate and baseline**: 14 ERROR/WARN checks aggregated into a single gate that blocks export while any error remains, reporting everything at once instead of one throw at a time.
- **Stability**: engine-argument guard, hand-free composition rewriter, shot attribution verification, and resumable jobs.

**Improved**

- **Model and subscription control**: per-model context tiers and maximum output, thinking levels, OpenAI/Anthropic protocol switching and retry policies; image-input capability is read from model catalogues.
- **Interface readability**: an 11px minimum type size, consistent micro-radius controls and inset focus rings, no side-by-side chat, and collaboration folded into work mode.
- **Terminal slots**: the simultaneous ceiling is now 16 and only *running* processes count. One-shot background tasks close their terminal window as soon as they finish; the record is kept for 10 minutes so the agent can still read the final output, without holding a slot. Exited records no longer hold a slot, and `stop` / `close` release immediately.
- **Terminal layout**: the terminal dock now anchors to the bottom of the agent conversation column instead of spanning the whole window. Opening the canvas or side chat narrows the terminal with the conversation, so it never reaches under the canvas.
- **Paper theme**: gold text in the light theme now uses a deeper, more saturated dark gold (`#7a5418` / `#86602a`) while body copy stays the same ink black. Filled gold buttons keep their own lighter fill so black labels stay readable. Gold-on-paper contrast rises from 4.27:1 / 2.96:1 to 5.78:1 / 4.83:1.
- **Subscription browser sign-in**: the login window now grants Local Network Access / loopback permission only to the HTTPS origin that started the flow, and the loopback callback answers CORS preflight with credentials. Command Code-style flows that POST the key back to `127.0.0.1` are no longer rejected by Chromium's default policy. The login window also exposes an “Open in system browser” menu as a reliable fallback when enterprise or browser policy still blocks the handoff.
- **Settings pages**: removed the “More features” hub. Memory, skills, connectors, the tool catalog, global search and version history are now first-class pages in the left settings nav, ordered as connect → extend → work → system → app. Projects, scheduled tasks and the browser stay on their existing home-screen entries and no longer appear in Settings; the embedded panels render inline instead of stacking another modal.
- **Progress rail**: while the right canvas/side chat is closed, a persistent “Progress” column sits to the right of the Agent conversation. It shows live status, elapsed time, todo completion, plan, collaborators and tool/artifact/permission updates from the real `RuntimeEvent` stream and the main-process `IslandSnapshot`. It collapses to a slim rail and yields automatically when the canvas or side chat opens.
- **Long-task completion quality**: web search results are now checked against the query: a multi-term query must match at least two distinct terms, so Bing's unrelated cached pages no longer pass as answers. The built-in engine timeout drops from 9s to 6s and points users to Tavily/Brave/Serper/SearXNG when it cannot get relevant results; a native answer with no citations is followed by one built-in pass to recover sources. Before research finishes, report citations are cross-checked against the URLs actually returned by `web_search` / `web_fetch`, so fabricated links no longer pass. Member briefs now include the plan's `deliverable` plus the downstream acceptance files and command. The Super-Agent prompt now states long-task triggers (three or more independent directions, three or more files/modules, deep research, multi-option comparison, independent acceptance, or an expected 8+ tool calls) and defaults to splitting and dispatching instead of solving everything serially.
- **Phone pairing**: Settings → Phone pairing now exposes the remote-channel switch, the phone pairing request, a 90-second single-use ticket and revocation of paired devices. The Android app's hello channel literal was fixed to match the desktop verifier, and the real Ktor ↔ Node `DirectChannel` pairing path passes. The APK ships with the delivery; physical-device scanning still needs an Android device.
- **File read limits**: `read_file` now reads up to 4 MB per call (was 256 KB) and returns up to 256K characters per page (was 64K). Morrow's own sources already exceeded the old ceiling.
- **Stability fixes**: fixed the blank taskbar icon, 8.3 short-path misdetection and a false limit on large workspace copies; stream breaks, empty turns and idle timeouts no longer stop silently.

**Fixed**

- Dangerous-command detection now normalizes input before matching: PowerShell aliases, encoded commands, line continuations and cmd delete switches are covered, closing nine bypass paths.
- Read-only mode registers read actions per feature domain and rejects anything unregistered; file, Git, terminal, media and Studio writes return `READ_ONLY` without side effects.
- The collaborator panel no longer covers content in narrow windows, and find/replace buttons are clickable again.
- Replace-all now recomputes ranges from the real editor document instead of the virtualized render window.
- Storyboard card badges no longer overlap: the candidate and duration badges were absolutely positioned into the same corner (25×9 px of overlap on every card). They now share one bottom row ordered video / candidates / duration.
- The storyboard scrolls only its main area: the scrollbar sits on the seam between the shot grid and the right-hand shot inspector and spans the full height of the main area, while the inspector keeps its own scrollbar at the window edge. The header, toolbar and footer no longer scroll out of view, and the inspector no longer shows blank space at the bottom.
- The single-file portable build no longer leaves a 502 MB runtime cache in `deliver/` after smoke testing, and cleanup failures are reported instead of swallowed.
- Export assertions became a single gate instead of a sequence of throws.

**Important Notes**

- Both executables are unsigned and may trigger SmartScreen on first run; verify them with `SHA256SUMS.txt` first.
- ComfyUI, llama.cpp, Ollama, LM Studio, FFmpeg, ACE-Step, TTS and subscription accounts come from your environment; missing pieces fail with an explanation.
- Read-only mode reads the global setting. Unifying session `permissionMode` with the global setting and disabling Git panel buttons are still follow-ups.
- The 0.3.0 hardening was folded into 0.2.0: the work was mostly framework-level, with no large new feature actually wired in, so it does not get its own version number.

## v0.1.0

发布：2026-10-24（GitHub Release；2026-11-05 清理死代码与空行后重发，功能不变）。

### 中文

首个公开版本：把对话、计划、文件编辑、画布、终端、Git、浏览器、模型订阅与本机多媒体放进同一个 Windows 工作区。所有新增条目按用户可感知的能力归并。

**变更概览**：新增 11 项 · 优化 0 项 · 修复 0 项

**新增**

- 五种工作方式：聊天（只读）、工作、计划、深度研究、长期目标；计划与研究在动手前等待批准，目标模式按同一套权限规则跨轮推进。
- 只读、询问、完全访问三档权限，审批卡写明工具、目标、影响与风险；危险命令、越界路径与外部副作用逐次确认。
- 工作区文件树、CodeMirror 多标签编辑器、成品画布（HTML/Markdown/SVG/图片/PDF/Office/音视频预览）、版本历史与导出。
- 每个用户轮次的检查点与写前快照，可回退代码、对话或两者，文件冲突时拒绝覆盖。
- 真实 PTY 终端（默认 Git Bash，可选 PowerShell 7 / WSL）、后台任务、Git 工作台与多标签内置浏览器。
- 11 个模型族的 API 预设、自定义 OpenAI 兼容端点、本机 llama.cpp / Ollama / LM Studio；模型能力按运行时元数据展示，思考档位与上下文档位只列出模型真实支持的选项。
- 10 个官方 Agent 订阅渠道与第三方 coding plan，凭据本机加密，请求经回环代理转发。
- 本机多媒体：ComfyUI / llama.cpp / Ollama / LM Studio 的图片与视频生成、短片、动画、剪辑与检查；`describe_media` 优先当前对话模型，只回退到声明视觉能力的模型。
- 项目、记忆中心、技能库（18 个内置技能）、MCP 连接器、自定义命令、自定义角色、钩子与定时任务。
- `/btw` 侧聊不写主会话；`/super-agent` 把独立任务分给 1–10 个协作成员，成员与主代理共用工作区与权限规则。
- 打包版本地崩溃日志与渲染进程自动恢复；订阅凭据、审批日志与数据目录均可在设置中查看或管理。

**重要说明**

- 本版仅交付 Windows 10/11 x64；便携版与安装包均未签名，首次运行可能触发 SmartScreen，请用 Release 附带的 `SHA256SUMS.txt` 校验。
- 便携版首次运行会在 exe 同级解压运行时缓存，之后启动更快；运行中不要删除该缓存或 `Morrow Data`。
- 本机只用 Qoder 与 Codex 真实账号验证过订阅链路，其余渠道只验证登录页、协议与端点，不提供虚构额度。
- 本机多媒体依赖用户自己的引擎、显卡与 ffmpeg；缺失时返回真实错误。Antigravity 登录需要自行提供 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。
- 2026-11-05 的重发包只清理死代码与空行，功能与文件结构不变；发布资产已替换，旧哈希作废。
- 源码包内的文档是打包时快照；源码包哈希以同名 `.sha256` 侧车为准。

### English

The first public release: conversation, planning, file editing, an artifact canvas, a terminal, Git, a browser, model subscriptions, and local media engines in one Windows workspace. Items below are grouped by what a user can do.

**Summary**: Added 11 · Improved 0 · Fixed 0

**Added**

- Five work modes — chat (read-only), work, plan, deep research, and long-running goals — where plan and research runs wait for approval before acting, and goals advance under the same permission rules.
- Read-only, ask, and full-access permission tiers with approval cards naming the tool, target, impact, and risk; dangerous commands, out-of-workspace paths, and external side effects are confirmed per call.
- A workspace file tree, a multi-tab CodeMirror editor, an artifact canvas for HTML, Markdown, SVG, images, PDF, Office files, audio, and video, plus version history and export.
- A checkpoint per user turn and a snapshot before every write, with rewind for code, conversation, or both and conflict-safe restore that refuses to overwrite changed files.
- A real PTY terminal (Git Bash by default, PowerShell 7 and WSL available), background tasks, a Git workbench, and a multi-tab built-in browser.
- API presets for 11 model families, any OpenAI-compatible endpoint, and local llama.cpp, Ollama, and LM Studio servers; capabilities come from runtime metadata, so thinking effort and context tiers only show what the model declares.
- Ten official agent subscription channels and third-party coding plans, with credentials encrypted locally and requests forwarded through a loopback proxy.
- Local media through ComfyUI, llama.cpp, Ollama, and LM Studio: image and video generation, short films, animations, editing, and inspection, with `describe_media` preferring the current chat model and falling back only to a model that declares vision.
- Projects, a memory center, a skill library with 18 built-in skills, MCP connectors, custom commands, custom agent roles, hooks, and scheduled tasks.
- `/btw` side chats that never write to the main session, and `/super-agent` runs that split independent work across 1–10 members sharing the main agent's workspace and permission rules.
- Local crash logging and renderer auto-recovery in packaged builds, plus in-app access to subscription credentials, the approval log, and the data directory.

**Important Notes**

- This release targets Windows 10/11 x64 only. The portable and installed executables are unsigned, so SmartScreen may warn on first launch; verify the download against the `SHA256SUMS.txt` attached to the Release.
- The portable build unpacks a runtime cache next to the executable on first launch and starts faster afterwards. Do not delete that cache or `Morrow Data` while the app is running.
- Only Qoder and Codex were verified with real accounts on the build machine. Other channels were checked at the login page, protocol, and endpoint level, and no quota numbers are invented.
- Local media requires your own engines, GPU, and ffmpeg, and reports a real error when they are missing. Antigravity login requires you to supply `MORROW_ANTIGRAVITY_CLIENT_SECRET`.
- The 2026-11-05 repack only removed dead code and blank lines; behavior and file structure are unchanged, the release assets were replaced, and old hashes are obsolete.
- Documentation inside the source archive is a snapshot taken at packaging time; the archive hash is the sidecar `.sha256` file next to it.
