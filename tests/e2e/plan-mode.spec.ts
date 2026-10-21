/**
 * P0-2 计划模式 E2E：
 * - /plan 进入计划模式并生成计划卡（只读工具运行，不写文件）；
 * - 拒绝 → 重新规划 → 生成修订版计划；
 * - 批准 → 自动切执行、写入 todo 与产物，完成后计划标记 completed 且持久化。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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
      { text: '前两步完成，继续执行第三步。' },
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

    // 1) /plan + 任务：进入计划模式并自动发送
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
    const firstTools = (mock.requests[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    const firstNames = firstTools.map((tool) => tool.function?.name)
    expect(firstNames).toContain('submit_plan')
    expect(firstNames).not.toContain('write_file')
    const executionRequest = mock.requests[4].body as { tools?: Array<{ function?: { name?: string } }> }
    expect((executionRequest.tools ?? []).map((tool) => tool.function?.name)).toContain('write_file')
  } finally {
    await morrow.close()
    await mock.close()
  }
})
