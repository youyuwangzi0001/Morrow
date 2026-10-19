/**
 * R8 阶段 B：真实模型一次性跑完整 39 题（仅一遍，≤400 次真实 DeepSeek 请求）。
 *
 * 设计：
 * - 统一走产品真实运行路径 AgentService（会话持久化 / 权限 / Goal 多轮循环 / MCP 工具）；
 * - 真实请求计数用全局 fetch 包装（覆盖 provider 重试），硬上限默认 400，可 env 调整；
 * - 每题独立 workspace / dataDir / mock-state；证据（产物、事件、会话、mock calls）落
 *   tmp/audit/r8/live/<runId>/<题号>/；
 * - 结果增量写入 docs/audit/live-full-39.json（崩溃也不丢已跑成绩）；
 * - 支持声明由 support-declaration-r8.md（冻结）决定；UNSUPPORTED 题不消耗请求。
 *
 * 解锁：MORROW_R8_LIVE=1（Lead 信号后）+ MORROW_R8_LIVE_CONFIRM=ONE_PASS_39 双重确认。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Attachment,
  ChatMessage,
  Goal,
  ModelInfo,
  ProviderConfig,
  RuntimeEvent,
  Session
} from '../../../src/shared/types'
import { AgentService, type GoalBudgetsInput } from '../../../src/main/services/agent-service'
import { SessionStore, deriveMeta } from '../../../src/main/services/session-store'
import { recoverGoalsOnStartup } from '../../../src/main/services/goal-recovery'
import type { SettingsStore } from '../../../src/main/services/settings-store'
import {
  QUESTIONS,
  PROJECT_ROOT,
  specById,
  type CheckContext,
  type QuestionSpec
} from './specs'

export const R8_LIVE_DIR = join(PROJECT_ROOT, 'tmp', 'audit', 'r8')
export const R8_LIVE_RUN_ROOT = join(R8_LIVE_DIR, 'live')
export const R8_LIVE_RESULTS =
  process.env.MORROW_R8_RESULTS || join(PROJECT_ROOT, 'docs', 'audit', 'live-full-39.json')
const FIXTURE_ROOT = join(R8_LIVE_DIR, 'fixtures')
const MOCK_MCP_SCRIPT = join(PROJECT_ROOT, 'tests', 'audit', 'r8', 'mocks', 'morrow-mock-mcp.mjs')
const BASE_URL = process.env.MORROW_R8_BASE_URL || 'https://api.deepseek.com/v1'
const MODEL_ID = 'deepseek-flash'
const MAX_REAL_REQUESTS = Number(process.env.MORROW_R8_MAX_REQUESTS || 400)
/** 一遍 39 题，按安全/长任务优先排序 */
const RUN_ORDER = [
  'M27', 'M28', 'M29', 'M30', 'M31', 'M32',
  'M39', 'M25', 'M26', 'M37', 'M23', 'M24',
  'M33', 'M34', 'M09', 'M11', 'M12', 'M13', 'M14', 'M15',
  'M19', 'M20', 'M21', 'M04', 'M05', 'M06',
  'M01', 'M02', 'M03', 'M07', 'M08', 'M10', 'M16', 'M17', 'M18',
  'M22', 'M35', 'M36', 'M38'
]

interface Budget {
  used: number
  cap: number
  exhausted: boolean
}

interface LiveHarness {
  service: AgentService
  sessionStore: SessionStore
  events: RuntimeEvent[]
  permissions: Array<Record<string, unknown>>
  questions: string[]
  goalEvents: Goal[]
  window: unknown
  dataDir: string
  model: ModelInfo
  provider: ProviderConfig
  dispose: () => void
}

interface QuestionRunRecord {
  id: string
  title: string
  support: string
  status: 'PASS' | 'FAIL' | 'UNSUPPORTED' | 'INVALID' | 'NOT_RUN'
  detail: string
  invalid?: string
  requests: number
  toolCalls: number
  durationMs: number
  actual?: unknown
  evidence: string[]
}

function readDeepSeekKey(): string {
  const envKey = process.env.DEEPSEEK_API_KEY
  if (envKey) return envKey.trim()
  const credPath = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml')
  if (!existsSync(credPath)) throw new Error('未找到凭据文件，也没有 DEEPSEEK_API_KEY 环境变量')
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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      return value
    }
  }
  throw new Error('凭据文件 refs 段没有 DEEPSEEK_API_KEY')
}

/** 安装全局 fetch 预算（只在 live 期间）；返回恢复函数 */
function installFetchBudget(budget: Budget): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (budget.used >= budget.cap) {
      budget.exhausted = true
      throw new Error('AUDIT_REQUEST_BUDGET_EXHAUSTED')
    }
    budget.used += 1
    return originalFetch(...args)
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

class LiveSettingsStore {
  constructor(
    private readonly provider: ProviderConfig,
    private readonly apiKey: string,
    private readonly options: { autoCompact?: boolean; compactThreshold?: number } = {}
  ) {}

  get(): ReturnType<SettingsStore['get']> {
    const model = this.provider.models[0]
    const base = {
      version: 1,
      theme: 'dark' as const,
      fontSize: 14,
      reduceMotion: false,
      permissionMode: 'auto' as const,
      sendKey: 'enter' as const,
      providers: [this.provider],
      defaultModel: { providerId: this.provider.id, modelId: model.id },
      lastWorkspace: null,
      recentWorkspaces: [],
      onboardingDone: true,
      sidebarCollapsed: false,
      demoSeen: false,
      showTokenMeter: false,
      sidebarWidth: 240,
      autoCompact: this.options.autoCompact ?? false,
      compactThreshold: this.options.compactThreshold ?? 0.8,
      canvasWidth: 420,
      autoTitle: true
    }
    return base as ReturnType<SettingsStore['get']>
  }

  getApiKey(providerId: string): string | null {
    return providerId === this.provider.id ? this.apiKey : null
  }

  hasAnyApiKey(): boolean {
    return true
  }
}

function makeProviderConfig(model: ModelInfo): ProviderConfig {
  return {
    id: 'deepseek-live',
    kind: 'openai-compat',
    name: 'DeepSeek (R8 audit)',
    baseUrl: BASE_URL,
    models: [model],
    category: 'cn',
    apiKeyStored: true,
    enabled: true
  }
}

function writeMockConfig(mockStateDir: string): string {
  const configPath = join(mockStateDir, 'mcp.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        morrow_mock: {
          command: process.execPath,
          args: [MOCK_MCP_SCRIPT],
          env: { MORROW_MOCK_STATE_DIR: mockStateDir },
          timeoutMs: 30_000,
          description: 'R8 审计 mock 服务（无真实发信/付款能力）'
        }
      }
    }),
    'utf8'
  )
  return configPath
}

function readMockArtifacts(mockStateDir?: string): { state: Record<string, unknown>; calls: Array<Record<string, unknown>>; round?: Record<string, unknown> } {
  if (!mockStateDir) return { state: {}, calls: [] }
  let state: Record<string, unknown> = {}
  let calls: Array<Record<string, unknown>> = []
  let round: Record<string, unknown> | undefined
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
  try {
    round = JSON.parse(readFileSync(join(mockStateDir, 'round.json'), 'utf8')) as Record<string, unknown>
  } catch {
    round = undefined
  }
  return { state, calls, round }
}

function makeHarness(opts: {
  dataDir: string
  workspace: string
  provider: ProviderConfig
  key: string
  model: ModelInfo
  autoCompact?: boolean
  compactThreshold?: number
  mockStateDir?: string
  answer?: string
  onGoalUpdate?: (goal: Goal) => void
}): LiveHarness {
  mkdirSync(opts.dataDir, { recursive: true })
  process.env.MORROW_AUDIT_DATA_DIR = opts.dataDir
  process.env.MORROW_DATA_DIR = opts.dataDir
  if (opts.mockStateDir) process.env.MORROW_MCP_CONFIG = writeMockConfig(opts.mockStateDir)
  else delete process.env.MORROW_MCP_CONFIG
  const sessionStore = new SessionStore()
  const settings = new LiveSettingsStore(opts.provider, opts.key, {
    autoCompact: opts.autoCompact,
    compactThreshold: opts.compactThreshold
  })
  const events: RuntimeEvent[] = []
  const permissions: Array<Record<string, unknown>> = []
  const questions: string[] = []
  const goalEvents: Goal[] = []
  let service!: AgentService
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: RuntimeEvent) => {
        if (channel !== 'morrow:event') return
        events.push(event)
        if (event.type === 'question_asked') {
          questions.push(event.request.question)
          const answer = opts.answer ?? '（测试未提供答案）'
          setTimeout(() => {
            try {
              service.respondQuestion(event.request.id, { value: answer, label: answer })
            } catch {
              // 运行可能已结束
            }
          }, 0)
        }
        if (event.type === 'permission_requested') {
          const request = event.request
          permissions.push({
            toolName: request.toolName,
            input: request.input,
            summary: request.summary,
            decision: null
          })
          // 审计用户对本地 morrow_mock 的调用显式授权一次；其余一律拒绝并记录
          const allowMock =
            request.toolName === 'mcp_call' && String((request.input as Record<string, unknown>).server ?? '') === 'morrow_mock'
          const decision = allowMock ? 'once' : 'deny'
          permissions[permissions.length - 1].decision = decision
          setTimeout(() => {
            try {
              service.respondPermission(request.id, decision)
            } catch {
              // 运行可能已结束
            }
          }, 0)
        }
        if (event.type === 'goal_updated' && event.goal) {
          goalEvents.push(event.goal)
          opts.onGoalUpdate?.(event.goal)
        }
      }
    }
  }
  service = new AgentService(settings as unknown as SettingsStore, sessionStore)
  return {
    service,
    sessionStore,
    events,
    permissions,
    questions,
    goalEvents,
    window,
    dataDir: opts.dataDir,
    model: opts.model,
    provider: opts.provider,
    dispose: () => service.dispose()
  }
}

function waitFor(condition: () => boolean, timeoutMs: number, intervalMs = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      let ok = false
      try {
        ok = condition()
      } catch {
        ok = false
      }
      if (ok) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`waitFor 超时（${timeoutMs}ms）`))
      }
    }, intervalMs)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sessionMessages(harness: LiveHarness, sessionId: string): ChatMessage[] {
  return harness.sessionStore.get(sessionId)?.messages ?? []
}

function assistantTextOf(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')))
    .join('\n')
}

function toolCallsOf(events: RuntimeEvent[]): number {
  return events.filter((event) => event.type === 'tool_started').length
}

function makeContext(
  spec: QuestionSpec,
  harness: LiveHarness,
  opts: {
    baseDir: string
    workspace: string
    sessions: ChatMessage[][]
    messages: ChatMessage[]
    mockStateDir?: string
    goal?: Goal | null
    extra?: Record<string, unknown>
  }
): CheckContext {
  const mock = readMockArtifacts(opts.mockStateDir)
  return {
    workspace: opts.workspace,
    baseDir: opts.baseDir,
    events: harness.events,
    assistantText: assistantTextOf(opts.messages),
    assistantTexts: opts.sessions.map((messages) => assistantTextOf(messages)),
    sessions: opts.sessions,
    mock,
    goal: opts.goal ?? null,
    permissions: harness.permissions,
    questions: harness.questions,
    extra: opts.extra ?? {}
  }
}

function createSession(harness: LiveHarness, workspace: string, title: string, mode?: 'work' | 'chat'): Session {
  const session = harness.sessionStore.create({
    workspace,
    model: { providerId: harness.provider.id, modelId: harness.model.id },
    permissionMode: 'auto',
    defaultModel: { providerId: harness.provider.id, modelId: harness.model.id },
    defaultPermission: 'auto',
    title,
    ...(mode ? { mode } : {})
  })
  return session
}

function attachmentsFor(workspace: string, images?: string[]): Attachment[] | undefined {
  if (!images?.length) return undefined
  return images.map((relative, index) => {
    const absolute = join(workspace, relative)
    const buffer = readFileSync(absolute)
    const ext = relative.split('.').pop()?.toLowerCase() ?? 'png'
    const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return {
      id: `att_${index}`,
      name: relative.split('/').pop() ?? `image-${index}`,
      path: absolute,
      size: statSync(absolute).size,
      kind: 'image' as const,
      content: `data:${mediaType};base64,${buffer.toString('base64')}`,
      mediaType
    }
  })
}

async function sendAndWait(
  harness: LiveHarness,
  sessionId: string,
  text: string,
  timeoutMs = 240_000,
  images?: string[],
  workspace?: string
): Promise<{ runId: string; messages: ChatMessage[] }> {
  const result = await harness.service.send(
    {
      sessionId,
      text,
      ...(images?.length && workspace ? { attachments: attachmentsFor(workspace, images) } : {})
    },
    harness.window as never
  )
  await waitFor(
    () => harness.events.some((event) => event.type === 'run_finished' && event.runId === result.runId),
    timeoutMs
  )
  await waitFor(() => !harness.service.isSessionRunning(sessionId), 15_000)
  await sleep(120)
  return { runId: result.runId, messages: sessionMessages(harness, sessionId) }
}

function writeQuestionEvidence(dir: string, harness: LiveHarness, extra: Record<string, unknown>): string[] {
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
    const root = harness.dataDir
    const sessionsDir = join(root, 'sessions')
    if (existsSync(sessionsDir)) {
      for (const name of readdirSync(sessionsDir) as string[]) {
        if (!name.endsWith('.json')) continue
        try {
          sessions[name] = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'))
        } catch {
          // ignore
        }
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
  return evidence.map((path) => path.replace(PROJECT_ROOT, '.').replace(/\\/g, '/'))
}

function copyWorkspaceOut(workspace: string, dir: string): void {
  try {
    const out = join(workspace, 'out')
    if (existsSync(out)) cpSync(out, join(dir, 'out'), { recursive: true })
  } catch {
    // ignore
  }
}

interface LiveRunResult {
  results: QuestionRunRecord[]
  stoppedReason?: string
}

/** 单题（single / multi-session）执行 */
async function runSingleQuestion(
  spec: QuestionSpec,
  suite: { root: string; key: string; budget: Budget }
): Promise<QuestionRunRecord> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  const workspace = join(baseDir, 'ws')
  const dataDir = join(baseDir, 'data')
  const mockStateDir = join(baseDir, 'mock-state')
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  mkdirSync(mockStateDir, { recursive: true })
  const snapshotDir = join(workspace, 'snapshots')
  mkdirSync(snapshotDir, { recursive: true })
  if (spec.fixture) {
    const source = join(FIXTURE_ROOT, spec.fixture)
    if (existsSync(source)) cpSync(source, join(workspace, 'in'), { recursive: true })
  }
  if (spec.prepare) {
    try {
      spec.prepare(workspace, baseDir)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        id: spec.id,
        title: spec.title,
        support: spec.declaredSupport,
        status: 'INVALID',
        invalid: message,
        detail: `INVALID（环境未建立）：${message}`,
        requests: 0,
        toolCalls: 0,
        durationMs: Date.now() - startedAt,
        evidence: []
      }
    }
  }

  const model: ModelInfo = {
    id: MODEL_ID,
    label: 'DeepSeek V4.1 Flash',
    contextWindow: 1_048_576,
    maxOutput: 393_216,
    supportsTools: true
  }
  const harness = makeHarness({
    dataDir,
    workspace,
    provider: makeProviderConfig(model),
    key: suite.key,
    model,
    answer: spec.answer,
    mockStateDir: spec.requires?.includes('mcp') ? mockStateDir : undefined
  })
  const sessions: ChatMessage[][] = []
  let record: QuestionRunRecord
  try {
    const session = createSession(harness, workspace, spec.id)
    await sendAndWait(harness, session.id, spec.prompt, 300_000, spec.images, workspace)
    sessions.push(sessionMessages(harness, session.id))
    let lastSessionId = session.id
    let promptIndex = 0
    for (const prompt of spec.extraPrompts ?? []) {
      promptIndex += 1
      // 记忆类题目必须使用独立新会话（与题面「关闭该对话并开启独立新会话」一致）
      const nextSession =
        spec.kind === 'multi-session' ? createSession(harness, workspace, spec.id + '-session-' + (promptIndex + 1)) : session
      lastSessionId = nextSession.id
      await sendAndWait(harness, nextSession.id, prompt, 240_000)
      sessions.push(sessionMessages(harness, nextSession.id))
    }
    const messages = sessions[sessions.length - 1] ?? sessionMessages(harness, lastSessionId)
    const ctx = makeContext(spec, harness, {
      baseDir,
      workspace,
      sessions,
      messages,
      mockStateDir: spec.requires?.includes('mcp') ? mockStateDir : undefined
    })
    let checked: { ok: boolean; detail: string; actual?: unknown; invalid?: string }
    try {
      checked = spec.checker(ctx)
    } catch (err) {
      checked = { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
    }
    const evidence = writeQuestionEvidence(baseDir, harness, { kind: spec.kind, invalid: checked.invalid ?? null })
    copyWorkspaceOut(workspace, baseDir)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
      detail: checked.invalid ? `INVALID：${checked.invalid}；观察：${checked.detail}` : checked.detail,
      ...(checked.invalid ? { invalid: checked.invalid } : {}),
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      ...(checked.actual !== undefined ? { actual: checked.actual } : {}),
      evidence
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const evidence = writeQuestionEvidence(baseDir, harness, { error: message })
    copyWorkspaceOut(workspace, baseDir)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: message.includes('BUDGET_EXHAUSTED') ? 'NOT_RUN' : 'FAIL',
      detail: message.includes('BUDGET_EXHAUSTED') ? '真实请求预算用尽，未完成（NOT_RUN）' : `运行失败：${message.slice(0, 300)}`,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      evidence
    }
  } finally {
    try {
      if (spec.cleanup) spec.cleanup(workspace, baseDir)
    } catch {
      // ignore
    }
    harness.dispose()
    delete process.env.MORROW_MCP_CONFIG
  }
  return record
}

/* ── M25：分批任务 + 中断恢复 ─────────────────────────────────── */

async function runM25(spec: QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<QuestionRunRecord> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  const workspace = join(baseDir, 'ws')
  const dataDir = join(baseDir, 'data')
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  if (spec.fixture) cpSync(join(FIXTURE_ROOT, spec.fixture), join(workspace, 'in'), { recursive: true })
  const model: ModelInfo = { id: MODEL_ID, label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxOutput: 65_000, supportsTools: true }
  let harness = makeHarness({ dataDir, workspace, provider: makeProviderConfig(model), key: suite.key, model })
  const evidenceSessions: ChatMessage[][] = []
  const extra: Record<string, unknown> = { interruptedOnce: false, pauseResumeVerified: false }
  let record: QuestionRunRecord
  try {
    const session = createSession(harness, workspace, spec.id)
    const goalResult = await harness.service.startGoal(session.id, spec.prompt, 8, harness.window as never, {
      maxToolCalls: 120,
      maxActiveMs: 20 * 60_000,
      maxNoProgressRounds: 4
    })
    void goalResult
    // 观察 checkpoint：完成 4 项时暂停 → 模拟应用重启 → 继续同一个目标
    let interrupted = false
    let restarted = false
    for (let tick = 0; tick < 1200; tick += 1) {
      const goal = harness.sessionStore.get(session.id)?.goal
      if (!goal) break
      const checkpoint = join(workspace, 'out', 'checkpoint.json')
      let completed = 0
      try {
        const parsed = JSON.parse(readFileSync(checkpoint, 'utf8')) as { completed?: string[] }
        completed = parsed.completed?.length ?? 0
      } catch {
        completed = 0
      }
      if (!interrupted && completed >= 4) {
        interrupted = true
        extra.interruptedOnce = true
        harness.service.pauseGoal(session.id, harness.window as never)
        await waitFor(() => !harness.service.isSessionRunning(session.id), 30_000)
        evidenceSessions.push(sessionMessages(harness, session.id))
        // 模拟应用进程重启：新 service + 启动恢复 active→paused + 继续同一目标
        harness.dispose()
        const restartedHarness = makeHarness({ dataDir, workspace, provider: makeProviderConfig(model), key: suite.key, model })
        recoverGoalsOnStartup(restartedHarness.sessionStore)
        harness = restartedHarness
        const recovered = harness.sessionStore.get(session.id)?.goal
        if (recovered?.status === 'paused') {
          harness.service.resumeGoal(session.id, harness.window as never)
          restarted = true
          extra.pauseResumeVerified = true
        }
      }
      if (goal.status === 'completed' || goal.status === 'cancelled') break
      if (goal.status === 'paused' && !harness.service.isSessionRunning(session.id)) break
      await sleep(150)
    }
    // 若目标提前停下但产物没完成：按题面允许用户说“继续刚才的批处理，先检查磁盘上的完成状态”
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resultExists = existsSync(join(workspace, 'out', 'result.json'))
      const items = existsSync(join(workspace, 'out', 'items')) ? readdirSync(join(workspace, 'out', 'items')).length : 0
      if (resultExists && items >= 12) break
      if (harness.service.isSessionRunning(session.id)) {
        await sleep(300)
        continue
      }
      await sendAndWait(harness, session.id, '继续刚才的批处理，先检查磁盘上的完成状态。', 180_000)
      evidenceSessions.push(sessionMessages(harness, session.id))
    }
    evidenceSessions.push(sessionMessages(harness, session.id))
    const messages = sessionMessages(harness, session.id)
    const ctx = makeContext(spec, harness, { baseDir, workspace, sessions: evidenceSessions, messages, extra })
    let checked: { ok: boolean; detail: string; actual?: unknown; invalid?: string }
    try {
      checked = spec.checker(ctx)
    } catch (err) {
      checked = { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
    }
    const evidence = writeQuestionEvidence(baseDir, harness, { ...extra, restarted, goal: harness.sessionStore.get(session.id)?.goal ?? null })
    copyWorkspaceOut(workspace, baseDir)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
      detail: checked.invalid ? `INVALID：${checked.invalid}；观察：${checked.detail}` : checked.detail,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      ...(checked.actual !== undefined ? { actual: checked.actual } : {}),
      evidence
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: message.includes('BUDGET_EXHAUSTED') ? 'NOT_RUN' : 'FAIL',
      detail: message.includes('BUDGET_EXHAUSTED') ? '真实请求预算用尽，未完成（NOT_RUN）' : `运行失败：${message.slice(0, 300)}`,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      evidence: writeQuestionEvidence(baseDir, harness, { error: message })
    }
  } finally {
    harness.dispose()
  }
  return record
}

/* ── M39：长期 Goal 三场景 ───────────────────────────────────── */

async function runM39(spec: QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<QuestionRunRecord> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  rmSync(baseDir, { recursive: true, force: true })
  const evidence: string[] = []
  const scenarioResults: Record<string, unknown> = {}
  const allMessages: ChatMessage[][] = []
  let lastHarness: LiveHarness | null = null
  let lastSessionId = ''
  let record: QuestionRunRecord
  try {
    const scenarios: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C']
    for (const scenario of scenarios) {
      const workspace = join(baseDir, `scenario-${scenario}`, 'ws')
      const dataDir = join(baseDir, `scenario-${scenario}`, 'data')
      const mockStateDir = join(baseDir, `scenario-${scenario}`, 'mock-state')
      mkdirSync(join(workspace, 'in'), { recursive: true })
      mkdirSync(join(workspace, 'out'), { recursive: true })
      mkdirSync(mockStateDir, { recursive: true })
      writeFileSync(join(mockStateDir, 'scenario.json'), JSON.stringify({ scenario }), 'utf8')
      writeFileSync(join(mockStateDir, 'round.json'), JSON.stringify({ goal_id: null, round: 0, status: 'none' }), 'utf8')
      const model: ModelInfo = { id: MODEL_ID, label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxOutput: 65_000, supportsTools: true }
      const maxRounds = scenario === 'C' ? 3 : 16
      let harness = makeHarness({
        dataDir,
        workspace,
        provider: makeProviderConfig(model),
        key: suite.key,
        model,
        mockStateDir,
        onGoalUpdate: (goal) => {
          try {
            writeFileSync(join(mockStateDir, 'round.json'), JSON.stringify({ goal_id: goal.id, round: goal.round, status: goal.status }), 'utf8')
          } catch {
            // ignore
          }
        }
      })
      const session = createSession(harness, workspace, `${spec.id}-${scenario}`)
      let interrupted = false
      let restartedAt8 = false
      const goal = await harness.service.startGoal(session.id, spec.prompt, maxRounds, harness.window as never, {
        maxToolCalls: 100,
        maxActiveMs: 20 * 60_000,
        maxNoProgressRounds: 3
      })
      void goal
      const waitStarted = Date.now()
      while (Date.now() - waitStarted < 900_000) {
        const current = harness.sessionStore.get(session.id)?.goal
        if (!current) break
        if (scenario === 'A') {
          const registrations = readMockArtifacts(mockStateDir).state.registrations as Array<unknown> | undefined
          const count = registrations?.length ?? 0
          if (!interrupted && count >= 4) {
            interrupted = true
            harness.service.pauseGoal(session.id, harness.window as never)
            await waitFor(() => !harness.service.isSessionRunning(session.id), 60_000)
            allMessages.push(sessionMessages(harness, session.id))
            harness.dispose()
            harness = makeHarness({
              dataDir,
              workspace,
              provider: makeProviderConfig(model),
              key: suite.key,
              model,
              mockStateDir,
              onGoalUpdate: (goalValue) => {
                try {
                  writeFileSync(join(mockStateDir, 'round.json'), JSON.stringify({ goal_id: goalValue.id, round: goalValue.round, status: goalValue.status }), 'utf8')
                } catch {
                  // ignore
                }
              }
            })
            recoverGoalsOnStartup(harness.sessionStore)
            if (harness.sessionStore.get(session.id)?.goal?.status === 'paused') {
              harness.service.resumeGoal(session.id, harness.window as never)
            }
            continue
          }
          if (interrupted && !restartedAt8 && count >= 8) {
            restartedAt8 = true
            // 第二次中断：模拟进程退出后恢复（先停止当前轮，再重建 service=模拟重启）
            harness.service.pauseGoal(session.id, harness.window as never)
            await waitFor(() => !harness.service.isSessionRunning(session.id), 30_000)
            allMessages.push(sessionMessages(harness, session.id))
            harness.dispose()
            harness = makeHarness({
              dataDir,
              workspace,
              provider: makeProviderConfig(model),
              key: suite.key,
              model,
              mockStateDir,
              onGoalUpdate: (goalValue) => {
                try {
                  writeFileSync(join(mockStateDir, 'round.json'), JSON.stringify({ goal_id: goalValue.id, round: goalValue.round, status: goalValue.status }), 'utf8')
                } catch {
                  // ignore
                }
              }
            })
            const recovered = recoverGoalsOnStartup(harness.sessionStore)
            if (harness.sessionStore.get(session.id)?.goal?.status !== 'paused' && recovered === 0) {
              // 目标可能刚从 active 被恢复；确保处于可继续状态
            }
            if (harness.sessionStore.get(session.id)?.goal?.status === 'paused') {
              harness.service.resumeGoal(session.id, harness.window as never)
            }
            continue
          }
        }
        if (current.status === 'completed' || current.status === 'cancelled' || current.status === 'blocked') break
        if (current.status === 'paused' && !harness.service.isSessionRunning(session.id)) break
        await sleep(200)
      }
      // 停止后观察 2 秒：不得出现新的自主轮次
      const roundBefore = harness.sessionStore.get(session.id)?.goal?.round ?? 0
      const msgBefore = sessionMessages(harness, session.id).length
      await sleep(2000)
      const roundAfter = harness.sessionStore.get(session.id)?.goal?.round ?? 0
      const msgAfter = sessionMessages(harness, session.id).length
      const noFurtherRounds = roundAfter === roundBefore && msgAfter === msgBefore
      allMessages.push(sessionMessages(harness, session.id))
      scenarioResults[scenario] = {
        goal: harness.sessionStore.get(session.id)?.goal ?? null,
        registrations: (readMockArtifacts(mockStateDir).state.registrations as Array<unknown> | undefined)?.length ?? 0,
        noFurtherRounds,
        interruptedOnce: interrupted,
        restarted: restartedAt8,
        requestsSoFar: suite.budget.used - before
      }
      lastHarness = harness
      lastSessionId = session.id
      // 证据：拷贝该场景工作区与 mock 状态
      try {
        mkdirSync(join(baseDir, `scenario-${scenario}`), { recursive: true })
        cpSync(join(workspace, 'out'), join(baseDir, `scenario-${scenario}`, 'out'), { recursive: true })
        writeFileSync(
          join(baseDir, `scenario-${scenario}`, 'mock-state.json'),
          JSON.stringify(readMockArtifacts(mockStateDir), null, 2),
          'utf8'
        )
      } catch {
        // ignore
      }
      if (scenario !== 'C') harness.dispose()
    }
    if (!lastHarness) throw new Error('M39 场景未执行')
    const finalHarness = lastHarness
    const finalScenario = scenarioResults as Record<string, { registrations?: number; noFurtherRounds?: boolean; interruptedOnce?: boolean }>
    // 三场景分别按 M39 checker 判分（A/B/C 都是题面要求；全部 PASS 才算 M39 PASS）
    const scenarioChecks: Record<string, { ok: boolean; detail: string; invalid?: string }> = {}
    for (const scenario of scenarios) {
      const entry = scenarioResults[scenario] as
        | { goal?: Goal | null; registrations?: number; noFurtherRounds?: boolean; interruptedOnce?: boolean }
        | undefined
      const workspaceS = join(baseDir, `scenario-${scenario}`, 'ws')
      const mockStateS = join(baseDir, `scenario-${scenario}`, 'mock-state')
      const mock = readMockArtifacts(mockStateS)
      const sctx: CheckContext = {
        workspace: workspaceS,
        baseDir,
        events: [],
        assistantText: '',
        assistantTexts: [],
        sessions: [],
        mock: {
          state: { ...mock.state, registrations: new Array(entry?.registrations ?? 0).fill({}) },
          calls: mock.calls,
          round: mock.round
        },
        goal: entry?.goal ?? null,
        permissions: [],
        questions: [],
        extra: {
          scenario,
          goalRounds: Number(entry?.goal?.round ?? 0),
          pauseResumeVerified: Boolean((scenarioResults.A as { interruptedOnce?: boolean } | undefined)?.interruptedOnce),
          noFurtherRounds: Boolean(entry?.noFurtherRounds),
          scenarios: scenarioResults
        }
      }
      try {
        const checkedS = spec.checker(sctx)
        scenarioChecks[scenario] = {
          ok: checkedS.ok,
          detail: checkedS.detail,
          ...(checkedS.invalid ? { invalid: checkedS.invalid } : {})
        }
      } catch (err) {
        scenarioChecks[scenario] = { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
      }
    }
    const invalidScenarios = Object.entries(scenarioChecks)
      .filter(([, value]) => Boolean(value.invalid))
      .map(([key]) => key)
    const failedScenarios = Object.entries(scenarioChecks)
      .filter(([, value]) => !value.ok && !value.invalid)
      .map(([key]) => key)
    const scenarioDetail = (['A', 'B', 'C'] as const)
      .map((scenario) => {
        const value = scenarioChecks[scenario]
        const label = !value
          ? '未执行'
          : value.ok
            ? 'PASS'
            : value.invalid
              ? `INVALID(${value.invalid})`
              : `FAIL(${value.detail})`
        return `场景${scenario}: ${label}`
      })
      .join('；')
    const checked = {
      ok: failedScenarios.length === 0 && invalidScenarios.length === 0,
      detail: scenarioDetail,
      ...(invalidScenarios.length > 0 ? { invalid: `场景 ${invalidScenarios.join('/')} INVALID（按题库规则需重测）` } : {}),
      actual: { scenarios: scenarioResults, scenarioChecks }
    }
    const evidence: string[] = writeQuestionEvidence(baseDir, finalHarness, {
      ...(checked.actual as Record<string, unknown>),
      scenarios: scenarioResults
    })
    for (const scenario of ['A', 'B', 'C'] as const) {
      const out = join(baseDir, `scenario-${scenario}`, 'out')
      if (existsSync(out)) evidence.push(join(baseDir, `scenario-${scenario}`, 'out').replace(PROJECT_ROOT, '.').replace(/\\/g, '/'))
    }
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
      detail: checked.invalid ? `INVALID：${checked.invalid}；${checked.detail}` : checked.detail,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(finalHarness.events),
      durationMs: Date.now() - startedAt,
      ...(checked.actual !== undefined ? { actual: checked.actual } : {}),
      evidence
    }
    finalHarness.dispose()
    return record
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    lastHarness?.dispose()
    try {
      mkdirSync(baseDir, { recursive: true })
      writeFileSync(
        join(baseDir, 'audit-extra.json'),
        JSON.stringify({ error: message, scenarioResults, sessions: allMessages.length }, null, 2),
        'utf8'
      )
      for (const scenario of ['A', 'B', 'C'] as const) {
        const out = join(baseDir, 'scenario-' + scenario, 'out')
        if (existsSync(out)) continue
      }
    } catch {
      // ignore
    }
    return {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: message.includes('BUDGET_EXHAUSTED') ? 'NOT_RUN' : 'FAIL',
      detail: message.includes('BUDGET_EXHAUSTED') ? '真实请求预算用尽，未完成（NOT_RUN）' : `M39 运行失败：${message.slice(0, 300)}`,
      requests: suite.budget.used - before,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      evidence: []
    }
  }
}


/* ── M27：长任务取消（审计侧在 slow_job 首次调用后发送停止） ───── */

async function runM27(spec: QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<QuestionRunRecord> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  const workspace = join(baseDir, 'ws')
  const dataDir = join(baseDir, 'data')
  const mockStateDir = join(baseDir, 'mock-state')
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  mkdirSync(mockStateDir, { recursive: true })
  const model: ModelInfo = { id: MODEL_ID, label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxOutput: 65_000, supportsTools: true }
  const harness = makeHarness({ dataDir, workspace, provider: makeProviderConfig(model), key: suite.key, model, mockStateDir })
  let record: QuestionRunRecord
  try {
    const session = createSession(harness, workspace, spec.id)
    const first = await harness.service.send({ sessionId: session.id, text: spec.prompt }, harness.window as never)
    let cancelSent = false
    for (let tick = 0; tick < 800; tick += 1) {
      const calls = readMockArtifacts(mockStateDir).calls
      if (calls.some((call) => call.tool === 'slow_job')) {
        harness.service.cancel(first.runId)
        cancelSent = true
        break
      }
      await sleep(150)
    }
    await waitFor(() => harness.events.some((event) => event.type === 'run_finished' && event.runId === first.runId), 180_000)
    await waitFor(() => !harness.service.isSessionRunning(session.id), 30_000)
    await sleep(150)
    if (!cancelSent) throw new Error('审计侧未成功在 slow_job 后发送停止（M27 需重测）')
    await sendAndWait(
      harness,
      session.id,
      '停止刚才的任务，不要继续轮询。请调用 morrow_mock 的 cancel_job（job_id="J-1"），然后在 out/result.json 写 status=cancelled。不要谎称已完成。',
      180_000
    )
    const messages = sessionMessages(harness, session.id)
    const ctx = makeContext(spec, harness, {
      baseDir,
      workspace,
      sessions: [messages],
      messages,
      mockStateDir,
      extra: { cancelSent: true }
    })
    let checked: { ok: boolean; detail: string; actual?: unknown; invalid?: string }
    try {
      checked = spec.checker(ctx)
    } catch (err) {
      checked = { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
    }
    const evidence = writeQuestionEvidence(baseDir, harness, { cancelSent })
    copyWorkspaceOut(workspace, baseDir)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
      detail: checked.invalid ? `INVALID：${checked.invalid}；观察：${checked.detail}` : checked.detail,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      ...(checked.actual !== undefined ? { actual: checked.actual } : {}),
      evidence
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: message.includes('BUDGET_EXHAUSTED') ? 'NOT_RUN' : 'FAIL',
      detail: message.includes('BUDGET_EXHAUSTED') ? '真实请求预算用尽，未完成（NOT_RUN）' : `运行失败：${message.slice(0, 300)}`,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      evidence: writeQuestionEvidence(baseDir, harness, { error: message })
    }
  } finally {
    harness.dispose()
  }
  return record
}

/* ── M37：产品原生上下文压缩（低阈值 + 小上下文窗口触发） ────── */

async function runM37(spec: QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<QuestionRunRecord> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  const workspace = join(baseDir, 'ws')
  const dataDir = join(baseDir, 'data')
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  if (spec.fixture) cpSync(join(FIXTURE_ROOT, spec.fixture), join(workspace, 'in'), { recursive: true })
  const contextWindow = Number(process.env.MORROW_R8_M37_CONTEXT || 40_000)
  const compactThreshold = Number(process.env.MORROW_R8_M37_THRESHOLD || 0.3)
  const model: ModelInfo = { id: MODEL_ID, label: 'DeepSeek V4.1 Flash', contextWindow, maxOutput: 8_000, supportsTools: true }
  const harness = makeHarness({
    dataDir,
    workspace,
    provider: makeProviderConfig(model),
    key: suite.key,
    model,
    autoCompact: true,
    compactThreshold
  })
  let record: QuestionRunRecord
  try {
    const session = createSession(harness, workspace, spec.id)
    await sendAndWait(harness, session.id, spec.prompt, 600_000)
    const messages = sessionMessages(harness, session.id)
    const ctx = makeContext(spec, harness, { baseDir, workspace, sessions: [messages], messages })
    let checked: { ok: boolean; detail: string; actual?: unknown; invalid?: string }
    try {
      checked = spec.checker(ctx)
    } catch (err) {
      checked = { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
    }
    const evidence = writeQuestionEvidence(baseDir, harness)
    copyWorkspaceOut(workspace, baseDir)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL',
      detail: checked.invalid ? `INVALID：${checked.invalid}；观察：${checked.detail}` : checked.detail,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      ...(checked.actual !== undefined ? { actual: checked.actual } : {}),
      evidence
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    record = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: message.includes('BUDGET_EXHAUSTED') ? 'NOT_RUN' : 'FAIL',
      detail: message.includes('BUDGET_EXHAUSTED') ? '真实请求预算用尽，未完成（NOT_RUN）' : `运行失败：${message.slice(0, 300)}`,
      requests: suite.budget.used - before,
      toolCalls: toolCallsOf(harness.events),
      durationMs: Date.now() - startedAt,
      evidence: writeQuestionEvidence(baseDir, harness, { error: message })
    }
  } finally {
    harness.dispose()
  }
  return record
}

/* ── 特殊 kind 分发 ──────────────────────────────────────────── */

async function runQuestion(
  spec: QuestionSpec,
  suite: { root: string; key: string; budget: Budget },
  resultsFile: string,
  runId: string,
  existing: QuestionRunRecord[]
): Promise<QuestionRunRecord> {
  if (spec.kind === 'unsupported') {
    const record: QuestionRunRecord = {
      id: spec.id,
      title: spec.title,
      support: spec.declaredSupport,
      status: 'UNSUPPORTED',
      detail: `开跑前已登记 UNSUPPORTED：${spec.supportNote}`,
      requests: 0,
      toolCalls: 0,
      durationMs: 0,
      evidence: []
    }
    existing.push(record)
    flushResults(resultsFile, runId, existing, suite.budget)
    return record
  }
  if (spec.kind === 'goal') {
    const record = await runM39(spec, suite)
    existing.push(record)
    flushResults(resultsFile, runId, existing, suite.budget)
    return record
  }
  if (spec.id === 'M27') {
    const record = await runM27(spec, suite)
    existing.push(record)
    flushResults(resultsFile, runId, existing, suite.budget)
    return record
  }
  if (spec.id === 'M37') {
    const record = await runM37(spec, suite)
    existing.push(record)
    flushResults(resultsFile, runId, existing, suite.budget)
    return record
  }
  if (spec.id === 'M25') {
    const record = await runM25(spec, suite)
    existing.push(record)
    flushResults(resultsFile, runId, existing, suite.budget)
    return record
  }
  const record = await runSingleQuestion(spec, suite)
  existing.push(record)
  flushResults(resultsFile, runId, existing, suite.budget)
  return record
}

function flushResults(resultsFile: string, runId: string, results: QuestionRunRecord[], budget: Budget): void {
  mkdirSync(dirname(resultsFile), { recursive: true })
  writeFileSync(
    resultsFile,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runId,
        version: '1.0.0',
        model: MODEL_ID,
        endpoint: BASE_URL,
        permissionMode: 'auto',
        supportDeclaration: 'docs/audit/support-declaration-r8.md',
        retest: process.env.MORROW_R8_RETEST === '1',
        budget: { cap: budget.cap, used: budget.used, exhausted: budget.exhausted },
        progress: { done: results.length, total: 39 },
        results
      },
      null,
      2
    ),
    'utf8'
  )
}

/** 阶段 B 主入口：仅一遍 39 题。 */
export async function runLiveFullSuite(): Promise<{ ok: boolean; results: QuestionRunRecord[] }> {
  if (process.env.MORROW_R8_LIVE !== '1') {
    throw new Error('live 全量测试未解锁：需要 MORROW_R8_LIVE=1（Lead 发出「新功能已集成」信号后才可运行）')
  }
  if (process.env.MORROW_R8_LIVE_CONFIRM !== 'ONE_PASS_39') {
    throw new Error('缺少一次性确认：需 MORROW_R8_LIVE_CONFIRM=ONE_PASS_39（仅一遍 39 题、不做三轮）')
  }
  // 冻结支持声明（若仍是草案）；管路自检（本地 mock）不冻结
  if (process.env.MORROW_R8_PLUMBING !== '1' && process.env.MORROW_R8_RETEST !== '1') {
    const { writeSupportDeclaration } = await import('./runner')
    writeSupportDeclaration(true)
  }

  const key = readDeepSeekKey()
  const runId = `r8-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const root = join(R8_LIVE_RUN_ROOT, runId)
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'fixtures'))
  // 复跑 Phase A 以确保夹具/checker 就绪（若缺失则构建）
  const phaseA = await import('./runner')
  const fixtures = phaseA.buildFixtures()
  if (!fixtures.ok) throw new Error('夹具构建/校验失败，终止 live（未消耗真实请求）')
  const budget: Budget = { used: 0, cap: MAX_REAL_REQUESTS, exhausted: false }
  const restoreFetch = installFetchBudget(budget)
  const results: QuestionRunRecord[] = []
  const suite = { root, key, budget }
  const onlyIds = (process.env.MORROW_R8_LIVE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const ordered = onlyIds.length > 0
    ? onlyIds.map((id) => specById(id)).filter((spec): spec is QuestionSpec => Boolean(spec))
    : [...RUN_ORDER.map((id) => specById(id)).filter((spec): spec is QuestionSpec => Boolean(spec)), ...QUESTIONS.filter((spec) => !RUN_ORDER.includes(spec.id))]
  try {
    for (const spec of ordered) {
      if (budget.exhausted || budget.used >= MAX_REAL_REQUESTS - 2) {
        const record: QuestionRunRecord = {
          id: spec.id,
          title: spec.title,
          support: spec.declaredSupport,
          status: 'NOT_RUN',
          detail: '真实请求预算用尽，未运行（NOT_RUN）',
          requests: 0,
          toolCalls: 0,
          durationMs: 0,
          evidence: []
        }
        results.push(record)
        flushResults(R8_LIVE_RESULTS, runId, results, budget)
        continue
      }
      const remaining = MAX_REAL_REQUESTS - budget.used
      console.log(`[r8-live] ${spec.id} 开始（已用 ${budget.used}/${budget.cap}，剩余 ${remaining}）`)
      const record = await runQuestion(spec, suite, R8_LIVE_RESULTS, runId, results)
      console.log(`[r8-live] ${record.id} ${record.status} requests=${record.requests} tools=${record.toolCalls} ${record.durationMs}ms · ${record.detail.slice(0, 160)}`)
    }
  } finally {
    restoreFetch()
  }
  flushResults(R8_LIVE_RESULTS, runId, results, budget)
  return { ok: results.every((record) => !['FAIL', 'INVALID'].includes(record.status)), results }
}
