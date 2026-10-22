/**
 * R13 真实进度：
 * 计划已全部标完成、模型却继续改文件时，托盘不能继续显示「计划完成」；
 * 内核会追加真实的「收尾完善」步骤，界面进度与实际工作保持一致。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

test('计划完成后继续打磨时追加收尾步骤，不虚报全部完成', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-plan-finishing-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        toolCalls: [
          {
            name: 'todo_write',
            arguments: { todos: [{ text: '交付页面', status: 'completed' }] }
          }
        ]
      },
      {
        toolCalls: [{ name: 'write_file', arguments: { path: 'page.html', content: '<h1>v1</h1>\n' } }]
      },
      { delayMs: 1800, text: '继续打磨视觉细节。' },
      { text: '收尾工作尚未结束。' },
      { text: '本轮先到这里。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-plan-finishing', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '收尾进度测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把页面继续完善好。')

    await expect(page.locator('.plan-tray')).toContainText('收尾完善', { timeout: 60_000 })
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划')
    await expect(page.locator('.plan-tray .plan-title')).not.toHaveText('计划完成')

    await waitForRunFinished(page, 90_000)
    const state = await readStore(page)
    expect(state.session?.todos.map((todo) => [todo.text, todo.status])).toEqual([
      ['交付页面', 'completed'],
      ['收尾完善', 'in_progress']
    ])
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划')
    await expect(page.locator('.plan-tray .plan-item-state')).toHaveText('未完成')
    expect(readFileSync(join(workspace, 'page.html'), 'utf8')).toContain('v1')
    await page.screenshot({ path: screenshotPath('r13-plan-finishing.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
