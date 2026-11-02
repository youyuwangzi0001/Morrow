/** OpenCode 的纯协议规则：本机 auth.json 解析、Zen 模型与请求改写。 */
import type { ModelInfo } from '../../shared/types'
import { asRecord, asString } from './agent-protocol-utils'

export const OPENCODE_ZEN_BASE = 'https://opencode.ai/zen/v1'

export const OPENCODE_MODELS: ModelInfo[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 400_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 200_000, maxOutput: 128_000, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', contextWindow: 262_144, maxOutput: 32_768, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'OpenCode Zen' },
  { id: 'big-pickle', label: 'Big Pickle', contextWindow: 128_000, maxOutput: 32_768, supportsTools: true, note: 'OpenCode Zen' }
]

/**
 * 本机 `auth.json` 按 provider 分键。只取 `type:"api"` 的密钥；
 * 优先 OpenCode Zen 自己的键，其次任意 api 键。OAuth 记录（Copilot/Codex）不在这里冒用。
 */
export function parseOpencodeAuth(payload: unknown): {
  key: string
  provider: string
  type: 'api' | 'oauth' | 'wellknown'
} | null {
  const root = asRecord(payload)
  if (!root) return null
  const preferred = ['opencode', 'opencode-zen', 'zen', 'opencode-zen-api']
  const entries = Object.entries(root)
    .map(([provider, value]) => ({ provider, record: asRecord(value) }))
    .filter((entry): entry is { provider: string; record: Record<string, unknown> } => Boolean(entry.record))
  const ordered = [
    ...preferred.flatMap((name) => entries.filter((entry) => entry.provider.toLowerCase() === name)),
    ...entries.filter((entry) => !preferred.some((name) => entry.provider.toLowerCase() === name))
  ]
  for (const entry of ordered) {
    const type = asString(entry.record.type)
    const key = asString(entry.record.key) ?? asString(entry.record.apiKey)
    if (type === 'api' && key) return { key, provider: entry.provider, type: 'api' }
  }
  return null
}

/** Zen `/models` → ModelInfo；目录不可用时由调用方回退到随包列表。 */
export function parseOpencodeModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload)
  const data = asRecord(root?.data)
  const list = Array.isArray(root?.data)
    ? root!.data
    : Array.isArray(data?.models) ? data!.models
      : Array.isArray(root?.models) ? root!.models
        : Array.isArray(payload) ? payload : []
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const id = asString(row.id) ?? asString(row.name)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label: asString(row.name) ?? id,
      contextWindow: Number(row.context_length ?? row.context_window ?? row.contextWindow) || 128_000,
      maxOutput: Number(row.max_output_tokens ?? row.maxOutputTokens) || 32_768,
      supportsTools: true,
      note: 'OpenCode Zen'
    })
  }
  return models
}

export function rewriteOpencodeBody(raw: string): string {
  const body = asRecord(JSON.parse(raw))
  if (!body) return raw
  body.stream = true
  body.stream_options = { ...(asRecord(body.stream_options) ?? {}), include_usage: true }
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) body.max_tokens = 32_768
  return JSON.stringify(body)
}
