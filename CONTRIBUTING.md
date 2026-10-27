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

## 9. 注释与文档

### 1. 评估口径

扫描范围：`src/` 下全部 `.ts` / `.tsx`（不含 `.d.ts`），共 **334 个文件**。
统计口径：以行首块注释、行注释计为注释行；不把字符串与正则中的 `//` 当成注释。

| 指标 | 精简前 | 精简后 |
|---|---:|---:|
| 源码行数 | 152,566 | 151,517 |
| 注释行 | 5,723 | 4,923 |
| 注释占比 | 3.8% | **3.25%** |
| 有效代码占比 | 96.2% | **96.75%** |

共修改 **186 个文件**，压缩 **80 个模块头**，删除 **99 条纯 `// ignore`/`// 忽略` 行**，并清理装饰性分隔线与重复空行。

### 2. 保留规则（不精简）

以下注释直接承载行为或安全约束，全部保留：

- 权限、越界、沙箱、密钥、隐私、SSRF、CSP、外部动作等安全边界；
- 原子写、幂等、并发、恢复、回退、损坏处理等不变量；
- Windows / Electron / FFmpeg / ComfyUI / WinRT 等平台坑点与 workaround；
- 对外契约中的字段含义、单位、可为空语义；
- `TODO` / `FIXME` / 用户可见的失败处理说明。

### 3. 精简规则（已执行）

1. **模块头压缩**：把一个文件顶部的 4–32 行模块说明压缩为一行职责；安全/边界类模块头保留。
2. **装饰分隔线删除**：`/* ── 作品基础操作 ───── */` 这类只起排版作用的分隔行删除。
3. **重复忽略注释删除**：`// ignore`、`// 忽略` 这类在 catch 中反复出现的空注释删除，保留错误处理本身。
4. **重复空行收敛**：连续 3 行以上空行收敛为 1 个空行，降低视觉噪音。
5. **不自动处理**：不删除安全边界、类型契约、状态机、失败恢复说明；不删除测试用例中的行为注释。

### 4. 后续可继续精简的对象

- `src/shared/types.ts`、`src/core/types.ts` 中字段级注释仍较多，但属于数据契约，暂不删除；
- `docs/`、`tests/` 的行为注释暂不纳入源码比例；
- 若后续模块拆分，优先把长模块头迁移到 `docs/ARCHITECTURE.md`，代码只保留一行职责。

### 5. 验证

- `npm run typecheck`：通过；
- 受影响的创作台/共享单测：通过（见本轮验证记录）；
- 注释精简不改变任何运行时分支、字符串或正则。

## 10. 文档维护

文档随代码一起提交；当前只维护这一套入口，不再新增同类重复文档：

- 用户操作与功能速查：`docs/USER-GUIDE.md`
- 创作台工作流、快捷键与边界：`docs/STUDIO.md`
- 模型、订阅与多媒体：`docs/MODELS.md`
- 进程、数据与安全边界：`docs/ARCHITECTURE.md`、`docs/SECURITY-PRIVACY.md`
- 视觉规范：`docs/DESIGN-SYSTEM.md`、`docs/guide/screens/`
- 质量方法、门禁与当前版本证据：`docs/verification/VERIFICATION.md`
- 创作台任务进度：`docs/STUDIO-TASKS.md`

新增功能时更新对应主文档，不新增平行副本；截图更新后同步 `docs/guide/screens/manifest.json`。
