/**
 * R12 计划同步：
 * 模型做完后直接收尾、忘记更新 todo 时，内核会在结束前提醒它同步计划；
 * 界面上的计划托盘必须从 0/2 变成 2/2，系统提醒本身不进入可见对话。
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
  readStore,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

const twoSteps = (first: string, second: string) => [
  { text: '搭骨架', status: first },
  { text: '补细节', status: second }
]

test('模型漏更新计划时自动提醒同步，托盘显示完成', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-plan-sync-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先列两步计划。',
        toolCalls: [
          { name: 'todo_write', arguments: { todos: twoSteps('in_progress', 'pending') } },
          { name: 'write_file', arguments: { path: 'note.txt', content: 'ok\n' } }
        ]
      },
      { text: '已经全部做好了。' },
      {
        toolCalls: [{ name: 'todo_write', arguments: { todos: twoSteps('completed', 'completed') } }]
      },
      { text: '计划已同步，全部完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-plan-sync', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '计划同步测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '分两步做一个文件。')
    await waitForRunFinished(page, 90_000)

    const state = await readStore(page)
    expect(state.session?.todos.map((todo) => todo.status)).toEqual(['completed', 'completed'])
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('2/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划完成')
    await expect(page.locator('.transcript-inner')).not.toContainText('[系统检查]')
    await page.screenshot({ path: screenshotPath('r12-plan-sync.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
