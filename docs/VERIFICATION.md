# 交付验证

> 本文为中文文档；英文概览见 [README.md](../README.md)。

版本 **0.2.0**。这页是当前交付的快照：产物哈希、测试结果、文档截图与验证边界。机器可读摘要见 [verification.json](verification.json) 与 [smoke-packaged.json](smoke-packaged.json)。

## 交付产物

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 206,927,872 B / 197.34 MiB | `ee60ca27cf757fee46ce53e9d3618bb6c47c1d2865a7bfd200e692bf64c879a1` |
| `Morrow-0.2.0-setup.exe` | 157,469,434 B / 150.17 MiB | `8e1dae39be084a5295ee49f3cb61b1d5a684c2c5043e99d522921fc618203278` |
| `Morrow-0.2.0-source.zip` | 112,505,929 B | `f1571bc7850de68950fe04a3ec981c2cb458b01d8525c46e8b4d8b80897ec26d` |

- 两个 exe 均未签名（`signed:false`），首次运行可能触发 SmartScreen；发布页的 `SHA256SUMS.txt` 覆盖全部资产。
- 便携版运行时修订为 `.morrow-runtime-0.2.0-r020`，首次运行在 exe 同级解压。
- 源码包由 `git archive` 从打标签的发布提交生成，其中 `docs/` 是打包时的旧文档快照，不含 2026-11-12 的文档重构；分支文档已更新，源码包未重打。

## 测试与检查

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run audit:ui` | 28 CSS + 30 TSX，0 裸排版声明，31 个字号令牌可缩放，焦点环 2px |
| `npm run docs:check` | 通过：16 个 Markdown、29 张 2100×1200 截图、36 个本地图片链接 |
| `npm run test:suite` | 573 单元 / 88 Electron / 42 域，维护预算 600 / 96 |
| `npm run test:unit` | 573/573 通过（30 文件，串行约 51s；并行约 21s） |
| `npm run test:e2e` | 86/86 通过（约 7.5 分钟），含 `model-settings.spec.ts` 与窄窗遮挡回归 |
| `npm run smoke:packaged` | 通过（总耗时 7.6s，CDP 6.5s） |

打包耗时约 70.8s（`docs/verification.json` 的 `durationMs=70794`）。代码统计按 `node scripts/count-code.mjs` 的统一口径：

| 范围 | 文件 | 行数 |
|---|---:|---:|
| 生产源码 `src/` | 126 | 195,777 |
| 测试 `tests/` | 50 | 37,398 |
| 构建脚本 `scripts/` | 25 | 4,980 |
| 启动器 `build/launcher/` | 1 | 847 |
| **合计** | **202** | **239,002** |

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
- 外部模型、ComfyUI、ACE-Step、FFmpeg、TTS、订阅账号与额度由用户环境决定；未逐一做真实付费调用或全渠道登录。
- 截图展示的是测试模式下的样例界面，不代表用户本机已有同样的项目或数据。
- 只读档读取的是全局设置；会话级 `permissionMode` 与全局设置的统一、Git 面板按钮置灰仍是后续项。

## 交付沿革

| 时间 | 内容 |
|---|---|
| 2026-10-27 | v0.2.0 首次发布 |
| 2026-11-06 | 接入国内云端多媒体，更新海外媒体默认模型与官方音色 |
| 2026-11-10 至 11-11 | 上下文与最大输出档位、视觉能力识别、任务栏图标与短路径修复 |
| 2026-11-12 | 修复 5 个开放 issue，复核 #8；重新打包并替换发布资产 |
| 2026-11-12 | 文档体系重构（本轮），二进制与源码包未重新打包 |

## 复现

```powershell
npm install
npm run typecheck
npm run audit:ui
npm run docs:check
npm run test:suite
npm run test:unit
npm run test:e2e
npm run docs:capture
npm run build
npm run dist:final
npm run smoke:packaged
```

打包前若 `deliver/Morrow Data` 存在，先暂存到 `tmp/`，打包完成后再原样恢复。