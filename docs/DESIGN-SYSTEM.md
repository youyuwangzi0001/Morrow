# Morrow 设计系统

> 母题：**夜桌与地平线**。一个安静的深夜书房：石墨色的桌面上有一道温暖的天光。Morrow = 明天，界面语言始终指向「明天会更轻」。
> 设计原则：**克制的奢华**（材料感、留白、细金线），**可读的行动**（Agent 的每一步都能看懂），**一个记忆点**（地平线 + 行动轨迹），其余全部安静。

---

## 1. 审美判断（与通用 AI 界面的区别）

明确避开：奶油底 + 陶土橙、纯黑 + 荧光酸绿、报纸细线排版、一样的圆角卡片阵列、全大写小标签 + 中缀点元信息、每个按钮都带 →。
Morrow 的记忆点只有两个：
1. **地平线**：1px 香槟色渐变线，出现在品牌下方、Composer 聚焦、发送瞬间扫过。代表「明天」。
2. **行动轨迹（Spine）**：工具调用不是卡片堆，而是一条垂直细线串起的菱形节点 + 等宽字体标签，像一份安静的执行日志。这是产品的灵魂可视化。
其余元素（按钮、列表、弹窗）保持低对比、低装饰。

## 2. 色彩 Token

### 墨夜（默认，dark）
| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#0B0D10` | 应用底色 |
| `--bg-elev` | `#10141A` | 面板/侧栏 |
| `--surface` | `#141922` | 卡片、输入区 |
| `--surface-hover` | `#1A2029` | 悬停 |
| `--surface-active` | `#202733` | 选中 |
| `--line` | `rgba(237,231,218,0.075)` | 1px 分隔线 |
| `--line-strong` | `rgba(237,231,218,0.14)` | 强调边界 |
| `--text` | `#EDE7DA` | 主文字（暖纸白） |
| `--text-2` | `#A39D91` | 次级 |
| `--text-3` | `#6B675F` | 三级/占位 |
| `--gold` | `#C8AE7D` | 主强调（香槟金） |
| `--gold-bright` | `#E4CE9E` | 悬停/高光 |
| `--gold-dim` | `rgba(200,174,125,0.14)` | 金色底纹 |
| `--patina` | `#7FA292` | 成功/完成（铜绿） |
| `--rust` | `#C2795F` | 危险/删除 |
| `--amber` | `#C9A227` | 等待审批 |
| `--mauve` | `#9A8FA8` | 思考/子代理 |
| `--glow` | `radial-gradient(1200px 600px at 78% -10%, rgba(200,174,125,0.055), transparent 60%)` | 夜桌天光 |

### 素纸（light 主题）
| token | 值 |
|---|---|
| `--bg` | `#F1EDE4` |
| `--bg-elev` | `#F6F2E9` |
| `--surface` | `#FBF7EE` |
| `--surface-hover` | `#EFE9DD` |
| `--line` | `rgba(27,26,23,0.10)` |
| `--text` | `#1B1A17` |
| `--text-2` | `#5C574D` |
| `--text-3` | `#8C867A` |
| `--gold` | `#8A6A3C` |
| `--gold-bright` | `#A8844F` |
| `--patina` | `#4F7263` |
| `--rust` | `#A2543F` |

> 「金」只用于：地平线、主按钮发送态、焦点环、关键数字强调、可交互高亮。**任何界面里金色面积不超过 3%**。其余靠灰度层次。

### 桌面小伙伴（灵动岛）

独立透明窗口沿用同一套 tokens，只额外定义 `--island-*` 玻璃材质：夜间为墨色玻璃，日间切为米色玻璃；金色状态线、状态色和文字色都复用全局变量。主窗口切换主题后通过 `settings:changed` 实时同步，不重开窗口。

## 3. 字体

| 角色 | 字体 | 用法 |
|---|---|---|
| 展示/编辑感标题 | **Newsreader** Variable（400/500，斜体 400） | 品牌字、欢迎语、助手大标题、画布标题 |
| UI/正文 | **Manrope** Variable（400/500/600） | 按钮、菜单、正文、标签；字号 13–15px |
| 等宽/仪器感 | **JetBrains Mono**（默认，400/500）；IBM Plex Mono 可选 | 工具轨迹、路径、代码、token 数字、快捷键 |
| 中文正文 | 系统栈：`"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC"` | 保证离线可用 |
| 中文大标题 | 系统栈 Light 字重 + 0.02em 字距；可选 Noto Serif SC 子集（M4 打磨） | 标题的东方编辑感 |

### 3.1 实现层字号阶梯（`src/renderer/src/styles/tokens.css`）

| token | 值 | 用途 |
|---|---|---|
| `--fs-display` | 34px | 品牌/欢迎语等最强装饰标题 |
| `--fs-display-sm` | 26px | 大空态标题、装饰数字 |
| `--fs-display-xs` | 22px | 大图标/局部展示标题 |
| `--fs-h1` | 24px | 页面内一级标题 |
| `--fs-title` | 20px | **设置页页面标题**、对话标题 |
| `--fs-h2` | 17px | 卡片/分区大标题 |
| `--fs-title-sm` | 16px | 小标题 |
| `--fs-body-lg` | 15px | 强调正文 |
| `--fs-body` | 14px | 正文默认（`body`） |
| `--fs-ui` | 13px | 按钮、分区标题、常规 UI |
| `--fs-ui-plus` | 13.5px | 紧凑 UI / 代码块标题 |
| `--fs-base` | 12px | 提示、说明、次要正文 |
| `--fs-base-plus` | 12.5px | 紧凑正文 |
| `--fs-sm` | 11px | 标签、表格元信息 |
| `--fs-sm-plus` | 11.5px | 默认元信息（mono 标签） |
| `--fs-xs` | 10px | 紧凑元信息 |
| `--fs-xs-plus` | 10.5px | 紧凑标签 |
| `--fs-2xs` | 9.5px | 仅密集轨迹/热力图 |
| `--fs-3xs` | 9px | **最小字号**，只用于非关键装饰信息 |

**规则**：正文/按钮/表单不得低于 12px；9–11px 只用于元信息、快捷键、热力图等非阅读主体。新增页面必须引用 token，不允许写死 `font-size: Npx`。

应用字号默认 **14px**（可选 12–15，驱动 `--fs-body`，`--fs-ui` 自动取 `max(12, body-1)`）；代码字号默认 **12px**（可选 11–14，驱动 `--fs-code`）。代码字体默认 **JetBrains Mono**，可切换 IBM Plex Mono 或系统等宽。

### 3.2 字重与语义角色

| token | 值 | 用途 |
|---|---|---|
| `--fw-regular` | 400 | 代码、等宽数字 |
| `--fw-book` | 450 | 正文默认 |
| `--fw-medium` | 500 | 页面标题、强调标签 |
| `--fw-mid` | 550 | 按钮、字段标签 |
| `--fw-semibold` | 600 | 分区标题、强强调 |

### 3.3 行高阶梯

| token | 值 | 用途 |
|---|---|---|
| `--lh-none` | 1 | 单行控件/图标文字 |
| `--lh-title` | 1.2 | 页面/卡片标题 |
| `--lh-tight` | 1.35 | 紧凑标签 |
| `--lh-ui` | 1.45 | 按钮、菜单、表单 |
| `--lh-copy` | 1.55 | 紧凑正文 |
| `--lh-readable` | 1.65 | 说明/提示默认 |
| `--lh-body` | 1.72 | 正文默认 |
| `--lh-loose` | 1.8 | 长文/空态 |

字距 token：`--ls-tight -0.01em`（标题）、`--ls-ui 0.01em`（常规 UI）、`--ls-label 0.02em`（标签）、`--ls-caps 0.06em`（全大写/状态）、`--ls-wide 0.1em`（微型标题）、`--ls-display 0.14em`（品牌字距）。

固定高度元素可以用 `line-height: 20px` 这类像素值，其余一律用 token。

语义别名（页面实现优先用这些，而不是直接写数值）：
`--text-page-title-size/-weight/-leading`、`--text-page-desc-size`、`--text-section-size/-weight`、`--text-body-size`、`--text-ui-size`、`--text-hint-size`、`--text-meta-size`、`--text-code-size/-weight`。

### 3.4 权限卡排版角色（顶层 token）

权限卡是高风险操作唯一的确认界面，字体、字号、字重、行距全部从 `tokens.css` 取，不允许在 `activity.css` 写裸值：

| token | 值 | 用途 |
|---|---|---|
| `--font-permission` | `var(--font-ui)` | 标题、说明、摘要、按钮、脚注 |
| `--font-permission-meta` | `var(--font-code)` | 风险标签、命令、路径、等宽预览 |
| `--text-permission-title-size/-weight/-leading` | 14px / 600 / 1.35 | 「写入 …」标题 |
| `--text-permission-desc-size/-weight/-leading` | 12.5px / 450 / 1.72 | 主说明 |
| `--text-permission-summary-size/-weight/-leading` | 12px / 450 / 1.65 | 补充摘要 |
| `--text-permission-risk-size/-weight/-leading` | 10px / 500 / 1 | 低/中/高风险标签 |
| `--text-permission-preview-size/-weight/-leading` | 11.5px / 450 / 1.45 | 预览折叠按钮 |
| `--text-permission-code-size/-weight/-leading` | 12px / 400 / 1.65 | 命令与文本预览 |
| `--text-permission-button-size/-weight/-leading` | 12.5px / 500 / 1.45 | 允许/拒绝按钮 |
| `--text-permission-note-size/-weight/-leading` | 11.5px / 450 / 1.45 | 高风险逐次确认说明 |
| `--text-permission-foot-size/-weight/-leading` | 11px / 450 / 1.65 | 底部提示 |

`tests/e2e/14-journey.spec.ts` 在真实审批卡上断言这些计算值；`npm run audit:ui` 继续阻止任何裸字号/字重/行高。

当前规范：设置页标题 **20px / 500 / 1.2 / -0.01em**；分区标题 **13px / 600**；说明文字 **12px / 1.65**；正文 **14px / 450**；代码 **400**。

行宽：对话列 `max-width: 720px`；画布内容 ≤ 900px。

## 4. 间距 / 圆角 / 层级 / 材质

- 间距 token：`--sp-1..10` = `4 8 12 16 20 24 32 40 56 72`。布局用 `--sp-6/7`，卡片内 `--sp-4/5`，行内 `--sp-2/3`；语义别名 `--card-pad`、`--row-gap`、`--section-gap`。
- 圆角 token（当前实现）：`--r-xs 4px`、`--r-sm 5px`、`--r-md 7px`、`--r-lg 9px`、`--r-xl 12px`、`--r-full 999px`；语义别名 `--r-control`（按钮/输入）、`--r-card`（卡片）、`--r-modal`（弹窗）、`--r-pill`。按钮统一 `--r-control`，小按钮用 `--r-xs`；卡片 `--r-card`；弹窗 `--r-modal`。不要给所有元素同一个圆角。
- 控件高度：`--control-xs 22px`、`--control-sm 28px`、`--control-md 34px`、`--control-field 36px`（输入框）、`--control-lg 40px`；图标：`--icon-xs 10px`、`--icon-sm 12px`、`--icon-md 14px`、`--icon-lg 16px`、`--icon-xl 20px`。UI Kit 的按钮高度只从这组 token 取。
- 阴影只在浮层：`0 24px 80px -24px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.35)`；普通卡片靠 1px 线 + 色差，不用阴影。
- 材质：`--grain` 2.5% 噪点覆盖全应用（SVG feTurbulence，性能友好）；玻璃仅用于命令面板/审批浮层（`backdrop-filter: blur(20px) saturate(120%)`）。
- 图标：lucide，`stroke-width: 1.5`，16/18px；图标颜色继承文字，不做彩色图标。

## 5. 布局

```
┌─────────────────────────────────────────────────────────────────────┐
│ · 44px titlebar (drag) — 左：平台留白/品牌字；中：会话标题；右：模型 · 窗控 │
├──────────────┬──────────────────────────────────────────────────────┤
│ sidebar 264  │  content (max 720 居中)                              │
│ ┌ brand      │   ┌ transcript 滚动 ─────────────────────────────┐  │
│ │ M  Morrow   │   │  welcome / messages / activity spine         │  │
│ ├ 新建对话 +  │   └───────────────────────────────────────────────┘  │
│ ├ 搜索/命令  │   ┌ plan tray（有 todo 时出现）──────────────────┐  │
│ ├ 项目/会话   │   ┌ composer ─────────────────────────────────────┐ │
│ └ footer      │   │ + 输入……                      model · 权限 · ↑ │ │
└──────────────┴──────────────────────────────────────────────────────┘
右侧画布可滑出（宽度 42%，min 420），与会话并排，hairline 分隔。
```
- 侧栏可折叠为 64px 图标栏（hover 提示），`Ctrl+B`。
- 欢迎态：Composer 位于垂直 46% 处；标题 greeting 用 Newsreader Italic + 中文 Light。
- 滚动条：8px，thumb `--line-strong`，hover 变金，轨道透明。

## 6. 关键组件规范

### 6.1 地平线
- 品牌下方 28px 宽、1px 高、`linear-gradient(90deg, transparent, var(--gold), transparent)`。
- Composer 聚焦时地平线出现在其顶部边缘，透明度 0→0.8，280ms。
- 发送时一条 2px 金色光带从输入区左向右扫过（400ms），随后消息段落依次淡入。

### 6.2 行动轨迹 Spine
- 垂直 1px `--line-strong`；节点 6px 菱形（旋转 45°），状态色：运行中金色呼吸、成功 `--patina`、失败 `--rust`、等待审批 `--amber`、子代理 `--mauve`。
- 行结构：`[节点] 工具图标 标题（人类语言）  路径/摘要（mono 12px，text-3）  耗时（mono，右）`。
- 展开：参数 JSON（折叠 ≤6 行）、结果（前 40 行）、diff（红绿低饱和底 `rgba(194,121,95,.08)` / `rgba(127,162,146,.08)`）。
- 标题必须人话：`读文件 sales-q3.csv`、`运行命令 npm install`、`搜索 "退款率"`。

### 6.3 消息
- 用户：右对齐，`--surface` 底、`--r-md`、最大宽 78%、内边距 12/16；无头像。
- 助手：无气泡，正文直接排在画布上；段首无「AI」标识；块级标题用 Newsreader；列表缩进紧凑。
- 思考：`--mauve` 斜体小字，默认折叠为一行「思考了 12 秒」。
- 流式光标：6px 宽 1.2em 金色竖条，600ms 呼吸。

### 6.4 Composer
- 容器：`--surface`、1px `--line`、`--r-lg`、内阴影 `inset 0 1px 0 rgba(255,255,255,.03)`；高度自适应 56→240px。
- 内部布局：顶部输入区（无边框 textarea），底部工具条：`+` 附件 · 工作区 chip · 模型选择 · 权限选择 · 位置右：发送按钮（36px 圆形，激活时金色渐变，图标 `arrow-up`）。
- 快捷键提示藏在 placeholder 与 tooltip；不做常驻提示条。
- 拖入文件：整块 composer 金色细描边 + 底部「松开以添加 3 个文件」。

### 6.5 权限卡
- 出现在轨迹流中，左侧 2px `--amber` 竖线，背景 `--surface`；标题「Morrow 想运行一条命令」；参数 mono 展示；展开可看完整内容。
- 按钮：主「允许一次」（金色描边）、次「始终允许（本工作区）」（持久规则，可在设置中删除）、危险文字「拒绝」；`Enter` 允许一次 / `Esc` 拒绝。

### 6.6 计划面板（Plan Tray）
- 位于 Composer 上方，可折叠，默认展开；标题「计划」+ 进度 `3/7`（mono）；条目 20px 行高，状态用 8px 方块：待办 `--line-strong` 空心、进行中金色脉冲、完成 `--patina` 实心 + 删除线弱化。
- 不做百分比进度条，用细线即可。

### 6.7 画布（Artifacts）
- 从右侧滑出，顶部 tabs（mono 文件名）、右侧操作（外部打开、全屏、关闭）。
- 预览背景 `--bg`，内容衬纸色卡片；HTML iframe 无边框、圆角 8px。
- 空态：一句话「让 Morrow 做一个网页、一份报告或一张图，成品会出现在这里。」

### 6.8 命令面板
- 居中浮层，宽 620，背景玻璃 + 1px line + 大阴影；输入无边框；结果按「操作 / 会话 / 文件」分组，键盘上下选择，选中项左侧金色 2px 竖条。
- 动效 180ms：opacity 0→1, scale .98→1, blur 8px→0。

### 6.10 页签（统一微圆角悬浮）

终端、浏览器、画布文件页签、Git 视图、项目视图与 Office 工作表共用一组顶层 token。页签不是「贴顶的文件夹」，而是 24px 高的微圆角悬浮块：

| token | 值 | 用途 |
|---|---|---|
| `--tab-height` | 24px | 页签高度 |
| `--tab-radius` | 5px | 微圆角 |
| `--tab-gap` | 3px | 页签间距 |
| `--tab-pad-x` / `--tab-pad-right` | 9px / 4px | 左内边距 / 右侧关闭区 |
| `--tab-font-size` | 11px | 页签标题 |
| `--tab-border` | 1px solid transparent | 默认透明边框，避免选中时跳动 |
| `--tab-color` / `--tab-hover-color` / `--tab-active-color` | text-2 / text / text | 文字层级 |
| `--tab-hover-bg` / `--tab-active-bg` | surface-hover / surface | 悬停 / 选中底色 |
| `--tab-active-border` | line-gold | 选中金色细边 |
| `--tab-close-size` / `--tab-close-radius` | 20px / 4px | 关闭按钮 |

页签栏本身：34px 高、`padding: 0 8px 0 10px`、1px 底部分隔线、`background: --bg-elev`。选中态只用「金色 1px 边框 + surface 底」，不再使用顶部圆角或底部金色下划线。

### 6.11 订阅详情（ChatGPT / Codex 为基准）

所有订阅渠道的详情页共用同一套排版与控件尺寸，不在 Qoder / Kimi / GLM 等页面单独调小：

| 角色 | token | 值 |
|---|---|---|
| 详情标题 | `--text-sub-detail-title-*` | 20px / 500 / 1.2，Newsreader |
| 详情说明 | `--text-sub-detail-desc-*` | 12.5px / 1.65 |
| 面板标题 | `--text-sub-panel-title-*` | 13px / 600 / 1.45 |
| 正文/连接说明 | `--text-sub-body-*` | 12.5px / 1.65 |
| 连接项标题 / 描述 | `--text-sub-connect-title-size` / `--text-sub-connect-desc-size` | 13px / 12px |
| 注释 / 免责声明 | `--text-sub-note-*` / `--text-sub-disclaimer-size` | 12px / 1.65 |
| 主操作按钮 | `--text-sub-button-*` | 34px 高 / 13px / 500 |
| 面板内小按钮 | `--text-sub-small-button-*` | 28px 高 / 12px |
| 面板内边距 / 连接项内边距 | `--sub-panel-pad` / `--sub-connect-pad` | 16px / 12px 13px |

`tests/e2e/08-settings.spec.ts` 打开 ChatGPT/Codex 与 Qoder 两个详情页，断言标题、说明、正文、按钮、连接项与免责声明的计算值一致，并输出双主题截图。

### 6.9 空/错/加载态
- 空：一句编辑感文案 + 3 个不对称「纸片」建议（一大两小），每个含标题与一行说明，hover 时金色细边浮现。
- 加载：不用通用 spinner；用 1px 金色线段在顶部 2s 循环（`horizon loader`）。
- 错误：一句人话 + 「怎么办」半句 + 一个动作按钮；mono 显示错误码可复制。
- 离线：标题栏出现小圆点 + 文案「模型未连接」，点击进设置。

## 7. 动效

| 场景 | 时长/曲线 |
|---|---|
| 消息进入 | 240ms `cubic-bezier(.2,.8,.2,1)`，opacity+6px translateY |
| 工具节点运行 | 金色呼吸 1.6s ease-in-out infinite |
| 画布滑出 | 320ms 同曲线，遮罩淡入 200ms |
| 弹窗/命令面板 | 180ms scale+opacity |
| 发送光带 | 400ms `cubic-bezier(.4,0,.2,1)` |
| hover | 120ms color/background |
| `prefers-reduced-motion` | 全部降为 ≤1ms 或直接切换 |

## 8. 文案语气

- 第一人称「我」，对用户称「你」；不用「您」，不卖萌，不用感叹号。
- 动词开头、句子短；错误不道歉，直接说发生了什么 + 下一步。
- 例：`API Key 无效。请检查是否复制完整，或换一个模型提供方。`
- 例：`这条命令会删除工作区外的文件，已被拦下。`
- 按钮 = 动作结果：`允许一次` `停止生成` `撤销这次修改` `打开文件夹`。
- 空态不煽情：`今天想完成什么？` 副行 `说清想要的结果就行，过程我来想办法。`

## 9. 令牌审计与维护

- `npm run audit:ui` 扫描全部渲染层 CSS：字号/字重/无单位行高出现裸值即失败；当前 50 个 CSS + 66 个 TSX 文件、0 处裸字号/字重/行高/字距（文档预览 iframe 白名单除外）。
- `tests/e2e/08-settings.spec.ts`（合并后的设置域）在真实 Electron 中校验页面标题 20px/500、说明 12px、分区 13px/600、正文 14px/450、代码 400、按钮高度 28/34，以及权限卡排版 token。
- 调整视觉规范只改 `tokens.css` 与对应语义别名；不要在组件里新增字号。9–11px 只用于非阅读主体，正文不得低于 12px。

## 10. 可达性

- 正文对比度 ≥ 7:1，次级 ≥ 4.5:1；金色仅用于非正文。
- 全键盘可达：Tab 焦点环 `0 0 0 1px var(--gold)`；Esc 关闭/停止；对话区快捷键列表进设置。
- 窗口缩放 100–200% 不破版；最小窗口 1000×680。
- 不用颜色单独表意，状态同时有文字/形状。

## 10. 品牌

- 字标：`Morrow`，Newsreader 400，字距 -0.015em；前方 monogram：`M` 衬线 + 下方 14px 金色地平线。
- 应用图标：石墨底 (#10141A) + 香槟金细线构成的地平线上升弧 + 衬线 M；多尺寸 ICO（16–256）。
- 启动画面（首帧）：墨底 + 金色地平线渐显 + 字标，≤ 600ms。
