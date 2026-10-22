import type { ModelPricing, Usage } from './types'

/** 按参考价格估算一次用量（美元）；没有价格返回 undefined。 */
export function estimateUsageCost(usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined
  const cached = Math.min(usage.inputTokens, usage.cacheReadTokens ?? 0)
  const freshInput = Math.max(0, usage.inputTokens - cached)
  const inputCost = (freshInput / 1_000_000) * pricing.inputPerMTok
  const cachedCost = (cached / 1_000_000) * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok)
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  return Math.round((inputCost + cachedCost + outputCost) * 1_000_000) / 1_000_000
}

export function formatUsd(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** Token 热力图的日期工具与月份标签排布（纯函数，便于单测）。 */

const WEEKDAY_MS = 86_400_000
export const MONTH_LABEL_MIN_GAP = 3

export function parseDay(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / WEEKDAY_MS)
}

export function monthLabel(date: Date): string {
  return `${date.getMonth() + 1}月`
}

export function dayLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function startOfWeek(date: Date): Date {
  return addDays(date, -((date.getDay() + 6) % 7))
}

export interface MonthLabel {
  column: number
  label: string
}

/**
 * 月份标签对齐到「该月 1 日所在的周列」。
 * 起始月剩余不足 3 周时不标起始月，否则它会和下个月标签挤在一起；其余标签至少间隔 3 列。
 */
export function buildMonthLabels(rangeStart: Date, end: Date): MonthLabel[] {
  const gridStart = startOfWeek(rangeStart)
  const columns = Math.ceil((diffDays(gridStart, end) + 1) / 7)
  const boundaries: MonthLabel[] = []
  let monthStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + 1, 1)
  while (monthStart.getTime() <= end.getTime()) {
    const column = Math.floor(diffDays(gridStart, monthStart) / 7)
    if (column >= 0 && column < columns) boundaries.push({ column, label: monthLabel(monthStart) })
    monthStart = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1)
  }
  const labels: MonthLabel[] = []
  const nextMonthStart = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + 1, 1)
  if (diffDays(rangeStart, nextMonthStart) >= MONTH_LABEL_MIN_GAP * 7) {
    labels.push({ column: 0, label: monthLabel(rangeStart) })
  }
  for (const boundary of boundaries) {
    const previous = labels[labels.length - 1]
    if (previous && boundary.column - previous.column < MONTH_LABEL_MIN_GAP) continue
    labels.push(boundary)
  }
  return labels
}
