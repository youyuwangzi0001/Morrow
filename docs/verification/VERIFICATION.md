# Morrow v0.1.0 验收记录

> 日期：2026-10-22（打包/签名复核；功能验收自 2026-10-21） · 版本：0.1.0 · 平台：Windows 10/11 x64 便携版
>
> 验收截图保留在本地 `docs/verification/screens/`，不纳入 Git；下方 `screens/` 链接仅在本机有效。

## 1. 本轮“小白化”目标对照

| 目标 | 结果 | 证据 |
|---|---|---|
| 侧边聊天占用右侧栏，与 Agent 主区域同一套设计，不遮挡输入框 | 完成：停靠右栏，与画布共用宽度/拖拽；关闭保留问答，切换对话清空 | `screens/sidechat-dark.png`、`sidechat-light.png`；sidechat E2E 3/3 |
| MCP、思考强度等约定英文保留 | 完成：MCP、tokens、`auto/low/medium/high/xhigh/max` 保留 | 模型 E2E、推理强度 E2E |
| 模型页剔除旧模型，补充近期模型 | 完成：移除 Qwen Plus / MiniMax M2.5；新增 MiMo V2.6 Pro/Flash、Muse Spark 1.3、Claude Fable 5.1、MiniMax M3、Qwen3.8 Flash Next | `screens/r5-final-settings-models.png`；`shared/models.ts` |
| 删除顶栏工作台，功能入口收进设置 | 完成：删除网格入口、菜单页与 Ctrl+Shift+W；设置新增「功能与工具」，命令面板保留直达 | `screens/r10-tools-settings.png`、`r10-panel-*.png` |
| 集群（Agent Swarm）作为小助手的主要并行方式，参考 Kimi Agent 集群 | 完成：角色/独立上下文/继承权限/禁止递归/2–8 个子任务、最多 8 并行；实时任务板显示等待、进行中、完成、失败、步数与结论；失败不伪装完成 | `screens/swarm-dark.png`、`swarm-light.png`；集群 E2E |
| 检查点回退同步回退对话与文件，操作直接 | 完成：回答末尾「回退」→ 唯一确认弹窗 → 同时恢复文件、删除本轮新建文件、回退对话；冲突可重新检查 | `screens/rewind-conflict-dark.png`、`rewind-ready-dark.png`；回退 E2E |
| 全局文案与零碎 UI 收口 | 完成：文件夹 / 对话 / 成品 / 执行过程 / 小助手；顶栏移除重复模型与模式入口；管理面板与设置页简化 | 各处截图与 `README.md` / `USER-GUIDE.md` |
| 清理历史构建、缓存与冗余文档 | 完成：旧构建、测试结果、日志、历史审计报告与旧截图已清理；最终只保留 `deliver/` 单文件 exe、使用说明、SHA256SUMS 与 LICENSE | 仓库目录 |

### 2026-10-21 全量质量自查修复

对 9 个指定新功能（项目容器、定时任务、连接器目录与安装、深度研究、成品版本与交付、临时对话与数据清除、灵动岛与快速唤起、全局回答风格、Token 统计与视图）和 7 个额外 R10 区域（文件树与编辑器、内置浏览器、记忆中心、全局搜索、受控 computer-use、文档工具、模型目录与同步）逐项审计并修复。代表性修复：

- Token 热力图按真实周列排布（列=周、行=周一→周日），月份标签与格子共用网格并按月份 1 日锚定；首月不足 3 周时不显示，避免重叠。
- 文件树键盘误操作、文件夹改名/删除后的陈旧展开状态、外部打开文件不展开祖先、子目录 2000 项截断提示。
- 编辑器保存竞态、跨标签撤销污染、只读模式实时生效、另存为基线/可编辑性、历史 IPC 工作区边界。
- 内置浏览器自动化精确定位/输入、下载确认被原生视图遮挡、下载成功提示与打开文件夹、主窗口归属（不挂到灵动岛）。
- 记忆中心跨范围确认误清空、IPC 工作区边界、越界软链接、注入预算；全局搜索工作区边界、索引上限与排序；computer-use DPI 与输入校验；办公文档读取/写入边界；模型同步重启持久化与 200 条上限。
- 打包脚本将中间解包目录移出 `release/`，避免系统索引/杀毒占用导致下一次打包失败。

### 2026-10-21 真实使用问题修复

| 问题 | 修复 | 证据 |
|---|---|---|
| 设置 → 功能与工具 里的「终端」与顶栏重复 | 移除该行；终端仍用顶栏入口，默认 Shell 仍在「设置 → 终端」选择 | `screens/r10-tools-settings.png`；r10-tools-settings E2E |
| 「关于」里的清除全部对话与侧栏折叠归档不完整 | 新增「设置 → 归档」分页：真实列出归档对话（标题/预览/消息数/时间/文件夹），支持恢复、逐条永久删除；清除全部对话移到该页底部；侧栏不再保留「已归档」折叠区，归档与恢复状态写入会话文件并可跨重启保留 | `screens/settings-archive-dark.png`、`settings-archive-light.png`、`settings-archive-delete.png`；settings-archive E2E；session-store 单测 |
| 输入框看不到思考强度（同步过旧模型元数据时） | 加载设置时补齐缺失的 `reasoningStyle`：Anthropic 用 thinking、其余协议用 effort；同步元数据合并与 `findModel` 同时兜底，旧配置升级后不再隐藏选择器 | `screens/reasoning-legacy-model-dark.png`、`reasoning-menu-dark.png`；reasoning-default E2E 2/2 |
| 切换 xhigh/max 提示「推理强度无效」 | 主进程会话 IPC 的白名单漏了 `xhigh`/`max`，而输入框已提供这两档；改为共享 `REASONING_EFFORTS` 校验，输入框选项也由同一常量生成，避免再次漂移 | reasoning-cost E2E（真实运行后切换 xhigh → max → high，校验会话状态且无错误提示）；reasoning 单测 |
| 同版本重建后单文件版仍运行旧缓存 | 启动器用内嵌应用 zip 的 SHA-256 校验 `.morrow-runtime-0.1.0`，内容变化即替换旧运行文件；已用伪造旧缓存验证首次启动会重新解压 | `scripts/smoke-packaged.mjs` 单文件冒烟；`build/launcher/MorrowLauncher.cs` |

### 2026-10-22 交付前两项修复

| 项目 | 修复 | 证据 |
|---|---|---|
| 项目面板入口收敛 | 左栏改为「全部项目 / 当前文件夹」Segmented 切换，新建按钮与切换同排；移除底部重复的「为当前文件夹新建项目」提示条；新建成功后直接进入项目概览 | `screens/a1-project-scope-current.png`；`a1-projects-home` 3/3；底部 `.pp-cta` 断言为 0 |
| 数据目录自定义 | 设置 → 关于新增「更改目录」：原生选目录、可选迁移现有对话/设置/项目/记忆/技能、写指针并重启；支持「恢复默认目录」；启动按指针优先。正常便携启动时按钮可用；测试以 `--data-dir` 启动时按钮按设计锁定 | `screens/settings-about-data-dir-enabled.png`（正常启动）、`settings-about-data-dir.png`（参数锁定）；`data-dir` 单测 5/5；`data-dir-settings` E2E 1/1 |

### 2026-10-22 R13 七项修复

| 问题 | 修复 | 证据 |
|---|---|---|
| 预览生成内容偶发 `ERR_CONNECTION_REFUSED` | 本地服务端口未就绪时自动等待重试（12×500ms），失败提示引导检查服务与端口；提示词优先用画布预览，必须用浏览器时先确认终端日志 | `r13-browser-retry` E2E（延迟 700ms 启动的本地服务可被成功打开） |
| 命令失败较多、超长提示溢出 | grep 支持直接搜索单个文件；命令失败按 PowerShell 引号/参数、MODULE_NOT_FOUND、权限占用等输出可执行建议；复杂脚本建议先写文件再执行；长错误自动换行 | `r13-long-error` E2E（400 字符无空格路径，错误块/详情/对话区均无横向溢出）；grep 单文件单测 |
| 上下文入口 | 删除顶栏圆环与输入框旧提示，改为输入框底部工具条内的圆环；点击向上弹出上下文占用、输入、其中缓存、缓存命中率、输出、累计费用、模型，双主题适配 | `r13-context-meter` E2E；`r13-context-meter-dark/light.png` |
| 大文件修改误报“内容没有变化” | 大文件 diff 改用公共前后缀裁剪 + 变更片段 LCS；超大文件回退为行多重集增删统计；仅换行符变化单独说明 | `r13-large-diff` E2E（2490 行文件 +2/−1）；diff 单测 |
| 计划/目标进度只在末尾更新 | 计划可分批续接；连续多步未更新时提醒模型同步；所有工作/目标流程提示边做边更新 | 提示词检查 + `r13-plan-finishing` E2E |
| 计划已全部完成但仍在优化 | 检测完成后继续改文件时追加真实「收尾完善（进行中）」步骤；托盘在运行中显示「计划完成 · 收尾中」，不再虚报收工 | `r13-plan-finishing` E2E（1/2 + 未完成 + 不再显示计划完成） |
| 画布页签不能关闭/排序 | 页签支持关闭（选中相邻页签）、拖动排序；关闭后可重新打开；文档页签同样可关闭 | `r13-canvas-tabs` E2E（关闭 A、拖动 C 到 B 前） |

补充修复：单文件启动器在 exe 同级运行目录被占用、回退到 `LOCALAPPDATA` 解压后，仍去旧路径查找 `Morrow-app.exe`，会导致启动失败；已改为使用实际解压目录，并记忆回退位置供后续启动复用。交付目录以该修复后的启动器完成冒烟。

## 2. 自动化门禁

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 0 error |
| 单元 | `npm run test:unit` | **811 passed + 5 skipped（79 files）** |
| 构建 | `npm run build` | 通过 |
| 端到端（本轮源码构建） | R12/R13 定向回归（11 个 spec） | **11/11 passed**（21.8s）：diff、计划同步/收尾、阶段、终端、预览重试、画布页签、上下文入口、长错误 |
| 打包 | `npm run dist` | 通过：单文件便携 exe 为 `50f5a9af…`；使用本地 Electron 与已缓存 winCodeSign |
| 打包冒烟（临时副本） | `node scripts/smoke-packaged.mjs --exe=tmp/...` | **通过**（5.2s）：启动、CDP、首屏渲染、preload、截图 |
| 打包冒烟（交付目录 + 旧运行目录被占用） | `node scripts/smoke-packaged.mjs --exe=deliver/...` | **通过**（7.6s）：启动器自动回退 `LOCALAPPDATA` 后从实际解压目录启动，渲染正常 |
| 直启 | CreateProcess 直接启动（无快捷方式）+ ShellExecute 模拟下载标记 | 单文件启动到渲染进程，关闭后启动器退出码 0；运行时 `app.asar` SHA-256 与交付包一致 |

打包冒烟摘要（本轮从 `C:/Temp` 的交付副本运行，避免污染 `deliver/`）：

- 单文件临时副本：`docs/verification/smoke-packaged.json`
- 交付目录（含旧运行目录被占用场景）：`docs/verification/smoke-delivered.json`

## 3. 最终产物

| 形态 | 位置 | 大小 | SHA-256 |
|---|---|---|---|
| 单文件便携版（唯一交付） | `deliver/Morrow-0.1.0-portable.exe` | 196,799,488 B / 187.68 MB | `50f5a9af3aa551b0dd43c119219e78623cff6eb02c5f8a7daf9c2f9089658f2f` |

交付物共 4 files / 196,803,948 B / 187.69 MB：单文件 exe、`使用说明.txt`、`SHA256SUMS.txt`、`LICENSE`。`deliver/` 中同时存在的 `Morrow Data` 与 `.morrow-runtime-*` 是本机运行数据/解压缓存，不属于分发文件；正式分发只需复制上述 4 个文件。完整清单与签名状态见 `docs/verification/packaging.json`。启动器文件版本与单文件运行时缓存目录均为 0.1.0。

## 4. Windows 安全提示诊断（2026-10-22）

### 4.1 结论

- 最终交付的单文件 exe 为 Authenticode `NotSigned`；内部 `--all` 构建的文件夹入口同样未签名（不再交付）。`Cert:\CurrentUser\My` 与 `Cert:\LocalMachine\My` 中没有代码签名证书。**没有受信任证书就无法消除“发布者未知/信誉不足”类提示。**
- 本机 `HKLM\SOFTWARE\Policies\Microsoft\Windows\System\EnableSmartScreen=0` 禁用了 SmartScreen，因此无法在本机复现该提示；直启通过只能证明程序可运行，不能证明默认 Windows 上的信誉行为。
- 版本不是原因：Electron 44 的 README 明确 Windows 10 及以上；React 只运行在渲染进程，与 Windows 启动器、代码签名、SmartScreen 无关。降级 Electron/React 不会消除 SmartScreen 或 MOTW。
- 旧启动器清单是真实弱点：csc 默认清单只有 `asInvoker`（`MyApplication.app`），没有 supportedOS/DPI/Common-Controls/longPathAware。已补全，但这只改善 DPI、兼容性与 UAC 语义，**不会**消除 SmartScreen。

### 4.2 提示类别

| 提示 | 触发条件 | 清单/版本能否修复 | 处理 |
|---|---|---|---|
| MOTW「打开文件 - 安全警告 / 无法验证发布者」 | 文件带 `Zone.Identifier`（浏览器/聊天工具下载） | 否；`Unblock-File` 或右键属性 → 解除锁定可去掉 | 交付说明要求先解除 exe 锁定 |
| SmartScreen「Windows 已保护你的电脑」 | 未签名/低信誉 exe 被 ShellExecute 启动 | 否；需要受信任代码签名证书 + 下载信誉 | 无证书时「更多信息 → 仍要运行」 |
| Smart App Control / WDAC / AppLocker | Windows 11 策略或企业策略阻止未签名/不受信任应用 | 否；需要签名或策略例外 | 企业环境需管理员放行 |
| UAC | `requestedExecutionLevel` 不是 asInvoker | 清单已固定 asInvoker，不触发 | 不适用 |
| 杀毒软件 | 启发式/信誉 | 签名有帮助但不保证 | 加入白名单 |

用户看到的单文件弹窗最可能是 SmartScreen；如果 exe 是直接下载的，可能先出现 MOTW 再出现 SmartScreen。精确判断需要提示标题与按钮文字。

### 4.3 启动器清单证据

`build/launcher/MorrowLauncher.manifest` 通过 csc `/win32manifest:` 嵌入单文件启动器（内部 `--all` 文件夹启动器使用同一清单）；用 `mt.exe` 从交付 exe 提取：

- `requestedExecutionLevel level="asInvoker" uiAccess="false"`
- supportedOS：Windows 7、8、8.1、10/11 四个 GUID
- `dpiAware=true/pm` + `dpiAwareness=PerMonitorV2, PerMonitor`
- `longPathAware=true`
- `Microsoft.Windows.Common-Controls` 6.0.0.0

文件大小变化：单文件 exe 196,770,304 → 196,774,400 B（入口清单、使用说明与数据目录说明增量）。

### 4.4 签名支持

`scripts/dist-portable.mjs` 支持 `MORROW_SIGN_PFX` + `MORROW_SIGN_PFX_PASSWORD`、`MORROW_SIGN_THUMBPRINT`、`MORROW_SIGN_SUBJECT`、`MORROW_SIGN_AUTO=1`。配置证书后会对单文件 exe（以及内部 `--all` 文件夹入口）做 SHA-256 + RFC3161 时间戳签名，并用 `signtool verify /pa` 与 PowerShell `Get-AuthenticodeSignature` 双重校验；任一失败即打包失败。未配置时产物标记 `signed:false`，不生成/安装自签名证书，也不阻断打包。

本次签名审计：

| 文件 | 状态 | 签名者 |
|---|---|---|
| `deliver/Morrow-0.1.0-portable.exe` | `NotSigned` | — |
| 单文件运行时 `resources/.../node-pty/.../OpenConsole.exe` | `Valid` | Microsoft Corporation |
| 单文件运行时 `resources/.../node-pty/.../winpty-agent.exe` | `NotSigned` | — |

### 4.5 直启验证

- 单文件 exe：直启 → 首次解压 `.morrow-runtime-0.1.0` → 加载渲染进程，关闭后启动器退出码 0。
- 最终包复验：单文件副本写入 `Zone.Identifier`（模拟浏览器下载）后经 ShellExecute 启动，窗口标题 `Morrow`，运行时 `app.asar` SHA-256 与交付包一致（`c9cabf7b…`）。
- 本机 SmartScreen 策略被禁用（`EnableSmartScreen=0`），以上不能证明默认 Windows 上双击无信誉提示；彻底消除需要受信任的代码签名证书。

## 5. 关键界面截图

- 主界面：`screens/v0.1.0-default-dark.png`
- Token 热力图：`screens/token-activity-heatmap-dark.png`、`token-activity-daily-light.png`
- 文件树 / 编辑器：`screens/r10-files-tree-light.png`、`r10-editor-readonly-mode.png`、`r10-editor-tab-isolation.png`
- 内置浏览器下载：`screens/browser-download-saved.png`
- 记忆中心：`screens/r10-memory-center-dark.png`、`r10-memory-center-light.png`
- 全局搜索：`screens/search-global-all.png`
- 模型设置：`screens/r5-final-settings-models.png`、`settings-local-sync-dark.png`
- 思考强度：`screens/reasoning-menu-dark.png`、`reasoning-legacy-model-dark.png`
- 对话归档：`screens/settings-archive-dark.png`、`settings-archive-light.png`、`settings-archive-delete.png`、`session-archive-light.png`
- 项目范围切换：`screens/a1-project-scope-current.png`
- 数据目录设置：`screens/settings-about-data-dir-enabled.png`（正常便携启动，按钮可用）、`screens/settings-about-data-dir.png`（测试参数锁定态）
- 功能与工具：`screens/r10-tools-settings.png`
- 侧边聊天：`screens/sidechat-dark.png`
- 集群 ×8：`screens/swarm-dark.png`、`swarm-light.png`
- 回退确认：`screens/rewind-ready-dark.png`
- 权限确认：`screens/permission-card.png`
- 管理面板：`screens/r10-panel-skills.png`、`memory.png`、`projects.png`、`connectors.png`、`search.png`、`browser.png`
- 终端：`screens/terminal-dark.png`、`terminal-light.png`
- 打包冒烟：`screens/packaged-smoke.png`

## 6. 已知限制

- 小助手不能再创建小助手；并行任务必须相互独立。
- 回退只覆盖 Morrow 通过写文件工具改过的文件；命令直接生成的文件不在回退范围。
- 终端使用真实 PTY（ConPTY），E2E 覆盖 PowerShell 键盘输入、命令提示符切换与后台任务；后台任务仍为独立子进程，应用退出后全部结束。
- 外部工具、浏览器自动化与 computer-use 依赖服务本身、网络与用户权限。
- 便携版未做代码签名（`NotSigned`）。首次运行可能被 SmartScreen 拦截一次，需要「更多信息 → 仍要运行」；解除下载锁定通常即可避免。如果每次都被拦截，可把 exe 加入安全软件白名单。要彻底消除提示，需要受信任的代码签名证书；清单和 Electron/React 版本都做不到。
- 更改数据目录需要重启；迁移只包含 Morrow 的对话、设置、项目、记忆与技能，不包含内置浏览器缓存/登录状态；恢复默认目录不会自动合并两边的数据。
- 打包中间目录（`release/`、`tmp/electron-builder-output/`）里的 `app.asar` 可能被 Qoder/索引器/杀毒软件占用，导致重复打包的清理步骤失败。关闭占用进程或排除目录后重跑即可；这不影响已经生成并验证过的 `deliver/` 产物。
- 打包用 `release/` 与测试用 `tmp/`、`test-results/` 均为中间产物，最终交付只保留 `deliver/` 中的单文件 exe、`使用说明.txt`、`SHA256SUMS.txt` 与 `LICENSE`。
