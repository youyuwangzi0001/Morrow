/**
 * 数据目录自定义：真实走主进程选目录 → 迁移 → 写指针 → 恢复默认。
 * 测试用 MORROW_DATA_LOCATION_FILE 把指针放到项目 tmp/，避免碰真实用户配置；
 * 测试模式不重启应用，因此可以直接断言指针与迁移结果。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, type MorrowApp } from './launch'
import { dismissOnboarding, waitForStoreReady } from './store'

test.describe('数据目录设置', () => {
  let morrow: MorrowApp | null = null
  let target = ''
  let pointer = ''

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    if (target) rmSync(target, { recursive: true, force: true })
    if (pointer) rmSync(pointer, { force: true })
  })

  test('更改目录会迁移数据并写入指针；恢复默认会移除指针', async () => {
    test.setTimeout(120_000)
    mkdirSync(join(root, 'tmp'), { recursive: true })
    target = mkdtempSync(join(root, 'tmp', 'data-dir-target-'))
    pointer = join(root, 'tmp', `data-location-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)

    morrow = await launchMorrow({
      name: 'data-dir-settings',
      timeoutMs: 90_000,
      env: {
        MORROW_ALLOW_DATA_DIR_CHANGE: '1',
        MORROW_DATA_LOCATION_FILE: pointer
      }
    })
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 主进程原生对话框在测试中替换为固定返回值：选择 target，并选择「迁移并重启」
    await app.evaluate(async ({ dialog }, selected) => {
      const patched = dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>
        showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>
      }
      patched.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      patched.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }, target)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    const change = settings.getByRole('button', { name: '更改目录' })
    await expect(change).toBeEnabled({ timeout: 10_000 })
    await change.click()
    await expect(page.getByText(/数据目录已保存，重启后生效/)).toBeVisible({ timeout: 20_000 })

    expect(existsSync(pointer)).toBe(true)
    const saved = JSON.parse(readFileSync(pointer, 'utf8')) as { dataDir: string }
    expect(saved.dataDir).toBe(resolve(target))
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(join(target, 'sessions'))).toBe(true)
    expect(existsSync(join(target, 'Cache'))).toBe(false)

    const reset = await page.evaluate(() => window.morrow.app.resetDataDir())
    expect(reset.ok).toBe(true)
    expect(existsSync(pointer)).toBe(false)
  })
})
