/**
 * A4 深度研究模式：
 * - 切到研究模式后，真实执行多轮 web_search，来源不足自动续研；
 * - 最终产出带引用的 Markdown 报告（画布成品），进度条如实显示轮次/来源；
 * - 自动续研的内部提示不展示为用户气泡；
 * - 未配置联网搜索时明确拒绝，不伪造研究。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  waitForStoreReady,
  waitUntil
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function dismissToasts(page: import('@playwright/test').Page): Promise<void> {
  const close = page.locator('.toast-close')
  for (let index = 0; index < 6; index += 1) {
    if ((await close.count()) === 0) return
    await close.first().click().catch(() => undefined)
    await page.waitForTimeout(80)
  }
}

async function startResearchSearch(): Promise<{ baseUrl: string; server: Server; queries: string[] }> {
  const queries: string[] = []
  const resultsFor: Record<string, Array<{ title: string; url: string; content: string; engine: string }>> = {
    first: [
      { title: '来源 A', url: 'https://example.com/a', content: '第一篇资料。', engine: 'mock' },
      { title: '来源 B', url: 'https://example.com/b', content: '第二篇资料。', engine: 'mock' }
    ],
    second: [
      { title: '来源 A', url: 'https://example.com/a', content: '第一篇资料。', engine: 'mock' },
      { title: '来源 C', url: 'https://example.com/c', content: '第三篇资料。', engine: 'mock' },
      { title: '来源 D', url: 'https://example.com/d', content: '第四篇资料。', engine: 'mock' }
    ]
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/search')) {
      const query = url.searchParams.get('q') ?? ''
      queries.push(query)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: query.includes('补充') ? resultsFor.second : resultsFor.first }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, server, queries }
}

const REPORT = [
  '# 深度研究报告：Morrow 研究能力',
  '',
  '## 关键结论',
  '- Morrow 是一个本地 AI 工作伙伴 [1]。',
  '- 它会保留来源并在报告中给出可核对链接 [2][3]。',
  '',
  '## 局限',
  '- 本次测试使用模拟检索服务。',
  '',
  '## 参考来源',
  '[1] https://example.com/a',
  '[2] https://example.com/b',
  '[3] https://example.com/c'
].join('\n')

const PLAN = [
  '# 研究计划：Morrow 深度研究能力',
  '',
  '## 研究目标',
  '确认 Morrow 深度研究的多轮检索、来源核对与报告交付能力。',
  '',
  '## 范围与假设',
  '- 以公开资料为主；优先 2026 年信息。',
  '',
  '## 子问题',
  '1. 它如何拆解研究问题？',
  '2. 它如何记录独立来源并自动补查？',
  '3. 它如何交付带引用的报告？',
  '',
  '## 检索策略',
  '- 两组不同关键词；至少 4 个独立来源。',
  '',
  '## 报告结构',
  '- 摘要、关键结论、证据与分歧、局限、参考来源。',
  '',
  '## 需要确认',
  '- 无。'
].join('\n')

test.describe('A4 深度研究模式', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null
  let search: Awaited<ReturnType<typeof startResearchSearch>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    await new Promise<void>((resolve) => (search ? search.server.close(() => resolve()) : resolve()))
    mock = null
    search = null
  })

  test('多轮检索自动补查 → 带引用报告与真实来源面板；内部补查不显示为气泡', async () => {
    test.setTimeout(180_000)
    search = await startResearchSearch()
    mock = await startMockLLM({
      scripts: [
        { text: PLAN },
        { text: '先检索第一批资料。', delayMs: 2_500, toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 研究能力 第一轮', max_results: 5 } }] },
        { text: '初步结论：还需要更多来源与正式报告。' },
        { text: '补充检索不同角度。', toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 研究能力 补充检索', max_results: 5 } }] },
        {
          text: '资料已经足够，整理研究报告。',
          toolCalls: [{ name: 'open_artifact', arguments: { title: '研究报告：Morrow 研究能力', kind: 'markdown', content: REPORT } }]
        },
        { text: '研究报告已经放到画布。' }
      ]
    })
    morrow = await launchMorrow({ name: 'a4-research', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const configuredSearch = await page.evaluate(async (baseUrl) => {
      const result = await window.morrow.settings.saveWebSearch({
        enabled: true,
        provider: 'searxng',
        baseUrl,
        maxResults: 5
      })
      return result.ok
    }, search.baseUrl)
    expect(configuredSearch).toBe(true)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('a4-research-ws'),
      ...provider,
      permissionMode: 'auto',
      title: '深度研究测试'
    })

    // 切到研究模式，选快速深度
    await page.locator('.composer-picker-mode').getByRole('radio', { name: '研究' }).click()
    await expect(page.locator('.composer-perm-lock.is-research')).toContainText('联网查证')
    await page.getByLabel('研究深度').click()
    await page.getByRole('option', { name: /研究·快速/ }).click()
    await expect(page.locator('.composer-picker-research')).toContainText('研究·快速')

    await page.locator('.composer-input').fill('研究一下 Morrow 的深度研究能力，并给出可核对的报告。')
    await page.locator('.composer-input').press('Enter')

    // ChatGPT Deep Research 式流程：先拿到可编辑计划，确认后才开始检索
    const ready = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return session?.research ?? null
      })
      return result?.status === 'ready' ? result : null
    }, 60_000, '研究计划生成')
    expect(ready.plan).toContain('研究计划')
    const planBar = page.locator('.research-bar')
    await expect(planBar).toContainText('计划待确认')
    await expect(page.getByLabel('研究计划')).toHaveValue(/研究计划/)
    await dismissToasts(page)
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-plan-dark.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-plan-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.getByLabel('研究计划').fill(`${PLAN}\n\n补充：优先 2026 年资料。`)
    await page.getByRole('button', { name: '开始研究' }).click()

    // 运行中可追加要求（ChatGPT Deep Research 式调整方向），下一轮优先纳入
    const running = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return session?.research?.status === 'searching' ? { sessionId: session.id as string } : null
      })
      return result
    }, 20_000, '研究开始')
    await expect(page.getByLabel('补充研究要求')).toBeVisible()
    await dismissToasts(page)
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-steering-dark.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-steering-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    const steered = await page.evaluate(
      async (arg: { sessionId: string; text: string }) => {
        const result = await window.morrow.chat.steerResearch({ sessionId: arg.sessionId, text: arg.text })
        return result.ok ? { ok: true as const } : { ok: false as const, error: result.error.message }
      },
      { sessionId: running.sessionId, text: '补充关注 2026 年资料与官方来源' }
    )
    expect(steered.ok).toBe(true)
    await expect(page.locator('.research-steer-pending')).toContainText('下一轮优先处理')

    // 等待两轮自动续研完成
    const final = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return { research: session?.research ?? null, messages: session?.messages ?? [] }
      })
      return result.research?.status === 'completed' ? result : null
    }, 90_000, '研究完成')
    expect(final.research).toMatchObject({
      status: 'completed',
      depth: 'quick',
      round: 2,
      minSources: 4
    })
    expect(final.research.sourceCount).toBeGreaterThanOrEqual(4)
    expect(final.research.plan).toContain('优先 2026 年资料')
    expect(final.messages.some((message: { hidden?: boolean; displayText?: string }) => message.hidden)).toBe(true)

    // 研究条：真实轮次/来源/报告入口；内部补查提示不出现在对话里
    const bar = page.locator('.research-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('已完成')
    await expect(bar).toContainText('来源 4/4')
    await expect(bar).toContainText('第 2/2 轮')
    await expect(page.getByText('继续这项深度研究')).toHaveCount(0)
    const reportButton = bar.getByRole('button', { name: '打开研究报告' })
    if (!(await reportButton.isVisible().catch(() => false))) {
      await bar.locator('.research-bar-toggle').click()
    }
    await expect(bar.getByRole('button', { name: '打开研究报告' })).toBeVisible()

    // 来源面板来自真实 web_search 结果（两轮共 4 个独立 URL）
    await expect(page.locator('.sources-tray')).toBeVisible()
    await page.locator('.sources-head').click()
    await expect(page.locator('.sources-item')).toHaveCount(4)
    await page.locator('.sources-head').click()

    await page.screenshot({ path: screenshotPath('a4-deep-research.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-deep-research-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 报告打开到画布
    await bar.getByRole('button', { name: '打开研究报告' }).click()
    await expect(page.locator('.canvas-head-title')).toContainText('研究报告', { timeout: 15_000 })

    // 研究模式的系统提示与工具白名单：有 web_search，无写文件/命令（跳过可能的连接探测请求）
    const researchRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('深度研究模式')
    )
    const system = JSON.stringify(
      (researchRequest?.body as { messages?: Array<{ content: unknown }> } | undefined)?.messages?.[0]?.content ?? ''
    )
    expect(system).toContain('优先 2026 年资料')
    const planRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('制定计划阶段')
    )
    const planTools = ((planRequest?.body as { tools?: unknown[] } | undefined)?.tools ?? []) as unknown[]
    expect(planTools).toHaveLength(0)
    expect(mock.requests.some((request) => JSON.stringify(request.body ?? {}).includes('补充关注 2026 年资料与官方来源'))).toBe(true)
    const toolNames = (
      (((researchRequest?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ??
        []) as Array<{ function?: { name?: string } }>)
    ).map((tool) => tool.function?.name ?? '')
    expect(system).toContain('深度研究模式')
    expect(system).toContain('研究模式固定只读资料与联网查证')
    expect(toolNames).toContain('web_search')
    expect(toolNames).not.toContain('run_command')
    expect(toolNames).not.toContain('write_file')
    expect(search.queries.length).toBeGreaterThanOrEqual(2)
  })

  test('未配置联网搜索时拒绝开始深度研究', async () => {
    test.setTimeout(90_000)
    mock = await startMockLLM({ scripts: [{ text: '不应该运行到这里。' }] })
    morrow = await launchMorrow({ name: 'a4-research-no-search', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('a4-research-no-search-ws'),
      ...provider,
      permissionMode: 'auto',
      title: '研究缺少联网'
    })
    await page.locator('.composer-picker-mode').getByRole('radio', { name: '研究' }).click()
    await page.locator('.composer-input').fill('研究一个需要联网的问题。')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.toast-item.toast-error')).toContainText('配置联网搜索', { timeout: 15_000 })
    const state = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.research ?? null
    })
    expect(state?.status ?? null).not.toBe('searching')
  })
})
