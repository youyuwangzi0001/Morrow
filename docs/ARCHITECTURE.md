# 架构说明

> 本文为中文文档；英文概览见 [README.md](../README.md)。

Morrow 是 Electron 桌面应用：主进程负责系统能力与持久化，preload 提供白名单 API，renderer 用 React 19 / Zustand 呈现界面。本文只写当前实现的稳定边界；具体行为以源码与测试为准。

## 目录

- [进程模型](#进程模型)
- [扁平源码结构](#扁平源码结构)
- [数据目录](#数据目录)
- [IPC 与事件](#ipc-与事件)
- [Agent 循环](#agent-循环)
- [权限与审批](#权限与审批)
- [协作任务](#协作任务)
- [上下文与压缩](#上下文与压缩)
- [Provider 与订阅](#provider-与订阅)
- [持久化](#持久化)
- [创作台架构](#创作台架构)
- [设计系统](#设计系统)
- [安全边界](#安全边界)
- [构建、测试与打包](#构建测试与打包)

## 进程模型

```text
renderer (React 19 / Zustand)
  │  window.morrow（preload 白名单）
  ▼
preload（contextIsolation，sandbox，无 nodeIntegration）
  │  IPC / feature:*
  ▼
main (Electron)
  ├─ index：窗口、生命周期、单实例、协议、CSP、托盘、灵动岛
  ├─ AgentService / core/agent：循环、工具、权限、压缩
  ├─ core/collaboration：成果、计划、验收、资源探测、卡住判断
  ├─ main/collaboration：成果存储、运行时、项目存储、验收、共享资源、成员名额、工具审计
  ├─ provider 工厂：OpenAI 兼容 / Anthropic / 本机 / demo
  ├─ StudioService / StudioStore：创作台
  ├─ creative-masters / creative-prompts.generated：内嵌大师方法
  ├─ media：ComfyUI / ffmpeg / TTS / 模型目录
  └─ session / settings / secrets / projects / memory / skills / schedules
```

### 启动顺序

1. 解析 `--data-dir` / 数据目录指针 / `portable.marker` / `%APPDATA%`，在单实例锁之前 `setPath`。
2. 创建主窗口与灵动岛；主窗口 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，禁用 webview。
3. 注册基础 IPC 与 `feature:*` 精确通道。
4. 启动 Agent 运行时、Studio 服务、媒体/终端/订阅等按需服务。
5. 恢复上次会话/工作区；渲染崩溃自动 reload（800ms，60 秒内最多 2 次）。

### 窗口与图标

窗口目标为 **2100×1200 物理像素**，按主屏缩放比换算为 DIP；最小 1200×760。主窗口无边框，灵动岛是独立窗口。文档截图保持默认窗口，输出 2100×1200 物理像素原图。

Windows 按 AUMID 缓存任务栏图标。便携版使用独立 AUMID `studio.morrow.agent.desktop.portable`，安装版沿用与开始菜单快捷方式一致的 `studio.morrow.agent.desktop`。窗口图标来自 extraResources 的 ICO/PNG，路径比较统一用 `realpathSync.native` 展开 8.3 短名。

## 扁平源码结构

源码按职责扁平放在 `src/main`、`src/core`、`src/renderer/features`、`src/shared`。合并功能套组后不保留多层 `studio/`、`core/agent/` 目录；新增文件优先放到对应扁平目录。

- **协作域**：核心逻辑在 `src/core/collaboration.ts`，主进程服务在 `src/main/collaboration.ts`。成果、计划、验收、共享资源、成员名额与工具审计都在两个文件内。
- **工具域**：`tool-kit`（公共层）、`tools`（注册表）、`tool-extra`（技能/MCP/任务）、`tool-files`（文件与文档）、`tool-media`（媒体/网页/搜索/浏览器/电脑/命令）。
- **渲染层**：每个功能域一个 `*.tsx` 组件加一个 `*.css`；跨 feature 复用的纯逻辑放 `*-core.ts`（如 `artifacts-core`、`files-core`、`studio-core`）。
- **共享层**：`shared/types`、`shared/contracts`、`shared/studio`、`shared/studio-assistant`。
- **测试**：`tests/unit` 按功能域合并入口；`tests/e2e` 按流程分文件；共用辅助平铺为 `helpers.ts`。

### 为什么保留少数分文件

- `feature-ipc` 被 `features`、`agent` 与多个服务复用；合并进 `features` 会让 `agent → features → agent` 形成循环。
- `*-core.ts` 被多个 feature 交叉引用；合并进单个组件文件会造成跨 feature 反向依赖。
- `main/workspace-isolation.ts` 属于工作区隔离域（`@core:workspace`），不是协作域内部实现。
- `studio-*.test.ts` 各自 mock 不同的 `electron` / `settings` 或独立 HTTP/TTS 生命周期；合并会把 mock 提升为整文件生效。

## 数据目录

解析顺序：`--data-dir` → `%LOCALAPPDATA%\Morrow\data-location.json` → 便携版 `portable.marker` → `%APPDATA%\Morrow`。

数据目录的完整分工与逐项说明见 [REFERENCE.md](REFERENCE.md#数据路径)：会话、快照/检查点、模型配置与加密凭据、设置、创作台作品、用量、定时任务、用户技能、审批日志与协作数据各占一个子目录。

工作区内 `.morrow/` 存项目记忆、经验、技能、命令、角色与 MCP 配置。

### 作品数据

`StudioStore` 是唯一写入口：原子读写项目 JSON、超长章节分片、版本快照、素材指纹与回收站索引。超长章节按内容哈希写入独立目录，`project.json` 成功后才清理旧分片；读取时逐章校验，只从历史版本恢复损坏章节。作品保存蓝图、章节、分镜、镜头、素材、时间线、任务、检查、审稿覆盖与交付；候选稿与版本在章节内部。

## IPC 与事件

- 基础 IPC 加精确 `feature:*` 注册；统一返回 `{ ok, data }` 或 `{ ok, error }`。
- 渲染层不直接使用 `ipcRenderer`，只通过 `window.morrow` 白名单调用。
- `RuntimeEvent` 带 `seq/runId/sessionId/at`；主进程先脱敏、持久化、登记检查点、更新灵动岛，再广播 `morrow:event`。
- 消息增量在主流式路径按 40ms 合并后广播，渲染层再按 24ms 兜底合并；`sessionLoad` 合并内存中的进行中消息并返回 `liveMessageId`，切回运行中的会话不会从下一个分片重新开始。
- 工具执行前校验执行身份（主代理 / Router / Worker）的 token、工具白名单、会话与运行、有效期和写入目录；“始终允许”按身份与尝试隔离并过期。允许/拒绝写入 `collaboration/tool-audit.jsonl`，不含工具参数或文件内容。

## Agent 循环

`core/agent` 负责：

- 组装系统提示词、角色、规则、技能与上下文；
- 调 Provider 流式生成，处理文本、思考、工具调用与错误；
- 执行工具、写检查点、广播事件、累计用量；
- 处理中断、重试、压缩与 Goal/Plan 模式；
- 维护权限签名与审批。

工具结果统一为 `ok/error`，错误带可读原因；工具参数按 schema 校验。文件工具限制在工作区内，工作区外读取只允许显式附件，写入仍走权限。

## 权限与审批

| 档位 | 行为 |
|---|---|
| 只读 | 拒绝写文件、命令、记忆与外部副作用动作 |
| 询问 | 工作区内写入/普通命令放行；危险命令、越界、外部动作、终端 stdin 逐次询问 |
| 完全访问 | 全部放行，只用于可信任务 |

审批卡显示工具、目标、影响范围与参数；危险动作没有“始终允许”。拒绝优先于允许；审批请求与执行身份绑定，过期或换身份后失效。

只读档按功能域登记读动作，域内未登记的动作默认按写处理（fail-closed）。覆盖文件、Git、终端、历史、媒体、定时任务、权限、创作台、订阅与浏览器；混合通道 `feature:studio:action` 按 `payload.type` 二分。

## 协作任务

工作模式没有独立的协作开关：主代理保留完整工具，简单工作直接完成；需要并行、隔离或独立验收时调用 `swarm` 派发成员。协作状态由 `core/agent`、`core/collaboration` 与 `main/collaboration` 驱动：

- **固定编号**：每次协作使用固定 `projectId` / `taskId`，每次重试生成新的 `attemptId`；状态记录来源（worker/verifier/user/system/legacy）、`revision` 与 `createdAt`，拒绝重复通知和晚到的旧 run。
- **执行前落盘**：协作动作在执行前写入 `collaboration/projects/<projectId>.json`；`pending` 可恢复，崩溃后遗留的 `running/executed` 转为 `uncertain` 等待人工核对，`done` 不会再次领取。会话文件只保存项目/任务编号。
- **独立工作副本**：Worker 在隔离副本中读写，结束后按任务文件清单合并；同文件同处冲突保留两版交给用户选择；用户未提交的改动保留。
- **成果版本**：发布时把文件复制到用户数据目录的只读快照；依赖成员读取快照，不受发布者后续修改影响；记录谁用了哪一版，新版本让旧使用记录过期。
- **独立验收**：verifier 在候选版本上运行安全命令并检查必需文件；失败退回作者返工，超过次数交负责人；验收后交付文件变化会作废旧结论并重新验收。
- **并发与用量**：Worker 名额受本机并发限制；用量只统计展示，不设硬预算或自动停止。
- **卡住判断**：只有重复无成果、审批等待或稳定产出等有依据的情况才提醒；停止或继续等待不影响其他成员。
- **补充与重试**：成员卡片可向运行中成员发送补充要求；失败/停滞任务可单项重试或带新指令重新激活。
- **主界面驾驶舱**：`SuperAgentState.toolUseId` 记录最近一次派发的 swarm 工具调用，渲染层据此把完整状态挂回主对话里的成员卡片；历史协作只保留静态摘要。

实现位置：`core/collaboration.ts`（成果、计划、验收、资源探测、卡住判断）与 `main/collaboration.ts`（存储、运行时、验收、共享资源、成员名额、工具审计）。

## 上下文与压缩

- **两层结构**：`Session.messages` / `RunContext.messages` 是**完整记录**（界面、落盘、导出、搜索、分叉都读它，永不裁剪）；`RunContext.modelMessages` 只承载发给模型的那一份，压缩只作用于它。集群成员循环（`runSwarmMemberLoop`）同样维护独立模型侧数组。
- **压缩只插入标记**：完整记录里在真实切点插入一条 `role=system` 摘要标记（带 `preservedMessageIds`、轮次、节省量），原文一条不删；模型侧由 `modelMessagesFrom()` 从最后一条标记处重建，旧会话（无标记）原样作为模型视图，无需迁移。
- **折叠预算随标记持久化**：单条工具结果常比整个目标预算还大，压缩时会按 `targetRatio`（默认 0.15，范围 0.10–0.30）逐级收紧工具输出，并把实际截断长度写进标记的 `modelTrimChars`；`modelTrimThroughId` 限定只折叠压缩当时已有的内容，压缩后新增的消息保持原文。
- **规划必须基于模型侧**：`planCompaction` 的输入是 `modelMessages`。用完整记录规划会因记录只增不减而每步重复触发压缩，且 `cutIndex` 与模型侧索引错位会清空当前窗口。
- 上下文账本保留最近用户消息、关键事实、工具结果与任务约束。
- 压缩 v2：确定性关键信息账本；不把摘要再次摘要；保留最近用户消息；压缩提示词带预算；Thrashing 保护避免反复压缩。
- 压缩后仍校验工具配对与首条角色；恢复时合并进行中消息，避免丢分片。
- 摘要消息记录其原文保留的消息 id；渲染层把“已压缩”标记放在保留段与后续内容的真实切点，而不是对话顶部。
- 断流重连：已有正文时断点续接；只有思考、还没有正文时重发原请求；空闲超时标记为可重试；重试耗尽在错误里注明重试次数。
- 模型只返回思考/空内容不视为任务完成：内核自动重试本步（最多 2 次），仍无正文时给出明确错误，不静默停止。

## Provider 与订阅

Provider 工厂支持 OpenAI 兼容、Anthropic 原生与 demo；本机模型走 OpenAI 兼容地址。订阅渠道使用独立适配器，处理 OAuth、本机登录、用量与模型目录；协议差异集中在 `src/main/subscriptions.ts`。订阅创建的 Provider 带 `managedBySubscription` 标记，只在订阅页管理，模型页只列官方 API 与自定义服务。

模型上下文档位由用户按完整窗口选择（3 档），以 `contextEdited` 标记随模型保存；最大输出档位（32K / 64K / 128K，1M 上下文模型追加 256K）以 `maxOutputEdited` 保存；订阅恢复/同步时设置存储保留用户选择，不会被目录默认值覆盖。

自定义服务的模型元数据可整体编辑（上下文 / 输出 / 思考档位与映射 / 图片输入 / 工具调用），写入同一套 `ModelInfo` 标记，刷新模型列表不会覆盖手动值。服务级另有 `ProviderConfig.retry`（`maxRetries` + `delays`）：`resolveRetryPolicy` 按「调用方覆盖 > 配置 > `DEFAULT_PROVIDER_RETRY`」合并并对越界值收敛；4xx（429 除外）与主动中断不重试。网关不声明长度时 `fallbackModelWindow` 按已知模型家族兜底，本机服务不猜测。

## 持久化

- 会话、设置、项目、记忆、技能、定时任务、用量与协作项目均为本机文件/JSON。
- 写入采用临时文件加重命名；读取校验并保留回滚清单。
- 密钥通过系统安全存储加密；界面不回显明文。
- 日志脱敏后写 JSON 行；敏感字段不落日志。

## 创作台架构

- `StudioService` 负责动作、任务、模型调用、媒体与导出；`StudioStore` 是唯一写入口。
- 蓝图由文本模型生成并按 token 计费；确认蓝图后才写正文/分镜、做画面，这些步骤另计费用；候选稿、历史版本、覆盖范围、任务状态与交付记录都在作品内。
- 内嵌三套大师方法只来自 `src/main/creative-prompts.generated.ts`；本地只做可计算检查。
- 协作者使用统一动作契约：预览影响、确认后应用、可撤销、下游过期；不直接改用户文件。
- 漫剧：蓝图 → 大纲 → 分镜 → 画面 → 配音/配乐 → 时间线 → 检查 → 交付；画布只组织工作流，不替代时间线。
- 导出：图片、视频、音频、PDF、DOCX、EPUB 与工程包；FFmpeg、字体与引擎缺失时明确失败。

## 设计系统

- **主题**：墨夜（默认）与素纸（light），共享 token，不新增第三套主题。
- **色彩**：背景、表面、文字、分隔线、强调色与状态色都由 token 驱动；破坏性确认使用低饱和酒红。
- **字体**：界面 Manrope / 中文字体；正文与文档使用 Newsreader / Noto Serif SC；代码 IBM Plex Mono / JetBrains Mono。
- **布局**：左侧栏、中心对话/画布、右侧面板；创作台三栏；1px 分隔线；默认 2100×1200，适配 1280–3840。
- **组件**：页签、开关、状态标签、按钮、Composer、消息与轨迹、权限卡、画布、设置、灵动岛与创作台品牌；输入框、文本域与下拉统一使用 `--control-radius` 微圆角和 `--control-focus-shadow` 内嵌焦点环。
- **动效**：克制、短时，只用于状态变化与空间关系；减少动态偏好下不阻塞操作。
- **可访问性**：键盘可达、焦点可见、对比度达标、禁用斜体、窗口缩放不挤压。字号下限为 11px，`npm run audit:ui` 会检查裸字号声明。

样式集中在 `src/renderer/styles.css`、`components.css` 与各 feature 的 `*.css`。

## 安全边界

- **进程隔离**：contextIsolation、sandbox、无 nodeIntegration、禁用 webview；preload 白名单。
- **CSP**：生产包收紧 CSP；仅应用自身 `index.html` 与受控成品预览协议可加载。
- **路径**：文件工具限制在工作区；工作区外读取只允许显式附件；写入仍走权限。
- **命令**：危险命令、越界路径、外部副作用与终端 stdin 逐次审批；命令环境过滤敏感变量。
- **网页 / MCP / 桌面**：内容按不可信数据处理；浏览器只允许 http(s)，`window.open` 拒绝；MCP 信任按工作区；桌面敏感窗口拒绝。
- **密钥**：系统安全存储加密，界面不回显，日志脱敏。
- **网络**：订阅与搜索走明确服务商；本机/局域网模型不误走原生搜索；带 SSRF 防护。
- **已知边界**：两个 exe 未签名；外部引擎与 FFmpeg 不随包；真实模型质量与账号额度由服务商决定。

## 构建、测试与打包

```powershell
npm run typecheck
npm run audit:ui
npm run docs:check
npm run test:suite
npm run test:unit
npm run test:e2e
npm run dist:final
npm run smoke:packaged
```

- 核心套组：573 项单元加 88 条 Electron 流程，42 个功能域；清单在 `tests/core-coverage.json`（维护预算 600 / 96）。
- 测试截图写 `tmp/e2e-screens`；文档截图由 `npm run docs:capture` 生成到 `docs/screens`，全部 2100×1200 原图。
- 打包：`dist:final` 产出便携 exe 与安装包；流程见 [DEVELOPMENT.md](DEVELOPMENT.md)，交付证据见 [VERIFICATION.md](VERIFICATION.md)。