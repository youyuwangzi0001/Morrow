# Morrow 验证与交付记录

版本：**0.2.0**。本页记录当前交付包、测试结果与文档截图。机器可读摘要见 [verification.json](verification.json) 与 [smoke-packaged.json](smoke-packaged.json)。

## 1. 当前交付

> 2026-11-12（字号可读性）：Agent 模式字号下限收敛。顶层阶梯把 9 / 9.5 / 10 / 10.5px 四级合并为 11px 下限，`sm` 与 `sm-plus` 合并为 11.5px，12px 以上保持原值；12px 应用字号下也不会出现字号倒挂。Super-Agent 成员卡片不再自备小字，改为直接复用权限卡语义令牌（标题 14 / 说明 12.5 / 摘要 12 / 辅助 11.75 / 按钮 12.5），停止与插话按钮高度 22→24px。全功能 DOM 扫描 15 个界面（主界面、设置首屏/外观/更多功能、记忆、项目、技能、外部工具、定时任务、版本记录、全局搜索、终端、命令面板、创作台首页/编辑器）均无低于 11px 的可见文字；创作台正文仍为 13.5px。验证：类型检查、UI token 审计（31 个可缩放令牌）、针对性 E2E 通过。

> 2026-11-12：Super-Agent 精简优化。删除右侧协作任务面板与输入框旁「协作」入口，把总目标、成员用量、进度跟盯、停止/继续/插话、重试、验收、冲突与成果全部内联到主对话的成员卡片；历史协作保留静态摘要，恢复型会话在对话末尾兜底显示驾驶舱。新增 `SuperAgentState.toolUseId` 把完整状态精确挂回最近一次 swarm 调用，并修复并行工作区共享基线在副本记录落盘前被提前释放的竞态。验证：类型检查、UI token 审计、文档检查、测试套组登记、协作/核心单测 121 项、工作区隔离单测 11 项、Electron 全量 e2e 85/85 通过，生产构建通过。本轮未重新打包 `deliver/` 便携版与安装包。

> 2026-11-11（第五次）：修复任务栏仍显示白纸图标。根因是 Windows 按 AUMID 缓存任务栏图标，旧 AUMID 的空白缓存不会因更换窗口图标而刷新；便携版改用独立 AUMID（安装版保持与快捷方式一致），移除上一轮失败的注册表兜底与调试文件；同时修复 8.3 短路径下 Git/工作区副本误判（统一用 `realpathSync.native`）。重新打包并覆盖本机 `deliver/` 与 GitHub v0.2.0。

> 2026-11-10（第四次）：修复 OpenDesign 订阅里的 DeepSeek V4.1 Flash 等模型无法审看图片。网关把图片能力放在模型目录的 `architecture.input_modalities`，旧解析器只读顶层字段，导致能看图的对话模型被判成纯文本，`describe_media` 直接回退到本机视觉模型并失败；「刷新可用模型」的同步链路有同样的漏读。现在两处都按 `architecture.input_modalities` 判定，已知模型元数据补上 `supportsVision`，并在恢复订阅时自动为旧凭据补齐能力（不必重新登录）。重新构建并替换本机 `deliver/`。

> 2026-11-10（第三次）：订阅渠道的「最大输出」收敛为 32K / 64K / 128K 三档（1M 上下文模型追加 256K），支持按模型调整并在订阅恢复/重新登录后保留；官方 API 不提供该入口。重新构建并替换本机 `deliver/` 与 GitHub v0.2.0 发布资产。

> 2026-11-10（第二次）：修复模型“思考后无输出直接停止”（断流只有思考时重发原请求、空闲超时可重试、空回合自动重试并在耗尽后给出明确错误），并让订阅创建的 Provider 只在订阅页管理、模型页只保留官方 API 接入。重新构建并替换本机 `deliver/` 与 GitHub v0.2.0 发布资产。

> 2026-11-10：本轮补齐订阅与官方 API 模型的上下文长度调节（每个模型 3 档；OpenDesign 为默认 / 200K / 400K / 1M），并修正上下文压缩摘要标记的展示位置（落在真实切点）。重新构建并替换本机 `deliver/` 与 GitHub v0.2.0 发布资产。

> 2026-11-09：按当前工作区重新构建 v0.2.0，包含设置/本地工具调整与 v0.3.0 规划文档；交付包与 GitHub Release 资产同步替换。

> 2026-11-12（自定义服务模型设置）：设置 → 模型的自定义服务补齐完整模型设置。每个模型行右侧齿轮里可改上下文窗口（128K / 200K / 256K / 400K / 512K / 1M 快捷档，也可填任意 tokens）、最大输出（32K / 64K / 128K / 256K / 384K）、思考强度（启用开关、`reasoning_effort` 与 `thinking budget` 两种映射、该模型真实接受的档位多选）、图片输入与工具调用；服务卡片底部新增「连接与重试」，可切换 OpenAI 兼容 / Anthropic Messages 协议并设置重试次数与退避毫秒（0 表示不重试，4xx 与主动中断不重试）。网关不声明上下文元数据时按已知模型家族兜底（DeepSeek V4 为 1M 上下文 / 393216 输出，Kimi K3、Claude、Gemini、GLM、MiniMax、Qwen3.8、MiMo、Grok 与内置预设同源），本机服务不做家族猜测；手动编辑过的长度带 `contextEdited` / `maxOutputEdited` 标记，刷新模型列表不会被覆盖。新增档位按钮统一为令牌驱动的微圆角矩形（`--r-control` 容器 + `--r-xs` 按钮，选中态复用 `--surface-active` 与 `--line-gold`）。重新打包覆盖本机 `deliver/` 与 GitHub v0.2.0。验证：类型检查、UI token 审计（28 CSS / 30 TSX）、文档检查、测试套组 539 单元 / 86 Electron、新增 Electron 用例 `model-settings.spec.ts` 通过、生产构建与打包冒烟通过。

> 2026-11-11：清理 18 张已无文档引用的历史截图（旧 REPAIR 文档删除后的遗留），文档检查恢复通过；未删除用户数据、测试夹具与运行时资源。

> 2026-11-07：本轮删除死代码、清理旧协作动作队列并合并主进程/渲染层重复类型后重新构建；生产源码 193,310 行，测试 36,188 行。源码、测试、生产构建与 `deliver/` 均使用本轮构建。

> 2026-11-06：本轮接入国内云端多媒体（Seedream 5.0、Seedance 2.5/2.0、MiniMax H3、Qwen-Image 2.1 Pro、Qwen3-TTS-Flash、MiniMax Speech 2.8、Mureka V9.5 配乐），并把云端模型更新到 GPT-Image 2.6、Gemini Nano Banana 2.1、Veo 3.1 稳定版、ElevenLabs v4 / Music v2.5；OpenAI、Qwen、MiniMax 的官方系统音色已全部列入声线选择。同时统一全部输入框、文本域和选择框的流金外框，移除内部高亮加粗框；多媒体验签改为分段切换，云端服务字号与文本模型行对齐。源码、测试、生产构建、`deliver/` 与 GitHub v0.2.0 均使用本轮构建。

> 2026-11-03：本版删除并排对话，统一输入框/文本域/下拉的微圆角与内嵌焦点环，放大记忆、更多功能、快捷键等界面字号，修复大工作区被 300MB 副本上限误拦的问题；同时修复删除同工作区其他对话会误停协作任务，右侧面板支持拖拽调宽并复用 1px 香槟金分隔线，任务栏图标按主题使用多尺寸 ICO；并行派发改为异步复制/扫描，验收命令兼容 `cd <目录> &&` 与 `2>&1`；后续版本已把协作任务合并进工作模式，不再需要单独的模式开关。`deliver/Morrow Data` 已按保护规则暂存并恢复。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 206,924,288 B / 197.34 MiB | `627028a73c1498b0aab13a7c8a694ef2137063937b09541637c60f8994a80244` |
| `Morrow-0.2.0-setup.exe` | 157,471,503 B / 150.18 MiB | `c92a4773776e4a970c4dfe5a9dcc77cd52f9fca1be97f8f50395c66b513a75f3` |
| **合计** | **364,395,791 B / 347.51 MiB** | 未签名（signed:false） |

- 任务栏图标：便携版使用独立 AUMID `studio.morrow.agent.desktop.portable`，绕过旧 AUMID 在部分机器上缓存的空白图标；安装版保持 `studio.morrow.agent.desktop`，与 NSIS 开始菜单快捷方式一致。窗口图标来自 extraResources 的多尺寸 ICO/PNG。
- 短路径修复：Git 返回长路径而 Windows 临时目录可能是 `ADMINI~1` 短名；Git 状态、工作区副本与版本历史统一用 `realpathSync.native` 展开后再比较。
- `deliver/` 保留两个分发 exe、源码包与校验文件、使用说明、`SHA256SUMS.txt` 与 `LICENSE`；本轮的 `deliver/Morrow Data` 用户数据与冒烟生成的 `.morrow-runtime-*` 已移到 `tmp/deliver-userdata-backup/` 暂存，交付目录只留两个 exe。
- 便携版运行时修订：`.morrow-runtime-0.2.0-r020`；已确认运行时目录包含 `icon.ico` / `icon-light.ico` 与主题 PNG。
- 打包：`npm run dist:final`；耗时 68.4s（`docs/verification.json` 的 `durationMs=68435`）。
- 冒烟：`npm run smoke:packaged` 通过；CDP 5.8s 就绪，总耗时 7.1s，窗口标题 `Morrow`，首屏显示 `v0.2.0`，预加载 API 与渲染正常。
- 任务栏实测：便携版启动日志 AUMID 为 `studio.morrow.agent.desktop.portable`；任务栏按钮显示 Morrow 金色 M 图标（DPI 感知截取真实任务栏）。
- 代码统计：`node scripts/count-code.mjs` 统一口径为 195 文件 / 236,409 行（生产 125 文件 / 194,675 行、测试 47 / 36,249）；0.1.0 同口径复算为 351 文件 / 171,550 行。
- 视觉审看实测（本轮修复点）：用本机 OpenDesign Key 走真实网关，`deepseek-v4.1-flash` 目录解析为 `supportsVision: true`，`MediaService.describeMedia` 直接调用该模型返回审看结论（`fallback: false`，14.1s）；旧凭据升级后同样带 `supportsVision`。

## 2. 代码与测试

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run audit:ui` | 28 CSS + 30 TSX，0 裸排版声明，31 个字号令牌可缩放，焦点环 2px |
| `npm run docs:check` | 通过（11 个 Markdown、29 张 2100×1200 截图、34 个本地图片链接） |
| `npm run test:suite` | 539 单元 / 86 Electron / 41 域 |
| `npm run test:unit` | 539 收集、537 通过；2 条 Git 大提交用例在本机清理临时目录时 EPERM，基线复跑同样失败，与本轮改动无关 |
| `npm run test:e2e` | 86/86 通过（7.1m），含新增 `model-settings.spec.ts`：自定义服务从 128K/32K 改到 1M/384K、思考档位、Anthropic 协议与重试策略全链路 |
| `npm run smoke:packaged` | 通过（7.1s，CDP 5.8s） |

核心测试入口：`tests/unit/collaboration.test.ts`（协作任务）、其余单元按功能域分文件；`tests/e2e` 7 个流程文件、86 条 Electron 用例。测试截图写 `tmp/e2e-screens`，不进入文档。

## 3. 文档截图

全部截图在 **默认 2100×1200 物理窗口**下重拍，原始 PNG，不缩放、不压缩、不套滤镜。截图使用测试模式的演示工作区与样例作品，不含用户数据。生成命令：`npm run docs:capture`；校验命令：`npm run docs:check`。

### 3.1 用户指南（12 张）

| 文件 | 内容 |
|---|---|
| `guide-onboarding.png` | 首次引导：认识 Morrow、连接模型、选择文件夹 |
| `guide-chat.png` | 主界面：会话、计划、输入框与工作区 |
| `guide-permission.png` | 审批卡：越界写入、影响范围、允许一次/拒绝 |
| `guide-editor.png` | 文件树、编辑器与已保存状态 |
| `guide-settings-models.png` | 设置 · 模型 |
| `guide-settings-subscriptions.png` | 设置 · 订阅 |
| `guide-settings-appearance.png` | 设置 · 外观 |
| `guide-settings-media.png` | 设置 · 本地与多媒体 |
| `guide-memory.png` | 记忆中心：长期/任务/项目/全局记忆 |
| `guide-browser.png` | 内置浏览器：标签、地址栏与真实页面 |
| `guide-terminal.png` | 真实终端：Git Bash 与命令输出 |
| `guide-collaboration.png` | 协作成员卡片：进度跟盯、用量与停止/插话 |

### 3.2 创作台（15 张）

| 文件 | 内容 |
|---|---|
| `studio-home.png` | 作品库与一句话入口 |
| `studio-create.png` | 创建作品：形态、一句话、精细度、比例与补充要求 |
| `studio-blueprint.png` | 蓝图：主线、人物、结构、风格与费用 |
| `studio-writing.png` | 写作台：大纲、纸页、候选与协作者 |
| `studio-assistant.png` | 协作者计划卡：影响、费用、待确认 |
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

## 4. 验证边界

- 安装包只做了打包与便携版冒烟；未执行 per-machine 安装，避免改动本机 `Program Files` 与快捷方式。
- 未配置代码签名证书；两个 exe 均为 `signed:false`，首次运行可能触发 SmartScreen。
- 外部模型、ComfyUI、ACE-Step、FFmpeg、TTS、订阅账号与额度由用户环境决定；未逐一做真实付费调用或全渠道登录。
- 截图展示的是测试模式下的样例界面；不代表用户本机已有同样的项目或数据。
- 旧版文档、历史验收记录与旧截图已归档到 `.qoder/internal/verification/archive-2026-11-02/`（本机，不进入仓库）。

## 5. 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run docs:check
npm run test:suite
npm run test:unit
npm run test:e2e
npm run docs:capture
npm run build
npm run dist:final
npm run smoke:packaged
```

打包前若 `deliver/Morrow Data` 存在，先暂存到 `tmp/`，打包完成后再原样恢复。
