/**
 * 打包版 UI 复核：项目范围切换与「关于 → 数据目录」入口必须随 app.asar 一起交付。
 */
import { expect, test } from '@playwright/test'
import { launchMorrow, type MorrowApp } from './launch'
import { getPackagedAppExe } from './packaged-runtime'
import { dismissOnboarding, waitForStoreReady } from './store'

test('打包版包含项目范围切换与自定义数据目录入口', async () => {
  test.setTimeout(90_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  let morrow: MorrowApp | null = null
  try {
    morrow = await launchMorrow({ name: 'packaged-ui-fixes', executablePath: appExe, timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    const scope = page.getByRole('radiogroup', { name: '项目范围' })
    await expect(scope).toBeVisible()
    await expect(scope.getByRole('radio', { name: '全部项目' })).toBeVisible()
    await expect(scope.getByRole('radio', { name: '当前文件夹' })).toBeVisible()
    await expect(page.locator('.pp-cta')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.pp-root')).toHaveCount(0)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    await expect(settings.getByRole('button', { name: '更改目录' })).toBeVisible()
    await expect(settings.getByRole('button', { name: '打开数据目录' })).toBeVisible()
    await expect(settings.locator('.st-about-path code')).not.toHaveText('—')
  } finally {
    await morrow?.close()
  }
})
