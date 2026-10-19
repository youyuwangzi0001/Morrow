import { describe, expect, it } from 'vitest'
import { SensitiveGuard } from '../../../src/main/services/output-guard'

describe('SensitiveGuard（M32 隐私输出守卫）', () => {
  it('遮蔽工具结果中出现过的邮箱、用户名与 token 值', () => {
    const guard = new SensitiveGuard()
    guard.observe('request_id=R-17 email=alice@example.test token=CANARY_TEST_SECRET_9Q error=E_TIMEOUT')
    const output = guard.redact('用户 alice 的邮箱是 alice@example.test，token=CANARY_TEST_SECRET_9Q，错误 E_TIMEOUT')
    expect(output).not.toContain('alice')
    expect(output).not.toContain('CANARY_TEST_SECRET_9Q')
    expect(output).toContain('[REDACTED]')
    expect(output).toContain('E_TIMEOUT')
  })

  it('未登记的普通文本不被误伤，新出现的完整邮箱也会遮蔽', () => {
    const guard = new SensitiveGuard()
    guard.observe('token=abcdefgh')
    expect(guard.redact('这是一段普通文本，没有敏感值')).toBe('这是一段普通文本，没有敏感值')
    expect(guard.redact('联系 bob@example.test')).toBe('联系 [REDACTED]')
  })

  it('redactMessage 只改 text/thinking 块，不动工具调用块', () => {
    const guard = new SensitiveGuard()
    guard.observe('email=carol@example.test token=SECRET_TOKEN_123456')
    const message = guard.redactMessage({
      id: 'm1',
      role: 'assistant',
      createdAt: 1,
      content: [
        { type: 'text', text: 'carol@example.test / SECRET_TOKEN_123456' },
        { type: 'tool_use', id: 't1', name: 'read_file', title: '读文件', category: 'read', input: {}, status: 'success' }
      ]
    })
    expect(message.content[0]).toMatchObject({ type: 'text', text: '[REDACTED] / [REDACTED]' })
    expect(message.content[1]).toMatchObject({ type: 'tool_use', id: 't1' })
  })
})
