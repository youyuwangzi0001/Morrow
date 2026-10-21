/**
 * P1-11 粘贴附件：剪贴板图片直接进入 Composer，发送后图片在历史消息中可见。
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

test('粘贴图片到输入框并在历史中显示', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ scripts: [{ text: '收到图片附件。' }] })
  const morrow = await launchMorrow({ name: 'attachment-paste', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-paste'),
      ...provider,
      permissionMode: 'auto',
      title: '粘贴附件测试'
    })

    await page.evaluate(async () => {
      // 用足够大的生成图，确保历史截图能真实展示附件可见性
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 100
      const context = canvas.getContext('2d')!
      const gradient = context.createLinearGradient(0, 0, 160, 100)
      gradient.addColorStop(0, '#1a1d22')
      gradient.addColorStop(0.55, '#3a2f1e')
      gradient.addColorStop(1, '#c8a35a')
      context.fillStyle = gradient
      context.fillRect(0, 0, 160, 100)
      context.fillStyle = '#f0e6d2'
      context.font = '600 28px serif'
      context.fillText('M', 68, 60)
      const blob = await new Promise<Blob | null>((resolveBlob) => canvas.toBlob(resolveBlob, 'image/png'))
      if (!blob) throw new Error('无法生成测试图片')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const file = new File([bytes], 'pasted.png', { type: 'image/png' })
      // 同名同尺寸的两张剪贴板图片不能被去重逻辑误删
      const second = new File([bytes], 'pasted.png', { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(file)
      data.items.add(second)
      const input = document.querySelector('.composer-input') as HTMLTextAreaElement
      input.focus()
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      )
    })

    await expect(page.locator('.composer-file-name')).toHaveCount(2)
    await expect(page.locator('.composer-file-name').first()).toContainText('pasted.png')
    await page.locator('.composer-input').fill('看看这两张图')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('收到图片附件。')).toBeVisible({ timeout: 45_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '粘贴消息完成')

    await expect(page.locator('.message-user-image')).toHaveCount(2)
    await expect(page.locator('.composer-file-name')).toHaveCount(0)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('attachment-paste-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('attachment-paste-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
