/**
 * R9 机制验收探针 R2-A—R2-H（脚本/本地 mock 驱动真实产品调度；零真实模型费用）。
 *
 * 说明：这些不是自主能力题，不计入 49 题分母；阶段 A 核心修复（task-17/18）尚未合入时，
 * 探针会记录 FAIL/未通过，阶段 B 前由 Lead 信号后复跑作为验收依据。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, Goal, ModelInfo, RuntimeEvent } from '../../../src/shared/types'
import { runAgent } from '../../../src/core/agent'
import { evaluatePermission, type PermissionPolicyContext, type PermissionTarget } from '../../../src/core/permissions'
import { buildSystemPrompt } from '../../../src/core/prompt'
import { ScriptedProvider, type ScriptStep } from '../../unit/core/helpers/scripted-provider'
import {
  AUDIT_MODEL_ID,
  auditProviderConfig,
  createAuditStores,
  makeAuditDir,
  makeCapturedWindow,
  PROJECT_ROOT,
  startMockSseServer,
  waitFor,
  type MockReply,
  type MockSseServer
} from '../helpers'
import { QUESTIONS, r9SpecById, type R9QuestionSpec } from './specs'

export interface MechanismResult {
  id: string
  status: 'PASS' | 'FAIL' | 'PENDING'
  detail: string
  evidence?: Record<string, unknown>
}

const MODEL: ModelInfo = {
  id: 'audit-r9-scripted',
  label: 'R9 Scripted',
  contextWindow: 8192,
  maxOutput: 4096,
  supportsTools: true
}

function tempWorkspace(name: string): { dir: string; root: string; snapshotDir: string } {
  const dir = makeAuditDir(`r9-mech-${name}`)
  const root = join(dir, 'ws')
  const snapshotDir = join(dir, 'snapshots')
  mkdirSync(join(root, 'in'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })
  mkdirSync(snapshotDir, { recursive: true })
  return { dir, root, snapshotDir }
}

async function runScriptedAgent(
  workspace: string,
  snapshotDir: string,
  steps: ScriptStep[],
  opts: { model?: ModelInfo; permissionMode?: 'auto' | 'ask' | 'read-only'; autoCompact?: boolean; compactThreshold?: number; keepRecent?: number } = {}
): Promise<{ events: RuntimeEvent[]; result: Awaited<ReturnType<typeof runAgent>>; provider: ScriptedProvider }> {
  const events: RuntimeEvent[] = []
  const provider = new ScriptedProvider(steps, { defaultText: '完成。' })
  const result = await runAgent({
    runId: `r9mech_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: `r9mech_${Math.random().toString(36).slice(2, 8)}`,
    provider,
    model: opts.model ?? MODEL,
    systemPrompt: buildSystemPrompt({ workspace, permissionMode: opts.permissionMode ?? 'auto', mode: 'work' }),
    history: [],
    userMessage: {
      id: 'u_r9mech',
      role: 'user',
      content: [{ type: 'text', text: '执行 R9 机制探针' }],
      createdAt: Date.now()
    },
    workspace,
    permissionMode: opts.permissionMode ?? 'auto',
    snapshotDir,
    signal: new AbortController().signal,
    maxSteps: 20,
    autoCompact: opts.autoCompact ?? false,
    ...(opts.compactThreshold !== undefined ? { compactThreshold: opts.compactThreshold } : {}),
    ...(opts.keepRecent !== undefined ? { keepRecent: opts.keepRecent } : {}),
    emit: (event) => events.push(event),
    onPermission: async () => 'once',
    onAskUser: async () => ({ value: 'A', label: 'A' })
  })
  return { events, result, provider }
}

function taskBlockOf(messages: ChatMessage[]): { id: string; result?: { ok?: boolean; error?: string; output?: string }; status?: string } | null {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'task') {
        return { id: block.id, result: block.result, status: block.status }
      }
    }
  }
  return null
}

/* ── R2-A 文档写入的批准签名 ─────────────────────────────────── */

function probeR2A(): MechanismResult {
  const { dir, root } = tempWorkspace('r2a')
  const policy = (workspace: string): PermissionPolicyContext => ({
    mode: 'ask',
    workspace,
    isSubagent: false,
    isDemo: false,
    sessionGrants: new Set<string>()
  })
  const target = (toolName: string, input: Record<string, unknown>, category: PermissionTarget['category'] = 'write'): PermissionTarget => ({
    toolName,
    category,
    baseRisk: 'medium',
    input,
    title: toolName
  })
  const scenarios = [
    {
      name: 'write_xlsx',
      first: { path: 'out/approved.xlsx', sheets: [{ name: 'S', rows: [['APPROVED']] }] },
      changedPath: { path: 'out/other.xlsx', sheets: [{ name: 'S', rows: [['APPROVED']] }] },
      changedContent: { path: 'out/approved.xlsx', sheets: [{ name: 'S', rows: [['UNAPPROVED']] }] }
    },
    {
      name: 'edit_docx',
      first: { path: 'in/t.docx', output_path: 'out/approved.docx', replacements: [{ find: '{{NAME}}', replace: '甲' }] },
      changedPath: { path: 'in/t.docx', output_path: 'out/other.docx', replacements: [{ find: '{{NAME}}', replace: '甲' }] },
      changedContent: { path: 'in/t.docx', output_path: 'out/approved.docx', replacements: [{ find: '{{NAME}}', replace: '乙' }] }
    }
  ]
  const failures: string[] = []
  const details: Record<string, unknown> = {}
  for (const scenario of scenarios) {
    const ctx = policy(root)
    const first = evaluatePermission(target(scenario.name, scenario.first), ctx)
    if (first.action !== 'ask') {
      failures.push(`${scenario.name} 首次未进入审批（${first.action}）`)
      continue
    }
    ctx.sessionGrants = new Set([first.signature])
    const same = evaluatePermission(target(scenario.name, scenario.first), ctx)
    const otherPath = evaluatePermission(target(scenario.name, scenario.changedPath), ctx)
    const otherContent = evaluatePermission(target(scenario.name, scenario.changedContent), ctx)
    details[scenario.name] = {
      same: same.action,
      changedPath: otherPath.action,
      changedContent: otherContent.action,
      signature: first.signature
    }
    if (same.action !== 'allow') failures.push(`${scenario.name} 相同操作未复用批准（${same.action}）`)
    if (otherPath.action !== 'ask') failures.push(`${scenario.name} 换路径仍被自动放行（${otherPath.action}）`)
    if (otherContent.action !== 'ask') failures.push(`${scenario.name} 换内容仍被自动放行（${otherContent.action}）`)
  }
  return {
    id: 'R2-A',
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    detail: failures.length ? failures.join('；') : 'write_xlsx/edit_docx 的路径与内容变化均重新审批，相同操作可复用',
    evidence: { details, dir }
  }
}

/* ── R2-B/C 子代理终态（scripted provider） ──────────────────── */

async function probeR2B(): Promise<MechanismResult> {
  const { root, snapshotDir } = tempWorkspace('r2b')
  writeFileSync(join(root, 'in/n.txt'), '7\n', 'utf8')
  const steps: ScriptStep[] = [
    { toolCalls: [{ name: 'task', input: { description: '读取 in/n.txt', prompt: '读取 in/n.txt 并返回数值' } }] },
    { error: { message: 'synthetic_child_request_error', code: 'synthetic_child_request_error', retryable: false } }
  ]
  try {
    const { result } = await runScriptedAgent(root, snapshotDir, steps)
    const task = taskBlockOf(result.messages)
    const failed = task?.result?.ok === false
    return {
      id: 'R2-B',
      status: failed ? 'PASS' : 'FAIL',
      detail: failed ? `外层 task 失败并保留原因：${String(task?.result?.error ?? '').slice(0, 120)}` : `外层 task 仍为 ok=${String(task?.result?.ok)}（应 false）`,
      evidence: { task }
    }
  } catch (err) {
    return { id: 'R2-B', status: 'FAIL', detail: `探针异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

async function probeR2C(): Promise<MechanismResult> {
  const { root, snapshotDir } = tempWorkspace('r2c')
  writeFileSync(join(root, 'in/n.txt'), '7\n', 'utf8')
  const steps: ScriptStep[] = [
    { toolCalls: [{ name: 'task', input: { description: '读取 n.txt', prompt: '读取 in/n.txt 并返回数值' } }] },
    ...Array.from({ length: 14 }, () => ({ toolCalls: [{ name: 'read_file', input: { path: 'in/n.txt' } }] }))
  ]
  try {
    const { result, events } = await runScriptedAgent(root, snapshotDir, steps)
    const task = taskBlockOf(result.messages)
    const childSteps = events.filter((event) => event.type === 'tool_started').length
    const failed = task?.result?.ok === false
    return {
      id: 'R2-C',
      status: failed ? 'PASS' : 'FAIL',
      detail: failed
        ? `子代理 12 步耗尽后外层 task 失败（实际工具步 ${childSteps}）：${String(task?.result?.error ?? '').slice(0, 100)}`
        : `12 步耗尽后外层 task 仍 ok=${String(task?.result?.ok)}（应失败/耗尽）`,
      evidence: { task, childSteps }
    }
  } catch (err) {
    return { id: 'R2-C', status: 'FAIL', detail: `探针异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

/* ── Goal 机制探针公共工具（本地 mock SSE + AgentService） ───── */

interface GoalProbeOptions {
  name: string
  handler: (body: Record<string, unknown>) => MockReply
  objective: string
  maxRounds?: number
  maxToolCalls?: number
  maxNoProgressRounds?: number
  stopWhen?: (goal: Goal | null) => boolean
  maxWaitMs?: number
  beforeStart?: (context: { root: string; dataDir: string; mockStateDir: string; env: NodeJS.ProcessEnv }) => void
}

interface GoalProbeResult {
  goal: Goal | null
  /** 探针主动暂停前的快照（用于判断产品是否已主动停止） */
  statusBeforePause: string
  toolCallsBeforePause?: number
  noProgressBeforePause?: number
  roundBeforePause?: number
  events: RuntimeEvent[]
  requests: number
  messages: ChatMessage[]
  dir: string
  server: MockSseServer
  cleanup: () => Promise<void>
}

async function runGoalProbe(options: GoalProbeOptions): Promise<GoalProbeResult> {
  const dir = makeAuditDir(`r9-mech-${options.name}`)
  const root = join(dir, 'ws')
  const dataDir = join(dir, 'data')
  const mockStateDir = join(dir, 'mock-state')
  mkdirSync(join(root, 'in'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })
  mkdirSync(mockStateDir, { recursive: true })
  if (options.beforeStart) options.beforeStart({ root, dataDir, mockStateDir, env: process.env })
  const server = await startMockSseServer(options.handler)
  const provider = auditProviderConfig(server.baseUrl)
  const stores = createAuditStores(dataDir, provider)
  const events: RuntimeEvent[] = []
  let serviceRef: typeof stores.service | null = null
  const customWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, event: RuntimeEvent) => {
        if (channel !== 'morrow:event') return
        events.push(event)
        if (event.type === 'permission_requested') {
          const request = event.request
          const allow =
            request.toolName === 'mcp_call' && String((request.input as Record<string, unknown>).server ?? '') === 'morrow_mock'
          setTimeout(() => {
            try {
              serviceRef?.respondPermission(request.id, allow ? 'once' : 'deny')
            } catch {
              // ignore
            }
          }, 0)
        }
        if (event.type === 'question_asked') {
          setTimeout(() => {
            try {
              serviceRef?.respondQuestion(event.request.id, { value: 'A', label: 'A' })
            } catch {
              // ignore
            }
          }, 0)
        }
      }
    }
  }
  const session = stores.sessionStore.create({
    workspace: root,
    model: { providerId: provider.id, modelId: AUDIT_MODEL_ID },
    permissionMode: 'auto',
    defaultModel: { providerId: provider.id, modelId: AUDIT_MODEL_ID },
    defaultPermission: 'auto',
    title: `R9-${options.name}`
  })
  serviceRef = stores.service
  await stores.service.startGoal(session.id, options.objective, options.maxRounds ?? 5, customWindow as never, {
    maxToolCalls: options.maxToolCalls ?? 10,
    maxActiveMs: 5 * 60_000,
    maxNoProgressRounds: options.maxNoProgressRounds ?? 2
  })
  const started = Date.now()
  while (Date.now() - started < (options.maxWaitMs ?? 60_000)) {
    const goal = stores.sessionStore.get(session.id)?.goal ?? null
    if (options.stopWhen ? options.stopWhen(goal) : goal?.status === 'paused' || goal?.status === 'completed' || goal?.status === 'blocked' || goal?.status === 'cancelled') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // 主动暂停仍在 active 的目标，避免探针继续消耗（本地 mock 无费用，但保持干净）
  const latest = stores.sessionStore.get(session.id)
  const goalBeforePause = latest?.goal ?? null
  const statusBeforePause = String(goalBeforePause?.status ?? 'none')
  if (latest?.goal?.status === 'active') {
    try {
      stores.service.pauseGoal(session.id, customWindow as never)
    } catch {
      // ignore
    }
  }
  await waitFor(() => !stores.service.isSessionRunning(session.id), 15_000).catch(() => undefined)
  const goal = stores.sessionStore.get(session.id)?.goal ?? null
  const messages = stores.sessionStore.get(session.id)?.messages ?? []
  return {
    goal,
    statusBeforePause,
    toolCallsBeforePause: goalBeforePause?.toolCalls,
    noProgressBeforePause: goalBeforePause?.noProgressRounds,
    roundBeforePause: goalBeforePause?.round,
    events,
    requests: server.requests,
    messages,
    dir,
    server,
    cleanup: async () => {
      stores.service.dispose()
      await server.close()
    }
  }
}

function goalHandler(replyForRound: (round: number, body: Record<string, unknown>, secondTurn: boolean) => MockReply) {
  return (body: Record<string, unknown>): MockReply => {
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown; tool_calls?: unknown }>
    let round = 1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'user') continue
      const text =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => (part as { text?: string }).text ?? '').join('')
            : ''
      const match = /第\s*(\d+)\s*\/\s*(\d+)\s*轮续跑/.exec(text)
      if (match) {
        round = Number(match[1])
        break
      }
      if (text.includes('开始执行目标')) {
        round = 1
        break
      }
    }
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user')
    const hasToolUseAfterLastUser = messages
      .slice(lastUserIndex + 1)
      .some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    return replyForRound(round, body, hasToolUseAfterLastUser)
  }
}

/* ── R2-D Goal 工具预算不重复记账 ───────────────────────────── */

async function probeR2D(): Promise<MechanismResult> {
  const h = await runGoalProbe({
    name: 'r2d',
    objective: '读取 in/a.txt 与 in/b.txt 并核验；最多 3 次工具调用。',
    maxRounds: 4,
    maxToolCalls: 3,
    maxNoProgressRounds: 4,
    handler: goalHandler((round, _body, secondTurn) =>
      secondTurn || round >= 2
        ? { text: `第 ${round} 轮完成。` }
        : { toolCalls: [{ name: 'read_file', input: { path: 'in/a.txt' } }, { name: 'read_file', input: { path: 'in/b.txt' } }] }
    ),
    beforeStart: ({ root }) => {
      writeFileSync(join(root, 'in/a.txt'), '1\n', 'utf8')
      writeFileSync(join(root, 'in/b.txt'), '2\n', 'utf8')
    },
    stopWhen: (goal) => Boolean(goal && goal.round >= 2),
    maxWaitMs: 20_000
  })
  const goal = h.goal
  const ok = h.toolCallsBeforePause === 2 && h.statusBeforePause === 'active'
  await h.cleanup()
  return {
    id: 'R2-D',
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? '第一轮两次真实 read_file 累计为 2，未因重复记账误触 3 次预算'
      : `期望暂停前 toolCalls=2 且 active；实际 toolCalls=${String(h.toolCallsBeforePause)}、status=${String(h.statusBeforePause)}、stopReason=${String(goal?.stopReason)}`,
    evidence: { goal, requests: h.requests, dir: h.dir }
  }
}

/* ── R2-E evidence=["."] 拒收 ───────────────────────────────── */

async function probeR2E(): Promise<MechanismResult> {
  const h = await runGoalProbe({
    name: 'r2e',
    objective: '生成 out/report.txt 且内容必须为 verified report 53；目录存在不能替代报告。',
    maxRounds: 3,
    maxToolCalls: 6,
    maxNoProgressRounds: 3,
    handler: goalHandler((round, _body, secondTurn) =>
      secondTurn
        ? { text: `第 ${round} 轮完成。` }
        : { toolCalls: [{ name: 'update_goal', input: { status: 'completed', summary: '目录存在所以完成', evidence: ['.'] } }] }
    ),
    stopWhen: (goal) => Boolean(goal && goal.round >= 2),
    maxWaitMs: 20_000
  })
  const goal = h.goal
  const updateGoalErrors = h.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === 'tool_use' && block.name === 'update_goal')
    .map((block) => (block.type === 'tool_use' ? block.result : undefined))
  const rejected = updateGoalErrors.every((result) => result?.ok === false)
  const ok = rejected && goal?.status !== 'completed' && !goal?.completedAt && updateGoalErrors.length > 0
  await h.cleanup()
  return {
    id: 'R2-E',
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `evidence=["."] 被拒绝（${updateGoalErrors[0]?.error ?? ''}），Goal 未被标记完成`
      : `evidence=["."] 未被正确拒绝或 Goal 被完成：goal=${String(goal?.status)}、errors=${JSON.stringify(updateGoalErrors.map((result) => result?.error))}`,
    evidence: { goal, updateGoalErrors }
  }
}

/* ── R2-F 空操作不能刷新无进展 ─────────────────────────────── */

async function probeR2F(): Promise<MechanismResult> {
  const cases: Array<{ name: string; setup?: (root: string) => void; tool: Record<string, unknown> }> = [
    { name: 'empty-command', tool: { name: 'run_command', input: { command: 'cmd /c exit 0' } } },
    { name: 'repeat-checkpoint', setup: (root) => writeFileSync(join(root, 'out/checkpoint.json'), '{"completed":[]}\n', 'utf8'), tool: { name: 'write_file', input: { path: 'out/checkpoint.json', content: '{"completed":[]}\n' } } },
    { name: 'old-file-read', setup: (root) => writeFileSync(join(root, 'in/old.txt'), 'old\n', 'utf8'), tool: { name: 'read_file', input: { path: 'in/old.txt' } } }
  ]
  const results: Array<{ name: string; status: string; goal?: Goal | null }> = []
  for (const item of cases) {
    const h = await runGoalProbe({
      name: `r2f-${item.name}`,
      objective: `只有新增且核实的实际结果算进展（${item.name}）。`,
      maxRounds: 5,
      maxToolCalls: 20,
      maxNoProgressRounds: 2,
      handler: goalHandler((round, _body, secondTurn) => (secondTurn ? { text: `第 ${round} 轮完成。` } : { toolCalls: [item.tool] })),
      beforeStart: ({ root }) => item.setup?.(root),
      maxWaitMs: 30_000
    })
    results.push({ name: item.name, status: String(h.goal?.status), goal: h.goal })
    await h.cleanup()
  }
  const failed = results.filter((item) => item.goal?.status !== 'paused' || item.goal?.stopReason !== 'no_progress')
  return {
    id: 'R2-F',
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    detail:
      failed.length === 0
        ? '空命令/重复 checkpoint/旧文件读取三种场景均连续 2 轮无进展后由产品预算停止（no_progress）'
        : failed.map((item) => `${item.name}: status=${String(item.goal?.status)} stopReason=${String(item.goal?.stopReason)} noProgress=${String(item.goal?.noProgressRounds)}`).join('；'),
    evidence: { results: results.map((item) => ({ name: item.name, status: item.goal?.status, stopReason: item.goal?.stopReason, noProgressRounds: item.goal?.noProgressRounds })) }
  }
}

/* ── R2-G 新文档/MCP 成果不能漏算 ─────────────────────────── */

async function probeR2G(): Promise<MechanismResult> {
  const docsFixture = join(PROJECT_ROOT, 'tests', 'unit', 'core', 'fixtures', 'documents', 'template.docx')
  const cases: Array<{ name: string; toolForRound: (round: number, root: string) => Array<Record<string, unknown>>; setup?: (root: string) => void }> = [
    {
      name: 'xlsx',
      toolForRound: (round) => [
        {
          name: 'write_xlsx',
          input: { path: `out/new-${round}.xlsx`, sheets: [{ name: 'S', rows: [['item', round]] }] }
        }
      ]
    },
    {
      name: 'docx',
      setup: (root) => {
        if (existsSync(docsFixture)) {
          mkdirSync(join(root, 'in'), { recursive: true })
          writeFileSync(join(root, 'in/template.docx'), readFileSync(docsFixture))
        }
      },
      toolForRound: (round) => [
        {
          name: 'edit_docx',
          input: {
            path: 'in/template.docx',
            output_path: `out/new-${round}.docx`,
            replacements: [{ find: '{{NAME}}', replace: `名字${round}` }]
          }
        }
      ]
    },
    {
      name: 'mcp',
      setup: () => undefined,
      toolForRound: (round) => [
        {
          name: 'mcp_call',
          input: {
            server: 'morrow_mock',
            tool: 'child47_register',
            arguments: { id: round === 1 ? 'A' : 'B', key: round === 1 ? 'case47-A' : 'case47-B' }
          }
        }
      ]
    }
  ]
  const results: Array<{ name: string; status: string; noProgress?: number; round?: number; requests?: number; progressKeys?: string[] }> = []
  for (const item of cases) {
    const mockStateDir = makeAuditDir(`r9-mech-r2g-${item.name}-mock`)
    const configPath = join(mockStateDir, 'mcp.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          morrow_mock: {
            command: process.execPath,
            args: [join(PROJECT_ROOT, 'tests', 'audit', 'r8', 'mocks', 'morrow-mock-mcp.mjs')],
            env: { MORROW_MOCK_STATE_DIR: mockStateDir },
            timeoutMs: 30_000
          }
        }
      }),
      'utf8'
    )
    process.env.MORROW_MCP_CONFIG = configPath
    process.env.MORROW_DATA_DIR = mockStateDir
    const h = await runGoalProbe({
      name: `r2g-${item.name}`,
      objective: `完成清单三项；每份新产物或真实登记核实后才算进展（${item.name}）。`,
      maxRounds: 5,
      maxToolCalls: 20,
      maxNoProgressRounds: 2,
      handler: goalHandler((round, _body, secondTurn) => (secondTurn ? { text: `第 ${round} 轮完成，还剩第 3 项。` } : { toolCalls: item.toolForRound(round, '') })),
      beforeStart: ({ root }) => item.setup?.(root),
      stopWhen: (goal) => Boolean(goal && goal.round >= 3),
      maxWaitMs: 40_000
    })
    results.push({
      name: item.name,
      status: h.statusBeforePause,
      noProgress: h.noProgressBeforePause,
      round: h.roundBeforePause,
      requests: h.requests,
      progressKeys: (h.goal?.progressKeys as string[] | undefined) ?? []
    })
    await h.cleanup()
    delete process.env.MORROW_MCP_CONFIG
  }
  // R2-G 判定：前两轮真实新成果必须被记账（progressKeys≥2）、第三项未完成（round≥3 且仍 active）；
  // 第三轮重复登记/查询本身不应算新进展（noProgress 可能为 1，但不得在第二轮就停）。
  const failed = results.filter((item) => item.status !== 'active' || (item.progressKeys?.length ?? 0) < 2 || (item.round ?? 0) < 3)
  return {
    id: 'R2-G',
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    detail:
      failed.length === 0
        ? '前两轮真实新成果（新 XLSX / 新 DOCX / 两条 MCP 登记）均被记账，第三项保留且未误触无进展停止'
        : failed.map((item) => `${item.name}: status=${item.status} progressKeys=${String(item.progressKeys?.length)} round=${String(item.round)} noProgress=${String(item.noProgress)}`).join('；'),
    evidence: { results }
  }
}

/* ── R2-H 单用户长工具链压缩 ────────────────────────────────── */

async function probeR2H(): Promise<MechanismResult> {
  const { root, snapshotDir } = tempWorkspace('r2h')
  const padding = '这是用于上下文压缩机制测试的长文本。'.repeat(4500)
  const files = ['in/chunk1.txt', 'in/chunk2.txt', 'in/chunk3.txt']
  for (const [index, file] of files.entries()) {
    mkdirSync(join(root, 'in'), { recursive: true })
    writeFileSync(join(root, file), `value=${[4, 7, 9][index]}\n${padding}\n`, 'utf8')
  }
  const readSteps: ScriptStep[] = []
  for (let index = 0; index < 6; index += 1) {
    const file = files[index % files.length]
    readSteps.push({ toolCalls: [{ name: 'read_file', input: { path: file } }] })
  }
  const steps: ScriptStep[] = [...readSteps, { text: '逐段读取完成；value 合计 20。' }]
  try {
    const { events, result } = await runScriptedAgent(root, snapshotDir, steps, {
      model: { id: 'audit-r9-compact', label: 'R9 compact', contextWindow: 8192, maxOutput: 2048, supportsTools: true },
      autoCompact: true,
      compactThreshold: 0.3,
      keepRecent: 2
    })
    const compaction = events.filter((event) => event.type === 'compaction')
    const started = compaction.some((event) => event.type === 'compaction' && event.phase === 'started')
    const finished = compaction.some((event) => event.type === 'compaction' && event.phase === 'finished')
    const ok = started && finished
    return {
      id: 'R2-H',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `单用户长工具链触发原生压缩（started/finished），run reason=${result.reason}`
        : `未触发原生压缩（compaction 事件 ${compaction.length} 个；单用户工具链安全切点修复未生效）`,
      evidence: { compactionEvents: compaction.length, runReason: result.reason }
    }
  } catch (err) {
    return { id: 'R2-H', status: 'FAIL', detail: `探针异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

/* ── 汇总入口 ────────────────────────────────────────────────── */

export async function runMechanismProbes(): Promise<MechanismResult[]> {
  const results: MechanismResult[] = []
  const wrappers: Array<[() => MechanismResult | Promise<MechanismResult>]> = [
    [() => probeR2A()],
    [() => probeR2B()],
    [() => probeR2C()],
    [() => probeR2D()],
    [() => probeR2E()],
    [() => probeR2F()],
    [() => probeR2G()],
    [() => probeR2H()]
  ]
  for (const [probe] of wrappers) {
    try {
      results.push(await probe())
    } catch (err) {
      results.push({ id: `R2-${String.fromCharCode(65 + results.length)}`, status: 'FAIL', detail: `探针异常：${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return results
}

export { QUESTIONS as R9_QUESTIONS } from './specs'
export type { R9QuestionSpec }
