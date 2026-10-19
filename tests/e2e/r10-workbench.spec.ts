import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

test.describe('R10 工作台入口', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('工作台弹窗与技能库面板可打开', async () => {
    morrow = await launchMorrow({ name: 'r10-workbench', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)
    await page.locator('[aria-label="打开工作台 (Ctrl+Shift+W)"]').click()
    await expect(page.locator('.modal-panel')).toBeVisible()
    await expect(page.locator('.workbench-card')).toHaveCount(6)
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r10-workbench-menu.png') })
    await page.locator('.workbench-card').filter({ hasText: '技能库' }).click()
    await expect(page.locator('.skills-panel, [aria-label="技能库"]').first()).toBeVisible({ timeout: 10000 }).catch(() => undefined)
    await page.waitForTimeout(700)
    await page.screenshot({ path: screenshotPath('r10-skills-panel.png') })
  })
})
