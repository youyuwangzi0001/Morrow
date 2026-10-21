/**
 * M0/M1 冒烟：Electron 真实启动 → 窗口出现 → 标题/渲染/预加载 API 正常 → 首屏截图。
 *
 * 运行：npx playwright test tests/e2e/smoke.spec.ts
 * 产物：docs/verification/screens/e2e-boot.png
 *
 * 说明：断言刻意写得「面向未来」——M2/M3 会把骨架页换成真实 App Shell，
 * 这里只验证窗口/标题/渲染/预加载这些不随 UI 迭代变化的事实。
 */
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, root, windowStates } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

test.describe('Morrow 桌面冒烟', () => {
  test('构建产物可启动：窗口出现、标题正确、首屏有渲染', async () => {
    // 前提：out/main/index.js 已构建
    expect(existsSync(join(root, 'out', 'main', 'index.js')), '缺少构建产物 out/main/index.js，请先 npm run build').toBe(true)

    const pageErrors: string[] = []
    const morrow = await launchMorrow({ name: 'smoke' })
    morrow.page.on('pageerror', (err) => pageErrors.push(String(err)))

    try {
      const { app, page } = morrow

      // 1) 恰好一个可见窗口，且标题是 Morrow
      const windows = await windowStates(app)
      expect(windows.length).toBe(1)
      expect(windows[0].visible).toBe(true)
      expect(windows[0].title).toContain('Morrow')
      // 默认窗口按「物理像素 2000×1000」设计：Electron bounds 是 DIP，需要乘缩放比校验
      const scaleFactor = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor)
      expect(Math.round(windows[0].bounds.width * scaleFactor)).toBeGreaterThanOrEqual(2090)
      expect(Math.round(windows[0].bounds.height * scaleFactor)).toBeGreaterThanOrEqual(1190)

      // 2) 渲染进程加载的是本地构建产物
      await expect(page).toHaveURL(/^file:\/\/.*out\/renderer\/index\.html/)
      await page.waitForLoadState('load')

      // 3) 预加载 API（窄接口）已注入
      const preload = await page.evaluate(() => {
        const api = (window as unknown as { morrow?: Record<string, unknown> }).morrow
        return { hasApi: !!api, keys: api ? Object.keys(api).sort() : [] }
      })
      expect(preload.hasApi).toBe(true)
      expect(preload.keys.length).toBeGreaterThan(0)

      // 4) 首屏不是白屏：body 有文本、有可见节点
      const bodyText = (await page.locator('body').innerText()).trim()
      expect(bodyText.length).toBeGreaterThan(0)
      expect(await page.locator('body').isVisible()).toBe(true)

      // 5) 没有未捕获的渲染层异常
      expect(pageErrors, `渲染层异常：\n${pageErrors.join('\n')}`).toEqual([])

      // 6) 首屏截图归档
      await page.screenshot({ path: screenshotPath('e2e-boot.png') })
      expect(existsSync(join(root, 'docs', 'verification', 'screens', 'e2e-boot.png'))).toBe(true)

      // 7) 数据目录被 --data-dir 指到项目 tmp/ 内（受限令牌下可写）
      expect(morrow.dataDir.startsWith(join(root, 'tmp'))).toBe(true)
    } finally {
      await morrow.close()
    }
  })

  test('明暗主题：设计 token 切换生效，两套主题截图归档', async () => {
    const morrow = await launchMorrow({ name: 'theme' })
    try {
      const { page } = morrow
      await page.waitForLoadState('load')

      const readTheme = () =>
        page.evaluate(() => {
          const rootStyle = getComputedStyle(document.documentElement)
          return {
            themeAttr: document.documentElement.getAttribute('data-theme'),
            bgToken: rootStyle.getPropertyValue('--bg').trim(),
            bodyBg: getComputedStyle(document.body).backgroundColor
          }
        })

      // 默认深色（Settings 默认 theme=dark，store 会写到 documentElement.dataset.theme）
      const dark = await readTheme()
      expect(dark.bgToken.toLowerCase()).toBe('#0b0d10')
      expect(dark.bodyBg.replace(/\s/g, '')).toBe('rgb(11,13,16)')
      await page.screenshot({ path: screenshotPath('e2e-theme-dark.png') })

      // 切到素纸（light）主题：token 与底色必须真的变化
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light')
      })
      await page.waitForTimeout(400)
      const light = await readTheme()
      expect(light.themeAttr).toBe('light')
      expect(light.bgToken.toLowerCase()).toBe('#f1ede4')
      expect(light.bodyBg.replace(/\s/g, '')).toBe('rgb(241,237,228)')
      await page.screenshot({ path: screenshotPath('e2e-theme-light.png') })

      // 切回深色，确认可逆
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark')
      })
      await page.waitForTimeout(200)
      const back = await readTheme()
      expect(back.bodyBg.replace(/\s/g, '')).toBe('rgb(11,13,16)')
    } finally {
      await morrow.close()
    }
  })

  test('外观设置：主题、字号与减少动效即时生效', async () => {
    const morrow = await launchMorrow({ name: 'appearance', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible' })
      await settings.getByRole('tab', { name: '外观' }).click()
      await expect(page.locator('.st-appearance')).toBeVisible()
      await page.waitForTimeout(150)
      await page.screenshot({ path: screenshotPath('settings-appearance-dark.png') })

      await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect(
        page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色' })
      ).toHaveAttribute('aria-checked', 'true')

      await page.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: '15' }).click()
      await expect(
        page.getByRole('radiogroup', { name: '字号' }).getByRole('radio', { name: '15' })
      ).toHaveAttribute('aria-checked', 'true')
      await expect
        .poll(() =>
          page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim())
        )
        .toBe('15px')

      const motion = page.getByRole('switch', { name: '减少动效' })
      await motion.click()
      await expect(motion).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true')

      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('settings-appearance-light.png') })
    } finally {
      await morrow.close()
    }
  })
})
