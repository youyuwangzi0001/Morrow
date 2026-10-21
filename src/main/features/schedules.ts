/**
 * 定时任务 feature IPC（feature:schedules:*）。
 * 状态变更会通过 feature:schedules:changed 广播给所有窗口。
 */
import { scheduledInputFromRecord } from '../services/schedule-store'
import {
  createSchedule,
  listSchedules,
  removeSchedule,
  runScheduleNow,
  setScheduleEnabled,
  updateSchedule
} from '../services/schedule-runtime'
import type { RegisterFeatureChannel } from './projects'

function record(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}

function requireId(payload: unknown): string {
  const id = record(payload).id
  if (typeof id !== 'string' || !id.trim()) throw new Error('缺少定时任务 id。')
  return id
}

export const SCHEDULES_FEATURE_CHANNELS = [
  'feature:schedules:list',
  'feature:schedules:create',
  'feature:schedules:update',
  'feature:schedules:remove',
  'feature:schedules:set-enabled',
  'feature:schedules:run-now'
] as const

export function registerSchedulesFeature(register: RegisterFeatureChannel): void {
  register('feature:schedules:list', () => listSchedules())

  register('feature:schedules:create', (payload) => createSchedule(scheduledInputFromRecord(payload)))

  register('feature:schedules:update', (payload) => {
    const data = record(payload)
    return updateSchedule(requireId(data), scheduledInputFromRecord(data))
  })

  register('feature:schedules:remove', (payload) => removeSchedule(requireId(payload)))

  register('feature:schedules:set-enabled', (payload) => {
    const data = record(payload)
    if (typeof data.enabled !== 'boolean') throw new Error('enabled 必须是布尔值。')
    return setScheduleEnabled(requireId(data), data.enabled)
  })

  register('feature:schedules:run-now', (payload) => runScheduleNow(requireId(payload)))
}
