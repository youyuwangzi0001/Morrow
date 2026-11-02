import type { ChatMessage } from '../../shared/types'

/**
 * 输出侧敏感值观察与遮蔽（R7 审计 M32 修复）。
 *
 * 模型可能把工具结果里的邮箱、token 等原值复述到用户可见回复中——提示词约束不足以保证。
 * 这里在**主进程输出链路**做二次保护：
 * 1) 从工具结果/用户消息中登记敏感值（完整邮箱、邮箱 local-part、token/secret/password 等赋值）；
 * 2) 流式 delta 与 message_completed、落盘消息都统一遮蔽为 [REDACTED]。
 *
 * 原则：只遮蔽**确实在当前会话中出现过**的敏感值，避免把普通文本误伤。
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const SECRET_ASSIGN_RE =
  /(?:token|secret|password|passwd|api[_-]?key|authorization|bearer)\s*[=:]\s*["']?([A-Za-z0-9_\-./+={}]{6,})/gi

const REDACTED = '[REDACTED]'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class SensitiveGuard {
  private readonly values = new Set<string>()

  /** 从任意文本（工具结果/用户消息）中提取敏感值并登记 */
  observe(text: string | null | undefined): void {
    if (!text) return
    for (const match of text.matchAll(EMAIL_RE)) {
      const email = match[0]
      this.values.add(email)
      const local = email.split('@')[0]
      if (local.length >= 3) this.values.add(local)
    }
    for (const match of text.matchAll(SECRET_ASSIGN_RE)) {
      const value = match[1]
      if (value) this.values.add(value)
    }
  }

  hasValues(): boolean {
    return this.values.size > 0
  }

  /** 遮蔽已登记的敏感值 + 新出现的完整邮箱 */
  redact(text: string | null | undefined): string {
    if (!text) return text ?? ''
    let next = text
    const values = [...this.values].sort((a, b) => b.length - a.length)
    for (const value of values) {
      if (!value) continue
      next = next.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED)
    }
    // 未登记的新邮箱也统一遮蔽（避免模型编造/拼接）
    next = next.replace(EMAIL_RE, REDACTED)
    // token=xxx 形式保留字段名，只遮蔽值
    next = next.replace(SECRET_ASSIGN_RE, (whole: string, value: string) =>
      value && !whole.includes(REDACTED) ? whole.replace(value, REDACTED) : whole
    )
    return next
  }

  redactMessage(message: ChatMessage): ChatMessage {
    const content = message.content.map((block) => {
      if (block.type !== 'text' && block.type !== 'thinking') return block
      return { ...block, text: this.redact(block.text) }
    })
    return { ...message, content }
  }
}
