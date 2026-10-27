// 创作台文本引擎：沿用 Morrow 已配置的模型，不另建第二套模型设置。
import type { ChatMessage, ModelInfo, ProviderConfig, Settings, Usage } from '../../shared/types'
import type { StudioEngineStatus, StudioProject } from '../../shared/studio'
import { findModel, isLocalServiceUrl } from '../../shared/models'
import { createProvider } from '../../core/providers'
import { getSettingsStore } from '../services/settings-store'

export type StudioTextStrategy = StudioProject['runtime']['strategy']

export interface StudioTextRouteInfo {
  providerId: string
  providerLabel: string
  modelId: string
  modelLabel: string
  local: boolean
  configured: boolean
  inputPerMTok?: number
  outputPerMTok?: number
}

export interface TextCandidate {
  config: ProviderConfig
  model: ModelInfo
  local: boolean
  apiKey: string | null
  default: boolean
}

const STRATEGY_LABEL: Record<StudioTextStrategy, string> = {
  'local-first': '本地优先',
  'cloud-first': '云端优先',
  'local-only': '只本地',
  'cloud-only': '只云端'
}

function isDemoConfig(config: ProviderConfig): boolean {
  return config.kind === 'demo' || config.id === 'demo'
}

function candidateKey(config: ProviderConfig, model: ModelInfo): string {
  return `${config.id}:${model.id}`
}

export function rankTextCandidates(
  settings: Pick<Settings, 'providers' | 'defaultModel'>,
  keyFor: (providerId: string) => string | null,
  strategy: StudioTextStrategy
): TextCandidate[] {
  const defaultKey = `${settings.defaultModel.providerId}:${settings.defaultModel.modelId}`
  const candidates: TextCandidate[] = []
  for (const config of settings.providers) {
    if (!config.enabled || isDemoConfig(config) || !Array.isArray(config.models)) continue
    const local = isLocalServiceUrl(config.baseUrl, { allowPrivate: true })
    if (strategy === 'local-only' && !local) continue
    if (strategy === 'cloud-only' && local) continue
    let apiKey = keyFor(config.id)
    if (!apiKey && local) apiKey = 'morrow-local'
    for (const model of config.models) {
      candidates.push({ config, model, local, apiKey, default: candidateKey(config, model) === defaultKey })
    }
  }
  const score = (candidate: TextCandidate): number => {
    let value = candidate.default ? 30 : 0
    if (candidate.apiKey) value += 100
    if (strategy === 'local-first') value += candidate.local ? 60 : 0
    if (strategy === 'cloud-first') value += candidate.local ? 0 : 60
    return value
  }
  return candidates.sort((left, right) => score(right) - score(left))
}

function rankCandidates(settings: Settings, strategy: StudioTextStrategy): TextCandidate[] {
  return rankTextCandidates(settings, (providerId) => getSettingsStore().getApiKey(providerId), strategy)
}

export function studioTextRoutes(strategy: StudioTextStrategy = 'local-first'): StudioTextRouteInfo[] {
  const settings = getSettingsStore().get()
  return rankCandidates(settings, strategy).slice(0, 8).map((candidate) => ({
    providerId: candidate.config.id,
    providerLabel: candidate.config.name,
    modelId: candidate.model.id,
    modelLabel: candidate.model.label,
    local: candidate.local,
    configured: Boolean(candidate.apiKey),
    ...(candidate.model.pricing ? { inputPerMTok: candidate.model.pricing.inputPerMTok, outputPerMTok: candidate.model.pricing.outputPerMTok } : {}),
    ...(candidate.model.contextWindow ? { contextWindow: candidate.model.contextWindow } : {}),
    ...(candidate.model.maxOutput ? { maxOutput: candidate.model.maxOutput } : {}),
    ...(candidate.model.supportsVision ? { supportsVision: true } : {}),
    ...(candidate.model.supportsTools ? { supportsTools: true } : {}),
    ...(candidate.model.supportsReasoning ? { supportsReasoning: true } : {})
  }))
}

export function studioVisionProvider(strategy: StudioTextStrategy = 'local-first'): { provider: ReturnType<typeof createProvider>; model: ModelInfo } | null {
  const runtime = studioTextRuntime(strategy)
  if (!runtime.configured || !runtime.config || !runtime.model || !runtime.model.supportsVision || !runtime.apiKey) return null
  return { provider: createProvider(runtime.config, runtime.apiKey, runtime.model.id), model: runtime.model }
}

export interface StudioTextRuntime {
  configured: boolean
  demo: boolean
  config: ProviderConfig | null
  model: ModelInfo | null
  apiKey: string | null
  message: string
}

export function studioTextRuntime(strategy: StudioTextStrategy = 'local-first'): StudioTextRuntime {
  const settings = getSettingsStore().get()
  const ranked = rankCandidates(settings, strategy)
  const chosen = ranked.find((candidate) => candidate.apiKey)
  if (chosen) {
    return {
      configured: true,
      demo: false,
      config: chosen.config,
      model: chosen.model,
      apiKey: chosen.apiKey,
      message: `${STRATEGY_LABEL[strategy]} · ${chosen.config.name} · ${chosen.model.label}${chosen.local ? ' · 本机' : ''}`
    }
  }
  const ref = settings.defaultModel
  const config = settings.providers.find((item) => item.id === ref.providerId) ?? null
  const model = config ? findModel(settings.providers, ref) ?? config.models[0] ?? null : null
  if (config && isDemoConfig(config)) {
    return {
      configured: false,
      demo: true,
      config,
      model,
      apiKey: null,
      message: '当前是离线演示模型；创作台会使用本地结构稿，不冒充模型写作。'
    }
  }
  if (!config) {
    return { configured: false, demo: false, config: null, model: null, apiKey: null, message: '还没有选择模型。可以先用本地结构稿，或到设置里连接模型。' }
  }
  if (!model) {
    return { configured: false, demo: false, config, model: null, apiKey: null, message: '这个提供方还没有可用模型。' }
  }
  const mode = STRATEGY_LABEL[strategy]
  const reason = strategy === 'local-only'
    ? '没有可用的本地文本模型；请到设置里配置本机 OpenAI 兼容服务，或改为其他策略。'
    : strategy === 'cloud-only'
      ? '没有可用的云端文本模型；请到 Agent 设置里配置云端提供方与 API Key。'
      : config.models.length
        ? `按「${mode}」没有找到带 Key 的可用模型；请到设置里检查账号与密钥。`
        : '这个提供方还没有可用模型。'
  return { configured: false, demo: false, config, model, apiKey: null, message: reason }
}

export interface CompletionResult {
  text: string
  model: string
  usage?: Usage
  costCny: number | null
  costNote?: string
}

/** 不带工具的纯文本补全；创作台的结构化动作都走这一条窄通道。 */
export async function completeCreativeText(options: {
  system: string
  prompt: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  strategy?: StudioTextStrategy
}): Promise<CompletionResult> {
  const runtime = studioTextRuntime(options.strategy ?? 'local-first')
  if (!runtime.configured || !runtime.config || !runtime.model) throw new Error(runtime.message)
  const provider = createProvider(runtime.config, runtime.apiKey, runtime.model.id)
  const message: ChatMessage = {
    id: `studio-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text: options.prompt }],
    createdAt: Date.now()
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let text = ''
  let usage: Usage | undefined
  try {
    const stream = provider.stream({
      system: options.system,
      messages: [message],
      tools: [],
      signal: controller.signal,
      maxTokens: options.maxTokens ?? Math.min(8000, runtime.model.maxOutput ?? 8000),
      temperature: options.temperature ?? 0.85
    })
    for await (const event of stream) {
      if (event.type === 'text_delta') text += event.text
      else if (event.type === 'usage') usage = event.usage
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  const trimmed = text.trim()
  if (!trimmed) throw new Error('模型没有返回可用的文本。请换一个模型或重试。')
  let costCny: number | null = null
  let costNote: string | undefined
  const pricing = runtime.model.pricing
  if (pricing && usage) {
    const usd = (usage.inputTokens / 1_000_000) * pricing.inputPerMTok + (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
    costCny = Math.round(usd * 7.2 * 1000) / 1000
    costNote = '按模型参考单价折算，实际以服务商账单为准'
  } else {
    costNote = '该模型没有可靠单价，费用显示为未知'
  }
  return { text: trimmed, model: runtime.model.label, ...(usage ? { usage } : {}), costCny, ...(costNote ? { costNote } : {}) }
}

export function textStatusForEngine(strategy: StudioTextStrategy = 'local-first'): StudioEngineStatus['text'] {
  const runtime = studioTextRuntime(strategy)
  return {
    configured: runtime.configured,
    ...(runtime.config ? { providerId: runtime.config.id, providerLabel: runtime.config.name } : {}),
    ...(runtime.model
      ? {
          modelId: runtime.model.id,
          modelLabel: runtime.model.label,
          ...(runtime.model.contextWindow ? { contextWindow: runtime.model.contextWindow } : {}),
          ...(runtime.model.maxOutput ? { maxOutput: runtime.model.maxOutput } : {}),
          ...(runtime.model.supportsVision ? { supportsVision: true } : {}),
          ...(runtime.model.supportsTools ? { supportsTools: true } : {}),
          ...(runtime.model.supportsReasoning ? { supportsReasoning: true } : {})
        }
      : {}),
    demo: runtime.demo,
    message: runtime.message,
    routes: studioTextRoutes(strategy)
  }
}

/** 按字符数粗估文本费用；没有单价时返回 null（界面必须显示未知）。 */
export function estimateTextCostCny(inputChars: number, outputChars: number, strategy: StudioTextStrategy = 'local-first'): number | null {
  const runtime = studioTextRuntime(strategy)
  if (!runtime.model?.pricing) return null
  const inputTokens = Math.ceil(inputChars / 1.7)
  const outputTokens = Math.ceil(outputChars / 1.7)
  const usd =
    (inputTokens / 1_000_000) * runtime.model.pricing.inputPerMTok +
    (outputTokens / 1_000_000) * runtime.model.pricing.outputPerMTok
  return Math.round(usd * 7.2 * 1000) / 1000
}

/** 从模型输出里提取第一个可解析 JSON 对象；容忍 ```json 围栏和前后说明。 */
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]
  const candidates = [fenced, trimmed]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    const slice = candidate.slice(start, end + 1)
    try {
      return JSON.parse(slice) as T
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}
