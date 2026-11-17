// 目标模式预算续跑：轮次/工具调用用尽时不再中断长任务。
//
// 用户在真实使用里遇到的故障：跑到约 200 次工具调用后目标被暂停，长任务卡住不会自动继续。
// 这里用 mock 模型真跑一遍，逐轮记账，断言目标在「轮次用尽」之后依然自动续跑并最终完成。
import { test, expect, type Page } from '@playwright/test'
import { launchMorrow, screenshotPath, configureMockProvider, waitForStoreReady, dismissOnboarding, type MorrowApp } from './helpers'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

async function getGoal(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __morrowStore: { getState: () => { session: { goal?: Record<string, any> | null } | null } }
        }
      ).__morrowStore.getState().session?.goal ?? null
  )
}

async function createSessionWithModel(
  page: Page,
  model: { providerId: string; modelId: string }
): Promise<void> {
  await page.evaluate(async (modelRef) => {
    const store = (
      window as unknown as { __morrowStore: { getState: () => Record<string, any> } }
    ).__morrowStore
    const workspace = await window.morrow.workspace.createDemo()
    if (!workspace.ok) throw new Error('createDemo 失败')
    const created = await window.morrow.session.create({
      workspace: workspace.data.path,
      model: modelRef,
      permissionMode: 'auto',
      title: 'Goal Budget E2E'
    })
    if (!created.ok) throw new Error('session.create 失败')
    await store.getState().selectSession(created.data.id)
  }, model)
}

test.describe('目标模式预算续跑', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('@core:goals 轮次预算用尽且仍在推进时自动续段，长任务不会卡住', async () => {
    test.setTimeout(180_000)
    // 3 个推进轮 + 1 个完成轮；maxRounds 设为 2，强制在第 3 轮触发轮次续段
    const mock = await startMockLLM({
      scripts: [
        {
          text: '第 1 轮：写第一个切片。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'slice-1.md', content: '# 切片 1\n' } },
            { name: 'update_goal', arguments: { status: 'active', summary: '完成切片 1', nextStep: '写切片 2' } }
          ]
        },
        { text: '第 1 轮结束。' },
        {
          text: '第 2 轮：写第二个切片。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'slice-2.md', content: '# 切片 2\n' } },
            { name: 'update_goal', arguments: { status: 'active', summary: '完成切片 2', nextStep: '写切片 3' } }
          ]
        },
        { text: '第 2 轮结束。' },
        {
          text: '第 3 轮：写第三个切片。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'slice-3.md', content: '# 切片 3\n' } },
            { name: 'update_goal', arguments: { status: 'active', summary: '完成切片 3', nextStep: '收尾并标记完成' } }
          ]
        },
        { text: '第 3 轮结束。' },
        {
          text: '第 4 轮：全部完成。',
          toolCalls: [
            {
              name: 'update_goal',
              arguments: {
                status: 'completed',
                summary: '三个切片全部完成并验证',
                evidence: ['slice-1.md', 'slice-2.md', 'slice-3.md']
              }
            }
          ]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'goal-budget', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      // 显式给 2 轮：验证「轮次用尽自动续段」而不是「直接暂停」
      await page.evaluate(() => {
        const store = (
          window as unknown as { __morrowStore: { getState: () => Record<string, any> } }
        ).__morrowStore
        return store.getState().startGoal('分四个切片完成一份多轮笔记，每轮只推进一个切片。', 2)
      })

      // 等目标进入终态（completed / blocked / paused）
      const deadline = Date.now() + 120_000
      let goal: Record<string, any> | null = null
      while (Date.now() < deadline) {
        goal = await getGoal(page)
        if (goal && ['completed', 'blocked', 'paused'].includes(goal.status)) break
        await page.waitForTimeout(300)
      }

      expect(goal, '目标没有进入终态').not.toBeNull()
      // 核心断言：轮次预算从 2 自动扩展到足够跑完，且最终是完成而不是预算暂停
      expect(goal?.round).toBeGreaterThan(2)
      expect(goal?.maxRounds).toBeGreaterThan(goal?.round ?? 0)
      expect(goal?.status).toBe('completed')
      expect(goal?.stopReason).toBeUndefined()
      // 工具调用累计是观测值，不设上限
      expect(goal?.toolCalls ?? 0).toBeGreaterThan(0)
      expect(goal?.maxToolCalls).toBeUndefined()

      await page.screenshot({ path: screenshotPath('goal-budget-auto-extended.png') })

      // 目标条在窄窗口下不能被挤压：直接读 DOM 文本 + 逐元素行数
      const goalBar = await page.evaluate(() => {
        const bar = document.querySelector('.goal-bar')
        if (!bar) return null
        const measure = (selector: string) => {
          const node = bar.querySelector(selector)
          if (!node) return null
          const rects = [...node.getClientRects()]
          const tops = new Set(rects.map((rect) => Math.round(rect.top)))
          return {
            text: (node.textContent ?? '').trim(),
            lineCount: tops.size,
            width: rects.length ? Math.round(rects[0].width) : 0
          }
        }
        return {
          status: bidText(bar.querySelector('.goal-status')),
          round: measure('.goal-bar-sub'),
          objective: measure('.goal-bar-objective'),
          meta: measure('.goal-detail-meta')
        }
        function bidText(node: Element | null): string {
          return (node?.textContent ?? '').trim()
        }
      })
      console.log('目标条状态:', JSON.stringify(goalBar))
      expect(goalBar, '目标条没有渲染').not.toBeNull()
      expect(goalBar!.status).toBe('已完成')
      // 轮次行、目标文字、底部元信息都不能被压成多行（元信息本身允许折行，只在展开时检查）
      expect(goalBar!.round!.lineCount).toBe(1)
      expect(goalBar!.objective!.lineCount).toBe(1)

      // 窄窗口（手机级宽度）下再测一次：尾部状态 chip 与轮次不能被压实
      await page.setViewportSize({ width: 420, height: 760 })
      await page.waitForTimeout(300)
      const narrow = await page.evaluate(() => {
        const bar = document.querySelector('.goal-bar')
        if (!bar) return null
        const chip = bar.querySelector('.goal-status')
        const sub = bar.querySelector('.goal-bar-sub')
        const lines = (node: Element | null): number => {
          if (!node) return 0
          return new Set([...node.getClientRects()].map((rect) => Math.round(rect.top))).size
        }
        return {
          statusLines: lines(chip),
          statusText: (chip?.textContent ?? '').trim(),
          roundLines: lines(sub),
          barWidth: Math.round(bar.getBoundingClientRect().width)
        }
      })
      console.log('窄窗口目标条:', JSON.stringify(narrow))
      expect(narrow!.statusLines).toBe(1)
      expect(narrow!.roundLines).toBe(1)
      await page.screenshot({ path: screenshotPath('goal-bar-narrow.png') })
      await page.locator('.goal-bar').screenshot({ path: screenshotPath('goal-bar-narrow-closeup.png') })
    } finally {
      await mock.close()
    }
  })
})