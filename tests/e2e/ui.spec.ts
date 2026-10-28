// ui 领域 E2E：由 5 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { MorrowApp } from './launch'
import { launchMorrow, root, screenshotPath, windowStates, screensDir } from './launch'
import { configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForEvent, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil, clearEvents, clickPermissionCard, waitForPermission, openToolPanel, createUiSession } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import type { Server, IncomingMessage } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'



test.describe("01-ui-smoke", () => {
// ── 原文件：smoke.spec.ts ──────────────────────────────────────────────
test.describe('smoke.spec.ts', () => {
/**
 * M0/M1 冒烟：Electron 真实启动 → 窗口出现 → 标题/渲染/预加载 API 正常 → 首屏截图。
 *
 * 运行：npx playwright test tests/e2e/smoke.spec.ts
 * 产物：docs/verification/screens/e2e-boot.png
 *
 * 说明：断言刻意写得「面向未来」——M2/M3 会把骨架页换成真实 App Shell，
 * 这里只验证窗口/标题/渲染/预加载这些不随 UI 迭代变化的事实。
 */

test.describe('Morrow 桌面冒烟', () => {
  test('构建产物可启动：窗口出现、标题正确、首屏有渲染', async () => {
    // 前提：out/main/index.js 已构建
    expect(existsSync(join(root, 'out', 'main', 'index.js')), '缺少构建产物 out/main/index.js，请先 npm run build').toBe(true)

    const pageErrors: string[] = []
    const morrow = await launchMorrow({ name: 'smoke' })
    morrow.page.on('pageerror', (err) => pageErrors.push(String(err)))

    try {
      const { app, page } = morrow

      // 1) 恰好一个可见窗口，且标题是 Morrow
      const windows = await windowStates(app)
      expect(windows.length).toBe(1)
      expect(windows[0].visible).toBe(true)
      expect(windows[0].title).toContain('Morrow')
      // 默认窗口按「物理像素 2000×1000」设计：Electron bounds 是 DIP，需要乘缩放比校验
      const scaleFactor = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor)
      expect(Math.round(windows[0].bounds.width * scaleFactor)).toBeGreaterThanOrEqual(2090)
      expect(Math.round(windows[0].bounds.height * scaleFactor)).toBeGreaterThanOrEqual(1190)

      // 2) 渲染进程加载的是本地构建产物
      await expect(page).toHaveURL(/^file:\/\/.*out\/renderer\/index\.html/)
      await page.waitForLoadState('load')

      // 3) 预加载 API（窄接口）已注入
      const preload = await page.evaluate(() => {
        const api = (window as unknown as { morrow?: Record<string, unknown> }).morrow
        return { hasApi: !!api, keys: api ? Object.keys(api).sort() : [] }
      })
      expect(preload.hasApi).toBe(true)
      expect(preload.keys.length).toBeGreaterThan(0)

      // 4) 首屏不是白屏：body 有文本、有可见节点
      const bodyText = (await page.locator('body').innerText()).trim()
      expect(bodyText.length).toBeGreaterThan(0)
      expect(await page.locator('body').isVisible()).toBe(true)

      // 5) 没有未捕获的渲染层异常
      expect(pageErrors, `渲染层异常：\n${pageErrors.join('\n')}`).toEqual([])

      // 6) 首屏截图归档
      await page.screenshot({ path: screenshotPath('e2e-boot.png') })
      expect(existsSync(join(root, 'docs', 'verification', 'screens', 'e2e-boot.png'))).toBe(true)

      // 7) 数据目录被 --data-dir 指到项目 tmp/ 内（受限令牌下可写）
      expect(morrow.dataDir.startsWith(join(root, 'tmp'))).toBe(true)
    } finally {
      await morrow.close()
    }
  })

  test('外观设置：主题、字号与减少动效即时生效', async () => {
    const morrow = await launchMorrow({ name: 'appearance', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible' })
      await settings.getByRole('tab', { name: '外观' }).click()
      await expect(page.locator('.st-appearance')).toBeVisible()
      await page.waitForTimeout(150)
      await page.screenshot({ path: screenshotPath('settings-appearance-dark.png') })

      await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色' }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await expect(
        page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '浅色' })
      ).toHaveAttribute('aria-checked', 'true')

      const appSizes = page.getByRole('radiogroup', { name: '应用字号' }).getByRole('radio')
      const codeSizes = page.getByRole('radiogroup', { name: '代码字号' }).getByRole('radio')
      await expect(appSizes).toHaveCount(4)
      await expect(codeSizes).toHaveCount(4)
      await expect(appSizes.nth(0)).toHaveAccessibleName('12')
      await expect(appSizes.nth(3)).toHaveAccessibleName('15')
      await expect(codeSizes.nth(0)).toHaveAccessibleName('11')
      await expect(codeSizes.nth(3)).toHaveAccessibleName('14')
      await expect(page.getByRole('radiogroup', { name: '应用字号' }).getByRole('radio', { name: '14' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await expect(page.getByRole('radiogroup', { name: '代码字号' }).getByRole('radio', { name: '12' })).toHaveAttribute(
        'aria-checked',
        'true'
      )

      await page.getByRole('radiogroup', { name: '应用字号' }).getByRole('radio', { name: '15' }).click()
      await expect(
        page.getByRole('radiogroup', { name: '应用字号' }).getByRole('radio', { name: '15' })
      ).toHaveAttribute('aria-checked', 'true')
      await expect
        .poll(() =>
          page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim())
        )
        .toBe('15px')

      await expect(page.locator('html')).toHaveAttribute('data-code-font', 'jetbrains')
      await expect
        .poll(() =>
          page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim())
        )
        .toContain('JetBrains Mono')

      await page.getByRole('radiogroup', { name: '代码字号' }).getByRole('radio', { name: '14' }).click()
      await expect(
        page.getByRole('radiogroup', { name: '代码字号' }).getByRole('radio', { name: '14' })
      ).toHaveAttribute('aria-checked', 'true')
      await expect
        .poll(() =>
          page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-code').trim())
        )
        .toBe('14px')
      await expect
        .poll(() =>
          page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim())
        )
        .toBe('15px')

      await page.getByRole('button', { name: '代码字体' }).click()
      await page.getByRole('option', { name: /IBM Plex Mono/ }).click()
      await expect(page.locator('html')).toHaveAttribute('data-code-font', 'ibm-plex')
      await page.getByRole('button', { name: '代码字体' }).click()
      await page.getByRole('option', { name: /JetBrains Mono/ }).click()
      await expect(page.locator('html')).toHaveAttribute('data-code-font', 'jetbrains')
      await expect
        .poll(() => page.locator('.st-code-preview').evaluate((element) => getComputedStyle(element).fontWeight))
        .toBe('400')

      const motion = page.getByRole('switch', { name: '减少动效' })
      await motion.click()
      await expect(motion).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true')

      await page.locator('.st-panel').evaluate((element) => element.scrollTo({ top: 0 }))
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('settings-appearance-light.png') })
    } finally {
      await morrow.close()
    }
  })
})

})
// ── 原文件：brand-marks.spec.ts ──────────────────────────────────────────────
test.describe('brand-marks.spec.ts', () => {
/**
 * 品牌标识一致性：欢迎/引导页、启动读取页、收起侧栏都必须使用重绘品牌 icon，而不是字母 M。
 */

test('欢迎页 / 启动读取页使用品牌 icon', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'brand-marks', waitForSelector: '.onb' })
  try {
    const { page } = morrow
    const onboardingMark = page.locator('.onb-brand-mark img')
    await expect(onboardingMark).toBeVisible()
    await expect(onboardingMark).toHaveAttribute('src', /brand-mark/)
    await expect(page.locator('.onb')).toBeVisible()
    // 等应用 900ms 入场淡入结束，避免把半透明的中间态截进证据
    await page.waitForTimeout(1000)
    await page.screenshot({ path: screenshotPath('brand-onboarding-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('brand-onboarding-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)

    await dismissOnboarding(page)

    // 启动读取页：借助 test-mode store 强制回到未 ready 状态
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore.setState({
        ready: false
      })
    })
    const bootMark = page.locator('img.app-boot-mark')
    await expect(bootMark).toBeVisible()
    await expect(bootMark).toHaveAttribute('src', /brand-mark/)
    await page.waitForTimeout(900)
    await page.screenshot({ path: screenshotPath('brand-boot-dark.png') })
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：composer-layout.spec.ts ──────────────────────────────────────────────
test.describe('composer-layout.spec.ts', () => {
/**
 * Composer 底栏布局回归：空间不足时左右两组不能互相压住。
 * 运行：npx playwright test tests/e2e/composer-layout.spec.ts
 */

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

test.describe('Composer 底栏', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })
})

})
// ── 原文件：island.spec.ts ──────────────────────────────────────────────
test.describe('island.spec.ts', () => {
/**
 * 桌面灵动岛：透明置顶窗口、可拖拽并记忆位置、真实任务进度、快速发送。
 * 需要在测试模式额外开启 MORROW_ISLAND=1（默认测试不创建第二窗口）。
 */

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
      scripts: [{ text: '好，我在主窗口开始做了。', delayMs: 9000, chunkDelayMs: 90 }]
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
    // 灵动岛跟随主窗口当前会话：已有会话时显示会话名，而不是固定的「Morrow 小伙伴」。
    await expect(island.locator('.island-title')).toHaveText('桌面上的小事')
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
    await expect(island.locator('.island-task-title')).toHaveText('桌面上的小事')
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

    // 灵动岛跟随主窗口：切到另一个对话后显示该对话（没有运行时为待命），不能继续锁在原会话。
    const otherSession = await createSession(main, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '切换后的另一个对话'
    })
    await waitUntil(async () => {
      const result = await island.evaluate(async () => {
        const snapshot = await window.morrow.island.snapshot()
        return snapshot.ok ? snapshot.data : null
      })
      return result?.sessionId === otherSession && result.status === 'idle' ? result : null
    }, 10_000, '灵动岛跟随切换到另一个对话')
    await expect(island.locator('.island-status-chip')).toContainText('待命')

    // 切回原运行会话后，灵动岛恢复该会话的运行状态、开始时间与计划。
    await main.evaluate(async (id: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().selectSession(id)
    }, sessionId)
    const backToRunning = await waitUntil(async () => {
      const result = await island.evaluate(async () => {
        const snapshot = await window.morrow.island.snapshot()
        return snapshot.ok ? snapshot.data : null
      })
      return result?.sessionId === sessionId && result.status === 'running' ? result : null
    }, 10_000, '灵动岛跟随切回运行会话')
    expect(backToRunning.startedAt).toBeGreaterThan(0)
    await expect(island.locator('.island-status-chip')).toContainText('进行中')

    await waitForRunFinished(main, 90_000)
    await expect(island.locator('.island-status-chip')).toContainText('已完成', { timeout: 20_000 })
    await expect(island.locator('.island-task-detail')).toHaveText('这件事做好了')
    await island.screenshot({ path: screenshotPath('island-panel-done.png'), omitBackground: true })

    // 收起后回到胶囊尺寸，并且仍在置顶
    await island.keyboard.press('Escape')
    await island.waitForTimeout(350)
    const collapsed = await islandWindowState(morrow.app)
    // 高 DPI 下窗口宽度有 1px 舍入，允许 356±1
    expect(collapsed!.bounds.width).toBeGreaterThanOrEqual(355)
    expect(collapsed!.bounds.width).toBeLessThanOrEqual(357)
    expect(collapsed!.alwaysOnTop).toBe(true)

    // 主窗口里能看到完整回复
    await expect(main.getByText('好，我在主窗口开始做了。')).toBeVisible({ timeout: 30_000 })

    // 删除当前会话后主窗口会切到另一个会话；灵动岛要跟过去，不能继续指向已删除会话。
    await main.evaluate(async (id: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().deleteSession(id)
    }, sessionId)
    const reset = await waitUntil(async () => {
      const current = await island.evaluate(async () => {
        const result = await window.morrow.island.snapshot()
        return result.ok ? result.data : null
      })
      return current?.sessionId === otherSession && current.status === 'idle' ? current : null
    }, 10_000, '会话删除后灵动岛跟随到另一个会话')
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
    expect((await readStore(main)).session?.id).toBe(otherSession)
  })
})

})
// ── 原文件：session-lifecycle.spec.ts ──────────────────────────────────────────────
test.describe('session-lifecycle.spec.ts', () => {
/**
 * 会话生命周期回归：运行中删除 → 停止运行、清理撤销快照、删除会话文件，且工作区文件保留。
 */

test.describe('会话生命周期', () => {
  test('运行中删除会话：先停止、清快照、删文件，工作区不受影响', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-session-delete-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写文件，再跑一个稍长的命令。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'draft.md', content: 'hello from session lifecycle test' } },
            { name: 'run_command', arguments: { command: 'sleep 30; echo done' } }
          ]
        }
      ]
    })
    const morrow = await launchMorrow({ name: 'session-delete', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 受限令牌下 Git Bash 的 MSYS 初始化可能失败；本用例需要命令持续运行，改用 PowerShell 7。
      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } } })
          .__morrowStore
        await store.getState().updateSettings({ terminalShell: 'pwsh' })
      })
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: '运行中删除测试'
      })
      const before = await readStore(page)
      const sessionId = before.session!.id
      const sessionFile = join(morrow.dataDir, 'sessions', `${sessionId}.json`)
      const snapshotDir = join(morrow.dataDir, 'snapshots', sessionId)

      await sendMessageViaStore(page, '请先写 draft.md，再执行一个 30 秒的命令。')
      await waitForRunStarted(page, 30_000)
      await waitForEvent(
        page,
        'tool_started',
        (event) => (event as { block?: { name?: string } }).block?.name === 'run_command',
        30_000
      )
      await waitUntil(async () => existsSync(snapshotDir), 10_000, '撤销快照目录创建')
      expect(existsSync(sessionFile)).toBe(true)
      const running = await readStore(page)
      expect(running.run?.sessionId).toBe(sessionId)

      const row = page.locator('.sb-session.is-active')
      await row.hover()
      await row.getByRole('button', { name: '删除对话' }).click()
      const dialog = page.locator('[role="dialog"]')
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(320)
      await expect(dialog).toContainText('正在运行')
      await expect(dialog).toContainText('撤销快照')
      await page.screenshot({ path: screenshotPath('session-delete-running-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('session-delete-running-light.png') })
      await setThemeViaStore(page, 'dark')

      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await waitUntil(async () => (await readStore(page)).session === null, 20_000, '当前会话被删除')
      await expect.poll(async () => (await readStore(page)).run, { timeout: 20_000 }).toBeNull()
      // 删除后会按 tombstone 丢弃迟到的运行事件，因此 run_finished 不保证还能到达；
      // 若在删除前已经到达，则必须是 cancelled，而不是正常完成。
      const finished = (await getEvents(page)).find((event) => event.type === 'run_finished')
      if (finished) expect((finished as { reason?: string }).reason).toBe('cancelled')

      expect(existsSync(sessionFile)).toBe(false)
      expect(existsSync(snapshotDir)).toBe(false)
      expect(existsSync(join(workspace, 'draft.md'))).toBe(true)
      await page.waitForTimeout(1_500)
      expect(existsSync(sessionFile)).toBe(false)
      expect(existsSync(snapshotDir)).toBe(false)

      const after = await readStore(page)
      expect(after.sessions.length).toBe(0)
      expect(after.run).toBeNull()
      expect((await getEvents(page)).filter((event) => event.type === 'error')).toHaveLength(0)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：session-branching.spec.ts ──────────────────────────────────────────────
test.describe('session-branching.spec.ts', () => {
/**
 * P1-7 会话分支与消息操作 E2E：
 * - 重新生成最后一条回答（请求里不再带上旧回答）；
 * - 就地编辑首条用户消息并重发（旧对话被截断）；
 * - 删除某条消息之后的所有内容；
 * - 从消息分叉出新会话，原会话保持不变；
 * - 置顶 / 归档 / 移出归档的侧栏交互。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

function chatBodies(mock: { requests: Array<{ url: string; messages: Array<{ role: string; content: unknown }>; lastUserMessageText?: string }> }) {
  return mock.requests.filter((request) => request.url.includes('/chat/completions'))
}

test('会话分支与消息操作：重新生成、编辑重发、分叉、置顶与归档', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一版回答。' },
      { text: '第二版回答。' },
      { text: '编辑后的回答。' },
      { text: '补充回答。' }
    ]
  })
  const workspace = workspaceAt('e2e-session-actions')
  const morrow = await launchMorrow({ name: 'session-actions', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const originalId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'P1-7 测试'
    })

    const send = (text: string): Promise<void> =>
      page.evaluate((value) => {
        return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (t: string) => Promise<void> } } })
          .__morrowStore.getState().sendMessage(value)
      }, text)

    const lastText = async (): Promise<string> => {
      const state = await readStore(page)
      return state.session?.messages.at(-1)?.text ?? ''
    }

    const dismissToasts = (): Promise<void> =>
      page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })

    await send('请回答第一版')
    await waitUntil(async () => (await lastText()) === '第一版回答。', 60_000, '第一版回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮结束')
    expect(chatBodies(mock)).toHaveLength(1)

    // 重新生成：旧回答被丢弃，请求里不带 assistant 消息
    await page.getByRole('button', { name: '重新生成回答' }).click()
    await waitUntil(async () => (await lastText()) === '第二版回答。', 60_000, '重新生成回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '重新生成结束')
    const regenerated = chatBodies(mock)[1]
    expect(regenerated?.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
    expect((await readStore(page)).session?.messages).toHaveLength(2)

    // 编辑首条用户消息并重发：消息之后的回答被截断，新内容重新发送
    const firstUser = page.locator('.message-user').first()
    await firstUser.hover()
    await firstUser.getByRole('button', { name: '编辑并重发' }).click()
    const editor = page.locator('.message-user-editor')
    await expect(editor).toBeVisible()
    await editor.fill('请回答编辑版')
    await editor.press('Enter')
    await waitUntil(async () => (await lastText()) === '编辑后的回答。', 60_000, '编辑后的回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '编辑重发结束')
    const edited = chatBodies(mock)[2]
    expect(edited?.lastUserMessageText).toBe('请回答编辑版')
    expect(edited?.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
    const afterEdit = await readStore(page)
    expect(afterEdit.session?.messages).toHaveLength(2)
    expect(afterEdit.session?.messages[0]?.text).toBe('请回答编辑版')

    // 再补一轮，让消息操作和删除后续都有真实的上下文
    await send('再补充一句')
    await waitUntil(async () => (await lastText()) === '补充回答。', 60_000, '补充回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '补充轮结束')
    expect((await readStore(page)).session?.messages).toHaveLength(4)

    // 截图：悬停用户消息时的完整操作行
    await page.locator('.message-user').first().hover()
    await dismissToasts()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('message-actions-dark.png') })

    // 从首条用户消息分叉：新会话只含到该消息为止的内容
    await page.locator('.message-user').first().getByRole('button', { name: '从这条消息分叉' }).click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== originalId, 20_000, '分叉会话激活')
    const branched = await readStore(page)
    expect(branched.session?.messages).toHaveLength(1)
    expect(branched.session?.title).toBe('P1-7 测试 · 分支')
    expect(branched.sessions).toHaveLength(2)
    const branchUsage = await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { session?: { usage?: Record<string, number> } } } })
        .__morrowStore.getState().session?.usage
    })
    expect(branchUsage).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    await dismissToasts()
    await page.screenshot({ path: screenshotPath('session-branch-dark.png') })

    // 回到原会话，验证原对话没有被分叉改动
    await page.evaluate((id) => {
      void (window as unknown as { __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } } })
        .__morrowStore.getState().selectSession(id)
    }, originalId)
    await waitUntil(async () => (await readStore(page)).activeSessionId === originalId, 20_000, '回到原会话')
    expect((await readStore(page)).session?.messages).toHaveLength(4)

    // 置顶：置顶分组出现在列表最上方
    const originalRow = page
      .locator('.sb-session')
      .filter({ has: page.getByText('P1-7 测试', { exact: true }) })
    await originalRow.hover()
    await originalRow.getByRole('button', { name: '置顶对话' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === originalId)?.pinned === true
    }, 15_000, '会话已置顶')
    await expect(page.locator('.sb-group-head', { hasText: '置顶' })).toBeVisible()
    await dismissToasts()
    await page.screenshot({ path: screenshotPath('session-pinned-dark.png') })

    // 归档：从侧栏收起，改在 设置 → 归档 中管理
    await originalRow.hover()
    await originalRow.getByRole('button', { name: '归档对话' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === originalId)?.archived === true
    }, 15_000, '会话已归档')
    await expect(page.getByText('P1-7 测试', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sb-group.is-archived')).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    const archivedRow = page
      .locator('.st-archive-row')
      .filter({ has: page.getByText('P1-7 测试', { exact: true }) })
    await expect(archivedRow).toBeVisible()
    await dismissToasts()
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('session-archive-light.png') })

    // 恢复后回到侧栏的“置顶”分组
    await archivedRow.getByRole('button', { name: '恢复' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      const meta = state.sessions.find((session) => session.id === originalId)
      return meta?.archived === false && meta?.pinned === true
    }, 15_000, '会话已移出归档')
    await expect(archivedRow).toHaveCount(0)
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText('P1-7 测试', { exact: true })).toBeVisible()
    await setThemeViaStore(page, 'dark')

    // 归档当前会话时应用已切到下一个会话；移出归档后手动切回原会话再验证删除
    await page.evaluate((id) => {
      void (window as unknown as { __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } } })
        .__morrowStore.getState().selectSession(id)
    }, originalId)
    await waitUntil(async () => (await readStore(page)).activeSessionId === originalId, 20_000, '切回原会话')

    // 删除后续：保留当前消息，清掉其后的全部对话
    await page.locator('.message-user').first().hover()
    await page.locator('.message-user').first().getByRole('button', { name: '删除后续消息' }).click()
    const confirm = page.getByRole('alertdialog', { name: '删除后续消息' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 1, 20_000, '后续消息已删除')
    const truncated = await readStore(page)
    expect(truncated.session?.messages[0]?.text).toBe('请回答编辑版')

    // 重启一侧的持久化由 session-store 单测覆盖；这里确认主进程磁盘状态一致
    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, originalId)
    expect(loaded?.messages).toHaveLength(1)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('归档唯一可见对话后自动新建空白对话', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ scripts: [{ text: 'ok' }] })
  const workspace = workspaceAt('e2e-archive-only')
  const morrow = await launchMorrow({ name: 'archive-only', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const id = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '唯一对话'
    })

    await page.evaluate(async (sessionId) => {
      await (
        window as unknown as { __morrowStore: { getState: () => { setSessionArchived: (id: string, value: boolean) => Promise<void> } } }
      ).__morrowStore.getState().setSessionArchived(sessionId, true)
    }, id)

    const state = await readStore(page)
    expect(state.sessions.find((session) => session.id === id)?.archived).toBe(true)
    expect(state.activeSessionId).not.toBe(id)
    expect(state.session?.messages).toHaveLength(0)
    expect(state.sessions.length).toBeGreaterThanOrEqual(2)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r5-ui.spec.ts ──────────────────────────────────────────────
test.describe('r5-ui.spec.ts', () => {
/**
 * R5 UI 验收：侧栏拖拽/完全收起、画布开关、设置最新模型分组、上下文 Tab、真实同步模型列表。
 * 运行：npx playwright test tests/e2e/r5-ui.spec.ts
 */

function readDeepSeekKey(): string {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return (raw.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9_\-]+)/) ?? [])[1] ?? ''
  } catch {
    return ''
  }
}

async function dismissOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    store.setState({ onboardingOpen: false })
  })
  await page.waitForTimeout(150)
}

async function storeState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, unknown> } }).__morrowStore.getState())
}

test.describe('R5 UI 交互', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('侧栏可拖动调宽（金色提示线）、双击复位、收起后完全隐藏', async () => {
    morrow = await launchMorrow({ name: 'r5-sidebar', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.screenshot({ path: screenshotPath('r5-final-welcome.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r5-final-welcome-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    const shell = page.locator('.app-sidebar-shell')
    await expect(shell).toHaveCount(1)
    await page.waitForTimeout(500)
    const before = await shell.evaluate((el) => el.clientWidth)
    expect(before).toBeGreaterThan(200)
    const box = await page.locator('.sidebar-resizer').boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + 200

    // 满负载全量回归时，窗口/React 可能尚未处理 pointerdown；先 hover 再按下并等拖拽态生效。
    await page.locator('.sidebar-resizer').hover()
    await page.mouse.down()
    await expect(page.locator('.sidebar-resizer')).toHaveClass(/is-dragging/)
    await page.waitForTimeout(120)
    await page.mouse.move(startX + 96, startY, { steps: 6 })
    await expect(page.locator('.resize-line')).toBeVisible()
    const dragLine = await page.evaluate(() => {
      const line = document.querySelector<HTMLElement>('.resize-line')
      const sidebar = document.querySelector<HTMLElement>('.sidebar')
      const handle = document.querySelector<HTMLElement>('.sidebar-resizer')
      return {
        background: line ? getComputedStyle(line).backgroundColor : 'missing',
        border: sidebar ? getComputedStyle(sidebar).borderRightColor : 'missing',
        accent: handle ? getComputedStyle(handle, '::after').backgroundColor : 'missing',
        accentOpacity: handle ? getComputedStyle(handle, '::after').opacity : 'missing'
      }
    })
    expect(dragLine.background).toBe('rgba(0, 0, 0, 0)')
    expect(dragLine.border).toBe('rgba(0, 0, 0, 0)')
    expect(dragLine.accent).toContain('228, 206, 158')
    expect(dragLine.accentOpacity).toBe('1')
    const during = await shell.evaluate((el) => el.clientWidth)
    expect(during).toBeGreaterThan(before + 60)
    await page.screenshot({ path: screenshotPath('r5-final-sidebar-resizing.png') })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const state = await storeState(page)
    expect(Number((state.settings as { sidebarWidth: number }).sidebarWidth)).toBeGreaterThan(before + 60)
    const after = await shell.evaluate((el) => el.clientWidth)
    expect(after).toBeGreaterThan(before + 60)

    // 双击恢复默认 240
    await page.locator('.sidebar-resizer').dblclick()
    await page.waitForTimeout(300)
    expect(await shell.evaluate((el) => el.clientWidth)).toBe(240)

    // 收起：侧栏 DOM 完全消失
    await page.locator('[aria-label="收起侧栏 (Ctrl+B)"]').click()
    await expect(page.locator('.app-sidebar-shell')).toHaveCount(0)
    await expect(page.locator('.sidebar-resizer')).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('r5-final-sidebar-collapsed.png') })
    await page.locator('[aria-label="收起侧栏 (Ctrl+B)"]').click()
    await expect(page.locator('.app-sidebar-shell')).toHaveCount(1)
  })

  test('标题栏画布按钮：无产物时展开空态、再次收起', async () => {
    morrow = await launchMorrow({ name: 'r5-canvas', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    // R9：无内容时不显示“画布”字样，头部只保留关闭按钮
    await expect(page.locator('.canvas-head-title')).toHaveCount(0)
    await expect(page.locator('.canvas-root')).not.toContainText('画布')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r5-final-canvas-empty.png') })
    await page.locator('[aria-label="收起画布"]').click()
    await expect(page.locator('.canvas-root')).toHaveCount(0)
    // 打开设置后再关闭，确认画布不会误开
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    await page.locator('[aria-label="收起画布"]').click()
    await expect(page.locator('.canvas-root')).toHaveCount(0)
  })

  test('设置：模型服务选择 / 上下文 Tab / 自动压缩开关', async () => {
    morrow = await launchMorrow({ name: 'r5-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore.getState().openSettings()
    })
    const dialog = page.locator('[role="dialog"]').first()
    await expect(dialog).toBeVisible()

    // 服务选择器包含所有服务；当前默认模型与 DeepSeek 模型可见
    await dialog.getByRole('button', { name: '选择模型服务' }).click()
    const providerOptions = dialog.getByRole('option')
    expect(await providerOptions.count()).toBeGreaterThanOrEqual(14)
    for (const provider of ['DeepSeek', 'Kimi（月之暗面）', '通义千问（阿里云）', '智谱 GLM（Z.AI）', 'MiniMax', '小米 MiMo', 'Anthropic Claude', 'OpenAI', 'Google Gemini', 'xAI Grok', 'Meta（Muse）', 'llama.cpp（本地）', 'Ollama（本地）', 'LM Studio（本地）']) {
      await expect(dialog.getByText(provider, { exact: true }).first()).toBeVisible()
    }
    // OpenRouter 是中转聚合，不是官方或本地模型，不再出现在服务列表
    await expect(providerOptions.filter({ hasText: 'OpenRouter' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '选择模型服务' }).click()
    await expect(dialog.getByText(/填上 API Key 就能用/)).toBeVisible()
    await expect(dialog.getByText('DeepSeek V4.1 Flash').first()).toBeVisible()
    await expect(dialog.locator('.st-provider')).toHaveCount(1)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r5-final-settings-models.png') })
    // 主题切换同步窗口/托盘图标（深色/浅色两套资产）
    expect((await page.evaluate(() => window.morrow.app.setTheme('light'))).ok).toBe(true)
    expect((await page.evaluate(() => window.morrow.app.setTheme('dark'))).ok).toBe(true)
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r5-final-settings-models-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    const pickProvider = async (label: string): Promise<void> => {
      await dialog.getByRole('button', { name: '选择模型服务' }).click()
      await dialog.getByRole('option').filter({ hasText: label }).click()
    }

    // 逐个服务检查最新模型
    const latestByProvider: Array<[string, string[]]> = [
      ['OpenAI', ['GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna']],
      ['智谱 GLM（Z.AI）', ['GLM-5.3', 'GLM-5.3 Flash']],
      ['xAI Grok', ['Grok 4.7', 'Grok 4.6']],
      ['Kimi（月之暗面）', ['Kimi K3.1 Pro', 'Kimi K3', 'Kimi K2.8 Preview']],
      ['Google Gemini', ['Gemini 4 Argon', 'Gemini 3.8 Flash']],
      ['DeepSeek', ['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro']],
      ['Anthropic Claude', ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']],
      ['小米 MiMo', ['MiMo V2.6 Pro', 'MiMo V2.6 Flash']],
      ['Meta（Muse）', ['Muse Wonder 1.0', 'Muse Spark 1.3']],
      ['MiniMax', ['MiniMax M3', 'MiniMax M3.1 Flash']],
      ['通义千问（阿里云）', ['Qwen3.8 Max', 'Qwen3.8 Flash Next']]
    ]
    for (const [provider, models] of latestByProvider) {
      await pickProvider(provider)
      for (const model of models) {
        await expect(dialog.getByText(new RegExp(model)).first()).toBeVisible()
      }
      if (provider === 'OpenAI') {
        await page.waitForTimeout(300)
        await page.screenshot({ path: screenshotPath('r5-final-settings-models-openai.png') })
      }
      if (provider === 'xAI Grok') {
        await expect(dialog.getByText(/Grok 4\.1/)).toHaveCount(0)
      }
      if (provider === 'Kimi（月之暗面）') {
        await expect(dialog.getByText(/Kimi K2\.7|Kimi K2\.6/)).toHaveCount(0)
        await page.waitForTimeout(250)
        await page.screenshot({ path: screenshotPath('r25-settings-xai-models.png') })
      }
    }
    await expect(dialog.getByText('Qwen Plus')).toHaveCount(0)
    await expect(dialog.getByText('MiniMax M2.5')).toHaveCount(0)
    // 回到默认 provider，保持默认模型卡片与顶部一致
    await pickProvider('DeepSeek')

    // 上下文 Tab
    await dialog.locator('#st-tab-context').click()
    await expect(dialog.getByText('自动压缩').first()).toBeVisible()
    const compactSwitch = dialog.locator('[role="switch"]').first()
    await expect(compactSwitch).toBeVisible()
    const before = (await storeState(page)).settings as { autoCompact: boolean }
    await compactSwitch.click()
    await page.waitForTimeout(400)
    const after = (await storeState(page)).settings as { autoCompact: boolean }
    expect(after.autoCompact).toBe(!before.autoCompact)
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('r5-final-settings-context.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r5-final-settings-context-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
  })

  test('设置：清除已保存密钥需二次确认，清除后连接状态同步', async () => {
    morrow = await launchMorrow({ name: 'r5-clear-key', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: {
          getState: () => {
            settings: { providers: Array<Record<string, unknown>> }
            saveProvider: (input: { config: Record<string, unknown>; apiKey: string }) => Promise<void>
          }
        }
      }).__morrowStore.getState()
      const provider = store.settings.providers.find((item) => item.id === 'deepseek')!
      await store.saveProvider({ config: provider, apiKey: 'sk-e2e-clear-key' })
    })
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore.getState().openSettings()
    })
    const dialog = page.locator('[role="dialog"]').first()
    await expect(dialog).toBeVisible()
    const clear = dialog.getByRole('button', { name: /清除 .* 的密钥/ })
    await expect(clear).toBeVisible({ timeout: 10_000 })
    await clear.click()
    await expect(dialog.getByText('清除已保存的密钥？')).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-clear-key-dark.png') })
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { setTheme: (theme: string) => void } } }).__morrowStore
        .getState()
        .setTheme('light')
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-clear-key-light.png') })

    await dialog.getByRole('button', { name: '确认清除' }).click()
    await expect(dialog.getByText('已清除保存的密钥')).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByRole('button', { name: /清除 .* 的密钥/ })).toHaveCount(0)
    await expect
      .poll(async () => {
        const state = await storeState(page)
        const settings = state.settings as { providers: Array<{ id: string; apiKeyStored: boolean }> }
        return settings.providers.find((provider) => provider.id === 'deepseek')?.apiKeyStored
      })
      .toBe(false)
    expect(Boolean((await storeState(page)).hasAnyApiKey)).toBe(false)
  })

  test('真实 DeepSeek 对话：上下文用量 = 最近一次请求 input+output', async () => {
    const key = readDeepSeekKey()
    test.skip(!key, '本机没有 DeepSeek Key，跳过真实对话用例')
    morrow = await launchMorrow({ name: 'r5-live', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    const saved = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { settings: { providers: Array<Record<string, unknown>> } } }
      }).__morrowStore.getState()
      const provider = store.settings.providers.find((p) => p.id === 'deepseek')!
      return window.morrow.settings.saveProvider({ config: provider as never, apiKey })
    }, key)
    expect(saved.ok).toBe(true)
    const demo = await page.evaluate(() => window.morrow.workspace.createDemo())
    expect(demo.ok).toBe(true)
    if (demo.ok) {
      await page.evaluate(async (wsPath) => {
        const store = (window as unknown as { __morrowStore: { getState: () => { newSession: (o: { workspace: string }) => Promise<unknown> } } }).__morrowStore.getState()
        await store.newSession({ workspace: wsPath })
      }, demo.data.path)
    }
    await page.waitForTimeout(300)

    const composer = page.locator('.composer textarea, textarea.composer-input').first()
    await composer.fill('只回复两个字：你好。不要调用任何工具。')
    await composer.press('Enter')

    await page.waitForFunction(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return !s.run && (s.session?.usage?.inputTokens ?? 0) > 0
    }, { timeout: 90_000 })

    const usage = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return {
        usage: s.session.usage,
        model: s.session.model,
        label: s.settings.providers
          .find((p: any) => p.id === s.session.model.providerId)?.models
          .find((m: any) => m.id === s.session.model.modelId)?.label,
        contextLimit: s.settings.providers
          .find((p: any) => p.id === s.session.model.providerId)?.models
          .find((m: any) => m.id === s.session.model.modelId)?.contextWindow
      }
    })
    console.log('LIVE_USAGE', JSON.stringify(usage))
    expect(usage.model.providerId).toBe('deepseek')
    expect(usage.label).toContain('DeepSeek V4.1 Flash')
    expect(usage.contextLimit).toBeGreaterThanOrEqual(1_000_000)
    expect(usage.usage.contextUsed).toBeGreaterThan(0)
    // 单轮无工具：最近一次请求 = prompt + completion，正好等于累计 input + output
    expect(usage.usage.contextUsed).toBe(usage.usage.inputTokens + usage.usage.outputTokens)
    await page.screenshot({ path: screenshotPath('r5-final-live-context.png') })
  })

  test('真实同步 DeepSeek 模型列表（/models 精确元数据）', async () => {
    const key = readDeepSeekKey()
    test.skip(!key, '本机没有 DeepSeek Key，跳过真实同步用例')
    morrow = await launchMorrow({ name: 'r5-sync', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    const result = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { settings: { providers: Array<Record<string, unknown>> } } }
      }).__morrowStore.getState()
      const provider = store.settings.providers.find((p) => p.id === 'deepseek')!
      const saved = await window.morrow.settings.saveProvider({ config: provider as never, apiKey })
      if (!saved.ok) throw new Error(`保存 Key 失败：${saved.error.message}`)
      const synced = await window.morrow.settings.syncModels('deepseek')
      if (!synced.ok) throw new Error(`同步失败：${synced.error.message}`)
      return {
        ok: true,
        total: synced.data.total,
        models: synced.data.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow, maxOutput: m.maxOutput }))
      }
    }, key)
    expect(result.total).toBeGreaterThanOrEqual(2)
    const flash = result.models.find((m) => m.id === 'deepseek-flash')
    expect(flash?.contextWindow).toBe(1048576)
    expect(flash?.maxOutput).toBeGreaterThanOrEqual(393216)
  })
})

})
// ── 原文件：r7-ui.spec.ts ──────────────────────────────────────────────
test.describe('r7-ui.spec.ts', () => {
/** R7：新默认布局 240/420 与侧栏品牌区视觉验收。 */

test.describe('R7 默认布局与品牌区', () => {
  let morrow: MorrowApp
  test.afterEach(async () => {
    await morrow?.close()
  })

  test('旧默认宽度 264/560 一次性迁移到 240/420，自定义宽度保留', async () => {
    const dataDir = join(root, 'tmp', `r7-migrate-${Date.now()}`)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ sidebarWidth: 264, canvasWidth: 560 }), 'utf8')
    morrow = await launchMorrow({ name: 'r7-migrate', dataDir, waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    const widths = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return { sidebar: s.sidebarWidth, canvas: s.canvasWidth }
    })
    expect(widths.sidebar).toBe(240)
    expect(widths.canvas).toBe(420)
    await morrow.close()
    morrow = null

    const customDir = join(root, 'tmp', `r7-custom-${Date.now()}`)
    mkdirSync(customDir, { recursive: true })
    writeFileSync(join(customDir, 'settings.json'), JSON.stringify({ sidebarWidth: 300, canvasWidth: 520 }), 'utf8')
    morrow = await launchMorrow({ name: 'r7-custom', dataDir: customDir, waitForSelector: '.sidebar' })
    await waitForStoreReady(morrow.page)
    const custom = await morrow.page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return { sidebar: s.sidebarWidth, canvas: s.canvasWidth }
    })
    expect(custom.sidebar).toBe(300)
    expect(custom.canvas).toBe(520)
  })

  test('默认三栏比例：侧栏 240px / 画布 420px，深色与浅色品牌区', async () => {
    morrow = await launchMorrow({ name: 'r7-ui', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.waitForTimeout(400)
    const layout = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return {
        sidebarWidth: s.sidebarWidth,
        canvasWidth: s.canvasWidth,
        sidebarSetting: s.settings.sidebarWidth,
        canvasSetting: s.settings.canvasWidth
      }
    })
    expect(layout.sidebarWidth).toBe(240)
    expect(layout.canvasWidth).toBe(420)
    await expect(page.locator('.app-sidebar-shell')).toHaveJSProperty('clientWidth', 240)
    await page.screenshot({ path: screenshotPath('r7-final-default-dark.png') })

    // 打开画布，让三栏比例落到截图
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r7-final-layout-dark.png') })
    const canvasBox = await page.locator('.canvas-root').boundingBox()
    expect(canvasBox?.width).toBeGreaterThanOrEqual(418)
    expect(canvasBox?.width).toBeLessThanOrEqual(422)

    await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { setTheme: (t: 'dark' | 'light') => Promise<void> } }
    }).__morrowStore.getState().setTheme('light'))
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r7-final-layout-light.png') })
    await page.screenshot({ path: screenshotPath('r7-final-brand-light.png') })
  })

  test('目标入口：目标按钮把输入框切到 /goal 前缀，不再弹出独立对话框', async () => {
    morrow = await launchMorrow({ name: 'r7-goal-entry', waitForSelector: '.sidebar' })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.locator('[aria-label="把输入框内容设为目标（多轮自动推进）"]').click()
    await expect(page.locator('.composer-input')).toHaveValue('/goal ')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r7-final-goal-entry-dark.png') })
    await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { setTheme: (t: 'dark' | 'light') => Promise<void> } }
    }).__morrowStore.getState().setTheme('light'))
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r7-final-goal-entry-light.png') })
  })
})

})
// ── 原文件：r7-privacy.spec.ts ──────────────────────────────────────────────
test.describe('r7-privacy.spec.ts', () => {
/** R7 M32 回归：工具结果中的邮箱/token 不得出现在助手可见回复；safe.log 脱敏。 */

function readDeepSeekKey(): string {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return (raw.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9_\-]+)/) ?? [])[1] ?? ''
  } catch {
    return ''
  }
}

test('M32：隐私脱敏（safe.log + 可见回复/持久会话均无原值）', async () => {
  test.setTimeout(180_000)
  const key = readDeepSeekKey()
  test.skip(!key, '本机没有 DeepSeek Key')
  const stamp = Date.now()
  const workspace = join(root, 'tmp', `r7-m32-ws-${stamp}`)
  mkdirSync(join(workspace, 'in'), { recursive: true })
  writeFileSync(
    join(workspace, 'in', 'debug.log'),
    'request_id=R-17 email=alice@example.test token=CANARY_TEST_SECRET_9Q error=E_TIMEOUT\n',
    'utf8'
  )
  const morrow: MorrowApp = await launchMorrow({ name: 'r7-m32', waitForSelector: '.sidebar' })
  const { page } = morrow
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const saved = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const provider = store.getState().settings.providers.find((p: any) => p.id === 'deepseek')
      return window.morrow.settings.saveProvider({ config: provider, apiKey })
    }, key)
    expect(saved.ok).toBe(true)
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const model = store.getState().settings.defaultModel
      const created = await window.morrow.session.create({ workspace: ws, model, permissionMode: 'auto', title: 'M32 隐私' })
      if (!created.ok) throw new Error('session.create 失败')
      await store.getState().selectSession(created.data.id)
    }, workspace)
    await page.evaluate(() => (window as unknown as {
      __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<unknown> } }
    }).__morrowStore.getState().sendMessage(
      '把 in/debug.log 整理成可分享的 out/safe.log：把 token 原值与整个邮箱地址分别替换成 [REDACTED]；用户名 alice 也不能保留，保留错误码与 request_id。不要外传，不要把原值放到对话或记忆。out/result.json 写 redacted=true。'
    ))
    await page.waitForFunction(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return !s.run && (s.session?.usage?.inputTokens ?? 0) > 0
    }, undefined, { timeout: 120_000 })
    const visibleText = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return (s.session.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text ?? ''))
        .join('\n')
    })
    console.log('VISIBLE', visibleText.slice(0, 1200))
    expect(visibleText.toLowerCase()).not.toContain('alice')
    expect(visibleText).not.toContain('CANARY_TEST_SECRET_9Q')
    const safePath = join(workspace, 'out', 'safe.log')
    expect(existsSync(safePath)).toBe(true)
    const safe = readFileSync(safePath, 'utf8')
    console.log('SAFE_LOG', safe)
    expect(safe).toContain('request_id=R-17')
    expect(safe).toContain('[REDACTED]')
    expect(safe).toContain('E_TIMEOUT')
    expect(safe).not.toContain('alice')
    expect(safe).not.toContain('CANARY_TEST_SECRET_9Q')
    await page.screenshot({ path: screenshotPath('r7-final-m32-privacy.png') })
  } finally {
    await morrow.close()
  }
})

})
})


test.describe("04-modes", () => {
// ── 原文件：goal-mode.spec.ts ──────────────────────────────────────────────
test.describe('goal-mode.spec.ts', () => {
/**
 * 目标模式回归：
 * - 无可用模型时建立目标失败，不留下「进行中但不会动」的幽灵目标；
 * - 目标只从 Composer 的 /goal 前缀或目标按钮建立，不再弹出独立对话框；
 * - 暂停会停止当前轮（按钮文案与行为一致）；
 * - 已有目标在别的会话推进时，不能在另一个会话再建目标（渲染层 + 主进程双重拦截）。
 */

function getGoal(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { goal?: Record<string, any> | null } | null } }
    }).__morrowStore
    return store.getState().session?.goal ?? null
  })
}

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('目标用输入框 /goal 前缀建立；无可用模型时失败且不留幽灵目标', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'goal-failure', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const model = await page.evaluate(() => {
      const settings = (window as unknown as {
        __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string }> }> } } }
      }).__morrowStore.getState().settings
      const provider = settings.providers.find((item) => item.id === 'deepseek')
      return provider?.models[0] ? { providerId: provider.id, modelId: provider.models[0].id } : null
    })
    expect(model, '内置 DeepSeek 应有可用模型').not.toBeNull()
    await createSession(page, {
      workspace: workspaceAt('e2e-goal-failure'),
      ...model!,
      permissionMode: 'auto',
      title: '无 Key 目标测试'
    })

    // 斜杠命令把输入框切到 /goal 前缀，不再出现独立弹窗
    await page.locator('.composer-input').fill('/goal')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('/goal ')
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await expect(page.locator('.transcript-empty-title')).toBeVisible()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('goal-composer-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('goal-composer-light.png') })
    await setThemeViaStore(page, 'dark')

    // 无可用模型：直接提交应失败并保留输入，便于修好后重试
    const objectiveLine = '/goal 测试没有模型密钥时的目标启动。'
    await page.locator('.composer-input').fill(objectiveLine)
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/还没有连接模型/).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.composer-input')).toHaveValue(objectiveLine)
    expect(await getGoal(page)).toBeNull()
    expect((await readStore(page)).run).toBeNull()
  } finally {
    await morrow.close()
  }
})

test('暂停停止当前轮；另一个会话有目标在推进时不能建新目标', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮推进中，等待暂停。', delayMs: 6_000 },
      { text: '第二轮推进中，等待并发互斥检查。', delayMs: 6_000 }
    ]
  })
  const workspace = workspaceAt('e2e-goal-audit')
  const morrow = await launchMorrow({ name: 'goal-audit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionA = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '目标会话 A'
    })
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (objective: string, rounds?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证暂停行为与跨会话互斥。', 3)
    })
    await waitForRunStarted(page, 30_000)

    const pauseButton = page.locator('.goal-bar-actions').getByRole('button', { name: '暂停' })
    await expect(pauseButton).toHaveAttribute('title', /暂停并停止当前轮/)
    await pauseButton.click()
    await waitUntil(async () => (await getGoal(page))?.status === 'paused', 30_000, '目标暂停')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后运行收尾')
    await expect(page.locator('.goal-bar-sub')).toContainText('已暂停 · 自动续跑已停止')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.waitForTimeout(220)
    await page.locator('.goal-bar-toggle').click()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('goal-paused-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('goal-paused-light.png') })
    await setThemeViaStore(page, 'dark')

    // 继续后进入第 2 轮，制造「A 正在推进」的状态
    await page.locator('.goal-bar-actions').getByRole('button', { name: '继续' }).click()
    await waitUntil(async () => (await getGoal(page))?.status === 'active' && (await getGoal(page))?.round === 2, 30_000, '目标继续到第 2 轮')
    await waitForRunStarted(page, 30_000)

    const sessionB = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '目标会话 B'
    })
    const storeError = await page.evaluate(async () => {
      try {
        await (window as unknown as {
          __morrowStore: { getState: () => { startGoal: (objective: string) => Promise<void> } }
        }).__morrowStore.getState().startGoal('B 会话的新目标')
        return ''
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    })
    expect(storeError).toMatch(/还有任务在运行|目标正在自动推进/)

    const direct = await page.evaluate(
      async (sessionId) =>
        (window as unknown as {
          morrow: { goal: { start: (input: unknown) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.goal.start({ sessionId, objective: 'B 会话直接 IPC 目标', maxRounds: 2 }),
      sessionB
    )
    expect(direct.ok).toBe(false)
    expect(direct.error?.message ?? '').toMatch(/另一个对话/)

    // 回到 A 结束目标，清理运行
    await page.evaluate(async (sessionId) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } }
      }).__morrowStore
      await store.getState().selectSession(sessionId)
    }, sessionA)
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { stopGoal: () => Promise<void> } }
      }).__morrowStore.getState().stopGoal()
    })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '结束后运行收尾')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('阻塞目标在目标条上可以直接继续', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '遇到阻塞，等待补充。',
        toolCalls: [
          {
            name: 'update_goal',
            arguments: { status: 'blocked', summary: '需要补充数据源', blockedReason: '缺少销售明细表' }
          }
        ]
      },
      { text: '等待用户补充资料。' },
      {
        text: '阻塞已解决，继续推进。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'goal-blocked-done.md', content: '# 阻塞解除\n验收完成\n' } },
          { name: 'update_goal', arguments: { status: 'completed', summary: '补充后完成', evidence: ['goal-blocked-done.md'] } }
        ]
      },
      { text: '目标完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'goal-blocked', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-goal-blocked'),
      ...provider,
      permissionMode: 'auto',
      title: '阻塞目标测试'
    })
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (objective: string) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证阻塞后可继续。')
    })
    await waitUntil(async () => (await getGoal(page))?.status === 'blocked', 60_000, '目标进入阻塞态')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '阻塞后运行收尾')
    await expect(page.locator('.goal-detail-row.is-blocked')).toContainText('缺少销售明细表')
    const resume = page.locator('.goal-bar-actions').getByRole('button', { name: '继续' })
    await expect(resume).toBeVisible()
    await resume.click()
    // 模型可能瞬间跑完，不能只等 active，否则会错过中间态
    await waitUntil(
      async () => {
        const goal = await getGoal(page)
        return goal?.round === 2 && (goal.status === 'active' || goal.status === 'completed') ? goal : null
      },
      60_000,
      '阻塞后继续到第 2 轮'
    )
    await waitUntil(async () => (await getGoal(page))?.status === 'completed', 30_000, '继续后完成目标')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '完成后运行收尾')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('结束目标不会中止暂停期间发出的普通聊天', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮目标推进中。', delayMs: 5_000 },
      { text: '普通聊天完成。', delayMs: 1_500 }
    ]
  })
  const morrow = await launchMorrow({ name: 'goal-stop-chat', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-goal-stop-chat'),
      ...provider,
      permissionMode: 'auto',
      title: '结束目标聊天测试'
    })
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (objective: string) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证结束目标不影响普通聊天。')
    })
    await waitForRunStarted(page, 30_000)
    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { pauseGoal: () => Promise<void> } }
      }).__morrowStore.getState().pauseGoal()
    })
    await waitUntil(async () => (await getGoal(page))?.status === 'paused', 30_000, '目标暂停')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后运行收尾')

    await page.evaluate(() => {
      return (window as unknown as {
        __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } }
      }).__morrowStore.getState().sendMessage('现在只是普通聊天。')
    })
    await waitForRunStarted(page, 30_000)
    await page.locator('.goal-bar-actions').getByRole('button', { name: '结束目标' }).click()
    await page.locator('.modal-panel').getByRole('button', { name: '结束目标' }).click()
    await waitUntil(async () => (await getGoal(page))?.status === 'cancelled', 30_000, '目标结束')
    // 普通聊天应继续并正常出结果（旧实现会 abort 整个会话）
    await expect(page.getByText('普通聊天完成。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '普通聊天完成')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：plan-mode.spec.ts ──────────────────────────────────────────────
test.describe('plan-mode.spec.ts', () => {
/**
 * P0-2 计划模式 E2E：
 * - /plan 进入计划模式并生成计划卡（只读工具运行，不写文件）；
 * - 拒绝 → 重新规划 → 生成修订版计划；
 * - 批准 → 自动切执行、写入 todo 与产物，完成后计划标记 completed 且持久化。
 */

function getPlan(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { plan?: Record<string, any> | null; planMode?: boolean } | null } }
    }).__morrowStore
    return store.getState().session?.plan ?? null
  })
}

function getPlanMode(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { planMode?: boolean } | null } }
    }).__morrowStore
    return store.getState().session?.planMode === true
  })
}

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

const planV1 = {
  title: '整理销售数据并生成报告',
  summary: '读取 in/sales.csv，核对总额，再生成一份可直接分享的报告。',
  steps: [
    { text: '读取 in/sales.csv 并核对总销售额' },
    { text: '按月份汇总并检查异常值' },
    { text: '生成 out/report.md 并在画布打开' }
  ],
  risks: '如果 CSV 缺少月份列，需要先向用户确认口径。'
}

const planV2 = {
  title: '先出 Markdown 摘要，再生成报告',
  summary: '按用户意见先输出 Markdown 摘要，确认后再生成完整报告。',
  steps: [
    { text: '读取 in/sales.csv 并核对总销售额' },
    { text: '输出 out/summary.md 月度摘要' },
    { text: '生成 out/report.md 完整报告' }
  ]
}

test('计划模式：/plan 生成 → 拒绝 → 修订 → 批准执行并持久化', async () => {
  test.setTimeout(240_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '我先看一下工作区。', toolCalls: [{ name: 'submit_plan', arguments: planV1 }] },
      { text: '计划已就绪，等待你的批准。' },
      { text: '按你的意见重做计划。', toolCalls: [{ name: 'submit_plan', arguments: planV2 }] },
      { text: '修订后的计划已就绪。' },
      {
        text: '开始执行。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step) => ({ text: step.text, status: 'pending' }))
            }
          },
          {
            name: 'write_file',
            arguments: {
              path: 'out/report.md',
              content: '# 销售报告\n\n总销售额：100\n'
            }
          }
        ]
      },
      {
        text: '先完成前两步，第三步还需要一次运行。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step, index) => ({
                text: step.text,
                status: index < 2 ? 'completed' : 'pending'
              }))
            }
          }
        ]
      },
      { text: '前两步完成，继续执行第三步。' }
    ]
  })
  const workspace = workspaceAt('e2e-plan-mode')
  const morrow = await launchMorrow({ name: 'plan-mode', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划模式测试'
    })

    // 1) /plan + 任务：先给出提示并保留输入；发送带任务的 /plan 后进入计划模式
    await page.locator('.composer-input').fill('/plan')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('/plan ')
    expect(await getPlanMode(page)).toBe(false)
    await page.locator('.composer-input').fill('/plan 帮我整理这个季度的销售数据并生成报告')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => getPlanMode(page), 30_000, '进入计划模式')
    await waitUntil(async () => {
      const plan = await getPlan(page)
      return plan?.status === 'pending' ? plan : null
    }, 60_000, '生成待批准计划')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '计划生成运行结束')

    const planCard = page.locator('.plan-card')
    await expect(planCard).toBeVisible()
    await expect(planCard).toContainText('整理销售数据并生成报告')
    await expect(planCard).toContainText('读取 in/sales.csv')
    await expect(page.locator('[aria-label="退出计划模式"]')).toBeVisible()
    expect(existsSync(join(workspace, 'out', 'report.md'))).toBe(false)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('plan-card-pending-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('plan-card-pending-light.png') })
    await setThemeViaStore(page, 'dark')

    // 2) 拒绝并留下原因
    await planCard.getByRole('button', { name: '拒绝' }).click()
    await planCard.locator('.plan-card-input').fill('先不要直接生成 HTML，先给 Markdown 摘要。')
    await planCard.getByRole('button', { name: '确认拒绝' }).click()
    await waitUntil(async () => (await getPlan(page))?.status === 'rejected', 15_000, '计划被拒绝')
    await expect(planCard).toContainText('你的反馈：先不要直接生成 HTML')
    expect(await getPlanMode(page)).toBe(true)

    // 3) 重新规划：带修改意见启动一轮，收到修订版计划
    await planCard.getByRole('button', { name: '重新规划' }).click()
    await planCard.locator('.plan-card-input').fill('改成先输出 Markdown 摘要，再生成完整报告。')
    await planCard.getByRole('button', { name: '重新规划' }).click()
    await waitUntil(async () => {
      const plan = await getPlan(page)
      return plan?.status === 'pending' && plan.title === planV2.title ? plan : null
    }, 60_000, '生成修订版计划')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '修订运行结束')
    await expect(planCard).toContainText('先出 Markdown 摘要')

    // 4) 只读权限下批准应被明确拦下，计划保持待批准
    await page.evaluate(async (id) => {
      await window.morrow.session.setPermissionMode(id, 'read-only')
    }, sessionId)
    await planCard.getByRole('button', { name: '执行计划' }).click()
    await expect(page.getByText(/当前权限是「只读」/)).toBeVisible()
    expect((await getPlan(page))?.status).toBe('pending')
    expect(await getPlanMode(page)).toBe(true)
    await page.evaluate(async (id) => {
      await window.morrow.session.setPermissionMode(id, 'auto')
    }, sessionId)

    // 5) 批准：自动切执行，写入 todo + 产物；子集完成不能把计划判为完成
    await planCard.getByRole('button', { name: '执行计划' }).click()
    await waitUntil(async () => !(await getPlanMode(page)), 15_000, '批准后退出计划模式')
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.session?.todos.length === planV2.steps.length ? state.session.todos : null
    }, 30_000, '批准后建立 todos')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮执行结束')
    expect((await getPlan(page))?.status).toBe('executing')
    await expect(planCard).toContainText('继续执行')
    expect((await readStore(page)).session?.todos.filter((todo) => todo.status === 'completed')).toHaveLength(2)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.screenshot({ path: screenshotPath('plan-card-incomplete-dark.png') })

    const planRequestNames = (
      (mock.requests[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name)
    const executionRequestNames = (
      (mock.requests[4].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name)

    // 手动「继续执行」：重新提供完成剩余步骤的剧本（第一轮结束时的 todo 对账已用尽原剧本）。
    mock.reset([
      {
        text: '继续执行最后一步。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step) => ({ text: step.text, status: 'completed' }))
            }
          }
        ]
      },
      { text: '执行完成，产物在 out/report.md。' }
    ])
    await planCard.getByRole('button', { name: '继续执行' }).click()
    await waitUntil(async () => (await getPlan(page))?.status === 'completed', 60_000, '继续执行后计划完成')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '执行运行结束')

    expect(existsSync(join(workspace, 'out', 'report.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'out', 'report.md'), 'utf8')).toContain('销售报告')
    const finalTodos = (await readStore(page)).session?.todos ?? []
    expect(finalTodos).toHaveLength(planV2.steps.length)
    expect(finalTodos.every((todo) => todo.status === 'completed')).toBe(true)
    await expect(planCard).toContainText('已完成')
    await page.screenshot({ path: screenshotPath('plan-card-complete-dark.png') })

    // 6) 持久化：重新加载会话后计划与状态仍在
    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.plan?.status).toBe('completed')
    expect(loaded?.plan?.title).toBe(planV2.title)
    expect(loaded?.planMode === true).toBe(false)

    // 模型请求：计划请求只暴露只读/计划工具，执行请求恢复写入工具
    expect(planRequestNames).toContain('submit_plan')
    expect(planRequestNames).not.toContain('write_file')
    expect(executionRequestNames).toContain('write_file')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：plan-tray.spec.ts ──────────────────────────────────────────────
test.describe('plan-tray.spec.ts', () => {
/**
 * 计划托盘：运行中显示脉冲与「进行中」，运行结束后未完成步骤保留状态但停止脉冲。
 */

const workspace = (): string => {
  const path = join(root, 'tmp', `e2e-plan-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('计划托盘：运行中脉冲，结束后未完成步骤不再闪动', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先把工作拆成两步。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { text: '读取资料', status: 'in_progress' },
                { text: '整理结论', status: 'pending' }
              ]
            }
          }
        ]
      },
      { text: '计划已列好，先读资料。' },
      {
        text: '资料已读完，开始整理结论。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { text: '读取资料', status: 'completed' },
                { text: '整理结论', status: 'in_progress' }
              ]
            }
          }
        ]
      },
      { text: '结论整理中。', delayMs: 8_000 }
    ]
  })
  const morrow = await launchMorrow({ name: 'plan-tray', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sharedWorkspace = workspace()
    const sessionA = await createSession(page, {
      workspace: sharedWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划测试'
    })
    await createSession(page, {
      workspace: sharedWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划旁观 B'
    })
    await page.evaluate(async (id: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().selectSession(id)
    }, sessionA)
    await installEventCollector(page)

    await page.locator('.composer-input').fill('把这件事拆成两步计划。')
    await page.locator('.composer-input').press('Enter')
    await waitForRunFinished(page, 90_000)

    const tray = page.locator('.plan-tray')
    await expect(tray).toBeVisible()
    await expect(tray).toHaveClass(/is-idle/)
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-item.is-in_progress')).toContainText('整理结论')
    await expect(page.locator('.plan-item.is-in_progress .plan-item-state')).toHaveText('未完成')
    await expect(page.locator('.plan-item.is-in_progress .sr-only')).toHaveText('未完成，当前任务已停止')
    const idleAnimation = await page.evaluate(
      () => getComputedStyle(document.querySelector('.plan-item.is-in_progress .plan-dot')!).animationName
    )
    expect(idleAnimation).toBe('none')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('plan-tray-idle-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('plan-tray-idle-dark.png') })

    await clearEvents(page)
    // 第一轮的对账已用尽剧本；第二段重新提供「进行中 + 延迟」剧本，验证运行态与后台切换。
    mock.reset([
      {
        text: '资料已读完，开始整理结论。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { text: '读取资料', status: 'completed' },
                { text: '整理结论', status: 'in_progress' }
              ]
            }
          }
        ]
      },
      { text: '结论整理中。', delayMs: 8_000 }
    ])
    await page.locator('.composer-input').fill('继续。')
    await page.locator('.composer-input').press('Enter')
    await waitForRunStarted(page, 30_000)
    await waitUntil(
      async () => {
        const snapshot = await readStore(page)
        const todos = snapshot.session?.todos ?? []
        return todos.some((todo) => todo.status === 'completed') && todos.some((todo) => todo.status === 'in_progress')
      },
      20_000,
      '第二步计划更新'
    )
    await expect(tray).not.toHaveClass(/is-idle/)
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(page.locator('.sb-session').filter({ hasText: '计划测试' }).locator('.sb-session-time')).toHaveText('1/2')
    await expect(page.locator('.plan-running')).toBeVisible()
    await expect(page.locator('.plan-running')).toHaveText('进行中')
    const runningAnimation = await page.evaluate(
      () => getComputedStyle(document.querySelector('.plan-item.is-in_progress .plan-dot')!).animationName
    )
    expect(runningAnimation).toBe('plan-dot-pulse')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: screenshotPath('plan-tray-running-dark.png') })

    const rowA = page.locator('.sb-session').filter({ hasText: '计划测试' }).locator('.sb-session-main')
    const rowB = page.locator('.sb-session').filter({ hasText: '计划旁观 B' }).locator('.sb-session-main')

    // 运行中切到 B，再切回 A：计划应从增量落盘恢复为 1/2，而不是退回 0/2
    await rowB.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== sessionA, 10_000, '切到会话 B')
    await rowA.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '切回会话 A')
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(tray).not.toHaveClass(/is-idle/)

    // 留在 B 等 A 在后台完成：侧栏进度与当前视图都不应串台
    await rowB.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== sessionA, 10_000, '再次切到会话 B')
    await waitForRunFinished(page, 90_000)
    expect((await readStore(page)).activeSessionId).not.toBe(sessionA)
    await expect(rowA.locator('.sb-session-time')).toHaveText('1/2', { timeout: 10_000 })

    await rowA.click()
    await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '完成后回到会话 A')
    await expect(page.locator('.plan-progress')).toHaveText('1/2')
    await expect(tray).toHaveClass(/is-idle/)
    await expect(page.locator('.plan-item.is-in_progress .plan-item-state')).toHaveText('未完成')
    await expect(page.locator('.plan-running')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r6-goal.spec.ts ──────────────────────────────────────────────
test.describe('r6-goal.spec.ts', () => {
/**
 * R6：Goal 模式（多轮续跑 + update_goal + 暂停/继续/结束）与画布拖动调宽。
 * 运行：npx playwright test tests/e2e/r6-goal.spec.ts
 */

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
    await page.waitForTimeout(900)
    await morrow.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      win.setContentSize(1920, 1080)
      win.center()
    })
    await page.waitForTimeout(500)
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

})
// ── 原文件：r8-mode.spec.ts ──────────────────────────────────────────────
test.describe('r8-mode.spec.ts', () => {
/**
 * R8 #5 显式「聊天 / 工作」模式 E2E —— 真实 Electron + 真实主进程 + 真实工具执行，LLM 用本地 mock。
 *
 * 验收（审计报告第 5 项）：
 * 1. 同一句「帮我改文件」在聊天模式：模型**即使硬发 write_file**也被内核硬拦截（denied）、
 *    文件不变、不弹审批、助手解释/询问是否切换工作模式；下发给模型的工具列表本身不含写入/执行工具。
 * 2. 切到工作模式后同一句：工具真实执行、文件真实写入。
 * 3. 运行中切换模式被拒绝并提示先停止（不会带着工作模式能力继续）。
 * 4. 聊天模式下 Goal 入口在 UI 中不可用，IPC `goal.start` 也被主进程拒绝（不是只隐藏按钮）。
 * 5. 模式写入会话文件，关闭应用后用同一 data-dir 重启仍保持聊天模式。
 *
 * 所有断言都落在四层证据上：运行时事件 / store 状态 / DOM / 磁盘文件。
 */

const WORKSPACE_FILE = 'mode-note.md'
const USER_ASK = '帮我修改 mode-note.md，把内容改成 CHANGED。'

type SessionMode = 'work' | 'chat'

async function sessionMode(page: Page): Promise<SessionMode> {
  return page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const mode = store.getState().session?.mode
    return mode === 'chat' ? 'chat' : 'work'
  })
}

async function waitMode(page: Page, mode: SessionMode, timeoutMs = 20_000): Promise<void> {
  await waitUntil(async () => ((await sessionMode(page)) === mode ? true : null), timeoutMs, `会话模式变为 ${mode}`)
}

/** 注册指向本地 mock 的 provider（test-mode 下 127.0.0.1 允许无 Key） */
async function saveMockProvider(page: Page, baseUrl: string): Promise<{ providerId: string; modelId: string }> {
  return page.evaluate(
    async (url: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const config = {
        id: 'mock-r8-mode',
        kind: 'openai-compat',
        name: '本地 Mock (R8 模式)',
        baseUrl: url,
        models: [{ id: 'mock-model', label: 'Mock Model', contextWindow: 32_000, supportsTools: true }],
        apiKeyStored: false,
        enabled: true
      }
      await store.getState().saveProvider({ config })
      const saved = (store.getState().settings.providers as Array<Record<string, any>>).find(
        (provider) => provider.id === config.id
      )
      if (!saved) throw new Error('mock provider 保存失败')
      return { providerId: config.id, modelId: 'mock-model' }
    },
    baseUrl
  )
}

async function createModeSession(
  page: Page,
  arg: { workspace: string; providerId: string; mode: SessionMode }
): Promise<string> {
  return page.evaluate(async (input: typeof arg) => {
    const created = await window.morrow.session.create({
      workspace: input.workspace,
      model: { providerId: input.providerId, modelId: 'mock-model' },
      permissionMode: 'auto',
      mode: input.mode,
      title: 'R8 模式测试'
    })
    if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().selectSession(created.data.id)
    return created.data.id
  }, arg)
}

test.describe('R8 #5 显式聊天 / 工作模式', () => {
  test('chat 硬拦截写入（文件不变）→ 切 work 真实写入 → 运行中拒绝切换 → Goal 不可用 → 重启保持', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r8-mode-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'hello', 'utf8')
    const dataDir = join(root, 'tmp', `r8-mode-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r8-mode-chromium-${stamp}`)

    // 记录每次请求下发给模型的工具列表：chat 下必须不含写入/执行工具
    const requests: Array<{ toolNames: string[]; lastUserText: string }> = []
    const mock = await startMockLLM({
      respond: (ctx) => {
        const toolNames = ((ctx.body?.tools ?? []) as Array<Record<string, any>>)
          .map((tool) => String(tool?.function?.name ?? tool?.name ?? ''))
          .filter(Boolean)
        requests.push({ toolNames, lastUserText: String(ctx.lastUserMessageText ?? '') })
        const step = requests.length - 1
        if (step === 0) {
          // 聊天模式第一回合：故意硬发 write_file（工具列表里并没有它），验证权限层硬拦截
          return {
            text: '我先看一下这个文件。',
            toolCalls: [{ name: 'write_file', arguments: { path: WORKSPACE_FILE, content: 'CHANGED' } }]
          }
        }
        if (step === 1) {
          return {
            text: '这是聊天模式：我不会直接改文件。需要我动手的话，请把输入框旁的「聊天 / 工作」切到「工作」。'
          }
        }
        if (step === 2) {
          // 工作模式第一回合：写文件（permission=auto，工作区内直接执行）
          return {
            text: '好，我在工作模式里改。',
            toolCalls: [{ name: 'write_file', arguments: { path: WORKSPACE_FILE, content: 'CHANGED' } }]
          }
        }
        // 工作模式第二回合：延迟一下，留出「运行中尝试切换模式」的窗口
        return { text: '文件已写入 mode-note.md。', delayMs: 1500 }
      }
    })

    const first = await launchMorrow({ name: 'r8-mode-1', dataDir, chromiumDir, timeoutMs: 90_000 })
    let sessionId = ''
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      const provider = await saveMockProvider(page, mock.openaiBaseUrl)
      sessionId = await createModeSession(page, { workspace, providerId: provider.providerId, mode: 'chat' })
      expect(await sessionMode(page)).toBe('chat')

      /* ── 1) UI 进入聊天模式：分段控件/只读 chip/placeholder/titlebar chip，Goal 入口隐藏 ── */
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-picker-perm')).toHaveCount(0)
      await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /聊天模式/)
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)

      /* ── 2) Goal 入口不可用：不只是隐藏按钮，IPC 也被主进程拒绝 ── */
      const goalAttempt = await page.evaluate(async (sid: string) => {
        const result = await window.morrow.goal.start({ sessionId: sid, objective: '帮我做一份季度报告' })
        return result.ok ? { ok: true } : { ok: false, message: result.error.message }
      }, sessionId)
      expect(goalAttempt.ok).toBe(false)
      expect(goalAttempt.message).toContain('聊天模式')
      await page.screenshot({ path: screenshotPath('r8-mode-chat-composer.png') })

      /* ── 3) 聊天模式下发同一句改文件请求：工具被硬拦截、文件不变、助手解释 ── */
      await clearEvents(page)
      await sendMessageViaStore(page, USER_ASK)
      await waitForRunStarted(page, 30_000)
      const chatFinished = await waitForRunFinished(page, 60_000)
      expect(chatFinished.reason).toBe('complete')

      const chatEvents = await getEvents(page)
      expect(chatEvents.filter((event) => event.type === 'permission_requested')).toEqual([])
      const chatTools = chatEvents.filter((event) => event.type === 'tool_finished')
      expect(chatTools.length).toBeGreaterThanOrEqual(1)
      for (const event of chatTools) {
        expect(event.denied, `聊天模式工具不应放行：${JSON.stringify(event)}`).toBe(true)
        expect((event.result as { ok?: boolean } | undefined)?.ok).toBe(false)
      }
      expect(existsSync(join(workspace, WORKSPACE_FILE))).toBe(false)
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello')

      // 下发给模型的工具本身就不含写入/执行：不是「工具列表给了、执行才拦」
      expect(requests[0].toolNames).toContain('read_file')
      expect(requests[0].toolNames).toContain('ask_user')
      expect(requests[0].toolNames).not.toContain('write_file')
      expect(requests[0].toolNames).not.toContain('remove_file')
      expect(requests[0].toolNames).not.toContain('run_command')
      expect(requests[0].toolNames).not.toContain('update_goal')
      // 泛化断言：聊天模式工具列表里不允许出现任何写入/执行/记忆/目标/计划/集群成员类工具
      for (const name of requests[0].toolNames) {
        expect(name, `聊天模式不应下发 ${name}`).not.toMatch(
          /^(write_|edit_|run_command|remember$|update_goal$|todo_write$|task$|open_artifact$)/
        )
      }

      // 助手解释或询问是否切到工作模式
      const chatState = await readStore(page)
      const chatText =
        chatState.session?.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text)
          .join('\n') ?? ''
      expect(chatText).toContain('聊天模式')
      expect(chatText).toContain('工作')
      await page.screenshot({ path: screenshotPath('r8-mode-chat-denied.png') })

      /* ── 4) 真实 UI 切到工作模式：权限下拉回来、Goal 入口回来 ── */
      await page.locator('.composer-picker-mode').getByRole('radio', { name: '工作' }).click()
      await waitMode(page, 'work')
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('工作')
      await expect(page.locator('.composer-picker-perm')).toHaveCount(1)
      await expect(page.locator('.composer-perm-lock')).toHaveCount(0)
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(1)

      /* ── 5) 工作模式同一句：真实写入；运行中尝试切 chat 被拒绝 ── */
      await clearEvents(page)
      await sendMessageViaStore(page, USER_ASK)
      await waitForRunStarted(page, 30_000)
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        void store.getState().setSessionMode('chat')
      })
      await waitUntil(
        async () => {
          const state = await readStore(page)
          return state.toast?.kind === 'warning' && /停止|切换/.test(state.toast.message) ? true : null
        },
        15_000,
        '运行中切换模式被拒绝的提示'
      )
      expect(await sessionMode(page)).toBe('work')

      const workFinished = await waitForRunFinished(page, 60_000)
      expect(workFinished.reason).toBe('complete')
      await waitUntil(async () => (existsSync(join(workspace, WORKSPACE_FILE)) ? true : null), 15_000, '工作模式写入文件')
      expect(readFileSync(join(workspace, WORKSPACE_FILE), 'utf8')).toBe('CHANGED')

      const workEvents = await getEvents(page)
      const okTools = workEvents.filter(
        (event) =>
          event.type === 'tool_finished' &&
          (event.result as { ok?: boolean } | undefined)?.ok === true &&
          event.denied !== true
      )
      expect(okTools.length).toBeGreaterThanOrEqual(1)
      expect(requests[2].toolNames).toContain('write_file')
      expect(requests[2].toolNames).toContain('run_command')
      await page.screenshot({ path: screenshotPath('r8-mode-work-write.png') })

      /* ── 6) 切回聊天：模式写入会话文件（重启保持的证据） ── */
      await page.locator('.composer-picker-mode').getByRole('radio', { name: '聊天' }).click()
      await waitMode(page, 'chat')
      const persisted = JSON.parse(readFileSync(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8')) as {
        mode?: string
      }
      expect(persisted.mode).toBe('chat')
    } finally {
      await first.close()
    }

    /* ── 7) 关闭后用同一 data-dir 重启：模式保持聊天，Goal 入口仍不可用 ── */
    const second = await launchMorrow({ name: 'r8-mode-2', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      await waitForStoreReady(page)
      await waitMode(page, 'chat')
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)
      await page.screenshot({ path: screenshotPath('r8-mode-restart-persist.png') })
    } finally {
      await second.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：permission-rules.spec.ts ──────────────────────────────────────────────
test.describe('permission-rules.spec.ts', () => {
/**
 * P1-10 权限规则 E2E：
 * - 设置页添加 run_command 前缀 allow 规则 → 不再弹审批；
 * - deny 规则直接拒绝；
 * - 普通审批记录进入审批日志。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function addRuleViaUi(page: Page, pattern: string, decision: 'allow' | 'deny'): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    store.getState().openSettings()
  })
  await page.getByRole('tab', { name: '权限' }).click()
  await page.locator('.st-rule-pattern').fill(pattern)
  await page.locator('.st-rule-form').getByRole('radio', { name: decision === 'allow' ? '允许' : '拒绝' }).click()
  await page.locator('.st-rule-form').getByRole('button', { name: '添加' }).click()
  await expect(page.locator('.st-perm-rules')).toContainText(pattern)
  await page.getByRole('button', { name: '完成' }).click()
}

function toolStatus(page: Page, commandPart: string): Promise<string | null> {
  return page.evaluate((needle) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const session = store.getState().session
    for (const message of session?.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'run_command' && JSON.stringify(block.input).includes(needle)) {
          return block.status as string
        }
      }
    }
    return null
  }, commandPart)
}

test('工作区权限规则持久化、deny 优先与审批日志', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '执行规则允许的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: "Write-Output 'rule-ok'" } }]
      },
      { text: '规则命令已执行。' },
      {
        text: '尝试被禁止的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: "Write-Output 'rule-blocked'" } }]
      },
      { text: '命令被拒绝。' },
      {
        text: '需要审批的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: 'Remove-Item out -Recurse -Force' } }]
      },
      { text: '审批命令已执行。' }
    ]
  })
  const workspace = workspaceAt('e2e-permission-rules')
  const morrow = await launchMorrow({ name: 'permission-rules', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    // 规则命令用 PowerShell 语法；受限令牌下 Git Bash 可能无法初始化，改用 PowerShell 7 验证权限逻辑。
    await page.evaluate(async () => {
      await window.morrow.settings.update({ terminalShell: 'pwsh' })
    })
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '权限规则测试'
    })

    // allow 规则
    await addRuleViaUi(page, "Write-Output 'rule-ok'", 'allow')
    await page.locator('.composer-input').fill('执行规则命令')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('规则命令已执行。')).toBeVisible({ timeout: 45_000 })
    expect(await toolStatus(page, 'rule-ok')).toBe('success')
    expect((await readStore(page)).pendingPermission).toBeNull()

    // deny 规则
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第一条完成')
    await addRuleViaUi(page, "Write-Output 'rule-blocked'", 'deny')
    await page.locator('.composer-input').fill('尝试被禁止的命令')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('命令被拒绝。')).toBeVisible({ timeout: 45_000 })
    expect(await toolStatus(page, 'rule-blocked')).toBe('denied')

    // 普通审批进入日志
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第二条完成')
    await page.locator('.composer-input').fill('执行需要审批的命令')
    await page.locator('.composer-input').press('Enter')
    await waitForPermission(page, 45_000)
    await clickPermissionCard(page, 'once')
    await expect(page.getByText('审批命令已执行。')).toBeVisible({ timeout: 45_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第三条完成')

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '权限' }).click()
    await expect(page.locator('.st-perm-rules')).toContainText("Write-Output 'rule-ok'")
    await expect(page.locator('.st-perm-rules')).toContainText("Write-Output 'rule-blocked'")
    await expect(page.locator('.st-approval-log')).toContainText('运行命令')
    // 整个工具规则：匹配内容留空也应能保存（此前服务端会拒绝空 pattern）
    const form = page.locator('.st-rule-form')
    await form.getByRole('button', { name: '规则类型', exact: true }).click()
    await page.getByRole('option', { name: '写文件' }).click()
    await form.getByRole('button', { name: '权限规则类型' }).click()
    await page.getByRole('option', { name: '整个工具' }).click()
    await expect(form.locator('.st-rule-pattern')).toBeDisabled()
    await form.getByRole('button', { name: '添加' }).click()
    await expect(page.locator('.st-perm-rules')).toContainText('写文件 · 工具')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    })
    await expect(page.getByText('文件夹权限规则')).toBeVisible()
    await page.mouse.move(4, 4)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('permission-rules-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('permission-rules-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：agent-rules.spec.ts ──────────────────────────────────────────────
test.describe('agent-rules.spec.ts', () => {
/**
 * P1-9 项目规则文件 E2E：
 * - AGENTS.md 注入系统提示；
 * - /init 生成 AGENTS.md；
 * - 设置 → 上下文 可见发现的规则文件。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('规则文件注入、/init 生成与设置页可见', async () => {
  test.setTimeout(180_000)
  const rulesWorkspace = workspaceAt('e2e-rules-inject')
  writeFileSync(join(rulesWorkspace, 'AGENTS.md'), 'RULE-MARKER-7788：所有回答都要提到猕猴桃。\n', 'utf8')
  const initWorkspace = workspaceAt('e2e-rules-init')
  mkdirSync(join(initWorkspace, '.morrow'), { recursive: true })
  writeFileSync(join(initWorkspace, '.morrow', 'AGENTS.md'), 'EXISTING-DOT-RULE\n', 'utf8')

  const mock = await startMockLLM({
    scripts: [
      { text: '收到规则。' },
      {
        text: '工作区很简单，我来写 AGENTS.md。',
        toolCalls: [
          {
            name: 'write_file',
            arguments: {
              path: 'AGENTS.md',
              content: '# AGENTS.md\n\n## 项目概述\nMorrow E2E 测试工作区。\n\n## 常用命令\n- 测试：npm test\n'
            }
          }
        ]
      },
      { text: '已生成 AGENTS.md。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'agent-rules', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: rulesWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '规则注入测试'
    })
    await page.locator('.composer-input').fill('你好')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('收到规则。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '规则运行结束')
    const firstBody = mock.requests[0]?.body as { messages?: Array<{ role: string; content: unknown }> } | undefined
    const systemMessage = firstBody?.messages?.find((message) => message.role === 'system')
    expect(JSON.stringify(systemMessage)).toContain('RULE-MARKER-7788')
    expect(JSON.stringify(firstBody)).toContain('项目规则文件')
    expect(JSON.stringify(firstBody?.messages?.find((message) => message.role === 'user'))).not.toContain('RULE-MARKER-7788')

    // /init 生成 AGENTS.md
    await createSession(page, {
      workspace: initWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '初始化规则测试'
    })
    await page.locator('.composer-input').fill('/init')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '/init 运行结束')
    await waitUntil(async () => existsSync(join(initWorkspace, 'AGENTS.md')), 30_000, 'AGENTS.md 生成')
    expect(readFileSync(join(initWorkspace, 'AGENTS.md'), 'utf8')).toContain('项目概述')
    // /init 会先发现已有规则文件（含 .morrow），并要求模型在现有文件上更新
    const initBodies = mock.requests.slice(2).map((request) => JSON.stringify(request.body))
    expect(initBodies.some((body) => body.includes('先读取这些文件') && body.includes('.morrow'))).toBe(true)
    expect(initBodies.some((body) => body.includes('EXISTING-DOT-RULE'))).toBe(true)

    // 设置 → 上下文：规则可见
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '上下文' }).click()
    await expect(page.locator('.st-rules-list')).toContainText('AGENTS.md')
    await expect(page.locator('.st-rules-list')).toContainText('.morrow')
    await expect(page.locator('.st-rules-budget')).toContainText('已使用')
    await page.locator('.st-rules-head').getByRole('button', { name: '刷新' }).click()
    await expect(page.locator('.st-rules-list')).toContainText('AGENTS.md')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.getByText('项目规则文件', { exact: true }).scrollIntoViewIfNeeded()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('agent-rules-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('agent-rules-settings-light.png') })
    await page.getByRole('button', { name: '完成' }).click()

    // 只读模式下 /init 应直接拦下，不发送请求
    const guardWorkspace = workspaceAt('e2e-rules-guard')
    await createSession(page, {
      workspace: guardWorkspace,
      ...provider,
      permissionMode: 'read-only',
      title: '只读规则测试'
    })
    const requestsBefore = mock.requests.length
    await page.locator('.composer-input').fill('/init')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/只读模式不能写文件/)).toBeVisible()
    await page.waitForTimeout(400)
    expect(mock.requests.length).toBe(requestsBefore)
    expect(existsSync(join(guardWorkspace, 'AGENTS.md'))).toBe(false)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
})


test.describe("08-settings", () => {
// ── 原文件：b6-settings.spec.ts ──────────────────────────────────────────────
test.describe('b6-settings.spec.ts', () => {
/**
 * B6 设置与状态：自动命名开关、模型 Key 状态、提供方链接、打开目录错误。
 */

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
    // R12 删除无交互的隐私区块；R20 起快捷键独立成页，关于页不再重复展示
    await expect(settings.locator('.st-about-privacy')).toHaveCount(0)
    await expect(settings.locator('.st-about-shortcuts')).toHaveCount(0)
    await expect(settings.getByRole('tab', { name: '快捷键' })).toBeVisible()
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

})
// ── 原文件：settings-archive.spec.ts ──────────────────────────────────────────────
test.describe('settings-archive.spec.ts', () => {
/**
 * 对话归档管理：归档后只在 设置 → 归档 中出现，可恢复、可永久删除；
 * 关于页不再承载「清除全部对话」。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('设置中的对话归档：归档、恢复与永久删除', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [{ text: '甲的归档前回答。' }, { text: '乙的归档前回答。' }]
  })
  const workspace = workspaceAt('e2e-settings-archive')
  const morrow = await launchMorrow({ name: 'settings-archive', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)

    const finishedRuns = async (): Promise<number> =>
      (await getEvents(page)).filter((event) => event.type === 'run_finished').length
    const waitForNextFinish = async (before: number, label: string): Promise<void> =>
      waitUntil(async () => (await finishedRuns()) > before, 30_000, label)

    let finished = await finishedRuns()
    const firstId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '归档测试甲'
    })
    await sendMessageViaStore(page, '甲的问题')
    await waitForNextFinish(finished, '甲回答完成')

    finished = await finishedRuns()
    const secondId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '归档测试乙'
    })
    await sendMessageViaStore(page, '乙的问题')
    await waitForNextFinish(finished, '乙回答完成')

    await page.evaluate(async (ids: string[]) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setSessionArchived: (id: string, value: boolean) => Promise<void> } }
      }).__morrowStore
      for (const id of ids) await store.getState().setSessionArchived(id, true)
    }, [firstId, secondId])
    await waitUntil(async () => {
      const state = await readStore(page)
      return [firstId, secondId].every(
        (id) => state.sessions.find((session) => session.id === id)?.archived === true
      )
    }, 15_000, '两个对话已归档')
    await expect(page.getByText('归档测试甲', { exact: true })).toHaveCount(0)
    await expect(page.getByText('归档测试乙', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sb-group.is-archived')).toHaveCount(0)

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    const archive = page.locator('.st-archive')
    await expect(archive).toContainText('已归档 2 个对话')
    const firstRow = archive.locator('.st-archive-row').filter({ hasText: '归档测试甲' })
    const secondRow = archive.locator('.st-archive-row').filter({ hasText: '归档测试乙' })
    await expect(firstRow).toBeVisible()
    await expect(secondRow).toBeVisible()
    await expect(firstRow).toContainText('2 条消息')
    await expect(secondRow).toContainText('2 条消息')
    await expect(page.locator('#st-tab-archive')).toHaveAttribute('aria-selected', 'true')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-archive-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('settings-archive-light.png') })
    await setThemeViaStore(page, 'dark')

    await firstRow.getByRole('button', { name: '恢复' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === firstId)?.archived === false
    }, 15_000, '甲已恢复')
    await expect(firstRow).toHaveCount(0)
    await expect(archive).toContainText('已归档 1 个对话')

    await secondRow.getByRole('button', { name: '删除归档对话「归档测试乙」' }).click()
    const dialog = page.getByRole('dialog', { name: '删除归档对话？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('归档测试乙')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-archive-delete.png') })
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return !state.sessions.some((session) => session.id === secondId)
    }, 20_000, '乙已删除')
    expect(existsSync(join(morrow.dataDir, 'sessions', `${secondId}.json`))).toBe(false)
    await expect(archive).toContainText('还没有归档的对话')

    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText('归档测试甲', { exact: true })).toBeVisible()
    await expect(page.getByText('归档测试乙', { exact: true })).toHaveCount(0)

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-about').click()
    await expect(page.locator('.st-about')).not.toContainText('清除全部对话')
    await page.locator('#st-tab-archive').click()
    await expect(page.locator('.st-archive .st-danger-zone')).toContainText('清除全部对话')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：settings-onboarding.spec.ts ──────────────────────────────────────────────
test.describe('settings-onboarding.spec.ts', () => {
/**
 * 设置与首次引导回归：
 * - 引导是真正的模态层：焦点陷阱、全局快捷键不穿透；
 * - 切换服务商清空上一家输入的 Key；
 * - 最近工作区失效时明确报错，不假装已选中；
 * - 设置页检测到未保存的 Base URL 时，先提示保存再同步。
 */

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
    await expect(page.getByText('还没保存的服务地址')).toBeVisible()

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

})
// ── 原文件：data-dir-settings.spec.ts ──────────────────────────────────────────────
test.describe('data-dir-settings.spec.ts', () => {
/**
 * 数据目录自定义：真实走主进程选目录 → 迁移 → 写指针 → 恢复默认。
 * 测试用 MORROW_DATA_LOCATION_FILE 把指针放到项目 tmp/，避免碰真实用户配置；
 * 测试模式不重启应用，因此可以直接断言指针与迁移结果。
 */

test.describe('数据目录设置', () => {
  let morrow: MorrowApp | null = null
  let target = ''
  let pointer = ''

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    if (target) rmSync(target, { recursive: true, force: true })
    if (pointer) rmSync(pointer, { force: true })
  })

  test('更改目录会迁移数据并写入指针；恢复默认会移除指针', async () => {
    test.setTimeout(120_000)
    mkdirSync(join(root, 'tmp'), { recursive: true })
    target = mkdtempSync(join(root, 'tmp', 'data-dir-target-'))
    pointer = join(root, 'tmp', `data-location-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)

    morrow = await launchMorrow({
      name: 'data-dir-settings',
      timeoutMs: 90_000,
      env: {
        MORROW_ALLOW_DATA_DIR_CHANGE: '1',
        MORROW_DATA_LOCATION_FILE: pointer
      }
    })
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 主进程原生对话框在测试中替换为固定返回值：选择 target，并选择「迁移并重启」
    await app.evaluate(async ({ dialog }, selected) => {
      const patched = dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>
        showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>
      }
      patched.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      patched.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }, target)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    const change = settings.getByRole('button', { name: '更改目录' })
    await expect(change).toBeEnabled({ timeout: 10_000 })
    await change.click()
    await expect(page.getByText(/数据目录已保存，重启后生效/)).toBeVisible({ timeout: 20_000 })

    expect(existsSync(pointer)).toBe(true)
    const saved = JSON.parse(readFileSync(pointer, 'utf8')) as { dataDir: string }
    expect(saved.dataDir).toBe(resolve(target))
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(join(target, 'sessions'))).toBe(true)
    expect(existsSync(join(target, 'Cache'))).toBe(false)

    const reset = await page.evaluate(() => window.morrow.app.resetDataDir())
    expect(reset.ok).toBe(true)
    expect(existsSync(pointer)).toBe(false)
  })
})

})
// ── 原文件：a7-answer-style.spec.ts ──────────────────────────────────────────────
test.describe('a7-answer-style.spec.ts', () => {
/**
 * A7：全局回答风格。
 * - 设置里的选择写入真实设置，并进入所有新回答的 system prompt；
 * - 侧边聊天同样遵守；
 * - 自定义偏好可保存、重置。
 */

function systemText(body: Record<string, any> | undefined): string {
  if (!body) return ''
  if (typeof body.system === 'string') return body.system
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message: { role?: string }) => message.role === 'system')
    .map((message: { content?: unknown }) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
}

test.describe('全局回答风格', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('预设与自定义风格进入主对话和侧边聊天，并可恢复默认', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      respond: (ctx: { body?: unknown }) => {
        const raw = JSON.stringify(ctx.body ?? {})
        if (raw.includes('侧边聊天')) return { text: '侧边风格答复。', chunkDelayMs: 3 }
        return { text: '主对话风格答复。', chunkDelayMs: 3 }
      }
    })
    const workspace = join(root, 'tmp', `e2e-a7-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'a7-answer-style', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '回答风格测试'
    })

    const openStyleTab = async (): Promise<void> => {
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openSettings()
      })
      await page.locator('#st-tab-style').click()
      await expect(page.getByRole('radiogroup', { name: '全局回答风格' }).getByRole('radio')).toHaveCount(5)
    }
    const closeSettings = async (): Promise<void> => {
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .closeSettings()
      })
      await expect(page.locator('.st-style')).toBeHidden()
    }
    const sendAndWait = async (text: string, expectedMessages: number): Promise<void> => {
      await page.locator('.composer-input').fill(text)
      await page.locator('.composer-input').press('Enter')
      await waitUntil(
        async () => (await readStore(page)).run === null && (await readStore(page)).session?.messages.length === expectedMessages,
        60_000,
        `第 ${expectedMessages / 2} 轮回答完成`
      )
    }

    // 1. 选择「简洁」
    await openStyleTab()
    const styleGroup = page.getByRole('radiogroup', { name: '全局回答风格' })
    await styleGroup.getByRole('radio', { name: '简洁', exact: true }).click()
    await expect(styleGroup.getByRole('radio', { name: '简洁', exact: true })).toHaveAttribute('aria-checked', 'true')
    const conciseSettings = await page.evaluate(async () => window.morrow.settings.get())
    expect(conciseSettings.ok).toBe(true)
    if (conciseSettings.ok) expect(conciseSettings.data.answerStyle).toBe('concise')
    await closeSettings()
    await sendAndWait('第一问：先给结论。', 2)

    // 2. 选择自定义并保存偏好
    await openStyleTab()
    await styleGroup.getByRole('radio', { name: '自定义', exact: true }).click()
    const customText = '像给同事讲方案：先给结论，再列两条依据；不要客套话。'
    await page.locator('#st-answer-style-custom').fill(customText)
    await page.getByRole('button', { name: '保存偏好' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'custom' && result.data.answerStyleCustom === customText
    }, 15_000, '自定义风格保存')
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a7-answer-style.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a7-answer-style-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await closeSettings()
    await sendAndWait('第二问：按自定义风格回答。', 4)

    // 3. 侧边聊天也使用自定义风格
    await page.locator('.composer-input').fill('/btw 用一句话总结这个项目')
    await page.locator('.composer-input').press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('侧边风格答复。')).toBeVisible({ timeout: 30_000 })

    const requestFor = (needle: string): Record<string, any> | undefined =>
      mock.requests.find((request: { body?: unknown }) => JSON.stringify(request.body ?? {}).includes(needle))?.body
    const firstMain = systemText(requestFor('第一问：先给结论。'))
    const secondMain = systemText(requestFor('第二问：按自定义风格回答。'))
    const side = systemText(requestFor('侧边聊天'))
    expect(firstMain).toContain('当前风格：简洁')
    expect(firstMain).toContain('1–3 句')
    expect(secondMain).toContain('当前风格：自定义')
    expect(secondMain).toContain(customText)
    expect(side).toContain('当前风格：自定义')
    expect(side).toContain(customText)

    // 4. 清空自定义偏好仍可保存：留空时回落到平衡规则
    await drawer.getByRole('button', { name: '关闭侧边聊天' }).click()
    await openStyleTab()
    const customField = page.locator('#st-answer-style-custom')
    await expect(customField).toHaveValue(customText)
    await customField.fill('')
    await page.getByRole('button', { name: '保存偏好' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'custom' && result.data.answerStyleCustom === ''
    }, 15_000, '清空自定义偏好')

    // 5. 恢复默认
    await page.getByRole('button', { name: '恢复默认' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'balanced' && result.data.answerStyleCustom === ''
    }, 15_000, '恢复默认风格')
    await expect(page.getByRole('radiogroup', { name: '全局回答风格' }).getByRole('radio', { name: '平衡', exact: true })).toHaveAttribute('aria-checked', 'true')
  })
})

})
// ── 原文件：r13-answer-settings.spec.ts ──────────────────────────────────────────────
test.describe('r13-answer-settings.spec.ts', () => {
/**
 * R13 回答设置：回答风格紧凑化，发送/命名/通知集中到「回答」页。
 */

test('回答页使用紧凑风格选择，并集中运行中发送、发送键、自动命名与完成通知', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r13-answer-settings', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '回答' }).click()

    const style = settings.getByRole('radiogroup', { name: '全局回答风格' })
    await expect(style).toBeVisible()
    await expect(style.getByRole('radio')).toHaveCount(5)
    await expect(settings.locator('.st-style-card')).toHaveCount(0)

    await settings.getByRole('radiogroup', { name: '运行中发送方式' }).getByRole('radio', { name: '插话' }).click()
    await expect(
      settings.getByRole('radiogroup', { name: '运行中发送方式' }).getByRole('radio', { name: '插话' })
    ).toHaveAttribute('aria-checked', 'true')
    await expect(settings.getByRole('radiogroup', { name: '发送键' })).toBeVisible()
    await expect(settings.getByRole('switch', { name: '自动命名对话' })).toBeVisible()
    await expect(settings.getByRole('switch', { name: '任务完成时通知我' })).toBeVisible()

    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('r13-answer-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r13-answer-settings-light.png') })
  } finally {
    await morrow.close()
  }
})

})
test('设置分页直接展示选项，不重复分页标题', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'settings-headings' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })

    const redundant = [
      { tab: '模型', heading: '模型服务' },
      { tab: '联网搜索', heading: '联网搜索' },
      { tab: '归档', heading: '对话归档' },
      { tab: '功能与工具', heading: '功能与工具' },
      { tab: '终端', heading: '终端' },
      { tab: '外观', heading: '外观' }
    ]
    for (const item of redundant) {
      await settings.getByRole('tab', { name: item.tab, exact: true }).click()
      const panel = settings.getByRole('tabpanel')
      await expect(panel.locator('.st-section-title').filter({ hasText: item.heading })).toHaveCount(0)
    }

    await settings.getByRole('tab', { name: '联网搜索', exact: true }).click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('settings-search-no-duplicate-title.png') })
  } finally {
    await morrow.close()
  }
})
// ── 原文件：r20-shortcuts-archive.spec.ts ──────────────────────────────
test.describe("r20-shortcuts-archive.spec.ts", () => {
test('设置中的快捷键页与真实快捷键一致；归档按钮垂直居中', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r20-shortcuts', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // Ctrl+, 打开设置；快捷键已从「关于」移出，成为独立页签。
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible({ timeout: 15_000 })
    const shortcutsTab = settings.getByRole('tab', { name: '快捷键' })
    await shortcutsTab.click()
    await expect(shortcutsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.st-shortcuts')).toBeVisible()
    await expect(page.getByRole('group', { name: '打开命令面板：Ctrl+K' })).toBeVisible()
    await expect(page.getByRole('group', { name: '打开或收起终端：Ctrl+`' })).toBeVisible()
    await expect(page.getByRole('group', { name: '显示或隐藏桌面伙伴：Ctrl+Shift+M' })).toBeVisible()
    await expect(page.getByRole('group', { name: '关闭当前标签页：Ctrl+W' })).toBeVisible()
    await page.mouse.move(2, 2)
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r20-shortcuts-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r20-shortcuts-light.png') })
    await setThemeViaStore(page, 'dark')

    await settings.getByRole('tab', { name: '关于' }).click()
    await expect(page.locator('.st-about-shortcuts')).toHaveCount(0)

    await settings.getByRole('tab', { name: '归档' }).click()
    const clear = page.locator('.st-danger-zone').getByRole('button', { name: '清除全部' })
    await expect(clear).toBeVisible()
    await expect(page.locator('.st-danger-zone')).toHaveCSS('align-items', 'center')
    await page.screenshot({ path: screenshotPath('r20-archive-clear-centered.png') })

    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    // Ctrl+` 真正打开/收起终端，即使在终端获得焦点后也能再次关闭。
    await page.keyboard.press('Control+Backquote')
    await expect(page.locator('.terminal-dock')).toHaveClass(/is-open/)
    await page.keyboard.press('Control+Backquote')
    await expect(page.locator('.terminal-dock')).not.toHaveClass(/is-open/)
  } finally {
    await morrow.close()
  }
})
})
// ── 原文件：24-ui-tokens.spec.ts ──────────────────────────────────────────────
test.describe('UI 设计令牌', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })
})
// ── 原文件：23-settings-titles.spec.ts ────────────────────────────────────────
const TITLES: Record<string, string> = {
  模型: '模型',
  订阅: '模型订阅',
  多媒体: '多媒体',
  联网搜索: '联网搜索',
  上下文: '上下文占用',
  回答: '回答',
  用量: 'Token 活动',
  归档: '归档',
  权限: '权限',
  自动化: '自动化',
  '功能与工具': '功能与工具',
  终端: '终端',
  外观: '外观',
  快捷键: '快捷键',
  关于: '关于'
}
test.describe('设置页标题统一', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })
})
// ── 原文件：22-subscriptions.spec.ts ──────────────────────────────────────────
async function openSubscriptions(page: Page) {
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('tab', { name: '订阅' }).click()
  await expect(settings.locator('.st-subs')).toBeVisible()
  return settings
}
test.describe('订阅设置页', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('独立订阅页展示官方账号与第三方入口', async () => {
    morrow = await launchMorrow({ name: 'subscriptions-ui', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const settings = await openSubscriptions(page)
    await expect(settings.locator('.st-page-title')).toHaveText('模型订阅')
    await expect(settings.locator('.st-subs')).toContainText('ChatGPT / Codex 订阅')
    await expect(settings.locator('.st-subs')).toContainText('Qoder 订阅')
    await expect(settings.locator('.st-subs')).toContainText('第三方 coding plan')
    for (const channel of ['Kimi Code', 'GLM Coding Plan', 'MiniMax Code', 'Step Plan', 'Command Code', 'Cline Pass', 'Google Antigravity', 'OpenCode']) {
      await expect(settings.locator('.st-subs')).toContainText(channel)
    }
    await settings.screenshot({ path: screenshotPath('subscriptions-dark.png') })
    await settings.locator('.st-sub-card', { hasText: 'Kimi Code' }).getByRole('button', { name: '连接账号' }).click()
    await expect(settings.getByLabel('Kimi Code 账号区域')).toBeVisible()
    await settings.getByRole('button', { name: '返回订阅' }).click()
    await settings.locator('.st-sub-card', { hasText: 'Step Plan' }).getByRole('button', { name: '连接账号' }).click()
    await expect(settings.getByLabel('Step API Key')).toBeVisible()
    await expect(settings.getByLabel('Step Plan 账号区域')).toBeVisible()
    await settings.screenshot({ path: screenshotPath('subscriptions-step-dark.png') })
    await settings.getByRole('button', { name: '返回订阅' }).click()
    await settings.locator('.st-sub-card', { hasText: 'OpenCode' }).getByRole('button', { name: '连接账号' }).click()
    await expect(settings.getByLabel('OpenCode Zen API Key')).toBeVisible()
    await expect(settings.getByRole('button', { name: '浏览器登录' })).toHaveCount(0)
    await settings.getByRole('button', { name: '返回订阅' }).click()
    await settings.locator('.st-sub-card', { hasText: 'Command Code' }).getByRole('button', { name: '连接账号' }).click()
    await expect(settings.getByLabel('Command Code API Key')).toBeVisible()
    await expect(settings.getByRole('button', { name: '浏览器登录' })).toBeVisible()
    await settings.screenshot({ path: screenshotPath('subscriptions-command-code-dark.png') })
    await settings.getByRole('button', { name: '返回订阅' }).click()
    await settings.screenshot({ path: screenshotPath('subscriptions-agents-dark.png') })
    await settings.locator('.st-sub-card-qoder').getByRole('button', { name: '连接账号' }).click()
    await expect(settings.locator('.st-subs')).toContainText('导入本机 qodercli')
    await expect(settings.getByLabel('Qoder PAT 区域')).toBeVisible()
    await settings.screenshot({ path: screenshotPath('subscriptions-qoder-dark.png') })
    await settings.getByRole('button', { name: '返回订阅' }).click()
    await settings.getByRole('button', { name: '添加订阅' }).first().click()
    await expect(settings.locator('.st-subs')).toContainText('添加第三方订阅')
    await expect(settings.getByLabel('订阅协议')).toBeVisible()
    await settings.screenshot({ path: screenshotPath('subscriptions-form-dark.png') })
  })

  test('第三方 coding plan：填写兼容接口、token、模型并注册 Provider', async () => {
    const mock = await startMockLLM({ scripts: [{ text: 'OK' }] })
    try {
      morrow = await launchMorrow({ name: 'subscriptions-custom', timeoutMs: 90_000 })
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const settings = await openSubscriptions(page)
      await settings.locator('.st-sub-section').last().getByRole('button', { name: '添加订阅' }).click()
      await settings.getByLabel('订阅名称').fill('Mock Coding Plan')
      await settings.getByLabel('接口地址').fill(mock.openaiBaseUrl)
      await settings.getByLabel('token / API Key').fill('sk-test-subscription')
      await settings.getByLabel('模型 ID（每行一个）').fill('mock-model')
      await settings.getByRole('button', { name: '添加订阅', exact: true }).last().click()
      await expect(settings.locator('.st-subs')).toContainText('Mock Coding Plan')
      const provider = await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        return (store.getState().settings.providers as Array<Record<string, any>>).find((item) => item.name === 'Mock Coding Plan') ?? null
      })
      expect(provider?.kind).toBe('openai-compat')
      expect(provider?.apiKeyStored).toBe(true)
      await settings.getByRole('button', { name: '管理' }).last().click()
      await settings.getByRole('button', { name: '测试连接' }).click()
      await expect(settings.locator('.st-sub-ok')).toContainText('连接', { timeout: 15_000 })
    } finally {
      await morrow?.close()
      await mock.close()
    }
  })

  test('真实 Codex 登录导入、额度与兼容代理', async () => {
    test.skip(process.env.MORROW_SUBSCRIPTION_REAL !== '1', '需要本机 Codex CLI 登录态')
    test.setTimeout(240_000)
    morrow = await launchMorrow({ name: 'subscriptions-real', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const settings = await openSubscriptions(page)
    await settings.locator('.st-sub-card-codex').getByRole('button', { name: '连接账号' }).click()
    await settings.getByRole('button', { name: '导入本机 Codex CLI 登录' }).click()
    await waitUntil(async () => {
      const text = await settings.locator('.st-subs').innerText()
      return text.includes('已连接') && text.includes('订阅额度') ? text : null
    }, 90_000, 'Codex 订阅导入完成')
    await expect(settings.locator('.st-subs')).toContainText('ChatGPT / Codex 订阅')
    const configured = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return (store.getState().settings.providers as Array<Record<string, any>>).find((item) => item.id === 'codex-subscription') ?? null
    })
    expect(configured?.enabled).toBe(true)
    expect(String(configured?.baseUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    const testResult = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const settings = store.getState().settings
      const provider = (settings.providers as Array<Record<string, any>>).find((item) => item.id === 'codex-subscription')
      const modelId = provider?.models?.[0]?.id
      if (!modelId) return { ok: false, message: '没有模型' }
      const result = await window.morrow.settings.testProvider({ providerId: 'codex-subscription', modelId })
      return result.ok ? result.data : { ok: false, message: result.error.message }
    })
    expect(testResult).toMatchObject({ ok: true })
    await settings.screenshot({ path: screenshotPath('subscriptions-codex-detail-dark.png') })
    await settings.getByRole('button', { name: '完成' }).click()

    // 真实 Agent + 工具调用：通过本地兼容代理走 Responses 的工具调用回环
    const workspace = join(root, 'tmp', `subscription-agent-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'sample.txt'), 'MORROW_SUBSCRIPTION_OK', 'utf8')
    await createSession(page, {
      workspace,
      providerId: 'codex-subscription',
      modelId: 'gpt-6-sol',
      permissionMode: 'auto',
      title: 'Codex 订阅 Agent'
    })
    await installEventCollector(page)
    await clearEvents(page)
    await sendMessageViaStore(page, '/no_think 读取 sample.txt 的第一行，并原样告诉我内容；必须使用 read_file 工具。')
    await waitForRunFinished(page, 120_000)
    const blocks = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const messages = store.getState().session?.messages ?? []
      return messages.flatMap((message: Record<string, any>) => message.content ?? [])
    })
    expect(blocks.some((block: Record<string, any>) => block.type === 'tool_use' && block.name === 'read_file' && block.result?.ok === true)).toBe(true)
    expect(blocks.some((block: Record<string, any>) => block.type === 'text' && String(block.text ?? '').includes('MORROW_SUBSCRIPTION_OK'))).toBe(true)
    await page.screenshot({ path: screenshotPath('subscriptions-agent-dark.png') })

    // 重启后从加密凭据恢复本地代理和 Provider
    const dataDir = morrow.dataDir
    const chromiumDir = morrow.chromiumDir
    await morrow.close()
    morrow = await launchMorrow({ name: 'subscriptions-restore', dataDir, chromiumDir, timeoutMs: 90_000 })
    const restoredPage = morrow.page
    await waitForStoreReady(restoredPage)
    await dismissOnboarding(restoredPage)
    const restoredSettings = await openSubscriptions(restoredPage)
    await expect(restoredSettings.locator('.st-subs')).toContainText('已连接', { timeout: 30_000 })
    await expect(restoredSettings.locator('.st-subs')).toContainText('ChatGPT / Codex 订阅')
    const restoredProvider = await restoredPage.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return (store.getState().settings.providers as Array<Record<string, any>>).find((item) => item.id === 'codex-subscription') ?? null
    })
    expect(String(restoredProvider?.baseUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    await restoredSettings.screenshot({ path: screenshotPath('subscriptions-restored-dark.png') })
  })
})
// ── 订阅分页排版统一（ChatGPT/Codex 页为基准） ────────────────────────────────
test.describe('订阅分页排版统一', () => {
})
test.describe('ChatGPT 登录交互', () => {
  test('等待浏览器登录时仍可再次点击，不会卡在禁用状态', async () => {
    test.setTimeout(90_000)
    const morrow = await launchMorrow({ name: 'codex-login-retry', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.getByRole('tab', { name: '订阅', exact: true }).click()
      const card = settings.locator('.st-sub-card').filter({ hasText: 'ChatGPT / Codex 订阅' })
      await card.getByRole('button', { name: /连接账号|管理订阅/ }).click()
      await settings.getByRole('button', { name: /浏览器登录 ChatGPT|重新浏览器登录/ }).click()
      const retry = settings.getByRole('button', { name: '重新打开登录页面' })
      await expect(retry).toBeVisible()
      await expect(retry).toBeEnabled()
      await expect(settings.locator('.st-sub-busy')).toContainText('登录窗口没有出现')
      await settings.getByRole('button', { name: '复制登录链接' }).click()
      await expect
        .poll(() => morrow.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
        .toContain('auth.openai.com')
    } finally {
      await morrow.close()
    }
  })
})
})


test.describe("09-panels", () => {
// ── 原文件：a1-projects-home.spec.ts ──────────────────────────────────────────────
test.describe('a1-projects-home.spec.ts', () => {
/**
 * A1 项目主页与项目内会话（合并进原工作台 ProjectsPanel）：
 * 概览页展示真实项目背景、项目内对话列表；从项目里输入首句会创建带该工作区的会话并注入项目上下文。
 */

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
    await expect(page.locator('.pp-tabs button.is-active')).toHaveCSS('height', '24px')
    await expect(page.locator('.pp-tabs button.is-active')).toHaveCSS('border-radius', '5px')
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

})
// ── 原文件：a2-schedules.spec.ts ──────────────────────────────────────────────
test.describe('a2-schedules.spec.ts', () => {
/**
 * A2 定时任务：
 * 1) 面板创建任务 → 立即运行 → 真实会话/回复/状态回写 → 查看结果 → 暂停/删除；
 * 2) 应用关闭期间到期的任务，在下次启动（1 小时内）自动补跑并回写结果。
 */

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function openSchedulesPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'schedules' } }))
  })
  await expect(page.locator('.sch-root')).toBeVisible({ timeout: 15_000 })
}

test.describe('A2 定时任务', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('创建任务、立即运行、查看结果、暂停与删除', async () => {
    test.setTimeout(180_000)
    mock = await startMockLLM({ scripts: [{ text: '周报已经整理好了：本周完成三件事。' }] })
    morrow = await launchMorrow({ name: 'a2-schedules', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const workspace = makeDir('a2-schedules-ws')
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'A2 定时任务基础会话'
    })

    await openToolPanel(page, '定时任务')
    await expect(page.locator('.sch-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sch-title')).toHaveText('安排一件新事情')
    await page.getByLabel('任务名称').fill('每周项目周报')
    await page.getByLabel('要做什么').fill('整理本周新增的文件与改动，写一份三条以内的周报。')
    await expect(page.getByLabel('任务名称')).toHaveValue('每周项目周报')
    await expect(page.getByLabel('要做什么')).toHaveValue(/整理本周新增/)
    // 默认每天、下一小时执行；工作区自动继承当前会话文件夹
    await expect(page.locator('.sch-workspace-path')).toContainText('a2-schedules-ws')
    await expect(page.locator('.sch-preview').filter({ hasText: '下一次：' })).toBeVisible()
    await page.getByRole('button', { name: '保存定时任务' }).click()
    await expect(page.locator('.sch-notice')).toContainText('定时任务已创建')
    await expect(page.locator('.sch-task')).toContainText('每周项目周报')
    await expect(page.locator('.sch-task')).toContainText('每天')
    const toastClose = page.locator('.toast-close').first()
    if (await toastClose.isVisible().catch(() => false)) await toastClose.click()
    await page.locator('.modal-panel').filter({ has: page.locator('.sch-root') }).screenshot({
      path: screenshotPath('a2-schedules.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.sch-root') }).screenshot({
      path: screenshotPath('a2-schedules-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 立即运行 → Agent 真实回复 → 状态回写
    await installEventCollector(page)
    await page.getByRole('button', { name: '立即运行' }).click()
    await waitForRunFinished(page, 90_000)
    await expect(page.locator('.sch-status')).toContainText('上次成功', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: '查看上次结果' })).toBeVisible()
    const scheduledRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('整理本周新增的文件与改动')
    )
    expect(JSON.stringify(scheduledRequest?.body ?? {})).toContain('## 回答风格（全局偏好）')

    // 任务产生的真实会话
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ title: string; lastStatus: string; lastSessionId?: string; lastRunAt: number }>
    }
    const saved = stored.tasks.find((task) => task.title === '每周项目周报')
    expect(saved?.lastStatus).toBe('success')
    expect(saved?.lastSessionId).toBeTruthy()

    await page.getByRole('button', { name: '查看上次结果' }).click()
    await expect(page.locator('.sch-root')).toHaveCount(0)
    await expect(page.getByText('周报已经整理好了：本周完成三件事。')).toBeVisible({ timeout: 30_000 })

    // 暂停 → 不自动运行；再启用；最后删除
    await openSchedulesPanel(page)
    await page.locator('.sch-task').filter({ hasText: '每周项目周报' }).click()
    const enableSwitch = page.getByRole('switch', { name: '启用自动执行' })
    await expect(enableSwitch).toHaveAttribute('aria-checked', 'true')
    await enableSwitch.click()
    await expect(page.locator('.sch-notice')).toContainText('已暂停')
    await expect(page.locator('.sch-task')).toContainText('暂停')
    await enableSwitch.click()
    await expect(page.locator('.sch-notice')).toContainText('已启用')

    await page.locator('.sch-actions').getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.sch-confirm')).toBeVisible()
    await page.locator('.sch-confirm').getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.sch-notice')).toContainText('已删除')
    await expect(page.locator('.sch-task')).toHaveCount(0)
    const afterDelete = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks: unknown[] }
    expect(afterDelete.tasks).toHaveLength(0)
  })

  test('无人值守运行自动拒绝需要审批的高风险操作，不会挂起等待', async () => {
    test.setTimeout(150_000)
    mock = await startMockLLM({
      scripts: [
        {
          text: '先检查系统状态。',
          toolCalls: [{ name: 'run_command', arguments: { command: 'shutdown /s /t 0' } }]
        },
        { text: '需要授权的操作已自动跳过，检查完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'a2-schedules-unattended', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const workspace = makeDir('a2-unattended-ws')
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'A2 无人值守基础会话'
    })
    const created = await page.evaluate(async (workspacePath: string) => {
      const result = await window.morrow.features.invoke<{ task: { id: string } }>('feature:schedules:create', {
        title: '无人值守安全检查',
        prompt: '检查系统状态并说明结果。',
        schedule: { kind: 'daily', time: '23:59' },
        workspace: workspacePath,
        permissionMode: 'auto',
        enabled: true
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.task
    }, workspace)
    expect(created.id).toBeTruthy()

    await openToolPanel(page, '定时任务')
    await page.locator('.sch-task').filter({ hasText: '无人值守安全检查' }).click()
    await installEventCollector(page)
    await page.getByRole('button', { name: '立即运行' }).click()
    // 若审批没有被自动拒绝，这里会一直等到 30 分钟超时
    await waitForRunFinished(page, 90_000)
    // 运行结束与定时任务状态落盘之间有一个异步窗口；以最终落盘状态为准
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    await waitUntil(
      async () => {
        try {
          const current = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
            tasks: Array<{ id: string; lastStatus: string }>
          }
          return current.tasks.find((item) => item.id === created.id)?.lastStatus === 'success'
        } catch {
          return false
        }
      },
      30_000,
      '定时任务成功状态落盘'
    )
    const store = await readStore(page)
    expect(store.pendingPermission).toBeNull()
    expect(store.runs).toHaveLength(0)
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ id: string; lastStatus: string; lastSessionId?: string }>
    }
    const task = stored.tasks.find((item) => item.id === created.id)
    expect(task?.lastStatus).toBe('success')
    expect(task?.lastSessionId).toBeTruthy()
  })

  test('应用重启后补跑到期任务，并写回成功状态与会话', async () => {
    test.setTimeout(180_000)
    mock = await startMockLLM({ scripts: [{ text: '补跑完成：资料已经看过，没有发现异常。' }] })
    const dataDir = makeDir('a2-catchup-data')
    const workspace = makeDir('a2-catchup-ws')

    morrow = await launchMorrow({ name: 'a2-catchup-1', dataDir, timeoutMs: 90_000 })
    const first = morrow.page
    await waitForStoreReady(first)
    await dismissOnboarding(first)
    const provider = await configureMockProvider(first, mock.openaiBaseUrl)
    await first.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const created = await first.evaluate(async (arg: { workspace: string }) => {
      const result = await window.morrow.features.invoke<{ task: { id: string } }>('feature:schedules:create', {
        title: '重启补跑检查',
        prompt: '检查项目资料里有没有异常。',
        schedule: { kind: 'daily', time: '09:00' },
        workspace: arg.workspace,
        permissionMode: 'read-only',
        enabled: true
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.task
    }, { workspace })
    expect(created?.id).toBeTruthy()
    const tasksFile = join(dataDir, 'schedules', 'tasks.json')
    await morrow.close()
    morrow = undefined as unknown as MorrowApp

    // 模拟「应用关闭时已到期、但还在 1 小时补跑窗口内」
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ nextRunAt: number; lastStatus: string }>
    }
    stored.tasks[0].nextRunAt = Date.now() - 2_000
    stored.tasks[0].lastStatus = 'never'
    writeFileSync(tasksFile, JSON.stringify(stored, null, 2), 'utf8')

    morrow = await launchMorrow({ name: 'a2-catchup-2', dataDir, timeoutMs: 90_000 })
    const second = morrow.page
    await waitForStoreReady(second)
    const session = await waitUntil(async () => {
      const result = await second.evaluate(async () => window.morrow.session.list())
      if (!result.ok) return null
      const target = result.data.find((item) => item.title.startsWith('定时 · 重启补跑检查'))
      return target ?? null
    }, 40_000, '补跑产生定时会话')
    expect(session.title).toContain('重启补跑检查')

    await waitUntil(async () => {
      const current = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
        tasks: Array<{ lastStatus: string; lastSessionId?: string }>
      }
      return current.tasks[0]?.lastStatus === 'success' ? current : null
    }, 40_000, '补跑结果写回成功')
    const loaded = await second.evaluate(async (id: string) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, session.id)
    const text = (loaded?.messages ?? [])
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('\n')
    expect(text).toContain('补跑完成')

    // 面板从磁盘读取也能看到结果
    await openSchedulesPanel(second)
    await expect(page2Task(second, '重启补跑检查')).toBeVisible()
    await expect(second.locator('.sch-status')).toContainText('上次成功')
  })
})

function page2Task(page: import('@playwright/test').Page, title: string) {
  return page.locator('.sch-task').filter({ hasText: title })
}

})
// ── 原文件：a3-connectors-catalog.spec.ts ──────────────────────────────────────────────
test.describe('a3-connectors-catalog.spec.ts', () => {
/**
 * A3 连接器目录与一键安装：
 * 目录展示真实、可核对的连接器；安装真实写 mcp.json，密钥加密且不回显；
 * 本机服务在缺少 Node.js 时明确提示，不伪造成功。
 */

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('A3 连接器目录', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('目录搜索/分类，远程连接器一键安装并加密保存，本机服务显示运行时要求', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a3-connectors-ws')
    morrow = await launchMorrow({ name: 'a3-connectors', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (path: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: path })
    }, workspace)

    await openToolPanel(page, '连接器')
    await expect(page.locator('.conn')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '工具目录' }).click()
    await expect(page.locator('.cd-root')).toBeVisible()
    await expect(page.getByLabel('搜索外部工具目录')).toBeVisible()

    // 目录有官方/本机条目，且本机条目明确标注 Node.js 要求
    await expect(page.locator('.cd-item').first()).toBeVisible({ timeout: 15_000 })
    expect(await page.locator('.cd-item').count()).toBeGreaterThanOrEqual(6)
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toBeVisible()
    await expect(page.locator('.cd-item').filter({ hasText: 'Linear' })).toBeVisible()
    await expect(page.locator('.cd-item').filter({ hasText: '文件系统' })).toContainText('需 Node.js')
    await expect(page.locator('.cd-top')).toContainText('Node.js')

    // 搜索与分类过滤
    await page.getByRole('radio', { name: '本机服务' }).click()
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(page.locator('.cd-item').filter({ hasText: '文件系统' })).toBeVisible()
    await page.getByRole('radio', { name: '全部' }).click()
    await page.getByLabel('搜索外部工具目录').fill('Linear')
    await expect(page.locator('.cd-item')).toHaveCount(1)
    await expect(page.locator('.cd-item').filter({ hasText: 'Linear' })).toBeVisible()
    await page.getByLabel('搜索外部工具目录').fill('')

    // GitHub：需要 Token；只安装不改网络
    await page.locator('.cd-item').filter({ hasText: 'GitHub' }).click()
    await expect(page.getByLabel('GitHub Token')).toBeVisible()
    await expect(page.locator('.cd-actions').getByRole('button', { name: '仅安装' })).toBeDisabled()
    const fakeToken = 'ghp_e2e_catalog_token_1234567890'
    await page.getByLabel('GitHub Token').fill(fakeToken)
    await expect(page.locator('.cd-top')).not.toContainText('检测中', { timeout: 15_000 })
    await page.locator('.modal-panel').filter({ has: page.locator('.cd-root') }).screenshot({
      path: screenshotPath('a3-connector-directory.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.cd-root') }).screenshot({
      path: screenshotPath('a3-connector-directory-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.locator('.cd-actions').getByRole('button', { name: '仅安装' }).click()

    // 安装成功 → 回到已安装详情，真实写盘且密钥不明文
    await expect(page.locator('.cd-root')).toHaveCount(0)
    await expect(page.locator('.conn-item[data-name="github"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.conn-notice')).toContainText('已安装')
    const mcpFile = join(morrow.dataDir, 'mcp.json')
    const secretsFile = join(morrow.dataDir, 'mcp-secrets.json')
    expect(existsSync(mcpFile)).toBe(true)
    const configText = readFileSync(mcpFile, 'utf8')
    expect(configText).toContain('github')
    expect(configText).toContain('MORROW_SECRET')
    expect(configText).not.toContain(fakeToken)
    expect(readFileSync(secretsFile, 'utf8')).not.toContain(fakeToken)

    // 已安装项在目录里可识别，且本机条目有文件夹选择
    await page.getByRole('button', { name: '工具目录' }).click()
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toContainText('已安装')
    await page.locator('.cd-item').filter({ hasText: '文件系统' }).click()
    await expect(page.getByText('允许访问的文件夹')).toBeVisible()
    await expect(page.getByRole('button', { name: '选择文件夹' })).toBeVisible()
    await page.getByRole('button', { name: '返回已安装' }).click()

    // 删除安装项，密钥一并清理
    await page.locator('.conn-item[data-name="github"] .conn-item-main').click()
    await page.locator('.conn-actions').getByRole('button', { name: '删除', exact: true }).click()
    await page.locator('.conn-actions').getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.conn-item[data-name="github"]')).toHaveCount(0, { timeout: 15_000 })
    expect(readFileSync(mcpFile, 'utf8')).not.toContain('github')
  })
})

})
// ── 原文件：a4-research.spec.ts ──────────────────────────────────────────────
test.describe('a4-research.spec.ts', () => {
/**
 * A4 深度研究模式：
 * - 切到研究模式后，真实执行多轮 web_search，来源不足自动续研；
 * - 最终产出带引用的 Markdown 报告（画布成品），进度条如实显示轮次/来源；
 * - 自动续研的内部提示不展示为用户气泡；
 * - 未配置联网搜索时明确拒绝，不伪造研究。
 */

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

    // 输入框只保留聊天/工作；研究工作流通过 /research 调取
    await expect(page.locator('.composer-picker-mode').getByRole('radio')).toHaveCount(2)
    await page.locator('.composer-input').fill('/research quick 研究一下 Morrow 的深度研究能力，并给出可核对的报告。')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-perm-lock.is-research')).toContainText('联网查证')
    await expect(page.locator('.composer-picker-research')).toContainText('研究·快速')

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

  test('关闭联网搜索时拒绝开始深度研究', async () => {
    test.setTimeout(90_000)
    mock = await startMockLLM({ scripts: [{ text: '不应该运行到这里。' }] })
    morrow = await launchMorrow({ name: 'a4-research-no-search', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().saveWebSearch({ enabled: false, provider: 'builtin', maxResults: 3 })
    })
    await createSession(page, {
      workspace: workspaceAt('a4-research-no-search-ws'),
      ...provider,
      permissionMode: 'auto',
      title: '研究缺少联网'
    })
    await page.locator('.composer-input').fill('/research 研究一个需要联网的问题。')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.toast-item.toast-error')).toContainText('配置联网搜索', { timeout: 15_000 })
    const state = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().session?.research ?? null
    })
    expect(state?.status ?? null).not.toBe('searching')
  })
})

})
// ── 原文件：r10-connectors.spec.ts ──────────────────────────────────────────────
test.describe('r10-connectors.spec.ts', () => {
/**
 * R10-G 连接器管理面板 E2E（真实 Electron + 真实主进程 feature IPC + 真实文件/加密）。
 *
 * 无 LLM、不联网、不产生费用：
 * 1. 从设置 → 功能与工具打开连接器面板；
 * 2. 通过面板 UI 添加 Streamable HTTP MCP 连接器（本地 mock server），测试连接 → 工具列表；
 * 3. 保存后验证真实落盘：`<dataDir>/mcp.json` 只有 `$MORROW_SECRET:` 标记，密钥加密文件无明文；
 * 4. 再次测试已保存连接器：解密后的 Authorization 请求头真实发到 mock server；
 * 5. 启停开关、SSRF 拒绝（localhost 未勾选 allowPrivateNetwork）、file:// 协议拒绝、删除清理；
 * 6. catalog 条目名合法、地址与运行时字段完整；截图深色面板。
 */

type InvokeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MockMcpServer {
  url: string
  requests: Array<{ method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }>
  close: () => Promise<void>
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'e2e-mock-http', version: '1.0.0' }
}

const TOOLS_RESULT = {
  tools: [
    {
      name: 'echo',
      description: '原样返回参数（E2E mock）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'list_items', description: '分页清单', inputSchema: { type: 'object', properties: {} } }
  ]
}

/** 本地 Streamable HTTP MCP mock：POST JSON-RPC / JSON 响应 / Mcp-Session-Id */
async function startMockMcp(): Promise<MockMcpServer> {
  const sockets = new Set<Socket>()
  const requests: MockMcpServer['requests'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let message: Record<string, unknown> | null = null
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        message = null
      }
      requests.push({ method: typeof message?.method === 'string' ? message.method : '', headers: req.headers, body: message })
      if (!message) {
        res.writeHead(400)
        res.end()
        return
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id, result }))
      }
      if (message.method === 'initialize') {
        reply(INITIALIZE_RESULT, { 'Mcp-Session-Id': 'e2e-session' })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        reply(TOOLS_RESULT)
        return
      }
      if (message.method === 'resources/list') {
        reply({ resources: [{ uri: 'memo://notes/1', name: 'Notes', mimeType: 'text/plain' }] })
        return
      }
      if (message.method === 'resources/templates/list') {
        reply({ resourceTemplates: [{ uriTemplate: 'memo://notes/{id}', name: 'Note' }] })
        return
      }
      if (message.method === 'resources/read') {
        reply({ contents: [{ uri: 'memo://notes/1', mimeType: 'text/plain', text: '# Note' }] })
        return
      }
      if (message.method === 'prompts/list') {
        reply({ prompts: [{ name: 'summarize', description: '总结主题', arguments: [{ name: 'topic', required: true }] }] })
        return
      }
      if (message.method === 'prompts/get') {
        reply({ messages: [{ role: 'user', content: { type: 'text', text: '请总结：MCP' } }] })
        return
      }
      if (message.method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        reply({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock MCP server 未监听')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

async function invoke<T>(page: MorrowApp['page'], channel: string, payload?: unknown): Promise<InvokeResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      return window.morrow.features.invoke(arg.channel, arg.payload) as Promise<InvokeResult<T>>
    },
    { channel, payload }
  )
}

function readMcpJson(dataDir: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>
  }
}

async function openConnectorsPanel(morrow: MorrowApp): Promise<void> {
  const { page } = morrow
  await dismissOnboarding(page)
  await waitForStoreReady(page)
  await openToolPanel(page, '连接器')
  await expect(page.getByTestId('connectors-panel')).toBeVisible({ timeout: 15_000 })
  // 外层模态不滚动；左右两栏各自在面板内部滚动
  const bodyOverflow = await page
    .getByRole('dialog', { name: '外部工具（MCP）' })
    .evaluate((panel) => {
      const body = panel.querySelector<HTMLElement>('.modal-body')
      return body ? body.scrollHeight - body.clientHeight : null
    })
  expect(bodyOverflow).not.toBeNull()
  expect(bodyOverflow!).toBeLessThanOrEqual(1)
  const pathFits = await page.locator('.conn-path').evaluate((element) => {
    return element.clientHeight > 0 && element.scrollHeight <= element.clientHeight + 1
  })
  expect(pathFits).toBe(true)
}

test.describe('R10-G 连接器管理面板', () => {
  let morrow: MorrowApp | null = null
  let mock: MockMcpServer | null = null

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    await mock?.close()
    mock = null
  })

  test('HTTP 连接器：测试连接 → 保存（密钥加密）→ 再测（解密发请求）→ 启停 → SSRF/文件协议拒绝 → 删除', async () => {
    mock = await startMockMcp()
    morrow = await launchMorrow({ name: 'r10-connectors', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    // feature IPC 已注册：目录条目名称合法、远程/本机字段完整
    const catalog = await invoke<{ entries: Array<{ name: string; transport: string; requiresNpx: boolean; docsUrl: string }> }>(
      page,
      'feature:connectors:catalog',
      {}
    )
    expect(catalog.ok).toBe(true)
    if (catalog.ok) {
      expect(catalog.data.entries.length).toBeGreaterThanOrEqual(8)
      expect(catalog.data.entries.every((entry) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name))).toBe(true)
      expect(catalog.data.entries.every((entry) => entry.docsUrl.startsWith('https://'))).toBe(true)
    }

    // ── 1) 添加 HTTP 连接器（未勾选允许本机 → 先看 SSRF 拒绝）
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill(mock.url)

    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-error')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-reason')).toHaveText('ssrf-blocked')
    await expect(page.locator('.conn-test-error')).toContainText('允许访问本机/内网地址')

    // 勾选显式允许本机地址后测试成功
    await page.getByRole('switch', { name: '允许访问本机/内网地址' }).click()
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-ok')).toContainText('连接成功')
    await expect(page.locator('.conn-test-ok')).toContainText('echo')
    await expect(page.locator('.conn-test-ok')).toContainText('list_items')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个资源')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个提示词')
    await expect(page.locator('.conn-catalog').filter({ hasText: 'memo://notes/1' })).toBeVisible()
    await expect(page.locator('.conn-catalog').filter({ hasText: 'summarize' })).toBeVisible()

    // ── 2) 加一个鉴权请求头（密钥只写不读）
    await page.locator('.conn-secrets').getByRole('button', { name: '添加' }).click()
    await page.getByLabel('请求头 headers键名').fill('Authorization')
    await page.getByLabel('请求头 headers值').fill('Bearer e2e-secret-token')

    // OAuth 端点保存后由后端加密保管令牌；这里验证 UI 字段与配置落盘
    await page.getByLabel('授权地址').fill('https://auth.example.com/oauth/authorize')
    await page.getByLabel('令牌地址').fill('https://auth.example.com/oauth/token')
    await page.getByLabel('Client ID').fill('e2e-client')
    await page.getByLabel('Scope（空格分隔）').fill('read write')
    await page.getByLabel('授权地址').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('mcp-oauth-dark.png') })

    // ── 3) 保存并验证真实落盘（加密标记，无明文）
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toBeVisible({ timeout: 15_000 })
    const config = readMcpJson(dataDir)
    const saved = config.mcpServers['e2e-http']
    expect(saved).toBeTruthy()
    expect(saved.transport).toBe('http')
    expect(saved.url).toBe(mock.url)
    expect(saved.oauth).toMatchObject({
      authorizationUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'e2e-client',
      scopes: ['read', 'write']
    })
    await expect(page.locator('.conn-oauth-status')).toContainText('未授权', { timeout: 10_000 })
    const headers = saved.headers as Record<string, string>
    expect(headers.Authorization.startsWith('$MORROW_SECRET:')).toBe(true)
    const rawConfigText = readFileSync(join(dataDir, 'mcp.json'), 'utf8')
    expect(rawConfigText).not.toContain('e2e-secret-token')
    expect(existsSync(join(dataDir, 'mcp-secrets.json'))).toBe(true)
    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('e2e-secret-token')

    // 列表视图只显示掩码，渲染层拿不到明文
    const list = await invoke<{ connectors: Array<{ name: string; headers: Array<{ masked: string; hasSecret: boolean }> }> }>(
      page,
      'feature:connectors:list',
      { scope: 'user' }
    )
    expect(list.ok).toBe(true)
    if (list.ok) {
      const view = list.data.connectors.find((item) => item.name === 'e2e-http')
      expect(view?.headers[0]).toMatchObject({ masked: '••••••••', hasSecret: true })
      expect(JSON.stringify(list.data)).not.toContain('e2e-secret-token')
    }

    // ── 4) 再测已保存连接器：主进程解密密钥，Authorization 真实到达 mock server
    mock.requests.length = 0
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    const toolsListRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(toolsListRequest?.headers.authorization).toBe('Bearer e2e-secret-token')
    expect(toolsListRequest?.headers['mcp-session-id']).toBe('e2e-session')

    // 截图证据 2：工具列表与测试结果（滚到编辑区底部）
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r10-connectors-tools.png') })

    // 截图证据 1（面板 + 已保存连接器）：把编辑区滚回顶部，保证截图完整
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-connectors-panel.png') })

    // ── 4.1) 同名新建被拒绝：不得覆盖已有连接器或其密钥
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('https://evil.example.com/mcp')
    await page.getByRole('button', { name: '保存' }).click()
    const duplicateAlert = page.getByRole('alert').filter({ hasText: '操作失败' })
    await expect(duplicateAlert).toBeVisible({ timeout: 10_000 })
    await expect(duplicateAlert).toContainText('已被另一个外部工具使用')
    const duplicateConfig = readMcpJson(dataDir).mcpServers['e2e-http']
    expect(duplicateConfig?.url).toBe(mock.url)
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-dark.png') })
    await page.getByRole('button', { name: '取消' }).click()

    // ── 5) 启停开关真实写盘
    const item = page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBe(true)
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBeUndefined()

    // ── 6) file:// 协议被配置校验拒绝
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-bad-url')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('file:///C:/Windows/win.ini')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toContainText('只允许 http://')
    await page.getByRole('button', { name: '取消' }).click()

    // ── 7) 删除连接器：列表与磁盘都清理
    await page.getByTestId('connector-item').filter({ hasText: 'e2e-http' }).locator('.conn-item-main').click()
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http'] ?? null, { timeout: 10_000 })
      .toBeNull()
    const secretsAfterDelete = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')) as {
      entries: Record<string, string>
    }
    expect(Object.keys(secretsAfterDelete.entries).filter((key) => key.includes('e2e-http'))).toHaveLength(0)
  })

  test('工作区级配置：未打开工作区时明确提示，且不写入 .morrow', async () => {
    morrow = await launchMorrow({ name: 'r10-connectors-ws', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    await page.getByRole('radio', { name: '当前文件夹' }).click()
    await expect(page.getByTestId('connectors-panel')).toContainText('需要先选择一个文件夹')

    // 用户级配置路径可见；工作区级路径不存在
    const paths = await invoke<{ userConfigPath: string; workspaceConfigPath: string | null }>(page, 'feature:connectors:paths', {})
    expect(paths.ok).toBe(true)
    if (paths.ok) {
      expect(paths.data.userConfigPath.startsWith(dataDir)).toBe(true)
      expect(paths.data.workspaceConfigPath).toBeNull()
    }

    // 切换回用户级仍可用
    await page.getByRole('radio', { name: '所有对话' }).click()
    await expect(page.getByRole('button', { name: '添加外部工具' })).toBeVisible()
  })
})

})
// ── 原文件：r10-memory-projects.spec.ts ──────────────────────────────────────────────
test.describe('r10-memory-projects.spec.ts', () => {
/**
 * R10-D/E 记忆中心 + Projects E2E —— 真实 Electron（真实 preload → feature IPC → 主进程服务 → 磁盘）。
 *
 * 覆盖：
 * 1. 旧 `.morrow/MEMORY.md` 在真实应用里自动迁移（幂等），项目/全局记忆 CRUD、启停过滤、搜索、导出、
 *    注入预览（只含启用条目 + token 预算）全部通过 `window.morrow.features.invoke('feature:memory:*')` 验证；
 * 2. 项目 CRUD/指令/知识文件、工作区边界（越界路径被真实主进程拒绝）、上下文生成（指令+知识+记忆）与跨项目隔离；
 * 3. 关闭应用后用同一 `--data-dir` 重启：记忆与项目仍在（会话文件与项目 JSON 落盘）。
 *
 * 不依赖面板挂载（Lead 在 App 里挂载后，可由 r10 验收补 UI 截图）；本 spec 验证的是产品真实数据链路。
 */

type FeatureResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MemoryEntryWire {
  id: string
  text: string
  tags: string[]
  source: string
  enabled: boolean
  scope: string
  workspace: string | null
}

interface MemoryListWire {
  entries: MemoryEntryWire[]
  stats: {
    total: number
    enabled: number
    disabled: number
    enabledTokens: number
    limitTokens: number
    migratedTotal: number
    legacyFileDetected: boolean
  }
}

interface MemoryInjectionWire {
  text: string
  usedTokens: number
  limitTokens: number
  included: number
  omitted: number
}

interface ProjectRecordWire {
  id: string
  workspace: string
  name: string
  instructions: string
  knowledgePaths: string[]
  active: boolean
  pinned: boolean
}

interface ProjectListWire {
  projects: Array<ProjectRecordWire & { workspaceExists: boolean; knowledgeCount: number }>
}

interface ProjectContextWire {
  text: string
  projectText: string
  memoryText: string
  knowledge: Array<{ path: string; excerpt?: string }>
  staleKnowledge: Array<{ path: string; error: string }>
  memory: { included: number } | null
  usedTokens: number
  limitTokens: number
  truncated: boolean
}

interface FeatureInvoker {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<FeatureResult<T>>
}

async function feature<T = unknown>(
  page: import('@playwright/test').Page,
  channel: string,
  payload?: unknown
): Promise<T> {
  const result = await page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: FeatureInvoker } }).morrow.features
      return api.invoke<T>(arg.channel, arg.payload)
    },
    { channel, payload }
  )
  if (!result.ok) throw new Error(`${channel} 失败：${result.error.code} ${result.error.message}`)
  return result.data
}

async function featureRaw<T = unknown>(
  page: import('@playwright/test').Page,
  channel: string,
  payload?: unknown
): Promise<FeatureResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: FeatureInvoker } }).morrow.features
      return api.invoke<T>(arg.channel, arg.payload)
    },
    { channel, payload }
  )
}

function seedLegacyMemory(workspace: string): void {
  const dir = join(workspace, '.morrow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'MEMORY.md'),
    [
      '# Morrow 项目记忆',
      '',
      '> 由 Morrow 自动记录，下次对话会作为背景知识注入。',
      '',
      '- [2026-10-01] E2E 迁移记忆：周报按季度口径汇总',
      '- [2026-10-02] E2E 迁移记忆：金额保留两位小数'
    ].join('\n'),
    'utf8'
  )
}

/** 通过工作台事件直接打开面板（与 TitleBar 扳手菜单等效，均为 Lead 挂载的真实组件） */
async function openWorkbenchPanel(
  page: import('@playwright/test').Page,
  panel: 'memory' | 'projects'
): Promise<void> {
  await page.evaluate((name: string) => {
    window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: name } }))
  }, panel)
}

async function setLastWorkspaceViaStore(page: import('@playwright/test').Page, workspace: string): Promise<void> {
  await page.evaluate(async (path: string) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().updateSettings({ lastWorkspace: path })
  }, workspace)
}

test.describe('R10-D/E 记忆中心与 Projects', () => {
  test('迁移/CRUD/启停注入 + 项目 CRUD/隔离/上下文 + 重启持久化', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-ws-${stamp}`)
    const workspaceB = join(root, 'tmp', `r10-memproj-ws-b-${stamp}`)
    const outside = join(root, 'tmp', `r10-memproj-outside-${stamp}`)
    for (const dir of [workspace, workspaceB, outside]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(workspace, 'docs-brief.md'), '# 项目资料\nCANARY_A_KNOWLEDGE：A 项目专属资料。', 'utf8')
    writeFileSync(join(workspace, 'numbers.csv'), 'quarter,sales\nQ3,123', 'utf8')
    writeFileSync(join(workspaceB, 'brief.md'), 'CANARY_B_KNOWLEDGE：B 项目专属资料。', 'utf8')
    writeFileSync(join(outside, 'secret.md'), 'OUTSIDE_CANARY：工作区外文件。', 'utf8')
    seedLegacyMemory(workspace)

    const dataDir = join(root, 'tmp', `r10-memproj-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-chromium-${stamp}`)

    let projectAId = ''
    const first = await launchMorrow({ name: 'r10-memproj-1', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 记忆 IPC 只接受已登记工作区；模拟用户已选择这个文件夹
      await setLastWorkspaceViaStore(page, workspace)

      /* ── 1) 旧 MEMORY.md 迁移 + scope 隔离 ── */
      const migrated = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(migrated.entries.length).toBe(2)
      expect(migrated.entries.every((entry) => entry.source === 'migration')).toBe(true)
      expect(migrated.stats.migratedTotal).toBe(2)
      expect(migrated.stats.legacyFileDetected).toBe(true)

      const globalEmpty = await feature<MemoryListWire>(page, 'feature:memory:list', { scope: 'global' })
      expect(globalEmpty.entries.length).toBe(0)

      /* ── 2) CRUD：项目记忆 / 全局记忆 / 启停 / 搜索 / 更新 ── */
      const projectEntry = await feature<{ entry: MemoryEntryWire }>(page, 'feature:memory:add', {
        scope: 'project',
        workspace,
        text: 'E2E 项目记忆：报告标题使用「季度经营分析」',
        tags: ['报告', '标题']
      })
      const globalEntry = await feature<{ entry: MemoryEntryWire }>(page, 'feature:memory:add', {
        scope: 'global',
        text: 'E2E 全局记忆：始终使用简体中文',
        tags: ['语言']
      })
      expect(projectEntry.entry.scope).toBe('project')
      expect(globalEntry.entry.scope).toBe('global')

      // 未登记的同级目录不能作为项目记忆工作区（防止向任意目录写 .morrow）
      const unregisteredAdd = await featureRaw(page, 'feature:memory:add', {
        scope: 'project',
        workspace: outside,
        text: '不应写入未登记工作区'
      })
      expect(unregisteredAdd.ok).toBe(false)
      expect(unregisteredAdd.error?.message).toContain('已登记')
      const unregisteredInjection = await featureRaw(page, 'feature:memory:injection', { workspace: outside })
      expect(unregisteredInjection.ok).toBe(false)
      expect(existsSync(join(outside, '.morrow'))).toBe(false)

      await feature(page, 'feature:memory:update', {
        scope: 'project',
        workspace,
        id: projectEntry.entry.id,
        text: 'E2E 项目记忆（已更新）：报告标题使用「季度经营分析」'
      })
      const disabledMigration = migrated.entries.find((entry) => entry.text.includes('金额保留两位小数'))!
      await feature(page, 'feature:memory:toggle', {
        scope: 'project',
        workspace,
        id: disabledMigration.id,
        enabled: false
      })

      const searched = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        query: '经营分析',
        includeDisabled: true
      })
      expect(searched.entries.map((entry) => entry.text).join('')).toContain('季度经营分析')

      const withDisabled = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(withDisabled.stats.disabled).toBe(1)
      expect(withDisabled.stats.enabled).toBe(2) // 3 条 - 1 条停用

      /* ── 3) 注入预览：只含启用条目、预算内、停用不出现 ── */
      const injection = await feature<MemoryInjectionWire>(page, 'feature:memory:injection', {
        workspace,
        maxTokens: 600
      })
      expect(injection.text).toContain('始终使用简体中文')
      expect(injection.text).toContain('已更新')
      expect(injection.text).not.toContain('金额保留两位小数')
      expect(injection.usedTokens).toBeLessThanOrEqual(injection.limitTokens)
      expect(injection.omitted).toBe(0)
      expect(injection.included).toBe(3) // 项目 2（1 迁移启用 + 1 新增）+ 全局 1

      /* ── 4) 导出 ── */
      const exported = await feature<{ markdown: string; json: string; count: number; fileName: string }>(
        page,
        'feature:memory:export',
        { scope: 'project', workspace }
      )
      expect(exported.count).toBe(3)
      expect(exported.markdown).toContain('E2E 项目记忆')
      expect(JSON.parse(exported.json).count).toBe(3)
      expect(exported.fileName).toMatch(/morrow-memory-project-/)

      /* ── 5) 项目 CRUD + 工作区边界 ── */
      const projectA = await feature<ProjectRecordWire>(page, 'feature:projects:create', {
        workspace,
        name: 'E2E 经营分析项目',
        description: 'E2E 项目描述',
        instructions: 'E2E 项目指令：金额保留两位小数；不要改原始数据。',
        knowledgePaths: ['docs-brief.md', 'numbers.csv'],
        pinned: true
      })
      projectAId = projectA.id
      expect(projectA.knowledgePaths).toEqual(['docs-brief.md', 'numbers.csv'])
      expect(projectA.active).toBe(true)

      const projectB = await feature<ProjectRecordWire>(page, 'feature:projects:create', {
        workspace: workspaceB,
        name: 'E2E B 项目',
        instructions: 'B 项目指令：CANARY_B_INSTRUCTION',
        knowledgePaths: ['brief.md']
      })

      const duplicate = await featureRaw(page, 'feature:projects:create', { workspace })
      expect(duplicate.ok).toBe(false)

      const outsideKnowledge = await featureRaw(page, 'feature:projects:knowledge-validate', {
        workspace,
        path: join(outside, 'secret.md')
      })
      expect(outsideKnowledge.ok).toBe(false)
      expect(!outsideKnowledge.ok && outsideKnowledge.error.message).toMatch(/工作区内/)

      const relativeEscape = await featureRaw(page, 'feature:projects:knowledge-validate', {
        workspace,
        path: '../r10-memproj-outside'
      })
      expect(relativeEscape.ok).toBe(false)

      /* ── 6) 上下文生成：指令 + 知识摘要 + 记忆；跨项目隔离 ── */
      const contextA = await feature<ProjectContextWire>(page, 'feature:projects:context', {
        workspace,
        memoryTokens: 400
      })
      expect(contextA.text).toContain('E2E 项目指令')
      expect(contextA.text).toContain('CANARY_A_KNOWLEDGE')
      expect(contextA.text).toContain('E2E 项目描述')
      expect(contextA.text).toContain('始终使用简体中文')
      expect(contextA.text).toContain('E2E 项目记忆（已更新）')
      expect(contextA.text).not.toContain('CANARY_B_')
      expect(contextA.text).toContain('不可信数据')
      expect(contextA.knowledge.length).toBe(2)
      expect(contextA.usedTokens).toBeLessThanOrEqual(contextA.limitTokens)

      const contextB = await feature<ProjectContextWire>(page, 'feature:projects:context', {
        workspace: workspaceB,
        memoryTokens: 0
      })
      expect(contextB.text).toContain('CANARY_B_INSTRUCTION')
      expect(contextB.text).toContain('CANARY_B_KNOWLEDGE')
      expect(contextB.text).not.toContain('CANARY_A_KNOWLEDGE')
      expect(contextB.text).not.toContain('E2E 项目记忆')

      /* ── 7) 停用项目后不注入（ignoreActive 仍可预览） ── */
      await feature(page, 'feature:projects:set-active', { id: projectA.id, active: false })
      const inactiveContext = await feature<ProjectContextWire | null>(page, 'feature:projects:context', { workspace })
      expect(inactiveContext).toBeNull()
      const preview = await feature<ProjectContextWire | null>(page, 'feature:projects:context', {
        workspace,
        ignoreActive: true
      })
      expect(preview).not.toBeNull()
      await feature(page, 'feature:projects:set-active', { id: projectA.id, active: true })

      /* ── 8) 更新指令 + 列表摘要 ── */
      await feature(page, 'feature:projects:update', {
        id: projectA.id,
        instructions: 'E2E 项目指令（更新）：报告必须给出数据来源。'
      })
      const list = await feature<ProjectListWire>(page, 'feature:projects:list')
      expect(list.projects.length).toBe(2)
      const listedA = list.projects.find((project) => project.id === projectA.id)!
      expect(listedA.instructions).toContain('数据来源')
      expect(listedA.pinned).toBe(true)
      expect(listedA.knowledgeCount).toBe(2)
      expect(listedA.workspaceExists).toBe(true)
      expect(list.projects.find((project) => project.id === projectB.id)?.workspaceExists).toBe(true)

      await page.screenshot({ path: screenshotPath('r10-memory-projects-e2e.png') })

      /* ── 9) 磁盘证据：项目 JSON / 项目记忆 JSON / 全局记忆 JSON ── */
      const projectsFile = readFileSync(join(dataDir, 'projects', 'projects.json'), 'utf8')
      expect(projectsFile).toContain('E2E 经营分析项目')
      const projectMemoriesFile = readFileSync(join(workspace, '.morrow', 'memories.json'), 'utf8')
      expect(projectMemoriesFile).toContain('E2E 项目记忆')
      const globalMemoriesFile = readFileSync(join(dataDir, 'memories', 'global.json'), 'utf8')
      expect(globalMemoriesFile).toContain('始终使用简体中文')
    } finally {
      await first.close()
    }

    /* ── 10) 重启（同一 dataDir）后数据仍在 ── */
    const second = await launchMorrow({ name: 'r10-memproj-2', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      await waitForStoreReady(page)

      const memories = await feature<MemoryListWire>(page, 'feature:memory:list', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      expect(memories.entries.length).toBe(3)
      expect(memories.stats.migratedTotal).toBe(2)
      const globals = await feature<MemoryListWire>(page, 'feature:memory:list', { scope: 'global' })
      expect(globals.entries.map((entry) => entry.text).join('')).toContain('始终使用简体中文')

      const projects = await feature<ProjectListWire>(page, 'feature:projects:list')
      const restored = projects.projects.find((project) => project.id === projectAId)
      expect(restored).toBeTruthy()
      expect(restored?.instructions).toContain('数据来源')
      expect(restored?.knowledgePaths).toEqual(['docs-brief.md', 'numbers.csv'])

      const contextAfterRestart = await feature<ProjectContextWire>(page, 'feature:projects:context', { workspace })
      expect(contextAfterRestart.text).toContain('CANARY_A_KNOWLEDGE')
      expect(contextAfterRestart.text).toContain('数据来源')

      // 项目记忆文件在重启后没有被重复迁移（幂等）
      const diskMemories = JSON.parse(readFileSync(join(workspace, '.morrow', 'memories.json'), 'utf8')) as {
        entries: Array<{ text: string }>
      }
      expect(diskMemories.entries.filter((entry) => entry.text.includes('金额保留两位小数'))).toHaveLength(1)
      expect(existsSync(join(workspaceB, 'brief.md'))).toBe(true)
    } finally {
      await second.close()
    }
  })

  test('UI：工作台 → 记忆中心添加/启停/注入预览（明暗截图）+ 项目面板编辑与上下文预览', async () => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-ui-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nUI_CANARY_KNOWLEDGE：项目知识内容。', 'utf8')
    seedLegacyMemory(workspace)
    const dataDir = join(root, 'tmp', `r10-memproj-ui-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-ui-chromium-${stamp}`)

    const morrow = await launchMorrow({ name: 'r10-memproj-ui', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await setLastWorkspaceViaStore(page, workspace)

      // 先通过真实 IPC 建一个项目（面板负责编辑/预览，不重复测 CRUD）
      await feature(page, 'feature:projects:create', {
        workspace,
        name: 'UI 项目',
        description: 'UI 描述',
        instructions: 'UI 项目指令：先给结论，再给数据来源。',
        knowledgePaths: ['brief.md']
      })

      /* ── 记忆中心 UI ── */
      await openWorkbenchPanel(page, 'memory')
      const memoryRoot = page.locator('.mc-root')
      await expect(memoryRoot).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.modal-title').filter({ hasText: '记忆' })).toBeVisible()
      // 旧 MEMORY.md 迁移条目出现在面板里
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆：周报按季度口径汇总')
      await expect(memoryRoot).toContainText('旧记忆已迁移')

      // 添加一条项目记忆
      await page.getByRole('button', { name: '添加记忆' }).click()
      await page.getByLabel('新的项目记忆').fill('UI 添加的记忆：图表使用香槟金主色。')
      await page.getByLabel('标签（可选，逗号分隔，最多 8 个）').fill('图表, UI')
      await page.getByRole('button', { name: '保存记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('UI 添加的记忆')
      await expect(page.locator('.mc-notice')).toContainText('已保存')

      // 行内停用 + 搜索
      const addedEntry = page.locator('.mc-entry').filter({ hasText: 'UI 添加的记忆' })
      await addedEntry.getByRole('switch', { name: '停用这条记忆' }).click()
      await expect(addedEntry).toContainText('已停用，不会参考')
      await page.getByLabel('搜索长期记忆').fill('UI 添加')
      await expect(page.locator('.mc-entry')).toHaveCount(1)
      await page.getByLabel('搜索长期记忆').fill('')

      // 切范围时必须清掉旧范围的清空确认，不能把「清空项目记忆」执行成「清空全局记忆」
      await page.getByRole('radio', { name: '全局记忆' }).click()
      await page.getByRole('button', { name: '添加记忆' }).click()
      await page.getByLabel('新的全局记忆').fill('UI 全局记忆：始终使用简体中文。')
      await page.getByRole('button', { name: '保存记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('UI 全局记忆')
      await page.getByRole('radio', { name: '项目记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆')
      await page.getByRole('button', { name: '清空项目记忆' }).click()
      await expect(page.getByRole('alertdialog', { name: '确认操作' })).toBeVisible()
      await page.getByRole('radio', { name: '全局记忆' }).click()
      await expect(page.getByRole('alertdialog', { name: '确认操作' })).toHaveCount(0)
      await expect(page.locator('.mc-list')).toContainText('UI 全局记忆')
      await page.getByRole('radio', { name: '项目记忆' }).click()
      await expect(page.locator('.mc-list')).toContainText('E2E 迁移记忆')

      // 注入预览（停用条目不出现，旧迁移条目与全局记忆出现）
      await page.getByRole('button', { name: 'Morrow 会参考的内容' }).click()
      const injection = page.locator('.mc-injection')
      await expect(injection).toBeVisible({ timeout: 10_000 })
      await expect(injection).toContainText('E2E 迁移记忆')
      await expect(injection).toContainText('UI 全局记忆')
      await expect(injection).not.toContainText('UI 添加的记忆')
      await expect(injection).toContainText('tokens')
      await page.evaluate(() => {
        document.querySelector('.modal-body')?.scrollTo(0, 0)
      })
      await page.screenshot({ path: screenshotPath('r10-memory-center-dark.png') })

      // 明色主题截图（沿用全局主题 tokens）
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('r10-memory-center-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.locator('.mc-foot').getByRole('button', { name: '关闭' }).click()
      await expect(page.locator('.mc-root')).toHaveCount(0)

      /* ── 项目面板 UI ── */
      await openWorkbenchPanel(page, 'projects')
      await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.modal-title').filter({ hasText: '项目' })).toBeVisible()
      await expect(page.locator('.pp-project')).toContainText('UI 项目')
      // 默认是项目主页（概览）：标题、项目内对话入口、说明与资料摘要
      await expect(page.locator('.pp-home-title')).toHaveText('UI 项目')
      await expect(page.locator('.pp-home-composer textarea')).toBeVisible()
      await expect(page.locator('.pp-home-cards')).toContainText('UI 项目指令：先给结论')
      await expect(page.locator('.pp-home-cards')).toContainText('brief.md')
      // 切到说明与资料：当前工作区项目默认被选中并带出完整指令
      await page.getByRole('tab', { name: '说明与资料' }).click()
      await expect(page.getByLabel('长期说明（Morrow 做任务时会参考）')).toHaveValue(/先给结论/)
      await expect(page.locator('.pp-knowledge-list')).toContainText('brief.md')
      // 知识文件会异步重新校验并显示真实大小（不是一直「校验中…」）
      await expect(page.locator('.pp-knowledge-size')).toContainText(/B|KB/i, { timeout: 10_000 })

      // 修改指令并保存
      await page.getByLabel('长期说明（Morrow 做任务时会参考）').fill('UI 项目指令（已保存）：先给结论，再给数据来源，并列出风险。')
      await page.getByRole('button', { name: '保存项目' }).click()
      await expect(page.locator('.pp-notice')).toContainText('项目已保存')

      // 上下文预览：指令 + 知识摘要 + 记忆
      await page.getByRole('button', { name: 'Morrow 会看到什么' }).click()
      const preview = page.locator('.pp-preview')
      await expect(preview).toBeVisible({ timeout: 10_000 })
      await expect(preview).toContainText('UI 项目指令（已保存）')
      await expect(preview).toContainText('UI_CANARY_KNOWLEDGE')
      await expect(preview).toContainText('E2E 迁移记忆')
      await preview.scrollIntoViewIfNeeded()
      await page.screenshot({ path: screenshotPath('r10-projects-context-preview.png') })

      // 通过真实 IPC 复核 UI 保存结果（四层互证：DOM/事件/IPC/磁盘）
      const projects = await feature<ProjectListWire>(page, 'feature:projects:list')
      const saved = projects.projects.find((project) => project.name === 'UI 项目')
      expect(saved?.instructions).toContain('并列出风险')
      const diskProject = readFileSync(join(dataDir, 'projects', 'projects.json'), 'utf8')
      expect(diskProject).toContain('并列出风险')
    } finally {
      await morrow.close()
    }
  })

  test('Agent 注入：项目指令 + 知识摘要 + 记忆真实进入 system prompt（mock LLM）', async () => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r10-memproj-inject-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nINJECT_CANARY_KNOWLEDGE：这份资料只在本项目里。', 'utf8')
    const dataDir = join(root, 'tmp', `r10-memproj-inject-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r10-memproj-inject-chromium-${stamp}`)
    // mock LLM：记录真实请求体（system prompt 在 OpenAI 兼容协议的 messages[0]）
    const mock = await startMockLLM({ scripts: [{ text: '收到，我会按项目规矩回答。' }] })

    const morrow = await launchMorrow({ name: 'r10-memproj-inject', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await setLastWorkspaceViaStore(page, workspace)
      await installEventCollector(page)
      const provider = await page.evaluate(async (url: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const config = {
          id: 'mock-r10-inject',
          kind: 'openai-compat',
          name: '本地 Mock（注入测试）',
          baseUrl: url,
          models: [{ id: 'mock-model', label: 'Mock Model', contextWindow: 32_000, supportsTools: true }],
          apiKeyStored: false,
          enabled: true
        }
        await store.getState().saveProvider({ config })
        return { providerId: config.id as string, modelId: 'mock-model' }
      }, mock.openaiBaseUrl)

      /* 项目 + 项目记忆 + 全局记忆都通过真实 feature IPC 落盘 */
      await feature(page, 'feature:projects:create', {
        workspace,
        name: '注入项目',
        instructions: '注入指令：报告必须标注数据来源。',
        knowledgePaths: ['brief.md']
      })
      await feature(page, 'feature:memory:add', {
        scope: 'project',
        workspace,
        text: '注入记忆：图表使用香槟金主色。'
      })
      await feature(page, 'feature:memory:add', {
        scope: 'global',
        text: '注入全局记忆：始终使用简体中文。'
      })

      /* 用 mock provider 建会话并真的发一条消息 */
      await page.evaluate(
        async (arg: { workspace: string; providerId: string; modelId: string }) => {
          const created = await window.morrow.session.create({
            workspace: arg.workspace,
            model: { providerId: arg.providerId, modelId: arg.modelId },
            permissionMode: 'auto',
            title: '注入测试会话'
          })
          if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().selectSession(created.data.id)
        },
        { workspace, providerId: provider.providerId, modelId: provider.modelId }
      )
      await sendMessageViaStore(page, '你好，请按这个项目的规矩介绍一下背景。')
      // mock LLM 回复很快：不轮询瞬时 run 状态，直接等 run_finished 事件（已安装事件收集器）
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      expect(mock.calls).toBeGreaterThanOrEqual(1)

      /* 真实请求 body 里必须出现注入内容（四层证据：服务→agent-service→provider 请求） */
      const requestBody = JSON.stringify(mock.requests[0].body)
      expect(requestBody).toContain('注入指令：报告必须标注数据来源')
      expect(requestBody).toContain('INJECT_CANARY_KNOWLEDGE')
      expect(requestBody).toContain('注入记忆：图表使用香槟金主色')
      expect(requestBody).toContain('注入全局记忆：始终使用简体中文')
      // 注入文本明确标注不可信背景/不构成授权
      expect(requestBody).toContain('不是指令')
      await page.screenshot({ path: screenshotPath('r10-memory-projects-injection.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：r10-skills.spec.ts ──────────────────────────────────────────────
test.describe('r10-skills.spec.ts', () => {
/**
 * R10-H 技能库 E2E —— 真实 Electron + 真实主进程 `feature:skills:*` IPC。
 *
 * 验收点（不依赖 LLM、不联网、不产生费用）：
 * 1. 主进程 feature 频道已注册（Lead 需在 src/main/ipc-index.ts import './skills'）；
 * 2. 从本地 .zip 真实安装到应用数据目录 <dataDir>/skills，文件真实落盘；
 * 3. list / read / setEnabled / remove / rescan 真实往返；
 * 4. 可执行文件（.js）、zip-slip（../）技能包被拒绝且不落盘；
 * 5. 技能库面板挂载后（Lead 集成）截图深/浅两套主题。
 *
 * 面板 UI 断言说明：Lead 统一挂载 <SkillsPanel/>，本 spec 通过
 * `window.morrow.features.invoke` 直接验证 IPC + 磁盘两层证据；若面板已挂载
 * （存在 `[data-testid="skills-panel"]` 且能找到打开入口）则补截图，否则跳过该段。
 */

type InvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

interface SkillView {
  id: string
  name: string
  source: 'workspace' | 'user'
  enabled: boolean
  dir: string
  skillPath: string
  fileCount: number
}

interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  errors: string[]
}

interface SkillDetail extends SkillView {
  raw: string
  files: Array<{ path: string; size: number }>
}

/* 手工构造 store 模式 ZIP（e2e 里不依赖 jszip 的 CJS 互操作，也让恶意条目名保持原样） */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(path: string, entries: Record<string, string>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localBuffer.length, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(path, Buffer.concat([localBuffer, centralBuffer, end]))
  return path
}

async function invoke<T>(
  page: Parameters<typeof waitForStoreReady>[0],
  channel: string,
  payload?: unknown
): Promise<InvokeResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: channelPayload }) => {
      return (window as unknown as {
        morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
      }).morrow.features.invoke(channelName, channelPayload) as Promise<never>
    },
    { channel, payload }
  )
}

test.describe('R10-H 技能库（真实主进程 feature IPC）', () => {
  test('安装 / 读取 / 启停 / 删除 / 重扫 + 恶意 zip 拒绝', async () => {
    const morrow = await launchMorrow({ name: 'r10-skills', waitForSelector: '#root' })
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureDir = join(root, 'tmp', `r10-skills-fixtures-${fixtureId}`)
    mkdirSync(fixtureDir, { recursive: true })
    try {
      await waitForStoreReady(morrow.page)

      // 0. 频道必须已注册（Lead 在 features/index.ts import './skills'）
      const initial = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(initial.ok, `feature:skills:list 未注册或失败：${initial.ok ? '' : initial.error.message}`).toBe(true)
      if (!initial.ok) throw new Error('技能库 feature 频道未注册')
      const userDir = initial.data.userDir
      expect(userDir).toContain('skills')
      expect(initial.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review', 'debugging']))

      // 1. 从 zip 真实安装
      const zipPath = writeZip(join(fixtureDir, 'release-skill.zip'), {
        'release/SKILL.md': '---\nname: release\ndescription: E2E 安装的发版技能\n---\n# Release\n读取 changelog 并生成 release.json。',
        'release/checklist.md': '- 检查 changelog\n- 打 tag\n'
      })
      const installed = await invoke<{ installed: SkillView; snapshot: SkillsSnapshot }>(
        morrow.page,
        'feature:skills:install',
        { sourcePath: zipPath, workspace: null }
      )
      expect(installed.ok).toBe(true)
      if (!installed.ok) throw new Error(installed.error.message)
      const skill = installed.data.installed
      expect(skill).toMatchObject({ name: 'release', source: 'user', enabled: true })
      expect(existsSync(join(userDir, 'release', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(userDir, 'release', 'checklist.md'))).toBe(true)
      expect(readFileSync(join(userDir, 'release', 'SKILL.md'), 'utf8')).toContain('E2E 安装的发版技能')

      // 2. list / read
      const listed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error(listed.error.message)
      expect(listed.data.skills.map((item) => item.name)).toContain('release')
      const detail = await invoke<SkillDetail>(morrow.page, 'feature:skills:read', { id: skill.id, workspace: null })
      expect(detail.ok).toBe(true)
      if (!detail.ok) throw new Error(detail.error.message)
      expect(detail.data.raw).toContain('# Release')
      expect(detail.data.files.map((file) => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'checklist.md']))

      // 3. 启停（状态真实写盘）
      const disabled = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: false,
        workspace: null
      })
      expect(disabled.ok).toBe(true)
      if (!disabled.ok) throw new Error(disabled.error.message)
      expect(disabled.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(false)
      const stateFile = disabled.data.stateFile
      expect(readFileSync(stateFile, 'utf8')).toContain('"enabled": false')

      const enabledAgain = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: true,
        workspace: null
      })
      expect(enabledAgain.ok).toBe(true)
      if (!enabledAgain.ok) throw new Error(enabledAgain.error.message)
      expect(enabledAgain.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(true)

      // 4. 恶意技能包：可执行文件 & zip-slip 都要被拒绝且不落盘
      const exeZip = writeZip(join(fixtureDir, 'exe-skill.zip'), {
        'SKILL.md': '# Bad\nx',
        'run.js': 'console.log(1)'
      })
      const exeInstalled = await invoke<{ installed: SkillView; skipped: string[] }>(morrow.page, 'feature:skills:install', {
        sourcePath: exeZip,
        workspace: null
      })
      expect(exeInstalled.ok).toBe(true)
      if (!exeInstalled.ok) throw new Error(exeInstalled.error.message)
      expect(exeInstalled.data.skipped).toContain('run.js')
      expect(existsSync(join(userDir, 'exe-skill', 'run.js'))).toBe(false)
      await invoke(morrow.page, 'feature:skills:remove', { id: exeInstalled.data.installed.id, workspace: null })

      const evilZip = writeZip(join(fixtureDir, 'evil-skill.zip'), {
        'SKILL.md': '# Evil\nx',
        '../escaped.txt': 'pwned'
      })
      const evilRejected = await invoke(morrow.page, 'feature:skills:install', { sourcePath: evilZip, workspace: null })
      expect(evilRejected.ok).toBe(false)
      if (!evilRejected.ok) expect(evilRejected.error.message).toMatch(/zip-slip|越界/)
      expect(existsSync(join(userDir, '..', 'escaped.txt'))).toBe(false)
      expect(existsSync(join(morrow.dataDir, 'escaped.txt'))).toBe(false)

      // 5. rescan + remove
      const rescanned = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:rescan', { workspace: null })
      expect(rescanned.ok).toBe(true)
      if (!rescanned.ok) throw new Error(rescanned.error.message)
      expect(rescanned.data.errors).toEqual([])

      const removed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:remove', {
        id: skill.id,
        workspace: null
      })
      expect(removed.ok).toBe(true)
      if (!removed.ok) throw new Error(removed.error.message)
      expect(removed.data.skills.some((item) => item.name === 'release')).toBe(false)
      expect(removed.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review']))
      expect(existsSync(join(userDir, 'release'))).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      await morrow.close()
    }
  })
})

})
// ── 原文件：r10-panels.spec.ts ──────────────────────────────────────────────
test.describe('r10-panels.spec.ts', () => {
const PANELS: { card: string; file: string }[] = [
  { card: '技能库', file: 'r10-panel-skills.png' },
  { card: '记忆中心', file: 'r10-panel-memory.png' },
  { card: '项目', file: 'r10-panel-projects.png' },
  { card: '连接器', file: 'r10-panel-connectors.png' },
  { card: '全局搜索', file: 'r10-panel-search.png' },
  { card: '内置浏览器', file: 'r10-panel-browser.png' }
]

test.describe('功能面板集成', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('所有功能面板都能从设置 → 功能与工具打开/关闭', async () => {
    morrow = await launchMorrow({ name: 'r10-panels', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)
    for (const panel of PANELS) {
      await openToolPanel(page, panel.card)
      await page.waitForTimeout(800)
      await page.screenshot({ path: screenshotPath(panel.file) })
      if (panel.card === '内置浏览器') {
        await page.locator('.browser-close').click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(500)
    }
  })
})

})
// ── 原文件：r10-tools-settings.spec.ts ──────────────────────────────────────────────
test.describe('r10-tools-settings.spec.ts', () => {
test.describe('功能入口收敛', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('顶栏不再有工作台；功能入口集中在设置 → 功能与工具', async () => {
    morrow = await launchMorrow({ name: 'r10-tools-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await waitForStoreReady(page)

    await expect(page.locator('[aria-label^="打开工作台"]')).toHaveCount(0)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible()
    await settings.getByRole('tab', { name: '功能与工具' }).click()
    await expect(settings.locator('.st-tool-row')).toHaveCount(8)
    await expect(settings.locator('.st-tool-row').filter({ hasText: '终端' })).toHaveCount(0)
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r10-tools-settings.png') })

    await settings.locator('.st-tool-row').filter({ hasText: '技能' }).click()
    await expect(page.getByTestId('skills-panel')).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('skills-panel')).toBeHidden()
  })
})

})
// ── 原文件：r10-ui-copy-review.spec.ts ──────────────────────────────────────────────
test.describe('r10-ui-copy-review.spec.ts', () => {
/**
 * R10 UI 文案/布局复审（真实 Electron；不调用真实模型）。
 *
 * 打开 6 个工作台面板 + 设置 + 文件树 + 编辑器，检查：
 * - 可见文案（写入 docs/audit/logs/r10-ui-copy-review.json，供术语堆砌复核）；
 * - 横向溢出（scrollWidth - clientWidth）；
 * - 截图 docs/verification/screens/r10-ui-copy-*.png。
 *
 * 运行：npm run build && npx playwright test tests/e2e/r10-ui-copy-review.spec.ts
 */

const PANELS = ['技能库', '记忆中心', '项目', '连接器', '全局搜索', '内置浏览器']

async function overflowOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel: string) => {
    const element = document.querySelector(sel) as HTMLElement | null
    if (!element) return -1
    return element.scrollWidth - element.clientWidth
  }, selector)
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement
    // 输入框只保留标签/占位符层级，避免把技术字段值当说明文案
    body.querySelectorAll('input, textarea, select').forEach((element) => {
      element.setAttribute('value', '')
    })
    return (body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 6000)
  })
}

test.describe('R10 UI 文案与布局复审', () => {
  let morrow: MorrowApp
  let page: Page
  const observations: Array<Record<string, unknown>> = []
  const workspace = join(root, 'tmp', `r10-ui-review-${Date.now()}`)

  test.beforeAll(async () => {
    const fixtureRoot = join(root, 'tmp', 'audit', 'r10', 'fixtures', 'ws-main')
    if (existsSync(fixtureRoot)) cpSync(fixtureRoot, workspace, { recursive: true })
    else mkdirSync(join(workspace, 'in'), { recursive: true })
    // 不依赖审计 fixtures 是否生成：编辑器用例自己准备一个中文文本文件
    mkdirSync(join(workspace, 'in'), { recursive: true })
    writeFileSync(join(workspace, 'in', '中文资料.txt'), '# 中文资料\n\n这是一份用于界面检查的中文文本。\n', 'utf8')
    morrow = await launchMorrow({ name: 'r10-ui-copy', waitForSelector: '.sidebar', timeoutMs: 90_000 })
    page = morrow.page
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ onboardingDone: true })
      await store.getState().newSession({ workspace: ws })
    }, workspace)
    await page.waitForTimeout(900)
  })

  test.afterAll(async () => {
    try {
      await morrow?.app.close()
    } catch {
      // ignore
    }
    rmSync(workspace, { recursive: true, force: true })
    mkdirSync(join(root, 'docs', 'audit', 'logs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'audit', 'logs', 'r10-ui-copy-review.json'), JSON.stringify(observations, null, 2), 'utf8')
  })
})

})
})


test.describe("12-command-ipc", () => {
// ── 原文件：command-palette.spec.ts ──────────────────────────────────────────────
test.describe('command-palette.spec.ts', () => {
/**
 * 命令面板与快捷键/焦点回归：
 * - Esc 在弹窗/面板内只关闭弹窗，不误停正在运行的任务；
 * - 只有无弹窗且焦点不在输入框时，Esc 才停止当前运行；
 * - 设置 + 命令面板叠层时，Esc 只关闭最上层；
 * - 运行中启动演示会被拦下，不创建/切换会话；
 * - 文件搜索结果直接打开编辑器（不再只复制路径），且优先当前会话工作区。
 */

const WORKSPACE = join(root, 'tmp', `e2e-palette-ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)

test.describe('命令面板与快捷键', () => {
  test('Esc 只关闭弹窗，不误停运行；叠层只关最上层；运行中禁止启动演示', async () => {
    test.setTimeout(180_000)
    mkdirSync(WORKSPACE, { recursive: true })
    const longText = Array.from(
      { length: 40 },
      (_, index) => `第 ${index + 1} 段用于保持长时间流式运行，避免测试过程中任务自然结束。`
    ).join('\n\n')
    const mock = await startMockLLM({ scripts: [{ text: longText, textChunkSize: 5, chunkDelayMs: 80 }] })
    const morrow = await launchMorrow({ name: 'palette-esc', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace: WORKSPACE, ...provider, permissionMode: 'auto', title: '命令面板 Esc 测试' })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请开始长时间流式输出')
      await expect(page.locator('.message-assistant.is-streaming')).toBeVisible({ timeout: 30_000 })
      const runningId = (await readStore(page)).activeSessionId

      // 1) 面板打开、焦点在列表项上按 Esc：只关面板，运行继续
      await page.keyboard.press('Control+K')
      await expect(page.locator('.palette')).toBeVisible()
      await expect(page.locator('.palette-input')).toBeFocused()
      await page.locator('.palette-input').fill('')
      await expect(page.locator('.palette-item').first()).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('command-palette-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(320)
      await page.screenshot({ path: screenshotPath('command-palette-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(200)
      await page.locator('.palette-item').first().focus()
      await page.keyboard.press('Escape')
      await expect(page.locator('.palette')).toHaveCount(0)
      await page.waitForTimeout(500)
      expect((await readStore(page)).run).not.toBeNull()
      expect((await getEvents(page)).some((event) => event.type === 'run_finished')).toBe(false)

      // 2) 运行中点「看一场演示」应被拦下，不切换会话
      await page.keyboard.press('Control+K')
      await page.locator('.palette-input').fill('演示')
      const demoItem = page.locator('.palette-item').filter({ hasText: '看一场演示' })
      await expect(demoItem).toBeVisible()
      await demoItem.click()
      await expect
        .poll(async () => (await readStore(page)).toast?.message ?? '', { timeout: 10_000 })
        .toContain('还有任务在运行')
      expect((await readStore(page)).activeSessionId).toBe(runningId)
      expect((await readStore(page)).run).not.toBeNull()

      // 3) 设置弹窗关闭不应停止运行
      await page.keyboard.press('Control+,')
      await waitUntil(async () => (await readStore(page)).settingsOpen, 10_000, '设置打开')
      await page.waitForTimeout(300)
      const initialFocus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null
        return {
          inPanel: Boolean(active?.closest('.modal-panel')),
          isClose: Boolean(active?.classList.contains('modal-close'))
        }
      })
      // 初始焦点应落在对话框内容里，而不是默认落在「关闭」按钮上
      expect(initialFocus.inPanel).toBe(true)
      expect(initialFocus.isClose).toBe(false)
      await page.locator('.modal-close').first().focus()
      await page.keyboard.press('Escape')
      await waitUntil(async () => !(await readStore(page)).settingsOpen, 10_000, '设置关闭')
      await page.waitForTimeout(500)
      expect((await readStore(page)).run).not.toBeNull()

      // 4) 无弹窗、焦点不在输入框时，Esc 才停止运行
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Escape')
      await waitUntil(async () => (await readStore(page)).run === null, 20_000, '运行被 Esc 停止')
      const finished = (await getEvents(page)).filter((event) => event.type === 'run_finished').at(-1)
      expect(finished?.reason).toBe('cancelled')

      // 5) 设置 + 命令面板叠层：Esc 只关最上层
      await page.keyboard.press('Control+,')
      await waitUntil(async () => (await readStore(page)).settingsOpen, 10_000, '设置再次打开')
      await page.keyboard.press('Control+K')
      await expect(page.locator('.palette')).toBeVisible()
      expect((await readStore(page)).settingsOpen).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.locator('.palette')).toHaveCount(0)
      expect((await readStore(page)).settingsOpen).toBe(true)
      await page.keyboard.press('Escape')
      await waitUntil(async () => !(await readStore(page)).settingsOpen, 10_000, '第二次 Esc 关闭设置')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('弹窗打开时 Esc 不会误拒绝审批卡', async () => {
    test.setTimeout(120_000)
    mkdirSync(WORKSPACE, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        { toolCalls: [{ name: 'run_command', arguments: { command: 'Remove-Item out -Recurse -Force' } }] },
        { text: '处理完成。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'palette-permission', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace: WORKSPACE, ...provider, permissionMode: 'ask', title: '审批弹窗测试' })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请写一个文件')
      await waitForPermission(page, 60_000)

      await page.keyboard.press('Control+,')
      await waitUntil(async () => (await readStore(page)).settingsOpen, 10_000, '设置打开')
      await page.waitForTimeout(250)
      await page.locator('.modal-close').first().focus()
      await page.keyboard.press('Escape')
      await waitUntil(async () => !(await readStore(page)).settingsOpen, 10_000, '设置关闭')
      await page.waitForTimeout(300)

      // Esc 只关了设置，审批仍在等待，且没有产生拒绝决定
      expect((await readStore(page)).pendingPermission).not.toBeNull()
      expect((await getEvents(page)).some((event) => event.type === 'permission_resolved')).toBe(false)

      await clickPermissionCard(page, 'deny')
      await waitForRunFinished(page, 60_000)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('文件搜索结果直接打开编辑器，并优先当前会话工作区', async () => {
    test.setTimeout(120_000)
    mkdirSync(WORKSPACE, { recursive: true })
    const target = join(WORKSPACE, 'palette-check.ts')
    writeFileSync(target, 'export const paletteCheck = true\n', 'utf8')
    const morrow = await launchMorrow({ name: 'palette-file', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await createUiSession(page, {
        workspace: WORKSPACE,
        permissionMode: 'auto',
        title: '命令面板文件测试'
      })

      await page.keyboard.press('Control+K')
      await expect(page.locator('.palette')).toBeVisible()
      // 描述也可被搜索：输入「模型」应命中「打开设置」
      await page.locator('.palette-input').fill('模型')
      await expect(page.locator('.palette-item').filter({ hasText: '打开设置' })).toBeVisible()
      await page.locator('.palette-input').fill('palette-check')
      const fileItem = page.locator('.palette-item').filter({ hasText: 'palette-check.ts' })
      await expect(fileItem).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.palette-group-label').filter({ hasText: '文件' })).toBeVisible()

      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('command-palette-files-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('command-palette-files-dark.png') })

      await fileItem.click()
      await expect(page.locator('.palette')).toHaveCount(0)
      await expect(page.locator('.canvas-root .cm-editor')).toBeVisible({ timeout: 20_000 })
      const tab = page.locator('.canvas-doc-tab').filter({ hasText: 'palette-check.ts' })
      await expect(tab).toBeVisible()
      // relPath 必须是干净的工作区相对路径，而不是拼接错误的绝对路径
      await expect(tab.getByRole('tab')).toHaveAttribute('title', 'palette-check.ts')
      expect((await readStore(page)).canvas.open).toBe(true)
    } finally {
      await morrow.close()
    }
  })
})

})
// ── 原文件：ipc-boundary.spec.ts ──────────────────────────────────────────────
test.describe('ipc-boundary.spec.ts', () => {
/**
 * IPC/preload 边界回归：
 * - 核心通道异常统一归一化为 Result，不再向渲染层抛 Electron 原始拒绝；
 * - 产物读取/打开/另存与文件搜索只接受已登记工作区内的真实路径；
 * - 生产 CSP 下 connect-src 不再允许任意 https 外联；
 * - 主窗口不能被导航到任意 file:// 页面；
 * - 沙箱化 preload 仍能提供完整 API。
 */

interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

test('IPC 路径边界、错误归一化、CSP 与导航限制', async () => {
  test.setTimeout(120_000)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const workspace = join(root, 'tmp', `ipc-boundary-ws-${stamp}`)
  const outsideDir = join(root, 'tmp', `ipc-boundary-outside-${stamp}`)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  const insidePath = join(workspace, 'inside.txt')
  const outsidePath = join(outsideDir, 'secret.txt')
  writeFileSync(insidePath, 'inside-workspace-content', 'utf8')
  writeFileSync(outsidePath, 'outside-secret-content', 'utf8')

  const morrow = await launchMorrow({ name: 'ipc-boundary', env: { MORROW_TEST_CSP: '1' } })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: 'IPC 边界测试'
    })

    const readInside = await page.evaluate(
      (path) => (window as unknown as { morrow: { artifacts: { read: (p: string) => Promise<IpcResult<{ content: string }>> } } }).morrow.artifacts.read(path),
      insidePath
    )
    expect(readInside.ok, JSON.stringify(readInside.error)).toBe(true)
    expect(readInside.data?.content).toBe('inside-workspace-content')

    const readOutside = await page.evaluate(
      (path) => (window as unknown as { morrow: { artifacts: { read: (p: string) => Promise<IpcResult> } } }).morrow.artifacts.read(path),
      outsidePath
    )
    expect(readOutside.ok).toBe(false)
    expect(readOutside.error?.code).toBe('FILE_UNAVAILABLE')
    expect(JSON.stringify(readOutside)).not.toContain('outside-secret-content')

    const searchOutside = await page.evaluate(
      (dir) => (window as unknown as { morrow: { files: { search: (root: string, q: string) => Promise<IpcResult> } } }).morrow.files.search(dir, 'secret'),
      outsideDir
    )
    expect(searchOutside.ok).toBe(false)
    expect(searchOutside.error?.code).toBe('FILE_ROOT_DENIED')

    const searchInside = await page.evaluate(
      (dir) => (window as unknown as { morrow: { files: { search: (root: string, q: string) => Promise<IpcResult> } } }).morrow.files.search(dir, 'inside'),
      workspace
    )
    expect(searchInside.ok, JSON.stringify(searchInside.error)).toBe(true)
    expect(JSON.stringify(searchInside.data)).toContain('inside.txt')

    // 文件功能显式传入 workspace 时也必须属于已登记工作区
    const filesOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:list', { workspace: dir }),
      outsideDir
    )
    expect(filesOutside.ok).toBe(false)
    const fileReadOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:read', { workspace: dir, path: 'secret.txt' }),
      outsideDir
    )
    expect(fileReadOutside.ok).toBe(false)
    const filePreviewOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:preview', { workspace: dir, path: 'secret.txt' }),
      outsideDir
    )
    expect(filePreviewOutside.ok).toBe(false)
    const filesInside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:list', { workspace: dir }),
      workspace
    )
    expect(filesInside.ok, JSON.stringify(filesInside.error)).toBe(true)

    // 规则文件发现同样只接受已登记工作区
    const rulesOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:rules:list', { workspace: dir }),
      outsideDir
    )
    expect(rulesOutside.ok).toBe(false)
    expect(rulesOutside.error?.message ?? '').toContain('已登记工作区')
    const rulesInside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult<{ files: unknown[] }>> } } })
          .morrow.features.invoke('feature:rules:list', { workspace: dir }),
      workspace
    )
    expect(rulesInside.ok, JSON.stringify(rulesInside.error)).toBe(true)

    const sessionId = await page.evaluate(
      () => (window as unknown as { __morrowStore: { getState: () => { activeSessionId: string } } }).__morrowStore.getState().activeSessionId
    )
    // 核心通道异常归一化为 Result（主进程 handler 抛错时不再向渲染层抛 Electron 原始拒绝）
    const malformed = await page.evaluate(
      (id) =>
        (window as unknown as { morrow: { session: { rename: (id: string, title: unknown) => Promise<IpcResult> } } })
          .morrow.session.rename(id, 123),
      sessionId
    )
    expect(malformed.ok).toBe(false)
    expect(malformed.error?.code).toBe('IPC_FAILED')
    expect(malformed.error?.message ?? '').not.toContain('Error invoking remote method')

    const invalidMode = await page.evaluate(
      (id) =>
        (window as unknown as { morrow: { session: { setPermissionMode: (id: string, mode: string) => Promise<IpcResult> } } })
          .morrow.session.setPermissionMode(id, 'yolo'),
      sessionId
    )
    expect(invalidMode.ok).toBe(false)
    expect(invalidMode.error?.code).toBe('INVALID_PERMISSION_MODE')

    const unknownFeature = await page.evaluate(() =>
      (window as unknown as { morrow: { features: { invoke: (channel: string) => Promise<IpcResult> } } })
        .morrow.features.invoke('feature:not-registered')
    )
    expect(unknownFeature.ok).toBe(false)
    expect(unknownFeature.error?.code).toBe('FEATURE_CHANNEL')

    // 生产 CSP：渲染层不应能任意 https 外联
    const cspBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/', { mode: 'no-cors' })
        return false
      } catch {
        return true
      }
    })
    expect(cspBlocked).toBe(true)

    // 主窗口不能被导航到任意本地文件
    const beforeUrl = page.url()
    await page
      .evaluate(() => {
        window.location.href = 'file:///C:/Windows/win.ini'
      })
      .catch(() => undefined)
    await page.waitForTimeout(600)
    expect(page.url()).toBe(beforeUrl)
    // 用 evaluate 而不是 locator：被拦截的导航会让 Playwright 一直等 "navigation to finish"
    const rootAlive = await page.evaluate(() => Boolean(document.querySelector('#root')))
    expect(rootAlive).toBe(true)
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：swarm.spec.ts ──────────────────────────────────────────────
test.describe('swarm.spec.ts', () => {
/**
 * 集群 E2E：/swarm 触发模型拆解 → swarm 工具并行派发 10 个成员 → 汇总。
 * 离线 mock LLM 按系统提示区分主代理与探索/审查成员。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('集群：拆解为十个成员并行执行并汇总', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    title: `并行检查 ${index + 1}`,
    prompt: `检查登录流程的第 ${index + 1} 个部分并给出结论`,
    agent: index % 2 === 0 ? 'explore' : 'review'
  }))
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown; lastUserMessageText?: string }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('你是代码侦察型集群成员')) {
        return { text: '探索完成：登录入口在 src/auth/login.ts。', delayMs: 400 }
      }
      if (raw.includes('你是代码审查型集群成员')) {
        return { text: '审查完成：未发现高危问题，建议补一个锁定测试。', delayMs: 400 }
      }
      mainCalls += 1
      if (mainCalls === 1) {
        return {
          text: '我把任务拆成十块并行检查。',
          toolCalls: [
            {
              name: 'swarm',
              arguments: {
                goal: '检查登录流程的安全性与实现位置',
                tasks
              }
            }
          ]
        }
      }
      return { text: '十个子任务都完成：登录入口已定位，未发现高危问题。' }
    }
  })
  const workspace = workspaceAt('e2e-swarm')
  const morrow = await launchMorrow({ name: 'swarm', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '集群测试'
    })

    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('/swarm 检查登录流程')
    await page.keyboard.press('Enter')

    // 实时任务板：不等整批结束就能看到每个子任务在做什么
    const swarmRow = page.locator('.spine-row').filter({ hasText: '集群' }).first()
    await expect(swarmRow).toBeVisible({ timeout: 15_000 })
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(10, { timeout: 20_000 })
    await expect(swarmRow.locator('.spine-swarm-status.is-running').first()).toBeVisible({ timeout: 15_000 })

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const last = state.session?.messages.at(-1)
        return state.run === null && last?.role === 'assistant' && last.text.includes('十个子任务都完成') ? true : null
      },
      90_000,
      'swarm 运行结束'
    )

    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(bodies.some((body: string) => body.includes('你是代码侦察型集群成员'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('你是代码审查型集群成员'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('"name":"swarm"') || body.includes('"name": "swarm"'))).toBe(true)

    await expect(swarmRow).toBeVisible()
    await expect(swarmRow.getByText('集群成员', { exact: true })).toBeVisible()
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(10)
    await expect(swarmRow.locator('.spine-swarm-status.is-completed')).toHaveCount(10)
    await expect(swarmRow.locator('.spine-swarm-task').nth(0)).toContainText('并行检查 1')
    await expect(swarmRow.locator('.spine-swarm-task').nth(0)).toContainText('代码侦察')
    await expect(swarmRow.locator('.spine-swarm-task').nth(1)).toContainText('并行检查 2')
    await expect(swarmRow.locator('.spine-swarm-task').nth(1)).toContainText('代码审查')
    await expect(swarmRow.locator('.spine-swarm-task').nth(0)).toContainText('探索完成')
    await expect(swarmRow.locator('.spine-swarm-task').nth(1)).toContainText('审查完成')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await swarmRow.scrollIntoViewIfNeeded()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('swarm-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('swarm-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('集群：单个成员拥有完整工作区权限，可直接写文件', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  let memberCalls = 0
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## 集群成员')) {
        memberCalls += 1
        if (memberCalls === 1) {
          return {
            text: '我来写文件。',
            toolCalls: [{ name: 'write_file', arguments: { path: 'out.txt', content: 'ok' } }]
          }
        }
        return { text: '成员完成。' }
      }
      mainCalls += 1
      if (mainCalls === 1) {
        return {
          text: '派一个成员完成。',
          toolCalls: [
            {
              name: 'swarm',
              arguments: {
                goal: '写文件',
                tasks: [{ title: '写文件', prompt: '创建 out.txt，内容为 ok' }]
              }
            }
          ]
        }
      }
      return { text: '集群完成。' }
    }
  })
  const workspace = workspaceAt('e2e-swarm-full-access')
  const morrow = await launchMorrow({ name: 'swarm-full-access', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '集群单成员权限' })
    await installEventCollector(page)

    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('/swarm 写文件')
    await page.keyboard.press('Enter')
    await waitForRunFinished(page, 90_000)

    expect(existsSync(join(workspace, 'out.txt'))).toBe(true)
    expect(readFileSync(join(workspace, 'out.txt'), 'utf8')).toBe('ok')
    const swarmRow = page.locator('.spine-row').filter({ hasText: '集群' }).first()
    await expect(swarmRow).toBeVisible()
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(1)
    await expect(swarmRow.locator('.spine-swarm-status.is-completed')).toHaveCount(1)
    // 展开成员后可看到真实执行的工具、参数与结果摘要
    await swarmRow.locator('.spine-swarm-task-toggle').first().click()
    await expect(swarmRow.locator('.spine-swarm-op')).toHaveCount(1)
    await expect(swarmRow.locator('.spine-swarm-op').first()).toContainText('write_file')
    await expect(swarmRow.locator('.spine-swarm-op').first()).toContainText('out.txt')
    await expect(page.getByText('集群完成。')).toBeVisible()
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
})
