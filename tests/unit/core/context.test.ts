import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../src/shared/types'
import {
  addUsage,
  applyCompaction,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  hasDanglingToolUse,
  localExtractSummary,
  planCompaction,
  serializeMessagesForSummary
} from '../../../src/core/context'

function message(role: ChatMessage['role'], text: string, createdAt = Date.now()): ChatMessage {
  return { id: `${role}-${Math.random().toString(36).slice(2)}`, role, content: [{ type: 'text', text }], createdAt }
}

describe('estimateTokens', () => {
  it('中文按 1 字 1 token，英文约 4 字符 1 token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('a你')).toBe(2)
  })

  it('消息估算包含 tool_use 参数与结果', () => {
    const withTool: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      createdAt: Date.now(),
      content: [
        { type: 'text', text: '我来读文件' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'read_file',
          title: '读取 a.txt',
          category: 'read',
          input: { path: 'a.txt' },
          status: 'success',
          result: { ok: true, output: '文件内容'.repeat(20) }
        }
      ]
    }
    expect(estimateMessageTokens(withTool)).toBeGreaterThan(20)
    expect(estimateMessagesTokens([withTool], '系统提示')).toBeGreaterThan(estimateMessageTokens(withTool))
  })
})

describe('planCompaction', () => {
  it('未超过阈值不压缩', () => {
    const messages = [message('user', '短消息'), message('assistant', '短回复')]
    const plan = planCompaction(messages, 'system', 128_000)
    expect(plan.shouldCompact).toBe(false)
    expect(plan.reason).toBe('below-threshold')
  })

  it('超过 80% 阈值时在 user 消息边界切割，并额外保留原始用户消息', () => {
    const messages: ChatMessage[] = []
    for (let i = 0; i < 20; i += 1) {
      messages.push(message(i % 2 === 0 ? 'user' : 'assistant', '内容'.repeat(800)))
    }
    const plan = planCompaction(messages, '', 2000, { keepRecent: 8 })
    expect(plan.shouldCompact).toBe(true)
    expect(plan.cutIndex).toBeGreaterThan(0)
    expect(messages[plan.cutIndex].role).toBe('user')
    expect(plan.cutKind).toBe('user')
    expect(plan.preserveCount).toBe(1)
    expect(plan.keepCount).toBe(messages.length - plan.cutIndex + 1)
    expect(plan.savedTokens).toBeGreaterThan(0)
  })

  it('单用户长工具链（没有第二个 user 边界）也能在完整工具对之后切分', () => {
    const messages: ChatMessage[] = [message('user', '只读材料并合计，禁止外发')]
    for (let i = 0; i < 20; i += 1) {
      messages.push(message('assistant', '这是一段很长的工具回合结果'.repeat(300)))
    }
    const plan = planCompaction(messages, '', 2000, { keepRecent: 8 })
    expect(plan.shouldCompact).toBe(true)
    expect(plan.cutIndex).toBeGreaterThan(0)
    expect(plan.cutKind).toBe('tool-pair')
    expect(messages[plan.cutIndex].role).toBe('assistant')
    expect(plan.preserveCount).toBe(1)
    expect(plan.shouldCompact && plan.keepCount).toBe(messages.length - plan.cutIndex + 1)
    expect(plan.savedTokens).toBeGreaterThan(0)
  })

  it('进行中的工具调用（tool_use 无结果）时拒绝压缩', () => {
    const dangling: ChatMessage = {
      id: 'dangling',
      role: 'assistant',
      createdAt: Date.now(),
      content: [
        { type: 'text', text: '读取中' },
        { type: 'tool_use', id: 'call_pending', name: 'read_file', title: '读取', category: 'read', input: {}, status: 'running' }
      ]
    }
    const messages: ChatMessage[] = [message('user', '问题'), ...Array.from({ length: 20 }, (_, i) => message('assistant', '长内容'.repeat(400))), dangling]
    const plan = planCompaction(messages, '', 2000, { keepRecent: 8 })
    expect(plan.shouldCompact).toBe(false)
    expect(plan.reason).toBe('no-safe-cut')
  })

  it('历史不足以切出有效压缩时拒绝（消息数不超过 keepRecent）', () => {
    const messages = [message('user', '问题'), message('assistant', '回答'.repeat(500))]
    const plan = planCompaction(messages, '', 2000, { keepRecent: 8, force: true })
    expect(plan.shouldCompact).toBe(false)
    expect(plan.reason).toBe('no-safe-cut')
  })
})

describe('压缩与序列化', () => {
  it('applyCompaction 用 system 摘要替换旧历史，并保留原始用户消息', () => {
    const messages = [message('user', '旧问题（含禁止外发约束）'), message('assistant', '旧回答'), message('user', '新问题')]
    const result = applyCompaction(messages, 2, '用户先问了旧问题')
    // 摘要 + 原始用户消息（约束）+ 保留段
    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('system')
    expect(result[0].content[0]).toMatchObject({ type: 'text' })
    expect(result[1].content[0]).toMatchObject({ type: 'text', text: '旧问题（含禁止外发约束）' })
    expect(result[2].content[0]).toMatchObject({ type: 'text', text: '新问题' })
  })

  it('serializeMessagesForSummary 保留工具调用痕迹并截断', () => {
    const messages: ChatMessage[] = [
      message('user', '帮我读文件'),
      {
        id: 'a2',
        role: 'assistant',
        createdAt: Date.now(),
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read_file',
            title: '读取',
            category: 'read',
            input: {},
            status: 'success',
            result: { ok: true, output: '文件内容' }
          }
        ]
      }
    ]
    const text = serializeMessagesForSummary(messages)
    expect(text).toContain('用户')
    expect(text).toContain('read_file')
    const truncated = serializeMessagesForSummary(messages, 10)
    expect(truncated.length).toBeLessThanOrEqual(80)
  })

  it('localExtractSummary 产出可读兜底摘要', () => {
    const summary = localExtractSummary([message('user', '目标：做一份报告'), message('assistant', '已完成')])
    expect(summary).toContain('目标：做一份报告')
  })

  it('hasDanglingToolUse 检测未回填的 tool_use', () => {
    const okMessage: ChatMessage = {
      id: 'a',
      role: 'assistant',
      createdAt: Date.now(),
      content: [
        {
          type: 'tool_use',
          id: 'call',
          name: 'read_file',
          title: '读取',
          category: 'read',
          input: {},
          status: 'success',
          result: { ok: true, output: '' }
        }
      ]
    }
    expect(hasDanglingToolUse([okMessage])).toBe(false)
    const dangling = { ...okMessage, content: [{ ...okMessage.content[0], result: undefined }] } as ChatMessage
    expect(hasDanglingToolUse([dangling])).toBe(true)
  })

  it('addUsage 累加 token', () => {
    const merged = addUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3, outputTokens: 7, cacheReadTokens: 2 })
    expect(merged).toEqual({ inputTokens: 13, outputTokens: 12, cacheReadTokens: 2 })
  })
})
