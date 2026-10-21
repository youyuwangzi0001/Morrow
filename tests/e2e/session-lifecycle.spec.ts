/**
 * 会话生命周期回归：运行中删除 → 停止运行、清理撤销快照、删除会话文件，且工作区文件保留。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  waitForEvent,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

test.describe('会话生命周期', () => {
  test('运行中删除会话：先停止、清快照、删文件，工作区不受影响', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-session-delete-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写文件，再跑一个稍长的命令。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'draft.md', content: 'hello from session lifecycle test' } },
            { name: 'run_command', arguments: { command: 'Start-Sleep -Seconds 30; Write-Output done' } }
          ]
        }
      ]
    })
    const morrow = await launchMorrow({ name: 'session-delete', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: '运行中删除测试'
      })
      const before = await readStore(page)
      const sessionId = before.session!.id
      const sessionFile = join(morrow.dataDir, 'sessions', `${sessionId}.json`)
      const snapshotDir = join(morrow.dataDir, 'snapshots', sessionId)

      await sendMessageViaStore(page, '请先写 draft.md，再执行一个 30 秒的命令。')
      await waitForRunStarted(page, 30_000)
      await waitForEvent(
        page,
        'tool_started',
        (event) => (event as { block?: { name?: string } }).block?.name === 'run_command',
        30_000
      )
      await waitUntil(async () => existsSync(snapshotDir), 10_000, '撤销快照目录创建')
      expect(existsSync(sessionFile)).toBe(true)
      const running = await readStore(page)
      expect(running.run?.sessionId).toBe(sessionId)

      const row = page.locator('.sb-session.is-active')
      await row.hover()
      await row.getByRole('button', { name: '删除对话' }).click()
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(320)
      await expect(dialog).toContainText('正在运行')
      await expect(dialog).toContainText('撤销快照')
      await page.screenshot({ path: screenshotPath('session-delete-running-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('session-delete-running-light.png') })
      await setThemeViaStore(page, 'dark')

      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await waitUntil(async () => (await readStore(page)).session === null, 20_000, '当前会话被删除')
      await expect.poll(async () => (await readStore(page)).run, { timeout: 20_000 }).toBeNull()
      // 删除后会按 tombstone 丢弃迟到的运行事件，因此 run_finished 不保证还能到达；
      // 若在删除前已经到达，则必须是 cancelled，而不是正常完成。
      const finished = (await getEvents(page)).find((event) => event.type === 'run_finished')
      if (finished) expect((finished as { reason?: string }).reason).toBe('cancelled')

      expect(existsSync(sessionFile)).toBe(false)
      expect(existsSync(snapshotDir)).toBe(false)
      expect(existsSync(join(workspace, 'draft.md'))).toBe(true)
      await page.waitForTimeout(1_500)
      expect(existsSync(sessionFile)).toBe(false)
      expect(existsSync(snapshotDir)).toBe(false)

      const after = await readStore(page)
      expect(after.sessions.length).toBe(0)
      expect(after.run).toBeNull()
      expect((await getEvents(page)).filter((event) => event.type === 'error')).toHaveLength(0)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})
