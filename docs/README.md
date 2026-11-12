# Morrow 文档地图

> 本文为中文文档；英文概览见 [README.md](../README.md)。

这页说明每份文档解决什么问题、按什么顺序阅读，不重复具体操作步骤。文档对应产品版本 `0.1.0`。

## 第一次使用

按下面的顺序读，前四步能让你完成第一个真实任务。

| 顺序 | 文档 | 解决什么 |
|---|---|---|
| 1 | [README.md](../README.md) | 一分钟了解 Morrow 是什么、装哪个包、怎么启动。 |
| 2 | [快速开始](GETTING-STARTED.md) | 安装、首次引导、连接模型、选择工作区、判断“算不算成功”。 |
| 3 | [用户指南](USER-GUIDE.md) | 界面、五种工作方式、审批、文件与画布、终端、Git、浏览器、项目与自动化。 |
| 4 | [参考手册](REFERENCE.md) | 快捷键、斜杠命令、数据路径、环境变量、内置技能清单。 |

## 按问题找文档

| 你的问题 | 读这篇 |
|---|---|
| 模型怎么接、思考档位为什么少了、上下文能不能调 | [模型与订阅](MODELS.md) |
| 订阅账号怎么登录、额度为什么是空的 | [模型与订阅](MODELS.md) |
| 图片/视频怎么生成、审看为什么失败、ffmpeg 放哪 | [多媒体](MEDIA.md) |
| 某个报错或异常行为怎么处理 | [排障指南](TROUBLESHOOTING.md) |
| 进程怎么分工、权限判断在哪、数据写到哪 | [架构说明](ARCHITECTURE.md) |
| 怎么开发、跑测试、打包、改 UI token | [开发指南](DEVELOPMENT.md) |
| 这一版交付了什么、测试结果与哈希在哪 | [交付验证](VERIFICATION.md) |
| 想贡献代码或报告漏洞 | [贡献指南](../CONTRIBUTING.md)、[安全策略](../SECURITY.md) |

截图目录是 [`guide/screens/`](guide/screens/manifest.json)：12 张深色主题截图由 E2E 在真实 Electron 窗口中生成，`manifest.json` 记录来源、尺寸与替代文本。文档只引用这些图片，不手工拼界面。

## 文档约定

| 说法 | 指什么 |
|---|---|
| 工作区 | 你在 Morrow 里选择的文件夹。文件工具、终端与媒体输入输出默认不越过它。 |
| 订阅 | ChatGPT/Codex、Qoder、Kimi Code 等官方 Agent 账号或第三方 coding plan。 |
| 模型服务 | 通过 API Key 或 Base URL 接入的 Provider，包括本机 llama.cpp / Ollama / LM Studio。 |
| 当前模型 | 本次对话选中的 Provider + Model。它的能力（视觉、思考档位、上下文档位）优先于任何本地默认值。 |
| 未验证 | 文档没有在该构建上完成实测，不把“应该可以”写成“支持”。 |

命令示例默认 Windows PowerShell 7 语法。终端面板实际使用的 Shell 以 **设置 → 终端** 为准，默认是 Git Bash。

## 版本与证据

- 产品版本：`0.1.0`；平台：Windows 10/11 x64；交付形态：单文件便携版、NSIS 安装包、源码包。
- 机器证据：[`verification/artifacts.json`](verification/artifacts.json)（2026-10-26 验收轮的代码规模与资产旧基线）、[`verification/packaging.json`](verification/packaging.json)（2026-11-05 重发包记录）、[`verification/smoke-packaged.json`](verification/smoke-packaged.json)（便携包冒烟）、[`verification/eval-results.json`](verification/eval-results.json)（Agent 质量评测）。
- 人类可读的结论、门禁与已知边界：[VERIFICATION.md](VERIFICATION.md)。

## 维护规则

改代码时同步更新受影响的文档，而不是事后补一篇新的：

| 改动 | 至少更新 |
|---|---|
| 用户可见能力、入口或限制 | [用户指南](USER-GUIDE.md)、[参考手册](REFERENCE.md)、[CHANGELOG](../CHANGELOG.md) |
| 模型、思考档位、订阅协议 | [模型与订阅](MODELS.md) |
| 媒体工具、引擎或审看顺序 | [多媒体](MEDIA.md) |
| 进程、权限、持久化、IPC | [架构说明](ARCHITECTURE.md) |
| 脚本、测试、打包、UI token | [开发指南](DEVELOPMENT.md) |
| 发布门禁、截图、交付哈希 | [VERIFICATION.md](VERIFICATION.md) 与 `guide/screens/manifest.json` |

视觉变化需要重跑截图用例并更新 `manifest.json`；不要手绘或拼接界面图。