/**
 * A5：成品版本历史与多格式导出。
 * - 打开历史时记录当前基线；内容变化后重新进入出现第二个版本；
 * - 恢复旧版本会写回会话，并把恢复本身记录为新版本；
 * - HTML 成品可导出真实 Markdown 与可打开的 PDF。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screensDir, type MorrowApp } from './launch'
import { createUiSession, dismissOnboarding, waitForStoreReady, waitUntil } from './store'

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
