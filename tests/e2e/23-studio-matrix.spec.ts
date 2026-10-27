import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, screensDir } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

test('创作台在小屏、中屏与大屏下均无横向溢出，监视器随视口放大', async () => {
  test.setTimeout(300_000)
  const outDir = join(screensDir, 'matrix')
  mkdirSync(outDir, { recursive: true })
  const morrow = await launchMorrow({ name: 'matrix', env: { MORROW_SEED_CORPUS: '1' } })
  const page = morrow.page
  const resize = async (width: number, height: number): Promise<void> => {
    await morrow.app.evaluate(async ({ BrowserWindow }, target) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
      if (!win) return
      win.setResizable(true)
      win.setContentSize(target.width, target.height)
      win.center()
    }, { width, height })
    await page.waitForTimeout(800)
  }
  const overflow = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  const box = (selector: string): Promise<{ width: number; height: number } | null> =>
    page.evaluate((key) => {
      const el = document.querySelector<HTMLElement>(key)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { width: Math.round(rect.width), height: Math.round(rect.height) }
    }, selector)

  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '0.12秒' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })

    const sizes = [
      { width: 1280, height: 800 },
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 }
    ]
    for (const size of sizes) {
      await resize(size.width, size.height)
      expect(await overflow(), `${size.width} 时间线横向溢出`).toBeLessThanOrEqual(2)
      const frame = await box('.studio-monitor-frame')
      const screen = await box('.studio-monitor-screen')
      const editor = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.studio-timeline-editor')
        return el ? { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight } : null
      })
      expect(frame?.height ?? 0, `${size.width} 监视器高度`).toBeGreaterThan(200)
      expect((screen?.width ?? 0) / Math.max(1, frame?.width ?? 1), `${size.width} 预览占比`).toBeGreaterThan(0.45)
      expect(editor?.scrollHeight ?? 999, `${size.width} 轨道被裁切`).toBeLessThanOrEqual((editor?.clientHeight ?? 0) + 2)
      if (size.width >= 3840) {
        expect(frame?.height ?? 0, '大屏监视器应明显放大').toBeGreaterThanOrEqual(400)
      }
      await page.screenshot({ path: join(outDir, `studio-${size.width}.png`) })
    }

    // 大屏其余页面：分镜、交付、首页与写作都不能出现横向溢出。
    await resize(3840, 2160)
    await page.locator('.studio-stage-item', { hasText: '分镜' }).click()
    await page.waitForSelector('.studio-storyboard', { timeout: 20_000 })
    await page.waitForTimeout(400)
    expect(await overflow(), '3840 分镜横向溢出').toBeLessThanOrEqual(2)

    await page.locator('.studio-stage-item', { hasText: '交付' }).click()
    await page.waitForTimeout(700)
    expect(await overflow(), '3840 交付横向溢出').toBeLessThanOrEqual(2)

    for (const stage of ['蓝图', '大纲', '画面', '配音', '音乐', '检查']) {
      await page.locator('.studio-stage-item', { hasText: stage }).first().click()
      await page.waitForTimeout(500)
      expect(await overflow(), `3840 ${stage}横向溢出`).toBeLessThanOrEqual(2)
    }

    await page.locator('.studio-home-link').click()
    await page.waitForSelector('.studio-home', { timeout: 20_000 })
    await page.waitForTimeout(400)
    expect(await overflow(), '3840 首页横向溢出').toBeLessThanOrEqual(2)

    await page.locator('.studio-project-card', { hasText: '雨停之前' }).first().locator('.studio-project-cover').click()
    await page.waitForTimeout(900)
    await page.locator('.studio-stage-item', { hasText: '写作' }).click()
    await page.waitForTimeout(600)
    expect(await overflow(), '3840 写作横向溢出').toBeLessThanOrEqual(2)

    // 小屏回退：分镜与首页仍无横向溢出。
    await page.locator('.studio-home-link').click()
    await page.waitForSelector('.studio-home', { timeout: 20_000 })
    await resize(1280, 800)
    expect(await overflow(), '1280 首页横向溢出').toBeLessThanOrEqual(2)
    await page.locator('.studio-project-card', { hasText: '0.12秒' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-stage-item', { hasText: '分镜' }).click()
    await page.waitForSelector('.studio-storyboard', { timeout: 20_000 })
    await page.waitForTimeout(400)
    expect(await overflow(), '1280 分镜横向溢出').toBeLessThanOrEqual(2)
    for (const stage of ['蓝图', '大纲', '画面', '配音', '音乐', '检查']) {
      await page.locator('.studio-stage-item', { hasText: stage }).first().click()
      await page.waitForTimeout(450)
      expect(await overflow(), `1280 ${stage}横向溢出`).toBeLessThanOrEqual(2)
    }
  } finally {
    await morrow.close()
  }
})
