/**
 * Provider 公共设施：错误归一化、HTTP → 人类可读文案、指数退避重试。
 */
import type { ResultError } from '../../shared/types'
import type { ProviderStreamEvent } from '../types'
import { isAbortError, sleep } from '../util'

export class ProviderError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly status?: number
  readonly providerId?: string

  constructor(
    message: string,
    opts: { code?: string; retryable?: boolean; status?: number; providerId?: string; cause?: unknown } = {}
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = opts.code ?? 'provider_error'
    this.retryable = opts.retryable ?? false
    this.status = opts.status
    this.providerId = opts.providerId
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause
  }

  toResultError(): ResultError {
    return { code: this.code, message: this.message, retryable: this.retryable }
  }
}

export interface RetryPolicy {
  /** 最多重试次数（不含首次请求） */
  maxRetries: number
  /** 每次重试前的等待（毫秒），最后一次不足时复用最后一项 */
  delays: number[]
}

/** 架构约定：0.8s / 2s / 5s，最多 3 次 */
export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, delays: [800, 2000, 5000] }

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

/** 从错误响应体里挖出人类可读的 detail（OpenAI/Anthropic/网关各不相同） */
export function extractErrorDetail(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string } | string
      message?: string
      detail?: string
    }
    if (typeof parsed.error === 'string') return parsed.error
    if (parsed.error?.message) return parsed.error.message
    if (parsed.message) return parsed.message
    if (parsed.detail) return parsed.detail
  } catch {
    // 非 JSON：直接截一段原文
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** HTTP 状态码 → 中文人话（新手用户必须看得懂） */
export function normalizeHttpError(status: number, body: string, providerId?: string): ProviderError {
  const detail = extractErrorDetail(body)
  const suffix = detail ? `：${detail}` : ''
  if (status === 401 || status === 403) {
    return new ProviderError(`API Key 无效或没有访问权限（HTTP ${status}）。请到设置里检查密钥是否填写正确、是否已过期。${suffix}`, {
      code: 'auth',
      retryable: false,
      status,
      providerId
    })
  }
  if (status === 404) {
    return new ProviderError(`接口地址不存在（HTTP 404）。请检查 Base URL 是否填写正确，或模型是否对该账号开放。${suffix}`, {
      code: 'not_found',
      retryable: false,
      status,
      providerId
    })
  }
  if (status === 400 || status === 422) {
    return new ProviderError(`请求被模型服务拒绝（HTTP ${status}）。${suffix || '可能是当前模型不支持工具调用或参数过长。'}`, {
      code: 'bad_request',
      retryable: false,
      status,
      providerId
    })
  }
  if (status === 429) {
    return new ProviderError(`请求太频繁或额度不足（HTTP 429），稍后会自动重试。${suffix}`, {
      code: 'rate_limit',
      retryable: true,
      status,
      providerId
    })
  }
  if (status >= 500) {
    return new ProviderError(`模型服务暂时不可用（HTTP ${status}），稍后会自动重试。${suffix}`, {
      code: 'server_error',
      retryable: true,
      status,
      providerId
    })
  }
  return new ProviderError(`模型服务返回错误（HTTP ${status}）。${suffix}`, {
    code: 'http_error',
    retryable: isRetryableStatus(status),
    status,
    providerId
  })
}

/** 把任意异常归一化成 ProviderError（网络错误标可重试，中断标 aborted） */
export function toProviderError(err: unknown, providerId?: string): ProviderError {
  if (err instanceof ProviderError) return err
  if (isAbortError(err)) {
    return new ProviderError('请求已中断。', { code: 'aborted', retryable: false, providerId, cause: err })
  }
  if (err instanceof TypeError) {
    // Node fetch 的网络错误（DNS/连接失败/证书）都是 TypeError
    return new ProviderError('无法连接到模型服务，请检查网络或接口地址是否正确。', {
      code: 'network',
      retryable: true,
      providerId,
      cause: err
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new ProviderError(`模型请求失败：${message}`, { code: 'provider_error', retryable: false, providerId, cause: err })
}

/** 读取错误响应文本（失败不抛错） */
export async function readTextSafe(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * 流式请求的退避重试包装：
 * - 只有「尚未产出任何内容」时失败才重试，避免重复文本；
 * - 重试前 yield notice，UI 显示「正在重试」而不是直接报错；
 * - signal 中断立即停止，不重试。
 */
export async function* streamWithRetry(
  open: () => AsyncGenerator<ProviderStreamEvent>,
  opts: { policy: RetryPolicy; signal: AbortSignal; providerId?: string }
): AsyncGenerator<ProviderStreamEvent> {
  let attempt = 0
  for (;;) {
    let producedContent = false
    try {
      for await (const event of open()) {
        if (event.type !== 'notice' && event.type !== 'usage') producedContent = true
        yield event
      }
      return
    } catch (err) {
      const error = toProviderError(err, opts.providerId)
      if (opts.signal.aborted || error.code === 'aborted') throw error
      if (producedContent || !error.retryable || attempt >= opts.policy.maxRetries) throw error
      const delay = opts.policy.delays[Math.min(attempt, opts.policy.delays.length - 1)] ?? 800
      attempt += 1
      yield {
        type: 'notice',
        level: 'warn',
        message: `连接波动：${error.message} 正在自动重试（第 ${attempt}/${opts.policy.maxRetries} 次，${Math.round(delay / 1000)} 秒后）…`
      }
      await sleep(delay, opts.signal)
    }
  }
}

/** 拼接 baseUrl 与 API 路径，避免出现重复斜杠 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/** OpenAI 兼容接口地址：支持用户填 https://host、https://host/v1、完整 /chat/completions */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(url)) return url
  if (/\/v1$/.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}

/** Anthropic Messages 接口地址：支持 https://host、https://host/v1、完整 /v1/messages */
export function resolveAnthropicMessagesUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/v1\/messages$/.test(url)) return url
  if (/\/v1$/.test(url)) return `${url}/messages`
  return `${url}/v1/messages`
}
