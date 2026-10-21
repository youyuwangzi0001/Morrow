/** R7：新默认布局 240/420 与侧栏品牌区视觉验收。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, root, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

test.describe('R7 默认布局与品牌区', () => {
  let morrow: MorrowApp
  test.afterEach(async () => {
    await morrow?.close()
  })

  test('旧默认宽度 264/560 一次性迁移到 240/420，自定义宽度保留', async () => {
    const dataDir = join(root, 'tmp', `r7-migrate-${Date.now()}`)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ sidebarWidth: 264, canvasWidth: 560 }), 'utf8')
    morrow = await launchMorrow({ name: 'r7-migrate', dataDir, waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    const widths = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return { sidebar: s.sidebarWidth, canvas: s.canvasWidth }
    })
    expect(widths.sidebar).toBe(240)
    expect(widths.canvas).toBe(420)
    await morrow.close()
    morrow = null

    const customDir = join(root, 'tmp', `r7-custom-${Date.now()}`)
    mkdirSync(customDir, { recursive: true })
    writeFileSync(join(customDir, 'settings.json'), JSON.stringify({ sidebarWidth: 300, canvasWidth: 520 }), 'utf8')
    morrow = await launchMorrow({ name: 'r7-custom', dataDir: customDir, waitForSelector: '.sidebar' })
    await waitForStoreReady(morrow.page)
    const custom = await morrow.page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return { sidebar: s.sidebarWidth, canvas: s.canvasWidth }
    })
    expect(custom.sidebar).toBe(300)
    expect(custom.canvas).toBe(520)
  })

  test('默认三栏比例：侧栏 240px / 画布 420px，深色与浅色品牌区', async () => {
    morrow = await launchMorrow({ name: 'r7-ui', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.waitForTimeout(400)
    const layout = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return {
        sidebarWidth: s.sidebarWidth,
        canvasWidth: s.canvasWidth,
        sidebarSetting: s.settings.sidebarWidth,
        canvasSetting: s.settings.canvasWidth
      }
    })
    expect(layout.sidebarWidth).toBe(240)
    expect(layout.canvasWidth).toBe(420)
    await expect(page.locator('.app-sidebar-shell')).toHaveJSProperty('clientWidth', 240)
    await page.screenshot({ path: screenshotPath('r7-final-default-dark.png') })

    // 打开画布，让三栏比例落到截图
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r7-final-layout-dark.png') })
    const canvasBox = await page.locator('.canvas-root').boundingBox()
    expect(canvasBox?.width).toBeGreaterThanOrEqual(418)
    expect(canvasBox?.width).toBeLessThanOrEqual(422)

    await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { setTheme: (t: 'dark' | 'light') => Promise<void> } }
    }).__morrowStore.getState().setTheme('light'))
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r7-final-layout-light.png') })
    await page.screenshot({ path: screenshotPath('r7-final-brand-light.png') })
  })

  test('目标入口：目标按钮把输入框切到 /goal 前缀，不再弹出独立对话框', async () => {
    morrow = await launchMorrow({ name: 'r7-goal-entry', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.locator('[aria-label="把输入框内容设为目标（多轮自动推进）"]').click()
    await expect(page.locator('.composer-input')).toHaveValue('/goal ')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r7-final-goal-entry-dark.png') })
    await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { setTheme: (t: 'dark' | 'light') => Promise<void> } }
    }).__morrowStore.getState().setTheme('light'))
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r7-final-goal-entry-light.png') })
  })
})
