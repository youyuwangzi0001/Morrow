/**
 * Google Antigravity 的纯协议规则：OAuth 常量、可选模型 → 运行时模型映射、
 * OpenAI Chat Completions ↔ Gemini generateContent 的请求/流事件转换、额度解析。
 */
import type { ModelInfo } from '../../shared/types'
import type { AgentSubscriptionQuota } from '../../shared/subscriptions'
import { asNumber, asRecord, asString, percentWindow, timestampMs } from './agent-protocol-utils'

export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const ANTIGRAVITY_CLIENT_SECRET = process.env.MORROW_ANTIGRAVITY_CLIENT_SECRET?.trim() ?? ''
export const ANTIGRAVITY_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
]
export const ANTIGRAVITY_PRIMARY = 'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_FALLBACK = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_REDIRECT_PATH = '/oauth-callback'

export const ANTIGRAVITY_MODELS: ModelInfo[] = [
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1_000_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 200_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 200_000, maxOutput: 65_536, supportsTools: true, supportsReasoning: true, reasoningStyle: 'effort', note: 'Antigravity' }
]

const ROUTING: Record<string, { off: string; routing: Record<string, string>; default: string }> = {
  'gemini-4-argon': {
    off: 'gemini-4-argon-low',
    routing: { minimal: 'gemini-4-argon-low', low: 'gemini-4-argon-low', medium: 'gemini-4-argon-medium', high: 'gemini-4-argon-high', xhigh: 'gemini-4-argon-high' },
    default: 'gemini-4-argon-medium'
  },
  'gemini-3.8-flash': {
    off: 'gemini-3.8-flash-tiered',
    routing: { minimal: 'gemini-3.8-flash-tiered', low: 'gemini-3.8-flash-tiered', medium: 'gemini-3.8-flash-tiered', high: 'gemini-3.8-flash-tiered', xhigh: 'gemini-3.8-flash-tiered' },
    default: 'gemini-3.8-flash-tiered'
  },
  'gemini-3.7-flash': {
    off: 'gemini-3.7-flash-low',
    routing: { minimal: 'gemini-3.7-flash-low', low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high', xhigh: 'gemini-3.7-flash-high' },
    default: 'gemini-3.7-flash-medium'
  },
  'gemini-3.5-flash': {
    off: 'gemini-3.5-flash-extra-low',
    routing: { minimal: 'gemini-3.5-flash-extra-low', low: 'gemini-3.5-flash-extra-low', medium: 'gemini-3.5-flash-low', high: 'gemini-3-flash-agent', xhigh: 'gemini-3-flash-agent' },
    default: 'gemini-3-flash-agent'
  },
  'gemini-3.1-pro': {
    off: 'gemini-3.1-pro-low',
    routing: { minimal: 'gemini-3.1-pro-low', low: 'gemini-3.1-pro-low', medium: 'gemini-pro-agent', high: 'gemini-pro-agent', xhigh: 'gemini-pro-agent' },
    default: 'gemini-pro-agent'
  },
  'gemini-2.5-pro': {
    off: 'gemini-2.5-pro',
    routing: { minimal: 'gemini-2.5-pro', low: 'gemini-2.5-pro', medium: 'gemini-2.5-pro', high: 'gemini-2.5-pro', xhigh: 'gemini-2.5-pro' },
    default: 'gemini-2.5-pro'
  },
  'gemini-2.5-flash': {
    off: 'gemini-2.5-flash',
    routing: { minimal: 'gemini-2.5-flash', low: 'gemini-2.5-flash', medium: 'gemini-2.5-flash', high: 'gemini-2.5-flash', xhigh: 'gemini-2.5-flash' },
    default: 'gemini-2.5-flash'
  },
  'claude-opus-5-5': {
    off: 'claude-opus-5-5-low',
    routing: { off: 'claude-opus-5-5-low', none: 'claude-opus-5-5-low', minimal: 'claude-opus-5-5-low', low: 'claude-opus-5-5-low', medium: 'claude-opus-5-5-medium', high: 'claude-opus-5-5-high', xhigh: 'claude-opus-5-5-high' },
    default: 'claude-opus-5-5-medium'
  },
  'claude-sonnet-5-5': {
    off: 'claude-sonnet-5-5-low',
    routing: { off: 'claude-sonnet-5-5-low', none: 'claude-sonnet-5-5-low', minimal: 'claude-sonnet-5-5-low', low: 'claude-sonnet-5-5-low', medium: 'claude-sonnet-5-5-medium', high: 'claude-sonnet-5-5-high', xhigh: 'claude-sonnet-5-5-high' },
    default: 'claude-sonnet-5-5-medium'
  }
}

let toolCallCounter = 0
export function sanitizeToolCallId(id: string | undefined, name: string): string {
  const cleaned = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned || `${name || 'tool'}_${Date.now()}_${++toolCallCounter}`
}

export function antigravityRuntime(model: string, effort?: string): string {
  const entry = ROUTING[model]
  if (!entry) return model
  const selected = (effort ?? 'medium').toLowerCase()
  return entry.routing[selected] ?? entry.default
}

export function isClaudeRuntime(runtime: string): boolean {
  return /^claude-/i.test(runtime)
}

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  'You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. '
  + 'You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.'
export const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists, or thinking/personality preambles in the final response. Output only the final response.'
export const ANTIGRAVITY_PROGRESS_INSTRUCTION =
  'Before EVERY tool call, emit 1-2 short sentences of ordinary visible assistant text stating what you are about to do and why. Never write those sentences only inside thinking. Keep them brief and factual.'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const row = asRecord(part)
    return asString(row?.text) ?? ''
  }).join('')
}

function imagePart(url: string): Record<string, unknown> | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url)
  if (!match) return null
  return { inlineData: { mimeType: match[1], data: match[2] } }
}

interface OpenAiMessage {
  role?: string
  content?: unknown
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  name?: string
}

function userParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const item of content) {
    const row = asRecord(item)
    if (!row) continue
    if (row.type === 'text' && asString(row.text)) parts.push({ text: asString(row.text) })
    else if (row.type === 'image_url') {
      const url = asString(asRecord(row.image_url)?.url)
      const converted = url ? imagePart(url) : null
      if (converted) parts.push(converted)
      else if (url) parts.push({ text: `[图片：${url.slice(0, 120)}]` })
    }
  }
  return parts
}

/** Gemini functionDeclarations 只接受 OpenAPI 子集；去掉会 400 的 JSON Schema 关键字。 */
export function sanitizeGeminiSchema(value: unknown, depth = 0): unknown {
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map((item) => sanitizeGeminiSchema(item, depth + 1))
  const row = asRecord(value)
  if (!row) return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(row)) {
    if (['$schema', '$id', '$defs', 'definitions', 'additionalProperties', 'patternProperties', 'examples', 'default'].includes(key)) continue
    if (key === 'type' && Array.isArray(raw)) {
      const types = raw.map((item) => String(item))
      const hasNull = types.includes('null')
      const nonNull = types.filter((item) => item !== 'null')
      out.type = nonNull[0] ?? 'string'
      if (hasNull) out.nullable = true
      continue
    }
    if (key === 'oneOf') {
      out.anyOf = Array.isArray(raw) ? raw.map((item) => sanitizeGeminiSchema(item, depth + 1)) : raw
      continue
    }
    if (key === 'const') {
      out.enum = [raw]
      continue
    }
    if (key === 'properties' && asRecord(raw)) {
      out.properties = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([name, schema]) => [name, sanitizeGeminiSchema(schema, depth + 1)])
      )
      continue
    }
    if (key === 'items' || key === 'anyOf' || key === 'allOf') {
      out[key] = Array.isArray(raw) ? raw.map((item) => sanitizeGeminiSchema(item, depth + 1)) : sanitizeGeminiSchema(raw, depth + 1)
      continue
    }
    out[key] = typeof raw === 'object' && raw !== null ? sanitizeGeminiSchema(raw, depth + 1) : raw
  }
  return out
}

/** OpenAI Chat Completions 请求 → Gemini contents + tools + generationConfig。 */
export function buildAntigravityRequest(
  rawBody: string,
  projectId: string
): { envelope: Record<string, unknown>; runtime: string } {
  const body = asRecord(JSON.parse(rawBody)) ?? {}
  const model = asString(body.model) ?? 'gemini-3.1-pro'
  const effort = asString(body.reasoning_effort)
  const runtime = antigravityRuntime(model, effort)
  const messages = Array.isArray(body.messages) ? body.messages as OpenAiMessage[] : []
  const systemTexts: string[] = []
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []
  const toolNames = new Map<string, string>()
  const toolIds = new Map<string, string>()
  const needsToolIds = isClaudeRuntime(runtime) || /^gpt-oss-/i.test(runtime)
  let pendingToolParts: Array<Record<string, unknown>> = []

  const flushTools = (): void => {
    if (pendingToolParts.length === 0) return
    contents.push({ role: 'user', parts: pendingToolParts })
    pendingToolParts = []
  }
  const push = (role: 'user' | 'model', parts: Array<Record<string, unknown>>): void => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    const role = asString(message.role)
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text) systemTexts.push(text)
      continue
    }
    if (role === 'tool') {
      const callId = asString(message.tool_call_id) ?? ''
      const name = toolNames.get(callId) ?? asString(message.name) ?? 'tool'
      const content = textOf(message.content)
      const wireId = toolIds.get(callId) ?? (needsToolIds ? sanitizeToolCallId(callId, name) : undefined)
      pendingToolParts.push({
        functionResponse: { name, response: { result: content }, ...(wireId ? { id: wireId } : {}) }
      })
      continue
    }
    flushTools()
    if (role === 'assistant') {
      const parts: Array<Record<string, unknown>> = []
      const text = textOf(message.content)
      if (text) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        const name = asString(call.function?.name)
        if (!name) continue
        const id = asString(call.id)
        if (id) toolNames.set(id, name)
        const wireId = needsToolIds ? sanitizeToolCallId(id, name) : undefined
        if (id && wireId) toolIds.set(id, wireId)
        let args: Record<string, unknown> = {}
        try {
          args = asRecord(JSON.parse(call.function?.arguments ?? '{}')) ?? {}
        } catch {
          args = { raw: call.function?.arguments ?? '' }
        }
        parts.push({
          functionCall: { name, args, ...(wireId ? { id: wireId } : {}) },
          thoughtSignature: 'skip_thought_signature_validator'
        })
      }
      push('model', parts)
      continue
    }
    push('user', userParts(message.content))
  }
  flushTools()
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '你好' }] })

  const generationConfig: Record<string, unknown> = {}
  const temperature = asNumber(body.temperature)
  if (temperature !== undefined) generationConfig.temperature = temperature
  const maxTokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens) ?? 32_768
  generationConfig.maxOutputTokens = Math.min(maxTokens, 65_536)

  const selected = (effort ?? 'medium').toLowerCase()
  const off = selected === 'off' || selected === 'none'
  const isTiered = /^gemini-.+-tiered$/.test(runtime)
  const isGemini25 = runtime.startsWith('gemini-2.5-') || model.startsWith('gemini-2.5-')
  const isClaude = isClaudeRuntime(runtime)
  if (isTiered) {
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === 'high' || selected === 'xhigh' ? 'HIGH' : selected === 'medium' ? 'MEDIUM' : 'LOW',
      includeThoughts: !off
    }
  } else if (isGemini25) {
    generationConfig.thinkingConfig = { thinkingBudget: 8_192, includeThoughts: !off }
  } else if (!isClaude) {
    generationConfig.thinkingConfig = { includeThoughts: !off }
  }

  const request: Record<string, unknown> = {
    contents,
    systemInstruction: {
      role: 'user',
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        ...(systemTexts.length > 0 ? [{ text: systemTexts.join('\n\n') }] : [])
      ]
    },
    generationConfig
  }

  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length > 0) {
    const declarations = tools.flatMap((item) => {
      const fn = asRecord(asRecord(item)?.function)
      if (!fn || !asString(fn.name)) return []
      return [{
        name: asString(fn.name),
        ...(asString(fn.description) ? { description: asString(fn.description) } : {}),
        ...(asRecord(fn.parameters) ? { parameters: sanitizeGeminiSchema(fn.parameters) } : {})
      }]
    })
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }]
    const choice = body.tool_choice
    const mode = choice === 'none' ? 'NONE' : choice === 'required' ? 'ANY' : 'AUTO'
    request.toolConfig = { functionCallingConfig: { mode } }
  }

  return {
    runtime,
    envelope: {
      project: projectId,
      model: runtime,
      request,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }
  }
}

export type AntigravityEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool'; name: string; args: string }
  | { type: 'finish'; reason: string }
  | { type: 'usage'; input: number; output: number; cached: number }
  | { type: 'error'; message: string }

/** 一帧 `data:` JSON → 统一事件。 */
export function parseAntigravityFrame(payload: unknown): AntigravityEvent[] {
  const root = asRecord(payload) ?? {}
  const response = asRecord(root.response) ?? root
  const events: AntigravityEvent[] = []
  const error = asRecord(response.error) ?? asRecord(root.error)
  if (error) {
    events.push({ type: 'error', message: asString(error.message) ?? 'Antigravity 返回了错误。' })
    return events
  }
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const candidate = asRecord(candidates[0])
  const content = asRecord(candidate?.content)
  const parts = Array.isArray(content?.parts) ? content!.parts : []
  for (const item of parts) {
    const part = asRecord(item)
    if (!part) continue
    const text = asString(part.text)
    if (text) events.push({ type: part.thought === true ? 'thought' : 'text', text })
    const call = asRecord(part.functionCall)
    const name = asString(call?.name)
    if (name) events.push({ type: 'tool', name, args: JSON.stringify(asRecord(call?.args) ?? {}) })
  }
  const finish = asString(candidate?.finishReason)
  if (finish) events.push({ type: 'finish', reason: finish })
  const usage = asRecord(response.usageMetadata)
  if (usage) {
    const input = asNumber(usage.promptTokenCount) ?? 0
    const output = (asNumber(usage.candidatesTokenCount) ?? 0) + (asNumber(usage.thoughtsTokenCount) ?? 0)
    const cached = asNumber(usage.cachedContentTokenCount) ?? 0
    if (input || output) events.push({ type: 'usage', input, output, cached })
  }
  return events
}

export function parseAntigravityQuota(payload: unknown, fetchedAt = Date.now()): AgentSubscriptionQuota {
  const root = asRecord(payload) ?? {}
  const groups = Array.isArray(root.groups) ? root.groups : []
  const windows = groups.flatMap((group) => {
    const groupRow = asRecord(group) ?? {}
    const groupName = asString(groupRow.displayName) ?? 'Antigravity'
    const buckets = Array.isArray(groupRow.buckets) ? groupRow.buckets : []
    return buckets.flatMap((bucket) => {
      const row = asRecord(bucket)
      if (!row) return []
      const fraction = asNumber(row.remainingFraction)
      if (fraction === undefined) return []
      const name = asString(row.displayName) ?? asString(row.bucketId) ?? '额度'
      return [percentWindow(
        `${groupName}-${name}`,
        `${groupName} · ${name}`,
        (1 - Math.max(0, Math.min(1, fraction))) * 100,
        timestampMs(row.resetTime)
      )]
    })
  })
  return {
    windows,
    fetchedAt,
    ...(windows.length === 0 ? { message: 'Antigravity 没有返回可识别的额度桶。' } : {})
  }
}
