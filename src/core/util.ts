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

/** 安全 JSON 解析：失败返回 null，绝不抛错（模型输出/SSE 帧都可能不完整） */
export function safeJsonParse<T = unknown>(text: string): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** 字符串字面量的转义修复结果 */
interface JsonLiteralRepair {
  text: string
  /** 修好的非法反斜杠转义个数（如 `"C:\交付成品"` 里的 `\交`） */
  escapes: number
  /** 修好的裸控制字符个数（字符串里的真实换行、制表符） */
  controls: number
}

const JSON_ESCAPABLE = '"\\/bfnrt'

/**
 * 修复字符串字面量里最常见的两类非法 JSON。它们都来自「模型把命令或路径当纯文本写」：
 * - 反斜杠只写了一层：`"C:\交付成品"` 在 JSON 里是有问题的转义；
 * - 多行命令里的真实换行/制表符没有写成转义序列。
 * 只改转义、不改字符内容，修出来的参数与模型本意一致；
 * 结构性损坏（截断、引号缺失）不在这里兜底，仍按失败处理，
 * 避免把半条命令当成完整参数执行。
 */
function repairJsonStringLiterals(text: string): JsonLiteralRepair {
  let out = ''
  let escapes = 0
  let controls = 0
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += `\\u${hex}`
          i += 5
          continue
        }
      } else if (next && JSON_ESCAPABLE.includes(next)) {
        out += `\\${next}`
        i += 1
        continue
      }
      // 非法转义（含结尾孤立的反斜杠）：按字面反斜杠处理
      out += '\\\\'
      escapes += 1
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    if (ch.charCodeAt(0) < 0x20) {
      const code = ch.charCodeAt(0)
      out +=
        code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`
      controls += 1
      continue
    }
    out += ch
  }
  return { text: out, escapes, controls }
}

/**
 * 从 start 处的 `{` 起按括号配对截出第一个完整对象（跳过字符串里的括号）。
 * 比「第一个 { 到最后一个 }」可靠：模型一次吐出两段 JSON 时，后者会横跨两个对象。
 * 找不到配对（被截断）时返回 null。
 */
function sliceBalancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 工具参数解析失败的具体原因：既要说明错在哪，也要带上模型自己写坏的那一段 */
export interface ToolArgsIssue {
  /** 面向模型的失败原因（同时用于工具卡上的错误文案） */
  error: string
  /** 失败位置附近的原始片段，回灌给模型让它看到问题，而不是盲猜重试 */
  sample?: string
}

export interface ToolArgsParseResult {
  input: Record<string, unknown> | null
  issue?: ToolArgsIssue
}

function parseObjectStrict(text: string): Record<string, unknown> | null {
  const parsed = safeJsonParse<unknown>(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

/** JSON.parse 的报错文本（不抛错）；空字符串表示这段文本本身能解析 */
function jsonErrorOf(text: string): string {
  try {
    JSON.parse(text)
    return ''
  } catch (err) {
    return errorMessage(err)
  }
}

/** 取失败位置前后各一小段：整条命令可能上千字符，全塞回模型只会挤占上下文 */
function sampleAround(text: string, at: number): string | undefined {
  const flat = text.replace(/\s+/g, ' ')
  if (!flat) return undefined
  if (at < 0) return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
  const from = Math.max(0, at - 60)
  const to = Math.min(flat.length, at + 60)
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}

const TRUNCATED_ERROR = /Unexpected end|Unterminated|end of JSON input/i
const BAD_ESCAPE_ERROR = /Bad escaped character/i
const BAD_CONTROL_ERROR = /Bad control character/i
const TRAILING_ERROR = /Unexpected non-whitespace character/i
const STRUCTURE_ERROR = /Expected ','|Expected property name|Expected ':'|Expected double-quoted|Unexpected token/i

function diagnoseToolArgs(text: string, message: string): ToolArgsIssue {
  const atMatch = /position (\d+)/.exec(message)
  const sample = sampleAround(text, atMatch ? Number(atMatch[1]) : -1)
  const build = (error: string): ToolArgsIssue => (sample ? { error, sample } : { error })
  if (TRUNCATED_ERROR.test(message)) {
    return build('参数 JSON 在结尾被截断（缺少结尾的引号、括号或花括号），通常是单次输出太长')
  }
  if (BAD_CONTROL_ERROR.test(message)) {
    return build('参数 JSON 的字符串里有真实换行或制表符，必须写成转义序列，不能直接换行')
  }
  if (BAD_ESCAPE_ERROR.test(message)) {
    return build('参数 JSON 里有不合法的反斜杠转义（Windows 路径只写了一个反斜杠，或命令里的 \\|、\\K 这类正则转义），每个反斜杠都要写成两个')
  }
  if (TRAILING_ERROR.test(message)) {
    return build('同一次输出里带了多段 JSON 或 JSON 之外的文字，只能输出一个参数对象')
  }
  if (STRUCTURE_ERROR.test(message)) {
    return build('参数 JSON 结构不完整（引号、逗号或括号没有配对）')
  }
  return build(`参数不是合法的 JSON 对象（${message || '无法解析'}）`)
}

/**
 * 带诊断的工具参数解析。除直接解析外，还会尝试这些不改变语义的修复：
 * 1) 去掉 markdown 代码围栏与 JSON 前后的解释文字；
 * 2) 取第一个括号配对完整的对象（兼容一次吐出两段 JSON）；
 * 3) 去掉尾逗号；
 * 4) 补字符串里的反斜杠转义、转义裸换行/制表符。
 * 仍失败时给出具体原因和出错位置附近的片段，供上层回灌给模型自修复。
 */
export function parseToolArgsDetailed(raw: string): ToolArgsParseResult {
  // 无参数的调用（如 todo_write 之外的零参数工具）上游给的是空串，按「没有参数」处理
  if (!raw || !raw.trim()) return { input: {} }
  const trimmed = raw.trim()
  const candidates: string[] = []
  const push = (value: string | null | undefined): void => {
    const text = value?.trim()
    if (text && !candidates.includes(text)) candidates.push(text)
  }
  push(trimmed)
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  push(fence?.[1])
  const start = trimmed.indexOf('{')
  const shape = start >= 0 ? sliceBalancedObject(trimmed, start) : null
  push(shape)
  if (start >= 0) {
    const end = trimmed.lastIndexOf('}')
    if (end > start) push(trimmed.slice(start, end + 1))
    // 被截断的尾巴：拿不到配对，但保留它作为候选项，让报错落在真正的位置上
    push(trimmed.slice(start))
  }

  const attempts: string[] = []
  for (const candidate of candidates) {
    const literal = repairJsonStringLiterals(candidate)
    const noComma = candidate.replace(/,\s*([}\]])/g, '$1')
    attempts.push(candidate, noComma, literal.text, literal.text.replace(/,\s*([}\]])/g, '$1'))
  }
  for (const attempt of attempts) {
    const parsed = parseObjectStrict(attempt)
    if (parsed) return { input: parsed }
  }
  // 诊断用「形状最规整」的候选：它最接近模型想表达的那个对象
  return { input: null, issue: diagnoseToolArgs(shape ?? trimmed, jsonErrorOf(shape ?? trimmed)) }
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
 * 安全策略常量也放在这里（纯数据），main 与 renderer/tests 共用同一口径：
 * - 所有外部动作必须经权限审批（权限层接线见 docs/ARCHITECTURE.md#安全边界）。
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

const PAGE_KEY_MAP: Record<string, string> = {
  ENTER: 'Enter',
  RETURN: 'Enter',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  TAB: 'Tab',
  SPACE: 'Space',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12'
}

/** 页面内按键白名单：只允许 Ctrl/Shift 组合，避免把系统级 Alt/F4 等带进网页。 */
export function parseBrowserKeys(raw: string): { keys: string[]; modifiers: Array<'control' | 'shift'> } | string {
  const value = String(raw ?? '').trim().toUpperCase()
  if (!value) return '按键不能为空。'
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 3) return '按键格式不合法（示例：Enter、CTRL+A、SHIFT+TAB）。'
  const modifiers: Array<'control' | 'shift'> = []
  const keys: string[] = []
  for (const part of parts) {
    if (part === 'CTRL' || part === 'CONTROL') {
      modifiers.push('control')
      continue
    }
    if (part === 'SHIFT') {
      modifiers.push('shift')
      continue
    }
    if (part === 'ALT' || part === 'META' || part === 'WIN' || part === 'CMD') {
      return `不允许 ${part} 组合键：页面自动化只支持 Ctrl/Shift。`
    }
    if (keys.length > 0) return '一次只能按一个普通键（修饰键除外）。'
    const mapped = PAGE_KEY_MAP[part]
    if (mapped) {
      keys.push(mapped)
      continue
    }
    if (/^[A-Z0-9]$/.test(part)) {
      keys.push(part)
      continue
    }
    if (/^(ARROWUP|ARROWDOWN|ARROWLEFT|ARROWRIGHT)$/.test(part)) {
      keys.push(part.replace('ARROW', 'Arrow'))
      continue
    }
    return `不允许的按键「${part}」。支持 Enter/Esc/Tab/Space/Backspace/Delete/方向键/Home/End/PageUp/PageDown/F1–F12/字母/数字。`
  }
  if (keys.length === 0) return '需要包含一个普通键（例如 CTRL+A）。'
  return { keys, modifiers }
}

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

/** Agent 在内置浏览器里的实时操作记录（渲染层 HUD + 对话轨迹共用）。 */
export interface BrowserActivityEntry {
  id: string
  tool: string
  title: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  detail?: string
}

export interface BrowserActivityState {
  active: boolean
  startedAt: number | null
  actions: number
  entries: BrowserActivityEntry[]
}

export interface BrowserSnapshotElement {
  /** 页面内稳定引用（e1、e2…），可直接传给 browser_click / browser_type */
  ref: string
  role: string
  name: string
  kind: 'interactive' | 'heading'
  tag: string
  x: number
  y: number
  width: number
  height: number
  value?: string
  placeholder?: string
  disabled?: boolean
  checked?: boolean
}

export interface BrowserSnapshotResult {
  url: string
  title: string
  text: string
  elements: BrowserSnapshotElement[]
  activeElement?: string
  scroll: { x: number; y: number; width: number; height: number }
  truncated: boolean
}

export interface BrowserConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error' | 'unknown'
  text: string
  source?: string
  line?: number
  at: number
}

export interface BrowserNetworkEntry {
  method: string
  url: string
  status?: number
  resourceType?: string
  fromCache?: boolean
  error?: string
  at: number
}

export interface BrowserWaitResult {
  ok: boolean
  waitedMs: number
  url: string
  title: string
  matched?: string
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
  /** Agent 本轮在浏览器里的操作轨迹；旧测试夹具可省略 */
  activity?: BrowserActivityState
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
  /** 页面结构快照：给模型一份带 ref 的可交互元素清单 */
  snapshot(ctx: BrowserCallContext & { maxElements?: number }): Promise<BrowserSnapshotResult>
  /** 向页面发送按键（不是系统级键盘） */
  press(keys: string, ctx: BrowserCallContext): Promise<BrowserActionResult>
  /** 等待选择器/文本/加载完成 */
  waitFor(
    input: { kind: 'selector' | 'text' | 'load' | 'idle'; value?: string; timeoutMs?: number },
    ctx: BrowserCallContext
  ): Promise<BrowserWaitResult>
  /** 当前页面的控制台消息（环形缓冲） */
  console(ctx: BrowserCallContext & { limit?: number; level?: 'error' | 'warning' | 'all' }): Promise<BrowserConsoleEntry[]>
  /** 当前页面的网络请求（环形缓冲） */
  network(ctx: BrowserCallContext & { limit?: number; failedOnly?: boolean; contains?: string }): Promise<BrowserNetworkEntry[]>
  /** 列出全部标签与当前活动标签 */
  tabs(ctx: BrowserCallContext): Promise<BrowserState>
  /** 新建标签并打开网址（http/https） */
  newTab(url: string, ctx: BrowserCallContext): Promise<BrowserState>
  /** 激活指定标签 */
  activateTab(id: string, ctx: BrowserCallContext): Promise<BrowserState>
  /** 关闭指定标签 */
  closeTab(id: string, ctx: BrowserCallContext): Promise<BrowserState>
  /** 把工具的开始/结束写入可见操作轨迹（不参与权限判断） */
  activity?(input: {
    tool: string
    title: string
    phase: 'start' | 'end'
    runId: string
    ok?: boolean
    detail?: string
  }): void
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

