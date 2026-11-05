# Morrow 验证与交付记录

版本：**0.2.0**。本页记录当前交付包、测试结果与文档截图。机器可读摘要见 [verification.json](verification.json) 与 [smoke-packaged.json](smoke-packaged.json)。

## 1. 当前交付

> 2026-11-05：本轮接入国内云端多媒体（Seedream 5.0、Seedance 2.5/2.0、MiniMax H3、Qwen-Image 2.1 Pro、Qwen3-TTS-Flash、MiniMax Speech 2.8），并把云端模型更新到 GPT-Image 2.6、Gemini Nano Banana 2.1、Veo 3.1 稳定版、ElevenLabs v4 / Music v2.5；OpenAI、Qwen、MiniMax 的官方系统音色已全部列入声线选择。同时统一全部输入框、文本域和选择框的流金外框，移除内部高亮加粗框。源码、测试与生产构建已通过。`deliver/` 与 GitHub v0.2.0 将随后更新为本轮构建。

> 2026-11-03：本版删除并排对话，统一输入框/文本域/下拉的微圆角与内嵌焦点环，放大记忆、更多功能、快捷键等界面字号，修复大工作区被 300MB 副本上限误拦的问题；同时修复删除同工作区其他对话会误停 Super-Agent 任务，右侧面板支持拖拽调宽并复用 1px 香槟金分隔线，任务栏图标按主题使用多尺寸 ICO；并行派发改为异步复制/扫描，验收命令兼容 `cd <目录> &&` 与 `2>&1`；Router 重新派发会自动修订当前计划，旧批次不再与新批次并行；浏览器与 Super 共用右侧栏时会自动收起另一方。`deliver/Morrow Data` 已按保护规则暂存并恢复。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 206,888,960 B / 197.30 MiB | `2cfde410f60b248da9c655e41dc8ae835d6d744805edc1a1e1ee0134ec82632b` |
| `Morrow-0.2.0-setup.exe` | 157,437,619 B / 150.15 MiB | `aedfc89c38a3905dff90f961d10f47599070c56b5fb257ada7490e551c0aca8a` |
| **合计** | **364,326,579 B / 347.45 MiB** | 未签名（signed:false） |

- 任务栏图标：改用新的 AppUserModelID（`studio.morrow.agent.desktop`），修复旧 AUMID 缓存导致 Windows 继续显示 Electron 默认图标；窗口图标改为从 extraResources 读取并缩放为 256px。
- `deliver/` 含两个分发 exe、源码包、使用说明、`SHA256SUMS.txt` 与 `LICENSE`；`deliver/Morrow Data` 用户数据保留，未打入分发包。
- 便携版运行时修订：`.morrow-runtime-0.2.0-r020`；已确认运行时目录包含 `icon.ico` / `icon-light.ico` 与主题 PNG。
- 打包：`npm run build` 后 `node scripts/dist-portable.mjs --two-files`；打包时暂存并恢复 `Morrow Data`；耗时 80.5s。
- 冒烟：`npm run smoke:packaged` 通过；CDP 4.9s 就绪，总耗时 6.0s，窗口标题 `Morrow`，首屏显示 `v0.2.0`，预加载 API 与渲染正常。
- 代码统计：`node scripts/count-code.mjs` 统一口径为 185 文件 / 232,462 行；0.1.0 同口径复算为 351 文件 / 171,550 行。

## 2. 代码与测试

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run audit:ui` | 28 CSS + 30 TSX，0 裸排版声明，31 个字号令牌可缩放，焦点环 2px |
| `npm run docs:check` | 通过（26 个 Markdown、47 张 2100×1200 截图、53 个本地图片链接） |
| `npm run test:suite` | 508 单元 / 86 Electron / 41 域 |
| `npm run test:unit` | 508 收集、508 通过、0 跳过、0 失败 |
| `npm run test:e2e` | 86 项流程通过（输入框流金外框回归已覆盖） |
| `npm run smoke:packaged` | 通过（6.0s，CDP 4.9s） |

核心测试入口：`tests/unit/collaboration.test.ts`（37 项协作/Super-Agent）、其余单元按功能域分文件；`tests/e2e` 5 个流程文件。测试截图写 `tmp/e2e-screens`，不进入文档。

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
| `guide-settings-media.png` | 设置 · 多媒体 |
| `guide-memory.png` | 记忆中心：长期/任务/项目/全局记忆 |
| `guide-browser.png` | 内置浏览器：标签、地址栏与真实页面 |
| `guide-terminal.png` | 真实终端：Git Bash 与命令输出 |
| `guide-super-agent.png` | Super-Agent：Morrow/成员协作面板与复核 |

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
