// 全部模型订阅协议、OAuth/本机登录与用量代理：由 *-protocol、*-subscription 与 subscriptions 扁平合并。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, publicEncrypt, constants } from 'node:crypto'
import { homedir, hostname, release, type, arch } from 'node:os'
import { join, dirname } from 'node:path'
import { safeStorage, net } from 'electron'
import type { ModelInfo, ProviderConfig, ReasoningEffort, Settings } from '../shared/types'
import type { SubscriptionTestResult, AgentSubscriptionQuota, AgentQuotaWindow, AgentSubscriptionAccount, AgentSubscriptionState, QoderSubscriptionAccount, QoderSubscriptionQuota, QoderSubscriptionState, AgentSubscriptionId, CodexSubscriptionAccount, CodexSubscriptionQuota, CodexSubscriptionState, CustomSubscriptionInput, CustomSubscriptionRecord, CustomSubscriptionState, SubscriptionAction, SubscriptionStatus } from '../shared/contracts'
import { enrichModelCapabilities, isReasoningEffort } from '../shared/contracts'
import { dataPath, openLoginUrl, openLoginQuiet } from './workspace'
import { getSettingsStore } from './settings'
import { testProviderConnection } from '../core/providers'
import { asRecord, asString, asNumber, percentWindow, timestampMs, sleep } from './agent'
import type { IncomingMessage, Server, ServerResponse, RequestListener } from 'node:http'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { log } from './logger'

/** 读取本机 JSON 文件；不存在或格式不对时返回 null，不抛错。 */
export function readLocalJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    return asRecord(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function homePath(...segments: string[]): string {
  return join(homedir(), ...segments)
}

/** 用系统浏览器打开授权页。 */
export function openExternal(url: string): void {
  void openLoginUrl(url).catch(() => undefined)
}

export function getProvider(id: string): ProviderConfig | undefined {
  return getSettingsStore().get().providers.find((item) => item.id === id)
}

/** 注册或更新回环 Provider，保留用户此前设置的启停状态。 */
export function saveLoopbackProvider(input: {
  id: string
  name: string
  kind: 'openai-compat' | 'anthropic'
  port: number
  models: ModelInfo[]
  localToken: string
}): ProviderConfig {
  const existing = getProvider(input.id)
  const config: ProviderConfig = {
    id: input.id,
    kind: input.kind,
    name: input.name,
    baseUrl: `http://127.0.0.1:${input.port}/v1`,
    models: enrichModelCapabilities(input.models),
    category: 'custom',
    apiKeyStored: true,
    enabled: existing?.enabled ?? true
  }
  getSettingsStore().saveProvider(config, input.localToken)
  return config
}

export function removeProvider(id: string): void {
  try {
    getSettingsStore().removeProvider(id)
  } catch {
    // Provider 已经被手动删除
  }
}

export function setProviderEnabled(id: string, enabled: boolean): void {
  const provider = getProvider(id)
  if (!provider) throw new Error('订阅 Provider 尚未创建。')
  getSettingsStore().saveProvider(
    { ...provider, enabled },
    getSettingsStore().getApiKey(id) ?? undefined
  )
}

export async function testSubscriptionProvider(id: string, modelId?: string): Promise<SubscriptionTestResult> {
  const started = Date.now()
  try {
    const provider = getProvider(id)
    if (!provider) throw new Error('订阅 Provider 不存在，请先完成登录。')
    const result = await testProviderConnection(provider, getSettingsStore().getApiKey(id), modelId)
    return { ...result, latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
  }
}

/** safeStorage 加密的本机 JSON 凭据文件。 */
export class SecureJsonStore<T> {
  constructor(private readonly fileName: string) {}

  filePath(): string {
    return dataPath(this.fileName)
  }

  load(): T | null {
    try {
      if (!existsSync(this.filePath())) return null
      const parsed = asRecord(JSON.parse(readFileSync(this.filePath(), 'utf8')))
      const encrypted = asString(parsed?.encrypted)
      if (!encrypted) return null
      if (!safeStorage.isEncryptionAvailable()) return null
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as T
    } catch {
      return null
    }
  }

  save(value: T): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统凭据加密不可用，无法保存登录态。')
    }
    mkdirSync(dataPath(), { recursive: true })
    const payload = {
      version: 1,
      encrypted: safeStorage.encryptString(JSON.stringify(value)).toString('base64'),
      updatedAt: Date.now()
    }
    writeFileSync(this.filePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  clear(): void {
    try {
      if (existsSync(this.filePath())) writeFileSync(this.filePath(), '', 'utf8')
    } catch {
      // 文件不可写时保留现状，下一次保存会覆盖
    }
  }
}

export function randomLocalToken(seed?: string | null): string {
  return seed && seed.length >= 16 ? seed : randomBytes(32).toString('base64url')
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const subscriptionRelayMAX_BODY = 64 * 1024 * 1024

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'] as const

const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'request-id', 'x-request-id', 'anthropic-version'] as const

export interface SubscriptionRelayOptions {
  localToken: string
  /** 把 Morrow 收到的 path + query 映射到上游完整 URL。 */
  resolveUpstream: (path: string, search: string) => string
  /** 每次请求调用，返回要注入上游的鉴权与其他头。 */
  getHeaders: () => Promise<Record<string, string>> | Record<string, string>
  /** 上游 401/403 时执行一次刷新，然后重试。 */
  refresh?: () => Promise<void>
  /** 可选的请求体改写（例如模型别名）；返回合法 JSON 字符串。 */
  rewriteBody?: (body: string, path: string) => Promise<string> | string
  /** 可选的 JSON 响应改写（例如上游把结果包在 `{data:...}` 里）。 */
  rewriteJsonResponse?: (body: string) => string
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

export interface SubscriptionRelayHandle {
  port: number
  close(): Promise<void>
}

async function subscriptionRelayReadBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > subscriptionRelayMAX_BODY) throw new Error('请求体超过 64MB。')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function subscriptionRelaySendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function requestHeaders(req: IncomingMessage, injected: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...injected }
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) headers[name] = value
  }
  return headers
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

export async function startSubscriptionRelay(options: SubscriptionRelayOptions): Promise<SubscriptionRelayHandle> {
  const fetchImpl = options.fetchImpl ?? fetch

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      subscriptionRelaySendJson(res, 200, { ok: true })
      return
    }
    const authorized = req.headers.authorization === `Bearer ${options.localToken}`
      || req.headers['x-api-key'] === options.localToken
    if (!authorized) {
      subscriptionRelaySendJson(res, 401, { error: { message: '本地订阅代理令牌无效。' } })
      return
    }
    const rawBody = req.method === 'POST' ? await subscriptionRelayReadBody(req) : ''
    const body = rawBody && options.rewriteBody ? await options.rewriteBody(rawBody, url.pathname) : rawBody
    const upstreamUrl = options.resolveUpstream(url.pathname, url.search)
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    const attempt = async (): Promise<Response> => fetchImpl(upstreamUrl, {
      method: req.method ?? 'GET',
      headers: requestHeaders(req, await options.getHeaders()),
      ...(body ? { body } : {}),
      signal: controller.signal
    })

    let response: Response
    try {
      response = await attempt()
      if ((response.status === 401 || response.status === 403) && options.refresh) {
        await response.body?.cancel().catch(() => undefined)
        await options.refresh()
        response = await attempt()
      }
    } catch (err) {
      if (!res.writableEnded) subscriptionRelaySendJson(res, 502, { error: { message: err instanceof Error ? err.message : String(err) } })
      return
    }

    if (!response.body || response.status === 204 || response.status === 304) {
      res.writeHead(response.status, responseHeaders(response))
      res.end()
      return
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (options.rewriteJsonResponse && response.ok && contentType.includes('application/json')) {
      const raw = await response.text()
      const next = options.rewriteJsonResponse(raw)
      res.writeHead(response.status, { ...responseHeaders(response), 'content-length': String(Buffer.byteLength(next)) })
      res.end(next)
      return
    }
    res.writeHead(response.status, responseHeaders(response))
    res.flushHeaders()
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
        stream.on('error', reject)
        res.on('close', () => { stream.destroy() })
        stream.pipe(res)
        stream.on('end', resolve)
      })
    } catch {
      if (!res.writableEnded) res.end()
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) subscriptionRelaySendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } })
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
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: async () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}

export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

export const ANTIGRAVITY_CLIENT_SECRET = process.env.MORROW_ANTIGRAVITY_CLIENT_SECRET?.trim() ?? ''

export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]

export const ANTIGRAVITY_PRIMARY = 'https://daily-cloudcode-pa.googleapis.com'

export const ANTIGRAVITY_FALLBACK = 'https://cloudcode-pa.googleapis.com'

export const ANTIGRAVITY_REDIRECT_PATH = '/oauth-callback'

export const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 200_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 200_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' }
]

const ROUTING: Record<string, { off: string; routing: Record<string, string>; default: string }> = {
  'gemini-4-argon': {
    off: 'gemini-4-argon-low',
    routing: { minimal: 'gemini-4-argon-low', low: 'gemini-4-argon-low', medium: 'gemini-4-argon-medium', high: 'gemini-4-argon-high', xhigh: 'gemini-4-argon-high' },
    default: 'gemini-4-argon-medium'
  },
  'gemini-3.8-flash': {
    off: 'gemini-3.8-flash-tiered',
    routing: { minimal: 'gemini-3.8-flash-tiered', low: 'gemini-3.8-flash-tiered', medium: 'gemini-3.8-flash-tiered', high: 'gemini-3.8-flash-tiered', xhigh: 'gemini-3.8-flash-tiered' },
    default: 'gemini-3.8-flash-tiered'
  },
  'gemini-3.7-flash': {
    off: 'gemini-3.7-flash-low',
    routing: { minimal: 'gemini-3.7-flash-low', low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high', xhigh: 'gemini-3.7-flash-high' },
    default: 'gemini-3.7-flash-medium'
  },
  'gemini-3.5-flash': {
    off: 'gemini-3.5-flash-extra-low',
    routing: { minimal: 'gemini-3.5-flash-extra-low', low: 'gemini-3.5-flash-extra-low', medium: 'gemini-3.5-flash-low', high: 'gemini-3-flash-agent', xhigh: 'gemini-3-flash-agent' },
    default: 'gemini-3-flash-agent'
  },
  'gemini-3.1-pro': {
    off: 'gemini-3.1-pro-low',
    routing: { minimal: 'gemini-3.1-pro-low', low: 'gemini-3.1-pro-low', medium: 'gemini-pro-agent', high: 'gemini-pro-agent', xhigh: 'gemini-pro-agent' },
    default: 'gemini-pro-agent'
  },
  'gemini-2.5-pro': {
    off: 'gemini-2.5-pro',
    routing: { minimal: 'gemini-2.5-pro', low: 'gemini-2.5-pro', medium: 'gemini-2.5-pro', high: 'gemini-2.5-pro', xhigh: 'gemini-2.5-pro' },
    default: 'gemini-2.5-pro'
  },
  'gemini-2.5-flash': {
    off: 'gemini-2.5-flash',
    routing: { minimal: 'gemini-2.5-flash', low: 'gemini-2.5-flash', medium: 'gemini-2.5-flash', high: 'gemini-2.5-flash', xhigh: 'gemini-2.5-flash' },
    default: 'gemini-2.5-flash'
  },
  'claude-opus-5-5': {
    off: 'claude-opus-5-5-low',
    routing: { off: 'claude-opus-5-5-low', none: 'claude-opus-5-5-low', minimal: 'claude-opus-5-5-low', low: 'claude-opus-5-5-low', medium: 'claude-opus-5-5-medium', high: 'claude-opus-5-5-high', xhigh: 'claude-opus-5-5-high' },
    default: 'claude-opus-5-5-medium'
  },
  'claude-sonnet-5-5': {
    off: 'claude-sonnet-5-5-low',
    routing: { off: 'claude-sonnet-5-5-low', none: 'claude-sonnet-5-5-low', minimal: 'claude-sonnet-5-5-low', low: 'claude-sonnet-5-5-low', medium: 'claude-sonnet-5-5-medium', high: 'claude-sonnet-5-5-high', xhigh: 'claude-sonnet-5-5-high' },
    default: 'claude-sonnet-5-5-medium'
  }
}

let toolCallCounter = 0

export function sanitizeToolCallId(id: string | undefined, name: string): string {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned || `${name || 'tool'}_${Date.now()}_${++toolCallCounter}`
}

export function antigravityRuntime(model: string, effort?: string): string {
  const entry = ROUTING[model]
  if (!entry) return model
  const selected = (effort ?? 'medium').toLowerCase()
  return entry.routing[selected] ?? entry.default
}

export function isClaudeRuntime(runtime: string): boolean {
  return /^claude-/i.test(runtime)
}

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  'You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. '
  + 'You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.'

export const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.'

export const ANTIGRAVITY_PROGRESS_INSTRUCTION =
  'Before EVERY tool call, emit 1-2 short sentences of ordinary visible assistant text stating what you are about to do and why. Never write those sentences only inside thinking. Keep them brief and factual.'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const row = asRecord(part)
    return asString(row?.text) ?? ''
  }).join('')
}

function imagePart(url: string): Record<string, unknown> | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url)
  if (!match) return null
  return { inlineData: { mimeType: match[1], data: match[2] } }
}

interface OpenAiMessage {
  role?: string
  content?: unknown
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  name?: string
}

function userParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const item of content) {
    const row = asRecord(item)
    if (!row) continue
    if (row.type === 'text' && asString(row.text)) parts.push({ text: asString(row.text) })
    else if (row.type === 'image_url') {
      const url = asString(asRecord(row.image_url)?.url)
      const converted = url ? imagePart(url) : null
      if (converted) parts.push(converted)
      else if (url) parts.push({ text: `[图片：${url.slice(0, 120)}]` })
    }
  }
  return parts
}

/** Gemini functionDeclarations 只接受 OpenAPI 子集；去掉会 400 的 JSON Schema 关键字。 */
export function sanitizeGeminiSchema(value: unknown, depth = 0): unknown {
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map((item) => sanitizeGeminiSchema(item, depth + 1))
  const row = asRecord(value)
  if (!row) return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(row)) {
    if (['$schema', '$id', '$defs', 'definitions', 'additionalProperties', 'patternProperties', 'examples', 'default'].includes(key)) continue
    if (key === 'type' && Array.isArray(raw)) {
      const types = raw.map((item) => String(item))
      const hasNull = types.includes('null')
      const nonNull = types.filter((item) => item !== 'null')
      out.type = nonNull[0] ?? 'string'
      if (hasNull) out.nullable = true
      continue
    }
    if (key === 'oneOf') {
      out.anyOf = Array.isArray(raw) ? raw.map((item) => sanitizeGeminiSchema(item, depth + 1)) : raw
      continue
    }
    if (key === 'const') {
      out.enum = [raw]
      continue
    }
    if (key === 'properties' && asRecord(raw)) {
      out.properties = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([name, schema]) => [name, sanitizeGeminiSchema(schema, depth + 1)])
      )
      continue
    }
    if (key === 'items' || key === 'anyOf' || key === 'allOf') {
      out[key] = Array.isArray(raw) ? raw.map((item) => sanitizeGeminiSchema(item, depth + 1)) : sanitizeGeminiSchema(raw, depth + 1)
      continue
    }
    out[key] = typeof raw === 'object' && raw !== null ? sanitizeGeminiSchema(raw, depth + 1) : raw
  }
  return out
}

/** OpenAI Chat Completions 请求 → Gemini contents + tools + generationConfig。 */
export function buildAntigravityRequest(
  rawBody: string,
  projectId: string
): { envelope: Record<string, unknown>; runtime: string } {
  const body = asRecord(JSON.parse(rawBody)) ?? {}
  const model = asString(body.model) ?? 'gemini-3.1-pro'
  const effort = asString(body.reasoning_effort)
  const runtime = antigravityRuntime(model, effort)
  const messages = Array.isArray(body.messages) ? body.messages as OpenAiMessage[] : []
  const systemTexts: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []
  const toolNames = new Map<string, string>()
  const toolIds = new Map<string, string>()
  const needsToolIds = isClaudeRuntime(runtime) || /^gpt-oss-/i.test(runtime)
  let pendingToolParts: Array<Record<string, unknown>> = []

  const flushTools = (): void => {
    if (pendingToolParts.length === 0) return
    contents.push({ role: 'user', parts: pendingToolParts })
    pendingToolParts = []
  }
  const push = (role: 'user' | 'model', parts: Array<Record<string, unknown>>): void => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    const role = asString(message.role)
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text) systemTexts.push(text)
      continue
    }
    if (role === 'tool') {
      const callId = asString(message.tool_call_id) ?? ''
      const name = toolNames.get(callId) ?? asString(message.name) ?? 'tool'
      const content = textOf(message.content)
      const wireId = toolIds.get(callId) ?? (needsToolIds ? sanitizeToolCallId(callId, name) : undefined)
      pendingToolParts.push({
        functionResponse: { name, response: { result: content }, ...(wireId ? { id: wireId } : {}) }
      })
      continue
    }
    flushTools()
    if (role === 'assistant') {
      const parts: Array<Record<string, unknown>> = []
      const text = textOf(message.content)
      if (text) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        const name = asString(call.function?.name)
        if (!name) continue
        const id = asString(call.id)
        if (id) toolNames.set(id, name)
        const wireId = needsToolIds ? sanitizeToolCallId(id, name) : undefined
        if (id && wireId) toolIds.set(id, wireId)
        let args: Record<string, unknown> = {}
        try {
          args = asRecord(JSON.parse(call.function?.arguments ?? '{}')) ?? {}
        } catch {
          args = { raw: call.function?.arguments ?? '' }
        }
        parts.push({
          functionCall: { name, args, ...(wireId ? { id: wireId } : {}) },
          thoughtSignature: 'skip_thought_signature_validator'
        })
      }
      push('model', parts)
      continue
    }
    push('user', userParts(message.content))
  }
  flushTools()
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '你好' }] })

  const generationConfig: Record<string, unknown> = {}
  const temperature = asNumber(body.temperature)
  if (temperature !== undefined) generationConfig.temperature = temperature
  const maxTokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens) ?? 32_768
  generationConfig.maxOutputTokens = Math.min(maxTokens, 65_536)

  const selected = (effort ?? 'medium').toLowerCase()
  const off = selected === 'off' || selected === 'none'
  const isTiered = /^gemini-.+-tiered$/.test(runtime)
  const isGemini25 = runtime.startsWith('gemini-2.5-') || model.startsWith('gemini-2.5-')
  const isClaude = isClaudeRuntime(runtime)
  if (isTiered) {
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === 'high' || selected === 'xhigh' ? 'HIGH' : selected === 'medium' ? 'MEDIUM' : 'LOW',
      includeThoughts: !off
    }
  } else if (isGemini25) {
    generationConfig.thinkingConfig = { thinkingBudget: 8_192, includeThoughts: !off }
  } else if (!isClaude) {
    generationConfig.thinkingConfig = { includeThoughts: !off }
  }

  const request: Record<string, unknown> = {
    contents,
    systemInstruction: {
      role: 'user',
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        ...(systemTexts.length > 0 ? [{ text: systemTexts.join('\n\n') }] : [])
      ]
    },
    generationConfig
  }

  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length > 0) {
    const declarations = tools.flatMap((item) => {
      const fn = asRecord(asRecord(item)?.function)
      if (!fn || !asString(fn.name)) return []
      return [{
        name: asString(fn.name),
        ...(asString(fn.description) ? { description: asString(fn.description) } : {}),
        ...(asRecord(fn.parameters) ? { parameters: sanitizeGeminiSchema(fn.parameters) } : {})
      }]
    })
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
    const choice = body.tool_choice
    const mode = choice === 'none' ? 'NONE' : choice === 'required' ? 'ANY' : 'AUTO'
    request.toolConfig = { functionCallingConfig: { mode } }
  }

  return {
    runtime,
    envelope: {
      project: projectId,
      model: runtime,
      request,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }
  }
}

export type AntigravityEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool'; name: string; args: string }
  | { type: 'finish'; reason: string }
  | { type: 'usage'; input: number; output: number; cached: number }
  | { type: 'error'; message: string }

/** 一帧 `data:` JSON → 统一事件。 */
export function parseAntigravityFrame(payload: unknown): AntigravityEvent[] {
  const root = asRecord(payload) ?? {}
  const response = asRecord(root.response) ?? root
  const events: AntigravityEvent[] = []
  const error = asRecord(response.error) ?? asRecord(root.error)
  if (error) {
    events.push({ type: 'error', message: asString(error.message) ?? 'Antigravity 返回了错误。' })
    return events
  }
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const candidate = asRecord(candidates[0])
  const content = asRecord(candidate?.content)
  const parts = Array.isArray(content?.parts) ? content!.parts : []
  for (const item of parts) {
    const part = asRecord(item)
    if (!part) continue
    const text = asString(part.text)
    if (text) events.push({ type: part.thought === true ? 'thought' : 'text', text })
    const call = asRecord(part.functionCall)
    const name = asString(call?.name)
    if (name) events.push({ type: 'tool', name, args: JSON.stringify(asRecord(call?.args) ?? {}) })
  }
  const finish = asString(candidate?.finishReason)
  if (finish) events.push({ type: 'finish', reason: finish })
  const usage = asRecord(response.usageMetadata)
  if (usage) {
    const input = asNumber(usage.promptTokenCount) ?? 0
    const output = (asNumber(usage.candidatesTokenCount) ?? 0) + (asNumber(usage.thoughtsTokenCount) ?? 0)
    const cached = asNumber(usage.cachedContentTokenCount) ?? 0
    if (input || output) events.push({ type: 'usage', input, output, cached })
  }
  return events
}

export function parseAntigravityQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const groups = Array.isArray(root.groups) ? root.groups : []
  const windows = groups.flatMap((group) => {
    const groupRow = asRecord(group) ?? {}
    const groupName = asString(groupRow.displayName) ?? 'Antigravity'
    const buckets = Array.isArray(groupRow.buckets) ? groupRow.buckets : []
    return buckets.flatMap((bucket) => {
      const row = asRecord(bucket)
      if (!row) return []
      const fraction = asNumber(row.remainingFraction)
      if (fraction === undefined) return []
      const name = asString(row.displayName) ?? asString(row.bucketId) ?? '额度'
      return [percentWindow(
        `${groupName}-${name}`,
        `${groupName} · ${name}`,
        (1 - Math.max(0, Math.min(1, fraction))) * 100,
        timestampMs(row.resetTime)
      )]
    })
  })
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: 'Antigravity 没有返回可识别的额度桶。' } : {})
  }
}

export const CLINE_BASE = 'https://api.cline.bot/api/v1'

export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'

export const CLINE_MODEL_PREFIX = 'cline-pass/'

const MODELS: Array<{ id: string; label: string; contextWindow: number }> = [
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 200_000 },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 384_000 },
  { id: 'glm-5.3', label: 'GLM-5.3', contextWindow: 200_000 },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', label: 'Kimi K3', contextWindow: 262_144 },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextWindow: 262_144 },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 262_144 },
  { id: 'minimax-m3', label: 'MiniMax M3', contextWindow: 512_000 },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', contextWindow: 262_144 },
  { id: 'qwen3.7-max', label: 'Qwen3.7 Max', contextWindow: 262_144 },
  { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', contextWindow: 262_144 },
  { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', contextWindow: 200_000 },
  { id: 'mimo-v2.5', label: 'MiMo V2.5', contextWindow: 200_000 }
]

export const CLINE_MODELS: ModelInfo[] = MODELS.map((model) => ({
  id: `${CLINE_MODEL_PREFIX}${model.id}`,
  label: model.label,
  contextWindow: model.contextWindow,
  maxOutput: 64_000,
  supportsTools: true,
  note: 'Cline Pass'
}))

export function rewriteClineBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  const model = typeof body.model === 'string' ? body.model : ''
  if (model && !model.startsWith(CLINE_MODEL_PREFIX)) body.model = `${CLINE_MODEL_PREFIX}${model}`
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 64_000
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  return JSON.stringify(body)
}

/** 非流式响应可能被包成 `{data:{choices...}}`；流式 SSE 原样透传。 */
export function unwrapClineJson(raw: string): string {
  try {
    const root = asRecord(JSON.parse(raw))
    const data = asRecord(root?.data)
    if (root?.success === true && data) return JSON.stringify(data)
    return raw
  } catch {
    return raw
  }
}

export function parseClineQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const limits = asRecord(root.data)?.limits
  if (!Array.isArray(limits)) {
    return { windows: [], fetchedAt, message: '额度接口没有返回可识别的数据。' }
  }
  const labels: Record<string, string> = {
    five_hour: '5 小时',
    'five-hour': '5 小时',
    weekly: '每周',
    monthly: '每月'
  }
  const windows = limits.flatMap((item) => {
    const row = asRecord(item)
    if (!row) return []
    const type = asString(row.type) ?? ''
    const percent = asNumber(row.percentUsed) ?? asNumber(row.percent_used)
    if (percent === undefined) return []
    return [percentWindow(type || 'window', labels[type] ?? type, percent, timestampMs(row.resetsAt))]
  })
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}

export interface CodexCredential {
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  email?: string
  plan?: string
  expiresAt: number
}

export interface CodexProxyOptions {
  localToken: string
  models: ModelInfo[]
  getCredentials: () => Promise<CodexCredential>
  refreshCredentials: () => Promise<CodexCredential>
  /** 上游 fetch；默认由主进程注入 Electron net.fetch（跟随系统代理） */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
}

export interface CodexProxyHandle {
  port: number
  close(): Promise<void>
}

const codexProxyMAX_BODY = 64 * 1024 * 1024

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.99.0'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

interface OpenAIMessage {
  role?: string
  content?: string | Array<Record<string, unknown>>
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
}

interface ChatBody {
  model?: string
  messages?: OpenAIMessage[]
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  stream?: boolean
  reasoning_effort?: string
  user?: string
}

function codexHeaders(credential: CodexCredential, sessionId: string): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    ...(credential.accountId ? { 'chatgpt-account-id': credential.accountId } : {}),
    'openai-beta': 'responses=experimental',
    originator: 'morrow',
    'user-agent': 'morrow-desktop/0.1.0',
    'session-id': sessionId,
    'content-type': 'application/json',
    accept: 'text/event-stream'
  }
}

function contentToInput(
  content: OpenAIMessage['content'],
  role: 'user' | 'assistant' = 'user'
): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : []
  if (!Array.isArray(content)) return []
  const out: Array<Record<string, unknown>> = []
  for (const raw of content) {
    const type = String(raw.type ?? '')
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = String(raw.text ?? '')
      if (text) out.push({ type: textType, text })
    } else if (type === 'refusal' && role === 'assistant') {
      const refusal = String(raw.refusal ?? raw.text ?? '')
      if (refusal) out.push({ type: 'refusal', refusal })
    } else if (type === 'image_url' && role === 'user') {
      const url = (raw.image_url as { url?: string } | undefined)?.url
      if (typeof url === 'string' && /^data:image\//i.test(url)) {
        out.push({ type: 'input_image', image_url: url })
      } else if (typeof url === 'string') {
        out.push({ type: 'input_text', text: `[远程图片未内联，避免把地址发给订阅端] ${url}` })
      }
    }
  }
  return out
}

/** OpenAI Chat Completions 请求 → Responses 请求。 */
export function toResponsesPayload(body: ChatBody): Record<string, unknown> {
  const instructions: string[] = []
  const input: Array<Record<string, unknown>> = []
  for (const message of body.messages ?? []) {
    const role = String(message.role ?? 'user')
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string'
        ? message.content
        : contentToInput(message.content).map((item) => String(item.text ?? '')).join('\n')
      if (text.trim()) instructions.push(text)
      continue
    }
    if (role === 'tool') {
      if (message.tool_call_id) {
        const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output })
      }
      continue
    }
    if (role === 'assistant') {
      const content = contentToInput(message.content, 'assistant')
      if (content.length > 0) input.push({ role: 'assistant', content })
      for (const call of message.tool_calls ?? []) {
        const name = call.function?.name
        if (!call.id || !name) continue
        input.push({ type: 'function_call', call_id: call.id, name, arguments: call.function?.arguments ?? '{}' })
      }
      continue
    }
    const content = contentToInput(message.content)
    if (content.length > 0) input.push({ role: 'user', content })
  }
  const payload: Record<string, unknown> = {
    model: body.model,
    store: false,
    stream: true,
    input,
    include: ['reasoning.encrypted_content']
  }
  if (instructions.length > 0) payload.instructions = instructions.join('\n\n')
  if (body.tools?.length) {
    payload.tools = body.tools
      .filter((tool) => tool.function?.name)
      .map((tool) => ({
        type: 'function',
        name: tool.function!.name,
        description: tool.function?.description ?? '',
        parameters: tool.function?.parameters ?? { type: 'object', properties: {} },
        strict: false
      }))
    payload.tool_choice = body.tool_choice ?? 'auto'
    payload.parallel_tool_calls = body.parallel_tool_calls !== false
  }
  if (body.reasoning_effort && body.reasoning_effort !== 'auto') {
    payload.reasoning = { effort: body.reasoning_effort }
  }
  return payload
}

interface SseEvent {
  event: string
  data: Record<string, unknown> | null
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        let event = ''
        let data = ''
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (data) {
          try {
            yield { event, data: JSON.parse(data) as Record<string, unknown> }
          } catch {
            // 忽略非 JSON 帧
          }
        }
        index = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function chunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>): string {
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > codexProxyMAX_BODY) throw new Error('请求体超过 64MB 上限。')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function codexProxySendJson(res: import('node:http').ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function upstreamFetchWithRetry(
  options: CodexProxyOptions,
  payload: Record<string, unknown>,
  sessionId: string,
  signal: AbortSignal
): Promise<Response> {
  let credential = await options.getCredentials()
  let response = await options.fetchImpl(RESPONSES_URL, {
    method: 'POST',
    headers: codexHeaders(credential, sessionId),
    body: JSON.stringify(payload),
    signal
  })
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined)
    credential = await options.refreshCredentials()
    response = await options.fetchImpl(RESPONSES_URL, {
      method: 'POST',
      headers: codexHeaders(credential, sessionId),
      body: JSON.stringify(payload),
      signal
    })
  }
  return response
}

async function codexProxyHandleChat(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  options: CodexProxyOptions
): Promise<void> {
  const body = (await readJson(req)) as ChatBody
  if (!body.model || !Array.isArray(body.messages)) {
    codexProxySendJson(res, 400, { error: { message: '缺少 model 或 messages。', type: 'invalid_request_error' } })
    return
  }
  const responseModel = body.model
  const controller = new AbortController()
  req.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const sessionId = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : randomUUID()
  const payload = toResponsesPayload(body)
  let upstream: Response
  try {
    upstream = await upstreamFetchWithRetry(options, payload, sessionId, controller.signal)
  } catch (err) {
    codexProxySendJson(res, 502, { error: { message: `连接 ChatGPT 订阅失败：${err instanceof Error ? err.message : String(err)}`, type: 'upstream_error' } })
    return
  }
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 800)
    codexProxySendJson(res, upstream.status, { error: { message: `ChatGPT 订阅返回 ${upstream.status}${detail ? `：${detail}` : ''}`, type: 'upstream_error' } })
    return
  }
  const stream = body.stream !== false
  if (!stream) {
    // 非流式请求：收集成普通 completion
    let text = ''
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
    const byItem = new Map<string, { id: string; name: string; args: string }>()
    if (upstream.body) {
      for await (const event of parseSse(upstream.body)) {
        const data = event.data ?? {}
        if (event.event === 'response.output_text.delta') text += String(data.delta ?? '')
        if (event.event === 'response.output_item.added') {
          const item = data.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') byItem.set(String(item.id ?? ''), { id: String(item.call_id ?? ''), name: String(item.name ?? ''), args: '' })
        }
        if (event.event === 'response.function_call_arguments.delta') {
          const state = byItem.get(String(data.item_id ?? ''))
          if (state) state.args += String(data.delta ?? '')
        }
        if (event.event === 'response.function_call_arguments.done') {
          const state = byItem.get(String(data.item_id ?? ''))
          if (state && typeof data.arguments === 'string') state.args = data.arguments
        }
        if (event.event === 'response.output_item.done') {
          const item = data.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') {
            const state = byItem.get(String(item.id ?? ''))
            if (state) state.args = String(item.arguments ?? state.args)
          }
        }
      }
    }
    for (const state of byItem.values()) {
      if (state.id && state.name) toolCalls.push({ id: state.id, name: state.name, arguments: state.args || '{}' })
    }
    codexProxySendJson(res, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {})
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(chunk(responseModel, { role: 'assistant' }))
  const toolByItem = new Map<string, { index: number; id: string; name: string; args: string }>()
  let nextToolIndex = 0
  const emitArgsDelta = (state: { index: number; args: string }, delta: string): void => {
    if (!delta) return
    state.args += delta
    res.write(chunk(responseModel, { tool_calls: [{ index: state.index, function: { arguments: delta } }] }))
  }
  const emitArgsAuthoritative = (state: { index: number; args: string }, full: string): void => {
    if (!full || full === state.args) return
    // 有些模型只在 done / arguments.done 里给完整参数；补发缺失部分，避免工具收到空对象。
    if (full.startsWith(state.args)) {
      emitArgsDelta(state, full.slice(state.args.length))
      return
    }
    if (!state.args) {
      emitArgsDelta(state, full)
      return
    }
    log.warn('codex tool arguments mismatch', { sent: state.args.length, full: full.length })
  }
  let finishReason: string | null = null
  let finished = false
  try {
    if (!upstream.body) throw new Error('ChatGPT 订阅没有返回响应流。')
    for await (const event of parseSse(upstream.body)) {
      const data = event.data ?? {}
      if (event.event === 'response.output_text.delta') {
        res.write(chunk(responseModel, { content: String(data.delta ?? '') }))
      } else if (event.event === 'response.reasoning_summary_text.delta') {
        res.write(chunk(responseModel, { reasoning_content: String(data.delta ?? '') }))
      } else if (event.event === 'response.output_item.added') {
        const item = data.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call') {
          const id = String(item.call_id ?? '')
          const name = String(item.name ?? '')
          const index = nextToolIndex++
          const initialArgs = typeof item.arguments === 'string' ? item.arguments : ''
          const state = { index, id, name, args: '' }
          toolByItem.set(String(item.id ?? ''), state)
          res.write(chunk(responseModel, { tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }))
          emitArgsDelta(state, initialArgs)
        }
      } else if (event.event === 'response.function_call_arguments.delta') {
        const state = toolByItem.get(String(data.item_id ?? ''))
        if (state) emitArgsDelta(state, String(data.delta ?? ''))
      } else if (event.event === 'response.function_call_arguments.done') {
        const state = toolByItem.get(String(data.item_id ?? ''))
        if (state && typeof data.arguments === 'string') emitArgsAuthoritative(state, data.arguments)
      } else if (event.event === 'response.output_item.done') {
        const item = data.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call') {
          const state = toolByItem.get(String(item.id ?? ''))
          if (state && typeof item.arguments === 'string') emitArgsAuthoritative(state, item.arguments)
        }
      } else if (event.event === 'response.completed' || event.event === 'response.incomplete') {
        const response = data.response as Record<string, unknown> | undefined
        const usage = response?.usage as Record<string, unknown> | undefined
        finishReason = event.event === 'response.incomplete' ? 'length' : (toolByItem.size > 0 ? 'tool_calls' : 'stop')
        const usagePayload = usage
          ? {
              prompt_tokens: Number(usage.input_tokens ?? 0),
              completion_tokens: Number(usage.output_tokens ?? 0),
              total_tokens: Number(usage.total_tokens ?? 0),
              ...(Number((usage.input_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0) > 0
                ? { prompt_cache_hit_tokens: Number((usage.input_tokens_details as { cached_tokens?: number }).cached_tokens) }
                : {})
            }
          : undefined
        res.write(chunk(responseModel, {}, finishReason, usagePayload))
        finished = true
      } else if (event.event === 'response.failed' || event.event === 'error') {
        const response = data.response as Record<string, unknown> | undefined
        const error = (response?.error ?? data.error ?? data) as Record<string, unknown>
        throw new Error(String(error.message ?? error.code ?? 'ChatGPT 订阅执行失败。'))
      }
    }
    if (!finished) res.write(chunk(responseModel, {}, 'stop'))
    res.write('data: [DONE]\n\n')
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: 'upstream_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
}

export async function startCodexProxy(options: CodexProxyOptions): Promise<CodexProxyHandle> {
  const listener: RequestListener = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/health') {
        codexProxySendJson(res, 200, { ok: true })
        return
      }
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${options.localToken}`) {
        codexProxySendJson(res, 401, { error: { message: '本地订阅代理令牌无效。', type: 'invalid_request_error' } })
        return
      }
      if (url.pathname === '/v1/models') {
        codexProxySendJson(res, 200, {
          object: 'list',
          data: options.models.map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'codex-subscription',
            context_window: model.contextWindow,
            supports_tools: model.supportsTools
          }))
        })
        return
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        await codexProxyHandleChat(req, res, options)
        return
      }
      codexProxySendJson(res, 404, { error: { message: '未找到该路径。', type: 'not_found' } })
    } catch (err) {
      if (!res.headersSent) codexProxySendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err), type: 'internal_error' } })
      else res.end()
    }
  }
  const server: Server = createServer(listener)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export { MODELS_URL, USAGE_URL }

export const COMMAND_CODE_API = 'https://api.commandcode.ai'

export const COMMAND_CODE_PROVIDER_PREFIX = '/provider/v1'

export const COMMAND_CODE_WHOAMI = '/alpha/whoami'

export const COMMAND_CODE_CREDITS = '/alpha/billing/credits'

export const COMMAND_CODE_STUDIO_AUTH = 'https://commandcode.ai/studio/auth/cli'

export const COMMAND_CODE_CHAT_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 384_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'moonshotai/Kimi-K3', label: 'Kimi K3', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'zai-org/GLM-5.3', label: 'GLM-5.3', contextWindow: 200_000, maxOutput: 64_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'MiniMaxAI/MiniMax-M3', label: 'MiniMax M3', contextWindow: 512_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'Qwen/Qwen3.8-Max', label: 'Qwen3.8 Max', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'xai/grok-4.6', label: 'Grok 4.6', contextWindow: 256_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' }
]

export const COMMAND_CODE_CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 200_000, maxOutput: 64_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'thinking', note: 'Command Code' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'thinking', note: 'Command Code' }
]

export function commandCodeHeaders(apiKey: string, platform = process.platform): Record<string, string> {
  const env = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'text/event-stream',
    'user-agent': 'command-code/1.0.0',
    'x-command-code-cli-version': '1.0.0',
    'x-command-code-cli-environment': env,
    'x-command-code-project-slug': 'morrow',
    'x-command-code-taste-learning': 'false',
    'x-command-code-session-id': 'morrow-session',
    'x-command-code-oss-primary-provider': 'chat-completions',
    'anthropic-version': '2023-06-01'
  }
}

/** GPT-5/6 与 o 系列只认 max_completion_tokens；其余模型用 max_tokens。 */
export function rewriteCommandCodeChat(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  const model = typeof body.model === 'string' ? body.model : ''
  const max = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens) ?? 32_768
  delete body.max_tokens
  delete body.max_completion_tokens
  if (/^(gpt-5|gpt-6|o[1-9])/i.test(model)) body.max_completion_tokens = max
  else body.max_tokens = max
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  const effort = asString(body.reasoning_effort)
  if (effort === 'none' || effort === 'off') delete body.reasoning_effort
  return JSON.stringify(body)
}

export function rewriteCommandCodeAnthropic(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  if (asRecord(body.thinking)) delete body.temperature
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 32_768
  return JSON.stringify(body)
}

/** 模型列表：`{data:[...]}` 或数组；按 `supported_endpoints` 分到 chat / messages。 */
export function parseCommandCodeCatalog(payload: unknown): {
  chat: ModelInfo[]
  claude: ModelInfo[]
} {
  const root = asRecord(payload)
  const list = Array.isArray(root?.data) ? root!.data : Array.isArray(root?.models) ? root!.models : Array.isArray(payload) ? payload : []
  const chat: ModelInfo[] = []
  const claude: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const id = asString(row.id) ?? asString(row.model)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const endpoints = Array.isArray(row.supported_endpoints)
      ? row.supported_endpoints.map((value) => asString(value)).filter((value): value is string => Boolean(value))
      : Array.isArray(row.supportedEndpoints)
        ? row.supportedEndpoints.map((value) => asString(value)).filter((value): value is string => Boolean(value))
        : []
    let wire: 'anthropic' | 'openai' | 'responses' | undefined
    for (const endpoint of endpoints) {
      if (/messages/i.test(endpoint)) { wire = 'anthropic'; break }
      if (/responses/i.test(endpoint)) { wire = 'responses'; break }
      if (/completions/i.test(endpoint)) { wire = 'openai'; break }
    }
    const isClaude = wire === 'anthropic' || (wire === undefined && /^claude[-/]/i.test(id))
    if (!isClaude && wire === 'responses') continue
    const contextWindow = asNumber(row.context_length) ?? asNumber(row.context_window) ?? asNumber(row.contextWindow) ?? asNumber(row.max_context_tokens) ?? 200_000
    const maxOutput = asNumber(row.max_output_tokens) ?? asNumber(row.maxOutputTokens) ?? Math.min(contextWindow, 32_768)
    const effortRaw = row.reasoning_efforts ?? row.supported_reasoning_efforts ?? row.reasoning_effort_support_list
    const reasoningEfforts: ReasoningEffort[] | undefined = Array.isArray(effortRaw)
      ? [...new Set(effortRaw.filter((value): value is ReasoningEffort => isReasoningEffort(value)))]
      : undefined
    const model: ModelInfo = {
      id,
      label: asString(row.name) ?? asString(row.display_name) ?? id,
      contextWindow,
      maxOutput,
      supportsTools: true,
      ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
      note: 'Command Code'
    }
    if (isClaude) {
      model.supportsReasoning = true
      model.reasoningStyle = 'thinking'
      claude.push(model)
    } else {
      model.supportsReasoning = true
      model.reasoningStyle = 'effort'
      chat.push(model)
    }
  }
  return { chat, claude }
}

export function parseCommandCodeAccount(payload: unknown): {
  email?: string
  name?: string
  uid?: string
  plan?: string
} {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const user = asRecord(data.user) ?? asRecord(data.profile) ?? asRecord(data.account) ?? asRecord(data.identity) ?? data
  const subscription = asRecord(data.subscription) ?? asRecord(data.plan) ?? {}
  const email = asString(user.email)
  const name = asString(user.userName) ?? asString(user.name) ?? asString(user.fullName)
  const uid = asString(user.id) ?? asString(user.userId) ?? asString(user.uid) ?? asString(root.userId)
  const plan = asString(subscription.name) ?? asString(subscription.displayName)
    ?? asString(data.planName) ?? asString(data.planLabel)
  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(uid ? { uid } : {}),
    ...(plan ? { plan } : {})
  }
}

/** `/alpha/billing/credits` 的 `windowLimits`。 */
export function parseCommandCodeQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const limits = asRecord(data.windowLimits) ?? asRecord(data.window_limits) ?? asRecord(data.limits) ?? {}
  const windows: AgentQuotaWindow[] = []
  const labels: Record<string, string> = { fiveHour: '5 小时', daily: '每天', weekly: '每周', monthly: '每月' }
  for (const [key, raw] of Object.entries(limits)) {
    const row = asRecord(raw)
    if (!row) continue
    const used = asNumber(row.used)
    const cap = asNumber(row.cap) ?? asNumber(row.total) ?? asNumber(row.limit)
    const percent = asNumber(row.usedPercent) ?? asNumber(row.used_percent)
      ?? (used !== undefined && cap !== undefined && cap > 0 ? (used / cap) * 100 : undefined)
    const resetAt = timestampMs(row.resetAt) ?? timestampMs(row.reset_at)
    const label = labels[key] ?? key
    const window = percentWindow(key, label, percent, resetAt)
    if (window.usedPercent === undefined) continue
    windows.push({ ...window, ...(used !== undefined ? { used } : {}), ...(cap !== undefined ? { total: cap } : {}) })
  }
  const credits = asRecord(data.credits)
  const monthly = asNumber(credits?.monthlyCredits) ?? asNumber(credits?.monthly_credits)
  if (monthly !== undefined) {
    windows.push({ id: 'monthly-credits', label: '每月积分', remaining: monthly, unit: '积分' })
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}

export type GlmRegion = 'intl' | 'cn'

export interface GlmRegionConfig {
  label: string
  business: string
  api: string
  cliProvider: 'zai' | 'bigmodel'
}

export const GLM_REGIONS: Record<GlmRegion, GlmRegionConfig> = {
  intl: {
    label: '国际区（z.ai）',
    business: 'https://api.z.ai',
    api: 'https://api.z.ai',
    cliProvider: 'zai'
  },
  cn: {
    label: '中国区（bigmodel.cn）',
    business: 'https://bigmodel.cn',
    api: 'https://open.bigmodel.cn',
    cliProvider: 'bigmodel'
  }
}

export const ZCODE_API_BASE = 'https://zcode.z.ai/api/v1'

export const CLI_INIT_PATH = '/oauth/cli/init'

export const CLI_POLL_PATH = '/oauth/cli/poll'

export const ANTHROPIC_PATH = '/api/anthropic'

export const QUOTA_PATH = '/api/monitor/usage/quota/limit'

export const GLM_KEY_NAME = 'morrow-glm-coding-plan'

export const GLM_MODELS: ModelInfo[] = [
  {
    id: 'GLM-5.3',
    label: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'GLM Coding Plan'
  },
  {
    id: 'GLM-5.3-Flash',
    label: 'GLM-5.3 Flash',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'GLM Coding Plan · 多模态'
  },
  {
    id: 'GLM-5-Turbo',
    label: 'GLM-5 Turbo',
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsTools: true,
    note: 'GLM Coding Plan · 快速推理'
  }
]

/**
 * Coding Plan 的 Anthropic 面要求流式与思考开启；思考深度用顶层 reasoning_effort，
 * 不发 Anthropic 的 budget_tokens。GLM-5-Turbo 不接受思考字段。
 */
export function rewriteGlmBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  const model = typeof body.model === 'string' ? body.model : ''
  if (/turbo/i.test(model)) {
    delete body.thinking
    delete body.reasoning_effort
    return JSON.stringify(body)
  }
  const thinking = asRecord(body.thinking)
  const budget = asNumber(thinking?.budget_tokens)
  const requested = asString(body.reasoning_effort) ?? (budget === undefined ? 'high'
    : budget <= 1_024 ? 'low'
      : budget <= 8_192 ? 'high' : 'max')
  const ladder = ['low', 'high', 'max']
  const rank: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
  const target = rank[requested] ?? rank.high!
  const snapped = ladder.reduce((best, value) =>
    Math.abs(rank[value]! - target) < Math.abs(rank[best]! - target)
      || (Math.abs(rank[value]! - target) === Math.abs(rank[best]! - target) && rank[value]! > rank[best]!)
      ? value : best, ladder[0]!)
  body.thinking = { type: 'enabled' }
  body.reasoning_effort = snapped
  if (typeof body.max_tokens === 'number' && body.max_tokens < 5_120) body.max_tokens = 8_192
  return JSON.stringify(body)
}

const QUOTA_WINDOWS: Record<number, { id: string; label: string }> = {
  3: { id: 'five-hour', label: '5 小时' },
  5: { id: 'monthly', label: '每月' },
  6: { id: 'weekly', label: '每周' }
}

/** `data.limits[]`：TOKENS_LIMIT 用 percentage，CREDIT_LIMIT 用 currentValue/usage。 */
export function parseGlmQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload)
  if (!root || root.success !== true) {
    return { windows: [], fetchedAt, message: '额度接口没有返回成功结果，请稍后重试。' }
  }
  const data = asRecord(root.data) ?? {}
  const list = Array.isArray(data.limits) ? data.limits : []
  const windows: AgentQuotaWindow[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const type = asString(row.type)
    if (type === 'TIME_LIMIT') continue
    const unit = asNumber(row.unit)
    const window = unit === undefined ? undefined : QUOTA_WINDOWS[unit]
    if (!window || seen.has(window.id)) continue
    let percent = asNumber(row.percentage)
    if (type === 'CREDIT_LIMIT') {
      const used = asNumber(row.currentValue)
      const total = asNumber(row.usage)
      if (used !== undefined && total !== undefined && total > 0) percent = (used / total) * 100
    }
    if (percent === undefined) continue
    seen.add(window.id)
    windows.push(percentWindow(window.id, window.label, percent, timestampMs(row.nextResetTime)))
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的套餐窗口。' } : {})
  }
}

/** 兑换链第 2 步：从 getCustomerInfo 里取默认机构与默认项目。 */
export function parseCustomerScope(payload: unknown): {
  organizationId: string
  projectId: string
  organizationName?: string
  projectName?: string
} {
  const data = asRecord(asRecord(payload)?.data) ?? asRecord(payload) ?? {}
  const orgs = Array.isArray(data.organizations)
    ? data.organizations
    : Array.isArray(data.orgs) ? data.orgs : []
  if (orgs.length === 0) throw new Error('账号下没有可用机构（getCustomerInfo 返回空列表）。')
  const normalized = orgs.map((item) => asRecord(item) ?? {})
  const org = normalized.find((item) => (asString(item.organizationName) ?? asString(item.name) ?? '').includes('默认机构'))
    ?? normalized[0]!
  const orgId = asString(org.organizationId) ?? asString(org.id) ?? asString(org.orgId)
  if (!orgId) throw new Error('客户信息里找不到机构 ID。')
  const projects = Array.isArray(org.projects) ? org.projects.map((item) => asRecord(item) ?? {}) : []
  if (projects.length === 0) throw new Error(`机构 ${orgId} 下没有可用项目。`)
  const project = projects.find((item) => (asString(item.projectName) ?? asString(item.name) ?? '').includes('默认项目'))
    ?? projects[0]!
  const projectId = asString(project.projectId) ?? asString(project.id) ?? asString(project.projectID)
  if (!projectId) throw new Error(`机构 ${orgId} 下找不到项目 ID。`)
  return {
    organizationId: orgId,
    projectId,
    ...(asString(org.organizationName) ? { organizationName: asString(org.organizationName) } : {}),
    ...(asString(project.projectName) ? { projectName: asString(project.projectName) } : {})
  }
}

/** 在 api_keys 列表里挑本线路自己创建的那把；没有就返回 null 让调用方新建。 */
export function pickGlmApiKey(payload: unknown): { id: string; name?: string } | null {
  const root = asRecord(payload)
  const inner = root?.data
  const data = Array.isArray(payload) ? payload : Array.isArray(inner) ? inner : asRecord(inner) ?? root
  const list = Array.isArray(data) ? data : Array.isArray(data?.apiKeys) ? data!.apiKeys : []
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const name = asString(row.name)
    if (name !== GLM_KEY_NAME) continue
    const id = asString(row.id) ?? asString(row.apiKeyId)
    if (id) return { id, ...(name ? { name } : {}) }
  }
  return null
}

const KIMI_MODELS_BASE: ModelInfo[] = [
  { id: 'k3', label: 'Kimi K3', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'k3-256k', label: 'Kimi K3 256K', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'kimi-for-coding', label: 'Kimi for Coding', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'kimi-for-coding-highspeed', label: 'Kimi for Coding 高速', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'k3.1-pro', label: 'Kimi K3.1 Pro', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'k3.1-pro-highspeed', label: 'Kimi K3.1 Pro 高速', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' }
]

/** Kimi K3/K3.1 Pro/K2.8 支持 low/high/max；代理按真实档位改写，不固定 high。 */
export const KIMI_MODELS: ModelInfo[] = KIMI_MODELS_BASE.map((model) => ({
  ...model,
  ...(model.supportsReasoning ? { reasoningEfforts: ['low', 'high', 'max'] as ModelInfo['reasoningEfforts'] } : {})
}))

function kimiProtocolAsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function kimiProtocolNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function resetAt(value: unknown): number | undefined {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Kimi 的 Chat Completions 变体：
 * - 不接受 temperature / top_p；
 * - 只认 max_completion_tokens；
 * - thinking 开启时每条 assistant 消息都必须带 reasoning_content（空串也算）。
 */
export function rewriteKimiBody(raw: string): string {
  const body = JSON.parse(raw) as Record<string, unknown>
  const maxTokens = kimiProtocolNumber(body.max_completion_tokens) ?? kimiProtocolNumber(body.max_tokens) ?? 32_768
  delete body.max_tokens
  delete body.temperature
  delete body.top_p
  delete body.presence_penalty
  delete body.frequency_penalty
  body.max_completion_tokens = Math.max(1_024, Math.min(maxTokens, 262_144))
  body.stream = true
  body.stream_options = { ...(kimiProtocolAsRecord(body.stream_options) ?? {}), include_usage: true }
  const requested = asString(body.reasoning_effort)
  const effort = requested === 'low' || requested === 'high' || requested === 'max' ? requested : 'high'
  body.reasoning_effort = effort
  body.thinking = { type: 'enabled', effort, keep: 'all' }
  if (Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice === undefined) body.tool_choice = 'auto'
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const record = kimiProtocolAsRecord(message)
      if (record?.role === 'assistant' && typeof record.reasoning_content !== 'string') record.reasoning_content = ''
    }
  }
  return JSON.stringify(body)
}

export function parseKimiQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = kimiProtocolAsRecord(payload) ?? {}
  const usages = kimiProtocolAsRecord(root.usages) ?? kimiProtocolAsRecord(root.usageWindows) ?? {}
  const windows: AgentQuotaWindow[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string, entry: Record<string, unknown> | null): void => {
    if (!entry || seen.has(id)) return
    const total = kimiProtocolNumber(entry.limit)
    const used = kimiProtocolNumber(entry.used)
    const remaining = kimiProtocolNumber(entry.remaining)
    const ratio = kimiProtocolNumber(entry.used_ratio) ?? kimiProtocolNumber(entry.usedRatio)
    const usedPercent = ratio !== undefined ? Math.max(0, Math.min(100, ratio * 100))
      : total !== undefined && total > 0 && used !== undefined ? (used / total) * 100
        : total !== undefined && total > 0 && remaining !== undefined ? ((total - remaining) / total) * 100
          : undefined
    const at = resetAt(entry.reset_time ?? entry.resetTime ?? entry.resetsAt)
    if (total === undefined && used === undefined && remaining === undefined && usedPercent === undefined) return
    seen.add(id)
    windows.push({
      id,
      label,
      ...(usedPercent !== undefined ? { usedPercent: Math.max(0, Math.min(100, usedPercent)) } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(at !== undefined ? { resetAt: at } : {})
    })
  }
  add('5h', '5 小时', kimiProtocolAsRecord(usages.limit_5h))
  add('7d', '每周', kimiProtocolAsRecord(usages.limit_7d))
  add('month-total', '每月总池', kimiProtocolAsRecord(usages.limit_month_total))
  add('month-code', '每月 Code', kimiProtocolAsRecord(usages.limit_month_code))
  // 兼容另一种形状：顶层 usage 表示 7 天池，limits[] 带 window 时长。
  if (windows.length === 0) {
    const top = kimiProtocolAsRecord(root.usage)
    if (top) add('7d', '每周', top)
  }
  const limits = Array.isArray(root.limits) ? root.limits : []
  for (const item of limits) {
    const entry = kimiProtocolAsRecord(item)
    if (!entry) continue
    const detail = kimiProtocolAsRecord(entry.detail) ?? entry
    const window = kimiProtocolAsRecord(entry.window)
    const duration = kimiProtocolNumber(window?.duration)
    const minutes = duration === undefined ? undefined
      : asString(window?.timeUnit ?? window?.time_unit) === 'TIME_UNIT_HOUR' ? duration * 60 : duration
    const id = minutes === 300 ? '5h' : minutes === 10_080 ? '7d' : asString(entry.id) ?? asString(entry.name) ?? `limit-${windows.length + 1}`
    const label = minutes === 300 ? '5 小时' : minutes === 10_080 ? '每周' : asString(entry.name) ?? '额度'
    add(id, label, detail)
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}

export type MinimaxRegion = 'cn' | 'global'

export const MINIMAX_REGIONS: Record<MinimaxRegion, { label: string; account: string; agent: string; quota: string[] }> = {
  cn: {
    label: '中国站（minimax.cn）',
    account: 'https://account.minimax.cn',
    agent: 'https://agent.minimax.cn',
    quota: ['https://api.minimax.cn', 'https://api.minimaxi.com']
  },
  global: {
    label: '全球区（minimax.io）',
    account: 'https://account.minimax.io',
    agent: 'https://agent.minimax.io',
    quota: ['https://api.minimax.io']
  }
}

export const MINIMAX_CLIENT_ID = 'mcode-public'

export const MINIMAX_SCOPE = 'agent.default'

export const MINIMAX_AUDIENCE = 'agent-backend'

export const MINIMAX_MESSAGES_PREFIX = '/mavis/api/v1/llm/v1'

export const MINIMAX_QUOTA_PATH = '/v1/api/openplatform/coding_plan/remains'

export const MINIMAX_MODELS: ModelInfo[] = [
  {
    id: 'MiniMax-M3',
    label: 'MiniMax M3',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'MiniMax Code'
  },
  {
    id: 'MiniMax-M3.1-Flash',
    label: 'MiniMax M3.1 Flash',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'MiniMax Code'
  },
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax M2.7',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsTools: true,
    note: 'MiniMax Code'
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    label: 'MiniMax M2.7 HighSpeed',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsTools: true,
    note: 'MiniMax Code · 高速'
  }
]

/** M2.7 不接受思考字段；M3 用 adaptive 选择思考通道，M3.1 只发 output_config。 */
export function rewriteMinimaxBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  const model = typeof body.model === 'string' ? body.model : ''
  const thinking = asRecord(body.thinking)
  const requested = asString(body.reasoning_effort)
  const budget = asNumber(thinking?.budget_tokens)
  const inferred = requested ?? (budget === undefined ? undefined
    : budget <= 1_024 ? 'low'
      : budget <= 4_096 ? 'medium'
        : budget <= 8_192 ? 'high'
          : budget <= 16_384 ? 'xhigh' : 'max')
  delete body.thinking
  delete body.reasoning_effort
  if (!/M2\.7/i.test(model)) {
    const off = inferred === 'off' || inferred === 'none'
    // M3 是 toggle 模型：adaptive 让思考进入 thinking 块；M3.1 是 forced-effort，不能发 thinking。
    if (!/M3\.1/i.test(model)) body.thinking = { type: off ? 'disabled' : 'adaptive' }
    if (!off) {
      body.output_config = { effort: inferred && inferred !== 'minimal' ? inferred : 'high' }
      delete body.temperature
    }
  }
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 32_768
  return JSON.stringify(body)
}

/**
 * `/v1/api/openplatform/coding_plan/remains`：`model_remains[]` 每个模型两窗口。
 * `current_interval_status === 3` 且两个总量都为 0 表示该模型没有额度桶，直接丢弃。
 */
export function parseMinimaxQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const rows = asRecord(payload)?.model_remains
  if (!Array.isArray(rows)) {
    return { windows: [], fetchedAt, message: '额度接口没有返回可识别的数据。' }
  }
  const windows: AgentQuotaWindow[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (!row) continue
    const name = asString(row.model_name) ?? 'MiniMax'
    const intervalTotal = asNumber(row.current_interval_total_count) ?? 0
    const weeklyTotal = asNumber(row.current_weekly_total_count) ?? 0
    const intervalStatus = asNumber(row.current_interval_status) ?? 0
    const weeklyStatus = asNumber(row.current_weekly_status) ?? 0
    if (intervalTotal === 0 && weeklyTotal === 0 && intervalStatus === 3 && weeklyStatus === 3) continue
    const add = (suffix: string, remainingPercent: number | undefined, usedPercent: number | undefined, resetAt: number | undefined): void => {
      if (remainingPercent === undefined && usedPercent === undefined) return
      const percent = usedPercent ?? (remainingPercent !== undefined ? 100 - remainingPercent : undefined)
      windows.push(percentWindow(`${name}-${suffix}`, `${name} · ${suffix}`, percent, resetAt))
    }
    add(
      '5 小时',
      asNumber(row.current_interval_remaining_percent),
      undefined,
      timestampMs(row.end_time)
    )
    add(
      '每周',
      asNumber(row.current_weekly_remaining_percent),
      undefined,
      timestampMs(row.weekly_end_time)
    )
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}

/**
 * 本机 MiniMax Code 的 auth.json（`records` 形）与扁平形都兼容。
 * 返回第一个带 access/refresh 的记录；区域由调用方按文件路径决定。
 */
export function parseMinimaxLocalAuth(payload: unknown): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  recordKey?: string
} | null {
  const root = asRecord(payload)
  if (!root) return null
  const records = asRecord(root.records)
  const candidates: Array<[string | undefined, Record<string, unknown>]> = records
    ? Object.entries(records).flatMap(([key, value]) => {
        const row = asRecord(value)
        return row ? [[key, row] as [string, Record<string, unknown>]] : []
      })
    : [['', root]]
  for (const [key, row] of candidates) {
    const accessToken = asString(row.accessToken) ?? asString(row.access_token)
    const refreshToken = asString(row.refreshToken) ?? asString(row.refresh_token)
    const expiresAt = asNumber(row.expiresAtMs) ?? timestampMs(row.expires_at) ?? timestampMs(row.expiresAt)
    if (!accessToken || !refreshToken || !expiresAt) continue
    return {
      accessToken,
      refreshToken,
      expiresAt,
      ...(key ? { recordKey: key } : {})
    }
  }
  return null
}

export const OPENCODE_ZEN_BASE = 'https://opencode.ai/zen/v1'

export const OPENCODE_MODELS: ModelInfo[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 400_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 200_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'big-pickle', label: 'Big Pickle', contextWindow: 128_000, maxOutput: 32_768, supportsTools: true, note: 'OpenCode Zen' }
]

/**
 * 本机 `auth.json` 按 provider 分键。只取 `type:"api"` 的密钥；
 * 优先 OpenCode Zen 自己的键，其次任意 api 键。OAuth 记录（Copilot/Codex）不在这里冒用。
 */
export function parseOpencodeAuth(payload: unknown): {
  key: string
  provider: string
  type: 'api' | 'oauth' | 'wellknown'
} | null {
  const root = asRecord(payload)
  if (!root) return null
  const preferred = ['opencode', 'opencode-zen', 'zen', 'opencode-zen-api']
  const entries = Object.entries(root)
    .map(([provider, value]) => ({ provider, record: asRecord(value) }))
    .filter((entry): entry is { provider: string; record: Record<string, unknown> } => Boolean(entry.record))
  const ordered = [
    ...preferred.flatMap((name) => entries.filter((entry) => entry.provider.toLowerCase() === name)),
    ...entries.filter((entry) => !preferred.some((name) => entry.provider.toLowerCase() === name))
  ]
  for (const entry of ordered) {
    const type = asString(entry.record.type)
    const key = asString(entry.record.key) ?? asString(entry.record.apiKey)
    if (type === 'api' && key) return { key, provider: entry.provider, type: 'api' }
  }
  return null
}

/** Zen `/models` → ModelInfo；目录不可用时由调用方回退到随包列表。 */
export function parseOpencodeModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload)
  const data = asRecord(root?.data)
  const list = Array.isArray(root?.data)
    ? root!.data
    : Array.isArray(data?.models) ? data!.models
      : Array.isArray(root?.models) ? root!.models
        : Array.isArray(payload) ? payload : []
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const id = asString(row.id) ?? asString(row.name)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label: asString(row.name) ?? id,
      contextWindow: Number(row.context_length ?? row.context_window ?? row.contextWindow) || 128_000,
      maxOutput: Number(row.max_output_tokens ?? row.maxOutputTokens) || 32_768,
      supportsTools: true,
      note: 'OpenCode Zen'
    })
  }
  return models
}

export function rewriteOpencodeBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 32_768
  return JSON.stringify(body)
}

export type QoderRegion = 'global' | 'cn'

export interface QoderModel {
  id: string
  upstreamKey: string
  label: string
  contextWindow: number
  supportsImages: boolean
  reasoning: boolean
  /** 账号模型目录真实支持的档位；未提供时只显示自动，避免发送无效档位 */
  reasoningEfforts?: ReasoningEffort[]
  /** 账号模型目录真实可选上下文（200K/400K/1M，以接口返回为准） */
  contextOptions?: number[]
  /** 账号模型目录的默认上下文；未提供时回落到 contextWindow */
  defaultContextWindow?: number
}

// 模型目录只来自 Qoder 账号接口 `/api/v2/model/list`；不再内置猜测的模型名/上下文/档位。

const HOSTS = {
  global: { inference: 'https://api3.qoder.sh', openapi: 'https://openapi.qoder.sh', center: 'https://center.qoder.sh', pat: 'https://qoder.com/account/integrations' },
  cn: { inference: 'https://gateway.qoder.com.cn', openapi: 'https://openapi.qoder.com.cn', center: 'https://gateway.qoder.com.cn', pat: 'https://qoder.com.cn/account/integrations' }
} as const

const CHAT_PATH = '/api/v2/service/pro/sse/agent_chat_generation'

const CHAT_QUERY = 'FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

const JOB_TOKEN_EXCHANGE_PATH = '/api/v1/jobToken/exchange'

const USERINFO_PATH = '/api/v1/userinfo'

const QUOTA_USAGE_PATH = '/api/v2/quota/usage'

const REFRESH_TOKEN_PATH = '/algo/api/v3/user/refresh_token'

const COSY_VERSION = '1.1.72'

const COSY_OPENAPI_VERSION = '1.0.1'

const COSY_CLIENT_TYPE = '5'

const COSY_MACHINE_TYPE = '5'

const COSY_LOGIN_VERSION = 'v2'

const QODER_BODY_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'

const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const QODER_BODY_PADDING_CHAR = '$'

const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

const qoderProxyMAX_BODY = 64 * 1024 * 1024

export interface QoderCredential {
  accessToken: string
  refreshToken?: string
  personalToken?: string
  expiresAt: number
  region: QoderRegion
  uid: string
  rawUserInfo: string
  dataPolicyAgreed: boolean
  email?: string
  name?: string
  plan?: string
  organizationId?: string
  organizationTags?: string[]
  machineId: string
}

export interface QoderProxyOptions {
  localToken: string
  models: QoderModel[]
  getCredential: () => Promise<QoderCredential>
  refreshCredential: () => Promise<QoderCredential>
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
}

export interface QoderProxyHandle {
  port: number
  close(): Promise<void>
}

function qoderMaskedBytes(entropy: Buffer): Buffer {
  const u = Buffer.from(entropy).reverse()
  u[6] = (u[6]! & 0x0f) | 0x40
  u[8] = (u[8]! & 0x3f) | 0x80
  return u
}

function requestUuid(entropy: Buffer): string {
  const hex = qoderMaskedBytes(entropy).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function runtimeAuth(rawUserInfo: string): { encryptUserInfo: string; key: string } {
  const keyText = qoderMaskedBytes(randomBytes(16)).toString('hex').slice(0, 16)
  const keyBytes = Buffer.from(keyText, 'utf8')
  const cipher = createCipheriv('aes-128-cbc', keyBytes, keyBytes)
  const encrypted = Buffer.concat([cipher.update(rawUserInfo, 'utf8'), cipher.final()]).toString('base64')
  const key = publicEncrypt({ key: RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, keyBytes).toString('base64')
  return { encryptUserInfo: encrypted, key }
}

const ENCODE_TABLE: readonly string[] = (() => {
  const table: string[] = new Array(128).fill('')
  for (let i = 0; i < QODER_STD_ALPHABET.length; i += 1) table[QODER_STD_ALPHABET.charCodeAt(i)] = QODER_BODY_ALPHABET[i]!
  table['='.charCodeAt(0)] = QODER_BODY_PADDING_CHAR
  return table
})()

export function encodeQoderBody(raw: string): string {
  const standard = Buffer.from(raw, 'utf8').toString('base64')
  const third = Math.floor(standard.length / 3)
  const reordered = standard.slice(standard.length - third) + standard.slice(third, standard.length - third) + standard.slice(0, third)
  let out = ''
  for (let i = 0; i < reordered.length; i += 1) out += ENCODE_TABLE[reordered.charCodeAt(i)] ?? reordered[i]
  return out
}

const DECODE_TABLE: readonly string[] = (() => {
  const table: string[] = new Array(128).fill('')
  for (let i = 0; i < QODER_BODY_ALPHABET.length; i += 1) table[QODER_BODY_ALPHABET.charCodeAt(i)] = QODER_STD_ALPHABET[i]!
  table[QODER_BODY_PADDING_CHAR.charCodeAt(0)] = '='
  return table
})()

/** 编码的逆运算；仅用于诊断与测试，不参与线上请求。 */
export function decodeQoderBody(encoded: string): string {
  let reordered = ''
  for (let i = 0; i < encoded.length; i += 1) reordered += DECODE_TABLE[encoded.charCodeAt(i)] ?? encoded[i]
  const n = reordered.length
  const third = Math.floor(n / 3)
  const standard = reordered.slice(n - third) + reordered.slice(third, n - third) + reordered.slice(0, third)
  return Buffer.from(standard, 'base64').toString('utf8')
}

export function decodeQoderAdoptPayload(content: string, machineId: string): string {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) return trimmed
  const key = machineId.slice(0, 16)
  if (key.length !== 16) throw new Error('Qoder machine_id 不足 16 字符')
  const keyBytes = Buffer.from(key, 'utf8')
  const decipher = createDecipheriv('aes-128-cbc', keyBytes, keyBytes)
  return Buffer.concat([decipher.update(Buffer.from(trimmed, 'base64')), decipher.final()]).toString('utf8')
}

function qoderProxyAsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asEffort(value: string): ReasoningEffort | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'none' || normalized === 'disabled' || normalized === 'disable') return 'off'
  return isReasoningEffort(normalized) ? normalized : undefined
}

/** 读取 Qoder 账号模型目录的 context_config / 可选上下文；不自行生成档位。 */
function qoderContextMeta(row: Record<string, unknown>): {
  contextWindow: number
  contextOptions?: number[]
  defaultContextWindow: number
} {
  const values: number[] = []
  let markedDefault: number | undefined
  const config = qoderProxyAsRecord(row.context_config)
  if (config) {
    for (const entry of Object.values(config)) {
      const record = qoderProxyAsRecord(entry)
      const token = asNumber(record?.token_count)
      if (!token || token <= 0) continue
      values.push(Math.round(token))
      if (record?.is_default === true) markedDefault = Math.round(token)
    }
  }
  const available = Array.isArray(row.available_context_windows) ? row.available_context_windows : []
  for (const entry of available) {
    const token = asNumber(qoderProxyAsRecord(entry)?.token_count ?? entry)
    if (token && token > 0) values.push(Math.round(token))
  }
  const options = [...new Set(values)].sort((a, b) => a - b)
  const maxInput = asNumber(row.max_input_tokens)
  const contextWindow = options.length > 0 ? Math.max(...options) : Math.max(1_024, Math.round(maxInput ?? 200_000))
  const explicitDefault = markedDefault ?? asNumber(row.default_context_window)
  const defaultContextWindow = explicitDefault && (options.length === 0 || options.includes(explicitDefault))
    ? explicitDefault
    : options.length > 0
      ? options[0]!
      : contextWindow
  return {
    contextWindow,
    ...(options.length > 0 ? { contextOptions: options } : {}),
    defaultContextWindow
  }
}

/** 读取 thinking_config / available_reasoning_effort 的真实档位。 */
function qoderReasoningEfforts(row: Record<string, unknown>): ReasoningEffort[] | undefined {
  const efforts = new Set<ReasoningEffort>()
  let supportsDisabled = row.supports_disabled === true || row.supportsDisabled === true
  for (const config of [
    qoderProxyAsRecord(row.thinking_config),
    qoderProxyAsRecord(row.thinkingConfig),
    qoderProxyAsRecord(row.available_reasoning_effort),
    qoderProxyAsRecord(row.availableReasoningEffort)
  ]) {
    if (!config) continue
    const enabled = qoderProxyAsRecord(config.enabled) ?? config
    const effortValues = enabled.efforts
    if (Array.isArray(effortValues)) {
      for (const value of effortValues) {
        const effort = typeof value === 'string' ? asEffort(value) : undefined
        if (effort) efforts.add(effort)
      }
    } else {
      const effortMap = qoderProxyAsRecord(effortValues)
      if (effortMap) {
        for (const key of Object.keys(effortMap)) {
          const effort = asEffort(key)
          if (effort) efforts.add(effort)
        }
      }
    }
    if (enabled.supports_disabled === true || enabled.supportsDisabled === true || config.supports_disabled === true) {
      supportsDisabled = true
    }
  }
  if (supportsDisabled) efforts.add('off')
  return efforts.size > 0 ? [...efforts] : undefined
}

/**
 * 解析 Qoder `/api/v2/model/list?Encode=1` 的账号模型目录。
 * 只使用接口返回的模型、上下文档位和思考档位，不猜测。
 */
export function parseQoderModelCatalog(payload: unknown): QoderModel[] {
  const root = qoderProxyAsRecord(payload)
  if (!root) return []
  const scene = Array.isArray(root.chat)
    ? root.chat
    : Array.isArray(root.assistant)
      ? root.assistant
      : Array.isArray(root.app)
        ? root.app
        : []
  const seen = new Set<string>()
  const models: QoderModel[] = []
  for (const item of scene) {
    const row = qoderProxyAsRecord(item)
    if (!row || row.enable === false) continue
    const key = asText(row.key)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const context = qoderContextMeta(row)
    const efforts = qoderReasoningEfforts(row)
    models.push({
      id: key,
      upstreamKey: key,
      label: asText(row.display_name) ?? key,
      contextWindow: context.contextWindow,
      ...(context.contextOptions ? { contextOptions: context.contextOptions } : {}),
      defaultContextWindow: context.defaultContextWindow,
      supportsImages: row.is_vl === true,
      reasoning: row.is_reasoning === true || Boolean(efforts?.length),
      ...(efforts ? { reasoningEfforts: efforts } : {})
    })
  }
  return models
}

/** 从账号模型目录接口读取模型/上下文/思考档位；COSY 头与聊天请求共用。 */
export async function fetchQoderModelCatalog(
  credential: QoderCredential,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
): Promise<QoderModel[]> {
  const url = `${HOSTS[credential.region].inference}/algo/api/v2/model/list?Encode=1`
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      ...cosyHeaders(credential, url, '', 'auto'),
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    throw new Error(`Qoder 账号模型目录读取失败（HTTP ${response.status}）。`)
  }
  const payload = await response.json().catch(() => null)
  const models = parseQoderModelCatalog(payload)
  if (models.length === 0) throw new Error('Qoder 账号模型目录为空。')
  return models
}

function cosySignedPath(url: string): string {
  try {
    const pathname = new URL(url).pathname
    return pathname.startsWith('/algo') ? pathname.slice('/algo'.length) : pathname
  } catch {
    return url
  }
}

function cosyHeaders(credential: QoderCredential, url: string, encodedBody: string, modelKey: string): Record<string, string> {
  // UserInfo 的键序是协议的一部分，且 security_oauth_token 必须是当前 access token。
  const rawUserInfo = '{"uid":' + JSON.stringify(credential.uid || 'qoder-user')
    + ',"security_oauth_token":' + JSON.stringify(credential.accessToken)
    + ',"name":' + JSON.stringify(credential.name ?? '')
    + ',"aid":""'
    + ',"email":' + JSON.stringify(credential.email ?? '') + '}'
  const runtime = runtimeAuth(rawUserInfo)
  const requestId = requestUuid(randomBytes(16))
  const unix = Math.floor(Date.now() / 1000).toString()
  const payloadB64 = Buffer.from(
    '{"version":"v1","requestId":' + JSON.stringify(requestId)
      + ',"info":' + JSON.stringify(runtime.encryptUserInfo)
      + ',"cosyVersion":' + JSON.stringify(COSY_VERSION)
      + ',"ideVersion":""}',
    'utf8'
  ).toString('base64')
  const signature = createHash('md5')
    .update(payloadB64).update('\n')
    .update(runtime.key).update('\n')
    .update(unix).update('\n')
    .update(encodedBody).update('\n')
    .update(cosySignedPath(url))
    .digest('hex')
  return {
    Accept: 'text/event-stream',
    Authorization: `Bearer COSY.${payloadB64}.${signature}`,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Cosy-Business-Product': 'cli',
    'Cosy-Business-Type': 'agent',
    'Cosy-ClientType': COSY_CLIENT_TYPE,
    'Cosy-Data-Policy': credential.dataPolicyAgreed ? 'agree' : 'disagree',
    'Cosy-Date': unix,
    'Cosy-Key': runtime.key,
    'Cosy-MachineId': credential.machineId,
    'Cosy-MachineToken': credential.machineId,
    'Cosy-MachineType': COSY_MACHINE_TYPE,
    'Cosy-Scene': 'assistant',
    'Cosy-User': credential.uid,
    'Cosy-Version': COSY_VERSION,
    'Login-Version': COSY_LOGIN_VERSION,
    'Content-Type': 'application/json',
    ...(credential.organizationId ? { 'Cosy-Organization-Id': credential.organizationId } : {}),
    ...(credential.organizationTags?.length ? { 'Cosy-Organization-Tags': credential.organizationTags.join(',') } : {}),
    'X-Model-Key': modelKey,
    'X-Model-Source': 'system'
  }
}

interface OpenAIRequestBody {
  model?: string
  messages?: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  reasoning_effort?: string
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      const record = part && typeof part === 'object' ? part as Record<string, unknown> : null
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

function qoderToolId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
  const safe = sanitized || 'call'
  return safe.length <= 64 ? safe : safe.slice(0, 64)
}

function qoderUserContent(value: unknown): string | Array<Record<string, unknown>> {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const part of value) {
    const record = part && typeof part === 'object' ? part as Record<string, unknown> : null
    if (!record) continue
    if (record.type === 'text' && typeof record.text === 'string') {
      if (record.text !== '') parts.push({ type: 'text', text: record.text })
      continue
    }
    if (record.type !== 'image_url') continue
    const image = record.image_url && typeof record.image_url === 'object' ? record.image_url as Record<string, unknown> : null
    const url = typeof image?.url === 'string' ? image.url : typeof record.image_url === 'string' ? record.image_url : ''
    if (!url) continue
    hasImage = true
    parts.push({ type: 'image_url', image_url: { url } })
  }
  if (!hasImage) return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
  return parts
}

function buildQoderRequest(
  body: OpenAIRequestBody,
  credential: QoderCredential,
  models: QoderModel[],
  sessionId: string,
  contextWindow?: number
): { payload: Record<string, unknown>; upstreamKey: string } {
  const model = models.find((item) => item.id === body.model)
  if (!model) throw new Error(`Qoder 模型不存在：${body.model ?? '未指定'}`)
  const systems = (body.messages ?? []).filter((message) => message.role === 'system' || message.role === 'developer')
  const system = systems.map((message) => contentText(message.content)).filter(Boolean).join('\n\n')
  const messages: Array<Record<string, unknown>> = []
  if (system) messages.push({ role: 'system', content: system })
  for (const message of body.messages ?? []) {
    const role = typeof message.role === 'string' ? message.role : 'user'
    if (role === 'system' || role === 'developer') continue
    if (role === 'tool') {
      const toolCallId = typeof message.tool_call_id === 'string' ? qoderToolId(message.tool_call_id) : ''
      messages.push({ role: 'tool', ...(toolCallId ? { tool_call_id: toolCallId } : {}), content: contentText(message.content) })
      continue
    }
    if (role === 'assistant') {
      const text = contentText(message.content)
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => {
            const record = call && typeof call === 'object' ? call as Record<string, unknown> : {}
            const fn = record.function && typeof record.function === 'object' ? record.function as Record<string, unknown> : {}
            return {
              id: qoderToolId(typeof record.id === 'string' ? record.id : 'call'),
              type: 'function',
              function: {
                name: typeof fn.name === 'string' ? fn.name : '',
                arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
              }
            }
          })
        : []
      messages.push({ role: 'assistant', content: text !== '' ? text : toolCalls.length > 0 ? ' ' : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
      continue
    }
    const content = qoderUserContent(message.content)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }
  // Qoder 的接口硬限制是 32768；Agent 按模型 maxOutput 传入更大的值时必须截断。
  const maxTokens = Math.min(Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 32_768, 32_768)
  const parameters: Record<string, unknown> = { max_tokens: maxTokens }
  if (typeof body.temperature === 'number') parameters.temperature = body.temperature
  const requestedEffort = body.reasoning_effort
  if (requestedEffort && requestedEffort !== 'auto') {
    const supported = model.reasoningEfforts
    if (supported && supported.includes(requestedEffort as ReasoningEffort)) {
      if (requestedEffort === 'off') parameters.enable_thinking = false
      else {
        parameters.enable_thinking = true
        parameters.reasoning_effort = requestedEffort
      }
    }
  }
  const effectiveContext = Math.min(
    model.contextWindow,
    Math.max(1_024, Math.round(
      contextWindow && contextWindow > 0
        ? contextWindow
        : model.defaultContextWindow ?? model.contextWindow
    ))
  )
  const tools = Array.isArray(body.tools) ? body.tools : []
  let lastUserText = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    lastUserText = contentText(messages[index]?.content)
    break
  }
  const recordHash = createHash('sha256').update('morrow-qoder').update('\0' + model.upstreamKey)
  for (const message of messages) recordHash.update('\0' + String(message.role ?? '')).update('\0' + JSON.stringify(message.content ?? ''))
  if (tools.length > 0) recordHash.update('\0' + JSON.stringify(tools))
  recordHash.update('\0mt=' + maxTokens)
  const recordId = recordHash.digest('hex').slice(0, 16)
  const sessionPrefix = createHash('sha256')
    .update('morrow-qoder-session').update('\0' + credential.uid).update('\0' + model.upstreamKey)
    .digest('hex').slice(0, 16)
  const payload = {
    agent_id: 'agent_common',
    aliyun_user_type: '',
    business: { begin_at: Date.now(), id: randomUUID(), name: lastUserText.slice(0, 30) || 'Morrow', product: 'cli', stage: 'start', type: 'agent', version: COSY_VERSION },
    chat_context: {},
    chat_record_id: recordId,
    chat_task: 'FREE_INPUT',
    custom_model: null,
    is_reply: true,
    is_retry: false,
    messages,
    model_config: { key: model.upstreamKey, format: 'openai', source: 'system', enable: true, display_name: model.label, is_vl: model.supportsImages, is_reasoning: model.reasoning, max_input_tokens: effectiveContext },
    parameters,
    request_id: randomUUID(),
    request_set_id: recordId,
    session_id: `${sessionPrefix}-${sessionId}`,
    session_type: 'qodercli',
    source: 1,
    stream: true,
    system,
    task_id: 'common',
    tools,
    version: '3'
  }
  return { payload, upstreamKey: model.upstreamKey }
}

function openAIChunk(model: string, delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
}

async function qoderProxyReadBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > qoderProxyMAX_BODY) throw new Error('请求体超过 64MB。')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function qoderProxySendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function upstream(options: QoderProxyOptions, payload: Record<string, unknown>, credential: QoderCredential, upstreamKey: string, signal: AbortSignal): Promise<Response> {
  const url = `${HOSTS[credential.region].inference}/algo${CHAT_PATH}?${CHAT_QUERY}`
  const encoded = encodeQoderBody(JSON.stringify(payload))
  return options.fetchImpl(url, {
    method: 'POST',
    headers: cosyHeaders(credential, url, encoded, upstreamKey),
    body: encoded,
    signal
  })
}

async function qoderProxyHandleChat(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, options: QoderProxyOptions): Promise<void> {
  const body = await qoderProxyReadBody(req) as OpenAIRequestBody
  if (!body.model || !Array.isArray(body.messages)) {
    qoderProxySendJson(res, 400, { error: { message: '缺少 model 或 messages。' } })
    return
  }
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  const sessionId = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : randomUUID()
  const contextHeader = typeof req.headers['x-morrow-context-window'] === 'string'
    ? Number(req.headers['x-morrow-context-window'])
    : undefined
  let credential = await options.getCredential()
  let { payload, upstreamKey } = buildQoderRequest(
    body,
    credential,
    options.models,
    sessionId,
    contextHeader && Number.isFinite(contextHeader) ? contextHeader : undefined
  )
  let response = await upstream(options, payload, credential, upstreamKey, controller.signal)
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined)
    credential = await options.refreshCredential()
    response = await upstream(options, payload, credential, upstreamKey, controller.signal)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 800)
    qoderProxySendJson(res, response.status, { error: { message: `Qoder 返回 ${response.status}${detail ? `：${detail}` : ''}` } })
    return
  }
  const modelId = body.model
  const stream = body.stream !== false
  const contentType = response.headers.get('content-type') ?? ''
  if (!stream && !contentType.includes('text/event-stream')) {
    const payloadJson = await response.json().catch(() => null)
    qoderProxySendJson(res, 200, payloadJson ?? { error: { message: 'Qoder 返回了无法解析的响应。' } })
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(openAIChunk(modelId, { role: 'assistant' }))
  const reader = response.body?.getReader()
  if (!reader) {
    res.end()
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let sentFinish = false
  const finish = (reason: string): void => {
    if (sentFinish) return
    sentFinish = true
    res.write(openAIChunk(modelId, {}, reason))
    res.write('data: [DONE]\n\n')
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of block.split('\n')) {
          if (line.startsWith('event:finish')) {
            finish('stop')
            continue
          }
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          if (raw === '[DONE]') { finish('stop'); continue }
          let envelope: Record<string, unknown>
          try { envelope = JSON.parse(raw) as Record<string, unknown> } catch { continue }
          const statusCode = Number(envelope.statusCodeValue ?? 200)
          const innerText = typeof envelope.body === 'string' ? envelope.body : ''
          if (statusCode !== 200) {
            res.write(`data: ${JSON.stringify({ error: { message: innerText || `Qoder 信封状态 ${statusCode}` } })}\n\n`)
            finish('stop')
            continue
          }
          if (!innerText) continue
          if (innerText === '[DONE]') { finish('stop'); continue }
          let inner: Record<string, unknown>
          try { inner = JSON.parse(innerText) as Record<string, unknown> } catch { continue }
          const innerError = inner.error && typeof inner.error === 'object' ? inner.error as Record<string, unknown> : null
          if (innerError) {
            res.write(`data: ${JSON.stringify({ error: { message: typeof innerError.message === 'string' ? innerError.message : 'Qoder 返回了错误帧。' } })}\n\n`)
            finish('stop')
            continue
          }
          const usage = inner.usage as Record<string, unknown> | undefined
          const choice = Array.isArray(inner.choices) ? inner.choices[0] as Record<string, unknown> | undefined : undefined
          const delta = choice?.delta as Record<string, unknown> | undefined
          const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
          if (delta && Object.keys(delta).length > 0) {
            res.write(openAIChunk(modelId, delta, null, usage))
          }
          if (finishReason) finish(finishReason === 'tool_calls' ? 'tool_calls' : finishReason === 'length' ? 'length' : 'stop')
        }
        index = buffer.indexOf('\n\n')
      }
    }
    if (!sentFinish) finish('stop')
  } catch (err) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`)
    finish('stop')
  } finally {
    if (!res.writableEnded) res.end()
    reader.releaseLock()
  }
}

export async function startQoderProxy(options: QoderProxyOptions): Promise<QoderProxyHandle> {
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/health') return qoderProxySendJson(res, 200, { ok: true })
      if ((req.headers.authorization ?? '') !== `Bearer ${options.localToken}`) return qoderProxySendJson(res, 401, { error: { message: '本地订阅代理令牌无效。' } })
      if (url.pathname === '/v1/models') {
        return qoderProxySendJson(res, 200, { object: 'list', data: options.models.map((model) => ({ id: model.id, object: 'model', owned_by: 'qoder-subscription', context_window: model.contextWindow })) })
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return qoderProxyHandleChat(req, res, options)
      return qoderProxySendJson(res, 404, { error: { message: '未找到该路径。' } })
    } catch (err) {
      qoderProxySendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, close: async () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

export { HOSTS, QUOTA_USAGE_PATH, JOB_TOKEN_EXCHANGE_PATH, USERINFO_PATH, REFRESH_TOKEN_PATH, COSY_OPENAPI_VERSION, COSY_CLIENT_TYPE }

export type StepProfile = 'step_plan' | 'step_plan_oversea' | 'platform_cn' | 'platform_oversea'

export interface StepProfileConfig {
  label: string
  /** 模型面 base（末尾不带 /v1）。 */
  api: string
  auth: string
  keyPage: string
  requiresLogin: boolean
}

export const STEP_PROFILES: Record<StepProfile, StepProfileConfig> = {
  step_plan: {
    label: 'Step Plan（中国区）',
    api: 'https://api.stepfun.com/step_plan',
    auth: 'https://platform.stepfun.com',
    keyPage: 'https://platform.stepfun.com/step-plan',
    requiresLogin: true
  },
  step_plan_oversea: {
    label: 'Step Plan（国际区）',
    api: 'https://api.stepfun.ai/step_plan',
    auth: 'https://platform.stepfun.ai',
    keyPage: 'https://platform.stepfun.ai/step-plan',
    requiresLogin: true
  },
  platform_cn: {
    label: 'Step 开放平台（中国区 Key）',
    api: 'https://api.stepfun.com',
    auth: 'https://platform.stepfun.com',
    keyPage: 'https://platform.stepfun.com/interface-key',
    requiresLogin: false
  },
  platform_oversea: {
    label: 'Step 开放平台（国际区 Key）',
    api: 'https://api.stepfun.ai',
    auth: 'https://platform.stepfun.ai',
    keyPage: 'https://platform.stepfun.ai/interface-key',
    requiresLogin: false
  }
}

export const STEP_CLI_INIT_PATH = '/api/stdhttp/v1/cli-login/init'

export const STEP_CLI_POLL_PATH = '/api/stdhttp/v1/cli-login/poll'

export const STEP_MODELS_PATH = '/v1/models'

export const STEP_CHAT_PATH = '/v1/chat/completions'

export function profileOf(value: string | undefined): StepProfile {
  return value && value in STEP_PROFILES ? value as StepProfile : 'step_plan'
}

/** `/v1/models` → ModelInfo；上游字段全部按「可能缺失」处理。 */
export function parseStepModels(payload: unknown, profile: StepProfile = 'step_plan'): {
  models: ModelInfo[]
  efforts: Record<string, string[]>
} {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data)
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(data?.models) ? data!.models
      : Array.isArray(root.models) ? root.models
        : Array.isArray(payload) ? payload : []
  const models: ModelInfo[] = []
  const efforts: Record<string, string[]> = {}
  const seen = new Set<string>()
  const rows = list.map((item) => asRecord(item)).filter((row): row is Record<string, unknown> => Boolean(row))
  const typed = rows.some((row) => asString(row.model_type) !== undefined)
  const usable = new Set(['大语言模型', '路由模型'])
  for (const row of rows) {
    const id = asString(row.id)
    if (!id || seen.has(id)) continue
    if (typed && !usable.has(asString(row.model_type) ?? '')) continue
    seen.add(id)
    const contextWindow = asNumber(row.max_input_tokens) ?? 128_000
    const ladder = Array.isArray(row.reasoning_effort_support_list)
      ? row.reasoning_effort_support_list.map((value) => asString(value)).filter((value): value is string => Boolean(value))
      : []
    const supportsReasoning = row.enable_reason === true
      || (row.enable_reason === undefined && ladder.some((value) => !/^(off|none|disabled|disable)$/i.test(value)))
    const modelEfforts = ladder.filter((value): value is ReasoningEffort => isReasoningEffort(value))
    if (supportsReasoning && ladder.length > 0) efforts[id] = ladder
    models.push({
      id,
      label: asString(row.name) ?? id,
      contextWindow,
      maxOutput: Math.min(contextWindow, 32_768),
      supportsTools: true,
      ...(supportsReasoning ? { supportsReasoning: true, reasoningStyle: 'effort' as const } : {}),
      ...(supportsReasoning && modelEfforts.length > 0 ? { reasoningEfforts: modelEfforts } : {}),
      note: STEP_PROFILES[profile].label
    })
  }
  return { models, efforts }
}

/**
 * Step 只接受 `max_tokens`，且思考档位必须落在该模型的支持列表里。
 * 不在列表里的档位收敛到最接近的一档；模型完全不支持思考时不发字段。
 */
export function rewriteStepBody(raw: string, effortLists: Record<string, string[]> = {}): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  const model = typeof body.model === 'string' ? body.model : ''
  const max = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens) ?? 32_768
  delete body.max_completion_tokens
  body.max_tokens = Math.max(1, max)
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  const allowed = (effortLists[model] ?? []).filter((value) => !/^(off|none|disabled|disable)$/i.test(value))
  const requested = asString(body.reasoning_effort)
  if (allowed.length === 0 || (requested && /^(off|none|disabled|disable)$/i.test(requested))) {
    delete body.reasoning_effort
  } else if (requested && !allowed.includes(requested)) {
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const target = order.indexOf(requested)
    const pick = allowed
      .filter((value) => order.includes(value))
      .sort((a, b) => Math.abs(order.indexOf(a) - target) - Math.abs(order.indexOf(b) - target))[0]
    if (pick) body.reasoning_effort = pick
    else delete body.reasoning_effort
  }
  return JSON.stringify(body)
}

/** 本机 StepCode auth.json 的两种形状。 */
export function parseStepLocalAuth(payload: unknown): {
  apiKey: string
  profile?: StepProfile
  uid?: string
} | null {
  const root = asRecord(payload)
  if (!root) return null
  const flatKey = asString(root.apiKey) ?? asString(root.api_key)
  if (flatKey) {
    const profile = asString(root.profile)
    return {
      apiKey: flatKey,
      ...(profile && profile in STEP_PROFILES ? { profile: profile as StepProfile } : {}),
      ...(asString(root.uid) ? { uid: asString(root.uid) } : {})
    }
  }
  const step = asRecord(root.step)
  if (step) {
    const key = asString(step.access) ?? asString(step.key) ?? asString(step.accessToken)
    if (key) {
      const profile = asString(step.profile)
      return {
        apiKey: key,
        ...(profile && profile in STEP_PROFILES ? { profile: profile as StepProfile } : {}),
        ...(asString(step.uid) ? { uid: asString(step.uid) } : {})
      }
    }
  }
  return null
}

const antigravitySubscriptionPROVIDER_ID = 'antigravity-subscription'

const antigravitySubscriptionQUOTA_CACHE_MS = 2 * 60_000

const antigravitySubscriptionREFRESH_MARGIN_MS = 5 * 60_000

const antigravitySubscriptionLOGIN_TIMEOUT_MS = 5 * 60_000

const antigravitySubscriptionMAX_BODY = 64 * 1024 * 1024

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

function antigravitySubscriptionReadBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > antigravitySubscriptionMAX_BODY) {
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

function antigravitySubscriptionSendJson(res: ServerResponse, status: number, body: unknown): void {
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
    if (current.expiresAt - Date.now() > antigravitySubscriptionREFRESH_MARGIN_MS) return current
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
    const localToken = getSettingsStore().getApiKey(antigravitySubscriptionPROVIDER_ID) ?? randomLocalToken()
    this.localToken = localToken
    const server = createServer((req, res) => {
      void this.handleProxy(req, res).catch((err) => {
        if (!res.headersSent) antigravitySubscriptionSendJson(res, 500, { error: { message: errorText(err) } })
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
      antigravitySubscriptionSendJson(res, 200, { ok: true })
      return
    }
    const authorized = req.headers.authorization === `Bearer ${this.localToken}`
      || req.headers['x-api-key'] === this.localToken
    if (!authorized) {
      antigravitySubscriptionSendJson(res, 401, { error: { message: '本地订阅代理令牌无效。' } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      antigravitySubscriptionSendJson(res, 200, {
        object: 'list',
        data: ANTIGRAVITY_MODELS.map((model) => ({ id: model.id, object: 'model', owned_by: 'antigravity' }))
      })
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      antigravitySubscriptionSendJson(res, 404, { error: { message: 'Antigravity 代理只支持 /v1/chat/completions。' } })
      return
    }
    const rawBody = await antigravitySubscriptionReadBody(req)
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
      antigravitySubscriptionSendJson(res, upstream?.status ?? 502, {
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
      id: antigravitySubscriptionPROVIDER_ID,
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
            const timer = setTimeout(() => rejectCode(new Error('Antigravity 浏览器登录超时（5 分钟）。')), antigravitySubscriptionLOGIN_TIMEOUT_MS)
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
    const provider = getProvider(antigravitySubscriptionPROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > antigravitySubscriptionQUOTA_CACHE_MS) quota = null
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
    if (!getProvider(antigravitySubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Google Antigravity。')
      await this.ensureProvider()
    }
    setProviderEnabled(antigravitySubscriptionPROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(antigravitySubscriptionPROVIDER_ID, ANTIGRAVITY_MODELS[0]?.id)
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
    removeProvider(antigravitySubscriptionPROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    await this.closeProxy()
  }
}

let antigravitySubscriptionInstance: AntigravitySubscriptionService | null = null

export function getAntigravitySubscriptionService(): AntigravitySubscriptionService {
  if (!antigravitySubscriptionInstance) antigravitySubscriptionInstance = new AntigravitySubscriptionService()
  return antigravitySubscriptionInstance
}

const clineSubscriptionPROVIDER_ID = 'cline-subscription'

const clineSubscriptionQUOTA_CACHE_MS = 5 * 60_000

const clineSubscriptionREFRESH_MARGIN_MS = 5 * 60_000

const clineSubscriptionLOGIN_TIMEOUT_MS = 5 * 60_000

interface ClineCredential {
  kind: 'oauth' | 'key'
  /** OAuth 时是 Cline 会话 access token；key 时是 API Key。 */
  access: string
  refresh?: string
  expiresAt?: number
  account?: AgentSubscriptionAccount
}

async function clineSubscriptionPostForm(url: string, fields: Record<string, string>): Promise<Response> {
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
    if (!current.expiresAt || current.expiresAt - Date.now() > clineSubscriptionREFRESH_MARGIN_MS) return current
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
    this.localToken = getSettingsStore().getApiKey(clineSubscriptionPROVIDER_ID) ?? randomLocalToken()
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
      id: clineSubscriptionPROVIDER_ID,
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
    const response = await clineSubscriptionPostForm('https://api.workos.com/user_management/authorize/device', {
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
    const deadline = Date.now() + Math.min(expiresIn, clineSubscriptionLOGIN_TIMEOUT_MS)
    let workos: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await clineSubscriptionPostForm('https://api.workos.com/user_management/authenticate', {
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
    const provider = getProvider(clineSubscriptionPROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > clineSubscriptionQUOTA_CACHE_MS) quota = null
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
    if (!getProvider(clineSubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Cline Pass。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(clineSubscriptionPROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(clineSubscriptionPROVIDER_ID, CLINE_MODELS[0]?.id)
  }

  async remove(): Promise<AgentSubscriptionState> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
    this.credential = null
    this.localToken = null
    this.quota = null
    this.lastError = null
    this.store.clear()
    removeProvider(clineSubscriptionPROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let clineSubscriptionInstance: ClineSubscriptionService | null = null

export function getClineSubscriptionService(): ClineSubscriptionService {
  if (!clineSubscriptionInstance) clineSubscriptionInstance = new ClineSubscriptionService()
  return clineSubscriptionInstance
}

const commandCodeSubscriptionPROVIDER_ID = 'command-code-subscription'

const CLAUDE_PROVIDER_ID = 'command-code-claude-subscription'

const commandCodeSubscriptionQUOTA_CACHE_MS = 2 * 60_000

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
    this.localToken = getSettingsStore().getApiKey(commandCodeSubscriptionPROVIDER_ID) ?? randomLocalToken()
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
      id: commandCodeSubscriptionPROVIDER_ID,
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
    const provider = getProvider(commandCodeSubscriptionPROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > commandCodeSubscriptionQUOTA_CACHE_MS) quota = null
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
    if (!getProvider(commandCodeSubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Command Code。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(commandCodeSubscriptionPROVIDER_ID, enabled)
    if (getProvider(CLAUDE_PROVIDER_ID)) setProviderEnabled(CLAUDE_PROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const chat = this.credential?.chatModels ?? []
    if (chat.length > 0) return testSubscriptionProvider(commandCodeSubscriptionPROVIDER_ID, chat[0]?.id)
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
    removeProvider(commandCodeSubscriptionPROVIDER_ID)
    removeProvider(CLAUDE_PROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let commandCodeSubscriptionInstance: CommandCodeSubscriptionService | null = null

export function getCommandCodeSubscriptionService(): CommandCodeSubscriptionService {
  if (!commandCodeSubscriptionInstance) commandCodeSubscriptionInstance = new CommandCodeSubscriptionService()
  return commandCodeSubscriptionInstance
}

const glmSubscriptionPROVIDER_ID = 'glm-subscription'

const glmSubscriptionQUOTA_CACHE_MS = 2 * 60_000

const glmSubscriptionLOGIN_TIMEOUT_MS = 5 * 60_000

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

function glmSubscriptionRegionOf(value: string | undefined): GlmRegion {
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
    this.localToken = getSettingsStore().getApiKey(glmSubscriptionPROVIDER_ID) ?? randomLocalToken()
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
      id: glmSubscriptionPROVIDER_ID,
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
    const region = glmSubscriptionRegionOf(regionValue)
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
    const deadline = Math.min(Date.now() + glmSubscriptionLOGIN_TIMEOUT_MS, serverDeadline)
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
    const provider = getProvider(glmSubscriptionPROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > glmSubscriptionQUOTA_CACHE_MS) quota = null
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
    if (!getProvider(glmSubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 GLM Coding Plan。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(glmSubscriptionPROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const result = await testSubscriptionProvider(glmSubscriptionPROVIDER_ID, GLM_MODELS[0]?.id)
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
    removeProvider(glmSubscriptionPROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let glmSubscriptionInstance: GlmSubscriptionService | null = null

export function getGlmSubscriptionService(): GlmSubscriptionService {
  if (!glmSubscriptionInstance) glmSubscriptionInstance = new GlmSubscriptionService()
  return glmSubscriptionInstance
}

export function glmModels(): ModelInfo[] {
  return GLM_MODELS
}

const kimiSubscriptionPROVIDER_ID = 'kimi-subscription'

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'

const kimiSubscriptionUA = 'morrow-desktop/0.1.0 kimi_code_cli/1.0.0'

const AUTH_HOSTS = { cn: 'https://auth.kimi.com', global: 'https://auth.kimi.ai' } as const

const CODING_HOSTS = { cn: 'https://api.kimi.com/coding', global: 'https://api.kimi.ai/coding' } as const

const SCOPE = 'kimi-code'

const kimiSubscriptionREFRESH_MARGIN_MS = 5 * 60_000

const kimiSubscriptionQUOTA_CACHE_MS = 2 * 60_000

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

function kimiSubscriptionAsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function kimiSubscriptionText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function kimiSubscriptionNumber(value: unknown): number | undefined {
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

function kimiSubscriptionSleep(ms: number): Promise<void> {
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
      'user-agent': kimiSubscriptionUA,
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
    const accessToken = kimiSubscriptionText(payload.access_token)
    const refreshToken = kimiSubscriptionText(payload.refresh_token)
    const expiresIn = kimiSubscriptionNumber(payload.expires_in)
    if (!accessToken || !refreshToken || !expiresIn || expiresIn <= 0) {
      throw new Error('Kimi 登录响应缺少 access_token / refresh_token / expires_in。')
    }
    const claims = jwtClaims(accessToken) ?? jwtClaims(refreshToken) ?? {}
    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      expiresIn,
      scope: kimiSubscriptionText(payload.scope) ?? SCOPE,
      tokenType: kimiSubscriptionText(payload.token_type) ?? 'Bearer',
      region,
      deviceId: this.deviceId(),
      ...(kimiSubscriptionText(claims.user_id) ?? kimiSubscriptionText(claims.sub) ? { uid: kimiSubscriptionText(claims.user_id) ?? kimiSubscriptionText(claims.sub) } : {}),
      ...(kimiSubscriptionText(claims.email) ? { email: kimiSubscriptionText(claims.email) } : {}),
      ...(kimiSubscriptionText(claims.name) ?? kimiSubscriptionText(claims.nickname) ? { name: kimiSubscriptionText(claims.name) ?? kimiSubscriptionText(claims.nickname) } : {})
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
    const refreshAt = Math.max(kimiSubscriptionREFRESH_MARGIN_MS, this.credential.expiresIn * 500)
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
            await kimiSubscriptionSleep(800 * (attempt + 1))
            continue
          }
          response = candidate
          break
        } catch (err) {
          transient = err instanceof Error ? err.message : String(err)
          if (attempt < 2) await kimiSubscriptionSleep(800 * (attempt + 1))
        }
      }
      if (!response) throw new Error(`Kimi 刷新暂时失败：${transient || '网络错误'}，请稍后重试。`)
      const payload = kimiSubscriptionAsRecord(await response.json().catch(() => null))
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
    const existing = getSettingsStore().get().providers.find((item) => item.id === kimiSubscriptionPROVIDER_ID)
    this.localToken = existing ? getSettingsStore().getApiKey(kimiSubscriptionPROVIDER_ID) : null
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
    const existing = getSettingsStore().get().providers.find((item) => item.id === kimiSubscriptionPROVIDER_ID)
    const config: ProviderConfig = {
      id: kimiSubscriptionPROVIDER_ID,
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
    const payload = kimiSubscriptionAsRecord(await response.json().catch(() => null))
    if (!response.ok || !payload) throw new Error(`Kimi 设备授权失败（HTTP ${response.status}）。`)
    const deviceCode = kimiSubscriptionText(payload.device_code)
    const verification = kimiSubscriptionText(payload.verification_uri_complete) ?? kimiSubscriptionText(payload.verification_uri)
    if (!deviceCode || !verification) throw new Error('Kimi 设备授权响应缺少 device_code 或授权地址。')
    const opened = await openLoginUrl(verification)
    if (!opened.opened) throw new Error(`无法打开浏览器；授权链接已复制：${verification}`)
    let interval = Math.max(1, kimiSubscriptionNumber(payload.interval) ?? 5) * 1000
    const expiresIn = Math.max(30, kimiSubscriptionNumber(payload.expires_in) ?? 600) * 1000
    const deadline = Date.now() + Math.min(expiresIn, 10 * 60_000)
    let tokenPayload: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await kimiSubscriptionSleep(interval)
      const poll = await this.postForm(`${auth}/api/oauth/token`, {
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
      const body = kimiSubscriptionAsRecord(await poll.json().catch(() => null))
      if (poll.ok && kimiSubscriptionText(body?.access_token)) {
        tokenPayload = body
        break
      }
      const errorObject = kimiSubscriptionAsRecord(body?.error)
      const code = kimiSubscriptionText(body?.error) ?? kimiSubscriptionText(errorObject?.code)
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') {
        interval += 5_000
        continue
      }
      if (code === 'expired_token') throw new Error('Kimi 授权码已过期，请重新发起登录。')
      if (code === 'access_denied') throw new Error('你取消了 Kimi 授权。')
      if (poll.status >= 500) continue
      throw new Error(`Kimi 设备登录失败（HTTP ${poll.status}）${kimiSubscriptionText(errorObject?.message) ? `：${kimiSubscriptionText(errorObject?.message)}` : ''}`)
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
    const payload = kimiSubscriptionAsRecord(await response.json().catch(() => null))
    const info = kimiSubscriptionAsRecord(payload?.data) && kimiSubscriptionAsRecord(kimiSubscriptionAsRecord(payload?.data)?.userInfo)
      ? kimiSubscriptionAsRecord(kimiSubscriptionAsRecord(payload?.data)?.userInfo)!
      : kimiSubscriptionAsRecord(payload?.userInfo) ?? payload ?? {}
    const plan = kimiSubscriptionText(info.user_level_name) ?? kimiSubscriptionText(info.user_level)
    const email = kimiSubscriptionText(info.email)
    const name = kimiSubscriptionText(info.nickname) ?? kimiSubscriptionText(info.name)
    const uid = kimiSubscriptionText(info.user_id) ?? kimiSubscriptionText(info.global_id)
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
    const provider = getSettingsStore().get().providers.find((item) => item.id === kimiSubscriptionPROVIDER_ID)
    let quota = this.quotaCache
    if (quota && Date.now() - quota.fetchedAt > kimiSubscriptionQUOTA_CACHE_MS) quota = null
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
    let provider = getSettingsStore().get().providers.find((item) => item.id === kimiSubscriptionPROVIDER_ID)
    if (!provider && enabled && this.credential) {
      await this.ensureProxy()
      this.ensureProvider()
      provider = getSettingsStore().get().providers.find((item) => item.id === kimiSubscriptionPROVIDER_ID)
    }
    if (!provider) throw new Error('Kimi Provider 尚未创建。')
    getSettingsStore().saveProvider({ ...provider, enabled }, getSettingsStore().getApiKey(kimiSubscriptionPROVIDER_ID) ?? undefined)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = Date.now()
    try {
      const provider = getSettingsStore().get().providers.find((item) => item.id === kimiSubscriptionPROVIDER_ID)
      if (!provider) throw new Error('Kimi Provider 不存在。')
      const result = await testProviderConnection(provider, getSettingsStore().getApiKey(kimiSubscriptionPROVIDER_ID), KIMI_MODELS[0]?.id)
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
      getSettingsStore().removeProvider(kimiSubscriptionPROVIDER_ID)
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

let kimiSubscriptionInstance: KimiSubscriptionService | null = null

export function getKimiSubscriptionService(): KimiSubscriptionService {
  if (!kimiSubscriptionInstance) kimiSubscriptionInstance = new KimiSubscriptionService()
  return kimiSubscriptionInstance
}

const minimaxSubscriptionPROVIDER_ID = 'minimax-subscription'

const minimaxSubscriptionQUOTA_CACHE_MS = 2 * 60_000

const minimaxSubscriptionREFRESH_MARGIN_MS = 5 * 60_000

const minimaxSubscriptionLOGIN_TIMEOUT_MS = 10 * 60_000

const minimaxSubscriptionUA = 'morrow-desktop/0.1.0'

interface MinimaxCredential {
  accessToken: string
  refreshToken: string
  expiresAt: number
  region: MinimaxRegion
  account?: AgentSubscriptionAccount
  recordKey?: string
}

function minimaxSubscriptionRegionOf(value: string | undefined): MinimaxRegion {
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
    'user-agent': minimaxSubscriptionUA
  }
}

async function minimaxSubscriptionPostForm(url: string, fields: Record<string, string>): Promise<Response> {
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
    if (current.expiresAt - Date.now() > minimaxSubscriptionREFRESH_MARGIN_MS) return current
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
          const candidate = await minimaxSubscriptionPostForm(`${MINIMAX_REGIONS[current.region].account}/oauth2/token`, {
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
    this.localToken = getSettingsStore().getApiKey(minimaxSubscriptionPROVIDER_ID) ?? randomLocalToken()
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
          'user-agent': minimaxSubscriptionUA
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
      id: minimaxSubscriptionPROVIDER_ID,
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
    const region = minimaxSubscriptionRegionOf(regionValue)
    const config = MINIMAX_REGIONS[region]
    const pkce = pkcePair()
    const response = await minimaxSubscriptionPostForm(`${config.account}/oauth2/device/code`, {
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
    const deadline = Date.now() + Math.min(expiresIn, minimaxSubscriptionLOGIN_TIMEOUT_MS)
    let tokenPayload: Record<string, unknown> | null = null
    while (Date.now() < deadline) {
      await sleep(interval)
      const poll = await minimaxSubscriptionPostForm(`${config.account}/oauth2/token`, {
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
        headers: { authorization: `Bearer ${credential.accessToken}`, accept: 'application/json', 'user-agent': minimaxSubscriptionUA },
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
    const provider = getProvider(minimaxSubscriptionPROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > minimaxSubscriptionQUOTA_CACHE_MS) quota = null
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
    if (!getProvider(minimaxSubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 MiniMax Code。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(minimaxSubscriptionPROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(minimaxSubscriptionPROVIDER_ID, MINIMAX_MODELS[0]?.id)
  }

  async remove(): Promise<AgentSubscriptionState> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
    this.credential = null
    this.localToken = null
    this.quota = null
    this.lastError = null
    this.store.clear()
    removeProvider(minimaxSubscriptionPROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let minimaxSubscriptionInstance: MinimaxSubscriptionService | null = null

export function getMinimaxSubscriptionService(): MinimaxSubscriptionService {
  if (!minimaxSubscriptionInstance) minimaxSubscriptionInstance = new MinimaxSubscriptionService()
  return minimaxSubscriptionInstance
}

const opencodeSubscriptionPROVIDER_ID = 'opencode-subscription'

const opencodeSubscriptionQUOTA_CACHE_MS = 2 * 60_000

interface OpencodeCredential {
  apiKey: string
  provider: string
  accountName: string
  source: 'local' | 'token'
  sourcePath?: string
  models?: import('../shared/types').ModelInfo[]
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
    this.localToken = getSettingsStore().getApiKey(opencodeSubscriptionPROVIDER_ID) ?? randomLocalToken()
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
      id: opencodeSubscriptionPROVIDER_ID,
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
    const provider = getProvider(opencodeSubscriptionPROVIDER_ID)
    let quota = this.quota
    if (quota && Date.now() - quota.fetchedAt > opencodeSubscriptionQUOTA_CACHE_MS) quota = null
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
    if (!getProvider(opencodeSubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有导入 OpenCode 凭据。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(opencodeSubscriptionPROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(opencodeSubscriptionPROVIDER_ID, (this.credential?.models ?? OPENCODE_MODELS)[0]?.id)
  }

  async remove(): Promise<AgentSubscriptionState> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
    this.credential = null
    this.localToken = null
    this.quota = null
    this.lastError = null
    this.store.clear()
    removeProvider(opencodeSubscriptionPROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let opencodeSubscriptionInstance: OpencodeSubscriptionService | null = null

export function getOpencodeSubscriptionService(): OpencodeSubscriptionService {
  if (!opencodeSubscriptionInstance) opencodeSubscriptionInstance = new OpencodeSubscriptionService()
  return opencodeSubscriptionInstance
}

const qoderSubscriptionPROVIDER_ID = 'qoder-subscription'

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

function qoderSubscriptionAsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function qoderSubscriptionText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function qoderSubscriptionNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function expiresAtFrom(payload: Record<string, unknown>): number {
  const absolute = qoderSubscriptionNumber(payload.expires_at)
  if (absolute !== undefined && absolute > 0) return absolute < 10_000_000_000 ? absolute * 1000 : absolute
  const seconds = qoderSubscriptionNumber(payload.expires_in)
  return Date.now() + (seconds && seconds > 0 ? seconds : 24 * 3600) * 1000
}

function toModelInfo(model: QoderModel): ModelInfo {
  return {
    id: model.id,
    label: model.label,
    contextWindow: model.contextWindow,
    maxOutput: 32_768,
    supportsTools: true,
    supportsReasoning: model.reasoning,
    ...(model.reasoning ? { reasoningStyle: 'effort' as const } : {}),
    ...(model.reasoningEfforts?.length ? { reasoningEfforts: model.reasoningEfforts } : {}),
    ...(model.contextOptions?.length ? { contextOptions: model.contextOptions } : {}),
    ...(model.defaultContextWindow ? { defaultContextWindow: model.defaultContextWindow } : {}),
    note: 'Qoder 订阅'
  }
}

function qoderSubscriptionParseQuota(payload: unknown): QoderSubscriptionQuota {
  const root = qoderSubscriptionAsRecord(payload) ?? {}
  const buckets: QoderSubscriptionQuota['buckets'] = []
  const add = (value: unknown, kind: QoderSubscriptionQuota['buckets'][number]['kind']): void => {
    const record = qoderSubscriptionAsRecord(value)
    if (!record) return
    const total = qoderSubscriptionNumber(kind === 'org' ? (record.cap ?? record.total) : record.total)
    const used = qoderSubscriptionNumber(record.used)
    const remaining = qoderSubscriptionNumber(record.remaining)
    if (total === undefined && used === undefined && remaining === undefined) return
    buckets.push({
      kind,
      ...(total !== undefined ? { total } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(qoderSubscriptionText(record.unit) ? { unit: qoderSubscriptionText(record.unit) } : {})
    })
  }
  add(root.userQuota, 'personal')
  add(root.addOnQuota, 'add-on')
  add(root.orgResourcePackage, 'org')
  const expires = qoderSubscriptionNumber(root.expiresAt)
  return {
    buckets,
    ...(expires !== undefined && expires <= 8.64e15 ? { expiresAt: expires } : {}),
    fetchedAt: Date.now(),
    ...(buckets.length === 0 ? { message: '额度接口没有返回可识别的额度桶。' } : {})
  }
}

function qoderSubscriptionSleep(ms: number): Promise<void> {
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
  private catalog: QoderModel[] | null = null

  constructor() {
    this.file = this.loadFile()
    this.credential = this.loadCredential()
    this.catalog = this.loadCatalogCache()
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

  private catalogPath(): string {
    return dataPath('qoder-model-catalog.json')
  }

  private loadCatalogCache(): QoderModel[] | null {
    try {
      const parsed = JSON.parse(readFileSync(this.catalogPath(), 'utf8')) as { models?: unknown }
      if (!Array.isArray(parsed?.models)) return null
      const models = parsed.models.filter((item): item is QoderModel => {
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : null
        return Boolean(record && typeof record.id === 'string' && typeof record.label === 'string' &&
          typeof record.contextWindow === 'number')
      })
      return models.length > 0 ? models : null
    } catch {
      return null
    }
  }

  private saveCatalogCache(models: QoderModel[]): void {
    try {
      mkdirSync(dataPath(), { recursive: true })
      writeFileSync(this.catalogPath(), `${JSON.stringify({ version: 1, updatedAt: Date.now(), models }, null, 2)}\n`, 'utf8')
    } catch (err) {
      log.warn('qoder model catalog cache save failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 账号模型目录是模型/上下文/思考档位的唯一来源；失败时沿用上次缓存。 */
  private async refreshCatalog(): Promise<void> {
    if (!this.credential) return
    try {
      const models = await fetchQoderModelCatalog(this.credential, (url, init) => this.fetchImpl(url, init))
      this.catalog = models
      this.saveCatalogCache(models)
      log.info('qoder account model catalog loaded', { models: models.length })
    } catch (err) {
      log.warn('qoder account model catalog unavailable', { error: err instanceof Error ? err.message : String(err) })
      if (!this.catalog) this.catalog = this.loadCatalogCache()
    }
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
    const payload = qoderSubscriptionAsRecord(await response.json().catch(() => null))
    const token = qoderSubscriptionText(payload?.token)
    if (!payload || !token) throw new Error('Qoder PAT 兑换响应里没有 token。')
    return {
      token,
      ...(qoderSubscriptionText(payload.refresh_token) ? { refreshToken: qoderSubscriptionText(payload.refresh_token) } : {}),
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
    const payload = qoderSubscriptionAsRecord(JSON.parse(raw) as unknown) ?? {}
    const tags = Array.isArray(payload.organization_tags)
      ? payload.organization_tags.filter((item): item is string => typeof item === 'string' && Boolean(item))
      : undefined
    return {
      uid: qoderSubscriptionText(payload.id) ?? qoderSubscriptionText(payload.uid) ?? '',
      ...(qoderSubscriptionText(payload.email) ? { email: qoderSubscriptionText(payload.email) } : {}),
      ...(qoderSubscriptionText(payload.name) ?? qoderSubscriptionText(payload.username) ? { name: qoderSubscriptionText(payload.name) ?? qoderSubscriptionText(payload.username) } : {}),
      ...(qoderSubscriptionText(payload.organization_id) ? { organizationId: qoderSubscriptionText(payload.organization_id) } : {}),
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
      const payload = qoderSubscriptionAsRecord(await response.json().catch(() => null))
      const token = qoderSubscriptionText(payload?.token)
      if (!payload || !token) throw new Error('Qoder 刷新响应里没有 token。')
      return this.persist({
        ...current,
        accessToken: token,
        refreshToken: qoderSubscriptionText(payload.refresh_token) ?? current.refreshToken,
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

  private models(_region: QoderRegion): QoderModel[] {
    return this.catalog ?? []
  }

  private async ensureProxy(): Promise<number> {
    if (this.proxy) return this.proxy.port
    if (!this.credential) throw new Error('还没有登录 Qoder。')
    const existing = getSettingsStore().get().providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
    this.localToken = existing ? getSettingsStore().getApiKey(qoderSubscriptionPROVIDER_ID) : null
    if (!this.localToken) this.localToken = randomBytes(32).toString('base64url')
    const models = this.models(this.credential.region)
    if (models.length === 0) {
      throw new Error('Qoder 账号模型目录尚未读取成功，请重新登录或稍后重试。')
    }
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
    const existing = getSettingsStore().get().providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
    const config: ProviderConfig = {
      id: qoderSubscriptionPROVIDER_ID,
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
      await this.refreshCatalog()
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
    await this.refreshCatalog()
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
      await qoderSubscriptionSleep(2_000)
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
      ready = qoderSubscriptionAsRecord(await response.json().catch(() => null))
      if (!ready || !qoderSubscriptionText(ready.token)) throw new Error('Qoder 设备登录响应里没有 token。')
      break
    }
    if (!ready) throw new Error('Qoder 浏览器登录超时（5 分钟）。请重新发起登录。')
    const token = qoderSubscriptionText(ready.token)!
    let info: Awaited<ReturnType<QoderSubscriptionService['userInfo']>> | null = null
    try {
      info = await this.userInfo(token, 'global')
    } catch {
      // 设备流本身已经给了 user_id；资料补齐失败不影响登录
    }
    const credential: QoderCredential = {
      accessToken: token,
      ...(qoderSubscriptionText(ready.refresh_token) ? { refreshToken: qoderSubscriptionText(ready.refresh_token) } : {}),
      expiresAt: expiresAtFrom(ready),
      region: 'global',
      uid: qoderSubscriptionText(ready.user_id) ?? info?.uid ?? 'qoder-user',
      rawUserInfo: info?.raw ?? '',
      dataPolicyAgreed: info?.dataPolicyAgreed === true,
      ...(info?.email ? { email: info.email } : {}),
      ...(info?.name ? { name: info.name } : {}),
      ...(info?.organizationId ? { organizationId: info.organizationId } : {}),
      ...(info?.organizationTags?.length ? { organizationTags: info.organizationTags } : {}),
      machineId
    }
    this.persist(credential, 'device')
    await this.refreshCatalog()
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
      parsed = qoderSubscriptionAsRecord(JSON.parse(plaintext) as unknown) ?? {}
    } catch (err) {
      throw new Error(`qodercli 登录态读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
    const accessToken = qoderSubscriptionText(parsed.access_token) ?? qoderSubscriptionText(parsed.security_oauth_token)
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
      ...(qoderSubscriptionText(parsed.refresh_token) ? { refreshToken: qoderSubscriptionText(parsed.refresh_token) } : {}),
      expiresAt: expiresAtFrom({ expires_at: parsed.expire_time ?? parsed.expires_at, expires_in: parsed.expires_in }),
      region,
      uid: info.uid || qoderSubscriptionText(parsed.uid) || 'qoder-user',
      rawUserInfo: info.raw,
      dataPolicyAgreed: info.dataPolicyAgreed || parsed.data_policy_agreed === true,
      ...(info.email ?? qoderSubscriptionText(parsed.email) ? { email: info.email ?? qoderSubscriptionText(parsed.email) } : {}),
      ...(info.name ?? qoderSubscriptionText(parsed.name) ? { name: info.name ?? qoderSubscriptionText(parsed.name) } : {}),
      ...(info.organizationId ?? qoderSubscriptionText(parsed.organization_id)
        ? { organizationId: info.organizationId ?? qoderSubscriptionText(parsed.organization_id) }
        : {}),
      ...(tags?.length ? { organizationTags: tags } : {}),
      machineId
    }
    this.persist(credential, 'local', paths.auth)
    await this.refreshCatalog()
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
    this.quotaCache = qoderSubscriptionParseQuota(await response.json().catch(() => null))
    return this.quotaCache
  }

  async status(): Promise<QoderSubscriptionState> {
    const settings = getSettingsStore().get()
    const provider = settings.providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
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

  /** 模型管理里的默认上下文只允许账号目录声明的档位（Qoder 为 200K/400K/1M）。 */
  async setModelContextWindow(modelId: string, contextWindow: number): Promise<QoderSubscriptionState> {
    const provider = getSettingsStore().get().providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
    const model = provider?.models.find((item) => item.id === modelId)
    if (!provider || !model) throw new Error('Qoder 模型不存在，请重新登录读取账号模型目录。')
    if (!model.contextOptions?.includes(contextWindow)) {
      throw new Error('这个上下文档位不在 Qoder 账号模型目录中。')
    }
    getSettingsStore().saveProvider({
      ...provider,
      models: provider.models.map((item) =>
        item.id === modelId ? { ...item, defaultContextWindow: contextWindow } : item
      )
    }, getSettingsStore().getApiKey(qoderSubscriptionPROVIDER_ID) ?? undefined)
    if (this.catalog) {
      this.catalog = this.catalog.map((item) =>
        item.id === modelId ? { ...item, defaultContextWindow: contextWindow } : item
      )
      this.saveCatalogCache(this.catalog)
    }
    return this.status()
  }

  async setEnabled(enabled: boolean): Promise<QoderSubscriptionState> {
    let provider = getSettingsStore().get().providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
    if (!provider && enabled && this.credential) {
      await this.ensureProxy()
      this.ensureProvider()
      provider = getSettingsStore().get().providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
    }
    if (!provider) throw new Error('Qoder Provider 尚未创建。')
    getSettingsStore().saveProvider({ ...provider, enabled }, getSettingsStore().getApiKey(qoderSubscriptionPROVIDER_ID) ?? undefined)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = Date.now()
    try {
      const provider = getSettingsStore().get().providers.find((item) => item.id === qoderSubscriptionPROVIDER_ID)
      if (!provider) throw new Error('Qoder Provider 不存在。')
      const result = await testProviderConnection(provider, getSettingsStore().getApiKey(qoderSubscriptionPROVIDER_ID), provider.models[0]?.id)
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
    this.catalog = null
    this.file = { version: 1 }
    this.saveFile()
    try {
      getSettingsStore().removeProvider(qoderSubscriptionPROVIDER_ID)
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

let qoderSubscriptionInstance: QoderSubscriptionService | null = null

export function getQoderSubscriptionService(): QoderSubscriptionService {
  if (!qoderSubscriptionInstance) qoderSubscriptionInstance = new QoderSubscriptionService()
  return qoderSubscriptionInstance
}

const stepSubscriptionPROVIDER_ID = 'step-subscription'

const stepSubscriptionLOGIN_TIMEOUT_MS = 10 * 60_000

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
    this.localToken = getSettingsStore().getApiKey(stepSubscriptionPROVIDER_ID) ?? randomLocalToken()
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
      id: stepSubscriptionPROVIDER_ID,
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
    const deadline = Math.min(expiresAt || Date.now() + stepSubscriptionLOGIN_TIMEOUT_MS, Date.now() + stepSubscriptionLOGIN_TIMEOUT_MS)
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
    const provider = getProvider(stepSubscriptionPROVIDER_ID)
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
    if (!getProvider(stepSubscriptionPROVIDER_ID)) {
      if (!this.credential) throw new Error('还没有登录 Step Plan。')
      await this.ensureProxy()
      this.ensureProvider()
    }
    setProviderEnabled(stepSubscriptionPROVIDER_ID, enabled)
    return this.status()
  }

  async test(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    return testSubscriptionProvider(stepSubscriptionPROVIDER_ID, this.credential?.models[0]?.id)
  }

  async remove(): Promise<AgentSubscriptionState> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
    this.credential = null
    this.localToken = null
    this.quota = null
    this.lastError = null
    this.store.clear()
    removeProvider(stepSubscriptionPROVIDER_ID)
    return this.status()
  }

  async dispose(): Promise<void> {
    if (this.proxy) await this.proxy.close().catch(() => undefined)
    this.proxy = null
  }
}

let stepSubscriptionInstance: StepSubscriptionService | null = null

export function getStepSubscriptionService(): StepSubscriptionService {
  if (!stepSubscriptionInstance) stepSubscriptionInstance = new StepSubscriptionService()
  return stepSubscriptionInstance
}

export interface AgentSubscriptionService {
  restore(): Promise<void>
  dispose(): Promise<void>
  status(): Promise<AgentSubscriptionState>
  login(region?: string): Promise<AgentSubscriptionState>
  loginToken?(token: string, region?: string): Promise<AgentSubscriptionState>
  importLocal?(): Promise<AgentSubscriptionState>
  refreshQuota(): Promise<unknown>
  test(): Promise<SubscriptionTestResult>
  remove(): Promise<AgentSubscriptionState>
  setEnabled(enabled: boolean): Promise<AgentSubscriptionState>
}

export const AGENT_ORDER: AgentSubscriptionId[] = [
  'kimi',
  'glm',
  'minimax',
  'step',
  'command-code',
  'cline',
  'antigravity',
  'opencode'
]

function kimiAdapter(): AgentSubscriptionService {
  const service = getKimiSubscriptionService()
  return {
    restore: () => service.restore(),
    dispose: () => service.dispose(),
    status: () => service.status(),
    login: (region) => service.loginDevice(region === 'global' ? 'global' : 'cn'),
    refreshQuota: () => service.refreshQuota(),
    test: () => service.test(),
    remove: () => service.remove(),
    setEnabled: (enabled) => service.setEnabled(enabled)
  }
}

export function getAgentService(id: AgentSubscriptionId): AgentSubscriptionService {
  switch (id) {
    case 'kimi':
      return kimiAdapter()
    case 'glm': {
      const service = getGlmSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: (region) => service.login(region),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'minimax': {
      const service = getMinimaxSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: (region) => service.login(region),
        importLocal: () => service.importLocal(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'step': {
      const service = getStepSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: (region) => service.login(region),
        loginToken: (token, region) => service.loginToken(token, region),
        importLocal: () => service.importLocal(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'command-code': {
      const service = getCommandCodeSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: () => service.login(),
        loginToken: (token) => service.loginToken(token),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'cline': {
      const service = getClineSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: () => service.login(),
        loginToken: (token) => service.loginToken(token),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'antigravity': {
      const service = getAntigravitySubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: () => service.login(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'opencode': {
      const service = getOpencodeSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: async () => service.importLocal(),
        loginToken: (token) => service.loginToken(token),
        importLocal: () => service.importLocal(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    default:
      throw new Error('未知的订阅渠道。')
  }
}

export function allAgentServices(): AgentSubscriptionService[] {
  return AGENT_ORDER.map((id) => getAgentService(id))
}

const CODEX_PROVIDER_ID = 'codex-subscription'

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'

const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'

const OAUTH_SCOPE = 'openid profile email offline_access'

const subscriptionsQUOTA_CACHE_MS = 60_000

const CODEX_MODELS_BASE: ModelInfo[] = [
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

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** ChatGPT 订阅暴露的档位；GPT-6/5.6 官方支持到 max。 */
export const CODEX_MODELS: ModelInfo[] = CODEX_MODELS_BASE.map((model) => ({
  ...model,
  reasoningEfforts: [...CODEX_EFFORTS]
}))

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

let subscriptionsInstance: SubscriptionService | null = null

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

function subscriptionsParseQuota(payload: unknown, fallbackEmail?: string): CodexSubscriptionQuota {
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
      return subscriptionsParseQuota(await response.json(), this.credential?.email)
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
    if (quota && Date.now() - quota.fetchedAt > subscriptionsQUOTA_CACHE_MS) quota = null
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
  if (!subscriptionsInstance) subscriptionsInstance = new SubscriptionService()
  return subscriptionsInstance
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
    case 'set-qoder-context':
      await getQoderSubscriptionService().setModelContextWindow(action.modelId, action.contextWindow)
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
