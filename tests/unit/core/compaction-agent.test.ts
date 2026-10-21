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
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ModelInfo, RuntimeEvent } from '../../../src/shared/types'
import type { Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../../src/core/types'
import { runAgent } from '../../../src/core/agent'
import { estimateMessagesTokens, hasDanglingToolUse } from '../../../src/core/context'
import { expectValidAnthropicSequence, expectValidOpenAISequence } from './helpers/compaction-validators'
import { makeTempWorkspace } from './helpers/workspace'

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
