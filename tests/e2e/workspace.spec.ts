// workspace 领域 E2E：由 4 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import JSZip from 'jszip'
import type { MorrowApp } from './launch'
import { launchMorrow, root, screenshotPath, screensDir } from './launch'
import { createUiSession, dismissOnboarding, readStore, setThemeViaStore, waitForStoreReady, waitUntil, configureMockProvider, createSession, installEventCollector, sendMessageViaStore, waitForRunFinished, clearEvents, getEvents, openToolPanel, waitForEvent } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

async function listShells(page: Page): Promise<Array<{ id: string; shellId?: string; status: string }>> {
  return page.evaluate(async () => {
    const result = await window.morrow.features.invoke('feature:terminal:list')
    return result.ok
      ? ((result.data as { processes: Array<{ id: string; shellId?: string; status: string; kind: string }> }).processes)
          .filter((process) => process.kind === 'shell')
          .map((process) => ({ id: process.id, shellId: process.shellId, status: process.status }))
      : []
  })
}

test.describe("05-files", () => {
// ── 原文件：file-previews.spec.ts ──────────────────────────────────────────────
test.describe('file-previews.spec.ts', () => {
/**
 * 多格式文件预览回归：图片 / PDF / DOCX / 音频 / 视频 / 大文本 / 不支持格式。
 * 走真实文件树点击 → 画布预览 → 本地协议读取，不 mock 文件内容。
 */

const fixtures = join(root, 'tests', 'fixtures', 'documents')
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
      const pdfDarkPixel = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.preview-pdf-canvas')
        const context = canvas?.getContext('2d')
        const data = context?.getImageData(Math.max(0, canvas.width - 4), Math.max(0, canvas.height - 4), 1, 1).data
        return data ? [data[0], data[1], data[2]] : null
      })
      expect(pdfDarkPixel).not.toBeNull()
      await expect(page.locator('.preview-pdf-image')).toBeVisible({ timeout: 20_000 })
      const pdfImagePixel = await page.evaluate(async () => {
        const image = document.querySelector<HTMLImageElement>('.preview-pdf-image')
        if (!image) return null
        if (!image.complete) await image.decode().catch(() => undefined)
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        context?.drawImage(image, 0, 0)
        const data = context?.getImageData(Math.max(0, canvas.width - 4), Math.max(0, canvas.height - 4), 1, 1).data
        return data ? { pixel: [data[0], data[1], data[2]], naturalWidth: image.naturalWidth, srcPrefix: image.src.slice(0, 32) } : null
      })
      console.log('PDF_IMAGE', JSON.stringify(pdfImagePixel))
      expect((pdfDarkPixel?.[0] ?? 255) + (pdfDarkPixel?.[1] ?? 255) + (pdfDarkPixel?.[2] ?? 255)).toBeLessThan(180)
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

})
// ── 原文件：file-preview-extended.spec.ts ──────────────────────────────────────────────
test.describe('file-preview-extended.spec.ts', () => {
/**
 * 文件预览扩展 E2E：
 * - XLSX 多工作表表格、PPTX 幻灯片文本、ZIP 文件列表、RTF 文档；
 * - CSV 编辑器内表格预览、SVG 图形预览；
 * - 旧版 .doc 明确提示用系统应用打开；
 * - 明暗主题截图。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function writeZip(workspace: string, name: string, files: Record<string, string>): Promise<void> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  writeFileSync(join(workspace, name), await zip.generateAsync({ type: 'nodebuffer' }))
}

function xlsxFiles(): Record<string, string> {
  return {
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Month</t></si><si><t>Amount</t></si><si><t>Jan</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Note</t></is></c></row></sheetData></worksheet>'
  }
}

function pptxFiles(): Record<string, string> {
  const slide = (title: string, line: string): string =>
    '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>' +
    `<a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${line}</a:t></a:r></a:p>` +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  return {
    'ppt/slides/slide1.xml': slide('Quarterly Sales', 'Revenue up 12%'),
    'ppt/slides/slide2.xml': slide('Next Steps', 'Expand to two regions')
  }
}

function openFile(page: Page, path: string): Promise<void> {
  return page.evaluate((filePath) => {
    window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path: filePath } }))
  }, path)
}

async function createPreviewSession(page: Page, workspace: string): Promise<void> {
  await page.evaluate(async (ws) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const state = store.getState()
    const created = await window.morrow.session.create({
      workspace: ws,
      model: state.settings.defaultModel,
      permissionMode: 'auto',
      title: '文件预览测试'
    })
    if (!created.ok) throw new Error(created.error.message)
    await store.getState().selectSession(created.data.id)
  }, workspace)
}

test('常见文档、压缩包、表格与图形均可打开', async () => {
  test.setTimeout(180_000)
  const workspace = workspaceAt('e2e-preview-extended')
  writeFileSync(join(workspace, 'sales.csv'), 'Month,Amount\nJan,100\nFeb,120\n', 'utf8')
  writeFileSync(join(workspace, 'note.rtf'), '{\\rtf1\\ansi Hello from RTF \\par Second line}', 'utf8')
  writeFileSync(join(workspace, 'legacy.doc'), 'legacy', 'utf8')
  writeFileSync(
    join(workspace, 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#c8ae7d"/></svg>',
    'utf8'
  )
  await writeZip(workspace, 'sales.xlsx', xlsxFiles())
  await writeZip(workspace, 'deck.pptx', pptxFiles())
  await writeZip(workspace, 'bundle.zip', { 'docs/readme.txt': 'hello', 'docs/': '' })

  const morrow = await launchMorrow({ name: 'preview-extended', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createPreviewSession(page, workspace)

    // XLSX
    await openFile(page, 'sales.xlsx')
    await expect(page.getByTestId('xlsx-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('xlsx-preview')).toContainText('Jan')
    await expect(page.getByTestId('xlsx-preview')).toContainText('100')
    await expect(page.locator('.office-sheet-tab')).toHaveCount(2)
    await expect(page.locator('.office-sheet-tab.is-active')).toHaveCSS('height', '24px')
    await expect(page.locator('.office-sheet-tab.is-active')).toHaveCSS('border-radius', '5px')
    await page.locator('.office-sheet-tab').nth(1).click()
    await expect(page.getByTestId('xlsx-preview')).toContainText('Note')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('preview-xlsx-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('preview-xlsx-light.png') })
    await setThemeViaStore(page, 'dark')

    // PPTX
    await openFile(page, 'deck.pptx')
    await expect(page.getByTestId('pptx-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('pptx-preview')).toContainText('Quarterly Sales')
    await expect(page.getByTestId('pptx-preview')).toContainText('Expand to two regions')
    await page.screenshot({ path: screenshotPath('preview-pptx-dark.png') })

    // ZIP
    await openFile(page, 'bundle.zip')
    await expect(page.getByTestId('archive-preview')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('archive-preview')).toContainText('docs/readme.txt')
    await page.screenshot({ path: screenshotPath('preview-archive-dark.png') })

    // RTF
    await openFile(page, 'note.rtf')
    await expect(page.getByTestId('document-preview')).toBeVisible({ timeout: 30_000 })
    const documentFrame = page.frameLocator('.preview-docx-frame')
    await expect(documentFrame.getByText('Hello from RTF')).toBeVisible()
    await expect(documentFrame.getByText('Second line')).toBeVisible()

    // CSV：编辑器内预览表格
    await openFile(page, 'sales.csv')
    await expect(page.locator('.editor-pane')).toBeVisible()
    await page.getByTitle('预览表格').click()
    await expect(page.getByTestId('table-preview')).toBeVisible()
    await expect(page.getByTestId('table-preview')).toContainText('Amount')
    await page.screenshot({ path: screenshotPath('preview-table-dark.png') })

    // SVG：编辑器内预览图形
    await openFile(page, 'mark.svg')
    await page.getByTitle('预览图形').click()
    await expect(page.locator('.editor-preview-svg img')).toBeVisible()

    // 旧版 .doc：明确降级说明
    await openFile(page, 'legacy.doc')
    await expect(page.getByTestId('unsupported-preview')).toBeVisible()
    await expect(page.getByTestId('unsupported-preview')).toContainText('旧版 Office')

    const state = await readStore(page)
    expect(state.session?.workspace).toBe(workspace)
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：r10-files.spec.ts ──────────────────────────────────────────────
test.describe('r10-files.spec.ts', () => {
/**
 * R10-A 文件树与文件操作 E2E（真实 Electron + 真实主进程 feature:files:* handlers）。
 *
 * 依赖：Lead 在 src/main/ipc-index.ts 顶层 import './files'，并已构建 out/。
 * 覆盖：懒加载/隐藏文件/过滤入口、点击派发 morrow:open-file、新建/重命名/删除二次确认、
 * 只读模式禁用与主进程拒绝、越界/二进制/超大/mtime 冲突的可读错误、明暗主题截图。
 */

let app: ElectronApplication
let page: Page
let workspace = ''

interface FeatureResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

async function invoke<T = unknown>(channel: string, payload: Record<string, unknown>): Promise<FeatureResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: requestPayload }) =>
      window.morrow.features.invoke(channelName, requestPayload) as Promise<FeatureResult<T>>,
    { channel, payload }
  )
}

async function createSessionForWorkspace(target: string): Promise<void> {
  await page.evaluate(async (ws) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().newSession({ workspace: ws })
  }, target)
  await page.waitForTimeout(600)
}

test.describe('R10-A 文件树与文件操作', () => {
  test.beforeAll(async () => {
    workspace = join(root, 'tmp', `r10-files-ws-${Date.now()}`)
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'hello.md'), '# hello\n', 'utf8')
    writeFileSync(join(workspace, 'docs', 'a.txt'), 'A', 'utf8')
    writeFileSync(join(workspace, '.env'), 'SECRET=1\n', 'utf8')
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const launched = await launchMorrow({ name: 'r10-files', timeoutMs: 90_000 })
    app = launched.app
    page = launched.page
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createSessionForWorkspace(workspace)
  })

  test.afterAll(async () => {
    try {
      await app?.close()
    } catch {
      // ignore
    }
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('文件树懒加载、隐藏文件开关、过滤入口与当前文件高亮', async () => {
    const tree = page.locator('.file-tree')
    await expect(tree).toBeVisible()
    await expect(tree.locator('.ft-row', { hasText: 'hello.md' })).toBeVisible()
    await expect(tree.locator('.ft-row', { hasText: '.env' })).toHaveCount(0)

    // 隐藏文件开关
    await page.getByRole('button', { name: '显示隐藏文件' }).click()
    await expect(tree.locator('.ft-row', { hasText: '.env' })).toBeVisible()
    await page.getByRole('button', { name: '隐藏隐藏文件' }).click()
    await expect(tree.locator('.ft-row', { hasText: '.env' })).toHaveCount(0)

    // 目录懒加载
    await tree.locator('.ft-row', { hasText: 'docs' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toBeVisible()
    await tree.locator('.ft-row.is-dir', { hasText: 'docs' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toHaveCount(0)

    // 过滤
    await page.getByRole('button', { name: '显示过滤框' }).click()
    await page.getByRole('textbox', { name: '过滤文件' }).fill('hel')
    await expect(tree.locator('.ft-row', { hasText: 'hello.md' })).toBeVisible()
    await expect(tree.locator('.ft-row', { hasText: 'docs' })).toHaveCount(0)
    await page.getByRole('textbox', { name: '过滤文件' }).fill('')
    await page.getByRole('button', { name: '隐藏过滤框' }).click()

    // 点击文件 → 派发 morrow:open-file，并高亮当前文件
    await page.evaluate(() => {
      const scope = window as unknown as { __opened: Array<{ path: string; absolutePath: string }> }
      scope.__opened = []
      window.addEventListener('morrow:open-file', (event) => {
        scope.__opened.push((event as CustomEvent<{ path: string; absolutePath: string }>).detail)
      })
    })
    await tree.locator('.ft-row', { hasText: 'hello.md' }).click()
    await waitUntil(
      async () => (await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened.length)) > 0,
      5_000,
      'morrow:open-file 事件'
    )
    const detail = await page.evaluate(
      () => (window as unknown as { __opened: Array<{ path: string; absolutePath: string }> }).__opened[0]
    )
    expect(detail.path).toBe('hello.md')
    expect(detail.absolutePath.endsWith('hello.md')).toBe(true)
    await expect(tree.locator('.ft-row.is-active', { hasText: 'hello.md' })).toBeVisible()

    await page.screenshot({ path: screenshotPath('r10-files-tree-dark.png') })
  })

  test('右键菜单：新建文件、重命名、删除（二次确认）真实落盘', async () => {
    const tree = page.locator('.file-tree')
    // 新建文件（工具栏）
    await page.getByRole('button', { name: '新建文件', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('note.md')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'note.md' })).toBeVisible()
    expect(existsSync(join(workspace, 'note.md'))).toBe(true)

    // 右键菜单截图
    await tree.locator('.ft-row', { hasText: 'note.md' }).click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '文件操作' })).toBeVisible()
    await page.screenshot({ path: screenshotPath('r10-files-context-menu-dark.png') })

    // 重命名
    await page.getByRole('menuitem', { name: '重命名' }).click()
    await page.getByLabel('新名字', { exact: true }).fill('renamed.md')
    await page.locator('.modal-foot').getByRole('button', { name: '重命名' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'renamed.md' })).toBeVisible()
    expect(existsSync(join(workspace, 'renamed.md'))).toBe(true)
    expect(existsSync(join(workspace, 'note.md'))).toBe(false)

    // 删除（二次确认）
    await tree.locator('.ft-row', { hasText: 'renamed.md' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除' }).click()
    await expect(page.getByRole('dialog')).toContainText('无法恢复')
    await page.screenshot({ path: screenshotPath('r10-files-delete-confirm-dark.png') })
    await page.locator('.modal-foot').getByRole('button', { name: '删除' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'renamed.md' })).toHaveCount(0)
    expect(existsSync(join(workspace, 'renamed.md'))).toBe(false)

    // 子目录内新建（右键目录 → 新建文件）
    await tree.locator('.ft-row', { hasText: 'docs' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('inner.md')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'inner.md' })).toBeVisible()
    expect(readFileSync(join(workspace, 'docs', 'inner.md'), 'utf8')).toBe('')
  })

  test('只读模式：UI 禁用写操作 + 主进程拒绝写', async () => {
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().setPermissionMode('read-only')
    })
    await expect(page.getByRole('button', { name: '新建文件', exact: true })).toBeDisabled()
    await page.locator('.file-tree').screenshot({ path: screenshotPath('r10-files-readonly-dark.png') })

    const write = await invoke('feature:files:write', {
      workspace,
      path: 'blocked.txt',
      content: 'should not write'
    })
    expect(write.ok).toBe(false)
    expect(write.error?.message).toContain('只读')
    expect(existsSync(join(workspace, 'blocked.txt'))).toBe(false)

    // 右键菜单中的写操作也应 disabled
    await page.locator('.file-tree .ft-row', { hasText: 'hello.md' }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '重命名' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: '删除' })).toBeDisabled()
    await page.keyboard.press('Escape')

    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().setPermissionMode('ask')
    })
  })

  test('文件夹重命名/删除后保持展开状态，旧路径不产生多余错误', async () => {
    const tree = page.locator('.file-tree')
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('pack')
    await page.getByRole('button', { name: '创建' }).click()
    const pack = tree.locator('.ft-row', { hasText: 'pack' })
    await expect(pack).toBeVisible()

    await pack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('inner.md')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(tree.locator('.ft-row[title="pack/inner.md"]')).toBeVisible()

    await pack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '重命名' }).click()
    await page.getByLabel('新名字', { exact: true }).fill('pack2')
    await page.locator('.modal-foot').getByRole('button', { name: '重命名' }).click()
    const renamed = tree.locator('.ft-row', { hasText: 'pack2' })
    await expect(renamed).toBeVisible()
    await expect(renamed).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator('.ft-row[title="pack2/inner.md"]')).toBeVisible()
    await expect(page.locator('.toast-item.toast-error')).toHaveCount(0)

    await renamed.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: '删除' }).click()
    await expect(renamed).toHaveCount(0)
    await expect(tree.locator('.ft-row[title="pack2/inner.md"]')).toHaveCount(0)
    await page.waitForTimeout(400)
    await expect(page.locator('.toast-item.toast-error')).toHaveCount(0)
  })

  test('键盘：无行焦点时不误删首行，方向键从首行开始且操作只作用于焦点行', async () => {
    const tree = page.locator('.file-tree')
    const body = tree.locator('.ft-body')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await body.focus()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('F2')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.keyboard.press('ArrowDown')
    await expect(tree.locator('.ft-row').first()).toBeFocused()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('外部打开文件时自动展开祖先目录并高亮', async () => {
    const tree = page.locator('.file-tree')
    const docs = tree.locator('.ft-row', { hasText: 'docs' })
    if ((await docs.getAttribute('aria-expanded')) === 'true') await docs.click()
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toHaveCount(0)

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('morrow:open-file', { detail: { path: 'docs/a.txt', absolutePath: '' } })
      )
    })
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toBeVisible()
    await expect(tree.locator('.ft-row.is-active', { hasText: 'a.txt' })).toBeVisible()
    await expect(docs).toHaveAttribute('aria-expanded', 'true')
  })

  test('边界 / 二进制 / mtime 冲突返回可读错误', async () => {
    const outside = await invoke('feature:files:read', { workspace, path: '../outside-secret.txt' })
    expect(outside.ok).toBe(false)
    expect(outside.error?.message).toContain('工作区之外')

    const binary = await invoke('feature:files:read', { workspace, path: 'binary.bin' })
    expect(binary.ok).toBe(false)
    expect(binary.error?.message).toContain('二进制')

    const created = await invoke<{ mtimeMs: number }>('feature:files:write', {
      workspace,
      path: 'conflict.txt',
      content: 'v1'
    })
    expect(created.ok).toBe(true)
    const stale = (created.data as { mtimeMs: number }).mtimeMs - 5000
    const conflict = await invoke('feature:files:write', {
      workspace,
      path: 'conflict.txt',
      content: 'v2',
      expectedMtimeMs: stale
    })
    expect(conflict.ok).toBe(false)
    expect(conflict.error?.message).toContain('外部修改')
    expect(readFileSync(join(workspace, 'conflict.txt'), 'utf8')).toBe('v1')

    // 删除必须显式 confirm
    const noConfirm = await invoke('feature:files:delete', { workspace, path: 'conflict.txt' })
    expect(noConfirm.ok).toBe(false)
    expect(noConfirm.error?.message).toContain('确认')
  })
})

})
// ── 原文件：artifact-preview.spec.ts ──────────────────────────────────────────────
test.describe('artifact-preview.spec.ts', () => {
/**
 * 画布 HTML 产物沙箱回归：
 * - 生产 CSP 下内联脚本仍可执行（独立 morrow-artifact:// 协议 + 自身 CSP）；
 * - iframe 不带 allow-same-origin，无法拿到宿主数据；
 * - 产物内 http(s) 链接通过 postMessage 交给系统浏览器，不在应用内导航；
 * - 明暗主题截图。
 */

const REPORT = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 30px; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f6f1e7; color: #2a2721; }
  h1 { margin: 0 0 14px; font-size: 24px; letter-spacing: .02em; }
  .card { border: 1px solid #dfd5c2; border-radius: 10px; padding: 16px 18px; background: #fffaf0; }
  #out { color: #8a6f42; }
  .muted { color: #7d7568; font-size: 12px; }
  a { color: #8a6f42; }
</style></head>
<body>
  <h1>季度销售报告</h1>
  <div class="card">
    <p>脚本状态：<strong id="out">static</strong></p>
    <p class="muted">如果这里显示 script-ran，说明沙箱内的内联脚本正常工作。</p>
  </div>
  <p><a id="ext" href="https://example.com/">查看外部资料</a></p>
  <script>document.getElementById('out').textContent = 'script-ran';</script>
</body></html>`

test('HTML 产物在 CSP 下可交互，外链交宿主打开，沙箱无同源', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-preview-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'artifact-preview', env: { MORROW_TEST_CSP: '1' } })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: 'HTML 产物预览测试'
    })

    await page.evaluate((content) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-html-preview',
        title: '季度销售报告',
        kind: 'html',
        content,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, REPORT)

    await expect(page.locator('iframe.canvas-frame')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('iframe.canvas-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
    const frame = page.frames().find((item) => item.url().startsWith('morrow-artifact://'))
    expect(frame, '找不到 morrow-artifact 预览帧').toBeTruthy()
    await expect(frame!.locator('#out')).toHaveText('script-ran', { timeout: 10_000 })
    // 沙箱没有 allow-same-origin：脚本可见，但拿不到宿主存储/DOM
    expect(await frame!.evaluate(() => window.origin)).toBe('null')

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { setState: (patch: any) => void } }).__morrowStore
      ;(window as unknown as { __openedExternal?: string[] }).__openedExternal = []
      store.setState({
        openExternal: async (url: string) => {
          ;(window as unknown as { __openedExternal?: string[] }).__openedExternal!.push(url)
        }
      })
    })
    const beforeUrl = page.url()
    await frame!.locator('#ext').click()
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __openedExternal?: string[] }).__openedExternal ?? []), {
        timeout: 10_000
      })
      .toEqual(['https://example.com/'])
    expect(page.url()).toBe(beforeUrl)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('artifact-preview-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('artifact-preview-light.png') })
  } finally {
    await morrow.close()
  }
})

test('画布 HTML 成品在内置浏览器打开，不拉起外部 Edge', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-browser-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'artifact-browser' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: '成品内置浏览器测试'
    })

    await page.evaluate((content) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-inline-browser',
        title: '内置浏览器报告',
        kind: 'html',
        content,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, REPORT)

    await expect(page.locator('iframe.canvas-frame')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: '在内置浏览器中预览' }).click()
    await expect(page.locator('.workbench-browser-overlay')).toBeVisible({ timeout: 20_000 })

    await expect
      .poll(
        async () =>
          morrow.app.evaluate(async () => {
            const service = (globalThis as unknown as {
              __morrowBrowserService: { debugInfo: () => { surface: boolean; surfaceUrl: string; surfaceVisible: boolean } }
            }).__morrowBrowserService
            return service.debugInfo()
          }),
        { timeout: 20_000 }
      )
      .toMatchObject({ surface: true, surfaceVisible: true, surfaceUrl: expect.stringMatching(/^morrow-artifact:\/\/preview\//) })

    const debug = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: {
          debugInfo: () => { surface: boolean; surfaceUrl: string; surfaceVisible: boolean }
          debugSurfaceScript: (script: string) => Promise<unknown>
        }
      }).__morrowBrowserService
      const info = service.debugInfo()
      const out = await service.debugSurfaceScript(`({
        out: document.getElementById('out')?.textContent ?? '',
        origin: location.origin,
        protocol: location.protocol
      })`)
      return { info, out }
    })
    expect(debug.info.surface).toBe(true)
    expect(debug.info.surfaceVisible).toBe(true)
    expect(debug.info.surfaceUrl).toMatch(/^morrow-artifact:\/\/preview\//)
    expect(debug.out).toMatchObject({ out: 'script-ran', origin: 'morrow-artifact://preview', protocol: 'morrow-artifact:' })
    await page.screenshot({ path: screenshotPath('artifact-browser-preview.png') })
  } finally {
    await morrow.close()
  }
})

test('超大文本产物只读前缀并显示截断提示', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-large-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const filePath = join(workspace, 'large.txt')
  writeFileSync(filePath, 'a'.repeat(8.5 * 1024 * 1024), 'utf8')
  const morrow = await launchMorrow({ name: 'artifact-large' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: '大产物截断测试'
    })
    await page.evaluate((path) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-large-text',
        title: 'large.txt',
        kind: 'file',
        path,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, filePath)

    await expect(page.locator('.canvas-truncated-note')).toContainText('只显示了前 8MB', { timeout: 30_000 })
    const length = await page.evaluate(() => document.querySelector('.canvas-text')?.textContent?.length ?? 0)
    expect(length).toBe(8 * 1024 * 1024)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('artifact-truncated-dark.png') })
  } finally {
    await morrow.close()
  }
})

test('PNG 截图产物自动进入只读图片预览，而不是按文本读取', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-artifact-image-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const imagePath = join(workspace, 'screenshot.png')
  writeFileSync(imagePath, readFileSync(join(root, 'build', 'icon.png')))
  const morrow = await launchMorrow({ name: 'artifact-image' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: '截图产物预览测试'
    })
    await page.evaluate((path) => {
      const store = (window as unknown as { __morrowStore: { getState: () => any; setState: (patch: any) => void } }).__morrowStore
      const session = store.getState().session
      const artifact = {
        id: 'artifact-image-preview',
        title: '网页截图 · example.com',
        kind: 'file',
        path,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      store.setState({
        session: { ...session, artifacts: [artifact] },
        canvas: { open: true, artifactId: artifact.id }
      })
    }, imagePath)

    await expect(page.locator('.preview-image')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.canvas-text')).toHaveCount(0)
    await expect(page.locator('.canvas-head-kicker')).toContainText('图片')
    await expect(page.locator('.canvas-tab[title*="图片"]')).toBeVisible()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('artifact-image-preview-dark.png') })

    // 关闭成品页签后，若同名文件仍在编辑器页签中打开，也应继续显示图片预览，而不是二进制乱码。
    await page.getByRole('button', { name: '关闭 网页截图 · example.com' }).click()
    const docTabClose = page.getByRole('button', { name: '关闭 screenshot.png' })
    if ((await docTabClose.count()) > 0) {
      await expect(page.locator('.preview-image')).toBeVisible()
      await expect(page.locator('.canvas-text')).toHaveCount(0)
    }
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：artifact-save.spec.ts ──────────────────────────────────────────────
test.describe('artifact-save.spec.ts', () => {
/**
 * 成品落盘：内联成品可以一键保存到工作区 artifacts/，并回写路径。
 */

test.describe('成品落盘', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('内联成品可保存到工作区 artifacts/，路径回写且按钮切换', async () => {
    test.setTimeout(120_000)
    const workspace = join(root, 'tmp', `e2e-artifact-save-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'artifact-save', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const sessionId = await createUiSession(page, { workspace, permissionMode: 'auto', title: '成品落盘测试' })

    const sessionFile = join(morrow.dataDir, 'sessions', `${sessionId}.json`)
    const raw = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>
    raw.artifacts = [
      {
        id: 'artifact-save-inline',
        title: '季度复盘报告',
        kind: 'html',
        content: '<!doctype html><html><body><h1>季度复盘</h1></body></html>',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]
    writeFileSync(sessionFile, JSON.stringify(raw, null, 2), 'utf8')

    await page.evaluate(async (arg: { sessionId: string; artifactId: string }) => {
      const loaded = await window.morrow.session.load(arg.sessionId)
      if (!loaded.ok) throw new Error(loaded.error.message)
      const store = (window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore
      store.setState({
        session: loaded.data,
        activeSessionId: arg.sessionId,
        canvas: { open: true, artifactId: arg.artifactId }
      })
    }, { sessionId, artifactId: 'artifact-save-inline' })

    await expect(page.locator('.canvas-head-title')).toContainText('季度复盘报告')

    const saveButton = page.locator('[aria-label="保存到文件夹"]')
    await expect(saveButton).toBeVisible()
    await saveButton.click()

    const target = join(workspace, 'artifacts', '季度复盘报告.html')
    await waitUntil(async () => existsSync(target), 15_000, '成品文件落盘')
    expect(readFileSync(target, 'utf8')).toContain('季度复盘')

    const loaded = await page.evaluate(async (sid: string) => window.morrow.session.load(sid), sessionId)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      const artifact = loaded.data.artifacts.find((item) => item.id === 'artifact-save-inline')
      expect(artifact?.path).toBe(target)
    }
    await expect(page.locator('[aria-label="在文件夹中显示"]')).toBeEnabled()
  })
})

})
})


test.describe("06-editor", () => {
// ── 原文件：r10-editor.spec.ts ──────────────────────────────────────────────
test.describe('r10-editor.spec.ts', () => {
/**
 * R10-B/F 编辑器 + 版本历史 E2E —— 真实 Electron / 真实主进程 / 真实文件系统。
 *
 * 覆盖：
 * 1. 文件树事件 `morrow:open-file` → Canvas 多标签编辑器打开文件（CodeMirror 真编辑器）。
 * 2. 编辑 → 脏标记 → Ctrl+S 保存 → 磁盘内容真实变化；关闭后重新打开能读回修改。
 * 3. 外部修改冲突：磁盘被外部改写 → 编辑器显示冲突条 → 「覆盖保存」写回。
 * 4. 未保存关闭确认：取消保留、放弃关闭不写盘。
 * 5. Markdown 预览切换。
 * 6. 版本历史：保存产生版本 → 历史抽屉 → diff → 恢复到旧版本后磁盘内容正确。
 *
 * 依赖 Lead 已把 `features/files` 与 `features/editor-history` 注册进 feature IPC。
 */

/** 建立独立工作区会话，避免与其它用例的历史记录/文件互相干扰。 */
async function createEditorSession(page: Page): Promise<{ workspace: string; sessionId: string }> {
  const workspace = join(root, 'tmp', `r10-editor-ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(workspace, { recursive: true })
  return page.evaluate(async (wsPath: string) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    await store.getState().updateSettings({ onboardingDone: true })
    store.setState({ onboardingOpen: false })
    const created = await window.morrow.session.create({
      workspace: wsPath,
      model: store.getState().settings.defaultModel,
      permissionMode: 'auto',
      title: 'R10 编辑器 E2E'
    })
    if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
    await store.getState().selectSession(created.data.id)
    return { workspace: wsPath, sessionId: created.data.id }
  }, workspace)
}

const TIMEOUT = 20_000

async function openFile(page: Awaited<ReturnType<typeof launchMorrow>>['page'], relativePath: string): Promise<void> {
  await page.evaluate((path: string) => {
    window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path } }))
  }, relativePath)
  // 切换标签时编辑器本身已经可见：必须等目标文件成为活动标签，避免读到上一个文件的内容
  await page
    .locator('.canvas-doc-tab.is-active')
    .filter({ hasText: basename(relativePath) })
    .waitFor({ state: 'visible', timeout: TIMEOUT })
  await page.locator('.canvas-root .cm-editor').first().waitFor({ state: 'visible', timeout: TIMEOUT })
}

async function readDisk(path: string): Promise<string> {
  return readFileSync(path, 'utf8')
}

async function waitDisk(path: string, predicate: (content: string) => boolean, label: string): Promise<void> {
  await waitUntil(async () => (predicate(await readDisk(path)) ? true : null), TIMEOUT, label)
}

test.describe('R10 画布编辑器与版本历史', () => {
  test('打开文件 → 编辑 → 保存 → 重新打开', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-save' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'src/e2e-note.ts'
      const absolute = join(workspace, 'src', 'e2e-note.ts')
      mkdirSync(join(workspace, 'src'), { recursive: true })
      const initial = 'export const answer = 41\n'
      writeFileSync(absolute, initial, 'utf8')

      await openFile(page, relative)
      const editorVisible = await page.locator('.canvas-root .cm-editor').isVisible()
      expect(editorVisible).toBe(true)
      // 语法高亮确实生效（CodeMirror 把行拆成带样式类的 token span）
      expect(await page.locator('.cm-line span').count()).toBeGreaterThan(1)
      const tokenColors = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.cm-line span')).slice(0, 20).map((el) => getComputedStyle(el).color)
      )
      expect(new Set(tokenColors).size).toBeGreaterThan(1)
      const editorFont = await page.locator('.cm-scroller').evaluate((element) => {
        const style = getComputedStyle(element)
        return { weight: style.fontWeight, family: style.fontFamily }
      })
      expect(editorFont.weight).toBe('400')
      expect(editorFont.family).toContain('JetBrains Mono')
      await page.screenshot({ path: screenshotPath('r10-editor-open.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('r10-editor-open-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(250)

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('// e2e 修改\n')
      await expect
        .poll(async () => page.locator('.canvas-head-dirty').count(), { timeout: TIMEOUT })
        .toBeGreaterThan(0)
      await page.screenshot({ path: screenshotPath('r10-editor-dirty.png') })

      await page.keyboard.press('Control+s')
      await expect
        .poll(async () => page.locator('.canvas-head-dirty').count(), { timeout: TIMEOUT })
        .toBe(0)
      await waitDisk(absolute, (content) => content.includes('// e2e 修改'), '磁盘写入编辑内容')

      // 关闭再打开，内容应来自磁盘
      await page.locator('.canvas-doc-tab .canvas-tab-close').first().click()
      await expect(page.locator('.canvas-doc-tab')).toHaveCount(0)
      await openFile(page, relative)
      await expect(page.locator('.cm-content')).toContainText('// e2e 修改')
    } finally {
      await app.close()
    }
  })

  test('文件树重命名已打开文件：编辑器标签同步新路径，保存写入新文件', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-rename-sync' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const oldRelative = 'rename-me.ts'
      const newRelative = 'renamed.ts'
      const oldAbsolute = join(workspace, oldRelative)
      const newAbsolute = join(workspace, newRelative)
      writeFileSync(oldAbsolute, 'export const before = 1\n', 'utf8')

      await page.locator('[aria-label="刷新文件树"]').click()
      const row = page.getByRole('treeitem').filter({ hasText: oldRelative }).first()
      await expect(row).toBeVisible({ timeout: TIMEOUT })
      await row.click()
      await page.locator('.canvas-root .cm-editor').first().waitFor({ state: 'visible', timeout: TIMEOUT })

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('// renamed while open\n')
      await expect(page.locator('.canvas-head-dirty')).toHaveCount(1)

      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /重命名/ }).click()
      await page.getByLabel('新名字').fill(newRelative)
      await page.getByRole('button', { name: '重命名', exact: true }).click()
      await expect(page.locator('.canvas-doc-tab .canvas-tab-title')).toContainText(newRelative)

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+s')
      await waitDisk(newAbsolute, (content) => content.includes('renamed while open'), '保存到重命名后的路径')
      expect(existsSync(oldAbsolute)).toBe(false)
      await page.screenshot({ path: screenshotPath('editor-rename-sync-dark.png') })

      // 删除已保存的干净文件：对应编辑器标签应关闭
      const newRow = page.getByRole('treeitem').filter({ hasText: newRelative }).first()
      await newRow.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /删除/ }).click()
      await page.getByRole('button', { name: '删除', exact: true }).click()
      await expect(page.locator('.canvas-doc-tab')).toHaveCount(0, { timeout: TIMEOUT })
      expect(existsSync(newAbsolute)).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('外部修改冲突提示与覆盖保存', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-conflict' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'notes/conflict.md'
      const absolute = join(workspace, 'notes', 'conflict.md')
      mkdirSync(join(workspace, 'notes'), { recursive: true })
      writeFileSync(absolute, '# 初始内容\n', 'utf8')

      await openFile(page, relative)
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('编辑器里的未保存内容\n')

      // 外部直接改写磁盘
      writeFileSync(absolute, '# 被外部改写了\n', 'utf8')
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect
        .poll(async () => page.locator('.editor-banner.is-warning').count(), { timeout: TIMEOUT })
        .toBeGreaterThan(0)
      await expect(page.locator('.editor-banner.is-warning')).toContainText('外部修改')
      await page.screenshot({ path: screenshotPath('r10-editor-conflict.png') })

      await page.getByRole('button', { name: /覆盖保存/ }).first().click()
      await waitDisk(absolute, (content) => content.includes('编辑器里的未保存内容'), '覆盖保存写回未保存内容')
      await expect.poll(async () => page.locator('.editor-banner.is-warning').count(), { timeout: TIMEOUT }).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('未保存关闭确认与 Markdown 预览', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-unsaved' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'README-e2e.md'
      const absolute = join(workspace, relative)
      writeFileSync(absolute, '# 标题\n\n正文内容\n', 'utf8')

      await openFile(page, relative)
      // Markdown 预览
      await page.getByRole('button', { name: /预览/ }).first().click()
      await expect(page.locator('.editor-preview-paper')).toBeVisible({ timeout: TIMEOUT })
      await expect(page.locator('.editor-preview-paper')).toContainText('标题')
      await page.screenshot({ path: screenshotPath('r10-editor-md-preview.png') })
      await page.locator('.editor-toolbar button[title="回到编辑"]').click()
      await page.locator('.editor-preview').waitFor({ state: 'hidden' })
      await page.locator('.cm-content').waitFor({ state: 'visible' })

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('未保存的补充\n')
      await page.locator('.canvas-doc-tab .canvas-tab-close').first().click()
      await expect(page.locator('.modal-panel')).toBeVisible({ timeout: TIMEOUT })
      await expect(page.locator('.modal-title')).toContainText('关闭未保存的文件')
      await page.screenshot({ path: screenshotPath('r10-editor-unsaved.png') })
      // 取消 → 标签仍在、磁盘未变
      await page.getByRole('button', { name: '取消' }).last().click()
      await expect(page.locator('.canvas-doc-tab')).toHaveCount(1)
      expect(await readDisk(absolute)).toBe('# 标题\n\n正文内容\n')
      // 不保存关闭 → 标签消失、磁盘仍未变
      await page.locator('.canvas-doc-tab .canvas-tab-close').first().click()
      await page.getByRole('button', { name: '不保存' }).first().click()
      await expect(page.locator('.canvas-doc-tab')).toHaveCount(0)
      expect(await readDisk(absolute)).toBe('# 标题\n\n正文内容\n')
    } finally {
      await app.close()
    }
  })

  test('版本历史：保存产生版本、diff 与恢复', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-history' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'history-note.md'
      const absolute = join(workspace, relative)
      const versionA = '# 第一版\n'
      const versionB = '# 第二版\n内容 B\n'
      writeFileSync(absolute, versionA, 'utf8')

      await openFile(page, relative)
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type(versionB)
      await page.keyboard.press('Control+s')
      await waitDisk(absolute, (content) => content === versionB, '保存第二版')

      await page.getByRole('button', { name: /历史/ }).first().click()
      await expect(page.locator('.editor-history')).toBeVisible({ timeout: TIMEOUT })
      const items = page.locator('.editor-history-item')
      await expect.poll(async () => items.count(), { timeout: TIMEOUT }).toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: screenshotPath('r10-editor-history.png') })

      // 选中最早版本，DiffView 出现（与当前编辑器内容对比）
      await items.last().click()
      await expect(page.locator('.editor-history-diff .diff-view')).toBeVisible({ timeout: TIMEOUT })
      await page.screenshot({ path: screenshotPath('r10-editor-history-diff.png') })

      // 恢复确认 → 磁盘回到第一版内容
      await page.getByRole('button', { name: /恢复到这个版本/ }).click()
      await page.getByRole('button', { name: '确认恢复' }).click()
      await waitDisk(absolute, (content) => content === versionA, '恢复第一版内容')
      await expect(page.locator('.editor-status')).toContainText('已保存')
    } finally {
      await app.close()
    }
  })

  test('保存进行中继续输入不会丢字，也不会误清脏标记', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-save-race' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'race-note.ts'
      const absolute = join(workspace, relative)
      writeFileSync(absolute, 'export const race = 0\n', 'utf8')
      await openFile(page, relative)

      // 让写盘慢下来，模拟磁盘/磁盘杀毒占用时的真实时序
      await page.evaluate(() => {
        ;(window as unknown as { __morrowFeatureTestHooks?: (channel: string, payload: unknown) => Promise<unknown> | undefined }).__morrowFeatureTestHooks =
          async (channel, payload) => {
            if (channel !== 'feature:files:write') return undefined
            await new Promise((resolve) => setTimeout(resolve, 900))
            return window.morrow.features.invoke(channel, payload)
          }
      })

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n// 第一段')
      await page.keyboard.press('Control+s')
      await page.waitForTimeout(180)
      await page.keyboard.type('\n// 保存期间的新输入')
      await expect(page.locator('.cm-content')).toContainText('保存期间的新输入')

      // 第一次写盘只包含第一段；编辑器必须保留新输入并继续显示未保存
      await waitDisk(absolute, (content) => content.includes('第一段') && !content.includes('保存期间的新输入'), '第一段已写盘')
      await expect.poll(async () => page.locator('.canvas-head-dirty').count(), { timeout: TIMEOUT }).toBeGreaterThan(0)
      await expect(page.locator('.cm-content')).toContainText('保存期间的新输入')

      // 再保存一次后两段都落盘
      await page.keyboard.press('Control+s')
      await waitDisk(absolute, (content) => content.includes('第一段') && content.includes('保存期间的新输入'), '新输入已写盘')
      await expect.poll(async () => page.locator('.canvas-head-dirty').count(), { timeout: TIMEOUT }).toBe(0)
    } finally {
      await app.close()
    }
  })

  test('切换标签不共享撤销历史，未保存内容不会被另一篇文档污染', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-tab-isolation' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      writeFileSync(join(workspace, 'a.md'), '# A\n', 'utf8')
      writeFileSync(join(workspace, 'b.md'), '# B\n', 'utf8')
      await openFile(page, 'a.md')
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\nA unsaved\n')
      await expect(page.locator('.canvas-head-dirty')).toHaveCount(1)

      await openFile(page, 'b.md')
      await expect(page.locator('.cm-content')).toContainText('# B')
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+z')
      await expect(page.locator('.cm-content')).toContainText('# B')
      await expect(page.locator('.cm-content')).not.toContainText('A unsaved')
      await expect(page.locator('.canvas-head-dirty')).toHaveCount(0)

      await page.locator('.canvas-doc-tab', { hasText: 'a.md' }).click()
      await expect(page.locator('.cm-content')).toContainText('A unsaved')
      await expect(page.locator('.canvas-head-dirty')).toHaveCount(1)
      await page.locator('[aria-label="刷新文件树"]').click()
      await expect(page.locator('.file-tree .ft-row', { hasText: 'b.md' })).toBeVisible()
      await page.screenshot({ path: screenshotPath('r10-editor-tab-isolation.png') })
    } finally {
      await app.close()
    }
  })

  test('切换只读模式会立即锁定编辑器，切回后仍可保存', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-readonly-mode' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'mode-note.md'
      const absolute = join(workspace, relative)
      writeFileSync(absolute, '# mode\n', 'utf8')
      await openFile(page, relative)

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('\n未保存的行\n')
      await expect(page.locator('.canvas-head-dirty')).toHaveCount(1)

      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().setPermissionMode('read-only')
      })
      await expect(page.locator('.editor-status')).toHaveText('只读模式')
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
      const before = await page.locator('.cm-content').innerText()
      await page.locator('.cm-content').click()
      await page.keyboard.type('不应写入')
      expect(await page.locator('.cm-content').innerText()).toBe(before)
      await page.keyboard.press('Control+s')
      await page.waitForTimeout(400)
      expect(await readDisk(absolute)).toBe('# mode\n')
      // 测试在文件树首次加载后才写文件；刷新一次让截图反映真实文件
      await page.locator('[aria-label="刷新文件树"]').click()
      await expect(page.locator('.file-tree .ft-row', { hasText: 'mode-note.md' })).toBeVisible()
      await page.screenshot({ path: screenshotPath('r10-editor-readonly-mode.png') })

      // 只读模式下可以查看历史，但不能恢复版本
      await waitUntil(
        async () =>
          page.evaluate(async (path) => {
            const result = (await window.morrow.features.invoke('feature:history:list', { path })) as {
              ok: boolean
              data?: { versions: unknown[] }
            }
            return result.ok && (result.data?.versions.length ?? 0) > 0 ? true : null
          }, absolute),
        TIMEOUT,
        '只读文件历史基线'
      )
      await page.locator('.editor-toolbar').getByRole('button', { name: '历史' }).click()
      await expect(page.locator('.editor-history')).toBeVisible()
      const historyItems = page.locator('.editor-history-item')
      await expect(historyItems.first()).toBeVisible({ timeout: TIMEOUT })
      await historyItems.first().click()
      await expect(page.getByRole('button', { name: /恢复到这个版本/ })).toBeDisabled()
      await page.getByRole('button', { name: '关闭版本历史' }).click()

      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().setPermissionMode('ask')
      })
      await expect(page.locator('.editor-status')).toHaveText('未保存')
      await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await waitDisk(absolute, (content) => content.includes('未保存的行'), '切回后可保存')
    } finally {
      await app.close()
    }
  })

  test('另存为：副本可继续编辑，并建立自己的历史基线', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-save-as' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const { workspace } = await createEditorSession(page)
      const relative = 'draft.ts'
      const copyRelative = 'draft-copy.ts'
      const absolute = join(workspace, relative)
      const copyAbsolute = join(workspace, copyRelative)
      writeFileSync(absolute, 'export const draft = 1\n', 'utf8')
      await openFile(page, relative)
      // 等原文档基线落库，确保「另存为」会继承 baselineRecorded 的真实时序
      await waitUntil(
        async () =>
          page.evaluate(async (path) => {
            const result = (await window.morrow.features.invoke('feature:history:list', { path })) as {
              ok: boolean
              data?: { versions: unknown[] }
            }
            return result.ok && (result.data?.versions.length ?? 0) > 0 ? true : null
          }, absolute),
        TIMEOUT,
        '原文件历史基线'
      )

      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('// copied\n')
      await page.getByRole('button', { name: '另存为', exact: true }).click()
      await page.getByLabel('另存为相对路径').fill(copyRelative)
      await page.getByRole('button', { name: '保存副本' }).click()
      await expect(page.locator('.editor-path')).toHaveText(copyRelative)
      await waitDisk(copyAbsolute, (content) => content.includes('// copied'), '副本写入磁盘')

      const versions = await waitUntil(
        async () =>
          page.evaluate(async (path) => {
            const result = (await window.morrow.features.invoke('feature:history:list', { path })) as {
              ok: boolean
              data?: { versions: unknown[] }
            }
            return result.ok && (result.data?.versions.length ?? 0) > 0 ? result.data!.versions.length : null
          }, copyAbsolute),
        TIMEOUT,
        '副本历史基线'
      )
      expect(versions).toBeGreaterThanOrEqual(1)

      // 副本不是只读，仍可继续编辑并保存
      await page.locator('.cm-content').click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('// again\n')
      await page.keyboard.press('Control+s')
      await waitDisk(copyAbsolute, (content) => content.includes('// again'), '副本二次保存')
    } finally {
      await app.close()
    }
  })

  test('版本历史 IPC 拒绝工作区外路径（阻止任意写）', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-history-boundary' })
    const outside = join(root, 'tmp', `outside-history-${Date.now()}.txt`)
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await createEditorSession(page)
      writeFileSync(outside, 'outside\n', 'utf8')
      const guard = await page.evaluate(async (filePath) => {
        const invoke = (channel: string, payload: Record<string, unknown>) =>
          window.morrow.features.invoke(channel, payload) as Promise<{ ok: boolean; error?: { message?: string } }>
        const record = await invoke('feature:history:record', { path: filePath, content: 'x' })
        const restore = await invoke('feature:history:restore', { path: filePath, versionId: 'v-test' })
        return { record, restore }
      }, outside)
      expect(guard.record.ok).toBe(false)
      expect(guard.record.error?.message).toContain('工作区')
      expect(guard.restore.ok).toBe(false)
      expect(guard.restore.error?.message).toContain('工作区')
    } finally {
      await app.close()
      try {
        rmSync(outside, { force: true })
      } catch {
        // ignore
      }
    }
  })

  test('只读产物仍然可以查看（不出现编辑器保存入口）', async () => {
    const { app, page } = await launchMorrow({ name: 'r10-editor-readonly' })
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await createEditorSession(page)
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (patch: Record<string, unknown>) => void } }).__morrowStore
        const session = store.getState().session
        store.setState({
          session: {
            ...session,
            artifacts: [
              {
                id: 'inline-preview-artifact',
                title: 'inline-report.html',
                kind: 'code',
                language: 'html',
                content: '<h1>inline</h1>',
                createdAt: Date.now(),
                updatedAt: Date.now()
              }
            ]
          },
          canvas: { open: true, artifactId: 'inline-preview-artifact' }
        })
      })
      await expect(page.locator('.canvas-root')).toBeVisible({ timeout: TIMEOUT })
      // 内联产物没有 path：不出现「在编辑器中打开」按钮，只读代码预览正常
      await expect(page.getByRole('button', { name: '在编辑器中打开' })).toHaveCount(0)
      await expect(page.locator('.canvas-code')).toBeVisible({ timeout: TIMEOUT })
      const state = await readStore(page)
      expect(state.canvas.open).toBe(true)
    } finally {
      await app.close()
    }
  })
})

})
// ── 原文件：a5-artifact-export.spec.ts ──────────────────────────────────────────────
test.describe('a5-artifact-export.spec.ts', () => {
/**
 * A5：成品版本历史与多格式导出。
 * - 打开历史时记录当前基线；内容变化后重新进入出现第二个版本；
 * - 恢复旧版本会写回会话，并把恢复本身记录为新版本；
 * - HTML 成品可导出真实 Markdown 与可打开的 PDF。
 */

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { setTheme: (value: string) => void } }
    }).__morrowStore
    store.getState().setTheme(next)
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await page.waitForTimeout(260)
}

const V1 = '<!doctype html><html><body><h1>季度复盘</h1><p>收入 <strong>增长 12%</strong></p><ul><li>留存提升</li></ul></body></html>'
const V2 = '<!doctype html><html><body><h1>季度复盘（修订）</h1><p>收入 <strong>增长 18%</strong></p><ul><li>留存提升</li><li>成本下降</li></ul></body></html>'

test.describe('成品版本与导出', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('版本历史可恢复，HTML 成品导出 Markdown 与 PDF', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-a5-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'a5-artifact-export', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const sessionId = await createUiSession(page, { workspace, permissionMode: 'auto', title: 'A5 版本导出' })

    const sessionFile = join(morrow.dataDir, 'sessions', `${sessionId}.json`)
    const raw = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>
    raw.artifacts = [
      {
        id: 'a5-report',
        title: '季度复盘报告',
        kind: 'html',
        content: V1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]
    writeFileSync(sessionFile, JSON.stringify(raw, null, 2), 'utf8')

    const loadIntoCanvas = async (): Promise<void> => {
      await page.evaluate(async (arg: { sessionId: string; artifactId: string }) => {
        const loaded = await window.morrow.session.load(arg.sessionId)
        if (!loaded.ok) throw new Error(loaded.error.message)
        const store = (window as unknown as {
          __morrowStore: { setState: (patch: Record<string, unknown>) => void }
        }).__morrowStore
        store.setState({
          session: loaded.data,
          activeSessionId: arg.sessionId,
          canvas: { open: true, artifactId: arg.artifactId }
        })
      }, { sessionId, artifactId: 'a5-report' })
    }

    await loadIntoCanvas()
    await expect(page.locator('.canvas-head-title')).toContainText('季度复盘报告')

    // 1. 打开历史 → 记录当前基线
    await page.locator('[aria-label="版本历史"]').click()
    await expect(page.locator('.artifact-version-item')).toHaveCount(1)
    await expect(page.locator('.artifact-version-current')).toHaveText('当前')
    await expect(page.locator('.artifact-version-pre')).toContainText('季度复盘')
    await page.locator('.artifact-dialog-actions').getByRole('button', { name: '关闭' }).click()

    // 2. 修改会话内容后重载 → 再打开历史出现两个版本
    const updated = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, any>
    updated.artifacts[0].content = V2
    updated.artifacts[0].updatedAt = Date.now()
    writeFileSync(sessionFile, JSON.stringify(updated, null, 2), 'utf8')
    await loadIntoCanvas()
    await page.locator('[aria-label="版本历史"]').click()
    await expect(page.locator('.artifact-version-item')).toHaveCount(2)
    await expect(page.locator('.artifact-version-source').first()).toHaveText('手动保存')
    await page.waitForTimeout(320)
    await page.screenshot({ path: join(screensDir, 'a5-versions.png') })
    await setTheme(page, 'light')
    await page.screenshot({ path: join(screensDir, 'a5-versions-light.png') })
    await setTheme(page, 'dark')

    // 3. 恢复旧版本
    await page.locator('.artifact-version-item').nth(1).click()
    await page.getByRole('button', { name: '恢复此版本' }).click()
    await expect(page.getByText('恢复会覆盖当前内容，但当前版本会保留。')).toBeVisible()
    await page.getByRole('button', { name: '确认恢复' }).click()
    await expect(page.locator('.toast-item.toast-success')).toContainText('已恢复到所选版本')
    await expect(page.locator('.artifact-version-item')).toHaveCount(3)

    const restored = await page.evaluate(async (sid: string) => window.morrow.session.load(sid), sessionId)
    expect(restored.ok).toBe(true)
    if (restored.ok) {
      const artifact = restored.data.artifacts.find((item) => item.id === 'a5-report')
      expect(artifact?.content).toContain('季度复盘')
      expect(artifact?.content).not.toContain('增长 18%')
    }
    await page.locator('.artifact-dialog-actions').getByRole('button', { name: '关闭' }).click()

    const markdownText = await page.evaluate(
      async (arg: { sessionId: string; artifactId: string }) =>
        window.morrow.artifacts.exportText(arg.sessionId, arg.artifactId, 'markdown'),
      { sessionId, artifactId: 'a5-report' }
    )
    expect(markdownText.ok).toBe(true)
    if (markdownText.ok) expect(markdownText.data).toContain('# 季度复盘')

    // 4. 导出 Markdown：真实转换标题、强调与列表
    await page.locator('[aria-label="导出成品"]').click()
    await expect(page.locator('.artifact-format')).toHaveCount(4)
    await page.waitForTimeout(320)
    await page.screenshot({ path: join(screensDir, 'a5-export.png') })
    await setTheme(page, 'light')
    await page.screenshot({ path: join(screensDir, 'a5-export-light.png') })
    await setTheme(page, 'dark')
    await page.getByRole('radio', { name: /Markdown/ }).click()
    const markdownPath = join(root, 'tmp', `e2e-a5-report-${Date.now()}.md`)
    await morrow.app.evaluate(async ({ dialog }, target) => {
      ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = async () => ({
        canceled: false,
        filePath: target
      })
    }, markdownPath)
    await page.getByRole('button', { name: '导出 Markdown' }).click()
    await waitUntil(async () => existsSync(markdownPath), 15_000, 'Markdown 导出落盘')
    const markdown = readFileSync(markdownPath, 'utf8')
    expect(markdown).toContain('# 季度复盘')
    expect(markdown).toContain('**增长 12%**')
    expect(markdown).toContain('- 留存提升')
    await expect(page.locator('.artifact-export-result')).toContainText(markdownPath)

    // 5. 导出 PDF：真实 PDF 文件头
    await page.getByRole('radio', { name: 'PDF' }).click()
    const pdfPath = join(root, 'tmp', `e2e-a5-report-${Date.now()}.pdf`)
    await morrow.app.evaluate(async ({ dialog }, target) => {
      ;(dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = async () => ({
        canceled: false,
        filePath: target
      })
    }, pdfPath)
    await page.getByRole('button', { name: '导出 PDF' }).click()
    await waitUntil(async () => existsSync(pdfPath), 30_000, 'PDF 导出落盘')
    const pdf = readFileSync(pdfPath)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(1_000)
    await expect(page.locator('.artifact-export-result')).toContainText(pdfPath)
  })

  test('已保存到工作区的文件成品恢复版本时，磁盘文件与画布内容一起回退', async () => {
    test.setTimeout(120_000)
    const workspace = join(root, 'tmp', `e2e-a5-path-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const reportPath = join(workspace, 'report.md')
    writeFileSync(reportPath, '# 旧内容\n\n第一版', 'utf8')
    morrow = await launchMorrow({ name: 'a5-artifact-path-restore', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const sessionId = await createUiSession(page, { workspace, permissionMode: 'auto', title: 'A5 文件成品恢复' })
    const sessionFile = join(morrow.dataDir, 'sessions', `${sessionId}.json`)
    const raw = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, unknown>
    raw.artifacts = [
      {
        id: 'a5-path-report',
        title: '文件报告',
        kind: 'markdown',
        path: reportPath,
        content: '# 旧内容\n\n第一版',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]
    writeFileSync(sessionFile, JSON.stringify(raw, null, 2), 'utf8')

    const firstVersions = await page.evaluate(async (sid: string) => {
      const result = await window.morrow.artifacts.versions(sid, 'a5-path-report')
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    }, sessionId)
    expect(firstVersions).toHaveLength(1)

    // 模拟外部编辑：磁盘与会话内容都变成新版，再打开历史形成第二个版本
    writeFileSync(reportPath, '# 新内容\n\n第二版', 'utf8')
    const changed = JSON.parse(readFileSync(sessionFile, 'utf8')) as Record<string, any>
    changed.artifacts[0].content = '# 新内容\n\n第二版'
    changed.artifacts[0].updatedAt = Date.now()
    writeFileSync(sessionFile, JSON.stringify(changed, null, 2), 'utf8')
    const versions = await page.evaluate(async (sid: string) => {
      const result = await window.morrow.artifacts.versions(sid, 'a5-path-report')
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    }, sessionId)
    expect(versions).toHaveLength(2)

    const baseline = versions[versions.length - 1]
    const restored = await page.evaluate(
      async (arg: { sid: string; versionId: string }) => {
        const result = await window.morrow.artifacts.restoreVersion(arg.sid, 'a5-path-report', arg.versionId)
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      { sid: sessionId, versionId: baseline.id }
    )
    expect(readFileSync(reportPath, 'utf8')).toContain('第一版')
    expect(restored.content).toContain('第一版')
    const saved = JSON.parse(readFileSync(sessionFile, 'utf8')) as { artifacts: Array<{ content?: string }> }
    expect(saved.artifacts[0].content).toContain('第一版')
  })
})

})
// ── 原文件：b2b-scanned-pdf.spec.ts ──────────────────────────────────────────────
test.describe('b2b-scanned-pdf.spec.ts', () => {
/**
 * B2b：扫描版 PDF 由本机 Windows OCR 真实识别，文字进入模型上下文，不再要求用户截图。
 * 夹具 scanned-zh.pdf 是只有一张图片、没有任何文字层的 PDF。
 */

test.describe('扫描版 PDF 图像识别', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('无文字层的 PDF 自动走本机 OCR，并把识别文字交给模型', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        {
          text: '',
          toolCalls: [{ name: 'read_pdf', arguments: { path: 'scan.pdf' } }]
        },
        { text: '扫描件已读取。' }
      ]
    })
    const workspace = join(root, 'tmp', `e2e-b2b-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    copyFileSync(
      join(root, 'tests', 'fixtures', 'documents', 'scanned-zh.pdf'),
      join(workspace, 'scan.pdf')
    )

    // 最终验收时可用 MORROW_PACKAGED_APP 指向打包产物，验证 asar 外的 OCR 脚本能被找到
    const packagedApp = process.env.MORROW_PACKAGED_APP
    morrow = await launchMorrow({
      name: 'b2b-scanned-pdf',
      timeoutMs: 90_000,
      ...(packagedApp ? { executablePath: packagedApp } : {})
    })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '扫描件识别测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '读取 scan.pdf，告诉我合计。')
    await waitForRunFinished(page, 90_000)
    await expect(page.getByText('扫描件已读取。')).toBeVisible({ timeout: 20_000 })

    // 第二次模型请求里必须带上 OCR 识别结果，而不是「请发截图」的错误提示
    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    const withToolResult = bodies.find((body: string) => body.includes('本机 OCR 已识别'))
    expect(withToolResult).toBeTruthy()
    expect(withToolResult).toContain('扫描发票')
    expect(withToolResult).toContain('9821.50')
    expect(withToolResult).toContain('关键数字请对照原页复核')
    expect(bodies.some((body: string) => body.includes('请把需要阅读的页面截图'))).toBe(false)

    await page.locator('.spine-item').filter({ hasText: '读取 PDF scan.pdf' }).click()
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'b2b-scanned-pdf.png') })
  })
})

})
// ── 原文件：custom-commands.spec.ts ──────────────────────────────────────────────
test.describe('custom-commands.spec.ts', () => {
/**
 * P1-12 自定义命令与钩子 E2E：
 * - .morrow/commands 命令出现在斜杠菜单，选择后输入参数，发送时展开 $1/$2；
 * - 设置 → 自动化：添加 user_prompt_submit 钩子并保存；
 * - 退出码 2 的钩子阻止消息，界面给出原因；设置持久化可读回。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('自定义命令展开参数，钩子可阻断并持久化', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({ scripts: [{ text: '审查完成。' }, { text: '不应该出现。' }] })
  const workspace = workspaceAt('e2e-commands')
  mkdirSync(join(workspace, '.morrow', 'commands'), { recursive: true })
  writeFileSync(
    join(workspace, '.morrow', 'commands', 'review.md'),
    '---\ndescription: 审查代码\nargument-hint: 文件与重点\n---\n请审查 $1，重点 $2。\n',
    'utf8'
  )
  writeFileSync(
    join(workspace, '.morrow', 'commands', 'hello.md'),
    '向用户问好，并总结今天的进展。\n',
    'utf8'
  )
  writeFileSync(
    join(workspace, '.morrow', 'commands', 'swarm.md'),
    '---\ndescription: 不应出现在菜单里的重名命令\n---\n不应执行。\n',
    'utf8'
  )
  const blockScript = join(workspace, 'block-hook.js')
  writeFileSync(blockScript, "process.stdout.write('需要先填写作者')\nprocess.exit(2)\n", 'utf8')
  const hookCommand = `"${process.execPath}" "${blockScript}"`

  const morrow = await launchMorrow({ name: 'custom-commands', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '命令测试'
    })

    // 斜杠菜单中发现项目命令，选择后进入参数输入
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('/rev')
    const popupItem = page.locator('.composer-pop-item').filter({ hasText: '审查代码' })
    await expect(popupItem).toBeVisible()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('custom-command-popup-dark.png') })
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('/review ')
    await input.pressSequentially('src/a.ts 性能')
    await page.keyboard.press('Enter')

    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '自定义命令运行结束')
    await expect(page.locator('.message-user')).toContainText('请审查 src/a.ts，重点 性能。')
    // 自动命名等后台请求可能先到；只检查真正带用户消息的对话请求
    const commandRequests = mock.requests.filter(
      (request: { lastUserMessageText?: string }) => typeof request.lastUserMessageText === 'string'
    )
    expect(commandRequests[0]?.lastUserMessageText).toBe('请审查 src/a.ts，重点 性能。')

    // 未知命令给出提示而不是把 /nope 当普通消息发给模型
    await input.fill('/nope')
    await page.keyboard.press('Enter')
    await expect(page.getByText('没有名为 /nope 的命令')).toBeVisible()
    await expect(input).toHaveValue('/nope')
    expect(
      mock.requests.filter(
        (request: { lastUserMessageText?: string }) => typeof request.lastUserMessageText === 'string'
      )
    ).toHaveLength(1)
    await input.fill('')

    // 与内置命令重名时，菜单只保留内置项，不出现重复条目
    await input.fill('/swarm')
    await expect(page.locator('.composer-pop-item')).toHaveCount(1)
    await expect(page.locator('.composer-pop-item')).toContainText('集群')
    await input.fill('')

    // 设置 → 自动化：添加并保存钩子
    await page.evaluate(() => {
      void (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } })
        .__morrowStore.getState().openSettings()
    })
    await page.getByRole('tab', { name: '自动化' }).click()
    await expect(page.locator('.st-command-name').filter({ hasText: '/review' })).toBeVisible()
    await expect(page.locator('.st-command-list li').filter({ hasText: '/swarm' })).toContainText('重名')
    await expect(page.getByText(/个命令与内置命令重名/)).toBeVisible()
    await expect(page.getByText('集群成员类型')).toBeVisible()
    await page.getByRole('button', { name: '查看全部成员类型' }).click()
    await expect(page.getByText('代码侦察', { exact: true })).toBeVisible()
    await expect(page.getByText('代码审查', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '收起', exact: true }).click()

    // 设置面板只保留右侧内容区一条滚动条，模态正文不再套一层滚动
    const settingsOverflow = await page
      .getByRole('dialog', { name: '设置' })
      .evaluate((panel) => {
        const body = panel.querySelector<HTMLElement>('.modal-body')
        return body ? body.scrollHeight - body.clientHeight : null
      })
    expect(settingsOverflow).not.toBeNull()
    expect(settingsOverflow!).toBeLessThanOrEqual(1)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('automation-settings-dark.png') })

    await page.getByRole('button', { name: '添加自动动作' }).click()
    await page.getByLabel('要运行的命令').fill(hookCommand)
    await page.getByLabel('启用这个自动动作').check()
    await page.getByRole('button', { name: '保存自动动作' }).click()
    await expect(page.locator('.st-hook-saved')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('automation-settings-light.png') })
    const savedSettings = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      return result.ok ? result.data.hooks : []
    })
    expect(savedSettings).toHaveLength(1)
    expect(savedSettings[0]).toMatchObject({ event: 'user_prompt_submit', enabled: true, command: hookCommand })

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '设置' })).toBeHidden()

    // 钩子退出码 2：阻止发送并显示原因，模型不被调用
    await input.fill('这条消息应该被钩子拦住')
    await page.keyboard.press('Enter')
    await expect(page.getByText(/自动动作阻止了这条消息/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('需要先填写作者')).toBeVisible()
    expect(mock.requests).toHaveLength(1)
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
})

})
})


test.describe("07-browser", () => {
// ── 原文件：r10-browser.spec.ts ──────────────────────────────────────────────
test.describe('r10-browser.spec.ts', () => {
/**
 * R10-C/K1 内置浏览器 E2E（真实 Electron + 真实本地 HTTP 服务）。
 *
 * 覆盖：
 * 1. feature:browser:* 频道：URL 安全（file/javascript/data 拒绝）、打开本地页、导航/后退/前进、
 *    bounds 同步、关闭；浏览器视图真实在 release 页面之外的原生 WebContentsView 中渲染。
 * 2. K1 自动化（主进程真实服务，经 --test-mode global 调用与 bridge 相同的实现）：
 *    在用户可见的同一个浏览器里打开页面 → 读取正文 → 真实点击 → 输入 → 截图 → 后退/前进。
 * 3. 下载确认：surface 内下载被暂停，渲染层收到 feature:browser:download 事件；拒绝不落盘、允许落盘。
 * 4. K1 审批（需 Lead 把 browserTools 接入 registry + permissions；R10_BROWSER_TOOLS_E2E=1 时运行）：
 *    ask 与 auto 模式都必须弹审批；批准后工具真实打开页面。
 *
 * 运行前：`npm run build`；本文件使用 tests/e2e/launch.ts 的隔离 data-dir/user-data-dir。
 */

/* ── 本地测试站点 ─────────────────────────────────────────────── */

interface TestSite {
  url: string
  server: Server
  close: () => Promise<void>
}

function startTestSite(): Promise<TestSite> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      const path = request.url ?? '/'
      if (path === '/page2') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>第二页</title>
          <style>
            body{margin:0;min-height:100vh;background:#0b0d10;color:#ede7da;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:48px 56px}
            .eyebrow{margin:0 0 12px;color:#c8ae7d;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em}
            h1{margin:0 0 10px;font-size:30px;font-weight:500}
            p{max-width:560px;margin:0 0 24px;color:#a39d91;font-size:14px;line-height:1.7}
            a{display:inline-flex;padding:9px 14px;border:1px solid rgba(200,174,125,.35);border-radius:8px;color:#c8ae7d;text-decoration:none}
          </style></head><body><p class="eyebrow">MORROW · 浏览器自动化测试</p><h1>第二页</h1>
          <p>这是内置浏览器的测试页面，只用来验证链接跳转、前进与后退，不属于正式应用界面。</p>
          <a id="back" href="/">返回首页</a></body></html>`)
        return
      }
      if (path === '/download') {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="morrow-test-download.txt"'
        })
        response.end('morrow browser e2e download content')
        return
      }
      if (path === '/download-pdf') {
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="morrow-test-download.pdf"'
        })
        response.end('%PDF-1.4\n% morrow e2e download\n')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>浏览器测试首页</title>
        <style>
          body{margin:0;min-height:100vh;background:#0b0d10;color:#ede7da;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:44px 56px}
          .eyebrow{margin:0 0 12px;color:#c8ae7d;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em}
          h1{margin:0 0 10px;font-size:30px;font-weight:500}
          .lead{max-width:600px;margin:0 0 26px;color:#a39d91;font-size:14px;line-height:1.7}
          .panel{max-width:600px;padding:18px;border:1px solid rgba(200,174,125,.24);border-radius:12px;background:#11151b;display:grid;gap:12px}
          .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
          button{padding:8px 13px;border:1px solid rgba(200,174,125,.35);border-radius:8px;background:#17140f;color:#ede7da;font:inherit;cursor:pointer}
          input{padding:8px 11px;border:1px solid #2b3038;border-radius:8px;background:#0b0d10;color:#ede7da;font:inherit;min-width:160px}
          .result{color:#a39d91;font:12px/1.6 ui-monospace,monospace}
          .links{margin-top:18px;display:grid;gap:8px;max-width:600px}
          a{display:block;padding:9px 12px;border:1px solid rgba(200,174,125,.2);border-radius:8px;color:#c8ae7d;text-decoration:none}
        </style></head><body>
        <p class="eyebrow">MORROW · 浏览器自动化测试</p>
        <h1>浏览器测试首页</h1>
        <p class="lead">本地测试站，仅用于验证内置浏览器的点击、输入、导航和下载；测试结束即关闭，不属于正式应用界面。</p>
        <div class="panel">
          <div class="row">
            <button id="btn" onclick="document.getElementById('result').textContent='clicked'">提交</button>
            <input id="name" placeholder="姓名" />
            <label for="email">邮箱</label>
            <input id="email" />
            <label><input id="agree" type="checkbox" /> 同意条款</label>
            <button id="greet" onclick="document.getElementById('greet-result').textContent='你好 '+document.getElementById('name').value">打招呼</button>
          </div>
          <div id="result" class="result">idle</div>
          <div id="greet-result" class="result">idle</div>
        </div>
        <div class="links">
          <a id="next" href="/page2">第二页</a>
          <a id="blank" href="/page2" target="_blank">新窗口打开第二页</a>
          <a id="dl" href="/download">下载文件</a>
          <a id="dlpdf" href="/download-pdf">下载 PDF</a>
        </div>
      </body></html>`)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

let site: TestSite

test.beforeAll(async () => {
  site = await startTestSite()
})

test.afterAll(async () => {
  await site?.close()
})

/* ── 小工具 ──────────────────────────────────────────────────── */

interface FeatureResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

async function invoke<T = unknown>(page: Page, channel: string, payload?: unknown): Promise<FeatureResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<unknown> } } }).morrow
      return (await api.features.invoke(arg.channel, arg.payload)) as FeatureResult<T>
    },
    { channel, payload }
  )
}

async function waitForBrowserState(page: Page, predicate: (state: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> {
  return waitUntil(
    async () => {
      const result = await invoke<Record<string, unknown>>(page, 'feature:browser:get-state')
      if (result.ok && result.data && predicate(result.data)) return result.data
      return null
    },
    30_000,
    label
  )
}

async function debugInfo(page: Page): Promise<Record<string, unknown>> {
  const result = await invoke<Record<string, unknown>>(page, 'feature:browser:debug-info')
  expect(result.ok, JSON.stringify(result.error)).toBe(true)
  return result.data as Record<string, unknown>
}

/** 在主进程里直接调用浏览器自动化实现（与 bridge 使用同一套方法） */
async function automation<T>(app: ElectronApplication, method: string, args: unknown[] = []): Promise<T> {
  return app.evaluate(
    async (_electron, arg: { method: string; args: unknown[] }) => {
      const service = (globalThis as unknown as { __morrowBrowserService?: Record<string, (...params: unknown[]) => Promise<unknown>> })
        .__morrowBrowserService
      if (!service) throw new Error('__morrowBrowserService 未暴露（需要 --test-mode）')
      const fn = service[arg.method]
      if (typeof fn !== 'function') throw new Error(`未知自动化方法：${arg.method}`)
      return (await fn.call(service, ...arg.args)) as T
    },
    { method, args }
  )
}

/* ── 1. feature IPC + URL 安全 + surface ─────────────────────── */

test('feature:browser 频道：URL 安全拦截、打开本地页、导航/历史/bounds/关闭', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-surface' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 1) 危险协议全部拒绝
    for (const badUrl of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'about:blank']) {
      const result = await invoke(page, 'feature:browser:open', { url: badUrl })
      expect(result.ok, badUrl).toBe(false)
      expect(result.error?.message, badUrl).toBeTruthy()
    }

    // 2) 打开本地 HTTP 页面 + bounds 同步
    const opened = await invoke<Record<string, unknown>>(page, 'feature:browser:open', {
      url: `${site.url}/`,
      bounds: { x: 80, y: 120, width: 720, height: 420 }
    })
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    const loaded = await waitForBrowserState(page, (state) => state.url === `${site.url}/` && state.title === '浏览器测试首页', 'surface 首页加载')
    expect(loaded.loading).toBe(false)

    const info = await debugInfo(page)
    expect(info.surface).toBe(true)
    expect(String(info.surfaceUrl)).toBe(`${site.url}/`)
    expect(info.surfaceBounds).toEqual({ x: 80, y: 120, width: 720, height: 420 })

    // 3) 导航 / 后退 / 前进
    const navResult = await invoke(page, 'feature:browser:navigate', { url: `${site.url}/page2` })
    expect(navResult.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '第二页', 'surface 第二页')
    const backResult = await invoke<Record<string, unknown>>(page, 'feature:browser:back')
    expect(backResult.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', 'surface 后退')
    const forwardResult = await invoke<Record<string, unknown>>(page, 'feature:browser:forward')
    expect(forwardResult.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '第二页', 'surface 前进')

    // 4) 关闭 → 状态复位，原生视图移除
    const closed = await invoke<Record<string, unknown>>(page, 'feature:browser:close')
    expect(closed.ok).toBe(true)
    expect((closed.data as Record<string, unknown>).open).toBe(false)
    const afterClose = await debugInfo(page)
    expect(afterClose.surface).toBe(false)
  } finally {
    await morrow.close()
  }
})

/* ── 1.5 真实站点交互 / 错误恢复 ─────────────────────────────── */

test('target=_blank 链接同视图打开；加载失败后后退能清错并恢复页面', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-recovery' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    await dismissOnboarding(page)
    const opened = await invoke(page, 'feature:browser:open', {
      url: `${site.url}/`,
      bounds: { x: 320, y: 90, width: 1200, height: 720 }
    })
    expect(opened.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', '首页加载')

    // 真实网站大量使用 target=_blank：单视图浏览器应在本视图打开，而不是「点了没反应」
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('blank').click()")
    })
    await waitForBrowserState(page, (state) => state.title === '第二页' && state.url === `${site.url}/page2`, '新窗口链接同视图打开')

    // 加载失败：应显示错误并隐藏原生视图
    const failed = await invoke(page, 'feature:browser:navigate', { url: 'http://127.0.0.1:1/' })
    expect(failed.ok).toBe(true)
    await waitForBrowserState(page, (state) => Boolean(state.error) && state.visible === false, '失败状态')

    // 后退到上一次正常页面：错误清除、视图重新可见
    const back = await invoke<Record<string, unknown>>(page, 'feature:browser:back')
    expect(back.ok, JSON.stringify(back.error)).toBe(true)
    const recovered = await waitForBrowserState(
      page,
      (state) => !state.error && state.visible === true && (state.title === '第二页' || state.title === '浏览器测试首页'),
      '失败后后退恢复'
    )
    expect(recovered.loading).toBe(false)
    // 原生 WebContentsView 不在 page.screenshot 的合成层里，直接从浏览器 webContents 取图
    const shotBase64 = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: { surface: { view: { webContents: { capturePage: () => Promise<{ toPNG: () => Buffer }> } } } }
      }).__morrowBrowserService
      const image = await service.surface.view.webContents.capturePage()
      return image.toPNG().toString('base64')
    })
    writeFileSync(screenshotPath('browser-navigation-recovery-dark.png'), Buffer.from(shotBase64, 'base64'))
  } finally {
    await morrow.close()
  }
})

/* ── 2. K1 自动化原语 ───────────────────────────────────────── */

test('K1 自动化：读取 → 真实点击 → 真实输入 → 截图 → 后退/前进（可见视图）', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-automation' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const runId = 'e2e-browser-automation'

    const state = await automation<Record<string, unknown>>(morrow.app, 'automationOpen', [`${site.url}/`, { runId }])
    expect(String(state.url)).toBe(`${site.url}/`)

    const read = await automation<{ url: string; title: string; text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(read.title).toBe('浏览器测试首页')
    expect(read.text).toContain('浏览器测试首页')

    const click = await automation<{ target: string }>(morrow.app, 'automationClick', ['#btn', { runId }])
    expect(click.target).toContain('提交')
    // 页面脚本在 DOMContentLoaded 后绑定点击处理；轮询真实 DOM 结果，避免读到点击前文本
    const afterClick = await waitUntil(
      async () => {
        const current = await automation<{ text: string }>(morrow.app, 'automationRead', [{ runId }])
        return current.text.includes('clicked') ? current : null
      },
      10_000,
      '点击后的页面文本',
      1_000
    )
    expect(afterClick.text).toContain('clicked')

    // 按 placeholder/可见文本定位输入框（不是 CSS selector）
    await automation(morrow.app, 'automationType', ['姓名', 'Morrow 测试', { runId }])
    await automation(morrow.app, 'automationClick', ['#greet', { runId }])
    const afterType = await automation<{ text: string }>(morrow.app, 'automationRead', [{ runId }])
    expect(afterType.text).toContain('你好 Morrow 测试')

    // 关联 label（for=email）也能定位；不支持文字输入的控件给出明确错误
    await automation(morrow.app, 'automationType', ['邮箱', 'morrow@example.test', { runId }])
    const email = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      return service.debugSurfaceScript("document.getElementById('email').value")
    })
    expect(email).toBe('morrow@example.test')
    await expect(automation(morrow.app, 'automationType', ['同意条款', 'x', { runId }])).rejects.toThrow(/不支持文字输入/)

    const shot = await automation<{ pngBase64: string; width: number; height: number }>(morrow.app, 'automationScreenshot', [{ runId }])
    expect(shot.pngBase64.length).toBeGreaterThan(1000)
    expect(Buffer.from(shot.pngBase64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(shot.width).toBeGreaterThan(100)
    expect(shot.height).toBeGreaterThan(100)

    // 历史：点击页内链接 → 第二页 → 后退 → 首页（点击后轮询真实导航结果）
    // 用独立 runId，避免历史轮询消耗主流程的步数预算
    const historyRun = 'e2e-browser-history'
    const linkClick = await automation<{ url: string; title: string; target: string; x: number; y: number; navigating: boolean }>(
      morrow.app,
      'automationClick',
      ['#next', { runId: historyRun }]
    )
    // 点击目标断言：必须命中「第二页」链接，坐标在窗口内，且确实触发了导航
    expect(linkClick.target).toContain('第二页')
    expect(linkClick.x).toBeGreaterThan(0)
    expect(linkClick.y).toBeGreaterThan(0)
    expect(linkClick.navigating).toBe(true)
    const page2 = await waitUntil(
      async () => {
        const current = await automation<{ url: string; title: string }>(morrow.app, 'automationRead', [{ runId: historyRun }])
        return current.url.endsWith('/page2') ? current : null
      },
      10_000,
      '自动化点击链接后的导航'
    )
    expect(page2.url).toBe(`${site.url}/page2`)
    await automation(morrow.app, 'automationBack', [{ runId: historyRun }])
    const back = await automation<{ url: string }>(morrow.app, 'automationRead', [{ runId: historyRun }])
    expect(back.url).toBe(`${site.url}/`)
    await automation(morrow.app, 'automationForward', [{ runId: historyRun }])
    const forward = await automation<{ url: string }>(morrow.app, 'automationRead', [{ runId: historyRun }])
    expect(forward.url).toBe(`${site.url}/page2`)

    // 步数预算：同一 runId 连续调用应被上限拦下（BROWSER_LIMITS.maxActionsPerRun=40）
    const budgetRun = 'e2e-browser-budget'
    let limited = false
    for (let index = 0; index < 45; index += 1) {
      try {
        await automation(morrow.app, 'automationRead', [{ runId: budgetRun }])
      } catch (err) {
        limited = String(err).includes('步数上限')
        break
      }
    }
    expect(limited).toBe(true)

    const info = await debugInfo(page)
    expect(info.automationOpen).toBe(true)
    expect(String(info.automationUrl)).toBe(`${site.url}/page2`)

    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { closeAutomation: () => Promise<void> } }).__morrowBrowserService
      await service.closeAutomation()
    })
  } finally {
    await morrow.close()
  }
})

/* ── 2.5 Agent 复用同一个可见 surface ───────────────────────── */

test('Agent 自动化复用同一个可见浏览器：导航与失败都反映在面板', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-unified' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const opened = await invoke(page, 'feature:browser:open', { url: `${site.url}/` })
    expect(opened.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', 'surface 首页加载')

    // Agent 打开新页面：同一个 surface 跟着导航，面板自动展开并显示“Morrow 操作中”
    await automation(morrow.app, 'automationOpen', [`${site.url}/page2`, { runId: 'e2e-unified' }])
    const afterSuccess = await waitForBrowserState(page, (state) => state.title === '第二页', 'surface 跟随 Agent 导航')
    expect(String(afterSuccess.url)).toContain('/page2')
    await expect(page.locator('.browser-surface')).toBeVisible()
    await expect(page.locator('.browser-agent-chip')).toContainText('Morrow 操作中')
    await page.screenshot({ path: screenshotPath('browser-unified-agent.png') })
    const info = await debugInfo(page)
    expect(info.surface).toBe(true)
    expect(String(info.surfaceUrl)).toContain('/page2')
    expect(info.automationActive).toBe(true)

    // 加载失败也展示在同一个面板里
    await automation(morrow.app, 'automationOpen', ['http://127.0.0.1:1/', { runId: 'e2e-unified' }]).catch(() => undefined)
    const afterFailure = await waitForBrowserState(page, (state) => Boolean(state.error), 'surface 显示加载失败')
    expect(String((afterFailure.error as { message?: string }).message)).toContain('页面加载失败')
    expect((await debugInfo(page)).surface).toBe(true)

    // Agent 关闭浏览器：面板与 surface 一起关闭
    await automation(morrow.app, 'closeAutomation').catch(() => undefined)
    expect((await debugInfo(page)).surface).toBe(false)
  } finally {
    await morrow.close()
  }
})

/* ── 2.8 窗口归属：绝不把网页嵌进灵动岛 ─────────────────────── */

test('Agent 打开浏览器时挂在主窗口，而不是聚焦的灵动岛', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-owner', env: { MORROW_ISLAND: '1' } })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    const windows = await morrow.app.evaluate(async ({ BrowserWindow }) => {
      const all = BrowserWindow.getAllWindows()
      const island = all.find((win) => win.webContents.getURL().includes('#island'))
      const main = all.find((win) => !win.webContents.getURL().includes('#island') && win.getContentBounds().width >= 800)
      if (!island || !main) return { island: false, main: false, focusedTitle: '' }
      main.hide()
      island.show()
      island.moveTop()
      // Windows 桌面会话可能拒绝测试进程抢焦点；轮询后仍失败时只记录，不把环境限制当成产品回归。
      let islandFocused = false
      for (let attempt = 0; attempt < 10; attempt += 1) {
        island.focus()
        island.webContents.focus()
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (island.isFocused()) {
          islandFocused = true
          break
        }
      }
      return { island: true, main: true, islandFocused }
    })
    expect(windows.island, JSON.stringify(windows)).toBe(true)
    expect(windows.main).toBe(true)
    if (!windows.islandFocused) console.warn('[browser-owner] 当前桌面会话拒绝测试窗口抢焦点；继续验证 surface 归属')

    await automation(morrow.app, 'automationOpen', [`${site.url}/`, { runId: 'e2e-owner' }])
    const info = await debugInfo(page)
    expect(info.surface).toBe(true)
    expect(info.surfaceOwnerTitle).toBe('Morrow')
    const ownerSize = info.surfaceOwnerSize as { width: number; height: number }
    expect(ownerSize.width).toBeGreaterThanOrEqual(800)
    expect(ownerSize.height).toBeGreaterThanOrEqual(600)
  } finally {
    await morrow.close()
  }
})

/* ── 3. 下载确认 ────────────────────────────────────────────── */

test('下载确认：surface 下载暂停等确认；拒绝不落盘、允许写入 data/downloads', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-download' })
  try {
    const { page, dataDir } = morrow
    await page.waitForLoadState('domcontentloaded')

    const opened = await invoke(page, 'feature:browser:open', { url: `${site.url}/` })
    expect(opened.ok).toBe(true)
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', '下载测试页面加载')

    // 渲染层订阅下载事件（与真实 BrowserSurface 相同的频道）
    await page.evaluate(() => {
      const scope = window as unknown as {
        __downloadEvents?: unknown[]
        __downloadResolved?: unknown[]
        morrow: { features: { on: (channel: string, listener: (payload: unknown) => void) => () => void } }
      }
      scope.__downloadEvents = []
      scope.__downloadResolved = []
      scope.morrow.features.on('feature:browser:download', (payload) => scope.__downloadEvents!.push(payload))
      scope.morrow.features.on('feature:browser:download-resolved', (payload) => scope.__downloadResolved!.push(payload))
    })

    // 在 surface 页面里真实点击下载链接
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('dl').click()")
    })
    const download = await waitUntil(async () => {
      const events = await page.evaluate(() => ((window as unknown as { __downloadEvents?: unknown[] }).__downloadEvents ?? [])[0] as Record<string, unknown> | undefined)
      return events ?? null
    }, 20_000, '下载确认事件')

    expect(String(download.filename)).toBe('morrow-test-download.txt')
    expect(String(download.url)).toContain('/download')
    const suggestedPath = String(download.suggestedPath)
    expect(suggestedPath.startsWith(dataDir)).toBe(true)
    raceCleanup(suggestedPath)

    // 拒绝：不落盘
    const denied = await invoke(page, 'feature:browser:decide-download', { id: String(download.id), allow: false })
    expect(denied.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(existsSync(suggestedPath)).toBe(false)

    // 允许：写入 dataDir/downloads
    await page.evaluate(() => {
      ;(window as unknown as { __downloadEvents?: unknown[] }).__downloadEvents = []
    })
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('dl').click()")
    })
    const second = await waitUntil(async () => {
      const events = await page.evaluate(() => ((window as unknown as { __downloadEvents?: unknown[] }).__downloadEvents ?? [])[0] as Record<string, unknown> | undefined)
      return events ?? null
    }, 20_000, '第二次下载确认事件')
    const allowed = await invoke(page, 'feature:browser:decide-download', { id: String(second.id), allow: true })
    expect(allowed.ok).toBe(true)
    const savedPath = String(second.suggestedPath)
    await waitUntil(async () => (existsSync(savedPath) ? true : null), 15_000, '下载文件落盘')
    expect(existsSync(savedPath)).toBe(true)
    raceCleanup(savedPath)
  } finally {
    await morrow.close()
  }
})

test('下载同名冲突时保留原扩展名，不把 .pdf 变成 .pdf-时间戳', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r10-browser-download-collision' })
  try {
    const { page } = morrow
    await page.waitForLoadState('domcontentloaded')
    await invoke(page, 'feature:browser:open', { url: `${site.url}/` })
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', '冲突测试页面加载')
    await page.evaluate(() => {
      const scope = window as unknown as {
        __downloadEvents?: unknown[]
        __downloadResolved?: unknown[]
        morrow: { features: { on: (channel: string, listener: (payload: unknown) => void) => () => void } }
      }
      scope.__downloadEvents = []
      scope.__downloadResolved = []
      scope.morrow.features.on('feature:browser:download', (payload) => scope.__downloadEvents!.push(payload))
      scope.morrow.features.on('feature:browser:download-resolved', (payload) => scope.__downloadResolved!.push(payload))
    })

    const downloadPdf = async (): Promise<string> => {
      await page.evaluate(() => {
        ;(window as unknown as { __downloadEvents?: unknown[]; __downloadResolved?: unknown[] }).__downloadEvents = []
        ;(window as unknown as { __downloadEvents?: unknown[]; __downloadResolved?: unknown[] }).__downloadResolved = []
      })
      await morrow.app.evaluate(async () => {
        const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
        await service.debugSurfaceScript("document.getElementById('dlpdf').click()")
      })
      const request = await waitUntil(async () => {
        const events = await page.evaluate(() => (window as unknown as { __downloadEvents?: Array<Record<string, unknown>> }).__downloadEvents ?? [])
        return events[0] ?? null
      }, 20_000, 'PDF 下载确认事件')
      const allowed = await invoke(page, 'feature:browser:decide-download', { id: String(request.id), allow: true })
      expect(allowed.ok).toBe(true)
      const resolved = await waitUntil(async () => {
        const events = await page.evaluate(() => (window as unknown as { __downloadResolved?: Array<Record<string, unknown>> }).__downloadResolved ?? [])
        return events.find((item) => item.allow === true && typeof item.path === 'string') ?? null
      }, 20_000, 'PDF 下载落盘')
      const path = String(resolved.path)
      expect(existsSync(path)).toBe(true)
      return path
    }

    const first = await downloadPdf()
    const second = await downloadPdf()
    expect(first.endsWith('.pdf')).toBe(true)
    expect(second.endsWith('.pdf')).toBe(true)
    expect(second).not.toBe(first)
    raceCleanup(first)
    raceCleanup(second)
  } finally {
    await morrow.close()
  }
})

function raceCleanup(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 忽略
  }
}

/* ── 4. K1 审批（依赖 Lead 集成 browserTools 到 registry+permissions） ── */

test.describe('K1 审批（registry + permissions 已集成）', () => {
  test('ask 模式被动浏览直接执行；auto 模式直接执行；browser_open 真实打开页面', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '我来打开网页。', toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}/` } }] },
        { text: '网页已打开。' },
        { text: '我再打开一次。', toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}/page2` } }] },
        { text: '完成。' }
      ]
    })
    const workspace = join(root, 'tmp', `r10-browser-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const morrow = await launchMorrow({ name: 'r10-browser-approval' })
    try {
      const { page } = morrow
      const ready = await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      for (const mode of ['ask', 'auto'] as const) {
        await createSession(page, { workspace, ...provider, permissionMode: mode, title: `浏览器审批 ${mode}` })
        await sendMessageViaStore(page, '帮我在 Morrow 内置浏览器打开测试网页。')
        await waitForRunFinished(page, 60_000)
        const events = await getEvents(page)
        // browser_open 是被动浏览：ask 与 auto 都不应弹审批（点击/输入才逐次确认）
        const prompts = events.filter((event) => event.type === 'permission_requested')
        expect(prompts.length, `${mode} 模式审批次数`).toBe(0)
        const finished = events.filter((event) => event.type === 'tool_finished' && (event as { result?: { ok?: boolean } }).result?.ok === true)
        expect(finished.length, `${mode} 模式 browser_open 应成功`).toBeGreaterThanOrEqual(1)
        // 等 store 的 run 收尾（waitForRunFinished 返回的是事件，run 状态可能再晚一个 tick 清理）
        await waitUntil(async () => ((await readStore(page)).run ? null : true), 30_000, `${mode} 模式 run 收尾`)
        const info = await debugInfo(page)
        expect(info.automationOpen, mode).toBe(true)
        expect(String(info.automationUrl), mode).toMatch(new RegExp(`${site.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(page2)?`))
        // 清理：关闭浏览器，等待下一轮
        await morrow.app.evaluate(async () => {
          const service = (globalThis as unknown as { __morrowBrowserService: { closeAutomation: () => Promise<void> } }).__morrowBrowserService
          await service.closeAutomation()
        })
        await clearRuns(page)
        await clearEvents(page)
      }
      expect(mock.calls).toBeGreaterThanOrEqual(4)
    } finally {
      await morrow.close()
      await mock.close()
      try {
        rmSync(workspace, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    }
  })
})

async function clearRuns(page: Page): Promise<void> {
  // 等待 store 的 run 状态自然收尾（事件已由 store 处理）；无需额外清理
  await waitUntil(async () => ((await readStore(page)).run ? null : true), 10_000, 'run 收尾')
}

test('真实 UI：工作台打开浏览器后原生视图拿到 bounds 且可见（不黑屏）', async () => {
  const morrow = await launchMorrow({ name: 'r10-browser-ui-bounds', waitForSelector: '.sidebar', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('browser-empty-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('browser-empty-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)
    await page.locator('.browser-address-input').fill(`${site.url}/`)
    await page.locator('.browser-address-input').press('Enter')
    await waitForBrowserState(page, (state) => state.title === '浏览器测试首页', 'UI 浏览器首页')

    const info = await debugInfo(page)
    expect(info.surface, JSON.stringify(info)).toBe(true)
    expect(info.surfaceVisible, JSON.stringify(info)).toBe(true)
    const bounds = info.surfaceBounds as { width: number; height: number } | null
    expect(bounds?.width ?? 0).toBeGreaterThan(0)
    expect(bounds?.height ?? 0).toBeGreaterThan(0)
    const size = info.surfaceWebContentsSize as { width: number; height: number } | null
    expect(size?.width ?? 0).toBeGreaterThan(0)
    expect(size?.height ?? 0).toBeGreaterThan(0)

    // 下载确认 → 允许 → 成功提示可打开下载文件夹
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> } }).__morrowBrowserService
      await service.debugSurfaceScript("document.getElementById('dl').click()")
    })
    const downloadDialog = page.getByRole('dialog', { name: '下载确认' })
    await expect(downloadDialog).toBeVisible({ timeout: 20_000 })
    const viewportBox = await page.locator('.browser-viewport').boundingBox()
    expect(viewportBox).not.toBeNull()
    await waitUntil(
      async () => {
        const details = await debugInfo(page)
        const bounds = details.surfaceBounds as { height: number } | null
        return bounds && viewportBox && bounds.height <= viewportBox.height - 140 ? true : null
      },
      5_000,
      '下载确认浮层让出原生视图空间'
    )
    await downloadDialog.getByRole('button', { name: '允许下载' }).click()
    const successToast = page.locator('.browser-toast.is-success')
    await expect(successToast).toBeVisible({ timeout: 20_000 })
    await expect(successToast).toContainText('morrow-test-download.txt')
    await expect(successToast.getByRole('button', { name: '打开文件夹' })).toBeVisible()
    await waitUntil(
      async () => {
        const details = await debugInfo(page)
        const bounds = details.surfaceBounds as { height: number } | null
        return bounds && viewportBox && bounds.height <= viewportBox.height - 56 ? true : null
      },
      5_000,
      '下载成功提示让出原生视图空间'
    )
    await page.screenshot({ path: screenshotPath('browser-download-saved.png') })

    // 定位只允许 downloads 内的真实文件（不弹出资源管理器，只验证拒绝路径）
    const outside = join(root, 'tmp', `browser-reveal-outside-${Date.now()}.txt`)
    writeFileSync(outside, 'x', 'utf8')
    const outsideReveal = await invoke(page, 'feature:browser:reveal-download', { path: outside })
    expect(outsideReveal.ok).toBe(false)
    expect(outsideReveal.error?.message).toContain('下载目录')
    const missingReveal = await invoke(page, 'feature:browser:reveal-download', {
      path: join(morrow.dataDir, 'downloads', 'missing-download.txt')
    })
    expect(missingReveal.ok).toBe(false)
    expect(missingReveal.error?.message).toContain('移动或删除')
    rmSync(outside, { force: true })
    rmSync(join(morrow.dataDir, 'downloads'), { recursive: true, force: true })
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：search-global.spec.ts ──────────────────────────────────────────────
test.describe('search-global.spec.ts', () => {
/**
 * 全局搜索：默认跨全部工作区；可切换当前文件夹；会话命中后跳到原句并高亮。
 */

const TOKEN = '沧海月明唯一检索词'

function makeDir(prefix: string): string {
  return mkdtempSync(join(root, 'tmp', `${prefix}-`))
}

function sessionJson(input: {
  id: string
  title: string
  workspace: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
}): string {
  return JSON.stringify({
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: { providerId: 'demo', modelId: 'morrow-demo' },
    permissionMode: 'read-only',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: input.messages.length,
    messages: input.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      createdAt: Date.now()
    })),
    todos: [],
    artifacts: [],
    usage: { inputTokens: 0, outputTokens: 0 }
  })
}

test('浏览器全屏面板隐藏标题栏，地址栏从左到右整段可聚焦', async () => {
  const morrow = await launchMorrow({ name: 'browser-address-focus', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    const input = page.locator('.browser-address-input')
    await input.waitFor({ state: 'visible' })

    // 顶部标题栏的原生拖动区会把地址栏切成多块焦点区；浏览器面板必须独占顶部。
    await expect(page.locator('.titlebar')).toBeHidden()
    const box = await input.boundingBox()
    expect(box).not.toBeNull()
    for (const ratio of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      await page.mouse.click(box!.x + box!.width * ratio, box!.y + box!.height / 2)
      const focused = await page.evaluate(() => document.activeElement?.className ?? '')
      expect(focused, `地址栏 x=${ratio} 应可聚焦`).toContain('browser-address-input')
    }

    await page.locator('[aria-label="返回主页面"]').click()
    await expect(page.locator('.titlebar')).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'browser' } }))
    })
    await expect(page.locator('.titlebar')).toBeHidden()
  } finally {
    await morrow.close()
  }
})

test('内置浏览器多标签：新建、切换、关闭', async () => {
  const tabsServer = createServer((request, response) => {
    const two = request.url?.startsWith('/page2')
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${two ? '第二页' : '浏览器测试首页'}</title></head><body>${two ? 'two' : 'one'}</body></html>`)
  })
  await new Promise<void>((resolve) => tabsServer.listen(0, '127.0.0.1', resolve))
  const tabsBase = `http://127.0.0.1:${(tabsServer.address() as AddressInfo).port}`
  const morrow = await launchMorrow({ name: 'browser-tabs', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await openToolPanel(page, '内置浏览器')
    const address = page.locator('.browser-address-input')
    await address.waitFor({ state: 'visible' })
    await expect(page.locator('.browser-tab')).toHaveCount(0)

    await address.fill(`${tabsBase}/`)
    await address.press('Enter')
    await expect(page.locator('.browser-tab')).toHaveCount(1)
    await expect(page.locator('.browser-tab.is-active .browser-tab-title')).toHaveText('浏览器测试首页')
    const activeTab = page.locator('.browser-tab.is-active')
    await expect(activeTab).toHaveCSS('height', '24px')
    await expect(activeTab).toHaveCSS('border-radius', '5px')

    await page.locator('[aria-label="新建标签页"]').click()
    await expect(page.locator('.browser-tab')).toHaveCount(2)
    await expect(address).toHaveValue('')
    await address.fill(`${tabsBase}/page2`)
    await address.press('Enter')
    await expect(page.locator('.browser-tab.is-active .browser-tab-title')).toHaveText('第二页')
    await page.screenshot({ path: screenshotPath('browser-tabs-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('browser-tabs-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)

    // 切回第一个标签：页面与地址恢复
    await page.locator('.browser-tab').first().click()
    await expect(page.locator('.browser-tab').first()).toHaveClass(/is-active/)
    await expect(address).toHaveValue(`${tabsBase}/`)
    await expect(page.locator('.browser-tab').first().locator('.browser-tab-title')).toHaveText('浏览器测试首页')

    // 关闭第一个标签，第二个接管
    await page.locator('.browser-tab').first().locator('.browser-tab-close').click()
    await expect(page.locator('.browser-tab')).toHaveCount(1)
    await expect(page.locator('.browser-tab.is-active .browser-tab-title')).toHaveText('第二页')
    await expect(address).toHaveValue(`${tabsBase}/page2`)

    // 关闭最后一个标签，面板收起
    await page.locator('.browser-tab.is-active .browser-tab-close').click()
    await expect(page.locator('.workbench-browser-overlay')).toBeHidden()
    await expect(page.locator('.titlebar')).toBeVisible()
  } finally {
    await morrow.close()
    await new Promise<void>((resolve) => tabsServer.close(() => resolve()))
  }
})

test('默认搜索全部项目；可切换当前文件夹；会话命中跳到原句并高亮', async () => {
  test.setTimeout(120_000)
  const workspaceA = makeDir('search-global-a')
  const workspaceB = makeDir('search-global-b')
  const dataDir = makeDir('search-global-data')
  mkdirSync(join(dataDir, 'sessions'), { recursive: true })
  writeFileSync(join(workspaceA, 'A-唯一检索词.md'), `# A\n\n${TOKEN}\n`, 'utf8')
  writeFileSync(join(workspaceB, 'B-唯一检索词.md'), `# B\n\n${TOKEN}\n`, 'utf8')

  const targetMessages = Array.from({ length: 40 }, (_, index) => ({
    id: index === 25 ? 'm_target' : `m_${index}`,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: index === 25 ? `这里藏着 ${TOKEN}，请定位到这一句。` : `第 ${index + 1} 条占位消息，用于制造足够长的对话。`
  }))
  writeFileSync(
    join(dataDir, 'sessions', 's_target.json'),
    sessionJson({ id: 's_target', title: '定位测试会话', workspace: workspaceA, messages: targetMessages }),
    'utf8'
  )
  writeFileSync(
    join(dataDir, 'sessions', 's_other.json'),
    sessionJson({
      id: 's_other',
      title: '另一个项目的会话',
      workspace: workspaceB,
      messages: [{ id: 'm_other', role: 'user', text: '我在另一个文件夹里。' }]
    }),
    'utf8'
  )

  const morrow = await launchMorrow({ name: 'search-global', dataDir, waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      await (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .selectSession('s_other')
    })
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId
        )) === 's_other',
      10_000,
      '切到另一个项目的会话'
    )

    await openToolPanel(page, '全局搜索')
    const input = page.getByRole('textbox', { name: '全局搜索' })
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill(TOKEN)

    // 默认「全部」：两个项目的文件都能搜到
    await expect(page.locator('.search-hit').filter({ hasText: 'A-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.search-hit').filter({ hasText: 'B-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })

    // 未登记目录不能作为搜索范围（否则索引器会读取任意目录）
    const outside = makeDir('search-global-outside')
    writeFileSync(join(outside, 'secret.md'), `outside ${TOKEN}`, 'utf8')
    const blocked = await page.evaluate(async (arg: { path: string; token: string }) => {
      const invoke = (channel: string, payload: Record<string, unknown>) =>
        window.morrow.features.invoke(channel, payload) as Promise<{ ok: boolean; error?: { message?: string } }>
      return {
        query: await invoke('feature:search:query', { q: arg.token, workspace: arg.path }),
        refresh: await invoke('feature:search:refresh', { workspace: arg.path })
      }
    }, { path: outside, token: TOKEN })
    expect(blocked.query.ok).toBe(false)
    expect(blocked.query.error?.message).toContain('已登记')
    expect(blocked.refresh.ok).toBe(false)
    expect(blocked.refresh.error?.message).toContain('已登记')
    rmSync(outside, { recursive: true, force: true })

    await page.screenshot({ path: screenshotPath('search-global-all.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('search-global-all-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 切到当前文件夹（workspaceB）：只剩 B
    const dialog = page.getByRole('dialog', { name: '全局搜索' })
    await dialog.getByRole('button', { name: '当前文件夹' }).click()
    await expect(page.locator('.search-hit').filter({ hasText: 'B-唯一检索词.md' })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.search-hit').filter({ hasText: 'A-唯一检索词.md' })).toHaveCount(0)

    // 切回全部，点击会话命中：切到目标会话并跳到原句
    await dialog.getByRole('button', { name: '全部' }).click()
    const sessionHit = page.locator('.search-hit').filter({ hasText: '定位测试会话' }).first()
    await expect(sessionHit).toBeVisible({ timeout: 15_000 })
    await sessionHit.click()
    await waitUntil(
      async () =>
        (await page.evaluate(
          () => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId
        )) === 's_target',
      15_000,
      '切换到命中会话'
    )
    const highlight = page.locator('[data-message-id="m_target"].is-search-hit')
    await waitUntil(async () => (await highlight.count()) > 0, 8_000, '命中消息金色高亮')
    await page.waitForTimeout(350)
    const box = await highlight.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    if (box && viewport) {
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeLessThan(viewport.height)
    }
    await page.screenshot({ path: screenshotPath('search-global-jump.png') })
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：search-consistency.spec.ts ──────────────────────────────────────────────
test.describe('search-consistency.spec.ts', () => {
/**
 * 全局搜索一致性回归：
 * 1) 删除会话后索引立即失效；
 * 2) 搜索文件时使用当前会话工作区（不是 lastWorkspace），结果可在编辑器中打开。
 */

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(root, 'tmp', `${prefix}-`))
  return dir
}

test.describe('全局搜索一致性', () => {
  test('删除会话后搜索索引立即移除该会话', async () => {
    test.setTimeout(60_000)
    const workspace = makeDir('search-delete-ws')
    const dataDir = makeDir('search-delete-data')
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    const sessionId = 's_searchdel1'
    const token = '海上升明月唯一标记'
    writeFileSync(
      join(dataDir, 'sessions', `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        title: '搜索删除残留测试',
        workspace,
        model: { providerId: 'demo', modelId: 'morrow-demo' },
        permissionMode: 'ask',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 1,
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: token }], createdAt: Date.now() }],
        todos: [],
        artifacts: [],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    )
    const morrow = await launchMorrow({ name: 'search-delete', dataDir, waitForSelector: '.sidebar' })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      // 搜索 IPC 只接受已登记工作区；模拟用户选择过这个文件夹（删除会话后仍保持登记）
      await page.evaluate(async (path) => {
        const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: Record<string, unknown>) => Promise<void> } } }).__morrowStore
        await store.getState().updateSettings({ lastWorkspace: path })
      }, workspace)
      const query = async () =>
        page.evaluate(
          async (arg: { token: string; workspace: string }) => {
            const result = await window.morrow.features.invoke<{
              groups: { sessions: Array<{ sessionId?: string }> }
            }>('feature:search:query', { q: arg.token, workspace: arg.workspace, limit: 20 })
            if (!result.ok) throw new Error(result.error.message)
            return result.data
          },
          { token, workspace }
        )

      const before = await query()
      expect(before.groups.sessions.some((hit) => hit.sessionId === sessionId)).toBe(true)

      const removed = await page.evaluate(async (id: string) => window.morrow.session.remove(id), sessionId)
      expect(removed.ok).toBe(true)
      expect(existsSync(join(dataDir, 'sessions', `${sessionId}.json`))).toBe(false)

      const after = await query()
      expect(after.groups.sessions.some((hit) => hit.sessionId === sessionId)).toBe(false)
    } finally {
      await morrow.close()
    }
  })

  test('搜索文件使用当前会话工作区，并可从结果打开编辑器', async () => {
    test.setTimeout(60_000)
    const workspaceA = makeDir('search-nav-a')
    const workspaceB = makeDir('search-nav-b')
    const dataDir = makeDir('search-nav-data')
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    const fileName = '预算导航.md'
    writeFileSync(join(workspaceA, fileName), '# 预算导航\n\n当前会话工作区里的文件。', 'utf8')
    // 预置一个同工作区、但非当前会话的 artifact 归属会话，验证跨会话结果跳转
    writeFileSync(
      join(dataDir, 'sessions', 's_artowner1.json'),
      JSON.stringify({
        id: 's_artowner1',
        title: '产物归属会话',
        workspace: workspaceA,
        model: { providerId: 'demo', modelId: 'morrow-demo' },
        permissionMode: 'read-only',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        messages: [],
        todos: [],
        artifacts: [
          {
            id: 'art_search_owner',
            title: '独有产物标题',
            kind: 'markdown',
            content: '# 独有产物\n\nARTIFACT-UNIQUE',
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ],
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    )
    const morrow = await launchMorrow({ name: 'search-nav', dataDir, waitForSelector: '.sidebar' })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const sessionId = await page.evaluate(
        async (arg: { workspaceA: string; workspaceB: string }) => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().updateSettings({ lastWorkspace: arg.workspaceB })
          const state = store.getState()
          const created = await window.morrow.session.create({
            workspace: arg.workspaceA,
            model: state.settings.defaultModel,
            permissionMode: 'read-only',
            title: '搜索导航会话'
          })
          if (!created.ok) throw new Error(created.error.message)
          await store.getState().selectSession(created.data.id)
          const list = await window.morrow.session.list()
          if (list.ok) store.setState({ sessions: list.data })
          return created.data.id
        },
        { workspaceA, workspaceB }
      )
      await waitUntil(async () => (await page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId)) === sessionId, 10_000, '会话选中')

      await openToolPanel(page, '全局搜索')
      const input = page.getByRole('textbox', { name: '全局搜索' })
      await expect(input).toBeVisible({ timeout: 10_000 })
      await input.fill('预算导航')
      const hit = page.locator('.search-hit').filter({ hasText: fileName }).first()
      await expect(hit).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('search-workspace-results-dark.png') })
      await hit.click()
      await expect(page.locator('.canvas-head-title')).toContainText(fileName, { timeout: 15_000 })
      await expect(page.locator('.editor-pane')).toBeVisible()

      // artifact 命中来自同工作区的另一个会话：应切回归属会话并打开画布
      await openToolPanel(page, '全局搜索')
      const artifactInput = page.getByRole('textbox', { name: '全局搜索' })
      await expect(artifactInput).toBeVisible({ timeout: 10_000 })
      await artifactInput.fill('独有产物')
      const artifactHit = page.locator('.search-hit').filter({ hasText: '独有产物标题' }).first()
      await expect(artifactHit).toBeVisible({ timeout: 15_000 })
      await artifactHit.click()
      await expect
        .poll(async () => page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState().activeSessionId), { timeout: 15_000 })
        .toBe('s_artowner1')
      await expect(page.locator('.canvas-head-title')).toContainText('独有产物标题', { timeout: 15_000 })
    } finally {
      await morrow.close()
    }
  })
})

})
// ── 原文件：r10-search.spec.ts ──────────────────────────────────────────────
test.describe('r10-search.spec.ts', () => {
/**
 * R10-I 搜索 feature 的 E2E 接线测试。
 * Lead 在 src/main/ipc-index.ts 注册 `import './search'` 且挂载 SearchPanel 后，
 * 本用例会自动从「跳过」变为「真实执行」（同一条测试，不伪造）。
 */

test.describe('R10-I 全局搜索接线', () => {
  test('feature:search:status / query 可用，返回分组与索引状态', async () => {
    const morrow = await launchMorrow({ name: 'r10-search' })
    try {
      await morrow.page.waitForFunction(() => Boolean((window as unknown as { morrow?: unknown }).morrow), undefined, {
        timeout: 30_000
      })
      const status = await morrow.page.evaluate(async () => {
        const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } } }).morrow
        try {
          return await api.features.invoke('feature:search:status', {})
        } catch (err) {
          return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
        }
      })
      test.skip(!status.ok, '搜索模块尚未由 Lead 注册到 features/index.ts（集成后自动执行）')
      expect(status.ok).toBe(true)
      expect(status.data).toMatchObject({ ready: expect.any(Boolean), sessions: expect.any(Number), files: expect.any(Number) })

      const query = await morrow.page.evaluate(async () => {
        const api = (window as unknown as { morrow: { features: { invoke: (c: string, p?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } } }).morrow
        try {
          return await api.features.invoke('feature:search:query', { q: '测试', limit: 5 })
        } catch (err) {
          return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } }
        }
      })
      expect(query.ok).toBe(true)
      expect(query.data).toMatchObject({
        query: '测试',
        groups: { sessions: expect.any(Array), files: expect.any(Array), artifacts: expect.any(Array) },
        total: expect.any(Number),
        tookMs: expect.any(Number)
      })
      const index = (query.data as { index: { workspaces: unknown } }).index
      expect(Array.isArray(index.workspaces)).toBe(true)
    } finally {
      await morrow.close()
    }
  })
})

})
// ── 原文件：web-search.spec.ts ──────────────────────────────────────────────
test.describe('web-search.spec.ts', () => {
/**
 * P0-4 联网搜索 E2E：
 * - 配置 SearXNG → 模型调用 web_search → 工具卡来源 + 会话来源面板；
 * - 设置页「联网搜索」分类可用；
 * - 明暗截图。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('联网搜索：真实网络搜索、工具调用、搜索卡与设置页', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '我来搜索一下。', toolCalls: [{ name: 'web_search', arguments: { query: 'OpenAI Codex', max_results: 3 } }] },
      { text: '根据 [1]，OpenAI Codex 是一个在本地运行的编程 Agent。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'web-search', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    // 默认配置即可：内置 Bing 搜索，无需 Key 或本机搜索服务
    const web = (await readStore(page)).ready
    expect(web).toBe(true)

    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-web-search'),
      ...provider,
      permissionMode: 'auto',
      title: '联网搜索测试'
    })
    await page.locator('.composer-input').fill('搜索一下 Morrow 是什么')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/OpenAI Codex 是一个在本地运行的编程 Agent/)).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '搜索运行结束')

    // 搜索运行时自动展开；若用户/测试已收起，再点一次展开
    if ((await page.locator('.spine-sources').count()) === 0) {
      await page.locator('.spine-item').first().click()
    }
    await expect(page.locator('.spine-search')).toBeVisible()

    // 会话来源面板
    await expect(page.locator('.sources-tray')).toBeVisible()
    await page.locator('.sources-head').click()
    expect(await page.locator('.sources-item').count()).toBeGreaterThan(0)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('web-search-sources-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('web-search-sources-light.png') })
    await setThemeViaStore(page, 'dark')

    // 设置页
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '联网搜索' }).click()
    await expect(page.locator('.st-search')).toBeVisible()
    await expect(page.locator('.st-search')).toContainText('自动联网搜索')
    await expect(page.locator('.st-search')).toContainText('内置多引擎搜索')
    await page.getByRole('button', { name: /保存并测试/ }).click()
    await expect(page.locator('.st-search-test')).toContainText(/连接正常|返回 \d+ 条/, { timeout: 30_000 })
    await page.locator('.st-panel').evaluate((element) => element.scrollTo({ top: 0 }))
    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('web-search-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('web-search-settings-light.png') })
    await setThemeViaStore(page, 'dark')

    const settings = (await readStore(page)).ready
    expect(settings).toBe(true)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r13-browser-retry.spec.ts ──────────────────────────────────────────────
test.describe('r13-browser-retry.spec.ts', () => {
/**
 * 本地预览服务启动竞态：terminal(start) 后端口稍后才监听时，
 * browser_open 应短暂重试，而不是立即报 ERR_CONNECTION_REFUSED。
 */

function listenLater(server: Server, port: number, delayMs: number): void {
  setTimeout(() => {
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      // 测试结束时可能已关闭
    }
  }, delayMs)
}

test('本地预览端口稍后监听时 browser_open 会自动重试成功', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-browser-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>preview-ok</title><style>html,body{margin:0;background:#0b0f13;color:#d6be91}body{height:2400px}</style></head><body>preview ok</body></html>')
  })
  const port = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(chosen))
    })
  })
  // 模拟 terminal(start) 已返回，但 Python http.server 还没真正 listen。
  listenLater(server, port, 700)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '打开本地预览。',
        toolCalls: [{ name: 'browser_open', arguments: { url: `http://127.0.0.1:${port}/` } }]
      },
      { text: '打开了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-browser-retry', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '本地预览重试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '打开本地预览页面。')
    await waitForRunFinished(page, 90_000)
    const event = (await getEvents(page))
      .filter((entry) => entry.type === 'tool_finished')
      .at(-1) as { result?: { ok?: boolean; output?: string } } | undefined
    expect(event?.result?.ok, event?.result?.output).toBe(true)
    expect(String(event?.result?.output ?? '')).toContain('已在 Morrow 浏览器打开')

    // 远程页面看不到宿主 CSS：滚动条样式必须注入到 surface 页面本身
    const browserDebug = await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: { debugInfo: () => { scrollbarCssApplied: boolean } }
      }).__morrowBrowserService
      return service.debugInfo()
    })
    expect(browserDebug.scrollbarCssApplied).toBe(true)
    const scrollbarStyle = (await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as {
        __morrowBrowserService: { debugSurfaceScript: (script: string) => Promise<unknown> }
      }).__morrowBrowserService
      return service.debugSurfaceScript(`(() => {
        const root = getComputedStyle(document.documentElement)
        const thumb = getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb')
        const bar = getComputedStyle(document.documentElement, '::-webkit-scrollbar')
        return {
          color: root.scrollbarColor,
          thumbColor: thumb.backgroundColor,
          thumbImage: thumb.backgroundImage,
          thumbRadius: thumb.borderRadius,
          thumbBorder: thumb.borderTopWidth,
          thumbClip: thumb.backgroundClip,
          width: bar.width
        }
      })()`)
    })) as {
      color?: string
      thumbColor?: string
      thumbImage?: string
      thumbRadius?: string
      thumbBorder?: string
      thumbClip?: string
      width?: string
    }
    expect(scrollbarStyle.width).toBe('8px')
    expect(scrollbarStyle.thumbImage).toBe('none')
    try {
      const png = await morrow.app.evaluate(async () => {
        const service = (globalThis as unknown as {
          __morrowBrowserService: { surface: { view: { webContents: { capturePage: () => Promise<{ toPNG: () => Buffer }> } } } }
        }).__morrowBrowserService
        return (await service.surface.view.webContents.capturePage()).toPNG().toString('base64')
      })
      writeFileSync(screenshotPath('r13-browser-scrollbar.png'), Buffer.from(png, 'base64'))
    } catch {
      // 截图只是证据；部分 CI/远程桌面环境无法抓取原生视图，不影响样式断言。
    }
  } finally {
    await morrow.close()
    await mock.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

})
test('浏览器返回主页面后保留页面并可切回', async () => {
  test.setTimeout(120_000)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><meta charset="utf-8"><title>返回测试页</title></head><body><h1>返回测试页</h1></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  const morrow = await launchMorrow({ name: 'browser-return' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    await page.getByRole('button', { name: '打开内置浏览器' }).click()
    await expect(page.locator('.browser-surface')).toBeVisible()
    const opened = await page.evaluate(async (targetUrl) => {
      const api = (window as unknown as {
        morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
      }).morrow
      return (await api.features.invoke('feature:browser:open', { url: targetUrl })) as {
        ok: boolean
        error?: { message?: string }
      }
    }, `${url}/`)
    expect(opened.ok, JSON.stringify(opened.error)).toBe(true)
    await expect.poll(() => page.locator('.browser-address-input').inputValue(), { timeout: 30_000 }).toContain(url)

    await page.getByRole('button', { name: '返回主页面' }).click()
    await expect(page.locator('.workbench-browser-overlay')).toBeHidden()
    await expect(page.locator('.app-main')).toBeVisible()
    await page.screenshot({ path: screenshotPath('browser-return-home.png') })

    await page.getByRole('button', { name: '打开内置浏览器' }).click()
    await expect(page.locator('.workbench-browser-overlay')).toBeVisible()
    await expect.poll(() => page.locator('.browser-address-input').inputValue(), { timeout: 30_000 }).toContain(url)
    await page.screenshot({ path: screenshotPath('browser-return-restored.png') })
  } finally {
    await morrow.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
})


test.describe("11-terminal-git", () => {
// ── 原文件：terminal-panel.spec.ts ──────────────────────────────────────────────
test.describe('terminal-panel.spec.ts', () => {
/**
 * 终端面板 E2E：
 * - 打开面板即创建真实 PTY，键盘输入可执行命令；
 * - 设置里切换默认终端后，新终端使用所选 Shell；
 * - 后台任务以标签页展示并可停止；
 * - 明暗截图。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function readTerminal(page: Page, id: string): Promise<string> {
  return page.evaluate(async (terminalId) => {
    const result = await window.morrow.features.invoke('feature:terminal:read', {
      id: terminalId,
      tail: 40_000
    })
    return result.ok ? (result.data as { output: string }).output : ''
  }, id)
}

test('真实终端、默认终端切换与后台任务', async () => {
  test.setTimeout(150_000)
  const workspace = workspaceAt('e2e-terminal')
  const morrow = await launchMorrow({ name: 'terminal', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const shellProfiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      if (!result.ok) return { ids: [] as string[], defaultShell: '' }
      const data = result.data as { profiles: Array<{ id: string }>; defaultShell: string }
      return { ids: data.profiles.map((item) => item.id), defaultShell: data.defaultShell }
    })
    expect(shellProfiles.defaultShell).toBe('gitbash')
    expect(shellProfiles.ids).not.toContain('powershell')
    expect(shellProfiles.ids).toContain('cmd')
    // 后续用例使用 PowerShell 语法；显式选择 PowerShell 7，同时保留上面的 Git Bash 默认断言。
    await page.evaluate(async () => {
      await window.morrow.settings.update({ terminalShell: 'pwsh' })
    })
    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const state = store.getState()
      const created = await window.morrow.session.create({
        workspace: ws,
        model: state.settings.defaultModel,
        permissionMode: 'auto',
        title: '终端测试'
      })
      if (!created.ok) throw new Error(created.error.message)
      await store.getState().selectSession(created.data.id)
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'terminal' } }))
    }, workspace)

    await expect(page.locator('.terminal-dock')).toBeVisible()
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 })
    // 原生 viewport 滚动条必须隐藏，否则上下三角会和自定义滑块重叠；
    // 自定义滑块与主区域原生细滚动条一致：6px 实心、全圆角、无渐变高光。
    const scrollbarState = async (): Promise<{ width: string; radius: string; background: string; backgroundImage: string; viewportScrollbar: string; opacity: string; invisible: boolean }> =>
      page.locator('.terminal-xterm .xterm-scrollable-element > .scrollbar.vertical').first().evaluate((element) => {
        const slider = element.querySelector('.slider')
        const viewport = document.querySelector('.terminal-xterm .xterm-viewport')
        return {
          width: slider ? getComputedStyle(slider).width : '',
          radius: slider ? getComputedStyle(slider).borderRadius : '',
          background: slider ? getComputedStyle(slider).backgroundColor : '',
          backgroundImage: slider ? getComputedStyle(slider).backgroundImage : '',
          viewportScrollbar: viewport ? getComputedStyle(viewport).scrollbarWidth : '',
          opacity: getComputedStyle(element).opacity,
          invisible: element.classList.contains('invisible')
        }
      })
    const scrollbarStyle = await scrollbarState()
    expect(scrollbarStyle.width).toBe('6px')
    expect(scrollbarStyle.radius).toBe('999px')
    expect(scrollbarStyle.background).toBe('rgb(138, 111, 66)')
    expect(scrollbarStyle.backgroundImage).toBe('none')
    expect(scrollbarStyle.viewportScrollbar).toBe('none')
    // 初始只有一行提示符：滚动条应与主区域一样自动隐藏。
    expect(scrollbarStyle.invisible || scrollbarStyle.opacity === '0').toBe(true)
    const dockBox = await page.locator('.terminal-dock').boundingBox()
    const mainBox = await page.locator('.app-main').boundingBox()
    expect(dockBox?.height).toBe(240)
    expect(Math.abs((dockBox?.x ?? 0) - (mainBox?.x ?? 0))).toBeLessThanOrEqual(1)

    // 终端顶边：1px 香槟金基准线；悬浮/按住提亮；移开且未按住恢复基准。
    const separator = page.locator('.terminal-resizer')
    const separatorLine = (): Promise<{ opacity: string; background: string; className: string }> =>
      separator.evaluate((element) => ({
        opacity: getComputedStyle(element, '::after').opacity,
        background: getComputedStyle(element, '::after').backgroundColor,
        className: element.className
      }))
    const separatorBox = await separator.boundingBox()
    expect(separatorBox).not.toBeNull()
    const sx = separatorBox!.x + separatorBox!.width / 2
    const sy = separatorBox!.y + separatorBox!.height / 2
    const baseLine = await separatorLine()
    expect(baseLine.opacity).toBe('0.45')
    expect(baseLine.background).toBe('rgb(200, 174, 125)')
    await page.mouse.move(sx - 120, sy + 40)
    await page.waitForTimeout(120)
    await page.mouse.move(sx, sy)
    await page.waitForTimeout(220)
    const hoverLine = await separatorLine()
    expect(hoverLine.opacity).toBe('1')
    expect(hoverLine.background).toBe('rgb(228, 206, 158)')
    expect(hoverLine.className).toContain('is-hovered')
    await page.mouse.move(sx - 120, sy + 40)
    await page.waitForTimeout(220)
    expect((await separatorLine()).opacity).toBe('0.45')

    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx, sy - 30, { steps: 4 })
    await page.waitForTimeout(220)
    const heldLine = await separatorLine()
    expect(heldLine.opacity).toBe('1')
    expect(heldLine.className).toContain('is-dragging')
    // 按住时把指针移到终端外，仍保持高亮。
    await page.mouse.move(sx + 220, sy - 30)
    await page.waitForTimeout(220)
    expect((await separatorLine()).opacity).toBe('1')
    await page.screenshot({ path: screenshotPath('terminal-resizer-gold.png') })
    await page.mouse.up()
    await page.mouse.move(sx - 120, sy + 40)
    await page.waitForTimeout(220)
    const releasedLine = await separatorLine()
    expect(releasedLine.opacity).toBe('0.45')
    expect(releasedLine.className).not.toContain('is-dragging')
    await separator.dblclick()
    await page.waitForTimeout(220)
    expect((await page.locator('.terminal-dock').boundingBox())?.height).toBe(240)
    const initialShells = await listShells(page)
    expect(initialShells).toHaveLength(1)
    expect(initialShells[0].shellId).toBeTruthy()

    // 键盘输入走 xterm → 真实 PTY；用不会出现在命令回显里的结果判断
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Write-Output ('pty_' + 'keyboard_ok')")
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readTerminal(page, initialShells[0].id), { timeout: 30_000 })
      .toContain('pty_keyboard_ok')
    // 中文输出必须按 UTF-8 到达 xterm，不能出现菱形替换符
    await page.keyboard.insertText("Write-Output '中文终端_ok'")
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readTerminal(page, initialShells[0].id), { timeout: 30_000 })
      .toContain('中文终端_ok')
    // 输出超过当前终端高度后，滚动条才出现；与主区域原生滚动条一致。
    await page.keyboard.insertText('1..80 | ForEach-Object { "scroll_$_" }')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readTerminal(page, initialShells[0].id), { timeout: 30_000 })
      .toContain('scroll_80')
    await expect.poll(async () => (await scrollbarState()).opacity).toBe('1')
    // 终端拥有键盘：Ctrl+K 不应打开命令面板
    await page.keyboard.press('Control+K')
    await expect(page.locator('.palette')).toHaveCount(0)

    // 设置里切到 PowerShell 7，主界面不再出现终端类型选择
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ terminalShell: 'pwsh' })
    })
    await page.getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.terminal-tab')).toHaveCount(2)
    const shells = await listShells(page)
    const pwshShell = shells.filter((shell) => shell.shellId === 'pwsh').at(-1)
    expect(pwshShell).toBeTruthy()
    expect(pwshShell!.id).not.toBe(initialShells[0].id)
    await page.locator('.xterm-helper-textarea').last().focus()
    await page.keyboard.type("Write-Output 'pwsh_terminal_ok'")
    await page.keyboard.press('Enter')
    await expect.poll(() => readTerminal(page, pwshShell!.id), { timeout: 30_000 }).toContain('pwsh_terminal_ok')
    await page.keyboard.insertText("Write-Output '中文终端_pwsh_ok'")
    await page.keyboard.press('Enter')
    await expect.poll(() => readTerminal(page, pwshShell!.id), { timeout: 30_000 }).toContain('中文终端_pwsh_ok')

    // 后台任务标签页
    const task = await page.evaluate(async (ws) => {
      const result = await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: "echo task-pty-ok"
      })
      return result.ok ? (result.data as { id: string }) : null
    }, workspace)
    expect(task).toBeTruthy()
    const taskTab = page.locator('.terminal-tab').filter({ hasText: 'task-pty-ok' })
    await expect(taskTab).toBeVisible()
    await taskTab.getByRole('tab').click()
    await expect(page.locator('.terminal-task-output')).toContainText('task-pty-ok', { timeout: 30_000 })

    // 长任务 + 停止（写成脚本文件，避免 cmd 下嵌套引号把命令吃掉）
    writeFileSync(join(workspace, 'tick.js'), "setInterval(() => console.log('tick'), 300)\n")
    await page.evaluate(async (ws) => {
      await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: 'node tick.js',
        title: '长时间任务'
      })
    }, workspace)
    const tickTab = page.locator('.terminal-tab').filter({ hasText: '长时间任务' })
    await expect(tickTab).toBeVisible()
    await tickTab.getByRole('tab').click()
    await expect(page.locator('.terminal-task-output')).toContainText('tick', { timeout: 30_000 })
    await page.getByRole('button', { name: '停止终端' }).click()
    await expect(tickTab.locator('.terminal-tab-dot')).not.toHaveClass(/is-running/, { timeout: 20_000 })

    // 回到第一个终端截图
    await page.locator('.terminal-tab').first().getByRole('tab').click()
    await expect(page.locator('.terminal-xterm').first()).toBeVisible()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('terminal-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('terminal-light.png') })
    await setThemeViaStore(page, 'dark')

    // 顶栏隐藏/打开终端；进程和标签继续保留
    await page.getByRole('button', { name: '隐藏终端' }).click()
    await expect(page.locator('.terminal-dock')).toBeHidden()
    await page.getByRole('button', { name: '打开终端' }).click()
    await expect(page.locator('.terminal-dock')).toBeVisible()
    await expect(page.locator('.terminal-tab')).toHaveCount(4)

    // 设置 → 终端
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '终端', exact: true }).click()
    await expect(page.locator('.st-search')).toContainText('默认终端')
    const shellSelect = page.getByRole('button', { name: '默认终端' })
    await shellSelect.click()
    await expect(page.getByRole('option', { name: /Git Bash/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Windows PowerShell/ })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /命令提示符/ })).toBeVisible()
    await page.getByRole('option', { name: /Git Bash/ }).click()
    await expect(shellSelect).toContainText('Git Bash')
    const savedShell = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      return store.getState().settings.terminalShell
    })
    expect(savedShell).toBe('gitbash')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('terminal-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('terminal-settings-light.png') })
    await setThemeViaStore(page, 'dark')
    await shellSelect.click()
    await page.getByRole('option', { name: /PowerShell 7/ }).click()
    await expect(shellSelect).toContainText('PowerShell 7')

    expect((await readStore(page)).session?.workspace).toBe(workspace)
  } finally {
    await morrow.close()
  }
})

})
// ── 原文件：git-workbench.spec.ts ──────────────────────────────────────────────
test.describe('git-workbench.spec.ts', () => {
/**
 * P1-8 Git 工作台 E2E：
 * - 工作台入口打开 Git 面板；非仓库工作区可一键 init；
 * - 未跟踪文件 → 查看差异 → 暂存 → 提交；
 * - 工作区改动 → 放弃（带确认）；
 * - 暂存全部 / 取消暂存；新建并切换分支；
 * - 历史提交与差异只读展示。
 */

/** Git 测试工作区放在系统临时目录：不能落在 Morrow 仓库内部（会命中父仓库的安全边界）。 */
function workspaceAt(): string {
  return mkdtempSync(join(tmpdir(), 'morrow-e2e-git-'))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('Git 工作台：初始化、差异、暂存提交、放弃、分支与历史', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({ scripts: [{ text: '好的。' }] })
  const workspace = workspaceAt()
  const morrow = await launchMorrow({ name: 'git-workbench', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'Git 测试'
    })

    await openToolPanel(page, 'Git')
    const dialog = page.getByRole('dialog', { name: '版本历史' })
    await expect(dialog).toBeVisible()

    // 页脚必须完整落在模态可视区内（高缩放下曾因固定高度被挤出）
    const layout = await dialog.evaluate((panel) => {
      const body = panel.querySelector<HTMLElement>('.modal-body')
      const foot = panel.querySelector<HTMLElement>('.git-foot')
      if (!body || !foot) return null
      return {
        overflow: body.scrollHeight - body.clientHeight,
        footBottom: foot.getBoundingClientRect().bottom,
        bodyBottom: body.getBoundingClientRect().bottom
      }
    })
    expect(layout).not.toBeNull()
    expect(layout!.overflow).toBeLessThanOrEqual(1)
    expect(layout!.footBottom).toBeLessThanOrEqual(layout!.bodyBottom + 1)

    // 非仓库 → 初始化
    await expect(page.getByText('这里还不是 Git 仓库')).toBeVisible()
    await page.getByRole('button', { name: '初始化 Git 仓库' }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(git(workspace, 'rev-parse', '--is-inside-work-tree')).toBe('true')
    await expect(page.locator('.git-tab.is-active')).toHaveCSS('height', '24px')
    await expect(page.locator('.git-tab.is-active')).toHaveCSS('border-radius', '5px')

    // 未跟踪文件：查看差异（工作区是全新的，先关闭引导通知再截图）
    writeFileSync(join(workspace, 'notes.md'), '# Notes\n\nHello from Morrow\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    const notesRow = page.locator('.git-file-row').filter({ hasText: 'notes.md' }).first()
    await expect(notesRow).toBeVisible()
    await notesRow.locator('.git-file-main').click()
    await expect(page.getByLabel('文件差异')).toContainText('+Hello from Morrow')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('git-workbench-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('git-workbench-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(200)

    // 暂存并提交
    await page.getByRole('button', { name: '暂存 notes.md' }).click()
    await expect(page.getByRole('region', { name: '已暂存的改动' })).toContainText('notes.md')
    await page.getByLabel('提交信息').fill('添加笔记')
    // 未配置身份时在面板内直接填写；首次提交会写入当前仓库的 .git/config 并完成提交
    await expect(page.getByRole('group', { name: '设置 Git 身份' })).toBeVisible()
    await page.screenshot({ path: screenshotPath('git-identity-dark.png') })
    await page.getByLabel('Git 用户名').fill('Morrow E2E')
    await page.getByLabel('Git 邮箱').fill('e2e@example.com')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(git(workspace, 'config', '--local', '--get', 'user.name')).toBe('Morrow E2E')
    expect(git(workspace, 'config', '--local', '--get', 'user.email')).toBe('e2e@example.com')
    expect(git(workspace, 'log', '--format=%s')).toBe('添加笔记')

    // 工作区改动 → 放弃（二次确认）
    writeFileSync(join(workspace, 'notes.md'), '# Notes\n\n被改坏了\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    await expect(page.locator('.git-file-row').filter({ hasText: 'notes.md' }).first()).toBeVisible()
    await page.getByRole('button', { name: '放弃 notes.md 的改动' }).click()
    const confirm = page.getByRole('alertdialog', { name: '放弃改动确认' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8').replace(/\r\n/g, '\n')).toContain('Hello from Morrow')

    // 暂存全部 → 取消暂存 → 再暂存并提交
    writeFileSync(join(workspace, 'feature.txt'), 'feature\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    await page.getByRole('button', { name: '暂存全部' }).click()
    await page.getByRole('button', { name: '取消暂存 feature.txt' }).click()
    await expect(page.getByRole('button', { name: '暂存 feature.txt' })).toBeVisible()
    await page.getByRole('button', { name: '暂存全部' }).click()
    await page.getByLabel('提交信息').fill('添加功能文件')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })
    expect(git(workspace, 'log', '--format=%s').split('\n')).toEqual(['添加功能文件', '添加笔记'])

    // 新建并切换分支
    const baseBranch = git(workspace, 'branch', '--show-current')
    await page.getByRole('button', { name: '切换或新建分支' }).click()
    await page.getByLabel('新分支名').fill('feature/git-panel')
    await page.getByLabel('新分支名').press('Enter')
    await waitUntil(async () => git(workspace, 'branch', '--show-current') === 'feature/git-panel', 15_000, '新分支已切换')
    await expect(page.getByRole('button', { name: '切换或新建分支' })).toContainText('feature/git-panel')

    // 在功能分支新增提交，确认历史页随分支切换刷新
    writeFileSync(join(workspace, 'branch-only.txt'), 'branch\n', 'utf8')
    await page.getByRole('button', { name: '刷新 Git 状态' }).click()
    await page.getByRole('button', { name: '暂存全部' }).click()
    await page.getByLabel('提交信息').fill('分支提交')
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByText('文件夹干净')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('tab', { name: '历史' }).click()
    await expect(page.locator('.git-commit-item')).toHaveCount(3)
    await expect(page.locator('.git-detail-title')).toContainText('分支提交')

    // 在历史页直接切回原分支：列表与详情必须随分支失效并刷新
    await page.getByRole('button', { name: '切换或新建分支' }).click()
    await page.getByRole('menuitem', { name: new RegExp(baseBranch) }).click()
    await waitUntil(async () => git(workspace, 'branch', '--show-current') === baseBranch, 15_000, '切回原分支')
    await expect(page.locator('.git-commit-item')).toHaveCount(2)
    await expect(page.locator('.git-detail-title')).toContainText('添加功能文件')
    await expect(page.locator('.git-diff')).toContainText('+feature')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('git-history-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('没有工作区时终端回退到可用 Shell 并保持运行', async () => {
  test.setTimeout(90_000)
  const morrow = await launchMorrow({ name: 'terminal-no-workspace', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.locator('.tb-terminal-toggle').click()
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 })
    await waitUntil(async () => ((await listShells(page)).length ? true : null), 12_000, '终端创建')
    // 受限令牌环境会让 Git Bash/MSYS2 在加载阶段退出；终端必须自动切到可用 Shell。
    const running = await waitUntil(async () => {
      const shells = await listShells(page)
      return shells[0]?.status === 'running' ? shells[0] : null
    }, 25_000, '终端保持运行')
    expect(['gitbash', 'pwsh', 'cmd']).toContain(running.shellId ?? '')
    const shell = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:list')
      return result.ok
        ? (result.data as { processes: Array<{ cwd: string }> }).processes[0]?.cwd ?? ''
        : ''
    })
    expect(shell.toLowerCase()).toBe((process.env.USERPROFILE ?? '').toLowerCase())

    await page.evaluate(async () => {
      await window.morrow.settings.update({ terminalShell: 'pwsh' })
    })
    await page.locator('.terminal-new').click()
    await expect(page.locator('.terminal-tab')).toHaveCount(2, { timeout: 30_000 })
    await waitUntil(
      async () =>
        (await listShells(page)).some((item) => item.shellId === 'pwsh' && item.status === 'running')
          ? true
          : null,
      20_000,
      'PowerShell 7 保持运行'
    )
  } finally {
    await morrow.close()
  }
})

})
})
