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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, readStore, setThemeViaStore, waitForStoreReady, waitUntil } from './store'

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
