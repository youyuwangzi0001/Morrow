# 开发指南

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页面向要修改 Morrow 的人：环境怎么装、脚本各自做什么、测试与质量门槛怎么跑、安装包怎么产出、UI 改动要遵守什么契约。它不解释产品功能，架构见 [架构说明](ARCHITECTURE.md)，交付证据见 [交付验证](VERIFICATION.md)。

## 目录

- [环境准备](#环境准备)
- [脚本](#脚本)
- [测试分层](#测试分层)
- [质量门槛与评测](#质量门槛与评测)
- [打包与交付](#打包与交付)
- [UI 契约](#ui-契约)
- [代码与提交约定](#代码与提交约定)
- [许可证](#许可证)

## 环境准备

- Windows 10/11 x64
- Node.js 22 或更新版本。`package.json` 没有声明 `engines` 字段，这里沿用现有开发基线；版本过低时 `electron-vite` 会直接报错。
- npm（仓库带 `package-lock.json`）
- Git，推荐同时安装 Git Bash：它也是终端面板的默认 Shell
- 可选：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、ffmpeg

```powershell
npm install
npm run dev
```

`postinstall` 会执行 `scripts/ensure-electron.mjs`，按需准备 Electron 运行时。构建产物用 `npm run build` 生成，`npm run preview` 启动构建后的应用；仓库没有 `npm start` 脚本。

## 脚本

| 脚本 | 作用 |
|---|---|
| `npm run dev` | electron-vite 开发模式，带热更新 |
| `npm run preview` | 启动已构建的产物 |
| `npm run build` | `typecheck` + `electron-vite build` |
| `npm run typecheck` | 主进程与渲染层各跑一次 `tsc --noEmit` |
| `npm run audit:ui` | 扫描 CSS / TSX 中的裸排版值，检查是否绕过设计 token |
| `npm run test:unit` | Vitest 单元测试 |
| `npm run test:e2e` | Playwright 启动真实 Electron 的端到端测试 |
| `npm run test:eval` | 只跑 Agent 质量评测用例（Mock Provider） |
| `npm run test:mock` | 用 `node --test` 验证 Mock LLM fixture |
| `npm run probe:live` | 真实账号与真实模型的探测脚本，按需手动执行 |
| `npm run dist` | 构建并产出单文件便携版 |
| `npm run dist:all` | 构建并产出便携版与 NSIS 安装包 |
| `npm run dist:dir` | 只产出未打包目录，便于排查 |
| `npm run smoke:packaged` | 对已产出的便携包做冒烟启动 |
| `npm run pack:source` | 从当前提交生成源码包 |
| `npm run verify` | `typecheck` → `audit:ui` → `test:unit` → `test:e2e` |

真实账号、真实本地模型与 ComfyUI 相关用例依赖环境变量与本机资源，默认 skip；不要为了“全绿”把它们改成 mock 通过。

## 测试分层

| 层 | 技术 | 验证什么 |
|---|---|---|
| 静态 | TypeScript、`audit:ui` | 编译错误、裸排版值、设计 token |
| 单元 | Vitest | 协议、工具、权限、上下文、持久化、模型映射 |
| E2E | Playwright `_electron` | 真实窗口、IPC、终端、浏览器、画布、设置与用户旅程 |
| 打包冒烟 | Playwright + 便携包 | 解压启动、PTY、文档工具、原生浏览器、双数据目录 |
| 真账号与真引擎 | 手动或条件测试 | 登录、真实模型调用、Qoder 模型目录、媒体生成 |

测试在临时数据目录中运行，避免污染用户数据。涉及界面截图时，图由 E2E 在真实窗口中生成并写入 `docs/guide/screens/`，来源记录在 `manifest.json`；不要手工替换或重绘。

## 质量门槛与评测

提交前至少执行：

```powershell
npm run typecheck
npm run audit:ui
npm run test:unit
```

涉及 UI 或桌面行为时补跑受影响的 E2E；发布前再跑全量：

```powershell
npx playwright test
npm run dist:all
npx playwright test tests/e2e/13-packaged.spec.ts
```

Agent 质量评测是离线确定性套件（`npm run test:eval`，Mock Provider），四项指标：

| 指标 | 含义 | 本版记录 |
|---|---|---|
| TSR@1 | 工具调用首次成功率 | 8 个任务首次成功 8/8；3 个重试任务成功 3/3 |
| LDR | 长任务上下文漂移率 | 60 轮、3 次压缩、24 个事实检查，违规 0 |
| CKR | 压缩后关键决定保留率 | 2 个场景、预期保留 10 项、实际 10 项 |
| TSS | Token 曲线斜率 | 80 轮、压缩 12 次，基线斜率 494，管理后 −0.04 |

综合记录为 100/100，结果文件是 [`verification/eval-results.json`](verification/eval-results.json)。这是确定性 Mock 测试的结论，不等同于任意真实模型的表现；真实模型仍需按任务验收。

## 打包与交付

```powershell
npm run build
npm run dist:all       # 便携版 + 安装包
npm run pack:source    # 源码包
npm run smoke:packaged # 对便携包冒烟
```

- 便携版由自研启动器把应用 zip 嵌进单个 exe，首次运行解压到 exe 同级的 `.morrow-runtime-<version>-<revision>`，之后启动更快。产物名由 `electron-builder` 的 `artifactName` 决定，本版是 `Morrow-0.1.0-portable.exe`。
- 安装包使用 NSIS，`oneClick: false`、按当前用户安装、允许修改安装目录，并创建开始菜单与桌面快捷方式；产物名是 `Morrow-0.1.0-setup.exe`。
- 源码包由 `scripts/pack-source.mjs` 从当前提交生成，最终哈希以 Release 侧车 `.sha256` 为准。
- 当前未配置代码签名（`MORROW_SIGN_PFX` / `MORROW_SIGN_THUMBPRINT` / `MORROW_SIGN_SUBJECT` / `MORROW_SIGN_AUTO` 未启用），两个 exe 都是 `signed: false`。打包脚本会记录签名状态与产物哈希。
- 打包缓存、Electron 缓存与临时解包目录放在可清理的目录；`deliver/` 只保留当前分发文件、源码包与用户数据，不进入 Git。

## UI 契约

- 视觉 token 在 `tokens.css`：颜色、字号、字重、行高、圆角、间距、阴影都必须引用 token。`npm run audit:ui` 会扫描裸排版值，文档预览 iframe 有白名单。
- 两套主题共用语义 token，通过 `data-theme="light"` 切换；改视觉时同时检查深色、浅色与窄屏。
- UI 字体是 Manrope，展示字体是 Newsreader，代码字体默认 JetBrains Mono（可选 IBM Plex Mono / 系统等宽）。正文与按钮不低于 12px，9–11px 只用于元信息。
- 页签、开关、chip、滚动条、权限卡与订阅详情使用组件级语义 token；不要在每个组件里另造一套数值。
- 所有交互元素需要 hover、focus-visible、disabled 三态，键盘可达；状态不能只靠颜色表达。
- 图标统一 `stroke-width: 1.5`，不单独承载关键动作。

## 代码与提交约定

- TypeScript strict；共享类型放 `src/shared`；避免 `any` 与无意义抽象。
- 渲染层不能直接访问 Node、`fs` 或 `child_process`；新增能力走 preload 白名单与 `Result<T>` IPC。
- 新增工具必须声明权限、风险与大小限制，并补单元测试；高风险动作走审批。
- 不要为了测试通过而放宽路径、权限、网络或密钥边界。
- 提交信息用祈使句，说明“为什么 / 影响”；一个提交聚焦一个边界清晰的问题。
- 不提交 `deliver/`、`tmp/`、构建产物、用户数据或真实 token；不 force-push 已发布分支。

## 许可证

MIT。贡献即同意以 MIT 发布，见 [LICENSE](../LICENSE)。安全问题按 [SECURITY.md](../SECURITY.md) 私下报告，不要开公开 issue 披露未修复漏洞。