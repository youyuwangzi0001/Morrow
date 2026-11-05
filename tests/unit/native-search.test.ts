import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo, ProviderConfig } from '../../src/shared/types'
import { nativeSearch, nativeSearchProtocol, nativeSearchSupported, NativeSearchError } from '../../src/main/native-search'

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    kind: 'openai-compat',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [],
    apiKeyStored: true,
    enabled: true,
    ...overrides
  }
}

const model: ModelInfo = {
  id: 'gpt-6-sol',
  label: 'GPT-6 Sol',
  contextWindow: 128_000,
  supportsTools: true
}

describe('模型原生搜索', () => {
  it('@core:web 识别原生搜索协议并排除本地服务', () => {
    expect(nativeSearchProtocol(config(), model)).toBe('openai-responses')
    expect(nativeSearchProtocol(config({ id: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }), model)).toBe('anthropic-messages')
    expect(nativeSearchProtocol(config({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' }), { ...model, id: 'gemini-4-argon' })).toBe('gemini-grounding')
    expect(nativeSearchProtocol(config({ id: 'xai', baseUrl: 'https://api.x.ai/v1' }), { ...model, id: 'grok-4.7' })).toBe('xai-live-search')
    expect(nativeSearchProtocol(config({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }), { ...model, id: 'deepseek-flash' })).toBe('deepseek-search')
    expect(nativeSearchSupported(config({ baseUrl: 'http://127.0.0.1:8080/v1' }), model)).toBe(false)
    expect(nativeSearchSupported(config({ id: 'demo', kind: 'demo', baseUrl: 'local://demo' }), model)).toBe(false)
  })

  it('@core:web 解析 OpenAI Responses 与 Anthropic 搜索来源', async () => {
    const openai = await nativeSearch({
      config: config(),
      model,
      apiKey: 'sk-test',
      query: 'Morrow',
      maxResults: 3,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        output_text: 'OpenAI 答案',
        output: [
          {
            type: 'message',
            content: [{
              type: 'output_text',
              text: 'OpenAI 答案',
              annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'A' }]
            }]
          },
          { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/b', title: 'B' }] } }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })
    expect(openai.provider).toBe('模型原生搜索')
    expect(openai.answer).toContain('OpenAI 答案')
    expect(openai.sources.map((source) => source.url)).toEqual(['https://example.com/a', 'https://example.com/b'])

    const anthropic = await nativeSearch({
      config: config({ id: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      model: { ...model, id: 'claude-opus-5-5', reasoningStyle: 'thinking' },
      apiKey: 'sk-ant',
      query: 'Morrow',
      maxResults: 3,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        content: [
          { type: 'text', text: 'Claude 答案', citations: [{ url: 'https://example.com/c', title: 'C' }] },
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/d', title: 'D', page_age: '2026-10-01' }] }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })
    expect(anthropic.answer).toContain('Claude 答案')
    expect(anthropic.sources.map((source) => source.url)).toEqual(['https://example.com/c', 'https://example.com/d'])
  })

  it('@core:web 从 web_search_call 与回答链接补全来源，模型没搜索时明确失败', async () => {
    const v4pro = await nativeSearch({
      config: config({ id: 'gateway', baseUrl: 'https://gateway.example.com/v1' }),
      model: { ...model, id: 'gateway-search-model' },
      apiKey: 'sk-test',
      query: '今天的科技新闻',
      maxResults: 5,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'web_search_call', action: { type: 'search', queries: ['科技新闻'] } },
          { type: 'web_search_call', action: { type: 'open_page', url: 'https://example.com/page#ws_call_id=call_01' } },
          {
            type: 'message',
            content: [{
              type: 'output_text',
              text: '参考 [新闻 A](https://example.com/news-a) 和 https://example.com/news-b。',
              annotations: []
            }]
          }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })
    expect(v4pro.answer).toContain('新闻 A')
    expect(v4pro.sources.map((source) => source.url)).toEqual([
      'https://example.com/page',
      'https://example.com/news-a',
      'https://example.com/news-b'
    ])

    await expect(nativeSearch({
      config: config({ id: 'gateway', baseUrl: 'https://gateway.example.com/v1' }),
      model: { ...model, id: 'gateway-flash-model' },
      apiKey: 'sk-test',
      query: '今天的科技新闻',
      maxResults: 5,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        output: [
          { type: 'reasoning', summary: [] },
          {
            type: 'message',
            content: [{
              type: 'output_text',
              text: '抱歉，我当前没有可用的联网搜索工具。建议到 https://news.google.com/search 查看。',
              annotations: []
            }]
          }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })).rejects.toMatchObject({ unsupported: true } satisfies Partial<NativeSearchError>)
  })

  it('@core:web DeepSeek 官方渠道走 Search API，并按结果生成来源', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      expect(body).toMatchObject({ query: 'DeepSeek V4', count: 3, need_content: false })
      return new Response(JSON.stringify({
        results: [
          { title: '结果 A', url: 'https://example.com/a', snippet: '短摘要', summary: '长摘要 A', site_name: '示例站', date: '2026-10-30T16:00:00+00:00', authority: 4 },
          { title: '结果 B', url: 'https://example.com/b', snippet: '短摘要 B', summary: '', site_name: null, date: null, authority: 3 },
          { title: '坏链接', url: 'file:///etc/passwd', snippet: 'drop' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const result = await nativeSearch({
      config: config({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }),
      model: { ...model, id: 'deepseek-flash' },
      apiKey: 'sk-test',
      query: 'DeepSeek V4',
      maxResults: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/tools/search')
    expect(result.provider).toBe('DeepSeek 搜索')
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({ title: '结果 A', url: 'https://example.com/a' })
    expect(result.sources[0]?.snippet).toContain('示例站')
    expect(result.sources[0]?.snippet).toContain('长摘要 A')

    const empty = await nativeSearch({
      config: config({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' }),
      model: { ...model, id: 'deepseek-flash' },
      apiKey: 'sk-test',
      query: '无结果',
      maxResults: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch
    })
    expect(empty.sources).toEqual([])
  })

  it('@core:web 解析 Gemini/xAI 来源，并把不支持端点标成可回退错误', async () => {
    const gemini = await nativeSearch({
      config: config({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' }),
      model: { ...model, id: 'gemini-4-argon' },
      apiKey: 'gemini-key',
      query: 'Morrow',
      maxResults: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: 'Gemini 答案' }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/e', title: 'E' } }] }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })
    expect(gemini.answer).toContain('Gemini 答案')
    expect(gemini.sources[0]).toMatchObject({ url: 'https://example.com/e', title: 'E' })

    const xai = await nativeSearch({
      config: config({ id: 'xai', baseUrl: 'https://api.x.ai/v1' }),
      model: { ...model, id: 'grok-4.7' },
      apiKey: 'xai-key',
      query: 'Morrow',
      maxResults: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'Grok 答案', citations: [{ url: 'https://example.com/f', title: 'F' }] } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    })
    expect(xai.answer).toContain('Grok 答案')
    expect(xai.sources[0]).toMatchObject({ url: 'https://example.com/f', title: 'F' })

    await expect(nativeSearch({
      config: config(),
      model,
      apiKey: 'sk-test',
      query: 'Morrow',
      maxResults: 2,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: { message: 'unknown tool: web_search' } }), { status: 400 })) as unknown as typeof fetch
    })).rejects.toMatchObject({ unsupported: true } satisfies Partial<NativeSearchError>)
  })
})
