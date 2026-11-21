// 联网搜索域：模型/厂商原生搜索（OpenAI Responses、Anthropic、Gemini、xAI、DeepSeek）与内置多引擎检索（Bing/DuckDuckGo）。
// 原生搜索失败或没有来源时，由内置检索补来源；两者共用同一套 WebSearchSource 契约。
import type { ModelInfo, ProviderConfig, WebSearchResponse, WebSearchSource } from '../shared/types'
import { resolveAnthropicMessagesUrl, resolveChatCompletionsUrl } from '../core/providers'
import { httpGet } from '../core/web-proxy'

// ───── native-search.ts ─────
// 模型/厂商原生联网搜索：OpenAI Responses、Anthropic Messages、Gemini Google Search、xAI Live Search。
// 这里只做“一次搜索请求 → 答案 + 来源”，不启动本地多引擎；不支持的渠道由上层提示用户配置自定义搜索。

export type NativeSearchProtocol = 'openai-responses' | 'anthropic-messages' | 'gemini-grounding' | 'xai-live-search' | 'deepseek-search'

export interface NativeSearchContext {
  config: ProviderConfig
  model: ModelInfo
  apiKey: string | null
}

export class NativeSearchError extends Error {
  readonly unsupported: boolean

  constructor(message: string, unsupported = false) {
    super(message)
    this.name = 'NativeSearchError'
    this.unsupported = unsupported
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function isLocalProvider(config: ProviderConfig): boolean {
  const host = hostOf(config.baseUrl)
  return /^(localhost|127\.|\[?::1\]?)/i.test(host) || /(?:^|\.)local$/i.test(host)
}

/**
 * 供应商/模型是否值得尝试原生搜索；本地服务和 demo 直接排除。
 *
 * 只有明确知道对方提供原生联网搜索端点时才返回协议：官方 OpenAI / Anthropic / Gemini /
 * xAI / DeepSeek，以及模型名明确是 OpenAI 系模型的网关。其他中转站大多没有 /responses
 * 或 web_search 工具，硬试只会白等几十秒再失败——这类渠道直接返回 null，
 * 由上层回退到内置网页搜索。
 */
export function nativeSearchProtocol(config: ProviderConfig, model: ModelInfo): NativeSearchProtocol | null {
  if (config.kind === 'demo' || isLocalProvider(config)) return null
  const id = `${config.id} ${model.id}`.toLowerCase()
  const host = hostOf(config.baseUrl)
  if (config.kind === 'anthropic' || /anthropic|claude/.test(id) || host.includes('anthropic.com')) {
    return 'anthropic-messages'
  }
  if (/\bgemini\b/.test(id) || host.includes('generativelanguage.googleapis.com')) {
    return 'gemini-grounding'
  }
  if (/\bxai\b|\bgrok\b/.test(id) || host.includes('api.x.ai')) {
    return 'xai-live-search'
  }
  // DeepSeek 官方把搜索拆成独立 Search API（POST /v1/tools/search）；
  // 但同一批模型跑在第三方中转上时没有这个端点，只能走内置搜索。
  if (host === 'api.deepseek.com') return 'deepseek-search'
  if (/deepseek/.test(id)) return null
  // OpenAI 官方与明确标注 GPT 的网关支持 Responses + web_search。
  if (host === 'api.openai.com' || host.endsWith('.openai.com') || /\bgpt-|^openai\b|\bopenai\b/.test(id)) {
    return 'openai-responses'
  }
  return null
}

export function nativeSearchSupported(config: ProviderConfig, model: ModelInfo): boolean {
  return nativeSearchProtocol(config, model) !== null
}

function resolveResponsesUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/responses$/.test(url)) return url
  if (/\/chat\/completions$/.test(url)) return url.replace(/\/chat\/completions$/, '/responses')
  if (/\/v1$/.test(url)) return `${url}/responses`
  return `${url}/v1/responses`
}

function resolveGeminiBase(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/v1beta\/openai$/i.test(url)) return url.replace(/\/openai$/i, '')
  if (/\/v1beta$/i.test(url)) return url
  return 'https://generativelanguage.googleapis.com/v1beta'
}

function resolveDeepSeekSearchUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/tools\/search$/i.test(url)) return url
  if (/\/chat\/completions$/i.test(url)) url = url.replace(/\/chat\/completions$/i, '')
  if (/\/anthropic(?:\/v1)?(?:\/messages)?$/i.test(url)) url = url.replace(/\/anthropic(?:\/v1)?(?:\/messages)?$/i, '')
  if (/\/v1$/i.test(url)) return `${url}/tools/search`
  return `${url}/v1/tools/search`
}

function sourceUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim().replace(/[)\]}>，。；;]+$/, '') : ''
  if (!/^https?:\/\//i.test(url)) return ''
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return ''
    parsed.hash = parsed.hash.replace(/^#?ws_call_id=.*$/i, '')
    return parsed.toString()
  } catch {
    return ''
  }
}

/** 从回答正文里提取 Markdown/裸链接，仅在有真实搜索调用时作为来源补充。 */
function answerSources(answer: string): Array<{ url: string; title: string }> {
  const found: Array<{ url: string; title: string }> = []
  const seen = new Set<string>()
  const push = (raw: string, title?: string): void => {
    const url = sourceUrl(raw)
    if (!url || seen.has(url)) return
    seen.add(url)
    found.push({ url, title: title?.trim() || url })
  }
  const markdown = /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g
  for (const match of answer.matchAll(markdown)) push(match[2]!, match[1])
  const bare = /https?:\/\/[^\s<>"'）)，。；]+/g
  for (const match of answer.matchAll(bare)) push(match[0])
  return found
}

function mergeAnswerSources(answer: string, sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set(sources.map((source) => source.url))
  for (const item of answerSources(answer)) {
    if (sources.length >= 20) break
    if (seen.has(item.url)) continue
    seen.add(item.url)
    sources.push({ rank: sources.length + 1, title: item.title.slice(0, 300), url: item.url, snippet: '' })
  }
  return sources
}

function pushSourceNative(target: WebSearchSource[], seen: Set<string>, url: unknown, title?: unknown, snippet?: unknown): void {
  const normalized = sourceUrl(url)
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  target.push({
    rank: target.length + 1,
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : normalized,
    url: normalized,
    snippet: typeof snippet === 'string' ? snippet.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
  })
}

function collectObjectSources(value: unknown, target: WebSearchSource[], seen: Set<string>, depth = 0): void {
  if (!value || depth > 7 || target.length >= 20) return
  if (Array.isArray(value)) {
    for (const item of value) collectObjectSources(item, target, seen, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const row = value as Record<string, unknown>
  const url = row.url ?? row.uri ?? row.link ?? row.source_url
  if (url) {
    const title = row.title ?? row.name ?? row.label
    const snippet = row.snippet ?? row.text ?? row.content ?? row.description ?? row.cited_text
    pushSourceNative(target, seen, url, title, snippet)
  }
  for (const child of Object.values(row)) collectObjectSources(child, target, seen, depth + 1)
}

function parseOpenAiResponse(payload: unknown): { answer: string; sources: WebSearchSource[]; searched: boolean } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const answerParts: string[] = []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  let searched = false
  const outputText = typeof root.output_text === 'string' ? root.output_text : ''
  if (outputText.trim()) answerParts.push(outputText.trim())

  const output = Array.isArray(root.output) ? root.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const content = Array.isArray(row.content) ? row.content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const block = part as Record<string, unknown>
      if (block.type === 'output_text') {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text.trim() && !outputText.includes(text.trim())) answerParts.push(text.trim())
        const annotations = Array.isArray(block.annotations) ? block.annotations : []
        if (annotations.length > 0) searched = true
        for (const annotation of annotations) {
          if (!annotation || typeof annotation !== 'object') continue
          const a = annotation as Record<string, unknown>
          pushSourceNative(sources, seen, a.url, a.title, a.text ?? a.cited_text)
        }
      }
    }
    if (row.type === 'web_search_call') {
      searched = true
      const action = row.action && typeof row.action === 'object' ? row.action as Record<string, unknown> : {}
      if (typeof action.url === 'string') pushSourceNative(sources, seen, action.url, action.title)
      collectObjectSources(action.sources ?? row.results ?? row.sources, sources, seen)
    }
  }
  if (sources.length === 0) {
    collectObjectSources(root.citations ?? root.sources, sources, seen)
  }
  // 兼容极少数网关把 Responses 风格请求回成 Chat Completions 形状。
  if (answerParts.length === 0 && Array.isArray(root.choices)) {
    const message = (root.choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined
    if (typeof message?.content === 'string') answerParts.push(message.content)
    collectObjectSources(root.citations, sources, seen)
    if (sources.length > 0) searched = true
  }
  const answer = answerParts.join('\n\n').trim()
  return { answer, sources: searched ? mergeAnswerSources(answer, sources) : sources, searched }
}

function parseAnthropicResponse(payload: unknown): { answer: string; sources: WebSearchSource[]; searched: boolean } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const content = Array.isArray(root.content) ? root.content : []
  const answerParts: string[] = []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  let searched = false
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (row.type === 'text' && typeof row.text === 'string') {
      if (row.text.trim()) answerParts.push(row.text.trim())
      const citations = Array.isArray(row.citations) ? row.citations : []
      if (citations.length > 0) searched = true
      for (const citation of citations) {
        if (!citation || typeof citation !== 'object') continue
        const c = citation as Record<string, unknown>
        pushSourceNative(sources, seen, c.url, c.title, c.cited_text ?? c.text)
      }
    } else if (row.type === 'web_search_tool_result') {
      searched = true
      collectObjectSources(row.content, sources, seen)
    } else if (row.type === 'server_tool_use' && /web_search/i.test(String(row.name ?? ''))) {
      searched = true
    }
  }
  if (sources.length === 0) collectObjectSources(root.citations, sources, seen)
  const answer = answerParts.join('\n\n').trim()
  return { answer, sources: searched ? mergeAnswerSources(answer, sources) : sources, searched }
}

function parseGeminiResponse(payload: unknown): { answer: string; sources: WebSearchSource[]; searched: boolean } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const candidates = Array.isArray(root.candidates) ? root.candidates : []
  const candidate = (candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : {}) as Record<string, unknown>
  const content = candidate.content && typeof candidate.content === 'object' ? candidate.content as Record<string, unknown> : {}
  const parts = Array.isArray(content.parts) ? content.parts : []
  const answerParts: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (typeof p.text === 'string' && p.text.trim()) answerParts.push(p.text.trim())
  }
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const metadata = candidate.groundingMetadata && typeof candidate.groundingMetadata === 'object'
    ? candidate.groundingMetadata as Record<string, unknown>
    : {}
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue
    const web = (chunk as Record<string, unknown>).web
    if (web && typeof web === 'object') {
      const w = web as Record<string, unknown>
      pushSourceNative(sources, seen, w.uri, w.title)
    }
  }
  const queries = Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : []
  const searched = chunks.length > 0 || queries.length > 0
  const answer = answerParts.join('\n\n').trim()
  return { answer, sources: searched ? mergeAnswerSources(answer, sources) : sources, searched }
}

function parseXaiResponse(payload: unknown): { answer: string; sources: WebSearchSource[]; searched: boolean } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = (choices[0] && typeof choices[0] === 'object' ? choices[0] : {}) as Record<string, unknown>
  const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {}
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  collectObjectSources(root.citations ?? message.citations, sources, seen)
  const answer = typeof message.content === 'string' ? message.content.trim() : ''
  const searched = sources.length > 0
  return { answer, sources: searched ? mergeAnswerSources(answer, sources) : sources, searched }
}

function parseDeepSeekSearchResponse(
  payload: unknown,
  maxResults: number
): { answer: string; sources: WebSearchSource[]; searched: boolean } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rows = Array.isArray(root.results) ? root.results : []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (sources.length >= Math.max(1, Math.min(50, maxResults))) break
    const item = row as Record<string, unknown>
    const summary = typeof item.summary === 'string' && item.summary.trim()
      ? item.summary
      : typeof item.snippet === 'string' ? item.snippet : ''
    const site = typeof item.site_name === 'string' && item.site_name.trim() ? item.site_name.trim() : ''
    const date = typeof item.date === 'string' ? item.date.slice(0, 10) : ''
    const meta = [site, date].filter(Boolean).join(' · ')
    const snippet = [meta, summary.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' — ')
    pushSourceNative(sources, seen, item.url, item.title, snippet)
  }
  return { answer: '', sources, searched: true }
}

async function readTextCapped(response: Response): Promise<string> {
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
      if (total > 4 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined)
        throw new NativeSearchError('原生搜索返回内容过大，已拒绝解析。')
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

function responseMessage(status: number, body: string): string {
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (status === 401 || status === 403) return `当前模型的 API Key 无效或没有联网搜索权限（HTTP ${status}）。`
  if (status === 402) return '当前模型账号余额不足，无法执行联网搜索（HTTP 402）。'
  if (status === 404) return `当前模型/渠道没有原生联网搜索端点（HTTP 404）。`
  if (status === 429) return '当前模型限流或额度不足，暂时无法联网搜索。'
  if (status >= 500) return `当前模型服务暂时不可用（HTTP ${status}）。`
  return `原生搜索请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`
}

function isUnsupportedStatus(status: number, body: string): boolean {
  if (status === 404) return true
  if (status !== 400 && status !== 422) return false
  return /web_search|web search|unknown tool|unsupported|not supported|invalid tool|tool.*not/i.test(body)
}

export async function nativeSearch(
  input: NativeSearchContext & {
    query: string
    maxResults: number
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  }
): Promise<WebSearchResponse> {
  const protocol = nativeSearchProtocol(input.config, input.model)
  if (!protocol) throw new NativeSearchError('当前模型或渠道不支持原生联网搜索。', true)
  const query = input.query.trim()
  if (!query) throw new NativeSearchError('搜索关键词不能为空。')
  const prompt = `请使用联网搜索回答下面的问题。只基于搜索结果，给出简洁、可核对的中文结论，并保留来源链接。\n\n问题：${query}`
  const fetchImpl = input.fetchImpl ?? fetch
  // 与上一层（WebSearchService）保持同一上限：这里再收紧会把慢但成功的搜索截断。
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(45_000)])
    : AbortSignal.timeout(45_000)
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  let url = ''
  let body: Record<string, unknown> = {}
  let parse = parseOpenAiResponse

  if (protocol === 'anthropic-messages') {
    if (!input.apiKey) throw new NativeSearchError('当前 Anthropic 渠道没有 API Key，无法使用原生搜索。', true)
    url = resolveAnthropicMessagesUrl(input.config.baseUrl)
    headers['x-api-key'] = input.apiKey
    headers['anthropic-version'] = '2023-06-01'
    body = {
      model: input.model.id,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.max(1, Math.min(5, input.maxResults)) }]
    }
    parse = parseAnthropicResponse
  } else if (protocol === 'gemini-grounding') {
    if (!input.apiKey) throw new NativeSearchError('当前 Gemini 渠道没有 API Key，无法使用原生搜索。', true)
    url = `${resolveGeminiBase(input.config.baseUrl)}/models/${encodeURIComponent(input.model.id)}:generateContent`
    headers['x-goog-api-key'] = input.apiKey
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    }
    parse = parseGeminiResponse
  } else if (protocol === 'xai-live-search') {
    if (!input.apiKey) throw new NativeSearchError('当前 xAI 渠道没有 API Key，无法使用原生搜索。', true)
    url = resolveChatCompletionsUrl(input.config.baseUrl)
    headers.authorization = `Bearer ${input.apiKey}`
    body = {
      model: input.model.id,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      search_parameters: {
        mode: 'on',
        return_citations: true,
        max_search_results: Math.max(1, Math.min(20, input.maxResults))
      }
    }
    parse = parseXaiResponse
  } else if (protocol === 'deepseek-search') {
    if (!input.apiKey) throw new NativeSearchError('当前 DeepSeek 渠道没有 API Key，无法使用联网搜索。', true)
    url = resolveDeepSeekSearchUrl(input.config.baseUrl)
    headers.authorization = `Bearer ${input.apiKey}`
    body = {
      query: query.slice(0, 128),
      count: Math.max(1, Math.min(50, input.maxResults)),
      need_content: false
    }
    parse = (payload) => parseDeepSeekSearchResponse(payload, input.maxResults)
  } else {
    url = resolveResponsesUrl(input.config.baseUrl)
    if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`
    body = {
      model: input.model.id,
      input: prompt,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      store: false
    }
    parse = parseOpenAiResponse
  }

  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: 'error'
    })
  } catch (err) {
    // AbortSignal.timeout 抛的是 TimeoutError，之前只认 AbortError，
    // 超时被当成「无法连接」，用户看到的提示与真实原因不符。
    const name = (err as Error)?.name
    if (name === 'AbortError' || name === 'TimeoutError' || signal.aborted) {
      throw new NativeSearchError('原生搜索超时或已取消。')
    }
    throw new NativeSearchError(`无法连接模型服务进行原生搜索：${err instanceof Error ? err.message : String(err)}`)
  }
  const raw = await readTextCapped(response).catch(() => '')
  if (!response.ok) {
    if (isUnsupportedStatus(response.status, raw)) {
      throw new NativeSearchError('当前模型/渠道不支持原生联网搜索。', true)
    }
    throw new NativeSearchError(responseMessage(response.status, raw))
  }
  let parsed: { answer: string; sources: WebSearchSource[]; searched: boolean }
  try {
    parsed = parse(JSON.parse(raw) as unknown)
  } catch (err) {
    if (err instanceof NativeSearchError) throw err
    throw new NativeSearchError('原生搜索返回了无法解析的响应。')
  }
  if (!parsed.searched) {
    throw new NativeSearchError(
      '当前模型没有真正执行联网搜索（模型没有调用 web_search 工具）。',
      true
    )
  }
  return {
    query,
    provider: protocol === 'deepseek-search' ? 'DeepSeek 搜索' : '模型原生搜索',
    sources: parsed.sources.slice(0, Math.max(1, Math.min(20, input.maxResults))),
    ...(parsed.answer ? { answer: parsed.answer } : {}),
    elapsedMs: Date.now() - startedAt
  }
}

// ───── builtin-search.ts ─────
// 内置网页搜索：不依赖模型/厂商的搜索能力，也不需要 API Key。
// 走 web-proxy 的 httpGet（系统代理 + 解压），优先 DuckDuckGo HTML 版、Bing 兜底。
// 解析逻辑保持纯函数，便于离线单测。

export const BUILTIN_SEARCH_TIMEOUT_MS = 6_000

/** DDG 在部分网络需要代理；给主引擎一个率先机会，超时后并行启动备用引擎。 */
const HEDGE_DELAY_MS = 1_500

const MAX_RESULTS = 10

/** 查询里的停用词不参与相关性判断，避免“如何/最新/the”把垃圾结果判成相关。 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  '如何',
  '怎么',
  '怎样',
  '什么',
  '哪些',
  '哪个',
  '为什么',
  '是否',
  '可以',
  '以及',
  '最新',
  '现在',
  '目前'
])

/**
 * 把查询拆成用于相关性核对的关键词。
 * - 拉丁词按词边界匹配，避免 `morrow` 命中 `tomorrow`；
 * - 中文没有空格，按连续汉字的二元组匹配（“智能体” → “智能”“能体”）；
 * - 去掉常见停用词，最多 12 个，避免长句把所有结果都判成相关。
 */
export function searchQueryTerms(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/["'“”‘’]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const terms = new Set<string>()
  for (const word of normalized.split(/\s+/)) {
    if (word.length < 2 || STOP_WORDS.has(word)) continue
    terms.add(word)
  }
  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!STOP_WORDS.has(bigram)) terms.add(bigram)
    }
  }
  return [...terms].slice(0, 12)
}

function matchesTerm(haystack: string, term: string): boolean {
  if (!haystack.includes(term)) return false
  // 拉丁词要求完整词边界；“morrow” 不能因为出现在 “tomorrow” 里就算命中。
  if (/^[a-z0-9]+$/i.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
  }
  return true
}

/**
 * 按查询相关性排序并过滤明显无关的结果。
 * Bing 在部分网络会返回与查询完全无关的缓存结果；只数“有没有结果”会把
 * 座头鲸/学习通当成 “Morrow AI agent” 的搜索结果。这里要求标题或摘要至少
 * 命中一个查询关键词，全都不命中时返回空数组，让上层明确报告失败。
 */
export function rankSearchSources(
  sources: WebSearchSource[],
  query: string,
  limit = MAX_RESULTS
): WebSearchSource[] {
  const terms = searchQueryTerms(query)
  if (terms.length === 0) return sources.slice(0, limit)
  const scored = sources.map((source) => {
    const haystack = `${source.title} ${source.snippet}`.toLowerCase()
    const score = terms.reduce((count, term) => count + (matchesTerm(haystack, term) ? 1 : 0), 0)
    return { source, score }
  })
  // 多词查询至少命中两个不同关键词。否则 “TypeScript 5.7 release notes”
  // 会被只提到 TypeScript 的泛教程占满，看起来有结果、实际答非所问。
  const required = terms.length >= 2 ? 2 : 1
  const relevant = scored.filter((item) => item.score >= required)
  relevant.sort((a, b) => b.score - a.score || a.source.rank - b.source.rank)
  return relevant.slice(0, Math.max(1, Math.min(MAX_RESULTS, Math.round(limit)))).map((item, index) => ({
    ...item.source,
    rank: index + 1
  }))
}

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
    const parsed = engine.parse(await response.text(), limit)
    const sources = rankSearchSources(parsed, query, limit)
    if (sources.length === 0) {
      return {
        sources,
        engine: engine.name,
        failure:
          parsed.length > 0
            ? `${engine.name} 返回的 ${parsed.length} 条结果与查询无关`
            : `${engine.name} 没有可解析的结果`
      }
    }
    return { sources, engine: engine.name }
  } catch (err) {
    if (signal?.aborted) throw new BuiltinSearchError('搜索已取消。')
    if (engineSignal.aborted) {
      return { sources: [], engine: engine.name, failure: `${engine.name} 请求超时（${timeoutMs}ms）` }
    }
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
            failures.length > 0
              ? `内置搜索没有拿到结果：${failures.join('；')}。如果经常超时或结果与需求不符，请在设置 → 联网搜索配置 Tavily / Brave / Serper / SearXNG。`
              : '内置搜索没有拿到结果。'
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
