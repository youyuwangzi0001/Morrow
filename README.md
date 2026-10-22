# Morrow · 明日工坊

> 住在你电脑里的 AI 工作伙伴。你说清想要的结果，它自己读文件、写代码、跑命令、做报告，把成品放到你面前。
>
> **v0.1.0 · Windows 10/11 便携版** · Electron 44 + React 19 + TypeScript · 单机优先 · 无遥测。

## 这是什么

Morrow 是一个桌面 AI 工作伙伴。它不只是聊天：会真实读写你选择的文件夹、运行命令、查资料、做计划，并把 HTML 报告、Markdown 文档、代码或表格直接放到右侧画布。

适合没有编程背景、但电脑上有很多杂活要处理的人：整理资料、做数据分析、写周报、批量改文件、查清楚一个问题。

- **说人话就能开始**：不需要懂提示词工程，说清结果即可。
- **过程看得见**：每一步操作、命令和文件改动都显示在对话中。
- **安全可控**：默认询问；工作区内自动执行，危险/越界/外部动作才询问；写入前有备份；可随时停止；可一并回退对话和文件。
- **长任务能跑完**：计划、目标、自动压缩上下文、集群。
- **深度研究**：先给出可编辑的研究计划（目标、范围、子问题、检索策略与报告结构），确认后再多轮联网检索、交叉核对；运行中可追加要求，最终交付带引用的报告。
- **离线也有演示**：没有 API Key 也能先看一场完整演示。

## 主要能力

- **文件与编辑器**：左侧文件夹树，新建/重命名/删除/搜索；右侧 CodeMirror 编辑器，多标签、查找替换、版本历史与文件预览（图片、PDF、Word、Excel、PPT、音视频、压缩包等）；扫描版 PDF 用 Windows 本机 OCR 离线识别，不上传文件。
- **对话与执行**：流式回答、工具调用、计划模式、长期目标、上下文压缩、队列与后台运行、分叉与导出。
- **轻量回退**：每条回答末尾点「回退」，只弹一次确认，确认后同时恢复这一轮改过的文件并回退对话。
- **右侧栏**：画布与侧边聊天共用右侧空间，可直接拖拽宽度，不遮挡输入框；成品有 30 个文本版本快照，可预览、确认后恢复，并可导出独立网页、Markdown、纯文本或 PDF。
- **集群（Agent Swarm）**：2–8 个独立子任务按角色并行，最多 8 个同时推进；执行过程中实时显示每个小助手的等待/进行中/完成状态与结论；失败不会被当成完成。Kimi Work 也把同类能力称为 Agent 集群。
- **文件、工具与数据**：真实终端（PowerShell / CMD / Git Bash / WSL，可在设置中选择）、后台任务、版本历史（Git）、外部工具（MCP）、技能、记忆、项目、全局搜索、浏览器、受控 computer-use。
- **项目范围**：项目面板在「全部项目 / 当前文件夹」之间切换；当前文件夹没有项目时可直接新建，说明与资料只注入这个文件夹的对话。
- **临时对话、归档与数据清理**：临时对话只存在内存，不写会话文件、不进入历史与搜索、不记 token；归档对话从侧栏收起，在设置 → 归档 中恢复或永久删除；同一页可一次性清除全部对话及派生数据，但不动文件夹文件、设置、记忆、项目和密钥。
- **全局回答风格**：设置 →「回答」可选平衡、简洁、讲解、正式或自定义偏好，持久保存在本机，对主对话、侧边聊天与定时任务统一生效。
- **新手友好**：首次引导、中文界面、可读的执行过程、清楚的错误提示与演示模式。

## 模型

默认接入 `deepseek-flash`（DeepSeek V4.1 Flash），也支持：

- 国内：DeepSeek、Kimi、通义千问、智谱 GLM、MiniMax M3、小米 MiMo V2.6
- 国际：Anthropic（含 Claude Fable 5.1）、OpenAI、Google Gemini、xAI Grok、Meta Muse Spark 1.3
- 聚合 / 本地：OpenRouter、Ollama、LM Studio
- 任何 OpenAI 兼容服务

设置 → 模型里选择服务并填 API Key；模型列表可在运行时刷新。思考强度使用 `auto` / `low` / `medium` / `high` / `xhigh` / `max`。

## 快速开始

1. 运行 **`Morrow-0.1.0-portable.exe`**。如果 exe 是从浏览器或聊天工具下载的，先右键 exe → 属性 → 勾选「解除锁定」→ 确定，再双击（去掉 Windows 的“来自 Internet”标记）。
2. 首次会把应用解压到 exe 同级的 `.morrow-runtime-0.1.0`（约 5–10 秒，带进度小窗），之后启动更快。
3. 如果 Windows 弹出「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。v0.1.0 尚未做代码签名（`signed:false`），这不是病毒提示；配置受信任证书重新打包后，提示才可能消失（新证书仍需积累下载信誉）。解除锁定后通常不会再出现 SmartScreen。
4. 首次启动可先看演示；之后在「设置 → 模型」填入自己的 API Key；在顶栏选择一个文件夹，然后直接说出你要的结果。

数据默认保存在 exe 同级的 `Morrow Data` 文件夹；把 exe 和 `Morrow Data` 一起拷走即可换机继续。可在「设置 → 关于」更改数据目录：会重启 Morrow，可选择迁移对话、设置、项目、记忆与技能（浏览器登录状态与缓存不迁移），也可恢复默认目录。API Key 使用 Windows DPAPI 加密，只保存在本机。交付包不包含任何用户数据、缓存或密钥。

## 安全与隐私

- 文件操作限制在你选择的文件夹内；越界、危险命令、外部动作都需要额外确认。
- 权限三档：只读 / 询问 / 完全访问。默认询问；「完全访问」不弹任何审批。
- 写文件前自动备份；回退时检测文件是否被外部修改，冲突则整体拒绝。
- 对话与设置保存在本机；不接入 Morrow 的云服务，不发送遥测。
- MCP、浏览器与 computer-use 均逐次审批，敏感窗口会被拒绝。

## 开发与验证

```bash
npm install
npm run dev          # 开发模式
npm run build        # 类型检查 + 构建
npm run test:unit    # 单元测试
npm run test:e2e     # 全量 Playwright E2E（真实 Electron）
npm run dist         # 生成最终单文件便携 exe（交付形态）
npm run dist:all     # 内部构建检查：文件夹 + zip + 单文件
npm run smoke:packaged
```

最终验证记录见 [VERIFICATION.md](docs/verification/VERIFICATION.md)。

## 文档

- [使用说明](docs/USER-GUIDE.md) — 5 分钟上手、操作、权限、数据位置、常见问题
- [架构](docs/ARCHITECTURE.md) — 进程模型、Agent 循环、工具与权限、持久化
- [设计系统](docs/DESIGN-SYSTEM.md) — 视觉语言、字体、颜色、动效与布局
- [模型调研](docs/MODELS-RESEARCH.md) — 模型、上下文与 API 端点核对
- [项目计划](docs/PLAN.md) — v0.1.0 范围、已完成项与已知限制

## 已知限制

- 小助手不能再创建小助手；并行任务必须相互独立。
- 回退只覆盖 Morrow 通过写文件工具改过的文件；命令直接生成的文件不在回退范围。
- 终端使用真实 PTY（ConPTY）；应用退出时终端与后台任务都会结束。
- 外部工具、浏览器自动化与 computer-use 需要服务本身与网络/权限支持。
- 更改数据目录需要重启；迁移只复制 Morrow 的对话、设置、项目、记忆与技能，不复制内置浏览器缓存/登录状态。恢复默认目录不会自动合并两边的数据。
- 便携版未做代码签名（`Get-AuthenticodeSignature` = `NotSigned`）。首次运行可能被 SmartScreen 拦截一次，需要「更多信息 → 仍要运行」；解除下载锁定通常即可避免。如果每次都被拦截，可把 exe 加入安全软件白名单。要彻底消除提示，需要受信任的代码签名证书（见下方「代码签名」）。

## 代码签名（可选）

默认不签名，`docs/verification/packaging.json` 中 `signed:false`。配置以下任一环境变量后运行 `npm run dist`，脚本会用 signtool 对单文件 exe 及其内置应用做 SHA-256 + RFC3161 时间戳签名，并用 signtool 与 PowerShell 双重校验；校验失败会让打包失败。

- `MORROW_SIGN_PFX` + `MORROW_SIGN_PFX_PASSWORD` — `.pfx` 文件与密码
- `MORROW_SIGN_THUMBPRINT` — `CurrentUser\My` 中的证书指纹
- `MORROW_SIGN_SUBJECT` — `CurrentUser\My` 中的证书主题
- `MORROW_SIGN_AUTO=1` — 仅当恰好一张私钥可用、未过期、链可信的代码签名证书时自动使用
- `MORROW_SIGN_TIMESTAMP_URL` — 默认 `http://timestamp.digicert.com`

没有证书时不会生成或安装自签名证书；产物保持未签名并记录原因。签名能解决“发布者未知”的一部分问题，但 SmartScreen 仍需要证书受信任并积累下载信誉（EV 证书通常更快）。

## 交付

- 单文件便携版：`deliver/Morrow-0.1.0-portable.exe`（187.66 MB，SHA-256 `04ca53a9417bd7a25c84ee9e484fc20cc9e3eb88b1728ca964867e0422763c8b`）
- 使用说明与校验：`deliver/使用说明.txt`、`deliver/SHA256SUMS.txt`
- 许可证：`deliver/LICENSE`（MIT）
- 打包摘要、签名状态与验证证据：[packaging.json](docs/verification/packaging.json)

`deliver/` 只保留单文件 exe、使用说明、SHA256SUMS 与 LICENSE；不包含文件夹版、zip、缓存、用户数据或旧包。

## License

MIT
