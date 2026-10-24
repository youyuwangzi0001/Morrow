/**
 * Cline Pass：WorkOS 设备码登录 → Cline 会话注册 → workos: Bearer。
 * 刷新会轮换 refresh token，必须先落盘再使用；也支持静态 API Key。
 */
import { net } from 'electron'
import type { AgentSubscriptionAccount, AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import type { SubscriptionRelayHandle } from './subscription-relay'
import { startSubscriptionRelay } from './subscription-relay'
import {
  CLINE_BASE,
  CLINE_MODELS,
  CLINE_WORKOS_CLIENT_ID,
  parseClineQuota,
  rewriteClineBody,
  unwrapClineJson
} from './cline-protocol'
import {
  asRecord,
  asString,
  errorText,
  getProvider,
  jwtClaims,
  openExternal,
  randomLocalToken,
  removeProvider,
  saveLoopbackProvider,
  SecureJsonStore,
  setProviderEnabled,
  sleep,
  testSubscriptionProvider
} from './agent-subscription-common'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

const PROVIDER_ID = 'cline-subscription'
const QUOTA_CACHE_MS = 5 * 60_000
const REFRESH_MARGIN_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000

interface ClineCredential {
  kind: 'oauth' | 'key'
  /** OAuth 时是 Cline 会话 access token；key 时是 API Key。 */
  access: string
  refresh?: string
  expiresAt?: number
  account?: AgentSubscriptionAccount
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30_000)
  })
}

async function postJson(url: string, body: unknown): Promise<{ response: Response; payload: Record<string, unknown> | null }> {
  const response = await net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  return { response, payload: asRecord(await response.json().catch(() => null)) }
}

function readAuthData(payload: Record<string, unknown> | null, what: string): {
  access: string
  refresh?: string
  expiresAt?: number
  account?: AgentSubscriptionAccount
} {
  const data = asRecord(payload?.data)
  if (payload?.success !== true || !data) {
    throw new Error(`${what}失败：${asString(payload?.message) ?? '服务端没有返回成功结果'}。`)
  }
  const access = asString(data.accessToken)
  if (!access) throw new Error(`${what}没有返回 accessToken。`)
  const refresh = asString(data.refreshToken)
  const expiresRaw = asString(data.expiresAt)
  const parsedExpiry = expiresRaw ? Date.parse(expiresRaw) : NaN
  const claimExp = Number(jwtClaims(access)?.exp) * 1000
  const expiresAt = Number.isFinite(parsedExpiry) && parsedExpiry > 0
    ? parsedExpiry
    : Number.isFinite(claimExp) && claimExp > 0 ? claimExp : Date.now() + 60 * 60_000
  const user = asRecord(data.userInfo) ?? {}
  const email = asString(user.email)
  const name = asString(user.name)
  const uid = asString(user.clineUserId)
  return {
    access,
    ...(refresh ? { refresh } : {}),
    expiresAt,
    account: {
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(uid ? { uid } : {}),
      region: 'Cline Pass',
      source: 'device',
      expiresAt
    }
  }
}

export class ClineSubscriptionService {
  private store = new SecureJsonStore<ClineCredential>('cline-subscription.json')
  private credential: ClineCredential | null = this.store.load()
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null
  private refreshing: Promise<ClineCredential> | null = null

  private bearer(): string {
    const credential = this.credential
    if (!credential) throw new Error('还没有登录 Cline Pass。')
    if (credential.kind === 'key') return credential.access
    return credential.access.toLowerCase().startsWith('workos:') ? credential.access : `workos:${credential.access}`
  }

  private persist(credential: ClineCredential): ClineCredential {
    this.credential = credential
    this.store.save(credential)
    return credential
  }

  private async ensureToken(): Promise<ClineCredential> {
    const current = this.credential
    if (!current) throw new Error('还没有登录 Cline Pass。')
    if (current.kind === 'key') return current
    if (!current.expiresAt || current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current
    return this.refreshToken()
  }

  private async refreshToken(): Promise<ClineCredential> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const current = this.credential
      if (!current || current.kind !== 'oauth' || !current.refresh) throw new Error('Cline 登录态不支持刷新，请重新登录。')
      const { response, payload } = await postJson(`${CLINE_BASE}/auth/refresh`, {
        refreshToken: current.refresh,
        grantType: 'refresh_token'
      })
      if (!response.ok) throw new Error(`Cline 刷新失败（HTTP ${response.status}），请重新登录。`)
      const data = readAuthData(payload, 'Cline 刷新')
      return this.persist({
        kind: 'oauth',
        access: data.access,
        refresh: data.refresh ?? current.refresh,
        expiresAt: data.expiresAt,
        account: { ...current.account, ...data.account, expiresAt: data.expiresAt }
      })
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    if (!this.credential) throw new Error('还没有登录 Cline Pass。')
    this.localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken,
      fetchImpl: (url, init) => net.fetch(url, init),
      resolveUpstream: (path) => `${CLINE_BASE}${path.replace(/^\/v1/, '')}`,
      getHeaders: async () => ({
        authorization: `Bearer ${this.bearer()}`,
        accept: 'text/event-stream'
      }),
      refresh: async () => {
        await this.refreshToken()
      },
      rewriteBody: rewriteClineBody,
      rewriteJsonResponse: unwrapClineJson
    })
    log.info('cline subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken) throw new Error('Cline 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'Cline Pass（订阅）',
      kind: 'openai-compat',
      port,
      models: CLINE_MODELS,
      localToken: this.localToken
    })
  }

  async restore(): Promise<void> {
    if (!this.credential) return
    try {
      await this.ensureProxy()
      this.ensureProvider()
      void this.refreshQuota().catch((err) => {
        this.lastError = errorText(err)
      })
    } catch (err) {
      this.lastError = errorText(err)
      log.warn('cline subscription restore failed', { error: this.lastError })
    }
  }

  async login(): Promise<AgentSubscriptionState> {
    const response = await postForm('https://api.workos.com/user_management/authorize/device', {
      client_id: CLINE_WORKOS_CLIENT_ID
    })
    const payload = asRecord(await response.json().catch(() => null))
    if (!response.ok || !payload) throw new Error(`Cline 设备授权失败（HTTP ${response.status}）。`)
    const deviceCode = asString(payload.device_code)
    const verification = asString(payload.verification_uri_complete) ?? asString(payload.verification_uri)
    if (!deviceCode || !verification) throw new Error('Cline 设备授权响应缺少 device_code 或授权地址。')
    openExternal(verification)
    let interval = Math.max(1, Number(payload.interval) || 5) * 1000
    const expiresIn = Math.max(60, Number(payload.expires_in) || 300) * 1000
    const deadline = Date.now() + Math.min(expiresIn, LOGIN_TIMEOUT_MS)
    let workos: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await postForm('https://api.workos.com/user_management/authenticate', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: CLINE_WORKOS_CLIENT_ID
      })
      const body = asRecord(await poll.json().catch(() => null))
      if (poll.ok && asString(body?.access_token)) {
        workos = body
        break
      }
      const code = asString(body?.error)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') {
        interval += 1_000
        continue
      }
      if (code === 'expired_token') throw new Error('Cline 授权码已过期，请重新发起登录。')
      if (code === 'access_denied') throw new Error('你取消了 Cline 授权。')
      if (poll.status >= 500) continue
      throw new Error(`Cline 设备登录失败（HTTP ${poll.status}）。`)
    }
    if (!workos) throw new Error('Cline 浏览器登录超时（5 分钟）。请重新发起登录。')
    const workosAccess = asString(workos.access_token)!
    const workosRefresh = asString(workos.refresh_token)
    if (!workosRefresh) throw new Error('Cline 登录响应缺少 refresh_token。')
    const { response: registerResponse, payload: registerPayload } = await postJson(`${CLINE_BASE}/auth/register`, {
      accessToken: workosAccess,
      refreshToken: workosRefresh
    })
    if (!registerResponse.ok) throw new Error(`Cline 会话注册失败（HTTP ${registerResponse.status}）。`)
    const data = readAuthData(registerPayload, 'Cline 会话注册')
    this.persist({
      kind: 'oauth',
      access: data.access,
      refresh: data.refresh ?? workosRefresh,
      expiresAt: data.expiresAt,
      account: data.account
    })
    await this.ensureProxy()
    this.ensureProvider()
    this.quota = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  async loginToken(token: string): Promise<AgentSubscriptionState> {
    const key = token.trim()
    if (!key) throw new Error('请填写 Cline API Key。')
    const response = await net.fetch(`${CLINE_BASE}/users/me/plan/usage-limits`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 401 || response.status === 403) throw new Error('Cline API Key 无效或已失效。')
    if (!response.ok) throw new Error(`Cline API Key 校验失败（HTTP ${response.status}）。`)
    this.persist({
      kind: 'key',
      access: key,
      account: { region: 'Cline Pass', source: 'token', name: 'Cline API Key' }
    })
    await this.ensureProxy()
    this.ensureProvider()
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  async refreshQuota(retried = false): Promise<AgentSubscriptionQuota> {
    const credential = await this.ensureToken()
    const response = await net.fetch(`${CLINE_BASE}/users/me/plan/usage-limits`, {
      headers: { authorization: `Bearer ${this.bearer()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 401 || response.status === 403) {
      if (credential.kind === 'oauth' && !retried) {
        await this.refreshToken()
        return this.refreshQuota(true)
      }
      throw new Error(credential.kind === 'key' ? 'Cline API Key 已失效。' : 'Cline 额度接口拒绝了当前会话，请重新登录。')
    }
    if (!response.ok) throw new Error(`Cline 额度读取失败（HTTP ${response.status}）。`)
    this.quota = parseClineQuota(await response.json().catch(() => null))
    return this.quota
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    return {
      id: 'cline',
      name: 'Cline Pass',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential?.account ? { account: this.credential.account } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : CLINE_MODELS,
      enabled: provider?.enabled ?? false,
      login: 'device',
      tokenLogin: {
        label: 'Cline API Key',
        placeholder: '可选：粘贴 Cline 的静态 API Key',
        help: '默认用浏览器设备登录；静态 Key 会直接校验额度接口。'
      },
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Cline Pass。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(PROVIDER_ID, CLINE_MODELS[0]?.id)
  }

  async remove(): Promise<AgentSubscriptionState> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
    this.credential = null
    this.localToken = null
    this.quota = null
    this.lastError = null
    this.store.clear()
    removeProvider(PROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let instance: ClineSubscriptionService | null = null

export function getClineSubscriptionService(): ClineSubscriptionService {
  if (!instance) instance = new ClineSubscriptionService()
  return instance
}
