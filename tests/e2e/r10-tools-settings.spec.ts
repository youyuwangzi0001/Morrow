import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

test.describe('功能入口收敛', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('顶栏不再有工作台；功能入口集中在设置 → 功能与工具', async () => {
    morrow = await launchMorrow({ name: 'r10-tools-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)

    await expect(page.locator('[aria-label^="打开工作台"]')).toHaveCount(0)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible()
    await settings.getByRole('tab', { name: '功能与工具' }).click()
    await expect(settings.locator('.st-tool-row')).toHaveCount(8)
    await expect(settings.locator('.st-tool-row').filter({ hasText: '终端' })).toHaveCount(0)
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r10-tools-settings.png') })

    await settings.locator('.st-tool-row').filter({ hasText: '技能' }).click()
    await expect(page.getByTestId('skills-panel')).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('skills-panel')).toBeHidden()
  })
})
