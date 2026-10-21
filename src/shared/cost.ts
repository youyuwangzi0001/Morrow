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
