# Morrow 0.2.0 验收记录（r043）

> 日期：2026-10-28 · 版本：0.2.0 · 运行时：r043 · 平台：Windows 10/11 x64
>
> 交付形态：单文件便携版 + NSIS 安装包 + 源码包

## 1. 结论

- 类型检查：`npm run typecheck` **0 error**。
- UI 令牌审计：`npm run audit:ui` **通过**，58 个 CSS + 83 个 TSX，0 处裸排版值。
- 单元测试：**29 个套件 / 1012 个用例**（1004 passed + 8 skipped）。
- 受影响 E2E：`18/19/20/21` 共 **9/9**；打包版 E2E **6/6**（27.6s）。
- 便携版冒烟：**1/1**（3.7s，CDP 2.5s，运行时 `.morrow-runtime-0.2.0-r043`）。
- 文件管理器：真实便携版在 **Medium（任务令牌）与 High（直接启动）** 下分别验证「打开数据目录」与「在资源管理器中定位导出文件」；两次 IPC 均返回 `ok`，Explorer 窗口真实出现（`exports`），关闭应用后隐藏任务与代理进程均被清理。
- 创作台作品库只剩 **三份内置样例**（《雨停之前》《雨伞铺的第七个夏天》《逆行的伞》）；真实语料作品、测试套组与 `resources/studio-corpus` 已从代码和工作区移除。
- 交付：**5 个分发文件 / 388,564,723 B / 370.56 MiB**；源码包与用户数据 `Morrow Data` 不计入。

## 2. 版本与规模

统计口径：`wc -l`；代码含 `src/`、`tests/`、`scripts/`、`build/`；文档为根目录 + `docs/` Markdown；不含 `node_modules`、构建产物、JSON 清单与图片。

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 341 | 160,045 |
| 测试 `tests/`（含 E2E） | 64 | 46,239 |
| 构建脚本 `scripts/` + `build/`（代码） | 13 | 3,900 |
| **代码合计** | **418** | **210,184** |
| Markdown 文档 | 13 | 695 |
| 指南截图 | 26 | 1600px 最长边 · PNG-8 |
| 演示素材 | 16.4 MiB | 图片已转 JPEG，音频/视频保留原格式 |

## 3. 本轮能力状态

### 3.1 文件管理器与启动器

- 根因：交付目录继承宿主工作区的 Low 完整性标签，从中启动的便携版、解压出的应用与代理全部是 Low；此时 `explorer.exe` 以 `0xC0000142` 退出，`SHOpenFolderAndSelectItems` 返回 `0x80070005`，Shell COM / ShellExecuteEx 会挂起。
- 修复：交付目录在打包后统一标为 Medium（含 `(OI)(CI)` 继承），解压出的运行时与后续用户作品都保持 Medium；应用不再使用 PowerShell 助手或 Shell COM。
- 启动器通过任务计划程序拉起一个隐藏代理，代理用现有 Explorer 执行 OPEN / REVEAL / SHUTDOWN；任务动作使用 ASCII 的 `powershell.exe` + `Start-Process`，即使交付路径含中文（如 `C:\交付成品\...`）也能启动。普通退出时主线程等待监视线程发送 SHUTDOWN 并删除任务，避免留下隐藏任务与孤儿进程。
- 代理按请求串行返回，`explorer.exe` 的 `0xC0000142` 被识别为失败而不是成功；应用不会再弹出系统错误框。
- 任务代理不可用时退回进程内代理；普通桌面（Medium）仍可打开，管理员/受限会话返回明确错误而不是超时。

### 3.2 作品库与样例

- 内置样例保持三份：中短篇《雨停之前》、长篇《雨伞铺的第七个夏天》、漫剧《逆行的伞》。
- 删除真实语料作品《极速曙光》《再造华夏》等种子、`src/main/studio/corpus*.ts`、`resources/studio-corpus`、`19-studio-corpus` 套组与相关文档/脚本引用；作品库、时间线、分镜、画布、交付与响应式测试改用内置漫剧样例。
- 已删除交付数据目录 `deliver/Morrow Data/studio/trash` 中的测试作品；用户数据目录保留。

### 3.3 创作台与 Agent

- 画布：多选/框选、对齐、编组、镜头内生成、PNG 快照；小屏/中屏/大屏响应式矩阵通过。
- 小说：分卷、世界设定、候选对照、配图导出、人物语气审稿；漫剧：12 镜、配音、五轨时间线、字幕、音轨、四格、草稿合成。
- Agent：多屏适配、终端贯通、助手来源与任务消息流保持通过；文件树「在文件夹中显示」与创作台共用同一 Shell 代理。

## 4. 验证门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 58 CSS + 83 TSX，0 裸排版值 |
| `npm run test:unit` | 29 文件 / 1012 用例；1004 passed + 8 skipped |
| E2E 18 创作台核心 | 2/2（入口/作品库/写作/分镜/时间线/交付；自动推进与草稿合成） |
| E2E 19 UX | 2/2（指引、演示、关于、灵动岛；导出任务进度） |
| E2E 20 画布与检查 | 3/3（画布编组/生成、人物语气、任务消息流、波形、布局与设置） |
| E2E 21 响应式 | 2/2（创作台 1280/1920/3840；Agent 三档） |
| 受影响 E2E 合计 | 18–21 共 9/9 |
| 打包版 E2E | 6/6（27.6s，r043 单文件便携版） |
| 便携版冒烟 | 1/1（3.7s，CDP 2.5s，渲染与预加载 API 正常） |
| 文件管理器实机 | Medium/High 各一次；打开数据目录与定位导出文件均 OK，Explorer 窗口出现 |
| 关闭清理 | 关闭应用后 `MorrowShellBroker-*` 任务与代理进程均消失 |
| 行为矩阵 | `STUDIO-BEHAVIOR-MATRIX.md` 123 项 |
| 指南截图 | 26 张，4.7MB，1600px 最长边 / PNG-8 |
| 全量 E2E | 本轮未重跑；移除语料套组后受影响 18–21 全过 |

## 5. 交付物

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 220,356,096 B / 210.15 MiB | `955153443de07b6f6dcab713d335625c6d8c492126db7366f92c5d1a873e9952` |
| `Morrow-0.2.0-setup.exe` | 168,201,254 B / 160.41 MiB | `efd05b67d2589f10d8546bf77bbcbc0c699d9c2d3821bef67a41049bc3f6fe6f` |
| `使用说明.txt` | 5,965 B | `4e8f7c71dd9396458da0cb4c132d685b1298ac9072cfb8a6add7bcf07e260611` |
| `SHA256SUMS.txt` | 338 B | `e5e3f32d0c9db940877a05f8707e3d79b0bff38bba1d5eb6e657de5a10a5ef55` |
| `LICENSE` | 1,070 B | `5a147a0421a711a0b44a5ecab6f6b0e8f0002dca17a8ecccef1599faaf70aa97` |
| **分发合计** | **388,564,723 B / 370.56 MiB** | 未签名（signed:false） |

源码包 `Morrow-0.2.0-source.zip` 单独附带，大小与 SHA-256 见交付目录的 `Morrow-0.2.0-source.zip.sha256` 侧车；源码包内文档为打包前快照，不计入上表五件分发文件。

便携版运行时为 `.morrow-runtime-0.2.0-r043`；内嵌应用 zip 带 SHA-256 戳记，缓存不匹配时会重新解压。`deliver/` 顶层保留五个分发文件、源码包与侧车、`Morrow Data` 用户数据，以及被宿主进程占用的旧运行时缓存（不计入分发）。`deliver/Morrow Data` 只保留三份内置样例。

## 6. 源码包

`Morrow-0.2.0-source.zip`：由当前工作树的临时 Git index 生成（`git read-tree` + `git add -A` + `git write-tree` + `git archive`），不依赖未提交改动是否已 commit。大小与 SHA-256 见 `Morrow-0.2.0-source.zip.sha256` 侧车。

## 7. 验证边界

- 本轮按「只跑受影响用例」的要求，未重跑全量 E2E；定向 18–21 共 9 项、打包版 6 项、便携版冒烟 1 项、文件管理器实机 2 场景，单元 1012 项。
- 文件管理器代理依赖 Windows 任务计划程序（10/11 默认可用）。任务代理不可用时退回进程内代理：普通 Medium 桌面可打开，High/受限会话返回明确错误，不伪造成功。
- 强制结束 Morrow 进程树可能留下一个隐藏代理进程（任务定义会在下次启动清理）；正常关闭会发送 SHUTDOWN 并删除任务。建议从窗口关闭或托盘退出。
- 安装包本轮重新生成，未执行系统级安装/卸载冒烟；NSIS 配置沿用已验收的 per-machine 流程。
- 外部 ComfyUI、云端 TTS、真实账号额度、FFmpeg 增强包仍受本机环境限制；无引擎时任务进入“需核对”，不伪造结果。
- 便携版/安装包未签名，首次运行可能触发 SmartScreen；请用 `SHA256SUMS.txt` 校验。
- 干净机器字体嵌入与无 FFmpeg 导出矩阵沿用上一轮边界，未在本轮单独重跑。

## 8. 维护

- 新功能合并前更新 `FEATURES.md`、`USER-GUIDE.md`、`STUDIO.md` 与 `STUDIO-SHORTCUTS.md`。
- 模型/协议变化更新 `MODELS.md`、`SUBSCRIPTIONS.md`、`MEDIA-MODELS.md`。
- 视觉变化更新 `DESIGN-SYSTEM.md` 与 `docs/guide/screens/`（重新跑截图用例，运行 `python scripts/optimize-guide-screens.py` 压缩，并更新 manifest）。
- 质量证据更新 `STUDIO-BEHAVIOR-MATRIX.md`、`THIRD-PARTY-LICENSES.md`、`artifacts.json` 与 `packaging.json`。
- 每次发布更新本文件的规模表、门禁结果与交付哈希。
