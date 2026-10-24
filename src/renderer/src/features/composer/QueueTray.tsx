import { useState } from 'react'
import { Check, ListOrdered, Pencil, X, Zap } from 'lucide-react'
import type { QueuedMessage } from '@shared/types'
import { useAppStore } from '../../store'
import './QueueTray.css'

const EMPTY_QUEUE: QueuedMessage[] = []

/**
 * 运行中排队托盘：展示本轮结束后将自动发送的消息。
 * 支持编辑、删除，以及「打断并发送」立即切换任务。
 */
export function QueueTray(): React.JSX.Element | null {
  const queue = useAppStore((s) => (s.session ? s.queues[s.session.id] ?? EMPTY_QUEUE : EMPTY_QUEUE))
  const interrupting = useAppStore((s) => s.interrupting)
  const updateQueuedMessage = useAppStore((s) => s.updateQueuedMessage)
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage)
  const interruptAndSendQueued = useAppStore((s) => s.interruptAndSendQueued)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  if (queue.length === 0) return null

  const startEdit = (item: QueuedMessage): void => {
    setEditingId(item.id)
    setDraft(item.text)
  }

  const saveEdit = (): void => {
    if (!editingId) return
    const text = draft.trim()
    if (!text) return
    void updateQueuedMessage(editingId, text)
    setEditingId(null)
    setDraft('')
  }

  return (
    <section className="queue-tray" aria-label="排队消息">
      <div className="queue-head">
        <ListOrdered size={13} strokeWidth={1.5} aria-hidden />
        <span className="queue-title">待发送</span>
        <span className="queue-count mono">{queue.length}</span>
        <span className="queue-hint">本轮结束后自动发送</span>
      </div>
      <ul className="queue-list">
        {queue.map((item) => (
          <li key={item.id} className="queue-item">
            {editingId === item.id ? (
              <div className="queue-edit">
                <textarea
                  className="queue-input input"
                  value={draft}
                  rows={2}
                  autoFocus
                  aria-label="编辑排队消息"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingId(null)
                    } else if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      saveEdit()
                    }
                  }}
                />
                <div className="queue-edit-actions">
                  <button type="button" className="queue-action" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                  <button type="button" className="queue-action is-primary" disabled={!draft.trim()} onClick={saveEdit}>
                    <Check size={11} strokeWidth={1.8} aria-hidden />
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="queue-text selectable">{item.text || '（仅附件）'}</p>
                {item.attachments?.length ? (
                  <span className="queue-attachments mono">{item.attachments.length} 个附件</span>
                ) : null}
                <div className="queue-actions">
                  <button
                    type="button"
                    className="queue-action is-interrupt"
                    title="停止当前运行，立即发送这条消息"
                    disabled={interrupting}
                    onClick={() => void interruptAndSendQueued(item.id)}
                  >
                    <Zap size={11} strokeWidth={1.7} aria-hidden />
                    打断并发送
                  </button>
                  <button type="button" className="queue-icon" aria-label="编辑这条排队消息" title="编辑" onClick={() => startEdit(item)}>
                    <Pencil size={12} strokeWidth={1.6} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="queue-icon"
                    aria-label="删除这条排队消息"
                    title="删除"
                    onClick={() => void removeQueuedMessage(item.id)}
                  >
                    <X size={12} strokeWidth={1.7} aria-hidden />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
