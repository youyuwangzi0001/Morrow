/**
 * 协议集成测试：本地 Mock LLM HTTP SSE → Provider → Agent 循环 → 真实工具执行。
 * 这是任务验收里「node 脚本用本地 mock HTTP SSE 跑通一次带工具调用的完整 run」的自动化版本，
 * 并把过程日志写到 tmp/verify/mock-run.log 作为证据。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderConfig, RuntimeEvent } from '../../../src/shared/types'
import { createProvider } from '../../../src/core/providers'
import { resetAllPermissionGrants, runAgent, type RunAgentResult } from '../../../src/core/agent'
import { anthropicTextFrames, anthropicToolFrames, openAITextFrames, openAIToolFrames, startMockLLM, type MockLLM } from './helpers/mock-llm'
import { makeTempWorkspace } from './helpers/workspace'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..', '..')

function providerConfig(id: string, kind: ProviderConfig['kind'], baseUrl: string): ProviderConfig {
  return {
    id,
    kind,
    name: id,
    baseUrl,
    models: [{ id: 'mock-model', label: 'Mock', contextWindow: 8000, maxOutput: 1024, supportsTools: true }],
    apiKeyStored: true,
    enabled: true
  }
}

const servers: MockLLM[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function runWithMock(
  server: MockLLM,
  config: ProviderConfig,
  workspace: string,
  snapshotDir: string,
  systemPrompt: string
): Promise<{ events: RuntimeEvent[]; result: RunAgentResult }> {
  const events: RuntimeEvent[] = []
  const provider = createProvider(config, 'sk-mock', 'mock-model')
  const result = await runAgent({
    runId: 'run_http',
    sessionId: 'session_http',
    provider,
    model: { id: 'mock-model', label: 'Mock', contextWindow: 8000, maxOutput: 1024, supportsTools: true },
    systemPrompt,
    history: [],
    userMessage: { id: 'u1', role: 'user', content: [{ type: 'text', text: '把 note.txt 的内容读出来' }], createdAt: Date.now() },
    workspace,
    permissionMode: 'auto',
    snapshotDir,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onPermission: async () => 'once',
    onAskUser: async () => ({ value: 'a', label: 'A' })
  })
  return { events, result }
}

describe('Mock HTTP SSE：OpenAI 完整 run', () => {
  it('真实 HTTP → Provider → Agent → read_file 工具 → 最终回答', async () => {
    resetAllPermissionGrants()
    const ws = makeTempWorkspace({ 'note.txt': '这是测试内容。' })
    const server = await startMockLLM((request, index) => {
      if (index === 0) {
        // 第一轮：模型决定调用 read_file
        const args = JSON.stringify({ path: 'note.txt' })
        return { frames: openAIToolFrames('call_mock_1', 'read_file', args, { text: '我先读一下文件。', usage: { input: 120, output: 30 } }) }
      }
      // 第二轮：模型看到工具结果，给出最终回答
      return { frames: openAITextFrames('文件内容是「这是测试内容。」。', { usage: { input: 160, output: 25 } }) }
    })
    servers.push(server)
    try {
      const { events, result } = await runWithMock(server, providerConfig('mock-openai', 'openai-compat', server.baseUrl), ws.root, ws.snapshotDir, '你是测试助手。')

      expect(result.reason).toBe('complete')
      expect(result.messages).toHaveLength(2)
      const toolBlock = result.messages[0].content.find((block) => block.type === 'tool_use')
      expect(toolBlock).toMatchObject({ name: 'read_file', status: 'success' })
      if (toolBlock?.type === 'tool_use') expect(toolBlock.result?.output).toContain('这是测试内容。')
      expect(result.usage.inputTokens).toBe(280)
      expect(result.usage.outputTokens).toBe(55)
      // 精确上下文：最后一次请求真实 usage = 160 + 25
      expect(result.usage.contextUsed).toBe(185)
      const usageEvents = events.filter((event) => event.type === 'usage_updated')
      const finishedEvent = events[events.length - 1]
      const lastUsageEvent = usageEvents[usageEvents.length - 1]
      if (lastUsageEvent?.type !== 'usage_updated' || finishedEvent.type !== 'run_finished') throw new Error('事件缺失')
      expect(lastUsageEvent.usage).toEqual(finishedEvent.usage)
      expect(finishedEvent.usage.contextUsed).toBe(185)

      // 第二轮请求确实带上了助手 tool_calls 与 tool 消息
      const secondRequest = server.requests[1].body as {
        messages: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }>
      }
      const assistantWithTools = secondRequest.messages.find((message) => message.role === 'assistant' && message.tool_calls)
      const toolMessage = secondRequest.messages.find((message) => message.role === 'tool')
      expect(assistantWithTools).toBeTruthy()
      expect(toolMessage?.tool_call_id).toBe('call_mock_1')
      // 事件序列完整
      expect(events[0].type).toBe('run_started')
      expect(events[events.length - 1].type).toBe('run_finished')
      expect(events.filter((event) => event.type === 'tool_finished')).toHaveLength(1)

      writeEvidence('openai', server, events, result, 'read_file(note.txt)', toolBlock?.type === 'tool_use' ? (toolBlock.result?.output ?? '') : '')
    } finally {
      ws.cleanup()
    }
  }, 30_000)
})

describe('Mock HTTP SSE：Anthropic 完整 run', () => {
  it('Anthropic SSE → 工具调用 → 文本回答', async () => {
    resetAllPermissionGrants()
    const ws = makeTempWorkspace({ 'data.md': '# 标题\n内容段落' })
    const server = await startMockLLM((request, index) => {
      if (index === 0) {
        return {
          frames: anthropicToolFrames('toolu_mock_1', 'read_file', JSON.stringify({ path: 'data.md' }), {
            text: '我看看这个文件。',
            usage: { input: 90, output: 20 }
          }),
          done: false
        }
      }
      return { frames: anthropicTextFrames('文件里是一个标题和一段内容。', { input: 140, output: 18 }), done: false }
    })
    servers.push(server)
    try {
      const { events, result } = await runWithMock(server, providerConfig('mock-anthropic', 'anthropic', server.baseUrl), ws.root, ws.snapshotDir, '你是测试助手。')
      expect(result.reason).toBe('complete')
      expect(result.messages).toHaveLength(2)
      const toolBlock = result.messages[0].content.find((block) => block.type === 'tool_use')
      expect(toolBlock).toMatchObject({ name: 'read_file', status: 'success' })
      if (toolBlock?.type === 'tool_use') expect(toolBlock.result?.output).toContain('内容段落')

      // 精确上下文：最后一次请求真实 usage = 140 + 18
      expect(result.usage.contextUsed).toBe(158)
      const usageEvents = events.filter((event) => event.type === 'usage_updated')
      const finishedEvent = events[events.length - 1]
      const lastUsageEvent = usageEvents[usageEvents.length - 1]
      if (lastUsageEvent?.type !== 'usage_updated' || finishedEvent.type !== 'run_finished') throw new Error('事件缺失')
      expect(lastUsageEvent.usage).toEqual(finishedEvent.usage)
      expect(finishedEvent.usage.contextUsed).toBe(158)

      const firstRequestBody = server.requests[0].body as { system?: string; stream?: boolean }
      expect(firstRequestBody.system).toContain('你是测试助手')
      expect(firstRequestBody.stream).toBe(true)
      const secondBody = server.requests[1].body as { messages: Array<{ role: string; content: Array<{ type: string }> }> }
      const toolResultBlock = secondBody.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_result')
      expect(toolResultBlock).toBeTruthy()

      writeEvidence('anthropic', server, events, result, 'read_file(data.md)', toolBlock?.type === 'tool_use' ? (toolBlock.result?.output ?? '') : '')
    } finally {
      ws.cleanup()
    }
  }, 30_000)
})

function writeEvidence(
  protocol: string,
  server: MockLLM,
  events: RuntimeEvent[],
  result: RunAgentResult,
  toolCall: string,
  toolOutput: string
): void {
  const dir = join(ROOT, 'tmp', 'verify')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `mock-run-${protocol}.log`)
  const lines = [
    `# Morrow Mock SSE 完整 run（${protocol}）`,
    `time: ${new Date().toISOString()}`,
    `mock server: ${server.baseUrl}`,
    `mock requests: ${server.requests.length}`,
    `run reason: ${result.reason}`,
    `messages: ${result.messages.length}`,
    `tool call: ${toolCall}`,
    `tool output: ${toolOutput.replace(/\s+/g, ' ').slice(0, 200)}`,
    `usage: input=${result.usage.inputTokens} output=${result.usage.outputTokens}`,
    '',
    '## event trace',
    ...events.map((event) => `seq=${event.seq} ${event.type}`),
    ''
  ]
  writeFileSync(file, lines.join('\n'), 'utf8')
  // 顺带断言日志确实写出来了
  expect(readFileSync(file, 'utf8')).toContain('run reason: complete')
}
