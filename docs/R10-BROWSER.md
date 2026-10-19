# R10-C / R10-K1：内置浏览器与浏览器自动化

> 交付：teammate `delivery`（task-24）｜实现范围：`src/main/services/browser-service.ts`、
> `src/main/features/browser.ts`、`src/core/browser-bridge.ts`、`src/core/tools/browser-tools.ts`、
> `src/renderer/src/features/browser/**`、`tests/unit/main/browser.test.ts`、`tests/e2e/r10-browser.spec.ts`。
> 未修改 central `ipc.ts` / `preload` / `feature-ipc.ts` / registry / permissions / App（由 Lead 集成）。

## 1. 交付物与架构

```
renderer  BrowserSurface (chrome: 地址栏/导航/状态/错误页/下载确认)
    │  window.morrow.features.invoke/on("feature:browser:*")
    ▼
main      features/browser.ts ──registerFeatureHandler── feature-ipc.ts（Lead 维护）
    │            │
    │            └── setBrowserBridge(...) ──► core/tools/browser-tools.ts（K1 工具）
    ▼
main      services/browser-service.ts
             ├─ UI surface: WebContentsView（挂在主窗口 contentView，bounds 由渲染层同步）
             ├─ K1 自动化: 独立隐藏 BrowserWindow（同安全 session / 同 preload 基线）
             └─ 安全策略: URL 白名单 / 证书 / 权限 / 下载确认 / 隔离 session
```

- **独立 session 分区**：`persist:morrow-browser`，与主应用 session 隔离（Cookie/缓存/权限互不影响）。
- **远程页面 WebPreferences**：`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、
  `nodeIntegrationInSubFrames:false`、`webviewTag:false`、`webSecurity:true`、
  `allowRunningInsecureContent:false`、`experimentalFeatures:false`、无 `preload`。
- **UI 与自动化分离**：用户可见的 surface 与 K1 自动化窗口互不串扰；自动化只操作自己创建的隐藏窗口，
  不查找/操作用户其它窗口。
- **自动化原语**：真实鼠标事件（`sendInputEvent` mouseDown/mouseUp）、真实文本输入
  （`insertText`）、页面读取（`executeJavaScript`）、`capturePage()` PNG 截图。
  已在 Electron 44 隐藏窗口下实测可用（capturePage/insertText/sendInputEvent 全部生效）。

## 2. 渲染层组件（Lead 挂载）

```tsx
import { BrowserSurface } from './features/browser'

<BrowserSurface
  open={browserOpen}
  onClose={() => setBrowserOpen(false)}
  initialUrl={optionalUrl}
/>
```

| prop | 类型 | 说明 |
| --- | --- | --- |
| `open` | `boolean` | 受控显示。`false` 时组件返回 null 并隐藏原生视图；卸载时自动 `feature:browser:close` |
| `onClose` | `() => void` | 点击关闭按钮时回调（Lead 更新挂载状态） |
| `initialUrl` | `string?` | 首次打开时自动导航（可选） |

行为：地址栏 Enter 打开/导航；前进/后退/刷新/停止；loading 旋转；标题/URL；加载失败/被拦截时显示错误页
（含错误码与重试）；下载请求弹出「允许下载/拒绝」；窗口 resize/fullscreen 时通过
`fe:set-bounds` 持续同步原生视图位置。

> 集成状态：Lead 已在 `src/renderer/src/features/workbench/WorkbenchHost.tsx` 以全屏 overlay 挂载
> `<BrowserSurface open onClose={close} />`。

## 3. IPC 契约（`feature:browser:*`）

| 频道 | 入参 | 返回 |
| --- | --- | --- |
| `get-state` | – | `BrowserState` |
| `open` | `{ url, bounds? }` | `BrowserState` |
| `navigate` | `{ url }` | `BrowserState` |
| `set-bounds` | `{ x, y, width, height }` | `BrowserBounds \| null` |
| `set-visible` | `{ visible }` | `BrowserState` |
| `back` / `forward` / `reload` / `stop` | – | `BrowserState` |
| `close` | – | `BrowserState` |
| `decide-download` | `{ id, allow }` | `{ decided, allow }` |
| `debug-info` | – | 仅 `MORROW_TEST=1`/`--test-mode` 下可用（E2E 用） |

事件：`feature:browser:state`（`BrowserState`）、`feature:browser:download`（`BrowserDownloadRequest`）、
`feature:browser:download-resolved`（`{ id, allow }`）。

`BrowserState`：`{ open, visible, url, title, loading, canGoBack, canGoForward, error }`。

## 4. K1 工具（core 导出数组，Lead 集成 registry）

`browserTools: ToolImpl[]`（`src/core/tools/browser-tools.ts`），名称常量 `BROWSER_TOOL_NAMES`：

| 工具 | 作用 | 关键限制 |
| --- | --- | --- |
| `browser_open` | 打开 http/https 网址 | URL ≤2048；仅 http/https；可省略协议（localhost 补 http） |
| `browser_click` | 点击 CSS selector 或可见文本 | target ≤500；真实鼠标事件；命中后等待导航开始 |
| `browser_type` | 聚焦输入框并键入文本（可选提交） | text ≤4000；`insertText` 真实输入；`submit` 可提交表单 |
| `browser_read` | 读取标题/URL/可见文本 | ≤20000 字符，工具输出再截断到 12000 |
| `browser_screenshot` | 截屏 PNG 并注册 artifact | 写入 `<workspace>/.morrow/browser/*.png`；需工作区 |
| `browser_back` / `browser_forward` | 历史前进/后退 | navigationHistory；不可用时明确报错 |

统一约束：全部 `category=exec`、`risk=high`；bridge 按 `runId` 计步，单轮上限 **40 次**；
每次动作默认超时 10s（加载 20s，均夹在 0.5–30s）；bridge 未注入时返回可读错误；
截图 artifact 通过 `ctx.addArtifact` 进入画布（kind=file）。

## 5. 安全矩阵

| 威胁 | 策略 | 验证 |
| --- | --- | --- |
| `file:` 本地文件读取 | 地址栏/导航/自动化统一拒绝 | 单测 URL 矩阵 + E2E 打开 `file:///C:/Windows/win.ini` 被拒 |
| `javascript:` / `data:` / `blob:` | 协议白名单（http/https）拒绝 | 单测 + E2E |
| `about:` / `chrome:` 特权页 | 协议白名单拒绝 | 单测 |
| URL 内嵌账号密码 | 拒绝（防钓鱼/历史泄漏） | 单测 |
| 远程页面取得 Node/preload | sandbox + contextIsolation + 无 preload + nodeIntegration=false | 单测断言 WebPreferences |
| 证书错误 | `app.on('certificate-error')` 仅对本服务 webContents `preventDefault + callback(false)` | 代码审计；单测覆盖「仅处理自有 webContents」设计 |
| 摄像头/麦克风/地理位置/通知 | session `permissionRequestHandler/CheckHandler` 全部拒绝 | E2E：页面 `navigator.permissions.query(...)` 为 denied* |
| 弹窗/`window.open` | `setWindowOpenHandler` 一律 deny（不打开外部浏览器） | 代码审计 + E2E navigation |
| 下载 | `will-download` 先写入 app 数据目录暂存区（不落用户下载目录），渲染层确认后移动进 `dataPath/downloads`；拒绝/60s 超时删除暂存；自动化窗口下载直接取消 | E2E 拒绝不落盘 / 允许落盘 |
| 跨站 iframe/`<webview>` | `will-attach-webview` preventDefault | 代码审计 |
| 自动化无限循环 | `runId` 步数预算 40 次/轮 | E2E 第 41 次报「步数上限」 |
| 工具操作用户其它窗口 | 只持有本服务 surface/automation 引用，不枚举窗口 | 代码审计 |

\* 权限查询的 E2E 断言在页面上下文执行（`navigator.permissions.query`），当前环境返回 `denied`。

## 6. 权限接线（Lead 集成时必须做）

1. **registry**：`src/core/tools/registry.ts` 中 `import { browserTools } from './browser-tools'`，
   把 `...browserTools` 追加进 `BASE_TOOLS`（放在 external 工具之后，保持既有顺序稳定）。
2. **permissions**：浏览器工具是外部动作，必须加入 `EXTERNAL_ACTION_TOOLS`：
   ```ts
   import { BROWSER_TOOL_NAMES } from './tools/browser-tools'
   export const EXTERNAL_ACTION_TOOLS = new Set(['web_fetch', 'mcp_call', ...BROWSER_TOOL_NAMES])
   ```
   - `category=exec` 已保证 **read-only 模式直接拒绝**；
   - 只有加入 `EXTERNAL_ACTION_TOOLS`，**auto 模式也会逐次 ask**（与 web_fetch/mcp_call 同机制）；
   - `ask` 模式本来就会 ask。
3. **feature 模块注册**：Lead 的 `src/main/features/index.ts` 在 app ready 后调用
   `registerBrowserFeature()`（已由 Lead 集成）；其内部完成 handler 注册、bridge 注入与
   `BrowserService.initialize()`。
4. **re-export**：`src/main/features/browser.ts` 额外导出 `browserService`、`browserAutomationBridge`，
   方便 Lead 做启动/关闭钩子（可选）。

## 6.1 下载与受限令牌环境（实现备注）

- Chromium 在受限令牌下可能无法写默认用户 Downloads（实测下载在 0 字节处 `interrupted`）。
  因此 `BrowserService.initialize()` 会执行 `app.setPath('downloads', dataPath('downloads'))` 并确保目录存在。
- 确认流程不使用 `DownloadItem.pause()/resume()`（Electron 44 实测 pause 后状态仍为 progressing、
  `canResume()` 为 false，`session.downloadURL` 重发也会卡住），改为：
  1. `will-download` 时 `item.setSavePath(<dataPath>/tmp/browser-downloads/<id>-<filename>)`，下载立即开始但不进用户目录；
  2. 渲染层收到 `feature:browser:download`，确认后调用 `decide-download`；
  3. 批准 → 把暂存文件移动到 `dataPath/downloads/<filename>`（同名追加时间戳）；
     拒绝或 60s 未决定 → 删除暂存文件。
- 这样「批准前不落用户下载目录、拒绝后不留文件」，也不依赖 pause/resume 的不可靠行为。

## 7. 与主进程全局安全策略的冲突（重要）

`src/main/index.ts` 的 `app.on('web-contents-created')` 会对**所有** webContents 安装
`will-navigate` 守卫：非 `file://`/dev URL 一律 `preventDefault()` 并 `shell.openExternal(url)`。
这对普通窗口是正确防护，但会让内置浏览器里点击链接变成「在系统浏览器打开」而非页内导航（实测根因）。

**处理**：`BrowserService.adoptOwnNavigationPolicy()` 只对本服务创建的 webContents
`removeAllListeners('will-navigate')`，随后由 `attachNavigationGuards()` 安装**更严格**的策略
（仅 http/https、证书/权限/下载全拒、弹窗 deny）。不影响主窗口，也不会外部拉起浏览器。
若 Lead 后续愿意在 `main/index.ts` 里按 `webContents.session === browserSession` 跳过浏览器，
可移除该适配；在此之前该适配是必要的。

## 8. 验证证据

### 单元测试（`tests/unit/main/browser.test.ts`，23 个用例）

```
npx vitest run tests/unit/main/browser.test.ts   # 23 passed
```

覆盖：URL 安全矩阵、地址栏规范化、页面内导航检查、loopback、WebPreferences 安全基线、
bounds/target 校验、7 个工具 happy path/输入校验/只读拒绝/截图落盘 artifact/错误归一化/bridge 未注入、
权限契约（read-only deny、ask、auto 在接入 EXTERNAL_ACTION_TOOLS 后 ask）。

### E2E（`tests/e2e/r10-browser.spec.ts`，真实 Electron + 本地 HTTP 站点）

```
npm run build
npx playwright test tests/e2e/r10-browser.spec.ts
```

完整日志：`docs/verification/r10-browser-e2e.log`；单测日志：`docs/verification/r10-browser-unit.log`。

- `feature:browser 频道`：危险协议拒绝 → 本地页打开/标题 → bounds 同步 → 导航/后退/前进 → 关闭；
- `K1 自动化`：打开 → read → 真实点击按钮 → 真实输入（insertText）→ 截图 PNG（签名/尺寸）→
  点击链接导航（含目标/坐标/导航断言）→ back/forward → 步数上限；
- `下载确认`：surface 内下载 pause → `feature:browser:download` 事件 → 拒绝不落盘 / 允许落盘；
- `K1 审批`（需 Lead 接线 registry+permissions，`R10_BROWSER_TOOLS_E2E=1`）：
  ask 与 auto 模式都弹 `browser_open` 审批，批准一次后真实打开页面。

**最近一次完整运行**（2026-10-19 22:12，Electron 44.9.0，Lead 已完成 registry/permissions 集成，
本机隔离 data-dir，不带任何 TEMP 接线）：

```
Running 4 tests using 1 worker
✓ feature:browser 频道：URL 安全拦截、打开本地页、导航/历史/bounds/关闭
✓ K1 自动化：读取 → 真实点击 → 真实输入 → 截图 → 后退/前进（隐藏窗口）
✓ 下载确认：surface 下载确认；拒绝不落盘、允许写入 data/downloads
✓ K1 审批（registry + permissions 已集成）：ask 与 auto 模式都逐次审批；批准后 browser_open 真实打开页面
4 passed (7.5s)
```

全量单测（同日）：`npm run test:unit` → **32 files / 459 tests passed**（含本任务 23 个浏览器单测）。
`npm run typecheck` → exit 0；`npm run build` → 成功。

> E2E 通过 `--test-mode` 暴露的 `globalThis.__morrowBrowserService` 调用与 bridge 相同的实现
> （生产模式不暴露）；渲染层事件仍走真实 `feature:browser:*` 频道。

## 9. 残余风险 / 已知限制

1. **主进程全局导航策略冲突**：当前用 `removeAllListeners('will-navigate')` 适配；若未来 main/index.ts
   修改策略需重新核对（建议 Lead 改成按 session 跳过，长期更干净）。
2. **权限 E2E 覆盖有限**：摄像头/麦克风/地理位置的拒绝以 session handler + 单测配置断言为主；
   E2E 只验证 `navigator.permissions.query` 结果，未逐项触发真实设备请求。
3. **证书错误**：未启动自签名 HTTPS 服务做 E2E；实现上仅拒绝本服务 webContents 的证书错误，
   其余窗口保持 Electron 默认。建议审计阶段补一次自签名证书用例。
4. **自动化窗口隐藏渲染**：Windows 下隐藏窗口首帧偶发空白，截图实现带 300ms 重试一次；
   极慢站点仍可能返回空白（会明确报错，不静默产假图）。
5. **点击目标解析**：优先 CSS selector，回退可见文本/placeholder/aria-label；复杂组件（canvas、
   跨 iframe、shadow DOM）可能无法命中——会返回明确错误而不是乱点。
6. **下载文件落盘位置**固定为 `<dataPath>/downloads`，同名文件追加时间戳；
   批准前文件只存在于 `<dataPath>/tmp/browser-downloads`，拒绝/超时（60s）会删除暂存。
7. **E2E 测试专用入口**：`__morrowBrowserService` 只在 `MORROW_TEST=1` 或 `--test-mode` 下挂到
   globalThis；`feature:browser:debug-info` 同样仅测试模式可用。
