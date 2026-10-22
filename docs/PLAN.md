# Morrow 项目计划（v0.1.0）

> 最后更新：2026-10-22 · 版本：0.1.0

## 目标

Morrow 是一个面向非技术用户的桌面 AI 工作伙伴：说清结果，它在本机文件夹里读写文件、运行命令、查资料、做计划，并把可用的成品放回对话和画布。

## 当前状态

v0.1.0 已完成最终回归、打包与冒烟，交付完成。当前交付包含真实终端、集群 ×8、联网搜索和权限卡等改动；并在 2026-10-21 对 9 个指定新功能及 7 个额外 R10 区域完成全量质量自查与修复（Token 周列热力图、文件树/编辑器、浏览器下载、记忆/搜索边界、computer-use、文档工具、模型同步等）。

R19（2026-10-22）完成代码库扁平化：源码文件 292 → 274，测试文件 195 → 53（79 个单元文件合并为 10 个套件，87 个 E2E spec 合并为 14 个套件），组件与画布目录上移一层；同时修复设置分页重复标题、终端 UTF-8 菱形乱码、运行中闪电插话按钮缺失，目标轮次上限提高到 256，并对齐 5 个陈旧 E2E 断言。完整证据与包体元信息见 `docs/verification/VERIFICATION.md`。

R20（2026-10-23）完成 7 项交互修复：顶栏左半区拖动、移除顶栏 Morrow 字样（仅保留在关于页）、终端紧凑排版、浏览器返回主页面/切回、`/plan` 输入体验对齐目标模式并完善提示词、输入框窄宽度自适应、画布文件夹定位不再触发 Explorer 0xC0000142；同时补上跨流式分片的隐私遮蔽兜底。全量回归 169 passed + 4 skipped（173 E2E），单元 824 passed + 5 skipped。

### 已交付能力

| 能力 | 状态 |
|---|---|
| 对话、流式输出、工具调用、计划模式、长期目标 | 完成 |
| 文件树、编辑器、文件预览、版本历史 | 完成 |
| 轻量回退：回答末尾一键确认，同时回退对话与文件 | 完成 |
| 侧边聊天：占用右侧栏，不遮挡输入框 | 完成 |
| 集群（Agent Swarm）：角色、独立上下文、实时任务板、结果汇总 | 完成 |
| 外部工具（MCP）、技能、记忆、项目、全局搜索 | 完成 |
| 浏览器、真实终端（PTY）、后台任务、受控 computer-use | 完成 |
| 模型目录：MiMo V2.6、Muse Spark 1.3、Claude Fable 5.1、MiniMax M3 等 | 完成 |
| 思考强度：auto / low / medium / high / xhigh / max | 完成 |
| 设置入口收敛、全应用文案与术语统一 | 完成 |
| 首次引导、离线演示、数据本机保存与加密 | 完成 |

### 本轮“小白化”改造摘要

1. **外壳**：侧边聊天停靠右栏；删除顶栏工作台；功能入口收进「设置 → 功能与工具」。
2. **模型**：重做模型服务选择器；更新提供商与模型；剔除 Qwen Plus、MiniMax M2.5；补充 MiMo、Muse、Fable、M3。
3. **设置与输出**：管理面板与设置页文案直白化；保留 MCP、tokens、reasoning effort、上下文压缩等必要约定词。
4. **回退**：从对话末尾直接操作，单次确认同时回退对话与文件；冲突可在弹窗内重新检查。
5. **集群**：2–8 个子任务、最多 8 个并行；实时任务板、每个小助手的状态/步数/结论；失败不伪装完成。
6. **整体界面**：统一“文件夹 / 对话 / 成品 / 执行过程 / 小助手”等称呼；移除重复模型/模式入口。

### 2026-10-21 真实使用问题修复

1. **终端入口去重**：设置 → 功能与工具不再重复放「终端」；终端仍从顶栏打开，默认 Shell 在「设置 → 终端」选择。
2. **对话归档进入设置**：新增「设置 → 归档」分页，真实列出归档对话并支持恢复、逐条永久删除；清除全部对话移到该页底部；侧栏移除「已归档」折叠区，归档状态写入会话文件并跨重启保留。
3. **思考强度恢复显示**：修复旧版同步模型缺少 `reasoningStyle` 时选择器被隐藏的问题；Anthropic 补 thinking、其余协议补 effort，旧配置无需重新同步。
4. **思考强度切换**：修复主进程会话 IPC 漏掉 `xhigh`/`max` 导致的「推理强度无效」；输入框选项与校验共用同一白名单。
5. **单文件缓存失效**：启动器按内嵌应用 zip 的 SHA-256 校验运行时缓存，同版本重建也会替换旧运行文件。

### 2026-10-22 打包与签名修复

1. **启动器清单**：新增 `build/launcher/MorrowLauncher.manifest` 并通过 csc `/win32manifest:` 嵌入文件夹版和单文件版启动器；包含 asInvoker、Win7/8/8.1/10/11 supportedOS、`dpiAware=true/pm` + PerMonitorV2、`longPathAware`、Common-Controls v6。
2. **签名就绪**：`scripts/dist-portable.mjs` 支持 `MORROW_SIGN_PFX`、`MORROW_SIGN_THUMBPRINT`、`MORROW_SIGN_SUBJECT`、`MORROW_SIGN_AUTO=1`；对应用、文件夹启动器、单文件 exe 做 SHA-256 + RFC3161 时间戳签名，并用 signtool 与 PowerShell 双重校验，失败即打包失败。无证书时 `signed:false`，不生成自签名证书、不阻断打包。
3. **干净交付**：打包后只把单文件 exe、`使用说明.txt`、`SHA256SUMS.txt`、`LICENSE` 放进 `deliver/`；文件夹版、zip、旧包、缓存、`Morrow Data`、日志不进入交付。
4. **安全提示诊断**：三个主入口均为 `NotSigned`；SmartScreen/MOTW 不能靠 Electron/React 版本或清单消除，需要受信任的代码签名证书。首次运行按「更多信息 → 仍要运行」处理，或使用文件夹里的可选桌面图标入口。

### 验证口径

| 层 | 命令 | 通过标准 |
|---|---|---|
| 类型 | `npm run typecheck` | 0 error |
| 单元 | `npm run test:unit` | **763 passed + 5 skipped（74 files）** |
| 端到端 | `npx playwright test` | 上一轮 **149 passed**；本轮重跑打包版 3 项 **3/3 passed** |
| 打包 | `npm run dist` | 默认只生成单文件 exe；`--all` 文件夹/zip 仅内部构建检查 |
| 冒烟 | `scripts/smoke-packaged.mjs` | 单文件版通过启动、渲染、截图；内部文件夹构建另验证 portable.marker |
| 直启 | CreateProcess（无快捷方式） | 两种形态均加载渲染进程，关闭后启动器退出码 0 |
| 证据 | `docs/verification/VERIFICATION.md` | 命令、截图、哈希、签名状态齐全 |

## 收尾结果

- 全量回归：typecheck 0 error；unit 768 passed + 5 skipped（75 files）；全量 E2E 151 passed（含单文件打包版 4/4）；单文件真实冒烟通过。
- 构建缓存、测试结果、日志、历史审计文档与旧包已清理；最终产物与哈希见 `docs/verification/VERIFICATION.md` 与 `docs/verification/packaging.json`。
- 交付位于 `deliver/`，只包含单文件 exe、`使用说明.txt`、`SHA256SUMS.txt` 与 `LICENSE`。文件夹版、zip、`release/`、测试 `tmp/` 均为内部构建检查中间产物，最终不交付。
- 打包脚本把中间解包目录放到 `tmp/electron-builder-output/`；Qoder/索引器/杀毒软件可能占用其中的 `app.asar`，重复打包前需释放占用或排除目录。

## 已知限制

- 小助手不能再创建小助手；并行任务必须相互独立。
- 回退只覆盖 Morrow 通过写文件工具改过的文件；命令直接生成的文件不在回退范围。
- 终端使用真实 PTY（ConPTY），可选 PowerShell 7 / Windows PowerShell / 命令提示符 / Git Bash / WSL；后台任务仍为独立子进程，应用退出后全部结束。
- 外部工具、浏览器自动化与 computer-use 依赖服务本身、网络与用户权限。
- 便携版未做代码签名（`NotSigned`）。首次运行可能被 SmartScreen 拦截一次，需要「更多信息 → 仍要运行」；如果每次都被拦截，可用 `创建桌面快捷方式.cmd` 或把文件夹加入安全软件白名单。要彻底消除提示，需要受信任的代码签名证书；清单和 Electron/React 版本都做不到。
