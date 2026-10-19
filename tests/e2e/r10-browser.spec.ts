/**
 * R10-C/K1 内置浏览器 E2E（真实 Electron + 真实本地 HTTP 服务）。
 *
 * 覆盖：
 * 1. feature:browser:* 频道：URL 安全（file/javascript/data 拒绝）、打开本地页、导航/后退/前进、
 *    bounds 同步、关闭；浏览器视图真实在 release 页面之外的原生 WebContentsView 中渲染。
 * 2. K1 自动化（主进程真实服务，经 --test-mode global 调用与 bridge 相同的实现）：
 *    打开页面 → 读取正文 → 真实鼠标点击 → 真实键盘输入 → 截图 PNG → 后退/前进。
 * 3. 下载确认：surface 内下载被暂停，渲染层收到 feature:browser:download 事件；拒绝不落盘、允许落盘。
 * 4. K1 审批（需 Lead 把 browserTools 接入 registry + permissions；R10_BROWSER_TOOLS_E2E=1 时运行）：
 *    ask 与 auto 模式都必须弹审批；批准后工具真实打开页面。
 *
 * 运行前：`npm run build`；本文件使用 tests/e2e/launch.ts 的隔离 data-dir/user-data-dir。
 */
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchMorrow, root } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clearEvents,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  waitForEvent,
  waitForPermission,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

/* ── 本地测试站点 ─────────────────────────────────────────────── */

interface TestSite {
  url: string
  server: Server
  close: () => Promise<void>
}

function startTestSite(): Promise<TestSite> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      const path = request.url ?? '/'
      if (path === '/page2') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html><head><title>第二页</title></head><body><h1>第二页</h1><a id="back" href="/">返回首页</a></body></html>')
        return
      }
      if (path === '/download') {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="morrow-test-download.txt"'
        })
        response.end('morrow browser e2e download content')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>浏览器测试首页</title></head><body>
        <h1>浏览器测试首页</h1>
        <button id="btn" onclick="document.getElementById('result').textContent='clicked'">提交</button>
        <input id="name" placeholder="姓名" />
        <button id="greet" onclick="document.getElementById('greet-result').textContent='你好 '+document.getElementById('name').value">打招呼</button>
        <div id="result">idle</div>
        <div id="greet-result">idle</div>
        <a id="next" href="/page2">第二页</a>
        <a id="dl" href="/download">下载文件</a>
      </body></html>`)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

let site: TestSite

test.beforeAll(async () => {
  site = await startTestSite()
})

test.afterAll(async () => {
  await site?.close()
})

/* ── 小工具 ──────────────────────────────────────────────────── */

interface FeatureResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

async function invoke<T = unknown>(page: Page, channel: string, payload?: unknown): Promise<FeatureResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<unknown> } } }).morrow
      return (await api.features.invoke(arg.channel, arg.payload)) as FeatureResult<T>
    },
    { channel, payload }
  )
}

async function waitForBrowserState(page: Page, predicate: (state: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> {
  return waitUntil(
    async () => {
      const result = await invoke<Record<string, unknown>>(page, 'feature:browser:get-state')
      if (result.ok && result.data && predicate(result.data)) return result.data
      return null
    },
    30_000,
    label
  )
}

async function debugInfo(page: Page): Promise<Record<string, unknown>> {
  const result = await invoke<Record<string, unknown>>(page, 'feature:browser:debug-info')
  expect(result.ok, JSON.stringify(result.error)).toBe(true)
  return result.data as Record<string, unknown>
}

/** 在主进程里直接调用浏览器自动化实现（与 bridge 使用同一套方法） */
async function automation<T>(app: ElectronApplication, method: string, args: unknown[] = []): Promise<T> {
  return app.evaluate(
    async (_electron, arg: { method: string; args: unknown[] }) => {
      const service = (globalThis as unknown as { __morrowBrowserService?: Record<string, (...params: unknown[]) => Promise<unknown>> })
        .__morrowBrowserService
      if (!service) throw new Error('__morrowBrowserService 未暴露（需要 --test-mode）')
      const fn = service[arg.method]
      if (typeof fn !== 'function') throw new Error(`未知自动化方法：${arg.method}`)
      return (await fn.call(service, ...arg.args)) as T
    },
    { method, args }
  )
}

/* ── 1. feature IPC + URL 安全 + surface ─────────────────────── */

test('feature:browser 频道：URL 安全拦截、打开本地页、导航/历史/bounds/关闭', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-surface' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')

    // 1) 危险协议全部拒绝
    for (const badUrl of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'about:blank']) {
      const result = await invoke(page, 'feature:browser:open', { url: badUrl })
      expect(result.ok, badUrl).toBe(false)
      expect(result.error?.message, badUrl).toBeTruthy()
    }

    // 2) 打开本地 HTTP 页面 + bounds 同步
    const opened = await invoke<Record<string, unknown>>(page, 'feature:browser:open', {
      url: `${site.url}/`,
      bounds: { x: 80, y: 120, width: 720, height: 420 }
    })
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const loaded = await waitForBrowserState(page, (state) => state.url === `${site.url}/` && state.title === '浏览器测试首页', 'surface 首页加载')
    expect(loaded.loading).toBe(false)

    const info = await debugInfo(page)
    expect(info.surface).toBe(true)
    expect(String(info.surfaceUrl)).toBe(`${site.url}/`)
    expect(info.surfaceBounds).toEqual({ x: 80, y: 120, width: 720, height: 420 })

    // 3) 导航 / 后退 / 前进
    const navResult = await invoke(page, 'feature:browser:navigate', { url: `${site.url}/page2` })
    expect(navResult.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '第二页', 'surface 第二页')
    const backResult = await invoke<Record<string, unknown>>(page, 'feature:browser:back')
    expect(backResult.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', 'surface 后退')
    const forwardResult = await invoke<Record<string, unknown>>(page, 'feature:browser:forward')
    expect(forwardResult.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '第二页', 'surface 前进')

    // 4) 关闭 → 状态复位，原生视图移除
    const closed = await invoke<Record<string, unknown>>(page, 'feature:browser:close')
    expect(closed.ok).toBe(true)
    expect((closed.data as Record<string, unknown>).open).toBe(false)
    const afterClose = await debugInfo(page)
    expect(afterClose.surface).toBe(false)
  } finally {
    await morrow.close()
  }
})

/* ── 2. K1 自动化原语 ───────────────────────────────────────── */

test('K1 自动化：读取 → 真实点击 → 真实输入 → 截图 → 后退/前进（隐藏窗口）', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-automation' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    const runId = 'e2e-browser-automation'

    const state = await automation<Record<string, unknown>>(morrow.app, 'automationOpen', [`${site.url}/`, { runId }])
    expect(String(state.url)).toBe(`${site.url}/`)

    const read = await automation<{ url: string; title: string; text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(read.title).toBe('浏览器测试首页')
    expect(read.text).toContain('浏览器测试首页')

    const click = await automation<{ target: string }>(morrow.app, 'automationClick', ['#btn', { runId }])
    expect(click.target).toContain('提交')
    const afterClick = await automation<{ text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(afterClick.text).toContain('clicked')

    await automation(morrow.app, 'automationType', ['#name', 'Morrow 测试', { runId }])
    await automation(morrow.app, 'automationClick', ['#greet', { runId }])
    const afterType = await automation<{ text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(afterType.text).toContain('你好 Morrow 测试')

    const shot = await automation<{ pngBase64: string; width: number; height: number }>(morrow.app, 'automationScreenshot', [{ runId }])
    expect(shot.pngBase64.length).toBeGreaterThan(1000)
    expect(Buffer.from(shot.pngBase64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(shot.width).toBeGreaterThan(100)
    expect(shot.height).toBeGreaterThan(100)

    // 历史：点击页内链接 → 第二页 → 后退 → 首页（点击后轮询真实导航结果）
    // 用独立 runId，避免历史轮询消耗主流程的步数预算
    const historyRun = 'e2e-browser-history'
    const linkClick = await automation<{ url: string; title: string; target: string; x: number; y: number; navigating: boolean }>(
      morrow.app,
      'automationClick',
      ['#next', { runId: historyRun }]
    )
    // 点击目标断言：必须命中「第二页」链接，坐标在窗口内，且确实触发了导航
    expect(linkClick.target).toContain('第二页')
    expect(linkClick.x).toBeGreaterThan(0)
    expect(linkClick.y).toBeGreaterThan(0)
    expect(linkClick.navigating).toBe(true)
    const page2 = await waitUntil(
      async () => {
        const current = await automation<{ url: string; title: string }>(morrow.app, 'automationRead', [{ runId: historyRun }])
        return current.url.endsWith('/page2') ? current : null
      },
      10_000,
      '自动化点击链接后的导航'
    )
    expect(page2.url).toBe(`${site.url}/page2`)
    await automation(morrow.app, 'automationBack', [{ runId: historyRun }])
    const back = await automation<{ url: string }>(morrow.app, 'automationRead', [{ runId: historyRun }])
    expect(back.url).toBe(`${site.url}/`)
    await automation(morrow.app, 'automationForward', [{ runId: historyRun }])
    const forward = await automation<{ url: string }>(morrow.app, 'automationRead', [{ runId: historyRun }])
    expect(forward.url).toBe(`${site.url}/page2`)

    // 步数预算：同一 runId 连续调用应被上限拦下（BROWSER_LIMITS.maxActionsPerRun=40）
    const budgetRun = 'e2e-browser-budget'
    let limited = false
    for (let index = 0; index < 45; index += 1) {
      try {
        await automation(morrow.app, 'automationRead', [{ runId: budgetRun }])
      } catch (err) {
        limited = String(err).includes('步数上限')
        break
      }
    }
    expect(limited).toBe(true)

    const info = await debugInfo(page)
    expect(info.automationOpen).toBe(true)
    expect(String(info.automationUrl)).toBe(`${site.url}/page2`)

    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { closeAutomation: () => Promise<void> } }).__morrowBrowserService
      await service.closeAutomation()
    })
  } finally {
    await morrow.close()
  }
})

/* ── 3. 下载确认 ────────────────────────────────────────────── */

test('下载确认：surface 下载暂停等确认；拒绝不落盘、允许写入 data/downloads', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-download' })
  try {
    const { page, dataDir } = morrow
    await page.waitForLoadState('domcontentloaded')

    const opened = await invoke(page, 'feature:browser:open', { url: `${site.url}/` })
    expect(opened.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', '下载测试页面加载')

    // 渲染层订阅下载事件（与真实 BrowserSurface 相同的频道）
    await page.evaluate(() => {
      const scope = window as unknown as {
        __downloadEvents?: unknown[]
        __downloadResolved?: unknown[]
        morrow: { features: { on: (channel: string, listener: (payload: unknown) => void) => () => void } }
      }
      scope.__downloadEvents = []
      scope.__downloadResolved = []
      scope.morrow.features.on('feature:browser:download', (payload) => scope.__downloadEvents!.push(payload))
      scope.morrow.features.on('feature:browser:download-resolved', (payload) => scope.__downloadResolved!.push(payload))
    })

    // 在 surface 页面里真实点击下载链接
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('dl').click()")
    })
    const download = await waitUntil(async () => {
      const events = await page.evaluate(() => ((window as unknown as { __downloadEvents?: unknown[] }).__downloadEvents ?? [])[0] as Record<string, unknown> | undefined)
      return events ?? null
    }, 20_000, '下载确认事件')

    expect(String(download.filename)).toBe('morrow-test-download.txt')
    expect(String(download.url)).toContain('/download')
    const suggestedPath = String(download.suggestedPath)
    expect(suggestedPath.startsWith(dataDir)).toBe(true)
    raceCleanup(suggestedPath)

    // 拒绝：不落盘
    const denied = await invoke(page, 'feature:browser:decide-download', { id: String(download.id), allow: false })
    expect(denied.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(existsSync(suggestedPath)).toBe(false)

    // 允许：写入 dataDir/downloads
    await page.evaluate(() => {
      ;(window as unknown as { __downloadEvents?: unknown[] }).__downloadEvents = []
    })
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('dl').click()")
    })
    const second = await waitUntil(async () => {
      const events = await page.evaluate(() => ((window as unknown as { __downloadEvents?: unknown[] }).__downloadEvents ?? [])[0] as Record<string, unknown> | undefined)
      return events ?? null
    }, 20_000, '第二次下载确认事件')
    const allowed = await invoke(page, 'feature:browser:decide-download', { id: String(second.id), allow: true })
    expect(allowed.ok).toBe(true)
    const savedPath = String(second.suggestedPath)
    await waitUntil(async () => (existsSync(savedPath) ? true : null), 15_000, '下载文件落盘')
    expect(existsSync(savedPath)).toBe(true)
    raceCleanup(savedPath)
  } finally {
    await morrow.close()
  }
})

function raceCleanup(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 忽略
  }
}

/* ── 4. K1 审批（依赖 Lead 集成 browserTools 到 registry+permissions） ── */

test.describe('K1 审批（registry + permissions 已集成）', () => {
  test('ask 与 auto 模式都逐次审批；批准后 browser_open 真实打开页面', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '我来打开网页。', toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}/` } }] },
        { text: '网页已打开。' },
        { text: '我再打开一次。', toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}/page2` } }] },
        { text: '完成。' }
      ]
    })
    const workspace = join(root, 'tmp', `r10-browser-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const morrow = await launchMorrow({ name: 'r10-browser-approval' })
    try {
      const { page } = morrow
      const ready = await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      for (const mode of ['ask', 'auto'] as const) {
        await createSession(page, { workspace, ...provider, permissionMode: mode, title: `浏览器审批 ${mode}` })
        await sendMessageViaStore(page, '帮我在 Morrow 内置浏览器打开测试网页。')
        const permission = await waitForPermission(page, 60_000)
        expect(permission.toolName, mode).toBe('browser_open')
        // 批准一次
        await page.evaluate(() => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, unknown> } }).__morrowStore
          return (store.getState().respondPermission as (decision: string) => Promise<void>)('once')
        })
        await waitForRunFinished(page, 60_000)
        const events = await getEvents(page)
        const finished = events.filter((event) => event.type === 'tool_finished' && (event as { result?: { ok?: boolean } }).result?.ok === true)
        expect(finished.length, `${mode} 模式 browser_open 应成功`).toBeGreaterThanOrEqual(1)
        // 等 store 的 run 收尾（waitForRunFinished 返回的是事件，run 状态可能再晚一个 tick 清理）
        await waitUntil(async () => ((await readStore(page)).run ? null : true), 30_000, `${mode} 模式 run 收尾`)
        const info = await debugInfo(page)
        expect(info.automationOpen, mode).toBe(true)
        expect(String(info.automationUrl), mode).toMatch(new RegExp(`${site.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(page2)?`))
        // 清理：关闭自动化窗口，等待下一轮
        await morrow.app.evaluate(async () => {
          const service = (globalThis as unknown as { __morrowBrowserService: { closeAutomation: () => Promise<void> } }).__morrowBrowserService
          await service.closeAutomation()
        })
        await clearRuns(page)
        await clearEvents(page)
      }
      expect(mock.calls).toBeGreaterThanOrEqual(4)
    } finally {
      await morrow.close()
      await mock.close()
      try {
        rmSync(workspace, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    }
  })
})

async function clearRuns(page: Page): Promise<void> {
  // 等待 store 的 run 状态自然收尾（事件已由 store 处理）；无需额外清理
  await waitUntil(async () => ((await readStore(page)).run ? null : true), 10_000, 'run 收尾')
}
