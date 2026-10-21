/**
 * 桌面灵动岛：透明置顶窗口、可拖拽并记忆位置、真实任务进度、快速发送。
 * 需要在测试模式额外开启 MORROW_ISLAND=1（默认测试不创建第二窗口）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function findIslandPage(app: ElectronApplication, timeoutMs = 20_000): Promise<Page> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const page of app.windows()) {
      try {
        if (await page.evaluate(() => window.location.hash === '#island')) {
          await page.waitForSelector('.island-pill', { timeout: 10_000 })
          return page
        }
      } catch {
        // 窗口仍在加载
      }
    }
    await sleep(120)
  }
  throw new Error('灵动岛窗口没有出现')
}

async function islandWindowState(app: ElectronApplication): Promise<{
  visible: boolean
  alwaysOnTop: boolean
  bounds: { x: number; y: number; width: number; height: number }
} | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('#island'))
    if (!win) return null
    return {
      visible: win.isVisible(),
      alwaysOnTop: win.isAlwaysOnTop(),
      bounds: win.getBounds()
    }
  })
}

async function showIslandWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('#island'))
    win?.show()
    win?.focus()
  })
}

async function expandPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: '快速对话' }).click()
  await page.locator('.island-panel').waitFor({ state: 'visible' })
  await page.waitForTimeout(420)
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { setTheme: (value: string) => void } }
    }).__morrowStore
    store.getState().setTheme(next)
  }, theme)
}

test.describe('桌面灵动岛', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('置顶胶囊可拖拽记忆位置，运行中显示真实进度并可从岛内快速发消息', async () => {
    test.setTimeout(180_000)
    mock = await startMockLLM({
      scripts: [{ text: '好，我在主窗口开始做了。', delayMs: 5500, chunkDelayMs: 90 }]
    })
    morrow = await launchMorrow({ name: 'island', env: { MORROW_ISLAND: '1' }, timeoutMs: 90_000 })
    const main = morrow.page
    await waitForStoreReady(main)
    await dismissOnboarding(main)

    const workspace = join(morrow.dataDir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const provider = await configureMockProvider(main, mock.openaiBaseUrl)
    const sessionId = await createSession(main, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '桌面上的小事'
    })
    await installEventCollector(main)

    const island = await findIslandPage(morrow.app)
    await expect(island.locator('.island-title')).toHaveText('Morrow 小伙伴')
    await expect(island.locator('.island-detail')).toContainText('在桌面陪你待命')
    await island.screenshot({ path: screenshotPath('island-collapsed.png'), omitBackground: true })

    // 透明、无边框、置顶，收起尺寸为胶囊
    const initial = await islandWindowState(morrow.app)
    expect(initial).not.toBeNull()
    expect(initial!.visible).toBe(true)
    expect(initial!.alwaysOnTop).toBe(true)
    expect(initial!.bounds.width).toBe(356)
    expect(initial!.bounds.height).toBe(84)

    // 拖到桌面任意位置：松手后写入设置，重启仍可恢复
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('#island'))
      win?.setPosition(160, 140)
    })
    await sleep(900)
    const saved = JSON.parse(readFileSync(join(morrow.dataDir, 'settings.json'), 'utf8')) as {
      islandPosition?: { x: number; y: number } | null
    }
    expect(saved.islandPosition).toEqual({ x: 160, y: 140 })

    // 展开面板：尺寸变化，显示最近对话与任务区
    await expandPanel(island)
    await expect(island.locator('.island-status-chip')).toContainText('待命')
    await expect(island.locator('.island-task-title')).toHaveText('桌面伙伴，随时待命')
    await expect(island.locator('.island-recent')).toContainText('桌面上的小事')
    const expanded = await islandWindowState(morrow.app)
    expect(expanded!.bounds.width).toBe(396)
    expect(expanded!.bounds.height).toBe(520)
    await island.screenshot({ path: screenshotPath('island-panel-idle.png'), omitBackground: true })

    // 岛内快速交代任务 → 主窗口真实运行
    const prompt = '帮我把这件事记下来：给桌面小伙伴加一盏金色小灯。'
    await island.locator('textarea').fill(prompt)
    await island.locator('textarea').press('Enter')
    await waitUntil(async () => {
      const state = await readStore(main)
      return state.session?.messages.some((message) => message.role === 'user' && message.text.includes('金色小灯'))
    }, 30_000, '主窗口收到岛内消息')

    // 运行中重新唤出小伙伴，读取真实状态（mock 首字节延迟 5.5s）
    await showIslandWindow(morrow.app)
    await island.waitForTimeout(300)
    const runningState = await waitUntil(async () => {
      const snapshot = await island.evaluate(async () => {
        const result = await window.morrow.island.snapshot()
        return result.ok ? result.data : null
      })
      return snapshot?.status === 'running' ? snapshot : null
    }, 10_000, '灵动岛进入运行中')
    expect(runningState.sessionId).toBe(sessionId)
    if (!(await island.locator('.island-panel').isVisible())) await expandPanel(island)
    await expect(island.locator('.island-status-chip')).toContainText('进行中')
    await expect(island.locator('.island-task-title')).toHaveText('桌面上的小事')
    await island.screenshot({ path: screenshotPath('island-panel-running.png'), omitBackground: true })

    await waitForRunFinished(main, 90_000)
    await expect(island.locator('.island-status-chip')).toContainText('已完成', { timeout: 20_000 })
    await expect(island.locator('.island-task-detail')).toHaveText('这件事做好了')
    await island.screenshot({ path: screenshotPath('island-panel-done.png'), omitBackground: true })

    // 收起后回到胶囊尺寸，并且仍在置顶
    await island.keyboard.press('Escape')
    await island.waitForTimeout(350)
    const collapsed = await islandWindowState(morrow.app)
    expect(collapsed!.bounds.width).toBe(356)
    expect(collapsed!.alwaysOnTop).toBe(true)

    // 主窗口里能看到完整回复
    await expect(main.getByText('好，我在主窗口开始做了。')).toBeVisible({ timeout: 30_000 })

    // 会话被删除后，岛不能继续指向它；用旧 sessionId 快速发送必须被拒绝，不能落到别的会话
    await main.evaluate(async (id: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().deleteSession(id)
    }, sessionId)
    const reset = await waitUntil(async () => {
      const current = await island.evaluate(async () => {
        const result = await window.morrow.island.snapshot()
        return result.ok ? result.data : null
      })
      return current?.sessionId === null && current.status === 'idle' ? current : null
    }, 10_000, '会话删除后灵动岛复位')
    expect(reset.detail).toContain('待命')

    const stale = await island.evaluate(
      async (id: string) => {
        const result = await window.morrow.island.quickSend({ text: '这条不该落到别的对话', sessionId: id })
        return result.ok ? { ok: true as const } : { ok: false as const, error: result.error.message }
      },
      sessionId
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error).toContain('不存在')
    expect((await readStore(main)).session).toBeNull()
  })

  test('灵动岛跟随明暗主题', async () => {
    test.setTimeout(120_000)
    morrow = await launchMorrow({ name: 'island-theme', env: { MORROW_ISLAND: '1' }, timeoutMs: 90_000 })
    const main = morrow.page
    await waitForStoreReady(main)
    await dismissOnboarding(main)
    const island = await findIslandPage(morrow.app)

    await setTheme(main, 'light')
    await expect.poll(() => island.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    const lightGlass = await island.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--island-pill-bg')
    )
    expect(lightGlass).toContain('252, 248, 240')
    await island.screenshot({ path: screenshotPath('island-collapsed-light.png'), omitBackground: true })

    await expandPanel(island)
    await island.screenshot({ path: screenshotPath('island-panel-light.png'), omitBackground: true })

    await setTheme(main, 'dark')
    await expect.poll(() => island.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    const darkGlass = await island.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--island-pill-bg')
    )
    expect(darkGlass).toContain('28, 33, 42')
  })
})
