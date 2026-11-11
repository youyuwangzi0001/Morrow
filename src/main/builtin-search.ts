// 内置网页搜索：不依赖模型/厂商的搜索能力，也不需要 API Key。
// 走 web-proxy 的 httpGet（系统代理 + 解压），优先 DuckDuckGo HTML 版、Bing 兜底。
// 解析逻辑保持纯函数，便于离线单测。
import type { WebSearchSource } from '../shared/types'
import { httpGet } from '../core/web-proxy'

export const BUILTIN_SEARCH_TIMEOUT_MS = 9_000

/** DDG 在部分网络需要代理；给主引擎一个率先机会，超时后并行启动备用引擎。 */
const HEDGE_DELAY_MS = 2_500

const MAX_RESULTS = 10

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’'
}

/** 去掉标签并解码常见实体（两套引擎的标题/摘要都用它）。 */
export function decodeSearchHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number(dec)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim()
}

function safeSourceUrl(raw: string, base: string): string {
  if (!raw) return ''
  try {
    const parsed = new URL(raw.replace(/&amp;/gi, '&'), base)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.username || parsed.password) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

/** DuckDuckGo HTML 版把结果包成 /l/?uddg=<urlencoded>，这里还原真实地址。 */
export function unwrapDuckDuckGoUrl(raw: string, base = 'https://duckduckgo.com'): string {
  const decoded = raw.replace(/&amp;/gi, '&').trim()
  if (!decoded) return ''
  let parsed: URL
  try {
    parsed = new URL(decoded, base)
  } catch {
    return ''
  }
  const target = parsed.searchParams.get('uddg')
  if (target) {
    try {
      return decodeURIComponent(target)
    } catch {
      return target
    }
  }
  return parsed.toString()
}

/** Bing 常把结果包成 /ck/a?...&u=a1<base64url> 的跳转链接，这里还原真实地址。 */
export function unwrapBingUrl(raw: string, base = 'https://www.bing.com'): string {
  const decoded = raw.replace(/&amp;/gi, '&').trim()
  if (!decoded) return ''
  let parsed: URL
  try {
    parsed = new URL(decoded, base)
  } catch {
    return ''
  }
  if (/(^|\.)bing\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/ck/')) {
    const encoded = parsed.searchParams.get('u') ?? ''
    if (encoded.startsWith('a1')) {
      try {
        return Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
      } catch {
        return ''
      }
    }
  }
  return parsed.toString()
}

function pushSource(
  sources: WebSearchSource[],
  seen: Set<string>,
  url: string,
  title: string,
  snippet: string
): void {
  if (!url || title === '' || sources.length >= MAX_RESULTS) return
  if (seen.has(url)) return
  seen.add(url)
  sources.push({ rank: sources.length + 1, title: title.slice(0, 300) || url, url, snippet: snippet.slice(0, 1200) })
}

/**
 * 解析 DuckDuckGo HTML 结果页。
 * 只保留 http(s) 外部链接，过滤 DDG 自身域名与广告跳转。
 */
export function parseDuckDuckGoHtml(html: string, maxResults = MAX_RESULTS): WebSearchSource[] {
  if (!html) return []
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.round(maxResults)))
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*results_links/i).slice(1)
  for (const block of blocks) {
    if (sources.length >= limit) break
    const link = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const url = safeSourceUrl(unwrapDuckDuckGoUrl(link[1]), 'https://duckduckgo.com')
    if (!url || /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) continue
    const snippetHtml =
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ??
      /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
      ''
    pushSource(sources, seen, url, decodeSearchHtml(link[2]), decodeSearchHtml(snippetHtml))
  }
  return sources
}

/**
 * 解析 Bing 结果页：每条 b_algo 取标题、链接与摘要。
 * 只保留 http(s) 外部链接，同一 URL 不重复占位。
 */
export function parseBingHtml(html: string, maxResults = MAX_RESULTS): WebSearchSource[] {
  if (!html) return []
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.round(maxResults)))
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const blocks = html.split(/<li class="b_algo"/i).slice(1)
  for (const block of blocks) {
    if (sources.length >= limit) break
    const link = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!link) continue
    const url = safeSourceUrl(unwrapBingUrl(link[1]), 'https://www.bing.com')
    if (!url || /(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue
    const snippetMatch =
      /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    pushSource(sources, seen, url, decodeSearchHtml(link[2]), snippetMatch ? decodeSearchHtml(snippetMatch[1]) : '')
  }
  return sources
}

export class BuiltinSearchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuiltinSearchError'
  }
}

export interface BuiltinSearchInput {
  query: string
  maxResults: number
  signal?: AbortSignal
  /** 测试注入；生产走 httpGet（带系统代理与解压） */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface BuiltinSearchResult {
  sources: WebSearchSource[]
  /** 实际应答的入口（给界面/日志说明用了哪个引擎） */
  engine: string
}

/** 把 httpGet 包成 fetch 形状，让内置搜索复用同一套代理与解压逻辑。 */
function proxyAwareFetch(timeoutMs: number, signal?: AbortSignal): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const result = await httpGet(url, { timeoutMs, ...(signal ? { signal } : {}) })
    return new Response(result.body, {
      status: result.status,
      headers: result.contentType ? { 'content-type': result.contentType } : {}
    })
  }) as typeof fetch
}

interface Engine {
  name: string
  url: (query: string) => string
  parse: (html: string, limit: number) => WebSearchSource[]
}

/**
 * 引擎顺序：DuckDuckGo HTML（中文/英文结果质量稳定，跳转链接可还原）
 * → Bing（DDG 被墙或限流时兜底）。两者都不需要 API Key。
 */
const ENGINES: Engine[] = [
  {
    name: 'DuckDuckGo',
    url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, 400))}`,
    parse: parseDuckDuckGoHtml
  },
  {
    name: 'Bing',
    url: (query) => {
      const url = new URL('https://www.bing.com/search')
      url.searchParams.set('q', query.slice(0, 400))
      url.searchParams.set('form', 'QBLH')
      return url.toString()
    },
    parse: parseBingHtml
  }
]

interface EngineOutcome {
  sources: WebSearchSource[]
  engine: string
  failure?: string
}

async function runEngine(
  engine: Engine,
  query: string,
  limit: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<EngineOutcome> {
  const engineSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetchImpl(engine.url(query), { method: 'GET', signal: engineSignal, redirect: 'follow' })
    if (!response.ok) return { sources: [], engine: engine.name, failure: `${engine.name} 返回 HTTP ${response.status}` }
    const sources = engine.parse(await response.text(), limit)
    if (sources.length === 0) return { sources, engine: engine.name, failure: `${engine.name} 没有可解析的结果` }
    return { sources, engine: engine.name }
  } catch (err) {
    if (signal?.aborted) throw new BuiltinSearchError('搜索已取消。')
    return { sources: [], engine: engine.name, failure: `${engine.name} 请求失败（${err instanceof Error ? err.message : String(err)}）` }
  }
}

/**
 * 依次尝试各引擎，后一个引擎不必等前一个彻底超时：
 * 前一个在 HEDGE_DELAY_MS 内还没给出结果，就把后面的引擎并行拉起来，谁先有结果用谁。
 * 任一引擎拿到结果就返回；全部失败时抛可读错误。
 * 用于「模型原生搜索不可用」时的兜底，保证任何模型都能联网搜索。
 */
export async function builtinWebSearch(input: BuiltinSearchInput): Promise<BuiltinSearchResult> {
  const query = input.query.trim()
  if (!query) throw new BuiltinSearchError('搜索关键词不能为空。')
  const timeoutMs = input.timeoutMs ?? BUILTIN_SEARCH_TIMEOUT_MS
  const fetchImpl = input.fetchImpl ?? proxyAwareFetch(timeoutMs, input.signal)
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.round(input.maxResults)))
  const failures: string[] = []

  return new Promise<BuiltinSearchResult>((resolve, reject) => {
    let settled = false
    let pending = 0
    const timers: Array<ReturnType<typeof setTimeout>> = []

    const finish = (outcome: EngineOutcome): void => {
      if (settled) return
      if (outcome.sources.length > 0) {
        settled = true
        timers.forEach(clearTimeout)
        resolve({ sources: outcome.sources, engine: outcome.engine })
        return
      }
      if (outcome.failure) failures.push(outcome.failure)
      pending -= 1
      if (pending === 0 && !settled) {
        settled = true
        timers.forEach(clearTimeout)
        reject(
          new BuiltinSearchError(
            failures.length > 0 ? `内置搜索没有拿到结果：${failures.join('；')}。` : '内置搜索没有拿到结果。'
          )
        )
      }
    }

    const start = (engine: Engine): void => {
      if (settled) return
      pending += 1
      void runEngine(engine, query, limit, timeoutMs, fetchImpl, input.signal)
        .then(finish)
        .catch((err) => {
          if (settled) return
          settled = true
          reject(err)
        })
    }

    start(ENGINES[0])
    let delay = 0
    for (const engine of ENGINES.slice(1)) {
      delay += HEDGE_DELAY_MS
      const timer = setTimeout(() => start(engine), delay)
      timers.push(timer)
    }
    if (input.signal) {
      const onAbort = (): void => {
        if (settled) return
        settled = true
        timers.forEach(clearTimeout)
        reject(new BuiltinSearchError('搜索已取消。'))
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
