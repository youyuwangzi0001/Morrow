# Morrow 架构说明

Morrow 是 Electron 桌面应用：main（Node/Electron）+ preload（白名单 API）+ renderer（React 19）。本文只写当前实现中稳定的边界；具体行号会随代码变化，以源码为准。

## 1. 进程模型

```text
renderer (React 19 / Zustand)
  │  window.morrow（preload 白名单）
  ▼
preload（contextIsolation，无 nodeIntegration）
  │  IPC / feature:*
  ▼
main (Electron)
  ├─ index：窗口、生命周期、单实例、协议、CSP
  ├─ AgentService / core/agent：循环、工具、权限、压缩
  ├─ provider 工厂：OpenAI 兼容 / Anthropic / 本机 / demo
  ├─ StudioService / StudioStore：创作台
  ├─ creative-masters：内嵌三套大师方法
  ├─ media：ComfyUI / ffmpeg / TTS
  └─ session/settings/secrets/projects/memory/skills/schedules
```

### 1.1 启动顺序

1. 解析 `--data-dir` / 数据目录指针 / `portable.marker` / `%APPDATA%`，在单实例锁之前 `setPath`。
2. 创建主窗口与灵动岛；主窗口 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，禁用 webview。
3. 注册基础 IPC 与 `feature:*` 精确通道。
4. 启动 Agent 运行时、Studio 服务、媒体/终端/订阅等按需服务。
5. 恢复上次会话/工作区；渲染崩溃自动 reload（800ms，60 秒内最多 2 次）。

![主界面](guide/screens/02-chat-home-dark.png)

### 1.2 扁平结构约束

源码按职责扁平放在 `src/main`、`src/core`、`src/renderer/features`、`src/shared`。合并功能套组后不保留多层 `studio/`、`core/agent/` 目录；新增文件优先放到对应扁平目录，避免重新长出重复层级。

## 2. 目录与数据

### 2.1 应用数据

数据目录解析顺序：

1. `--data-dir`；
2. `%LOCALAPPDATA%\Morrow\data-location.json`；
3. 便携版 `portable.marker` → exe 同级 `Morrow Data`；
4. `PORTABLE_EXECUTABLE_DIR`；
5. `%APPDATA%\Morrow`。

数据目录包含：

| 目录/文件 | 内容 |
|---|---|
| `sessions/` | 会话与消息 |
| `snapshots/`、`checkpoints/` | 文件/会话检查点 |
| `logs/` | `main.log` JSON 行，5MB 轮转保留 3 份 |
| `providers/`、`secrets.json` | 模型配置与加密凭据 |
| `settings.json` | 应用设置 |
| `studio/` | 作品、素材、版本、任务、回收站 |
| `usage/` | Token Activity |
| `schedules/` | 定时任务 |
| `skills/` | 用户技能 |
| `permissions/` | 审批日志 |

工作区内的 `.morrow/` 存项目记忆、经验、技能、命令、角色、MCP 配置。

### 2.2 作品数据

`StudioStore` 是唯一写入口：原子读写项目 JSON、超长章节分片、版本快照、素材指纹、回收站索引。超长章节分片按内容哈希写入独立目录，`project.json` 成功后才清理旧分片；读取时逐章校验，只从历史版本恢复损坏章节。作品文件保存蓝图、章节、分镜、镜头、素材、时间线、任务、检查、审稿覆盖与交付；候选稿与版本在章节内部。

## 3. IPC 与事件

- 基础 IPC + 精确 `feature:*` 注册；统一返回 `{ ok, data }` 或 `{ ok, error }`。
- 渲染层不直接使用 `ipcRenderer`；只通过 `window.morrow` 白名单调用。
- `RuntimeEvent` 带 `seq/runId/sessionId/at`；主进程先脱敏、持久化、登记检查点、更新灵动岛，再广播 `morrow:event`。
- 事件包括消息增量、工具开始/结束、审批请求、任务进度、压缩、错误、完成等。

## 4. Agent 循环

- 五种工作方式：聊天（只读）、工作（可写/命令）、计划（只读 + submit_plan）、深度研究（只读 + 网页白名单）、长期目标（跨轮）。
- 工具按类别注册：文件、命令、终端、搜索、技能、MCP、浏览器、媒体、计划、目标等。
- 循环：模型流式输出 → 工具调用 → 权限检查 → 执行 → 结果回填 → 继续，直到完成/达到步数/中断。
- 长任务会压缩上下文：优先摘要，摘要不划算时折叠大工具输出；保留用户任务锚点与合法消息序列。
- 每个用户轮次一个检查点；写文件前快照；支持会话回退、文件回退与冲突校验。

## 5. 权限与审批

三档：只读 / 询问 / 完全访问。

- **只读**：拒绝写文件、命令、改记忆。
- **询问**：工作区内写文件/普通命令直接放行；危险命令、越界路径、外部副作用动作、终端 stdin 逐次询问；没有“始终允许”用于危险动作。
- **完全访问**：全部直接放行，包括危险命令、越界和外部动作。

“始终允许”= 工具 + 目标 + 参数哈希；落会话 grant 与工作区规则；deny 优先；每工作区最多 300 条；审批日志 `permissions/approval-log.jsonl`。

聊天硬只读；研究只放行只读 + 白名单；计划只读 + `submit_plan`。

## 6. 上下文、压缩与恢复

- 上下文按模型窗口估算；接近阈值时先摘要，再折叠大工具输出，最后才做紧急裁剪。
- 摘要失败/被中断时不把历史 assistant 误标为 interrupted；保留用户任务锚点。
- 会话列表最多 300；每轮检查点最多 100；成品版本 30 版/8MB；Token 账在 `usage/token-activity.json`。

## 7. Provider 层

- 15 个内置 Provider：DeepSeek、Kimi、Qwen、GLM、MiniMax、MiMo、OpenAI、Gemini、xAI、Meta、Anthropic、Ollama、llama.cpp、LM Studio、demo。
- OpenAI 兼容走 `/chat/completions` 流式；Anthropic 走 `/v1/messages`；Gemini 走 OpenAI 兼容端点。
- 思考档位：OpenAI 兼容用 `reasoning_effort`；Anthropic 用 `thinking.budget_tokens`（1024–32768，temperature=1）；DeepSeek `off` 映射 `none`；Qoder 代理保持 `off`。
- 重试：网络/5xx/429 按策略重试；结构化任务触达输出上限时默认报错，不返回半截 JSON。

## 8. 持久化

- 会话：单 JSON 原子写；消息列表与元信息分离；启动时恢复。
- 检查点：每轮一个；文件快照写前登记；回退时校验冲突。
- 作品：`StudioStore` 原子写；超长章节按内容哈希分片、JSON 后写；素材按内容哈希去重；版本/候选/回收站索引。
- 审稿：`reviewCoverage` 记录批次、章节/镜头版本与实际字符区间；长章按段送审，未读区间不算完成。
- 成片：视频交付保存 `timelineVersion` 与 `renderKey`；上游 visuals/voice/timeline/delivery 失效或渲染依据变化时，旧片不作为当前成片。
- 密钥：`safeStorage`/DPAPI 加密；加密不可用时拒绝保存；渲染层只看到 `apiKeyStored`。

## 9. 订阅与代理

- 订阅渠道：ChatGPT/Codex、Qoder、Kimi Code、GLM Coding Plan、MiniMax Code、Step Plan、Command Code、Cline Pass、Google Antigravity、OpenCode、第三方 coding plan。
- 当前真实状态：Codex 提供本机导入/OAuth 与用量接口；Qoder 有账号模型目录实现但本机未完成登录实测；其余渠道完成登录页/协议实现，未验证已连通。Morrow 不伪造额度或已连接。
- 订阅回环只监听 `127.0.0.1` 随机端口，使用本地 Bearer；不暴露公网。
- 不提供 Claude 登录；Antigravity 需要 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。

## 10. 创作台架构

### 10.1 服务与存储

- `StudioService` 是唯一写入口；`StudioStore` 负责项目原子读写、分片、版本、素材指纹与回收站。
- `src/main/studio.ts` 扁平合并了蓝图、大纲、正文、分镜、协作者、时间线、导出、检查、TTS/音乐等逻辑。
- 渲染层在 `src/renderer/features/studio.tsx` 与 `studio-core.ts`；数据契约在 `src/shared/studio.ts`。

### 10.2 内嵌提示词

- `src/main/creative-prompts.generated.ts` 存 gzip+base64 的写作/编剧/导演三套方法。
- `src/main/creative-masters.ts` 解压、路由、选段、方法论预算、输出契约；运行时不读文件系统。
- `scripts/embed-creative-prompts.mjs` 只供维护者重新生成；`npm run build` 不调用。
- 旧的 `prompt-library.ts`、29 组内嵌手法、七维权重、六条门禁已移除；只保留本地可计算指标与交付检查。

### 10.3 协作者

- 前端 `assistantContextFor` 把 `focusedStage` 与当前步骤可用的选中项转成 `{ view, selection }`。
- 主进程 `revisionSnapshot` 生成作品快照；`planRevision` 让模型输出 `{ reply, actions }`；`normalizeRevisionActions` 归一化；`applyEditPlan` 应用。
- 计划卡先预览，确认后应用；应用前写整项目快照，可整体撤销。
- 动作覆盖蓝图、局部大纲、章节、章序/镜序、镜头/人物/地点、声线/配音、音效/配乐、画面/视频、补镜头；`set-clip-*` 由本地处理。

![创作台与协作者](guide/screens/18-studio-assistant-dark.png)

### 10.4 媒体与导出

- 图片/视频/章节配图：ComfyUI；未就绪明确失败。
- 配乐：ACE-Step；`local` 只是草稿。
- 配音：云端 `/audio/speech` / Qwen3-TTS / Windows SAPI。
- 合成：FFmpeg；导出 EPUB/PDF/Word/TXT、ASS/SRT、封面、工程包、四格漫画等。

![时间线与交付](guide/screens/14-studio-timeline-dark.png)

## 11. 安全边界

- 文件路径 realpath 后限工作区；附件例外；URL 只允许 http(s)；`window.open` 拒绝；webview 禁用。
- 打包版 CSP；画布 HTML 使用独立 `morrow-artifact` 协议/CSP。
- 网页、MCP、浏览器内容按不可信数据处理；不把网页指令当系统指令。
- 日志本地、脱敏、轮转；crashReporter 不上传。

## 12. 构建、打包与测试

```powershell
npm run dev
npm run typecheck
npm run audit:ui
npm run test:unit
npm run test:e2e
npm run build
npm run dist:final
```

- `dist:final`：只交付 `Morrow-0.2.0-portable.exe` 与 `Morrow-0.2.0-setup.exe`；文件夹版/zip/源码包只作中间产物。
- 仓库仅保留 366 项核心单元 + 46 条 Electron 集成流程，覆盖 38 个功能域。`test:unit` / `test:e2e` 直接运行所有现存用例，`verify` 为统一检查入口；非核心套组已删除。覆盖矩阵与精简记录见 [测试说明](TESTING.md)。
- 覆盖矩阵、实测结果和环境条件见 [测试说明](TESTING.md)；发布约定见 [贡献指南](../CONTRIBUTING.md) 与 [验收记录](verification/VERIFICATION.md)。
