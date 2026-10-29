# 验收记录

- 产品：Morrow
- 版本：0.2.0
- 构建修订：r050
- 平台：Windows 10.0.26300 x64
- Electron：44.9.0
- electron-builder：26.0.12

## 1. 交付物

本轮只交付两个单文件：

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `Morrow-0.2.0-portable.exe` | 220,550,144 B / 210.33 MiB | `31f5b086db8bc280150ebffdd198b95f3832ac5853c3ca51168e6b9453d0989f` |
| `Morrow-0.2.0-setup.exe` | 168,375,330 B / 160.58 MiB | `c223f38060921b40adbed87d597692f737c5f6b1fc0a018d26300f05887e4eb8` |

- 两个产物均未配置代码签名（signed:false）。
- 交付目录不包含文件夹版、zip、源码包、使用说明或 SHA256SUMS；这些只作中间产物/文档。
- 本机构建备注：`deliver/` 里旧的隐藏运行时缓存被宿主 Qoder 进程占用，当前会话无法删除；干净双文件副本在 `deliver-clean/`。关闭 Qoder 后可删除旧缓存，`deliver/` 即只剩两个 exe。
- `Morrow Data` 用户数据已移到工作区外保留，不进入交付目录。
- 便携版首次运行会在 exe 同级解压 `.morrow-runtime-0.2.0-r050`；安装版数据默认在 `%APPDATA%\Morrow`。

![协作者计划](../guide/screens/18-studio-assistant-dark.png)

## 2. 质量门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run audit:ui` | 27 CSS + 29 TSX，0 裸排版值 |
| `npm run test:unit` | 15 套件 / 1046 用例（1037 passed + 9 skipped） |
| 协作者真实 UI | 3 条新增链路（声音页改配音、短篇局部改大纲、长篇调章序）通过 |
| 截图相关 E2E | 171 条：159 passed + 11 skipped + 1 failed；失败项修复后复验 1/1 通过 |
| 便携 exe 冒烟 | r050 最终包通过：启动、渲染、截图 5.2s |
| 安装包 | electron-builder NSIS 构建成功，完整性标签 Medium；未做无人值守静默安装测试 |

## 3. 三套大师提示词

- 写作/编剧/导演三套内容编译在 `src/main/creative-prompts.generated.ts`（gzip + base64）。
- `src/main/creative-masters.ts` 运行时只解压内存，`root='embedded'`；不读桌面文件夹、`resources/prompts`、`process.resourcesPath/prompts` 或 `MORROW_CREATIVE_PROMPTS`。
- `package.json` 的 `extraResources` 只有 `pdf-ocr.ps1`、`studio-demo`、`tts`。
- 旧 `prompt-library.ts`、29 组内嵌手法、七维权重、六条门禁已移除。
- 单测 `studio-runtime.test.ts` 覆盖：大师路由、方法论预算、内嵌加载、提示词不含外部回退。

![检查页](../guide/screens/31-studio-review-dark.png)

## 4. 协作者链路

- 单测 `studio-intent.test.ts` 26 条：逐步上下文、章序/镜序、局部大纲、人物/镜头声线、全片重配、自动重配、计划归一化。
- 真实 UI `studio.spec.ts` → `35-studio-collaborator`：
  - 声音页改配音 → 新声线写回镜头并排队重配；
  - 中短篇局部改大纲 → 标题与正文保留；
  - 长篇调章节顺序 → 正文随章节重排；
  - 原有台词替换、整章重写、改名。
- 计划卡先预览、确认后应用、应用前整项目快照、可整体撤销；改台词/声线自动清旧配音并重配；改章序/镜序同步编号与蓝图单元。

![创作台](../guide/screens/13-studio-home-dark.png)

## 5. 截图体系

- 已删除历史多轮测试截图与旧指南图（含此前 121MB 旧验证图）；本轮用最新 v0.2.0 构建重新生成 267 张测试截图，收敛为 45 张指南图。
- 指南图在 `docs/guide/screens/`，由 `scripts/build-guide-screens.mjs` 生成 `manifest.json`；每张图有 alt、尺寸与来源；`scripts/optimize-guide-screens.py` 压到 1600px/PNG-8（约 9.4MB）。
- `scripts/check-guide-links.mjs` 校验 89 条本地图片链接全部存在。
- 文档按章节引用：README、用户指南、创作台、模型、设计系统、质检、能力对照、安全、架构、验收。
- 截图来源：`tests/e2e/ui.spec.ts`、`workspace.spec.ts`、`journey.spec.ts`、`studio.spec.ts`、`guide-extra.spec.ts`；全部用 v0.2.0 最新构建启动，不手绘、不使用旧图；协作者落点修复后补拍声音/计划/设置子页并复验失败用例。

## 6. 打包冒烟

- 便携 exe：通过。r050 最终包启动、渲染、截图完成（5.2s）；首屏正常，预加载 API 正常，数据目录按预期创建。
- 安装包：构建成功并做完整性标签 Medium；未做无人值守静默安装测试。
- 交付目录最终只保留两个 exe；运行时缓存属于中间产物，不随交付。

## 7. 已知边界

- 未配置代码签名，SmartScreen 可能提示。
- FFmpeg 不随包内置；配音/配乐/视频依赖本机 TTS/ComfyUI/ACE-Step。
- 订阅渠道未验证的连通状态不显示“已连接”，不伪造额度。
- 完整 E2E 基线不在每轮重跑；本轮跑截图相关 171 条与协作者 3 条真实 UI 用例。

## 8. 复现

```powershell
npm run typecheck
npm run audit:ui
npm run test:unit
npx playwright test tests/e2e/ui.spec.ts tests/e2e/workspace.spec.ts tests/e2e/journey.spec.ts tests/e2e/studio.spec.ts --workers=1
npx playwright test tests/e2e/guide-extra.spec.ts --workers=1
node scripts/build-guide-screens.mjs
python scripts/optimize-guide-screens.py
node scripts/check-guide-links.mjs
MORROW_RUNTIME_REVISION=r050 npm run dist:final
npm run smoke:packaged
```
