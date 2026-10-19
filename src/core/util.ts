/**
 * 内核通用小工具：id、休眠、哈希、JSON 容错、文本截断。
 * 不依赖第三方库，保持 core 可脱离桌面独立测试。
 */
import { createHash, randomUUID } from 'node:crypto'

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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

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
