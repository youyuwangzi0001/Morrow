# UI 集成契约（Lead 维护）

> 渲染层采用「单 store + 组件直连 store」模式。`src/renderer/src/state/store.ts` 是唯一状态源（zustand），
> 所有功能组件通过 `useAppStore` 选择所需切片，props 只用于纯展示参数。禁止组件内直接调 `window.morrow`，
> 一律通过 store actions。

## 1. 目录与拥有者

| 目录 | 拥有者 | 说明 |
|---|---|---|
| `src/renderer/src/App.tsx`、`App.css` | lead | 应用组装、布局、覆盖层挂载 |
| `src/renderer/src/state/**` | lead | store、事件归约、IPC 封装、selectors |
| `src/renderer/src/ui/**` | lead | 基础组件（Button/IconButton/Tooltip/Modal/Field/Select/Switch/Segmented/Badge/Kbd/ToastViewport/Spinner/ScrollArea） |
| `src/renderer/src/styles/**` | lead | tokens / base / 字体 |
| `src/renderer/src/features/shell/**` | shell | TitleBar、Sidebar、Welcome、Toasts、错误横幅 |
| `features/composer/**` | shell | Composer、附件、@引用、/命令、模型与权限芯片 |
| `features/settings/**` | shell | 设置弹窗（模型连接/权限/外观/关于） |
| `features/onboarding/**` | shell | 首次引导 |
| `features/palette/**` | shell | 命令面板 Ctrl+K |
| `features/chat/**` | surfaces | Transcript、用户/助手消息、流式、思考、错误态 |
| `features/activity/**` | surfaces | 行动轨迹 Spine、工具卡、权限卡、提问卡、计划托盘 |
| `features/artifacts/**` | surfaces | 画布、HTML 沙箱预览、代码/Markdown 预览 |
| `features/demo/**` | surfaces | 演示模式呈现（步骤字幕/入口提示） |
| `components/**` | surfaces | Markdown、代码高亮、Diff、Prose 样式 |

样式：每个 feature 目录放自己的 CSS 文件（如 `Sidebar.css`），类名带前缀（`.sidebar-*`、`.spine-*`），
颜色/间距/圆角/动效一律使用 `styles/tokens.css` 的 CSS 变量，不要硬编码颜色（状态色用 `--status-*`）。

## 2. store 契约（`state/store.ts`）

```ts
import { useAppStore } from '@renderer/state/store'

interface AppStore {
  // 启动与数据
  ready: boolean
  bootError: string | null
  settings: Settings
  sessions: SessionMeta[]
  projects: Project[]
  appInfo: AppInfo | null
  demoAvailable: boolean
  hasAnyApiKey: boolean

  // 当前会话
  activeSessionId: string | null
  session: Session | null          // 已加载的当前会话
  loadingSession: boolean

  // 运行态
  run: { runId: string; sessionId: string; startedAt: number } | null
  streaming: { messageId: string; text: string; thinking: string } | null
  pendingPermission: PermissionRequest | null
  pendingQuestion: AskUserRequest | null
  compacting: boolean
  demoStep: { index: number; total: number; caption: string } | null

  // UI
  sidebarCollapsed: boolean
  canvas: { open: boolean; artifactId: string | null }
  paletteOpen: boolean
  settingsOpen: boolean               // 设置弹窗
  onboardingOpen: boolean
  planExpanded: boolean
  theme: ThemeMode
  toast: Toast | null
  searchQuery: string

  // actions（节选，全部返回 Promise<void> 除非注明）
  init(): Promise<void>
  newSession(opts?: { workspace?: string | null; openOnboarding?: boolean }): Promise<void>
  selectSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  sendMessage(text: string, attachments?: Attachment[]): Promise<void>
  stopRun(): Promise<void>
  respondPermission(decision: PermissionDecision): Promise<void>
  respondQuestion(answer: AskUserAnswer): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  setTheme(theme: ThemeMode): void
  toggleSidebar(): void
  openSettings(): void; closeSettings(): void
  openPalette(): void; closePalette(): void
  openCanvas(artifactId?: string): void; closeCanvas(): void
  setPlanExpanded(v: boolean): void
  pickWorkspace(): Promise<void>
  attachFiles(): Promise<Attachment[]>
  searchFiles(query: string): Promise<FileSearchResult[]>
  startDemo(): Promise<void>
  dismissToast(): void
  copyText(text: string): Promise<void>
  revealArtifact(path: string): Promise<void>
  saveArtifactAs(path: string): Promise<void>
}
```

事件归约：`applyEvent(event: RuntimeEvent)`（init 时订阅 `window.morrow.onEvent`）。store 内部已处理：
流式增量、工具状态、权限/提问、todos、artifacts（新产物自动打开画布）、usage、run 生命周期、错误 toast。
组件只读状态、不改状态（除 UI 本地状态）。

常用 selector 建议：
- 会话标题：`session?.title ?? '新对话'`
- 是否运行：`!!run`
- 上下文占用：`session?.usage.contextUsed / contextLimit`

## 3. 组件导出契约（App.tsx 将按此挂载）

```tsx
// shell
export function TitleBar(): JSX.Element
export function Sidebar(): JSX.Element
export function Welcome(): JSX.Element            // 空状态：问候 + 建议纸片 + 演示入口
export function Toasts(): JSX.Element
// 布局要求：<main> 内上下结构 Transcript + PlanTray + Composer

// surfaces
export function Transcript(): JSX.Element          // 滚动容器 + 消息列表 + 自动跟随
export function PlanTray(): JSX.Element            // 有 todos 时显示，位于 Composer 上方
export function Canvas(): JSX.Element              // 右侧画布抽屉（自己控制开合动画）
// overlay
export function SettingsModal(): JSX.Element
export function Onboarding(): JSX.Element
export function CommandPalette(): JSX.Element
export function DemoOverlay(): JSX.Element         // 演示模式字幕/进度（可选）
```

App.tsx 负责：`init()`、主题与 `data-*` 属性、快捷键（Ctrl+K / Ctrl+B / Ctrl+N / Esc）、首次引导挂载、
条件渲染 Welcome vs Transcript、Composer 常驻、Canvas/PlanTray 挂载、全局 overlay。

## 4. 设计语言要点（务必遵守 `docs/DESIGN-SYSTEM.md`）
- 石墨底 + 暖纸白文字 + 香槟金 ≤3% 面积；金色只用于动作、焦点、地平线、关键数字。
- 展示字体 Newsreader（`font-family: var(--font-display)`），UI 字体 Manrope，仪器感文字 IBM Plex Mono。
- 禁用：奶油底+陶土橙、酸绿、全大写小标签堆叠、统一圆角卡片阵列、每个按钮加 →。
- 签名元素：地平线（1px 金色渐变线）、行动轨迹 Spine（竖线+菱形节点+等宽标签）。
- 动效克制：消息 240ms 淡入上移、工具节点金色呼吸、画布 320ms 滑入、命令面板 180ms；尊重减少动效。
- 文案：中文、动词开头、不卖萌、错误说人话（发生了什么 + 怎么办）。
- 键盘可达：所有操作可 Tab 到达，焦点环金色；按钮有 aria-label；弹窗 Esc 关闭且焦点陷阱。

## 5. 并行开发约定
- 你的目录内可自由创建文件；需要 `ui/**` 新基础组件时先看现有组件，不够用时给 Lead 发消息，不要自行创建到 `ui/`。
- 需要修改 store 或 App.tsx 时给 Lead 发消息，由 Lead 修改。
- 截图自检：`npm run build && node scripts/shot.mjs <name> [--theme=light] [--wait=ms]`（脚本会自动用项目内数据目录启动 Electron）。
- 每完成一个页面/交互，至少留一张 `docs/verification/screens/` 截图并在报告里给出路径。
