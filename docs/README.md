# Morrow 文档地图

> 本页是整套文档的入口。它只回答三件事：第一次用该按什么顺序读、遇到具体任务查哪一篇、改文档要守哪些约定。
> 英文仓库首页见 [README.md](../README.md)，中文首页见 [README.zh.md](../README.zh.md)。

当前版本 **0.2.0**，覆盖三个面：桌面端、创作台、安卓伴侣端。

## 第一次使用

按顺序读三页，大约 20 分钟：

1. [GETTING-STARTED.md](GETTING-STARTED.md) —— 装上、走完引导、接上模型、做出第一个成品，再把手机接上。
2. [DESKTOP-GUIDE.md](DESKTOP-GUIDE.md) —— 界面地图、五种工作方式、权限与审批、检查点、文件与终端。
3. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) —— 只在卡住时查，按现象索引。

不想先接模型，可以在首次引导里选择“先看演示”：演示离线运行，不消耗额度，也不会写你的文件夹。

## 按任务找文档

| 你想做的事 | 读这篇 |
|---|---|
| 装上桌面版、接模型、跑通第一句话 | [GETTING-STARTED.md](GETTING-STARTED.md) |
| 搞清界面、五种模式、权限与日常操作 | [DESKTOP-GUIDE.md](DESKTOP-GUIDE.md) |
| 写中短篇、长篇、做漫剧，把作品交付出去 | [STUDIO.md](STUDIO.md) |
| 在手机上看进度、批权限、翻成品 | [MOBILE.md](MOBILE.md) |
| 把手机接上电脑，或搞清局域网通道的安全边界 | [PAIRING.md](PAIRING.md) |
| 接 API、订阅、本机模型，调上下文与思考档位 | [MODELS.md](MODELS.md) |
| 接 ComfyUI、云端图片/视频、配音、配乐、FFmpeg | [MEDIA.md](MEDIA.md) |
| 查快捷键、数据路径、环境变量、内置技能、设置分页 | [REFERENCE.md](REFERENCE.md) |
| 某个功能报错、连不上、找不到数据 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| 看懂进程、IPC、Agent 循环、权限顺序、手机通道 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 搭环境、跑测试、打包、看许可 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 核对交付哈希、测试结果、截图清单与未验证项 | [VERIFICATION.md](VERIFICATION.md) |

## 按角色阅读

- **普通使用者**：GETTING-STARTED → DESKTOP-GUIDE → 需要时查 TROUBLESHOOTING。
- **创作者**：GETTING-STARTED → STUDIO → DESKTOP-GUIDE 里权限与文件那几节。
- **接模型或订阅的人**：GETTING-STARTED 的“连接模型” → MODELS → MEDIA。
- **想用手机盯进度的人**：GETTING-STARTED 的“装上手机端” → PAIRING → MOBILE。
- **开发者**：ARCHITECTURE → DEVELOPMENT → VERIFICATION。

## 文档约定

| 约定 | 具体要求 |
|---|---|
| 一主题一文件 | 正文平铺在 `docs/` 下，不建子目录；`screens/`、`diagrams/`、`evidence/`、`cards/` 只放素材与记录 |
| 双语两个文件 | 根 `README.md` 写英文、`README.zh.md` 写中文，两份同序互链、内容完整对应；`docs/` 正文只用中文 |
| 不写文件内目录 | 导航只在本页维护，避免十篇各写一套目录然后漂移 |
| 事实分级 | 已实现直陈；有限制当场写明；未实现或未验证用“未实现”“未验证”标注，并集中到该篇的“能力边界”或“已知限制” |
| 数字唯一 | 测试规模、设置分页数、技能数这类数字只写一处来源（`npm run test:suite` 的输出），不各篇各写一套 |
| 不承诺未来 | 不写路线图，不写“后续将支持”；能力以当前代码为准 |
| 术语一致 | 智能体、轮次、检查点、审批、配对票据、工位、创作台，六个别名 |

`docs/cards/` 里是 relay、配对与传输层的三份协议设计记录（B1–B3），写于实现之前，用来说明设计取舍。它们不是待办清单，也不随功能变化逐条更新；与代码冲突时以代码和各篇正文为准。

## 截图与示意图

| 类型 | 位置 | 生成方式 | 说明 |
|---|---|---|---|
| 桌面截图 | `screens/*.png` | `npm run docs:capture`（27 张）、`npm run test:pair-panel`（1 张）、E2E 顺手产 2 张后手工搬运 | 真实 Electron 窗口，2100×1200，不缩放不加水印；来自测试模式与内置演示工作区 |
| 手机截图 | `screens/mobile/*.png` | 安卓模拟器安装 APK 后 `adb exec-out screencap` | 真实 Compose 界面，未连接的页面显示空态 |
| 示意图 | `diagrams/*.png` | 手工绘制并提交 | 只解释结构与时序，不画成仿真界面；图注第一句必须写“示意图” |

三条硬规则：

1. `screens/` 下每张桌面截图都会被 `docs:check` 校验：必须是 PNG、必须 2100×1200、必须至少被一篇文档引用。换图不要手工缩，走 `docs:capture`。
2. 创作台的截图里作品是内置样例，图注要写明，不能让读者以为是真实用户作品。
3. 不把示意图当截图用，也不给截图加营销贴纸。

## 版本与证据

- 版本号：`0.2.0`，发布资产见 <https://github.com/youyuwangzi0001/Morrow/releases/tag/v0.2.0>。
- [VERIFICATION.md](VERIFICATION.md) 是唯一可以引用交付哈希与检查结果的地方。
- `verification.json` 与 `smoke-packaged.json` 是最近一次打包与冒烟脚本写出的机器摘要，字段名与时间戳保留原样；它们不随文档改写，引用前先看时间戳。
- 逐版本变更见 [CHANGELOG.md](../CHANGELOG.md)。

## 维护这套文档

改一处文档的最小流程：

1. 先判断它属于“第一次使用”“按任务操作”“查询参考”“开发与证据”中的哪一类，再决定改现有文件还是新建。
2. 只改这一处事实的所有副本：数字类事实在 [DEVELOPMENT.md](DEVELOPMENT.md) 与 [VERIFICATION.md](VERIFICATION.md) 各出现一次，改完两处对齐。
3. 改完跑 `npm run docs:check`：它检查根目录五个 Markdown 与 `docs/` 下全部 Markdown 的本地链接与锚点，检查每张桌面截图的尺寸与引用。
4. 改了截图，先改 `scripts/docs-capture.spec.ts` 里的选择器或步骤，再跑 `npm run docs:capture`；不要手工替换成缩略图。
5. 新增一篇正文，回本页补“按任务找文档”一行，并在 [README.md](../README.md) 与 [README.zh.md](../README.zh.md) 的文档表里各补一行。

锚点提示：`docs:check` 用仓库自己的 slug 规则校验锚点——标题转小写、去掉反引号与所有非字母数字空格连字符的字符、空格转 `-`。所以“终端、Git 与浏览器”的锚点是 `#终端git-与浏览器`。不确定时只写文件名，不写锚点。