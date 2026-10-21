/**
 * P0-2 计划模式 —— 内核验收：
 * 1) 工具白名单：只读 + ask_user/todo_write/submit_plan，写入/执行/记忆/子代理/目标一律不暴露；
 * 2) 即使模型强行调用写入工具，权限层也只读拒绝（不是只靠提示词）；
 * 3) submit_plan 生成 pending 计划、plan_updated 事件与 Markdown 产物；
 * 4) 计划模式可带历史 goal 运行，但不会注入目标段/update_goal；
 * 5) 非计划模式不能提交计划。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Goal, ModelInfo, RuntimeEvent } from '../../../src/shared/types'
import { resetAllPermissionGrants, runAgent, type RunAgentOptions } from '../../../src/core/agent'
import { buildSystemPrompt } from '../../../src/core/prompt'
import { ScriptedProvider, type ScriptStep } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

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
      expect(names).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'run_command', 'task', 'remember', 'update_goal', 'web_fetch', 'mcp_call', 'terminal']))
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
    expect(prompt).not.toContain('## 可用子代理角色')
  })

  it('denies unadvertised meta tools such as task even if the model calls them', async () => {
    const ws = makeTempWorkspace({ 'in/sales.csv': 'a,b\n1,2\n' })
    try {
      const run = await runScript(ws, [
        {
          text: '',
          toolCalls: [{ name: 'task', input: { description: '偷偷调研', prompt: '读取工作区并总结' } }]
        },
        { text: '计划模式下不能启动子代理。' }
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
