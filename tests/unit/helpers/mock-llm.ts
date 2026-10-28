/**
 * 测试辅助：本地 Mock LLM HTTP 服务（同时支持 OpenAI 与 Anthropic 两种 SSE）。
 * 端口动态分配，用于协议层集成测试与完整的「HTTP → Provider → Agent」链路。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  /** 解析后的 JSON body */
  body: Record<string, unknown>
  raw: string
}

export interface MockSSEReply {
  status?: number
  /** 非 2xx 时的响应体（JSON 字符串） */
  body?: string
  /** SSE 帧；带 _event 字段的会输出 `event: <name>`（Anthropic 风格） */
  frames?: Array<Record<string, unknown>>
  /** 是否在末尾补 `data: [DONE]`（OpenAI），默认 true */
  done?: boolean
}

export type MockHandler = (request: MockRequest, index: number) => MockSSEReply | Promise<MockSSEReply>

export interface MockLLM {
  baseUrl: string
  requests: MockRequest[]
  close: () => Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function writeSse(response: ServerResponse, frames: Array<Record<string, unknown>>, done: boolean): void {
  for (const frame of frames) {
    const eventName = frame._event
    const payload = { ...frame }
    delete payload._event
    if (eventName) response.write(`event: ${String(eventName)}\n`)
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  if (done) response.write('data: [DONE]\n\n')
  response.end()
}

export async function startMockLLM(handler: MockHandler): Promise<MockLLM> {
  const requests: MockRequest[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request)
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      const record: MockRequest = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body,
        raw
      }
      requests.push(record)
      const index = requests.length - 1
      let reply: MockSSEReply
      try {
        reply = await handler(record, index)
      } catch (err) {
        reply = { status: 500, body: JSON.stringify({ error: { message: String(err) } }) }
      }
      if (reply.status && reply.status >= 400) {
        response.writeHead(reply.status, { 'content-type': 'application/json' })
        response.end(reply.body ?? JSON.stringify({ error: { message: `mock error ${reply.status}` } }))
        return
      }
      if (!reply.frames) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(reply.body ?? '{}')
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      writeSse(response, reply.frames, reply.done !== false)
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

/* ── 便捷帧构造 ───────────────────────────────────────────────── */

/** OpenAI 文本流：逐段 delta */
export function openAITextFrames(text: string, options: { usage?: { input: number; output: number } } = {}): Array<Record<string, unknown>> {
  const chars = [...text]
  const frames: Array<Record<string, unknown>> = chars.map((char) => ({
    choices: [{ index: 0, delta: { content: char } }]
  }))
  if (options.usage) {
    frames.push({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: options.usage.input, completion_tokens: options.usage.output }
    })
  }
  return frames
}

/** OpenAI 工具调用流：id/name 在首帧，arguments 分片 */
export function openAIToolFrames(
  id: string,
  name: string,
  argsJson: string,
  options: { text?: string; usage?: { input: number; output: number } } = {}
): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  if (options.text) frames.push({ choices: [{ index: 0, delta: { content: options.text } }] })
  frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] })
  const third = Math.ceil(argsJson.length / 3)
  for (let i = 0; i < argsJson.length; i += third) {
    frames.push({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(i, i + third) } }] } }]
    })
  }
  if (options.usage) {
    frames.push({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: options.usage.input, completion_tokens: options.usage.output }
    })
  }
  return frames
}

/** Anthropic 文本流（含 message_start/message_delta/message_stop） */
export function anthropicTextFrames(text: string, usage: { input: number; output: number } = { input: 30, output: 10 }): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [
    { _event: 'message_start', type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: usage.input, output_tokens: 0 } } },
    { _event: 'content_block_start', type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
  ]
  for (const char of [...text]) {
    frames.push({ _event: 'content_block_delta', type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: char } })
  }
  frames.push(
    { _event: 'content_block_stop', type: 'content_block_stop', index: 0 },
    { _event: 'message_delta', type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output } },
    { _event: 'message_stop', type: 'message_stop' }
  )
  return frames
}

/** Anthropic 工具调用流（content_block_start(tool_use) + input_json_delta 分片） */
export function anthropicToolFrames(
  id: string,
  name: string,
  argsJson: string,
  options: { text?: string; usage?: { input: number; output: number } } = {}
): Array<Record<string, unknown>> {
  const usage = options.usage ?? { input: 40, output: 20 }
  const frames: Array<Record<string, unknown>> = [
    { _event: 'message_start', type: 'message_start', message: { id: 'msg_mock', usage: { input_tokens: usage.input, output_tokens: 0 } } }
  ]
  if (options.text) {
    frames.push(
      { _event: 'content_block_start', type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { _event: 'content_block_delta', type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: options.text } },
      { _event: 'content_block_stop', type: 'content_block_stop', index: 0 }
    )
  }
  const toolIndex = options.text ? 1 : 0
  frames.push(
    { _event: 'content_block_start', type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id, name } },
    { _event: 'content_block_delta', type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: argsJson } },
    { _event: 'content_block_stop', type: 'content_block_stop', index: toolIndex },
    { _event: 'message_delta', type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: usage.output } },
    { _event: 'message_stop', type: 'message_stop' }
  )
  return frames
}
