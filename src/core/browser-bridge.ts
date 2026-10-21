/**
 * 浏览器自动化桥（core ↔ main）。
 *
 * core 是纯 TS 运行时（不 import electron）；真实浏览器能力由主进程实现：
 * - 主进程在启动时调用 `setBrowserBridge(...)` 注入实现；
 * - `src/core/tools/browser-tools.ts` 里的工具只依赖本文件的接口；
 * - 单元测试可注入假 bridge，不启动 Electron。
 *
 * 安全策略常量也放在这里（纯数据），main 与 renderer/tests 共用同一口径：
 * - 仅 http/https；localhost 允许；file/javascript/data/blob 等一律拒绝；
 * - 远程页面 webPreferences：sandbox + contextIsolation + 无 Node/preload；
 * - 所有外部动作必须经权限审批（权限层接线见 docs/R10-BROWSER.md）。
 */

/** 浏览器专用持久化 session 分区（与主应用 session 隔离） */
export const BROWSER_PARTITION = 'persist:morrow-browser'

/** 允许的导航协议（地址栏/页面跳转/自动化 open 统一口径） */
export const BROWSER_ALLOWED_PROTOCOLS = ['http:', 'https:'] as const

/** 远程页面 WebPreferences 安全基线（main 直接展开使用；纯对象便于单测断言） */
export const BROWSER_WEB_PREFERENCES = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  safeDialogs: true,
  spellcheck: false,
  backgroundThrottling: false
  // 注意：不设置 preload —— 远程页面拿不到任何 Morrow 能力
} as const

/** K1 自动化限制（工具层与 service 层双重约束） */
export const BROWSER_LIMITS = {
  /** 单次加载超时 */
  openTimeoutMs: 20_000,
  /** 单次动作（click/type/read/screenshot/back/forward）超时 */
  actionTimeoutMs: 10_000,
  minTimeoutMs: 500,
  maxTimeoutMs: 30_000,
  /** 单次 run 的自动化动作上限（含 open） */
  maxActionsPerRun: 40,
  /** 读取页面文本上限（字符） */
  maxReadChars: 20_000,
  /** 输入文本上限 */
  maxTypeChars: 4_000,
  /** 目标（CSS selector / 可见文本）长度上限 */
  maxTargetChars: 500,
  /** URL 长度上限 */
  maxUrlChars: 2_048,
  /** 自动点击的控件类型 */
  clickableSelector: 'a,button,input[type="submit"],input[type="button"],[role="button"],[role="link"]',
  /** 等待页面加载完成的最长轮询时间 */
  loadPollMs: 200
} as const

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  /** 当前是否已创建浏览器视图 */
  open: boolean
  /** 是否可见（面板打开且无致命错误） */
  visible: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 最近一次致命错误（加载失败/被安全策略拦截）；成功后清空 */
  error: { code: string; message: string } | null
  /** Agent 正在操作这个页面（用于面板上的「Morrow 操作中」提示） */
  automationActive: boolean
}

export interface BrowserDownloadRequest {
  id: string
  filename: string
  url: string
  /** 建议保存路径（dataPath/downloads/...），批准后使用 */
  suggestedPath: string
  totalBytes: number
  createdAt: number
}

export interface BrowserScreenshotResult {
  /** PNG base64（不含 data: 前缀） */
  pngBase64: string
  width: number
  height: number
  url: string
  title: string
}

export interface BrowserReadResult {
  url: string
  title: string
  text: string
  truncated: boolean
}

export interface BrowserActionResult {
  url: string
  title: string
  /** 目标的人类可读描述（用于工具结果/日志） */
  target?: string
  /** 实际发送鼠标事件的位置（CSS px / DIP），便于 E2E 断言与排障 */
  x?: number
  y?: number
  /** 点击后是否已开始导航（用于等待/日志） */
  navigating?: boolean
}

/** 每次调用都带 runId：bridge 用它做「单轮步数上限」，避免自动化无限自循环 */
export interface BrowserCallContext {
  runId: string
  timeoutMs?: number
}

export interface BrowserBridge {
  open(url: string, ctx: BrowserCallContext): Promise<BrowserState>
  click(target: string, ctx: BrowserCallContext): Promise<BrowserActionResult>
  type(target: string, text: string, ctx: BrowserCallContext & { submit?: boolean }): Promise<BrowserActionResult>
  read(ctx: BrowserCallContext & { maxChars?: number }): Promise<BrowserReadResult>
  screenshot(ctx: BrowserCallContext): Promise<BrowserScreenshotResult>
  back(ctx: BrowserCallContext): Promise<BrowserState>
  forward(ctx: BrowserCallContext): Promise<BrowserState>
  /** 关闭自动化浏览器（工具/主进程退出时调用） */
  closeAutomation(): Promise<void>
}

let bridge: BrowserBridge | null = null

/** 主进程启动时注入真实实现；传 null 可清除（测试用） */
export function setBrowserBridge(next: BrowserBridge | null): void {
  bridge = next
}

export function getBrowserBridge(): BrowserBridge | null {
  return bridge
}

/** bridge 未注入时工具返回的用户可读错误 */
export class BrowserUnavailableError extends Error {
  constructor() {
    super('浏览器自动化不可用：主进程尚未初始化浏览器服务。')
    this.name = 'BrowserUnavailableError'
  }
}

/* ── 纯函数安全策略（main 与单测共用） ─────────────────────────── */

export interface BrowserUrlCheck {
  allowed: boolean
  /** 规范化后的 URL（allowed=true 时存在） */
  url?: string
  /** 拒绝原因（给用户/模型看的人话） */
  reason?: string
}

/**
 * 地址栏/自动化入口的 URL 安全检查：
 * - 仅允许 http/https；
 * - 拒绝 file/javascript/data/blob/about 等协议（含大小写变体）；
 * - 拒绝带用户名/密码的 URL（防钓鱼/凭据泄漏到地址栏与历史）；
 * - http/https 的 host 必须存在；localhost/127.0.0.1/[::1] 允许。
 */
export function checkBrowserUrl(raw: string): BrowserUrlCheck {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { allowed: false, reason: '网址不能为空。' }
  if (trimmed.length > BROWSER_LIMITS.maxUrlChars) {
    return { allowed: false, reason: `网址过长（上限 ${BROWSER_LIMITS.maxUrlChars} 字符）。` }
  }
  // 禁止控制字符 / 换行（防止日志注入与解析歧义）
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { allowed: false, reason: '网址包含不可见控制字符，已拒绝。' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { allowed: false, reason: '网址格式无效。请输入完整地址，例如 https://example.com。' }
  }
  const protocol = parsed.protocol.toLowerCase()
  if (!(BROWSER_ALLOWED_PROTOCOLS as readonly string[]).includes(protocol)) {
    return {
      allowed: false,
      reason: `只允许 http / https 网址（当前为 ${protocol}）。浏览器不允许打开本地文件、javascript: 或 data: 页面。`
    }
  }
  if (!parsed.hostname) return { allowed: false, reason: '网址缺少主机名。' }
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: '网址包含账号密码，出于安全考虑已拒绝。' }
  }
  return { allowed: true, url: parsed.toString() }
}

/**
 * 地址栏输入规范化（给用户便利）：
 * - 完整 URL 直接走 checkBrowserUrl；
 * - 省略协议时自动补 https://（localhost/127.0.0.1 补 http://）；
 * - 危险协议保持原样交给 checkBrowserUrl 拒绝并给出明确原因。
 */
export function normalizeBrowserAddress(raw: string): BrowserUrlCheck {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return { allowed: false, reason: '网址不能为空。' }
  // 已知 URL 协议（含危险协议）原样交给安全检查；`localhost:3000` 这类 host:port 不当作协议
  if (/^(?:https?|file|javascript|data|blob|about|chrome|ftp|mailto|tel|vbscript):/i.test(trimmed) || trimmed.includes('://')) {
    return checkBrowserUrl(trimmed)
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(trimmed)
  return checkBrowserUrl(`${local ? 'http://' : 'https://'}${trimmed}`)
}

/** 页面内导航（will-navigate/will-redirect/窗口打开）的安全检查：不补协议，必须已规范 */
export function isBrowserNavigationAllowed(rawUrl: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(rawUrl)) return false
  try {
    const parsed = new URL(rawUrl)
    const protocol = parsed.protocol.toLowerCase()
    if (!(BROWSER_ALLOWED_PROTOCOLS as readonly string[]).includes(protocol)) return false
    if (!parsed.hostname) return false
    if (parsed.username || parsed.password) return false
    return true
  } catch {
    return false
  }
}

/** 判断是否是本地回环地址（localhost 允许；用于 UI 提示与日志，不改变放行规则） */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/** bounds 安全化：必须是有限非负整数；不合法时返回 null（调用方保持原 bounds） */
export function sanitizeBrowserBounds(raw: unknown): BrowserBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const values = ['x', 'y', 'width', 'height'].map((key) => Number(source[key]))
  if (values.some((value) => !Number.isFinite(value))) return null
  const [x, y, width, height] = values.map((value) => Math.round(value))
  if (width <= 0 || height <= 0) return null
  if (width > 10_000 || height > 10_000) return null
  return { x, y, width, height }
}

/** 工具/自动化目标（CSS selector 或可见文本）的长度与内容基础校验 */
export function validateBrowserTarget(raw: unknown): { ok: true; target: string } | { ok: false; reason: string } {
  const target = typeof raw === 'string' ? raw.trim() : ''
  if (!target) return { ok: false, reason: 'target 不能为空：请提供 CSS selector 或元素可见文本。' }
  if (target.length > BROWSER_LIMITS.maxTargetChars) {
    return { ok: false, reason: `target 过长（上限 ${BROWSER_LIMITS.maxTargetChars} 字符）。` }
  }
  if (/[\u0000-\u001f\u007f]/.test(target)) return { ok: false, reason: 'target 包含控制字符，已拒绝。' }
  return { ok: true, target }
}
