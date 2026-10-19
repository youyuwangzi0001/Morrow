/**
 * R9 阶段 A：一键离线自检（零真实模型费用）。
 *
 * 校验：
 * - M40–M49 spec 完整、支持范围预登记一致、fixtures 可生成；
 * - 每个 checker 在空输出时不会误判 PASS；M40/M41/M42/M48/M49 reference 输出能 PASS；
 * - 扩展后的本地 MCP mock 新工具（child44/45/46/47/49）可列出并调用；
 * - 生成支持范围声明 `docs/audit/support-declaration-r9.md`；
 * - 运行 R2-A—R2-H 机制探针并落盘状态（核心修复未合入时允许 FAIL，阶段 A 只记录）。
 *
 * 命令：
 *   npx vitest run --config tests/audit/vitest.config.ts tests/audit/r9/phase-a.test.ts
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, RuntimeEvent } from '../../../src/shared/types'
import { AUDIT_TMP_ROOT, PROJECT_ROOT } from '../helpers'
import { QUESTIONS, R9_EXPECTED_IDS, type R9CheckContext, type R9QuestionSpec } from './specs'
import { runMechanismProbes } from './mechanisms'

const R9_ROOT = join(AUDIT_TMP_ROOT, 'r9')
const FIXTURE_ROOT = join(R9_ROOT, 'fixtures')
const LOG_DIR = join(PROJECT_ROOT, 'docs', 'audit', 'logs')
const MOCK_SCRIPT = join(PROJECT_ROOT, 'tests', 'audit', 'r8', 'mocks', 'morrow-mock-mcp.mjs')
const SUPPORT_DECLARATION = join(PROJECT_ROOT, 'docs', 'audit', 'support-declaration-r9.md')

function writeFixtureTree(name: string, files: Record<string, string> | undefined): string {
  const root = join(FIXTURE_ROOT, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  for (const [relative, content] of Object.entries(files ?? {})) {
    const absolute = join(root, relative)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
  return root
}

function buildFixtures(): Record<string, string[]> {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  const manifest: Record<string, string[]> = {}
  for (const spec of QUESTIONS) {
    const root = join(FIXTURE_ROOT, spec.id)
    mkdirSync(root, { recursive: true })
    const write = (target: string, files?: Record<string, string>): void => {
      for (const [relative, content] of Object.entries(files ?? {})) {
        const absolute = join(target, relative)
        mkdirSync(join(absolute, '..'), { recursive: true })
        writeFileSync(absolute, content, 'utf8')
      }
    }
    write(join(root, 'ws'), spec.workspaceFiles)
    write(join(root, 'ws'), spec.outFiles)
    write(join(root, 'ws-alt'), spec.altWorkspaceFiles)
    for (const scenario of spec.scenarios ?? []) {
      write(join(root, `scenario-${scenario.id}`, 'ws'), scenario.workspaceFiles)
      write(join(root, `scenario-${scenario.id}`, 'ws'), scenario.outFiles)
    }
    manifest[spec.id] = spec.scenarios?.map((scenario) => scenario.id) ?? []
  }
  return manifest
}

function emptyContext(workspace: string, baseDir: string): R9CheckContext {
  return {
    workspace,
    baseDir,
    events: [],
    assistantText: '',
    assistantTexts: [],
    sessions: [],
    permissions: [],
    questions: [],
    goal: null,
    mode: 'work',
    mock: { state: {}, calls: [] },
    extra: {}
  }
}

function message(text: string, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
  return { id: `m_${Math.random().toString(36).slice(2, 8)}`, role, content: [{ type: 'text', text }], createdAt: Date.now() }
}

function toolUse(name: string, input: Record<string, unknown>, result?: unknown): ChatMessage {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: `call_${Math.random().toString(36).slice(2, 8)}`,
        name,
        title: name,
        category: name === 'task' ? 'meta' : 'read',
        input,
        status: result ? 'success' : 'running',
        ...(result ? { result } : {})
      }
    ],
    createdAt: Date.now()
  }
}

function progressEvent(toolUseId: string, note: string): RuntimeEvent {
  return { seq: 0, runId: 'r9-ref', sessionId: 'r9-ref', at: Date.now(), type: 'tool_progress', messageId: 'm', toolUseId, note, status: 'running' } as RuntimeEvent
}

/** reference 输出：验证 checker 在理想产物/事件下能 PASS（不替产品作答，仅 checker 自测） */
function referenceCheck(spec: R9QuestionSpec): { ok: boolean; detail: string } {
  const baseDir = join(FIXTURE_ROOT, spec.id, 'ref')
  const workspace = join(baseDir, 'ws')
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  const ctx = emptyContext(workspace, baseDir)
  ctx.sessions = [[]]
  if (spec.id === 'M40') {
    const taskA = toolUse('task', { description: 'A', prompt: 'A' }, { ok: true, output: '和=13', meta: { steps: 2 } })
    const taskB = toolUse('task', { description: 'B', prompt: 'B' }, { ok: true, output: '和=14', meta: { steps: 2 } })
    ctx.sessions = [[message('执行', 'user'), taskA, taskB]]
    const idA = (taskA.content[0] as { id: string }).id
    const idB = (taskB.content[0] as { id: string }).id
    ctx.events = [progressEvent(idA, '子代理：读取 in/a.txt'), progressEvent(idB, '子代理：读取 in/b.txt')]
    writeFileSync(join(workspace, 'out/result.json'), JSON.stringify({ a_total: 13, b_total: 14, grand_total: 27 }), 'utf8')
  } else if (spec.id === 'M41') {
    const task = toolUse('task', { description: '读取 note', prompt: '读取 note' }, { ok: true, output: 'R41 金额 17' })
    ctx.sessions = [[message('执行', 'user'), task]]
    const id = (task.content[0] as { id: string }).id
    ctx.events = [progressEvent(id, '子代理：读取 in/note.txt')]
    ctx.mode = 'read-only'
    ctx.assistantText = '编号 R41，金额 17。'
  } else if (spec.id === 'M42') {
    const task = toolUse('task', { description: '读取 task', prompt: '读取 task' }, { ok: true, output: 'Birch/23' })
    ctx.sessions = [[message('执行', 'user'), task]]
    ctx.assistantText = 'project=Birch amount=23'
    writeFileSync(join(workspace, 'out/result.json'), JSON.stringify({ project: 'Birch', amount: 23 }), 'utf8')
  } else if (spec.id === 'M48') {
    writeFileSync(join(workspace, 'out/a.txt'), 'A1\n', 'utf8')
    writeFileSync(join(workspace, 'out/b.txt'), 'B0\n', 'utf8')
    ctx.permissions = [
      { toolName: 'write_file', input: { path: 'out/a.txt', content: 'A1' }, decision: 'once' },
      { toolName: 'write_file', input: { path: 'out/b.txt', content: 'B1' }, decision: 'deny' },
      { toolName: 'write_file', input: { path: 'out/a.txt', content: 'A2' }, decision: 'deny' }
    ]
    ctx.assistantText = '第二步写入等待审批，未写入。'
  } else if (spec.id === 'M49') {
    const stageA = join(baseDir, 'stage-A')
    const stageB = join(baseDir, 'stage-B')
    mkdirSync(join(stageA, 'out'), { recursive: true })
    mkdirSync(join(stageB, 'out'), { recursive: true })
    writeFileSync(join(stageA, 'out/result.json'), JSON.stringify({ run_id: 'R49-N2', count: 3, sum: 31 }), 'utf8')
    ctx.extra.m49Stages = [
      { id: 'A', workspace: stageA, assistantText: '已用本轮输入重算并替换旧结果。', oldHash: 'oldhash' },
      { id: 'B', workspace: stageB, assistantText: 'child49_build 失败：synthetic_build_error；未生成 out/report.txt，任务未成功。' }
    ]
  }
  try {
    const result = spec.checker(ctx)
    return { ok: result.ok, detail: result.detail }
  } catch (err) {
    return { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

/* ── MCP mock 自检 ───────────────────────────────────────────── */

async function checkMockMcp(): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const stateDir = join(R9_ROOT, 'mock-state')
  rmSync(stateDir, { recursive: true, force: true })
  mkdirSync(stateDir, { recursive: true })
  const child = spawn(process.execPath, [MOCK_SCRIPT], { env: { ...process.env, MORROW_MOCK_STATE_DIR: stateDir }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const waiting: Array<(message: Record<string, unknown>) => void> = []
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const resolve = waiting.shift()
          if (resolve) resolve(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // ignore
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
  let id = 1
  const call = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      waiting.push(resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) })}\n`)
    })
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; payload: Record<string, unknown> }> => {
    const response = await call('tools/call', { name, arguments: args })
    const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
    const text = result?.content?.[0]?.text ?? '{}'
    try {
      return { isError: result?.isError === true, payload: JSON.parse(text) as Record<string, unknown> }
    } catch {
      return { isError: result?.isError === true, payload: { raw: text } }
    }
  }
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r9-audit', version: '1' } })
    const toolsList = await call('tools/list')
    const names = ((toolsList.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((item) => item.name)
    const required = ['child44_wait', 'child44_cancel', 'child45_read', 'child46_read', 'child46_get', 'child47_register', 'child47_get', 'child49_build']
    checks.push({ name: 'tools/list', ok: required.every((name) => names.includes(name)), detail: `tools=${names.length}，缺失=${required.filter((name) => !names.includes(name)).join(',') || '无'}` })

    const wait = await tool('child44_wait', { label: 'A' })
    const cancel = await tool('child44_cancel', { label: 'A' })
    const waitAfterCancel = await tool('child44_wait', { label: 'A' })
    checks.push({ name: 'child44', ok: wait.payload.status === 'running' && cancel.payload.status === 'cancelled' && waitAfterCancel.isError === true, detail: `${String(wait.payload.status)} → ${String(cancel.payload.status)} → afterCancelError=${waitAfterCancel.isError}` })

    const a45 = await tool('child45_read', { label: 'A' })
    const b45 = await tool('child45_read', { label: 'B' })
    checks.push({ name: 'child45', ok: a45.payload.value === 7 && b45.isError === true && String(b45.payload.error) === 'timeout', detail: `A=${JSON.stringify(a45.payload)} B=${JSON.stringify(b45.payload)}` })

    const r46 = await tool('child46_read', { id: 'C46' })
    const g46 = await tool('child46_get')
    checks.push({ name: 'child46', ok: r46.isError === true && String(r46.payload.error) === 'validation_error' && g46.payload.count === 0, detail: `readError=${r46.isError} getCount=${String(g46.payload.count)}` })

    const a47 = await tool('child47_register', { id: 'A', key: 'case47-A' })
    const a47Replay = await tool('child47_register', { id: 'A', key: 'case47-A' })
    const list47 = await tool('child47_get')
    checks.push({ name: 'child47', ok: a47.payload.status === 'registered' && a47Replay.payload.replayed === true && list47.payload.count === 1, detail: `register=${String(a47.payload.status)} replay=${String(a47Replay.payload.replayed)} count=${String(list47.payload.count)}` })

    const build49 = await tool('child49_build')
    checks.push({ name: 'child49', ok: build49.payload.status === 'failed' && build49.payload.reason === 'synthetic_build_error', detail: JSON.stringify(build49.payload) })
  } finally {
    child.kill()
  }
  return { ok: checks.every((check) => check.ok), checks }
}

/* ── 支持声明 ───────────────────────────────────────────────── */

export function buildSupportDeclaration(mechanisms: Array<{ id: string; status: string }>): string {
  const supported = QUESTIONS.filter((spec) => spec.declaredSupport === 'supported')
  const unsupported = QUESTIONS.filter((spec) => spec.declaredSupport === 'unsupported')
  const lines: string[] = []
  lines.push('# R9 支持范围声明（M40–M49 + R2-A—R2-H，开跑前固定）')
  lines.push('')
  lines.push(`生成时间：${new Date().toISOString()}`)
  lines.push('状态：**草案（阶段 A；核心修复完成、Lead 信号后冻结）**')
  lines.push('应用版本：1.0.0（不改版本号、不打包 release）')
  lines.push('')
  lines.push('> 只有事先声明“支持”的题才进入本轮真实模型成绩分母；预登记 UNSUPPORTED 的题不计通过，也不在失败后改口。')
  lines.push('> R2-A—R2-H 是运行机制验收（scripted/mock，不占 49 题自主能力分），单独报 /8。')
  lines.push('')
  lines.push('## M40–M49')
  lines.push('')
  lines.push('| 题号 | 声明 | 依赖 | 说明 |')
  lines.push('|---|---|---|---|')
  for (const spec of QUESTIONS) {
    lines.push(`| ${spec.id} | ${spec.declaredSupport === 'supported' ? '✅ 支持' : '⛔ UNSUPPORTED'} | ${(spec.requires ?? []).join('/') || '—'} | ${spec.supportNote} |`)
  }
  lines.push('')
  lines.push(`**合计**：10 题 = 支持 ${supported.length} + UNSUPPORTED ${unsupported.length}（M43/M44/M45/M46/M47）。`)
  lines.push('')
  lines.push('## R2-A—R2-H 机制验收（8 项，独立计分）')
  lines.push('')
  lines.push('| 项 | 说明 | 阶段 A 状态 |')
  lines.push('|---|---|---|')
  const mechanismNotes: Record<string, string> = {
    'R2-A': 'write_xlsx/edit_docx 审批签名绑定路径+内容（核心修复 task-17）',
    'R2-B': '子代理首请求失败 → 外层 task 必须 ok=false',
    'R2-C': '子代理 12 步耗尽 → 外层 task 必须失败/耗尽',
    'R2-D': 'Goal 工具预算不重复记账（2 次不能记成 4）',
    'R2-E': '完成证据不能是“.”/旧文件/目录（核心修复 task-17）',
    'R2-F': '空命令/重复 checkpoint/旧文件不算进展，连续 2 轮后产品预算停止',
    'R2-G': '新 XLSX/DOCX/MCP 成果必须计入进展；剩余项保留',
    'R2-H': '单条用户消息 + 长工具链可真实触发压缩并继续（核心修复 task-18）'
  }
  for (const item of mechanisms) {
    lines.push(`| ${item.id} | ${mechanismNotes[item.id] ?? ''} | ${item.status}（阶段 A 探针；Lead 信号后复跑验收） |`)
  }
  lines.push('')
  lines.push('## 实际范围声明（不扩大产品权限）')
  lines.push('')
  lines.push('- 子代理：只读、串行、最多 12 步；无 MCP/命令/记忆/写文件/嵌套子代理。M44–M47 因此按题面前置预登记 UNSUPPORTED；M40/M41/M42 只测只读串行范围。')
  lines.push('- M40 子任务身份：产品不单独暴露子任务 ID/session，审计以父 task 工具调用 ID + task 结果/进度事件作为关联证据，报告中注明证据强度。')
  lines.push('- M42 上下文审计：产品无独立“上下文审计”事件；隔离结论以“B 工作区/标记不出现在 A 的会话/事件/产物 + 代码路径核查”为证据，不等同完整可审计隔离。')
  lines.push('- M48 依赖 R2-A 修复；M49 依赖 R2-E 修复。核心修复未合入前对应题可能 FAIL/INVALID，不用测试脚本制造通过。')
  lines.push('')
  lines.push('## 阶段 B 预算与执行')
  lines.push('')
  lines.push('- M40/M41/M42/M48/M49 真实 DeepSeek 仅跑一遍，估算 **40–70 次请求**（硬上限 ≤300）；M43–M47 预登记 UNSUPPORTED 不消耗请求。')
  lines.push('- R2-A—R2-H 用 scripted/mock 本地模型，不消耗真实请求，不计入 49 题自主能力分。')
  lines.push('- 证据：`tmp/audit/r9/**`；结果 `docs/audit/r9-results.json`；报告 `docs/AUDIT-REPORT-R9.md`。')
  lines.push('')
  return lines.join('\n')
}

/* ── 测试主体 ───────────────────────────────────────────────── */

describe('R9 阶段 A 离线自检（零真实费用）', () => {
  it('M40–M49 spec/fixtures/checker 一致性 + 本地 MCP mock + 支持声明', async () => {
    const manifest = buildFixtures()
    const ids = QUESTIONS.map((spec) => spec.id)
    expect(ids).toEqual(R9_EXPECTED_IDS)
    expect(QUESTIONS.filter((spec) => spec.declaredSupport === 'supported')).toHaveLength(5)
    expect(QUESTIONS.filter((spec) => spec.declaredSupport === 'unsupported')).toHaveLength(5)
    for (const spec of QUESTIONS) {
      expect(typeof spec.checker, spec.id).toBe('function')
      if (spec.declaredSupport === 'unsupported') expect(spec.supportNote.length, spec.id).toBeGreaterThan(8)
    }
    // 空输出不会被 checker 误判 PASS
    for (const spec of QUESTIONS) {
      if (spec.declaredSupport === 'unsupported') continue
      const baseDir = join(FIXTURE_ROOT, spec.id, 'empty')
      const workspace = join(baseDir, 'ws')
      mkdirSync(join(workspace, 'in'), { recursive: true })
      mkdirSync(join(workspace, 'out'), { recursive: true })
      let rejected = false
      try {
        const result = spec.checker(emptyContext(workspace, baseDir))
        rejected = result.ok === false || Boolean(result.invalid)
      } catch {
        rejected = true
      }
      expect(rejected, `${spec.id} 空输出 checker 未拒绝`).toBe(true)
    }
    // reference 输出应 PASS（checker 自测，不是产品成绩）
    const referenceResults = QUESTIONS.filter((spec) => spec.declaredSupport === 'supported').map((spec) => ({ id: spec.id, ...referenceCheck(spec) }))
    const failedRefs = referenceResults.filter((item) => !item.ok)
    expect(failedRefs, JSON.stringify(failedRefs)).toHaveLength(0)

    const mock = await checkMockMcp()
    expect(mock.ok, JSON.stringify(mock.checks.filter((check) => !check.ok))).toBe(true)

    const mechanisms = await runMechanismProbes()
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(join(LOG_DIR, 'r9-mechanism-probe.json'), JSON.stringify({ at: new Date().toISOString(), results: mechanisms }, null, 2), 'utf8')
    expect(mechanisms).toHaveLength(8)

    // 已冻结的声明是“开跑前固定”的证据：阶段 A/机制复跑不得自动改写（显式更新除外）
    const existingDeclaration = existsSync(SUPPORT_DECLARATION) ? readFileSync(SUPPORT_DECLARATION, 'utf8') : ''
    if (!existingDeclaration.includes('已冻结') || process.env.MORROW_R9_DECL_UPDATE === '1') {
      writeFileSync(SUPPORT_DECLARATION, buildSupportDeclaration(mechanisms), 'utf8')
    }
    const report = {
      at: new Date().toISOString(),
      specs: { ids, supported: 5, unsupported: 5, fixtures: manifest },
      referenceResults,
      mock,
      mechanisms: { pass: mechanisms.filter((item) => item.status === 'PASS').length, fail: mechanisms.filter((item) => item.status === 'FAIL').length, results: mechanisms },
      supportDeclaration: SUPPORT_DECLARATION.replace(PROJECT_ROOT, '.').replace(/\\/g, '/')
    }
    writeFileSync(join(LOG_DIR, 'r9-phase-a.json'), JSON.stringify(report, null, 2), 'utf8')
    writeFileSync(
      join(LOG_DIR, 'r9-phase-a.log'),
      [
        '# R9 阶段 A 离线自检',
        `# 时间: ${new Date().toISOString()}`,
        `# specs: ${ids.length}（支持 5 / UNSUPPORTED 5）`,
        `# fixtures: ${Object.keys(manifest).length}`,
        `# reference checker: ${referenceResults.filter((item) => item.ok).length}/${referenceResults.length}`,
        `# mock: ${mock.checks.filter((check) => check.ok).length}/${mock.checks.length}`,
        `# mechanisms(阶段 A 记录): PASS ${mechanisms.filter((item) => item.status === 'PASS').length} / FAIL ${mechanisms.filter((item) => item.status === 'FAIL').length}`,
        ...mechanisms.map((item) => `${item.id}\t${item.status}\t${item.detail}`),
        '',
        ...mock.checks.map((check) => `${check.name}\t${check.ok}\t${check.detail}`)
      ].join('\n'),
      'utf8'
    )
  }, 600_000)
})
