/**
 * Kimi Code 订阅：RFC 8628 设备流、令牌刷新、额度与账号；
 * 本地回环代理把 Morrow 的 Chat Completions 请求改写成 Kimi 编码规则后转发。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, release, type, arch } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { safeStorage, net } from 'electron'
import type { ProviderConfig } from '../../shared/types'
import type {
  AgentSubscriptionAccount,
  AgentSubscriptionQuota,
  AgentSubscriptionState
} from '../../shared/subscriptions'
import { getSettingsStore } from './settings-store'
import { dataPath } from './paths'
import { startSubscriptionRelay, type SubscriptionRelayHandle } from './subscription-relay'
import { openLoginUrl } from './external-open'
import { KIMI_MODELS, parseKimiQuota, rewriteKimiBody } from './kimi-protocol'
import { testProviderConnection } from '../../core/providers'
import { log } from './logger'

const PROVIDER_ID = 'kimi-subscription'
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const UA = 'morrow-desktop/0.1.0 kimi_code_cli/1.0.0'
const AUTH_HOSTS = { cn: 'https://auth.kimi.com', global: 'https://auth.kimi.ai' } as const
const CODING_HOSTS = { cn: 'https://api.kimi.com/coding', global: 'https://api.kimi.ai/coding' } as const
const SCOPE = 'kimi-code'
const REFRESH_MARGIN_MS = 5 * 60_000
const QUOTA_CACHE_MS = 2 * 60_000

export type KimiRegion = 'cn' | 'global'

interface KimiCredential {
  accessToken: string
  refreshToken: string
  expiresAt: number
  expiresIn: number
  scope: string
  tokenType: string
  region: KimiRegion
  deviceId: string
  uid?: string
  email?: string
  name?: string
  plan?: string
}

interface StoredKimi {
  encrypted: string
  account: AgentSubscriptionAccount
  updatedAt: number
}

interface KimiFile {
  version: 1
  kimi?: StoredKimi
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function jwtClaims(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function identityValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class KimiSubscriptionService {
  private file: KimiFile = { version: 1 }
  private credential: KimiCredential | null = null
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quotaCache: AgentSubscriptionQuota | null = null
  private lastError: string | null = null
  private refreshing: Promise<KimiCredential> | null = null

  constructor() {
    this.file = this.loadFile()
    this.credential = this.loadCredential()
  }

  private filePath(): string {
    return dataPath('kimi-subscription.json')
  }

  private loadFile(): KimiFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(), 'utf8')) as KimiFile
      return parsed?.version === 1 ? parsed : { version: 1 }
    } catch {
      return { version: 1 }
    }
  }

  private saveFile(): void {
    mkdirSync(dataPath(), { recursive: true })
    writeFileSync(this.filePath(), `${JSON.stringify(this.file, null, 2)}\n`, 'utf8')
  }

  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存 Kimi 登录。')
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private loadCredential(): KimiCredential | null {
    if (!this.file.kimi) return null
    try {
      const parsed = JSON.parse(this.decrypt(this.file.kimi.encrypted)) as KimiCredential
      return parsed.accessToken && parsed.refreshToken ? parsed : null
    } catch (err) {
      this.lastError = `读取 Kimi 凭据失败：${err instanceof Error ? err.message : String(err)}`
      return null
    }
  }

  private deviceId(): string {
    const file = dataPath('kimi-device-id')
    try {
      if (existsSync(file)) {
        const value = readFileSync(file, 'utf8').trim()
        if (value.length === 36) return value
      }
    } catch {
      // 生成新的
    }
    const generated = randomUUID()
    try {
      mkdirSync(dataPath(), { recursive: true })
      writeFileSync(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 内存身份仍一致
    }
    return generated
  }

  private identityHeaders(): Record<string, string> {
    const values: Record<string, string> = {
      'user-agent': UA,
      'x-msh-platform': 'kimi_code_cli',
      'x-msh-version': '1.0.0',
      'x-msh-device-name': identityValue(hostname()),
      'x-msh-device-model': identityValue(`${type()} ${release()} ${arch()}`),
      'x-msh-os-version': identityValue(release()),
      'x-msh-device-id': this.deviceId()
    }
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))
  }

  private async fetchImpl(url: string, init: RequestInit): Promise<Response> {
    return net.fetch(url, init)
  }

  private async postForm(url: string, fields: Record<string, string>): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...this.identityHeaders(),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: new URLSearchParams(fields).toString()
    })
  }

  private tokenFromPayload(payload: Record<string, unknown>, region: KimiRegion): KimiCredential {
    const accessToken = text(payload.access_token)
    const refreshToken = text(payload.refresh_token)
    const expiresIn = number(payload.expires_in)
    if (!accessToken || !refreshToken || !expiresIn || expiresIn <= 0) {
      throw new Error('Kimi 登录响应缺少 access_token / refresh_token / expires_in。')
    }
    const claims = jwtClaims(accessToken) ?? jwtClaims(refreshToken) ?? {}
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      expiresIn,
      scope: text(payload.scope) ?? SCOPE,
      tokenType: text(payload.token_type) ?? 'Bearer',
      region,
      deviceId: this.deviceId(),
      ...(text(claims.user_id) ?? text(claims.sub) ? { uid: text(claims.user_id) ?? text(claims.sub) } : {}),
      ...(text(claims.email) ? { email: text(claims.email) } : {}),
      ...(text(claims.name) ?? text(claims.nickname) ? { name: text(claims.name) ?? text(claims.nickname) } : {})
    }
  }

  private persist(credential: KimiCredential): KimiCredential {
    this.credential = credential
    const account: AgentSubscriptionAccount = {
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.name ? { name: credential.name } : {}),
      ...(credential.uid ? { uid: credential.uid } : {}),
      ...(credential.plan ? { plan: credential.plan } : {}),
      region: credential.region === 'cn' ? '中国站' : '全球区',
      expiresAt: credential.expiresAt,
      source: 'device'
    }
    this.file.kimi = { encrypted: this.encrypt(JSON.stringify(credential)), account, updatedAt: Date.now() }
    this.saveFile()
    return credential
  }

  private async ensureToken(): Promise<KimiCredential> {
    if (!this.credential) throw new Error('还没有登录 Kimi Code。')
    const remaining = this.credential.expiresAt - Date.now()
    const refreshAt = Math.max(REFRESH_MARGIN_MS, this.credential.expiresIn * 500)
    if (remaining <= refreshAt) return this.refreshToken()
    return this.credential
  }

  private async refreshToken(): Promise<KimiCredential> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const current = this.credential
      if (!current) throw new Error('还没有登录 Kimi Code。')
      let response: Response | null = null
      let transient = ''
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const candidate = await this.postForm(`${AUTH_HOSTS[current.region]}/api/oauth/token`, {
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken
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
      if (!response) throw new Error(`Kimi 刷新暂时失败：${transient || '网络错误'}，请稍后重试。`)
      const payload = asRecord(await response.json().catch(() => null))
      if (!response.ok || !payload?.access_token || !payload.refresh_token) {
        throw new Error(`Kimi 登录已失效（HTTP ${response.status}），请重新登录。`)
      }
      const next = this.tokenFromPayload(payload, current.region)
      return this.persist({
        ...next,
        ...(next.uid ?? current.uid ? { uid: next.uid ?? current.uid } : {}),
        ...(next.email ?? current.email ? { email: next.email ?? current.email } : {}),
        ...(next.name ?? current.name ? { name: next.name ?? current.name } : {}),
        ...(current.plan ? { plan: current.plan } : {})
      })
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    if (!this.credential) throw new Error('还没有登录 Kimi Code。')
    const existing = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    this.localToken = existing ? getSettingsStore().getApiKey(PROVIDER_ID) : null
    if (!this.localToken) this.localToken = randomBytes(32).toString('base64url')
    const region = this.credential.region
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken,
      resolveUpstream: (path) => `${CODING_HOSTS[region]}${path}`,
      getHeaders: async () => {
        const credential = await this.ensureToken()
        return { ...this.identityHeaders(), authorization: `Bearer ${credential.accessToken}`, accept: 'text/event-stream' }
      },
      refresh: async () => {
        await this.refreshToken()
      },
      rewriteBody: (body) => rewriteKimiBody(body)
    })
    log.info('kimi subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken) throw new Error('Kimi 订阅代理没有启动。')
    const existing = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    const config: ProviderConfig = {
      id: PROVIDER_ID,
      kind: 'openai-compat',
      name: 'Kimi Code（订阅）',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: KIMI_MODELS,
      category: 'custom',
      apiKeyStored: true,
      enabled: existing?.enabled ?? true
    }
    getSettingsStore().saveProvider(config, this.localToken)
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
        this.lastError = err instanceof Error ? err.message : String(err)
      })
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      log.warn('kimi subscription restore failed', { error: this.lastError })
    }
  }

  async loginDevice(region: KimiRegion = 'cn'): Promise<AgentSubscriptionState> {
    const auth = AUTH_HOSTS[region]
    const response = await this.postForm(`${auth}/api/oauth/device_authorization`, { client_id: CLIENT_ID })
    const payload = asRecord(await response.json().catch(() => null))
    if (!response.ok || !payload) throw new Error(`Kimi 设备授权失败（HTTP ${response.status}）。`)
    const deviceCode = text(payload.device_code)
    const verification = text(payload.verification_uri_complete) ?? text(payload.verification_uri)
    if (!deviceCode || !verification) throw new Error('Kimi 设备授权响应缺少 device_code 或授权地址。')
    const opened = await openLoginUrl(verification)
    if (!opened.opened) throw new Error(`无法打开浏览器；授权链接已复制：${verification}`)
    let interval = Math.max(1, number(payload.interval) ?? 5) * 1000
    const expiresIn = Math.max(30, number(payload.expires_in) ?? 600) * 1000
    const deadline = Date.now() + Math.min(expiresIn, 10 * 60_000)
    let tokenPayload: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await this.postForm(`${auth}/api/oauth/token`, {
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
      const body = asRecord(await poll.json().catch(() => null))
      if (poll.ok && text(body?.access_token)) {
        tokenPayload = body
        break
      }
      const errorObject = asRecord(body?.error)
      const code = text(body?.error) ?? text(errorObject?.code)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') {
        interval += 5_000
        continue
      }
      if (code === 'expired_token') throw new Error('Kimi 授权码已过期，请重新发起登录。')
      if (code === 'access_denied') throw new Error('你取消了 Kimi 授权。')
      if (poll.status >= 500) continue
      throw new Error(`Kimi 设备登录失败（HTTP ${poll.status}）${text(errorObject?.message) ? `：${text(errorObject?.message)}` : ''}`)
    }
    if (!tokenPayload) throw new Error('Kimi 浏览器登录超时（10 分钟）。请重新发起登录。')
    const credential = this.tokenFromPayload(tokenPayload, region)
    this.persist(credential)
    await this.resetProxy()
    await this.ensureProxy()
    this.ensureProvider()
    this.quotaCache = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有登录 Kimi Code。')
    const credential = await this.ensureToken()
    const response = await this.fetchImpl(`${CODING_HOSTS[credential.region]}/v1/usages`, {
      headers: { ...this.identityHeaders(), authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' }
    })
    if (response.status === 401) {
      await this.refreshToken()
      return this.refreshQuota()
    }
    if (!response.ok) throw new Error(`Kimi 额度读取失败（HTTP ${response.status}）。`)
    this.quotaCache = parseKimiQuota(await response.json().catch(() => null))
    await this.refreshProfile().catch(() => undefined)
    return this.quotaCache
  }

  private async refreshProfile(): Promise<void> {
    if (!this.credential) return
    const credential = await this.ensureToken()
    const response = await this.fetchImpl(`${CODING_HOSTS[credential.region]}/v1/me`, {
      headers: { ...this.identityHeaders(), authorization: `Bearer ${credential.accessToken}`, accept: 'application/json' }
    })
    if (!response.ok) return
    const payload = asRecord(await response.json().catch(() => null))
    const info = asRecord(payload?.data) && asRecord(asRecord(payload?.data)?.userInfo)
      ? asRecord(asRecord(payload?.data)?.userInfo)!
      : asRecord(payload?.userInfo) ?? payload ?? {}
    const plan = text(info.user_level_name) ?? text(info.user_level)
    const email = text(info.email)
    const name = text(info.nickname) ?? text(info.name)
    const uid = text(info.user_id) ?? text(info.global_id)
    if (!plan && !email && !name && !uid) return
    const current = this.credential
    if (!current) return
    this.persist({
      ...current,
      ...(plan ? { plan } : {}),
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(uid ? { uid } : {})
    })
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    let quota = this.quotaCache
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    return {
      id: 'kimi',
      name: 'Kimi Code',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.file.kimi?.account ? { account: this.file.kimi.account } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : KIMI_MODELS,
      enabled: provider?.enabled ?? false,
      login: 'device',
      regionOptions: [
        { value: 'cn', label: '中国站（kimi.com）' },
        { value: 'global', label: '全球区（kimi.ai）' }
      ],
      defaultRegion: this.credential?.region ?? 'cn',
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    let provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    if (!provider && enabled && this.credential) {
      await this.ensureProxy()
      this.ensureProvider()
      provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    }
    if (!provider) throw new Error('Kimi Provider 尚未创建。')
    getSettingsStore().saveProvider({ ...provider, enabled }, getSettingsStore().getApiKey(PROVIDER_ID) ?? undefined)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = Date.now()
    try {
      const provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
      if (!provider) throw new Error('Kimi Provider 不存在。')
      const result = await testProviderConnection(provider, getSettingsStore().getApiKey(PROVIDER_ID), KIMI_MODELS[0]?.id)
      return { ...result, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async remove(): Promise<AgentSubscriptionState> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
    this.credential = null
    this.localToken = null
    this.quotaCache = null
    this.lastError = null
    this.file = { version: 1 }
    this.saveFile()
    try {
      getSettingsStore().removeProvider(PROVIDER_ID)
    } catch {
      // 已手动删除
    }
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let instance: KimiSubscriptionService | null = null

export function getKimiSubscriptionService(): KimiSubscriptionService {
  if (!instance) instance = new KimiSubscriptionService()
  return instance
}
