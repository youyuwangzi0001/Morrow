import { describe, expect, it } from 'vitest'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest, ToolDefinition } from '../../../src/core/types'
import { ToolProtocolProvider } from '../../../src/core/providers/protocol'

function request(tools: string[]): ProviderStreamRequest {
  const definitions: ToolDefinition[] = tools.map((name) => ({
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    category: 'read',
    risk: 'low',
    titleFor: () => name
  }))
  return {
    system: '',
    messages: [],
    tools: definitions,
    signal: new AbortController().signal
  }
}

function fakeProvider(events: ProviderStreamEvent[]): Provider {
  return {
    async *stream() {
      for (const event of events) yield event
    }
  }
}

async function collect(provider: Provider, req: ProviderStreamRequest): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of provider.stream(req)) events.push(event)
  return events
}

describe('Provider 协议归一化包装层', () => {
  it('把正文里的文本工具协议还原成标准工具事件', async () => {
    const text = `<|tool_calls_section_begin|>
<|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"a.html"}<|tool_call_end|>
<|tool_calls_section_end|>`
    const provider = new ToolProtocolProvider(
      fakeProvider([
        { type: 'text_delta', text: '先改文件。' },
        ...Array.from(text).map((char) => ({ type: 'text_delta' as const, text: char }))
      ])
    )
    const events = await collect(provider, request(['edit_file']))
    expect(events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')).toBe('先改文件。')
    const end = events.find((event) => event.type === 'tool_call_end')
    expect(end).toMatchObject({ type: 'tool_call_end', name: 'edit_file', input: { path: 'a.html' } })
  })

  it('结构化 tool_calls 存在时不重复执行文本协议', async () => {
    const provider = new ToolProtocolProvider(
      fakeProvider([
        { type: 'text_delta', text: '<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}</tool_call>' },
        { type: 'tool_call_start', index: 0, id: 'call_1', name: 'edit_file' },
        { type: 'tool_call_end', index: 0, id: 'call_1', name: 'edit_file', input: { path: 'a.html' } }
      ])
    )
    const events = await collect(provider, request(['edit_file']))
    expect(events.filter((event) => event.type === 'tool_call_end')).toHaveLength(1)
    expect(events.some((event) => event.type === 'text_delta' && event.text.includes('tool_call'))).toBe(false)
  })

  it('未注册工具调用被忽略并提示，不冒充执行', async () => {
    const provider = new ToolProtocolProvider(
      fakeProvider([
        { type: 'text_delta', text: '<tool_call>{"name":"rm_rf","arguments":{"path":"/"}}</tool_call>' }
      ])
    )
    const events = await collect(provider, request(['edit_file']))
    expect(events.some((event) => event.type === 'tool_call_end')).toBe(false)
    expect(events.some((event) => event.type === 'notice' && event.message.includes('未注册'))).toBe(true)
  })
})
