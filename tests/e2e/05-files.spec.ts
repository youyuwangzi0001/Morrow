/**
 * 合并自 5 个 E2E spec：file-previews.spec.ts、file-preview-extended.spec.ts、r10-files.spec.ts、artifact-preview.spec.ts、artifact-save.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import JSZip from 'jszip'
import { launchMorrow, root, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { createUiSession, dismissOnboarding, readStore, setThemeViaStore, waitForStoreReady, waitUntil } from './store'

// ── 原文件：file-previews.spec.ts ──────────────────────────────────────────────
test.describe('file-previews.spec.ts', () => {
/**
 * 多格式文件预览回归：图片 / PDF / DOCX / 音频 / 视频 / 大文本 / 不支持格式。
 * 走真实文件树点击 → 画布预览 → 本地协议读取，不 mock 文件内容。
 */

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
 * 依赖：Lead 在 src/main/features/index.ts 顶层 import './files'，并已构建 out/。
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

  test('明暗主题截图（文件树）', async () => {
    // 等前面操作的成功提示自动消失，截图只保留应用界面
    await expect(page.locator('.toast-item')).toHaveCount(0, { timeout: 7_000 })
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().setTheme('light')
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-files-tree-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().setTheme('dark')
    })
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
