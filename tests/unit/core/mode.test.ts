/**
 * R8 #5 显式「聊天 / 工作」模式 —— 内核测试。
 *
 * 覆盖审计报告第 5 项的验收点：
 * 1) 聊天模式系统提示：明确「只讨论、不执行」、只列只读工具、Goal 段不注入；
 * 2) 工具白名单：只读工具 + ask_user；写入/执行/记忆/目标/计划/子代理一律不可用；
 * 3) 权限层硬拦截：即使 permission=auto，chat 下 write_file / run_command / remember 也 denied，
 *    **工具不会真正执行**、文件与命令产物不变（不是只靠提示词）；
 * 4) 主进程自带 systemPrompt 缺聊天段时由内核补上（防止绕过）；
 * 5) 工作模式回归：原有 auto 写文件行为不变；
 * 6) 聊天模式下即使误传 active Goal，也不注入 update_goal / 目标提示段。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Goal, ModelInfo, RuntimeEvent, ToolCategory } from '../../../src/shared/types'
import { resetAllPermissionGrants, runAgent, type RunAgentOptions } from '../../../src/core/agent'
import { buildSystemPrompt } from '../../../src/core/prompt'
import {
  evaluatePermission,
  isChatModeToolAllowed,
  type PermissionPolicyContext,
  type PermissionTarget
} from '../../../src/core/permissions'
import { TOOL_DEFINITIONS } from '../../../src/core/tools/registry'
import { ScriptedProvider, type ScriptStep } from './helpers/scripted-provider'
import { makeTempWorkspace, type TempWorkspace } from './helpers/workspace'

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
  return { mode, workspace, isSubagent: false, isDemo: false, sessionGrants: new Set(), sessionMode }
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
  it('只读类工具与 ask_user 放行，其余（写入/执行/记忆/目标/计划/子代理/画布）全部拒绝', () => {
    for (const name of ['read_file', 'list_dir', 'glob', 'grep']) {
      expect(isChatModeToolAllowed(name, 'read'), name).toBe(true)
    }
    expect(isChatModeToolAllowed('ask_user', 'meta')).toBe(true)

    expect(isChatModeToolAllowed('write_file', 'write')).toBe(false)
    expect(isChatModeToolAllowed('edit_file', 'write')).toBe(false)
    expect(isChatModeToolAllowed('run_command', 'exec')).toBe(false)
    expect(isChatModeToolAllowed('remember', 'meta')).toBe(false)
    expect(isChatModeToolAllowed('todo_write', 'meta')).toBe(false)
    expect(isChatModeToolAllowed('task', 'meta')).toBe(false)
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
  it('写入 / 执行 / 记忆 / 目标 / 计划 / 子代理 / 画布 一律 deny，并提示切到工作模式', () => {
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
        ['task', 'meta', { description: '调研', prompt: '调研一下' }],
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

  it('聊天模式优先级最高：演示模式/子代理叠加时也不放行写入', () => {
    const ws = makeTempWorkspace()
    try {
      for (const extra of [{ isDemo: true }, { isSubagent: true }] as const) {
        const ctx: PermissionPolicyContext = {
          mode: 'auto',
          workspace: ws.root,
          isSubagent: false,
          isDemo: false,
          sessionGrants: new Set(),
          sessionMode: 'chat',
          ...extra
        }
        const gate = evaluatePermission(target('write_file', 'write', { path: 'a.txt', content: 'x' }), ctx)
        expect(gate.action).toBe('deny')
        expect(evaluatePermission(target('read_file', 'read', { path: 'a.txt' }), ctx).action).toBe('allow')
      }
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
