# 参考：快捷键、路径、变量与内置技能

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页只放查询型信息。操作步骤见 [USER-GUIDE.md](USER-GUIDE.md)，模型与订阅见 [MODELS.md](MODELS.md)，多媒体见 [MEDIA.md](MEDIA.md)。

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

创作台的阶段切换、时间线、画布与协作计划以界面提示为准；终端聚焦时，全局快捷键不会抢占终端输入。

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

工作区内 `.morrow/` 存项目记忆、经验、技能、命令、角色与 MCP 配置。

便携版首次运行会在 exe 同级生成 `.morrow-runtime-0.2.0-<修订>` 运行时缓存；不要手动删除正在使用的缓存。安装版与便携版的数据目录都可在“设置 → 关于”中更改，更改会重启并迁移现有数据。

## 环境变量

| 变量 | 用途 |
|---|---|
| `MORROW_DATA_DIR` | 指定数据目录（等价 `--data-dir`） |
| `MORROW_COMFYUI_DIR` | 指定 ComfyUI 目录 |
| `MORROW_TERMINAL` | 内部终端标记（固定为 `1`），用户无需设置；默认终端只在“设置 → 终端”选择 |
| `MORROW_ANTIGRAVITY_CLIENT_SECRET` | Antigravity OAuth secret（不内置） |
| `MORROW_TTS_*` | 本机 Qwen3-TTS 路径、模型与端口 |
| `MORROW_STUDIO_NO_DEMO=1` | 不注入创作台演示样例 |
| `MORROW_SIGN_*` | 代码签名证书、指纹或主题；`MORROW_SIGN_AUTO=1` 自动签名 |
| `MORROW_RELEASE_DIR` / `MORROW_DELIVER_DIR` | 打包输出/交付目录覆盖 |
| `MORROW_RUNTIME_REVISION` | 单文件版运行时缓存修订名 |

测试与 QA 变量（`MORROW_TEST`、`MORROW_TEST_CSP`、`MORROW_DEMO_SPEED`、`MORROW_E2E_EXE`）只用于自动化，不应出现在正式用户环境中。

## 内置技能

`BUILTIN_SKILLS_VERSION = 12`，当前共 20 个内置技能。它们按官方 Agent 技能库的工作流重写，不直接复制原文；来源与许可见 [DEVELOPMENT.md](DEVELOPMENT.md)。

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

工作区技能放在 `.morrow/skills`；安装前会显示来源与文件。内置技能可启停，不会被用户技能静默覆盖。

## 命令速查

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动开发模式 |
| `npm run build` | 类型检查 + 构建 |
| `npm run test:unit` | 单元测试 |
| `npm run test:e2e` | Electron 流程测试（先构建） |
| `npm run verify` | 类型、UI、文档、清单、单元与 Electron |
| `npm run dist:final` | 重建两个发布 exe |
| `npm run smoke:packaged` | 启动打包产物做冒烟 |
| `npm run docs:check` | 检查文档链接、截图尺寸与引用 |

完整开发流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。