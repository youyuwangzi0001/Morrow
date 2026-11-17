import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import { launchMorrow, waitForStoreReady, dismissOnboarding, configureMockProvider, createSession, openToolPanel } from './helpers'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

/**
 * 回归：v0.2.0 那次提交涉及 650 个文件、patch 约 14MB。
 * 旧实现用 execFile 的 8MB maxBuffer 收集 git 输出，超限时子进程被杀，
 * 溢出的 stdout 被当成错误消息弹窗，表现为「点击版本 → 无法读取提交内容」。
 * 这里在真实 Electron 里造一个 12MB 的提交，确认历史页能读出来并提示已截断。
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('@core:git 超大提交在版本历史里可读取并提示截断', async () => {
  test.setTimeout(240_000)
  const mock = await startMockLLM({ scripts: [{ text: '好的。' }] })
  const workspace = join(tmpdir(), `morrow-e2e-bigcommit-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  execFileSync('icacls', [workspace, '/setintegritylevel', '(OI)(CI)L'], { encoding: 'utf8', windowsHide: true })
  git(workspace, 'init')
  git(workspace, 'config', 'user.name', 'Morrow E2E')
  git(workspace, 'config', 'user.email', 'e2e@example.com')
  // 约 12MB 文本：旧实现的 8MB maxBuffer 必然爆掉
  writeFileSync(join(workspace, 'huge.txt'), `${'0123456789'.repeat(20)}\n`.repeat(60_000), 'utf8')
  git(workspace, 'add', 'huge.txt')
  git(workspace, 'commit', '-m', '超大提交')

  const morrow = await launchMorrow({ name: 'git-big-commit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '大提交测试' })

    await openToolPanel(page, 'Git')
    const dialog = page.getByRole('dialog', { name: '版本历史' })
    await expect(dialog).toBeVisible()
    await page.getByRole('tab', { name: '历史' }).click()

    const item = page.locator('.git-commit-item').first()
    await expect(item).toContainText('超大提交')
    await item.click()

    // 详情必须真的读出来：标题正确、diff 有内容、并明确告知已截断
    await expect(page.locator('.git-detail-title')).toContainText('超大提交', { timeout: 60_000 })
    await expect(page.getByLabel('文件差异')).toContainText('diff --git a/huge.txt b/huge.txt')
    await expect(page.getByText('差异过大，已截断')).toBeVisible()
    // 不能再出现把 diff 内容当错误弹出的情况
    await expect(page.locator('.error-note')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
})
