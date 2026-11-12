# 交付验证

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页记录 Morrow 0.1.0 的交付证据：跑了哪些门禁、结果如何、交付文件与校验值在哪、哪些结论没有验证。它是发布与验收的依据，不描述产品用法。

## 目录

- [结论](#结论)
- [交付物与校验](#交付物与校验)
- [测试与规模](#测试与规模)
- [本版能力状态](#本版能力状态)
- [截图证据](#截图证据)
- [验证边界](#验证边界)
- [复现](#复现)

## 结论

2026-10-24 首发，2026-11-05 清理死代码与空行后重发（功能不变，资产已替换，旧哈希作废）。门禁记录日期 2026-10-26，对应版本 `0.1.0`、运行时 `r019`、平台 Windows 10/11 x64。交付校验以下表的 11-05 重发包为准。

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 通过；50 个 CSS 文件与 66 个 TSX 文件，0 处裸排版值（文档预览 iframe 白名单除外） |
| `npm run test:unit` | 14 个套件 / 952 个用例：944 passed + 8 skipped |
| E2E 全量 | 17 个套件 / 209 个用例；本轮未重跑全量，沿用上一轮基线 |
| 定向 E2E | 终端 1/1、Shell 选择 1/1、浏览器滚动条 1/1、上下文 5/5 |
| 打包版 E2E | 5/5（18.2s，便携包实际解压启动） |
| 指南截图 | 11 个截图用例全部通过，生成 12 张图 |
| 交付 | 两个 exe 与源码包；Release 另附 `LICENSE`、`Morrow-0.1.0-usage.txt`、`SHA256SUMS.txt` 等 |

机器证据：[`packaging.json`](evidence/packaging.json)、[`smoke-packaged.json`](evidence/smoke-packaged.json) 对应 2026-11-05 重发包；[`artifacts.json`](evidence/artifacts.json) 与 [`eval-results.json`](evidence/eval-results.json) 是 2026-10-26 验收轮记录，`artifacts.json` 里的资产哈希已标为旧基线（`legacyArtifacts`），不用于校验当前 Release 附件。

## 交付物与校验

以下数值取自 GitHub Release v0.1.0 的发布资产（2026-11-05 清理后重发包），与 Release 附带的 `SHA256SUMS.txt` 逐项一致：

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.1.0-portable.exe` | 205,348,352 B / 195.84 MiB | `e8cac5295894ef6c1bdd2a84b364baec75e9ea4437bbfd78686ad73194674150` |
| `Morrow-0.1.0-setup.exe` | 156,165,451 B / 148.93 MiB | `8dfe743dba5b84477aa3a8610c1efa93fc83b5d019d1b89d0adfb73376ede48a` |
| `Morrow-0.1.0-source.zip` | 11,839,285 B / 11.29 MiB | `bcc991bf8079a25002659017a65e79f6ae8870073e0564520c0392ee48fefe2d` |

`SHA256SUMS.txt` 覆盖以上三个文件；源码包另有侧车 `Morrow-0.1.0-source.zip.sha256`。本分支不包含 exe，无法在本地重算，下载后请以 Release 附件为唯一校验依据。源码包内的文档是打包前的快照，不包含本次文档重构。

便携版首次运行会在 exe 同级解压 `.morrow-runtime-0.1.0-r019`，并通过内嵌应用 zip 的 SHA-256 戳记校验缓存。运行中的实例会占用该缓存，关闭应用后再清理。

## 测试与规模

统计口径与 v0.1.0 发布记录一致：`wc -l`；生产 `src/`、测试 `tests/`、构建脚本 `scripts/` 与启动器 `build/launcher/`；不含 `node_modules`、构建产物、文档、图片与媒体夹具。

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 294 | 125,181 |
| 测试 `tests/` | 46 | 43,481 |
| 构建脚本 `scripts/` | 10 | 2,263 |
| 启动器 `build/launcher/` | 1 | 625 |
| **代码合计** | **351** | **171,550** |

单元测试 14 个套件 / 952 个用例（944 passed + 8 skipped）；E2E 17 个套件 / 209 个用例，沿用上一轮基线，记录为 197 passed + 11 skipped；打包冒烟 5/5。Agent 质量评测四项指标与结果见 [开发指南](DEVELOPMENT.md#质量门槛与评测) 与 [`eval-results.json`](evidence/eval-results.json)。

## 本版能力状态

### 模型与订阅

- 内置目录按服务商公开资料核对：DeepSeek V4.1 Flash 为 1M / off-low-high-max，V4 Pro 为 high-max；Kimi、Claude、GPT-6 补齐 max；Qwen 为 low/medium/xhigh；Gemini 三档；Grok 与 Muse 四档；GLM-5.2 已从目录移除。
- Qoder 不再维护静态模型表：账号接口实测返回 15 个 chat 模型、200K / 400K / 1M 上下文、默认 200K；以 max 思考加 400K 上下文的真实请求成功。
- 订阅渠道的安全与限制见 [模型与订阅](MODELS.md#订阅渠道)。本机只有 Qoder 与 Codex 完成真实账号验证，其余渠道只验证登录页、协议与端点，没有编造额度。

### 媒体审看

- 顺序固定：当前对话模型 → 声明视觉能力的本地模型 → 真实失败。
- 视觉请求关闭思考并给 2048 输出预算；DeepSeek 直接 Provider 的 `off` → `none`，Qoder 代理保持 `off`。
- 本地只选声明视觉能力的模型或 Coder390 预设；两边失败返回真实错误与配置建议，不用生图或文本模型冒充审看。
- 单测覆盖请求顺序、思考关闭、输出预算与本地模型筛选；未在最终构建上重复消耗真实视觉额度。

### 终端与稳定性

- 默认终端为 Git Bash；Windows PowerShell 5.1 与 CMD 选项移除，保留 PowerShell 7 与 WSL。
- 终端空态隐藏滚动条，内容溢出才显示；轨道 8px、滑块 6px 实色全圆角。
- 受限测试令牌下 Git Bash 的 MSYS 共享内存不可用，打包 PTY 回归显式使用 PowerShell 7；普通桌面默认仍是 Git Bash。
- 打包版启用本地 crashReporter，记录未捕获异常、未处理 Promise 与子进程消失；主窗口渲染进程崩溃后自动 reload，60 秒内最多两次。
- 用户报告的闪退时刻没有对应 WER 记录，根因未确认；后续复现可查看 `logs/main.log` 与本地转储。

## 截图证据

12 张指南截图来自当前构建的真实 Electron E2E，覆盖首次启动、主界面、审批卡、编辑器与画布、模型/订阅/外观/多媒体设置、浏览器、终端、记忆中心与项目页。文档只引用这些图片，不手工伪造界面；替代文本写在各文档的引用处。

| 文件 | 实际尺寸 | 引用于 |
|---|---:|---|
| `screens/guide-onboarding.png` | 2100×1200 | [README](../README.md)、[README.zh](../README.zh.md)、[快速开始](GETTING-STARTED.md) |
| `screens/guide-chat.png` | 2100×1200 | [README](../README.md)、[README.zh](../README.zh.md)、[用户指南](USER-GUIDE.md) |
| `screens/guide-permission.png` | 2102×1203 | [用户指南](USER-GUIDE.md) |
| `screens/guide-editor.png` | 2102×1203 | [用户指南](USER-GUIDE.md) |
| `screens/guide-settings-models.png` | 1320×966 | [快速开始](GETTING-STARTED.md) |
| `screens/guide-subscriptions.png` | 1322×969 | [README](../README.md)、[README.zh](../README.zh.md)、[模型与订阅](MODELS.md) |
| `screens/guide-settings-appearance.png` | 1320×966 | [用户指南](USER-GUIDE.md) |
| `screens/guide-settings-media.png` | 1320×966 | [多媒体](MEDIA.md) |
| `screens/guide-browser.png` | 2100×1200 | [用户指南](USER-GUIDE.md) |
| `screens/guide-terminal.png` | 2100×1200 | [用户指南](USER-GUIDE.md) |
| `screens/guide-memory.png` | 2100×1200 | [用户指南](USER-GUIDE.md) |
| `screens/guide-projects.png` | 1560×990 | [用户指南](USER-GUIDE.md) |

尺寸是抓图时的实际像素：多数主窗口图为 2100×1200，设置页为 1320×966；03/04 为 2102×1203、06 为 1322×969、12 为 1560×990。本版没有重拍，也没有缩放或裁剪，因此不是每张都恰好 2100×1200。`guide-browser.png` 抓取时页面内容区为空，图只展示标签页、地址栏与前进/后退按钮，不代表浏览器只能显示空白。

## 验证边界

- E2E 全量 17 个套件 / 209 个用例沿用上一轮基线；本轮没有重跑完整套件，只跑了受影响用例与截图用例。
- 真实订阅账号只有 Qoder 与 Codex 可用；Kimi、GLM、MiniMax、Step、Command Code、Cline、Antigravity、OpenCode 没有完成本机账号登录实测。
- 媒体真实生成依赖本机 GPU 与 ComfyUI；无引擎时 skip，不把 mock 结果当作真实生成。
- 真实视觉调用未在最终构建上重复执行；请求顺序与优先级由单测覆盖。
- 用户报告的闪退没有 WER 或 Application Error 记录，已补崩溃日志与自动恢复，根因待复现。
- 两个 exe 均未签名，首次运行可能触发 SmartScreen；请用 Release 的 `SHA256SUMS.txt` 校验。
- 本分支不包含 `deliver/` 下的 exe，无法在本地复核交付哈希；交付物的实际哈希以 Release 附件为准。

## 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run test:unit
npm run test:eval
npx playwright test
npm run dist:all
npm run smoke:packaged
```

真实账号与真实引擎的用例需要额外环境变量与本机资源，按 [模型与订阅](MODELS.md#订阅渠道) 与 [多媒体](MEDIA.md) 配置；未配置时应看到明确的 skip 或真实错误，而不是伪造通过。