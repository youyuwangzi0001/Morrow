/**
 * 命令面板与快捷键/焦点回归：
 * - Esc 在弹窗/面板内只关闭弹窗，不误停正在运行的任务；
 * - 只有无弹窗且焦点不在输入框时，Esc 才停止当前运行；
 * - 设置 + 命令面板叠层时，Esc 只关闭最上层；
 * - 运行中启动演示会被拦下，不创建/切换会话；
 * - 文件搜索结果直接打开编辑器（不再只复制路径），且优先当前会话工作区。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clickPermissionCard,
  configureMockProvider,
  createSession,
  createUiSession,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  waitForPermission,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

const WORKSPACE = join(root, 'tmp', `e2e-palette-ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)

test.describe('命令面板与快捷键', () => {
  test('Esc 只关闭弹窗，不误停运行；叠层只关最上层；运行中禁止启动演示', async () => {
    test.setTimeout(180_000)
    mkdirSync(WORKSPACE, { recursive: true })
    const longText = Array.from(
      { length: 40 },
      (_, index) => `第 ${index + 1} 段用于保持长时间流式运行，避免测试过程中任务自然结束。`
    ).join('\n\n')
    const mock = await startMockLLM({ scripts: [{ text: longText, textChunkSize: 5, chunkDelayMs: 80 }] })
    const morrow = await launchMorrow({ name: 'palette-esc', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace: WORKSPACE, ...provider, permissionMode: 'auto', title: '命令面板 Esc 测试' })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请开始长时间流式输出')
      await expect(page.locator('.message-assistant.is-streaming')).toBeVisible({ timeout: 30_000 })
      const runningId = (await readStore(page)).activeSessionId

      // 1) 面板打开、焦点在列表项上按 Esc：只关面板，运行继续
      await page.keyboard.press('Control+K')
      await expect(page.locator('.palette')).toBeVisible()
      await expect(page.locator('.palette-input')).toBeFocused()
      await page.locator('.palette-input').fill('')
      await expect(page.locator('.palette-item').first()).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('command-palette-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(320)
      await page.screenshot({ path: screenshotPath('command-palette-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(200)
      await page.locator('.palette-item').first().focus()
      await page.keyboard.press('Escape')
      await expect(page.locator('.palette')).toHaveCount(0)
      await page.waitForTimeout(500)
      expect((await readStore(page)).run).not.toBeNull()
      expect((await getEvents(page)).some((event) => event.type === 'run_finished')).toBe(false)

      // 2) 运行中点「看一场演示」应被拦下，不切换会话
      await page.keyboard.press('Control+K')
      await page.locator('.palette-input').fill('演示')
      const demoItem = page.locator('.palette-item').filter({ hasText: '看一场演示' })
      await expect(demoItem).toBeVisible()
      await demoItem.click()
      await expect
        .poll(async () => (await readStore(page)).toast?.message ?? '', { timeout: 10_000 })
        .toContain('还有任务在运行')
      expect((await readStore(page)).activeSessionId).toBe(runningId)
      expect((await readStore(page)).run).not.toBeNull()

      // 3) 设置弹窗关闭不应停止运行
      await page.keyboard.press('Control+,')
      await waitUntil(async () => (await readStore(page)).settingsOpen, 10_000, '设置打开')
      await page.waitForTimeout(300)
      const initialFocus = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null
        return {
          inPanel: Boolean(active?.closest('.modal-panel')),
          isClose: Boolean(active?.classList.contains('modal-close'))
        }
      })
      // 初始焦点应落在对话框内容里，而不是默认落在「关闭」按钮上
      expect(initialFocus.inPanel).toBe(true)
      expect(initialFocus.isClose).toBe(false)
      await page.locator('.modal-close').first().focus()
      await page.keyboard.press('Escape')
      await waitUntil(async () => !(await readStore(page)).settingsOpen, 10_000, '设置关闭')
      await page.waitForTimeout(500)
      expect((await readStore(page)).run).not.toBeNull()

      // 4) 无弹窗、焦点不在输入框时，Esc 才停止运行
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Escape')
      await waitUntil(async () => (await readStore(page)).run === null, 20_000, '运行被 Esc 停止')
      const finished = (await getEvents(page)).filter((event) => event.type === 'run_finished').at(-1)
      expect(finished?.reason).toBe('cancelled')

      // 5) 设置 + 命令面板叠层：Esc 只关最上层
      await page.keyboard.press('Control+,')
      await waitUntil(async () => (await readStore(page)).settingsOpen, 10_000, '设置再次打开')
      await page.keyboard.press('Control+K')
      await expect(page.locator('.palette')).toBeVisible()
      expect((await readStore(page)).settingsOpen).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.locator('.palette')).toHaveCount(0)
      expect((await readStore(page)).settingsOpen).toBe(true)
      await page.keyboard.press('Escape')
      await waitUntil(async () => !(await readStore(page)).settingsOpen, 10_000, '第二次 Esc 关闭设置')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('弹窗打开时 Esc 不会误拒绝审批卡', async () => {
    test.setTimeout(120_000)
    mkdirSync(WORKSPACE, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'palette-approval.txt', content: 'ok' } }] },
        { text: '处理完成。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'palette-permission', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace: WORKSPACE, ...provider, permissionMode: 'ask', title: '审批弹窗测试' })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请写一个文件')
      await waitForPermission(page, 60_000)

      await page.keyboard.press('Control+,')
      await waitUntil(async () => (await readStore(page)).settingsOpen, 10_000, '设置打开')
      await page.waitForTimeout(250)
      await page.locator('.modal-close').first().focus()
      await page.keyboard.press('Escape')
      await waitUntil(async () => !(await readStore(page)).settingsOpen, 10_000, '设置关闭')
      await page.waitForTimeout(300)

      // Esc 只关了设置，审批仍在等待，且没有产生拒绝决定
      expect((await readStore(page)).pendingPermission).not.toBeNull()
      expect((await getEvents(page)).some((event) => event.type === 'permission_resolved')).toBe(false)

      await clickPermissionCard(page, 'deny')
      await waitForRunFinished(page, 60_000)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('文件搜索结果直接打开编辑器，并优先当前会话工作区', async () => {
    test.setTimeout(120_000)
    mkdirSync(WORKSPACE, { recursive: true })
    const target = join(WORKSPACE, 'palette-check.ts')
    writeFileSync(target, 'export const paletteCheck = true\n', 'utf8')
    const morrow = await launchMorrow({ name: 'palette-file', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await createUiSession(page, {
        workspace: WORKSPACE,
        permissionMode: 'auto',
        title: '命令面板文件测试'
      })

      await page.keyboard.press('Control+K')
      await expect(page.locator('.palette')).toBeVisible()
      // 描述也可被搜索：输入「模型」应命中「打开设置」
      await page.locator('.palette-input').fill('模型')
      await expect(page.locator('.palette-item').filter({ hasText: '打开设置' })).toBeVisible()
      await page.locator('.palette-input').fill('palette-check')
      const fileItem = page.locator('.palette-item').filter({ hasText: 'palette-check.ts' })
      await expect(fileItem).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.palette-group-label').filter({ hasText: '文件' })).toBeVisible()

      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('command-palette-files-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('command-palette-files-dark.png') })

      await fileItem.click()
      await expect(page.locator('.palette')).toHaveCount(0)
      await expect(page.locator('.canvas-root .cm-editor')).toBeVisible({ timeout: 20_000 })
      const tab = page.locator('.canvas-doc-tab').filter({ hasText: 'palette-check.ts' })
      await expect(tab).toBeVisible()
      // relPath 必须是干净的工作区相对路径，而不是拼接错误的绝对路径
      await expect(tab.getByRole('tab')).toHaveAttribute('title', 'palette-check.ts')
      expect((await readStore(page)).canvas.open).toBe(true)
    } finally {
      await morrow.close()
    }
  })
})
