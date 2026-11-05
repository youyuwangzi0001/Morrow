# 贡献指南

## 环境

Windows 10/11 x64、Node.js 22+、Git（默认 Git Bash）。可选 PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg。

```powershell
npm install
npm run dev
```

详细说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 结构

| 目录 | 内容 |
|---|---|
| `src/main/` | Electron 主进程、窗口、Agent/Session/Studio/媒体/订阅 |
| `src/core/` | Agent 循环、Provider、工具、权限、上下文、协作 |
| `src/renderer/` | React 界面、features、样式、store |
| `src/shared/` | IPC/数据契约、共享工具 |
| `tests/unit/` | Vitest 单元；按功能域合并入口 |
| `tests/e2e/` | Playwright Electron 流程 |
| `docs/` | 扁平文档与 `screens/` 原图 |
| `scripts/` | 构建、测试、打包、冒烟、截图、文档检查 |

源码按职责扁平放置；不要重新引入多层 `studio/`、`core/agent/` 目录。协作域已合并为 `src/core/collaboration.ts` 与 `src/main/collaboration.ts`；测试辅助平铺为 `tests/unit/helpers.ts`、`tests/e2e/helpers.ts`。

## 开发边界

- 创作台不重新引入本地创作手法库、七维权重、六条门禁或固定故事模板；创作判断只来自内嵌三套大师方法，本地只做可计算检查。
- 三套大师方法的运行时来源只有 `src/main/creative-prompts.generated.ts`；不要恢复桌面读取、`resources/prompts` 或 `MORROW_CREATIVE_PROMPTS`。
- 没有真实文本模型/ComfyUI/ACE-Step/FFmpeg/TTS 时明确失败；不用占位图、假候选、假额度或本地模板冒充。
- 删除/回收站、数据目录迁移、密钥存储等高风险逻辑必须先看现有测试与边界。
- 交付只保留两个单文件 exe；文件夹版/zip/源码包是中间产物。

## 提交前检查

```powershell
npm run typecheck
npm run audit:ui
npm run docs:check
npm run test:suite
npm run test:unit
```

涉及 UI/真实链路时跑受影响的 E2E；完整门槛见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#提交前检查)。

文档改动：

```powershell
npm run docs:capture   # 重拍 docs/screens，全部 2100×1200 原图
npm run docs:check     # 链接、尺寸、引用与废弃目录
```

## 代码风格

- 2 空格缩进、无分号、单引号；TypeScript strict。
- 不引入未使用的依赖或抽象；能复用现有工具就不新增。
- 新功能必须有真实行为与回归保护；不要用占位入口或假成功冒充。
- 提交信息用 `type(scope): 说明`，一个提交只做一件事。

## 提交与 PR

- 先确认改动范围与验证结果；PR 描述写清“为什么”和“怎么验证”。
- 不提交密钥、用户数据、日志原文或打包产物。
- 不在公开 issue 披露安全细节；见 [SECURITY.md](SECURITY.md)。

## 文档

文档采用扁平结构，一个主题一个文件；截图放 `docs/screens/`，全部 2100×1200 原图。新增页时先更新 `scripts/docs-capture.spec.ts`，再写文档引用，最后跑 `npm run docs:check`。

## License

MIT。第三方组件与内置技能来源见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#第三方组件与许可)。
