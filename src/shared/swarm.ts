/** Swarm 任务状态的小工具：主进程增量落盘与渲染层事件归并共用。 */
import type { SwarmTaskProgress, SwarmTaskStatus } from './types'

const STATUSES: SwarmTaskStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'exhausted']

function statusOf(value: unknown): SwarmTaskStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value) ? (value as SwarmTaskStatus) : 'failed'
}

/** 按 index 合并一个子任务的最新状态，保证乱序/并行事件不会互相覆盖。 */
export function mergeSwarmTask(
  tasks: SwarmTaskProgress[] | undefined,
  incoming: SwarmTaskProgress
): SwarmTaskProgress[] {
  const next = tasks ? tasks.map((task) => ({ ...task })) : []
  const index = next.findIndex((task) => task.index === incoming.index)
  if (index >= 0) next[index] = { ...next[index], ...incoming }
  else next.push({ ...incoming })
  return next.sort((a, b) => a.index - b.index)
}

/** 从工具结果 meta.tasks 还原最终状态（重载旧会话、补发事件时使用）。 */
export function swarmTasksFromMeta(meta: unknown): SwarmTaskProgress[] {
  if (!meta || typeof meta !== 'object') return []
  const raw = (meta as Record<string, unknown>).tasks
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry, position) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title : `子任务 ${position + 1}`
    return [
      {
        index: typeof item.index === 'number' ? item.index : position,
        title,
        agent: typeof item.agent === 'string' ? item.agent : typeof item.role === 'string' ? item.role : 'general',
        status: statusOf(item.status),
        ...(typeof item.steps === 'number' ? { stepCount: item.steps } : {}),
        ...(typeof item.summary === 'string' && item.summary ? { summary: item.summary } : {}),
        ...(typeof item.error === 'string' && item.error ? { error: item.error } : {})
      }
    ]
  })
}
