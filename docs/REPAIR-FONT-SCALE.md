# 全局字号令牌统一 · 全量审计记录

- 完成时间：2026-11-02
- 起始版本：Morrow `0.2.0`，提交 `c6c7de2`
- 核心文件：`src/renderer/styles.css`、`src/renderer/store.ts`、`scripts/ui-token-audit.mjs`、`tests/e2e/ui.spec.ts`
- 涉及范围：整个渲染层 UI（Agent、Super-Agent、会话、侧栏、设置、创作台、记忆、连接器、终端等）

## 问题根因

字号设置原先只覆盖了三个变量：

```ts
--fs-body = 设置字号
--fs-ui   = 设置字号 - 1
--fs-code = 代码字号
```

其余 `--fs-display`、`--fs-title`、`--fs-base`、`--fs-sm`、`--fs-xs`、`--fs-2xs`、`--fs-3xs` 等仍是固定 px。Super-Agent 任务卡、侧栏卡片、创作台协作者等大量使用 `--fs-xs` / `--fs-3xs` / `--fs-base-plus` / `--fs-panel-*`，所以设置字号时它们不变。

## 修复方式

### 1. 两个基值驱动全部字号

```css
--font-ui-size: 14px;    /* 用户设置 12–15 */
--font-code-size: 12px;  /* 用户设置 11–14 */

--fs-body: var(--font-ui-size);
--fs-ui: max(11px, calc(var(--font-ui-size) - 1px));
--fs-base: max(10px, calc(var(--font-ui-size) - 2px));
--fs-xs: max(8.5px, calc(var(--font-ui-size) - 4px));
...
--fs-display: calc(var(--font-ui-size) + 20px);
--fs-code: var(--font-code-size);
```

- 默认 14 / 12 时，所有令牌的像素值与旧版完全一致；
- 12–15 与 11–14 时，所有字号同步缩放；
- 极小标签设置下限，避免 12px 时掉到 7px；
- 语义令牌 `--text-*`、`--settings-*`、`--fs-panel-*` 继续作为别名，不再另写死值；
- 两个基值统一由 `applyThemePreferences()` 写入：主窗口、独立桌面伙伴窗口和设置变更都走同一条路径，不会再出现某个窗口停留在默认字号。

### 2. 全量审计结果

审计口径：`src/renderer/**/*.css` 与 `src/renderer/**/*.tsx` 中所有字号声明、内联字号与字号令牌定义。

| 项目 | 结果 |
| --- | --- |
| CSS 字号声明 | 1716 条 |
| 使用令牌 | 1712 条 |
| 相对值 / 隐藏用 0 | 4 条（`0.92em`、`0`、两处 `inherit`） |
| `--fs-*` 令牌定义 | 31 个，全部从 `--font-ui-size` / `--font-code-size` 推导 |
| 原始 TSX 内联 px 字号 | 0 条（文档预览与终端渲染例外，见下） |

已确认不再有“组件自己写死字号”的 UI 路径。Super-Agent、侧栏、创作台协作者、设置、对话、命令面板、记忆中心、连接器、文件树、浏览器、时间线等都使用同一套令牌。

### 3. 保留的必要例外

| 例外 | 原因 |
| --- | --- |
| 文档预览 HTML（`artifacts.tsx` 内 `doc-page` / `docx-page`） | 预览必须保持文档自身排版，不能随应用字号改变正文分页与行宽 |
| 导出/打印模板（`main/artifacts.ts`、`main/studio.ts`） | EPUB/PDF/DOCX 属于交付物内容，字号是作品排版的一部分 |
| 画布/封面快照（`studio-core.ts` 中 `ctx.font`） | 导出的位图内容，不是可交互 UI |
| 创作台字幕预览（`studio.tsx` 字幕字号） | 字号来自字幕轨样式，属于视频内容 |
| 终端 xterm `fontWeight: 400` | canvas 渲染器读不到 CSS 自定义属性；字号本身已由代码字号设置驱动 |
| 内置浏览器网页、PDF/Office 预览 | 第三方内容，保持原页面排版 |

### 4. 审计脚本升级

`npm run audit:ui` 现在同时检查：

- 禁止 UI 文件里出现原始 `font-size: Npx`、原始字重/行高/字距；
- 所有 `--fs-*` 定义必须从基值派生，不能写死；
- `styles.css` 必须保留 `--font-ui-size` / `--font-code-size`；
- 文档预览与终端 canvas 使用显式、带注释的例外。

## 验证

```bash
npm run typecheck
npm run audit:ui                     # 0 raw typography declarations, 31 scale-derived tokens
npm run test:unit                    # 490 passed
npm run test:suite                   # 490 unit / 81 e2e / 40 域
npx playwright test tests/e2e/ui.spec.ts -g "字号设置驱动"  # 1 passed
npx playwright test tests/e2e/ui.spec.ts -g "Router 派发 DAG"  # 1 passed（Super-Agent 卡片 10→11→10）
```

E2E 断言：

- 默认：`body 14 / ui 13 / title 20 / 3xs 9 / code 12`，侧栏按钮 12.5px；
- 12px：`body 12 / ui 11 / title 18 / 3xs 8`，侧栏按钮 10.5px，创作台协作者正文 11.5px；
- 15px：`body 15 / ui 14 / title 21 / 3xs 10`，创作台协作者正文 14.5px；
- 代码字号 11px 时 `--fs-code` 为 11px；
- Super-Agent 卡片副标题从 10px → 11px → 10px，跟随全局设置；
- 默认值逐项等于旧版，视觉不变。

截图（12px / 15px）：

![12px 字号下的创作台](screens/font-scale-12.png)

![15px 字号下的创作台](screens/font-scale-15.png)

## 已知边界

- 应用字号只影响 Morrow 自身 UI；内置浏览器网页、PDF/Office 预览与导出作品保持自身排版。
- 极小标签在 12px 设置下有可读下限（8–11px），不会无限缩小；正文与主要 UI 会完整跟随设置。
- 系统级原生菜单、托盘菜单由操作系统绘制，不受应用字号影响。
