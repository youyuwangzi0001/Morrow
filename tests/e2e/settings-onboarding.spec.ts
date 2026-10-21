/**
 * 设置与首次引导回归：
 * - 引导是真正的模态层：焦点陷阱、全局快捷键不穿透；
 * - 切换服务商清空上一家输入的 Key；
 * - 最近工作区失效时明确报错，不假装已选中；
 * - 设置页检测到未保存的 Base URL 时，先提示保存再同步。
 */
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, readStore, setThemeViaStore, waitForStoreReady } from './store'

let localSyncServer: Server | null = null
test.afterEach(async () => {
  if (!localSyncServer) return
  const server = localSyncServer
  localSyncServer = null
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('首次引导：焦点陷阱、快捷键隔离、切换服务商清 Key、失效工作区提示', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'onboarding-audit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await expect(page.locator('.onb')).toBeVisible()
    await page.waitForTimeout(300)

    const focusInside = async (): Promise<boolean> =>
      page.evaluate(() => Boolean(document.activeElement?.closest('.onb')))
    expect(await focusInside()).toBe(true)
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press('Tab')
      expect(await focusInside()).toBe(true)
    }

    // 引导打开时 Ctrl+K 不应穿透打开命令面板
    await page.keyboard.press('Control+K')
    await page.waitForTimeout(250)
    await expect(page.locator('.palette')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => { paletteOpen: boolean } } }).__morrowStore.getState().paletteOpen)).toBe(false)

    await page.getByRole('button', { name: '开始设置' }).click()
    await page.locator('#onb-api-key').fill('sk-should-not-leak')
    await expect(page.locator('#onb-api-key')).toHaveValue('sk-should-not-leak')
    await page.getByRole('radio', { name: /Anthropic/ }).click()
    await expect(page.locator('#onb-api-key')).toHaveValue('')

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('onboarding-provider-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('onboarding-provider-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(250)

    // 失效的最近工作区：不能假装选中
    const missing = join(root, 'tmp', `missing-workspace-${Date.now()}`)
    await page.evaluate(async (path) => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ recentWorkspaces: [path] })
    }, missing)
    await page.getByRole('button', { name: '下一步' }).click()
    const recent = page.locator('.onb-recent-item').first()
    await expect(recent).toBeVisible()
    await recent.click()
    await expect(page.locator('.onb-error')).toContainText('已经不可用')
    await expect(page.locator('.onb-workspace.is-chosen')).toHaveCount(0)
  } finally {
    await morrow.close()
  }
})

test('设置页：未保存 Base URL 时先提示保存；切换服务商清空 Key', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'settings-audit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.keyboard.press('Control+,')
    await expect(page.locator('#st-base-url')).toBeVisible({ timeout: 10_000 })

    // 记住上次分类：关闭再打开时焦点与可见分类一致
    await page.locator('#st-tab-appearance').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#st-tab-appearance')).toHaveCount(0)
    await page.keyboard.press('Control+,')
    await expect(page.locator('#st-tab-appearance')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#st-tab-appearance')).toBeFocused()
    await page.locator('#st-tab-models').click()
    await expect(page.locator('#st-base-url')).toBeVisible()

    await page.locator('#st-base-url').fill('https://example.invalid/v1')
    await page.getByRole('button', { name: '刷新可用模型' }).click()
    await expect(page.getByText('还没保存的 Base URL')).toBeVisible()

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('settings-unsaved-baseurl-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('settings-unsaved-baseurl-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(250)

    await page.locator('#st-api-key').fill('sk-settings-provider-switch')
    const pickProvider = async (label: string): Promise<void> => {
      await page.getByRole('button', { name: '选择模型服务' }).click()
      await page.getByRole('option').filter({ hasText: label }).click()
    }
    await pickProvider('Kimi（月之暗面）')
    await expect(page.locator('#st-api-key')).toHaveValue('')

    // 本地服务不需要 Key 也能同步模型
    localSyncServer = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'local-e2e-model', context_length: 8192, max_output_tokens: 2048 }] }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve) => localSyncServer!.listen(0, '127.0.0.1', resolve))
    const address = localSyncServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await pickProvider('Ollama（本地）')
    // 完整推理地址也应能正确归一到 /v1/models
    await page.locator('#st-base-url').fill(`http://127.0.0.1:${port}/v1/chat/completions`)
    await page.getByRole('button', { name: '保存连接' }).click()
    await expect(page.getByText('已保存并生效')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '刷新可用模型' }).click()
    await expect(page.getByText(/同步完成：1 个模型/)).toBeVisible({ timeout: 20_000 })
    const ollamaModels = await page.evaluate(() => {
      const settings = (window as unknown as { __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string }> }> } } } }).__morrowStore.getState().settings
      return settings.providers.find((provider) => provider.id === 'ollama')?.models.map((model) => model.id) ?? []
    })
    expect(ollamaModels).toContain('local-e2e-model')
    const dismissToasts = async (): Promise<void> => {
      // 直接触发 DOM click，避免 toast 消失后 Playwright 继续等待已卸载的按钮
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })
      await page.waitForTimeout(220)
    }
    await dismissToasts()
    await page.evaluate(() => {
      const note = Array.from(document.querySelectorAll('p')).find((element) => element.textContent?.includes('同步完成'))
      note?.scrollIntoView({ block: 'center' })
    })
    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('settings-local-sync-dark.png') })

    // 关于页品牌标识使用重绘 icon，而不是字母 M
    await page.locator('#st-tab-about').click()
    await expect(page.locator('img.st-about-mark')).toHaveAttribute('src', /brand-mark/)
    await dismissToasts()
    await page.locator('img.st-about-mark').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-about-dark.png') })

    // 关闭设置后回到主界面
    await page.keyboard.press('Escape')
    await expect(page.locator('#st-base-url')).toHaveCount(0)
    expect((await readStore(page)).settingsOpen).toBe(false)
  } finally {
    await morrow.close()
  }
})
