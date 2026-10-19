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
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, readStore, setThemeViaStore, waitForStoreReady, waitUntil } from './store'

/**
 * 建立独立 ASCII 工作区会话。
 * 说明：demo 工作区含中文文件名，当前 shell 的文件树有 btoa(CJK) 崩溃 bug；
 * 编辑器用例使用独立 ASCII 工作区，避免被文件树问题连带。该 bug 已单独上报 Lead。
 */
async function createEditorSession(page: Page): Promise<{ workspace: string; sessionId: string }> {
  const workspace = join(root, 'tmp', `r10-editor-ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(workspace, { recursive: true })
  return page.evaluate(async (wsPath: string) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    await store.getState().updateSettings({ onboardingDone: true })
    store.setState({ onboardingOpen: false })
    const created = await window.morrow.session.create({
      workspace: wsPath,
      model: { providerId: 'demo', modelId: 'morrow-demo' },
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
