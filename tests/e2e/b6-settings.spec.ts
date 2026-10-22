/**
 * B6 设置与状态：自动命名开关、模型 Key 状态、提供方链接、打开目录错误。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

test.describe('B6 设置与状态', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('自动命名开关真正生效：关闭时保持新对话，开启后按首条消息命名', async () => {
    test.setTimeout(120_000)
    const workspace = join(root, 'tmp', `b6-autoname-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [{ text: '好的。' }, { text: '整理好了。' }]
    })
    morrow = await launchMorrow({ name: 'b6-autoname', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await installEventCollector(page)

      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ autoTitle: false })
      })
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '新对话' })
      await sendMessageViaStore(page, '关闭自动命名时的第一条消息')
      await waitForRunFinished(page, 60_000)
      await waitUntil(async () => (await readStore(page)).session?.title === '新对话', 10_000, '关闭时保持新对话')

      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ autoTitle: true })
      })
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '新对话' })
      await sendMessageViaStore(page, '帮我整理季度销售数据')
      await waitForRunFinished(page, 60_000)
      const title = await waitUntil(
        async () => {
          const value = (await readStore(page)).session?.title ?? ''
          return value !== '新对话' ? value : null
        },
        10_000,
        '开启后自动命名'
      )
      expect(title).toContain('帮我整理季度销售数据')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('模型状态显示 Key 已保存；关于页链接跟随提供方；打开目录失败会报错', async () => {
    test.setTimeout(90_000)
    morrow = await launchMorrow({ name: 'b6-provider', timeoutMs: 90_000 })
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const saved = await window.morrow.settings.saveProvider({
        config: {
          id: 'b6-provider',
          kind: 'openai-compat',
          name: 'B6 测试服务',
          baseUrl: 'https://api.example.com/v1',
          models: [{ id: 'b6-model', label: 'B6 Model', contextWindow: 128_000, supportsTools: true }],
          apiKeyStored: false,
          enabled: true,
          isBuiltin: false,
          category: 'custom'
        },
        apiKey: 'sk-b6-test-key'
      })
      if (!saved.ok) throw new Error(saved.error.message)
      await store.getState().updateSettings({
        defaultModel: { providerId: 'b6-provider', modelId: 'b6-model' }
      })
    })

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '模型' }).click()
    await expect(settings.locator('.st-provider-state').filter({ hasText: 'Key 已保存' })).toBeVisible()

    await settings.getByRole('tab', { name: '关于' }).click()
    // R12：无交互的「隐私」区块已删除，关于页直接进入快捷键
    await expect(settings.locator('.st-about-privacy')).toHaveCount(0)
    await expect(settings.getByText('键盘快捷键')).toBeVisible()
    await expect(settings.getByRole('button', { name: '更改目录' })).toBeVisible()
    await expect(settings.getByRole('button', { name: '更改目录' })).toBeDisabled()
    await expect(settings).toContainText('当前数据目录由启动参数指定')
    await settings.screenshot({ path: screenshotPath('settings-about-data-dir.png') })

    await app.evaluate(async ({ shell }) => {
      ;(shell as unknown as { openPath: (path: string) => Promise<string> }).openPath = async () => '拒绝访问（测试）'
    })
    const dataDir = await page.evaluate(() => window.morrow.app.openDataDir())
    expect(dataDir.ok).toBe(false)
    if (!dataDir.ok) expect(dataDir.error.message).toContain('拒绝访问（测试）')
    const logs = await page.evaluate(() => window.morrow.app.openLogs())
    expect(logs.ok).toBe(false)
    if (!logs.ok) expect(logs.error.message).toContain('拒绝访问（测试）')
  })
})
