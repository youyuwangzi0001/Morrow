import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

test('自动推进在确认后排入补齐与草稿合成任务', async () => {
  test.setTimeout(240_000)
  const morrow = await launchMorrow({ name: 'studio-pipeline', env: { MORROW_SEED_CORPUS: '1' } })
  const page = morrow.page
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '0.12秒' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-stage-item', { hasText: '检查' }).click()
    await page.waitForSelector('.studio-review', { timeout: 20_000 })

    await page.getByRole('button', { name: '自动补齐并合成草稿' }).click()
    const dialog = page.getByRole('dialog', { name: '自动推进到草稿' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('合成一版可审看的草稿')
    await dialog.getByRole('button', { name: '开始补齐并合成' }).click()

    const pipelineRow = page.locator('.studio-receipt-row', { hasText: '自动推进 · 装配并合成草稿' }).first()
    await expect(pipelineRow).toBeVisible({ timeout: 30_000 })
    const renderRow = page.locator('.studio-receipt-row', { hasText: '合成动态分镜草稿' }).first()
    await expect(renderRow).toBeVisible({ timeout: 60_000 })
    await page.screenshot({ path: screenshotPath('studio-auto-pipeline-dark.png') })
  } finally {
    await morrow.close()
  }
})
