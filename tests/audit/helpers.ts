/**
 * R7 审计 helper：隔离目录、工具上下文、本地 mock SSE 模型服务、假 Electron 窗口、假设置存储。
 * 所有临时文件都在 Morrow/tmp/audit/**，跑完由测试自行清理。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Artifact,
  ChatMessage,
  PermissionMode,
  ProviderConfig,
  RuntimeEvent,
  Settings,
  TodoItem
} from '../../src/shared/types'
import type { ToolContext } from '../../src/core/types'
import { SessionStore } from '../../src/main/services/session-store'
import { AgentService } from '../../src/main/services/agent-service'
import type { SettingsStore } from '../../src/main/services/settings-store'

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const AUDIT_TMP_ROOT = join(PROJECT_ROOT, 'tmp', 'audit')

/** 在 tmp/audit 下建唯一目录 */
export function makeAuditDir(name: string): string {
  mkdirSync(AUDIT_TMP_ROOT, { recursive: true })
  return mkdtempSync(join(AUDIT_TMP_ROOT, `${name}-`))
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

/* ── 工具上下文 ───────────────────────────────────────────────── */

export interface CtxState {
  todos: TodoItem[]
  artifacts: Artifact[]
  progressNotes: string[]
}

export function makeToolCtx(
  workspace: string,
  snapshotDir: string,
  overrides: Partial<ToolContext> = {},
  state: CtxState = { todos: [], artifacts: [], progressNotes: [] }
): ToolContext {
  return {
    sessionId: 'audit_session',
    runId: 'audit_run',
    messageId: 'audit_msg',
    toolUseId: 'audit_call_1',
    workspace,
    permissionMode: 'auto',
    snapshotDir,
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => state.todos,
    setTodos: (todos) => {
      state.todos = todos
    },
    getArtifacts: () => state.artifacts,
    addArtifact: (artifact) => state.artifacts.push(artifact),
    askUser: async () => ({ value: 'A', label: '方案 A' }),
    progress: (note) => state.progressNotes.push(note),
    runSubagent: async () => ({ summary: '子代理完成', steps: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    ...overrides
  }
}

export function userMessage(text: string): ChatMessage {
  return { id: `u_${Math.random().toString(36).slice(2, 8)}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
}

/* ── 本地 mock SSE 模型服务（OpenAI 兼容） ─────────────────────── */

export interface MockToolCall {
  name: string
  input: Record<string, unknown>
}

export interface MockReply {
  text?: string
  toolCalls?: MockToolCall[]
}

export interface MockSseServer {
  baseUrl: string
  requests: number
  lastBody: () => Record<string, unknown> | null
  close: () => Promise<void>
}

/** 每个请求交给 handler 决定回复内容；返回 OpenAI 兼容 SSE 流 */
export async function startMockSseServer(
  handler: (body: Record<string, unknown>) => MockReply
): Promise<MockSseServer> {
  let requests = 0
  let lastBody: Record<string, unknown> | null = null
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests += 1
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      lastBody = body
      const reply = handler(body)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      send({ id: 'audit-chunk', object: 'chat.completion.chunk', created: Date.now(), model: 'audit-mock', choices: [{ index: 0, delta: {}, finish_reason: null }] })
      if (reply.toolCalls?.length) {
        reply.toolCalls.forEach((call, index) => {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: `call_${requests}_${index}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })
        })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        const text = reply.text ?? '好的。'
        // 分两片发送，模拟流式
        for (const part of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
          if (!part) continue
          send({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests(): number {
      return requests
    },
    lastBody: () => lastBody,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise())
      })
  }
}

/* ── 假设置 / 真 SessionStore / 假窗口 ────────────────────────── */

export const AUDIT_MODEL_ID = 'audit-mock-model'

export function auditProviderConfig(baseUrl: string): ProviderConfig {
  return {
    id: 'audit-openai',
    kind: 'openai-compat',
    name: 'Audit Mock Provider',
    baseUrl,
    models: [
      {
        id: AUDIT_MODEL_ID,
        label: 'Audit Mock',
        contextWindow: 128_000,
        maxOutput: 4096,
        supportsTools: true
      }
    ],
    category: 'custom',
    apiKeyStored: true,
    enabled: true
  }
}

export class FakeSettingsStore {
  constructor(private readonly provider: ProviderConfig) {}

  get(): Settings {
    return {
      version: 1,
      theme: 'dark',
      fontSize: 14,
      reduceMotion: false,
      permissionMode: 'auto',
      sendKey: 'enter',
      providers: [this.provider],
      defaultModel: { providerId: this.provider.id, modelId: this.provider.models[0].id },
      lastWorkspace: null,
      recentWorkspaces: [],
      onboardingDone: true,
      sidebarCollapsed: false,
      demoSeen: false,
      showTokenMeter: false,
      sidebarWidth: 240,
      autoCompact: false,
      compactThreshold: 0.8,
      canvasWidth: 420,
      autoTitle: true
    }
  }

  getApiKey(): string {
    return 'sk-audit-local'
  }
}

/** 指向 tmp/audit 数据目录的真 SessionStore（会话 JSON 真落盘，可重开验证恢复） */
export function createAuditStores(dataDir: string, provider: ProviderConfig): {
  sessionStore: SessionStore
  service: AgentService
} {
  process.env.MORROW_AUDIT_DATA_DIR = dataDir
  const sessionStore = new SessionStore()
  const service = new AgentService(new FakeSettingsStore(provider) as unknown as SettingsStore, sessionStore)
  return { sessionStore, service }
}

export interface CapturedWindow {
  events: RuntimeEvent[]
  window: { isDestroyed: () => boolean; webContents: { send: (channel: string, event: RuntimeEvent) => void } }
}

export function makeCapturedWindow(): CapturedWindow {
  const events: RuntimeEvent[] = []
  return {
    events,
    window: {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, event: RuntimeEvent) => {
          if (channel === 'morrow:event') events.push(event)
        }
      }
    }
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (condition()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`)
}

export function countFiles(root: string, relativeDir: string): number {
  const dir = join(root, relativeDir)
  if (!existsSync(dir)) return 0
  try {
    return require('node:fs').readdirSync(dir).length as number
  } catch {
    return 0
  }
}
