# 开发与打包

> 本文为中文文档；英文概览见 [README.md](../README.md)。

本文覆盖开发环境、仓库结构、测试与质量门槛、文档截图、打包和第三方边界。产品行为见 [ARCHITECTURE.md](ARCHITECTURE.md)，操作说明见 [USER-GUIDE.md](USER-GUIDE.md)。

## 目录

- [环境](#环境)
- [仓库结构](#仓库结构)
- [开发边界](#开发边界)
- [测试](#测试)
- [持续集成](#持续集成)
- [文档与截图](#文档与截图)
- [打包](#打包)
- [第三方组件与许可](#第三方组件与许可)
- [内置技能来源](#内置技能来源)
- [提交前检查](#提交前检查)

## 环境

- Windows 10/11 x64；Node.js 22.12+；Git（默认终端使用 Git Bash）。
- 可选：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg。
- 安装依赖：`npm install`；启动开发：`npm run dev`。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `src/main/` | Electron 主进程、窗口、Agent/Session/Studio/媒体/订阅 |
| `src/core/` | Agent 循环、Provider、工具、权限、上下文、协作 |
| `src/renderer/` | React 界面、features、样式、store |
| `src/shared/` | IPC 与数据契约、共享工具 |
| `tests/unit/` | Vitest 单元测试（按功能域合并入口） |
| `tests/e2e/` | Playwright Electron 流程 |
| `docs/` | 文档、封面与 `screens/` 原图 |
| `scripts/` | 构建、测试、打包、冒烟、截图与文档检查 |

源码按职责扁平放置；不要重新引入多层 `studio/`、`core/agent/` 目录。协作域已合并为 `src/core/collaboration.ts` 与 `src/main/collaboration.ts`；测试辅助平铺为 `tests/unit/helpers.ts`、`tests/e2e/helpers.ts`。保留少数分文件的理由见 [ARCHITECTURE.md](ARCHITECTURE.md#为什么保留少数分文件)。

## 开发边界

- 创作台不重新引入本地创作手法库、七维权重、六条门禁或固定故事模板；创作判断只来自内嵌三套大师方法，本地只做可计算检查。
- 三套大师方法的运行时来源只有 `src/main/creative-prompts.generated.ts`；不要恢复桌面读取、`resources/prompts` 或 `MORROW_CREATIVE_PROMPTS`。
- 没有真实文本模型、ComfyUI、ACE-Step、FFmpeg 或 TTS 时明确失败；不要用占位图、假候选、假额度或本地模板冒充。
- 删除与回收站、数据目录迁移、密钥存储等高风险逻辑，先看现有测试与边界。
- 交付只保留两个单文件 exe；文件夹版、zip 与源码包是中间产物。

## 测试

| 命令 | 内容 |
|---|---|
| `npm run test:unit` | 573 项核心单元 |
| `npm run test:e2e` | 先构建，再跑 86 条 Electron 流程 |
| `npm run test:suite` | 41 域覆盖登记、核心标记与数量预算 |
| `npm run verify` | 类型、UI、文档、清单、单元、Electron |
| `npm run smoke:packaged` | 实际启动打包 exe，检查渲染与截图 |

维护规则：

1. 每个独立用例直接使用 `@core:功能域` 标题，并在 `tests/core-coverage.json` 登记；禁止 `.only`、整组标记或用参数化隐藏数量。
2. 优先在现有核心流程补断言；独立的数据安全、权限或主链路行为才新增核心用例。
3. 当前基线 573 单元 / 88 Electron；维护预算 600 / 96，只拦失控增长，不要求“加一条先删一条”。新增前先消除重复，确需扩展时说明覆盖并同步基线。
4. 同一功能域用例合并到单一入口；测试共用辅助平铺，不恢复 `helpers/` 子目录。
5. 修改模块可先跑对应文件，完成后跑 `npm run verify`；涉及 UI 或真实链路时跑受影响的 E2E。
6. 上下文压缩：`Session.messages` 永远是完整记录，压缩只写 `RunContext.modelMessages`。新增压缩路径必须走 `applyModelCompaction`，规划输入必须是模型侧数组；不要让 `planCompaction` 读完整记录，也不要再用「替换数组」的做法（`applyCompaction` 已删除）。

代码统计统一使用 `node scripts/count-code.mjs`（或 `--ref v0.1.0`）：生产 `src/**/*.{ts,tsx,css,html}`、测试、构建脚本与启动器，按 `wc -l` 换行口径，排除依赖、产物、文档、图片与媒体夹具。

## 持续集成

`.github/workflows/quality-gates.yml` 在每次 push / PR 上跑 L1 门槛：`typecheck` → `audit:ui` → `docs:check` → `test:suite`，安装时用 `MORROW_SKIP_ELECTRON_BINARY=1` 跳过约 368MB 的 Electron 运行时下载。运行在 `ubuntu-latest`：这四道门槛都是纯 Node 脚本，与平台无关；实测本仓库账号拿不到 hosted Windows runner（`windows-latest` 长时间排队后被取消，`ubuntu-latest` 45 秒内就绪）。

L2（`test:unit`、`test:e2e`、`dist:final`、`smoke:packaged`）需要自托管 Windows runner：E2E 等主窗口稳定在 2100×1200 物理像素，并有两条用例要管理员权限执行 `icacls`。未接入前以本地 `npm run verify` 为准。

## 文档与截图

```text
README.md                英文主文件
README.zh.md             中文镜像
CHANGELOG.md             双语版本记录
CONTRIBUTING.md          协作约定
SECURITY.md              安全边界
docs/
  README.md              文档地图
  GETTING-STARTED.md     首次使用
  USER-GUIDE.md          日常操作
  STUDIO.md              创作台
  MODELS.md              模型与订阅
  MEDIA.md               多媒体与引擎
  REFERENCE.md           快捷键、路径、变量、技能
  TROUBLESHOOTING.md     排障
  ARCHITECTURE.md        架构
  DEVELOPMENT.md         开发与打包
  VERIFICATION.md        交付证据
  cover.png              README 封面
  screens/*.png          2100×1200 文档截图
  verification.json      打包摘要（脚本生成）
  smoke-packaged.json    冒烟摘要（脚本生成）
  evidence/              机器证据
  planning/              未来版本规划
```

- `npm run docs:capture`：先构建，再用测试模式启动应用，按默认 2100×1200 物理窗口重拍全部文档截图，直接写 `docs/screens/`；不缩放、不压缩。
- `npm run docs:check`：检查 Markdown 链接与锚点、每张截图必须 2100×1200 且被文档引用、`docs/guide` 与 `docs/verification` 不重新出现；覆盖根 README / README.zh / CHANGELOG / CONTRIBUTING / SECURITY 与 `docs/*.md`，共 16 个 Markdown。
- 截图脚本：`scripts/docs-capture.spec.ts` + `playwright.docs.config.ts`；它不属于核心测试套组，不计入 `npm run test:e2e` 的数量。
- 新增界面页时，先在 `docs-capture.spec.ts` 增加稳定状态，再写文档引用；不要把临时测试截图放进 `docs/screens`。
- README 的封面放在 `docs/cover.png`，不进入 `screens/`，避免被截图尺寸检查误判。

## 打包

```powershell
npm run build
npm run dist:final
npm run smoke:packaged
```

`dist:final` 等于 `npm run build` 加 `node scripts/dist-portable.mjs --two-files`，产物：

- `deliver/Morrow-0.2.0-portable.exe`
- `deliver/Morrow-0.2.0-setup.exe`

注意：

- `--two-files` 要求 `deliver/` 不含 `Morrow Data`。如果存在用户数据，先暂存到 `tmp/`，打包后原样恢复；不要把用户数据打进分发包。
- 在 Morrow 自己的沙箱里也能直接打包：`winCodeSign` 含 macOS 符号链接、`7za` 无权创建时会复用系统已解压的缓存；Low 完整性无法把产物提升为 Medium 时会跳过并告警，需要 Medium 标签时在 Morrow 外重跑。
- 上一轮中断留下的 `app.asar` 占用会让固定中间目录无法清空，脚本会改用带时间戳的独立目录并在结束后清理。
- 便携版首次运行在 exe 同级解压 `.morrow-runtime-0.2.0-<修订>`；安装版数据在 `%APPDATA%\Morrow`。
- 未配置证书时产物 `signed:false`；可用 `MORROW_SIGN_*` 与 `MORROW_SIGN_AUTO=1` 配置签名。
- 打包摘要写 `docs/verification.json`，冒烟摘要写 `docs/smoke-packaged.json`；日志与临时截图写 `tmp/verification/`。

## 第三方组件与许可

### 运行时依赖

| 组件 | 用途 | 许可 |
|---|---|---|
| Electron | 桌面运行时 | MIT |
| React / React DOM | 界面 | MIT |
| Zustand | 状态 | MIT |
| CodeMirror 6 | 编辑器 | MIT |
| xterm.js | 终端 | MIT |
| node-pty | 真实 PTY | MIT |
| JSZip | EPUB/工程包 | MIT 或 GPLv3（按发行版） |
| mammoth | DOCX 读取 | BSD-2-Clause |
| pdf-parse / pdfjs-dist | PDF 读取与预览 | MIT / Apache-2.0 |
| Shiki | 代码高亮 | MIT |
| react-markdown / remark | Markdown | MIT |
| Lucide | 图标 | ISC |
| Fontsource 字体 | Manrope / Newsreader / Noto Serif SC / IBM Plex Mono / JetBrains Mono | 各字体 OFL |

以各项目仓库的 LICENSE 为准；交付包只包含运行时需要的文件。

### 构建与测试工具

electron-vite、Vite、TypeScript、Vitest、Playwright、electron-builder、diff 等只在开发/构建阶段使用，不进入用户运行时。

### 外部组件（不随包）

ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg、Qwen3-TTS、ACE-Step、Windows SAPI 与各模型服务由用户自行安装或授权。Morrow 只连接本机地址或用户配置的 API，不内置这些程序或模型。

## 内置技能来源

`src/main/builtin-skills.ts` 当前 `BUILTIN_SKILLS_VERSION = 12`，共 20 个技能。技能按官方 Agent 技能库的工作流重写，不直接复制原文：

- DeepSeek 官方技能与工程实践；
- Anthropic Agent Skills 与 webapp-testing；
- Gemini behavioral-evals 与研究流程；
- OpenAI 官方 Agent 指南；
- 各项目公开的测试、重构、安全与文档工作流。

重写原则：保留可执行的工作流、边界与验收，去掉品牌文案与不可用依赖；技能文本随应用内嵌，不依赖桌面文件。清单与用途见 [REFERENCE.md](REFERENCE.md#内置技能)。

## 提交前检查

```powershell
npm run typecheck
npm run audit:ui
npm run docs:check
npm run test:suite
npm run test:unit
```

涉及 UI 或真实链路：

```powershell
npm run test:e2e
# 或按文件/标题定向
npx playwright test tests/e2e/studio.spec.ts -g "studio"
```

提交前确认：

- [ ] 没有 `.only`、跳过或未登记的独立用例。
- [ ] 没有假数据、假额度、占位图或未实现却显示成功的入口。
- [ ] 文档链接、锚点与截图尺寸通过 `docs:check`。
- [ ] 打包前 `deliver/Morrow Data` 已暂存并恢复。
- [ ] 敏感文件、密钥与用户数据未进入提交。

提交信息用 `type(scope): 说明`，一个提交只做一件事。代码风格：2 空格缩进、无分号、单引号；不引入未使用的依赖或抽象。

未来版本规划见 [planning/v0.3.0-plan.html](planning/v0.3.0-plan.html)（HTML，仅在需要开发交接时打开）。