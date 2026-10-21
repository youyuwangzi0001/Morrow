/**
 * P1-13 推理强度与费用：
 * - 模型支持推理时输入区出现推理强度选择；
 * - 选择「高」后 provider 请求带 reasoning_effort；
 * - 会话累计费用 > 0，/usage 打开上下文用量页。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  readStore,
  setThemeViaStore,
  waitUntil,
  waitForStoreReady
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('推理强度映射与费用累计', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮回答。' },
      { text: '第二轮回答。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'reasoning-cost', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-reasoning'),
      ...provider,
      permissionMode: 'auto',
      title: '推理与费用测试'
    })

    await expect(page.getByRole('button', { name: '推理强度' })).toBeVisible()
    await page.getByRole('button', { name: '推理强度' }).click()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(page.getByRole('button', { name: '推理强度' })).toContainText('high')

    await page.locator('.composer-input').fill('第一次提问')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('第一轮回答。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第一轮完成')
    expect(mock.requests[0].body.reasoning_effort).toBe('high')

    // 真实运行结束后继续切换 xhigh / max：两档都必须被 IPC 接受，不能出现「推理强度无效」
    const effortNow = (): Promise<string | undefined> =>
      page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        return state.session?.reasoningEffort ?? state.settings.reasoningEffort
      })
    const trigger = page.getByRole('button', { name: '推理强度' })
    await trigger.click()
    await page.getByRole('option', { name: /^xhigh/ }).click()
    await expect(trigger).toContainText('xhigh')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('xhigh')
    await expect(page.locator('.toast-item.toast-error').filter({ hasText: '推理强度无效' })).toHaveCount(0)

    await trigger.click()
    await page.getByRole('option', { name: /^max/ }).click()
    await expect(trigger).toContainText('max')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('max')
    await expect(page.locator('.toast-item.toast-error').filter({ hasText: '推理强度无效' })).toHaveCount(0)

    await trigger.click()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('high')

    await page.locator('.composer-input').fill('第二次提问')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('第二轮回答。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第二轮完成')

    const usage = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.usage ?? null
    })
    expect(usage?.costUsd).toBeGreaterThan(0)
    expect(usage?.inputTokens).toBeGreaterThan(0)

    await page.locator('.composer-input').fill('/usage')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByRole('tab', { name: '上下文' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.st-context')).toContainText('估算费用')
    await expect(page.locator('.st-context')).toContainText('参考价')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    // 打开上下文页时焦点不应落在阈值滑杆上：方向键会误改值，主题切换也会把面板滚走
    await expect(page.locator('.st-range')).not.toBeFocused()
    const cardOffset = (): Promise<number> =>
      page.locator('.st-ctx-card').evaluate((card) => {
        const panel = card.closest('.st-panel') as HTMLElement
        return Math.round(card.getBoundingClientRect().top - panel.getBoundingClientRect().top)
      })
    // 截图聚焦上下文占用与费用卡片，而不是滚动到下方的压缩设置
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      ;(element.closest('.modal-body') as HTMLElement | null)?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    })
    await expect.poll(cardOffset, { message: '费用卡片应位于面板顶部' }).toBeLessThan(40)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await expect.poll(cardOffset, { message: '切换主题后面板不应滚动' }).toBeLessThan(40)
    await page.screenshot({ path: screenshotPath('reasoning-cost-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await expect.poll(cardOffset, { message: '切换主题后面板不应滚动' }).toBeLessThan(40)
    await page.screenshot({ path: screenshotPath('reasoning-cost-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
