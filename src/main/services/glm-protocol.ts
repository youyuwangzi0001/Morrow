/** GLM Coding Plan（ZCode）的纯协议规则：区域、模型、请求改写与额度解析。 */
import type { ModelInfo } from '../../shared/types'
import type { AgentQuotaWindow, AgentSubscriptionQuota } from '../../shared/subscriptions'
import { asNumber, asRecord, asString, percentWindow, timestampMs } from './agent-protocol-utils'

export type GlmRegion = 'intl' | 'cn'

export interface GlmRegionConfig {
  label: string
  business: string
  api: string
  cliProvider: 'zai' | 'bigmodel'
}

export const GLM_REGIONS: Record<GlmRegion, GlmRegionConfig> = {
  intl: {
    label: '国际区（z.ai）',
    business: 'https://api.z.ai',
    api: 'https://api.z.ai',
    cliProvider: 'zai'
  },
  cn: {
    label: '中国区（bigmodel.cn）',
    business: 'https://bigmodel.cn',
    api: 'https://open.bigmodel.cn',
    cliProvider: 'bigmodel'
  }
}

export const ZCODE_API_BASE = 'https://zcode.z.ai/api/v1'
export const CLI_INIT_PATH = '/oauth/cli/init'
export const CLI_POLL_PATH = '/oauth/cli/poll'
export const ANTHROPIC_PATH = '/api/anthropic'
export const QUOTA_PATH = '/api/monitor/usage/quota/limit'
export const GLM_KEY_NAME = 'morrow-glm-coding-plan'

export const GLM_MODELS: ModelInfo[] = [
  {
    id: 'GLM-5.3',
    label: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'GLM Coding Plan'
  },
  {
    id: 'GLM-5.3-Flash',
    label: 'GLM-5.3 Flash',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'GLM Coding Plan · 多模态'
  },
  {
    id: 'GLM-5.2',
    label: 'GLM-5.2',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    reasoningStyle: 'thinking',
    note: 'GLM Coding Plan · 上一代旗舰'
  },
  {
    id: 'GLM-5-Turbo',
    label: 'GLM-5 Turbo',
    contextWindow: 200_000,
    maxOutput: 64_000,
    supportsTools: true,
    note: 'GLM Coding Plan · 快速推理'
  }
]

/**
 * Coding Plan 的 Anthropic 面要求流式与思考开启；思考深度用顶层 reasoning_effort，
 * 不发 Anthropic 的 budget_tokens。GLM-5-Turbo 不接受思考字段。
 */
export function rewriteGlmBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  const model = typeof body.model === 'string' ? body.model : ''
  if (/turbo/i.test(model)) {
    delete body.thinking
    delete body.reasoning_effort
    return JSON.stringify(body)
  }
  const thinking = asRecord(body.thinking)
  const budget = asNumber(thinking?.budget_tokens)
  const requested = asString(body.reasoning_effort) ?? (budget === undefined ? 'high'
    : budget <= 1_024 ? 'low'
      : budget <= 8_192 ? 'high' : 'max')
  const ladder = /5\.2/i.test(model) ? ['high', 'max'] : ['low', 'high', 'max']
  const rank: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
  const target = rank[requested] ?? rank.high!
  const snapped = ladder.reduce((best, value) =>
    Math.abs(rank[value]! - target) < Math.abs(rank[best]! - target)
      || (Math.abs(rank[value]! - target) === Math.abs(rank[best]! - target) && rank[value]! > rank[best]!)
      ? value : best, ladder[0]!)
  body.thinking = { type: 'enabled' }
  body.reasoning_effort = snapped
  if (typeof body.max_tokens === 'number' && body.max_tokens < 5_120) body.max_tokens = 8_192
  return JSON.stringify(body)
}

const QUOTA_WINDOWS: Record<number, { id: string; label: string }> = {
  3: { id: 'five-hour', label: '5 小时' },
  5: { id: 'monthly', label: '每月' },
  6: { id: 'weekly', label: '每周' }
}

/** `data.limits[]`：TOKENS_LIMIT 用 percentage，CREDIT_LIMIT 用 currentValue/usage。 */
export function parseGlmQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload)
  if (!root || root.success !== true) {
    return { windows: [], fetchedAt, message: '额度接口没有返回成功结果，请稍后重试。' }
  }
  const data = asRecord(root.data) ?? {}
  const list = Array.isArray(data.limits) ? data.limits : []
  const windows: AgentQuotaWindow[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const type = asString(row.type)
    if (type === 'TIME_LIMIT') continue
    const unit = asNumber(row.unit)
    const window = unit === undefined ? undefined : QUOTA_WINDOWS[unit]
    if (!window || seen.has(window.id)) continue
    let percent = asNumber(row.percentage)
    if (type === 'CREDIT_LIMIT') {
      const used = asNumber(row.currentValue)
      const total = asNumber(row.usage)
      if (used !== undefined && total !== undefined && total > 0) percent = (used / total) * 100
    }
    if (percent === undefined) continue
    seen.add(window.id)
    windows.push(percentWindow(window.id, window.label, percent, timestampMs(row.nextResetTime)))
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的套餐窗口。' } : {})
  }
}

/** 兑换链第 2 步：从 getCustomerInfo 里取默认机构与默认项目。 */
export function parseCustomerScope(payload: unknown): {
  organizationId: string
  projectId: string
  organizationName?: string
  projectName?: string
} {
  const data = asRecord(asRecord(payload)?.data) ?? asRecord(payload) ?? {}
  const orgs = Array.isArray(data.organizations)
    ? data.organizations
    : Array.isArray(data.orgs) ? data.orgs : []
  if (orgs.length === 0) throw new Error('账号下没有可用机构（getCustomerInfo 返回空列表）。')
  const normalized = orgs.map((item) => asRecord(item) ?? {})
  const org = normalized.find((item) => (asString(item.organizationName) ?? asString(item.name) ?? '').includes('默认机构'))
    ?? normalized[0]!
  const orgId = asString(org.organizationId) ?? asString(org.id) ?? asString(org.orgId)
  if (!orgId) throw new Error('客户信息里找不到机构 ID。')
  const projects = Array.isArray(org.projects) ? org.projects.map((item) => asRecord(item) ?? {}) : []
  if (projects.length === 0) throw new Error(`机构 ${orgId} 下没有可用项目。`)
  const project = projects.find((item) => (asString(item.projectName) ?? asString(item.name) ?? '').includes('默认项目'))
    ?? projects[0]!
  const projectId = asString(project.projectId) ?? asString(project.id) ?? asString(project.projectID)
  if (!projectId) throw new Error(`机构 ${orgId} 下找不到项目 ID。`)
  return {
    organizationId: orgId,
    projectId,
    ...(asString(org.organizationName) ? { organizationName: asString(org.organizationName) } : {}),
    ...(asString(project.projectName) ? { projectName: asString(project.projectName) } : {})
  }
}

/** 在 api_keys 列表里挑本线路自己创建的那把；没有就返回 null 让调用方新建。 */
export function pickGlmApiKey(payload: unknown): { id: string; name?: string } | null {
  const root = asRecord(payload)
  const inner = root?.data
  const data = Array.isArray(payload) ? payload : Array.isArray(inner) ? inner : asRecord(inner) ?? root
  const list = Array.isArray(data) ? data : Array.isArray(data?.apiKeys) ? data!.apiKeys : []
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const name = asString(row.name)
    if (name !== GLM_KEY_NAME) continue
    const id = asString(row.id) ?? asString(row.apiKeyId)
    if (id) return { id, ...(name ? { name } : {}) }
  }
  return null
}
