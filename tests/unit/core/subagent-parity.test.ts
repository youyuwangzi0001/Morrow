/**
 * R9.1 子代理全权限 + 真实并行测试。
 * - 子代理工具集与主代理一致（排除 task 防嵌套、update_goal 仅主代理）；
 * - 子代理 write_file/run_command/mcp_call 走主代理同一套权限链（ask/auto/read-only）；
 * - 同一 assistant 消息里多个 task 调用真正并发（时间线重叠）；
 * - 并行审批串行（不会同时挂起多个审批卡）；拒绝/abort 正确传播。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AskUserAnswer,
  ChatMessage,
  ModelInfo,
  PermissionDecision,
  PermissionRequest,
  RuntimeEvent
} from '../../../src/shared/types'
import { runAgent, type RunAgentOptions } from '../../../src/core/agent'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../../src/core/types'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

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
      toolNames: request.tools.map((tool) => tool.name)
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
  it('子代理工具集 = 主代理工具集 - task - update_goal（含 write_file/run_command/mcp_call）', async () => {
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
      expect(childTools.has('update_goal')).toBe(false)
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
            : { toolCalls: [{ id: 'child_write_ask', name: 'write_file', input: { path: 'out/child.txt', content: 'child-data' } }] }
        )
      )
      const harness = await runParity(ws, provider, { permissionMode: 'ask' })
      expect(harness.result.reason).toBe('complete')
      expect(harness.permissionRequests).toHaveLength(1)
      expect(harness.permissionRequests[0]).toMatchObject({ toolName: 'write_file', risk: 'medium' })
      expect(harness.permissionRequests[0].toolUseId).toBe('child_write_ask')
      expect(harness.events.some((event) => event.type === 'permission_requested')).toBe(true)
      expect(readFileSync(join(ws.root, 'out/child.txt'), 'utf8')).toBe('child-data')
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
                  input: { path: `out/${label.toLowerCase()}.txt`, content: `child-${label}` }
                }
              ]
            }
      )
      const harness = await runParity(ws, provider, { permissionMode: 'auto' })
      expect(harness.result.reason).toBe('complete')
      // 两个子任务产物独立写入
      expect(readFileSync(join(ws.root, 'out/a.txt'), 'utf8')).toBe('child-A')
      expect(readFileSync(join(ws.root, 'out/b.txt'), 'utf8')).toBe('child-B')
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
                  input: { path: `out/${label.toLowerCase()}.txt`, content: `child-${label}` }
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
      expect(existsSync(join(ws.root, 'out/a.txt'))).toBe(true)
      expect(existsSync(join(ws.root, 'out/b.txt'))).toBe(true)
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
          : { toolCalls: [{ id: `child_write_${label}`, name: 'write_file', input: { path: `out/${label}.txt`, content: 'x' } }] }
      )
      const harness = await runParity(ws, provider, {
        permissionMode: 'ask',
        onPermission: async () => 'deny'
      })
      expect(harness.result.reason).toBe('complete')
      expect(existsSync(join(ws.root, 'out/A.txt'))).toBe(false)
      expect(existsSync(join(ws.root, 'out/B.txt'))).toBe(false)
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
