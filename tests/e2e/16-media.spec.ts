/**
 * 本地多媒体全链路：设置 → Agent 生成图片/视频 → 聊天内预览 → 画布预览 → ffmpeg 剪辑 → 图像编辑。
 * 使用真实 Electron + 本地 ComfyUI mock（返回真实 PNG/MP4），不依赖 GPU。
 *
 * 合并自 19-code-render.spec.ts、20-concat.spec.ts；每个原 spec 整体包在独立 test.describe 中，
 * 各自管理启动的 Electron / mock 资源，不共用原有 afterEach，也不产生顺序依赖。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { startMockComfyUI } from '../fixtures/mock-comfyui.mjs'
import {
  clearEvents,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

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

  test('设置、生成、编辑与预览', async () => {
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

/**
 * 真实短片：默认跳过，需先启动本机 ComfyUI（模型齐全）后运行：
 *   MORROW_MEDIA_REAL=1 npx playwright test tests/e2e/16-media.spec.ts -g "雨后纸鹤"
 * 使用 mock LLM 只负责发出工具调用，图像/视频/拼接全部由真实 ComfyUI 与 ffmpeg 完成。
 */
const describeReal = process.env.MORROW_MEDIA_REAL === '1' ? test.describe : test.describe.skip

describeReal('真实短片《雨后纸鹤》', () => {
  test('两镜连续短片生成、拼接与预览', async () => {
    test.setTimeout(20 * 60_000)
    const mockLLM = await startMockLLM({
      scripts: [
        {
          text: '我按两个镜头来做：先定住雨巷里的纸鹤，再让它起飞，最后拼成一条短片。',
          toolCalls: [{
            name: 'generate_film',
            arguments: {
              style: '同一只暖白色折纸鹤，由纸张折叠而成：折痕清晰、翼面平直、边缘挺括，绝不呈现羽毛或布料质感；江南雨后青石巷，湿润反光，清晨薄雾，暖色侧光，写实电影感，35mm 浅景深，画面中无人物无文字',
              quality: 'fast',
              aspect_ratio: '16:9',
              seed: 20261024,
              shots: [
                {
                  prompt: '纸鹤停在青石巷的积水旁，屋檐雨滴落下，水面泛起细小涟漪；镜头从纸鹤身后缓慢向前推进，环境声是屋檐滴水与远处鸟鸣。',
                  image_prompt: '一只暖白色折纸鹤停在雨后青石巷的积水边，折痕清晰、翼面平直，倒影清晰，屋檐滴水，晨雾和暖色侧光，画面无人物无文字。'
                },
                {
                  prompt: '保持首帧折纸鹤的全部几何结构：清晰的折纸折痕、硬直的三角纸翼、纸张纤维质感；不要变成真鸟、布料或羽毛，不要长出长尾，不要出现第二只鸟。纸鹤以折纸动画的方式展开两只三角纸翼，贴着青石巷飞向巷口晨光；镜头从侧后方跟随并缓慢抬升，水洼倒影掠过，环境声有轻风与纸张振动。'
                }
              ]
            }
          }]
        },
        { text: '两镜已经拍完并拼接成片，可以在画布播放；我保留了首帧作为封面。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'simple-film', timeoutMs: 120_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ autoTitle: false })
        await store.getState().updateSettings({
          mediaEngine: {
            enabled: true,
            comfyuiUrl: 'http://127.0.0.1:8188',
            comfyuiDir: 'C:/AI/MorrowMedia/ComfyUI',
            ffmpegPath: null,
            autoStart: true,
            imageTimeoutSec: 600,
            videoTimeoutSec: 3600,
            outputDir: 'media'
          }
        })
      })
      const provider = await configureMockProvider(page, mockLLM.openaiBaseUrl)
      const workspace = join(root, 'tmp', `e2e-simple-film-${Date.now()}`)
      mkdirSync(workspace, { recursive: true })
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: '雨后纸鹤'
      })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请做一条 10 秒左右的短片：雨后青石巷里的一只暖白色纸鹤先停在水边，再展翅飞向巷口晨光。要两镜连续，写实电影感，不要文字和人物。')

      const finished = await waitForRunFinished(page, 18 * 60_000)
      expect(finished.reason ?? 'complete').toBe('complete')
      const film = await waitUntil(async () => {
        const store = await readStore(page)
        return store.session?.artifacts.find((artifact) => artifact.path?.includes('films') && artifact.path?.endsWith('.mp4')) ?? null
      }, 60_000, '短片成品')
      expect(existsSync(film.path!)).toBe(true)

      const evidenceDir = join(root, 'docs', 'verification', 'media', 'simple-film')
      mkdirSync(evidenceDir, { recursive: true })
      const evidenceFilm = join(evidenceDir, 'rain-paper-crane-2shot.mp4')
      copyFileSync(film.path!, evidenceFilm)
      const probe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type', '-of', 'json', evidenceFilm], { encoding: 'utf8' })
      ) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> }
      const duration = Number(probe.format?.duration ?? 0)
      const streams = (probe.streams ?? []).map((stream) => stream.codec_type)
      expect(streams).toContain('video')
      expect(streams).toContain('audio')
      expect(duration).toBeGreaterThan(9)
      expect(duration).toBeLessThan(13)
      for (const [name, at] of [['01-start', 0.8], ['02-shot1-end', 4.8], ['03-shot2-start', 5.6], ['04-end', 9.4]] as const) {
        execFileSync('ffmpeg', ['-y', '-ss', String(at), '-i', evidenceFilm, '-frames:v', '1', join(evidenceDir, `${name}.png`)], { stdio: 'ignore' })
      }

      await expect(page.locator('[data-testid="tool-media-card"]').last()).toHaveAttribute('data-media-kind', 'video')
      await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('media-simple-film-dark.png') })
      console.log(JSON.stringify({ film: evidenceFilm, duration, streams }, null, 2))
    } finally {
      await morrow.close()
      await mockLLM.close()
    }
  })
})

// ── 原文件：19-code-render.spec.ts ──────────────────────────────────────────────
test.describe('19-code-render.spec.ts', () => {
/**
 * 代码镜头渲染：coder390 生成的 HTML → Morrow render_animation → 画布播放。
 * 不需要 ComfyUI/GPU 生成模型；使用真实 Electron 离屏渲染 + ffmpeg。
 */

test('coder390 HTML 代码镜头：render_animation → 画布播放', async () => {
  test.setTimeout(180_000)
  const workspace = join(root, 'tmp', `code-render-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  copyFileSync(join(root, 'tests', 'fixtures', 'media', 'code-shot.html'), join(workspace, 'code-shot.html'))
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我用代码模型生成的 HTML 渲染这一镜。',
        toolCalls: [{
          name: 'render_animation',
          arguments: {
            html_path: 'code-shot.html',
            duration_seconds: 3,
            fps: 24,
            width: 960,
            height: 544,
            time_unit: 'milliseconds'
          }
        }]
      },
      { text: '代码镜头已经渲染完成，放到画布上了。' }
    ]
  })
  let morrow: MorrowApp | null = null
  try {
    morrow = await launchMorrow({ name: 'code-render', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoTitle: false })
    })
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '代码镜头渲染' })
    await installEventCollector(page)
    await clearEvents(page)
    await sendMessageViaStore(page, '把 code-shot.html 渲染成 3 秒的代码镜头。')
    await waitForRunFinished(page, 120_000)
    const video = await waitUntil(async () => {
      const store = await readStore(page)
      return store.session?.artifacts.find((artifact) => artifact.path?.includes('code') && artifact.path?.endsWith('.mp4')) ?? null
    }, 30_000, '代码镜头成品')
    expect(existsSync(video.path!)).toBe(true)
    expect(statSync(video.path!).size).toBeGreaterThan(10_000)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', video.path!], { encoding: 'utf8' })
    expect(probe.status).toBe(0)
    const info = JSON.parse(probe.stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
    expect((info.streams ?? []).some((stream) => stream.codec_type === 'video')).toBe(true)
    expect(Number(info.format?.duration ?? 0)).toBeGreaterThan(2.5)
    await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => page.locator('.preview-video').evaluate((element) => (element as HTMLVideoElement).videoWidth)).toBeGreaterThan(0)
    await expect(page.locator('[data-testid="tool-media-card"]')).toHaveAttribute('data-media-kind', 'video')
    await page.screenshot({ path: screenshotPath('media-code-render-dark.png') })
    const evidence = join(root, 'docs', 'verification', 'media')
    mkdirSync(evidence, { recursive: true })
    copyFileSync(video.path!, join(evidence, 'coder390-code-shot.mp4'))
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2.8', '-i', video.path!, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', join(evidence, 'coder390-code-shot-poster.jpg')])
  } finally {
    await morrow?.close()
    await mock.close()
  }
})

test('当前模型支持视觉时优先审看图片：describe_media → Morrow 工具结果', async () => {
  test.setTimeout(180_000)
  const workspace = join(root, 'tmp', `vision-check-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  copyFileSync(join(root, 'tests', 'fixtures', 'media', 'sample.png'), join(workspace, 'sample.png'))
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我先审看这张图。',
        toolCalls: [{
          name: 'describe_media',
          arguments: { path: 'sample.png', question: '这张图里有哪些形状和颜色？用中文简短回答。' }
        }]
      },
      { text: '图片里有一个蓝色圆形和一个橙色方形。' },
      { text: '视觉审看完成。' }
    ]
  })
  let morrow: MorrowApp | null = null
  try {
    morrow = await launchMorrow({ name: 'vision-check', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoTitle: false })
    })
    const provider = await configureMockProvider(page, mock.openaiBaseUrl, 'mock-vision', 32_000, true)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '多模态审看' })
    await installEventCollector(page)
    await clearEvents(page)
    await sendMessageViaStore(page, '审看 sample.png 里有哪些形状和颜色。')
    await waitForRunFinished(page, 120_000)
    await expect(page.locator('.spine-row').filter({ hasText: '审看' }).first()).toBeVisible({ timeout: 30_000 })
    const transcript = JSON.stringify(mock.requests)
    // 当前 mock 模型声明 supportsVision：图片应直接发给它，而不是去找本机 coder390。
    expect(transcript).toContain('image_url')
    expect(transcript).toContain('Mock Model')
    expect(transcript).toContain('蓝色圆形')
    expect(transcript).not.toContain('媒体审看失败')
    expect(transcript).not.toContain('Qwen3.8 27B')
    expect(transcript.length).toBeGreaterThan(1000)
    await page.screenshot({ path: screenshotPath('media-vision-dark.png') })
  } finally {
    await morrow?.close()
    await mock.close()
  }
})
})

// ── 原文件：20-concat.spec.ts ──────────────────────────────────────────────
test.describe('20-concat.spec.ts', () => {
/** 拼接修复回归：生成短片 + 代码镜头，音视频必须同长。 */

test('拼接两段视频时音视频长度一致（-shortest）', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `concat-check-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  copyFileSync(join(root, 'tests/fixtures/media/sample.mp4'), join(workspace, 'clip-a.mp4'))
  copyFileSync(join(root, 'tests/fixtures/media/sample-32k.mp4'), join(workspace, 'clip-b-32k.mp4'))
  const mock = await startMockLLM({
    scripts: [
      { text: '拼接最终片。', toolCalls: [{ name: 'edit_media', arguments: { operation: 'concat', paths: ['clip-a.mp4', 'clip-b-32k.mp4'] } }] },
      { text: '最终片已拼接完成。' }
    ]
  })
  let morrow: MorrowApp | null = null
  try {
    morrow = await launchMorrow({ name: 'concat-check', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '拼接验收' })
    await installEventCollector(page)
    await clearEvents(page)
    await sendMessageViaStore(page, '把 clip-a.mp4 和 clip-b-32k.mp4 拼成最终片。')
    await waitForRunFinished(page, 90_000)
    const final = await waitUntil(async () => {
      const store = await readStore(page)
      return store.session?.artifacts.find((artifact) => artifact.path?.includes('concat') && artifact.path?.endsWith('.mp4')) ?? null
    }, 30_000, '最终拼接片')
    expect(existsSync(final.path!)).toBe(true)
    expect(statSync(final.path!).size).toBeGreaterThan(20_000)
    const probe = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', final.path!], { encoding: 'utf8' })
    expect(probe.status).toBe(0)
    const data = JSON.parse(probe.stdout) as { streams: Array<Record<string, unknown>>; format: Record<string, unknown> }
    const video = data.streams.find((stream) => stream.codec_type === 'video')
    const audio = data.streams.find((stream) => stream.codec_type === 'audio')
    expect(Number(video?.duration ?? 0)).toBeCloseTo(2, 0)
    expect(Number(audio?.duration ?? 0)).toBeCloseTo(Number(video?.duration ?? 0), 0)
    expect(Number(data.format.duration ?? 0)).toBeLessThan(3)
    await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: screenshotPath('media-final-concat-dark.png') })
    // 拼接回归只保留临时结果，不再写入交付样片
  } finally {
    await morrow?.close()
    await mock.close()
  }
})
})


// ── 原文件：25-media-model-form.spec.ts ───────────────────────────────────────
test.describe('多媒体 · 应用内添加本机模型', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('填写名称、引擎、能力与本地文件即可注册模型，无需 JSON 清单或 Agent', async () => {
    const dir = join(root, 'tmp', `media-form-${Date.now()}`)
    const modelDir = join(dir, 'models')
    mkdirSync(modelDir, { recursive: true })
    const modelFile = join(modelDir, 'e2e-local.gguf')
    writeFileSync(modelFile, Buffer.alloc(2048))

    morrow = await launchMorrow({ name: 'media-model-form', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    const registered = await page.evaluate(async (engineDir) => {
      const result = await window.morrow.features.invoke('feature:media:catalog-action', {
        action: 'register-engine',
        manifest: {
          id: 'e2e-local-files',
          label: 'E2E 本地引擎',
          kind: 'custom',
          capabilities: ['chat'],
          source: 'user',
          modelDir: engineDir
        }
      })
      return result.ok
    }, modelDir)
    expect(registered).toBe(true)

    // 模型下载目录里的文件不在引擎目录内：导入时应自动复制，而不是让用户手动搬运。
    const outsideFile = join(dir, 'outside.gguf')
    writeFileSync(outsideFile, Buffer.alloc(4096))
    const copied = await page.evaluate(async (args: { engineId: string; source: string }) => {
      const result = (await window.morrow.features.invoke('feature:media:resolve-model-files', {
        engineId: args.engineId,
        paths: [args.source]
      })) as { ok: boolean; data?: Array<{ dest: string; copied: boolean }>; error?: { message: string } }
      return result.ok ? { ok: true, file: result.data?.[0] ?? null } : { ok: false, message: result.error?.message ?? '' }
    }, { engineId: 'e2e-local-files', source: outsideFile })
    expect(copied).toMatchObject({ ok: true, file: { dest: 'outside.gguf', copied: true } })
    expect(existsSync(join(modelDir, 'outside.gguf'))).toBe(true)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '多媒体' }).click()
    const mediaTab = settings.locator('.st-media')
    await expect(mediaTab).toBeVisible()

    await settings.getByRole('button', { name: '添加本机模型' }).click()
    const form = settings.locator('.st-media-model-form')
    await expect(form).toBeVisible()
    await form.scrollIntoViewIfNeeded()
    await settings.screenshot({ path: screenshotPath('media-model-form-top-dark.png') })
    await form.getByLabel('模型名称').fill('E2E 本机模型')
    await form.getByLabel('模型 ID（可选）').fill('e2e-local-model')
    await form.getByRole('button', { name: '模型引擎' }).click()
    await form.getByRole('option', { name: 'E2E 本地引擎' }).click()
    await form.getByLabel('模型文件（每行一个绝对路径）').fill(modelFile)
    await settings.screenshot({ path: screenshotPath('media-model-form-dark.png') })
    await form.getByRole('button', { name: '保存模型' }).click()

    await expect(mediaTab).toContainText('E2E 本机模型', { timeout: 15_000 })
    await expect(mediaTab).toContainText('已安装')
    const catalog = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:media:catalog')
      return result.ok ? result.data : null
    })
    const model = catalog?.models?.find((item: { id: string }) => item.id === 'e2e-local-model')
    expect(model).toMatchObject({ engine: 'e2e-local-files', installed: true })
    expect(model.installType).toBe('files')
    await settings.screenshot({ path: screenshotPath('media-model-form-saved-dark.png') })
  })

  test('添加 llama.cpp GGUF 后同步到模型选择器的 llama.cpp 提供方', async () => {
    const marker = `morrow-e2e-${Date.now()}`
    let modelFile = ''
    morrow = await launchMorrow({ name: 'media-model-form-llama', timeoutMs: 90_000 })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const engine = await page.evaluate(async () => {
        const result = await window.morrow.features.invoke('feature:media:catalog')
        if (!result.ok) return null
        return result.data.engines.find((item: { id: string }) => item.id === 'llamacpp') ?? null
      })
      expect(engine?.modelDir).toBeTruthy()
      const dir = join(engine.modelDir, marker)
      mkdirSync(dir, { recursive: true })
      modelFile = join(dir, 'e2e-tiny.gguf')
      writeFileSync(modelFile, Buffer.alloc(1024))

      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible' })
      await settings.getByRole('tab', { name: '多媒体' }).click()
      await settings.getByRole('button', { name: '添加本机模型' }).click()
      const form = settings.locator('.st-media-model-form')
      await form.getByLabel('模型名称').fill('E2E 本地 GGUF')
      await form.getByLabel('模型 ID（可选）').fill(marker)
      await form.getByLabel('模型文件（每行一个绝对路径）').fill(modelFile)
      await form.getByRole('button', { name: '保存模型' }).click()
      await expect(settings.locator('.st-media')).toContainText('E2E 本地 GGUF', { timeout: 15_000 })

      const provider = await page.evaluate(async () => {
        const result = await window.morrow.settings.get()
        if (!result.ok) return null
        return result.data.providers.find((item: { id: string }) => item.id === 'llamacpp') ?? null
      })
      expect(provider?.models?.some((model: { id: string }) => model.id === marker)).toBe(true)
    } finally {
      if (modelFile) {
        try { rmSync(modelFile, { force: true }) } catch { /* 清理失败不影响测试结论 */ }
        try { rmSync(join(modelFile, '..'), { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  })
})

test('ComfyUI 自定义工作流：应用内粘贴 API 工作流即可注册模型', async () => {
  const comfyDir = join(root, 'tmp', `media-comfy-form-${Date.now()}`)
  mkdirSync(join(comfyDir, 'models'), { recursive: true })
  let morrow: MorrowApp | null = null
  try {
    morrow = await launchMorrow({ name: 'media-comfy-form', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (dir: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const settings = store.getState().settings
      await store.getState().updateSettings({
        mediaEngine: { ...settings.mediaEngine, comfyuiDir: dir, comfyuiUrl: 'http://127.0.0.1:59999', autoStart: false }
      })
    }, comfyDir)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '多媒体' }).click()
    await settings.getByRole('button', { name: '添加本机模型' }).click()
    const form = settings.locator('.st-media-model-form')
    await expect(form).toBeVisible()
    await form.getByRole('button', { name: '模型引擎' }).click()
    await form.getByRole('option', { name: 'ComfyUI' }).click()
    await expect(form.getByText('ComfyUI 工作流 JSON（API 格式）')).toBeVisible()
    await form.getByLabel('模型名称').fill('E2E 工作流模型')
    await form.getByLabel('模型 ID（可选）').fill('e2e-comfy-workflow')
    await form.getByLabel('ComfyUI 工作流 JSON（API 格式）').fill(
      JSON.stringify({ '9': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'morrow/e2e' } } })
    )
    await form.getByLabel('输出节点 ID').fill('9')
    await form.getByRole('button', { name: '保存模型' }).click()
    await expect(settings.locator('.st-media')).toContainText('E2E 工作流模型', { timeout: 15_000 })

    const model = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:media:catalog')
      if (!result.ok) return null
      return result.data.models.find((item: { id: string }) => item.id === 'e2e-comfy-workflow') ?? null
    })
    expect(model).toMatchObject({ kind: 'image', engine: 'comfyui', installed: true })
  } finally {
    await morrow?.close()
    try {
      rmSync(comfyDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
