/**
 * Morrow 完整用户旅程 E2E —— 真实渲染进程 + 真实主进程 + 真实工具执行，无任何 mock 数据。
 *
 * 覆盖（对应 M1–M3 验收）：
 * 1. 演示模式全流程：点「看一场演示」→ Agent 真实读取演示工作区 CSV → 运行命令聚合 → 写 HTML 报告 → 画布打开。
 * 2. 权限卡「拒绝」：ask 模式下写文件/跑命令弹审批，真实点击拒绝 → 工具 denied、run 收尾不崩。
 * 3. 权限卡「允许一次」：真实点击允许一次 → 工具全部成功、报告生成。
 * 4. 中断：运行中 stopRun → run_finished cancelled、消息 interrupted、UI 显示已停止。
 * 5. 会话恢复：完成一轮后退出，用同一 data-dir 重启 → 会话列表/消息/产物保留，画布可再打开。
 * 6. 键盘与主题：Ctrl+K 命令面板、Ctrl+B 侧栏、store.setTheme 驱动真实明暗切换。
 *
 * 说明：
 * - 演示 Provider 的 `MORROW_DEMO_SPEED` 环境变量控制播放速度（0.05 ≈ 秒播），仍会真实执行工具；
 * - 所有操作优先通过 `window.__morrowStore`（test-mode 暴露，见 src/renderer/src/main.tsx）驱动，
 *   与真实 UI 共用同一条 store → preload → IPC → 主进程链路；关键交互（演示入口、审批按钮）走真实 DOM 点击。
 * - 截图统一归档 docs/verification/screens/。
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clickPermissionCard,
  configureMockProvider,
  dismissOnboarding,
  createDemoSession,
  createSession,
  demoEntryButton,
  getEvents,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  setThemeViaStore,
  stopRunViaStore,
  waitForEvent,
  waitForPermission,
  waitForRunFinished,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

const DEMO_PROMPT = '帮我把这个季度的销售数据理一遍，做一份可以给老板看的分析报告。'

test.describe('Morrow 完整旅程', () => {
  test('演示模式：点「看一场演示」→ 真实跑完 → HTML 报告落盘 → 画布自动打开', async () => {
    test.setTimeout(240_000)
    const morrow = await launchMorrow({
      name: 'demo',
      env: { MORROW_DEMO_SPEED: '0.05' },
      timeoutMs: 90_000
    })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      // 1) 从真实 UI 入口启动演示
      const demoButton = demoEntryButton(page)
      await expect(demoButton).toBeVisible({ timeout: 15_000 })
      await demoButton.click()

      // 2) 等 run 开始与结束（真实工具执行：list/read/run_command/write_file/open_artifact）
      await waitForRunStarted(page, 30_000)
      const finished = await waitForRunFinished(page, 180_000)
      expect(finished.reason, '演示必须完整跑完').toBe('complete')

      // 3) store 状态：run 收尾、产物 ≥1、canvas 自动打开
      const state = await readStore(page)
      expect(state.run).toBeNull()
      expect(state.bootError).toBeNull()
      expect(state.session).not.toBeNull()
      const session = state.session!
      expect(session.artifacts.length).toBeGreaterThanOrEqual(1)
      expect(session.messages.length).toBeGreaterThanOrEqual(2)
      expect(session.todos.length).toBeGreaterThan(0)
      expect(session.todos.some((todo) => todo.status === 'completed')).toBe(true)
      await expect.poll(async () => (await readStore(page)).canvas.open, { timeout: 15_000 }).toBe(true)

      // 4) 画布 iframe 真实渲染
      const iframe = page.locator('iframe').first()
      await expect(iframe).toBeVisible({ timeout: 15_000 })

      // 5) HTML 报告文件真实落盘且内容像一份报告
      const htmlArtifact = session.artifacts.find((artifact) => artifact.kind === 'html') ?? session.artifacts[0]
      expect(htmlArtifact.path, '产物应带工作区路径').toBeTruthy()
      const reportPath = htmlArtifact.path!
      expect(statSync(reportPath).size).toBeGreaterThan(1024)
      const html = readFileSync(reportPath, 'utf8')
      expect(html).toMatch(/<html|<!doctype/i)
      expect(html.length).toBeGreaterThan(1024)

      // 6) 事件质量：无 error；工具调用（真实执行）全部成功；演示步骤事件存在
      const events = await getEvents(page)
      const errors = events.filter((event) => event.type === 'error')
      expect(errors, `出现 error 事件：${JSON.stringify(errors)}`).toEqual([])
      const toolFinished = events.filter((event) => event.type === 'tool_finished')
      expect(toolFinished.length).toBeGreaterThanOrEqual(4)
      for (const event of toolFinished) {
        expect((event.result as { ok?: boolean } | undefined)?.ok, `工具失败：${JSON.stringify(event)}`).toBe(true)
      }
      expect(events.some((event) => event.type === 'demo_step')).toBe(true)
      expect(events.some((event) => event.type === 'artifacts_updated')).toBe(true)

      // 7) 截图证据（画布打开态）
      await page.screenshot({ path: screenshotPath('demo-run.png') })

      // 8) 画布交互：关闭 → 从产物重新打开，iframe 再次渲染
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .closeCanvas()
      })
      await expect.poll(async () => (await readStore(page)).canvas.open, { timeout: 10_000 }).toBe(false)
      await page.evaluate((artifactId: string) => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openCanvas(artifactId)
      }, htmlArtifact.id)
      await expect(page.locator('iframe').first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await morrow.close()
    }
  })

  test('权限卡「拒绝」：Mock LLM 触发 write_file → 真实点拒绝 → denied、文件未写入、run 正常结束', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-perm-deny-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个测试文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: 'permission-test.md', content: 'hello from mock' } }]
        },
        { text: '好，那我不写文件了，你想让我怎么整理？' }
      ]
    })
    const morrow = await launchMorrow({ name: 'permission-deny', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      // 注册本地 Mock provider（test-mode 下 127.0.0.1 允许无 Key）并建 ask 权限会话
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '权限测试 · 拒绝' })
      await sendMessageViaStore(page, '请帮我写一个测试文件 permission-test.md。')
      await waitForRunStarted(page, 30_000)

      // 1) 审批请求到达 → 真实审批卡出现（写文件 = write 类）
      const request = await waitForPermission(page, 60_000)
      expect(request.toolName).toBe('write_file')
      const card = page.locator('.permission-card')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(card).toContainText('允许一次')
      await page.screenshot({ path: screenshotPath('permission-card.png') })

      // 2) 真实点击「拒绝」
      await clickPermissionCard(page, 'deny')
      const resolved = await waitForEvent(page, 'permission_resolved', (event) => event.decision === 'deny', 30_000)
      expect(resolved.decision).toBe('deny')

      // 3) 运行收尾：denied 工具结果回填给 Mock LLM，模型改用文字回复
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      const events = await getEvents(page)
      const denied = events.filter((event) => event.type === 'tool_finished' && event.denied === true)
      expect(denied.length).toBeGreaterThanOrEqual(1)
      expect((denied[0].result as { ok?: boolean } | undefined)?.ok).toBe(false)
      expect(events.filter((event) => event.type === 'error')).toEqual([])
      // 文件确实没写入
      expect(existsSync(join(workspace, 'permission-test.md'))).toBe(false)
      // Mock LLM 收到至少两轮（工具调用 → 工具结果回填）
      expect(mock.calls).toBeGreaterThanOrEqual(2)
      const state = await readStore(page)
      expect(state.run).toBeNull()
      await expect(page.locator('.spine')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('permission-denied.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('权限卡「允许一次」：Mock LLM 触发 write_file → 真实点允许 → 文件写入、工具 success、run complete', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-perm-allow-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个测试文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: 'permission-test.md', content: 'hello from mock' } }]
        },
        { text: '文件已经写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'permission-allow', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '权限测试 · 允许' })
      await sendMessageViaStore(page, '请帮我写一个测试文件 permission-test.md。')
      await waitForRunStarted(page, 30_000)

      await waitForPermission(page, 60_000)
      const card = page.locator('.permission-card')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('permission-card-allow.png') })
      await clickPermissionCard(page, 'once')
      await waitForEvent(page, 'permission_resolved', (event) => event.decision === 'once', 30_000)

      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      const events = await getEvents(page)
      const toolFinished = events.filter((event) => event.type === 'tool_finished')
      expect(toolFinished.length).toBeGreaterThanOrEqual(1)
      expect(toolFinished.some((event) => event.denied === true)).toBe(false)
      for (const event of toolFinished) {
        expect((event.result as { ok?: boolean } | undefined)?.ok, `工具失败：${JSON.stringify(event)}`).toBe(true)
      }
      // 文件真实写入且内容正确
      const target = join(workspace, 'permission-test.md')
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('hello from mock')
      expect(mock.calls).toBeGreaterThanOrEqual(2)
      expect((await readStore(page)).run).toBeNull()
      await page.screenshot({ path: screenshotPath('permission-allowed.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('中断：运行中 stopRun → cancelled、消息 interrupted、UI 显示已停止', async () => {
    test.setTimeout(180_000)
    // 0.25 倍速：演示总时长 ~10s+，留出足够窗口在运行中打断
    const morrow = await launchMorrow({
      name: 'interrupt',
      env: { MORROW_DEMO_SPEED: '0.25' },
      timeoutMs: 90_000
    })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      await demoEntryButton(page).click()
      await waitForRunStarted(page, 30_000)
      // 等第一个流式分片，确认已经开始输出
      await waitForEvent(page, 'message_delta', () => true, 30_000)
      await new Promise((resolve) => setTimeout(resolve, 800))

      await stopRunViaStore(page)
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('cancelled')

      const state = await readStore(page)
      expect(state.run).toBeNull()
      // store 里的 assistant 消息应为 interrupted
      const interrupted = state.session?.messages.some((message) => message.interrupted)
      expect(interrupted).toBe(true)

      // 持久化层同样记录了 interrupted（从磁盘重新加载验证）
      const loaded = await page.evaluate(async (sessionId: string) => {
        const result = await window.morrow.session.load(sessionId)
        return result.ok ? result.data : null
      }, state.activeSessionId!)
      expect(loaded).not.toBeNull()
      expect(loaded!.messages.some((message: { interrupted?: boolean }) => message.interrupted === true)).toBe(true)

      // UI：助手消息显示「已停止生成」
      await expect(page.getByText(/已停止生成/).first()).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: screenshotPath('e2e-interrupt.png') })
    } finally {
      await morrow.close()
    }
  })

  test('会话恢复：完成一轮后重启同一 data-dir → 列表/消息/产物保留，画布可打开', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const dataDir = join(root, 'tmp', `e2e-restore-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `e2e-restore-chromium-${stamp}`)

    // 第一段：真实跑完一场演示
    const first = await launchMorrow({
      name: 'restore-1',
      env: { MORROW_DEMO_SPEED: '0.05' },
      dataDir,
      chromiumDir,
      timeoutMs: 90_000
    })
    let sessionId: string
    let artifactCount: number
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      await demoEntryButton(page).click()
      await waitForRunStarted(page, 30_000)
      const finished = await waitForRunFinished(page, 180_000)
      expect(finished.reason).toBe('complete')
      const state = await readStore(page)
      sessionId = state.activeSessionId!
      artifactCount = state.session?.artifacts.length ?? 0
      expect(artifactCount).toBeGreaterThanOrEqual(1)
      expect(state.session?.messages.length ?? 0).toBeGreaterThanOrEqual(2)
    } finally {
      await first.close()
    }
    // 等 Electron 完全退出、单实例锁释放
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // 第二段：同一 data-dir 重启（新的 Chromium user-data-dir）
    const second = await launchMorrow({ name: 'restore-2', dataDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      const boot = await waitForStoreReady(page)
      await dismissOnboarding(page)
      // bootstrap 的会话列表里必须有上一轮的会话
      expect(boot.sessions.some((meta) => meta.id === sessionId)).toBe(true)

      // 选中并加载 → 消息 / 产物 / 计划都还在
      await page.evaluate(async (id: string) => {
        return (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .selectSession(id)
      }, sessionId)
      const restored = await waitUntil(
        async () => {
          const snapshot = await readStore(page)
          return snapshot.session?.id === sessionId ? snapshot : null
        },
        20_000,
        '恢复会话加载'
      )
      expect(restored.session!.messages.length).toBeGreaterThanOrEqual(2)
      expect(restored.session!.artifacts.length).toBe(artifactCount)
      expect(restored.session!.todos.length).toBeGreaterThan(0)

      // 画布能从持久化的产物重新打开并渲染
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openCanvas()
      })
      await expect(page.locator('iframe').first()).toBeVisible({ timeout: 20_000 })
      await page.screenshot({ path: screenshotPath('e2e-restore.png') })
    } finally {
      await second.close()
    }
  })

  test('ask_user 卡片：Mock LLM 触发提问 → 真实点选项 → 答案回填给模型、run 完成', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-question-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '这一步需要你确认一下。',
          toolCalls: [
            {
              name: 'ask_user',
              arguments: {
                question: '报告想用什么格式？',
                options: [
                  { label: 'HTML 报告', value: 'html' },
                  { label: 'Word 文档', value: 'docx' }
                ]
              }
            }
          ]
        },
        { text: '好，那就按 HTML 报告来做。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'ask-user', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '提问卡片测试' })
      await sendMessageViaStore(page, '帮我做一份报告，格式我先确认一下。')
      await waitForRunStarted(page, 30_000)

      // 1) 提问事件与卡片出现（ask_user 属于 meta 工具，不需要审批）
      await waitForEvent(page, 'question_asked', () => true, 60_000)
      const pending = await waitUntil(async () => (await readStore(page)).pendingQuestion, 30_000, 'pendingQuestion')
      expect(pending.question).toContain('报告想用什么格式')
      const card = page.locator('.question-card')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(card).toContainText('HTML 报告')
      await page.screenshot({ path: screenshotPath('e2e-question-card.png') })

      // 2) 真实点击选项
      await card.getByRole('button', { name: /HTML 报告/ }).first().click()
      const answered = await waitForEvent(page, 'question_answered', () => true, 30_000)
      expect(answered.answer).toMatchObject({ value: 'html' })

      // 3) run 完成，答案回填给 Mock LLM 的第二次请求
      const finished = await waitForRunFinished(page, 60_000)
      expect(finished.reason).toBe('complete')
      expect(mock.calls).toBeGreaterThanOrEqual(2)
      const secondTurn = JSON.stringify(mock.requests[1].body.messages)
      expect(secondTurn).toContain('html')
      const state = await readStore(page)
      expect(state.pendingQuestion).toBeNull()
      expect(state.run).toBeNull()
      expect((await getEvents(page)).filter((event) => event.type === 'error')).toEqual([])
      await page.screenshot({ path: screenshotPath('e2e-question-answered.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('键盘与主题：Ctrl+K 命令面板（方向键选择 + Esc 关闭）、Ctrl+B 侧栏、真实明暗切换', async () => {
    test.setTimeout(120_000)
    const morrow = await launchMorrow({ name: 'keyboard', timeoutMs: 60_000 })
    try {
      const { page } = morrow
      const initial = await waitForStoreReady(page)
      await dismissOnboarding(page)
      expect(initial.theme).toBe('dark')

      // 1) Ctrl+K 打开命令面板（命令面板是玻璃浮层 .palette）
      await page.keyboard.press('Control+KeyK')
      const palette = page.locator('.palette')
      await expect(palette).toBeVisible({ timeout: 10_000 })
      await expect.poll(async () => (await readStore(page)).paletteOpen, { timeout: 5_000 }).toBe(true)
      const paletteInput = palette.locator('input.palette-input')
      await expect(paletteInput).toBeVisible()
      await expect(palette.locator('.palette-item').first()).toBeVisible({ timeout: 10_000 })
      await page.screenshot({ path: screenshotPath('e2e-palette.png') })

      // 2) 方向键移动选中项（aria-activedescendant 指向第 2/3 个可选项）
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await expect
        .poll(async () => paletteInput.getAttribute('aria-activedescendant'), { timeout: 5_000 })
        .toBeTruthy()
      const activeDescendant = await paletteInput.getAttribute('aria-activedescendant')
      expect(activeDescendant).toMatch(/^palette-item-/)
      const activeItem = palette.locator(`[id="${activeDescendant}"]`)
      await expect(activeItem).toHaveClass(/is-active/)

      // 3) Esc 关闭命令面板（Modal 层消费 Esc）
      await page.keyboard.press('Escape')
      await expect(palette).toBeHidden({ timeout: 5_000 })
      await expect.poll(async () => (await readStore(page)).paletteOpen, { timeout: 5_000 }).toBe(false)

      // 4) Ctrl+B 折叠/展开侧栏
      const collapsedBefore = (await readStore(page)).sidebarCollapsed
      await page.keyboard.press('Control+KeyB')
      await expect.poll(async () => (await readStore(page)).sidebarCollapsed, { timeout: 5_000 }).toBe(!collapsedBefore)

      // 5) 真实主题动作：store.setTheme → settings.update IPC → data-theme
      await setThemeViaStore(page, 'light')
      await expect.poll(async () => (await readStore(page)).theme, { timeout: 5_000 }).toBe('light')
      const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor.replace(/\s/g, ''))
      expect(lightBg).toBe('rgb(241,237,228)')
      await page.screenshot({ path: screenshotPath('e2e-theme-light-store.png') })

      await setThemeViaStore(page, 'dark')
      await expect.poll(async () => (await readStore(page)).theme, { timeout: 5_000 }).toBe('dark')
      const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor.replace(/\s/g, ''))
      expect(darkBg).toBe('rgb(11,13,16)')
    } finally {
      await morrow.close()
    }
  })
})
