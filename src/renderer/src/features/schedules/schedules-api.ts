/**
 * 定时任务渲染层 API：只走已注册的 feature:schedules:* 频道。
 */
import type { ScheduledTask, ScheduledTaskInput } from '@shared/schedules'

export interface ScheduleState {
  tasks: ScheduledTask[]
  runningTaskIds: string[]
}

export interface ScheduleMutation extends ScheduleState {
  task: ScheduledTask
}

const PREFIX = 'feature:schedules:'

async function invoke<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.morrow.features.invoke<T>(`${PREFIX}${action}`, payload)
  if (!result.ok) throw new Error(result.error.message || '定时任务操作失败')
  return result.data
}

export const schedulesApi = {
  list: (): Promise<ScheduleState> => invoke('list'),
  create: (input: ScheduledTaskInput): Promise<ScheduleMutation> => invoke('create', input),
  update: (id: string, input: ScheduledTaskInput): Promise<ScheduleMutation> => invoke('update', { id, ...input }),
  remove: (id: string): Promise<ScheduleState> => invoke('remove', { id }),
  setEnabled: (id: string, enabled: boolean): Promise<ScheduleMutation> => invoke('set-enabled', { id, enabled }),
  runNow: (id: string): Promise<ScheduleState> => invoke('run-now', { id }),
  onChanged: (listener: (state: ScheduleState) => void): (() => void) => {
    return window.morrow.features.on('feature:schedules:changed', (payload) => {
      if (!payload || typeof payload !== 'object') return
      const state = payload as ScheduleState
      if (Array.isArray(state.tasks) && Array.isArray(state.runningTaskIds)) listener(state)
    })
  }
}
