import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore, waitUntil } from './store'

test.describe('创作台 · 首次指引、演示与灵动岛', () => {
  test('首次进入指引、随时观看的演示、无斜体、关于页与灵动岛真实状态', async () => {
    test.setTimeout(180_000)
    const morrow = await launchMorrow({ name: 'studio-ux', env: { MORROW_ISLAND: '1', MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      const guide = page.locator('.studio-guide')
      await expect(guide).toBeVisible({ timeout: 15_000 })
      await expect(guide.locator('.studio-guide-brand img')).toHaveJSProperty('complete', true)
      expect(await guide.locator('.studio-guide-brand img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      await expect(guide).toContainText('创作台')
      await page.screenshot({ path: screenshotPath('studio-guide-dark.png') })
      await guide.getByRole('button', { name: '下一步' }).click()
      await guide.getByRole('button', { name: '下一步' }).click()
      await guide.getByRole('button', { name: '看演示' }).click()
      const demo = page.locator('.studio-demo')
      await expect(demo).toBeVisible({ timeout: 15_000 })
      await expect(demo).toContainText('真实界面')
      await expect(demo).toContainText('一句话')
      // 演示驱动真实首页：真输入框里逐字写出样例的一句话
      await expect(page.locator('.studio-logline-input')).toHaveValue(/一个雨夜/, { timeout: 20_000 })
      await page.locator('.studio-demo-play[title="暂停"]').click()

      // 真实蓝图页
      await page.locator('.studio-demo-next').click()
      await expect(page.locator('.studio-blueprint')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.studio-blueprint-title-block')).toBeVisible()
      await expect(demo).toContainText('蓝图')

      // 真实分镜页：12 个镜头，并自动打开第 6 镜的真实详情
      await page.locator('.studio-demo-next').click()
      await expect(page.locator('.studio-shot-card')).toHaveCount(12, { timeout: 20_000 })
      await expect(page.locator('.studio-shot-inspector')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('studio-demo-dark.png') })

      // 真实时间线：五轨剪辑与监视器
      await page.locator('.studio-demo-next').click()
      await expect(page.locator('.studio-timeline-view')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.studio-monitor')).toBeVisible()
      await expect(page.locator('.studio-clip').first()).toBeVisible()

      // 真实交付页
      await page.locator('.studio-demo-next').click()
      await expect(page.locator('.studio-delivery')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.studio-delivery-poster')).toBeVisible()
      await expect(page.locator('.studio-delivery-row').first()).toBeVisible()

      // 退出演示，恢复到进入前的首页
      await page.keyboard.press('Escape')
      await expect(demo).toHaveCount(0)
      await expect(page.locator('.studio-home')).toBeVisible()
      await expect(page.locator('.studio-home-utility')).toHaveCount(2)
      await page.screenshot({ path: screenshotPath('studio-home-dark.png') })

      // 首页的随时演示入口
      await page.locator('.studio-home-utility', { hasText: '看演示' }).click()
      await expect(page.locator('.studio-demo')).toBeVisible()
      await page.locator('.studio-demo-close').click()
      await expect(page.locator('.studio-demo')).toHaveCount(0)

      // 第一次进入的指引可以再次打开
      await page.locator('.studio-home-utility', { hasText: '使用指引' }).click()
      await expect(page.locator('.studio-guide')).toBeVisible()
      await page.locator('.studio-guide-skip').click()
      await expect(page.locator('.studio-guide')).toHaveCount(0)

      // 创作台内没有产品标题/图标；全应用不使用斜体
      await expect(page.locator('.studio-brand')).toHaveCount(0)
      await expect(page.locator('.studio-topbar img.studio-mark')).toHaveCount(0)
      await expect(page.locator('.studio-root')).not.toContainText('创作台')
      const italics = await page.evaluate(() =>
        Array.from(document.querySelectorAll('em, i, cite, dfn, var'))
          .map((element) => getComputedStyle(element).fontStyle)
          .filter((style) => style !== 'normal')
      )
      expect(italics).toEqual([])

      // 灵动岛跟随创作台，而不是空的 Agent 会话
      const island = await page.evaluate(async () => {
        const response = await window.morrow.island.snapshot()
        return response.ok ? response.data : null
      })
      expect(island?.mode).toBe('studio')
      expect(island?.studioProjectTitle).toBe('作品库')

      // 灵动岛创作台主按钮：真实点击 + 统一的微圆角实心矩形。
      const islandPage = morrow.app.windows().find((candidate) => candidate.url().includes('#island'))
      expect(islandPage).toBeTruthy()
      if (!(await islandPage!.locator('.island-panel').count())) {
        const chevron = islandPage!.locator('.island-chevron')
        if (await chevron.isVisible().catch(() => false)) await chevron.click()
      }
      await expect(islandPage!.locator('.island-panel')).toBeVisible({ timeout: 15_000 })
      const openStudio = islandPage!.locator('.island-panel-foot').getByRole('button', { name: '打开创作台' })
      await expect(openStudio).toBeVisible()
      const studioButton = await openStudio.evaluate((element) => {
        const style = getComputedStyle(element)
        return { radius: style.borderRadius, background: style.backgroundColor, border: style.borderStyle }
      })
      expect(parseFloat(studioButton.radius)).toBeLessThanOrEqual(6)
      expect(studioButton.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(studioButton.border).toBe('solid')
      await islandPage!.screenshot({ path: screenshotPath('studio-island-studio-dark.png') })

      // 灵动岛“回到 Agent”必须点击真实按钮退出创作台，而不只是聚焦主窗口。
      await islandPage!.locator('.island-panel-foot').getByRole('button', { name: '回到 Agent' }).click()
      await expect(page.locator('.studio-root')).toHaveCount(0, { timeout: 15_000 })
      await expect(page.locator('.sidebar')).toBeVisible()
      const afterReturn = await page.evaluate(async () => {
        const response = await window.morrow.island.snapshot()
        return response.ok ? response.data : null
      })
      expect(afterReturn?.mode).not.toBe('studio')

      // 重新进入创作台，继续验证退出与关于页
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 20_000 })
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()

      // 退出后关于页只保留 Morrow 主应用信息
      await page.locator('.studio-exit').click()
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
        store.getState().openSettings()
      })
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible', timeout: 15_000 })
      await settings.getByRole('tab', { name: '关于' }).click()
      await expect(settings.locator('.st-about-brand')).toBeVisible()
      await expect(settings.locator('.st-about-studio')).toHaveCount(0)
      await expect(settings).not.toContainText('把一句话做成一部作品')
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      await morrow.close()
    }
  })

  test('导出任务会在灵动岛显示真实进度与完成状态', async () => {
    test.setTimeout(120_000)
    const morrow = await launchMorrow({ name: 'studio-island-job', env: { MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
      await page.waitForTimeout(600)
      const list = await page.evaluate(async () => {
        const response = await window.morrow.features.invoke('feature:studio:action', { type: 'list' })
        return response.ok ? response.data : null
      })
      const project = list?.projects?.find((item: { title: string }) => item.title === '极速曙光')
      expect(project?.id).toBeTruthy()
      await page.locator('.studio-project-card', { hasText: '极速曙光' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      await page.evaluate(async (projectId: string) => {
        const response = await window.morrow.features.invoke('feature:studio:action', { type: 'export', projectId, format: 'txt' })
        if (!response.ok) throw new Error(response.error?.message)
      }, project.id)
      await waitUntil(
        async () => {
          const response = await page.evaluate(async () => {
            const snapshot = await window.morrow.island.snapshot()
            return snapshot.ok ? snapshot.data : null
          })
          return response?.mode === 'studio' && Boolean(response.studioJobLabel)
        },
        20_000,
        '灵动岛显示创作台任务'
      )
      const island = await page.evaluate(async () => {
        const response = await window.morrow.island.snapshot()
        return response.ok ? response.data : null
      })
      expect(island?.studioProjectTitle).toBe('极速曙光')
      expect(island?.studioJobActive || island?.status === 'done').toBe(true)
    } finally {
      await morrow.close()
    }
  })
})
