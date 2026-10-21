/**
 * 定时任务：共享的调度规则、校验与展示文案。
 * 只做纯时间计算，不依赖 Electron，主进程与渲染层共用。
 */

export type ScheduleKind = 'once' | 'daily' | 'weekly'
export type ScheduledPermission = 'read-only' | 'auto'
export type ScheduledTaskStatus = 'never' | 'running' | 'success' | 'error' | 'stopped' | 'missed'

export interface ScheduleSpec {
  kind: ScheduleKind
  /** 本地时间 HH:mm（24 小时制） */
  time: string
  /** once：本地日期 YYYY-MM-DD */
  date?: string
  /** weekly：0=周日 … 6=周六 */
  weekday?: number
}

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  schedule: ScheduleSpec
  /** 绑定的工作区；null = 不绑定文件夹 */
  workspace: string | null
  permissionMode: ScheduledPermission
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 下一次自动执行时间；暂停/一次性已执行后为 null */
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: ScheduledTaskStatus
  lastError?: string
  lastSessionId?: string
}

export interface ScheduledTaskInput {
  title: string
  prompt: string
  schedule: ScheduleSpec
  workspace: string | null
  permissionMode: ScheduledPermission
  enabled: boolean
}

export const SCHEDULE_MAX_TASKS = 50
export const SCHEDULE_MAX_TITLE_CHARS = 80
export const SCHEDULE_MAX_PROMPT_CHARS = 20_000
/** 应用重启后，错过不超过这个时间的任务会补跑一次。 */
export const SCHEDULE_CATCHUP_MS = 60 * 60 * 1000
/** 单次自动运行的最长等待（防止提问/挂起占住队列）。 */
export const SCHEDULE_RUN_TIMEOUT_MS = 30 * 60 * 1000

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === 'once' || value === 'daily' || value === 'weekly'
}

export function isScheduledPermission(value: unknown): value is ScheduledPermission {
  return value === 'read-only' || value === 'auto'
}

function parseTime(value: string): { hours: number; minutes: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(year, month - 1, day)
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null
  return { year, month, day }
}

function atTime(base: Date, hours: number, minutes: number): Date {
  const next = new Date(base.getTime())
  next.setHours(hours, minutes, 0, 0)
  return next
}

/**
 * 计算下一次执行时间（本地时区）。
 * - once：日期+时间必须存在；返回时间可能早于 from，调用方据此给出「已过去」错误。
 * - daily：今天该时刻已过则明天。
 * - weekly：本周该星期几已过则下周。
 * 返回 null 表示规则本身无效。
 */
export function computeNextRun(spec: ScheduleSpec, from: number = Date.now()): number | null {
  const time = parseTime(spec.time)
  if (!time) return null
  const base = new Date(from)
  if (spec.kind === 'once') {
    if (!spec.date) return null
    const date = parseDate(spec.date)
    if (!date) return null
    const target = new Date(date.year, date.month - 1, date.day, time.hours, time.minutes, 0, 0)
    return target.getTime()
  }
  if (spec.kind === 'daily') {
    const target = atTime(base, time.hours, time.minutes)
    if (target.getTime() <= from) target.setDate(target.getDate() + 1)
    return target.getTime()
  }
  if (spec.kind === 'weekly') {
    if (typeof spec.weekday !== 'number' || !Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6) {
      return null
    }
    const target = atTime(base, time.hours, time.minutes)
    let delta = (spec.weekday - target.getDay() + 7) % 7
    if (delta === 0 && target.getTime() <= from) delta = 7
    target.setDate(target.getDate() + delta)
    return target.getTime()
  }
  return null
}

/** 校验并规范化调度规则；不合法时抛出可直接展示给用户的中文错误。 */
export function validateScheduleSpec(spec: ScheduleSpec, from: number = Date.now()): {
  spec: ScheduleSpec
  nextRunAt: number
} {
  if (!spec || !isScheduleKind(spec.kind)) throw new Error('请选择执行频率。')
  if (!parseTime(spec.time)) throw new Error('时间格式不对，应为 HH:mm。')
  const normalized: ScheduleSpec = { kind: spec.kind, time: spec.time.trim() }
  if (spec.kind === 'once') {
    if (!spec.date || !parseDate(spec.date)) throw new Error('请选择一个有效日期。')
    normalized.date = spec.date
    const next = computeNextRun(normalized, from)
    if (next === null) throw new Error('执行时间不合法。')
    if (next <= from + 5_000) throw new Error('一次性任务的时间需要晚于现在。')
    return { spec: normalized, nextRunAt: next }
  }
  if (spec.kind === 'weekly') {
    if (typeof spec.weekday !== 'number' || !Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6) {
      throw new Error('请选择星期几。')
    }
    normalized.weekday = spec.weekday
  }
  const next = computeNextRun(normalized, from)
  if (next === null) throw new Error('执行时间不合法。')
  return { spec: normalized, nextRunAt: next }
}

/** 「每天 09:00」「每周一 09:00」「10月22日 09:00 · 一次」 */
export function describeSchedule(spec: ScheduleSpec, options: { withOnceSuffix?: boolean } = {}): string {
  const time = spec.time
  if (spec.kind === 'daily') return `每天 ${time}`
  if (spec.kind === 'weekly') {
    const weekday = typeof spec.weekday === 'number' ? WEEKDAY_LABELS[spec.weekday] ?? '' : ''
    return weekday ? `每${weekday} ${time}` : `每周 ${time}`
  }
  const date = spec.date ? parseDate(spec.date) : null
  const label = date ? `${date.month}月${date.day}日 ${time}` : `一次 ${time}`
  return options.withOnceSuffix === false ? label : `${label} · 一次`
}

/** 下一次执行的简短中文描述；用于列表与状态条。 */
export function describeNextRun(nextRunAt: number | null, now: number = Date.now()): string {
  if (nextRunAt === null) return '未安排'
  const date = new Date(nextRunAt)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfTarget - startOfToday) / 86_400_000)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const time = `${hh}:${mm}`
  if (nextRunAt <= now) return '即将执行'
  const diff = nextRunAt - now
  if (diff < 60_000) return '不到 1 分钟后'
  if (dayDiff === 0) return `今天 ${time}`
  if (dayDiff === 1) return `明天 ${time}`
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} 天后 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export function describeLastStatus(status: ScheduledTaskStatus): string {
  switch (status) {
    case 'never':
      return '还没运行'
    case 'running':
      return '正在运行'
    case 'success':
      return '上次成功'
    case 'error':
      return '上次失败'
    case 'stopped':
      return '上次已停止'
    case 'missed':
      return '上次错过'
  }
}
