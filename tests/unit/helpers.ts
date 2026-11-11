// 单元测试共用辅助：由 helpers/ 下 workspace、tool-context、mock-llm、scripted-provider、compaction-validators、env 扁平合并。
import { expect } from 'vitest'
import type { ChatMessage, Artifact, SessionPlan, TodoItem } from '../../src/shared/types'
import { toOpenAIMessages, toAnthropicMessages, ProviderError } from '../../src/core/providers'
import { sanitizeEnv } from '../../src/core/tool-media'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest, ToolContext } from '../../src/core/types'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** OpenAI 序列合法性：assistant.tool_calls 后面必须紧跟同 id 的 tool 消息，无孤立 tool。 */
export function expectValidOpenAISequence(messages: ChatMessage[]): void {
  const converted = toOpenAIMessages(messages, '你是压缩测试助手。')
  const pending: string[] = []
  for (const message of converted) {
    if (message.role === 'tool') {
      expect(pending.length, `出现孤立 tool 消息：${JSON.stringify(message)}`).toBeGreaterThan(0)
      const expectedId = pending.shift()
      expect(message.tool_call_id).toBe(expectedId)
      continue
    }
    expect(pending, `assistant.tool_calls 后缺少 tool 结果：${JSON.stringify(message)}`).toHaveLength(0)
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) pending.push(call.id)
    }
  }
  expect(pending, '存在没有回填结果的 tool_calls').toHaveLength(0)
}

/** Anthropic 序列合法性：首条 user；user/assistant 交替；每个 tool_result 前面有对应 tool_use。 */
export function expectValidAnthropicSequence(messages: ChatMessage[]): void {
  const converted = toAnthropicMessages(messages, '你是压缩测试助手。')
  expect(converted.messages.length).toBeGreaterThan(0)
  expect(converted.messages[0].role).toBe('user')
  const toolUseIds = new Set<string>()
  const resultIds: string[] = []
  for (let index = 0; index < converted.messages.length; index += 1) {
    const message = converted.messages[index]
    if (index > 0) expect(message.role).not.toBe(converted.messages[index - 1].role)
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') resultIds.push(block.tool_use_id)
    }
  }
  for (const resultId of resultIds) expect(toolUseIds.has(resultId)).toBe(true)
  expect(resultIds).toHaveLength(toolUseIds.size)
}

export function filterSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return sanitizeEnv(env)
}

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

export interface ScriptToolCall {
  name: string
  input?: Record<string, unknown>
  id?: string
  /** 自定义参数 JSON（默认由 input 序列化） */
  args?: string
  /** 模拟「参数被截断/不合法」：provider 以 parseError 形式结束该工具调用 */
  parseError?: string
}

export interface ScriptStep {
  text?: string
  thinking?: string
  toolCalls?: ScriptToolCall[]
  /** 该回合直接抛错（模拟 provider 失败） */
  error?: { message: string; code?: string; retryable?: boolean }
  /** 逐事件间隔（毫秒），用于中断测试 */
  delayMs?: number
}

export class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  readonly calls: ProviderStreamRequest[] = []
  private readonly queue: ScriptStep[]
  private readonly defaultText: string

  constructor(steps: ScriptStep[], options: { defaultText?: string } = {}) {
    this.queue = [...steps]
    this.defaultText = options.defaultText ?? '好的。'
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    // 快照消息数组：请求对象里的 messages 是 Agent 的工作数组，后续回合还会 push 新消息
    this.calls.push({ ...request, messages: [...request.messages] })
    const step = this.queue.shift() ?? { text: this.defaultText }
    if (step.delayMs && step.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs))
    }
    if (step.error) {
      throw new ProviderError(step.error.message, {
        code: step.error.code ?? 'provider_error',
        retryable: step.error.retryable ?? false,
        providerId: this.id
      })
    }
    if (step.thinking) yield { type: 'thinking_delta', text: step.thinking }
    if (step.text) yield { type: 'text_delta', text: step.text }
    const calls = step.toolCalls ?? []
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]
      const id = call.id ?? `call_${this.calls.length}_${index}`
      if (call.parseError) {
        yield { type: 'tool_call_end', index, id, name: call.name, input: {}, parseError: call.parseError }
        continue
      }
      const args = call.args ?? JSON.stringify(call.input ?? {})
      yield { type: 'tool_call_start', index, id, name: call.name }
      if (step.delayMs && step.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs))
      }
      yield { type: 'tool_call_delta', index, argsDelta: args }
      yield {
        type: 'tool_call_end',
        index,
        id,
        name: call.name,
        input: call.input ?? (JSON.parse(args) as Record<string, unknown>)
      }
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
  }
}

/** 收集 async iterable 的所有事件 */
export async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of iterable) events.push(event)
  return events
}

export interface ToolContextState {
  todos: TodoItem[]
  artifacts: Artifact[]
  progressNotes: string[]
}

export function makeToolContext(
  ws: TempWorkspace,
  overrides: Partial<ToolContext> = {},
  state: ToolContextState = { todos: [], artifacts: [], progressNotes: [] }
): ToolContext {
  let plan: SessionPlan | null = null
  return {
    sessionId: 'session_docs',
    runId: 'run_docs',
    messageId: 'msg_docs',
    toolUseId: 'call_docs',
    workspace: ws.root,
    permissionMode: 'auto',
    snapshotDir: ws.snapshotDir,
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    planMode: false,
    getPlan: () => plan,
    proposePlan: (next) => {
      plan = next
      return next
    },
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => state.todos,
    setTodos: (todos) => {
      state.todos = todos
    },
    getArtifacts: () => state.artifacts,
    addArtifact: (artifact) => {
      state.artifacts.push(artifact)
    },
    askUser: async () => ({ value: 'A', label: '方案 A' }),
    progress: (note) => {
      state.progressNotes.push(note)
    },
    runSwarmMember: async () => ({ status: 'completed', summary: '集群成员已完成', steps: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    ...overrides
  }
}

export interface TempWorkspace {
  root: string
  snapshotDir: string
  cleanup: () => void
}

export function makeTempDir(prefix = 'morrow-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 在 root 下按相对路径写文件（自动建父目录） */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
}

export function makeTempWorkspace(files: Record<string, string> = {}): TempWorkspace {
  const root = makeTempDir('morrow-ws-')
  const snapshotDir = makeTempDir('morrow-snap-')
  writeFiles(root, files)
  return {
    root,
    snapshotDir,
    cleanup: () => {
      // Windows 上刚退出的 ConPTY 宿主可能短暂占用工作目录；重试后仍被占用不应让测试失败。
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY') throw err
      }
      rmSync(snapshotDir, { recursive: true, force: true })
    }
  }
}
