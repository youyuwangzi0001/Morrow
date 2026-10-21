/**
 * R10-C/K1 内置浏览器 E2E（真实 Electron + 真实本地 HTTP 服务）。
 *
 * 覆盖：
 * 1. feature:browser:* 频道：URL 安全（file/javascript/data 拒绝）、打开本地页、导航/后退/前进、
 *    bounds 同步、关闭；浏览器视图真实在 release 页面之外的原生 WebContentsView 中渲染。
 * 2. K1 自动化（主进程真实服务，经 --test-mode global 调用与 bridge 相同的实现）：
 *    在用户可见的同一个浏览器里打开页面 → 读取正文 → 真实点击 → 输入 → 截图 → 后退/前进。
 * 3. 下载确认：surface 内下载被暂停，渲染层收到 feature:browser:download 事件；拒绝不落盘、允许落盘。
 * 4. K1 审批（需 Lead 把 browserTools 接入 registry + permissions；R10_BROWSER_TOOLS_E2E=1 时运行）：
 *    ask 与 auto 模式都必须弹审批；批准后工具真实打开页面。
 *
 * 运行前：`npm run build`；本文件使用 tests/e2e/launch.ts 的隔离 data-dir/user-data-dir。
 */
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clearEvents,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  openToolPanel,
  readStore,
  setThemeViaStore,
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
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>第二页</title>
          <style>
            body{margin:0;min-height:100vh;background:#0b0d10;color:#ede7da;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:48px 56px}
            .eyebrow{margin:0 0 12px;color:#c8ae7d;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em}
            h1{margin:0 0 10px;font-size:30px;font-weight:500}
            p{max-width:560px;margin:0 0 24px;color:#a39d91;font-size:14px;line-height:1.7}
            a{display:inline-flex;padding:9px 14px;border:1px solid rgba(200,174,125,.35);border-radius:8px;color:#c8ae7d;text-decoration:none}
          </style></head><body><p class="eyebrow">MORROW · 浏览器自动化测试</p><h1>第二页</h1>
          <p>这是内置浏览器的测试页面，只用来验证链接跳转、前进与后退，不属于正式应用界面。</p>
          <a id="back" href="/">返回首页</a></body></html>`)
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
      if (path === '/download-pdf') {
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="morrow-test-download.pdf"'
        })
        response.end('%PDF-1.4\n% morrow e2e download\n')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>浏览器测试首页</title>
        <style>
          body{margin:0;min-height:100vh;background:#0b0d10;color:#ede7da;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:44px 56px}
          .eyebrow{margin:0 0 12px;color:#c8ae7d;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em}
          h1{margin:0 0 10px;font-size:30px;font-weight:500}
          .lead{max-width:600px;margin:0 0 26px;color:#a39d91;font-size:14px;line-height:1.7}
          .panel{max-width:600px;padding:18px;border:1px solid rgba(200,174,125,.24);border-radius:12px;background:#11151b;display:grid;gap:12px}
          .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
          button{padding:8px 13px;border:1px solid rgba(200,174,125,.35);border-radius:8px;background:#17140f;color:#ede7da;font:inherit;cursor:pointer}
          input{padding:8px 11px;border:1px solid #2b3038;border-radius:8px;background:#0b0d10;color:#ede7da;font:inherit;min-width:160px}
          .result{color:#a39d91;font:12px/1.6 ui-monospace,monospace}
          .links{margin-top:18px;display:grid;gap:8px;max-width:600px}
          a{display:block;padding:9px 12px;border:1px solid rgba(200,174,125,.2);border-radius:8px;color:#c8ae7d;text-decoration:none}
        </style></head><body>
        <p class="eyebrow">MORROW · 浏览器自动化测试</p>
        <h1>浏览器测试首页</h1>
        <p class="lead">本地测试站，仅用于验证内置浏览器的点击、输入、导航和下载；测试结束即关闭，不属于正式应用界面。</p>
        <div class="panel">
          <div class="row">
            <button id="btn" onclick="document.getElementById('result').textContent='clicked'">提交</button>
            <input id="name" placeholder="姓名" />
            <label for="email">邮箱</label>
            <input id="email" />
            <label><input id="agree" type="checkbox" /> 同意条款</label>
            <button id="greet" onclick="document.getElementById('greet-result').textContent='你好 '+document.getElementById('name').value">打招呼</button>
          </div>
          <div id="result" class="result">idle</div>
          <div id="greet-result" class="result">idle</div>
        </div>
        <div class="links">
          <a id="next" href="/page2">第二页</a>
          <a id="blank" href="/page2" target="_blank">新窗口打开第二页</a>
          <a id="dl" href="/download">下载文件</a>
          <a id="dlpdf" href="/download-pdf">下载 PDF</a>
        </div>
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

/* ── 1.5 真实站点交互 / 错误恢复 ─────────────────────────────── */

test('target=_blank 链接同视图打开；加载失败后后退能清错并恢复页面', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-recovery' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    await dismissOnboarding(page)
    const opened = await invoke(page, 'feature:browser:open', {
      url: `${site.url}/`,
      bounds: { x: 320, y: 90, width: 1200, height: 720 }
    })
    expect(opened.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', '首页加载')

    // 真实网站大量使用 target=_blank：单视图浏览器应在本视图打开，而不是「点了没反应」
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('blank').click()")
    })
    await waitForBrowserState(page, (state) => state.title === '第二页' && state.url === `${site.url}/page2`, '新窗口链接同视图打开')

    // 加载失败：应显示错误并隐藏原生视图
    const failed = await invoke(page, 'feature:browser:navigate', { url: 'http://127.0.0.1:1/' })
    expect(failed.ok).toBe(true)
    await waitForBrowserState(page, (state) => Boolean(state.error) && state.visible === false, '失败状态')

    // 后退到上一次正常页面：错误清除、视图重新可见
    const back = await invoke<Record<string, unknown>>(page, 'feature:browser:back')
    expect(back.ok, JSON.stringify(back.error)).toBe(true)
    const recovered = await waitForBrowserState(
      page,
      (state) => !state.error && state.visible === true && (state.title === '第二页' || state.title === '浏览器测试首页'),
      '失败后后退恢复'
    )
    expect(recovered.loading).toBe(false)
    // 原生 WebContentsView 不在 page.screenshot 的合成层里，直接从浏览器 webContents 取图
    const shotBase64 = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: { surface: { view: { webContents: { capturePage: () => Promise<{ toPNG: () => Buffer }> } } } }
      }).__morrowBrowserService
      const image = await service.surface.view.webContents.capturePage()
      return image.toPNG().toString('base64')
    })
    writeFileSync(screenshotPath('browser-navigation-recovery-dark.png'), Buffer.from(shotBase64, 'base64'))
  } finally {
    await morrow.close()
  }
})

/* ── 2. K1 自动化原语 ───────────────────────────────────────── */

test('K1 自动化：读取 → 真实点击 → 真实输入 → 截图 → 后退/前进（可见视图）', async () => {
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

    // 按 placeholder/可见文本定位输入框（不是 CSS selector）
    await automation(morrow.app, 'automationType', ['姓名', 'Morrow 测试', { runId }])
    await automation(morrow.app, 'automationClick', ['#greet', { runId }])
    const afterType = await automation<{ text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(afterType.text).toContain('你好 Morrow 测试')

    // 关联 label（for=email）也能定位；不支持文字输入的控件给出明确错误
    await automation(morrow.app, 'automationType', ['邮箱', 'morrow@example.test', { runId }])
    const email = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      return service.debugSurfaceScript("document.getElementById('email').value")
    })
    expect(email).toBe('morrow@example.test')
    await expect(automation(morrow.app, 'automationType', ['同意条款', 'x', { runId }])).rejects.toThrow(/不支持文字输入/)

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

/* ── 2.5 Agent 复用同一个可见 surface ───────────────────────── */

test('Agent 自动化复用同一个可见浏览器：导航与失败都反映在面板', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-unified' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const opened = await invoke(page, 'feature:browser:open', { url: `${site.url}/` })
    expect(opened.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', 'surface 首页加载')

    // Agent 打开新页面：同一个 surface 跟着导航，面板自动展开并显示“Morrow 操作中”
    await automation(morrow.app, 'automationOpen', [`${site.url}/page2`, { runId: 'e2e-unified' }])
    const afterSuccess = await waitForBrowserState(page, (state) => state.title === '第二页', 'surface 跟随 Agent 导航')
    expect(String(afterSuccess.url)).toContain('/page2')
    await expect(page.locator('.browser-surface')).toBeVisible()
    await expect(page.locator('.browser-agent-chip')).toContainText('Morrow 操作中')
    await page.screenshot({ path: screenshotPath('browser-unified-agent.png') })
    const info = await debugInfo(page)
    expect(info.surface).toBe(true)
    expect(String(info.surfaceUrl)).toContain('/page2')
    expect(info.automationActive).toBe(true)

    // 加载失败也展示在同一个面板里
    await automation(morrow.app, 'automationOpen', ['http://127.0.0.1:1/', { runId: 'e2e-unified' }]).catch(() => undefined)
    const afterFailure = await waitForBrowserState(page, (state) => Boolean(state.error), 'surface 显示加载失败')
    expect(String((afterFailure.error as { message?: string }).message)).toContain('页面加载失败')
    expect((await debugInfo(page)).surface).toBe(true)

    // Agent 关闭浏览器：面板与 surface 一起关闭
    await automation(morrow.app, 'closeAutomation').catch(() => undefined)
    expect((await debugInfo(page)).surface).toBe(false)
  } finally {
    await morrow.close()
  }
})

/* ── 2.8 窗口归属：绝不把网页嵌进灵动岛 ─────────────────────── */

test('Agent 打开浏览器时挂在主窗口，而不是聚焦的灵动岛', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-owner', env: { MORROW_ISLAND: '1' } })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    const windows = await morrow.app.evaluate(async ({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows()
      const island = all.find((win) => win.webContents.getURL().includes('#island'))
      const main = all.find((win) => !win.webContents.getURL().includes('#island') && win.getContentBounds().width >= 800)
      if (!island || !main) return { island: false, main: false, focusedTitle: '' }
      main.hide()
      island.show()
      island.moveTop()
      island.focus()
      island.webContents.focus()
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { island: true, main: true, islandFocused: island.isFocused() }
    })
    expect(windows.island, JSON.stringify(windows)).toBe(true)
    expect(windows.main).toBe(true)
    expect(windows.islandFocused).toBe(true)

    await automation(morrow.app, 'automationOpen', [`${site.url}/`, { runId: 'e2e-owner' }])
    const info = await debugInfo(page)
    expect(info.surface).toBe(true)
    expect(info.surfaceOwnerTitle).toBe('Morrow')
    const ownerSize = info.surfaceOwnerSize as { width: number; height: number }
    expect(ownerSize.width).toBeGreaterThanOrEqual(800)
    expect(ownerSize.height).toBeGreaterThanOrEqual(600)
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

test('下载同名冲突时保留原扩展名，不把 .pdf 变成 .pdf-时间戳', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-download-collision' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    await invoke(page, 'feature:browser:open', { url: `${site.url}/` })
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', '冲突测试页面加载')
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

    const downloadPdf = async (): Promise<string> => {
      await page.evaluate(() => {
        ;(window as unknown as { __downloadEvents?: unknown[]; __downloadResolved?: unknown[] }).__downloadEvents = []
        ;(window as unknown as { __downloadEvents?: unknown[]; __downloadResolved?: unknown[] }).__downloadResolved = []
      })
      await morrow.app.evaluate(async () => {
        const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
        await service.debugSurfaceScript("document.getElementById('dlpdf').click()")
      })
      const request = await waitUntil(async () => {
        const events = await page.evaluate(() => (window as unknown as { __downloadEvents?: Array<Record<string, unknown>> }).__downloadEvents ?? [])
        return events[0] ?? null
      }, 20_000, 'PDF 下载确认事件')
      const allowed = await invoke(page, 'feature:browser:decide-download', { id: String(request.id), allow: true })
      expect(allowed.ok).toBe(true)
      const resolved = await waitUntil(async () => {
        const events = await page.evaluate(() => (window as unknown as { __downloadResolved?: Array<Record<string, unknown>> }).__downloadResolved ?? [])
        return events.find((item) => item.allow === true && typeof item.path === 'string') ?? null
      }, 20_000, 'PDF 下载落盘')
      const path = String(resolved.path)
      expect(existsSync(path)).toBe(true)
      return path
    }

    const first = await downloadPdf()
    const second = await downloadPdf()
    expect(first.endsWith('.pdf')).toBe(true)
    expect(second.endsWith('.pdf')).toBe(true)
    expect(second).not.toBe(first)
    raceCleanup(first)
    raceCleanup(second)
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
        // 清理：关闭浏览器，等待下一轮
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

test('真实 UI：工作台打开浏览器后原生视图拿到 bounds 且可见（不黑屏）', async () => {
  const morrow = await launchMorrow({ name: 'r10-browser-ui-bounds', waitForSelector: '.sidebar', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('browser-empty-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('browser-empty-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)
    await page.locator('.browser-address-input').fill(`${site.url}/`)
    await page.locator('.browser-address-input').press('Enter')
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', 'UI 浏览器首页')

    const info = await debugInfo(page)
    expect(info.surface, JSON.stringify(info)).toBe(true)
    expect(info.surfaceVisible, JSON.stringify(info)).toBe(true)
    const bounds = info.surfaceBounds as { width: number; height: number } | null
    expect(bounds?.width ?? 0).toBeGreaterThan(0)
    expect(bounds?.height ?? 0).toBeGreaterThan(0)
    const size = info.surfaceWebContentsSize as { width: number; height: number } | null
    expect(size?.width ?? 0).toBeGreaterThan(0)
    expect(size?.height ?? 0).toBeGreaterThan(0)

    // 下载确认 → 允许 → 成功提示可打开下载文件夹
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('dl').click()")
    })
    const downloadDialog = page.getByRole('dialog', { name: '下载确认' })
    await expect(downloadDialog).toBeVisible({ timeout: 20_000 })
    const viewportBox = await page.locator('.browser-viewport').boundingBox()
    expect(viewportBox).not.toBeNull()
    await waitUntil(
      async () => {
        const details = await debugInfo(page)
        const bounds = details.surfaceBounds as { height: number } | null
        return bounds && viewportBox && bounds.height <= viewportBox.height - 140 ? true : null
      },
      5_000,
      '下载确认浮层让出原生视图空间'
    )
    await downloadDialog.getByRole('button', { name: '允许下载' }).click()
    const successToast = page.locator('.browser-toast.is-success')
    await expect(successToast).toBeVisible({ timeout: 20_000 })
    await expect(successToast).toContainText('morrow-test-download.txt')
    await expect(successToast.getByRole('button', { name: '打开文件夹' })).toBeVisible()
    await waitUntil(
      async () => {
        const details = await debugInfo(page)
        const bounds = details.surfaceBounds as { height: number } | null
        return bounds && viewportBox && bounds.height <= viewportBox.height - 56 ? true : null
      },
      5_000,
      '下载成功提示让出原生视图空间'
    )
    await page.screenshot({ path: screenshotPath('browser-download-saved.png') })

    // 定位只允许 downloads 内的真实文件（不弹出资源管理器，只验证拒绝路径）
    const outside = join(root, 'tmp', `browser-reveal-outside-${Date.now()}.txt`)
    writeFileSync(outside, 'x', 'utf8')
    const outsideReveal = await invoke(page, 'feature:browser:reveal-download', { path: outside })
    expect(outsideReveal.ok).toBe(false)
    expect(outsideReveal.error?.message).toContain('下载目录')
    const missingReveal = await invoke(page, 'feature:browser:reveal-download', {
      path: join(morrow.dataDir, 'downloads', 'missing-download.txt')
    })
    expect(missingReveal.ok).toBe(false)
    expect(missingReveal.error?.message).toContain('移动或删除')
    rmSync(outside, { force: true })
    rmSync(join(morrow.dataDir, 'downloads'), { recursive: true, force: true })
  } finally {
    await morrow.close()
  }
})
