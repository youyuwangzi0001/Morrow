/** Kimi Code 的纯协议规则：模型目录、额度解析、Chat Completions 请求改写。 */
import type { ModelInfo } from '../../shared/types'
import type { AgentQuotaWindow, AgentSubscriptionQuota } from '../../shared/subscriptions'
import { asString } from './agent-protocol-utils'

const KIMI_MODELS_BASE: ModelInfo[] = [
  { id: 'k3', label: 'Kimi K3', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'k3-256k', label: 'Kimi K3 256K', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'kimi-for-coding', label: 'Kimi for Coding', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'kimi-for-coding-highspeed', label: 'Kimi for Coding 高速', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'k3.1-pro', label: 'Kimi K3.1 Pro', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' },
  { id: 'k3.1-pro-highspeed', label: 'Kimi K3.1 Pro 高速', contextWindow: 1_048_576, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Kimi Code' }
]

/** Kimi K3/K3.1 Pro/K2.8 支持 low/high/max；代理按真实档位改写，不固定 high。 */
export const KIMI_MODELS: ModelInfo[] = KIMI_MODELS_BASE.map((model) => ({
  ...model,
  ...(model.supportsReasoning ? { reasoningEfforts: ['low', 'high', 'max'] as ModelInfo['reasoningEfforts'] } : {})
}))

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function number(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function resetAt(value: unknown): number | undefined {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Kimi 的 Chat Completions 变体：
 * - 不接受 temperature / top_p；
 * - 只认 max_completion_tokens；
 * - thinking 开启时每条 assistant 消息都必须带 reasoning_content（空串也算）。
 */
export function rewriteKimiBody(raw: string): string {
  const body = JSON.parse(raw) as Record<string, unknown>
  const maxTokens = number(body.max_completion_tokens) ?? number(body.max_tokens) ?? 32_768
  delete body.max_tokens
  delete body.temperature
  delete body.top_p
  delete body.presence_penalty
  delete body.frequency_penalty
  body.max_completion_tokens = Math.max(1_024, Math.min(maxTokens, 262_144))
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  const requested = asString(body.reasoning_effort)
  const effort = requested === 'low' || requested === 'high' || requested === 'max' ? requested : 'high'
  body.reasoning_effort = effort
  body.thinking = { type: 'enabled', effort, keep: 'all' }
  if (Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice === undefined) body.tool_choice = 'auto'
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const record = asRecord(message)
      if (record?.role === 'assistant' && typeof record.reasoning_content !== 'string') record.reasoning_content = ''
    }
  }
  return JSON.stringify(body)
}

export function parseKimiQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const usages = asRecord(root.usages) ?? asRecord(root.usageWindows) ?? {}
  const windows: AgentQuotaWindow[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string, entry: Record<string, unknown> | null): void => {
    if (!entry || seen.has(id)) return
    const total = number(entry.limit)
    const used = number(entry.used)
    const remaining = number(entry.remaining)
    const ratio = number(entry.used_ratio) ?? number(entry.usedRatio)
    const usedPercent = ratio !== undefined ? Math.max(0, Math.min(100, ratio * 100))
      : total !== undefined && total > 0 && used !== undefined ? (used / total) * 100
        : total !== undefined && total > 0 && remaining !== undefined ? ((total - remaining) / total) * 100
          : undefined
    const at = resetAt(entry.reset_time ?? entry.resetTime ?? entry.resetsAt)
    if (total === undefined && used === undefined && remaining === undefined && usedPercent === undefined) return
    seen.add(id)
    windows.push({
      id,
      label,
      ...(usedPercent !== undefined ? { usedPercent: Math.max(0, Math.min(100, usedPercent)) } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(at !== undefined ? { resetAt: at } : {})
    })
  }
  add('5h', '5 小时', asRecord(usages.limit_5h))
  add('7d', '每周', asRecord(usages.limit_7d))
  add('month-total', '每月总池', asRecord(usages.limit_month_total))
  add('month-code', '每月 Code', asRecord(usages.limit_month_code))
  // 兼容另一种形状：顶层 usage 表示 7 天池，limits[] 带 window 时长。
  if (windows.length === 0) {
    const top = asRecord(root.usage)
    if (top) add('7d', '每周', top)
  }
  const limits = Array.isArray(root.limits) ? root.limits : []
  for (const item of limits) {
    const entry = asRecord(item)
    if (!entry) continue
    const detail = asRecord(entry.detail) ?? entry
    const window = asRecord(entry.window)
    const duration = number(window?.duration)
    const minutes = duration === undefined ? undefined
      : asString(window?.timeUnit ?? window?.time_unit) === 'TIME_UNIT_HOUR' ? duration * 60 : duration
    const id = minutes === 300 ? '5h' : minutes === 10_080 ? '7d' : asString(entry.id) ?? asString(entry.name) ?? `limit-${windows.length + 1}`
    const label = minutes === 300 ? '5 小时' : minutes === 10_080 ? '每周' : asString(entry.name) ?? '额度'
    add(id, label, detail)
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}
