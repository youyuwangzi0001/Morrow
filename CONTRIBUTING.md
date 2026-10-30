# 贡献指南

## 1. 开发环境

- Windows 10/11 x64；Node.js 22+；Git（默认终端使用 Git Bash）。
- 可选：PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg。
- 安装依赖：

```powershell
npm install
```

- 开发运行：

```powershell
npm run dev
```

## 2. 目录

| 目录 | 内容 |
|---|---|
| `src/main/` | Electron 主进程、窗口、Agent/Session/Studio/媒体/订阅 |
| `src/core/` | Agent 循环、Provider、工具、权限、上下文 |
| `src/renderer/` | React 界面、features、样式、store |
| `src/shared/` | IPC/数据契约、共享工具 |
| `tests/unit/` | Vitest 单元测试 |
| `tests/e2e/` | Playwright Electron E2E |
| `scripts/` | 构建、打包、冒烟、提示词内嵌、空行清理 |
| `docs/` | 架构、创作台、模型、设计、安全、用户指南 |

源码按职责扁平放置；不要重新引入多层 `studio/`、`core/agent/` 目录。

![真实终端](docs/guide/screens/10-terminal-dark.png)

## 3. 开发边界

- 创作台不重新引入本地创作手法库、七维权重、六条门禁或固定故事模板。创作判断只来自内嵌三套大师方法；本地只做可计算检查。
- 三套大师方法的运行时来源只有 `src/main/creative-prompts.generated.ts`；不要恢复桌面读取、`resources/prompts` 或 `MORROW_CREATIVE_PROMPTS`。
- 没有真实文本模型/ComfyUI/ACE-Step/FFmpeg/TTS 时明确失败；不要用占位图、假候选、假额度或本地模板冒充。
- 删除/回收站、数据目录迁移、密钥存储等高风险逻辑必须先看现有测试与边界。
- 交付只保留两个单文件 exe；文件夹版/zip/源码包是中间产物。

## 4. 提交前检查

```powershell
npm run typecheck
npm run audit:ui
npm run test:suite
npm run test:unit
```

仓库只保留核心回归，`test:unit` 直接运行全部现存单元用例。改动模块可单独运行对应文件；涉及 UI/真实链路时跑受影响的 E2E：

```powershell
npx vitest run tests/unit/studio-intent.test.ts
npm run build
npx playwright test tests/e2e/studio.spec.ts -g "35-studio-collaborator"
```

发布前运行全部核心检查与打包冒烟：

```powershell
npm run verify
npm run dist:final
npm run smoke:packaged
```

- `typecheck` 必须 0 错误。
- `audit:ui` 必须 0 裸排版值。
- 单元测试必须全绿；失败的测试先查根因，不要跳过。
- 核心功能用例使用 `@core:功能域` 标记，并登记到 `tests/core-coverage.json`。只保留这一套用例，登记检查会拒绝无标记用例及额外测试入口；数量预算与覆盖矩阵见 [测试说明](docs/TESTING.md)。
- 打包后的便携 exe 必须能启动、渲染、截图；安装包用 electron-builder 的完整性检查。

## 5. 代码风格

- TypeScript strict；优先纯函数与小模块，避免隐式 any。
- 命名用完整英文单词；用户可见文案用中文白话。
- 颜色/字号/间距/圆角/分隔线必须走 token；新增裸值先加 token。
- 全应用禁用斜体；正文/按钮/表单 ≥12px。
- 注释只解释“为什么”，不复述“做了什么”；不要写多段注释块。
- 连续空行最多一个；提交前可跑 `node scripts/trim-blank-lines.mjs` 检查。

## 6. 提交与 PR

- 一个提交只做一件事；提交信息写“为什么”，不要写文件清单。
- 不提交 `node_modules`、`out`、`release`、`tmp`、`test-results`、`deliver` 旧产物、用户数据或密钥。
- PR 说明包含：改动范围、验证命令、真实 UI/打包证据、已知边界。
- 不绕过 hooks/签名；不 force push 主分支。

## 7. 安全

- 不把 API Key、订阅 token、用户作品、日志原文贴进 issue/PR/截图。
- 权限、路径、网络、MCP、网页读取的改动必须补测试。
- 安全问题走私密渠道，见 [SECURITY.md](SECURITY.md)。

## 8. License

MIT。提交即同意按 MIT 分发；新增第三方代码/素材必须更新 [第三方许可清单](docs/THIRD-PARTY-LICENSES.md)。

## 9. 文档

- 用户可见行为变化同步更新 [用户指南](docs/USER-GUIDE.md) 与 [创作台](docs/STUDIO.md)。
- 架构/契约变化同步更新 [架构说明](docs/ARCHITECTURE.md) 与 [底层提示词与质检](docs/QUALITY-FRAMEWORK.md)。
- 发布前更新 [验收记录](docs/verification/VERIFICATION.md) 与交付哈希。
- 文档只写当前实现；删除过时结论，不保留“历史曾经”式段落（除非明确标注为历史）。
