# 参考：快捷键、路径、变量与常量

这页只放查询型信息：快捷键、数据位置、环境变量、内置技能、设置分页、脚本与手机端常量。第一次使用看 [GETTING-STARTED.md](GETTING-STARTED.md)，模型与订阅看 [MODELS.md](MODELS.md)，图片视频与配音看 [MEDIA.md](MEDIA.md)。

## 快捷键

`设置 › 快捷键` 里可以改 6 个组合键，其余的按聚焦区域固定生效。Windows 上界面把 `CommandOrControl` 显示为 `Ctrl`；录制新组合时至少要有 Ctrl 或 Alt 之一（Shift 只能叠加），和现有快捷键冲突或属于系统保留组合时不会保存。

| 快捷键 | 动作 |
|---|---|
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+B` | 收起或展开侧栏 |
| `Ctrl+N` | 新建对话 |
| `Ctrl+,` | 打开设置 |
| `` Ctrl+` `` | 打开或收起终端 |
| `Ctrl+Shift+M` | 显示或隐藏桌面伙伴（全局，需先在设置里开启） |

下面这些按键跟随当前区域生效，不参与改键。

| 区域 | 按键 | 动作 |
|---|---|---|
| 全局 | `Esc` | 停止生成；有弹窗时先关闭弹窗 |
| 对话输入 | `Enter` | 发送消息（可在 `设置 › 回答` 改成 `Ctrl+Enter`） |
| 对话输入 | `Shift+Enter` | 在消息中换行 |
| 对话输入 | `/` | 打开命令菜单 |
| 对话输入 | `@` | 引用文件夹里的文件 |
| 编辑器 | `Ctrl+S` | 保存当前文件 |
| 编辑器 | `Ctrl+F` | 查找 |
| 编辑器 | `Ctrl+Z` | 撤销 |
| 编辑器 | `Ctrl+Y` | 重做 |
| 文件树 | `Enter` | 打开文件或展开文件夹 |
| 文件树 | `F2` | 重命名 |
| 文件树 | `Delete` | 删除 |
| 文件树 | 方向键 | 在文件之间移动 |
| 文件树 | `Shift+F10` | 打开右键菜单 |
| 内置浏览器 | `Ctrl+T` | 新建标签页 |
| 内置浏览器 | `Ctrl+L` | 聚焦地址栏 |
| 内置浏览器 | `Ctrl+W` | 关闭当前标签页 |
| 内置浏览器 | `Ctrl+Tab` | 切换到下一个标签页 |
| 内置浏览器 | `Ctrl+Shift+Tab` | 切换到上一个标签页 |
| 创作台写作台 | `Ctrl+S` | 保存当前章节 |
| 创作台写作台 | `Ctrl+F` | 查找 |
| 创作台写作台 | `Ctrl+H` | 替换 |
| 创作台写作台 | `Ctrl+Shift+Z` | 重做 |
| 窗口 | `Alt+F4` | 关闭窗口，与标题栏关闭按钮共用确认逻辑 |

快捷键只在 Morrow 窗口内生效，桌面伙伴那一项例外。被系统或其他应用占用时不会生效，换一个组合再试。

## 数据路径

会话、作品、密钥、日志与缓存都在数据目录里。Morrow 启动时按下面的顺序选目录，命中第一个可用的就停。

| 顺序 | 场景 | 数据目录 |
|---|---|---|
| 1 | 启动参数带 `--data-dir=<路径>` | 使用该路径；此时设置里不能改目录 |
| 2 | 在 `设置 › 关于` 里选过自定义目录 | `%LOCALAPPDATA%\Morrow\data-location.json` 里记录的路径；路径不可用时回退默认目录 |
| 3 | 便携版：exe 同级有 `portable.marker`，或启动器设置了 `PORTABLE_EXECUTABLE_DIR` | `<exe 所在目录>\Morrow Data` |
| 4 | 单文件便携版：从 `.morrow-runtime-*` 运行时启动 | 回溯到宿主目录，仍是 `<exe 所在目录>\Morrow Data` |
| 5 | 其他情况（NSIS 安装版） | `%APPDATA%\Morrow` |

`MORROW_DATA_DIR` 是 core 侧的数据目录覆盖项：`resolveMcpDataDir` 会优先读它，再回退到 `--data-dir` 与默认位置。桌面端启动时不读这个变量，而是由主进程把解析结果写进去，供 core 工具、MCP 配置发现与终端子进程使用；直接设置它不会改变上面的目录选择，启动时覆盖目录要用 `--data-dir`。

数据目录里常见的条目：

| 路径 | 内容 |
|---|---|
| `sessions/` | 会话与消息 |
| `snapshots/`、`checkpoints/` | 文件备份与会话检查点 |
| `logs/main.log` | JSON 行日志，5 MB 轮转，保留 3 份 |
| `settings.json` | 应用设置 |
| `secrets.json` | API Key 等敏感值，用 Windows DPAPI 加密 |
| `permissions.json`、`permissions/approval-log.jsonl` | 权限规则与审批日志 |
| `studio/` | 创作台作品、素材、版本、任务与回收站 |
| `usage/token-activity.json` | 按天累计的 token 用量 |
| `schedules/` | 定时任务 |
| `skills/`、`skills-state.json` | 本机安装的技能与启停状态 |
| `collaboration/` | 协作项目、工具审计与共享成果 |
| `mcp.json`、`mcp-secrets.json`、`mcp-trust.json` | 外部工具配置、密钥与工作区信任 |
| `downloads/`、`editor-history/`、`attachments/`、`tmp/` | 下载、编辑历史、附件与临时文件 |
| `engines/`、`media-engines.json`、`media-models.json` | 本机多媒体引擎与模型清单 |

工作区里的 `.morrow/` 放项目记忆 `MEMORY.md`、工作区技能与 MCP 配置。创作台默认用 `<数据目录>\studio`；在创作台设置里改过位置后，指针存在 `%LOCALAPPDATA%\Morrow\studio-location.json`，可用 `MORROW_STUDIO_LOCATION_FILE` 覆盖指针文件。

在 `设置 › 关于` 更改数据目录会重启 Morrow，并迁移对话、设置、项目、记忆等数据；浏览器登录状态不迁移。有任务在跑时按钮不可用，先停止任务。

## 环境变量

普通使用通常不需要设置这些变量。下表里“谁在用”写的是实际读取或写入它的位置。

| 变量 | 作用 | 谁在用 |
|---|---|---|
| `MORROW_DATA_DIR` | 已解析的数据目录，供 core 与子进程定位配置、密钥和临时文件 | `src/main/memory.ts` 写入；`src/core/tool-extra.ts`、`src/main/terminal-manager.ts` 读取 |
| `MORROW_PROMPT_SOURCE` | 覆盖创作台提示词私有源目录，默认 `%APPDATA%\Morrow-build\prompts`；缺源时构建失败，typecheck 只写占位 | `scripts/embed-prompts.mjs`（`prebuild`、`embed:prompts`、`pretypecheck`） |
| `MORROW_DEMO_SPEED` | 演示模式的播放倍率，`0` 表示不等待，默认 `1` | `src/core/providers.ts`；E2E 与截图用 `0.05` |
| `MORROW_TEST` | 测试模式：跳过系统级快捷键注册、开放测试专用 IPC、启用测试专用行为 | `src/main/shortcuts.ts`、`features.ts`、`agent.ts`、`artifacts.ts` |
| `MORROW_TEST_CSP` | 未打包形态也套用生产 CSP，仅供 E2E 验证 | `src/main/index.ts` |
| `MORROW_STUDIO_LOCATION_FILE` | 覆盖创作台目录指针文件路径，默认 `%LOCALAPPDATA%\Morrow\studio-location.json` | `src/main/workspace.ts` |
| `MORROW_STUDIO_NO_DEMO` | 设为 `1` 时不注入创作台演示样例 | `src/main/studio.ts`；`scripts/smoke-packaged.mjs` |
| `MORROW_SKIP_ELECTRON_BINARY` | 设为 `1` 时 `postinstall` 跳过 Electron 二进制下载 | `scripts/ensure-electron.mjs` |
| `MORROW_E2E_EXE` | 指定 E2E 启动的已打包 exe 路径 | `tests/e2e/helpers.ts` |
| `MORROW_COMFYUI_DIR` | 指定 ComfyUI 安装目录 | `src/main/media.ts` |
| `MORROW_TTS_HOME`、`MORROW_TTS_PYTHON`、`MORROW_TTS_MODEL`、`MORROW_TTS_SCRIPT` | 本机 Qwen3-TTS 的目录、解释器、模型与启动脚本 | `src/main/tts-local.ts` |
| `MORROW_TERMINAL` | 设为 `1`，标记该进程是 Morrow 打开的终端或后台任务 | `src/main/terminal-manager.ts` |
| `MORROW_MCP_CONFIG`、`MORROW_MCP_TRUST_WORKSPACE` | 覆盖 MCP 配置文件路径；声明工作区信任级别 | `src/core/tool-extra.ts` |
| `MORROW_ALLOW_DATA_DIR_CHANGE` | 即使由 `--data-dir` 锁定，也允许在设置里改数据目录（测试用） | `src/main/workspace.ts` |
| `MORROW_STUCK_STEPS`、`MORROW_STUCK_REPEATS`、`MORROW_STUCK_IDLE_MS` | 卡住检测的步数、重复次数与空闲时间阈值 | `src/main/agent.ts` |
| `MORROW_SIGN_PFX`、`MORROW_SIGN_PFX_PASSWORD`、`MORROW_SIGN_THUMBPRINT`、`MORROW_SIGN_SUBJECT`、`MORROW_SIGN_AUTO`、`MORROW_SIGN_TIMESTAMP_URL` | 打包时的代码签名证书与时间戳配置 | `scripts/dist-portable.mjs` |
| `MORROW_RELEASE_DIR`、`MORROW_DELIVER_DIR` | 覆盖构建输出目录与交付目录 | `scripts/dist-portable.mjs`、`scripts/pack-source.mjs` |
| `MORROW_RUNTIME_REVISION` | 单文件便携版的运行时缓存修订名 | `scripts/dist-portable.mjs` |

## 内置技能

内置技能随应用安装，当前 20 个，技能数据版本为 12。启停入口在 `设置 › 技能`，工作区技能放在 `.morrow/skills/<名称>/SKILL.md`；来源与许可见 [DEVELOPMENT.md](DEVELOPMENT.md)。

| 技能 | 一句话用途 |
|---|---|
| `brainstorm-and-scope` | 把模糊需求变成可执行的任务简报 |
| `plan-and-execute` | 为多步骤任务做可验证的计划并持续推进 |
| `verify-before-delivery` | 用新鲜证据验证后再声称完成 |
| `parallel-work` | 把独立任务拆给最多 10 个协作成员 |
| `code-review` | 只读审查改动，按 P0–P3 报风险 |
| `debugging` | 稳定复现、定位根因、最小修复并做红绿验证 |
| `test-writer` | 补高价值自动化测试与回归保护 |
| `refactor` | 建行为基线后小步重构 |
| `security-audit` | 围绕信任边界做授权范围内的安全审计 |
| `frontend-art-direction` | 建立视觉方向并多轮打磨界面 |
| `deliverable-quality` | 按统一标准自检交付成品 |
| `document-deliverables` | 写可交付文档与 Word、Excel、PPT、PDF 成品 |
| `data-analysis` | 从 CSV、Excel 做可复核的分析 |
| `web-research` | 带来源的联网调研并交叉验证 |
| `canvas-artifacts` | 生成可预览、可导出的画布成品 |
| `workspace-git` | 在工作区内读写文件并管理 Git |
| `mcp-integration` | 接入、调用与排查 MCP 工具和资源 |
| `skill-author` | 创建、测试并安装 SKILL.md |
| `webapp-testing` | 用真实浏览器验证网页 |
| `computer-use` | 用 Windows UI Automation 操作桌面应用 |

## 设置分页

设置是 21 个扁平分页，没有二级分组，顺序与代码里的标签表一致。从 `Ctrl+,`、侧栏底部的设置按钮或命令面板进入。

| 序号 | 分页 | 可配置内容 |
|---|---|---|
| 1 | 模型 | 选服务商（国内、国际、本地、自定义），填 API Key 与 Base URL，测试连接、刷新可用模型；逐个模型改上下文与最大输出，开关工具调用、图片输入与思考；添加自定义服务；设置重试次数与退避 |
| 2 | 订阅 | ChatGPT / Codex、Qoder、9 个 Agent 订阅（Kimi Code、GLM Coding Plan、MiniMax Code、Step Plan、Command Code、Cline Pass、Google Antigravity、OpenCode、OpenDesign Cloud）与自定义第三方订阅；登录、导入本机登录、看额度、刷新模型 |
| 3 | 本地 | ComfyUI 地址、安装目录、自动启动与一键启动，本机引擎与模型清单、自定义工作流 JSON；FFmpeg 路径；云端多媒体服务与每类默认服务 |
| 4 | 联网搜索 | 自动联网搜索开关；自定义服务商 Tavily、Brave、Serper、SearXNG 与实例地址；API Key 或访问令牌；默认来源数 3、5、8、10；保存并测试 |
| 5 | 记忆 | 长期记忆、任务经验与“Morrow 的建议”；建议采纳后才写入，任务经验可暂停、删除或清空 |
| 6 | 技能 | 内置与“我的技能”的启停、搜索、筛选与排序；从本地文件夹或 zip 安装；查看技能说明 |
| 7 | 外部工具 | 已安装的 MCP 服务与官方目录（8 项）；stdio 本机程序或 HTTP 网络服务；OAuth、密钥、安装到当前文件夹或所有对话、测试连接 |
| 8 | 全部功能 | 可搜索的功能目录，逐项说明用途，并标出哪些动作需要你确认 |
| 9 | 全局搜索 | 搜索对话、文件与成品；限定当前文件夹或整个 Morrow；本地搜索，不联网 |
| 10 | 版本记录 | Git 面板：初始化、status 与 diff、暂存与取消暂存、放弃改动、提交、身份、分支、log 与 show；只操作当前文件夹 |
| 11 | 上下文 | 当前对话占用（API 精确或估算）与累计输入输出、缓存、费用；自动压缩开关与 50–95% 阈值、立即压缩；项目规则文件 AGENTS.md、CLAUDE.md、MORROW.md |
| 12 | 回答 | 回答风格与自定义偏好；发送键 Enter 或 Ctrl+Enter；运行中发送选插话或排队；自动命名对话；完成时通知 |
| 13 | 用量 | 今天、近 7 天、近一年与累计用量，活跃天数；按天、按周、累计三种热力图；服务商没有数据时标注估算 |
| 14 | 归档 | 已归档对话的恢复与永久删除；清除全部对话（不动文件夹里的文件、设置、记忆、项目、定时安排与 API Key） |
| 15 | 权限 | 只读、询问、完全访问三档；文件夹权限规则（工具、前缀、路径三类，允许或拒绝）；审批日志；会被单独询问的危险动作清单 |
| 16 | 自动运行 | 自定义命令列表（来自 `.morrow/commands/` 与 `~/.morrow/commands/`）；协作成员类型；自动动作（发送消息前、每次工具完成后、每轮结束后运行指定命令，最多 20 条，每个事件最多启用 5 条） |
| 17 | 手机配对 | 远程通道开关（默认关闭）；粘贴手机配对请求；生成六位码与配对文本，90 秒有效；已配对设备与撤销 |
| 18 | 终端 | 选择默认终端（Git Bash、PowerShell 7、WSL），重新检测，打开终端；只影响之后新建的终端 |
| 19 | 外观 | 主题、应用字号、代码字号、代码字体、减少动效、token 计量、桌面小伙伴、关闭窗口时的行为 |
| 20 | 快捷键 | 6 个可改组合键，录制、冲突检测与恢复默认；按区域查看其余只读键位 |
| 21 | 关于 | 版本与 Electron、Chromium、Node 版本；数据目录的复制、更改、打开与恢复默认；打开日志 |

## 命令速查

脚本都在 `package.json` 里，用 `npm run <名称>` 执行。源码构建需要私有提示词源，见 [DEVELOPMENT.md](DEVELOPMENT.md)。

| 命令 | 说明 |
|---|---|
| `npm run dev` | 用 electron-vite 启动开发模式 |
| `npm run build` | 先跑 `embed:prompts` 与类型检查，再构建主进程、preload 与渲染层 |
| `npm run typecheck` | 对 Node 与 Web 两套 tsconfig 做 `--noEmit` 检查；缺提示词源时写占位再检查 |
| `npm run test:unit` | 用 Vitest 跑单元测试 |
| `npm run test:e2e` | 先用 `build-for-tests` 构建，再用 Playwright 跑 Electron 流程测试 |
| `npm run test:suite` | 静态校验测试套件与 `tests/core-coverage.json` 的对应关系，不执行用例 |
| `npm run verify` | 依次跑类型检查、`audit:ui`、`audit:flex`、`docs:check`、`test:suite`、`test:unit`、`test:e2e` |
| `npm run docs:check` | 检查文档链接与锚点、截图尺寸与引用、封面与废弃目录 |
| `npm run docs:capture` | 先构建，再用 Playwright 抓文档截图 |
| `npm run dist:final` | 构建后产出两个交付文件：单文件便携 exe 与 NSIS 安装包 |
| `npm run smoke:packaged` | 启动已打包产物做冒烟，验证窗口、渲染与数据目录，可加 `--folder` 或 `--all` |
| `npm run pack:source` | 把当前工作树打成源码 zip，可加 `--ref` 指定提交 |

补充脚本：`preview` 预览构建产物，`dist`、`dist:all`、`dist:dir` 是不同打包形态，`test:pair-panel` 抓配对面板截图，`audit:ui` 与 `audit:flex` 做 UI 规则审计，`bench:compaction` 与 `bench:collaboration` 跑基准，`produce:demo-film` 生成演示片。完整构建与发布链路见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 手机端常量

手机端是桌面端的旁观与审批端，配对流程见 [PAIRING.md](PAIRING.md)，功能与限制见 [MOBILE.md](MOBILE.md)。

| 常量 | 值 |
|---|---|
| 应用包名 | `studio.morrow.android.debug`（debug 变体） |
| versionName | `1.0.0-debug` |
| minSdk / targetSdk | 26 / 35 |
| 通道监听端口 | `relayPort` 默认 `0`，表示由系统分配可用端口 |
| 配对票据有效期 | 90 秒，一次性 |
| 配对请求前缀 | `MORROWPAIR1.` |
| 六位码错误上限 | 3 次，超过后票据作废 |
| 关闭码 4401 | 鉴权失败 |
| 关闭码 4402 | 加密帧认证失败，密文被改过 |
| 关闭码 4403 | 检测到重放，旧帧或乱序帧 |

密钥协商用 ECDH P-256，经 HKDF-SHA256 派生双向密钥，再用 AES-256-GCM 加密信道；手机只从同一局域网直连，公网中继未实现。
