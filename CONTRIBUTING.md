# 贡献指南

感谢参与 Morrow。提交前请先理解边界：这是本地桌面 Agent，任何新增能力都必须遵守工作区、权限与密钥边界。

## 1. 开发环境

- Windows 10/11 x64
- Node.js 22+
- Git（默认终端使用 Git Bash）
- 可选：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、ffmpeg

```powershell
npm install
npm run dev
```

构建产物：

```powershell
npm run build
npm start
```

## 2. 目录

```text
src/main/        Electron 主进程、服务、IPC
src/core/        Agent 循环、工具、权限、Provider
src/preload/     白名单 contextBridge
src/renderer/    React UI 与 Zustand store
src/shared/      共享类型、模型、命令、协议常量
tests/unit/      Vitest
tests/e2e/       Playwright 真实 Electron
docs/            用户/架构/设计/验收文档
scripts/         构建、打包、截图、审计
build/           图标、启动器、安装器资源
```

## 3. 开发边界

- 文件工具、终端、媒体输入输出必须在工作区内；新增路径 API 要 realpath 校验。
- 渲染层不能直接访问 Node/fs/child_process；通过 preload 白名单与 `Result<T>` IPC。
- 密钥只进主进程加密存储；不要在日志、错误、渲染层或测试快照中出现明文。
- 新增工具必须声明权限/风险/大小限制，并补单元测试；高风险操作走审批。
- 不要为“让测试绿”而放宽路径、权限、网络或密钥边界。
- 不要提交 `deliver/`、`tmp/`、构建产物、用户数据或真实 token。

## 4. 提交前检查

```powershell
npm run typecheck
npm run audit:ui
npm run test:unit
```

UI/桌面行为改动请跑受影响 E2E；发布前再跑全量：

```powershell
npx playwright test
npm run dist:all
npx playwright test tests/e2e/13-packaged.spec.ts
```

## 5. 代码风格

- TypeScript strict；共享类型优先；避免 `any` 和无意义抽象。
- 注释只解释“为什么/隐藏约束”，不复述代码；不要写多段 docstring。
- UI 只引用顶层 token；新增字号/圆角/颜色先加到 tokens，再改组件。
- 视觉改动同时检查深/浅主题与窄屏。
- 一个 PR 聚焦一个边界清晰的问题；不要混入无关格式化。

## 6. 提交与 PR

- 提交信息用祈使句，说明“为什么/影响”，例如 `fix: 修正终端滚动条按需显示`。
- PR 描述包含：问题、方案、测试证据、风险/回滚。
- 涉及 UI 的 PR 附截图；涉及协议/模型的 PR 附真实或 mock 断言。
- 不要 force-push 已发布分支，不要修改 Git 配置或跳过 hooks。

## 7. 安全

- 发现漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。
- 不要提交或打印 Antigravity OAuth secret；该凭据需通过 `MORROW_ANTIGRAVITY_CLIENT_SECRET` 注入。
- 不要在 issue/PR 中粘贴真实 API Key、订阅 token、工作区隐私内容。

## 8. License

贡献即同意以 MIT License 发布。见 [LICENSE](LICENSE)。
