// Mock LLM 自检：node --test tests/fixtures/mock-llm.test.mjs
// 不依赖 vitest（根 vitest.config.ts 只扫 tests/unit），保持 fixture 可独立运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockLLM } from './mock-llm.mjs'



/** 把 SSE 响应体拆成 [{ event?, data }]。 */
async function readSse(response) {
  const text = await response.text()
  const events = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line.length > 0)
    if (lines.length === 0) continue
    let event
    const dataLines = []
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      else if (line === 'data:') dataLines.push('')
    }
    events.push({ event, data: dataLines.join('\n') })
  }
  return events
}

function openAiChunks(events) {
  return events
    .filter((e) => e.data !== undefined && e.data !== '[DONE]' && e.data !== '')
    .map((e) => JSON.parse(e.data))
}

function joinedContent(chunks) {
  return chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
}

async function postOpenAI(mock, body) {
  return fetch(`${mock.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', ...body })
  })
}

async function postAnthropic(mock, body) {
  return fetch(`${mock.anthropicBaseUrl}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', max_tokens: 256, ...body })
  })
}

const user = (text) => ({ role: 'user', content: text })

test('启动/关闭：动态端口、health、models', async () => {
  const mock = await startMockLLM({ port: 0, models: ['mock-a', 'mock-b'] })
  try {
    assert.ok(mock.port > 0)
    assert.equal(mock.url, `http://127.0.0.1:${mock.port}`)
    assert.equal(mock.openaiBaseUrl, `${mock.url}/v1`)
    const health = await (await fetch(`${mock.url}/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.calls, 0)
    const models = await (await fetch(`${mock.url}/v1/models`)).json()
    assert.deepEqual(
      models.data.map((m) => m.id),
      ['mock-a', 'mock-b']
    )
    assert.equal(mock.calls, 0)
  } finally {
    await mock.close()
  }
})

test('OpenAI SSE：文本流、role、finish_reason、[DONE] 与请求记录', async () => {
  const mock = await startMockLLM({ scripts: [{ text: '你好，Morrow' }] })
  try {
    const res = await postOpenAI(mock, { stream: true, messages: [user('你好')] })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const events = await readSse(res)
    const chunks = openAiChunks(events)
    assert.equal(chunks[0].choices[0].delta.role, 'assistant')
    assert.equal(joinedContent(chunks), '你好，Morrow')
    const finished = chunks.find((c) => c.choices?.[0]?.finish_reason)
    assert.equal(finished.choices[0].finish_reason, 'stop')
    assert.ok(events.some((e) => e.data === '[DONE]'))
    // 请求被记录：engine 可以断言模型收到的消息
    assert.equal(mock.calls, 1)
    assert.equal(mock.requests[0].protocol, 'openai')
    assert.equal(mock.requests[0].lastUserMessageText, '你好')
    assert.equal(mock.requests[0].body.messages[0].content, '你好')
  } finally {
    await mock.close()
  }
})

test('OpenAI SSE：tool_calls 分片（多个调用、参数 JSON 跨分片）', async () => {
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我先读两个文件。',
        toolCalls: [
          { name: 'read_file', arguments: { path: 'docs/说明.md', limit: 10 } },
          { name: 'list_dir', arguments: { path: '.', depth: 2 } }
        ]
      }
    ]
  })
  try {
    const res = await postOpenAI(mock, { stream: true, messages: [user('读文件')] })
    const chunks = openAiChunks(await readSse(res))
    const toolDeltas = chunks.filter((c) => Array.isArray(c.choices?.[0]?.delta?.tool_calls))
    assert.ok(toolDeltas.length >= 4, '参数应该被拆成多个分片')
    // 按 index 聚合
    const calls = new Map()
    for (const chunk of toolDeltas) {
      for (const delta of chunk.choices[0].delta.tool_calls) {
        const acc = calls.get(delta.index) || { id: undefined, name: '', args: '' }
        if (delta.id) acc.id = delta.id
        if (delta.function?.name) acc.name += delta.function.name
        if (delta.function?.arguments) acc.args += delta.function.arguments
        calls.set(delta.index, acc)
      }
    }
    assert.equal(calls.size, 2)
    assert.equal(calls.get(0).name, 'read_file')
    assert.deepEqual(JSON.parse(calls.get(0).args), { path: 'docs/说明.md', limit: 10 })
    assert.equal(calls.get(1).name, 'list_dir')
    assert.deepEqual(JSON.parse(calls.get(1).args), { path: '.', depth: 2 })
    assert.ok(calls.get(0).id.startsWith('call_mock_'))
    const finished = chunks.find((c) => c.choices?.[0]?.finish_reason)
    assert.equal(finished.choices[0].finish_reason, 'tool_calls')
  } finally {
    await mock.close()
  }
})

test('OpenAI SSE：stream_options.include_usage 才追加 usage 分片', async () => {
  const mock = await startMockLLM({ scripts: [{ text: 'ok', usage: { inputTokens: 12, outputTokens: 3 } }] })
  try {
    const withUsage = await readSse(
      await postOpenAI(mock, {
        stream: true,
        messages: [user('a')],
        stream_options: { include_usage: true }
      })
    )
    const chunks = openAiChunks(withUsage)
    const usageChunk = chunks.find((c) => c.usage)
    assert.ok(usageChunk, '缺少 usage 分片')
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
    assert.deepEqual(usageChunk.choices, [])

    const withoutUsage = await readSse(await postOpenAI(mock, { stream: true, messages: [user('b')] }))
    assert.equal(openAiChunks(withoutUsage).some((c) => c.usage), false)
  } finally {
    await mock.close()
  }
})

test('OpenAI 非流式：message + tool_calls + usage JSON', async () => {
  const mock = await startMockLLM({
    scripts: [{ text: '好的', toolCalls: [{ name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } }] }]
  })
  try {
    const res = await postOpenAI(mock, { stream: false, messages: [user('写文件')] })
    assert.match(res.headers.get('content-type'), /application\/json/)
    const json = await res.json()
    assert.equal(json.object, 'chat.completion')
    assert.equal(json.choices[0].message.content, '好的')
    assert.equal(json.choices[0].message.tool_calls[0].function.name, 'write_file')
    assert.deepEqual(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments), {
      path: 'out.txt',
      content: 'hi'
    })
    assert.equal(json.choices[0].finish_reason, 'tool_calls')
    assert.ok(json.usage.total_tokens > 0)
  } finally {
    await mock.close()
  }
})

test('错误注入：429 后重试成功，500 归一化错误体', async () => {
  const mock = await startMockLLM({
    scripts: [{ error: { status: 429, message: '慢一点', retryAfterMs: 500 } }, { text: '重试成功' }]
  })
  try {
    const first = await postOpenAI(mock, { stream: true, messages: [user('a')] })
    assert.equal(first.status, 429)
    assert.equal(first.headers.get('retry-after'), '1')
    const errBody = await first.json()
    assert.match(errBody.error.type, /rate_limit/)
    assert.equal(errBody.error.message, '慢一点')

    const second = await postOpenAI(mock, { stream: true, messages: [user('a')] })
    assert.equal(second.status, 200)
    const chunks = openAiChunks(await readSse(second))
    assert.equal(joinedContent(chunks), '重试成功')
    assert.equal(mock.calls, 2)
  } finally {
    await mock.close()
  }

  const mock500 = await startMockLLM({ scripts: [{ error: { status: 500 } }] })
  try {
    const res = await postOpenAI(mock500, { stream: true, messages: [user('a')] })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal(body.error.type, 'server_error')
  } finally {
    await mock500.close()
  }
})

test('Anthropic SSE：消息/文本块事件序列完整', async () => {
  const mock = await startMockLLM({ scripts: [{ text: '好的，我来处理。', usage: { inputTokens: 20, outputTokens: 8 } }] })
  try {
    const res = await postAnthropic(mock, { stream: true, messages: [user('帮个忙')] })
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const events = await readSse(res)
    const names = events.filter((e) => e.event).map((e) => e.event)
    assert.deepEqual(names.slice(0, 3), ['message_start', 'ping', 'content_block_start'])
    assert.equal(names.filter((n) => n === 'content_block_delta').length, 3, '8 个字符按 3 字一片应产生 3 个 delta')
    assert.deepEqual(names.slice(-3), ['content_block_stop', 'message_delta', 'message_stop'])
    assert.equal(names[names.length - 2], 'message_delta')
    const parsed = events.filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }))
    const start = parsed.find((e) => e.event === 'message_start').data
    assert.equal(start.message.role, 'assistant')
    assert.equal(start.message.usage.input_tokens, 20)
    const text = parsed
      .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
      .map((e) => e.data.delta.text)
      .join('')
    assert.equal(text, '好的，我来处理。')
    const delta = parsed.find((e) => e.event === 'message_delta').data
    assert.equal(delta.delta.stop_reason, 'end_turn')
    assert.equal(delta.usage.output_tokens, 8)
  } finally {
    await mock.close()
  }
})

test('Anthropic SSE：tool_use 的 input_json_delta 跨分片可拼回 JSON', async () => {
  const mock = await startMockLLM({
    scripts: [{ text: '我读一下。', toolCalls: [{ name: 'read_file', arguments: { path: 'README-待整理.md' } }] }]
  })
  try {
    const res = await postAnthropic(mock, { stream: true, messages: [user('读 README')] })
    const events = await readSse(res)
    const parsed = events.filter((e) => e.event && e.data).map((e) => ({ event: e.event, data: JSON.parse(e.data) }))
    const blockStart = parsed.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use')
    assert.ok(blockStart, '缺少 tool_use 的 content_block_start')
    assert.equal(blockStart.data.content_block.name, 'read_file')
    assert.ok(blockStart.data.content_block.id.startsWith('toolu_mock_'))
    const index = blockStart.data.index
    const fragments = parsed
      .filter((e) => e.event === 'content_block_delta' && e.data.index === index)
      .map((e) => e.data.delta.partial_json)
    assert.ok(fragments.length > 1, '参数应该被拆成多个 input_json_delta')
    assert.deepEqual(JSON.parse(fragments.join('')), { path: 'README-待整理.md' })
    const messageDelta = parsed.find((e) => e.event === 'message_delta').data
    assert.equal(messageDelta.delta.stop_reason, 'tool_use')
  } finally {
    await mock.close()
  }
})

test('剧本选择：按最后一条 user 消息返回不同剧本', async () => {
  const mock = await startMockLLM({
    respond: ({ lastUserMessageText }) =>
      lastUserMessageText.includes('天气') ? { text: '今天晴，26 度。' } : { text: '收到，我来做。' }
  })
  try {
    const sunny = openAiChunks(await readSse(await postOpenAI(mock, { stream: true, messages: [user('今天天气如何')] })))
    assert.equal(joinedContent(sunny), '今天晴，26 度。')
    const other = openAiChunks(await readSse(await postOpenAI(mock, { stream: true, messages: [user('做个周报')] })))
    assert.equal(joinedContent(other), '收到，我来做。')
    assert.equal(mock.requests[0].lastUserMessageText, '今天天气如何')
    assert.equal(mock.requests[1].lastUserMessageText, '做个周报')
  } finally {
    await mock.close()
  }
})

test('剧本用尽时使用 defaultScript；reset 清空请求记录', async () => {
  const mock = await startMockLLM({ scripts: [{ text: '第一句' }], defaultScript: { text: '兜底' } })
  try {
    const first = openAiChunks(await readSse(await postOpenAI(mock, { stream: true, messages: [user('1')] })))
    assert.equal(joinedContent(first), '第一句')
    const second = openAiChunks(await readSse(await postOpenAI(mock, { stream: true, messages: [user('2')] })))
    assert.equal(joinedContent(second), '兜底')
    assert.equal(mock.calls, 2)
    mock.reset()
    assert.equal(mock.calls, 0)
  } finally {
    await mock.close()
  }
})

test('分片控制：textChunkSize / chunkDelayMs / reasoning_content', async () => {
  const mock = await startMockLLM({
    scripts: [{ reasoning: '想一想', text: 'abcdef', textChunkSize: 2, chunkDelayMs: 1 }]
  })
  try {
    const chunks = openAiChunks(await readSse(await postOpenAI(mock, { stream: true, messages: [user('x')] })))
    const contentPieces = chunks.map((c) => c.choices?.[0]?.delta?.content).filter((t) => t !== undefined && t !== '')
    assert.deepEqual(contentPieces, ['ab', 'cd', 'ef'])
    const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? '').join('')
    assert.equal(reasoning, '想一想')
  } finally {
    await mock.close()
  }
})

test('停摆注入：hang 时客户端超时，close 不悬挂', async () => {
  const mock = await startMockLLM({ scripts: [{ hang: true, hangMs: 5000 }] })
  try {
    const started = Date.now()
    await assert.rejects(
      fetch(`${mock.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mock-model', stream: true, messages: [user('x')] }),
        signal: AbortSignal.timeout(300)
      })
    )
    assert.ok(Date.now() - started < 3000, '应该很快超时')
  } finally {
    const closed = await Promise.race([
      mock.close().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000))
    ])
    assert.equal(closed, true, 'mock.close() 不应被 hang 的连接卡住')
  }
})

test('rawSse 原样透传（用于异常/畸形流测试）', async () => {
  const raw = 'data: {"choices":[{"delta":{"content":"半"}}]}\n\ndata: [DONE]\n\n'
  const mock = await startMockLLM({ scripts: [{ rawSse: raw }] })
  try {
    const res = await postOpenAI(mock, { stream: true, messages: [user('x')] })
    assert.equal(await res.text(), raw)
  } finally {
    await mock.close()
  }
})
