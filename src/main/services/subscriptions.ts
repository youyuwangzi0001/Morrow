/**
 * 模型订阅接入：官方 Codex（ChatGPT 订阅）+ 第三方 coding plan。
 *
 * 官方线路：只用用户自己的 OAuth/本机 Codex 登录态，不伪造官方客户端身份；
 * 通过回环代理把 Responses 转成 OpenAI 兼容接口，再注册为 Morrow Provider。
 * 第三方线路：OpenAI/Anthropic 兼容端点 + 用户 token，直接注册 Provider。
 */
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { net, safeStorage } from 'electron'
import type { ModelInfo, ProviderConfig, Settings } from '../../shared/types'
import type {
  CodexCredential
} from './codex-proxy'
import { startCodexProxy, USAGE_URL, type CodexProxyHandle } from './codex-proxy'
import type {
  CodexSubscriptionAccount,
  CodexSubscriptionQuota,
  CodexSubscriptionState,
  CustomSubscriptionInput,
  CustomSubscriptionRecord,
  CustomSubscriptionState,
  SubscriptionAction,
  SubscriptionStatus,
  SubscriptionTestResult
} from '../../shared/subscriptions'
import { getSettingsStore } from './settings-store'
import { dataPath } from './paths'
import { log } from './logger'
import { testProviderConnection } from '../../core/providers'
import { getQoderSubscriptionService } from './qoder-subscription'
import { AGENT_ORDER, getAgentService } from './agent-subscriptions'
import { openLoginQuiet } from './external-open'

const CODEX_PROVIDER_ID = 'codex-subscription'
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const OAUTH_SCOPE = 'openid profile email offline_access'
const QUOTA_CACHE_MS = 60_000
export const CODEX_MODELS: ModelInfo[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 384_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 384_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 384_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', contextWindow: 384_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextWindow: 272_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', contextWindow: 272_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextWindow: 272_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 272_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', contextWindow: 272_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, supportsVision: true, reasoningStyle: 'effort', note: 'ChatGPT 订阅' }
]

const DISCLAIMER =
  '订阅接入只使用你自己的官方账号登录态或第三方 token，不代充、不共享账号、不绕过服务商限制。账号额度、模型可用性与使用条款由服务商决定；Morrow 只负责调用与展示。'

interface StoredCodex {
  encrypted: string
  account: CodexSubscriptionAccount
  sourcePath?: string
  updatedAt: number
}

interface SubscriptionFile {
  version: 1
  codex?: StoredCodex
  custom: CustomSubscriptionRecord[]
}

interface JwtClaims {
  exp?: number
  email?: string
  [key: string]: unknown
}

let instance: SubscriptionService | null = null

function decodeJwt(token?: string): JwtClaims | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtClaims
  } catch {
    return undefined
  }
}

function authClaims(token?: string): Record<string, unknown> | undefined {
  const claims = decodeJwt(token)
  const auth = claims?.['https://api.openai.com/auth']
  return auth && typeof auth === 'object' ? auth as Record<string, unknown> : undefined
}

function credentialFromTokens(accessToken: string, refreshToken: string, idToken?: string, accountId?: string): CodexCredential {
  const access = decodeJwt(accessToken)
  const id = decodeJwt(idToken)
  const auth = authClaims(idToken) ?? authClaims(accessToken)
  const expiresAt = typeof access?.exp === 'number' ? access.exp * 1000 : Date.now() + 5 * 60_000
  return {
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    ...(accountId || (typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined)
      ? { accountId: accountId ?? String(auth?.chatgpt_account_id) }
      : {}),
    ...(typeof id?.email === 'string' ? { email: id.email } : {}),
    ...(typeof auth?.chatgpt_plan_type === 'string' ? { plan: auth.chatgpt_plan_type } : {}),
    expiresAt
  }
}

function readCodexAuth(path: string): CodexCredential | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (raw.auth_mode !== 'chatgpt') return null
    const tokens = raw.tokens
    if (!tokens || typeof tokens !== 'object') return null
    const record = tokens as Record<string, unknown>
    const access = typeof record.access_token === 'string' ? record.access_token : ''
    const refresh = typeof record.refresh_token === 'string' ? record.refresh_token : ''
    if (!access || !refresh) return null
    return credentialFromTokens(
      access,
      refresh,
      typeof record.id_token === 'string' ? record.id_token : undefined,
      typeof record.account_id === 'string' ? record.account_id : undefined
    )
  } catch {
    return null
  }
}

function defaultCodexAuthPath(): string {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return join(home, 'auth.json')
}

function safeAccount(credential: CodexCredential): CodexSubscriptionAccount {
  return {
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.plan ? { plan: credential.plan } : {}),
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
    ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    source: 'oauth'
  }
}

function windowLabel(seconds: number): string {
  if (seconds >= 7 * 24 * 3600 - 3600) return '每周'
  if (seconds >= 5 * 3600 - 300 && seconds <= 5 * 3600 + 300) return '5 小时'
  if (seconds >= 24 * 3600 - 300) return `${Math.round(seconds / 86400)} 天`
  return `${Math.max(1, Math.round(seconds / 3600))} 小时`
}

function parseQuota(payload: unknown, fallbackEmail?: string): CodexSubscriptionQuota {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rate = root.rate_limit && typeof root.rate_limit === 'object' ? root.rate_limit as Record<string, unknown> : {}
  const windows: CodexSubscriptionQuota['windows'] = []
  for (const key of ['primary_window', 'secondary_window']) {
    const item = rate[key]
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const used = Number(entry.used_percent ?? 0)
    const seconds = Number(entry.limit_window_seconds ?? 0)
    const reset = Number(entry.reset_at ?? 0)
    windows.push({
      label: windowLabel(seconds || 0),
      usedPercent: Math.max(0, Math.min(100, Number.isFinite(used) ? used : 0)),
      ...(seconds > 0 ? { windowSeconds: seconds } : {}),
      ...(reset > 0 ? { resetAt: reset * 1000 } : {})
    })
  }
  const credits = root.credits && typeof root.credits === 'object' ? root.credits as Record<string, unknown> : null
  const balance = Number(credits?.balance ?? Number.NaN)
  return {
    ...(typeof root.plan_type === 'string' ? { plan: root.plan_type } : {}),
    ...(typeof root.email === 'string' ? { email: root.email } : fallbackEmail ? { email: fallbackEmail } : {}),
    windows,
    ...(credits
      ? {
          credits: {
            hasCredits: credits.has_credits === true,
            unlimited: credits.unlimited === true,
            ...(Number.isFinite(balance) ? { balance } : {})
          }
        }
      : {}),
    fetchedAt: Date.now()
  }
}

export class SubscriptionService {
  private file: SubscriptionFile = { version: 1, custom: [] }
  private credential: CodexCredential | null = null
  private proxy: CodexProxyHandle | null = null
  private localToken: string | null = null
  private quotaCache: CodexSubscriptionQuota | null = null
  private lastError: string | null = null
  private refreshPromise: Promise<CodexCredential> | null = null
  private restoring: Promise<void> | null = null
  /** 正在等待回调的 Codex 登录；重复点击只重新打开授权页，不再抢占 1455 端口。 */
  private codexLogin: { url: string; promise: Promise<SubscriptionStatus> } | null = null

  constructor() {
    this.file = this.loadFile()
    this.credential = this.loadCredential()
  }

  private filePath(): string {
    return dataPath('subscriptions.json')
  }

  private loadFile(): SubscriptionFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(), 'utf8')) as SubscriptionFile
      return {
        version: 1,
        ...(parsed.codex ? { codex: parsed.codex } : {}),
        custom: Array.isArray(parsed.custom) ? parsed.custom.filter((item) => item && typeof item.id === 'string') : []
      }
    } catch {
      return { version: 1, custom: [] }
    }
  }

  private saveFile(): void {
    mkdirSync(dirname(this.filePath()), { recursive: true })
    writeFileSync(this.filePath(), `${JSON.stringify(this.file, null, 2)}\n`, 'utf8')
  }

  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存订阅登录态。')
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private loadCredential(): CodexCredential | null {
    if (!this.file.codex) return null
    try {
      const raw = JSON.parse(this.decrypt(this.file.codex.encrypted)) as CodexCredential
      if (!raw.accessToken || !raw.refreshToken) return null
      return raw
    } catch (err) {
      this.lastError = `读取加密登录态失败：${err instanceof Error ? err.message : String(err)}`
      return null
    }
  }

  /** 启动后恢复本地代理；失败不阻断应用启动。 */
  async restore(): Promise<void> {
    if (this.restoring) return this.restoring
    this.restoring = (async () => {
      if (!this.credential) return
      try {
        await this.ensureProxy()
        this.ensureProvider()
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        log.warn('subscription restore failed', { error: this.lastError })
      }
    })().finally(() => {
      this.restoring = null
    })
    return this.restoring
  }

  private async fetchImpl(url: string, init: RequestInit): Promise<Response> {
    return net.fetch(url, init)
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    if (!this.credential) throw new Error('还没有登录 ChatGPT 订阅。')
    const settings = getSettingsStore().get()
    const existingProvider = settings.providers.find((provider) => provider.id === CODEX_PROVIDER_ID)
    this.localToken = existingProvider ? getSettingsStore().getApiKey(CODEX_PROVIDER_ID) ?? null : null
    if (!this.localToken) {
      this.localToken = randomBytes(32).toString('base64url')
    }
    const handle = await startCodexProxy({
      localToken: this.localToken,
      models: CODEX_MODELS,
      getCredentials: async () => {
        if (!this.credential) throw new Error('ChatGPT 登录态已丢失。')
        if (this.credential.expiresAt - Date.now() < 120_000) return this.refreshCodexToken()
        return this.credential
      },
      refreshCredentials: () => this.refreshCodexToken(),
      fetchImpl: (url, init) => this.fetchImpl(url, init)
    })
    this.proxy = handle
    log.info('codex subscription proxy started', { port: handle.port })
    return handle.port
  }

  private ensureProvider(): Settings {
    const port = this.proxy?.port
    if (!port || !this.localToken) throw new Error('Codex 订阅代理没有启动。')
    const existing = getSettingsStore().get().providers.find((item) => item.id === CODEX_PROVIDER_ID)
    const config: ProviderConfig = {
      id: CODEX_PROVIDER_ID,
      kind: 'openai-compat',
      name: 'Codex（ChatGPT 订阅）',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: CODEX_MODELS,
      category: 'custom',
      apiKeyStored: true,
      enabled: existing?.enabled ?? true
    }
    return getSettingsStore().saveProvider(config, this.localToken)
  }

  private async refreshCodexToken(): Promise<CodexCredential> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      const current = this.credential
      if (!current?.refreshToken) throw new Error('ChatGPT 登录已过期，请重新登录。')
      const response = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
          client_id: OAUTH_CLIENT_ID
        }).toString()
      })
      if (!response.ok) throw new Error(`刷新 ChatGPT 登录失败（HTTP ${response.status}），请重新登录。`)
      const tokens = await response.json() as Record<string, unknown>
      const next = credentialFromTokens(
        String(tokens.access_token ?? ''),
        String(tokens.refresh_token ?? current.refreshToken),
        typeof tokens.id_token === 'string' ? tokens.id_token : current.idToken,
        current.accountId
      )
      this.persistCredential(next)
      return next
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private persistCredential(credential: CodexCredential): void {
    this.credential = credential
    const account = safeAccount(credential)
    this.file.codex = {
      encrypted: this.encrypt(JSON.stringify(credential)),
      account,
      ...(this.file.codex?.sourcePath ? { sourcePath: this.file.codex.sourcePath } : {}),
      updatedAt: Date.now()
    }
    this.saveFile()
  }

  async importCodex(path?: string): Promise<SubscriptionStatus> {
    const target = path?.trim() || defaultCodexAuthPath()
    if (!existsSync(target)) throw new Error(`找不到 Codex 登录文件：${target}`)
    const credential = readCodexAuth(target)
    if (!credential) throw new Error('这个文件不是可用的 ChatGPT/Codex 登录态（需要 auth_mode=chatgpt 的 access/refresh token）。')
    this.persistCredential(credential)
    this.file.codex = { ...this.file.codex!, sourcePath: target, account: { ...safeAccount(credential), source: 'codex-cli' }, updatedAt: Date.now() }
    this.saveFile()
    await this.ensureProxy()
    this.ensureProvider()
    this.quotaCache = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  pendingLoginUrl(): string | null {
    return this.codexLogin?.url ?? null
  }

  async loginCodex(): Promise<SubscriptionStatus> {
    // 用户第一次点击后浏览器可能被系统/安全软件拦下；第二次点击应重新打开同一个授权页，
    // 而不是再次 listen(1455) 导致 EADDRINUSE。
    if (this.codexLogin) {
      openLoginQuiet(this.codexLogin.url)
      return this.codexLogin.promise
    }
    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(24).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const url = new URL(OAUTH_AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', OAUTH_CLIENT_ID)
    url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI)
    url.searchParams.set('scope', OAUTH_SCOPE)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('id_token_add_organizations', 'true')
    url.searchParams.set('codex_cli_simplified_flow', 'true')
    url.searchParams.set('state', state)
    url.searchParams.set('originator', 'morrow')
    const login = { url: url.toString(), promise: this.runCodexLogin(url, verifier, state) }
    this.codexLogin = login
    try {
      return await login.promise
    } finally {
      if (this.codexLogin === login) this.codexLogin = null
    }
  }

  private async runCodexLogin(url: URL, verifier: string, state: string): Promise<SubscriptionStatus> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error('ChatGPT 登录回调端口 1455 被占用。请关闭占用该端口的程序后重试；如果上一次登录仍在等待，请先在浏览器完成它。')
            : err
        )
      }
      server.once('error', onError)
      server.listen(1455, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ChatGPT 登录超时（5 分钟）。')), 5 * 60_000)
        server.on('request', (req, res) => {
          try {
            const requestUrl = new URL(req.url ?? '/', 'http://localhost:1455')
            if (requestUrl.pathname !== '/auth/callback') {
              res.writeHead(404).end()
              return
            }
            if (requestUrl.searchParams.get('state') !== state) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state 校验失败，请回到 Morrow 重试。')
              return
            }
            const denied = requestUrl.searchParams.get('error')
            if (denied) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`登录未完成：${denied}`)
              clearTimeout(timer)
              reject(new Error(`ChatGPT 登录未完成：${denied}`))
              return
            }
            const value = requestUrl.searchParams.get('code')
            if (!value) {
              res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('没有收到授权码。')
              return
            }
            clearTimeout(timer)
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body style="font-family:system-ui;padding:40px"><h2>登录完成</h2><p>可以关闭此页面，回到 Morrow。</p></body></html>')
            resolve(value)
          } catch (err) {
            clearTimeout(timer)
            reject(err)
          }
        })
        openLoginQuiet(url.toString())
      })
      const response = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: OAUTH_CLIENT_ID
        }).toString()
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 600)
        throw new Error(`ChatGPT 登录换取 token 失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
      }
      const tokens = await response.json() as Record<string, unknown>
      const credential = credentialFromTokens(
        String(tokens.access_token ?? ''),
        String(tokens.refresh_token ?? ''),
        typeof tokens.id_token === 'string' ? tokens.id_token : undefined
      )
      if (!credential.accessToken || !credential.refreshToken) throw new Error('ChatGPT 没有返回完整的登录凭据。')
      this.persistCredential(credential)
      await this.ensureProxy()
      this.ensureProvider()
      this.quotaCache = null
      await this.refreshQuota().catch(() => undefined)
      return this.status()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  async refreshQuota(): Promise<CodexSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有登录 ChatGPT 订阅。')
    const load = async (): Promise<CodexSubscriptionQuota> => {
      const response = await this.fetchImpl(USAGE_URL, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.credential!.accessToken}`,
          ...(this.credential!.accountId ? { 'chatgpt-account-id': this.credential!.accountId } : {}),
          originator: 'morrow',
          'user-agent': 'morrow-desktop/0.1.0',
          accept: 'application/json'
        }
      })
      if (response.status === 401) {
        await this.refreshCodexToken()
        return load()
      }
      if (!response.ok) throw new Error(`读取订阅额度失败（HTTP ${response.status}）。`)
      return parseQuota(await response.json(), this.credential?.email)
    }
    this.quotaCache = await load()
    return this.quotaCache
  }

  async removeCodex(): Promise<SubscriptionStatus> {
    if (this.proxy) {
      await this.proxy.close().catch(() => undefined)
      this.proxy = null
    }
    this.credential = null
    this.localToken = null
    this.quotaCache = null
    delete this.file.codex
    this.saveFile()
    try {
      getSettingsStore().removeProvider(CODEX_PROVIDER_ID)
    } catch {
      // provider 可能已被用户手动删除
    }
    return this.status()
  }

  async setCodexEnabled(enabled: boolean): Promise<SubscriptionStatus> {
    let provider = getSettingsStore().get().providers.find((item) => item.id === CODEX_PROVIDER_ID)
    if (!provider && enabled && this.credential) {
      await this.ensureProxy()
      this.ensureProvider()
      provider = getSettingsStore().get().providers.find((item) => item.id === CODEX_PROVIDER_ID)
    }
    if (!provider) throw new Error('Codex 订阅 Provider 尚未创建。')
    const key = getSettingsStore().getApiKey(CODEX_PROVIDER_ID)
    getSettingsStore().saveProvider({ ...provider, enabled }, key ?? undefined)
    return this.status()
  }

  async testCodex(): Promise<SubscriptionTestResult> {
    const started = Date.now()
    try {
      await this.refreshQuota()
      const provider = getSettingsStore().get().providers.find((item) => item.id === CODEX_PROVIDER_ID)
      if (!provider) throw new Error('Codex Provider 不存在。')
      const result = await testProviderConnection(provider, getSettingsStore().getApiKey(CODEX_PROVIDER_ID), CODEX_MODELS[0]?.id)
      return { ...result, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async addCustom(input: CustomSubscriptionInput): Promise<SubscriptionStatus> {
    const record = this.customRecord(input)
    this.file.custom.push(record)
    this.saveFile()
    this.saveCustomProvider(record, input)
    return this.status()
  }

  async updateCustom(input: CustomSubscriptionInput): Promise<SubscriptionStatus> {
    if (!input.id) throw new Error('缺少订阅 id。')
    const index = this.file.custom.findIndex((item) => item.id === input.id)
    if (index < 0) throw new Error('找不到这个订阅。')
    const record = { ...this.customRecord(input), id: input.id, createdAt: this.file.custom[index].createdAt }
    this.file.custom[index] = record
    this.saveFile()
    this.saveCustomProvider(record, input)
    return this.status()
  }

  private customRecord(input: CustomSubscriptionInput): CustomSubscriptionRecord {
    const name = input.name?.trim()
    if (!name) throw new Error('请填写订阅名称。')
    if (input.protocol !== 'openai-compat' && input.protocol !== 'anthropic') throw new Error('不支持的协议。')
    if (!/^https?:\/\//i.test(input.baseUrl?.trim() ?? '')) throw new Error('接口地址必须是 http(s)。')
    const models = [...new Set((input.models ?? []).map((item) => item.trim()).filter(Boolean))]
    if (models.length === 0) throw new Error('至少填写一个模型 ID。')
    const id = input.id ?? `sub_${randomBytes(5).toString('hex')}`
    return {
      id,
      name,
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      providerId: `subscription-${id}`,
      models,
      createdAt: Date.now()
    }
  }

  private saveCustomProvider(record: CustomSubscriptionRecord, input: CustomSubscriptionInput): void {
    const existing = getSettingsStore().get().providers.find((item) => item.id === record.providerId)
    const config: ProviderConfig = {
      id: record.providerId,
      kind: record.protocol,
      name: record.name,
      baseUrl: record.baseUrl,
      models: record.models.map((id) => ({
        id,
        label: id,
        contextWindow: 128_000,
        maxOutput: 16_384,
        supportsTools: true,
        supportsReasoning: false,
        note: '第三方订阅'
      })),
      category: 'custom',
      apiKeyStored: Boolean(getSettingsStore().getApiKey(record.providerId)),
      enabled: existing?.enabled ?? true
    }
    getSettingsStore().saveProvider(config, input.apiKey?.trim() || undefined)
  }

  async removeCustom(id: string): Promise<SubscriptionStatus> {
    const record = this.file.custom.find((item) => item.id === id)
    if (!record) throw new Error('找不到这个订阅。')
    this.file.custom = this.file.custom.filter((item) => item.id !== id)
    this.saveFile()
    try {
      getSettingsStore().removeProvider(record.providerId)
    } catch {
      // 可能已手动删除
    }
    return this.status()
  }

  async testCustom(id: string): Promise<SubscriptionTestResult> {
    const record = this.file.custom.find((item) => item.id === id)
    if (!record) throw new Error('找不到这个订阅。')
    const provider = getSettingsStore().get().providers.find((item) => item.id === record.providerId)
    if (!provider) return { ok: false, latencyMs: 0, message: 'Provider 已被删除，请重新添加订阅。' }
    const started = Date.now()
    try {
      const result = await testProviderConnection(provider, getSettingsStore().getApiKey(record.providerId), record.models[0])
      return { ...result, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async setCustomEnabled(id: string, enabled: boolean): Promise<SubscriptionStatus> {
    const record = this.file.custom.find((item) => item.id === id)
    if (!record) throw new Error('找不到这个订阅。')
    const provider = getSettingsStore().get().providers.find((item) => item.id === record.providerId)
    if (!provider) throw new Error('Provider 已被删除。')
    getSettingsStore().saveProvider({ ...provider, enabled }, getSettingsStore().getApiKey(record.providerId) ?? undefined)
    return this.status()
  }

  async status(): Promise<SubscriptionStatus> {
    const settings = getSettingsStore().get()
    const provider = settings.providers.find((item) => item.id === CODEX_PROVIDER_ID)
    let quota = this.quotaCache
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    if (!quota && this.credential && this.proxy) {
      try {
        quota = await this.refreshQuota()
        this.lastError = null
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    const codexAccount = this.file.codex?.account ?? (this.credential ? safeAccount(this.credential) : undefined)
    const codex: CodexSubscriptionState = {
      available: true,
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(codexAccount ? { account: codexAccount } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : CODEX_MODELS,
      enabled: provider?.enabled ?? false,
      ...(this.file.codex?.sourcePath ? { sourcePath: this.file.codex.sourcePath } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
    const custom: CustomSubscriptionState[] = this.file.custom.map((record) => {
      const customProvider = settings.providers.find((item) => item.id === record.providerId)
      return {
        record,
        ...(customProvider ? { provider: customProvider } : {}),
        connected: Boolean(customProvider?.apiKeyStored),
        ...(!customProvider ? { error: 'Provider 已被删除' } : {})
      }
    })
    const qoder = await getQoderSubscriptionService().status()
    const agents = await Promise.all(AGENT_ORDER.map((id) => getAgentService(id).status()))
    return { codex, qoder, agents, custom, disclaimer: DISCLAIMER }
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

export function getSubscriptionService(): SubscriptionService {
  if (!instance) instance = new SubscriptionService()
  return instance
}

export async function runSubscriptionAction(action: SubscriptionAction): Promise<SubscriptionStatus | SubscriptionTestResult> {
  const service = getSubscriptionService()
  switch (action.action) {
    case 'import-codex':
      return service.importCodex(action.path)
    case 'login-codex':
      return service.loginCodex()
    case 'refresh-codex':
      await service.refreshQuota()
      return service.status()
    case 'remove-codex':
      return service.removeCodex()
    case 'set-codex-enabled':
      return service.setCodexEnabled(action.enabled)
    case 'test-codex':
      return service.testCodex()
    case 'login-qoder':
      await getQoderSubscriptionService().loginPat(action.pat, action.region)
      return service.status()
    case 'login-qoder-device':
      await getQoderSubscriptionService().loginDevice()
      return service.status()
    case 'import-qoder-local':
      await getQoderSubscriptionService().importLocal()
      return service.status()
    case 'refresh-qoder':
      await getQoderSubscriptionService().refreshQuota()
      return service.status()
    case 'remove-qoder':
      await getQoderSubscriptionService().remove()
      return service.status()
    case 'test-qoder':
      return getQoderSubscriptionService().test()
    case 'set-qoder-enabled':
      await getQoderSubscriptionService().setEnabled(action.enabled)
      return service.status()
    case 'login-agent':
      await getAgentService(action.id).login(action.region)
      return service.status()
    case 'login-agent-token': {
      const target = getAgentService(action.id)
      if (!target.loginToken) throw new Error('这个订阅渠道不支持直接填写密钥。')
      await target.loginToken(action.token, action.region)
      return service.status()
    }
    case 'import-agent-local': {
      const target = getAgentService(action.id)
      if (!target.importLocal) throw new Error('这个订阅渠道没有本机登录可导入。')
      await target.importLocal()
      return service.status()
    }
    case 'refresh-agent':
      await getAgentService(action.id).refreshQuota()
      return service.status()
    case 'remove-agent':
      await getAgentService(action.id).remove()
      return service.status()
    case 'test-agent':
      return getAgentService(action.id).test()
    case 'set-agent-enabled':
      await getAgentService(action.id).setEnabled(action.enabled)
      return service.status()
    case 'add-custom':
      return service.addCustom(action.input)
    case 'update-custom':
      return service.updateCustom(action.input)
    case 'remove-custom':
      return service.removeCustom(action.id)
    case 'test-custom':
      return service.testCustom(action.id)
    case 'set-custom-enabled':
      return service.setCustomEnabled(action.id, action.enabled)
    default:
      throw new Error('不支持的订阅操作。')
  }
}
