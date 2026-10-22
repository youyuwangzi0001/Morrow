/**
 * 合并自 4 个 E2E spec：r10-editor.spec.ts、a5-artifact-export.spec.ts、b2b-scanned-pdf.spec.ts、custom-commands.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchMorrow, root, screensDir, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { configureMockProvider, createSession, createUiSession, dismissOnboarding, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForRunFinished, waitForStoreReady, waitUntil } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

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
      join(root, 'tests', 'unit', 'core', 'fixtures', 'documents', 'scanned-zh.pdf'),
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
    expect(mock.requests[0]?.lastUserMessageText).toBe('请审查 src/a.ts，重点 性能。')

    // 未知命令给出提示而不是把 /nope 当普通消息发给模型
    await input.fill('/nope')
    await page.keyboard.press('Enter')
    await expect(page.getByText('没有名为 /nope 的命令')).toBeVisible()
    await expect(input).toHaveValue('/nope')
    expect(mock.requests).toHaveLength(1)
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
    await expect(page.getByText('小助手角色')).toBeVisible()
    await expect(page.getByText('探索者', { exact: true })).toBeVisible()
    await expect(page.getByText('审查者', { exact: true })).toBeVisible()

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
