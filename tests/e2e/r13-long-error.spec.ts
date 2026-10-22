/**
 * R13 长错误不溢出：
 * 工具错误里带超长无空格路径时，错误块必须换行，且不能把对话区撑出横向滚动。
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
  installEventCollector,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

test('超长工具错误在活动区换行，不产生横向溢出', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-long-error-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const longName = `${'abcdefghij'.repeat(40)}.html`
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我读取这个文件。',
        toolCalls: [{ name: 'read_file', arguments: { path: longName } }]
      },
      { text: '路径不对，我先用 list_dir 找正确文件。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-long-error', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '长错误测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '读取那个文件。')
    await waitForRunFinished(page, 90_000)

    await expect(page.locator('.spine-error-title')).toContainText('路径不存在')
    await page.locator('.spine-error').scrollIntoViewIfNeeded()
    await expect(page.locator('.spine-error')).toBeVisible()
    const overflow = await page.evaluate(() => {
      const pick = (selector: string): HTMLElement | null => document.querySelector(selector)
      const error = pick('.spine-error')
      const detail = pick('.spine-detail')
      const transcript = pick('.transcript-inner')
      return {
        error: error ? error.scrollWidth - error.clientWidth : -1,
        detail: detail ? detail.scrollWidth - detail.clientWidth : -1,
        transcript: transcript ? transcript.scrollWidth - transcript.clientWidth : -1
      }
    })
    expect(overflow.error, JSON.stringify(overflow)).toBeLessThanOrEqual(1)
    expect(overflow.detail, JSON.stringify(overflow)).toBeLessThanOrEqual(1)
    expect(overflow.transcript, JSON.stringify(overflow)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: screenshotPath('r13-long-error.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
