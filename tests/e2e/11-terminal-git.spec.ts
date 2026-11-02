/**
 * 合并自 2 个 E2E spec：terminal-panel.spec.ts、git-workbench.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { configureMockProvider, createSession, dismissOnboarding, openToolPanel, readStore, setThemeViaStore, waitForStoreReady, waitUntil } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

// ── 原文件：terminal-panel.spec.ts ──────────────────────────────────────────────
test.describe('terminal-panel.spec.ts', () => {
/**
 * 终端面板 E2E：
 * - 打开面板即创建真实 PTY，键盘输入可执行命令；
 * - 设置里切换默认终端后，新终端使用所选 Shell；
 * - 后台任务以标签页展示并可停止；
 * - 明暗截图。
 */

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
    const shellProfiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      if (!result.ok) return { ids: [] as string[], defaultShell: '' }
      const data = result.data as { profiles: Array<{ id: string }>; defaultShell: string }
      return { ids: data.profiles.map((item) => item.id), defaultShell: data.defaultShell }
    })
    expect(shellProfiles.defaultShell).toBe('gitbash')
    expect(shellProfiles.ids).not.toContain('powershell')
    expect(shellProfiles.ids).not.toContain('cmd')
    // 后续用例使用 PowerShell 语法；显式选择 PowerShell 7，同时保留上面的 Git Bash 默认断言。
    await page.evaluate(async () => {
      await window.morrow.settings.update({ terminalShell: 'pwsh' })
    })
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
    // 原生 viewport 滚动条必须隐藏，否则上下三角会和自定义滑块重叠；
    // 自定义滑块与主区域原生细滚动条一致：6px 实心、全圆角、无渐变高光。
    const scrollbarState = async (): Promise<{ width: string; radius: string; background: string; backgroundImage: string; viewportScrollbar: string; opacity: string; invisible: boolean }> =>
      page.locator('.terminal-xterm .xterm-scrollable-element > .scrollbar.vertical').first().evaluate((element) => {
        const slider = element.querySelector('.slider')
        const viewport = document.querySelector('.terminal-xterm .xterm-viewport')
        return {
          width: slider ? getComputedStyle(slider).width : '',
          radius: slider ? getComputedStyle(slider).borderRadius : '',
          background: slider ? getComputedStyle(slider).backgroundColor : '',
          backgroundImage: slider ? getComputedStyle(slider).backgroundImage : '',
          viewportScrollbar: viewport ? getComputedStyle(viewport).scrollbarWidth : '',
          opacity: getComputedStyle(element).opacity,
          invisible: element.classList.contains('invisible')
        }
      })
    const scrollbarStyle = await scrollbarState()
    expect(scrollbarStyle.width).toBe('6px')
    expect(scrollbarStyle.radius).toBe('999px')
    expect(scrollbarStyle.background).toBe('rgb(138, 111, 66)')
    expect(scrollbarStyle.backgroundImage).toBe('none')
    expect(scrollbarStyle.viewportScrollbar).toBe('none')
    // 初始只有一行提示符：滚动条应与主区域一样自动隐藏。
    expect(scrollbarStyle.invisible || scrollbarStyle.opacity === '0').toBe(true)
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
    // 中文输出必须按 UTF-8 到达 xterm，不能出现菱形替换符
    await page.keyboard.insertText("Write-Output '中文终端_ok'")
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readTerminal(page, initialShells[0].id), { timeout: 30_000 })
      .toContain('中文终端_ok')
    // 输出超过当前终端高度后，滚动条才出现；与主区域原生滚动条一致。
    await page.keyboard.insertText('1..80 | ForEach-Object { "scroll_$_" }')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readTerminal(page, initialShells[0].id), { timeout: 30_000 })
      .toContain('scroll_80')
    await expect.poll(async () => (await scrollbarState()).opacity).toBe('1')
    // 终端拥有键盘：Ctrl+K 不应打开命令面板
    await page.keyboard.press('Control+K')
    await expect(page.locator('.palette')).toHaveCount(0)

    // 设置里切到 PowerShell 7，主界面不再出现终端类型选择
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ terminalShell: 'pwsh' })
    })
    await page.getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.terminal-tab')).toHaveCount(2)
    const shells = await listShells(page)
    const pwshShell = shells.filter((shell) => shell.shellId === 'pwsh').at(-1)
    expect(pwshShell).toBeTruthy()
    expect(pwshShell!.id).not.toBe(initialShells[0].id)
    await page.locator('.xterm-helper-textarea').last().focus()
    await page.keyboard.type("Write-Output 'pwsh_terminal_ok'")
    await page.keyboard.press('Enter')
    await expect.poll(() => readTerminal(page, pwshShell!.id), { timeout: 30_000 }).toContain('pwsh_terminal_ok')
    await page.keyboard.insertText("Write-Output '中文终端_pwsh_ok'")
    await page.keyboard.press('Enter')
    await expect.poll(() => readTerminal(page, pwshShell!.id), { timeout: 30_000 }).toContain('中文终端_pwsh_ok')

    // 后台任务标签页
    const task = await page.evaluate(async (ws) => {
      const result = await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: "echo task-pty-ok"
      })
      return result.ok ? (result.data as { id: string }) : null
    }, workspace)
    expect(task).toBeTruthy()
    const taskTab = page.locator('.terminal-tab').filter({ hasText: 'task-pty-ok' })
    await expect(taskTab).toBeVisible()
    await taskTab.getByRole('tab').click()
    await expect(page.locator('.terminal-task-output')).toContainText('task-pty-ok', { timeout: 30_000 })

    // 长任务 + 停止（写成脚本文件，避免 cmd 下嵌套引号把命令吃掉）
    writeFileSync(join(workspace, 'tick.js'), "setInterval(() => console.log('tick'), 300)\n")
    await page.evaluate(async (ws) => {
      await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: 'node tick.js',
        title: '长时间任务'
      })
    }, workspace)
    const tickTab = page.locator('.terminal-tab').filter({ hasText: '长时间任务' })
    await expect(tickTab).toBeVisible()
    await tickTab.getByRole('tab').click()
    await expect(page.locator('.terminal-task-output')).toContainText('tick', { timeout: 30_000 })
    await page.getByRole('button', { name: '停止终端' }).click()
    await expect(tickTab.locator('.terminal-tab-dot')).not.toHaveClass(/is-running/, { timeout: 20_000 })

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
    const shellSelect = page.getByRole('button', { name: '默认终端' })
    await shellSelect.click()
    await expect(page.getByRole('option', { name: /Git Bash/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Windows PowerShell/ })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /命令提示符/ })).toHaveCount(0)
    await page.getByRole('option', { name: /Git Bash/ }).click()
    await expect(shellSelect).toContainText('Git Bash')
    const savedShell = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().settings.terminalShell
    })
    expect(savedShell).toBe('gitbash')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('terminal-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('terminal-settings-light.png') })
    await setThemeViaStore(page, 'dark')
    await shellSelect.click()
    await page.getByRole('option', { name: /PowerShell 7/ }).click()
    await expect(shellSelect).toContainText('PowerShell 7')

    expect((await readStore(page)).session?.workspace).toBe(workspace)
  } finally {
    await morrow.close()
  }
})

})

// ── 原文件：git-workbench.spec.ts ──────────────────────────────────────────────
test.describe('git-workbench.spec.ts', () => {
/**
 * P1-8 Git 工作台 E2E：
 * - 工作台入口打开 Git 面板；非仓库工作区可一键 init；
 * - 未跟踪文件 → 查看差异 → 暂存 → 提交；
 * - 工作区改动 → 放弃（带确认）；
 * - 暂存全部 / 取消暂存；新建并切换分支；
 * - 历史提交与差异只读展示。
 */

/** Git 测试工作区放在系统临时目录：不能落在 Morrow 仓库内部（会命中父仓库的安全边界）。 */
function workspaceAt(): string {
  return mkdtempSync(join(tmpdir(), 'morrow-e2e-git-'))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('Git 工作台：初始化、差异、暂存提交、放弃、分支与历史', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({ scripts: [{ text: '好的。' }] })
  const workspace = workspaceAt()
  const morrow = await launchMorrow({ name: 'git-workbench', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'Git 测试'
    })

    await openToolPanel(page, 'Git')
    const dialog = page.getByRole('dialog', { name: '版本历史' })
    await expect(dialog).toBeVisible()

    // 页脚必须完整落在模态可视区内（高缩放下曾因固定高度被挤出）
    const layout = await dialog.evaluate((panel) => {
      const body = panel.querySelector<HTMLElement>('.modal-body')
      const foot = panel.querySelector<HTMLElement>('.git-foot')
      if (!body || !foot) return null
      return {
        overflow: body.scrollHeight - body.clientHeight,
        footBottom: foot.getBoundingClientRect().bottom,
        bodyBottom: body.getBoundingClientRect().bottom
      }
    })
    expect(layout).not.toBeNull()
    expect(layout!.overflow).toBeLessThanOrEqual(1)
    expect(layout!.footBottom).toBeLessThanOrEqual(layout!.bodyBottom + 1)

    // 非仓库 → 初始化
    await expect(page.getByText('这里还不是 Git 仓库')).toBeVisible()
    await page.getByRole('button', { name: '初始化 Git 仓库' }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(git(workspace, 'rev-parse', '--is-inside-work-tree')).toBe('true')
    await expect(page.locator('.git-tab.is-active')).toHaveCSS('height', '24px')
    await expect(page.locator('.git-tab.is-active')).toHaveCSS('border-radius', '5px')

    // 未跟踪文件：查看差异（工作区是全新的，先关闭引导通知再截图）
    writeFileSync(join(workspace, 'notes.md'), '# Notes\n\nHello from Morrow\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    const notesRow = page.locator('.git-file-row').filter({ hasText: 'notes.md' }).first()
    await expect(notesRow).toBeVisible()
    await notesRow.locator('.git-file-main').click()
    await expect(page.getByLabel('文件差异')).toContainText('+Hello from Morrow')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('git-workbench-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('git-workbench-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)

    // 暂存并提交
    await page.getByRole('button', { name: '暂存 notes.md' }).click()
    await expect(page.getByRole('region', { name: '已暂存的改动' })).toContainText('notes.md')
    await page.getByLabel('提交信息').fill('添加笔记')
    // 未配置身份时在面板内直接填写；首次提交会写入当前仓库的 .git/config 并完成提交
    await expect(page.getByRole('group', { name: '设置 Git 身份' })).toBeVisible()
    await page.screenshot({ path: screenshotPath('git-identity-dark.png') })
    await page.getByLabel('Git 用户名').fill('Morrow E2E')
    await page.getByLabel('Git 邮箱').fill('e2e@example.com')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(git(workspace, 'config', '--local', '--get', 'user.name')).toBe('Morrow E2E')
    expect(git(workspace, 'config', '--local', '--get', 'user.email')).toBe('e2e@example.com')
    expect(git(workspace, 'log', '--format=%s')).toBe('添加笔记')

    // 工作区改动 → 放弃（二次确认）
    writeFileSync(join(workspace, 'notes.md'), '# Notes\n\n被改坏了\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    await expect(page.locator('.git-file-row').filter({ hasText: 'notes.md' }).first()).toBeVisible()
    await page.getByRole('button', { name: '放弃 notes.md 的改动' }).click()
    const confirm = page.getByRole('alertdialog', { name: '放弃改动确认' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8').replace(/\r\n/g, '\n')).toContain('Hello from Morrow')

    // 暂存全部 → 取消暂存 → 再暂存并提交
    writeFileSync(join(workspace, 'feature.txt'), 'feature\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    await page.getByRole('button', { name: '暂存全部' }).click()
    await page.getByRole('button', { name: '取消暂存 feature.txt' }).click()
    await expect(page.getByRole('button', { name: '暂存 feature.txt' })).toBeVisible()
    await page.getByRole('button', { name: '暂存全部' }).click()
    await page.getByLabel('提交信息').fill('添加功能文件')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(git(workspace, 'log', '--format=%s').split('\n')).toEqual(['添加功能文件', '添加笔记'])

    // 新建并切换分支
    const baseBranch = git(workspace, 'branch', '--show-current')
    await page.getByRole('button', { name: '切换或新建分支' }).click()
    await page.getByLabel('新分支名').fill('feature/git-panel')
    await page.getByLabel('新分支名').press('Enter')
    await waitUntil(async () => git(workspace, 'branch', '--show-current') === 'feature/git-panel', 15_000, '新分支已切换')
    await expect(page.getByRole('button', { name: '切换或新建分支' })).toContainText('feature/git-panel')

    // 在功能分支新增提交，确认历史页随分支切换刷新
    writeFileSync(join(workspace, 'branch-only.txt'), 'branch\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    await page.getByRole('button', { name: '暂存全部' }).click()
    await page.getByLabel('提交信息').fill('分支提交')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('tab', { name: '历史' }).click()
    await expect(page.locator('.git-commit-item')).toHaveCount(3)
    await expect(page.locator('.git-detail-title')).toContainText('分支提交')

    // 在历史页直接切回原分支：列表与详情必须随分支失效并刷新
    await page.getByRole('button', { name: '切换或新建分支' }).click()
    await page.getByRole('menuitem', { name: new RegExp(baseBranch) }).click()
    await waitUntil(async () => git(workspace, 'branch', '--show-current') === baseBranch, 15_000, '切回原分支')
    await expect(page.locator('.git-commit-item')).toHaveCount(2)
    await expect(page.locator('.git-detail-title')).toContainText('添加功能文件')
    await expect(page.locator('.git-diff')).toContainText('+feature')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('git-history-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
})

})
