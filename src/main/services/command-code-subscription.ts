/**
 * Command Code 订阅：浏览器领取长期 API Key（本地回调）或手动粘贴，
 * 保存前用 /alpha/whoami 真实性校验；模型按 Claude / 其他分成 Anthropic 与 OpenAI 两条 wire，
 * 共用一个本地回环代理。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { net } from 'electron'
import type { AgentSubscriptionAccount, AgentSubscriptionQuota, AgentSubscriptionState } from '../../shared/subscriptions'
import type { ModelInfo } from '../../shared/types'
import type { SubscriptionRelayHandle } from './subscription-relay'
import { startSubscriptionRelay } from './subscription-relay'
import {
  COMMAND_CODE_API,
  COMMAND_CODE_CHAT_MODELS,
  COMMAND_CODE_CLAUDE_MODELS,
  COMMAND_CODE_CREDITS,
  COMMAND_CODE_PROVIDER_PREFIX,
  COMMAND_CODE_STUDIO_AUTH,
  COMMAND_CODE_WHOAMI,
  commandCodeHeaders,
  parseCommandCodeAccount,
  parseCommandCodeCatalog,
  parseCommandCodeQuota,
  rewriteCommandCodeAnthropic,
  rewriteCommandCodeChat
} from './command-code-protocol'
import {
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
import { openLoginUrl } from './external-open'
import { log } from './logger'

const PROVIDER_ID = 'command-code-subscription'
const CLAUDE_PROVIDER_ID = 'command-code-claude-subscription'
const QUOTA_CACHE_MS = 2 * 60_000
const CALLBACK_TIMEOUT_MS = 5 * 60_000

interface CommandCodeCredential {
  apiKey: string
  account: AgentSubscriptionAccount
  chatModels: ModelInfo[]
  claudeModels: ModelInfo[]
  savedAt: number
}

async function apiGet(path: string, apiKey: string): Promise<unknown> {
  const response = await net.fetch(`${COMMAND_CODE_API}${path}`, {
    headers: commandCodeHeaders(apiKey),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Command Code ${path} 失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`)
  }
  return response.json().catch(() => null)
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = origin && /^https:\/\/([a-z0-9-]+\.)*commandcode\.ai$/i.test(origin) || origin === 'http://localhost:3000'
    ? origin!
    : 'https://commandcode.ai'
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    vary: 'origin'
  }
}

async function readCallbackBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > 16_384) throw new Error('回调请求体过大。')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return asRecord(JSON.parse(raw)) ?? {}
  } catch {
    return Object.fromEntries(new URLSearchParams(raw)) as Record<string, unknown>
  }
}

export class CommandCodeSubscriptionService {
  private store = new SecureJsonStore<CommandCodeCredential>('command-code-subscription.json')
  private credential: CommandCodeCredential | null = this.store.load()
  private proxy: SubscriptionRelayHandle | null = null
  private localToken: string | null = null
  private quota: AgentSubscriptionQuota | null = null
  private lastError: string | null = null

  private async fetchCatalog(): Promise<{ chat: ModelInfo[]; claude: ModelInfo[] }> {
    try {
      const response = await net.fetch(`${COMMAND_CODE_API}${COMMAND_CODE_PROVIDER_PREFIX}/models`, {
        headers: { accept: 'application/json', 'user-agent': 'command-code/1.0.0' },
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const parsed = parseCommandCodeCatalog(await response.json().catch(() => null))
      if (parsed.chat.length === 0 && parsed.claude.length === 0) throw new Error('目录为空')
      return parsed
    } catch (err) {
      log.warn('command code catalog fallback', { error: errorText(err) })
      return { chat: COMMAND_CODE_CHAT_MODELS, claude: COMMAND_CODE_CLAUDE_MODELS }
    }
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    const credential = this.credential
    if (!credential) throw new Error('还没有登录 Command Code。')
    this.localToken = getSettingsStore().getApiKey(PROVIDER_ID) ?? randomLocalToken()
    this.proxy = await startSubscriptionRelay({
      localToken: this.localToken,
      fetchImpl: (url, init) => net.fetch(url, init),
      resolveUpstream: (path) => `${COMMAND_CODE_API}${COMMAND_CODE_PROVIDER_PREFIX}${path.replace(/^\/v1/, '')}`,
      getHeaders: () => commandCodeHeaders(credential.apiKey),
      rewriteBody: (body, path) => path.includes('/messages')
        ? rewriteCommandCodeAnthropic(body)
        : rewriteCommandCodeChat(body)
    })
    log.info('command code subscription proxy started', { port: this.proxy.port })
    return this.proxy.port
  }

  private ensureProvider(): void {
    const port = this.proxy?.port
    if (!port || !this.localToken || !this.credential) throw new Error('Command Code 订阅代理没有启动。')
    saveLoopbackProvider({
      id: PROVIDER_ID,
      name: 'Command Code（订阅）',
      kind: 'openai-compat',
      port,
      models: this.credential.chatModels,
      localToken: this.localToken
    })
    saveLoopbackProvider({
      id: CLAUDE_PROVIDER_ID,
      name: 'Command Code Claude（订阅）',
      kind: 'anthropic',
      port,
      models: this.credential.claudeModels,
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
      log.warn('command code subscription restore failed', { error: this.lastError })
    }
  }

  async login(): Promise<AgentSubscriptionState> {
    const state = randomBytes(24).toString('base64url')
    const received = await this.listenForCallback(state)
    const authUrl = `${COMMAND_CODE_STUDIO_AUTH}?callback=${encodeURIComponent(`http://127.0.0.1:${received.port}/callback`)}&state=${encodeURIComponent(state)}&mode=redirect`
    const opened = await openLoginUrl(authUrl)
    if (!opened.opened) {
      received.close()
      throw new Error(`无法打开浏览器；Command Code 领取链接已复制：${authUrl}`)
    }
    const apiKey = await received.key
    return this.finishLogin(apiKey, 'browser')
  }

  async loginToken(token: string): Promise<AgentSubscriptionState> {
    const key = token.trim()
    if (!key) throw new Error('请填写 Command Code API Key。')
    return this.finishLogin(key, 'token')
  }

  private async finishLogin(apiKey: string, source: string): Promise<AgentSubscriptionState> {
    const whoami = await apiGet(COMMAND_CODE_WHOAMI, apiKey)
    const info = parseCommandCodeAccount(whoami)
    const catalog = await this.fetchCatalog()
    const credential: CommandCodeCredential = {
      apiKey,
      account: { ...info, region: 'Command Code', source },
      chatModels: catalog.chat,
      claudeModels: catalog.claude,
      savedAt: Date.now()
    }
    this.credential = credential
    this.store.save(credential)
    this.lastError = null
    await this.resetProxy()
    await this.ensureProxy()
    this.ensureProvider()
    await this.refreshQuota().catch(() => undefined)
    return this.status()
  }

  private listenForCallback(expectedState: string): Promise<{ port: number; key: Promise<string>; close: () => void }> {
    return new Promise((resolveServer, rejectServer) => {
      let settled = false
      let resolveKey: (value: string) => void = () => undefined
      let rejectKey: (err: Error) => void = () => undefined
      const key = new Promise<string>((resolve, reject) => {
        resolveKey = resolve
        rejectKey = reject
      })
      const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const cors = corsHeaders(req.headers.origin)
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors)
          res.end()
          return
        }
        if (url.pathname === '/callback/complete') {
          res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' })
          res.end('<!doctype html><meta charset="utf-8"><title>Morrow</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>登录已完成，可以关闭此页面回到 Morrow。</p></body>')
          return
        }
        if (url.pathname !== '/callback') {
          res.writeHead(404, cors)
          res.end()
          return
        }
        if (req.method === 'GET') {
          const queryState = url.searchParams.get('state')
          const queryKey = url.searchParams.get('apiKey') ?? url.searchParams.get('api_key')
          if (queryKey && queryState === expectedState) {
            res.writeHead(303, { ...cors, location: `/callback/complete?state=${encodeURIComponent(expectedState)}` })
            res.end()
            resolveKey(queryKey)
            return
          }
          res.writeHead(400, cors)
          res.end('missing key')
          return
        }
        void readCallbackBody(req)
          .then((body) => {
            const gotState = asString(body.state)
            const apiKey = asString(body.apiKey) ?? asString(body.api_key)
            if (gotState !== expectedState) throw new Error('state 不匹配，已拒绝这次回调。')
            if (!apiKey) throw new Error('回调没有带 apiKey。')
            res.writeHead(303, { ...cors, location: `/callback/complete?state=${encodeURIComponent(expectedState)}` })
            res.end()
            resolveKey(apiKey)
          })
          .catch((err) => {
            if (res.headersSent) res.end()
            else {
              res.writeHead(400, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
              res.end(err instanceof Error ? err.message : 'bad request')
            }
          })
      })
      const tryPort = (port: number, remaining: number): void => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && remaining > 0) tryPort(port + 1, remaining - 1)
          else if (!settled) {
            settled = true
            rejectServer(new Error(`Command Code 登录回调端口不可用（从 5959 起探测 1024 个端口）：${err.message}`))
          }
        })
        server.listen(port, '127.0.0.1', () => {
          settled = true
          const address = server.address()
          const actual = typeof address === 'object' && address ? address.port : port
          resolveServer({ port: actual, key, close: () => server.close() })
          const timer = setTimeout(() => rejectKey(new Error('Command Code 浏览器登录超时（5 分钟）。')), CALLBACK_TIMEOUT_MS)
          void key.finally(() => {
            clearTimeout(timer)
            // Studio 在收到 303 后还会打开 /callback/complete，保留几秒避免连接被提前关闭
            setTimeout(() => server.close(), 8_000).unref?.()
          }).catch(() => undefined)
        })
      }
      tryPort(5959, 1024)
    })
  }

  async refreshQuota(): Promise<AgentSubscriptionQuota> {
    if (!this.credential) throw new Error('还没有登录 Command Code。')
    const whoami = await apiGet(COMMAND_CODE_WHOAMI, this.credential.apiKey).catch(() => null)
    const info = parseCommandCodeAccount(whoami)
    if (info.plan && info.plan !== this.credential.account.plan) {
      this.credential.account = { ...this.credential.account, plan: info.plan }
      this.store.save(this.credential)
    }
    let creditPayload: unknown = null
    let creditError = ''
    try {
      creditPayload = await apiGet(COMMAND_CODE_CREDITS, this.credential.apiKey)
    } catch (err) {
      creditError = errorText(err)
    }
    this.quota = creditPayload
      ? parseCommandCodeQuota(creditPayload)
      : { windows: [], fetchedAt: Date.now(), message: `额度读取失败：${creditError || '接口没有返回数据'}` }
    return this.quota
  }

  async status(): Promise<AgentSubscriptionState> {
    const provider = getProvider(PROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > QUOTA_CACHE_MS) quota = null
    const models = [...(this.credential?.chatModels ?? []), ...(this.credential?.claudeModels ?? [])]
    return {
      id: 'command-code',
      name: 'Command Code',
      connected: Boolean(this.credential),
      ...(provider ? { providerId: provider.id } : {}),
      ...(this.credential?.account ? { account: this.credential.account } : {}),
      ...(quota ? { quota } : {}),
      models: models.length > 0 ? models : [...COMMAND_CODE_CHAT_MODELS, ...COMMAND_CODE_CLAUDE_MODELS],
      enabled: provider?.enabled ?? false,
      login: 'browser',
      tokenLogin: {
        label: 'Command Code API Key',
        placeholder: '粘贴 Command Code Studio 生成的长期密钥',
        help: '浏览器登录会自动回填；也可以从 Command Code Studio 复制密钥粘贴到这里。'
      },
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async setEnabled(enabled: boolean): Promise<AgentSubscriptionState> {
    if (!getProvider(PROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Command Code。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(PROVIDER_ID, enabled)
    if (getProvider(CLAUDE_PROVIDER_ID)) setProviderEnabled(CLAUDE_PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const chat = this.credential?.chatModels ?? []
    if (chat.length > 0) return testSubscriptionProvider(PROVIDER_ID, chat[0]?.id)
    return testSubscriptionProvider(CLAUDE_PROVIDER_ID, this.credential?.claudeModels[0]?.id)
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
    removeProvider(CLAUDE_PROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let instance: CommandCodeSubscriptionService | null = null

export function getCommandCodeSubscriptionService(): CommandCodeSubscriptionService {
  if (!instance) instance = new CommandCodeSubscriptionService()
  return instance
}
