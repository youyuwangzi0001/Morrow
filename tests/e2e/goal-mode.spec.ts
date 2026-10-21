/**
 * 目标模式回归：
 * - 无可用模型时建立目标失败，不留下「进行中但不会动」的幽灵目标；
 * - 目标只从 Composer 的 /goal 前缀或目标按钮建立，不再弹出独立对话框；
 * - 暂停会停止当前轮（按钮文案与行为一致）；
 * - 已有目标在别的会话推进时，不能在另一个会话再建目标（渲染层 + 主进程双重拦截）。
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
  installEventCollector,
  readStore,
  setThemeViaStore,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

function getGoal(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { goal?: Record<string, any> | null } | null } }
    }).__morrowStore
    return store.getState().session?.goal ?? null
  })
}

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('目标用输入框 /goal 前缀建立；无可用模型时失败且不留幽灵目标', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'goal-failure', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const model = await page.evaluate(() => {
      const settings = (window as unknown as {
        __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string }> }> } } }
      }).__morrowStore.getState().settings
      const provider = settings.providers.find((item) => item.id === 'deepseek')
      return provider?.models[0] ? { providerId: provider.id, modelId: provider.models[0].id } : null
    })
    expect(model, '内置 DeepSeek 应有可用模型').not.toBeNull()
    await createSession(page, {
      workspace: workspaceAt('e2e-goal-failure'),
      ...model!,
      permissionMode: 'auto',
      title: '无 Key 目标测试'
    })

    // 斜杠命令把输入框切到 /goal 前缀，不再出现独立弹窗
    await page.locator('.composer-input').fill('/goal')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('/goal ')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await expect(page.locator('.transcript-empty-title')).toBeVisible()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('goal-composer-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('goal-composer-light.png') })
    await setThemeViaStore(page, 'dark')

    // 无可用模型：直接提交应失败并保留输入，便于修好后重试
    const objectiveLine = '/goal 测试没有模型密钥时的目标启动。'
    await page.locator('.composer-input').fill(objectiveLine)
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/还没有连接模型/).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.composer-input')).toHaveValue(objectiveLine)
    expect(await getGoal(page)).toBeNull()
    expect((await readStore(page)).run).toBeNull()
  } finally {
    await morrow.close()
  }
})

test('暂停停止当前轮；另一个会话有目标在推进时不能建新目标', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮推进中，等待暂停。', delayMs: 6_000 },
      { text: '第二轮推进中，等待并发互斥检查。', delayMs: 6_000 }
    ]
  })
  const workspace = workspaceAt('e2e-goal-audit')
  const morrow = await launchMorrow({ name: 'goal-audit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionA = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '目标会话 A'
    })
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (objective: string, rounds?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证暂停行为与跨会话互斥。', 3)
    })
    await waitForRunStarted(page, 30_000)

    const pauseButton = page.locator('.goal-bar-actions').getByRole('button', { name: '暂停' })
    await expect(pauseButton).toHaveAttribute('title', /暂停并停止当前轮/)
    await pauseButton.click()
    await waitUntil(async () => (await getGoal(page))?.status === 'paused', 30_000, '目标暂停')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后运行收尾')
    await expect(page.locator('.goal-bar-sub')).toContainText('已暂停 · 自动续跑已停止')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.waitForTimeout(220)
    await page.locator('.goal-bar-toggle').click()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('goal-paused-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('goal-paused-light.png') })
    await setThemeViaStore(page, 'dark')

    // 继续后进入第 2 轮，制造「A 正在推进」的状态
    await page.locator('.goal-bar-actions').getByRole('button', { name: '继续' }).click()
    await waitUntil(async () => (await getGoal(page))?.status === 'active' && (await getGoal(page))?.round === 2, 30_000, '目标继续到第 2 轮')
    await waitForRunStarted(page, 30_000)

    const sessionB = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '目标会话 B'
    })
    const storeError = await page.evaluate(async () => {
      try {
        await (window as unknown as {
          __morrowStore: { getState: () => { startGoal: (objective: string) => Promise<void> } }
        }).__morrowStore.getState().startGoal('B 会话的新目标')
        return ''
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })
    expect(storeError).toMatch(/还有任务在运行|目标正在自动推进/)

    const direct = await page.evaluate(
      async (sessionId) =>
        (window as unknown as {
          morrow: { goal: { start: (input: unknown) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.goal.start({ sessionId, objective: 'B 会话直接 IPC 目标', maxRounds: 2 }),
      sessionB
    )
    expect(direct.ok).toBe(false)
    expect(direct.error?.message ?? '').toMatch(/另一个对话/)

    // 回到 A 结束目标，清理运行
    await page.evaluate(async (sessionId) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } }
      }).__morrowStore
      await store.getState().selectSession(sessionId)
    }, sessionA)
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { stopGoal: () => Promise<void> } }
      }).__morrowStore.getState().stopGoal()
    })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '结束后运行收尾')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('阻塞目标在目标条上可以直接继续', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '遇到阻塞，等待补充。',
        toolCalls: [
          {
            name: 'update_goal',
            arguments: { status: 'blocked', summary: '需要补充数据源', blockedReason: '缺少销售明细表' }
          }
        ]
      },
      { text: '等待用户补充资料。' },
      {
        text: '阻塞已解决，继续推进。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'goal-blocked-done.md', content: '# 阻塞解除\n验收完成\n' } },
          { name: 'update_goal', arguments: { status: 'completed', summary: '补充后完成', evidence: ['goal-blocked-done.md'] } }
        ]
      },
      { text: '目标完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'goal-blocked', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-goal-blocked'),
      ...provider,
      permissionMode: 'auto',
      title: '阻塞目标测试'
    })
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (objective: string) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证阻塞后可继续。')
    })
    await waitUntil(async () => (await getGoal(page))?.status === 'blocked', 60_000, '目标进入阻塞态')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '阻塞后运行收尾')
    await expect(page.locator('.goal-detail-row.is-blocked')).toContainText('缺少销售明细表')
    const resume = page.locator('.goal-bar-actions').getByRole('button', { name: '继续' })
    await expect(resume).toBeVisible()
    await resume.click()
    // 模型可能瞬间跑完，不能只等 active，否则会错过中间态
    await waitUntil(
      async () => {
        const goal = await getGoal(page)
        return goal?.round === 2 && (goal.status === 'active' || goal.status === 'completed') ? goal : null
      },
      60_000,
      '阻塞后继续到第 2 轮'
    )
    await waitUntil(async () => (await getGoal(page))?.status === 'completed', 30_000, '继续后完成目标')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '完成后运行收尾')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('结束目标不会中止暂停期间发出的普通聊天', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮目标推进中。', delayMs: 5_000 },
      { text: '普通聊天完成。', delayMs: 1_500 }
    ]
  })
  const morrow = await launchMorrow({ name: 'goal-stop-chat', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-goal-stop-chat'),
      ...provider,
      permissionMode: 'auto',
      title: '结束目标聊天测试'
    })
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (objective: string) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证结束目标不影响普通聊天。')
    })
    await waitForRunStarted(page, 30_000)
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { pauseGoal: () => Promise<void> } }
      }).__morrowStore.getState().pauseGoal()
    })
    await waitUntil(async () => (await getGoal(page))?.status === 'paused', 30_000, '目标暂停')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后运行收尾')

    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } }
      }).__morrowStore.getState().sendMessage('现在只是普通聊天。')
    })
    await waitForRunStarted(page, 30_000)
    await page.locator('.goal-bar-actions').getByRole('button', { name: '结束目标' }).click()
    await page.locator('.modal-panel').getByRole('button', { name: '结束目标' }).click()
    await waitUntil(async () => (await getGoal(page))?.status === 'cancelled', 30_000, '目标结束')
    // 普通聊天应继续并正常出结果（旧实现会 abort 整个会话）
    await expect(page.getByText('普通聊天完成。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '普通聊天完成')
  } finally {
    await morrow.close()
    await mock.close()
  }
})
