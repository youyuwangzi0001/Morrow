/**
 * 合并自 3 个 E2E spec：command-palette.spec.ts、ipc-boundary.spec.ts、swarm.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clickPermissionCard, configureMockProvider, createSession, createUiSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForPermission, waitForRunFinished, waitForStoreReady, waitUntil } from './store'

// ── 原文件：command-palette.spec.ts ──────────────────────────────────────────────
test.describe('command-palette.spec.ts', () => {
/**
 * 命令面板与快捷键/焦点回归：
 * - Esc 在弹窗/面板内只关闭弹窗，不误停正在运行的任务；
 * - 只有无弹窗且焦点不在输入框时，Esc 才停止当前运行；
 * - 设置 + 命令面板叠层时，Esc 只关闭最上层；
 * - 运行中启动演示会被拦下，不创建/切换会话；
 * - 文件搜索结果直接打开编辑器（不再只复制路径），且优先当前会话工作区。
 */

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
        { toolCalls: [{ name: 'run_command', arguments: { command: 'Remove-Item out -Recurse -Force' } }] },
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

})

// ── 原文件：ipc-boundary.spec.ts ──────────────────────────────────────────────
test.describe('ipc-boundary.spec.ts', () => {
/**
 * IPC/preload 边界回归：
 * - 核心通道异常统一归一化为 Result，不再向渲染层抛 Electron 原始拒绝；
 * - 产物读取/打开/另存与文件搜索只接受已登记工作区内的真实路径；
 * - 生产 CSP 下 connect-src 不再允许任意 https 外联；
 * - 主窗口不能被导航到任意 file:// 页面；
 * - 沙箱化 preload 仍能提供完整 API。
 */

interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

test('IPC 路径边界、错误归一化、CSP 与导航限制', async () => {
  test.setTimeout(120_000)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const workspace = join(root, 'tmp', `ipc-boundary-ws-${stamp}`)
  const outsideDir = join(root, 'tmp', `ipc-boundary-outside-${stamp}`)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  const insidePath = join(workspace, 'inside.txt')
  const outsidePath = join(outsideDir, 'secret.txt')
  writeFileSync(insidePath, 'inside-workspace-content', 'utf8')
  writeFileSync(outsidePath, 'outside-secret-content', 'utf8')

  const morrow = await launchMorrow({ name: 'ipc-boundary', env: { MORROW_TEST_CSP: '1' } })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: 'IPC 边界测试'
    })

    const readInside = await page.evaluate(
      (path) => (window as unknown as { morrow: { artifacts: { read: (p: string) => Promise<IpcResult<{ content: string }>> } } }).morrow.artifacts.read(path),
      insidePath
    )
    expect(readInside.ok, JSON.stringify(readInside.error)).toBe(true)
    expect(readInside.data?.content).toBe('inside-workspace-content')

    const readOutside = await page.evaluate(
      (path) => (window as unknown as { morrow: { artifacts: { read: (p: string) => Promise<IpcResult> } } }).morrow.artifacts.read(path),
      outsidePath
    )
    expect(readOutside.ok).toBe(false)
    expect(readOutside.error?.code).toBe('FILE_UNAVAILABLE')
    expect(JSON.stringify(readOutside)).not.toContain('outside-secret-content')

    const searchOutside = await page.evaluate(
      (dir) => (window as unknown as { morrow: { files: { search: (root: string, q: string) => Promise<IpcResult> } } }).morrow.files.search(dir, 'secret'),
      outsideDir
    )
    expect(searchOutside.ok).toBe(false)
    expect(searchOutside.error?.code).toBe('FILE_ROOT_DENIED')

    const searchInside = await page.evaluate(
      (dir) => (window as unknown as { morrow: { files: { search: (root: string, q: string) => Promise<IpcResult> } } }).morrow.files.search(dir, 'inside'),
      workspace
    )
    expect(searchInside.ok, JSON.stringify(searchInside.error)).toBe(true)
    expect(JSON.stringify(searchInside.data)).toContain('inside.txt')

    // 文件功能显式传入 workspace 时也必须属于已登记工作区
    const filesOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:list', { workspace: dir }),
      outsideDir
    )
    expect(filesOutside.ok).toBe(false)
    const fileReadOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:read', { workspace: dir, path: 'secret.txt' }),
      outsideDir
    )
    expect(fileReadOutside.ok).toBe(false)
    const filePreviewOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:preview', { workspace: dir, path: 'secret.txt' }),
      outsideDir
    )
    expect(filePreviewOutside.ok).toBe(false)
    const filesInside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:list', { workspace: dir }),
      workspace
    )
    expect(filesInside.ok, JSON.stringify(filesInside.error)).toBe(true)

    // 规则文件发现同样只接受已登记工作区
    const rulesOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:rules:list', { workspace: dir }),
      outsideDir
    )
    expect(rulesOutside.ok).toBe(false)
    expect(rulesOutside.error?.message ?? '').toContain('已登记工作区')
    const rulesInside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult<{ files: unknown[] }>> } } })
          .morrow.features.invoke('feature:rules:list', { workspace: dir }),
      workspace
    )
    expect(rulesInside.ok, JSON.stringify(rulesInside.error)).toBe(true)

    const sessionId = await page.evaluate(
      () => (window as unknown as { __morrowStore: { getState: () => { activeSessionId: string } } }).__morrowStore.getState().activeSessionId
    )
    // 核心通道异常归一化为 Result（主进程 handler 抛错时不再向渲染层抛 Electron 原始拒绝）
    const malformed = await page.evaluate(
      (id) =>
        (window as unknown as { morrow: { session: { rename: (id: string, title: unknown) => Promise<IpcResult> } } })
          .morrow.session.rename(id, 123),
      sessionId
    )
    expect(malformed.ok).toBe(false)
    expect(malformed.error?.code).toBe('IPC_FAILED')
    expect(malformed.error?.message ?? '').not.toContain('Error invoking remote method')

    const invalidMode = await page.evaluate(
      (id) =>
        (window as unknown as { morrow: { session: { setPermissionMode: (id: string, mode: string) => Promise<IpcResult> } } })
          .morrow.session.setPermissionMode(id, 'yolo'),
      sessionId
    )
    expect(invalidMode.ok).toBe(false)
    expect(invalidMode.error?.code).toBe('INVALID_PERMISSION_MODE')

    const unknownFeature = await page.evaluate(() =>
      (window as unknown as { morrow: { features: { invoke: (channel: string) => Promise<IpcResult> } } })
        .morrow.features.invoke('feature:not-registered')
    )
    expect(unknownFeature.ok).toBe(false)
    expect(unknownFeature.error?.code).toBe('FEATURE_CHANNEL')

    // 生产 CSP：渲染层不应能任意 https 外联
    const cspBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/', { mode: 'no-cors' })
        return false
      } catch {
        return true
      }
    })
    expect(cspBlocked).toBe(true)

    // 主窗口不能被导航到任意本地文件
    const beforeUrl = page.url()
    await page
      .evaluate(() => {
        window.location.href = 'file:///C:/Windows/win.ini'
      })
      .catch(() => undefined)
    await page.waitForTimeout(600)
    expect(page.url()).toBe(beforeUrl)
    // 用 evaluate 而不是 locator：被拦截的导航会让 Playwright 一直等 "navigation to finish"
    const rootAlive = await page.evaluate(() => Boolean(document.querySelector('#root')))
    expect(rootAlive).toBe(true)
  } finally {
    await morrow.close()
  }
})

})

// ── 原文件：swarm.spec.ts ──────────────────────────────────────────────
test.describe('swarm.spec.ts', () => {
/**
 * 集群 E2E：/swarm 触发模型拆解 → swarm 工具并行派发 8 个子代理 → 汇总。
 * 离线 mock LLM 按系统提示区分主代理与探索/审查子代理。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('集群：拆解为八个子代理并行执行并汇总', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    title: `并行检查 ${index + 1}`,
    prompt: `检查登录流程的第 ${index + 1} 个部分并给出结论`,
    agent: index % 2 === 0 ? 'explore' : 'review'
  }))
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown; lastUserMessageText?: string }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('你是只读探索子代理')) {
        return { text: '探索完成：登录入口在 src/auth/login.ts。', delayMs: 400 }
      }
      if (raw.includes('你是只读代码审查子代理')) {
        return { text: '审查完成：未发现高危问题，建议补一个锁定测试。', delayMs: 400 }
      }
      mainCalls += 1
      if (mainCalls === 1) {
        return {
          text: '我把任务拆成八块并行检查。',
          toolCalls: [
            {
              name: 'swarm',
              arguments: {
                goal: '检查登录流程的安全性与实现位置',
                tasks
              }
            }
          ]
        }
      }
      return { text: '八个子任务都完成：登录入口已定位，未发现高危问题。' }
    }
  })
  const workspace = workspaceAt('e2e-swarm')
  const morrow = await launchMorrow({ name: 'swarm', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '集群测试'
    })

    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('/swarm 检查登录流程')
    await page.keyboard.press('Enter')

    // 实时任务板：不等整批结束就能看到每个子任务在做什么
    const swarmRow = page.locator('.spine-row').filter({ hasText: '集群' }).first()
    await expect(swarmRow).toBeVisible({ timeout: 15_000 })
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(8, { timeout: 20_000 })
    await expect(swarmRow.locator('.spine-swarm-status.is-running').first()).toBeVisible({ timeout: 15_000 })

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const last = state.session?.messages.at(-1)
        return state.run === null && last?.role === 'assistant' && last.text.includes('八个子任务都完成') ? true : null
      },
      90_000,
      'swarm 运行结束'
    )

    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(bodies.some((body: string) => body.includes('你是只读探索子代理'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('你是只读代码审查子代理'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('"name":"swarm"') || body.includes('"name": "swarm"'))).toBe(true)

    await expect(swarmRow).toBeVisible()
    await expect(swarmRow.getByText('小助手', { exact: true })).toBeVisible()
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(8)
    await expect(swarmRow.locator('.spine-swarm-status.is-completed')).toHaveCount(8)
    await expect(swarmRow.locator('.spine-swarm-task').filter({ hasText: '并行检查 1' })).toContainText('explore')
    await expect(swarmRow.locator('.spine-swarm-task').filter({ hasText: '并行检查 2' })).toContainText('review')
    await expect(swarmRow.locator('.spine-swarm-task').filter({ hasText: '并行检查 1' })).toContainText('探索完成')
    await expect(swarmRow.locator('.spine-swarm-task').filter({ hasText: '并行检查 2' })).toContainText('审查完成')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await swarmRow.scrollIntoViewIfNeeded()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('swarm-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('swarm-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
