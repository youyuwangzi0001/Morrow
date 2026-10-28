// 通用工具、Shell 调用与浏览器桥：由 core/util、core/shell、core/browser-bridge 扁平合并。
import { createHash, randomUUID } from 'node:crypto'
import type { CommandShell } from './types'



/** 生成带前缀的短 id：msg_lx3k9a1f2b3c */
export function newId(prefix: string): string {
  const uuid = randomUUID().replace(/-/g, '')
  return `${prefix}_${uuid.slice(0, 16)}`
}


/** 可被 AbortSignal 打断的 sleep；被打断时 reject 一个 name='AbortError' 的错误 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}


export function abortError(message = '操作已中断'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}


export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'AbortException'
}


/** 让 promise 与 AbortSignal 竞争：中断时立即 reject，避免审批/提问把整个 run 挂死 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {  if (!signal) return promise
  if (signal.aborted) {
    // 仍然吞掉原 promise 的后续 rejection，避免 unhandledRejection
    void promise.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err: unknown) => {
        cleanup()
        reject(err)
      }
    )
  })
}


export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}


/**
 * 带 AbortSignal 的异步迭代：即使 Provider 内部不响应中断（例如自定义实现），
 * Agent 也能在 signal 触发后立刻停止等待，保证「停止」按钮永远有效。
 */
async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(abortError())
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    iterator.next().then(
      (result) => {
        if (settled) {
          // 已经因中断 reject，忽略迟到的结果（并尝试关闭底层迭代器）
          if (!result.done) void iterator.return?.(undefined)?.catch?.(() => undefined)
          return
        }
        settled = true
        cleanup()
        resolve(result)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }
    )
  })
}


/** 把任意 AsyncIterable 包装成「可被 signal 立刻打断」的迭代器 */
export async function* iterateWithAbort<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    for (;;) {
      const result = await nextWithAbort(iterator, signal)
      if (result.done) return
      yield result.value
    }
  } finally {
    try {
      await iterator.return?.(undefined)
    } catch {
      // 关闭失败不影响上层中断流程
    }
  }
}


/** 单行单元格（用于报告/日志，不做 HTML 转义） */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}


/** 安全 JSON 解析：失败返回 null，绝不抛错（模型输出/SSE 帧都可能不完整） */
export function safeJsonParse<T = unknown>(text: string): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}


/**
 * 容错解析工具参数 JSON：
 * 1) 去掉 markdown 代码围栏；
 * 2) 从第一个 { 截到最后 } —— 兼容模型在 JSON 前后夹带解释文字；
 * 3) 去掉尾逗号再试一次。
 * 全部失败返回 null，由上层回灌「参数不合法，请重新输出」。
 */
export function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return {}
  const candidates: string[] = []
  const trimmed = raw.trim()
  candidates.push(trimmed)
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    const parsed = safeJsonParse<Record<string, unknown>>(candidate)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  }
  // 尾逗号 / 其它常见小错
  for (const candidate of candidates) {
    const repaired = candidate.replace(/,\s*([}\]])/g, '$1')
    const parsed = safeJsonParse<Record<string, unknown>>(repaired)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  }
  return null
}


/** 按字符截断并给出「已截断」说明（中英文按字符，不做字节裁剪） */
export function truncateText(text: string, maxChars: number, note = '输出已截断'): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（${note}，共 ${text.length} 字符，仅显示前 ${maxChars} 字符）`
}


/** 形如 1.2 秒 / 850 毫秒 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}


export { formatBytes } from '../shared/types'


/** 把任意异常归一化为可读文本 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}


/** 限制整数到 [min,max] */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}


const PS_PREFIX =
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding=[Console]::OutputEncoding; $ProgressPreference="SilentlyContinue"; '


export function fallbackCommandShell(): CommandShell {
  return process.platform === 'win32'
    ? { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe' }
    : { id: 'default', label: '默认终端', file: '/bin/sh' }
}


export function buildOneShotInvocation(
  shell: CommandShell | null | undefined,
  command: string
): { file: string; args: string[] } {
  const target = shell?.file ? shell : fallbackCommandShell()
  switch (shell?.id) {
    case 'pwsh':
    case 'powershell':
      return {
        file: target.file,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          PS_PREFIX + command
        ]
      }
    case 'cmd':
      return { file: target.file, args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`] }
    case 'gitbash':
      return { file: target.file, args: ['-lc', command] }
    case 'wsl':
      return { file: target.file, args: ['-e', 'sh', '-lc', command] }
    default:
      return process.platform === 'win32'
        ? {
            file: target.file,
            args: [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              PS_PREFIX + command
            ]
          }
        : { file: target.file, args: ['-lc', command] }
  }
}


/**
 * 命令失败后的可执行建议：让模型看到「下一步怎么改」，而不是只看到通用提示后原样重试。
 * 只做文本识别，不改变命令本身。
 */
export function commandFailureHint(stderr: string, stdout: string, shellLabel: string): string {
  const text = `${stderr}\n${stdout}`
  if (/A positional parameter cannot be found|找不到接受实际参数|无法找到接受实际参数/i.test(text)) {
    return 'PowerShell 把参数拆错了：路径含空格时要用引号包住，或去掉多余的引号/续行符。把命令拆短，或改用 read_file/grep/list_dir 等内置工具。'
  }
  if (/ParserError|UnexpectedToken|unexpected token|unexpected EOF|Missing closing|字符串缺少终止符|意外的标记/i.test(text)) {
    return '命令里有语法或引号错误。先用一条最小命令验证，再逐步拼接；复杂脚本请用 write_file 写成 .ps1/.js 后执行，避免多层引号。'
  }
  if (/Cannot find module|MODULE_NOT_FOUND|模块.*未找到/i.test(text)) {
    return '脚本或依赖路径不对。先用 list_dir 确认脚本存在、cwd 正确；Node 脚本用工作区内相对路径（如 node scripts/x.js），缺依赖先安装。'
  }
  if (/is not recognized as the name of a cmdlet|CommandNotFoundException|不是内部或外部命令|command not found/i.test(text)) {
    return `当前终端（${shellLabel}）找不到这个命令。检查命令名与语法是否属于该终端；也可以用内置工具完成同样的事，避免依赖外部程序。`
  }
  if (/running scripts is disabled|禁止运行脚本|ExecutionPolicy/i.test(text)) {
    return 'PowerShell 执行策略阻止了脚本。改用 -Command 直接执行，或直接调用解释器（node/python）。'
  }
  if (/Access is denied|Permission denied|拒绝访问|EBUSY|being used by another process|另一个程序正在使用/i.test(text)) {
    return '文件被占用或权限不足。先关闭占用该文件的程序再重试，并确认路径在工作区内。'
  }
  return '检查命令语法、文件路径是否正确；如果是脚本报错，先读一下错误信息再修改，避免原样重试。'
}


/** 给模型看的命令语法提示；避免用户选 cmd/Git Bash 时仍写 PowerShell。 */
export function shellSyntaxHint(
  shell: { id: string; label?: string; file?: string } | null | undefined
): string {
  switch (shell?.id) {
    case 'cmd':
      return '当前是命令提示符（cmd）：用 dir/type/copy 等 cmd 语法，不要用 PowerShell cmdlet。'
    case 'gitbash':
      return '当前是 Git Bash：用 POSIX/bash 语法（ls/cat/grep/&&），不要用 PowerShell cmdlet。'
    case 'wsl':
      return '当前是 WSL：命令在 Linux 中执行，用 POSIX 语法。'
    default:
      return '当前是 PowerShell：用 PowerShell 语法（Get-ChildItem 等），不要用 bash/cmd 专有语法。'
  }
}
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


export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 该标签最近一次致命错误；错误标签仍保留在标签栏，方便关闭或重试 */
  error: { code: string; message: string } | null
}


export interface BrowserState {
  /** 当前是否已创建浏览器视图（至少有一个标签） */
  open: boolean
  /** 是否可见（面板打开且无致命错误） */
  visible: boolean
  /** 当前活动标签的字段 */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 当前活动标签最近一次致命错误；成功后清空 */
  error: { code: string; message: string } | null
  /** Agent 正在操作这个页面（用于面板上的「Morrow 操作中」提示） */
  automationActive: boolean
  /** 全部标签（按标签栏顺序） */
  tabs: BrowserTabInfo[]
  /** 当前活动标签 id；没有标签时为 null */
  activeTabId: string | null
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
  reload(ctx: BrowserCallContext): Promise<BrowserState>
  scroll(ctx: BrowserCallContext, deltaY: number): Promise<BrowserActionResult>
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
