# Morrow · 明日工坊

> 住在你电脑里的 AI 工作伙伴。你说话，它动手：读文件、写代码、跑命令、做报告，把成品放到你面前。
> Windows 便携版（文件夹 / zip / 单文件 exe）· Electron 44 + React + TypeScript · 单机优先 · 无遥测。

![Morrow 欢迎页](docs/verification/screens/shell-welcome-dark.png)

## 这是什么

一个 **桌面 Agent 应用**，交互形态参考 Claude Desktop，Agent 内核参考 Claude Code：

- 会真实使用工具：读/写/编辑文件、目录、搜索、运行 PowerShell 命令、生成 HTML 报告/网页
- 行动全程可见：计划面板 + 行动轨迹（Spine）+ 文件差异
- 有安全边界：工作区沙箱、三档权限、危险命令拦截、写前快照可撤销
- 长程任务：上下文自动压缩、手动 `/compact`、全权限并行子代理、项目记忆/项目知识
- R10 工作台：真实文件树与文件操作、CodeMirror 编辑器+版本历史、内置浏览器+浏览器自动化、记忆中心、Projects、MCP 连接器（stdio/HTTP/SSE）、技能库、全局搜索、受控 computer-use
- 新手友好：首次引导、离线演示模式（无 Key 也能看到完整「WOW 时刻」）、中文界面、说明文档
- 默认接入 `deepseek-flash`（与 DSH 同款），也支持 DeepSeek / Anthropic / OpenAI / Kimi 及任何 OpenAI 兼容服务；API Key 用 Windows DPAPI 加密存储
- 默认窗口 2100×1200 物理像素，紧凑硬朗的界面（小圆角、石墨+香槟金、2.5D 悬浮品牌徽记）

## R10 工作台（2026-10-19）

按 Claude Desktop 对照补齐（J 定时任务不做）：
- 左侧真实文件树 + 新建/重命名/删除/过滤/拖拽；右侧 CodeMirror 编辑器 + 版本历史；
- 内置浏览器（WebContentsView）+ 浏览器自动化工具，外部动作逐次审批；
- 记忆中心、Projects（指令+知识）、MCP 连接器（stdio/HTTP/SSE）、技能库、全局搜索、受控 computer-use；
- 统一工作台入口（TitleBar 网格图标）、黑金面板、中文文件名/窄画布工具栏修正；
- 测试/自动化模式不再拉起外部 Edge。

## R9 子代理与 UI（2026-10-19）

- 子代理与主代理**同工具集、同权限模式、同工作区/审批链**（仅排除 task 防嵌套、update_goal 防改父目标）；read-only/chat 父任务仍只读；
- 同一消息多个 `task` 真并行；父停止取消全部；失败/耗尽/取消不被文字完成覆盖；
- 2.5D 悬浮徽记 + 黑金无边框滚动条 + 空画布去字 + 统一确认弹窗；
- 推荐用 `启动 Morrow.cmd` 打开：先清下载标记、建桌面快捷方式，规避 SmartScreen；
- R9.1 审计：M40–M49 **8 PASS / 1 FAIL / 1 UNSUPPORTED**（M44 假任务取消清理、M47 子任务运行态持久化）；R2-A—H **8/8**。详见 `docs/AUDIT-REPORT-R9.1.md`。

## 快速开始

```bash
npm install          # postinstall 会通过 npmmirror 下载 Electron 二进制
npm run dev          # 开发模式（需在普通桌面终端，DSH 会话内请用 build+shot）
npm run build        # 类型检查 + 构建
npm run test:unit    # 内核单元测试（459）
npm run test:e2e     # Playwright 端到端旅程（真实 Electron）
npm run dist         # 生成三种便携产物（文件夹 + zip + 单文件 exe）
npm run smoke:packaged  # 启动便携 exe 冒烟并截图
npm run probe:live   # 用本机 DeepSeek Key 做真实模型冒烟（结果不入库）
```

> 本仓库在受限 DSH 会话里开发：Electron 子进程启动需要 `--no-sandbox` 且 `--user-data-dir/--data-dir`
> 落在项目 `tmp/` 内；`scripts/env.mjs` 统一处理。普通用户双击便携 exe 不受这些限制。

## 目录

```
src/
  core/      纯 TS Agent 内核：providers / agent 循环 / 20+ 工具（文档、MCP、web）/ 权限 / 上下文压缩 / 子代理 / 演示引擎
  main/      Electron 主进程：窗口、IPC、设置与密钥、会话持久化、工作区、快照
  preload/   窄接口 contextBridge（renderer 拿不到 Node）
  renderer/  React 19 + Zustand + Vite：外壳、对话、行动轨迹、画布、设置、引导
  shared/    跨进程契约（类型 / IPC / 模型预设）
assets/demo-workspace/  离线演示的只读数据源（会复制到用户数据目录后使用）
docs/      产品、架构、设计系统、UI 契约、内核交接、使用说明、验证证据
tests/     单元（core）与端到端（Playwright Electron + Mock LLM）
scripts/   开发/截图/打包/冒烟/真实模型探测
```

## 文档

- [使用说明](docs/USER-GUIDE.md) — 给用户的 5 分钟上手与 FAQ
- [开发总纲](docs/PLAN.md) — 里程碑、任务板、验收口径
- [架构](docs/ARCHITECTURE.md) — 进程模型、事件协议、工具/权限/压缩、测试策略
- [设计系统](docs/DESIGN-SYSTEM.md) — 「夜桌与地平线」视觉语言与组件规范
- [内核交接](docs/ENGINE-HANDOFF.md) — Agent 运行时契约与维护注意事项
- [验证证据](docs/verification/EVIDENCE.md) — 测试、截图、打包与真实模型冒烟记录

## 第二轮优化（2026-10-19，版本号保持 1.0.0）

用户反馈驱动的一轮升级：

- **Electron 44.9.0**（最新稳定版），E2E 9/9、两形态打包冒烟通过
- **修复便携版打不开**：早期单文件 NSIS 自解压依赖 `%TEMP%`，受限环境会报 “Error writing temporary file”；现改为**自研启动器**：文件夹版 `Morrow.exe` 是轻量启动器，自动以兼容模式（`--no-sandbox`）启动 `Morrow-app.exe`；单文件版把应用 zip 内嵌，首次启动解压到 exe 同级 `.morrow-runtime-1.0.0` 缓存，不依赖 TEMP，之后秒开（实测 TEMP 指向不存在盘符仍可启动）。同时保留**文件夹便携版**（启动最快、数据同级 `Morrow Data`）为推荐形态。根因见 `docs/verification/NSIS-ROOT-CAUSE.md`
- **默认窗口 2100×1200 物理像素**：按主屏缩放比换算 DIP（150% 缩放为 1400×800 DIP，精确对应），任意缩放下视觉尺寸一致
- **更硬朗的 UI**：全局圆角缩小（4/5/7/9/12px），chips 与发送按钮改为小圆角，宽屏版心与欢迎页排版适配 2000px
- **deepseek-flash 默认模型**（与 DSH 同款），保留 DeepSeek Chat/Reasoner、Anthropic、OpenAI、Kimi
- **真实能力验证**：deepseek-flash 跑 9 道跨领域题（4 资深 + 4 小白 + 1 安全恢复），**9/9 机械通过、平均评审 4.78/5**；据此修复工具参数截断自修复、max-steps 收尾、命令越界审批，并新增 `write_file append` 分段写入。报告 `docs/CAPABILITY-REPORT.md`

## 状态

1.0.0 交付版：M0–M5 + 第二轮优化完成；真实 DeepSeek/DeepSeek Flash 会话、离线演示、权限允许/拒绝、中断、会话恢复、打包版真实任务均有端到端证据。
已知限制见 `docs/PLAN.md` 与内核交接文档。

## License

MIT（仅代码）。演示数据为虚构示例。
