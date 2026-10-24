/**
 * OpenCode：导入本机 OpenCode 的 auth.json（只读）或手动填写 OpenCode Zen API Key，
 * 通过 Zen 的 OpenAI 兼容入口转发。OAuth 记录（GitHub Copilot / Codex）不在本渠道冒用。
 */
import { existsSync } from 'node:fs'
import { net } from 'electron'
import type { AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import type { SubscriptionRelayHandle } from './subscription-relay'
import { startSubscriptionRelay } from './subscription-relay'
import { OPENCODE_MODELS, OPENCODE_ZEN_BASE, parseOpencodeAuth, parseOpencodeModels, rewriteOpencodeBody } from './opencode-protocol'
import {
  errorText,
  getProvider,
  homePath,
  randomLocalToken,
  readLocalJson,
  removeProvider,
  saveLoopbackProvider,
  SecureJsonStore,
  setProviderEnabled,
  testSubscriptionProvider
} from './agent-subscription-common'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

const PROVIDER_ID = 'opencode-subscription'
const QUOTA_CACHE_MS = 2 * 60_000

interface OpencodeCredential {
  apiKey: string
  provider: string
  accountName: string
  source: 'local' | 'token'
  sourcePath?: string
  models?: import('../../shared/types').ModelInfo[]
  savedAt: number
}

function authPaths(): string[] {
  const paths = [homePath('.local', 'share', 'opencode', 'auth.json')]
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) paths.unshift(`${xdg.replace(/[\\/]+$/, '')}/opencode/auth.json`)
  return Array.from(new Set(paths))
}

function maskKey(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

export class OpencodeSubscriptionService {
  private store = new SecureJsonStore<OpencodeCredential>('opencode-subscription.json')
  private credential: OpencodeCredential | null = this.store.load()
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    const credential = this.credential
    if (!credential) throw new Error('还没有导入 OpenCode 凭据。')
    this.localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken,
      fetchImpl: (url, init) => net.fetch(url, init),
      resolveUpstream: (path) => `${OPENCODE_ZEN_BASE}${path.replace(/^\/v1/, '')}`,
      getHeaders: () => ({ authorization: `Bearer ${credential.apiKey}`, accept: 'text/event-stream' }),
      rewriteBody: rewriteOpencodeBody
    })
    log.info('opencode subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken) throw new Error('OpenCode 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'OpenCode（订阅）',
      kind: 'openai-compat',
      port,
      models: this.credential?.models?.length ? this.credential.models : OPENCODE_MODELS,
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
      log.warn('opencode subscription restore failed', { error: this.lastError })
    }
  }

  localImportInfo(): { available: boolean; path: string } {
    for (const path of authPaths()) {
      if (existsSync(path)) return { available: true, path }
    }
    return { available: false, path: authPaths()[0]! }
  }

  async importLocal(): Promise<AgentSubscriptionState> {
    for (const path of authPaths()) {
      const parsed = parseOpencodeAuth(readLocalJson(path))
      if (!parsed) continue
      return this.finishLogin(parsed.key, parsed.provider, 'local', path)
    }
    throw new Error('没有找到本机 OpenCode 的 API Key（~/.local/share/opencode/auth.json）。')
  }

  async loginToken(token: string): Promise<AgentSubscriptionState> {
    const key = token.trim()
    if (!key) throw new Error('请填写 OpenCode Zen API Key。')
    return this.finishLogin(key, 'opencode', 'token')
  }

  private async finishLogin(
    apiKey: string,
    provider: string,
    source: 'local' | 'token',
    sourcePath?: string
  ): Promise<AgentSubscriptionState> {
    const response = await net.fetch(`${OPENCODE_ZEN_BASE}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 401 || response.status === 403) throw new Error('OpenCode Zen API Key 无效或已失效。')
    let warning = ''
    let models = OPENCODE_MODELS
    if (response.ok) {
      const live = parseOpencodeModels(await response.json().catch(() => null))
      if (live.length > 0) models = live
    }
    if (!response.ok) {
      const probe = await net.fetch(`${OPENCODE_ZEN_BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          model: OPENCODE_MODELS[0]!.id,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false
        }),
        signal: AbortSignal.timeout(30_000)
      })
      if (probe.status === 401 || probe.status === 403) throw new Error('OpenCode Zen API Key 无效或已失效。')
      if (!probe.ok) throw new Error(`OpenCode Zen 密钥校验失败（HTTP ${probe.status}）。`)
      warning = 'Zen 模型目录不可用，已用一次真实推理请求完成校验。'
    }
    this.credential = {
      apiKey,
      provider,
      accountName: `OpenCode Zen · ${maskKey(apiKey)}`,
      source,
      ...(sourcePath ? { sourcePath } : {}),
      models,
      savedAt: Date.now()
    }
    this.store.save(this.credential)
    this.lastError = warning || null
    await this.resetProxy()
    await this.ensureProxy()
    this.ensureProvider()
    this.quota = {
      windows: [],
      fetchedAt: Date.now(),
      message: 'OpenCode Zen 没有公开的额度查询接口；这里只展示账号与模型，余额以 OpenCode 控制台为准。'
    }
    return this.status()
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有导入 OpenCode 凭据。')
    this.quota = {
      windows: [],
      fetchedAt: Date.now(),
      message: 'OpenCode Zen 没有公开的额度查询接口；这里只展示账号与模型，余额以 OpenCode 控制台为准。'
    }
    return this.quota
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    return {
      id: 'opencode',
      name: 'OpenCode',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential ? {
        account: {
          name: this.credential.accountName,
          region: 'OpenCode Zen',
          source: this.credential.source,
          ...(this.credential.sourcePath ? { sourcePath: this.credential.sourcePath } : {})
        }
      } : {}),
      ...(quota ? { quota } : {}),
      models: provider?.models?.length ? provider.models : this.credential?.models ?? OPENCODE_MODELS,
      enabled: provider?.enabled ?? false,
      login: 'local',
      tokenLogin: {
        label: 'OpenCode Zen API Key',
        placeholder: '粘贴以 oc_sk_ 开头的 Zen API Key',
        help: '也可以只读导入本机 ~/.local/share/opencode/auth.json 里的 api 类型密钥。'
      },
      localImport: this.localImportInfo(),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有导入 OpenCode 凭据。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(PROVIDER_ID, (this.credential?.models ?? OPENCODE_MODELS)[0]?.id)
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

let instance: OpencodeSubscriptionService | null = null

export function getOpencodeSubscriptionService(): OpencodeSubscriptionService {
  if (!instance) instance = new OpencodeSubscriptionService()
  return instance
}
