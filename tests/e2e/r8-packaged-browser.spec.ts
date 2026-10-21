/**
 * 打包版内置浏览器回归：从工作台真实打开 → 原生 WebContentsView 必须拿到 bounds 并可见。
 * （曾出现 bounds=null、view=0×0/隐藏 → 网页标题正常但窗口区域全黑。）
 */
import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { getPackagedAppExe } from './packaged-runtime'
import { dismissOnboarding, openToolPanel, waitForStoreReady } from './store'

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
