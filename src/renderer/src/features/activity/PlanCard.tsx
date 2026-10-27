import { useMemo, useState } from 'react'
import { Check, ClipboardList, FileText, Pencil, Play, RotateCcw, X } from 'lucide-react'
import { todoMatchesPlanStep } from '@shared/plan'
import type { SessionPlan, TodoItem } from '@shared/types'
import { useAppStore } from '../../store'
import './PlanCard.css'

const EMPTY_TODOS: TodoItem[] = []

type EditorMode = 'revise' | 'reject' | null

function statusLabel(plan: SessionPlan): string {
  if (plan.status === 'pending') return '待批准'
  if (plan.status === 'executing') return '执行中'
  if (plan.status === 'completed') return '已完成'
  return '已拒绝'
}

/**
 * 计划卡：计划模式的审批与执行入口。
 * 待批准时可执行 / 修改 / 拒绝；执行中展示步骤进度并可继续中断的执行；
 * 拒绝后保留反馈，允许重新规划。计划正文同时以 Markdown 成品进入画布。
 */
export function PlanCard(): React.JSX.Element | null {
  const plan = useAppStore((s) => s.session?.plan ?? null)
  const todos = useAppStore((s) => s.session?.todos ?? EMPTY_TODOS)
  const running = useAppStore((s) => !!s.run && s.run.sessionId === s.session?.id)
  const approvePlan = useAppStore((s) => s.approvePlan)
  const revisePlan = useAppStore((s) => s.revisePlan)
  const rejectPlan = useAppStore((s) => s.rejectPlan)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const [editor, setEditor] = useState<EditorMode>(null)
  const [feedback, setFeedback] = useState('')
  const [collapsed, setCollapsed] = useState(false)

  const progress = useMemo(() => {
    if (!plan) return { completed: 0, total: 0 }
    const completed = plan.steps.filter((step) =>
      todos.some((todo) => todo.status === 'completed' && todoMatchesPlanStep(todo, step.text))
    ).length
    return { completed, total: plan.steps.length }
  }, [plan, todos])

  if (!plan) return null

  const pending = plan.status === 'pending'
  const executing = plan.status === 'executing'
  const completed = plan.status === 'completed'
  const rejected = plan.status === 'rejected'
  const canResume = executing && !running && progress.completed < progress.total

  const submitEditor = (): void => {
    if (!editor) return
    const note = feedback.trim()
    if (editor === 'revise') {
      if (!note) return
      void revisePlan(note)
    } else {
      void rejectPlan(note || undefined)
    }
    setEditor(null)
    setFeedback('')
  }

  return (
    <section
      className={[
        'plan-card',
        pending ? 'is-pending' : '',
        executing ? 'is-executing' : '',
        completed ? 'is-complete' : '',
        rejected ? 'is-rejected' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="执行计划"
    >
      <button type="button" className="plan-card-head" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        <ClipboardList size={14} strokeWidth={1.5} className="plan-card-icon" aria-hidden />
        <span className="plan-card-kicker mono">{statusLabel(plan)}</span>
        <span className="plan-card-title truncate">{plan.title}</span>
        <span className="plan-card-count mono">
          {executing || completed ? `${progress.completed}/${progress.total}` : `${plan.steps.length} 步`}
        </span>
      </button>

      {!collapsed ? (
        <div className="plan-card-body">
          <p className="plan-card-summary selectable">{plan.summary}</p>
          {pending ? (
            <p className="plan-card-hint">批准后 Morrow 会自动切到工作模式并按步骤执行。</p>
          ) : null}

          <ol className="plan-card-steps">
            {plan.steps.map((step) => {
              const match = todos.find((todo) => todoMatchesPlanStep(todo, step.text))
              const done = completed || match?.status === 'completed'
              const active = executing && !done && match?.status === 'in_progress'
              return (
                <li
                  key={step.id}
                  className={['plan-card-step', done ? 'is-done' : '', active ? 'is-active' : ''].filter(Boolean).join(' ')}
                >
                  <span className="plan-card-step-mark" aria-hidden>
                    {done ? <Check size={11} strokeWidth={2} /> : null}
                  </span>
                  <span className="plan-card-step-text selectable">{step.text}</span>
                </li>
              )
            })}
          </ol>

          {plan.risks?.trim() ? (
            <div className="plan-card-risks">
              <span className="plan-card-risks-label mono">风险与前提</span>
              <p className="selectable">{plan.risks.trim()}</p>
            </div>
          ) : null}

          {rejected && plan.feedback ? (
            <p className="plan-card-feedback">你的反馈：{plan.feedback}</p>
          ) : null}

          {editor ? (
            <div className="plan-card-editor">
              <textarea
                className="plan-card-input input"
                value={feedback}
                autoFocus
                rows={2}
                placeholder={editor === 'revise' ? '说明要改什么（例如：先保留原表，再单独输出一份摘要）' : '可选：说明拒绝原因，便于之后重新规划'}
                aria-label={editor === 'revise' ? '计划修改意见' : '拒绝计划的原因'}
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditor(null)
                  }
                }}
              />
              <div className="plan-card-editor-actions">
                <button type="button" className="plan-card-btn is-ghost" onClick={() => setEditor(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="plan-card-btn is-primary"
                  disabled={editor === 'revise' && !feedback.trim()}
                  onClick={submitEditor}
                >
                  {editor === 'revise' ? '重新规划' : '确认拒绝'}
                </button>
              </div>
            </div>
          ) : (
            <div className="plan-card-actions">
              {pending ? (
                <>
                  <button type="button" className="plan-card-btn is-primary" onClick={() => void approvePlan()}>
                    <Play size={12} strokeWidth={1.8} aria-hidden />
                    执行计划
                  </button>
                  <button type="button" className="plan-card-btn" onClick={() => setEditor('revise')}>
                    <Pencil size={12} strokeWidth={1.6} aria-hidden />
                    修改
                  </button>
                  <button type="button" className="plan-card-btn is-quiet" onClick={() => setEditor('reject')}>
                    <X size={12} strokeWidth={1.7} aria-hidden />
                    拒绝
                  </button>
                </>
              ) : null}

              {canResume ? (
                <button type="button" className="plan-card-btn is-primary" onClick={() => void approvePlan()}>
                  <Play size={12} strokeWidth={1.8} aria-hidden />
                  继续执行
                </button>
              ) : null}

              {rejected ? (
                <button type="button" className="plan-card-btn is-primary" onClick={() => setEditor('revise')}>
                  <RotateCcw size={12} strokeWidth={1.6} aria-hidden />
                  重新规划
                </button>
              ) : null}

              {plan.artifactId ? (
                <button
                  type="button"
                  className="plan-card-btn is-quiet"
                  onClick={() => openCanvas(plan.artifactId)}
                  title="在画布中查看计划文档"
                >
                  <FileText size={12} strokeWidth={1.5} aria-hidden />
                  计划文档
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

export interface PlanNoticeInfo {
  kind: 'approved' | 'resume' | 'revise'
  title?: string
}

export function parsePlanMessage(text: string): PlanNoticeInfo | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('【计划已获批准】')) {
    const title = /计划：([^\n]+)/.exec(trimmed)?.[1]?.trim()
    return { kind: 'approved', ...(title ? { title } : {}) }
  }
  if (trimmed.startsWith('【计划执行 · 继续】')) {
    const title = /计划：([^\n]+)/.exec(trimmed)?.[1]?.trim()
    return { kind: 'resume', ...(title ? { title } : {}) }
  }
  if (trimmed.startsWith('【修改计划】')) return { kind: 'revise' }
  return null
}

export function PlanNotice({ info }: { info: PlanNoticeInfo }): React.JSX.Element {
  const label =
    info.kind === 'approved'
      ? '计划已获批准 · 开始执行'
      : info.kind === 'resume'
        ? '继续执行计划'
        : '按你的反馈修改计划'
  return (
    <div className="plan-notice" role="status">
      <ClipboardList size={12} strokeWidth={1.5} aria-hidden />
      <span className="plan-notice-label">{label}</span>
      {info.title ? <span className="plan-notice-title truncate">{info.title}</span> : null}
    </div>
  )
}
