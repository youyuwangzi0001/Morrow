import { describe, expect, it } from 'vitest'
import { estimateMessagesTokens, hasDanglingToolUse, runAgent } from '../../src/core/agent'
import type { ChatMessage, ModelInfo, ToolUseBlock } from '../../src/shared/types'
import { ScriptedProvider } from './helpers'

let idc = 0
const nextId = (p: string): string => `${p}-${(idc += 1)}`

function userMessage(text: string): ChatMessage {
  return { id: nextId('u'), role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
}

function toolTurn(value: number, padding: number, dangling = false): ChatMessage {
  const block: ToolUseBlock = {
    type: 'tool_use',
    id: nextId('call'),
    name: 'read_file',
    title: `读取第 ${value} 组材料`,
    category: 'read',
    input: { path: `in/m${value}.txt` },
    status: dangling ? 'running' : 'success'
  }
  if (!dangling) {
    block.result = { ok: true, output: `value=${value}\n${'材料内容 '.repeat(padding)}` }
  }
  return {
    id: nextId('a'),
    role: 'assistant',
    content: [{ type: 'text', text: `已读取第 ${value} 组材料。` }, block],
    createdAt: Date.now()
  }
}

const model: ModelInfo = {
  id: 'test-model',
  label: 'Test',
  contextWindow: 8_000,
  maxOutput: 1_000,
  supportsTools: true
}

function baseOptions(history: ChatMessage[], provider: ScriptedProvider, sessionId: string) {
  return {
    provider,
    model,
    systemPrompt: '你是测试助手。',
    workspace: 'C:/交付成品/Morrow/tmp',
    permissionMode: 'auto' as const,
    sessionId,
    runId: `r-${sessionId}`,
    userMessage: userMessage('继续汇总。'),
    history,
    maxSteps: 2,
    signal: new AbortController().signal,
    snapshotDir: 'C:/交付成品/Morrow/tmp/snapshots',
    onPermission: async () => 'once' as const,
    onAskUser: async () => ({ value: 'A', label: '方案 A' }),
    emit: () => {}
  }
}

describe('上下文不越过设置限额', () => {
  it('@core:context 历史里残留悬空调用时照常压缩，请求被压到限额以内', async () => {
    const history: ChatMessage[] = [
      userMessage('逐段读取材料并汇总 value；不要写文件。'),
      ...Array.from({ length: 11 }, (_, i) => toolTurn(i + 1, 400)),
      toolTurn(12, 400, true)
    ]
    expect(estimateMessagesTokens(history, '')).toBeGreaterThan(8_000)
    expect(hasDanglingToolUse(history)).toBe(true)

    const provider = new ScriptedProvider([{ text: '汇总完成。' }])
    const result = await runAgent(baseOptions(history, provider, 's-dangling'))
    expect(result.reason).toBe('complete')
    expect(provider.calls.length).toBeGreaterThan(0)
    for (const call of provider.calls) {
      expect(estimateMessagesTokens(call.messages, call.system ?? '')).toBeLessThanOrEqual(8_000)
      expect(hasDanglingToolUse(call.messages)).toBe(false)
    }
  })

  it('@core:context 新一轮运行会收尾上次遗留的悬空调用，并发出可解释的提示', async () => {
    const history: ChatMessage[] = [
      userMessage('读取材料。'),
      toolTurn(1, 50),
      toolTurn(2, 50, true) // 上次运行被停止，这条永远没有结果
    ]
    expect(hasDanglingToolUse(history)).toBe(true)

    const events: Array<{ type: string; level?: string; message?: string }> = []
    const provider = new ScriptedProvider([{ text: '继续完成。' }])
    const outcome = await runAgent({
      ...baseOptions(history, provider, 's-stale'),
      emit: (event) => events.push(event as never)
    })

    // 只有一次请求：说明没有落入「上下文异常 → 反复重试」的路径
    expect(provider.calls).toHaveLength(1)
    expect(hasDanglingToolUse(provider.calls[0].messages)).toBe(false)
    // 用户能看到「已清理未完成调用」，而不是只看到超限报错
    const notice = events.find(
      (event) => event.type === 'notice' && typeof event.message === 'string' && event.message.includes('未完成的工具调用')
    )
    expect(notice).toBeTruthy()
    // 记录本身也被修复，不会把「running」永久留在历史里
    expect(hasDanglingToolUse(outcome.messages)).toBe(false)
  })

  it('@core:context 自动压缩被关掉时不静默超限：请求仍被压进设置限额', async () => {
    // 压缩不运行的任何路径（关闭自动压缩、thrashing 停摆、历史无法切段）都不能
    // 变成「直接把 410k 发给 400k 的模型」。超过窗口的请求本来就会被服务端判失败。
    const history: ChatMessage[] = [
      userMessage('逐段读取材料并汇总 value。'),
      ...Array.from({ length: 11 }, (_, i) => toolTurn(i + 1, 400))
    ]
    expect(estimateMessagesTokens(history, '')).toBeGreaterThan(8_000)

    const provider = new ScriptedProvider([{ text: '汇总完成。' }])
    const result = await runAgent({
      ...baseOptions(history, provider, 's-nocompact'),
      autoCompact: false
    })
    expect(result.reason).toBe('complete')
    for (const call of provider.calls) {
      expect(estimateMessagesTokens(call.messages, call.system ?? '')).toBeLessThanOrEqual(8_000)
    }
  })
})