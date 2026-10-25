// 合并自 tests/unit/core/goal.test.ts、tests/unit/core/mode.test.ts、tests/unit/core/plan-mode.test.ts、tests/unit/core/goal-evidence.test.ts、tests/unit/core/goal-progress.test.ts、tests/unit/core/answer-style.test.ts、tests/unit/core/prompt-mentions.test.ts
// 每个原文件整体包裹在独立 describe 中，保留原有 hooks 与用例。

import { existsSync, readFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Goal, ModelInfo, RuntimeEvent, ToolCategory } from '../../../src/shared/types'
import { resetAllPermissionGrants, runAgent, type RunAgentOptions } from '../../../src/core/agent'
import { buildGoalPromptSection, buildSystemPrompt } from '../../../src/core/prompt'
import { TOOL_DEFINITIONS, toolDefinitionsForRun } from '../../../src/core/tools/registry'
import {
  evaluatePermission,
  isChatModeToolAllowed,
  type PermissionPolicyContext,
  type PermissionTarget,
} from '../../../src/core/permissions'
import { updateGoalTool, validateGoalEvidence } from '../../../src/core/tools/meta-tools'
import {
  clampRounds,
  GOAL_MAX_ROUNDS,
  GoalProgressTracker,
  inferGoalRounds,
  mergeGoalUsage
} from '../../../src/main/services/goal-budget'
import {
  ANSWER_STYLE_MAX_CUSTOM,
  ANSWER_STYLES,
  answerStyleLabel,
  buildAnswerStyleSection,
  isAnswerStyleId,
  normalizeAnswerStyle,
  normalizeAnswerStyleCustom,
} from '../../../src/shared/answer-style'
import { ScriptedProvider, type ScriptStep } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'
import { makeToolContext } from './helpers/tool-context'

beforeEach(() => {
  resetAllPermissionGrants()
})

describe('goal.test.ts', () => {
  /**
   * R6 Goal 模式内核测试：
   * - 目标系统提示段（goal active 注入、非 active 不注入、主进程自带 prompt 时补段）；
   * - 工具列表按模式注入 update_goal；
   * - update_goal 工具的 active/completed/blocked 合并与 goal_updated 事件；
   * - 非法输入、非目标模式防御；不影响审批（meta 不弹审批）；
   * - max-steps 收尾请求仍可 update_goal。
   */

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
      expect(baseNames).toHaveLength(57)
      expect(baseNames).not.toContain('update_goal')
      const goalTools = toolDefinitionsForRun(true)
      expect(goalTools.map((tool) => tool.name)).toContain('update_goal')
      expect(goalTools).toHaveLength(57)
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
})

describe('mode.test.ts', () => {
  /**
   * R8 #5 显式「聊天 / 工作」模式 —— 内核测试。
   *
   * 覆盖审计报告第 5 项的验收点：
   * 1) 聊天模式系统提示：明确「只讨论、不执行」、只列只读工具、Goal 段不注入；
   * 2) 工具白名单：只读工具 + ask_user；写入/执行/记忆/目标/计划/集群成员一律不可用；
   * 3) 权限层硬拦截：即使 permission=auto，chat 下 write_file / run_command / remember 也 denied，
   *    **工具不会真正执行**、文件与命令产物不变（不是只靠提示词）；
   * 4) 主进程自带 systemPrompt 缺聊天段时由内核补上（防止绕过）；
   * 5) 工作模式回归：原有 auto 写文件行为不变；
   * 6) 聊天模式下即使误传 active Goal，也不注入 update_goal / 目标提示段。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  function makeGoal(overrides: Partial<Goal> = {}): Goal {
    const now = Date.now()
    return {
      id: 'goal_chat_1',
      objective: '完成一份竞品调研报告',
      status: 'active',
      round: 2,
      maxRounds: 5,
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      ...overrides
    }
  }

  function target(toolName: string, category: ToolCategory, input: Record<string, unknown> = {}): PermissionTarget {
    return { toolName, category, baseRisk: category === 'read' ? 'low' : 'medium', input, title: toolName }
  }

  function policy(
    workspace: string | null,
    mode: PermissionPolicyContext['mode'],
    sessionMode: PermissionPolicyContext['sessionMode']
  ): PermissionPolicyContext {
    return { mode, workspace, isDemo: false, sessionGrants: new Set(), sessionMode }
  }

  interface ScriptRun {
    events: RuntimeEvent[]
    provider: ScriptedProvider
    result: Awaited<ReturnType<typeof runAgent>>
  }

  async function runScript(
    ws: TempWorkspace,
    steps: ScriptStep[],
    overrides: Partial<RunAgentOptions> = {}
  ): Promise<ScriptRun> {
    const events: RuntimeEvent[] = []
    const provider = new ScriptedProvider(steps, { defaultText: '（结束）' })
    const result = await runAgent({
      runId: 'run_mode_test',
      sessionId: 'session_mode_test',
      provider,
      model: MODEL,
      systemPrompt: '你是 Morrow 测试助手。',
      history: [],
      userMessage: userMessage('帮我改一下文件'),
      workspace: ws.root,
      permissionMode: 'ask',
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async () => 'once',
      onAskUser: async () => ({ value: 'A', label: 'A' }),
      maxSteps: 20,
      ...overrides
    })
    return { events, provider, result }
  }

  function toolNamesOf(run: ScriptRun, index = 0): string[] {
    return [...run.provider.calls[index].tools.map((tool) => tool.name)].sort()
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  /* ── 1. 系统提示 ─────────────────────────────────────────────── */

  describe('聊天模式系统提示', () => {
    it('注入「只讨论、不执行」段，且只列只读工具', () => {
      const prompt = buildSystemPrompt({ mode: 'chat', workspace: 'C:\\work' })
      expect(prompt).toContain('## 聊天模式（只讨论，不执行）')
      expect(prompt).toContain('切到「工作」')
      expect(prompt).toContain('read_file')
      expect(prompt).toContain('list_dir')
      expect(prompt).toContain('glob')
      expect(prompt).toContain('grep')
      expect(prompt).toContain('ask_user')
      expect(prompt).not.toContain('write_file')
      expect(prompt).not.toContain('run_command')
      expect(prompt).not.toContain('update_goal')
      expect(prompt).toContain('聊天模式固定只读')
    })

    it('工作模式（缺省）不注入聊天段，保持原有工具与权限说明', () => {
      const work = buildSystemPrompt({ mode: 'work' })
      const legacy = buildSystemPrompt({})
      for (const prompt of [work, legacy]) {
        expect(prompt).not.toContain('## 聊天模式')
        expect(prompt).toContain('write_file')
        expect(prompt).toContain('run_command')
        expect(prompt).toContain('工作模式（可读写与执行，受权限档位约束）')
      }
    })

    it('聊天模式即使传入 active Goal 也不注入目标段（Goal 是工作模式能力）', () => {
      const prompt = buildSystemPrompt({ mode: 'chat', goal: makeGoal() })
      expect(prompt).not.toContain('## 目标模式')
      expect(prompt).not.toContain('update_goal')
    })

    it('主进程自带 systemPrompt 缺少聊天段时，内核自动补上（且不重复）', async () => {
      const ws = makeTempWorkspace()
      try {
        const first = await runScript(ws, [{ text: '好的。' }], {
          mode: 'chat',
          systemPrompt: '主进程自己的系统提示。'
        })
        const system = first.provider.calls[0].system
        expect(system).toContain('主进程自己的系统提示。')
        expect(system).toContain('## 聊天模式（只讨论，不执行）')
        expect(system.split('## 聊天模式').length - 1).toBe(1)

        const withSection = `主进程提示。\n\n${buildSystemPrompt({ mode: 'chat' })}`
        const second = await runScript(ws, [{ text: '好的。' }], { mode: 'chat', systemPrompt: withSection })
        expect(second.provider.calls[0].system.split('## 聊天模式').length - 1).toBe(1)
      } finally {
        ws.cleanup()
      }
    })
  })

  /* ── 2. 工具白名单 ───────────────────────────────────────────── */

  describe('聊天模式工具白名单', () => {
    it('只读类工具与 ask_user 放行，其余（写入/执行/记忆/目标/计划/集群成员/画布）全部拒绝', () => {
      for (const name of ['read_file', 'list_dir', 'glob', 'grep']) {
        expect(isChatModeToolAllowed(name, 'read'), name).toBe(true)
      }
      expect(isChatModeToolAllowed('ask_user', 'meta')).toBe(true)

      expect(isChatModeToolAllowed('write_file', 'write')).toBe(false)
      expect(isChatModeToolAllowed('edit_file', 'write')).toBe(false)
      expect(isChatModeToolAllowed('run_command', 'exec')).toBe(false)
      expect(isChatModeToolAllowed('remember', 'meta')).toBe(false)
      expect(isChatModeToolAllowed('todo_write', 'meta')).toBe(false)
      expect(isChatModeToolAllowed('swarm', 'meta')).toBe(false)
      expect(isChatModeToolAllowed('open_artifact', 'meta')).toBe(false)
      expect(isChatModeToolAllowed('update_goal', 'meta')).toBe(false)
    })

    it('内核实际下发给模型的工具列表只有只读工具 + ask_user', async () => {
      const ws = makeTempWorkspace()
      try {
        const run = await runScript(ws, [{ text: '好。' }], { mode: 'chat' })
        const expected = TOOL_DEFINITIONS.filter(
          (definition) => definition.category === 'read' || definition.name === 'ask_user'
        )
          .map((definition) => definition.name)
          .sort()
        expect(toolNamesOf(run)).toEqual(expected)
        expect(toolNamesOf(run)).toContain('read_file')
        expect(toolNamesOf(run)).toContain('ask_user')
        expect(toolNamesOf(run)).not.toContain('write_file')
        expect(toolNamesOf(run)).not.toContain('run_command')
        expect(toolNamesOf(run)).not.toContain('update_goal')
      } finally {
        ws.cleanup()
      }
    })

    it('聊天模式下误传 active Goal：不下发 update_goal、不注入目标段、结果不写回目标', async () => {
      const ws = makeTempWorkspace()
      try {
        const goal = makeGoal()
        const run = await runScript(ws, [{ text: '好。' }], { mode: 'chat', goal })
        expect(toolNamesOf(run)).not.toContain('update_goal')
        expect(run.provider.calls[0].system).not.toContain('## 目标模式')
        expect(run.result.goal).toBeNull()
      } finally {
        ws.cleanup()
      }
    })
  })

  /* ── 3. 权限层硬拦截 ─────────────────────────────────────────── */

  describe('聊天模式权限层硬拦截（即使 permission=auto）', () => {
    it('写入 / 执行 / 记忆 / 目标 / 计划 / 集群成员 / 画布 一律 deny，并提示切到工作模式', () => {
      const ws = makeTempWorkspace()
      try {
        const ctx = policy(ws.root, 'auto', 'chat')
        const denied: Array<[string, ToolCategory, Record<string, unknown>]> = [
          ['write_file', 'write', { path: 'a.txt', content: 'x' }],
          ['edit_file', 'write', { path: 'a.txt', old_string: 'a', new_string: 'b' }],
          ['run_command', 'exec', { command: 'Get-Date' }],
          ['remember', 'meta', { text: '记住：以后都用 CSV' }],
          ['update_goal', 'meta', { status: 'active' }],
          ['todo_write', 'meta', { todos: [] }],
          ['swarm', 'meta', { goal: '调研', tasks: [{ title: '调研', prompt: '调研一下' }] }],
          ['open_artifact', 'meta', { title: '报告', kind: 'html', content: '<html></html>' }]
        ]
        for (const [name, category, input] of denied) {
          const gate = evaluatePermission(target(name, category, input), ctx)
          expect(gate.action, name).toBe('deny')
          if (gate.action === 'deny') {
            expect(gate.reason).toContain('聊天模式')
            expect(gate.hint).toContain('工作')
          }
        }

        const allowed: Array<[string, ToolCategory, Record<string, unknown>]> = [
          ['read_file', 'read', { path: 'a.txt' }],
          ['list_dir', 'read', { path: '.' }],
          ['glob', 'read', { pattern: '*.txt' }],
          ['grep', 'read', { pattern: 'hello' }],
          ['ask_user', 'meta', { question: '选哪个？' }]
        ]
        for (const [name, category, input] of allowed) {
          expect(evaluatePermission(target(name, category, input), ctx).action, name).toBe('allow')
        }
      } finally {
        ws.cleanup()
      }
    })

    it('聊天 + read-only 叠加时仍给出聊天模式的原因（不是普通只读提示）', () => {
      const ws = makeTempWorkspace()
      try {
        const gate = evaluatePermission(
          target('write_file', 'write', { path: 'a.txt', content: 'x' }),
          policy(ws.root, 'read-only', 'chat')
        )
        expect(gate.action).toBe('deny')
        if (gate.action === 'deny') {
          expect(gate.reason).toContain('聊天模式')
          expect(gate.hint).toContain('工作')
        }
      } finally {
        ws.cleanup()
      }
    })

    it('聊天模式下只读工具越出工作区仍然要审批（不因聊天模式放行越界读取）', () => {
      const ws = makeTempWorkspace({ 'a.txt': 'hello' })
      try {
        const gate = evaluatePermission(
          target('read_file', 'read', { path: '../outside.txt' }),
          policy(ws.root, 'auto', 'chat')
        )
        expect(gate.action).toBe('ask')
      } finally {
        ws.cleanup()
      }
    })

    it('聊天模式优先级最高：演示模式叠加时也不放行写入', () => {
      const ws = makeTempWorkspace()
      try {
        const ctx: PermissionPolicyContext = {
          mode: 'auto',
          workspace: ws.root,
          isDemo: true,
          sessionGrants: new Set(),
          sessionMode: 'chat'
        }
        const gate = evaluatePermission(target('write_file', 'write', { path: 'a.txt', content: 'x' }), ctx)
        expect(gate.action).toBe('deny')
        expect(evaluatePermission(target('read_file', 'read', { path: 'a.txt' }), ctx).action).toBe('allow')
      } finally {
        ws.cleanup()
      }
    })

    it('工作模式 auto 回归：写文件与普通命令仍自动放行', () => {
      const ws = makeTempWorkspace()
      try {
        const ctx = policy(ws.root, 'auto', 'work')
        expect(evaluatePermission(target('write_file', 'write', { path: 'a.txt', content: 'x' }), ctx)).toEqual({
          action: 'allow'
        })
        expect(evaluatePermission(target('run_command', 'exec', { command: 'Get-Date' }), ctx)).toEqual({
          action: 'allow'
        })
      } finally {
        ws.cleanup()
      }
    })
  })

  /* ── 4. Agent 端到端（脚本化 Provider 强制发起写入/执行） ─────── */

  describe('聊天模式 Agent 端到端', () => {
    it('模型硬发 write_file + run_command：工具全部 denied、文件与命令产物均未产生、助手解释需切模式', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'hello' })
      try {
        const run = await runScript(
          ws,
          [
            {
              text: '我来改文件。',
              toolCalls: [
                { name: 'write_file', input: { path: 'chat-write.txt', content: 'CHAT' } },
                { name: 'run_command', input: { command: 'Set-Content chat-cmd.txt CHAT' } }
              ]
            },
            { text: '当前是聊天模式，我不能直接改文件或跑命令；请切到工作模式后我再执行。' }
          ],
          { mode: 'chat', permissionMode: 'auto' }
        )

        expect(run.result.reason).toBe('complete')
        // 没有弹审批：聊天模式是直接拒绝，不是「问用户要不要写」
        expect(run.events.filter((event) => event.type === 'permission_requested')).toEqual([])

        const finished = run.events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool_finished' }> => event.type === 'tool_finished'
        )
        expect(finished.length).toBe(2)
        for (const event of finished) {
          expect(event.denied).toBe(true)
          expect(event.result.ok).toBe(false)
          expect(event.result.error).toContain('聊天模式')
        }

        // 工具确实没有执行：文件/命令产物都不存在
        expect(existsSync(join(ws.root, 'chat-write.txt'))).toBe(false)
        expect(existsSync(join(ws.root, 'chat-cmd.txt'))).toBe(false)
        expect(readFileSync(join(ws.root, 'a.txt'), 'utf8')).toBe('hello')

        const assistantText = run.result.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n')
        expect(assistantText).toContain('聊天模式')
        expect(assistantText).toContain('工作模式')
        // 工具结果回填后模型还有第二次请求（证明 denied 结果回了模型，而不是静默跳过）
        expect(run.provider.calls.length).toBeGreaterThanOrEqual(2)
      } finally {
        ws.cleanup()
      }
    })

    it('聊天模式 ask_user 仍可用（只讨论也需要向用户确认）', async () => {
      const ws = makeTempWorkspace()
      try {
        const run = await runScript(
          ws,
          [
            {
              text: '我需要确认一下。',
              toolCalls: [
                { name: 'ask_user', input: { question: '要分析哪个文件？', options: [{ label: 'a.txt' }, { label: 'b.txt' }] } }
              ]
            },
            { text: `好的，按你选的 A 继续。` }
          ],
          { mode: 'chat' }
        )
        expect(run.events.some((event) => event.type === 'question_asked')).toBe(true)
        const finished = run.events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool_finished' }> => event.type === 'tool_finished'
        )
        expect(finished.length).toBe(1)
        expect(finished[0].denied).toBeUndefined()
        expect(finished[0].result.ok).toBe(true)
        expect(run.result.reason).toBe('complete')
      } finally {
        ws.cleanup()
      }
    })

    it('工作模式回归：同一句「改文件」在 auto 下真实写入', async () => {
      const ws = makeTempWorkspace({ 'a.txt': 'hello' })
      try {
        const run = await runScript(
          ws,
          [
            { text: '我来写。', toolCalls: [{ name: 'write_file', input: { path: 'work-write.txt', content: 'WORK' } }] },
            { text: '写好了。' }
          ],
          { mode: 'work', permissionMode: 'auto' }
        )
        expect(run.result.reason).toBe('complete')
        const targetPath = join(ws.root, 'work-write.txt')
        expect(existsSync(targetPath)).toBe(true)
        expect(readFileSync(targetPath, 'utf8')).toBe('WORK')
        const finished = run.events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'tool_finished' }> => event.type === 'tool_finished'
        )
        expect(finished.length).toBe(1)
        expect(finished[0].denied).toBeUndefined()
        expect(finished[0].result.ok).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('plan-mode.test.ts', () => {
  /**
   * P0-2 计划模式 —— 内核验收：
   * 1) 工具白名单：只读 + ask_user/todo_write/submit_plan，写入/执行/记忆/集群成员/目标一律不暴露；
   * 2) 即使模型强行调用写入工具，权限层也只读拒绝（不是只靠提示词）；
   * 3) submit_plan 生成 pending 计划、plan_updated 事件与 Markdown 产物；
   * 4) 计划模式可带历史 goal 运行，但不会注入目标段/update_goal；
   * 5) 非计划模式不能提交计划。
   */

  const MODEL: ModelInfo = { id: 'mock-model', label: 'Mock', contextWindow: 128_000, supportsTools: true }

  function userMessage(text: string): ChatMessage {
    return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], createdAt: Date.now() }
  }

  function makeGoal(): Goal {
    const now = Date.now()
    return {
      id: 'goal_plan_1',
      objective: '完成一份报告',
      status: 'active',
      round: 1,
      maxRounds: 5,
      createdAt: now - 60_000,
      updatedAt: now - 30_000
    }
  }

  interface ScriptRun {
    events: RuntimeEvent[]
    provider: ScriptedProvider
    result: Awaited<ReturnType<typeof runAgent>>
  }

  async function runScript(
    ws: TempWorkspace,
    steps: ScriptStep[],
    overrides: Partial<RunAgentOptions> = {}
  ): Promise<ScriptRun> {
    const events: RuntimeEvent[] = []
    const provider = new ScriptedProvider(steps, { defaultText: '（结束）' })
    const result = await runAgent({
      runId: 'run_plan_test',
      sessionId: 'session_plan_test',
      provider,
      model: MODEL,
      systemPrompt: '你是 Morrow 测试助手。',
      history: [],
      userMessage: userMessage('帮我整理这个季度的销售数据'),
      workspace: ws.root,
      permissionMode: 'ask',
      planMode: true,
      snapshotDir: ws.snapshotDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      onPermission: async () => 'once',
      onAskUser: async () => ({ value: 'A', label: 'A' }),
      maxSteps: 20,
      ...overrides
    })
    return { events, provider, result }
  }

  function toolNames(run: ScriptRun, index = 0): string[] {
    return run.provider.calls[index].tools.map((tool) => tool.name).sort()
  }

  beforeEach(() => {
    resetAllPermissionGrants()
  })

  describe('plan mode tool surface', () => {
    it('exposes only read-only + planning tools and injects the plan prompt', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'a,b\n1,2\n' })
      try {
        const run = await runScript(ws, [{ text: '我先看看工作区。' }], { goal: makeGoal() })
        const names = toolNames(run)
        expect(names).toEqual(
          expect.arrayContaining(['list_dir', 'glob', 'grep', 'read_file', 'ask_user', 'todo_write', 'submit_plan'])
        )
        expect(names).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'run_command', 'swarm', 'remember', 'update_goal', 'web_fetch', 'mcp_call', 'terminal']))
        expect(run.provider.calls[0].system).toContain('## 计划模式')
        expect(run.provider.calls[0].system).toContain('submit_plan')
        // 计划模式不注入 Goal 段，即使会话里曾有 active 目标
        expect(run.provider.calls[0].system).not.toContain('## 目标模式')
        expect(run.result.planMode).toBe(true)
        expect(run.result.plan).toBeNull()
      } finally {
        ws.cleanup()
      }
    })

    it('does not advertise write/exec tool usage in the plan-mode system prompt', () => {
      const prompt = buildSystemPrompt({ mode: 'work', planMode: true, workspace: '/tmp/ws', platform: 'linux' })
      expect(prompt).toContain('工具使用（计划模式：只读）')
      expect(prompt).not.toContain('新建文件用 write_file')
      expect(prompt).not.toContain('Windows 默认 PowerShell')
      expect(prompt).not.toContain('## 可用集群成员角色')
    })

    it('denies unadvertised meta tools such as swarm even if the model calls them', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'a,b\n1,2\n' })
      try {
        const run = await runScript(ws, [
          {
            text: '',
            toolCalls: [{ name: 'swarm', input: { goal: '偷偷调研', tasks: [{ title: '调研', prompt: '读取工作区并总结' }] } }]
          },
          { text: '计划模式下不能启动集群。' }
        ])
        const tool = run.result.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_use')
        expect(tool?.type).toBe('tool_use')
        if (tool?.type === 'tool_use') {
          expect(tool.status).toBe('error')
          expect(tool.result?.ok).toBe(false)
          expect(tool.result?.error).toContain('计划模式只能使用')
        }
      } finally {
        ws.cleanup()
      }
    })

    it('refuses writes at the permission layer even if the model calls write_file', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'a,b\n1,2\n' })
      try {
        const run = await runScript(ws, [
          {
            text: '',
            toolCalls: [
              {
                name: 'write_file',
                input: { path: 'out/should-not-exist.txt', content: 'should not be written' }
              }
            ]
          },
          { text: '计划模式下不能写入。' }
        ])
        expect(existsSync(join(ws.root, 'out', 'should-not-exist.txt'))).toBe(false)
        const tool = run.result.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_use')
        expect(tool?.type).toBe('tool_use')
        if (tool?.type === 'tool_use') {
          expect(tool.status).toBe('denied')
          expect(tool.result?.ok).toBe(false)
        }
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('submit_plan', () => {
    it('records a pending plan, emits plan_updated and registers a Markdown artifact', async () => {
      const ws = makeTempWorkspace({ 'in/sales.csv': 'month,amount\n1,100\n' })
      try {
        const run = await runScript(ws, [
          {
            text: '已核对数据，计划如下。',
            toolCalls: [
              {
                name: 'submit_plan',
                input: {
                  title: '整理 Q3 销售并生成报告',
                  summary: '读取 in/sales.csv，核对总额，生成可直接分享的 HTML 报告。',
                  steps: [
                    { text: '读取 in/sales.csv 并核对总销售额' },
                    { text: '按月份汇总并检查异常值' },
                    { text: '生成 out/report.html 并在画布打开' }
                  ],
                  risks: '如果 CSV 缺少月份列，需要先向用户确认口径。'
                }
              }
            ]
          },
          { text: '计划已就绪，等待你的批准。' }
        ])

        const plan = run.result.plan
        expect(plan).not.toBeNull()
        expect(plan?.status).toBe('pending')
        expect(plan?.title).toBe('整理 Q3 销售并生成报告')
        expect(plan?.steps.map((step) => step.text)).toHaveLength(3)
        expect(plan?.risks).toContain('缺少月份列')

        const planEvent = run.events.find((event) => event.type === 'plan_updated')
        expect(planEvent?.type).toBe('plan_updated')
        if (planEvent?.type === 'plan_updated') {
          expect(planEvent.planMode).toBe(true)
          expect(planEvent.plan?.status).toBe('pending')
        }

        const artifact = run.result.artifacts.find((item) => item.title.startsWith('计划：'))
        expect(artifact?.kind).toBe('markdown')
        expect(artifact?.content).toContain('## 执行步骤')
        expect(artifact?.content).toContain('1. 读取 in/sales.csv')
        expect(plan?.artifactId).toBe(artifact?.id)

        // 提交计划不等于执行：工作区不应出现任何产物
        expect(existsSync(join(ws.root, 'out', 'report.html'))).toBe(false)
      } finally {
        ws.cleanup()
      }
    })

    it('rejects submit_plan outside plan mode', async () => {
      const ws = makeTempWorkspace()
      try {
        const run = await runScript(
          ws,
          [
            {
              text: '',
              toolCalls: [
                {
                  name: 'submit_plan',
                  input: { title: 'x', summary: 'y', steps: [{ text: 'z' }] }
                }
              ]
            },
            { text: '好的。' }
          ],
          { planMode: false }
        )
        expect(run.result.plan).toBeNull()
        const tool = run.result.messages
          .flatMap((message) => message.content)
          .find((block) => block.type === 'tool_use')
        if (tool?.type === 'tool_use') {
          expect(tool.result?.ok).toBe(false)
          expect(tool.result?.error).toContain('不在计划模式')
        }
        expect(tool).toBeDefined()
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('goal-evidence.test.ts', () => {
  /**
   * R9 / R2-E、M49：Goal 完成证据必须有真实、新鲜的产物文件。
   * 目录、工作区根/「.」、Goal 创建前的旧文件、空文件、缺失文件都必须拒绝。
   */

  function makeGoal(overrides: Partial<Goal> = {}): Goal {
    const now = Date.now()
    return {
      id: 'goal_evidence',
      objective: '生成 out/report.txt',
      status: 'active',
      round: 1,
      maxRounds: 5,
      createdAt: now - 60_000,
      updatedAt: now - 30_000,
      ...overrides
    }
  }

  describe('validateGoalEvidence（R2-E/M49）', () => {
    it('目录、工作区根、「.」一律拒绝', () => {
      const ws = makeTempWorkspace({ 'out/keep.txt': 'x' })
      try {
        const goal = makeGoal()
        const dir = validateGoalEvidence(['out'], ws.root, goal.createdAt)
        expect(dir.ok).toBe(false)
        if (!dir.ok) expect(dir.error).toContain('目录')

        const dot = validateGoalEvidence(['.'], ws.root, goal.createdAt)
        expect(dot.ok).toBe(false)
        const root = validateGoalEvidence([ws.root], ws.root, goal.createdAt)
        expect(root.ok).toBe(false)
        const absoluteDir = validateGoalEvidence([join(ws.root, 'out')], ws.root, goal.createdAt)
        expect(absoluteDir.ok).toBe(false)
        if (!absoluteDir.ok) expect(absoluteDir.error).toContain('目录')
      } finally {
        ws.cleanup()
      }
    })

    it('Goal 创建前就存在的旧文件拒绝（mtime 早于 createdAt）', () => {
      const ws = makeTempWorkspace({ 'out/result.json': '{"old":true}' })
      try {
        const goal = makeGoal()
        const oldPath = join(ws.root, 'out/result.json')
        const oldDate = new Date(goal.createdAt - 120_000)
        utimesSync(oldPath, oldDate, oldDate)
        const checked = validateGoalEvidence(['out/result.json'], ws.root, goal.createdAt)
        expect(checked.ok).toBe(false)
        if (!checked.ok) expect(checked.error).toContain('旧文件')
      } finally {
        ws.cleanup()
      }
    })

    it('本 Goal 期间被覆盖更新的旧路径可以算证据（mtime 已更新）', () => {
      const ws = makeTempWorkspace({ 'out/result.json': '{"old":true}' })
      try {
        const goal = makeGoal()
        const target = join(ws.root, 'out/result.json')
        const oldDate = new Date(goal.createdAt - 120_000)
        utimesSync(target, oldDate, oldDate)
        writeFileSync(target, '{"new":true}')
        const checked = validateGoalEvidence(['out/result.json'], ws.root, goal.createdAt)
        expect(checked.ok).toBe(true)
        if (checked.ok) expect(checked.paths).toEqual(['out/result.json'])
      } finally {
        ws.cleanup()
      }
    })

    it('空文件、缺失文件、goalCreatedAt 缺失时的行为', () => {
      const ws = makeTempWorkspace()
      try {
        mkdirSync(join(ws.root, 'out'), { recursive: true })
        writeFileSync(join(ws.root, 'out/empty.txt'), '')
        const goal = makeGoal()
        const empty = validateGoalEvidence(['out/empty.txt'], ws.root, goal.createdAt)
        expect(empty.ok).toBe(false)
        if (!empty.ok) expect(empty.error).toContain('空文件')
        expect(validateGoalEvidence(['out/none.txt'], ws.root, goal.createdAt).ok).toBe(false)
        // 不传 createdAt 时只做存在性/类型校验（向后兼容）
        writeFileSync(join(ws.root, 'out/new.txt'), 'ok')
        const noCreatedAt = validateGoalEvidence(['out/new.txt'], ws.root)
        expect(noCreatedAt.ok).toBe(true)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('update_goal(completed) 通过工具层也拒绝不合格证据', () => {
    it('evidence=["."] → 返回 ok=false，不更新目标', async () => {
      const ws = makeTempWorkspace({ 'out/result.txt': 'verified report 53' })
      try {
        const goal = makeGoal()
        let current: Goal | null = goal
        const updated: Goal[] = []
        const ctx = makeToolContext(ws, {
          goal,
          updateGoal: (patch) => {
            current = { ...goal, ...patch, updatedAt: Date.now() }
            updated.push(current)
            return current
          }
        })
        const rejected = await updateGoalTool.execute({ status: 'completed', evidence: ['.'] }, ctx)
        expect(rejected.ok).toBe(false)
        expect(String(rejected.error)).toContain('目录')
        expect(updated).toHaveLength(0)

        // 旧文件（Goal 创建前 mtime）也拒绝
        const oldPath = join(ws.root, 'out/result.txt')
        const oldDate = new Date(goal.createdAt - 120_000)
        utimesSync(oldPath, oldDate, oldDate)
        const stale = await updateGoalTool.execute({ status: 'completed', evidence: ['out/result.txt'] }, ctx)
        expect(stale.ok).toBe(false)
        expect(String(stale.error)).toContain('旧文件')

        // 新产出的非空文件 → 允许完成
        writeFileSync(join(ws.root, 'out/report.txt'), 'verified report 53')
        const accepted = await updateGoalTool.execute(
          { status: 'completed', summary: '完成报告', evidence: ['out/report.txt'] },
          ctx
        )
        expect(accepted.ok).toBe(true)
        expect(updated).toHaveLength(1)
        expect(updated[0].status).toBe('completed')
        expect(updated[0].evidence).toEqual(['out/report.txt'])
        expect(String(accepted.output)).toContain('完成')
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('goal-progress.test.ts', () => {
  /**
   * R9 / R2-D、R2-F、R2-G：Goal 用量合并（不重复记账）与真实进展追踪。
   * 直接测试 main/services/goal-budget.ts 的纯函数（不 import electron）。
   */

  function sha(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  it('轮次预算上限为 256：100 轮可保留，超过上限被钳制', () => {
    expect(GOAL_MAX_ROUNDS).toBe(256)
    expect(clampRounds(100)).toBe(100)
    expect(clampRounds(300)).toBe(256)
    const inferred = inferGoalRounds('这是一个长期项目，分 120 轮逐步完善报告')
    expect(inferred).toBeGreaterThanOrEqual(100)
    expect(inferred).toBeLessThanOrEqual(GOAL_MAX_ROUNDS)
  })

  describe('R2-D：单轮用量合并（assignment，不是累加）', () => {
    it('base + 本轮只记一次；重复合并不翻倍', () => {
      const base = { toolCalls: 5, activeMs: 10_000 }
      const round = { toolCalls: 2, activeMs: 3_000 }
      expect(mergeGoalUsage(base, round)).toEqual({ toolCalls: 7, activeMs: 13_000 })
      // 模拟 flushIncremental 与 afterRun 都执行一次：结果必须仍是 7，而不是 9
      expect(mergeGoalUsage(base, round)).toEqual({ toolCalls: 7, activeMs: 13_000 })
      // R2-D 场景：max=3，第一次调用两次 → 计数 2，不提前停
      expect(mergeGoalUsage({ toolCalls: 0 }, { toolCalls: 2, activeMs: 10 })).toMatchObject({ toolCalls: 2 })
    })

    it('非法/负数计数被 clamp，不会污染预算', () => {
      expect(mergeGoalUsage({ toolCalls: -3, activeMs: -1 }, { toolCalls: 2, activeMs: 5 })).toEqual({
        toolCalls: 2,
        activeMs: 5
      })
    })
  })

  describe('R2-F：空操作 / 重复写入 / 旧文件不算真实进展', () => {
    it('同一路径重复写相同内容只算一次进展；换内容才算新进展', () => {
      const ws = makeTempWorkspace()
      try {
        const goalCreatedAt = Date.now()
        const file = join(ws.root, 'checkpoint.txt')
        const tracker = new GoalProgressTracker({ existingKeys: [] })
        writeFileSync(file, 'step-1')
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'checkpoint.txt' },
            ok: true,
            resultMeta: { absolutePath: file, afterHash: sha('step-1') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(true)
        // 重复写相同 checkpoint → 不算进展
        writeFileSync(file, 'step-1')
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'checkpoint.txt' },
            ok: true,
            resultMeta: { absolutePath: file, afterHash: sha('step-1') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
        // 真新内容 → 进展
        writeFileSync(file, 'step-2')
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'checkpoint.txt' },
            ok: true,
            resultMeta: { absolutePath: file, afterHash: sha('step-2') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(true)
      } finally {
        ws.cleanup()
      }
    })

    it('引用旧输入文件、空 run_command、失败调用都不算进展', () => {
      const ws = makeTempWorkspace({ 'in/old.txt': 'old input' })
      try {
        const goalCreatedAt = Date.now()
        const oldPath = join(ws.root, 'in/old.txt')
        const oldDate = new Date(Date.now() - 120_000)
        utimesSync(oldPath, oldDate, oldDate)
        const tracker = new GoalProgressTracker()
        const stale = tracker.observe({
          toolName: 'open_artifact',
          input: { path: 'in/old.txt' },
          ok: true,
          resultMeta: { absolutePath: oldPath },
          workspace: ws.root,
          goalCreatedAt
        })
        expect(stale.progress).toBe(false)
        expect(stale.reason).toBe('stale-file')

        expect(
          tracker.observe({ toolName: 'run_command', input: { command: '' }, ok: true, workspace: ws.root, goalCreatedAt }).progress
        ).toBe(false)
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'x.txt' },
            ok: false,
            resultMeta: {},
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
      } finally {
        ws.cleanup()
      }
    })

    it('目录 / 不存在路径不算进展', () => {
      const ws = makeTempWorkspace({ 'dir/a.txt': 'a' })
      try {
        const goalCreatedAt = Date.now()
        const tracker = new GoalProgressTracker()
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'dir' },
            ok: true,
            resultMeta: { absolutePath: join(ws.root, 'dir') },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
        expect(
          tracker.observe({
            toolName: 'write_file',
            input: { path: 'missing.txt' },
            ok: true,
            resultMeta: {},
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })

  describe('R2-G：新 XLSX/DOCX 与本地 MCP 成果必须被计为进展', () => {
    it('两份不同 XLSX/DOCX 各算一次；重复同一份不算', () => {
      const ws = makeTempWorkspace()
      try {
        const goalCreatedAt = Date.now()
        mkdirSync(join(ws.root, 'out'), { recursive: true })
        const tracker = new GoalProgressTracker()
        const xlsxA = join(ws.root, 'out/a.xlsx')
        const xlsxB = join(ws.root, 'out/b.xlsx')
        const docx = join(ws.root, 'out/letter.docx')
        writeFileSync(xlsxA, 'xlsx-A')
        writeFileSync(xlsxB, 'xlsx-B')
        writeFileSync(docx, 'docx-v1')
        const observe = (toolName: string, path: string) =>
          tracker.observe({
            toolName,
            input: { path },
            ok: true,
            resultMeta: { absolutePath: path },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        expect(observe('write_xlsx', xlsxA)).toBe(true)
        expect(observe('write_xlsx', xlsxB)).toBe(true)
        expect(observe('edit_docx', docx)).toBe(true)
        expect(observe('write_xlsx', xlsxB)).toBe(false)
      } finally {
        ws.cleanup()
      }
    })

    it('MCP/web 外部调用：首次成功算进展，重复/失败/普通读取不算', () => {
      const ws = makeTempWorkspace()
      try {
        const goalCreatedAt = Date.now()
        const tracker = new GoalProgressTracker()
        const mcpCall = (input: Record<string, unknown>, ok = true) =>
          tracker.observe({ toolName: 'mcp_call', input, ok, workspace: ws.root, goalCreatedAt }).progress
        expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'A', key: 'case47-A' } })).toBe(true)
        // 重复相同调用 → 不算
        expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'A', key: 'case47-A' } })).toBe(false)
        // 不同参数 → 新成果
        expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'B', key: 'case47-B' } })).toBe(true)
        // MCP 读取/失败 → 不算
        expect(mcpCall({ server: 'local', tool: 'child47_get', arguments: {} })).toBe(false)
        expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'C' } }, false)).toBe(false)
        // web_fetch 同一 URL 只算一次
        const web = (url: string) => tracker.observe({ toolName: 'web_fetch', input: { url }, ok: true, workspace: ws.root, goalCreatedAt }).progress
        expect(web('http://127.0.0.1:1/a')).toBe(true)
        expect(web('http://127.0.0.1:1/a')).toBe(false)
      } finally {
        ws.cleanup()
      }
    })

    it('持久化恢复后不会重复计数（重启/暂停/续跑）', () => {
      const ws = makeTempWorkspace()
      try {
        const goalCreatedAt = Date.now()
        const file = join(ws.root, 'out/report.html')
        mkdirSync(join(ws.root, 'out'), { recursive: true })
        writeFileSync(file, '<html>done</html>')
        const first = new GoalProgressTracker()
        expect(
          first.observe({
            toolName: 'write_file',
            input: {},
            ok: true,
            resultMeta: { absolutePath: file },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(true)
        const restored = new GoalProgressTracker({ existingKeys: first.toKeys() })
        expect(
          restored.observe({
            toolName: 'write_file',
            input: {},
            ok: true,
            resultMeta: { absolutePath: file },
            workspace: ws.root,
            goalCreatedAt
          }).progress
        ).toBe(false)
      } finally {
        ws.cleanup()
      }
    })
  })
})

describe('answer-style.test.ts', () => {
  describe('全局回答风格', () => {
    it('风格 id 归一化：未知或缺失回落到平衡', () => {
      for (const style of ANSWER_STYLES) expect(isAnswerStyleId(style.id)).toBe(true)
      expect(isAnswerStyleId('weird')).toBe(false)
      expect(normalizeAnswerStyle('weird')).toBe('balanced')
      expect(normalizeAnswerStyle(undefined)).toBe('balanced')
      expect(normalizeAnswerStyle('formal')).toBe('formal')
      expect(answerStyleLabel('custom')).toBe('自定义')
    })

    it('自定义偏好保留换行、去掉首尾空白并限长', () => {
      expect(normalizeAnswerStyleCustom('  先结论\n\n再解释  ')).toBe('先结论\n\n再解释')
      expect(normalizeAnswerStyleCustom('x'.repeat(ANSWER_STYLE_MAX_CUSTOM + 20))).toHaveLength(
        ANSWER_STYLE_MAX_CUSTOM
      )
      expect(normalizeAnswerStyleCustom(123)).toBe('')
    })

    it('每种预设都带自己的规则，并明确不覆盖安全与任务要求', () => {
      const full = ANSWER_STYLES.map((style) => buildAnswerStyleSection(style.id, '')).join('\n')
      expect(full).toContain('1–3 句')
      expect(full).toContain('补充关键原理')
      expect(full).toContain('专业、客观、完整的书面语')
      for (const style of ANSWER_STYLES.filter((item) => item.id !== 'custom')) {
        const section = buildAnswerStyleSection(style.id, '')
        expect(section).toContain('不改变工具使用、权限、安全边界')
        expect(section).toContain(`当前风格：${style.label}`)
        expect(section).toContain(style.prompt)
      }
    })

    it('自定义风格使用用户文本；为空时回落到平衡规则', () => {
      const section = buildAnswerStyleSection('custom', '像同事讲方案：先结论，再给两条依据。')
      expect(section).toContain('当前风格：自定义')
      expect(section).toContain('像同事讲方案：先结论，再给两条依据。')

      const empty = buildAnswerStyleSection('custom', '   ')
      expect(empty).toContain('用户还没有写下自定义偏好')
      expect(empty).toContain('先给结论')
      expect(empty).not.toContain('像同事讲方案')
    })

    it('系统提示词接入全局风格，只出现当前选择的规则', () => {
      const concise = buildSystemPrompt({ answerStyle: 'concise' })
      expect(concise).toContain('## 回答风格（全局偏好）')
      expect(concise).toContain('当前风格：简洁')
      expect(concise).toContain('1–3 句')
      expect(concise).not.toContain('当前风格：讲解')

      const custom = buildSystemPrompt({
        answerStyle: 'custom',
        answerStyleCustom: '每段不超过三句，先给风险。'
      })
      expect(custom).toContain('当前风格：自定义')
      expect(custom).toContain('每段不超过三句，先给风险。')

      const fallback = buildSystemPrompt({})
      expect(fallback).toContain('当前风格：平衡')
    })
  })
})

describe('prompt-mentions.test.ts', () => {
  describe('系统提示：@ 文件引用语义', () => {
    it('工作模式要求先 read_file 再回答，不能只看文件名猜测', () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
      expect(prompt).toContain('@相对路径')
      expect(prompt).toContain('read_file')
      expect(prompt).toContain('不要假装已经读过')
    })

    it('聊天模式（只读）同样识别 @ 引用', () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'chat' })
      expect(prompt).toContain('@相对路径')
      expect(prompt).toContain('read_file')
    })

    it('工作模式把视觉审美作为硬指标，并要求读取艺术指导技能', () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
      expect(prompt).toContain('## 视觉成品（网页 / 游戏 / 海报 / 界面）')
      expect(prompt).toContain('frontend-art-direction')
      expect(prompt).toContain('按需视觉打磨')
      expect(prompt).toContain('只有本轮马上给出最终答复时才把全部步骤标为 completed')
    })

    it('工作模式注入当前终端，避免用户选 cmd/Git Bash 时仍写 PowerShell', () => {
      const prompt = buildSystemPrompt({
        workspace: 'C:\\work',
        permissionMode: 'auto',
        mode: 'work',
        terminalShell: { id: 'gitbash', label: 'Git Bash' }
      })
      expect(prompt).toContain('默认终端：Git Bash')
      expect(prompt).toContain('run_command、terminal(run/start) 与终端面板都使用它')
      expect(prompt).toContain('POSIX/bash')
      expect(prompt).toContain('不要假设永远是 PowerShell')
    })

    it('工作模式注入跨类型质量门槛，且与具体模型无关', () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
      expect(prompt).toContain('## 交付质量（全类型）')
      expect(prompt).toContain('deliverable-quality')
      expect(prompt).toContain('不要依赖某个模型的特殊标记')
      expect(prompt).toContain('文档/报告/幻灯片')
      expect(prompt).toContain('表格/数据')
      for (const modelLabel of ['DeepSeek V4', 'Claude', 'GPT', 'Kimi']) {
        const forModel = buildSystemPrompt({
          workspace: 'C:\\work',
          permissionMode: 'auto',
          mode: 'work',
          modelLabel
        })
        expect(forModel).toContain('## 交付质量（全类型）')
        expect(forModel).toContain('deliverable-quality')
      }
    })

    it('工作模式包含讨论/执行分界、最小改动、可逆性与如实汇报约束', () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', permissionMode: 'auto', mode: 'work' })
      for (const text of [
        '## 讨论与执行的分界',
        '## 改动边界（最小正确改动）',
        '共享状态与不可逆操作',
        '区分已验证与未验证',
        '4K/超宽屏',
        '相对路径:行号'
      ]) {
        expect(prompt).toContain(text)
      }
    })

    it('提示词不含固定分辨率或固定视口数值', () => {
      const modes = ['work', 'chat', 'research'] as const
      const prompts = [
        ...modes.map((mode) => buildSystemPrompt({ workspace: 'C:\\work', mode })),
        buildSystemPrompt({ workspace: 'C:\\work', planMode: true })
      ]
      for (const prompt of prompts) {
        expect(prompt).not.toMatch(/\b(?:1080p|1440|1920|2560|3840)\b/)
        expect(prompt).not.toMatch(/\b\d{3,4}\s*px\b/)
      }
    })

    it('计划模式按定界、勘察、设计、收敛、提交五段组织，并要求提交前自检', () => {
      const prompt = buildSystemPrompt({ workspace: 'C:\\work', planMode: true })
      for (const text of ['### 工作节奏', '**定界**', '**勘察**', '**设计**', '**收敛**', '### 提交前自检', '### 边界', 'submit_plan']) {
        expect(prompt).toContain(text)
      }
      expect(prompt).not.toContain('## 可用集群成员角色')
    })

    it('目标模式要求完成审计、真实证据与预算收尾', () => {
      const prompt = buildSystemPrompt({
        workspace: 'C:\\work',
        mode: 'work',
        goal: {
          id: 'g1',
          objective: '交付一份可发布的报告',
          status: 'active',
          maxRounds: 5,
          round: 2,
          createdAt: 1,
          updatedAt: 2,
          summary: '已完成初稿',
          nextStep: '补齐数据',
          maxToolCalls: 200,
          toolCalls: 4,
          maxActiveMs: 1200000,
          activeMs: 60000,
          maxNoProgressRounds: 3,
          noProgressRounds: 0
        }
      })
      for (const text of ['### 完成审计', '原始要求 → 产物/证据', 'evidence', 'status=completed', 'status=blocked', '接近预算时先收尾在途工作']) {
        expect(prompt).toContain(text)
      }
    })
  })
})

describe('超频模式提示词', () => {
  it('在聊天、工作、计划与研究模式下都常驻，且不受思考强度档位影响', () => {
    const prompts = [
      buildSystemPrompt({ mode: 'work', workspace: 'C:\work' }),
      buildSystemPrompt({ mode: 'chat', workspace: 'C:\work' }),
      buildSystemPrompt({ mode: 'work', planMode: true, workspace: 'C:\work' }),
      buildSystemPrompt({ mode: 'research', workspace: 'C:\work' })
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain('## 超频模式（常驻）')
      expect(prompt).toContain('任何档位')
      expect(prompt).toContain('没有验证的内容不能算完成')
    }
  })
})
