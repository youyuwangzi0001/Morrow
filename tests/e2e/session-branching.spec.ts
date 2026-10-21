/**
 * P1-7 会话分支与消息操作 E2E：
 * - 重新生成最后一条回答（请求里不再带上旧回答）；
 * - 就地编辑首条用户消息并重发（旧对话被截断）；
 * - 删除某条消息之后的所有内容；
 * - 从消息分叉出新会话，原会话保持不变；
 * - 置顶 / 归档 / 移出归档的侧栏交互。
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
  readStore,
  setThemeViaStore,
  waitUntil,
  waitForStoreReady
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

function chatBodies(mock: { requests: Array<{ url: string; messages: Array<{ role: string; content: unknown }>; lastUserMessageText?: string }> }) {
  return mock.requests.filter((request) => request.url.includes('/chat/completions'))
}

test('会话分支与消息操作：重新生成、编辑重发、分叉、置顶与归档', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一版回答。' },
      { text: '第二版回答。' },
      { text: '编辑后的回答。' },
      { text: '补充回答。' }
    ]
  })
  const workspace = workspaceAt('e2e-session-actions')
  const morrow = await launchMorrow({ name: 'session-actions', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const originalId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'P1-7 测试'
    })

    const send = (text: string): Promise<void> =>
      page.evaluate((value) => {
        return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (t: string) => Promise<void> } } })
          .__morrowStore.getState().sendMessage(value)
      }, text)

    const lastText = async (): Promise<string> => {
      const state = await readStore(page)
      return state.session?.messages.at(-1)?.text ?? ''
    }

    const dismissToasts = (): Promise<void> =>
      page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })

    await send('请回答第一版')
    await waitUntil(async () => (await lastText()) === '第一版回答。', 60_000, '第一版回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮结束')
    expect(chatBodies(mock)).toHaveLength(1)

    // 重新生成：旧回答被丢弃，请求里不带 assistant 消息
    await page.getByRole('button', { name: '重新生成回答' }).click()
    await waitUntil(async () => (await lastText()) === '第二版回答。', 60_000, '重新生成回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '重新生成结束')
    const regenerated = chatBodies(mock)[1]
    expect(regenerated?.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
    expect((await readStore(page)).session?.messages).toHaveLength(2)

    // 编辑首条用户消息并重发：消息之后的回答被截断，新内容重新发送
    const firstUser = page.locator('.message-user').first()
    await firstUser.hover()
    await firstUser.getByRole('button', { name: '编辑并重发' }).click()
    const editor = page.locator('.message-user-editor')
    await expect(editor).toBeVisible()
    await editor.fill('请回答编辑版')
    await editor.press('Enter')
    await waitUntil(async () => (await lastText()) === '编辑后的回答。', 60_000, '编辑后的回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '编辑重发结束')
    const edited = chatBodies(mock)[2]
    expect(edited?.lastUserMessageText).toBe('请回答编辑版')
    expect(edited?.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
    const afterEdit = await readStore(page)
    expect(afterEdit.session?.messages).toHaveLength(2)
    expect(afterEdit.session?.messages[0]?.text).toBe('请回答编辑版')

    // 再补一轮，让消息操作和删除后续都有真实的上下文
    await send('再补充一句')
    await waitUntil(async () => (await lastText()) === '补充回答。', 60_000, '补充回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '补充轮结束')
    expect((await readStore(page)).session?.messages).toHaveLength(4)

    // 截图：悬停用户消息时的完整操作行
    await page.locator('.message-user').first().hover()
    await dismissToasts()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('message-actions-dark.png') })

    // 从首条用户消息分叉：新会话只含到该消息为止的内容
    await page.locator('.message-user').first().getByRole('button', { name: '从这条消息分叉' }).click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== originalId, 20_000, '分叉会话激活')
    const branched = await readStore(page)
    expect(branched.session?.messages).toHaveLength(1)
    expect(branched.session?.title).toBe('P1-7 测试 · 分支')
    expect(branched.sessions).toHaveLength(2)
    const branchUsage = await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { session?: { usage?: Record<string, number> } } } })
        .__morrowStore.getState().session?.usage
    })
    expect(branchUsage).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    await dismissToasts()
    await page.screenshot({ path: screenshotPath('session-branch-dark.png') })

    // 回到原会话，验证原对话没有被分叉改动
    await page.evaluate((id) => {
      void (window as unknown as { __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } } })
        .__morrowStore.getState().selectSession(id)
    }, originalId)
    await waitUntil(async () => (await readStore(page)).activeSessionId === originalId, 20_000, '回到原会话')
    expect((await readStore(page)).session?.messages).toHaveLength(4)

    // 置顶：置顶分组出现在列表最上方
    const originalRow = page
      .locator('.sb-session')
      .filter({ has: page.getByText('P1-7 测试', { exact: true }) })
    await originalRow.hover()
    await originalRow.getByRole('button', { name: '置顶对话' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === originalId)?.pinned === true
    }, 15_000, '会话已置顶')
    await expect(page.locator('.sb-group-head', { hasText: '置顶' })).toBeVisible()
    await dismissToasts()
    await page.screenshot({ path: screenshotPath('session-pinned-dark.png') })

    // 归档：从侧栏收起，改在 设置 → 归档 中管理
    await originalRow.hover()
    await originalRow.getByRole('button', { name: '归档对话' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === originalId)?.archived === true
    }, 15_000, '会话已归档')
    await expect(page.getByText('P1-7 测试', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sb-group.is-archived')).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    const archivedRow = page
      .locator('.st-archive-row')
      .filter({ has: page.getByText('P1-7 测试', { exact: true }) })
    await expect(archivedRow).toBeVisible()
    await dismissToasts()
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('session-archive-light.png') })

    // 恢复后回到侧栏的“置顶”分组
    await archivedRow.getByRole('button', { name: '恢复' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      const meta = state.sessions.find((session) => session.id === originalId)
      return meta?.archived === false && meta?.pinned === true
    }, 15_000, '会话已移出归档')
    await expect(archivedRow).toHaveCount(0)
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText('P1-7 测试', { exact: true })).toBeVisible()
    await setThemeViaStore(page, 'dark')

    // 归档当前会话时应用已切到下一个会话；移出归档后手动切回原会话再验证删除
    await page.evaluate((id) => {
      void (window as unknown as { __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } } })
        .__morrowStore.getState().selectSession(id)
    }, originalId)
    await waitUntil(async () => (await readStore(page)).activeSessionId === originalId, 20_000, '切回原会话')

    // 删除后续：保留当前消息，清掉其后的全部对话
    await page.locator('.message-user').first().hover()
    await page.locator('.message-user').first().getByRole('button', { name: '删除后续消息' }).click()
    const confirm = page.getByRole('alertdialog', { name: '删除后续消息' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 1, 20_000, '后续消息已删除')
    const truncated = await readStore(page)
    expect(truncated.session?.messages[0]?.text).toBe('请回答编辑版')

    // 重启一侧的持久化由 session-store 单测覆盖；这里确认主进程磁盘状态一致
    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, originalId)
    expect(loaded?.messages).toHaveLength(1)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('归档唯一可见对话后自动新建空白对话', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ scripts: [{ text: 'ok' }] })
  const workspace = workspaceAt('e2e-archive-only')
  const morrow = await launchMorrow({ name: 'archive-only', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const id = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '唯一对话'
    })

    await page.evaluate(async (sessionId) => {
      await (
        window as unknown as { __morrowStore: { getState: () => { setSessionArchived: (id: string, value: boolean) => Promise<void> } } }
      ).__morrowStore.getState().setSessionArchived(sessionId, true)
    }, id)

    const state = await readStore(page)
    expect(state.sessions.find((session) => session.id === id)?.archived).toBe(true)
    expect(state.activeSessionId).not.toBe(id)
    expect(state.session?.messages).toHaveLength(0)
    expect(state.sessions.length).toBeGreaterThanOrEqual(2)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
