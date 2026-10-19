/**
 * R7 审计 · Goal 长期任务最小复现（本地 mock SSE 模型服务 + 产品原生 Goal 事件）。
 *
 * 覆盖：
 * - A：>10 轮真实 Goal 轮次推进（12 轮完成，update_goal(completed)+evidence 校验通过）；
 * - B：暂停后不再自动开新工作 → 模拟应用重启（active→paused 恢复）→ 继续同一个 Goal，
 *      从下一轮接着做（不重建、不重复、预算计数不重置）；
 * - C：用户手动「结束目标」→ cancelled（不是 completed），停止后不再运行；
 * - D：连续无进展 → 诚实停止（no_progress，不是完成）；
 * - E：模型反复谎报 completed 但缺证据 → 永远不标完成，最后按轮次预算停止；
 * - F：轮次上限按目标智能估算（无需手动设置，上限 200）。
 *
 * 全部使用本地 mock，不产生真实模型费用；数据目录在 Morrow/tmp/audit/**。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Goal } from '../../src/shared/types'
import {
  AUDIT_MODEL_ID,
  auditProviderConfig,
  cleanupDir,
  createAuditStores,
  makeAuditDir,
  makeCapturedWindow,
  startMockSseServer,
  waitFor,
  type MockReply,
  type MockSseServer
} from './helpers'
import { inferGoalRounds, GOAL_MAX_ROUNDS } from '../../src/main/services/goal-budget'
import { recoverGoalsOnStartup } from '../../src/main/services/goal-recovery'
import type { AgentService } from '../../src/main/services/agent-service'
import type { SessionStore } from '../../src/main/services/session-store'

interface ScenarioOptions {
  targetRounds: number
  /** true = 每轮只做只读查询，没有真实推进 */
  noProgress?: boolean
  /** true = 每轮都谎报 completed 但不提供 evidence */
  claimCompletedNoEvidence?: boolean
}

/** 按「真实 Goal 轮次」响应：第 N 轮第一次请求产出工具调用，第二次请求给出本轮收尾文本 */
function makeGoalHandler(options: ScenarioOptions): (body: Record<string, unknown>) => MockReply {
  return (body) => {
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
    let hasToolUseAfterLastUser = false
    for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        hasToolUseAfterLastUser = true
      }
    }
    // 同一轮里的第二次请求：本轮工具已执行，收尾
    if (hasToolUseAfterLastUser) return { text: `第 ${round} 轮收尾。` }
    if (options.noProgress) {
      return { toolCalls: [{ name: 'read_file', input: { path: 'in/data.txt' } }] }
    }
    if (options.claimCompletedNoEvidence) {
      return { toolCalls: [{ name: 'update_goal', input: { status: 'completed', summary: `第 ${round} 轮我宣布完成` } }] }
    }
    if (round >= options.targetRounds) {
      return {
        toolCalls: [
          {
            name: 'update_goal',
            input: { status: 'completed', summary: '全部批次完成并核对', evidence: ['out/round-1.md'] }
          }
        ]
      }
    }
    return {
      toolCalls: [
        {
          name: 'write_file',
          input: { path: `out/round-${round}.md`, content: `round ${round} progress\n` }
        }
      ]
    }
  }
}

async function setupScenario(name: string, options: ScenarioOptions): Promise<{
  dir: string
  workspace: string
  dataDir: string
  server: MockSseServer
  sessionStore: SessionStore
  service: AgentService
  sessionId: string
  events: ReturnType<typeof makeCapturedWindow>['events']
  window: ReturnType<typeof makeCapturedWindow>['window']
  cleanup: () => Promise<void>
}> {
  const dir = makeAuditDir(name)
  const workspace = join(dir, 'ws')
  const dataDir = join(dir, 'data')
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(workspace, 'in', 'data.txt'), 'progress source\n', 'utf8')
  const server = await startMockSseServer(makeGoalHandler(options))
  const provider = auditProviderConfig(server.baseUrl)
  const stores = createAuditStores(dataDir, provider)
  const session = stores.sessionStore.create({
    workspace,
    model: { providerId: provider.id, modelId: AUDIT_MODEL_ID },
    permissionMode: 'auto',
    defaultModel: { providerId: provider.id, modelId: AUDIT_MODEL_ID },
    defaultPermission: 'auto',
    title: 'R7 Goal 审计'
  })
  const captured = makeCapturedWindow()
  return {
    dir,
    workspace,
    dataDir,
    server,
    sessionStore: stores.sessionStore,
    service: stores.service,
    sessionId: session.id,
    events: captured.events,
    window: captured.window,
    cleanup: async () => {
      stores.service.dispose()
      await server.close()
      cleanupDir(dir)
    }
  }
}

function goalOf(sessionStore: SessionStore, sessionId: string): Goal | null {
  return sessionStore.get(sessionId)?.goal ?? null
}

function outFiles(workspace: string): string[] {
  const dir = join(workspace, 'out')
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

const cleanupQueue: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const cleanup = cleanupQueue.pop()
    if (cleanup) await cleanup()
  }
})

describe('Goal 长期任务（本地 mock 模型 + 产品原生 Goal 循环）', () => {
  it('A：同一个 Goal 真实推进 12 轮后完成（>10 轮），完成需 evidence 校验', async () => {
    const scenario = await setupScenario('goal-a', { targetRounds: 12 })
    cleanupQueue.push(scenario.cleanup)
    await scenario.service.startGoal(
      scenario.sessionId,
      '完成 12 批资料的登记与核对，每轮处理一批，最后输出进度报告',
      16,
      scenario.window,
      { maxToolCalls: 100, maxActiveMs: 20 * 60_000, maxNoProgressRounds: 3 }
    )
    await waitFor(() => goalOf(scenario.sessionStore, scenario.sessionId)?.status === 'completed', 30_000)
    const goal = goalOf(scenario.sessionStore, scenario.sessionId)
    expect(goal).not.toBeNull()
    expect(goal!.status).toBe('completed')
    expect(goal!.round).toBe(12)
    expect(goal!.round).toBeGreaterThan(10)
    expect(goal!.evidence).toContain('out/round-1.md')
    expect(existsSync(join(scenario.workspace, 'out', 'round-1.md'))).toBe(true)
    expect(goal!.toolCalls).toBeGreaterThanOrEqual(11)
    expect(goal!.activeMs).toBeGreaterThan(0)
    expect(goal!.noProgressRounds).toBe(0)
    expect(goal!.maxRounds).toBe(16)
    expect(goal!.maxRoundsAuto).toBe(false)
    expect(goal!.completedAt).toBeTruthy()
    // 12 轮中每个完成轮各写一份进度文件（每轮一次，不重复）；模型/进程边界下允许最多少一份
    const roundFiles = outFiles(scenario.workspace).filter((file) => /^round-\d+\.md$/.test(file))
    expect(roundFiles.length).toBeGreaterThanOrEqual(10)
    expect(new Set(roundFiles).size).toBe(roundFiles.length)
    // Goal 事件来自产品原生循环：goal_updated 覆盖每轮
    const goalEvents = scenario.events.filter((event) => event.type === 'goal_updated')
    expect(goalEvents.length).toBeGreaterThanOrEqual(11)
  }, 60_000)

  it('B：暂停后不再干活；重启后 active→paused 可恢复，继续同一个 Goal 从下一轮接着做', async () => {
    const scenario = await setupScenario('goal-b', { targetRounds: 12 })
    cleanupQueue.push(scenario.cleanup)
    await scenario.service.startGoal(
      scenario.sessionId,
      '分批完成 12 批资料处理，每轮一批',
      16,
      scenario.window,
      { maxToolCalls: 100, maxActiveMs: 20 * 60_000, maxNoProgressRounds: 3 }
    )
    await waitFor(() => goalOf(scenario.sessionStore, scenario.sessionId)?.round === 4, 20_000)
    await waitFor(() => outFiles(scenario.workspace).filter((file) => file.startsWith('round-')).length >= 3, 10_000)
    scenario.service.pauseGoal(scenario.sessionId, scenario.window)
    await waitFor(() => goalOf(scenario.sessionStore, scenario.sessionId)?.status === 'paused', 10_000)
    // 等本轮 abort 的收尾动作（interrupted 消息）落盘，再记录基线
    await waitFor(() => !scenario.service.isSessionRunning(scenario.sessionId), 10_000)
    const paused = goalOf(scenario.sessionStore, scenario.sessionId)!
    expect(paused.stopReason).toBe('user_paused')
    const messagesAtPause = scenario.sessionStore.get(scenario.sessionId)!.messages.length
    const requestsAtPause = scenario.server.requests
    // 暂停后 1.2 秒内不得出现新的自主轮次/业务动作
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const afterPause = goalOf(scenario.sessionStore, scenario.sessionId)!
    expect(afterPause.status).toBe('paused')
    expect(afterPause.round).toBe(paused.round)
    expect(scenario.sessionStore.get(scenario.sessionId)!.messages.length).toBe(messagesAtPause)
    expect(scenario.server.requests).toBe(requestsAtPause)

    // 模拟「应用进程被杀/重启」：磁盘上的目标仍是 paused；先人为置回 active 模拟崩溃前状态
    const persisted = scenario.sessionStore.get(scenario.sessionId)!
    persisted.goal!.status = 'active'
    persisted.goal!.stopReason = undefined
    scenario.sessionStore.save(persisted)
    // 重启：新的 SessionStore/AgentService 读同一数据目录，启动恢复把 active→paused
    const restarted = createAuditStores(scenario.dataDir, auditProviderConfig(scenario.server.baseUrl))
    cleanupQueue.push(async () => restarted.service.dispose())
    const recovered = recoverGoalsOnStartup(restarted.sessionStore)
    expect(recovered).toBe(1)
    const recoveredGoal = goalOf(restarted.sessionStore, scenario.sessionId)!
    expect(recoveredGoal.status).toBe('paused')
    expect(recoveredGoal.stopReason).toBe('app_restarted')
    // 轮次与预算计数不因重启重置
    expect(recoveredGoal.round).toBe(paused.round)
    expect(recoveredGoal.toolCalls).toBeGreaterThanOrEqual(paused.toolCalls ?? 0)
    expect(recoveredGoal.id).toBe(paused.id)

    const resumed = restarted.service.resumeGoal(scenario.sessionId, scenario.window)
    expect(resumed.goal.id).toBe(paused.id)
    expect(resumed.goal.round).toBe(paused.round + 1)
    await waitFor(() => goalOf(restarted.sessionStore, scenario.sessionId)?.status === 'completed', 30_000)
    const finished = goalOf(restarted.sessionStore, scenario.sessionId)!
    expect(finished.status).toBe('completed')
    expect(finished.round).toBe(12)
    // 继续时没有重复做已经做过的轮次：每个完成的轮次最多一份进度文件，且恢复后确实推进到了后面的轮次。
    // （暂停发生在第 4 轮写入边界，那一轮可能被中断没写文件，因此允许 10/11 份。）
    const roundFiles = outFiles(scenario.workspace).filter((file) => /^round-\d+\.md$/.test(file))
    expect(roundFiles.length).toBeGreaterThanOrEqual(10)
    expect(new Set(roundFiles).size).toBe(roundFiles.length)
    const roundsWritten = new Set(roundFiles.map((file) => Number(/round-(\d+)/.exec(file)?.[1] ?? 0)))
    expect(roundsWritten.has(11)).toBe(true)
  }, 90_000)

  it('C：用户手动结束 → cancelled（不是 completed），之后不再偷偷运行', async () => {
    const scenario = await setupScenario('goal-c', { targetRounds: 12 })
    cleanupQueue.push(scenario.cleanup)
    await scenario.service.startGoal(scenario.sessionId, '长期跟踪 12 批资料，每轮一批', 16, scenario.window, {
      maxToolCalls: 100,
      maxActiveMs: 20 * 60_000,
      maxNoProgressRounds: 3
    })
    await waitFor(() => goalOf(scenario.sessionStore, scenario.sessionId)?.round === 3, 20_000)
    scenario.service.stopGoal(scenario.sessionId, scenario.window)
    await waitFor(() => !scenario.service.isSessionRunning(scenario.sessionId), 10_000)
    const stopped = goalOf(scenario.sessionStore, scenario.sessionId)!
    expect(stopped.status).toBe('cancelled')
    expect(stopped.completedAt).toBeUndefined()
    expect(stopped.stopReason).toBe('user_stopped')
    expect(stopped.cancelledAt).toBeTruthy()
    const messagesAtStop = scenario.sessionStore.get(scenario.sessionId)!.messages.length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const afterStop = goalOf(scenario.sessionStore, scenario.sessionId)!
    expect(afterStop.status).toBe('cancelled')
    expect(scenario.sessionStore.get(scenario.sessionId)!.messages.length).toBe(messagesAtStop)
  }, 60_000)

  it('D：连续无进展 → 诚实停止（no_progress，不是完成）', async () => {
    const scenario = await setupScenario('goal-d', { targetRounds: 12, noProgress: true })
    cleanupQueue.push(scenario.cleanup)
    await scenario.service.startGoal(scenario.sessionId, '持续跟踪 12 批资料并登记', 16, scenario.window, {
      maxToolCalls: 100,
      maxActiveMs: 20 * 60_000,
      maxNoProgressRounds: 3
    })
    await waitFor(() => goalOf(scenario.sessionStore, scenario.sessionId)?.status === 'paused', 30_000)
    const goal = goalOf(scenario.sessionStore, scenario.sessionId)!
    expect(goal.status).toBe('paused')
    expect(goal.stopReason).toBe('no_progress')
    expect(goal.round).toBeLessThan(16)
    expect(goal.noProgressRounds).toBeGreaterThanOrEqual(3)
    expect(goal.completedAt).toBeUndefined()
    const messagesAtStop = scenario.sessionStore.get(scenario.sessionId)!.messages.length
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(scenario.sessionStore.get(scenario.sessionId)!.messages.length).toBe(messagesAtStop)
  }, 60_000)

  it('E：模型反复谎报 completed 但无证据 → 永不标记完成，到轮次预算诚实停止', async () => {
    const scenario = await setupScenario('goal-e', { targetRounds: 12, claimCompletedNoEvidence: true })
    cleanupQueue.push(scenario.cleanup)
    await scenario.service.startGoal(scenario.sessionId, '完成一项无法验证的任务', 3, scenario.window, {
      maxToolCalls: 100,
      maxActiveMs: 20 * 60_000,
      maxNoProgressRounds: 99
    })
    await waitFor(() => goalOf(scenario.sessionStore, scenario.sessionId)?.status === 'paused', 30_000)
    const goal = goalOf(scenario.sessionStore, scenario.sessionId)!
    expect(goal.status).not.toBe('completed')
    expect(goal.completedAt).toBeUndefined()
    expect(goal.evidence).toBeUndefined()
    expect(goal.stopReason).toBe('budget_rounds')
    expect(goal.round).toBe(3)
    // 假完成被工具层拒绝：会话里能看到 update_goal 的错误结果
    const session = scenario.sessionStore.get(scenario.sessionId)!
    const updateGoalResults = session.messages.flatMap((message) =>
      message.content
        .filter((block) => block.type === 'tool_use' && block.name === 'update_goal')
        .map((block) => (block.type === 'tool_use' ? block.result : undefined))
    )
    expect(updateGoalResults.length).toBeGreaterThan(0)
    expect(updateGoalResults.every((result) => result?.ok === false)).toBe(true)
  }, 60_000)

  it('F：轮次预算由目标复杂度智能估算（无需手动设置，上限 200）', async () => {
    // 估算器本身
    expect(inferGoalRounds('写一个简短总结')).toBeLessThanOrEqual(8)
    expect(inferGoalRounds('分 12 批完成资料登记，每轮处理一批并核对，最后输出报告和网页')).toBeGreaterThanOrEqual(14)
    expect(
      inferGoalRounds('长期项目：分批处理 20 批数据，第一轮收集资料，第二轮分析对比，第三轮写报告，然后生成网页和表格，持续迭代')
    ).toBeGreaterThan(20)
    expect(inferGoalRounds(`${'很长的目标描述，'.repeat(200)}最多 500 轮`)).toBeLessThanOrEqual(GOAL_MAX_ROUNDS)

    // 产品入口：不传轮次时 maxRoundsAuto=true 且落在合理区间
    const scenario = await setupScenario('goal-f', { targetRounds: 12 })
    cleanupQueue.push(scenario.cleanup)
    const started = await scenario.service.startGoal(
      scenario.sessionId,
      '分批完成 12 批资料登记，每轮处理一批并核对，最后输出报告和网页',
      0,
      scenario.window
    )
    expect(started.goal.maxRoundsAuto).toBe(true)
    expect(started.goal.maxRounds).toBeGreaterThanOrEqual(14)
    expect(started.goal.maxRounds).toBeLessThanOrEqual(GOAL_MAX_ROUNDS)
    expect(started.goal.maxToolCalls).toBeGreaterThanOrEqual(200)
    scenario.service.stopGoal(scenario.sessionId, scenario.window)
  }, 30_000)
})
