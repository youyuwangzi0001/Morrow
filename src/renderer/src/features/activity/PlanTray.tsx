import { ChevronDown, ListChecks } from 'lucide-react'
import type { TodoItem } from '@shared/types'
import { useAppStore } from '../../state/store'
import './activity.css'

/** 模块级常量：selector 必须返回稳定引用，避免 zustand 无限重渲染 */
const EMPTY_TODOS: TodoItem[] = []

const STATUS_TEXT: Record<TodoItem['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成'
}

/**
 * 计划托盘：有 todo 时出现在 Composer 上方。
 * 细线进度 + 方块状态点；进行中金色脉冲，完成铜绿 + 删除线弱化。
 */
export function PlanTray(): React.JSX.Element | null {
  const todos = useAppStore((s) => s.session?.todos ?? EMPTY_TODOS)
  const expanded = useAppStore((s) => s.planExpanded)
  const setExpanded = useAppStore((s) => s.setPlanExpanded)
  const running = useAppStore((s) => s.run !== null)

  if (todos.length === 0) return null

  const completed = todos.filter((todo) => todo.status === 'completed').length
  const allDone = completed === todos.length
  const active = todos.find((todo) => todo.status === 'in_progress') ?? null

  return (
    <section className={['plan-tray', expanded ? 'is-expanded' : '', allDone ? 'is-complete' : ''].filter(Boolean).join(' ')} aria-label="计划">
      <button
        type="button"
        className="plan-head"
        aria-expanded={expanded}
        aria-controls="plan-todo-list"
        onClick={() => setExpanded(!expanded)}
      >
        <ListChecks size={14} strokeWidth={1.5} className="plan-icon" aria-hidden />
        <span className="plan-title">{allDone ? '计划完成' : '计划'}</span>
        <span className="plan-progress mono">
          {completed}/{todos.length}
        </span>
        {!expanded && active ? <span className="plan-current">{active.text}</span> : null}
        {running && !allDone ? <span className="plan-running mono">进行中</span> : null}
        <ChevronDown size={14} strokeWidth={1.6} className="plan-chevron" aria-hidden />
      </button>

      <div className="plan-collapse" aria-hidden={!expanded}>
        <div className="plan-collapse-inner">
          <ul className="plan-list" id="plan-todo-list">
            {todos.map((todo) => (
              <li key={todo.id} className={`plan-item is-${todo.status}`}>
                <span className="plan-dot" aria-hidden />
                <span className="plan-text">{todo.text}</span>
                <span className="sr-only">{STATUS_TEXT[todo.status]}</span>
              </li>
            ))}
          </ul>
          <div className="plan-rule" aria-hidden>
            <span style={{ width: `${Math.round((completed / todos.length) * 100)}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}
