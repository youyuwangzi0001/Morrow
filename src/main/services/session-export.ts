/** 会话导出（Markdown / JSON）。 */
import type { ChatMessage, Session } from '../../shared/types'
import { messagePlainText, userMessageDisplayText } from '../../shared/message'

function timeText(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date(timestamp).toISOString()
  }
}

function toolLines(message: ChatMessage): string[] {
  const lines: string[] = []
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue
    const result = block.result
    const state = result ? (result.ok ? '完成' : '失败') : block.status
    lines.push(`- 工具 \`${block.name}\`：${block.title || '调用'}（${state}）`)
    if (result?.output) {
      const text = result.output.replace(/\s+/g, ' ').trim()
      if (text) lines.push(`  > ${text.slice(0, 240)}${text.length > 240 ? '…' : ''}`)
    }
    if (result?.error) lines.push(`  > 错误：${result.error.slice(0, 240)}`)
  }
  return lines
}

export function sessionToMarkdown(session: Session): string {
  const lines = [
    `# ${session.title}`,
    '',
    `- 导出时间：${timeText(Date.now())}`,
    `- 创建时间：${timeText(session.createdAt)}`,
    `- 工作区：${session.workspace ?? '（未绑定）'}`,
    `- 模型：${session.model.providerId} / ${session.model.modelId}`,
    `- 消息数：${session.messages.length}`,
    ''
  ]
  for (const message of session.messages) {
    if (message.role === 'system' && message.content.some((block) => block.type === 'text' && block.text.includes('历史对话摘要'))) {
      lines.push('## 上下文摘要', '', messagePlainText(message).replace(/^\[历史对话摘要[^\]]*\]\s*/, '').trim(), '')
      continue
    }
    if (message.role === 'user') {
      lines.push(`## 用户 · ${timeText(message.createdAt)}`, '', userMessageDisplayText(message) || '（附件）', '')
      if (message.attachments?.length) lines.push(`附件：${message.attachments.map((item) => item.name).join('、')}`, '')
      continue
    }
    if (message.role === 'assistant') {
      lines.push(`## 助手 · ${timeText(message.createdAt)}`, '')
      const text = message.content
        .filter((block): block is import('../../shared/types').TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
        .trim()
      if (text) lines.push(text, '')
      const tools = toolLines(message)
      if (tools.length) lines.push('### 工具调用', '', ...tools, '')
      if (message.interrupted) lines.push('> 本轮已停止', '')
      if (message.error) lines.push(`> 错误：${message.error.message}`, '')
    }
  }
  const todoLines = session.todos.map((todo) => `- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.text}`)
  if (todoLines.length) lines.push('## 计划', '', ...todoLines, '')
  if (session.artifacts.length) {
    lines.push('## 产物', '')
    for (const artifact of session.artifacts) lines.push(`- ${artifact.title}（${artifact.kind}）${artifact.path ?? ''}`)
  }
  return `${lines.join('\n')}\n`
}

export function sessionExportContent(session: Session, format: 'markdown' | 'json'): { filename: string; content: string } {
  const safeTitle = session.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'Morrow 对话'
  if (format === 'json') {
    return { filename: `${safeTitle}.json`, content: JSON.stringify(session, null, 2) }
  }
  return { filename: `${safeTitle}.md`, content: sessionToMarkdown(session) }
}

