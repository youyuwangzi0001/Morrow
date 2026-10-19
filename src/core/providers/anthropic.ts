/**
 * Anthropic Messages API 流式 Provider。
 *
 * 与 OpenAI 的差异：
 * - system 是顶层字段，不在 messages 里；
 * - 工具调用是 assistant content 里的 tool_use block，工具结果必须是 user 消息里的
 *   tool_result block，且消息角色必须交替；
 * - 流事件：message_start / content_block_start / content_block_delta / content_block_stop /
 *   message_delta / message_stop。
 */
import type { ChatMessage, ProviderConfig, Usage } from '../../shared/types'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest, ToolDefinition } from '../types'
import { parseToolArgs } from '../util'
import { iterateSSEData } from './sse'
import {
  DEFAULT_RETRY,
  ProviderError,
  normalizeHttpError,
  readTextSafe,
  resolveAnthropicMessagesUrl,
  streamWithRetry,
  toProviderError,
  type RetryPolicy
} from './types'

export const ANTHROPIC_VERSION = '2023-06-01'

/* ── 请求体转换（导出供测试断言） ─────────────────────────────── */

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

function toolResultText(block: Extract<ChatMessage['content'][number], { type: 'tool_use' }>): string {
  if (!block.result) return '[该工具调用没有返回结果]'
  if (block.result.ok) return block.result.output || '(命令执行成功，没有输出)'
  const parts = [`[工具执行失败] ${block.result.error ?? block.result.output ?? '未知错误'}`]
  if (block.result.hint) parts.push(`提示：${block.result.hint}`)
  if (block.result.output) parts.push(block.result.output)
  return parts.join('\n')
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
          content: toolResultText(block),
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
    system: converted.system,
    messages: converted.messages,
    max_tokens: typeof req.maxTokens === 'number' && req.maxTokens > 0 ? req.maxTokens : 8192,
    stream: true
  }
  if (req.tools.length > 0) body.tools = req.tools.map(toAnthropicTool)
  if (typeof req.temperature === 'number') body.temperature = req.temperature
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
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {})
  }
}

/* ── 流事件结构 ───────────────────────────────────────────────── */

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

/* ── Provider ─────────────────────────────────────────────────── */

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
    const policy: RetryPolicy = { maxRetries: 3, delays: this.retryDelays }
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

    interface BlockState {
      kind: 'text' | 'thinking' | 'tool_use'
      toolId?: string
      toolName?: string
      json: string
      ended: boolean
    }
    const blocks = new Map<number, BlockState>()

    for await (const payload of iterateSSEData(response.body)) {
      const event = payload as AnthropicStreamPayload
      switch (event.type) {
        case 'message_start': {
          const usage = event.message?.usage
          inputTokens = usage?.input_tokens ?? 0
          cacheReadTokens = usage?.cache_read_input_tokens ?? 0
          yield { type: 'usage', usage: { inputTokens, outputTokens: 0, ...(cacheReadTokens ? { cacheReadTokens } : {}) } }
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
            yield { type: 'text_delta', text: delta.text }
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'thinking_delta', text: delta.thinking }
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            if (state) state.json += delta.partial_json
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
            const input = parseToolArgs(state.json)
            if (!input) {
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
          return
        default:
          // ping / 未知事件：忽略
          break
      }
    }

    // 防御：服务端未发 message_stop 就断流时，把已开始的工具块收尾
    for (const [index, state] of blocks) {
      if (!state.ended && state.kind === 'tool_use' && state.toolId && state.toolName) {
        const input = parseToolArgs(state.json)
        if (!input) {
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
  }
}
