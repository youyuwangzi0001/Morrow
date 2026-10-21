/**
 * OpenAI 兼容 Chat Completions 流式 Provider。
 * 覆盖：DeepSeek（含 reasoning_content）、OpenAI、Kimi、以及任意 OpenAI 兼容网关。
 *
 * 协议要点：
 * - POST {baseUrl}/chat/completions，stream=true，stream_options.include_usage=true；
 * - SSE data 帧里 delta.content / delta.reasoning_content / delta.tool_calls 增量；
 * - tool_calls 按 index 拼接 id/name/arguments，arguments 是**字符串分片**；
 * - 429/5xx/网络错误按 DEFAULT_RETRY 指数退避重试（见 types.ts streamWithRetry）。
 */
import type { ChatMessage, ProviderConfig, Usage } from '../../shared/types'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest, ToolDefinition } from '../types'
import { newId, parseToolArgs } from '../util'
import { iterateSSEData } from './sse'
import {
  DEFAULT_RETRY,
  ProviderError,
  normalizeHttpError,
  readTextSafe,
  resolveChatCompletionsUrl,
  streamWithRetry,
  toProviderError,
  type RetryPolicy
} from './types'

interface OpenAIDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
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

/* ── 请求体转换（也导出给测试断言） ───────────────────────────── */

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | OpenAIContentPart[]
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function toolResultText(result: Extract<ChatMessage['content'][number], { type: 'tool_use' }>): string {
  if (!result.result) return '[该工具调用没有返回结果]'
  if (result.result.ok) {
    return result.result.output || '(命令执行成功，没有输出)'
  }
  const parts = [`[工具执行失败] ${result.result.error ?? result.result.output ?? '未知错误'}`]
  if (result.result.hint) parts.push(`提示：${result.result.hint}`)
  if (result.result.output) parts.push(result.result.output)
  return parts.join('\n')
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
    for (const block of toolUses) out.push({ role: 'tool', tool_call_id: block.id, content: toolResultText(block) })
  }
  // 空的 system 消息会被部分网关判为非法 content，没有系统提示时直接省略
  const systemText = systemParts.join('\n\n')
  return systemText ? [{ role: 'system', content: systemText }, ...out] : out
}

export function buildOpenAIRequestBody(
  req: ProviderStreamRequest,
  model: string
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
  if (req.reasoning?.style === 'effort') body.reasoning_effort = req.reasoning.effort
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

/* ── Provider ─────────────────────────────────────────────────── */

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
        headers: this.headers,
        body: JSON.stringify(buildOpenAIRequestBody(req, this.model)),
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
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        hasOutput = true
        yield { type: 'text_delta', text: delta.content }
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
        const argsDelta = call.function?.arguments ?? ''
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
    }

    // 流结束：补发 tool_call_end（含容错解析的参数）
    for (const acc of [...toolAcc.values()].sort((a, b) => a.index - b.index)) {
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
