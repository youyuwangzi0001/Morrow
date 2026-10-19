/**
 * R9 阶段 B：真实 DeepSeek 只跑 M40/M41/M42/M48/M49 各一遍（硬上限 ≤300 请求）。
 * R2-A—R2-H 机制结果由 mechanisms-final 单独产出，不占自主能力分。
 *
 * 解锁：MORROW_R9_LIVE=1 且 MORROW_R9_LIVE_CONFIRM=ONE_PASS_M40_M49。
 * 输出：docs/audit/r9-results.json（增量落盘）
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatMessage, ModelInfo, PermissionDecision, ProviderConfig, RuntimeEvent, Session } from '../../../src/shared/types'
import { AgentService } from '../../../src/main/services/agent-service'
import { SessionStore } from '../../../src/main/services/session-store'
import type { SettingsStore } from '../../../src/main/services/settings-store'
import { PROJECT_ROOT } from '../helpers'
import { QUESTIONS, r9SpecById, type R9CheckContext, type R9QuestionSpec } from './specs'

const BASE_URL = process.env.MORROW_R9_BASE_URL || 'https://api.deepseek.com/v1'
const MODEL_ID = 'deepseek-flash'
const MAX_REQUESTS = Number(process.env.MORROW_R9_MAX_REQUESTS || 300)
const RESULTS_FILE = process.env.MORROW_R9_RESULTS || join(PROJECT_ROOT, 'docs', 'audit', 'r9-results.json')
const RUN_ROOT = join(PROJECT_ROOT, 'tmp', 'audit', 'r9', 'live')
const MOCK_MCP = join(PROJECT_ROOT, 'tests', 'audit', 'r8', 'mocks', 'morrow-mock-mcp.mjs')

export interface Budget {
  used: number
  cap: number
  exhausted: boolean
}

export function installFetchBudget(budget: Budget): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (budget.used >= budget.cap) {
      budget.exhausted = true
      throw new Error('AUDIT_REQUEST_BUDGET_EXHAUSTED')
    }
    budget.used += 1
    return original(...args)
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

export function readDeepSeekKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const credPath = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml')
  if (!existsSync(credPath)) throw new Error('缺少凭据文件与 DEEPSEEK_API_KEY')
  const text = readFileSync(credPath, 'utf8')
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break
    const match = line.match(/^\s+DEEPSEEK_API_KEY:\s*(.+?)\s*$/)
    if (match) {
      let value = match[1].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      return value
    }
  }
  throw new Error('凭据 refs 缺 DEEPSEEK_API_KEY')
}

class LiveSettings {
  constructor(private readonly provider: ProviderConfig, private readonly key: string) {}
  get(): ReturnType<SettingsStore['get']> {
    return {
      version: 1,
      theme: 'dark',
      fontSize: 14,
      reduceMotion: false,
      permissionMode: 'auto',
      sendKey: 'enter',
      providers: [this.provider],
      defaultModel: { providerId: this.provider.id, modelId: MODEL_ID },
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
    } as ReturnType<SettingsStore['get']>
  }
  getApiKey(providerId: string): string | null {
    return providerId === this.provider.id ? this.key : null
  }
  hasAnyApiKey(): boolean {
    return true
  }
}

export type ApprovalPolicy = (request: { toolName: string; input: Record<string, unknown>; summary?: string }) => PermissionDecision

export interface HarnessOpts {
  dataDir: string
  workspace: string
  key: string
  model: ModelInfo
  mockStateDir?: string
  approval?: ApprovalPolicy
  answer?: string
}

export interface LiveHarness {
  service: AgentService
  store: SessionStore
  events: RuntimeEvent[]
  permissions: Array<Record<string, unknown>>
  questions: string[]
  window: unknown
  dispose: () => void
}

function writeMockConfig(mockStateDir: string): string {
  const configPath = join(mockStateDir, 'mcp.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        morrow_mock: {
          command: process.execPath,
          args: [MOCK_MCP],
          env: {
            MORROW_MOCK_STATE_DIR: mockStateDir,
            ...(process.env.MORROW_MOCK_CHILD45_TIMEOUT_MS
              ? { MORROW_MOCK_CHILD45_TIMEOUT_MS: process.env.MORROW_MOCK_CHILD45_TIMEOUT_MS }
              : {})
          },
          timeoutMs: 30_000,
          description: 'R9 审计 mock'
        }
      }
    }),
    'utf8'
  )
  return configPath
}

export function makeHarness(opts: HarnessOpts): LiveHarness {
  mkdirSync(opts.dataDir, { recursive: true })
  process.env.MORROW_AUDIT_DATA_DIR = opts.dataDir
  process.env.MORROW_DATA_DIR = opts.dataDir
  if (opts.mockStateDir) process.env.MORROW_MCP_CONFIG = writeMockConfig(opts.mockStateDir)
  else delete process.env.MORROW_MCP_CONFIG
  const provider: ProviderConfig = {
    id: 'deepseek-r9',
    kind: 'openai-compat',
    name: 'DeepSeek R9 audit',
    baseUrl: BASE_URL,
    models: [opts.model],
    category: 'cn',
    apiKeyStored: true,
    enabled: true
  }
  const settings = new LiveSettings(provider, opts.key)
  const store = new SessionStore()
  const events: RuntimeEvent[] = []
  const permissions: Array<Record<string, unknown>> = []
  const questions: string[] = []
  let service!: AgentService
  const defaultApproval: ApprovalPolicy = (request) =>
    request.toolName === 'mcp_call' && String((request.input as Record<string, unknown>).server ?? '') === 'morrow_mock' ? 'once' : 'deny'
  const approval = opts.approval ?? defaultApproval
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: RuntimeEvent) => {
        if (channel !== 'morrow:event') return
        events.push(event)
        if (event.type === 'question_asked') {
          questions.push(event.request.question)
          setTimeout(() => {
            try {
              service.respondQuestion(event.request.id, { value: opts.answer ?? '测试未提供答案', label: opts.answer ?? '测试未提供答案' })
            } catch {
              // ignore
            }
          }, 0)
        }
        if (event.type === 'permission_requested') {
          const request = event.request
          const decision = approval({ toolName: request.toolName, input: request.input, summary: request.summary })
          permissions.push({ toolName: request.toolName, input: request.input, summary: request.summary, decision })
          setTimeout(() => {
            try {
              service.respondPermission(request.id, decision)
            } catch {
              // ignore
            }
          }, 0)
        }
      }
    }
  }
  service = new AgentService(settings as unknown as SettingsStore, store)
  return { service, store, events, permissions, questions, window, dispose: () => service.dispose() }
}

export function waitFor(condition: () => boolean, timeoutMs: number, interval = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`waitFor timeout ${timeoutMs}ms`))
      }
    }, interval)
  })
}

export function createSession(harness: LiveHarness, workspace: string, title: string, permissionMode: 'auto' | 'ask' | 'read-only'): Session {
  return harness.store.create({
    workspace,
    model: { providerId: 'deepseek-r9', modelId: MODEL_ID },
    permissionMode,
    defaultModel: { providerId: 'deepseek-r9', modelId: MODEL_ID },
    defaultPermission: permissionMode,
    title
  })
}

export async function sendAndWait(harness: LiveHarness, sessionId: string, text: string, timeoutMs = 300_000): Promise<void> {
  const result = await harness.service.send({ sessionId, text }, harness.window as never)
  await waitFor(() => harness.events.some((event) => event.type === 'run_finished' && event.runId === result.runId), timeoutMs)
  await waitFor(() => !harness.service.isSessionRunning(sessionId), 20_000)
  await new Promise((resolve) => setTimeout(resolve, 100))
}

export function messagesOf(harness: LiveHarness, sessionId: string): ChatMessage[] {
  return harness.store.get(sessionId)?.messages ?? []
}

export function assistantText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')))
    .join('\n')
}

export function readMock(mockStateDir?: string): { state: Record<string, unknown>; calls: Array<Record<string, unknown>> } {
  if (!mockStateDir) return { state: {}, calls: [] }
  let state: Record<string, unknown> = {}
  let calls: Array<Record<string, unknown>> = []
  try {
    state = JSON.parse(readFileSync(join(mockStateDir, 'state.json'), 'utf8')) as Record<string, unknown>
  } catch {
    state = {}
  }
  try {
    calls = readFileSync(join(mockStateDir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    calls = []
  }
  return { state, calls }
}

export function makeContext(
  harness: LiveHarness,
  opts: {
    workspace: string
    baseDir: string
    sessions: ChatMessage[][]
    mode: 'work' | 'chat' | 'read-only'
    extra?: Record<string, unknown>
    mockStateDir?: string
    goal?: null
  }
): R9CheckContext {
  const messages = opts.sessions[opts.sessions.length - 1] ?? []
  return {
    workspace: opts.workspace,
    baseDir: opts.baseDir,
    events: harness.events,
    assistantText: assistantText(messages),
    assistantTexts: opts.sessions.map((items) => assistantText(items)),
    sessions: opts.sessions,
    permissions: harness.permissions,
    questions: harness.questions,
    goal: null,
    mode: opts.mode,
    mock: readMock(opts.mockStateDir),
    extra: opts.extra ?? {}
  }
}

export function seed(workspace: string, spec: R9QuestionSpec, scenarioIndex?: number): { oldHash?: string; oldResult?: string } {
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  const scenario = scenarioIndex !== undefined ? spec.scenarios?.[scenarioIndex] : undefined
  const files = scenario?.workspaceFiles ?? spec.workspaceFiles
  const outs = scenario?.outFiles ?? spec.outFiles
  for (const [relative, content] of Object.entries(files ?? {})) {
    const absolute = join(workspace, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  let oldHash: string | undefined
  let oldResult: string | undefined
  for (const [relative, content] of Object.entries(outs ?? {})) {
    const absolute = join(workspace, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
    if (relative === 'out/result.json') {
      oldResult = content
      oldHash = createHash('sha256').update(content).digest('hex')
    }
  }
  return { ...(oldHash ? { oldHash } : {}), ...(oldResult ? { oldResult } : {}) }
}

export function writeEvidence(dir: string, harness: LiveHarness, workspace: string, extra: Record<string, unknown>): string[] {
  mkdirSync(dir, { recursive: true })
  const evidence: string[] = []
  try {
    writeFileSync(join(dir, 'events.json'), JSON.stringify(harness.events, null, 2), 'utf8')
    evidence.push(join(dir, 'events.json'))
  } catch {
    // ignore
  }
  try {
    const sessions: Record<string, unknown> = {}
    for (const name of readdirSync(join(process.env.MORROW_AUDIT_DATA_DIR ?? '', 'sessions'))) {
      if (!name.endsWith('.json')) continue
      try {
        sessions[name] = JSON.parse(readFileSync(join(process.env.MORROW_AUDIT_DATA_DIR ?? '', 'sessions', name), 'utf8'))
      } catch {
        // ignore
      }
    }
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions, null, 2), 'utf8')
    evidence.push(join(dir, 'sessions.json'))
  } catch {
    // ignore
  }
  try {
    writeFileSync(join(dir, 'audit-extra.json'), JSON.stringify(extra, null, 2), 'utf8')
    evidence.push(join(dir, 'audit-extra.json'))
  } catch {
    // ignore
  }
  try {
    cpSync(join(workspace, 'out'), join(dir, 'out'), { recursive: true })
    evidence.push(join(dir, 'out'))
  } catch {
    // ignore
  }
  return evidence.map((path) => path.replace(PROJECT_ROOT, '.').replace(/\\/g, '/'))
}

export interface R9Record {
  id: string
  title: string
  declaredSupport: string
  status: 'PASS' | 'FAIL' | 'UNSUPPORTED' | 'INVALID' | 'NOT_RUN'
  detail: string
  invalid?: string
  requests: number
  toolCalls: number
  durationMs: number
  actual?: unknown
  evidence: string[]
}

export function toolCallCount(events: RuntimeEvent[]): number {
  return events.filter((event) => event.type === 'tool_started').length
}

export async function runOneQuestion(
  spec: R9QuestionSpec,
  suite: { root: string; key: string; budget: Budget; model: ModelInfo }
): Promise<R9Record> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(baseDir, { recursive: true })

  if (spec.declaredSupport === 'unsupported') {
    return {
      id: spec.id,
      title: spec.title,
      declaredSupport: spec.declaredSupport,
      status: 'UNSUPPORTED',
      detail: `开跑前已登记 UNSUPPORTED：${spec.supportNote}`,
      requests: 0,
      toolCalls: 0,
      durationMs: 0,
      evidence: []
    }
  }

  try {
    if (spec.id === 'M49') {
      const stageResults: Array<{ id: string; workspace: string; assistantText: string; oldHash?: string; oldResult?: string }> = []
      for (const [index, scenario] of (spec.scenarios ?? []).entries()) {
        const workspace = join(baseDir, `stage-${scenario.id}`, 'ws')
        const dataDir = join(baseDir, `stage-${scenario.id}`, 'data')
        const mockStateDir = join(baseDir, `stage-${scenario.id}`, 'mock-state')
        mkdirSync(mockStateDir, { recursive: true })
        const old = seed(workspace, spec, index)
        const harness = makeHarness({
          dataDir,
          workspace,
          key: suite.key,
          model: suite.model,
          mockStateDir: scenario.id === 'B' ? mockStateDir : undefined
        })
        const session = createSession(harness, workspace, `M49-${scenario.id}`, 'auto')
        await sendAndWait(harness, session.id, scenario.prompt, 300_000)
        const messages = messagesOf(harness, session.id)
        stageResults.push({ id: scenario.id, workspace, assistantText: assistantText(messages), ...old })
        writeEvidence(join(baseDir, `stage-${scenario.id}`), harness, workspace, { scenario: scenario.id, ...old })
        harness.dispose()
      }
      const finalHarness = makeHarness({ dataDir: join(baseDir, 'checker-data'), workspace: join(baseDir, 'stage-A', 'ws'), key: suite.key, model: suite.model })
      const ctx = makeContext(finalHarness, {
        workspace: join(baseDir, 'stage-A', 'ws'),
        baseDir,
        sessions: [[]],
        mode: 'work',
        extra: { m49Stages: stageResults }
      })
      const checked = spec.checker(ctx)
      finalHarness.dispose()
      return {
        id: spec.id,
        title: spec.title,
        declaredSupport: spec.declaredSupport,
        status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
        detail: checked.invalid ? `INVALID：${checked.invalid}；${checked.detail}` : checked.detail,
        ...(checked.invalid ? { invalid: checked.invalid } : {}),
        requests: suite.budget.used - before,
        toolCalls: 0,
        durationMs: Date.now() - startedAt,
        actual: checked.actual,
        evidence: [join(baseDir, 'stage-A'), join(baseDir, 'stage-B')].map((path) => path.replace(PROJECT_ROOT, '.').replace(/\\/g, '/'))
      }
    }

    const workspace = join(baseDir, 'ws')
    const dataDir = join(baseDir, 'data')
    const mockStateDir = join(baseDir, 'mock-state')
    mkdirSync(mockStateDir, { recursive: true })
    seed(workspace, spec)
    const approval =
      spec.approvalPolicy === 'm48-once'
        ? (request: { toolName: string; input: Record<string, unknown> }) => {
            const target = String((request.input as Record<string, unknown>).path ?? '')
            const content = String((request.input as Record<string, unknown>).content ?? '').trim()
            const replacement = String((request.input as Record<string, unknown>).new_string ?? '').trim()
            const firstAllowed =
              target === 'out/a.txt' &&
              ((request.toolName === 'write_file' && content === 'A1') ||
                (request.toolName === 'edit_file' && replacement === 'A1'))
            if (firstAllowed) return 'once'
            return 'deny'
          }
        : undefined
    const harness = makeHarness({
      dataDir,
      workspace,
      key: suite.key,
      model: suite.model,
      mockStateDir: spec.requires?.includes('mcp') ? mockStateDir : undefined,
      ...(approval ? { approval } : {}),
      ...(spec.answer ? { answer: spec.answer } : {})
    })
    const sessions: ChatMessage[][] = []
    const session = createSession(harness, workspace, spec.id, spec.permissionMode ?? 'auto')
    await sendAndWait(harness, session.id, spec.prompt, 300_000)
    sessions.push(messagesOf(harness, session.id))
    if (spec.secondPrompt) {
      await sendAndWait(harness, session.id, spec.secondPrompt, 300_000)
      sessions.push(messagesOf(harness, session.id))
    }
    if (spec.thirdPrompt) {
      await sendAndWait(harness, session.id, spec.thirdPrompt, 300_000)
      sessions.push(messagesOf(harness, session.id))
    }
    if (spec.id === 'M42') {
      // 建立独立 B 会话/工作根（只作为隔离背景，不参与 A 的上下文）
      const bWorkspace = join(baseDir, 'ws-b')
      for (const [relative, content] of Object.entries(spec.altWorkspaceFiles ?? {})) {
        const absolute = join(bWorkspace, relative)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, content, 'utf8')
      }
      const bSession = createSession(harness, bWorkspace, 'M42-B', 'auto')
      void bSession
    }
    const ctx = makeContext(harness, {
      workspace,
      baseDir,
      sessions,
      mode: spec.permissionMode === 'read-only' ? 'read-only' : 'work',
      mockStateDir: spec.requires?.includes('mcp') ? mockStateDir : undefined
    })
    let checked: { ok: boolean; detail: string; actual?: unknown; invalid?: string }
    try {
      checked = spec.checker(ctx)
    } catch (err) {
      checked = { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
    }
    const evidence = writeEvidence(baseDir, harness, workspace, { kind: spec.kind, permissions: harness.permissions })
    const toolCalls = toolCallCount(harness.events)
    harness.dispose()
    return {
      id: spec.id,
      title: spec.title,
      declaredSupport: spec.declaredSupport,
      status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
      detail: checked.invalid ? `INVALID：${checked.invalid}；${checked.detail}` : checked.detail,
      ...(checked.invalid ? { invalid: checked.invalid } : {}),
      requests: suite.budget.used - before,
      toolCalls,
      durationMs: Date.now() - startedAt,
      ...(checked.actual !== undefined ? { actual: checked.actual } : {}),
      evidence
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: spec.id,
      title: spec.title,
      declaredSupport: spec.declaredSupport,
      status: message.includes('BUDGET_EXHAUSTED') ? 'NOT_RUN' : 'FAIL',
      detail: message.includes('BUDGET_EXHAUSTED') ? '真实请求预算用尽（NOT_RUN）' : `运行失败：${message.slice(0, 300)}`,
      requests: suite.budget.used - before,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      evidence: []
    }
  }
}

function flush(results: R9Record[], budget: Budget, runId: string, mechanism: unknown): void {
  mkdirSync(dirname(RESULTS_FILE), { recursive: true })
  writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runId,
        version: '1.0.0',
        model: MODEL_ID,
        endpoint: BASE_URL,
        supportDeclaration: 'docs/audit/support-declaration-r9.md',
        budget: { cap: budget.cap, used: budget.used, exhausted: budget.exhausted },
        mechanisms: mechanism,
        results
      },
      null,
      2
    ),
    'utf8'
  )
}

export async function runR9LiveSuite(): Promise<{ results: R9Record[]; budget: Budget }> {
  if (process.env.MORROW_R9_LIVE !== '1' || process.env.MORROW_R9_LIVE_CONFIRM !== 'ONE_PASS_M40_M49') {
    throw new Error('R9 live 未解锁：需要 MORROW_R9_LIVE=1 且 MORROW_R9_LIVE_CONFIRM=ONE_PASS_M40_M49')
  }
  const key = readDeepSeekKey()
  const runId = `r9-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const root = join(RUN_ROOT, runId)
  mkdirSync(root, { recursive: true })
  const budget: Budget = { used: 0, cap: MAX_REQUESTS, exhausted: false }
  const restore = installFetchBudget(budget)
  const model: ModelInfo = { id: MODEL_ID, label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxOutput: 393_216, supportsTools: true }
  const results: R9Record[] = []
  let mechanism: unknown = null
  try {
    try {
      mechanism = JSON.parse(readFileSync(join(PROJECT_ROOT, 'docs', 'audit', 'logs', 'r9-mechanism-final.json'), 'utf8'))
    } catch {
      mechanism = null
    }
    const requestedIds = (process.env.MORROW_R9_IDS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const supported = QUESTIONS.filter(
      (spec) => spec.declaredSupport === 'supported' && (requestedIds.length === 0 || requestedIds.includes(spec.id))
    )
    for (const spec of supported) {
      if (budget.exhausted || budget.used >= MAX_REQUESTS - 2) {
        results.push({
          id: spec.id,
          title: spec.title,
          declaredSupport: spec.declaredSupport,
          status: 'NOT_RUN',
          detail: '真实请求预算用尽（NOT_RUN）',
          requests: 0,
          toolCalls: 0,
          durationMs: 0,
          evidence: []
        })
        flush(results, budget, runId, mechanism)
        continue
      }
      console.log(`[r9-live] ${spec.id} 开始（已用 ${budget.used}/${budget.cap}）`)
      const record = await runOneQuestion(spec, { root, key, budget, model })
      results.push(record)
      console.log(`[r9-live] ${record.id} ${record.status} requests=${record.requests} tools=${record.toolCalls} · ${record.detail.slice(0, 160)}`)
      flush(results, budget, runId, mechanism)
    }
    // 不支持题不消耗请求，但逐题记录 UNSUPPORTED（仅在完整跑时列出）
    for (const spec of requestedIds.length === 0 ? QUESTIONS.filter((item) => item.declaredSupport === 'unsupported') : []) {
      results.push({
        id: spec.id,
        title: spec.title,
        declaredSupport: spec.declaredSupport,
        status: 'UNSUPPORTED',
        detail: `开跑前已登记 UNSUPPORTED：${spec.supportNote}`,
        requests: 0,
        toolCalls: 0,
        durationMs: 0,
        evidence: []
      })
    }
    flush(results, budget, runId, mechanism)
  } finally {
    restore()
  }
  return { results, budget }
}
