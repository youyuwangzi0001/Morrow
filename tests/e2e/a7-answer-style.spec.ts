/**
 * A7：全局回答风格。
 * - 设置里的选择写入真实设置，并进入所有新回答的 system prompt；
 * - 侧边聊天同样遵守；
 * - 自定义偏好可保存、重置。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screensDir, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  readStore,
  waitForStoreReady,
  waitUntil
} from './store'

function systemText(body: Record<string, any> | undefined): string {
  if (!body) return ''
  if (typeof body.system === 'string') return body.system
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message: { role?: string }) => message.role === 'system')
    .map((message: { content?: unknown }) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
}

test.describe('全局回答风格', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('预设与自定义风格进入主对话和侧边聊天，并可恢复默认', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      respond: (ctx: { body?: unknown }) => {
        const raw = JSON.stringify(ctx.body ?? {})
        if (raw.includes('侧边聊天')) return { text: '侧边风格答复。', chunkDelayMs: 3 }
        return { text: '主对话风格答复。', chunkDelayMs: 3 }
      }
    })
    const workspace = join(root, 'tmp', `e2e-a7-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'a7-answer-style', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '回答风格测试'
    })

    const openStyleTab = async (): Promise<void> => {
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openSettings()
      })
      await page.locator('#st-tab-style').click()
      await expect(page.locator('.st-style-card')).toHaveCount(5)
    }
    const closeSettings = async (): Promise<void> => {
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .closeSettings()
      })
      await expect(page.locator('.st-style')).toBeHidden()
    }
    const sendAndWait = async (text: string, expectedMessages: number): Promise<void> => {
      await page.locator('.composer-input').fill(text)
      await page.locator('.composer-input').press('Enter')
      await waitUntil(
        async () => (await readStore(page)).run === null && (await readStore(page)).session?.messages.length === expectedMessages,
        60_000,
        `第 ${expectedMessages / 2} 轮回答完成`
      )
    }

    // 1. 选择「简洁」
    await openStyleTab()
    await page.locator('.st-style-card').filter({ hasText: '简洁' }).click()
    await expect(page.locator('.st-style-card').filter({ hasText: '简洁' })).toHaveAttribute('aria-checked', 'true')
    const conciseSettings = await page.evaluate(async () => window.morrow.settings.get())
    expect(conciseSettings.ok).toBe(true)
    if (conciseSettings.ok) expect(conciseSettings.data.answerStyle).toBe('concise')
    await closeSettings()
    await sendAndWait('第一问：先给结论。', 2)

    // 2. 选择自定义并保存偏好
    await openStyleTab()
    await page.locator('.st-style-card').filter({ hasText: '自定义' }).click()
    const customText = '像给同事讲方案：先给结论，再列两条依据；不要客套话。'
    await page.locator('#st-answer-style-custom').fill(customText)
    await page.getByRole('button', { name: '保存偏好' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'custom' && result.data.answerStyleCustom === customText
    }, 15_000, '自定义风格保存')
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a7-answer-style.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a7-answer-style-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await closeSettings()
    await sendAndWait('第二问：按自定义风格回答。', 4)

    // 3. 侧边聊天也使用自定义风格
    await page.locator('.composer-input').fill('/btw 用一句话总结这个项目')
    await page.locator('.composer-input').press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('侧边风格答复。')).toBeVisible({ timeout: 30_000 })

    const requestFor = (needle: string): Record<string, any> | undefined =>
      mock.requests.find((request: { body?: unknown }) => JSON.stringify(request.body ?? {}).includes(needle))?.body
    const firstMain = systemText(requestFor('第一问：先给结论。'))
    const secondMain = systemText(requestFor('第二问：按自定义风格回答。'))
    const side = systemText(requestFor('侧边聊天'))
    expect(firstMain).toContain('当前风格：简洁')
    expect(firstMain).toContain('1–3 句')
    expect(secondMain).toContain('当前风格：自定义')
    expect(secondMain).toContain(customText)
    expect(side).toContain('当前风格：自定义')
    expect(side).toContain(customText)

    // 4. 清空自定义偏好仍可保存：留空时回落到平衡规则
    await drawer.getByRole('button', { name: '关闭侧边聊天' }).click()
    await openStyleTab()
    const customField = page.locator('#st-answer-style-custom')
    await expect(customField).toHaveValue(customText)
    await customField.fill('')
    await page.getByRole('button', { name: '保存偏好' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'custom' && result.data.answerStyleCustom === ''
    }, 15_000, '清空自定义偏好')

    // 5. 恢复默认
    await page.getByRole('button', { name: '恢复默认' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'balanced' && result.data.answerStyleCustom === ''
    }, 15_000, '恢复默认风格')
    await expect(page.locator('.st-style-card').filter({ hasText: '平衡' })).toHaveAttribute('aria-checked', 'true')
  })
})
