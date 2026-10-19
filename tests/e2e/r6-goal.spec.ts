/**
 * R6：Goal 模式（多轮续跑 + update_goal + 暂停/继续/结束）与画布拖动调宽。
 * 运行：npx playwright test tests/e2e/r6-goal.spec.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import {
  configureMockProvider,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  readStore,
  waitForRunStarted,
  waitUntil,
  waitForStoreReady
} from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

function readDeepSeekKey(): string {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return (raw.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9_\-]+)/) ?? [])[1] ?? ''
  } catch {
    return ''
  }
}

async function getGoal(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => (window as unknown as {
    __morrowStore: { getState: () => { session: { goal?: Record<string, any> | null } | null } }
  }).__morrowStore.getState().session?.goal ?? null)
}

async function createSessionWithModel(
  page: Page,
  model: { providerId: string; modelId: string }
): Promise<{ sessionId: string; workspace: string }> {
  return page.evaluate(async (modelRef) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const workspace = await window.morrow.workspace.createDemo()
    if (!workspace.ok) throw new Error('createDemo 失败')
    const created = await window.morrow.session.create({
      workspace: workspace.data.path,
      model: modelRef,
      permissionMode: 'auto',
      title: 'Goal E2E'
    })
    if (!created.ok) throw new Error('session.create 失败')
    await store.getState().selectSession(created.data.id)
    return { sessionId: created.data.id, workspace: workspace.data.path }
  }, model)
}

test.describe('R6 Goal 模式 / 画布调宽', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('画布左缘拖动调宽：香槟金落点线、持久化、双击复位', async () => {
    morrow = await launchMorrow({ name: 'r6-canvas', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    await page.waitForTimeout(300)
    const before = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { canvasWidth: number } }
    }).__morrowStore.getState().canvasWidth)
    expect(before).toBe(420)
    const box = await page.locator('.canvas-resizer').boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + 200
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX - 300, startY, { steps: 8 })
    await expect(page.locator('.resize-line')).toBeVisible()
    const during = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { canvasWidth: number } }
    }).__morrowStore.getState().canvasWidth)
    expect(during).toBeGreaterThan(680)
    await page.screenshot({ path: screenshotPath('r6-final-canvas-resizing.png') })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const state = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return { canvasWidth: s.canvasWidth, setting: s.settings.canvasWidth }
    })
    expect(state.canvasWidth).toBeGreaterThan(680)
    expect(state.setting).toBe(state.canvasWidth)
    await page.locator('.canvas-resizer').dblclick()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { canvasWidth: number } }
    }).__morrowStore.getState().canvasWidth)).toBe(420)
    await page.screenshot({ path: screenshotPath('r6-final-canvas-wide.png') })
  })

  test('Mock LLM：目标多轮续跑（round 1 active → round 2 completed）', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        {
          text: '第 1 轮：写入产物并记录推进摘要。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'goal-part1.md', content: '# Round 1\n骨架完成\n' } },
            { name: 'update_goal', arguments: { status: 'active', summary: '第 1 轮完成：写出 goal-part1.md', nextStep: '第 2 轮补充 goal-part2.md 并验收' } }
          ]
        },
        { text: '第 1 轮结束，等待系统续跑。' },
        {
          text: '第 2 轮：写入收尾产物并标记完成。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'goal-part2.md', content: '# Round 2\n验收完成\n' } },
            { name: 'update_goal', arguments: { status: 'completed', summary: '两轮全部完成，goal-part1.md 与 goal-part2.md 已写入并验收', evidence: ['goal-part1.md', 'goal-part2.md'] } }
          ]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'r6-goal-mock', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('分两轮完成一份验证目标模式的笔记，每轮只推进一个阶段。', 3))
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal && (goal.status === 'completed' || goal.status === 'blocked' || goal.status === 'paused') ? goal : null
      }, 90_000, '目标进入终态')
      const goal = await getGoal(page)
      expect(goal?.status).toBe('completed')
      expect(goal?.round).toBe(2)
      const events = await getEvents(page)
      const goalEvents = events.filter((event) => event.type === 'goal_updated')
      expect(goalEvents.length).toBeGreaterThanOrEqual(2)
      expect(events.some((event) => event.type === 'tool_started' && (event as any).block?.name === 'update_goal')).toBe(true)
      expect(events.filter((event) => event.type === 'tool_finished' && JSON.stringify((event as any).result).includes('目标状态已更新')).length).toBeGreaterThanOrEqual(2)
      const state = await readStore(page)
      expect(state.run).toBeNull()
      await page.screenshot({ path: screenshotPath('r6-final-goal-mock-completed.png') })
    } finally {
      await mock.close()
    }
  })

  test('Mock LLM：暂停/继续/结束的终态不被旧 run 覆盖', async () => {
    test.setTimeout(120_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '先暂停我。', delayMs: 4000 },
        {
          text: '继续后完成目标。',
          toolCalls: [{ name: 'update_goal', arguments: { status: 'completed', summary: '恢复后已完成' } }]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'r6-goal-pause', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证暂停与继续。', 3))
      await waitForRunStarted(page, 30_000)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { pauseGoal: () => Promise<void> } }
      }).__morrowStore.getState().pauseGoal())
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal?.status === 'paused' ? goal : null
      }, 30_000, '目标暂停')
      await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后 run 收尾')
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { resumeGoal: () => Promise<void> } }
      }).__morrowStore.getState().resumeGoal())
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal?.status === 'active' && goal.round === 2 ? goal : null
      }, 60_000, '继续后进入第 2 轮')
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { stopGoal: () => Promise<void> } }
      }).__morrowStore.getState().stopGoal())
      await page.waitForTimeout(1500)
      const afterStop = await getGoal(page)
      // 手动「结束目标」是取消，不是完成；且旧 run 迟到回调必须保持 cancelled
      expect(afterStop?.status).toBe('cancelled')
    } finally {
      await mock.close()
    }
  })

  test('真实 DeepSeek：目标模式多轮续跑并产出文件', async () => {
    test.setTimeout(300_000)
    const key = readDeepSeekKey()
    test.skip(!key, '本机没有 DeepSeek Key')
    morrow = await launchMorrow({ name: 'r6-goal-live', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const saved = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const provider = store.getState().settings.providers.find((p: any) => p.id === 'deepseek')
      return window.morrow.settings.saveProvider({ config: provider, apiKey })
    }, key)
    expect(saved.ok).toBe(true)
    const model = await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { settings: { defaultModel: Record<string, any> } } }
    }).__morrowStore.getState().settings.defaultModel)
    const { workspace } = await createSessionWithModel(page, model as { providerId: string; modelId: string })
    const objective = [
      '分两轮完成目标模式验收文件，每轮只推进一个阶段：',
      '第 1 轮：在工作区创建 goal-round1.md，写三条「目标模式是什么」的要点；完成后调用 update_goal(status=active, summary=第1轮完成, nextStep=第2轮创建 goal-round2.md)，然后结束本轮，不要继续写第二个文件。',
      '第 2 轮：创建 goal-round2.md，写三条可人工检查的验收项；完成后调用 update_goal(status=completed, summary=两轮完成, evidence=["goal-round1.md","goal-round2.md"])。',
      '不要创建其他文件；两个文件都用简体中文。'
    ].join('\n')
    await page.evaluate((text) => (window as unknown as {
      __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
    }).__morrowStore.getState().startGoal(text, 3), objective)
    await waitUntil(async () => {
      const goal = await getGoal(page)
      return goal && ['completed', 'blocked', 'paused'].includes(goal.status) ? goal : null
    }, 240_000, '真实目标进入终态')
    const goal = await getGoal(page)
    console.log('LIVE_GOAL', JSON.stringify(goal))
    expect(goal?.status).toBe('completed')
    expect(goal?.round).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(workspace, 'goal-round1.md'))).toBe(true)
    expect(existsSync(join(workspace, 'goal-round2.md'))).toBe(true)
    const events = await getEvents(page)
    expect(events.some((event) => event.type === 'goal_updated')).toBe(true)
    await page.waitForTimeout(800)
    await page.screenshot({ path: screenshotPath('r6-final-goal-live-completed.png') })
  })
})
