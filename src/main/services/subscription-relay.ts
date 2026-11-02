/**
 * 订阅线路的本地回环转发器。
 *
 * 适用于上游本身兼容 OpenAI Chat Completions 或 Anthropic Messages、但鉴权头
 * 与端点需要由 Morrow 动态注入的渠道。它只做「鉴权注入 + 401 刷新重试 + 流式透传」，
 * 不改写协议；协议不兼容的渠道（Qoder、Antigravity 等）用各自的专用代理。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const MAX_BODY = 64 * 1024 * 1024
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'] as const
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'request-id', 'x-request-id', 'anthropic-version'] as const

export interface SubscriptionRelayOptions {
  localToken: string
  /** 把 Morrow 收到的 path + query 映射到上游完整 URL。 */
  resolveUpstream: (path: string, search: string) => string
  /** 每次请求调用，返回要注入上游的鉴权与其他头。 */
  getHeaders: () => Promise<Record<string, string>> | Record<string, string>
  /** 上游 401/403 时执行一次刷新，然后重试。 */
  refresh?: () => Promise<void>
  /** 可选的请求体改写（例如模型别名）；返回合法 JSON 字符串。 */
  rewriteBody?: (body: string, path: string) => Promise<string> | string
  /** 可选的 JSON 响应改写（例如上游把结果包在 `{data:...}` 里）。 */
  rewriteJsonResponse?: (body: string) => string
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

export interface SubscriptionRelayHandle {
  port: number
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY) throw new Error('请求体超过 64MB。')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function requestHeaders(req: IncomingMessage, injected: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...injected }
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) headers[name] = value
  }
  return headers
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

export async function startSubscriptionRelay(options: SubscriptionRelayOptions): Promise<SubscriptionRelayHandle> {
  const fetchImpl = options.fetchImpl ?? fetch

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    const authorized = req.headers.authorization === `Bearer ${options.localToken}`
      || req.headers['x-api-key'] === options.localToken
    if (!authorized) {
      sendJson(res, 401, { error: { message: '本地订阅代理令牌无效。' } })
      return
    }
    const rawBody = req.method === 'POST' ? await readBody(req) : ''
    const body = rawBody && options.rewriteBody ? await options.rewriteBody(rawBody, url.pathname) : rawBody
    const upstreamUrl = options.resolveUpstream(url.pathname, url.search)
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    const attempt = async (): Promise<Response> => fetchImpl(upstreamUrl, {
      method: req.method ?? 'GET',
      headers: requestHeaders(req, await options.getHeaders()),
      ...(body ? { body } : {}),
      signal: controller.signal
    })

    let response: Response
    try {
      response = await attempt()
      if ((response.status === 401 || response.status === 403) && options.refresh) {
        await response.body?.cancel().catch(() => undefined)
        await options.refresh()
        response = await attempt()
      }
    } catch (err) {
      if (!res.writableEnded) sendJson(res, 502, { error: { message: err instanceof Error ? err.message : String(err) } })
      return
    }

    if (!response.body || response.status === 204 || response.status === 304) {
      res.writeHead(response.status, responseHeaders(response))
      res.end()
      return
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (options.rewriteJsonResponse && response.ok && contentType.includes('application/json')) {
      const raw = await response.text()
      const next = options.rewriteJsonResponse(raw)
      res.writeHead(response.status, { ...responseHeaders(response), 'content-length': String(Buffer.byteLength(next)) })
      res.end(next)
      return
    }
    res.writeHead(response.status, responseHeaders(response))
    res.flushHeaders()
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
        stream.on('error', reject)
        res.on('close', () => { stream.destroy() })
        stream.pipe(res)
        stream.on('end', resolve)
      })
    } catch {
      if (!res.writableEnded) res.end()
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } })
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: async () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}
