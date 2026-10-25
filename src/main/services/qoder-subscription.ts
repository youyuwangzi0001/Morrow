/**
 * Qoder 订阅账号：PAT 兑换、浏览器设备流、本机 qodercli 登录态导入、
 * 额度、本地代理与 Provider 生命周期。协议细节在 qoder-proxy.ts。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { safeStorage, net } from 'electron'
import type { ModelInfo, ProviderConfig } from '../../shared/types'
import type { QoderSubscriptionAccount, QoderSubscriptionQuota, QoderSubscriptionState } from '../../shared/subscriptions'
import { openLoginQuiet } from './external-open'
import {
  QODER_MODELS_CN,
  QODER_MODELS_GLOBAL,
  HOSTS,
  QUOTA_USAGE_PATH,
  JOB_TOKEN_EXCHANGE_PATH,
  USERINFO_PATH,
  REFRESH_TOKEN_PATH,
  COSY_OPENAPI_VERSION,
  COSY_CLIENT_TYPE,
  decodeQoderAdoptPayload,
  startQoderProxy,
  type QoderCredential,
  type QoderModel,
  type QoderProxyHandle,
  type QoderRegion
} from './qoder-proxy'
import { getSettingsStore } from './settings-store'
import { dataPath } from './paths'
import { testProviderConnection } from '../../core/providers'
import { log } from './logger'

const PROVIDER_ID = 'qoder-subscription'
const USER_AGENT = 'morrow-desktop/0.1.0'
const DEVICE_AUTHORIZE_PAGE = 'https://qoder.com/device/selectAccounts'
const DEVICE_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'
const DEVICE_TOKEN_POLL_PATH = '/api/v1/deviceToken/poll'
const QODER_CLI_AUTH_FILE = 'user'
const QODER_CLI_MACHINE_FILE = 'machine_id'

type QoderSource = 'pat' | 'device' | 'local'

interface StoredQoder {
  encrypted: string
  account: QoderSubscriptionAccount
  updatedAt: number
}

interface QoderFile {
  version: 1
  qoder?: StoredQoder
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

function expiresAtFrom(payload: Record<string, unknown>): number {
  const absolute = number(payload.expires_at)
  if (absolute !== undefined && absolute > 0) return absolute < 10_000_000_000 ? absolute * 1000 : absolute
  const seconds = number(payload.expires_in)
  return Date.now() + (seconds && seconds > 0 ? seconds : 24 * 3600) * 1000
}

function toModelInfo(model: QoderModel): ModelInfo {
  return {
    id: model.id,
    label: model.label,
    contextWindow: model.contextWindow,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: model.reasoning,
    ...(model.reasoning ? { reasoningStyle: 'effort' as const } : {}),
    note: 'Qoder 订阅'
  }
}

function parseQuota(payload: unknown): QoderSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const buckets: QoderSubscriptionQuota['buckets'] = []
  const add = (value: unknown, kind: QoderSubscriptionQuota['buckets'][number]['kind']): void => {
    const record = asRecord(value)
    if (!record) return
    const total = number(kind === 'org' ? (record.cap ?? record.total) : record.total)
    const used = number(record.used)
    const remaining = number(record.remaining)
    if (total === undefined && used === undefined && remaining === undefined) return
    buckets.push({
      kind,
      ...(total !== undefined ? { total } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(text(record.unit) ? { unit: text(record.unit) } : {})
    })
  }
  add(root.userQuota, 'personal')
  add(root.addOnQuota, 'add-on')
  add(root.orgResourcePackage, 'org')
  const expires = number(root.expiresAt)
  return {
    buckets,
    ...(expires !== undefined && expires <= 8.64e15 ? { expiresAt: expires } : {}),
    fetchedAt: Date.now(),
    ...(buckets.length === 0 ? { message: '额度接口没有返回可识别的额度桶。' } : {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class QoderSubscriptionService {
  private file: QoderFile = { version: 1 }
  private credential: QoderCredential | null = null
  private proxy: QoderProxyHandle | null = null
  private localToken: string | null = null
  private quotaCache: QoderSubscriptionQuota | null = null
  private lastError: string | null = null
  private refreshing: Promise<QoderCredential> | null = null
  private deviceLogin: { url: string; promise: Promise<QoderSubscriptionState> } | null = null

  constructor() {
    this.file = this.loadFile()
    this.credential = this.loadCredential()
  }

  private filePath(): string {
    return dataPath('qoder-subscription.json')
  }

  private loadFile(): QoderFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath(), 'utf8')) as QoderFile
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
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存 Qoder 登录。')
    return safeStorage.encryptString(value).toString('base64')
  }

  private decrypt(value: string): string {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  }

  private loadCredential(): QoderCredential | null {
    if (!this.file.qoder) return null
    try {
      return JSON.parse(this.decrypt(this.file.qoder.encrypted)) as QoderCredential
    } catch (err) {
      this.lastError = `读取 Qoder 凭据失败：${err instanceof Error ? err.message : String(err)}`
      return null
    }
  }

  private cliPaths(): { auth: string; machine: string } {
    const base = join(process.env.USERPROFILE || homedir(), '.qoder', '.auth')
    return { auth: join(base, QODER_CLI_AUTH_FILE), machine: join(base, QODER_CLI_MACHINE_FILE) }
  }

  private machineId(): string {
    const cli = this.cliPaths().machine
    try {
      if (existsSync(cli)) {
        const value = readFileSync(cli, 'utf8').trim()
        if (value.length === 36) return value
      }
    } catch {
      // 继续用本线路自己的
    }
    const file = dataPath('qoder-machine-id')
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

  private async fetchImpl(url: string, init: RequestInit): Promise<Response> {
    return net.fetch(url, init)
  }

  private async exchangePat(pat: string, region: QoderRegion): Promise<{ token: string; refreshToken?: string; expiresAt: number }> {
    const response = await this.fetchImpl(`${HOSTS[region].openapi}${JOB_TOKEN_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'cosy-version': COSY_OPENAPI_VERSION,
        'cosy-clienttype': COSY_CLIENT_TYPE,
        'user-agent': USER_AGENT
      },
      body: JSON.stringify({ personal_token: pat })
    })
    if (!response.ok) throw new Error(`Qoder PAT 兑换失败（HTTP ${response.status}）。请确认 PAT 未过期、区域选择正确。`)
    const payload = asRecord(await response.json().catch(() => null))
    const token = text(payload?.token)
    if (!payload || !token) throw new Error('Qoder PAT 兑换响应里没有 token。')
    return {
      token,
      ...(text(payload.refresh_token) ? { refreshToken: text(payload.refresh_token) } : {}),
      expiresAt: expiresAtFrom(payload)
    }
  }

  private async userInfo(accessToken: string, region: QoderRegion): Promise<{
    uid: string
    email?: string
    name?: string
    organizationId?: string
    organizationTags?: string[]
    dataPolicyAgreed: boolean
    raw: string
  }> {
    const response = await this.fetchImpl(`${HOSTS[region].openapi}${USERINFO_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': USER_AGENT }
    })
    if (!response.ok) throw new Error(`Qoder userinfo 读取失败（HTTP ${response.status}）。`)
    const raw = await response.text()
    const payload = asRecord(JSON.parse(raw) as unknown) ?? {}
    const tags = Array.isArray(payload.organization_tags)
      ? payload.organization_tags.filter((item): item is string => typeof item === 'string' && Boolean(item))
      : undefined
    return {
      uid: text(payload.id) ?? text(payload.uid) ?? '',
      ...(text(payload.email) ? { email: text(payload.email) } : {}),
      ...(text(payload.name) ?? text(payload.username) ? { name: text(payload.name) ?? text(payload.username) } : {}),
      ...(text(payload.organization_id) ? { organizationId: text(payload.organization_id) } : {}),
      ...(tags?.length ? { organizationTags: tags } : {}),
      dataPolicyAgreed: payload.data_policy_agreed === true,
      raw
    }
  }

  private async refreshToken(): Promise<QoderCredential> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const current = this.credential
      if (!current) throw new Error('还没有登录 Qoder。')
      if (current.personalToken) {
        const exchanged = await this.exchangePat(current.personalToken, current.region)
        const user = await this.userInfo(exchanged.token, current.region)
        return this.persist({
          ...current,
          accessToken: exchanged.token,
          refreshToken: exchanged.refreshToken ?? current.refreshToken,
          expiresAt: exchanged.expiresAt,
          uid: user.uid || current.uid,
          rawUserInfo: user.raw,
          dataPolicyAgreed: user.dataPolicyAgreed,
          email: user.email ?? current.email,
          name: user.name ?? current.name,
          organizationId: user.organizationId ?? current.organizationId,
          organizationTags: user.organizationTags ?? current.organizationTags
        })
      }
      if (!current.refreshToken) throw new Error('Qoder 登录已过期，请重新登录。')
      const response = await this.fetchImpl(`${HOSTS[current.region].center}${REFRESH_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${current.accessToken}`, 'user-agent': USER_AGENT },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      })
      if (!response.ok) throw new Error(`Qoder 令牌刷新失败（HTTP ${response.status}），请重新登录。`)
      const payload = asRecord(await response.json().catch(() => null))
      const token = text(payload?.token)
      if (!payload || !token) throw new Error('Qoder 刷新响应里没有 token。')
      return this.persist({
        ...current,
        accessToken: token,
        refreshToken: text(payload.refresh_token) ?? current.refreshToken,
        expiresAt: expiresAtFrom(payload)
      })
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private persist(credential: QoderCredential, source?: QoderSource, sourcePath?: string): QoderCredential {
    this.credential = credential
    const previous = this.file.qoder?.account
    const account: QoderSubscriptionAccount = {
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.name ? { name: credential.name } : {}),
      uid: credential.uid,
      region: credential.region,
      expiresAt: credential.expiresAt,
      ...(source ?? previous?.source ? { source: source ?? previous?.source } : {}),
      ...(sourcePath ?? previous?.sourcePath ? { sourcePath: sourcePath ?? previous?.sourcePath } : {})
    }
    this.file.qoder = { encrypted: this.encrypt(JSON.stringify(credential)), account, updatedAt: Date.now() }
    this.saveFile()
    return credential
  }

  private models(region: QoderRegion): QoderModel[] {
    return region === 'cn' ? QODER_MODELS_CN : QODER_MODELS_GLOBAL
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    if (!this.credential) throw new Error('还没有登录 Qoder。')
    const existing = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    this.localToken = existing ? getSettingsStore().getApiKey(PROVIDER_ID) : null
    if (!this.localToken) this.localToken = randomBytes(32).toString('base64url')
    const models = this.models(this.credential.region)
    this.proxy = await startQoderProxy({
      localToken: this.localToken,
      models,
      getCredential: async () => {
        if (!this.credential) throw new Error('Qoder 登录已丢失。')
        if (this.credential.expiresAt - Date.now() < 3600_000) return this.refreshToken()
        return this.credential
      },
      refreshCredential: () => this.refreshToken(),
      fetchImpl: (url, init) => this.fetchImpl(url, init)
    })
    log.info('qoder subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken || !this.credential) throw new Error('Qoder 代理没有启动。')
    const existing = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    const config: ProviderConfig = {
      id: PROVIDER_ID,
      kind: 'openai-compat',
      name: 'Qoder（订阅）',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: this.models(this.credential.region).map(toModelInfo),
      category: 'custom',
      apiKeyStored: true,
      enabled: existing?.enabled ?? true
    }
    getSettingsStore().saveProvider(config, this.localToken)
  }

  async restore(): Promise<void> {
    if (!this.credential) return
    try {
      await this.ensureProxy()
      this.ensureProvider()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      log.warn('qoder subscription restore failed', { error: this.lastError })
    }
  }

  async loginPat(pat: string, region: QoderRegion): Promise<QoderSubscriptionState> {
    const trimmed = pat.trim()
    if (!trimmed) throw new Error('请粘贴 Qoder PAT。')
    const exchanged = await this.exchangePat(trimmed, region)
    const user = await this.userInfo(exchanged.token, region)
    const credential: QoderCredential = {
      accessToken: exchanged.token,
      refreshToken: exchanged.refreshToken,
      personalToken: trimmed,
      expiresAt: exchanged.expiresAt,
      region,
      uid: user.uid || 'qoder-user',
      rawUserInfo: user.raw,
      dataPolicyAgreed: user.dataPolicyAgreed,
      email: user.email,
      name: user.name,
      organizationId: user.organizationId,
      organizationTags: user.organizationTags,
      machineId: this.machineId()
    }
    this.persist(credential, 'pat')
    await this.ensureProxy()
    this.ensureProvider()
    this.quotaCache = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  pendingLoginUrl(): string | null {
    return this.deviceLogin?.url ?? null
  }

  async loginDevice(): Promise<QoderSubscriptionState> {
    if (this.deviceLogin) {
      openLoginQuiet(this.deviceLogin.url)
      return this.deviceLogin.promise
    }
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const nonce = randomUUID()
    const machineId = this.machineId()
    const url = new URL(DEVICE_AUTHORIZE_PAGE)
    url.searchParams.set('challenge', challenge)
    url.searchParams.set('challenge_method', 'S256')
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('machine_id', machineId)
    url.searchParams.set('client_id', DEVICE_CLIENT_ID)
    const login = {
      url: url.toString(),
      promise: this.runDeviceLogin(url.toString(), verifier, nonce, machineId)
    }
    this.deviceLogin = login
    try {
      return await login.promise
    } finally {
      if (this.deviceLogin === login) this.deviceLogin = null
    }
  }

  private async runDeviceLogin(url: string, verifier: string, nonce: string, machineId: string): Promise<QoderSubscriptionState> {
    openLoginQuiet(url)
    const deadline = Date.now() + 5 * 60_000
    let ready: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await sleep(2_000)
      const pollUrl = new URL(`${HOSTS.global.openapi}${DEVICE_TOKEN_POLL_PATH}`)
      pollUrl.searchParams.set('nonce', nonce)
      pollUrl.searchParams.set('verifier', verifier)
      pollUrl.searchParams.set('challenge_method', 'S256')
      const response = await this.fetchImpl(pollUrl.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      })
      if (response.status === 404 || response.status === 202) continue
      if (!response.ok) throw new Error(`Qoder 设备登录轮询失败（HTTP ${response.status}）。`)
      ready = asRecord(await response.json().catch(() => null))
      if (!ready || !text(ready.token)) throw new Error('Qoder 设备登录响应里没有 token。')
      break
    }
    if (!ready) throw new Error('Qoder 浏览器登录超时（5 分钟）。请重新发起登录。')
    const token = text(ready.token)!
    let info: Awaited<ReturnType<QoderSubscriptionService['userInfo']>> | null = null
    try {
      info = await this.userInfo(token, 'global')
    } catch {
      // 设备流本身已经给了 user_id；资料补齐失败不影响登录
    }
    const credential: QoderCredential = {
      accessToken: token,
      ...(text(ready.refresh_token) ? { refreshToken: text(ready.refresh_token) } : {}),
      expiresAt: expiresAtFrom(ready),
      region: 'global',
      uid: text(ready.user_id) ?? info?.uid ?? 'qoder-user',
      rawUserInfo: info?.raw ?? '',
      dataPolicyAgreed: info?.dataPolicyAgreed === true,
      ...(info?.email ? { email: info.email } : {}),
      ...(info?.name ? { name: info.name } : {}),
      ...(info?.organizationId ? { organizationId: info.organizationId } : {}),
      ...(info?.organizationTags?.length ? { organizationTags: info.organizationTags } : {}),
      machineId
    }
    this.persist(credential, 'device')
    await this.ensureProxy()
    this.ensureProvider()
    this.quotaCache = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  async importLocal(): Promise<QoderSubscriptionState> {
    const paths = this.cliPaths()
    if (!existsSync(paths.auth) || !existsSync(paths.machine)) {
      throw new Error('本机没有找到 qodercli 登录态（需要 ~/.qoder/.auth/user 与 machine_id）。请先在 Qoder CLI 登录，或改用 PAT / 浏览器登录。')
    }
    const machineId = readFileSync(paths.machine, 'utf8').trim()
    if (machineId.length < 16) throw new Error('qodercli 的 machine_id 文件无效。')
    let parsed: Record<string, unknown>
    try {
      const plaintext = decodeQoderAdoptPayload(readFileSync(paths.auth, 'utf8'), machineId)
      parsed = asRecord(JSON.parse(plaintext) as unknown) ?? {}
    } catch (err) {
      throw new Error(`qodercli 登录态读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
    const accessToken = text(parsed.access_token) ?? text(parsed.security_oauth_token)
    if (!accessToken) throw new Error('qodercli 登录态里没有 access_token。')
    let region: QoderRegion | null = null
    let info: Awaited<ReturnType<QoderSubscriptionService['userInfo']>> | null = null
    for (const candidate of ['global', 'cn'] as const) {
      try {
        info = await this.userInfo(accessToken, candidate)
        region = candidate
        break
      } catch {
        // 这一区不认，试下一区
      }
    }
    if (!region || !info) throw new Error('qodercli 登录态已失效（全球区与中国站都不认这把 token），请重新登录。')
    const tags = info.organizationTags?.length
      ? info.organizationTags
      : Array.isArray(parsed.organization_tags)
        ? parsed.organization_tags.filter((item): item is string => typeof item === 'string' && Boolean(item))
        : undefined
    const credential: QoderCredential = {
      accessToken,
      ...(text(parsed.refresh_token) ? { refreshToken: text(parsed.refresh_token) } : {}),
      expiresAt: expiresAtFrom({ expires_at: parsed.expire_time ?? parsed.expires_at, expires_in: parsed.expires_in }),
      region,
      uid: info.uid || text(parsed.uid) || 'qoder-user',
      rawUserInfo: info.raw,
      dataPolicyAgreed: info.dataPolicyAgreed || parsed.data_policy_agreed === true,
      ...(info.email ?? text(parsed.email) ? { email: info.email ?? text(parsed.email) } : {}),
      ...(info.name ?? text(parsed.name) ? { name: info.name ?? text(parsed.name) } : {}),
      ...(info.organizationId ?? text(parsed.organization_id)
        ? { organizationId: info.organizationId ?? text(parsed.organization_id) }
        : {}),
      ...(tags?.length ? { organizationTags: tags } : {}),
      machineId
    }
    this.persist(credential, 'local', paths.auth)
    await this.ensureProxy()
    this.ensureProvider()
    this.quotaCache = null
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  async refreshQuota(): Promise<QoderSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有登录 Qoder。')
    const response = await this.fetchImpl(`${HOSTS[this.credential.region].openapi}${QUOTA_USAGE_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${this.credential.accessToken}`, 'user-agent': USER_AGENT }
    })
    if (response.status === 401) {
      await this.refreshToken()
      return this.refreshQuota()
    }
    if (!response.ok) throw new Error(`Qoder 额度读取失败（HTTP ${response.status}）。`)
    this.quotaCache = parseQuota(await response.json().catch(() => null))
    return this.quotaCache
  }

  async status(): Promise<QoderSubscriptionState> {
    const settings = getSettingsStore().get()
    const provider = settings.providers.find((item) => item.id === PROVIDER_ID)
    let quota = this.quotaCache
    if (quota && Date.now() - quota.fetchedAt > 60_000) quota = null
    if (!quota && this.credential && this.proxy) {
      try {
        quota = await this.refreshQuota()
        this.lastError = null
      } catch (err) {
        quota = { buckets: [], fetchedAt: Date.now(), message: err instanceof Error ? err.message : String(err) }
      }
    }
    const paths = this.cliPaths()
    const localAvailable = existsSync(paths.auth) && existsSync(paths.machine)
    return {
      available: true,
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.file.qoder?.account ? { account: this.file.qoder.account } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : this.credential ? this.models(this.credential.region).map(toModelInfo) : [],
      enabled: provider?.enabled ?? false,
      patUrl: HOSTS[this.credential?.region ?? 'cn'].pat,
      localImport: { available: localAvailable, path: paths.auth },
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<QoderSubscriptionState> {
    let provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    if (!provider && enabled && this.credential) {
      await this.ensureProxy()
      this.ensureProvider()
      provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
    }
    if (!provider) throw new Error('Qoder Provider 尚未创建。')
    getSettingsStore().saveProvider({ ...provider, enabled }, getSettingsStore().getApiKey(PROVIDER_ID) ?? undefined)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = Date.now()
    try {
      const provider = getSettingsStore().get().providers.find((item) => item.id === PROVIDER_ID)
      if (!provider) throw new Error('Qoder Provider 不存在。')
      const result = await testProviderConnection(provider, getSettingsStore().getApiKey(PROVIDER_ID), provider.models[0]?.id)
      return { ...result, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async remove(): Promise<QoderSubscriptionState> {
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

let instance: QoderSubscriptionService | null = null

export function getQoderSubscriptionService(): QoderSubscriptionService {
  if (!instance) instance = new QoderSubscriptionService()
  return instance
}
