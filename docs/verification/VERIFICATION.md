# Morrow 0.2.0 验收记录（r040）

> 日期：2026-10-28 · 版本：0.2.0 · 运行时：r040 · 平台：Windows 10/11 x64
>
> 交付形态：单文件便携版 + NSIS 安装包 + 源码包

## 1. 结论

- 类型检查：`npm run typecheck` **0 error**。
- UI 令牌审计：`npm run audit:ui` **通过**，58 个 CSS + 83 个 TSX，0 处裸排版值（文档预览 iframe 白名单除外）。
- 单元测试：**29 个套件 / 1011 个用例**（1003 passed + 8 skipped），Agent 质量评测 `score=100`。
- 全量 E2E：**22 个套件 / 224 个用例**，**213 passed + 11 skipped + 0 failed**，15.2 分钟；跳过项均为真实账号、本机模型或真实短片生成的环境边界。
- 最终代码定向回归：`18–22` 共 **14/14**；打包版 E2E **6/6**；便携版冒烟 **1/1**；文件夹版冒烟 **1/1**。
- 安装包：per-machine 默认路径静默安装 **363 个文件**，安装版可启动并显示主窗口；卸载后快捷方式与注册表项清理，安装目录仅余空目录（测试后已清理），用户数据保留。
- 指南截图：**26 张**，真实 Electron 窗口生成，压缩到 **4.6MB**（1600px、PNG-8 256 色）；另有 8 张 1280/1920/3840 响应式矩阵。
- 助手来源：每条回答记录本轮实际使用的章节、镜头、片段与设定来源，可点击回到原位置；模型上下文与看图/工具能力在协作者头部可见。
- 导出预检：交付页检查中文字体、FFmpeg 与格式状态；PDF 使用 Type3 字形嵌入，DOCX/EPUB 使用字体回退栈。
- 自动推进：一次确认后补齐缺失素材、自动装配时间线并合成草稿；付费步骤仍逐项过预算闸门。
- 交付：**5 个分发文件 / 388,579,387 B / 370.58 MiB**；源码包与用户数据 `Morrow Data` 不计入。

## 2. 质量方法与 Agent 指标

### 2.1 测试分层

| 层 | 技术 | 规模 | 作用 |
|---|---|---:|---|
| 类型/静态 | TypeScript + UI token audit | 全量 | 编译、裸排版值、设计 token |
| 单元 | Vitest | 29 套件 / 1011 用例 | 协议、工具、权限、上下文、持久化、模型映射、创作台 |
| E2E | Playwright `_electron` | 22 套件 / 224 用例 | 真实窗口、IPC、终端、浏览器、画布、设置、旅程、创作台 |
| 打包回归 | Playwright + 最终构建 | 6 用例 | PTY、文档工具、原生浏览器、双数据目录、创作台资产 |
| 真账号/真引擎 | 手动/条件测试 | 按环境 | 登录、Agent 调用、Qoder 模型目录、媒体 |

单测可以 mock Provider/引擎；E2E 必须启动真实 Electron、真实 IPC、真实 PTY/画布。真实账号、真实模型、ComfyUI、ffmpeg 等外部依赖不在默认 CI 中运行，会明确 skip，不伪造通过；所有测试使用临时数据目录。

### 2.2 Agent 质量指标

离线确定性套件（`npm run test:eval`，Mock Provider）评估四项：

- **工具调用首次成功率（TSR@1）**：8 个工具任务，首次成功 8/8；3 个重试任务成功 3/3。
- **长任务上下文漂移率（LDR）**：60 轮、3 次压缩、24 个事实检查，违规 0。
- **压缩后关键决定保留率（CKR）**：2 个场景，预期保留 10 项，实际 10 项。
- **Token 曲线斜率（TSS）**：80 轮，上限 10,000，压缩 12 次；基线斜率 494，管理后 -0.04；管理后峰值 7,994、最终 7,500，基线峰值 39,806。

综合得分 **100/100**，四项门槛全部通过。结果文件：`docs/verification/eval-results.json`。

### 2.3 真实任务与回归

- **Qoder 真账号**：内置浏览器登录 → 账号目录 15 个 chat 模型 / 200K、400K、1M → Agent 调用返回“链路正常” → max 思考 + 400K 真实请求成功。
- **Codex**：本机 `auth.json` 导入 connected + quota；Responses 工具参数与 assistant 历史内容修复。
- **媒体**：ComfyUI mock 真实生成/编辑/预览；本地 Coder390/视觉链路的请求与回退逻辑由单测覆盖。
- **终端/Git**：真实 PTY、默认 Git Bash 选择、空终端隐藏滚动条、80 行输出后显示、Shell 切换、Git 暂存/提交/分支/历史/放弃。
- **创作台**：真实 Electron 走查作品库、12 镜 96 秒时间线、分镜详情、交付视频、长篇写作候选与自动保存、大白话修改计划、版本对话框与双主题。
- **创作台测试夹具**：`19-studio-corpus.spec.ts` 使用 4 份真实语料夹具（不随安装包分发）覆盖章节/设定/配图/候选锁稿/连续写作/真实草稿合成/工程包导入。
- **创作台真实引擎**：本机 ComfyUI Qwen-Image 生成图片、MiniMax H3 图生视频、ffmpeg 草稿 960×540 与成片 1920×1080、TXT/MD/DOCX/EPUB/PDF/封面/工程包/交付文件夹。
- **打包与安装**：r040 便携包实际解压启动；文件夹版原地运行。NSIS 安装/卸载已在 r038 验收，r040 沿用同一 NSIS 配置，本轮未重跑安装流程。

### 2.4 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run test:unit
npm run test:eval
npx playwright test
npx playwright test tests/e2e/18-studio.spec.ts
npm run dist:all
npx playwright test tests/e2e/13-packaged.spec.ts
```

真实账号/引擎测试需要额外环境变量与本机资源；详见 [多媒体与本地模型](../MODELS.md) 与 [订阅与模型](../MODELS.md)。

## 3. v0.2.0 体验完善与质量自查

| 轮次 | 范围 | 结果 |
|---|---|---|
| 1 | 创作台左右栏与聊天框 | 左右栏可拖动（默认 240 / 420，1px 香槟金线，双击复位，按机记忆）；协作栏打开时左栏不再收成图标轨；Agent 主输入 / 侧边聊天 / 协作者统一流金边框；深/浅主题同步 |
| 2 | 交付页 | “用途—画面—字幕—文件—清晰度”按意图排列；推荐设置；格式与音频用途说明；六种带走方式说明可见；导出预检；交付记录去掉裸哈希 |
| 3 | 设置页 | 子页“配音与引擎”；预算“不设上限”与后端 0 值一致；模型策略“先用哪个模型”；路线表“已连接/未连接、会看图、会用工具、参考价”；工具能力保留常用术语 |
| 4 | 时间线 | 保留起点 / 入点 / 转场·淡入淡出 / 分割 / 逐帧 / 变速 / 播放头；底部常驻“拖中间改位置，拖两端改长短” |
| 5 | 质量自查 | 检查页去掉引擎/声线术语；预算 0 在顶栏、协作者、蓝图、检查、设置统一显示“不限”；创作台文件夹打开统一走系统 Shell 助手；源码包改为包含当前工作树 |
| 6 | 术语平衡 | 从过度口语化回退到行业常用说法，保留推荐设置、可见说明、预算不限等真实改进 |
| 7 | 数据目录、双线与字号 | 创作台数据目录可自定义并迁移重启；悬浮/拖动只高亮面板 1px 边框（Studio + Agent）；画布素材/节点、写作目录/人物设定、正文字号上调并统一“协作者” |
| 8 | 终检假实现与半成品 | 蓝图确认前隐藏“用模型重写”；大白话原话与“不改脸/保持雨向”写入画面/视频提示词并锁定当前镜头参考；“自动排好”先确认、服务端拒绝静默覆盖；字幕字号/颜色/底板写入 ASS 并补上界面控件；外部章节配图按 chapterId 回到本章草稿 |

- **假实现检查**：`src/main/studio` 与 `src/renderer/src/features/studio` 没有 TODO/FIXME/占位实现或空 `onClick`；11 个 `studio_*` 助手动作都落到真实服务；ComfyUI 外部任务取回走 `resumePrompt`；未发现只改文案不接真实服务的半成品。
- **真实缺陷修复**：预算 0 的多处“¥0”误导显示；`pack-source.mjs` 原先只打包 `HEAD`，会漏掉未跟踪的创作台目录，现已改为临时 Git index 打包当前工作树；创作台文件夹打开统一走系统 Shell 助手。
- **文档整合**：FEATURES / STUDIO-SHORTCUTS / SUBSCRIPTIONS / MEDIA-MODELS / COMMENT-AUDIT / EVALUATION / TROUBLESHOOTING 并入 USER-GUIDE、STUDIO、MODELS、CONTRIBUTING、VERIFICATION；删除重复的 docs/README 与旧审计日志。Markdown 文档收敛为 **13 个**。

## 4. 版本与规模

统计口径：`wc -l`；代码含 `src/`、`tests/`、`scripts/`、`build/`；文档为根目录 + `docs/` + `docs/verification/` 的 Markdown；不含 `node_modules`、构建产物、JSON 清单、应用内置技能说明与图片。

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 343 | 160,704 |
| 测试 `tests/`（含 E2E） | 65 | 46,711 |
| 构建脚本 `scripts/` + `build/` | 17 | 4,141 |
| **代码合计** | **425** | **211,556** |
| Markdown 文档 | 13 | 2,781 |
| 指南截图 | 26 | 1600px 最长边 · PNG-8 |
| 语料素材 | 17.7 MiB | 图片已转 JPEG，音频/视频保留原格式 |

## 5. 能力状态

- **Agent 响应式与终端**：对话列 / 输入区 / 欢迎页按视口放大；画布拖宽时为对话列保留 560px；终端从侧栏右缘铺满主区，画布或侧边聊天打开时从其下方贯通。
- **助手能力与来源**：协作者头部展示模型、上下文与看图/工具/本机或云端；来源可点击跳转，来源失效写入检查项；计划预览/应用/整体撤销与预算闸门保持。
- **交付与自动推进**：导出预检、真实 EPUB/DOCX/PDF/工程包/音轨/四格漫画；PDF Type3、DOCX eastAsia、EPUB 回退栈均有真实导出断言；自动补齐 + 时间线装配 + 草稿合成。
- **画布、任务、长篇与媒体**：多选/对齐/编组/快照 PNG；任务消息流与 ComfyUI 外部任务号取回；超长章节分片、候选段落级对照、人物语气审稿；真实波形、540p 代理、云端 TTS、内置音频素材。
- **创作台体验**：左右栏 240/420 可拖动；三种聊天框统一流金边框；交付、设置、时间线文案已小白化；深/浅主题截图与 1280/1920/3840 矩阵覆盖。
- **模型目录**：Meta 新增 Muse Wonder 1.0（1,048,576 上下文、视觉/工具、五档思考、$4/$20 参考价）；Muse Spark 1.3 保留。
- **文件夹打开**：创作台作品文件夹、创作台数据目录与媒体模型目录优先走 PowerShell Shell 助手，启动器命名管道代理只作兜底，避免“启动器代理响应超时”。

## 6. 验证门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 58 CSS + 83 TSX，0 裸排版值 |
| `npm run test:unit` | 29 套件 / 1011 用例；1003 passed + 8 skipped |
| `npm run test:eval` | Agent 质量 score=100，pass=true |
| 全量 E2E | 22 套件 / 224 用例；213 passed + 11 skipped + 0 failed（15.2m） |
| 最终代码定向 E2E | 18–22 共 14/14 |
| 打包版 E2E | 6/6（19.3s，r040 文件夹版） |
| 便携版冒烟 | 1/1（5.4s，r040，首屏与预加载 API 正常） |
| 文件夹版冒烟 | 1/1（1.6s，r040，原地运行、portable.marker 数据目录正确） |
| NSIS 安装/卸载 | r038 通过（363 个文件，per-machine）；r040 未重跑，配置未变 |
| EPUB 配图/字体 | JSZip 读取 `OEBPS/images/`、`<figure>` 与字体回退栈通过 |
| DOCX 配图/目录/字体 | `word/media/`、`<w:drawing>`、目录文本、`w:eastAsia="宋体"` 通过 |
| PDF 配图/字体 | `/Subtype /Image`、`/Subtype /Type3` 通过 |
| 行为矩阵 | `STUDIO-BEHAVIOR-MATRIX.md` 123 项 |
| 容量基准 | 100 章/300 素材保存读取、100 镜装配 119 片段 |
| 恢复演练 | 损坏作品恢复超长章节与外部任务号 |
| 指南截图压缩 | 26 张，压缩到约 4.6MB，文字清晰度人工复核 |

全量 E2E 在最后一轮文案/错误提示修复后的构建上完成；11 个跳过项为：真实 Codex 登录 1 项、本机模型 9 项、真实短片生成 1 项。

## 7. 交付物

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 220,361,728 B / 210.15 MiB | `3c3cb55f41c8cb2eff614519d2a8324781200acaad46658dabc349cd856fb96e` |
| `Morrow-0.2.0-setup.exe` | 168,210,410 B / 160.42 MiB | `1c07214c0c4cf3a0579cf75e553e4ed551e6d6a361ee42891a38cffe1b26975d` |
| `使用说明.txt` | 5,841 B | `f02df9f8881314a7a0139610e46bab3cdc3397e794a45cf997ab0b04e7fdc0a8` |
| `SHA256SUMS.txt` | 338 B | `f5ad7e1c4a9ddc62873a6652d3e451f3d04aaeddf7b385e71aa7435af244ce75` |
| `LICENSE` | 1,070 B | `5a147a0421a711a0b44a5ecab6f6b0e8f0002dca17a8ecccef1599faaf70aa97` |
| **分发合计** | **388,579,387 B / 370.58 MiB** | 未签名（signed:false） |

便携版运行时为 `.morrow-runtime-0.2.0-r040`；安装包为 per-machine（Program Files，需要管理员权限）；内嵌应用 zip 带 SHA-256 戳记，缓存不匹配时会重新解压。`deliver/` 顶层保留五个分发文件、源码包与侧车，以及原样保留的 `Morrow Data` 用户数据（不计入分发）。

## 8. 源码包

`Morrow-0.2.0-source.zip`：**41,453,690 B / 39.53 MiB**，SHA-256 `7579e7ea7d62b8d5dbe5766bcd7036c3161f32f11b6b6c8bec0278d91085774f`；侧车为 `Morrow-0.2.0-source.zip.sha256`。源码包由当前工作树的临时 Git index 生成（遵守 `.gitignore`），包含全部源码、测试、构建脚本、文档与素材；包内不含源码包自身哈希，以侧车为准。

## 9. 验证边界

- 11 个 E2E 跳过项需要真实 Codex 账号、本机模型或 GPU/ComfyUI；跳过不是通过，也不以 mock 冒充。
- 创作台 E2E 已从 9 个碎套组合并为 5 个领域套组（18–22），合并后定向 18–22 重跑 14/14；全量 224 个用例内容未变，最近一次全量通过数沿用 r038 全量结果。
- 外部 ComfyUI 自动对账需要本机引擎在线；无引擎时任务进入“需核对”，不会伪造成功。
- 本机只有 Qoder/Codex 有可用真实账号；其他订阅只验证登录页/协议/端点，没有编造额度。
- 云端 TTS 仅验证兼容 OpenAI `/audio/speech` 的真实请求与错误路径；具体服务商兼容性由用户账号决定。
- Windows 语音在受限令牌/远程会话中可能失败，产品提供“导入配音”兜底。
- FFmpeg 未内置，增强包能力取决于本机安装；分发许可见 `../THIRD-PARTY-LICENSES.md`。
- K07/K08 已增加导出预检、PDF Type3/DOCX/EPUB 字体断言；DOCX/EPUB 在目标机器上仍依赖 Office/阅读器字体，干净机器与无 FFmpeg 导出矩阵仍需多机验收。
- 安装包为 per-machine：安装到 Program Files，需要管理员权限；卸载后快捷方式与注册表清理，安装目录可能保留空目录，用户数据默认保留。
- 便携版/安装包未签名，首次运行可能触发 SmartScreen；请用 `SHA256SUMS.txt` 校验。

## 10. 维护

- 新功能合并前更新 `USER-GUIDE.md`、`STUDIO.md`（含快捷键表）。
- 模型/协议变化更新 `MODELS.md`（含订阅与多媒体）。
- 视觉变化更新 `DESIGN-SYSTEM.md` 与 `docs/guide/screens/`（重新跑截图用例，运行 `python scripts/optimize-guide-screens.py` 压缩，并更新 manifest）。
- 质量证据更新 `STUDIO-BEHAVIOR-MATRIX.md`、`THIRD-PARTY-LICENSES.md`、`artifacts.json` 与 `packaging.json`。
- 每次发布更新本文件的规模表、门禁结果与交付哈希。
