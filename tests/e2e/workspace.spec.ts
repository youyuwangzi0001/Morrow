// workspace 领域 E2E：由 4 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { screensDir, launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore, waitForStoreReady, waitUntil, configureMockProvider, createSession, openToolPanel } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

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
  test('@core:documents 图片、PDF、DOCX、音视频、大文本与不支持格式均可预览', async () => {
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

  test('@core:workspace 右键菜单：新建文件、重命名、删除（二次确认）真实落盘', async () => {
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
  test('@core:workspace 打开文件 → 编辑 → 保存 → 重新打开', async () => {
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

  test('@core:workspace 保存进行中继续输入不会丢字，也不会误清脏标记', async () => {
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

/* ── 2. K1 自动化原语 ───────────────────────────────────────── */

test('@core:browser K1 自动化：读取 → 真实点击 → 真实输入 → 截图 → 后退/前进（可见视图）', async () => {
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

})
})

test.describe("11-terminal-git", () => {
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
  const workspace = mkdtempSync(join(tmpdir(), 'morrow-e2e-git-'))
  if (process.platform === 'win32') {
    // Electron 在本测试宿主中以 Low integrity 运行，系统 TEMP 默认是 Medium。
    // 只给新建的测试夹具目录设置可继承的 Low 标签，不更改用户仓库或 TEMP 根目录。
    execFileSync('icacls', [workspace, '/setintegritylevel', '(OI)(CI)L'], {
      encoding: 'utf8', windowsHide: true
    })
  }
  return workspace
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

test('@core:git Git 工作台：初始化、差异、暂存提交、放弃、分支与历史', async () => {
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

})
})

// ── terminal-gitbash.spec.ts ──────────────────────────────────────────────
{






test('@core:terminal Git Bash 在 MSYS 共享内存冲突下仍真实可用', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `terminal-gitbash-${Date.now()}`)
  const outDir = join(screensDir, 'matrix')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  // 固定 Git Bash 环境，避免兼容前缀默认进入 MSYS 后改变提示符。
  const morrow = await launchMorrow({ name: 'terminal-gitbash', timeoutMs: 90_000, env: { MSYSTEM: 'MINGW64' } })
  const { page } = morrow
  const readTerminal = async (id: string): Promise<string> =>
    page.evaluate(async (terminalId) => {
      const result = await window.morrow.features.invoke('feature:terminal:read', {
        id: terminalId,
        tail: 40_000
      })
      return result.ok ? (result.data as { output: string }).output : ''
    }, id)
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const profiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      if (!result.ok) return { ids: [] as string[], defaultShell: '' }
      const data = result.data as { profiles: Array<{ id: string }>; defaultShell: string }
      return { ids: data.profiles.map((item) => item.id), defaultShell: data.defaultShell }
    })
    test.skip(!profiles.ids.includes('gitbash'), '本机没有可用的 Git Bash')
    expect(profiles.defaultShell).toBe('gitbash')

    await page.evaluate(async (ws) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const state = store.getState()
      const created = await window.morrow.session.create({
        workspace: ws,
        model: state.settings.defaultModel,
        permissionMode: 'auto',
        title: 'Git Bash 终端'
      })
      if (!created.ok) throw new Error(created.error.message)
      await store.getState().selectSession(created.data.id)
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'terminal' } }))
    }, workspace)

    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 })
    const shells = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:list')
      if (!result.ok) return []
      return (result.data as { processes: Array<{ id: string; title: string; shellId?: string; status: string }> }).processes
    })
    expect(shells[0]?.shellId).toBe('gitbash')
    expect(shells[0]?.title).toContain('Git Bash')
    expect(shells[0]?.status).toBe('running')

    await expect.poll(() => readTerminal(shells[0].id), { timeout: 30_000 }).toContain('MINGW64')
    const measure = await page.locator('.xterm-char-measure-element').first().evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return { visibility: getComputedStyle(el).visibility, left: Math.round(rect.left), width: Math.round(rect.width) }
    })
    expect(measure.visibility).toBe('hidden')
    expect(measure.left).toBeLessThan(0)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("echo GIT_BASH_RECOVERY_OK && git --version")
    await page.keyboard.press('Enter')
    await expect.poll(() => readTerminal(shells[0].id), { timeout: 30_000 }).toContain('GIT_BASH_RECOVERY_OK')
    await expect.poll(() => readTerminal(shells[0].id), { timeout: 30_000 }).toContain('git version')
    await page.screenshot({ path: join(outDir, 'terminal-gitbash.png') })

    // Agent 的一次性命令也必须复用同一个 Git Bash 兼容环境。
    const task = await page.evaluate(async (ws) => {
      const result = await window.morrow.features.invoke('feature:terminal:start-task', {
        cwd: ws,
        command: 'git --version',
        title: 'Git Bash 命令'
      })
      return result.ok ? (result.data as { id: string; shellId?: string }) : null
    }, workspace)
    expect(task?.shellId).toBe('gitbash')
    await expect.poll(() => readTerminal(task!.id), { timeout: 60_000 }).toContain('git version')
  } finally {
    await morrow.close()
  }
})
}
