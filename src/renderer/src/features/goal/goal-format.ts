import type { GoalStatus, GoalStopReason } from '@shared/types'

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  blocked: '已阻塞',
  cancelled: '已取消'
}

/** 停止原因人话（R7：停止 ≠ 完成，必须说清楚为什么停） */
export const GOAL_STOP_REASON_LABEL: Record<GoalStopReason, string> = {
  user_paused: '你暂停了目标，进度已保留',
  user_stopped: '你结束了目标（记为已取消，不是完成）',
  app_restarted: '应用重启，目标已自动暂停，可继续',
  error: '本轮运行出错，已暂停',
  budget_rounds: '轮次预算用尽，已停止（不是完成）',
  budget_tool_calls: '工具调用预算用尽，已停止（不是完成）',
  budget_time: '有效运行时间预算用尽，已停止（不是完成）',
  no_progress: '连续多轮没有实际进展，已停止（不是完成）',
  blocked: '遇到阻塞，需要你决定'
}

export function goalStopReasonText(reason?: GoalStopReason | null): string {
  return reason ? GOAL_STOP_REASON_LABEL[reason] ?? String(reason) : ''
}

export function goalRoundText(round: number, maxRounds: number): string {
  return `第 ${Math.max(1, Math.min(round, Math.max(1, maxRounds)))}/${maxRounds} 轮`
}

export function formatGoalTime(timestamp?: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function goalBudgetText(goal: {
  toolCalls?: number
  maxToolCalls?: number
  activeMs?: number
  maxActiveMs?: number
  noProgressRounds?: number
  maxNoProgressRounds?: number
}): string {
  const calls = `${goal.toolCalls ?? 0}/${goal.maxToolCalls ?? 200} 次调用`
  const minutes = `${Math.round((goal.activeMs ?? 0) / 60000)}/${Math.round((goal.maxActiveMs ?? 20 * 60000) / 60000)} 分钟`
  const noProgress = `${goal.noProgressRounds ?? 0}/${goal.maxNoProgressRounds ?? 3} 轮无进展`
  return `${calls} · ${minutes} · ${noProgress}`
}
