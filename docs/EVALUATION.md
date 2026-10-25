# 评测规范

Morrow 的“完成”不是模型说完成，而是可复现的测试、真实任务和证据文件。本文说明测试分层、Agent 质量指标、当前结果与已知边界。

## 1. 目标与边界

- 验证工具调用、上下文管理、权限、持久化与 UI 的真实行为，而不是只测文案。
- 单测可以 mock Provider/引擎；E2E 必须启动真实 Electron、真实 IPC、真实 PTY/画布。
- 真实账号、真实模型、ComfyUI、ffmpeg 等外部依赖不在默认 CI 中运行；会明确 skip，不伪造通过。
- 所有测试都在临时数据目录中运行，避免污染用户数据。

## 2. 测试分层

| 层 | 技术 | 规模 | 作用 |
|---|---|---:|---|
| 类型/静态 | TypeScript + UI token audit | 全量 | 编译、裸排版值、设计 token |
| 单元 | Vitest | 14 套件 / 952 用例 | 协议、工具、权限、上下文、持久化、模型映射 |
| E2E | Playwright `_electron` | 17 套件 / 209 用例 | 真实窗口、IPC、终端、浏览器、画布、设置、旅程 |
| 打包冒烟 | Playwright + 便携包 | 5 用例 | 解压启动、PTY、文档工具、原生浏览器、双数据目录 |
| 真账号/真引擎 | 手动/条件测试 | 按环境 | 登录、Agent 调用、Qoder 模型目录、媒体 |

当前代码规模（`wc -l`）：

| 范围 | 行数 |
|---|---:|
| `src/` | 125,812 |
| `tests/` | 43,456 |
| 其中 `tests/e2e/` | 19,236 |
| `scripts/` + `build/` | 2,896 |
| **代码合计** | **172,164** |

## 3. Agent 质量指标

离线确定性套件（`npm run test:eval`，Mock Provider）评估四项：

### 3.1 工具调用首次成功率（TSR@1）

- 8 个工具任务；
- 首次成功 8/8，TSR@1 = 1；
- 重试任务 3 个，重试成功 3/3，TSR@R = 1。

### 3.2 长任务上下文漂移率（LDR）

- 60 轮、3 次压缩、24 个事实检查；
- 违规 0，漂移率 0；
- 硬约束缺失 0。

### 3.3 压缩后关键决定保留率（CKR）

- 2 个场景，预期保留 10 项，实际 10 项，保留率 1；
- 本地兜底压缩与模型压缩均执行；
- 硬约束缺失 0。

### 3.4 Token 曲线斜率（TSS）

- 80 轮，上下文上限 10,000，压缩 12 次；
- 基线斜率 494，管理后斜率 -0.04；
- 管理后峰值 7,994，最终 7,500；基线峰值 39,806。

综合得分 **100/100**，四项门槛全部通过。结果文件：`docs/verification/eval-results.json`。

## 4. 真实任务与回归

除离线指标外，使用真实项目/账号验证：

- **Qoder 真账号**：内置浏览器登录 → 账号目录 15 个 chat 模型 / 200K、400K、1M → Agent 调用 `deepseek-v4.1-flash`、`qwen-3.8-flash` 返回“链路正常” → max 思考 + 400K 真实请求成功。
- **Codex**：本机 `auth.json` 导入 connected + quota；Responses 工具参数与 assistant 历史内容修复。
- **媒体**：ComfyUI mock 真实生成/编辑/预览；本地 Coder390/视觉链路的请求与回退逻辑由单测覆盖；真实 DeepSeek 视觉调用未在最终构建上重复消耗额度，下一次真实开发直接走当前模型优先路径。
- **终端/Git**：真实 PTY、默认 Git Bash 选择、空终端隐藏滚动条、80 行输出后显示、Shell 切换、Git 暂存/提交/分支/历史/放弃。
- **设置/订阅**：所有设置页标题规格、订阅详情统一排版、双主题截图。
- **打包**：r019 便携包实际解压启动，PTY/文档工具/浏览器/双数据目录 5/5。

## 5. 质量门禁

提交前至少执行：

```powershell
npm run typecheck
npm run audit:ui
npm run test:unit
```

涉及 UI/桌面行为时，运行相关 E2E：

```powershell
npx playwright test tests/e2e/11-terminal-git.spec.ts -g "真实终端"
npx playwright test tests/e2e/13-packaged.spec.ts
```

全量 E2E 约 11 分钟，适合发布前；日常改动优先跑受影响 spec，避免无意义重跑。

## 6. 截图与验收证据

- 12 张指南图由 E2E 真实 Electron 窗口生成，见 `docs/guide/screens/manifest.json`。
- 每张图记录来源 spec、尺寸和主题；文档只引用这些图片，不手工伪造界面。
- 验收记录见 [VERIFICATION.md](verification/VERIFICATION.md)，包含哈希、测试结果和边界。

## 7. 已知限制

- 全量 E2E 未在本轮所有文档修改后重跑；已运行定向终端/Shell/打包用例与 12 张截图生成。
- 真实订阅渠道中，本机只有 Qoder/Codex 有可用账号；其他渠道只验证登录页、协议单测与端点实现，未编造额度。
- 媒体真实生成依赖本机 GPU/ComfyUI；无引擎时会 skip，不伪造成功。
- Agent 质量指标是确定性 Mock 测试，不等同于所有真实模型的表现；真实模型仍需按任务验收。
- 受 Windows 令牌/低完整性影响，Git Bash 在部分环境不可用；测试会用 PowerShell 7 验证 PTY，产品默认仍是 Git Bash。

## 8. 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run test:unit
npm run test:eval
npx playwright test
npm run dist:all
npx playwright test tests/e2e/13-packaged.spec.ts
```

真实账号/引擎测试需要额外环境变量与本机资源；详见 [多媒体与本地模型](MEDIA-MODELS.md) 与 [订阅接入](SUBSCRIPTIONS.md)。
