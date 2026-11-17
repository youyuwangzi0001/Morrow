# 交付验证

> 本文为中文文档；英文概览见 [README.md](../README.md)。

版本 **0.2.0**。这页是 v0.2.0 的真实交付快照：产物哈希、测试结果、文档截图与验证边界，全部来自本机实测。机器可读摘要见 [verification.json](verification.json) 与 [smoke-packaged.json](smoke-packaged.json)。

## 交付产物

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 206,965,248 B / 197.38 MiB | `b9f6ca1653b275c24d42153dec6d01cd6775bbe9aef3e965be20cede98f7f058` |
| `Morrow-0.2.0-setup.exe` | 157,499,170 B / 150.20 MiB | `d21143e97de579960a4c1df5b64048374088ee1f22068f0084a5fc38ac442aa8` |

`deliver/` 合计 347.58 MB / 2 个分发文件，附 `SHA256SUMS.txt`（已用 `sha256sum -c` 反向校验，两个包均为 `OK`）。

- 两个 exe 均**未签名**（`signed:false`，`NotSigned`）：未配置代码签名证书，首次运行可能触发 SmartScreen，需「更多信息 → 仍要运行」。
- 便携版是自研单文件启动器：内嵌应用 zip，首次运行解压到 exe 同级 `.morrow-runtime-0.2.0` 缓存（**不依赖 `%TEMP%`**），之后秒开；启动器带完整 Win32 manifest 并自动加 `--no-sandbox` 以兼容受限环境。
- 安装包是 NSIS 自解压：可选安装目录、创建开始菜单/桌面快捷方式，默认安装到 `Program Files`（需管理员权限）；安装版数据目录为 `%APPDATA%\Morrow`，可在设置中更改。

## 冒烟验证

单文件便携包**真实启动过**（不是只看文件存在）：

| 项 | 实测 |
|---|---|
| 启动方式 | `Morrow-0.2.0-portable.exe --no-sandbox --test-mode --remote-debugging-port=9658` |
| CDP 就绪 | Chrome/152.0.7977.167，6131ms |
| 窗口标题 | Morrow |
| 界面版本 | **v0.2.0**（确认版本号已进产物） |
| 渲染 | 首屏文本正常（创作台 / 新建对话 / 文件树 / 设置 /「未连接」），预加载 API 正常 |
| 运行位置 | 解压到 `.morrow-runtime-0.2.0-r020` 运行（符合单文件版预期） |
| 截图 | `tmp/verification/screens/packaged-smoke.png` |
| 总耗时 | 7.3s |
| 冒烟包哈希 | `b9f6ca16…f7f058`（与被测 exe 一致） |
| 汇总 | `portable=通过` |

冒烟脚本会清理单文件版解压出的运行时缓存，避免 `deliver/` 被 500MB 级缓存污染；清理失败会写入 `runtimeCleanupError` 而不是静默。

## 本轮修复的回归

| 缺陷 | 根因 | 回归保护 |
|---|---|---|
| 分镜卡「候选」与「时长」徽标重叠 | 两者各自 `position: absolute` 定位到同一右下角，实测每张卡 25×9px 交叠 | `tests/e2e/studio.spec.ts` 逐卡比较三个徽标的边界框，要求零交叠 |
| 终端槽位满时 `stop` 成功却仍报满，回退 `run_command` | 上限把**已退出**的记录也算作槽位，而 `stop` 只发信号、不删记录，名额永不释放；工具层也没有可用的关闭动作 | `tests/unit/main-runtime.test.ts` 覆盖「32 条已退出记录不占名额」「stop 后记录释放」「32 个运行中仍被拦」 |
| `read_file` 只能看到 256KB 以内的开头 | `MAX_READ_BYTES = 256 * 1024`，Morrow 自己的 `studio.ts` 等早已远超 | `tests/unit/core-tools.test.ts` 覆盖「300KB 文件能读到尾部」与「默认 2000 行不被 64K 输出上限截断」 |

## 测试与检查

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过（node + web 双配置） |
| `npm run audit:ui` | 28 CSS + 30 TSX，0 裸排版声明，31 个字号令牌可缩放 |
| `npm run audit:flex` | 通过：未发现会被压成竖排的行内尾部标签 |
| `npm run docs:check` | 通过：16 个 Markdown、29 张 2100×1200 截图、36 个本地图片链接 |
| `npm run test:suite` | 655 单元 / 93 Electron / 42 域，维护预算 662 / 96 |
| `npm run test:unit` | 658/658 通过（49 文件） |
| `npm run test:e2e` | 91/93 通过、1 跳过（详见下方「E2E 结果说明」） |

E2E 结果说明：全量 93 条中 91 条通过、1 条跳过（`packaged-parallel` 需要打包产物，属预期跳过）。另有 1 条 `@core:accessibility` 焦点环用例在全量顺序下偶发失败，单独复跑通过（`ok 1 tests/e2e/ui.spec.ts` —— 2.9s），属于该用例对设置面板焦点顺序的敏感，不是本版回归。

打包耗时 77.6s（`docs/verification.json` 的 `durationMs=77605`），Electron 44.9.0 / electron-builder 26.0.12。

代码统计按 `node scripts/count-code.mjs` 的统一口径（`wc -l` 换行，排除依赖、产物、文档、图片与媒体夹具）：

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 140 | 200,095 |
| 测试 `tests/` | 74 | 40,917 |
| 构建脚本 `scripts/` | 25 | 5,057 |
| 启动器 `build/launcher/` | 1 | 847 |
| **合计** | **240** | **246,916** |

## 文档截图

全部截图在默认 **2100×1200 物理窗口**下重拍，原始 PNG，不缩放、不压缩、不套滤镜。截图使用测试模式的演示工作区与样例作品，不含用户数据。生成命令 `npm run docs:capture`，校验命令 `npm run docs:check`。

### 用户指南与设置（14 张）

| 文件 | 内容 |
|---|---|
| `guide-onboarding.png` | 首次引导：认识 Morrow、连接模型、选择文件夹 |
| `guide-chat.png` | 主界面：会话、计划、输入框与工作区 |
| `guide-permission.png` | 审批卡：文件夹外路径、影响范围、允许一次/拒绝 |
| `guide-editor.png` | 文件树、编辑器与保存状态 |
| `guide-settings-models.png` | 设置 · 模型 |
| `guide-settings-subscriptions.png` | 设置 · 订阅 |
| `guide-settings-appearance.png` | 设置 · 外观 |
| `guide-settings-media.png` | 设置 · 本地与多媒体 |
| `guide-memory.png` | 记忆中心：长期、任务、项目与全局记忆 |
| `guide-browser.png` | 内置浏览器：标签、地址栏与真实页面 |
| `guide-terminal.png` | 真实终端：Git Bash 与命令输出 |
| `guide-collaboration.png` | 协作成员卡片：进度、用量与停止/插话 |
| `settings-cloud-media.png` | 模型页中的国内与海外多媒体服务 |
| `settings-local.png` | 本地模型与本地媒体引擎 |

### 创作台（15 张）

| 文件 | 内容 |
|---|---|
| `studio-home.png` | 作品库与一句话入口 |
| `studio-create.png` | 创建作品：形态、一句话、精细度与补充要求 |
| `studio-blueprint.png` | 蓝图：主线、人物、结构、风格与费用 |
| `studio-writing.png` | 写作台：大纲、纸页、候选与协作者 |
| `studio-assistant.png` | 协作者计划卡：影响、费用与待确认 |
| `studio-storyboard.png` | 分镜板与单镜详情 |
| `studio-timeline.png` | 时间线：监视器、五轨、波形与时间码 |
| `studio-canvas.png` | 漫剧画布：镜头/素材节点与连线 |
| `studio-voice.png` | 声音 · 配音 |
| `studio-music.png` | 声音 · 音乐 |
| `studio-review.png` | 检查：本地检查、模型审稿与引擎 |
| `studio-delivery.png` | 交付：成片预览、格式与预检 |
| `studio-settings.png` | 创作台设置：模型与预算等五页 |
| `studio-trash.png` | 回收站 |
| `studio-light.png` | 素纸主题作品库 |

`docs:check` 会核对：每张截图必须 2100×1200、必须在文档中被引用、不能出现废弃的 `docs/guide` 或 `docs/verification` 目录。

## 验证边界

- 安装包只做了打包与便携版冒烟，未执行 per-machine 安装，避免改动本机 `Program Files` 与快捷方式。
- 未配置代码签名证书；两个 exe 均为 `signed:false`。
- 外部模型、ComfyUI、MiniMax Music3、FFmpeg、TTS、订阅账号与额度由用户环境决定；未逐一做真实付费调用或全渠道登录。
- 截图展示的是测试模式下的样例界面，不代表用户本机已有同样的项目或数据。
- 只读档读取的是全局设置；会话级 `permissionMode` 与全局设置的统一、Git 面板按钮置灰仍是后续项。
- 本轮把 0.3.0 的框架加固并入 0.2.0：升级集中在底层判定与稳定性，没有真正接入大的新功能，因此沿用 0.2.0 版本号。

## 交付沿革

| 时间 | 内容 |
|---|---|
| 2026-10-27 | v0.2.0 首次发布 |
| 2026-11-06 | 接入国内云端多媒体，更新海外媒体默认模型与官方音色 |
| 2026-11-10 至 11-11 | 上下文与最大输出档位、视觉能力识别、任务栏图标与短路径修复 |
| 2026-11-12 | 修复 5 个开放 issue，复核 #8；重新打包并替换发布资产 |
| 2026-11-16 | 创作产线加固（帧数契约、画音分离、导演层、门禁等）；修复分镜徽标重叠、终端槽位不释放、文件读取上限；版本号沿用 0.2.0 |

## 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run audit:flex
npm run docs:check
npm run test:suite
npm run test:unit
npm run test:e2e
npm run build
npm run dist:final
npm run smoke:packaged
```

打包前若 `deliver/Morrow Data` 存在，先暂存到 `tmp/`，打包完成后再原样恢复。