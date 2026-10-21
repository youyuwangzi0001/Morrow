import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../src/shared/types'
import { messagePlainText, replaceUserMessageText, userMessageDisplayText } from '../../../src/shared/message'

function message(patch: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg_test',
    role: 'user',
    content: [],
    createdAt: 0,
    ...patch
  }
}

describe('userMessageDisplayText', () => {
  it('优先使用 displayText', () => {
    const item = message({
      displayText: '用户输入',
      content: [{ type: 'text', text: '用户输入\n\n[附件] 内部资料.md：机密正文' }]
    })
    expect(userMessageDisplayText(item)).toBe('用户输入')
  })

  it('旧消息回退到附件块之前的文本', () => {
    const item = message({
      content: [{ type: 'text', text: '用户输入\n\n[附件] 内部资料.md（12 KB，路径：C:\\a.md）：正文' }]
    })
    expect(userMessageDisplayText(item)).toBe('用户输入')
  })

  it('普通文本保持原样', () => {
    const item = message({ content: [{ type: 'text', text: '没有附件' }] })
    expect(userMessageDisplayText(item)).toBe('没有附件')
    expect(messagePlainText(item)).toBe('没有附件')
  })
})

describe('replaceUserMessageText', () => {
  it('只替换用户输入，保留附件内容与元数据', () => {
    const item = message({
      displayText: '用户输入',
      attachments: [{ name: '内部资料.md', size: 12, kind: 'text' }],
      content: [{ type: 'text', text: '用户输入\n\n[附件] 内部资料.md：机密正文' }]
    })
    const next = replaceUserMessageText(item, '新输入')
    expect(next.displayText).toBe('新输入')
    expect(next.content[0]).toMatchObject({ type: 'text', text: '新输入\n\n[附件] 内部资料.md：机密正文' })
    expect(next.attachments).toEqual(item.attachments)
  })

  it('仅附件的旧消息也能在补充文字后保留附件', () => {
    const item = message({ content: [{ type: 'text', text: '[附件] data.csv：a,b' }] })
    const next = replaceUserMessageText(item, '看看这个')
    expect(String(next.content[0]?.type === 'text' ? next.content[0].text : '')).toContain('看看这个')
    expect(String(next.content[0]?.type === 'text' ? next.content[0].text : '')).toContain('data.csv')
  })
})
