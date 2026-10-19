/**
 * R9 / R2-H：单用户长工具链的安全压缩（planCompaction / applyCompaction 直接验证）。
 *
 * 覆盖：
 * - 单条 user + 多轮 assistant(tool_use+result) 达到阈值时能切分压缩（不再依赖第二条 user 消息）；
 * - 压缩后保留原始用户约束、最近工具结果、剩余状态；token 真实变短；
 * - 不产生孤立 tool_use / tool_result：内部消息与 OpenAI / Anthropic 两种协议序列都合法；
 * - 进行中（tool_use 无 result）时拒绝压缩。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolUseBlock } from '../../../src/shared/types'
import {
  applyCompaction,
  estimateMessagesTokens,
  hasDanglingToolUse,
  planCompaction
} from '../../../src/core/context'
import {
  expectValidAnthropicSequence,
  expectValidOpenAISequence
} from './helpers/compaction-validators'

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
