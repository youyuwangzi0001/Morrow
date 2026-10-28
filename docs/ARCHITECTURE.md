# Morrow 架构说明

本文描述 Morrow 0.2.0（r049）的实际实现，而不是设计愿景。目标是让新贡献者在一小时内理解：进程如何分工、一次对话如何变成工具调用、创作台如何落到作品文件、数据写到哪里、哪些边界不可越过。

## 1. 进程模型

```text
┌─────────────────────────────── main (Electron) ───────────────────────────────┐
│ index.ts        启动、单实例、窗口/灵动岛/托盘、安全策略、崩溃处理            │
│ ipc.ts          chat/session/settings/window 等基础 IPC                       │
│ feature-ipc.ts  feature:* 白名单注册与 Result 包装                            │
│ main/*.ts       扁平模块：agent/studio/features/workspace/runtime/session/     │
│                  settings/subscriptions/memory/media/artifacts/terminal-manager│
│ core/*.ts       扁平模块：agent/tools/tool-kit/tool-files/tool-media/          │
│                  tool-extra/providers/types/util                                │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ contextBridge / ipcRenderer.invoke
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ preload（contextIsolation + sandbox）                                         │
│ 只暴露 window.morrow 白名单；所有 invoke 返回 Result<T>，不暴露 ipcRenderer   │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────────────┐
│ renderer（React 19 + Zustand）                                                │
│ features/*.tsx  每个功能域一个扁平组件文件；components.tsx 承载共享 UI            │
└───────────────────────────────────────────────────────────────────────────────┘
```

主窗口与灵动岛都启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，禁用 `<webview>`。渲染层不能直接读文件、执行命令或访问密钥。

### 1.1 启动顺序

1. 解析数据目录：`--data-dir` → `%LOCALAPPDATA%\Morrow\data-location.json` → `portable.marker` → `PORTABLE_EXECUTABLE_DIR` → `%APPDATA%\Morrow`。
2. 在单实例锁之前 `app.setPath('userData', dataDir)`；否则多个便携副本会互相顶掉。
3. 获取单实例锁；第二个实例只唤醒已有主窗。
4. 注册 `morrow-file` / `morrow-artifact` 私有协议。
5. `whenReady`：安全策略 → 协议处理器 → 菜单置空 → 基础 IPC → feature 模块 → 订阅恢复 → Token 账本 → 主窗 → 灵动岛 → 托盘 → 定时任务 → 全局快捷键。
6. 打包版启动本地 crashReporter；主进程安装未捕获异常/未处理 Promise/子进程消失日志。

### 1.2 扁平结构约束

生产源码只保留 8 个目录（`src/main`、`src/core`、`src/preload`、`src/renderer`、`src/renderer/assets`、`src/renderer/features`、`src/shared` 与根）。规则：

- 主进程/核心不再按 `services/`、`features/`、`studio/`、`tools/`、`providers/` 分层；同类实现合并到领域文件。
- 渲染层每个功能域只保留 `<域>.tsx`（组件）与 `<域>-core.ts`（纯逻辑，若有）；CSS 合并为 `<域>.css`。
- 新增模块先判断能否并入现有领域文件；只有确实独立的边界才新建文件。

## 1.3 窗口与生命周期

- 主窗默认按 2100×1200 物理像素换算 DIP；最小 1200×760 物理像素左右。
- 关闭动作由 `settings.closeAction` 决定：每次询问、最小化到任务栏、完全退出。
- `window-all-closed` 不退出进程；托盘/灵动岛仍可运行后台任务。
- 退出时清理终端、Agent、订阅代理、定时任务、托盘；4 秒未完成强制 `app.exit(0)`。
- 主窗口渲染进程崩溃后 800ms 自动 reload；60 秒内最多两次，避免崩溃循环。无响应事件写入日志。

## 2. 目录与数据

数据目录初始化时创建：

```text
<dataDir>/
  sessions/          会话 JSON
  snapshots/         文件写入前快照
  checkpoints/       每轮检查点
  logs/main.log      主进程日志
  providers/         Provider 相关状态
  attachments/       附件临时/持久文件
  schedules/         定时任务
  skills/            用户技能
  memories/          全局记忆
  projects/          项目元信息
  artifact-versions/ 成品版本
  studio/           创作台作品、版本、素材与交付物
  usage/             Token 日账
  permissions/       审批日志
  secrets.json       safeStorage 加密的 API Key
  settings.json      脱敏设置
```

工作区内另有：

```text
<workspace>/.morrow/
  memories.json      项目记忆
  episodes.json      任务经验
  skills/            工作区技能
  commands/          自定义命令
  agents/            自定义角色
  mcp.json           工作区 MCP 配置
  mcp-trust.json     MCP 信任登记
```

`deliver/Morrow Data` 是用户数据；构建脚本保留但从不计入交付。

## 3. IPC 与事件

- 基础 IPC 覆盖 chat/send、session CRUD、settings、window、数据目录、归档等。
- feature IPC 只挂载已注册的精确 `feature:*` 频道；返回值统一 `{ok:true,data}` 或 `{ok:false,error}`，避免 Electron 原始异常泄漏。
- 创作台走 `feature:studio:action`：渲染层提交窄动作，主进程 `StudioService` 校验后只通过 `StudioStore` 读写作品；任务进度用 `feature:studio:event` 推送作品摘要与任务状态。外部 ComfyUI 任务号会写入任务记录；应用启动时若引擎在线，自动对账上次已提交的外部任务，也可在检查页手动取回。
- 渲染层通过 preload 的 `window.morrow` 调用；没有裸 `ipcRenderer`。
- Agent 运行产生 `RuntimeEvent`（started/delta/tool/permission/usage/compaction/notice/finished 等），带 `seq/runId/sessionId/at`；主进程先做敏感值脱敏、持久化、检查点登记、灵动岛更新，再广播 `morrow:event`。
- feature 事件走 `feature:*` 并广播所有窗口；设置变更只发主窗。
- 网页/浏览器/MCP 内容按不可信数据处理，不作为系统指令。

## 4. Agent 循环

一次 `chat:send` 的主路径：

1. `user_prompt_submit` 钩子（返回码 2 可阻断发送）。
2. 同会话互斥检查；已有运行则拒绝或排队。
3. 创建本轮检查点与快照目录。
4. 解析 Provider/Model/Key/权限/上下文覆盖。
5. 写入用户消息、自动标题（首条可见消息截 26 字，仅在标题仍是“新对话/临时对话”时）。
6. `runAgent`：构建 system prompt、历史、工具列表；流式调用 Provider；聚合文本/思考/工具调用；执行工具；回填 tool_result；循环直到完成/步数/预算/中止。
7. 每个工具调用前做权限判断；审批/提问全局按 run 串行。
8. 运行结束持久化消息、usage、todo、artifact、goal/plan/research；执行 `run_finished` 钩子、队列/目标/研究后续。
9. 清理临时状态；迟到事件不再覆盖新运行。

### 4.1 模式与限制

- `chat`：只读工具集合 + ask_user/web_search；内核拒绝写/命令/记忆/集群。
- `work`：默认；完整工具。
- `plan`：仅工作模式；固定只读 + `submit_plan`；最多 2 步；批准后转执行。
- `research`：固定只读权限 `auto`，但有研究白名单；计划阶段不暴露工具；检索轮以隐藏消息续跑。
- `goal`：仅工作模式；2–256 轮；预算含工具调用、有效时间、连续无进展；完成需证据文件；全局同时一个目标。
- `temporary`：不写项目记忆、不持久化；不提供回退/成品版本。
- `demo`：一次性演示工作区，跳过审批但真实执行工具，约 35–50 秒。

### 4.2 工具注册

工具按固定顺序注册：文件、PDF/DOCX/XLSX/PPTX、搜索、命令、技能、元工具、联网、终端、MCP、浏览器、computer-use、多媒体、创作台。`submit_plan/update_goal` 按模式注入。

- 创作台注册 11 个 `studio_*` 工具；读工具 `studio_project/studio_review` 进入只读集合，写工具仍走权限与审批。
- 创作台工具不直接改文件，只调用与界面相同的 `StudioService`；因此 Agent、集群与 UI 共享一份状态。

- 主代理工具调用串行执行；单个工具异常转 `ToolResult`，不炸整轮。
- 连续 4 次完全相同工具调用判死循环。
- 工具结果、参数、MCP 配置等都有大小上限；文件/终端/媒体路径必须在工作区内。

## 5. 权限与审批

权限模型在 `core/agent.ts`，持久化在 `main/runtime.ts`。

| 档位 | 普通写/命令 | 危险命令 | 越界路径 | 外部副作用 |
|---|---|---|---|---|
| 只读 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 询问 | 工作区内放行 | 询问 | 询问 | 询问 |
| 完全访问 | 放行 | 询问 | 询问 | 询问 |

- “始终允许”按工具 + 目标 + 参数哈希形成会话 grant，并落为工作区 allow 规则。
- deny 规则优先；allow 不能越过危险/越界/外部动作。
- 危险命令、越界路径、终端 stdin 等始终逐次确认，不提供“始终允许”。
- 审批日志在 `permissions/approval-log.jsonl`，规则在 `permissions.json`。
- 无人值守运行/定时任务自动拒绝审批和提问，不会挂起。

## 6. 上下文、压缩与恢复

- 自动压缩默认阈值 0.8、保留最近 8 条；可配 0.5–0.98、2–50。
- 只在完整消息边界切；保留首条用户锚点与当前请求；有未回填 `tool_use` 时拒绝压缩。
- 优先模型摘要；失败退本地摘要；仍超目标再 `aggressiveTrim`。
- 上下文溢出最多强制压缩重试 2 次；手动 `/compact` 需空闲、至少 4 条消息、90s 超时、压缩前后校验消息签名。
- 每轮检查点最多 100 个；回退范围 code/conversation/both；命令副作用不可通用追踪。
- 写文件前快照记录 before/after 哈希；恢复前校验会话根、清单哈希和当前文件哈希，冲突拒绝。

## 7. Provider 层

### 7.1 工厂

- `demo`：离线剧本，真实执行工具。
- `anthropic`：Anthropic Messages。
- 其他：OpenAI 兼容 Chat Completions。
- 真实 Provider 外包 `ToolProtocolProvider`：剔除正文中的文本工具协议，缺失结构化 tool_calls 时解析为工具事件，未知工具忽略并提示。

### 7.2 OpenAI 兼容

- `/chat/completions` + SSE + `stream_options.include_usage`。
- tool_calls 按 index 拼接；`reasoning_content/reasoning` → `thinking_delta`。
- `reasoning_effort` 透传；DeepSeek 直接 Provider 的 `off` 映射为 `none`；Qoder 代理保持 `off`。
- 支持 `x-morrow-context-window` 会话级上下文覆盖。
- 图片消息使用 content 数组 + `image_url` data URL。

### 7.3 Anthropic

- system 顶层；user/assistant 交替；tool_use/tool_result 块。
- 思考档位映射 `thinking.budget_tokens`（low 1024 … max 32768），强制 temperature=1；`off` 不发送 thinking。
- 缓存读写计入总输入；不使用 Morrow 的 context-window 头。

### 7.4 重试

- 408/409/425/429/5xx 与网络错误可重试，最多 3 次，退避 800/2000/5000ms。
- 只有“尚未产出任何内容”才重试；abort 立即停止。

## 8. 持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| 会话 | `sessions/<id>.json` | 整份 JSON；临时文件 + rename；临时会话仅内存；列表最多 300 |
| 设置 | `settings.json` | 脱敏配置；内置 Provider 每次启动与代码预设合并 |
| 密钥 | `secrets.json` | safeStorage 加密；加密不可用时拒绝保存；旧 `b64:` 只读兼容 |
| 项目 | `projects/projects.json` | 背景、资料、会话、范围 |
| 记忆 | 工作区 `.morrow/memories.json` / 全局 `memories/global.json` | 项目/全局长期记忆 |
| 任务经验 | `.morrow/episodes.json` / `episodes/global.json` | 任务复盘 |
| 成品版本 | `artifact-versions/<session>/<artifact>/` | 最多 30 版、单版 8MB |
| 创作台作品 | `studio/projects/<id>/project.json` | 原子写入；版本在 `versions/`，素材按 SHA-256 去重，导出在 `exports/` |
| 创作台分片 | `studio/projects/<id>/chunks/<chapter>/` | 超过 1.8 万字的章节按 1.2 万字分片，`project.json` 只留引用与哈希 |
| 创作台派生 | `studio/projects/<id>/derived/` | 波形缓存 `waveforms/`、540p 代理 `proxies/`，可重建、不进入工程包 |
| 创作台任务 | `studio/projects/<id>/jobs.jsonl` | 每次任务状态与消息流追加记录 |
| 创作台回收 | `studio/trash/<id>-<time>/` | 删除作品先移到回收目录，不直接 `rm -rf` |
| 技能 | `skills/` / 工作区 `.morrow/skills` | 用户/工作区技能 |
| MCP | `mcp.json` / 工作区 `.morrow/mcp.json` | 工作区需 `mcp-trust.json` |
| 定时任务 | `schedules/tasks.json` | 最多 50 |
| Token 账 | `usage/token-activity.json` | 日账 |
| 日志 | `logs/main.log` | 主进程 JSON 行日志 |

## 9. 订阅与代理

订阅服务与协议统一在 `main/subscriptions.ts`。共同结构：

- 登录/导入 → 凭据加密落盘 → 账号/额度校验 → 模型目录 → 本地回环代理 → Provider。
- 回环代理只绑 `127.0.0.1` 随机端口，要求随机本地 Bearer；上游 token 不进入渲染层。
- 401/403 只刷新一次后重试；刷新先落盘再使用。
- 官方接口变化时返回真实错误，不假装已连接。
- 各渠道细节见 [订阅接入](MODELS.md)。

## 10. 创作台、终端、Git、浏览器与媒体

- 创作台：`StudioService` 是唯一写入口；`StudioStore` 负责项目原子读写、超长章节分片、版本快照、素材指纹与回收；文本路由、蓝图落地、样例数据、创作手法库与七维质检、意图解析、语气分析、波形代理、视频与成书导出都扁平合并在 `main/studio.ts`。界面在 `renderer/features/studio.tsx` 与 `studio-core.ts`，数据契约在 `shared/studio.ts`。
- `TerminalManager`：node-pty / ConPTY；Git Bash 默认；PowerShell 7 / WSL 可选；Windows PowerShell 5.1 与 CMD 移除（CMD 仅在无其他 Shell 时兼容回退）。
- Git：`git-service` 封装工作区仓库操作；拒绝越界与父仓库根操作；diff 超长截断。
- 浏览器：`BrowserService` 管理多标签/原生视图；普通页面与登录 session 分离；导航白名单、下载、权限与错误页有独立处理。
- 媒体：`MediaService` + `media-catalog` 管理引擎/模型/下载/启动；ComfyUI（Qwen 图片、MiniMax 视频、ACE-Step 配乐）、llama.cpp、Ollama、LM Studio；ffmpeg 由系统或设置提供；产物写入 `media/`。创作台的画面/视频/配乐都走同一套媒体服务，模型未就绪时明确失败。

## 11. 安全边界

- 文件 IPC 必须 realpath 后位于最近工作区/会话工作区。
- 外部 URL 仅 http(s)；`window.open` 拒绝；webview 禁止。
- 打包版 CSP；画布 HTML 走独立 `morrow-artifact` 协议与独立 CSP。
- 密钥永不下发渲染层；日志脱敏；输出守卫遮蔽邮箱/用户名/token。
- 网页、MCP、浏览器内容不可信；不执行页面指令。
- Antigravity 不内置 OAuth secret，需 `MORROW_ANTIGRAVITY_CLIENT_SECRET`。
- 详见 [安全与隐私](SECURITY-PRIVACY.md)。

## 12. 构建、打包与测试

- 构建：`npm run build`（typecheck + electron-vite）。
- 打包：`npm run dist` / `dist:all`；便携版使用自研 C# 启动器，内嵌 zip，首次解压到 exe 同级 `.morrow-runtime-<version>-<revision>`。
- 安装包：NSIS，默认安装到 Program Files（需要管理员权限）。
- 单元测试：Vitest，29 个套件 / 1012 用例；其中创作台覆盖作品仓库、分片恢复、提示词、语气审稿、文本 diff、云端 TTS、路由、状态转移、时间线、修改计划与 Agent 工具。
- E2E：Playwright `_electron`，22 个套件 / 224 用例；打包版 E2E 另跑 6 个用例（含创作台资产）。
- 真实账号/媒体用例默认跳过，需环境变量与本机引擎。
- 评测指标、复现命令与当前结果见 [验收记录](verification/VERIFICATION.md)。
