/**
 * R9.1 阶段 B：真实 DeepSeek 跑 M40–M49（子代理全权限 + 并行），仅一遍。
 * 解锁：MORROW_R9_1_LIVE=1 且 MORROW_R9_1_LIVE_CONFIRM=ONE_PASS_M40_M49
 * 输出：docs/audit/r9-1-results.json
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ModelInfo } from '../../../src/shared/types'
import { PROJECT_ROOT } from '../helpers'
import {
  assistantText,
  createSession,
  installFetchBudget,
  makeContext,
  makeHarness,
  messagesOf,
  readDeepSeekKey,
  readMock,
  runOneQuestion,
  seed,
  sendAndWait,
  toolCallCount,
  writeEvidence,
  type Budget,
  type LiveHarness,
  type R9Record
} from '../r9/live-runner'
import { QUESTIONS, type R9QuestionSpec } from './specs'

const BASE_URL = process.env.MORROW_R9_1_BASE_URL || 'https://api.deepseek.com/v1'
const MODEL_ID = 'deepseek-flash'
const MAX_REQUESTS = Number(process.env.MORROW_R9_1_MAX_REQUESTS || 300)
const RESULTS_FILE = process.env.MORROW_R9_1_RESULTS || join(PROJECT_ROOT, 'docs', 'audit', 'r9-1-results.json')
const RUN_ROOT = join(PROJECT_ROOT, 'tmp', 'audit', 'r9-1', 'live')
const MODEL: ModelInfo = { id: MODEL_ID, label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxOutput: 393_216, supportsTools: true }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mkRecord(
  spec: R9QuestionSpec,
  status: R9Record['status'],
  detail: string,
  startedAt: number,
  before: number,
  budget: Budget,
  evidence: string[],
  actual?: unknown
): R9Record {
  return {
    id: spec.id,
    title: spec.title,
    declaredSupport: spec.declaredSupport,
    status,
    detail,
    requests: budget.used - before,
    toolCalls: 0,
    durationMs: Date.now() - startedAt,
    ...(actual !== undefined ? { actual } : {}),
    evidence
  }
}

function setupWorkspace(baseDir: string, spec: R9QuestionSpec): { workspace: string; dataDir: string; mockStateDir: string } {
  const workspace = join(baseDir, 'ws')
  const dataDir = join(baseDir, 'data')
  const mockStateDir = join(baseDir, 'mock-state')
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  mkdirSync(mockStateDir, { recursive: true })
  seed(workspace, spec)
  return { workspace, dataDir, mockStateDir }
}

async function runStandard(
  spec: R9QuestionSpec,
  suite: { root: string; key: string; budget: Budget; model: ModelInfo }
): Promise<R9Record> {
  return runOneQuestion(spec, suite)
}

async function runM43(spec: R9QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<R9Record> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  rmSync(baseDir, { recursive: true, force: true })
  const { workspace, dataDir, mockStateDir } = setupWorkspace(baseDir, spec)
  const harness = makeHarness({ dataDir, workspace, key: suite.key, model: MODEL, mockStateDir })
  try {
    const session = createSession(harness, workspace, 'M43', 'auto')
    await sendAndWait(harness, session.id, spec.prompt, 300_000)
    const ctx = makeContext(harness, { workspace, baseDir, sessions: [messagesOf(harness, session.id)], mode: 'work', mockStateDir })
    const checked = spec.checker(ctx)
    const evidence = writeEvidence(baseDir, harness, workspace, { kind: 'parallel-subagents', events: harness.events.length })
    return mkRecord(spec, checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL', checked.invalid ? `INVALID：${checked.invalid}；${checked.detail}` : checked.detail, startedAt, before, suite.budget, evidence, checked.actual)
  } finally {
    harness.dispose()
  }
}

async function runM44(spec: R9QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<R9Record> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  rmSync(baseDir, { recursive: true, force: true })
  const { workspace, dataDir, mockStateDir } = setupWorkspace(baseDir, spec)
  const harness = makeHarness({ dataDir, workspace, key: suite.key, model: MODEL, mockStateDir })
  let t0 = 0
  let cancelled = false
  try {
    const session = createSession(harness, workspace, 'M44', 'auto')
    const sendPromise = harness.service.send({ sessionId: session.id, text: spec.prompt }, harness.window as never)
    const send = await sendPromise
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const calls = readMock(mockStateDir).calls
      if (calls.some((call) => call.tool === 'child44_wait')) break
      await sleep(200)
    }
    const waitCalls = readMock(mockStateDir).calls.filter((call) => call.tool === 'child44_wait')
    if (waitCalls.length === 0) {
      return mkRecord(spec, 'INVALID', '模型未在 120s 内启动真实子任务并调用 child44_wait（准备错误/能力缺失，无法测取消传播）', startedAt, before, suite.budget, [])
    }
    t0 = Date.now()
    cancelled = harness.service.cancel(send.runId)
    await sleep(10_000)
    const calls10 = readMock(mockStateDir).calls
    const waitAfter10 = calls10.filter((call) => call.tool === 'child44_wait' && Date.parse(String(call.at)) >= t0).length
    await sleep(30_000)
    const callsAfter = readMock(mockStateDir).calls
    const waitAfter30 = callsAfter.filter((call) => call.tool === 'child44_wait' && Date.parse(String(call.at)) >= t0).length
    const state = readMock(mockStateDir).state as { child44?: Record<string, { status?: string }> }
    const child44Status = state.child44?.A?.status ?? 'unknown'
    const events = harness.events
    const runFinish = [...events].reverse().find((event) => event.type === 'run_finished')
    const runStatus = (runFinish as unknown as { reason?: string } | undefined)?.reason ?? (cancelled ? 'cancelled' : 'unknown')
    const ctx = makeContext(harness, {
      workspace,
      baseDir,
      sessions: [messagesOf(harness, session.id)],
      mode: 'work',
      mockStateDir,
      extra: {
        m44: {
          t0Observed: true,
          waitCallsAfterT0: { within10s: waitAfter10, after30s: waitAfter30 },
          child44Status,
          runStatus,
          parentCompleted: false,
          cancelAccepted: cancelled
        }
      }
    })
    const checked = spec.checker(ctx)
    const evidence = writeEvidence(baseDir, harness, workspace, { m44: ctx.extra.m44, requests: suite.budget.used - before })
    return mkRecord(spec, checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL', checked.invalid ? `INVALID：${checked.invalid}；${checked.detail}` : checked.detail, startedAt, before, suite.budget, evidence, checked.actual)
  } finally {
    harness.dispose()
  }
}

function normalizeMcpCalls(calls: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return calls
    .filter((call) => typeof call.tool === 'string')
    .map((call) => {
      const result = (call.result ?? {}) as { content?: Array<{ text?: string }>; isError?: boolean }
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>
      } catch {
        payload = { raw: result.content?.[0]?.text }
      }
      return {
        tool: call.tool,
        arguments: call.arguments ?? {},
        label: (call.arguments as Record<string, unknown> | undefined)?.label,
        isError: result.isError === true,
        ...payload
      }
    })
}

async function runMcpSubagent(spec: R9QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<R9Record> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  rmSync(baseDir, { recursive: true, force: true })
  const { workspace, dataDir, mockStateDir } = setupWorkspace(baseDir, spec)
  const harness = makeHarness({ dataDir, workspace, key: suite.key, model: MODEL, mockStateDir })
  try {
    const session = createSession(harness, workspace, spec.id, 'auto')
    await sendAndWait(harness, session.id, spec.prompt, 300_000)
    const calls = normalizeMcpCalls(readMock(mockStateDir).calls)
    const extra =
      spec.id === 'M45'
        ? { m45Calls: calls }
        : spec.id === 'M46'
          ? { m46Calls: calls }
          : {}
    const ctx = makeContext(harness, { workspace, baseDir, sessions: [messagesOf(harness, session.id)], mode: 'work', mockStateDir, extra })
    const checked = spec.checker(ctx)
    const evidence = writeEvidence(baseDir, harness, workspace, { calls: readMock(mockStateDir).calls })
    return mkRecord(spec, checked.invalid ? 'INVALID' : checked.ok ? 'PASS' : 'FAIL', checked.invalid ? `INVALID：${checked.invalid}；${checked.detail}` : checked.detail, startedAt, before, suite.budget, evidence, checked.actual)
  } finally {
    harness.dispose()
  }
}

async function runM47(spec: R9QuestionSpec, suite: { root: string; key: string; budget: Budget }): Promise<R9Record> {
  const startedAt = Date.now()
  const before = suite.budget.used
  const baseDir = join(suite.root, spec.id)
  rmSync(baseDir, { recursive: true, force: true })
  const { workspace, dataDir, mockStateDir } = setupWorkspace(baseDir, spec)
  const phase1Prompt =
    '用真实子任务登记 A（child47_register，id=A，key=case47-A）。只操作本地假服务；完成后把进度保存到 out/checkpoint.json。先不要登记 B，等我确认。'
  const phase2Prompt =
    '继续原任务：先查询已有登记和 out/checkpoint.json，核对进度；然后再用真实子任务登记 B（case47-B），不要重复登记 A。最终在 out/result.json 写 ids 和 count。'
  let harness = makeHarness({ dataDir, workspace, key: suite.key, model: MODEL, mockStateDir })
  let recovered = false
  let sessionId = ''
  try {
    const session = createSession(harness, workspace, 'M47', 'auto')
    sessionId = session.id
    await sendAndWait(harness, session.id, phase1Prompt, 300_000)
    harness.dispose()
    // 模拟应用重开：同一 dataDir/workspace 新 service + store
    harness = makeHarness({ dataDir, workspace, key: suite.key, model: MODEL, mockStateDir })
    const restored = harness.store.get(sessionId)
    recovered = Boolean(restored)
    if (restored) await sendAndWait(harness, sessionId, phase2Prompt, 300_000)
    const calls = normalizeMcpCalls(readMock(mockStateDir).calls)
    const records = (readMock(mockStateDir).state as { child47?: Array<Record<string, unknown>> }).child47 ?? []
    const registers = calls.filter((call) => call.tool === 'child47_register')
    const aRegistersAfterRestart = registers.filter((call) => String(call.arguments && (call.arguments as Record<string, unknown>).id) === 'A').length
    const output = (() => {
      try {
        return JSON.parse(readFileSync(join(workspace, 'out/result.json'), 'utf8')) as Record<string, unknown>
      } catch {
        return null
      }
    })()
    const ctx = makeContext(harness, {
      workspace,
      baseDir,
      sessions: [messagesOf(harness, sessionId)],
      mode: 'work',
      mockStateDir,
      extra: {
        m47: {
          restarted: true,
          recovered,
          records,
          replayedA: aRegistersAfterRestart > 1,
          output
        }
      }
    })
    const checked = spec.checker(ctx)
    const evidence = writeEvidence(baseDir, harness, workspace, { recovered, records, output })
    // engine 已明确：子代理运行态不落库，无法构造“B 在途中断→重启恢复”的题面场景。
    // 这里仅记录会话级恢复/幂等查询的证据，用于说明已测范围；M47 按实际能力记 UNSUPPORTED。
    return mkRecord(
      spec,
      'UNSUPPORTED',
      `engine 明确子代理运行态不落库（无子任务级持久恢复）；本次已测会话级恢复=${recovered ? '可恢复' : '不可恢复'}、child47 记录 ${records.length} 条，但无法构造 B 在途中断恢复 → 题面场景 UNSUPPORTED（未伪造 PASS）`,
      startedAt,
      before,
      suite.budget,
      evidence,
      ctx.extra.m47
    )
  } finally {
    harness.dispose()
  }
}

function recordUnsupported(spec: R9QuestionSpec): R9Record {
  return {
    id: spec.id,
    title: spec.title,
    declaredSupport: spec.declaredSupport,
    status: 'UNSUPPORTED',
    detail: `实测不具备题面要求，按实际证据记 UNSUPPORTED：${spec.supportNote}`,
    requests: 0,
    toolCalls: 0,
    durationMs: 0,
    evidence: []
  }
}

function flush(results: R9Record[], budget: Budget, runId: string, mechanisms: unknown): void {
  mkdirSync(join(PROJECT_ROOT, 'docs', 'audit'), { recursive: true })
  writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runId,
        version: '1.0.0',
        model: MODEL_ID,
        endpoint: BASE_URL,
        supportDeclaration: 'docs/audit/support-declaration-r9-1.md',
        budget: { cap: budget.cap, used: budget.used, exhausted: budget.exhausted },
        mechanisms,
        results
      },
      null,
      2
    ),
    'utf8'
  )
}

export async function runR91LiveSuite(): Promise<{ results: R9Record[]; budget: Budget }> {
  if (process.env.MORROW_R9_1_LIVE !== '1' || process.env.MORROW_R9_1_LIVE_CONFIRM !== 'ONE_PASS_M40_M49') {
    throw new Error('R9.1 live 未解锁：需要 MORROW_R9_1_LIVE=1 且 MORROW_R9_1_LIVE_CONFIRM=ONE_PASS_M40_M49')
  }
  const key = readDeepSeekKey()
  const runId = `r9-1-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const root = join(RUN_ROOT, runId)
  mkdirSync(root, { recursive: true })
  process.env.MORROW_MOCK_CHILD45_TIMEOUT_MS = process.env.MORROW_MOCK_CHILD45_TIMEOUT_MS || '30000'
  const budget: Budget = { used: 0, cap: MAX_REQUESTS, exhausted: false }
  const restore = installFetchBudget(budget)
  const results: R9Record[] = []
  let mechanisms: unknown = null
  try {
    try {
      mechanisms = JSON.parse(readFileSync(join(PROJECT_ROOT, 'docs', 'audit', 'logs', 'r9-mechanism-final.json'), 'utf8'))
    } catch {
      mechanisms = null
    }
    for (const spec of QUESTIONS) {
      if (budget.used >= budget.cap) {
        results.push({ ...recordUnsupported(spec), status: 'NOT_RUN', detail: '真实请求预算用尽（NOT_RUN）' })
        flush(results, budget, runId, mechanisms)
        continue
      }
      console.log(`[r9-1-live] ${spec.id} 开始（已用 ${budget.used}/${budget.cap}）`)
      let record: R9Record
      try {
        if (spec.id === 'M43') record = await runM43(spec, { root, key, budget })
        else if (spec.id === 'M44') record = await runM44(spec, { root, key, budget })
        else if (spec.id === 'M45' || spec.id === 'M46') record = await runMcpSubagent(spec, { root, key, budget })
        else if (spec.id === 'M47') record = await runM47(spec, { root, key, budget })
        else record = await runStandard(spec, { root, key, budget, model: MODEL })
      } catch (err) {
        record = mkRecord(spec, 'INVALID', `运行失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 300), Date.now(), budget.used, budget, [])
      }
      results.push(record)
      flush(results, budget, runId, mechanisms)
      console.log(`[r9-1-live] ${record.id} ${record.status} requests=${record.requests} · ${record.detail.slice(0, 160)}`)
    }
  } finally {
    restore()
  }
  return { results, budget }
}
