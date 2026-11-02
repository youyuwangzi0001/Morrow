/** 计划步骤与 todo 的匹配规则（主进程完成判定与渲染层进度共用）。 */
import type { SessionPlan, TodoItem } from './types'

const TODO_TEXT_LIMIT = 200

/** todo_write 会把文本截到 200 字，匹配时统一按同样口径归一化。 */
export function planStepKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TODO_TEXT_LIMIT)
}

export function todoMatchesPlanStep(todo: TodoItem, stepText: string): boolean {
  return planStepKey(todo.text) === planStepKey(stepText)
}

export function planStepsCompleted(plan: SessionPlan, todos: TodoItem[]): boolean {
  if (plan.steps.length === 0) return false
  const completed = new Set(
    todos.filter((todo) => todo.status === 'completed').map((todo) => planStepKey(todo.text))
  )
  return plan.steps.every((step) => completed.has(planStepKey(step.text)))
}

/** 批准计划时建立全新的待办；此前的计划模式 todo 不应被当成已完成进度。 */
export function todosFromPlan(plan: SessionPlan): TodoItem[] {
  return plan.steps.map((step) => ({ id: `todo_${step.id}`, text: step.text, status: 'pending' as const }))
}
