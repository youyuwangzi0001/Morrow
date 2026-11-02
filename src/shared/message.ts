import type { ChatMessage } from './types'

/** 消息里给用户看的纯文本；思考与工具块不进入复制内容。 */
export function messagePlainText(message: ChatMessage): string {
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'error') return block.message
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/**
 * 用户气泡与侧栏预览只展示用户输入本身。
 * 新消息用 displayText；旧消息在附件块前有固定分隔，回退截断。
 */
export function userMessageDisplayText(message: ChatMessage): string {
  if (typeof message.displayText === 'string') return message.displayText.trim()
  const text = messagePlainText(message)
  const marker = text.indexOf('\n\n[附件] ')
  return (marker >= 0 ? text.slice(0, marker) : text).trim()
}

/**
 * 编辑用户消息文本，保留原消息里的附件/图片块。
 * 用户消息正文是「用户输入 + 附件块」，只替换用户输入前缀，避免编辑后附件静默丢失。
 */
export function replaceUserMessageText(message: ChatMessage, text: string): ChatMessage {
  const value = text.trim()
  const display = userMessageDisplayText(message)
  // 旧版只有附件的消息没有 displayText，回退值就是附件块本身，不能把它当成用户正文
  const previous = typeof message.displayText !== 'string' && display.startsWith('[附件] ') ? '' : display
  let replaced = false
  const content = message.content.map((block) => {
    if (block.type !== 'text' || replaced) return block
    replaced = true
    if (previous && block.text.startsWith(previous)) {
      return { ...block, text: `${value}${block.text.slice(previous.length)}` }
    }
    const attachmentAt = block.text.indexOf('[附件] ')
    if (attachmentAt >= 0) {
      return { ...block, text: `${value}\n\n${block.text.slice(attachmentAt)}` }
    }
    return { ...block, text: value }
  })
  if (!replaced) content.push({ type: 'text', text: value })
  return { ...message, content, displayText: value }
}
