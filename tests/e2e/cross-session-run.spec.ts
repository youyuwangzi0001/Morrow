/**
 * 跨会话运行态回归：A 在等待审批时切到 B，审批不丢；
 * B 显示后台运行/待确认提示与会话行标记，返回 A 后可继续批准并完成。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clickPermissionCard,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  waitForPermission,
  waitForRunFinished,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

test.describe('跨会话运行态', () => {
  test('A 等待审批时切到 B：提示保留、返回可批准、完成后后台状态清理', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-session-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: 'cross.md', content: 'from session A' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-run', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '跨会话 A'
      })
      const sessionB = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '跨会话 B'
      })
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionA)

      await sendMessageViaStore(page, '请在 A 会话里写 cross.md。')
      await waitForRunStarted(page, 30_000)
      const permission = await waitForPermission(page, 30_000)
      expect(permission.toolName).toBe('write_file')

      // 通过真实侧栏切到 B（A 仍在等待审批）
      const rowB = page.locator('.sb-session').filter({ hasText: '跨会话 B' }).locator('.sb-session-main')
      await rowB.click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切换到会话 B')

      const background = page.locator('.composer-background')
      await expect(background).toBeVisible({ timeout: 10_000 })
      await expect(background).toContainText('跨会话 A')
      await expect(background).toContainText('等待你的确认')
      await expect(page.locator('.sb-session').filter({ hasText: '跨会话 A' }).locator('.sb-session-flag.is-attention')).toBeVisible()
      await expect(page.locator('.permission-card')).toHaveCount(0)
      await expect(background.getByRole('button', { name: '返回处理' })).toBeVisible()
      await expect(background.getByRole('button', { name: '停止' })).toBeVisible()
      await page.locator('[aria-label="收起通知"]').last().click().catch(() => undefined)
      await page.waitForTimeout(250)

      await page.screenshot({ path: screenshotPath('cross-session-waiting-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('cross-session-waiting-light.png') })
      await setThemeViaStore(page, 'dark')

      await background.getByRole('button', { name: '返回处理' }).click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '返回会话 A')
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)

      expect(existsSync(join(workspace, 'cross.md'))).toBe(true)
      const pending = await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        return {
          permissions: Object.keys(state.pendingPermissions ?? {}),
          questions: Object.keys(state.pendingQuestions ?? {}),
          run: state.run
        }
      })
      expect(pending.permissions).toEqual([])
      expect(pending.questions).toEqual([])
      expect(pending.run).toBeNull()

      // 回到 B：后台提示与运行标记应消失
      const rowBAfter = page.locator('.sb-session').filter({ hasText: '跨会话 B' }).locator('.sb-session-main')
      await rowBAfter.click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切回会话 B')
      await expect(page.locator('.composer-background')).toHaveCount(0)
      await expect(page.locator('.sb-session').filter({ hasText: '跨会话 A' }).locator('.sb-session-flag')).toHaveCount(0)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('新建对话不会继承上一个会话的审批卡，返回后仍可批准', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-new-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '等待批准再写。',
          toolCalls: [{ name: 'write_file', arguments: { path: 'new-session.md', content: 'ok' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-new', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '待审批 A'
      })
      await sendMessageViaStore(page, '请写 new-session.md。')
      await waitForPermission(page, 30_000)
      await expect(page.locator('.permission-card')).toBeVisible()

      await page.evaluate(async () => {
        await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .newSession()
      })
      await waitUntil(async () => (await readStore(page)).activeSessionId !== sessionA, 10_000, '新建对话')
      await expect(page.locator('.permission-card')).toHaveCount(0)

      await page.evaluate(async (id) => {
        await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .selectSession(id)
      }, sessionA)
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)
      expect(existsSync(join(workspace, 'new-session.md'))).toBe(true)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('在 B 时后台 A 才请求审批：toast 提醒并可一键回到 A 处理', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-toast-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          delayMs: 1_200,
          text: '我先写一个文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: 'cross-toast.md', content: 'from A' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-toast', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '后台审批 A'
      })
      const sessionB = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '后台审批 B'
      })
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionA)
      await sendMessageViaStore(page, '请在 A 里写 cross-toast.md。')
      await waitForRunStarted(page, 30_000)
      // 抢在模型返回工具调用前切到 B
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionB)
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切换到 B')

      const toast = page.locator('.toast-item').filter({ hasText: '后台审批 A' }).filter({ hasText: '需要你的确认' })
      await expect(toast).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.run-center-item.is-waiting')).toContainText('等待确认')
      await expect(toast.getByRole('button', { name: '去处理' })).toBeVisible()
      await toast.getByRole('button', { name: '去处理' }).click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '通过 toast 回到 A')
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)
      expect(existsSync(join(workspace, 'cross-toast.md'))).toBe(true)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})
