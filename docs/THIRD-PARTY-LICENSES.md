# 第三方许可清单

更新日期：2026-10-27 · 版本：Morrow 0.2.0

本清单覆盖 Morrow 直接依赖、随应用打包的字体与图标库。所有依赖均为宽松许可；`jszip` 为 MIT 或 GPL-3.0 双许可，本项目按 MIT 使用。完整许可文本随各依赖包分发，可在 `node_modules/<包名>/LICENSE*` 查看。

## 运行时依赖

| 包 | 版本 | 许可 | 用途 |
|---|---:|---|---|
| @xterm/xterm | 6.0.0 | MIT | 终端渲染 |
| @xterm/addon-fit | 0.11.0 | MIT | 终端尺寸适配 |
| jszip | 3.10.1 | MIT OR GPL-3.0 | EPUB / DOCX / 工程包 |
| mammoth | 1.13.0 | BSD-2-Clause | DOCX 读取 |
| node-pty | 1.1.0 | MIT | 真实终端 PTY |
| pdf-parse | 1.1.1 | MIT | PDF 文本读取 |
| pdfjs-dist | 6.4.299 | Apache-2.0 | PDF 预览 |
| @fontsource/jetbrains-mono | 5.3.0 | OFL-1.1 | 等宽字体 |
| @fontsource-variable/manrope | 5.2.8 | OFL-1.1 | 界面字体 |
| @fontsource-variable/newsreader | 5.2.8 | OFL-1.1 | 衬线标题 |
| @fontsource-variable/noto-serif-sc | 5.3.1 | OFL-1.1 | 中文衬线 |
| @fontsource/ibm-plex-mono | 5.3.0 | OFL-1.1 | 辅助等宽字体 |

## 随包打包的界面与编辑依赖

| 包 | 版本 | 许可 | 用途 |
|---|---:|---|---|
| react / react-dom | 19.2.0 | MIT | 界面运行时 |
| react-markdown | 10.1.0 | MIT | Markdown 渲染 |
| remark-gfm | 4.0.1 | MIT | GFM 表格/任务列表 |
| remark-cjk-friendly | 2.3.2 | MIT | 中文换行 |
| lucide-react | 0.544.0 | ISC | 图标 |
| zustand | 5.0.8 | MIT | 界面状态 |
| shiki | 3.23.0 | MIT | 代码高亮 |
| diff | 7.0.0 | BSD-3-Clause | 候选稿对照 |
| @codemirror/* | 6.x | MIT | 编辑器内核、语言与搜索 |
| @lezer/highlight | 1.2.5 | MIT | 语法高亮 |

## 构建与测试工具（不进用户运行时）

| 包 | 版本 | 许可 |
|---|---:|---|
| electron | 44.9.0 | MIT |
| electron-builder | 26.0.12 | MIT |
| electron-vite | 4.0.1 | MIT |
| vite | 7.1.7 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vitest | 3.2.4 | MIT |
| @playwright/test | 1.64.1 | Apache-2.0 |
| @vitejs/plugin-react | 5.0.4 | MIT |
| @types/* | 24.10.0 / 19.2.0 | MIT |

## 未随应用打包的外部组件

- **FFmpeg**：Morrow 不内置 FFmpeg 二进制，调用用户本机安装或设置中指定的 `ffmpeg.exe`。FFmpeg 的许可取决于所下载构建（通常为 LGPL-2.1+ 或 GPL-2.0+）；分发或商用前请核对所选构建的许可与 `--enable-gpl` / `--enable-nonfree` 选项。
- **ComfyUI 与模型权重**：不在 Morrow 安装包内，由用户本机安装；Qwen-Image、MiniMax-H3 等模型按其各自许可使用。
- **系统语音（Windows SAPI / WinRT）**：由操作系统提供，不随应用分发。
- **真实语料样例**：仅用于本地验收测试；正式分发前请确认语料权利。

## 独立实现说明

创作台的画布、时间线、导出器、提示词检索、人物语气审稿与媒体代理逻辑均为本项目实现；未复制第三方应用的源代码或素材。`Agent阵法` 资料仅用于提炼提示词结构，最终模块为本项目重新撰写的中文提示词。
