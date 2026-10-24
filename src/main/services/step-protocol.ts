/** Step Plan 的纯协议规则：profile、登录、模型目录与请求改写。 */
import type { ModelInfo } from '../../shared/types'
import { asNumber, asRecord, asString } from './agent-protocol-utils'

export type StepProfile = 'step_plan' | 'step_plan_oversea' | 'platform_cn' | 'platform_oversea'

export interface StepProfileConfig {
  label: string
  /** 模型面 base（末尾不带 /v1）。 */
  api: string
  auth: string
  keyPage: string
  requiresLogin: boolean
}

export const STEP_PROFILES: Record<StepProfile, StepProfileConfig> = {
  step_plan: {
    label: 'Step Plan（中国区）',
    api: 'https://api.stepfun.com/step_plan',
    auth: 'https://platform.stepfun.com',
    keyPage: 'https://platform.stepfun.com/step-plan',
    requiresLogin: true
  },
  step_plan_oversea: {
    label: 'Step Plan（国际区）',
    api: 'https://api.stepfun.ai/step_plan',
    auth: 'https://platform.stepfun.ai',
    keyPage: 'https://platform.stepfun.ai/step-plan',
    requiresLogin: true
  },
  platform_cn: {
    label: 'Step 开放平台（中国区 Key）',
    api: 'https://api.stepfun.com',
    auth: 'https://platform.stepfun.com',
    keyPage: 'https://platform.stepfun.com/interface-key',
    requiresLogin: false
  },
  platform_oversea: {
    label: 'Step 开放平台（国际区 Key）',
    api: 'https://api.stepfun.ai',
    auth: 'https://platform.stepfun.ai',
    keyPage: 'https://platform.stepfun.ai/interface-key',
    requiresLogin: false
  }
}

export const STEP_CLI_INIT_PATH = '/api/stdhttp/v1/cli-login/init'
export const STEP_CLI_POLL_PATH = '/api/stdhttp/v1/cli-login/poll'
export const STEP_MODELS_PATH = '/v1/models'
export const STEP_CHAT_PATH = '/v1/chat/completions'

export function profileOf(value: string | undefined): StepProfile {
  return value && value in STEP_PROFILES ? value as StepProfile : 'step_plan'
}

/** `/v1/models` → ModelInfo；上游字段全部按「可能缺失」处理。 */
export function parseStepModels(payload: unknown, profile: StepProfile = 'step_plan'): {
  models: ModelInfo[]
  efforts: Record<string, string[]>
} {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data)
  const list = Array.isArray(root.data)
    ? root.data
    : Array.isArray(data?.models) ? data!.models
      : Array.isArray(root.models) ? root.models
        : Array.isArray(payload) ? payload : []
  const models: ModelInfo[] = []
  const efforts: Record<string, string[]> = {}
  const seen = new Set<string>()
  const rows = list.map((item) => asRecord(item)).filter((row): row is Record<string, unknown> => Boolean(row))
  const typed = rows.some((row) => asString(row.model_type) !== undefined)
  const usable = new Set(['大语言模型', '路由模型'])
  for (const row of rows) {
    const id = asString(row.id)
    if (!id || seen.has(id)) continue
    if (typed && !usable.has(asString(row.model_type) ?? '')) continue
    seen.add(id)
    const contextWindow = asNumber(row.max_input_tokens) ?? 128_000
    const ladder = Array.isArray(row.reasoning_effort_support_list)
      ? row.reasoning_effort_support_list.map((value) => asString(value)).filter((value): value is string => Boolean(value))
      : []
    const supportsReasoning = row.enable_reason === true
      || (row.enable_reason === undefined && ladder.some((value) => !/^(off|none|disabled|disable)$/i.test(value)))
    if (supportsReasoning && ladder.length > 0) efforts[id] = ladder
    models.push({
      id,
      label: asString(row.name) ?? id,
      contextWindow,
      maxOutput: Math.min(contextWindow, 32_768),
      supportsTools: true,
      ...(supportsReasoning ? { supportsReasoning: true, reasoningStyle: 'effort' as const } : {}),
      note: STEP_PROFILES[profile].label
    })
  }
  return { models, efforts }
}

/**
 * Step 只接受 `max_tokens`，且思考档位必须落在该模型的支持列表里。
 * 不在列表里的档位收敛到最接近的一档；模型完全不支持思考时不发字段。
 */
export function rewriteStepBody(raw: string, effortLists: Record<string, string[]> = {}): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  const model = typeof body.model === 'string' ? body.model : ''
  const max = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens) ?? 32_768
  delete body.max_completion_tokens
  body.max_tokens = Math.max(1, max)
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  const allowed = (effortLists[model] ?? []).filter((value) => !/^(off|none|disabled|disable)$/i.test(value))
  const requested = asString(body.reasoning_effort)
  if (allowed.length === 0 || (requested && /^(off|none|disabled|disable)$/i.test(requested))) {
    delete body.reasoning_effort
  } else if (requested && !allowed.includes(requested)) {
    const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const target = order.indexOf(requested)
    const pick = allowed
      .filter((value) => order.includes(value))
      .sort((a, b) => Math.abs(order.indexOf(a) - target) - Math.abs(order.indexOf(b) - target))[0]
    if (pick) body.reasoning_effort = pick
    else delete body.reasoning_effort
  }
  return JSON.stringify(body)
}

/** 本机 StepCode auth.json 的两种形状。 */
export function parseStepLocalAuth(payload: unknown): {
  apiKey: string
  profile?: StepProfile
  uid?: string
} | null {
  const root = asRecord(payload)
  if (!root) return null
  const flatKey = asString(root.apiKey) ?? asString(root.api_key)
  if (flatKey) {
    const profile = asString(root.profile)
    return {
      apiKey: flatKey,
      ...(profile && profile in STEP_PROFILES ? { profile: profile as StepProfile } : {}),
      ...(asString(root.uid) ? { uid: asString(root.uid) } : {})
    }
  }
  const step = asRecord(root.step)
  if (step) {
    const key = asString(step.access) ?? asString(step.key) ?? asString(step.accessToken)
    if (key) {
      const profile = asString(step.profile)
      return {
        apiKey: key,
        ...(profile && profile in STEP_PROFILES ? { profile: profile as StepProfile } : {}),
        ...(asString(step.uid) ? { uid: asString(step.uid) } : {})
      }
    }
  }
  return null
}
