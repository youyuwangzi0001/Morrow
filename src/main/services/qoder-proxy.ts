/**
 * Qoder 订阅 → 本地 OpenAI 兼容代理。
 *
 * Qoder 的对话不是 OpenAI/Anthropic：请求包在 RemoteChatAsk 信封里，body 自定义
 * alphabet 编码，COSY 头签名，应答是信封 SSE。这里按参考仓库的公开算法逐字实现
 * COSY/编码，并把信封内层 OpenAI chunk 转回 Morrow 的 Chat Completions。
 */
import { createHash, createCipheriv, createDecipheriv, publicEncrypt, constants, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { ModelInfo } from '../../shared/types'

export type QoderRegion = 'global' | 'cn'

export interface QoderModel {
  id: string
  upstreamKey: string
  label: string
  contextWindow: number
  supportsImages: boolean
  reasoning: boolean
}

export const QODER_MODELS_GLOBAL: QoderModel[] = [
  { id: 'Auto', upstreamKey: 'auto', label: 'Auto', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Ultimate', upstreamKey: 'ultimate', label: 'Ultimate', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Performance', upstreamKey: 'performance', label: 'Performance', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Efficient', upstreamKey: 'efficient', label: 'Efficient', contextWindow: 200_000, supportsImages: true, reasoning: false },
  { id: 'Lite', upstreamKey: 'lite', label: 'Lite', contextWindow: 128_000, supportsImages: false, reasoning: false },
  { id: 'Qwen3.7Plus', upstreamKey: 'qmodel', label: 'Qwen3.7 Plus', contextWindow: 200_000, supportsImages: true, reasoning: false },
  { id: 'Cantus', upstreamKey: 'cmodel', label: 'Cantus', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Qwen3.8-Max', upstreamKey: 'qmodel_preview', label: 'Qwen3.8-Max', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Qwen3.7-Max', upstreamKey: 'qmodel_latest', label: 'Qwen3.7-Max', contextWindow: 200_000, supportsImages: true, reasoning: false },
  { id: 'DeepSeek-V4-Pro', upstreamKey: 'dmodel', label: 'DeepSeek-V4-Pro', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'DeepSeek-V4-Flash', upstreamKey: 'dfmodel', label: 'DeepSeek-V4-Flash', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'GLM-5.2', upstreamKey: 'gm51model', label: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true, reasoning: true },
  { id: 'Kimi-K2.7-Code', upstreamKey: 'kmodel', label: 'Kimi-K2.7-Code', contextWindow: 256_000, supportsImages: true, reasoning: false },
  { id: 'Kimi-K3', upstreamKey: 'kmodel_latest', label: 'Kimi-K3', contextWindow: 256_000, supportsImages: true, reasoning: false },
  { id: 'MiniMax-M3', upstreamKey: 'mmodel', label: 'MiniMax-M3', contextWindow: 200_000, supportsImages: true, reasoning: false }
]

export const QODER_MODELS_CN: QoderModel[] = [
  { id: 'Auto', upstreamKey: 'auto', label: 'Auto', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Qwen3.7-Max', upstreamKey: 'qmodel_latest', label: 'Qwen3.7-Max', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Qwen3.7-Plus', upstreamKey: 'qmodel', label: 'Qwen3.7-Plus', contextWindow: 200_000, supportsImages: false, reasoning: true },
  { id: 'Qwen3.6-Flash', upstreamKey: 'q36fmodel', label: 'Qwen3.6-Flash', contextWindow: 200_000, supportsImages: false, reasoning: true },
  { id: 'DeepSeek-V4-Pro', upstreamKey: 'dmodel', label: 'DeepSeek-V4-Pro', contextWindow: 200_000, supportsImages: false, reasoning: true },
  { id: 'DeepSeek-V4-Flash', upstreamKey: 'dfmodel', label: 'DeepSeek-V4-Flash', contextWindow: 200_000, supportsImages: false, reasoning: false },
  { id: 'GLM-5.2', upstreamKey: 'gm51model', label: 'GLM-5.2', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Kimi-K2.7-Code', upstreamKey: 'kmodel', label: 'Kimi-K2.7-Code', contextWindow: 256_000, supportsImages: true, reasoning: true },
  { id: 'MiniMax-M2.7', upstreamKey: 'mmodel', label: 'MiniMax-M2.7', contextWindow: 200_000, supportsImages: false, reasoning: false }
]

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
const MAX_BODY = 64 * 1024 * 1024

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

function buildQoderRequest(body: OpenAIRequestBody, credential: QoderCredential, models: QoderModel[], sessionId: string): { payload: Record<string, unknown>; upstreamKey: string } {
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
  const maxTokens = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 32_768
  const parameters: Record<string, unknown> = { max_tokens: maxTokens }
  if (typeof body.temperature === 'number') parameters.temperature = body.temperature
  if (body.reasoning_effort && body.reasoning_effort !== 'auto') {
    parameters.enable_thinking = true
    parameters.reasoning_effort = body.reasoning_effort
  }
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
    model_config: { key: model.upstreamKey, format: 'openai', source: 'system', enable: true, display_name: model.label, is_vl: model.supportsImages, is_reasoning: model.reasoning, max_input_tokens: model.contextWindow },
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

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY) throw new Error('请求体超过 64MB。')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
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

async function handleChat(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, options: QoderProxyOptions): Promise<void> {
  const body = await readBody(req) as OpenAIRequestBody
  if (!body.model || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { message: '缺少 model 或 messages。' } })
    return
  }
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  const sessionId = typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : randomUUID()
  let credential = await options.getCredential()
  let { payload, upstreamKey } = buildQoderRequest(body, credential, options.models, sessionId)
  let response = await upstream(options, payload, credential, upstreamKey, controller.signal)
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined)
    credential = await options.refreshCredential()
    response = await upstream(options, payload, credential, upstreamKey, controller.signal)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 800)
    sendJson(res, response.status, { error: { message: `Qoder 返回 ${response.status}${detail ? `：${detail}` : ''}` } })
    return
  }
  const modelId = body.model
  const stream = body.stream !== false
  const contentType = response.headers.get('content-type') ?? ''
  if (!stream && !contentType.includes('text/event-stream')) {
    const payloadJson = await response.json().catch(() => null)
    sendJson(res, 200, payloadJson ?? { error: { message: 'Qoder 返回了无法解析的响应。' } })
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
      if (url.pathname === '/health') return sendJson(res, 200, { ok: true })
      if ((req.headers.authorization ?? '') !== `Bearer ${options.localToken}`) return sendJson(res, 401, { error: { message: '本地订阅代理令牌无效。' } })
      if (url.pathname === '/v1/models') {
        return sendJson(res, 200, { object: 'list', data: options.models.map((model) => ({ id: model.id, object: 'model', owned_by: 'qoder-subscription', context_window: model.contextWindow })) })
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChat(req, res, options)
      return sendJson(res, 404, { error: { message: '未找到该路径。' } })
    } catch (err) {
      sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } })
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
