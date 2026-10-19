/**
 * R10 阶段 A：零费用准备自检。
 *
 * 校验：验收矩阵存在且覆盖 A/B/F/C/K1/G/K2/H/D/E/I/K3 与关键安全项；
 * fixtures（含恶意 zip）可生成；浏览器 HTTP mock / MCP HTTP+SSE mock 可启动并响应；
 * 扫描功能模块落地情况（缺失只记录，不判产品 FAIL；等 Lead「功能可验收」后再执行矩阵）。
 *
 * 命令：npx vitest run --config tests/audit/vitest.config.ts tests/audit/r10/phase-a.test.ts
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../helpers'

const R10_ROOT = join(PROJECT_ROOT, 'tmp', 'audit', 'r10')
const FIXTURE_ROOT = join(R10_ROOT, 'fixtures')
const LOG_DIR = join(PROJECT_ROOT, 'docs', 'audit', 'logs')
const MATRIX = join(PROJECT_ROOT, 'docs', 'audit', 'r10-verification-matrix.md')
const PY = process.platform === 'win32' ? 'python' : 'python3'

const EXPECTED_MODULES: Array<{ area: string; paths: string[] }> = [
  { area: 'A 文件', paths: ['src/main/services/workspace-files.ts', 'src/main/features/files.ts', 'src/renderer/src/features/files'] },
  { area: 'B/F 编辑器', paths: ['src/main/services/editor-history.ts', 'src/main/features/editor-history.ts', 'src/renderer/src/components/editor', 'src/renderer/src/features/artifacts'] },
  { area: 'C/K1 浏览器', paths: ['src/main/services/browser-service.ts', 'src/main/features/browser.ts', 'src/core/browser-bridge.ts', 'src/core/tools/browser-tools.ts', 'src/renderer/src/features/browser'] },
  { area: 'G/K2 MCP', paths: ['src/main/services/mcp-service.ts', 'src/main/features/connectors.ts', 'src/renderer/src/features/connectors'] },
  { area: 'H 技能', paths: ['src/main/services/skills-service.ts', 'src/main/features/skills.ts', 'src/renderer/src/features/skills'] },
  { area: 'D/E 记忆/项目', paths: ['src/main/services/memory-service.ts', 'src/main/services/project-service.ts', 'src/main/features/memory.ts', 'src/main/features/projects.ts', 'src/renderer/src/features/memory', 'src/renderer/src/features/projects'] },
  { area: 'I/K3 搜索/computer', paths: ['src/main/services/search-service.ts', 'src/main/features/search.ts', 'src/renderer/src/features/search', 'src/core/tools/computer-tools.ts'] }
]

const REQUIRED_MATRIX_KEYWORDS = [
  'A. 文件树',
  'B/F. 编辑器',
  'C/K1. 浏览器',
  'G/K2. MCP',
  'H. 技能库',
  'D/E. 记忆',
  'I/K3. 全局搜索',
  'zip-slip',
  '跨工作区',
  '中文',
  'ask',
  '证书',
  '只读',
  '冲突'
]

function runPython(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(PY, args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60_000 })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function checkBrowserMock(): Promise<{ ok: boolean; detail: string }> {
  const module = await import('./mocks/browser-server.mjs')
  const server = module.createBrowserFixtureServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  try {
    const home = await fetch(`${base}/`)
    const html = await home.text()
    const page2 = await fetch(`${base}/page2`)
    const redirect = await fetch(`${base}/redirect`, { redirect: 'manual' })
    const slow = await fetch(`${base}/slow`)
    const slowText = await slow.text()
    const download = await fetch(`${base}/download`)
    const downloadBuffer = Buffer.from(await download.arrayBuffer())
    const checks = [
      home.status === 200 && html.includes('R10 Home') && html.includes('R10 Browser Fixture'),
      page2.status === 200 && (await page2.text()).includes('R10 Page2'),
      redirect.status === 302 && redirect.headers.get('location') === '/page2',
      slow.status === 200 && slowText === 'slow-done',
      download.status === 200 && downloadBuffer.length > 0
    ]
    return { ok: checks.every(Boolean), detail: `routes=${checks.filter(Boolean).length}/5 base=${base}` }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function checkMcpHttpSseMock(): Promise<{ ok: boolean; detail: string }> {
  const module = await import('./mocks/mcp-http-sse.mjs')
  const { server, state } = module.createMcpHttpSseFixture()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  const rpc = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })
    })
    return (await response.json()) as Record<string, unknown>
  }
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r10-audit', version: '1' } })
    const list = await rpc('tools/list')
    const tools = ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name)
    const echo = await rpc('tools/call', { name: 'echo', arguments: { text: '你好 R10' } })
    const echoText = (echo.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? ''
    const slow = await rpc('tools/call', { name: 'slow', arguments: { delayMs: 50 } })
    const bad = await rpc('tools/call', { name: 'bad', arguments: {} })
    const badIsError = (bad.result as { isError?: boolean } | undefined)?.isError === true
    const sse = await new Promise<string>(async (resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        reject(new Error('SSE endpoint 超时'))
      }, 3000)
      try {
        const response = await fetch(`${base}/sse`, { signal: controller.signal })
        const reader = response.body?.getReader()
        const chunk = reader ? await reader.read() : { value: undefined }
        clearTimeout(timer)
        controller.abort()
        resolve(chunk.value ? Buffer.from(chunk.value).toString('utf8') : '')
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
    const checks = [
      Boolean(init.result),
      tools.includes('echo') && tools.includes('slow') && tools.includes('bad'),
      echoText.includes('你好 R10'),
      Boolean(slow.result),
      badIsError,
      sse.includes('event: endpoint') && sse.includes('/messages?sessionId=')
    ]
    return { ok: checks.every(Boolean), detail: `checks=${checks.filter(Boolean).length}/6 calls=${state.calls.length}` }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('R10 阶段 A 准备自检（零费用）', () => {
  it('验收矩阵/fixtures/浏览器与 MCP HTTP+SSE mock/模块落地扫描', async () => {
    // 1) 矩阵完整性
    expect(existsSync(MATRIX)).toBe(true)
    const matrix = readFileSync(MATRIX, 'utf8')
    for (const keyword of REQUIRED_MATRIX_KEYWORDS) expect(matrix, `矩阵缺少关键字 ${keyword}`).toContain(keyword)
    const rowCount = (matrix.match(/^\| R10-[A-Z0-9]+ \|/gm) ?? []).length
    expect(rowCount, '验收矩阵条目过少').toBeGreaterThanOrEqual(35)

    // 2) fixtures 构建（Python stdlib：zip-slip/中文/二进制/大文件/旧记忆）
    const built = runPython(['tests/audit/r10/py/build_fixtures.py'])
    expect(built.status, built.stderr).toBe(0)
    const fixtureReport = JSON.parse(built.stdout.trim().split(/\r?\n/).pop() ?? '{}') as { ok?: boolean; files?: number }
    expect(fixtureReport.ok).toBe(true)
    const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8')) as { files: Array<{ path: string }>; crossWorkspaceMarker: string }
    const paths = manifest.files.map((file) => file.path)
    expect(paths).toContain('ws-main/in/中文资料.txt')
    expect(paths).toContain('ws-main/in/binary.bin')
    expect(paths).toContain('ws-b/in/private.md')
    expect(paths).toContain('zips/skill-zip-slip.zip')
    const zipCheck = runPython([
      '-c',
      'import zipfile,json;z=zipfile.ZipFile(r"tmp/audit/r10/fixtures/zips/skill-zip-slip.zip");print(json.dumps(z.namelist(),ensure_ascii=False))'
    ])
    expect(zipCheck.status, zipCheck.stderr).toBe(0)
    const zipNames = JSON.parse(zipCheck.stdout.trim()) as string[]
    expect(zipNames.some((name) => name.includes('..'))).toBe(true)
    expect(zipNames.some((name) => name.startsWith('/'))).toBe(true)

    // 3) mock 服务
    const browser = await checkBrowserMock()
    expect(browser.ok, browser.detail).toBe(true)
    const mcp = await checkMcpHttpSseMock()
    expect(mcp.ok, mcp.detail).toBe(true)

    // 4) 功能模块落地扫描（准备阶段只记录；缺模块不判产品失败）
    const modules = EXPECTED_MODULES.map((area) => ({
      area: area.area,
      missing: area.paths.filter((path) => !existsSync(join(PROJECT_ROOT, path))),
      present: area.paths.filter((path) => existsSync(join(PROJECT_ROOT, path)))
    }))
    const missingTotal = modules.reduce((sum, area) => sum + area.missing.length, 0)

    mkdirSync(LOG_DIR, { recursive: true })
    const report = {
      at: new Date().toISOString(),
      stage: 'R10 preparation',
      matrix: { path: MATRIX.replace(PROJECT_ROOT, '.').replace(/\\/g, '/'), rows: rowCount, requiredKeywords: REQUIRED_MATRIX_KEYWORDS.length },
      fixtures: { root: FIXTURE_ROOT.replace(PROJECT_ROOT, '.').replace(/\\/g, '/'), files: fixtureReport.files, crossWorkspaceMarker: manifest.crossWorkspaceMarker },
      mocks: { browser, mcp },
      modules,
      missingTotal,
      note: '准备阶段：未执行产品验收，不判 PASS/FAIL；等 Lead「功能可验收」后跑矩阵与 r10-audit E2E。'
    }
    writeFileSync(join(LOG_DIR, 'r10-phase-a.json'), JSON.stringify(report, null, 2), 'utf8')
    writeFileSync(
      join(LOG_DIR, 'r10-phase-a.log'),
      [
        '# R10 阶段 A 准备自检',
        `# 时间: ${new Date().toISOString()}`,
        `# 矩阵: ${rowCount} 行 / ${REQUIRED_MATRIX_KEYWORDS.length} 关键字`,
        `# fixtures: ${fixtureReport.files} 个文件（含恶意 zip）`,
        `# browser mock: ${browser.ok ? 'OK' : 'FAIL'} · ${browser.detail}`,
        `# mcp http/sse mock: ${mcp.ok ? 'OK' : 'FAIL'} · ${mcp.detail}`,
        `# 模块缺失: ${missingTotal}（准备阶段记录；集成后再判）`,
        ...modules.map((area) => `${area.area}\tpresent=${area.present.length}\tmissing=${area.missing.join(',') || '无'}`)
      ].join('\n'),
      'utf8'
    )
  }, 180_000)
})
