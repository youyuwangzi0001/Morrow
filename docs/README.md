# Morrow 文档中心

Morrow 是 Windows 上的本地桌面 AI Agent。本文档按“先用起来 → 理解能力 → 配置模型/订阅/媒体 → 开发与验收”的顺序组织。

## 建议阅读顺序

1. [项目 README](../README.md) — 一分钟了解产品与快速开始。
2. [用户指南](USER-GUIDE.md) — 从首次启动到日常工作流。
3. [功能参考](FEATURES.md) — 查入口、能力和限制。
4. [模型与思考档位](MODELS.md) — 配置 API 模型、本机模型和 Qoder 账号目录。
5. [订阅接入](SUBSCRIPTIONS.md) / [多媒体与本地模型](MEDIA-MODELS.md) — 使用官方账号或本机媒体引擎。
6. [架构说明](ARCHITECTURE.md) / [设计系统](DESIGN-SYSTEM.md) — 开发与界面规范。
7. [安全与隐私](SECURITY-PRIVACY.md) / [排障指南](TROUBLESHOOTING.md) — 边界与问题处理。
8. [评测规范](EVALUATION.md) / [验收记录](verification/VERIFICATION.md) — 质量证据与发布信息。

## 版本与证据

- 产品版本：**0.1.0**
- 当前运行时：**r019**
- 平台：Windows 10/11 x64
- 交付形态：单文件便携版 + NSIS 安装包 + 源码包
- 截图：[`guide/screens/manifest.json`](guide/screens/manifest.json)（12 张，深色主题，E2E 真实窗口生成）

## 文档约定

- “工作区”指用户在 Morrow 里选择的文件夹；Morrow 默认不越过工作区读写。
- “订阅”指 ChatGPT/Codex、Qoder、Kimi Code 等官方 Agent 账号；“模型服务”指通过 API Key 接入的 Provider。
- “当前模型”指本次对话选中的 Provider + Model；模型能力（视觉、思考档位、可调上下文）优先于任何本地默认配置。
- 命令示例默认 Windows PowerShell 7 语法；终端面板的实际 Shell 以设置 → 终端为准，当前默认 Git Bash。

## 维护

文档随代码一起提交。新增功能时至少更新：

- 功能入口与限制：`FEATURES.md`、`USER-GUIDE.md`
- 模型/协议变化：`MODELS.md`、`SUBSCRIPTIONS.md`、`MEDIA-MODELS.md`
- 进程/数据/安全边界：`ARCHITECTURE.md`、`SECURITY-PRIVACY.md`
- 门禁、截图和交付哈希：`verification/VERIFICATION.md`、`guide/screens/manifest.json`
