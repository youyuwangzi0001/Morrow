/**
 * P0-3 检查点回退 E2E：
 * - 两轮真实写文件 → 自动生成检查点；
 * - 消息「回退」按钮 + /rewind 命令打开面板；
 * - 外部修改触发冲突并禁用确认；
 * - 恢复预期内容后回退 both：notes 回到 v1、新建文件删除、对话清空。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

test('检查点回退：冲突检测 → 恢复文件与对话', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我来修改文件。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'notes.md', content: 'v2\n' } },
          { name: 'write_file', arguments: { path: 'new.md', content: 'new\n' } }
        ]
      },
      { text: '第一轮完成。' },
      { text: '继续修改。', toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: 'v3\n' } }] },
      { text: '第二轮完成。' }
    ]
  })
  const workspace = workspaceAt('e2e-checkpoint')
  writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8')
  const morrow = await launchMorrow({ name: 'checkpoint', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '检查点测试'
    })

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('把 notes.md 改成 v2，并新建 new.md。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v2\n')

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('再把 notes.md 改成 v3。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第二轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v3\n')

    // 主进程检查点已落盘（两轮）
    await waitUntil(
      async () =>
        page.evaluate(async (id) => {
          const result = await window.morrow.checkpoints.list(id)
          return result.ok && result.data.length === 2 ? result.data.length : null
        }, sessionId),
      20_000,
      '两个检查点'
    )

    // 外部修改一个已登记文件 → 从回答末尾「回退」打开唯一的确认弹窗
    writeFileSync(join(workspace, 'notes.md'), 'external\n', 'utf8')
    await page.getByRole('button', { name: '回退这一轮' }).first().click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.locator('.rewind-confirm-list')).toHaveCount(0)
    await expect(page.getByText(/有 1 个文件被改过/)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files li.is-conflict')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '确认回退' })).toBeDisabled()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-conflict-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('rewind-conflict-light.png') })
    await setThemeViaStore(page, 'dark')

    // 修好文件后，在同一个确认弹窗里「重新检查」即可解除冲突
    writeFileSync(join(workspace, 'notes.md'), 'v3\n', 'utf8')
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(page.getByText(/有 1 个文件被改过/)).toHaveCount(0)
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('new.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('删除新文件')
    await expect(page.getByRole('button', { name: '确认回退' })).toBeEnabled()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-ready-dark.png') })

    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这一轮之前/)).toBeVisible({ timeout: 10_000 })
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 0, 20_000, '对话已回退')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v1\n')
    expect(() => readFileSync(join(workspace, 'new.md'), 'utf8')).toThrow()

    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.messages).toHaveLength(0)
    const remaining = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data.length : -1
    }, sessionId)
    expect(remaining).toBe(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
