/**
 * 画布 HTML 产物沙箱回归：
 * - 生产 CSP 下内联脚本仍可执行（独立 morrow-artifact:// 协议 + 自身 CSP）；
 * - iframe 不带 allow-same-origin，无法拿到宿主数据；
 * - 产物内 http(s) 链接通过 postMessage 交给系统浏览器，不在应用内导航；
 * - 明暗主题截图。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { createUiSession, dismissOnboarding, setThemeViaStore, waitForStoreReady } from './store'

const REPORT = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 30px; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f6f1e7; color: #2a2721; }
  h1 { margin: 0 0 14px; font-size: 24px; letter-spacing: .02em; }
  .card { border: 1px solid #dfd5c2; border-radius: 10px; padding: 16px 18px; background: #fffaf0; }
  #out { color: #8a6f42; }
  .muted { color: #7d7568; font-size: 12px; }
  a { color: #8a6f42; }
</style></head>
<body>
  <h1>季度销售报告</h1>
  <div class="card">
    <p>脚本状态：<strong id="out">static</strong></p>
    <p class="muted">如果这里显示 script-ran，说明沙箱内的内联脚本正常工作。</p>
  </div>
  <p><a id="ext" href="https://example.com/">查看外部资料</a></p>
  <script>document.getElementById('out').textContent = 'script-ran';</script>
</body></html>`

test('HTML 产物在 CSP 下可交互，外链交宿主打开，沙箱无同源', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-preview-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'artifact-preview', env: { MORROW_TEST_CSP: '1' } })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: 'HTML 产物预览测试'
    })

    await page.evaluate((content) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-html-preview',
        title: '季度销售报告',
        kind: 'html',
        content,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, REPORT)

    await expect(page.locator('iframe.canvas-frame')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('iframe.canvas-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
    const frame = page.frames().find((item) => item.url().startsWith('morrow-artifact://'))
    expect(frame, '找不到 morrow-artifact 预览帧').toBeTruthy()
    await expect(frame!.locator('#out')).toHaveText('script-ran', { timeout: 10_000 })
    // 沙箱没有 allow-same-origin：脚本可见，但拿不到宿主存储/DOM
    expect(await frame!.evaluate(() => window.origin)).toBe('null')

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { setState: (patch: any) => void } }).__morrowStore
      ;(window as unknown as { __openedExternal?: string[] }).__openedExternal = []
      store.setState({
        openExternal: async (url: string) => {
          ;(window as unknown as { __openedExternal?: string[] }).__openedExternal!.push(url)
        }
      })
    })
    const beforeUrl = page.url()
    await frame!.locator('#ext').click()
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __openedExternal?: string[] }).__openedExternal ?? []), {
        timeout: 10_000
      })
      .toEqual(['https://example.com/'])
    expect(page.url()).toBe(beforeUrl)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('artifact-preview-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('artifact-preview-light.png') })
  } finally {
    await morrow.close()
  }
})

test('超大文本产物只读前缀并显示截断提示', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-large-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const filePath = join(workspace, 'large.txt')
  writeFileSync(filePath, 'a'.repeat(2.2 * 1024 * 1024), 'utf8')
  const morrow = await launchMorrow({ name: 'artifact-large' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: '大产物截断测试'
    })
    await page.evaluate((path) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-large-text',
        title: 'large.txt',
        kind: 'file',
        path,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, filePath)

    await expect(page.locator('.canvas-truncated-note')).toContainText('只显示了前 2MB', { timeout: 20_000 })
    const length = await page.evaluate(() => document.querySelector('.canvas-text')?.textContent?.length ?? 0)
    expect(length).toBe(2 * 1024 * 1024)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('artifact-truncated-dark.png') })
  } finally {
    await morrow.close()
  }
})

test('PNG 截图产物自动进入只读图片预览，而不是按文本读取', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-image-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const imagePath = join(workspace, 'screenshot.png')
  writeFileSync(imagePath, readFileSync(join(root, 'build', 'icon.png')))
  const morrow = await launchMorrow({ name: 'artifact-image' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: '截图产物预览测试'
    })
    await page.evaluate((path) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-image-preview',
        title: '网页截图 · example.com',
        kind: 'file',
        path,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, imagePath)

    await expect(page.locator('.preview-image')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.canvas-text')).toHaveCount(0)
    await expect(page.locator('.canvas-head-kicker')).toContainText('图片')
    await expect(page.locator('.canvas-tab[title*="图片"]')).toBeVisible()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('artifact-image-preview-dark.png') })

    // 关闭预览后不应回退成二进制乱码，而是给出重新打开入口
    await page.locator('.canvas-tab-close').click()
    await expect(page.getByText('这个文件可以只读预览。')).toBeVisible()
    await page.getByRole('button', { name: '打开预览' }).click()
    await expect(page.locator('.preview-image')).toBeVisible({ timeout: 20_000 })
  } finally {
    await morrow.close()
  }
})
