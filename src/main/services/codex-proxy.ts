// Codex 订阅 → OpenAI Chat Completions 本地兼容层。
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { RequestListener } from 'node:http'
import type { ModelInfo } from '../../shared/types'
import { log } from './logger'

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

const MAX_BODY = 64 * 1024 * 1024
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
    if (total > MAX_BODY) throw new Error('请求体超过 64MB 上限。')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(res: import('node:http').ServerResponse, status: number, value: unknown): void {
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

async function handleChat(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  options: CodexProxyOptions
): Promise<void> {
  const body = (await readJson(req)) as ChatBody
  if (!body.model || !Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { message: '缺少 model 或 messages。', type: 'invalid_request_error' } })
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
    sendJson(res, 502, { error: { message: `连接 ChatGPT 订阅失败：${err instanceof Error ? err.message : String(err)}`, type: 'upstream_error' } })
    return
  }
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 800)
    sendJson(res, upstream.status, { error: { message: `ChatGPT 订阅返回 ${upstream.status}${detail ? `：${detail}` : ''}`, type: 'upstream_error' } })
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
    sendJson(res, 200, {
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
        sendJson(res, 200, { ok: true })
        return
      }
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${options.localToken}`) {
        sendJson(res, 401, { error: { message: '本地订阅代理令牌无效。', type: 'invalid_request_error' } })
        return
      }
      if (url.pathname === '/v1/models') {
        sendJson(res, 200, {
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
        await handleChat(req, res, options)
        return
      }
      sendJson(res, 404, { error: { message: '未找到该路径。', type: 'not_found' } })
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err), type: 'internal_error' } })
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
