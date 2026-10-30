// core-runtime 单元测试：由 4 个原测试文件合并；每个文件保留独立 describe 作用域。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, afterEach } from 'vitest'
import type { AskUserAnswer, ChatMessage, ModelInfo, PermissionDecision, PermissionRequest, RuntimeEvent, ProviderConfig, ToolUseBlock, Goal, ToolCategory } from '../../src/shared/types'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest, ToolDefinition, SwarmMemberRequest, SwarmMemberResult, ToolContext } from '../../src/core/types'
import type { RunAgentOptions, RunAgentResult, PermissionPolicyContext, PermissionTarget } from '../../src/core/agent'
import { compactSession, resetAllPermissionGrants, runAgent, buildSystemPrompt, estimateMessagesTokens, hasDanglingToolUse, applyCompaction, planCompaction, estimateMessageTokens, evaluatePermission, detectOutsidePathInCommand, permissionSignature, BUILTIN_AGENT_ROLES } from '../../src/core/agent'
import { OpenAICompatProvider, ProviderError, AnthropicProvider, testProviderConnection, ToolProtocolProvider, SSEParser, iterateSSE } from '../../src/core/providers'
import type { ScriptStep } from './helpers/scripted-provider'
import { ScriptedProvider, collectEvents } from './helpers/scripted-provider'
import type { TempWorkspace } from './helpers/workspace'
import { makeTempWorkspace } from './helpers/workspace'
import type { MockLLM } from './helpers/mock-llm'
import { anthropicTextFrames, anthropicToolFrames, openAITextFrames, openAIToolFrames, startMockLLM } from './helpers/mock-llm'
import { expectValidAnthropicSequence, expectValidOpenAISequence } from './helpers/compaction-validators'
import { createHash } from 'node:crypto'
import { swarmTool } from '../../src/core/tool-extra'
import { GoalProgressTracker } from '../../src/main/agent'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import * as core from '../../src/core/index'
import { buildOneShotInvocation } from '../../src/core/util'
import { createSafeLookup, createWebFetchTool, fetchWebPage, isBlockedAddress, validatePublicUrl, WebFetchError, WEB_FETCH_LIMITS } from '../../src/core/tool-media'

describe("agent", () => {
beforeEach(() => {
  resetAllPermissionGrants()
})
describe('agent.test.ts', () => {
  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  interface Harness {
    events: RuntimeEvent[]
    provider: Provider
    result: RunAgentResult
    permissionCalls: PermissionRequest[]
    askCalls: number
  }

  async function runScript(
    ws: TempWorkspace,
    steps: ConstructorParameters<typeof ScriptedProvider>[0],
    overrides: Partial<RunAgentOptions> & {
      onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>
      onAskUser?: () => Promise<AskUserAnswer>
    } = {}
  ): Promise<Harness> {
    const events: RuntimeEvent[] = []
    const provider = overrides.provider ?? new ScriptedProvider(steps, { defaultText: '（结束）' })
    const permissionCalls: PermissionRequest[] = []
    let askCalls = 0
    const { onPermission: overridePermission, onAskUser: overrideAskUser, ...rest } = overrides
    const options: RunAgentOptions = {
      runId: 'run_1',
      sessionId: 'session_1',
      provider,
      model: MODEL,
      systemPrompt: '你是 Morrow 测试助手。',
      history: [],
      userMessage: userMessage('帮我处理一下'),
      workspace: ws.root,
      permissionMode: 'auto',
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async (request) => {
        permissionCalls.push(request)
        return overridePermission ? overridePermission(request) : 'once'
      },
      onAskUser: async () => {
        askCalls += 1
        return overrideAskUser ? overrideAskUser() : { value: 'A', label: '方案 A' }
      },
      maxSteps: 20,
      ...rest
    }
    const result = await runAgent(options)
    return { events, provider, result, permissionCalls, askCalls }
  }

  function indexOf(events: RuntimeEvent[], type: RuntimeEvent['type']): number {
    return events.findIndex((event) => event.type === type)
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  describe('Agent 循环：完整一轮（文本 → 工具 → 文本）', () => {
    it('@core:agent 执行工具、回填结果、事件有序、usage 累计', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [
          { text: '我先写一个文件。', toolCalls: [{ name: 'write_file', input: { path: 'hello.txt', content: '你好，Morrow' } }] },
          { text: '文件写好了，请查看。' }
        ])
        const { events, result } = harness
        expect(result.reason).toBe('complete')
        // 文件真实落盘
        expect(readFileSync(join(ws.root, 'hello.txt'), 'utf8')).toBe('你好，Morrow')
        // 消息结构：两条 assistant，第一条 tool_use 已回填
        expect(result.messages).toHaveLength(2)
        const first = result.messages[0]
        const toolBlock = first.content.find((block) => block.type === 'tool_use')
        expect(toolBlock).toMatchObject({ name: 'write_file', status: 'success' })
        if (toolBlock?.type === 'tool_use') {
          expect(toolBlock.result?.ok).toBe(true)
          expect(String(toolBlock.result?.meta?.afterHash)).toMatch(/^[0-9a-f]{64}$/)
        }
        expect(result.messages[1].content[0]).toMatchObject({ type: 'text', text: '文件写好了，请查看。' })
        // 事件顺序
        expect(events[0].type).toBe('run_started')
        expect(events[events.length - 1].type).toBe('run_finished')
        expect(indexOf(events, 'message_started')).toBeLessThan(indexOf(events, 'message_delta'))
        expect(indexOf(events, 'tool_started')).toBeLessThan(indexOf(events, 'tool_finished'))
        expect(indexOf(events, 'tool_progress')).toBeLessThan(indexOf(events, 'tool_finished'))
        // seq 连续、信封字段齐全
        events.forEach((event, index) => {
          expect(event.seq).toBe(index + 1)
          expect(event.runId).toBe('run_1')
          expect(event.sessionId).toBe('session_1')
          expect(typeof event.at).toBe('number')
        })
        // usage 累计两轮请求
        expect(result.usage.inputTokens).toBe(200)
        expect(result.usage.outputTokens).toBe(40)
        expect(result.usage.contextLimit).toBe(128_000)
        const finished = events[events.length - 1]
        expect(finished.type === 'run_finished' && finished.reason).toBe('complete')
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('审批时序', () => {

    it('@core:agent 拒绝审批：不落盘，工具结果 denied 并回灌给模型', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [{ toolCalls: [{ name: 'write_file', input: { path: '../c.txt', content: 'x' } }] }, { text: '那我换个方案。' }],
          { permissionMode: 'ask', onPermission: async () => 'deny' }
        )
        expect(existsSync(join(ws.root, '..', 'c.txt'))).toBe(false)
        expect(harness.result.reason).toBe('complete')
        const toolBlock = harness.result.messages[0].content.find((block) => block.type === 'tool_use')
        expect(toolBlock).toMatchObject({ status: 'denied' })
        if (toolBlock?.type === 'tool_use') expect(toolBlock.result?.error).toContain('文件修改')
        const finished = harness.events.find((event) => event.type === 'tool_finished')
        expect(finished?.type === 'tool_finished' && finished.denied).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('@core:agent 只读模式：写工具直接拒绝，不弹审批', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [{ toolCalls: [{ name: 'write_file', input: { path: 'd.txt', content: 'x' } }] }, { text: '好的' }],
          { permissionMode: 'read-only' }
        )
        expect(harness.permissionCalls).toHaveLength(0)
        expect(harness.events.some((event) => event.type === 'permission_requested')).toBe(false)
        const finished = harness.events.find((event) => event.type === 'tool_finished')
        expect(finished?.type === 'tool_finished' && finished.denied).toBe(true)
        expect(existsSync(join(ws.root, 'd.txt'))).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('中断收尾', () => {
    it('@core:agent 流式过程中中断：assistant 消息带 interrupted 标记，run 以 cancelled 结束', async () => {
      const ws = makeTempWorkspace()
      try {
        const controller = new AbortController()
        const provider: Provider = {
          async *stream() {
            yield { type: 'text_delta', text: '我正在处理' }
            await new Promise((resolve) => setTimeout(resolve, 300))
            yield { type: 'text_delta', text: '继续' }
          }
        }
        const events: RuntimeEvent[] = []
        const promise = runAgent({
          runId: 'run_cancel',
          sessionId: 'session_cancel',
          provider,
          model: MODEL,
          systemPrompt: 's',
          history: [],
          userMessage: userMessage('长任务'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: controller.signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' })
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        controller.abort()
        const result = await promise
        expect(result.reason).toBe('cancelled')
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].interrupted).toBe(true)
        const finished = events[events.length - 1]
        expect(finished.type === 'run_finished' && finished.reason).toBe('cancelled')
        // 同一 id 的 message_completed 会再发一次以带出 interrupted 标记
        const completedEvents = events.filter((event) => event.type === 'message_completed')
        expect(completedEvents.length).toBeGreaterThanOrEqual(1)
        expect(completedEvents[completedEvents.length - 1].type === 'message_completed' && completedEvents[completedEvents.length - 1]).toMatchObject({
          messageId: result.messages[0].id
        })
      } finally {
        ws.cleanup()
      }
    })

    it('@core:agent 等待审批时中断：未完成的 tool_use 回填 interrupted 结果', async () => {
      const ws = makeTempWorkspace()
      try {
        const controller = new AbortController()
        const provider: Provider = {
          async *stream() {
            yield { type: 'tool_call_start', index: 0, id: 'call_pending', name: 'write_file' }
            yield { type: 'tool_call_delta', index: 0, argsDelta: '{"path":"f.txt","content":"x"}' }
            yield { type: 'tool_call_end', index: 0, id: 'call_pending', name: 'write_file', input: { path: '../f.txt', content: 'x' } }
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
          }
        }
        const events: RuntimeEvent[] = []
        let permissionRequested = false
        const promise = runAgent({
          runId: 'run_perm',
          sessionId: 'session_perm',
          provider,
          model: MODEL,
          systemPrompt: 's',
          history: [],
          userMessage: userMessage('写文件'),
          workspace: ws.root,
          permissionMode: 'ask',
          snapshotDir: ws.snapshotDir,
          signal: controller.signal,
          emit: (event) => {
            events.push(event)
            if (event.type === 'permission_requested') {
              permissionRequested = true
              setTimeout(() => controller.abort(), 20)
            }
          },
          onPermission: () => new Promise<PermissionDecision>(() => undefined),
          onAskUser: async () => ({ value: 'a', label: 'A' })
        })
        const result = await promise
        expect(permissionRequested).toBe(true)
        expect(result.reason).toBe('cancelled')
        const toolBlock = result.messages[0].content.find((block) => block.type === 'tool_use')
        expect(toolBlock).toMatchObject({ status: 'interrupted' })
        if (toolBlock?.type === 'tool_use') expect(toolBlock.result?.meta).toMatchObject({ interrupted: true })
        expect(existsSync(join(ws.root, '..', 'f.txt'))).toBe(false)
        // 中断也要发 permission_resolved('deny') 让 UI 收起审批卡
        const resolved = events.find((event) => event.type === 'permission_resolved')
        expect(resolved?.type === 'permission_resolved' && resolved.decision).toBe('deny')
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('停止条件与错误', () => {

    it('@core:agent Provider 抛错：run 以 error 结束并带 error 事件', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [{ error: { message: '模型服务暂时不可用', code: 'server_error', retryable: true } }])
        expect(harness.result.reason).toBe('error')
        expect(harness.result.error?.message).toContain('模型服务暂时不可用')
        expect(harness.events.some((event) => event.type === 'error')).toBe(true)
        expect(harness.result.messages[0].error).toBeTruthy()
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('ask_user / 集群成员 / 状态透传', () => {
    it('@core:agent ask_user 走 question_asked/answered 并回填答案', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [
            {
              toolCalls: [
                {
                  name: 'ask_user',
                  input: { question: '报告要什么风格？', options: [{ label: '正式' }, { label: '轻松' }] }
                }
              ]
            },
            { text: '好的，按正式风格来。' }
          ]
        )
        expect(harness.askCalls).toBe(1)
        expect(harness.events.some((event) => event.type === 'question_asked')).toBe(true)
        expect(harness.events.some((event) => event.type === 'question_answered')).toBe(true)
        const toolBlock = harness.result.messages[0].content.find((block) => block.type === 'tool_use')
        if (toolBlock?.type === 'tool_use') expect(toolBlock.result?.output).toContain('方案 A')
      } finally {
        ws.cleanup()
      }
    })

    it('@core:agent 计划全部完成后仍改文件：自动追加“收尾完善”步骤，不显示虚假的 6/6', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'v1' })
      try {
        const harness = await runScript(
          ws,
          [
            {
              text: '继续优化。',
              toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'v1', new_string: 'v2' } }]
            },
            { text: '好了。' },
            {
              toolCalls: [
                {
                  name: 'todo_write',
                  input: {
                    todos: [
                      { text: '步骤', status: 'completed' },
                      { text: '收尾完善', status: 'completed' }
                    ]
                  }
                }
              ]
            },
            { text: '全部完成。' }
          ],
          { initialTodos: [{ id: 'todo_done', text: '步骤', status: 'completed' }] }
        )
        expect(harness.result.reason).toBe('complete')
        expect(harness.result.todos.map((todo) => todo.text)).toContain('收尾完善')
        expect(harness.events.some((event) => event.type === 'todos_updated')).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('上下文压缩', () => {
    function longHistory(): ChatMessage[] {
      const history: ChatMessage[] = []
      for (let index = 0; index < 20; index += 1) {
        history.push({
          id: `hist-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: '这是一段需要被压缩的长历史内容。'.repeat(120) }],
          createdAt: Date.now()
        })
      }
      return history
    }

    it('@core:context 摘要阶段被中断时新建停止消息，不把历史 assistant 误标为 interrupted', async () => {
      const ws = makeTempWorkspace()
      try {
        const controller = new AbortController()
        const events: RuntimeEvent[] = []
        const provider = new ScriptedProvider([
          { text: '这次摘要会被中断。', delayMs: 1000 },
          { text: '不应到达。' }
        ])
        const running = runAgent({
          runId: 'run_compact_abort',
          sessionId: 'session_compact_abort',
          provider,
          model: { ...MODEL, contextWindow: 2500 },
          systemPrompt: '你是测试助手。',
          history: longHistory(),
          userMessage: userMessage('继续'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: controller.signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' })
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        controller.abort()
        const result = await running
        expect(result.reason).toBe('cancelled')
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].interrupted).toBe(true)
        expect(result.messages[0].content.some((block) => block.type === 'text' && block.text.includes('本轮运行已停止'))).toBe(true)
        expect(events.filter((event) => event.type === 'run_finished')).toHaveLength(1)
      } finally {
        ws.cleanup()
      }
    })

    it('@core:context 摘要模型失败时用本地摘要兜底，对话继续', async () => {
      const ws = makeTempWorkspace()
      try {
        const events: RuntimeEvent[] = []
        const provider = new ScriptedProvider([{ error: { message: '摘要服务挂了' } }, { text: '仍然完成。' }])
        const result = await runAgent({
          runId: 'run_compact_fail',
          sessionId: 'session_compact_fail',
          provider,
          model: { ...MODEL, contextWindow: 2500 },
          systemPrompt: '你是测试助手。',
          history: longHistory(),
          userMessage: userMessage('继续'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' })
        })
        expect(result.reason).toBe('complete')
        const notice = events.find(
          (event) => event.type === 'notice' && event.message.includes('本地摘要')
        )
        expect(notice).toBeTruthy()
        expect(events.some((event) => event.type === 'compaction' && event.phase === 'finished')).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('compactSession（手动 /compact 入口）', () => {
    function historyMessages(): ChatMessage[] {
      const messages: ChatMessage[] = []
      for (let index = 0; index < 16; index += 1) {
        messages.push({
          id: `h-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          // R9：压缩实现要求「省下的 token 为正」，用足够长的历史消息构造可压缩场景
          content: [{ type: 'text', text: `第 ${index} 条历史消息：${'这是一段需要压缩的历史对话内容。'.repeat(20)}` }],
          createdAt: Date.now()
        })
      }
      return messages
    }

    it('@core:context force=true 时调用摘要模型并压缩到 user 边界之后', async () => {
      const provider = new ScriptedProvider([{ text: '用户此前在做销售复盘，已完成数据核对。' }])
      const messages = historyMessages()
      const result = await compactSession({
        provider,
        model: MODEL,
        systemPrompt: '你是测试助手。',
        messages,
        signal: new AbortController().signal,
        force: true
      })
      expect(result.compacted).toBe(true)
      expect(result.messages[0].role).toBe('system')
      expect(result.messages.length).toBeLessThan(messages.length)
      expect(result.summary).toContain('销售复盘')
      expect(result.savedTokens).toBeGreaterThan(0)
      // 摘要请求不应携带工具
      expect(provider.calls[0].tools).toHaveLength(0)
    })
  })

  describe('流式重复工具帧', () => {
    it('@core:agent 同一 tool_call_end 重复出现时只执行一次', async () => {
      const ws = makeTempWorkspace()
      try {
        class DuplicateEndProvider implements Provider {
          private calls = 0
          async *stream(): AsyncGenerator<ProviderStreamEvent> {
            this.calls += 1
            if (this.calls === 1) {
              const end = { type: 'tool_call_end' as const, index: 0, id: 'dup-end', name: 'write_file', input: { path: 'dup.txt', content: 'once' } }
              yield { type: 'tool_call_start', index: 0, id: 'dup-end', name: 'write_file' }
              yield end
              yield end
              yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 6 } }
              return
            }
            yield { type: 'text_delta', text: '完成。' }
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
          }
        }
        const events: RuntimeEvent[] = []
        const result = await runAgent({
          runId: 'run_dup_end',
          sessionId: 'session_dup_end',
          provider: new DuplicateEndProvider(),
          model: MODEL,
          systemPrompt: '你是测试助手。',
          history: [],
          userMessage: { id: 'u-dup', role: 'user', content: [{ type: 'text', text: '写入 dup.txt' }], createdAt: Date.now() },
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'A', label: 'A' }),
          maxSteps: 8
        })
        expect(result.reason).toBe('complete')
        expect(readFileSync(join(ws.root, 'dup.txt'), 'utf8')).toBe('once')
        expect(events.filter((event) => event.type === 'tool_finished')).toHaveLength(1)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('工具参数被截断（max_tokens）的自修复路径', () => {
    it('@core:agent 截断的工具调用转为 error 结果 + hint 回灌，整轮不中断', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [
          {
            toolCalls: [
              {
                name: 'write_file',
                id: 'trunc_1',
                parseError: '模型输出达到长度上限（finish_reason=length），工具参数被截断，不是完整 JSON'
              }
            ]
          },
          { text: '收到，我把内容拆小后重写。' }
        ])
        expect(harness.result.reason).toBe('complete')
        expect(harness.events.some((event) => event.type === 'error')).toBe(false)
        const block = harness.result.messages[0].content.find((item) => item.type === 'tool_use')
        expect(block).toMatchObject({ status: 'error' })
        if (block?.type === 'tool_use') {
          expect(block.result?.ok).toBe(false)
          expect(String(block.result?.hint)).toContain('拆小')
        }
        // 截断的写文件不应真正落盘
        expect(existsSync(join(ws.root, 'hello.txt'))).toBe(false)
        // 第二个回合模型能继续（历史里 tool_use 有 result，消息合法）
        expect(harness.result.messages).toHaveLength(2)
      } finally {
        ws.cleanup()
      }
    })
  })

  /* ── R5：精确上下文用量 + 自动压缩参数 ───────────────────────── */

  describe('精确上下文用量（contextUsed）', () => {
    it('@core:agent 有真实 usage 时 contextUsed = 最近一次请求的 input+output，且 usage_updated 与 run_finished 一致', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [
          { toolCalls: [{ name: 'todo_write', input: { todos: [{ text: '步骤一', status: 'completed' }] } }] },
          { text: '完成。' }
        ])
        // ScriptedProvider 每轮返回 usage input=100 / output=20；两轮共 2 次请求
        expect(harness.result.usage.inputTokens).toBe(200)
        expect(harness.result.usage.outputTokens).toBe(40)
        // contextUsed 应取最后一次请求真实值 100+20，而不是估算
        expect(harness.result.usage.contextUsed).toBe(120)
        const usageEvents = harness.events.filter((event) => event.type === 'usage_updated')
        const finished = harness.events[harness.events.length - 1]
        expect(usageEvents.length).toBeGreaterThan(0)
        const lastUsage = usageEvents[usageEvents.length - 1]
        if (lastUsage.type !== 'usage_updated' || finished.type !== 'run_finished') throw new Error('事件缺失')
        expect(lastUsage.usage).toEqual(finished.usage)
        expect(finished.usage.contextUsed).toBe(120)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('自动压缩参数（autoCompact / compactThreshold / keepRecent）', () => {
    function longHistory(count = 12): ChatMessage[] {
      const history: ChatMessage[] = []
      for (let index = 0; index < count; index += 1) {
        history.push({
          id: `r5-hist-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: '这是一段需要压缩的历史对话内容。'.repeat(25) }],
          createdAt: Date.now()
        })
      }
      return history
    }

    it('@core:context autoCompact=false 时不触发自动压缩（即使超过阈值）', async () => {
      const ws = makeTempWorkspace()
      try {
        const provider = new ScriptedProvider([{ text: '直接回答。' }])
        const result = await runAgent({
          runId: 'run_no_compact',
          sessionId: 'session_no_compact',
          provider,
          model: { ...MODEL, contextWindow: 2500 },
          systemPrompt: '你是测试助手。',
          history: longHistory(),
          userMessage: userMessage('继续'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: () => undefined,
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' }),
          autoCompact: false
        })
        expect(result.reason).toBe('complete')
        // 没有压缩调用（如果压缩会先发一个摘要请求，calls 会 >1 且 tools 为空）
        expect(provider.calls).toHaveLength(1)
        expect(provider.calls[0].tools.length).toBeGreaterThan(0)
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('compaction-agent.test.ts', () => {
  /**
   * R9 / R2-H 端到端机制验证：单用户长工具链在真实 Agent 循环里触发压缩并继续。
   *
   * 场景（对应 R2-H）：
   * - 只有一条用户消息（含「只读 / 不写文件 / 禁止外发」约束）；
   * - 脚本化 provider 通过真实 read_file 工具逐段读取 3 组长文本（value=4/7/9）；
   * - 小上下文窗口（2400）促使 estimate 达到 80% 阈值 → 真实 planCompaction + compactSession 摘要请求；
   * - 压缩后继续一次真实工具调用（读取 notes.txt），再给出最终答案「合计 20」；
   * - 断言：真实触发压缩事件、压缩后 tokens 变短、原始用户约束保留、最近工具结果保留、
   *   无孤立 tool 消息、下一轮请求消息序列合法、最终值来自真实读取。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 2400, supportsTools: true }
  const SYSTEM_PROMPT = '你是 Morrow 测试助手。'

  function textOf(message: ChatMessage): string {
    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  }

  describe('R2-H 单用户长工具链：真实触发压缩并继续', () => {

    it('@core:context 长任务每次达到阈值都会压缩（3 次以上），不会因压缩次数中断', async () => {
      // 压缩回归需要真实的大工具结果；读取文件即可，不必重复启动 12 个 Shell。
      const ws = makeTempWorkspace(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
        `a-${index + 1}.txt`, `value=12\n${'材料内容 '.repeat(2001 + index)}`
      ])))
      try {
        class RepeatedCompactionProvider implements Provider {
          readonly calls: ProviderStreamRequest[] = []
          private reads = 0
          async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
            this.calls.push({ ...request, messages: [...request.messages] })
            if (request.tools.length === 0 && request.system.includes('压缩器')) {
              yield {
                type: 'text_delta',
                text: '摘要：用户要求反复读取同一份材料并统计 value；只读、不写文件。已经读取了若干轮，剩余轮次继续；下一轮继续 read_file a.txt。'
              }
              yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 60 } }
              return
            }
            if (this.reads < 12) {
              const id = `repeat-${this.reads}`
              this.reads += 1
              yield { type: 'tool_call_start', index: 0, id, name: 'read_file' }
              yield { type: 'tool_call_end', index: 0, id, name: 'read_file', input: { path: `a-${this.reads}.txt` } }
              yield { type: 'usage', usage: { inputTokens: 160, outputTokens: 20 } }
              return
            }
            yield { type: 'text_delta', text: '已完成 12 次读取，value=12。' }
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 16 } }
          }
        }
        const events: RuntimeEvent[] = []
        const provider = new RepeatedCompactionProvider()
        const result = await runAgent({
          runId: 'run_repeat_compact',
          sessionId: 'session_repeat_compact',
          provider,
          model: { ...MODEL, contextWindow: 6_000 },
          systemPrompt: SYSTEM_PROMPT,
          history: [],
          userMessage: {
            id: 'u-repeat',
            role: 'user',
            content: [{ type: 'text', text: '反复读取 a-1.txt 到 a-12.txt 这 12 份材料并统计 value；只读，不写文件。' }],
            createdAt: Date.now()
          },
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'A', label: 'A' }),
          maxSteps: 40,
          keepRecent: 2
        })

        const finished = events.filter((event) => event.type === 'compaction' && event.phase === 'finished')
        const folded = events.filter(
          (event) => event.type === 'notice' && event.message.includes('已折叠过大的工具输出')
        )
        // 每次达到阈值都必须处理：优先摘要压缩，摘要不划算时折叠大工具输出
        expect(finished.length + folded.length).toBeGreaterThanOrEqual(3)
        const reads = events.filter((event) => event.type === 'tool_finished')
        expect(reads).toHaveLength(12)
        expect(reads.every((event) => event.type === 'tool_finished' && event.result.ok)).toBe(true)
        expect(events.some((event) => event.type === 'error')).toBe(false)
        expect(result.reason).toBe('complete')
        expect(result.messages.map(textOf).join('\n')).toContain('已完成 12 次读取')
        // 每次压缩后仍保留用户任务锚点与合法消息序列
        const lastMain = [...provider.calls].reverse().find((call) => call.tools.length > 0)
        expect(lastMain?.messages.some((message) => message.role === 'user' && textOf(message).includes('反复读取'))).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('@core:context 上下文溢出不终止任务：自动压缩后重试，且不向用户弹错误', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'ok' })
      try {
        class OverflowOnceProvider implements Provider {
          readonly calls: ProviderStreamRequest[] = []
          private failed = false
          async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
            this.calls.push({ ...request, messages: [...request.messages] })
            if (request.tools.length === 0 && request.system.includes('压缩器')) {
              yield { type: 'text_delta', text: '摘要：用户要求读取 a.txt 并给出结论；只读，不写文件；下一步继续完成任务。' }
              yield { type: 'usage', usage: { inputTokens: 160, outputTokens: 40 } }
              return
            }
            if (!this.failed) {
              this.failed = true
              throw new ProviderError("This model's maximum context length is 2400 tokens. Please reduce the length of the messages.", {
                code: 'context_length_exceeded',
                status: 400
              })
            }
            yield { type: 'text_delta', text: '压缩后继续完成，a.txt 读取成功。' }
            yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 16 } }
          }
        }
        const provider = new OverflowOnceProvider()
        const events: RuntimeEvent[] = []
        const big = '背景材料 '.repeat(60)
        const history: ChatMessage[] = [
          { id: 'h1', role: 'user', content: [{ type: 'text', text: `任务：读取 a.txt 并总结。${big}` }], createdAt: Date.now() },
          { id: 'h2', role: 'assistant', content: [{ type: 'text', text: `先确认任务。${big}` }], createdAt: Date.now() },
          { id: 'h3', role: 'user', content: [{ type: 'text', text: `补充约束：只读，不写文件。${big}` }], createdAt: Date.now() }
        ]
        const result = await runAgent({
          runId: 'run_overflow_once',
          sessionId: 'session_overflow_once',
          provider,
          model: MODEL,
          systemPrompt: SYSTEM_PROMPT,
          history,
          userMessage: { id: 'u-overflow', role: 'user', content: [{ type: 'text', text: '继续完成。' }], createdAt: Date.now() },
          workspace: ws.root,
          permissionMode: 'auto',
          compactThreshold: 0.99,
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'A', label: 'A' }),
          maxSteps: 20,
          keepRecent: 2
        })
        expect(result.reason).toBe('complete')
        expect(events.some((event) => event.type === 'compaction' && event.phase === 'finished')).toBe(true)
        expect(events.some((event) => event.type === 'error')).toBe(false)
        expect(provider.calls.some((call) => call.tools.length === 0 && call.system.includes('压缩器'))).toBe(true)
        expect(result.messages.map(textOf).join('\n')).toContain('压缩后继续完成')
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('compaction.test.ts', () => {
  /**
   * R9 / R2-H：单用户长工具链的安全压缩（planCompaction / applyCompaction 直接验证）。
   *
   * 覆盖：
   * - 单条 user + 多轮 assistant(tool_use+result) 达到阈值时能切分压缩（不再依赖第二条 user 消息）；
   * - 压缩后保留原始用户约束、最近工具结果、剩余状态；token 真实变短；
   * - 不产生孤立 tool_use / tool_result：内部消息与 OpenAI / Anthropic 两种协议序列都合法；
   * - 进行中（tool_use 无 result）时拒绝压缩。
   */

  let idCounter = 0
  const nextId = (prefix: string): string => `${prefix}-${(idCounter += 1)}`

  function userMessage(text: string): ChatMessage {
    return { id: nextId('u'), role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  /** 一条完整的「模型动作 + 工具结果」消息（内部模型 tool_result 内嵌在 tool_use.result） */
  function toolTurn(value: number, padding = 600, options: { dangling?: boolean } = {}): ChatMessage {
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: nextId('call'),
      name: 'read_file',
      title: `读取第 ${value} 组材料`,
      category: 'read',
      input: { path: `in/m${value}.txt` },
      status: options.dangling ? 'running' : 'success'
    }
    if (!options.dangling) {
      block.result = { ok: true, output: `value=${value}\n${'材料内容 '.repeat(padding)}` }
    }
    return {
      id: nextId('a'),
      role: 'assistant',
      content: [{ type: 'text', text: `已读取第 ${value} 组材料。` }, block],
      createdAt: Date.now()
    }
  }

  /** 构造「单用户 + N 轮工具调用」历史 */
  function singleUserLongChain(turns = 12): ChatMessage[] {
    return [
      userMessage('逐段只读三组长文本并合计 value；不写文件、不保存记忆、禁止外发。'),
      ...Array.from({ length: turns }, (_, index) => toolTurn(index + 1))
    ]
  }

  describe('R9 压缩切点（单用户长工具链）', () => {

    it('@core:context 压缩后：保留原始用户约束与最近工具结果，token 变短，两种协议序列都合法', () => {
      const messages = singleUserLongChain(12)
      const plan = planCompaction(messages, '你是压缩测试助手。', 4000, { keepRecent: 4 })
      expect(plan.shouldCompact).toBe(true)
      const compacted = applyCompaction(messages, plan.cutIndex, '摘要：用户要求只读材料并合计 value，禁止外发；已读取部分材料，剩余工作继续。')

      // 结构：摘要 → 原始用户消息 → 保留段
      expect(compacted[0].role).toBe('system')
      expect(compacted[1].role).toBe('user')
      const compactedText = compacted
        .filter((message) => message.role === 'user')
        .map((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
        .join('\n')
      expect(compactedText).toContain('禁止外发')
      expect(compactedText).toContain('只读三组长文本')

      // 最近工具结果仍在保留段里
      const keptOutputs = compacted
        .flatMap((message) => message.content)
        .filter((block): block is ToolUseBlock => block.type === 'tool_use')
        .map((block) => block.result?.output ?? '')
      expect(keptOutputs.some((output) => output.includes('value=12'))).toBe(true)
      expect(hasDanglingToolUse(compacted)).toBe(false)

      // token 真实变短
      const before = estimateMessagesTokens(messages, '你是压缩测试助手。')
      const after = estimateMessagesTokens(compacted, '你是压缩测试助手。')
      expect(after).toBeLessThan(before)

      // 两种 provider 协议下，消息序列都合法（无孤立 tool / 首条 user / 配对完整）
      expectValidOpenAISequence(compacted)
      expectValidAnthropicSequence(compacted)
    })

    it('@core:context 进行中的工具调用（tool_use 无 result）时拒绝压缩，避免压缩出非法请求', () => {
      const messages = [userMessage('读材料'), ...Array.from({ length: 10 }, (_, index) => toolTurn(index + 1)), toolTurn(11, 300, { dangling: true })]
      const plan = planCompaction(messages, '', 2000, { keepRecent: 4 })
      expect(plan.shouldCompact).toBe(false)
      expect(plan.reason).toBe('no-safe-cut')
    })
  })
})
describe('context.test.ts', () => {
  function message(role: ChatMessage['role'], text: string, createdAt = Date.now()): ChatMessage {
    return { id: `${role}-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], createdAt }
  }

  describe('estimateTokens', () => {

    it('@core:context 历史图片计入上下文估算，避免带图会话迟迟不压缩', () => {
      const withImage: ChatMessage = {
        ...message('user', '看这张图'),
        images: [{ mediaType: 'image/png', dataBase64: 'A'.repeat(100), name: 'shot.png' }]
      }
      expect(estimateMessageTokens(withImage)).toBeGreaterThanOrEqual(1100)
      expect(estimateMessageTokens(withImage)).toBeGreaterThan(estimateMessageTokens(message('user', '看这张图')))
    })
  })
})
describe('subagent-interactive.test.ts', () => {
  /**
   * 并行集群成员的交互卡必须串行：一个成员在等待审批时，
   * 另一个成员不能同时弹出审批卡或提问卡（否则后一张会覆盖前一张，任务悬挂）。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 32_000, supportsTools: true }

  class ParallelTaskProvider implements Provider {
    readonly calls: ProviderStreamRequest[] = []
    private parentCalls = 0
    private readonly subSteps = new Map<string, number>()

    async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
      this.calls.push(request)
      if (!request.system.includes('## 集群成员')) {
        this.parentCalls += 1
        if (this.parentCalls === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'swarm-ab', name: 'swarm' }
          yield {
            type: 'tool_call_end',
            index: 0,
            id: 'swarm-ab',
            name: 'swarm',
            input: {
              goal: '并行处理 A/B',
              tasks: [
                { title: '任务 A', prompt: '创建 a.txt，内容为 A' },
                { title: '任务 B', prompt: '先问用户选哪个，再汇报' }
              ]
            }
          }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } }
          return
        }
        yield { type: 'text_delta', text: '两个子任务都已完成。' }
        yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20 } }
        return
      }

      const firstUser = request.messages.find((message) => message.role === 'user')
      const prompt = firstUser?.content.map((block) => (block.type === 'text' ? block.text : '')).join('') ?? ''
      const label = prompt.includes('任务 A') ? 'A' : 'B'
      const step = (this.subSteps.get(label) ?? 0) + 1
      this.subSteps.set(label, step)
      if (step === 1) {
        if (label === 'A') {
          yield { type: 'tool_call_start', index: 0, id: 'write-a', name: 'write_file' }
          yield { type: 'tool_call_end', index: 0, id: 'write-a', name: 'write_file', input: { path: '../a.txt', content: 'A' } }
        } else {
          yield { type: 'tool_call_start', index: 0, id: 'ask-b', name: 'ask_user' }
          yield {
            type: 'tool_call_end',
            index: 0,
            id: 'ask-b',
            name: 'ask_user',
            input: { question: '成员 B 需要你选择', options: ['甲', '乙'] }
          }
        }
        yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } }
        return
      }
      yield { type: 'text_delta', text: `子任务 ${label} 完成` }
      yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 16 } }
    }
  }

  function textOf(message: ChatMessage): string {
    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  }

  describe('并行集群成员交互串行', () => {
    it('@core:swarm 审批卡与提问卡不会同时出现，两个成员都能完成且拥有完整工具', async () => {
      const ws = makeTempWorkspace()
      try {
        const provider = new ParallelTaskProvider()
        const events: RuntimeEvent[] = []
        let open = 0
        let maxOpen = 0
        const track = (delta: number): void => {
          open += delta
          maxOpen = Math.max(maxOpen, open)
        }
        const result = await runAgent({
          runId: 'run_parallel_swarm_members',
          sessionId: 'session_parallel_swarm_members',
          provider,
          model: MODEL,
          systemPrompt: '你是并行集群协作测试助手。',
          history: [],
          userMessage: { id: 'u-parallel', role: 'user', content: [{ type: 'text', text: '并行派两个子任务。' }], createdAt: Date.now() },
          workspace: ws.root,
          permissionMode: 'ask',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => {
            events.push(event)
            if (event.type === 'permission_requested' || event.type === 'question_asked') track(1)
            if (event.type === 'permission_resolved' || event.type === 'question_answered') track(-1)
          },
          onPermission: async () => {
            await new Promise((resolve) => setTimeout(resolve, 35))
            return 'once'
          },
          onAskUser: async () => {
            await new Promise((resolve) => setTimeout(resolve, 35))
            return { value: '甲', label: '甲' }
          },
          maxSteps: 8
        })

        expect(result.reason).toBe('complete')
        expect(events.filter((event) => event.type === 'permission_requested')).toHaveLength(1)
        expect(events.filter((event) => event.type === 'permission_resolved')).toHaveLength(1)
        expect(events.filter((event) => event.type === 'question_asked')).toHaveLength(1)
        expect(events.filter((event) => event.type === 'question_answered')).toHaveLength(1)
        expect(maxOpen, '同时打开了两张交互卡').toBe(1)
        expect(open).toBe(0)
        expect(existsSync(join(ws.root, '..', 'a.txt'))).toBe(true)

        const swarmBlocks = result.messages
          .flatMap((message) => message.content)
          .filter((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === 'swarm')
        expect(swarmBlocks).toHaveLength(1)
        expect(swarmBlocks[0]?.result?.ok).toBe(true)
        const swarmMeta = swarmBlocks[0]?.result?.meta as { tasks?: Array<{ status: string }> } | undefined
        expect(swarmMeta?.tasks?.map((task) => task.status)).toEqual(['completed', 'completed'])
        expect(result.messages.map(textOf).join('\n')).toContain('两个子任务都已完成')

        const memberCalls = provider.calls.filter((call) => call.system.includes('## 集群成员'))
        const memberTools = new Set(memberCalls.flatMap((call) => call.tools.map((tool) => tool.name)))
        expect(memberTools.has('swarm')).toBe(false)
        expect(memberTools.has('update_goal')).toBe(false)
        expect(memberTools.has('todo_write')).toBe(false)
        for (const name of ['write_file', 'edit_file', 'run_command', 'terminal', 'mcp_call']) {
          expect(memberTools.has(name), name).toBe(true)
        }
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('cluster-swarm.test.ts', () => {
  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 32_000, supportsTools: true }

  it('@core:swarm auto 父任务：单个集群成员拥有完整工作区权限，写入直接生效并登记 changedFiles', async () => {
    const ws = makeTempWorkspace()
    try {
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            {
              name: 'swarm',
              input: { goal: '写文件', tasks: [{ title: '写文件', prompt: '创建 out.txt，内容为 ok' }] }
            }
          ]
        },
        { toolCalls: [{ name: 'write_file', input: { path: 'out.txt', content: 'ok' } }] },
        { text: '成员完成。' },
        { text: '主代理完成。' }
      ])
      const events: RuntimeEvent[] = []
      const result = await runAgent({
        runId: 'run_swarm_full_access',
        sessionId: 'session_swarm_full_access',
        provider,
        model: MODEL,
        systemPrompt: '你是集群协作测试助手。',
        history: [],
        userMessage: { id: 'u-swarm', role: 'user', content: [{ type: 'text', text: '派一个成员写文件。' }], createdAt: Date.now() },
        workspace: ws.root,
        permissionMode: 'auto',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        onPermission: async () => {
          throw new Error('auto 模式不应弹出审批')
        },
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        maxSteps: 10
      })
      expect(result.reason).toBe('complete')
      expect(readFileSync(join(ws.root, 'out.txt'), 'utf8')).toBe('ok')
      const swarmBlock = result.messages
        .flatMap((message) => message.content)
        .find((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === 'swarm')
      expect(swarmBlock?.result?.ok).toBe(true)
      const meta = swarmBlock?.result?.meta as { changedFiles?: Array<{ absolutePath?: string }> } | undefined
      expect(meta?.changedFiles?.some((file) => String(file.absolutePath).endsWith('out.txt'))).toBe(true)
      const memberCall = provider.calls.find((call) => call.system.includes('## 集群成员'))
      const memberTools = new Set(memberCall?.tools.map((tool) => tool.name) ?? [])
      for (const name of ['write_file', 'edit_file', 'run_command', 'terminal', 'mcp_call', 'browser_open']) {
        expect(memberTools.has(name), name).toBe(true)
      }
      // 角色管分工、技能管方法：成员提示词必须给出边界与冲突时的取舍
      expect(memberCall?.system).toContain('## 角色与技能的关系')
      expect(memberCall?.system).toContain('角色分工与安全边界 > 技能里的方法细节')
      expect(memberCall?.system).toContain('技能与角色/任务的边界或验收冲突时')
      expect(events.some((event) => event.type === 'permission_requested')).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 只读父任务不能启动集群，成员不能获得比主代理更高的权限', async () => {
    const ws = makeTempWorkspace()
    try {
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            {
              name: 'swarm',
              input: { goal: '写文件', tasks: [{ title: '写文件', prompt: '创建 out.txt' }] }
            }
          ]
        },
        { text: '只读模式不能启动集群。' }
      ])
      const result = await runAgent({
        runId: 'run_swarm_readonly',
        sessionId: 'session_swarm_readonly',
        provider,
        model: MODEL,
        systemPrompt: '你是集群协作测试助手。',
        history: [],
        userMessage: { id: 'u-swarm-ro', role: 'user', content: [{ type: 'text', text: '派成员写文件。' }], createdAt: Date.now() },
        workspace: ws.root,
        permissionMode: 'read-only',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: () => undefined,
        onPermission: async () => 'once',
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        maxSteps: 10
      })
      expect(result.reason).toBe('complete')
      expect(existsSync(join(ws.root, 'out.txt'))).toBe(false)
      const swarmBlock = result.messages
        .flatMap((message) => message.content)
        .find((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === 'swarm')
      expect(swarmBlock?.result?.ok).toBe(false)
      expect(swarmBlock?.result?.error).toContain('只读上下文')
      expect(provider.calls.some((call) => call.system.includes('## 集群成员'))).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 集群成员不再有 12 步上限：长任务可以持续执行到给出结论', async () => {
    const ws = makeTempWorkspace({ 'a.txt': 'value=12\n' })
    try {
      class LongMemberProvider implements Provider {
        readonly calls: ProviderStreamRequest[] = []
        private parentCalls = 0
        private memberSteps = 0
        async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
          this.calls.push({ ...request, messages: [...request.messages] })
          if (!request.system.includes('## 集群成员')) {
            this.parentCalls += 1
            if (this.parentCalls === 1) {
              yield { type: 'tool_call_start', index: 0, id: 'task-long', name: 'swarm' }
              yield {
                type: 'tool_call_end',
                index: 0,
                id: 'task-long',
                name: 'swarm',
                input: { goal: '长任务', tasks: [{ title: '长任务', prompt: '反复读取 a.txt 15 次，统计 value，然后给出结论。' }] }
              }
              yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 20 } }
              return
            }
            yield { type: 'text_delta', text: '成员长任务完成。' }
            yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } }
            return
          }
          this.memberSteps += 1
          if (this.memberSteps <= 15) {
            const id = `member-read-${this.memberSteps}`
            yield { type: 'tool_call_start', index: 0, id, name: 'read_file' }
            yield { type: 'tool_call_end', index: 0, id, name: 'read_file', input: { path: 'a.txt', offset: this.memberSteps } }
            yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
            return
          }
          yield { type: 'text_delta', text: '已读取 15 次，value=12，任务完成。' }
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12 } }
        }
      }
      const provider = new LongMemberProvider()
      const result = await runAgent({
        runId: 'run_long_member',
        sessionId: 'session_long_member',
        provider,
        model: MODEL,
        systemPrompt: '你是集群协作测试助手。',
        history: [],
        userMessage: { id: 'u-long-member', role: 'user', content: [{ type: 'text', text: '派一个成员完成长任务。' }], createdAt: Date.now() },
        workspace: ws.root,
        permissionMode: 'auto',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: () => undefined,
        onPermission: async () => 'once',
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        maxSteps: 10
      })
      expect(result.reason).toBe('complete')
      const swarmBlock = result.messages
        .flatMap((message) => message.content)
        .find((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === 'swarm')
      expect(swarmBlock?.result?.ok).toBe(true)
      const meta = swarmBlock?.result?.meta as { tasks?: Array<{ status: string; steps?: number }> } | undefined
      expect(meta?.tasks?.[0]?.status).toBe('completed')
      expect(meta?.tasks?.[0]?.steps ?? 0).toBeGreaterThan(12)
      expect(JSON.stringify(swarmBlock?.result)).not.toContain('最大步数')
    } finally {
      ws.cleanup()
    }
  })
})
})

describe("goal", () => {
beforeEach(() => {
  resetAllPermissionGrants()
})
describe('goal.test.ts', () => {
  /**
   * R6 Goal 模式内核测试：
   * - 目标系统提示段（goal active 注入、非 active 不注入、主进程自带 prompt 时补段）；
   * - 工具列表按模式注入 update_goal；
   * - update_goal 工具的 active/completed/blocked 合并与 goal_updated 事件；
   * - 非法输入、非目标模式防御；不影响审批（meta 不弹审批）；
   * - max-steps 收尾请求仍可 update_goal。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function makeGoal(overrides: Partial<Goal> = {}): Goal {
    const now = Date.now()
    return {
      id: 'goal_1',
      objective: '分三轮完成一份竞品调研报告，每轮推进一个阶段',
      status: 'active',
      round: 2,
      maxRounds: 5,
      summary: '上一轮完成了竞品名单收集',
      nextStep: '整理竞品功能对比表',
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      ...overrides
    }
  }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  interface GoalRun {
    events: RuntimeEvent[]
    provider: ScriptedProvider
    result: Awaited<ReturnType<typeof runAgent>>
  }

  async function runGoalScript(
    ws: TempWorkspace,
    steps: ConstructorParameters<typeof ScriptedProvider>[0],
    goal: Goal | null | undefined,
    overrides: Partial<RunAgentOptions> = {}
  ): Promise<GoalRun> {
    const events: RuntimeEvent[] = []
    const provider = new ScriptedProvider(steps, { defaultText: '（结束）' })
    const result = await runAgent({
      runId: 'run_goal_test',
      sessionId: 'session_goal_test',
      provider,
      model: MODEL,
      systemPrompt: '你是 Morrow 测试助手。',
      history: [],
      userMessage: userMessage('继续推进目标'),
      workspace: ws.root,
      permissionMode: 'ask',
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async () => 'once',
      onAskUser: async () => ({ value: 'a', label: 'A' }),
      maxSteps: 20,
      ...(goal === undefined ? {} : { goal }),
      ...overrides
    })
    return { events, provider, result }
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  describe('update_goal 工具行为', () => {

    it('@core:goals completed：设置 completedAt，并清掉 nextStep/blockedReason（R7 起必须带可核验 evidence）', async () => {
      const ws = makeTempWorkspace({ 'out/report.md': '# 竞品报告\n正文' })
      try {
        const { events, result } = await runGoalScript(
          ws,
          [
            {
              toolCalls: [
                {
                  name: 'update_goal',
                  input: { status: 'completed', summary: '报告已生成并自检通过', evidence: ['out/report.md'] }
                }
              ]
            },
            { text: '目标完成。' }
          ],
          makeGoal({ nextStep: '还差一步' })
        )
        const updatedEvent = events.find((event) => event.type === 'goal_updated')
        const updatedGoal = updatedEvent?.type === 'goal_updated' ? updatedEvent.goal : null
        expect(updatedGoal?.status).toBe('completed')
        expect(updatedGoal?.completedAt).toEqual(expect.any(Number))
        expect(updatedGoal?.nextStep).toBeUndefined()
        expect(updatedGoal?.evidence).toContain('out/report.md')
        expect(result.goal?.status).toBe('completed')
      } finally {
        ws.cleanup()
      }
    })

    it('@core:goals completed 缺证据或证据不存在：拒绝标记完成，状态保持 active', async () => {
      const ws = makeTempWorkspace({ 'out/real.md': 'real' })
      try {
        const { events, result } = await runGoalScript(
          ws,
          [
            {
              toolCalls: [
                { name: 'update_goal', input: { status: 'completed', summary: '我说完成了' } },
                {
                  name: 'update_goal',
                  input: { status: 'completed', summary: '证据不存在', evidence: ['out/missing.md'] }
                }
              ]
            },
            { text: '结束' }
          ],
          makeGoal()
        )
        expect(result.goal?.status).toBe('active')
        expect(events.some((event) => event.type === 'goal_updated')).toBe(false)
        const blocks = result.messages[0].content.filter((item) => item.type === 'tool_use')
        expect(blocks.length).toBe(2)
        for (const block of blocks) {
          expect(block).toMatchObject({ name: 'update_goal', status: 'error' })
          if (block.type === 'tool_use') {
            // 第一条：缺 evidence；第二条：evidence 路径不存在
            expect(`${block.result?.error ?? ''}${block.result?.hint ?? ''}`).toMatch(/evidence|证据/)
          }
        }
      } finally {
        ws.cleanup()
      }
    })

    it('@core:goals blocked：记录 blockedReason；缺 blockedReason 时返回可读错误且不发事件', async () => {
      const ws = makeTempWorkspace()
      try {
        const blocked = await runGoalScript(
          ws,
          [
            {
              toolCalls: [
                { name: 'update_goal', input: { status: 'blocked', blockedReason: '缺少用户提供的竞品价格表' } }
              ]
            },
            { text: '已阻塞。' }
          ],
          makeGoal()
        )
        const event = blocked.events.find((item) => item.type === 'goal_updated')
        const blockedGoal = event?.type === 'goal_updated' ? event.goal : null
        expect(blockedGoal?.blockedReason).toBe('缺少用户提供的竞品价格表')
        expect(blocked.result.goal?.blockedReason).toBe('缺少用户提供的竞品价格表')

        const missingReason = await runGoalScript(
          ws,
          [
            { toolCalls: [{ name: 'update_goal', input: { status: 'blocked' } }] },
            { text: '我来说明阻塞原因。' }
          ],
          makeGoal()
        )
        expect(missingReason.result.reason).toBe('complete')
        const failedBlock = missingReason.result.messages[0].content.find((item) => item.type === 'tool_use')
        expect(failedBlock).toMatchObject({ status: 'error' })
        if (failedBlock?.type === 'tool_use') expect(failedBlock.result?.error).toContain('blockedReason')
        expect(missingReason.events.some((item) => item.type === 'goal_updated')).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('mode.test.ts', () => {
  /**
   * R8 #5 显式「聊天 / 工作」模式 —— 内核测试。
   *
   * 覆盖审计报告第 5 项的验收点：
   * 1) 聊天模式系统提示：明确「只讨论、不执行」、只列只读工具、Goal 段不注入；
   * 2) 工具白名单：只读工具 + ask_user；写入/执行/记忆/目标/计划/集群成员一律不可用；
   * 3) 权限层硬拦截：即使 permission=auto，chat 下 write_file / run_command / remember 也 denied，
   *    **工具不会真正执行**、文件与命令产物不变（不是只靠提示词）；
   * 4) 主进程自带 systemPrompt 缺聊天段时由内核补上（防止绕过）；
   * 5) 工作模式回归：原有 auto 写文件行为不变；
   * 6) 聊天模式下即使误传 active Goal，也不注入 update_goal / 目标提示段。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  interface ScriptRun {
    events: RuntimeEvent[]
    provider: ScriptedProvider
    result: Awaited<ReturnType<typeof runAgent>>
  }

  async function runScript(
    ws: TempWorkspace,
    steps: ScriptStep[],
    overrides: Partial<RunAgentOptions> = {}
  ): Promise<ScriptRun> {
    const events: RuntimeEvent[] = []
    const provider = new ScriptedProvider(steps, { defaultText: '（结束）' })
    const result = await runAgent({
      runId: 'run_mode_test',
      sessionId: 'session_mode_test',
      provider,
      model: MODEL,
      systemPrompt: '你是 Morrow 测试助手。',
      history: [],
      userMessage: userMessage('帮我改一下文件'),
      workspace: ws.root,
      permissionMode: 'ask',
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async () => 'once',
      onAskUser: async () => ({ value: 'A', label: 'A' }),
      maxSteps: 20,
      ...overrides
    })
    return { events, provider, result }
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  /* ── 4. Agent 端到端（脚本化 Provider 强制发起写入/执行） ─────── */

  describe('聊天模式 Agent 端到端', () => {
    it('@core:modes 模型硬发 write_file + run_command：工具全部 denied、文件与命令产物均未产生、助手解释需切模式', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'hello' })
      try {
        const run = await runScript(
          ws,
          [
            {
              text: '我来改文件。',
              toolCalls: [
                { name: 'write_file', input: { path: 'chat-write.txt', content: 'CHAT' } },
                { name: 'run_command', input: { command: 'Set-Content chat-cmd.txt CHAT' } }
              ]
            },
            { text: '当前是聊天模式，我不能直接改文件或跑命令；请切到工作模式后我再执行。' }
          ],
          { mode: 'chat', permissionMode: 'auto' }
        )

        expect(run.result.reason).toBe('complete')
        // 没有弹审批：聊天模式是直接拒绝，不是「问用户要不要写」
        expect(run.events.filter((event) => event.type === 'permission_requested')).toEqual([])

        const finished = run.events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool_finished' }> => event.type === 'tool_finished'
        )
        expect(finished.length).toBe(2)
        for (const event of finished) {
          expect(event.denied).toBe(true)
          expect(event.result.ok).toBe(false)
          expect(event.result.error).toContain('聊天模式')
        }

        // 工具确实没有执行：文件/命令产物都不存在
        expect(existsSync(join(ws.root, 'chat-write.txt'))).toBe(false)
        expect(existsSync(join(ws.root, 'chat-cmd.txt'))).toBe(false)
        expect(readFileSync(join(ws.root, 'a.txt'), 'utf8')).toBe('hello')

        const assistantText = run.result.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
        expect(assistantText).toContain('聊天模式')
        expect(assistantText).toContain('工作模式')
        // 工具结果回填后模型还有第二次请求（证明 denied 结果回了模型，而不是静默跳过）
        expect(run.provider.calls.length).toBeGreaterThanOrEqual(2)
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('plan-mode.test.ts', () => {
  /**
   * P0-2 计划模式 —— 内核验收：
   * 1) 工具白名单：只读 + ask_user/todo_write/submit_plan，写入/执行/记忆/集群成员/目标一律不暴露；
   * 2) 即使模型强行调用写入工具，权限层也只读拒绝（不是只靠提示词）；
   * 3) submit_plan 生成 pending 计划、plan_updated 事件与 Markdown 产物；
   * 4) 计划模式可带历史 goal 运行，但不会注入目标段/update_goal；
   * 5) 非计划模式不能提交计划。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  function makeGoal(): Goal {
    const now = Date.now()
    return {
      id: 'goal_plan_1',
      objective: '完成一份报告',
      status: 'active',
      round: 1,
      maxRounds: 5,
      createdAt: now - 60_000,
      updatedAt: now - 30_000
    }
  }

  interface ScriptRun {
    events: RuntimeEvent[]
    provider: ScriptedProvider
    result: Awaited<ReturnType<typeof runAgent>>
  }

  async function runScript(
    ws: TempWorkspace,
    steps: ScriptStep[],
    overrides: Partial<RunAgentOptions> = {}
  ): Promise<ScriptRun> {
    const events: RuntimeEvent[] = []
    const provider = new ScriptedProvider(steps, { defaultText: '（结束）' })
    const result = await runAgent({
      runId: 'run_plan_test',
      sessionId: 'session_plan_test',
      provider,
      model: MODEL,
      systemPrompt: '你是 Morrow 测试助手。',
      history: [],
      userMessage: userMessage('帮我整理这个季度的销售数据'),
      workspace: ws.root,
      permissionMode: 'ask',
      planMode: true,
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async () => 'once',
      onAskUser: async () => ({ value: 'A', label: 'A' }),
      maxSteps: 20,
      ...overrides
    })
    return { events, provider, result }
  }

  function toolNames(run: ScriptRun, index = 0): string[] {
    return run.provider.calls[index].tools.map((tool) => tool.name).sort()
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  describe('plan mode tool surface', () => {
    it('@core:modes exposes only read-only + planning tools and injects the plan prompt', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'a,b\n1,2\n' })
      try {
        const run = await runScript(ws, [{ text: '我先看看工作区。' }], { goal: makeGoal() })
        const names = toolNames(run)
        expect(names).toEqual(
          expect.arrayContaining(['list_dir', 'glob', 'grep', 'read_file', 'ask_user', 'todo_write', 'submit_plan'])
        )
        expect(names).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'run_command', 'swarm', 'remember', 'update_goal', 'web_fetch', 'mcp_call', 'terminal']))
        expect(run.provider.calls[0].system).toContain('## 计划模式')
        expect(run.provider.calls[0].system).toContain('submit_plan')
        // 计划模式不注入 Goal 段，即使会话里曾有 active 目标
        expect(run.provider.calls[0].system).not.toContain('## 目标模式')
        expect(run.result.planMode).toBe(true)
        expect(run.result.plan).toBeNull()
      } finally {
        ws.cleanup()
      }
    })

    it('@core:modes refuses writes at the permission layer even if the model calls write_file', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'a,b\n1,2\n' })
      try {
        const run = await runScript(ws, [
          {
            text: '',
            toolCalls: [
              {
                name: 'write_file',
                input: { path: 'out/should-not-exist.txt', content: 'should not be written' }
              }
            ]
          },
          { text: '计划模式下不能写入。' }
        ])
        expect(existsSync(join(ws.root, 'out', 'should-not-exist.txt'))).toBe(false)
        const tool = run.result.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_use')
        expect(tool?.type).toBe('tool_use')
        if (tool?.type === 'tool_use') {
          expect(tool.status).toBe('denied')
          expect(tool.result?.ok).toBe(false)
        }
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('submit_plan', () => {
    it('@core:modes records a pending plan, emits plan_updated and registers a Markdown artifact', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'month,amount\n1,100\n' })
      try {
        const run = await runScript(ws, [
          {
            text: '已核对数据，计划如下。',
            toolCalls: [
              {
                name: 'submit_plan',
                input: {
                  title: '整理 Q3 销售并生成报告',
                  summary: '读取 in/sales.csv，核对总额，生成可直接分享的 HTML 报告。',
                  steps: [
                    { text: '读取 in/sales.csv 并核对总销售额' },
                    { text: '按月份汇总并检查异常值' },
                    { text: '生成 out/report.html 并在画布打开' }
                  ],
                  risks: '如果 CSV 缺少月份列，需要先向用户确认口径。'
                }
              }
            ]
          },
          { text: '计划已就绪，等待你的批准。' }
        ])

        const plan = run.result.plan
        expect(plan).not.toBeNull()
        expect(plan?.status).toBe('pending')
        expect(plan?.title).toBe('整理 Q3 销售并生成报告')
        expect(plan?.steps.map((step) => step.text)).toHaveLength(3)
        expect(plan?.risks).toContain('缺少月份列')

        const planEvent = run.events.find((event) => event.type === 'plan_updated')
        expect(planEvent?.type).toBe('plan_updated')
        if (planEvent?.type === 'plan_updated') {
          expect(planEvent.planMode).toBe(true)
          expect(planEvent.plan?.status).toBe('pending')
        }

        const artifact = run.result.artifacts.find((item) => item.title.startsWith('计划：'))
        expect(artifact?.kind).toBe('markdown')
        expect(artifact?.content).toContain('## 执行步骤')
        expect(artifact?.content).toContain('1. 读取 in/sales.csv')
        expect(plan?.artifactId).toBe(artifact?.id)

        // 提交计划不等于执行：工作区不应出现任何产物
        expect(existsSync(join(ws.root, 'out', 'report.html'))).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('goal-progress.test.ts', () => {
  /**
   * R9 / R2-D、R2-F、R2-G：Goal 用量合并（不重复记账）与真实进展追踪。
   * 直接测试 main/services/goal-budget.ts 的纯函数（不 import electron）。
   */

  function sha(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  describe('R2-F：空操作 / 重复写入 / 旧文件不算真实进展', () => {
    it('@core:goals 同一路径重复写相同内容只算一次进展；换内容才算新进展', () => {
      const ws = makeTempWorkspace()
      try {
        const goalCreatedAt = Date.now()
        const file = join(ws.root, 'checkpoint.txt')
        const tracker = new GoalProgressTracker({ existingKeys: [] })
        writeFileSync(file, 'step-1')
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'checkpoint.txt' },
            ok: true,
            resultMeta: { absolutePath: file, afterHash: sha('step-1') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(true)
        // 重复写相同 checkpoint → 不算进展
        writeFileSync(file, 'step-1')
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'checkpoint.txt' },
            ok: true,
            resultMeta: { absolutePath: file, afterHash: sha('step-1') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
        // 真新内容 → 进展
        writeFileSync(file, 'step-2')
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'checkpoint.txt' },
            ok: true,
            resultMeta: { absolutePath: file, afterHash: sha('step-2') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('R2-G：新 XLSX/DOCX 与本地 MCP 成果必须被计为进展', () => {

    it('@core:goals 持久化恢复后不会重复计数（重启/暂停/续跑）', () => {
      const ws = makeTempWorkspace()
      try {
        const goalCreatedAt = Date.now()
        const file = join(ws.root, 'out/report.html')
        mkdirSync(join(ws.root, 'out'), { recursive: true })
        writeFileSync(file, '<html>done</html>')
        const first = new GoalProgressTracker()
        expect(
          first.observe({
            toolName: 'write_file',
            input: {},
            ok: true,
            resultMeta: { absolutePath: file },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(true)
        const restored = new GoalProgressTracker({ existingKeys: first.toKeys() })
        expect(
          restored.observe({
            toolName: 'write_file',
            input: {},
            ok: true,
            resultMeta: { absolutePath: file },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('answer-style.test.ts', () => {
  describe('全局回答风格', () => {

    it('@core:interface 系统提示词接入全局风格，只出现当前选择的规则', () => {
      const concise = buildSystemPrompt({ answerStyle: 'concise' })
      expect(concise).toContain('## 回答风格（全局偏好）')
      expect(concise).toContain('当前风格：简洁')
      expect(concise).toContain('1–3 句')
      expect(concise).not.toContain('当前风格：讲解')

      const custom = buildSystemPrompt({
        answerStyle: 'custom',
        answerStyleCustom: '每段不超过三句，先给风险。'
      })
      expect(custom).toContain('当前风格：自定义')
      expect(custom).toContain('每段不超过三句，先给风险。')

      const fallback = buildSystemPrompt({})
      expect(fallback).toContain('当前风格：平衡')
    })
  })
})
})

describe("model-budget", () => {
  it('@core:interface 系统提示不再注入全局无限 token 声明', () => {
    const prompt = buildSystemPrompt({})
    expect(prompt).not.toContain('无限的token')
    expect(prompt).toContain('视频模型只生成画面与纯器乐配乐')
    expect(prompt).toContain('字幕只做外挂 SRT/ASS，绝不烧录进画面')
  })
})

describe("providers", () => {
beforeEach(() => {
  resetAllPermissionGrants()
})
describe('providers.test.ts', () => {
  function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      id: 'mock',
      kind: 'openai-compat',
      name: 'Mock',
      baseUrl: 'http://127.0.0.1:1',
      models: [{ id: 'mock-model', label: 'Mock', contextWindow: 8000, supportsTools: true }],
      apiKeyStored: false,
      enabled: true,
      ...overrides
    }
  }

  function userMessage(text: string): ChatMessage {
    return { id: 'u1', role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  const servsers: MockLLM[] = []
  async function serve(handler: Parameters<typeof startMockLLM>[0]): Promise<MockLLM> {
    const server = await startMockLLM(handler)
    servsers.push(server)
    return server
  }
  afterEach(async () => {
    await Promise.all(servsers.splice(0).map((server) => server.close()))
  })

  describe('OpenAI 兼容协议', () => {
    it('@core:providers 流式文本 + reasoning_content + usage', async () => {
      const server = await serve(() => ({
        frames: [
          { choices: [{ index: 0, delta: { reasoning_content: '先想一下' } }] },
          ...openAITextFrames('你好，我是 Morrow', { usage: { input: 12, output: 8 } })
        ]
      }))
      const provider = new OpenAICompatProvider(config({ baseUrl: server.baseUrl }), 'sk-test', 'mock-model', { retryDelays: [1, 1, 1] })
      const events = await collectEvents(provider.stream({ system: '你是助手', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
      const text = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')
      const thinking = events.filter((e) => e.type === 'thinking_delta').map((e) => (e.type === 'thinking_delta' ? e.text : '')).join('')
      expect(text).toBe('你好，我是 Morrow')
      expect(thinking).toBe('先想一下')
      const usage = events.find((e) => e.type === 'usage')
      expect(usage?.type === 'usage' && usage.usage).toMatchObject({ inputTokens: 12, outputTokens: 8 })

      const body = server.requests[0].body as Record<string, unknown>
      expect(server.requests[0].path).toBe('/v1/chat/completions')
      expect(server.requests[0].headers.authorization).toBe('Bearer sk-test')
      expect(body.model).toBe('mock-model')
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
      expect((body.messages as Array<{ role: string }>)[0].role).toBe('system')
    })

    it('@core:providers 工具调用增量拼接成完整 input', async () => {
      const args = JSON.stringify({ path: 'a.txt', content: '你好世界' })
      const server = await serve(() => ({ frames: openAIToolFrames('call_1', 'write_file', args, { usage: { input: 20, output: 10 } }) }))
      const provider = new OpenAICompatProvider(config({ baseUrl: server.baseUrl }), 'k', 'm', { retryDelays: [1] })
      const events = await collectEvents(provider.stream({ system: '', messages: [userMessage('写文件')], tools: [], signal: new AbortController().signal }))
      const end = events.find((e) => e.type === 'tool_call_end')
      expect(end?.type === 'tool_call_end' && end).toMatchObject({
        id: 'call_1',
        name: 'write_file',
        input: { path: 'a.txt', content: '你好世界' }
      })
      expect(events.filter((e) => e.type === 'tool_call_start')).toHaveLength(1)
    })

    it('@core:providers 429 自动退避重试并发出 notice', async () => {
      let attempts = 0
      const server = await serve(() => {
        attempts += 1
        if (attempts <= 2) return { status: 429, body: JSON.stringify({ error: { message: 'rate limited' } }) }
        return { frames: openAITextFrames('ok') }
      })
      const provider = new OpenAICompatProvider(config({ baseUrl: server.baseUrl }), 'k', 'm', { retryDelays: [1, 1, 1] })
      const events = await collectEvents(provider.stream({ system: '', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
      expect(server.requests).toHaveLength(3)
      expect(events.filter((e) => e.type === 'notice')).toHaveLength(2)
      expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    })
  })

  describe('Anthropic 协议', () => {
    it('@core:providers 流式文本 + usage + 正确请求头与路径', async () => {
      const server = await serve(() => ({ frames: anthropicTextFrames('你好，我是 Claude', { input: 33, output: 12 }), done: false }))
      const provider = new AnthropicProvider(config({ id: 'anthropic', kind: 'anthropic', baseUrl: server.baseUrl }), 'sk-ant', 'claude-test')
      const events = await collectEvents(provider.stream({ system: '你是助手', messages: [userMessage('hi')], tools: [], signal: new AbortController().signal }))
      expect(server.requests[0].path).toBe('/v1/messages')
      expect(server.requests[0].headers['x-api-key']).toBe('sk-ant')
      expect(server.requests[0].headers['anthropic-version']).toBe('2023-06-01')
      const text = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')
      expect(text).toBe('你好，我是 Claude')
      const usages = events.filter((e) => e.type === 'usage')
      expect(usages.length).toBeGreaterThan(0)
      const last = usages[usages.length - 1]
      expect(last.type === 'usage' && last.usage).toMatchObject({ inputTokens: 33, outputTokens: 12 })
    })

    it('@core:providers 工具调用：content_block_start + input_json_delta 拼接', async () => {
      const args = JSON.stringify({ path: '报告.md', content: '# 标题' })
      const server = await serve(() => ({ frames: anthropicToolFrames('toolu_1', 'write_file', args), done: false }))
      const provider = new AnthropicProvider(config({ id: 'anthropic', kind: 'anthropic', baseUrl: server.baseUrl }), 'sk-ant', 'claude-test')
      const events = await collectEvents(provider.stream({ system: '', messages: [userMessage('写报告')], tools: [], signal: new AbortController().signal }))
      const end = events.find((e) => e.type === 'tool_call_end')
      expect(end?.type === 'tool_call_end' && end).toMatchObject({ id: 'toolu_1', name: 'write_file', input: { path: '报告.md', content: '# 标题' } })
    })
  })

  describe('createProvider / testProviderConnection', () => {

    it('@core:providers 连接成功返回延迟与人话', async () => {
      const server = await serve(() => ({ frames: openAITextFrames('你好') }))
      const result = await testProviderConnection(config({ baseUrl: server.baseUrl }), 'sk-test', 'mock-model', { timeoutMs: 5000 })
      expect(result.ok).toBe(true)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      expect(result.message).toContain('连接成功')
    })

    it('@core:providers 401 返回可读失败信息', async () => {
      const server = await serve(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }))
      const result = await testProviderConnection(config({ baseUrl: server.baseUrl }), 'sk-test', 'mock-model', { timeoutMs: 5000 })
      expect(result.ok).toBe(false)
      expect(result.message).toContain('API Key')
    })
  })
})
describe('protocol-provider.test.ts', () => {
  function request(tools: string[]): ProviderStreamRequest {
    const definitions: ToolDefinition[] = tools.map((name) => ({
      name,
      description: '',
      parameters: { type: 'object', properties: {} },
      category: 'read',
      risk: 'low',
      titleFor: () => name
    }))
    return {
      system: '',
      messages: [],
      tools: definitions,
      signal: new AbortController().signal
    }
  }

  function fakeProvider(events: ProviderStreamEvent[]): Provider {
    return {
      async *stream() {
        for (const event of events) yield event
      }
    }
  }

  async function collect(provider: Provider, req: ProviderStreamRequest): Promise<ProviderStreamEvent[]> {
    const events: ProviderStreamEvent[] = []
    for await (const event of provider.stream(req)) events.push(event)
    return events
  }

  describe('Provider 协议归一化包装层', () => {
    it('@core:providers 把正文里的文本工具协议还原成标准工具事件', async () => {
      const text = `<|tool_calls_section_begin|>
<|tool_call_begin|>functions.edit_file:0<|tool_call_argument_begin|>{"path":"a.html"}<|tool_call_end|>
<|tool_calls_section_end|>`
      const provider = new ToolProtocolProvider(
        fakeProvider([
          { type: 'text_delta', text: '先改文件。' },
          ...Array.from(text).map((char) => ({ type: 'text_delta' as const, text: char }))
        ])
      )
      const events = await collect(provider, request(['edit_file']))
      expect(events.filter((event) => event.type === 'text_delta').map((event) => event.text).join('')).toBe('先改文件。')
      const end = events.find((event) => event.type === 'tool_call_end')
      expect(end).toMatchObject({ type: 'tool_call_end', name: 'edit_file', input: { path: 'a.html' } })
    })

    it('@core:providers 结构化 tool_calls 存在时不重复执行文本协议', async () => {
      const provider = new ToolProtocolProvider(
        fakeProvider([
          { type: 'text_delta', text: '<tool_call>{"name":"edit_file","arguments":{"path":"a.html"}}</tool_call>' },
          { type: 'tool_call_start', index: 0, id: 'call_1', name: 'edit_file' },
          { type: 'tool_call_end', index: 0, id: 'call_1', name: 'edit_file', input: { path: 'a.html' } }
        ])
      )
      const events = await collect(provider, request(['edit_file']))
      expect(events.filter((event) => event.type === 'tool_call_end')).toHaveLength(1)
      expect(events.some((event) => event.type === 'text_delta' && event.text.includes('tool_call'))).toBe(false)
    })
  })
})
describe('sse.test.ts', () => {

  describe('SSEParser', () => {

    it('@core:providers CRLF 被 chunk 边界切开时不会丢帧', () => {
      const parser = new SSEParser()
      expect(parser.push('data: hello\r')).toEqual([])
      expect(parser.push('\n\r')).toEqual([])
      expect(parser.push('\ndata: world\r\n\r\n').map((frame) => frame.data)).toEqual(['hello', 'world'])
    })
  })

  describe('iterateSSE', () => {

    it('@core:providers 流长时间没有新数据时按空闲超时中断，并释放底层迭代器', async () => {
      let returned = 0
      const stalled: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<string>>(() => undefined),
          return: async () => {
            returned += 1
            return { done: true as const, value: undefined }
          }
        })
      }
      const consume = async (): Promise<number> => {
        let count = 0
        for await (const _frame of iterateSSE(stalled, 20)) count += 1
        return count
      }
      await expect(consume()).rejects.toThrow(/没有数据，已中断/)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(returned).toBe(1)
    })
  })
})
describe('index.test.ts', () => {
  /**
   * 公共出口契约测试：主进程只会 import src/core/index.ts，
   * 这里逐个确认 Lead 集成契约里要求的导出都存在且形状正确。
   */

  describe('src/core/index 公共出口契约', () => {

    it('@core:interface TOOL_DEFINITIONS 覆盖全部内置工具且 schema 完整', () => {
      const names = core.TOOL_DEFINITIONS.map((tool) => tool.name)
      expect(names).toEqual([
        'read_file',
        'write_file',
        'edit_file',
        'delete_file',
        'list_dir',
        'move_file',
        'copy_file',
        'make_dir',
        'read_pdf',
        'read_docx',
        'edit_docx',
        'read_xlsx',
        'write_xlsx',
        'read_pptx',
        'glob',
        'grep',
        'run_command',
        'list_skills',
        'read_skill',
        'todo_write',
        'ask_user',
        'remember',
        'swarm',
        'open_artifact',
        'web_search',
        'web_fetch',
        'terminal',
        'mcp_list',
        'mcp_call',
        'mcp_resources',
        'mcp_prompt',
        'browser_open',
        'browser_click',
        'browser_type',
        'browser_read',
        'browser_screenshot',
        'browser_back',
        'browser_forward',
        'browser_reload',
        'browser_scroll',
        'browser_close',
        'computer_screenshot',
        'computer_click',
        'computer_type',
        'computer_key',
        'generate_image',
        'generate_video',
        'generate_film',
        'render_animation',
        'edit_media',
        'inspect_media',
        'describe_media',
        'media_status',
        'list_local_models',
        'manage_local_model',
        'manage_local_engine',
        'run_local_model',
        'studio_project',
        'studio_create',
        'studio_blueprint',
        'studio_write',
        'studio_storyboard',
        'studio_media',
        'studio_timeline',
        'studio_edit',
        'studio_review',
        'studio_render',
        'studio_export'
      ])
      for (const tool of core.TOOL_DEFINITIONS) {
        expect(tool.description.length).toBeGreaterThan(10)
        expect(tool.parameters).toMatchObject({ type: 'object' })
        expect(['read', 'write', 'exec', 'meta']).toContain(tool.category)
        expect(typeof tool.titleFor).toBe('function')
        expect(tool.titleFor({ path: 'a.txt', command: 'ls' })).toBeTruthy()
      }
      // write_file 支持 append 分段写入（大产物分步写）
      const writeFileDef = core.TOOL_DEFINITIONS.find((tool) => tool.name === 'write_file')
      expect(writeFileDef?.parameters).toMatchObject({ type: 'object', properties: { append: { type: 'boolean' } } })
      expect(writeFileDef?.titleFor({ path: 'a.html', append: true })).toContain('追加')

      // 集群成员只读工具集
      expect(core.READ_ONLY_TOOL_DEFINITIONS.every((tool) => tool.category === 'read')).toBe(true)
      expect(core.READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
        'read_file',
        'list_dir',
        'read_pdf',
        'read_docx',
        'read_xlsx',
        'read_pptx',
        'glob',
        'grep',
        'list_skills',
        'read_skill',
        'inspect_media',
        'describe_media',
        'media_status',
        'list_local_models',
        'studio_project',
        'studio_review'
      ])
    })
  })
})
describe('permissions.test.ts', () => {
  function target(toolName: string, category: ToolCategory, input: Record<string, unknown> = {}): PermissionTarget {
    return { toolName, category, baseRisk: category === 'read' ? 'low' : category === 'meta' ? 'low' : 'medium', input, title: toolName }
  }

  function policy(workspace: string | null, mode: PermissionPolicyContext['mode'], grants: string[] = []): PermissionPolicyContext {
    return { mode, workspace, isDemo: false, sessionGrants: new Set(grants) }
  }

  describe('命令中的工作区外绝对路径', () => {
    const ws = makeTempWorkspace({ 'a.txt': 'hello' })
    try {

      it('@core:permissions 询问模式下命令引用工作区外路径提升为高风险审批', () => {
        const gate = evaluatePermission(target('run_command', 'exec', { command: 'Get-Content C:\\Windows\\win.ini' }), policy(ws.root, 'ask'))
        expect(gate.action).toBe('ask')
        if (gate.action === 'ask') {
          expect(gate.risk).toBe('high')
          expect(gate.summary).toContain('当前文件夹以外')
        }
      })

      it('@core:permissions R11：UNC、常见 Unix 系统目录、$HOME 与 ~ 仍识别为越界', () => {
        expect(detectOutsidePathInCommand(String.raw`Get-Content \\server\share\secret.txt`, ws.root)).toBeTruthy()
        expect(detectOutsidePathInCommand('cat /usr/local/bin/tool', ws.root)).toBe('/usr/local/bin/tool')
        expect(detectOutsidePathInCommand('cat /bin/sh', ws.root)).toBe('/bin/sh')
        expect(detectOutsidePathInCommand('cd ~; Get-ChildItem', ws.root)).toContain('~')
        expect(detectOutsidePathInCommand('Get-Content $HOME/.config/app.json', ws.root)).toContain('环境变量')
        expect(detectOutsidePathInCommand('Get-Content ${env:USERPROFILE}\\secret.txt', ws.root)).toContain('环境变量')
        expect(detectOutsidePathInCommand('Get-Content %HOMEPATH%\\secret.txt', ws.root)).toContain('环境变量')
        expect(detectOutsidePathInCommand('Get-Content %USERPROFILE:~0,8%\\secret.txt', ws.root)).toContain('环境变量')
        const uncGate = evaluatePermission(
          target('run_command', 'exec', { command: String.raw`Get-Content \\server\share\secret.txt` }),
          policy(ws.root, 'ask')
        )
        expect(uncGate.action).toBe('ask')
        if (uncGate.action === 'ask') expect(uncGate.risk).toBe('high')
      })
    } finally {
      ws.cleanup()
    }
  })

  describe('外部动作工具（web_fetch / mcp_call）', () => {
    const ws = makeTempWorkspace({ 'a.txt': 'hello' })

    it('@core:permissions 只读模式直接 deny（不联网、不启动外部进程）', () => {
      expect(evaluatePermission(target('web_fetch', 'exec', { url: 'https://example.com/a' }), policy(ws.root, 'read-only')).action).toBe('deny')
      expect(evaluatePermission(target('mcp_list', 'exec', { server: 's' }), policy(ws.root, 'read-only')).action).toBe('deny')
      expect(evaluatePermission(target('mcp_call', 'exec', { server: 's', tool: 't', arguments: {} }), policy(ws.root, 'read-only')).action).toBe('deny')
    })

    it('@core:permissions 询问模式逐次审批：web_fetch 可按站点记住，MCP 不提供「始终允许」', () => {
      const web = target('web_fetch', 'exec', { url: 'https://example.com/a' })
      const list = target('mcp_list', 'exec', { server: 's' })
      const mcp = target('mcp_call', 'exec', { server: 's', tool: 't', arguments: { x: 1 } })
      const webGate = evaluatePermission(web, policy(ws.root, 'ask'))
      expect(webGate.action).toBe('ask')
      if (webGate.action === 'ask') expect(webGate.allowAlways).toBe(true)
      for (const gate of [
        evaluatePermission(list, policy(ws.root, 'ask')),
        evaluatePermission(mcp, policy(ws.root, 'ask'))
      ]) {
        expect(gate.action).toBe('ask')
        if (gate.action === 'ask') expect(gate.allowAlways).toBe(false)
      }
    })
  })

  describe('evaluatePermission：三档模式', () => {
    const ws = makeTempWorkspace({ 'a.txt': 'hello' })
    try {

      it('@core:permissions ask：工作区内写文件与普通命令直接执行（旧自动体验）', () => {
        expect(
          evaluatePermission(target('write_file', 'write', { path: 'a.txt', content: 'hello world' }), policy(ws.root, 'ask'))
        ).toEqual({ action: 'allow' })
        expect(evaluatePermission(target('run_command', 'exec', { command: 'npm run test:unit' }), policy(ws.root, 'ask'))).toEqual({
          action: 'allow'
        })
      })

      it('@core:permissions auto：危险命令也直接执行（完全访问）', () => {
        expect(
          evaluatePermission(target('run_command', 'exec', { command: 'Remove-Item C:\\ -Recurse -Force' }), policy(ws.root, 'auto'))
        ).toEqual({ action: 'allow' })
      })

      it('@core:permissions ask：危险命令仍然强询问（高风险，不提供始终允许）', () => {
        const gate = evaluatePermission(target('run_command', 'exec', { command: 'Remove-Item C:\\ -Recurse -Force' }), policy(ws.root, 'ask'))
        expect(gate.action).toBe('ask')
        if (gate.action === 'ask') {
          expect(gate.risk).toBe('high')
          expect(gate.summary).toContain('高风险')
          expect(gate.allowAlways).toBe(false)
        }
        const signature = permissionSignature(target('run_command', 'exec', { command: 'shutdown /s' }), policy(ws.root, 'ask'))
        expect(evaluatePermission(target('run_command', 'exec', { command: 'shutdown /s' }), policy(ws.root, 'ask', [signature])).action).toBe(
          'ask'
        )
      })

      it('@core:permissions read-only：写文件 / 运行命令 / remember 一律直接拒绝（不进入询问）', () => {
        const readonly = policy(ws.root, 'read-only')
        expect(evaluatePermission(target('write_file', 'write', { path: 'a.txt', content: 'x' }), readonly).action).toBe('deny')
        expect(evaluatePermission(target('run_command', 'exec', { command: 'Get-Date' }), readonly).action).toBe('deny')
        // remember 是 meta 但有写盘副作用，只读模式必须拒绝
        expect(evaluatePermission(target('remember', 'meta', { text: '记住偏好' }), readonly).action).toBe('deny')
        // 越界写在只读模式也是拒绝，而不是询问
        const escapeWrite = evaluatePermission(
          target('write_file', 'write', { path: `${ws.root}/../outside.txt`, content: 'x' }),
          readonly
        )
        expect(escapeWrite.action).toBe('deny')
      })
    } finally {
      ws.cleanup()
    }
  })

  describe('工作区越界', () => {
    const ws = makeTempWorkspace({ 'a.txt': 'hello' })
    try {
      it('@core:permissions 完全访问下工作区外路径直接执行，询问模式仍审批', () => {
        const outside = ws.root.includes('\\') ? `${ws.root}\\..\\..\\outside.txt` : `${ws.root}/../../outside.txt`
        expect(evaluatePermission(target('read_file', 'read', { path: outside }), policy(ws.root, 'auto'))).toEqual({
          action: 'allow',
          escape: true
        })
        const gate = evaluatePermission(target('read_file', 'read', { path: outside }), policy(ws.root, 'ask'))
        expect(gate.action).toBe('ask')
        if (gate.action === 'ask') {
          expect(gate.risk).toBe('high')
          expect(gate.escape).toBe(true)
          expect(gate.allowAlways).toBe(false)
          expect(gate.preview?.kind).toBe('path')
        }
      })

      it('@core:permissions edit_docx 的输入或输出任一越界都要审批', () => {
        const outsideOutput = evaluatePermission(
          target('edit_docx', 'write', { path: 'in/template.docx', output_path: '../outside.docx' }),
          policy(ws.root, 'ask')
        )
        expect(outsideOutput.action).toBe('ask')
        if (outsideOutput.action === 'ask') expect(outsideOutput.escape).toBe(true)

        const outsideInput = evaluatePermission(
          target('edit_docx', 'write', { path: '../outside.docx', output_path: 'out/ok.docx' }),
          policy(ws.root, 'ask')
        )
        expect(outsideInput.action).toBe('ask')
        if (outsideInput.action === 'ask') expect(outsideInput.escape).toBe(true)

        expect(
          evaluatePermission(target('edit_docx', 'write', { path: '../outside.docx', output_path: 'out/ok.docx' }), policy(ws.root, 'auto'))
        ).toEqual({ action: 'allow', escape: true })
      })
    } finally {
      ws.cleanup()
    }
  })

  describe('terminal 权限', () => {
    it('@core:permissions stdin 写入：询问模式逐次确认，完全访问直接执行', () => {
      const ws = makeTempWorkspace()
      try {
        expect(
          evaluatePermission(target('terminal', 'exec', { action: 'write', id: 'task_1', data: 'rm -rf /\n' }), policy(ws.root, 'auto'))
        ).toEqual({ action: 'allow' })
        const gate = evaluatePermission(
          target('terminal', 'exec', { action: 'write', id: 'task_1', data: 'rm -rf /\n' }),
          policy(ws.root, 'ask')
        )
        expect(gate.action).toBe('ask')
        if (gate.action === 'ask') {
          expect(gate.risk).toBe('high')
          expect(gate.allowAlways).toBe(false)
          expect(gate.preview?.content).toContain('rm -rf /')
        }
      } finally {
        ws.cleanup()
      }
    })
  })
})
describe('permissions-doc-auth.test.ts', () => {
  /**
   * R9 / R2-A：Office 文档写工具的审批签名必须绑定「路径 + 内容/替换参数」。
   * R12 权限档位调整后，工作区内写入在「询问」档直接执行；签名仍用于记录/规则，
   * 不能变成跨路径/跨内容的通用通行证。
   */

  function target(toolName: string, input: Record<string, unknown>): PermissionTarget {
    return { toolName, category: 'write', baseRisk: 'medium', input, title: toolName }
  }

  function policy(workspace: string, mode: PermissionPolicyContext['mode']): PermissionPolicyContext {
    return { mode, workspace, isDemo: false, sessionGrants: new Set() }
  }

  describe('R2-A：write_xlsx 审批签名绑定路径与内容', () => {
    const ws = makeTempWorkspace()
    const base = {
      path: 'out/approved.xlsx',
      sheets: [{ name: 'S', rows: [['A1', 'APPROVED']] }]
    }
    try {
      it('@core:permissions 同路径同内容签名稳定；换路径/换内容签名不同', () => {
        const first = permissionSignature(target('write_xlsx', base), policy(ws.root, 'ask'))
        expect(permissionSignature(target('write_xlsx', { ...base }), policy(ws.root, 'ask'))).toBe(first)
        const otherPath = permissionSignature(
          target('write_xlsx', { ...base, path: 'out/other.xlsx' }),
          policy(ws.root, 'ask')
        )
        expect(otherPath).not.toBe(first)
        const otherContent = permissionSignature(
          target('write_xlsx', { ...base, sheets: [{ name: 'S', rows: [['A1', 'UNAPPROVED']] }] }),
          policy(ws.root, 'ask')
        )
        expect(otherContent).not.toBe(first)
        expect(first).not.toContain('default')
        expect(first.replace(/\\/g, '/')).toContain('out/approved.xlsx'.toLowerCase())
      })
    } finally {
      ws.cleanup()
    }
  })
})
describe('shell.test.ts', () => {
  describe('one-shot shell invocation', () => {

    it('@core:terminal Git Bash and WSL use POSIX login shells', () => {
      const gitbash = buildOneShotInvocation(
        { id: 'gitbash', label: 'Git Bash', file: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        'printf ok'
      )
      expect(gitbash.args).toEqual(['-lc', 'printf ok'])
      const wsl = buildOneShotInvocation({ id: 'wsl', label: 'WSL', file: 'wsl.exe' }, 'uname -a')
      expect(wsl.args).toEqual(['-e', 'sh', '-lc', 'uname -a'])
    })
  })
})
describe('swarm.test.ts', () => {
  /**
   * Swarm：多角色并行子任务。
   * 验证角色解析、并行派发、部分失败不伪装完成、task 单任务角色。
   */

  function makeCtx(runSwarmMember: (request: SwarmMemberRequest) => Promise<SwarmMemberResult>): ToolContext {
    return {
      sessionId: 's',
      runId: 'r',
      messageId: 'm',
      toolUseId: 't',
      workspace: null,
      permissionMode: 'auto',
      snapshotDir: '',
      signal: new AbortController().signal,
      depth: 0,
      readOnly: false,
      escapeApproved: false,
      demo: false,
      goal: null,
      planMode: false,
      getPlan: () => null,
      proposePlan: (plan) => plan,
      emit: () => undefined,
      updateGoal: () => null,
      getTodos: () => [],
      setTodos: () => undefined,
      getArtifacts: () => [],
      addArtifact: () => undefined,
      askUser: async () => ({ value: 'A', label: 'A' }),
      progress: () => undefined,
      runSwarmMember,
      agents: BUILTIN_AGENT_ROLES
    }
  }

  const usage = { inputTokens: 0, outputTokens: 0 }

  describe('swarm', () => {
    it('@core:swarm 并行派发不同角色，返回每个子任务摘要', async () => {
      const seen: SwarmMemberRequest[] = []
      const ctx = makeCtx(async (request) => {
        seen.push(request)
        return { status: 'completed', summary: `${request.role?.name}:${request.description}`, steps: 2, usage }
      })
      const result = await swarmTool.execute(
        {
          goal: '并行检查',
          tasks: [
            { title: '找入口', prompt: '定位启动文件', agent: 'explore' },
            { title: '审查鉴权', prompt: '检查权限边界', agent: 'review' }
          ]
        },
        ctx
      )
      expect(result.ok).toBe(true)
      expect(seen.map((request) => request.role?.name).sort()).toEqual(['explore', 'review'])
      expect(seen.every((request) => request.prompt.startsWith('【总目标】并行检查'))).toBe(true)
      expect(result.output).toContain('2/2 个完成')
      expect(result.output).toContain('找入口')
      expect(result.meta).toMatchObject({ completed: 2, failed: 0 })
    })

    it('@core:swarm 任一子任务未完成时返回错误，不伪装全部完成', async () => {
      let index = 0
      const ctx = makeCtx(async (request) => {
        index += 1
        return index === 1
          ? { status: 'completed', summary: '完成 A', steps: 1, usage }
          : { status: 'failed', summary: '部分结果', steps: 1, usage, error: '模型超时' }
      })
      const result = await swarmTool.execute(
        {
          goal: '并行检查',
          tasks: [
            { title: 'A', prompt: '任务 A', agent: 'explore' },
            { title: 'B', prompt: '任务 B', agent: 'test' }
          ]
        },
        ctx
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('1/2')
      expect(result.output).toContain('完成 A')
      expect(result.output).toContain('模型超时')
      expect(result.meta).toMatchObject({ completed: 1, failed: 1 })
    })
  })
})
describe('web-tools.test.ts', () => {
  /**
   * R8 外部工具 · web_fetch（离线验证，不依赖公网）：
   * - SSRF 防护：协议白名单、本地/内网 IPv4/IPv6、DNS 解析后再校验、重定向逐跳校验；
   * - 抓取行为：超时、大小上限、重定向次数、404/二进制错误、HTML→可读文本；
   * - 工具层：schema 只允许 GET 读取（无 method/headers/body）、成功/失败文案、meta。
   *
   * 用本机 127.0.0.1 上的 fixture HTTP server 验证真实网络路径；
   * 生产默认禁止内网，测试通过 allowPrivateNetwork 显式放行（仅 createWebFetchTool 的测试注入）。
   */

  /* ── 本地 HTTP fixture ─────────────────────────────────────────── */

  interface FixtureServer {
    url: string
    requests: Array<{ method: string; url: string; headers: IncomingMessage['headers'] }>
    close: () => Promise<void>
  }

  const servers: FixtureServer[] = []

  async function startFixture(): Promise<FixtureServer> {
    const sockets = new Set<Socket>()
    const requests: FixtureServer['requests'] = []
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
      const path = (req.url ?? '/').split('?')[0]
      switch (path) {
        case '/ok': {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            '<!doctype html><html><head><title>Aurora 价格公告</title>' +
              '<meta name="description" content="官方定价页面">' +
              '<style>.x{color:red}</style><script>alert("should-not-appear")</script></head>' +
              '<body><nav>导航链接</nav><main><h1>Basic 方案</h1>' +
              '<p>2026-03-01 起：USD&nbsp;25 / 月 &amp; 含税。</p>' +
              '<ul><li>第一项</li><li>第二项</li></ul></main>' +
              '<footer>页脚</footer></body></html>'
          )
          return
        }
        case '/plain': {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('纯文本内容 line-1\nline-2')
          return
        }
        case '/go': {
          res.writeHead(302, { Location: '/ok' })
          res.end()
          return
        }
        case '/loop': {
          res.writeHead(302, { Location: '/loop' })
          res.end()
          return
        }
        case '/to-file': {
          res.writeHead(302, { Location: 'file:///C:/Windows/win.ini' })
          res.end()
          return
        }
        case '/big': {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.write('B'.repeat(WEB_FETCH_LIMITS.maxBytes + 32 * 1024))
          res.end()
          return
        }
        case '/slow': {
          // 故意不响应：验证客户端超时后主动断开
          return
        }
        case '/binary': {
          res.writeHead(200, { 'Content-Type': 'image/png' })
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
          return
        }
        case '/huge-title': {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<html><head><title>${'T'.repeat(5000)}</title>` +
              `<meta name="description" content="${'D'.repeat(5000)}"></head>` +
              '<body><p>正文</p></body></html>'
          )
          return
        }
        case '/missing': {
          res.writeHead(404, { 'Content-Type': 'text/html' })
          res.end('<h1>not found</h1>')
          return
        }
        case '/boom': {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('server error')
          return
        }
        default: {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('no fixture')
        }
      }
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server 未监听端口')
    const fixture: FixtureServer = {
      url: `http://127.0.0.1:${address.port}`,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolve())
        })
    }
    servers.push(fixture)
    return fixture
  }

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()
      if (server) await server.close()
    }
  })

  /* ── ToolContext stub ─────────────────────────────────────────── */

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 'session_web',
      runId: 'run_web',
      messageId: 'msg_web',
      toolUseId: 'tool_web',
      workspace: null,
      permissionMode: 'ask',
      snapshotDir: '',
      signal: new AbortController().signal,
      depth: 0,
      readOnly: false,
      escapeApproved: false,
      demo: false,
      goal: null,
      planMode: false,
      getPlan: () => null,
      proposePlan: (plan) => plan,
      emit: () => undefined,
      updateGoal: () => null,
      getTodos: () => [],
      setTodos: () => undefined,
      getArtifacts: () => [],
      addArtifact: () => undefined,
      askUser: async () => ({ value: 'A', label: 'A' }),
      progress: () => undefined,
      runSwarmMember: async () => ({ status: 'completed', summary: '', steps: 0, usage: { inputTokens: 0, outputTokens: 0 } }),
      ...overrides
    }
  }

  /* ── HTML → 可读文本 ──────────────────────────────────────────── */

  describe('createSafeLookup', () => {

    it('@core:web fails closed when every resolved address is private', async () => {
      const lookup = createSafeLookup(async () => [{ address: '127.0.0.1', family: 4 }])
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        ;(lookup as unknown as (host: string, opts: unknown, cb: unknown) => void)(
          'rebind.example',
          { all: true },
          (err: NodeJS.ErrnoException | null) => resolve(err as NodeJS.ErrnoException)
        )
      })
      expect(error.code).toBe('SSRF_BLOCKED')
    })
  })

  /* ── SSRF：地址判断 ───────────────────────────────────────────── */

  describe('isBlockedAddress / validatePublicUrl 的 SSRF 防护', () => {
    it('@core:web 拦截内网/本地/保留 IPv4 地址', () => {
      const blocked = [
        '127.0.0.1',
        '127.255.255.254',
        '0.0.0.0',
        '10.0.0.8',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '192.0.2.10',
        '198.18.0.1',
        '224.0.0.1',
        '240.0.0.1',
        '255.255.255.255'
      ]
      for (const address of blocked) {
        expect(isBlockedAddress(address), address).toBe(true)
      }
      // 172.15 / 172.32 在外网段，不能误伤
      expect(isBlockedAddress('172.15.0.1')).toBe(false)
      expect(isBlockedAddress('172.32.0.1')).toBe(false)
      expect(isBlockedAddress('93.184.216.34')).toBe(false)
      expect(isBlockedAddress('8.8.8.8')).toBe(false)
    })

    it('@core:web 拦截 IPv6 本地/link-local/ULA/multicast 与 IPv4-mapped 内网', () => {
      const blocked = ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1']
      for (const address of blocked) {
        expect(isBlockedAddress(address), address).toBe(true)
      }
      expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false)
      expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
    })

    it('@core:web DNS 解析到内网地址时拒绝（解析后再校验一次）', async () => {
      const resolveHost = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '10.1.2.3', family: 4 }]
      const error = (await validatePublicUrl('http://totally-public.example/', { resolveHost }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
      expect(error).toBeInstanceOf(WebFetchError)
      expect(error.kind).toBe('ssrf-blocked')
      expect(error.message).toContain('内网')

      const ok = await validatePublicUrl('http://totally-public.example/', {
        resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
      })
      expect(ok.hostname).toBe('totally-public.example')
    })
  })

  /* ── 抓取行为（本地 fixture，真实 HTTP 路径） ─────────────────── */

  describe('fetchWebPage（本地 HTTP fixture）', () => {
    it('@core:web 抓取 HTML：标题/正文清洗、最终 URL、状态码、内容类型与耗时', async () => {
      const fixture = await startFixture()
      const result = await fetchWebPage(`${fixture.url}/ok`, { allowPrivateNetwork: true })
      expect(result.status).toBe(200)
      expect(result.finalUrl).toBe(`${fixture.url}/ok`)
      expect(result.contentType).toContain('text/html')
      expect(result.title).toBe('Aurora 价格公告')
      expect(result.text).toContain('USD 25 / 月')
      expect(result.text).toContain('第一项')
      expect(result.text).not.toContain('should-not-appear')
      expect(result.text).not.toContain('导航链接')
      expect(result.bytesRead).toBeGreaterThan(0)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
      // 只发 GET，不带请求体/自定义头
      expect(fixture.requests).toHaveLength(1)
      expect(fixture.requests[0].method).toBe('GET')
      expect(fixture.requests[0].headers['user-agent']).toContain('Morrow')
    })

    it('@core:web 重定向到 file:// 被拒绝（逐跳校验协议）', async () => {
      const fixture = await startFixture()
      const error = (await fetchWebPage(`${fixture.url}/to-file`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
      expect(error).toBeInstanceOf(WebFetchError)
      expect(error.kind).toBe('invalid-url')
    })

    it('@core:web 404 / 500 返回可理解的失败（不把错误页当证据）', async () => {
      const fixture = await startFixture()
      const notFound = (await fetchWebPage(`${fixture.url}/missing`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
      expect(notFound).toBeInstanceOf(WebFetchError)
      expect(notFound.kind).toBe('http-status')
      expect(notFound.message).toContain('404')

      const boom = (await fetchWebPage(`${fixture.url}/boom`, { allowPrivateNetwork: true }).catch((err: unknown) => err as WebFetchError)) as WebFetchError
      expect(boom.kind).toBe('http-status')
      expect(boom.message).toContain('500')
    })
  })

  /* ── 工具层：schema / 成功文案 / 失败文案 ─────────────────────── */

  describe('createWebFetchTool', () => {

    it('@core:web 成功时返回来源 URL、状态、标题与「不可信数据」声明', async () => {
      const fixture = await startFixture()
      const tool = createWebFetchTool({ allowPrivateNetwork: true })
      const result = await tool.execute({ url: `${fixture.url}/ok` }, makeCtx())
      expect(result.ok).toBe(true)
      expect(result.output).toContain('不可信')
      expect(result.output).toContain('Aurora 价格公告')
      expect(result.output).toContain(`${fixture.url}/ok`)
      expect(result.output).toContain('200')
      expect(result.meta).toMatchObject({
        finalUrl: `${fixture.url}/ok`,
        status: 200,
        title: 'Aurora 价格公告'
      })
    })
  })
})
})
