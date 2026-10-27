import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, screensDir } from './launch'
import { createDemoSession, dismissOnboarding, setThemeViaStore, waitForStoreReady } from './store'

test('Agent 在小屏、中屏与大屏下无溢出，内容列与画布随视口放大', async () => {
  test.setTimeout(300_000)
  const outDir = join(screensDir, 'matrix')
  mkdirSync(outDir, { recursive: true })
  const morrow = await launchMorrow({ name: 'agent-matrix' })
  const page = morrow.page
  const resize = async (width: number, height: number): Promise<void> => {
    await morrow.app.evaluate(async ({ BrowserWindow }, target) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
      win?.setContentSize(target.width, target.height)
      win?.center()
    }, { width, height })
    await page.waitForTimeout(700)
  }
  const measure = async (): Promise<{
    width: number
    overflow: number
    welcome: number
    transcript: number
    composer: number
    conversation: number
    canvas: number
    terminal: number
    terminalX: number
    terminalRight: number
  }> =>
    page.evaluate(() => {
      const width = (selector: string): number => {
        const el = document.querySelector<HTMLElement>(selector)
        return el ? Math.round(el.getBoundingClientRect().width) : 0
      }
      const rect = (selector: string): { x: number; right: number } => {
        const el = document.querySelector<HTMLElement>(selector)
        if (!el) return { x: 0, right: 0 }
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), right: Math.round(r.right) }
      }
      return {
        width: window.innerWidth,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        welcome: width('.welcome-inner'),
        transcript: width('.transcript-inner'),
        composer: width('.composer'),
        conversation: width('.app-conversation'),
        canvas: width('.canvas-root'),
        terminal: width('.terminal-dock'),
        terminalX: rect('.terminal-dock').x,
        terminalRight: rect('.terminal-dock').right
      }
    })

  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')

    for (const [w, h] of [[1280, 800], [1920, 1080], [3840, 2160]] as const) {
      await resize(w, h)
      const data = await measure()
      expect(data.overflow, `${w} 欢迎页横向溢出`).toBeLessThanOrEqual(2)
      expect(data.welcome, `${w} 欢迎页宽度`).toBeGreaterThanOrEqual(w >= 3000 ? 1100 : 900)
      await page.screenshot({ path: join(outDir, `agent-welcome-${w}.png`) })
    }

    await resize(1280, 800)
    await createDemoSession(page, 'auto', 'Agent 适配检查')
    await page.waitForTimeout(600)
    for (const [w, h] of [[1280, 800], [1920, 1080], [3840, 2160]] as const) {
      await resize(w, h)
      const data = await measure()
      expect(data.overflow, `${w} 对话页横向溢出`).toBeLessThanOrEqual(2)
      expect(data.transcript, `${w} 对话列宽度`).toBeGreaterThanOrEqual(w >= 3000 ? 1000 : 780)
      expect(data.composer, `${w} 输入区宽度`).toBeGreaterThanOrEqual(w >= 3000 ? 1100 : 900)
    }

    // 大屏默认画布自动放宽，但不改变用户保存的默认宽度。
    await resize(3840, 2160)
    await page.getByRole('button', { name: '展开画布' }).click()
    await page.waitForTimeout(400)
    const largeCanvas = await measure()
    expect(largeCanvas.canvas).toBeGreaterThanOrEqual(580)
    expect(largeCanvas.conversation).toBeGreaterThanOrEqual(1000)
    await page.screenshot({ path: join(outDir, 'agent-canvas-3840.png') })

    // 中屏把画布拖到极限时，对话列仍保留可输入宽度。
    await page.locator('.canvas-resizer').dblclick()
    await resize(1280, 800)
    const before = await measure()
    expect(before.canvas).toBe(420)
    const box = await page.locator('.canvas-resizer').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + 2, box!.y + 200)
    await page.mouse.down()
    await page.mouse.move(box!.x - 700, box!.y + 200, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const clamped = await measure()
    expect(clamped.canvas).toBeLessThanOrEqual(490)
    expect(clamped.conversation).toBeGreaterThanOrEqual(550)
    expect(clamped.overflow, '1280 画布极限拖动横向溢出').toBeLessThanOrEqual(2)

    // 终端必须铺满侧栏右侧的整个主区域，并延伸覆盖到右侧画布下方。
    await page.getByRole('button', { name: '打开终端' }).click()
    await resize(3840, 2160)
    await page.waitForTimeout(800)
    const terminal = await measure()
    expect(terminal.terminalX).toBe(243)
    expect(terminal.terminalRight).toBe(terminal.width)
    expect(terminal.terminal).toBe(terminal.width - 243)
    expect(terminal.canvas).toBeGreaterThan(0)
    expect(terminal.overflow, '3840 终端横向溢出').toBeLessThanOrEqual(2)
    await page.screenshot({ path: join(outDir, 'agent-terminal-3840.png') })
  } finally {
    await morrow.close()
  }
})
