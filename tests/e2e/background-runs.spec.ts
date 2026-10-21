/**
 * P0-6 后台运行与运行中心：
 * - 会话 A 运行中可切换到会话 B 并启动第二个运行；
 * - 运行中心列出两个任务，可切换/停止；
 * - 关闭窗口默认隐藏到托盘，应用不退出。
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

    // 关闭窗口 → 默认进托盘，应用仍在运行
    const trayState = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.close()
      await new Promise((resolve) => setTimeout(resolve, 400))
      return {
        count: BrowserWindow.getAllWindows().length,
        visible: win ? win.isVisible() : false,
        destroyed: win ? win.isDestroyed() : true
      }
    })
    expect(trayState.count).toBe(1)
    expect(trayState.destroyed).toBe(false)
    expect(trayState.visible).toBe(false)

    await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.show()
      win?.focus()
    })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
