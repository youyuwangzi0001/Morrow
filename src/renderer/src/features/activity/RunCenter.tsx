import { useEffect, useState } from 'react'
import { Activity, ChevronDown, Square } from 'lucide-react'
import { useAppStore } from '../../store'
import './RunCenter.css'

function elapsedLabel(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function RunElapsed({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="run-center-elapsed mono">{elapsedLabel(startedAt)}</span>
}

/**
 * 运行中心：展示所有对话的活动运行，支持切换/停止。
 * 仅有一个当前对话任务时不显示（输入框已有停止按钮）。
 */
export function RunCenter(): React.JSX.Element | null {
  const runs = useAppStore((s) => s.runs)
  const sessions = useAppStore((s) => s.sessions)
  const pendingPermissions = useAppStore((s) => s.pendingPermissions)
  const pendingQuestions = useAppStore((s) => s.pendingQuestions)
  const queues = useAppStore((s) => s.queues)
  const currentSessionId = useAppStore((s) => s.session?.id ?? null)
  const selectSession = useAppStore((s) => s.selectSession)
  const stopRunById = useAppStore((s) => s.stopRunById)
  const [expanded, setExpanded] = useState(true)

  const list = Object.values(runs)
  if (list.length === 0) return null
  if (list.length === 1 && list[0].sessionId === currentSessionId) return null

  const titleOf = (sessionId: string): string =>
    sessions.find((item) => item.id === sessionId)?.title ?? '对话'

  return (
    <section className={['run-center', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ')} aria-label="运行中心">
      <button type="button" className="run-center-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <Activity size={13} strokeWidth={1.5} className="run-center-icon" aria-hidden />
        <span className="run-center-title">运行中心</span>
        <span className="run-center-count mono">{list.length}</span>
        <span className="run-center-hint">后台任务继续运行</span>
        <ChevronDown size={13} strokeWidth={1.6} className="run-center-chevron" aria-hidden />
      </button>
      {expanded ? (
        <ul className="run-center-list">
          {list.map((run) => {
            const isCurrent = run.sessionId === currentSessionId
            const waiting = Boolean(pendingPermissions[run.sessionId] || pendingQuestions[run.sessionId])
            const queued = queues[run.sessionId]?.length ?? 0
            return (
              <li
                key={run.runId}
                className={['run-center-item', isCurrent ? 'is-current' : '', waiting ? 'is-waiting' : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="run-center-dot" aria-hidden />
                <button type="button" className="run-center-main" onClick={() => void selectSession(run.sessionId)}>
                  <span className="run-center-name truncate">{titleOf(run.sessionId)}</span>
                  <span className="run-center-meta mono">
                    {isCurrent ? '当前对话' : '后台'} · <RunElapsed startedAt={run.startedAt} />
                    {waiting ? ' · 等待确认' : ''}
                    {queued > 0 ? ` · 队列 ${queued}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="run-center-stop"
                  aria-label={`停止任务：${titleOf(run.sessionId)}`}
                  title="停止这个任务"
                  onClick={() => void stopRunById(run.runId)}
                >
                  <Square size={10} strokeWidth={2} fill="currentColor" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
