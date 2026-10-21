/**
 * 并行子代理的交互卡必须串行：一个子代理在等待审批时，
 * 另一个子代理不能同时弹出审批卡或提问卡（否则后一张会覆盖前一张，任务悬挂）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModelInfo, RuntimeEvent, ToolUseBlock } from '../../../src/shared/types'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../../src/core/types'
import { runAgent } from '../../../src/core/agent'
import { makeTempWorkspace } from './helpers/workspace'

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
        yield { type: 'tool_call_end', index: 0, id: 'write-a', name: 'write_file', input: { path: 'a.txt', content: 'A' } }
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
      expect(existsSync(join(ws.root, 'a.txt'))).toBe(true)

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
