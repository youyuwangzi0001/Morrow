import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AskUserAnswer,
  ChatMessage,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  RuntimeEvent
} from '../../../src/shared/types'
import type { Provider } from '../../../src/core/types'
import {
  compactSession,
  resetAllPermissionGrants,
  runAgent,
  type RunAgentOptions,
  type RunAgentResult
} from '../../../src/core/agent'
import { buildSystemPrompt } from '../../../src/core/prompt'
import { estimateMessagesTokens } from '../../../src/core/context'
import { ScriptedProvider, collectEvents } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

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
        [{ toolCalls: [{ name: 'write_file', input: { path: 'b.txt', content: 'x' } }] }, { text: '完成' }],
        { permissionMode: 'ask' }
      )
      const { events, permissionCalls } = harness
      expect(permissionCalls).toHaveLength(1)
      expect(permissionCalls[0]).toMatchObject({ toolName: 'write_file', category: 'write', risk: 'medium' })
      expect(permissionCalls[0].title).toContain('写入')
      expect(permissionCalls[0].preview?.kind).toBe('diff')
      expect(indexOf(events, 'tool_started')).toBeLessThan(indexOf(events, 'permission_requested'))
      expect(indexOf(events, 'permission_requested')).toBeLessThan(indexOf(events, 'permission_resolved'))
      expect(indexOf(events, 'permission_resolved')).toBeLessThan(indexOf(events, 'tool_progress'))
      expect(indexOf(events, 'tool_progress')).toBeLessThan(indexOf(events, 'tool_finished'))
      const started = events.find((event) => event.type === 'tool_started')
      expect(started?.type === 'tool_started' && started.block.status).toBe('waiting')
      expect(existsSync(join(ws.root, 'b.txt'))).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('拒绝审批：不落盘，工具结果 denied 并回灌给模型', async () => {
    const ws = makeTempWorkspace()
    try {
      const harness = await runScript(
        ws,
        [{ toolCalls: [{ name: 'write_file', input: { path: 'c.txt', content: 'x' } }] }, { text: '那我换个方案。' }],
        { permissionMode: 'ask', onPermission: async () => 'deny' }
      )
      expect(existsSync(join(ws.root, 'c.txt'))).toBe(false)
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

  it('「始终允许」按会话记忆：只有完全相同的调用不再弹审批', async () => {
    const ws = makeTempWorkspace()
    try {
      const first = await runScript(
        ws,
        [{ toolCalls: [{ name: 'write_file', input: { path: 'e.txt', content: '1' } }] }, { text: '完成' }],
        { permissionMode: 'ask', onPermission: async () => 'always' }
      )
      expect(first.permissionCalls).toHaveLength(1)
      // R7 审计修复：同路径但内容不同 = 新的写操作，必须重新询问
      const second = await runScript(
        ws,
        [{ toolCalls: [{ name: 'write_file', input: { path: 'e.txt', content: '2' } }] }, { text: '完成' }],
        { permissionMode: 'ask', onPermission: async () => 'deny' }
      )
      expect(second.permissionCalls).toHaveLength(1)
      expect(readFileSync(join(ws.root, 'e.txt'), 'utf8')).toBe('1')
      // 完全相同的调用（路径+内容一致）命中会话级授权，不再弹审批
      const third = await runScript(
        ws,
        [{ toolCalls: [{ name: 'write_file', input: { path: 'e.txt', content: '1' } }] }, { text: '完成' }],
        { permissionMode: 'ask', onPermission: async () => 'deny' }
      )
      expect(third.permissionCalls).toHaveLength(0)
      expect(readFileSync(join(ws.root, 'e.txt'), 'utf8')).toBe('1')
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
          yield { type: 'tool_call_end', index: 0, id: 'call_pending', name: 'write_file', input: { path: 'f.txt', content: 'x' } }
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
      expect(existsSync(join(ws.root, 'f.txt'))).toBe(false)
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
        { toolCalls: [{ name: 'todo_write', input: { todos: [{ text: '步骤一' }] } }] },
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
