/**
 * 并行子代理 UI：活动条展示任务、审批卡一次只出现一张、两个子代理都能完成。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clickPermissionCard,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  waitForPermission,
  waitForRunFinished,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

test('并行子代理：审批卡串行、活动条可见、两个子任务真实落盘', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我并行安排两个子任务。',
        toolCalls: [
          { name: 'task', arguments: { description: '写入 A', prompt: '请在上一级目录创建 alpha.txt，内容为 A。' } },
          { name: 'task', arguments: { description: '写入 B', prompt: '请在上一级目录创建 beta.txt，内容为 B。' } }
        ]
      },
      { text: '开始写文件。', toolCalls: [{ name: 'write_file', arguments: { path: '../alpha.txt', content: 'A' } }] },
      { text: '开始写文件。', toolCalls: [{ name: 'write_file', arguments: { path: '../beta.txt', content: 'B' } }] },
      { text: '子任务 A 完成。' },
      { text: '子任务 B 完成。' },
      { text: '两个子任务都完成了。' }
    ]
  })
  const workspace = join(root, 'tmp', `e2e-subagent-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'subagent-ui', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '并行子代理测试' })
    await installEventCollector(page)

    await sendMessageViaStore(page, '并行创建两个文件。')
    await waitForRunStarted(page, 30_000)
    const first = await waitForPermission(page, 30_000)
    expect(first.toolName).toBe('write_file')
    await expect(page.locator('.permission-card')).toHaveCount(1)
    await clickPermissionCard(page, 'once')

    // 第一张审批卡结束后才出现第二张，不能同时叠两张
    const second = await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.pendingPermission && state.pendingPermission.id !== first.id ? state.pendingPermission : null
      },
      30_000,
      '第二张审批卡'
    )
    expect(second.toolName).toBe('write_file')
    await expect(page.locator('.permission-card')).toHaveCount(1)
    await clickPermissionCard(page, 'once')

    await waitForRunFinished(page, 90_000)
    await expect(page.getByText('两个子任务都完成了。')).toBeVisible()
    expect(existsSync(join(workspace, '..', 'alpha.txt'))).toBe(true)
    expect(existsSync(join(workspace, '..', 'beta.txt'))).toBe(true)

    const rows = page.locator('.spine-row.is-subagent')
    await expect(rows).toHaveCount(2)
    await expect(rows.locator('.spine-tag')).toHaveCount(2)
    await expect(page.locator('.permission-card')).toHaveCount(0)

    await rows.first().locator('.spine-item').click()
    await expect(rows.first().locator('.spine-subagent')).toContainText('小助手')
    await expect(rows.first().locator('.spine-subagent .mono')).toContainText('步')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await rows.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('subagent-parallel-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('subagent-parallel-dark.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
