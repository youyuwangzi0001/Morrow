/**
 * GLM Coding Plan（ZCode）订阅：浏览器轮询登录 → 业务 token → Coding Plan Key 兑换 →
 * 本地 Anthropic 兼容代理。GLM 的 OAuth 没有 refresh 交换接口，Coding Plan Key 本身是长期凭据，
 * 因此「刷新」只刷新额度；Key 被拒时要求重新登录。
 */
import { randomBytes } from 'node:crypto'
import { net } from 'electron'
import type { AgentSubscriptionAccount, AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import { getSettingsStore } from './settings-store'
import type { ModelInfo } from '../../shared/types'
import type { SubscriptionRelayHandle } from './subscription-relay'
import { startSubscriptionRelay } from './subscription-relay'
import {
  GLM_KEY_NAME,
  GLM_MODELS,
  GLM_REGIONS,
  ZCODE_API_BASE,
  CLI_INIT_PATH,
  CLI_POLL_PATH,
  ANTHROPIC_PATH,
  QUOTA_PATH,
  parseCustomerScope,
  parseGlmQuota,
  pickGlmApiKey,
  rewriteGlmBody,
  type GlmRegion
} from './glm-protocol'
import {
  asRecord,
  asString,
  errorText,
  getProvider,
  openExternal,
  randomLocalToken,
  removeProvider,
  saveLoopbackProvider,
  SecureJsonStore,
  setProviderEnabled,
  sleep,
  testSubscriptionProvider
} from './agent-subscription-common'
import { log } from './logger'

const PROVIDER_ID = 'glm-subscription'
const QUOTA_CACHE_MS = 2 * 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 30_000

interface GlmCredential {
  region: GlmRegion
  codingKey: string
  apiKeyId: string
  secretKey: string
  accessToken: string
  organizationId: string
  projectId: string
  planLevel?: string
  account?: AgentSubscriptionAccount
  savedAt: number
}

function regionOf(value: string | undefined): GlmRegion {
  return value === 'cn' ? 'cn' : 'intl'
}

async function request(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  return net.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

function unwrap(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload) ?? {}
  return asRecord(root.data) ?? root
}

function bizCode(payload: unknown): number | string | undefined {
  const root = asRecord(payload) ?? {}
  const raw = root.code ?? root.status
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return undefined
}

function bizOk(payload: unknown): boolean {
  const code = bizCode(payload)
  return code === undefined || code === 0 || code === 200 || code === '0' || code === '200'
}

async function bizJson(url: string, authorization: string, body?: unknown): Promise<unknown> {
  const response = await request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(authorization ? { authorization } : {}),
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`GLM 兑换失败（HTTP ${response.status}）。`)
  if (!bizOk(payload)) {
    const root = asRecord(payload) ?? {}
    throw new Error(`GLM 兑换被拒绝：${asString(root.msg) ?? asString(root.message) ?? String(bizCode(payload))}`)
  }
  return asRecord(payload)?.data ?? payload
}

export class GlmSubscriptionService {
  private store = new SecureJsonStore<GlmCredential>('glm-subscription.json')
  private credential: GlmCredential | null = this.store.load()
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null

  private async readQuota(credential = this.credential): Promise<AgentSubscriptionQuota> {
    if (!credential) throw new Error('还没有登录 GLM Coding Plan。')
    const region = GLM_REGIONS[credential.region]
    const response = await request(`${region.business}${QUOTA_PATH}`, {
      headers: { authorization: credential.codingKey, accept: 'application/json' }
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error('GLM Coding Plan Key 已失效，请重新登录。')
    }
    if (!response.ok) throw new Error(`GLM 额度读取失败（HTTP ${response.status}）。`)
    const payload: unknown = await response.json().catch(() => null)
    const data = asRecord(asRecord(payload)?.data)
    const level = asString(data?.level)
    if (level && credential.planLevel !== level) {
      credential.planLevel = level
      this.store.save(credential)
    }
    this.quota = parseGlmQuota(payload)
    return this.quota
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    const credential = this.credential
    if (!credential) throw new Error('还没有登录 GLM Coding Plan。')
    this.localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    const region = GLM_REGIONS[credential.region]
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken!,
      fetchImpl: (url, init) => net.fetch(url, init),
      resolveUpstream: (path) => `${region.api}${ANTHROPIC_PATH}${path}`,
      getHeaders: () => ({
        'x-api-key': credential.codingKey,
        authorization: `Bearer ${credential.codingKey}`,
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream'
      }),
      rewriteBody: rewriteGlmBody
    })
    log.info('glm subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken) throw new Error('GLM 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'GLM Coding Plan（订阅）',
      kind: 'anthropic',
      port,
      models: GLM_MODELS,
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
      void this.readQuota().catch((err) => {
        this.lastError = errorText(err)
      })
    } catch (err) {
      this.lastError = errorText(err)
      log.warn('glm subscription restore failed', { error: this.lastError })
    }
  }

  async login(regionValue: string | undefined): Promise<AgentSubscriptionState> {
    const region = regionOf(regionValue)
    const config = GLM_REGIONS[region]
    const pollToken = randomBytes(32).toString('hex')
    const initResponse = await request(`${ZCODE_API_BASE}${CLI_INIT_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pollToken}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ provider: config.cliProvider })
    })
    const initPayload: unknown = await initResponse.json().catch(() => null)
    if (!initResponse.ok) throw new Error(`GLM 登录初始化失败（HTTP ${initResponse.status}）。`)
    if (!bizOk(initPayload)) throw new Error('GLM 登录初始化被拒绝。')
    const init = unwrap(initPayload)
    const flowId = asString(init.flow_id)
    const authorizeUrl = asString(init.authorize_url)
    if (!flowId || !authorizeUrl) throw new Error('GLM 登录响应缺少 flow_id 或授权地址。')
    openExternal(authorizeUrl)
    const interval = Math.max(1, Number(init.poll_interval_sec) || 2) * 1000
    const serverDeadline = Number(init.expires_at) > 0 ? Number(init.expires_at) * 1000 : Number.POSITIVE_INFINITY
    const deadline = Math.min(Date.now() + LOGIN_TIMEOUT_MS, serverDeadline)
    let accessToken: string | undefined
    let user: Record<string, unknown> = {}
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await request(`${ZCODE_API_BASE}${CLI_POLL_PATH}/${encodeURIComponent(flowId)}`, {
        headers: { authorization: `Bearer ${pollToken}`, accept: 'application/json' }
      })
      if (!poll.ok) {
        if (poll.status >= 500) continue
        throw new Error(`GLM 登录轮询失败（HTTP ${poll.status}）。`)
      }
      const payload: unknown = await poll.json().catch(() => null)
      if (!bizOk(payload)) throw new Error('GLM 登录轮询被拒绝。')
      const body = unwrap(payload)
      const status = asString(body.status)
      if (status === 'pending') continue
      if (status && status !== 'ready') throw new Error(`GLM 登录返回了未知状态：${status}。`)
      const provider = asRecord(body[config.cliProvider]) ?? asRecord(body.credential) ?? body
      accessToken = asString(provider.access_token)
      user = asRecord(body.user) ?? {}
      if (!accessToken) continue
      break
    }
    if (!accessToken) throw new Error('GLM 浏览器登录超时（5 分钟）。请重新发起登录。')

    const scope = await this.exchangeKey(region, accessToken)
    const quota = await this.readQuotaRaw(region, scope.codingKey)
    const account: AgentSubscriptionAccount = {
      ...(asString(user.email) ? { email: asString(user.email) } : {}),
      ...(asString(user.name) ?? asString(user.nickname) ? { name: asString(user.name) ?? asString(user.nickname) } : {}),
      ...(asString(user.user_id) ? { uid: asString(user.user_id) } : {}),
      ...(scope.planLevel ? { plan: scope.planLevel } : {}),
      region: config.label,
      source: 'browser'
    }
    const credential: GlmCredential = {
      region,
      codingKey: scope.codingKey,
      apiKeyId: scope.apiKeyId,
      secretKey: scope.secretKey,
      accessToken,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      ...(scope.planLevel ? { planLevel: scope.planLevel } : {}),
      account,
      savedAt: Date.now()
    }
    this.credential = credential
    this.store.save(credential)
    this.quota = quota
    this.lastError = null
    await this.resetProxy()
    await this.ensureProxy()
    this.ensureProvider()
    return this.status()
  }

  private async readQuotaRaw(regionValue: GlmRegion, codingKey: string): Promise<AgentSubscriptionQuota> {
    const region = GLM_REGIONS[regionValue]
    const response = await request(`${region.business}${QUOTA_PATH}`, {
      headers: { authorization: codingKey, accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`这把 Key 不能服务 GLM Coding Plan（额度接口 HTTP ${response.status}）。`)
    const payload: unknown = await response.json().catch(() => null)
    return parseGlmQuota(payload)
  }

  private async exchangeKey(region: GlmRegion, accessToken: string): Promise<{
    codingKey: string
    apiKeyId: string
    secretKey: string
    organizationId: string
    projectId: string
    organizationName?: string
    planLevel?: string
  }> {
    const config = GLM_REGIONS[region]
    let authorization: string
    if (region === 'cn') {
      authorization = accessToken
    } else {
      const login = asRecord(await bizJson(`${config.business}/api/auth/z/login`, '', { token: accessToken }))
      const bizToken = asString(login?.access_token) ?? asString(login?.accessToken)
      if (!bizToken) throw new Error('GLM 业务登录没有返回业务 token（兑换链可能已变更）。')
      authorization = `Bearer ${bizToken}`
    }
    const customer = await bizJson(`${config.business}/api/biz/customer/getCustomerInfo`, authorization)
    const scope = parseCustomerScope(customer)
    const keysUrl = `${config.business}/api/biz/v1/organization/${encodeURIComponent(scope.organizationId)}/projects/${encodeURIComponent(scope.projectId)}/api_keys`
    let key = pickGlmApiKey(await bizJson(keysUrl, authorization).catch(() => null))
    if (!key) {
      const created = asRecord(await bizJson(keysUrl, authorization, { name: GLM_KEY_NAME }))
      const apiKeyId = asString(created?.apiKey) ?? asString(created?.apiKeyId) ?? asString(created?.id)
      if (!apiKeyId) throw new Error('创建 GLM Coding Plan Key 的响应里没有 apiKey。')
      key = { id: apiKeyId }
    }
    const secretPayload = asRecord(
      await bizJson(`${keysUrl}/copy/${encodeURIComponent(key.id)}`, authorization)
    )
    const secretKey = asString(secretPayload?.secretKey) ?? asString(secretPayload?.secret_key)
    if (!secretKey) throw new Error('取 GLM Key secret 的响应里没有 secretKey。')
    const codingKey = `${key.id}.${secretKey}`
    const quotaPayload = await request(`${config.business}${QUOTA_PATH}`, {
      headers: { authorization: codingKey, accept: 'application/json' }
    }).then((response) => response.ok ? response.json().catch(() => null) : null)
    const planLevel = asString(asRecord(asRecord(quotaPayload)?.data)?.level)
    return {
      codingKey,
      apiKeyId: key.id,
      secretKey,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      ...(scope.organizationName ? { organizationName: scope.organizationName } : {}),
      ...(planLevel ? { planLevel } : {})
    }
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    return this.readQuota()
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    return {
      id: 'glm',
      name: 'GLM Coding Plan',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential?.account ? { account: this.credential.account } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : GLM_MODELS,
      enabled: provider?.enabled ?? false,
      login: 'browser',
      regionOptions: [
        { value: 'intl', label: '国际区（z.ai）' },
        { value: 'cn', label: '中国区（bigmodel.cn）' }
      ],
      defaultRegion: this.credential?.region ?? 'intl',
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 GLM Coding Plan。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const result = await testSubscriptionProvider(PROVIDER_ID, GLM_MODELS[0]?.id)
    if (!result.ok && /401|403|无效|失效/.test(result.message)) {
      this.lastError = result.message
    }
    return result
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

let instance: GlmSubscriptionService | null = null

export function getGlmSubscriptionService(): GlmSubscriptionService {
  if (!instance) instance = new GlmSubscriptionService()
  return instance
}

export function glmModels(): ModelInfo[] {
  return GLM_MODELS
}
