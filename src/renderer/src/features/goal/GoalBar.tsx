import { useEffect, useState } from 'react'
import { ChevronDown, CirclePause, CirclePlay, Target } from 'lucide-react'
import type { Goal } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button, Modal } from '../../ui'
import {
  GOAL_STATUS_LABEL,
  formatGoalTime,
  goalBudgetText,
  goalRoundText,
  goalStopReasonText
} from './goal-format'
import './Goal.css'

/** 目标条操作：暂停 / 继续 / 结束 / 清除（动作完成后由 store 刷新 goal） */
type GoalAction = 'pause' | 'resume' | 'stop' | 'clear'

function GoalStatusChip({ goal }: { goal: Goal }): React.JSX.Element {
  return (
    <span className={`goal-status is-${goal.status}`} aria-live="polite">
      {GOAL_STATUS_LABEL[goal.status]}
    </span>
  )
}

function GoalProgress({ goal }: { goal: Goal }): React.JSX.Element {
  // 轮次上限可到 50：进度点最多显示 20 个，避免撑爆目标条
  const total = Math.max(1, Math.min(20, goal.maxRounds))
  const scaledRound = goal.maxRounds > total ? Math.ceil((goal.round / goal.maxRounds) * total) : goal.round
  const current = Math.max(1, Math.min(scaledRound, total))
  return (
    <span className="goal-progress" aria-hidden>
      {Array.from({ length: total }, (_, index) => {
        const state = index < current - 1 ? 'is-done' : index === current - 1 ? 'is-current' : ''
        return <span key={index} className={['goal-seg', state].filter(Boolean).join(' ')} />
      })}
    </span>
  )
}

/**
 * Goal 模式目标条：位于 Composer 上方（app-dock 内、PlanTray 之前）。
 * 无目标时返回 null，不占任何空间。
 */
export function GoalBar(): React.JSX.Element | null {
  const goal = useAppStore((s) => s.session?.goal ?? null)
  const run = useAppStore((s) => s.run)
  const pauseGoal = useAppStore((s) => s.pauseGoal)
  const resumeGoal = useAppStore((s) => s.resumeGoal)
  const stopGoal = useAppStore((s) => s.stopGoal)
  const clearGoal = useAppStore((s) => s.clearGoal)
  const notify = useAppStore((s) => s.notify)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<GoalAction | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  // 完成 / 阻塞 / 取消时自动展开，让摘要与原因直接可见
  useEffect(() => {
    if (goal?.status === 'completed' || goal?.status === 'blocked' || goal?.status === 'cancelled') setExpanded(true)
  }, [goal?.status])

  if (!goal) return null

  const running = !!run && goal.status === 'active'
  const status = goal.status

  const runAction = async (action: GoalAction): Promise<void> => {
    if (busy) return
    setBusy(action)
    try {
      if (action === 'pause') {
        await pauseGoal()
        if (useAppStore.getState().session?.goal?.status === 'paused') notify('info', '目标已暂停。')
      } else if (action === 'resume') {
        await resumeGoal()
      } else if (action === 'stop') {
        await stopGoal()
      } else {
        await clearGoal()
        if (!useAppStore.getState().session?.goal) notify('info', '目标已清除。')
      }
    } finally {
      setBusy(null)
    }
  }

  const summaryLine = goal.summary?.trim()
  const nextLine = goal.nextStep?.trim()
  const blockedLine = goal.blockedReason?.trim()

  return (
    <>
    <section
      className={['goal-bar', `is-${status}`, running ? 'is-running' : '', expanded ? 'is-expanded' : '']
        .filter(Boolean)
        .join(' ')}
      role="region"
      aria-label={`目标模式：${goal.objective}`}
    >
      <div className="goal-bar-head">
        <button
          type="button"
          className="goal-bar-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? '收起目标详情' : '展开目标详情'}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="goal-bar-icon" aria-hidden>
            <Target size={14} strokeWidth={1.6} />
          </span>
          <span className="goal-bar-copy">
            <span className="goal-bar-objective truncate">{goal.objective}</span>
            <span className="goal-bar-sub mono">
              {goalRoundText(goal.round, goal.maxRounds)}
              {running ? ' · 正在推进' : status === 'paused' ? ' · 已暂停自动续跑' : ''}
            </span>
          </span>
          <GoalProgress goal={goal} />
          <GoalStatusChip goal={goal} />
          <ChevronDown
            size={13}
            strokeWidth={1.5}
            className={['goal-bar-chevron', expanded ? 'is-open' : ''].filter(Boolean).join(' ')}
            aria-hidden
          />
        </button>

        <div className="goal-bar-actions">
          {status === 'active' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<CirclePause size={13} strokeWidth={1.5} />}
              loading={busy === 'pause'}
              disabled={busy !== null}
              onClick={() => void runAction('pause')}
              title="暂停自动续跑，当前轮结果会保留"
            >
              暂停
            </Button>
          ) : null}
          {status === 'paused' ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<CirclePlay size={13} strokeWidth={1.5} />}
              loading={busy === 'resume'}
              disabled={busy !== null}
              onClick={() => void runAction('resume')}
              title="从下一轮继续推进目标"
            >
              继续
            </Button>
          ) : null}
          {status === 'active' || status === 'paused' ? (
            <button
              type="button"
              className="goal-end"
              disabled={busy !== null}
              onClick={() => setConfirmStop(true)}
              title="结束目标：停止自动续跑，标记为已取消（不会算作完成），保留已生成的内容"
            >
              结束目标
            </button>
          ) : null}
          {status === 'completed' || status === 'blocked' || status === 'cancelled' ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'clear'}
              disabled={busy !== null}
              onClick={() => void runAction('clear')}
              title="从这条对话里移除目标记录"
            >
              清除
            </Button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="goal-detail">
          {blockedLine ? (
            <p className="goal-detail-row is-blocked">
              <span className="goal-detail-label mono">需要你决定</span>
              <span>{blockedLine}</span>
            </p>
          ) : null}
          {goal.stopReason ? (
            <p className={['goal-detail-row', goal.status === 'cancelled' ? 'is-blocked' : 'is-muted'].join(' ')}>
              <span className="goal-detail-label mono">停止原因</span>
              <span>{goalStopReasonText(goal.stopReason)}</span>
            </p>
          ) : null}
          {summaryLine ? (
            <p className="goal-detail-row">
              <span className="goal-detail-label mono">上一轮</span>
              <span>{summaryLine}</span>
            </p>
          ) : null}
          {nextLine ? (
            <p className="goal-detail-row">
              <span className="goal-detail-label mono">下一步</span>
              <span>{nextLine}</span>
            </p>
          ) : null}
          {goal.evidence?.length ? (
            <p className="goal-detail-row">
              <span className="goal-detail-label mono">完成证据</span>
              <span className="mono">{goal.evidence.join('、')}</span>
            </p>
          ) : null}
          {!summaryLine && !nextLine && !blockedLine ? (
            <p className="goal-detail-row is-muted">
              还没有进度摘要。每轮结束时 Morrow 会更新这里，并自动继续下一轮。
            </p>
          ) : null}
          <p className="goal-detail-meta mono">
            建立于 {formatGoalTime(goal.createdAt)} · 轮次预算 {goal.maxRounds} 轮
            {goal.maxRoundsAuto ? '（按目标自动估算）' : ''} · {goalBudgetText(goal)}
            {goal.completedAt ? ` · 完成于 ${formatGoalTime(goal.completedAt)}` : ''}
            {goal.cancelledAt ? ` · 取消于 ${formatGoalTime(goal.cancelledAt)}` : ''}
          </p>
        </div>
      ) : null}
    </section>

    <Modal
      open={confirmStop}
      onClose={() => setConfirmStop(false)}
      title="结束目标？"
      width={430}
      footer={
        <>
          <Button variant="ghost" onClick={() => setConfirmStop(false)}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={busy === 'stop'}
            onClick={() => {
              setConfirmStop(false)
              void runAction('stop')
            }}
          >
            结束目标
          </Button>
        </>
      }
    >
      <p className="goal-confirm-body">
        结束后目标会记为「已取消」（不是完成），已经生成的内容、工具记录和对话都会保留。之后可以在目标条上清除这条记录。
      </p>
      <div className="goal-confirm-list mono">
        当前进度摘要：{goal.summary?.trim() || '还没有摘要'} · 已进行 {goalRoundText(goal.round, goal.maxRounds)}
      </div>
    </Modal>
    </>
  )
}
