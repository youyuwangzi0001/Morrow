/**
 * A6：临时对话与全量清除。
 * - 临时对话不写会话文件、不进入侧栏持久历史/搜索、不记 token 账本；
 * - 清除全部对话会删除会话文件、快照、检查点、成品版本、审批日志与用量，但不动工作区文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screensDir, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  dismissOnboarding,
  readStore,
  waitForStoreReady,
  waitUntil
} from './store'

test.describe('临时对话与清除全部', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('临时对话不落盘，清除全部只删对话派生数据', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '临时回答已生成。', delayMs: 50 },
        { text: '普通回答已生成。', delayMs: 50 },
        { text: '定时任务完成。', delayMs: 50 }
      ]
    })
    const workspace = join(root, 'tmp', `e2e-a6-${Date.now()}`)
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    writeFileSync(join(workspace, 'keep-me.txt'), '工作区文件必须保留', 'utf8')
    writeFileSync(join(workspace, '.morrow', 'MEMORY.md'), '秘密项目记忆XYZ：只应在普通对话出现。', 'utf8')
    morrow = await launchMorrow({ name: 'a6-temp-clear', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    await page.evaluate(async (path: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: path })
    }, workspace)

    const tokenBefore = await page.evaluate(async () => window.morrow.tokenActivity.get())

    // 1. 从侧栏创建临时对话
    await page.locator('.sb-temp').click()
    await expect(page.locator('.tb-temp-badge')).toBeVisible()
    await expect(page.getByRole('heading', { name: '临时 · 不保存' })).toBeVisible()
    const tempId = (await readStore(page)).activeSessionId
    expect(tempId).toBeTruthy()
    const tempFile = join(morrow.dataDir, 'sessions', `${tempId}.json`)
    expect(existsSync(tempFile)).toBe(false)

    await page.evaluate(
      async (arg: { id: string; provider: { providerId: string; modelId: string } }) => {
        const result = await window.morrow.session.setModel(arg.id, {
          providerId: arg.provider.providerId,
          modelId: arg.provider.modelId
        })
        if (!result.ok) throw new Error(result.error.message)
      },
      { id: tempId!, provider }
    )

    // 2. 真实跑一轮：保存走内存，不产生会话文件
    await page.locator('.composer-input').fill('这是一次临时任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('临时回答已生成。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '临时对话运行结束')
    expect(existsSync(tempFile)).toBe(false)
    const loadedTemp = await page.evaluate(async (id: string) => window.morrow.session.load(id), tempId!)
    expect(loadedTemp.ok).toBe(true)
    if (loadedTemp.ok) expect(loadedTemp.data.messages.length).toBeGreaterThan(1)

    const listed = await page.evaluate(async () => window.morrow.session.list())
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.data.some((item) => item.id === tempId)).toBe(false)

    const search = await page.evaluate(async () =>
      window.morrow.features.invoke<{ groups: { sessions: unknown[] } }>('feature:search:query', { q: '临时回答' })
    )
    expect(search.ok).toBe(true)
    if (search.ok) expect(search.data.groups.sessions).toHaveLength(0)

    const tokenAfterTemp = await page.evaluate(async () => window.morrow.tokenActivity.get())
    expect(tokenAfterTemp.ok && tokenBefore.ok ? tokenAfterTemp.data.total : 0).toBe(
      tokenBefore.ok ? tokenBefore.data.total : 0
    )

    // 临时对话不注入项目记忆，也不向模型暴露 remember 工具
    const systemText = (body: Record<string, any> | undefined): string => {
      if (!body) return ''
      if (typeof body.system === 'string') return body.system
      return (Array.isArray(body.messages) ? body.messages : [])
        .filter((message: { role?: string }) => message.role === 'system')
        .map((message: { content?: unknown }) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n')
    }
    const tempRequest = mock.requests[0]
    const tempSystem = systemText(tempRequest?.body)
    const tempTools = Array.isArray(tempRequest?.body?.tools)
      ? tempRequest.body.tools.map((tool: { function?: { name?: string }; name?: string }) => tool.function?.name ?? tool.name)
      : []
    expect(tempSystem).not.toContain('秘密项目记忆XYZ')
    expect(tempTools).not.toContain('remember')

    await page.waitForTimeout(280)
    await page.screenshot({ path: join(screensDir, 'a6-temp-chat.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a6-temp-chat-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 3. 普通对话会落盘，用来验证全量清除
    const normalId = await page.evaluate(async (providerArg: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      if (!created) throw new Error('普通对话创建失败')
      const result = await window.morrow.session.setModel(created.id, {
        providerId: providerArg.providerId,
        modelId: providerArg.modelId
      })
      if (!result.ok) throw new Error(result.error.message)
      return created.id as string
    }, provider)
    await page.locator('.composer-input').fill('这是一次普通任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('普通回答已生成。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '普通对话运行结束')
    const normalFile = join(morrow.dataDir, 'sessions', `${normalId}.json`)
    expect(existsSync(normalFile)).toBe(true)
    const normalRequest = mock.requests[mock.requests.length - 1]
    const normalSystem = systemText(normalRequest?.body)
    const normalTools = Array.isArray(normalRequest?.body?.tools)
      ? normalRequest.body.tools.map((tool: { function?: { name?: string }; name?: string }) => tool.function?.name ?? tool.name)
      : []
    expect(normalSystem).toContain('秘密项目记忆XYZ')
    expect(normalTools).toContain('remember')

    // 定时任务运行后会引用自己的会话；清除全部对话时这些引用与运行历史也要一起清掉
    const scheduledTask = await page.evaluate(async (workspacePath: string) => {
      const created = await window.morrow.features.invoke<{ task: { id: string } }>('feature:schedules:create', {
        title: '清除测试定时任务',
        prompt: '给出一个简短的完成确认。',
        schedule: { kind: 'daily', time: '23:59' },
        workspace: workspacePath,
        permissionMode: 'read-only',
        enabled: true
      })
      if (!created.ok) throw new Error(created.error.message)
      const ran = await window.morrow.features.invoke('feature:schedules:run-now', { id: created.data.task.id })
      if (!ran.ok) throw new Error(ran.error.message)
      return created.data.task
    }, workspace)
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    await waitUntil(async () => {
      const raw = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
        tasks: Array<{ id: string; lastStatus: string; lastSessionId?: string }>
      }
      const task = raw.tasks.find((item) => item.id === scheduledTask.id)
      return task?.lastStatus === 'success' && task.lastSessionId ? task : null
    }, 30_000, '定时任务运行完成')

    // 4. 制造需要随对话一起清除的派生数据
    const checkpointDir = join(morrow.dataDir, 'checkpoints', normalId)
    const snapshotDir = join(morrow.dataDir, 'snapshots', normalId)
    const versionDir = join(morrow.dataDir, 'artifact-versions', normalId, 'a1')
    mkdirSync(checkpointDir, { recursive: true })
    mkdirSync(snapshotDir, { recursive: true })
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(join(checkpointDir, 'c1.json'), '{}', 'utf8')
    writeFileSync(join(snapshotDir, 's1.txt'), 'snapshot', 'utf8')
    writeFileSync(join(versionDir, 'v1.json'), '{}', 'utf8')
    mkdirSync(join(morrow.dataDir, 'permissions'), { recursive: true })
    writeFileSync(join(morrow.dataDir, 'permissions', 'approval-log.jsonl'), '{"toolName":"x"}\n', 'utf8')

    // 5. 设置 → 归档 → 清除全部对话
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    await page.locator('.st-danger-zone').getByRole('button', { name: '清除全部对话…' }).click()
    await expect(page.getByRole('heading', { name: '清除全部对话？' })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(screensDir, 'a6-clear-confirm.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a6-clear-confirm-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.getByRole('button', { name: '确认清除' }).click()

    await waitUntil(async () => (await readStore(page)).sessions.length === 0, 30_000, '对话列表清空')
    await expect(page.locator('.welcome')).toBeVisible({ timeout: 15_000 })
    expect(readdirSync(join(morrow.dataDir, 'sessions'))).toEqual([])
    expect(existsSync(checkpointDir)).toBe(false)
    expect(existsSync(snapshotDir)).toBe(false)
    expect(existsSync(join(morrow.dataDir, 'artifact-versions', normalId))).toBe(false)
    expect(existsSync(join(morrow.dataDir, 'permissions', 'approval-log.jsonl'))).toBe(false)

    const tokenAfterClear = await page.evaluate(async () => window.morrow.tokenActivity.get())
    expect(tokenAfterClear.ok).toBe(true)
    if (tokenAfterClear.ok) expect(tokenAfterClear.data.total).toBe(0)

    const oldSession = await page.evaluate(async (id: string) => window.morrow.session.load(id), normalId)
    expect(oldSession.ok).toBe(false)
    const searchAfterClear = await page.evaluate(async () =>
      window.morrow.features.invoke<{ groups: { sessions: unknown[] } }>('feature:search:query', { q: '普通回答' })
    )
    expect(searchAfterClear.ok).toBe(true)
    if (searchAfterClear.ok) expect(searchAfterClear.data.groups.sessions).toHaveLength(0)

    const schedulesAfter = await page.evaluate(async () =>
      window.morrow.features.invoke<{
        tasks: Array<{ id: string; lastStatus: string; lastSessionId?: string; lastRunAt: number | null; nextRunAt: number | null }>
      }>('feature:schedules:list')
    )
    expect(schedulesAfter.ok).toBe(true)
    if (schedulesAfter.ok) {
      const task = schedulesAfter.data.tasks.find((item) => item.id === scheduledTask.id)
      expect(task).toBeTruthy()
      expect(task?.lastSessionId).toBeUndefined()
      expect(task?.lastStatus).toBe('never')
      expect(task?.lastRunAt).toBeNull()
      expect(task?.nextRunAt).toBeGreaterThan(Date.now())
    }

    expect(existsSync(join(workspace, 'keep-me.txt'))).toBe(true)
    expect(existsSync(join(workspace, '.morrow', 'MEMORY.md'))).toBe(true)
    expect(readdirSync(workspace)).toContain('keep-me.txt')
    const settingsAfter = await page.evaluate(async () => window.morrow.settings.get())
    expect(settingsAfter.ok).toBe(true)
    if (settingsAfter.ok) expect(settingsAfter.data.lastWorkspace).toBe(workspace)
    await expect(page.locator('.tb-temp-badge')).toHaveCount(0)
  })

  test('关闭应用后临时对话消失，启动时清理遗留的临时快照目录', async () => {
    test.setTimeout(120_000)
    const dataDir = join(root, 'tmp', `e2e-a6-restart-${Date.now()}`)
    const workspace = join(root, 'tmp', `e2e-a6-restart-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })

    const first = await launchMorrow({ name: 'a6-restart-1', dataDir, timeoutMs: 90_000 })
    let tempId = ''
    try {
      await waitForStoreReady(first.page)
      await dismissOnboarding(first.page)
      await first.page.evaluate(async (path: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ lastWorkspace: path })
      }, workspace)
      await first.page.locator('.sb-temp').click()
      await expect(first.page.locator('.tb-temp-badge')).toBeVisible()
      tempId = (await readStore(first.page)).activeSessionId ?? ''
      expect(tempId.startsWith('tmp_')).toBe(true)

      // 模拟崩溃遗留：临时目录与无主 tmp 目录
      for (const name of ['snapshots', 'checkpoints', 'artifact-versions']) {
        const dir = join(dataDir, name, 'tmp_orphan')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'leftover.txt'), 'should be cleaned', 'utf8')
      }
    } finally {
      await first.close()
    }
    expect(existsSync(join(dataDir, 'sessions', `${tempId}.json`))).toBe(false)

    morrow = await launchMorrow({ name: 'a6-restart-2', dataDir, timeoutMs: 90_000 })
    await waitForStoreReady(morrow.page)
    const listed = await morrow.page.evaluate(async () => window.morrow.session.list())
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.data).toHaveLength(0)
    expect(readdirSync(join(morrow.dataDir, 'sessions'))).toEqual([])
    for (const name of ['snapshots', 'checkpoints', 'artifact-versions']) {
      expect(existsSync(join(morrow.dataDir, name, 'tmp_orphan'))).toBe(false)
    }
    await expect(morrow.page.locator('.tb-temp-badge')).toHaveCount(0)
  })

  test('运行中清除全部：先停止任务，运行收尾不会把会话写回来', async () => {
    test.setTimeout(120_000)
    const mock = await startMockLLM({
      scripts: [{ text: '这一轮会被清除。', delayMs: 4_000 }]
    })
    const workspace = join(root, 'tmp', `e2e-a6-running-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'a6-clear-running', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await page.evaluate(async (providerArg: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      if (!created) throw new Error('新建对话失败')
      const result = await window.morrow.session.setModel(created.id, {
        providerId: providerArg.providerId,
        modelId: providerArg.modelId
      })
      if (!result.ok) throw new Error(result.error.message)
      return created.id as string
    }, provider)
    await page.locator('.composer-input').fill('先跑起来再清除')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).run !== null, 30_000, '运行开始')

    const deleted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().clearAllSessions()
    })
    expect(deleted).toBeGreaterThan(0)
    await expect(page.locator('.welcome')).toBeVisible({ timeout: 15_000 })

    // 等过原运行时长，确认收尾不会重建会话文件
    await page.waitForTimeout(4_800)
    expect(existsSync(join(morrow.dataDir, 'sessions', `${sessionId}.json`))).toBe(false)
    expect(readdirSync(join(morrow.dataDir, 'sessions'))).toEqual([])
    const state = await readStore(page)
    expect(state.sessions).toHaveLength(0)
    expect(state.run).toBeNull()
  })
})
