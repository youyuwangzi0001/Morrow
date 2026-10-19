/**
 * R9 / R2-B、R2-C、M40-M46：子代理终态不能把失败/耗尽当成功。
 * - 首步模型请求报错 → task 工具 ok=false，原因透传；
 * - 12 步耗尽无最终结论 → task 工具 ok=false（exhausted）；
 * - 子代理工具失败要保留在父任务结果里（不能被“完成”文字覆盖）；
 * - 父任务 abort 要传到子循环（子任务中断、父 run cancelled）。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModelInfo, RuntimeEvent } from '../../../src/shared/types'
import { runAgent, type RunAgentOptions } from '../../../src/core/agent'
import type { Provider } from '../../../src/core/types'
import { ScriptedProvider } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

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
