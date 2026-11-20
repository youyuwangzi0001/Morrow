# 交付验证

> 本文为中文文档；英文概览见 [README.md](../README.md)。

版本 **0.2.0**。这页是 2026-11-21 重新打包后的真实交付快照：产物哈希、测试结果、文档截图与验证边界，全部来自本机实测。机器可读摘要见 [verification.json](verification.json) 与 [smoke-packaged.json](smoke-packaged.json)。

## 交付产物

本轮（2026-11-21 重建，含第 1–10 项体验修复与安卓配对修复）产物在 `deliver/`：

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 207,744,512 B / 198.12 MiB | `61d729e57f5fdcba2dfb73108aff07b6bae1943704bc8b75ae4319a877d6056f` |
| `Morrow-0.2.0-setup.exe` | 157,930,448 B / 150.61 MiB | `c4ea88a6f57cf07a5dc8a404cb232140d2da7afac9bcf166b9a2a9b04bbb9cd3` |
| `Morrow-Android-1.0.0-debug.apk` | 19,492,528 B / 18.59 MiB | `9b3ac3c15ad020be57306e0b67ba302e3d2b9913a3a3036154cf400442b63dc0` |

`deliver/` 合计 385,167,488 B / 367.32 MiB，附 `SHA256SUMS.txt`（已用 `sha256sum -c` 反向校验，三个包均为 `OK`）。旧包与 `Morrow Data` 用户数据已移出交付目录；用户数据保留在 `.morrow/user-data/`，不进入分发包。

- 两个 exe 均**未签名**（`signed:false`，`NotSigned`）：未配置代码签名证书，首次运行可能触发 SmartScreen，需「更多信息 → 仍要运行」。
- 便携版是自研单文件启动器：内嵌应用 zip，首次运行解压到 exe 同级 `.morrow-runtime-0.2.0-r020` 缓存（**不依赖 `%TEMP%`**），之后秒开；启动器带完整 Win32 manifest 并自动加 `--no-sandbox` 以兼容受限环境。
- 安装包是 NSIS 自解压：可选安装目录、创建开始菜单/桌面快捷方式，默认安装到 `Program Files`（需管理员权限）；安装版数据目录为 `%APPDATA%\Morrow`，可在设置中更改。
- 安装包与文件夹版的应用代码一致：从安装包解出的 `Morrow-app.exe` 与 `resources/app.asar` 哈希分别为 `13f1473c…6d3a92` / `1138bb09…ed2edf`，与 `release/Morrow-0.2.0-portable/` 同名文件完全相同；两侧 `Morrow.exe` 启动器因便携标记不同而哈希不同，属预期。
- 安卓 APK 为 **debug 构建**（`studio.morrow.android.debug`，versionName `1.0.0-debug`，minSdk 26 / targetSdk 35），使用工程内 debug keystore 签名，`apksigner verify` 确认 APK Signature Scheme v2 通过；用于安装验收，不是应用商店正式签名包。

## 冒烟验证

单文件便携包**真实启动过**（不是只看文件存在）：

| 项 | 实测 |
|---|---|
| 被测文件 | `deliver/Morrow-0.2.0-portable.exe`（198.12 MB） |
| 启动方式 | `Morrow-0.2.0-portable.exe --no-sandbox --test-mode --remote-debugging-port=8526` |
| CDP 就绪 | Chrome/152.0.7977.167，3762ms |
| 窗口标题 | Morrow |
| 界面版本 | **v0.2.0**（确认版本号已进产物） |
| 渲染 | 首屏文本正常（创作台 / 新建对话 / 文件树 / 设置 /「未连接」），预加载 API 正常 |
| 运行位置 | 解压到 `.morrow-runtime-0.2.0-r020` 运行（符合单文件版预期） |
| 截图 | [docs/evidence/packaged-smoke.png](evidence/packaged-smoke.png)（2102×1203） |
| 总耗时 | 5.0s |
| 冒烟包哈希 | `61d729e5…d6056f`（与被测 exe 一致） |
| 汇总 | `portable=通过`，摘要见 [smoke-packaged.json](smoke-packaged.json) |

安装包另做了归档完整性检查：用 `7za` 解出 334 个文件 / 530,691,575 B，`Morrow-app.exe` 与 `resources/app.asar` 均与文件夹版逐字节一致；未执行 per-machine 安装，避免改动本机 `Program Files` 与快捷方式。

冒烟脚本会清理单文件版解压出的运行时缓存，避免交付目录被 500MB 级缓存污染；清理失败会写入 `runtimeCleanupError` 而不是静默。打包与冒烟日志保留在 [docs/evidence/dist-all-final.log](evidence/dist-all-final.log) / [docs/evidence/smoke-packaged-portable.log](evidence/smoke-packaged-portable.log)。

## 本轮修复的回归

| 缺陷 | 根因 | 回归保护 |
|---|---|---|
| 工具参数报「模型输出的工具参数不是合法 JSON」，模型反复重试同样坏掉的调用 | `parseToolArgs` 只会去代码围栏/截首尾花括号/去尾逗号；模型把 Windows 路径、grep 正则（`\|`、`\K`）按纯文本写入时产生非法转义，一个都修不了，且失败文案不指出错在哪 | `tests/unit/core-runtime.test.ts` 用真实坏样本覆盖「非法转义 + 裸换行自动修好」与「截断必须报截断并带回出错片段」 |
| 分镜卡「候选」与「时长」徽标重叠 | 两者各自 `position: absolute` 定位到同一右下角，实测每张卡 25×9px 交叠 | `tests/e2e/studio.spec.ts` 逐卡比较三个徽标的边界框，要求零交叠 |
| 终端槽位满时 `stop` 成功却仍报满，回退 `run_command` | 上限把**已退出**的记录也算作槽位，而 `stop` 只发信号、不删记录，名额永不释放；工具层也没有可用的关闭动作 | `tests/unit/main-runtime.test.ts` 覆盖「16 条已退出记录不占名额」「stop 后记录释放」「16 个运行中仍被拦」以及「一次性任务结束自动收起窗口但可回读输出」 |
| 终端 UI 横跨 Agent 对话列和右侧画布 | 终端停靠层渲染在 `WorkbenchHost`（对话列之外），用 `position: fixed; left: 侧栏宽度; right: 0` 贴整个窗口，画布打开后终端仍横跨画布下方 | `tests/e2e/workspace.spec.ts` 的 `@core:terminal` 用例打开画布后比较终端、对话列、画布三者的边界：终端必须完全落在对话列内且不越过画布左边界 |
| 素纸主题的金色文字发灰、对比度不足 | 浅色主题 `--gold` 为 `#8a6a3c`（对纸底 4.27:1），`--gold-bright` 为 `#a8844f`（2.96:1）；两者同时承担文字与按钮填充，单独压暗会让黑字按钮失效 | `tests/e2e/ui.spec.ts` 的 `@core:typography` 用例读取真实 CSS token 计算 WCAG：正文 ≥12:1，暗金与次级暗金对纸底均 ≥4.5:1，金色填充上的深色标签也 ≥4.5:1 |
| Command Code 等订阅在系统 Edge 能授权，内置登录窗提示只能复制 API Key | 登录页把授权 Key 自动 POST 回 `127.0.0.1` 时被 Chromium 的 Local Network Access / loopback 权限、以及回调 CORS 的凭据/预检限制拦住；登录窗口没有对应权限处理器 | `tests/unit/main-external-open.test.ts` 覆盖可信 HTTPS 来源才放行回环权限、非 HTTPS/未授权来源拒绝；`@core:browser` E2E 确认内置浏览器未回归；登录窗口另提供系统浏览器菜单作为策略兜底 |
| 设置里的“更多功能”把记忆、技能、外部工具、搜索和版本记录折叠起来，项目/定时任务/浏览器又与主页入口重复 | 这些功能原本是工作台面板，只能从“更多功能”列表里逐个打开；设置左侧没有一级入口 | `@core:tools` E2E 断言左侧有记忆/技能/外部工具/全部功能/全局搜索/版本记录分页，且“更多功能/项目/定时任务/浏览器”不再作为设置分页；同一用例打开全部功能、技能与内联全局搜索；`@core:connectors`、`@core:git`、`@core:memory`、`@core:schedules` 覆盖嵌入后的真实交互 |
| 右栏未展开时看不到 Agent 的实时进展，只能翻对话 | 现有运行事件只更新对话与灵动岛，主窗口没有独立的进展视图；另造一套进度会与真实状态脱节 | `ProgressDock` 订阅真实 `window.morrow.onEvent` 与 `island.onState`，`@core:memory` 断言挂窗可见、可收起为细轨再展开、本轮完成后状态为“已完成”并展示实时动态；`@core:permissions` 断言工具运行与“等待你确认”入列，拒绝后变为“确认完成”；`@core:modes` 断言画布关闭后显示 2/3 待办、状态为“等待你”，且通知堆叠位于挂窗左侧上方；`@core:terminal` 断言画布展开时挂窗让位 |
| `read_file` 只能看到 256KB 以内的开头 | `MAX_READ_BYTES = 256 * 1024`，Morrow 自己的 `studio.ts` 等早已远超 | `tests/unit/core-tools.test.ts` 覆盖「300KB 文件能读到尾部」与「默认 2000 行不被 64K 输出上限截断」 |
| 深度研究只数「两个链接 + 参考来源标题」，编造的 URL 也能完成 | `hasSourceEvidence` 只统计正则匹配到的链接数量，没有和真实搜索/读取记录比对 | `tests/unit/shared.test.ts` 的 `@core:research` 用例加入伪造链接不完成的断言；`hasResearchReport` 现在接收 `collectResearchSources` 的归一化来源集合，至少 2 个不同来源命中才完成 |
| 协作成员只看到主代理手写的 prompt，漏掉交付物与验收口径 | 成员简报只有 `【总目标】` + prompt，`deliverable` / `verify` 留在计划结构里，没有进入成员上下文 | `src/core/tool-extra.ts` 自动注入 `【你的交付物】` 和下游验收文件/命令；`@core:superagent` 成员消息 E2E 断言测试成员收到自己的交付物且不串收 |
| 内置搜索经常超时，且 Bing 会返回与查询无关的缓存页（如搜 “Morrow AI agent” 返回座头鲸/学习通） | 旧实现只要解析出任意 5 条结果就返回；多词查询没有相关性门槛，Bing 的无关结果会顶掉 DDG；超时 9s 让等待过长 | `rankSearchSources` 要求多词查询命中至少两个不同关键词、拉丁词按边界匹配，`morrow` 不误命中 `tomorrow`；内置超时 9s→6s、hedge 2.5s→1.5s；`@core:web` 覆盖无关结果过滤与 `tomorrow` 误命中 |
| 模型原生搜索返回答案却没有可引用来源 | 原生搜索成功分支直接返回 `sources: []`，没有补来源 | `WebSearchService` 在原生来源为空时再走一次内置搜索；内置也失败才保留原生回答，并明确提示不要编造引用 |
| 长任务里主 Agent 倾向自己串行做完，Super-Agent 调用保守 | 旧提示只有“需要并行/隔离/独立验收时再用”，没有长任务触发条件 | `buildWorkToolStrategy` 与 `super_agent` 工具描述新增三个以上独立方向、跨三个以上文件/模块、深度调研、多方案比较、独立验收或预计超过 8 次工具调用等触发条件，默认先拆分派发 |
| 安卓版扫码配对在真实桌面端始终 4401，收不到 welcome | 手机 `RelayProtocol.CHANNEL_LAN = "wss"`，桌面 `DirectChannel.verifyRequest(deviceId, 'lan', …)` 校验的是 `lan`；通道字面量不一致，跨语言 E2E 与向量测试同时失败 | `MorrowAndroid` 改为 `CHANNEL_LAN = "lan"`；`CrossDeviceE2ETest` 用真实 Node `DirectChannel` ↔ Kotlin `RelaySocketClient` 跑 6 项；`verify.sh` 新增 E3 硬校验，避免证据日志过期 |

## 测试与检查

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过（node + web 双配置） |
| `npm run audit:ui` | 通过：30 CSS + 32 TSX，0 裸排版声明，31 个字号令牌可缩放 |
| `npm run audit:flex` | 通过：未发现会被压成竖排的行内尾部标签 |
| `npm run docs:check` | 通过：16 个 Markdown、30 张 2100×1200 截图、37 个本地图片链接 |
| `npm run test:suite` | 965 单元 / 96 Electron / 43 域，维护预算 965 / 96 |
| `npm run test:unit` | 63 文件 / 965 通过 |
| `npm run test:e2e` | 95 通过 / 1 跳过 / 0 失败（96 条），9.5m |

E2E 结果说明：唯一跳过的是 `packaged-parallel`（需要打包产物，属预期跳过）。全量 E2E 记录在 [docs/evidence/e2e-final.log](evidence/e2e-final.log)；本轮另修掉进展挂窗 `.progress-status` 的 flex-shrink 与 20 处裸排版声明，`audit:flex`、`audit:ui` 均恢复通过。

打包耗时 77.3s（`docs/verification.json`），Electron 44.9.0 / electron-builder 26.0.12。

代码统计按 `node scripts/count-code.mjs` 的统一口径（`wc -l` 换行，排除依赖、产物、文档、图片与媒体夹具）：

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 158 | 207,251 |
| 测试 `tests/` | 90 | 46,651 |
| 构建脚本 `scripts/` | 28 | 5,712 |
| 启动器 `build/launcher/` | 1 | 907 |
| **合计** | **277** | **260,521** |

## 文档截图

全部截图在默认 **2100×1200 物理窗口**下重拍，原始 PNG，不缩放、不压缩、不套滤镜。截图使用测试模式的演示工作区与样例作品，不含用户数据。生成命令 `npm run docs:capture`，校验命令 `npm run docs:check`。

### 用户指南与设置（15 张）

| 文件 | 内容 |
|---|---|
| `guide-onboarding.png` | 首次引导：认识 Morrow、连接模型、选择文件夹 |
| `guide-chat.png` | 主界面：会话、计划、输入框与工作区 |
| `guide-permission.png` | 审批卡：文件夹外路径、影响范围、允许一次/拒绝 |
| `guide-editor.png` | 文件树、编辑器与保存状态 |
| `guide-settings-models.png` | 设置 · 模型 |
| `guide-settings-subscriptions.png` | 设置 · 订阅 |
| `guide-settings-appearance.png` | 设置 · 外观 |
| `guide-settings-media.png` | 设置 · 本地与多媒体 |
| `guide-memory.png` | 记忆中心：长期、任务、项目与全局记忆 |
| `guide-browser.png` | 内置浏览器：标签、地址栏与真实页面 |
| `guide-terminal.png` | 真实终端：Git Bash 与命令输出 |
| `guide-collaboration.png` | 协作成员卡片：进度、用量与停止/插话 |
| `settings-cloud-media.png` | 模型页中的国内与海外多媒体服务 |
| `settings-local.png` | 本地模型与本地媒体引擎 |
| `pair-panel-devices.png` | 手机配对：远程通道、配对码与已配对设备 |

### 创作台（15 张）

| 文件 | 内容 |
|---|---|
| `studio-home.png` | 作品库与一句话入口 |
| `studio-create.png` | 创建作品：形态、一句话、精细度与补充要求 |
| `studio-blueprint.png` | 蓝图：主线、人物、结构、风格与费用 |
| `studio-writing.png` | 写作台：大纲、纸页、候选与协作者 |
| `studio-assistant.png` | 协作者计划卡：影响、费用与待确认 |
| `studio-storyboard.png` | 分镜板与单镜详情 |
| `studio-timeline.png` | 时间线：监视器、五轨、波形与时间码 |
| `studio-canvas.png` | 漫剧画布：镜头/素材节点与连线 |
| `studio-voice.png` | 声音 · 配音 |
| `studio-music.png` | 声音 · 音乐 |
| `studio-review.png` | 检查：本地检查、模型审稿与引擎 |
| `studio-delivery.png` | 交付：成片预览、格式与预检 |
| `studio-settings.png` | 创作台设置：模型与预算等五页 |
| `studio-trash.png` | 回收站 |
| `studio-light.png` | 素纸主题作品库 |

`docs:check` 会核对：每张截图必须 2100×1200、必须在文档中被引用、不能出现废弃的 `docs/guide` 或 `docs/verification` 目录。

## 验证边界

- 安装包只做了归档完整性与便携版冒烟，未执行 per-machine 安装，避免改动本机 `Program Files` 与快捷方式。
- 未配置代码签名证书；两个 exe 均为 `signed:false`。安卓 APK 仅为 debug 签名，不是应用商店正式签名包。
- 本机没有 Android 模拟器/真机，未做实体扫码与安装；安卓侧用真实桌面 Node `DirectChannel` ↔ Kotlin `RelaySocketClient` 跨语言 E2E + Robolectric UI 验证，实体机验收仍需一台 Android 设备。
- 外部模型、ComfyUI、MiniMax Music3、FFmpeg、TTS、订阅账号与额度由用户环境决定；未逐一做真实付费调用或全渠道登录，第 9 项的质量验证也没有调用真实付费模型。
- 截图展示的是测试模式下的样例界面，不代表用户本机已有同样的项目或数据。
- 只读档读取的是全局设置；会话级 `permissionMode` 与全局设置的统一、Git 面板按钮置灰仍是后续项。
- 本轮把 0.3.0 的框架加固并入 0.2.0：升级集中在底层判定与稳定性，没有真正接入大的新功能，因此沿用 0.2.0 版本号。

## 交付沿革

| 时间 | 内容 |
|---|---|
| 2026-10-27 | v0.2.0 首次发布 |
| 2026-11-06 | 接入国内云端多媒体，更新海外媒体默认模型与官方音色 |
| 2026-11-10 至 11-11 | 上下文与最大输出档位、视觉能力识别、任务栏图标与短路径修复 |
| 2026-11-12 | 修复 5 个开放 issue，复核 #8；重新打包并替换发布资产 |
| 2026-11-16 | 创作产线加固（帧数契约、画音分离、导演层、门禁等）；修复分镜徽标重叠、终端槽位不释放、文件读取上限；版本号沿用 0.2.0 |
| 2026-11-21 | 10 项体验修复（画布压层、终端、暗金、OAuth、设置分页、进展挂窗、安卓真实配对、长任务质量）；清理旧包后重出桌面与安卓安装包 |

## 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run audit:flex
npm run docs:check
npm run test:suite
npm run test:unit
npm run test:e2e
npm run build
npm run dist:final
npm run smoke:packaged
```

打包前若 `deliver/Morrow Data` 存在，先移出交付目录（本轮已移到 `.morrow/user-data/` 保留），不要把用户数据打进分发包。