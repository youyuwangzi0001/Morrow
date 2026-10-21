/**
 * 品牌标识一致性：欢迎/引导页、启动读取页、收起侧栏都必须使用重绘品牌 icon，而不是字母 M。
 */
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

test('欢迎页 / 启动读取页使用品牌 icon', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'brand-marks', waitForSelector: '.onb' })
  try {
    const { page } = morrow
    const onboardingMark = page.locator('.onb-brand-mark img')
    await expect(onboardingMark).toBeVisible()
    await expect(onboardingMark).toHaveAttribute('src', /brand-mark/)
    await expect(page.locator('.onb')).toBeVisible()
    // 等应用 900ms 入场淡入结束，避免把半透明的中间态截进证据
    await page.waitForTimeout(1000)
    await page.screenshot({ path: screenshotPath('brand-onboarding-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('brand-onboarding-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)

    await dismissOnboarding(page)

    // 启动读取页：借助 test-mode store 强制回到未 ready 状态
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore.setState({
        ready: false
      })
    })
    const bootMark = page.locator('img.app-boot-mark')
    await expect(bootMark).toBeVisible()
    await expect(bootMark).toHaveAttribute('src', /brand-mark/)
    await page.waitForTimeout(900)
    await page.screenshot({ path: screenshotPath('brand-boot-dark.png') })
  } finally {
    await morrow.close()
  }
})
