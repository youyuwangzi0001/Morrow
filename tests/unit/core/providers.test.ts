import { afterEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ProviderConfig } from '../../../src/shared/types'
import { AnthropicProvider, buildAnthropicRequestBody, toAnthropicMessages } from '../../../src/core/providers/anthropic'
import {
  OpenAICompatProvider,
  buildOpenAIRequestBody,
  toOpenAIMessages
} from '../../../src/core/providers/openai-compat'
import { createProvider, testProviderConnection } from '../../../src/core/providers'
import {
  normalizeHttpError,
  resolveAnthropicMessagesUrl,
  resolveChatCompletionsUrl
} from '../../../src/core/providers/types'
import { collectEvents } from './helpers/scripted-provider'
import {
  anthropicTextFrames,
  anthropicToolFrames,
  openAITextFrames,
  openAIToolFrames,
  startMockLLM,
  type MockLLM
} from './helpers/mock-llm'

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'mock',
    kind: 'openai-compat',
    name: 'Mock',
    baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'mock-model', label: 'Mock', contextWindow: 8000, supportsTools: true }],
    apiKeyStored: false,
    enabled: true,
    ...overrides
  }
}

function userMessage(text: string): ChatMessage {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
}

const servsers: MockLLM[] = []
async function serve(handler: Parameters<typeof startMockLLM>[0]): Promise<MockLLM> {
  const server = await startMockLLM(handler)
  servsers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servsers.splice(0).map((server) => server.close()))
})

describe('URL 归一化', () => {
  it('OpenAI 兼容地址', () => {
    expect(resolveChatCompletionsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(resolveChatCompletionsUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions')
    expect(resolveChatCompletionsUrl('https://x/v1/chat/completions')).toBe('https://x/v1/chat/completions')
    expect(resolveChatCompletionsUrl('http://127.0.0.1:1234/v1/')).toBe('http://127.0.0.1:1234/v1/chat/completions')
  })

  it('Anthropic 地址', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://proxy/v1/messages')).toBe('https://proxy/v1/messages')
  })
})

describe('错误归一化', () => {
  it('401 提示检查 API Key', () => {
    const error = normalizeHttpError(401, JSON.stringify({ error: { message: 'invalid key' } }), 'deepseek')
    expect(error.code).toBe('auth')
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('API Key')
    expect(error.message).toContain('invalid key')
  })

  it('429/5xx 可重试', () => {
    expect(normalizeHttpError(429, '', 'x').retryable).toBe(true)
    expect(normalizeHttpError(503, '', 'x').retryable).toBe(true)
    expect(normalizeHttpError(400, '', 'x').retryable).toBe(false)
  })
})

describe('OpenAI 兼容协议', () => {
  it('流式文本 + reasoning_content + usage', async () => {
    const server = await serve(() => ({
      frames: [
        { choices: [{ index: 0, delta: { reasoning_content: '先想一下' } }] },
        ...openAITextFrames('你好，我是 Morrow', { usage: { input: 12, output: 8 } })
      ]
    }))
    const provider = new OpenAICompatProvider(config({ baseUrl: server.baseUrl }), 'sk-test', 'mock-model', { retryDelays: [1, 1, 1] })
    const events = await collectEvents(provider.stream({ system: '你是助手', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')
    const thinking = events.filter((e) => e.type === 'thinking_delta').map((e) => (e.type === 'thinking_delta' ? e.text : '')).join('')
    expect(text).toBe('你好，我是 Morrow')
    expect(thinking).toBe('先想一下')
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage).toMatchObject({ inputTokens: 12, outputTokens: 8 })

    const body = server.requests[0].body as Record<string, unknown>
    expect(server.requests[0].path).toBe('/v1/chat/completions')
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-test')
    expect(body.model).toBe('mock-model')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('system')
  })

  it('工具调用增量拼接成完整 input', async () => {
    const args = JSON.stringify({ path: 'a.txt', content: '你好世界' })
    const server = await serve(() => ({ frames: openAIToolFrames('call_1', 'write_file', args, { usage: { input: 20, output: 10 } }) }))
    const provider = new OpenAICompatProvider(config({ baseUrl: server.baseUrl }), 'k', 'm', { retryDelays: [1] })
    const events = await collectEvents(provider.stream({ system: '', messages: [userMessage('写文件')], tools: [], signal: new AbortController().signal }))
    const end = events.find((e) => e.type === 'tool_call_end')
    expect(end?.type === 'tool_call_end' && end).toMatchObject({
      id: 'call_1',
      name: 'write_file',
      input: { path: 'a.txt', content: '你好世界' }
    })
    expect(events.filter((e) => e.type === 'tool_call_start')).toHaveLength(1)
  })

  it('429 自动退避重试并发出 notice', async () => {
    let attempts = 0
    const server = await serve(() => {
      attempts += 1
      if (attempts <= 2) return { status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) }
      return { frames: openAITextFrames('ok') }
    })
    const provider = new OpenAICompatProvider(config({ baseUrl: server.baseUrl }), 'k', 'm', { retryDelays: [1, 1, 1] })
    const events = await collectEvents(provider.stream({ system: '', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
    expect(server.requests).toHaveLength(3)
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(2)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
  })

  it('请求体转换：tool_use 回填成 tool_calls + tool 消息，system 独立', () => {
    const history: ChatMessage[] = [
      userMessage('读取 a.txt'),
      {
        id: 'a1',
        role: 'assistant',
        createdAt: Date.now(),
        content: [
          { type: 'text', text: '我来读取' },
          {
            type: 'tool_use',
            id: 'call_9',
            name: 'read_file',
            title: '读取 a.txt',
            category: 'read',
            input: { path: 'a.txt' },
            status: 'success',
            result: { ok: true, output: '文件内容' }
          }
        ]
      },
      userMessage('继续')
    ]
    const messages = toOpenAIMessages(history, '系统提示')
    expect(messages[0]).toEqual({ role: 'system', content: '系统提示' })
    expect(messages[1]).toEqual({ role: 'user', content: '读取 a.txt' })
    expect(messages[2].role).toBe('assistant')
    expect(messages[2].tool_calls?.[0].function.name).toBe('read_file')
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_9', content: '文件内容' })
    expect(messages[4].role).toBe('user')
  })

  it('buildOpenAIRequestBody 携带 tools schema 与 maxTokens', () => {
    const request = buildOpenAIRequestBody(
      {
        system: 's',
        messages: [userMessage('hi')],
        tools: [
          {
            name: 'read_file',
            description: '读文件',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            category: 'read',
            risk: 'low',
            titleFor: () => '读取'
          }
        ],
        signal: new AbortController().signal,
        maxTokens: 512
      },
      'mock-model'
    )
    expect(request.max_tokens).toBe(512)
    expect((request.tools as Array<{ function: { name: string } }>)[0].function.name).toBe('read_file')
  })
})

describe('Anthropic 协议', () => {
  it('流式文本 + usage + 正确请求头与路径', async () => {
    const server = await serve(() => ({ frames: anthropicTextFrames('你好，我是 Claude', { input: 33, output: 12 }), done: false }))
    const provider = new AnthropicProvider(config({ id: 'anthropic', kind: 'anthropic', baseUrl: server.baseUrl }), 'sk-ant', 'claude-test')
    const events = await collectEvents(provider.stream({ system: '你是助手', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
    expect(server.requests[0].path).toBe('/v1/messages')
    expect(server.requests[0].headers['x-api-key']).toBe('sk-ant')
    expect(server.requests[0].headers['anthropic-version']).toBe('2023-06-01')
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')
    expect(text).toBe('你好，我是 Claude')
    const usages = events.filter((e) => e.type === 'usage')
    expect(usages.length).toBeGreaterThan(0)
    const last = usages[usages.length - 1]
    expect(last.type === 'usage' && last.usage).toMatchObject({ inputTokens: 33, outputTokens: 12 })
  })

  it('工具调用：content_block_start + input_json_delta 拼接', async () => {
    const args = JSON.stringify({ path: '报告.md', content: '# 标题' })
    const server = await serve(() => ({ frames: anthropicToolFrames('toolu_1', 'write_file', args), done: false }))
    const provider = new AnthropicProvider(config({ id: 'anthropic', kind: 'anthropic', baseUrl: server.baseUrl }), 'sk-ant', 'claude-test')
    const events = await collectEvents(provider.stream({ system: '', messages: [userMessage('写报告')], tools: [], signal: new AbortController().signal }))
    const end = events.find((e) => e.type === 'tool_call_end')
    expect(end?.type === 'tool_call_end' && end).toMatchObject({ id: 'toolu_1', name: 'write_file', input: { path: '报告.md', content: '# 标题' } })
  })

  it('Anthropic 错误帧可重试时会重试到上限', async () => {
    const server = await serve(() => ({
      frames: [{ _event: 'error', type: 'error', error: { type: 'overloaded_error', message: '服务繁忙' } }],
      done: false
    }))
    const provider = new AnthropicProvider(config({ id: 'anthropic', kind: 'anthropic', baseUrl: server.baseUrl }), 'sk-ant', 'claude-test', { retryDelays: [1, 1, 1] })
    await expect(
      collectEvents(provider.stream({ system: '', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
    ).rejects.toThrow(/服务繁忙/)
    expect(server.requests).toHaveLength(4)
  })

  it('消息转换：tool_result 作为 user 消息、system 独立、首条必须是 user', () => {
    const history: ChatMessage[] = [
      {
        id: 'a0',
        role: 'assistant',
        createdAt: Date.now(),
        content: [{ type: 'text', text: '（历史被裁剪后的开头）' }]
      },
      userMessage('继续'),
      {
        id: 'a1',
        role: 'assistant',
        createdAt: Date.now(),
        content: [
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'read_file',
            title: '读取',
            category: 'read',
            input: { path: 'x' },
            status: 'success',
            result: { ok: false, output: '', error: '文件不存在' }
          }
        ]
      }
    ]
    const converted = toAnthropicMessages(history, '系统')
    expect(converted.system).toBe('系统')
    expect(converted.messages[0].role).toBe('user')
    const toolResultMessage = converted.messages.find((message) =>
      message.content.some((block) => block.type === 'tool_result')
    )
    expect(toolResultMessage?.role).toBe('user')
    const toolResult = toolResultMessage?.content.find((block) => block.type === 'tool_result')
    expect(toolResult).toMatchObject({ tool_use_id: 'toolu_9', is_error: true })
    const request = buildAnthropicRequestBody(
      { system: '系统', messages: history, tools: [], signal: new AbortController().signal, maxTokens: 100 },
      'claude-test'
    )
    expect(request.system).toBe('系统')
    expect(request.max_tokens).toBe(100)
    expect(request.stream).toBe(true)
  })
})

describe('createProvider / testProviderConnection', () => {
  it('demo 返回离线 Provider', () => {
    const provider = createProvider(config({ id: 'demo', kind: 'demo', baseUrl: 'local://demo' }), null)
    expect(provider).toBeInstanceOf(Object)
    expect(typeof (provider as { stream?: unknown }).stream).toBe('function')
    expect(provider.constructor.name).toBe('DemoProvider')
  })

  it('连接成功返回延迟与人话', async () => {
    const server = await serve(() => ({ frames: openAITextFrames('你好') }))
    const result = await testProviderConnection(config({ baseUrl: server.baseUrl }), 'sk-test', 'mock-model', { timeoutMs: 5000 })
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.message).toContain('连接成功')
  })

  it('401 返回可读失败信息', async () => {
    const server = await serve(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }))
    const result = await testProviderConnection(config({ baseUrl: server.baseUrl }), 'sk-test', 'mock-model', { timeoutMs: 5000 })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API Key')
  })

  it('没有 API Key 时直接给出提示（远程地址）', async () => {
    const result = await testProviderConnection(config({ baseUrl: 'https://api.example.com/v1' }), null, 'mock-model')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API Key')
  })

  it('demo 连接测试直接成功', async () => {
    const result = await testProviderConnection(config({ id: 'demo', kind: 'demo', baseUrl: 'local://demo' }), null)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('演示引擎')
  })
})
