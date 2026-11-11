// 出站网页请求的统一入口：系统代理、浏览器请求头、重定向与压缩解码。
//
// 主进程的 node http/https 不读 Windows 系统代理（只有 Chromium 网络栈会读），
// 于是会出现「浏览器能打开、Morrow 打不开」。这里把代理探测做成可注入：主进程用
// Electron 的 session.resolveProxy 注入（支持 PAC），未注入时退回环境变量与注册表。
// 代理隧道自己用 CONNECT 实现，不引入额外依赖。
import type { Agent as HttpAgent } from 'node:http'
import { Agent as NodeHttpAgent, request as httpRequest } from 'node:http'
import { Agent as NodeHttpsAgent, request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

const execFileAsync = promisify(execFile)

/** 真实浏览器 UA：MSI、技嘉、知乎等站点对非浏览器 UA 会直接返回 403。 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'

/** 与浏览器一致的请求头集合；extra 覆盖同名项。 */
export function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: BROWSER_ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Ch-Ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    ...extra
  }
}

/* ── 代理规则 ─────────────────────────────────────────────────── */

export interface ProxyEndpoint {
  host: string
  port: number
  auth?: string
}

export type ProxyRule = { type: 'direct' } | { type: 'proxy'; endpoint: ProxyEndpoint } | { type: 'unsupported'; detail: string }

function parseEndpoint(raw: string): ProxyEndpoint | null {
  const text = raw.trim().replace(/^(?:https?|socks[45]?):\/\//i, '').replace(/\/$/, '')
  if (!text) return null
  let auth: string | undefined
  let hostPort = text
  const at = text.lastIndexOf('@')
  if (at >= 0) {
    const decoded = decodeURIComponent(text.slice(0, at))
    hostPort = text.slice(at + 1)
    auth = `Basic ${Buffer.from(decoded).toString('base64')}`
  }
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort)
  const match = ipv6 ? null : /^(?:[a-z][a-z0-9+.-]*=)?([^:]+?)(?::(\d+))?$/i.exec(hostPort)
  const host = ipv6 ? ipv6[1] : match?.[1]
  const portText = ipv6 ? ipv6[2] : match?.[2]
  if (!host) return null
  const port = Number(portText ?? 80)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: host.toLowerCase(), port, ...(auth ? { auth } : {}) }
}

/** 解析 Electron `session.resolveProxy` 的返回值，例如 `PROXY 127.0.0.1:7890; DIRECT`。 */
export function parseProxyRule(raw: string): ProxyRule {
  const text = (raw ?? '').trim()
  if (!text) return { type: 'direct' }
  let unsupported: ProxyRule | null = null
  for (const part of text.split(';').map((item) => item.trim()).filter(Boolean)) {
    // 裸 DIRECT / REJECT 不带参数，必须在按空格拆分之前识别
    if (/^(DIRECT|REJECT)$/i.test(part)) return { type: 'direct' }
    const rule = /^([A-Za-z][A-Za-z0-9-]*)\s+(.+)$/.exec(part)
    if (!rule) {
      const endpoint = parseEndpoint(part)
      if (endpoint) return { type: 'proxy', endpoint }
      continue
    }
    const kind = rule[1].toUpperCase()
    if (kind === 'PROXY' || kind === 'HTTPS') {
      const endpoint = parseEndpoint(rule[2])
      if (endpoint) return { type: 'proxy', endpoint }
      continue
    }
    if (kind.startsWith('SOCKS')) {
      // 没有 socks 实现时不能静默直连（会连到错误的地方），显式说明。
      unsupported ??= { type: 'unsupported', detail: `仅支持 HTTP 代理，当前系统代理是 ${part}。` }
    }
  }
  return unsupported ?? { type: 'direct' }
}

function hostMatchesNoProxy(hostname: string, noProxy: string): boolean {
  const host = hostname.toLowerCase()
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    const suffix = entry.replace(/:\d+$/, '').replace(/^\*?\./, '')
    if (suffix && (host === suffix || host.endsWith(`.${suffix}`))) return true
  }
  return false
}

function envProxyRule(target: URL): ProxyRule | null {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ''
  if (noProxy && hostMatchesNoProxy(target.hostname, noProxy)) return { type: 'direct' }
  const candidates =
    target.protocol === 'https:'
      ? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.ALL_PROXY, process.env.all_proxy, process.env.HTTP_PROXY, process.env.http_proxy]
      : [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy]
  for (const candidate of candidates) {
    const raw = candidate?.trim()
    if (!raw) continue
    if (/^socks/i.test(raw)) return { type: 'unsupported', detail: '仅支持 HTTP 代理，环境变量里配置的是 SOCKS 代理。' }
    const endpoint = parseEndpoint(raw)
    if (endpoint) return { type: 'proxy', endpoint }
  }
  return null
}

let windowsProxyCache: { at: number; rule: ProxyRule | null } | null = null
const WINDOWS_PROXY_TTL_MS = 60_000

/** 读取 Windows「Internet 选项」的全局代理；双击启动的打包版拿不到终端环境变量。 */
async function windowsProxyRule(): Promise<ProxyRule | null> {
  if (process.platform !== 'win32') return null
  if (windowsProxyCache && Date.now() - windowsProxyCache.at < WINDOWS_PROXY_TTL_MS) return windowsProxyCache.rule
  let rule: ProxyRule | null = null
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { timeout: 4_000, windowsHide: true }
    )
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1] ?? ''
    const autoConfig = /AutoConfigURL\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1] ?? ''
    if (enabled && server) {
      // `http=127.0.0.1:7890;https=127.0.0.1:7890` 这种按协议分段的写法优先取 https
      const segments = server.split(';').map((item) => item.trim()).filter(Boolean)
      const pick = segments.find((item) => /^https=/i.test(item)) ?? segments[0]
      const endpoint = parseEndpoint(pick.replace(/^[a-z]+=/i, ''))
      if (endpoint) rule = { type: 'proxy', endpoint }
    } else if (enabled && autoConfig) {
      rule = { type: 'unsupported', detail: '系统代理使用 PAC 脚本，Node 侧无法直接解析；请在系统代理里改用固定 HTTP 代理。' }
    }
  } catch {
    rule = null
  }
  windowsProxyCache = { at: Date.now(), rule }
  return rule
}

export type SystemProxyResolver = (url: string) => Promise<string | null>
let injectedResolver: SystemProxyResolver | null = null

/** 主进程注入 Electron resolveProxy（支持 PAC 与系统策略），优先于环境变量。 */
export function setSystemProxyResolver(resolver: SystemProxyResolver | null): void {
  injectedResolver = resolver
  windowsProxyCache = null
}

/** 解析目标地址该走哪个代理：Electron 注入 → 环境变量 → Windows 注册表。 */
export async function resolveProxyFor(rawUrl: string): Promise<ProxyRule> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return { type: 'direct' }
  }
  if (injectedResolver) {
    try {
      const raw = await injectedResolver(target.toString())
      if (raw) return parseProxyRule(raw)
    } catch {
      // 注入实现不可用时继续走本地探测
    }
  }
  return envProxyRule(target) ?? (await windowsProxyRule()) ?? { type: 'direct' }
}

/* ── 代理隧道 Agent（CONNECT） ────────────────────────────────── */

function tunnel(endpoint: ProxyEndpoint, options: { host: string; port: number }, secure: boolean, callback: (err: Error | null, socket?: Socket) => void): void {
  const authHeaders = endpoint.auth
    ? { 'Proxy-Authorization': endpoint.auth, 'Proxy-Connection': 'keep-alive', Host: `${options.host}:${options.port}` }
    : { 'Proxy-Connection': 'keep-alive', Host: `${options.host}:${options.port}` }
  const request = httpRequest({
    host: endpoint.host,
    port: endpoint.port,
    method: 'CONNECT',
    path: `${options.host}:${options.port}`,
    headers: authHeaders,
    timeout: 15_000
  })
  request.once('connect', (response, socket) => {
    if (response.statusCode !== 200) {
      socket.destroy()
      callback(new Error(`代理拒绝建立隧道（HTTP ${response.statusCode}）`))
      return
    }
    if (!secure) {
      callback(null, socket)
      return
    }
    const tls = tlsConnect({ socket, servername: options.host }, () => {
      callback(null, tls)
    })
    tls.once('error', (err) => {
      tls.destroy()
      callback(err)
    })
  })
  request.once('timeout', () => {
    request.destroy(proxyUnavailableError(endpoint, '连接代理超时'))
  })
  request.once('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    // 连不上代理本身（客户端没开、端口变了）不是目标站的问题：
    // 标记成可识别的错误，让上层立刻改走直连，而不是让用户以为网页打不开。
    if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE/i.test(code)) {
      callback(proxyUnavailableError(endpoint, err.message))
      return
    }
    callback(err)
  })
  request.end()
}

const PROXY_UNAVAILABLE_CODE = 'MORROW_PROXY_UNAVAILABLE'

function proxyUnavailableError(endpoint: ProxyEndpoint, detail: string): Error {
  const error = new Error(`系统代理 ${endpoint.host}:${endpoint.port} 不可用（${detail}）`) as NodeJS.ErrnoException
  error.code = PROXY_UNAVAILABLE_CODE
  return error
}

/** 判断是不是「代理本身连不上」，用于自动改走直连。 */
export function isProxyUnavailableError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === PROXY_UNAVAILABLE_CODE)
}

/** 代理不可达后的冷却：这段时间内直接走直连，避免每个请求都先撞一次超时。 */
const proxyCooldown = new Map<string, number>()
const PROXY_COOLDOWN_MS = 60_000

function proxyKey(endpoint: ProxyEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`
}

function markProxyUnavailable(endpoint: ProxyEndpoint): void {
  proxyCooldown.set(proxyKey(endpoint), Date.now() + PROXY_COOLDOWN_MS)
  agentCache.delete(proxyKey(endpoint))
}

function proxyCoolingDown(endpoint: ProxyEndpoint): boolean {
  const until = proxyCooldown.get(proxyKey(endpoint))
  if (!until) return false
  if (until <= Date.now()) {
    proxyCooldown.delete(proxyKey(endpoint))
    return false
  }
  return true
}

function createTunnelAgent(endpoint: ProxyEndpoint, secure: boolean): HttpAgent {
  const Base = secure ? NodeHttpsAgent : NodeHttpAgent
  const agent = new Base({ keepAlive: false })
  ;(agent as unknown as { createConnection: unknown }).createConnection = (
    options: { host?: string; port?: number },
    callback: (err: Error | null, socket?: Socket) => void
  ): void => {
    const host = options.host ?? ''
    const port = Number(options.port ?? (secure ? 443 : 80))
    if (!host) {
      callback(new Error('缺少目标主机'))
      return
    }
    tunnel(endpoint, { host, port }, secure, callback)
  }
  return agent
}

const agentCache = new Map<string, { http: HttpAgent; https: HttpAgent }>()

function proxyAgents(endpoint: ProxyEndpoint): { http: HttpAgent; https: HttpAgent } {
  const key = `${endpoint.host}:${endpoint.port}:${endpoint.auth ?? ''}`
  const cached = agentCache.get(key)
  if (cached) return cached
  if (agentCache.size >= 8) agentCache.clear()
  const created = { http: createTunnelAgent(endpoint, false), https: createTunnelAgent(endpoint, true) }
  agentCache.set(key, created)
  return created
}

export interface OutboundAgentSelection {
  agent?: HttpAgent
  /** 走代理时由代理侧解析 DNS，不再注入本地 lookup */
  note?: string
}

/** 为某个 URL 选出代理 Agent；DIRECT 或 SOCKS 时返回 undefined（SOCKS 记 note 供报错）。 */
export async function agentForUrl(rawUrl: string): Promise<OutboundAgentSelection> {
  const rule = await resolveProxyFor(rawUrl)
  if (rule.type === 'proxy') {
    // 代理刚被判定不可用（客户端没开、端口变了）：冷却期内直接走直连
    if (proxyCoolingDown(rule.endpoint)) {
      return { note: `系统代理 ${rule.endpoint.host}:${rule.endpoint.port} 不可用，已临时改走直连。` }
    }
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return {}
    }
    const agents = proxyAgents(rule.endpoint)
    return { agent: parsed.protocol === 'https:' ? agents.https : agents.http }
  }
  if (rule.type === 'unsupported') return { note: rule.detail }
  return {}
}

/**
 * 代理连不上时立刻改走直连重试一次，并让后续请求在冷却期内直连。
 * 只看「代理本身不可达」，目标站自己的错误（403/404/超时）保持原样。
 */
export async function attemptWithDirectFallback<T>(
  attempt: () => Promise<T>,
  direct: () => Promise<T>,
  rawUrl: string
): Promise<T> {
  try {
    return await attempt()
  } catch (err) {
    if (!isProxyUnavailableError(err)) throw err
    const rule = await resolveProxyFor(rawUrl)
    if (rule.type === 'proxy') markProxyUnavailable(rule.endpoint)
    return direct()
  }
}

/* ── 解压与 GET ───────────────────────────────────────────────── */

/** 按 Content-Encoding 解压；identity 或未知编码原样返回。 */
export async function decodeContentEncoding(body: Buffer, contentEncoding: string): Promise<Buffer> {
  if (!body.length) return body
  const encoding = (contentEncoding ?? '').toLowerCase().split(',').pop()?.trim() ?? ''
  const stream =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'br'
        ? createBrotliDecompress()
        : encoding === 'deflate'
          ? createInflate()
          : null
  if (!stream) return body
  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    // 解压失败说明站点返回的编码与声明不符：退回原文，交给上层判断可读性
    stream.on('error', () => resolve(body))
    stream.end(body)
  })
}

export interface HttpGetOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

export interface HttpGetResult {
  status: number
  finalUrl: string
  contentType: string
  body: Buffer
  truncated: boolean
  elapsedMs: number
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const GET_TIMEOUT_MS = 20_000
const GET_MAX_BYTES = 2 * 1024 * 1024
const GET_MAX_REDIRECTS = 5

function getOnce(
  target: URL,
  headers: Record<string, string>,
  agent: HttpAgent | undefined,
  remainingMs: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ status: number; location: string; body: Buffer; truncated: boolean; contentType: string }> {
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = transport(
      target,
      {
        method: 'GET',
        headers,
        ...(agent ? { agent } : {}),
        ...(signal ? { signal } : {})
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = typeof response.headers.location === 'string' ? response.headers.location : ''
        const contentType = String(response.headers['content-type'] ?? '')
        if (REDIRECT_CODES.has(status)) {
          response.resume()
          resolve({ status, location, body: Buffer.alloc(0), truncated: false, contentType })
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        let truncated = false
        const finish = (): void => {
          void decodeContentEncoding(Buffer.concat(chunks), String(response.headers['content-encoding'] ?? '')).then((body) =>
            resolve({ status, location, body, truncated, contentType })
          )
        }
        response.on('data', (chunk: Buffer) => {
          const remaining = maxBytes - total
          if (chunk.length >= remaining) {
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining))
              total += remaining
            }
            truncated = true
            response.destroy()
            finish()
            return
          }
          chunks.push(chunk)
          total += chunk.length
        })
        response.on('end', finish)
        response.on('error', reject)
      }
    )
    request.on('error', reject)
    request.setTimeout(Math.max(1, remainingMs), () => {
      request.destroy(new Error(`请求超时（${Math.round(remainingMs)}ms）`))
    })
    request.end()
  })
}

/** 跟随重定向的 GET（自动解压）；用于内置搜索等不需要逐跳 SSRF 校验的场景。 */
export async function httpGet(rawUrl: string, options: HttpGetOptions = {}): Promise<HttpGetResult> {
  const startedAt = Date.now()
  const timeoutMs = Math.min(Math.max(1_000, options.timeoutMs ?? GET_TIMEOUT_MS), 60_000)
  const maxBytes = Math.max(1_024, options.maxBytes ?? GET_MAX_BYTES)
  const maxRedirects = Math.max(0, Math.min(10, options.maxRedirects ?? GET_MAX_REDIRECTS))
  const deadline = startedAt + timeoutMs
  const headers = browserHeaders(options.headers)
  let current = new URL(rawUrl)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options.signal?.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' })
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`请求超时（超过 ${timeoutMs}ms）`)
    const selection = await agentForUrl(current.toString())
    const result = await attemptWithDirectFallback(
      () => getOnce(current, headers, selection.agent, Math.max(1, deadline - Date.now()), maxBytes, options.signal),
      () => getOnce(current, headers, undefined, Math.max(1, deadline - Date.now()), maxBytes, options.signal),
      current.toString()
    )
    if (REDIRECT_CODES.has(result.status) && result.location) {
      try {
        current = new URL(result.location, current)
      } catch {
        throw new Error(`返回了无效的重定向地址：${result.location}`)
      }
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('重定向到了非 http(s) 地址，已拒绝。')
      }
      continue
    }
    return {
      status: result.status,
      finalUrl: current.toString(),
      contentType: result.contentType,
      body: result.body,
      truncated: result.truncated,
      elapsedMs: Date.now() - startedAt
    }
  }
  throw new Error(`重定向次数过多（超过 ${maxRedirects} 次）`)
}
