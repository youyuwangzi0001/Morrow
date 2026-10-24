/**
 * MiniMax Code 订阅：RFC 8628 设备码 + PKCE，Bearer 访问 Token，
 * 本机回环代理把 Anthropic Messages 请求转发到 MiniMax 的托管 Agent 端点。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { net } from 'electron'
import type { AgentSubscriptionAccount, AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import { getSettingsStore } from './settings-store'
import type { SubscriptionRelayHandle } from './subscription-relay'
import { startSubscriptionRelay } from './subscription-relay'
import {
  MINIMAX_AUDIENCE,
  MINIMAX_CLIENT_ID,
  MINIMAX_MESSAGES_PREFIX,
  MINIMAX_MODELS,
  MINIMAX_QUOTA_PATH,
  MINIMAX_REGIONS,
  MINIMAX_SCOPE,
  parseMinimaxLocalAuth,
  parseMinimaxQuota,
  rewriteMinimaxBody,
  type MinimaxRegion
} from './minimax-protocol'
import {
  asRecord,
  asString,
  errorText,
  getProvider,
  homePath,
  jwtClaims,
  openExternal,
  randomLocalToken,
  readLocalJson,
  removeProvider,
  saveLoopbackProvider,
  SecureJsonStore,
  setProviderEnabled,
  sleep,
  testSubscriptionProvider
} from './agent-subscription-common'
import { log } from './logger'

const PROVIDER_ID = 'minimax-subscription'
const QUOTA_CACHE_MS = 2 * 60_000
const REFRESH_MARGIN_MS = 5 * 60_000
const LOGIN_TIMEOUT_MS = 10 * 60_000
const UA = 'morrow-desktop/0.1.0'

interface MinimaxCredential {
  accessToken: string
  refreshToken: string
  expiresAt: number
  region: MinimaxRegion
  account?: AgentSubscriptionAccount
  recordKey?: string
}

function regionOf(value: string | undefined): MinimaxRegion {
  return value === 'global' ? 'global' : 'cn'
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function authHeaders(): Record<string, string> {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'user-agent': UA
  }
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return net.fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30_000)
  })
}

function accountFromToken(accessToken: string, region: MinimaxRegion, expiresAt: number): AgentSubscriptionAccount {
  const claims = jwtClaims(accessToken) ?? {}
  const email = asString(claims.email)
  const name = asString(claims.name) ?? asString(claims.nickname)
  const uid = asString(claims.sub) ?? asString(claims.user_id)
  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(uid ? { uid } : {}),
    region: MINIMAX_REGIONS[region].label,
    expiresAt,
    source: 'device'
  }
}

export class MinimaxSubscriptionService {
  private store = new SecureJsonStore<MinimaxCredential>('minimax-subscription.json')
  private credential: MinimaxCredential | null = this.store.load()
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null
  private refreshing: Promise<MinimaxCredential> | null = null

  private persist(credential: MinimaxCredential): MinimaxCredential {
    this.credential = credential
    this.store.save(credential)
    return credential
  }

  private async ensureToken(): Promise<MinimaxCredential> {
    const current = this.credential
    if (!current) throw new Error('还没有登录 MiniMax Code。')
    if (current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current
    return this.refreshToken()
  }

  private async refreshToken(): Promise<MinimaxCredential> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const current = this.credential
      if (!current) throw new Error('还没有登录 MiniMax Code。')
      let response: Response | null = null
      let transient = ''
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const candidate = await postForm(`${MINIMAX_REGIONS[current.region].account}/oauth2/token`, {
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
            client_id: MINIMAX_CLIENT_ID,
            scope: MINIMAX_SCOPE,
            audience: MINIMAX_AUDIENCE
          })
          if (candidate.status === 429 || candidate.status >= 500) {
            transient = `HTTP ${candidate.status}`
            await sleep(800 * (attempt + 1))
            continue
          }
          response = candidate
          break
        } catch (err) {
          transient = err instanceof Error ? err.message : String(err)
          if (attempt < 2) await sleep(800 * (attempt + 1))
        }
      }
      if (!response) throw new Error(`MiniMax 刷新暂时失败：${transient || '网络错误'}，请稍后重试。`)
      const payload = asRecord(await response.json().catch(() => null))
      if (response.status === 400 || response.status === 401 || response.status === 403 || !payload?.access_token) {
        throw new Error('MiniMax 登录已失效，请重新登录。')
      }
      const expiresIn = Number(payload.expires_in)
      const expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000)
      return this.persist({
        ...current,
        accessToken: asString(payload.access_token)!,
        refreshToken: asString(payload.refresh_token) ?? current.refreshToken,
        expiresAt,
        account: accountFromToken(asString(payload.access_token)!, current.region, expiresAt)
      })
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    const credential = this.credential
    if (!credential) throw new Error('还没有登录 MiniMax Code。')
    this.localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    const region = MINIMAX_REGIONS[credential.region]
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken,
      fetchImpl: (url, init) => net.fetch(url, init),
      resolveUpstream: (path) => `${region.agent}${MINIMAX_MESSAGES_PREFIX}${path.replace(/^\/v1/, '')}`,
      getHeaders: async () => {
        const current = await this.ensureToken()
        return {
          authorization: `Bearer ${current.accessToken}`,
          'anthropic-version': '2023-06-01',
          accept: 'text/event-stream',
          'user-agent': UA
        }
      },
      refresh: async () => {
        await this.refreshToken()
      },
      rewriteBody: rewriteMinimaxBody
    })
    log.info('minimax subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken) throw new Error('MiniMax 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'MiniMax Code（订阅）',
      kind: 'anthropic',
      port,
      models: MINIMAX_MODELS,
      localToken: this.localToken
    })
  }


  private async resetProxy(): Promise<void> {
    if (this.proxy) {
      await this.proxy.close().catch(() => undefined)
      this.proxy = null
    }
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
      log.warn('minimax subscription restore failed', { error: this.lastError })
    }
  }

  async login(regionValue: string | undefined): Promise<AgentSubscriptionState> {
    const region = regionOf(regionValue)
    const config = MINIMAX_REGIONS[region]
    const pkce = pkcePair()
    const response = await postForm(`${config.account}/oauth2/device/code`, {
      client_id: MINIMAX_CLIENT_ID,
      scope: MINIMAX_SCOPE,
      audience: MINIMAX_AUDIENCE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256'
    })
    const payload = asRecord(await response.json().catch(() => null))
    if (!response.ok || !payload) throw new Error(`MiniMax 设备授权失败（HTTP ${response.status}）。`)
    const deviceCode = asString(payload.device_code)
    const userCode = asString(payload.user_code)
    const verification = asString(payload.verification_uri_complete) ?? asString(payload.verification_uri)
    if (!deviceCode || !verification) throw new Error('MiniMax 设备授权响应缺少 device_code 或授权地址。')
    if (userCode) log.info('minimax device login started', { region })
    openExternal(verification)
    let interval = Math.max(1, Number(payload.interval) || 5) * 1000
    const expiresIn = Math.max(60, Number(payload.expires_in) || 600) * 1000
    const deadline = Date.now() + Math.min(expiresIn, LOGIN_TIMEOUT_MS)
    let tokenPayload: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await postForm(`${config.account}/oauth2/token`, {
        client_id: MINIMAX_CLIENT_ID,
        device_code: deviceCode,
        code_verifier: pkce.verifier,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
      const body = asRecord(await poll.json().catch(() => null))
      if (poll.ok && asString(body?.access_token)) {
        tokenPayload = body
        break
      }
      const code = asString(body?.error) ?? asString(asRecord(body?.error)?.code)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') {
        interval += 1_000
        continue
      }
      if (code === 'expired_token') throw new Error('MiniMax 授权码已过期，请重新发起登录。')
      if (code === 'access_denied') throw new Error('你取消了 MiniMax 授权。')
      if (poll.status >= 500) continue
      throw new Error(`MiniMax 设备登录失败（HTTP ${poll.status}）。`)
    }
    if (!tokenPayload) throw new Error('MiniMax 浏览器登录超时（10 分钟）。请重新发起登录。')
    const accessToken = asString(tokenPayload.access_token)!
    const refreshToken = asString(tokenPayload.refresh_token)
    if (!refreshToken) throw new Error('MiniMax 登录响应缺少 refresh_token。')
    const expiresInSec = Number(tokenPayload.expires_in)
    const expiresAt = Date.now() + (Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 3_600_000)
    this.persist({
      accessToken,
      refreshToken,
      expiresAt,
      region,
      account: accountFromToken(accessToken, region, expiresAt)
    })
    await this.resetProxy()
    await this.ensureProxy()
    this.ensureProvider()
    this.quota = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    const credential = await this.ensureToken()
    const config = MINIMAX_REGIONS[credential.region]
    let lastStatus = 0
    for (const host of config.quota) {
      const response = await net.fetch(`${host}${MINIMAX_QUOTA_PATH}`, {
        headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(30_000)
      })
      lastStatus = response.status
      if (!response.ok) continue
      this.quota = parseMinimaxQuota(await response.json().catch(() => null))
      return this.quota
    }
    throw new Error(`MiniMax 额度读取失败（HTTP ${lastStatus || '网络错误'}）。`)
  }

  localImportInfo(): { available: boolean; path: string } {
    for (const region of ['cn', 'global'] as const) {
      const path = homePath('.minimax', 'auth', 'prod', region, MINIMAX_CLIENT_ID, 'auth.json')
      if (existsSync(path)) return { available: true, path }
    }
    return { available: false, path: homePath('.minimax', 'auth', 'prod', 'cn', MINIMAX_CLIENT_ID, 'auth.json') }
  }

  async importLocal(): Promise<AgentSubscriptionState> {
    for (const region of ['cn', 'global'] as const) {
      const path = homePath('.minimax', 'auth', 'prod', region, MINIMAX_CLIENT_ID, 'auth.json')
      const parsed = parseMinimaxLocalAuth(readLocalJson(path))
      if (!parsed) continue
      this.persist({
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        region,
        account: {
          ...accountFromToken(parsed.accessToken, region, parsed.expiresAt),
          source: 'local',
          sourcePath: path
        },
        ...(parsed.recordKey ? { recordKey: parsed.recordKey } : {})
      })
      await this.resetProxy()
      await this.ensureProxy()
      this.ensureProvider()
      this.quota = null
      await this.refreshQuota().catch(() => undefined)
      return this.status()
    }
    throw new Error('没有找到本机 MiniMax Code 登录态（~/.minimax/auth/prod/*/mcode-public/auth.json）。')
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    return {
      id: 'minimax',
      name: 'MiniMax Code',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential?.account ? { account: this.credential.account } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : MINIMAX_MODELS,
      enabled: provider?.enabled ?? false,
      login: 'device',
      regionOptions: [
        { value: 'cn', label: '中国站（minimax.cn）' },
        { value: 'global', label: '全球区（minimax.io）' }
      ],
      defaultRegion: this.credential?.region ?? 'cn',
      localImport: this.localImportInfo(),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 MiniMax Code。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(PROVIDER_ID, MINIMAX_MODELS[0]?.id)
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

let instance: MinimaxSubscriptionService | null = null

export function getMinimaxSubscriptionService(): MinimaxSubscriptionService {
  if (!instance) instance = new MinimaxSubscriptionService()
  return instance
}
