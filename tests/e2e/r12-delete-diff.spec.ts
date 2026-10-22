/**
 * R12 删除 diff：
 * - 删除文件生成 −N 的 diff 摘要；
 * - 同一轮里新建后又删除的文件净变化为零，不显示任何 diff；
 * - 检查点不把净零临时文件带入回退列表。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

test('删除文件显示 diff，新建后删除不显示 diff', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-delete-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'old.txt'), '旧文件一\n旧文件二\n旧文件三\n', 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先建一个临时文件再删掉。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'temp.txt', content: '临时内容\n' } },
          { name: 'delete_file', arguments: { path: 'temp.txt' } }
        ]
      },
      {
        text: '删除旧文件。',
        toolCalls: [{ name: 'delete_file', arguments: { path: 'old.txt' } }]
      },
      { text: '清理完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-delete', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '删除 diff 测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '先建一个临时文件再删除，然后把 old.txt 也删除。')
    await waitForRunFinished(page, 90_000)

    // 新建后删除的 temp.txt 没有净变化；只有 old.txt 留下 −3。
    const diffs = page.locator('.message-diff-summary')
    await expect(diffs).toHaveCount(1)
    await expect(diffs.first()).toContainText('old.txt')
    await expect(diffs.first()).toContainText('−3')
    await expect(diffs.first()).not.toContainText('temp.txt')

    const checkpoints = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data : []
    }, sessionId)
    const files = checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => file.path))
    expect(files.some((path) => path.endsWith('old.txt'))).toBe(true)
    expect(files.some((path) => path.endsWith('temp.txt'))).toBe(false)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-delete-diff-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-delete-diff-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
