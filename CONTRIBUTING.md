# Contributing to Morrow

感谢你愿意参与 Morrow。这个项目面向真实桌面场景：文件、命令、模型、媒体与权限都在本机发生，因此我们优先考虑 **可复现、可验证、可回退** 的改动。

## 开发环境

- Windows 10/11 x64
- Node.js 22+ / npm
- 可选：NVIDIA 显卡、ComfyUI、ffmpeg（仅本地多媒体功能）；llama.cpp / Ollama / LM Studio（仅本地模型）

```bash
npm ci
npm run dev
```

## 提交前检查

```bash
npm run typecheck
npm run audit:ui
npm run test:unit
npm run test:e2e
```

- `typecheck` 与 `audit:ui` 必须通过。
- 单元测试按 `tests/unit` 的领域套件组织（当前 13 个）；新增测试请并入对应套件并保留原文件的独立 `describe`，不要新增散落的 spec 文件。
- E2E 按设置、聊天、模式、文件、媒体等领域组织（当前 17 个）；小型 UI 契约优先并入同域 spec。
- 涉及交互、持久化、权限、媒体或 Agent 行为的改动，请补充/更新 E2E。
- 真实引擎、真实本地模型、打包与平台条件用例默认跳过；在 PR 中注明哪些可选测试未运行及原因。

## 代码边界

- `src/core/` 保持纯 TypeScript，不引入 Electron/React。
- 渲染层只通过 preload 暴露的窄 API 访问主进程；不要在 `src/renderer` 直接使用 Node 或密钥。
- 文件路径必须经过工作区边界校验；外部动作、MCP、浏览器与 computer-use 走权限审批。
- 优先复用现有 Provider、工具、UI 组件与 IPC 注册方式，避免为单一场景新增平行抽象。
- 目录保持扁平：`services`、`features`、`components`、`tools` 单层平铺；小模块优先并入语义内聚的邻近模块。

## 提交与 PR

1. 一个 PR 聚焦一个问题；说明背景、改动、验证方式与已知限制。
2. UI 改动附浅色/深色截图；行为改动附关键日志或测试输出。
3. 不提交 API Key、`Morrow Data`、`deliver/`、`tmp/`、`test-results/`、日志或截图缓存。
4. 遵循现有提交信息风格，保持历史可读。

## 安全

- 不要在 Issue/PR 中粘贴真实 API Key、邮箱、用户文件或会话内容。
- 发现越界访问、命令注入、隐私泄漏、权限绕过等问题时，请先私下联系维护者，不要公开利用细节。
- 安全相关改动必须附带回归测试，并说明误伤范围。

## License

提交贡献即表示同意以 MIT License 发布。
