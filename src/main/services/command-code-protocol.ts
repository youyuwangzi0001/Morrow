/** Command Code 的纯协议规则：鉴权头、模型路由、请求改写与额度解析。 */
import type { ModelInfo } from '../../shared/types'
import type { AgentQuotaWindow, AgentSubscriptionQuota } from '../../shared/subscriptions'
import { asNumber, asRecord, asString, percentWindow, timestampMs } from './agent-protocol-utils'

export const COMMAND_CODE_API = 'https://api.commandcode.ai'
export const COMMAND_CODE_PROVIDER_PREFIX = '/provider/v1'
export const COMMAND_CODE_WHOAMI = '/alpha/whoami'
export const COMMAND_CODE_CREDITS = '/alpha/billing/credits'
export const COMMAND_CODE_STUDIO_AUTH = 'https://commandcode.ai/studio/auth/cli'

export const COMMAND_CODE_CHAT_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 384_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'moonshotai/Kimi-K3', label: 'Kimi K3', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'zai-org/GLM-5.3', label: 'GLM-5.3', contextWindow: 200_000, maxOutput: 64_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'MiniMaxAI/MiniMax-M3', label: 'MiniMax M3', contextWindow: 512_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'Qwen/Qwen3.8-Max', label: 'Qwen3.8 Max', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' },
  { id: 'xai/grok-4.6', label: 'Grok 4.6', contextWindow: 256_000, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Command Code' }
]

export const COMMAND_CODE_CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 200_000, maxOutput: 64_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'thinking', note: 'Command Code' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'thinking', note: 'Command Code' }
]

export function commandCodeHeaders(apiKey: string, platform = process.platform): Record<string, string> {
  const env = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'text/event-stream',
    'user-agent': 'command-code/1.0.0',
    'x-command-code-cli-version': '1.0.0',
    'x-command-code-cli-environment': env,
    'x-command-code-project-slug': 'morrow',
    'x-command-code-taste-learning': 'false',
    'x-command-code-session-id': 'morrow-session',
    'x-command-code-oss-primary-provider': 'chat-completions',
    'anthropic-version': '2023-06-01'
  }
}

/** GPT-5/6 与 o 系列只认 max_completion_tokens；其余模型用 max_tokens。 */
export function rewriteCommandCodeChat(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  const model = typeof body.model === 'string' ? body.model : ''
  const max = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens) ?? 32_768
  delete body.max_tokens
  delete body.max_completion_tokens
  if (/^(gpt-5|gpt-6|o[1-9])/i.test(model)) body.max_completion_tokens = max
  else body.max_tokens = max
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  const effort = asString(body.reasoning_effort)
  if (effort === 'none' || effort === 'off') delete body.reasoning_effort
  return JSON.stringify(body)
}

export function rewriteCommandCodeAnthropic(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  if (asRecord(body.thinking)) delete body.temperature
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 32_768
  return JSON.stringify(body)
}

/** 模型列表：`{data:[...]}` 或数组；按 `supported_endpoints` 分到 chat / messages。 */
export function parseCommandCodeCatalog(payload: unknown): {
  chat: ModelInfo[]
  claude: ModelInfo[]
} {
  const root = asRecord(payload)
  const list = Array.isArray(root?.data) ? root!.data : Array.isArray(root?.models) ? root!.models : Array.isArray(payload) ? payload : []
  const chat: ModelInfo[] = []
  const claude: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const id = asString(row.id) ?? asString(row.model)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const endpoints = Array.isArray(row.supported_endpoints)
      ? row.supported_endpoints.map((value) => asString(value)).filter((value): value is string => Boolean(value))
      : Array.isArray(row.supportedEndpoints)
        ? row.supportedEndpoints.map((value) => asString(value)).filter((value): value is string => Boolean(value))
        : []
    let wire: 'anthropic' | 'openai' | 'responses' | undefined
    for (const endpoint of endpoints) {
      if (/messages/i.test(endpoint)) { wire = 'anthropic'; break }
      if (/responses/i.test(endpoint)) { wire = 'responses'; break }
      if (/completions/i.test(endpoint)) { wire = 'openai'; break }
    }
    const isClaude = wire === 'anthropic' || (wire === undefined && /^claude[-/]/i.test(id))
    if (!isClaude && wire === 'responses') continue
    const contextWindow = asNumber(row.context_length) ?? asNumber(row.context_window) ?? asNumber(row.contextWindow) ?? asNumber(row.max_context_tokens) ?? 200_000
    const maxOutput = asNumber(row.max_output_tokens) ?? asNumber(row.maxOutputTokens) ?? Math.min(contextWindow, 32_768)
    const model: ModelInfo = {
      id,
      label: asString(row.name) ?? asString(row.display_name) ?? id,
      contextWindow,
      maxOutput,
      supportsTools: true,
      note: 'Command Code'
    }
    if (isClaude) {
      model.supportsReasoning = true
      model.reasoningStyle = 'thinking'
      claude.push(model)
    } else {
      model.supportsReasoning = true
      model.reasoningStyle = 'effort'
      chat.push(model)
    }
  }
  return { chat, claude }
}

export function parseCommandCodeAccount(payload: unknown): {
  email?: string
  name?: string
  uid?: string
  plan?: string
} {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const user = asRecord(data.user) ?? asRecord(data.profile) ?? asRecord(data.account) ?? asRecord(data.identity) ?? data
  const subscription = asRecord(data.subscription) ?? asRecord(data.plan) ?? {}
  const email = asString(user.email)
  const name = asString(user.userName) ?? asString(user.name) ?? asString(user.fullName)
  const uid = asString(user.id) ?? asString(user.userId) ?? asString(user.uid) ?? asString(root.userId)
  const plan = asString(subscription.name) ?? asString(subscription.displayName)
    ?? asString(data.planName) ?? asString(data.planLabel)
  return {
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(uid ? { uid } : {}),
    ...(plan ? { plan } : {})
  }
}

/** `/alpha/billing/credits` 的 `windowLimits`。 */
export function parseCommandCodeQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const data = asRecord(root.data) ?? root
  const limits = asRecord(data.windowLimits) ?? asRecord(data.window_limits) ?? asRecord(data.limits) ?? {}
  const windows: AgentQuotaWindow[] = []
  const labels: Record<string, string> = { fiveHour: '5 小时', daily: '每天', weekly: '每周', monthly: '每月' }
  for (const [key, raw] of Object.entries(limits)) {
    const row = asRecord(raw)
    if (!row) continue
    const used = asNumber(row.used)
    const cap = asNumber(row.cap) ?? asNumber(row.total) ?? asNumber(row.limit)
    const percent = asNumber(row.usedPercent) ?? asNumber(row.used_percent)
      ?? (used !== undefined && cap !== undefined && cap > 0 ? (used / cap) * 100 : undefined)
    const resetAt = timestampMs(row.resetAt) ?? timestampMs(row.reset_at)
    const label = labels[key] ?? key
    const window = percentWindow(key, label, percent, resetAt)
    if (window.usedPercent === undefined) continue
    windows.push({ ...window, ...(used !== undefined ? { used } : {}), ...(cap !== undefined ? { total: cap } : {}) })
  }
  const credits = asRecord(data.credits)
  const monthly = asNumber(credits?.monthlyCredits) ?? asNumber(credits?.monthly_credits)
  if (monthly !== undefined) {
    windows.push({ id: 'monthly-credits', label: '每月积分', remaining: monthly, unit: '积分' })
  }
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: '额度接口没有返回可识别的时间窗口。' } : {})
  }
}
