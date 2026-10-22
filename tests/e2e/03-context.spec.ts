/**
 * 合并自 8 个 E2E spec：context-compaction.spec.ts、checkpoint-rewind.spec.ts、a6-temp-clear.spec.ts、demo-isolation.spec.ts、background-runs.spec.ts、reasoning-default.spec.ts、reasoning-cost.spec.ts、token-activity.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screensDir, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clearEvents, configureMockProvider, createSession, dismissOnboarding, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil } from './store'
import { DEFAULT_MODEL, defaultSettings } from '../../src/shared/models'

// ── 原文件：context-compaction.spec.ts ──────────────────────────────────────────────
test.describe('context-compaction.spec.ts', () => {
/**
 * 手动上下文压缩：
 * - 压缩期间禁止发送/再次压缩（主进程 + 渲染层双重拦截），不会丢新消息；
 * - 摘要收敛为「上下文已压缩」系统标记，按需展开，不再伪装成助手长回复；
 * - 压缩后旧消息按安全切点折叠，原始用户约束保留。
 */

test('手动压缩：锁住发送、摘要折叠展示、旧消息安全折叠', async () => {
  test.setTimeout(240_000)
  const normalScripts = Array.from({ length: 6 }, (_, index) => ({
    text: `第 ${index + 1} 轮核对完成。${'资料内容与结论'.repeat(60)}`
  }))
  const summaryText = '摘要：用户连续进行了六轮资料核对，前四轮已完成；保留目标、文件路径与未完成事项。'
  const mock = await startMockLLM({
    scripts: [...normalScripts, { text: summaryText, delayMs: 2_500 }]
  })
  const workspace = join(root, 'tmp', `e2e-compaction-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'context-compaction', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '压缩测试'
    })
    await installEventCollector(page)

    for (let round = 1; round <= 6; round += 1) {
      await clearEvents(page)
      await sendMessageViaStore(page, `第 ${round} 轮：请核对这一批资料并给出结论。${'补充说明'.repeat(12)}`)
      await waitForRunFinished(page, 60_000)
    }
    expect(mock.requests.length).toBe(6)
    await expect(page.locator('.message-user-bubble')).toHaveCount(6)
    await expect(page.locator('.message-assistant')).toHaveCount(6)

    // 输入 /compact 走真实命令面板；摘要请求会故意慢 2.5s，留出并发检查窗口
    await page.locator('.composer-input').fill('/compact')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.transcript-compacting')).toBeVisible({ timeout: 10_000 })

    const directSend = await page.evaluate(
      async (id) =>
        (window as unknown as {
          morrow: { chat: { send: (input: unknown) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.chat.send({ sessionId: id, text: '压缩期间直接发送' }),
      sessionId
    )
    expect(directSend.ok).toBe(false)
    expect(directSend.error?.message ?? '').toContain('正在压缩上下文')

    const directCompact = await page.evaluate(
      async (id) =>
        (window as unknown as {
          morrow: { chat: { compact: (id: string) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.chat.compact(id),
      sessionId
    )
    expect(directCompact.ok).toBe(false)
    expect(directCompact.error?.message ?? '').toContain('正在压缩上下文')

    await page.locator('.composer-input').fill('压缩结束前不要丢这条')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('压缩结束前不要丢这条')
    await expect(page.getByText('正在压缩上下文，完成后再发送。')).toBeVisible()
    // 6 次正常请求 + 1 次摘要请求；被拦下的发送不应产生第 8 次请求
    expect(mock.requests.length).toBe(7)

    await expect(page.locator('.message-compaction')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.message-compaction .compaction-head')).toContainText('上下文已压缩')
    await expect(page.locator('.compaction-body')).toHaveCount(0)
    await expect(page.locator('.message-user-bubble')).toHaveCount(5)
    await expect(page.locator('.message-assistant')).toHaveCount(4)
    expect(mock.requests.length).toBe(7)

    await page.locator('.composer-input').fill('')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.locator('.message-compaction').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('context-compaction-collapsed-light.png') })

    await page.locator('.message-compaction .compaction-head').click()
    await expect(page.locator('.compaction-body')).toBeVisible()
    await expect(page.locator('.compaction-body')).toContainText('六轮资料核对')
    await page.screenshot({ path: screenshotPath('context-compaction-expanded-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('context-compaction-expanded-dark.png') })

    // 摘要已落盘：重新加载仍是折叠的系统标记
    const persisted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const current = store.getState().session
      const loaded = await window.morrow.session.load(current.id)
      if (!loaded.ok) throw new Error(loaded.error.message)
      return loaded.data.messages.map((message) => message.role)
    })
    expect(persisted[0]).toBe('system')
    expect(persisted.filter((role: string) => role === 'assistant')).toHaveLength(4)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('自动压缩：运行结束时把压缩后的历史同步回当前视图', async () => {
  test.setTimeout(240_000)
  const longReply = (index: number): string => `第 ${index} 次响应。${'长内容与核对结论'.repeat(90)}`
  const mock = await startMockLLM({
    scripts: Array.from({ length: 24 }, (_, index) => ({ text: longReply(index + 1) }))
  })
  const workspace = join(root, 'tmp', `e2e-auto-compaction-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'auto-compaction', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    // 小窗口 + 50% 阈值，让多轮对话在结束前触发自动压缩
    const provider = await configureMockProvider(page, mock.openaiBaseUrl, 'mock-e2e', 12_000)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoCompact: true, compactThreshold: 0.5 })
    })
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '自动压缩测试'
    })
    await installEventCollector(page)

    let rounds = 0
    for (let round = 1; round <= 8; round += 1) {
      await clearEvents(page)
      await sendMessageViaStore(page, `第 ${round} 轮：继续核对资料。${'这是本轮的具体要求。'.repeat(10)}`)
      await waitForRunFinished(page, 60_000)
      rounds = round
      if ((await page.locator('.message-compaction').count()) > 0) break
    }

    await expect(page.locator('.message-compaction').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.message-compaction .compaction-head').first()).toContainText('上下文已压缩')
    await expect(page.locator('.compaction-body')).toHaveCount(0)
    // 最早的助手回合已被折叠进摘要（用户约束消息会被保留，所以看助手消息数）
    expect(await page.locator('.message-assistant').count()).toBeLessThan(rounds)

    const persisted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const current = store.getState().session
      const loaded = await window.morrow.session.load(current.id)
      if (!loaded.ok) throw new Error(loaded.error.message)
      return { first: loaded.data.messages[0]?.role, count: loaded.data.messages.length }
    })
    expect(persisted.first).toBe('system')
    expect(persisted.count).toBeGreaterThan(0)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.message-compaction').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('context-compaction-auto-dark.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：checkpoint-rewind.spec.ts ──────────────────────────────────────────────
test.describe('checkpoint-rewind.spec.ts', () => {
/**
 * P0-3 检查点回退 E2E：
 * - 两轮真实写文件 → 自动生成检查点；
 * - 消息「回退」按钮 + /rewind 命令打开面板；
 * - 外部修改触发冲突并禁用确认；
 * - 恢复预期内容后回退 both：notes 回到 v1、新建文件删除、对话清空。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('检查点回退：冲突检测 → 恢复文件与对话', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我来修改文件。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'notes.md', content: 'v2\n' } },
          { name: 'write_file', arguments: { path: 'new.md', content: 'new\n' } }
        ]
      },
      { text: '第一轮完成。' },
      { text: '继续修改。', toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: 'v3\n' } }] },
      { text: '第二轮完成。' }
    ]
  })
  const workspace = workspaceAt('e2e-checkpoint')
  writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8')
  const morrow = await launchMorrow({ name: 'checkpoint', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '检查点测试'
    })

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('把 notes.md 改成 v2，并新建 new.md。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v2\n')

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('再把 notes.md 改成 v3。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第二轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v3\n')

    // 主进程检查点已落盘（两轮）
    await waitUntil(
      async () =>
        page.evaluate(async (id) => {
          const result = await window.morrow.checkpoints.list(id)
          return result.ok && result.data.length === 2 ? result.data.length : null
        }, sessionId),
      20_000,
      '两个检查点'
    )

    // 外部修改一个已登记文件 → 从回答末尾「回退」打开唯一的确认弹窗
    writeFileSync(join(workspace, 'notes.md'), 'external\n', 'utf8')
    await page.getByRole('button', { name: '回退这一轮' }).first().click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.locator('.rewind-confirm-list')).toHaveCount(0)
    await expect(page.getByText(/有 1 个文件被改过/)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files li.is-conflict')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '确认回退' })).toBeDisabled()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-conflict-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('rewind-conflict-light.png') })
    await setThemeViaStore(page, 'dark')

    // 修好文件后，在同一个确认弹窗里「重新检查」即可解除冲突
    writeFileSync(join(workspace, 'notes.md'), 'v3\n', 'utf8')
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(page.getByText(/有 1 个文件被改过/)).toHaveCount(0)
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('new.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('删除新文件')
    await expect(page.getByRole('button', { name: '确认回退' })).toBeEnabled()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-ready-dark.png') })

    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这一轮之前/)).toBeVisible({ timeout: 10_000 })
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 0, 20_000, '对话已回退')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v1\n')
    expect(() => readFileSync(join(workspace, 'new.md'), 'utf8')).toThrow()

    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.messages).toHaveLength(0)
    const remaining = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data.length : -1
    }, sessionId)
    expect(remaining).toBe(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：a6-temp-clear.spec.ts ──────────────────────────────────────────────
test.describe('a6-temp-clear.spec.ts', () => {
/**
 * A6：临时对话与全量清除。
 * - 临时对话不写会话文件、不进入侧栏持久历史/搜索、不记 token 账本；
 * - 清除全部对话会删除会话文件、快照、检查点、成品版本、审批日志与用量，但不动工作区文件。
 */

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

})

// ── 原文件：demo-isolation.spec.ts ──────────────────────────────────────────────
test.describe('demo-isolation.spec.ts', () => {
/**
 * 演示隔离回归：演示模型不能污染默认模型，也不能在真实文件夹里播放剧本。
 * 运行：npx playwright test tests/e2e/demo-isolation.spec.ts
 */

const DEMO_MODEL = { providerId: 'demo', modelId: 'morrow-demo' }

function workspaceAt(name: string): string {
  const dir = join(root, 'tmp', `demo-isolation-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('演示隔离', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('演示不写入默认模型；普通会话不能用演示模型；旧数据自动修复', async () => {
    test.setTimeout(180_000)
    morrow = await launchMorrow({
      name: 'demo-isolation',
      env: { MORROW_DEMO_SPEED: '0.1' },
      timeoutMs: 90_000,
      waitForSelector: '.onb-skip'
    })
    const { page } = morrow
    await waitForStoreReady(page)
    await installEventCollector(page)

    await page.locator('.onb-skip').click()
    const demoState = await waitUntil(
      async () =>
        page.evaluate(() => {
          const state = (window as unknown as {
            __morrowStore: { getState: () => Record<string, any> }
          }).__morrowStore.getState()
          if (state.session?.demo !== true) return null
          return {
            defaultModel: state.settings.defaultModel as { providerId: string; modelId: string },
            session: {
              id: String(state.session.id),
              model: state.session.model as { providerId: string; modelId: string },
              demo: state.session.demo === true,
              workspace: state.session.workspace as string | null
            }
          }
        }),
      30_000,
      '演示会话建立'
    )
    await waitForRunStarted(page)
    await waitForRunFinished(page, 90_000)

    expect(demoState.defaultModel).toEqual(DEFAULT_MODEL)
    expect(demoState.session.model.providerId).toBe('demo')
    expect(demoState.session.demo).toBe(true)
    expect(demoState.session.workspace).toContain('demo-workspace')
    await page.screenshot({ path: screenshotPath('demo-isolation.png') })

    const afterDemo = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const created = await store.getState().newSession()
      return {
        model: created.model as { providerId: string },
        demo: created.demo === true,
        defaultModel: store.getState().settings.defaultModel as { providerId: string }
      }
    })
    expect(afterDemo.defaultModel).toEqual(DEFAULT_MODEL)
    expect(afterDemo.model).toEqual(DEFAULT_MODEL)
    expect(afterDemo.demo).toBe(false)

    const realWorkspace = workspaceAt('real')
    const rejectedCreate = await page.evaluate(
      async (arg: { workspace: string; model: { providerId: string; modelId: string } }) =>
        window.morrow.session.create({ workspace: arg.workspace, model: arg.model }),
      { workspace: realWorkspace, model: DEMO_MODEL }
    )
    expect(rejectedCreate.ok).toBe(false)
    if (!rejectedCreate.ok) expect(rejectedCreate.error.message).toContain('演示模型只能在')

    const rejectedDefault = await page.evaluate(
      async (model: { providerId: string; modelId: string }) => window.morrow.settings.update({ defaultModel: model }),
      DEMO_MODEL
    )
    expect(rejectedDefault.ok).toBe(false)

    const realModel = await page.evaluate(
      () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().settings.defaultModel
    )
    const created = await page.evaluate(
      async (arg: { workspace: string; model: { providerId: string; modelId: string } }) =>
        window.morrow.session.create({ workspace: arg.workspace, model: arg.model, title: '旧演示会话' }),
      { workspace: realWorkspace, model: realModel }
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const file = join(morrow.dataDir, 'sessions', `${created.data.id}.json`)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.model = DEMO_MODEL
    raw.workspace = realWorkspace
    delete raw.demo
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    const repaired = await page.evaluate(async (sessionId: string) => window.morrow.session.load(sessionId), created.data.id)
    expect(repaired.ok).toBe(true)
    if (repaired.ok) {
      expect(repaired.data.model.providerId).not.toBe('demo')
      expect(repaired.data.demo).not.toBe(true)
    }
    const repairedFile = JSON.parse(readFileSync(file, 'utf8')) as { model: { providerId: string } }
    expect(repairedFile.model.providerId).not.toBe('demo')
  })
})

})

// ── 原文件：background-runs.spec.ts ──────────────────────────────────────────────
test.describe('background-runs.spec.ts', () => {
/**
 * P0-6 后台运行与运行中心：
 * - 会话 A 运行中可切换到会话 B 并启动第二个运行；
 * - 运行中心列出两个任务，可切换/停止；
 * - 关闭窗口默认隐藏到托盘，应用不退出。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('多会话后台运行、运行中心与关闭到托盘', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '后台 A 完成。', delayMs: 6_000 },
      { text: '当前 B 完成。', delayMs: 6_000 }
    ]
  })
  const workspace = workspaceAt('e2e-background')
  const morrow = await launchMorrow({ name: 'background-runs', timeoutMs: 90_000 })
  try {
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)

    const sessionA = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '后台会话 A'
    })
    await page.locator('.composer-input').fill('任务 A')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).runs.length === 1, 30_000, 'A 开始运行')

    const sessionB = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '当前会话 B'
    })
    await page.locator('.composer-input').fill('任务 B')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).runs.length === 2, 30_000, '两个会话并行运行')

    await expect(page.locator('.run-center')).toBeVisible()
    await expect(page.locator('.run-center-item')).toHaveCount(2)
    await expect(page.locator('.run-center')).toContainText('后台会话 A')
    // 后台会话在侧栏也应显示运行标记，而不是只有当前会话显示
    await expect(
      page.locator('.sb-session').filter({ hasText: '后台会话 A' }).locator('.sb-session-flag.is-running')
    ).toHaveCount(1)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('run-center-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('run-center-light.png') })
    await setThemeViaStore(page, 'dark')

    // 运行中心切回 A
    await page.locator('.run-center-main').filter({ hasText: '后台会话 A' }).click()
    await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 15_000, '切回会话 A')
    await expect(page.getByText('后台 A 完成。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).runs.length === 0, 60_000, '两个运行结束')

    // B 的回复仍在磁盘/会话里
    await page.evaluate(async (id) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().selectSession(id)
    }, sessionB)
    await expect(page.getByText('当前 B 完成。')).toBeVisible({ timeout: 30_000 })

    // 关闭窗口 → 首次询问；选择最小化到任务栏，应用仍在运行
    const closeState = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.close()
      return {
        count: BrowserWindow.getAllWindows().length,
        destroyed: win ? win.isDestroyed() : true
      }
    })
    expect(closeState.count).toBe(1)
    expect(closeState.destroyed).toBe(false)
    await expect(page.getByText('要关闭 Morrow 吗？')).toBeVisible()
    await page.getByRole('button', { name: /最小化到任务栏/ }).click()
    await expect
      .poll(async () =>
        app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          return { minimized: win ? win.isMinimized() : false, destroyed: win ? win.isDestroyed() : true }
        })
      )
      .toMatchObject({ minimized: true, destroyed: false })

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.restore()
      win?.show()
      win?.focus()
    })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：reasoning-default.spec.ts ──────────────────────────────────────────────
test.describe('reasoning-default.spec.ts', () => {
/**
 * P1-13 回归：默认内置 DeepSeek 模型必须暴露推理强度选项。
 * 之前的元数据只给 openai/anthropic 推断 reasoningStyle，DeepSeek 等
 * OpenAI 兼容内置模型被标记 supportsReasoning 却没有 style，导致选择器被隐藏。
 */

test('默认 DeepSeek 模型可选择推理强度', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({
    name: 'reasoning-default',
    waitForSelector: '.composer',
    timeoutMs: 90_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)

    const trigger = page.getByRole('button', { name: '推理强度' })
    await expect(trigger).toBeVisible()
    await expect(trigger).toContainText('auto')
    await trigger.click()
    await expect(page.getByRole('option', { name: /^low/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^medium/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^high/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^xhigh/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^max/ })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('reasoning-menu-dark.png') })

    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await trigger.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('reasoning-menu-light.png') })
  } finally {
    await morrow.close()
  }
})

/**
 * 旧版本同步过模型元数据、但没有 reasoningStyle 的真实升级路径：
 * 设置合并不能让模型「支持推理」却隐藏思考强度选择。
 */
test('旧版同步模型缺少 reasoningStyle 时仍显示思考强度', async () => {
  test.setTimeout(120_000)
  const dataDir = join(root, 'tmp', `reasoning-legacy-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = defaultSettings()
  settings.onboardingDone = true
  settings.providers = settings.providers.map((provider) =>
    provider.id === 'deepseek'
      ? {
          ...provider,
          modelsSyncedAt: 1_700_000_000_000,
          models: [
            {
              id: 'deepseek-flash',
              label: 'DeepSeek V4.1 Flash',
              contextWindow: 1_048_576,
              maxOutput: 393_216,
              supportsTools: true,
              supportsReasoning: true
            }
          ]
        }
      : provider
  )
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings), 'utf8')

  const morrow = await launchMorrow({
    name: 'reasoning-legacy',
    dataDir,
    waitForSelector: '.composer',
    timeoutMs: 90_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const model = await page.evaluate(() => {
      const state = (window as unknown as { __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string; reasoningStyle?: string }> }> } } } }).__morrowStore.getState()
      return state.settings.providers.find((provider) => provider.id === 'deepseek')?.models[0]
    })
    expect(model?.reasoningStyle).toBe('effort')
    const trigger = page.getByRole('button', { name: '推理强度' })
    await expect(trigger).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('reasoning-legacy-model-dark.png') })
    await trigger.click()
    await expect(page.getByRole('option', { name: /^high/ })).toBeVisible()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
  } finally {
    await morrow.close()
  }
})

})

// ── 原文件：reasoning-cost.spec.ts ──────────────────────────────────────────────
test.describe('reasoning-cost.spec.ts', () => {
/**
 * P1-13 推理强度与费用：
 * - 模型支持推理时输入区出现推理强度选择；
 * - 选择「高」后 provider 请求带 reasoning_effort；
 * - 会话累计费用 > 0，/usage 打开上下文用量页。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('推理强度映射与费用累计', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮回答。' },
      { text: '第二轮回答。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'reasoning-cost', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-reasoning'),
      ...provider,
      permissionMode: 'auto',
      title: '推理与费用测试'
    })

    await expect(page.getByRole('button', { name: '推理强度' })).toBeVisible()
    await page.getByRole('button', { name: '推理强度' }).click()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(page.getByRole('button', { name: '推理强度' })).toContainText('high')

    await page.locator('.composer-input').fill('第一次提问')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('第一轮回答。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第一轮完成')
    expect(mock.requests[0].body.reasoning_effort).toBe('high')

    // 真实运行结束后继续切换 xhigh / max：两档都必须被 IPC 接受，不能出现「推理强度无效」
    const effortNow = (): Promise<string | undefined> =>
      page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        return state.session?.reasoningEffort ?? state.settings.reasoningEffort
      })
    const trigger = page.getByRole('button', { name: '推理强度' })
    await trigger.click()
    await page.getByRole('option', { name: /^xhigh/ }).click()
    await expect(trigger).toContainText('xhigh')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('xhigh')
    await expect(page.locator('.toast-item.toast-error').filter({ hasText: '推理强度无效' })).toHaveCount(0)

    await trigger.click()
    await page.getByRole('option', { name: /^max/ }).click()
    await expect(trigger).toContainText('max')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('max')
    await expect(page.locator('.toast-item.toast-error').filter({ hasText: '推理强度无效' })).toHaveCount(0)

    await trigger.click()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
    await expect.poll(effortNow, { timeout: 10_000 }).toBe('high')

    await page.locator('.composer-input').fill('第二次提问')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('第二轮回答。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第二轮完成')

    const usage = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.usage ?? null
    })
    expect(usage?.costUsd).toBeGreaterThan(0)
    expect(usage?.inputTokens).toBeGreaterThan(0)

    await page.locator('.composer-input').fill('/usage')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByRole('tab', { name: '上下文' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.st-context')).toContainText('估算费用')
    await expect(page.locator('.st-context')).toContainText('参考价')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    // 打开上下文页时焦点不应落在阈值滑杆上：方向键会误改值，主题切换也会把面板滚走
    await expect(page.locator('.st-range')).not.toBeFocused()
    const cardOffset = (): Promise<number> =>
      page.locator('.st-ctx-card').evaluate((card) => {
        const panel = card.closest('.st-panel') as HTMLElement
        return Math.round(card.getBoundingClientRect().top - panel.getBoundingClientRect().top)
      })
    // 截图聚焦上下文占用与费用卡片，而不是滚动到下方的压缩设置
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      ;(element.closest('.modal-body') as HTMLElement | null)?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    })
    await expect.poll(cardOffset, { message: '费用卡片应位于面板顶部' }).toBeLessThan(40)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await expect.poll(cardOffset, { message: '切换主题后面板不应滚动' }).toBeLessThan(40)
    await page.screenshot({ path: screenshotPath('reasoning-cost-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await expect.poll(cardOffset, { message: '切换主题后面板不应滚动' }).toBeLessThan(40)
    await page.screenshot({ path: screenshotPath('reasoning-cost-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：token-activity.spec.ts ──────────────────────────────────────────────
test.describe('token-activity.spec.ts', () => {
/**
 * Token 活动：真实 usage 落账 → 马赛克热力图 → 日/周/累计切换与悬浮详情。
 */

function makeDir(prefix: string): string {
  return join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
}

function nextDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

test.describe('Token 活动', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('真实 usage 入账，马赛克视图可切换并显示悬浮详情', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('token-activity-ws')
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({ scripts: [{ text: '收到了，这是 Token 统计测试回复。' }] })
    morrow = await launchMorrow({ name: 'token-activity', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: 'Token 活动测试'
      })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请回复一句用于 Token 统计的话。')
      await waitForRunFinished(page, 60_000)

      const ledger = join(morrow.dataDir, 'usage', 'token-activity.json')
      await waitUntil(async () => existsSync(ledger), 10_000, 'Token 账本落盘')
      const summary = await waitUntil(
        async () => {
          const result = await page.evaluate(async () => window.morrow.tokenActivity.get())
          return result.ok && result.data.total > 0 ? result.data : null
        },
        10_000,
        'Token 活动有真实记录'
      )
      expect(summary.total).toBeGreaterThan(0)
      expect(summary.today).toBeGreaterThan(0)

      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible' })
      await settings.getByRole('tab', { name: '用量' }).click()
      await expect(page.locator('.token-activity-title')).toHaveText('Token 活动')
      // 切换控件与应用其它 Segmented 保持一致，不再使用自定义胶囊样式
      await expect(settings.locator('.token-activity .segmented')).toBeVisible()
      await expect(settings.locator('.token-mode-tabs')).toHaveCount(0)

      const mosaic = page.locator('.token-mosaic')
      const dailyCells = page.locator('.token-mosaic .token-cell')
      await expect(page.locator('.token-mosaic .token-cell:not(.is-outside)').first()).toBeVisible({ timeout: 10_000 })
      await expect(mosaic).toHaveAttribute('data-mode', 'day')
      expect(await dailyCells.count()).toBeGreaterThanOrEqual(365)
      // 每列一周：同一列从上到下必须是连续日期，且方块行号与星期几严格对应
      await expect(page.locator('.token-weekday')).toHaveText(['一', '二', '三', '四', '五', '六', '日'])
      const layout = await page.$$eval('.token-mosaic .token-cell:not(.is-outside)', (cells) =>
        cells.map((cell) => {
          const element = cell as HTMLElement
          return {
            date: element.dataset.date ?? '',
            weekday: Number(element.dataset.weekday),
            column: Number(element.style.gridColumn),
            row: Number(element.style.gridRow)
          }
        })
      )
      expect(layout.length).toBe(summary.days.length)
      expect(layout.length).toBe(365)
      const byColumn = new Map<number, typeof layout>()
      for (const cell of layout) {
        byColumn.set(cell.column, [...(byColumn.get(cell.column) ?? []), cell])
      }
      const columnKeys = [...byColumn.keys()].sort((a, b) => a - b)
      expect(columnKeys[0]).toBe(2)
      for (let index = 1; index < columnKeys.length; index += 1) {
        expect(columnKeys[index]).toBe(columnKeys[index - 1] + 1)
      }
      for (const items of byColumn.values()) {
        const sorted = [...items].sort((a, b) => a.row - b.row)
        for (let index = 0; index < sorted.length; index += 1) {
          const cell = sorted[index]
          const jsDay = new Date(`${cell.date}T00:00:00`).getDay()
          const expectedWeekday = jsDay === 0 ? 7 : jsDay
          expect(cell.weekday).toBe(expectedWeekday)
          expect(cell.row).toBe(expectedWeekday)
          if (index > 0) {
            expect(cell.row).toBe(sorted[index - 1].row + 1)
            expect(cell.date).toBe(nextDay(sorted[index - 1].date))
          }
        }
      }
      expect(new Date(`${layout[0].date}T00:00:00`).getTime()).toBeLessThan(
        new Date(`${layout[layout.length - 1].date}T00:00:00`).getTime()
      )

      // 月份标签：钉在「该月 1 日所在的那一列」，文字不重叠，且至少间隔 3 列
      const labels = await page.$$eval('.token-month-label', (nodes) =>
        nodes.map((node) => {
          const element = node as HTMLElement
          const column = Number(element.style.gridColumn)
          const rect = element.getBoundingClientRect()
          const cell = [...document.querySelectorAll('.token-mosaic .token-cell')].find(
            (candidate) => Number((candidate as HTMLElement).style.gridColumn) === column
          ) as HTMLElement | undefined
          return {
            text: element.textContent ?? '',
            column,
            left: rect.left,
            right: rect.right,
            columnLeft: cell?.getBoundingClientRect().left ?? null
          }
        })
      )
      expect(labels.length).toBeGreaterThanOrEqual(11)
      const firstDay = new Date(`${layout[0].date}T00:00:00`)
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index]
        const month = Number(label.text.replace('月', ''))
        const isStartLabel = index === 0 && label.column === 2 && month === firstDay.getMonth() + 1
        if (!isStartLabel) {
          const week = layout.filter((cell) => cell.column === label.column)
          const anchored = week.some((cell) => {
            const date = new Date(`${cell.date}T00:00:00`)
            return date.getDate() === 1 && date.getMonth() + 1 === month
          })
          expect(anchored, `${label.text} 应锚定在包含该月 1 日的那一列`).toBe(true)
        }
        if (index > 0) {
          expect(label.column).toBeGreaterThanOrEqual(labels[index - 1].column + 3)
          expect(label.left).toBeGreaterThan(labels[index - 1].right + 2)
        }
        if (label.column !== columnKeys[columnKeys.length - 1]) {
          expect(label.columnLeft).not.toBeNull()
          expect(Math.abs(label.left - (label.columnLeft ?? 0))).toBeLessThanOrEqual(1)
        }
      }
      await expect(page.locator('.token-activity-stats')).toContainText('今天')
      await expect(page.locator('.token-mode-note')).toContainText('每列一周（周一→周日）')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(120)
      await page.locator('.token-activity').screenshot({ path: screenshotPath('token-activity-heatmap-dark.png') })

      const dailyCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').first()
      await expect(dailyCell).toBeVisible()
      await dailyCell.hover()
      await page.waitForTimeout(120)
      await dailyCell.hover()
      await expect(page.locator('.token-tooltip')).toBeVisible()
      await expect(page.locator('.token-tooltip')).toContainText('tokens')
      await page.screenshot({ path: screenshotPath('token-activity-daily.png') })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __morrowStore: { getState: () => { setTheme: (value: string) => void } }
        }).__morrowStore
        store.getState().setTheme('light')
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('token-activity-daily-light.png') })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __morrowStore: { getState: () => { setTheme: (value: string) => void } }
        }).__morrowStore
        store.getState().setTheme('dark')
      })

      // 每周：仍然是 365 个日格，格子与悬浮显示所在周合计
      await settings.getByRole('radio', { name: '每周' }).click()
      await expect(mosaic).toHaveAttribute('data-mode', 'week')
      expect(await page.locator('.token-mosaic .token-cell').count()).toBeGreaterThanOrEqual(365)
      await expect(page.locator('.token-month-label').first()).toBeVisible()
      await expect(page.locator('.token-mode-note')).toContainText('所在自然周的合计')
      const weekCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').first()
      await expect(weekCell).toBeVisible()
      await weekCell.hover()
      await expect(page.locator('.token-tooltip')).toContainText('该周合计')
      await page.screenshot({ path: screenshotPath('token-activity-weekly.png') })

      // 累计：仍然是 365 个日格，格子与悬浮显示截至当天的历史累计
      await settings.getByRole('radio', { name: '累计总量' }).click()
      await expect(mosaic).toHaveAttribute('data-mode', 'total')
      expect(await page.locator('.token-mosaic .token-cell').count()).toBeGreaterThanOrEqual(365)
      await expect(page.locator('.token-mode-note')).toContainText('截至当天的历史累计')
      const totalCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').last()
      await expect(totalCell).toBeVisible()
      await totalCell.hover()
      await expect(page.locator('.token-tooltip')).toContainText('累计用量')
      await page.screenshot({ path: screenshotPath('token-activity-total.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
