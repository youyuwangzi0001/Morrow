/**
 * R12 阶段式分叉/回退：
 * - 每完成一个计划步骤只出现一个阶段节点，中间模型步骤不显示分叉/回退；
 * - 新建文件也显示 diff 增删行；
 * - 回退到阶段节点：保留该阶段对话，撤销其后的文件改动与对话。
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
  setThemeViaStore,
  waitUntil,
  waitForRunFinished,
  waitForStoreReady
} from './store'

const todos = (first: string, second: string) => [
  { text: '搭骨架', status: first },
  { text: '补细节', status: second }
]

test('阶段节点只在计划步骤完成时出现，回退保留阶段边界', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-stages-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先拆成两步。',
        toolCalls: [{ name: 'todo_write', arguments: { todos: todos('in_progress', 'pending') } }]
      },
      {
        text: '第一步完成。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'plan.html', content: '<h1>计划</h1>\n<p>骨架</p>\n' } },
          { name: 'todo_write', arguments: { todos: todos('completed', 'in_progress') } }
        ]
      },
      {
        text: '第二步完成。',
        toolCalls: [
          { name: 'edit_file', arguments: { path: 'plan.html', old_string: '骨架', new_string: '完整骨架' } },
          { name: 'todo_write', arguments: { todos: todos('completed', 'completed') } }
        ]
      },
      { text: '两步都完成了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-stages', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '阶段节点测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '按两步做一个计划页面。')
    await waitForRunFinished(page, 90_000)

    // 两个计划步骤各一个阶段节点；中间那条只有 todo_write 的模型步骤没有操作行
    await expect(page.locator('.message-stage-node')).toHaveCount(2)
    await expect(page.locator('.message-stage-node').first()).toContainText('完成：搭骨架')
    const firstStep = page.locator('.message-assistant').filter({ hasText: '先拆成两步。' })
    await expect(firstStep.locator('.message-meta')).toHaveCount(0)

    // 新建文件也显示 diff：+2 −0
    const diffs = page.locator('.message-diff-summary')
    await expect(diffs).toHaveCount(2)
    await expect(diffs.first()).toContainText('+2')
    await expect(diffs.first()).toContainText('−0')
    await expect(diffs.first()).toContainText('plan.html')

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.locator('.message-stage-node').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('r12-stages-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-stages-light.png') })
    await setThemeViaStore(page, 'dark')

    // 回退到第一个阶段：保留边界消息，文件回到该阶段完成时的内容
    const firstStage = page
      .locator('.message-assistant')
      .filter({ has: page.locator('.message-stage-node') })
      .first()
    await firstStage.getByRole('button', { name: '回退到这个阶段完成时' }).click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.getByText('对话和文件会一起回到这个阶段完成时。这一步不能撤销。')).toBeVisible()
    await expect(page.getByText(/保留这个阶段，移除其后的 2 条对话/)).toBeVisible()
    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这个阶段完成时/)).toBeVisible({ timeout: 15_000 })

    expect(readFileSync(join(workspace, 'plan.html'), 'utf8')).toBe('<h1>计划</h1>\n<p>骨架</p>\n')
    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.session?.messages.length === 3 &&
          state.session.todos?.length === 2 &&
          state.session.todos[0].status === 'completed' &&
          state.session.todos[1].status === 'in_progress'
          ? true
          : null
      },
      20_000,
      '阶段对话与计划已恢复'
    )
    await expect(page.locator('.message-stage-node')).toHaveCount(1)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
