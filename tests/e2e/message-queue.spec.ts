/**
 * P0-5 运行中排队与引导：
 * - 运行中输入 Enter 进入队列；
 * - 队列可编辑/删除；
 * - 本轮正常结束后自动发送队首消息；
 * - 「打断并发送」立即停止当前运行并发新消息。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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

function userTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { messages: Array<Record<string, any>> } | null } }
    }).__morrowStore
    const session = store.getState().session
    return (session?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => String(message.displayText ?? message.content?.find((block: any) => block.type === 'text')?.text ?? ''))
  })
}

test('运行中排队：编辑、删除、本轮结束后自动发送', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮完成。', delayMs: 12_000 },
      { text: '排队消息已处理。' },
      { text: '队列清空。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'message-queue', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-queue'),
      ...provider,
      permissionMode: 'auto',
      title: '排队测试'
    })

    await page.locator('.composer-input').fill('第一条任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /正在处理/)
    await expect(page.locator('.composer-send.is-stop')).toBeVisible()

    await page.locator('.composer-input').fill('第二条消息')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.queue-tray')).toBeVisible()
    await expect(page.locator('.queue-tray')).toContainText('第二条消息')

    await page.locator('.composer-input').fill('第三条消息')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.queue-item')).toHaveCount(2)

    // 编辑第二条
    await page.locator('.queue-item').nth(1).getByLabel('编辑这条排队消息').click()
    await page.locator('.queue-input').fill('第三条消息（已修改）')
    await page.locator('.queue-edit-actions').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.queue-tray')).toContainText('第三条消息（已修改）')

    // 删除第一条
    await page.locator('.queue-item').first().getByLabel('删除这条排队消息').click()
    await expect(page.locator('.queue-item')).toHaveCount(1)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('queue-tray-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('queue-tray-light.png') })
    await setThemeViaStore(page, 'dark')

    // 第一轮完成 → 自动发送剩下的排队消息
    await expect(page.getByText('排队消息已处理。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '排队消息运行结束')
    await expect(page.locator('.queue-tray')).toHaveCount(0)
    const texts = await userTexts(page)
    expect(texts).toContain('第一条任务')
    expect(texts).toContain('第三条消息（已修改）')
    expect(texts).not.toContain('第二条消息')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('打断并发送立即停止当前运行并发新消息', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '慢任务开始。', delayMs: 8_000 },
      { text: '新消息已处理。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'message-interrupt', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-interrupt'),
      ...provider,
      permissionMode: 'auto',
      title: '打断发送测试'
    })

    await page.locator('.composer-input').fill('慢任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-send.is-stop')).toBeVisible()

    await page.locator('.composer-input').fill('打断后立即发送这条')
    const interruptButton = page.getByRole('button', { name: '打断当前任务并立即发送' })
    await expect(interruptButton).toBeVisible()
    await interruptButton.click()

    await expect(page.getByText('新消息已处理。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '打断后运行结束')
    const texts = await userTexts(page)
    expect(texts).toContain('慢任务')
    expect(texts).toContain('打断后立即发送这条')
  } finally {
    await morrow.close()
    await mock.close()
  }
})
