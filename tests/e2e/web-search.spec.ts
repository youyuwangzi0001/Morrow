/**
 * P0-4 联网搜索 E2E：
 * - 配置 SearXNG → 模型调用 web_search → 工具卡来源 + 会话来源面板；
 * - 设置页「联网搜索」分类可用；
 * - 明暗截图。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
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

async function startSearxng(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/search')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          results: [
            {
              title: 'Morrow 官方资料',
              url: 'https://example.com/morrow',
              content: 'Morrow 是一个住在电脑里的 AI 工作伙伴。',
              engine: 'mock'
            },
            {
              title: '搜索来源第二条',
              url: 'https://example.com/second',
              content: '第二条摘要。',
              engine: 'mock'
            }
          ]
        })
      )
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, server }
}

test('联网搜索：配置、工具调用、来源面板与设置页', async () => {
  test.setTimeout(180_000)
  const searxng = await startSearxng()
  const mock = await startMockLLM({
    scripts: [
      { text: '我来搜索一下。', toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 是什么', max_results: 2 } }] },
      { text: '根据 [1]，Morrow 是一个 AI 工作伙伴；另见 [2]。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'web-search', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const configured = await page.evaluate(async (baseUrl) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().saveWebSearch({
        enabled: true,
        provider: 'searxng',
        baseUrl,
        maxResults: 3
      })
    }, searxng.baseUrl)
    expect(configured).toBe(true)

    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-web-search'),
      ...provider,
      permissionMode: 'auto',
      title: '联网搜索测试'
    })
    await page.locator('.composer-input').fill('搜索一下 Morrow 是什么')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/Morrow 是一个 AI 工作伙伴/)).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '搜索运行结束')

    // 工具卡展开后显示来源
    await page.locator('.spine-item').first().click()
    await expect(page.locator('.spine-sources')).toContainText('Morrow 官方资料')

    // 会话来源面板
    await expect(page.locator('.sources-tray')).toBeVisible()
    await page.locator('.sources-head').click()
    await expect(page.locator('.sources-item')).toHaveCount(2)
    await expect(page.locator('.sources-tray')).toContainText('搜索来源第二条')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('web-search-sources-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('web-search-sources-light.png') })
    await setThemeViaStore(page, 'dark')

    // 设置页
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '联网搜索' }).click()
    await expect(page.locator('.st-search')).toBeVisible()
    await expect(page.locator('.st-search')).toContainText('SearXNG')
    await page.getByRole('button', { name: /保存并测试/ }).click()
    await expect(page.locator('.st-search-test')).toContainText(/连接正常|返回 2 条/, { timeout: 30_000 })
    await page.locator('.st-panel').evaluate((element) => element.scrollTo({ top: 0 }))
    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('web-search-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('web-search-settings-light.png') })
    await setThemeViaStore(page, 'dark')

    const settings = (await readStore(page)).ready
    expect(settings).toBe(true)
  } finally {
    await morrow.close()
    await mock.close()
    await new Promise<void>((resolve) => searxng.server.close(() => resolve()))
  }
})
