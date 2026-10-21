/**
 * 多格式文件预览回归：图片 / PDF / DOCX / 音频 / 视频 / 大文本 / 不支持格式。
 * 走真实文件树点击 → 画布预览 → 本地协议读取，不 mock 文件内容。
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import {
  dismissOnboarding,
  setThemeViaStore,
  waitForStoreReady
} from './store'

const fixtures = join(root, 'tests', 'unit', 'core', 'fixtures', 'documents')
const mediaFixtures = join(root, 'tests', 'fixtures', 'media')

async function openFile(page: Page, name: string): Promise<void> {
  const row = page.locator(`[data-path-key="${encodeURIComponent(name)}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
}

async function shot(page: Page, name: string, theme: 'dark' | 'light'): Promise<void> {
  await setThemeViaStore(page, theme)
  await page.waitForTimeout(450)
  await page.screenshot({ path: screenshotPath(`preview-${name}-${theme}.png`) })
}

test.describe('多格式文件预览', () => {
  test('图片、PDF、DOCX、音视频、大文本与不支持格式均可预览', async () => {
    test.setTimeout(240_000)
    const workspace = join(root, 'tmp', `e2e-preview-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    copyFileSync(join(root, 'build', 'icon.png'), join(workspace, 'preview-image.png'))
    copyFileSync(join(fixtures, 'invoice-zh.pdf'), join(workspace, 'preview-invoice.pdf'))
    copyFileSync(join(fixtures, 'invoice-zh.docx'), join(workspace, 'preview-invoice.docx'))
    copyFileSync(join(mediaFixtures, 'sample.wav'), join(workspace, 'preview-audio.wav'))
    copyFileSync(join(mediaFixtures, 'sample.mp3'), join(workspace, 'preview-audio.mp3'))
    copyFileSync(join(mediaFixtures, 'sample.webm'), join(workspace, 'preview-video.webm'))
    copyFileSync(join(mediaFixtures, 'sample.mp4'), join(workspace, 'preview-video.mp4'))
    writeFileSync(join(workspace, 'preview-unsupported.7z'), Buffer.from('7z\u00bc\u00af\u0027\u001c', 'binary'))
    writeFileSync(join(workspace, 'preview-large.txt'), '大文件预览\n' + 'x'.repeat(9 * 1024 * 1024), 'utf8')

    const packagedExe = process.env.MORROW_PREVIEW_EXE
    const morrow = await launchMorrow({
      name: 'file-previews',
      timeoutMs: 90_000,
      ...(packagedExe ? { executablePath: packagedExe } : {}),
      env: { MORROW_TEST_CSP: '1' }
    })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await page.evaluate(async (targetWorkspace: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        const created = await window.morrow.session.create({
          workspace: targetWorkspace,
          model: state.settings.defaultModel,
          permissionMode: 'read-only',
          title: '文件预览'
        })
        if (!created.ok) throw new Error(created.error.message)
        await store.getState().selectSession(created.data.id)
      }, workspace)
      await expect(page.locator('[data-path-key="preview-image.png"]')).toBeVisible({ timeout: 20_000 })

      await openFile(page, 'preview-image.png')
      await expect(page.locator('[data-testid="image-preview"]')).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(async () => page.locator('.preview-image').evaluate((image) => (image as HTMLImageElement).naturalWidth), { timeout: 20_000 })
        .toBeGreaterThan(0)
      await shot(page, 'image', 'dark')
      await shot(page, 'image', 'light')

      await setThemeViaStore(page, 'dark')
      await openFile(page, 'preview-invoice.pdf')
      await expect(page.locator('[data-testid="pdf-preview"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-testid="pdf-total-pages"]')).toContainText('/ 1 页', { timeout: 30_000 })
      await expect
        .poll(async () => page.locator('.preview-pdf-canvas').evaluate((canvas) => canvas.width), { timeout: 30_000 })
        .toBeGreaterThan(0)
      const pdfMetrics = await page.evaluate(() => {
        const stage = document.querySelector('.preview-pdf-stage') as HTMLElement | null
        return {
          docWidth: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
          stageWidth: stage?.scrollWidth ?? null,
          stageClient: stage?.clientWidth ?? null
        }
      })
      expect(pdfMetrics.docWidth).toBeLessThanOrEqual(pdfMetrics.docClient)
      expect(pdfMetrics.stageWidth).toBeLessThanOrEqual(pdfMetrics.stageClient)
      await shot(page, 'pdf', 'dark')
      await shot(page, 'pdf', 'light')

      await setThemeViaStore(page, 'dark')
      await openFile(page, 'preview-invoice.docx')
      await expect(page.locator('[data-testid="docx-preview"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.frameLocator('.preview-docx-frame').locator('body')).toContainText('发票', { timeout: 20_000 })
      await shot(page, 'docx', 'dark')
      await shot(page, 'docx', 'light')

      await setThemeViaStore(page, 'dark')
      await openFile(page, 'preview-audio.wav')
      await expect(page.locator('[data-testid="audio-preview"]')).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(async () => page.locator('audio.preview-audio').evaluate((audio) => (audio as HTMLAudioElement).readyState), { timeout: 20_000 })
        .toBeGreaterThan(0)
      await shot(page, 'audio', 'dark')
      await shot(page, 'audio', 'light')

      await setThemeViaStore(page, 'dark')
      await openFile(page, 'preview-audio.mp3')
      await expect
        .poll(async () => page.locator('audio.preview-audio').evaluate((audio) => (audio as HTMLAudioElement).readyState), { timeout: 20_000 })
        .toBeGreaterThan(0)

      await openFile(page, 'preview-video.webm')
      await expect(page.locator('[data-testid="video-preview"]')).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(async () => page.locator('video.preview-video').evaluate((video) => (video as HTMLVideoElement).videoWidth), { timeout: 25_000 })
        .toBeGreaterThan(0)
      await shot(page, 'video', 'dark')
      await shot(page, 'video', 'light')
      // 浅色主题下视频舞台必须跟随明色表面，不能保留近黑背景
      const videoStageBg = await page
        .locator('.preview-video-stage')
        .evaluate((element) => getComputedStyle(element).backgroundColor)
      const [r, g, b] = (videoStageBg.match(/\d+/g) ?? []).map(Number)
      expect((r + g + b) / 3).toBeGreaterThan(180)

      await setThemeViaStore(page, 'dark')
      await openFile(page, 'preview-video.mp4')
      await expect
        .poll(async () => page.locator('video.preview-video').evaluate((video) => (video as HTMLVideoElement).videoWidth), { timeout: 25_000 })
        .toBeGreaterThan(0)

      await openFile(page, 'preview-large.txt')
      await expect(page.locator('.editor-banner.is-danger')).toContainText('文件较大', { timeout: 30_000 })
      await shot(page, 'large-text', 'dark')

      await openFile(page, 'preview-unsupported.7z')
      await expect(page.locator('[data-testid="unsupported-preview"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-testid="unsupported-preview"]')).toContainText('暂不支持')
      await shot(page, 'unsupported', 'dark')
    } finally {
      await morrow.close()
    }
  })
})
