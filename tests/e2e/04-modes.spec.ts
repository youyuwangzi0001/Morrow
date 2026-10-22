/**
 * 合并自 7 个 E2E spec：goal-mode.spec.ts、plan-mode.spec.ts、plan-tray.spec.ts、r6-goal.spec.ts、r8-mode.spec.ts、permission-rules.spec.ts、agent-rules.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clearEvents, clickPermissionCard, configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForPermission, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil } from './store'

// ── 原文件：goal-mode.spec.ts ──────────────────────────────────────────────
test.describe('goal-mode.spec.ts', () => {
/**
 * 目标模式回归：
 * - 无可用模型时建立目标失败，不留下「进行中但不会动」的幽灵目标；
 * - 目标只从 Composer 的 /goal 前缀或目标按钮建立，不再弹出独立对话框；
 * - 暂停会停止当前轮（按钮文案与行为一致）；
 * - 已有目标在别的会话推进时，不能在另一个会话再建目标（渲染层 + 主进程双重拦截）。
 */

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

})

// ── 原文件：plan-mode.spec.ts ──────────────────────────────────────────────
test.describe('plan-mode.spec.ts', () => {
/**
 * P0-2 计划模式 E2E：
 * - /plan 进入计划模式并生成计划卡（只读工具运行，不写文件）；
 * - 拒绝 → 重新规划 → 生成修订版计划；
 * - 批准 → 自动切执行、写入 todo 与产物，完成后计划标记 completed 且持久化。
 */

function getPlan(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { plan?: Record<string, any> | null; planMode?: boolean } | null } }
    }).__morrowStore
    return store.getState().session?.plan ?? null
  })
}

function getPlanMode(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { planMode?: boolean } | null } }
    }).__morrowStore
    return store.getState().session?.planMode === true
  })
}

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

const planV1 = {
  title: '整理销售数据并生成报告',
  summary: '读取 in/sales.csv，核对总额，再生成一份可直接分享的报告。',
  steps: [
    { text: '读取 in/sales.csv 并核对总销售额' },
    { text: '按月份汇总并检查异常值' },
    { text: '生成 out/report.md 并在画布打开' }
  ],
  risks: '如果 CSV 缺少月份列，需要先向用户确认口径。'
}

const planV2 = {
  title: '先出 Markdown 摘要，再生成报告',
  summary: '按用户意见先输出 Markdown 摘要，确认后再生成完整报告。',
  steps: [
    { text: '读取 in/sales.csv 并核对总销售额' },
    { text: '输出 out/summary.md 月度摘要' },
    { text: '生成 out/report.md 完整报告' }
  ]
}

test('计划模式：/plan 生成 → 拒绝 → 修订 → 批准执行并持久化', async () => {
  test.setTimeout(240_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '我先看一下工作区。', toolCalls: [{ name: 'submit_plan', arguments: planV1 }] },
      { text: '计划已就绪，等待你的批准。' },
      { text: '按你的意见重做计划。', toolCalls: [{ name: 'submit_plan', arguments: planV2 }] },
      { text: '修订后的计划已就绪。' },
      {
        text: '开始执行。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step) => ({ text: step.text, status: 'pending' }))
            }
          },
          {
            name: 'write_file',
            arguments: {
              path: 'out/report.md',
              content: '# 销售报告\n\n总销售额：100\n'
            }
          }
        ]
      },
      {
        text: '先完成前两步，第三步还需要一次运行。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step, index) => ({
                text: step.text,
                status: index < 2 ? 'completed' : 'pending'
              }))
            }
          }
        ]
      },
      { text: '前两步完成，继续执行第三步。' }
    ]
  })
  const workspace = workspaceAt('e2e-plan-mode')
  const morrow = await launchMorrow({ name: 'plan-mode', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划模式测试'
    })

    // 1) /plan + 任务：先给出提示并保留输入；发送带任务的 /plan 后进入计划模式
    await page.locator('.composer-input').fill('/plan')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('/plan ')
    expect(await getPlanMode(page)).toBe(false)
    await page.locator('.composer-input').fill('/plan 帮我整理这个季度的销售数据并生成报告')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => getPlanMode(page), 30_000, '进入计划模式')
    await waitUntil(async () => {
      const plan = await getPlan(page)
      return plan?.status === 'pending' ? plan : null
    }, 60_000, '生成待批准计划')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '计划生成运行结束')

    const planCard = page.locator('.plan-card')
    await expect(planCard).toBeVisible()
    await expect(planCard).toContainText('整理销售数据并生成报告')
    await expect(planCard).toContainText('读取 in/sales.csv')
    await expect(page.locator('[aria-label="退出计划模式"]')).toBeVisible()
    expect(existsSync(join(workspace, 'out', 'report.md'))).toBe(false)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('plan-card-pending-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('plan-card-pending-light.png') })
    await setThemeViaStore(page, 'dark')

    // 2) 拒绝并留下原因
    await planCard.getByRole('button', { name: '拒绝' }).click()
    await planCard.locator('.plan-card-input').fill('先不要直接生成 HTML，先给 Markdown 摘要。')
    await planCard.getByRole('button', { name: '确认拒绝' }).click()
    await waitUntil(async () => (await getPlan(page))?.status === 'rejected', 15_000, '计划被拒绝')
    await expect(planCard).toContainText('你的反馈：先不要直接生成 HTML')
    expect(await getPlanMode(page)).toBe(true)

    // 3) 重新规划：带修改意见启动一轮，收到修订版计划
    await planCard.getByRole('button', { name: '重新规划' }).click()
    await planCard.locator('.plan-card-input').fill('改成先输出 Markdown 摘要，再生成完整报告。')
    await planCard.getByRole('button', { name: '重新规划' }).click()
    await waitUntil(async () => {
      const plan = await getPlan(page)
      return plan?.status === 'pending' && plan.title === planV2.title ? plan : null
    }, 60_000, '生成修订版计划')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '修订运行结束')
    await expect(planCard).toContainText('先出 Markdown 摘要')

    // 4) 只读权限下批准应被明确拦下，计划保持待批准
    await page.evaluate(async (id) => {
      await window.morrow.session.setPermissionMode(id, 'read-only')
    }, sessionId)
    await planCard.getByRole('button', { name: '执行计划' }).click()
    await expect(page.getByText(/当前权限是「只读」/)).toBeVisible()
    expect((await getPlan(page))?.status).toBe('pending')
    expect(await getPlanMode(page)).toBe(true)
    await page.evaluate(async (id) => {
      await window.morrow.session.setPermissionMode(id, 'auto')
    }, sessionId)

    // 5) 批准：自动切执行，写入 todo + 产物；子集完成不能把计划判为完成
    await planCard.getByRole('button', { name: '执行计划' }).click()
    await waitUntil(async () => !(await getPlanMode(page)), 15_000, '批准后退出计划模式')
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.session?.todos.length === planV2.steps.length ? state.session.todos : null
    }, 30_000, '批准后建立 todos')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮执行结束')
    expect((await getPlan(page))?.status).toBe('executing')
    await expect(planCard).toContainText('继续执行')
    expect((await readStore(page)).session?.todos.filter((todo) => todo.status === 'completed')).toHaveLength(2)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.screenshot({ path: screenshotPath('plan-card-incomplete-dark.png') })

    const planRequestNames = (
      (mock.requests[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name)
    const executionRequestNames = (
      (mock.requests[4].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name)

    // 手动「继续执行」：重新提供完成剩余步骤的剧本（第一轮结束时的 todo 对账已用尽原剧本）。
    mock.reset([
      {
        text: '继续执行最后一步。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step) => ({ text: step.text, status: 'completed' }))
            }
          }
        ]
      },
      { text: '执行完成，产物在 out/report.md。' }
    ])
    await planCard.getByRole('button', { name: '继续执行' }).click()
    await waitUntil(async () => (await getPlan(page))?.status === 'completed', 60_000, '继续执行后计划完成')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '执行运行结束')

    expect(existsSync(join(workspace, 'out', 'report.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'out', 'report.md'), 'utf8')).toContain('销售报告')
    const finalTodos = (await readStore(page)).session?.todos ?? []
    expect(finalTodos).toHaveLength(planV2.steps.length)
    expect(finalTodos.every((todo) => todo.status === 'completed')).toBe(true)
    await expect(planCard).toContainText('已完成')
    await page.screenshot({ path: screenshotPath('plan-card-complete-dark.png') })

    // 6) 持久化：重新加载会话后计划与状态仍在
    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.plan?.status).toBe('completed')
    expect(loaded?.plan?.title).toBe(planV2.title)
    expect(loaded?.planMode === true).toBe(false)

    // 模型请求：计划请求只暴露只读/计划工具，执行请求恢复写入工具
    expect(planRequestNames).toContain('submit_plan')
    expect(planRequestNames).not.toContain('write_file')
    expect(executionRequestNames).toContain('write_file')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：plan-tray.spec.ts ──────────────────────────────────────────────
test.describe('plan-tray.spec.ts', () => {
/**
 * 计划托盘：运行中显示脉冲与「进行中」，运行结束后未完成步骤保留状态但停止脉冲。
 */

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
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-item.is-in_progress')).toContainText('整理结论')
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
    // 第一轮的对账已用尽剧本；第二段重新提供「进行中 + 延迟」剧本，验证运行态与后台切换。
    mock.reset([
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
    ])
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

})

// ── 原文件：r6-goal.spec.ts ──────────────────────────────────────────────
test.describe('r6-goal.spec.ts', () => {
/**
 * R6：Goal 模式（多轮续跑 + update_goal + 暂停/继续/结束）与画布拖动调宽。
 * 运行：npx playwright test tests/e2e/r6-goal.spec.ts
 */

function readDeepSeekKey(): string {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return (raw.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9_\-]+)/) ?? [])[1] ?? ''
  } catch {
    return ''
  }
}

async function getGoal(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => (window as unknown as {
    __morrowStore: { getState: () => { session: { goal?: Record<string, any> | null } | null } }
  }).__morrowStore.getState().session?.goal ?? null)
}

async function createSessionWithModel(
  page: Page,
  model: { providerId: string; modelId: string }
): Promise<{ sessionId: string; workspace: string }> {
  return page.evaluate(async (modelRef) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const workspace = await window.morrow.workspace.createDemo()
    if (!workspace.ok) throw new Error('createDemo 失败')
    const created = await window.morrow.session.create({
      workspace: workspace.data.path,
      model: modelRef,
      permissionMode: 'auto',
      title: 'Goal E2E'
    })
    if (!created.ok) throw new Error('session.create 失败')
    await store.getState().selectSession(created.data.id)
    return { sessionId: created.data.id, workspace: workspace.data.path }
  }, model)
}

test.describe('R6 Goal 模式 / 画布调宽', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('画布左缘拖动调宽：香槟金落点线、持久化、双击复位', async () => {
    morrow = await launchMorrow({ name: 'r6-canvas', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    await page.waitForTimeout(300)
    const before = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { canvasWidth: number } }
    }).__morrowStore.getState().canvasWidth)
    expect(before).toBe(420)
    const box = await page.locator('.canvas-resizer').boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + 200
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX - 300, startY, { steps: 8 })
    await expect(page.locator('.resize-line')).toBeVisible()
    const during = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { canvasWidth: number } }
    }).__morrowStore.getState().canvasWidth)
    expect(during).toBeGreaterThan(680)
    await page.screenshot({ path: screenshotPath('r6-final-canvas-resizing.png') })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const state = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return { canvasWidth: s.canvasWidth, setting: s.settings.canvasWidth }
    })
    expect(state.canvasWidth).toBeGreaterThan(680)
    expect(state.setting).toBe(state.canvasWidth)
    await page.locator('.canvas-resizer').dblclick()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { canvasWidth: number } }
    }).__morrowStore.getState().canvasWidth)).toBe(420)
    await page.screenshot({ path: screenshotPath('r6-final-canvas-wide.png') })
  })

  test('Mock LLM：目标多轮续跑（round 1 active → round 2 completed）', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        {
          text: '第 1 轮：写入产物并记录推进摘要。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'goal-part1.md', content: '# Round 1\n骨架完成\n' } },
            { name: 'update_goal', arguments: { status: 'active', summary: '第 1 轮完成：写出 goal-part1.md', nextStep: '第 2 轮补充 goal-part2.md 并验收' } }
          ]
        },
        { text: '第 1 轮结束，等待系统续跑。' },
        {
          text: '第 2 轮：写入收尾产物并标记完成。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'goal-part2.md', content: '# Round 2\n验收完成\n' } },
            { name: 'update_goal', arguments: { status: 'completed', summary: '两轮全部完成，goal-part1.md 与 goal-part2.md 已写入并验收', evidence: ['goal-part1.md', 'goal-part2.md'] } }
          ]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'r6-goal-mock', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('分两轮完成一份验证目标模式的笔记，每轮只推进一个阶段。', 3))
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal && (goal.status === 'completed' || goal.status === 'blocked' || goal.status === 'paused') ? goal : null
      }, 90_000, '目标进入终态')
      const goal = await getGoal(page)
      expect(goal?.status).toBe('completed')
      expect(goal?.round).toBe(2)
      const events = await getEvents(page)
      const goalEvents = events.filter((event) => event.type === 'goal_updated')
      expect(goalEvents.length).toBeGreaterThanOrEqual(2)
      expect(events.some((event) => event.type === 'tool_started' && (event as any).block?.name === 'update_goal')).toBe(true)
      expect(events.filter((event) => event.type === 'tool_finished' && JSON.stringify((event as any).result).includes('目标状态已更新')).length).toBeGreaterThanOrEqual(2)
      const state = await readStore(page)
      expect(state.run).toBeNull()
      await page.screenshot({ path: screenshotPath('r6-final-goal-mock-completed.png') })
    } finally {
      await mock.close()
    }
  })

  test('Mock LLM：暂停/继续/结束的终态不被旧 run 覆盖', async () => {
    test.setTimeout(120_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '先暂停我。', delayMs: 4000 },
        {
          text: '继续后完成目标。',
          toolCalls: [{ name: 'update_goal', arguments: { status: 'completed', summary: '恢复后已完成' } }]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'r6-goal-pause', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证暂停与继续。', 3))
      await waitForRunStarted(page, 30_000)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { pauseGoal: () => Promise<void> } }
      }).__morrowStore.getState().pauseGoal())
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal?.status === 'paused' ? goal : null
      }, 30_000, '目标暂停')
      await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后 run 收尾')
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { resumeGoal: () => Promise<void> } }
      }).__morrowStore.getState().resumeGoal())
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal?.status === 'active' && goal.round === 2 ? goal : null
      }, 60_000, '继续后进入第 2 轮')
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { stopGoal: () => Promise<void> } }
      }).__morrowStore.getState().stopGoal())
      await page.waitForTimeout(1500)
      const afterStop = await getGoal(page)
      // 手动「结束目标」是取消，不是完成；且旧 run 迟到回调必须保持 cancelled
      expect(afterStop?.status).toBe('cancelled')
    } finally {
      await mock.close()
    }
  })

  test('真实 DeepSeek：目标模式多轮续跑并产出文件', async () => {
    test.setTimeout(300_000)
    const key = readDeepSeekKey()
    test.skip(!key, '本机没有 DeepSeek Key')
    morrow = await launchMorrow({ name: 'r6-goal-live', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const saved = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const provider = store.getState().settings.providers.find((p: any) => p.id === 'deepseek')
      return window.morrow.settings.saveProvider({ config: provider, apiKey })
    }, key)
    expect(saved.ok).toBe(true)
    const model = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { settings: { defaultModel: Record<string, any> } } }
    }).__morrowStore.getState().settings.defaultModel)
    const { workspace } = await createSessionWithModel(page, model as { providerId: string; modelId: string })
    const objective = [
      '分两轮完成目标模式验收文件，每轮只推进一个阶段：',
      '第 1 轮：在工作区创建 goal-round1.md，写三条「目标模式是什么」的要点；完成后调用 update_goal(status=active, summary=第1轮完成, nextStep=第2轮创建 goal-round2.md)，然后结束本轮，不要继续写第二个文件。',
      '第 2 轮：创建 goal-round2.md，写三条可人工检查的验收项；完成后调用 update_goal(status=completed, summary=两轮完成, evidence=["goal-round1.md","goal-round2.md"])。',
      '不要创建其他文件；两个文件都用简体中文。'
    ].join('\n')
    await page.evaluate((text) => (window as unknown as {
      __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
    }).__morrowStore.getState().startGoal(text, 3), objective)
    await waitUntil(async () => {
      const goal = await getGoal(page)
      return goal && ['completed', 'blocked', 'paused'].includes(goal.status) ? goal : null
    }, 240_000, '真实目标进入终态')
    const goal = await getGoal(page)
    console.log('LIVE_GOAL', JSON.stringify(goal))
    expect(goal?.status).toBe('completed')
    expect(goal?.round).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(workspace, 'goal-round1.md'))).toBe(true)
    expect(existsSync(join(workspace, 'goal-round2.md'))).toBe(true)
    const events = await getEvents(page)
    expect(events.some((event) => event.type === 'goal_updated')).toBe(true)
    await page.waitForTimeout(800)
    await page.screenshot({ path: screenshotPath('r6-final-goal-live-completed.png') })
  })
})

})

// ── 原文件：r8-mode.spec.ts ──────────────────────────────────────────────
test.describe('r8-mode.spec.ts', () => {
/**
 * R8 #5 显式「聊天 / 工作」模式 E2E —— 真实 Electron + 真实主进程 + 真实工具执行，LLM 用本地 mock。
 *
 * 验收（审计报告第 5 项）：
 * 1. 同一句「帮我改文件」在聊天模式：模型**即使硬发 write_file**也被内核硬拦截（denied）、
 *    文件不变、不弹审批、助手解释/询问是否切换工作模式；下发给模型的工具列表本身不含写入/执行工具。
 * 2. 切到工作模式后同一句：工具真实执行、文件真实写入。
 * 3. 运行中切换模式被拒绝并提示先停止（不会带着工作模式能力继续）。
 * 4. 聊天模式下 Goal 入口在 UI 中不可用，IPC `goal.start` 也被主进程拒绝（不是只隐藏按钮）。
 * 5. 模式写入会话文件，关闭应用后用同一 data-dir 重启仍保持聊天模式。
 *
 * 所有断言都落在四层证据上：运行时事件 / store 状态 / DOM / 磁盘文件。
 */

const WORKSPACE_FILE = 'mode-note.md'
const USER_ASK = '帮我修改 mode-note.md，把内容改成 CHANGED。'

type SessionMode = 'work' | 'chat'

async function sessionMode(page: Page): Promise<SessionMode> {
  return page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const mode = store.getState().session?.mode
    return mode === 'chat' ? 'chat' : 'work'
  })
}

async function waitMode(page: Page, mode: SessionMode, timeoutMs = 20_000): Promise<void> {
  await waitUntil(async () => ((await sessionMode(page)) === mode ? true : null), timeoutMs, `会话模式变为 ${mode}`)
}

/** 注册指向本地 mock 的 provider（test-mode 下 127.0.0.1 允许无 Key） */
async function saveMockProvider(page: Page, baseUrl: string): Promise<{ providerId: string; modelId: string }> {
  return page.evaluate(
    async (url: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const config = {
        id: 'mock-r8-mode',
        kind: 'openai-compat',
        name: '本地 Mock (R8 模式)',
        baseUrl: url,
        models: [{ id: 'mock-model', label: 'Mock Model', contextWindow: 32_000, supportsTools: true }],
        apiKeyStored: false,
        enabled: true
      }
      await store.getState().saveProvider({ config })
      const saved = (store.getState().settings.providers as Array<Record<string, any>>).find(
        (provider) => provider.id === config.id
      )
      if (!saved) throw new Error('mock provider 保存失败')
      return { providerId: config.id, modelId: 'mock-model' }
    },
    baseUrl
  )
}

async function createModeSession(
  page: Page,
  arg: { workspace: string; providerId: string; mode: SessionMode }
): Promise<string> {
  return page.evaluate(async (input: typeof arg) => {
    const created = await window.morrow.session.create({
      workspace: input.workspace,
      model: { providerId: input.providerId, modelId: 'mock-model' },
      permissionMode: 'auto',
      mode: input.mode,
      title: 'R8 模式测试'
    })
    if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().selectSession(created.data.id)
    return created.data.id
  }, arg)
}

test.describe('R8 #5 显式聊天 / 工作模式', () => {
  test('chat 硬拦截写入（文件不变）→ 切 work 真实写入 → 运行中拒绝切换 → Goal 不可用 → 重启保持', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r8-mode-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'hello', 'utf8')
    const dataDir = join(root, 'tmp', `r8-mode-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r8-mode-chromium-${stamp}`)

    // 记录每次请求下发给模型的工具列表：chat 下必须不含写入/执行工具
    const requests: Array<{ toolNames: string[]; lastUserText: string }> = []
    const mock = await startMockLLM({
      respond: (ctx) => {
        const toolNames = ((ctx.body?.tools ?? []) as Array<Record<string, any>>)
          .map((tool) => String(tool?.function?.name ?? tool?.name ?? ''))
          .filter(Boolean)
        requests.push({ toolNames, lastUserText: String(ctx.lastUserMessageText ?? '') })
        const step = requests.length - 1
        if (step === 0) {
          // 聊天模式第一回合：故意硬发 write_file（工具列表里并没有它），验证权限层硬拦截
          return {
            text: '我先看一下这个文件。',
            toolCalls: [{ name: 'write_file', arguments: { path: WORKSPACE_FILE, content: 'CHANGED' } }]
          }
        }
        if (step === 1) {
          return {
            text: '这是聊天模式：我不会直接改文件。需要我动手的话，请把输入框旁的「聊天 / 工作」切到「工作」。'
          }
        }
        if (step === 2) {
          // 工作模式第一回合：写文件（permission=auto，工作区内直接执行）
          return {
            text: '好，我在工作模式里改。',
            toolCalls: [{ name: 'write_file', arguments: { path: WORKSPACE_FILE, content: 'CHANGED' } }]
          }
        }
        // 工作模式第二回合：延迟一下，留出「运行中尝试切换模式」的窗口
        return { text: '文件已写入 mode-note.md。', delayMs: 1500 }
      }
    })

    const first = await launchMorrow({ name: 'r8-mode-1', dataDir, chromiumDir, timeoutMs: 90_000 })
    let sessionId = ''
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      const provider = await saveMockProvider(page, mock.openaiBaseUrl)
      sessionId = await createModeSession(page, { workspace, providerId: provider.providerId, mode: 'chat' })
      expect(await sessionMode(page)).toBe('chat')

      /* ── 1) UI 进入聊天模式：分段控件/只读 chip/placeholder/titlebar chip，Goal 入口隐藏 ── */
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-picker-perm')).toHaveCount(0)
      await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /聊天模式/)
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)

      /* ── 2) Goal 入口不可用：不只是隐藏按钮，IPC 也被主进程拒绝 ── */
      const goalAttempt = await page.evaluate(async (sid: string) => {
        const result = await window.morrow.goal.start({ sessionId: sid, objective: '帮我做一份季度报告' })
        return result.ok ? { ok: true } : { ok: false, message: result.error.message }
      }, sessionId)
      expect(goalAttempt.ok).toBe(false)
      expect(goalAttempt.message).toContain('聊天模式')
      await page.screenshot({ path: screenshotPath('r8-mode-chat-composer.png') })

      /* ── 3) 聊天模式下发同一句改文件请求：工具被硬拦截、文件不变、助手解释 ── */
      await clearEvents(page)
      await sendMessageViaStore(page, USER_ASK)
      await waitForRunStarted(page, 30_000)
      const chatFinished = await waitForRunFinished(page, 60_000)
      expect(chatFinished.reason).toBe('complete')

      const chatEvents = await getEvents(page)
      expect(chatEvents.filter((event) => event.type === 'permission_requested')).toEqual([])
      const chatTools = chatEvents.filter((event) => event.type === 'tool_finished')
      expect(chatTools.length).toBeGreaterThanOrEqual(1)
      for (const event of chatTools) {
        expect(event.denied, `聊天模式工具不应放行：${JSON.stringify(event)}`).toBe(true)
        expect((event.result as { ok?: boolean } | undefined)?.ok).toBe(false)
      }
      expect(existsSync(join(workspace, WORKSPACE_FILE))).toBe(false)
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello')

      // 下发给模型的工具本身就不含写入/执行：不是「工具列表给了、执行才拦」
      expect(requests[0].toolNames).toContain('read_file')
      expect(requests[0].toolNames).toContain('ask_user')
      expect(requests[0].toolNames).not.toContain('write_file')
      expect(requests[0].toolNames).not.toContain('remove_file')
      expect(requests[0].toolNames).not.toContain('run_command')
      expect(requests[0].toolNames).not.toContain('update_goal')
      // 泛化断言：聊天模式工具列表里不允许出现任何写入/执行/记忆/目标/计划/子代理类工具
      for (const name of requests[0].toolNames) {
        expect(name, `聊天模式不应下发 ${name}`).not.toMatch(
          /^(write_|edit_|run_command|remember$|update_goal$|todo_write$|task$|open_artifact$)/
        )
      }

      // 助手解释或询问是否切到工作模式
      const chatState = await readStore(page)
      const chatText =
        chatState.session?.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text)
          .join('\n') ?? ''
      expect(chatText).toContain('聊天模式')
      expect(chatText).toContain('工作')
      await page.screenshot({ path: screenshotPath('r8-mode-chat-denied.png') })

      /* ── 4) 真实 UI 切到工作模式：权限下拉回来、Goal 入口回来 ── */
      await page.locator('.composer-picker-mode').getByRole('radio', { name: '工作' }).click()
      await waitMode(page, 'work')
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('工作')
      await expect(page.locator('.composer-picker-perm')).toHaveCount(1)
      await expect(page.locator('.composer-perm-lock')).toHaveCount(0)
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(1)

      /* ── 5) 工作模式同一句：真实写入；运行中尝试切 chat 被拒绝 ── */
      await clearEvents(page)
      await sendMessageViaStore(page, USER_ASK)
      await waitForRunStarted(page, 30_000)
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        void store.getState().setSessionMode('chat')
      })
      await waitUntil(
        async () => {
          const state = await readStore(page)
          return state.toast?.kind === 'warning' && /停止|切换/.test(state.toast.message) ? true : null
        },
        15_000,
        '运行中切换模式被拒绝的提示'
      )
      expect(await sessionMode(page)).toBe('work')

      const workFinished = await waitForRunFinished(page, 60_000)
      expect(workFinished.reason).toBe('complete')
      await waitUntil(async () => (existsSync(join(workspace, WORKSPACE_FILE)) ? true : null), 15_000, '工作模式写入文件')
      expect(readFileSync(join(workspace, WORKSPACE_FILE), 'utf8')).toBe('CHANGED')

      const workEvents = await getEvents(page)
      const okTools = workEvents.filter(
        (event) =>
          event.type === 'tool_finished' &&
          (event.result as { ok?: boolean } | undefined)?.ok === true &&
          event.denied !== true
      )
      expect(okTools.length).toBeGreaterThanOrEqual(1)
      expect(requests[2].toolNames).toContain('write_file')
      expect(requests[2].toolNames).toContain('run_command')
      await page.screenshot({ path: screenshotPath('r8-mode-work-write.png') })

      /* ── 6) 切回聊天：模式写入会话文件（重启保持的证据） ── */
      await page.locator('.composer-picker-mode').getByRole('radio', { name: '聊天' }).click()
      await waitMode(page, 'chat')
      const persisted = JSON.parse(readFileSync(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8')) as {
        mode?: string
      }
      expect(persisted.mode).toBe('chat')
    } finally {
      await first.close()
    }

    /* ── 7) 关闭后用同一 data-dir 重启：模式保持聊天，Goal 入口仍不可用 ── */
    const second = await launchMorrow({ name: 'r8-mode-2', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      await waitForStoreReady(page)
      await waitMode(page, 'chat')
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)
      await page.screenshot({ path: screenshotPath('r8-mode-restart-persist.png') })
    } finally {
      await second.close()
      await mock.close()
    }
  })
})

})

// ── 原文件：permission-rules.spec.ts ──────────────────────────────────────────────
test.describe('permission-rules.spec.ts', () => {
/**
 * P1-10 权限规则 E2E：
 * - 设置页添加 run_command 前缀 allow 规则 → 不再弹审批；
 * - deny 规则直接拒绝；
 * - 普通审批记录进入审批日志。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function addRuleViaUi(page: Page, pattern: string, decision: 'allow' | 'deny'): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    store.getState().openSettings()
  })
  await page.getByRole('tab', { name: '权限' }).click()
  await page.locator('.st-rule-pattern').fill(pattern)
  await page.locator('.st-rule-form').getByRole('radio', { name: decision === 'allow' ? '允许' : '拒绝' }).click()
  await page.locator('.st-rule-form').getByRole('button', { name: '添加' }).click()
  await expect(page.locator('.st-perm-rules')).toContainText(pattern)
  await page.getByRole('button', { name: '完成' }).click()
}

function toolStatus(page: Page, commandPart: string): Promise<string | null> {
  return page.evaluate((needle) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const session = store.getState().session
    for (const message of session?.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'run_command' && JSON.stringify(block.input).includes(needle)) {
          return block.status as string
        }
      }
    }
    return null
  }, commandPart)
}

test('工作区权限规则持久化、deny 优先与审批日志', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '执行规则允许的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: "Write-Output 'rule-ok'" } }]
      },
      { text: '规则命令已执行。' },
      {
        text: '尝试被禁止的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: "Write-Output 'rule-blocked'" } }]
      },
      { text: '命令被拒绝。' },
      {
        text: '需要审批的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: 'Remove-Item out -Recurse -Force' } }]
      },
      { text: '审批命令已执行。' }
    ]
  })
  const workspace = workspaceAt('e2e-permission-rules')
  const morrow = await launchMorrow({ name: 'permission-rules', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '权限规则测试'
    })

    // allow 规则
    await addRuleViaUi(page, "Write-Output 'rule-ok'", 'allow')
    await page.locator('.composer-input').fill('执行规则命令')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('规则命令已执行。')).toBeVisible({ timeout: 45_000 })
    expect(await toolStatus(page, 'rule-ok')).toBe('success')
    expect((await readStore(page)).pendingPermission).toBeNull()

    // deny 规则
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第一条完成')
    await addRuleViaUi(page, "Write-Output 'rule-blocked'", 'deny')
    await page.locator('.composer-input').fill('尝试被禁止的命令')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('命令被拒绝。')).toBeVisible({ timeout: 45_000 })
    expect(await toolStatus(page, 'rule-blocked')).toBe('denied')

    // 普通审批进入日志
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第二条完成')
    await page.locator('.composer-input').fill('执行需要审批的命令')
    await page.locator('.composer-input').press('Enter')
    await waitForPermission(page, 45_000)
    await clickPermissionCard(page, 'once')
    await expect(page.getByText('审批命令已执行。')).toBeVisible({ timeout: 45_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第三条完成')

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '权限' }).click()
    await expect(page.locator('.st-perm-rules')).toContainText("Write-Output 'rule-ok'")
    await expect(page.locator('.st-perm-rules')).toContainText("Write-Output 'rule-blocked'")
    await expect(page.locator('.st-approval-log')).toContainText('运行命令')
    // 整个工具规则：匹配内容留空也应能保存（此前服务端会拒绝空 pattern）
    const form = page.locator('.st-rule-form')
    await form.getByRole('button', { name: '规则类型', exact: true }).click()
    await page.getByRole('option', { name: '写文件' }).click()
    await form.getByRole('button', { name: '权限规则类型' }).click()
    await page.getByRole('option', { name: '整个工具' }).click()
    await expect(form.locator('.st-rule-pattern')).toBeDisabled()
    await form.getByRole('button', { name: '添加' }).click()
    await expect(page.locator('.st-perm-rules')).toContainText('写文件 · 工具')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    })
    await expect(page.getByText('文件夹权限规则')).toBeVisible()
    await page.mouse.move(4, 4)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('permission-rules-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('permission-rules-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：agent-rules.spec.ts ──────────────────────────────────────────────
test.describe('agent-rules.spec.ts', () => {
/**
 * P1-9 项目规则文件 E2E：
 * - AGENTS.md 注入系统提示；
 * - /init 生成 AGENTS.md；
 * - 设置 → 上下文 可见发现的规则文件。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('规则文件注入、/init 生成与设置页可见', async () => {
  test.setTimeout(180_000)
  const rulesWorkspace = workspaceAt('e2e-rules-inject')
  writeFileSync(join(rulesWorkspace, 'AGENTS.md'), 'RULE-MARKER-7788：所有回答都要提到猕猴桃。\n', 'utf8')
  const initWorkspace = workspaceAt('e2e-rules-init')
  mkdirSync(join(initWorkspace, '.morrow'), { recursive: true })
  writeFileSync(join(initWorkspace, '.morrow', 'AGENTS.md'), 'EXISTING-DOT-RULE\n', 'utf8')

  const mock = await startMockLLM({
    scripts: [
      { text: '收到规则。' },
      {
        text: '工作区很简单，我来写 AGENTS.md。',
        toolCalls: [
          {
            name: 'write_file',
            arguments: {
              path: 'AGENTS.md',
              content: '# AGENTS.md\n\n## 项目概述\nMorrow E2E 测试工作区。\n\n## 常用命令\n- 测试：npm test\n'
            }
          }
        ]
      },
      { text: '已生成 AGENTS.md。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'agent-rules', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: rulesWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '规则注入测试'
    })
    await page.locator('.composer-input').fill('你好')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('收到规则。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '规则运行结束')
    const firstBody = mock.requests[0]?.body as { messages?: Array<{ role: string; content: unknown }> } | undefined
    const systemMessage = firstBody?.messages?.find((message) => message.role === 'system')
    expect(JSON.stringify(systemMessage)).toContain('RULE-MARKER-7788')
    expect(JSON.stringify(firstBody)).toContain('项目规则文件')
    expect(JSON.stringify(firstBody?.messages?.find((message) => message.role === 'user'))).not.toContain('RULE-MARKER-7788')

    // /init 生成 AGENTS.md
    await createSession(page, {
      workspace: initWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '初始化规则测试'
    })
    await page.locator('.composer-input').fill('/init')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '/init 运行结束')
    await waitUntil(async () => existsSync(join(initWorkspace, 'AGENTS.md')), 30_000, 'AGENTS.md 生成')
    expect(readFileSync(join(initWorkspace, 'AGENTS.md'), 'utf8')).toContain('项目概述')
    // /init 会先发现已有规则文件（含 .morrow），并要求模型在现有文件上更新
    const initBodies = mock.requests.slice(2).map((request) => JSON.stringify(request.body))
    expect(initBodies.some((body) => body.includes('先读取这些文件') && body.includes('.morrow'))).toBe(true)
    expect(initBodies.some((body) => body.includes('EXISTING-DOT-RULE'))).toBe(true)

    // 设置 → 上下文：规则可见
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '上下文' }).click()
    await expect(page.locator('.st-rules-list')).toContainText('AGENTS.md')
    await expect(page.locator('.st-rules-list')).toContainText('.morrow')
    await expect(page.locator('.st-rules-budget')).toContainText('已使用')
    await page.locator('.st-rules-head').getByRole('button', { name: '刷新' }).click()
    await expect(page.locator('.st-rules-list')).toContainText('AGENTS.md')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.getByText('项目规则文件', { exact: true }).scrollIntoViewIfNeeded()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('agent-rules-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('agent-rules-settings-light.png') })
    await page.getByRole('button', { name: '完成' }).click()

    // 只读模式下 /init 应直接拦下，不发送请求
    const guardWorkspace = workspaceAt('e2e-rules-guard')
    await createSession(page, {
      workspace: guardWorkspace,
      ...provider,
      permissionMode: 'read-only',
      title: '只读规则测试'
    })
    const requestsBefore = mock.requests.length
    await page.locator('.composer-input').fill('/init')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/只读模式不能写文件/)).toBeVisible()
    await page.waitForTimeout(400)
    expect(mock.requests.length).toBe(requestsBefore)
    expect(existsSync(join(guardWorkspace, 'AGENTS.md'))).toBe(false)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
