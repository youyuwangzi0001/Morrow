// Morrow 本地 Mock LLM 服务器 —— 同时实现 OpenAI 与 Anthropic 两套流式协议。
//
// 用途：
//   - tests/unit/core（engine 的 Provider / Agent 循环单测）
//   - tests/e2e（Playwright 启动 Electron 时通过 MORROW_MOCK_LLM 指向这里）
//   - scripts/probe 之类的离线联调
//
// 设计目标：不依赖任何第三方包，纯 node:http；端口动态；剧本可控；能注入错误与停摆。
//
// ── 快速上手 ───────────────────────────────────────────────────────────
//   import { startMockLLM } from './mock-llm.mjs'
//   const mock = await startMockLLM({
//     scripts: [
//       { text: '我先读一下文件。', toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
//       { text: '读完了，共 3 行。' }
//     ]
//   })
//   mock.openaiBaseUrl     // http://127.0.0.1:<port>/v1
//   mock.anthropicBaseUrl  // http://127.0.0.1:<port>/v1
//   mock.requests          // 收到的请求（含 body / headers），用于断言
//   await mock.close()
//
//        POST /v1/chat/completions   OpenAI 兼容（SSE；stream:false 时返回 JSON）
//        POST /v1/messages           Anthropic Messages（SSE；stream:false 时返回 JSON）
//        GET  /v1/models             OpenAI 风格模型列表（供 testProviderConnection 用）
//        GET  /health                { ok, calls } 供 E2E 探活
//
// ── 剧本（script）字段 ────────────────────────────────────────────────
//   text?: string                流式输出的文本
//   chunks?: string[]            直接指定文本分片（优先于 text 的自动切分）
//   textChunkSize?: number       自动切分文本的分片长度，默认 3
//   reasoning?: string           OpenAI 的 reasoning_content 增量（DeepSeek 风格）
//   toolCalls?: Array<{         工具调用（可多个；文本在前、调用在后）
//     name: string
//     arguments?: object | string     对象会被 JSON.stringify 后分片；字符串原样分片
//     argumentsChunks?: string[]      直接指定 JSON 参数字符串的分片
//     argsChunkSize?: number          自动分片长度，默认 8
//     id?: string
//   }>
//   usage?: { inputTokens?: number, outputTokens?: number }
//   stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'   （Anthropic；OpenAI 只有 stop/tool_calls）
//   delayMs?: number             首字节前延迟（模拟思考/网络）
//   chunkDelayMs?: number        每个分片之间延迟，默认 0
//   error?: { status: number, message?: string, type?: string, retryAfterMs?: number }
//   hang?: true | number         保持连接不返回；hangMs 后强制断开
//   rawSse?: string              原样写入的 SSE 文本（用于异常数据健壮性测试）
//
// ── 剧本选择 ──────────────────────────────────────────────────────────
//   1) options.respond(ctx) 优先：ctx = { index, protocol, method, url, headers, body,
//      messages, lastUserMessage, lastMessage }；返回 undefined 则回退到 scripts。
//   2) options.scripts 按请求序号消费（第 1 个请求用 scripts[0]，依此类推）。
//   3) 都取不到时用 options.defaultScript，再退回一句默认中文回复。
//
// 注意：AI 提供商在收到工具结果后会发起下一轮请求；剧本数组按序消费即可模拟多轮。

import { createServer } from 'node:http'

const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*'
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 按长度切分字符串；size<=0 或非有限数时返回整段。 */
function splitBySize(text, size) {
  if (!Number.isFinite(size) || size <= 0) return text ? [text] : []
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function estimateInputTokens(body) {
  // 粗略估算：只用于让 usage 看起来合理，不做真实 tokenizer。
  let chars = 0
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (const m of messages) {
    if (typeof m?.content === 'string') chars += m.content.length
    else if (Array.isArray(m?.content)) {
      for (const block of m.content) {
        if (typeof block?.text === 'string') chars += block.text.length
        else if (typeof block?.content === 'string') chars += block.content.length
        else if (block?.input) chars += JSON.stringify(block.input).length
      }
    }
  }
  if (typeof body?.system === 'string') chars += body.system.length
  return Math.max(1, Math.round(chars / 3))
}

function normalizeScript(raw, fallback) {
  if (raw == null) return fallback
  if (typeof raw === 'string') return { text: raw }
  return raw
}

/** 把剧本里的 toolCalls 变成带分片的中间结构。 */
function buildToolCalls(script, protocol) {
  const rawCalls = Array.isArray(script.toolCalls) ? script.toolCalls : []
  return rawCalls.map((call, index) => {
    const id = call.id || (protocol === 'anthropic' ? `toolu_mock_${index + 1}` : `call_mock_${index + 1}`)
    let fragments
    if (Array.isArray(call.argumentsChunks)) {
      fragments = call.argumentsChunks
    } else if (typeof call.arguments === 'string') {
      fragments = splitBySize(call.arguments, call.argsChunkSize ?? script.argsChunkSize ?? 8)
    } else {
      fragments = splitBySize(JSON.stringify(call.arguments ?? {}), call.argsChunkSize ?? script.argsChunkSize ?? 8)
    }
    if (fragments.length === 0) fragments = ['{}']
    // input 先尽量解析成对象；解析失败时保留原始字符串（用于测容错）
    let input
    try {
      input = JSON.parse(fragments.join(''))
    } catch {
      input = fragments.join('')
    }
    return { index, id, name: call.name, fragments, input, json: fragments.join('') }
  })
}

function defaultErrorBody(protocol, status, message) {
  const type =
    status === 429
      ? protocol === 'anthropic'
        ? 'rate_limit_error'
        : 'rate_limit_exceeded'
      : status >= 500
        ? protocol === 'anthropic'
          ? 'api_error'
          : 'server_error'
        : 'invalid_request_error'
  if (protocol === 'anthropic') return { type: 'error', error: { type, message } }
  return { error: { type, message, code: type } }
}

function computeUsage(script, body) {
  const usage = script.usage || {}
  return {
    inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : estimateInputTokens(body),
    outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : 24
  }
}

/**
 * 启动 Mock LLM 服务器。
 * @param {object} [options]
 * @param {number} [options.port] 默认 0（系统分配）
 * @param {string} [options.host] 默认 127.0.0.1
 * @param {Array<object|string>} [options.scripts] 按请求序号消费的剧本
 * @param {object|string} [options.defaultScript] 剧本用尽后的默认回复
 * @param {(ctx: object) => (object|string|undefined|Promise<object|string|undefined>)} [options.respond]
 * @param {number} [options.chunkDelayMs] 全局分片延迟（默认 0）
 * @param {string[]} [options.models] GET /v1/models 返回的模型 id
 * @param {'auto'|'openai'|'anthropic'} [options.defaultProtocol] 未知路径按哪种协议回（默认 openai）
 * @param {(ctx: object) => void} [options.onRequest] 收到请求时的回调（便于测试观察）
 * @returns {Promise<object>} mock 服务器句柄
 */
export async function startMockLLM(options = {}) {
  const host = options.host || '127.0.0.1'
  const models = options.models || ['mock-model', 'mock-tool-model']
  const globalChunkDelay = options.chunkDelayMs ?? 0
  const sockets = new Set()
  const timers = new Set()
  const requests = []
  let scripts = [...(options.scripts || [])]
  let respond = options.respond
  let defaultScript = options.defaultScript

  const state = {
    /** 收到的请求记录，测试里可直接断言 */
    requests,
    reset(next) {
      requests.length = 0
      if (Array.isArray(next)) scripts = [...next]
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        if (Array.isArray(next.scripts)) scripts = [...next.scripts]
        if (typeof next.respond === 'function' || next.respond === undefined) respond = next.respond
        if ('defaultScript' in next) defaultScript = next.defaultScript
      }
    },
    pushScript(script) {
      scripts.push(script)
    },
    setScripts(next) {
      scripts = Array.isArray(next) ? [...next] : []
    },
    setRespond(fn) {
      respond = fn
    }
  }

  async function pickScript(ctx) {
    if (typeof respond === 'function') {
      const picked = await respond(ctx)
      if (picked !== undefined && picked !== null) return normalizeScript(picked, {})
    }
    if (ctx.index < scripts.length) return normalizeScript(scripts[ctx.index], {})
    if (defaultScript !== undefined) return normalizeScript(defaultScript, {})
    return { text: '（mock 默认回复）已收到你的消息。' }
  }

  function writeSse(res, payload, event) {
    if (res.writableEnded || res.destroyed) return false
    const prefix = event ? `event: ${event}\n` : ''
    res.write(`${prefix}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
    return true
  }

  async function streamOpenAI(ctx, script) {
    const { res, body, seq } = ctx
    const id = `chatcmpl-mock-${seq}`
    const created = Math.floor(Date.now() / 1000)
    const model = body.model || models[0]
    const usage = computeUsage(script, body)
    const text = typeof script.text === 'string' ? script.text : ''
    const textChunks = Array.isArray(script.chunks) ? script.chunks : splitBySize(text, script.textChunkSize ?? 3)
    const calls = buildToolCalls(script, 'openai')
    const chunkDelay = script.chunkDelayMs ?? globalChunkDelay
    const base = () => ({ id, object: 'chat.completion.chunk', created, model })
    const deltaChunk = (delta, finishReason = null) => ({
      ...base(),
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })

    res.writeHead(200, sseHeaders)
    res.flushHeaders?.()

    writeSse(res, deltaChunk({ role: 'assistant', content: '' }))
    if (typeof script.reasoning === 'string' && script.reasoning.length > 0) {
      for (const piece of splitBySize(script.reasoning, script.textChunkSize ?? 3)) {
        if (!writeSse(res, deltaChunk({ reasoning_content: piece }))) return
        if (chunkDelay) await sleep(chunkDelay)
      }
    }
    for (const piece of textChunks) {
      if (!writeSse(res, deltaChunk({ content: piece }))) return
      if (chunkDelay) await sleep(chunkDelay)
    }
    for (const call of calls) {
      writeSse(
        res,
        deltaChunk({
          tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }]
        })
      )
      for (const fragment of call.fragments) {
        if (!writeSse(res, deltaChunk({ tool_calls: [{ index: call.index, function: { arguments: fragment } }] }))) return
        if (chunkDelay) await sleep(chunkDelay)
      }
    }
    const finishReason = calls.length > 0 ? 'tool_calls' : (script.stopReason === 'max_tokens' ? 'length' : 'stop')
    writeSse(res, deltaChunk({}, finishReason))
    // OpenAI 规范：只有请求 stream_options.include_usage 时才追加 usage 分片（choices 为空）
    if (body.stream_options && body.stream_options.include_usage) {
      writeSse(res, {
        ...base(),
        choices: [],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens
        }
      })
    }
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  async function streamAnthropic(ctx, script) {
    const { res, body, seq } = ctx
    const id = `msg_mock_${seq}`
    const model = body.model || models[0]
    const usage = computeUsage(script, body)
    const text = typeof script.text === 'string' ? script.text : ''
    const textChunks = Array.isArray(script.chunks) ? script.chunks : splitBySize(text, script.textChunkSize ?? 3)
    const calls = buildToolCalls(script, 'anthropic')
    const chunkDelay = script.chunkDelayMs ?? globalChunkDelay

    res.writeHead(200, sseHeaders)
    res.flushHeaders?.()

    writeSse(
      res,
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.inputTokens, output_tokens: 0 }
        }
      },
      'message_start'
    )
    writeSse(res, { type: 'ping' }, 'ping')

    // 文本块
    if (textChunks.length > 0) {
      writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start')
      for (const piece of textChunks) {
        if (!writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, 'content_block_delta')) return
        if (chunkDelay) await sleep(chunkDelay)
      }
      writeSse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop')
    }
    // 工具块（索引从文本块之后继续）
    let index = textChunks.length > 0 ? 1 : 0
    for (const call of calls) {
      writeSse(
        res,
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} }
        },
        'content_block_start'
      )
      for (const fragment of call.fragments) {
        if (!writeSse(res, {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: fragment }
        }, 'content_block_delta')) return
        if (chunkDelay) await sleep(chunkDelay)
      }
      writeSse(res, { type: 'content_block_stop', index }, 'content_block_stop')
      index += 1
    }

    const stopReason =
      script.stopReason || (calls.length > 0 ? 'tool_use' : textChunks.length > 0 ? 'end_turn' : 'end_turn')
    writeSse(
      res,
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: usage.outputTokens }
      },
      'message_delta'
    )
    writeSse(res, { type: 'message_stop' }, 'message_stop')
    if (!res.writableEnded && !res.destroyed) res.end()
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders })
    res.end(body)
  }

  function sendNonStream(ctx, script) {
    const { res, body, seq, protocol } = ctx
    const usage = computeUsage(script, body)
    const text = typeof script.text === 'string' ? script.text : ''
    const calls = buildToolCalls(script, protocol)
    if (protocol === 'anthropic') {
      const content = []
      if (text) content.push({ type: 'text', text })
      for (const call of calls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      sendJson(res, 200, {
        id: `msg_mock_${seq}`,
        type: 'message',
        role: 'assistant',
        model: body.model || models[0],
        content,
        stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
      })
      return
    }
    const message = { role: 'assistant', content: text || null }
    if (calls.length > 0) {
      message.tool_calls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.json }
      }))
    }
    sendJson(res, 200, {
      id: `chatcmpl-mock-${seq}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || models[0],
      choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens
      }
    })
  }

  function handleError(ctx, script) {
    const { res, protocol } = ctx
    const status = script.error.status || 500
    const message = script.error.message || `mock error ${status}`
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders }
    if (script.error.retryAfterMs) headers['Retry-After'] = String(Math.ceil(script.error.retryAfterMs / 1000))
    res.writeHead(status, headers)
    res.end(JSON.stringify(defaultErrorBody(protocol, status, message)))
  }

  function handleHang(ctx, script) {
    const { res } = ctx
    // 不发送响应头：模拟真实网络里「请求已到、响应迟迟不来」的停摆。
    // 客户端（provider）应靠自己的 timeout/AbortSignal 结束等待。
    const hangMs = typeof script.hangMs === 'number' ? script.hangMs : typeof script.hang === 'number' ? script.hang : 60_000
    const timer = setTimeout(() => {
      timers.delete(timer)
      res.destroy()
    }, hangMs)
    timers.add(timer)
    res.on('close', () => {
      clearTimeout(timer)
      timers.delete(timer)
    })
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 16 * 1024 * 1024) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || host}`)
    const path = url.pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders)
      res.end()
      return
    }
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      sendJson(res, 200, { ok: true, calls: requests.length, service: 'morrow-mock-llm' })
      return
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: models.map((id, i) => ({
          id,
          object: 'model',
          created: 1_760_000_000 + i,
          owned_by: 'morrow-mock'
        }))
      })
      return
    }
    const isOpenAI = path === '/v1/chat/completions' || path === '/chat/completions' || path === '/v1/completions'
    const isAnthropic = path === '/v1/messages' || path === '/messages'
    if (req.method !== 'POST' || (!isOpenAI && !isAnthropic)) {
      sendJson(res, 404, { error: { message: `未知路径 ${req.method} ${path}` } })
      return
    }
    const protocol = isAnthropic ? 'anthropic' : 'openai'
    let raw
    try {
      raw = await readBody(req)
    } catch (err) {
      sendJson(res, 400, { error: { message: String(err) } })
      return
    }
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      sendJson(res, 400, { error: { message: '请求体不是合法 JSON', raw: raw.slice(0, 200) } })
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const lastMessage = messages[messages.length - 1]
    const lastUserMessage = [...messages].reverse().find((m) => m && m.role === 'user')
    const userText =
      typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : Array.isArray(lastUserMessage?.content)
          ? lastUserMessage.content
              .map((b) => (typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : ''))
              .join('\n')
          : ''
    const record = {
      index: requests.length,
      protocol,
      method: req.method,
      url: path,
      headers: { ...req.headers },
      body,
      messages,
      lastUserMessage: lastUserMessage || null,
      lastUserMessageText: userText,
      receivedAt: Date.now()
    }
    requests.push(record)
    if (typeof options.onRequest === 'function') {
      try {
        options.onRequest(record)
      } catch {
        // 回调异常不影响服务
      }
    }
    const seq = record.index + 1
    const ctx = {
      index: record.index,
      seq,
      protocol,
      method: req.method,
      url: path,
      headers: req.headers,
      body,
      raw,
      messages,
      lastUserMessage: lastUserMessage || null,
      lastUserMessageText: userText,
      lastMessage,
      record,
      req,
      res
    }
    try {
      const script = await pickScript(ctx)
      if (script.delayMs) await sleep(script.delayMs)
      if (res.writableEnded || res.destroyed) return
      if (script.rawSse !== undefined) {
        res.writeHead(200, sseHeaders)
        res.flushHeaders?.()
        res.write(String(script.rawSse))
        res.end()
        return
      }
      if (script.error) return handleError(ctx, script)
      if (script.hang) return handleHang(ctx, script)
      if (body.stream === false) return sendNonStream(ctx, script)
      if (protocol === 'anthropic') await streamAnthropic(ctx, script)
      else await streamOpenAI(ctx, script)
    } catch (err) {
      if (!res.writableEnded && !res.destroyed) {
        try {
          sendJson(res, 500, { error: { message: `mock 内部错误: ${String(err)}` } })
        } catch {
          // 连接已断
        }
      }
    }
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://${host}:${port}`

  return {
    ...state,
    port,
    host,
    url,
    openaiBaseUrl: `${url}/v1`,
    anthropicBaseUrl: `${url}/v1`,
    models,
    /** 已收到的请求数 */
    get calls() {
      return requests.length
    },
    /** 最近一次请求记录 */
    get lastRequest() {
      return requests[requests.length - 1]
    },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }
}

export default startMockLLM
