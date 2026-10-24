/**
 * 合并自 10 个 E2E spec：a1-projects-home.spec.ts、a2-schedules.spec.ts、a3-connectors-catalog.spec.ts、a4-research.spec.ts、r10-connectors.spec.ts、r10-memory-projects.spec.ts、r10-skills.spec.ts、r10-panels.spec.ts、r10-tools-settings.spec.ts、r10-ui-copy-review.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { configureMockProvider, createSession, dismissOnboarding, installEventCollector, openToolPanel, readStore, sendMessageViaStore, setThemeViaStore, waitForRunFinished, waitForStoreReady, waitUntil } from './store'

// ── 原文件：a1-projects-home.spec.ts ──────────────────────────────────────────────
test.describe('a1-projects-home.spec.ts', () => {
/**
 * A1 项目主页与项目内会话（合并进原工作台 ProjectsPanel）：
 * 概览页展示真实项目背景、项目内对话列表；从项目里输入首句会创建带该工作区的会话并注入项目上下文。
 */

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function sameWorkspace(a: string | null, b: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!a && norm(a) === norm(b)
}

test.describe('A1 项目主页', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('概览展示项目背景；首句在项目工作区创建会话并注入说明与资料', async () => {
    test.setTimeout(180_000)
    const workspace = makeDir('a1-project-ws')
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nA1_CANARY_KNOWLEDGE：这是项目内的资料。', 'utf8')
    mock = await startMockLLM({ scripts: [{ text: '好的，我已经按项目背景开始。' }] })

    morrow = await launchMorrow({ name: 'a1-project-home', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoTitle: false, lastWorkspace: null })
    })
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({
        defaultModel: { providerId: model.providerId, modelId: model.modelId }
      })
    }, provider)

    const created = await page.evaluate(
      async (arg: { workspace: string }) => {
        const result = await window.morrow.features.invoke<{ id: string }>('feature:projects:create', {
          workspace: arg.workspace,
          name: 'A1 项目主页测试',
          description: '验证项目概览与项目内对话。',
          instructions: 'A1 项目指令：回答前先参考项目资料。',
          knowledgePaths: ['brief.md'],
          active: true
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      { workspace }
    )
    expect(created.id).toBeTruthy()
    const toastClose = page.locator('.toast-close').first()
    if (await toastClose.isVisible().catch(() => false)) await toastClose.click()

    // 打开同一个工作台项目面板（概览是默认视图）
    await page.getByRole('button', { name: '打开项目主页' }).click()
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.pp-tabs button.is-active')).toHaveCSS('height', '24px')
    await expect(page.locator('.pp-tabs button.is-active')).toHaveCSS('border-radius', '5px')
    await expect(page.locator('.pp-home-title')).toHaveText('A1 项目主页测试')
    await expect(page.locator('.pp-home-desc')).toContainText('验证项目概览')
    await expect(page.locator('.pp-home-meta')).toContainText('1 份资料')
    await expect(page.locator('.pp-home-cards')).toContainText('A1 项目指令：回答前先参考项目资料。')
    await expect(page.locator('.pp-home-cards')).toContainText('brief.md')
    await expect(page.locator('.pp-home-recent')).toContainText('这里还没有对话')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 从项目里发第一句 → 真实创建项目工作区会话
    await installEventCollector(page)
    const prompt = '把项目资料读一遍，然后告诉我项目要做什么。'
    const composer = page.locator('.pp-home-composer textarea')
    await composer.fill(prompt)
    await composer.press('Enter')
    await expect(page.locator('.pp-root')).toHaveCount(0, { timeout: 15_000 })
    await waitForRunFinished(page, 90_000)

    const store = await readStore(page)
    expect(store.session?.workspace && sameWorkspace(store.session.workspace, workspace)).toBe(true)
    expect(store.session?.messages.some((message) => message.role === 'user' && message.text.includes('项目资料读一遍'))).toBe(true)

    // 真实请求体里带上了项目说明与资料（system prompt）；跳过可能的连接探测请求
    const firstBody = (mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('项目资料读一遍')
    )?.body ?? {}) as { messages?: Array<{ role: string; content: unknown }> }
    const sys = JSON.stringify(firstBody.messages?.[0]?.content ?? '')
    expect(sys).toContain('A1 项目指令')
    expect(sys).toContain('A1_CANARY_KNOWLEDGE')

    // 再开概览：项目内对话已计入并可直接打开
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-home-recent')).toContainText('项目资料读一遍', { timeout: 15_000 })
    await expect(page.locator('.pp-home-meta')).toContainText('1 段对话')
    await expect(page.locator('.pp-project')).toContainText('1 对话')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home-with-chat.png')
    })

    // 项目内对话可直接打开主窗口里的同一条会话
    await page.locator('.pp-home-sessions button').first().click()
    await expect(page.locator('.pp-root')).toHaveCount(0)
    await expect(page.getByText('好的，我已经按项目背景开始。')).toBeVisible({ timeout: 30_000 })
  })

  test('资料失效时仍能保存项目修改、移除失效资料，并在预览中说明原因', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a1-project-stale-ws')
    writeFileSync(join(workspace, 'brief.md'), '# 资料\nA1_STALE_CANARY：有效资料。', 'utf8')
    writeFileSync(join(workspace, 'gone.md'), 'GONE_CANARY：稍后删除。', 'utf8')

    morrow = await launchMorrow({ name: 'a1-project-stale', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: null })
    })

    const created = await page.evaluate(
      async (arg: { workspace: string }) => {
        const result = await window.morrow.features.invoke<{ id: string }>('feature:projects:create', {
          workspace: arg.workspace,
          name: '失效资料项目',
          instructions: 'A1 初始说明。',
          knowledgePaths: ['brief.md', 'gone.md'],
          active: true
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      { workspace }
    )
    expect(created.id).toBeTruthy()
    // 项目创建后删除其中一份资料：这正是此前“一丢文件就再也保存不了”的场景
    unlinkSync(join(workspace, 'gone.md'))

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('tab', { name: '说明与资料' }).click()
    await expect(page.locator('.pp-knowledge-item.is-invalid')).toContainText('gone.md')
    await expect(page.locator('.pp-knowledge-item.is-invalid')).toContainText(/不存在/)
    // 记忆中心独立注入，界面文案不再承诺“停用项目连记忆一起停”
    await expect(page.locator('.pp-switches')).toContainText('记忆中心按自己的设置单独注入')

    await page.getByLabel('长期说明（Morrow 做任务时会参考）').fill('A1 失效资料仍可保存：说明已更新。')
    await page.getByRole('button', { name: '保存项目' }).click()
    await expect(page.locator('.pp-notice')).toContainText('项目已保存')

    await page.getByRole('button', { name: 'Morrow 会看到什么' }).click()
    const preview = page.locator('.pp-preview')
    await expect(preview).toBeVisible({ timeout: 10_000 })
    await expect(preview).toContainText('A1 失效资料仍可保存')
    await expect(preview).toContainText('A1_STALE_CANARY')
    await expect(preview.locator('.pp-preview-warn')).toContainText('已跳过失效的参考资料')
    await expect(preview.locator('.pp-preview-warn')).toContainText('gone.md')
    await expect(preview.locator('.pp-preview-head')).not.toContainText('已截断')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-root') }).screenshot({
      path: screenshotPath('a1-project-stale-dark.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-root') }).screenshot({
      path: screenshotPath('a1-project-stale-light.png')
    })

    // 移除失效资料后保存：磁盘上只剩有效资料
    await page.getByRole('button', { name: '移除参考资料 gone.md' }).click()
    await page.getByRole('button', { name: '保存项目' }).click()
    await expect(page.locator('.pp-notice')).toContainText('项目已保存')
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke<{ projects: Array<{ knowledgePaths: string[] }> }>(
        'feature:projects:list'
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.data.projects.find((project) => project.knowledgePaths.length > 0) ?? null
    })
    expect(saved?.knowledgePaths).toEqual(['brief.md'])
  })

  test('当前文件夹范围突出新建入口，底部重复 CTA 已移除', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a1-project-scope-ws')

    morrow = await launchMorrow({ name: 'a1-project-scope', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (nextWorkspace: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: nextWorkspace })
    }, workspace)
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })

    const scope = page.getByRole('radiogroup', { name: '项目范围' })
    await expect(scope).toBeVisible()
    await expect(scope.getByRole('radio', { name: '全部项目' })).toHaveAttribute('aria-checked', 'true')
    await scope.getByRole('radio', { name: '当前文件夹' }).click()
    await expect(scope.getByRole('radio', { name: '当前文件夹' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.pp-empty')).toContainText('当前文件夹')
    await expect(page.locator('.pp-empty')).toContainText('还没有项目')
    await expect(page.locator('.pp-cta')).toHaveCount(0)

    await page.getByRole('button', { name: '新建项目' }).click()
    await page.getByLabel('项目名称').fill('当前文件夹项目')
    await page.getByRole('button', { name: '创建项目' }).click()
    await expect(page.locator('.pp-home-title')).toHaveText('当前文件夹项目', { timeout: 15_000 })
    await expect(page.locator('.pp-project')).toContainText('当前文件夹项目')
    await expect(page.locator('.pp-cta')).toHaveCount(0)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-root') }).screenshot({
      path: screenshotPath('a1-project-scope-current.png')
    })
  })
})

})

// ── 原文件：a2-schedules.spec.ts ──────────────────────────────────────────────
test.describe('a2-schedules.spec.ts', () => {
/**
 * A2 定时任务：
 * 1) 面板创建任务 → 立即运行 → 真实会话/回复/状态回写 → 查看结果 → 暂停/删除；
 * 2) 应用关闭期间到期的任务，在下次启动（1 小时内）自动补跑并回写结果。
 */

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
    // 运行结束与定时任务状态落盘之间有一个异步窗口；以最终落盘状态为准
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    await waitUntil(
      async () => {
        try {
          const current = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
            tasks: Array<{ id: string; lastStatus: string }>
          }
          return current.tasks.find((item) => item.id === created.id)?.lastStatus === 'success'
        } catch {
          return false
        }
      },
      30_000,
      '定时任务成功状态落盘'
    )
    const store = await readStore(page)
    expect(store.pendingPermission).toBeNull()
    expect(store.runs).toHaveLength(0)
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

})

// ── 原文件：a3-connectors-catalog.spec.ts ──────────────────────────────────────────────
test.describe('a3-connectors-catalog.spec.ts', () => {
/**
 * A3 连接器目录与一键安装：
 * 目录展示真实、可核对的连接器；安装真实写 mcp.json，密钥加密且不回显；
 * 本机服务在缺少 Node.js 时明确提示，不伪造成功。
 */

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('A3 连接器目录', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('目录搜索/分类，远程连接器一键安装并加密保存，本机服务显示运行时要求', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a3-connectors-ws')
    morrow = await launchMorrow({ name: 'a3-connectors', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (path: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: path })
    }, workspace)

    await openToolPanel(page, '连接器')
    await expect(page.locator('.conn')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '工具目录' }).click()
    await expect(page.locator('.cd-root')).toBeVisible()
    await expect(page.getByLabel('搜索外部工具目录')).toBeVisible()

    // 目录有官方/本机条目，且本机条目明确标注 Node.js 要求
    await expect(page.locator('.cd-item').first()).toBeVisible({ timeout: 15_000 })
    expect(await page.locator('.cd-item').count()).toBeGreaterThanOrEqual(6)
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toBeVisible()
    await expect(page.locator('.cd-item').filter({ hasText: 'Linear' })).toBeVisible()
    await expect(page.locator('.cd-item').filter({ hasText: '文件系统' })).toContainText('需 Node.js')
    await expect(page.locator('.cd-top')).toContainText('Node.js')

    // 搜索与分类过滤
    await page.getByRole('radio', { name: '本机服务' }).click()
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(page.locator('.cd-item').filter({ hasText: '文件系统' })).toBeVisible()
    await page.getByRole('radio', { name: '全部' }).click()
    await page.getByLabel('搜索外部工具目录').fill('Linear')
    await expect(page.locator('.cd-item')).toHaveCount(1)
    await expect(page.locator('.cd-item').filter({ hasText: 'Linear' })).toBeVisible()
    await page.getByLabel('搜索外部工具目录').fill('')

    // GitHub：需要 Token；只安装不改网络
    await page.locator('.cd-item').filter({ hasText: 'GitHub' }).click()
    await expect(page.getByLabel('GitHub Token')).toBeVisible()
    await expect(page.locator('.cd-actions').getByRole('button', { name: '仅安装' })).toBeDisabled()
    const fakeToken = 'ghp_e2e_catalog_token_1234567890'
    await page.getByLabel('GitHub Token').fill(fakeToken)
    await expect(page.locator('.cd-top')).not.toContainText('检测中', { timeout: 15_000 })
    await page.locator('.modal-panel').filter({ has: page.locator('.cd-root') }).screenshot({
      path: screenshotPath('a3-connector-directory.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.cd-root') }).screenshot({
      path: screenshotPath('a3-connector-directory-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.locator('.cd-actions').getByRole('button', { name: '仅安装' }).click()

    // 安装成功 → 回到已安装详情，真实写盘且密钥不明文
    await expect(page.locator('.cd-root')).toHaveCount(0)
    await expect(page.locator('.conn-item[data-name="github"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.conn-notice')).toContainText('已安装')
    const mcpFile = join(morrow.dataDir, 'mcp.json')
    const secretsFile = join(morrow.dataDir, 'mcp-secrets.json')
    expect(existsSync(mcpFile)).toBe(true)
    const configText = readFileSync(mcpFile, 'utf8')
    expect(configText).toContain('github')
    expect(configText).toContain('MORROW_SECRET')
    expect(configText).not.toContain(fakeToken)
    expect(readFileSync(secretsFile, 'utf8')).not.toContain(fakeToken)

    // 已安装项在目录里可识别，且本机条目有文件夹选择
    await page.getByRole('button', { name: '工具目录' }).click()
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toContainText('已安装')
    await page.locator('.cd-item').filter({ hasText: '文件系统' }).click()
    await expect(page.getByText('允许访问的文件夹')).toBeVisible()
    await expect(page.getByRole('button', { name: '选择文件夹' })).toBeVisible()
    await page.getByRole('button', { name: '返回已安装' }).click()

    // 删除安装项，密钥一并清理
    await page.locator('.conn-item[data-name="github"] .conn-item-main').click()
    await page.locator('.conn-actions').getByRole('button', { name: '删除', exact: true }).click()
    await page.locator('.conn-actions').getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.conn-item[data-name="github"]')).toHaveCount(0, { timeout: 15_000 })
    expect(readFileSync(mcpFile, 'utf8')).not.toContain('github')
  })
})

})

// ── 原文件：a4-research.spec.ts ──────────────────────────────────────────────
test.describe('a4-research.spec.ts', () => {
/**
 * A4 深度研究模式：
 * - 切到研究模式后，真实执行多轮 web_search，来源不足自动续研；
 * - 最终产出带引用的 Markdown 报告（画布成品），进度条如实显示轮次/来源；
 * - 自动续研的内部提示不展示为用户气泡；
 * - 未配置联网搜索时明确拒绝，不伪造研究。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function dismissToasts(page: import('@playwright/test').Page): Promise<void> {
  const close = page.locator('.toast-close')
  for (let index = 0; index < 6; index += 1) {
    if ((await close.count()) === 0) return
    await close.first().click().catch(() => undefined)
    await page.waitForTimeout(80)
  }
}

async function startResearchSearch(): Promise<{ baseUrl: string; server: Server; queries: string[] }> {
  const queries: string[] = []
  const resultsFor: Record<string, Array<{ title: string; url: string; content: string; engine: string }>> = {
    first: [
      { title: '来源 A', url: 'https://example.com/a', content: '第一篇资料。', engine: 'mock' },
      { title: '来源 B', url: 'https://example.com/b', content: '第二篇资料。', engine: 'mock' }
    ],
    second: [
      { title: '来源 A', url: 'https://example.com/a', content: '第一篇资料。', engine: 'mock' },
      { title: '来源 C', url: 'https://example.com/c', content: '第三篇资料。', engine: 'mock' },
      { title: '来源 D', url: 'https://example.com/d', content: '第四篇资料。', engine: 'mock' }
    ]
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/search')) {
      const query = url.searchParams.get('q') ?? ''
      queries.push(query)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: query.includes('补充') ? resultsFor.second : resultsFor.first }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, server, queries }
}

const REPORT = [
  '# 深度研究报告：Morrow 研究能力',
  '',
  '## 关键结论',
  '- Morrow 是一个本地 AI 工作伙伴 [1]。',
  '- 它会保留来源并在报告中给出可核对链接 [2][3]。',
  '',
  '## 局限',
  '- 本次测试使用模拟检索服务。',
  '',
  '## 参考来源',
  '[1] https://example.com/a',
  '[2] https://example.com/b',
  '[3] https://example.com/c'
].join('\n')

const PLAN = [
  '# 研究计划：Morrow 深度研究能力',
  '',
  '## 研究目标',
  '确认 Morrow 深度研究的多轮检索、来源核对与报告交付能力。',
  '',
  '## 范围与假设',
  '- 以公开资料为主；优先 2026 年信息。',
  '',
  '## 子问题',
  '1. 它如何拆解研究问题？',
  '2. 它如何记录独立来源并自动补查？',
  '3. 它如何交付带引用的报告？',
  '',
  '## 检索策略',
  '- 两组不同关键词；至少 4 个独立来源。',
  '',
  '## 报告结构',
  '- 摘要、关键结论、证据与分歧、局限、参考来源。',
  '',
  '## 需要确认',
  '- 无。'
].join('\n')

test.describe('A4 深度研究模式', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null
  let search: Awaited<ReturnType<typeof startResearchSearch>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    await new Promise<void>((resolve) => (search ? search.server.close(() => resolve()) : resolve()))
    mock = null
    search = null
  })

  test('多轮检索自动补查 → 带引用报告与真实来源面板；内部补查不显示为气泡', async () => {
    test.setTimeout(180_000)
    search = await startResearchSearch()
    mock = await startMockLLM({
      scripts: [
        { text: PLAN },
        { text: '先检索第一批资料。', delayMs: 2_500, toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 研究能力 第一轮', max_results: 5 } }] },
        { text: '初步结论：还需要更多来源与正式报告。' },
        { text: '补充检索不同角度。', toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 研究能力 补充检索', max_results: 5 } }] },
        {
          text: '资料已经足够，整理研究报告。',
          toolCalls: [{ name: 'open_artifact', arguments: { title: '研究报告：Morrow 研究能力', kind: 'markdown', content: REPORT } }]
        },
        { text: '研究报告已经放到画布。' }
      ]
    })
    morrow = await launchMorrow({ name: 'a4-research', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const configuredSearch = await page.evaluate(async (baseUrl) => {
      const result = await window.morrow.settings.saveWebSearch({
        enabled: true,
        provider: 'searxng',
        baseUrl,
        maxResults: 5
      })
      return result.ok
    }, search.baseUrl)
    expect(configuredSearch).toBe(true)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('a4-research-ws'),
      ...provider,
      permissionMode: 'auto',
      title: '深度研究测试'
    })

    // 输入框只保留聊天/工作；研究工作流通过 /research 调取
    await expect(page.locator('.composer-picker-mode').getByRole('radio')).toHaveCount(2)
    await page.locator('.composer-input').fill('/research quick 研究一下 Morrow 的深度研究能力，并给出可核对的报告。')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-perm-lock.is-research')).toContainText('联网查证')
    await expect(page.locator('.composer-picker-research')).toContainText('研究·快速')

    // ChatGPT Deep Research 式流程：先拿到可编辑计划，确认后才开始检索
    const ready = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return session?.research ?? null
      })
      return result?.status === 'ready' ? result : null
    }, 60_000, '研究计划生成')
    expect(ready.plan).toContain('研究计划')
    const planBar = page.locator('.research-bar')
    await expect(planBar).toContainText('计划待确认')
    await expect(page.getByLabel('研究计划')).toHaveValue(/研究计划/)
    await dismissToasts(page)
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-plan-dark.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-plan-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.getByLabel('研究计划').fill(`${PLAN}\n\n补充：优先 2026 年资料。`)
    await page.getByRole('button', { name: '开始研究' }).click()

    // 运行中可追加要求（ChatGPT Deep Research 式调整方向），下一轮优先纳入
    const running = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return session?.research?.status === 'searching' ? { sessionId: session.id as string } : null
      })
      return result
    }, 20_000, '研究开始')
    await expect(page.getByLabel('补充研究要求')).toBeVisible()
    await dismissToasts(page)
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-steering-dark.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-steering-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    const steered = await page.evaluate(
      async (arg: { sessionId: string; text: string }) => {
        const result = await window.morrow.chat.steerResearch({ sessionId: arg.sessionId, text: arg.text })
        return result.ok ? { ok: true as const } : { ok: false as const, error: result.error.message }
      },
      { sessionId: running.sessionId, text: '补充关注 2026 年资料与官方来源' }
    )
    expect(steered.ok).toBe(true)
    await expect(page.locator('.research-steer-pending')).toContainText('下一轮优先处理')

    // 等待两轮自动续研完成
    const final = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return { research: session?.research ?? null, messages: session?.messages ?? [] }
      })
      return result.research?.status === 'completed' ? result : null
    }, 90_000, '研究完成')
    expect(final.research).toMatchObject({
      status: 'completed',
      depth: 'quick',
      round: 2,
      minSources: 4
    })
    expect(final.research.sourceCount).toBeGreaterThanOrEqual(4)
    expect(final.research.plan).toContain('优先 2026 年资料')
    expect(final.messages.some((message: { hidden?: boolean; displayText?: string }) => message.hidden)).toBe(true)

    // 研究条：真实轮次/来源/报告入口；内部补查提示不出现在对话里
    const bar = page.locator('.research-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('已完成')
    await expect(bar).toContainText('来源 4/4')
    await expect(bar).toContainText('第 2/2 轮')
    await expect(page.getByText('继续这项深度研究')).toHaveCount(0)
    const reportButton = bar.getByRole('button', { name: '打开研究报告' })
    if (!(await reportButton.isVisible().catch(() => false))) {
      await bar.locator('.research-bar-toggle').click()
    }
    await expect(bar.getByRole('button', { name: '打开研究报告' })).toBeVisible()

    // 来源面板来自真实 web_search 结果（两轮共 4 个独立 URL）
    await expect(page.locator('.sources-tray')).toBeVisible()
    await page.locator('.sources-head').click()
    await expect(page.locator('.sources-item')).toHaveCount(4)
    await page.locator('.sources-head').click()

    await page.screenshot({ path: screenshotPath('a4-deep-research.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-deep-research-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 报告打开到画布
    await bar.getByRole('button', { name: '打开研究报告' }).click()
    await expect(page.locator('.canvas-head-title')).toContainText('研究报告', { timeout: 15_000 })

    // 研究模式的系统提示与工具白名单：有 web_search，无写文件/命令（跳过可能的连接探测请求）
    const researchRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('深度研究模式')
    )
    const system = JSON.stringify(
      (researchRequest?.body as { messages?: Array<{ content: unknown }> } | undefined)?.messages?.[0]?.content ?? ''
    )
    expect(system).toContain('优先 2026 年资料')
    const planRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('制定计划阶段')
    )
    const planTools = ((planRequest?.body as { tools?: unknown[] } | undefined)?.tools ?? []) as unknown[]
    expect(planTools).toHaveLength(0)
    expect(mock.requests.some((request) => JSON.stringify(request.body ?? {}).includes('补充关注 2026 年资料与官方来源'))).toBe(true)
    const toolNames = (
      (((researchRequest?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ??
        []) as Array<{ function?: { name?: string } }>)
    ).map((tool) => tool.function?.name ?? '')
    expect(system).toContain('深度研究模式')
    expect(system).toContain('研究模式固定只读资料与联网查证')
    expect(toolNames).toContain('web_search')
    expect(toolNames).not.toContain('run_command')
    expect(toolNames).not.toContain('write_file')
    expect(search.queries.length).toBeGreaterThanOrEqual(2)
  })

  test('关闭联网搜索时拒绝开始深度研究', async () => {
    test.setTimeout(90_000)
    mock = await startMockLLM({ scripts: [{ text: '不应该运行到这里。' }] })
    morrow = await launchMorrow({ name: 'a4-research-no-search', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().saveWebSearch({ enabled: false, provider: 'builtin', maxResults: 3 })
    })
    await createSession(page, {
      workspace: workspaceAt('a4-research-no-search-ws'),
      ...provider,
      permissionMode: 'auto',
      title: '研究缺少联网'
    })
    await page.locator('.composer-input').fill('/research 研究一个需要联网的问题。')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.toast-item.toast-error')).toContainText('配置联网搜索', { timeout: 15_000 })
    const state = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.research ?? null
    })
    expect(state?.status ?? null).not.toBe('searching')
  })
})

})

// ── 原文件：r10-connectors.spec.ts ──────────────────────────────────────────────
test.describe('r10-connectors.spec.ts', () => {
/**
 * R10-G 连接器管理面板 E2E（真实 Electron + 真实主进程 feature IPC + 真实文件/加密）。
 *
 * 无 LLM、不联网、不产生费用：
 * 1. 从设置 → 功能与工具打开连接器面板；
 * 2. 通过面板 UI 添加 Streamable HTTP MCP 连接器（本地 mock server），测试连接 → 工具列表；
 * 3. 保存后验证真实落盘：`<dataDir>/mcp.json` 只有 `$MORROW_SECRET:` 标记，密钥加密文件无明文；
 * 4. 再次测试已保存连接器：解密后的 Authorization 请求头真实发到 mock server；
 * 5. 启停开关、SSRF 拒绝（localhost 未勾选 allowPrivateNetwork）、file:// 协议拒绝、删除清理；
 * 6. catalog 条目名合法、地址与运行时字段完整；截图深色面板。
 */

type InvokeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MockMcpServer {
  url: string
  requests: Array<{ method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }>
  close: () => Promise<void>
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'e2e-mock-http', version: '1.0.0' }
}

const TOOLS_RESULT = {
  tools: [
    {
      name: 'echo',
      description: '原样返回参数（E2E mock）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'list_items', description: '分页清单', inputSchema: { type: 'object', properties: {} } }
  ]
}

/** 本地 Streamable HTTP MCP mock：POST JSON-RPC / JSON 响应 / Mcp-Session-Id */
async function startMockMcp(): Promise<MockMcpServer> {
  const sockets = new Set<Socket>()
  const requests: MockMcpServer['requests'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let message: Record<string, unknown> | null = null
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        message = null
      }
      requests.push({ method: typeof message?.method === 'string' ? message.method : '', headers: req.headers, body: message })
      if (!message) {
        res.writeHead(400)
        res.end()
        return
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id, result }))
      }
      if (message.method === 'initialize') {
        reply(INITIALIZE_RESULT, { 'Mcp-Session-Id': 'e2e-session' })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        reply(TOOLS_RESULT)
        return
      }
      if (message.method === 'resources/list') {
        reply({ resources: [{ uri: 'memo://notes/1', name: 'Notes', mimeType: 'text/plain' }] })
        return
      }
      if (message.method === 'resources/templates/list') {
        reply({ resourceTemplates: [{ uriTemplate: 'memo://notes/{id}', name: 'Note' }] })
        return
      }
      if (message.method === 'resources/read') {
        reply({ contents: [{ uri: 'memo://notes/1', mimeType: 'text/plain', text: '# Note' }] })
        return
      }
      if (message.method === 'prompts/list') {
        reply({ prompts: [{ name: 'summarize', description: '总结主题', arguments: [{ name: 'topic', required: true }] }] })
        return
      }
      if (message.method === 'prompts/get') {
        reply({ messages: [{ role: 'user', content: { type: 'text', text: '请总结：MCP' } }] })
        return
      }
      if (message.method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        reply({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock MCP server 未监听')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

async function invoke<T>(page: MorrowApp['page'], channel: string, payload?: unknown): Promise<InvokeResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      return window.morrow.features.invoke(arg.channel, arg.payload) as Promise<InvokeResult<T>>
    },
    { channel, payload }
  )
}

function readMcpJson(dataDir: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>
  }
}

async function openConnectorsPanel(morrow: MorrowApp): Promise<void> {
  const { page } = morrow
  await dismissOnboarding(page)
  await waitForStoreReady(page)
  await openToolPanel(page, '连接器')
  await expect(page.getByTestId('connectors-panel')).toBeVisible({ timeout: 15_000 })
  // 外层模态不滚动；左右两栏各自在面板内部滚动
  const bodyOverflow = await page
    .getByRole('dialog', { name: '外部工具（MCP）' })
    .evaluate((panel) => {
      const body = panel.querySelector<HTMLElement>('.modal-body')
      return body ? body.scrollHeight - body.clientHeight : null
    })
  expect(bodyOverflow).not.toBeNull()
  expect(bodyOverflow!).toBeLessThanOrEqual(1)
  const pathFits = await page.locator('.conn-path').evaluate((element) => {
    return element.clientHeight > 0 && element.scrollHeight <= element.clientHeight + 1
  })
  expect(pathFits).toBe(true)
}

test.describe('R10-G 连接器管理面板', () => {
  let morrow: MorrowApp | null = null
  let mock: MockMcpServer | null = null

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    await mock?.close()
    mock = null
  })

  test('HTTP 连接器：测试连接 → 保存（密钥加密）→ 再测（解密发请求）→ 启停 → SSRF/文件协议拒绝 → 删除', async () => {
    mock = await startMockMcp()
    morrow = await launchMorrow({ name: 'r10-connectors', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    // feature IPC 已注册：目录条目名称合法、远程/本机字段完整
    const catalog = await invoke<{ entries: Array<{ name: string; transport: string; requiresNpx: boolean; docsUrl: string }> }>(
      page,
      'feature:connectors:catalog',
      {}
    )
    expect(catalog.ok).toBe(true)
    if (catalog.ok) {
      expect(catalog.data.entries.length).toBeGreaterThanOrEqual(8)
      expect(catalog.data.entries.every((entry) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name))).toBe(true)
      expect(catalog.data.entries.every((entry) => entry.docsUrl.startsWith('https://'))).toBe(true)
    }

    // ── 1) 添加 HTTP 连接器（未勾选允许本机 → 先看 SSRF 拒绝）
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill(mock.url)

    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-error')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-reason')).toHaveText('ssrf-blocked')
    await expect(page.locator('.conn-test-error')).toContainText('允许访问本机/内网地址')

    // 勾选显式允许本机地址后测试成功
    await page.getByRole('switch', { name: '允许访问本机/内网地址' }).click()
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-ok')).toContainText('连接成功')
    await expect(page.locator('.conn-test-ok')).toContainText('echo')
    await expect(page.locator('.conn-test-ok')).toContainText('list_items')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个资源')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个提示词')
    await expect(page.locator('.conn-catalog').filter({ hasText: 'memo://notes/1' })).toBeVisible()
    await expect(page.locator('.conn-catalog').filter({ hasText: 'summarize' })).toBeVisible()

    // ── 2) 加一个鉴权请求头（密钥只写不读）
    await page.locator('.conn-secrets').getByRole('button', { name: '添加' }).click()
    await page.getByLabel('请求头 headers键名').fill('Authorization')
    await page.getByLabel('请求头 headers值').fill('Bearer e2e-secret-token')

    // OAuth 端点保存后由后端加密保管令牌；这里验证 UI 字段与配置落盘
    await page.getByLabel('授权地址').fill('https://auth.example.com/oauth/authorize')
    await page.getByLabel('令牌地址').fill('https://auth.example.com/oauth/token')
    await page.getByLabel('Client ID').fill('e2e-client')
    await page.getByLabel('Scope（空格分隔）').fill('read write')
    await page.getByLabel('授权地址').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('mcp-oauth-dark.png') })

    // ── 3) 保存并验证真实落盘（加密标记，无明文）
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toBeVisible({ timeout: 15_000 })
    const config = readMcpJson(dataDir)
    const saved = config.mcpServers['e2e-http']
    expect(saved).toBeTruthy()
    expect(saved.transport).toBe('http')
    expect(saved.url).toBe(mock.url)
    expect(saved.oauth).toMatchObject({
      authorizationUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'e2e-client',
      scopes: ['read', 'write']
    })
    await expect(page.locator('.conn-oauth-status')).toContainText('未授权', { timeout: 10_000 })
    const headers = saved.headers as Record<string, string>
    expect(headers.Authorization.startsWith('$MORROW_SECRET:')).toBe(true)
    const rawConfigText = readFileSync(join(dataDir, 'mcp.json'), 'utf8')
    expect(rawConfigText).not.toContain('e2e-secret-token')
    expect(existsSync(join(dataDir, 'mcp-secrets.json'))).toBe(true)
    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('e2e-secret-token')

    // 列表视图只显示掩码，渲染层拿不到明文
    const list = await invoke<{ connectors: Array<{ name: string; headers: Array<{ masked: string; hasSecret: boolean }> }> }>(
      page,
      'feature:connectors:list',
      { scope: 'user' }
    )
    expect(list.ok).toBe(true)
    if (list.ok) {
      const view = list.data.connectors.find((item) => item.name === 'e2e-http')
      expect(view?.headers[0]).toMatchObject({ masked: '••••••••', hasSecret: true })
      expect(JSON.stringify(list.data)).not.toContain('e2e-secret-token')
    }

    // ── 4) 再测已保存连接器：主进程解密密钥，Authorization 真实到达 mock server
    mock.requests.length = 0
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    const toolsListRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(toolsListRequest?.headers.authorization).toBe('Bearer e2e-secret-token')
    expect(toolsListRequest?.headers['mcp-session-id']).toBe('e2e-session')

    // 截图证据 2：工具列表与测试结果（滚到编辑区底部）
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r10-connectors-tools.png') })

    // 截图证据 1（面板 + 已保存连接器）：把编辑区滚回顶部，保证截图完整
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-connectors-panel.png') })

    // ── 4.1) 同名新建被拒绝：不得覆盖已有连接器或其密钥
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('https://evil.example.com/mcp')
    await page.getByRole('button', { name: '保存' }).click()
    const duplicateAlert = page.getByRole('alert').filter({ hasText: '操作失败' })
    await expect(duplicateAlert).toBeVisible({ timeout: 10_000 })
    await expect(duplicateAlert).toContainText('已被另一个外部工具使用')
    const duplicateConfig = readMcpJson(dataDir).mcpServers['e2e-http']
    expect(duplicateConfig?.url).toBe(mock.url)
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-dark.png') })
    await page.getByRole('button', { name: '取消' }).click()

    // ── 5) 启停开关真实写盘
    const item = page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBe(true)
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBeUndefined()

    // ── 6) file:// 协议被配置校验拒绝
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-bad-url')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('file:///C:/Windows/win.ini')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toContainText('只允许 http://')
    await page.getByRole('button', { name: '取消' }).click()

    // ── 7) 删除连接器：列表与磁盘都清理
    await page.getByTestId('connector-item').filter({ hasText: 'e2e-http' }).locator('.conn-item-main').click()
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http'] ?? null, { timeout: 10_000 })
      .toBeNull()
    const secretsAfterDelete = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')) as {
      entries: Record<string, string>
    }
    expect(Object.keys(secretsAfterDelete.entries).filter((key) => key.includes('e2e-http'))).toHaveLength(0)
  })

  test('工作区级配置：未打开工作区时明确提示，且不写入 .morrow', async () => {
    morrow = await launchMorrow({ name: 'r10-connectors-ws', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    await page.getByRole('radio', { name: '当前文件夹' }).click()
    await expect(page.getByTestId('connectors-panel')).toContainText('需要先选择一个文件夹')

    // 用户级配置路径可见；工作区级路径不存在
    const paths = await invoke<{ userConfigPath: string; workspaceConfigPath: string | null }>(page, 'feature:connectors:paths', {})
    expect(paths.ok).toBe(true)
    if (paths.ok) {
      expect(paths.data.userConfigPath.startsWith(dataDir)).toBe(true)
      expect(paths.data.workspaceConfigPath).toBeNull()
    }

    // 切换回用户级仍可用
    await page.getByRole('radio', { name: '所有对话' }).click()
    await expect(page.getByRole('button', { name: '添加外部工具' })).toBeVisible()
  })
})

})

// ── 原文件：r10-memory-projects.spec.ts ──────────────────────────────────────────────
test.describe('r10-memory-projects.spec.ts', () => {
/**
 * R10-D/E 记忆中心 + Projects E2E —— 真实 Electron（真实 preload → feature IPC → 主进程服务 → 磁盘）。
 *
 * 覆盖：
 * 1. 旧 `.morrow/MEMORY.md` 在真实应用里自动迁移（幂等），项目/全局记忆 CRUD、启停过滤、搜索、导出、
 *    注入预览（只含启用条目 + token 预算）全部通过 `window.morrow.features.invoke('feature:memory:*')` 验证；
 * 2. 项目 CRUD/指令/知识文件、工作区边界（越界路径被真实主进程拒绝）、上下文生成（指令+知识+记忆）与跨项目隔离；
 * 3. 关闭应用后用同一 `--data-dir` 重启：记忆与项目仍在（会话文件与项目 JSON 落盘）。
 *
 * 不依赖面板挂载（Lead 在 App 里挂载后，可由 r10 验收补 UI 截图）；本 spec 验证的是产品真实数据链路。
 */

type FeatureResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MemoryEntryWire {
  id: string
  text: string
  tags: string[]
  source: string
  enabled: boolean
  scope: string
  workspace: string | null
}

interface MemoryListWire {
  entries: MemoryEntryWire[]
  stats: {
    total: number
    enabled: number
    disabled: number
    enabledTokens: number
    limitTokens: number
    migratedTotal: number
    legacyFileDetected: boolean
  }
}

interface MemoryInjectionWire {
  text: string
  usedTokens: number
  limitTokens: number
  included: number
  omitted: number
}

interface ProjectRecordWire {
  id: string
  workspace: string
  name: string
  instructions: string
  knowledgePaths: string[]
  active: boolean
  pinned: boolean
}

interface ProjectListWire {
  projects: Array<ProjectRecordWire & { workspaceExists: boolean; knowledgeCount: number }>
}

interface ProjectContextWire {
  text: string
  projectText: string
  memoryText: string
  knowledge: Array<{ path: string; excerpt?: string }>
  staleKnowledge: Array<{ path: string; error: string }>
  memory: { included: number } | null
  usedTokens: number
  limitTokens: number
  truncated: boolean
}

interface FeatureInvoker {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<FeatureResult<T>>
}

async function feature<T = unknown>(
  page: import('@playwright/test').Page,
  channel: string,
  payload?: unknown
): Promise<T> {
  const result = await page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: FeatureInvoker } }).morrow.features
      return api.invoke<T>(arg.channel, arg.payload)
    },
    { channel, payload }
  )
  if (!result.ok) throw new Error(`${channel} 失败：${result.error.code} ${result.error.message}`)
  return result.data
}

async function featureRaw<T = unknown>(
  page: import('@playwright/test').Page,
  channel: string,
  payload?: unknown
): Promise<FeatureResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: FeatureInvoker } }).morrow.features
      return api.invoke<T>(arg.channel, arg.payload)
    },
    { channel, payload }
  )
}

function seedLegacyMemory(workspace: string): void {
  const dir = join(workspace, '.morrow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'MEMORY.md'),
    [
      '# Morrow 项目记忆',
      '',
      '> 由 Morrow 自动记录，下次对话会作为背景知识注入。',
      '',
      '- [2026-10-01] E2E 迁移记忆：周报按季度口径汇总',
      '- [2026-10-02] E2E 迁移记忆：金额保留两位小数'
    ].join('\n'),
    'utf8'
  )
}

/** 通过工作台事件直接打开面板（与 TitleBar 扳手菜单等效，均为 Lead 挂载的真实组件） */
async function openWorkbenchPanel(
  page: import('@playwright/test').Page,
  panel: 'memory' | 'projects'
): Promise<void> {
  await page.evaluate((name: string) => {
    window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: name } }))
  }, panel)
}

async function setLastWorkspaceViaStore(page: import('@playwright/test').Page, workspace: string): Promise<void> {
  await page.evaluate(async (path: string) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().updateSettings({ lastWorkspace: path })
  }, workspace)
}

test.describe('R10-D/E 记忆中心与 Projects', () => {
  test('迁移/CRUD/启停注入 + 项目 CRUD/隔离/上下文 + 重启持久化', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-ws-${stamp}`)
    const workspaceB = join(root, 'tmp', `r10-memproj-ws-b-${stamp}`)
    const outside = join(root, 'tmp', `r10-memproj-outside-${stamp}`)
    for (const dir of [workspace, workspaceB, outside]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(workspace, 'docs-brief.md'), '# 项目资料\nCANARY_A_KNOWLEDGE：A 项目专属资料。', 'utf8')
    writeFileSync(join(workspace, 'numbers.csv'), 'quarter,sales\nQ3,123', 'utf8')
    writeFileSync(join(workspaceB, 'brief.md'), 'CANARY_B_KNOWLEDGE：B 项目专属资料。', 'utf8')
    writeFileSync(join(outside, 'secret.md'), 'OUTSIDE_CANARY：工作区外文件。', 'utf8')
    seedLegacyMemory(workspace)

    const dataDir = join(root, 'tmp', `r10-memproj-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-chromium-${stamp}`)

    let projectAId = ''
    const first = await launchMorrow({ name: 'r10-memproj-1', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 记忆 IPC 只接受已登记工作区；模拟用户已选择这个文件夹
      await setLastWorkspaceViaStore(page, workspace)

      /* ── 1) 旧 MEMORY.md 迁移 + scope 隔离 ── */
      const migrated = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(migrated.entries.length).toBe(2)
      expect(migrated.entries.every((entry) => entry.source === 'migration')).toBe(true)
      expect(migrated.stats.migratedTotal).toBe(2)
      expect(migrated.stats.legacyFileDetected).toBe(true)

      const globalEmpty = await feature<MemoryListWire>(page, 'feature:memory:list', { scope: 'global' })
      expect(globalEmpty.entries.length).toBe(0)

      /* ── 2) CRUD：项目记忆 / 全局记忆 / 启停 / 搜索 / 更新 ── */
      const projectEntry = await feature<{ entry: MemoryEntryWire }>(page, 'feature:memory:add', {
        scope: 'project',
        workspace,
        text: 'E2E 项目记忆：报告标题使用「季度经营分析」',
        tags: ['报告', '标题']
      })
      const globalEntry = await feature<{ entry: MemoryEntryWire }>(page, 'feature:memory:add', {
        scope: 'global',
        text: 'E2E 全局记忆：始终使用简体中文',
        tags: ['语言']
      })
      expect(projectEntry.entry.scope).toBe('project')
      expect(globalEntry.entry.scope).toBe('global')

      // 未登记的同级目录不能作为项目记忆工作区（防止向任意目录写 .morrow）
      const unregisteredAdd = await featureRaw(page, 'feature:memory:add', {
        scope: 'project',
        workspace: outside,
        text: '不应写入未登记工作区'
      })
      expect(unregisteredAdd.ok).toBe(false)
      expect(unregisteredAdd.error?.message).toContain('已登记')
      const unregisteredInjection = await featureRaw(page, 'feature:memory:injection', { workspace: outside })
      expect(unregisteredInjection.ok).toBe(false)
      expect(existsSync(join(outside, '.morrow'))).toBe(false)

      await feature(page, 'feature:memory:update', {
        scope: 'project',
        workspace,
        id: projectEntry.entry.id,
        text: 'E2E 项目记忆（已更新）：报告标题使用「季度经营分析」'
      })
      const disabledMigration = migrated.entries.find((entry) => entry.text.includes('金额保留两位小数'))!
      await feature(page, 'feature:memory:toggle', {
        scope: 'project',
        workspace,
        id: disabledMigration.id,
        enabled: false
      })

      const searched = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        query: '经营分析',
        includeDisabled: true
      })
      expect(searched.entries.map((entry) => entry.text).join('')).toContain('季度经营分析')

      const withDisabled = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(withDisabled.stats.disabled).toBe(1)
      expect(withDisabled.stats.enabled).toBe(2) // 3 条 - 1 条停用

      /* ── 3) 注入预览：只含启用条目、预算内、停用不出现 ── */
      const injection = await feature<MemoryInjectionWire>(page, 'feature:memory:injection', {
        workspace,
        maxTokens: 600
      })
      expect(injection.text).toContain('始终使用简体中文')
      expect(injection.text).toContain('已更新')
      expect(injection.text).not.toContain('金额保留两位小数')
      expect(injection.usedTokens).toBeLessThanOrEqual(injection.limitTokens)
      expect(injection.omitted).toBe(0)
      expect(injection.included).toBe(3) // 项目 2（1 迁移启用 + 1 新增）+ 全局 1

      /* ── 4) 导出 ── */
      const exported = await feature<{ markdown: string; json: string; count: number; fileName: string }>(
        page,
        'feature:memory:export',
        { scope: 'project', workspace }
      )
      expect(exported.count).toBe(3)
      expect(exported.markdown).toContain('E2E 项目记忆')
      expect(JSON.parse(exported.json).count).toBe(3)
      expect(exported.fileName).toMatch(/morrow-memory-project-/)

      /* ── 5) 项目 CRUD + 工作区边界 ── */
      const projectA = await feature<ProjectRecordWire>(page, 'feature:projects:create', {
        workspace,
        name: 'E2E 经营分析项目',
        description: 'E2E 项目描述',
        instructions: 'E2E 项目指令：金额保留两位小数；不要改原始数据。',
        knowledgePaths: ['docs-brief.md', 'numbers.csv'],
        pinned: true
      })
      projectAId = projectA.id
      expect(projectA.knowledgePaths).toEqual(['docs-brief.md', 'numbers.csv'])
      expect(projectA.active).toBe(true)

      const projectB = await feature<ProjectRecordWire>(page, 'feature:projects:create', {
        workspace: workspaceB,
        name: 'E2E B 项目',
        instructions: 'B 项目指令：CANARY_B_INSTRUCTION',
        knowledgePaths: ['brief.md']
      })

      const duplicate = await featureRaw(page, 'feature:projects:create', { workspace })
      expect(duplicate.ok).toBe(false)

      const outsideKnowledge = await featureRaw(page, 'feature:projects:knowledge-validate', {
        workspace,
        path: join(outside, 'secret.md')
      })
      expect(outsideKnowledge.ok).toBe(false)
      expect(!outsideKnowledge.ok && outsideKnowledge.error.message).toMatch(/工作区内/)

      const relativeEscape = await featureRaw(page, 'feature:projects:knowledge-validate', {
        workspace,
        path: '../r10-memproj-outside'
      })
      expect(relativeEscape.ok).toBe(false)

      /* ── 6) 上下文生成：指令 + 知识摘要 + 记忆；跨项目隔离 ── */
      const contextA = await feature<ProjectContextWire>(page, 'feature:projects:context', {
        workspace,
        memoryTokens: 400
      })
      expect(contextA.text).toContain('E2E 项目指令')
      expect(contextA.text).toContain('CANARY_A_KNOWLEDGE')
      expect(contextA.text).toContain('E2E 项目描述')
      expect(contextA.text).toContain('始终使用简体中文')
      expect(contextA.text).toContain('E2E 项目记忆（已更新）')
      expect(contextA.text).not.toContain('CANARY_B_')
      expect(contextA.text).toContain('不可信数据')
      expect(contextA.knowledge.length).toBe(2)
      expect(contextA.usedTokens).toBeLessThanOrEqual(contextA.limitTokens)

      const contextB = await feature<ProjectContextWire>(page, 'feature:projects:context', {
        workspace: workspaceB,
        memoryTokens: 0
      })
      expect(contextB.text).toContain('CANARY_B_INSTRUCTION')
      expect(contextB.text).toContain('CANARY_B_KNOWLEDGE')
      expect(contextB.text).not.toContain('CANARY_A_KNOWLEDGE')
      expect(contextB.text).not.toContain('E2E 项目记忆')

      /* ── 7) 停用项目后不注入（ignoreActive 仍可预览） ── */
      await feature(page, 'feature:projects:set-active', { id: projectA.id, active: false })
      const inactiveContext = await feature<ProjectContextWire | null>(page, 'feature:projects:context', { workspace })
      expect(inactiveContext).toBeNull()
      const preview = await feature<ProjectContextWire | null>(page, 'feature:projects:context', {
        workspace,
        ignoreActive: true
      })
      expect(preview).not.toBeNull()
      await feature(page, 'feature:projects:set-active', { id: projectA.id, active: true })

      /* ── 8) 更新指令 + 列表摘要 ── */
      await feature(page, 'feature:projects:update', {
        id: projectA.id,
        instructions: 'E2E 项目指令（更新）：报告必须给出数据来源。'
      })
      const list = await feature<ProjectListWire>(page, 'feature:projects:list')
      expect(list.projects.length).toBe(2)
      const listedA = list.projects.find((project) => project.id === projectA.id)!
      expect(listedA.instructions).toContain('数据来源')
      expect(listedA.pinned).toBe(true)
      expect(listedA.knowledgeCount).toBe(2)
      expect(listedA.workspaceExists).toBe(true)
      expect(list.projects.find((project) => project.id === projectB.id)?.workspaceExists).toBe(true)

      await page.screenshot({ path: screenshotPath('r10-memory-projects-e2e.png') })

      /* ── 9) 磁盘证据：项目 JSON / 项目记忆 JSON / 全局记忆 JSON ── */
      const projectsFile = readFileSync(join(dataDir, 'projects', 'projects.json'), 'utf8')
      expect(projectsFile).toContain('E2E 经营分析项目')
      const projectMemoriesFile = readFileSync(join(workspace, '.morrow', 'memories.json'), 'utf8')
      expect(projectMemoriesFile).toContain('E2E 项目记忆')
      const globalMemoriesFile = readFileSync(join(dataDir, 'memories', 'global.json'), 'utf8')
      expect(globalMemoriesFile).toContain('始终使用简体中文')
    } finally {
      await first.close()
    }

    /* ── 10) 重启（同一 dataDir）后数据仍在 ── */
    const second = await launchMorrow({ name: 'r10-memproj-2', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      await waitForStoreReady(page)

      const memories = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(memories.entries.length).toBe(3)
      expect(memories.stats.migratedTotal).toBe(2)
      const globals = await feature<MemoryListWire>(page, 'feature:memory:list', { scope: 'global' })
      expect(globals.entries.map((entry) => entry.text).join('')).toContain('始终使用简体中文')

      const projects = await feature<ProjectListWire>(page, 'feature:projects:list')
      const restored = projects.projects.find((project) => project.id === projectAId)
      expect(restored).toBeTruthy()
      expect(restored?.instructions).toContain('数据来源')
      expect(restored?.knowledgePaths).toEqual(['docs-brief.md', 'numbers.csv'])

      const contextAfterRestart = await feature<ProjectContextWire>(page, 'feature:projects:context', { workspace })
      expect(contextAfterRestart.text).toContain('CANARY_A_KNOWLEDGE')
      expect(contextAfterRestart.text).toContain('数据来源')

      // 项目记忆文件在重启后没有被重复迁移（幂等）
      const diskMemories = JSON.parse(readFileSync(join(workspace, '.morrow', 'memories.json'), 'utf8')) as {
        entries: Array<{ text: string }>
      }
      expect(diskMemories.entries.filter((entry) => entry.text.includes('金额保留两位小数'))).toHaveLength(1)
      expect(existsSync(join(workspaceB, 'brief.md'))).toBe(true)
    } finally {
      await second.close()
    }
  })

  test('UI：工作台 → 记忆中心添加/启停/注入预览（明暗截图）+ 项目面板编辑与上下文预览', async () => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-ui-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nUI_CANARY_KNOWLEDGE：项目知识内容。', 'utf8')
    seedLegacyMemory(workspace)
    const dataDir = join(root, 'tmp', `r10-memproj-ui-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-ui-chromium-${stamp}`)

    const morrow = await launchMorrow({ name: 'r10-memproj-ui', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await setLastWorkspaceViaStore(page, workspace)

      // 先通过真实 IPC 建一个项目（面板负责编辑/预览，不重复测 CRUD）
      await feature(page, 'feature:projects:create', {
        workspace,
        name: 'UI 项目',
        description: 'UI 描述',
        instructions: 'UI 项目指令：先给结论，再给数据来源。',
        knowledgePaths: ['brief.md']
      })

      /* ── 记忆中心 UI ── */
      await openWorkbenchPanel(page, 'memory')
      const memoryRoot = page.locator('.mc-root')
      await expect(memoryRoot).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.modal-title').filter({ hasText: '记忆' })).toBeVisible()
      // 旧 MEMORY.md 迁移条目出现在面板里
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆：周报按季度口径汇总')
      await expect(memoryRoot).toContainText('旧记忆已迁移')

      // 添加一条项目记忆
      await page.getByRole('button', { name: '添加记忆' }).click()
      await page.getByLabel('新的项目记忆').fill('UI 添加的记忆：图表使用香槟金主色。')
      await page.getByLabel('标签（可选，逗号分隔，最多 8 个）').fill('图表, UI')
      await page.getByRole('button', { name: '保存记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('UI 添加的记忆')
      await expect(page.locator('.mc-notice')).toContainText('已保存')

      // 行内停用 + 搜索
      const addedEntry = page.locator('.mc-entry').filter({ hasText: 'UI 添加的记忆' })
      await addedEntry.getByRole('switch', { name: '停用这条记忆' }).click()
      await expect(addedEntry).toContainText('已停用，不会参考')
      await page.getByLabel('搜索长期记忆').fill('UI 添加')
      await expect(page.locator('.mc-entry')).toHaveCount(1)
      await page.getByLabel('搜索长期记忆').fill('')

      // 切范围时必须清掉旧范围的清空确认，不能把「清空项目记忆」执行成「清空全局记忆」
      await page.getByRole('radio', { name: '全局记忆' }).click()
      await page.getByRole('button', { name: '添加记忆' }).click()
      await page.getByLabel('新的全局记忆').fill('UI 全局记忆：始终使用简体中文。')
      await page.getByRole('button', { name: '保存记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('UI 全局记忆')
      await page.getByRole('radio', { name: '项目记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆')
      await page.getByRole('button', { name: '清空项目记忆' }).click()
      await expect(page.getByRole('alertdialog', { name: '确认操作' })).toBeVisible()
      await page.getByRole('radio', { name: '全局记忆' }).click()
      await expect(page.getByRole('alertdialog', { name: '确认操作' })).toHaveCount(0)
      await expect(page.locator('.mc-list')).toContainText('UI 全局记忆')
      await page.getByRole('radio', { name: '项目记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆')

      // 注入预览（停用条目不出现，旧迁移条目与全局记忆出现）
      await page.getByRole('button', { name: 'Morrow 会参考的内容' }).click()
      const injection = page.locator('.mc-injection')
      await expect(injection).toBeVisible({ timeout: 10_000 })
      await expect(injection).toContainText('E2E 迁移记忆')
      await expect(injection).toContainText('UI 全局记忆')
      await expect(injection).not.toContainText('UI 添加的记忆')
      await expect(injection).toContainText('tokens')
      await page.evaluate(() => {
        document.querySelector('.modal-body')?.scrollTo(0, 0)
      })
      await page.screenshot({ path: screenshotPath('r10-memory-center-dark.png') })

      // 明色主题截图（沿用全局主题 tokens）
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('r10-memory-center-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.locator('.mc-foot').getByRole('button', { name: '关闭' }).click()
      await expect(page.locator('.mc-root')).toHaveCount(0)

      /* ── 项目面板 UI ── */
      await openWorkbenchPanel(page, 'projects')
      await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.modal-title').filter({ hasText: '项目' })).toBeVisible()
      await expect(page.locator('.pp-project')).toContainText('UI 项目')
      // 默认是项目主页（概览）：标题、项目内对话入口、说明与资料摘要
      await expect(page.locator('.pp-home-title')).toHaveText('UI 项目')
      await expect(page.locator('.pp-home-composer textarea')).toBeVisible()
      await expect(page.locator('.pp-home-cards')).toContainText('UI 项目指令：先给结论')
      await expect(page.locator('.pp-home-cards')).toContainText('brief.md')
      // 切到说明与资料：当前工作区项目默认被选中并带出完整指令
      await page.getByRole('tab', { name: '说明与资料' }).click()
      await expect(page.getByLabel('长期说明（Morrow 做任务时会参考）')).toHaveValue(/先给结论/)
      await expect(page.locator('.pp-knowledge-list')).toContainText('brief.md')
      // 知识文件会异步重新校验并显示真实大小（不是一直「校验中…」）
      await expect(page.locator('.pp-knowledge-size')).toContainText(/B|KB/i, { timeout: 10_000 })

      // 修改指令并保存
      await page.getByLabel('长期说明（Morrow 做任务时会参考）').fill('UI 项目指令（已保存）：先给结论，再给数据来源，并列出风险。')
      await page.getByRole('button', { name: '保存项目' }).click()
      await expect(page.locator('.pp-notice')).toContainText('项目已保存')

      // 上下文预览：指令 + 知识摘要 + 记忆
      await page.getByRole('button', { name: 'Morrow 会看到什么' }).click()
      const preview = page.locator('.pp-preview')
      await expect(preview).toBeVisible({ timeout: 10_000 })
      await expect(preview).toContainText('UI 项目指令（已保存）')
      await expect(preview).toContainText('UI_CANARY_KNOWLEDGE')
      await expect(preview).toContainText('E2E 迁移记忆')
      await preview.scrollIntoViewIfNeeded()
      await page.screenshot({ path: screenshotPath('r10-projects-context-preview.png') })

      // 通过真实 IPC 复核 UI 保存结果（四层互证：DOM/事件/IPC/磁盘）
      const projects = await feature<ProjectListWire>(page, 'feature:projects:list')
      const saved = projects.projects.find((project) => project.name === 'UI 项目')
      expect(saved?.instructions).toContain('并列出风险')
      const diskProject = readFileSync(join(dataDir, 'projects', 'projects.json'), 'utf8')
      expect(diskProject).toContain('并列出风险')
    } finally {
      await morrow.close()
    }
  })

  test('Agent 注入：项目指令 + 知识摘要 + 记忆真实进入 system prompt（mock LLM）', async () => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-inject-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nINJECT_CANARY_KNOWLEDGE：这份资料只在本项目里。', 'utf8')
    const dataDir = join(root, 'tmp', `r10-memproj-inject-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-inject-chromium-${stamp}`)
    // mock LLM：记录真实请求体（system prompt 在 OpenAI 兼容协议的 messages[0]）
    const mock = await startMockLLM({ scripts: [{ text: '收到，我会按项目规矩回答。' }] })

    const morrow = await launchMorrow({ name: 'r10-memproj-inject', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await setLastWorkspaceViaStore(page, workspace)
      await installEventCollector(page)
      const provider = await page.evaluate(async (url: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const config = {
          id: 'mock-r10-inject',
          kind: 'openai-compat',
          name: '本地 Mock（注入测试）',
          baseUrl: url,
          models: [{ id: 'mock-model', label: 'Mock Model', contextWindow: 32_000, supportsTools: true }],
          apiKeyStored: false,
          enabled: true
        }
        await store.getState().saveProvider({ config })
        return { providerId: config.id as string, modelId: 'mock-model' }
      }, mock.openaiBaseUrl)

      /* 项目 + 项目记忆 + 全局记忆都通过真实 feature IPC 落盘 */
      await feature(page, 'feature:projects:create', {
        workspace,
        name: '注入项目',
        instructions: '注入指令：报告必须标注数据来源。',
        knowledgePaths: ['brief.md']
      })
      await feature(page, 'feature:memory:add', {
        scope: 'project',
        workspace,
        text: '注入记忆：图表使用香槟金主色。'
      })
      await feature(page, 'feature:memory:add', {
        scope: 'global',
        text: '注入全局记忆：始终使用简体中文。'
      })

      /* 用 mock provider 建会话并真的发一条消息 */
      await page.evaluate(
        async (arg: { workspace: string; providerId: string; modelId: string }) => {
          const created = await window.morrow.session.create({
            workspace: arg.workspace,
            model: { providerId: arg.providerId, modelId: arg.modelId },
            permissionMode: 'auto',
            title: '注入测试会话'
          })
          if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().selectSession(created.data.id)
        },
        { workspace, providerId: provider.providerId, modelId: provider.modelId }
      )
      await sendMessageViaStore(page, '你好，请按这个项目的规矩介绍一下背景。')
      // mock LLM 回复很快：不轮询瞬时 run 状态，直接等 run_finished 事件（已安装事件收集器）
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      expect(mock.calls).toBeGreaterThanOrEqual(1)

      /* 真实请求 body 里必须出现注入内容（四层证据：服务→agent-service→provider 请求） */
      const requestBody = JSON.stringify(mock.requests[0].body)
      expect(requestBody).toContain('注入指令：报告必须标注数据来源')
      expect(requestBody).toContain('INJECT_CANARY_KNOWLEDGE')
      expect(requestBody).toContain('注入记忆：图表使用香槟金主色')
      expect(requestBody).toContain('注入全局记忆：始终使用简体中文')
      // 注入文本明确标注不可信背景/不构成授权
      expect(requestBody).toContain('不是指令')
      await page.screenshot({ path: screenshotPath('r10-memory-projects-injection.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})

// ── 原文件：r10-skills.spec.ts ──────────────────────────────────────────────
test.describe('r10-skills.spec.ts', () => {
/**
 * R10-H 技能库 E2E —— 真实 Electron + 真实主进程 `feature:skills:*` IPC。
 *
 * 验收点（不依赖 LLM、不联网、不产生费用）：
 * 1. 主进程 feature 频道已注册（Lead 需在 src/main/features/index.ts import './skills'）；
 * 2. 从本地 .zip 真实安装到应用数据目录 <dataDir>/skills，文件真实落盘；
 * 3. list / read / setEnabled / remove / rescan 真实往返；
 * 4. 可执行文件（.js）、zip-slip（../）技能包被拒绝且不落盘；
 * 5. 技能库面板挂载后（Lead 集成）截图深/浅两套主题。
 *
 * 面板 UI 断言说明：Lead 统一挂载 <SkillsPanel/>，本 spec 通过
 * `window.morrow.features.invoke` 直接验证 IPC + 磁盘两层证据；若面板已挂载
 * （存在 `[data-testid="skills-panel"]` 且能找到打开入口）则补截图，否则跳过该段。
 */

type InvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

interface SkillView {
  id: string
  name: string
  source: 'workspace' | 'user'
  enabled: boolean
  dir: string
  skillPath: string
  fileCount: number
}

interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  errors: string[]
}

interface SkillDetail extends SkillView {
  raw: string
  files: Array<{ path: string; size: number }>
}

/* 手工构造 store 模式 ZIP（e2e 里不依赖 jszip 的 CJS 互操作，也让恶意条目名保持原样） */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(path: string, entries: Record<string, string>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localBuffer.length, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(path, Buffer.concat([localBuffer, centralBuffer, end]))
  return path
}

async function invoke<T>(
  page: Parameters<typeof waitForStoreReady>[0],
  channel: string,
  payload?: unknown
): Promise<InvokeResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: channelPayload }) => {
      return (window as unknown as {
        morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
      }).morrow.features.invoke(channelName, channelPayload) as Promise<never>
    },
    { channel, payload }
  )
}

test.describe('R10-H 技能库（真实主进程 feature IPC）', () => {
  test('安装 / 读取 / 启停 / 删除 / 重扫 + 恶意 zip 拒绝', async () => {
    const morrow = await launchMorrow({ name: 'r10-skills', waitForSelector: '#root' })
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureDir = join(root, 'tmp', `r10-skills-fixtures-${fixtureId}`)
    mkdirSync(fixtureDir, { recursive: true })
    try {
      await waitForStoreReady(morrow.page)

      // 0. 频道必须已注册（Lead 在 features/index.ts import './skills'）
      const initial = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(initial.ok, `feature:skills:list 未注册或失败：${initial.ok ? '' : initial.error.message}`).toBe(true)
      if (!initial.ok) throw new Error('技能库 feature 频道未注册')
      const userDir = initial.data.userDir
      expect(userDir).toContain('skills')
      expect(initial.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review', 'debugging']))

      // 1. 从 zip 真实安装
      const zipPath = writeZip(join(fixtureDir, 'release-skill.zip'), {
        'release/SKILL.md': '---\nname: release\ndescription: E2E 安装的发版技能\n---\n# Release\n读取 changelog 并生成 release.json。',
        'release/checklist.md': '- 检查 changelog\n- 打 tag\n'
      })
      const installed = await invoke<{ installed: SkillView; snapshot: SkillsSnapshot }>(
        morrow.page,
        'feature:skills:install',
        { sourcePath: zipPath, workspace: null }
      )
      expect(installed.ok).toBe(true)
      if (!installed.ok) throw new Error(installed.error.message)
      const skill = installed.data.installed
      expect(skill).toMatchObject({ name: 'release', source: 'user', enabled: true })
      expect(existsSync(join(userDir, 'release', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(userDir, 'release', 'checklist.md'))).toBe(true)
      expect(readFileSync(join(userDir, 'release', 'SKILL.md'), 'utf8')).toContain('E2E 安装的发版技能')

      // 2. list / read
      const listed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error(listed.error.message)
      expect(listed.data.skills.map((item) => item.name)).toContain('release')
      const detail = await invoke<SkillDetail>(morrow.page, 'feature:skills:read', { id: skill.id, workspace: null })
      expect(detail.ok).toBe(true)
      if (!detail.ok) throw new Error(detail.error.message)
      expect(detail.data.raw).toContain('# Release')
      expect(detail.data.files.map((file) => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'checklist.md']))

      // 3. 启停（状态真实写盘）
      const disabled = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: false,
        workspace: null
      })
      expect(disabled.ok).toBe(true)
      if (!disabled.ok) throw new Error(disabled.error.message)
      expect(disabled.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(false)
      const stateFile = disabled.data.stateFile
      expect(readFileSync(stateFile, 'utf8')).toContain('"enabled": false')

      const enabledAgain = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: true,
        workspace: null
      })
      expect(enabledAgain.ok).toBe(true)
      if (!enabledAgain.ok) throw new Error(enabledAgain.error.message)
      expect(enabledAgain.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(true)

      // 4. 恶意技能包：可执行文件 & zip-slip 都要被拒绝且不落盘
      const exeZip = writeZip(join(fixtureDir, 'exe-skill.zip'), {
        'SKILL.md': '# Bad\nx',
        'run.js': 'console.log(1)'
      })
      const exeInstalled = await invoke<{ installed: SkillView; skipped: string[] }>(morrow.page, 'feature:skills:install', {
        sourcePath: exeZip,
        workspace: null
      })
      expect(exeInstalled.ok).toBe(true)
      if (!exeInstalled.ok) throw new Error(exeInstalled.error.message)
      expect(exeInstalled.data.skipped).toContain('run.js')
      expect(existsSync(join(userDir, 'exe-skill', 'run.js'))).toBe(false)
      await invoke(morrow.page, 'feature:skills:remove', { id: exeInstalled.data.installed.id, workspace: null })

      const evilZip = writeZip(join(fixtureDir, 'evil-skill.zip'), {
        'SKILL.md': '# Evil\nx',
        '../escaped.txt': 'pwned'
      })
      const evilRejected = await invoke(morrow.page, 'feature:skills:install', { sourcePath: evilZip, workspace: null })
      expect(evilRejected.ok).toBe(false)
      if (!evilRejected.ok) expect(evilRejected.error.message).toMatch(/zip-slip|越界/)
      expect(existsSync(join(userDir, '..', 'escaped.txt'))).toBe(false)
      expect(existsSync(join(morrow.dataDir, 'escaped.txt'))).toBe(false)

      // 5. rescan + remove
      const rescanned = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:rescan', { workspace: null })
      expect(rescanned.ok).toBe(true)
      if (!rescanned.ok) throw new Error(rescanned.error.message)
      expect(rescanned.data.errors).toEqual([])

      const removed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:remove', {
        id: skill.id,
        workspace: null
      })
      expect(removed.ok).toBe(true)
      if (!removed.ok) throw new Error(removed.error.message)
      expect(removed.data.skills.some((item) => item.name === 'release')).toBe(false)
      expect(removed.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review']))
      expect(existsSync(join(userDir, 'release'))).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      await morrow.close()
    }
  })

  test('面板 UI（工作台入口）：打开技能库并截图深/浅两套主题', async () => {
    const morrow = await launchMorrow({ name: 'r10-skills-ui', waitForSelector: '#root' })
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureDir = join(root, 'tmp', `r10-skills-ui-${fixtureId}`)
    mkdirSync(fixtureDir, { recursive: true })
    try {
      await waitForStoreReady(morrow.page)
      await dismissOnboarding(morrow.page)
      // 先安装一个真实技能，让面板截图里有内容（列表 + 详情 + SKILL.md）
      const zipPath = writeZip(join(fixtureDir, 'release-skill.zip'), {
        'release/SKILL.md':
          '---\nname: release\ndescription: E2E 安装的发版技能\n---\n# Release\n读取 changelog 并生成 release.json。\n',
        'release/checklist.md': '- 检查 changelog\n- 打 tag\n'
      })
      const installed = await invoke(morrow.page, 'feature:skills:install', { sourcePath: zipPath, workspace: null })
      expect(installed.ok).toBe(true)

      // 统一入口：设置 → 功能与工具 → 技能
      await openToolPanel(morrow.page, '技能库')
      await morrow.page.waitForSelector('[data-testid="skills-panel"]', { timeout: 10_000 })
      await morrow.page.waitForTimeout(300)
      const bodyOverflow = await morrow.page
        .getByRole('dialog', { name: '技能' })
        .evaluate((panel) => {
          const body = panel.querySelector<HTMLElement>('.modal-body')
          return body ? body.scrollHeight - body.clientHeight : null
        })
      expect(bodyOverflow).not.toBeNull()
      expect(bodyOverflow!).toBeLessThanOrEqual(1)
      // 内置技能随首次启动安装，面板里应能看到
      const builtin = morrow.page.getByRole('option', { name: /code-review/ }).first()
      await expect(builtin).toBeVisible()
      await builtin.click()
      await expect(morrow.page.getByText('代码审查').first()).toBeVisible()
      await morrow.page.screenshot({ path: screenshotPath('r10-skills-dark.png') })

      // 选中列表里的 release 技能（安装后默认选中第一个，这里显式点一下更稳）
      const card = morrow.page.getByRole('option', { name: /release/ }).first()
      if ((await card.count()) > 0) await card.click()
      await morrow.page.waitForTimeout(200)
      await morrow.page.screenshot({ path: screenshotPath('r10-skills-dark-detail.png') })

      await morrow.page.evaluate(() => {
        const state = (window as unknown as { __morrowStore?: { getState: () => Record<string, void> } }).__morrowStore
        ;(state?.getState().setTheme as ((theme: string) => void) | undefined)?.('light')
      })
      await morrow.page.waitForTimeout(400)
      await morrow.page.waitForTimeout(260)
      await morrow.page.screenshot({ path: screenshotPath('r10-skills-light.png') })
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      await morrow.close()
    }
  })
})

})

// ── 原文件：r10-panels.spec.ts ──────────────────────────────────────────────
test.describe('r10-panels.spec.ts', () => {
const PANELS: { card: string; file: string }[] = [
  { card: '技能库', file: 'r10-panel-skills.png' },
  { card: '记忆中心', file: 'r10-panel-memory.png' },
  { card: '项目', file: 'r10-panel-projects.png' },
  { card: '连接器', file: 'r10-panel-connectors.png' },
  { card: '全局搜索', file: 'r10-panel-search.png' },
  { card: '内置浏览器', file: 'r10-panel-browser.png' }
]

test.describe('功能面板集成', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('所有功能面板都能从设置 → 功能与工具打开/关闭', async () => {
    morrow = await launchMorrow({ name: 'r10-panels', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)
    for (const panel of PANELS) {
      await openToolPanel(page, panel.card)
      await page.waitForTimeout(800)
      await page.screenshot({ path: screenshotPath(panel.file) })
      if (panel.card === '内置浏览器') {
        await page.locator('.browser-close').click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(500)
    }
  })
})

})

// ── 原文件：r10-tools-settings.spec.ts ──────────────────────────────────────────────
test.describe('r10-tools-settings.spec.ts', () => {
test.describe('功能入口收敛', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('顶栏不再有工作台；功能入口集中在设置 → 功能与工具', async () => {
    morrow = await launchMorrow({ name: 'r10-tools-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)

    await expect(page.locator('[aria-label^="打开工作台"]')).toHaveCount(0)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible()
    await settings.getByRole('tab', { name: '功能与工具' }).click()
    await expect(settings.locator('.st-tool-row')).toHaveCount(8)
    await expect(settings.locator('.st-tool-row').filter({ hasText: '终端' })).toHaveCount(0)
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r10-tools-settings.png') })

    await settings.locator('.st-tool-row').filter({ hasText: '技能' }).click()
    await expect(page.getByTestId('skills-panel')).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('skills-panel')).toBeHidden()
  })
})

})

// ── 原文件：r10-ui-copy-review.spec.ts ──────────────────────────────────────────────
test.describe('r10-ui-copy-review.spec.ts', () => {
/**
 * R10 UI 文案/布局复审（真实 Electron；不调用真实模型）。
 *
 * 打开 6 个工作台面板 + 设置 + 文件树 + 编辑器，检查：
 * - 可见文案（写入 docs/audit/logs/r10-ui-copy-review.json，供术语堆砌复核）；
 * - 横向溢出（scrollWidth - clientWidth）；
 * - 截图 docs/verification/screens/r10-ui-copy-*.png。
 *
 * 运行：npm run build && npx playwright test tests/e2e/r10-ui-copy-review.spec.ts
 */

const PANELS = ['技能库', '记忆中心', '项目', '连接器', '全局搜索', '内置浏览器']

async function overflowOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel: string) => {
    const element = document.querySelector(sel) as HTMLElement | null
    if (!element) return -1
    return element.scrollWidth - element.clientWidth
  }, selector)
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement
    // 输入框只保留标签/占位符层级，避免把技术字段值当说明文案
    body.querySelectorAll('input, textarea, select').forEach((element) => {
      element.setAttribute('value', '')
    })
    return (body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 6000)
  })
}

test.describe('R10 UI 文案与布局复审', () => {
  let morrow: MorrowApp
  let page: Page
  const observations: Array<Record<string, unknown>> = []
  const workspace = join(root, 'tmp', `r10-ui-review-${Date.now()}`)

  test.beforeAll(async () => {
    const fixtureRoot = join(root, 'tmp', 'audit', 'r10', 'fixtures', 'ws-main')
    if (existsSync(fixtureRoot)) cpSync(fixtureRoot, workspace, { recursive: true })
    else mkdirSync(join(workspace, 'in'), { recursive: true })
    // 不依赖审计 fixtures 是否生成：编辑器用例自己准备一个中文文本文件
    mkdirSync(join(workspace, 'in'), { recursive: true })
    writeFileSync(join(workspace, 'in', '中文资料.txt'), '# 中文资料\n\n这是一份用于界面检查的中文文本。\n', 'utf8')
    morrow = await launchMorrow({ name: 'r10-ui-copy', waitForSelector: '.sidebar', timeoutMs: 90_000 })
    page = morrow.page
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ onboardingDone: true })
      await store.getState().newSession({ workspace: ws })
    }, workspace)
    await page.waitForTimeout(900)
  })

  test.afterAll(async () => {
    try {
      await morrow?.app.close()
    } catch {
      // ignore
    }
    rmSync(workspace, { recursive: true, force: true })
    mkdirSync(join(root, 'docs', 'audit', 'logs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'audit', 'logs', 'r10-ui-copy-review.json'), JSON.stringify(observations, null, 2), 'utf8')
  })

  test('6 面板 + 设置 + 文件树 + 编辑器截图与溢出检查', async () => {
    // 文件树
    await page.locator('.file-tree').waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('.sidebar').screenshot({ path: screenshotPath('r10-ui-copy-files.png') })
    observations.push({
      view: '文件树',
      overflow: await overflowOf(page, '.sidebar'),
      text: await page.locator('.file-tree').innerText()
    })

    // 功能面板 6 项
    for (const panel of PANELS) {
      await openToolPanel(page, panel)
      await page.waitForTimeout(750)
      await page.screenshot({ path: screenshotPath(`r10-ui-copy-${panel}.png`) })
      observations.push({
        view: panel,
        overflow: await overflowOf(page, 'body'),
        text: await visibleText(page)
      })
      if (panel === '内置浏览器') await page.locator('.browser-close').click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }

    // 设置
    const settingsButton = page.locator('[aria-label^="设置"]').last()
    await settingsButton.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: screenshotPath('r10-ui-copy-settings.png') })
    observations.push({ view: '设置', overflow: await overflowOf(page, 'body'), text: await visibleText(page) })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    // 编辑器（打开中文文件，420px 窄画布）
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().setCanvasWidth(420, false)
      window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path: 'in/中文资料.txt' } }))
    })
    await page.locator('.canvas-root .cm-editor').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(600)
    await page.locator('.canvas-root').screenshot({ path: screenshotPath('r10-ui-copy-editor.png') })
    observations.push({
      view: '编辑器',
      overflow: await overflowOf(page, '.canvas-root'),
      canvasWidth: await page.locator('.canvas-root').evaluate((element) => (element as HTMLElement).clientWidth),
      text: await page.locator('.canvas-root').innerText()
    })
  })
})

})
