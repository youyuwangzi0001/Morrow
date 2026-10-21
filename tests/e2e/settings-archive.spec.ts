/**
 * 对话归档管理：归档后只在 设置 → 归档 中出现，可恢复、可永久删除；
 * 关于页不再承载「清除全部对话」。
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
  waitForStoreReady,
  waitUntil
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('设置中的对话归档：归档、恢复与永久删除', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [{ text: '甲的归档前回答。' }, { text: '乙的归档前回答。' }]
  })
  const workspace = workspaceAt('e2e-settings-archive')
  const morrow = await launchMorrow({ name: 'settings-archive', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)

    const finishedRuns = async (): Promise<number> =>
      (await getEvents(page)).filter((event) => event.type === 'run_finished').length
    const waitForNextFinish = async (before: number, label: string): Promise<void> =>
      waitUntil(async () => (await finishedRuns()) > before, 30_000, label)

    let finished = await finishedRuns()
    const firstId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '归档测试甲'
    })
    await sendMessageViaStore(page, '甲的问题')
    await waitForNextFinish(finished, '甲回答完成')

    finished = await finishedRuns()
    const secondId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '归档测试乙'
    })
    await sendMessageViaStore(page, '乙的问题')
    await waitForNextFinish(finished, '乙回答完成')

    await page.evaluate(async (ids: string[]) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setSessionArchived: (id: string, value: boolean) => Promise<void> } }
      }).__morrowStore
      for (const id of ids) await store.getState().setSessionArchived(id, true)
    }, [firstId, secondId])
    await waitUntil(async () => {
      const state = await readStore(page)
      return [firstId, secondId].every(
        (id) => state.sessions.find((session) => session.id === id)?.archived === true
      )
    }, 15_000, '两个对话已归档')
    await expect(page.getByText('归档测试甲', { exact: true })).toHaveCount(0)
    await expect(page.getByText('归档测试乙', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sb-group.is-archived')).toHaveCount(0)

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    const archive = page.locator('.st-archive')
    await expect(archive).toContainText('已归档 2 个对话')
    const firstRow = archive.locator('.st-archive-row').filter({ hasText: '归档测试甲' })
    const secondRow = archive.locator('.st-archive-row').filter({ hasText: '归档测试乙' })
    await expect(firstRow).toBeVisible()
    await expect(secondRow).toBeVisible()
    await expect(firstRow).toContainText('2 条消息')
    await expect(secondRow).toContainText('2 条消息')
    await expect(page.locator('#st-tab-archive')).toHaveAttribute('aria-selected', 'true')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-archive-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('settings-archive-light.png') })
    await setThemeViaStore(page, 'dark')

    await firstRow.getByRole('button', { name: '恢复' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === firstId)?.archived === false
    }, 15_000, '甲已恢复')
    await expect(firstRow).toHaveCount(0)
    await expect(archive).toContainText('已归档 1 个对话')

    await secondRow.getByRole('button', { name: '删除归档对话「归档测试乙」' }).click()
    const dialog = page.getByRole('dialog', { name: '删除归档对话？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('归档测试乙')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-archive-delete.png') })
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return !state.sessions.some((session) => session.id === secondId)
    }, 20_000, '乙已删除')
    expect(existsSync(join(morrow.dataDir, 'sessions', `${secondId}.json`))).toBe(false)
    await expect(archive).toContainText('还没有归档的对话')

    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText('归档测试甲', { exact: true })).toBeVisible()
    await expect(page.getByText('归档测试乙', { exact: true })).toHaveCount(0)

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-about').click()
    await expect(page.locator('.st-about')).not.toContainText('清除全部对话')
    await page.locator('#st-tab-archive').click()
    await expect(page.locator('.st-archive .st-danger-zone')).toContainText('清除全部对话')
  } finally {
    await morrow.close()
    await mock.close()
  }
})
