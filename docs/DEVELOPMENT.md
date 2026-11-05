# Morrow 开发与质量

本文覆盖开发环境、扁平仓库结构、测试、文档截图、打包与第三方边界。产品行为见 [ARCHITECTURE.md](ARCHITECTURE.md)，操作说明见 [GUIDE.md](GUIDE.md)。

## 1. 环境

- Windows 10/11 x64；Node.js 22+；Git（默认终端使用 Git Bash）。
- 可选：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg。
- 安装：`npm install`；开发：`npm run dev`。

## 2. 仓库结构

| 目录 | 内容 |
|---|---|
| `src/main/` | Electron 主进程、窗口、Agent/Session/Studio/媒体/订阅 |
| `src/core/` | Agent 循环、Provider、工具、权限、上下文、协作 |
| `src/renderer/` | React 界面、features、样式、store |
| `src/shared/` | IPC/数据契约、共享工具 |
| `tests/unit/` | Vitest 单元测试（按功能域合并入口） |
| `tests/e2e/` | Playwright Electron 流程 |
| `docs/` | 扁平文档与 `screens/` 原图 |
| `scripts/` | 构建、测试、打包、冒烟、截图、文档检查 |

源码按职责扁平放置；不要重新引入多层 `studio/`、`core/agent/` 目录。协作域已合并为 `src/core/collaboration.ts` 与 `src/main/collaboration.ts`；测试辅助平铺为 `tests/unit/helpers.ts`、`tests/e2e/helpers.ts`。保留 `feature-ipc`、`*-core.ts` 与 `workspace-isolation` 的理由见 [ARCHITECTURE.md](ARCHITECTURE.md#为什么保留少数分文件)。

## 3. 开发边界

- 创作台不重新引入本地创作手法库、七维权重、六条门禁或固定故事模板；创作判断只来自内嵌三套大师方法，本地只做可计算检查。
- 三套大师方法的运行时来源只有 `src/main/creative-prompts.generated.ts`；不要恢复桌面读取、`resources/prompts` 或 `MORROW_CREATIVE_PROMPTS`。
- 没有真实文本模型/ComfyUI/ACE-Step/FFmpeg/TTS 时明确失败；不要用占位图、假候选、假额度或本地模板冒充。
- 删除/回收站、数据目录迁移、密钥存储等高风险逻辑必须先看现有测试与边界。
- 交付只保留两个单文件 exe；文件夹版/zip/源码包是中间产物。

## 4. 测试

| 命令 | 内容 |
|---|---|
| `npm run test:unit` | 494 项核心单元 |
| `npm run test:e2e` | 先构建，再跑 82 条 Electron 流程 |
| `npm run test:suite` | 41 域覆盖登记、核心标记与数量预算 |
| `npm run verify` | 类型、UI、文档、清单、单元、Electron |
| `npm run smoke:packaged` | 实际启动打包 exe，检查渲染与截图 |

维护规则：

1. 每个独立用例直接使用 `@core:功能域` 标题，并在 `tests/core-coverage.json` 登记；禁止 `.only`、整组标记或用参数化隐藏数量。
2. 优先在现有核心流程补断言；独立的数据安全、权限或主链路行为才新增核心用例。
3. 当前预算 494 单元 / 82 Electron；新增前先消除重复，确需扩展时说明覆盖并同步预算。
4. 同一功能域用例合并到单一入口；测试共用辅助平铺，不恢复 `helpers/` 子目录。
5. 修改模块可先跑对应文件，完成后跑 `npm run verify`；涉及 UI/真实链路时跑受影响的 E2E。

测试截图写 `tmp/e2e-screens`，不进入文档；文档截图单独生成。

代码统计统一使用 `node scripts/count-code.mjs`（或 `--ref v0.1.0`）：生产 `src/**/*.{ts,tsx,css,html}`、测试、构建脚本与启动器，按 `wc -l` 换行口径，排除依赖、产物、文档、图片与媒体夹具。

## 5. 文档与截图

文档采用扁平结构：

```text
README.md
CONTRIBUTING.md
SECURITY.md
docs/GUIDE.md
docs/STUDIO.md
docs/REFERENCE.md
docs/ARCHITECTURE.md
docs/DEVELOPMENT.md
docs/VERIFICATION.md
docs/verification.json
docs/smoke-packaged.json
docs/screens/*.png
```

- `npm run docs:capture`：先构建，再用测试模式启动应用，按默认 2100×1200 物理窗口重拍全部文档截图，直接写 `docs/screens/`；不缩放、不压缩。
- `npm run docs:check`：检查图片链接、每张截图必须 2100×1200、每张截图都被文档引用、废弃的 `docs/guide` / `docs/verification` 不重新出现。
- 截图脚本：`scripts/docs-capture.spec.ts` + `playwright.docs.config.ts`；它不属于核心测试套组，不会进入 `npm run test:e2e` 的数量。
- 新增界面页时：先在 `docs-capture.spec.ts` 增加稳定状态，再写文档引用；不要把临时测试截图放进 `docs/screens`。
- 旧文档与历史证据已归档到 `.qoder/internal/verification/archive-2026-11-02/`（本机，不进入仓库）。

## 6. 打包

```powershell
npm run build
npm run dist:final
npm run smoke:packaged
```

`dist:final` = `npm run build` + `node scripts/dist-portable.mjs --two-files`，产物：

- `deliver/Morrow-0.2.0-portable.exe`
- `deliver/Morrow-0.2.0-setup.exe`

注意：

- `--two-files` 要求 `deliver/` 不含 `Morrow Data`。如果存在用户数据，先暂存到 `tmp/`，打包后原样恢复；不要把用户数据打进分发包。
- 便携版首次运行在 exe 同级解压 `.morrow-runtime-0.2.0-<修订>`；安装版数据在 `%APPDATA%\Morrow`。
- 未配置证书时产物 `signed:false`；可用 `MORROW_SIGN_PFX` / `MORROW_SIGN_THUMBPRINT` / `MORROW_SIGN_SUBJECT` / `MORROW_SIGN_AUTO=1` 配置签名。
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

ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg、Qwen3-TTS、ACE-Step、Windows SAPI 与各模型服务由用户自行安装/授权。Morrow 只连接本机地址或用户配置的 API，不内置这些程序或模型。

## 内置技能来源

`src/main/builtin-skills.ts` 当前 `BUILTIN_SKILLS_VERSION = 12`，共 20 个技能。技能按官方 Agent 技能库的工作流重写，不直接复制原文：

- DeepSeek 官方技能/工程实践；
- Anthropic Agent Skills 与 webapp-testing；
- Gemini behavioral-evals / 研究流程；
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

涉及 UI/真实链路：

```powershell
npm run test:e2e
# 或按文件/标题定向
npx playwright test tests/e2e/studio.spec.ts -g "studio"
```

提交前确认：

- [ ] 没有 `.only`、跳过或未登记的独立用例。
- [ ] 没有假数据、假额度、占位图或未实现却显示成功的入口。
- [ ] 文档与截图尺寸通过 `docs:check`。
- [ ] 打包前 `deliver/Morrow Data` 已暂存并恢复。
- [ ] 敏感文件、密钥与用户数据未进入提交。

提交信息用 `type(scope): 说明`，一个提交只做一件事。代码风格：2 空格缩进、无分号、单引号；不引入未使用的依赖或抽象。
