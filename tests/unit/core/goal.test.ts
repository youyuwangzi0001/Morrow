/**
 * R6 Goal 模式内核测试：
 * - 目标系统提示段（goal active 注入、非 active 不注入、主进程自带 prompt 时补段）；
 * - 工具列表按模式注入 update_goal；
 * - update_goal 工具的 active/completed/blocked 合并与 goal_updated 事件；
 * - 非法输入、非目标模式防御；不影响审批（meta 不弹审批）；
 * - max-steps 收尾请求仍可 update_goal。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Goal, ModelInfo, RuntimeEvent } from '../../../src/shared/types'
import { resetAllPermissionGrants, runAgent, type RunAgentOptions } from '../../../src/core/agent'
import { buildGoalPromptSection, buildSystemPrompt } from '../../../src/core/prompt'
import { TOOL_DEFINITIONS, toolDefinitionsForRun } from '../../../src/core/tools/registry'
import { ScriptedProvider } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: 'goal_1',
    objective: '分三轮完成一份竞品调研报告，每轮推进一个阶段',
    status: 'active',
    round: 2,
    maxRounds: 5,
    summary: '上一轮完成了竞品名单收集',
    nextStep: '整理竞品功能对比表',
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    ...overrides
  }
}

function userMessage(text: string): ChatMessage {
  return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
}

interface GoalRun {
  events: RuntimeEvent[]
  provider: ScriptedProvider
  result: Awaited<ReturnType<typeof runAgent>>
}

async function runGoalScript(
  ws: TempWorkspace,
  steps: ConstructorParameters<typeof ScriptedProvider>[0],
  goal: Goal | null | undefined,
  overrides: Partial<RunAgentOptions> = {}
): Promise<GoalRun> {
  const events: RuntimeEvent[] = []
  const provider = new ScriptedProvider(steps, { defaultText: '（结束）' })
  const result = await runAgent({
    runId: 'run_goal_test',
    sessionId: 'session_goal_test',
    provider,
    model: MODEL,
    systemPrompt: '你是 Morrow 测试助手。',
    history: [],
    userMessage: userMessage('继续推进目标'),
    workspace: ws.root,
    permissionMode: 'ask',
    snapshotDir: ws.snapshotDir,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onPermission: async () => 'once',
    onAskUser: async () => ({ value: 'a', label: 'A' }),
    maxSteps: 20,
    ...(goal === undefined ? {} : { goal }),
    ...overrides
  })
  return { events, provider, result }
}

beforeEach(() => {
  resetAllPermissionGrants()
})

describe('Goal 系统提示', () => {
  it('active 目标注入目标、轮次、摘要与每轮行为规范', () => {
    const goal = makeGoal()
    const prompt = buildSystemPrompt({ goal })
    expect(prompt).toContain('## 目标模式')
    expect(prompt).toContain(goal.objective)
    expect(prompt).toContain('第 2/5 轮')
    expect(prompt).toContain('上一轮完成了竞品名单收集')
    expect(prompt).toContain('整理竞品功能对比表')
    expect(prompt).toContain('update_goal')
    expect(prompt).toContain('status=completed')
    expect(prompt).toContain('status=blocked')
  })

  it('非 active（paused/completed/blocked）与无 goal 不注入目标段', () => {
    for (const status of ['paused', 'completed', 'blocked'] as const) {
      expect(buildSystemPrompt({ goal: makeGoal({ status }) })).not.toContain('## 目标模式')
    }
    expect(buildSystemPrompt({})).not.toContain('## 目标模式')
  })

  it('主进程自带 systemPrompt 缺少目标段时，Agent 自动补上（且不重复）', async () => {
    const ws = makeTempWorkspace()
    try {
      const goal = makeGoal()
      const { provider } = await runGoalScript(ws, [{ text: '完成。' }], goal, { systemPrompt: '主进程自己的系统提示。' })
      const system = provider.calls[0].system
      expect(system).toContain('主进程自己的系统提示。')
      expect(system).toContain('## 目标模式')
      expect(system).toContain(goal.objective)

      // 已经包含目标段时不重复添加
      const withSection = `主进程提示。\n\n${buildGoalPromptSection(goal)}`
      const second = await runGoalScript(ws, [{ text: '完成。' }], goal, { systemPrompt: withSection })
      const secondSystem = second.provider.calls[0].system
      expect(secondSystem.split('## 目标模式').length - 1).toBe(1)
    } finally {
      ws.cleanup()
    }
  })
})

describe('工具列表按模式注入 update_goal', () => {
  it('TOOL_DEFINITIONS 保持基础工具；goal 模式追加 update_goal', () => {
    const baseNames = TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(baseNames).toHaveLength(39)
    expect(baseNames).not.toContain('update_goal')
    const goalTools = toolDefinitionsForRun(true)
    expect(goalTools.map((tool) => tool.name)).toContain('update_goal')
    expect(goalTools).toHaveLength(39)
    const goalTool = goalTools.find((tool) => tool.name === 'update_goal')
    expect(goalTool).toMatchObject({ category: 'meta', risk: 'low' })
    expect(goalTool?.parameters).toMatchObject({ required: ['status'] })
    expect(goalTool?.parameters.properties).toMatchObject({
      status: { enum: ['active', 'completed', 'blocked'] }
    })
  })

  it('非 goal 模式 provider 拿不到 update_goal；goal 模式拿得到', async () => {
    const ws = makeTempWorkspace()
    try {
      const nonGoal = await runGoalScript(ws, [{ text: '普通回答。' }], undefined)
      expect(nonGoal.provider.calls[0].tools.map((tool) => tool.name)).not.toContain('update_goal')
      const goalRun = await runGoalScript(ws, [{ text: '目标回答。' }], makeGoal())
      expect(goalRun.provider.calls[0].tools.map((tool) => tool.name)).toContain('update_goal')
    } finally {
      ws.cleanup()
    }
  })
})

describe('update_goal 工具行为', () => {
  it('active：保留轮次/目标，写入 summary/nextStep 并 emit goal_updated（meta 不弹审批）', async () => {
    const ws = makeTempWorkspace()
    try {
      const goal = makeGoal()
      const { events, result } = await runGoalScript(
        ws,
        [
          {
            toolCalls: [
              {
                name: 'update_goal',
                input: { status: 'active', summary: '本轮完成功能对比表初稿', nextStep: '补充价格与渠道信息' }
              }
            ]
          },
          { text: '本轮推进完成，等待下一轮。' }
        ],
        goal
      )
      expect(result.reason).toBe('complete')
      const goalEvents = events.filter((event) => event.type === 'goal_updated')
      expect(goalEvents).toHaveLength(1)
      const updated = goalEvents[0].type === 'goal_updated' ? goalEvents[0].goal : null
      expect(updated).toMatchObject({
        id: goal.id,
        objective: goal.objective,
        status: 'active',
        round: 2,
        maxRounds: 5,
        summary: '本轮完成功能对比表初稿',
        nextStep: '补充价格与渠道信息'
      })
      expect(updated?.updatedAt).toBeGreaterThan(goal.updatedAt)
      expect(result.goal).toEqual(updated)
      // 工具结果给人看的状态文案
      const block = result.messages[0].content.find((item) => item.type === 'tool_use')
      expect(block).toMatchObject({ name: 'update_goal', status: 'success' })
      if (block?.type === 'tool_use') expect(block.result?.output).toContain('进行中（第 2/5 轮）')
      // meta 工具不弹审批
      expect(events.some((event) => event.type === 'permission_requested')).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('completed：设置 completedAt，并清掉 nextStep/blockedReason（R7 起必须带可核验 evidence）', async () => {
    const ws = makeTempWorkspace({ 'out/report.md': '# 竞品报告\n正文' })
    try {
      const { events, result } = await runGoalScript(
        ws,
        [
          {
            toolCalls: [
              {
                name: 'update_goal',
                input: { status: 'completed', summary: '报告已生成并自检通过', evidence: ['out/report.md'] }
              }
            ]
          },
          { text: '目标完成。' }
        ],
        makeGoal({ nextStep: '还差一步' })
      )
      const updatedEvent = events.find((event) => event.type === 'goal_updated')
      const updatedGoal = updatedEvent?.type === 'goal_updated' ? updatedEvent.goal : null
      expect(updatedGoal?.status).toBe('completed')
      expect(updatedGoal?.completedAt).toEqual(expect.any(Number))
      expect(updatedGoal?.nextStep).toBeUndefined()
      expect(updatedGoal?.evidence).toContain('out/report.md')
      expect(result.goal?.status).toBe('completed')
    } finally {
      ws.cleanup()
    }
  })

  it('completed 缺证据或证据不存在：拒绝标记完成，状态保持 active', async () => {
    const ws = makeTempWorkspace({ 'out/real.md': 'real' })
    try {
      const { events, result } = await runGoalScript(
        ws,
        [
          {
            toolCalls: [
              { name: 'update_goal', input: { status: 'completed', summary: '我说完成了' } },
              {
                name: 'update_goal',
                input: { status: 'completed', summary: '证据不存在', evidence: ['out/missing.md'] }
              }
            ]
          },
          { text: '结束' }
        ],
        makeGoal()
      )
      expect(result.goal?.status).toBe('active')
      expect(events.some((event) => event.type === 'goal_updated')).toBe(false)
      const blocks = result.messages[0].content.filter((item) => item.type === 'tool_use')
      expect(blocks.length).toBe(2)
      for (const block of blocks) {
        expect(block).toMatchObject({ name: 'update_goal', status: 'error' })
        if (block.type === 'tool_use') {
          // 第一条：缺 evidence；第二条：evidence 路径不存在
          expect(`${block.result?.error ?? ''}${block.result?.hint ?? ''}`).toMatch(/evidence|证据/)
        }
      }
    } finally {
      ws.cleanup()
    }
  })

  it('blocked：记录 blockedReason；缺 blockedReason 时返回可读错误且不发事件', async () => {
    const ws = makeTempWorkspace()
    try {
      const blocked = await runGoalScript(
        ws,
        [
          {
            toolCalls: [
              { name: 'update_goal', input: { status: 'blocked', blockedReason: '缺少用户提供的竞品价格表' } }
            ]
          },
          { text: '已阻塞。' }
        ],
        makeGoal()
      )
      const event = blocked.events.find((item) => item.type === 'goal_updated')
      const blockedGoal = event?.type === 'goal_updated' ? event.goal : null
      expect(blockedGoal?.blockedReason).toBe('缺少用户提供的竞品价格表')
      expect(blocked.result.goal?.blockedReason).toBe('缺少用户提供的竞品价格表')

      const missingReason = await runGoalScript(
        ws,
        [
          { toolCalls: [{ name: 'update_goal', input: { status: 'blocked' } }] },
          { text: '我来说明阻塞原因。' }
        ],
        makeGoal()
      )
      expect(missingReason.result.reason).toBe('complete')
      const failedBlock = missingReason.result.messages[0].content.find((item) => item.type === 'tool_use')
      expect(failedBlock).toMatchObject({ status: 'error' })
      if (failedBlock?.type === 'tool_use') expect(failedBlock.result?.error).toContain('blockedReason')
      expect(missingReason.events.some((item) => item.type === 'goal_updated')).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('非法 status 返回可读错误，不崩溃、不发事件', async () => {
    const ws = makeTempWorkspace()
    try {
      const { result, events } = await runGoalScript(
        ws,
        [
          { toolCalls: [{ name: 'update_goal', input: { status: 'done' } }] },
          { text: '我纠正一下状态。' }
        ],
        makeGoal()
      )
      expect(result.reason).toBe('complete')
      const block = result.messages[0].content.find((item) => item.type === 'tool_use')
      expect(block).toMatchObject({ status: 'error' })
      if (block?.type === 'tool_use') {
        expect(block.result?.error).toContain('非法')
        expect(String(block.result?.hint)).toContain('active')
      }
      expect(events.some((item) => item.type === 'goal_updated')).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('非目标模式调用 update_goal 被防御性拒绝（即使模型硬发）', async () => {
    const ws = makeTempWorkspace()
    try {
      const { result, events } = await runGoalScript(
        ws,
        [
          { toolCalls: [{ name: 'update_goal', input: { status: 'completed' } }] },
          { text: '好的。' }
        ],
        undefined
      )
      expect(result.reason).toBe('complete')
      const block = result.messages[0].content.find((item) => item.type === 'tool_use')
      expect(block).toMatchObject({ status: 'error' })
      if (block?.type === 'tool_use') expect(block.result?.error).toContain('目标模式')
      expect(events.some((item) => item.type === 'goal_updated')).toBe(false)
      expect(result.goal).toBeNull()
    } finally {
      ws.cleanup()
    }
  })

  it('paused 目标不启用目标模式，但结果回显传入状态', async () => {
    const ws = makeTempWorkspace()
    try {
      const paused = makeGoal({ status: 'paused' })
      const { provider, result } = await runGoalScript(ws, [{ text: '普通回答。' }], paused)
      expect(provider.calls[0].tools.map((tool) => tool.name)).not.toContain('update_goal')
      expect(provider.calls[0].system).not.toContain('## 目标模式')
      expect(result.goal).toEqual(paused)
    } finally {
      ws.cleanup()
    }
  })
})

describe('max-steps 收尾请求中的 goal 工具', () => {
  it('收尾请求带 update_goal，且能更新目标状态', async () => {
    const ws = makeTempWorkspace({ 'out/report.md': '# report' })
    try {
      const { events, provider, result } = await runGoalScript(
        ws,
        [
          { toolCalls: [{ name: 'update_goal', input: { status: 'active', summary: '第一轮完成', nextStep: '第二轮' } }] },
          {
            text: '达到步数上限，先收尾。',
            toolCalls: [
              {
                name: 'update_goal',
                input: { status: 'completed', summary: '收尾时确认全部完成', evidence: ['out/report.md'] }
              }
            ]
          }
        ],
        makeGoal(),
        { maxSteps: 1 }
      )
      expect(result.reason).toBe('max-steps')
      expect(provider.calls).toHaveLength(2)
      expect(provider.calls[1].tools.map((tool) => tool.name)).toContain('update_goal')
      // 收尾请求里的 completed 补丁应生效
      expect(result.goal?.status).toBe('completed')
      const goalEvents = events.filter((event) => event.type === 'goal_updated')
      expect(goalEvents.length).toBeGreaterThanOrEqual(1)
      const statuses = goalEvents.map((event) => (event.type === 'goal_updated' ? event.goal?.status ?? '' : ''))
      expect(statuses).toContain('completed')
    } finally {
      ws.cleanup()
    }
  })
})
