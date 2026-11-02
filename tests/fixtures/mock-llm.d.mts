/**
 * `mock-llm.mjs` 的类型声明（供 engine 的 TS 单测直接 import 使用）。
 * 例：import { startMockLLM } from '../../fixtures/mock-llm.mjs'
 */

export type MockProtocol = 'openai' | 'anthropic'

export interface MockToolCallSpec {
  name: string
  /** 对象会被 JSON.stringify 后自动分片；字符串按原样分片 */
  arguments?: Record<string, unknown> | string | unknown[]
  /** 直接指定 JSON 参数字符串的分片（优先于 arguments） */
  argumentsChunks?: string[]
  /** 自动分片长度，默认 8 */
  argsChunkSize?: number
  id?: string
}

export interface MockErrorSpec {
  status: number
  message?: string
  type?: string
  retryAfterMs?: number
}

export interface MockScript {
  text?: string
  chunks?: string[]
  textChunkSize?: number
  reasoning?: string
  toolCalls?: MockToolCallSpec[]
  usage?: { inputTokens?: number; outputTokens?: number }
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'
  delayMs?: number
  chunkDelayMs?: number
  error?: MockErrorSpec
  hang?: true | number
  hangMs?: number
  rawSse?: string
}

export interface MockRequestRecord {
  index: number
  protocol: MockProtocol
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, any>
  messages: Array<Record<string, any>>
  lastUserMessage: Record<string, any> | null
  lastUserMessageText: string
  receivedAt: number
}

export interface MockScriptContext {
  index: number
  seq: number
  protocol: MockProtocol
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, any>
  raw: string
  messages: Array<Record<string, any>>
  lastUserMessage: Record<string, any> | null
  lastUserMessageText: string
  lastMessage: Record<string, any> | undefined
  record: MockRequestRecord
}

export interface MockLLMOptions {
  port?: number
  host?: string
  scripts?: Array<MockScript | string>
  defaultScript?: MockScript | string
  respond?: (ctx: MockScriptContext) => MockScript | string | undefined | null | Promise<MockScript | string | undefined | null>
  chunkDelayMs?: number
  models?: string[]
  onRequest?: (record: MockRequestRecord) => void
}

export interface MockLLMServer {
  readonly port: number
  readonly host: string
  readonly url: string
  readonly openaiBaseUrl: string
  readonly anthropicBaseUrl: string
  readonly models: string[]
  readonly requests: MockRequestRecord[]
  readonly calls: number
  readonly lastRequest: MockRequestRecord | undefined
  reset(next?: Array<MockScript | string> | { scripts?: Array<MockScript | string>; respond?: MockLLMOptions['respond']; defaultScript?: MockScript | string }): void
  pushScript(script: MockScript | string): void
  setScripts(scripts: Array<MockScript | string>): void
  setRespond(fn: MockLLMOptions['respond']): void
  close(): Promise<void>
}

export function startMockLLM(options?: MockLLMOptions): Promise<MockLLMServer>
export default startMockLLM
