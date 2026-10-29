// Extra guide screens that the long walkthrough does not cover.
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

test.describe('guide-extra', () => {
  test('补拍创作台创建、纲要、声音子页、设置子页与计划卡', async () => {
    test.setTimeout(180_000)
    const morrow = await launchMorrow({ name: 'guide-extra', timeoutMs: 90_000 })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')

      await page.locator('.tb-create').click()
      await expect(page.locator('.studio-home')).toBeVisible({ timeout: 30_000 })
      if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
      await page.waitForTimeout(600)
      await page.screenshot({ path: screenshotPath('studio-create-dark.png') })

      // Long novel outline
      await page.locator('.studio-project-card', { hasText: '雨伞铺的第七个夏天' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      if (await page.locator('.studio-stage-item', { hasText: '大纲' }).count()) {
        await page.locator('.studio-stage-item', { hasText: '大纲' }).click()
      } else {
        await page.getByRole('button', { name: '切换阶段' }).click()
        await page.getByRole('menuitem', { name: '大纲' }).click()
      }
      await page.waitForTimeout(800)
      await page.screenshot({ path: screenshotPath('studio-outline-dark.png') })

      // Drama sound sub-tabs
      await page.locator('.studio-home-link').click()
      await expect(page.locator('.studio-home')).toBeVisible({ timeout: 15_000 })
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
      await page.locator('.studio-stage-item', { hasText: '声音' }).click()
      await page.getByRole('tab', { name: '配音' }).click()
      await page.waitForTimeout(700)
      await page.screenshot({ path: screenshotPath('studio-voice-tab-dark.png') })
      await page.getByRole('tab', { name: '音乐' }).click()
      await page.waitForTimeout(700)
      await page.screenshot({ path: screenshotPath('studio-music-tab-dark.png') })

      // Pending plan card (local rules, no model)
      await page.locator('.studio-stage-item', { hasText: '时间线' }).click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
      if (!(await page.locator('.studio-assistant').isVisible())) {
        await page.locator('[aria-label="切换协作者面板"]').click()
      }
      const composer = page.locator('.studio-assistant-composer textarea')
      await composer.fill('加一段雨声，铺在开头。')
      await composer.press('Enter')
      const card = page.locator('.studio-plan-card')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('studio-plan-card-dark.png') })
      await card.locator('.studio-plan-cancel').click()

      // Settings sub-pages
      await page.locator('.studio-top-icon[title="创作台设置"]').click()
      await page.waitForSelector('.studio-settings-layout', { timeout: 15_000 })
      await page.getByRole('tab', { name: '回收站' }).click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: screenshotPath('studio-trash-dark.png') })
      await page.getByRole('tab', { name: '数据与安全' }).click()
      await page.waitForTimeout(500)
      await page.screenshot({ path: screenshotPath('studio-settings-data-dark.png') })
    } finally {
      await morrow.close()
    }
  })
})
