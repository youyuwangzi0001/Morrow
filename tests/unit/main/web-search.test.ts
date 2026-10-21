/**
 * P0-4 联网搜索：SearXNG 适配、结果清洗、缓存、限流、核心工具输出。
 * 全部离线（本机 HTTP mock + 内存 SettingsStore 替身）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSearchError, WebSearchService } from '../../../src/main/services/web-search'
import type { SettingsStore } from '../../../src/main/services/settings-store'
import type { WebSearchSettings } from '../../../src/shared/types'
import { executeTool } from '../../../src/core/tools/registry'
import { makeTempWorkspace } from '../core/helpers/workspace'
import { makeToolContext } from '../core/helpers/tool-context'

function storeFor(baseUrl: string, overrides: Partial<WebSearchSettings> = {}): SettingsStore {
  const webSearch: WebSearchSettings = {
    enabled: true,
    provider: 'searxng',
    baseUrl,
    apiKeyStored: false,
    maxResults: 5,
    ...overrides
  }
  return {
    get: () => ({ webSearch }),
    getWebSearchKey: () => null
  } as unknown as SettingsStore
}

async function startSearchServer(): Promise<{ baseUrl: string; server: Server; requests: string[] }> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/bad' || url.pathname.startsWith('/bad/')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"down"}')
      return
    }
    if (url.pathname.startsWith('/huge')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [], pad: 'x'.repeat(2.2 * 1024 * 1024) }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: [
          { title: 'Result &amp; one', url: 'https://example.com/a', content: 'Snippet one', engine: 'google' },
          { title: 'Result two', url: 'https://example.com/b', content: 'Snippet two' },
          { title: 'Bad URL', url: 'file:///etc/passwd', content: 'should be dropped' },
          { title: 'Result three', url: 'https://example.com/c', content: 'Snippet three' }
        ],
        answers: ['A short answer']
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, server, requests }
}

const servers: Server[] = []
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  }
})

describe('WebSearchService', () => {
  it('normalizes SearXNG results, drops unsafe URLs and honors maxResults', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(mock.baseUrl))
    const result = await search.search({ query: 'Morrow', maxResults: 2, signal: new AbortController().signal })
    expect(result.provider).toBe('SearXNG')
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({ rank: 1, title: 'Result &amp; one', url: 'https://example.com/a' })
    expect(result.sources.every((source) => source.url.startsWith('https://'))).toBe(true)
    expect(result.answer).toBe('A short answer')
    expect(mock.requests[0]).toContain('format=json')
  })

  it('caches identical searches and enforces the per-minute rate limit', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(mock.baseUrl))
    const first = await search.search({ query: 'cache me', maxResults: 3, signal: new AbortController().signal })
    const second = await search.search({ query: 'cache me', maxResults: 3, signal: new AbortController().signal })
    expect(first.cached).not.toBe(true)
    expect(second.cached).toBe(true)
    expect(mock.requests).toHaveLength(1)

    const limited = new WebSearchService(storeFor(mock.baseUrl))
    for (let index = 0; index < 10; index += 1) {
      await limited.search({ query: `q-${index}`, maxResults: 1, signal: new AbortController().signal })
    }
    await expect(
      limited.search({ query: 'q-overflow', maxResults: 1, signal: new AbortController().signal })
    ).rejects.toBeInstanceOf(WebSearchError)
  })

  it('uses settings.maxResults when omitted and keys the cache by SearXNG instance', async () => {
    const mockA = await startSearchServer()
    servers.push(mockA.server)
    const mockB = await startSearchServer()
    servers.push(mockB.server)
    let webSearch: WebSearchSettings = {
      enabled: true,
      provider: 'searxng',
      baseUrl: mockA.baseUrl,
      apiKeyStored: false,
      maxResults: 2
    }
    const store = {
      get: () => ({ webSearch }),
      getWebSearchKey: () => null
    } as unknown as SettingsStore
    const search = new WebSearchService(store)
    const first = await search.search({ query: 'default-count', signal: new AbortController().signal })
    expect(first.sources).toHaveLength(2)

    await search.search({ query: 'instance-switch', signal: new AbortController().signal })
    webSearch = { ...webSearch, baseUrl: mockB.baseUrl }
    await search.search({ query: 'instance-switch', signal: new AbortController().signal })
    expect(mockB.requests).toHaveLength(1)
  })

  it('rejects oversized provider responses without parsing them', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(`${mock.baseUrl}/huge`))
    await expect(
      search.search({ query: 'huge', maxResults: 1, signal: new AbortController().signal })
    ).rejects.toThrow(/内容过大/)
  })

  it('reports provider HTTP failures without leaking keys', async () => {
    const mock = await startSearchServer()
    servers.push(mock.server)
    const search = new WebSearchService(storeFor(`${mock.baseUrl}/bad`))
    await expect(
      search.search({ query: 'fail', maxResults: 1, signal: new AbortController().signal })
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe('web_search core tool', () => {
  it('formats numbered sources and metadata; rejects when search is not configured', async () => {
    const ws = makeTempWorkspace()
    try {
      const ctx = makeToolContext(ws, {
        searchWeb: async () => ({
          query: 'Morrow',
          provider: 'Tavily',
          elapsedMs: 12,
          sources: [
            { rank: 1, title: 'First', url: 'https://example.com/1', snippet: 'One' },
            { rank: 2, title: 'Second', url: 'https://example.com/2', snippet: 'Two' }
          ]
        })
      })
      const result = await executeTool('web_search', { query: 'Morrow', max_results: 2 }, ctx)
      expect(result.ok).toBe(true)
      expect(result.output).toContain('[1] First')
      expect(result.output).toContain('URL: https://example.com/1')
      expect(result.output).toContain('不可信数据')
      expect((result.meta?.sources as unknown[])).toHaveLength(2)

      const noSearch = await executeTool('web_search', { query: 'x' }, makeToolContext(ws))
      expect(noSearch.ok).toBe(false)
      expect(noSearch.error).toContain('还没有配置联网搜索')
    } finally {
      ws.cleanup()
    }
  })
})
