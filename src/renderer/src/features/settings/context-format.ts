// 上下文/模型的数字格式化（R5 设置重做 + 标题栏 + Composer 共用）。
import type { Usage } from '@shared/types'

function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(2)))
}

/** 用量数字：<1000 保留整数，≥1k 用 k（保留一位），≥1M 用 M */
export function formatUsageTokens(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`
  if (value >= 1000) return `${trimNumber(Math.round(value / 100) / 10)}k`
  return String(Math.round(value))
}

/**
 * 模型元数据（上下文窗口 / 最大输出）：官网习惯用 1024 进制（1M = 1048576）。
 * 1_048_576 -> 1M，393_216 -> 384K，65_536 -> 64K，1_000_000 -> 1M。
 */
export function formatModelWindow(value?: number | null): string {
  if (value === undefined || value === null || value <= 0) return '—'
  // 同时存在两种约定：128,000 官方写作 128K（十进制整除），393,216 官方写作 384K（1024 进制）。
  // 优先按十进制整除判断，否则按 1024 进制，避免把 128K 显示成 125K。
  const base = value % 1000 === 0 ? 1000 : value % 1024 === 0 ? 1024 : 1000
  if (value >= base * base) return `${trimNumber(value / (base * base))}M`
  if (value >= base) return `${trimNumber(value / base)}K`
  return String(value)
}

/** 精确整数（带千分位），用于 tooltip / 明细 */
export function formatExactTokens(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

export interface ContextSnapshot {
  used: number
  limit: number
  ratio: number
  percent: number
  /** 用量来自服务商 API 返回（精确）还是字符估算 */
  source: 'api' | 'estimate'
}

/**
 * 会话上下文快照：limit 取 usage.contextLimit，其次当前模型 contextWindow。
 * R5 内核会把最近一次请求的真实 prompt+completion tokens 写进 contextUsed；
 * 只要收到过 API usage，就按「API 精确」展示，否则是字符估算。
 */
export function contextSnapshot(
  usage: Usage | null | undefined,
  fallbackLimit?: number | null
): ContextSnapshot {
  const limit = Math.max(0, usage?.contextLimit || fallbackLimit || 0)
  const used = Math.max(0, usage?.contextUsed ?? 0)
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const apiUsage = (usage?.inputTokens ?? 0) > 0 || (usage?.outputTokens ?? 0) > 0
  return {
    used,
    limit,
    ratio,
    percent: Math.round(ratio * 100),
    source: apiUsage && used > 0 ? 'api' : 'estimate'
  }
}

export function contextSourceLabel(source: ContextSnapshot['source']): string {
  return source === 'api' ? 'API 精确' : '字符估算'
}
