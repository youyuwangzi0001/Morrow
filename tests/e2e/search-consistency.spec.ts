/**
 * 全局搜索一致性回归：
 * 1) 删除会话后索引立即失效；
 * 2) 搜索文件时使用当前会话工作区（不是 lastWorkspace），结果可在编辑器中打开。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, openToolPanel, waitForStoreReady, waitUntil } from './store'

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(root, 'tmp', `${prefix}-`))
  return dir
}

test.describe('全局搜索一致性', () => {
  test('删除会话后搜索索引立即移除该会话', async () => {
    test.setTimeout(60_000)
    const workspace = makeDir('search-delete-ws')
    const dataDir = makeDir('search-delete-data')
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    const sessionId = 's_searchdel1'
    const token = '海上升明月唯一标记'
    writeFileSync(
      join(dataDir, 'sessions', `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        title: '搜索删除残留测试',
        workspace,
        model: { providerId: 'demo', modelId: 'morrow-demo' },
        permissionMode: 'ask',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 1,
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: token }], createdAt: Date.now() }],
        todos: [],
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    )
    const morrow = await launchMorrow({ name: 'search-delete', dataDir, waitForSelector: '.sidebar' })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 搜索 IPC 只接受已登记工作区；模拟用户选择过这个文件夹（删除会话后仍保持登记）
      await page.evaluate(async (path) => {
        const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: Record<string, unknown>) => Promise<void> } } }).__morrowStore
        await store.getState().updateSettings({ lastWorkspace: path })
      }, workspace)
      const query = async () =>
        page.evaluate(
          async (arg: { token: string; workspace: string }) => {
            const result = await window.morrow.features.invoke<{
              groups: { sessions: Array<{ sessionId?: string }> }
            }>('feature:search:query', { q: arg.token, workspace: arg.workspace, limit: 20 })
            if (!result.ok) throw new Error(result.error.message)
            return result.data
          },
          { token, workspace }
        )

      const before = await query()
      expect(before.groups.sessions.some((hit) => hit.sessionId === sessionId)).toBe(true)

      const removed = await page.evaluate(async (id: string) => window.morrow.session.remove(id), sessionId)
      expect(removed.ok).toBe(true)
      expect(existsSync(join(dataDir, 'sessions', `${sessionId}.json`))).toBe(false)

      const after = await query()
      expect(after.groups.sessions.some((hit) => hit.sessionId === sessionId)).toBe(false)
    } finally {
      await morrow.close()
    }
  })

  test('搜索文件使用当前会话工作区，并可从结果打开编辑器', async () => {
    test.setTimeout(60_000)
    const workspaceA = makeDir('search-nav-a')
    const workspaceB = makeDir('search-nav-b')
    const dataDir = makeDir('search-nav-data')
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    const fileName = '预算导航.md'
    writeFileSync(join(workspaceA, fileName), '# 预算导航\n\n当前会话工作区里的文件。', 'utf8')
    // 预置一个同工作区、但非当前会话的 artifact 归属会话，验证跨会话结果跳转
    writeFileSync(
      join(dataDir, 'sessions', 's_artowner1.json'),
      JSON.stringify({
        id: 's_artowner1',
        title: '产物归属会话',
        workspace: workspaceA,
        model: { providerId: 'demo', modelId: 'morrow-demo' },
        permissionMode: 'read-only',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        messages: [],
        todos: [],
        artifacts: [
          {
            id: 'art_search_owner',
            title: '独有产物标题',
            kind: 'markdown',
            content: '# 独有产物\n\nARTIFACT-UNIQUE',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    )
    const morrow = await launchMorrow({ name: 'search-nav', dataDir, waitForSelector: '.sidebar' })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const sessionId = await page.evaluate(
        async (arg: { workspaceA: string; workspaceB: string }) => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().updateSettings({ lastWorkspace: arg.workspaceB })
          const state = store.getState()
          const created = await window.morrow.session.create({
            workspace: arg.workspaceA,
            model: state.settings.defaultModel,
            permissionMode: 'read-only',
            title: '搜索导航会话'
          })
          if (!created.ok) throw new Error(created.error.message)
          await store.getState().selectSession(created.data.id)
          const list = await window.morrow.session.list()
          if (list.ok) store.setState({ sessions: list.data })
          return created.data.id
        },
        { workspaceA, workspaceB }
      )
      await waitUntil(async () => (await page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId)) === sessionId, 10_000, '会话选中')

      await openToolPanel(page, '全局搜索')
      const input = page.getByRole('textbox', { name: '全局搜索' })
      await expect(input).toBeVisible({ timeout: 10_000 })
      await input.fill('预算导航')
      const hit = page.locator('.search-hit').filter({ hasText: fileName }).first()
      await expect(hit).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('search-workspace-results-dark.png') })
      await hit.click()
      await expect(page.locator('.canvas-head-title')).toContainText(fileName, { timeout: 15_000 })
      await expect(page.locator('.editor-pane')).toBeVisible()

      // artifact 命中来自同工作区的另一个会话：应切回归属会话并打开画布
      await openToolPanel(page, '全局搜索')
      const artifactInput = page.getByRole('textbox', { name: '全局搜索' })
      await expect(artifactInput).toBeVisible({ timeout: 10_000 })
      await artifactInput.fill('独有产物')
      const artifactHit = page.locator('.search-hit').filter({ hasText: '独有产物标题' }).first()
      await expect(artifactHit).toBeVisible({ timeout: 15_000 })
      await artifactHit.click()
      await expect
        .poll(async () => page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId), { timeout: 15_000 })
        .toBe('s_artowner1')
      await expect(page.locator('.canvas-head-title')).toContainText('独有产物标题', { timeout: 15_000 })
    } finally {
      await morrow.close()
    }
  })
})
