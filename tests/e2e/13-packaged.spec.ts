/**
 * 合并自 5 个 E2E spec：packaged-terminal.spec.ts、packaged-ui-fixes.spec.ts、r8-packaged-tools.spec.ts、r8-packaged-browser.spec.ts、portable-copies.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { getPackagedAppExe } from './packaged-runtime'
import { configureMockProvider, dismissOnboarding, installEventCollector, openToolPanel, readStore, setThemeViaStore, waitForRunFinished, waitForStoreReady } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

// ── 原文件：packaged-terminal.spec.ts ──────────────────────────────────────────────
test.describe('packaged-terminal.spec.ts', () => {
/**
 * 打包版终端回归：asar 内的 node-pty 原生模块必须可加载，并能真实执行命令。
 */

test('打包版：终端能创建真实 PTY 并执行命令', async () => {
  test.setTimeout(180_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  // 旧便携包没有 node-pty；打包更新后再跑，避免全量 E2E 被历史产物误伤
  const hasPty = existsSync(
    join(dirname(appExe), 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  )
  test.skip(!hasPty, '需要先构建包含真实终端的便携包（npm run dist）')
  const workspace = join(root, 'tmp', `packaged-terminal-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({
    name: 'packaged-terminal',
    executablePath: appExe,
    timeoutMs: 120_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const profiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      return result.ok
        ? {
            ids: (result.data as { profiles: Array<{ id: string }> }).profiles.map((item) => item.id),
            defaultShell: (result.data as { defaultShell: string }).defaultShell
          }
        : { ids: [] as string[], defaultShell: '' }
    })
    if (profiles.ids.includes('gitbash')) expect(profiles.defaultShell).toBe('gitbash')
    expect(profiles.ids).not.toContain('powershell')
    expect(profiles.ids).not.toContain('cmd')
    // 当前测试宿主是受限令牌，Git Bash 的 MSYS 共享内存无法初始化；PTY 回归显式用 PowerShell 7。
    await page.evaluate(async () => {
      await window.morrow.settings.update({ terminalShell: 'pwsh' })
    })
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const state = store.getState()
      const created = await window.morrow.session.create({
        workspace: ws,
        model: state.settings.defaultModel,
        permissionMode: 'auto',
        title: '打包终端测试'
      })
      if (!created.ok) throw new Error(created.error.message)
      await store.getState().selectSession(created.data.id)
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'terminal' } }))
    }, workspace)

    await expect(page.locator('.terminal-dock')).toBeVisible()
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 })
    const shellId = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:list')
      if (!result.ok) return ''
      const list = (result.data as { processes: Array<{ id: string; kind: string }> }).processes
      return list.find((process) => process.kind === 'shell')?.id ?? ''
    })
    expect(shellId).toBeTruthy()
    await page.evaluate(async (id) => {
      await window.morrow.features.invoke('feature:terminal:input', {
        id,
        data: "Write-Output ('packaged_' + 'pty_ok')\r"
      })
    }, shellId)
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const result = await window.morrow.features.invoke('feature:terminal:read', { id, tail: 20_000 })
            return result.ok ? (result.data as { output: string }).output : ''
          }, shellId),
        { timeout: 30_000 }
      )
      .toContain('packaged_pty_ok')

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('packaged-terminal-dark.png') })
  } finally {
    await morrow.close()
  }
})

})

// ── 原文件：packaged-ui-fixes.spec.ts ──────────────────────────────────────────────
test.describe('packaged-ui-fixes.spec.ts', () => {
/**
 * 打包版 UI 复核：项目范围切换与「关于 → 数据目录」入口必须随 app.asar 一起交付。
 */

test('打包版包含项目范围切换与自定义数据目录入口', async () => {
  test.setTimeout(90_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  let morrow: MorrowApp | null = null
  try {
    morrow = await launchMorrow({ name: 'packaged-ui-fixes', executablePath: appExe, timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    const scope = page.getByRole('radiogroup', { name: '项目范围' })
    await expect(scope).toBeVisible()
    await expect(scope.getByRole('radio', { name: '全部项目' })).toBeVisible()
    await expect(scope.getByRole('radio', { name: '当前文件夹' })).toBeVisible()
    await expect(page.locator('.pp-cta')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.pp-root')).toHaveCount(0)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    await expect(settings.getByRole('button', { name: '更改目录' })).toBeVisible()
    await expect(settings.getByRole('button', { name: '打开数据目录' })).toBeVisible()
    await expect(settings.locator('.st-about-path code')).not.toHaveText('—')
  } finally {
    await morrow?.close()
  }
})

})

// ── 原文件：r8-packaged-tools.spec.ts ──────────────────────────────────────────────
test.describe('r8-packaged-tools.spec.ts', () => {
/** 打包版 asar 冒烟：确认 pdf-parse/jszip 在资源包内可用，read_pdf/read_docx 真实执行。 */

test('打包版文档工具（asar 内 pdf-parse / jszip）', async () => {
  test.setTimeout(180_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  const mock = await startMockLLM({
    scripts: [
      {
        text: '',
        toolCalls: [
          { name: 'read_pdf', arguments: { path: 'in/invoice.pdf' } },
          { name: 'read_docx', arguments: { path: 'in/template.docx' } }
        ]
      },
      { text: '两个文档都已读取。' }
    ]
  })
  const workspace = join(root, 'tmp', `r8-pkg-tools-${Date.now()}`)
  mkdirSync(join(workspace, 'in'), { recursive: true })
  copyFileSync(join(root, 'tests', 'unit', 'core', 'fixtures', 'documents', 'invoice.pdf'), join(workspace, 'in', 'invoice.pdf'))
  copyFileSync(join(root, 'tests', 'unit', 'core', 'fixtures', 'documents', 'template.docx'), join(workspace, 'in', 'template.docx'))
  const morrow = await launchMorrow({ name: 'r8-pkg-tools', executablePath: appExe, waitForSelector: '.sidebar', extraArgs: ['--data-dir=' + join(workspace, 'data')] })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (arg: { ws: string; providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await window.morrow.session.create({
        workspace: arg.ws,
        model: { providerId: arg.providerId, modelId: arg.modelId },
        permissionMode: 'auto',
        title: '打包文档冒烟'
      })
      if (!created.ok) throw new Error('session.create 失败')
      await store.getState().selectSession(created.data.id)
      await store.getState().sendMessage('请分别用 read_pdf 与 read_docx 读取 in/invoice.pdf 和 in/template.docx，然后总结。')
    }, { ws: workspace, providerId: provider.providerId, modelId: provider.modelId })
    await waitForRunFinished(page, 90_000)
    const events = await page.evaluate(() => (window as unknown as { __morrowEvents?: Array<any> }).__morrowEvents ?? [])
    const state = await readStore(page)
    expect(state.run).toBeNull()
    const toolEvents = events.filter((e) => e.type === 'tool_finished')
    console.log('TOOLS', JSON.stringify(toolEvents.map((e) => ({ name: e.result?.name, ok: e.result?.ok }))))
    // 如果没有安装事件收集器，fallback 从会话工具块读
    const session = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { session: Record<string, any> } }
    }).__morrowStore.getState().session)
    const blocks = (session.messages as Array<{ content: Array<Record<string, any>> }>)
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_use')
    const pdf = blocks.find((b) => b.name === 'read_pdf')
    const docx = blocks.find((b) => b.name === 'read_docx')
    console.log('STATUS', pdf?.status, docx?.status, JSON.stringify(pdf?.result ?? '').slice(0, 300))
    expect(pdf?.status).toBe('success')
    expect(docx?.status).toBe('success')
    const pdfText = JSON.stringify(pdf?.result ?? '')
    const docxText = JSON.stringify(docx?.result ?? '')
    expect(pdfText).toContain('INV-0042')
    expect(docxText).toContain('Pilot Letter')
    console.log('PDF_OK', pdfText.slice(0, 160))
    console.log('DOCX_OK', docxText.slice(0, 160))
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r8-packaged-browser.spec.ts ──────────────────────────────────────────────
test.describe('r8-packaged-browser.spec.ts', () => {
/**
 * 打包版内置浏览器回归：从工作台真实打开 → 原生 WebContentsView 必须拿到 bounds 并可见。
 * （曾出现 bounds=null、view=0×0/隐藏 → 网页标题正常但窗口区域全黑。）
 */

function startSite(): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><html><head><title>打包浏览器测试</title></head><body style="background:#fff"><h1>打包浏览器测试页</h1><p>原生视图可见性回归。</p></body></html>'
      )
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

test('打包版：工作台打开浏览器后原生视图有 bounds 且可见', async () => {
  test.setTimeout(180_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  const site = await startSite()
  const morrow = await launchMorrow({
    name: 'r8-packaged-browser',
    executablePath: appExe,
    waitForSelector: '.sidebar',
    timeoutMs: 120_000
  })
  try {
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    await page.locator('.browser-address-input').fill(`${site.url}/`)
    await page.locator('.browser-address-input').press('Enter')

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const api = (window as unknown as { morrow: { features: { invoke: (c: string) => Promise<any> } } }).morrow
            const result = await api.features.invoke('feature:browser:debug-info')
            return result?.data?.surfaceTitle ?? ''
          }),
        { timeout: 30_000 }
      )
      .toBe('打包浏览器测试')

    const info = await page.evaluate(async () => {
      const api = (window as unknown as { morrow: { features: { invoke: (c: string) => Promise<any> } } }).morrow
      return (await api.features.invoke('feature:browser:debug-info'))?.data
    })
    expect(info.surface, JSON.stringify(info)).toBe(true)
    expect(info.surfaceVisible, JSON.stringify(info)).toBe(true)
    expect(info.surfaceBounds?.width ?? 0).toBeGreaterThan(0)
    expect(info.surfaceBounds?.height ?? 0).toBeGreaterThan(0)
    expect(info.surfaceWebContentsSize?.width ?? 0).toBeGreaterThan(0)
    expect(info.surfaceWebContentsSize?.height ?? 0).toBeGreaterThan(0)

    // 实际合成画面证据（含原生视图）
    const png = await app.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1000 } })
      const morrow = sources.find((source) => source.name === 'Morrow')
      return morrow?.thumbnail.toPNG().toString('base64') ?? ''
    })
    if (png) writeFileSync(screenshotPath('packaged-browser-ui.png'), Buffer.from(png, 'base64'))
  } finally {
    await morrow.close()
    await site.close()
  }
})

})

// ── 原文件：portable-copies.spec.ts ──────────────────────────────────────────────
test.describe('portable-copies.spec.ts', () => {
test('两份便携副本使用不同数据目录时都能启动', async () => {
  test.setTimeout(180_000)
  const first = await launchMorrow({ name: 'two-copies-a', waitForSelector: '.sidebar' })
  const second = await launchMorrow({ name: 'two-copies-b', waitForSelector: '.sidebar' })
  try {
    expect(await first.page.title()).toBe('Morrow')
    expect(await second.page.title()).toBe('Morrow')
    expect(await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0)
    expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0)
  } finally {
    await first.close()
    await second.close()
  }
})

})

// ── 打包版创作台：演示资产随 extraResources 交付 ──────────────────────────────
test.describe('packaged-studio.spec.ts', () => {
test('打包版包含创作台演示资产，作品库与时间线可打开', async () => {
  test.setTimeout(240_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist:all）再跑打包冒烟')
    return
  }
  const morrow = await launchMorrow({ name: 'packaged-studio', executablePath: appExe, timeoutMs: 120_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 60_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await expect(page.locator('.studio-project-card')).toHaveCount(3, { timeout: 60_000 })
    await expect(page.locator('.studio-root')).not.toContainText('创作台')
    await expect(page.locator('.studio-topbar img.studio-mark')).toHaveCount(0)

    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await expect(page.locator('.studio-monitor img')).toHaveCount(1, { timeout: 30_000 })
    await expect(page.locator('.studio-clip').first()).toBeVisible()
    await expect
      .poll(() => page.locator('.studio-root').evaluate((node) => getComputedStyle(node).getPropertyValue('--studio-paper').trim()))
      .toBe('#17191d')
    await page.screenshot({ path: screenshotPath('packaged-studio-dark.png') })
  } finally {
    await morrow.close()
  }
})
})
