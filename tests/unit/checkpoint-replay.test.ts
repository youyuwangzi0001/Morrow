import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgent } from '../../src/core/agent'
import { CheckpointService } from '../../src/main/session'
import type { ModelInfo } from '../../src/core/types'
import type { ChatMessage, RuntimeEvent, Session, ToolUseBlock, TurnCheckpoint } from '../../src/shared/types'
import { buildCheckpointReplay } from '../../src/shared/checkpoint'
import { ScriptedProvider, makeTempWorkspace } from './helpers'

const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 32_000, supportsTools: true }

function checkpointMessage(): ChatMessage {
  return {
    id: 'u-replay',
    role: 'user',
    content: [{ type: 'text', text: '写文件并读回来。' }],
    createdAt: Date.now()
  }
}

function partialAssistant(keepPath: string, keepHash: string): ChatMessage {
  const content: ToolUseBlock[] = [
    {
      type: 'tool_use',
      id: 'keep',
      name: 'write_file',
      title: '写入 kept.txt',
      category: 'write',
      input: { path: 'kept.txt', content: 'kept' },
      status: 'success',
      result: {
        ok: true,
        output: '已写入 kept.txt',
        meta: { absolutePath: keepPath, afterHash: keepHash },
        durationMs: 2
      },
      startedAt: 1,
      finishedAt: 2
    },
    {
      type: 'tool_use',
      id: 'retry',
      name: 'write_file',
      title: '写入 retry.txt',
      category: 'write',
      input: { path: 'retry.txt', content: 'retry' },
      status: 'error',
      result: { ok: false, output: '', error: '上次失败' },
      startedAt: 3,
      finishedAt: 4
    },
    {
      type: 'tool_use',
      id: 'missing-read',
      name: 'read_file',
      title: '读取 kept.txt',
      category: 'read',
      input: { path: 'kept.txt' },
      status: 'running'
    }
  ]
  return { id: 'a-replay', role: 'assistant', content, createdAt: Date.now(), model: MODEL.id }
}

describe('checkpoint-replay.test.ts', () => {
  it('@core:sessions 检查点恢复分类：成功跳过、失败/未执行重跑、拒绝保留', () => {
    const keepPath = join('C:', 'tmp', 'kept.txt')
    const plan = buildCheckpointReplay(
      [checkpointMessage(), partialAssistant(keepPath, 'hash-keep')],
      'u-replay'
    )
    expect(plan.messageFound).toBe(true)
    expect(plan.assistantMessageId).toBe('a-replay')
    expect(plan.steps.find((step) => step.toolUseId === 'keep')?.action).toBe('skip')
    expect(plan.steps.find((step) => step.toolUseId === 'retry')?.action).toBe('rerun')
    expect(plan.steps.find((step) => step.toolUseId === 'missing-read')?.action).toBe('rerun')
    const denied = partialAssistant(keepPath, 'hash-keep')
    const deniedBlock = denied.content.find(
      (block): block is ToolUseBlock => block.type === 'tool_use' && block.id === 'retry'
    )!
    deniedBlock.status = 'denied'
    deniedBlock.result = { ok: false, output: '', error: '用户拒绝' }
    const deniedPlan = buildCheckpointReplay([checkpointMessage(), denied], 'u-replay')
    expect(deniedPlan.steps.find((step) => step.toolUseId === 'retry')?.action).toBe('denied')
  })

  it('@core:sessions 恢复预览：成功写入被外部修改时阻止恢复', () => {
    const ws = makeTempWorkspace({ 'kept.txt': 'changed' })
    try {
      const checkpoint: TurnCheckpoint = {
        id: 'cp_replay',
        sessionId: 'session_replay',
        messageId: 'u-replay',
        messageIndex: 0,
        label: '恢复测试',
        createdAt: Date.now(),
        files: [],
        todos: [],
        artifactIds: [],
        plan: null
      }
      const dataDir = join(ws.root, '.checkpoint-data')
      mkdirSync(join(dataDir, 'checkpoints', 'session_replay'), { recursive: true })
      writeFileSync(
        join(dataDir, 'checkpoints', 'session_replay', 'cp_replay.json'),
        JSON.stringify(checkpoint),
        'utf8'
      )
      const session = {
        id: 'session_replay',
        workspace: ws.root,
        messages: [checkpointMessage(), partialAssistant(join(ws.root, 'kept.txt'), 'not-the-current-hash')]
      } as unknown as Session
      const service = new CheckpointService({} as never, dataDir)
      const preview = service.replayPreview(session, checkpoint.id)
      expect(preview.skip).toBe(0)
      expect(preview.conflicts).toHaveLength(1)
      expect(preview.steps.find((step) => step.toolUseId === 'keep')?.action).toBe('conflict')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:sessions 从检查点恢复只重跑失败/未执行步骤，保留成功文件', async () => {
    const ws = makeTempWorkspace({ 'kept.txt': 'kept' })
    try {
      const keepPath = join(ws.root, 'kept.txt')
      const history = [checkpointMessage(), partialAssistant(keepPath, 'hash-keep')]
      const events: RuntimeEvent[] = []
      const provider = new ScriptedProvider([{ text: '恢复完成。' }], { defaultText: '完成。' })
      const result = await runAgent({
        runId: 'run_replay',
        sessionId: 'session_replay_run',
        provider,
        model: MODEL,
        systemPrompt: '你是检查点恢复测试助手。',
        history,
        userMessage: {
          id: 'u-resume',
          role: 'user',
          hidden: true,
          content: [{ type: 'text', text: '继续上一轮未完成的工作。' }],
          createdAt: Date.now()
        },
        resume: { assistantMessageId: 'a-replay', toolUseIds: ['retry', 'missing-read'] },
        workspace: ws.root,
        permissionMode: 'auto',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        onPermission: async () => 'once',
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        maxSteps: 6
      })
      expect(result.reason).toBe('complete')
      expect(readFileSync(join(ws.root, 'retry.txt'), 'utf8')).toBe('retry')
      expect(readFileSync(join(ws.root, 'kept.txt'), 'utf8')).toBe('kept')
      const assistant = history[1]
      const blocks = assistant.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
      expect(blocks.find((block) => block.id === 'keep')?.status).toBe('success')
      expect(blocks.find((block) => block.id === 'retry')?.result?.ok).toBe(true)
      expect(blocks.find((block) => block.id === 'missing-read')?.result?.output).toContain('kept')
      const started = events.filter(
        (event): event is Extract<RuntimeEvent, { type: 'tool_started' }> => event.type === 'tool_started'
      )
      expect(started.map((event) => event.block.id).sort()).toEqual(['missing-read', 'retry'])
      expect(provider.calls).toHaveLength(1)
      const providerMessage = provider.calls[0].messages.find((message) => message.id === 'a-replay')
      const providerBlocks = providerMessage?.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      )
      expect(providerBlocks?.find((block) => block.id === 'retry')?.result?.ok).toBe(true)
    } finally {
      ws.cleanup()
    }
  })
})
