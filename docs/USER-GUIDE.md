# Morrow 使用说明

> 住在你电脑里的 AI 工作伙伴。你描述想要的结果，它自己读文件、写代码、跑命令、做报告，把成品放到你面前。
> 本指南对应 **Morrow 0.1.0**（Windows 10/11 x64）。

![首次启动](guide/screens/01-onboarding-dark.png)

## 一、5 分钟上手

### 1. 打开 Morrow

- **安装版**：运行 `Morrow-0.1.0-setup.exe`，按向导选择目录。默认按当前用户安装，数据在 `%APPDATA%\Morrow`。
- **便携版**：运行 `Morrow-0.1.0-portable.exe`。首次启动会在 exe 同级解压运行时缓存（约 5–10 秒），数据在同级 `Morrow Data`。
- 未签名构建首次运行可能被 SmartScreen 拦截：点「更多信息 → 仍要运行」；下载来的 exe 先右键 → 属性 → 解除锁定。
- 不想配置模型也可以先点欢迎页的「看一场演示」，用离线演示走完一次真实文件任务。

### 2. 选择工作文件夹

点顶栏的文件夹按钮，选择让 Morrow 工作的目录。它只能读写这个目录及其子目录；越界访问、危险命令和外部动作都会先问你。

### 3. 说出你想要的结果

不要写命令步骤，直接说结果，例如：

- 「把 downloads 里的发票整理成一张 Excel，按月份汇总。」
- 「读一遍这个项目，告诉我入口在哪、怎么跑起来，并修掉启动报错。」
- 「做一份 8 页的产品介绍 HTML，深色、克制，最后导出 PDF。」

Morrow 会先给计划（复杂任务）、再执行，过程在对话里可见，成品放到右侧画布。

![主界面](guide/screens/02-chat-home-dark.png)

### 4. 聊天 / 工作 / 计划 / 目标

- **聊天**：只讨论与只读分析，不动文件。
- **工作**：可以读写文件、运行命令、推进计划。
- **计划模式**：`/plan 任务`，先只读探索并给出步骤、风险与验收标准，你批准后才执行。
- **目标模式**：`/goal 目标`，适合需要多轮推进的长任务；完成必须有真实文件证据，阻塞会如实停下。
- **深度研究**：`/research [quick|standard|deep] 问题`，先出可编辑研究计划，再多轮检索并交付带引用的报告。
- **侧边聊天**：`/btw 问题`，右侧只读问答，不写入主会话。

### 5. 审批卡：它想做什么，会发生什么

高风险动作会弹出审批卡，显示风险级别、人话说明、命令/路径/diff 预览：

- `Enter` 允许一次，`Esc` 拒绝。
- 「始终允许（本工作区）」只对低/中风险且可持久化的操作开放；高风险/外部动作每次都要确认。
- 不确定时先拒绝，然后在输入框里告诉它换个做法。

![审批卡](guide/screens/03-permission-card-dark.png)

### 6. 画布、文件与编辑器

- 右侧画布显示 HTML、Markdown、代码、图片、PDF、Office、音视频等成品；可预览、看版本历史、导出或系统打开。
- 左侧文件树可新建、重命名、移动、复制、删除、搜索；双击文件进入编辑器。
- 编辑器支持多标签、查找替换、撤销重做、外部修改冲突提示、历史版本与恢复。
- 扫描版 PDF 可以用 Windows 本机 OCR 离线识别；每次最多 12 页，超出会提示分批。

![编辑器与画布](guide/screens/04-editor-canvas-dark.png)

### 7. 连接模型

设置 → 模型：

1. 选择服务（DeepSeek、Kimi、通义千问、GLM、MiniMax、Claude、OpenAI、Gemini、Grok、Meta、llama.cpp、Ollama、LM Studio 或自定义服务）。
2. 粘贴 API Key，点「保存连接」；再点「测试连接」与「刷新可用模型」。
3. 本机或局域网服务（`localhost`、`127.0.0.1`、`192.168.x`、`10.x`、`172.16–31.x`、`.local`）可以留空 Key；公网服务仍需 Key。
4. 在输入框下方选择默认模型；模型支持时可切换思考强度 `auto / low / medium / high / xhigh / max`。

![模型设置](guide/screens/05-settings-models-dark.png)

### 8. 订阅：把已在用的 Agent 账号接进来

设置 → 订阅支持 ChatGPT/Codex、Qoder、Kimi、GLM、MiniMax、Step、Command Code、Cline、Antigravity、OpenCode 与第三方 coding plan。每条渠道都有真实登录/导入、加密存储、额度与账号状态；登录态只保存在本机。Morrow 不代充、不共享账号、不绕过限流。

![订阅](guide/screens/06-subscriptions-dark.png)

### 9. 外观：字号与字体

设置 → 外观：

- 应用字号 **12–15，默认 14**；代码字号 **11–14，默认 12**。
- 代码字体默认 **JetBrains Mono**，可切 IBM Plex Mono 或系统等宽。
- 深色墨夜 / 浅色素纸；减少动效；token 计量；桌面小伙伴；关闭窗口行为。

![外观](guide/screens/07-settings-appearance-dark.png)

### 10. 本机多媒体

设置 → 多媒体连接你电脑上的 ComfyUI、llama.cpp、Ollama、LM Studio 或自建引擎；Morrow 不自带推理引擎或模型文件。

- **添加本机模型**：填名称、引擎、能力、文件或引擎内 ID 即可注册。
  - llama.cpp 选 GGUF，可一键「启动此模型」。
  - Ollama / LM Studio 填引擎内模型 ID，保存后在引擎里拉取。
  - ComfyUI 粘贴「保存（API 格式）」导出的工作流 JSON，填输出节点与输出类型即可。
- 模型文件不在引擎目录时自动复制进去，重名自动加序号。
- ffmpeg 只用于剪辑、转 GIF、封面与拼接；图片/视频生成不依赖它。

![多媒体](guide/screens/08-media-models-dark.png)

### 11. 工作台：终端、Git、浏览器

- **终端**：PowerShell 7 / Windows PowerShell / CMD / Git Bash / WSL；WSL 需先在 Windows 安装发行版，可在「设置 → 终端」重新检测；多标签、后台任务、复制粘贴、拖动调高。
- **Git**：查看差异、暂存/取消暂存、提交、切换/新建分支、浏览历史、配置身份；不提供 push/pull，请用终端。
- **内置浏览器**：多标签、前进/后退/刷新、下载确认；Agent 与你共用同一页面；返回主页面后页面保留。

![浏览器](guide/screens/09-browser-tabs-dark.png)

![终端](guide/screens/10-terminal-dark.png)

### 12. 记忆、项目、搜索、定时、技能、MCP

- **记忆中心**：长期记忆（项目/全局）与任务经验；按 token 预算注入，可编辑、删除、导出。
- **项目**：每个工作区一个项目；名称、描述、指令、知识文件会按预算带进对话。
- **全局搜索**：跨对话、文件、成品搜索；命中会话可跳转并高亮。
- **定时任务**：设置 → 自动化；无人值守时自动拒绝高风险操作、自动跳过提问。
- **技能**：内置技能 + 用户技能库；支持文件夹/zip 安装；脚本/可执行文件会被跳过并提示，不会执行。
- **MCP**：内置目录、手动配置、OAuth；工具/资源/提示词按权限审批。

![记忆中心](guide/screens/11-memory-center-dark.png)

![项目](guide/screens/12-projects-dark.png)

### 13. 数据、备份与卸载

- 安装版数据：`%APPDATA%\Morrow`；便携版数据：`Morrow Data`。
- 备份：退出 Morrow 后复制整个数据目录。API Key 使用 Windows DPAPI 加密，换机器/用户后需重新填写。
- 更改数据目录：设置 → 关于；会迁移对话、设置、项目、记忆与技能，不包含浏览器缓存/登录状态，需重启。
- 卸载：Windows 设置 → 应用 → Morrow；默认保留用户数据。彻底清理需手动删除数据目录。
- 单文件版的 `.morrow-runtime-*` 可以删除，下次启动会重新解压；不要在 Morrow 运行时删除。

## 二、常用操作

| 操作 | 方式 |
|---|---|
| 打开设置 | `Ctrl+,` |
| 命令面板 | `Ctrl+K` |
| 收起/展开侧栏 | `Ctrl+B` |
| 打开/收起终端 | `Ctrl+\`` |
| 全局搜索 | `Ctrl+Shift+F` |
| 新建对话 | `Ctrl+N` |
| 唤回桌面小伙伴 | `Ctrl+Shift+M` |
| 审批允许 / 拒绝 | `Enter` / `Esc` |
| 发送 | `Enter` 或 `Ctrl+Enter`（设置 → 回答可切换） |

## 三、常见问题

更多排障见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

- **没有 API Key 能用吗？** 可以看演示、浏览本地文件、使用本地引擎；连接公网模型需要 Key。
- **模型测试失败？** 先检查 Key、Base URL 与服务商状态；本机/局域网服务 Key 可留空。
- **ComfyUI 一直离线？** 检查服务地址、安装目录（含 `main.py`）、所需自定义节点；远程 ComfyUI 只能手动启动。
- **为什么没有生成视频？** 需要本机 ComfyUI、MiniMax/Qwen 模型文件与足够显存；16GB 显存下代码模型与视频模型需分阶段执行。
- **回退能恢复命令生成的文件吗？** 不能；检查点只覆盖 Morrow 通过写文件工具修改的文件。
- **技能里的脚本会运行吗？** 不会；安装时会跳过并提示。

## 四、安全与隐私

- 本地优先，无遥测；对话、设置、记忆与项目保存在本机。
- API Key 使用 Windows DPAPI 加密，只在主进程解密；渲染层只看到「是否已保存」。
- 文件操作限制在工作区；越界、危险命令、外部动作逐次审批；写文件前快照。
- 浏览器、MCP、computer-use 默认逐次审批；网页内容按不可信资料处理。
- 详细说明见 [SECURITY-PRIVACY.md](SECURITY-PRIVACY.md)；漏洞报告见 [SECURITY.md](../SECURITY.md)。
