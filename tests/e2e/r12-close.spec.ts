/**
 * R12 关闭流程：关闭按钮询问 → 记住选择 → 最小化到任务栏 / 完全退出。
 */
import { expect, test } from '@playwright/test'
import { launchMorrow, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

async function mainWindowState(app: MorrowApp): Promise<{ minimized: boolean; visible: boolean } | null> {
  return app.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
    if (!win || win.isDestroyed()) return null
    return { minimized: win.isMinimized(), visible: win.isVisible() }
  })
}

test('关闭按钮先询问；选择后记住并最小化到任务栏；改为退出后不再询问', async () => {
  test.setTimeout(120_000)
  test.skip(process.platform !== 'win32', 'Windows 窗口行为测试')
  const morrow = await launchMorrow({ name: 'r12-close', timeoutMs: 90_000 })
  let closed = false
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 第一次关闭：必须弹出询问弹窗，而不是直接隐藏/退出
    await page.locator('.tb-win-close').click()
    const dialog = page.getByRole('dialog', { name: '要关闭 Morrow 吗？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('最小化到任务栏')
    await expect(dialog).toContainText('完全退出')
    await page.screenshot({ path: 'docs/verification/screens/r12-close-ask.png' })

    await dialog.getByRole('button', { name: /最小化到任务栏/ }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 })
      .toBe(true)
    const minimizedState = await mainWindowState(morrow)
    expect(minimizedState?.minimized).toBe(true)
    const settings = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      return result.ok ? result.data.closeAction : null
    })
    expect(settings).toBe('minimize')

    // 恢复窗口后再关闭：已记住选择，不再弹窗，直接最小化
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
      win?.restore()
      win?.show()
      win?.focus()
    })
    await expect.poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 }).toBe(false)
    await page.locator('.tb-win-close').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 }).toBe(true)

    // 改为“退出”：下一次关闭直接结束进程，不再询问
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
      win?.restore()
      win?.show()
      win?.focus()
    })
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.settings.update({ closeAction: 'quit' })
      return result.ok
    })
    expect(saved).toBe(true)
    const closePromise = morrow.app.waitForEvent('close', { timeout: 20_000 })
    await page.locator('.tb-win-close').click()
    await closePromise
    closed = true
  } finally {
    if (!closed) await morrow.close()
  }
})
