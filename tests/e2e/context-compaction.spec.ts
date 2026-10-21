/**
 * 手动上下文压缩：
 * - 压缩期间禁止发送/再次压缩（主进程 + 渲染层双重拦截），不会丢新消息；
 * - 摘要收敛为「上下文已压缩」系统标记，按需展开，不再伪装成助手长回复；
 * - 压缩后旧消息按安全切点折叠，原始用户约束保留。
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
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

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
