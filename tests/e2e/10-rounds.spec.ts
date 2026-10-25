/**
 * 合并自 14 个 E2E spec：r12-close.spec.ts、r12-delete-diff.spec.ts、r12-plan-sync.spec.ts、r12-protocol-diff.spec.ts、r12-stages.spec.ts、r12-terminal-shell.spec.ts、r13-canvas-tabs.spec.ts、r13-context-meter.spec.ts、r13-diff-card.spec.ts、r13-execution-group.spec.ts、r13-large-diff.spec.ts、r13-long-error.spec.ts、r13-plan-finishing.spec.ts、r16-ui.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { configureMockProvider, createSession, createUiSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForRunFinished, waitForStoreReady, waitUntil } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'

// ── 原文件：r12-close.spec.ts ──────────────────────────────────────────────
test.describe('r12-close.spec.ts', () => {
/**
 * R12 关闭流程：关闭按钮询问 → 记住选择 → 最小化到任务栏 / 完全退出。
 */

async function mainWindowState(app: MorrowApp): Promise<{ minimized: boolean; visible: boolean } | null> {
  return app.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
    if (!win || win.isDestroyed()) return null
    return { minimized: win.isMinimized(), visible: win.isVisible() }
  })
}

test('关闭按钮先询问；选择后记住并最小化到任务栏；改为退出后不再询问', async () => {
  test.setTimeout(120_000)
  test.skip(process.platform !== 'win32', 'Windows 窗口行为测试')
  const morrow = await launchMorrow({ name: 'r12-close', timeoutMs: 90_000 })
  let closed = false
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 第一次关闭：必须弹出询问弹窗，而不是直接隐藏/退出
    await page.locator('.tb-win-close').click()
    const dialog = page.getByRole('dialog', { name: '要关闭 Morrow 吗？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('最小化到任务栏')
    await expect(dialog).toContainText('完全退出')
    await page.screenshot({ path: 'docs/verification/screens/r12-close-ask.png' })

    await dialog.getByRole('button', { name: /最小化到任务栏/ }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 })
      .toBe(true)
    const minimizedState = await mainWindowState(morrow)
    expect(minimizedState?.minimized).toBe(true)
    const settings = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      return result.ok ? result.data.closeAction : null
    })
    expect(settings).toBe('minimize')

    // 恢复窗口后再关闭：已记住选择，不再弹窗，直接最小化
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
      win?.restore()
      win?.show()
      win?.focus()
    })
    await expect.poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 }).toBe(false)
    await page.locator('.tb-win-close').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await mainWindowState(morrow))?.minimized, { timeout: 10_000 }).toBe(true)

    // 改为“退出”：下一次关闭直接结束进程，不再询问
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Morrow')
      win?.restore()
      win?.show()
      win?.focus()
    })
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.settings.update({ closeAction: 'quit' })
      return result.ok
    })
    expect(saved).toBe(true)
    const closePromise = morrow.app.waitForEvent('close', { timeout: 20_000 })
    await page.locator('.tb-win-close').click()
    await closePromise
    closed = true
  } finally {
    if (!closed) await morrow.close()
  }
})

})

// ── 原文件：r12-delete-diff.spec.ts ──────────────────────────────────────────────
test.describe('r12-delete-diff.spec.ts', () => {
/**
 * R12 删除 diff：
 * - 删除文件生成 −N 的 diff 摘要；
 * - 同一轮里新建后又删除的文件净变化为零，不显示任何 diff；
 * - 检查点不把净零临时文件带入回退列表。
 */

test('删除文件显示 diff，新建后删除不显示 diff', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-delete-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'old.txt'), '旧文件一\n旧文件二\n旧文件三\n', 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先建一个临时文件再删掉。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'temp.txt', content: '临时内容\n' } },
          { name: 'delete_file', arguments: { path: 'temp.txt' } }
        ]
      },
      {
        text: '删除旧文件。',
        toolCalls: [{ name: 'delete_file', arguments: { path: 'old.txt' } }]
      },
      { text: '清理完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-delete', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '删除 diff 测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '先建一个临时文件再删除，然后把 old.txt 也删除。')
    await waitForRunFinished(page, 90_000)

    // 新建后删除的 temp.txt 没有净变化；只有 old.txt 留下 −3。
    const diffs = page.locator('.message-diff-summary')
    await expect(diffs).toHaveCount(1)
    await expect(diffs.first()).toContainText('old.txt')
    await expect(diffs.first()).toContainText('−3')
    await expect(diffs.first()).not.toContainText('temp.txt')

    const checkpoints = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data : []
    }, sessionId)
    const files = checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => file.path))
    expect(files.some((path) => path.endsWith('old.txt'))).toBe(true)
    expect(files.some((path) => path.endsWith('temp.txt'))).toBe(false)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-delete-diff-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-delete-diff-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r12-plan-sync.spec.ts ──────────────────────────────────────────────
test.describe('r12-plan-sync.spec.ts', () => {
/**
 * R12 计划同步：
 * 模型做完后直接收尾、忘记更新 todo 时，内核会在结束前提醒它同步计划；
 * 界面上的计划托盘必须从 0/2 变成 2/2，系统提醒本身不进入可见对话。
 */

const twoSteps = (first: string, second: string) => [
  { text: '搭骨架', status: first },
  { text: '补细节', status: second }
]

test('模型漏更新计划时自动提醒同步，托盘显示完成', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-plan-sync-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先列两步计划。',
        toolCalls: [
          { name: 'todo_write', arguments: { todos: twoSteps('in_progress', 'pending') } },
          { name: 'write_file', arguments: { path: 'note.txt', content: 'ok\n' } }
        ]
      },
      { text: '已经全部做好了。' },
      {
        toolCalls: [{ name: 'todo_write', arguments: { todos: twoSteps('completed', 'completed') } }]
      },
      { text: '计划已同步，全部完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-plan-sync', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '计划同步测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '分两步做一个文件。')
    await waitForRunFinished(page, 90_000)

    const state = await readStore(page)
    expect(state.session?.todos.map((todo) => todo.status)).toEqual(['completed', 'completed'])
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('2/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划完成')
    await expect(page.locator('.transcript-inner')).not.toContainText('[系统检查]')
    await page.screenshot({ path: screenshotPath('r12-plan-sync.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r12-protocol-diff.spec.ts ──────────────────────────────────────────────
test.describe('r12-protocol-diff.spec.ts', () => {
/**
 * R12 模型兼容 + diff 摘要：
 * - 模型把工具调用写成正文（DSML/Kimi 等文本协议）时，Morrow 应解析执行、界面无协议乱码；
 * - 文件改动后在消息末尾显示 +X / −Y 的 diff 摘要，双主题可读。
 */

const DSML_CALL = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="edit_file">
<｜｜DSML｜｜ parameter name="path" string="true">dsml-note.txt</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="old_string" string="true">old line</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="new_string" string="true">new line</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`

test('文本工具协议被解析执行，消息后显示 diff 增删行摘要（双主题）', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r12-protocol-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const target = join(workspace, 'dsml-note.txt')
  writeFileSync(target, 'old line\n', 'utf8')

  const mock = await startMockLLM({
    scripts: [{ text: DSML_CALL }, { text: '改好了，已经替换成新的一行。' }]
  })
  const morrow = await launchMorrow({ name: 'r12-protocol', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '协议与 diff 测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把 dsml-note.txt 里的 old line 改成 new line。')
    await waitForRunFinished(page, 60_000)

    // 文本协议被识别成真实工具调用，文件真实修改
    expect(readFileSync(target, 'utf8')).toBe('new line\n')

    // 正文不出现 DSML / parameter 等协议标记
    const transcript = page.locator('.message-assistant').last()
    await expect(transcript).toContainText('改好了')
    await expect(transcript).not.toContainText('DSML')
    await expect(transcript).not.toContainText('parameter')

    // 轮末的改动卡：1 个文件，+1 / −1
    const summary = page.locator('.message-diff-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('本轮改动 1 个文件')
    await expect(summary).toContainText('+1')
    await expect(summary).toContainText('−1')
    await expect(summary).toContainText('dsml-note.txt')
    await page.waitForTimeout(400)
    await transcript.scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('r12-protocol-diff-dark.png') })

    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(summary).toBeVisible()
    await page.screenshot({ path: screenshotPath('r12-protocol-diff-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r12-stages.spec.ts ──────────────────────────────────────────────
test.describe('r12-stages.spec.ts', () => {
/**
 * R12 阶段式分叉/回退：
 * - 每完成一个计划步骤只出现一个阶段节点，中间模型步骤不显示分叉/回退；
 * - 新建文件也显示 diff 增删行；
 * - 回退到阶段节点：保留该阶段对话，撤销其后的文件改动与对话。
 */

const todos = (first: string, second: string) => [
  { text: '搭骨架', status: first },
  { text: '补细节', status: second }
]

test('阶段节点只在计划步骤完成时出现，回退保留阶段边界', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r12-stages-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先拆成两步。',
        toolCalls: [{ name: 'todo_write', arguments: { todos: todos('in_progress', 'pending') } }]
      },
      {
        text: '第一步完成。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'plan.html', content: '<h1>计划</h1>\n<p>骨架</p>\n' } },
          { name: 'todo_write', arguments: { todos: todos('completed', 'in_progress') } }
        ]
      },
      {
        text: '第二步完成。',
        toolCalls: [
          { name: 'edit_file', arguments: { path: 'plan.html', old_string: '骨架', new_string: '完整骨架' } },
          { name: 'todo_write', arguments: { todos: todos('completed', 'completed') } }
        ]
      },
      { text: '两步都完成了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r12-stages', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '阶段节点测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '按两步做一个计划页面。')
    await waitForRunFinished(page, 90_000)

    // 两个计划步骤各一个阶段节点；中间那条只有 todo_write 的模型步骤没有操作行
    await expect(page.locator('.message-stage-node')).toHaveCount(2)
    await expect(page.locator('.message-stage-node').first()).toContainText('完成：搭骨架')
    // 长阶段标题只能让标题自己换行/截断，不能把“阶段完成”压成竖排
    await expect(page.locator('.message-stage-label').first()).toHaveCSS('white-space', 'nowrap')
    const firstStep = page.locator('.message-assistant').filter({ hasText: '先拆成两步。' })
    await expect(firstStep.locator('.message-meta')).toHaveCount(0)

    // 整轮只保留一张改动卡：新建 + 后续编辑汇总为 +3 −1
    const diffs = page.locator('.message-diff-summary')
    await expect(diffs).toHaveCount(1)
    await expect(diffs.first()).toContainText('本轮改动 1 个文件')
    await expect(diffs.first()).toContainText('+3')
    await expect(diffs.first()).toContainText('−1')
    await expect(diffs.first()).toContainText('plan.html')
    await diffs.first().click()
    const fileRow = page.locator('.message-diff-file-head').first()
    await expect(fileRow).toContainText('+3')
    await expect(fileRow).toContainText('−1')
    await fileRow.click()
    await expect(page.locator('.message-diff-change')).toHaveCount(2)
    await expect(page.locator('.message-diff-change-note')).toContainText('2 次')
    await page.screenshot({ path: screenshotPath('r18-turn-diff-multi-change.png') })
    await fileRow.click()
    await diffs.first().click()

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.locator('.message-stage-node').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('r12-stages-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r12-stages-light.png') })
    await setThemeViaStore(page, 'dark')

    // 回退到第一个阶段：保留边界消息，文件回到该阶段完成时的内容
    const firstStage = page
      .locator('.message-assistant')
      .filter({ has: page.locator('.message-stage-node') })
      .first()
    await firstStage.getByRole('button', { name: '回退到这个阶段完成时' }).click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.getByText('对话和文件会一起回到这个阶段完成时。这一步不能撤销。')).toBeVisible()
    await expect(page.getByText(/保留这个阶段，移除其后的 2 条对话/)).toBeVisible()
    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这个阶段完成时/)).toBeVisible({ timeout: 15_000 })

    expect(readFileSync(join(workspace, 'plan.html'), 'utf8')).toBe('<h1>计划</h1>\n<p>骨架</p>\n')
    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.session?.messages.length === 3 &&
          state.session.todos?.length === 2 &&
          state.session.todos[0].status === 'completed' &&
          state.session.todos[1].status === 'in_progress'
          ? true
          : null
      },
      20_000,
      '阶段对话与计划已恢复'
    )
    await expect(page.locator('.message-stage-node')).toHaveCount(1)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r12-terminal-shell.spec.ts ──────────────────────────────────────────────
test.describe('r12-terminal-shell.spec.ts', () => {
/**
 * R12 终端一致性：
 * 设置里选中的默认终端必须真正用于 Agent 的 run_command（而不是永远 Windows PowerShell）。
 * 逐个验证 PowerShell 7 / Windows PowerShell / cmd / Git Bash 的语法与输出。
 */

// Git Bash 在当前 DSH 受限令牌下无法创建 MSYS 共享内存（0xC0000022），
// 其一次性命令与后台任务由 tests/unit/main/terminal.test.ts 在真实 Node 进程中覆盖。
const cases = [
  { id: 'pwsh', command: '$PSVersionTable.PSVersion.Major', expected: '7' },
  { id: 'powershell', command: '$PSVersionTable.PSVersion.Major', expected: '5' },
  { id: 'cmd', command: 'echo %OS%', expected: 'Windows_NT' }
]

test('Agent run_command 使用设置里选中的 PowerShell 7 / Windows PowerShell / cmd', async () => {
  test.setTimeout(240_000)
  const workspace = join(root, 'tmp', `e2e-r12-shell-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '完成。' }] })
  const morrow = await launchMorrow({ name: 'r12-shell', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const profiles = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke('feature:terminal:profiles')
      return result.ok ? (result.data as { profiles: Array<{ id: string }> }).profiles.map((item) => item.id) : []
    })
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '终端一致性测试'
    })

    for (const item of cases) {
      if (!profiles.includes(item.id)) continue
      await page.evaluate(async (shell) => {
        await window.morrow.settings.update({ terminalShell: shell })
      }, item.id)
      mock.reset([
        { text: `检查 ${item.id}`, toolCalls: [{ name: 'run_command', arguments: { command: item.command } }] },
        { text: '完成。' }
      ])
      await installEventCollector(page)
      await sendMessageViaStore(page, `只运行这一条终端检查：${item.command}`)
      await waitForRunFinished(page, 60_000)
      const event = (await getEvents(page))
        .filter((entry) => entry.type === 'tool_finished')
        .at(-1) as
        | { toolUseId?: string; result?: { ok?: boolean; output?: string; meta?: Record<string, unknown> } }
        | undefined
      if (!event?.result?.ok) console.log('SHELL FAIL', item.id, event?.result?.output)
      expect(event?.result?.ok, `${item.id} 命令失败`).toBe(true)
      expect(String(event?.result?.output ?? '')).toContain(item.expected)
      expect(event?.result?.meta).toMatchObject({ shellId: item.id })
    }
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-canvas-tabs.spec.ts ──────────────────────────────────────────────
test.describe('r13-canvas-tabs.spec.ts', () => {
/** 画布页签：成品页签可关闭、可拖动排序。 */

test('画布成品页签支持关闭和拖动排序', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-tabs-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '打开三个成品。',
        toolCalls: [
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 A', content: '<html><body>A</body></html>' } },
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 B', content: '<html><body>B</body></html>' } },
          { name: 'open_artifact', arguments: { kind: 'html', title: '成品 C', content: '<html><body>C</body></html>' } }
        ]
      },
      { text: '都打开了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-tabs', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '画布页签测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '打开三个成品。')
    await waitForRunFinished(page, 60_000)

    const titles = page.locator('.canvas-tab-title')
    await expect(titles).toHaveCount(3)
    // 画布页签与终端/浏览器同款：24px 高、5px 微圆角、金色选中边框
    const activeCanvasTab = page.locator('.canvas-doc-tab.is-active').first()
    await expect(activeCanvasTab).toHaveCSS('height', '24px')
    await expect(activeCanvasTab).toHaveCSS('border-radius', '5px')
    await expect(activeCanvasTab).toHaveCSS('border-top-color', 'rgba(200, 174, 125, 0.32)')
    const tabA = page.locator('.canvas-doc-tab').filter({ hasText: '成品 A' })
    await tabA.locator('.canvas-tab-close').click()
    await expect(page.locator('.canvas-doc-tab').filter({ hasText: '成品 A' })).toHaveCount(0)
    await expect(page.locator('.canvas-tab-title')).toHaveCount(2)

    const tabB = page.locator('.canvas-doc-tab').filter({ hasText: '成品 B' })
    const tabC = page.locator('.canvas-doc-tab').filter({ hasText: '成品 C' })
    await tabC.dragTo(tabB)
    await expect(page.locator('.canvas-tab-title').first()).toHaveText('成品 C')
    await page.screenshot({ path: screenshotPath('r13-canvas-tabs.png') })

    // 关闭最后一个页签：画布保留为空态，页签不会在重新打开时复活
    await page.locator('.canvas-doc-tab').filter({ hasText: '成品 B' }).locator('.canvas-tab-close').click()
    await page.locator('.canvas-doc-tab').filter({ hasText: '成品 C' }).locator('.canvas-tab-close').click()
    await expect(page.locator('.canvas-tab-title')).toHaveCount(0)
    await expect(page.locator('.canvas-root')).toBeVisible()
    await expect(page.locator('.canvas-empty')).toBeVisible()
    await page.screenshot({ path: screenshotPath('r13-canvas-tabs-empty.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-context-meter.spec.ts ──────────────────────────────────────────────
test.describe('r13-context-meter.spec.ts', () => {
/** 输入框上下文环：顶栏入口已移除、实时 token 详情、双主题。 */

test('上下文入口在输入框内，顶栏已移除，点击后展示上下文与 token 详情', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-context-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '这是用于产生 token 用量的回答。' }] })
  const morrow = await launchMorrow({ name: 'r13-context', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '上下文详情测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '简单回答一句。')
    await waitForRunFinished(page, 60_000)
    await expect(page.locator('.tb-ctx')).toHaveCount(0)
    await expect(page.locator('.composer-bar .composer-ctx')).toHaveCount(1)
    const meter = page.locator('.composer-ctx-ring')
    await expect(meter).toBeVisible()
    const meterBox = await meter.boundingBox()
    const inputBox = await page.locator('.composer-input').boundingBox()
    expect(meterBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(meterBox!.y).toBeGreaterThan(inputBox!.y)
    await meter.click()
    const popover = page.getByRole('dialog', { name: '上下文与 Token 使用' })
    await expect(popover).toBeVisible()
    const popBox = await popover.boundingBox()
    expect(popBox).not.toBeNull()
    // 弹窗紧贴圆环按钮上沿，并覆盖在输入框上方，而不是固定到输入框顶部。
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(meterBox!.y + 4)
    expect(popBox!.y + popBox!.height).toBeGreaterThanOrEqual(meterBox!.y - 20)
    expect(popBox!.y).toBeLessThan(inputBox!.y + inputBox!.height)
    expect(Math.abs(popBox!.x - meterBox!.x)).toBeLessThanOrEqual(16)
    const topmost = await page.evaluate(() => {
      const el = document.querySelector('.composer-ctx-pop')
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { inside: top ? el.contains(top) : false, topClass: top?.className ?? '' }
    })
    expect(topmost?.inside, JSON.stringify(topmost)).toBe(true)
    await expect(popover).toContainText('上下文')
    await expect(popover).toContainText('输入')
    await expect(popover).toContainText('其中缓存')
    await expect(popover).toContainText('缓存命中率')
    await expect(popover).toContainText('输出')
    await page.waitForTimeout(220)
    await page.screenshot({ path: screenshotPath('r13-context-meter-dark.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(350)
    await expect(popover).toBeVisible()
    await page.screenshot({ path: screenshotPath('r13-context-meter-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-diff-card.spec.ts ──────────────────────────────────────────────
test.describe('r13-diff-card.spec.ts', () => {
/**
 * R13 改动卡：运行中只显示统计；任务结束后才能展开查看逐文件 diff。
 */

test('改动卡运行中不可展开，结束后可展开查看详细 diff', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-diff-card-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先写一版。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'draft.txt', content: '第一行\n第二行\n' } }
        ]
      },
      { text: '写好了。', delayMs: 2_500 }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-diff-card', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '改动卡测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '写一个草稿文件。')

    // 运行中：整轮只有一张统计，没有展开入口
    const summary = page.locator('.message-diff-summary')
    await expect(summary).toHaveCount(1, { timeout: 30_000 })
    await expect(summary).toContainText('draft.txt')
    await expect(summary).not.toHaveClass(/is-expandable/)
    await expect(page.locator('.message-diff-detail')).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('r13-diff-card-collapsed.png') })

    await waitForRunFinished(page, 60_000)
    const expandable = page.locator('.message-diff-summary.is-expandable')
    await expect(expandable).toHaveCount(1)
    await expect(page.locator('.message-diff-detail')).toHaveCount(0)

    // 展开后先看到文件列表，逐行 diff 默认收起
    await expandable.click()
    await expect(expandable).toHaveAttribute('aria-expanded', 'true')
    const detail = page.locator('.message-diff-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('draft.txt')
    await expect(page.locator('.message-diff-file .diff-view')).toHaveCount(0)

    const fileRow = page.locator('.message-diff-file-head', { hasText: 'draft.txt' })
    await expect(fileRow).toHaveAttribute('aria-expanded', 'false')
    await fileRow.click()
    await expect(fileRow).toHaveAttribute('aria-expanded', 'true')
    const fileDiff = page.locator('.message-diff-file .diff-view')
    await expect(fileDiff).toContainText('+第一行')
    await expect(fileDiff).toContainText('+第二行')
    const typography = await fileDiff.evaluate((root) => {
      const gutter = getComputedStyle(root.querySelector('.diff-gutter') as HTMLElement)
      const code = getComputedStyle(root.querySelector('.diff-code') as HTMLElement)
      return {
        gutterWeight: gutter.fontWeight,
        codeWeight: code.fontWeight,
        gutterSize: gutter.fontSize,
        codeSize: code.fontSize,
        gutterSpacing: gutter.letterSpacing,
        codeSpacing: code.letterSpacing
      }
    })
    expect(typography.gutterWeight).toBe('400')
    expect(typography.codeWeight).toBe('400')
    expect(typography.gutterSize).toBe(typography.codeSize)
    expect(['normal', '0px']).toContain(typography.gutterSpacing)
    expect(['normal', '0px']).toContain(typography.codeSpacing)
    const statTypography = await page.locator('.message-diff-file-head .message-diff-add').first().evaluate((element) => {
      const style = getComputedStyle(element)
      return { weight: style.fontWeight, size: style.fontSize, spacing: style.letterSpacing }
    })
    expect(statTypography.weight).toBe('400')
    expect(statTypography.size).toBe(typography.codeSize)
    expect(['normal', '0px']).toContain(statTypography.spacing)
    await page.screenshot({ path: screenshotPath('r13-diff-card-expanded.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r13-diff-card-expanded-light.png') })

    await expandable.click()
    await expect(page.locator('.message-diff-detail')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('超长文件路径不会把展开箭头挤到第二行', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-diff-long-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const longPath =
    'very-long-directory-name/another-very-long-directory/third-long-directory/ultra-long-file-name-for-diff-card-layout-check-with-many-words.ts'
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先写一版。',
        toolCalls: [{ name: 'write_file', arguments: { path: longPath, content: 'export const value = 1\n' } }]
      },
      { text: '写好了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-diff-long', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '超长路径改动卡'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '写一个层级很深的文件。')
    await waitForRunFinished(page, 60_000)
    const summary = page.locator('.message-diff-summary').first()
    await expect(summary).toContainText('ultra-long-file-name')
    const boxes = await page.evaluate(() => {
      const summaryEl = document.querySelector('.message-diff-summary')
      const chevron = document.querySelector('.message-diff-summary .message-diff-chevron')
      if (!summaryEl || !chevron) return null
      return {
        summary: summaryEl.getBoundingClientRect().toJSON(),
        chevron: chevron.getBoundingClientRect().toJSON()
      }
    })
    expect(boxes).not.toBeNull()
    expect(boxes!.summary.height).toBeLessThan(44)
    expect(boxes!.chevron.y).toBeLessThan(boxes!.summary.y + 26)
    expect(boxes!.chevron.x).toBeGreaterThan(boxes!.summary.x + boxes!.summary.width / 2)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-execution-group.spec.ts ──────────────────────────────────────────────
test.describe('r13-execution-group.spec.ts', () => {
/**
 * R13 执行过程分组：
 * 同一轮的多步工具调用默认合并成一条「执行工具 N 次」；展开后保留每一步轨迹，
 * 再次点击可收起，最终回答始终在组外可见。
 */

test('多步执行默认合并，展开与收起保留真实工具轨迹', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-execution-group-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const files = Array.from({ length: 8 }, (_, index) => `note-${index + 1}.txt`)
  for (const [index, name] of files.entries()) {
    writeFileSync(join(workspace, name), `第 ${index + 1} 份记录\n`, 'utf8')
  }
  const mock = await startMockLLM({
    scripts: [
      ...files.map((name) => ({
        toolCalls: [{ name: 'read_file', arguments: { path: name } }]
      })),
      { text: '八份记录都检查完了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-execution-group', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '执行分组测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把八份记录都检查一遍。')
    await waitForRunFinished(page, 90_000)

    const group = page.locator('.exec-group')
    await expect(group).toHaveCount(1)
    const head = group.locator('.exec-group-head')
    await expect(head).toContainText('执行工具 8 次')
    // 简要视图只显示工具次数，不再显示“N 步”
    await expect(head.locator('.exec-group-meta')).toHaveCount(0)
    await expect(head).not.toContainText('步')
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(group.locator('.exec-group-body')).toHaveCount(0)
    await expect(page.locator('.message-assistant').last()).toContainText('八份记录都检查完了。')
    await page.waitForTimeout(220)
    await page.screenshot({ path: screenshotPath('r13-execution-group-dark.png') })

    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await expect(group.locator('.exec-group-body')).toBeVisible()
    await expect(group.locator('.exec-group-body .spine-item')).toHaveCount(8)

    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await page.screenshot({ path: screenshotPath('r13-execution-group-light.png') })

    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'false')
    await expect(group.locator('.exec-group-body')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-large-diff.spec.ts ──────────────────────────────────────────────
test.describe('r13-large-diff.spec.ts', () => {
/** 大文件局部修改：diff 摘要必须显示真实增删行，不能退化为 +0/-0。 */

test('超过 1000 行的 diff 在文件详情里给出截断提示', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-large-diff-cap-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const beforeLines = Array.from({ length: 1_100 }, (_, index) => `line ${index}`)
  const afterLines = Array.from({ length: 1_100 }, (_, index) => `changed ${index}`)
  writeFileSync(join(workspace, 'long.txt'), `${beforeLines.join('\n')}\n`, 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '重写这个文件。',
        toolCalls: [
          {
            name: 'write_file',
            arguments: { path: 'long.txt', content: `${afterLines.join('\n')}\n` }
          }
        ]
      },
      { text: '重写完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-large-diff-cap', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '大 diff 截断' })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把 long.txt 的每一行都改掉。')
    await waitForRunFinished(page, 60_000)

    const summary = page.locator('.message-diff-summary')
    await expect(summary).toContainText('+1100')
    await expect(summary).toContainText('−1100')
    await summary.click()
    await page.locator('.message-diff-file-head', { hasText: 'long.txt' }).click()
    await expect(page.locator('.diff-note')).toContainText('仅显示前 1000 行')
    await page.screenshot({ path: screenshotPath('r18-large-diff-notice.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('大文件局部 edit 显示真实增删行而不是“内容没有变化”', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r13-large-diff-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const lines = Array.from({ length: 2490 }, (_, index) => `line ${index}`)
  lines[1200] = '.theme-toggle { background: #20261a; }'
  writeFileSync(join(workspace, 'big.css'), `${lines.join('\n')}\n`, 'utf8')
  const mock = await startMockLLM({
    scripts: [
      {
        text: '修改这一行。',
        toolCalls: [
          {
            name: 'edit_file',
            arguments: {
              path: 'big.css',
              old_string: '.theme-toggle { background: #20261a; }',
              new_string: '.theme-toggle { background: #3a4630; }\ntransition: background .2s ease;'
            }
          }
        ]
      },
      { text: '修改完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-large-diff', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'ask', title: '大文件 diff' })
    await installEventCollector(page)
    await sendMessageViaStore(page, '修改 big.css 里的主题切换颜色。')
    await waitForRunFinished(page, 60_000)

    const summary = page.locator('.message-diff-summary')
    await expect(summary).toHaveCount(1)
    await expect(summary).toContainText('+2')
    await expect(summary).toContainText('−1')
    const assistant = page.locator('.message-assistant').first()
    await assistant.locator('.spine-item').first().click()
    await expect(assistant).not.toContainText('内容没有变化')
    await expect(assistant).toContainText('3a4630')
    await page.screenshot({ path: screenshotPath('r13-large-diff.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-long-error.spec.ts ──────────────────────────────────────────────
test.describe('r13-long-error.spec.ts', () => {
/**
 * R13 长错误不溢出：
 * 工具错误里带超长无空格路径时，错误块必须换行，且不能把对话区撑出横向滚动。
 */

test('超长工具错误在活动区换行，不产生横向溢出', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-long-error-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const longName = `${'abcdefghij'.repeat(40)}.html`
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我读取这个文件。',
        toolCalls: [{ name: 'read_file', arguments: { path: longName } }]
      },
      { text: '路径不对，我先用 list_dir 找正确文件。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-long-error', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '长错误测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '读取那个文件。')
    await waitForRunFinished(page, 90_000)

    const failedRow = page.locator('.spine-row.is-error').first()
    const failedItem = failedRow.locator('.spine-item')
    await expect(failedRow).toBeVisible()
    await expect(failedItem).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.spine-error')).toHaveCount(0)
    await expect(failedRow.locator('.spine-summary')).toContainText('路径不存在')
    await failedRow.scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath('r13-long-error-collapsed.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r13-long-error-collapsed-light.png') })
    await setThemeViaStore(page, 'dark')

    await failedItem.click()
    await expect(failedItem).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.spine-error-title')).toContainText('路径不存在')
    await page.locator('.spine-error').scrollIntoViewIfNeeded()
    await expect(page.locator('.spine-error')).toBeVisible()
    const overflow = await page.evaluate(() => {
      const pick = (selector: string): HTMLElement | null => document.querySelector(selector)
      const error = pick('.spine-error')
      const detail = pick('.spine-detail')
      const transcript = pick('.transcript-inner')
      return {
        error: error ? error.scrollWidth - error.clientWidth : -1,
        detail: detail ? detail.scrollWidth - detail.clientWidth : -1,
        transcript: transcript ? transcript.scrollWidth - transcript.clientWidth : -1
      }
    })
    expect(overflow.error, JSON.stringify(overflow)).toBeLessThanOrEqual(1)
    expect(overflow.detail, JSON.stringify(overflow)).toBeLessThanOrEqual(1)
    expect(overflow.transcript, JSON.stringify(overflow)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: screenshotPath('r13-long-error.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r13-plan-finishing.spec.ts ──────────────────────────────────────────────
test.describe('r13-plan-finishing.spec.ts', () => {
/**
 * R13 真实进度：
 * 计划已全部标完成、模型却继续改文件时，托盘不能继续显示「计划完成」；
 * 内核会追加真实的「收尾完善」步骤，界面进度与实际工作保持一致。
 */

test('计划完成后继续打磨时追加收尾步骤，不虚报全部完成', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-r13-plan-finishing-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({
    scripts: [
      {
        toolCalls: [
          {
            name: 'todo_write',
            arguments: { todos: [{ text: '交付页面', status: 'completed' }] }
          }
        ]
      },
      {
        toolCalls: [{ name: 'write_file', arguments: { path: 'page.html', content: '<h1>v1</h1>\n' } }]
      },
      { delayMs: 1800, text: '继续打磨视觉细节。' },
      { text: '收尾工作尚未结束。' },
      { text: '本轮先到这里。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'r13-plan-finishing', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '收尾进度测试'
    })
    await installEventCollector(page)
    await sendMessageViaStore(page, '把页面继续完善好。')

    await expect(page.locator('.plan-tray')).toContainText('收尾完善', { timeout: 60_000 })
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划')
    await expect(page.locator('.plan-tray .plan-title')).not.toHaveText('计划完成')

    await waitForRunFinished(page, 90_000)
    const state = await readStore(page)
    expect(state.session?.todos.map((todo) => [todo.text, todo.status])).toEqual([
      ['交付页面', 'completed'],
      ['收尾完善', 'in_progress']
    ])
    await expect(page.locator('.plan-tray .plan-progress')).toHaveText('1/2')
    await expect(page.locator('.plan-tray .plan-title')).toHaveText('计划')
    await expect(page.locator('.plan-tray .plan-item-state')).toHaveText('未完成')
    expect(readFileSync(join(workspace, 'page.html'), 'utf8')).toContain('v1')
    await page.screenshot({ path: screenshotPath('r13-plan-finishing.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：r16-ui.spec.ts ──────────────────────────────────────────────
test.describe('r16-ui.spec.ts', () => {
/**
 * R16 界面收口：顶栏字标/对话标题、首页文案单行、输入框拖动高度。
 */

test('顶栏不显示 Morrow 字样、首页文案不换行、输入框可拖高并持久化', async () => {
  test.setTimeout(120_000)
  const workspace = join(root, 'tmp', `e2e-r16-ui-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'r16-ui' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 顶栏不再显示品牌字样；品牌只保留在关于页
    await expect(page.locator('.tb-wordmark')).toHaveCount(0)
    const dragRegion = await page.locator('.tb-left').evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region')
    )
    expect(dragRegion).toBe('drag')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r16-titlebar-empty.png') })

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    await expect(settings.locator('.st-about-name')).toHaveText('Morrow')
    await settings.getByRole('button', { name: '完成' }).click()

    // 拖动输入框上沿：高度增加，并写入 settings
    const composer = page.locator('.composer-shell')
    const handle = page.locator('.composer-resize')
    const before = await composer.boundingBox()
    const grip = await handle.boundingBox()
    expect(before && grip).toBeTruthy()
    await page.mouse.move((grip?.x ?? 0) + (grip?.width ?? 0) / 2, (grip?.y ?? 0) + 5)
    await page.mouse.down()
    await page.mouse.move((grip?.x ?? 0) + (grip?.width ?? 0) / 2, (grip?.y ?? 0) - 80, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const settings = await page.evaluate(() => window.morrow.settings.get())
        return settings.ok ? settings.data.composerHeight : 0
      })
      .toBeGreaterThanOrEqual(80)
    const after = await composer.boundingBox()
    expect(after?.height ?? 0).toBeGreaterThan((before?.height ?? 0) + 40)
    await page.screenshot({ path: screenshotPath('r16-composer-height.png') })

    // 新建对话后：顶栏显示对话标题，品牌字样仍不出现，空对话页显示首页说明
    await createUiSession(page, { workspace, permissionMode: 'auto', title: '顶栏标题测试' })
    await expect(page.locator('.tb-wordmark')).toHaveCount(0)
    await expect(page.locator('.tb-title')).toContainText('顶栏标题测试')
    const desc = page.locator('.transcript-empty-desc')
    await expect(desc).toBeVisible()
    const overflow = await desc.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(overflow.scroll, '首页说明不应产生第二行').toBeLessThanOrEqual(overflow.client + 1)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r16-titlebar-title.png') })
  } finally {
    await morrow.close()
  }
})

test('输入框双击不再折叠，高度固定为 80px 到窗口 1/3', async () => {
  const morrow = await launchMorrow({ name: 'composer-height-limits', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const input = page.locator('.composer-input')
    const handle = page.locator('.composer-resize')
    await expect(input).toBeVisible()
    const inputHeight = (): Promise<number> => input.evaluate((el) => el.getBoundingClientRect().height)

    expect(await inputHeight()).toBeGreaterThanOrEqual(80)
    await handle.dblclick()
    await page.waitForTimeout(200)
    expect(await inputHeight(), '双击不应折叠输入框').toBeGreaterThanOrEqual(80)

    const grip = await handle.boundingBox()
    expect(grip).not.toBeNull()
    const x = (grip?.x ?? 0) + (grip?.width ?? 0) / 2
    await page.mouse.move(x, (grip?.y ?? 0) + 5)
    await page.mouse.down()
    await page.mouse.move(x, 10, { steps: 10 })
    await page.mouse.up()
    const maxAllowed = await page.evaluate(() => Math.floor(window.innerHeight / 3))
    expect(await inputHeight()).toBeLessThanOrEqual(maxAllowed + 1)
    expect(await inputHeight()).toBeGreaterThan(150)

    const grip2 = await handle.boundingBox()
    expect(grip2).not.toBeNull()
    const x2 = (grip2?.x ?? 0) + (grip2?.width ?? 0) / 2
    await page.mouse.move(x2, (grip2?.y ?? 0) + 5)
    await page.mouse.down()
    await page.mouse.move(x2, 1200, { steps: 10 })
    await page.mouse.up()
    expect(await inputHeight()).toBeGreaterThanOrEqual(79)
    const settings = await page.evaluate(() => window.morrow.settings.get())
    if (settings.ok) expect(settings.data.composerHeight).toBeGreaterThanOrEqual(80)
  } finally {
    await morrow.close()
  }
})

})
