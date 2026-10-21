/**
 * 联网搜索服务（P0-4）。
 *
 * 支持 Tavily / Brave / Serper / SearXNG；Key 由 SettingsStore 加密保存，
 * 搜索请求只从主进程发出。安全与稳定性：
 * - 固定服务商端点；SearXNG 地址由用户显式配置（允许本机实例），保存时校验协议与凭据；
 * - 15s 超时、2MB 响应上限、最多 maxResults 条；结果 URL 只保留 http(s)；
 * - 进程级限流（10 次/分钟）与 5 分钟缓存，避免模型循环搜索耗尽额度；
 * - 错误信息不包含 API Key。
 */
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSettings,
  WebSearchSource
} from '../../shared/types'
import type { SettingsStore } from './settings-store'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 40

const PROVIDER_LABEL: Record<WebSearchProvider, string> = {
  tavily: 'Tavily',
  brave: 'Brave Search',
  serper: 'Serper',
  searxng: 'SearXNG'
}

export class WebSearchError extends Error {
  readonly hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'WebSearchError'
    this.hint = hint
  }
}

interface CachedEntry {
  response: WebSearchResponse
  expiresAt: number
}

interface SearchOptions {
  query: string
  /** 省略时使用设置里的「每次结果数」 */
  maxResults?: number
  signal?: AbortSignal
}

function sanitizeText(value: unknown, max = 1000): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : ''
}

function sanitizeUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password) return ''
    return url.toString().slice(0, 2048)
  } catch {
    return ''
  }
}

function toSources(
  items: unknown,
  map: (item: Record<string, unknown>, index: number) => WebSearchSource | null,
  maxResults: number
): WebSearchSource[] {
  if (!Array.isArray(items)) return []
  const sources: WebSearchSource[] = []
  for (let index = 0; index < items.length && sources.length < maxResults; index += 1) {
    const item = items[index]
    if (!item || typeof item !== 'object') continue
    const source = map(item as Record<string, unknown>, index)
    if (source && source.url) sources.push({ ...source, rank: sources.length + 1 })
  }
  return sources
}

export class WebSearchService {
  private cache = new Map<string, CachedEntry>()
  private requests: number[] = []

  constructor(private readonly settingsStore: SettingsStore) {}

  getSettings(): WebSearchSettings {
    return this.settingsStore.get().webSearch
  }

  isConfigured(): boolean {
    const settings = this.getSettings()
    if (!settings.enabled) return false
    if (settings.provider === 'searxng') return Boolean(settings.baseUrl)
    return Boolean(this.settingsStore.getWebSearchKey())
  }

  private assertRateLimit(): void {
    const now = Date.now()
    this.requests = this.requests.filter((time) => now - time < RATE_WINDOW_MS)
    if (this.requests.length >= RATE_LIMIT) {
      throw new WebSearchError(
        `联网搜索太频繁（每分钟最多 ${RATE_LIMIT} 次），请稍后再试。`,
        '先整理已有结果，或等一分钟后再搜索。'
      )
    }
    this.requests.push(now)
  }

  private cacheGet(key: string): WebSearchResponse | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return null
    }
    return { ...entry.response, cached: true }
  }

  private cacheSet(key: string, response: WebSearchResponse): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL_MS })
  }

  async search(options: SearchOptions): Promise<WebSearchResponse> {
    const settings = this.getSettings()
    if (!settings.enabled) throw new WebSearchError('联网搜索还没有启用。', '请到设置 → 搜索启用并保存服务商。')
    const query = options.query.trim()
    if (!query) throw new WebSearchError('搜索关键词不能为空。')
    const maxResults = Math.min(10, Math.max(1, Math.round(options.maxResults || settings.maxResults)))
    // 缓存键包含 SearXNG 实例地址：切换实例后不能复用上一个实例的结果
    const baseKey = settings.provider === 'searxng' ? (settings.baseUrl ?? '').toLowerCase() : ''
    const cacheKey = `${settings.provider}:${baseKey}:${maxResults}:${query.toLowerCase()}`
    const cached = this.cacheGet(cacheKey)
    if (cached) return cached
    this.assertRateLimit()

    const startedAt = Date.now()
    const provider = settings.provider
    const key = this.settingsStore.getWebSearchKey()
    if (provider !== 'searxng' && !key) {
      throw new WebSearchError('搜索服务的 API Key 不存在。', '请到设置 → 搜索重新填写并保存 Key。')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (options.signal?.aborted) throw new Error('aborted')
      let response: WebSearchResponse
      if (provider === 'tavily') response = await this.searchTavily(query, maxResults, key!, controller.signal)
      else if (provider === 'brave') response = await this.searchBrave(query, maxResults, key!, controller.signal)
      else if (provider === 'serper') response = await this.searchSerper(query, maxResults, key!, controller.signal)
      else response = await this.searchSearxng(query, maxResults, key, settings.baseUrl!, controller.signal)
      response.elapsedMs = Date.now() - startedAt
      this.cacheSet(cacheKey, response)
      return response
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    provider: string
  ): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetch(url, { ...init, redirect: 'error' })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new WebSearchError(`搜索超时或已取消（${provider}）。`, '可以稍后重试，或缩短关键词。')
      }
      throw new WebSearchError(
        `无法连接 ${provider}：${err instanceof Error ? err.message : String(err)}`,
        '请检查网络或搜索服务配置。'
      )
    }
    if (!response.ok) {
      throw new WebSearchError(
        `${provider} 返回 HTTP ${response.status}。`,
        response.status === 401 || response.status === 403
          ? 'API Key 可能无效或额度用尽，请到设置 → 搜索检查。'
          : '可以稍后重试，或换一个搜索服务商。'
      )
    }
    const text = await this.readBodyCapped(response, provider)
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('not object')
      return parsed as Record<string, unknown>
    } catch {
      throw new WebSearchError(`${provider} 返回了无法解析的响应。`, '请检查服务商是否开启了 JSON 输出。')
    }
  }

  /** 按解压后的字节流读取，超过上限立即取消，避免一次性把超大响应读进内存。 */
  private async readBodyCapped(response: Response, provider: string): Promise<string> {
    const body = response.body
    if (!body) return ''
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new WebSearchError(`${provider} 返回内容过大，已拒绝解析。`)
        }
        chunks.push(value)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }
    if (total === 0) return ''
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8').decode(merged)
  }

  private async searchTavily(
    query: string,
    maxResults: number,
    key: string,
    signal: AbortSignal
  ): Promise<WebSearchResponse> {
    const data = await this.requestJson(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: false
        }),
        signal
      },
      'Tavily'
    )
    const sources = toSources(
      data.results,
      (item) => {
        const url = sanitizeUrl(item.url)
        if (!url) return null
        return {
          rank: 0,
          title: sanitizeText(item.title, 300) || url,
          url,
          snippet: sanitizeText(item.content, 1200),
          ...(sanitizeText(item.published_date, 80) ? { publishedAt: sanitizeText(item.published_date, 80) } : {})
        }
      },
      maxResults
    )
    return {
      query,
      provider: PROVIDER_LABEL.tavily,
      sources,
      ...(sanitizeText(data.answer, 2000) ? { answer: sanitizeText(data.answer, 2000) } : {}),
      elapsedMs: 0
    }
  }

  private async searchBrave(
    query: string,
    maxResults: number,
    key: string,
    signal: AbortSignal
  ): Promise<WebSearchResponse> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(maxResults))
    url.searchParams.set('safesearch', 'moderate')
    const data = await this.requestJson(
      url.toString(),
      {
        headers: { accept: 'application/json', 'x-subscription-token': key },
        signal
      },
      'Brave Search'
    )
    const web = data.web && typeof data.web === 'object' ? (data.web as Record<string, unknown>) : {}
    const sources = toSources(
      web.results,
      (item) => {
        const url = sanitizeUrl(item.url)
        if (!url) return null
        return {
          rank: 0,
          title: sanitizeText(item.title, 300) || url,
          url,
          snippet: sanitizeText(item.description, 1200),
          ...(sanitizeText(item.age, 80) ? { publishedAt: sanitizeText(item.age, 80) } : {})
        }
      },
      maxResults
    )
    return { query, provider: PROVIDER_LABEL.brave, sources, elapsedMs: 0 }
  }

  private async searchSerper(
    query: string,
    maxResults: number,
    key: string,
    signal: AbortSignal
  ): Promise<WebSearchResponse> {
    const data = await this.requestJson(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal
      },
      'Serper'
    )
    const sources = toSources(
      data.organic,
      (item) => {
        const url = sanitizeUrl(item.link)
        if (!url) return null
        return {
          rank: 0,
          title: sanitizeText(item.title, 300) || url,
          url,
          snippet: sanitizeText(item.snippet, 1200),
          ...(sanitizeText(item.date, 80) ? { publishedAt: sanitizeText(item.date, 80) } : {})
        }
      },
      maxResults
    )
    return {
      query,
      provider: PROVIDER_LABEL.serper,
      sources,
      ...(sanitizeText(data.answerBox && (data.answerBox as Record<string, unknown>).answer, 2000)
        ? { answer: sanitizeText((data.answerBox as Record<string, unknown>).answer, 2000) }
        : {}),
      elapsedMs: 0
    }
  }

  private async searchSearxng(
    query: string,
    maxResults: number,
    key: string | null,
    baseUrl: string,
    signal: AbortSignal
  ): Promise<WebSearchResponse> {
    const base = baseUrl.replace(/\/+$/, '')
    const endpoint = /\/search$/i.test(base) ? base : `${base}/search`
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new WebSearchError('SearXNG 实例地址不合法。', '请到设置 → 搜索检查实例地址。')
    }
    // 加载自磁盘的旧配置也要在运行时再校验，阻止 file://、凭据或查询串改变请求路径
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new WebSearchError('SearXNG 实例地址不合法。', '请到设置 → 搜索填写不带账号、查询参数或片段的 http(s) 地址。')
    }
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', 'zh-CN')
    url.searchParams.set('safesearch', '1')
    const data = await this.requestJson(
      url.toString(),
      {
        headers: {
          accept: 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {})
        },
        signal
      },
      'SearXNG'
    )
    const sources = toSources(
      data.results,
      (item) => {
        const url = sanitizeUrl(item.url)
        if (!url) return null
        return {
          rank: 0,
          title: sanitizeText(item.title, 300) || url,
          url,
          snippet: sanitizeText(item.content, 1200),
          ...(sanitizeText(item.publishedDate, 80) ? { publishedAt: sanitizeText(item.publishedDate, 80) } : {}),
          ...(sanitizeText(item.engine, 60) ? { engine: sanitizeText(item.engine, 60) } : {})
        }
      },
      maxResults
    )
    const answers = Array.isArray(data.answers) ? data.answers.filter((item) => typeof item === 'string') : []
    return {
      query,
      provider: PROVIDER_LABEL.searxng,
      sources,
      ...(answers[0] ? { answer: sanitizeText(answers[0], 2000) } : {}),
      elapsedMs: 0
    }
  }
}

let instance: WebSearchService | null = null
export function getWebSearchService(settingsStore: SettingsStore): WebSearchService {
  if (!instance) instance = new WebSearchService(settingsStore)
  return instance
}
