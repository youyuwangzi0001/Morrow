/**
 * P1-8 Git 工作台 E2E：
 * - 工作台入口打开 Git 面板；非仓库工作区可一键 init；
 * - 未跟踪文件 → 查看差异 → 暂存 → 提交；
 * - 工作区改动 → 放弃（带确认）；
 * - 暂存全部 / 取消暂存；新建并切换分支；
 * - 历史提交与差异只读展示。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  openToolPanel,
  setThemeViaStore,
  waitUntil,
  waitForStoreReady
} from './store'

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
    await page.getByRole('button', { name: '提交', exact: true }).click()
    // 未配置 Git 身份时给出可执行的提示；配置后重试成功
    await expect(page.getByText(/user\.name/)).toBeVisible({ timeout: 15_000 })
    git(workspace, 'config', 'user.name', 'Morrow E2E')
    git(workspace, 'config', 'user.email', 'e2e@example.com')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
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
