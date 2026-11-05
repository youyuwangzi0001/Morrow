import type { ChatMessage, CheckpointReplayStep } from './types'

/**
 * 从检查点之后的消息里找出最后一轮带工具调用的助手消息，并判断每一步：
 * - 已成功：跳过；
 * - 失败/中断/没有结果：重跑；
 * - 用户明确拒绝：保留拒绝，不自动重试。
 * 只做纯判断，不读文件；主进程再用 afterHash 检查成功写入是否被外部改动。
 */
export function buildCheckpointReplay(
  messages: ChatMessage[],
  checkpointMessageId: string
): { messageFound: boolean; assistantMessageId: string | null; steps: CheckpointReplayStep[] } {
  const checkpointIndex = messages.findIndex(
    (message) => message.id === checkpointMessageId && message.role === 'user'
  )
  if (checkpointIndex < 0) {
    return { messageFound: false, assistantMessageId: null, steps: [] }
  }
  let assistant: ChatMessage | undefined
  for (let index = messages.length - 1; index > checkpointIndex; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.content.some((block) => block.type === 'tool_use')) {
      assistant = message
      break
    }
  }
  if (!assistant) {
    return { messageFound: true, assistantMessageId: null, steps: [] }
  }
  const steps: CheckpointReplayStep[] = []
  for (const block of assistant.content) {
    if (block.type !== 'tool_use') continue
    const result = block.result
    const meta = result?.meta && typeof result.meta === 'object' ? (result.meta as Record<string, unknown>) : undefined
    const absolutePath = typeof meta?.absolutePath === 'string' ? meta.absolutePath : undefined
    const afterHash = typeof meta?.afterHash === 'string' ? meta.afterHash : undefined
    const base = {
      toolUseId: block.id,
      name: block.name,
      title: block.title || block.name,
      ...(absolutePath ? { absolutePath } : {}),
      ...(afterHash ? { afterHash } : {})
    }
    if (block.status === 'denied') {
      steps.push({ ...base, action: 'denied', reason: '上次被用户拒绝，恢复时不会自动重试。' })
      continue
    }
    if (result?.ok === true && block.status !== 'interrupted') {
      steps.push({ ...base, action: 'skip', reason: '上次已成功，恢复时跳过。' })
      continue
    }
    if (block.status === 'interrupted' || (result?.meta as Record<string, unknown> | undefined)?.interrupted === true) {
      steps.push({ ...base, action: 'rerun', reason: '上次执行被中断，恢复时重跑。' })
      continue
    }
    if (result && result.ok === false) {
      steps.push({
        ...base,
        action: 'rerun',
        reason: `上次失败：${(result.error ?? '未知错误').slice(0, 120)}`
      })
      continue
    }
    steps.push({ ...base, action: 'rerun', reason: '上次没有拿到结果，恢复时重跑。' })
  }
  return { messageFound: true, assistantMessageId: assistant.id, steps }
}
