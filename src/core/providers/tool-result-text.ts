import type { ChatMessage } from '../../shared/types'

function cleanFailureText(text: string, max = 2000): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s+/.test(line) && !/node:internal|processTicksAndRejections/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

/** 工具结果回给模型：失败时保留可行动信息，去掉栈帧与内部实现噪音。 */
export function toolResultTextForModel(
  block: Extract<ChatMessage['content'][number], { type: 'tool_use' }>
): string {
  if (!block.result) return '[该工具调用没有返回结果]'
  if (block.result.ok) return block.result.output || '(命令执行成功，没有输出)'
  const error = cleanFailureText(block.result.error ?? block.result.output ?? '未知错误', 1200) || '未知错误'
  const output = cleanFailureText(block.result.output ?? '', 1200)
  const parts = [`[工具执行失败] ${error}`]
  if (block.result.hint?.trim()) parts.push(`提示：${block.result.hint.trim()}`)
  if (output && output !== error) parts.push(`输出：${output}`)
  parts.push('下一步：先按提示检查参数、路径或权限再重试；同一错误再次出现时换一种做法，必要时用 ask_user 询问用户。')
  return parts.join('\n')
}
