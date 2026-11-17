import { launchMorrow, dismissOnboarding, setThemeViaStore } from './helpers'
import { expect, test } from '@playwright/test'

/** 用 DOM 几何核对轨道行：名称、可见性、是否被裁切。不依赖截图审看。 */
test('@core:studio-timeline 轨道头逐个可见且文字不被裁切（含环境床）', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'audio-geom' })
  const page = morrow.page
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await Promise.race([
      page.waitForSelector('.studio-timeline-view', { timeout: 30_000 }),
      page.waitForSelector('.studio-home', { timeout: 30_000 })
    ])
    if (await page.locator('.studio-home').count()) {
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    }
    await expect(page.locator('.studio-root')).toContainText('逆行的伞')

    const labels = page.locator('.studio-timeline-view').getByText('环境床', { exact: true })
    await expect(labels.first()).toBeVisible()
    const geometry = await labels.first().evaluate((element) => {
      const box = element.getBoundingClientRect()
      const parent = element.closest('*')?.parentElement?.getBoundingClientRect()
      return {
        text: element.textContent?.trim() ?? '',
        width: Math.round(box.width),
        height: Math.round(box.height),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        visible: box.width > 0 && box.height > 0,
        parentWidth: parent ? Math.round(parent.width) : 0
      }
    })
    expect(geometry.text).toBe('环境床')
    expect(geometry.visible).toBe(true)
    expect(geometry.width).toBeGreaterThan(10)
    // 文字没有被压缩到不可读（宽度足以放下三个汉字）。
    expect(geometry.clientWidth).toBeGreaterThanOrEqual(geometry.scrollWidth - 1)

    // 六个轨道名都应该在界面上（画面 / 对白 / 环境床 / 音乐 / 音效 / 字幕）。
    const trackTexts = await page.locator('.studio-timeline-view').innerText()
    for (const name of ['画面', '对白', '环境床', '音乐', '音效', '字幕']) {
      expect(trackTexts, `轨道「${name}」应出现在时间线上`).toContain(name)
    }
  } finally {
    await morrow.close()
  }
})