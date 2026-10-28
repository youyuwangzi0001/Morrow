// Provider 实现与协议适配：由 core/providers/* 扁平合并，一个文件承载全部供应商逻辑。
import type { ResultError, ChatMessage, ProviderConfig, Usage, ProviderTestResult } from '../shared/types'
import type { ProviderStreamEvent, Provider, ProviderStreamRequest, ToolDefinition, ConnectionTestOptions } from './types'
import { isAbortError, sleep, parseToolArgs, newId } from './util'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { ToolProtocolStreamFilter, parseTextToolCalls } from '../shared/types'
import { isLocalServiceUrl } from '../shared/contracts'
import { withUnlimitedTokenBudget } from './agent'



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


/**
 * 读取错误响应文本（失败不抛错）。
 * 限制读取字节数：有些网关出错时返回整页 HTML/日志，全部读进内存只会拖慢报错。
 */
export async function readTextSafe(response: Response, maxBytes = 64 * 1024): Promise<string> {
  const body = response.body
  if (!body) {
    try {
      return (await response.text()).slice(0, maxBytes)
    } catch {
      return ''
    }
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let text = ''
  let bytes = 0
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const previous = bytes
      bytes += value.byteLength
      if (bytes > maxBytes) {
        text += decoder.decode(value.subarray(0, maxBytes - previous), { stream: true })
        break
      }
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // 读取失败：返回已经读到的部分
  }
  try {
    await reader.cancel()
  } catch {
    // 流已关闭
  }
  text += decoder.decode()
  return text
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
// SSE（text/event-stream）增量解析。

export interface SSEFrame {
  event: string | null
  data: string
  id?: string
  retry?: number
}


export class SSEParser {
  /** 尚未按行结束符切开的残余文本（可能以孤立的 \r 结尾，等待下一块确认 CRLF） */
  private buffer = ''
  private dataLines: string[] = []
  private event: string | null = null
  private id: string | undefined
  private retry: number | undefined
  private hasField = false

  /** 输入任意切片，返回本切片内已经完整的帧（不完整的留在内部 buffer） */
  push(chunk: string): SSEFrame[] {
    this.buffer += chunk
    const frames: SSEFrame[] = []
    let index = 0
    while (index < this.buffer.length) {
      const lf = this.buffer.indexOf('\n', index)
      const cr = this.buffer.indexOf('\r', index)
      let lineEnd: number
      let nextIndex: number
      if (cr >= 0 && (lf < 0 || cr < lf)) {
        // 块尾的孤立 \r 可能是 CRLF 的前半，留到下一块再判断
        if (cr === this.buffer.length - 1) break
        lineEnd = cr
        nextIndex = this.buffer[cr + 1] === '\n' ? cr + 2 : cr + 1
      } else if (lf >= 0) {
        lineEnd = lf
        nextIndex = lf + 1
      } else {
        break
      }
      const frame = this.consumeLine(this.buffer.slice(index, lineEnd))
      if (frame) frames.push(frame)
      index = nextIndex
    }
    this.buffer = this.buffer.slice(index)
    return frames
  }

  /** 流结束时调用：收下没有行结束符/空行的最后一帧（服务端也可能不发末尾空行） */
  flush(): SSEFrame[] {
    const rest = this.buffer
    this.buffer = ''
    const frames: SSEFrame[] = []
    if (rest) {
      // 句尾孤立的 \r 是已结束的行；其余残余文本也按最后一行解析
      const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
      if (line) {
        const frame = this.consumeLine(line)
        if (frame) frames.push(frame)
      }
    }
    const tail = this.dispatch()
    if (tail) frames.push(tail)
    return frames
  }

  private consumeLine(line: string): SSEFrame | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null // 注释/心跳（": ping"）
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.hasField = true
    switch (field) {
      case 'data':
        this.dataLines.push(value)
        break
      case 'event':
        this.event = value || null
        break
      case 'id':
        this.id = value
        break
      case 'retry': {
        const n = Number(value)
        if (Number.isFinite(n)) this.retry = n
        break
      }
      default:
        // 未知字段按规范忽略
        break
    }
    return null
  }

  /** 空行派发：只有收到过 data 字段的帧才算事件（规范如此，纯 event/id 行不派发） */
  private dispatch(): SSEFrame | null {
    const hasData = this.dataLines.length > 0
    const frame: SSEFrame = {
      event: this.event,
      data: this.dataLines.join('\n'),
      ...(this.id !== undefined ? { id: this.id } : {}),
      ...(this.retry !== undefined ? { retry: this.retry } : {})
    }
    const shouldEmit = hasData && this.hasField
    this.dataLines = []
    this.event = null
    this.id = undefined
    this.retry = undefined
    this.hasField = false
    return shouldEmit ? frame : null
  }
}


export const STREAM_IDLE_TIMEOUT_MS = 180_000


/**
 * 把 fetch 的 body 流转成 SSE 帧。
 * 注意：调用方负责判断 `data: [DONE]`。
 * 超过 idleTimeoutMs 没有任何数据（含心跳）就报错，避免连接半开导致整轮永久卡住。
 */
export async function* iterateSSE(
  stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS
): AsyncGenerator<SSEFrame> {
  const parser = new SSEParser()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const iterator = (stream as AsyncIterable<string | Uint8Array>)[Symbol.asyncIterator]()
  let timer: NodeJS.Timeout | null = null
  let timedOut = false
  const arm = (): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`模型流式响应超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有数据，已中断。`))
      }, idleTimeoutMs)
    })
  try {
    while (true) {
      if (timer) clearTimeout(timer)
      timer = null
      const next = await Promise.race([iterator.next(), arm()])
      if (next.done) break
      if (timer) clearTimeout(timer)
      timer = null
      const chunk = next.value
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      for (const frame of parser.push(text)) yield frame
    }
    const tail = decoder.decode()
    if (tail) for (const frame of parser.push(tail)) yield frame
    for (const frame of parser.flush()) yield frame
  } finally {
    if (timer) clearTimeout(timer)
    // 不等待 return：底层读取可能同样卡死，等它会把超时又变成永久挂起
    if (timedOut) void Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}


/**
 * 逐帧 JSON 解析（跳过注释/心跳/空 data/[DONE]）。
 * onDone：收到 `[DONE]` 哨兵时回调，供 Provider 区分「正常收尾」与「中途断流」。
 */
export async function* iterateSSEData(
  stream: ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array>,
  onDone?: () => void
): AsyncGenerator<unknown> {
  for await (const frame of iterateSSE(stream)) {
    const data = frame.data.trim()
    if (!data) continue
    if (data === '[DONE]') {
      onDone?.()
      continue
    }
    try {
      yield JSON.parse(data) as unknown
    } catch {
      // 单帧 JSON 坏掉不应让整个流死亡：跳过由上层通过「没有内容」感知
    }
  }
}


function cleanFailureText(text: string, max = 2000): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s+/.test(line) && !/node:internal|processTicksAndRejections/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}


/** 工具结果回给模型：失败时保留可行动信息，去掉栈帧与内部实现噪音。 */
export function toolResultTextForModel(
  block: Extract<ChatMessage['content'][number], { type: 'tool_use' }>
): string {
  if (!block.result) return '[该工具调用没有返回结果]'
  if (block.result.ok) return block.result.output || '(命令执行成功，没有输出)'
  const error = cleanFailureText(block.result.error ?? block.result.output ?? '未知错误', 1200) || '未知错误'
  const output = cleanFailureText(block.result.output ?? '', 1200)
  const parts = [`[工具执行失败] ${error}`]
  if (block.result.hint?.trim()) parts.push(`提示：${block.result.hint.trim()}`)
  if (output && output !== error) parts.push(`输出：${output}`)
  parts.push('下一步：先按提示检查参数、路径或权限再重试；同一错误再次出现时换一种做法，必要时用 ask_user 询问用户。')
  return parts.join('\n')
}


export const ANTHROPIC_VERSION = '2023-06-01'


export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }


export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}


function textOf(message: ChatMessage): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}


/**
 * 内部 ChatMessage[] → Anthropic {system, messages}。
 * Anthropic 要求：首条消息必须是 user；user/assistant 交替；tool_result 必须紧跟 tool_use。
 * 历史被裁剪后可能不满足，这里统一做「合并同类 + 补首条 user」的规范化。
 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  system: string
): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  if (system.trim()) systemParts.push(system.trim())
  const out: AnthropicMessage[] = []
  const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const message of messages) {
    const text = textOf(message)
    if (message.role === 'system') {
      if (text.trim()) systemParts.push(text.trim())
      continue
    }
    if (message.role === 'user') {
      const blocks: AnthropicBlock[] = []
      if (text) blocks.push({ type: 'text', text })
      // Anthropic 多模态：base64 image block
      for (const image of message.images ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 }
        })
      }
      if (blocks.length > 0) pushBlocks('user', blocks)
      continue
    }
    const assistantBlocks: AnthropicBlock[] = []
    if (text) assistantBlocks.push({ type: 'text', text })
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        assistantBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} })
      }
    }
    pushBlocks('assistant', assistantBlocks)
    const toolResults: AnthropicBlock[] = []
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolResultTextForModel(block),
          is_error: block.result?.ok === false
        })
      }
    }
    pushBlocks('user', toolResults)
  }
  if (out.length === 0) {
    out.push({ role: 'user', content: [{ type: 'text', text: '（对话开始）' }] })
  } else if (out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '（对话继续）' }] })
  }
  return { system: systemParts.filter(Boolean).join('\n\n'), messages: out }
}


export function buildAnthropicRequestBody(
  req: ProviderStreamRequest,
  model: string
): Record<string, unknown> {
  const converted = toAnthropicMessages(req.messages, req.system)
  const body: Record<string, unknown> = {
    model,
    messages: converted.messages,
    max_tokens: typeof req.maxTokens === 'number' && req.maxTokens > 0 ? req.maxTokens : 8192,
    stream: true
  }
  if (converted.system) body.system = converted.system
  if (req.tools.length > 0) body.tools = req.tools.map(toAnthropicTool)
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (req.reasoning?.style === 'thinking' && req.reasoning.effort !== 'off') {
    const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 } as const
    const budget = budgets[req.reasoning.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max'] ?? 4096
    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 8192
    body.max_tokens = Math.max(maxTokens, budget + 1024)
    // Anthropic 扩展思考要求 temperature 为 1
    body.temperature = 1
    body.thinking = { type: 'enabled', budget_tokens: budget }
  }
  return body
}


export function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}


function mapAnthropicUsage(usage: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} | null | undefined): Usage {
  const cacheRead = usage?.cache_read_input_tokens ?? 0
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0
  // Anthropic 的 input_tokens 不含缓存读写；统一成「总输入 + 其中缓存读」口径，
  // 与 OpenAI 的 prompt_tokens 对齐，费用估算和上下文占用才不会偏低。
  return {
    inputTokens: (usage?.input_tokens ?? 0) + cacheRead + cacheCreate,
    outputTokens: usage?.output_tokens ?? 0,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {})
  }
}


interface AnthropicStreamPayload {
  type?: string
  index?: number
  message?: { usage?: Parameters<typeof mapAnthropicUsage>[0] }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: Parameters<typeof mapAnthropicUsage>[0]
  error?: { type?: string; message?: string }
}


export interface AnthropicProviderOptions {
  retryDelays?: number[]
  fetchImpl?: typeof fetch
}


export class AnthropicProvider implements Provider {
  readonly id: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly model: string
  private readonly retryDelays: number[]
  private readonly fetchImpl: typeof fetch

  constructor(config: ProviderConfig, apiKey: string | null, modelId?: string, options: AnthropicProviderOptions = {}) {
    this.id = config.id
    this.url = resolveAnthropicMessagesUrl(config.baseUrl)
    this.model = modelId || config.models[0]?.id || 'unknown'
    this.retryDelays = options.retryDelays ?? DEFAULT_RETRY.delays
    this.fetchImpl = options.fetchImpl ?? fetch
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(config.headers ?? {})
    }
  }

  stream(req: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent> {
    const policy: RetryPolicy = { maxRetries: DEFAULT_RETRY.maxRetries, delays: this.retryDelays }
    return streamWithRetry(() => this.attempt(req), {
      policy,
      signal: req.signal,
      providerId: this.id
    })
  }

  private async *attempt(req: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(buildAnthropicRequestBody(req, this.model)),
        signal: req.signal
      })
    } catch (err) {
      throw toProviderError(err, this.id)
    }
    if (!response.ok) {
      const body = await readTextSafe(response)
      throw normalizeHttpError(response.status, body, this.id)
    }
    if (!response.body) {
      throw new ProviderError('模型服务返回了空响应。', { code: 'empty_response', retryable: true, providerId: this.id })
    }

    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let completed = false
    let hasOutput = false
    let finalizedToolCalls = 0
    let hadParseError = false
    let stopReason: string | null = null

    interface BlockState {
      kind: 'text' | 'thinking' | 'tool_use'
      toolId?: string
      toolName?: string
      json: string
      ended: boolean
    }
    const blocks = new Map<number, BlockState>()

    streamLoop: for await (const payload of iterateSSEData(response.body)) {
      const event = payload as AnthropicStreamPayload
      switch (event.type) {
        case 'message_start': {
          const usage = mapAnthropicUsage(event.message?.usage)
          inputTokens = usage.inputTokens
          cacheReadTokens = usage.cacheReadTokens ?? 0
          yield { type: 'usage', usage: { ...usage, outputTokens: 0 } }
          break
        }
        case 'content_block_start': {
          const index = event.index ?? 0
          const block = event.content_block
          if (block?.type === 'tool_use') {
            const state: BlockState = {
              kind: 'tool_use',
              toolId: block.id ?? '',
              toolName: block.name ?? '',
              json: '',
              ended: false
            }
            blocks.set(index, state)
            if (state.toolId && state.toolName) {
              hasOutput = true
              yield { type: 'tool_call_start', index, id: state.toolId, name: state.toolName }
            }
          } else {
            blocks.set(index, {
              kind: block?.type === 'thinking' ? 'thinking' : 'text',
              json: '',
              ended: false
            })
          }
          break
        }
        case 'content_block_delta': {
          const index = event.index ?? 0
          const state = blocks.get(index)
          const delta = event.delta
          if (!delta) break
          if (delta.type === 'text_delta' && delta.text) {
            hasOutput = true
            yield { type: 'text_delta', text: delta.text }
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            hasOutput = true
            yield { type: 'thinking_delta', text: delta.thinking }
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            if (state) state.json += delta.partial_json
            hasOutput = true
            yield { type: 'tool_call_delta', index, argsDelta: delta.partial_json }
          }
          break
        }
        case 'content_block_stop': {
          const index = event.index ?? 0
          const state = blocks.get(index)
          if (!state || state.ended) break
          state.ended = true
          if (state.kind === 'tool_use' && state.toolId && state.toolName) {
            finalizedToolCalls += 1
            const input = parseToolArgs(state.json)
            if (!input) {
              hadParseError = true
              const parseError = '模型输出的工具参数不是合法 JSON（可能因为内容过长被截断）'
              yield { type: 'notice', level: 'warn', message: `${parseError}（工具：${state.toolName}），将改为分步重试。` }
              yield { type: 'tool_call_end', index, id: state.toolId, name: state.toolName, input: {}, parseError }
              break
            }
            yield { type: 'tool_call_end', index, id: state.toolId, name: state.toolName, input }
          }
          break
        }
        case 'message_delta': {
          const usage = event.usage
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
          if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens
          yield {
            type: 'usage',
            usage: {
              inputTokens,
              outputTokens,
              ...(cacheReadTokens ? { cacheReadTokens } : {})
            }
          }
          break
        }
        case 'error': {
          const type = event.error?.type ?? 'api_error'
          const retryable = type === 'overloaded_error' || type === 'api_error' || type === 'rate_limit_error'
          throw new ProviderError(`Anthropic 返回错误：${event.error?.message ?? type}`, {
            code: type,
            retryable,
            providerId: this.id
          })
        }
        case 'message_stop':
          completed = true
          break streamLoop
        default:
          // ping / 未知事件：忽略
          break
      }
    }

    // 防御：服务端未发 message_stop 就断流时，把已开始的工具块收尾
    for (const [index, state] of blocks) {
      if (!state.ended && state.kind === 'tool_use' && state.toolId && state.toolName) {
        state.ended = true
        hasOutput = true
        finalizedToolCalls += 1
        const input = parseToolArgs(state.json)
        if (!input) {
          hadParseError = true
          yield {
            type: 'tool_call_end',
            index,
            id: state.toolId,
            name: state.toolName,
            input: {},
            parseError: '模型输出的工具参数不是合法 JSON（可能因为内容过长被截断）'
          }
          continue
        }
        yield { type: 'tool_call_end', index, id: state.toolId, name: state.toolName, input }
      }
    }
    yield {
      type: 'usage',
      usage: { inputTokens, outputTokens, ...(cacheReadTokens ? { cacheReadTokens } : {}) }
    }
    if (stopReason === 'max_tokens' && !hadParseError) {
      yield {
        type: 'notice',
        level: 'warn',
        message: '模型回复达到单次输出长度上限，内容可能被截断；可以回复「继续」让模型接着写。'
      }
    } else if (stopReason === 'refusal') {
      yield {
        type: 'notice',
        level: 'warn',
        message: '模型输出被服务商的内容安全策略拦截，部分内容可能没有返回。'
      }
    }
    if (!completed) {
      if (!hasOutput && finalizedToolCalls === 0) {
        throw new ProviderError('模型服务返回了空响应。', {
          code: 'empty_response',
          retryable: true,
          providerId: this.id
        })
      }
      // 有工具调用时保留已解析的调用交给 Agent 自修复；纯文本则明确报错，避免把半截回答当完整答案。
      if (finalizedToolCalls === 0) {
        throw new ProviderError('模型服务在回复完成前断开了连接，输出可能不完整。', {
          code: 'incomplete_stream',
          retryable: false,
          providerId: this.id
        })
      }
    }
  }
}


interface OpenAIDelta {
  /** 少数网关在多模态流里返回 content 数组 */
  content?: string | Array<{ type?: string; text?: string }> | null
  reasoning_content?: string | null
  reasoning?: string | null
  /** 旧版 OpenAI function calling（部分网关仍在使用） */
  function_call?: { name?: string; arguments?: string | Record<string, unknown> } | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string | Record<string, unknown> }
  }>
}


interface OpenAIStreamChunk {
  choices?: Array<{ index?: number; delta?: OpenAIDelta; finish_reason?: string | null }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; type?: string } | string
}


export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }


export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | OpenAIContentPart[]
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}


/**
 * 内部 ChatMessage[]（tool_result 内嵌在 tool_use.result）→ OpenAI messages。
 * 关键：assistant.tool_calls 后必须紧跟对应的 role:'tool' 消息，否则 API 拒绝。
 */
export function toOpenAIMessages(messages: ChatMessage[], system: string): OpenAIChatMessage[] {
  const systemParts: string[] = []
  if (system.trim()) systemParts.push(system.trim())
  const out: OpenAIChatMessage[] = []
  for (const message of messages) {
    const text = textOf(message)
    if (message.role === 'system') {
      if (text.trim()) systemParts.push(text.trim())
      continue
    }
    if (message.role === 'user') {
      const images = message.images ?? []
      if (images.length > 0) {
        // OpenAI 兼容多模态：content 数组里放 text + image_url(data URL)
        const parts: OpenAIContentPart[] = []
        if (text) parts.push({ type: 'text', text })
        for (const image of images) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` }
          })
        }
        out.push({ role: 'user', content: parts })
      } else if (text) {
        out.push({ role: 'user', content: text })
      }
      continue
    }
    const toolUses = message.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
    if (toolUses.length === 0) {
      if (text) out.push({ role: 'assistant', content: text })
      continue
    }
    out.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolUses.map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      }))
    })
    for (const block of toolUses) out.push({ role: 'tool', tool_call_id: block.id, content: toolResultTextForModel(block) })
  }
  // 空的 system 消息会被部分网关判为非法 content，没有系统提示时直接省略
  const systemText = systemParts.join('\n\n')
  return systemText ? [{ role: 'system', content: systemText }, ...out] : out
}


export function buildOpenAIRequestBody(
  req: ProviderStreamRequest,
  model: string,
  providerId?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req.messages, req.system),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (req.tools.length > 0) {
    body.tools = req.tools.map(toOpenAITool)
    body.tool_choice = 'auto'
  }
  if (typeof req.maxTokens === 'number' && req.maxTokens > 0) body.max_tokens = req.maxTokens
  if (typeof req.temperature === 'number') body.temperature = req.temperature
  if (req.reasoning?.style === 'effort') {
    // DeepSeek 官方档位是 none/low/high/max；Morrow 统一用 off 表示关闭。
    // Qoder 代理仍按自己的 off 档位处理，不能在这里改成 none。
    body.reasoning_effort =
      req.reasoning.effort === 'off' && providerId === 'deepseek' && /deepseek/i.test(model)
        ? 'none'
        : req.reasoning.effort
  }
  return body
}


export function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}


function mapUsage(usage: NonNullable<OpenAIStreamChunk['usage']>): Usage {
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    ...(typeof cached === 'number' && cached > 0 ? { cacheReadTokens: cached } : {})
  }
}


export interface OpenAICompatProviderOptions {
  /** 测试用：自定义退避（毫秒数组） */
  retryDelays?: number[]
  /** 测试用：注入 fetch */
  fetchImpl?: typeof fetch
}


interface ToolAccumulator {
  index: number
  id: string
  name: string
  args: string
  started: boolean
}


function contentText(content: OpenAIDelta['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('')
  return ''
}


function argsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}


export class OpenAICompatProvider implements Provider {
  readonly id: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly model: string
  private readonly retryDelays: number[]
  private readonly fetchImpl: typeof fetch

  constructor(config: ProviderConfig, apiKey: string | null, modelId?: string, options: OpenAICompatProviderOptions = {}) {
    this.id = config.id
    this.url = resolveChatCompletionsUrl(config.baseUrl)
    this.model = modelId || config.models[0]?.id || 'unknown'
    this.retryDelays = options.retryDelays ?? DEFAULT_RETRY.delays
    this.fetchImpl = options.fetchImpl ?? fetch
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(config.headers ?? {})
    }
  }

  stream(req: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent> {
    const policy: RetryPolicy = { maxRetries: DEFAULT_RETRY.maxRetries, delays: this.retryDelays }
    return streamWithRetry(() => this.attempt(req), {
      policy,
      signal: req.signal,
      providerId: this.id
    })
  }

  private async *attempt(req: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          ...this.headers,
          ...(req.contextWindow ? { 'x-morrow-context-window': String(req.contextWindow) } : {})
        },
        body: JSON.stringify(buildOpenAIRequestBody(req, this.model, this.id)),
        signal: req.signal
      })
    } catch (err) {
      throw toProviderError(err, this.id)
    }
    if (!response.ok) {
      const body = await readTextSafe(response)
      throw normalizeHttpError(response.status, body, this.id)
    }
    if (!response.body) {
      throw new ProviderError('模型服务返回了空响应。', { code: 'empty_response', retryable: true, providerId: this.id })
    }

    const toolAcc = new Map<number, ToolAccumulator>()
    let finishReason: string | null = null
    let completed = false
    let hasOutput = false
    let finalizedToolCalls = 0
    let hadParseError = false
    // 少数网关不返回 tool_call.index：沿用最近一次的索引，避免每个分片都变成幽灵调用
    let currentIndex = 0
    // 旧版 function_call 只有一个调用，用 -1 与 tool_calls 区分
    let legacyFunction: ToolAccumulator | null = null

    for await (const payload of iterateSSEData(response.body, () => {
      completed = true
    })) {
      const chunk = payload as OpenAIStreamChunk
      // 个别网关会在 200 响应里塞 error 帧
      if (chunk.error) {
        const errorType = typeof chunk.error === 'string' ? '' : (chunk.error.type ?? '')
        const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message
        const retryable = /rate.?limit|overload|server_error|timeout|unavailable|temporar/i.test(
          `${errorType} ${message ?? ''}`
        )
        throw new ProviderError(`模型服务返回错误：${message ?? '未知错误'}`, {
          code: errorType || 'provider_error',
          retryable,
          providerId: this.id
        })
      }
      if (chunk.usage) yield { type: 'usage', usage: mapUsage(chunk.usage) }
      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason
        completed = true
      }
      const delta = choice?.delta
      if (!delta) continue
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        hasOutput = true
        yield { type: 'thinking_delta', text: reasoning }
      }
      const textDelta = contentText(delta.content)
      if (textDelta) {
        hasOutput = true
        yield { type: 'text_delta', text: textDelta }
      }
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === 'number' ? call.index : currentIndex
        currentIndex = index
        let acc = toolAcc.get(index)
        if (!acc) {
          acc = { index, id: '', name: '', args: '', started: false }
          toolAcc.set(index, acc)
        }
        if (call.id && !acc.id) acc.id = call.id
        if (call.function?.name && !acc.name) acc.name = call.function.name
        const argsDelta = argsText(call.function?.arguments)
        if (argsDelta) acc.args += argsDelta
        if (!acc.started && acc.name) {
          acc.started = true
          acc.id = acc.id || newId('call')
          hasOutput = true
          yield { type: 'tool_call_start', index, id: acc.id, name: acc.name }
          if (acc.args) yield { type: 'tool_call_delta', index, argsDelta: acc.args }
        } else if (acc.started && argsDelta) {
          hasOutput = true
          yield { type: 'tool_call_delta', index, argsDelta }
        }
      }
      if (delta.function_call) {
        if (!legacyFunction) legacyFunction = { index: -1, id: '', name: '', args: '', started: false }
        const name = delta.function_call.name
        if (name && !legacyFunction.name) legacyFunction.name = name
        const argsDelta = argsText(delta.function_call.arguments)
        if (argsDelta) legacyFunction.args += argsDelta
        if (!legacyFunction.started && legacyFunction.name) {
          legacyFunction.started = true
          legacyFunction.id = legacyFunction.id || newId('call')
          hasOutput = true
          yield { type: 'tool_call_start', index: -1, id: legacyFunction.id, name: legacyFunction.name }
          if (legacyFunction.args) {
            yield { type: 'tool_call_delta', index: -1, argsDelta: legacyFunction.args }
          }
        } else if (legacyFunction.started && argsDelta) {
          hasOutput = true
          yield { type: 'tool_call_delta', index: -1, argsDelta }
        }
      }
    }

    // 流结束：补发 tool_call_end（含容错解析的参数）
    const accumulators = [...toolAcc.values()]
    if (legacyFunction?.name) accumulators.push(legacyFunction)

    for (const acc of accumulators.sort((a, b) => a.index - b.index)) {
      if (!acc.name) continue
      finalizedToolCalls += 1
      if (!acc.started) {
        acc.started = true
        acc.id = acc.id || newId('call')
        hasOutput = true
        yield { type: 'tool_call_start', index: acc.index, id: acc.id, name: acc.name }
        if (acc.args) yield { type: 'tool_call_delta', index: acc.index, argsDelta: acc.args }
      }
      const input = parseToolArgs(acc.args)
      if (!input) {
        // 参数 JSON 不完整通常是输出触达 max_tokens 被截断：不要杀死整轮，
        // 交给 Agent 生成「可自修复」的工具错误，模型随后可以拆小内容重试。
        hadParseError = true
        const parseError =
          finishReason === 'length'
            ? '模型输出达到长度上限（finish_reason=length），工具参数被截断，不是完整 JSON'
            : '模型输出的工具参数不是合法 JSON'
        yield { type: 'notice', level: 'warn', message: `${parseError}（工具：${acc.name}），将改为分步重试。` }
        yield { type: 'tool_call_end', index: acc.index, id: acc.id, name: acc.name, input: {}, parseError }
        continue
      }
      yield { type: 'tool_call_end', index: acc.index, id: acc.id, name: acc.name, input }
    }

    // 文本被输出上限截断/被安全策略拦截时，至少给用户一个可见提示（工具参数截断已有专门提示）
    if (finishReason === 'length' && !hadParseError) {
      yield {
        type: 'notice',
        level: 'warn',
        message: '模型回复达到单次输出长度上限，内容可能被截断；可以回复「继续」让模型接着写。'
      }
    } else if (finishReason === 'content_filter') {
      yield {
        type: 'notice',
        level: 'warn',
        message: '模型输出被服务商的内容安全策略拦截，部分内容可能没有返回。'
      }
    }

    // 没有任何内容且没有收尾标记：空流。抛可重试错误，让 streamWithRetry 重连，
    // 而不是在 UI 里显示成「模型没有返回内容」的正常回复。
    if (!completed) {
      if (!hasOutput && finalizedToolCalls === 0) {
        throw new ProviderError('模型服务返回了空响应。', {
          code: 'empty_response',
          retryable: true,
          providerId: this.id
        })
      }
      // 已经有文本但既没有 finish_reason 也没有 [DONE]：连接在中途断开。
      // 有工具调用时保留已解析的调用交给 Agent 自修复；纯文本则明确报错，避免把半截回答当完整答案。
      if (finalizedToolCalls === 0) {
        throw new ProviderError('模型服务在回复完成前断开了连接，输出可能不完整。', {
          code: 'incomplete_stream',
          retryable: false,
          providerId: this.id
        })
      }
    }
  }
}


interface SalesRow {
  line: number
  date: string
  orderId: string
  channel: string
  customer: string
  city: string
  category: string
  price: number
  quantity: number
  discount: number
  amount: number
}


export interface DemoAnomaly {
  orderId: string
  line: number
  reason: string
  detail: string
}


export interface DemoMetrics {
  rawRows: number
  uniqueOrderIds: number
  validOrders: number
  duplicateExtra: number
  refundCount: number
  totalRevenue: number
  avgOrderValue: number
  q2Revenue: number
  q2ReportedTotal: number
  q2Gap: number
  qoqGrowth: number
  monthly: Array<{ label: string; revenue: number; orders: number }>
  channels: Array<{ name: string; revenue: number; orders: number }>
  cities: Array<{ name: string; revenue: number }>
  categories: Array<{ name: string; revenue: number }>
  anomalies: DemoAnomaly[]
  customerConflict: { customer: string; salesCity: string; listCity: string } | null
  files: {
    sales: string
    customers: string
    readme: string
    q2: string
    notes: string
  }
  source: 'workspace' | 'fallback'
}


interface DemoStep {
  caption: string
  thinking?: string
  text?: string
  tools?: Array<{ name: string; input: Record<string, unknown> }>
}


export interface DemoProviderOptions {
  /** 播放速度倍率：0 = 不等待（测试），1 = 正常演示 */
  speed?: number
}


function demoEnvSpeed(): number {
  const raw = process.env.MORROW_DEMO_SPEED
  if (!raw) return 1
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : 1
}


function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out
}


function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = clean.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map((header) => header.trim())
  const rows: Array<Record<string, string>> = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i])
    if (cells.every((cell) => !cell.trim())) continue
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim()
    })
    rows.push(record)
  }
  return rows
}


function num(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value.replace(/[,\s¥￥]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}


function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}


function toPosix(path: string): string {
  return path.split(sep).join('/')
}


function listFiles(root: string, depth = 3, prefix = ''): string[] {
  const out: string[] = []
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', '.morrow'].includes(entry.name)) continue
      if (depth > 1) out.push(...listFiles(join(root, entry.name), depth - 1, rel))
      continue
    }
    if (entry.isFile()) out.push(rel)
  }
  return out
}


function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}


function isSalesHeader(rows: Array<Record<string, string>>): boolean {
  if (rows.length === 0) return false
  const headers = Object.keys(rows[0])
  const has = (keyword: string): boolean => headers.some((header) => header.includes(keyword))
  return has('订单号') && has('金额') && has('日期')
}


function isCustomerHeader(rows: Array<Record<string, string>>): boolean {
  if (rows.length === 0) return false
  const headers = Object.keys(rows[0])
  return headers.some((header) => header.includes('客户')) && headers.some((header) => header.includes('城市'))
}


function findField(row: Record<string, string>, keywords: string[]): string {
  for (const key of Object.keys(row)) {
    if (keywords.some((keyword) => key.includes(keyword))) return row[key] ?? ''
  }
  return ''
}


function fallbackMetrics(): DemoMetrics {
  return {
    rawRows: 103,
    uniqueOrderIds: 102,
    validOrders: 101,
    duplicateExtra: 1,
    refundCount: 1,
    totalRevenue: 171627.85,
    avgOrderValue: 1699.29,
    q2Revenue: 144900,
    q2ReportedTotal: 145760,
    q2Gap: 860,
    qoqGrowth: 18.44,
    monthly: [
      { label: '7 月', revenue: 43421.35, orders: 32 },
      { label: '8 月', revenue: 61105.65, orders: 35 },
      { label: '9 月', revenue: 67100.85, orders: 34 }
    ],
    channels: [
      { name: '京东自营', revenue: 61381.95, orders: 12 },
      { name: '微信小程序', revenue: 43666.9, orders: 21 },
      { name: '抖音直播', revenue: 39724.6, orders: 42 },
      { name: '天猫旗舰店', revenue: 19022.5, orders: 15 },
      { name: '小红书商城', revenue: 6568.9, orders: 8 },
      { name: '线下门店', revenue: 1263, orders: 3 }
    ],
    cities: [
      { name: '广州', revenue: 47964.7 },
      { name: '上海', revenue: 22750.65 },
      { name: '苏州', revenue: 21194.45 }
    ],
    categories: [
      { name: '企业礼盒', revenue: 93712 },
      { name: '咖啡器具', revenue: 22668.55 },
      { name: '茶具', revenue: 22615.4 },
      { name: '家居香氛', revenue: 22442.45 },
      { name: '文具', revenue: 10189.45 }
    ],
    anomalies: [
      { orderId: 'ORD-2026Q3-0054', line: 0, reason: '折扣异常', detail: '折扣率 85%，远高于正常水平' },
      { orderId: 'ORD-2026Q3-0098', line: 0, reason: '退款/负数量单', detail: '数量 -1、金额负数，按口径剔除' },
      { orderId: 'ORD-2026Q3-0031', line: 0, reason: '订单号重复', detail: '同一订单在导出中出现 2 次，按口径只算一次' },
      { orderId: 'ORD-2026Q3-0003', line: 0, reason: '金额勾稽不符', detail: '金额与「单价 × 数量 × (1 − 折扣)」相差 1,888 元' }
    ],
    customerConflict: { customer: '上海星野广告', salesCity: '上海', listCity: '杭州' },
    files: {
      sales: '销售明细-2026Q3.csv',
      customers: '客户名单.csv',
      readme: 'README-待整理.md',
      q2: '旧文件/2026Q2-销售汇总.csv',
      notes: '旧文件/客户回访记录-2026-06.txt'
    },
    source: 'fallback'
  }
}


/** 从演示工作区读取真实数据并计算报告所需指标（文件缺失时退回基准数据） */
export function collectDemoMetrics(workspace: string | null): DemoMetrics {
  const fallback = fallbackMetrics()
  if (!workspace || !existsSync(workspace)) return fallback
  const files = listFiles(workspace, 3)
  const pick = (predicate: (rel: string, text: string) => boolean): string | null => {
    for (const rel of files) {
      if (!rel.toLowerCase().endsWith('.csv')) continue
      const text = readTextFile(join(workspace, rel))
      if (predicate(rel, text)) return rel
    }
    return null
  }
  const salesRel =
    pick((rel, text) => isSalesHeader(parseCsv(text).slice(0, 1))) ??
    files.find((rel) => rel.includes('销售明细')) ??
    null
  if (!salesRel) return fallback
  const salesText = readTextFile(join(workspace, salesRel))
  const rawRowsList = parseCsv(salesText)
  if (rawRowsList.length < 5) return fallback

  const sales: SalesRow[] = rawRowsList.map((row, index) => ({
    line: index + 2, // 1 行表头
    date: findField(row, ['日期', 'date']),
    orderId: findField(row, ['订单号', 'order']),
    channel: findField(row, ['渠道', 'channel']),
    customer: findField(row, ['客户', 'customer']),
    city: findField(row, ['城市', 'city', '地区', 'region']),
    category: findField(row, ['品类', '产品线', 'category']),
    price: num(findField(row, ['单价', 'price'])),
    quantity: num(findField(row, ['数量', 'qty', 'quantity'])),
    discount: num(findField(row, ['折扣', 'discount'])),
    amount: num(findField(row, ['金额', 'amount', 'revenue']))
  }))

  const uniqueIds = new Set(sales.map((row) => row.orderId))
  const countByOrder = new Map<string, number>()
  for (const row of sales) countByOrder.set(row.orderId, (countByOrder.get(row.orderId) ?? 0) + 1)
  const duplicateExtra = [...countByOrder.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)

  const refundRows = sales.filter((row) => row.amount < 0 || row.quantity < 0)
  const clean: SalesRow[] = []
  const seen = new Set<string>()
  for (const row of sales) {
    if (row.amount < 0 || row.quantity <= 0) continue
    if (seen.has(row.orderId)) continue
    seen.add(row.orderId)
    clean.push(row)
  }

  const totalRevenue = round2(clean.reduce((sum, row) => sum + row.amount, 0))
  const validOrders = clean.length
  const avgOrderValue = validOrders > 0 ? round2(totalRevenue / validOrders) : 0

  const monthMap = new Map<string, { revenue: number; orders: number }>()
  for (const row of clean) {
    const month = row.date.slice(0, 7)
    if (!month) continue
    const entry = monthMap.get(month) ?? { revenue: 0, orders: 0 }
    entry.revenue += row.amount
    entry.orders += 1
    monthMap.set(month, entry)
  }
  const monthly = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, value]) => ({ label: `${Number(month.slice(5, 7))} 月`, revenue: round2(value.revenue), orders: value.orders }))

  const groupSum = (key: (row: SalesRow) => string, withOrders: boolean): Array<{ name: string; revenue: number; orders: number }> => {
    const map = new Map<string, { revenue: number; orders: number }>()
    for (const row of clean) {
      const name = key(row) || '（未填写）'
      const entry = map.get(name) ?? { revenue: 0, orders: 0 }
      entry.revenue += row.amount
      entry.orders += 1
      map.set(name, entry)
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, revenue: round2(value.revenue), orders: withOrders ? value.orders : 0 }))
      .sort((a, b) => b.revenue - a.revenue)
  }
  const channels = groupSum((row) => row.channel, true)
  const cities = groupSum((row) => row.city, false).map((item) => ({ name: item.name, revenue: item.revenue }))
  const categories = groupSum((row) => row.category, false).map((item) => ({ name: item.name, revenue: item.revenue }))

  // Q2 汇总：分渠道加总 vs 表内合计行
  let q2Revenue = fallback.q2Revenue
  let q2ReportedTotal = fallback.q2ReportedTotal
  const q2Rel =
    files.find((rel) => /2026Q2|2026-Q2/i.test(rel) && rel.toLowerCase().endsWith('.csv')) ??
    files.find((rel) => rel.includes('旧文件') && rel.toLowerCase().endsWith('.csv') && !rel.includes('销售明细')) ??
    null
  if (q2Rel) {
    const q2Rows = parseCsv(readTextFile(join(workspace, q2Rel)))
    if (q2Rows.length > 0) {
      let detailSum = 0
      let totalRowValue: number | null = null
      for (const row of q2Rows) {
        const month = findField(row, ['月份', 'month'])
        const amount = num(findField(row, ['销售额', 'amount', '金额']))
        if (month.includes('合计') || month.includes('总计')) {
          totalRowValue = amount
          continue
        }
        detailSum += amount
      }
      if (detailSum > 0) q2Revenue = round2(detailSum)
      if (totalRowValue !== null) q2ReportedTotal = round2(totalRowValue)
    }
  }
  const q2Gap = round2(q2ReportedTotal - q2Revenue)
  const qoqGrowth = q2Revenue > 0 ? round2(((totalRevenue - q2Revenue) / q2Revenue) * 100) : 0

  // 异常：折扣、退款、重复、勾稽
  const anomalies: DemoAnomaly[] = []
  for (const row of sales) {
    if (row.discount > 0.6) {
      anomalies.push({
        orderId: row.orderId,
        line: row.line,
        reason: '折扣异常',
        detail: `折扣率 ${(row.discount * 100).toFixed(0)}%，远高于正常水平（正常 ≤ 30%）`
      })
    }
  }
  for (const row of refundRows) {
    anomalies.push({
      orderId: row.orderId,
      line: row.line,
      reason: '退款/负数量单',
      detail: `数量 ${row.quantity}、金额 ¥${fmtMoney(row.amount)}，按口径在汇总时剔除`
    })
  }
  for (const [orderId, count] of countByOrder) {
    if (count > 1) {
      const row = sales.find((item) => item.orderId === orderId)
      anomalies.push({
        orderId,
        line: row?.line ?? 0,
        reason: '订单号重复',
        detail: `同一订单在导出中出现 ${count} 次，按口径只算一次（多计 ${count - 1} 行）`
      })
    }
  }
  for (const row of sales) {
    const expected = round2(row.price * row.quantity * (1 - row.discount))
    if (Math.abs(round2(row.amount) - expected) > 1) {
      anomalies.push({
        orderId: row.orderId,
        line: row.line,
        reason: '金额勾稽不符',
        detail: `金额 ¥${fmtMoney(row.amount)}，按「单价 × 数量 × (1 − 折扣)」应为 ¥${fmtMoney(expected)}，差 ¥${fmtMoney(row.amount - expected)}`
      })
    }
  }

  // 客户名单城市矛盾
  let customerConflict: DemoMetrics['customerConflict'] = null
  const customersRel = files.find((rel) => {
    if (!rel.toLowerCase().endsWith('.csv') || rel === salesRel) return false
    return isCustomerHeader(parseCsv(readTextFile(join(workspace, rel))).slice(0, 1))
  })
  if (customersRel) {
    const customerRows = parseCsv(readTextFile(join(workspace, customersRel)))
    const listCity = new Map<string, string>()
    for (const row of customerRows) {
      const name = findField(row, ['客户', 'customer'])
      const city = findField(row, ['城市', 'city'])
      if (name && city) listCity.set(name, city)
    }
    for (const row of clean) {
      const listed = listCity.get(row.customer)
      if (listed && row.city && listed !== row.city) {
        customerConflict = { customer: row.customer, salesCity: row.city, listCity: listed }
        break
      }
    }
  }

  const pickRel = (keywords: string[], extensions: string[]): string | null =>
    files.find((rel) => {
      const lower = rel.toLowerCase()
      return keywords.some((keyword) => lower.includes(keyword.toLowerCase())) && extensions.some((ext) => lower.endsWith(ext))
    }) ?? null

  return {
    rawRows: sales.length,
    uniqueOrderIds: uniqueIds.size,
    validOrders,
    duplicateExtra,
    refundCount: refundRows.length,
    totalRevenue,
    avgOrderValue,
    q2Revenue,
    q2ReportedTotal,
    q2Gap,
    qoqGrowth,
    monthly,
    channels,
    cities,
    categories,
    anomalies,
    customerConflict,
    files: {
      sales: toPosix(salesRel),
      customers: customersRel ? toPosix(customersRel) : fallback.files.customers,
      readme: pickRel(['readme', '说明'], ['.md', '.txt']) ? toPosix(pickRel(['readme', '说明'], ['.md', '.txt']) as string) : fallback.files.readme,
      q2: q2Rel ? toPosix(q2Rel) : fallback.files.q2,
      notes: pickRel(['回访'], ['.txt']) ? toPosix(pickRel(['回访'], ['.txt']) as string) : fallback.files.notes
    },
    source: 'workspace'
  }
}


/** 千分位金额（不带 ¥） */
export function fmtMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}


function fmtPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}


function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}


function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}


function buildAggregateCommand(files: DemoMetrics['files']): string {
  const sales = psQuote(files.sales)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = Import-Csv -Path ${sales} -Encoding UTF8`,
    `$clean = @($rows | Where-Object { [double]$_.'数量' -gt 0 -and [double]$_.'金额' -ge 0 } | Sort-Object '订单号' -Unique)`,
    `$refunds = @($rows | Where-Object { [double]$_.'金额' -lt 0 -or [double]$_.'数量' -lt 0 })`,
    `$total = ($clean | ForEach-Object { [double]$_.'金额' } | Measure-Object -Sum).Sum`,
    `$avg = [math]::Round($total / $clean.Count, 2)`,
    `"原始数据行: $($rows.Count)"`,
    `"有效订单数: $($clean.Count)"`,
    `"退款/负数量行: $($refunds.Count)"`,
    `"总销售额: $([math]::Round($total, 2))"`,
    `"客单价: $avg"`,
    `"渠道表现:"`,
    `$channels = $clean | Group-Object '渠道' | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Orders = $_.Count; Sum = (($_.Group | ForEach-Object { [double]$_.'金额' }) | Measure-Object -Sum).Sum } } | Sort-Object Sum -Descending`,
    `foreach ($c in $channels) { "{0} | 订单 {1} 笔 | 销售额 {2}" -f $c.Name, $c.Orders, [math]::Round($c.Sum, 2) }`
  ].join('\n')
}


function buildAnomalyCommand(files: DemoMetrics['files']): string {
  const sales = psQuote(files.sales)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = Import-Csv -Path ${sales} -Encoding UTF8`,
    `"【1】折扣异常（> 60%）"`,
    `foreach ($r in $rows | Where-Object { [double]$_.'折扣' -gt 0.6 }) { "{0} | 折扣 {1} | 金额 {2}" -f $r.'订单号', $r.'折扣', $r.'金额' }`,
    `"【2】退款 / 负数量"`,
    `foreach ($r in $rows | Where-Object { [double]$_.'金额' -lt 0 -or [double]$_.'数量' -lt 0 }) { "{0} | 数量 {1} | 金额 {2}" -f $r.'订单号', $r.'数量', $r.'金额' }`,
    `"【3】重复订单号"`,
    `foreach ($g in $rows | Group-Object '订单号' | Where-Object { $_.Count -gt 1 }) { "{0} 出现 {1} 次" -f $g.Name, $g.Count }`,
    `"【4】金额与 单价×数量×(1-折扣) 不一致"`,
    `foreach ($r in $rows) { $expect = [double]$r.'单价' * [double]$r.'数量' * (1 - [double]$r.'折扣'); if ([math]::Abs([double]$r.'金额' - $expect) -gt 1) { "{0} | 金额 {1} | 应为 {2}" -f $r.'订单号', $r.'金额', [math]::Round($expect, 2) } }`
  ].join('\n')
}


function buildQ2Command(files: DemoMetrics['files']): string {
  const q2 = psQuote(files.q2)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = Import-Csv -Path ${q2} -Encoding UTF8`,
    `$detail = @($rows | Where-Object { $_.'月份' -ne '合计' })`,
    `$totalRow = @($rows | Where-Object { $_.'月份' -eq '合计' })`,
    `$sum = ($detail | ForEach-Object { [double]$_.'销售额' } | Measure-Object -Sum).Sum`,
    `"Q2 明细行: $($detail.Count)"`,
    `"分渠道加总: $([math]::Round($sum, 2))"`,
    `"表内合计行: $($totalRow[0].'销售额')"`,
    `"差额: $([math]::Round([double]$totalRow[0].'销售额' - $sum, 2))"`
  ].join('\n')
}


function svgBars(
  items: Array<{ label: string; value: number; note?: string }>,
  opts: { gradientId: string; labelWidth?: number; valueWidth?: number }
): string {
  const width = 660
  const labelWidth = opts.labelWidth ?? 96
  const valueWidth = opts.valueWidth ?? 208
  const chartWidth = width - labelWidth - valueWidth
  const rowHeight = 34
  const top = 8
  const height = top * 2 + items.length * rowHeight
  const max = Math.max(...items.map((item) => item.value), 1)
  const rows = items
    .map((item, index) => {
      const y = top + index * rowHeight
      const barWidth = Math.max(4, Math.round((item.value / max) * chartWidth))
      const opacity = (0.62 + 0.38 * (1 - index / Math.max(1, items.length - 1))).toFixed(2)
      const note = item.note ? ` <tspan fill="#8f887e">${esc(item.note)}</tspan>` : ''
      return [
        `<text x="${labelWidth - 12}" y="${y + 16}" text-anchor="end" fill="#d9d2c5" font-size="13">${esc(item.label)}</text>`,
        `<rect x="${labelWidth}" y="${y + 4}" width="${chartWidth}" height="18" rx="4" fill="rgba(255,255,255,0.05)"/>`,
        `<rect x="${labelWidth}" y="${y + 4}" width="${barWidth}" height="18" rx="4" fill="url(#${opts.gradientId})" opacity="${opacity}"/>`,
        `<text x="${labelWidth + barWidth + 10}" y="${y + 17}" fill="#e2c894" font-size="12" font-family="ui-monospace, Consolas, monospace">¥${fmtMoney(item.value)}${note}</text>`
      ].join('')
    })
    .join('\n')
  return [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><linearGradient id="${opts.gradientId}" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0%" stop-color="#8a6f3d"/><stop offset="100%" stop-color="#e6cf9f"/>`,
    `</linearGradient></defs>`,
    rows,
    `</svg>`
  ].join('\n')
}


function anomalyCards(metrics: DemoMetrics): string {
  return metrics.anomalies
    .map((anomaly) => {
      const order = anomaly.orderId ? `<span class="order">${esc(anomaly.orderId)}</span>` : ''
      return `<li class="anomaly"><span class="tag">${esc(anomaly.reason)}</span>${order}<span class="detail">${esc(anomaly.detail)}</span></li>`
    })
    .join('\n')
}


function rankRows(items: Array<{ name: string; revenue: number }>, total: number): string {
  return items
    .slice(0, 5)
    .map((item, index) => {
      const share = total > 0 ? (item.revenue / total) * 100 : 0
      return `<tr><td class="rank">${String(index + 1).padStart(2, '0')}</td><td class="name">${esc(item.name)}</td><td class="num">¥${fmtMoney(item.revenue)}</td><td class="share"><span style="width:${Math.max(2, Math.round(share))}%"></span></td><td class="pct">${share.toFixed(1)}%</td></tr>`
    })
    .join('\n')
}


/** 生成自包含 HTML 报告（无外链、内联 CSS/SVG，可直接在 iframe 预览/发给老板） */
export function renderDemoReportHtml(metrics: DemoMetrics, generatedAt: Date): string {
  const total = metrics.totalRevenue
  const topChannel = metrics.channels[0] ?? { name: '—', revenue: 0, orders: 0 }
  const topCategory = metrics.categories[0] ?? { name: '—', revenue: 0 }
  const topCity = metrics.cities[0] ?? { name: '—', revenue: 0 }
  const mostOrders = [...metrics.channels].sort((a, b) => b.orders - a.orders)[0] ?? { name: '—', orders: 0 }
  const channelShare = total > 0 ? (topChannel.revenue / total) * 100 : 0
  const categoryShare = total > 0 ? (topCategory.revenue / total) * 100 : 0
  const monthlyBars = svgBars(
    metrics.monthly.map((month) => ({ label: month.label, value: month.revenue, note: `· ${month.orders} 单` })),
    { gradientId: 'goldMonth' }
  )
  const channelBars = svgBars(
    metrics.channels.map((channel) => ({ label: channel.name, value: channel.revenue, note: `· ${channel.orders} 单` })),
    { gradientId: 'goldChannel', labelWidth: 112 }
  )
  const conflict = metrics.customerConflict
  const generated = generatedAt.toLocaleString('zh-CN', { hour12: false })

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Q3 销售复盘 · 2026</title>
<style>
  :root {
    --bg: #0b0d10;
    --panel: #14171c;
    --panel-2: #1a1e24;
    --line: rgba(201, 168, 106, 0.22);
    --text: #e9e4da;
    --muted: #948d82;
    --gold: #c9a86a;
    --gold-strong: #e6cf9f;
    --good: #8fc4a8;
    --bad: #e29a86;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 15px;
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 1000px; margin: 0 auto; padding: 64px 56px 72px; }
  .eyebrow {
    font-size: 11px; letter-spacing: 0.34em; color: var(--gold);
    text-transform: uppercase; margin-bottom: 18px;
  }
  h1 {
    font-family: Georgia, "Times New Roman", "Songti SC", "SimSun", serif;
    font-size: 52px; line-height: 1.12; font-weight: 500;
    margin: 0 0 18px; letter-spacing: 0.01em;
  }
  h1 em { font-style: normal; color: var(--gold-strong); }
  .lead { color: var(--muted); max-width: 720px; margin: 0 0 8px; }
  .meta-line { color: #6f6a61; font-size: 12px; letter-spacing: 0.04em; }
  .rule { height: 1px; background: linear-gradient(90deg, var(--line), transparent 92%); margin: 40px 0; }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .kpi {
    background: linear-gradient(160deg, var(--panel-2), var(--panel));
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px; padding: 22px 20px 18px;
  }
  .kpi .label { color: var(--muted); font-size: 12px; letter-spacing: 0.06em; }
  .kpi .value {
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-size: 34px; line-height: 1.2; margin-top: 10px; color: var(--gold-strong);
  }
  .kpi .value small { font-size: 16px; color: var(--muted); margin-right: 2px; }
  .kpi .note { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .delta-up { color: var(--good); }
  section { margin-top: 52px; }
  h2 {
    font-family: Georgia, "Times New Roman", "Songti SC", serif;
    font-size: 26px; font-weight: 500; margin: 0 0 6px;
  }
  h2 .num { color: var(--gold); font-size: 14px; margin-right: 12px; letter-spacing: 0.12em; }
  .sub { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .panel {
    background: linear-gradient(165deg, rgba(26, 30, 36, 0.9), rgba(18, 21, 26, 0.9));
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 16px; padding: 26px 24px;
  }
  .insight { color: var(--muted); font-size: 13px; margin-top: 14px; }
  .insight strong { color: var(--gold-strong); font-weight: 600; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  table.rank-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .rank-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 0 8px 10px 0; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 11px; letter-spacing: 0.08em; }
  .rank-table td { padding: 10px 8px 10px 0; border-bottom: 1px solid rgba(255,255,255,0.045); vertical-align: middle; }
  .rank-table .rank { color: #5f5a52; font-family: ui-monospace, Consolas, monospace; }
  .rank-table .name { color: var(--text); }
  .rank-table .num { color: var(--gold-strong); font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
  .rank-table .share { width: 34%; }
  .rank-table .share span { display: block; height: 7px; border-radius: 4px; background: linear-gradient(90deg, #8a6f3d, #e6cf9f); }
  .rank-table .pct { color: var(--muted); font-family: ui-monospace, Consolas, monospace; text-align: right; white-space: nowrap; }
  ul.anomalies { list-style: none; margin: 0; padding: 0; }
  li.anomaly {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px;
    padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 13px;
  }
  li.anomaly:last-child { border-bottom: none; }
  li.anomaly .tag {
    color: var(--bg); background: var(--gold); border-radius: 999px;
    padding: 1px 10px; font-size: 11px; letter-spacing: 0.04em; flex: none;
  }
  li.anomaly .order { color: var(--gold-strong); font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  li.anomaly .detail { color: var(--muted); flex: 1 1 240px; }
  .callout {
    border-left: 2px solid var(--gold); padding: 14px 18px;
    background: rgba(201, 168, 106, 0.06); border-radius: 0 10px 10px 0;
    color: #cfc8bc; font-size: 13px;
  }
  .callout b { color: var(--gold-strong); }
  .suggestions { counter-reset: sug; list-style: none; margin: 0; padding: 0; }
  .suggestions li {
    counter-increment: sug; position: relative; padding: 14px 0 14px 44px;
    border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px;
  }
  .suggestions li:last-child { border-bottom: none; }
  .suggestions li::before {
    content: counter(sug, decimal-leading-zero);
    position: absolute; left: 0; top: 14px; color: var(--gold);
    font-family: Georgia, serif; font-size: 18px;
  }
  .suggestions b { color: var(--gold-strong); font-weight: 600; }
  footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid rgba(255,255,255,0.06); color: #5f5a52; font-size: 11px; letter-spacing: 0.05em; }
  @media (max-width: 820px) {
    .page { padding: 40px 24px 48px; }
    h1 { font-size: 36px; }
    .kpis { grid-template-columns: 1fr 1fr; }
    .grid-2 { grid-template-columns: 1fr; }
  }
  @media print {
    body { background: #fff; color: #1b1b1b; }
    .page { padding: 24px; max-width: none; }
    .panel, .kpi { background: #f7f5f0; border-color: #ddd6c8; }
    h1 em, .kpi .value, .rank-table .num, .rank-table .pct, li.anomaly .order { color: #8a6f3d; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="eyebrow">Morrow · 2026 Q3 Review</div>
  <h1>Q3 销售复盘<em>，比上季度更好一点</em></h1>
  <p class="lead">这份报告由 Morrow 在本地读取销售明细后真实计算生成：先剔除退款、按订单号去重，再按「金额」列汇总。所有数字都可以在原始 CSV 里复核。</p>
  <p class="meta-line">数据来源：${esc(metrics.files.sales)} · 生成时间：${esc(generated)}</p>

  <div class="rule"></div>

  <div class="kpis">
    <div class="kpi">
      <div class="label">Q3 总销售额</div>
      <div class="value"><small>¥</small>${fmtMoney(total)}</div>
      <div class="note">按干净口径汇总</div>
    </div>
    <div class="kpi">
      <div class="label">有效订单</div>
      <div class="value">${metrics.validOrders}<small> 笔</small></div>
      <div class="note">原始 ${metrics.rawRows} 行 · 去重 ${metrics.duplicateExtra} 行 · 剔除退款 ${metrics.refundCount} 笔</div>
    </div>
    <div class="kpi">
      <div class="label">客单价</div>
      <div class="value"><small>¥</small>${fmtMoney(metrics.avgOrderValue)}</div>
      <div class="note">销售额 ÷ 有效订单数</div>
    </div>
    <div class="kpi">
      <div class="label">环比 Q2</div>
      <div class="value delta-up">${fmtPct(metrics.qoqGrowth)}</div>
      <div class="note">Q2 ${fmtMoney(metrics.q2Revenue)} → Q3 ${fmtMoney(total)}</div>
    </div>
  </div>

  <section>
    <h2><span class="num">01</span>三个月都在往上走</h2>
    <p class="sub">按月份拆分的销售额与订单数（干净口径）</p>
    <div class="panel">
      ${monthlyBars}
      <p class="insight">7 月到 9 月连续增长，9 月单月销售额 <strong>¥${fmtMoney(metrics.monthly[metrics.monthly.length - 1]?.revenue ?? 0)}</strong>，是季度内最高点。</p>
    </div>
  </section>

  <section>
    <h2><span class="num">02</span>京东自营扛住了大盘</h2>
    <p class="sub">渠道销售额排名（Top 6）</p>
    <div class="panel">
      ${channelBars}
      <p class="insight">京东自营贡献了 <strong>${channelShare.toFixed(1)}%</strong> 的销售额；但订单数最多的是 <strong>${esc(mostOrders.name)}（${mostOrders.orders} 笔）</strong>——一个走客单价，一个走流量，投放策略值得分开看。</p>
    </div>
  </section>

  <section>
    <h2><span class="num">03</span>城市与品类</h2>
    <p class="sub">销售额 Top 5（城市 / 品类）</p>
    <div class="grid-2">
      <div class="panel">
        <table class="rank-table">
          <thead><tr><th>#</th><th>城市</th><th>销售额</th><th>占比</th><th></th></tr></thead>
          <tbody>${rankRows(metrics.cities, total)}</tbody>
        </table>
      </div>
      <div class="panel">
        <table class="rank-table">
          <thead><tr><th>#</th><th>品类</th><th>销售额</th><th>占比</th><th></th></tr></thead>
          <tbody>${rankRows(metrics.categories, total)}</tbody>
        </table>
      </div>
    </div>
    <p class="insight">头部城市是 <strong>${esc(topCity.name)}</strong>；品类里 <strong>${esc(topCategory.name)}</strong> 一家占了 <strong>${categoryShare.toFixed(1)}%</strong>，主要来自企业礼盒的 B2B 订单，复购和备货要提前锁。</p>
  </section>

  <section>
    <h2><span class="num">04</span>数据里发现的问题</h2>
    <p class="sub">共 ${metrics.anomalies.length} 处，建议先修数据再做下一步决策</p>
    <div class="panel">
      <ul class="anomalies">
        ${anomalyCards(metrics)}
      </ul>
      <div class="callout" style="margin-top:18px">
        另外，Q2 汇总表的分渠道加总是 <b>¥${fmtMoney(metrics.q2Revenue)}</b>，但表内「合计」行写的是 <b>¥${fmtMoney(metrics.q2ReportedTotal)}</b>，差了 <b>¥${fmtMoney(Math.abs(metrics.q2Gap))}</b>，应该是当时手抄错了。本报告的环比用分渠道加总值计算。
      </div>
      ${
        conflict
          ? `<div class="callout" style="margin-top:12px">客户名单里「<b>${esc(conflict.customer)}</b>」的城市和销售表对不上：销售表是 <b>${esc(conflict.salesCity)}</b>，名单写的是 <b>${esc(conflict.listCity)}</b>。发给老板前建议确认一下。</div>`
          : ''
      }
    </div>
  </section>

  <section>
    <h2><span class="num">05</span>下一步建议</h2>
    <p class="sub">按优先级排序</p>
    <div class="panel">
      <ol class="suggestions">
        <li><b>先修那 ${metrics.anomalies.length} 处异常数据</b>：尤其是金额勾稽不符和重复导出的订单，不修掉下次复盘还会对不上。</li>
        <li><b>按渠道分策略</b>：京东自营和企业礼盒贡献了主要销售额，${esc(mostOrders.name)} 带来最多订单但客单价低，两个渠道的投放和选品要分开定。</li>
        <li><b>整理「旧文件」</b>：修正 Q2 汇总的合计错误、归档客户回访记录，并确认${conflict ? esc(conflict.customer) : '客户名单'}的城市口径。</li>
      </ol>
    </div>
  </section>

  <footer>
    Morrow · 明日工坊 · 本报告由本地数据生成，未上传任何文件 · ${esc(generated)}
  </footer>
</div>
</body>
</html>
`
}


function buildDemoScript(workspace: string | null, now: Date): DemoStep[] {
  const m = collectDemoMetrics(workspace)
  const anomalyCount = m.anomalies.length
  const topChannel = m.channels[0] ?? { name: '京东自营', revenue: 0, orders: 0 }
  const topCategory = m.categories[0] ?? { name: '企业礼盒', revenue: 0 }
  const mostOrders = [...m.channels].sort((a, b) => b.orders - a.orders)[0] ?? { name: '抖音直播', orders: 0 }
  const channelShare = m.totalRevenue > 0 ? (topChannel.revenue / m.totalRevenue) * 100 : 0
  const report = renderDemoReportHtml(m, now)

  return [
    {
      caption: '扫描工作区',
      thinking: '先摸清工作区结构，别一上来就写报告。',
      text:
        '我先看看这个文件夹里有什么。\n\n' +
        '不急着下结论——先弄清楚数据在哪、口径是什么，再把数字算准。',
      tools: [{ name: 'list_dir', input: { path: '.', depth: 2 } }]
    },
    {
      caption: '列出计划',
      thinking: '目标是给老板一份能直接发的复盘，拆成五步最稳。',
      text:
        '目录已经清楚了：一份 Q3 销售明细、一份客户名单、一份待整理的说明，还有一个 `旧文件` 文件夹。\n\n' +
        '老板要的复盘我拆成五步，先列个计划，边做边更新：',
      tools: [
        {
          name: 'todo_write',
          input: {
            todos: [
              { text: '读取销售明细，确认数据口径', status: 'in_progress' },
              { text: '用命令做真实聚合，核对总额与客单价', status: 'pending' },
              { text: '排查异常订单与 Q2 汇总勾稽', status: 'pending' },
              { text: '生成自包含 HTML 复盘报告', status: 'pending' },
              { text: '打开画布并给出下一步建议', status: 'pending' }
            ]
          }
        }
      ]
    },
    {
      caption: '读取销售明细与说明',
      thinking: '先看表头和说明里的口径，再决定怎么算。',
      text:
        '先读销售明细的前几行，再翻一下那份说明——口径都写在里面，比我自己猜靠谱。',
      tools: [
        { name: 'read_file', input: { path: m.files.sales, limit: 6 } },
        { name: 'read_file', input: { path: m.files.readme } }
      ]
    },
    {
      caption: '用命令做真实聚合',
      thinking: '数字不能靠猜，直接用 PowerShell 把 CSV 聚合一遍。',
      text:
        '说明里写得很清楚：**退款要剔除、重复订单号只算一次、客单价 = 销售额 ÷ 有效订单数**。\n\n' +
        '我直接用 PowerShell 对 CSV 做一次真实聚合，不猜数字：',
      tools: [
        { name: 'run_command', input: { command: buildAggregateCommand(m.files), timeout_ms: 60000 } },
        {
          name: 'todo_write',
          input: {
            todos: [
              { text: '读取销售明细，确认数据口径', status: 'completed' },
              { text: '用命令做真实聚合，核对总额与客单价', status: 'completed' },
              { text: '排查异常订单与 Q2 汇总勾稽', status: 'in_progress' },
              { text: '生成自包含 HTML 复盘报告', status: 'pending' },
              { text: '打开画布并给出下一步建议', status: 'pending' }
            ]
          }
        }
      ]
    },
    {
      caption: '排查异常订单',
      thinking: '折差异常、负数、重复、勾稽错误，这四类最容易糊弄过去，必须单独查。',
      text:
        `聚合结果出来了：\n\n` +
        `- Q3 总销售额 **¥${fmtMoney(m.totalRevenue)}**\n` +
        `- 有效订单 **${m.validOrders}** 笔（原始 ${m.rawRows} 行，含 ${m.refundCount} 笔退款、${m.duplicateExtra} 行重复导出）\n` +
        `- 客单价约 **¥${fmtMoney(m.avgOrderValue)}**\n\n` +
        `同时扫出 ${anomalyCount} 处数据问题——这些正是报告里最该被点出来、而不是被平均掉的部分：`,
      tools: [{ name: 'run_command', input: { command: buildAnomalyCommand(m.files), timeout_ms: 60000 } }]
    },
    {
      caption: '核对 Q2 环比与客户名单',
      thinking: '环比要用分渠道加总值，不能直接信合计行；客户名单的城市也对一下。',
      text:
        '接着核对 Q2 和客户名单：环比不能直接信「合计」行，得自己加一遍。',
      tools: [
        { name: 'run_command', input: { command: buildQ2Command(m.files), timeout_ms: 60000 } },
        ...(m.customerConflict ? [{ name: 'grep', input: { pattern: m.customerConflict.customer, include: '*.csv' } }] : [])
      ]
    },
    {
      caption: '生成自包含 HTML 报告',
      thinking: '报告要给老板直接看，单文件、无外链、视觉得撑得住场面。',
      text:
        `口径全部核对完了：Q2 分渠道加总 **¥${fmtMoney(m.q2Revenue)}**，表内合计行却是 **¥${fmtMoney(m.q2ReportedTotal)}**（差 ¥${fmtMoney(Math.abs(m.q2Gap))}）；Q3 环比增长 **${fmtPct(m.qoqGrowth)}**。\n\n` +
        '现在开始写报告：先把结构、样式和图表骨架写好，再补数据与文案。石墨底 + 香槟金、衬线大标题、关键指标卡和环比条形图，做成单文件自包含的 HTML——双击就能看，直接转发也不丢样式。',
      tools: [{ name: 'write_file', input: { path: '分析报告.html', content: report } }]
    },
    {
      caption: '打开画布',
      thinking: '把成品放到用户面前，这一步才算交付。',
      text: '报告写好了，我把它放到画布上给你看看。',
      tools: [
        {
          name: 'todo_write',
          input: {
            todos: [
              { text: '读取销售明细，确认数据口径', status: 'completed' },
              { text: '用命令做真实聚合，核对总额与客单价', status: 'completed' },
              { text: '排查异常订单与 Q2 汇总勾稽', status: 'completed' },
              { text: '生成自包含 HTML 复盘报告', status: 'completed' },
              { text: '打开画布并给出下一步建议', status: 'in_progress' }
            ]
          }
        },
        { name: 'open_artifact', input: { title: 'Q3 销售复盘 · 2026', kind: 'html', path: '分析报告.html' } }
      ]
    },
    {
      caption: '给出下一步建议',
      thinking: '最后给三条能直接执行的建议，别让用户自己琢磨。',
      text:
        `报告已经生成好了：**分析报告.html**（已放到画布）。一句话结论：**Q3 卖了 ¥${fmtMoney(m.totalRevenue)}，比 Q2 增长 ${fmtPct(m.qoqGrowth)}，${esc(topChannel.name)}和${esc(topCategory.name)}是主要拉动**。\n\n` +
        '接下来我建议做这三件事：\n\n' +
        `1. **先处理那 ${anomalyCount} 条异常数据**——尤其是金额勾稽不符的订单和重复导出的订单号，不修掉下次复盘还会对不上。\n` +
        `2. **按渠道分策略**：${esc(topChannel.name)}贡献了 ${channelShare.toFixed(1)}% 的销售额，而订单数最多的是${esc(mostOrders.name)}（${mostOrders.orders} 笔），一个走客单价、一个走流量。\n` +
        `3. **整理「旧文件」文件夹**：修正 Q2 汇总的合计错误、把客户回访记录归档，顺便确认一下${m.customerConflict ? esc(m.customerConflict.customer) : '客户名单'}的城市口径。\n\n` +
        '想让我直接改数据、或者把报告导出成别的格式，说一声就行。'
    }
  ]
}


export class DemoProvider implements Provider {
  readonly id = 'demo'
  private readonly speed: number
  private script: DemoStep[] | null = null
  private stepIndex = 0
  private finished = false

  constructor(options: DemoProviderOptions = {}) {
    const speed = options.speed ?? demoEnvSpeed()
    this.speed = Number.isFinite(speed) && speed >= 0 ? speed : 1
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    if (!this.script || this.finished) {
      this.script = buildDemoScript(request.workspace ?? null, new Date())
      this.stepIndex = 0
      this.finished = false
    }
    const step = this.script[this.stepIndex]
    if (!step) {
      this.finished = true
      yield { type: 'text_delta', text: '（演示已结束，可以继续向 Morrow 提问。）' }
      return
    }
    this.stepIndex += 1
    const total = this.script.length
    yield { type: 'demo_step', index: this.stepIndex, total, caption: step.caption }

    await this.pause(650, request.signal)
    if (step.thinking) {
      for await (const event of this.streamText(step.thinking, 'thinking', request.signal)) yield event
    }
    if (step.text) {
      for await (const event of this.streamText(step.text, 'text', request.signal)) yield event
    }
    if (step.tools) {
      for (let index = 0; index < step.tools.length; index += 1) {
        const tool = step.tools[index]
        for await (const event of this.streamTool(tool, index, request.signal)) yield event
      }
    }
    await this.pause(450, request.signal)
    const textLength = (step.thinking?.length ?? 0) + (step.text?.length ?? 0)
    yield {
      type: 'usage',
      usage: { inputTokens: 900 + this.stepIndex * 460, outputTokens: 80 + Math.ceil(textLength / 3) }
    }
    if (!step.tools || step.tools.length === 0) this.finished = true
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (this.speed <= 0) return
    await sleep(Math.round(ms * this.speed), signal)
  }

  private async *streamText(
    text: string,
    kind: 'text' | 'thinking',
    signal: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    let index = 0
    while (index < text.length) {
      if (signal.aborted) throw Object.assign(new Error('演示已中断'), { name: 'AbortError' })
      if (text[index] === '\n') {
        if (this.speed > 0) await sleep(Math.round((kind === 'thinking' ? 45 : 180) * this.speed), signal)
        yield kind === 'text' ? { type: 'text_delta', text: '\n' } : { type: 'thinking_delta', text: '\n' }
        index += 1
        continue
      }
      // 逐 2~3 个字符输出，接近真人打字的节奏
      const size = index + 4 <= text.length && /[\u3000-\u9fff]/.test(text[index]) ? 3 : 2
      const chunk = text.slice(index, index + size)
      index += size
      if (this.speed > 0) await sleep(Math.round((kind === 'thinking' ? 19 : 26) * this.speed), signal)
      yield kind === 'text' ? { type: 'text_delta', text: chunk } : { type: 'thinking_delta', text: chunk }
    }
  }

  private async *streamTool(
    tool: { name: string; input: Record<string, unknown> },
    index: number,
    signal: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const id = newId('call')
    yield { type: 'tool_call_start', index, id, name: tool.name }
    await this.pause(280, signal)
    const args = JSON.stringify(tool.input)
    yield { type: 'tool_call_delta', index, argsDelta: args }
    await this.pause(200, signal)
    if (tool.name === 'write_file') {
      // 真实开发里写文件是最耗时的一步：演示时按内容长度模拟“正在写代码”，
      // 让报告不是瞬间出现，而是先看到结构、再等文件落盘。
      const content = typeof tool.input.content === 'string' ? tool.input.content : ''
      const lines = content ? content.split('\n').length : 20
      const file = typeof tool.input.path === 'string' ? tool.input.path : '文件'
      yield {
        type: 'demo_step',
        index: this.stepIndex,
        total: this.script?.length ?? 0,
        caption: `编写 ${file}（约 ${lines} 行）`
      }
      await this.pause(1_100 + Math.min(4_200, Math.round(content.length / 7)), signal)
    } else if (tool.name === 'run_command' || tool.name === 'terminal') {
      yield {
        type: 'demo_step',
        index: this.stepIndex,
        total: this.script?.length ?? 0,
        caption: '运行命令并核对输出'
      }
      await this.pause(650, signal)
    } else {
      await this.pause(180, signal)
    }
    yield { type: 'tool_call_end', index, id, name: tool.name, input: tool.input }
  }
}


export class ToolProtocolProvider implements Provider {
  readonly id: string
  private readonly inner: Provider

  constructor(inner: Provider) {
    this.inner = inner
    this.id = (inner as Provider & { id?: string }).id ?? 'provider'
  }

  stream(req: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent> {
    return this.normalize(req)
  }

  private async *normalize(req: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    const textFilter = new ToolProtocolStreamFilter()
    const thinkingFilter = new ToolProtocolStreamFilter()
    let structuredToolCalls = 0

    for await (const event of this.inner.stream(req)) {
      if (event.type === 'text_delta') {
        const clean = textFilter.feed(event.text)
        if (clean) yield { type: 'text_delta', text: clean }
        continue
      }
      if (event.type === 'thinking_delta') {
        const clean = thinkingFilter.feed(event.text)
        if (clean) yield { type: 'thinking_delta', text: clean }
        continue
      }
      if (event.type === 'tool_call_start' || event.type === 'tool_call_end') {
        structuredToolCalls += 1
      }
      yield event
    }

    const tail = textFilter.finish()
    if (tail.text) yield { type: 'text_delta', text: tail.text }
    // 思考内容不外溢：协议块直接丢弃，尾部正文照常显示
    const thinkingTail = thinkingFilter.finish()
    if (thinkingTail.text) yield { type: 'thinking_delta', text: thinkingTail.text }

    if (structuredToolCalls > 0 || tail.blocks.length === 0) return

    const knownTools = new Set(req.tools.map((tool) => tool.name))
    const parsed = parseTextToolCalls(tail.blocks.join('\n'))
    const usable = parsed.filter((call) => knownTools.has(call.name))

    for (let index = 0; index < usable.length; index += 1) {
      const call = usable[index]
      const id = newId('call')
      yield { type: 'tool_call_start', index, id, name: call.name }
      yield { type: 'tool_call_delta', index, argsDelta: JSON.stringify(call.input ?? {}) }
      yield { type: 'tool_call_end', index, id, name: call.name, input: call.input ?? {} }
    }

    if (usable.length === 0) {
      yield {
        type: 'notice',
        level: 'warn',
        message:
          knownTools.size === 0
            ? '模型输出了工具调用标记，但当前模式没有可用工具；已忽略这段协议文本。'
            : parsed.length > 0
              ? `模型输出了未注册的工具调用（${parsed.map((call) => call.name).join('、')}），已忽略。`
              : '模型返回了不完整的工具标记，已忽略这段协议文本；请重试或把任务拆小。'
      }
    }
  }
}


/**
 * 按 ProviderConfig.kind 选择实现。
 * demo 走离线剧本引擎（忽略 apiKey/modelId；模型 id 只用于 UI 展示）。
 */
export class UnlimitedBudgetProvider implements Provider {
  readonly id: string
  private readonly inner: Provider

  constructor(inner: Provider) {
    this.inner = inner
    this.id = (inner as Provider & { id?: string }).id ?? 'provider'
  }

  stream(req: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent> {
    return this.inner.stream({ ...req, system: withUnlimitedTokenBudget(req.system) })
  }
}


export function createProvider(config: ProviderConfig, apiKey: string | null, modelId?: string): Provider {
  const inner =
    config.kind === 'demo' || config.id === 'demo'
      ? new DemoProvider()
      : new ToolProtocolProvider(
          config.kind === 'anthropic'
            ? new AnthropicProvider(config, apiKey, modelId)
            : new OpenAICompatProvider(config, apiKey, modelId)
        )
  // 所有 provider（含订阅回环、创作台、Agent、子代理）统一注入同一句预算提示。
  return new UnlimitedBudgetProvider(inner)
}


/**
 * 测试模型连接：发一个极短的流式请求（最多 16 token），返回首字延迟与人话结论。
 * - 本机 / 局域网地址允许不填 Key，方便本地 Ollama、LM Studio 或局域网网关；
 * - demo 直接返回就绪；
 * - 超时默认 15s，成功/失败都返回结构化结果而不是抛错。
 */
export async function testProviderConnection(
  config: ProviderConfig,
  apiKey: string | null,
  modelId?: string,
  options: ConnectionTestOptions = {}
): Promise<ProviderTestResult> {
  const startedAt = Date.now()
  const modelCount = config.models.length

  if (config.kind === 'demo' || config.id === 'demo') {
    return {
      ok: true,
      latencyMs: 0,
      modelCount,
      message: '演示引擎已就绪（离线运行，不消耗任何额度）。'
    }
  }
  if (!config.baseUrl || !config.baseUrl.trim()) {
    return { ok: false, latencyMs: 0, modelCount, message: '还没有填写接口地址（Base URL）。' }
  }
  const hasKey = Boolean(apiKey && apiKey.trim())
  if (!hasKey && !isLocalServiceUrl(config.baseUrl, { allowPrivate: true })) {
    return {
      ok: false,
      latencyMs: 0,
      modelCount,
      message: '还没有填写 API Key。公网服务请先到提供商官网创建密钥；本机或局域网服务可以留空。'
    }
  }

  const model = modelId || config.models[0]?.id || 'unknown'
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const provider = createProvider(config, hasKey ? apiKey : 'local-test', model)
  const testMessage: ChatMessage = {
    id: newId('test'),
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    createdAt: Date.now()
  }
  try {
    let received = false
    for await (const event of provider.stream({
      system: '你是连接测试助手，请只回复两个字：你好。',
      messages: [testMessage],
      tools: [],
      signal: controller.signal,
      maxTokens: 16
    })) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        received = true
        break
      }
    }
    const latencyMs = Date.now() - startedAt
    return {
      ok: true,
      latencyMs,
      modelCount,
      message: received
        ? `连接成功，首字延迟约 ${latencyMs} 毫秒。`
        : `连接成功（服务可达），耗时 ${latencyMs} 毫秒。`
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const providerError = toProviderError(err, config.id)
    const message = controller.signal.aborted
      ? `连接超时（超过 ${(timeoutMs / 1000).toFixed(0)} 秒）。请检查网络、代理或 Base URL 是否正确。`
      : providerError.message
    return { ok: false, latencyMs, modelCount, message }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
