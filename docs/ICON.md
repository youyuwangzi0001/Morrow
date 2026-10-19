# Morrow 品牌图标（R9 2.5D 悬浮徽记）生成与落地

## 设计
- 源文件：`build/icon-source.svg`（1024×1024）；侧栏复用 `src/renderer/src/assets/brand-mark.svg`。
- 视觉：石墨色 squircle 底，中央悬浮的 2.5D 金属 **M** 主体（金面顶板、深色正面、金色倒角与棱边高光），
  下方是带三层同心环的悬浮石台与底部锥形/辉光，背后升起悬浮太阳，外圈有倾斜轨道环与星尘；
  无任何文字，16/24/32 小尺寸仍保留 M 轮廓与金色层次。
- 侧栏品牌区只有该徽记 + 艺术化 `Morrow` 字标；图标 62px，带 7.5s 轻微悬浮动画（减少动效模式自动关闭）。

## 生成
```bash
node scripts/render-icon.mjs   # build/icon-source.svg -> build/icon.png（1024，透明背景）
python scripts/make-icons.py   # -> build/icon.ico（16–256）、build/installerIcon.ico、build/icon-512.png
```

## Windows 落地
- `Morrow-app.exe`：electron-builder `win.icon = build/icon.ico`；
- 文件夹版启动器 `Morrow.exe`：`scripts/dist-portable.mjs` 用 `csc -win32icon:build/icon.ico` 编译；
- 单文件版 `Morrow-1.0.0-portable.exe`：同一个 ico 编入启动器；
- `BrowserWindow` 图标：主进程按候选路径自动解析（开发/打包都可用）；
- **任务栏**：使用 exe 内嵌图标（`app.setAppUserModelId('studio.morrow.agent')` 保持一致）；
- **桌面快捷方式**：`启动 Morrow.cmd` 会在启动前创建 `Morrow.lnk`（已存在则不覆盖）；也可运行 `创建桌面快捷方式.cmd` 手动重建；
- **Explorer 图标缓存**：三个 exe 资源已正确；若文件管理器仍显示旧图，运行 `修复图标显示.cmd`（重建快捷方式 + 清 iconcache + 重启 Explorer）；
- **无警告入口**：`启动 Morrow.cmd` 先清除下载文件的安全标记（MOTW），再创建桌面快捷方式并启动；
- 预览：`docs/verification/screens/r9-icon-preview.png`（16–256 全尺寸）、`r8-exe-icons-preview.png`（旧版 exe 提取对照）。
