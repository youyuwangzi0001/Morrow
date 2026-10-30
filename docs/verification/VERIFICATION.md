# 验收记录

- 产品：Morrow
- 版本：0.2.0
- 构建修订：r059
- 平台：Windows 10.0.26300 x64
- Electron：44.9.0
- electron-builder：26.0.12

> 本页顶部交付物与第 10 节为 r057 内置漫剧升级后的最新记录；第 1–3 节保留 r054 的终端与改编修复背景，第 8–9 节保留 r055/r056 审计修复记录。当前测试入口、数量与执行命令见 [测试说明](../TESTING.md)。测试目录现仅保留核心套组，统一使用 `npm run verify`。

> **r059（2026-10-30）：时间线定位、设置清理、空作品库与全新包体。**时间线预览新增可点击/拖动的整片进度条；移除 Coder390 及 llama.cpp 默认模型预设，修正引擎/模型主页；画布去掉重复的“画布/素材/节点”说明；创作台默认不再写入三份样例项目，包体只保留 Agent 演示与创作台独立演示；修正“补充要求”等挤压换行。

> **r058（2026-10-30）：漫剧成片规则与交付清理。**视频模型只生成画面与纯器乐配乐，人物配音改由真实剧本台词驱动音频模型，字幕只做外挂；内置《逆行的伞》已删除旧素材并从零重制 12 镜、7 段 Qwen3-TTS 配音、96 秒 1080p 成片与外挂 SRT；两项顶栏品牌字统一 18px + 流光；移除超频/全局无限 token 提示；核心单元 365/365、Electron 46/46、打包版冒烟通过。

## 0.1 r058 漫剧成片重制与体验收口（2026-10-30）

| 范围 | 实现 | 结果 |
|---|---|---|
| 视频声音规则 | 在媒体服务层统一追加规则：H3 只生成画面与纯器乐配乐，不生成人物配音、旁白或字幕；Studio 与 Agent 的 generate_video / generate_film 均生效 | `main-media` 规则单测；demo-final.mp4 仅含 H.264 画面 + AAC 配乐，无字幕流 |
| 配音来源 | 配音只使用真实剧本 `shot.dialogue`；本机 Qwen3-TTS 默认，云端 TTS 可接收 `instructions`（角色、情境、停顿、情绪） | 7/7 段 Qwen3-TTS 真实合成；配音文件 `voice-03…11.wav` |
| 字幕 | 合成不再烧录字幕；字幕只生成同名外挂 SRT/ASS | `demo-final.srt` 7 条；ffprobe 无 subtitle 流 |
| 内置漫剧从零重做 | 删除旧 demo-draft / 旧视频/旧配音/旧音乐，重新生成 12 镜 MiniMax-H3 真实视频（960×544 源片，含纯器乐音轨）、7 段配音、96 秒 1920×1080 成片与 SRT；`resources/studio-demo` 更新 | 12 个 video-*.mp4 + 7 个 voice-*.wav + demo-final.mp4/srt + manifest |
| 配乐判定 | H3 视频自带无人声配乐视为已就绪；同时仍可单独生成 ACE-Step 配乐 | `hasEmbeddedVideoScore` 单元/界面判定 |
| 顶栏品牌字 | Agent 与创作台统一 18px、常规字重、水平/垂直居中、流光动画 | 实测两种模式 fontSize=18px、animation=brand-sheen、背景位置随时间变化 |
| 超频/额外提示 | 删除全局无限 token 提示定义与注入；源码无“超频”残留 | `@core:interface` 断言系统提示不含无限 token 声明 |
| 测试合并 | 7 个 Studio E2E 与 terminal 合并进 5 个领域 spec；单元保持按功能域 16 个套组 | 核心套组 365 单元 + 46 Electron，`test:suite` 通过 |
| 本地清理 | 删除停用的 Qwen3.8-27B 本地文本模型（13GB）、llama.cpp 运行时（0.58GB）、runtime-0.1.0（0.5GB）、未使用的 ACE-Step turbo（4.5GB）及旧 tmp/release 构建缓存 | 释放约 37GB；保留 TTS、H3、Qwen-Image、ACE-Step base、FFmpeg |

## 0.0 r059 使用体验与空包体（2026-10-30）

| 范围 | 实现 | 结果 |
|---|---|---|
| 时间线定位 | 预览播放器新增整片进度条：点击或拖动任意位置立即定位，支持方向键/Home/End；原 ±1 秒按钮保留 | `studio.spec` 点击 50% 后播放头时间 >30s |
| 画布默认宽度 | 移除宽屏自动放大；画布统一按用户保存宽度显示，默认 420px | 2100 宽度实测 420px，对话区正常保留 |
| 模型预设 | 移除 Coder390 媒体清单与 llama.cpp 默认模型；旧设置通过 RETIRED_MODEL_IDS 清理，本地模型改由用户添加 | `main-settings` 新增“本地模型无预置”单元用例 |
| 主页链接 | 修正 Ollama/LM Studio/ComfyUI/llama.cpp 引擎主页与 Qwen-Image/MiniMax/ACE-Step 模型主页；模型主页指向真实仓库 | 链接可打开；失败时仍复制到剪贴板 |
| UI 挤压 | “补充要求”不再换行；协作者建议改成两行可读；画布标题去掉重复“画布”，左右栏只保留“素材与镜头”“镜头节点”；设置 → 数据与安全删除“密钥只保存在本机”说明块 | 1280/2100 实图核对；`audit:ui` 通过 |
| 空作品库 | 默认不再复制三份样例项目；`MORROW_TEST=1` 才为测试注入样例；包体移除 `resources/studio-demo` 82MB 与样例素材 | 新包作品库为空；独立“看演示”仍可用；`_empty-audit` 通过 |
| 全新交付 | 两文件：便携 exe + 安装包；不含项目数据、样例素材、源码包或使用说明 | 便携版 196.95 MiB / 安装包 149.82 MiB；冒烟通过 |

## 1. 交付物

本轮 r059 只交付两个单文件（`deliver/`）：

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 206,520,320 B / 196.95 MiB | `543a95ccc7eacfbb03083aed4f0c50482050e60367accf94ce4e76e2751a486f` |
| `Morrow-0.2.0-setup.exe` | 157,101,479 B / 149.82 MiB | `bf2286b46888cee884e451a3c4701458d50a000a7e573e1bc55c5aad9c5a5317` |
| **分发合计** | **363,621,799 B / 346.77 MiB** | 未签名（signed:false） |

- 两个产物均未配置代码签名（signed:false）。
- 交付目录不包含文件夹版、zip、源码包、使用说明或 SHA256SUMS；这些只作中间产物/文档。
- 两个分发文件为 `deliver/` 下的便携 exe 与安装包；冒烟解压目录 `.morrow-runtime-0.2.0-r056` 可能被宿主短暂占用，稍后可删除，不计入分发。旧版用户数据与 r053/r054 冒烟缓存已移到 `tmp/deliver-backup-r054/`，未删除。
- 便携版首次运行会在 exe 同级解压 `.morrow-runtime-0.2.0`；安装版数据默认在 `%APPDATA%\Morrow`。

![终端恢复为 Git Bash](screens/matrix/terminal-gitbash.png)

## 2. 质量门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run audit:ui` | 27 CSS + 29 TSX，0 裸排版值 |
| `npm run test:unit` | 15 套件 / 1049 用例（1040 passed + 9 skipped） |
| E2E 新增终端回归 | `terminal-gitbash.spec.ts` 1/1：默认 Shell 为 Git Bash，PTY 内可执行 `git --version`，Agent 一次性命令同样走 Git Bash |
| E2E 既有终端套件 | `terminal-panel.spec.ts` 真实终端、默认终端切换与后台任务 1/1 |
| 打包版真实 UI | `packaged-terminal-gitbash.spec.ts` 1/1：真实 r053 便携运行时，强制复制分支下终端可执行 `git --version`，Agent `run_command` 返回 `shellId=gitbash` |
| E2E 全部章节改编 | `adaptation-all-chapters.spec.ts` 1/1：15 章全部进入目标工程，分 2 批生成 12 镜，`adaptedFrom.chapters=15` |
| E2E 写作台替换 | `studio.spec.ts` 29-writing-desk 1/1：独立替换按钮、Ctrl+H 聚焦、全部替换、撤销 |
| E2E 写作台窄窗 | `studio.spec.ts` 29-writing-desk 1/1：1280 展开协作者时工具条与替换栏 0 溢出，标签折叠为图标 |
| r054 受影响 E2E 合计 | **3/3 passed，0 failed** |
| r053 终端回归（保留） | 终端新增/既有/打包真实 UI **3/3** |
| r055 单元核心套组 | 16 套件 / 355 passed + 705 skipped；新增写作安全、预算、中断恢复、交付版本测试 |
| r055 审计修复 E2E | 改编全章、分镜续作、长篇蓝图续作、审稿覆盖、小说核心 **5/5 passed** |
| r055 创作台 UI E2E | 真实走查（含分镜范围弹窗）、画布离开补存、音效计划撤销 **3/3 passed** |
| r055 门禁 | `typecheck` 0 错误；`audit:ui` 27 CSS + 29 TSX 0 裸排版值；`test:suite` 355 单元 / 41 Electron / 38 域 |
| r055 便携 exe 冒烟 | 最终包通过：启动、渲染、截图 6.3s（`tempMode=workspace-redirect`） |
| r056 完整单元 | 1,069 项：1,060 passed + 9 skipped；核心 363/363 |
| r056 核心 Electron | **45/45 passed**（4.7 分钟，完整核心套组） |
| r056 复审专项 | 分片写入失败/只恢复损坏章节/人物检查点/长章分段/覆盖合并/跨作品画布/成片版本均有单元或 E2E |
| r056 便携 exe 冒烟 | 最终包通过：启动、渲染、截图 6.4s（`tempMode=workspace-redirect`） |
| r057 内置漫剧 E2E | `demo-film.spec.ts` 1/1：12 镜视频资产、12 段视频时间线、96 秒、1080p 成片实际播放；改动时间线后旧成片立即过期 |
| r057 打包版内置漫剧 | 便携包内 `12 镜视频资产 / 12 视频片段 / 7 对白 / 7 字幕 / 1080p 成片 HTTP 200` |
| r057 完整单元 | 364 passed；核心 364/364 |
| r057 核心 Electron | **46/46 passed**（5.1 分钟） |
| r057 便携 exe 冒烟 | 最终包通过：启动、渲染、截图 6.6s（`tempMode=workspace-redirect`） |
| 安装包 | r055 electron-builder NSIS 构建成功，完整性标签 Medium；未做无人值守静默安装测试 |

## 3. 本轮修复

### 3.1 小说改编漫剧覆盖全部章节

- `adaptToDrama` 去掉了 `slice(0, 12)`，目标漫剧复制全部非空章节；`storyboardPrompt` 与场景归一化中剩余的 12 章/12 场截断也全部移除。
- 新增 `storyboardChapterBatches`：超过 12 章时按 8 章一批调用模型，保留前批结尾摘要维持连续性，合并场景/镜头后再一次性应用；不再用单次 40 镜上限截断长篇。
- 单元测试覆盖 15/36 章批次数与空章过滤；E2E 用 15 章工程 + mock 模型验证 2 批请求、目标 15 章、12 镜、`adaptedFrom.chapters=15`。

### 3.2 写作台查找/替换 UI

- 工具栏新增独立的「查找」与「替换」按钮；替换按钮打开同一查找栏并聚焦“替换为”，不再让用户从“查找”里猜。
- `Ctrl+F` 打开查找、`Ctrl+H` 直接聚焦替换；有选区时自动带入查找词。
- 保留单条替换与全部替换；替换当前条后定位下一条，全部替换后可撤销。1280 展开协作者时按容器宽度折叠按钮文字，查找栏 0 溢出。

### 3.3 Git Bash 被 MSYS 共享内存冲突挡住


- 根因：系统 Git Bash 与其他权限级别（如管理员/Qoder 终端）的 Git Bash 共用 `\BaseNamedObjects\msys-2.0S5-…`；后启动的一方在 `NtCreateDirectoryObject` 被拒绝（`0xC0000022`），于是旧逻辑把终端换成了 PowerShell 7。
- 修复：`terminal-manager` 在第一次使用 Git Bash 时做一次无输出的启动探测；如果命中该错误，就生成一个**独立 Git Bash 前缀**：优先递归硬链接同一份系统 Git；普通权限无法给 Program Files 文件建链接（`EPERM`）时自动切换为逐文件复制。终端仍运行同一份系统 Git，HOME、配置和仓库不变；MSYS 按新前缀生成自己的共享内存名，不再冲突。
  - `usr/bin` 已包含 `bash.exe` 与 `msys-2.0.dll`，子进程会加载独立前缀里的 DLL。
  - HOME、Git 配置、仓库路径不变；`git --version` 与实际命令在真实 PTY 中验证。
  - 前缀优先放在 `%LOCALAPPDATA%\Morrow\terminal-runtime`（持久、同卷）；数据目录或临时目录作为同卷回退。硬链接失败时复制约 400MB；只有复制/启动都失败时才回退 PowerShell 7。
  - 标记文件记录 Git 的 bash/git 时间戳，Git 更新后自动重建；终端与 Agent `run_command` 共用同一个前缀。
- 新增 E2E：`tests/e2e/terminal-gitbash.spec.ts`，在受限 Electron 中打开真实终端，断言 `shellId=gitbash`、输入命令并执行 `git --version`；打包版测试同时验证 Agent `run_command`。
- 打包版验证：`packaged-terminal-gitbash.spec.ts` 用真实 r053 便携运行时，设置 `MORROW_TERMINAL_SHADOW_COPY=1` 强制复制分支（模拟普通权限无法建硬链接），断言复制出的 `bash.exe` 是独立副本（`nlink=1`），终端执行 `git --version`，Agent `run_command` 成功且 `shellId=gitbash`。

![打包版终端与工具](screens/matrix/packaged-terminal-tool.png)

### 3.4 终端左上角的方框与 `$` 行

- 根因：终端没有引入 `@xterm/xterm/css/xterm.css`。xterm 的**字符宽度测量节点**（`.xterm-char-measure-element`）本应 `visibility:hidden` 并移出屏幕；缺少基础样式后它被渲染在终端左上角，形成方框字形和一整行重复测量字符（`$`/`5`/`>`）。
- 修复：`terminal.tsx` 在自定义终端样式前引入 xterm 基础样式；回归测试断言测量节点 `visibility=hidden` 且 `left<0`。
- 该问题与 Git Bash 无关；PowerShell 回退和正常 Git Bash 都会出现，只是之前终端未真正启动时不易看到。

## 4. 终端行为

- 真实 PTY（ConPTY），不是管道；默认 Git Bash，也可选择 PowerShell 7 / WSL。
- 多标签、后台任务、复制粘贴、拖动调高；隐藏不结束进程，关闭标签才结束。
- 终端类型只在「设置 → 终端」选择；默认 Shell 不因回退被改写。
- 独立前缀只用于终端/命令 Shell，不修改系统 Git 安装，也不修改安全策略；如复制或前缀仍无法启动，界面会明确显示切换到 PowerShell 7 的原因。

## 5. 打包冒烟

- 便携 exe：通过。r055 最终包启动、渲染、截图完成（6.4s）；首屏正常，预加载 API 正常，数据目录按预期创建。
- 安装包：构建成功并做完整性标签 Medium；未做无人值守静默安装测试。
- 交付分发为两个 exe；用户数据与旧版运行时缓存已移到 `tmp/deliver-backup-r054/`，冒烟解压缓存不计入分发。

## 6. 已知边界

- 独立 Git Bash 前缀需要与系统 Git 同卷；不同卷时回退 PowerShell 7，并在终端显示提示。普通权限环境会复制约 400MB 兼容运行时到本机应用缓存（一次生成，Git 更新后重建）。
- 未配置代码签名，SmartScreen 可能提示。
- FFmpeg 不随包内置；配音/配乐/视频依赖本机 TTS/ComfyUI/ACE-Step。
- 订阅渠道未验证的连通状态不显示“已连接”，不伪造额度。
- 本轮已重跑完整核心 Electron 套组（45/45）；仍不属于全部 245 条 Electron 用例的发布级回归。

## 7. 复现

```powershell
npm run typecheck
npm run audit:ui
npm run test:unit
npx playwright test --grep @core: --workers=1
node scripts/build-demo-film.mjs
MORROW_BUILDER_OUTPUT=tmp/electron-builder-output-r057 MORROW_RELEASE_DIR=tmp/rel-r057 MORROW_RUNTIME_REVISION=r057 npm run dist:final
node scripts/smoke-packaged.mjs --exe=deliver/Morrow-0.2.0-portable.exe
```

## 8. r055 审计修复记录（2026-10-30）

本轮按 [MORROW-AUDIT-2026-10-30.md](../MORROW-AUDIT-2026-10-30.md) 逐条修复功能断点与设计偏差；版本号保持 0.2.0，构建修订 r055。

### 8.1 内容与保存完整性

- **F01 分片校验**：读取长章节时核对分片数量、连续编号与 SHA-256；缺失时隔离 `corrupt-*` 并从最近历史版本恢复，不再把残稿当完整正文显示。
- **F03 重写冲突**：`polish-chapter` 记录开始时的章节修订与正文；生成期间用户手改时，新稿保存为候选，不覆盖手稿，候选摘要不写入正式摘要（F11）。
- **F04 时间线保存**：保存只确认提交时的那一版；保存期间的新修改保留并继续保存。
- **F05 草稿归属**：写作台草稿绑定章节；首次保存失败时阻止危险切章，后续保存始终使用草稿所属章节。
- **F06 画布离开**：离开画布/切换作品前补存 700ms 防抖内的修改，返回后节点不丢。
- **F07 取消**：任务收尾再次核对取消状态，迟到结果保留文件但不应用到作品。
- **F21 容量**：工程保存与打开统一容量保护；超过上限时在覆盖原稿前报错并保留原文件。

### 8.2 操作对象、权限与预算

- **F02 目标作品**：刷新、保存、任务、应用计划等操作始终绑定发起时的作品；后台结果不把用户从作品 B 拉回作品 A。
- **F08 只读审稿**：`studio_review` 只读取已有检查，不重跑、不写入、不启动视觉模型。
- **F09 路径越界**：统一解析 `/c/...`、MSYS、Cygwin、WSL 路径后再判断是否越界。
- **F10 排队预算**：预算检查计入 queued/running 任务已承诺金额，执行前排除自己重新核算。
- **F12 作品队列**：任务按作品拆分队列；暂停一本作品不阻塞其他作品。

### 8.3 分镜、审稿与交付版本

- **D02 已有镜头重做**：重新生成分镜先选当前镜头、指定章节或全书分批；已有素材按镜头编号稳定对应更新，默认禁止模型增删镜头；分批失败保存已完成批次，下一批继续。
- **D10 审稿范围**：小说与漫剧都支持自动抽样、当前对象、全书/全片分批；每批保存覆盖对象与原文版本，检查页列出已审范围、版本变化和未审部分，不再把抽样当全书完成。
- **D11 分批续作**：分镜、长篇蓝图、模型审稿都写入 `derived/*-partial.json`；失败后重试跳过已完成批次。
- **F13 计划撤销**：计划自身排队的任务完成后仍可整体撤销；用户后续编辑会阻止整体撤销，避免覆盖新修改。
- **F14/F15 交付版本**：音频导出、预检与交付只选当前时间线版本的成片；时间线改动会让旧视频/旧审核明确过期。
- **F16/F17 启动恢复**：中断的任务与阶段一起改为待核对；异常退出后活跃目标恢复为可继续状态。
- **F18/F19 打包与媒体**：导入/导出包统一 300 MiB 限制；波形、视频代理、音轨与四格漫画改用可超时、可取消的异步进程。
- **F20 评估入口**：`npm run test:eval` 指回现存评估套件。

### 8.4 长篇设计偏差

- 改编按全部非空章节分批；每批提示包含本批章号范围、前批结尾，并同时提供章节梗概与原文（长章取头尾 3000 字）。
- 协作者快照优先放用户选中的章/镜及邻近内容；章节生成按当前人物、地点、伏笔挑选事实，并带入世界规则、势力与道具。
- 自动规划保留用户给定的卷数、章数与单章字数目标；人物/地点名单上限放宽到 60。
- 修改计划不再静默截断到 12 个动作；超出时提出分批方案。
- 改编前确认改编范围与单集时长；制作精细度标明是创作取向，不等于分辨率或成片质量保证。

### 8.5 证据

- 单元：`tests/unit/studio-writing-safety.test.ts`（重写冲突/候选摘要、排队预算、中断恢复、交付版本）、`studio-runtime.test.ts`（分镜分批、范围更新、覆盖合并）。
- E2E：`adaptation-all-chapters.spec.ts`（全章改编 + 已有镜头按章节重做并保留素材）、`storyboard-resume.spec.ts`、`blueprint-resume.spec.ts`、`review-coverage.spec.ts`、`studio-novel-core.spec.ts`；`studio.spec.ts` 的真实走查、画布离开补存、音效计划撤销。
- 截图：`screens/matrix/studio-review-coverage.png`、`screens/studio-storyboard-scope-dark.png`、`screens/packaged-smoke.png`。
- 未覆盖：真实付费账号连通、云端费用、长媒体压力、安装/升级/卸载、真人对文学质量与改编忠实度的评价。

## 9. r056 复审修复记录（2026-10-30）

本轮依据 [MORROW-REPAIR-REAUDIT-2026-10-30.md](../MORROW-REPAIR-REAUDIT-2026-10-30.md) 修复 N01–N10；版本号保持 0.2.0，构建修订 r056。

### 9.1 存储与恢复

- **N01**：长章节分片改为按内容哈希写入独立目录，`project.json` 成功落盘后才清理旧分片；JSON 写入失败时旧 JSON 与旧分片一起保持有效。`save` 与 `savePassive` 共用该顺序。
- **N02**：读取时逐章校验并收集损坏章节，只从最近历史版本恢复这些章节；其他章节、画布、时间线、任务与最近修改保持当前工程。原数据隔离失败时停止自动恢复并明确报错，不再声称已留备份。

### 9.2 长篇蓝图与审稿

- **N03**：长篇蓝图检查点分别记录骨架、人物/地点与各卷批次；人物阶段失败后重试先补人物，不再带着 0 人物去写章节。
- **N04**：小说审稿按 8,000 字一段拆分长章，提示中标注实际字符区间；覆盖记录保存每段区间，长章尾部未读时不会把整章/全书算完成。全书、当前章与自动抽样共用分段规则。
- **N05**：覆盖合并不再按 60 条截断；500 章、125 批的记录完整保留，界面可滚动查看。
- **N06**：覆盖按批次部分去重，不再要求同类型旧记录 source 完全相同；逐章审稿时其他章节的有效记录保留。

### 9.3 分镜、重试与跨作品保存

- **N07**：分镜任务记录开始时的逐镜版本；写回时冲突镜头不覆盖人工修改，AI 新稿进入镜头详情的待比较候选，可「采用 AI 新稿」或「丢弃」。
- **N08**：模型审稿重试保留 `scope`、`chapterId`/`shotId`；当前章/当前镜找不到时直接报错，不再悄悄改成自动抽样或第一个对象。
- **N09**：画布与时间线补存固定草稿所属作品 ID；切换 A→B 时只写 A，B 的画布不会被 A 的内容污染。
- **N10**：`currentTimelineVideo` 同时检查 visuals/voice/timeline/delivery 失效状态与渲染依据 `renderKey`；更换配音或素材后旧视频只能作为历史版本，不能冒充当前成片。

### 9.4 证据

- 单元：`studio-store.test.ts`（写入失败一致性、只恢复损坏章节）、`studio-runtime.test.ts`（人物检查点不在单元层；分段/覆盖/500 章/逐章合并/分镜冲突）、`studio-writing-safety.test.ts`（冲突镜头采用/丢弃、成片 stale 与 renderKey）。
- E2E：`storyboard-conflict.spec.ts`（真实界面手改 + AI 候选）、`review-coverage.spec.ts`（9000 字长章尾部、当前章重试范围、覆盖 UI）、`blueprint-resume.spec.ts`（人物失败续作）、`studio.spec.ts`（A→B 画布隔离、画布离开补存、计划撤销）。
- 截图：`screens/matrix/studio-review-coverage.png`、`screens/studio-storyboard-scope-dark.png`、`screens/packaged-smoke.png`；冲突候选界面由 `storyboard-conflict.spec.ts` 实际点击验证。
- 边界：没有实际构造 512 MiB 工程或填满磁盘；N05 的 125 批为生产合并函数验证而非 125 次付费模型调用；未做真实重新编码音频、安装/升级/卸载与长媒体压力测试。

## 10. r056 最终独立验收与内测放行（2026-10-30）

**结论：批准开启内测。**逐项核对 N01–N10 的生产路径，重跑实际回归，检查关键页面及窄窗口截图；本轮未发现阻塞内测的新断点或 UI 遗漏。

- 核心单元 363/363；核心 Electron 45/45（297.95 秒）；窄窗口布局 3/3；分镜冲突候选明暗主题专项 1/1。Electron 均为 0 失败、0 跳过、0 不稳定用例。
- 构建、类型检查、UI 样式规则、38 域核心覆盖登记均通过。此次未重跑全部 1,069 项单元或 245 条 Electron。
- 从隔离副本重新启动最终 r056 便携单文件，5.62 秒完成启动、渲染与截图；新解压 ASAR 中 467 个编译文件与本轮构建逐字节相同。
- 两个分发 exe 的 SHA-256 均与本页交付表一致；安装包未执行安装、升级或卸载。
- 验收期间记录的关键生产源码未变化。本轮未修改生产代码，也未增删永久测试套组。

逐项关闭记录及 UI 截图见 [最终验收文档](../MORROW-BETA-ACCEPTANCE-2026-10-30.md)，统计与哈希见 [最终证据](beta-final-2026-10-30.json)，便携启动结果见 [冒烟记录](beta-final-smoke-2026-10-30.json)。

## 11. 核心套组实际删除与复核（2026-10-30）

按内测放行后的项目决定，删除 706 项非核心单元、200 条非核心 Electron 流程和 13 项 Mock 夹具自测，共 919 项。原有 408 项核心全保留；同期漫剧更新新增 1 项单元、1 条 Electron 核心回归也保留，当前为 **364＋46**。

独立验证目录重建后：单元 **364/364**（9.36 秒）。Electron 整轮 **45/46**（375.15 秒），剩余终端项固定 MSYSTEM 测试环境后单独 **1/1** 通过，最终 46 项均通过、0 跳过、0 未解决失败。类型、UI 样式、38 域登记和核心清单防护检查通过。

日常和发布前统一使用 `npm run verify`，打包后继续执行 `npm run smoke:packaged`。本节只记录测试精简，不变更前述历史版本的功能验收与交付哈希。详情见 [当前测试说明](../TESTING.md) 和 [精简证据](core-only-2026-10-30.json)。

## 10. r057 内置漫剧升级（2026-10-30）

本轮把内置《逆行的伞》从“12 张分镜图 + 样例草稿”升级为可发布、可继续编辑的动态漫项目；版本号保持 0.2.0，构建修订 r057。

### 10.1 镜头与成片

- 12 张分镜逐张生成 1920×1080 / 30fps 动态镜头：每个镜头有独立运镜（推、拉、横移、上/下摇）、轻微胶片颗粒与暗角；输出 `resources/studio-demo/video-01.mp4` … `video-12.mp4`。
- 12 段镜头按 96 秒时间线硬切拼接；首尾淡入淡出，不逐镜黑场。
- 混入 7 段对白、配乐、雨声/伞骨/心跳音效，按镜头起点对时；烧录中文字幕；输出 1920×1080 H.264/AAC 成片 `resources/studio-demo/demo-final.mp4`。
- 成片交付带 `quality=final`、`resolution=1080p`、`timelineVersion=5` 与 `renderKey`；时间线改动后旧成片立即显示过期，不再冒充当前成片。

### 10.2 可编辑项目

- 每个镜头同时保留原分镜图与 `videoAssetId`；分镜卡显示 VIDEO 与时长，时间线 12 段视频片段可直接拖动、裁剪、调速、替换。
- 保留 3 场、12 镜、7 段对白、配乐与 3 类音效；新增第一集标题/梗概和“纸鹤”第二集钩子。
- 老安装中的《逆行的伞》会在首次启动时自动升级：补齐 12 段动态镜头并把视频轨道指向它们；未改过的时间线补 1080p 成片，改过的时间线保持原样、只升级镜头。见 [studio.ts](C:/交付成品/Morrow/src/main/studio.ts) 的 `upgradeDemoFilm`。
- 交付页视频海报回退到项目封面，时间线预览视频也带海报，0:00 不再显示黑框。

### 10.3 证据

- 脚本：`scripts/build-demo-film.mjs` 可重复生成 12 段动态镜头、SRT、海报与 1080p 成片。
- E2E：`tests/e2e/demo-film.spec.ts` 验证 12 个视频资产/12 段视频时间线/7 对白/7 字幕/96 秒；交付页视频实际加载为 1920×1080 并能播放；改动时间线后旧成片过期。
- 打包版：真实 r057 便携包启动后读取内置工程，`12 镜视频资产 / 12 视频片段 / 1080p 成片 HTTP 200`。
- 截图：`screens/studio-timeline-dark.png`、`screens/studio-storyboard-dark.png`、`screens/studio-delivery-dark.png`、`screens/packaged-smoke.png`。
- 边界：动态镜头由分镜图做运镜生成，属于“动态漫”而非 AI 实拍短剧；源镜头仍可逐镜替换为 ComfyUI/外部视频。未做上传平台编码规范、音乐版权登记与真实发布审核。
