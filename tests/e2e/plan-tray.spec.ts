/**
 * 计划托盘：运行中显示脉冲与「进行中」，运行结束后未完成步骤保留状态但停止脉冲。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clearEvents,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

const workspace = (): string => {
  const path = join(root, 'tmp', `e2e-plan-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('计划托盘：运行中脉冲，结束后未完成步骤不再闪动', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先把工作拆成两步。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { text: '读取资料', status: 'in_progress' },
                { text: '整理结论', status: 'pending' }
              ]
            }
          }
        ]
      },
      { text: '计划已列好，先读资料。' },
      {
        text: '资料已读完，开始整理结论。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { text: '读取资料', status: 'completed' },
                { text: '整理结论', status: 'in_progress' }
              ]
            }
          }
        ]
      },
      { text: '结论整理中。', delayMs: 8_000 }
    ]
  })
  const morrow = await launchMorrow({ name: 'plan-tray', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sharedWorkspace = workspace()
    const sessionA = await createSession(page, {
      workspace: sharedWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划测试'
    })
    await createSession(page, {
      workspace: sharedWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划旁观 B'
    })
    await page.evaluate(async (id: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().selectSession(id)
    }, sessionA)
    await installEventCollector(page)

    await page.locator('.composer-input').fill('把这件事拆成两步计划。')
    await page.locator('.composer-input').press('Enter')
    await waitForRunFinished(page, 90_000)

    const tray = page.locator('.plan-tray')
    await expect(tray).toBeVisible()
    await expect(tray).toHaveClass(/is-idle/)
    await expect(page.locator('.plan-progress')).toHaveText('0/2')
    await expect(page.locator('.plan-item.is-in_progress')).toContainText('读取资料')
    await expect(page.locator('.plan-item.is-in_progress .plan-item-state')).toHaveText('未完成')
    await expect(page.locator('.plan-item.is-in_progress .sr-only')).toHaveText('未完成，当前任务已停止')
    const idleAnimation = await page.evaluate(
      () => getComputedStyle(document.querySelector('.plan-item.is-in_progress .plan-dot')!).animationName
    )
    expect(idleAnimation).toBe('none')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('plan-tray-idle-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('plan-tray-idle-dark.png') })

    await clearEvents(page)
    await page.locator('.composer-input').fill('继续。')
    await page.locator('.composer-input').press('Enter')
    await waitForRunStarted(page, 30_000)
    await waitUntil(
      async () => {
        const snapshot = await readStore(page)
        const todos = snapshot.session?.todos ?? []
        return todos.some((todo) => todo.status === 'completed') && todos.some((todo) => todo.status === 'in_progress')
      },
      20_000,
      '第二步计划更新'
    )
    await expect(tray).not.toHaveClass(/is-idle/)
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(page.locator('.sb-session').filter({ hasText: '计划测试' }).locator('.sb-session-time')).toHaveText('1/2')
    await expect(page.locator('.plan-running')).toBeVisible()
    await expect(page.locator('.plan-running')).toHaveText('进行中')
    const runningAnimation = await page.evaluate(
      () => getComputedStyle(document.querySelector('.plan-item.is-in_progress .plan-dot')!).animationName
    )
    expect(runningAnimation).toBe('plan-dot-pulse')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: screenshotPath('plan-tray-running-dark.png') })

    const rowA = page.locator('.sb-session').filter({ hasText: '计划测试' }).locator('.sb-session-main')
    const rowB = page.locator('.sb-session').filter({ hasText: '计划旁观 B' }).locator('.sb-session-main')

    // 运行中切到 B，再切回 A：计划应从增量落盘恢复为 1/2，而不是退回 0/2
    await rowB.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== sessionA, 10_000, '切到会话 B')
    await rowA.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '切回会话 A')
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(tray).not.toHaveClass(/is-idle/)

    // 留在 B 等 A 在后台完成：侧栏进度与当前视图都不应串台
    await rowB.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== sessionA, 10_000, '再次切到会话 B')
    await waitForRunFinished(page, 90_000)
    expect((await readStore(page)).activeSessionId).not.toBe(sessionA)
    await expect(rowA.locator('.sb-session-time')).toHaveText('1/2', { timeout: 10_000 })

    await rowA.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '完成后回到会话 A')
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(tray).toHaveClass(/is-idle/)
    await expect(page.locator('.plan-item.is-in_progress .plan-item-state')).toHaveText('未完成')
    await expect(page.locator('.plan-running')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
