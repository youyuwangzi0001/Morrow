import { describe, expect, it } from 'vitest'
import {
  applyModelCompaction,
  estimateMessagesTokens,
  planCompaction
} from '../../src/core/agent'
import type { ChatMessage, ToolUseBlock } from '../../src/shared/types'

/**
 * 目标比例（Settings.compactTargetRatio，默认 15%）只是偏好，不是硬门槛：
 * - 能压得更小就压得更小（历史短时可能远低于 10%）；
 * - 压不到目标也不放弃压缩，取「保住近期历史前提下能压到的最大值」；
 * - 连近期历史都保不住时，才退到全局最小。
 */

let idc = 0
const nextId = (p: string): string => `${p}-${(idc += 1)}`

function userMessage(text: string): ChatMessage {
  return { id: nextId('u'), role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
}

function toolTurn(value: number, padding: number): ChatMessage {
  const block: ToolUseBlock = {
    type: 'tool_use',
    id: nextId('call'),
    name: 'read_file',
    title: `读取第 ${value} 组材料`,
    category: 'read',
    input: { path: `in/m${value}.txt` },
    status: 'success',
    result: { ok: true, output: `value=${value}\n${'材料内容 '.repeat(padding)}` }
  }
  return {
    id: nextId('a'),
    role: 'assistant',
    content: [{ type: 'text', text: `已读取第 ${value} 组材料。` }, block],
    createdAt: Date.now()
  }
}

/** 一条超大工具结果夹在中间：切到它之后能压得很小，但会丢掉近期历史 */
function withHugeMiddleTurn(): ChatMessage[] {
  return [
    userMessage('读大文件并总结；不要外发。'),
    toolTurn(1, 100),
    toolTurn(2, 50_000),
    toolTurn(3, 100),
    toolTurn(4, 100)
  ]
}

function pct(tokens: number, limit: number): number {
  return (tokens / limit) * 100
}

describe('压缩目标只是偏好，不是硬门槛', () => {
  it('@core:context 历史里有超大消息时可以压到 10% 以下，不被下限拦住', () => {
    const limit = 400_000
    const messages = withHugeMiddleTurn()
    const before = estimateMessagesTokens(messages, '')
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    // 能压得很小就压得很小：远低于 MIN_TARGET_RATIO(10%)
    expect(plan.afterTokens).toBeDefined()
    expect(pct(plan.afterTokens!, limit)).toBeLessThan(10)
    expect(plan.afterTokens!).toBeLessThan(before)
  })

  it('@core:context 历史消息过多压不到目标时，仍按能压到的最优值压缩，不放弃', () => {
    const limit = 200_000
    // 每条 ~12k tokens × 40 条 ≈ 480k，远超窗口；近期预算本身也很大
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 6_000))
    ]
    const before = estimateMessagesTokens(messages, '')
    expect(before).toBeGreaterThan(limit)
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    // 没有被「必须落进 15%」卡住：压后明显变小，且仍保留可接续的近期历史
    expect(plan.afterTokens!).toBeLessThan(before * 0.3)
    expect(plan.keepCount).toBeGreaterThan(1)
  })

  it('@core:context 压到很小也不会清空当前窗口：摘要 + 用户锚点 + 近期消息都在', () => {
    const limit = 400_000
    const messages = withHugeMiddleTurn()
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    const outcome = applyModelCompaction(messages, messages, plan, '摘要正文。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })
    const view = outcome.modelMessages
    // 第一条是摘要标记
    expect(view[0]?.role).toBe('system')
    // 至少一条原文保留的用户约束消息，且内容未被摘要替换
    const users = view.filter((message) => message.role === 'user')
    expect(users.length).toBeGreaterThanOrEqual(1)
    expect(
      users.some((message) =>
        message.content.some((block) => block.type === 'text' && block.text.includes('不要外发'))
      )
    ).toBe(true)
    // 不是「只剩一条摘要」
    expect(view.length).toBeGreaterThan(1)
  })

  it('@core:context 压不到目标时保留近期历史优先于「压得更小」', () => {
    const limit = 200_000
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 6_000))
    ]
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    const outcome = applyModelCompaction(messages, messages, plan, '摘要。', {
      systemPrompt: '',
      contextLimit: limit,
      targetRatio: 0.15
    })
    // 近期历史（最后几条工具结果）仍在模型侧，当前任务可以接续
    const keptOutputs = outcome.modelMessages
      .flatMap((message) => message.content)
      .filter((block): block is ToolUseBlock => block.type === 'tool_use')
      .map((block) => block.result?.output ?? '')
    expect(keptOutputs.length).toBeGreaterThan(0)
    // 压缩后仍显著小于压缩前
    expect(estimateMessagesTokens(outcome.modelMessages, '')).toBeLessThan(
      estimateMessagesTokens(messages, '') * 0.3
    )
  })

  it('@core:context 压完仍高于 20% 也照常压缩，不被目标区间卡住', () => {
    // 40 条 × ~12k tokens，窗口 200k：即使切到最近几轮，模型侧仍在 20% 以上。
    // 旧行为会因为「进不了 15% 目标」而退到最保守的切点，几乎不省；
    // 现在按「保住近期历史前提下能压到的最小值」执行，收益真实存在即可。
    const limit = 200_000
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 6_000))
    ]
    const before = estimateMessagesTokens(messages, '')
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    const afterPct = pct(plan.afterTokens!, limit)
    // 关键：允许超出 20%——只要确实压小了就继续
    expect(afterPct).toBeGreaterThan(20)
    expect(plan.afterTokens!).toBeLessThan(before * 0.1)
  })

  it('@core:context 切点会落到超大消息之前时，不允许把上下文压得更大', () => {
    // 一条 ~85k tokens 的消息夹在中间：切到它之前会让「保留段 + 摘要」反而更大。
    // 这种切点必须被拒绝，否则压缩会把上下文推向上限。
    const limit = 120_000
    const messages: ChatMessage[] = [
      userMessage('读大文件并总结；不要外发。'),
      toolTurn(1, 20_000), // ≈ 80k tokens，单条就占窗口 2/3
      toolTurn(2, 20),
      toolTurn(3, 20),
      toolTurn(4, 20)
    ]
    const before = estimateMessagesTokens(messages, '')
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    if (!plan.shouldCompact) return
    // 压缩结果必须小于压缩前，不能越压越大
    expect(plan.afterTokens!).toBeLessThan(before)
  })

  it('@core:context 压缩后不会超过窗口本身（几条超大消息时也不能越压越大）', () => {
    // 8 条各 ~28k tokens、窗口 200k：最右切点会留下全部巨幅消息，
    // 修复前它会算出「压缩后 220k > 200k 窗口」——压缩把上下文推过了上限。
    const limit = 200_000
    const messages: ChatMessage[] = [
      userMessage('逐段处理并汇总；不要外发。'),
      ...Array.from({ length: 8 }, (_, i) => toolTurn(i + 1, 12_000))
    ]
    const before = estimateMessagesTokens(messages, '')
    expect(before).toBeGreaterThan(limit * 0.9)
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    // 关键：压完必须真的更小，且不能超过窗口
    expect(plan.afterTokens!).toBeLessThan(before)
    expect(plan.afterTokens!).toBeLessThan(limit)
  })

  it('@core:context 单条超大消息在中间时可以压到 10% 以下', () => {
    // 巨型消息之后还有几条小消息：切到它之后能压到 1% 左右（远低于目标区间）
    const limit = 400_000
    const messages: ChatMessage[] = [
      userMessage('读大文件并总结；不要外发。'),
      toolTurn(1, 100),
      toolTurn(2, 50_000),
      toolTurn(3, 100),
      toolTurn(4, 100)
    ]
    const plan = planCompaction(messages, '', limit, { threshold: 0.5, force: true })
    expect(plan.shouldCompact).toBe(true)
    expect(pct(plan.afterTokens!, limit)).toBeLessThan(10)
    expect(plan.afterTokens!).toBeLessThan(estimateMessagesTokens(messages, '') * 0.1)
  })
})