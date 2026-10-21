import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, openToolPanel, waitForStoreReady } from './store'

const PANELS: { card: string; file: string }[] = [
  { card: '技能库', file: 'r10-panel-skills.png' },
  { card: '记忆中心', file: 'r10-panel-memory.png' },
  { card: '项目', file: 'r10-panel-projects.png' },
  { card: '连接器', file: 'r10-panel-connectors.png' },
  { card: '全局搜索', file: 'r10-panel-search.png' },
  { card: '内置浏览器', file: 'r10-panel-browser.png' }
]

test.describe('功能面板集成', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('所有功能面板都能从设置 → 功能与工具打开/关闭', async () => {
    morrow = await launchMorrow({ name: 'r10-panels', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)
    for (const panel of PANELS) {
      await openToolPanel(page, panel.card)
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
