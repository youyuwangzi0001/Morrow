/**
 * 成品落盘：内联成品可以一键保存到工作区 artifacts/，并回写路径。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, type MorrowApp } from './launch'
import { createUiSession, dismissOnboarding, waitForStoreReady, waitUntil } from './store'

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
