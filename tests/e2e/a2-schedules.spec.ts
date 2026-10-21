/**
 * A2 定时任务：
 * 1) 面板创建任务 → 立即运行 → 真实会话/回复/状态回写 → 查看结果 → 暂停/删除；
 * 2) 应用关闭期间到期的任务，在下次启动（1 小时内）自动补跑并回写结果。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  openToolPanel,
  readStore,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function openSchedulesPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'schedules' } }))
  })
  await expect(page.locator('.sch-root')).toBeVisible({ timeout: 15_000 })
}

test.describe('A2 定时任务', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('创建任务、立即运行、查看结果、暂停与删除', async () => {
    test.setTimeout(180_000)
    mock = await startMockLLM({ scripts: [{ text: '周报已经整理好了：本周完成三件事。' }] })
    morrow = await launchMorrow({ name: 'a2-schedules', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const workspace = makeDir('a2-schedules-ws')
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'A2 定时任务基础会话'
    })

    await openToolPanel(page, '定时任务')
    await expect(page.locator('.sch-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sch-title')).toHaveText('安排一件新事情')
    await page.getByLabel('任务名称').fill('每周项目周报')
    await page.getByLabel('要做什么').fill('整理本周新增的文件与改动，写一份三条以内的周报。')
    await expect(page.getByLabel('任务名称')).toHaveValue('每周项目周报')
    await expect(page.getByLabel('要做什么')).toHaveValue(/整理本周新增/)
    // 默认每天、下一小时执行；工作区自动继承当前会话文件夹
    await expect(page.locator('.sch-workspace-path')).toContainText('a2-schedules-ws')
    await expect(page.locator('.sch-preview').filter({ hasText: '下一次：' })).toBeVisible()
    await page.getByRole('button', { name: '保存定时任务' }).click()
    await expect(page.locator('.sch-notice')).toContainText('定时任务已创建')
    await expect(page.locator('.sch-task')).toContainText('每周项目周报')
    await expect(page.locator('.sch-task')).toContainText('每天')
    const toastClose = page.locator('.toast-close').first()
    if (await toastClose.isVisible().catch(() => false)) await toastClose.click()
    await page.locator('.modal-panel').filter({ has: page.locator('.sch-root') }).screenshot({
      path: screenshotPath('a2-schedules.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.sch-root') }).screenshot({
      path: screenshotPath('a2-schedules-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 立即运行 → Agent 真实回复 → 状态回写
    await installEventCollector(page)
    await page.getByRole('button', { name: '立即运行' }).click()
    await waitForRunFinished(page, 90_000)
    await expect(page.locator('.sch-status')).toContainText('上次成功', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: '查看上次结果' })).toBeVisible()
    const scheduledRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('整理本周新增的文件与改动')
    )
    expect(JSON.stringify(scheduledRequest?.body ?? {})).toContain('## 回答风格（全局偏好）')

    // 任务产生的真实会话
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ title: string; lastStatus: string; lastSessionId?: string; lastRunAt: number }>
    }
    const saved = stored.tasks.find((task) => task.title === '每周项目周报')
    expect(saved?.lastStatus).toBe('success')
    expect(saved?.lastSessionId).toBeTruthy()

    await page.getByRole('button', { name: '查看上次结果' }).click()
    await expect(page.locator('.sch-root')).toHaveCount(0)
    await expect(page.getByText('周报已经整理好了：本周完成三件事。')).toBeVisible({ timeout: 30_000 })

    // 暂停 → 不自动运行；再启用；最后删除
    await openSchedulesPanel(page)
    await page.locator('.sch-task').filter({ hasText: '每周项目周报' }).click()
    const enableSwitch = page.getByRole('switch', { name: '启用自动执行' })
    await expect(enableSwitch).toHaveAttribute('aria-checked', 'true')
    await enableSwitch.click()
    await expect(page.locator('.sch-notice')).toContainText('已暂停')
    await expect(page.locator('.sch-task')).toContainText('暂停')
    await enableSwitch.click()
    await expect(page.locator('.sch-notice')).toContainText('已启用')

    await page.locator('.sch-actions').getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.sch-confirm')).toBeVisible()
    await page.locator('.sch-confirm').getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.sch-notice')).toContainText('已删除')
    await expect(page.locator('.sch-task')).toHaveCount(0)
    const afterDelete = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks: unknown[] }
    expect(afterDelete.tasks).toHaveLength(0)
  })

  test('无人值守运行自动拒绝需要审批的高风险操作，不会挂起等待', async () => {
    test.setTimeout(150_000)
    mock = await startMockLLM({
      scripts: [
        {
          text: '先检查系统状态。',
          toolCalls: [{ name: 'run_command', arguments: { command: 'shutdown /s /t 0' } }]
        },
        { text: '需要授权的操作已自动跳过，检查完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'a2-schedules-unattended', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const workspace = makeDir('a2-unattended-ws')
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'A2 无人值守基础会话'
    })
    const created = await page.evaluate(async (workspacePath: string) => {
      const result = await window.morrow.features.invoke<{ task: { id: string } }>('feature:schedules:create', {
        title: '无人值守安全检查',
        prompt: '检查系统状态并说明结果。',
        schedule: { kind: 'daily', time: '23:59' },
        workspace: workspacePath,
        permissionMode: 'auto',
        enabled: true
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.task
    }, workspace)
    expect(created.id).toBeTruthy()

    await openToolPanel(page, '定时任务')
    await page.locator('.sch-task').filter({ hasText: '无人值守安全检查' }).click()
    await installEventCollector(page)
    await page.getByRole('button', { name: '立即运行' }).click()
    // 若审批没有被自动拒绝，这里会一直等到 30 分钟超时
    await waitForRunFinished(page, 90_000)
    await expect(page.locator('.sch-status')).toContainText('上次成功', { timeout: 20_000 })
    const store = await readStore(page)
    expect(store.pendingPermission).toBeNull()
    expect(store.runs).toHaveLength(0)
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ id: string; lastStatus: string; lastSessionId?: string }>
    }
    const task = stored.tasks.find((item) => item.id === created.id)
    expect(task?.lastStatus).toBe('success')
    expect(task?.lastSessionId).toBeTruthy()
  })

  test('应用重启后补跑到期任务，并写回成功状态与会话', async () => {
    test.setTimeout(180_000)
    mock = await startMockLLM({ scripts: [{ text: '补跑完成：资料已经看过，没有发现异常。' }] })
    const dataDir = makeDir('a2-catchup-data')
    const workspace = makeDir('a2-catchup-ws')

    morrow = await launchMorrow({ name: 'a2-catchup-1', dataDir, timeoutMs: 90_000 })
    const first = morrow.page
    await waitForStoreReady(first)
    await dismissOnboarding(first)
    const provider = await configureMockProvider(first, mock.openaiBaseUrl)
    await first.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const created = await first.evaluate(async (arg: { workspace: string }) => {
      const result = await window.morrow.features.invoke<{ task: { id: string } }>('feature:schedules:create', {
        title: '重启补跑检查',
        prompt: '检查项目资料里有没有异常。',
        schedule: { kind: 'daily', time: '09:00' },
        workspace: arg.workspace,
        permissionMode: 'read-only',
        enabled: true
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.task
    }, { workspace })
    expect(created?.id).toBeTruthy()
    const tasksFile = join(dataDir, 'schedules', 'tasks.json')
    await morrow.close()
    morrow = undefined as unknown as MorrowApp

    // 模拟「应用关闭时已到期、但还在 1 小时补跑窗口内」
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ nextRunAt: number; lastStatus: string }>
    }
    stored.tasks[0].nextRunAt = Date.now() - 2_000
    stored.tasks[0].lastStatus = 'never'
    writeFileSync(tasksFile, JSON.stringify(stored, null, 2), 'utf8')

    morrow = await launchMorrow({ name: 'a2-catchup-2', dataDir, timeoutMs: 90_000 })
    const second = morrow.page
    await waitForStoreReady(second)
    const session = await waitUntil(async () => {
      const result = await second.evaluate(async () => window.morrow.session.list())
      if (!result.ok) return null
      const target = result.data.find((item) => item.title.startsWith('定时 · 重启补跑检查'))
      return target ?? null
    }, 40_000, '补跑产生定时会话')
    expect(session.title).toContain('重启补跑检查')

    await waitUntil(async () => {
      const current = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
        tasks: Array<{ lastStatus: string; lastSessionId?: string }>
      }
      return current.tasks[0]?.lastStatus === 'success' ? current : null
    }, 40_000, '补跑结果写回成功')
    const loaded = await second.evaluate(async (id: string) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, session.id)
    const text = (loaded?.messages ?? [])
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('\n')
    expect(text).toContain('补跑完成')

    // 面板从磁盘读取也能看到结果
    await openSchedulesPanel(second)
    await expect(page2Task(second, '重启补跑检查')).toBeVisible()
    await expect(second.locator('.sch-status')).toContainText('上次成功')
  })
})

function page2Task(page: import('@playwright/test').Page, title: string) {
  return page.locator('.sch-task').filter({ hasText: title })
}
