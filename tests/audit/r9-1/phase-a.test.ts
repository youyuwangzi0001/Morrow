/**
 * R9.1 阶段 A：零费用自检（子代理全权限 + 并行 M43–M47）。
 *
 * 命令：
 *   npx vitest run --config tests/audit/vitest.config.ts tests/audit/r9-1/phase-a.test.ts
 *
 * 校验：M40–M49 十题均按“支持”登记；M43–M47 reference checker 能 PASS；
 * 本地 mock child44/45/46/47 语义可用（child45 B 可配延迟 timeout）；生成 R9.1 支持声明草案。
 * 注意：真实产品并行/全权限能力要等 engine task-20 完成、Lead 信号后跑 live；本测试不调用真实模型。
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '../../../src/shared/types'
import { AUDIT_TMP_ROOT, PROJECT_ROOT } from '../helpers'
import { QUESTIONS, R91_EXPECTED_IDS, type R9CheckContext, type R9QuestionSpec } from './specs'

const R91_ROOT = join(AUDIT_TMP_ROOT, 'r9-1')
const FIXTURE_ROOT = join(R91_ROOT, 'fixtures')
const LOG_DIR = join(PROJECT_ROOT, 'docs', 'audit', 'logs')
const MOCK_SCRIPT = join(PROJECT_ROOT, 'tests', 'audit', 'r8', 'mocks', 'morrow-mock-mcp.mjs')
const DECLARATION = join(PROJECT_ROOT, 'docs', 'audit', 'support-declaration-r9-1.md')

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

function taskMessage(id: string, startedAt: number, finishedAt: number): ChatMessage {
  return {
    id: `m_${id}`,
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id,
        name: 'task',
        title: '子代理：并行任务',
        category: 'meta',
        input: { description: id, prompt: id },
        result: { ok: true, output: '已完成' },
        status: 'success',
        startedAt,
        finishedAt
      }
    ],
    createdAt: startedAt
  }
}

function progress(toolUseId: string, note: string): Record<string, unknown> {
  return { seq: 0, runId: 'ref', sessionId: 'ref', at: Date.now(), type: 'tool_progress', messageId: 'm', toolUseId, note, status: 'running' }
}

function referenceCheck(spec: R9QuestionSpec): { ok: boolean; detail: string } {
  const baseDir = join(FIXTURE_ROOT, spec.id, 'ref')
  const workspace = join(baseDir, 'ws')
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  const ctx = emptyContext(workspace, baseDir)
  if (spec.id === 'M43') {
    const a = taskMessage('task_a', 1000, 3000)
    const b = taskMessage('task_b', 1200, 2800)
    ctx.sessions = [[a, b]]
    ctx.events = [
      progress('task_a', '子代理：读取 in/a.json'),
      progress('task_a', '子代理：写入 out/a.json'),
      progress('task_b', '子代理：读取 in/b.json'),
      progress('task_b', '子代理：写入 out/b.json')
    ] as never
    writeFileSync(join(workspace, 'out/a.json'), JSON.stringify({ id: 'A', value: 11 }), 'utf8')
    writeFileSync(join(workspace, 'out/b.json'), JSON.stringify({ id: 'B', value: 19 }), 'utf8')
    writeFileSync(join(workspace, 'out/result.json'), JSON.stringify({ records: [{ id: 'A', value: 11 }, { id: 'B', value: 19 }], total: 30 }), 'utf8')
  } else if (spec.id === 'M44') {
    ctx.extra.m44 = {
      t0Observed: true,
      waitCallsAfterT0: { within10s: 0, after30s: 0 },
      child44Status: 'cancelled',
      runStatus: 'cancelled',
      parentCompleted: false
    }
  } else if (spec.id === 'M45') {
    writeFileSync(
      join(workspace, 'out/result.json'),
      JSON.stringify({ status: 'partial', a_value: 7, b_value: null, total: null, failed_children: ['B'] }),
      'utf8'
    )
    ctx.extra.m45Calls = [
      { tool: 'child45_read', label: 'A', isError: false, value: 7 },
      { tool: 'child45_read', label: 'B', isError: true, error: 'timeout' }
    ]
  } else if (spec.id === 'M46') {
    writeFileSync(join(workspace, 'out/result.json'), JSON.stringify({ status: 'failed', record_count: 0, reason: 'validation_error' }), 'utf8')
    ctx.extra.m46Calls = [
      { tool: 'child46_read', arguments: { id: 'C46' }, isError: true, error: 'validation_error' },
      { tool: 'child46_get', arguments: {}, isError: false, payload: { records: [], count: 0 } }
    ]
  } else if (spec.id === 'M47') {
    writeFileSync(join(workspace, 'out/result.json'), JSON.stringify({ ids: ['A', 'B'], count: 2 }), 'utf8')
    ctx.extra.m47 = {
      restarted: true,
      recovered: true,
      records: [
        { id: 'A', key: 'case47-A', status: 'registered' },
        { id: 'B', key: 'case47-B', status: 'registered' }
      ],
      replayedA: false
    }
    ctx.mock.state = { child47: ctx.extra.m47.records }
  } else {
    // 其它题：交给 R9 原 checker 的 reference 已在 R9 phase-a 验证；这里只验证 M43–M47
    return { ok: true, detail: 'skip' }
  }
  try {
    return spec.checker(ctx)
  } catch (err) {
    return { ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

async function checkMock(): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const stateDir = join(R91_ROOT, 'mock-state')
  rmSync(stateDir, { recursive: true, force: true })
  mkdirSync(stateDir, { recursive: true })
  const child = spawn(process.execPath, [MOCK_SCRIPT], {
    env: { ...process.env, MORROW_MOCK_STATE_DIR: stateDir, MORROW_MOCK_CHILD45_TIMEOUT_MS: '50' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
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
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; payload: Record<string, unknown>; elapsed: number }> => {
    const started = Date.now()
    const response = await call('tools/call', { name, arguments: args })
    const result = response.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined
    const text = result?.content?.[0]?.text ?? '{}'
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      payload = { raw: text }
    }
    return { isError: result?.isError === true, payload, elapsed: Date.now() - started }
  }
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r9-1-audit', version: '1' } })
    const names = ((await call('tools/list')).result as { tools?: Array<{ name: string }> })?.tools?.map((item) => item.name) ?? []
    checks.push({ name: 'tools/list', ok: names.includes('child44_wait') && names.includes('child45_read') && names.includes('child46_read') && names.includes('child47_register'), detail: `tools=${names.length}` })

    const wait = await tool('child44_wait', { label: 'A' })
    const cancel = await tool('child44_cancel', { label: 'A' })
    const waitAgain = await tool('child44_wait', { label: 'A' })
    checks.push({ name: 'child44', ok: wait.payload.status === 'running' && cancel.payload.status === 'cancelled' && waitAgain.isError, detail: `${String(wait.payload.status)}→${String(cancel.payload.status)}→orphanError=${waitAgain.isError}` })

    const a = await tool('child45_read', { label: 'A' })
    const b = await tool('child45_read', { label: 'B' })
    checks.push({ name: 'child45', ok: a.payload.value === 7 && b.isError && b.elapsed >= 40 && b.elapsed < 5000, detail: `A=${JSON.stringify(a.payload)} B=${JSON.stringify(b.payload)} B延迟=${b.elapsed}ms` })

    const r46 = await tool('child46_read', { id: 'C46' })
    const g46 = await tool('child46_get')
    checks.push({ name: 'child46', ok: r46.isError && String(r46.payload.error) === 'validation_error' && g46.payload.count === 0, detail: `readError=${r46.isError} count=${String(g46.payload.count)}` })

    const a47 = await tool('child47_register', { id: 'A', key: 'case47-A' })
    const replay = await tool('child47_register', { id: 'A', key: 'case47-A' })
    const list = await tool('child47_get')
    checks.push({ name: 'child47', ok: a47.payload.status === 'registered' && replay.payload.replayed === true && list.payload.count === 1, detail: `replay=${String(replay.payload.replayed)} count=${String(list.payload.count)}` })

    const build = await tool('child49_build')
    checks.push({ name: 'child49', ok: build.payload.status === 'failed', detail: JSON.stringify(build.payload) })
  } finally {
    child.kill()
  }
  return { ok: checks.every((check) => check.ok), checks }
}

function supportDeclaration(): string {
  return `# R9.1 支持范围声明（子代理全权限 + 并行，开跑前固定）

生成时间：${new Date().toISOString()}
状态：**草案（阶段 A；engine task-20 完成、Lead 信号后冻结）**
应用版本：1.0.0（不改版本号、不打包 release）

> 用户明确纠正：子代理必须与主代理权限完全一致，不能只读/串行。R9.1 不再把 M43–M47 预登记 UNSUPPORTED；
> M47 的“重启持久恢复”以实际证据为准，若实现缺失，运行后如实记 UNSUPPORTED/INVALID 并说明，不在开跑前缩分母。
> 旧 R9 支持声明/报告保留，作为“只读子代理”旧口径对照，不回填旧成绩。

## M40–M49（10 题，全部支持）

| 题号 | 声明 | 依赖 | 说明 |
|---|---|---|---|
${QUESTIONS.map((spec) => `| ${spec.id} | ✅ 支持 | ${(spec.requires ?? []).join('/') || '—'} | ${spec.supportNote} |`).join('\n')}

**合计**：10 题全部进入支持范围；M47 若实测无持久恢复，按实际证据记 UNSUPPORTED/INVALID，不提前缩分母。

## 实际范围（不扩大权限）

- 子代理：与主代理同工具集（排除嵌套 task；update_goal 仍只主代理），同 permissionMode/mode/工作区/snapshot/MCP/审批链；只读父或 chat 模式子代理仍只读。
- M43：两个真实 task 并行，时间线重叠；子任务各自写 out/a.json / out/b.json；父任务写最终 result。
- M44：父取消向在途子任务/工具传播；t0 后观察 10s/30s 无新 child44_wait、无孤儿；父任务不标完成。单子任务通过不代表多子任务树全部验证。
- M45：child45_read B 在 30s 后返回标准 timeout；父保留 A=7、B=null、total=null，不补 0、不重试。
- M46：子代理保留 child46_read 的真实 isError（validation_error）；父结果 failed/0/validation_error，不重试、不换参数。
- M47：真实中断/重开同一账户，恢复原任务后先查询再幂等登记；只有实际实现持久恢复并通过检查才计 PASS，否则按证据记录。
- 旧 M01–M39 本轮不重跑，不合并成 49 题总分；R2-A—R2-H 机制回归单独计分（8 项，不计入自主能力）。

## 阶段 B 预算与产出

- 真实 DeepSeek：M40–M49 仅一遍，估算 **80–150 次请求**（硬上限另行确认）；M43–M47 若实际能力具备全部消耗请求。
- R2-A—R2-H 用 scripted/本地 mock（0 真实请求），单独报 /8。
- 证据：\`tmp/audit/r9-1/live/**\`；结果 \`docs/audit/r9-1-results.json\`；报告 \`docs/AUDIT-REPORT-R9.1.md\`。
- 需要的 mock 配置：\`MORROW_MCP_CONFIG\` 指向本地 \`morrow_mock\`（child44/45/46/47/49）；M45 live 设 \`MORROW_MOCK_CHILD45_TIMEOUT_MS=30000\`（阶段 A 自检用 50ms）。
`
}

describe('R9.1 阶段 A 自检（零真实费用）', () => {
  it('M40–M49 全部支持登记 + M43–M47 reference checker + mock 语义 + 声明草案', async () => {
    expect(QUESTIONS.map((spec) => spec.id)).toEqual(R91_EXPECTED_IDS)
    expect(QUESTIONS.every((spec) => spec.declaredSupport === 'supported')).toBe(true)
    for (const spec of QUESTIONS) expect(spec.supportNote.length, spec.id).toBeGreaterThan(8)

    // fixtures
    rmSync(FIXTURE_ROOT, { recursive: true, force: true })
    mkdirSync(FIXTURE_ROOT, { recursive: true })
    for (const spec of QUESTIONS) {
      const root = join(FIXTURE_ROOT, spec.id, 'ws')
      for (const [relative, content] of Object.entries(spec.workspaceFiles ?? {})) {
        const absolute = join(root, relative)
        mkdirSync(join(absolute, '..'), { recursive: true })
        writeFileSync(absolute, content, 'utf8')
      }
      for (const [relative, content] of Object.entries(spec.outFiles ?? {})) {
        const absolute = join(root, relative)
        mkdirSync(join(absolute, '..'), { recursive: true })
        writeFileSync(absolute, content, 'utf8')
      }
    }

    // 空输出不能误判 PASS（M43–M47；其余题 R9 phase-a 已覆盖）
    for (const spec of QUESTIONS.filter((item) => ['M43', 'M44', 'M45', 'M46', 'M47'].includes(item.id))) {
      const workspace = join(FIXTURE_ROOT, spec.id, 'empty', 'ws')
      mkdirSync(workspace, { recursive: true })
      const result = spec.checker(emptyContext(workspace, join(FIXTURE_ROOT, spec.id, 'empty')))
      expect(result.ok, `${spec.id} 空输出未拒绝`).toBe(false)
    }

    const refs = QUESTIONS.filter((spec) => ['M43', 'M44', 'M45', 'M46', 'M47'].includes(spec.id)).map((spec) => ({ id: spec.id, ...referenceCheck(spec) }))
    const failedRefs = refs.filter((item) => !item.ok)
    expect(failedRefs, JSON.stringify(failedRefs)).toHaveLength(0)

    const mock = await checkMock()
    expect(mock.ok, JSON.stringify(mock.checks.filter((item) => !item.ok))).toBe(true)

    mkdirSync(LOG_DIR, { recursive: true })
    const existingDeclaration = existsSync(DECLARATION) ? readFileSync(DECLARATION, 'utf8') : ''
    if (!existingDeclaration.includes('已冻结') || process.env.MORROW_R9_1_DECL_UPDATE === '1') {
      writeFileSync(DECLARATION, supportDeclaration(), 'utf8')
    }
    const report = {
      at: new Date().toISOString(),
      mode: 'R9.1 subagent full-permission + parallel preparation',
      specs: { ids: R91_EXPECTED_IDS, allSupported: true },
      referenceResults: refs,
      mock,
      declaration: DECLARATION.replace(PROJECT_ROOT, '.').replace(/\\/g, '/'),
      note: '阶段 A 零真实费用；真实并行/全权限需 engine task-20 完成并经 Lead 信号后跑 live。'
    }
    writeFileSync(join(LOG_DIR, 'r9-1-phase-a.json'), JSON.stringify(report, null, 2), 'utf8')
    writeFileSync(
      join(LOG_DIR, 'r9-1-phase-a.log'),
      [
        '# R9.1 阶段 A 离线自检',
        `# 时间: ${new Date().toISOString()}`,
        `# specs: ${QUESTIONS.length}（全部支持）`,
        `# reference checker: ${refs.filter((item) => item.ok).length}/${refs.length}`,
        `# mock: ${mock.checks.filter((item) => item.ok).length}/${mock.checks.length}`,
        ...refs.map((item) => `${item.id}\t${item.ok ? 'PASS' : 'FAIL'}\t${item.detail}`),
        '',
        ...mock.checks.map((check) => `${check.name}\t${check.ok}\t${check.detail}`)
      ].join('\n'),
      'utf8'
    )
  }, 300_000)
})
