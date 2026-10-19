import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

const PANELS: { card: string; file: string }[] = [
  { card: '技能库', file: 'r10-panel-skills.png' },
  { card: '记忆中心', file: 'r10-panel-memory.png' },
  { card: '项目', file: 'r10-panel-projects.png' },
  { card: '连接器', file: 'r10-panel-connectors.png' },
  { card: '全局搜索', file: 'r10-panel-search.png' },
  { card: '内置浏览器', file: 'r10-panel-browser.png' }
]

test.describe('R10 工作台面板集成', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('六个面板都能从工作台打开/关闭', async () => {
    morrow = await launchMorrow({ name: 'r10-panels', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)
    for (const panel of PANELS) {
      await page.locator('[aria-label="打开工作台 (Ctrl+Shift+W)"]').click()
      await expect(page.locator('.workbench-card')).toHaveCount(6)
      await page.locator('.workbench-card').filter({ hasText: panel.card }).click()
      await page.waitForTimeout(800)
      await page.screenshot({ path: screenshotPath(panel.file) })
      if (panel.card === '内置浏览器') {
        await page.locator('.browser-close').click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(500)
    }
  })
})
