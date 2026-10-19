import type { ModelInfo, ProviderConfig } from '../../shared/types'

export interface SyncModelsOutcome {
  added: number
  updated: number
  total: number
  message: string
  models: ModelInfo[]
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
export async function syncProviderModels(
  config: ProviderConfig,
  apiKey: string | null
): Promise<SyncModelsOutcome> {
  if (config.kind === 'demo') throw new Error('演示引擎不需要同步模型。')
  if (!apiKey) throw new Error('请先保存 API Key，再同步模型列表。')
  const base = config.baseUrl.replace(/\/+$/, '')
  const isAnthropic = config.kind === 'anthropic'
  const url = isAnthropic ? `${base}/v1/models` : `${base}/models`
  const res = await fetch(url, {
    method: 'GET',
    headers: isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(config.headers ?? {}) }
      : { Authorization: `Bearer ${apiKey}`, ...(config.headers ?? {}) },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(explain(res.status))
  const payload = (await res.json()) as { data?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>> }
  const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
  if (raw.length === 0) throw new Error('服务商没有返回任何模型。')

  const existingById = new Map(config.models.map((model) => [model.id, model]))
  const models: ModelInfo[] = []
  let added = 0
  let updated = 0
  for (const item of raw) {
    const id = String(item.id ?? item.name ?? item.model ?? '').trim()
    if (!id) continue
    const existing = existingById.get(id)
    const contextRaw =
      item.context_window ?? item.context_length ?? item.max_context_length ?? item.input_token_limit
    const outputRaw = item.max_output_tokens ?? item.max_tokens ?? item.output_token_limit
    const contextWindow =
      typeof contextRaw === 'number' && contextRaw > 0
        ? Math.round(contextRaw)
        : (existing?.contextWindow ?? (isAnthropic ? 200_000 : 131_072))
    const maxOutput =
      typeof outputRaw === 'number' && outputRaw > 0
        ? Math.round(outputRaw)
        : (existing?.maxOutput ?? (isAnthropic ? 16_384 : 8_192))
    const label =
      (typeof item.display_name === 'string' && item.display_name) ||
      (typeof item.name === 'string' && item.name) ||
      existing?.label ||
      id
    const info: ModelInfo = {
      id,
      label,
      contextWindow,
      maxOutput,
      supportsTools: existing?.supportsTools ?? true,
      supportsReasoning: existing?.supportsReasoning ?? true,
      ...(existing?.note ? { note: existing.note } : {})
    }
    if (existing) updated += 1
    else added += 1
    models.push(info)
  }
  if (models.length === 0) throw new Error('返回的模型列表无法解析。')
  return {
    added,
    updated,
    total: models.length,
    message: `已同步 ${models.length} 个模型（新增 ${added} 个 / 更新 ${updated} 个）。上下文与输出上限以服务商返回为准。`,
    models
  }
}
