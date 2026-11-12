# 参考手册

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页是查询表：快捷键、斜杠命令、设置分页、数据与配置文件、环境变量、内置技能与常见上限。它不解释工作流程，操作步骤见 [用户指南](USER-GUIDE.md)。

## 目录

- [快捷键](#快捷键)
- [斜杠命令](#斜杠命令)
- [设置分页](#设置分页)
- [数据目录](#数据目录)
- [工作区文件](#工作区文件)
- [环境变量](#环境变量)
- [内置技能](#内置技能)
- [常见上限](#常见上限)

## 快捷键

快捷键以 `src/shared/commands.ts` 为准，设置 → 快捷键渲染同一份清单。

| 生效范围 | 快捷键 | 动作 |
|---|---|---|
| 全局 | `Ctrl+K` | 打开命令面板 |
| 全局 | `Ctrl+B` | 收起或展开侧栏 |
| 全局 | `Ctrl+N` | 新建对话 |
| 全局 | `Ctrl+,` | 打开设置 |
| 全局 | ``Ctrl+` `` | 打开或收起终端 |
| 全局 | `Ctrl+Shift+M` | 显示或隐藏桌面伙伴（需在设置中开启） |
| 全局 | `Esc` | 停止生成或关闭弹窗 |
| 对话输入 | `Enter` | 发送消息（可在设置 → 回答切换为 `Ctrl+Enter`） |
| 对话输入 | `Shift+Enter` | 在消息中换行 |
| 对话输入 | `/` | 打开命令菜单 |
| 对话输入 | `@` | 引用文件夹里的文件 |
| 编辑器 | `Ctrl+S` | 保存当前文件 |
| 编辑器 | `Ctrl+F` | 查找 |
| 编辑器 | `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| 文件树 | `Enter` | 打开文件或展开文件夹 |
| 文件树 | `F2` / `Delete` | 重命名 / 删除 |
| 文件树 | 方向键 | 在文件之间移动 |
| 文件树 | `Shift+F10` | 打开右键菜单 |
| 内置浏览器 | `Ctrl+T` / `Ctrl+L` / `Ctrl+W` | 新建标签页 / 聚焦地址栏 / 关闭当前标签页 |
| 内置浏览器 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |

## 斜杠命令

| 命令 | 作用 |
|---|---|
| `/new` | 新建对话 |
| `/temp` | 新建临时对话（不持久化、不写记忆） |
| `/demo` | 运行一次离线演示工作区 |
| `/plan` | 计划模式：只读探索并提交可审阅计划 |
| `/research` | 深度研究：选择 quick / standard / deep 后先出研究计划 |
| `/goal` | 长期目标：跨轮推进到可验证结果 |
| `/btw` | 侧聊：无工具、不写主会话与检查点 |
| `/swarm` | 集群：把独立任务分给 1–10 个成员 |
| `/init` | 只读分析工作区并创建或更新 `AGENTS.md` |
| `/settings` | 打开设置 |
| `/git` | 打开 Git 工作台 |
| `/usage` | 查看 Token 用量 |
| `/compact` | 手动压缩上下文 |
| `/rewind` | 回退到某个检查点 |
| `/clear` | 清空当前对话 |
| `/export` / `/export-json` | 导出对话 |

自定义命令放在工作区 `.morrow/commands/*.md` 或用户 `~/.morrow/commands/*.md`，支持 `description`、`argument-hint`、`$ARGUMENTS` 与 `$1..$9`。上面这些内置名字是保留名，自定义命令不能覆盖。

## 设置分页

| 分页 | 主要选项 |
|---|---|
| 模型 | Provider、API Key、Base URL、模型同步、默认模型 |
| 订阅 | 官方账号、第三方 plan、模型与额度、登录态 |
| 多媒体 | 引擎、模型目录、ffmpeg、超时、输出目录 |
| 联网搜索 | builtin / Tavily / Brave / Serper / SearXNG；默认 5 条 |
| 上下文 | 用量、自动压缩、阈值 50–95%、项目规则 |
| 回答 | 5 种风格、发送键、运行中发送、自动命名、完成通知 |
| 用量 | Token 活动，按日 / 周 / 总计 |
| 归档 | 恢复、永久删除、清空 |
| 权限 | 三档权限、文件夹规则、审批日志、危险动作清单 |
| 自动化 | 自定义命令、集群成员、钩子 |
| 功能与工具 | 记忆 / 项目 / 定时 / 技能 / MCP / 搜索 / 浏览器 / Git 入口 |
| 终端 | 默认 Shell、WSL 提示、重新检测 |
| 外观 | 主题、应用与代码字号、代码字体、减少动效、关闭行为 |
| 快捷键 | 内置快捷键一览 |
| 关于 | 版本、运行时、数据目录、迁移 |

默认值：墨夜深色主题、应用字号 14、代码字号 12、JetBrains Mono、询问权限、`Enter` 发送、运行中排队、自动压缩开启（0.8）、Token 计量开启、侧栏 240px、画布 420px、关闭时询问、通知开启、桌面伙伴开启。

## 数据目录

解析顺序（`src/main/services/paths.ts`）：

1. `--data-dir=<path>` 启动参数；
2. `%LOCALAPPDATA%\Morrow\data-location.json` 中记录的自定义目录；
3. 便携文件夹版：exe 同级存在 `portable.marker` 时使用 `<exe 目录>/Morrow Data`；
4. 便携单文件版：`PORTABLE_EXECUTABLE_DIR/Morrow Data`；
5. 默认 `%APPDATA%\Morrow`。

目录内容：

```text
<dataDir>/
  sessions/          会话 JSON
  snapshots/         写文件前快照
  checkpoints/       每轮检查点
  logs/main.log      主进程 JSON 行日志
  attachments/       附件
  schedules/         定时任务
  skills/            用户技能
  memories/          全局长期记忆
  projects/          项目元信息
  artifact-versions/ 成品版本
  usage/             Token 日账
  permissions/       审批规则与日志
  mcp.json           MCP 配置
  secrets.json       safeStorage 加密的 API Key
  settings.json      脱敏设置
```

## 工作区文件

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

规则文件名为 `AGENTS.md`、`CLAUDE.md` 或 `MORROW.md`，最多向上读取 6 层，默认注入 3000 tokens。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MORROW_ANTIGRAVITY_CLIENT_SECRET` | Antigravity 登录所需的 Google OAuth client secret；不设置时登录入口提示缺少配置。应用不内置该值。 |
| `MORROW_MCP_CONFIG` | 指定 MCP 配置文件路径，优先于应用数据目录与工作区配置。 |
| `MORROW_MCP_TRUST_WORKSPACE` | 设为 `1` 时信任工作区 `.morrow/mcp.json`，等价于在连接器面板完成信任登记。 |
| `MORROW_COMFYUI_DIR` | 指定 ComfyUI 安装目录，作用同设置 → 多媒体中的目录。 |
| `MORROW_DATA_DIR` | 主进程内部用于定位数据目录的环境变量，工具与 MCP 配置读取它；切换数据目录请用设置 → 关于。 |
| `MORROW_DATA_LOCATION_FILE` | 覆盖记录自定义数据目录的指针文件位置。 |
| `MORROW_HOOK_EVENT` / `MORROW_WORKSPACE` | 由 Morrow 注入给钩子进程，分别表示事件名与当前工作区。 |

MCP 配置中的密钥可以写成 `$MORROW_SECRET:<id>`，由主进程用系统加密的密钥库解析，不要把明文写进 `mcp.json`。

## 内置技能

首次启动会把 18 个内置技能安装到 `<dataDir>/skills/`，之后可禁用或删除；升级只覆盖未被用户修改过的副本。

| 技能 | 用途 |
|---|---|
| `brainstorm-and-scope` | 把模糊需求变成可执行的任务简报 |
| `plan-and-execute` | 为多步骤任务做可验证的计划并持续推进 |
| `verify-before-delivery` | 声称完成前用新鲜证据验证 |
| `parallel-work` | 用集群拆分并派发 1–10 个独立任务 |
| `code-review` | 只读审查改动并按严重程度报告风险 |
| `debugging` | 先复现与取证，再定位根因并最小修复 |
| `test-writer` | 先写失败用例，再让实现通过 |
| `refactor` | 不改变外部行为的小步重构 |
| `security-audit` | 围绕信任边界做授权范围内的安全审计 |
| `frontend-art-direction` | 建立视觉方向并完成多轮打磨 |
| `deliverable-quality` | 跨类型成品的统一交付门槛 |
| `document-deliverables` | README、规格、报告、发布说明与 Office 成品 |
| `data-analysis` | 从 CSV / Excel 做可复核分析 |
| `web-research` | 有来源的联网调研 |
| `canvas-artifacts` | 把 HTML / Markdown / SVG / 代码成品放上画布 |
| `workspace-git` | 在工作区内安全读写文件与管理 Git |
| `mcp-integration` | 接入、调用与排查 MCP |
| `skill-author` | 创建与测试新的 `SKILL.md` |

## 常见上限

| 项目 | 上限 |
|---|---|
| 会话列表 | 300 条 |
| 每轮检查点 | 100 个 |
| 成品版本 | 30 版，单版 8MB |
| 画布文本预览 | 8MB |
| 单条消息附件 | 8 个；单图 5MB，超出压缩到最长边 1568px |
| 运行队列 | 每会话 20 条，单条 20k 字 |
| 终端后台任务 | 32 个，400KB 环缓冲 |
| 定时任务 | 50 个，5 秒轮询，单次 30 分钟超时 |
| 钩子 | 每事件 5 个，15 秒超时 |
| 自定义角色 | 单文件 32KB |
| 项目资料 | 20 个，单文件 512KB |
| 自动压缩 | 默认阈值 0.8，保留最近 8 条；可配 0.5–0.98 / 2–50 |
| 研究深度 | quick 2 轮 / 4 来源，standard 4 / 10，deep 6 / 20 |
| 集群成员 | 1–10 个，不能嵌套 |
| 侧聊 | 最多 8 并发；历史 12 条 / 12k 字，输出 4096 tokens |

这些数值来自 `src/` 中的实现常量。调整前先确认对应工具与 UI 是否也同步，不要把文档当作配置入口。