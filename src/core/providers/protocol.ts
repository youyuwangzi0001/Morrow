/**
 * Provider 协议归一化包装层。
 *
 * 所有模型（DeepSeek / Kimi / GLM / MiMo / Qwen / MiniMax / Anthropic / 本地网关）
 * 都会经过这一层：正文里的文本工具协议被剔除；如果网关没有把它放进 tool_calls，
 * 就解析成标准工具事件，避免“乱码”和“看起来执行了其实没执行”。
 */
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../types'
import { newId } from '../util'
import { ToolProtocolStreamFilter, parseTextToolCalls } from '../../shared/tool-protocol'

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
