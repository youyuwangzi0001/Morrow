/** 输入框上下文环：顶栏入口已移除、实时 token 详情、双主题。 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

test('上下文入口在输入框内，顶栏已移除，点击后展示上下文与 token 详情', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-context-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '这是用于产生 token 用量的回答。' }] })
  const morrow = await launchMorrow({ name: 'r13-context', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '上下文详情测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '简单回答一句。')
    await waitForRunFinished(page, 60_000)
    await expect(page.locator('.tb-ctx')).toHaveCount(0)
    await expect(page.locator('.composer-bar .composer-ctx')).toHaveCount(1)
    const meter = page.locator('.composer-ctx-ring')
    await expect(meter).toBeVisible()
    const meterBox = await meter.boundingBox()
    const inputBox = await page.locator('.composer-input').boundingBox()
    expect(meterBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(meterBox!.y).toBeGreaterThan(inputBox!.y)
    await meter.click()
    const popover = page.getByRole('dialog', { name: '上下文与 Token 使用' })
    await expect(popover).toBeVisible()
    const popBox = await popover.boundingBox()
    expect(popBox).not.toBeNull()
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(inputBox!.y - 4)
    expect(Math.abs(popBox!.x - meterBox!.x)).toBeLessThanOrEqual(16)
    const topmost = await page.evaluate(() => {
      const el = document.querySelector('.composer-ctx-pop')
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { inside: top ? el.contains(top) : false, topClass: top?.className ?? '' }
    })
    expect(topmost?.inside, JSON.stringify(topmost)).toBe(true)
    await expect(popover).toContainText('上下文')
    await expect(popover).toContainText('输入')
    await expect(popover).toContainText('其中缓存')
    await expect(popover).toContainText('缓存命中率')
    await expect(popover).toContainText('输出')
    await page.waitForTimeout(220)
    await page.screenshot({ path: screenshotPath('r13-context-meter-dark.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(350)
    await expect(popover).toBeVisible()
    await page.screenshot({ path: screenshotPath('r13-context-meter-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
