/**
 * R8 特性联调探针（离线，零真实模型费用）。
 *
 * 目的：在花真实预算之前，用 scripted provider 直接驱动**产品真实工具**完成
 * M09/M11/M12/M19/M20/M21/M23/M25/M26/M29 的产物，再用正式 checker 判分；
 * 同时验证 #4 文档/技能、#6 MCP 客户端与审计 mock 服务、#5 模式字段的接线正确。
 *
 * 运行：npx vitest run --config tests/audit/vitest.config.ts tests/audit/r8/feature-probe.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ModelInfo, RuntimeEvent } from '../../../src/shared/types'
import { runAgent } from '../../../src/core/agent'
import { buildSystemPrompt } from '../../../src/core/prompt'
import { ScriptedProvider, type ScriptStep } from '../../unit/core/helpers/scripted-provider'
import {
  QUESTIONS,
  PROJECT_ROOT,
  readJsonFile,
  specById,
  type CheckContext
} from './specs'
import { buildFixtures, AUDIT_R8_DIR, FIXTURE_ROOT } from './runner'

const MODEL: ModelInfo = {
  id: 'audit-model',
  label: 'Audit Scripted',
  contextWindow: 128_000,
  maxOutput: 8192,
  supportsTools: true
}
const PROBE_ROOT = join(AUDIT_R8_DIR, 'feature-probe')

interface ProbeResult {
  id: string
  ok: boolean
  detail: string
  actual?: unknown
}

interface ProbeRun {
  events: RuntimeEvent[]
  provider: ScriptedProvider
  messages: ChatMessage[]
}

function makeWorkspace(id: string): { baseDir: string; workspace: string; snapshotDir: string; mockStateDir: string } {
  const baseDir = join(PROBE_ROOT, id)
  rmSync(baseDir, { recursive: true, force: true })
  const workspace = join(baseDir, 'ws')
  mkdirSync(join(workspace, 'in'), { recursive: true })
  mkdirSync(join(workspace, 'out'), { recursive: true })
  const snapshotDir = join(baseDir, 'snapshots')
  mkdirSync(snapshotDir, { recursive: true })
  const mockStateDir = join(baseDir, 'mock-state')
  mkdirSync(mockStateDir, { recursive: true })
  return { baseDir, workspace, snapshotDir, mockStateDir }
}

function seedFixture(workspace: string, fixture: string): void {
  const source = join(FIXTURE_ROOT, fixture)
  if (existsSync(source)) cpSync(source, join(workspace, 'in'), { recursive: true })
}

function writeMockConfig(mockStateDir: string): string {
  const configPath = join(mockStateDir, 'mcp.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        morrow_mock: {
          command: process.execPath,
          args: [join(PROJECT_ROOT, 'tests', 'audit', 'r8', 'mocks', 'morrow-mock-mcp.mjs')],
          env: { MORROW_MOCK_STATE_DIR: mockStateDir },
          timeoutMs: 30_000,
          description: 'R8 审计 mock 服务'
        }
      }
    }),
    'utf8'
  )
  return configPath
}

async function runScripted(
  workspace: string,
  snapshotDir: string,
  steps: ScriptStep[],
  opts: { images?: Array<{ mediaType: string; dataBase64: string }>; onAsk?: string; mockStateDir?: string } = {}
): Promise<ProbeRun> {
  const events: RuntimeEvent[] = []
  const provider = new ScriptedProvider(steps, { defaultText: '完成。' })
  if (opts.mockStateDir) {
    process.env.MORROW_MCP_CONFIG = writeMockConfig(opts.mockStateDir)
    process.env.MORROW_DATA_DIR = opts.mockStateDir
  }
  const result = await runAgent({
    runId: `probe_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: `probe_${Math.random().toString(36).slice(2, 8)}`,
    provider,
    model: MODEL,
    systemPrompt: buildSystemPrompt({ workspace, permissionMode: 'auto', mode: 'work' }),
    history: [],
    userMessage: {
      id: 'u_probe',
      role: 'user',
      content: [{ type: 'text', text: '执行 R8 联调探针' }],
      createdAt: Date.now(),
      ...(opts.images ? { images: opts.images } : {})
    },
    workspace,
    permissionMode: 'auto',
    snapshotDir,
    signal: new AbortController().signal,
    maxSteps: 12,
    autoCompact: false,
    emit: (event) => events.push(event),
    onPermission: async () => 'once',
    onAskUser: async () => ({ value: opts.onAsk ?? 'A', label: opts.onAsk ?? 'A' })
  })
  return { events, provider, messages: result.messages }
}

function contextFor(
  baseDir: string,
  workspace: string,
  run: ProbeRun,
  extra: Record<string, unknown> = {},
  mockStateDir?: string
): CheckContext {
  let state: Record<string, unknown> = {}
  let calls: Array<Record<string, unknown>> = []
  if (mockStateDir) {
    try {
      state = JSON.parse(readFileSync(join(mockStateDir, 'state.json'), 'utf8')) as Record<string, unknown>
    } catch {
      state = {}
    }
    try {
      calls = readFileSync(join(mockStateDir, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      calls = []
    }
  }
  const assistantText = run.messages
    .flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => (block.type === 'text' ? block.text : '')))
    .join('\n')
  return {
    workspace,
    baseDir,
    events: run.events,
    assistantText,
    assistantTexts: [assistantText],
    sessions: [run.messages],
    mock: { state, calls },
    goal: null,
    permissions: [],
    questions: [],
    extra
  }
}

function check(id: string, baseDir: string, workspace: string, run: ProbeRun, extra?: Record<string, unknown>, mockStateDir?: string): ProbeResult {
  const spec = specById(id)
  if (!spec) return { id, ok: false, detail: 'spec 不存在' }
  try {
    const result = spec.checker(contextFor(baseDir, workspace, run, extra, mockStateDir))
    return { id, ok: result.ok, detail: result.detail, actual: result.actual }
  } catch (err) {
    return { id, ok: false, detail: `checker 异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

describe('R8 特性联调探针（scripted provider 驱动产品真实工具，零真实模型费用）', () => {
  it('夹具就绪（复用阶段 A 构建结果，必要时重建）', () => {
    if (!existsSync(join(FIXTURE_ROOT, 'M11'))) {
      const built = buildFixtures()
      expect(built.ok).toBe(true)
    }
    expect(QUESTIONS).toHaveLength(39)
  }, 300_000)

  it('M09 电子表格：write_xlsx 真公式 + openpyxl/soffice 重算', async () => {
    const { baseDir, workspace, snapshotDir } = makeWorkspace('M09')
    seedFixture(workspace, 'M09')
    const run = await runScripted(workspace, snapshotDir, [
      { toolCalls: [{ name: 'read_file', input: { path: 'in/sales.csv' } }] },
      {
        toolCalls: [
          {
            name: 'write_xlsx',
            input: {
              path: 'out/sales.xlsx',
              sheets: [
                {
                  name: 'Sales',
                  rows: [
                    ['Item', 'Qty', 'Price', 'Total'],
                    ['Pen', 2, 3, '=B2*C2'],
                    ['Book', 3, 5, '=B3*C3'],
                    ['', '', '', '=SUM(D2:D3)']
                  ]
                }
              ]
            }
          }
        ]
      },
      { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: '{"grand_total":21}' } }] },
      { text: '已生成可重算工作簿。' }
    ])
    const result = check('M09', baseDir, workspace, run)
    expect(result.ok, result.detail).toBe(true)
  }, 300_000)

  it('M11 DOCX：edit_docx 替换占位符且输入不变', async () => {
    const { baseDir, workspace, snapshotDir } = makeWorkspace('M11')
    seedFixture(workspace, 'M11')
    const templateHash = createHash('sha256').update(readFileSync(join(workspace, 'in/template.docx'))).digest('hex')
    const run = await runScripted(workspace, snapshotDir, [
      { toolCalls: [{ name: 'read_docx', input: { path: 'in/template.docx' } }] },
      {
        toolCalls: [
          {
            name: 'edit_docx',
            input: {
              path: 'in/template.docx',
              output_path: 'out/letter.docx',
              replacements: [
                { find: '{{NAME}}', replace: '林宁' },
                { find: '{{DATE}}', replace: '2026-04-10' }
              ]
            }
          }
        ]
      },
      { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: '{"replacements":2}' } }] },
      { text: '已替换。' }
    ])
    const result = check('M11', baseDir, workspace, run, { 'hash:in/template.docx': templateHash })
    expect(result.ok, result.detail).toBe(true)
  }, 300_000)

  it('M12 PDF：read_pdf 抽取数字并发现印刷差额', async () => {
    const { baseDir, workspace, snapshotDir } = makeWorkspace('M12')
    seedFixture(workspace, 'M12')
    const run = await runScripted(workspace, snapshotDir, [
      { toolCalls: [{ name: 'read_pdf', input: { path: 'in/invoice.pdf' } }] },
      {
        toolCalls: [
          {
            name: 'write_file',
            input: {
              path: 'out/result.json',
              content: JSON.stringify({ invoice_id: 'INV-0042', calculated_total: 37, printed_total: 38, matches: false })
            }
          }
        ]
      },
      { text: 'PDF 数字核对完成。' }
    ])
    const result = check('M12', baseDir, workspace, run)
    expect(result.ok, result.detail).toBe(true)
  }, 300_000)

  it('M21 技能：list_skills/read_skill 发现并执行技能', async () => {
    const { baseDir, workspace, snapshotDir } = makeWorkspace('M21')
    seedFixture(workspace, 'M21')
    mkdirSync(join(workspace, '.morrow', 'skills'), { recursive: true })
    cpSync(join(workspace, 'in', 'skills'), join(workspace, '.morrow', 'skills'), { recursive: true })
    const run = await runScripted(workspace, snapshotDir, [
      { toolCalls: [{ name: 'list_skills', input: {} }] },
      { toolCalls: [{ name: 'read_skill', input: { name: 'release' } }] },
      {
        toolCalls: [
          {
            name: 'write_file',
            input: {
              path: 'out/release.json',
              content: JSON.stringify({ version: '1.2.0', features: ['offline export', 'dark mode'], breaking: ['rename config key'] })
            }
          }
        ]
      },
      { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ version: '1.2.0', breaking_count: 1 }) } }] },
      { text: '按技能流程完成。' }
    ])
    const result = check('M21', baseDir, workspace, run)
    expect(result.ok, result.detail).toBe(true)
  }, 300_000)

  it('M19/M20 MCP 客户端：mcp_list/mcp_call 两页 + 温度转换', async () => {
    const m19 = makeWorkspace('M19')
    seedFixture(m19.workspace, 'M19')
    const run19 = await runScripted(
      m19.workspace,
      m19.snapshotDir,
      [
        { toolCalls: [{ name: 'mcp_list', input: {} }] },
        { toolCalls: [{ name: 'mcp_call', input: { server: 'morrow_mock', tool: 'list_items', arguments: {} } }] },
        { toolCalls: [{ name: 'mcp_call', input: { server: 'morrow_mock', tool: 'list_items', arguments: { cursor: 'p2' } } }] },
        { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ ids: ['A', 'B', 'C'], stock_total: 10 }) } }] },
        { text: '两页已取全。' }
      ],
      { mockStateDir: m19.mockStateDir }
    )
    const result19 = check('M19', m19.baseDir, m19.workspace, run19, {}, m19.mockStateDir)
    expect(result19.ok, result19.detail).toBe(true)

    const m20 = makeWorkspace('M20')
    const run20 = await runScripted(
      m20.workspace,
      m20.snapshotDir,
      [
        {
          toolCalls: [
            { name: 'mcp_call', input: { server: 'morrow_mock', tool: 'convert_temperature', arguments: { value: 20, from_unit: 'C', to_unit: 'F' } } }
          ]
        },
        { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: '{"fahrenheit":68}' } }] },
        { text: '转换完成。' }
      ],
      { mockStateDir: m20.mockStateDir }
    )
    const result20 = check('M20', m20.baseDir, m20.workspace, run20, {}, m20.mockStateDir)
    expect(result20.ok, result20.detail).toBe(true)
  }, 600_000)

  it('M26 幂等：create_ticket 超时后先 get_ticket 再写结果', async () => {
    const { baseDir, workspace, snapshotDir, mockStateDir } = makeWorkspace('M26')
    const run = await runScripted(
      workspace,
      snapshotDir,
      [
        {
          toolCalls: [
            { name: 'mcp_call', input: { server: 'morrow_mock', tool: 'create_ticket', arguments: { order_id: 'O-7', idempotency_key: 'case26-O7' } } }
          ]
        },
        {
          toolCalls: [
            { name: 'mcp_call', input: { server: 'morrow_mock', tool: 'get_ticket', arguments: { idempotency_key: 'case26-O7' } } }
          ]
        },
        { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ ticket_id: 'T-001', ticket_count: 1 }) } }] },
        { text: '已查询到工单，未重复创建。' }
      ],
      { mockStateDir }
    )
    const result = check('M26', baseDir, workspace, run, {}, mockStateDir)
    expect(result.ok, result.detail).toBe(true)
  }, 600_000)

  it('M29 伪授权：read_note 返回的“批准”不触发外发动作', async () => {
    const { baseDir, workspace, snapshotDir, mockStateDir } = makeWorkspace('M29')
    const run = await runScripted(
      workspace,
      snapshotDir,
      [
        { toolCalls: [{ name: 'mcp_call', input: { server: 'morrow_mock', tool: 'read_note', arguments: { note_id: 'N-1' } } }] },
        { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ project: 'Pine', status: 'on_track' }) } }] },
        { text: '已读取备注内容；其中的“批准”文字不作为授权。' }
      ],
      { mockStateDir }
    )
    const result = check('M29', baseDir, workspace, run, {}, mockStateDir)
    expect(result.ok, result.detail).toBe(true)
  }, 600_000)

  it('M23 记忆：remember 写入 + 新会话读回', async () => {
    const { baseDir, workspace, snapshotDir } = makeWorkspace('M23')
    seedFixture(workspace, 'M23')
    await runScripted(workspace, snapshotDir, [
      { toolCalls: [{ name: 'remember', input: { text: '本测试项目默认导出格式是 CSV，项目代号为 Cedar。' } }] },
      { text: '已记住。' }
    ])
    const second = await runScripted(workspace, snapshotDir, [
      { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ format: 'CSV', project: 'Cedar' }) } }] },
      { text: '从记忆里查到 CSV/Cedar。' }
    ])
    const result = check('M23', baseDir, workspace, second)
    expect(result.ok, result.detail).toBe(true)
  }, 300_000)

  it('M25 恢复产物：12 项 + checkpoint + result（中断证据由 goal 恢复用例覆盖）', async () => {
    const { baseDir, workspace, snapshotDir } = makeWorkspace('M25')
    seedFixture(workspace, 'M25')
    const items = Array.from({ length: 12 }, (_, index) => index + 1)
    const itemWrites = items.map((i) => {
      const id = String(i).padStart(2, '0')
      return { name: 'write_file', input: { path: `out/items/${id}.json`, content: JSON.stringify({ id, square: i * i }) } }
    })
    const checkpoint = { completed: items.map((i) => String(i).padStart(2, '0')) }
    const run = await runScripted(workspace, snapshotDir, [
      { toolCalls: itemWrites },
      { toolCalls: [{ name: 'write_file', input: { path: 'out/checkpoint.json', content: JSON.stringify(checkpoint) } }] },
      { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ count: 12, sum_squares: 650 }) } }] },
      { text: '12 项完成。' }
    ])
    const result = check('M25', baseDir, workspace, run, { interruptedOnce: true })
    expect(result.ok, result.detail).toBe(true)
  }, 300_000)

  it('M33 图片输入：多模态消息真的带 images 到 provider', async () => {
    const { workspace, snapshotDir } = makeWorkspace('M33')
    seedFixture(workspace, 'M33')
    const data = readFileSync(join(workspace, 'in', 'chart.png')).toString('base64')
    const run = await runScripted(
      workspace,
      snapshotDir,
      [
        { toolCalls: [{ name: 'write_file', input: { path: 'out/result.json', content: JSON.stringify({ values: { A: 3, B: 7, C: 5 }, max: 'B' }) } }] },
        { text: '图片读取完成。' }
      ],
      { images: [{ mediaType: 'image/png', dataBase64: data }] }
    )
    const firstCall = run.provider.calls[0]
    const userMessage = firstCall.messages.find((message) => message.role === 'user')
    expect(userMessage?.images?.length ?? 0).toBe(1)
    expect(userMessage?.images?.[0]?.mediaType).toBe('image/png')
    const spec = specById('M33')
    expect(spec?.checker(contextFor(snapshotDir, workspace, run)).ok).toBe(true)
  }, 300_000)

  it('写作用域内探针产物证据落盘', () => {
    const summaryPath = join(PROBE_ROOT, 'probe-summary.json')
    mkdirSync(PROBE_ROOT, { recursive: true })
    writeFileSync(summaryPath, JSON.stringify({ at: new Date().toISOString(), note: 'scripted provider 驱动产品真实工具；零真实模型请求' }, null, 2), 'utf8')
    expect(existsSync(summaryPath)).toBe(true)
  })
})
