# Morrow v0.1.0 验收记录

> 日期：2026-10-26 · 版本：0.1.0 · 平台：Windows 10/11 x64 · 交付形态：单文件便携版 + NSIS 安装包
>
> 本轮主题：Qoder 真账号闭环、模型元信息与真实思考档位、上下文上限真实可调、终端与主区域/画布滚动条完全对齐（含按需显示）。

## 1. 结论

- 类型检查：`npm run typecheck` **0 error**（主进程 + 渲染层）。
- UI 令牌审计：`npm run audit:ui` **通过**，50 个 CSS + 66 个 TSX，0 处裸字号/字重/行高/字距（文档预览 iframe 白名单除外）。
- 单元测试：**14 个套件 / 951 个用例**（943 passed + 8 skipped；按环境跳过真实引擎/本地模型集成）。
- 端到端：**17 个套件 / 209 个用例**（上一轮全量基线 208；本轮新增模型元数据/上下文上限 1 例，未重跑全量）。上一轮非打包 **197 passed + 11 skipped**、打包 **5/5**；本轮定向 E2E **5/5**（DeepSeek 档位、旧模型迁移、推理映射、上下文上限、终端滚动条；终端滚动条最终版复跑 1/1，验证空终端隐藏、输出 80 行后出现；内置浏览器滚动条注入复跑 1/1），打包版 **5/5**（17.3s，r017 便携包实际解压启动）。ChatGPT 内置浏览器登录表单 1/1，本机 Codex 真账号导入 connected/quota；Qoder/Kimi/GLM/MiniMax/Step/Command Code/Cline 内置登录/授权页逐项打开（Antigravity 缺 secret、OpenCode 本机 Key 除外）。
- 真实断点：真实项目测试发现的 **6 个阻断点**全部修复并补回归（Codex 工具参数、登录端口复用、灵动岛跟随会话、当前模型视觉、登录按钮可重试、assistant 历史消息协议），见 §4。
- 内置浏览器真实登录：Morrow 内置 BrowserWindow 加载 auth.openai.com，完整显示“欢迎回来”邮箱/Google/Apple/Microsoft/手机登录表单；User-Agent/UA-CH 对齐 Chrome 后通过 Cloudflare。本机 `~/.codex/auth.json` 真实导入返回 connected + quota（未输出凭据）。所有渠道统一走内置窗口：ChatGPT/Kimi/GLM/Command Code/Cline 显示登录/授权页，MiniMax/Step 显示授权/校验页，Antigravity 需 `MORROW_ANTIGRAVITY_CLIENT_SECRET`，OpenCode 为本机 Key 登录。
- Qoder 真账号闭环：内置窗口完成“允许登录 → 继续 → 登录成功”，设置页即时显示已连接、额度与账号接口返回的 **15 个 chat 模型**。模型、上下文档位与思考档位全部来自账号接口 `/algo/api/v2/model/list?Encode=1`：`context_config` 提供 **200K / 400K / 1M**（默认 200K），`thinking_config` 提供每个模型真实档位；不再保留任何硬编码 Qoder 模型表。Agent 用 `deepseek-v4.1-flash` 与 `qwen-3.8-flash` 真实调用均返回“链路正常”（`run_finished` reason=complete，无错误）；另以账号返回的模型完成 **max 思考 + 400K 上下文**真实请求，会话模型与用量均按 400K 生效。
- 模型契约：`ModelInfo` 增加 `reasoningEfforts` / `contextOptions` / `defaultContextWindow`，`ModelRef` 增加 `contextWindow`；模型选择器只显示原始模型名，思考强度只列模型真实档位，不支持时显示“不支持思考”。DeepSeek V4.1 Flash 为 off/low/high/max、V4 Pro 为 high/max；Kimi K3/K3.1/K2.8 为 low/high/max；Claude 与 GPT-6 均包含 max；未知模型只保留“自动”。Step/Command Code/OpenAI 兼容 `/models` 会读取真实元数据；Qoder/Kimi/GLM 等订阅协议不再把 Morrow 的固定六档硬塞给上游。
- 交付包：**5 个分发文件 / 345.81 MiB**；便携版 196.41 MiB，安装包 149.39 MiB，未签名。

## 2. 本轮 UI/UX 收口

| 项目 | 结果 | 证据 |
|---|---|---|
| 权限卡令牌 | 字体族、字号、字重、行距全部提取为 `--font-permission*` / `--text-permission-*`；真实审批卡断言 14px/600/18.9px、说明 12.5px/450/21.5px、风险 10px、按钮 12.5px/500/34px | `tokens.css`、`activity.css`、`DESIGN-SYSTEM.md` §3.4；`14-journey` 权限卡用例 |
| 应用字号 | 可选 **12–15，默认 14**；`--fs-ui` 最低 12px | `SettingsModal.tsx`、`settings-store.ts`、`models.ts`；`01-ui-smoke` 外观用例 |
| 代码字号 | 可选 **11–14，默认 12**；代码、终端、diff、等宽数字共用 `--fs-code` | 同上；`CODE_FONT_FAMILY` 默认 JetBrains Mono |
| 代码字体 | 默认 **JetBrains Mono**，可切 IBM Plex Mono / 系统等宽；`data-code-font` 默认 `jetbrains` | `tokens.css`、`base.css`、外观设置；编辑器 E2E 断言 |
| 浏览器页签 | 24px 高、5px 微圆角、金色选中边框、surface 底，取消顶部圆角与下划线 | `browser.css`；`07-browser` 多标签用例断言 24px/5px |
| 画布页签 | 与终端/浏览器同款；取消方形贴顶与金色下划线 | `Canvas.css`；`10-rounds` 画布页签用例断言 24px/5px/金色边框 |
| 其它页签 | Git 视图、项目视图、Office 工作表全部统一到同一组 `--tab-*` token | `git.css`、`ProjectsPanel.css`、`preview.css`；对应 E2E 断言 |
| 订阅详情 | 以 ChatGPT/Codex 页为基准：标题 20px/500、说明 12.5px、正文 12.5px、连接项标题 13px、主按钮 34px/13px、面板内小按钮 28px/12px；Qoder/Kimi/GLM 等全部共用 | `tokens.css`、`SettingsSubscriptions.css`、`DESIGN-SYSTEM.md` §6.11；`08-settings` 订阅排版用例 + 双主题截图 |
| 默认模型卡 | 从内容区移入页面标题栏，与说明文字同一行顶部对齐，减少空白 | `SettingsModal.tsx`、`SettingsModal.css`；`settings-title-models-*.png` |
| 改动卡 | 长路径改为单行省略，展开箭头固定在同一行，不再被挤到第二行 | `Transcript.css`；`10-rounds` 超长路径用例 |
| diff 字重 | 行号、加减号、`+27/-8` 统计与代码统一 `--fs-code` / `--code-font-weight` / 0 字距；均为 12px/400，不再出现数字比代码显粗或模糊 | `DiffView.css`、`Transcript.css`；`10-rounds` 改动卡用例断言 computed style |
| 上下文浮层 | 紧贴圆环按钮上浮，宽度、圆角、背景与字号对齐模型上拉菜单 | `ContextMeter.tsx`、`Composer.css`；`10-rounds` 上下文用例 |
| 开关 | 设置、记忆中心、任务经验、技能卡全部改为 34×20px 微圆角矩形；轨道 5px、滑钮 4px，统一 `--toggle-*` token | `tokens.css`、`ui.css`、`EvolutionSuggestions.css`、`MemoryCenter.css`、`SkillsPanel.css`；`08-settings` 外观 token 用例 |
| 状态标签 | 项目、Git、订阅、记忆、研究、定时任务、文件树、侧栏、浏览器等文本徽标统一为 4px 微圆角矩形，统一 `--chip-*` token；项目路径独占一行，信息区增加间距 | `tokens.css`、`ProjectsPanel.css`、`git.css`、`SettingsSubscriptions.css` 等；项目页截图 |
| WSL 终端 | 设置 → 终端检测 WSL 与发行版；无发行版时显示灰色说明，支持「重新检测」；有发行版时使用真实 PTY | `terminal-manager.ts`、`SettingsModal.tsx`；`11-terminal-git` 终端用例 |

截图：

- [设置 · 模型](../guide/screens/05-settings-models-dark.png)
- [设置 · 订阅 · ChatGPT/Codex](../guide/screens/06-subscriptions-dark.png)
- [权限卡](../guide/screens/03-permission-card-dark.png)
- [画布与页签](../guide/screens/04-editor-canvas-dark.png)
- 订阅详情：[ChatGPT/Codex](../guide/screens/06-subscriptions-dark.png)；浅色主题截图在 E2E 中生成，未纳入交付图集。

## 3. 真实用户卡点修复

| 卡点 | 修复 | 证据 |
|---|---|---|
| 本机/局域网 Ollama、LM Studio、网关被误判为「缺少 API Key」 | 统一 `isLoopbackHost` / `isPrivateNetworkHost` / `isLocalServiceUrl`；回环、`10.x`、`172.16–31.x`、`192.168.x`、`.local` 允许空 Key；错误文案改为「公网服务需 Key，本机/局域网可留空」 | `shared/models.ts`、`core/providers/index.ts`、`model-sync.ts`、`SettingsModal.tsx`；`shared.test.ts` 本机/私网分类用例 |
| 模型文件在下载目录时只能手动搬进引擎目录 | `resolve-model-files` 自动复制到引擎模型目录，重名自动加序号，返回 `copied`；表单提示同步更新 | `main/features/media.ts`、`MediaTab.tsx`；`16-media` 应用内模型用例 |
| 只有 ComfyUI 时「添加本机模型」永久禁用，被迫离开应用准备 JSON | 应用内表单支持 ComfyUI：粘贴 API 工作流 JSON、输出节点、输出类型、可选提示词节点；无可用引擎时给出明确出口提示 | `MediaTab.tsx`；`16-media` ComfyUI 工作流用例 |
| 真实技能包带 `scripts/` 时整包拒绝 | 脚本/可执行文件改为跳过并在安装结果中报告，Markdown/资源正常安装；SKILL.md 与大小/数量/zip-slip 安全限制保留 | `skills-service.ts`、`SkillsPanel.tsx`；`reveal.test.ts` 文件夹/zip 安装用例 |
| 长报告 >2MB 无法上画布 | 画布文本上限提高到 8MB，读取端同步 8MB 并保留截断提示 | `meta-tools.ts`、`ipc.ts`、内置技能说明 |
| 订阅页各渠道字号/按钮不一致 | 统一顶层 token 与详情面板布局（见 §2） | `SettingsSubscriptions.css`、`08-settings` 用例 |

## 4. R33 真实使用断点修复

本轮用真实项目跑通「新建站点 → 开发 → 预览 → 修改」链路，并追加订阅协议热修复，共修复 6 个阻断点：

| 断点 | 根因 | 修复 | 证据 |
|---|---|---|---|
| 连接 ChatGPT/Codex 订阅后，任务卡在「请补上 name 参数后重试」，`read_skill` 实际收到 `{}` | 代理只在 `response.output_item.done` 读取工具参数；部分响应把完整参数放在 `response.function_call_arguments.done`，流式增量组装时丢失 | 流式/非流式都消费 `function_call_arguments.done`；以 `output_item.added` 的增量为底，done 作为权威参数；`read_skill` 缺 `name` 时返回可用技能清单与重试提示，而不是直接失败 | `codex-proxy.ts`、`skills-tools.ts`；`subscriptions.test.ts` 的 done 事件参数用例、`tools.test.ts` 的缺少 name 回退用例 |
| 首次点击「浏览器登录 ChatGPT」不弹浏览器；再次点击提示 `address already in use`（127.0.0.1:1455） | 首次登录在弹窗前中断，回调服务器未复用，第二次重复 `listen` 同一端口 | 登录流程改为单例：保存授权 URL 与同一个 Promise，重复点击重开同一授权页而不是重开端口；端口被占用时返回明确文案 | `subscriptions.ts`；`08-settings` 订阅连接用例 |
| 多对话切换后，灵动岛不显示当前任务计划、耗时与进度条，只显示「随时待命」 | 灵动岛仅在开始运行或收到运行事件时更新，未跟随主窗口当前会话 | 新增 `island:sync-session`；渲染层在启动、切换、新建、切换工作区/演示/分支后同步；主进程按当前会话生成运行中/等待/待命快照，非当前会话事件不再覆盖 | `island.ts`、`ipc.ts`、`preload/index.ts`、`store.ts`、`agent-service.ts`；`01-ui-smoke` 灵动岛实时跟随、删除会话后跟随用例 |
| 当前使用 DeepSeek 或 ChatGPT 订阅开发时，审看媒体仍优先调用已配置的本地视觉模型 | `describe_media` 固定走 `visionProvider` 本地配置；Codex 订阅模型目录未声明 `supportsVision` | 当前模型声明 `supportsVision` 时直接用当前 Provider 处理图片；失败才回退本地并标注 fallback；为 Codex 订阅模型补齐视觉标记 | `media-service.ts`、`media-tools.ts`、`models.ts`、`subscriptions.ts`；`16-media` 当前模型视觉用例 |
| 点击「浏览器登录 ChatGPT / Qoder」后浏览器无响应、空白「无标题」页，关闭后弹出 Edge 跨权限重启提示 | 本机 `EnableLUA=0`；Morrow 进程实测为 **Low** 完整性（S-1-16-4096），系统 Edge 主进程为 **High**（S-1-16-12288）。跨完整性的外部 Edge 会白屏并弹重启提示；Morrow 清单本身是 `asInvoker`，不是主动提权 | 订阅登录全部改到 **Morrow 内置 BrowserWindow**；登录 session 的 User-Agent/UA-CH 对齐 Chrome，Cloudflare 直接放行；用户完成登录后由原有回调/轮询更新订阅页，成功后收起窗口；复制链接保留。不再依赖系统 Edge，也不再创建计划任务 | `src/main/services/login-window.ts`、`external-open.ts`、`features/index.ts`、`SubscriptionTab.tsx`、`external-open.test.ts`；ChatGPT 登录表单 1/1、真实 Codex 登录导入 connected/quota、7 个渠道内置页验证 |
| ChatGPT 订阅首轮回复后立刻 HTTP 400：`Invalid value: 'input_text'`，要求 `output_text` | `contentToInput` 对所有角色都发送 `input_text`；Responses 要求 assistant 历史内容使用 `output_text` | 按角色映射：user/system 用 `input_text`，assistant 用 `output_text`，refusal 保留 `refusal`；补协议单测 | `codex-proxy.ts`；`subscriptions.test.ts` 的 assistant 历史内容用例 |

本轮改为内置浏览器登录后重新执行单元门禁（**951**）并重打包；全量 E2E 沿用上一轮基线（见 §6），本轮追加定向 E2E 与真账号实调（见 §4.1–§4.3）；交付包哈希见 §7。

## 4.1 2026-10-26 追加修复（Qoder 真账号闭环）

| 问题 | 根因 | 修复 | 证据 |
|---|---|---|---|
| Qoder 内置登录点击“继续”无反应；关掉窗口后仍弹 Edge“无标题”/提权提示 | 应用级 `web-contents-created` 给所有 webContents 安装了 `will-navigate`：登录页的同页导航被拦截，并被转交给外部 Edge | 登录 session 跳过全局导航护栏；登录窗口及 OAuth 子窗口安装自己的 http(s) 白名单（`isLoginSession` + `installLoginNavigation`），子窗口同样放行 http(s) popup | `login-window.ts`、`index.ts`；真实 Qoder 设置页登录 **1/1**，登录页→继续→登录成功→已连接；7 个渠道内置登录页 smoke |
| Qoder 登录成功后 Agent 首次调用 HTTP 400：`Range of max_tokens should be [1, 32768]` | Qoder 上游硬限制 32768，Provider 声明 128k，Agent 按 128k 传入 | Qoder 模型 `maxOutput` 收敛为 32768；代理侧再次截断 `max_tokens`；补充限免模型与回归单测 | `qoder-proxy.ts`、`qoder-subscription.ts`、`subscriptions.test.ts`；Agent `deepseek-v4.1-flash` / `qwen-3.8-flash` **2/2** 返回“链路正常” |
| 输入栏模型/思考强度顺序、终端底栏与滚动条不一致 | 模型选择在右、思考强度在左；终端底部保留 20px 状态栏；xterm 使用 14px 自带滚动条 | 输入栏改为“模型 → 思考强度”；删除终端状态栏；滚动条统一到顶层 `--scrollbar-*` token，覆盖 xterm 自定义 slider 并隐藏原生箭头；最终尺寸与颜色见 §4.2 | `Composer.tsx`、`TerminalPanel.tsx`、`terminal.css`、`tokens.css`；composer E2E **1/1**、terminal E2E **1/1**、双主题截图 |

## 4.2 2026-10-26 追加修复（模型契约与滚动条）

| 问题 | 根因 | 修复 | 证据 |
|---|---|---|---|
| 终端滚动条和上下两个小三角重叠；4px 滑块显得比主区域/画布更细；空终端也常显滚动条 | ① xterm 的 `.xterm-viewport` 原生滚动条仍在渲染上下箭头，与自定义 `.xterm-scrollable-element` 滑块叠在一起；② 主区域/画布使用 Chromium 原生 overlay 滚动条，在 1.5 DPR 下 thumb 为 9 设备像素 ≈ **6 CSS px**，而终端自定义滑块只有 4px；此前的渐变与低圆角又造成炫光、上下无圆角；③ iframe / 内置浏览器仍使用 `scrollbar.ts` 里的旧渐变与 2px 圆角；④ 自定义 slider 被强制 `opacity:1`，没有内容溢出时也常显 | 隐藏原生 viewport 滚动条与箭头，只保留一个 xterm 自定义滑块；以原生 overlay 的 6 CSS px 为基准统一到顶层 token：轨道 8px、**实色滑块 6px**、`--r-full` 全圆角、无渐变/炫光、最小长度 36px；显隐交还 xterm 的 `visible`/`invisible` 类，只有内容超出当前高度时才显示；主区域、画布、代码编辑器、终端、iframe 与内置浏览器全部共用同一套数值 | `terminal.css`、`base.css`、`tokens.css`、`CodeEditor.css`、`shared/scrollbar.ts`；`11-terminal-git` 断言 6px/999px/`rgb(138,111,66)`/`background-image:none`/原生滚动条 `none`，空终端隐藏、输出 80 行后显示，复跑 **1/1**；`07-browser` 断言注入宽度 8px、无渐变，复跑 **1/1**；单元测试锁定 iframe 规则 |
| 模型选择器带有“限免/订阅/上下文”说明；思考强度固定为 Morrow 六档，DeepSeek 选 medium 会 400 | 档位来自 UI 常量而非模型元数据；Qoder 模型标签带营销后缀 | 新增 `reasoningEfforts` / `contextOptions` / `defaultContextWindow` 元数据；选择器只显示原始模型名；思考强度只列模型真实档位，不支持时显示“不支持思考”；请求前统一收敛，非法历史档位退回 auto | `shared/models.ts`、`shared/types.ts`、`Composer.tsx`、`qoder-proxy.ts`、`step-protocol.ts`、`kimi-protocol.ts`、`model-sync.ts`、`settings-store.ts`；`03-context` 定向 E2E 断言 DeepSeek 无 medium/xhigh |
| 上下文长度只能看不能调；Qoder 出现 32K/64K/128K/200K 等自造档位 | 模型元数据没有可调上下文档位；未读取 Qoder 账号接口的 `context_config`，由前端自行生成档位；Qoder 代理也没有接收会话级覆盖 | **删除全部硬编码 Qoder 模型表与自造档位**；登录/恢复时读取账号模型目录，`context_config` 映射为 **200K / 400K / 1M**，`is_default` 作为默认值；设置页每个 Qoder 模型可单独选择上下文；输入栏“上下文上限”按 `contextOptions` 显示；会话保存覆盖值，代理通过 `x-morrow-context-window` 写入 `model_config.max_input_tokens` | `qoder-subscription.ts`、`qoder-proxy.ts`、`SubscriptionTab.tsx`、`ContextMeter.tsx`、`Composer.tsx`、`store.ts`、`agent-service.ts`、`openai-compat.ts`；Mock E2E 断言 65,536/400,000 请求头；真实账号 **400K + max** 返回正常 |
| 订阅/API 模型元信息不统一 | 各订阅协议各自硬编码标签与能力 | Step 读取 `/models` 的 `reasoning_effort_support_list`；Command Code/OpenAI 兼容 `/models` 读取 `reasoning_efforts` 等字段；保存 Provider 时统一补全已知家族档位；未知家族只保留自动 | `step-protocol.ts`、`command-code-protocol.ts`、`model-sync.ts`、`settings-store.ts`、`agent-subscription-common.ts`；单元 **951** 例 |

### 4.3 模型能力调研与修正

按各服务商公开模型/API 文档逐族核对上下文上限与思考档位，修正内置目录并把同一套 `reasoningEfforts` / `contextOptions` 契约用于订阅与 API 模型；未知模型只保留“自动”，不猜测。核查与实测时间：2026-10-25 / 2026-10-26。

| 模型族 | 上下文 | 思考档位 | 本轮修正 | 依据 |
|---|---|---|---|---|
| DeepSeek V4.1 Flash | 1,000,000 | off / low / high / max | 上下文由 1,048,576 修正为 1,000,000；`none` 在 Morrow 中显示为 `off` | DeepSeek API 文档 |
| DeepSeek V4 Pro | 1,000,000 | high / max | 不提供 low/medium；不再与 Flash 共用档位 | DeepSeek API 文档 |
| Kimi K3 / K3.1 Pro / K2.8 / for Coding | 1,048,576；256K/高速变体 262,144 | low / high / max | 补齐 **max**；区分 1M 与 256K 模型；Kimi 订阅统一 low/high/max | Kimi Code 模型文档 |
| Claude 5.5（Fable / Opus / Sonnet / Haiku） | 1,000,000 | low / medium / high / xhigh / max | 补齐 low…**max** 五档；Haiku 也标记为支持思考（`off` 时不发 thinking） | Anthropic 模型概览 |
| GPT-6.1 Sol / GPT-6 系列 | 1,050,000 | low / medium / high / xhigh / max | 补齐 **max**；不发送 none/minimal | OpenAI 模型文档 |
| Qwen3.8 Max / Flash Next | 1,000,000 | low / medium / xhigh | 去掉不支持的 high/max；上游对 high/max 统一映射到 xhigh | 阿里云百炼模型文档 |
| GLM-5.3 / GLM-5.3 Flash | 1,000,000 | low / high / max | 档位收敛为三档；**GLM-5.2 从 API、GLM Coding Plan、Cline 与模式推断中全部移除**（官方模型列表已无此型号） | 智谱开放平台 |
| MiniMax M3 / M3.1 Flash | 1,000,000 | low / medium / high / xhigh / max | 两代 M3 均为 1M；旧版 200K 模型保留 200K，不统一篡改 | MiniMax 开放平台 |
| Gemini 4 Argon / 3.8 Flash | 1,048,576 | low / medium / high | 只保留三档，不发送 xhigh/max | Google AI 模型文档 |
| Grok 4.6 / 4.7 | 500,000 | low / medium / high / xhigh | 补齐 xhigh，默认 high | xAI 模型文档 |
| Muse Spark 1.3 | 1,048,576 | low / medium / high / xhigh | 使用四档，不发送 max | Meta 模型文档 |
| Qoder 订阅模型 | 账号 `context_config`：200K / 400K / 1M，默认 200K | 账号 `thinking_config.enabled.efforts` | **删除静态模型表**，15 个 chat 模型与档位全部实时读取；设置页逐模型调整上下文 | Qoder 账号接口实测 |
| 未知 / 自定义 API 模型 | 由 `/models` 或设置决定 | 仅“自动” | 不猜测档位；旧设置中的非法档位回退 auto | 运行时元数据 |

## 5. 代码库扁平化

| 项目 | 变化 |
|---|---|
| 单元测试 | 22 → **14 个文件**：8 个订阅协议 + qoder/relay 合并为 `subscription-protocols.test.ts` / `subscriptions.test.ts`，另新增 `external-open.test.ts`；用例数 934 → **951** |
| E2E | 21 → **17 个文件**：设置标题/UI token/订阅并入 `08-settings`，模型表单并入 `16-media`；用例数 204 → **209**（本轮 +1 模型元数据/上下文） |
| Feature 注册 | `discovery` / `permissions` / `git` / `subscriptions` / `schedules` 五个只被注册表引用的模块并入 `main/features/index.ts`，统一复用 `payloadOf` |
| 死代码 | 删除 17 个无引用导出、5 个死频道常量、死常量/死兼容分支 |
| 重复实现 | 统一 13 处 `errorText`、画布版本时间/大小格式化、`formatBytes`（core/project/renderer）、本机/私网 URL 判定、4 处 feature payload 解析 |
| 规模 | 源码 **314 个文件**（其中 293 个 ts/tsx/css，**125,725 行**：ts 71,382 / tsx 29,228 / css 25,115）；测试 **66 个文件**（14 单元 + 17 E2E + helpers/fixtures）；文档 31 个文件（10 个 Markdown + 12 张指南图 + manifest/验收 JSON） |

## 6. 验证门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm run audit:ui` | 50 CSS + 66 TSX，0 裸排版值 |
| `npm run test:unit` | 14 文件；951 用例；**943 passed + 8 skipped** |
| `npx playwright test`（全量） | 17 文件；209 用例（上一轮 208 基线 + 本轮 1 例）；**未重跑** |
| 定向 E2E（本轮） | DeepSeek 真实档位 1/1、旧模型迁移 1/1、推理映射/费用 1/1、上下文上限 1/1、终端面板/滚动条 1/1；**5/5 passed**（全量 E2E 未重跑）；终端最终版复跑 **1/1**（空终端隐藏、80 行输出后显示）；内置浏览器滚动条注入复跑 **1/1** |
| 登录渠道实测（本轮） | Qoder 真账号内置登录 UI **1/1**；账号模型目录 **15** 个 chat 模型、上下文档位 200K/400K/1M；Qoder Agent 真调用 `deepseek-v4.1-flash` / `qwen-3.8-flash` **2/2**，另完成 **max + 400K** 真实请求；7 个渠道（Codex/Kimi/GLM/MiniMax/Step/Command Code/Cline）内置登录页 smoke 全部打开，Antigravity 按预期提示缺少 OAuth secret；OpenCode 本机 Key |
| 打包版 E2E | 5 用例；**5/5 passed**（17.3s，r017 便携包实际解压启动） |
| 内置浏览器登录 | 内置窗口加载 ChatGPT 登录表单 **1/1**；本机 Codex 登录导入 connected + quota；Qoder/Kimi/GLM/Command Code/Cline 内置页逐项打开 |
| 单元/打包耗时 | 单元 11.7s；全量 E2E 11.1m；打包 E2E 17.3s |

## 7. 交付物

| 产物 | 大小 | SHA-256 |
|---|---|---|
| `Morrow-0.1.0-portable.exe` | 205,955,584 B / 196.41 MiB | `d6b45b53f79e8ec8b5a89e2bde2e7cf030dc03fffbc1cb7622b09ca137780a23` |
| `Morrow-0.1.0-setup.exe` | 156,649,780 B / 149.39 MiB | `f96432257cbf060acec3bfaadeec834b0a7ff1c11706bb7606060ffc1a7a567d` |
| `使用说明.txt` | 3,386 B | `3e08d67aaf664091ba784c50bec68bb5627a2818c639ab246f91a2baf4ce4e55` |
| `SHA256SUMS.txt` | 338 B | `77224e04e44c912b284c2221de2c4655667a46b1fe3b9b11430b343b18399a77` |
| `LICENSE` | 1,070 B | `5a147a0421a711a0b44a5ecab6f6b0e8f0002dca17a8ecccef1599faaf70aa97` |
| **分发合计** | **5 文件 / 362,610,158 B / 345.81 MiB** | 未签名（signed:false） |

源码包 `Morrow-0.1.0-source.zip` 单独附带：12,564,440 B / 11.98 MiB，SHA-256 `75635272870afc97fa84429189556a13250daeaf0f2140ae6ee2e5977357aa84`，侧车 `Morrow-0.1.0-source.zip.sha256`；源码包内验收文档是打包前快照，最终哈希以侧车为准；不计入上表五件分发文件。

安装包载荷：**331 个文件 / 55 个目录**，包含 `Morrow-app.exe`、`resources/app.asar`、`node-pty` 原生模块；与便携版共用同一份 `win-unpacked`。

本轮便携版使用 **r017** 运行时目录，并通过内嵌应用 zip 的 SHA-256 戳记校验缓存；旧的 r010–r016 运行时缓存、历史 `tmp`/`release` 打包缓存与测试残留已全部清理，`deliver/` 只保留当前五个分发文件、源码包与用户数据 `Morrow Data`。订阅登录全部在 Morrow 内置 BrowserWindow 完成，内置 Chromium 以 Chrome UA/UA-CH 请求头通过 Cloudflare；不再依赖系统 Edge。缓存不属于分发文件，也未计入 `SHA256SUMS.txt`。`deliver/Morrow Data` 为用户数据，打包脚本保留但从不计入交付统计。

分发文件不包含用户数据、`.morrow-runtime-*` 缓存、日志或密钥；`deliver/Morrow Data` 是用户数据，打包脚本会保留但不会计入交付统计。

## 8. 验证边界（如实记录）

- Qoder 已用本机真实账号完成内置浏览器登录、设置页状态回写、账号模型目录读取（15 个 chat 模型 / 200K、400K、1M 上下文档位）、Agent 真实调用，以及 **max 思考 + 400K 上下文**的真实请求；Kimi、GLM、MiniMax、Step、Command Code、Cline、Antigravity、OpenCode 在本机没有可用账号，本轮只验证内置登录页、真实端点实现、协议单测、设置页 UI 与恢复路径，没有把未连接显示成已连接，也没有编造额度。
- 思考档位只来自服务商元数据或可核对的模型族目录；未被公开的档位只显示“自动”，不猜测。上下文上限目前只对声明了可调档位的模型（Qoder 及 `/models` 明确返回档位的 Provider）开放。
- 真实 Codex 订阅用例默认跳过（`MORROW_SUBSCRIPTION_REAL=1` 开启）；真实本地模型/多媒体用例默认跳过，需要自备引擎、模型与 ffmpeg。
- 多媒体高分辨率/长视频依赖 NVIDIA 显卡与显存；16GB 显存下代码模型与视频模型需分阶段执行。
- 终端使用真实 PTY；应用退出时终端与后台任务会结束。
- 回退只覆盖 Morrow 通过写文件工具修改的文件；命令直接生成的文件不在范围内。
- 便携版/安装包未签名，首次运行可能触发 SmartScreen；彻底消除需要受信任的代码签名证书。
- 更改数据目录需要重启；迁移不包含浏览器缓存/登录状态，恢复默认目录不会自动合并两边数据。

## 9. 历史

R1–R32 的详细轮次记录已归档，不随交付发布。本轮以本文件为准。
