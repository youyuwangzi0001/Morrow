/**
 * 终端面板 E2E：
 * - 打开面板即创建真实 PTY，键盘输入可执行命令；
 * - 设置里切换默认终端后，新终端使用所选 Shell；
 * - 后台任务以标签页展示并可停止；
 * - 明暗截图。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, readStore, setThemeViaStore, waitForStoreReady } from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function readTerminal(page: Page, id: string): Promise<string> {
  return page.evaluate(async (terminalId) => {
    const result = await window.morrow.features.invoke('feature:terminal:read', {
      id: terminalId,
      tail: 40_000
    })
    return result.ok ? (result.data as { output: string }).output : ''
  }, id)
}

async function listShells(page: Page): Promise<Array<{ id: string; shellId?: string; status: string }>> {
  return page.evaluate(async () => {
    const result = await window.morrow.features.invoke('feature:terminal:list')
    return result.ok
      ? ((result.data as { processes: Array<{ id: string; shellId?: string; status: string; kind: string }> }).processes)
          .filter((process) => process.kind === 'shell')
          .map((process) => ({ id: process.id, shellId: process.shellId, status: process.status }))
      : []
  })
}

test('真实终端、默认终端切换与后台任务', async () => {
  test.setTimeout(150_000)
  const workspace = workspaceAt('e2e-terminal')
  const morrow = await launchMorrow({ name: 'terminal', timeoutMs: 90_000 })
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
        title: '终端测试'
      })
      if (!created.ok) throw new Error(created.error.message)
      await store.getState().selectSession(created.data.id)
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'terminal' } }))
    }, workspace)

    await expect(page.locator('.terminal-dock')).toBeVisible()
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 })
    const dockBox = await page.locator('.terminal-dock').boundingBox()
    const mainBox = await page.locator('.app-main').boundingBox()
    expect(dockBox?.height).toBe(240)
    expect(Math.abs((dockBox?.x ?? 0) - (mainBox?.x ?? 0))).toBeLessThanOrEqual(1)
    const initialShells = await listShells(page)
    expect(initialShells).toHaveLength(1)
    expect(initialShells[0].shellId).toBeTruthy()

    // 键盘输入走 xterm → 真实 PTY；用不会出现在命令回显里的结果判断
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Write-Output ('pty_' + 'keyboard_ok')")
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readTerminal(page, initialShells[0].id), { timeout: 30_000 })
      .toContain('pty_keyboard_ok')
    // 终端拥有键盘：Ctrl+K 不应打开命令面板
    await page.keyboard.press('Control+K')
    await expect(page.locator('.palette')).toHaveCount(0)

    // 设置里切到命令提示符，主界面不再出现终端类型选择
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ terminalShell: 'cmd' })
    })
    await page.getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.terminal-tab')).toHaveCount(2)
    const shells = await listShells(page)
    const cmdShell = shells.find((shell) => shell.shellId === 'cmd')
    expect(cmdShell).toBeTruthy()
    await page.locator('.xterm-helper-textarea').last().focus()
    await page.keyboard.type('echo %OS%_cmd_ok')
    await page.keyboard.press('Enter')
    await expect.poll(() => readTerminal(page, cmdShell!.id), { timeout: 30_000 }).toContain('Windows_NT_cmd_ok')

    // 后台任务标签页
    const task = await page.evaluate(async (ws) => {
      const result = await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: "Write-Output 'task-pty-ok'"
      })
      return result.ok ? (result.data as { id: string }) : null
    }, workspace)
    expect(task).toBeTruthy()
    const taskTab = page.locator('.terminal-tab').filter({ hasText: 'task-pty-ok' })
    await expect(taskTab).toBeVisible()
    await taskTab.getByRole('tab').click()
    await expect(page.locator('.terminal-task-output')).toContainText('task-pty-ok', { timeout: 30_000 })

    // 长任务 + 停止
    await page.evaluate(async (ws) => {
      await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: "node -e \"setInterval(()=>console.log('tick'),300)\"",
        title: '长时间任务'
      })
    }, workspace)
    const tickTab = page.locator('.terminal-tab').filter({ hasText: '长时间任务' })
    await expect(tickTab).toBeVisible()
    await tickTab.getByRole('tab').click()
    await expect(page.locator('.terminal-task-output')).toContainText('tick', { timeout: 30_000 })
    await page.getByRole('button', { name: '停止终端' }).click()
    await expect(page.locator('.terminal-status-meta')).toContainText('已退出', { timeout: 20_000 })

    // 回到第一个终端截图
    await page.locator('.terminal-tab').first().getByRole('tab').click()
    await expect(page.locator('.terminal-xterm').first()).toBeVisible()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('terminal-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('terminal-light.png') })
    await setThemeViaStore(page, 'dark')

    // 顶栏隐藏/打开终端；进程和标签继续保留
    await page.getByRole('button', { name: '隐藏终端' }).click()
    await expect(page.locator('.terminal-dock')).toBeHidden()
    await page.getByRole('button', { name: '打开终端' }).click()
    await expect(page.locator('.terminal-dock')).toBeVisible()
    await expect(page.locator('.terminal-tab')).toHaveCount(4)

    // 设置 → 终端
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '终端', exact: true }).click()
    await expect(page.locator('.st-search')).toContainText('默认终端')
    await expect(page.locator('.st-search')).toContainText('命令提示符')
    const shellSelect = page.getByRole('button', { name: '默认终端' })
    await shellSelect.click()
    await page.getByRole('option', { name: /Windows PowerShell/ }).click()
    await expect(shellSelect).toContainText('Windows PowerShell')
    const savedShell = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().settings.terminalShell
    })
    expect(savedShell).toBe('powershell')
    await shellSelect.click()
    await page.getByRole('option', { name: /命令提示符/ }).click()
    await expect(shellSelect).toContainText('命令提示符')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('terminal-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('terminal-settings-light.png') })
    await setThemeViaStore(page, 'dark')

    expect((await readStore(page)).session?.workspace).toBe(workspace)
  } finally {
    await morrow.close()
  }
})
