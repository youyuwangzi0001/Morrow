/**
 * 打包版终端回归：asar 内的 node-pty 原生模块必须可加载，并能真实执行命令。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { getPackagedAppExe } from './packaged-runtime'
import { dismissOnboarding, setThemeViaStore, waitForStoreReady } from './store'

test('打包版：终端能创建真实 PTY 并执行命令', async () => {
  test.setTimeout(180_000)
  const appExe = await getPackagedAppExe()
  if (!appExe) {
    test.skip(true, '需要先构建单文件便携包（npm run dist）再跑打包冒烟')
    return
  }
  // 旧便携包没有 node-pty；打包更新后再跑，避免全量 E2E 被历史产物误伤
  const hasPty = existsSync(
    join(dirname(appExe), 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  )
  test.skip(!hasPty, '需要先构建包含真实终端的便携包（npm run dist）')
  const workspace = join(root, 'tmp', `packaged-terminal-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({
    name: 'packaged-terminal',
    executablePath: appExe,
    timeoutMs: 120_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const state = store.getState()
      const created = await window.morrow.session.create({
        workspace: ws,
        model: state.settings.defaultModel,
        permissionMode: 'auto',
        title: '打包终端测试'
      })
      if (!created.ok) throw new Error(created.error.message)
      await store.getState().selectSession(created.data.id)
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'terminal' } }))
    }, workspace)

    await expect(page.locator('.terminal-dock')).toBeVisible()
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 })
    const shellId = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:list')
      if (!result.ok) return ''
      const list = (result.data as { processes: Array<{ id: string; kind: string }> }).processes
      return list.find((process) => process.kind === 'shell')?.id ?? ''
    })
    expect(shellId).toBeTruthy()
    await page.evaluate(async (id) => {
      await window.morrow.features.invoke('feature:terminal:input', {
        id,
        data: "Write-Output ('packaged_' + 'pty_ok')\r"
      })
    }, shellId)
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const result = await window.morrow.features.invoke('feature:terminal:read', { id, tail: 20_000 })
            return result.ok ? (result.data as { output: string }).output : ''
          }, shellId),
        { timeout: 30_000 }
      )
      .toContain('packaged_pty_ok')

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('packaged-terminal-dark.png') })
  } finally {
    await morrow.close()
  }
})
