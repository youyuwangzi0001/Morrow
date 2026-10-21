/**
 * Composer 底栏布局回归：空间不足时左右两组不能互相压住。
 * 运行：npx playwright test tests/e2e/composer-layout.spec.ts
 */
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test.describe('Composer 底栏', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('窄窗口下左侧按钮不重叠右侧控件，且保持一行', async () => {
    morrow = await launchMorrow({ name: 'composer-layout', waitForSelector: '.composer-bar' })
    const { page, app } = morrow
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore
      store.setState({ onboardingOpen: false })
    })

    const widths = [1400, 1200, 1100, 1000, 940, 900, 860, 820]
    for (const width of widths) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => {
        const win = BrowserWindow.getAllWindows()[0]
        const bounds = win.getBounds()
        win.setBounds({ x: bounds.x, y: bounds.y, width: nextWidth, height: 900 })
      }, width)
      await page.waitForTimeout(200)

      const layout = await page.evaluate(() => {
        const rect = (selector: string): DOMRect | null => {
          const el = document.querySelector(selector)
          return el ? el.getBoundingClientRect() : null
        }
        const left = rect('.composer-bar-left')
        const right = rect('.composer-bar-right')
        const icons = [...document.querySelectorAll('.composer-bar-left > *')].map((el) =>
          el.getBoundingClientRect().toJSON()
        )
        const bar = document.querySelector('.composer-bar')
        return {
          left: left?.toJSON() ?? null,
          right: right?.toJSON() ?? null,
          icons,
          overflow: bar ? bar.scrollWidth - bar.clientWidth : 0
        }
      })

      expect(layout.left, `${width}: 左栏存在`).not.toBeNull()
      expect(layout.right, `${width}: 右栏存在`).not.toBeNull()
      expect(intersects(layout.left!, layout.right!), `${width}: 左右两组不能相交`).toBe(false)
      const leftMid = layout.left!.y + layout.left!.height / 2
      const rightMid = layout.right!.y + layout.right!.height / 2
      expect(Math.abs(leftMid - rightMid), `${width}: 工具条保持同一行`).toBeLessThanOrEqual(1)
      for (const icon of layout.icons) {
        expect(icon.right, `${width}: 图标不能越出左栏`).toBeLessThanOrEqual(layout.left!.x + layout.left!.width + 0.5)
      }
      expect(layout.overflow, `${width}: 底栏不能横向溢出`).toBeLessThanOrEqual(1)
    }

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const bounds = win.getBounds()
      win.setBounds({ x: bounds.x, y: bounds.y, width: 820, height: 900 })
    })
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('composer-narrow-wrap.png') })
  })
})
