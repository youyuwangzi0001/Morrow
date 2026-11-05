/**
 * T01 协作基准：用真实 runAgent / swarm 调度器 + 离线脚本模型，
 * 在隔离的登录样例上跑「必须串行」与「可同时开工」两种调度，
 * 导出脱敏时间线，供后续任务卡对照耗时、返工和用量。
 *
 * 这里不调用外部模型；所有等待与输出都由脚本固定，结论只描述调度关系，
 * 不冒充真实项目的时长或模型速度。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runAgent, BUILTIN_AGENT_ROLES, type RunAgentResult } from '../../src/core/agent'
import type { ModelInfo, Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../src/core/types'
import type { ChatMessage, RuntimeEvent, SuperAgentState } from '../../src/shared/types'

export interface BenchmarkOptions {
  /** 仓库根目录 */
  root: string
  /** 输出目录；默认 tmp/verification/collaboration */
  outDir?: string
}

interface Mark {
  at: number
  kind: string
  label: string
}

interface TaskTimeline {
  id: string
  title: string
  dependsOn: string[]
  status: string
  attempts: number
  startMs: number
  endMs: number
  durationMs: number
  waitReason: string
}

interface AcceptanceResult {
  ok: boolean
  exitCode: number
  pass: number | null
  fail: number | null
  error: string | null
}

interface BenchmarkRun {
  scenario: 'sequential' | 'parallel'
  round: number
  order: number
  maxParallel: number
  wallMs: number
  peakConcurrent: number
  tasks: TaskTimeline[]
  overlaps: Array<{ a: string; b: string; fromMs: number; toMs: number; ms: number }>
  acceptance: AcceptanceResult
  artifacts: { serviceLockout: boolean; pageLocked: boolean; lockoutTest: boolean }
  fileHashes: { service: string; page: string; lockoutTest: string }
  counts: { completed: number; failed: number; cancelled: number; timedOut: number }
  downstreamContextA: boolean
  /** 受控样例没有审批等待；真实项目记录可把审批/提问等待单独填在这里 */
  userWaitMs: number
  userWaits: Array<{ kind: string; waitMs: number }>
  marks: Mark[]
  usage: { inputTokens: number; outputTokens: number; kind: 'fixture' }
  notes: string[]
}

interface BenchmarkRound {
  round: number
  order: Array<'sequential' | 'parallel'>
  runs: BenchmarkRun[]
}

interface ScenarioAggregate {
  scenario: 'sequential' | 'parallel'
  runs: number
  wallMsMedian: number
  wallMsMin: number
  wallMsMax: number
  completed: number
  failed: number
  timedOut: number
  userWaitMs: number
  inputTokens: number
  outputTokens: number
  acceptancePassed: number
}

interface BenchmarkRecord {
  schema: 'morrow.collaboration-benchmark/v1'
  generatedAt: string
  environment: {
    node: string
    platform: string
    arch: string
    morrowVersion: string
    commit: string
    dirty: boolean
    model: string
    command: string
    fixture: string
  }
  project: {
    name: string
    workspace: '<temporary-copy>'
    acceptance: string
  }
  realProject: { status: 'missing'; reason: string }
  referencePrototype: { status: 'not-run'; reason: string }
  baseline: { acceptance: AcceptanceResult; artifacts: BenchmarkRun['artifacts'] }
  rounds: BenchmarkRound[]
  runs: BenchmarkRun[]
  aggregate: ScenarioAggregate[]
  checks: Array<{ id: string; ok: boolean; detail: string }>
  ok: boolean
}

const FIXTURE_RELATIVE = 'tests/fixtures/login-demo'

const WORK_DELAYS: Record<string, { read: number; write: number }> = {
  A: { read: 30, write: 110 },
  B: { read: 40, write: 700 },
  C: { read: 20, write: 70 }
}

const WORK_TARGETS: Record<string, string> = {
  A: 'src/service.js',
  B: 'src/page.js',
  C: 'test/lockout-check.mjs'
}

const WORK_SUMMARIES: Record<string, string> = {
  A: '登录服务已实现：锁定账户返回 423，且不签发 token。',
  B: '登录页已实现：423 显示「账户已锁定」，401 显示账号或密码提示。',
  C: '锁定账户用例已补充：校验 423 与不返回 accessToken，并读取 A 的服务实现。'
}

const SERVICE_IMPLEMENTATION = `// 由 T01 基准的脚本成员写入；真实运行时这里应是模型产出的代码。
export function login(input, accounts) {
  const user = accounts?.[input?.username]
  if (!user || user.password !== input?.password) {
    return { status: 401, body: { error: 'invalid_credentials' } }
  }
  if (user.locked) {
    return { status: 423, body: { error: 'account_locked' } }
  }
  return { status: 200, body: { accessToken: \`token-\${input.username}\` } }
}
`

const PAGE_IMPLEMENTATION = `// 由 T01 基准的脚本成员写入；真实运行时这里应是模型产出的代码。
const MESSAGES = {
  401: '账号或密码不正确',
  423: '账户已锁定'
}

export function loginErrorMessage(status) {
  return MESSAGES[status] ?? '登录失败，请稍后再试'
}
`

const LOCKOUT_TEST = `import assert from 'node:assert/strict'
import test from 'node:test'
import { login } from '../src/service.js'

const accounts = {
  bob: { password: 'pw', locked: true }
}

test('锁定账户不返回 accessToken', () => {
  const result = login({ username: 'bob', password: 'pw' }, accounts)
  assert.equal(result.status, 423)
  assert.equal(result.body.accessToken, undefined)
})
`

const FILE_CONTENT: Record<string, string> = {
  A: SERVICE_IMPLEMENTATION,
  B: PAGE_IMPLEMENTATION,
  C: LOCKOUT_TEST
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function messageText(message: ChatMessage | undefined): string {
  if (!message) return ''
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

function toolEvent(id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent {
  return { type: 'tool_call_end', index: 0, id, name, input }
}

function workerTitle(request: ProviderStreamRequest): string {
  return /【子任务】([ABC])\b/.exec(messageText(request.messages[0]))?.[1] ?? '?'
}

function isWorkerPrompt(request: ProviderStreamRequest): boolean {
  return request.system.includes('## 集群成员：')
}

class ScriptedProvider implements Provider {
  private routerCalls = 0
  private readonly workerSteps = new Map<string, number>()
  readonly marks: Mark[] = []

  constructor(private readonly maxParallel: number) {}

  private mark(kind: string, label: string): void {
    this.marks.push({ at: Date.now(), kind, label })
  }

  async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
    if (!isWorkerPrompt(request)) {
      this.routerCalls += 1
      if (this.routerCalls === 1) {
        this.mark('router.dispatch', 'Router 派发 A/B/C')
        yield toolEvent('bench-swarm', 'swarm', {
          goal: '在隔离登录样例上完成服务、页面与锁定测试',
          max_parallel: this.maxParallel,
          retry: 0,
          watchdog_ms: 0,
          tasks: [
            {
              id: 'a',
              title: 'A 登录服务',
              prompt: '读 spec/login-v1.md，实现 src/service.js。',
              deliverable: 'src/service.js 登录服务',
              files: ['src/service.js']
            },
            {
              id: 'b',
              title: 'B 登录页面',
              prompt: '读 spec/login-v1.md，实现 src/page.js。',
              deliverable: 'src/page.js 登录页面',
              files: ['src/page.js']
            },
            {
              id: 'c',
              title: 'C 锁定测试',
              prompt: '读 spec/login-v1.md 和 A 的摘要，补充 test/lockout-check.mjs。',
              deliverable: 'test/lockout-check.mjs 锁定用例',
              files: ['test/lockout-check.mjs'],
              depends_on: ['a'],
              needs: [{ task_id: 'a', result: '登录服务的锁定行为与交付摘要' }],
              wait_reason: '锁定用例需要 A 的登录服务行为'
            }
          ]
        })
        return
      }
      this.mark('router.final', 'Router 汇总结果')
      yield { type: 'text_delta', text: '登录样例由三名成员完成；现在运行验收检查。' }
      return
    }

    const title = workerTitle(request)
    const step = (this.workerSteps.get(title) ?? 0) + 1
    this.workerSteps.set(title, step)
    if (title === 'C' && step === 1) {
      this.mark('worker.context.A', messageText(request.messages[0]).includes('登录服务已实现') ? 'yes' : 'no')
    }
    if (step === 1) {
      this.mark('worker.stream.start', title)
      yield toolEvent(`read-${title}`, 'read_file', { path: 'spec/login-v1.md' })
      await sleep(WORK_DELAYS[title]?.read ?? 20)
      yield toolEvent(`write-${title}`, 'write_file', {
        path: WORK_TARGETS[title],
        content: FILE_CONTENT[title]
      })
      await sleep(WORK_DELAYS[title]?.write ?? 50)
      return
    }

    yield {
      type: 'usage',
      usage: { inputTokens: 120, outputTokens: 40 }
    }
    yield { type: 'text_delta', text: WORK_SUMMARIES[title] ?? '已完成。' }
    this.mark('worker.stream.end', title)
  }
}

function prepareWorkspace(root: string, scenario: string): string {
  const source = join(root, FIXTURE_RELATIVE)
  // Windows 上杀毒/索引可能短暂占用上次目录，使用唯一目录避免清理失败影响重跑。
  const target = join(
    root,
    'tmp',
    'collaboration-benchmark',
    `${scenario}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
  return target
}

function findSuperState(result: RunAgentResult, events: RuntimeEvent[], label: string): SuperAgentState {
  let swarmResult: { ok?: boolean; error?: string; meta?: unknown } | null = null
  for (const message of result.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'swarm') continue
      swarmResult = block.result as { ok?: boolean; error?: string; meta?: unknown } | undefined ?? null
      const meta = block.result?.meta as Record<string, unknown> | undefined
      const state = meta?.superAgent as SuperAgentState | undefined
      if (state) return state
    }
  }
  const fallback = [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: 'super_updated' }> => event.type === 'super_updated')
  if (!fallback?.state) {
    const tools = result.messages
      .flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => `${block.name}:${block.result?.ok === true ? 'ok' : block.result?.error ?? 'no-result'}`)
      .join(' | ')
    throw new Error(
      `${label} 没有产生 super_updated 状态（reason=${result.reason}，swarm=${JSON.stringify(swarmResult?.meta ?? null)}，error=${swarmResult?.error ?? ''}，工具=${tools}）。`
    )
  }
  return fallback.state
}

function parseCount(output: string, label: 'pass' | 'fail'): number | null {
  const match = new RegExp(`(?:#|ℹ)\\s*${label}\\s+(\\d+)`).exec(output)
  return match ? Number(match[1]) : null
}

function sanitizeOutput(output: string, workspace: string): string {
  const normalized = output
    .replaceAll(workspace, '<workspace>')
    .replaceAll(workspace.replaceAll('\\', '/'), '<workspace>')
    .replace(/file:\/\/\/[^\s)]+/gi, '<file>')
    .replace(/[A-Za-z]:[\\/][^\s"'<>)]+/g, '<path>')
  return normalized
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+/.test(line) && line.trim().length > 0)
    .slice(-20)
    .join('\n')
    .slice(0, 1600)
}

function runAcceptance(workspace: string): AcceptanceResult {
  const args = ['--test', 'test/login-check.mjs', 'test/lockout-check.mjs']
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
      ok: true,
      exitCode: 0,
      pass: parseCount(output, 'pass'),
      fail: parseCount(output, 'fail'),
      error: null
    }
  } catch (error) {
    const err = error as { status?: number | null; stdout?: string; stderr?: string; message?: string }
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    return {
      ok: false,
      exitCode: typeof err.status === 'number' ? err.status : -1,
      pass: parseCount(output, 'pass'),
      fail: parseCount(output, 'fail'),
      error: sanitizeOutput(output || err.message || '验收命令失败', workspace)
    }
  }
}

function waitReason(task: TaskTimeline, tasks: TaskTimeline[], maxParallel: number): string {
  const dependencies = task.dependsOn
    .map((id) => tasks.find((entry) => entry.id === id))
    .filter((entry): entry is TaskTimeline => Boolean(entry))
  const dependencyReadyAt = dependencies.length > 0 ? Math.max(...dependencies.map((entry) => entry.endMs)) : -1
  if (dependencies.length > 0 && task.startMs - dependencyReadyAt <= 15) {
    return `等待依赖 ${dependencies.map((entry) => entry.id).join('、')} 完成`
  }
  const occupied = tasks.filter(
    (other) =>
      other.id !== task.id &&
      other.startMs < task.startMs &&
      other.endMs >= task.startMs - 1
  ).length
  if (occupied >= maxParallel) {
    return dependencies.length > 0
      ? `等待并行名额（最多 ${maxParallel} 人；依赖已就绪）`
      : `等待并行名额（最多 ${maxParallel} 人）`
  }
  return '无需等待'
}

function overlapsOf(tasks: TaskTimeline[]): BenchmarkRun['overlaps'] {
  const overlaps: BenchmarkRun['overlaps'] = []
  for (let index = 0; index < tasks.length; index += 1) {
    for (let other = index + 1; other < tasks.length; other += 1) {
      const a = tasks[index]
      const b = tasks[other]
      const from = Math.max(a.startMs, b.startMs)
      const to = Math.min(a.endMs, b.endMs)
      if (to - from > 5) overlaps.push({ a: a.id, b: b.id, fromMs: from, toMs: to, ms: to - from })
    }
  }
  return overlaps
}

function peakConcurrency(tasks: TaskTimeline[]): number {
  const points = tasks.flatMap((task) => [
    { at: task.startMs, delta: 1 },
    { at: task.endMs, delta: -1 }
  ])
  points.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let peak = 0
  let current = 0
  for (const point of points) {
    current += point.delta
    peak = Math.max(peak, current)
  }
  return peak
}

function artifactChecks(workspace: string): BenchmarkRun['artifacts'] {
  const servicePath = join(workspace, 'src', 'service.js')
  const pagePath = join(workspace, 'src', 'page.js')
  const testPath = join(workspace, 'test', 'lockout-check.mjs')
  return {
    serviceLockout: existsSync(servicePath) && readFileSync(servicePath, 'utf8').includes('account_locked'),
    pageLocked: existsSync(pagePath) && readFileSync(pagePath, 'utf8').includes('账户已锁定'),
    lockoutTest: existsSync(testPath)
  }
}

function fileHash(path: string): string {
  if (!existsSync(path)) return ''
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
}

function artifactHashes(workspace: string): BenchmarkRun['fileHashes'] {
  return {
    service: fileHash(join(workspace, 'src', 'service.js')),
    page: fileHash(join(workspace, 'src', 'page.js')),
    lockoutTest: fileHash(join(workspace, 'test', 'lockout-check.mjs'))
  }
}

async function runScenario(
  root: string,
  scenario: 'sequential' | 'parallel',
  maxParallel: number,
  round = 1,
  order = 1
): Promise<BenchmarkRun> {
  const workspace = prepareWorkspace(root, `${scenario}-r${round}`)
  const provider = new ScriptedProvider(maxParallel)
  const events: RuntimeEvent[] = []
  const start = Date.now()
  const result = await runAgent({
    runId: `bench-${scenario}-r${round}`,
    sessionId: `bench-${scenario}-r${round}-${start}`,
    provider,
    model: {
      id: 'scripted-fixture',
      label: 'Scripted Fixture',
      contextWindow: 128_000,
      maxOutput: 4096,
      supportsTools: true
    } satisfies ModelInfo,
    systemPrompt: '协作基准：在隔离项目里完成登录样例。',
    history: [],
    userMessage: {
      id: `bench-user-${scenario}`,
      role: 'user',
      content: [{ type: 'text', text: '完成登录样例，并让锁定账户提示正确。' }],
      createdAt: start
    },
    workspace,
    permissionMode: 'auto',
    mode: 'work',
    superMode: true,
    agents: BUILTIN_AGENT_ROLES,
    snapshotDir: join(workspace, '.snapshots'),
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onPermission: async () => 'deny',
    onAskUser: async () => ({ value: 'no', label: 'no' }),
    autoCompact: false
  })
  const wallMs = Date.now() - start
  const state = findSuperState(result, events, `${scenario} 第 ${round} 轮`)
  const tasks: TaskTimeline[] = state.tasks.map((task) => {
    const taskStart = task.startedAt ?? start
    const taskEnd = task.finishedAt ?? taskStart
    return {
      id: task.id,
      title: task.title,
      dependsOn: [...task.dependsOn],
      status: task.status,
      attempts: task.attempts,
      startMs: Math.max(0, taskStart - start),
      endMs: Math.max(0, taskEnd - start),
      durationMs: Math.max(0, taskEnd - taskStart),
      waitReason: ''
    }
  })
  for (const task of tasks) task.waitReason = waitReason(task, tasks, maxParallel)
  const acceptance = runAcceptance(workspace)
  const usage = result.usage
  return {
    scenario,
    round,
    order,
    maxParallel,
    wallMs,
    peakConcurrent: peakConcurrency(tasks),
    tasks,
    overlaps: overlapsOf(tasks),
    acceptance,
    artifacts: artifactChecks(workspace),
    fileHashes: artifactHashes(workspace),
    counts: {
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      cancelled: tasks.filter((task) => task.status === 'cancelled').length,
      timedOut: 0
    },
    downstreamContextA: provider.marks.some(
      (mark) => mark.kind === 'worker.context.A' && mark.label === 'yes'
    ),
    userWaitMs: 0,
    userWaits: [],
    marks: provider.marks.map((mark) => ({ at: Math.max(0, mark.at - start), kind: mark.kind, label: mark.label })),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      kind: 'fixture'
    },
    notes: [
      '脚本模型固定等待与输出，不代表真实模型速度。',
      '所有文件写入都发生在 tmp 下的隔离副本，不触碰用户项目。',
      acceptance.ok ? '验收命令通过。' : '验收命令未通过，详见 acceptance。'
    ]
  }
}

function compareRuns(
  rounds: BenchmarkRound[],
  baseline: BenchmarkRecord['baseline']
): Array<{ id: string; ok: boolean; detail: string }> {
  const runs = rounds.flatMap((round) => round.runs)
  const sequentialRuns = runs.filter((run) => run.scenario === 'sequential')
  const parallelRuns = runs.filter((run) => run.scenario === 'parallel')
  const sequential = sequentialRuns[0]
  const a = sequential?.tasks.find((task) => task.id === 'a')
  const b = sequential?.tasks.find((task) => task.id === 'b')
  const c = sequential?.tasks.find((task) => task.id === 'c')
  const checks: Array<{ id: string; ok: boolean; detail: string }> = []
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail })
  }
  add(
    'baseline-incomplete',
    !baseline.acceptance.ok &&
      !baseline.artifacts.serviceLockout &&
      !baseline.artifacts.pageLocked &&
      !baseline.artifacts.lockoutTest,
    '样例起点必须未通过验收且三个产物均未完成，避免用已完成代码冒充协作结果。'
  )
  add(
    'rotation-order',
    rounds.length >= 2 &&
      rounds[0]?.order.join('>') === 'sequential>parallel' &&
      rounds[1]?.order.join('>') === 'parallel>sequential',
    '至少两轮，且旧/新方式的运行顺序轮换，减少固定顺序带来的偏差。'
  )
  add(
    'all-tasks-completed',
    runs.length >= 4 &&
      runs.every(
        (run) =>
          run.tasks.length === 3 &&
          run.tasks.every((task) => task.status === 'completed') &&
          run.counts.failed === 0 &&
          run.counts.cancelled === 0
      ),
    '所有轮次的 A/B/C 都应为 completed，失败/取消为 0；超时单列。'
  )
  add(
    'sequential-no-overlap',
    sequentialRuns.length >= 2 &&
      sequentialRuns.every((run) => run.overlaps.length === 0 && run.peakConcurrent === 1),
    '旧方式（串行，最多 1 人）任意两任务不应重叠，峰值人数为 1。'
  )
  add(
    'sequential-order',
    Boolean(a && b && c) &&
      sequentialRuns.every((run) => {
        const ra = run.tasks.find((task) => task.id === 'a')
        const rb = run.tasks.find((task) => task.id === 'b')
        const rc = run.tasks.find((task) => task.id === 'c')
        return Boolean(ra && rb && rc && ra.startMs <= rb.startMs && rb.startMs <= rc.startMs)
      }),
    '旧方式按 A→B→C 开始。'
  )
  add(
    'parallel-overlap',
    parallelRuns.length >= 2 &&
      parallelRuns.every(
        (run) =>
          run.overlaps.some((pair) => pair.a === 'a' && pair.b === 'b') &&
          run.peakConcurrent >= 2
      ),
    '新方式（并行，最多 2 人）A 与 B 应有实际重叠，峰值至少 2。'
  )
  add(
    'handoff-after-dependency',
    parallelRuns.every((run) => {
      const pa = run.tasks.find((task) => task.id === 'a')
      const pc = run.tasks.find((task) => task.id === 'c')
      return Boolean(pa && pc && pc.startMs + 5 >= pa.endMs)
    }),
    '新方式的 C 必须在 A 完成后才开始。'
  )
  add(
    'handoff-before-slow-finish',
    parallelRuns.every((run) => {
      const pb = run.tasks.find((task) => task.id === 'b')
      const pc = run.tasks.find((task) => task.id === 'c')
      return Boolean(pb && pc && pc.startMs < pb.endMs)
    }),
    '新方式的 C 应在 B 结束前拿到 A 的成果并开工。'
  )
  add(
    'downstream-context',
    parallelRuns.every((run) => run.downstreamContextA),
    '新方式 C 的上下文应包含 A 的交付摘要。'
  )
  add(
    'acceptance-pass',
    runs.length >= 4 && runs.every((run) => run.acceptance.ok),
    '所有轮次运行后的 node --test 验收都应通过。'
  )
  add(
    'artifacts-exist',
    runs.length >= 4 &&
      runs.every(
        (run) =>
          run.artifacts.serviceLockout &&
          run.artifacts.pageLocked &&
          run.artifacts.lockoutTest
      ),
    '每次运行都应真实写入服务、页面、锁定用例三个产物。'
  )
  add(
    'same-artifact-hashes',
    sequentialRuns.length >= 2 &&
      parallelRuns.length >= 2 &&
      sequentialRuns.every(
        (run) =>
          run.fileHashes.service === sequential.fileHashes.service &&
          run.fileHashes.page === sequential.fileHashes.page &&
          run.fileHashes.lockoutTest === sequential.fileHashes.lockoutTest
      ) &&
      parallelRuns.every(
        (run) =>
          run.fileHashes.service === sequential.fileHashes.service &&
          run.fileHashes.page === sequential.fileHashes.page &&
          run.fileHashes.lockoutTest === sequential.fileHashes.lockoutTest
      ),
    '旧/新方式写出的三份交付文件哈希一致，结论能指回同一版本文件。'
  )
  add(
    'usage-recorded',
    runs.every((run) => run.usage.inputTokens > 0 && run.usage.outputTokens > 0),
    '每次运行都记录脚本模型的输入/输出用量；这是夹具用量，不是真实账单。'
  )
  return checks
}

function aggregateRuns(runs: BenchmarkRun[]): ScenarioAggregate[] {
  const scenarios: Array<'sequential' | 'parallel'> = ['sequential', 'parallel']
  return scenarios.map((scenario) => {
    const list = runs.filter((run) => run.scenario === scenario)
    const wall = list.map((run) => run.wallMs).sort((left, right) => left - right)
    const median =
      wall.length === 0
        ? 0
        : wall.length % 2 === 1
          ? wall[(wall.length - 1) / 2]
          : Math.round((wall[wall.length / 2 - 1] + wall[wall.length / 2]) / 2)
    return {
      scenario,
      runs: list.length,
      wallMsMedian: median,
      wallMsMin: wall[0] ?? 0,
      wallMsMax: wall.at(-1) ?? 0,
      completed: list.reduce((sum, run) => sum + run.counts.completed, 0),
      failed: list.reduce((sum, run) => sum + run.counts.failed, 0),
      timedOut: list.reduce((sum, run) => sum + run.counts.timedOut, 0),
      userWaitMs: list.reduce((sum, run) => sum + run.userWaitMs, 0),
      inputTokens: list.reduce((sum, run) => sum + run.usage.inputTokens, 0),
      outputTokens: list.reduce((sum, run) => sum + run.usage.outputTokens, 0),
      acceptancePassed: list.filter((run) => run.acceptance.ok).length
    }
  })
}

function gitInfo(root: string): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
    return { commit, dirty: status.length > 0 }
  } catch {
    return { commit: 'unknown', dirty: false }
  }
}

function packageVersion(root: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof raw.version === 'string' ? raw.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function timelineBar(run: BenchmarkRun, width = 56): string[] {
  const span = Math.max(1, run.wallMs)
  const scale = (value: number): number => Math.min(width, Math.max(0, Math.round((value / span) * width)))
  return run.tasks.map((task) => {
    const start = scale(task.startMs)
    const end = Math.max(start + 1, scale(task.endMs))
    return `${task.id.toUpperCase()} ${'·'.repeat(start)}${'█'.repeat(end - start)} ${task.startMs}–${task.endMs}ms ${task.waitReason}`
  })
}

function renderMarkdown(record: BenchmarkRecord): string {
  const scenarioLabel = (scenario: 'sequential' | 'parallel'): string =>
    scenario === 'sequential' ? '旧方式：串行（最多 1 人）' : '新方式：并行 + 提前交接（最多 2 人）'
  const lines: string[] = [
    '# 协作对照基准（T01 · T16 复用）',
    '',
    `- 生成时间：${record.generatedAt}`,
    `- 起点：\`${record.environment.commit}\`${record.environment.dirty ? '（工作区有未提交改动）' : ''}`,
    `- 模型：${record.environment.model}（离线脚本，不代表真实模型速度）`,
    `- 命令：\`${record.environment.command}\``,
    `- 样例：\`${record.project.name}\` · 验收：\`${record.project.acceptance}\``,
    `- 真实项目记录：未提供（${record.realProject.reason}）`,
    `- 参考原型：未比较速度或质量（${record.referencePrototype.reason}）`,
    '',
    '## 起点状态',
    '',
    `- 初始验收：${record.baseline.acceptance.ok ? '通过（不应发生）' : '未通过（预期）'}`,
    `- 初始产物：服务锁定=${record.baseline.artifacts.serviceLockout ? '有' : '无'} · 页面提示=${record.baseline.artifacts.pageLocked ? '有' : '无'} · 锁定用例=${record.baseline.artifacts.lockoutTest ? '有' : '无'}`,
    '',
    '## 对照表（同一项目、需求、脚本模型、角色与验收）',
    '',
    '| 方式 | 运行次数 | 总耗时中位数 | 耗时范围 | 完成 / 失败 / 超时 | 用户等待 | 输入+输出 tokens | 验收通过 |',
    '|---|---|---:|---:|---|---:|---:|---:|'
  ]
  for (const row of record.aggregate) {
    lines.push(
      `| ${scenarioLabel(row.scenario)} | ${row.runs} | ${row.wallMsMedian}ms | ${row.wallMsMin}–${row.wallMsMax}ms | ${row.completed} / ${row.failed} / ${row.timedOut} | ${row.userWaitMs}ms | ${row.inputTokens + row.outputTokens} | ${row.acceptancePassed}/${row.runs} |`
    )
  }
  lines.push(
    '',
    '运行顺序轮换：' +
      record.rounds.map((round) => `第 ${round.round} 轮 ${round.order.join(' → ')}`).join('；') +
      '。耗时来自受控脚本等待，只验证调度关系，不作为真实提速结论。',
    ''
  )
  for (const round of record.rounds) {
    lines.push(`## 第 ${round.round} 轮（${round.order.join(' → ')}）`, '')
    for (const run of round.runs) {
      lines.push(
        `### ${scenarioLabel(run.scenario)}`,
        '',
        `- 总耗时：${run.wallMs}ms`,
        `- 峰值同时工作人数：${run.peakConcurrent}`,
        `- 完成 / 失败 / 超时 / 取消：${run.counts.completed} / ${run.counts.failed} / ${run.counts.timedOut} / ${run.counts.cancelled}`,
        `- 验收：${run.acceptance.ok ? '通过' : '未通过'}（pass=${run.acceptance.pass ?? '?'}, fail=${run.acceptance.fail ?? '?'}）`,
        `- 用户等待：${run.userWaitMs}ms（${run.userWaits.length === 0 ? '受控样例未触发审批/提问' : run.userWaits.map((wait) => `${wait.kind}=${wait.waitMs}ms`).join('、')}）`,
        `- 用量：输入 ${run.usage.inputTokens} / 输出 ${run.usage.outputTokens}（夹具固定用量）`,
        `- 文件哈希：service=${run.fileHashes.service} · page=${run.fileHashes.page} · lockout=${run.fileHashes.lockoutTest}`,
        '',
        '```text',
        ...timelineBar(run),
        '```',
        '',
        '| 任务 | 依赖 | 开始 | 结束 | 耗时 | 等待原因 | 状态 |',
        '|---|---|---:|---:|---:|---|---|'
      )
      for (const task of run.tasks) {
        lines.push(
          `| ${task.id} | ${task.dependsOn.join('、') || '—'} | ${task.startMs}ms | ${task.endMs}ms | ${task.durationMs}ms | ${task.waitReason} | ${task.status} |`
        )
      }
      lines.push(
        '',
        `重叠：${run.overlaps.length ? run.overlaps.map((pair) => `${pair.a}/${pair.b} ${pair.fromMs}–${pair.toMs}ms`).join('；') : '无'}`,
        ''
      )
    }
  }
  lines.push('## 检查', '', '| 检查 | 结果 | 说明 |', '|---|---|---|')
  for (const check of record.checks) lines.push(`| ${check.id} | ${check.ok ? '通过' : '失败'} | ${check.detail} |`)
  lines.push(
    '',
    '## 说明',
    '',
    '- 这是受控离线样例：脚本模型固定等待与输出，只验证调度、依赖交接、真实文件写入与验收命令。',
    '- 旧/新方式使用同一夹具、同一脚本模型、同一角色与验收脚本；唯一变化是串行/并行与提前交接。',
    '- 真实项目负责人尚未提供获准使用的项目副本，因此本记录不包含真实项目时长、失败率或模型账单。',
    '- 参考原型没有在本机提供可运行部署，本记录不与参考原型比较速度或质量；只把同题、同版本文件与验收结果留作对照。',
    '',
    '## 失败、超时与用户等待',
    '',
    '- 本轮的对照运行没有失败、超时或审批等待，表中为 0；这三种情况由 T07（重试/看门狗）、T14（满员时用户跟进）和 T15（卡住提醒）的专门记录覆盖。',
    '- 不要把 0 失败/0 超时理解成真实项目不会失败；这里只是在比较调度关系。',
    ''
  )
  return lines.join('\n')
}

/** 运行轮换基准并写出脱敏记录；任一检查失败时仍先写文件，再抛错。 */
export async function runCollaborationBenchmark(options: BenchmarkOptions): Promise<BenchmarkRecord> {
  const root = resolve(options.root)
  const outDir = options.outDir ? resolve(options.outDir) : join(root, 'tmp', 'verification', 'collaboration')
  mkdirSync(outDir, { recursive: true })
  const baselineWorkspace = prepareWorkspace(root, 'baseline')
  const baseline = {
    acceptance: runAcceptance(baselineWorkspace),
    artifacts: artifactChecks(baselineWorkspace)
  }
  // 轮换旧/新方式的运行顺序，避免固定顺序把缓存、磁盘或调度预热算成新版优势。
  const round1: BenchmarkRound = {
    round: 1,
    order: ['sequential', 'parallel'],
    runs: [await runScenario(root, 'sequential', 1, 1, 1), await runScenario(root, 'parallel', 2, 1, 2)]
  }
  const round2: BenchmarkRound = {
    round: 2,
    order: ['parallel', 'sequential'],
    runs: [await runScenario(root, 'parallel', 2, 2, 1), await runScenario(root, 'sequential', 1, 2, 2)]
  }
  const rounds = [round1, round2]
  const runs = rounds.flatMap((round) => round.runs)
  const aggregate = aggregateRuns(runs)
  const checks = compareRuns(rounds, baseline)
  const git = gitInfo(root)
  const record: BenchmarkRecord = {
    schema: 'morrow.collaboration-benchmark/v1',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      morrowVersion: packageVersion(root),
      commit: git.commit,
      dirty: git.dirty,
      model: 'scripted-fixture (offline, no external API)',
      command: 'npm run bench:collaboration',
      fixture: FIXTURE_RELATIVE
    },
    project: {
      name: 'login-demo',
      workspace: '<temporary-copy>',
      acceptance: 'node --test test/login-check.mjs test/lockout-check.mjs'
    },
    realProject: {
      status: 'missing',
      reason: '本轮没有获准使用的真实项目副本；真实项目时间线需由负责人补充'
    },
    referencePrototype: {
      status: 'not-run',
      reason: '参考原型没有在本机提供可运行部署；本记录只做同题对照，不与参考原型比较速度或模型质量'
    },
    baseline,
    rounds,
    runs,
    aggregate,
    checks,
    ok: checks.every((check) => check.ok)
  }
  const serialized = JSON.stringify(record)
  const sanitized = !serialized.includes(root) && !/file:\/\/\//i.test(serialized)
  if (!sanitized) throw new Error('协作基准脱敏失败：记录仍包含工作区绝对路径或文件 URL。')
  writeFileSync(join(outDir, 'benchmark-latest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  writeFileSync(join(outDir, 'timeline-latest.md'), renderMarkdown(record), 'utf8')
  if (!record.ok) {
    const failed = checks.filter((check) => !check.ok).map((check) => `${check.id}: ${check.detail}`)
    throw new Error(`协作基准未通过：${failed.join('；')}`)
  }
  return record
}
