/** MiniMax Code 的纯协议规则：区域、模型、请求改写与额度解析。 */
import type { ModelInfo } from '../../shared/types'
import type { AgentQuotaWindow, AgentSubscriptionQuota } from '../../shared/subscriptions'
import { asNumber, asRecord, asString, percentWindow, timestampMs } from './agent-protocol-utils'

export type MinimaxRegion = 'cn' | 'global'

export const MINIMAX_REGIONS: Record<MinimaxRegion, { label: string; account: string; agent: string; quota: string[] }> = {
  cn: {
    label: '中国站（minimax.cn）',
    account: 'https://account.minimax.cn',
    agent: 'https://agent.minimax.cn',
    quota: ['https://api.minimax.cn', 'https://api.minimaxi.com']
  },
  global: {
    label: '全球区（minimax.io）',
    account: 'https://account.minimax.io',
    agent: 'https://agent.minimax.io',
    quota: ['https://api.minimax.io']
  }
}

export const MINIMAX_CLIENT_ID = 'mcode-public'
export const MINIMAX_SCOPE = 'agent.default'
export const MINIMAX_AUDIENCE = 'agent-backend'
export const MINIMAX_MESSAGES_PREFIX = '/mavis/api/v1/llm/v1'
export const MINIMAX_QUOTA_PATH = '/v1/api/openplatform/coding_plan/remains'

export const MINIMAX_MODELS: ModelInfo[] = [
  {
    id: 'MiniMax-M3',
    label: 'MiniMax M3',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'MiniMax Code'
  },
  {
    id: 'MiniMax-M3.1-Flash',
    label: 'MiniMax M3.1 Flash',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'MiniMax Code'
  },
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax M2.7',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsTools: true,
    note: 'MiniMax Code'
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    label: 'MiniMax M2.7 HighSpeed',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsTools: true,
    note: 'MiniMax Code · 高速'
  }
]

/** M2.7 不接受思考字段；M3 用 adaptive 选择思考通道，M3.1 只发 output_config。 */
export function rewriteMinimaxBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  const model = typeof body.model === 'string' ? body.model : ''
  const thinking = asRecord(body.thinking)
  const requested = asString(body.reasoning_effort)
  const budget = asNumber(thinking?.budget_tokens)
  const inferred = requested ?? (budget === undefined ? undefined
    : budget <= 1_024 ? 'low'
      : budget <= 4_096 ? 'medium'
        : budget <= 8_192 ? 'high'
          : budget <= 16_384 ? 'xhigh' : 'max')
  delete body.thinking
  delete body.reasoning_effort
  if (!/M2\.7/i.test(model)) {
    const off = inferred === 'off' || inferred === 'none'
    // M3 是 toggle 模型：adaptive 让思考进入 thinking 块；M3.1 是 forced-effort，不能发 thinking。
    if (!/M3\.1/i.test(model)) body.thinking = { type: off ? 'disabled' : 'adaptive' }
    if (!off) {
      body.output_config = { effort: inferred && inferred !== 'minimal' ? inferred : 'high' }
      delete body.temperature
    }
  }
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 32_768
  return JSON.stringify(body)
}

/**
 * `/v1/api/openplatform/coding_plan/remains`：`model_remains[]` 每个模型两窗口。
 * `current_interval_status === 3` 且两个总量都为 0 表示该模型没有额度桶，直接丢弃。
 */
export function parseMinimaxQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const rows = asRecord(payload)?.model_remains
  if (!Array.isArray(rows)) {
    return { windows: [], fetchedAt, message: '额度接口没有返回可识别的数据。' }
  }
  const windows: AgentQuotaWindow[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (!row) continue
    const name = asString(row.model_name) ?? 'MiniMax'
    const intervalTotal = asNumber(row.current_interval_total_count) ?? 0
    const weeklyTotal = asNumber(row.current_weekly_total_count) ?? 0
    const intervalStatus = asNumber(row.current_interval_status) ?? 0
    const weeklyStatus = asNumber(row.current_weekly_status) ?? 0
    if (intervalTotal === 0 && weeklyTotal === 0 && intervalStatus === 3 && weeklyStatus === 3) continue
    const add = (suffix: string, remainingPercent: number | undefined, usedPercent: number | undefined, resetAt: number | undefined): void => {
      if (remainingPercent === undefined && usedPercent === undefined) return
      const percent = usedPercent ?? (remainingPercent !== undefined ? 100 - remainingPercent : undefined)
      windows.push(percentWindow(`${name}-${suffix}`, `${name} · ${suffix}`, percent, resetAt))
    }
    add(
      '5 小时',
      asNumber(row.current_interval_remaining_percent),
      undefined,
      timestampMs(row.end_time)
    )
    add(
      '每周',
      asNumber(row.current_weekly_remaining_percent),
      undefined,
      timestampMs(row.weekly_end_time)
    )
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}

/**
 * 本机 MiniMax Code 的 auth.json（`records` 形）与扁平形都兼容。
 * 返回第一个带 access/refresh 的记录；区域由调用方按文件路径决定。
 */
export function parseMinimaxLocalAuth(payload: unknown): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  recordKey?: string
} | null {
  const root = asRecord(payload)
  if (!root) return null
  const records = asRecord(root.records)
  const candidates: Array<[string | undefined, Record<string, unknown>]> = records
    ? Object.entries(records).flatMap(([key, value]) => {
        const row = asRecord(value)
        return row ? [[key, row] as [string, Record<string, unknown>]] : []
      })
    : [['', root]]
  for (const [key, row] of candidates) {
    const accessToken = asString(row.accessToken) ?? asString(row.access_token)
    const refreshToken = asString(row.refreshToken) ?? asString(row.refresh_token)
    const expiresAt = asNumber(row.expiresAtMs) ?? timestampMs(row.expires_at) ?? timestampMs(row.expiresAt)
    if (!accessToken || !refreshToken || !expiresAt) continue
    return {
      accessToken,
      refreshToken,
      expiresAt,
      ...(key ? { recordKey: key } : {})
    }
  }
  return null
}
