import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationRuntime, CollaborationStore } from '../../src/main/collaboration'
import { workerAskTool, workerMessageTool, workerTodoTool } from '../../src/core/tool-extra'
import type { ToolContext } from '../../src/core/types'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'morrow-worker-test') },
  BrowserWindow: class {},
  session: {},
  shell: { openPath: async () => '' },
  clipboard: {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

const PROJECT = 'proj_worker_test'
let dataDir = ''
let store: CollaborationStore
let runtime: CollaborationRuntime

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    messageId: 'm1',
    toolUseId: 't1',
    workspace: null,
    permissionMode: 'auto',
    snapshotDir: '',
    signal: new AbortController().signal,
    depth: 1,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    planMode: false,
    projectId: PROJECT,
    taskId: 'task_a',
    attemptId: 'attempt_1',
    getPlan: () => null,
    proposePlan: (plan) => plan,
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => [],
    setTodos: () => undefined,
    getArtifacts: () => [],
    addArtifact: () => undefined,
    askUser: async () => ({ value: 'ok', label: 'ok' }),
    progress: () => undefined,
    collaborationRuntime: runtime,
    ...overrides
  } as ToolContext
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'morrow-worker-collab-'))
  store = new CollaborationStore(dataDir)
  runtime = new CollaborationRuntime(store)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('worker-collaboration.test.ts', () => {
  it('@core:swarm 协作消息区分主代理指令、Worker 汇报与提问，安全步只投递指令', () => {
    store.enqueueMessage({
      projectId: PROJECT,
      taskId: 'task_a',
      text: '优先保留现有接口',
      idempotencyKey: 'main-1',
      direction: 'main',
      kind: 'directive'
    })
    store.enqueueMessage({
      projectId: PROJECT,
      taskId: 'task_a',
      text: '发现旧接口没有被任何页面引用',
      idempotencyKey: 'worker-1',
      direction: 'worker',
      kind: 'note',
      author: '代码侦察'
    })
    const question = store.enqueueMessage({
      projectId: PROJECT,
      taskId: 'task_a',
      text: '要直接删旧接口吗？',
      idempotencyKey: 'worker-2',
      direction: 'worker',
      kind: 'question',
      author: '代码侦察'
    })

    const drained = store.drainMessages({ projectId: PROJECT, taskId: 'task_a', attemptId: 'attempt_1' })
    expect(drained).toHaveLength(1)
    expect(drained[0]?.text).toBe('优先保留现有接口')
    expect(drained[0]?.direction).toBe('main')

    const reloaded = new CollaborationStore(dataDir).projection(PROJECT)
    expect(reloaded.messages).toHaveLength(3)
    expect(reloaded.messages.find((message) => message.id === question.id)?.kind).toBe('question')
    expect(reloaded.messages.find((message) => message.kind === 'note')?.direction).toBe('worker')
  })

  it('@core:swarm Worker 提问可等待主代理答复，答复后问题标记已采用', async () => {
    const posted = runtime.postTaskMessage({
      projectId: PROJECT,
      taskId: 'task_a',
      attemptId: 'attempt_1',
      text: '登录入口要保留吗？',
      kind: 'question',
      author: '代码侦察'
    })
    const waiting = runtime.waitForTaskReply({
      projectId: PROJECT,
      taskId: 'task_a',
      questionId: posted.message.id,
      signal: new AbortController().signal
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    store.enqueueMessage({
      projectId: PROJECT,
      taskId: 'task_a',
      text: '保留，只补测试',
      idempotencyKey: 'answer-1',
      direction: 'main',
      kind: 'answer',
      replyTo: posted.message.id
    })
    await expect(waiting).resolves.toMatchObject({ text: '保留，只补测试' })
    const projection = store.projection(PROJECT)
    expect(projection.messages.find((message) => message.id === posted.message.id)?.status).toBe('adopted')
  })

  it('@core:swarm Worker 专用工具可回消息、提问和更新自己的待办', async () => {
    const emitted: string[] = []
    const ctx = context({
      emit: (event) => {
        emitted.push(event.type)
      }
    })

    const message = await workerMessageTool.execute({ text: '已完成接口定位' }, ctx)
    expect(message.ok).toBe(true)
    expect(message.meta).toMatchObject({ direction: 'worker', kind: 'note' })

    const todoResult = await workerTodoTool.execute(
      { todos: [{ text: '读接口', status: 'completed' }, { text: '补测试', status: 'in_progress' }] },
      context({
        workerTodos: {
          get: () => [],
          set: (todos) => {
            emitted.push(`todos:${todos.length}:${todos[1]?.status}`)
          }
        }
      })
    )
    expect(todoResult.ok).toBe(true)
    expect(todoResult.output).toContain('[x] 读接口')
    expect(emitted).toContain('todos:2:in_progress')

    const asking = workerAskTool.execute({ text: '是否保留旧字段？' }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const question = store.projection(PROJECT).messages.find((item) => item.kind === 'question')
    expect(question).toBeTruthy()
    store.enqueueMessage({
      projectId: PROJECT,
      taskId: 'task_a',
      text: '保留，兼容旧调用',
      idempotencyKey: 'answer-2',
      direction: 'main',
      kind: 'answer',
      replyTo: question!.id
    })
    const answer = await asking
    expect(answer.ok).toBe(true)
    expect(answer.output).toContain('保留，兼容旧调用')
    expect(emitted).toContain('collaboration_updated')
  })

  it('@core:swarm 重新激活带原线程和新指令进入 Worker', async () => {
    const { swarmTool } = await import('../../src/core/tool-extra')
    let seen: import('../../src/core/types').SwarmMemberRequest | null = null
    const base = context({
      collaborationRuntime: runtime,
      runSwarmMember: async (request) => {
        seen = request
        return {
          status: 'completed',
          summary: '已按新指令继续',
          steps: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          history: [
            { role: 'user', text: '旧目标', at: 1 },
            { role: 'assistant', text: '旧结论', at: 2 },
            { role: 'user', text: '这次补测试', at: 3 }
          ],
          workerTodos: [{ id: 'w1', text: '补测试', status: 'completed' }]
        }
      }
    })
    const task = {
      id: 'task_a',
      taskId: 'task_a',
      planKey: 'task_a',
      index: 0,
      title: '补测试',
      prompt: '补登录测试',
      promptFull: '补登录测试',
      deliverable: '测试通过',
      role: 'general',
      status: 'completed' as const,
      dependsOn: [],
      attempts: 1,
      workerHistory: [
        { role: 'user' as const, text: '旧目标', at: 1 },
        { role: 'assistant' as const, text: '旧结论', at: 2 }
      ]
    }
    const result = await swarmTool.execute(
      {
        goal: '登录流程',
        tasks: [{ id: 'task_a', title: '补测试', prompt: '补登录测试', deliverable: '测试通过' }],
        max_parallel: 1
      },
      context({
        ...base,
        depth: 0,
        resumeSwarmTask: {
          projectId: PROJECT,
          runId: 'super_run',
          goal: '登录流程',
          task,
          instruction: '这次补测试'
        }
      })
    )
    expect(result.ok).toBe(true)
    expect(seen).not.toBeNull()
    expect(seen!.history?.map((entry) => entry.text)).toEqual(['旧目标', '旧结论'])
    expect(seen!.instruction).toBe('这次补测试')
  })

  it('@core:swarm 共享工作区按声明文件加租约，同一文件不会被两个 Worker 同时写', async () => {
    const events: string[] = []
    const runSwarmMember = async (request: import('../../src/core/types').SwarmMemberRequest) => {
      events.push(`${request.description}:start`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      events.push(`${request.description}:end`)
      return { status: 'completed' as const, summary: `${request.description} 完成`, steps: 1, usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const { swarmTool } = await import('../../src/core/tool-extra')
    const result = await swarmTool.execute(
      {
        goal: '改同一个文件',
        max_parallel: 2,
        tasks: [
          { id: 'a', title: 'A', prompt: '写 A', deliverable: 'A', files: ['src/shared.ts'] },
          { id: 'b', title: 'B', prompt: '写 B', deliverable: 'B', files: ['src/shared.ts'] }
        ]
      },
      context({ depth: 0, runSwarmMember })
    )
    expect(result.ok).toBe(true)
    expect(events.slice(0, 4)).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('@core:swarm 不同文件可以真正并行启动', async () => {
    const events: string[] = []
    const runSwarmMember = async (request: import('../../src/core/types').SwarmMemberRequest) => {
      events.push(`${request.description}:start`)
      await new Promise((resolve) => setTimeout(resolve, 60))
      events.push(`${request.description}:end`)
      return { status: 'completed' as const, summary: `${request.description} 完成`, steps: 1, usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const { swarmTool } = await import('../../src/core/tool-extra')
    const result = await swarmTool.execute(
      {
        goal: '并行改两个文件',
        max_parallel: 2,
        tasks: [
          { id: 'a', title: 'A', prompt: '写 A', deliverable: 'A', files: ['src/a.ts'] },
          { id: 'b', title: 'B', prompt: '写 B', deliverable: 'B', files: ['src/b.ts'] }
        ]
      },
      context({ depth: 0, runSwarmMember })
    )
    expect(result.ok).toBe(true)
    expect(events.slice(0, 2)).toEqual(['A:start', 'B:start'])
  })
})
