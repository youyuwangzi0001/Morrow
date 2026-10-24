/**
 * Step Plan 订阅：云端轮询浏览器登录（或手动 API Key / 本机 StepCode 登录导入）。
 * 凭据是静态 API Key，不刷新；模型面走 OpenAI Chat Completions。
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { arch } from 'node:os'
import { net } from 'electron'
import type { AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import type { ModelInfo } from '../../shared/types'
import type { SubscriptionRelayHandle } from './subscription-relay'
import { startSubscriptionRelay } from './subscription-relay'
import {
  STEP_CHAT_PATH,
  STEP_CLI_INIT_PATH,
  STEP_CLI_POLL_PATH,
  STEP_MODELS_PATH,
  STEP_PROFILES,
  parseStepLocalAuth,
  parseStepModels,
  profileOf,
  rewriteStepBody,
  type StepProfile
} from './step-protocol'
import {
  asNumber,
  asRecord,
  asString,
  errorText,
  getProvider,
  homePath,
  openExternal,
  readLocalJson,
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

const PROVIDER_ID = 'step-subscription'
const LOGIN_TIMEOUT_MS = 10 * 60_000
const LOCAL_PATHS = [
  homePath('.stepcode', 'auth.json'),
  homePath('.stepcode', 'agent', 'auth.json'),
  homePath('.stepcode', 'legacy-auth.json')
]

interface StepCredential {
  apiKey: string
  profile: StepProfile
  uid?: string
  models: ModelInfo[]
  efforts: Record<string, string[]>
  source?: string
  sourcePath?: string
  savedAt: number
}

export class StepSubscriptionService {
  private store = new SecureJsonStore<StepCredential>('step-subscription.json')
  private credential: StepCredential | null = this.store.load()
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null

  private async fetchModels(profile: StepProfile, apiKey: string): Promise<{ models: ModelInfo[]; efforts: Record<string, string[]> }> {
    const config = STEP_PROFILES[profile]
    const response = await net.fetch(`${config.api}${STEP_MODELS_PATH}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 401 || response.status === 403) throw new Error('Step API Key 无效或已失效。')
    if (!response.ok) throw new Error(`Step 模型目录读取失败（HTTP ${response.status}）。`)
    const parsed = parseStepModels(await response.json().catch(() => null), profile)
    if (parsed.models.length === 0) throw new Error('Step 账号没有返回可用模型。')
    return parsed
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    const credential = this.credential
    if (!credential) throw new Error('还没有登录 Step Plan。')
    this.localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    const config = STEP_PROFILES[credential.profile]
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken,
      fetchImpl: (url, init) => net.fetch(url, init),
      resolveUpstream: (path) => `${config.api}${path}`,
      getHeaders: () => ({
        authorization: `Bearer ${credential.apiKey}`,
        accept: 'text/event-stream'
      }),
      rewriteBody: (body) => rewriteStepBody(body, credential.efforts)
    })
    log.info('step subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken || !this.credential) throw new Error('Step 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'Step Plan（订阅）',
      kind: 'openai-compat',
      port,
      models: this.credential.models,
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
    } catch (err) {
      this.lastError = errorText(err)
      log.warn('step subscription restore failed', { error: this.lastError })
    }
  }

  async login(profileValue: string | undefined): Promise<AgentSubscriptionState> {
    const profile = profileOf(profileValue)
    const config = STEP_PROFILES[profile]
    const pollToken = randomBytes(32).toString('hex')
    const initResponse = await net.fetch(`${config.auth}${STEP_CLI_INIT_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${pollToken}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        profile,
        origin: config.auth,
        client: { name: 'morrow', version: '0.1.0', platform: `${process.platform}-${arch()}` }
      }),
      signal: AbortSignal.timeout(30_000)
    })
    const init = asRecord(await initResponse.json().catch(() => null))
    if (!initResponse.ok || !init) throw new Error(`Step 登录初始化失败（HTTP ${initResponse.status}）。`)
    const flowId = asString(init.flow_id)
    if (!flowId) throw new Error('Step 登录响应缺少 flow_id。')
    const interval = Math.max(1, Math.min(60, asNumber(init.poll_interval_sec) ?? 2)) * 1000
    const expiresAt = (asNumber(init.expires_at) ?? 0) * 1000
    const deadline = Math.min(expiresAt || Date.now() + LOGIN_TIMEOUT_MS, Date.now() + LOGIN_TIMEOUT_MS)
    openExternal(`${config.auth}/cli-login-remote?flow_id=${encodeURIComponent(flowId)}`)
    let apiKey: string | undefined
    let uid: string | undefined
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await net.fetch(`${config.auth}${STEP_CLI_POLL_PATH}/${encodeURIComponent(flowId)}`, {
        headers: { authorization: `Bearer ${pollToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      })
      if (!poll.ok) {
        if (poll.status >= 500) continue
        throw new Error(`Step 登录轮询失败（HTTP ${poll.status}）。`)
      }
      const payload: unknown = await poll.json().catch(() => null)
      const body = asRecord(asRecord(payload)?.data) ?? asRecord(payload) ?? {}
      const state = asString(body.state)
      if (state === 'pending') continue
      if (state === 'failed') throw new Error('Step 授权被拒绝或已失败，请重新发起登录。')
      if (state !== 'ready') continue
      const credential = asRecord(body.credential)
      apiKey = asString(credential?.api_key) ?? asString(credential?.apiKey)
      uid = asString(body.uid)
      break
    }
    if (!apiKey) throw new Error('Step 浏览器登录超时（10 分钟）。请重新发起登录。')
    return this.finishLogin(apiKey, profile, uid, 'browser')
  }

  async loginToken(token: string, profileValue: string | undefined): Promise<AgentSubscriptionState> {
    const key = token.trim()
    if (!key) throw new Error('请填写 Step API Key。')
    return this.finishLogin(key, profileOf(profileValue), undefined, 'token')
  }

  private async finishLogin(
    apiKey: string,
    profile: StepProfile,
    uid: string | undefined,
    source: string,
    sourcePath?: string
  ): Promise<AgentSubscriptionState> {
    let models: ModelInfo[]
    let efforts: Record<string, string[]>
    try {
      const fetched = await this.fetchModels(profile, apiKey)
      models = fetched.models
      efforts = fetched.efforts
    } catch (err) {
      // 目录接口暂时不可用时，复用同一 profile 上一次登录得到的真实模型 ID，不凭空编造。
      if (this.credential?.profile === profile && this.credential.models.length > 0) {
        models = this.credential.models
        efforts = this.credential.efforts
        this.lastError = `Step 模型目录暂时读取失败，已复用上次的 ${models.length} 个模型：${errorText(err)}`
      } else {
        throw err
      }
    }
    this.credential = { apiKey, profile, ...(uid ? { uid } : {}), models, efforts, source, ...(sourcePath ? { sourcePath } : {}), savedAt: Date.now() }
    this.store.save(this.credential)
    this.lastError = null
    await this.resetProxy()
    await this.ensureProxy()
    this.ensureProvider()
    this.quota = {
      windows: [],
      fetchedAt: Date.now(),
      message: 'Step Plan 的额度需要在平台网页会话中读取（Oasis Token），本版本只展示账号与模型；实际额度以服务商返回为准。'
    }
    return this.status()
  }

  localImportInfo(): { available: boolean; path: string } {
    for (const path of LOCAL_PATHS) {
      if (existsSync(path)) return { available: true, path }
    }
    return { available: false, path: LOCAL_PATHS[0]! }
  }

  async importLocal(): Promise<AgentSubscriptionState> {
    for (const path of LOCAL_PATHS) {
      const parsed = parseStepLocalAuth(readLocalJson(path))
      if (!parsed) continue
      return this.finishLogin(parsed.apiKey, parsed.profile ?? 'step_plan', parsed.uid, 'local', path)
    }
    throw new Error('没有找到本机 StepCode 登录态（~/.stepcode/auth.json）。')
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有登录 Step Plan。')
    this.quota = {
      windows: [],
      fetchedAt: Date.now(),
      message: 'Step Plan 的额度需要在平台网页会话中读取（Oasis Token），本版本只展示账号与模型；实际额度以服务商返回为准。'
    }
    return this.quota
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    const config = this.credential ? STEP_PROFILES[this.credential.profile] : null
    return {
      id: 'step',
      name: 'Step Plan',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential ? {
        account: {
          ...(this.credential.uid ? { uid: this.credential.uid } : {}),
          ...(config ? { region: config.label } : {}),
          ...(this.credential.source ? { source: this.credential.source } : {}),
          ...(this.credential.sourcePath ? { sourcePath: this.credential.sourcePath } : {})
        }
      } : {}),
      ...(this.quota ? { quota: this.quota } : {}),
      models: provider?.models?.length ? provider.models : this.credential?.models ?? [],
      enabled: provider?.enabled ?? false,
      login: 'browser',
      regionOptions: Object.entries(STEP_PROFILES).map(([value, item]) => ({ value, label: item.label })),
      defaultRegion: this.credential?.profile ?? 'step_plan',
      tokenLogin: {
        label: 'Step API Key',
        placeholder: '粘贴 Step 开放平台或 Step Plan 的 API Key',
        help: '也可以直接导入本机 StepCode 登录；API Key 只保存在本机。'
      },
      localImport: this.localImportInfo(),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Step Plan。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(PROVIDER_ID, this.credential?.models[0]?.id)
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

let instance: StepSubscriptionService | null = null

export function getStepSubscriptionService(): StepSubscriptionService {
  if (!instance) instance = new StepSubscriptionService()
  return instance
}

