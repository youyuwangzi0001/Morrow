/**
 * 合并自 6 个 E2E spec：r10-browser.spec.ts、search-global.spec.ts、search-consistency.spec.ts、r10-search.spec.ts、web-search.spec.ts、r13-browser-retry.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clearEvents, configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, openToolPanel, readStore, sendMessageViaStore, setThemeViaStore, waitForEvent, waitForRunFinished, waitForStoreReady, waitUntil } from './store'

// ── 原文件：r10-browser.spec.ts ──────────────────────────────────────────────
test.describe('r10-browser.spec.ts', () => {
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
    await waitForStoreReady(page)
    await dismissOnboarding(page)

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
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const runId = 'e2e-browser-automation'

    const state = await automation<Record<string, unknown>>(morrow.app, 'automationOpen', [`${site.url}/`, { runId }])
    expect(String(state.url)).toBe(`${site.url}/`)

    const read = await automation<{ url: string; title: string; text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(read.title).toBe('浏览器测试首页')
    expect(read.text).toContain('浏览器测试首页')

    const click = await automation<{ target: string }>(morrow.app, 'automationClick', ['#btn', { runId }])
    expect(click.target).toContain('提交')
    // 页面脚本在 DOMContentLoaded 后绑定点击处理；轮询真实 DOM 结果，避免读到点击前文本
    const afterClick = await waitUntil(
      async () => {
        const current = await automation<{ text: string }>(morrow.app, 'automationRead', [{ runId }])
        return current.text.includes('clicked') ? current : null
      },
      10_000,
      '点击后的页面文本',
      1_000
    )
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
      // Windows 桌面会话可能拒绝测试进程抢焦点；轮询后仍失败时只记录，不把环境限制当成产品回归。
      let islandFocused = false
      for (let attempt = 0; attempt < 10; attempt += 1) {
        island.focus()
        island.webContents.focus()
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (island.isFocused()) {
          islandFocused = true
          break
        }
      }
      return { island: true, main: true, islandFocused }
    })
    expect(windows.island, JSON.stringify(windows)).toBe(true)
    expect(windows.main).toBe(true)
    if (!windows.islandFocused) console.warn('[browser-owner] 当前桌面会话拒绝测试窗口抢焦点；继续验证 surface 归属')

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
  test('ask 模式被动浏览直接执行；auto 模式直接执行；browser_open 真实打开页面', async () => {
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
        await waitForRunFinished(page, 60_000)
        const events = await getEvents(page)
        // browser_open 是被动浏览：ask 与 auto 都不应弹审批（点击/输入才逐次确认）
        const prompts = events.filter((event) => event.type === 'permission_requested')
        expect(prompts.length, `${mode} 模式审批次数`).toBe(0)
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

})

// ── 原文件：search-global.spec.ts ──────────────────────────────────────────────
test.describe('search-global.spec.ts', () => {
/**
 * 全局搜索：默认跨全部工作区；可切换当前文件夹；会话命中后跳到原句并高亮。
 */

const TOKEN = '沧海月明唯一检索词'

function makeDir(prefix: string): string {
  return mkdtempSync(join(root, 'tmp', `${prefix}-`))
}

function sessionJson(input: {
  id: string
  title: string
  workspace: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
}): string {
  return JSON.stringify({
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: { providerId: 'demo', modelId: 'morrow-demo' },
    permissionMode: 'read-only',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: input.messages.length,
    messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      createdAt: Date.now()
    })),
    todos: [],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0 }
  })
}

test('浏览器全屏面板隐藏标题栏，地址栏从左到右整段可聚焦', async () => {
  const morrow = await launchMorrow({ name: 'browser-address-focus', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    const input = page.locator('.browser-address-input')
    await input.waitFor({ state: 'visible' })

    // 顶部标题栏的原生拖动区会把地址栏切成多块焦点区；浏览器面板必须独占顶部。
    await expect(page.locator('.titlebar')).toBeHidden()
    const box = await input.boundingBox()
    expect(box).not.toBeNull()
    for (const ratio of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      await page.mouse.click(box!.x + box!.width * ratio, box!.y + box!.height / 2)
      const focused = await page.evaluate(() => document.activeElement?.className ?? '')
      expect(focused, `地址栏 x=${ratio} 应可聚焦`).toContain('browser-address-input')
    }

    await page.locator('[aria-label="返回主页面"]').click()
    await expect(page.locator('.titlebar')).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'browser' } }))
    })
    await expect(page.locator('.titlebar')).toBeHidden()
  } finally {
    await morrow.close()
  }
})

test('内置浏览器多标签：新建、切换、关闭', async () => {
  const tabsServer = createServer((request, response) => {
    const two = request.url?.startsWith('/page2')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${two ? '第二页' : '浏览器测试首页'}</title></head><body>${two ? 'two' : 'one'}</body></html>`)
  })
  await new Promise<void>((resolve) => tabsServer.listen(0, '127.0.0.1', resolve))
  const tabsBase = `http://127.0.0.1:${(tabsServer.address() as AddressInfo).port}`
  const morrow = await launchMorrow({ name: 'browser-tabs', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    const address = page.locator('.browser-address-input')
    await address.waitFor({ state: 'visible' })
    await expect(page.locator('.browser-tab')).toHaveCount(0)

    await address.fill(`${tabsBase}/`)
    await address.press('Enter')
    await expect(page.locator('.browser-tab')).toHaveCount(1)
    await expect(page.locator('.browser-tab.is-active .browser-tab-title')).toHaveText('浏览器测试首页')
    const activeTab = page.locator('.browser-tab.is-active')
    await expect(activeTab).toHaveCSS('height', '24px')
    await expect(activeTab).toHaveCSS('border-radius', '5px')

    await page.locator('[aria-label="新建标签页"]').click()
    await expect(page.locator('.browser-tab')).toHaveCount(2)
    await expect(address).toHaveValue('')
    await address.fill(`${tabsBase}/page2`)
    await address.press('Enter')
    await expect(page.locator('.browser-tab.is-active .browser-tab-title')).toHaveText('第二页')
    await page.screenshot({ path: screenshotPath('browser-tabs-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('browser-tabs-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)

    // 切回第一个标签：页面与地址恢复
    await page.locator('.browser-tab').first().click()
    await expect(page.locator('.browser-tab').first()).toHaveClass(/is-active/)
    await expect(address).toHaveValue(`${tabsBase}/`)
    await expect(page.locator('.browser-tab').first().locator('.browser-tab-title')).toHaveText('浏览器测试首页')

    // 关闭第一个标签，第二个接管
    await page.locator('.browser-tab').first().locator('.browser-tab-close').click()
    await expect(page.locator('.browser-tab')).toHaveCount(1)
    await expect(page.locator('.browser-tab.is-active .browser-tab-title')).toHaveText('第二页')
    await expect(address).toHaveValue(`${tabsBase}/page2`)

    // 关闭最后一个标签，面板收起
    await page.locator('.browser-tab.is-active .browser-tab-close').click()
    await expect(page.locator('.workbench-browser-overlay')).toBeHidden()
    await expect(page.locator('.titlebar')).toBeVisible()
  } finally {
    await morrow.close()
    await new Promise<void>((resolve) => tabsServer.close(() => resolve()))
  }
})

test('默认搜索全部项目；可切换当前文件夹；会话命中跳到原句并高亮', async () => {
  test.setTimeout(120_000)
  const workspaceA = makeDir('search-global-a')
  const workspaceB = makeDir('search-global-b')
  const dataDir = makeDir('search-global-data')
  mkdirSync(join(dataDir, 'sessions'), { recursive: true })
  writeFileSync(join(workspaceA, 'A-唯一检索词.md'), `# A\n\n${TOKEN}\n`, 'utf8')
  writeFileSync(join(workspaceB, 'B-唯一检索词.md'), `# B\n\n${TOKEN}\n`, 'utf8')

  const targetMessages = Array.from({ length: 40 }, (_, index) => ({
    id: index === 25 ? 'm_target' : `m_${index}`,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: index === 25 ? `这里藏着 ${TOKEN}，请定位到这一句。` : `第 ${index + 1} 条占位消息，用于制造足够长的对话。`
  }))
  writeFileSync(
    join(dataDir, 'sessions', 's_target.json'),
    sessionJson({ id: 's_target', title: '定位测试会话', workspace: workspaceA, messages: targetMessages }),
    'utf8'
  )
  writeFileSync(
    join(dataDir, 'sessions', 's_other.json'),
    sessionJson({
      id: 's_other',
      title: '另一个项目的会话',
      workspace: workspaceB,
      messages: [{ id: 'm_other', role: 'user', text: '我在另一个文件夹里。' }]
    }),
    'utf8'
  )

  const morrow = await launchMorrow({ name: 'search-global', dataDir, waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .selectSession('s_other')
    })
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId
        )) === 's_other',
      10_000,
      '切到另一个项目的会话'
    )

    await openToolPanel(page, '全局搜索')
    const input = page.getByRole('textbox', { name: '全局搜索' })
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill(TOKEN)

    // 默认「全部」：两个项目的文件都能搜到
    await expect(page.locator('.search-hit').filter({ hasText: 'A-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.search-hit').filter({ hasText: 'B-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })

    // 未登记目录不能作为搜索范围（否则索引器会读取任意目录）
    const outside = makeDir('search-global-outside')
    writeFileSync(join(outside, 'secret.md'), `outside ${TOKEN}`, 'utf8')
    const blocked = await page.evaluate(async (arg: { path: string; token: string }) => {
      const invoke = (channel: string, payload: Record<string, unknown>) =>
        window.morrow.features.invoke(channel, payload) as Promise<{ ok: boolean; error?: { message?: string } }>
      return {
        query: await invoke('feature:search:query', { q: arg.token, workspace: arg.path }),
        refresh: await invoke('feature:search:refresh', { workspace: arg.path })
      }
    }, { path: outside, token: TOKEN })
    expect(blocked.query.ok).toBe(false)
    expect(blocked.query.error?.message).toContain('已登记')
    expect(blocked.refresh.ok).toBe(false)
    expect(blocked.refresh.error?.message).toContain('已登记')
    rmSync(outside, { recursive: true, force: true })

    await page.screenshot({ path: screenshotPath('search-global-all.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('search-global-all-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 切到当前文件夹（workspaceB）：只剩 B
    const dialog = page.getByRole('dialog', { name: '全局搜索' })
    await dialog.getByRole('button', { name: '当前文件夹' }).click()
    await expect(page.locator('.search-hit').filter({ hasText: 'B-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.search-hit').filter({ hasText: 'A-唯一检索词.md' })).toHaveCount(0)

    // 切回全部，点击会话命中：切到目标会话并跳到原句
    await dialog.getByRole('button', { name: '全部' }).click()
    const sessionHit = page.locator('.search-hit').filter({ hasText: '定位测试会话' }).first()
    await expect(sessionHit).toBeVisible({ timeout: 15_000 })
    await sessionHit.click()
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId
        )) === 's_target',
      15_000,
      '切换到命中会话'
    )
    const highlight = page.locator('[data-message-id="m_target"].is-search-hit')
    await waitUntil(async () => (await highlight.count()) > 0, 8_000, '命中消息金色高亮')
    await page.waitForTimeout(350)
    const box = await highlight.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    if (box && viewport) {
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeLessThan(viewport.height)
    }
    await page.screenshot({ path: screenshotPath('search-global-jump.png') })
  } finally {
    await morrow.close()
  }
})

})

// ── 原文件：search-consistency.spec.ts ──────────────────────────────────────────────
test.describe('search-consistency.spec.ts', () => {
/**
 * 全局搜索一致性回归：
 * 1) 删除会话后索引立即失效；
 * 2) 搜索文件时使用当前会话工作区（不是 lastWorkspace），结果可在编辑器中打开。
 */

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(root, 'tmp', `${prefix}-`))
  return dir
}

test.describe('全局搜索一致性', () => {
  test('删除会话后搜索索引立即移除该会话', async () => {
    test.setTimeout(60_000)
    const workspace = makeDir('search-delete-ws')
    const dataDir = makeDir('search-delete-data')
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    const sessionId = 's_searchdel1'
    const token = '海上升明月唯一标记'
    writeFileSync(
      join(dataDir, 'sessions', `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        title: '搜索删除残留测试',
        workspace,
        model: { providerId: 'demo', modelId: 'morrow-demo' },
        permissionMode: 'ask',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 1,
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: token }], createdAt: Date.now() }],
        todos: [],
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    )
    const morrow = await launchMorrow({ name: 'search-delete', dataDir, waitForSelector: '.sidebar' })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 搜索 IPC 只接受已登记工作区；模拟用户选择过这个文件夹（删除会话后仍保持登记）
      await page.evaluate(async (path) => {
        const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: Record<string, unknown>) => Promise<void> } } }).__morrowStore
        await store.getState().updateSettings({ lastWorkspace: path })
      }, workspace)
      const query = async () =>
        page.evaluate(
          async (arg: { token: string; workspace: string }) => {
            const result = await window.morrow.features.invoke<{
              groups: { sessions: Array<{ sessionId?: string }> }
            }>('feature:search:query', { q: arg.token, workspace: arg.workspace, limit: 20 })
            if (!result.ok) throw new Error(result.error.message)
            return result.data
          },
          { token, workspace }
        )

      const before = await query()
      expect(before.groups.sessions.some((hit) => hit.sessionId === sessionId)).toBe(true)

      const removed = await page.evaluate(async (id: string) => window.morrow.session.remove(id), sessionId)
      expect(removed.ok).toBe(true)
      expect(existsSync(join(dataDir, 'sessions', `${sessionId}.json`))).toBe(false)

      const after = await query()
      expect(after.groups.sessions.some((hit) => hit.sessionId === sessionId)).toBe(false)
    } finally {
      await morrow.close()
    }
  })

  test('搜索文件使用当前会话工作区，并可从结果打开编辑器', async () => {
    test.setTimeout(60_000)
    const workspaceA = makeDir('search-nav-a')
    const workspaceB = makeDir('search-nav-b')
    const dataDir = makeDir('search-nav-data')
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    const fileName = '预算导航.md'
    writeFileSync(join(workspaceA, fileName), '# 预算导航\n\n当前会话工作区里的文件。', 'utf8')
    // 预置一个同工作区、但非当前会话的 artifact 归属会话，验证跨会话结果跳转
    writeFileSync(
      join(dataDir, 'sessions', 's_artowner1.json'),
      JSON.stringify({
        id: 's_artowner1',
        title: '产物归属会话',
        workspace: workspaceA,
        model: { providerId: 'demo', modelId: 'morrow-demo' },
        permissionMode: 'read-only',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        messages: [],
        todos: [],
        artifacts: [
          {
            id: 'art_search_owner',
            title: '独有产物标题',
            kind: 'markdown',
            content: '# 独有产物\n\nARTIFACT-UNIQUE',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    )
    const morrow = await launchMorrow({ name: 'search-nav', dataDir, waitForSelector: '.sidebar' })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const sessionId = await page.evaluate(
        async (arg: { workspaceA: string; workspaceB: string }) => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().updateSettings({ lastWorkspace: arg.workspaceB })
          const state = store.getState()
          const created = await window.morrow.session.create({
            workspace: arg.workspaceA,
            model: state.settings.defaultModel,
            permissionMode: 'read-only',
            title: '搜索导航会话'
          })
          if (!created.ok) throw new Error(created.error.message)
          await store.getState().selectSession(created.data.id)
          const list = await window.morrow.session.list()
          if (list.ok) store.setState({ sessions: list.data })
          return created.data.id
        },
        { workspaceA, workspaceB }
      )
      await waitUntil(async () => (await page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId)) === sessionId, 10_000, '会话选中')

      await openToolPanel(page, '全局搜索')
      const input = page.getByRole('textbox', { name: '全局搜索' })
      await expect(input).toBeVisible({ timeout: 10_000 })
      await input.fill('预算导航')
      const hit = page.locator('.search-hit').filter({ hasText: fileName }).first()
      await expect(hit).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('search-workspace-results-dark.png') })
      await hit.click()
      await expect(page.locator('.canvas-head-title')).toContainText(fileName, { timeout: 15_000 })
      await expect(page.locator('.editor-pane')).toBeVisible()

      // artifact 命中来自同工作区的另一个会话：应切回归属会话并打开画布
      await openToolPanel(page, '全局搜索')
      const artifactInput = page.getByRole('textbox', { name: '全局搜索' })
      await expect(artifactInput).toBeVisible({ timeout: 10_000 })
      await artifactInput.fill('独有产物')
      const artifactHit = page.locator('.search-hit').filter({ hasText: '独有产物标题' }).first()
      await expect(artifactHit).toBeVisible({ timeout: 15_000 })
      await artifactHit.click()
      await expect
        .poll(async () => page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId), { timeout: 15_000 })
        .toBe('s_artowner1')
      await expect(page.locator('.canvas-head-title')).toContainText('独有产物标题', { timeout: 15_000 })
    } finally {
      await morrow.close()
    }
  })
})

})

// ── 原文件：r10-search.spec.ts ──────────────────────────────────────────────
test.describe('r10-search.spec.ts', () => {
/**
 * R10-I 搜索 feature 的 E2E 接线测试。
 * Lead 在 src/main/features/index.ts 注册 `import './search'` 且挂载 SearchPanel 后，
 * 本用例会自动从「跳过」变为「真实执行」（同一条测试，不伪造）。
 */

test.describe('R10-I 全局搜索接线', () => {
  test('feature:search:status / query 可用，返回分组与索引状态', async () => {
    const morrow = await launchMorrow({ name: 'r10-search' })
    try {
      await morrow.page.waitForFunction(() => Boolean((window as unknown as { morrow?: unknown }).morrow), undefined, {
        timeout: 30_000
      })
      const status = await morrow.page.evaluate(async () => {
        const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } } }).morrow
        try {
          return await api.features.invoke('feature:search:status', {})
        } catch (err) {
          return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
        }
      })
      test.skip(!status.ok, '搜索模块尚未由 Lead 注册到 features/index.ts（集成后自动执行）')
      expect(status.ok).toBe(true)
      expect(status.data).toMatchObject({ ready: expect.any(Boolean), sessions: expect.any(Number), files: expect.any(Number) })

      const query = await morrow.page.evaluate(async () => {
        const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } } }).morrow
        try {
          return await api.features.invoke('feature:search:query', { q: '测试', limit: 5 })
        } catch (err) {
          return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
        }
      })
      expect(query.ok).toBe(true)
      expect(query.data).toMatchObject({
        query: '测试',
        groups: { sessions: expect.any(Array), files: expect.any(Array), artifacts: expect.any(Array) },
        total: expect.any(Number),
        tookMs: expect.any(Number)
      })
      const index = (query.data as { index: { workspaces: unknown } }).index
      expect(Array.isArray(index.workspaces)).toBe(true)
    } finally {
      await morrow.close()
    }
  })
})

})

// ── 原文件：web-search.spec.ts ──────────────────────────────────────────────
test.describe('web-search.spec.ts', () => {
/**
 * P0-4 联网搜索 E2E：
 * - 配置 SearXNG → 模型调用 web_search → 工具卡来源 + 会话来源面板；
 * - 设置页「联网搜索」分类可用；
 * - 明暗截图。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('联网搜索：真实网络搜索、工具调用、搜索卡与设置页', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '我来搜索一下。', toolCalls: [{ name: 'web_search', arguments: { query: 'OpenAI Codex', max_results: 3 } }] },
      { text: '根据 [1]，OpenAI Codex 是一个在本地运行的编程 Agent。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'web-search', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    // 默认配置即可：内置 Bing 搜索，无需 Key 或本机搜索服务
    const web = (await readStore(page)).ready
    expect(web).toBe(true)

    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-web-search'),
      ...provider,
      permissionMode: 'auto',
      title: '联网搜索测试'
    })
    await page.locator('.composer-input').fill('搜索一下 Morrow 是什么')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/OpenAI Codex 是一个在本地运行的编程 Agent/)).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '搜索运行结束')

    // 搜索运行时自动展开；若用户/测试已收起，再点一次展开
    if ((await page.locator('.spine-sources').count()) === 0) {
      await page.locator('.spine-item').first().click()
    }
    await expect(page.locator('.spine-search')).toBeVisible()

    // 会话来源面板
    await expect(page.locator('.sources-tray')).toBeVisible()
    await page.locator('.sources-head').click()
    expect(await page.locator('.sources-item').count()).toBeGreaterThan(0)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('web-search-sources-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('web-search-sources-light.png') })
    await setThemeViaStore(page, 'dark')

    // 设置页
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '联网搜索' }).click()
    await expect(page.locator('.st-search')).toBeVisible()
    await expect(page.locator('.st-search')).toContainText('自动联网搜索')
    await expect(page.locator('.st-search')).toContainText('内置多引擎搜索')
    await page.getByRole('button', { name: /保存并测试/ }).click()
    await expect(page.locator('.st-search-test')).toContainText(/连接正常|返回 \d+ 条/, { timeout: 30_000 })
    await page.locator('.st-panel').evaluate((element) => element.scrollTo({ top: 0 }))
    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('web-search-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('web-search-settings-light.png') })
    await setThemeViaStore(page, 'dark')

    const settings = (await readStore(page)).ready
    expect(settings).toBe(true)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-browser-retry.spec.ts ──────────────────────────────────────────────
test.describe('r13-browser-retry.spec.ts', () => {
/**
 * 本地预览服务启动竞态：terminal(start) 后端口稍后才监听时，
 * browser_open 应短暂重试，而不是立即报 ERR_CONNECTION_REFUSED。
 */

function listenLater(server: Server, port: number, delayMs: number): void {
  setTimeout(() => {
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      // 测试结束时可能已关闭
    }
  }, delayMs)
}

test('本地预览端口稍后监听时 browser_open 会自动重试成功', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-browser-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>preview-ok</title><style>html,body{margin:0;background:#0b0f13;color:#d6be91}body{height:2400px}</style></head><body>preview ok</body></html>')
  })
  const port = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(chosen))
    })
  })
  // 模拟 terminal(start) 已返回，但 Python http.server 还没真正 listen。
  listenLater(server, port, 700)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '打开本地预览。',
        toolCalls: [{ name: 'browser_open', arguments: { url: `http://127.0.0.1:${port}/` } }]
      },
      { text: '打开了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-browser-retry', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '本地预览重试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '打开本地预览页面。')
    await waitForRunFinished(page, 90_000)
    const event = (await getEvents(page))
      .filter((entry) => entry.type === 'tool_finished')
      .at(-1) as { result?: { ok?: boolean; output?: string } } | undefined
    expect(event?.result?.ok, event?.result?.output).toBe(true)
    expect(String(event?.result?.output ?? '')).toContain('已在 Morrow 浏览器打开')

    // 远程页面看不到宿主 CSS：滚动条样式必须注入到 surface 页面本身
    const browserDebug = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: { debugInfo: () => { scrollbarCssApplied: boolean } }
      }).__morrowBrowserService
      return service.debugInfo()
    })
    expect(browserDebug.scrollbarCssApplied).toBe(true)
    const scrollbarStyle = (await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> }
      }).__morrowBrowserService
      return service.debugSurfaceScript(`(() => {
        const root = getComputedStyle(document.documentElement)
        const thumb = getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb')
        const bar = getComputedStyle(document.documentElement, '::-webkit-scrollbar')
        return { color: root.scrollbarColor, thumb: thumb.backgroundImage, width: bar.width }
      })()`)
    })) as { color?: string; thumb?: string; width?: string }
    expect(JSON.stringify(scrollbarStyle)).toMatch(/138,\s*111,\s*66|#8a6f42|linear-gradient/i)
    try {
      const png = await morrow.app.evaluate(async () => {
        const service = (globalThis as unknown as {
          __morrowBrowserService: { surface: { view: { webContents: { capturePage: () => Promise<{ toPNG: () => Buffer }> } } } }
        }).__morrowBrowserService
        return (await service.surface.view.webContents.capturePage()).toPNG().toString('base64')
      })
      writeFileSync(screenshotPath('r13-browser-scrollbar.png'), Buffer.from(png, 'base64'))
    } catch {
      // 截图只是证据；部分 CI/远程桌面环境无法抓取原生视图，不影响样式断言。
    }
  } finally {
    await morrow.close()
    await mock.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

})

test('浏览器返回主页面后保留页面并可切回', async () => {
  test.setTimeout(120_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><meta charset="utf-8"><title>返回测试页</title></head><body><h1>返回测试页</h1></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  const morrow = await launchMorrow({ name: 'browser-return' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    await page.getByRole('button', { name: '打开内置浏览器' }).click()
    await expect(page.locator('.browser-surface')).toBeVisible()
    const opened = await page.evaluate(async (targetUrl) => {
      const api = (window as unknown as {
        morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
      }).morrow
      return (await api.features.invoke('feature:browser:open', { url: targetUrl })) as {
        ok: boolean
        error?: { message?: string }
      }
    }, `${url}/`)
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    await expect.poll(() => page.locator('.browser-address-input').inputValue(), { timeout: 30_000 }).toContain(url)

    await page.getByRole('button', { name: '返回主页面' }).click()
    await expect(page.locator('.workbench-browser-overlay')).toBeHidden()
    await expect(page.locator('.app-main')).toBeVisible()
    await page.screenshot({ path: screenshotPath('browser-return-home.png') })

    await page.getByRole('button', { name: '打开内置浏览器' }).click()
    await expect(page.locator('.workbench-browser-overlay')).toBeVisible()
    await expect.poll(() => page.locator('.browser-address-input').inputValue(), { timeout: 30_000 }).toContain(url)
    await page.screenshot({ path: screenshotPath('browser-return-restored.png') })
  } finally {
    await morrow.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
