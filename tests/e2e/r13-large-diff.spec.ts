/** 大文件局部修改：diff 摘要必须显示真实增删行，不能退化为 +0/-0。 */
import { mkdirSync, writeFileSync } from 'node:fs'
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

test('大文件局部 edit 显示真实增删行而不是“内容没有变化”', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-large-diff-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const lines = Array.from({ length: 2490 }, (_, index) => `line ${index}`)
  lines[1200] = '.theme-toggle { background: #20261a; }'
  writeFileSync(join(workspace, 'big.css'), `${lines.join('\n')}\n`, 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '修改这一行。',
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'big.css',
              old_string: '.theme-toggle { background: #20261a; }',
              new_string: '.theme-toggle { background: #3a4630; }\ntransition: background .2s ease;'
            }
          }
        ]
      },
      { text: '修改完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-large-diff', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '大文件 diff' })
    await installEventCollector(page)
    await sendMessageViaStore(page, '修改 big.css 里的主题切换颜色。')
    await waitForRunFinished(page, 60_000)

    const summary = page.locator('.message-diff-summary')
    await expect(summary).toHaveCount(1)
    await expect(summary).toContainText('+2')
    await expect(summary).toContainText('−1')
    const assistant = page.locator('.message-assistant').first()
    await assistant.locator('.spine-item').first().click()
    await expect(assistant).not.toContainText('内容没有变化')
    await expect(assistant).toContainText('3a4630')
    await page.screenshot({ path: screenshotPath('r13-large-diff.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
