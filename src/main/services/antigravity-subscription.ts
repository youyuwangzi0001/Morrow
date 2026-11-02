/**
 * Google Antigravity 订阅：Google OAuth（PKCE）→ Gemini/Antigravity 专用本地代理。
 * 上游是 Gemini `streamGenerateContent` 信封，不是 OpenAI wire，因此这里做完整翻译；
 * 刷新令牌前先落盘，代理只监听回环地址。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { net } from 'electron'
import type { AgentSubscriptionAccount, AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import {
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_FALLBACK,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PRIMARY,
  ANTIGRAVITY_REDIRECT_PATH,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_URL,
  buildAntigravityRequest,
  isClaudeRuntime,
  parseAntigravityFrame,
  parseAntigravityQuota
} from './antigravity-protocol'
import {
  asNumber,
  asRecord,
  asString,
  errorText,
  getProvider,
  randomLocalToken,
  removeProvider,
  saveLoopbackProvider,
  SecureJsonStore,
  setProviderEnabled,
  testSubscriptionProvider
} from './agent-subscription-common'
import { getSettingsStore } from './settings-store'
import { log } from './logger'
import { openLoginUrl } from './external-open'

const PROVIDER_ID = 'antigravity-subscription'
const QUOTA_CACHE_MS = 2 * 60_000
const REFRESH_MARGIN_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_BODY = 64 * 1024 * 1024

function requireClientSecret(): string {
  if (!ANTIGRAVITY_CLIENT_SECRET) {
    throw new Error('Antigravity 登录需要 Google OAuth client secret；请设置环境变量 MORROW_ANTIGRAVITY_CLIENT_SECRET 后重启 Morrow。')
  }
  return ANTIGRAVITY_CLIENT_SECRET
}

interface AntigravityCredential {
  access: string
  refresh: string
  expiresAt: number
  projectId: string
  account?: AgentSubscriptionAccount
}

function platformName(): string {
  return process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX'
}

function osType(): string {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
}

function clientMetadata(): string {
  return JSON.stringify({ ideType: 'ANTIGRAVITY', platform: platformName(), pluginType: 'GEMINI' })
}

function headersFor(token: string, runtime?: string, accept: 'json' | 'sse' = 'sse'): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: accept === 'json' ? 'application/json' : 'text/event-stream',
    'user-agent': `antigravity/hub/2.23.0 (aidev_client; os_type=${osType()}; arch=${process.arch === 'arm64' ? 'arm64' : 'amd64'}; cl=998057262)`,
    'x-goog-api-client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'client-metadata': clientMetadata(),
    ...(runtime && isClaudeRuntime(runtime) ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {})
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY) {
        reject(new Error('请求体超过 64MB。'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export class AntigravitySubscriptionService {
  private store = new SecureJsonStore<AntigravityCredential>('antigravity-subscription.json')
  private credential: AntigravityCredential | null = this.store.load()
  private proxy: Server | null = null
  private proxyPort: number | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null
  private refreshing: Promise<AntigravityCredential> | null = null

  private persist(credential: AntigravityCredential): AntigravityCredential {
    this.credential = credential
    this.store.save(credential)
    return credential
  }

  private async ensureToken(): Promise<AntigravityCredential> {
    const current = this.credential
    if (!current) throw new Error('还没有登录 Google Antigravity。')
    if (current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current
    return this.refreshToken()
  }

  private async refreshToken(): Promise<AntigravityCredential> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const current = this.credential
      if (!current) throw new Error('还没有登录 Google Antigravity。')
      let response: Response | null = null
      let transient = ''
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const candidate = await net.fetch(ANTIGRAVITY_TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams({
              client_id: ANTIGRAVITY_CLIENT_ID,
              client_secret: requireClientSecret(),
              refresh_token: current.refresh,
              grant_type: 'refresh_token'
            }).toString(),
            signal: AbortSignal.timeout(30_000)
          })
          if (candidate.status === 429 || candidate.status >= 500) {
            transient = `HTTP ${candidate.status}`
            await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
            continue
          }
          response = candidate
          break
        } catch (err) {
          transient = err instanceof Error ? err.message : String(err)
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
        }
      }
      if (!response) throw new Error(`Antigravity 刷新暂时失败：${transient || '网络错误'}，请稍后重试。`)
      const payload = asRecord(await response.json().catch(() => null))
      if (!response.ok || !payload?.access_token) throw new Error('Antigravity 登录已失效，请重新登录。')
      const expiresIn = asNumber(payload.expires_in) ?? 3_600
      return this.persist({
        ...current,
        access: asString(payload.access_token)!,
        refresh: asString(payload.refresh_token) ?? current.refresh,
        expiresAt: Date.now() + expiresIn * 1000
      })
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async callApi(path: string, body: unknown): Promise<Response> {
    const credential = await this.ensureToken()
    for (const endpoint of [ANTIGRAVITY_PRIMARY, ANTIGRAVITY_FALLBACK]) {
      const response = await net.fetch(`${endpoint}${path}`, {
        method: 'POST',
        headers: headersFor(credential.access, undefined, 'json'),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      }).catch(() => null)
      if (response?.ok) return response
    }
    throw new Error(`Antigravity 接口调用失败：${path}`)
  }

  private extractProject(payload: unknown): string | undefined {
    const root = asRecord(payload)
    if (!root) return undefined
    const direct = root.antigravityProjectId
      ?? root.projectId
      ?? root.backendProjectId
      ?? root.userDefinedCloudaicompanionProject
      ?? root.cloudaicompanionProject
      ?? root.project
    if (typeof direct === 'string' && direct) return direct
    if (asRecord(direct) && asString(asRecord(direct)!.id)) return asString(asRecord(direct)!.id)
    for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
      const list = root[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const nested = this.extractProject(item)
        if (nested) return nested
        const value = asString(item)
        if (value) return value
      }
    }
    return undefined
  }

  private async loadCodeAssistProject(): Promise<string | undefined> {
    const response = await this.callApi('/v1internal:loadCodeAssist', {
      metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
    }).catch(() => null)
    return response ? this.extractProject(await response.json().catch(() => null)) : undefined
  }

  private async listCompanionProject(): Promise<string | undefined> {
    const response = await this.callApi('/v1internal:listCloudAICompanionProjects', {}).catch(() => null)
    return response ? this.extractProject(await response.json().catch(() => null)) : undefined
  }

  /** 新账号还没有 project 时，先入免费档；失败也只退回默认 project。 */
  private async onboardUser(): Promise<void> {
    const credential = await this.ensureToken()
    for (const endpoint of [ANTIGRAVITY_PRIMARY, ANTIGRAVITY_FALLBACK]) {
      try {
        const response = await net.fetch(`${endpoint}/v1internal:onboardUser`, {
          method: 'POST',
          headers: headersFor(credential.access, undefined, 'json'),
          body: JSON.stringify({ tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } }),
          signal: AbortSignal.timeout(30_000)
        })
        if (!response.ok) continue
        let operation = asRecord(await response.json().catch(() => null)) ?? {}
        const deadline = Date.now() + 30_000
        while (!operation.done && Date.now() < deadline) {
          const name = asString(operation.name)
          if (!name) return
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          const poll = await net.fetch(`${endpoint}/v1internal/${name}`, {
            headers: headersFor(credential.access, undefined, 'json'),
            signal: AbortSignal.timeout(30_000)
          })
          if (!poll.ok) return
          operation = asRecord(await poll.json().catch(() => null)) ?? {}
        }
        if (operation.error) return
        return
      } catch {
        // 尝试下一个端点；失败不阻断登录，project 可退回默认值
      }
    }
  }

  private async ensureProject(): Promise<string> {
    const credential = this.credential
    if (!credential) throw new Error('还没有登录 Google Antigravity。')
    if (credential.projectId) return credential.projectId
    let project = await this.loadCodeAssistProject() ?? await this.listCompanionProject()
    if (!project) {
      await this.onboardUser()
      project = await this.loadCodeAssistProject() ?? await this.listCompanionProject()
    }
    const projectId = project ?? 'antigravity-default'
    this.persist({ ...credential, projectId })
    return projectId
  }

  private async startProxy(): Promise<number> {
    if (this.proxy && this.proxyPort) return this.proxyPort
    const localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    this.localToken = localToken
    const server = createServer((req, res) => {
      void this.handleProxy(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: errorText(err) } })
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
    this.proxy = server
    this.proxyPort = typeof address === 'object' && address ? address.port : 0
    log.info('antigravity subscription proxy started', { port: this.proxyPort })
    return this.proxyPort
  }

  private async handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    const authorized = req.headers.authorization === `Bearer ${this.localToken}`
      || req.headers['x-api-key'] === this.localToken
    if (!authorized) {
      sendJson(res, 401, { error: { message: '本地订阅代理令牌无效。' } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: ANTIGRAVITY_MODELS.map((model) => ({ id: model.id, object: 'model', owned_by: 'antigravity' }))
      })
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      sendJson(res, 404, { error: { message: 'Antigravity 代理只支持 /v1/chat/completions。' } })
      return
    }
    const rawBody = await readBody(req)
    const projectId = await this.ensureProject()
    const { envelope, runtime } = buildAntigravityRequest(rawBody, projectId)
    const credential = await this.ensureToken()
    let upstream: Response | null = null
    for (const endpoint of [ANTIGRAVITY_PRIMARY, ANTIGRAVITY_FALLBACK]) {
      upstream = await net.fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: headersFor(credential.access, runtime),
        body: JSON.stringify(envelope)
      }).catch(() => null)
      if (upstream?.ok) break
      if (upstream && (upstream.status === 401 || upstream.status === 403)) {
        await this.refreshToken()
        upstream = null
      }
    }
    if (!upstream || !upstream.ok) {
      const detail = upstream ? await upstream.text().catch(() => '') : ''
      sendJson(res, upstream?.status ?? 502, {
        error: { message: `Antigravity 上游请求失败${upstream ? `（HTTP ${upstream.status}）` : ''}${detail ? `：${detail.slice(0, 300)}` : ''}` }
      })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    res.flushHeaders()
    await this.pipeStream(res, upstream, runtime)
  }

  private async pipeStream(res: ServerResponse, upstream: Response, runtime: string): Promise<void> {
    const created = Math.floor(Date.now() / 1000)
    const chunkId = `chatcmpl-ag-${Date.now()}`
    const model = runtime
    let toolIndex = 0
    let toolSeen = false
    let finishReason: string | null = null
    let usage: { input: number; output: number; cached: number } | null = null
    let errorSent = false
    const write = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): void => {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify({
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra
      })}\n\n`)
    }
    write({ role: 'assistant', content: '' })
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    let buffer = ''
    try {
      const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream)
      for await (const chunk of stream) {
        buffer += Buffer.from(chunk as Buffer).toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let payload: unknown
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          for (const event of parseAntigravityFrame(payload)) {
            if (event.type === 'text') write({ content: event.text })
            else if (event.type === 'thought') write({ reasoning_content: event.text })
            else if (event.type === 'tool') {
              toolSeen = true
              write({
                tool_calls: [{
                  index: toolIndex,
                  id: `call_${toolIndex}_${Date.now().toString(36)}`,
                  type: 'function',
                  function: { name: event.name, arguments: event.args }
                }]
              })
              toolIndex += 1
            } else if (event.type === 'usage') usage = event
            else if (event.type === 'finish') finishReason = event.reason
            else if (event.type === 'error') {
              errorSent = true
              write({}, null)
              res.write(`data: ${JSON.stringify({ error: { message: event.message } })}\n\n`)
            }
          }
        }
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: errorText(err) } })}\n\n`)
      }
    }
    const mapped = toolSeen
      ? 'tool_calls'
      : finishReason === 'MAX_TOKENS' ? 'length' : 'stop'
    const payload = usage
      ? { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output, ...(usage.cached ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}) }
      : undefined
    if (!errorSent && !res.writableEnded) {
      write({}, mapped, payload ? { usage: payload } : {})
      res.write('data: [DONE]\n\n')
    }
    if (!res.writableEnded) res.end()
  }

  private async ensureProvider(): Promise<void> {
    const port = await this.startProxy()
    if (!this.localToken) throw new Error('Antigravity 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'Google Antigravity（订阅）',
      kind: 'openai-compat',
      port,
      models: ANTIGRAVITY_MODELS,
      localToken: this.localToken
    })
  }

  async restore(): Promise<void> {
    if (!this.credential) return
    try {
      await this.ensureProject()
      await this.ensureProvider()
      void this.refreshQuota().catch((err) => {
        this.lastError = errorText(err)
      })
    } catch (err) {
      this.lastError = errorText(err)
      log.warn('antigravity subscription restore failed', { error: this.lastError })
    }
  }

  async login(): Promise<AgentSubscriptionState> {
    requireClientSecret()
    const { port, code, close } = await this.listenForCode()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(24).toString('base64url')
    const redirectUri = `http://127.0.0.1:${port}${ANTIGRAVITY_REDIRECT_PATH}`
    const authUrl = `${ANTIGRAVITY_AUTH_URL}?${new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: ANTIGRAVITY_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    }).toString()}`
    let result: { code: string; state: string }
    try {
      const opened = await openLoginUrl(authUrl)
      if (!opened.opened) throw new Error(`无法打开浏览器；Google 授权链接已复制：${authUrl}`)
      result = await code
    } finally {
      close()
    }
    if (result.state !== state) throw new Error('Antigravity 登录回调 state 不匹配。')
    const tokenResponse = await net.fetch(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: requireClientSecret(),
        code: result.code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: verifier
      }).toString(),
      signal: AbortSignal.timeout(30_000)
    })
    const tokenPayload = asRecord(await tokenResponse.json().catch(() => null))
    if (!tokenResponse.ok || !tokenPayload?.access_token) {
      throw new Error(`Antigravity 换取 Google 登录失败（HTTP ${tokenResponse.status}）。`)
    }
    const access = asString(tokenPayload.access_token)!
    const refresh = asString(tokenPayload.refresh_token)
    if (!refresh) throw new Error('Google 没有返回 refresh_token；请在授权页允许离线访问后重试。')
    const expiresIn = asNumber(tokenPayload.expires_in) ?? 3_600
    const profile = asRecord(await net.fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(20_000)
    }).then((response) => response.ok ? response.json() : null).catch(() => null))
    const email = asString(profile?.email)
    const name = asString(profile?.name)
    const uid = asString(profile?.id)
    const account: AgentSubscriptionAccount = {
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(uid ? { uid } : {}),
      region: 'Google Antigravity',
      source: 'oauth',
      expiresAt: Date.now() + expiresIn * 1000
    }
    this.persist({
      access,
      refresh,
      expiresAt: Date.now() + expiresIn * 1000,
      projectId: '',
      account
    })
    await this.ensureProject()
    await this.ensureProvider()
    this.quota = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  private listenForCode(): Promise<{ port: number; code: Promise<{ code: string; state: string }>; close: () => void }> {
    return new Promise((resolveServer, rejectServer) => {
      let closeServer: () => void = () => undefined
      const code = new Promise<{ code: string; state: string }>((resolveCode, rejectCode) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (url.pathname !== ANTIGRAVITY_REDIRECT_PATH) {
            res.writeHead(404)
            res.end()
            return
          }
          const gotCode = url.searchParams.get('code')
          const gotState = url.searchParams.get('state')
          const error = url.searchParams.get('error')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<!doctype html><meta charset="utf-8"><title>Morrow</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>Google 登录已完成，可以关闭此页面回到 Morrow。</p></body>')
          if (error) rejectCode(new Error(`Google 授权失败：${error}`))
          else if (!gotCode || !gotState) rejectCode(new Error('Google 回调缺少 code 或 state。'))
          else resolveCode({ code: gotCode, state: gotState })
        })
        closeServer = () => server.close()
        const tryPort = (port: number, remaining: number): void => {
          server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE' && remaining > 0) tryPort(port + 1, remaining - 1)
            else rejectServer(new Error(`Antigravity 登录回调端口不可用：${err.message}`))
          })
          server.listen(port, '127.0.0.1', () => {
            const address = server.address()
            const actual = typeof address === 'object' && address ? address.port : port
            resolveServer({ port: actual, code, close: closeServer })
            const timer = setTimeout(() => rejectCode(new Error('Antigravity 浏览器登录超时（5 分钟）。')), LOGIN_TIMEOUT_MS)
            void code.finally(() => {
              clearTimeout(timer)
              server.close()
            }).catch(() => undefined)
          })
        }
        tryPort(51121, 1024)
      })
    })
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有登录 Google Antigravity。')
    const response = await this.callApi('/v1internal:retrieveUserQuotaSummary', {})
    const payload = await response.json().catch(() => null)
    this.quota = parseAntigravityQuota(payload)
    return this.quota
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    return {
      id: 'antigravity',
      name: 'Google Antigravity',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential?.account ? { account: this.credential.account } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : ANTIGRAVITY_MODELS,
      enabled: provider?.enabled ?? false,
      login: 'oauth',
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Google Antigravity。')
      await this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(PROVIDER_ID, ANTIGRAVITY_MODELS[0]?.id)
  }

  private async closeProxy(): Promise<void> {
    if (!this.proxy) return
    const server = this.proxy
    this.proxy = null
    this.proxyPort = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }).catch(() => undefined)
  }

  async remove(): Promise<AgentSubscriptionState> {
    await this.closeProxy()
    this.proxy = null
    this.proxyPort = null
    this.credential = null
    this.localToken = null
    this.quota = null
    this.lastError = null
    this.store.clear()
    removeProvider(PROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    await this.closeProxy()
  }
}

let instance: AntigravitySubscriptionService | null = null

export function getAntigravitySubscriptionService(): AntigravitySubscriptionService {
  if (!instance) instance = new AntigravitySubscriptionService()
  return instance
}
