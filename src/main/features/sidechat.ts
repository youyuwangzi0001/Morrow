/** 侧边聊天（/btw）：只读问答，不写入主对话。 */
import { randomUUID } from 'node:crypto'
import { registerFeatureHandler, sendFeatureEvent } from '../feature-ipc'
import { runSideChat, type SideChatHistoryItem } from '../services/side-chat'
import { recordTokenUsage } from '../services/runtime'
import { getSessionStore } from '../services/session-store'
import { estimateTokens } from '@core/index'

export const SIDECHAT_EVENT = 'feature:sidechat:event'

const controllers = new Map<string, AbortController>()

/** 清除全部对话时中止所有侧聊，避免它们在数据清空后继续写用量。 */
export function abortAllSideChats(): void {
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  sessionRequests.clear()
}
const sessionRequests = new Map<string, string>()
const MAX_CONCURRENT = 8
const MAX_HISTORY_CHARS = 12_000

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

registerFeatureHandler('feature:sidechat:ask', (payload) => {
  const input = payloadOf(payload)
  const sessionId = text(input.sessionId, 128)
  const question = text(input.question, 8000)
  if (!sessionId) throw new Error('缺少会话 id。')
  if (!question) throw new Error('问题不能为空。')
  const parsedHistory: SideChatHistoryItem[] = Array.isArray(input.history)
    ? input.history
        .slice(-12)
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const record = item as Record<string, unknown>
          const content = text(record.content, 8000)
          if (!content) return null
          return { role: record.role === 'assistant' ? ('assistant' as const) : ('user' as const), content }
        })
        .filter((item): item is SideChatHistoryItem => item !== null)
    : []
  // 从最新消息往旧消息分配总额度，避免 12×8KB 历史超小上下文
  const history: SideChatHistoryItem[] = []
  let historyChars = 0
  for (const item of [...parsedHistory].reverse()) {
    if (historyChars >= MAX_HISTORY_CHARS) break
    const remaining = MAX_HISTORY_CHARS - historyChars
    const content = item.content.slice(0, remaining)
    if (!content) continue
    history.unshift({ role: item.role, content })
    historyChars += content.length
  }

  // requestId 由渲染层生成并在 invoke 前保存，避免极快模型的事件先于 IPC 返回值到达而被丢弃
  const requestedId = text(input.requestId, 80)
  const requestId = /^[A-Za-z0-9_-]{8,80}$/.test(requestedId)
    ? requestedId
    : `side_${randomUUID().slice(0, 12)}`
  if (controllers.size >= MAX_CONCURRENT && !controllers.has(requestId)) {
    throw new Error('同时进行的侧边聊天过多，请稍后再试。')
  }
  const previous = sessionRequests.get(sessionId)
  if (previous && previous !== requestId) controllers.get(previous)?.abort()
  const controller = new AbortController()
  controllers.set(requestId, controller)
  sessionRequests.set(sessionId, requestId)
  void (async () => {
    try {
      const result = await runSideChat(
        {
          sessionId,
          question,
          useContext: input.useContext !== false,
          history
        },
        (delta) => sendFeatureEvent(SIDECHAT_EVENT, { requestId, type: 'delta', text: delta }),
        controller.signal,
        (message) => sendFeatureEvent(SIDECHAT_EVENT, { requestId, type: 'notice', message })
      )
      if (!getSessionStore().get(sessionId)?.temporary) {
        recordTokenUsage({
          sessionId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens ?? 0,
          estimatedInputTokens:
            result.usage.inputTokens > 0
              ? 0
              : estimateTokens(question) + history.reduce((sum, item) => sum + estimateTokens(item.content), 0),
          estimatedOutputTokens: result.usage.outputTokens > 0 ? 0 : estimateTokens(result.text)
        })
      }
      sendFeatureEvent(SIDECHAT_EVENT, {
        requestId,
        type: 'done',
        text: result.text,
        usage: result.usage
      })
    } catch (err) {
      const aborted = controller.signal.aborted
      sendFeatureEvent(SIDECHAT_EVENT, {
        requestId,
        type: aborted ? 'cancelled' : 'error',
        ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err) })
      })
    } finally {
      controllers.delete(requestId)
      if (sessionRequests.get(sessionId) === requestId) sessionRequests.delete(sessionId)
    }
  })()
  return { requestId }
})

registerFeatureHandler('feature:sidechat:cancel', (payload) => {
  const requestId = text(payloadOf(payload).requestId, 128)
  const controller = controllers.get(requestId)
  if (!controller) return { cancelled: false }
  controller.abort()
  for (const [sessionId, activeId] of sessionRequests) {
    if (activeId === requestId) sessionRequests.delete(sessionId)
  }
  return { cancelled: true }
})
