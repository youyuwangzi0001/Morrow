# Morrow 文档地图

> 本文为中文文档；英文概览见 [README.md](../README.md)。

当前版本 **0.2.0**。这一页只回答两个问题：第一次用该读哪几页；遇到具体任务该翻哪一篇。

## 第一次使用

按顺序读三页，大约 15 分钟：

1. [GETTING-STARTED.md](GETTING-STARTED.md) —— 安装、连接模型、选择工作文件夹、确认一切正常。
2. [USER-GUIDE.md](USER-GUIDE.md) —— 界面地图、五种工作方式、权限与审批、文件与终端。
3. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) —— 只在卡住时查，按现象索引。

不想先接模型，可以在首次引导里选择“先看演示”；演示离线运行，不消耗额度。

## 按任务找文档

| 你想做的事 | 读这篇 |
|---|---|
| 装上、接模型、跑通第一句话 | [GETTING-STARTED.md](GETTING-STARTED.md) |
| 搞清界面、模式、权限与日常操作 | [USER-GUIDE.md](USER-GUIDE.md) |
| 写小说、做漫剧、把作品交付出去 | [STUDIO.md](STUDIO.md) |
| 接 API、订阅、本机模型，调上下文与思考档位 | [MODELS.md](MODELS.md) |
| 接 ComfyUI、云端图片/视频、配音、配乐、FFmpeg | [MEDIA.md](MEDIA.md) |
| 查快捷键、数据路径、环境变量、内置技能 | [REFERENCE.md](REFERENCE.md) |
| 某个功能报错、连不上、找不到数据 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| 看懂进程、IPC、Agent 循环、安全边界 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 搭环境、跑测试、打包、看许可 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 核对交付哈希、测试结果与截图清单 | [VERIFICATION.md](VERIFICATION.md) |

## 按角色阅读

- **普通使用者**：GETTING-STARTED → USER-GUIDE → 需要时查 TROUBLESHOOTING。
- **创作者**：GETTING-STARTED → STUDIO → USER-GUIDE 的权限与文件章节。
- **接模型/订阅的人**：GETTING-STARTED 第 2 步 → MODELS → MEDIA。
- **开发者**：ARCHITECTURE → DEVELOPMENT → VERIFICATION。

## 文档约定

- 文档正文为中文；`README.md` 为英文主文件，`README.zh.md` 是对应的中文镜像，两者同序互链。
- 文档正文平铺在 `docs/` 下，按任务拆分，一个主题一个文件；截图放 `docs/screens/`，规划放 `docs/planning/`，其余机器证据放 `docs/evidence/`。`verification.json` 与 `smoke-packaged.json` 由脚本直接写在 `docs/` 根，是有意保留的例外。
- 截图全部来自真实 Electron 窗口，默认 2100×1200 物理像素，不缩放、不压缩、不加滤镜。
- 版本相关的文件名、命令与路径以本分支的 `package.json` 和源码为准。
- 未在本机验证的能力会直接写明“未验证”，不用“支持”掩盖。

## 版本与证据

- 版本号：`0.2.0`。
- 发布资产与下载：<https://github.com/youyuwangzi0001/Morrow/releases/tag/v0.2.0>。
- 机器可读的打包摘要：[verification.json](verification.json)；打包冒烟摘要：[smoke-packaged.json](smoke-packaged.json)。
- 逐版本变更：[CHANGELOG.md](../CHANGELOG.md)。

## 维护这篇文档

新增或调整文档时：

1. 先判断它属于“第一次使用”“按任务操作”“查询参考”“开发与证据”中的哪一类，再决定放进现有文件还是新建。
2. 同步更新本页的“按任务找文档”表。
3. 运行 `npm run docs:check`：它覆盖根 README / README.zh / CHANGELOG / CONTRIBUTING / SECURITY 与 `docs/*.md`（共 16 个 Markdown），检查链接与锚点、截图尺寸与引用。
4. 如果改了截图，运行 `npm run docs:capture` 重拍，不要手工替换成缩略图。