/**
 * 全局搜索：默认跨全部工作区；可切换当前文件夹；会话命中后跳到原句并高亮。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, openToolPanel, waitForStoreReady, waitUntil } from './store'

const TOKEN = '沧海月明唯一检索词'

function makeDir(prefix: string): string {
  return mkdtempSync(join(root, 'tmp', `${prefix}-`))
}

function sessionJson(input: {
  id: string
  title: string
  workspace: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
}): string {
  return JSON.stringify({
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: { providerId: 'demo', modelId: 'morrow-demo' },
    permissionMode: 'read-only',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: input.messages.length,
    messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      createdAt: Date.now()
    })),
    todos: [],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0 }
  })
}

test('默认搜索全部项目；可切换当前文件夹；会话命中跳到原句并高亮', async () => {
  test.setTimeout(120_000)
  const workspaceA = makeDir('search-global-a')
  const workspaceB = makeDir('search-global-b')
  const dataDir = makeDir('search-global-data')
  mkdirSync(join(dataDir, 'sessions'), { recursive: true })
  writeFileSync(join(workspaceA, 'A-唯一检索词.md'), `# A\n\n${TOKEN}\n`, 'utf8')
  writeFileSync(join(workspaceB, 'B-唯一检索词.md'), `# B\n\n${TOKEN}\n`, 'utf8')

  const targetMessages = Array.from({ length: 40 }, (_, index) => ({
    id: index === 25 ? 'm_target' : `m_${index}`,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: index === 25 ? `这里藏着 ${TOKEN}，请定位到这一句。` : `第 ${index + 1} 条占位消息，用于制造足够长的对话。`
  }))
  writeFileSync(
    join(dataDir, 'sessions', 's_target.json'),
    sessionJson({ id: 's_target', title: '定位测试会话', workspace: workspaceA, messages: targetMessages }),
    'utf8'
  )
  writeFileSync(
    join(dataDir, 'sessions', 's_other.json'),
    sessionJson({
      id: 's_other',
      title: '另一个项目的会话',
      workspace: workspaceB,
      messages: [{ id: 'm_other', role: 'user', text: '我在另一个文件夹里。' }]
    }),
    'utf8'
  )

  const morrow = await launchMorrow({ name: 'search-global', dataDir, waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .selectSession('s_other')
    })
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId
        )) === 's_other',
      10_000,
      '切到另一个项目的会话'
    )

    await openToolPanel(page, '全局搜索')
    const input = page.getByRole('textbox', { name: '全局搜索' })
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill(TOKEN)

    // 默认「全部」：两个项目的文件都能搜到
    await expect(page.locator('.search-hit').filter({ hasText: 'A-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.search-hit').filter({ hasText: 'B-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })

    // 未登记目录不能作为搜索范围（否则索引器会读取任意目录）
    const outside = makeDir('search-global-outside')
    writeFileSync(join(outside, 'secret.md'), `outside ${TOKEN}`, 'utf8')
    const blocked = await page.evaluate(async (arg: { path: string; token: string }) => {
      const invoke = (channel: string, payload: Record<string, unknown>) =>
        window.morrow.features.invoke(channel, payload) as Promise<{ ok: boolean; error?: { message?: string } }>
      return {
        query: await invoke('feature:search:query', { q: arg.token, workspace: arg.path }),
        refresh: await invoke('feature:search:refresh', { workspace: arg.path })
      }
    }, { path: outside, token: TOKEN })
    expect(blocked.query.ok).toBe(false)
    expect(blocked.query.error?.message).toContain('已登记')
    expect(blocked.refresh.ok).toBe(false)
    expect(blocked.refresh.error?.message).toContain('已登记')
    rmSync(outside, { recursive: true, force: true })

    await page.screenshot({ path: screenshotPath('search-global-all.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('search-global-all-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 切到当前文件夹（workspaceB）：只剩 B
    const dialog = page.getByRole('dialog', { name: '全局搜索' })
    await dialog.getByRole('button', { name: '当前文件夹' }).click()
    await expect(page.locator('.search-hit').filter({ hasText: 'B-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.search-hit').filter({ hasText: 'A-唯一检索词.md' })).toHaveCount(0)

    // 切回全部，点击会话命中：切到目标会话并跳到原句
    await dialog.getByRole('button', { name: '全部' }).click()
    const sessionHit = page.locator('.search-hit').filter({ hasText: '定位测试会话' }).first()
    await expect(sessionHit).toBeVisible({ timeout: 15_000 })
    await sessionHit.click()
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId
        )) === 's_target',
      15_000,
      '切换到命中会话'
    )
    const highlight = page.locator('[data-message-id="m_target"].is-search-hit')
    await waitUntil(async () => (await highlight.count()) > 0, 8_000, '命中消息金色高亮')
    await page.waitForTimeout(350)
    const box = await highlight.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    if (box && viewport) {
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeLessThan(viewport.height)
    }
    await page.screenshot({ path: screenshotPath('search-global-jump.png') })
  } finally {
    await morrow.close()
  }
})
