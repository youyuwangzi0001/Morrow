/** Cline Pass 的纯协议规则：模型、请求改写、额度与非流式 envelope 解包。 */
import type { ModelInfo } from '../../shared/types'
import type { AgentSubscriptionQuota } from '../../shared/subscriptions'
import { asNumber, asRecord, asString, percentWindow, timestampMs } from './agent-protocol-utils'

export const CLINE_BASE = 'https://api.cline.bot/api/v1'
export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
export const CLINE_MODEL_PREFIX = 'cline-pass/'

const MODELS: Array<{ id: string; label: string; contextWindow: number }> = [
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 200_000 },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 384_000 },
  { id: 'glm-5.3', label: 'GLM-5.3', contextWindow: 200_000 },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', label: 'Kimi K3', contextWindow: 262_144 },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextWindow: 262_144 },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 262_144 },
  { id: 'minimax-m3', label: 'MiniMax M3', contextWindow: 512_000 },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', contextWindow: 262_144 },
  { id: 'qwen3.7-max', label: 'Qwen3.7 Max', contextWindow: 262_144 },
  { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', contextWindow: 262_144 },
  { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', contextWindow: 200_000 },
  { id: 'mimo-v2.5', label: 'MiMo V2.5', contextWindow: 200_000 }
]

export const CLINE_MODELS: ModelInfo[] = MODELS.map((model) => ({
  id: `${CLINE_MODEL_PREFIX}${model.id}`,
  label: model.label,
  contextWindow: model.contextWindow,
  maxOutput: 64_000,
  supportsTools: true,
  note: 'Cline Pass'
}))

export function rewriteClineBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  const model = typeof body.model === 'string' ? body.model : ''
  if (model && !model.startsWith(CLINE_MODEL_PREFIX)) body.model = `${CLINE_MODEL_PREFIX}${model}`
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 64_000
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  return JSON.stringify(body)
}

/** 非流式响应可能被包成 `{data:{choices...}}`；流式 SSE 原样透传。 */
export function unwrapClineJson(raw: string): string {
  try {
    const root = asRecord(JSON.parse(raw))
    const data = asRecord(root?.data)
    if (root?.success === true && data) return JSON.stringify(data)
    return raw
  } catch {
    return raw
  }
}

export function parseClineQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const limits = asRecord(root.data)?.limits
  if (!Array.isArray(limits)) {
    return { windows: [], fetchedAt, message: '额度接口没有返回可识别的数据。' }
  }
  const labels: Record<string, string> = {
    five_hour: '5 小时',
    'five-hour': '5 小时',
    weekly: '每周',
    monthly: '每月'
  }
  const windows = limits.flatMap((item) => {
    const row = asRecord(item)
    if (!row) return []
    const type = asString(row.type) ?? ''
    const percent = asNumber(row.percentUsed) ?? asNumber(row.percent_used)
    if (percent === undefined) return []
    return [percentWindow(type || 'window', labels[type] ?? type, percent, timestampMs(row.resetsAt))]
  })
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}
