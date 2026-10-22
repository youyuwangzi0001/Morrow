// 合并自 tests/unit/core/agent.test.ts、tests/unit/core/agent-http.test.ts、tests/unit/core/compaction-agent.test.ts、tests/unit/core/compaction.test.ts、tests/unit/core/context.test.ts、tests/unit/core/subagent-interactive.test.ts、tests/unit/core/subagent-parity.test.ts、tests/unit/core/subagent-terminal.test.ts
// 每个原文件整体包裹在独立 describe 中，保留原有 hooks 与用例。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, afterEach } from 'vitest'
import type {
  AskUserAnswer,
  ChatMessage,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  RuntimeEvent,
  ProviderConfig,
  ToolUseBlock,
} from '../../../src/shared/types'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../../src/core/types'
import {
  compactSession,
  resetAllPermissionGrants,
  runAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from '../../../src/core/agent'
import { buildSystemPrompt } from '../../../src/core/prompt'
import {
  estimateMessagesTokens,
  hasDanglingToolUse,
  applyCompaction,
  planCompaction,
  addUsage,
  estimateMessageTokens,
  estimateTokens,
  localExtractSummary,
  serializeMessagesForSummary,
} from '../../../src/core/context'
import { OpenAICompatProvider, createProvider } from '../../../src/core/providers'
import { ScriptedProvider, collectEvents } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'
import {
  anthropicTextFrames,
  anthropicToolFrames,
  openAITextFrames,
  openAIToolFrames,
  startMockLLM,
  type MockLLM,
} from './helpers/mock-llm'
import { expectValidAnthropicSequence, expectValidOpenAISequence } from './helpers/compaction-validators'

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

  function eventTypes(events: RuntimeEvent[]): string[] {
    return events.map((event) => event.type)
  }

  function indexOf(events: RuntimeEvent[], type: RuntimeEvent['type']): number {
    return events.findIndex((event) => event.type === type)
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  describe('Agent 循环：完整一轮（文本 → 工具 → 文本）', () => {
    it('执行工具、回填结果、事件有序、usage 累计', async () => {
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

    it('请求历史包含此前工具结果（第二轮请求）', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [
          { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
          { text: '读完了。' }
        ])
        expect(harness.events[0].type === 'run_started').toBe(true)
        // 第一轮失败（文件不存在）不应中断循环
        expect(harness.result.reason).toBe('complete')
        expect(harness.result.messages[0].content.find((block) => block.type === 'tool_use')).toMatchObject({ status: 'error' })
      } finally {
        ws.cleanup()
      }
    })

    it('构建系统提示词时包含工作区与中文输出要求；空 systemPrompt 时自动生成', async () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'ask' })
      expect(prompt).toContain('Morrow')
      expect(prompt).toContain('简体中文')
      expect(prompt).toContain('C:\\work')
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [{ text: '好的。' }], { systemPrompt: '' })
        const request = (harness.provider as ScriptedProvider).calls[0]
        expect(request.system).toContain('Morrow')
        expect(request.system).toContain(ws.root)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('审批时序', () => {
    it('ask 模式：tool_started(waiting) → permission_requested → resolved → running → finished', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [{ toolCalls: [{ name: 'write_file', input: { path: '../b.txt', content: 'x' } }] }, { text: '完成' }],
          { permissionMode: 'ask' }
        )
        const { events, permissionCalls } = harness
        expect(permissionCalls).toHaveLength(1)
        expect(permissionCalls[0]).toMatchObject({ toolName: 'write_file', category: 'write', risk: 'high' })
        expect(permissionCalls[0].title).toContain('写入')
        expect(permissionCalls[0].preview?.kind).toBe('path')
        expect(indexOf(events, 'tool_started')).toBeLessThan(indexOf(events, 'permission_requested'))
        expect(indexOf(events, 'permission_requested')).toBeLessThan(indexOf(events, 'permission_resolved'))
        expect(indexOf(events, 'permission_resolved')).toBeLessThan(indexOf(events, 'tool_progress'))
        expect(indexOf(events, 'tool_progress')).toBeLessThan(indexOf(events, 'tool_finished'))
        const started = events.find((event) => event.type === 'tool_started')
        expect(started?.type === 'tool_started' && started.block.status).toBe('waiting')
        expect(existsSync(join(ws.root, '..', 'b.txt'))).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('拒绝审批：不落盘，工具结果 denied 并回灌给模型', async () => {
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

    it('只读模式：写工具直接拒绝，不弹审批', async () => {
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

    it('ask 档工作区写入自动执行，不再弹审批', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [{ toolCalls: [{ name: 'write_file', input: { path: 'e-auto.txt', content: '1' } }] }, { text: '完成' }],
          { permissionMode: 'ask' }
        )
        expect(harness.permissionCalls).toHaveLength(0)
        expect(readFileSync(join(ws.root, 'e-auto.txt'), 'utf8')).toBe('1')
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('中断收尾', () => {
    it('流式过程中中断：assistant 消息带 interrupted 标记，run 以 cancelled 结束', async () => {
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

    it('等待审批时中断：未完成的 tool_use 回填 interrupted 结果', async () => {
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

    it('一开始就已被中断：仍然产出完整事件序列', async () => {
      const ws = makeTempWorkspace()
      try {
        const controller = new AbortController()
        controller.abort()
        const harness = await runScript(ws, [{ text: '不会被执行' }], { signal: controller.signal })
        expect(harness.result.reason).toBe('cancelled')
        expect(harness.events[0].type).toBe('run_started')
        expect(harness.events[harness.events.length - 1].type).toBe('run_finished')
        expect(harness.result.messages[0].interrupted).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('停止条件与错误', () => {
    it('max-steps：达到步数上限时结束并提示', async () => {
      const ws = makeTempWorkspace()
      try {
        const steps = Array.from({ length: 10 }, (_, index) => ({
          toolCalls: [{ name: 'todo_write', input: { todos: [{ text: `第 ${index} 步`, status: 'pending' }] } }]
        }))
        const harness = await runScript(ws, steps, { maxSteps: 2 })
        expect(harness.result.reason).toBe('max-steps')
        // 2 个工具回合 + 1 条「无工具收尾答复」
        expect(harness.result.messages).toHaveLength(3)
        const lastText = harness.result.messages[2].content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
        expect(lastText.length).toBeGreaterThan(0)
        expect(harness.events.some((event) => event.type === 'notice')).toBe(true)
        const finished = harness.events[harness.events.length - 1]
        expect(finished.type === 'run_finished' && finished.reason).toBe('max-steps')
      } finally {
        ws.cleanup()
      }
    })

    it('Provider 抛错：run 以 error 结束并带 error 事件', async () => {
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

  describe('ask_user / 子代理 / 状态透传', () => {
    it('ask_user 走 question_asked/answered 并回填答案', async () => {
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

    it('task 子代理：只读执行并返回摘要，进度通过 tool_progress 上报', async () => {
      const ws = makeTempWorkspace({ 'data.txt': '数据内容' })
      try {
        const harness = await runScript(ws, [
          { toolCalls: [{ name: 'task', input: { description: '调研数据', prompt: '读一下 data.txt 告诉我内容' } }] },
          { text: '子代理的结论是：数据内容。' },
          { text: '主代理完成。' }
        ])
        expect(harness.result.reason).toBe('complete')
        const taskBlock = harness.result.messages[0].content.find((block) => block.type === 'tool_use')
        expect(taskBlock?.type === 'tool_use' && taskBlock.status).toBe('success')
        if (taskBlock?.type === 'tool_use') {
          expect(taskBlock.result?.output).toContain('子代理摘要')
          expect(taskBlock.result?.output).toContain('子代理的结论')
          expect(taskBlock.result?.meta?.steps).toBe(1)
        }
        // 子代理对工具的使用以 tool_progress note 呈现
        const progressNotes = harness.events.filter((event) => event.type === 'tool_progress')
        expect(progressNotes.length).toBeGreaterThan(1)
        // 子代理内部没有对主会话发 message_*（只有主代理的两条消息）
        expect(harness.result.messages).toHaveLength(2)
      } finally {
        ws.cleanup()
      }
    })

    it('模型直接收尾但计划未完成时，会先提醒同步计划再结束', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(ws, [
          {
            toolCalls: [
              {
                name: 'todo_write',
                input: {
                  todos: [
                    { text: '搭骨架', status: 'in_progress' },
                    { text: '补细节', status: 'pending' }
                  ]
                }
              }
            ]
          },
          { text: '已经全部做好了。' },
          {
            toolCalls: [
              {
                name: 'todo_write',
                input: {
                  todos: [
                    { text: '搭骨架', status: 'completed' },
                    { text: '补细节', status: 'completed' }
                  ]
                }
              }
            ]
          },
          { text: '计划已同步，全部完成。' }
        ])
        expect(harness.result.reason).toBe('complete')
        expect(harness.result.todos.map((todo) => todo.status)).toEqual(['completed', 'completed'])
        const nudge = harness.result.messages.find(
          (message) =>
            message.hidden === true &&
            message.role === 'user' &&
            message.content.some((block) => block.type === 'text' && block.text.includes('[系统检查]'))
        )
        expect(nudge).toBeTruthy()
      } finally {
        ws.cleanup()
      }
    })

    it('长任务连续多步不更新计划时，会提醒模型同步进度', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'ok' })
      try {
        const steps: Array<{ text?: string; toolCalls?: Array<{ name: string; input: Record<string, unknown> }> }> = []
        for (let index = 0; index < 6; index += 1) {
          const path = `note-${index}.txt`
          writeFileSync(join(ws.root, path), `第 ${index} 份记录\n`)
          steps.push({ toolCalls: [{ name: 'read_file', input: { path } }] })
        }
        steps.push({ text: '完成了。' }, { text: '仍在收尾。' }, { text: '结束。' })
        const harness = await runScript(ws, steps, {
          initialTodos: [{ id: 'todo_1', text: '长任务步骤', status: 'in_progress' }]
        })
        expect(harness.result.reason).toBe('complete')
        const reminderSent = (harness.provider as ScriptedProvider).calls.some((call) =>
          call.messages.some(
            (message) =>
              message.hidden === true &&
              message.role === 'user' &&
              message.content.some(
                (block) => block.type === 'text' && block.text.includes('连续多步没有更新')
              )
          )
        )
        expect(reminderSent).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('视觉任务完成后不再强制追加打磨轮，由模型按需决定', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [
            {
              text: '先做一版。',
              toolCalls: [
                { name: 'write_file', input: { path: 'site.html', content: '<html><body>v1</body></html>' } },
                { name: 'open_artifact', input: { title: '首页', path: 'site.html' } }
              ]
            },
            { text: '做好了。' }
          ],
          { userMessage: userMessage('做一个页面，画面尽可能惊艳。') }
        )
        expect(harness.result.reason).toBe('complete')
        expect(readFileSync(join(ws.root, 'site.html'), 'utf8')).toContain('v1')
        const nudge = harness.result.messages.find(
          (message) =>
            message.hidden === true &&
            message.role === 'user' &&
            message.content.some((block) => block.type === 'text' && block.text.includes('用户明确要求画面惊艳'))
        )
        expect(nudge).toBeFalsy()
      } finally {
        ws.cleanup()
      }
    })

    it('计划全部完成后仍改文件：自动追加“收尾完善”步骤，不显示虚假的 6/6', async () => {
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

    it('非视觉高质量交付也会触发交付前质量审查', async () => {
      const ws = makeTempWorkspace()
      try {
        const harness = await runScript(
          ws,
          [
            {
              text: '先写报告。',
              toolCalls: [
                { name: 'write_file', input: { path: 'report.md', content: '# 报告\n\n初稿' } },
                { name: 'open_artifact', input: { kind: 'markdown', title: '报告', path: 'report.md' } }
              ]
            },
            { text: '报告完成。' },
            {
              toolCalls: [
                { name: 'edit_file', input: { path: 'report.md', old_string: '初稿', new_string: '初稿\n\n数据口径：已核对' } }
              ]
            },
            { text: '已补充交付前检查。' }
          ],
          { userMessage: userMessage('做一份专业、可直接交付的报告。') }
        )
        expect(harness.result.reason).toBe('complete')
        expect(readFileSync(join(ws.root, 'report.md'), 'utf8')).toContain('数据口径：已核对')
        const nudge = harness.result.messages.find(
          (message) =>
            message.hidden === true &&
            message.role === 'user' &&
            message.content.some((block) => block.type === 'text' && block.text.includes('用户明确要求高质量交付'))
        )
        expect(nudge).toBeTruthy()
      } finally {
        ws.cleanup()
      }
    })

    it('initialTodos / initialArtifacts 会合并进结果', async () => {
      const ws = makeTempWorkspace({ 'r.html': '<html>hi</html>' })
      try {
        const harness = await runScript(
          ws,
          [
            {
              toolCalls: [
                { name: 'todo_write', input: { todos: [{ text: '旧任务', status: 'completed' }, { text: '新任务', status: 'in_progress' }] } },
                { name: 'open_artifact', input: { title: '报告', path: 'r.html' } }
              ]
            },
            { text: '完成' }
          ],
          {
            initialTodos: [{ id: 'todo-old', text: '旧任务', status: 'completed' }],
            initialArtifacts: [
              { id: 'art-old', title: '旧产物', kind: 'text', content: 'old', createdAt: 1, updatedAt: 1 }
            ]
          }
        )
        expect(harness.result.todos).toHaveLength(2)
        expect(harness.result.artifacts).toHaveLength(2)
        expect(harness.result.artifacts[1]).toMatchObject({ title: '报告', kind: 'html' })
        expect(harness.events.some((event) => event.type === 'todos_updated')).toBe(true)
        expect(harness.events.some((event) => event.type === 'artifacts_updated')).toBe(true)
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

    it('超过阈值时调用摘要模型并继续回答', async () => {
      const ws = makeTempWorkspace()
      try {
        const events: RuntimeEvent[] = []
        const provider = new ScriptedProvider([{ text: '早期对话的摘要要点。' }, { text: '压缩后继续完成的回答。' }])
        const result = await runAgent({
          runId: 'run_compact',
          sessionId: 'session_compact',
          provider,
          model: { ...MODEL, contextWindow: 2500 },
          systemPrompt: '你是测试助手。',
          history: longHistory(),
          userMessage: userMessage('接着做'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' })
        })
        expect(result.reason).toBe('complete')
        expect(events.filter((event) => event.type === 'compaction')).toHaveLength(2)
        // 第一次请求是摘要请求：不带工具、system 是压缩器
        expect(provider.calls[0].tools).toHaveLength(0)
        expect(provider.calls[0].system).toContain('压缩器')
        // 压缩后的主请求里带系统摘要消息
        expect(provider.calls[1].messages.some((message) => message.role === 'system')).toBe(true)
        const lastText = result.messages[result.messages.length - 1].content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
        expect(lastText).toContain('压缩后继续完成')
        const finished = events.find((event) => event.type === 'compaction' && event.phase === 'finished')
        expect(finished?.type === 'compaction' && Number(finished.savedTokens)).toBeGreaterThan(0)
      } finally {
        ws.cleanup()
      }
    })

    it('摘要阶段被中断时新建停止消息，不把历史 assistant 误标为 interrupted', async () => {
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

    it('摘要模型失败时用本地摘要兜底，对话继续', async () => {
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

    it('force=true 时调用摘要模型并压缩到 user 边界之后', async () => {
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

    it('未到阈值且未 force 时不压缩', async () => {
      const provider = new ScriptedProvider([{ text: '不应该被调用' }])
      const result = await compactSession({
        provider,
        model: MODEL,
        systemPrompt: '你是测试助手。',
        messages: historyMessages().slice(0, 2),
        signal: new AbortController().signal
      })
      expect(result.compacted).toBe(false)
      expect(result.reason).toBe('below-threshold')
      expect(provider.calls).toHaveLength(0)
    })
  })

  describe('tool_use id 唯一性（防快照/UI 冲突）', () => {
    it('provider 复用历史里出现过的 id 时自动重映射', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'v1' })
      try {
        const history: ChatMessage[] = [
          {
            id: 'hist-a',
            role: 'assistant',
            createdAt: Date.now(),
            content: [
              {
                type: 'tool_use',
                id: 'dup_id',
                name: 'read_file',
                title: '读取',
                category: 'read',
                input: { path: 'a.txt' },
                status: 'success',
                result: { ok: true, output: 'v1' }
              }
            ]
          }
        ]
        const harness = await runScript(
          ws,
          [
            { toolCalls: [{ name: 'write_file', input: { path: 'a.txt', content: 'v2' }, id: 'dup_id' }] },
            { text: '完成' }
          ],
          { history }
        )
        const block = harness.result.messages[0].content.find((item) => item.type === 'tool_use')
        expect(block?.type === 'tool_use' && block.id).not.toBe('dup_id')
        if (block?.type === 'tool_use') {
          // 快照目录使用新 id，不会覆盖历史调用留下的目录
          expect(block.result?.meta?.snapshotId).toBe(block.id)
          expect(existsSync(join(ws.snapshotDir, block.id, 'a.txt'))).toBe(true)
        }
      } finally {
        ws.cleanup()
      }
    })

    it('同一回合里 provider 给出重复 id 也会被拆开', async () => {
      const ws = makeTempWorkspace({
        'x.txt': 'a',
        'y.txt': 'b'
      })
      try {
        const harness = await runScript(ws, [
          {
            toolCalls: [
              { name: 'write_file', input: { path: 'x.txt', content: '1' }, id: 'same_id' },
              { name: 'write_file', input: { path: 'y.txt', content: '2' }, id: 'same_id' }
            ]
          },
          { text: '完成' }
        ])
        const ids = harness.result.messages[0].content
          .filter((block) => block.type === 'tool_use')
          .map((block) => (block.type === 'tool_use' ? block.id : ''))
        expect(ids).toHaveLength(2)
        expect(new Set(ids).size).toBe(2)
        // 第一次使用保留原 id，第二次重映射
        expect(ids[0]).toBe('same_id')
        expect(ids[1]).not.toBe('same_id')
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('工具参数被截断（max_tokens）的自修复路径', () => {
    it('截断的工具调用转为 error 结果 + hint 回灌，整轮不中断', async () => {
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
    it('有真实 usage 时 contextUsed = 最近一次请求的 input+output，且 usage_updated 与 run_finished 一致', async () => {
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

    it('Provider 完全不返回 usage 时回退到估算', async () => {
      const ws = makeTempWorkspace()
      try {
        const noUsageProvider: Provider = {
          async *stream() {
            yield { type: 'text_delta', text: '没有 usage 的回答。' }
          }
        }
        const harness = await runScript(ws, [], { provider: noUsageProvider })
        const userMsg: ChatMessage = {
          id: 'u-帮我处理一下',
          role: 'user',
          content: [{ type: 'text', text: '帮我处理一下' }],
          createdAt: 0
        }
        const expected = estimateMessagesTokens([userMsg, harness.result.messages[0]], '你是 Morrow 测试助手。')
        expect(harness.result.usage.contextUsed).toBe(expected)
        expect(harness.result.usage.contextUsed).toBeGreaterThan(0)
        // 没有真实 token 计数时总量为 0
        expect(harness.result.usage.inputTokens).toBe(0)
        expect(harness.result.usage.outputTokens).toBe(0)
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
    const smallModel: ModelInfo = { ...MODEL, contextWindow: 8000 }

    it('autoCompact=false 时不触发自动压缩（即使超过阈值）', async () => {
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

    it('更低的 compactThreshold 会提前触发压缩（默认阈值下不压缩）', async () => {
      const ws = makeTempWorkspace()
      try {
        // 控制组：默认 0.8 阈值（8000*0.8 = 6400 > 估算 ~4.9k）不压缩
        const controlProvider = new ScriptedProvider([{ text: '直接回答。' }])
        const control = await runScript(ws, [], { provider: controlProvider, model: smallModel, history: longHistory(), userMessage: userMessage('继续') })
        expect(control.events.some((event) => event.type === 'compaction')).toBe(false)
        expect(controlProvider.calls).toHaveLength(1)

        // 实验组：threshold=0.5（8000*0.5 = 4000 < 估算）触发压缩
        const provider = new ScriptedProvider([{ text: '历史摘要要点。' }, { text: '压缩后回答。' }])
        const events: RuntimeEvent[] = []
        const result = await runAgent({
          runId: 'run_low_threshold',
          sessionId: 'session_low_threshold',
          provider,
          model: smallModel,
          systemPrompt: '你是测试助手。',
          history: longHistory(),
          userMessage: userMessage('继续'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' }),
          compactThreshold: 0.5
        })
        expect(result.reason).toBe('complete')
        expect(events.filter((event) => event.type === 'compaction')).toHaveLength(2)
        expect(provider.calls[0].tools).toHaveLength(0)
        expect(provider.calls[0].system).toContain('压缩器')
      } finally {
        ws.cleanup()
      }
    })

    it('keepRecent 控制压缩后保留的消息数量', async () => {
      const ws = makeTempWorkspace()
      try {
        // keepRecent=2：13 条消息 → 在最近 2 条之前切（assistant 边界），保留 2 条 + 摘要 + 原始用户消息 = 5 条
        const provider = new ScriptedProvider([{ text: '摘要。' }, { text: '回答。' }])
        const result = await runAgent({
          runId: 'run_keep_recent',
          sessionId: 'session_keep_recent',
          provider,
          model: smallModel,
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
          compactThreshold: 0.5,
          keepRecent: 2
        })
        expect(result.reason).toBe('complete')
        // calls[0] 是摘要请求；calls[1] 是压缩后的主请求
        expect(provider.calls[1].messages).toHaveLength(5)
        expect(provider.calls[1].messages[0].role).toBe('system')
        // 原始用户消息（约束/任务）始终保留在摘要之后
        expect(provider.calls[1].messages[1].content[0]).toMatchObject({ type: 'text' })
        expect(provider.calls[1].messages[1].role).toBe('user')
        // 保留的最后一条是本次用户消息
        const last = provider.calls[1].messages[provider.calls[1].messages.length - 1]
        expect(last.content[0]).toMatchObject({ type: 'text', text: '继续' })
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('compactSession 的 threshold 参数', () => {
    it('更低阈值可让未到 80% 的会话提前压缩', async () => {
      const longMessages: ChatMessage[] = []
      for (let index = 0; index < 16; index += 1) {
        longMessages.push({
          id: `th-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: '这是一段需要压缩的历史对话内容。'.repeat(25) }],
          createdAt: Date.now()
        })
      }
      const bigModel: ModelInfo = { ...MODEL, contextWindow: 10_000 }
      // 默认 0.8 阈值（8000）> 估算 ~6.5k → 不压缩
      const controlProvider = new ScriptedProvider([{ text: '不应该被调用' }])
      const control = await compactSession({
        provider: controlProvider,
        model: bigModel,
        systemPrompt: '你是测试助手。',
        messages: longMessages,
        signal: new AbortController().signal
      })
      expect(control.compacted).toBe(false)
      expect(control.reason).toBe('below-threshold')
      expect(controlProvider.calls).toHaveLength(0)

      // threshold=0.5（5000）< 估算 ~6.5k → 压缩
      const provider = new ScriptedProvider([{ text: '历史摘要。' }])
      const compacted = await compactSession({
        provider,
        model: bigModel,
        systemPrompt: '你是测试助手。',
        messages: longMessages,
        signal: new AbortController().signal,
        threshold: 0.5
      })
      expect(compacted.compacted).toBe(true)
      expect(compacted.messages[0].role).toBe('system')
      expect(provider.calls[0].system).toContain('压缩器')
    })
  })

  describe('思考耗时', () => {
    it('完成后把思考耗时写入 thinking 块，供 UI 显示「思考了 N 秒」', async () => {
      const ws = makeTempWorkspace()
      try {
        const { result } = await runScript(ws, [{ thinking: '先想一想。', text: '想好了。' }])
        const message = result.messages[0]
        const block = message.content.find((item) => item.type === 'thinking')
        expect(block?.type).toBe('thinking')
        if (block?.type === 'thinking') {
          expect(typeof block.durationMs).toBe('number')
          expect(block.durationMs).toBeGreaterThanOrEqual(0)
        }
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('agent-http.test.ts', () => {
  /**
   * 协议集成测试：本地 Mock LLM HTTP SSE → Provider → Agent 循环 → 真实工具执行。
   * 这是任务验收里「node 脚本用本地 mock HTTP SSE 跑通一次带工具调用的完整 run」的自动化版本，
   * 并把过程日志写到 tmp/verify/mock-run.log 作为证据。
   */

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
    systemPrompt: string,
    providerOverride?: Provider
  ): Promise<{ events: RuntimeEvent[]; result: RunAgentResult }> {
    const events: RuntimeEvent[] = []
    const provider = providerOverride ?? createProvider(config, 'sk-mock', 'mock-model')
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

  describe('Mock HTTP SSE：空流与断流', () => {
    it('200 空流重试后以 error 结束，不再伪装成正常空回复', async () => {
      resetAllPermissionGrants()
      const ws = makeTempWorkspace()
      const server = await startMockLLM(() => ({ frames: [], done: false }))
      servers.push(server)
      try {
        const config = providerConfig('mock-empty', 'openai-compat', server.baseUrl)
        const provider = new OpenAICompatProvider(config, 'sk-mock', 'mock-model', { retryDelays: [1, 1, 1] })
        const { events, result } = await runWithMock(server, config, ws.root, ws.snapshotDir, '你是测试助手。', provider)
        expect(result.reason).toBe('error')
        expect(result.error?.code).toBe('empty_response')
        expect(server.requests).toHaveLength(4)
        const message = result.messages[0]
        expect(message.error?.code).toBe('empty_response')
        expect(message.content).toContainEqual(expect.objectContaining({ type: 'error', code: 'empty_response' }))
        expect(message.content.some((block) => block.type === 'text' && block.text.includes('模型没有返回内容'))).toBe(false)
        expect(events.some((event) => event.type === 'error')).toBe(true)
      } finally {
        ws.cleanup()
      }
    }, 20_000)

    it('文本流中途断流：保留已收到文本并以 error 结束', async () => {
      resetAllPermissionGrants()
      const ws = makeTempWorkspace()
      const server = await startMockLLM(() => ({
        frames: [{ choices: [{ index: 0, delta: { content: '半截回答' } }] }],
        done: false
      }))
      servers.push(server)
      try {
        const config = providerConfig('mock-truncated', 'openai-compat', server.baseUrl)
        const provider = new OpenAICompatProvider(config, 'sk-mock', 'mock-model', { retryDelays: [1, 1, 1] })
        const { result } = await runWithMock(server, config, ws.root, ws.snapshotDir, '你是测试助手。', provider)
        expect(result.reason).toBe('error')
        expect(result.error?.code).toBe('incomplete_stream')
        // 已产出内容后不重试，避免重复半截文本
        expect(server.requests).toHaveLength(1)
        const message = result.messages[0]
        expect(message.error?.code).toBe('incomplete_stream')
        expect(message.content.some((block) => block.type === 'text' && block.text === '半截回答')).toBe(true)
        expect(message.content.some((block) => block.type === 'error')).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
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

  /** 单用户长工具链剧本：读 3 份材料 → 压缩后继续读 1 份 → 合计。 */
  class SingleUserChainProvider implements Provider {
    readonly id = 'r2h-scripted'
    readonly calls: ProviderStreamRequest[] = []
    /** 从真实工具结果里观察到的 value（按 tool id 去重） */
    readonly observedValues = new Map<string, number>()
    private reads = 0
    private readonly files = ['in/m1.txt', 'in/m2.txt', 'in/m3.txt', 'in/notes.txt']

    async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
      // 快照消息数组（Agent 后续还会 push 新消息）
      this.calls.push({ ...request, messages: [...request.messages] })
      this.collectValues(request.messages)
      // 摘要请求：system 是压缩器提示词、无工具
      if (request.tools.length === 0 && request.system.includes('压缩器')) {
        yield {
          type: 'text_delta',
          text: '摘要：用户要求逐段只读三组长文本并合计 value；限制为只读、不写文件、不保存记忆、禁止外发。已读取部分材料，剩余材料继续读取后合计。'
        }
        yield { type: 'usage', usage: { inputTokens: 320, outputTokens: 90 } }
        return
      }
      if (this.reads < this.files.length) {
        const path = this.files[this.reads]
        const index = this.reads
        this.reads += 1
        const id = `r2h-call-${index}`
        yield { type: 'tool_call_start', index: 0, id, name: 'read_file' }
        yield { type: 'tool_call_delta', index: 0, argsDelta: JSON.stringify({ path }) }
        yield { type: 'tool_call_end', index: 0, id, name: 'read_file', input: { path } }
        yield { type: 'usage', usage: { inputTokens: 180, outputTokens: 24 } }
        return
      }
      const total = [...this.observedValues.values()].reduce((sum, value) => sum + value, 0)
      yield { type: 'text_delta', text: `已读 ${this.observedValues.size} 份材料，value 合计 ${total}；未写文件、未保存记忆、未外发。` }
      yield { type: 'usage', usage: { inputTokens: 260, outputTokens: 40 } }
    }

    private collectValues(messages: ChatMessage[]): void {
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type !== 'tool_use' || !block.result?.ok) continue
          const match = /value=(\d+)/.exec(block.result.output ?? '')
          if (match) this.observedValues.set(block.id, Number(match[1]))
        }
      }
    }
  }

  function textOf(message: ChatMessage): string {
    return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  }

  describe('R2-H 单用户长工具链：真实触发压缩并继续', () => {
    it('达到阈值→压缩事件→上下文变短→继续工具调用→真实合计 20', async () => {
      const padding = '材料内容 '.repeat(600)
      const ws = makeTempWorkspace({
        'in/m1.txt': `value=4\n${padding}`,
        'in/m2.txt': `value=7\n${padding}`,
        'in/m3.txt': `value=9\n${padding}`,
        'in/notes.txt': '剩余工作：三份材料已读完，可以直接合计。\n'
      })
      try {
        const events: RuntimeEvent[] = []
        const provider = new SingleUserChainProvider()
        const userText = '逐段只读 in/m1.txt、in/m2.txt、in/m3.txt 这三组长文本并合计 value；不写文件、不保存记忆、禁止外发。'
        const result = await runAgent({
          runId: 'run_r2h_compact',
          sessionId: 'session_r2h_compact',
          provider,
          model: MODEL,
          systemPrompt: SYSTEM_PROMPT,
          history: [],
          userMessage: { id: 'u-r2h', role: 'user', content: [{ type: 'text', text: userText }], createdAt: Date.now() },
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'A', label: '方案 A', custom: true }),
          maxSteps: 12,
          keepRecent: 2
        })

        // 1) 真实读到三份材料，value 分别 4/7/9
        expect([...provider.observedValues.values()].sort((a, b) => a - b)).toEqual([4, 7, 9])

        // 2) 压缩真实发生（started + finished 成对事件）且 savedTokens > 0
        const compactionEvents = events.filter((event) => event.type === 'compaction')
        expect(compactionEvents.length).toBeGreaterThanOrEqual(2)
        expect(compactionEvents.length % 2).toBe(0)
        const finishedEvents = compactionEvents.filter((event) => event.type === 'compaction' && event.phase === 'finished')
        expect(finishedEvents.length).toBeGreaterThanOrEqual(1)
        const totalSaved = finishedEvents.reduce((sum, event) => sum + (event.type === 'compaction' ? event.savedTokens ?? 0 : 0), 0)
        expect(totalSaved).toBeGreaterThan(0)
        expect(events.some((event) => event.type === 'error')).toBe(false)

        // 3) 找到「摘要请求」及其前后的主请求，验证真实 token 达到阈值并变短
        const summaryIndex = provider.calls.findIndex((call) => call.tools.length === 0 && call.system.includes('压缩器'))
        expect(summaryIndex).toBeGreaterThan(0)
        const summaryRequest = provider.calls[summaryIndex]
        const beforeCompaction = provider.calls[summaryIndex - 1]
        const afterCompaction = provider.calls[summaryIndex + 1]
        expect(afterCompaction).toBeTruthy()
        const thresholdTokens = MODEL.contextWindow * 0.8
        expect(estimateMessagesTokens(beforeCompaction.messages, SYSTEM_PROMPT)).toBeGreaterThan(thresholdTokens)
        // 摘要请求本身只含「被裁掉的安全历史序列化」，不带工具
        expect(summaryRequest.messages).toHaveLength(1)
        expect(summaryRequest.messages[0].role).toBe('user')
        // 压缩后主请求：system 摘要 + 原始用户消息 + 保留的完整工具对
        expect(afterCompaction.messages[0].role).toBe('system')
        expect(afterCompaction.messages[1].role).toBe('user')
        expect(textOf(afterCompaction.messages[1])).toContain('禁止外发')
        expect(textOf(afterCompaction.messages[1])).toContain('只读')
        expect(hasDanglingToolUse(afterCompaction.messages)).toBe(false)
        expectValidOpenAISequence(afterCompaction.messages)
        expectValidAnthropicSequence(afterCompaction.messages)
        // 最近工具结果保留：压缩后的请求里能看到 value=7 / value=9 的真实结果文本
        const keptToolOutputs = afterCompaction.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'tool_use')
          .map((block) => (block.type === 'tool_use' ? block.result?.output ?? '' : ''))
          .join('\n')
        expect(keptToolOutputs).toContain('value=7')
        expect(keptToolOutputs).toContain('value=9')
        // token 真实变短：对比「若不压缩的第 4 步请求（user + 前 3 个工具回合）」
        // 注意 result.messages 不含 user 消息，需手动拼上
        const uncompactedMessages = [
          { id: 'u-r2h', role: 'user' as const, content: [{ type: 'text' as const, text: '逐段只读 in/m1.txt、in/m2.txt、in/m3.txt 这三组长文本并合计 value；不写文件、不保存记忆、禁止外发。' }], createdAt: Date.now() },
          ...result.messages.slice(0, 3)
        ]
        const uncompactedTokens = estimateMessagesTokens(uncompactedMessages, SYSTEM_PROMPT)
        const afterTokens = estimateMessagesTokens(afterCompaction.messages, SYSTEM_PROMPT)
        expect(uncompactedTokens).toBeGreaterThan(thresholdTokens)
        expect(afterTokens).toBeLessThan(uncompactedTokens)

        // 4) 压缩后仍继续了工具调用（读 notes.txt）并正常完成
        expect(result.reason).toBe('complete')
        const allToolCalls = provider.calls
          .flatMap((call) => call.messages)
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'tool_use')
        const notesCalls = allToolCalls.filter((block) => block.type === 'tool_use' && JSON.stringify(block.input).includes('notes.txt'))
        expect(notesCalls.length).toBeGreaterThanOrEqual(1)
        expect(notesCalls.every((block) => block.type === 'tool_use' ? block.result?.ok === true : false)).toBe(true)
        // 读 notes.txt 发生在第一次压缩之后（压缩后继续执行）
        const afterFirstSummary = provider.calls.slice(summaryIndex + 1)
        const callsAfterCompaction = afterFirstSummary
          .flatMap((call) => call.messages)
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'tool_use')
          .map((block) => (block.type === 'tool_use' ? JSON.stringify(block.input) : ''))
        expect(callsAfterCompaction.some((input) => input.includes('notes.txt'))).toBe(true)

        // 5) 最终答案来自真实读取（4+7+9=20），且遵守限制（不写文件、不保存记忆、未外发）
        const finalText = result.messages.map(textOf).join('\n')
        expect(finalText).toContain('合计 20')
        expect(finalText).toMatch(/未写文件|未外发/)
        // 全程没有写文件 / 记忆 / 命令类工具调用
        const toolNames = provider.calls
          .flatMap((call) => call.messages)
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'tool_use')
          .map((block) => (block.type === 'tool_use' ? block.name : ''))
        expect(new Set(toolNames)).toEqual(new Set(['read_file']))

        // 6) 压缩发生在单用户消息的链里：只发过这一条 user 请求（没有补第二条用户消息）
        const userMessages = provider.calls[provider.calls.length - 1].messages.filter((message) => message.role === 'user')
        expect(userMessages.length).toBeLessThanOrEqual(2) // 原始用户消息（+可能的当前用户请求）
        expect(userMessages.some((message) => textOf(message).includes('逐段只读'))).toBe(true)

        // 7) 压缩后的完整历史必须一起返回，主进程才能把它写回会话（否则重启后旧历史复活）
        expect(result.compactedMessages?.[0].role).toBe('system')
        expect(result.compactedMessages?.some((message) => textOf(message).includes('逐段只读'))).toBe(true)
        // 摘要请求的 320/90 token 也计入总用量
        expect(result.usage.inputTokens).toBeGreaterThanOrEqual(320)
        expect(result.usage.outputTokens).toBeGreaterThanOrEqual(90)
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
    it('单条 user + 多轮工具结果达到阈值 → 在完整工具对之后切分（cutKind=tool-pair）', () => {
      const messages = singleUserLongChain(12)
      const plan = planCompaction(messages, '你是压缩测试助手。', 4000, { keepRecent: 4 })
      expect(plan.shouldCompact).toBe(true)
      expect(plan.cutKind).toBe('tool-pair')
      expect(plan.cutIndex).toBeGreaterThan(0)
      expect(messages[plan.cutIndex].role).toBe('assistant')
      expect(plan.preserveCount).toBe(1)
      expect(plan.keepCount).toBe(messages.length - plan.cutIndex + 1)
      expect(plan.savedTokens).toBeGreaterThan(0)
      // 被裁掉段与保留段都不含未回填结果的工具调用
      expect(hasDanglingToolUse(messages.slice(0, plan.cutIndex))).toBe(false)
      expect(hasDanglingToolUse(messages.slice(plan.cutIndex))).toBe(false)
      // 保留段确实是「完整工具对之后」：从切点开始的消息都自带 result
      for (const message of messages.slice(plan.cutIndex)) {
        for (const block of message.content) {
          if (block.type === 'tool_use') expect(block.result).toBeTruthy()
        }
      }
    })

    it('压缩后：保留原始用户约束与最近工具结果，token 变短，两种协议序列都合法', () => {
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

    it('切点落在后续工具回合中途时，同时保留「首条用户约束」与「当前用户请求」', () => {
      const first = userMessage('整体任务：整理材料；禁止外发。')
      const firstTurn = toolTurn(1)
      const currentRequest = userMessage('现在先读第二组材料并合计。')
      const secondTurn = toolTurn(2)
      const thirdTurn = toolTurn(3)
      const messages = [first, firstTurn, currentRequest, secondTurn, thirdTurn]
      const plan = planCompaction(messages, '你是压缩测试助手。', 2000, { keepRecent: 2, force: true })
      expect(plan.shouldCompact).toBe(true)
      expect(plan.cutKind).toBe('tool-pair')
      expect(plan.preserveCount).toBe(2)
      const compacted = applyCompaction(messages, plan.cutIndex, '摘要：已读取第一组材料；当前任务为读取第二组并合计。')
      const users = compacted.filter((message) => message.role === 'user')
      expect(users).toHaveLength(2)
      expect(users[0].content[0]).toMatchObject({ type: 'text', text: first.content[0].type === 'text' ? first.content[0].text : '' })
      expect(users[1].content[0]).toMatchObject({ type: 'text', text: currentRequest.content[0].type === 'text' ? currentRequest.content[0].text : '' })
      expectValidOpenAISequence(compacted)
      expectValidAnthropicSequence(compacted)
    })

    it('进行中的工具调用（tool_use 无 result）时拒绝压缩，避免压缩出非法请求', () => {
      const messages = [userMessage('读材料'), ...Array.from({ length: 10 }, (_, index) => toolTurn(index + 1)), toolTurn(11, 300, { dangling: true })]
      const plan = planCompaction(messages, '', 2000, { keepRecent: 4 })
      expect(plan.shouldCompact).toBe(false)
      expect(plan.reason).toBe('no-safe-cut')
    })

    it('强制压缩但历史很短（省不下 token）时安全返回 no-safe-cut', () => {
      const plan = planCompaction([userMessage('问题'), toolTurn(1, 20)], '', 2000, { keepRecent: 8, force: true })
      expect(plan.shouldCompact).toBe(false)
      expect(plan.reason).toBe('no-safe-cut')
    })

    it('keepRecent=1 时也能工作，且保留段+原始用户消息构成最小合法上下文', () => {
      const messages = singleUserLongChain(6)
      const plan = planCompaction(messages, '', 3000, { keepRecent: 1 })
      expect(plan.shouldCompact).toBe(true)
      const compacted = applyCompaction(messages, plan.cutIndex, '摘要：已读取部分材料。')
      expect(compacted[0].role).toBe('system')
      expect(compacted[1].role).toBe('user')
      expectValidOpenAISequence(compacted)
      expectValidAnthropicSequence(compacted)
    })
  })
})

describe('context.test.ts', () => {
  function message(role: ChatMessage['role'], text: string, createdAt = Date.now()): ChatMessage {
    return { id: `${role}-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], createdAt }
  }

  describe('estimateTokens', () => {
    it('中文按 1 字 1 token，英文约 4 字符 1 token', () => {
      expect(estimateTokens('')).toBe(0)
      expect(estimateTokens('你好世界')).toBe(4)
      expect(estimateTokens('abcd')).toBe(1)
      expect(estimateTokens('abcdefgh')).toBe(2)
      expect(estimateTokens('a你')).toBe(2)
    })

    it('消息估算包含 tool_use 参数与结果', () => {
      const withTool: ChatMessage = {
        id: 'a1',
        role: 'assistant',
        createdAt: Date.now(),
        content: [
          { type: 'text', text: '我来读文件' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read_file',
            title: '读取 a.txt',
            category: 'read',
            input: { path: 'a.txt' },
            status: 'success',
            result: { ok: true, output: '文件内容'.repeat(20) }
          }
        ]
      }
      expect(estimateMessageTokens(withTool)).toBeGreaterThan(20)
      expect(estimateMessagesTokens([withTool], '系统提示')).toBeGreaterThan(estimateMessageTokens(withTool))
    })

    it('历史图片计入上下文估算，避免带图会话迟迟不压缩', () => {
      const withImage: ChatMessage = {
        ...message('user', '看这张图'),
        images: [{ mediaType: 'image/png', dataBase64: 'A'.repeat(100), name: 'shot.png' }]
      }
      expect(estimateMessageTokens(withImage)).toBeGreaterThanOrEqual(1100)
      expect(estimateMessageTokens(withImage)).toBeGreaterThan(estimateMessageTokens(message('user', '看这张图')))
    })
  })

  describe('planCompaction', () => {
    it('未超过阈值不压缩', () => {
      const messages = [message('user', '短消息'), message('assistant', '短回复')]
      const plan = planCompaction(messages, 'system', 128_000)
      expect(plan.shouldCompact).toBe(false)
      expect(plan.reason).toBe('below-threshold')
    })

    it('超过 80% 阈值时在 user 消息边界切割，并额外保留原始用户消息', () => {
      const messages: ChatMessage[] = []
      for (let i = 0; i < 20; i += 1) {
        messages.push(message(i % 2 === 0 ? 'user' : 'assistant', '内容'.repeat(800)))
      }
      const plan = planCompaction(messages, '', 2000, { keepRecent: 8 })
      expect(plan.shouldCompact).toBe(true)
      expect(plan.cutIndex).toBeGreaterThan(0)
      expect(messages[plan.cutIndex].role).toBe('user')
      expect(plan.cutKind).toBe('user')
      expect(plan.preserveCount).toBe(1)
      expect(plan.keepCount).toBe(messages.length - plan.cutIndex + 1)
      expect(plan.savedTokens).toBeGreaterThan(0)
    })

    it('单用户长工具链（没有第二个 user 边界）也能在完整工具对之后切分', () => {
      const messages: ChatMessage[] = [message('user', '只读材料并合计，禁止外发')]
      for (let i = 0; i < 20; i += 1) {
        messages.push(message('assistant', '这是一段很长的工具回合结果'.repeat(300)))
      }
      const plan = planCompaction(messages, '', 2000, { keepRecent: 8 })
      expect(plan.shouldCompact).toBe(true)
      expect(plan.cutIndex).toBeGreaterThan(0)
      expect(plan.cutKind).toBe('tool-pair')
      expect(messages[plan.cutIndex].role).toBe('assistant')
      expect(plan.preserveCount).toBe(1)
      expect(plan.shouldCompact && plan.keepCount).toBe(messages.length - plan.cutIndex + 1)
      expect(plan.savedTokens).toBeGreaterThan(0)
    })

    it('进行中的工具调用（tool_use 无结果）时拒绝压缩', () => {
      const dangling: ChatMessage = {
        id: 'dangling',
        role: 'assistant',
        createdAt: Date.now(),
        content: [
          { type: 'text', text: '读取中' },
          { type: 'tool_use', id: 'call_pending', name: 'read_file', title: '读取', category: 'read', input: {}, status: 'running' }
        ]
      }
      const messages: ChatMessage[] = [message('user', '问题'), ...Array.from({ length: 20 }, (_, i) => message('assistant', '长内容'.repeat(400))), dangling]
      const plan = planCompaction(messages, '', 2000, { keepRecent: 8 })
      expect(plan.shouldCompact).toBe(false)
      expect(plan.reason).toBe('no-safe-cut')
    })

    it('历史不足以切出有效压缩时拒绝（消息数不超过 keepRecent）', () => {
      const messages = [message('user', '问题'), message('assistant', '回答'.repeat(500))]
      const plan = planCompaction(messages, '', 2000, { keepRecent: 8, force: true })
      expect(plan.shouldCompact).toBe(false)
      expect(plan.reason).toBe('no-safe-cut')
    })
  })

  describe('压缩与序列化', () => {
    it('applyCompaction 用 system 摘要替换旧历史，并保留原始用户消息', () => {
      const messages = [message('user', '旧问题（含禁止外发约束）'), message('assistant', '旧回答'), message('user', '新问题')]
      const result = applyCompaction(messages, 2, '用户先问了旧问题')
      // 摘要 + 原始用户消息（约束）+ 保留段
      expect(result).toHaveLength(3)
      expect(result[0].role).toBe('system')
      expect(result[0].content[0]).toMatchObject({ type: 'text' })
      expect(result[1].content[0]).toMatchObject({ type: 'text', text: '旧问题（含禁止外发约束）' })
      expect(result[2].content[0]).toMatchObject({ type: 'text', text: '新问题' })
    })

    it('serializeMessagesForSummary 保留工具调用痕迹并截断', () => {
      const messages: ChatMessage[] = [
        message('user', '帮我读文件'),
        {
          id: 'a2',
          role: 'assistant',
          createdAt: Date.now(),
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'read_file',
              title: '读取',
              category: 'read',
              input: { path: '资料/报价单.xlsx' },
              status: 'success',
              result: { ok: true, output: '文件内容' }
            }
          ]
        }
      ]
      const text = serializeMessagesForSummary(messages)
      expect(text).toContain('用户')
      expect(text).toContain('read_file')
      expect(text).toContain('资料/报价单.xlsx')
      const truncated = serializeMessagesForSummary(messages, 10)
      expect(truncated.length).toBeLessThanOrEqual(80)
    })

    it('摘要输入保留图片存在感，而不是当作没有附件', () => {
      const withImage: ChatMessage = {
        ...message('user', '看设计稿'),
        images: [{ mediaType: 'image/png', dataBase64: 'AAAA', name: '首页设计.png' }]
      }
      const text = serializeMessagesForSummary([withImage])
      expect(text).toContain('1 张图片')
      expect(text).toContain('首页设计.png')
      expect(text).not.toContain('AAAA')
    })

    it('localExtractSummary 产出可读兜底摘要', () => {
      const summary = localExtractSummary([message('user', '目标：做一份报告'), message('assistant', '已完成')])
      expect(summary).toContain('目标：做一份报告')
    })

    it('hasDanglingToolUse 检测未回填的 tool_use', () => {
      const okMessage: ChatMessage = {
        id: 'a',
        role: 'assistant',
        createdAt: Date.now(),
        content: [
          {
            type: 'tool_use',
            id: 'call',
            name: 'read_file',
            title: '读取',
            category: 'read',
            input: {},
            status: 'success',
            result: { ok: true, output: '' }
          }
        ]
      }
      expect(hasDanglingToolUse([okMessage])).toBe(false)
      const dangling = { ...okMessage, content: [{ ...okMessage.content[0], result: undefined }] } as ChatMessage
      expect(hasDanglingToolUse([dangling])).toBe(true)
    })

    it('addUsage 累加 token', () => {
      const merged = addUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3, outputTokens: 7, cacheReadTokens: 2 })
      expect(merged).toEqual({ inputTokens: 13, outputTokens: 12, cacheReadTokens: 2 })
    })
  })
})

describe('subagent-interactive.test.ts', () => {
  /**
   * 并行子代理的交互卡必须串行：一个子代理在等待审批时，
   * 另一个子代理不能同时弹出审批卡或提问卡（否则后一张会覆盖前一张，任务悬挂）。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 32_000, supportsTools: true }

  class ParallelTaskProvider implements Provider {
    readonly calls: ProviderStreamRequest[] = []
    private parentCalls = 0
    private readonly subSteps = new Map<string, number>()

    async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
      this.calls.push(request)
      if (!request.system.includes('## 子代理')) {
        this.parentCalls += 1
        if (this.parentCalls === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'task-a', name: 'task' }
          yield { type: 'tool_call_end', index: 0, id: 'task-a', name: 'task', input: { description: '任务 A', prompt: '创建 a.txt，内容为 A' } }
          yield { type: 'tool_call_start', index: 1, id: 'task-b', name: 'task' }
          yield { type: 'tool_call_end', index: 1, id: 'task-b', name: 'task', input: { description: '任务 B', prompt: '先问用户选哪个，再汇报' } }
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
            input: { question: '子代理 B 需要你选择', options: ['甲', '乙'] }
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

  describe('并行子代理交互串行', () => {
    it('审批卡与提问卡不会同时出现，两个子任务都能完成', async () => {
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
          runId: 'run_parallel_subagents',
          sessionId: 'session_parallel_subagents',
          provider,
          model: MODEL,
          systemPrompt: '你是并行子代理测试助手。',
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

        const taskResults = result.messages
          .flatMap((message) => message.content)
          .filter((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === 'task')
        expect(taskResults).toHaveLength(2)
        expect(taskResults.every((block) => block.result?.ok === true)).toBe(true)
        expect(result.messages.map(textOf).join('\n')).toContain('两个子任务都已完成')

        const subCalls = provider.calls.filter((call) => call.system.includes('## 子代理'))
        const subToolNames = new Set(subCalls.flatMap((call) => call.tools.map((tool) => tool.name)))
        expect(subToolNames.has('task')).toBe(false)
        expect(subToolNames.has('update_goal')).toBe(false)
        expect(subToolNames.has('todo_write')).toBe(false)
        expect(subToolNames.has('write_file')).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('subagent-parity.test.ts', () => {
  /**
   * R9.1 子代理全权限 + 真实并行测试。
   * - 子代理工具集与主代理一致（排除 task 防嵌套、update_goal 仅主代理）；
   * - 子代理 write_file/run_command/mcp_call 走主代理同一套权限链（ask/auto/read-only）；
   * - 同一 assistant 消息里多个 task 调用真正并发（时间线重叠）；
   * - 并行审批串行（不会同时挂起多个审批卡）；拒绝/abort 正确传播。
   */

  const MODEL: ModelInfo = {
    id: 'mock-model',
    label: 'Mock',
    contextWindow: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'effort'
  }

  interface ToolCallSpec {
    name: string
    input: Record<string, unknown>
    id: string
  }

  interface Route {
    text?: string
    toolCalls?: ToolCallSpec[]
  }

  interface RoutedCall {
    kind: 'main' | 'child'
    label?: string
    messagesLength: number
    toolNames: string[]
    reasoning?: ProviderStreamRequest['reasoning']
  }

  /** 按「最后一个 user 消息内容 + 是否第二轮」路由的可控 provider（支持并发调用） */
  class RoutedProvider implements Provider {
    readonly calls: RoutedCall[] = []
    private readonly router: (request: ProviderStreamRequest) => Route

    constructor(router: (request: ProviderStreamRequest) => Route) {
      this.router = router
    }

    async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
      const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
      const text = lastUser?.content.find((block) => block.type === 'text')
      const prompt = text && text.type === 'text' ? text.text : ''
      const childMatch = /CHILD-([AB])/.exec(prompt)
      this.calls.push({
        kind: childMatch ? 'child' : 'main',
        ...(childMatch ? { label: childMatch[1] } : {}),
        messagesLength: request.messages.length,
        toolNames: request.tools.map((tool) => tool.name),
        ...(request.reasoning ? { reasoning: request.reasoning } : {})
      })
      yield* yieldRoute(this.router(request))
    }
  }

  async function* yieldRoute(route: Route): AsyncGenerator<ProviderStreamEvent> {
    if (route.text) yield { type: 'text_delta', text: route.text }
    for (let index = 0; index < (route.toolCalls ?? []).length; index += 1) {
      const call = (route.toolCalls ?? [])[index]
      yield { type: 'tool_call_start', index, id: call.id, name: call.name }
      yield { type: 'tool_call_delta', index, argsDelta: JSON.stringify(call.input) }
      yield { type: 'tool_call_end', index, id: call.id, name: call.name, input: call.input }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  interface HarnessResult {
    result: Awaited<ReturnType<typeof runAgent>>
    events: RuntimeEvent[]
    provider: RoutedProvider
    permissionRequests: PermissionRequest[]
  }

  async function runParity(
    ws: TempWorkspace,
    provider: RoutedProvider,
    overrides: Partial<RunAgentOptions> & { onPermission?: (request: PermissionRequest) => Promise<PermissionDecision> } = {}
  ): Promise<HarnessResult> {
    const { onPermission: overridePermission, ...rest } = overrides
    const events: RuntimeEvent[] = []
    const permissionRequests: PermissionRequest[] = []
    const result = await runAgent({
      runId: 'run_parity',
      sessionId: 'session_parity',
      provider,
      model: MODEL,
      systemPrompt: '你是测试助手。',
      history: [],
      userMessage: userMessage('START'),
      workspace: ws.root,
      permissionMode: 'auto',
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async (request) => {
        permissionRequests.push(request)
        return overridePermission ? overridePermission(request) : 'once'
      },
      onAskUser: async (): Promise<AskUserAnswer> => ({ value: 'ok', label: 'OK' }),
      maxSteps: 20,
      ...rest
    })
    return { result, events, provider, permissionRequests }
  }

  function taskBlocks(result: Awaited<ReturnType<typeof runAgent>>) {
    return result.messages
      .flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use' && block.name === 'task')
  }

  /** 主代理首轮 → 一个 task；子代理首轮 → 指定工具；子代理第二轮 → 文本；主代理第二轮 → 文本 */
  function singleTaskRouter(childRoute: (secondRound: boolean) => Route, taskId = 'task_1'): (req: ProviderStreamRequest) => Route {
    return (request) => {
      const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
      const text = lastUser?.content.find((block) => block.type === 'text')
      const prompt = text && text.type === 'text' ? text.text : ''
      if (/CHILD-/.test(prompt)) return childRoute(request.messages.length > 1)
      if (request.messages.length > 1) return { text: '主代理汇总完成。' }
      return {
        text: '我把任务拆给一个子代理。',
        toolCalls: [
          {
            id: taskId,
            name: 'task',
            input: { description: '子任务', prompt: 'CHILD-A 请执行子任务并返回结果' }
          }
        ]
      }
    }
  }

  describe('R9.1 子代理工具/权限与主代理一致', () => {
    it('子代理的 token 用量计入父运行总用量', async () => {
      const ws = makeTempWorkspace({ 'in/a.txt': 'A' })
      try {
        const provider = new RoutedProvider(singleTaskRouter(() => ({ text: '子代理完成' })))
        const harness = await runParity(ws, provider)
        expect(harness.result.reason).toBe('complete')
        // 每次 provider.stream（父/子）都回报 10/5；父结果必须包含子代理消耗
        expect(harness.result.usage.inputTokens).toBe(provider.calls.length * 10)
        expect(harness.result.usage.outputTokens).toBe(provider.calls.length * 5)
      } finally {
        ws.cleanup()
      }
    })

    it('子代理继承会话的推理强度', async () => {
      const ws = makeTempWorkspace({ 'in/a.txt': 'A' })
      try {
        const provider = new RoutedProvider(singleTaskRouter(() => ({ text: '子代理完成' })))
        const harness = await runParity(ws, provider, { reasoningEffort: 'high' })
        expect(harness.result.reason).toBe('complete')
        const childCall = provider.calls.find((call) => call.kind === 'child')
        expect(childCall?.reasoning).toEqual({ effort: 'high', style: 'effort' })
      } finally {
        ws.cleanup()
      }
    })

    it('子代理工具集 = 主代理工具集 - task/swarm - update_goal（含 write_file/run_command/mcp_call）', async () => {
      const ws = makeTempWorkspace({ 'in/a.txt': 'A' })
      try {
        const provider = new RoutedProvider(singleTaskRouter(() => ({ text: '子代理完成' })))
        const harness = await runParity(ws, provider)
        expect(harness.result.reason).toBe('complete')
        const childCall = provider.calls.find((call) => call.kind === 'child')
        expect(childCall).toBeTruthy()
        const childTools = new Set(childCall?.toolNames ?? [])
        expect(childTools.has('read_file')).toBe(true)
        expect(childTools.has('write_file')).toBe(true)
        expect(childTools.has('run_command')).toBe(true)
        expect(childTools.has('mcp_call')).toBe(true)
        expect(childTools.has('task')).toBe(false)
        expect(childTools.has('swarm')).toBe(false)
        expect(childTools.has('update_goal')).toBe(false)
        expect(childTools.has('todo_write')).toBe(false)
      } finally {
        ws.cleanup()
      }
    })

    it('只读父任务 → 子代理写文件被权限层拒绝（文件不落盘，失败保留在 failedTools）', async () => {
      const ws = makeTempWorkspace({ 'in/a.txt': 'A' })
      try {
        const provider = new RoutedProvider(
          singleTaskRouter((secondRound) =>
            secondRound
              ? { text: '我无法写入（当前只读）。' }
              : {
                  toolCalls: [
                    {
                      id: 'child_write_ro',
                      name: 'write_file',
                      input: { path: 'out/should-not-exist.txt', content: 'x' }
                    }
                  ]
                }
          )
        )
        const harness = await runParity(ws, provider, { permissionMode: 'read-only' })
        expect(harness.result.reason).toBe('complete')
        expect(existsSync(join(ws.root, 'out/should-not-exist.txt'))).toBe(false)
        // 只读模式下写工具直接拒绝，不弹审批
        expect(harness.events.some((event) => event.type === 'permission_requested')).toBe(false)
        const block = taskBlocks(harness.result)[0]
        const failedTools = block?.result?.meta?.failedTools as string[] | undefined
        expect(failedTools?.some((item) => item.includes('write_file') && /只读|拒绝/.test(item))).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('ask 父任务 → 子代理写文件走父级审批，允许后真实落盘', async () => {
      const ws = makeTempWorkspace()
      try {
        const provider = new RoutedProvider(
          singleTaskRouter((secondRound) =>
            secondRound
              ? { text: '已写入子任务产物。' }
              : { toolCalls: [{ id: 'child_write_ask', name: 'write_file', input: { path: '../once-child.txt', content: 'child-data' } }] }
          )
        )
        const harness = await runParity(ws, provider, { permissionMode: 'ask' })
        expect(harness.result.reason).toBe('complete')
        expect(harness.permissionRequests).toHaveLength(1)
        expect(harness.permissionRequests[0]).toMatchObject({ toolName: 'write_file', risk: 'high' })
        expect(harness.permissionRequests[0].toolUseId).toBe('child_write_ask')
        expect(harness.events.some((event) => event.type === 'permission_requested')).toBe(true)
        expect(readFileSync(join(ws.root, '..', 'once-child.txt'), 'utf8')).toBe('child-data')
        expect(taskBlocks(harness.result)[0]?.status).toBe('success')
      } finally {
        ws.cleanup()
      }
    })

    it('auto 父任务 → 子代理 run_command 直接执行（输出可见，无审批）', async () => {
      const ws = makeTempWorkspace()
      try {
        const command = process.platform === 'win32' ? "Write-Output 'child-ok'" : "echo 'child-ok'"
        const provider = new RoutedProvider(
          singleTaskRouter((secondRound) =>
            secondRound
              ? { text: '命令执行完成。' }
              : { toolCalls: [{ id: 'child_run_auto', name: 'run_command', input: { command } }] }
          )
        )
        const harness = await runParity(ws, provider, { permissionMode: 'auto' })
        expect(harness.result.reason).toBe('complete')
        expect(harness.events.some((event) => event.type === 'permission_requested')).toBe(false)
        const taskBlock = taskBlocks(harness.result)[0]
        expect(taskBlock?.status).toBe('success')
        expect(String(taskBlock?.result?.meta?.status)).toBe('completed')
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('R9.1 同一消息多个 task 真正并发', () => {
    function parallelProvider(childRoute: (label: 'A' | 'B', secondRound: boolean) => Route): RoutedProvider {
      return new RoutedProvider((request) => {
        const lastUser = [...request.messages].reverse().find((message) => message.role === 'user')
        const text = lastUser?.content.find((block) => block.type === 'text')
        const prompt = text && text.type === 'text' ? text.text : ''
        const child = /CHILD-([AB])/.exec(prompt)
        if (child) return childRoute(child[1] as 'A' | 'B', request.messages.length > 1)
        if (request.messages.length > 1) return { text: '两个子任务都完成了。' }
        return {
          text: '我并行派两个子代理。',
          toolCalls: [
            { id: 'task_a', name: 'task', input: { description: '子任务A', prompt: 'CHILD-A 写入 A 文件' } },
            { id: 'task_b', name: 'task', input: { description: '子任务B', prompt: 'CHILD-B 写入 B 文件' } }
          ]
        }
      })
    }

    it('两个 task 的 tool_started 都在任一 task 完成之前（并行而非串行）', async () => {
      const ws = makeTempWorkspace()
      try {
        const provider = parallelProvider((label, secondRound) =>
          secondRound
            ? { text: `子任务 ${label} 完成。` }
            : {
                toolCalls: [
                  {
                    id: `child_write_${label}`,
                    name: 'write_file',
                    input: { path: `../auto-${label.toLowerCase()}.txt`, content: `child-${label}` }
                  }
                ]
              }
        )
        const harness = await runParity(ws, provider, { permissionMode: 'auto' })
        expect(harness.result.reason).toBe('complete')
        // 两个子任务产物独立写入
        expect(readFileSync(join(ws.root, '..', 'auto-a.txt'), 'utf8')).toBe('child-A')
        expect(readFileSync(join(ws.root, '..', 'auto-b.txt'), 'utf8')).toBe('child-B')
        const started = harness.events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool_started' }> =>
            event.type === 'tool_started' && event.block.name === 'task'
        )
        const finished = harness.events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool_finished' }> =>
            event.type === 'tool_finished' && event.toolUseId === 'task_a' || (event.type === 'tool_finished' && event.toolUseId === 'task_b')
        )
        expect(started).toHaveLength(2)
        expect(finished).toHaveLength(2)
        // 串行实现：task_b 的 started 会在 task_a 的 finished 之后；并行实现：两个 started 先全部出现
        const startedB = started.find((event) => event.block.id === 'task_b')
        const finishedA = finished.find((event) => event.toolUseId === 'task_a')
        expect(startedB?.at).toBeLessThanOrEqual(finishedA?.at ?? 0)
        // 子代理确实执行了写工具
        expect(provider.calls.filter((call) => call.kind === 'child')).toHaveLength(4)
      } finally {
        ws.cleanup()
      }
    })

    it('并行子代理的审批串行化：不会同时挂起两个审批，两个写入都需各自批准', async () => {
      const ws = makeTempWorkspace()
      try {
        const provider = parallelProvider((label, secondRound) =>
          secondRound
            ? { text: `子任务 ${label} 完成。` }
            : {
                toolCalls: [
                  {
                    id: `child_write_${label}`,
                    name: 'write_file',
                    input: { path: `../once-${label.toLowerCase()}.txt`, content: `child-${label}` }
                  }
                ]
              }
        )
        let active = 0
        let maxActive = 0
        const harness = await runParity(ws, provider, {
          permissionMode: 'ask',
          onPermission: async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await new Promise((resolve) => setTimeout(resolve, 20))
            active -= 1
            return 'once'
          }
        })
        expect(harness.result.reason).toBe('complete')
        expect(harness.permissionRequests).toHaveLength(2)
        expect(maxActive).toBe(1)
        expect(existsSync(join(ws.root, '..', 'once-a.txt'))).toBe(true)
        expect(existsSync(join(ws.root, '..', 'once-b.txt'))).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('并行子代理审批被拒绝：文件都不落盘，拒绝原因保留在 failedTools', async () => {
      const ws = makeTempWorkspace()
      try {
        const provider = parallelProvider((label, secondRound) =>
          secondRound
            ? { text: `子任务 ${label} 因权限失败。` }
            : { toolCalls: [{ id: `child_write_${label}`, name: 'write_file', input: { path: `../deny-${label}.txt`, content: 'x' } }] }
        )
        const harness = await runParity(ws, provider, {
          permissionMode: 'ask',
          onPermission: async () => 'deny'
        })
        expect(harness.result.reason).toBe('complete')
        expect(existsSync(join(ws.root, '..', 'deny-A.txt'))).toBe(false)
        expect(existsSync(join(ws.root, '..', 'deny-B.txt'))).toBe(false)
        const blocks = taskBlocks(harness.result)
        for (const block of blocks) {
          const failedTools = block.result?.meta?.failedTools as string[] | undefined
          expect(failedTools?.some((item) => item.includes('write_file') && /只读|拒绝/.test(item))).toBe(true)
        }
      } finally {
        ws.cleanup()
      }
    })

    it('父任务 abort → 所有并行子代理取消，task 卡片标记 interrupted', async () => {
      const ws = makeTempWorkspace()
      try {
        const sleepCommand = process.platform === 'win32' ? 'Start-Sleep -Milliseconds 3000' : 'sleep 3'
        const controller = new AbortController()
        const provider = parallelProvider((label, secondRound) =>
          secondRound
            ? { text: `子任务 ${label} 完成。` }
            : { toolCalls: [{ id: `child_run_${label}`, name: 'run_command', input: { command: sleepCommand } }] }
        )
        const providerRouted: Provider = {
          stream(request) {
            return provider.stream(request)
          }
        }
        const events: RuntimeEvent[] = []
        let taskStarts = 0
        const promise = runAgent({
          runId: 'run_parallel_abort',
          sessionId: 'session_parallel_abort',
          provider: providerRouted,
          model: MODEL,
          systemPrompt: 's',
          history: [],
          userMessage: userMessage('START'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: controller.signal,
          emit: (event) => {
            events.push(event)
            if (event.type === 'tool_started' && event.block.name === 'task') {
              taskStarts += 1
              if (taskStarts === 2) setTimeout(() => controller.abort(), 120)
            }
          },
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'ok', label: 'OK' }),
          maxSteps: 20
        })
        const result = await promise
        expect(result.reason).toBe('cancelled')
        const blocks = taskBlocks(result)
        expect(blocks).toHaveLength(2)
        expect(blocks.every((block) => block.status === 'interrupted')).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('subagent-terminal.test.ts', () => {
  /**
   * R9 / R2-B、R2-C、M40-M46：子代理终态不能把失败/耗尽当成功。
   * - 首步模型请求报错 → task 工具 ok=false，原因透传；
   * - 12 步耗尽无最终结论 → task 工具 ok=false（exhausted）；
   * - 子代理工具失败要保留在父任务结果里（不能被“完成”文字覆盖）；
   * - 父任务 abort 要传到子循环（子任务中断、父 run cancelled）。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  async function runWithScript(
    ws: TempWorkspace,
    steps: ConstructorParameters<typeof ScriptedProvider>[0],
    overrides: Partial<RunAgentOptions> = {}
  ): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; events: RuntimeEvent[]; provider: Provider }> {
    const events: RuntimeEvent[] = []
    const provider = new ScriptedProvider(steps)
    const result = await runAgent({
      runId: 'run_subagent_test',
      sessionId: 'session_subagent_test',
      provider,
      model: MODEL,
      systemPrompt: '你是测试助手。',
      history: [],
      userMessage: userMessage('请委派一个子任务'),
      workspace: ws.root,
      permissionMode: 'auto',
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async () => 'once',
      onAskUser: async () => ({ value: 'a', label: 'A' }),
      maxSteps: 20,
      ...overrides
    })
    return { result, events, provider }
  }

  function taskBlockFrom(result: Awaited<ReturnType<typeof runAgent>>): { status?: string; result?: { ok: boolean; output: string; error?: string; hint?: string; meta?: Record<string, unknown> } } | undefined {
    for (const message of result.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.name === 'task') return block
      }
    }
    return undefined
  }

  describe('R2-B：子代理首步模型请求报错', () => {
    it('外层 task 必须失败（ok=false）并保留原始失败原因', async () => {
      const ws = makeTempWorkspace({ 'in/n.txt': '7' })
      try {
        const { result, events } = await runWithScript(ws, [
          { toolCalls: [{ name: 'task', input: { description: '读取 n.txt', prompt: '读取 in/n.txt 并返回数值' } }] },
          { error: { message: 'synthetic_child_request_error', code: 'server_error', retryable: false } },
          { text: '子代理请求失败，我改用主代理直接读取。' }
        ])
        expect(result.reason).toBe('complete')
        const block = taskBlockFrom(result)
        expect(block?.status).toBe('error')
        expect(block?.result?.ok).toBe(false)
        expect(String(block?.result?.error ?? '')).toContain('synthetic_child_request_error')
        expect(block?.result?.meta).toMatchObject({ status: 'failed' })
        // 失败不能吞成 ok=true 的“摘要”
        expect(block?.result?.output ?? '').not.toContain('子代理摘要')
        expect(events.some((event) => event.type === 'error')).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('R2-C：子代理 12 步耗尽无结论', () => {
    it('task 返回 exhausted/ok=false，不能把工具调用成功当任务完成', async () => {
      const ws = makeTempWorkspace({ 'in/n.txt': '7', 'a.txt': 'a' })
      try {
        const steps: ConstructorParameters<typeof ScriptedProvider>[0] = [
          { toolCalls: [{ name: 'task', input: { description: '持续读取', prompt: '读取 a.txt，反复确认直到给出结论' } }] }
        ]
        // 子代理原生上限 12 步：每步只调用读取工具、不给最终答案
        for (let step = 0; step < 12; step += 1) {
          steps.push({ toolCalls: [{ name: 'read_file', input: { path: 'in/n.txt' } }] })
        }
        steps.push({ text: '子代理耗尽步数，我改用主代理。' })
        const { result } = await runWithScript(ws, steps)
        expect(result.reason).toBe('complete')
        const block = taskBlockFrom(result)
        expect(block?.status).toBe('error')
        expect(block?.result?.ok).toBe(false)
        expect(String(block?.result?.error ?? '')).toMatch(/最大步数|步数上限/)
        expect(block?.result?.meta).toMatchObject({ status: 'exhausted', steps: 12 })
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('M46：子代理工具失败不能被“完成”文字覆盖', () => {
    it('completed 时仍保留 failedTools，并提示父任务结论可能不完整', async () => {
      const ws = makeTempWorkspace({ 'in/n.txt': '7' })
      try {
        const { result } = await runWithScript(ws, [
          { toolCalls: [{ name: 'task', input: { description: '读取缺失文件', prompt: '读取 missing.txt' } }] },
          {
            text: '我先尝试读取。',
            toolCalls: [{ name: 'read_file', input: { path: 'missing.txt' } }]
          },
          { text: '结论：该文件不存在，无法返回数值。' },
          { text: '收到子代理结论。' }
        ])
        expect(result.reason).toBe('complete')
        const block = taskBlockFrom(result)
        expect(block?.status).toBe('success')
        expect(block?.result?.meta).toMatchObject({ status: 'completed' })
        const failedTools = block?.result?.meta?.failedTools as string[] | undefined
        expect(failedTools?.length).toBeGreaterThanOrEqual(1)
        expect(String(block?.result?.output ?? '')).toContain('工具失败')
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('父任务 abort 传播到子循环', () => {
    it('取消父任务时子代理也中断，run 以 cancelled 收尾', async () => {
      const ws = makeTempWorkspace()
      try {
        const controller = new AbortController()
        const provider: Provider = {
          async *stream() {
            if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            yield {
              type: 'tool_call_start',
              index: 0,
              id: 'call_task_abort',
              name: 'task'
            }
            yield {
              type: 'tool_call_delta',
              index: 0,
              argsDelta: JSON.stringify({ description: '慢任务', prompt: '执行一个慢任务' })
            }
            yield {
              type: 'tool_call_end',
              index: 0,
              id: 'call_task_abort',
              name: 'task',
              input: { description: '慢任务', prompt: '执行一个慢任务' }
            }
            // 父任务第一轮结束后：子代理循环会再次调用 provider（这个生成器每次都是同一逻辑）
            if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 400)
              controller.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  resolve()
                },
                { once: true }
              )
            })
            if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        const promise = runAgent({
          runId: 'run_abort_sub',
          sessionId: 'session_abort_sub',
          provider,
          model: MODEL,
          systemPrompt: 's',
          history: [],
          userMessage: userMessage('委派慢任务'),
          workspace: ws.root,
          permissionMode: 'auto',
          snapshotDir: ws.snapshotDir,
          signal: controller.signal,
          emit: () => undefined,
          onPermission: async () => 'once',
          onAskUser: async () => ({ value: 'a', label: 'A' }),
          maxSteps: 10
        })
        await new Promise((resolve) => setTimeout(resolve, 120))
        controller.abort()
        const result = await promise
        expect(result.reason).toBe('cancelled')
        const block = taskBlockFrom(result)
        expect(block?.status).toBe('interrupted')
      } finally {
        ws.cleanup()
      }
    })
  })
})
