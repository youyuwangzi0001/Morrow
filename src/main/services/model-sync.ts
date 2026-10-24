import type { ModelInfo, ProviderConfig } from '../../shared/types'
import { isLocalServiceUrl } from '../../shared/models'
import { resolveAnthropicMessagesUrl, resolveChatCompletionsUrl } from '../../core/providers/types'

export interface SyncModelsOutcome {
  added: number
  updated: number
  total: number
  message: string
  models: ModelInfo[]
  /** 服务商返回的条目超过上限或格式无效，列表被裁剪/跳过 */
  truncated?: boolean
  skipped?: number
}

/** 与设置存储的模型数量上限保持一致 */
const MAX_SYNC_MODELS = 200
const MAX_SYNC_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_MODEL_ID_CHARS = 160

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? number : null
}

function explain(status: number): string {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限。'
  if (status === 404) return '该服务商没有提供 /models 接口，或 Base URL 不对。'
  if (status === 429) return '请求太频繁，稍后再试。'
  return `服务商返回 HTTP ${status}。`
}

/**
 * 从服务商 /models 接口同步模型清单与上下文元数据。
 * - OpenAI 兼容：GET {baseUrl}/models（Bearer）
 * - Anthropic：GET {baseUrl}/v1/models（x-api-key）
 * 解析 context_window / context_length / max_output_tokens / max_tokens 等常见字段；
 * 服务商未提供的字段保留本地调研值。
 */
function isLocalProvider(config: ProviderConfig): boolean {
  return config.category === 'local' || isLocalServiceUrl(config.baseUrl, { allowPrivate: true })
}

export async function syncProviderModels(
  config: ProviderConfig,
  apiKey: string | null
): Promise<SyncModelsOutcome> {
  if (config.kind === 'demo') throw new Error('演示引擎不需要同步模型。')
  const local = isLocalProvider(config)
  // 本机 / 局域网 Ollama、LM Studio 通常不需要 Key；公网服务仍需先保存密钥
  if (!apiKey && !local) throw new Error('请先保存 API Key（本机或局域网服务可留空），再同步模型列表。')
  const isAnthropic = config.kind === 'anthropic'
  // 与推理地址使用同一套归一化：兼容裸域名、/v1、以及粘贴完整 /chat/completions 或 /v1/messages
  const url = isAnthropic
    ? resolveAnthropicMessagesUrl(config.baseUrl).replace(/\/messages$/, '/models')
    : resolveChatCompletionsUrl(config.baseUrl).replace(/\/chat\/completions$/, '/models')
  const authHeaders: Record<string, string> = apiKey
    ? isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` }
    : {}
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders, ...(config.headers ?? {}) },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(explain(res.status))
  const declaredLength = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SYNC_RESPONSE_BYTES) {
    throw new Error('服务商返回的模型列表过大（超过 5MB），已停止同步。')
  }
  const text = await res.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_SYNC_RESPONSE_BYTES) {
    throw new Error('服务商返回的模型列表过大（超过 5MB），已停止同步。')
  }
  let payload: { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error('服务商返回的不是 JSON（可能 Base URL 指向了网页，或服务商接口不可用）。')
  }
  const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
  if (raw.length === 0) throw new Error('服务商没有返回任何模型。')

  const existingById = new Map(config.models.map((model) => [model.id, model]))
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  let skipped = 0
  let capped = false
  for (const item of raw) {
    if (models.length >= MAX_SYNC_MODELS) {
      capped = true
      break
    }
    if (!item || typeof item !== 'object') {
      skipped += 1
      continue
    }
    const id = String(item.id ?? item.name ?? item.model ?? '').trim()
    if (!id || id.length > MAX_MODEL_ID_CHARS || seen.has(id)) {
      skipped += 1
      continue
    }
    seen.add(id)
    const existing = existingById.get(id)
    const contextRaw =
      item.context_window ?? item.context_length ?? item.max_context_length ?? item.input_token_limit
    const outputRaw = item.max_output_tokens ?? item.max_tokens ?? item.output_token_limit
    const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))
    const contextValue = positiveNumber(contextRaw)
    const outputValue = positiveNumber(outputRaw)
    const contextWindow = contextValue
      ? clampInt(contextValue, 1_024, 10_000_000)
      : (existing?.contextWindow ?? (isAnthropic ? 200_000 : 131_072))
    const maxOutput = outputValue
      ? clampInt(outputValue, 1, 2_000_000)
      : (existing?.maxOutput ?? (isAnthropic ? 16_384 : 8_192))
    const rawLabel = [item.display_name, item.name, existing?.label].find(
      (value): value is string => typeof value === 'string' && Boolean(value.trim())
    )
    const label = (rawLabel ?? id).trim().slice(0, 120) || id
    const supportsReasoning = existing?.supportsReasoning ?? true
    const reasoningStyle =
      existing?.reasoningStyle ?? (supportsReasoning ? (isAnthropic ? 'thinking' : 'effort') : undefined)
    const visionRaw = item.supports_vision ?? item.supports_image_input ?? item.vision
    const supportsVision = typeof visionRaw === 'boolean' ? visionRaw : existing?.supportsVision
    const info: ModelInfo = {
      id,
      label,
      contextWindow,
      maxOutput,
      supportsTools: existing?.supportsTools ?? true,
      supportsReasoning,
      ...(reasoningStyle ? { reasoningStyle } : {}),
      ...(supportsVision !== undefined ? { supportsVision } : {}),
      ...(existing?.note ? { note: existing.note } : {})
    }
    if (existing) updated += 1
    else added += 1
    models.push(info)
  }
  if (models.length === 0) throw new Error('返回的模型列表无法解析。')
  const notes: string[] = []
  if (capped) notes.push(`服务商返回的模型超过 ${MAX_SYNC_MODELS} 个，保留前 ${models.length} 个`)
  if (skipped > 0) notes.push(`跳过 ${skipped} 个无效或重复条目`)
  return {
    added,
    updated,
    total: models.length,
    message:
      `已同步 ${models.length} 个模型（新增 ${added} 个 / 更新 ${updated} 个）` +
      `${notes.length > 0 ? `；${notes.join('；')}` : ''}。` +
      '服务商返回的上下文与输出上限已更新；未返回的保留本地值。',
    models,
    ...(capped ? { truncated: true } : {}),
    ...(skipped > 0 ? { skipped } : {})
  }
}
