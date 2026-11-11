# Morrow 参考手册

本页只放查询型信息：模型与订阅、媒体引擎、内置技能、快捷键、数据路径与环境变量。操作步骤见 [GUIDE.md](GUIDE.md)，创作链路见 [STUDIO.md](STUDIO.md)。

## 模型与 Provider

Morrow 的 Provider 协议只有三类：

| 类型 | 用途 | 说明 |
|---|---|---|
| `openai-compat` | 大多数云端与本机模型 | Chat Completions / Responses 兼容接口；可填任意 Base URL、API Key 与模型 ID |
| `anthropic` | Anthropic 原生消息协议 | 支持 thinking、工具调用与流式事件 |
| `demo` | 内置离线演示 | 不消耗额度；只用于演示与测试，不冒充真实模型 |

常见接入：

- **云端 OpenAI 兼容**：OpenAI、DeepSeek、Kimi、GLM、MiniMax、Qwen、MiMo、xAI、OpenRouter、Command Code、OpenCode 等，以服务商当前接口为准。
- **Anthropic 原生**：Claude 系列；不提供 Claude 账号登录，只接 API Key 或订阅协议。
- **本机模型**：Ollama、llama.cpp、LM Studio，使用本机 OpenAI 兼容地址。
- **订阅渠道**：见下文，与普通 Provider 分开管理。

思考强度只显示模型真实支持的档位；未知模型只保留“自动”。可读取长度、最大输出与价格以模型配置为准；服务商没有返回用量时，界面标为估算。

## 订阅渠道

| 渠道 | 主要接入方式 | 说明 |
|---|---|---|
| ChatGPT / Codex | 本机导入 / OAuth / 用量接口 | 支持账号模型目录与额度读取 |
| Qoder | 账号模型目录 | 本机未完成登录实测；不会显示假额度 |
| Kimi Code | 登录页 / 协议实现 | 以官方渠道为准 |
| GLM Coding Plan | 中国区 / 国际区 | 区分 z.ai 与 bigmodel.cn |
| MiniMax Code | 中国区 / 国际区 | 区分 minimax.cn 与 minimax.io |
| Step Plan | 中国区 / 国际区 / 开放平台 Key | 以官方渠道为准 |
| Command Code | Claude / 通用模型目录 | 使用订阅 Key |
| Cline Pass | API Key | 账号信息按 token 读取 |
| OpenCode | OpenCode Zen API Key | 模型目录以服务商为准 |
| Google Antigravity | OAuth | 不内置 OAuth secret；需设置 `MORROW_ANTIGRAVITY_CLIENT_SECRET` |
| OpenDesign Cloud | API Key + 模型目录 | 额度需在 Cloud 控制台查看；API 只做模型调用；上下文长度可按模型调整（本地调度预算） |

边界：

- 登录态与额度由服务商决定；Morrow 不伪造已连接、额度或用例。
- 未完成本机实测的渠道会明确标注，不把“已实现登录页”当成“已连通”。
- 不提供 Claude 登录。
- 订阅渠道的协议可能随服务商变化；失败时按提示重新登录或改用普通 Provider。

## 媒体与引擎

| 能力 | 引擎 / 接口 | 边界 |
|---|---|---|
| 图片、视频、章节配图 | ComfyUI | 需要工作流与模型；未连接时真实失败 |
| 本机视觉审看 | llama.cpp / Ollama / LM Studio | 优先当前对话模型，失败才回退 |
| 配音 | Qwen3-TTS 本机 / Windows SAPI / 云端 `/audio/speech` | 声线取决于本机安装或服务商 |
| 配乐 | ComfyUI ACE-Step | `local` 只生成草稿并明确标注 |
| 剪辑、转码、封面、波形 | 本机 FFmpeg | 不随包内置；许可证由用户选择 |
| 图片/视频/音频预览 | Electron 渲染层 + 本机解码 | 大文件截断保护 |

## 内置技能

`BUILTIN_SKILLS_VERSION = 12`，当前共 20 个内置技能。它们按官方 Agent 技能库的工作流重写，不直接复制原文；来源与许可见 [DEVELOPMENT.md](DEVELOPMENT.md#内置技能来源)。

| 技能 | 用途 |
|---|---|
| `brainstorm-and-scope` | 把模糊需求变成可执行任务简报 |
| `plan-and-execute` | 多步骤计划、目标契约与持续推进 |
| `verify-before-delivery` | 用新鲜证据验证再声称完成 |
| `parallel-work` | 用 swarm 拆分并派发独立任务 |
| `code-review` | 只读审查改动，按 P0–P3 报告风险 |
| `debugging` | 稳定复现、定位根因、最小修复 |
| `test-writer` | 补高价值自动化测试与回归保护 |
| `refactor` | 建行为基线后小步重构 |
| `security-audit` | 围绕信任边界做授权范围内审计 |
| `frontend-art-direction` | 主题、构图、材质、状态与可访问性 |
| `deliverable-quality` | 跨类型交付质量门槛 |
| `document-deliverables` | README、规格、报告、Office 成品 |
| `data-analysis` | 从 CSV/Excel 做可复核分析 |
| `web-research` | 检索、核对来源与报告 |
| `canvas-artifacts` | 生成可交互画布/成品 |
| `workspace-git` | 工作区文件与 Git 操作 |
| `mcp-integration` | MCP 工具、资源与提示词接入 |
| `skill-author` | 编写与安装技能包 |
| `webapp-testing` | 真实浏览器验证网页 |
| `computer-use` | Windows 桌面 UI Automation |

工作区技能放在 `.morrow/skills`；安装前显示来源与文件。内置技能可启停，不会被用户技能静默覆盖。

## 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl+,` | 打开设置 |
| `Ctrl+K` | 命令面板 / 搜索或运行命令 |
| `Ctrl+N` | 新建对话 |
| `Ctrl+B` | 收起/展开侧栏 |
| ``Ctrl+` `` | 打开/收起终端 |
| `Esc` | 停止当前对话的运行（弹窗、审批或输入法优先时除外） |
| `Enter` | 发送消息（可在设置改为 `Ctrl+Enter`） |
| `Shift+Enter` | 换行 |
| `Ctrl+S` | 保存当前编辑器文件 |
| `Ctrl+F` / `Ctrl+H` | 编辑器查找 / 替换 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+T` / `Ctrl+W` | 新建 / 关闭内置浏览器标签 |
| `Ctrl+Shift+M` | 全局唤起灵动岛（仅正式运行，非测试模式） |
| `Alt+F4` | 关闭窗口（与标题栏关闭按钮共用确认逻辑） |

创作台的阶段切换、时间线、画布与协作计划以界面提示为准；不要用全局快捷键在终端聚焦时抢占终端输入。

## 数据路径

数据目录解析顺序：`--data-dir` → `%LOCALAPPDATA%\Morrow\data-location.json` → 便携版 `portable.marker` → `%APPDATA%\Morrow`。

| 路径 | 内容 |
|---|---|
| `sessions/` | 会话与消息 |
| `snapshots/`、`checkpoints/` | 文件/会话检查点 |
| `logs/main.log` | JSON 行日志；5MB 轮转保留 3 份 |
| `providers/`、`secrets.json` | 模型配置与加密凭据 |
| `settings.json` | 应用设置 |
| `studio/` | 作品、素材、版本、任务、回收站 |
| `usage/` | Token Activity |
| `schedules/` | 定时任务 |
| `skills/` | 用户技能 |
| `permissions/` | 审批日志 |
| `collaboration/` | 协作项目、工具审计、共享资源与成果 |

工作区内 `.morrow/` 存项目记忆、经验、技能、命令、角色、MCP 配置。便携版首次运行会在 exe 同级生成 `.morrow-runtime-0.2.0-<修订>` 运行时缓存；不要手动删除正在使用的缓存。

## 环境变量

| 变量 | 用途 |
|---|---|
| `MORROW_DATA_DIR` | 指定数据目录（等价 `--data-dir`） |
| `MORROW_COMFYUI_DIR` | 指定 ComfyUI 目录 |
| `MORROW_TERMINAL` | 指定默认终端 |
| `MORROW_ANTIGRAVITY_CLIENT_SECRET` | Antigravity OAuth secret（不内置） |
| `MORROW_TTS_*` | 本机 Qwen3-TTS 路径、模型、端口 |
| `MORROW_STUDIO_NO_DEMO=1` | 不注入创作台演示样例 |
| `MORROW_SIGN_*` | 代码签名证书、指纹或主题；`MORROW_SIGN_AUTO=1` 自动签名 |
| `MORROW_RELEASE_DIR` / `MORROW_DELIVER_DIR` | 打包输出/交付目录覆盖 |
| `MORROW_RUNTIME_REVISION` | 单文件版运行时缓存修订名 |

测试与 QA 变量（`MORROW_TEST`、`MORROW_TEST_CSP`、`MORROW_DEMO_SPEED`、`MORROW_E2E_EXE`）只用于自动化，不应出现在正式用户环境中。
