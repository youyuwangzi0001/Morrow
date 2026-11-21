# 开发与打包

这一篇写给要跑起来、改起来、打包的人：环境与私有提示词源、仓库结构、测试真值、CI 的边界、截图管线、打包链路与提交前检查。架构与权限顺序见 [ARCHITECTURE.md](ARCHITECTURE.md)，交付实测见 [VERIFICATION.md](VERIFICATION.md)。

## 环境

Windows 10/11 x64、Node.js 22.12 或更高、Git。默认终端用 Git Bash，所以 Git 既是版本工具也是终端依赖。

```powershell
npm install
npm run dev
```

- `npm install` 之后会跑 `postinstall` 的 `ensure-electron.mjs`；不需要 Electron 运行时的环境可以设 `MORROW_SKIP_ELECTRON_BINARY=1` 跳过约 368 MB 的下载。
- 可选组件按需安装：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg、Qwen3-TTS 模型。它们不随包，缺了就明确失败。
- 源码构建必须先准备私有提示词源。`npm run build` 的 `prebuild` 调 `scripts/embed-prompts.mjs`，它读取 `%APPDATA%\Morrow-build\prompts\creative-masters.json` 与 `prompt-kit.json`；也可以用 `MORROW_PROMPT_SOURCE` 指向别的目录。缺这两个文件时脚本写一个空占位并退出 1，`npm run build` 直接失败。
- 干净 clone 跑不起来的原因就是这一条，不是依赖没装。空占位只能让 `npm run typecheck` 通过（`pretypecheck` 带 `--placeholder-ok`），不会生成可运行的创作台。
- `MORROW_PROMPT_SOURCE` 只在构建期读取；不要把私有源拷进仓库，也不要提交 `src/generated/`。

## 仓库结构

源码扁平放在五个根里，`scripts` 与 `tests` 平铺，交付物只进 `deliver/`。

| 路径 | 内容 |
|---|---|
| `src/main/` | Electron 主进程、窗口、Agent 服务、创作台、媒体、订阅、终端、Git、浏览器、relay 与持久化 |
| `src/core/` | Agent 循环、Provider、工具、权限、上下文压缩、协作，不 import Electron |
| `src/renderer/` | React 界面、feature 组件、Zustand store、样式与 token |
| `src/shared/` | 跨进程契约、类型、纯判定模块（门禁、帧数契约、接缝审计、导演层） |
| `src/generated/` | 构建期提示词产物，`.gitignore` 忽略 |
| `src/preload/` | 渲染层唯一入口，白名单方法与事件订阅 |
| `tests/unit/` | Vitest 用例，按功能域合并入口 |
| `tests/e2e/` | Playwright Electron 流程，按流程分文件 |
| `scripts/` | 构建、测试、打包、冒烟、截图与文档校验 |
| `docs/` | 中文文档、`screens/` 截图与机器证据 |
| `deliver/` | 两个 exe、APK 与 `SHA256SUMS.txt` |

- 不新建 `src/relay` 之类的第五个顶层源码目录，也不恢复 `core/agent/`、`studio/` 多层目录；新文件放进对应扁平目录。
- 远程通道按职责分成 `relay.ts`、`relay-channel.ts`、`relay-crypto.ts`、`relay-pairing.ts`、`relay-server.ts`；协作域是 `core/collaboration.ts` 加 `main/collaboration.ts`；搜索域是 `main/search.ts`。合并理由见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 渲染层的跨 feature 纯逻辑放 `*-core.ts`；跨 feature 共享放 `src/shared`，不要让两个 feature 互相 import。
- 测试辅助平铺为 `tests/unit/helpers.ts` 与 `tests/e2e/helpers.ts`，不恢复子目录。

## 安卓端仓库

手机端已经拆到独立仓库 [Morrow-Android](https://github.com/youyuwangzi0001/Morrow-Android)：源码、文档与 APK 都在那里，本仓不再包含安卓源码，也不再分发 APK。

- 两端共享协议、不共享代码。通道常量、帧格式、配对与加密在两边各有一份实现，靠向量脚本对齐；改协议要两边同时改。
- 联调入口：安卓仓库的 `scripts/e3-desktop-relay.mjs` 会加载本仓 `src/main/relay.ts` 与 `relay-channel.ts` 的真实实现，跑一次完整配对与加密帧收发。
- 本仓的 `npm run verify` 不构建安卓；不要把 Gradle 任务写进根 `package.json`。
- 安卓的工具链、构建与签名说明在 [Morrow-Android 的 BUILD.md](https://github.com/youyuwangzi0001/Morrow-Android/blob/main/docs/BUILD.md)。

## 开发边界

这些边界不是风格偏好，而是交付质量的一部分。

- 不重新引入本地创作手法库、固定故事模板或七维权重。创作判断只来自构建期内嵌的方法与提示词基座。
- 提示词只来自生成产物。不要恢复桌面读取、`resources/prompts` 或明文 JSON，也不要把提示词以可解密密文提交回仓库。
- 没有真实文本模型、ComfyUI、FFmpeg、TTS 或音乐服务时明确失败。不要用占位图、假候选、假额度或模板冒充成功。
- 出包门禁是可计算的工程判定：帧数、静帧、内嵌字幕、配乐人声、全等长、空镜开场等。新增检查项必须同时登记到 `GATE_CHECKS`，否则 `missingGateChecks` 会报错。
- 删除与回收站、数据目录迁移、密钥存储这类高风险逻辑，先看现有测试与边界，再动实现。
- `scripts/` 只放长期职责脚本（构建、测试、打包、冒烟、截图、文档检查）；一次性验收脚本在结论沉淀为测试后删除。
- 新增界面页时先在 `scripts/docs-capture.spec.ts` 里加稳定状态，再写文档引用；临时截图不要放进 `docs/screens`。

## 测试

测试分两套执行入口加一道静态登记。数量是维护预算，不是宣传数字。

| 命令 | 内容 | 当前真值 |
|---|---|---|
| `npm run test:unit` | Vitest 单元用例 | 1014 项、50 个文件 |
| `npm run test:e2e` | 先构建，再跑 Playwright Electron 流程 | 96 条、16 个文件，95 通过加 1 跳过 |
| `npm run test:suite` | 只读静态校验：覆盖登记、核心标记与数量预算 | 43 个功能域，预算 1014 / 96 |
| `npm run verify` | 七道门槛串行 | typecheck、audit:ui、audit:flex、docs:check、test:suite、test:unit、test:e2e |
| `npm run bench:compaction` | 上下文压缩基准 | 不参与门槛 |
| `npm run bench:collaboration` | 协作调度基准 | 不参与门槛 |

- 独立用例标题直接写 `@core:功能域`，并在 `tests/core-coverage.json` 登记；禁止 `.only`、整组标记或参数化隐藏数量。`test:suite` 会逐条检查，不通过就不算提交完成。
- 当前预算是 1014 个单元与 96 条 Electron 流程。预算只拦失控增长，不要求“加一条先删一条”；新增前先消除重复，确需扩展时说明覆盖并同步预算。
- `test:e2e` 的 `pretest:e2e` 会先跑 `build-for-tests`，需要真实桌面会话与稳定的 2100×1200 物理窗口；有两条用例要管理员权限执行 `icacls`。
- 唯一跳过项是 `packaged-parallel`，它需要现成的打包产物，按设计在常规 E2E 里跳过；跳过不是通过。
- 压缩路径有硬规则：`Session.messages` 永远是完整记录，压缩只写 `RunContext.modelMessages`。新增压缩必须走 `applyModelCompaction`，规划输入必须是模型侧数组；不要让 `planCompaction` 读完整记录。
- 修改单个模块可以先跑对应文件，完成后跑 `npm run verify`；涉及 UI、终端、权限或真实链路时，跑受影响的 E2E。
- 代码统计用 `node scripts/count-code.mjs`，口径是 `wc -l` 换行，排除依赖、产物、文档、图片与媒体夹具。

## 构建

- `electron.vite.config.ts` 里 renderer 固定 `target: esnext` 并用 terser 压缩；main/preload 用 `target: node22` 且按源文件拆 `manualChunks`。
- 原因是 Windows 上 esbuild 0.25 处理超过约 512 KB 的整块 chunk 时会先写临时文件，删除时稳定报 `remove ...: Access is denied`（本机 4 MB 复现，与杀软/临时目录无关）。拆小或跳过整块转译都能绕开，逐模块 TS/TSX 转译不受影响。
- 这不是“关掉压缩”：renderer 仍由 terser 输出压缩产物；main 保持可读，便于崩溃栈定位。

## 持续集成

CI 只承担能在几分钟内跑完的静态与类型门槛，Windows 专属验证留在本地。

- 工作流是 `.github/workflows/quality-gates.yml`，在 push、pull request 与手动触发时运行。
- 它只跑四道：`typecheck`、`audit:ui`、`docs:check`、`test:suite`。安装用 `npm ci`，Node 固定 22.12.0，并设 `MORROW_SKIP_ELECTRON_BINARY=1` 跳过 Electron 运行时下载。
- 跑在 `ubuntu-latest`：这四道都是纯 Node 脚本，与平台无关；实测本仓库账号拿不到 hosted Windows runner（`windows-latest` 长时间排队后被取消，`ubuntu-latest` 45 秒内就绪）。
- L2（`test:unit`、`test:e2e`、`dist:final`、`smoke:packaged`）需要自托管 Windows runner：E2E 依赖 2100×1200 窗口、Git Bash、node-pty 与管理员 `icacls`。当前尚未接入，所以以本地 `npm run verify` 为准。
- `audit:flex` 只在本地 `verify` 链里跑，CI 不含这一步；提交前不要漏掉。
- 文档与截图检查（`docs:check`）在 CI 里跑，所以新增文档或换图必须同步更新引用，否则 PR 会红。

## 文档与截图

文档平铺在 `docs/` 下，截图是真实 Electron 窗口，不是设计稿。

- 正文只写中文，一个主题一个文件，不建子目录。`screens/` 与 `diagrams/` 是素材目录，不放正文。
- 文档集合：`README.md` 是地图，其余按主题分成入门、桌面、创作台、手机、配对、模型、多媒体、参考、排障、架构、开发与验证。跨文档链接只写文件名，不写锚点。
- `npm run docs:capture` 先构建，再用测试模式与内置演示工作区按 2100×1200 抓取，产 27 张，直接写 `docs/screens/`。
- `npm run test:pair-panel` 产 1 张配对面板截图；两条 E2E 顺手截下 2 张设置页（多媒体服务与本地引擎），需要手工搬到 `docs/screens/`。三处合计 30 张，全部 2100×1200。
- `shotDesktop` 用系统 `CopyFromScreen` 抓真实桌面，必须有可交互的登录会话；锁屏、无人值守或远程会话断开时会截到黑屏，不能当作通过。
- `npm run docs:check` 校验：Markdown 链接与锚点存在、图片路径存在、`screens/` 每张必须是 2100×1200 且被至少一篇文档引用、废弃的 `docs/guide` 与 `docs/verification` 目录没有回归。
- 截图统一来自测试模式与内置演示工作区，不含你的数据。创作台截图里的作品是内置样例，图注要写清楚。
- README 封面放 `docs/cover.png`，不要放进 `screens/`，否则会被尺寸检查误判。

## 打包

打包分两步：先构建，再生成两个单文件产物。`dist:final` 把两步串起来。

```powershell
npm run build
npm run dist:final
npm run smoke:packaged
```

- `dist:final` 等于 `npm run build` 加 `node scripts/dist-portable.mjs --two-files`，产物是 `deliver/Morrow-0.2.0-portable.exe` 与 `deliver/Morrow-0.2.0-setup.exe`；交付时另附 `deliver/SHA256SUMS.txt`。
- 打包前 `deliver/` 不能有 `Morrow Data`。如果存在你的数据，先暂存到 `tmp/`，打包后原样恢复，不要把数据打进分发包。
- 便携版是自研单文件启动器：首次运行在 exe 同级解压 `.morrow-runtime-<版本>-<修订>`，之后复用缓存；不依赖 `%TEMP%`，也不写系统目录。
- 安装包是 NSIS 自解压：可选安装目录，创建开始菜单与桌面快捷方式，按 per-machine 安装，默认落在 `Program Files`；安装版数据目录是 `%APPDATA%\Morrow`，可在设置里改。
- 未配置证书时产物 `signed:false`；需要签名时用 `MORROW_SIGN_*` 环境变量提供证书与口令。签名不改变代码，只改变信任链。
- `smoke:packaged` 真实启动便携包，检查 CDP 就绪、窗口标题、界面版本、预加载 API 与首屏文本，并把摘要写进 `docs/smoke-packaged.json`（生成物，不入库）。
- 打包摘要写 `docs/verification.json`，日志与临时截图写 `tmp/verification/`。这两份 JSON 是机器摘要，已列入 `.gitignore`，不替代 [VERIFICATION.md](VERIFICATION.md) 的人工结论。
- 文件夹版、zip 与源码包是中间产物，不进交付目录；`--two-files` 只保留两个 exe。
- 上一轮中断留下的 `app.asar` 占用会让固定中间目录清不空，脚本会改用带时间戳的目录并在结束后清理。

## 第三方组件与许可

仓库是 MIT。运行时依赖随包，构建与测试工具不进运行时，外部引擎与模型由你自行安装。

| 组件 | 用途 | 许可 |
|---|---|---|
| Electron | 桌面运行时 | MIT |
| React、React DOM | 界面 | MIT |
| Zustand | 状态管理 | MIT |
| CodeMirror 6 | 编辑器 | MIT |
| xterm.js、node-pty | 终端与真实 PTY | MIT |
| JSZip | EPUB 与工程包 | MIT 或 GPLv3（按发行版） |
| mammoth | DOCX 读取 | BSD-2-Clause |
| pdf-parse、pdfjs-dist | PDF 读取与预览 | MIT、Apache-2.0 |
| Shiki | 代码高亮 | MIT |
| react-markdown、remark | Markdown 渲染 | MIT |
| Lucide | 图标 | ISC |
| Fontsource 字体 | Manrope、Newsreader、Noto Serif SC、IBM Plex Mono、JetBrains Mono | 各字体 OFL |

- 构建与测试工具（electron-vite、Vite、TypeScript、Vitest、Playwright、electron-builder、diff）只在开发阶段使用，不进入运行时。
- 外部组件不随包：ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg、Qwen3-TTS 模型、音乐服务与各模型 API。Morrow 只连接本机地址或你配置的服务。
- 具体版本以 `package.json` 与 `package-lock.json` 为准；再分发时保留各项目的 LICENSE 文本。

## 内置技能来源

内置技能随应用内嵌，不依赖桌面文件；当前有 20 个，源码在 `src/main/builtin-skills.ts`。

- 按公开的 Agent 技能工作流重写，来源包括 DeepSeek 官方技能与工程实践、Anthropic Agent Skills、Gemini behavioral-evals、OpenAI 官方 Agent 指南，以及各项目公开的测试、重构、安全与文档流程。
- 重写原则：保留可执行的工作流、边界与验收，去掉品牌文案与不可用依赖；不直接复制原文。
- 技能文本随构建进入应用，不从网络拉取；工作区还可以放自己的技能，作用域按工作区隔离。
- 清单与每个技能的一句话说明见 [REFERENCE.md](REFERENCE.md)。

## 提交前检查

提交前至少跑完 `npm run verify`；只改文档时也要跑 `docs:check`。

```powershell
npm run verify
```

等价的分步命令：

```powershell
npm run typecheck
npm run audit:ui
npm run audit:flex
npm run docs:check
npm run test:suite
npm run test:unit
npm run test:e2e
```

- 没有 `.only`、跳过或未登记的独立用例。
- 没有假数据、假额度、占位图或未实现却显示成功的入口。
- 新页面已进 `scripts/docs-capture.spec.ts`，并至少被一篇文档引用。
- 不提交 `src/generated/`、私有提示词、密钥或你的数据；`deliver/Morrow Data` 已暂存并恢复。
- 文档链接、锚点、截图尺寸与引用都能通过 `docs:check`。
- 提交信息用 `type(scope): 说明`，一个提交只做一件事；代码风格是 2 空格缩进、无分号、单引号。