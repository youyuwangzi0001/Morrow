/**
 * 压缩测试共用断言：把内部 ChatMessage[] 转成两种 provider 协议，验证工具配对与首条角色。
 */
import { expect } from 'vitest'
import type { ChatMessage } from '../../../src/shared/types'
import { toOpenAIMessages } from '../../../src/core/providers'
import { toAnthropicMessages } from '../../../src/core/providers'

/** OpenAI 序列合法性：assistant.tool_calls 后面必须紧跟同 id 的 tool 消息，无孤立 tool。 */
export function expectValidOpenAISequence(messages: ChatMessage[]): void {
  const converted = toOpenAIMessages(messages, '你是压缩测试助手。')
  const pending: string[] = []
  for (const message of converted) {
    if (message.role === 'tool') {
      expect(pending.length, `出现孤立 tool 消息：${JSON.stringify(message)}`).toBeGreaterThan(0)
      const expectedId = pending.shift()
      expect(message.tool_call_id).toBe(expectedId)
      continue
    }
    expect(pending, `assistant.tool_calls 后缺少 tool 结果：${JSON.stringify(message)}`).toHaveLength(0)
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) pending.push(call.id)
    }
  }
  expect(pending, '存在没有回填结果的 tool_calls').toHaveLength(0)
}

/** Anthropic 序列合法性：首条 user；user/assistant 交替；每个 tool_result 前面有对应 tool_use。 */
export function expectValidAnthropicSequence(messages: ChatMessage[]): void {
  const converted = toAnthropicMessages(messages, '你是压缩测试助手。')
  expect(converted.messages.length).toBeGreaterThan(0)
  expect(converted.messages[0].role).toBe('user')
  const toolUseIds = new Set<string>()
  const resultIds: string[] = []
  for (let index = 0; index < converted.messages.length; index += 1) {
    const message = converted.messages[index]
    if (index > 0) expect(message.role).not.toBe(converted.messages[index - 1].role)
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') resultIds.push(block.tool_use_id)
    }
  }
  for (const resultId of resultIds) expect(toolUseIds.has(resultId)).toBe(true)
  expect(resultIds).toHaveLength(toolUseIds.size)
}
