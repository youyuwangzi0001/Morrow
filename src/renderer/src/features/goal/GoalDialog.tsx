import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'
import type { Goal } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button, Modal, TextArea } from '../../ui'
import { GOAL_STATUS_LABEL, goalRoundText } from './goal-format'
import './Goal.css'

export interface GoalDialogProps {
  open: boolean
  onClose: () => void
  /** 打开时带入的目标描述（例如 Composer 里已经写好的文字） */
  initialObjective?: string
  /** 目标建立成功后回调（Composer 用来清空输入框） */
  onStarted?: () => void
}

/**
 * 建立目标对话框（Goal 模式入口）。
 * 轮次预算由主进程按目标复杂度智能估算（最高 200 轮），用户不需要手动设置；
 * 若当前对话已有目标：active/paused 由 GoalBar 操作；终态会在建立新目标前先清除旧目标。
 */
export function GoalDialog({ open, onClose, initialObjective, onStarted }: GoalDialogProps): React.JSX.Element {
  const session = useAppStore((s) => s.session)
  const newSession = useAppStore((s) => s.newSession)
  const startGoal = useAppStore((s) => s.startGoal)
  const clearGoal = useAppStore((s) => s.clearGoal)
  const [objective, setObjective] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingGoal: Goal | null = session?.goal ?? null
  const existingBlocking = existingGoal && (existingGoal.status === 'active' || existingGoal.status === 'paused')

  useEffect(() => {
    if (!open) return
    setObjective((initialObjective ?? '').trim())
    setError(null)
    setSubmitting(false)
    // 每次打开时重置表单
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = async (): Promise<void> => {
    if (submitting) return
    const text = objective.trim()
    if (!text) {
      setError('先写一句目标：你希望 Morrow 最终交付什么。')
      return
    }
    if (existingBlocking) {
      setError('当前对话已有进行中的目标，请在目标条上暂停或结束后再建立新的。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      if (!useAppStore.getState().session) {
        const created = await newSession()
        if (!created) {
          setError('新建对话失败，请重试。')
          return
        }
      }
      const active = useAppStore.getState().session?.goal
      if (active) await clearGoal()
      // 不传轮次：由主进程按目标复杂度估算（最高 200 轮）
      await startGoal(text)
      const goal = useAppStore.getState().session?.goal
      if (!goal) {
        setError('目标没有建立成功，请重试。')
        return
      }
      onStarted?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '目标建立失败，请重试。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="建立目标"
      description="Morrow 会自动多轮推进，直到完成或被卡住。每轮结束都会停下来更新进度。"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="gold"
            icon={<Target size={14} strokeWidth={1.6} />}
            loading={submitting}
            disabled={existingBlocking === true}
            onClick={() => void submit()}
          >
            建立目标并开始
          </Button>
        </>
      }
    >
      <div className="goal-dialog">
        {existingGoal ? (
          <p className="goal-dialog-existing">
            当前对话已有目标：
            <span className={`goal-status is-${existingGoal.status}`}>{GOAL_STATUS_LABEL[existingGoal.status]}</span>
            <span className="mono">{goalRoundText(existingGoal.round, existingGoal.maxRounds)}</span>
            {existingGoal.status === 'completed' || existingGoal.status === 'blocked'
              ? '，建立新目标时会先清除它。'
              : '，请先在目标条暂停或结束。'}
          </p>
        ) : null}

        <div className="goal-dialog-field">
          <div className="goal-dialog-label-row">
            <label className="goal-dialog-label" htmlFor="goal-objective">
              目标描述
            </label>
            <span className="goal-dialog-count mono">{objective.length}/600</span>
          </div>
          <TextArea
            id="goal-objective"
            rows={4}
            className="goal-dialog-textarea"
            placeholder="例如：分三轮完成一份竞品调研报告，每轮推进一个阶段——第一轮收集资料，第二轮分析对比，第三轮写完整报告并生成网页。"
            value={objective}
            maxLength={600}
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </div>

        <div className="goal-dialog-row">
          <p className="goal-dialog-hint">
            轮次上限由 Morrow 根据目标的实际复杂度**自动估算**（最高 200 轮），不需要手动设置；
            工具调用、有效运行时间与连续无进展也有预算。任一项用尽时会停下并说明原因（不是完成），
            已完成的进度会保留，可随时继续。
          </p>
        </div>

        <ul className="goal-dialog-notes">
          <li className="goal-dialog-note">
            <span className="goal-dialog-diamond" aria-hidden />
            每轮只推进可验证的一部分，结束后自动继续下一轮
          </li>
          <li className="goal-dialog-note">
            <span className="goal-dialog-diamond" aria-hidden />
            随时可以暂停、继续或结束，已完成的内容不会丢
          </li>
          <li className="goal-dialog-note">
            <span className="goal-dialog-diamond" aria-hidden />
            完成或遇到阻塞时自动停止，并在目标条上说明原因
          </li>
        </ul>

        {error ? (
          <p className="goal-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="goal-dialog-fine mono">Ctrl+Enter 快速建立</p>
      </div>
    </Modal>
  )
}
