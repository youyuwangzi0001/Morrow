import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startCodexProxy, toResponsesPayload, type CodexCredential } from '../../../src/main/services/codex-proxy'
import { startSubscriptionRelay } from '../../../src/main/services/subscription-relay'
import {
  decodeQoderBody,
  encodeQoderBody,
  startQoderProxy,
  type QoderCredential,
  type QoderModel
} from '../../../src/main/services/qoder-proxy'

describe('Codex 订阅代理文件', () => {
const models = [{
  id: 'gpt-6-sol',
  label: 'GPT-6 Sol',
  contextWindow: 384000,
  supportsTools: true,
  supportsReasoning: true,
  reasoningStyle: 'effort' as const
}]

const credential: CodexCredential = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  accountId: 'acct-123',
  email: 'user@example.com',
  plan: 'pro',
  expiresAt: Date.now() + 3600_000
}

function sse(events: Array<{ event: string; data: unknown }>): Response {
  const text = events.map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('Codex 订阅代理', () => {
  const handles: Array<{ close(): Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
  })

  it('把 Chat Completions 消息和工具转成 Responses payload', () => {
    const payload = toResponsesPayload({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: '系统约束' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '调用工具', tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '文件内容' }
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
    })
    expect(payload).toMatchObject({ model: 'gpt-6-sol', store: false, stream: true })
    expect(payload.instructions).toBe('系统约束')
    expect(payload.tools).toEqual([expect.objectContaining({ type: 'function', name: 'read_file' })])
    const input = payload.input as Array<Record<string, unknown>>
    expect(input.some((item) => item.type === 'function_call' && item.call_id === 'call_1')).toBe(true)
    expect(input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1')).toBe(true)
  })

  it('assistant 历史内容使用 output_text，避免上游拒绝 input_text', () => {
    const payload = toResponsesPayload({
      model: 'gpt-6-sol',
      messages: [
        { role: 'user', content: '画一只鹅' },
        { role: 'assistant', content: '已经画好了。' },
        { role: 'assistant', content: [{ type: 'text', text: '补充说明。' }] }
      ]
    })
    const input = payload.input as Array<Record<string, unknown>>
    expect(input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: '画一只鹅' }] })
    expect(input[1]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: '已经画好了。' }] })
    expect(input[2]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: '补充说明。' }] })
  })

  it('启动回环代理并把 Responses 文本/工具事件转成 OpenAI 流', async () => {
    const localToken = 'local-token'
    let upstreamHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      upstreamHeaders = init.headers as Record<string, string>
      return sse([
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'OK' } },
        { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } } },
        { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"a"}' } },
        { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } } }
      ])
    })
    const handle = await startCodexProxy({
      localToken,
      models,
      getCredentials: async () => credential,
      refreshCredentials: async () => credential,
      fetchImpl
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }]
      })
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"content":"OK"')
    expect(text).toContain('"tool_calls"')
    expect(text).toContain('call_1')
    expect(text).toContain('[DONE]')
    expect(upstreamHeaders.authorization).toBe('Bearer test-access')
    expect(upstreamHeaders['chatgpt-account-id']).toBe('acct-123')
  })

  it('上游只在 done 事件给出完整工具参数时，仍把参数补发给客户端', async () => {
    const localToken = 'local-token'
    const fetchImpl = vi.fn(async () => sse([
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_skill', arguments: '' } } },
      { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_skill', arguments: '{"name":"code-review"}' } } },
      { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } } }
    ]))
    const handle = await startCodexProxy({
      localToken,
      models,
      getCredentials: async () => credential,
      refreshCredentials: async () => credential,
      fetchImpl
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        stream: true,
        messages: [{ role: 'user', content: 'read skill' }],
        tools: [{ type: 'function', function: { name: 'read_skill', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }]
      })
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('read_skill')
    expect(text).toContain('code-review')
    expect(text).toContain('tool_calls')
  })

  it('上游用 function_call_arguments.done 下发完整参数时，流式工具调用参数不丢失', async () => {
    const localToken = 'local-token'
    const fetchImpl = vi.fn(async () => sse([
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_skill', arguments: '' } } },
      { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"name":"code-review"}' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } } }
    ]))
    const handle = await startCodexProxy({
      localToken,
      models,
      getCredentials: async () => credential,
      refreshCredentials: async () => credential,
      fetchImpl
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-sol',
        stream: true,
        messages: [{ role: 'user', content: 'read skill' }],
        tools: [{ type: 'function', function: { name: 'read_skill', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } }]
      })
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('read_skill')
    expect(text).toContain('code-review')
  })

  it('拒绝未携带本地令牌的请求', async () => {
    const handle = await startCodexProxy({
      localToken: 'expected',
      models,
      getCredentials: async () => credential,
      refreshCredentials: async () => credential,
      fetchImpl: vi.fn()
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/models`)
    expect(response.status).toBe(401)
  })
})
})

describe('订阅线路转发器文件', () => {
describe('订阅线路转发器', () => {
  const handles: Array<{ close(): Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
  })

  it('注入鉴权头、改写模型并透传流式响应', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('data: {"type":"content_block_delta"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' }
      })
    })
    const handle = await startSubscriptionRelay({
      localToken: 'local-token',
      resolveUpstream: (path, search) => `https://upstream.example${path}${search}`,
      getHeaders: () => ({ authorization: 'Bearer upstream-oauth', 'x-app': 'morrow' }),
      rewriteBody: (body) => body.replace(/"model":"alias"/, '"model":"upstream-model"'),
      fetchImpl
    })
    handles.push(handle)

    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/messages?beta=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer local-token' },
      body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('req-1')
    expect(await response.text()).toContain('content_block_delta')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://upstream.example/v1/messages?beta=1')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer upstream-oauth')
    expect(headers['x-app']).toBe('morrow')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(String(calls[0]!.init.body)).toContain('"upstream-model"')
  })

  it('上游 401 时刷新令牌并重试一次', async () => {
    let token = 'expired'
    let refreshes = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization
      if (auth === 'Bearer expired') return new Response('unauthorized', { status: 401 })
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    const handle = await startSubscriptionRelay({
      localToken: 'local',
      resolveUpstream: (path) => `https://upstream.example${path}`,
      getHeaders: () => ({ authorization: `Bearer ${token}` }),
      refresh: async () => {
        refreshes += 1
        token = 'fresh'
      },
      fetchImpl
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
      body: JSON.stringify({ model: 'm', messages: [] })
    })
    expect(response.status).toBe(200)
    expect(refreshes).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('拒绝错误的本地令牌，并允许健康检查', async () => {
    const handle = await startSubscriptionRelay({
      localToken: 'expected',
      resolveUpstream: (path) => `https://upstream.example${path}`,
      getHeaders: () => ({}),
      fetchImpl: vi.fn()
    })
    handles.push(handle)
    expect((await fetch(`http://127.0.0.1:${handle.port}/v1/models`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${handle.port}/health`)).status).toBe(200)
  })
})
})

describe('Qoder 订阅文件', () => {
const models: QoderModel[] = [
  { id: 'Auto', upstreamKey: 'auto', label: 'Auto', contextWindow: 200_000, supportsImages: true, reasoning: true },
  { id: 'Qwen3.7-Max', upstreamKey: 'qmodel_latest', label: 'Qwen3.7-Max', contextWindow: 200_000, supportsImages: true, reasoning: true }
]

const credential: QoderCredential = {
  accessToken: 'jt-test-access',
  refreshToken: 'jrt-test-refresh',
  expiresAt: Date.now() + 3600_000,
  region: 'global',
  uid: 'uid-1',
  rawUserInfo: '',
  dataPolicyAgreed: true,
  email: 'qoder@example.com',
  name: 'Qoder User',
  organizationId: 'org-1',
  organizationTags: ['team', 'pro'],
  machineId: '00000000-1111-4222-8333-444444444444'
}

function envelope(body: unknown, status = 200): string {
  return `data: ${JSON.stringify({ headers: {}, body: JSON.stringify(body), statusCodeValue: status })}\n\n`
}

function sseResponse(frames: string): Response {
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('Qoder 请求 codec', () => {
  it('按 frozen fixture 逐字节编码请求体', () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, '../../fixtures/qoder/body-codec.json'), 'utf8')) as {
      body_raw: string
      body_string: string
    }
    const encoded = encodeQoderBody(fixture.body_raw)
    expect(encoded).toBe(fixture.body_string)
    expect(decodeQoderBody(fixture.body_string)).toBe(fixture.body_raw)
  })

  it('自定义 alphabet 与三段交换可逆', () => {
    const raw = JSON.stringify({ messages: [{ role: 'system', content: '中文 system' }, { role: 'user', content: '你好，Qoder' }] })
    const encoded = encodeQoderBody(raw)
    expect(encoded).not.toContain('{')
    expect(decodeQoderBody(encoded)).toBe(raw)
  })
})

describe('Qoder 订阅代理', () => {
  const handles: Array<{ close(): Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
  })

  it('签名请求上游，并把信封 SSE 转成 OpenAI 流', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return sseResponse(
        envelope({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
        + envelope({ choices: [{ index: 0, delta: { content: '你好' } }] })
        + envelope({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } })
        + 'event:finish\ndata: {"duration":1}\n\n'
      )
    })
    const localToken = 'local-qoder-token'
    const handle = await startQoderProxy({
      localToken,
      models,
      getCredential: async () => credential,
      refreshCredential: async () => credential,
      fetchImpl
    })
    handles.push(handle)

    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${localToken}`,
        'content-type': 'application/json',
        'x-session-id': 'sess-1'
      },
      body: JSON.stringify({
        model: 'Auto',
        stream: true,
        messages: [
          { role: 'system', content: '你是 Morrow 的助手' },
          { role: 'user', content: '你好' }
        ],
        tools: [{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
      })
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"content":"你好"')
    expect(text).toContain('[DONE]')

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toContain('https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?')
    expect(call.url).toContain('FetchKeys=llm_model_result')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
    expect(headers['Cosy-User']).toBe('uid-1')
    expect(headers['Cosy-MachineId']).toBe(credential.machineId)
    expect(headers['Cosy-Data-Policy']).toBe('agree')
    expect(headers['Cosy-Organization-Id']).toBe('org-1')
    expect(headers['Cosy-Organization-Tags']).toBe('team,pro')
    expect(headers['X-Model-Key']).toBe('auto')
    expect(headers['X-Model-Source']).toBe('system')

    const payload = JSON.parse(decodeQoderBody(String(call.init.body))) as Record<string, unknown>
    expect(payload.agent_id).toBe('agent_common')
    expect(payload.session_type).toBe('qodercli')
    expect(payload.stream).toBe(true)
    expect(payload.session_id).toMatch(/^[0-9a-f]{16}-sess-1$/)
    expect(payload.system).toBe('你是 Morrow 的助手')
    const messages = payload.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: '你是 Morrow 的助手' })
    expect(messages[1]).toEqual({ role: 'user', content: '你好' })
    expect(payload.model_config).toMatchObject({ key: 'auto', is_reasoning: true })
    expect(Array.isArray(payload.tools)).toBe(true)
    expect((payload.business as Record<string, unknown>).name).toBe('你好')
  })

  it('保留工具调用帧与 finish_reason', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(
      envelope({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]
          },
          finish_reason: 'tool_calls'
        }]
      })
      + 'event:finish\ndata: {}\n\n'
    ))
    const handle = await startQoderProxy({
      localToken: 'token',
      models,
      getCredential: async () => credential,
      refreshCredential: async () => credential,
      fetchImpl
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Auto', stream: true, messages: [{ role: 'user', content: '读文件' }] })
    })
    const text = await response.text()
    expect(text).toContain('"tool_calls"')
    expect(text).toContain('call_1')
    expect(text).toContain('"finish_reason":"tool_calls"')
  })

  it('把上游错误信封转成错误帧', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(
      `data: ${JSON.stringify({ body: JSON.stringify({ code: 105, message: 'Login expired' }), statusCodeValue: 401 })}\n\n`
    ))
    const handle = await startQoderProxy({
      localToken: 'token',
      models,
      getCredential: async () => credential,
      refreshCredential: async () => credential,
      fetchImpl
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Auto', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    const text = await response.text()
    expect(text).toContain('Login expired')
  })

  it('拒绝未携带本地令牌的请求', async () => {
    const handle = await startQoderProxy({
      localToken: 'expected',
      models,
      getCredential: async () => credential,
      refreshCredential: async () => credential,
      fetchImpl: vi.fn()
    })
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/v1/models`)
    expect(response.status).toBe(401)
  })
})
})
