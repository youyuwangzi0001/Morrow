# Morrow 架构说明

Morrow 是 Electron 桌面应用：主进程负责系统能力与持久化，preload 提供白名单 API，renderer 用 React 19 / Zustand 呈现界面。本文只写当前实现的稳定边界；具体行为以源码与测试为准。

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

### 默认窗口

窗口目标为 **2100×1200 物理像素**，按主屏缩放比换算为 DIP；最小 1200×760。主窗口无边框；灵动岛是独立窗口。文档截图保持默认窗口，输出 2100×1200 物理像素原图。

任务栏图标：Windows 按 AUMID 缓存图标，旧 AUMID 的空白缓存不会因更换窗口图标而刷新；便携版使用独立 AUMID `studio.morrow.agent.desktop.portable`，安装版沿用与开始菜单快捷方式一致的 `studio.morrow.agent.desktop`。窗口图标来自 extraResources 的 ICO/PNG，路径比较统一用 `realpathSync.native` 展开 Windows 8.3 短名。

## 扁平源码结构

源码按职责扁平放在 `src/main`、`src/core`、`src/renderer/features`、`src/shared`。合并功能套组后不保留多层 `studio/`、`core/agent/` 目录；新增文件优先放到对应扁平目录。

- **协作域**：核心逻辑在 `src/core/collaboration.ts`；主进程服务在 `src/main/collaboration.ts`。成果、计划、验收、共享资源、成员名额、工具审计都在这两个文件内。
- **工具域**：`tool-kit`（公共层）、`tools`（注册表）、`tool-extra`（技能/MCP/任务）、`tool-files`（文件与文档）、`tool-media`（媒体/网页/搜索/浏览器/电脑/命令）。
- **渲染层**：每个功能域一个 `*.tsx` 组件 + 一个 `*.css`；跨 feature 复用的纯逻辑放 `*-core.ts`（如 `artifacts-core`、`files-core`、`studio-core`）。
- **共享层**：`shared/types`、`shared/contracts`、`shared/studio`、`shared/studio-assistant`、`shared/diff.d.ts`。
- **测试**：`tests/unit` 按功能域合并入口（协作任务统一 `collaboration.test.ts`）；`tests/e2e` 5 个流程文件；共用辅助平铺为 `helpers.ts`。

### 为什么保留少数分文件

- `feature-ipc` 被 `features`、`agent` 与多个服务复用；合并进 `features` 会让 `agent → features → agent` 形成循环。
- `*-core.ts` 被多个 feature 交叉引用；合并进单个组件文件会造成跨 feature 反向依赖。
- `main/workspace-isolation.ts` 属于工作区隔离域（`@core:workspace`），不是协作域内部实现。
- `studio-*.test.ts` 各自 mock 不同的 `electron` / `settings` 或独立 HTTP/TTS 生命周期；合并会把 mock 提升为整文件生效。

## 数据目录

解析顺序：`--data-dir` → `%LOCALAPPDATA%\Morrow\data-location.json` → 便携版 `portable.marker` → `%APPDATA%\Morrow`。

| 目录/文件 | 内容 |
|---|---|
| `sessions/` | 会话与消息 |
| `snapshots/`、`checkpoints/` | 文件/会话检查点 |
| `logs/main.log` | JSON 行日志，5MB 轮转保留 3 份 |
| `providers/`、`secrets.json` | 模型配置与加密凭据 |
| `settings.json` | 应用设置 |
| `studio/` | 作品、素材、版本、任务、回收站 |
| `usage/` | Token Activity |
| `schedules/` | 定时任务 |
| `skills/` | 用户技能 |
| `permissions/` | 审批日志 |
| `collaboration/` | 项目、工具审计、共享资源、成果 |

工作区内 `.morrow/` 存项目记忆、经验、技能、命令、角色、MCP 配置。

### 作品数据

`StudioStore` 是唯一写入口：原子读写项目 JSON、超长章节分片、版本快照、素材指纹、回收站索引。超长章节按内容哈希写入独立目录，`project.json` 成功后才清理旧分片；读取时逐章校验，只从历史版本恢复损坏章节。作品文件保存蓝图、章节、分镜、镜头、素材、时间线、任务、检查、审稿覆盖与交付；候选稿与版本在章节内部。

## IPC 与事件

- 基础 IPC + 精确 `feature:*` 注册；统一返回 `{ ok, data }` 或 `{ ok, error }`。
- 渲染层不直接使用 `ipcRenderer`；只通过 `window.morrow` 白名单调用。
- `RuntimeEvent` 带 `seq/runId/sessionId/at`；主进程先脱敏、持久化、登记检查点、更新灵动岛，再广播 `morrow:event`。
- 消息增量在主流式路径按 40ms 合并后广播，渲染层再按 24ms 兜底合并；`sessionLoad` 合并内存中的进行中消息并返回 `liveMessageId`，切回运行中的会话不会从下一个分片重新开始。
- 工具执行前校验执行身份（主代理 / Router / Worker）的 token、工具白名单、会话与运行、有效期和写入目录；「始终允许」按身份与尝试隔离并过期。允许/拒绝写入 `collaboration/tool-audit.jsonl`，不含工具参数或文件内容。

## Agent 循环

`core/agent` 负责：

- 组装系统提示词、角色、规则、技能与上下文；
- 调 Provider 流式生成，处理文本、思考、工具调用与错误；
- 执行工具、写检查点、广播事件、累计用量；
- 处理中断、重试、压缩与 Goal/Plan 模式；
- 维护权限签名与审批。

工具结果统一为 `ok/error`，错误带可读原因；工具参数按 schema 校验。文件工具限制在工作区内，工作区外读取只允许显式附件；写入仍走权限。

## 权限与审批

三档权限：

| 档位 | 行为 |
|---|---|
| 只读 | 拒绝写文件、命令、记忆与外部副作用动作 |
| 询问 | 工作区内写入/普通命令放行；危险命令、越界、外部动作、终端 stdin 逐次询问 |
| 完全访问 | 全部放行；只用于可信任务 |

审批卡显示工具、目标、影响范围与参数；危险动作没有“始终允许”。拒绝优先于允许；审批请求与执行身份绑定，过期或换身份后失效。

## 协作任务

工作模式没有独立的协作开关：主代理保留完整工具，简单工作直接完成；需要并行、隔离或独立验收时调用 `swarm` 派发成员。协作状态与主进程服务由 `core/agent`、`core/collaboration` 与 `main/collaboration` 驱动：

- **固定编号**：每次协作使用固定 `projectId` / `taskId`，每次重试生成新的 `attemptId`；状态记录来源（worker/verifier/user/system/legacy）、`revision` 与 `createdAt`，拒绝重复通知和晚到的旧 run。
- **执行前落盘**：协作动作在执行前写入 `collaboration/projects/<projectId>.json`；`pending` 可恢复，崩溃后遗留的 `running/executed` 转为 `uncertain` 等待人工核对，`done` 不会再次领取。会话文件只保存项目/任务编号。
- **独立工作副本**：Worker 在隔离副本中读写，结束后按任务文件清单合并；同文件同处冲突保留两版交给用户选择；用户未提交改动保留。
- **成果版本**：发布时把文件复制到用户数据目录的只读快照；依赖成员读取快照，不受发布者后续修改影响；记录谁用了哪一版，新版本让旧使用记录过期。
- **独立验收**：verifier 在候选版本上运行安全命令并检查必需文件；失败退回作者返工，超过次数交负责人；验收后交付文件变化会作废旧结论并重新验收。
- **并发与用量**：Worker 名额受本机并发限制；用量只统计展示，不设硬预算或自动停止。
- **卡住判断**：只有重复无成果、审批等待或稳定产出等有依据的情况才提醒；停止或继续等待不影响其他成员。
- **补充与重试**：成员卡片可向运行中成员发送补充要求；失败/停滞任务可单项重试或带新指令重新激活。
- **主界面驾驶舱**：`SuperAgentState.toolUseId` 记录最近一次派发的 swarm 工具调用，渲染层据此把完整状态挂回主对话里的成员卡片；历史协作只保留静态摘要。旧的右侧协作面板与输入框旁入口已移除，画布/浏览器打开时协作卡片仍留在对话中。

实现位置：`core/collaboration.ts`（成果、计划、验收、资源探测、卡住判断）与 `main/collaboration.ts`（存储、运行时、验收、共享资源、成员名额、工具审计）。

## 上下文与压缩

- 上下文账本保留最近用户消息、关键事实、工具结果与任务约束。
- 压缩 v2：确定性关键信息账本；不把摘要再次摘要；保留最近用户消息；压缩提示词带预算；Thrashing 保护避免反复压缩。
- 压缩后仍校验工具配对与首条角色；恢复时合并进行中消息，避免丢分片。
- 摘要消息记录其原文保留的消息 id；渲染层把「已压缩」标记放在保留段与后续内容的真实切点，而不是对话顶部。
- 断流重连：已有正文时断点续接；只有思考、还没有正文时重发原请求；空闲超时标记为可重试；重试耗尽在错误里注明重试次数。
- 模型只返回思考/空内容不视为任务完成：内核自动重试本步（最多 2 次），仍无正文时给出明确错误，不静默停止。

## Provider 与订阅

Provider 工厂支持 OpenAI 兼容、Anthropic 原生与 demo；本机模型走 OpenAI 兼容地址。订阅渠道使用独立适配器，处理 OAuth、本机登录、用量与模型目录；协议差异集中在 `src/main/subscriptions.ts`。订阅创建的 Provider 带 `managedBySubscription` 标记，只在订阅页管理，模型页只列官方 API 与自定义服务。模型上下文档位由用户按完整窗口选择（3 档），以 `contextEdited` 标记随模型保存；最大输出档位（32K / 64K / 128K，1M 上下文模型追加 256K）以 `maxOutputEdited` 保存；订阅恢复/同步时设置存储保留用户选择，不会被目录默认值覆盖。未实测渠道不显示已连接，不伪造额度。详细清单见 [REFERENCE.md](REFERENCE.md#订阅渠道)。

自定义服务的模型元数据可整体编辑（上下文 / 输出 / 思考档位与映射 / 图片输入 / 工具调用），写入同一套 `ModelInfo` 标记，所以刷新模型列表不会覆盖手动值。服务级另有 `ProviderConfig.retry`（`maxRetries` + `delays`）：`resolveRetryPolicy` 按「调用方覆盖 > 配置 > `DEFAULT_PROVIDER_RETRY`」合并并对越界值收敛，`createProvider` 把它交给具体 Provider 执行；4xx（429 除外）与主动中断不重试。网关不声明长度时 `fallbackModelWindow` 按已知模型家族兜底（与内置预设同源），本机服务不猜测。

## 持久化

- 会话、设置、项目、记忆、技能、定时任务、用量、协作项目均为本机文件/JSON。
- 写入采用临时文件 + 重命名；读取校验并保留回滚清单。
- 密钥通过系统安全存储加密；界面不回显明文。
- 日志脱敏后写 JSON 行；敏感字段不落日志。

## 创作台架构

- `StudioService` 负责动作、任务、模型调用、媒体与导出；`StudioStore` 是唯一写入口。
- 蓝图确认后才写正文/分镜并产生费用；候选稿、历史版本、覆盖范围、任务状态与交付记录都在作品内。
- 内嵌三套大师方法只来自 `src/main/creative-prompts.generated.ts`；本地只做可计算检查。
- 协作者使用统一动作契约：预览影响、确认后应用、可撤销、下游过期；不直接改用户文件。
- 漫剧：蓝图 → 分镜 → 画面 → 配音/配乐 → 时间线 → 检查 → 交付；画布只组织工作流，不替代时间线。
- 导出：图片/视频/音频/PDF/DOCX/EPUB/工程包；FFmpeg、字体与引擎缺失时明确失败。

## 设计系统

- **主题**：墨夜（默认）与素纸（light），共享 token；不新增第三套主题。
- **色彩**：背景/表面/文字/分隔线/强调色/状态色都由 token 驱动；破坏性确认使用低饱和酒红。
- **字体**：界面 Manrope / 中文系统字体；正文与文档使用 Newsreader / Noto Serif SC；代码 IBM Plex Mono / JetBrains Mono。
- **布局**：左侧栏、中心对话/画布、右侧面板；创作台三栏；1px 分隔线；默认 2100×1200，适配 1280–3840。
- **组件**：页签、开关、状态标签、按钮、Composer、消息与轨迹、权限卡、画布、设置、灵动岛、创作台品牌；输入框、文本域与下拉统一使用 `--control-radius` 微圆角和 `--control-focus-shadow` 内嵌焦点环，避免滚动容器裁切。
- **动效**：克制、短时、只用于状态变化与空间关系；减少动态偏好下不阻塞操作。
- **可访问性**：键盘可达、焦点可见、对比度达标、禁用斜体、窗口缩放不挤压。

样式集中在 `src/renderer/styles.css`、`components.css` 与各 feature 的 `*.css`；`npm run audit:ui` 检查裸字号/排版声明。

## 安全边界

- **进程隔离**：contextIsolation、sandbox、无 nodeIntegration、webview 禁用；preload 白名单。
- **CSP**：生产包收紧 CSP；仅应用自身 `index.html` 与受控成品预览协议可加载。
- **路径**：文件工具限制在工作区；工作区外读取只允许显式附件；写入仍走权限。
- **命令**：危险命令、越界路径、外部副作用、终端 stdin 逐次审批；命令环境过滤敏感变量。
- **网页/MCP/桌面**：内容按不可信数据处理；浏览器只允许 http(s)；`window.open` 拒绝；MCP 信任按工作区；桌面敏感窗口拒绝。
- **密钥**：系统安全存储加密；界面不回显；日志脱敏。
- **网络**：订阅与搜索走明确服务商；本机/局域网模型不误走原生搜索；SSRF 防护。
- **已知边界**：两个 exe 未签名；外部引擎与 FFmpeg 不随包；真实模型质量与账号额度由服务商决定。

## 扁平化与去重记录

2026-11-02 完成协作域合并：

| 合并 | 结果 |
|---|---|
| 核心协作 6 文件 → `src/core/collaboration.ts` | 成果、计划、验收、资源探测、卡住判断；`taskKey` 只保留一份 |
| 主进程协作 8 文件 → `src/main/collaboration.ts` | 成果存储、运行时、项目存储、验收、共享资源、成员名额、工具审计；`inside`/`sha256`/`isBinary` 去重，单例按服务重命名 |
| 8 个协作单元入口 → `tests/unit/collaboration.test.ts` | 保留独立 `describe` 作用域 |
| 单元辅助 6 文件 → `tests/unit/helpers.ts`；E2E 辅助 2 文件 → `tests/e2e/helpers.ts` | 删除 `helpers/` 子目录 |
| 基准夹具 `collaboration-benchmark/` → `tests/fixtures/collaboration-benchmark.ts` + `tests/fixtures/login-demo/` | 少一层目录 |

本轮追加合并：`a11y.tsx` → `App.tsx`；`connectors-core`/`projects-core`/`skills-core` → 对应组件；`main/embedding.ts` → `main/memory.ts`；`motion`/`shortcuts` 测试 → `shared.test.ts`，provider 续接/结构化输出测试 → `core-runtime.test.ts`，工具并行测试 → `core-tools.test.ts`。保留但未合并的原因见上文“为什么保留少数分文件”。扫描方法：导出符号按名称聚类、检查工具注册/进程启动/持久化/压缩/搜索/技能安装/渲染层 core，并用测试回归确认行为一致。

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

- 核心套组：532 项单元 + 85 条 Electron / 41 域；清单 `tests/core-coverage.json`。
- 测试截图写 `tmp/e2e-screens`；文档截图由 `npm run docs:capture` 生成到 `docs/screens`，全部 2100×1200 原图。
- 打包：`dist:final` 产出便携 exe + 安装包，`deliver/` 只保留两个文件与用户数据；详见 [DEVELOPMENT.md](DEVELOPMENT.md) 与 [VERIFICATION.md](VERIFICATION.md)。
