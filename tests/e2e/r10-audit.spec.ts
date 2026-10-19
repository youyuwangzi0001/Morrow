/**
 * R10 审计 · 跨领域功能/安全验收（独立探针；不依赖队友 E2E 的断言）。
 *
 * 覆盖矩阵重点：
 * - 文件：中文路径/内容、路径穿越、绝对外部路径、二进制、只读、mtime 冲突、删除确认、版本历史；
 * - 搜索：中文命中、跨工作区标记不泄漏；
 * - 技能：正常 zip 安装、zip-slip 拒绝且不落盘；
 * - 记忆/项目：旧 MEMORY 迁移、项目创建、知识文件越界拒绝；
 * - 连接器/浏览器：HTTP MCP mock、SSRF/file 协议拒绝、浏览器 file/javascript 拒绝、本地页面打开；
 * - UI 走查：工作台面板截图 + 横向溢出检查。
 *
 * 运行：npm run build && npx playwright test tests/e2e/r10-audit.spec.ts
 * 不修改产品代码；fixtures 来自 tmp/audit/r10/fixtures（由 tests/audit/r10/py/build_fixtures.py 生成）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

interface InvokeResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

let app: ElectronApplication
let morrow: MorrowApp
let page: Page
let workspaceA = ''
let workspaceB = ''
let browserServer: { close: () => Promise<void>; url: string }
let mcpServer: { close: () => Promise<void>; url: string }

async function invoke<T = unknown>(channel: string, payload: Record<string, unknown> = {}): Promise<InvokeResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: requestPayload }) => {
      const api = (window as unknown as { morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } } }).morrow
      return api.features.invoke(channelName, requestPayload) as Promise<InvokeResult<T>>
    },
    { channel, payload }
  )
}

async function createSession(workspace: string): Promise<void> {
  await page.evaluate(async (ws) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().newSession({ workspace: ws })
  }, workspace)
  await page.waitForTimeout(800)
}

async function startBrowserMock(): Promise<{ close: () => Promise<void>; url: string }> {
  const module = await import('../audit/r10/mocks/browser-server.mjs')
  const server = module.createBrowserFixtureServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function startMcpMock(): Promise<{ close: () => Promise<void>; url: string }> {
  const module = await import('../audit/r10/mocks/mcp-http-sse.mjs')
  const { server } = module.createMcpHttpSseFixture()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('R10 审计跨领域验收', () => {
  test.beforeAll(async () => {
    const fixtureRoot = join(root, 'tmp', 'audit', 'r10', 'fixtures')
    expect(existsSync(join(fixtureRoot, 'manifest.json')), 'fixtures 未生成，先跑 tests/audit/r10/py/build_fixtures.py').toBe(true)
    const stamp = Date.now()
    workspaceA = join(root, 'tmp', `r10-audit-A-${stamp}`)
    workspaceB = join(root, 'tmp', `r10-audit-B-${stamp}`)
    rmSync(workspaceA, { recursive: true, force: true })
    rmSync(workspaceB, { recursive: true, force: true })
    cpSync(join(fixtureRoot, 'ws-main'), workspaceA, { recursive: true })
    cpSync(join(fixtureRoot, 'ws-b'), workspaceB, { recursive: true })
    mkdirSync(join(workspaceA, 'out'), { recursive: true })
    browserServer = await startBrowserMock()
    mcpServer = await startMcpMock()
    morrow = await launchMorrow({ name: 'r10-audit', waitForSelector: '.sidebar', timeoutMs: 90_000 })
    app = morrow.app
    page = morrow.page
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createSession(workspaceA)
  })

  test.afterAll(async () => {
    try {
      await app?.close()
    } catch {
      // ignore
    }
    await browserServer?.close().catch(() => undefined)
    await mcpServer?.close().catch(() => undefined)
  })

  test('feature IPC：未知频道拒绝', async () => {
    let rejected = false
    try {
      await invoke('feature:audit:not-registered', {})
    } catch {
      rejected = true
    }
    expect(rejected, '未知 feature 频道未被拒绝').toBe(true)
  })

  test('文件安全：中文/路径穿越/绝对外部/二进制/只读/冲突/删除确认/历史', async () => {
    const listed = await invoke<{ entries: Array<{ name: string }> }>('feature:files:list', { workspace: workspaceA, dir: '' })
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true)
    expect(listed.data?.entries?.some((entry) => entry.name === 'in')).toBe(true)

    const readChinese = await invoke<{ content: string }>('feature:files:read', { workspace: workspaceA, path: 'in/中文资料.txt' })
    expect(readChinese.ok, JSON.stringify(readChinese.error)).toBe(true)
    expect(readChinese.data?.content).toContain('R10-A')

    for (const path of ['../ws-b/in/private.md', '..\\ws-b\\in\\private.md', join(workspaceB, 'in', 'private.md')]) {
      const escaped = await invoke('feature:files:read', { workspace: workspaceA, path })
      expect(escaped.ok, `越界路径未被拒绝：${path}`).toBe(false)
    }

    const binary = await invoke('feature:files:read', { workspace: workspaceA, path: 'in/binary.bin' })
    expect(binary.ok && typeof (binary.data as { content?: string })?.content === 'string' && (binary.data as { content: string }).content.includes('\u0000')).toBe(false)

    const target = 'out/r10-conflict.txt'
    const first = await invoke<{ mtimeMs: number }>('feature:files:write', { workspace: workspaceA, path: target, content: 'R10-v1' })
    expect(first.ok, JSON.stringify(first.error)).toBe(true)
    const stale = first.data?.mtimeMs ?? 0
    const second = await invoke('feature:files:write', { workspace: workspaceA, path: target, content: 'R10-v2', expectedMtimeMs: stale })
    expect(second.ok, '相同 expectedMtimeMs 的重复写入应当冲突或使用新 mtime').toBe(true)
    const third = await invoke('feature:files:write', { workspace: workspaceA, path: target, content: 'R10-v3', expectedMtimeMs: stale })
    expect(third.ok, '过期 mtime 写入未被拒绝').toBe(false)
    expect(readFileSync(join(workspaceA, target), 'utf8')).toBe('R10-v2')

    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().setPermissionMode('read-only')
    })
    const readOnlyWrite = await invoke('feature:files:create', { workspace: workspaceA, path: 'out/blocked.txt', kind: 'file' })
    expect(readOnlyWrite.ok, '只读模式仍允许新建文件').toBe(false)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().setPermissionMode('ask')
    })

    const cancelDelete = await invoke('feature:files:delete', { workspace: workspaceA, path: target, confirm: false })
    expect(cancelDelete.ok, '未确认删除不应执行').toBe(false)
    const confirmDelete = await invoke('feature:files:delete', { workspace: workspaceA, path: target, confirm: true })
    expect(confirmDelete.ok, JSON.stringify(confirmDelete.error)).toBe(true)

    const historyPath = join(workspaceA, 'out', 'history.txt')
    const recorded = await invoke('feature:history:record', { path: historyPath, content: 'history-v1', source: 'user' })
    expect(recorded.ok, JSON.stringify(recorded.error)).toBe(true)
    const versions = await invoke<{ versions: Array<{ id: string }> }>('feature:history:list', { path: historyPath })
    expect(versions.ok, JSON.stringify(versions.error)).toBe(true)
    expect((versions.data?.versions ?? []).length).toBeGreaterThan(0)
  })

  test('搜索：中文命中、忽略目录、跨工作区隔离', async () => {
    const refreshed = await invoke('feature:search:refresh', { workspace: workspaceA, full: true })
    expect(refreshed.ok, JSON.stringify(refreshed.error)).toBe(true)
    const chinese = await invoke<{ total?: number }>('feature:search:query', { workspace: workspaceA, q: '季度报告', limit: 50 })
    expect(chinese.ok, JSON.stringify(chinese.error)).toBe(true)
    expect(chinese.data?.total ?? 0).toBeGreaterThan(0)
    const marker = await invoke<{ total?: number }>('feature:search:query', { workspace: workspaceA, q: 'CROSS_WS_R10_SECRET', limit: 50 })
    expect(marker.data?.total ?? 0, '跨工作区私密标记泄漏到 A 搜索').toBe(0)
    const ignored = await invoke<{ total?: number }>('feature:search:query', { workspace: workspaceA, q: 'R10_SEARCH_IGNORED_DIRECTORIES_SHOULD_NOT_MATCH', limit: 50 })
    expect(ignored.data?.total ?? 0, 'node_modules/.git 未忽略').toBe(0)
  })

  test('技能：正常 zip 安装、zip-slip 拒绝且不落盘', async () => {
    const zips = join(root, 'tmp', 'audit', 'r10', 'fixtures', 'zips')
    const good = await invoke('feature:skills:install', { sourcePath: join(zips, 'skill-good.zip'), workspace: null })
    expect(good.ok, JSON.stringify(good.error)).toBe(true)
    const slip = await invoke('feature:skills:install', { sourcePath: join(zips, 'skill-zip-slip.zip'), workspace: null })
    expect(slip.ok, 'zip-slip 技能包未被拒绝').toBe(false)
    const escaped = [join(morrow.dataDir, 'r10-evil-relative.txt'), join(morrow.dataDir, 'r10-evil-absolute.txt'), join(root, 'tmp', 'r10-evil-relative.txt')]
    for (const file of escaped) expect(existsSync(file), `zip-slip 写出了文件：${file}`).toBe(false)
  })

  test('记忆/项目：旧记忆迁移、项目创建、知识文件越界拒绝', async () => {
    const memory = await invoke<{ entries: Array<{ text: string }> }>('feature:memory:list', { scope: 'project', workspace: workspaceA })
    expect(memory.ok, JSON.stringify(memory.error)).toBe(true)
    expect(JSON.stringify(memory.data ?? {})).toContain('R10-LEGACY')
    const project = await invoke<{ id: string }>('feature:projects:create', { workspace: workspaceA, name: 'R10 Audit A' })
    expect(project.ok, JSON.stringify(project.error)).toBe(true)
    const outside = await invoke('feature:projects:knowledge-validate', { workspace: workspaceA, path: join(workspaceB, 'in', 'private.md') })
    expect(outside.ok, '项目知识文件越界未被拒绝').toBe(false)
    const projectB = await invoke('feature:projects:get', { workspace: workspaceB })
    expect(projectB.ok).toBe(true)
    expect(projectB.data ?? null).toBeNull()
  })

  test('连接器：模板示例标记、HTTP mock 测试、SSRF/file 协议拒绝', async () => {
    const templates = await invoke<Array<{ exampleOnly: boolean }>>('feature:connectors:templates', {})
    expect(templates.ok, JSON.stringify(templates.error)).toBe(true)
    expect(templates.data?.every((item) => item.exampleOnly === true)).toBe(true)

    const draft = { name: 'r10-audit-http', transport: 'http', url: mcpServer.url, headers: [], env: [], allowPrivateNetwork: true }
    const allowed = await invoke<{ ok?: boolean }>('feature:connectors:test', { scope: 'user', draft })
    expect(allowed.ok, JSON.stringify(allowed.error)).toBe(true)
    expect(allowed.data?.ok, JSON.stringify(allowed.data)).toBe(true)
    const fileDraft = { name: 'r10-audit-file', transport: 'http', url: 'file:///C:/Windows/win.ini', headers: [], env: [] }
    const fileBlocked = await invoke<{ ok?: boolean }>('feature:connectors:test', { scope: 'user', draft: fileDraft })
    expect(fileBlocked.data?.ok, 'file:// MCP 未被拒绝').toBe(false)
    const metadataDraft = { name: 'r10-audit-meta', transport: 'http', url: 'http://169.254.169.254/latest/meta-data', headers: [], env: [] }
    const metadataBlocked = await invoke<{ ok?: boolean; blockedReason?: string }>('feature:connectors:test', { scope: 'user', draft: metadataDraft })
    expect(metadataBlocked.data?.ok, '云元数据地址未被 SSRF 拦截').toBe(false)
  })

  test('浏览器：file/javascript 拒绝、本地 HTTP 打开、UI 走查截图', async () => {
    for (const badUrl of ['file:///C:/Windows/win.ini', 'javascript:alert(1)']) {
      const result = await invoke('feature:browser:open', { url: badUrl })
      expect(result.ok, `危险 URL 未被拒绝：${badUrl}`).toBe(false)
    }
    const opened = await invoke('feature:browser:open', {
      url: `${browserServer.url}/`,
      bounds: { x: 80, y: 120, width: 760, height: 460 }
    })
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    await page.waitForTimeout(800)
    const state = await invoke<{ url?: string; title?: string }>('feature:browser:get-state')
    expect(state.ok).toBe(true)
    expect(String(state.data?.url ?? '')).toContain(browserServer.url.replace('http://127.0.0.1:', ''))
    expect(String(state.data?.title ?? '')).toContain('R10')
    await invoke('feature:browser:close')

    const panels = ['技能库', '记忆中心', '项目', '连接器', '全局搜索', '内置浏览器']
    for (const panel of panels) {
      await page.keyboard.press('Control+Shift+W')
      await expect(page.locator('.workbench-card')).toHaveCount(6)
      await page.locator('.workbench-card').filter({ hasText: panel }).click()
      await page.waitForTimeout(700)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${panel} 横向溢出 ${overflow}px`).toBeLessThanOrEqual(2)
      await page.screenshot({ path: screenshotPath(`r10-audit-${panel}.png`) })
      if (panel === '内置浏览器') await page.locator('.browser-close').click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
  })
})
