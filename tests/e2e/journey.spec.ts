// journey 领域 E2E：由 4 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import type { MorrowApp } from './launch'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clickPermissionCard, configureMockProvider, createSession, demoEntryButton, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForEvent, waitForPermission, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil, clearEvents } from './store'
import { startMockComfyUI } from '../fixtures/mock-comfyui.mjs'

test.describe("14-journey", () => {
// ── 原文件：journey.spec.ts ──────────────────────────────────────────────
test.describe('journey.spec.ts', () => {

test.describe('Morrow 完整旅程', () => {
  test('@core:interface 演示模式：点「看一场演示」→ 真实跑完 → HTML 报告落盘 → 画布自动打开', async () => {
    test.setTimeout(240_000)
    const morrow = await launchMorrow({
      name: 'demo',
      env: { MORROW_DEMO_SPEED: '0.05' },
      timeoutMs: 90_000
    })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      // 1) 从真实 UI 入口启动演示
      const demoButton = demoEntryButton(page)
      await expect(demoButton).toBeVisible({ timeout: 15_000 })
      await demoButton.click()

      // 2) 等 run 开始与结束（真实工具执行：list/read/run_command/write_file/open_artifact）
      await waitForRunStarted(page, 30_000)
      const finished = await waitForRunFinished(page, 180_000)
      expect(finished.reason, '演示必须完整跑完').toBe('complete')

      // 3) store 状态：run 收尾、产物 ≥1、canvas 自动打开
      const state = await readStore(page)
      expect(state.run).toBeNull()
      expect(state.bootError).toBeNull()
      expect(state.session).not.toBeNull()
      const session = state.session!
      expect(session.artifacts.length).toBeGreaterThanOrEqual(1)
      expect(session.messages.length).toBeGreaterThanOrEqual(2)
      expect(session.todos.length).toBeGreaterThan(0)
      expect(session.todos.some((todo) => todo.status === 'completed')).toBe(true)
      await expect.poll(async () => (await readStore(page)).canvas.open, { timeout: 15_000 }).toBe(true)

      // 4) 画布 iframe 真实渲染
      const iframe = page.locator('iframe').first()
      await expect(iframe).toBeVisible({ timeout: 15_000 })

      // 5) HTML 报告文件真实落盘且内容像一份报告
      const htmlArtifact = session.artifacts.find((artifact) => artifact.kind === 'html') ?? session.artifacts[0]
      expect(htmlArtifact.path, '产物应带工作区路径').toBeTruthy()
      const reportPath = htmlArtifact.path!
      expect(statSync(reportPath).size).toBeGreaterThan(1024)
      const html = readFileSync(reportPath, 'utf8')
      expect(html).toMatch(/<html|<!doctype/i)
      expect(html.length).toBeGreaterThan(1024)

      // 6) 事件质量：无 error；工具调用（真实执行）全部成功；演示步骤事件存在
      const events = await getEvents(page)
      const errors = events.filter((event) => event.type === 'error')
      expect(errors, `出现 error 事件：${JSON.stringify(errors)}`).toEqual([])
      const toolFinished = events.filter((event) => event.type === 'tool_finished')
      expect(toolFinished.length).toBeGreaterThanOrEqual(4)
      for (const event of toolFinished) {
        expect((event.result as { ok?: boolean } | undefined)?.ok, `工具失败：${JSON.stringify(event)}`).toBe(true)
      }
      expect(events.some((event) => event.type === 'demo_step')).toBe(true)
      expect(events.some((event) => event.type === 'artifacts_updated')).toBe(true)

      // 7) 截图证据（画布打开态）
      await page.screenshot({ path: screenshotPath('demo-run.png') })

      // 8) 画布交互：关闭 → 从产物重新打开，iframe 再次渲染
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .closeCanvas()
      })
      await expect.poll(async () => (await readStore(page)).canvas.open, { timeout: 10_000 }).toBe(false)
      await page.evaluate((artifactId: string) => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openCanvas(artifactId)
      }, htmlArtifact.id)
      await expect(page.locator('iframe').first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await morrow.close()
    }
  })

  test('@core:permissions 权限卡「拒绝」：Mock LLM 触发 write_file → 真实点拒绝 → denied、文件未写入、run 正常结束', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-perm-deny-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个测试文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: '../permission-test-deny.md', content: 'hello from mock' } }]
        },
        { text: '好，那我不写文件了，你想让我怎么整理？' }
      ]
    })
    const morrow = await launchMorrow({ name: 'permission-deny', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      // 注册本地 Mock provider（test-mode 下 127.0.0.1 允许无 Key）并建 ask 权限会话
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '权限测试 · 拒绝' })
      await sendMessageViaStore(page, '请帮我写一个测试文件 permission-test.md。')
      await waitForRunStarted(page, 30_000)

      // 1) 审批请求到达 → 真实审批卡出现（写文件 = write 类）
      const request = await waitForPermission(page, 60_000)
      expect(request.toolName).toBe('write_file')
      const card = page.locator('.permission-card')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(card).toContainText('允许一次')
      await expect(card).toContainText('当前文件夹以外')
      await page.waitForTimeout(350) // 等入场动画结束，避免截到 opacity 0 的帧
      // 权限卡排版来自顶层 token，而不是组件级裸值
      await expect(card.locator('.permission-title')).toHaveCSS('font-size', '14px')
      await expect(card.locator('.permission-title')).toHaveCSS('font-weight', '600')
      await expect(card.locator('.permission-title')).toHaveCSS('line-height', '18.9px')
      await expect(card.locator('.permission-desc')).toHaveCSS('font-size', '12.5px')
      await expect(card.locator('.permission-desc')).toHaveCSS('font-weight', '450')
      await expect(card.locator('.permission-desc')).toHaveCSS('line-height', '21.5px')
      await expect(card.locator('.permission-risk')).toHaveCSS('font-size', '10px')
      await expect(card.locator('.permission-risk')).toHaveCSS('line-height', '10px')
      await expect(card.locator('.permission-foot')).toHaveCSS('font-size', '11px')
      await expect(card.locator('.permission-actions .perm-btn-primary')).toHaveCSS('font-size', '12.5px')
      await expect(card.locator('.permission-actions .perm-btn-primary')).toHaveCSS('font-weight', '500')
      await expect(card.locator('.permission-actions .perm-btn-primary')).toHaveCSS('line-height', '18.125px')
      await page.screenshot({ path: screenshotPath('permission-card-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('permission-card-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(250)

      // 2) 真实点击「拒绝」
      await clickPermissionCard(page, 'deny')
      const resolved = await waitForEvent(page, 'permission_resolved', (event) => event.decision === 'deny', 30_000)
      expect(resolved.decision).toBe('deny')

      // 3) 运行收尾：denied 工具结果回填给 Mock LLM，模型改用文字回复
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      const events = await getEvents(page)
      const denied = events.filter((event) => event.type === 'tool_finished' && event.denied === true)
      expect(denied.length).toBeGreaterThanOrEqual(1)
      expect((denied[0].result as { ok?: boolean } | undefined)?.ok).toBe(false)
      expect(events.filter((event) => event.type === 'error')).toEqual([])
      // 文件确实没写入
      expect(existsSync(join(workspace, '..', 'permission-test-deny.md'))).toBe(false)
      // Mock LLM 收到至少两轮（工具调用 → 工具结果回填）
      expect(mock.calls).toBeGreaterThanOrEqual(2)
      const state = await readStore(page)
      expect(state.run).toBeNull()
      await expect(page.locator('.spine')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('permission-denied.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('@core:permissions 权限卡「允许一次」：Mock LLM 触发 write_file → 真实点允许 → 文件写入、工具 success、run complete', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-perm-allow-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个测试文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: '../permission-test-allow.md', content: 'hello from mock' } }]
        },
        { text: '文件已经写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'permission-allow', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '权限测试 · 允许' })
      await sendMessageViaStore(page, '请帮我写一个测试文件 permission-test.md。')
      await waitForRunStarted(page, 30_000)

      await waitForPermission(page, 60_000)
      const card = page.locator('.permission-card')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(350) // 等入场动画结束，避免截到 opacity 0 的帧
      await clickPermissionCard(page, 'once')
      await waitForEvent(page, 'permission_resolved', (event) => event.decision === 'once', 30_000)

      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      const events = await getEvents(page)
      const toolFinished = events.filter((event) => event.type === 'tool_finished')
      expect(toolFinished.length).toBeGreaterThanOrEqual(1)
      expect(toolFinished.some((event) => event.denied === true)).toBe(false)
      for (const event of toolFinished) {
        expect((event.result as { ok?: boolean } | undefined)?.ok, `工具失败：${JSON.stringify(event)}`).toBe(true)
      }
      // 文件真实写入且内容正确
      const target = join(workspace, '..', 'permission-test-allow.md')
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('hello from mock')
      expect(mock.calls).toBeGreaterThanOrEqual(2)
      expect((await readStore(page)).run).toBeNull()
      await page.screenshot({ path: screenshotPath('permission-allowed.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('@core:sessions 会话恢复：完成一轮后重启同一 data-dir → 列表/消息/产物保留，画布可打开', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const dataDir = join(root, 'tmp', `e2e-restore-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `e2e-restore-chromium-${stamp}`)

    // 第一段：真实跑完一场演示
    const first = await launchMorrow({
      name: 'restore-1',
      env: { MORROW_DEMO_SPEED: '0.05' },
      dataDir,
      chromiumDir,
      timeoutMs: 90_000
    })
    let sessionId: string
    let artifactCount: number
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      await demoEntryButton(page).click()
      await waitForRunStarted(page, 30_000)
      const finished = await waitForRunFinished(page, 180_000)
      expect(finished.reason).toBe('complete')
      const state = await readStore(page)
      sessionId = state.activeSessionId!
      artifactCount = state.session?.artifacts.length ?? 0
      expect(artifactCount).toBeGreaterThanOrEqual(1)
      expect(state.session?.messages.length ?? 0).toBeGreaterThanOrEqual(2)
    } finally {
      await first.close()
    }
    // 等 Electron 完全退出、单实例锁释放
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // 第二段：同一 data-dir 重启（新的 Chromium user-data-dir）
    const second = await launchMorrow({ name: 'restore-2', dataDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      const boot = await waitForStoreReady(page)
      await dismissOnboarding(page)
      // bootstrap 的会话列表里必须有上一轮的会话
      expect(boot.sessions.some((meta) => meta.id === sessionId)).toBe(true)

      // 选中并加载 → 消息 / 产物 / 计划都还在
      await page.evaluate(async (id: string) => {
        return (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .selectSession(id)
      }, sessionId)
      const restored = await waitUntil(
        async () => {
          const snapshot = await readStore(page)
          return snapshot.session?.id === sessionId ? snapshot : null
        },
        20_000,
        '恢复会话加载'
      )
      expect(restored.session!.messages.length).toBeGreaterThanOrEqual(2)
      expect(restored.session!.artifacts.length).toBe(artifactCount)
      expect(restored.session!.todos.length).toBeGreaterThan(0)

      // 画布能从持久化的产物重新打开并渲染
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openCanvas()
      })
      await expect(page.locator('iframe').first()).toBeVisible({ timeout: 20_000 })
      await page.screenshot({ path: screenshotPath('e2e-restore.png') })
    } finally {
      await second.close()
    }
  })
})

})
})

test.describe("16-media", () => {
function makeWorkspace(): string {
  const dir = join(root, 'tmp', `e2e-media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(root, 'tests', 'fixtures', 'media', 'sample.mp4'), join(dir, 'clip.mp4'))
  return dir
}
async function latestArtifact(page: import('@playwright/test').Page) {
  const store = await readStore(page)
  return store.session?.artifacts[store.session.artifacts.length - 1] ?? null
}
test.describe('本地多媒体全链路', () => {
  let morrow: MorrowApp
  let mockLLM: Awaited<ReturnType<typeof startMockLLM>> | null = null
  let mockComfy: Awaited<ReturnType<typeof startMockComfyUI>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mockLLM?.close()
    await mockComfy?.close()
    mockLLM = null
    mockComfy = null
  })

  test('@core:media 设置、生成、编辑与预览', async () => {
    test.setTimeout(240_000)
    mockComfy = await startMockComfyUI({ delayMs: 350 })
    mockLLM = await startMockLLM({
      scripts: [
        {
          text: '我先用本机图片模型生成一张图。',
          toolCalls: [{ name: 'generate_image', arguments: { prompt: '一只站在雪地松林里的赤狐，清晨侧逆光，电影感特写', size: '1024x1024' } }]
        },
        { text: '图片已经生成，并放到画布上了。' }
      ]
    })
    morrow = await launchMorrow({ name: 'media-e2e', timeoutMs: 90_000 })
    const { page } = morrow
    const workspace = makeWorkspace()
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoTitle: false })
    })
    const provider = await configureMockProvider(page, mockLLM.openaiBaseUrl)
    await page.evaluate(async (url: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({
        mediaEngine: {
          enabled: true,
          comfyuiUrl: url,
          comfyuiDir: null,
          ffmpegPath: null,
          autoStart: false,
          imageTimeoutSec: 120,
          videoTimeoutSec: 300,
          outputDir: 'media'
        }
      })
    }, mockComfy.baseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '多媒体 E2E'
    })
    await installEventCollector(page)

    // 设置 → 多媒体：真实检测 mock 引擎、模型与 ffmpeg
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '多媒体' }).click()
    const mediaTab = settings.locator('.st-media')
    await expect(mediaTab).toBeVisible()
    await expect(settings.locator('.st-page-title')).toHaveText('多媒体')
    await expect(mediaTab).toContainText('本机引擎')
    await expect(mediaTab).toContainText('已连接', { timeout: 15_000 })
    await expect(mediaTab).toContainText('本地引擎')
    await expect(mediaTab).toContainText('导入模型')
    await expect(mediaTab).toContainText('Qwen-Image 2.1 Turbo')
    await expect(mediaTab).toContainText('MiniMax-H3 16G HiFi')
    await expect(mediaTab).toContainText('ffmpeg')
    await mediaTab.screenshot({ path: screenshotPath('media-settings-dark.png') })
    await settings.screenshot({ path: screenshotPath('media-settings-full-dark.png') })
    expect(await mediaTab.evaluate((element) => (element as HTMLElement).scrollWidth - (element as HTMLElement).clientWidth)).toBeLessThanOrEqual(1)
    await settings.getByText('Qwen-Image 2.1 Turbo').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: screenshotPath('media-settings-models-dark.png') })
    await settings.getByText('ffmpeg（剪辑）').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: screenshotPath('media-settings-ffmpeg-dark.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(200)
    await settings.locator('.st-panel').evaluate((element) => element.scrollTo({ top: 0 }))
    await page.waitForTimeout(200)
    await settings.screenshot({ path: screenshotPath('media-settings-light.png') })
    await settings.getByText('Qwen-Image 2.1 Turbo').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: screenshotPath('media-settings-models-light.png') })
    await setThemeViaStore(page, 'dark')
    await settings.getByRole('button', { name: '完成' }).click()
    await expect(settings).not.toBeVisible()

    // 图片生成 → 聊天内卡片 + 画布图片预览
    await clearEvents(page)
    await sendMessageViaStore(page, '帮我生成一张雪地赤狐的图片。')
    await waitForRunFinished(page, 90_000)
    const imageArtifact = await waitUntil(async () => {
      const artifact = await latestArtifact(page)
      return artifact?.path?.endsWith('.png') ? artifact : null
    }, 30_000, '图片成品')
    expect(existsSync(imageArtifact.path!)).toBe(true)
    const imageCard = page.locator('[data-testid="tool-media-card"]').last()
    await expect(imageCard).toBeVisible()
    await expect(imageCard).toHaveAttribute('data-media-kind', 'image')
    await expect(imageCard.locator('[data-testid="tool-media-thumb"]')).toBeVisible()
    await expect(page.locator('[data-testid="image-preview"]')).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => page.locator('.preview-image').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: screenshotPath('media-image-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('media-image-light.png') })
    await setThemeViaStore(page, 'dark')

    // 视频生成（不给参考图 → 自动先生成首帧）
    mockLLM.pushScript({
      text: '首帧已经准备好，我开始生成视频，需要一点时间。',
      toolCalls: [{ name: 'generate_video', arguments: { prompt: '<Picture 1> 里的赤狐轻轻眨眼，雪花飘落，镜头缓慢推近，环境声有轻风和鸟鸣', seconds: 5, quality: 'fast', aspect_ratio: '16:9' } }]
    })
    mockLLM.pushScript({ text: '视频生成好了，已经放进画布。' })
    await clearEvents(page)
    await sendMessageViaStore(page, '把这只狐狸做成一段 5 秒的视频。')
    await waitForRunFinished(page, 120_000)
    const videoArtifact = await waitUntil(async () => {
      const artifact = await latestArtifact(page)
      return artifact?.path?.endsWith('.mp4') ? artifact : null
    }, 30_000, '视频成品')
    expect(existsSync(videoArtifact.path!)).toBe(true)
    const videoCard = page.locator('[data-testid="tool-media-card"]').last()
    await expect(videoCard).toHaveAttribute('data-media-kind', 'video')
    await expect(videoCard.locator('[data-testid="tool-media-video"]')).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => videoCard.locator('[data-testid="tool-media-video"]').evaluate((element) => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0)
    await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: screenshotPath('media-video-dark.png') })

    // ffmpeg 剪辑：把工作区里的 clip.mp4 剪成 0.8 秒
    mockLLM.pushScript({
      text: '我把这段素材剪短。',
      toolCalls: [{ name: 'edit_media', arguments: { path: 'clip.mp4', operation: 'trim', start_seconds: 0, end_seconds: 0.8 } }]
    })
    mockLLM.pushScript({ text: '剪辑完成，画布上可以直接播放。' })
    await clearEvents(page)
    await sendMessageViaStore(page, '把 clip.mp4 剪成前 0.8 秒。')
    await waitForRunFinished(page, 120_000)
    const clipped = await waitUntil(async () => {
      const store = await readStore(page)
      return store.session?.artifacts.find((artifact) => artifact.path?.includes('clip-trim')) ?? null
    }, 30_000, '剪辑成品')
    expect(existsSync(clipped.path!)).toBe(true)
    await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 15_000 })

    // 图像编辑：把上一步生成的图片作为 reference，交给 Agent 改图
    const imageRel = relative(workspace, imageArtifact.path!).split(sep).join('/')
    mockLLM.pushScript({
      text: '我用刚才那张图做一次编辑。',
      toolCalls: [{ name: 'generate_image', arguments: { prompt: '以 <image1> 为编辑目标，保持狐狸的脸、姿势、雪林和光线不变，只在脖子上加一条蓝色围巾。', reference_path: imageRel, size: '1024x1024' } }]
    })
    mockLLM.pushScript({ text: '编辑后的图片已经放进画布。' })
    await clearEvents(page)
    await sendMessageViaStore(page, '给刚才的狐狸加一条蓝色围巾。')
    await waitForRunFinished(page, 120_000)
    const edited = await waitUntil(async () => {
      const store = await readStore(page)
      const artifacts = store.session?.artifacts ?? []
      return artifacts.length >= 4 ? artifacts[artifacts.length - 1] : null
    }, 30_000, '编辑成品')
    expect(edited.path).not.toBe(imageArtifact.path)
    expect(existsSync(edited.path!)).toBe(true)
    await expect(page.locator('[data-testid="image-preview"]')).toBeVisible({ timeout: 15_000 })

    // 跨模型短片：Qwen 首帧 → MiniMax 视频 → 取尾帧 → 下一镜 → 拼接
    mockLLM.pushScript({
      text: '我按分镜把图片和视频串起来，先生成首帧再逐镜推进。',
      toolCalls: [{
        name: 'generate_film',
        arguments: {
          style: '同一只戴红围巾的赤狐，雪松林，清晨侧光，电影感浅景深',
          quality: 'fast',
          shots: [
            { prompt: '狐狸轻轻眨眼，镜头缓慢推近，环境声是轻风' },
            { prompt: '狐狸转身走向树林，镜头跟随，雪粒飘落' }
          ]
        }
      }]
    })
    mockLLM.pushScript({ text: '短片已经拼接完成，可以在画布直接播放。' })
    await clearEvents(page)
    await sendMessageViaStore(page, '把这只狐狸做成一条两镜头的连贯短片。')
    await waitForRunFinished(page, 120_000)
    const film = await waitUntil(async () => {
      const store = await readStore(page)
      return store.session?.artifacts.find((artifact) => artifact.path?.includes('films') && artifact.path?.endsWith('.mp4')) ?? null
    }, 30_000, '短片成品')
    expect(existsSync(film.path!)).toBe(true)
    const filmCard = page.locator('[data-testid="tool-media-card"]').last()
    await expect(filmCard).toHaveAttribute('data-media-kind', 'video')
    await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: screenshotPath('media-film-dark.png') })

    // 服务确实收到了图像编辑工作流（LoadImage + images 引用），且视频工作流带 SaveVideo
    const graphs = mockComfy.graphs
    expect(graphs.some((graph) => JSON.stringify(graph).includes('"class_type":"SaveVideo"'))).toBe(true)
    expect(
      graphs.some(
        (graph) =>
          JSON.stringify(graph).includes('"class_type":"LoadImage"') &&
          JSON.stringify(graph).includes('"class_type":"TextEncodeQwenImage21"') &&
          JSON.stringify(graph).includes('"images.image_1"')
      )
    ).toBe(true)
    expect(
      mockComfy.graphs.some(
        (graph) =>
          JSON.stringify(graph).includes('"class_type":"MiniMaxH3ReferenceToVideo"') &&
          JSON.stringify(graph).includes('"ref_images.ref_image_0"')
      )
    ).toBe(true)
    // 第二镜从上一镜尾帧继续，走 FL2VA 的首帧锚定
    expect(
      mockComfy.graphs.some(
        (graph) =>
          JSON.stringify(graph).includes('"class_type":"MiniMaxH3ImageToVideo"') &&
          JSON.stringify(graph).includes('"first_frame":["ref0",0]')
      )
    ).toBe(true)
    expect(readFileSync(edited.path!).length).toBeGreaterThan(0)
  })
})
})

test.describe("17-memory", () => {
// ── 自进化建议（原 r19-evolution.spec.ts） ─────────────────────

const REVIEW_SUGGESTIONS = {
  suggestions: [
    {
      kind: 'memory',
      action: 'create',
      scope: 'project',
      title: '报表口径',
      text: '报表统一使用季度口径；数字保留两位小数。',
      tags: ['报表', '口径'],
      rationale: '用户明确要求以后都按这个口径处理。',
      confidence: 0.92
    },
    {
      kind: 'skill',
      action: 'create',
      name: 'release-pipeline',
      description: '把双形态交付整理成可重复执行的发布流程。',
      body: [
        '## 何时使用',
        '需要同时产出便携文件夹版和单文件版时。',
        '',
        '## 步骤',
        '1. 运行类型检查和单元测试。',
        '2. 构建并确认没有进程占用 app.asar。',
        '3. 打包单文件、运行冒烟并核对校验和。',
        '',
        '## 完成检查',
        '窗口能打开，使用说明与 SHA256SUMS 已更新。',
        '',
        '## 反模式',
        '不要跳过冒烟，也不要把 Morrow Data 放进交付包。'
      ].join('\n'),
      rationale: '这次任务形成了可复现的打包流程。',
      confidence: 0.88
    }
  ]
}
function isReviewRequest(ctx: { body?: unknown }): boolean {
  try {
    return JSON.stringify(ctx.body ?? {}).includes('经验编辑')
  } catch {
    return false
  }
}
test('@core:memory 强信号任务自动复盘，建议可采纳为真实记忆与技能', async () => {
  test.setTimeout(180_000)
  const workspace = join(root, 'tmp', `e2e-r19-evolution-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      { text: '先整理一版清单。' },
      { text: '明白，改成纯文本；以后都按这个口径。' }
    ],
    respond: (ctx: { body?: unknown }) =>
      isReviewRequest(ctx) ? { text: JSON.stringify(REVIEW_SUGGESTIONS) } : undefined
  })
  const morrow = await launchMorrow({ name: 'r19-evolution', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '自进化建议测试'
    })
    await page.evaluate(async () => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } }
      }).__morrowStore
      await store.getState().updateSettings({ evolutionEnabled: true })
    })
    await installEventCollector(page)

    await sendMessageViaStore(page, '帮我整理一份清单。')
    await waitForRunFinished(page, 60_000)
    await clearEvents(page)
    await sendMessageViaStore(page, '不要用表格，改成纯文本；以后都按季度口径。')
    await waitForRunFinished(page, 60_000)

    // 自动复盘在运行结束后异步发生；轮询真实 feature IPC，而不是等固定时间。
    const list = await waitUntil(
      async () => {
        const result = await page.evaluate(async (ws) => {
          const response = await window.morrow.features.invoke<{
            suggestions: Array<{ id: string; status: string; title: string }>
            pending: number
          }>('feature:evolution:list', { workspace: ws })
          return response.ok ? response.data : null
        }, workspace)
        return result && result.pending >= 2 ? result : null
      },
      45_000,
      '自动复盘生成两条建议'
    )
    expect(list.suggestions).toHaveLength(2)

    // 设置 → 功能与工具里的「记忆」入口显示待处理数量，避免建议被藏起来。
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } })
        .__morrowStore
      store.getState().openSettings()
    })
    const settingsDialog = page.getByRole('dialog', { name: '设置' })
    await expect(settingsDialog).toBeVisible({ timeout: 15_000 })
    await settingsDialog.getByRole('tab', { name: '功能与工具' }).click()
    await expect(page.locator('.st-tool-badge')).toHaveText('2')
    await page.screenshot({ path: screenshotPath('r19-evolution-badge-dark.png') })
    await page.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden()

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'memory' } }))
    })
    await expect(page.locator('.evo-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.evo-head-title')).toHaveText('Morrow 的建议')
    await expect(page.locator('.evo-card')).toHaveCount(2)
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r19-evolution-suggestions-dark.png') })

    // 展开技能建议，确认展示的是完整 SKILL.md，而不是只有一句摘要。
    const skillCard = page.locator('.evo-card').filter({ hasText: 'release-pipeline' })
    await skillCard.getByRole('button', { name: /查看 release-pipeline 的完整内容/ }).click()
    await expect(skillCard.locator('.evo-content')).toContainText('## 完成检查')
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r19-evolution-expanded-light.png') })
    await skillCard.getByRole('button', { name: /收起 release-pipeline 的完整内容/ }).click()
    await setThemeViaStore(page, 'dark')

    // 自动复盘开关是可持久化的真实设置；关闭后仍可手动检查。
    const toggle = page.getByRole('switch', { name: '任务完成后自动检查对话' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const store = (window as unknown as {
            __morrowStore: { getState: () => { settings: { evolutionEnabled: boolean } } }
          }).__morrowStore
          return store.getState().settings.evolutionEnabled
        })
      )
      .toBe(false)

    // 采纳记忆：真实写入项目 memories.json，并刷新当前项目列表。
    const memoryCard = page.locator('.evo-card').filter({ hasText: '报表口径' })
    await memoryCard.getByRole('button', { name: '采纳' }).click()
    await expect(page.locator('.evo-message.is-ok')).toContainText('已保存到记忆')
    await expect(page.locator('.mc-list')).toContainText('报表统一使用季度口径')
    await expect(page.locator('.evo-card')).toHaveCount(1)

    // 采纳技能：真实写 SKILL.md，并可从提示直接打开技能库。
    const remainingSkill = page.locator('.evo-card').filter({ hasText: 'release-pipeline' })
    await remainingSkill.getByRole('button', { name: '采纳' }).click()
    await expect(page.locator('.evo-message.is-ok')).toContainText('已保存为技能')
    await expect(page.locator('.evo-empty')).toBeVisible()

    const skills = await page.evaluate(async (ws) => {
      const response = await window.morrow.features.invoke<{
        skills: Array<{ name: string; id: string; source: string }>
      }>('feature:skills:list', { workspace: ws })
      return response.ok ? response.data : null
    }, workspace)
    expect(skills?.skills.some((skill) => skill.name === 'release-pipeline' && skill.source === 'user')).toBe(true)
    const skillMd = join(morrow.dataDir, 'skills', 'release-pipeline', 'SKILL.md')
    expect(readFileSync(skillMd, 'utf8')).toContain('name: release-pipeline')

    await expect(page.getByRole('button', { name: '打开技能库' })).toBeVisible()
    await page.getByRole('button', { name: '打开技能库' }).click()
    await expect(page.getByTestId('skills-panel')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('skills-panel')).toContainText('release-pipeline')
  } finally {
    await morrow.close()
    await mock.close()
  }
})
})
