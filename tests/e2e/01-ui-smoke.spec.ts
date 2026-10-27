/**
 * 合并自 9 个 E2E spec：smoke.spec.ts、brand-marks.spec.ts、composer-layout.spec.ts、island.spec.ts、session-lifecycle.spec.ts、session-branching.spec.ts、r5-ui.spec.ts、r7-ui.spec.ts、r7-privacy.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath, windowStates } from './launch'
import type { MorrowApp } from './launch'
import { configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForEvent, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

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

  test('明暗主题：设计 token 切换生效，两套主题截图归档', async () => {
    const morrow = await launchMorrow({ name: 'theme' })
    try {
      const { page } = morrow
      await page.waitForLoadState('load')

      const readTheme = () =>
        page.evaluate(() => {
          const rootStyle = getComputedStyle(document.documentElement)
          return {
            themeAttr: document.documentElement.getAttribute('data-theme'),
            bgToken: rootStyle.getPropertyValue('--bg').trim(),
            bodyBg: getComputedStyle(document.body).backgroundColor
          }
        })

      // 默认深色（Settings 默认 theme=dark，store 会写到 documentElement.dataset.theme）
      const dark = await readTheme()
      expect(dark.bgToken.toLowerCase()).toBe('#0b0d10')
      expect(dark.bodyBg.replace(/\s/g, '')).toBe('rgb(11,13,16)')
      await page.screenshot({ path: screenshotPath('e2e-theme-dark.png') })

      // 切到素纸（light）主题：token 与底色必须真的变化
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light')
      })
      await page.waitForTimeout(400)
      const light = await readTheme()
      expect(light.themeAttr).toBe('light')
      expect(light.bgToken.toLowerCase()).toBe('#f1ede4')
      expect(light.bodyBg.replace(/\s/g, '')).toBe('rgb(241,237,228)')
      await page.screenshot({ path: screenshotPath('e2e-theme-light.png') })

      // 切回深色，确认可逆
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark')
      })
      await page.waitForTimeout(200)
      const back = await readTheme()
      expect(back.bodyBg.replace(/\s/g, '')).toBe('rgb(11,13,16)')
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

  test('窄窗口下左侧按钮不重叠右侧控件，且保持一行', async () => {
    morrow = await launchMorrow({ name: 'composer-layout', waitForSelector: '.composer-bar' })
    const { page, app } = morrow
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore
      store.setState({ onboardingOpen: false })
    })

    const widths = [1400, 1200, 1100, 1000, 940, 900, 860, 820, 800]
    for (const width of widths) {
      await app.evaluate(({ BrowserWindow }, nextWidth) => {
        const win = BrowserWindow.getAllWindows()[0]
        const bounds = win.getBounds()
        win.setBounds({ x: bounds.x, y: bounds.y, width: nextWidth, height: 900 })
      }, width)
      await page.waitForTimeout(200)

      const layout = await page.evaluate(() => {
        const rect = (selector: string): DOMRect | null => {
          const el = document.querySelector(selector)
          return el ? el.getBoundingClientRect() : null
        }
        const left = rect('.composer-bar-left')
        const right = rect('.composer-bar-right')
        const icons = [...document.querySelectorAll('.composer-bar-left > *')].map((el) =>
          el.getBoundingClientRect().toJSON()
        )
        const bar = document.querySelector('.composer-bar')
        return {
          left: left?.toJSON() ?? null,
          right: right?.toJSON() ?? null,
          icons,
          overflow: bar ? bar.scrollWidth - bar.clientWidth : 0
        }
      })

      expect(layout.left, `${width}: 左栏存在`).not.toBeNull()
      expect(layout.right, `${width}: 右栏存在`).not.toBeNull()
      expect(intersects(layout.left!, layout.right!), `${width}: 左右两组不能相交`).toBe(false)
      const leftMid = layout.left!.y + layout.left!.height / 2
      const rightMid = layout.right!.y + layout.right!.height / 2
      expect(Math.abs(leftMid - rightMid), `${width}: 工具条保持同一行`).toBeLessThanOrEqual(1)
      for (const icon of layout.icons) {
        expect(icon.right, `${width}: 图标不能越出左栏`).toBeLessThanOrEqual(layout.left!.x + layout.left!.width + 0.5)
      }
      expect(layout.overflow, `${width}: 底栏不能横向溢出`).toBeLessThanOrEqual(1)
      if (width === 800) await page.screenshot({ path: screenshotPath('composer-narrow-800.png') })
    }

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const bounds = win.getBounds()
      win.setBounds({ x: bounds.x, y: bounds.y, width: 820, height: 900 })
    })
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('composer-narrow-wrap.png') })
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
      return {
        background: line ? getComputedStyle(line).backgroundColor : 'missing',
        border: sidebar ? getComputedStyle(sidebar).borderRightColor : 'missing'
      }
    })
    expect(dragLine.background).toBe('rgba(0, 0, 0, 0)')
    expect(dragLine.border).toContain('200, 174, 125')
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
      ['Meta（Muse）', ['Muse Spark 1.3']],
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
