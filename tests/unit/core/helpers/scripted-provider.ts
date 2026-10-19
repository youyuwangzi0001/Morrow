/**
 * 测试辅助：脚本化 Provider —— 按预设剧本逐回合产出流事件，用于测 Agent 循环。
 */
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../../../src/core/types'
import { ProviderError } from '../../../../src/core/providers/types'

export interface ScriptToolCall {
  name: string
  input?: Record<string, unknown>
  id?: string
  /** 自定义参数 JSON（默认由 input 序列化） */
  args?: string
  /** 模拟「参数被截断/不合法」：provider 以 parseError 形式结束该工具调用 */
  parseError?: string
}

export interface ScriptStep {
  text?: string
  thinking?: string
  toolCalls?: ScriptToolCall[]
  /** 该回合直接抛错（模拟 provider 失败） */
  error?: { message: string; code?: string; retryable?: boolean }
  /** 逐事件间隔（毫秒），用于中断测试 */
  delayMs?: number
}

export class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  readonly calls: ProviderStreamRequest[] = []
  private readonly queue: ScriptStep[]
  private readonly defaultText: string
  private counter = 0

  constructor(steps: ScriptStep[], options: { defaultText?: string } = {}) {
    this.queue = [...steps]
    this.defaultText = options.defaultText ?? '好的。'
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    // 快照消息数组：请求对象里的 messages 是 Agent 的工作数组，后续回合还会 push 新消息
    this.calls.push({ ...request, messages: [...request.messages] })
    const step = this.queue.shift() ?? { text: this.defaultText }
    if (step.delayMs && step.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs))
    }
    if (step.error) {
      throw new ProviderError(step.error.message, {
        code: step.error.code ?? 'provider_error',
        retryable: step.error.retryable ?? false,
        providerId: this.id
      })
    }
    if (step.thinking) yield { type: 'thinking_delta', text: step.thinking }
    if (step.text) yield { type: 'text_delta', text: step.text }
    const calls = step.toolCalls ?? []
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]
      const id = call.id ?? `call_${this.calls.length}_${index}`
      if (call.parseError) {
        yield { type: 'tool_call_end', index, id, name: call.name, input: {}, parseError: call.parseError }
        continue
      }
      const args = call.args ?? JSON.stringify(call.input ?? {})
      yield { type: 'tool_call_start', index, id, name: call.name }
      if (step.delayMs && step.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs))
      }
      yield { type: 'tool_call_delta', index, argsDelta: args }
      yield {
        type: 'tool_call_end',
        index,
        id,
        name: call.name,
        input: call.input ?? (JSON.parse(args) as Record<string, unknown>)
      }
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
  }
}

/** 收集 async iterable 的所有事件 */
export async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of iterable) events.push(event)
  return events
}
