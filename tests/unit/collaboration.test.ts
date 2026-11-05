// 协作/Super-Agent 核心用例：由 collaboration-*、super-agent 测试扁平合并。
import { describe, expect, it, vi } from 'vitest'
import { join, basename } from 'node:path'
import { executeTool, superRouterToolDefinitions, toolDefinitionsForRun } from '../../src/core/tools'
import { artifactDependencyReady, latestReadyArtifact, publishArtifactVersion, recordArtifactUsage, revokeArtifactVersion, compilePlan, PlanCompileError, buildTraceEntries, traceUsageOf, formatArtifactHandoff, verificationFailureText, isSafeVerificationCommand, type PlanTaskInput } from '../../src/core/collaboration'
import { superProgressOf, type CollaborationArtifact, type CollaborationArtifactUsage, type SuperAgentState, type SuperTask, type SwarmOperation, type CollaborationVerification, type ChatMessage, type ModelInfo, type RuntimeEvent, type ToolUseBlock } from '../../src/shared/types'
import type { CollaborationArtifactOutcome, CollaborationArtifactPort, CollaborationArtifactPublishInput, CollaborationArtifactReadResult, SwarmMemberRequest, SwarmMemberResult, WorkerSlotLease, WorkerSlotPort, CollaborationRuntimePort, ToolContext, CollaborationTaskControl, RuntimeEventPayload, Provider, ProviderStreamEvent, ProviderStreamRequest } from '../../src/core/types'
import { BUILTIN_AGENT_ROLES, runAgent } from '../../src/core/agent'
import { makeTempWorkspace, makeToolContext, makeTempDir } from './helpers'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { collaborationAttemptId, collaborationProjectId } from '../../src/shared/contracts'
import { WorkspaceIsolationService } from '../../src/main/workspace-isolation'
import { StuckTracker } from '../../src/core/collaboration'
import { CollaborationTraceService, getCollaborationRuntime, CollaborationVerificationService } from '../../src/main/collaboration'

describe('collaboration-artifact', () => {
const PROJECT_ID = 'project_artifact_test'

function makeTask(overrides: Partial<SuperTask> & Pick<SuperTask, 'id' | 'taskId' | 'title'>): SuperTask {
  return {
    index: 0,
    prompt: overrides.title,
    deliverable: `${overrides.title}成果`,
    files: [],
    needs: [],
    role: 'general',
    status: 'completed',
    dependsOn: [],
    attempts: 1,
    currentAttemptId: `attempt_${(overrides.taskId ?? overrides.id).slice(-6)}_a1`,
    ...overrides
  }
}

function baseState(tasks: SuperTask[]): SuperAgentState {
  return {
    runId: 'super_artifact_unit',
    projectId: PROJECT_ID,
    goal: '登录功能',
    status: 'running',
    tasks,
    createdAt: 1,
    updatedAt: 1
  }
}

function artifact(overrides: Partial<CollaborationArtifact> & Pick<CollaborationArtifact, 'name' | 'version'>): CollaborationArtifact {
  return {
    id: `artifact_${overrides.name}_${overrides.version}`,
    projectId: PROJECT_ID,
    path: `docs/${overrides.name}.md`,
    status: 'ready',
    hash: `hash_${overrides.version}`,
    size: 10,
    snapshotPath: `C:/snap/${overrides.name}/v${overrides.version}.md`,
    publishedAt: overrides.version,
    taskId: 'task_service',
    ...overrides
  }
}

function fullState(): SuperAgentState {
  const service = makeTask({ id: 'service', taskId: 'task_service', title: '登录服务' })
  const page = makeTask({
    id: 'page',
    taskId: 'task_page',
    title: '登录页面',
    dependsOn: ['service'],
    needs: [{ taskId: 'service', result: '登录接口说明', artifact: '登录接口说明' }]
  })
  const test = makeTask({
    id: 'test',
    taskId: 'task_test',
    title: '登录测试',
    dependsOn: ['service'],
    needs: [{ taskId: 'service', result: '登录接口说明', artifact: '登录接口说明' }]
  })
  const docs = makeTask({ id: 'docs', taskId: 'task_docs', title: '使用说明' })
  return baseState([service, page, test, docs])
}

describe('collaboration-artifact.test.ts', () => {
  it('@core:swarm 成果按版本交接：草稿不生效，第 2 版只让旧版使用者重测，撤回后恢复', () => {
    let state = fullState()
    const v1 = artifact({ name: '登录接口说明', version: 1, summary: '第 1 版接口' })
    state = publishArtifactVersion(state, v1).state
    expect(latestReadyArtifact(state.artifacts, '登录接口说明')?.version).toBe(1)

    const page = state.tasks.find((task) => task.id === 'page')!
    const test = state.tasks.find((task) => task.id === 'test')!
    state = recordArtifactUsage(state, {
      artifactId: v1.id,
      name: v1.name,
      version: 1,
      taskId: 'task_page',
      attemptId: page.currentAttemptId!,
      at: 10
    }).state
    state = recordArtifactUsage(state, {
      artifactId: v1.id,
      name: v1.name,
      version: 1,
      taskId: 'task_test',
      attemptId: test.currentAttemptId!,
      at: 11
    }).state

    // 草稿不是可用版本：不会让任何任务变成“需重测”。
    const draft = publishArtifactVersion(state, artifact({ name: '登录接口说明', version: 2, status: 'draft' }))
    state = draft.state
    expect(draft.staleTaskIds).toEqual([])
    expect(latestReadyArtifact(state.artifacts, '登录接口说明')?.version).toBe(1)
    expect(state.tasks.find((task) => task.id === 'test')?.needsRetest).toBeFalsy()

    // 下一版可用：只有实际使用 v1 的页面/测试需要重测，无关说明任务不受影响。
    const v3 = publishArtifactVersion(state, artifact({ name: '登录接口说明', version: 3, summary: '签名有变' }))
    state = v3.state
    expect(v3.staleTaskIds.sort()).toEqual(['task_page', 'task_test'])
    const pageAfter = state.tasks.find((task) => task.id === 'page')!
    const testAfter = state.tasks.find((task) => task.id === 'test')!
    expect(pageAfter.needsRetest).toBe(true)
    expect(testAfter.staleArtifacts?.[0]).toContain('v1 → 最新 v3')
    expect(state.tasks.find((task) => task.id === 'docs')?.needsRetest).toBeFalsy()
    expect(superProgressOf(state)).toMatchObject({ total: 4, completed: 2, retest: 2 })

    // 撤回有误的新版本：v1 恢复为当前可用，任务不再需要因这一版重测。
    const revoked = revokeArtifactVersion(state, { name: '登录接口说明', version: 3, reason: '签名写错' })
    state = revoked.state
    expect(revoked.artifact.status).toBe('revoked')
    expect(revoked.restoredTaskIds.sort()).toEqual(['task_page', 'task_test'])
    expect(state.tasks.find((task) => task.id === 'test')?.needsRetest).toBeFalsy()
    expect(latestReadyArtifact(state.artifacts, '登录接口说明')?.version).toBe(1)

    // 重新发布下一版并使用，任务恢复为当前版本。
    const v4 = publishArtifactVersion(state, artifact({ name: '登录接口说明', version: 4 }))
    state = v4.state
    const retested = recordArtifactUsage(state, {
      artifactId: state.artifacts!.find((item) => item.version === 4)!.id,
      name: '登录接口说明',
      version: 4,
      taskId: 'task_test',
      attemptId: testAfter.currentAttemptId!
    }).state
    expect(retested.tasks.find((task) => task.id === 'test')?.needsRetest).toBeFalsy()
    expect(retested.tasks.find((task) => task.id === 'page')?.needsRetest).toBe(true)

    // 撤回已经被人使用过的版本：使用者必须重测，使用记录保留。
    const revokedUsed = revokeArtifactVersion(retested, { name: '登录接口说明', version: 4, reason: '第 4 版有误' })
    const testAfterRevoke = revokedUsed.state.tasks.find((task) => task.id === 'test')!
    expect(testAfterRevoke.needsRetest).toBe(true)
    expect(testAfterRevoke.staleArtifacts?.[0]).toContain('已撤回')
    expect(testAfterRevoke.artifactUsage?.some((usage) => usage.version === 4)).toBe(true)
  })

  it('@core:swarm 依赖成果可由发布者提前解锁，版本与发布者不匹配时不放行', () => {
    const state = fullState()
    const page = state.tasks.find((task) => task.id === 'page')!
    const service = state.tasks.find((task) => task.id === 'service')!
    const v1 = artifact({ name: '登录接口说明', version: 1 })
    expect(artifactDependencyReady(page, service, [v1]).ready).toBe(true)
    expect(artifactDependencyReady(page, service, [{ ...v1, status: 'draft' }]).ready).toBe(false)
    expect(artifactDependencyReady(page, service, [{ ...v1, taskId: 'task_docs' }]).ready).toBe(false)
    const high = { ...page, needs: [{ ...page.needs![0], artifactVersion: 2 }] }
    expect(artifactDependencyReady(high, service, [v1]).ready).toBe(false)
    expect(artifactDependencyReady(high, service, [v1, artifact({ name: '登录接口说明', version: 2 })]).ready).toBe(true)
  })

  it('@core:swarm 发布者继续工作时页面和测试已读取同一版可用成果；第 2 版只让使用者重测', async () => {
    const ws = makeTempWorkspace()
    const fake = new FakeArtifacts()
    const contexts = new Map<string, string>()
    const startedWhileServiceRunning = new Map<string, boolean>()
    const pageStarted = deferred()
    const testStarted = deferred()
    let serviceRunning = false
    const runner = async (request: SwarmMemberRequest): Promise<SwarmMemberResult> => {
      if (request.description === '登录服务') {
        serviceRunning = true
        await fake.publish({
          projectId: PROJECT_ID,
          taskId: request.taskId!,
          attemptId: request.attemptId!,
          name: '登录接口说明',
          path: 'docs/login-api.md',
          workspace: ws.root,
          status: 'ready',
          summary: '第 1 版接口'
        })
        await withTimeout(Promise.all([pageStarted.promise, testStarted.promise]), 4_000)
        await fake.publish({
          projectId: PROJECT_ID,
          taskId: request.taskId!,
          attemptId: request.attemptId!,
          name: '登录接口说明',
          path: 'docs/login-api.md',
          workspace: ws.root,
          status: 'ready',
          summary: '签名有变'
        })
        serviceRunning = false
        return completed('登录服务')
      }
      if (request.description === '登录页面' || request.description === '登录测试') {
        const key = request.description === '登录页面' ? 'page' : 'test'
        contexts.set(key, request.context ?? '')
        startedWhileServiceRunning.set(key, serviceRunning)
        if (key === 'page') pageStarted.resolve()
        else testStarted.resolve()
        return completed(request.description)
      }
      return completed(request.description)
    }
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      collaborationArtifacts: fake,
      runSwarmMember: runner
    })
    const result = await executeTool(
      'swarm',
      {
        goal: '实现登录功能',
        max_parallel: 4,
        tasks: [
          { id: 'service', title: '登录服务', prompt: '写接口说明并继续实现', deliverable: '登录 API 与接口说明', files: [] },
          {
            id: 'page',
            title: '登录页面',
            prompt: '按接口说明实现页面',
            deliverable: '登录页',
            files: [],
            depends_on: ['service'],
            needs: [{ task_id: 'service', result: '登录接口说明', artifact: '登录接口说明' }]
          },
          {
            id: 'test',
            title: '登录测试',
            prompt: '按接口说明写测试',
            deliverable: '登录测试通过',
            files: [],
            depends_on: ['service'],
            needs: [{ task_id: 'service', result: '登录接口说明', artifact: '登录接口说明' }]
          },
          { id: 'docs', title: '使用说明', prompt: '写使用说明', deliverable: '使用说明', files: [] }
        ]
      },
      ctx
    )

    expect(contexts.get('page')).toContain('登录接口说明 v1')
    expect(contexts.get('test')).toContain('登录接口说明 v1')
    expect(contexts.get('page')).toContain('第 1 版接口')
    expect(startedWhileServiceRunning.get('page')).toBe(true)
    expect(startedWhileServiceRunning.get('test')).toBe(true)

    const state = (result.meta?.superAgent as SuperAgentState) ?? null
    expect(state).not.toBeNull()
    const page = state!.tasks.find((task) => task.id === 'page')!
    const test = state!.tasks.find((task) => task.id === 'test')!
    const docs = state!.tasks.find((task) => task.id === 'docs')!
    expect(page.needsRetest).toBe(true)
    expect(test.needsRetest).toBe(true)
    expect(page.staleArtifacts?.[0]).toContain('v1 → 最新 v2')
    expect(docs.needsRetest).toBeFalsy()
    expect(state!.status).toBe('partial')
    expect(superProgressOf(state)).toMatchObject({ completed: 2, retest: 2 })

    // 只重测测试项：沿用原 taskId，读取最新 v2，完成后不再需要重测；页面不被重跑。
    fake.contents.set(2, '第 2 版接口：签名有变')
    const retryTask = test
    const retryCtx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      collaborationArtifacts: fake,
      resumeSwarmTask: {
        projectId: PROJECT_ID,
        runId: state!.runId,
        goal: state!.goal,
        task: retryTask
      },
      runSwarmMember: async (request) => {
        expect(request.description).toBe('登录测试')
        expect(request.context).toContain('登录接口说明 v2')
        return completed('登录测试重测通过')
      }
    })
    const retryResult = await executeTool(
      'swarm',
      {
        goal: state!.goal,
        tasks: [
          {
            id: retryTask.id,
            title: retryTask.title,
            prompt: retryTask.prompt,
            deliverable: retryTask.deliverable!
          }
        ],
        max_parallel: 1
      },
      retryCtx
    )
    const retried = ((retryResult.meta?.superAgent as SuperAgentState) ?? null)?.tasks[0]
    expect(retried?.needsRetest).toBeFalsy()
    expect(retried?.artifactUsage?.at(-1)?.version).toBe(2)
    expect(retried?.attempts).toBe(2)

    ws.cleanup()
  })
})

/* ── 测试替身 ─────────────────────────────────────────────── */

class FakeArtifacts implements CollaborationArtifactPort {
  artifacts: CollaborationArtifact[] = []
  contents = new Map<number, string>([[1, '第 1 版接口内容']])
  state: SuperAgentState = {
    runId: 'fake',
    goal: 'fake',
    status: 'running',
    tasks: [],
    createdAt: 1,
    updatedAt: 1
  }

  list(_projectId: string, name?: string): CollaborationArtifact[] {
    return this.artifacts.filter((artifact) => !name || artifact.name === name)
  }

  async publish(input: CollaborationArtifactPublishInput): Promise<CollaborationArtifactOutcome> {
    const versions = this.artifacts.filter((artifact) => artifact.name === input.name)
    const version = input.version ?? Math.max(0, ...versions.map((artifact) => artifact.version)) + 1
    const artifact: CollaborationArtifact = {
      id: `fake_${input.name}_${version}`,
      projectId: input.projectId,
      name: input.name,
      version,
      path: input.path,
      status: input.status,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      hash: `hash_${version}`,
      size: 10,
      snapshotPath: join('fake', input.name, `v${version}`),
      publishedAt: Date.now() + version
    }
    this.artifacts.push(artifact)
    const result = publishArtifactVersion(this.state, artifact)
    this.state = result.state
    return {
      state: result.state,
      artifact,
      staleTaskIds: result.staleTaskIds,
      restoredTaskIds: result.restoredTaskIds
    }
  }

  async read(input: {
    projectId: string
    taskId?: string
    attemptId?: string
    name: string
    version?: number
  }): Promise<CollaborationArtifactReadResult> {
    const artifact =
      input.version !== undefined
        ? this.artifacts.find((entry) => entry.name === input.name && entry.version === input.version)
        : latestReadyArtifact(this.artifacts, input.name)
    if (!artifact || artifact.status !== 'ready') throw new Error('没有可用成果')
    const content = this.contents.get(artifact.version) ?? `v${artifact.version} 内容`
    const usage: CollaborationArtifactUsage | undefined =
      input.taskId && input.attemptId
        ? {
            id: `usage_${artifact.id}_${input.attemptId}`,
            artifactId: artifact.id,
            name: artifact.name,
            version: artifact.version,
            taskId: input.taskId,
            attemptId: input.attemptId,
            readAt: Date.now(),
            status: 'current'
          }
        : undefined
    return { state: this.state, artifact, content, ...(usage ? { usage } : {}) }
  }

  async revoke(input: {
    projectId: string
    name: string
    version: number
    reason?: string
  }): Promise<CollaborationArtifactOutcome> {
    const result = revokeArtifactVersion(this.state, input)
    this.state = result.state
    this.artifacts = this.state.artifacts ?? this.artifacts
    return {
      state: result.state,
      artifact: result.artifact,
      staleTaskIds: result.staleTaskIds,
      restoredTaskIds: result.restoredTaskIds
    }
  }
}

function completed(title: string): SwarmMemberResult {
  return {
    status: 'completed',
    summary: `${title}已完成`,
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ])
}
})

describe('collaboration-limits', () => {
function completed(title: string): SwarmMemberResult {
  return {
    status: 'completed',
    summary: `${title}已完成`,
    steps: 1,
    usage: { inputTokens: 100, outputTokens: 20 }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeSlots implements WorkerSlotPort {
  active = 0
  peak = 0
  waiting = 0

  constructor(private readonly limit: number) {}

  async acquire(input: { ownerId: string; signal?: AbortSignal }): Promise<WorkerSlotLease | null> {
    if (input.signal?.aborted) return null
    this.waiting += 1
    while (this.active >= this.limit) {
      if (input.signal?.aborted) {
        this.waiting -= 1
        return null
      }
      await sleep(5)
    }
    this.waiting -= 1
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
      }
    }
  }

  snapshot(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiting, limit: this.limit }
  }
}

function toolTasks(count = 4): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    title: `成员 ${String.fromCharCode(65 + index)}`,
    prompt: `完成任务 ${index + 1}`,
    deliverable: `结果 ${index + 1}`,
    files: []
  }))
}

async function runWithLimit(limit: number, budget = 0, delayMs = 120) {
  const ws = makeTempWorkspace()
  const slots = new FakeSlots(limit)
  const runner = async (request: { description: string }): Promise<SwarmMemberResult> => {
    await sleep(delayMs)
    return completed(request.description)
  }
  const ctx = makeToolContext(ws, {
    superMode: true,
    permissionMode: 'auto',
    agents: BUILTIN_AGENT_ROLES,
    workerSlots: slots,
    collaborationLimits: { maxWorkers: limit, hostLimit: 8, auto: false, tokenBudget: budget },
    runSwarmMember: runner
  })
  const startedAt = Date.now()
  try {
    const result = await executeTool(
      'swarm',
      { goal: `并发 ${limit}`, max_parallel: 4, watchdog_ms: 0, tasks: toolTasks() },
      ctx
    )
    const state = (result.meta as { superAgent: SuperAgentState }).superAgent
    return {
      result,
      state,
      wallMs: Date.now() - startedAt,
      peak: slots.peak,
      activeAfter: slots.active,
      ws
    }
  } catch (err) {
    ws.cleanup()
    throw err
  }
}

describe('collaboration-limits.test.ts', () => {
  it('@core:swarm 1/2/4 人并发对照：并发不超上限，用量按任务累计', async () => {
    const runs: Array<{
      limit: number
      wallMs: number
      peak: number
      usageTokens: number
      tasks: Array<{ title: string; waitMs: number; usageTokens: number }>
    }> = []
    try {
      for (const limit of [1, 2, 4]) {
        const { result, state, wallMs, peak, activeAfter, ws } = await runWithLimit(limit)
        try {
          expect(result.ok, result.error).toBe(true)
          expect(activeAfter).toBe(0)
          expect(peak).toBeLessThanOrEqual(limit)
          expect(state.status).toBe('completed')
          expect(state.usage?.totalTokens).toBe(480)
          expect(state.usage?.acceptedTasks).toBe(4)
          expect(state.usage?.overBudget).toBe(false)
          expect(state.tasks.every((task) => task.usage?.totalTokens === 120)).toBe(true)
          runs.push({
            limit,
            wallMs,
            peak,
            usageTokens: state.usage?.totalTokens ?? 0,
            tasks: state.tasks.map((task) => ({
              title: task.title,
              waitMs: Math.max(0, (task.startedAt ?? state.createdAt) - state.createdAt),
              usageTokens: task.usage?.totalTokens ?? 0
            }))
          })
        } finally {
          ws.cleanup()
        }
      }
      expect(runs.map((run) => run.peak)).toEqual([1, 2, 4])
      // 固定脚本延迟下，限制越小总耗时不应更短；只作调度对照，不冒充真实模型速度。
      expect(runs[0].wallMs).toBeGreaterThanOrEqual(runs[2].wallMs)
      mkdirSync(join(process.cwd(), 'tmp', 'verification', 'collaboration'), { recursive: true })
      writeFileSync(
        join(process.cwd(), 'tmp', 'verification', 'collaboration', 'T14-limits-evidence.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            kind: 'fixture',
            note: '脚本成员固定等待与用量；这里只验证并发上限、排队与用量累计，不代表真实模型速度。',
            runs
          },
          null,
          2
        ),
        'utf8'
      )
    } catch (err) {
      for (const run of runs) void run
      throw err
    }
  })

  it('@core:swarm 失败尝试和重试消耗也计入项目用量', async () => {
    const ws = makeTempWorkspace()
    const slots = new FakeSlots(2)
    let aCalls = 0
    const runner = async (request: { description: string }): Promise<SwarmMemberResult> => {
      if (request.description === '成员 A') {
        aCalls += 1
        if (aCalls === 1) {
          return {
            status: 'failed',
            summary: '',
            steps: 1,
            usage: { inputTokens: 50, outputTokens: 10 },
            error: '第一次尝试失败'
          }
        }
        return completed('成员 A')
      }
      return completed(request.description)
    }
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      workerSlots: slots,
      collaborationLimits: { maxWorkers: 2, hostLimit: 8, auto: false, tokenBudget: 0 },
      runSwarmMember: runner
    })
    try {
      const result = await executeTool(
        'swarm',
        { goal: '失败与重试用量', max_parallel: 2, watchdog_ms: 0, retry: 1, tasks: toolTasks(2) },
        ctx
      )
      expect(result.ok, result.error).toBe(true)
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      const a = state.tasks.find((task) => task.title === '成员 A')!
      expect(a.attempts).toBe(2)
      expect(a.status).toBe('completed')
      expect(state.usage).toMatchObject({
        totalTokens: 300,
        acceptedTasks: 2,
        failedAttempts: 1,
        overBudget: false
      })
      expect(a.usage?.totalTokens).toBe(120)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 用量预算用尽后停止派发新 Worker，已开始的记录保留', async () => {
    const { result, state, ws } = await runWithLimit(1, 250, 40)
    try {
      expect(result.ok).toBe(false)
      expect(state.usage?.totalTokens).toBe(360)
      expect(state.usage?.acceptedTasks).toBe(3)
      expect(state.usage?.overBudget).toBe(true)
      expect(state.status).toBe('partial')
      const completedTasks = state.tasks.filter((task) => task.status === 'completed')
      const blocked = state.tasks.filter((task) => task.status === 'blocked')
      expect(completedTasks).toHaveLength(3)
      expect(blocked).toHaveLength(1)
      expect(blocked[0].error).toContain('预算')
      expect(blocked[0].usage).toBeUndefined()
      expect(result.meta?.usage).toMatchObject({ totalTokens: 360, budgetTokens: 250, overBudget: true })
      expect(String(result.output)).toContain('预算已用尽')
    } finally {
      ws.cleanup()
    }
  })
})
})

describe('collaboration-pilot', () => {
class PausedRuntime implements CollaborationRuntimePort {
  registerTask(): void {}
  unregisterTask(): void {}
  projectState(): null {
    return null
  }
  dispatchAllowed(): boolean {
    return false
  }
}

describe('collaboration-pilot.test.ts', () => {
  it('@core:swarm 试点关闭后拒绝新派工，不调用任何成员', async () => {
    const ws = makeTempWorkspace()
    const runner = vi.fn(
      async (request: { description: string }): Promise<SwarmMemberResult> => ({
        status: 'completed',
        summary: request.description,
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 }
      })
    )
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      collaborationRuntime: new PausedRuntime(),
      runSwarmMember: runner
    })
    try {
      const result = await executeTool(
        'swarm',
        {
          goal: '试点关闭后的新派工',
          tasks: [{ id: 'a', title: '新任务', prompt: '写文件', deliverable: '结果', files: [] }]
        },
        ctx
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('已在做的工作会继续')
      expect(result.hint).toContain('重新开启')
      expect(runner).not.toHaveBeenCalled()
    } finally {
      ws.cleanup()
    }
  })
})
})

describe('collaboration-plan', () => {
const SESSION_ID = 'session_docs'

function planTask(overrides: Partial<PlanTaskInput> & Pick<PlanTaskInput, 'id' | 'title' | 'deliverable'>): PlanTaskInput {
  const prompt = overrides.prompt ?? overrides.title
  return {
    index: 0,
    prompt,
    promptFull: overrides.promptFull ?? prompt,
    files: [],
    needs: [],
    dependsOn: [],
    role: 'general',
    roleTitle: '通用成员',
    ...overrides
  }
}

function loginPlan(ruleVersion = 'v1'): PlanTaskInput[] {
  return [
    planTask({
      id: 'rules',
      index: 0,
      title: '登录规则',
      prompt: `定义登录规则（${ruleVersion}），锁定策略与错误码。`,
      deliverable: '登录规则与错误码',
      files: ['docs/login-rules.md']
    }),
    planTask({
      id: 'service',
      index: 1,
      title: '登录服务',
      prompt: '按规则实现登录 API。',
      deliverable: '登录 API',
      files: ['src/login.ts'],
      dependsOn: ['rules'],
      needs: [{ taskId: 'rules', result: '登录规则与错误码' }]
    }),
    planTask({
      id: 'page',
      index: 2,
      title: '登录页面',
      prompt: '按规则实现登录页。',
      deliverable: '登录页',
      files: ['src/login.tsx'],
      dependsOn: ['rules'],
      needs: [{ taskId: 'rules', result: '登录规则与错误码' }]
    }),
    planTask({
      id: 'test',
      index: 3,
      title: '登录测试',
      prompt: '对服务和页面运行登录测试。',
      deliverable: '登录测试通过',
      files: ['tests/login.test.ts'],
      dependsOn: ['service', 'page'],
      needs: [
        { taskId: 'service', result: '登录 API' },
        { taskId: 'page', result: '登录页' }
      ]
    }),
    planTask({
      id: 'docs',
      index: 4,
      title: '使用说明',
      prompt: '写登录使用说明。',
      deliverable: '登录使用说明',
      files: ['docs/login-guide.md']
    })
  ]
}

function migrationPlan(): PlanTaskInput[] {
  return [
    planTask({
      id: 'check',
      index: 0,
      title: '迁移前检查',
      prompt: '检查数据完整性与冲突。',
      deliverable: '检查报告',
      files: ['migration/check.md']
    }),
    planTask({
      id: 'migrate',
      index: 1,
      title: '执行迁移',
      prompt: '按检查报告执行迁移。',
      deliverable: '迁移后的数据',
      files: ['migration/run.ts'],
      dependsOn: ['check'],
      needs: [{ taskId: 'check', result: '检查报告' }]
    }),
    planTask({
      id: 'verify',
      index: 2,
      title: '迁移后核对',
      prompt: '核对迁移结果。',
      deliverable: '核对报告',
      files: ['migration/verify.md'],
      dependsOn: ['migrate'],
      needs: [{ taskId: 'migrate', result: '迁移后的数据' }]
    })
  ]
}

function completeAll(state: SuperAgentState): SuperAgentState {
  for (const task of state.tasks) {
    task.status = 'completed'
    task.attempts = Math.max(1, task.attempts)
    task.currentAttemptId = collaborationAttemptId(task.taskId ?? task.id, task.attempts)
    task.summary = `${task.title}已完成`
    task.attemptHistory = [
      {
        id: task.currentAttemptId,
        taskId: task.taskId ?? task.id,
        attempt: task.attempts,
        status: 'delivered',
        startedAt: 1,
        finishedAt: 2,
        source: 'router',
        summary: task.summary
      }
    ]
  }
  state.status = 'completed'
  return state
}

function toolContext(
  ws: ReturnType<typeof makeTempWorkspace>,
  runner: (request: SwarmMemberRequest) => Promise<SwarmMemberResult>,
  overrides: Partial<ToolContext> = {}
): ToolContext {
  return makeToolContext(ws, {
    superMode: true,
    permissionMode: 'auto',
    agents: BUILTIN_AGENT_ROLES,
    emit: () => undefined,
    progress: () => undefined,
    runSwarmMember: runner,
    ...overrides
  })
}

function completed(title: string): SwarmMemberResult {
  return { status: 'completed', summary: `${title}已完成`, steps: 1, usage: { inputTokens: 1, outputTokens: 1 } }
}

/** 工具入参使用模型侧的 snake_case；纯编译器用 camelCase 的 PlanTaskInput。 */
function asToolTasks(tasks: PlanTaskInput[]): Array<Record<string, unknown>> {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    deliverable: task.deliverable,
    files: [...task.files],
    needs: task.needs.map((need) => ({ task_id: need.taskId, result: need.result })),
    depends_on: [...task.dependsOn],
    ...(task.waitReason ? { wait_reason: task.waitReason } : {})
  }))
}

describe('collaboration-plan.test.ts', () => {
  it('@core:swarm 登录计划按成果拆分：服务与页面可并行，测试等两者，等待理由可读', () => {
    const compiled = compilePlan({
      projectId: 'project_plan00000001',
      runId: 'super_plan_1',
      goal: '实现登录功能',
      tasks: loginPlan('v1')
    })
    expect(compiled.changed).toBe(true)
    expect(compiled.planRevision).toBe(1)
    expect(compiled.state.planHistory).toHaveLength(1)
    const state = compiled.state
    const service = state.tasks.find((task) => task.id === 'service')!
    const page = state.tasks.find((task) => task.id === 'page')!
    const test = state.tasks.find((task) => task.id === 'test')!
    expect(service.dependsOn).toEqual(['rules'])
    expect(page.dependsOn).toEqual(['rules'])
    expect(test.dependsOn).toEqual(['service', 'page'])
    expect(service.waitReason).toContain('登录规则')
    expect(service.waitReason).toContain('登录规则与错误码')
    expect(test.needs).toHaveLength(2)
    expect(state.planHistory?.[0].tasks.find((task) => task.key === 'test')?.needs).toEqual([
      { taskId: 'service', result: '登录 API' },
      { taskId: 'page', result: '登录页' }
    ])
  })

  it('@core:swarm 数据迁移保持强制顺序：检查→迁移→核对，不能并行越级', () => {
    const compiled = compilePlan({
      projectId: 'project_plan00000002',
      runId: 'super_plan_2',
      goal: '数据迁移',
      tasks: migrationPlan()
    })
    expect(compiled.state.tasks.map((task) => task.id)).toEqual(['check', 'migrate', 'verify'])
    const migrate = compiled.state.tasks.find((task) => task.id === 'migrate')!
    const verify = compiled.state.tasks.find((task) => task.id === 'verify')!
    expect(migrate.waitReason).toContain('迁移前检查')
    expect(verify.waitReason).toContain('执行迁移')
    expect(compiled.state.tasks.find((task) => task.id === 'check')?.dependsOn).toEqual([])
  })

  it('@core:swarm 局部修订只重排受影响项：无关任务保留完成，下游自动失效', () => {
    const projectId = 'project_plan00000003'
    const v1 = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v1') }).state
    )
    const revised = compilePlan({
      projectId,
      runId: 'super_plan_v2',
      goal: '登录功能（规则更新）',
      tasks: loginPlan('v2'),
      current: v1,
      revisionOf: 'current'
    })
    expect(revised.changed).toBe(true)
    expect(revised.planRevision).toBe(2)
    expect(revised.state.planHistory).toHaveLength(2)
    expect(revised.affectedKeys.sort()).toEqual(['page', 'rules', 'service', 'test'])
    expect(revised.reusedKeys).toEqual(['docs'])
    const docs = revised.state.tasks.find((task) => task.id === 'docs')!
    expect(docs.status).toBe('completed')
    expect(docs.attempts).toBe(1)
    const service = revised.state.tasks.find((task) => task.id === 'service')!
    expect(service.status).toBe('queued')
    expect(service.attempts).toBe(1)
    expect(service.taskId).toBe(v1.tasks.find((task) => task.id === 'service')?.taskId)
    expect(service.statusHistory?.at(-1)).toMatchObject({ source: 'user', to: 'waiting' })
    expect(revised.hasWork).toBe(true)
  })

  it('@core:swarm 相同计划重复提交：不产生新版本，也不重跑任何任务', () => {
    const projectId = 'project_plan00000004'
    const v2 = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v2') }).state
    )
    const again = compilePlan({
      projectId,
      runId: 'super_plan_v1b',
      goal: '登录功能',
      tasks: loginPlan('v2'),
      current: v2,
      revisionOf: 'current'
    })
    expect(again.changed).toBe(false)
    expect(again.planRevision).toBe(1)
    expect(again.affectedKeys).toEqual([])
    expect(again.hasWork).toBe(false)
  })

  it('@core:swarm 修订影响运行中的任务时要求先停止它，避免新旧尝试同时写文件', () => {
    const projectId = 'project_plan00000007'
    const v1 = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v1') }).state
    )
    const rules = v1.tasks.find((task) => task.id === 'rules')!
    rules.status = 'running'
    rules.currentAttemptId = 'attempt_rules_a1'
    const revised = compilePlan({
      projectId,
      runId: 'super_plan_v2',
      goal: '登录功能（规则 v2）',
      tasks: loginPlan('v2'),
      current: v1,
      revisionOf: 'current'
    })
    expect(revised.stopKeys).toEqual(['rules'])
    expect(revised.state.tasks.find((task) => task.id === 'rules')?.status).toBe('queued')
    expect(revised.affectedKeys.sort()).toEqual(['page', 'rules', 'service', 'test'])
  })

  it('@core:swarm 从计划移除已完成项：保留历史成果，但不影响当前计划完成状态', () => {
    const projectId = 'project_plan00000006'
    const v1 = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v1') }).state
    )
    const withoutDocs = loginPlan('v1').filter((task) => task.id !== 'docs')
    const revised = compilePlan({
      projectId,
      runId: 'super_plan_v2',
      goal: '登录功能',
      tasks: withoutDocs,
      current: v1,
      revisionOf: 'current'
    })
    expect(revised.removedKeys).toEqual(['docs'])
    const docs = revised.state.tasks.find((task) => task.id === 'docs')!
    expect(docs.planRemoved).toBe(true)
    expect(docs.status).toBe('completed')
    expect(revised.state.status).toBe('completed')
  })

  it('@core:swarm 互相等待或缺少前置结果时拒绝修订，上一版计划保持不变', () => {
    const projectId = 'project_plan00000005'
    const current = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v1') }).state
    )
    const before = JSON.stringify(current)
    const cycle = [
      planTask({
        id: 'a',
        title: 'A',
        deliverable: 'A 的成果',
        dependsOn: ['b'],
        needs: [{ taskId: 'b', result: 'B 的成果' }]
      }),
      planTask({
        id: 'b',
        title: 'B',
        deliverable: 'B 的成果',
        dependsOn: ['a'],
        needs: [{ taskId: 'a', result: 'A 的成果' }]
      })
    ]
    expect(() =>
      compilePlan({ projectId, runId: 'super_bad', goal: '环', tasks: cycle, current, revisionOf: 'current' })
    ).toThrow(PlanCompileError)
    expect(() =>
      compilePlan({ projectId, runId: 'super_bad', goal: '环', tasks: cycle, current, revisionOf: 'current' })
    ).toThrow(/互相等待/)
    expect(JSON.stringify(current)).toBe(before)

    const missingNeed = [
      planTask({ id: 'rules', title: '登录规则', deliverable: '登录规则与错误码' }),
      planTask({
        id: 'x',
        title: 'X',
        deliverable: 'X 的成果',
        dependsOn: ['rules'],
        needs: []
      })
    ]
    expect(() =>
      compilePlan({ projectId, runId: 'super_bad2', goal: '缺结果', tasks: missingNeed, current, revisionOf: 'current' })
    ).toThrow(/没有写清需要/)
  })
})

describe('collaboration-plan-tool.test.ts', () => {
  it('@core:swarm 登录计划真实调度：规则完成后服务/页面并行，测试等两者', async () => {
    const ws = makeTempWorkspace()
    const starts = new Map<string, number>()
    const ends = new Map<string, number>()
    let running = 0
    let maxRunning = 0
    const ctx = toolContext(ws, async (request) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      starts.set(request.description, Date.now())
      await new Promise((resolve) => setTimeout(resolve, request.description === '登录规则' ? 20 : 40))
      ends.set(request.description, Date.now())
      running -= 1
      return completed(request.description)
    })
    try {
      const result = await executeTool(
        'swarm',
        { goal: '实现登录功能', max_parallel: 3, watchdog_ms: 0, tasks: asToolTasks(loginPlan('v1')) },
        ctx
      )
      expect(result.ok, result.error).toBe(true)
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      expect(state.tasks.every((task) => task.status === 'completed')).toBe(true)
      expect(state.planHistory?.[0].tasks.find((task) => task.key === 'service')?.waitReason).toContain('登录规则')
      expect(starts.get('登录服务')!).toBeGreaterThanOrEqual(ends.get('登录规则')!)
      expect(starts.get('登录页面')!).toBeGreaterThanOrEqual(ends.get('登录规则')!)
      expect(maxRunning).toBeGreaterThanOrEqual(2)
      expect(starts.get('登录测试')!).toBeGreaterThanOrEqual(ends.get('登录服务')!)
      expect(starts.get('登录测试')!).toBeGreaterThanOrEqual(ends.get('登录页面')!)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 数据迁移真实调度：即使并行名额足够也按检查→迁移→核对顺序执行', async () => {
    const ws = makeTempWorkspace()
    const starts = new Map<string, number>()
    const ends = new Map<string, number>()
    let running = 0
    let maxRunning = 0
    const ctx = toolContext(ws, async (request) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      starts.set(request.description, Date.now())
      await new Promise((resolve) => setTimeout(resolve, 25))
      ends.set(request.description, Date.now())
      running -= 1
      return completed(request.description)
    })
    try {
      const result = await executeTool(
        'swarm',
        { goal: '数据迁移', max_parallel: 3, watchdog_ms: 0, tasks: asToolTasks(migrationPlan()) },
        ctx
      )
      expect(result.ok, result.error).toBe(true)
      expect(maxRunning).toBe(1)
      expect(starts.get('执行迁移')!).toBeGreaterThanOrEqual(ends.get('迁移前检查')!)
      expect(starts.get('迁移后核对')!).toBeGreaterThanOrEqual(ends.get('执行迁移')!)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 规则变更后只重跑受影响项：无关说明任务保留完成，下游服务/页面/测试重新排队', async () => {
    const ws = makeTempWorkspace()
    const projectId = collaborationProjectId(ws.root, SESSION_ID)
    const current = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v1') }).state
    )
    const calls: string[] = []
    const runtime = {
      projectState: () => current,
      registerTask: () => undefined,
      unregisterTask: () => undefined
    }
    const ctx = toolContext(
      ws,
      async (request) => {
        calls.push(request.description)
        return completed(request.description)
      },
      { collaborationRuntime: runtime, superAgentState: current }
    )
    try {
      const result = await executeTool(
        'swarm',
        {
          goal: '登录功能（规则更新）',
          revision_of: 'current',
          max_parallel: 3,
          watchdog_ms: 0,
          tasks: asToolTasks(loginPlan('v2'))
        },
        ctx
      )
      expect(result.ok, result.error).toBe(true)
      expect(calls.sort()).toEqual(['登录规则', '登录服务', '登录页面', '登录测试'].sort())
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      expect(state.planRevision).toBe(2)
      const docs = state.tasks.find((task) => task.id === 'docs')!
      expect(docs.status).toBe('completed')
      expect(docs.attempts).toBe(1)
      expect(state.tasks.find((task) => task.id === 'service')?.attempts).toBe(2)
      expect(String(result.output)).toContain('计划第 2 版')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 两个 Worker 改同一行：独立副本合并时保留两份，主文件不被静默覆盖', async () => {
    const dataDir = makeTempDir('morrow-swarm-iso-')
    const ws = makeTempWorkspace({ 'note.txt': 'base line\n' })
    try {
      const isolation = new WorkspaceIsolationService(dataDir)
      const calls: string[] = []
      const ctx = toolContext(
        ws,
        async (request) => {
          calls.push(request.description)
          const target = request.workspace
          expect(target).toBeTruthy()
          writeFileSync(join(target!, 'note.txt'), `line from ${request.description}\n`)
          return completed(request.description)
        },
        { workspaceIsolation: isolation }
      )
      const result = await executeTool(
        'swarm',
        {
          goal: '并发改同一行',
          max_parallel: 2,
          watchdog_ms: 0,
          tasks: [
            { id: 'a', title: '成员 A', prompt: '写 A 版本', deliverable: 'A 的 note.txt' },
            { id: 'b', title: '成员 B', prompt: '写 B 版本', deliverable: 'B 的 note.txt' }
          ]
        },
        ctx
      )
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('文件冲突')
      expect(calls.sort()).toEqual(['成员 A', '成员 B'])
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      expect(state.conflicts).toHaveLength(1)
      expect(state.conflicts?.[0]).toMatchObject({ path: 'note.txt', status: 'open' })
      expect(state.conflicts?.[0].currentPreview).toBeTruthy()
      expect(state.conflicts?.[0].incomingPreview).toBeTruthy()
      const main = readFileSync(join(ws.root, 'note.txt'), 'utf8')
      expect(main === 'line from 成员 A\n' || main === 'line from 成员 B\n').toBe(true)
      const conflicted = state.tasks.find((task) => task.conflictCount === 1)
      expect(conflicted).toBeTruthy()
      expect(conflicted?.workspaceCopy?.path).toContain(dataDir)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      ws.cleanup()
    }
  })

  it('@core:swarm 修订出现互相等待时拒绝并保留上一版：没有 Worker 被启动', async () => {
    const ws = makeTempWorkspace()
    const projectId = collaborationProjectId(ws.root, SESSION_ID)
    const current = completeAll(
      compilePlan({ projectId, runId: 'super_plan_v1', goal: '登录功能', tasks: loginPlan('v1') }).state
    )
    const before = JSON.stringify(current)
    const calls: string[] = []
    const runtime = {
      projectState: () => current,
      registerTask: () => undefined,
      unregisterTask: () => undefined
    }
    const ctx = toolContext(
      ws,
      async (request) => {
        calls.push(request.description)
        return completed(request.description)
      },
      { collaborationRuntime: runtime, superAgentState: current }
    )
    try {
      const result = await executeTool(
        'swarm',
        {
          goal: '环',
          revision_of: 'current',
          tasks: asToolTasks([
            planTask({
              id: 'a',
              title: 'A',
              deliverable: 'A 的成果',
              dependsOn: ['b'],
              needs: [{ taskId: 'b', result: 'B 的成果' }]
            }),
            planTask({
              id: 'b',
              title: 'B',
              deliverable: 'B 的成果',
              dependsOn: ['a'],
              needs: [{ taskId: 'a', result: 'A 的成果' }]
            })
          ])
        },
        ctx
      )
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('互相等待')
      expect(calls).toHaveLength(0)
      expect(JSON.stringify(current)).toBe(before)
    } finally {
      ws.cleanup()
    }
  })
})
})

describe('collaboration-stuck', () => {
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readOperation(id: string): SwarmOperation {
  return {
    id,
    name: 'read_file',
    title: '读取文件',
    status: 'success',
    input: '{"path":"same.txt"}'
  }
}

function writeOperation(id: string, content: string): SwarmOperation {
  return {
    id,
    name: 'write_file',
    title: '写入文件',
    status: 'success',
    input: `{"path":"${id}.txt"}`,
    effective: true,
    target: `${id}.txt`,
    afterHash: `hash-${content}`
  }
}

function completed(title: string): SwarmMemberResult {
  return {
    status: 'completed',
    summary: `${title}已完成`,
    steps: 4,
    usage: { inputTokens: 10, outputTokens: 5 }
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(abortError())
      return
    }
    if (signal.aborted) {
      reject(abortError())
      return
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

async function waitFor<T>(read: () => T | undefined | null | false, timeoutMs = 2500): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = read()
    if (value) return value
    await sleep(20)
  }
  throw new Error('等待卡住提醒超时')
}

class FakeRuntime implements CollaborationRuntimePort {
  readonly controls = new Map<string, CollaborationTaskControl>()

  registerTask(control: CollaborationTaskControl): void {
    this.controls.set(`${control.projectId}:${control.taskId}`, control)
  }

  unregisterTask(input: { projectId: string; taskId: string; attemptId: string }): void {
    const key = `${input.projectId}:${input.taskId}`
    if (this.controls.get(key)?.attemptId === input.attemptId) this.controls.delete(key)
  }

  projectState(): SuperAgentState | null {
    return null
  }

  controlFor(taskId: string): CollaborationTaskControl | undefined {
    return [...this.controls.values()].find((control) => control.taskId === taskId)
  }
}

class FakeSlots implements WorkerSlotPort {
  active = 0
  peak = 0

  constructor(private readonly limit: number) {}

  async acquire(input: { ownerId: string; signal?: AbortSignal }): Promise<WorkerSlotLease | null> {
    if (input.signal?.aborted) return null
    while (this.active >= this.limit) {
      if (input.signal?.aborted) return null
      await sleep(5)
    }
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
      }
    }
  }

  snapshot(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: 0, limit: this.limit }
  }
}

const STUCK_LIMITS = {
  maxWorkers: 3,
  hostLimit: 8,
  auto: false,
  tokenBudget: 0,
  stuckAlerts: true,
  stuckIdleMs: 60,
  stuckRepeats: 3,
  stuckSteps: 4
}

describe('collaboration-stuck.test.ts', () => {
  it('@core:swarm 重复操作要同时满足没有新成果和等待时间', () => {
    const tracker = new StuckTracker({ enabled: true, idleMs: 1_000, repeats: 3, steps: 6 }, 0)
    const first = tracker.observe({
      now: 500,
      stepCount: 1,
      waitingApproval: false,
      operations: [readOperation('r1')]
    })
    expect(first.kind).toBe('idle')

    const repeated = tracker.observe({
      now: 1_100,
      stepCount: 3,
      waitingApproval: false,
      operations: [readOperation('r2'), readOperation('r3'), readOperation('r4')]
    })
    expect(repeated.kind).toBe('stuck')
    expect(repeated.reason).toContain('相同操作')
    expect(repeated.repeatedCount).toBe(4)

    const effective = tracker.observe({
      now: 1_200,
      stepCount: 4,
      waitingApproval: false,
      operations: [writeOperation('w1', 'new-content')]
    })
    expect(effective.kind).toBe('progress')

    const afterProgress = tracker.observe({ now: 1_300, stepCount: 4, waitingApproval: false })
    expect(afterProgress.kind).toBe('idle')
  })

  it('@core:swarm 等人批准期间暂停，关闭开关后不再提示', () => {
    const tracker = new StuckTracker({ enabled: true, idleMs: 200, repeats: 3, steps: 3 }, 0)
    tracker.observe({
      now: 100,
      stepCount: 5,
      waitingApproval: false,
      operations: [readOperation('a'), readOperation('b'), readOperation('c')]
    })
    const waiting = tracker.observe({ now: 300, stepCount: 5, waitingApproval: true })
    expect(waiting.kind).toBe('waiting')
    const resumed = tracker.observe({ now: 3_000, stepCount: 5, waitingApproval: false })
    expect(resumed.kind).toBe('idle')
    expect(tracker.observe({ now: 3_100, stepCount: 5, waitingApproval: false }).kind).toBe('idle')

    const disabled = new StuckTracker({ enabled: false, idleMs: 50, repeats: 2, steps: 2 }, 0)
    disabled.observe({
      now: 10,
      stepCount: 4,
      waitingApproval: false,
      operations: [readOperation('d'), readOperation('e'), readOperation('f')]
    })
    const noAlert = disabled.observe({ now: 10_000, stepCount: 9, waitingApproval: false })
    expect(noAlert.kind).toBe('idle')
  })

  it('@core:swarm 重复无成果才提示，等人批准不误报，选择继续等待不停止成员', async () => {
    const ws = makeTempWorkspace({ 'seed.txt': 'unchanged' })
    const runtime = new FakeRuntime()
    const states: SuperAgentState[] = []
    let approvalStarted!: () => void
    const approvalStartedPromise = new Promise<void>((resolve) => {
      approvalStarted = resolve
    })
    let releaseApproval!: () => void
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    let releaseRepeat!: () => void
    const repeatGate = new Promise<void>((resolve) => {
      releaseRepeat = resolve
    })

    const runner = async (request: SwarmMemberRequest): Promise<SwarmMemberResult> => {
      if (request.description === '重复成员') {
        request.onProgress?.('反复读取同一文件', 3, [readOperation('repeat-1'), readOperation('repeat-2'), readOperation('repeat-3')])
        await Promise.race([sleep(1_200), repeatGate, abortPromise(request.signal)])
        request.onProgress?.('写入最终结果', 4, [writeOperation('repeat-result', 'done')])
        return completed(request.description)
      }
      if (request.description === '等待成员') {
        request.onProgress?.('准备请求批准', 4, [
          readOperation('wait-1'),
          readOperation('wait-2'),
          readOperation('wait-3'),
          readOperation('wait-4')
        ])
        approvalStarted()
        await Promise.race([approvalGate, abortPromise(request.signal)])
        request.onProgress?.('批准后写入', 5, [writeOperation('approved-result', 'ok')])
        return completed(request.description)
      }
      for (let index = 0; index < 4; index += 1) {
        await sleep(70)
        request.onProgress?.(`稳定产出第 ${index + 1} 份`, index + 1, [
          writeOperation(`steady-${index + 1}`, `v${index + 1}`)
        ])
      }
      return completed(request.description)
    }

    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      collaborationRuntime: runtime,
      collaborationLimits: STUCK_LIMITS,
      runSwarmMember: runner,
      emit: (event: RuntimeEventPayload) => {
        if (event.type === 'super_updated' && event.state) states.push(event.state)
      }
    })
    const latest = (): SuperAgentState | undefined => states[states.length - 1]
    const openAlert = (title: string) => {
      const task = latest()?.tasks.find((entry) => entry.title === title)
      return task?.stuck
    }

    try {
      const pending = executeTool(
        'swarm',
        {
          goal: '三种任务的卡住判断',
          max_parallel: 3,
          watchdog_ms: 0,
          tasks: [
            { id: 'repeat', title: '重复成员', prompt: '重复读取同一个文件', deliverable: '结论', files: [] },
            { id: 'waiting', title: '等待成员', prompt: '等待批准后继续', deliverable: '结论', files: [] },
            { id: 'steady', title: '稳定成员', prompt: '持续写出新结果', deliverable: '文件', files: [] }
          ]
        },
        ctx
      )

      await approvalStartedPromise
      const waitingTaskId = await waitFor(() =>
        latest()?.tasks.find((task) => task.title === '等待成员')?.taskId
      )
      runtime.controlFor(waitingTaskId)?.setWaiting?.(true)

      const alert = await waitFor(() => openAlert('重复成员'))
      expect(alert.reason).toContain('相同操作')
      expect(alert.evidence?.length).toBeGreaterThan(0)
      expect(alert.evidence?.every((operation) => operation.effective !== true)).toBe(true)
      const repeatTaskId = await waitFor(() =>
        latest()?.tasks.find((task) => task.title === '重复成员')?.taskId
      )

      runtime.controlFor(repeatTaskId)?.dismissStuck?.()
      await waitFor(() =>
        latest()?.stuckAlerts?.some(
          (entry) => entry.id === alert.id && entry.status === 'resolved' && entry.resolution === 'dismissed'
        )
      )
      // 提醒只是提示：选择继续等待后这项任务仍在运行。
      expect(latest()?.tasks.find((task) => task.title === '重复成员')?.status).toBe('running')
      expect(openAlert('等待成员')).toBeUndefined()
      expect(openAlert('稳定成员')).toBeUndefined()

      runtime.controlFor(waitingTaskId)?.setWaiting?.(false)
      releaseApproval()
      releaseRepeat()
      const result = await pending
      expect(result.ok, result.error).toBe(true)
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      expect(state.tasks.every((task) => task.status === 'completed')).toBe(true)

      const waitingTask = state.tasks.find((task) => task.title === '等待成员')!
      const steadyTask = state.tasks.find((task) => task.title === '稳定成员')!
      expect(waitingTask.stuck).toBeUndefined()
      expect(steadyTask.stuck).toBeUndefined()
      expect(state.stuckAlerts?.filter((entry) => entry.taskId === waitingTask.taskId)).toHaveLength(0)
      expect(state.stuckAlerts?.filter((entry) => entry.taskId === steadyTask.taskId)).toHaveLength(0)
      expect(
        state.stuckAlerts?.some((entry) => entry.id === alert.id && entry.resolution === 'dismissed')
      ).toBe(true)
      // 判断只读现有记录，没有改动用户文件。
      expect(readFileSync(join(ws.root, 'seed.txt'), 'utf8')).toBe('unchanged')

      mkdirSync(join(process.cwd(), 'tmp', 'verification', 'collaboration'), { recursive: true })
      writeFileSync(
        join(process.cwd(), 'tmp', 'verification', 'collaboration', 'T15-stuck-evidence.json'),
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            kind: 'fixture',
            note: '脚本成员模拟三种情况：重复无成果、正常等待批准、稳定产出；只验证判断与提醒，不代表真实模型。',
            situations: [
              {
                title: '重复操作、没有新成果',
                taskId: alert.taskId,
                reason: alert.reason,
                resolution: 'dismissed',
                evidence: alert.evidence?.map((operation) => ({
                  name: operation.name,
                  input: operation.input,
                  effective: operation.effective === true
                }))
              },
              {
                title: '正常等待用户批准',
                taskId: waitingTask.taskId,
                alert: null,
                note: '审批期间暂停计时，批准后重新累计'
              },
              {
                title: '稳步产出成果',
                taskId: steadyTask.taskId,
                alert: null,
                note: '每次有效写入都清除重复计数'
              }
            ]
          },
          null,
          2
        ),
        'utf8'
      )
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 停止只影响这一项并释放名额，后续任务继续', async () => {
    const ws = makeTempWorkspace()
    const runtime = new FakeRuntime()
    const states: SuperAgentState[] = []
    const slots = new FakeSlots(1)
    const startOrder: string[] = []
    const runner = async (request: SwarmMemberRequest): Promise<SwarmMemberResult> => {
      startOrder.push(request.description)
      if (request.description === '卡住成员') {
        request.onProgress?.('反复读取同一文件', 3, [
          readOperation('stuck-1'),
          readOperation('stuck-2'),
          readOperation('stuck-3')
        ])
        await abortPromise(request.signal)
      }
      return completed(request.description)
    }
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      collaborationRuntime: runtime,
      workerSlots: slots,
      collaborationLimits: { ...STUCK_LIMITS, maxWorkers: 1 },
      runSwarmMember: runner,
      emit: (event: RuntimeEventPayload) => {
        if (event.type === 'super_updated' && event.state) states.push(event.state)
      }
    })
    const latest = (): SuperAgentState | undefined => states[states.length - 1]

    try {
      const pending = executeTool(
        'swarm',
        {
          goal: '释放名额',
          max_parallel: 2,
          watchdog_ms: 0,
          tasks: [
            { id: 'stuck', title: '卡住成员', prompt: '重复读取', deliverable: '结论', files: [] },
            { id: 'next', title: '后续成员', prompt: '继续工作', deliverable: '结论', files: [] }
          ]
        },
        ctx
      )
      const alert = await waitFor(() => {
        const task = latest()?.tasks.find((entry) => entry.title === '卡住成员')
        return task?.stuck
      })
      expect(alert.taskId).toBeTruthy()
      expect(startOrder).toEqual(['卡住成员'])
      runtime.controlFor(alert.taskId)?.stop()

      const result = await pending
      expect(result.ok, result.error).toBe(false)
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      const stuckTask = state.tasks.find((task) => task.title === '卡住成员')!
      const nextTask = state.tasks.find((task) => task.title === '后续成员')!
      expect(stuckTask.status).toBe('cancelled')
      expect(nextTask.status).toBe('completed')
      expect(startOrder).toEqual(['卡住成员', '后续成员'])
      expect(slots.active).toBe(0)
      expect(slots.peak).toBe(1)
      expect(
        state.stuckAlerts?.some(
          (entry) => entry.id === alert.id && entry.resolution === 'stopped' && entry.status === 'resolved'
        )
      ).toBe(true)
    } finally {
      ws.cleanup()
    }
  })
})
})

describe('collaboration-trace', () => {
const PROJECT_ID = 'project_trace_test'
const V1_CONTENT = `# 登录接口说明 v1\n${'初始内容。'.repeat(700)}\n版本：草稿\n`
const V2_CONTENT = `# 登录接口说明 v2\n${'最终内容。'.repeat(700)}\n版本：final\n`

function makeArtifact(version: number, hash: string, snapshotPath: string, content: string): CollaborationArtifact {
  return {
    id: `artifact_login_v${version}`,
    projectId: PROJECT_ID,
    name: '登录接口说明',
    version,
    path: 'docs/login.md',
    status: 'ready',
    taskId: 'task_trace_author',
    hash,
    size: Buffer.byteLength(content),
    snapshotPath,
    publishedAt: version,
    summary: version === 1 ? '第 1 版草稿' : '第 2 版定稿'
  }
}

function makeState(v1: CollaborationArtifact, v2: CollaborationArtifact, failed: CollaborationVerification, passed: CollaborationVerification): SuperAgentState {
  return {
    runId: 'super_trace_unit',
    projectId: PROJECT_ID,
    revision: 1,
    goal: '追溯测试',
    status: 'completed',
    createdAt: 1,
    updatedAt: 30,
    artifacts: [v1, v2],
    tasks: [
      {
        id: 'author',
        taskId: 'task_trace_author',
        planKey: 'author',
        index: 0,
        title: '登录接口说明',
        prompt: '写接口说明',
        deliverable: 'docs/login.md',
        files: ['docs/login.md'],
        role: 'general',
        status: 'completed',
        dependsOn: [],
        attempts: 2,
        currentAttemptId: 'attempt_trace_author_a2',
        summary: '已按验收反馈修复',
        reworkFeedback: '上一次独立验收失败，请修复',
        verificationHistory: [failed, passed],
        verification: passed,
        verify: { files: ['docs/login.md'], command: 'node --test test/login.test.mjs', maxReworks: 1 },
        verifies: ['author']
      }
    ]
  }
}

describe('collaboration-trace.test.ts', () => {
  it('@core:swarm 从失败追到成果版本、修复与验收，旧版本标记历史依据且短引用省用量', async () => {
    const dataDir = makeTempDir('morrow-trace-')
    const snapshotDir = join(dataDir, 'collaboration', 'projects', PROJECT_ID, 'artifacts', 'login')
    mkdirSync(snapshotDir, { recursive: true })
    const v1Path = join(snapshotDir, 'v1.md')
    const v2Path = join(snapshotDir, 'v2.md')
    writeFileSync(v1Path, V1_CONTENT, 'utf8')
    writeFileSync(v2Path, V2_CONTENT, 'utf8')
    const longFailure = `AssertionError: expected final\n${'失败堆栈。'.repeat(500)}`
    const failed: CollaborationVerification = {
      id: 'verification_failed_v1',
      projectId: PROJECT_ID,
      taskId: 'task_trace_author',
      verifies: ['author'],
      candidateVersion: 'cand_fail0000001',
      files: [{ path: 'docs/login.md', required: true, exists: true, hash: 'hash_v1', size: Buffer.byteLength(V1_CONTENT) }],
      command: { command: 'node --test test/login.test.mjs', exitCode: 1, output: longFailure, timedOut: false, durationMs: 30 },
      status: 'failed',
      checkedAt: 10,
      attempt: 1,
      reworkCount: 1,
      maxReworks: 1,
      error: '验收命令未通过。'
    }
    const passed: CollaborationVerification = {
      ...failed,
      id: 'verification_passed_v2',
      candidateVersion: 'cand_pass0000002',
      files: [{ path: 'docs/login.md', required: true, exists: true, hash: 'hash_v2', size: Buffer.byteLength(V2_CONTENT) }],
      command: { command: 'node --test test/login.test.mjs', exitCode: 0, output: 'pass 1', timedOut: false, durationMs: 20 },
      status: 'passed',
      checkedAt: 20,
      attempt: 2,
      error: undefined
    }
    const v1 = makeArtifact(1, 'hash_v1', v1Path, V1_CONTENT)
    const v2 = makeArtifact(2, 'hash_v2', v2Path, V2_CONTENT)
    const state = makeState(v1, v2, failed, passed)
    getCollaborationRuntime().replaceProjectState(state)
    const service = new CollaborationTraceService(dataDir)
    try {
      const entries = buildTraceEntries(state)
      const failedEntry = entries.find((entry) => entry.id === `verification:${failed.id}`)!
      const passedEntry = entries.find((entry) => entry.id === `verification:${passed.id}`)!
      const v1Entry = entries.find((entry) => entry.id === `artifact:${v1.id}`)!
      const v2Entry = entries.find((entry) => entry.id === `artifact:${v2.id}`)!
      expect(failedEntry.kind).toBe('failure')
      expect(failedEntry.applicableVersions).toEqual(['登录接口说明 v1'])
      expect(failedEntry.staleForCurrent).toBe(true)
      expect(failedEntry.links.some((link) => link.kind === 'artifact' && link.version === 1)).toBe(true)
      expect(passedEntry.kind).toBe('verification')
      expect(passedEntry.applicableVersions).toEqual(['登录接口说明 v2'])
      expect(passedEntry.staleForCurrent).toBe(false)
      expect(v1Entry.staleForCurrent).toBe(true)
      expect(v2Entry.staleForCurrent).toBe(false)
      const usage = traceUsageOf(state, entries)
      expect(usage.summaryChars).toBeLessThan(usage.fullChars)
      expect(usage.savedChars / usage.fullChars).toBeGreaterThan(0.5)

      // 短引用：Worker 上下文只放预览和 trace 指引，不再整段塞入。
      const handoff = formatArtifactHandoff({
        artifact: v1,
        content: V1_CONTENT,
        need: { taskId: 'author', result: '登录接口说明', artifact: '登录接口说明' },
        publisherTitle: '登录接口说明'
      })
      expect(handoff.length).toBeLessThan(2_500)
      expect(handoff).toContain('trace(action="artifact"')
      const feedback = verificationFailureText(failed)
      expect(feedback.length).toBeLessThan(1_500)
      expect(feedback).toContain('trace(action="verification"')
      expect(feedback).toContain('cand_fail0000001')

      const list = await service.query({
        authorizedProjectId: PROJECT_ID,
        requestedProjectId: PROJECT_ID,
        query: { action: 'list' }
      })
      expect(list.entries.length).toBeGreaterThanOrEqual(4)
      expect(list.usage.fullChars).toBeGreaterThan(list.usage.summaryChars)

      // 长记录分页读到末尾。
      const first = await service.query({
        authorizedProjectId: PROJECT_ID,
        requestedProjectId: PROJECT_ID,
        query: { action: 'artifact', name: '登录接口说明', version: 1, maxChars: 200 }
      })
      expect(first.detail?.missing).toBe(false)
      expect(first.detail?.content).toHaveLength(200)
      expect(first.detail?.nextOffset).toBe(200)
      let combined = first.detail!.content
      let offset = first.detail!.nextOffset
      while (offset !== undefined) {
        const page = await service.query({
          authorizedProjectId: PROJECT_ID,
          requestedProjectId: PROJECT_ID,
          query: { action: 'artifact', name: '登录接口说明', version: 1, offset, maxChars: 200 }
        })
        combined += page.detail!.content
        offset = page.detail!.nextOffset
      }
      expect(combined).toBe(V1_CONTENT)
      expect(combined).toContain('版本：草稿')

      // 失败验收完整输出也可分页追溯。
      const failureDetail = await service.query({
        authorizedProjectId: PROJECT_ID,
        requestedProjectId: PROJECT_ID,
        query: { action: 'verification', candidateVersion: 'cand_fail0000001', maxChars: 200 }
      })
      expect(failureDetail.detail?.entry.kind).toBe('failure')
      expect(failureDetail.detail?.totalChars).toBe(longFailure.length)
      const nextFailure = await service.query({
        authorizedProjectId: PROJECT_ID,
        requestedProjectId: PROJECT_ID,
        query: {
          action: 'verification',
          candidateVersion: 'cand_fail0000001',
          offset: failureDetail.detail!.nextOffset,
          maxChars: 12_000
        }
      })
      expect(`${failureDetail.detail!.content}${nextFailure.detail!.content}`).toContain('AssertionError')

      // 原始快照缺失：明确提示，不拿 v2 内容代替。
      rmSync(v1Path)
      const missing = await service.query({
        authorizedProjectId: PROJECT_ID,
        requestedProjectId: PROJECT_ID,
        query: { action: 'artifact', name: '登录接口说明', version: 1 }
      })
      expect(missing.detail?.missing).toBe(true)
      expect(missing.detail?.content).toBe('')
      expect(missing.detail?.content).not.toContain('最终内容')

      // 跨项目拒绝并留审计。
      await expect(
        service.query({
          authorizedProjectId: PROJECT_ID,
          requestedProjectId: 'project_other',
          query: { action: 'list' }
        })
      ).rejects.toThrow('无权访问')
      const audit = readFileSync(join(dataDir, 'collaboration', 'trace-audit.jsonl'), 'utf8')
      expect(audit).toContain('trace-denied')
      expect(audit).toContain('project_other')
      expect(existsSync(v2Path)).toBe(true)
    } finally {
      getCollaborationRuntime().clearProject(PROJECT_ID)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
})

describe('collaboration-verification', () => {

function completed(title: string): SwarmMemberResult {
  return {
    status: 'completed',
    summary: `${title}已完成`,
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 }
  }
}

function toolTasks(options: { maxReworks?: number; extra?: boolean } = {}): Array<Record<string, unknown>> {
  const tasks: Array<Record<string, unknown>> = [
    {
      id: 'author',
      title: '编写交付物',
      prompt: '把真正要交付的内容写到 artifact.txt。',
      deliverable: 'artifact.txt',
      files: ['artifact.txt']
    },
    {
      id: 'verify',
      title: '独立验收',
      prompt: '由独立验收员检查候选版本。',
      deliverable: '验收记录',
      files: [],
      depends_on: ['author'],
      verify: {
        files: ['artifact.txt'],
        command: 'node --test test/accept.test.mjs',
        max_reworks: options.maxReworks ?? 1,
        timeout_ms: 60_000
      }
    },
    {
      id: 'docs',
      title: '说明',
      prompt: '写与交付物无关的使用说明。',
      deliverable: '使用说明',
      files: ['docs/guide.md']
    }
  ]
  if (options.extra) {
    tasks.push({
      id: 'extra',
      title: '补充说明',
      prompt: '写一段补充说明。',
      deliverable: '补充说明',
      files: ['docs/extra.md']
    })
  }
  return tasks
}

function prepareWorkspace() {
  const ws = makeTempWorkspace()
  mkdirSync(join(ws.root, 'test'), { recursive: true })
  writeFileSync(
    join(ws.root, 'test', 'accept.test.mjs'),
    `import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
test('artifact is ready', () => {
  const text = readFileSync(new URL('../artifact.txt', import.meta.url), 'utf8')
  assert.match(text, /ready/)
})
`,
    'utf8'
  )
  const dataDir = makeTempDir('morrow-verify-')
  return { ws, dataDir }
}

function runtimeOf(get: () => SuperAgentState | null): CollaborationRuntimePort {
  return {
    projectState: (projectId: string) => {
      const state = get()
      return state && (!state.projectId || state.projectId === projectId) ? state : null
    },
    registerTask: () => undefined,
    unregisterTask: () => undefined
  } as unknown as CollaborationRuntimePort
}

describe('collaboration-verification.test.ts', () => {
  it('@core:swarm 验收命令只允许常见测试运行器，不能借验收绕过命令权限', async () => {
    expect(isSafeVerificationCommand('node --test test/accept.test.mjs')).toBe(true)
    expect(isSafeVerificationCommand('node.exe --test test/accept.test.mjs')).toBe(true)
    expect(isSafeVerificationCommand('cd pelican-night-ride && node --test tests/static.test.mjs')).toBe(true)
    expect(isSafeVerificationCommand('cd "my app" && npm test 2>&1')).toBe(true)
    expect(isSafeVerificationCommand('node --test test/accept.test.mjs 2>&1')).toBe(true)
    expect(isSafeVerificationCommand('npm test -- --runInBand')).toBe(true)
    expect(isSafeVerificationCommand('npx vitest run tests/unit')).toBe(true)
    expect(isSafeVerificationCommand('pytest -q')).toBe(true)
    expect(isSafeVerificationCommand('powershell -Command "Remove-Item -Recurse ."')).toBe(false)
    expect(isSafeVerificationCommand('node -e "process.exit(0)"')).toBe(false)
    expect(isSafeVerificationCommand('npm test && rm -rf .')).toBe(false)
    expect(isSafeVerificationCommand('cd app && npm test && rm -rf .')).toBe(false)
    expect(isSafeVerificationCommand('npm test > out.txt')).toBe(false)

    const { ws, dataDir } = prepareWorkspace()
    const verifier = new CollaborationVerificationService(dataDir)
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      verification: verifier,
      runSwarmMember: async (request) => completed(request.description)
    })
    try {
      const tasks = toolTasks({ maxReworks: 1 })
      ;(tasks[1].verify as Record<string, unknown>).command = 'powershell -Command "Remove-Item -Recurse ."'
      const result = await executeTool('swarm', { goal: '不安全验收', max_parallel: 2, tasks }, ctx)
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('安全测试命令')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 独立验收失败退回作者返工，修复后在新候选版本复测通过', async () => {
    const { ws, dataDir } = prepareWorkspace()
    let authorCalls = 0
    let verifierCalls = 0
    let docsCalls = 0
    const verifier = new CollaborationVerificationService(dataDir)
    const runner = async (request: { description: string }): Promise<SwarmMemberResult> => {
      if (request.description === '编写交付物') {
        authorCalls += 1
        writeFileSync(join(ws.root, 'artifact.txt'), authorCalls === 1 ? 'draft' : 'ready', 'utf8')
        return completed('编写交付物')
      }
      if (request.description === '独立验收') {
        verifierCalls += 1
        return completed('独立验收')
      }
      if (request.description === '说明') {
        docsCalls += 1
        mkdirSync(join(ws.root, 'docs'), { recursive: true })
        writeFileSync(join(ws.root, 'docs', 'guide.md'), 'guide', 'utf8')
        return completed('说明')
      }
      return completed(request.description)
    }
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      verification: verifier,
      runSwarmMember: runner
    })
    try {
      const result = await executeTool(
        'swarm',
        { goal: '独立验收', max_parallel: 3, watchdog_ms: 0, tasks: toolTasks({ maxReworks: 1 }) },
        ctx
      )
      expect(result.ok, result.error).toBe(true)
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      const author = state.tasks.find((task) => task.id === 'author')!
      const verifierTask = state.tasks.find((task) => task.id === 'verify')!
      const docs = state.tasks.find((task) => task.id === 'docs')!
      expect(state.status).toBe('completed')
      expect(verifierCalls).toBe(0)
      expect(authorCalls).toBe(2)
      expect(author.attempts).toBe(2)
      expect(author.reworkFeedback).toBeUndefined()
      expect(verifierTask.attempts).toBe(2)
      expect(docs.attempts).toBe(1)
      expect(verifierTask.verification?.status).toBe('passed')
      expect(verifierTask.verification?.command?.exitCode).toBe(0)
      expect(verifierTask.verificationHistory?.map((record) => record.status)).toEqual(['failed', 'passed'])
      expect(verifierTask.verificationHistory?.[0].command?.exitCode).not.toBe(0)
      expect(verifierTask.verificationHistory?.[0].candidateVersion).not.toBe(
        verifierTask.verificationHistory?.[1].candidateVersion
      )
      expect(verifierTask.verificationHistory?.[1].files[0]).toMatchObject({
        path: 'artifact.txt',
        required: true,
        exists: true
      })
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 必需文件缺失时作者自报完成也不能通过，超过返工上限交负责人', async () => {
    const { ws, dataDir } = prepareWorkspace()
    let authorCalls = 0
    const verifier = new CollaborationVerificationService(dataDir)
    const runner = async (request: { description: string }): Promise<SwarmMemberResult> => {
      if (request.description === '编写交付物') {
        authorCalls += 1
        return completed('编写交付物')
      }
      if (request.description === '说明') {
        mkdirSync(join(ws.root, 'docs'), { recursive: true })
        writeFileSync(join(ws.root, 'docs', 'guide.md'), 'guide', 'utf8')
        return completed('说明')
      }
      return completed(request.description)
    }
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      verification: verifier,
      runSwarmMember: runner
    })
    try {
      const result = await executeTool(
        'swarm',
        { goal: '缺失文件验收', max_parallel: 3, watchdog_ms: 0, tasks: toolTasks({ maxReworks: 1 }) },
        ctx
      )
      expect(result.ok).toBe(false)
      const state = (result.meta as { superAgent: SuperAgentState }).superAgent
      const verifierTask = state.tasks.find((task) => task.id === 'verify')!
      const author = state.tasks.find((task) => task.id === 'author')!
      expect(state.status).toBe('partial')
      expect(author.status).toBe('completed')
      expect(author.attempts).toBe(2)
      expect(authorCalls).toBe(2)
      expect(verifierTask.status).toBe('blocked')
      expect(verifierTask.verification?.status).toBe('review')
      expect(verifierTask.verification?.reworkCount).toBe(2)
      expect(verifierTask.verificationHistory?.map((record) => record.status)).toEqual(['failed', 'failed'])
      expect(verifierTask.verificationHistory?.[0].files[0]).toMatchObject({
        path: 'artifact.txt',
        required: true,
        exists: false
      })
      expect(verifierTask.error).toContain('等待负责人决定')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 验收后交付文件变化会作废旧结论，并重新验收新版本', async () => {
    const { ws, dataDir } = prepareWorkspace()
    let authorCalls = 0
    let latest: SuperAgentState | null = null
    const verifier = new CollaborationVerificationService(dataDir)
    const runner = async (request: { description: string }): Promise<SwarmMemberResult> => {
      if (request.description === '编写交付物') {
        authorCalls += 1
        writeFileSync(join(ws.root, 'artifact.txt'), authorCalls === 1 ? 'ready' : 'ready v2', 'utf8')
        return completed('编写交付物')
      }
      if (request.description === '说明') {
        mkdirSync(join(ws.root, 'docs'), { recursive: true })
        writeFileSync(join(ws.root, 'docs', 'guide.md'), 'guide', 'utf8')
        return completed('说明')
      }
      if (request.description === '补充说明') {
        mkdirSync(join(ws.root, 'docs'), { recursive: true })
        writeFileSync(join(ws.root, 'docs', 'extra.md'), 'extra', 'utf8')
        return completed('补充说明')
      }
      return completed(request.description)
    }
    const ctx = makeToolContext(ws, {
      superMode: true,
      permissionMode: 'auto',
      agents: BUILTIN_AGENT_ROLES,
      verification: verifier,
      collaborationRuntime: runtimeOf(() => latest),
      runSwarmMember: runner
    })
    try {
      const first = await executeTool(
        'swarm',
        { goal: '验收失效', max_parallel: 3, watchdog_ms: 0, tasks: toolTasks({ maxReworks: 1 }) },
        ctx
      )
      expect(first.ok, first.error).toBe(true)
      latest = (first.meta as { superAgent: SuperAgentState }).superAgent
      const passedTask = latest.tasks.find((task) => task.id === 'verify')!
      expect(passedTask.verification?.status).toBe('passed')
      const firstCandidate = passedTask.verification!.candidateVersion

      // 验收后文件又被外部改坏：下一批必须在新的候选版本上重新验收。
      writeFileSync(join(ws.root, 'artifact.txt'), 'tampered', 'utf8')
      const second = await executeTool(
        'swarm',
        {
          goal: '验收失效',
          revision_of: 'current',
          max_parallel: 4,
          watchdog_ms: 0,
          tasks: toolTasks({ maxReworks: 1, extra: true })
        },
        ctx
      )
      expect(second.ok, second.error).toBe(true)
      const state = (second.meta as { superAgent: SuperAgentState }).superAgent
      const verifierTask = state.tasks.find((task) => task.id === 'verify')!
      const extra = state.tasks.find((task) => task.id === 'extra')!
      expect(state.status).toBe('completed')
      expect(state.planRevision).toBe(2)
      expect(extra.attempts).toBe(1)
      expect(state.tasks.find((task) => task.id === 'docs')?.attempts).toBe(1)
      expect(authorCalls).toBe(2)
      expect(verifierTask.attempts).toBe(3)
      expect(verifierTask.verification?.status).toBe('passed')
      expect(verifierTask.verification?.candidateVersion).not.toBe(firstCandidate)
      expect(verifierTask.verificationHistory?.[0].status).toBe('stale')
      expect(verifierTask.verificationHistory?.some((record) => record.status === 'failed')).toBe(true)
      expect(verifierTask.verificationHistory?.at(-1)?.status).toBe('passed')
      expect(verifierTask.verificationHistory?.[0].error).toContain('验收后交付文件已变化')
    } finally {
      ws.cleanup()
    }
  })
})
})

describe('super-agent', () => {
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function completed(title: string): SwarmMemberResult {
  return {
    status: 'completed',
    summary: `${title} 已完成`,
    steps: 2,
    usage: { inputTokens: 10, outputTokens: 10 }
  }
}

function ctxWith(
  workspace: ReturnType<typeof makeTempWorkspace>,
  runner: (request: SwarmMemberRequest) => Promise<SwarmMemberResult>,
  overrides: Partial<ToolContext> = {}
): { ctx: ToolContext; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  const ctx = makeToolContext(workspace, {
    superMode: true,
    permissionMode: 'auto',
    emit: (event) => events.push(event as unknown as Record<string, unknown>),
    progress: (note, options) => events.push({ type: 'progress', note, ...options }),
    runSwarmMember: runner,
    ...overrides
  })
  return { ctx, events }
}

function tasksOf(result: { meta?: Record<string, unknown> }): SuperAgentState {
  return (result.meta as { superAgent: SuperAgentState }).superAgent
}

describe('Super-Agent Router / Worker', () => {
  it('@core:swarm 按 DAG 依赖调度，并在上限内并行 Worker', async () => {
    const ws = makeTempWorkspace()
    const starts: Record<string, number> = {}
    const ends: Record<string, number> = {}
    let running = 0
    let maxRunning = 0
    const { ctx } = ctxWith(ws, async (request) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      starts[request.description] = Date.now()
      await sleep(request.description === 'B' ? 60 : 25)
      ends[request.description] = Date.now()
      running -= 1
      return completed(request.description)
    })
    try {
      const result = await executeTool('swarm', {
        goal: '完成 A/B/C',
        max_parallel: 2,
        watchdog_ms: 0,
        tasks: [
          { id: 'a', title: 'A', prompt: '做 A', deliverable: 'A 的成果' },
          { id: 'b', title: 'B', prompt: '做 B', deliverable: 'B 的成果' },
          {
            id: 'c',
            title: 'C',
            prompt: '做 C',
            deliverable: 'C 的成果',
            depends_on: ['a'],
            needs: [{ task_id: 'a', result: 'A 的成果' }]
          }
        ]
      }, ctx)
      expect(result.ok, result.error).toBe(true)
      const state = tasksOf(result)
      expect(state.status).toBe('completed')
      expect(state.tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed'])
      expect(maxRunning).toBeLessThanOrEqual(2)
      expect(maxRunning).toBe(2)
      expect(starts.C).toBeGreaterThanOrEqual(ends.A)
      expect(state.projectId).toMatch(/^project_[0-9a-f]{12}$/)
      expect(state.revision).toBeGreaterThan(0)
      for (const task of state.tasks) {
        expect(task.taskId).toMatch(/^task_[0-9a-f]{12}$/)
        expect(task.currentAttemptId).toContain('_a1')
        expect(task.attemptHistory).toHaveLength(1)
        expect(task.attemptHistory?.[0]).toMatchObject({ status: 'delivered', source: 'router' })
        expect(task.statusHistory?.some((change) => change.to === 'running' && change.source === 'router')).toBe(true)
        expect(task.statusHistory?.some((change) => change.to === 'delivered' && change.source === 'worker')).toBe(true)
      }
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 失败任务阻塞下游，独立任务继续并返回部分结果', async () => {
    const ws = makeTempWorkspace()
    const { ctx } = ctxWith(ws, async (request) => {
      if (request.description === 'A') {
        return { status: 'failed', summary: '', steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, error: '模拟失败' }
      }
      return completed(request.description)
    })
    try {
      const result = await executeTool('swarm', {
        goal: '失败测试',
        watchdog_ms: 0,
        tasks: [
          { id: 'a', title: 'A', prompt: '做 A', deliverable: 'A 的成果' },
          {
            id: 'b',
            title: 'B',
            prompt: '做 B',
            deliverable: 'B 的成果',
            depends_on: ['a'],
            needs: [{ task_id: 'a', result: 'A 的成果' }]
          },
          { id: 'c', title: 'C', prompt: '做 C', deliverable: 'C 的成果' }
        ]
      }, ctx)
      expect(result.ok).toBe(false)
      const state = tasksOf(result)
      expect(state.status).toBe('partial')
      expect(state.tasks.find((task) => task.id === 'a')?.status).toBe('failed')
      expect(state.tasks.find((task) => task.id === 'b')?.status).toBe('blocked')
      expect(state.tasks.find((task) => task.id === 'c')?.status).toBe('completed')
      expect(String(result.error)).toContain('2/3')
      expect(String(result.hint)).toContain('C')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 失败可按 retry 重试，依赖任务等待重试结果', async () => {
    const ws = makeTempWorkspace()
    const calls: string[] = []
    const { ctx } = ctxWith(ws, async (request) => {
      calls.push(request.description)
      if (request.description === 'A' && calls.filter((item) => item === 'A').length === 1) {
        return { status: 'failed', summary: '', steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, error: '第一次失败' }
      }
      return completed(request.description)
    })
    try {
      const result = await executeTool('swarm', {
        goal: '重试测试',
        retry: 1,
        watchdog_ms: 0,
        tasks: [
          { id: 'a', title: 'A', prompt: '做 A', deliverable: 'A 的成果' },
          {
            id: 'b',
            title: 'B',
            prompt: '做 B',
            deliverable: 'B 的成果',
            depends_on: ['a'],
            needs: [{ task_id: 'a', result: 'A 的成果' }]
          }
        ]
      }, ctx)
      expect(result.ok, result.error).toBe(true)
      const state = tasksOf(result)
      expect(calls.filter((item) => item === 'A')).toHaveLength(2)
      expect(state.tasks[0].attempts).toBe(2)
      expect(state.tasks.every((task) => task.status === 'completed')).toBe(true)
      const retried = state.tasks[0]
      expect(retried.currentAttemptId).toContain('_a2')
      expect(retried.attemptHistory?.map((attempt) => attempt.status)).toEqual(['failed', 'delivered'])
      expect(retried.statusHistory?.some((change) => change.to === 'waiting' && change.source === 'router')).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm Watchdog 停止无进展 Worker 并标记 stalled', async () => {
    const ws = makeTempWorkspace()
    const { ctx } = ctxWith(ws, (request) =>
      new Promise<SwarmMemberResult>((resolve, reject) => {
        const signal = request.signal
        const timer = setTimeout(() => resolve(completed(request.description)), 500)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    )
    try {
      const result = await executeTool('swarm', {
        goal: '看门狗测试',
        watchdog_ms: 80,
        tasks: [{ id: 'a', title: 'A', prompt: '永远没有进展', deliverable: 'A 的成果' }]
      }, ctx)
      expect(result.ok).toBe(false)
      const state = tasksOf(result)
      expect(state.tasks[0].status).toBe('stalled')
      expect(state.tasks[0].error).toContain('Watchdog')
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 拒绝循环依赖，并只给 Router 暴露只读与分派工具', async () => {
    const ws = makeTempWorkspace()
    const { ctx } = ctxWith(ws, async (request) => completed(request.description))
    try {
      const result = await executeTool('swarm', {
        goal: '环',
        tasks: [
          {
            id: 'a',
            title: 'A',
            prompt: '做 A',
            deliverable: 'A 的成果',
            depends_on: ['b'],
            needs: [{ task_id: 'b', result: 'B 的成果' }]
          },
          {
            id: 'b',
            title: 'B',
            prompt: '做 B',
            deliverable: 'B 的成果',
            depends_on: ['a'],
            needs: [{ task_id: 'a', result: 'A 的成果' }]
          }
        ]
      }, ctx)
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain('互相等待')

      const routerTools = superRouterToolDefinitions(true).map((tool) => tool.name)
      expect(routerTools).toContain('swarm')
      expect(routerTools).toContain('read_file')
      expect(routerTools).not.toContain('write_file')
      expect(routerTools).not.toContain('run_command')
      expect(routerTools).not.toContain('remember')
      expect(routerTools).not.toContain('browser_open')
      const normalTools = toolDefinitionsForRun(false, false, true).map((tool) => tool.name)
      expect(normalTools).toContain('swarm')
    } finally {
      ws.cleanup()
    }
  })
})

describe('background-dispatch.test.ts', () => {
  it('@core:swarm 派工立即返回任务编号，B 未结束时 A/C 继续，单项停止 B 不影响它们', async () => {
    const ws = makeTempWorkspace()
    const starts = new Map<string, number>()
    const ends = new Map<string, number>()
    const stopped = new Map<string, () => void>()
    const runtime = {
      registerTask: (control: { taskId: string; stop: () => void }) => {
        stopped.set(control.taskId, control.stop)
      },
      unregisterTask: (input: { taskId: string }) => {
        stopped.delete(input.taskId)
      }
    }
    const runner = (request: SwarmMemberRequest): Promise<SwarmMemberResult> =>
      new Promise((resolve, reject) => {
        const title = request.description
        starts.set(title, Date.now())
        if (title === 'B') {
          const timer = setTimeout(() => {
            ends.set(title, Date.now())
            resolve(completed('B'))
          }, 1_500)
          request.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              ends.set(title, Date.now())
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true }
          )
          return
        }
        setTimeout(() => {
          ends.set(title, Date.now())
          resolve(completed(title))
        }, title === 'A' ? 25 : 45)
      })
    const { ctx, events } = ctxWith(ws, runner, {
      deferSwarm: true,
      collaborationRuntime: runtime
    })
    try {
      const startedAt = Date.now()
      const result = await executeTool('swarm', {
        goal: '后台派工',
        max_parallel: 2,
        watchdog_ms: 0,
        tasks: [
          { id: 'a', title: 'A', prompt: '做 A', deliverable: 'A 的成果' },
          { id: 'b', title: 'B', prompt: '做 B', deliverable: 'B 的成果' },
          {
            id: 'c',
            title: 'C',
            prompt: '做 C',
            deliverable: 'C 的成果',
            depends_on: ['a'],
            needs: [{ task_id: 'a', result: 'A 的成果' }]
          }
        ]
      }, ctx)
      expect(Date.now() - startedAt).toBeLessThan(700)
      expect(result.ok).toBe(true)
      expect(result.meta).toMatchObject({ dispatched: true, complete: false })
      const dispatchTaskIds = (result.meta as { taskIds: string[] }).taskIds
      expect(dispatchTaskIds).toHaveLength(3)
      expect(stopped.has(dispatchTaskIds[0]) && stopped.has(dispatchTaskIds[1])).toBe(true)

      const stateOf = (): { tasks: SuperAgentState['tasks'] } | null => {
        const last = [...events].reverse().find((event) => event.type === 'super_updated') as
          | { state?: SuperAgentState }
          | undefined
        return last?.state ?? null
      }
      const waitFor = async (check: () => boolean, timeoutMs = 3_000): Promise<void> => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
          if (check()) return
          await sleep(15)
        }
        throw new Error('等待后台任务状态超时')
      }
      await waitFor(() => {
        const state = stateOf()
        return Boolean(
          state &&
            state.tasks.find((task) => task.title === 'A')?.status === 'completed' &&
            state.tasks.find((task) => task.title === 'C')?.status === 'completed'
        )
      })
      const beforeStop = stateOf()
      expect(beforeStop?.tasks.find((task) => task.title === 'B')?.status).toBe('running')
      expect(starts.get('C')!).toBeGreaterThanOrEqual(ends.get('A')!)
      stopped.get(dispatchTaskIds[1])?.()
      await waitFor(() => stateOf()?.tasks.find((task) => task.title === 'B')?.status === 'cancelled')
      const finalState = stateOf()
      expect(finalState?.tasks.find((task) => task.title === 'A')?.status).toBe('completed')
      expect(finalState?.tasks.find((task) => task.title === 'C')?.status).toBe('completed')
      expect(finalState?.tasks.find((task) => task.title === 'B')?.error).toContain('单独停止')
      expect(stopped.has(dispatchTaskIds[1])).toBe(false)
    } finally {
      ws.cleanup()
    }
  })
})

describe('recovery-retry.test.ts', () => {
  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  function swarmStates(events: RuntimeEvent[]): SuperAgentState[] {
    return events
      .filter((event): event is Extract<RuntimeEvent, { type: 'super_updated' }> => event.type === 'super_updated')
      .map((event) => event.state)
      .filter((state): state is SuperAgentState => Boolean(state))
  }

  it('@core:swarm 单独重试只运行指定任务：沿用 taskId、尝试次数递增、已完成任务不重跑', async () => {
    const ws = makeTempWorkspace()
    const provider = new (class implements Provider {
      readonly calls: ProviderStreamRequest[] = []
      async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
        this.calls.push(request)
        yield { type: 'text_delta', text: '重试完成：登录页已修复。' }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
      }
    })()
    const events: RuntimeEvent[] = []
    const projectId = 'project_retry0001'
    const task: SuperAgentState['tasks'][number] = {
      id: 'a',
      taskId: 'task_retry000001',
      index: 0,
      title: '修复登录页',
      prompt: '旧的截断简报',
      promptFull: '完整简报：修复登录页的账号锁定提示，并运行登录测试。',
      role: 'general',
      status: 'failed',
      dependsOn: [],
      attempts: 1,
      currentAttemptId: 'attempt_retry000001_a1',
      attemptHistory: [
        {
          id: 'attempt_retry000001_a1',
          taskId: 'task_retry000001',
          attempt: 1,
          status: 'failed',
          startedAt: 1,
          finishedAt: 2,
          source: 'router',
          error: '旧错误'
        }
      ],
      statusHistory: [
        {
          id: 'attempt_retry000001_a1:failed',
          taskId: 'task_retry000001',
          attemptId: 'attempt_retry000001_a1',
          to: 'failed',
          at: 2,
          source: 'worker',
          reason: '旧错误'
        }
      ],
      error: '旧错误'
    }
    try {
      const result = await runAgent({
        runId: 'run_retry',
        sessionId: 'session_retry',
        provider,
        model: MODEL,
        systemPrompt: '你是测试助手。',
        history: [],
        userMessage: userMessage('单独重试'),
        workspace: ws.root,
        permissionMode: 'auto',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        onPermission: async () => 'once',
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        superMode: true,
        retrySwarmTask: { projectId, runId: 'super_retry', goal: '修复登录页', task }
      })
      expect(result.reason).toBe('complete')
      // 单项重试不经过 Router 模型，只调用一次 Worker。
      expect(provider.calls).toHaveLength(1)
      expect(provider.calls[0].system).toContain('## 集群成员')
      const workerPrompt = provider.calls[0].messages
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.content)
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      expect(workerPrompt).toContain('完整简报：修复登录页的账号锁定提示')
      const swarmBlock = result.messages
        .flatMap((message) => message.content)
        .find((block): block is ToolUseBlock => block.type === 'tool_use' && block.name === 'swarm')
      expect(swarmBlock?.result?.ok).toBe(true)
      const state = (swarmBlock?.result?.meta as { superAgent?: SuperAgentState } | undefined)?.superAgent
      expect(state?.projectId).toBe(projectId)
      expect(state?.tasks).toHaveLength(1)
      const retried = state?.tasks[0]
      expect(retried?.taskId).toBe('task_retry000001')
      expect(retried?.status).toBe('completed')
      expect(retried?.attempts).toBe(2)
      expect(retried?.currentAttemptId).toContain('_a2')
      expect(retried?.attemptHistory?.map((attempt) => attempt.status)).toEqual(['failed', 'delivered'])
      const merged = swarmStates(events).at(-1)
      expect(merged?.tasks[0].attemptHistory).toHaveLength(2)
      expect(merged?.tasks[0].statusHistory?.some((change) => change.source === 'user' && change.to === 'waiting')).toBe(
        true
      )
    } finally {
      ws.cleanup()
    }
  })

  it('@core:swarm 等用户批准时暂停看门狗，批准后继续完成', async () => {
    const ws = makeTempWorkspace()
    // 工作区外的写入会触发审批；等审批时间超过看门狗阈值。
    const outsideName = `${basename(ws.root)}-approval.txt`
    const outsidePath = join(ws.root, '..', outsideName)
    class ApprovalProvider implements Provider {
      readonly calls: ProviderStreamRequest[] = []
      private workerSteps = 0
      private parentCalls = 0
      async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
        this.calls.push(request)
        if (!request.system.includes('## 集群成员')) {
          this.parentCalls += 1
          if (this.parentCalls === 1) {
            yield { type: 'tool_call_start', index: 0, id: 'swarm-approval', name: 'swarm' }
            yield {
              type: 'tool_call_end',
              index: 0,
              id: 'swarm-approval',
              name: 'swarm',
              input: {
                goal: '审批等待测试',
                max_parallel: 1,
                watchdog_ms: 120,
                tasks: [{ id: 'a', title: '需要审批的写入', prompt: '写 approval.txt', deliverable: '写入 approval.txt' }]
              }
            }
          } else {
            yield { type: 'text_delta', text: '本轮结束。' }
          }
          yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
          return
        }
        this.workerSteps += 1
        if (this.workerSteps === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'write-approval', name: 'write_file' }
          yield {
            type: 'tool_call_end',
            index: 0,
            id: 'write-approval',
            name: 'write_file',
            input: { path: `../${outsideName}`, content: '等审批后写入' }
          }
          yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
          return
        }
        yield { type: 'text_delta', text: '审批已通过，写入完成。' }
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      }
    }
    const provider = new ApprovalProvider()
    const events: RuntimeEvent[] = []
    const waitingCalls: boolean[] = []
    const controls = new Map<string, { attemptId: string; stop: () => void; setWaiting?: (waiting: boolean) => void }>()
    const runtime = {
      registerTask: (control: {
        taskId: string
        attemptId: string
        stop: () => void
        setWaiting?: (waiting: boolean) => void
      }) => {
        controls.set(control.taskId, control)
      },
      unregisterTask: (input: { taskId: string; attemptId: string }) => {
        if (controls.get(input.taskId)?.attemptId === input.attemptId) controls.delete(input.taskId)
      },
      setTaskWaiting: (input: { taskId: string; attemptId: string; waiting: boolean }) => {
        const control = controls.get(input.taskId)
        if (!control || control.attemptId !== input.attemptId) return
        waitingCalls.push(input.waiting)
        control.setWaiting?.(input.waiting)
      }
    }
    try {
      const result = await runAgent({
        runId: 'run_approval_wait',
        sessionId: 'session_approval_wait',
        provider,
        model: MODEL,
        systemPrompt: '你是测试助手。',
        history: [],
        userMessage: userMessage('派一个需要审批的成员'),
        workspace: ws.root,
        permissionMode: 'ask',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        // 等审批的时间超过看门狗阈值；如果看门狗没暂停，Worker 会被误杀。
        onPermission: async () => {
          await new Promise((resolve) => setTimeout(resolve, 360))
          return 'once'
        },
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        superMode: true,
        collaborationRuntime: runtime
      })
      expect(result.reason).toBe('complete')
      expect(waitingCalls).toEqual([true, false])
      const state = swarmStates(events).at(-1)
      expect(state?.tasks[0].status).toBe('completed')
      expect(state?.tasks[0].waitingForApproval).toBeUndefined()
      expect(state?.tasks[0].error).toBeUndefined()
      const waitingSnapshots = swarmStates(events).filter((snapshot) => snapshot.tasks[0]?.waitingForApproval)
      expect(waitingSnapshots.length).toBeGreaterThan(0)
      expect(readFileSync(outsidePath, 'utf8')).toBe('等审批后写入')
      mkdirSync(join(process.cwd(), 'test-results'), { recursive: true })
      writeFileSync(
        join(process.cwd(), 'test-results', 't07-approval-wait-evidence.json'),
        JSON.stringify(
          {
            watchdogMs: 120,
            approvalWaitMs: 360,
            waitingCalls,
            finalTask: {
              status: state?.tasks[0].status,
              waitingForApproval: state?.tasks[0].waitingForApproval ?? null,
              error: state?.tasks[0].error ?? null
            },
            file: { path: outsidePath, exists: existsSync(outsidePath), content: readFileSync(outsidePath, 'utf8') }
          },
          null,
          2
        ),
        'utf8'
      )
    } finally {
      rmSync(outsidePath, { force: true })
      ws.cleanup()
    }
  })

  it('@core:swarm 单独取消等待审批的任务：停止等待、不写文件，其他成员继续完成', async () => {
    const ws = makeTempWorkspace()
    const outsideName = `${basename(ws.root)}-b.txt`
    const outsidePath = join(ws.root, '..', outsideName)
    class TwoTaskProvider implements Provider {
      readonly calls: ProviderStreamRequest[] = []
      private workerSteps = new Map<string, number>()
      async *stream(request: ProviderStreamRequest): AsyncGenerator<ProviderStreamEvent> {
        this.calls.push(request)
        if (!request.system.includes('## 集群成员')) {
          const parentCalls = this.calls.filter((call) => !call.system.includes('## 集群成员')).length
          if (parentCalls === 1) {
            yield { type: 'tool_call_start', index: 0, id: 'swarm-stop-wait', name: 'swarm' }
            yield {
              type: 'tool_call_end',
              index: 0,
              id: 'swarm-stop-wait',
              name: 'swarm',
              input: {
                goal: '取消等待测试',
                max_parallel: 2,
                watchdog_ms: 0,
                tasks: [
                  { id: 'a', title: 'A', prompt: '只汇报，不改文件', deliverable: 'A 的结论' },
                  { id: 'b', title: 'B', prompt: `写 ../${outsideName}`, deliverable: `写入 ${outsideName}` }
                ]
              }
            }
          } else {
            yield { type: 'text_delta', text: '本轮结束。' }
          }
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
          return
        }
        const firstUser = request.messages.find((message) => message.role === 'user')
        const prompt =
          firstUser?.content.map((block) => (block.type === 'text' ? block.text : '')).join('') ?? ''
        const label = prompt.includes(outsideName) ? 'b' : 'a'
        const step = (this.workerSteps.get(label) ?? 0) + 1
        this.workerSteps.set(label, step)
        if (label === 'b' && step === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'write-b', name: 'write_file' }
          yield {
            type: 'tool_call_end',
            index: 0,
            id: 'write-b',
            name: 'write_file',
            input: { path: `../${outsideName}`, content: 'B 的内容' }
          }
        } else {
          yield { type: 'text_delta', text: label === 'a' ? 'A 完成。' : 'B 完成。' }
        }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      }
    }
    const provider = new TwoTaskProvider()
    const events: RuntimeEvent[] = []
    const waitingCalls: boolean[] = []
    const controls = new Map<string, { attemptId: string; stop: () => void; setWaiting?: (waiting: boolean) => void }>()
    const runtime = {
      registerTask: (control: {
        taskId: string
        attemptId: string
        stop: () => void
        setWaiting?: (waiting: boolean) => void
      }) => {
        controls.set(control.taskId, control)
      },
      unregisterTask: (input: { taskId: string; attemptId: string }) => {
        if (controls.get(input.taskId)?.attemptId === input.attemptId) controls.delete(input.taskId)
      },
      setTaskWaiting: (input: { taskId: string; attemptId: string; waiting: boolean }) => {
        const control = controls.get(input.taskId)
        if (!control || control.attemptId !== input.attemptId) return
        waitingCalls.push(input.waiting)
        control.setWaiting?.(input.waiting)
      }
    }
    let releasePermission: (decision: 'once') => void = () => undefined
    const permissionGate = new Promise<'once'>((resolve) => {
      releasePermission = resolve
    })
    try {
      const runPromise = runAgent({
        runId: 'run_stop_waiting',
        sessionId: 'session_stop_waiting',
        provider,
        model: MODEL,
        systemPrompt: '你是测试助手。',
        history: [],
        userMessage: userMessage('派两个成员，其中一个等审批'),
        workspace: ws.root,
        permissionMode: 'ask',
        snapshotDir: ws.snapshotDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        onPermission: () => permissionGate,
        onAskUser: async () => ({ value: 'A', label: 'A' }),
        superMode: true,
        collaborationRuntime: runtime
      })
      const deadline = Date.now() + 3_000
      let waitingTaskId = ''
      while (Date.now() < deadline) {
        const state = swarmStates(events).at(-1)
        const waitingTask = state?.tasks.find((task) => task.title === 'B')
        if (waitingTask?.waitingForApproval) {
          waitingTaskId = waitingTask.taskId ?? waitingTask.id
          break
        }
        await sleep(10)
      }
      expect(waitingTaskId, '没有进入等待批准状态').toBeTruthy()
      const beforeStop = swarmStates(events).at(-1)
      expect(beforeStop?.tasks.find((task) => task.title === 'A')?.status).toBe('completed')
      expect(beforeStop?.tasks.find((task) => task.title === 'B')?.status).toBe('running')
      expect(controls.get(waitingTaskId)?.attemptId).toContain('_a1')
      controls.get(waitingTaskId)?.stop()
      const result = await Promise.race([
        runPromise,
        sleep(3_000).then(() => {
          throw new Error('停止等待后运行没有结束')
        })
      ])
      expect(result.reason).toBe('complete')
      const finalState = swarmStates(events).at(-1)
      expect(finalState?.tasks.find((task) => task.title === 'A')?.status).toBe('completed')
      expect(finalState?.tasks.find((task) => task.title === 'B')?.status).toBe('cancelled')
      expect(finalState?.tasks.find((task) => task.title === 'B')?.error).toContain('单独停止')
      expect(waitingCalls).toContain(true)
      expect(waitingCalls.at(-1)).toBe(false)
      expect(existsSync(outsidePath)).toBe(false)
      mkdirSync(join(process.cwd(), 'test-results'), { recursive: true })
      writeFileSync(
        join(process.cwd(), 'test-results', 't07-stop-wait-evidence.json'),
        JSON.stringify(
          {
            beforeCancel: {
              taskA: beforeStop?.tasks.find((task) => task.title === 'A')?.status,
              taskB: beforeStop?.tasks.find((task) => task.title === 'B')?.status,
              taskBWaiting: beforeStop?.tasks.find((task) => task.title === 'B')?.waitingForApproval === true,
              fileExists: existsSync(outsidePath)
            },
            afterCancel: {
              taskA: finalState?.tasks.find((task) => task.title === 'A')?.status,
              taskB: finalState?.tasks.find((task) => task.title === 'B')?.status,
              taskBError: finalState?.tasks.find((task) => task.title === 'B')?.error,
              fileExists: existsSync(outsidePath)
            },
            waitingCalls,
            runFinished: result.reason
          },
          null,
          2
        ),
        'utf8'
      )
      releasePermission('once')
    } finally {
      rmSync(outsidePath, { force: true })
      ws.cleanup()
    }
  })
})
})
