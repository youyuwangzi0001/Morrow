# 贡献指南

## 环境

Windows 10/11 x64、Node.js 22.12+、Git（默认 Git Bash）。可选 PowerShell 7、WSL、ComfyUI、llama.cpp、Ollama、LM Studio、FFmpeg。

```powershell
npm install
npm run dev
```

源码构建依赖构建期生成的提示词包：私有源默认在 `%APPDATA%\Morrow-build\prompts`，可用 `MORROW_PROMPT_SOURCE` 覆盖，`src/generated/` 不入库。缺源时 `npm run build` 会明确失败。完整说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 结构

| 目录 | 内容 |
|---|---|
| `src/main/` | Electron 主进程、窗口、Agent/Session/Studio/媒体/订阅/relay |
| `src/core/` | Agent 循环、Provider、工具、权限、上下文、协作 |
| `src/renderer/` | React 界面、features、样式、store |
| `src/shared/` | IPC/数据契约、共享工具 |
| `src/generated/` | 构建期生成的提示词包，不入库 |
| `tests/unit/` | Vitest 单元；按功能域合并入口 |
| `tests/e2e/` | Playwright Electron 流程 |
| `docs/` | 扁平正文、`screens/` 截图、`diagrams/` 示意图 |
| `scripts/` | 构建、测试、打包、冒烟、截图、文档检查 |

源码按职责扁平放置；不要重新引入多层 `studio/`、`core/agent/` 目录。协作域已合并为 `src/core/collaboration.ts` 与 `src/main/collaboration.ts`；测试辅助平铺为 `tests/unit/helpers.ts`、`tests/e2e/helpers.ts`。

安卓伴侣端的源码、文档与分发包都在独立仓库 [Morrow-Android](https://github.com/youyuwangzi0001/Morrow-Android)（Kotlin/Compose），本仓不含安卓源码，也不再分发 APK。两端只共享协议：改通道常量、帧格式或配对流程时，两个仓库要一起改，并跑一次安卓仓库的 `scripts/e3-desktop-relay.mjs` 确认跨语言仍能握手。

`src/shared/` 里每个模块都必须有生产调用点：只被测试引用的模块是死代码，要么接入真实链路，要么删除。`.mjs` 脚本只保留构建、测试、打包、冒烟、截图与文档检查这些长期职责；一次性验收脚本在结论沉淀为单元测试后删除，不再堆积在 `scripts/`。

## 开发边界

- 创作台不重新引入本地创作手法库、七维权重、六条门禁或固定故事模板；创作判断只来自内嵌三套大师方法，本地只做可计算检查。
- 三套大师方法与提示词基座的运行时来源只有构建期产物 `src/generated/prompts.bundle.ts`；产物与私有源都不进仓库，不要提交明文或可解密的密文。
- 没有真实文本模型/ComfyUI/FFmpeg/TTS 时明确失败；不用占位图、假候选、假额度或本地模板冒充。
- 删除/回收站、数据目录迁移、密钥存储等高风险逻辑必须先看现有测试与边界。
- 手机通道只做局域网 WSS 直连；公网中继目前是占位实现，不要把它写成可用能力。
- 交付只保留两个单文件 exe 与一个 APK；文件夹版/zip/源码包是中间产物。

## 提交前检查

```powershell
npm run typecheck
npm run audit:ui
npm run audit:flex
npm run docs:check
npm run test:suite
npm run test:unit
```

涉及 UI/真实链路时跑受影响的 E2E（`npm run test:e2e` 会先构建）。`npm run verify` 把上面这条链连同 E2E 一次跑完，完整说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

文档改动：

```powershell
npm run docs:check     # 链接、锚点、截图尺寸、每张图是否被引用
npm run docs:capture   # 界面有改动时重拍；产出 docs/screens 下 27 张桌面图
```

`docs:capture` 不覆盖全部截图：配对面板那张由 `npm run test:pair-panel` 产出，另有两张由 E2E 顺手产出后手工搬入 `docs/screens/`。手机截图与示意图不入这条管线，见 [docs/README.md](docs/README.md)。

## 代码风格

- 2 空格缩进、无分号、单引号；TypeScript strict。
- 不引入未使用的依赖或抽象；能复用现有工具就不新增。
- 新功能必须有真实行为与回归保护；不要用占位入口或假成功冒充。
- 提交信息用 `type(scope): 说明`，一个提交只做一件事。

## 提交与 PR

- 先确认改动范围与验证结果；PR 描述写清“为什么”和“怎么验证”。
- 不提交密钥、用户数据、日志原文或打包产物。
- 不在公开 issue 披露安全细节；见 [SECURITY.md](SECURITY.md)。

## 版本与发布

- 版本号只写在 `package.json` 的 `version`；当前发布版本为 `0.2.0`。
- 每个发布版本对应一条发布提交：`release: Morrow vX.Y.Z`，以及 `vX.Y.Z` 分支与标签。
- 发布后的纯文档修订（不改变二进制、源码包与安装行为）单独提交为 `docs: ...`，直接推送到对应版本分支；不改写已发布的提交、标签与 Release 附件。
- 需要替换二进制、重打包或刷新验证证据时，才按发布流程重跑并说明产物变化；不要在文档提交里夹带构建产物。
- 只有升级到新发布版本（如 `0.2.0` → `0.3.0`）时，才新建发布提交、分支与 `vX.Y.Z` 标签。
- 发布流程：

```powershell
npm run dist:final      # 构建 + 两个单文件 exe 到 deliver/，并刷新 docs/verification.json（该文件不入库）
npm run smoke:packaged  # 冒烟打包产物，刷新 docs/smoke-packaged.json（该文件不入库）
npm run docs:capture    # 界面有改动时重拍 docs/screens
git add -A
git commit -m "release: Morrow vX.Y.Z"
git tag vX.Y.Z
git push origin <分支> refs/tags/vX.Y.Z
```

## 文档

文档按任务拆分，一个主题一个文件，平铺在 `docs/` 下；`README.md` 是英文主文件，`README.zh.md` 是中文镜像，两份同序互链。截图放 `docs/screens/`（2100×1200 原图），手机截图放 `docs/screens/mobile/`，示意图放 `docs/diagrams/`，封面是 `docs/cover.png`。新增页时先更新 `scripts/docs-capture.spec.ts`，再写文档引用，最后跑 `npm run docs:check`。整套文档的地图与写作约定见 [docs/README.md](docs/README.md)。

## License

MIT。第三方组件与内置技能来源见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。