/**
 * R10 UI 文案/布局复审（真实 Electron；不调用真实模型）。
 *
 * 打开 6 个工作台面板 + 设置 + 文件树 + 编辑器，检查：
 * - 可见文案（写入 docs/audit/logs/r10-ui-copy-review.json，供术语堆砌复核）；
 * - 横向溢出（scrollWidth - clientWidth）；
 * - 截图 docs/verification/screens/r10-ui-copy-*.png。
 *
 * 运行：npm run build && npx playwright test tests/e2e/r10-ui-copy-review.spec.ts
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

const PANELS = ['技能库', '记忆中心', '项目', '连接器', '全局搜索', '内置浏览器']

async function overflowOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel: string) => {
    const element = document.querySelector(sel) as HTMLElement | null
    if (!element) return -1
    return element.scrollWidth - element.clientWidth
  }, selector)
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement
    // 输入框只保留标签/占位符层级，避免把技术字段值当说明文案
    body.querySelectorAll('input, textarea, select').forEach((element) => {
      element.setAttribute('value', '')
    })
    return (body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 6000)
  })
}

test.describe('R10 UI 文案与布局复审', () => {
  let morrow: MorrowApp
  let page: Page
  const observations: Array<Record<string, unknown>> = []
  const workspace = join(root, 'tmp', `r10-ui-review-${Date.now()}`)

  test.beforeAll(async () => {
    const fixtureRoot = join(root, 'tmp', 'audit', 'r10', 'fixtures', 'ws-main')
    if (existsSync(fixtureRoot)) cpSync(fixtureRoot, workspace, { recursive: true })
    else mkdirSync(join(workspace, 'in'), { recursive: true })
    morrow = await launchMorrow({ name: 'r10-ui-copy', waitForSelector: '.sidebar', timeoutMs: 90_000 })
    page = morrow.page
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ onboardingDone: true })
      await store.getState().newSession({ workspace: ws })
    }, workspace)
    await page.waitForTimeout(900)
  })

  test.afterAll(async () => {
    try {
      await morrow?.app.close()
    } catch {
      // ignore
    }
    rmSync(workspace, { recursive: true, force: true })
    mkdirSync(join(root, 'docs', 'audit', 'logs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'audit', 'logs', 'r10-ui-copy-review.json'), JSON.stringify(observations, null, 2), 'utf8')
  })

  test('6 面板 + 设置 + 文件树 + 编辑器截图与溢出检查', async () => {
    // 文件树
    await page.locator('.file-tree').waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('.sidebar').screenshot({ path: screenshotPath('r10-ui-copy-files.png') })
    observations.push({
      view: '文件树',
      overflow: await overflowOf(page, '.sidebar'),
      text: await page.locator('.file-tree').innerText()
    })

    // 工作台 6 面板
    for (const panel of PANELS) {
      await page.keyboard.press('Control+Shift+W')
      await expect(page.locator('.workbench-card')).toHaveCount(6)
      await page.locator('.workbench-card').filter({ hasText: panel }).click()
      await page.waitForTimeout(750)
      await page.screenshot({ path: screenshotPath(`r10-ui-copy-${panel}.png`) })
      observations.push({
        view: panel,
        overflow: await overflowOf(page, 'body'),
        text: await visibleText(page)
      })
      if (panel === '内置浏览器') await page.locator('.browser-close').click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }

    // 设置
    const settingsButton = page.locator('[aria-label^="设置"]').last()
    await settingsButton.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: screenshotPath('r10-ui-copy-settings.png') })
    observations.push({ view: '设置', overflow: await overflowOf(page, 'body'), text: await visibleText(page) })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // 编辑器（打开中文文件，420px 窄画布）
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().setCanvasWidth(420, false)
      window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path: 'in/中文资料.txt' } }))
    })
    await page.locator('.canvas-root .cm-editor').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(600)
    await page.locator('.canvas-root').screenshot({ path: screenshotPath('r10-ui-copy-editor.png') })
    observations.push({
      view: '编辑器',
      overflow: await overflowOf(page, '.canvas-root'),
      canvasWidth: await page.locator('.canvas-root').evaluate((element) => (element as HTMLElement).clientWidth),
      text: await page.locator('.canvas-root').innerText()
    })
  })
})
