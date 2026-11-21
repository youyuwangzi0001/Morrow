# 交付验证

这一页记录本次交付的可核对结果：三个产物文件的字节数与 SHA-256、便携包的启动冒烟、本轮修复的回归、测试与门槛的实测输出、截图来源与验证边界。所有数字都来自本机实测或 `deliver/` 里的文件，不引用上一批构建的哈希。

机器可读摘要有两份：`docs/verification.json` 是打包摘要，`docs/smoke-packaged.json` 是冒烟摘要。两者都由脚本在每次打包时重写，已列入 `.gitignore`，属于最近一次本机运行的过程记录，不在仓库里。其中的哈希与本节指纹不是同一批产物，本页只把它们当作过程记录。

## 交付产物

两个文件都在 `deliver/`，与同目录的 `SHA256SUMS.txt` 逐条一致。哈希用 `Get-FileHash -Algorithm SHA256` 重新计算过。

| 文件 | 字节 | 大小 | SHA-256 |
|---|---:|---:|---|
| `Morrow-0.2.0-portable.exe` | 207,418,736 | 197.81 MiB | `0ea73491ef9a663690c97117148950fed21a9e07965237c24c58a30fa29a6eed` |
| `Morrow-0.2.0-setup.exe` | 157,686,712 | 150.38 MiB | `64a65fad5256498b93aa90e35bb906899693336622758c315003090c3b6d9d82` |

两个文件合计 365,105,448 B（348.19 MiB）。哈希与同目录的 `SHA256SUMS.txt` 逐条一致。

- 便携版是单文件启动器，内嵌应用 zip；首次运行在 exe 同级解压 `.morrow-runtime-<版本>-<修订>`，之后复用缓存。
- 安装包是 NSIS 自解压，可选安装目录，创建开始菜单与桌面快捷方式；安装版数据目录是 `%APPDATA%\Morrow`。
- 两个 exe 都用自签名证书做过 Authenticode 签名：主体 `CN=Morrow Studio`，SHA-1 指纹 `B5BF433D707CB11DA0A2E558DA98C4BFDF6C69C1`，带 RFC3161 时间戳，`signtool verify /pa` 与 `Get-AuthenticodeSignature` 双校验通过。证书不是受信任 CA 签发，首次运行 SmartScreen 仍可能要求“更多信息 → 仍要运行”；证书与说明在 `build/signing/`。

安卓伴侣端已迁出本仓：源码、文档与 `Morrow-Android-0.2.0.apk` 都在 [Morrow-Android](https://github.com/youyuwangzi0001/Morrow-Android) 的 v0.2.0 发布页，本仓的 v0.2.0 发布页只保留这两个 Windows 包。APK 本轮的哈希是 `07bdb684ee52aaed8db4327755545b375216dd1e091dc60efb7b6e91bbcf276c`（2,323,442 B），与桌面端同一轮重新构建。安卓侧的验证记录在[那个仓库的 VERIFICATION.md](https://github.com/youyuwangzi0001/Morrow-Android/blob/main/docs/VERIFICATION.md)。

## 冒烟验证

便携包真实启动过一次，不是只看文件存在。冒烟脚本从 `deliver/` 启动 exe，用 CDP 检查窗口与首屏，再抓一张图。

| 项 | 实测 |
|---|---|
| 被测文件 | `Morrow-0.2.0-portable.exe`（207,418,736 B，`0ea73491…`） |
| 启动参数 | `--no-sandbox --test-mode --remote-debugging-port=4036`，另带独立的 user-data-dir 与 data-dir |
| CDP 就绪 | Chrome/152.0.7977.167，6,162 ms |
| 窗口标题 | Morrow |
| 界面版本 | 首屏显示 v0.2.0，确认版本号已进产物 |
| 渲染 | 首屏文本正常，预加载 API 可用 |
| 运行位置 | 解压到 `.morrow-runtime-0.2.0-r020` 后启动 |
| 截图 | `tmp/verification/screens/packaged-smoke.png`（本机生成物，不入库） |
| 总耗时 | 7.2 s |
| 摘要 | `docs/smoke-packaged.json`，`ok: true` |

- 冒烟覆盖的是“能启动、能渲染、能截图、预加载 API 可用”，不覆盖文件写入、模型调用与创作台产线。
- `docs/smoke-packaged.json` 里的 `exeSha256` 与本节表格的便携版一致（`0ea73491…`），都是本次产物。
- 冒烟结束后脚本会清理解压出的运行时缓存，避免交付目录被数百 MB 的缓存污染；清理失败会写进摘要，不静默跳过。
- 安装包没有执行 per-machine 安装，只做了归档完整性检查；未改动本机 `Program Files` 与快捷方式。

## 本轮修复的回归

本轮交付带着以下修复。每一条都在当前测试里有对应断言，删掉修复测试会红。

| 缺陷 | 根因 | 回归位置 |
|---|---|---|
| 模型输出非法 JSON 参数后反复重试同一个坏调用 | 旧解析只去代码围栏与尾逗号，Windows 路径与正则里的反斜杠、裸换行都修不了，报错也不指出位置 | `tests/unit/core-runtime.test.ts` 的非法转义与截断样本 |
| 300 KB 的源码文件只能读到开头 | `read_file` 的读取上限停在 256 KB，仓库里不少文件超过这个值 | `tests/unit/core-tools.test.ts` 的 300 KB 读到尾部用例 |
| 终端槽位满时 `stop` 成功却仍报满 | 上限把已退出记录也当运行中，`stop` 只发信号不释放记录 | `tests/unit/main-runtime.test.ts` 的“已退出记录不占槽位” |
| 分镜卡的“候选”与“时长”徽标重叠 | 两个徽标各自绝对定位到同一右下角，实测出现交叠 | `tests/e2e/studio.spec.ts` 逐卡比较徽标边界 |
| 进展浮窗展开时盖住消息操作与画布 | 浮窗悬浮在主区右上角，命中区域压住消息操作行与终端 | `tests/e2e/ui.spec.ts`、`tests/e2e/workspace.spec.ts` 的让位断言 |
| 安卓真实配对始终 4401，收不到 welcome | 手机侧通道字面量是 `wss`，桌面签名校验的是 `lan`，跨语言握手被拒 | `MorrowAndroid` 的 `CrossDeviceE2ETest`（6 项） |

- 前五条的断言在 `npm run test:unit` 与 `npm run test:e2e` 里随全量执行，不靠人工点按。
- 最后一条在安卓仓库的 JVM 套组里执行：桌面 Node 的 `DirectChannel` 与 Kotlin 的 `RelaySocketClient` 跑真实握手与加密帧。
- 没有证据的改动不写进这张表；测试通过不等于功能完整，未接线的页面在“验证边界”里单独列出。

## 测试与检查

本次交付的测试与四道本地门槛结果如下。数量是当前维护预算内的真值。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过：`tsconfig.node.json` 与 `tsconfig.web.json` 两套配置都无错误 |
| `npm run audit:ui` | 通过：0 条裸排版声明，字号令牌全部由基值推导，焦点环 2 px |
| `npm run audit:flex` | 通过：没有被压成竖排的行内尾部标签 |
| `npm run docs:check` | 通过：链接与锚点存在，30 张截图均为 2100×1200 且被引用 |
| `npm run test:suite` | 1026 个单元 / 96 条 Electron / 43 个域，未超预算 |
| `npm run test:unit` | 50 个文件、1026 项通过 |
| `npm run test:e2e` | 16 个文件、96 条：95 通过、1 跳过、0 失败，9.5 分钟 |

- 唯一跳过的是 `packaged-parallel`，它需要现成的打包产物；跳过项不计入通过。
- 全量 E2E 记录在 `docs/evidence/e2e-final.log`。安卓侧的 939 项 JVM 用例与 276 项静态验收由 [Morrow-Android](https://github.com/youyuwangzi0001/Morrow-Android) 仓库自己的 `scripts/verify.sh` 覆盖，本页不再摘录。
- `verify` 链是 typecheck → audit:ui → audit:flex → docs:check → test:suite → test:unit → test:e2e；上面七行都通过时整链才为绿。
- `test:suite` 是静态校验：它只读测试源码与 `tests/core-coverage.json`，不执行任何用例；通过它不代表用例通过。

## 截图与示意图清单

`docs/screens/` 有 30 张桌面截图，全部 2100×1200，来自测试模式与内置演示工作区。来源分三处，不能混写。

| 来源 | 张数 | 说明 |
|---|---:|---|
| `npm run docs:capture` | 27 | 12 张引导、设置与工作区，15 张创作台，直接写入 `docs/screens/` |
| `npm run test:pair-panel` | 1 | 桌面端配对面板，不是手机截图 |
| E2E 顺手截取 | 2 | 两张设置页，需要手工搬入 `docs/screens/` |

- 30 张均在 2026-11-21 用当前 0.2.0 构建重拍：`docs:capture` 三个 spec、配对面板按 2100×1200 裁切、E2E 的 `settings-cloud-media.png` 与 `settings-local.png` 从 `tmp/e2e-screens/` 拷入。
- 手机端本轮没有真机或模拟器，因此 **0 张手机截图**；`docs/diagrams/mobile-pages.png` 是按 Compose 结构重画的示意图，不是界面截图。
- 安卓的构建、签名、JVM 与静态验收数字见 `Morrow-Android` 仓库的 `docs/evidence/`，本页不再摘录。

| 文件 | 内容 |
|---|---|
| `guide-onboarding.png` | 首次引导：认识 Morrow、连接模型、选择文件夹 |
| `guide-chat.png` | 主界面：会话、计划、输入框与工作区 |
| `guide-permission.png` | 审批卡：文件夹外路径、影响范围与按钮 |
| `guide-editor.png` | 文件树、编辑器与保存状态 |
| `guide-settings-models.png` | 设置 · 模型 |
| `guide-settings-subscriptions.png` | 设置 · 订阅 |
| `guide-settings-appearance.png` | 设置 · 外观 |
| `guide-settings-media.png` | 设置 · 本地与多媒体 |
| `guide-memory.png` | 记忆中心：长期、任务、项目与全局记忆 |
| `guide-browser.png` | 内置浏览器：标签、地址栏与真实页面 |
| `guide-terminal.png` | 真实终端：Git Bash 与命令输出 |
| `guide-collaboration.png` | 协作成员卡片：进度、用量与停止 / 插话 |
| `settings-cloud-media.png` | 云端多媒体服务设置页 |
| `settings-local.png` | 本地模型与本地媒体引擎设置页 |
| `pair-panel-devices.png` | 手机配对：通道、配对码与已配对设备 |
| `studio-home.png` | 作品库与一句话入口 |
| `studio-create.png` | 创建作品：形态、一句话、精细度与补充要求 |
| `studio-blueprint.png` | 蓝图：主线、人物、结构、风格与费用 |
| `studio-writing.png` | 写作台：大纲、纸页、候选与协作者 |
| `studio-assistant.png` | 协作者计划卡：影响、费用与待确认 |
| `studio-storyboard.png` | 分镜板与单镜详情 |
| `studio-canvas.png` | 漫剧画布：镜头与素材节点、连线 |
| `studio-voice.png` | 声音 · 配音 |
| `studio-music.png` | 声音 · 音乐 |
| `studio-timeline.png` | 时间线：监视器、六轨、波形与时间码 |
| `studio-review.png` | 检查：本地检查、模型审稿与引擎 |
| `studio-delivery.png` | 交付：成片预览、格式与预检 |
| `studio-settings.png` | 创作台设置 |
| `studio-trash.png` | 回收站 |
| `studio-light.png` | 素纸主题作品库 |

- 创作台截图里的作品是内置样例，不是真实作品；图注要写明这一点。
- 手机端本轮没有可交付的截图，移动端文档使用桌面配对面板图，并在图注里说明来源。手机端的真实界面截图在 [Morrow-Android](https://github.com/youyuwangzi0001/Morrow-Android) 仓库的 `docs/screens/`。
- 示意图共三张：`diagrams/architecture.png`（分层数据流，用在 [ARCHITECTURE.md](ARCHITECTURE.md)）、`diagrams/pairing-flow.png`（配对九步时序，用在 [PAIRING.md](PAIRING.md)）、`diagrams/mobile-pages.png`（六页与数据来源，用在 [MOBILE.md](MOBILE.md)）。它们都是结构图，不是界面截图，也不参与 2100×1200 的截图尺寸检查。

## 验证边界

下面这些没有被本次交付证明，不能从上面的绿勾里推断。

- 安装包没有执行 per-machine 安装，只验证了解压后的文件与文件夹版一致；安装路径、快捷方式与卸载流程没有实机走查。
- 两个 exe 用工程内自签名证书签名（`build/signing/`）。它不是应用商店或正式分发渠道。
- 安卓伴侣端已迁到独立仓库，本页不再为它的测试规模与界面证据背书；那里的边界逐条写在 [Morrow-Android 的 VERIFICATION.md](https://github.com/youyuwangzi0001/Morrow-Android/blob/main/docs/VERIFICATION.md)。
- 公网中继是占位实现，手机只能在同一局域网内直连；没有跨网络、NAT 穿透与移动网络下的证据。
- 手机配对协议本身有两端向量与 JVM 用例（ECDH 向量、relay 协议向量、SecureChannel 双向密文、桌面解密校验），但这些只证明算法一致，不证明设备上跑通。
- 桌面端调用 `relayPair.issue` 时如果不传 `relayHint`，票据就缺局域网地址。0.2.0 的面板已改为自动补上局域网地址并在缺地址时当场说明原因，但这条路径只在模拟器联调中跑过，没有真机证据。
- 外部模型、订阅渠道、ComfyUI、FFmpeg、TTS 与音乐服务依赖你的环境；没有逐一做真实付费调用，也没有覆盖全部订阅渠道的登录。
- 截图来自测试模式与演示工作区，不代表你本机已有同样的项目或数据；`packaged-parallel` 因缺少打包产物而跳过。
- `docs/verification.json` 与 `docs/smoke-packaged.json` 是最近一次打包的机器摘要，已列入 `.gitignore`，只在生成它的那台机器上存在；其中的哈希对应上一批产物，本页没有引用它们作为交付指纹。

## 交付沿革

时间线只记可查的交付节点，不把未发布的改动写成版本号。

| 时间 | 内容 |
|---|---|
| 2026-10-27 | 首次发布桌面版与安卓调试包 |
| 2026-11-06 | 接入国内云端多媒体，更新海外媒体默认模型与音色 |
| 2026-11-10 至 11-11 | 上下文与最大输出档位、视觉能力识别、任务栏图标与短路径修复 |
| 2026-11-12 | 修复若干开放 issue，重新打包并替换发布资产 |
| 2026-11-16 | 创作产线加固：帧数契约、画音分离、导演层、出包门禁 |
| 2026-11-21 | 体验修复、源码扁平化合并，重出桌面双包与安卓 APK；单测 985、E2E 96 |
| 2026-11-21 | 安卓补齐事件流、审批生物识别、通知、设置、作品预览与协作干预；单测 1014、安卓 JVM 919、静态验收 265 |
| 2026-11-21 | 文档体系按扁平结构重写：13 篇正文、双语首页、三张示意图与截图复核，校验脚本同步加固 |
| 2026-11-23 | 手机端补齐桌面信息同步（命令执行、文件增删改、待办、提示），发送改为等桌面回执；重出桌面双包与安卓 APK，原地覆盖 v0.2.0。单测 1026、安卓 JVM 939、静态验收 276 |

## 复现

在仓库根执行。构建前先准备私有提示词源，否则 `npm run build` 会在 `prebuild` 明确失败。

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

- 私有提示词源默认在 `%APPDATA%\Morrow-build\prompts`，可用 `MORROW_PROMPT_SOURCE` 指向别处。缺源时只能跑 `npm run typecheck`。
- 打包前确认 `deliver/` 没有 `Morrow Data`；有就先暂存到 `tmp/`，打包后恢复。
- 安卓复现不在本仓：到 [Morrow-Android](https://github.com/youyuwangzi0001/Morrow-Android) 按它的 `docs/BUILD.md` 构建 release 变体。
- 哈希复核：

```powershell
Get-FileHash deliver\Morrow-0.2.0-portable.exe, deliver\Morrow-0.2.0-setup.exe -Algorithm SHA256
```