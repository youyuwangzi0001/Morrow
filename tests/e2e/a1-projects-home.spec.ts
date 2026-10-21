/**
 * A1 项目主页与项目内会话（合并进原工作台 ProjectsPanel）：
 * 概览页展示真实项目背景、项目内对话列表；从项目里输入首句会创建带该工作区的会话并注入项目上下文。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  dismissOnboarding,
  installEventCollector,
  readStore,
  waitForRunFinished,
  waitForStoreReady
} from './store'

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function sameWorkspace(a: string | null, b: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!a && norm(a) === norm(b)
}

test.describe('A1 项目主页', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('概览展示项目背景；首句在项目工作区创建会话并注入说明与资料', async () => {
    test.setTimeout(180_000)
    const workspace = makeDir('a1-project-ws')
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nA1_CANARY_KNOWLEDGE：这是项目内的资料。', 'utf8')
    mock = await startMockLLM({ scripts: [{ text: '好的，我已经按项目背景开始。' }] })

    morrow = await launchMorrow({ name: 'a1-project-home', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoTitle: false, lastWorkspace: null })
    })
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({
        defaultModel: { providerId: model.providerId, modelId: model.modelId }
      })
    }, provider)

    const created = await page.evaluate(
      async (arg: { workspace: string }) => {
        const result = await window.morrow.features.invoke<{ id: string }>('feature:projects:create', {
          workspace: arg.workspace,
          name: 'A1 项目主页测试',
          description: '验证项目概览与项目内对话。',
          instructions: 'A1 项目指令：回答前先参考项目资料。',
          knowledgePaths: ['brief.md'],
          active: true
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      { workspace }
    )
    expect(created.id).toBeTruthy()
    const toastClose = page.locator('.toast-close').first()
    if (await toastClose.isVisible().catch(() => false)) await toastClose.click()

    // 打开同一个工作台项目面板（概览是默认视图）
    await page.getByRole('button', { name: '打开项目主页' }).click()
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.pp-home-title')).toHaveText('A1 项目主页测试')
    await expect(page.locator('.pp-home-desc')).toContainText('验证项目概览')
    await expect(page.locator('.pp-home-meta')).toContainText('1 份资料')
    await expect(page.locator('.pp-home-cards')).toContainText('A1 项目指令：回答前先参考项目资料。')
    await expect(page.locator('.pp-home-cards')).toContainText('brief.md')
    await expect(page.locator('.pp-home-recent')).toContainText('这里还没有对话')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 从项目里发第一句 → 真实创建项目工作区会话
    await installEventCollector(page)
    const prompt = '把项目资料读一遍，然后告诉我项目要做什么。'
    const composer = page.locator('.pp-home-composer textarea')
    await composer.fill(prompt)
    await composer.press('Enter')
    await expect(page.locator('.pp-root')).toHaveCount(0, { timeout: 15_000 })
    await waitForRunFinished(page, 90_000)

    const store = await readStore(page)
    expect(store.session?.workspace && sameWorkspace(store.session.workspace, workspace)).toBe(true)
    expect(store.session?.messages.some((message) => message.role === 'user' && message.text.includes('项目资料读一遍'))).toBe(true)

    // 真实请求体里带上了项目说明与资料（system prompt）；跳过可能的连接探测请求
    const firstBody = (mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('项目资料读一遍')
    )?.body ?? {}) as { messages?: Array<{ role: string; content: unknown }> }
    const sys = JSON.stringify(firstBody.messages?.[0]?.content ?? '')
    expect(sys).toContain('A1 项目指令')
    expect(sys).toContain('A1_CANARY_KNOWLEDGE')

    // 再开概览：项目内对话已计入并可直接打开
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-home-recent')).toContainText('项目资料读一遍', { timeout: 15_000 })
    await expect(page.locator('.pp-home-meta')).toContainText('1 段对话')
    await expect(page.locator('.pp-project')).toContainText('1 对话')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home-with-chat.png')
    })

    // 项目内对话可直接打开主窗口里的同一条会话
    await page.locator('.pp-home-sessions button').first().click()
    await expect(page.locator('.pp-root')).toHaveCount(0)
    await expect(page.getByText('好的，我已经按项目背景开始。')).toBeVisible({ timeout: 30_000 })
  })

  test('资料失效时仍能保存项目修改、移除失效资料，并在预览中说明原因', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a1-project-stale-ws')
    writeFileSync(join(workspace, 'brief.md'), '# 资料\nA1_STALE_CANARY：有效资料。', 'utf8')
    writeFileSync(join(workspace, 'gone.md'), 'GONE_CANARY：稍后删除。', 'utf8')

    morrow = await launchMorrow({ name: 'a1-project-stale', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: null })
    })

    const created = await page.evaluate(
      async (arg: { workspace: string }) => {
        const result = await window.morrow.features.invoke<{ id: string }>('feature:projects:create', {
          workspace: arg.workspace,
          name: '失效资料项目',
          instructions: 'A1 初始说明。',
          knowledgePaths: ['brief.md', 'gone.md'],
          active: true
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      { workspace }
    )
    expect(created.id).toBeTruthy()
    // 项目创建后删除其中一份资料：这正是此前“一丢文件就再也保存不了”的场景
    unlinkSync(join(workspace, 'gone.md'))

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('tab', { name: '说明与资料' }).click()
    await expect(page.locator('.pp-knowledge-item.is-invalid')).toContainText('gone.md')
    await expect(page.locator('.pp-knowledge-item.is-invalid')).toContainText(/不存在/)
    // 记忆中心独立注入，界面文案不再承诺“停用项目连记忆一起停”
    await expect(page.locator('.pp-switches')).toContainText('记忆中心按自己的设置单独注入')

    await page.getByLabel('长期说明（Morrow 做任务时会参考）').fill('A1 失效资料仍可保存：说明已更新。')
    await page.getByRole('button', { name: '保存项目' }).click()
    await expect(page.locator('.pp-notice')).toContainText('项目已保存')

    await page.getByRole('button', { name: 'Morrow 会看到什么' }).click()
    const preview = page.locator('.pp-preview')
    await expect(preview).toBeVisible({ timeout: 10_000 })
    await expect(preview).toContainText('A1 失效资料仍可保存')
    await expect(preview).toContainText('A1_STALE_CANARY')
    await expect(preview.locator('.pp-preview-warn')).toContainText('已跳过失效的参考资料')
    await expect(preview.locator('.pp-preview-warn')).toContainText('gone.md')
    await expect(preview.locator('.pp-preview-head')).not.toContainText('已截断')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-root') }).screenshot({
      path: screenshotPath('a1-project-stale-dark.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-root') }).screenshot({
      path: screenshotPath('a1-project-stale-light.png')
    })

    // 移除失效资料后保存：磁盘上只剩有效资料
    await page.getByRole('button', { name: '移除参考资料 gone.md' }).click()
    await page.getByRole('button', { name: '保存项目' }).click()
    await expect(page.locator('.pp-notice')).toContainText('项目已保存')
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke<{ projects: Array<{ knowledgePaths: string[] }> }>(
        'feature:projects:list'
      )
      if (!result.ok) throw new Error(result.error.message)
      return result.data.projects.find((project) => project.knowledgePaths.length > 0) ?? null
    })
    expect(saved?.knowledgePaths).toEqual(['brief.md'])
  })

  test('当前文件夹范围突出新建入口，底部重复 CTA 已移除', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a1-project-scope-ws')

    morrow = await launchMorrow({ name: 'a1-project-scope', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (nextWorkspace: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: nextWorkspace })
    }, workspace)
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })

    const scope = page.getByRole('radiogroup', { name: '项目范围' })
    await expect(scope).toBeVisible()
    await expect(scope.getByRole('radio', { name: '全部项目' })).toHaveAttribute('aria-checked', 'true')
    await scope.getByRole('radio', { name: '当前文件夹' }).click()
    await expect(scope.getByRole('radio', { name: '当前文件夹' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.pp-empty')).toContainText('当前文件夹')
    await expect(page.locator('.pp-empty')).toContainText('还没有项目')
    await expect(page.locator('.pp-cta')).toHaveCount(0)

    await page.getByRole('button', { name: '新建项目' }).click()
    await page.getByLabel('项目名称').fill('当前文件夹项目')
    await page.getByRole('button', { name: '创建项目' }).click()
    await expect(page.locator('.pp-home-title')).toHaveText('当前文件夹项目', { timeout: 15_000 })
    await expect(page.locator('.pp-project')).toContainText('当前文件夹项目')
    await expect(page.locator('.pp-cta')).toHaveCount(0)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-root') }).screenshot({
      path: screenshotPath('a1-project-scope-current.png')
    })
  })
})
