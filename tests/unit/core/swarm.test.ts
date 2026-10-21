/**
 * Swarm：多角色并行子任务。
 * 验证角色解析、并行派发、部分失败不伪装完成、task 单任务角色。
 */
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_AGENT_ROLES } from '../../../src/core/agent-roles'
import { swarmTool, taskTool } from '../../../src/core/tools/meta-tools'
import type { SubagentRequest, SubagentResult, ToolContext } from '../../../src/core/types'

function makeCtx(runSubagent: (request: SubagentRequest) => Promise<SubagentResult>): ToolContext {
  return {
    sessionId: 's',
    runId: 'r',
    messageId: 'm',
    toolUseId: 't',
    workspace: null,
    permissionMode: 'auto',
    snapshotDir: '',
    signal: new AbortController().signal,
    depth: 0,
    readOnly: false,
    escapeApproved: false,
    demo: false,
    goal: null,
    planMode: false,
    getPlan: () => null,
    proposePlan: (plan) => plan,
    emit: () => undefined,
    updateGoal: () => null,
    getTodos: () => [],
    setTodos: () => undefined,
    getArtifacts: () => [],
    addArtifact: () => undefined,
    askUser: async () => ({ value: 'A', label: 'A' }),
    progress: () => undefined,
    runSubagent,
    agents: BUILTIN_AGENT_ROLES
  }
}

const usage = { inputTokens: 0, outputTokens: 0 }

describe('swarm', () => {
  it('并行派发不同角色，返回每个子任务摘要', async () => {
    const seen: SubagentRequest[] = []
    const ctx = makeCtx(async (request) => {
      seen.push(request)
      return { status: 'completed', summary: `${request.role?.name}:${request.description}`, steps: 2, usage }
    })
    const result = await swarmTool.execute(
      {
        goal: '并行检查',
        tasks: [
          { title: '找入口', prompt: '定位启动文件', agent: 'explore' },
          { title: '审查鉴权', prompt: '检查权限边界', agent: 'review' }
        ]
      },
      ctx
    )
    expect(result.ok).toBe(true)
    expect(seen.map((request) => request.role?.name).sort()).toEqual(['explore', 'review'])
    expect(seen.every((request) => request.prompt.startsWith('【总目标】并行检查'))).toBe(true)
    expect(result.output).toContain('2/2 个完成')
    expect(result.output).toContain('找入口')
    expect(result.meta).toMatchObject({ completed: 2, failed: 0 })
  })

  it('任一子任务未完成时返回错误，不伪装全部完成', async () => {
    let index = 0
    const ctx = makeCtx(async (request) => {
      index += 1
      return index === 1
        ? { status: 'completed', summary: '完成 A', steps: 1, usage }
        : { status: 'failed', summary: '部分结果', steps: 1, usage, error: '模型超时' }
    })
    const result = await swarmTool.execute(
      {
        goal: '并行检查',
        tasks: [
          { title: 'A', prompt: '任务 A', agent: 'explore' },
          { title: 'B', prompt: '任务 B', agent: 'test' }
        ]
      },
      ctx
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('1/2')
    expect(result.output).toContain('完成 A')
    expect(result.output).toContain('模型超时')
    expect(result.meta).toMatchObject({ completed: 1, failed: 1 })
  })

  it('把编排、实时状态和结果身份送到界面', async () => {
    const seen: SubagentRequest[] = []
    const progress: Array<{ note: string; swarmTask?: { index: number; status: string } }> = []
    const ctx = makeCtx(async (request) => {
      seen.push(request)
      return { status: 'completed', summary: `${request.description} 完成`, steps: 3, usage }
    })
    ctx.progress = (note, opts) => {
      progress.push({ note, ...(opts?.swarmTask ? { swarmTask: opts.swarmTask } : {}) })
    }
    const result = await swarmTool.execute(
      {
        goal: '并行检查',
        tasks: [
          { title: '找入口', prompt: '定位启动文件', agent: 'explore' },
          { title: '审查鉴权', prompt: '检查权限边界', agent: 'review' }
        ]
      },
      ctx
    )
    expect(result.ok).toBe(true)
    expect(seen.map((request) => request.swarmTask?.index).sort()).toEqual([0, 1])
    expect(seen.map((request) => request.swarmTask?.agent).sort()).toEqual(['explore', 'review'])
    expect(progress.some((item) => item.swarmTask?.index === 0 && item.swarmTask.status === 'queued')).toBe(true)
    expect(progress.some((item) => item.swarmTask?.index === 1 && item.swarmTask.status === 'running')).toBe(true)
    expect(progress.some((item) => item.swarmTask?.index === 0 && item.swarmTask.status === 'completed')).toBe(true)
    const metaTasks = (result.meta as { tasks?: Array<Record<string, unknown>> }).tasks ?? []
    expect(metaTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 0, agent: 'explore', title: '找入口' }),
        expect.objectContaining({ index: 1, agent: 'review', title: '审查鉴权' })
      ])
    )
  })

  it('最多接受 8 个子任务，并让 8 个同时推进', async () => {
    let active = 0
    let peak = 0
    const ctx = makeCtx(async (request) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return { status: 'completed', summary: `${request.description} 完成`, steps: 1, usage }
    })
    const tasks = Array.from({ length: 8 }, (_, index) => ({
      title: `任务 ${index + 1}`,
      prompt: `处理第 ${index + 1} 部分`,
      agent: 'general'
    }))
    const result = await swarmTool.execute({ goal: '八路并行', tasks }, ctx)
    expect(result.ok).toBe(true)
    expect(peak).toBe(8)
    expect(result.meta).toMatchObject({ completed: 8, failed: 0 })
    const nine = await swarmTool.execute(
      { goal: '超出上限', tasks: [...tasks, { title: '任务 9', prompt: '多余任务' }] },
      ctx
    )
    expect(nine.ok).toBe(false)
    expect(nine.error).toContain('2–8')
  })

  it('未知角色与数量越界直接报错且不派发', async () => {
    const run = vi.fn(async () => ({ status: 'completed' as const, summary: 'x', steps: 1, usage }))
    const ctx = makeCtx(run)
    const unknown = await swarmTool.execute(
      { goal: 'g', tasks: [{ title: 'A', prompt: 'a', agent: 'nope' }, { title: 'B', prompt: 'b' }] },
      ctx
    )
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('nope')
    const single = await swarmTool.execute({ goal: 'g', tasks: [{ title: 'A', prompt: 'a' }] }, ctx)
    expect(single.ok).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('task 工具把角色传给子代理，并在进度里标注角色', async () => {
    const seen: SubagentRequest[] = []
    const notes: string[] = []
    const ctx = makeCtx(async (request) => {
      seen.push(request)
      return { status: 'completed', summary: 'ok', steps: 1, usage }
    })
    ctx.progress = (note) => notes.push(note)
    const result = await taskTool.execute(
      { description: '检查代码', prompt: '检查 src', agent: 'review' },
      ctx
    )
    expect(result.ok).toBe(true)
    expect(seen[0]?.role?.name).toBe('review')
    expect(notes[0]).toContain('审查者')
    expect(result.meta).toMatchObject({ role: 'review' })
  })
})
