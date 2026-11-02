# Morrow 0.1.0 验收记录（r019）

> 日期：2026-10-26 · 版本：0.1.0 · 运行时：r019 · 平台：Windows 10/11 x64
>
> 交付形态：单文件便携版 + NSIS 安装包 + 源码包

## 1. 结论

- 类型检查：`npm run typecheck` **0 error**。
- UI 令牌审计：`npm run audit:ui` **通过**，50 个 CSS + 66 个 TSX，0 处裸排版值（文档预览 iframe 白名单除外）。
- 单元测试：**14 个套件 / 952 个用例**（944 passed + 8 skipped）。
- E2E：**17 个套件 / 209 个用例**；本轮定向终端、Shell、打包冒烟与 12 张指南截图全部通过。
- 打包版：**5/5**（18.2s，r019 便携包实际解压启动）。
- 文档：**15 篇 Markdown / 2,142 行**；12 张指南图由真实 Electron E2E 重新生成。
- 交付：**5 个分发文件 / 345.81 MiB**，另有源码包与用户数据 `Morrow Data`（不计入分发）。

## 2. 版本与规模

统计口径：`wc -l`；代码含 `src/`、`tests/`（含 E2E）、`scripts/`、`build/`；文档为根目录 + `docs/` Markdown；不含 `node_modules`、构建产物、JSON 清单与图片。

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 314 | 125,812 |
| 测试 `tests/`（含 E2E） | 66 | 43,456 |
| 其中 E2E 套组 `tests/e2e/` | 20 | 19,236 |
| 构建脚本 `scripts/` + `build/` | 11 | 2,896 |
| **代码合计** | **391** | **172,164** |
| Markdown 文档 | 15 | 2,142 |
| 指南截图 | 12 | 2100×1200 为主 |

## 3. 本轮能力状态

### 3.1 模型与订阅

- 内置 API 目录与思考档位按服务商公开资料核对：DeepSeek V4.1 Flash 1M / off-low-high-max，V4 Pro high-max；Kimi、Claude、GPT-6 补齐 max；Qwen 仅 low/medium/xhigh；Gemini 三档；Grok/Muse 四档；GLM-5.2 移除。
- Qoder 删除静态模型表，模型目录实时读取账号接口；实测 15 个 chat 模型、200K/400K/1M 上下文、默认 200K；max + 400K 真实请求成功。
- 订阅渠道、代理、额度与安全边界见 `docs/SUBSCRIPTIONS.md`；未在本机验证的渠道只做登录页/协议/端点验证，不伪造额度。

### 3.2 媒体审看

- 顺序固定：当前对话模型 → 声明视觉能力的本地模型 → 真实失败。
- 视觉请求关闭思考并给 2048 输出预算；DeepSeek 直接 Provider 的 off→none，Qoder 保持 off。
- 本地只选声明视觉能力的模型或 Coder390 预设；两边失败返回真实错误与配置建议，不用生图/文本模型冒充审看。
- 单测覆盖请求顺序、思考关闭、输出预算与本地模型筛选；未在最终构建上重复消耗真实 DeepSeek 视觉额度。

### 3.3 终端与滚动条

- 默认终端 **Git Bash**；Windows PowerShell 5.1 与 CMD 选项移除，保留 PowerShell 7 / WSL。
- 终端空态隐藏滚动条，内容溢出才显示；轨道 8px、滑块 6px 实色全圆角、无渐变/箭头。
- 受限测试令牌下 Git Bash MSYS 共享内存不可用，打包 PTY 回归显式使用 PowerShell 7；真实桌面默认仍为 Git Bash。

### 3.4 稳定性

- 打包版启用本地 crashReporter；记录 uncaughtException、unhandledRejection、child-process-gone。
- 主窗口渲染进程崩溃后自动 reload（60 秒内最多两次），记录无响应事件。
- 用户报告的闪退时刻没有对应 WER 记录，根因未确认；后续复现可查看 `logs/main.log` 与本地转储。

### 3.5 文档与截图

- 文档体系从零重写：README、文档索引、用户指南、功能参考、模型、订阅、媒体、架构、设计系统、安全、排障、评测、验收、贡献与安全策略。
- 12 张截图来自当前 r019 UI 的真实 Electron E2E：首次启动、主界面、审批卡、编辑器、模型/订阅/外观/多媒体设置、浏览器、终端、记忆中心、项目主页。截图来源与尺寸见 `docs/guide/screens/manifest.json`。

## 4. 验证门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 50 CSS + 66 TSX，0 裸排版值 |
| `npm run test:unit` | 14 文件 / 952 用例；944 passed + 8 skipped |
| E2E 全量 | 17 文件 / 209 用例；本轮未重跑全量，沿用上一轮基线 |
| 定向 E2E | 终端 1/1、Shell 选择 1/1、浏览器滚动条 1/1、上下文 5/5 |
| 打包版 E2E | 5/5（18.2s，r019） |
| 指南截图 | 11 个截图用例全部通过，生成 12 张图 |

## 5. 交付物

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.1.0-portable.exe` | 205,956,096 B / 196.41 MiB | `c6276d60c5aad2a4c785576ce9b854e7ff96e1b92e0f96bd6aa5aaab56ba96e3` |
| `Morrow-0.1.0-setup.exe` | 156,651,619 B / 149.39 MiB | `17faadf2304d2312ca0d043a3fb92207433d87959b29060a56064c00a47a6141` |
| `使用说明.txt` | 3,951 B | `9926e526ec2554abb8b574c18747c663efbe8c657396cc2542c6a27120d909a6` |
| `SHA256SUMS.txt` | 338 B | `2125265725f6a22f2b7f196e8eb10833560016375ad3d8b3bb7000f4e4f0e77f` |
| `LICENSE` | 1,070 B | `5a147a0421a711a0b44a5ecab6f6b0e8f0002dca17a8ecccef1599faaf70aa97` |
| **分发合计** | **5 文件 / 362,613,074 B / 345.81 MiB** | 未签名（signed:false） |

源码包 `Morrow-0.1.0-source.zip` 单独附带：大小与 SHA-256 以同目录侧车 `Morrow-0.1.0-source.zip.sha256` 为准（源码包内文档为打包前快照，最终哈希以侧车为准）；不计入上表五件分发文件。

本轮便携版使用 **r019** 运行时目录，并通过内嵌应用 zip 的 SHA-256 戳记校验缓存。旧的 r010–r016 运行时缓存、历史 `tmp`/`release` 打包缓存与测试残留已清理；`deliver/` 的分发文件只保留当前五个，另保留源码包与用户数据 `Morrow Data`。当前运行实例若仍占用 r017/r018 运行时缓存，关闭应用后可删除；缓存不属于分发文件。

## 6. 验证边界

- E2E 全量 17 个套件 / 209 例沿用上一轮基线；本轮没有重新跑完整套件，只跑了受影响用例与截图用例。
- 本机只有 Qoder/Codex 有可用真实账号；Kimi、GLM、MiniMax、Step、Command Code、Cline、Antigravity、OpenCode 只验证登录页/协议/端点，没有编造额度。
- 媒体真实生成依赖本机 GPU/ComfyUI；无引擎时 skip，不把 mock 结果当真实生成。
- 真实 DeepSeek 视觉调用未在最终构建上重复执行；请求层与优先级由单测覆盖，下一次真实开发直接走当前模型优先路径。
- 用户报告的闪退没有 WER/Application Error 记录；已补崩溃日志与自动恢复，根因仍待复现。
- 便携版/安装包未签名，首次运行可能触发 SmartScreen；请用 `SHA256SUMS.txt` 校验。

## 7. 维护

- 新功能合并前更新 `FEATURES.md`、`USER-GUIDE.md` 与对应专项文档。
- 模型/协议变化更新 `MODELS.md`、`SUBSCRIPTIONS.md`、`MEDIA-MODELS.md`。
- 视觉变化更新 `DESIGN-SYSTEM.md` 与 `docs/guide/screens/`（重新跑截图用例并更新 manifest）。
- 每次发布更新本文件的规模表、门禁结果与交付哈希。
