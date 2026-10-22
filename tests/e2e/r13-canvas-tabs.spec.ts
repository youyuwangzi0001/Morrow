/** 画布页签：成品页签可关闭、可拖动排序。 */
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

test('画布成品页签支持关闭和拖动排序', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-tabs-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '打开三个成品。',
        toolCalls: [
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 A', content: '<html><body>A</body></html>' } },
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 B', content: '<html><body>B</body></html>' } },
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 C', content: '<html><body>C</body></html>' } }
        ]
      },
      { text: '都打开了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-tabs', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '画布页签测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '打开三个成品。')
    await waitForRunFinished(page, 60_000)

    const titles = page.locator('.canvas-tab-title')
    await expect(titles).toHaveCount(3)
    const tabA = page.locator('.canvas-doc-tab').filter({ hasText: '成品 A' })
    await tabA.locator('.canvas-tab-close').click()
    await expect(page.locator('.canvas-doc-tab').filter({ hasText: '成品 A' })).toHaveCount(0)
    await expect(page.locator('.canvas-tab-title')).toHaveCount(2)

    const tabB = page.locator('.canvas-doc-tab').filter({ hasText: '成品 B' })
    const tabC = page.locator('.canvas-doc-tab').filter({ hasText: '成品 C' })
    await tabC.dragTo(tabB)
    await expect(page.locator('.canvas-tab-title').first()).toHaveText('成品 C')
    await page.screenshot({ path: screenshotPath('r13-canvas-tabs.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
