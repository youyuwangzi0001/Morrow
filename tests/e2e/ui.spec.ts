import { launchMorrow, root, screenshotPath, configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForDefaultWindowSize, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil, clearEvents, openToolPanel, type MorrowApp } from './helpers'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
test.describe("01-ui-smoke", () => {
// ── 原文件：session-branching.spec.ts ──────────────────────────────────────────────
test.describe('session-branching.spec.ts', () => {
/**
 * P1-7 会话分支与消息操作 E2E：
 * - 重新生成最后一条回答（请求里不再带上旧回答）；
 * - 就地编辑首条用户消息并重发（旧对话被截断）；
 * - 删除某条消息之后的所有内容；
 * - 从消息分叉出新会话，原会话保持不变；
 * - 置顶 / 归档 / 移出归档的侧栏交互。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

function chatBodies(mock: { requests: Array<{ url: string; messages: Array<{ role: string; content: unknown }>; lastUserMessageText?: string }> }) {
  return mock.requests.filter((request) => request.url.includes('/chat/completions'))
}

test('@core:sessions 会话分支与消息操作：重新生成、编辑重发、分叉、置顶与归档', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一版回答。' },
      { text: '第二版回答。' },
      { text: '编辑后的回答。' },
      { text: '补充回答。' }
    ]
  })
  const workspace = workspaceAt('e2e-session-actions')
  const morrow = await launchMorrow({ name: 'session-actions', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const originalId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'P1-7 测试'
    })

    const send = (text: string): Promise<void> =>
      page.evaluate((value) => {
        return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (t: string) => Promise<void> } } })
          .__morrowStore.getState().sendMessage(value)
      }, text)

    const lastText = async (): Promise<string> => {
      const state = await readStore(page)
      return state.session?.messages.at(-1)?.text ?? ''
    }

    const dismissToasts = (): Promise<void> =>
      page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })

    await send('请回答第一版')
    await waitUntil(async () => (await lastText()) === '第一版回答。', 60_000, '第一版回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮结束')
    expect(chatBodies(mock)).toHaveLength(1)

    // 重新生成：旧回答被丢弃，请求里不带 assistant 消息
    await page.getByRole('button', { name: '重新生成回答' }).click()
    await waitUntil(async () => (await lastText()) === '第二版回答。', 60_000, '重新生成回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '重新生成结束')
    const regenerated = chatBodies(mock)[1]
    expect(regenerated?.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
    expect((await readStore(page)).session?.messages).toHaveLength(2)

    // 编辑首条用户消息并重发：消息之后的回答被截断，新内容重新发送
    const firstUser = page.locator('.message-user').first()
    await firstUser.hover()
    await firstUser.getByRole('button', { name: '编辑并重发' }).click()
    const editor = page.locator('.message-user-editor')
    await expect(editor).toBeVisible()
    await editor.fill('请回答编辑版')
    await editor.press('Enter')
    await waitUntil(async () => (await lastText()) === '编辑后的回答。', 60_000, '编辑后的回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '编辑重发结束')
    const edited = chatBodies(mock)[2]
    expect(edited?.lastUserMessageText).toBe('请回答编辑版')
    expect(edited?.messages.filter((message) => message.role === 'assistant')).toHaveLength(0)
    const afterEdit = await readStore(page)
    expect(afterEdit.session?.messages).toHaveLength(2)
    expect(afterEdit.session?.messages[0]?.text).toBe('请回答编辑版')

    // 再补一轮，让消息操作和删除后续都有真实的上下文
    await send('再补充一句')
    await waitUntil(async () => (await lastText()) === '补充回答。', 60_000, '补充回答')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '补充轮结束')
    expect((await readStore(page)).session?.messages).toHaveLength(4)

    // 截图：悬停用户消息时的完整操作行
    await page.locator('.message-user').first().hover()
    await dismissToasts()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('message-actions-dark.png') })

    // 从首条用户消息分叉：新会话只含到该消息为止的内容
    await page.locator('.message-user').first().getByRole('button', { name: '从这条消息分叉' }).click()
    await waitUntil(async () => (await readStore(page)).activeSessionId !== originalId, 20_000, '分叉会话激活')
    const branched = await readStore(page)
    expect(branched.session?.messages).toHaveLength(1)
    expect(branched.session?.title).toBe('P1-7 测试 · 分支')
    expect(branched.sessions).toHaveLength(2)
    const branchUsage = await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { session?: { usage?: Record<string, number> } } } })
        .__morrowStore.getState().session?.usage
    })
    expect(branchUsage).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    await dismissToasts()
    await page.screenshot({ path: screenshotPath('session-branch-dark.png') })

    // 回到原会话，验证原对话没有被分叉改动
    await page.evaluate((id) => {
      void (window as unknown as { __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } } })
        .__morrowStore.getState().selectSession(id)
    }, originalId)
    await waitUntil(async () => (await readStore(page)).activeSessionId === originalId, 20_000, '回到原会话')
    expect((await readStore(page)).session?.messages).toHaveLength(4)

    // 置顶：置顶分组出现在列表最上方
    const originalRow = page
      .locator('.sb-session')
      .filter({ has: page.getByText('P1-7 测试', { exact: true }) })
    await originalRow.hover()
    await originalRow.getByRole('button', { name: '置顶对话' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === originalId)?.pinned === true
    }, 15_000, '会话已置顶')
    await expect(page.locator('.sb-group-head', { hasText: '置顶' })).toBeVisible()
    await dismissToasts()
    await page.screenshot({ path: screenshotPath('session-pinned-dark.png') })

    // 归档：从侧栏收起，改在 设置 → 归档 中管理
    await originalRow.hover()
    await originalRow.getByRole('button', { name: '归档对话' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === originalId)?.archived === true
    }, 15_000, '会话已归档')
    await expect(page.getByText('P1-7 测试', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sb-group.is-archived')).toHaveCount(0)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    const archivedRow = page
      .locator('.st-archive-row')
      .filter({ has: page.getByText('P1-7 测试', { exact: true }) })
    await expect(archivedRow).toBeVisible()
    await dismissToasts()
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('session-archive-light.png') })

    // 恢复后回到侧栏的“置顶”分组
    await archivedRow.getByRole('button', { name: '恢复' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      const meta = state.sessions.find((session) => session.id === originalId)
      return meta?.archived === false && meta?.pinned === true
    }, 15_000, '会话已移出归档')
    await expect(archivedRow).toHaveCount(0)
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText('P1-7 测试', { exact: true })).toBeVisible()
    await setThemeViaStore(page, 'dark')

    // 归档当前会话时应用已切到下一个会话；移出归档后手动切回原会话再验证删除
    await page.evaluate((id) => {
      void (window as unknown as { __morrowStore: { getState: () => { selectSession: (id: string) => Promise<void> } } })
        .__morrowStore.getState().selectSession(id)
    }, originalId)
    await waitUntil(async () => (await readStore(page)).activeSessionId === originalId, 20_000, '切回原会话')

    // 删除后续：保留当前消息，清掉其后的全部对话
    await page.locator('.message-user').first().hover()
    await page.locator('.message-user').first().getByRole('button', { name: '删除后续消息' }).click()
    const confirm = page.getByRole('alertdialog', { name: '删除后续消息' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 1, 20_000, '后续消息已删除')
    const truncated = await readStore(page)
    expect(truncated.session?.messages[0]?.text).toBe('请回答编辑版')

    // 重启一侧的持久化由 session-store 单测覆盖；这里确认主进程磁盘状态一致
    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, originalId)
    expect(loaded?.messages).toHaveLength(1)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r5-ui.spec.ts ──────────────────────────────────────────────
test.describe('r5-ui.spec.ts', () => {

async function dismissOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    store.setState({ onboardingOpen: false })
  })
  await page.waitForTimeout(150)
}

async function storeState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, unknown> } }).__morrowStore.getState())
}

test.describe('R5 UI 交互', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('@core:settings 设置：模型服务选择 / 对话长度 Tab / 自动整理开关', async () => {
    morrow = await launchMorrow({ name: 'r5-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore.getState().openSettings()
    })
    const dialog = page.locator('[role="dialog"]').first()
    await expect(dialog).toBeVisible()

    // 模型页只保留云端服务；本地模型统一放到「本地」页
    await dialog.getByRole('button', { name: '选择模型服务' }).click()
    const providerOptions = dialog.getByRole('option')
    expect(await providerOptions.count()).toBeGreaterThanOrEqual(11)
    for (const provider of ['DeepSeek', 'Kimi（月之暗面）', '通义千问（阿里云）', '智谱 GLM（Z.AI）', 'MiniMax', '小米 MiMo', 'Anthropic Claude', 'OpenAI', 'Google Gemini', 'xAI Grok', 'Meta（Muse）']) {
      await expect(dialog.getByText(provider, { exact: true }).first()).toBeVisible()
    }
    // OpenRouter 是中转聚合，不是官方或本地模型，不再出现在服务列表
    await expect(providerOptions.filter({ hasText: 'OpenRouter' })).toHaveCount(0)
    await expect(providerOptions.filter({ hasText: 'llama.cpp（本地）' })).toHaveCount(0)
    await expect(providerOptions.filter({ hasText: 'Ollama（本地）' })).toHaveCount(0)
    await expect(providerOptions.filter({ hasText: 'LM Studio（本地）' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '选择模型服务' }).click()
    await expect(dialog.getByText(/连接一个模型服务/)).toBeVisible()
    await expect(dialog.getByText('DeepSeek V4.1 Flash').first()).toBeVisible()
    await expect(dialog.locator('.st-provider')).toHaveCount(1)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r5-final-settings-models.png') })
    // 主题切换同步窗口/托盘图标（深色/浅色两套资产）
    expect((await page.evaluate(() => window.morrow.app.setTheme('light'))).ok).toBe(true)
    expect((await page.evaluate(() => window.morrow.app.setTheme('dark'))).ok).toBe(true)
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r5-final-settings-models-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    const pickProvider = async (label: string): Promise<void> => {
      await dialog.getByRole('button', { name: '选择模型服务' }).click()
      await dialog.getByRole('option').filter({ hasText: label }).click()
    }

    // 逐个服务检查最新模型
    const latestByProvider: Array<[string, string[]]> = [
      ['OpenAI', ['GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna']],
      ['智谱 GLM（Z.AI）', ['GLM-5.3', 'GLM-5.3 Flash']],
      ['xAI Grok', ['Grok 4.7', 'Grok 4.6']],
      ['Kimi（月之暗面）', ['Kimi K3.1 Pro', 'Kimi K3', 'Kimi K2.8 Preview']],
      ['Google Gemini', ['Gemini 4 Argon', 'Gemini 3.8 Flash']],
      ['DeepSeek', ['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro']],
      ['Anthropic Claude', ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']],
      ['小米 MiMo', ['MiMo V2.6 Pro', 'MiMo V2.6 Flash']],
      ['Meta（Muse）', ['Muse Wonder 1.0', 'Muse Spark 1.3']],
      ['MiniMax', ['MiniMax M3', 'MiniMax M3.1 Flash']],
      ['通义千问（阿里云）', ['Qwen3.8 Max', 'Qwen3.8 Flash Next']]
    ]
    for (const [provider, models] of latestByProvider) {
      await pickProvider(provider)
      for (const model of models) {
        await expect(dialog.getByText(new RegExp(model)).first()).toBeVisible()
      }
      if (provider === 'OpenAI') {
        await page.waitForTimeout(300)
        await page.screenshot({ path: screenshotPath('r5-final-settings-models-openai.png') })
      }
      if (provider === 'xAI Grok') {
        await expect(dialog.getByText(/Grok 4\.1/)).toHaveCount(0)
      }
      if (provider === 'Kimi（月之暗面）') {
        await expect(dialog.getByText(/Kimi K2\.7|Kimi K2\.6/)).toHaveCount(0)
        await page.waitForTimeout(250)
        await page.screenshot({ path: screenshotPath('r25-settings-xai-models.png') })
      }
    }
    await expect(dialog.getByText('Qwen Plus')).toHaveCount(0)
    await expect(dialog.getByText('MiniMax M2.5')).toHaveCount(0)
    // 回到默认 provider，保持默认模型卡片与顶部一致
    await pickProvider('DeepSeek')

    // 上下文 Tab
    await dialog.locator('#st-tab-context').click()
    await expect(dialog.getByText('自动整理').first()).toBeVisible()
    const compactSwitch = dialog.locator('[role="switch"]').first()
    await expect(compactSwitch).toBeVisible()
    const before = (await storeState(page)).settings as { autoCompact: boolean }
    await compactSwitch.click()
    await page.waitForTimeout(400)
    const after = (await storeState(page)).settings as { autoCompact: boolean }
    expect(after.autoCompact).toBe(!before.autoCompact)
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('r5-final-settings-context.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r5-final-settings-context-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
  })
})

})
})

test.describe("04-modes", () => {
// ── 原文件：plan-mode.spec.ts ──────────────────────────────────────────────
test.describe('plan-mode.spec.ts', () => {
/**
 * P0-2 计划模式 E2E：
 * - /plan 进入计划模式并生成计划卡（只读工具运行，不写文件）；
 * - 拒绝 → 重新规划 → 生成修订版计划；
 * - 批准 → 自动切执行、写入 todo 与产物，完成后计划标记 completed 且持久化。
 */

function getPlan(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { plan?: Record<string, any> | null; planMode?: boolean } | null } }
    }).__morrowStore
    return store.getState().session?.plan ?? null
  })
}

function getPlanMode(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { planMode?: boolean } | null } }
    }).__morrowStore
    return store.getState().session?.planMode === true
  })
}

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

const planV1 = {
  title: '整理销售数据并生成报告',
  summary: '读取 in/sales.csv，核对总额，再生成一份可直接分享的报告。',
  steps: [
    { text: '读取 in/sales.csv 并核对总销售额' },
    { text: '按月份汇总并检查异常值' },
    { text: '生成 out/report.md 并在画布打开' }
  ],
  risks: '如果 CSV 缺少月份列，需要先向用户确认口径。'
}

const planV2 = {
  title: '先出 Markdown 摘要，再生成报告',
  summary: '按用户意见先输出 Markdown 摘要，确认后再生成完整报告。',
  steps: [
    { text: '读取 in/sales.csv 并核对总销售额' },
    { text: '输出 out/summary.md 月度摘要' },
    { text: '生成 out/report.md 完整报告' }
  ]
}

test('@core:modes 计划模式：/plan 生成 → 拒绝 → 修订 → 批准执行并持久化', async () => {
  test.setTimeout(240_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '我先看一下工作区。', toolCalls: [{ name: 'submit_plan', arguments: planV1 }] },
      { text: '计划已就绪，等待你的批准。' },
      { text: '按你的意见重做计划。', toolCalls: [{ name: 'submit_plan', arguments: planV2 }] },
      { text: '修订后的计划已就绪。' },
      {
        text: '开始执行。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step) => ({ text: step.text, status: 'pending' }))
            }
          },
          {
            name: 'write_file',
            arguments: {
              path: 'out/report.md',
              content: '# 销售报告\n\n总销售额：100\n'
            }
          }
        ]
      },
      {
        text: '先完成前两步，第三步还需要一次运行。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step, index) => ({
                text: step.text,
                status: index < 2 ? 'completed' : 'pending'
              }))
            }
          }
        ]
      },
      { text: '前两步完成，继续执行第三步。' }
    ]
  })
  const workspace = workspaceAt('e2e-plan-mode')
  const morrow = await launchMorrow({ name: 'plan-mode', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划模式测试'
    })

    // 1) /plan + 任务：先给出提示并保留输入；发送带任务的 /plan 后进入计划模式
    await page.locator('.composer-input').fill('/plan')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('/plan ')
    expect(await getPlanMode(page)).toBe(false)
    await page.locator('.composer-input').fill('/plan 帮我整理这个季度的销售数据并生成报告')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => getPlanMode(page), 30_000, '进入计划模式')
    await waitUntil(async () => {
      const plan = await getPlan(page)
      return plan?.status === 'pending' ? plan : null
    }, 60_000, '生成待批准计划')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '计划生成运行结束')

    const planCard = page.locator('.plan-card')
    await expect(planCard).toBeVisible()
    await expect(planCard).toContainText('整理销售数据并生成报告')
    await expect(planCard).toContainText('读取 in/sales.csv')
    await expect(page.locator('[aria-label="退出计划模式"]')).toBeVisible()
    expect(existsSync(join(workspace, 'out', 'report.md'))).toBe(false)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('plan-card-pending-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('plan-card-pending-light.png') })
    await setThemeViaStore(page, 'dark')

    // 2) 拒绝并留下原因
    await planCard.getByRole('button', { name: '拒绝' }).click()
    await planCard.locator('.plan-card-input').fill('先不要直接生成 HTML，先给 Markdown 摘要。')
    await planCard.getByRole('button', { name: '确认拒绝' }).click()
    await waitUntil(async () => (await getPlan(page))?.status === 'rejected', 15_000, '计划被拒绝')
    await expect(planCard).toContainText('你的反馈：先不要直接生成 HTML')
    expect(await getPlanMode(page)).toBe(true)

    // 3) 重新规划：带修改意见启动一轮，收到修订版计划
    await planCard.getByRole('button', { name: '重新规划' }).click()
    await planCard.locator('.plan-card-input').fill('改成先输出 Markdown 摘要，再生成完整报告。')
    await planCard.getByRole('button', { name: '重新规划' }).click()
    await waitUntil(async () => {
      const plan = await getPlan(page)
      return plan?.status === 'pending' && plan.title === planV2.title ? plan : null
    }, 60_000, '生成修订版计划')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '修订运行结束')
    await expect(planCard).toContainText('先出 Markdown 摘要')

    // 4) 只读权限下批准应被明确拦下，计划保持待批准
    await page.evaluate(async (id) => {
      await window.morrow.session.setPermissionMode(id, 'read-only')
    }, sessionId)
    await planCard.getByRole('button', { name: '执行计划' }).click()
    await expect(page.getByText(/当前权限是「只读」/)).toBeVisible()
    expect((await getPlan(page))?.status).toBe('pending')
    expect(await getPlanMode(page)).toBe(true)
    await page.evaluate(async (id) => {
      await window.morrow.session.setPermissionMode(id, 'auto')
    }, sessionId)

    // 5) 批准：自动切执行，写入 todo + 产物；子集完成不能把计划判为完成
    await planCard.getByRole('button', { name: '执行计划' }).click()
    await waitUntil(async () => !(await getPlanMode(page)), 15_000, '批准后退出计划模式')
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.session?.todos.length === planV2.steps.length ? state.session.todos : null
    }, 30_000, '批准后建立 todos')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮执行结束')
    expect((await getPlan(page))?.status).toBe('executing')
    await expect(planCard).toContainText('继续执行')
    expect((await readStore(page)).session?.todos.filter((todo) => todo.status === 'completed')).toHaveLength(2)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.screenshot({ path: screenshotPath('plan-card-incomplete-dark.png') })

    const planRequestNames = (
      (mock.requests[0].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name)
    const executionRequestNames = (
      (mock.requests[4].body as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
    ).map((tool) => tool.function?.name)

    // 手动「继续执行」：重新提供完成剩余步骤的剧本（第一轮结束时的 todo 对账已用尽原剧本）。
    mock.reset([
      {
        text: '继续执行最后一步。',
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: planV2.steps.map((step) => ({ text: step.text, status: 'completed' }))
            }
          }
        ]
      },
      { text: '执行完成，产物在 out/report.md。' }
    ])
    await planCard.getByRole('button', { name: '继续执行' }).click()
    await waitUntil(async () => (await getPlan(page))?.status === 'completed', 60_000, '继续执行后计划完成')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '执行运行结束')

    expect(existsSync(join(workspace, 'out', 'report.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'out', 'report.md'), 'utf8')).toContain('销售报告')
    const finalTodos = (await readStore(page)).session?.todos ?? []
    expect(finalTodos).toHaveLength(planV2.steps.length)
    expect(finalTodos.every((todo) => todo.status === 'completed')).toBe(true)
    await expect(planCard).toContainText('已完成')
    await page.screenshot({ path: screenshotPath('plan-card-complete-dark.png') })

    // 6) 持久化：重新加载会话后计划与状态仍在
    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.plan?.status).toBe('completed')
    expect(loaded?.plan?.title).toBe(planV2.title)
    expect(loaded?.planMode === true).toBe(false)

    // 模型请求：计划请求只暴露只读/计划工具，执行请求恢复写入工具
    expect(planRequestNames).toContain('submit_plan')
    expect(planRequestNames).not.toContain('write_file')
    expect(executionRequestNames).toContain('write_file')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：r6-goal.spec.ts ──────────────────────────────────────────────
test.describe('r6-goal.spec.ts', () => {

async function getGoal(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => (window as unknown as {
    __morrowStore: { getState: () => { session: { goal?: Record<string, any> | null } | null } }
  }).__morrowStore.getState().session?.goal ?? null)
}

async function createSessionWithModel(
  page: Page,
  model: { providerId: string; modelId: string }
): Promise<{ sessionId: string; workspace: string }> {
  return page.evaluate(async (modelRef) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const workspace = await window.morrow.workspace.createDemo()
    if (!workspace.ok) throw new Error('createDemo 失败')
    const created = await window.morrow.session.create({
      workspace: workspace.data.path,
      model: modelRef,
      permissionMode: 'auto',
      title: 'Goal E2E'
    })
    if (!created.ok) throw new Error('session.create 失败')
    await store.getState().selectSession(created.data.id)
    return { sessionId: created.data.id, workspace: workspace.data.path }
  }, model)
}

test.describe('R6 Goal 模式 / 画布调宽', () => {
  let morrow: MorrowApp | null = null
  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
  })

  test('@core:goals Mock LLM：目标多轮续跑（round 1 active → round 2 completed）', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        {
          text: '第 1 轮：写入产物并记录推进摘要。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'goal-part1.md', content: '# Round 1\n骨架完成\n' } },
            { name: 'update_goal', arguments: { status: 'active', summary: '第 1 轮完成：写出 goal-part1.md', nextStep: '第 2 轮补充 goal-part2.md 并验收' } }
          ]
        },
        { text: '第 1 轮结束，等待系统续跑。' },
        {
          text: '第 2 轮：写入收尾产物并标记完成。',
          toolCalls: [
            { name: 'write_file', arguments: { path: 'goal-part2.md', content: '# Round 2\n验收完成\n' } },
            { name: 'update_goal', arguments: { status: 'completed', summary: '两轮全部完成，goal-part1.md 与 goal-part2.md 已写入并验收', evidence: ['goal-part1.md', 'goal-part2.md'] } }
          ]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'r6-goal-mock', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('分两轮完成一份验证目标模式的笔记，每轮只推进一个阶段。', 3))
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal && (goal.status === 'completed' || goal.status === 'blocked' || goal.status === 'paused') ? goal : null
      }, 90_000, '目标进入终态')
      const goal = await getGoal(page)
      expect(goal?.status).toBe('completed')
      expect(goal?.round).toBe(2)
      const events = await getEvents(page)
      const goalEvents = events.filter((event) => event.type === 'goal_updated')
      expect(goalEvents.length).toBeGreaterThanOrEqual(2)
      expect(events.some((event) => event.type === 'tool_started' && (event as any).block?.name === 'update_goal')).toBe(true)
      expect(events.filter((event) => event.type === 'tool_finished' && JSON.stringify((event as any).result).includes('目标状态已更新')).length).toBeGreaterThanOrEqual(2)
      const state = await readStore(page)
      expect(state.run).toBeNull()
      await page.screenshot({ path: screenshotPath('r6-final-goal-mock-completed.png') })
    } finally {
      await mock.close()
    }
  })

  test('@core:goals Mock LLM：暂停/继续/结束的终态不被旧 run 覆盖', async () => {
    test.setTimeout(120_000)
    const mock = await startMockLLM({
      scripts: [
        { text: '先暂停我。', delayMs: 4000 },
        {
          text: '继续后完成目标。',
          toolCalls: [{ name: 'update_goal', arguments: { status: 'completed', summary: '恢复后已完成' } }]
        },
        { text: '目标已完成。' }
      ]
    })
    morrow = await launchMorrow({ name: 'r6-goal-pause', waitForSelector: '.sidebar' })
    const { page } = morrow
    try {
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSessionWithModel(page, provider)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { startGoal: (o: string, n?: number) => Promise<void> } }
      }).__morrowStore.getState().startGoal('验证暂停与继续。', 3))
      await waitForRunStarted(page, 30_000)
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { pauseGoal: () => Promise<void> } }
      }).__morrowStore.getState().pauseGoal())
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal?.status === 'paused' ? goal : null
      }, 30_000, '目标暂停')
      await waitUntil(async () => (await readStore(page)).run === null, 30_000, '暂停后 run 收尾')
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { resumeGoal: () => Promise<void> } }
      }).__morrowStore.getState().resumeGoal())
      await waitUntil(async () => {
        const goal = await getGoal(page)
        return goal?.status === 'active' && goal.round === 2 ? goal : null
      }, 60_000, '继续后进入第 2 轮')
      await page.evaluate(() => (window as unknown as {
        __morrowStore: { getState: () => { stopGoal: () => Promise<void> } }
      }).__morrowStore.getState().stopGoal())
      await page.waitForTimeout(1500)
      const afterStop = await getGoal(page)
      // 手动「结束目标」是取消，不是完成；且旧 run 迟到回调必须保持 cancelled
      expect(afterStop?.status).toBe('cancelled')
    } finally {
      await mock.close()
    }
  })
})

})
// ── 原文件：r8-mode.spec.ts ──────────────────────────────────────────────
test.describe('r8-mode.spec.ts', () => {
/**
 * R8 #5 显式「聊天 / 工作」模式 E2E —— 真实 Electron + 真实主进程 + 真实工具执行，LLM 用本地 mock。
 *
 * 验收（审计报告第 5 项）：
 * 1. 同一句「帮我改文件」在聊天模式：模型**即使硬发 write_file**也被内核硬拦截（denied）、
 *    文件不变、不弹审批、助手解释/询问是否切换工作模式；下发给模型的工具列表本身不含写入/执行工具。
 * 2. 切到工作模式后同一句：工具真实执行、文件真实写入。
 * 3. 运行中切换模式被拒绝并提示先停止（不会带着工作模式能力继续）。
 * 4. 聊天模式下 Goal 入口在 UI 中不可用，IPC `goal.start` 也被主进程拒绝（不是只隐藏按钮）。
 * 5. 模式写入会话文件，关闭应用后用同一 data-dir 重启仍保持聊天模式。
 *
 * 所有断言都落在四层证据上：运行时事件 / store 状态 / DOM / 磁盘文件。
 */

const WORKSPACE_FILE = 'mode-note.md'
const USER_ASK = '帮我修改 mode-note.md，把内容改成 CHANGED。'

type SessionMode = 'work' | 'chat'

async function sessionMode(page: Page): Promise<SessionMode> {
  return page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const mode = store.getState().session?.mode
    return mode === 'chat' ? 'chat' : 'work'
  })
}

async function waitMode(page: Page, mode: SessionMode, timeoutMs = 20_000): Promise<void> {
  await waitUntil(async () => ((await sessionMode(page)) === mode ? true : null), timeoutMs, `会话模式变为 ${mode}`)
}

/** 注册指向本地 mock 的 provider（test-mode 下 127.0.0.1 允许无 Key） */
async function saveMockProvider(page: Page, baseUrl: string): Promise<{ providerId: string; modelId: string }> {
  return page.evaluate(
    async (url: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const config = {
        id: 'mock-r8-mode',
        kind: 'openai-compat',
        name: '本地 Mock (R8 模式)',
        baseUrl: url,
        models: [{ id: 'mock-model', label: 'Mock Model', contextWindow: 32_000, supportsTools: true }],
        apiKeyStored: false,
        enabled: true
      }
      await store.getState().saveProvider({ config })
      const saved = (store.getState().settings.providers as Array<Record<string, any>>).find(
        (provider) => provider.id === config.id
      )
      if (!saved) throw new Error('mock provider 保存失败')
      return { providerId: config.id, modelId: 'mock-model' }
    },
    baseUrl
  )
}

async function createModeSession(
  page: Page,
  arg: { workspace: string; providerId: string; mode: SessionMode }
): Promise<string> {
  return page.evaluate(async (input: typeof arg) => {
    const created = await window.morrow.session.create({
      workspace: input.workspace,
      model: { providerId: input.providerId, modelId: 'mock-model' },
      permissionMode: 'auto',
      mode: input.mode,
      title: 'R8 模式测试'
    })
    if (!created.ok) throw new Error(`session.create 失败：${created.error.message}`)
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().selectSession(created.data.id)
    return created.data.id
  }, arg)
}

test.describe('R8 #5 显式聊天 / 工作模式', () => {
  test('@core:modes chat 硬拦截写入（文件不变）→ 切 work 真实写入 → 运行中拒绝切换 → Goal 不可用 → 重启保持', async () => {
    test.setTimeout(300_000)
    const stamp = Date.now()
    const workspace = join(root, 'tmp', `r8-mode-ws-${stamp}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'a.txt'), 'hello', 'utf8')
    const dataDir = join(root, 'tmp', `r8-mode-data-${stamp}`)
    const chromiumDir = join(root, 'tmp', `r8-mode-chromium-${stamp}`)

    // 记录每次请求下发给模型的工具列表：chat 下必须不含写入/执行工具
    const requests: Array<{ toolNames: string[]; lastUserText: string }> = []
    const mock = await startMockLLM({
      respond: (ctx) => {
        const toolNames = ((ctx.body?.tools ?? []) as Array<Record<string, any>>)
          .map((tool) => String(tool?.function?.name ?? tool?.name ?? ''))
          .filter(Boolean)
        requests.push({ toolNames, lastUserText: String(ctx.lastUserMessageText ?? '') })
        const step = requests.length - 1
        if (step === 0) {
          // 聊天模式第一回合：故意硬发 write_file（工具列表里并没有它），验证权限层硬拦截
          return {
            text: '我先看一下这个文件。',
            toolCalls: [{ name: 'write_file', arguments: { path: WORKSPACE_FILE, content: 'CHANGED' } }]
          }
        }
        if (step === 1) {
          return {
            text: '这是聊天模式：我不会直接改文件。需要我动手的话，请把输入框旁的「聊天 / 工作」切到「工作」。'
          }
        }
        if (step === 2) {
          // 工作模式第一回合：写文件（permission=auto，工作区内直接执行）
          return {
            text: '好，我在工作模式里改。',
            toolCalls: [{ name: 'write_file', arguments: { path: WORKSPACE_FILE, content: 'CHANGED' } }]
          }
        }
        // 工作模式第二回合：延迟一下，留出「运行中尝试切换模式」的窗口
        return { text: '文件已写入 mode-note.md。', delayMs: 1500 }
      }
    })

    const first = await launchMorrow({ name: 'r8-mode-1', dataDir, chromiumDir, timeoutMs: 90_000 })
    let sessionId = ''
    try {
      const { page } = first
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)

      const provider = await saveMockProvider(page, mock.openaiBaseUrl)
      sessionId = await createModeSession(page, { workspace, providerId: provider.providerId, mode: 'chat' })
      expect(await sessionMode(page)).toBe('chat')

      /* ── 1) UI 进入聊天模式：分段控件/只读 chip/placeholder/titlebar chip，Goal 入口隐藏 ── */
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-picker-perm')).toHaveCount(0)
      await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /聊天模式/)
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)

      /* ── 2) Goal 入口不可用：不只是隐藏按钮，IPC 也被主进程拒绝 ── */
      const goalAttempt = await page.evaluate(async (sid: string) => {
        const result = await window.morrow.goal.start({ sessionId: sid, objective: '帮我做一份季度报告' })
        return result.ok ? { ok: true } : { ok: false, message: result.error.message }
      }, sessionId)
      expect(goalAttempt.ok).toBe(false)
      expect(goalAttempt.message).toContain('聊天模式')
      await page.screenshot({ path: screenshotPath('r8-mode-chat-composer.png') })

      /* ── 3) 聊天模式下发同一句改文件请求：工具被硬拦截、文件不变、助手解释 ── */
      await clearEvents(page)
      await sendMessageViaStore(page, USER_ASK)
      await waitForRunStarted(page, 30_000)
      const chatFinished = await waitForRunFinished(page, 60_000)
      expect(chatFinished.reason).toBe('complete')

      const chatEvents = await getEvents(page)
      expect(chatEvents.filter((event) => event.type === 'permission_requested')).toEqual([])
      const chatTools = chatEvents.filter((event) => event.type === 'tool_finished')
      expect(chatTools.length).toBeGreaterThanOrEqual(1)
      for (const event of chatTools) {
        expect(event.denied, `聊天模式工具不应放行：${JSON.stringify(event)}`).toBe(true)
        expect((event.result as { ok?: boolean } | undefined)?.ok).toBe(false)
      }
      expect(existsSync(join(workspace, WORKSPACE_FILE))).toBe(false)
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello')

      // 下发给模型的工具本身就不含写入/执行：不是「工具列表给了、执行才拦」
      expect(requests[0].toolNames).toContain('read_file')
      expect(requests[0].toolNames).toContain('ask_user')
      expect(requests[0].toolNames).not.toContain('write_file')
      expect(requests[0].toolNames).not.toContain('remove_file')
      expect(requests[0].toolNames).not.toContain('run_command')
      expect(requests[0].toolNames).not.toContain('update_goal')
      // 泛化断言：聊天模式工具列表里不允许出现任何写入/执行/记忆/目标/计划/集群成员类工具
      for (const name of requests[0].toolNames) {
        expect(name, `聊天模式不应下发 ${name}`).not.toMatch(
          /^(write_|edit_|run_command|remember$|update_goal$|todo_write$|task$|open_artifact$)/
        )
      }

      // 助手解释或询问是否切到工作模式
      const chatState = await readStore(page)
      const chatText =
        chatState.session?.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.text)
          .join('\n') ?? ''
      expect(chatText).toContain('聊天模式')
      expect(chatText).toContain('工作')
      await page.screenshot({ path: screenshotPath('r8-mode-chat-denied.png') })

      /* ── 4) 真实 UI 切到工作模式：权限下拉回来、Goal 入口回来 ── */
      await page.locator('.composer-picker-mode').getByRole('radio', { name: '工作' }).click()
      await waitMode(page, 'work')
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('工作')
      await expect(page.locator('.composer-picker-perm')).toHaveCount(1)
      await expect(page.locator('.composer-perm-lock')).toHaveCount(0)
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(1)

      /* ── 5) 工作模式同一句：真实写入；运行中尝试切 chat 被拒绝 ── */
      await clearEvents(page)
      await sendMessageViaStore(page, USER_ASK)
      await waitForRunStarted(page, 30_000)
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        void store.getState().setSessionMode('chat')
      })
      await waitUntil(
        async () => {
          const state = await readStore(page)
          return state.toast?.kind === 'warning' && /停止|切换/.test(state.toast.message) ? true : null
        },
        15_000,
        '运行中切换模式被拒绝的提示'
      )
      expect(await sessionMode(page)).toBe('work')

      const workFinished = await waitForRunFinished(page, 60_000)
      expect(workFinished.reason).toBe('complete')
      await waitUntil(async () => (existsSync(join(workspace, WORKSPACE_FILE)) ? true : null), 15_000, '工作模式写入文件')
      expect(readFileSync(join(workspace, WORKSPACE_FILE), 'utf8')).toBe('CHANGED')

      const workEvents = await getEvents(page)
      const okTools = workEvents.filter(
        (event) =>
          event.type === 'tool_finished' &&
          (event.result as { ok?: boolean } | undefined)?.ok === true &&
          event.denied !== true
      )
      expect(okTools.length).toBeGreaterThanOrEqual(1)
      expect(requests[2].toolNames).toContain('write_file')
      expect(requests[2].toolNames).toContain('run_command')
      await page.screenshot({ path: screenshotPath('r8-mode-work-write.png') })

      /* ── 6) 切回聊天：模式写入会话文件（重启保持的证据） ── */
      await page.locator('.composer-picker-mode').getByRole('radio', { name: '聊天' }).click()
      await waitMode(page, 'chat')
      const persisted = JSON.parse(readFileSync(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8')) as {
        mode?: string
      }
      expect(persisted.mode).toBe('chat')
    } finally {
      await first.close()
    }

    /* ── 7) 关闭后用同一 data-dir 重启：模式保持聊天，Goal 入口仍不可用 ── */
    const second = await launchMorrow({ name: 'r8-mode-2', dataDir, chromiumDir, timeoutMs: 90_000 })
    try {
      const { page } = second
      await waitForStoreReady(page)
      await waitMode(page, 'chat')
      await expect(page.locator('.composer-picker-mode .segmented-item.is-active')).toHaveText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)
      await page.screenshot({ path: screenshotPath('r8-mode-restart-persist.png') })
    } finally {
      await second.close()
      await mock.close()
    }
  })
})

})
})

test.describe("09-panels", () => {
// ── 原文件：a1-projects-home.spec.ts ──────────────────────────────────────────────
test.describe('a1-projects-home.spec.ts', () => {
/**
 * A1 项目主页与项目内会话（合并进原工作台 ProjectsPanel）：
 * 概览页展示真实项目背景、项目内对话列表；从项目里输入首句会创建带该工作区的会话并注入项目上下文。
 */

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function sameWorkspace(a: string | null, b: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!a && norm(a) === norm(b)
}

test.describe('A1 项目主页', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('@core:projects 概览展示项目背景；首句在项目工作区创建会话并注入说明与资料', async () => {
    test.setTimeout(180_000)
    const workspace = makeDir('a1-project-ws')
    writeFileSync(join(workspace, 'brief.md'), '# 项目资料\nA1_CANARY_KNOWLEDGE：这是项目内的资料。', 'utf8')
    mock = await startMockLLM({ scripts: [{ text: '好的，我已经按项目背景开始。' }] })

    morrow = await launchMorrow({ name: 'a1-project-home', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ autoTitle: false, lastWorkspace: null })
    })
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({
        defaultModel: { providerId: model.providerId, modelId: model.modelId }
      })
    }, provider)

    const created = await page.evaluate(
      async (arg: { workspace: string }) => {
        const result = await window.morrow.features.invoke<{ id: string }>('feature:projects:create', {
          workspace: arg.workspace,
          name: 'A1 项目主页测试',
          description: '验证项目概览与项目内对话。',
          instructions: 'A1 项目指令：回答前先参考项目资料。',
          knowledgePaths: ['brief.md'],
          active: true
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.data
      },
      { workspace }
    )
    expect(created.id).toBeTruthy()
    const toastClose = page.locator('.toast-close').first()
    if (await toastClose.isVisible().catch(() => false)) await toastClose.click()

    // 打开同一个工作台项目面板（概览是默认视图）
    await page.getByRole('button', { name: '打开项目主页' }).click()
    await expect(page.locator('.pp-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.pp-tabs button.is-active')).toHaveCSS('height', '24px')
    await expect(page.locator('.pp-tabs button.is-active')).toHaveCSS('border-radius', '5px')
    await expect(page.locator('.pp-home-title')).toHaveText('A1 项目主页测试')
    await expect(page.locator('.pp-home-desc')).toContainText('验证项目概览')
    await expect(page.locator('.pp-home-meta')).toContainText('1 份资料')
    await expect(page.locator('.pp-home-cards')).toContainText('A1 项目指令：回答前先参考项目资料。')
    await expect(page.locator('.pp-home-cards')).toContainText('brief.md')
    await expect(page.locator('.pp-home-recent')).toContainText('这里还没有对话')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 从项目里发第一句 → 真实创建项目工作区会话
    await installEventCollector(page)
    const prompt = '把项目资料读一遍，然后告诉我项目要做什么。'
    const composer = page.locator('.pp-home-composer textarea')
    await composer.fill(prompt)
    await composer.press('Enter')
    await expect(page.locator('.pp-root')).toHaveCount(0, { timeout: 15_000 })
    await waitForRunFinished(page, 90_000)

    const store = await readStore(page)
    expect(store.session?.workspace && sameWorkspace(store.session.workspace, workspace)).toBe(true)
    expect(store.session?.messages.some((message) => message.role === 'user' && message.text.includes('项目资料读一遍'))).toBe(true)

    // 真实请求体里带上了项目说明与资料（system prompt）；跳过可能的连接探测请求
    const firstBody = (mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('项目资料读一遍')
    )?.body ?? {}) as { messages?: Array<{ role: string; content: unknown }> }
    const sys = JSON.stringify(firstBody.messages?.[0]?.content ?? '')
    expect(sys).toContain('A1 项目指令')
    expect(sys).toContain('A1_CANARY_KNOWLEDGE')

    // 再开概览：项目内对话已计入并可直接打开
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'projects' } }))
    })
    await expect(page.locator('.pp-home-recent')).toContainText('项目资料读一遍', { timeout: 15_000 })
    await expect(page.locator('.pp-home-meta')).toContainText('1 段对话')
    await expect(page.locator('.pp-project')).toContainText('1 对话')
    await page.locator('.modal-panel').filter({ has: page.locator('.pp-home') }).screenshot({
      path: screenshotPath('a1-project-home-with-chat.png')
    })

    // 项目内对话可直接打开主窗口里的同一条会话
    await page.locator('.pp-home-sessions button').first().click()
    await expect(page.locator('.pp-root')).toHaveCount(0)
    await expect(page.getByText('好的，我已经按项目背景开始。')).toBeVisible({ timeout: 30_000 })
  })
})

})
// ── 原文件：a2-schedules.spec.ts ──────────────────────────────────────────────
test.describe('a2-schedules.spec.ts', () => {
/**
 * A2 定时任务：
 * 1) 面板创建任务 → 立即运行 → 真实会话/回复/状态回写 → 查看结果 → 暂停/删除；
 * 2) 应用关闭期间到期的任务，在下次启动（1 小时内）自动补跑并回写结果。
 */

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function openSchedulesPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'schedules' } }))
  })
  await expect(page.locator('.sch-root')).toBeVisible({ timeout: 15_000 })
}

test.describe('A2 定时任务', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    mock = null
  })

  test('@core:schedules 创建任务、立即运行、查看结果、暂停与删除', async () => {
    test.setTimeout(180_000)
    mock = await startMockLLM({ scripts: [{ text: '周报已经整理好了：本周完成三件事。' }] })
    morrow = await launchMorrow({ name: 'a2-schedules', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await page.evaluate(async (model: { providerId: string; modelId: string }) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ defaultModel: { providerId: model.providerId, modelId: model.modelId } })
    }, provider)
    const workspace = makeDir('a2-schedules-ws')
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'A2 定时任务基础会话'
    })

    await openToolPanel(page, '定时任务')
    await expect(page.locator('.sch-root')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sch-title')).toHaveText('安排一件新事情')
    await page.getByLabel('任务名称').fill('每周项目周报')
    await page.getByLabel('要做什么').fill('整理本周新增的文件与改动，写一份三条以内的周报。')
    await expect(page.getByLabel('任务名称')).toHaveValue('每周项目周报')
    await expect(page.getByLabel('要做什么')).toHaveValue(/整理本周新增/)
    // 默认每天、下一小时执行；工作区自动继承当前会话文件夹
    await expect(page.locator('.sch-workspace-path')).toContainText('a2-schedules-ws')
    await expect(page.locator('.sch-preview').filter({ hasText: '下一次：' })).toBeVisible()
    await page.getByRole('button', { name: '保存定时任务' }).click()
    await expect(page.locator('.sch-notice')).toContainText('定时任务已创建')
    await expect(page.locator('.sch-task')).toContainText('每周项目周报')
    await expect(page.locator('.sch-task')).toContainText('每天')
    const toastClose = page.locator('.toast-close').first()
    if (await toastClose.isVisible().catch(() => false)) await toastClose.click()
    await page.locator('.modal-panel').filter({ has: page.locator('.sch-root') }).screenshot({
      path: screenshotPath('a2-schedules.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.sch-root') }).screenshot({
      path: screenshotPath('a2-schedules-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 立即运行 → Agent 真实回复 → 状态回写
    await installEventCollector(page)
    await page.getByRole('button', { name: '立即运行' }).click()
    await waitForRunFinished(page, 90_000)
    await expect(page.locator('.sch-status')).toContainText('上次成功', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: '查看上次结果' })).toBeVisible()
    const scheduledRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('整理本周新增的文件与改动')
    )
    expect(JSON.stringify(scheduledRequest?.body ?? {})).toContain('## 回答风格（全局偏好）')

    // 任务产生的真实会话
    const tasksFile = join(morrow.dataDir, 'schedules', 'tasks.json')
    const stored = JSON.parse(readFileSync(tasksFile, 'utf8')) as {
      tasks: Array<{ title: string; lastStatus: string; lastSessionId?: string; lastRunAt: number }>
    }
    const saved = stored.tasks.find((task) => task.title === '每周项目周报')
    expect(saved?.lastStatus).toBe('success')
    expect(saved?.lastSessionId).toBeTruthy()

    await page.getByRole('button', { name: '查看上次结果' }).click()
    await expect(page.locator('.sch-root')).toHaveCount(0)
    await expect(page.getByText('周报已经整理好了：本周完成三件事。')).toBeVisible({ timeout: 30_000 })

    // 暂停 → 不自动运行；再启用；最后删除
    await openSchedulesPanel(page)
    await page.locator('.sch-task').filter({ hasText: '每周项目周报' }).click()
    const enableSwitch = page.getByRole('switch', { name: '启用自动执行' })
    await expect(enableSwitch).toHaveAttribute('aria-checked', 'true')
    await enableSwitch.click()
    await expect(page.locator('.sch-notice')).toContainText('已暂停')
    await expect(page.locator('.sch-task')).toContainText('暂停')
    await enableSwitch.click()
    await expect(page.locator('.sch-notice')).toContainText('已启用')

    await page.locator('.sch-actions').getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.locator('.sch-confirm')).toBeVisible()
    await page.locator('.sch-confirm').getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.sch-notice')).toContainText('已删除')
    await expect(page.locator('.sch-task')).toHaveCount(0)
    const afterDelete = JSON.parse(readFileSync(tasksFile, 'utf8')) as { tasks: unknown[] }
    expect(afterDelete.tasks).toHaveLength(0)
  })
})

})
// ── 原文件：a4-research.spec.ts ──────────────────────────────────────────────
test.describe('a4-research.spec.ts', () => {
/**
 * A4 深度研究模式：
 * - 切到研究模式后，真实执行多轮 web_search，来源不足自动续研；
 * - 最终产出带引用的 Markdown 报告（画布成品），进度条如实显示轮次/来源；
 * - 自动续研的内部提示不展示为用户气泡；
 * - 未配置联网搜索时明确拒绝，不伪造研究。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function dismissToasts(page: import('@playwright/test').Page): Promise<void> {
  const close = page.locator('.toast-close')
  for (let index = 0; index < 6; index += 1) {
    if ((await close.count()) === 0) return
    await close.first().click().catch(() => undefined)
    await page.waitForTimeout(80)
  }
}

async function startResearchSearch(): Promise<{ baseUrl: string; server: Server; queries: string[] }> {
  const queries: string[] = []
  const resultsFor: Record<string, Array<{ title: string; url: string; content: string; engine: string }>> = {
    first: [
      { title: '来源 A', url: 'https://example.com/a', content: '第一篇资料。', engine: 'mock' },
      { title: '来源 B', url: 'https://example.com/b', content: '第二篇资料。', engine: 'mock' }
    ],
    second: [
      { title: '来源 A', url: 'https://example.com/a', content: '第一篇资料。', engine: 'mock' },
      { title: '来源 C', url: 'https://example.com/c', content: '第三篇资料。', engine: 'mock' },
      { title: '来源 D', url: 'https://example.com/d', content: '第四篇资料。', engine: 'mock' }
    ]
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.endsWith('/search')) {
      const query = url.searchParams.get('q') ?? ''
      queries.push(query)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: query.includes('补充') ? resultsFor.second : resultsFor.first }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, server, queries }
}

const REPORT = [
  '# 深度研究报告：Morrow 研究能力',
  '',
  '## 关键结论',
  '- Morrow 是一个本地 AI 工作伙伴 [1]。',
  '- 它会保留来源并在报告中给出可核对链接 [2][3]。',
  '',
  '## 局限',
  '- 本次测试使用模拟检索服务。',
  '',
  '## 参考来源',
  '[1] https://example.com/a',
  '[2] https://example.com/b',
  '[3] https://example.com/c'
].join('\n')

const PLAN = [
  '# 研究计划：Morrow 深度研究能力',
  '',
  '## 研究目标',
  '确认 Morrow 深度研究的多轮检索、来源核对与报告交付能力。',
  '',
  '## 范围与假设',
  '- 以公开资料为主；优先 2026 年信息。',
  '',
  '## 子问题',
  '1. 它如何拆解研究问题？',
  '2. 它如何记录独立来源并自动补查？',
  '3. 它如何交付带引用的报告？',
  '',
  '## 检索策略',
  '- 两组不同关键词；至少 4 个独立来源。',
  '',
  '## 报告结构',
  '- 摘要、关键结论、证据与分歧、局限、参考来源。',
  '',
  '## 需要确认',
  '- 无。'
].join('\n')

test.describe('A4 深度研究模式', () => {
  let morrow: MorrowApp
  let mock: Awaited<ReturnType<typeof startMockLLM>> | null = null
  let search: Awaited<ReturnType<typeof startResearchSearch>> | null = null

  test.afterEach(async () => {
    await morrow?.close()
    await mock?.close()
    await new Promise<void>((resolve) => (search ? search.server.close(() => resolve()) : resolve()))
    mock = null
    search = null
  })

  test('@core:research 多轮检索自动补查 → 带引用报告与真实来源面板；内部补查不显示为气泡', async () => {
    test.setTimeout(180_000)
    search = await startResearchSearch()
    mock = await startMockLLM({
      scripts: [
        { text: PLAN },
        { text: '先检索第一批资料。', delayMs: 2_500, toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 研究能力 第一轮', max_results: 5 } }] },
        { text: '初步结论：还需要更多来源与正式报告。' },
        { text: '补充检索不同角度。', toolCalls: [{ name: 'web_search', arguments: { query: 'Morrow 研究能力 补充检索', max_results: 5 } }] },
        {
          text: '资料已经足够，整理研究报告。',
          toolCalls: [{ name: 'open_artifact', arguments: { title: '研究报告：Morrow 研究能力', kind: 'markdown', content: REPORT } }]
        },
        { text: '研究报告已经放到画布。' }
      ]
    })
    morrow = await launchMorrow({ name: 'a4-research', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const configuredSearch = await page.evaluate(async (baseUrl) => {
      const result = await window.morrow.settings.saveWebSearch({
        enabled: true,
        provider: 'searxng',
        baseUrl,
        maxResults: 5
      })
      return result.ok
    }, search.baseUrl)
    expect(configuredSearch).toBe(true)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('a4-research-ws'),
      ...provider,
      permissionMode: 'auto',
      title: '深度研究测试'
    })

    // 输入框只保留聊天/工作；研究工作流通过 /research 调取
    await expect(page.locator('.composer-picker-mode').getByRole('radio')).toHaveCount(2)
    await page.locator('.composer-input').fill('/research quick 研究一下 Morrow 的深度研究能力，并给出可核对的报告。')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-perm-lock.is-research')).toContainText('联网查证')
    await expect(page.locator('.composer-picker-research')).toContainText('研究·快速')

    // ChatGPT Deep Research 式流程：先拿到可编辑计划，确认后才开始检索
    const ready = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return session?.research ?? null
      })
      return result?.status === 'ready' ? result : null
    }, 60_000, '研究计划生成')
    expect(ready.plan).toContain('研究计划')
    const planBar = page.locator('.research-bar')
    await expect(planBar).toContainText('计划待确认')
    await expect(page.getByLabel('研究计划')).toHaveValue(/研究计划/)
    await dismissToasts(page)
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-plan-dark.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-plan-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.getByLabel('研究计划').fill(`${PLAN}\n\n补充：优先 2026 年资料。`)
    await page.getByRole('button', { name: '开始研究' }).click()

    // 运行中可追加要求（ChatGPT Deep Research 式调整方向），下一轮优先纳入
    const running = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return session?.research?.status === 'searching' ? { sessionId: session.id as string } : null
      })
      return result
    }, 20_000, '研究开始')
    await expect(page.getByLabel('补充研究要求')).toBeVisible()
    await dismissToasts(page)
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-steering-dark.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-research-steering-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    const steered = await page.evaluate(
      async (arg: { sessionId: string; text: string }) => {
        const result = await window.morrow.chat.steerResearch({ sessionId: arg.sessionId, text: arg.text })
        return result.ok ? { ok: true as const } : { ok: false as const, error: result.error.message }
      },
      { sessionId: running.sessionId, text: '补充关注 2026 年资料与官方来源' }
    )
    expect(steered.ok).toBe(true)
    await expect(page.locator('.research-steer-pending')).toContainText('下一轮优先处理')

    // 等待两轮自动续研完成
    const final = await waitUntil(async () => {
      const result = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const session = store.getState().session
        return { research: session?.research ?? null, messages: session?.messages ?? [] }
      })
      return result.research?.status === 'completed' ? result : null
    }, 90_000, '研究完成')
    expect(final.research).toMatchObject({
      status: 'completed',
      depth: 'quick',
      round: 2,
      minSources: 4
    })
    expect(final.research.sourceCount).toBeGreaterThanOrEqual(4)
    expect(final.research.plan).toContain('优先 2026 年资料')
    expect(final.messages.some((message: { hidden?: boolean; displayText?: string }) => message.hidden)).toBe(true)

    // 研究条：真实轮次/来源/报告入口；内部补查提示不出现在对话里
    const bar = page.locator('.research-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('已完成')
    await expect(bar).toContainText('来源 4/4')
    await expect(bar).toContainText('第 2/2 轮')
    await expect(page.getByText('继续这项深度研究')).toHaveCount(0)
    const reportButton = bar.getByRole('button', { name: '打开研究报告' })
    if (!(await reportButton.isVisible().catch(() => false))) {
      await bar.locator('.research-bar-toggle').click()
    }
    await expect(bar.getByRole('button', { name: '打开研究报告' })).toBeVisible()

    // 来源面板来自真实 web_search 结果（两轮共 4 个独立 URL）
    await expect(page.locator('.sources-tray')).toBeVisible()
    await page.locator('.sources-head').click()
    await expect(page.locator('.sources-item')).toHaveCount(4)
    await page.locator('.sources-head').click()

    await page.screenshot({ path: screenshotPath('a4-deep-research.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: screenshotPath('a4-deep-research-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })

    // 报告打开到画布
    await bar.getByRole('button', { name: '打开研究报告' }).click()
    await expect(page.locator('.canvas-head-title')).toContainText('研究报告', { timeout: 15_000 })

    // 研究模式的系统提示与工具白名单：有 web_search，无写文件/命令（跳过可能的连接探测请求）
    const researchRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('深度研究模式')
    )
    const system = JSON.stringify(
      (researchRequest?.body as { messages?: Array<{ content: unknown }> } | undefined)?.messages?.[0]?.content ?? ''
    )
    expect(system).toContain('优先 2026 年资料')
    const planRequest = mock.requests.find((request) =>
      JSON.stringify(request.body ?? {}).includes('制定计划阶段')
    )
    const planTools = ((planRequest?.body as { tools?: unknown[] } | undefined)?.tools ?? []) as unknown[]
    expect(planTools).toHaveLength(0)
    expect(mock.requests.some((request) => JSON.stringify(request.body ?? {}).includes('补充关注 2026 年资料与官方来源'))).toBe(true)
    const toolNames = (
      (((researchRequest?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ??
        []) as Array<{ function?: { name?: string } }>)
    ).map((tool) => tool.function?.name ?? '')
    expect(system).toContain('深度研究模式')
    expect(system).toContain('研究模式固定只读资料与联网查证')
    expect(toolNames).toContain('web_search')
    expect(toolNames).not.toContain('run_command')
    expect(toolNames).not.toContain('write_file')
    expect(search.queries.length).toBeGreaterThanOrEqual(2)
  })
})

})
// ── 原文件：r10-connectors.spec.ts ──────────────────────────────────────────────
test.describe('r10-connectors.spec.ts', () => {
/**
 * R10-G 连接器管理面板 E2E（真实 Electron + 真实主进程 feature IPC + 真实文件/加密）。
 *
 * 无 LLM、不联网、不产生费用：
 * 1. 从设置 → 更多功能打开连接器面板；
 * 2. 通过面板 UI 添加 Streamable HTTP MCP 连接器（本地 mock server），测试连接 → 工具列表；
 * 3. 保存后验证真实落盘：`<dataDir>/mcp.json` 只有 `$MORROW_SECRET:` 标记，密钥加密文件无明文；
 * 4. 再次测试已保存连接器：解密后的 Authorization 请求头真实发到 mock server；
 * 5. 启停开关、SSRF 拒绝（localhost 未勾选 allowPrivateNetwork）、file:// 协议拒绝、删除清理；
 * 6. catalog 条目名合法、地址与运行时字段完整；截图深色面板。
 */

type InvokeResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

interface MockMcpServer {
  url: string
  requests: Array<{ method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }>
  close: () => Promise<void>
}

const INITIALIZE_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'e2e-mock-http', version: '1.0.0' }
}

const TOOLS_RESULT = {
  tools: [
    {
      name: 'echo',
      description: '原样返回参数（E2E mock）',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    { name: 'list_items', description: '分页清单', inputSchema: { type: 'object', properties: {} } }
  ]
}

/** 本地 Streamable HTTP MCP mock：POST JSON-RPC / JSON 响应 / Mcp-Session-Id */
async function startMockMcp(): Promise<MockMcpServer> {
  const sockets = new Set<Socket>()
  const requests: MockMcpServer['requests'] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let message: Record<string, unknown> | null = null
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        message = null
      }
      requests.push({ method: typeof message?.method === 'string' ? message.method : '', headers: req.headers, body: message })
      if (!message) {
        res.writeHead(400)
        res.end()
        return
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id, result }))
      }
      if (message.method === 'initialize') {
        reply(INITIALIZE_RESULT, { 'Mcp-Session-Id': 'e2e-session' })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        reply(TOOLS_RESULT)
        return
      }
      if (message.method === 'resources/list') {
        reply({ resources: [{ uri: 'memo://notes/1', name: 'Notes', mimeType: 'text/plain' }] })
        return
      }
      if (message.method === 'resources/templates/list') {
        reply({ resourceTemplates: [{ uriTemplate: 'memo://notes/{id}', name: 'Note' }] })
        return
      }
      if (message.method === 'resources/read') {
        reply({ contents: [{ uri: 'memo://notes/1', mimeType: 'text/plain', text: '# Note' }] })
        return
      }
      if (message.method === 'prompts/list') {
        reply({ prompts: [{ name: 'summarize', description: '总结主题', arguments: [{ name: 'topic', required: true }] }] })
        return
      }
      if (message.method === 'prompts/get') {
        reply({ messages: [{ role: 'user', content: { type: 'text', text: '请总结：MCP' } }] })
        return
      }
      if (message.method === 'tools/call') {
        const params = (message.params ?? {}) as Record<string, unknown>
        reply({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock MCP server 未监听')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

async function invoke<T>(page: MorrowApp['page'], channel: string, payload?: unknown): Promise<InvokeResult<T>> {
  return page.evaluate(
    async (arg: { channel: string; payload?: unknown }) => {
      return window.morrow.features.invoke(arg.channel, arg.payload) as Promise<InvokeResult<T>>
    },
    { channel, payload }
  )
}

function readMcpJson(dataDir: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>
  }
}

async function openConnectorsPanel(morrow: MorrowApp): Promise<void> {
  const { page } = morrow
  await dismissOnboarding(page)
  await waitForStoreReady(page)
  await openToolPanel(page, '连接器')
  await expect(page.getByTestId('connectors-panel')).toBeVisible({ timeout: 15_000 })
  // 外层模态不滚动；左右两栏各自在面板内部滚动
  const bodyOverflow = await page
    .getByRole('dialog', { name: '外部工具' })
    .evaluate((panel) => {
      const body = panel.querySelector<HTMLElement>('.modal-body')
      return body ? body.scrollHeight - body.clientHeight : null
    })
  expect(bodyOverflow).not.toBeNull()
  expect(bodyOverflow!).toBeLessThanOrEqual(1)
  const pathFits = await page.locator('.conn-path').evaluate((element) => {
    return element.clientHeight > 0 && element.scrollHeight <= element.clientHeight + 1
  })
  expect(pathFits).toBe(true)
}

test.describe('R10-G 连接器管理面板', () => {
  let morrow: MorrowApp | null = null
  let mock: MockMcpServer | null = null

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    await mock?.close()
    mock = null
  })

  test('@core:connectors HTTP 连接器：测试连接 → 保存（密钥加密）→ 再测（解密发请求）→ 启停 → SSRF/文件协议拒绝 → 删除', async () => {
    mock = await startMockMcp()
    morrow = await launchMorrow({ name: 'r10-connectors', waitForSelector: '.sidebar' })
    const { page, dataDir } = morrow
    await openConnectorsPanel(morrow)

    // feature IPC 已注册：目录条目名称合法、远程/本机字段完整
    const catalog = await invoke<{ entries: Array<{ name: string; transport: string; requiresNpx: boolean; docsUrl: string }> }>(
      page,
      'feature:connectors:catalog',
      {}
    )
    expect(catalog.ok).toBe(true)
    if (catalog.ok) {
      expect(catalog.data.entries.length).toBeGreaterThanOrEqual(8)
      expect(catalog.data.entries.every((entry) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name))).toBe(true)
      expect(catalog.data.entries.every((entry) => entry.docsUrl.startsWith('https://'))).toBe(true)
    }

    // ── 1) 添加 HTTP 连接器（未勾选允许本机 → 先看 SSRF 拒绝）
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill(mock.url)

    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-error')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-reason')).toHaveText('ssrf-blocked')
    await expect(page.locator('.conn-test-error')).toContainText('允许访问本机/内网地址')

    // 勾选显式允许本机地址后测试成功
    await page.getByRole('switch', { name: '允许访问本机/内网地址' }).click()
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.conn-test-ok')).toContainText('连接成功')
    await expect(page.locator('.conn-test-ok')).toContainText('echo')
    await expect(page.locator('.conn-test-ok')).toContainText('list_items')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个资源')
    await expect(page.locator('.conn-test-ok')).toContainText('1 个提示词')
    await expect(page.locator('.conn-catalog').filter({ hasText: 'memo://notes/1' })).toBeVisible()
    await expect(page.locator('.conn-catalog').filter({ hasText: 'summarize' })).toBeVisible()

    // ── 2) 加一个鉴权请求头（密钥只写不读）
    await page.locator('.conn-secrets').getByRole('button', { name: '添加' }).click()
    await page.getByLabel('请求头 headers键名').fill('Authorization')
    await page.getByLabel('请求头 headers值').fill('Bearer e2e-secret-token')

    // OAuth 端点保存后由后端加密保管令牌；这里验证 UI 字段与配置落盘
    await page.getByLabel('授权地址').fill('https://auth.example.com/oauth/authorize')
    await page.getByLabel('令牌地址').fill('https://auth.example.com/oauth/token')
    await page.getByLabel('Client ID').fill('e2e-client')
    await page.getByLabel('Scope（空格分隔）').fill('read write')
    await page.getByLabel('授权地址').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('mcp-oauth-dark.png') })

    // ── 3) 保存并验证真实落盘（加密标记，无明文）
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toBeVisible({ timeout: 15_000 })
    const config = readMcpJson(dataDir)
    const saved = config.mcpServers['e2e-http']
    expect(saved).toBeTruthy()
    expect(saved.transport).toBe('http')
    expect(saved.url).toBe(mock.url)
    expect(saved.oauth).toMatchObject({
      authorizationUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'e2e-client',
      scopes: ['read', 'write']
    })
    await expect(page.locator('.conn-oauth-status')).toContainText('未授权', { timeout: 10_000 })
    const headers = saved.headers as Record<string, string>
    expect(headers.Authorization.startsWith('$MORROW_SECRET:')).toBe(true)
    const rawConfigText = readFileSync(join(dataDir, 'mcp.json'), 'utf8')
    expect(rawConfigText).not.toContain('e2e-secret-token')
    expect(existsSync(join(dataDir, 'mcp-secrets.json'))).toBe(true)
    const secretsText = readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')
    expect(secretsText).not.toContain('e2e-secret-token')

    // 列表视图只显示掩码，渲染层拿不到明文
    const list = await invoke<{ connectors: Array<{ name: string; headers: Array<{ masked: string; hasSecret: boolean }> }> }>(
      page,
      'feature:connectors:list',
      { scope: 'user' }
    )
    expect(list.ok).toBe(true)
    if (list.ok) {
      const view = list.data.connectors.find((item) => item.name === 'e2e-http')
      expect(view?.headers[0]).toMatchObject({ masked: '••••••••', hasSecret: true })
      expect(JSON.stringify(list.data)).not.toContain('e2e-secret-token')
    }

    // ── 4) 再测已保存连接器：主进程解密密钥，Authorization 真实到达 mock server
    mock.requests.length = 0
    await page.getByRole('button', { name: '测试连接' }).click()
    await expect(page.locator('.conn-test-ok')).toBeVisible({ timeout: 20_000 })
    const toolsListRequest = mock.requests.find((request) => request.method === 'tools/list')
    expect(toolsListRequest?.headers.authorization).toBe('Bearer e2e-secret-token')
    expect(toolsListRequest?.headers['mcp-session-id']).toBe('e2e-session')

    // 截图证据 2：工具列表与测试结果（滚到编辑区底部）
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('r10-connectors-tools.png') })

    // 截图证据 1（面板 + 已保存连接器）：把编辑区滚回顶部，保证截图完整
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-connectors-panel.png') })

    // ── 4.1) 同名新建被拒绝：不得覆盖已有连接器或其密钥
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-http')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('https://evil.example.com/mcp')
    await page.getByRole('button', { name: '保存' }).click()
    const duplicateAlert = page.getByRole('alert').filter({ hasText: '操作失败' })
    await expect(duplicateAlert).toBeVisible({ timeout: 10_000 })
    await expect(duplicateAlert).toContainText('已被另一个外部工具使用')
    const duplicateConfig = readMcpJson(dataDir).mcpServers['e2e-http']
    expect(duplicateConfig?.url).toBe(mock.url)
    await page.locator('.conn-detail').evaluate((element) => {
      element.scrollTop = 0
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('connector-duplicate-name-dark.png') })
    await page.getByRole('button', { name: '取消' }).click()

    // ── 5) 启停开关真实写盘
    const item = page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBe(true)
    await item.getByRole('switch').click()
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http']?.disabled, { timeout: 10_000 })
      .toBeUndefined()

    // ── 6) file:// 协议被配置校验拒绝
    await page.getByRole('button', { name: '添加外部工具' }).click()
    await page.getByLabel('名称').fill('e2e-bad-url')
    await page.getByRole('radio', { name: 'HTTP' }).click()
    await page.getByLabel('服务地址').fill('file:///C:/Windows/win.ini')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toContainText('只允许 http://')
    await page.getByRole('button', { name: '取消' }).click()

    // ── 7) 删除连接器：列表与磁盘都清理
    await page.getByTestId('connector-item').filter({ hasText: 'e2e-http' }).locator('.conn-item-main').click()
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByTestId('connector-item').filter({ hasText: 'e2e-http' })).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => readMcpJson(dataDir).mcpServers['e2e-http'] ?? null, { timeout: 10_000 })
      .toBeNull()
    const secretsAfterDelete = JSON.parse(readFileSync(join(dataDir, 'mcp-secrets.json'), 'utf8')) as {
      entries: Record<string, string>
    }
    expect(Object.keys(secretsAfterDelete.entries).filter((key) => key.includes('e2e-http'))).toHaveLength(0)
  })
})

})
// ── 原文件：r10-skills.spec.ts ──────────────────────────────────────────────
test.describe('r10-skills.spec.ts', () => {
/**
 * R10-H 技能库 E2E —— 真实 Electron + 真实主进程 `feature:skills:*` IPC。
 *
 * 验收点（不依赖 LLM、不联网、不产生费用）：
 * 1. 主进程 feature 频道已注册（Lead 需在 src/main/ipc-index.ts import './skills'）；
 * 2. 从本地 .zip 真实安装到应用数据目录 <dataDir>/skills，文件真实落盘；
 * 3. list / read / setEnabled / remove / rescan 真实往返；
 * 4. 可执行文件（.js）、zip-slip（../）技能包被拒绝且不落盘；
 * 5. 技能库面板挂载后（Lead 集成）截图深/浅两套主题。
 *
 * 面板 UI 断言说明：Lead 统一挂载 <SkillsPanel/>，本 spec 通过
 * `window.morrow.features.invoke` 直接验证 IPC + 磁盘两层证据；若面板已挂载
 * （存在 `[data-testid="skills-panel"]` 且能找到打开入口）则补截图，否则跳过该段。
 */

type InvokeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

interface SkillView {
  id: string
  name: string
  source: 'workspace' | 'user'
  enabled: boolean
  dir: string
  skillPath: string
  fileCount: number
}

interface SkillsSnapshot {
  userDir: string
  stateFile: string
  workspace: string | null
  skills: SkillView[]
  errors: string[]
}

interface SkillDetail extends SkillView {
  raw: string
  files: Array<{ path: string; size: number }>
}

/* 手工构造 store 模式 ZIP（e2e 里不依赖 jszip 的 CJS 互操作，也让恶意条目名保持原样） */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(path: string, entries: Record<string, string>): string {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localBuffer.length, 16)
  end.writeUInt16LE(0, 20)
  writeFileSync(path, Buffer.concat([localBuffer, centralBuffer, end]))
  return path
}

async function invoke<T>(
  page: Parameters<typeof waitForStoreReady>[0],
  channel: string,
  payload?: unknown
): Promise<InvokeResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: channelPayload }) => {
      return (window as unknown as {
        morrow: { features: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
      }).morrow.features.invoke(channelName, channelPayload) as Promise<never>
    },
    { channel, payload }
  )
}

test.describe('R10-H 技能库（真实主进程 feature IPC）', () => {
  test('@core:skills 安装 / 读取 / 启停 / 删除 / 重扫 + 恶意 zip 拒绝', async () => {
    const morrow = await launchMorrow({ name: 'r10-skills', waitForSelector: '#root' })
    const fixtureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureDir = join(root, 'tmp', `r10-skills-fixtures-${fixtureId}`)
    mkdirSync(fixtureDir, { recursive: true })
    try {
      await waitForStoreReady(morrow.page)

      // 0. 频道必须已注册（Lead 在 features/index.ts import './skills'）
      const initial = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(initial.ok, `feature:skills:list 未注册或失败：${initial.ok ? '' : initial.error.message}`).toBe(true)
      if (!initial.ok) throw new Error('技能库 feature 频道未注册')
      const userDir = initial.data.userDir
      expect(userDir).toContain('skills')
      expect(initial.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review', 'debugging']))

      // 1. 从 zip 真实安装
      const zipPath = writeZip(join(fixtureDir, 'release-skill.zip'), {
        'release/SKILL.md': '---\nname: release\ndescription: E2E 安装的发版技能\n---\n# Release\n读取 changelog 并生成 release.json。',
        'release/checklist.md': '- 检查 changelog\n- 打 tag\n'
      })
      const installed = await invoke<{ installed: SkillView; snapshot: SkillsSnapshot }>(
        morrow.page,
        'feature:skills:install',
        { sourcePath: zipPath, workspace: null }
      )
      expect(installed.ok).toBe(true)
      if (!installed.ok) throw new Error(installed.error.message)
      const skill = installed.data.installed
      expect(skill).toMatchObject({ name: 'release', source: 'user', enabled: true })
      expect(existsSync(join(userDir, 'release', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(userDir, 'release', 'checklist.md'))).toBe(true)
      expect(readFileSync(join(userDir, 'release', 'SKILL.md'), 'utf8')).toContain('E2E 安装的发版技能')

      // 2. list / read
      const listed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:list', { workspace: null })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error(listed.error.message)
      expect(listed.data.skills.map((item) => item.name)).toContain('release')
      const detail = await invoke<SkillDetail>(morrow.page, 'feature:skills:read', { id: skill.id, workspace: null })
      expect(detail.ok).toBe(true)
      if (!detail.ok) throw new Error(detail.error.message)
      expect(detail.data.raw).toContain('# Release')
      expect(detail.data.files.map((file) => file.path)).toEqual(expect.arrayContaining(['SKILL.md', 'checklist.md']))

      // 3. 启停（状态真实写盘）
      const disabled = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: false,
        workspace: null
      })
      expect(disabled.ok).toBe(true)
      if (!disabled.ok) throw new Error(disabled.error.message)
      expect(disabled.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(false)
      const stateFile = disabled.data.stateFile
      expect(readFileSync(stateFile, 'utf8')).toContain('"enabled": false')

      const enabledAgain = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:setEnabled', {
        id: skill.id,
        enabled: true,
        workspace: null
      })
      expect(enabledAgain.ok).toBe(true)
      if (!enabledAgain.ok) throw new Error(enabledAgain.error.message)
      expect(enabledAgain.data.skills.find((item) => item.id === skill.id)?.enabled).toBe(true)

      // 4. 恶意技能包：可执行文件 & zip-slip 都要被拒绝且不落盘
      const exeZip = writeZip(join(fixtureDir, 'exe-skill.zip'), {
        'SKILL.md': '# Bad\nx',
        'run.js': 'console.log(1)'
      })
      const exeInstalled = await invoke<{ installed: SkillView; skipped: string[] }>(morrow.page, 'feature:skills:install', {
        sourcePath: exeZip,
        workspace: null
      })
      expect(exeInstalled.ok).toBe(true)
      if (!exeInstalled.ok) throw new Error(exeInstalled.error.message)
      expect(exeInstalled.data.skipped).toContain('run.js')
      expect(existsSync(join(userDir, 'exe-skill', 'run.js'))).toBe(false)
      await invoke(morrow.page, 'feature:skills:remove', { id: exeInstalled.data.installed.id, workspace: null })

      const evilZip = writeZip(join(fixtureDir, 'evil-skill.zip'), {
        'SKILL.md': '# Evil\nx',
        '../escaped.txt': 'pwned'
      })
      const evilRejected = await invoke(morrow.page, 'feature:skills:install', { sourcePath: evilZip, workspace: null })
      expect(evilRejected.ok).toBe(false)
      if (!evilRejected.ok) expect(evilRejected.error.message).toMatch(/zip-slip|越界/)
      expect(existsSync(join(userDir, '..', 'escaped.txt'))).toBe(false)
      expect(existsSync(join(morrow.dataDir, 'escaped.txt'))).toBe(false)

      // 5. rescan + remove
      const rescanned = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:rescan', { workspace: null })
      expect(rescanned.ok).toBe(true)
      if (!rescanned.ok) throw new Error(rescanned.error.message)
      expect(rescanned.data.errors).toEqual([])

      const removed = await invoke<SkillsSnapshot>(morrow.page, 'feature:skills:remove', {
        id: skill.id,
        workspace: null
      })
      expect(removed.ok).toBe(true)
      if (!removed.ok) throw new Error(removed.error.message)
      expect(removed.data.skills.some((item) => item.name === 'release')).toBe(false)
      expect(removed.data.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['code-review']))
      expect(existsSync(join(userDir, 'release'))).toBe(false)
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
      await morrow.close()
    }
  })
})

})
})

test.describe("12-command-ipc", () => {
// ── 原文件：swarm.spec.ts ──────────────────────────────────────────────
test.describe('swarm.spec.ts', () => {
/**
 * 集群 E2E：/swarm 触发模型拆解 → swarm 工具并行派发 10 个成员 → 汇总。
 * 离线 mock LLM 按系统提示区分主代理与探索/审查成员。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('@core:swarm 集群：拆解为十个成员并行执行并汇总', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    title: `并行检查 ${index + 1}`,
    prompt: `检查登录流程的第 ${index + 1} 个部分并给出结论`,
    deliverable: `第 ${index + 1} 部分的检查结论`,
    agent: index % 2 === 0 ? 'explore' : 'review'
  }))
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown; lastUserMessageText?: string }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('你是代码侦察型集群成员')) {
        return { text: '探索完成：登录入口在 src/auth/login.ts。', delayMs: 400 }
      }
      if (raw.includes('你是代码审查型集群成员')) {
        return { text: '审查完成：未发现高危问题，建议补一个锁定测试。', delayMs: 400 }
      }
      mainCalls += 1
      if (mainCalls === 1) {
        return {
          text: '我把任务拆成十块并行检查。',
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
      return { text: '十个子任务都完成：登录入口已定位，未发现高危问题。' }
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
    const swarmRow = page.locator('.spine-row').filter({ hasText: '成员协作' }).first()
    await expect(swarmRow).toBeVisible({ timeout: 15_000 })
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(10, { timeout: 20_000 })
    await expect(swarmRow.locator('.spine-swarm-status.is-running').first()).toBeVisible({ timeout: 15_000 })

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const last = state.session?.messages.at(-1)
        return state.run === null && last?.role === 'assistant' && last.text.includes('十个子任务都完成') ? true : null
      },
      90_000,
      'swarm 运行结束'
    )

    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(bodies.some((body: string) => body.includes('你是代码侦察型集群成员'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('你是代码审查型集群成员'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('"name":"swarm"') || body.includes('"name": "swarm"'))).toBe(true)

    await expect(swarmRow).toBeVisible()
    await expect(swarmRow.getByText('协作成员', { exact: true })).toBeVisible()
    await expect(swarmRow.locator('.spine-swarm-task')).toHaveCount(10)
    await expect(swarmRow.locator('.spine-swarm-status.is-completed')).toHaveCount(10)
    await expect(swarmRow.locator('.spine-swarm-task').nth(0)).toContainText('并行检查 1')
    await expect(swarmRow.locator('.spine-swarm-task').nth(0)).toContainText('代码侦察')
    await expect(swarmRow.locator('.spine-swarm-task').nth(1)).toContainText('并行检查 2')
    await expect(swarmRow.locator('.spine-swarm-task').nth(1)).toContainText('代码审查')
    await expect(swarmRow.locator('.spine-swarm-task').nth(0)).toContainText('探索完成')
    await expect(swarmRow.locator('.spine-swarm-task').nth(1)).toContainText('审查完成')
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

test('@core:swarm Super-Agent：Router 派发 DAG Worker 并在右侧驾驶舱展示', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown; lastUserMessageText?: string }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        mainCalls += 1
        if (mainCalls === 1) {
          return {
            text: '我把任务拆成两个 Worker：先定位登录入口，再审查风险。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '检查登录流程',
                  max_parallel: 2,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'a',
                      title: '定位登录入口',
                      prompt: '定位登录入口并返回文件路径',
                      deliverable: '登录入口文件与行号',
                      agent: 'explore'
                    },
                    {
                      id: 'b',
                      title: '审查登录风险',
                      prompt: '审查登录流程的风险',
                      deliverable: '风险清单与建议',
                      agent: 'review',
                      depends_on: ['a'],
                      needs: [{ task_id: 'a', result: '登录入口文件与行号' }]
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: 'Super-Agent 完成：入口已定位，未发现高危问题。' }
      }
      if (raw.includes('## 集群成员')) {
        return {
          text: raw.includes('你是代码侦察型集群成员')
            ? '探索完成：入口在 src/auth/login.ts。'
            : '审查完成：未发现高危问题，建议补一个锁定测试。',
          delayMs: 2500
        }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'Super-Agent 测试'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.super-head')).toContainText('Super-Agent')
    await expect(page.locator('.super-dock')).toContainText('把目标交给 Morrow')

    // 右侧面板与画布共用拖拽手柄：可聚焦/方向键调宽，并点亮同一条 1px 香槟金分隔线。
    const superPanel = page.locator('.super-dock')
    const superResizer = page.locator('.super-dock-resizer')
    await expect(superResizer).toBeVisible()
    const panelWidth = (): Promise<number> => superPanel.evaluate((element) => element.getBoundingClientRect().width)
    const initialWidth = await panelWidth()
    await superResizer.press('ArrowLeft')
    await expect.poll(panelWidth).toBeGreaterThan(initialWidth)
    await superResizer.press('ArrowRight')
    await expect.poll(panelWidth).toBe(initialWidth)
    await superResizer.evaluate((element) => (element as HTMLElement).blur())
    await superResizer.hover()
    await expect
      .poll(() => superResizer.evaluate((element) => getComputedStyle(element, '::after').opacity))
      .toBe('1')
    expect(await superResizer.evaluate((element) => getComputedStyle(element, '::after').width)).toBe('1px')

    const dragBox = await superResizer.boundingBox()
    if (!dragBox) throw new Error('Super-Agent 调宽手柄不可见')
    const beforeDrag = await panelWidth()
    await page.mouse.move(dragBox.x + 2, dragBox.y + 120)
    await page.mouse.down()
    await page.waitForTimeout(80)
    await page.mouse.move(dragBox.x - 40, dragBox.y + 120, { steps: 5 })
    await page.waitForTimeout(80)
    await page.mouse.up()
    await expect.poll(panelWidth).toBeGreaterThan(beforeDrag)
    await superResizer.dblclick()
    await expect.poll(panelWidth).toBe(420)

    // 浏览器与 Super 共用右侧栏：打开一个必须收起另一个，不能叠成错误布局。
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'browser' } }))
    })
    await expect(page.locator('.browser-dock')).toBeVisible()
    await expect(page.locator('.super-dock')).toHaveCount(0)
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.browser-dock')).toHaveCount(0)
    await expect(page.locator('.super-dock')).toBeVisible()

    // 任务卡字号必须跟随全局设置，而不是写死在卡片里。
    const superSubSize = (): Promise<string> =>
      page.locator('.super-head-sub').evaluate((element) => getComputedStyle(element).fontSize)
    expect(await superSubSize()).toBe('10px')
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: object) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ fontSize: 15 })
    })
    await expect.poll(superSubSize).toBe('11px')
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: object) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ fontSize: 14 })
    })
    await expect.poll(superSubSize).toBe('10px')

    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('检查登录流程，先定位入口，再审查风险。')
    await page.keyboard.press('Enter')

    const superRow = page.locator('.spine-row').filter({ hasText: 'Super-Agent' }).first()
    await expect(superRow).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.super-dock .super-task')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.locator('.super-dock .super-task.is-running').first()).toBeVisible({ timeout: 15_000 })

    // 删除同工作区的其他对话时，正在运行的 Super-Agent 任务不能被连带停止。
    await page.evaluate(
      async (arg: { workspace: string; providerId: string; modelId: string }) => {
        const created = await window.morrow.session.create({
          workspace: arg.workspace,
          model: { providerId: arg.providerId, modelId: arg.modelId },
          permissionMode: 'auto',
          title: '同工作区的其他对话'
        })
        if (!created.ok) throw new Error(created.error.message)
        const removed = await window.morrow.session.remove(created.data.id)
        if (!removed.ok) throw new Error(removed.error.message)
      },
      { workspace, providerId: provider.providerId, modelId: provider.modelId }
    )
    await expect(page.locator('.super-dock .super-task.is-running').first()).toBeVisible()

    // 用户收起驾驶舱后，运行中的 Super 按钮必须仍可重新打开，而不是被 disabled。
    await page.locator('.super-foot button').filter({ hasText: '收起' }).click()
    await expect(page.locator('.super-dock')).toHaveCount(0)
    await expect(page.locator('.composer-super-toggle')).toBeEnabled()
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible()
    await expect(page.locator('.super-dock .super-task.is-running').first()).toBeVisible()

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        const last = state.session?.messages.at(-1)
        return state.run === null &&
          superState?.status === 'completed' &&
          superState.tasks.length === 2 &&
          last?.role === 'assistant' &&
          last.text.includes('Super-Agent 完成')
          ? true
          : null
      },
      90_000,
      'Super-Agent 运行结束'
    )

    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(bodies.some((body: string) => body.includes('"name":"swarm"') || body.includes('"name": "swarm"'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('## Super-Agent'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('你是代码侦察型集群成员'))).toBe(true)
    const routerBody = bodies.find((body: string) => body.includes('## Super-Agent')) ?? ''
    expect(routerBody).not.toContain('"name":"write_file"')
    expect(routerBody).not.toContain('"name": "write_file"')
    const workerBodies = bodies.filter((body: string) => body.includes('## 集群成员'))
    expect(workerBodies.length).toBeGreaterThan(0)
    expect(workerBodies.some((body: string) => body.includes('write_file'))).toBe(true)

    await expect(page.locator('.super-dock .super-task.is-completed')).toHaveCount(2)
    await expect(page.locator('.super-dock')).toContainText('定位登录入口')
    await expect(page.locator('.super-dock')).toContainText('审查登录风险')
    await expect(page.locator('.super-dock .super-state')).toContainText('已完成')
    await expect(superRow.locator('.spine-swarm-task')).toHaveCount(2)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('super-agent-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('super-agent-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:swarm Super-Agent：单项重试只重跑失败任务，已完成任务不重复执行', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  let bAttempts = 0
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        mainCalls += 1
        if (mainCalls === 1) {
          return {
            text: '派两个任务，其中 B 第一次会失败。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '单项重试验收',
                  max_parallel: 2,
                  watchdog_ms: 0,
                  tasks: [
                    { id: 'a', title: '任务 A（成功项）', prompt: '完成任务 A 并返回结论', deliverable: 'A 的结论' },
                    { id: 'b', title: '任务 B（失败项）', prompt: '完成任务 B 并返回结论', deliverable: 'B 的结论' }
                  ]
                }
              }
            ]
          }
        }
        return { text: '第一轮结束：A 完成，B 失败。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        if (prompt.includes('任务 B')) {
          bAttempts += 1
          if (bAttempts === 1) {
            return { error: { status: 400, message: '模拟 B 第一次失败', type: 'invalid_request_error' } }
          }
          return { text: '任务 B 重试完成。' }
        }
        return { text: '任务 A 完成。' }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-retry-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-retry', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '单项重试测试'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('第一个任务可以失败，然后只重试失败项。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        const a = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 A'))
        const b = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 B'))
        return state.run === null && a?.status === 'completed' && b?.status === 'failed' ? true : null
      },
      90_000,
      '第一轮部分完成'
    )

    const rows = page.locator('.super-dock .super-task')
    const aRow = rows.filter({ hasText: '任务 A' })
    const bRow = rows.filter({ hasText: '任务 B' })
    await expect(bRow.locator('.super-task-retry')).toBeVisible({ timeout: 10_000 })
    await expect(aRow.locator('.super-task-retry')).toHaveCount(0)
    const retryBox = await bRow.locator('.super-task-retry').boundingBox()
    const reactivateBox = await bRow.locator('.super-task-reactivate').boundingBox()
    expect(retryBox && reactivateBox).toBeTruthy()
    // 重试与重新激活是两个独立动作，必须并排显示，不能叠在同一坐标。
    expect(Math.abs(retryBox!.x - reactivateBox!.x)).toBeGreaterThan(10)
    const firstRound = await readStore(page)
    const readPersisted = (): Record<string, any> | null => {
      const sessionId = firstRound.session?.id
      if (!sessionId) return null
      try {
        return JSON.parse(readFileSync(join(morrow.dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
      } catch {
        return null
      }
    }
    const persistedBefore = readPersisted()
    const taskTable = (state: Record<string, any> | null) =>
      (state?.superAgent?.tasks ?? []).map((task: Record<string, any>) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        attempts: task.attempts,
        attemptsHistory: (task.attemptHistory ?? []).map(
          (attempt: Record<string, any>) => `${attempt.attempt}:${attempt.status}`
        )
      }))
    const beforeTasks = taskTable(persistedBefore)
    const firstRoundProjectId = persistedBefore?.superAgent?.projectId
    const aCallsBefore = mock.requests.filter(
      (request: { body?: unknown }) =>
        JSON.stringify(request.body ?? {}).includes('## 集群成员') &&
        (request as { lastUserMessageText?: string }).lastUserMessageText?.includes('任务 A')
    ).length
    const bCallsBefore = mock.requests.filter(
      (request: { body?: unknown }) =>
        JSON.stringify(request.body ?? {}).includes('## 集群成员') &&
        (request as { lastUserMessageText?: string }).lastUserMessageText?.includes('任务 B')
    ).length
    expect(aCallsBefore).toBeGreaterThan(0)
    expect(bCallsBefore).toBe(1)
    await page.screenshot({ path: screenshotPath('super-agent-retry-available.png') })

    await bRow.locator('.super-task-retry').click()
    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        const b = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 B'))
        return b?.status === 'completed' && b?.attempts === 2 && state.run === null ? true : null
      },
      90_000,
      '失败项单独重试完成'
    )
    const finalState = await readStore(page)
    const tasks = finalState.session?.superAgent?.tasks ?? []
    const a = tasks.find((task: { title: string }) => task.title.includes('任务 A'))
    const b = tasks.find((task: { title: string }) => task.title.includes('任务 B'))
    expect(a?.status).toBe('completed')
    expect(a?.attempts).toBe(1)
    expect(b?.status).toBe('completed')
    expect(b?.attempts).toBe(2)
    expect(finalState.session?.superAgent?.status).toBe('completed')
    const aCallsAfter = mock.requests.filter(
      (request: { body?: unknown }) =>
        JSON.stringify(request.body ?? {}).includes('## 集群成员') &&
        (request as { lastUserMessageText?: string }).lastUserMessageText?.includes('任务 A')
    ).length
    const bCallsAfter = mock.requests.filter(
      (request: { body?: unknown }) =>
        JSON.stringify(request.body ?? {}).includes('## 集群成员') &&
        (request as { lastUserMessageText?: string }).lastUserMessageText?.includes('任务 B')
    ).length
    expect(aCallsAfter).toBe(aCallsBefore)
    expect(bCallsAfter).toBeGreaterThan(bCallsBefore)
    // 单项重试不经过 Router，只调用失败任务的 Worker。
    expect(mainCalls).toBe(2)
    const persistedAfter = (() => {
      const sessionId = finalState.session?.id
      if (!sessionId) return null
      try {
        return JSON.parse(readFileSync(join(morrow.dataDir, 'sessions', `${sessionId}.json`), 'utf8'))
      } catch {
        return null
      }
    })()
    const evidence = {
      capturedAt: new Date().toISOString(),
      projectId: firstRoundProjectId,
      firstRound: {
        status: persistedBefore?.superAgent?.status ?? firstRound.session?.superAgent?.status,
        tasks: beforeTasks
      },
      afterRetry: {
        status: persistedAfter?.superAgent?.status ?? finalState.session?.superAgent?.status,
        tasks: taskTable(persistedAfter)
      },
      workerCalls: {
        taskA: { before: aCallsBefore, after: aCallsAfter },
        taskB: { before: bCallsBefore, after: bCallsAfter }
      },
      routerCalls: mainCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't07-retry-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
    await page.screenshot({ path: screenshotPath('super-agent-retry-completed.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:swarm Super-Agent：后台 Worker 等审批不误判，单独取消后其他成员继续', async () => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const outsideName = `e2e-approval-${stamp}.txt`
  let mainCalls = 0
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        mainCalls += 1
        if (mainCalls === 1) {
          return {
            text: '派两个任务，其中一个需要用户批准。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '审批等待验收',
                  max_parallel: 2,
                  watchdog_ms: 0,
                  tasks: [
                    { id: 'a', title: '任务 A（无需审批）', prompt: '只汇报，不改文件', deliverable: 'A 的汇报' },
                    {
                      id: 'b',
                      title: '任务 B（等待审批）',
                      prompt: `写 ../${outsideName}`,
                      deliverable: `写入 ${outsideName}`
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '第一轮结束：A 完成，B 在等批准。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        if (prompt.includes(outsideName)) {
          return {
            text: '',
            toolCalls: [
              {
                name: 'write_file',
                arguments: { path: `../${outsideName}`, content: '批准后才会写入' }
              }
            ]
          }
        }
        return { text: '任务 A 完成。' }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-approval-${stamp}`)
  const outsidePath = join(workspace, '..', outsideName)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-approval', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '审批等待测试'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('派两个任务，其中一个需要我批准；先别自动处理。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        const a = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 A'))
        const b = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 B'))
        return state.run === null && state.pendingPermission && a?.status === 'completed' && b?.status === 'running'
          ? true
          : null
      },
      90_000,
      '后台 Worker 等审批（Router 已结束）'
    )
    const rows = page.locator('.super-dock .super-task')
    const aRow = rows.filter({ hasText: '任务 A' })
    const bRow = rows.filter({ hasText: '任务 B' })
    await expect(bRow).toContainText('等待批准', { timeout: 10_000 })
    await page.screenshot({ path: screenshotPath('super-agent-waiting-approval.png') })
    expect(existsSync(outsidePath)).toBe(false)
    await bRow.locator('.super-task-stop').click()

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        const a = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 A'))
        const b = superState?.tasks.find((task: { title: string }) => task.title.includes('任务 B'))
        return state.pendingPermission === null && a?.status === 'completed' && b?.status === 'cancelled'
          ? true
          : null
      },
      90_000,
      '取消等待后 B 停止、A 保持完成'
    )
    expect(existsSync(outsidePath)).toBe(false)
    await expect(aRow).toHaveClass(/is-completed/)
    await expect(bRow).toHaveClass(/is-cancelled/)
    await page.screenshot({ path: screenshotPath('super-agent-waiting-cancelled.png') })
  } finally {
    rmSync(outsidePath, { force: true })
    await morrow.close()
    await mock.close()
  }
})

test('@core:swarm Super-Agent：规则变更只重排受影响项，无关任务不重跑', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const workerCalls = new Map<string, number>()
  const baseTasks = [
    {
      id: 'rules',
      title: '登录规则',
      prompt: '【任务：rules】登录规则：定义登录规则 v1、锁定策略与错误码。',
      deliverable: '登录规则与错误码 v1',
      files: ['docs/login-rules.md']
    },
    {
      id: 'service',
      title: '登录服务',
      prompt: '【任务：service】登录服务：按规则实现登录 API。',
      deliverable: '登录 API',
      files: ['src/login.ts'],
      depends_on: ['rules'],
      needs: [{ task_id: 'rules', result: '登录规则与错误码 v1' }]
    },
    {
      id: 'page',
      title: '登录页面',
      prompt: '【任务：page】登录页面：按规则实现登录页。',
      deliverable: '登录页',
      files: ['src/login-page.tsx'],
      depends_on: ['rules'],
      needs: [{ task_id: 'rules', result: '登录规则与错误码 v1' }]
    },
    {
      id: 'test',
      title: '登录测试',
      prompt: '【任务：test】登录测试：对服务和页面运行登录测试。',
      deliverable: '登录测试通过',
      files: ['tests/login.test.ts'],
      depends_on: ['service', 'page'],
      needs: [
        { task_id: 'service', result: '登录 API' },
        { task_id: 'page', result: '登录页' }
      ]
    },
    {
      id: 'docs',
      title: '使用说明',
      prompt: '【任务：docs】使用说明：写登录使用说明。',
      deliverable: '登录使用说明',
      files: ['docs/login-guide.md']
    }
  ]
  const revisedTasks = baseTasks.map((task) =>
    task.id === 'rules'
      ? {
          ...task,
          prompt: '【任务：rules】登录规则：改成 v2，连续失败锁定 30 分钟。',
          deliverable: '登录规则与错误码 v2（锁定 30 分钟）'
        }
      : task.id === 'service' || task.id === 'page'
        ? {
            ...task,
            needs: [{ task_id: 'rules', result: '登录规则与错误码 v2（锁定 30 分钟）' }]
          }
        : task
  )
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        mainCalls += 1
        if (mainCalls === 1) {
          return {
            text: '把登录功能拆成规则、服务、页面、测试和说明。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: { goal: '实现登录功能', max_parallel: 4, watchdog_ms: 0, tasks: baseTasks }
              }
            ]
          }
        }
        if (mainCalls === 2) return { text: '第一轮完成。' }
        if (mainCalls === 3) {
          return {
            text: '登录规则改为锁定 30 分钟，只重排受影响项。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '实现登录功能（规则 v2）',
                  revision_of: 'current',
                  max_parallel: 4,
                  watchdog_ms: 0,
                  tasks: revisedTasks
                }
              }
            ]
          }
        }
        return { text: '第二轮完成：只重跑了受影响项。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        const key =
          ['rules', 'service', 'page', 'test', 'docs'].find((id) => prompt.includes(`【任务：${id}】`)) ?? 'unknown'
        workerCalls.set(key, (workerCalls.get(key) ?? 0) + 1)
        return { text: `完成：${key}`, delayMs: 160 }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-replan-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-replan', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '计划修订测试'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('实现登录功能，先定规则，再做服务、页面和测试。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        return state.run === null && superState?.status === 'completed' && superState.planRevision === 1
          ? true
          : null
      },
      90_000,
      '第一版登录计划完成'
    )
    expect(workerCalls.get('docs')).toBe(1)
    expect(workerCalls.get('rules')).toBe(1)
    await page.screenshot({ path: screenshotPath('super-agent-plan-v1.png') })

    await input.click()
    await input.fill('登录规则改成连续失败锁定 30 分钟；无关的说明不要重做。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        const docs = superState?.tasks.find((task: { title: string }) => task.title === '使用说明')
        return state.run === null &&
          superState?.status === 'completed' &&
          superState.planRevision === 2 &&
          docs?.attempts === 1
          ? true
          : null
      },
      90_000,
      '第二版计划只重排受影响项'
    )
    const finalState = await readStore(page)
    const tasks = finalState.session?.superAgent?.tasks ?? []
    expect(finalState.session?.superAgent?.planRevision).toBe(2)
    expect(tasks.find((task: { title: string }) => task.title === '使用说明')?.attempts).toBe(1)
    expect(tasks.find((task: { title: string }) => task.title === '登录规则')?.attempts).toBe(2)
    expect(tasks.find((task: { title: string }) => task.title === '登录服务')?.attempts).toBe(2)
    expect(tasks.find((task: { title: string }) => task.title === '登录页面')?.attempts).toBe(2)
    expect(tasks.find((task: { title: string }) => task.title === '登录测试')?.attempts).toBe(2)
    expect(workerCalls.get('docs')).toBe(1)
    expect(workerCalls.get('rules')).toBe(2)
    expect(workerCalls.get('service')).toBe(2)
    expect(workerCalls.get('page')).toBe(2)
    expect(workerCalls.get('test')).toBe(2)
    const allBodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(allBodies.some((body: string) => body.includes('## 当前项目计划（第 1 版）'))).toBe(true)
    await expect(page.locator('.super-dock .super-stats')).toContainText('第 2 版计划')

    const docsRow = page.locator('.super-dock .super-task').filter({ hasText: '使用说明' })
    await expect(docsRow).toHaveClass(/is-completed/)
    await expect(docsRow).toContainText('通用成员')
    const serviceRow = page.locator('.super-dock .super-task').filter({ hasText: '登录服务' })
    await serviceRow.locator('.super-task-main').click()
    await expect(serviceRow.locator('.super-task-detail')).toContainText('交付：登录 API')
    await expect(serviceRow.locator('.super-task-detail')).toContainText('等待理由')
    await expect(serviceRow.locator('.super-task-detail')).toContainText('登录规则')
    await page.screenshot({ path: screenshotPath('super-agent-plan-v2.png') })

    const sessionId = finalState.session?.id
    const persisted = sessionId
      ? (JSON.parse(readFileSync(join(morrow.dataDir, 'sessions', `${sessionId}.json`), 'utf8')) as Record<string, any>)
      : null
    const evidence = {
      capturedAt: new Date().toISOString(),
      planRevision: persisted?.superAgent?.planRevision ?? null,
      planHistory: (persisted?.superAgent?.planHistory ?? []).map((plan: Record<string, any>) => ({
        revision: plan.revision,
        goal: plan.goal,
        tasks: (plan.tasks ?? []).map((task: Record<string, any>) => ({
          key: task.key,
          title: task.title,
          deliverable: task.deliverable,
          dependsOn: task.dependsOn,
          needs: task.needs,
          waitReason: task.waitReason,
          files: task.files
        }))
      })),
      attempts: tasks.map((task: Record<string, any>) => ({
        title: task.title,
        status: task.status,
        attempts: task.attempts
      })),
      workerCalls: Object.fromEntries(workerCalls),
      routerCalls: mainCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't08-plan-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
    expect(evidence.planHistory).toHaveLength(2)
    expect(evidence.routerCalls).toBe(4)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:swarm Super-Agent：两个成员改同一文件同一行，保留两版并按选择合并', async () => {
  test.setTimeout(180_000)
  let routerCalls = 0
  const workerSteps = new Map<string, number>()
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '派两个成员改同一个文件，稍后合并。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '并发改同一行',
                  max_parallel: 2,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'a',
                      title: '成员 A',
                      prompt: '【任务：a】把 note.txt 改成 A 版本',
                      deliverable: 'A 版本 note.txt'
                    },
                    {
                      id: 'b',
                      title: '成员 B',
                      prompt: '【任务：b】把 note.txt 改成 B 版本',
                      deliverable: 'B 版本 note.txt'
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '第一轮结束：两位成员都已完成，等待合并结果。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        const key = prompt.includes('【任务：a】') ? 'a' : 'b'
        const step = (workerSteps.get(key) ?? 0) + 1
        workerSteps.set(key, step)
        if (step === 1) {
          return {
            toolCalls: [
              {
                name: 'write_file',
                arguments: { path: 'note.txt', content: `${key.toUpperCase()} version\n` }
              }
            ]
          }
        }
        return { text: `成员 ${key.toUpperCase()} 完成。` }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-conflict-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'note.txt'), 'base\n', 'utf8')
  const morrow = await launchMorrow({ name: 'super-agent-conflict', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '文件冲突测试' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('让两个成员改同一个文件，然后合并。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        return state.run === null && superState?.conflicts?.length === 1 ? true : null
      },
      90_000,
      '两个成员改同一行后产生冲突'
    )
    const before = await readStore(page)
    const superState = before.session!.superAgent!
    const conflict = superState.conflicts[0]
    expect(conflict.path).toBe('note.txt')
    expect(conflict.currentPreview).toContain('version')
    expect(conflict.incomingPreview).toContain('version')
    expect(conflict.currentPreview).not.toBe(conflict.incomingPreview)
    const conflictedTask = superState.tasks.find((task) => task.taskId === conflict.taskId)!
    const otherTask = superState.tasks.find((task) => task.taskId !== conflict.taskId)!
    expect(conflictedTask.conflictCount).toBe(1)
    expect(conflictedTask.workspaceCopy).toBeTruthy()
    expect(otherTask.workspaceCopy).toBeTruthy()
    const otherLetter = otherTask.title.includes('A') ? 'A' : 'B'
    const conflictedLetter = conflictedTask.title.includes('A') ? 'A' : 'B'
    const fileBefore = readFileSync(join(workspace, 'note.txt'), 'utf8')
    expect(fileBefore).toContain(`${otherLetter} version`)

    const banner = page.locator('.super-collab-banner.is-conflict')
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toContainText('文件冲突')
    await expect(banner).toContainText('note.txt')
    await expect(banner).toContainText('采用成员版本')
    await banner.locator('summary').click()
    await expect(banner).toContainText(conflict.currentPreview.trim())
    await expect(banner).toContainText(conflict.incomingPreview.trim())
    await page.screenshot({ path: screenshotPath('super-agent-file-conflict.png') })

    await banner.getByRole('button', { name: '采用成员版本' }).click()
    await waitUntil(
      async () => {
        const state = await readStore(page)
        const current = state.session?.superAgent
        return current?.conflicts?.length === 0 && current.status === 'completed' ? true : null
      },
      30_000,
      '选择成员版本后冲突关闭'
    )
    const fileAfter = readFileSync(join(workspace, 'note.txt'), 'utf8')
    expect(fileAfter).toContain(`${conflictedLetter} version`)
    await expect(banner).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('super-agent-file-conflict-resolved.png') })

    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace,
      file: {
        base: 'base',
        beforeResolution: fileBefore,
        afterResolution: fileAfter
      },
      conflict: {
        path: conflict.path,
        reason: conflict.reason,
        taskId: conflict.taskId,
        currentPreview: conflict.currentPreview,
        incomingPreview: conflict.incomingPreview
      },
      tasks: superState.tasks.map((task) => ({
        title: task.title,
        status: task.status,
        attempts: task.attempts,
        conflictCount: task.conflictCount,
        workspaceCopy: task.workspaceCopy
      })),
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(
      join(root, 'test-results', 't09-conflict-evidence.json'),
      JSON.stringify(evidence, null, 2),
      'utf8'
    )
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm Super-Agent：成果版本可提前交接，第 2 版只让使用旧版的成员重测', async () => {
  test.setTimeout(240_000)
  let routerCalls = 0
  let serviceSteps = 0
  const workerSteps = new Map<string, number>()
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '服务先发布接口说明，页面和测试可先用它开工。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '按版本化接口说明完成页面和测试',
                  max_parallel: 4,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'service',
                      title: '登录服务',
                      prompt: '【任务：service】先发布第 1 版登录接口说明，继续实现后再发布第 2 版。',
                      deliverable: '登录 API 与两版接口说明',
                      files: ['docs/login-api.md']
                    },
                    {
                      id: 'page',
                      title: '登录页面',
                      prompt: '【任务：page】按可用的接口说明实现登录页。',
                      deliverable: '使用接口说明的登录页',
                      files: [],
                      depends_on: ['service'],
                      needs: [{ task_id: 'service', result: '登录接口说明', artifact: '登录接口说明' }]
                    },
                    {
                      id: 'test',
                      title: '登录测试',
                      prompt: '【任务：test】按可用的接口说明编写并运行登录测试。',
                      deliverable: '登录测试结果',
                      files: [],
                      depends_on: ['service'],
                      needs: [{ task_id: 'service', result: '登录接口说明', artifact: '登录接口说明' }]
                    },
                    {
                      id: 'docs',
                      title: '使用说明',
                      prompt: '【任务：docs】写与接口版本无关的使用说明。',
                      deliverable: '使用说明',
                      files: ['docs/guide.md']
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '已派发：服务先发布成果，页面和测试按版本开工。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        if (prompt.includes('【任务：service】')) {
          serviceSteps += 1
          if (serviceSteps === 1) {
            return {
              toolCalls: [
                {
                  name: 'write_file',
                  arguments: { path: 'docs/login-api.md', content: '# 登录接口说明\n\n版本：v1\n接口：login(user, password)\n' }
                },
                {
                  name: 'artifact',
                  arguments: {
                    action: 'publish',
                    name: '登录接口说明',
                    path: 'docs/login-api.md',
                    status: 'ready',
                    summary: '第 1 版：login(user, password)'
                  }
                }
              ]
            }
          }
          if (serviceSteps === 2) {
            return {
              toolCalls: [
                {
                  name: 'run_command',
                  arguments: { command: 'powershell -NoProfile -Command "Start-Sleep -Seconds 4"' }
                }
              ]
            }
          }
          if (serviceSteps === 3) {
            return {
              toolCalls: [
                {
                  name: 'write_file',
                  arguments: { path: 'docs/login-api.md', content: '# 登录接口说明\n\n版本：v2\n接口：login({ user, password, remember })\n签名有变，请按新版重测。\n' }
                },
                {
                  name: 'artifact',
                  arguments: {
                    action: 'publish',
                    name: '登录接口说明',
                    path: 'docs/login-api.md',
                    status: 'ready',
                    summary: '第 2 版：签名改为对象参数，使用 v1 的任务需重测'
                  }
                }
              ]
            }
          }
          return { text: '两版接口说明已发布，服务实现完成。' }
        }
        const key = prompt.includes('【任务：page】') ? 'page' : prompt.includes('【任务：test】') ? 'test' : 'docs'
        const version = raw.includes('登录接口说明 v2') ? 'v2' : 'v1'
        const stepKey = `${key}:${version}`
        const step = (workerSteps.get(stepKey) ?? 0) + 1
        workerSteps.set(stepKey, step)
        if (key === 'docs') {
          if (step === 1) {
            return {
              toolCalls: [
                { name: 'write_file', arguments: { path: 'docs/guide.md', content: '# 使用说明（与接口版本无关）\n' } }
              ]
            }
          }
          return { text: '使用说明完成。' }
        }
        if (step === 1) {
          return {
            toolCalls: [{ name: 'artifact', arguments: { action: 'read', name: '登录接口说明' } }]
          }
        }
        return { text: `${key === 'page' ? '页面' : '测试'}已按 ${version} 接口说明完成。` }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-artifact-${Date.now()}`)
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-artifact', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '成果版本交接测试' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('让服务先发布接口说明，页面和测试按版本开工。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const store = await readStore(page)
        const state = store.session?.superAgent
        if (!state || state.tasks.length !== 4 || state.status === 'running') return null
        return state.tasks.every((task) => ['completed', 'failed'].includes(task.status)) ? state : null
      },
      120_000,
      '四个任务完成并发布两版成果'
    )
    const afterBatch = await readStore(page)
    const state = afterBatch.session!.superAgent!
    const pageTask = state.tasks.find((task) => task.title === '登录页面')!
    const testTask = state.tasks.find((task) => task.title === '登录测试')!
    const serviceTask = state.tasks.find((task) => task.title === '登录服务')!
    const docsTask = state.tasks.find((task) => task.title === '使用说明')!
    expect(state.status).toBe('partial')
    expect(serviceTask.status).toBe('completed')
    expect(docsTask.status).toBe('completed')
    expect(pageTask.needsRetest).toBe(true)
    expect(testTask.needsRetest).toBe(true)
    expect(pageTask.artifactUsage.at(-1)?.version).toBe(1)
    expect(testTask.artifactUsage.at(-1)?.version).toBe(1)
    expect(pageTask.earlyStartedBy).toContain('登录服务')
    expect(testTask.earlyStartedBy).toContain('登录服务')
    const v2PublishedAt = state.artifacts.find((artifact) => artifact.version === 2)!.publishedAt
    const pageV1ReadAt = pageTask.artifactUsage.find((usage) => usage.version === 1)!.readAt
    const testV1ReadAt = testTask.artifactUsage.find((usage) => usage.version === 1)!.readAt
    expect(pageV1ReadAt).toBeLessThan(v2PublishedAt)
    expect(testV1ReadAt).toBeLessThan(v2PublishedAt)
    expect(pageV1ReadAt).toBeLessThan(serviceTask.finishedAt!)
    expect(testV1ReadAt).toBeLessThan(serviceTask.finishedAt!)
    expect(state.artifacts.map((artifact) => artifact.version)).toEqual([1, 2])
    expect(state.artifacts[0].status).toBe('ready')
    expect(state.artifacts[1].status).toBe('ready')
    expect(state.artifacts[1].hash).not.toBe(state.artifacts[0].hash)
    expect(readFileSync(join(workspace, 'docs', 'login-api.md'), 'utf8')).toContain('版本：v2')
    expect(readFileSync(join(workspace, 'docs', 'guide.md'), 'utf8')).toContain('与接口版本无关')

    const artifactPanel = page.locator('.super-artifacts')
    await expect(artifactPanel).toBeVisible({ timeout: 10_000 })
    await expect(artifactPanel).toContainText('登录接口说明')
    await expect(artifactPanel).toContainText('v2')
    await expect(artifactPanel).toContainText('可用')
    await expect(page.locator('.super-task-retest')).toHaveCount(2)
    await artifactPanel.locator('summary').first().click()
    await expect(artifactPanel).toContainText('登录页面')
    await page.screenshot({ path: screenshotPath('super-agent-artifact-handoff.png') })

    // 只重测使用旧版的测试项；无关服务/说明任务不重跑。
    const testCard = page.locator('.super-task', { hasText: '登录测试' })
    await testCard.getByRole('button', { name: '重测任务：登录测试' }).click()
    await waitUntil(
      async () => {
        const current = (await readStore(page)).session?.superAgent
        const task = current?.tasks.find((item) => item.title === '登录测试')
        return task && task.attempts >= 2 && !task.needsRetest && task.artifactUsage.some((usage) => usage.version === 2)
          ? true
          : null
      },
      90_000,
      '测试项按第 2 版重测完成'
    )
    const afterTest = (await readStore(page)).session!.superAgent!
    expect(afterTest.tasks.find((task) => task.title === '登录页面')?.needsRetest).toBe(true)
    expect(afterTest.tasks.find((task) => task.title === '登录服务')?.attempts).toBe(1)
    expect(afterTest.tasks.find((task) => task.title === '使用说明')?.attempts).toBe(1)

    const pageCard = page.locator('.super-task', { hasText: '登录页面' })
    await pageCard.getByRole('button', { name: '重测任务：登录页面' }).click()
    await waitUntil(
      async () => {
        const current = (await readStore(page)).session?.superAgent
        return current?.status === 'completed' && !current.tasks.some((task) => task.needsRetest) ? current : null
      },
      90_000,
      '页面按第 2 版重测后项目完成'
    )
    const finalState = (await readStore(page)).session!.superAgent!
    expect(finalState.tasks.find((task) => task.title === '登录服务')?.attempts).toBe(1)
    expect(finalState.tasks.find((task) => task.title === '使用说明')?.attempts).toBe(1)
    expect(finalState.tasks.find((task) => task.title === '登录测试')?.artifactUsage.at(-1)?.version).toBe(2)
    expect(finalState.tasks.find((task) => task.title === '登录页面')?.artifactUsage.at(-1)?.version).toBe(2)
    await expect(page.locator('.super-task-retest')).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('super-agent-artifact-retested.png') })

    // 撤回有误的第 2 版：旧版 v1 恢复可用，使用记录保留；已使用 v2 的任务重新标记为需重测。
    await artifactPanel.locator('.super-artifact-revoke').first().click()
    await waitUntil(
      async () => {
        const current = (await readStore(page)).session?.superAgent
        const revoked = current?.artifacts.find((artifact) => artifact.version === 2)
        return revoked?.status === 'revoked' &&
          current?.status === 'partial' &&
          current.tasks.filter((task) => task.needsRetest).length === 2
          ? true
          : null
      },
      30_000,
      '撤回第 2 版后旧版恢复且使用记录保留'
    )
    const revokedState = (await readStore(page)).session!.superAgent!
    expect(revokedState.artifacts.find((artifact) => artifact.version === 1)?.status).toBe('ready')
    expect(revokedState.artifacts.find((artifact) => artifact.version === 2)?.status).toBe('revoked')
    expect(revokedState.tasks.find((task) => task.title === '登录页面')?.artifactUsage).toHaveLength(2)
    expect(revokedState.tasks.find((task) => task.title === '登录测试')?.artifactUsage).toHaveLength(2)
    await expect(artifactPanel).toContainText('已撤回')
    await page.screenshot({ path: screenshotPath('super-agent-artifact-revoked.png') })

    const usage = (title: string): Array<Record<string, unknown>> =>
      (finalState.tasks.find((task) => task.title === title)?.artifactUsage ?? []).map((entry) => ({
        version: entry.version,
        taskId: entry.attemptId,
        readAt: entry.readAt,
        status: entry.status
      }))
    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace: '<临时测试工作区>',
      releases: finalState.artifacts.map((artifact) => ({
        name: artifact.name,
        version: artifact.version,
        status: artifact.status,
        path: artifact.path,
        hash: artifact.hash,
        taskId: artifact.taskId,
        summary: artifact.summary,
        publishedAt: artifact.publishedAt
      })),
      file: {
        finalVersion: 'v2',
        finalContains: readFileSync(join(workspace, 'docs', 'login-api.md'), 'utf8').includes('版本：v2')
      },
      service: {
        startedAt: serviceTask.startedAt,
        finishedAt: serviceTask.finishedAt,
        attempts: serviceTask.attempts
      },
      earlyStart: [
        {
          task: '登录页面',
          reason: pageTask.earlyStartedBy,
          usedVersion: pageTask.artifactUsage.at(-1)?.version,
          readAt: pageV1ReadAt,
          beforeServiceFinished: pageV1ReadAt < (serviceTask.finishedAt ?? 0),
          beforeV2Published: pageV1ReadAt < v2PublishedAt
        },
        {
          task: '登录测试',
          reason: testTask.earlyStartedBy,
          usedVersion: testTask.artifactUsage.at(-1)?.version,
          readAt: testV1ReadAt,
          beforeServiceFinished: testV1ReadAt < (serviceTask.finishedAt ?? 0),
          beforeV2Published: testV1ReadAt < v2PublishedAt
        }
      ],
      retestAfterV2: ['登录页面', '登录测试'],
      untouched: ['登录服务', '使用说明'],
      usage: {
        登录页面: usage('登录页面'),
        登录测试: usage('登录测试')
      },
      finalStatus: finalState.status,
      revoke: {
        revokedVersion: 2,
        revokedStatus: revokedState.artifacts.find((artifact) => artifact.version === 2)?.status,
        oldVersionStatus: revokedState.artifacts.find((artifact) => artifact.version === 1)?.status,
        usageKept: ['登录页面', '登录测试'].map((title) => ({
          task: title,
          records: revokedState.tasks.find((task) => task.title === title)?.artifactUsage.length ?? 0
        })),
        needsRetestAfterRevoke: revokedState.tasks.filter((task) => task.needsRetest).map((task) => task.title)
      },
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't10-artifact-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm Super-Agent：独立验收失败退回作者返工，修复后在新候选版本通过', async () => {
  test.setTimeout(240_000)
  let routerCalls = 0
  let loginSteps = 0
  let guideSteps = 0
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '先写登录接口说明，再由独立验收员检查；失败就退回返工。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '先写交付文件，再由独立验收员验收',
                  max_parallel: 3,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'login',
                      title: '登录接口说明',
                      prompt: '【任务：login】先写接口说明；如果验收失败，按反馈修复后重新交付。',
                      deliverable: '最终的 docs/login.md',
                      files: ['docs/login.md']
                    },
                    {
                      id: 'check',
                      title: '独立验收',
                      prompt: '独立运行验收命令，核对 docs/login.md 是否存在并真正通过。',
                      deliverable: '验收记录（候选版本、命令结果与交付文件）',
                      files: [],
                      depends_on: ['login'],
                      verify: {
                        files: ['docs/login.md'],
                        command: 'node --test test/login.test.mjs',
                        max_reworks: 1
                      }
                    },
                    {
                      id: 'guide',
                      title: '使用说明',
                      prompt: '【任务：guide】写与验收无关的使用说明。',
                      deliverable: '使用说明',
                      files: ['docs/guide.md']
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '已派发：验收失败会自动退回作者返工。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        if (prompt.includes('【任务：login】')) {
          loginSteps += 1
          if (loginSteps === 1) {
            return {
              toolCalls: [
                {
                  name: 'write_file',
                  arguments: { path: 'docs/login.md', content: '# 登录接口说明\n\n版本：草稿\n接口：login(user)\n' }
                }
              ]
            }
          }
          if (loginSteps === 2) return { text: '草稿已写，等待独立验收。' }
          if (loginSteps === 3) {
            return {
              toolCalls: [
                {
                  name: 'write_file',
                  arguments: {
                    path: 'docs/login.md',
                    content: '# 登录接口说明\n\n版本：final\n接口：login({ user, password, remember })\n'
                  }
                }
              ]
            }
          }
          return { text: '已按验收失败反馈修复，等待复测。' }
        }
        if (prompt.includes('【任务：guide】')) {
          guideSteps += 1
          if (guideSteps === 1) {
            return {
              toolCalls: [
                { name: 'write_file', arguments: { path: 'docs/guide.md', content: '# 使用说明（与验收无关）\n' } }
              ]
            }
          }
          return { text: '使用说明完成。' }
        }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-verify-${Date.now()}`)
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  mkdirSync(join(workspace, 'test'), { recursive: true })
  writeFileSync(
    join(workspace, 'test', 'login.test.mjs'),
    `import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
test('login doc is final', () => {
  const text = readFileSync(new URL('../docs/login.md', import.meta.url), 'utf8')
  assert.match(text, /final/)
})
`,
    'utf8'
  )
  const morrow = await launchMorrow({ name: 'super-agent-verify', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '独立验收测试' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('先写文件，再让独立验收员检查；失败就返工。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const store = await readStore(page)
        const state = store.session?.superAgent
        if (!state || state.tasks.length !== 3 || state.status === 'running') return null
        return state.tasks.every((task) => ['completed', 'failed', 'blocked'].includes(task.status)) ? state : null
      },
      150_000,
      '独立验收失败返工后复测通过'
    )
    const state = (await readStore(page)).session!.superAgent!
    const login = state.tasks.find((task) => task.title === '登录接口说明')!
    const check = state.tasks.find((task) => task.title === '独立验收')!
    const guide = state.tasks.find((task) => task.title === '使用说明')!
    expect(state.status).toBe('completed')
    expect(login.attempts).toBe(2)
    expect(check.attempts).toBe(2)
    expect(guide.attempts).toBe(1)
    expect(login.reworkFeedback).toContain('独立验收失败')
    expect(check.verification?.status).toBe('passed')
    expect(check.verification?.candidateVersion).toMatch(/^cand_[0-9a-f]{12}$/)
    expect(check.verification?.command?.exitCode).toBe(0)
    expect(check.verification?.files[0]).toMatchObject({ path: 'docs/login.md', required: true, exists: true })
    expect(check.verificationHistory.map((record) => record.status)).toEqual(['failed', 'passed'])
    expect(check.verificationHistory[0].candidateVersion).not.toBe(check.verificationHistory[1].candidateVersion)
    expect(check.verificationHistory[0].command?.exitCode).not.toBe(0)
    expect(check.verificationHistory[0].files[0]).toMatchObject({
      path: 'docs/login.md',
      required: true,
      exists: true
    })
    expect(readFileSync(join(workspace, 'docs', 'login.md'), 'utf8')).toContain('final')
    expect(readFileSync(join(workspace, 'docs', 'guide.md'), 'utf8')).toContain('与验收无关')

    const checkCard = page.locator('.super-task', { hasText: '独立验收' })
    await checkCard.locator('.super-task-main').click()
    const verifyBlock = checkCard.locator('.super-verify-block')
    await expect(verifyBlock).toBeVisible({ timeout: 10_000 })
    await expect(verifyBlock).toContainText('验收通过')
    await expect(verifyBlock).toContainText('cand_')
    await expect(verifyBlock).toContainText('node --test test/login.test.mjs')
    await expect(verifyBlock).toContainText('退出码 0')
    await expect(verifyBlock).toContainText('docs/login.md')
    await expect(verifyBlock).toContainText('失败 / 通过记录')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await verifyBlock.scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('super-agent-verification.png') })
    await checkCard.screenshot({ path: screenshotPath('super-agent-verification-detail.png') })

    const sanitize = (text: string): string => text.replaceAll(workspace, '<临时测试工作区>')
    const failure = check.verificationHistory[0]
    const passed = check.verificationHistory[1]
    const summarize = (record: typeof failure) => ({
      candidateVersion: record.candidateVersion,
      status: record.status,
      command: record.command
        ? {
            command: record.command.command,
            exitCode: record.command.exitCode,
            timedOut: record.command.timedOut,
            output: sanitize(record.command.output)
          }
        : null,
      files: record.files,
      error: sanitize(record.error)
    })
    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace: '<临时测试工作区>',
      plan: {
        verifier: '独立验收',
        requiredFiles: check.verify?.files ?? [],
        command: check.verify?.command ?? '',
        maxReworks: check.verification?.maxReworks ?? 0
      },
      failure: summarize(failure),
      passed: summarize(passed),
      tasks: state.tasks.map((task) => ({
        title: task.title,
        status: task.status,
        attempts: task.attempts,
        verification: task.verification?.status ?? null
      })),
      file: {
        exists: existsSync(join(workspace, 'docs', 'login.md')),
        finalContains: readFileSync(join(workspace, 'docs', 'login.md'), 'utf8').includes('final')
      },
      untouched: {
        guideAttempts: guide.attempts
      },
      finalStatus: state.status,
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't11-verification-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm 项目进度页：一眼看清谁在做、谁在等、能帮什么，并用键盘暂停单项', async () => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const outsideName = `e2e-progress-outside-${stamp}.txt`
  let routerCalls = 0
  const mock = await startMockLLM({
    respond: async (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '派四项任务：执行中、等批准、失败和待验收各一项。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '项目进度页四态验证',
                  max_parallel: 4,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'a',
                      title: '任务 A（执行中）',
                      prompt: '【任务：A】先认真分析，稍后再给出结论。',
                      deliverable: 'A 的报告'
                    },
                    {
                      id: 'b',
                      title: '任务 B（等批准）',
                      prompt: `【任务：B】写 ../${outsideName}`,
                      deliverable: 'B 的外部文件'
                    },
                    {
                      id: 'c',
                      title: '任务 C（失败）',
                      prompt: '【任务：C】这次模型请求注定失败。',
                      deliverable: 'C 的结果'
                    },
                    {
                      id: 'd',
                      title: '任务 D（待验收）',
                      prompt: '【任务：D】等待 A 后做独立验收。',
                      deliverable: 'D 的验收记录',
                      depends_on: ['a'],
                      verify: {
                        files: ['docs/a.md'],
                        command: 'node --test test/accept.test.mjs',
                        max_reworks: 0
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '已派发四项任务，完整进度看右侧驾驶舱。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        if (prompt.includes('【任务：A】')) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20_000)
            ctx.req.once('close', () => {
              clearTimeout(timer)
              resolve()
            })
          })
          return { text: '任务 A 完成。' }
        }
        if (prompt.includes('【任务：B】')) {
          return {
            toolCalls: [
              { name: 'write_file', arguments: { path: `../${outsideName}`, content: '需要批准' } }
            ]
          }
        }
        if (prompt.includes('【任务：C】')) {
          return { error: { status: 400, message: '模拟任务失败：模型请求被拒绝' } }
        }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-progress-${stamp}`)
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  mkdirSync(join(workspace, 'test'), { recursive: true })
  writeFileSync(
    join(workspace, 'test', 'accept.test.mjs'),
    `import { test } from 'node:test'
import assert from 'node:assert'
test('accept placeholder', () => assert.equal(1, 1))
`,
    'utf8'
  )
  const outsidePath = join(workspace, '..', outsideName)
  let morrow = await launchMorrow({ name: 'super-agent-progress', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '项目进度页测试'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('派四项任务，让我看清谁在做、谁在等、我能帮什么。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const store = await readStore(page)
        const state = store.session?.superAgent
        const a = state?.tasks.find((task) => task.title.includes('任务 A'))
        const b = state?.tasks.find((task) => task.title.includes('任务 B'))
        const c = state?.tasks.find((task) => task.title.includes('任务 C'))
        const d = state?.tasks.find((task) => task.title.includes('任务 D'))
        return store.run === null &&
          state?.tasks.length === 4 &&
          a?.status === 'running' &&
          b?.waitingForApproval === true &&
          c?.status === 'failed' &&
          d?.status === 'queued'
          ? true
          : null
      },
      90_000,
      '同一项目出现执行中、等批准、失败和待验收四种任务'
    )
    const before = (await readStore(page)).session!.superAgent!
    const beforeTasks = before.tasks.map((task) => ({
      title: task.title,
      status: task.status,
      waitingForApproval: task.waitingForApproval,
      waitReason: task.waitReason,
      error: task.error
    }))
    const overview = page.locator('.super-overview')
    await expect(overview).toBeVisible()
    await expect(overview).toContainText('谁在做')
    await expect(overview).toContainText('谁在等')
    await expect(overview).toContainText('你能帮什么')
    await expect(overview).toContainText('任务 A')
    await expect(overview).toContainText('等你批准')
    await expect(overview).toContainText('重试 1 个失败/阻塞任务')
    await expect(page.locator('.super-task-handoff')).toHaveCount(0)
    const dRow = page.locator('.super-task', { hasText: '任务 D' })
    await expect(dRow).toContainText('待验收')
    await expect(dRow.locator('.super-task-wait')).toContainText('等待')

    // 窄窗口：进度总览与等待原因仍可读，不横向溢出。
    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#island'))
      win?.setSize(1280, 900)
    })
    await page.waitForTimeout(400)
    const narrow = await page.evaluate(() => {
      const dock = document.querySelector('.super-dock') as HTMLElement | null
      const overviewEl = document.querySelector('.super-overview') as HTMLElement | null
      return {
        dockOverflow: dock ? dock.scrollWidth - dock.clientWidth : 0,
        overviewOverflow: overviewEl ? overviewEl.scrollWidth - overviewEl.clientWidth : 0,
        waitText: document.querySelector('.super-overview-item.is-waiting p')?.textContent ?? ''
      }
    })
    expect(narrow.dockOverflow).toBeLessThanOrEqual(1)
    expect(narrow.overviewOverflow).toBeLessThanOrEqual(1)
    expect(narrow.waitText).toContain('等你批准')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.super-dock').screenshot({ path: screenshotPath('super-agent-progress-narrow.png') })

    // 键盘操作：聚焦单项停止按钮并按 Enter，其他任务不受影响。
    const bRow = page.locator('.super-task', { hasText: '任务 B' })
    const stop = bRow.locator('.super-task-stop')
    await stop.focus()
    expect(await stop.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Space')
    await expect(bRow.locator('.super-task-action')).toContainText(/停止(已提交|待确认)/, { timeout: 5_000 })
    await waitUntil(
      async () => {
        const store = await readStore(page)
        const state = store.session?.superAgent
        const a = state?.tasks.find((task) => task.title.includes('任务 A'))
        const b = state?.tasks.find((task) => task.title.includes('任务 B'))
        const c = state?.tasks.find((task) => task.title.includes('任务 C'))
        const d = state?.tasks.find((task) => task.title.includes('任务 D'))
        return store.pendingPermission === null &&
          a?.status === 'running' &&
          b?.status === 'cancelled' &&
          c?.status === 'failed' &&
          d?.status === 'queued'
          ? true
          : null
      },
      90_000,
      '键盘暂停 B 后 A 仍在执行，C/D 状态不变'
    )
    const after = (await readStore(page)).session!.superAgent!
    const afterTasks = after.tasks.map((task) => ({
      title: task.title,
      status: task.status,
      waitReason: task.waitReason
    }))
    expect(existsSync(outsidePath)).toBe(false)
    await expect(overview).toContainText('任务 A')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.super-dock').screenshot({ path: screenshotPath('super-agent-progress-paused.png') })

    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace: '<临时测试工作区>',
      before: beforeTasks,
      afterPause: afterTasks,
      overview: {
        narrowWaitText: narrow.waitText,
        narrowDockOverflow: narrow.dockOverflow,
        narrowOverviewOverflow: narrow.overviewOverflow
      },
      keyboard: {
        focusedStopButton: true,
        key: 'Space',
        feedback: (await bRow.locator('.super-task-action').textContent()) ?? ''
      },
      outsideFileCreated: existsSync(outsidePath),
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't12-progress-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  } finally {
    rmSync(outsidePath, { force: true })
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm 旧会话项目进度只读：历史可查，已完成项不触发实际执行', async () => {
  test.setTimeout(180_000)
  let routerCalls = 0
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '派一个会快速完成的任务。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '旧会话只读验证',
                  max_parallel: 1,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'done',
                      title: '已完成任务',
                      prompt: '【任务：done】直接给出结论。',
                      deliverable: '最终结论'
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '任务已完成，进度在右侧驾驶舱。' }
      }
      if (raw.includes('## 集群成员')) return { text: '旧会话任务完成，结论可查。' }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-history-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  let morrow = await launchMorrow({ name: 'super-agent-history', timeoutMs: 90_000 })
  let dataDir = ''
  let chromiumDir = ''
  try {
    let page = morrow.page
    dataDir = morrow.dataDir
    chromiumDir = morrow.chromiumDir
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '旧会话只读测试'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('跑一个很快完成的任务。')
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => {
        const store = await readStore(page)
        return store.run === null && store.session?.superAgent?.status === 'completed' ? true : null
      },
      90_000,
      '旧会话任务完成'
    )
    const completed = (await readStore(page)).session!.superAgent!
    expect(completed.tasks[0]?.summary).toContain('旧会话任务完成')

    await morrow.close()
    morrow = await launchMorrow({
      name: 'super-agent-history-reopen',
      dataDir,
      chromiumDir,
      timeoutMs: 90_000
    })
    page = morrow.page
    await waitForStoreReady(page)
    await page.evaluate((id) => {
      void (window as unknown as {
        __morrowStore: { getState: () => { selectSession: (sessionId: string) => Promise<void> } }
      }).__morrowStore.getState().selectSession(id)
    }, sessionId)
    await waitUntil(
      async () => {
        const store = await readStore(page)
        return store.activeSessionId === sessionId && store.session?.superAgent?.status === 'completed' ? true : null
      },
      60_000,
      '重新打开旧会话'
    )
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSuperPanel: () => void } } })
        .__morrowStore.getState().openSuperPanel()
    })
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const historyBanner = page.locator('.super-collab-banner.is-readonly', { hasText: '本次已完成' })
    await expect(historyBanner).toBeVisible()
    await expect(historyBanner).toContainText('不会自动触发执行')
    await expect(page.locator('.super-task-stop')).toHaveCount(0)
    await expect(page.locator('.super-task-retry')).toHaveCount(0)
    await expect(page.locator('.super-overview')).toContainText('暂时不用处理')
    const oldState = await readStore(page)
    expect(oldState.run).toBeNull()
    expect(oldState.session?.superAgent?.tasks[0]).toMatchObject({
      title: '已完成任务',
      status: 'completed'
    })
    await expect(page.locator('.super-task', { hasText: '已完成任务' })).toContainText('最近交接')
    await page.screenshot({ path: screenshotPath('super-agent-progress-history.png') })

    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace: '<临时测试工作区>',
      reopenedSession: sessionId,
      status: oldState.session?.superAgent?.status,
      run: oldState.run,
      readOnlyBanner: true,
      stopButtons: 0,
      retryButtons: 0,
      task: oldState.session?.superAgent?.tasks[0]
        ? {
            title: oldState.session.superAgent.tasks[0].title,
            status: oldState.session.superAgent.tasks[0].status,
            attempts: oldState.session.superAgent.tasks[0].attempts,
            summary: oldState.session.superAgent.tasks[0].summary
          }
        : null,
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't12-history-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  } finally {
    await morrow.close().catch(() => undefined)
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm 追溯：从验收失败追到文件版本、修复和通过记录，跨项目拒绝', async () => {
  test.setTimeout(240_000)
  let routerCalls = 0
  let loginSteps = 0
  const draft = `# 登录接口说明\n\n版本：草稿\n${'初始接口说明内容。'.repeat(900)}\n`
  const final = `# 登录接口说明\n\n版本：final\n${'最终接口说明内容。'.repeat(900)}\n`
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '写长接口说明并发布两个版本，再由独立验收员检查。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '验证成果追溯与跨项目隔离',
                  max_parallel: 2,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'login',
                      title: '登录接口说明',
                      prompt: '【任务：login】写长接口说明；验收失败后按反馈修复并发布新版本。',
                      deliverable: '两版 docs/login.md',
                      files: ['docs/login.md']
                    },
                    {
                      id: 'check',
                      title: '独立验收',
                      prompt: '独立运行验收命令，核对 docs/login.md 是否是定稿。',
                      deliverable: '验收记录',
                      files: [],
                      depends_on: ['login'],
                      verify: {
                        files: ['docs/login.md'],
                        command: 'node --test test/login.test.mjs',
                        max_reworks: 1
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '已派发，失败会自动返工并留下追溯记录。' }
      }
      if (raw.includes('## 集群成员')) {
        const prompt = ctx.lastUserMessageText ?? ''
        if (prompt.includes('【任务：login】')) {
          loginSteps += 1
          if (loginSteps === 1) {
            return {
              toolCalls: [
                { name: 'write_file', arguments: { path: 'docs/login.md', content: draft } },
                {
                  name: 'artifact',
                  arguments: {
                    action: 'publish',
                    name: '登录接口说明',
                    path: 'docs/login.md',
                    status: 'ready',
                    summary: '第 1 版：长草稿'
                  }
                }
              ]
            }
          }
          if (loginSteps === 2) return { text: '第 1 版草稿已发布，等待验收。' }
          if (loginSteps === 3) {
            return {
              toolCalls: [
                { name: 'write_file', arguments: { path: 'docs/login.md', content: final } },
                {
                  name: 'artifact',
                  arguments: {
                    action: 'publish',
                    name: '登录接口说明',
                    path: 'docs/login.md',
                    status: 'ready',
                    summary: '第 2 版：定稿'
                  }
                }
              ]
            }
          }
          return { text: '已按验收失败反馈修复并发布定稿。' }
        }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-trace-${Date.now()}`)
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  mkdirSync(join(workspace, 'test'), { recursive: true })
  writeFileSync(
    join(workspace, 'test', 'login.test.mjs'),
    `import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
test('login doc is final and long', () => {
  const text = readFileSync(new URL('../docs/login.md', import.meta.url), 'utf8')
  assert.ok(text.length > 6000)
  assert.ok(text.includes('版本：final'), 'missing final marker')
})
`,
    'utf8'
  )
  const morrow = await launchMorrow({ name: 'super-agent-trace', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '成果追溯测试' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('写长接口说明，失败后修复，并让我能追溯原文件。')
    await page.keyboard.press('Enter')
    await waitUntil(
      async () => {
        const store = await readStore(page)
        const state = store.session?.superAgent
        return state?.status === 'completed' && state.tasks.every((task) => task.status === 'completed') ? true : null
      },
      150_000,
      '追溯项目完成且验收通过'
    )
    const state = (await readStore(page)).session!.superAgent!
    const check = state.tasks.find((task) => task.title === '独立验收')!
    const login = state.tasks.find((task) => task.title === '登录接口说明')!
    expect(state.artifacts?.map((artifact) => artifact.version)).toEqual([1, 2])
    expect(login.attempts).toBe(2)
    expect(check.attempts).toBe(2)
    expect(check.verificationHistory.map((record) => record.status)).toEqual(['failed', 'passed'])
    const failureCandidate = check.verificationHistory[0].candidateVersion
    const passCandidate = check.verificationHistory[1].candidateVersion
    expect(failureCandidate).not.toBe(passCandidate)

    // 从验收任务打开追溯抽屉，默认是短摘要。
    const checkCard = page.locator('.super-task', { hasText: '独立验收' })
    await checkCard.locator('.super-task-main').click()
    await checkCard.locator('.super-verify-block .super-task-trace').click()
    const drawer = page.locator('.super-trace')
    await expect(drawer).toBeVisible({ timeout: 10_000 })
    await expect(drawer).toContainText('项目记录')
    await expect(drawer).toContainText('登录接口说明 v1')
    await expect(drawer).toContainText('历史依据')
    await expect(drawer).toContainText('短引用')

    // 失败记录 → 完整验收输出 → 关联原文件版本。
    await drawer.locator('.super-trace-entry').filter({ hasText: '验收失败' }).first().click()
    await expect(drawer.locator('.super-trace-detail')).toContainText('AssertionError')
    const taskLink = drawer.locator('.super-trace-links button', { hasText: '任务「登录接口说明」' })
    await expect(taskLink).toBeVisible()
    await drawer.locator('.super-trace-links button', { hasText: '登录接口说明 v1' }).click()
    await expect(drawer.locator('.super-trace-detail-head')).toContainText('登录接口说明 v1')
    await expect(drawer.locator('.super-trace-detail pre')).toContainText('版本：草稿')
    await expect(drawer.locator('.super-trace-detail-foot')).toContainText('继续读取')
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const foot = (await drawer.locator('.super-trace-detail-foot').textContent()) ?? ''
      if (foot.includes('已读到末尾')) break
      await drawer.getByRole('button', { name: '继续读取' }).click()
      await page.waitForTimeout(80)
    }
    await expect(drawer.locator('.super-trace-detail-foot')).toContainText('已读到末尾')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.screenshot({ path: screenshotPath('super-agent-trace.png') })

    // 任务详情包含尝试与修复反馈。
    await drawer.locator('.super-trace-links button', { hasText: '发布任务' }).click()
    await expect(drawer.locator('.super-trace-detail pre')).toContainText('尝试记录')
    await expect(drawer.locator('.super-trace-detail pre')).toContainText('修复反馈')

    const traceList = await page.evaluate(async () => {
      const session = (window as unknown as { __morrowStore: { getState: () => { session: { id: string; superAgent: { projectId: string } } } } }).__morrowStore.getState().session
      const api = (window as unknown as {
        morrow: { collaboration: { trace: (input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }> } }
      }).morrow
      return api.collaboration.trace({
        sessionId: session.id,
        projectId: session.superAgent.projectId,
        query: { action: 'list' }
      })
    })
    expect(traceList.ok).toBe(true)
    const listData = traceList.data as {
      entries: Array<{ id: string; kind: string; title: string; summary: string; applicableVersions: string[]; staleForCurrent: boolean }>
      usage: { summaryChars: number; fullChars: number; savedChars: number }
    }
    expect(listData.entries.some((entry) => entry.applicableVersions.includes('登录接口说明 v1'))).toBe(true)
    expect(listData.usage.summaryChars).toBeLessThan(listData.usage.fullChars)

    // 跨项目拒绝：即使拿到会话，也不能读取另一个项目。
    const denial = await page.evaluate(async () => {
      const session = (window as unknown as { __morrowStore: { getState: () => { session: { id: string } } } }).__morrowStore.getState().session
      const api = (window as unknown as {
        morrow: {
          collaboration: {
            trace: (input: unknown) => Promise<{ ok: boolean; error?: { code: string; message: string } }>
          }
        }
      }).morrow
      return api.collaboration.trace({
        sessionId: session.id,
        projectId: 'project_other_trace',
        query: { action: 'list' }
      })
    })
    expect(denial.ok).toBe(false)
    expect(denial.error?.message).toContain('无权访问')

    // 原始快照缺失：明确提示，不替换成第 2 版。
    const projectFile = join(morrow.dataDir, 'collaboration', 'projects', `${state.projectId}.json`)
    const record = JSON.parse(readFileSync(projectFile, 'utf8')) as {
      superAgent: { artifacts: Array<{ version: number; snapshotPath: string }> }
    }
    const v1Snapshot = record.superAgent.artifacts.find((artifact) => artifact.version === 1)!.snapshotPath
    rmSync(v1Snapshot, { force: true })
    const missing = await page.evaluate(async ({ projectId }) => {
      const session = (window as unknown as { __morrowStore: { getState: () => { session: { id: string } } } }).__morrowStore.getState().session
      const api = (window as unknown as {
        morrow: {
          collaboration: {
            trace: (input: unknown) => Promise<{ ok: boolean; data?: { detail?: { missing?: boolean; content?: string } }; error?: string }>
          }
        }
      }).morrow
      return api.collaboration.trace({
        sessionId: session.id,
        projectId,
        query: { action: 'artifact', name: '登录接口说明', version: 1 }
      })
    }, { projectId: state.projectId })
    expect(missing.ok).toBe(true)
    expect(missing.data?.detail?.missing).toBe(true)
    expect(missing.data?.detail?.content ?? '').not.toContain('最终接口说明')

    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace: '<临时测试工作区>',
      lookup: {
        failedCandidate: failureCandidate,
        artifactVersion: '登录接口说明 v1',
        repairAttempt: 2,
        passedCandidate: passCandidate,
        finalArtifactVersion: '登录接口说明 v2'
      },
      entries: listData.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        applicableVersions: entry.applicableVersions,
        staleForCurrent: entry.staleForCurrent
      })),
      usage: listData.usage,
      usageReductionPercent:
        Math.round((listData.usage.savedChars / Math.max(1, listData.usage.fullChars)) * 1000) / 10,
      workerBrief: {
        summaryChars: listData.usage.summaryChars,
        previewCharsPerArtifact: 1_200,
        savingsPercent:
          Math.round(
            (1 - (listData.usage.summaryChars + 1_200) / Math.max(1, listData.usage.fullChars)) * 1000
          ) / 10
      },
      crossProject: { denied: true, error: denial.error?.message ?? '' },
      missingSnapshot: { missing: true, substituted: false },
      tasks: state.tasks.map((task) => ({ title: task.title, attempts: task.attempts, status: task.status })),
      finalStatus: state.status,
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't13-trace-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm 本机并发与用量预算：满员时用户仍能接话，超预算停止派发', async () => {
  test.setTimeout(180_000)
  let routerCalls = 0
  const mock = await startMockLLM({
    respond: (ctx) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '派五个成员并行处理。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '本机并发与预算压力测试',
                  max_parallel: 4,
                  watchdog_ms: 0,
                  tasks: Array.from({ length: 5 }, (_, index) => ({
                    id: `t${index + 1}`,
                    title: `成员 ${index + 1}`,
                    prompt: `成员 ${index + 1} 处理一个独立小块。`,
                    deliverable: `成员 ${index + 1} 的结果`,
                    files: []
                  }))
                }
              }
            ]
          }
        }
        if (routerCalls === 2) return { text: '已派发，后台继续处理。' }
        return { text: '收到，我会在后台继续处理。' }
      }
      if (raw.includes('## 集群成员')) {
        return { text: '成员已完成这一块。', delayMs: 1_800 }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-limits-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-limits', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '并发与预算测试' })
    await page.evaluate(() => {
      void (window as unknown as {
        __morrowStore: {
          getState: () => {
            updateSettings: (patch: { collaborationMaxWorkers: number; collaborationTokenBudget: number }) => Promise<void>
          }
        }
      }).__morrowStore.getState().updateSettings({ collaborationMaxWorkers: 2, collaborationTokenBudget: 15_000 })
    })
    await waitUntil(
      async () =>
        page.evaluate(() => {
          const settings = (window as unknown as {
            __morrowStore: { getState: () => { settings: { collaborationMaxWorkers: number; collaborationTokenBudget: number } } }
          }).__morrowStore.getState().settings
          return settings.collaborationMaxWorkers === 2 && settings.collaborationTokenBudget === 15_000
        }),
      10_000,
      '并发与预算设置已保存'
    )
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('让五个成员并行处理；后台满时我也要能继续说话。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const tasks = state.session?.superAgent?.tasks ?? []
        return tasks.length === 5 &&
          tasks.filter((task) => task.status === 'running').length === 2 &&
          tasks.filter((task) => task.status === 'queued').length === 3
          ? true
          : null
      },
      30_000,
      '并发上限 2：两个执行、三个排队'
    )
    const beforeFollowUp = await readStore(page)
    const beforeMessages = beforeFollowUp.session?.messages.length ?? 0
    const startedAt = Date.now()
    await sendMessageViaStore(page, '补充一句：后台满时也要能接话。')
    await waitUntil(
      async () => {
        const state = await readStore(page)
        const messages = state.session?.messages ?? []
        const last = messages.at(-1)
        return messages.length > beforeMessages && last?.role === 'assistant' && last.text.includes('收到')
          ? true
          : null
      },
      15_000,
      '满员时用户跟进得到 Router 回复'
    )
    const userWaitMs = Date.now() - startedAt
    expect(userWaitMs).toBeLessThan(5_000)

    const state = await waitUntil(
      async () => {
        const store = await readStore(page)
        const superState = store.session?.superAgent
        return store.run === null &&
          superState?.tasks.length === 5 &&
          superState.status === 'partial' &&
          superState.tasks.filter((task) => task.status === 'completed').length === 4 &&
          superState.tasks.filter((task) => task.status === 'blocked').length === 1 &&
          superState.usage?.overBudget === true
          ? superState
          : null
      },
      30_000,
      '预算用尽后 4 项完成、1 项阻塞'
    )
    const completed = state.tasks.filter((task) => task.status === 'completed')
    const blocked = state.tasks.filter((task) => task.status === 'blocked')
    expect(completed).toHaveLength(4)
    expect(blocked).toHaveLength(1)
    expect(blocked[0].error).toContain('预算')
    expect(state.status).toBe('partial')
    expect(state.usage?.overBudget).toBe(true)
    expect(state.usage?.acceptedTasks).toBe(4)
    expect(state.usage?.budgetTokens).toBe(15_000)
    expect(state.usage?.totalTokens ?? 0).toBeGreaterThan(15_000)
    expect(completed.every((task) => (task.usage?.totalTokens ?? 0) > 0)).toBe(true)

    const banner = page.locator('.super-collab-banner.is-warning')
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toContainText('成员用量已达上限')
    await expect(page.locator('.super-limits summary')).toContainText('最多 2 人同时运行')
    await expect(page.locator('.super-limits summary')).toContainText('成员用量')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.screenshot({ path: screenshotPath('super-agent-limits.png') })

    // 单独调回人数与预算：只影响下一次派发，已开始/已记录的任务保持不变。
    const limitsBlock = page.locator('.super-limits')
    await limitsBlock.locator('summary').click()
    await limitsBlock.locator('select').selectOption('4')
    await waitUntil(
      async () =>
        page.evaluate(() => {
          const settings = (window as unknown as {
            __morrowStore: { getState: () => { settings: { collaborationMaxWorkers: number } } }
          }).__morrowStore.getState().settings
          return settings.collaborationMaxWorkers === 4
        }),
      10_000,
      '调回 4 人'
    )
    await limitsBlock.locator('input[type="number"]').fill('30000')
    await limitsBlock.locator('input[type="number"]').press('Enter')
    await waitUntil(
      async () =>
        page.evaluate(() => {
          const settings = (window as unknown as {
            __morrowStore: { getState: () => { settings: { collaborationMaxWorkers: number; collaborationTokenBudget: number } } }
          }).__morrowStore.getState().settings
          return settings.collaborationMaxWorkers === 4 && settings.collaborationTokenBudget === 30_000
        }),
      10_000,
      '预算调到 30000'
    )
    await expect(limitsBlock.locator('summary')).toContainText('最多 4 人同时运行')
    const afterAdjust = (await readStore(page)).session!.superAgent!
    expect(afterAdjust.tasks.map((task) => task.status)).toEqual(state.tasks.map((task) => task.status))

    const evidence = {
      capturedAt: new Date().toISOString(),
      workspace: '<临时测试工作区>',
      limits: { maxWorkers: 2, tokenBudget: 15_000 },
      userFollowUp: { waitMs: userWaitMs, receivedReply: true },
      tasks: state.tasks.map((task) => ({
        title: task.title,
        status: task.status,
        usage: task.usage?.totalTokens ?? 0,
        error: task.error ?? ''
      })),
      usage: state.usage,
      overBudget: true,
      finalStatus: state.status,
      adjustedLimits: { maxWorkers: 4, tokenBudget: 30_000, startedTasksPreserved: true },
      routerCalls
    }
    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(join(root, 'test-results', 't14-overload-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm 试点开关：退出只停新派工，在途成员完成且切回旧方式不重跑', async () => {
  test.setTimeout(120_000)
  let routerCalls = 0
  const memberSteps = new Map<string, number>()
  const mock = await startMockLLM({
    respond: ({ raw }: { raw: string }) => {
      if (raw.includes('## 集群成员')) {
        const title = ['成员 A', '成员 B', '成员 C'].find((entry) => raw.includes(entry))
        if (!title) return { text: '成员完成。', delayMs: 100 }
        const step = (memberSteps.get(title) ?? 0) + 1
        memberSteps.set(title, step)
        if (step === 1) {
          const file = title === '成员 A' ? 'pilot-a.txt' : title === '成员 B' ? 'pilot-b.txt' : 'pilot-c.txt'
          return {
            delayMs: 1_800,
            toolCalls: [{ name: 'write_file', arguments: { path: file, content: `${title} 的交付内容` } }]
          }
        }
        return { text: `${title} 已完成。`, delayMs: 100 }
      }
      routerCalls += 1
      if (routerCalls === 1) {
        return {
          text: '已派发三个成员。',
          toolCalls: [
            {
              name: 'swarm',
              arguments: {
                goal: '试点回退演练',
                max_parallel: 3,
                watchdog_ms: 0,
                tasks: [
                  { id: 'a', title: '成员 A', prompt: '写出 A 的交付文件', deliverable: 'pilot-a.txt', files: ['pilot-a.txt'] },
                  { id: 'b', title: '成员 B', prompt: '写出 B 的交付文件', deliverable: 'pilot-b.txt', files: ['pilot-b.txt'] },
                  { id: 'c', title: '成员 C', prompt: '写出 C 的交付文件', deliverable: 'pilot-c.txt', files: ['pilot-c.txt'] }
                ]
              }
            }
          ]
        }
      }
      if (routerCalls === 2) return { text: '后台继续处理。', delayMs: 50 }
      if (routerCalls === 3) return { text: '旧方式回复：已直接处理，不再派发成员。', delayMs: 80 }
      if (routerCalls === 4) {
        return {
          text: '准备再派一个成员。',
          delayMs: 1_500,
          toolCalls: [
            {
              name: 'swarm',
              arguments: {
                goal: '试点关闭后的新派工',
                max_parallel: 1,
                watchdog_ms: 0,
                tasks: [
                  { id: 'x', title: '新成员', prompt: '这项不应开始', deliverable: 'pilot-x.txt', files: ['pilot-x.txt'] }
                ]
              }
            }
          ]
        }
      }
      return { text: '试点已关闭，没有派发新成员。', delayMs: 80 }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-pilot-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-pilot', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '试点回退演练' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('让三个成员各写一个文件。')
    await page.keyboard.press('Enter')

    const beforeExit = await waitUntil(
      async () => {
        const state = await readStore(page)
        const superState = state.session?.superAgent
        return superState?.tasks.length === 3 && superState.tasks.every((task) => task.status === 'running')
          ? superState
          : null
      },
      30_000,
      '三个成员都在运行'
    )
    const attemptsBefore = new Map(beforeExit.tasks.map((task) => [task.title, task.attempts]))

    // 驾驶舱底部的「退出」就是试点开关：在途 Worker 不应被停止。
    await page.locator('.super-foot-actions button', { hasText: '退出' }).click()
    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.session?.superMode === false ? true : null
      },
      10_000,
      'Super-Agent 试点已退出'
    )
    await expect(page.locator('.super-dock')).toBeHidden({ timeout: 5_000 })

    const finished = await waitUntil(
      async () => {
        const store = await readStore(page)
        const superState = store.session?.superAgent
        return superState?.tasks.length === 3 && superState.tasks.every((task) => task.status === 'completed')
          ? superState
          : null
      },
      30_000,
      '退出试点后在途成员仍完成'
    )
    expect(finished.tasks.every((task) => task.attempts === attemptsBefore.get(task.title))).toBe(true)
    expect(readFileSync(join(workspace, 'pilot-a.txt'), 'utf8')).toContain('成员 A')
    expect(readFileSync(join(workspace, 'pilot-b.txt'), 'utf8')).toContain('成员 B')
    expect(readFileSync(join(workspace, 'pilot-c.txt'), 'utf8')).toContain('成员 C')

    // 旧方式：普通会话直接处理，不再产生新的 Worker 任务。
    const beforeMessages = (await readStore(page)).session?.messages.length ?? 0
    await sendMessageViaStore(page, '现在用旧方式继续。')
    await waitUntil(
      async () => {
        const state = await readStore(page)
        const messages = state.session?.messages ?? []
        const last = messages.at(-1)
        return state.run === null &&
          messages.length > beforeMessages &&
          last?.role === 'assistant' &&
          last.text.includes('旧方式回复')
          ? true
          : null
      },
      15_000,
      '关闭试点后旧方式得到回复'
    )
    const oldMode = await readStore(page)
    expect(oldMode.session?.superAgent?.tasks).toHaveLength(3)
    expect(oldMode.session?.superAgent?.tasks.every((task: { status: string }) => task.status === 'completed')).toBe(true)

    // 重新开启试点：已完成的尝试不重跑，记录仍在。
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const restored = await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.session?.superMode === true && state.session?.superAgent?.tasks.length === 3
          ? state.session.superAgent
          : null
      },
      10_000,
      '重新开启试点后任务记录仍在'
    )
    expect(restored.tasks.every((task) => task.status === 'completed')).toBe(true)
    expect(restored.tasks.every((task) => task.attempts === attemptsBefore.get(task.title))).toBe(true)

    // Router 正在准备新派工时退出试点：只阻断新任务，已在录的任务不重跑。
    const taskCountBeforeBlock = restored.tasks.length
    await sendMessageViaStore(page, '再派一个新成员试试。')
    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.run ? true : null
      },
      10_000,
      'Router 开始准备新派工'
    )
    await page.locator('.super-foot-actions button', { hasText: '退出' }).click()
    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.session?.superMode === false ? true : null
      },
      10_000,
      '运行中退出试点'
    )
    await waitUntil(
      async () => {
        const state = await readStore(page)
        const messages = state.session?.messages ?? []
        const last = messages.at(-1)
        return state.run === null &&
          state.session?.superAgent?.tasks.length === taskCountBeforeBlock &&
          last?.role === 'assistant' &&
          last.text.includes('试点已关闭')
          ? true
          : null
      },
      20_000,
      '新派工被试点开关拒绝'
    )
    const afterBlock = (await readStore(page)).session!.superAgent!
    expect(afterBlock.tasks).toHaveLength(taskCountBeforeBlock)
    expect(afterBlock.tasks.some((task: { title: string }) => task.title === '新成员')).toBe(false)
    expect(afterBlock.tasks.every((task) => task.attempts === attemptsBefore.get(task.title))).toBe(true)

    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(
      join(root, 'test-results', 't16-rollback-evidence.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          workspace: '<临时测试工作区>',
          drill: '退出试点 → 在途成员完成 → 旧方式回复 → 重新开启',
          beforeExit: beforeExit.tasks.map((task) => ({
            title: task.title,
            status: task.status,
            attempts: task.attempts
          })),
          afterExit: finished.tasks.map((task) => ({
            title: task.title,
            status: task.status,
            attempts: task.attempts
          })),
          oldModeReply: true,
          reenabled: restored.tasks.map((task) => ({
            title: task.title,
            status: task.status,
            attempts: task.attempts
          })),
          dispatchBlocked: true,
          tasksUnchangedAfterBlock: afterBlock.tasks.length === taskCountBeforeBlock,
          filesIntact: true
        },
        null,
        2
      ),
      'utf8'
    )
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:swarm 卡住提醒只在有依据时提示，停止或继续等待都不影响其他成员', async () => {
  test.setTimeout(120_000)
  let routerCalls = 0
  const memberSteps = new Map<string, number>()
  const mock = await startMockLLM({
    respond: ({ raw }: { raw: string }) => {
      if (raw.includes('## 集群成员')) {
        const title = ['重复成员 A', '重复成员 B', '稳定成员'].find((entry) => raw.includes(entry))
        if (!title) return { text: '成员完成。', delayMs: 200 }
        const step = (memberSteps.get(title) ?? 0) + 1
        memberSteps.set(title, step)
        if (title === '稳定成员') {
          if (step <= 3) {
            return {
              delayMs: 400,
              toolCalls: [{ name: 'write_file', arguments: { path: 'steady.txt', content: `version ${step}` } }]
            }
          }
          return { text: '稳定成员写完了三个版本。', delayMs: 100 }
        }
        if (step <= 3) {
          return {
            delayMs: 700,
            toolCalls: [{ name: 'read_file', arguments: { path: 'fixture.txt' } }]
          }
        }
        if (step === 4) {
          return {
            delayMs: 1_500,
            toolCalls: [{ name: 'read_file', arguments: { path: 'fixture.txt', offset: title === '重复成员 A' ? 1 : 2 } }]
          }
        }
        return { text: `${title} 已按负责人要求继续。`, delayMs: 120 }
      }
      routerCalls += 1
      if (routerCalls === 1) {
        return {
          text: '已派发三个成员。',
          toolCalls: [
            {
              name: 'swarm',
              arguments: {
                goal: '卡住提醒界面验证',
                max_parallel: 3,
                watchdog_ms: 0,
                tasks: [
                  { id: 'dup-a', title: '重复成员 A', prompt: '反复读取 fixture.txt', deliverable: '结论', files: [] },
                  { id: 'dup-b', title: '重复成员 B', prompt: '反复读取 fixture.txt 后继续', deliverable: '结论', files: [] },
                  { id: 'steady', title: '稳定成员', prompt: '持续写入新版本', deliverable: 'steady.txt', files: ['steady.txt'] }
                ]
              }
            }
          ]
        }
      }
      return { text: '收到，后台继续。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-stuck-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'fixture.txt'), 'stable content\n', 'utf8')
  const morrow = await launchMorrow({
    name: 'super-agent-stuck',
    timeoutMs: 90_000,
    env: {
      MORROW_STUCK_IDLE_MS: '700',
      MORROW_STUCK_REPEATS: '3',
      MORROW_STUCK_STEPS: '5'
    }
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '卡住提醒测试' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('让三个成员分别处理，遇到重复没有成果时要提醒我。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const tasks = state.session?.superAgent?.tasks ?? []
        const stuck = (state.session?.superAgent?.stuckAlerts ?? []).filter(
          (alert: { status?: string }) => alert.status !== 'resolved'
        )
        return tasks.length === 3 && stuck.length === 2 ? state.session?.superAgent : null
      },
      30_000,
      '两个重复任务出现卡住提醒，稳定任务不误报'
    )

    const stuckBanner = page.locator('.super-collab-banner.is-stuck')
    await expect(stuckBanner).toBeVisible({ timeout: 10_000 })
    await expect(stuckBanner).toContainText('可能卡住')
    await expect(stuckBanner).toContainText('重复成员 A')
    await expect(stuckBanner).toContainText('重复成员 B')
    await expect(stuckBanner).not.toContainText('稳定成员')
    await expect(stuckBanner).toContainText('只提醒，不自动停止')

    const itemA = stuckBanner.locator('.super-stuck-list > li').filter({ hasText: '重复成员 A' })
    await itemA.locator('summary').click()
    await expect(itemA).toContainText('读取 fixture.txt')
    await expect(itemA).toContainText('没有产生新成果')
    // 提醒本身只读记录，不会改动用户原文件。
    expect(readFileSync(join(workspace, 'fixture.txt'), 'utf8')).toBe('stable content\n')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.screenshot({ path: screenshotPath('super-agent-stuck.png') })

    // 关闭提醒开关只影响提醒，不停止任何成员。
    const limitsBlock = page.locator('.super-limits')
    await limitsBlock.locator('summary').click()
    await limitsBlock.locator('.super-limits-switch input').click({ force: true })
    await waitUntil(
      async () =>
        page.evaluate(() => {
          const settings = (window as unknown as {
            __morrowStore: { getState: () => { settings: { collaborationStuckAlerts: boolean } } }
          }).__morrowStore.getState().settings
          return settings.collaborationStuckAlerts === false
        }),
      10_000,
      '卡住提醒开关已关闭'
    )
    await expect(stuckBanner).toBeHidden({ timeout: 5_000 })
    const whileOff = (await readStore(page)).session!.superAgent!
    expect(whileOff.tasks.filter((task) => task.status === 'running').length).toBeGreaterThanOrEqual(2)
    expect(whileOff.stuckAlerts?.filter((alert) => alert.status !== 'resolved')).toHaveLength(2)

    await limitsBlock.locator('.super-limits-switch input').click({ force: true })
    await waitUntil(
      async () =>
        page.evaluate(() => {
          const settings = (window as unknown as {
            __morrowStore: { getState: () => { settings: { collaborationStuckAlerts: boolean } } }
          }).__morrowStore.getState().settings
          return settings.collaborationStuckAlerts === true
        }),
      10_000,
      '卡住提醒开关已恢复'
    )
    await expect(stuckBanner).toBeVisible({ timeout: 5_000 })

    const itemAAgain = stuckBanner.locator('.super-stuck-list > li').filter({ hasText: '重复成员 A' })
    await itemAAgain.getByRole('button', { name: '继续等待' }).click()
    await waitUntil(
      async () => {
        const state = await readStore(page)
        const alert = (state.session?.superAgent?.stuckAlerts ?? []).find(
          (entry: { taskTitle?: string; resolution?: string }) =>
            entry.taskTitle === '重复成员 A' && entry.resolution === 'dismissed'
        )
        const task = state.session?.superAgent?.tasks.find((entry: { title: string }) => entry.title === '重复成员 A')
        return alert && (task?.status === 'running' || task?.status === 'completed') ? true : null
      },
      10_000,
      '选择继续等待后重复成员 A 仍在工作'
    )

    const itemB = stuckBanner.locator('.super-stuck-list > li').filter({ hasText: '重复成员 B' })
    await itemB.getByRole('button', { name: '停止这项（释放名额）' }).click()
    const finalState = await waitUntil(
      async () => {
        const store = await readStore(page)
        const superState = store.session?.superAgent
        const terminal = superState?.tasks.every((task: { status: string }) =>
          ['completed', 'cancelled', 'failed', 'stalled', 'blocked'].includes(task.status)
        )
        return store.run === null && superState && terminal ? superState : null
      },
      30_000,
      '停止卡住任务后所有成员到达终态'
    )
    const byTitle = (title: string): { status: string; taskId?: string } | undefined =>
      finalState.tasks.find((task: { title: string }) => task.title === title)
    expect(byTitle('重复成员 A')?.status).toBe('completed')
    expect(byTitle('重复成员 B')?.status).toBe('cancelled')
    expect(byTitle('稳定成员')?.status).toBe('completed')
    expect(finalState.stuckAlerts?.filter((alert) => alert.status !== 'resolved')).toHaveLength(0)
    expect(
      finalState.stuckAlerts?.some(
        (alert) => alert.taskTitle === '重复成员 B' && alert.resolution === 'stopped'
      )
    ).toBe(true)
    await expect(stuckBanner).toBeHidden({ timeout: 5_000 })
    await expect(page.locator('.super-task-stuck')).toHaveCount(0)
    expect(readFileSync(join(workspace, 'fixture.txt'), 'utf8')).toBe('stable content\n')
    expect(readFileSync(join(workspace, 'steady.txt'), 'utf8')).toBe('version 3')

    mkdirSync(join(root, 'test-results'), { recursive: true })
    writeFileSync(
      join(root, 'test-results', 't15-stuck-evidence.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          workspace: '<临时测试工作区>',
          settingsToggle: { offKeptTwoRunning: true, onShowsExistingAlerts: true },
          situations: [
            { title: '重复成员 A', alert: 'same-operation', resolution: 'dismissed', status: byTitle('重复成员 A')?.status },
            { title: '重复成员 B', alert: 'same-operation', resolution: 'stopped', status: byTitle('重复成员 B')?.status },
            { title: '稳定成员', alert: null, status: byTitle('稳定成员')?.status }
          ],
          finalStatus: finalState.status,
          alerts: (finalState.stuckAlerts ?? []).map((alert) => ({
            taskTitle: alert.taskTitle,
            reason: alert.reason,
            resolution: alert.resolution,
            status: alert.status
          }))
        },
        null,
        2
      ),
      'utf8'
    )
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:interface 侧边聊天顶栏标题与说明有呼吸间距，窄窗不挤压', async () => {
  test.setTimeout(90_000)
  const mock = await startMockLLM({ respond: () => ({ text: '侧边回答。' }) })
  const workspace = join(root, 'tmp', `e2e-sidechat-head-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'sidechat-head', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '侧边聊天顶栏测试' })
    await page.locator('.composer-action-sidechat').click()
    await expect(page.locator('.sidechat-rail')).toBeVisible({ timeout: 10_000 })

    const measure = async (): Promise<Record<string, number>> =>
      page.evaluate(() => {
        const rect = (selector: string): DOMRect | null =>
          document.querySelector(selector)?.getBoundingClientRect() ?? null
        const head = rect('.sidechat-head')
        const title = rect('.sidechat-title')
        const sub = rect('.sidechat-sub')
        const actions = rect('.sidechat-head-actions')
        const headEl = document.querySelector('.sidechat-head') as HTMLElement | null
        const copy = document.querySelector('.sidechat-head-copy') as HTMLElement | null
        return {
          headHeight: head?.height ?? 0,
          headBottom: head?.bottom ?? 0,
          titleBottom: title?.bottom ?? 0,
          subTop: sub?.top ?? 0,
          subBottom: sub?.bottom ?? 0,
          titleRight: title?.right ?? 0,
          actionsLeft: actions?.left ?? 0,
          copyGap: copy ? Number.parseFloat(getComputedStyle(copy).rowGap) || 0 : 0,
          overflow: headEl ? headEl.scrollHeight - headEl.clientHeight : 0
        }
      })

    const wide = await measure()
    expect(wide.headHeight).toBeGreaterThanOrEqual(56)
    expect(wide.copyGap).toBeGreaterThanOrEqual(3)
    expect(wide.subTop - wide.titleBottom).toBeGreaterThanOrEqual(2)
    expect(wide.subBottom).toBeLessThanOrEqual(wide.headBottom - 6)
    expect(wide.titleRight).toBeLessThanOrEqual(wide.actionsLeft)
    expect(wide.overflow).toBeLessThanOrEqual(1)

    await morrow.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#island'))
      win?.setSize(1280, 900)
    })
    await page.waitForTimeout(350)
    const narrow = await measure()
    expect(narrow.headHeight).toBeGreaterThanOrEqual(56)
    expect(narrow.subTop - narrow.titleBottom).toBeGreaterThanOrEqual(2)
    expect(narrow.subBottom).toBeLessThanOrEqual(narrow.headBottom - 6)
    expect(narrow.titleRight).toBeLessThanOrEqual(narrow.actionsLeft)
    expect(narrow.overflow).toBeLessThanOrEqual(1)
    await page.screenshot({ path: screenshotPath('side-chat-header.png') })
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:interface 侧边聊天输入框只有流金外框，没有内部高亮框', async () => {
  test.setTimeout(90_000)
  const mock = await startMockLLM({ respond: () => ({ text: '侧边回答。' }) })
  const workspace = join(root, 'tmp', `e2e-sidechat-frame-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'sidechat-frame', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '侧边聊天输入框测试' })
    await page.locator('.composer-action-sidechat').click()
    const input = page.locator('.sidechat-input')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.focus()
    await page.waitForTimeout(250)
    const frame = await page.evaluate(() => {
      const field = document.querySelector('.sidechat-input') as HTMLElement | null
      const shell = document.querySelector('.sidechat-composer') as HTMLElement | null
      if (!field || !shell) throw new Error('missing sidechat field')
      const fieldStyle = getComputedStyle(field)
      const shellStyle = getComputedStyle(shell)
      const rootStyle = getComputedStyle(document.documentElement)
      return {
        fieldOutlineStyle: fieldStyle.outlineStyle,
        fieldAppearance: fieldStyle.appearance,
        fieldShadow: fieldStyle.boxShadow,
        fieldBorder: fieldStyle.borderWidth,
        active: document.activeElement === field,
        shellBorder: shellStyle.borderColor,
        shellShadow: shellStyle.boxShadow,
        shellRadius: shellStyle.borderRadius,
        focusToken: rootStyle.getPropertyValue('--field-frame-focus-shadow').trim(),
        radiusToken: rootStyle.getPropertyValue('--field-frame-radius').trim()
      }
    })
    expect(frame.active).toBe(true)
    expect(frame.fieldOutlineStyle).toBe('none')
    expect(frame.fieldAppearance).toBe('none')
    expect(frame.fieldShadow).toBe('none')
    expect(frame.fieldBorder).toBe('0px')
    expect(frame.shellBorder).toContain('200, 174, 125')
    expect(frame.shellShadow).not.toBe('none')
    expect(frame.focusToken).toContain('0 0 0 3px')
    expect(frame.radiusToken).not.toBe('')
    expect(frame.shellRadius).toBe('5px')
    await page.screenshot({ path: screenshotPath('sidechat-gold-frame.png') })
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('@core:interface 输入框底栏在窄窗与 Super 侧栏打开时保持单行', async () => {
  test.setTimeout(90_000)
  const mock = await startMockLLM({ respond: () => ({ text: 'ok' }) })
  const workspace = join(root, 'tmp', `e2e-composer-row-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'composer-row', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '底栏单行测试' })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })

    // 主窗口 ready-to-show 后 900ms 会校正一次初始尺寸；等它结束再调整，避免覆盖测试目标尺寸。
    await page.waitForTimeout(1100)

    for (const size of [{ width: 1280, height: 900 }, { width: 1600, height: 1000 }, { width: 2100, height: 1200 }]) {
      await morrow.app.evaluate(({ BrowserWindow }, next) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#island'))
        win?.setSize(next.width, next.height)
      }, size)
      await page.waitForTimeout(350)
      const metrics = await page.evaluate(() => {
        const left = document.querySelector('.composer-bar-left')?.getBoundingClientRect()
        const right = document.querySelector('.composer-bar-right')?.getBoundingClientRect()
        const bar = document.querySelector('.composer-bar')?.getBoundingClientRect()
        const picker = (selector: string) => {
          const root = document.querySelector(selector)
          const trigger = root?.querySelector('.select-trigger')
          const value = root?.querySelector('.select-value')
          if (!trigger || !value) return null
          const valueStyle = getComputedStyle(value)
          return {
            width: Math.round(trigger.getBoundingClientRect().width * 10) / 10,
            valueFits: value.scrollWidth <= value.clientWidth + 1,
            ellipsis: valueStyle.overflow === 'hidden' && valueStyle.textOverflow === 'ellipsis'
          }
        }
        const reasoning = document.querySelector('.composer-picker-reasoning')
        return {
          leftTop: left?.top ?? 0,
          rightTop: right?.top ?? 0,
          barHeight: bar?.height ?? 0,
          barWidth: bar?.width ?? 0,
          barOverflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : false,
          rightOverflow: right ? right.scrollWidth > right.clientWidth + 1 : false,
          reasoningVisible: !!reasoning && reasoning.getBoundingClientRect().width > 0,
          model: picker('.composer-picker-model'),
          perm: picker('.composer-picker-perm'),
          reasoning: picker('.composer-picker-reasoning')
        }
      })
      expect(Math.abs(metrics.leftTop - metrics.rightTop), `window ${size.width}: ${JSON.stringify(metrics)}`).toBeLessThan(2)
      expect(metrics.barHeight, `window ${size.width}: ${JSON.stringify(metrics)}`).toBeLessThan(45)
      expect(metrics.barOverflow, `window ${size.width}: ${JSON.stringify(metrics)}`).toBe(false)
      expect(metrics.rightOverflow, `window ${size.width}: ${JSON.stringify(metrics)}`).toBe(false)
      expect(metrics.model?.width, `window ${size.width}: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(145)
      expect(metrics.perm?.width, `window ${size.width}: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(93)
      for (const [name, picker] of Object.entries({ model: metrics.model, perm: metrics.perm, reasoning: metrics.reasoning })) {
        if (!picker) continue
        expect(picker.ellipsis, `${name} ellipsis @ ${size.width}`).toBe(true)
        expect(picker.valueFits, `${name} text fits @ ${size.width}`).toBe(true)
      }
      if (size.width >= 1600) {
        expect(metrics.reasoningVisible, `window ${size.width}: ${JSON.stringify(metrics)}`).toBe(true)
        expect(metrics.reasoning?.width ?? 999, `window ${size.width}: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(80)
      }
    }
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:swarm Super-Agent：真实开发任务写文件、执行 node --test 并独立复核', async () => {
  test.setTimeout(180_000)
  let routerCalls = 0
  let implCalls = 0
  let verifyCalls = 0
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown; lastUserMessageText?: string }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        routerCalls += 1
        if (routerCalls === 1) {
          return {
            text: '这是真实开发任务，我分派实现与独立复核两个 Worker。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '实现一个带测试的 Node 数学模块，并真实验证',
                  max_parallel: 2,
                  watchdog_ms: 120_000,
                  tasks: [
                    {
                      id: 'impl',
                      title: '实现数学模块与测试',
                      prompt: '在 src/math.js 实现 add/subtract，在 test/math.test.js 用 node:test 写测试，并运行 node --test',
                      deliverable: 'src/math.js 与通过 node --test 的测试',
                      agent: 'general'
                    },
                    {
                      id: 'verify',
                      title: '独立验证测试',
                      prompt: '读取 src/math.js 和 test/math.test.js，运行 node --test，确认真实通过',
                      deliverable: '独立运行结果与结论',
                      agent: 'review',
                      depends_on: ['impl'],
                      needs: [{ task_id: 'impl', result: '实现文件与测试运行结果' }]
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '真实开发任务完成：模块、测试与运行结果均已验证。' }
      }
      if (raw.includes('## 集群成员')) {
        if (raw.includes('在 src/math.js 实现 add/subtract')) {
          implCalls += 1
          if (implCalls === 1) {
            return {
              text: '开始实现模块与测试。',
              toolCalls: [
                {
                  name: 'write_file',
                  arguments: {
                    path: 'src/math.js',
                    content: `function add(a, b) { return a + b }
function subtract(a, b) { return a - b }
module.exports = { add, subtract }
`
                  }
                },
                {
                  name: 'write_file',
                  arguments: {
                    path: 'test/math.test.js',
                    content: `const test = require('node:test')
const assert = require('node:assert')
const { add, subtract } = require('../src/math')
test('add', () => assert.equal(add(2, 3), 5))
test('subtract', () => assert.equal(subtract(5, 3), 2))
`
                  }
                },
                { name: 'run_command', arguments: { command: 'node --test' } }
              ]
            }
          }
          return { text: '实现完成：文件已写入，node --test 通过。' }
        }
        verifyCalls += 1
        if (verifyCalls === 1) {
          return {
            text: '开始独立复核。',
            toolCalls: [
              { name: 'read_file', arguments: { path: 'src/math.js' } },
              { name: 'run_command', arguments: { command: 'node --test' } }
            ]
          }
        }
        return { text: '独立复核完成：测试真实通过，代码可读。' }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-super-dev-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'super-agent-dev', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: 'Super 真实开发任务'
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('实现一个带测试的 Node 数学模块，并真实验证。')
    await page.keyboard.press('Enter')

    await waitUntil(
      async () => {
        const state = await readStore(page)
        return state.run === null &&
          state.session?.superAgent?.status === 'completed' &&
          state.session.superAgent.tasks.length === 2 &&
          state.session.superAgent.tasks.every((task) => task.status === 'completed')
          ? true
          : null
      },
      90_000,
      'Super 真实开发任务完成'
    )

    // 真实文件与真实命令：不是只在本地数据里模拟。
    expect(readFileSync(join(workspace, 'src', 'math.js'), 'utf8')).toContain('function add')
    expect(readFileSync(join(workspace, 'test', 'math.test.js'), 'utf8')).toContain("test('add'")
    const state = await readStore(page)
    const impl = state.session?.superAgent?.tasks.find((task) => task.id === 'impl')
    const verify = state.session?.superAgent?.tasks.find((task) => task.id === 'verify')
    expect(impl?.status).toBe('completed')
    expect(verify?.status).toBe('completed')
    const operations = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const tasks = store.getState().session?.superAgent?.tasks ?? []
      return tasks.flatMap((task: Record<string, any>) =>
        (task.operations ?? []).map((operation: Record<string, any>) => ({
          name: String(operation.name ?? ''),
          status: String(operation.status ?? ''),
          output: String(operation.output ?? ''),
          error: String(operation.error ?? '')
        }))
      )
    })
    expect(
      operations.some(
        (operation) =>
          operation.name === 'run_command' &&
          operation.status === 'success' &&
          /pass 2|ok 2|# pass 2/i.test(operation.output)
      )
    ).toBe(true)
    await expect(page.locator('.super-dock .super-task.is-completed')).toHaveCount(2)
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('super-agent-real-dev.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
})

// ── T04：本地协作进度的待核对与重开恢复 ─────────────────────────────────
test.describe('collaboration-review.spec.ts', () => {
  test('@core:sessions 协作待核对：重启后显示待核对，人工核对后重开不再重复执行', async () => {
    test.setTimeout(180_000)
    const dataDir = join(root, 'tmp', `data-collab-review-${Date.now()}`)
    const projectId = 'project_123456789abc'
    const sessionId = 's_collab_review01'
    const taskId = 'task_123456789abc'
    const attemptId = 'attempt_123456789abc_a1'
    const at = Date.now() - 2_000
    const superAgent = {
      runId: 'super_seed_review',
      projectId,
      revision: 3,
      goal: '恢复待核对动作',
      status: 'partial',
      createdAt: at,
      updatedAt: at + 100,
      finishedAt: at + 100,
      tasks: [
        {
          id: 'a',
          taskId,
          index: 0,
          title: '写文件',
          prompt: '',
          role: 'general',
          status: 'completed',
          dependsOn: [],
          attempts: 1,
          currentAttemptId: attemptId,
          attemptHistory: [
            {
              id: attemptId,
              taskId,
              attempt: 1,
              status: 'delivered',
              startedAt: at,
              finishedAt: at + 50,
              source: 'worker',
              summary: '完成'
            }
          ],
          statusHistory: [
            { id: `${attemptId}:delivered`, taskId, attemptId, to: 'delivered', at: at + 50, source: 'worker' }
          ],
          startedAt: at,
          finishedAt: at + 50
        }
      ]
    }
    const session = {
      id: sessionId,
      title: '协作待核对',
      workspace: null,
      model: { providerId: '', modelId: '' },
      permissionMode: 'auto',
      mode: 'work',
      superMode: true,
      createdAt: at,
      updatedAt: at + 100,
      messageCount: 0,
      messages: [],
      todos: [],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      superAgent
    }
    const action = {
      id: `action_${attemptId}`,
      projectId,
      taskId,
      attemptId,
      kind: 'execute_attempt',
      label: '执行「写文件」第 1 次尝试',
      status: 'running',
      idempotencyKey: attemptId,
      createdAt: at,
      updatedAt: at,
      startedAt: at
    }
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    mkdirSync(join(dataDir, 'collaboration', 'projects'), { recursive: true })
    writeFileSync(join(dataDir, 'sessions', `${sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
    writeFileSync(
      join(dataDir, 'collaboration', 'projects', `${projectId}.json`),
      JSON.stringify(
        {
          version: 1,
          projectId,
          sessionId,
          workspace: null,
          title: session.title,
          createdAt: at,
          updatedAt: at,
          revision: 3,
          superAgent,
          actions: [action]
        },
        null,
        2
      ),
      'utf8'
    )

    let first: MorrowApp | null = null
    let second: MorrowApp | null = null
    try {
      first = await launchMorrow({ name: 'collab-review-1', dataDir, timeoutMs: 90_000 })
      await waitForStoreReady(first.page)
      await dismissOnboarding(first.page)
      await first.page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
        store.getState().openSuperPanel()
      }, sessionId)
      const review = first.page.locator('.super-collab-banner.is-review')
      await expect(review).toBeVisible({ timeout: 10_000 })
      await expect(review).toContainText('待核对')
      await expect(review).toContainText('执行「写文件」第 1 次尝试')
      await first.page.getByRole('button', { name: '标记已核对' }).click()
      await expect(review).toHaveCount(0, { timeout: 10_000 })
      const afterConfirm = JSON.parse(
        readFileSync(join(dataDir, 'collaboration', 'projects', `${projectId}.json`), 'utf8')
      ) as { actions: Array<{ status: string; confirmedBy?: string }> }
      expect(afterConfirm.actions[0]).toMatchObject({ status: 'done', confirmedBy: 'user' })
      await first.close()
      first = null

      // 同一数据目录重开：已核对动作不重新执行，也不再出现待核对
      second = await launchMorrow({ name: 'collab-review-2', dataDir, timeoutMs: 90_000 })
      await waitForStoreReady(second.page)
      await dismissOnboarding(second.page)
      await second.page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
        store.getState().openSuperPanel()
      }, sessionId)
      await expect(second.page.locator('.super-collab-banner.is-review')).toHaveCount(0)
      const afterReopen = JSON.parse(
        readFileSync(join(dataDir, 'collaboration', 'projects', `${projectId}.json`), 'utf8')
      ) as { actions: Array<{ status: string; confirmedBy?: string }> }
      expect(afterReopen.actions[0]).toMatchObject({ status: 'done', confirmedBy: 'user' })
    } finally {
      if (first) await first.close()
      if (second) await second.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('@core:swarm 重开只恢复待办任务：完成项不重跑、执行项转核对、排队项可继续', async () => {
    test.setTimeout(180_000)
    const dataDir = join(root, 'tmp', `data-collab-restart-${Date.now()}`)
    const projectId = 'project_restartabcd'
    const sessionId = 's_collab_restart01'
    const at = Date.now() - 5_000
    const taskA = {
      id: 'a',
      taskId: 'task_done00000001',
      index: 0,
      title: '完成项',
      prompt: 'a',
      role: 'general',
      status: 'completed',
      dependsOn: [],
      attempts: 1,
      currentAttemptId: 'attempt_done00000001_a1',
      attemptHistory: [
        {
          id: 'attempt_done00000001_a1',
          taskId: 'task_done00000001',
          attempt: 1,
          status: 'delivered',
          startedAt: at,
          finishedAt: at + 100,
          source: 'router',
          summary: '成果已保存'
        }
      ],
      statusHistory: [
        {
          id: 'attempt_done00000001_a1:delivered',
          taskId: 'task_done00000001',
          attemptId: 'attempt_done00000001_a1',
          to: 'delivered',
          at: at + 100,
          source: 'worker'
        }
      ],
      summary: '成果已保存'
    }
    const taskB = {
      id: 'b',
      taskId: 'task_run000000002',
      index: 1,
      title: '执行项',
      prompt: 'b',
      role: 'general',
      status: 'running',
      dependsOn: [],
      attempts: 1,
      currentAttemptId: 'attempt_run000000002_a1',
      attemptHistory: [
        {
          id: 'attempt_run000000002_a1',
          taskId: 'task_run000000002',
          attempt: 1,
          status: 'running',
          startedAt: at + 200,
          source: 'router'
        }
      ],
      statusHistory: [
        {
          id: 'attempt_run000000002_a1:running',
          taskId: 'task_run000000002',
          attemptId: 'attempt_run000000002_a1',
          to: 'running',
          at: at + 200,
          source: 'router'
        }
      ],
      waitingForApproval: true,
      waitingApprovalSince: at + 220
    }
    const taskC = {
      id: 'c',
      taskId: 'task_wait00000003',
      index: 2,
      title: '排队项',
      prompt: 'c',
      role: 'general',
      status: 'queued',
      dependsOn: [],
      attempts: 0,
      statusHistory: [
        {
          id: 'task_wait00000003:waiting',
          taskId: 'task_wait00000003',
          to: 'waiting',
          at: at + 300,
          source: 'router'
        }
      ]
    }
    const superAgent = {
      runId: 'super_restart_e2e',
      projectId,
      revision: 5,
      goal: '重开恢复验收',
      status: 'running',
      createdAt: at,
      updatedAt: at + 300,
      tasks: [taskA, taskB, taskC]
    }
    const actions = [
      {
        id: 'action_attempt_done00000001_a1',
        projectId,
        taskId: taskA.taskId,
        attemptId: taskA.currentAttemptId,
        kind: 'execute_attempt',
        label: '执行「完成项」第 1 次尝试',
        status: 'done',
        idempotencyKey: taskA.currentAttemptId,
        createdAt: at,
        updatedAt: at + 100,
        startedAt: at,
        executedAt: at + 100,
        confirmedAt: at + 100,
        confirmedBy: 'system',
        result: '成果已保存'
      },
      {
        id: 'action_attempt_run000000002_a1',
        projectId,
        taskId: taskB.taskId,
        attemptId: taskB.currentAttemptId,
        kind: 'execute_attempt',
        label: '执行「执行项」第 1 次尝试',
        status: 'running',
        idempotencyKey: taskB.currentAttemptId,
        createdAt: at + 200,
        updatedAt: at + 200,
        startedAt: at + 200
      }
    ]
    const session = {
      id: sessionId,
      title: '重开恢复测试',
      workspace: null,
      model: { providerId: '', modelId: '' },
      permissionMode: 'auto',
      mode: 'work',
      superMode: true,
      createdAt: at,
      updatedAt: at + 300,
      messageCount: 0,
      messages: [],
      todos: [],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      superAgent
    }
    const taskSeed = [taskA, taskB, taskC].map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      attempts: task.attempts
    }))
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
    mkdirSync(join(dataDir, 'collaboration', 'projects'), { recursive: true })
    writeFileSync(join(dataDir, 'sessions', `${sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
    writeFileSync(
      join(dataDir, 'collaboration', 'projects', `${projectId}.json`),
      JSON.stringify(
        {
          version: 1,
          projectId,
          sessionId,
          workspace: null,
          title: session.title,
          createdAt: at,
          updatedAt: at + 300,
          revision: 5,
          superAgent,
          actions,
          messages: []
        },
        null,
        2
      ),
      'utf8'
    )
    const readProjection = async (app: MorrowApp): Promise<Record<string, any>> => {
      const result = await app.page.evaluate(async (pid: string) => {
        const api = (window as unknown as { morrow?: { collaboration?: { projection(id: string): Promise<unknown> } } }).morrow
        return api?.collaboration?.projection(pid)
      }, projectId)
      return result as Record<string, any>
    }
    const readPersistedTable = (): Array<Record<string, unknown>> => {
      const persisted = JSON.parse(readFileSync(join(dataDir, 'sessions', `${sessionId}.json`), 'utf8')) as {
        superAgent?: { tasks?: Array<Record<string, any>> }
      }
      return (persisted.superAgent?.tasks ?? []).map((task) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        attempts: task.attempts,
        attemptsHistory: (task.attemptHistory ?? []).map(
          (attempt: Record<string, any>) => `${attempt.attempt}:${attempt.status}`
        )
      }))
    }
    const openCockpit = async (app: MorrowApp): Promise<void> => {
      await waitForStoreReady(app.page)
      await dismissOnboarding(app.page)
      await app.page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
        store.getState().openSuperPanel()
      }, sessionId)
      await expect(app.page.locator('.super-dock .super-task')).toHaveCount(3, { timeout: 20_000 })
    }
    let first: MorrowApp | null = null
    let second: MorrowApp | null = null
    try {
      first = await launchMorrow({ name: 'collab-restart-1', dataDir, timeoutMs: 90_000 })
      await openCockpit(first)
      const rows = first.page.locator('.super-dock .super-task')
      const aRow = rows.filter({ hasText: '完成项' })
      const bRow = rows.filter({ hasText: '执行项' })
      const cRow = rows.filter({ hasText: '排队项' })
      await expect(aRow).toHaveClass(/is-completed/)
      await expect(bRow).toHaveClass(/is-cancelled/)
      await expect(cRow).toHaveClass(/is-queued/)
      await expect(bRow).toContainText('应用重启')
      await expect(aRow.locator('.super-task-retry')).toHaveCount(0)
      await expect(bRow.locator('.super-task-retry')).toHaveCount(1)
      await expect(cRow.locator('.super-task-retry')).toHaveCount(1)
      const firstProjection = await readProjection(first)
      expect(firstProjection.ok).toBe(true)
      expect((firstProjection.data as { pending: Array<{ taskId: string }> }).pending.map((action) => action.taskId)).toEqual([
        taskC.taskId
      ])
      expect(
        (firstProjection.data as { uncertain: Array<{ taskId: string }> }).uncertain.map((action) => action.taskId)
      ).toEqual([taskB.taskId])
      const afterRestart = readPersistedTable()
      await first.page.waitForTimeout(500)
      await first.page.screenshot({ path: screenshotPath('super-agent-restart-recovered.png') })
      await first.close()
      first = null

      // 第二次重开：状态已收口，不重复生成 attempt/待办，也不把完成项再跑一遍。
      second = await launchMorrow({ name: 'collab-restart-2', dataDir, timeoutMs: 90_000 })
      await openCockpit(second)
      const secondRows = second.page.locator('.super-dock .super-task')
      await expect(secondRows.filter({ hasText: '完成项' })).toHaveClass(/is-completed/)
      await expect(secondRows.filter({ hasText: '执行项' })).toHaveClass(/is-cancelled/)
      await expect(secondRows.filter({ hasText: '排队项' })).toHaveClass(/is-queued/)
      const secondProjection = await readProjection(second)
      expect(secondProjection.ok).toBe(true)
      expect((secondProjection.data as { pending: unknown[] }).pending).toHaveLength(1)
      expect((secondProjection.data as { uncertain: unknown[] }).uncertain).toHaveLength(1)
      const afterSecondReopen = readPersistedTable()
      expect(afterSecondReopen).toEqual(afterRestart)
      const evidence = {
        capturedAt: new Date().toISOString(),
        projectId,
        beforeClose: taskSeed,
        afterFirstReopen: afterRestart,
        afterSecondReopen,
        projection: {
          pendingTaskIds: (secondProjection.data as { pending: Array<{ taskId: string }> }).pending.map(
            (action) => action.taskId
          ),
          uncertainTaskIds: (secondProjection.data as { uncertain: Array<{ taskId: string }> }).uncertain.map(
            (action) => action.taskId
          )
        },
        retryButtons: { done: 0, cancelled: 1, queued: 1 }
      }
      mkdirSync(join(root, 'test-results'), { recursive: true })
      writeFileSync(
        join(root, 'test-results', 't07-reopen-evidence.json'),
        JSON.stringify(evidence, null, 2),
        'utf8'
      )
    } finally {
      if (first) await first.close()
      if (second) await second.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// ── T05：派工立即返回、后台继续、单项停止 ─────────────────────────────
test.describe('background-dispatch.spec.ts', () => {
  test('@core:swarm 派工后 Router 继续接话：B 未结束时接收新任务，单项停止不影响 A/C/D', async () => {
    test.setTimeout(180_000)
    let routerCalls = 0
    const mock = await startMockLLM({
      respond: (ctx: { body: unknown; lastUserMessageText?: string }) => {
        const raw = JSON.stringify(ctx.body ?? {})
        if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
          routerCalls += 1
          if (routerCalls === 1) {
            return {
              text: '已派发 A/B/C，任务编号见驾驶舱；B 还在后台。',
              toolCalls: [
                {
                  name: 'swarm',
                  arguments: {
                    goal: '后台并行测试',
                    max_parallel: 2,
                    watchdog_ms: 0,
                    tasks: [
                      { id: 'a', title: '快速任务 A', prompt: '快速完成 A', deliverable: 'A 的结果', agent: 'explore' },
                      { id: 'b', title: '慢任务 B', prompt: '慢慢完成 B', deliverable: 'B 的结果', agent: 'general' },
                      {
                        id: 'c',
                        title: '汇总 C',
                        prompt: '读取 A 的摘要后完成 C',
                        deliverable: 'C 的汇总',
                        agent: 'test',
                        depends_on: ['a'],
                        needs: [{ task_id: 'a', result: 'A 的结果' }]
                      }
                    ]
                  }
                }
              ]
            }
          }
          if (routerCalls === 2) {
            return { text: '收到；B 仍在后台运行，不影响我继续接话。' }
          }
          if (routerCalls === 3) {
            return {
              text: '已收到新任务 D，任务编号见驾驶舱。',
              toolCalls: [
                {
                  name: 'swarm',
                  arguments: {
                    goal: '追加后台任务',
                    max_parallel: 2,
                    watchdog_ms: 0,
                    tasks: [{ id: 'd', title: '新任务 D', prompt: '后台完成 D', deliverable: 'D 的结果', agent: 'general' }]
                  }
                }
              ]
            }
          }
          return { text: 'D 已收到，后台继续。' }
        }
        if (raw.includes('## 集群成员')) {
          const isB = raw.includes('慢任务 B')
          const isD = raw.includes('新任务 D')
          return {
            text: isB ? 'B 完成' : isD ? 'D 完成' : '完成',
            delayMs: isB ? 6_000 : isD ? 3_000 : 300
          }
        }
        return { text: '收到。' }
      }
    })
    const workspace = join(root, 'tmp', `e2e-background-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const morrow = await launchMorrow({ name: 'background-dispatch', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: '后台派工测试'
      })
      await page.locator('.composer-super-toggle').click()
      await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
      const input = page.locator('.composer-input')
      await input.fill('先派 A/B/C，B 可以慢一点。')
      await page.keyboard.press('Enter')

      const readTasks = () =>
        page.evaluate(() => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } })
            .__morrowStore
          return (store.getState().session?.superAgent?.tasks ?? []).map((task: Record<string, any>) => ({
            title: String(task.title),
            taskId: String(task.taskId ?? task.id),
            status: String(task.status),
            startedAt: typeof task.startedAt === 'number' ? task.startedAt : null,
            finishedAt: typeof task.finishedAt === 'number' ? task.finishedAt : null
          }))
        })
      await waitUntil(async () => {
        const tasks = await readTasks()
        const a = tasks.find((task) => task.title.includes('快速任务 A'))
        const b = tasks.find((task) => task.title.includes('慢任务 B'))
        const c = tasks.find((task) => task.title.includes('汇总 C'))
        return a?.status === 'completed' && b?.status === 'running' && c?.status === 'completed'
          ? tasks
          : null
      }, 30_000, 'A/C 完成且 B 仍在运行')
      const firstTasks = await readTasks()
      const a = firstTasks.find((task) => task.title.includes('快速任务 A'))!
      const b = firstTasks.find((task) => task.title.includes('慢任务 B'))!
      const c = firstTasks.find((task) => task.title.includes('汇总 C'))!
      expect(b.startedAt ?? 0).toBeLessThanOrEqual(a.finishedAt ?? 0)
      expect(c.startedAt ?? 0).toBeGreaterThanOrEqual(a.finishedAt ?? 0)
      await waitUntil(async () => (await readStore(page)).run === null, 20_000, 'Router 首轮结束但 B 仍在后台')
      await expect(page.locator('.super-task').filter({ hasText: '慢任务 B' })).toHaveClass(/is-running/)

      await sendMessageViaStore(page, '再派一个新任务 D。')
      await waitUntil(async () => (await readTasks()).some((task) => task.title.includes('新任务 D')), 30_000, 'D 已派发')
      const withD = await readTasks()
      expect(withD).toHaveLength(4)
      expect(withD.find((task) => task.title.includes('慢任务 B'))?.status).toBe('running')
      const d = withD.find((task) => task.title.includes('新任务 D'))!
      const bRow = page.locator('.super-task').filter({ hasText: '慢任务 B' })
      await expect(bRow).toHaveClass(/is-running/)
      await bRow.locator('.super-task-stop').click()
      await waitUntil(async () => {
        const tasks = await readTasks()
        return tasks.find((task) => task.title.includes('慢任务 B'))?.status === 'cancelled' ? tasks : null
      }, 15_000, 'B 被单独停止')
      const finalTasks = await readTasks()
      for (const title of ['快速任务 A', '汇总 C', '新任务 D']) {
        expect(finalTasks.find((task) => task.title.includes(title))?.status).not.toBe('cancelled')
      }
      const bFinal = finalTasks.find((task) => task.title.includes('慢任务 B'))!
      expect(bFinal.status).toBe('cancelled')
      await waitUntil(async () => {
        const tasks = await readTasks()
        return tasks.every((task) => task.title.includes('慢任务 B') || task.status === 'completed')
          ? tasks
          : null
      }, 20_000, 'A/C/D 完成')
      const dispatchedOutputs = await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } })
          .__morrowStore
        return (store.getState().session?.messages ?? []).flatMap((message: Record<string, any>) =>
          (message.content ?? [])
            .filter((block: Record<string, any>) => block.type === 'tool_use' && block.name === 'swarm')
            .map((block: Record<string, any>) => String(block.result?.output ?? ''))
        )
      })
      expect(dispatchedOutputs.some((output) => output.includes('已派发') && /task_[0-9a-f]{12}/.test(output))).toBe(true)
      expect(routerCalls).toBeGreaterThanOrEqual(3)
      expect(d.taskId).toMatch(/^task_[0-9a-f]{12}$/)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

// ── T06：补充要求送到正确成员 ───────────────────────────────────────
test.describe('member-message.spec.ts', () => {
  test('@core:swarm 补充要求只送到测试成员，送达/已读/已采用可追踪，界面成员继续原工作', async () => {
    test.setTimeout(180_000)
    let routerCalls = 0
    const workerSteps = new Map<string, number>()
    const mock = await startMockLLM({
      respond: (ctx: { body: unknown }) => {
        const raw = JSON.stringify(ctx.body ?? {})
        if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
          routerCalls += 1
          if (routerCalls === 1) {
            return {
              text: '已派发界面成员和测试成员。',
              toolCalls: [
                {
                  name: 'swarm',
                  arguments: {
                    goal: '补充要求分派',
                    max_parallel: 2,
                    watchdog_ms: 0,
                    tasks: [
                      { id: 'a', title: '界面成员 A', prompt: '继续完成界面工作', deliverable: '界面改动与说明', agent: 'general' },
                      { id: 'b', title: '测试成员 B', prompt: '先读 note.txt，再完成测试', deliverable: '测试结果与结论', agent: 'test' }
                    ]
                  }
                }
              ]
            }
          }
          return { text: '两位成员已收到任务，测试成员的补充要求会单独投递。' }
        }
        if (raw.includes('## 集群成员')) {
          if (raw.includes('界面成员 A')) {
            return { text: '界面工作已完成。', delayMs: 300 }
          }
          const step = (workerSteps.get('b') ?? 0) + 1
          workerSteps.set('b', step)
          if (step === 1) {
            return {
              delayMs: 5_000,
              toolCalls: [{ name: 'read_file', arguments: { path: 'note.txt' } }]
            }
          }
          return { text: '已按补充要求完成测试。', delayMs: 300 }
        }
        return { text: '收到。' }
      }
    })
    const workspace = join(root, 'tmp', `e2e-member-message-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'note.txt'), '测试输入\n', 'utf8')
    const morrow = await launchMorrow({ name: 'member-message', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: '补充要求测试'
      })
      await page.locator('.composer-super-toggle').click()
      await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
      await page.locator('.composer-input').fill('派界面成员和测试成员，测试稍慢。')
      await page.keyboard.press('Enter')

      const readCollab = () =>
        page.evaluate(() => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } })
            .__morrowStore
          const state = store.getState().session
          return {
            collaboration: state?.collaboration ?? null,
            tasks: (state?.superAgent?.tasks ?? []).map((task: Record<string, any>) => ({
              title: String(task.title),
              taskId: String(task.taskId ?? task.id),
              status: String(task.status)
            }))
          }
        })
      await waitUntil(async () => {
        const { tasks } = await readCollab()
        return tasks.find((task) => task.title.includes('界面成员 A'))?.status === 'completed' &&
          tasks.find((task) => task.title.includes('测试成员 B'))?.status === 'running'
          ? tasks
          : null
      }, 30_000, '界面成员完成且测试成员仍在运行')
      const before = await readCollab()
      const testTask = before.tasks.find((task) => task.title.includes('测试成员 B'))!
      const row = page.locator('.super-task').filter({ hasText: '测试成员 B' })
      await row.locator('.super-task-main').click()
      await row.getByRole('button', { name: '补充' }).click()
      const input = row.getByLabel('给「测试成员 B」的补充要求')
      await input.fill('锁定账户时返回 423，并补充对应测试。')
      await row.getByRole('button', { name: '保存并投递' }).click()
      await expect(row).toContainText('锁定账户时返回 423')
      const sent = await readCollab()
      const message = sent.collaboration?.messages?.[0]
      expect(message).toBeTruthy()
      expect(message.taskId).toBe(testTask.taskId)
      expect(['pending', 'delivered', 'read', 'adopted']).toContain(message.status)
      // 同一 clientMessageId 重发不产生第二条
      await page.evaluate(
        async (arg: { sessionId: string; projectId: string; taskId: string; key: string }) => {
          await window.morrow.collaboration.sendMessage({
            sessionId: arg.sessionId,
            projectId: arg.projectId,
            taskId: arg.taskId,
            text: '锁定账户时返回 423，并补充对应测试。',
            clientMessageId: arg.key
          })
        },
        {
          sessionId: (await readStore(page)).session!.id,
          projectId: sent.collaboration.projectId,
          taskId: testTask.taskId,
          key: message.idempotencyKey
        }
      )
      await waitUntil(async () => {
        const { collaboration } = await readCollab()
        return collaboration?.messages?.some((item: Record<string, any>) => item.status === 'adopted') ? true : null
      }, 20_000, '补充要求已采用')
      const after = await readCollab()
      expect(after.collaboration.messages).toHaveLength(1)
      expect(after.collaboration.messages[0]).toMatchObject({
        taskId: testTask.taskId,
        status: 'adopted'
      })
      expect(typeof after.collaboration.messages[0].deliveredAt).toBe('number')
      expect(typeof after.collaboration.messages[0].readAt).toBe('number')
      expect(typeof after.collaboration.messages[0].adoptedAt).toBe('number')
      expect(after.tasks.find((task) => task.title.includes('界面成员 A'))?.status).toBe('completed')
      expect(after.tasks.find((task) => task.title.includes('测试成员 B'))?.status).toBe('completed')

      const workerBodies = mock.requests
        .map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
        .filter((body: string) => body.includes('## 集群成员'))
      const testBodies = workerBodies.filter((body: string) => body.includes('测试成员 B'))
      const uiBodies = workerBodies.filter((body: string) => body.includes('界面成员 A'))
      expect(testBodies.some((body: string) => body.includes('锁定账户时返回 423'))).toBe(true)
      expect(uiBodies.every((body: string) => !body.includes('锁定账户时返回 423'))).toBe(true)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

// ── T01：并行只读工具轨迹 ─────────────────────────────────────────────
test('@core:tools 并行只读工具并排展示，组可折叠为单行摘要', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '并行读取三个样例文件。',
        toolCalls: [
          { name: 'read_file', arguments: { path: 'README-待整理.md' } },
          { name: 'read_file', arguments: { path: '客户名单.csv' } },
          { name: 'read_file', arguments: { path: '销售明细-2026Q3.csv' } }
        ]
      },
      { text: '三个文件都读完了。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'tool-parallel', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const workspace = await page.evaluate(async () => {
      const created = await window.morrow.workspace.createDemo()
      if (!created.ok) throw new Error(created.error.message)
      return created.data.path
    })
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '并行工具 E2E' })
    await sendMessageViaStore(page, '并行读取这几个文件。')

    const group = page.locator('.spine-parallel')
    await expect(group).toBeVisible({ timeout: 15_000 })
    await expect(group.locator('.spine-parallel-head')).toContainText('3 个工具并行')
    await expect(group.locator('.spine-parallel-body .spine-row')).toHaveCount(3)
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '并行读取完成')
    await expect(group).toBeVisible()
    await page.screenshot({ path: screenshotPath('tool-parallel-group.png') })

    await group.locator('.spine-parallel-head').click()
    await expect(group.locator('.spine-parallel-body')).toBeHidden()
    await group.locator('.spine-parallel-head').click()
    await expect(group.locator('.spine-parallel-body')).toBeVisible()
  } finally {
    await morrow.close()
    await mock.close()
  }
})

// ── T04：检查点恢复 ────────────────────────────────────────────────
test('@core:sessions 检查点恢复只重跑失败步骤，跳过成功读取', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '先读一个文件，再尝试写入。',
        toolCalls: [
          { name: 'read_file', arguments: { path: 'README-待整理.md' } },
          { name: 'write_file', arguments: { path: 'blocked', content: 'now a file' } }
        ]
      },
      { text: '第一轮结束，写入没有成功。' },
      { text: '恢复后写入完成。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'checkpoint-resume', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const workspace = await page.evaluate(async () => {
      const created = await window.morrow.workspace.createDemo()
      if (!created.ok) throw new Error(created.error.message)
      return created.data.path
    })
    mkdirSync(join(workspace, 'blocked'), { recursive: true })
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '检查点恢复 E2E' })
    await sendMessageViaStore(page, '读一个文件，再写 blocked。')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '第一轮结束')

    // 让重跑时的写入目标从文件夹变成可用路径。
    rmSync(join(workspace, 'blocked'), { recursive: true, force: true })
    await page.locator('.message-meta button', { hasText: '回退' }).last().click()
    const replay = page.locator('.rewind-replay')
    await expect(replay).toBeVisible({ timeout: 10_000 })
    await expect(replay).toContainText('跳过 1')
    await expect(replay).toContainText('重跑 1')
    await expect(replay).toContainText('读取')
    await expect(replay).toContainText('写入')
    await expect(replay.getByRole('button', { name: '重跑未完成步骤' })).toBeEnabled()

    await clearEvents(page)
    await replay.getByRole('button', { name: '重跑未完成步骤' }).click()
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '恢复运行结束')
    expect(readFileSync(join(workspace, 'blocked'), 'utf8')).toBe('now a file')
    const started = (await getEvents(page)).filter(
      (event: { type?: string; block?: { name?: string } }) =>
        event.type === 'tool_started' && event.block?.name === 'write_file'
    )
    expect(started).toHaveLength(1)
    const replayBlocks = await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const messages = store.getState().session?.messages ?? []
      return messages.flatMap((message: Record<string, any>) =>
        (message.content ?? [])
          .filter((block: Record<string, any>) => block.type === 'tool_use')
          .map((block: Record<string, any>) => ({
            id: block.id,
            name: block.name,
            status: block.status,
            ok: block.result?.ok ?? null,
            error: block.result?.error ?? ''
          }))
      )
    })
    expect(replayBlocks.filter((block: { name: string }) => block.name === 'write_file').every((block: { status: string }) => block.status === 'success')).toBe(true)
    const writeRow = page.locator('.spine-row').filter({ hasText: '写入 blocked' })
    await expect(writeRow).toHaveClass(/is-success/)
    await expect(writeRow).not.toHaveClass(/is-error/)
    await expect(writeRow.locator('.spine-item')).not.toHaveCSS('border-top-color', 'rgb(194, 121, 95)')
    await page.screenshot({ path: screenshotPath('checkpoint-resume.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

// ── T05：流式中断续传 ─────────────────────────────────────────────
test('@core:providers 流式断流后保留已收文字并在轨迹里显示续接状态', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { rawSse: 'data: {"choices":[{"index":0,"delta":{"content":"第一段"}}]}\n\n' },
      { text: '第二段', delayMs: 2_500 }
    ]
  })
  const morrow = await launchMorrow({ name: 'stream-resume', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const workspace = await page.evaluate(async () => {
      const created = await window.morrow.workspace.createDemo()
      if (!created.ok) throw new Error(created.error.message)
      return created.data.path
    })
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '流式续接 E2E' })
    await sendMessageViaStore(page, '请分两段回答。')
    const reconnect = page.locator('.stream-reconnect')
    await expect(reconnect).toBeVisible({ timeout: 15_000 })
    await expect(reconnect).toContainText('已保留 3 字')
    await page.screenshot({ path: screenshotPath('stream-resume.png') })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '续接运行结束')
    const state = await readStore(page)
    const last = state.session?.messages.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.text).toContain('第一段第二段')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

// ── T07：跨会话用量趋势（轻量） ───────────────────────────────────
test('@core:providers 上下文面板底部显示近 7 日趋势并可打开用量页', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ respond: () => ({ text: '趋势测试回答。' }) })
  const morrow = await launchMorrow({ name: 'usage-trend', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const workspace = await page.evaluate(async () => {
      const created = await window.morrow.workspace.createDemo()
      if (!created.ok) throw new Error(created.error.message)
      return created.data.path
    })
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '趋势 E2E' })
    await sendMessageViaStore(page, '先产生一点用量。')
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '回答结束')
    await page.locator('.composer-ctx-ring').click()
    const trend = page.locator('.composer-ctx-trend')
    await expect(trend).toBeVisible({ timeout: 10_000 })
    await expect(trend).toContainText('近 7 日')
    await expect(trend).toContainText('tokens')
    await expect(trend).toContainText('今天')
    await expect(trend).toContainText('查看用量')
    await page.screenshot({ path: screenshotPath('usage-trend.png') })
    await trend.click()
    await expect(page.locator('.token-activity')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.token-activity')).toContainText('近 7 天')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:memory 记忆中心支持相关度排序、语义搜索与重要性星级', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({ respond: () => ({ text: '记忆测试回答。' }) })
  const morrow = await launchMorrow({ name: 'memory-semantic', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const workspace = await page.evaluate(async () => {
      const created = await window.morrow.workspace.createDemo()
      if (!created.ok) throw new Error(created.error.message)
      return created.data.path
    })
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '记忆语义 E2E' })

    const now = Date.now()
    const episodes = [
      {
        id: 'ep_sales',
        scope: 'project',
        workspace,
        title: '整理季度销售报表',
        intent: '把季度销售数据整理成报告',
        summary: '按季度汇总销售额，保留两位小数，生成 out/report.md。',
        outcome: 'completed',
        tools: ['read_file', 'write_file'],
        files: ['out/report.md'],
        tags: ['报表'],
        importance: 3,
        lastUsedAt: 0,
        useCount: 2,
        sourceSessionId: 'seed',
        sourceSessionTitle: '季度报表',
        sourceMessageId: 'seed-sales',
        createdAt: now - 3 * 86_400_000,
        updatedAt: now - 3 * 86_400_000,
        enabled: true
      },
      {
        id: 'ep_login',
        scope: 'project',
        workspace,
        title: '修复登录报错',
        intent: '登录失败时给出可读提示',
        summary: '统一错误提示，避免把网络错误显示成密码错误。',
        outcome: 'completed',
        tools: ['read_file', 'write_file'],
        files: ['src/auth.ts'],
        tags: ['修复'],
        importance: 2,
        lastUsedAt: 0,
        useCount: 0,
        sourceSessionId: 'seed',
        sourceSessionTitle: '登录修复',
        sourceMessageId: 'seed-login',
        createdAt: now - 2 * 86_400_000,
        updatedAt: now - 2 * 86_400_000,
        enabled: true
      },
      {
        id: 'ep_color',
        scope: 'project',
        workspace,
        title: '调整界面配色',
        intent: '把设置页强调色换成墨绿',
        summary: '调整设置页强调色，保持对比度。',
        outcome: 'completed',
        tools: ['read_file', 'write_file'],
        files: ['src/settings.css'],
        tags: ['界面'],
        importance: 1,
        lastUsedAt: 0,
        useCount: 0,
        sourceSessionId: 'seed',
        sourceSessionTitle: '配色调整',
        sourceMessageId: 'seed-color',
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000,
        enabled: true
      }
    ]
    mkdirSync(join(workspace, '.morrow'), { recursive: true })
    writeFileSync(
      join(workspace, '.morrow', 'episodes.json'),
      JSON.stringify({ version: 1, entries: episodes, forgotten: 0 }, null, 2),
      'utf8'
    )

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'memory' } }))
    })
    await expect(page.locator('.mc-root')).toBeVisible({ timeout: 10_000 })

    await expect(page.getByText('这个项目还没有记忆')).toBeVisible()
    const search = page.locator('.mc-search input')
    await search.fill('绝不会存在的记忆')
    await expect(page.getByText('没有匹配「绝不会存在的记忆」的记忆')).toBeVisible({ timeout: 5_000 })
    await page.locator('.mc-link-button').click()
    await expect(page.getByText('这个项目还没有记忆')).toBeVisible()

    await page.getByRole('radio', { name: '任务经验' }).click()
    await expect(page.locator('.mc-episode')).toHaveCount(3, { timeout: 10_000 })
    await expect(page.locator('.mc-embedding')).toBeVisible()
    await expect(page.locator('.mc-star')).toHaveCount(9)

    await expect(page.getByRole('button', { name: '最相关' })).toHaveAttribute('aria-pressed', 'true')
    const titles = page.locator('.mc-episode-title')
    await expect(titles.first()).toContainText('整理季度销售报表')

    await search.fill('销售')
    await expect(page.locator('.mc-episode')).toHaveCount(1, { timeout: 10_000 })
    await expect(page.locator('.mc-episode mark').first()).toBeVisible()
    await expect(page.locator('.mc-hit-score')).toBeVisible()
    await page.locator('.toast-close').click({ timeout: 1_000 }).catch(() => undefined)
    await waitForDefaultWindowSize(morrow.app)
    await page.screenshot({ path: screenshotPath('memory-semantic.png') })

    await page.locator('.mc-search-clear').click()
    await page.getByRole('button', { name: '最近', exact: true }).click()
    await expect(page.getByRole('button', { name: '最近', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.mc-episode-title').first()).toContainText('调整界面配色')

    const color = page.locator('.mc-episode', { hasText: '调整界面配色' })
    await color.locator('.mc-star').nth(2).click()
    await expect(color.locator('.mc-star').nth(2)).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 })
    await waitUntil(
      async () => {
        const raw = readFileSync(join(workspace, '.morrow', 'episodes.json'), 'utf8')
        const parsed = JSON.parse(raw) as { entries: { id: string; importance: number }[] }
        return parsed.entries.find((entry) => entry.id === 'ep_color')?.importance === 3
      },
      10_000,
      '重要性写入磁盘'
    )

    await search.fill('火箭发射窗口')
    await expect(page.getByText('没有匹配「火箭发射窗口」的任务经验')).toBeVisible({ timeout: 10_000 })
    await page.locator('.mc-link-button').click()
    await expect(page.locator('.mc-episode')).toHaveCount(3, { timeout: 10_000 })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:swarm Worker 可向主代理提问、回消息、维护待办并重新激活', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('## Super-Agent') && !raw.includes('## 集群成员')) {
        mainCalls += 1
        if (mainCalls === 1) {
          return {
            text: '我派一个 Worker 定位登录入口。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '定位登录入口',
                  max_parallel: 1,
                  watchdog_ms: 0,
                  tasks: [
                    {
                      id: 'a',
                      title: '定位登录入口',
                      prompt: '定位登录入口并确认兼容策略',
                      deliverable: '入口文件与兼容结论',
                      files: ['src/login.ts'],
                      agent: 'explore'
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: 'Super-Agent 完成：Worker 已定位入口。' }
      }
      if (raw.includes('## 集群成员')) {
        if (raw.includes('【主代理新指令】')) {
          return { text: '重新激活完成：已按新指令补了回归测试。' }
        }
        if (raw.includes('主代理答复：')) {
          return { text: '收到答复，Worker 完成：保留旧接口并补了测试。' }
        }
        return {
          text: '我先确认兼容策略。',
          toolCalls: [
            {
              name: 'worker_todo_write',
              arguments: {
                todos: [
                  { text: '读取登录入口', status: 'completed' },
                  { text: '确认兼容策略', status: 'in_progress' }
                ]
              }
            },
            { name: 'write_file', arguments: { path: 'src/login.ts', content: 'export const login = true\n' } },
            { name: 'worker_ask', arguments: { text: '要保留旧端口吗？' } }
          ]
        }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-worker-collab-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'worker-collab', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: 'Worker 协作测试' })
    await page.evaluate(async () => {
      const result = await window.morrow.settings.update({ collaborationMaxWorkers: 4 })
      if (!result.ok) throw new Error(result.error.message)
    })
    await page.locator('.composer-super-toggle').click()
    await expect(page.locator('.super-dock')).toBeVisible({ timeout: 10_000 })
    const input = page.locator('.composer-input')
    await input.fill('定位登录入口，确认是否保留旧端口。')
    await page.keyboard.press('Enter')

    await expect(page.locator('.super-dock .super-task')).toHaveCount(1, { timeout: 20_000 })
    await page.locator('.super-task-main').first().click()
    await expect(page.locator('.super-msg-list')).toContainText('要保留旧端口吗？', { timeout: 30_000 })
    await expect(page.locator('.super-worker-todos')).toContainText('确认兼容策略')
    await expect(page.locator('.super-op-diff')).toBeVisible({ timeout: 15_000 })
    await page.locator('.super-op-diff summary').click()
    await page.locator('.super-op-diff').scrollIntoViewIfNeeded()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('worker-live-diff.png') })

    await page.getByRole('button', { name: '答复' }).click()
    const replyBox = page.locator('.super-msg-form textarea')
    await replyBox.fill('保留，只补回归测试。')
    await page.getByRole('button', { name: '发送答复' }).click()

    await expect(page.locator('.super-task.is-completed')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.locator('.super-worker-todos')).toContainText('读取登录入口')
    await expect(page.locator('.super-msg-list')).toContainText('保留，只补回归测试。')

    await page.getByRole('button', { name: /重新激活任务/ }).click()
    const reactivateBox = page.locator('.super-msg-form textarea')
    await reactivateBox.fill('再补一个回归测试。')
    await page.locator('.super-msg-form').getByRole('button', { name: '重新激活' }).click()

    await waitUntil(
      async () => {
        const state = await readStore(page)
        const task = state.session?.superAgent?.tasks?.[0]
        return state.run === null && task?.status === 'completed' && (task.attempts ?? 0) >= 2
      },
      90_000,
      'Worker 重新激活完成'
    )
    const bodies = mock.requests.map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
    expect(bodies.some((body: string) => body.includes('【主代理新指令】再补一个回归测试'))).toBe(true)
    expect(bodies.some((body: string) => body.includes('收到答复，Worker 完成'))).toBe(true)
    await expect(page.locator('.super-task')).toContainText('第 2 次尝试')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.super-worker-todos').scrollIntoViewIfNeeded()
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('worker-collaboration.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:memory 任务完成后自动沉淀经验，可查看/撤销', async () => {
  test.setTimeout(180_000)
  let taskCalls = 0
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('任务经验整理器')) {
        return {
          text: '{"entries":[{"title":"登录入口修复","intent":"修复登录入口","summary":"统一错误提示并补一个回归测试。","tags":["登录","测试"],"files":["src/login.ts"]}]}'
        }
      }
      if (raw.includes('写一个登录入口')) {
        taskCalls += 1
        if (taskCalls === 1) {
          return {
            text: '我写一个登录入口并补测试。',
            toolCalls: [
              { name: 'write_file', arguments: { path: 'src/login.ts', content: 'export const login = true\n' } }
            ]
          }
        }
        return { text: '登录入口已写好，并补了回归测试。' }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `e2e-memory-capture-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'memory-capture', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '经验沉淀测试' })
    await page.evaluate(async () => {
      const result = await window.morrow.settings.update({ episodeMemoryEnabled: true })
      if (!result.ok) throw new Error(result.error.message)
    })
    await sendMessageViaStore(page, '写一个登录入口，并补测试。')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '登录任务完成')

    const bar = page.locator('.memory-capture-bar')
    await expect(bar).toBeVisible({ timeout: 60_000 })
    await expect(bar).toContainText('已沉淀')
    await expect(bar.getByRole('button', { name: '查看' })).toBeVisible()
    await expect(bar.getByRole('button', { name: '撤销' })).toBeVisible()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('memory-capture.png') })

    await bar.getByRole('button', { name: '查看' }).click()
    await expect(page.locator('.mc-root')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('radio', { name: '任务经验' }).click()
    await expect.poll(() => page.locator('.mc-episode').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect(page.locator('.mc-episode').first()).toContainText('登录入口')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)

    await bar.getByRole('button', { name: '撤销' }).click()
    await expect(bar).toHaveCount(0, { timeout: 10_000 })
    const afterUndo = await page.evaluate(async (workspace: string) => {
      const result = await window.morrow.features.invoke<{ entries: unknown[] }>('feature:memory:episodes', {
        scope: 'project',
        workspace,
        includeDisabled: true
      })
      if (!result.ok) throw new Error(result.error.message)
      return result.data.entries.length
    }, workspace)
    expect(afterUndo).toBe(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:tools 更多功能中的全部功能子页展示真实工具清单与审批方式', async () => {
  test.setTimeout(90_000)
  const morrow = await launchMorrow({ name: 'tool-catalog', waitForSelector: '.sidebar' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
      store.getState().openSettings()
    })
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('tab', { name: '更多功能' }).click()

    const toolsPage = settings.locator('.st-tools')
    await expect(toolsPage).toBeVisible({ timeout: 10_000 })
    await expect(settings.locator('.st-tool-catalog')).toHaveCount(0)
    const entry = toolsPage.getByRole('button', { name: /全部功能/ })
    await expect(entry).toBeVisible()
    await expect(entry).toHaveClass(/st-tool-row/)
    await expect(entry.locator('.st-tool-open')).toContainText('打开')
    await entry.scrollIntoViewIfNeeded()
    for (let index = 0; index < 6; index += 1) {
      if ((await page.locator('.toast-close').count()) === 0) break
      await page.locator('.toast-close').first().click().catch(() => undefined)
      await page.waitForTimeout(80)
    }
    await waitForDefaultWindowSize(morrow.app)
    await page.screenshot({ path: screenshotPath('tool-catalog-entry.png') })
    await entry.click()
    const catalog = settings.locator('.st-capability-page')
    await expect(catalog).toBeVisible({ timeout: 10_000 })
    await expect(catalog).toContainText('全部功能')
    await expect(catalog).toContainText('http_request')
    await expect(catalog).toContainText('browser_tab')
    await expect(catalog).toContainText('每次询问')

    const search = catalog.getByRole('textbox', { name: '搜索功能' })
    await search.fill('http_request')
    await expect(catalog.locator('li')).toHaveCount(1)
    await expect(catalog.locator('li')).toContainText('http_request')
    await expect(catalog.locator('li')).toContainText('需要确认')
    await catalog.getByRole('button', { name: '清除功能搜索' }).click()
    await catalog.locator('.st-sub-back').click()
    await expect(toolsPage).toBeVisible()
    await expect(settings.locator('.st-capability-page')).toHaveCount(0)

    await entry.click()
    await expect(catalog).toBeVisible()
    await catalog.evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('tool-catalog.png') })
  } finally {
    await morrow.close()
  }
})

test('@core:shortcuts 快捷键可录制改键、冲突提示并实际生效', async () => {
  test.setTimeout(90_000)
  const morrow = await launchMorrow({ name: 'shortcut-keymap' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
      store.getState().openSettings()
    })
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('tab', { name: '快捷键' }).click()
    const keymap = settings.locator('.st-keymap')
    await expect(keymap).toBeVisible({ timeout: 10_000 })

    const newSessionRow = keymap.locator('[data-shortcut="new-session"]')
    await newSessionRow.getByRole('button', { name: '修改新建对话快捷键' }).click()
    await expect(newSessionRow.getByRole('button', { name: '修改新建对话快捷键' })).toContainText('按下新组合')
    await page.keyboard.press('Control+Shift+U')
    await expect(newSessionRow.locator('.st-key-binding')).toContainText('Ctrl+Shift+U', { timeout: 10_000 })
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      if (!result.ok) throw new Error(result.error.message)
      return result.data.shortcuts
    })
    expect(saved['new-session']).toBe('CommandOrControl+Shift+U')

    await keymap.evaluate((element) => {
      let node = element.parentElement
      while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement
      if (node) node.scrollTop = 0
    })
    await page.waitForTimeout(200)
    await waitForDefaultWindowSize(morrow.app)
    await page.screenshot({ path: screenshotPath('shortcut-keymap.png') })

    const paletteRow = keymap.locator('[data-shortcut="palette"]')
    await paletteRow.getByRole('button', { name: '修改打开命令面板快捷键' }).click()
    await page.keyboard.press('Control+Shift+U')
    await expect(paletteRow.locator('.st-key-error')).toContainText('冲突', { timeout: 10_000 })
    await expect(paletteRow).toHaveClass(/is-conflict/)
    await page.screenshot({ path: screenshotPath('shortcut-conflict.png') })
    await page.keyboard.press('Escape')
    await expect(paletteRow.locator('.st-key-error')).toHaveCount(0)
    await expect(paletteRow.locator('.st-key-binding')).toContainText('Ctrl+K')
    await expect(paletteRow.getByRole('button', { name: '修改打开命令面板快捷键' })).not.toContainText('按下新组合')

    const before = (await readStore(page)).activeSessionId
    await settings.locator('.modal-close').click()
    await expect(settings).toHaveCount(0)
    await page.keyboard.press('Control+Shift+U')
    await waitUntil(async () => (await readStore(page)).activeSessionId !== before, 10_000, '自定义快捷键新建对话')
  } finally {
    await morrow.close()
  }
})

test('@core:typography 字号设置驱动侧栏、创作台协作者与代码字号', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'font-scale', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const readTokens = () =>
      page.evaluate(() => {
        const resolve = (name: string): string => {
          const probe = document.createElement('span')
          probe.style.position = 'absolute'
          probe.style.visibility = 'hidden'
          probe.style.fontSize = `var(${name})`
          document.body.appendChild(probe)
          const value = getComputedStyle(probe).fontSize
          probe.remove()
          return value
        }
        const fontSizeOf = (selector: string): string | null => {
          const element = document.querySelector(selector)
          return element ? getComputedStyle(element).fontSize : null
        }
        return {
          body: resolve('--fs-body'),
          ui: resolve('--fs-ui'),
          title: resolve('--fs-title'),
          small: resolve('--fs-3xs'),
          code: resolve('--fs-code'),
          sidebar: fontSizeOf('.sb-new-label'),
          studioBody: fontSizeOf('.studio-assistant-bubble > p')
        }
      })
    const setFontSize = async (fontSize: number): Promise<void> => {
      await page.evaluate(async (value) => {
        const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: object) => Promise<void> } } }).__morrowStore
        await store.getState().updateSettings({ fontSize: value })
      }, fontSize)
      await expect.poll(async () => (await readTokens()).body).toBe(`${fontSize}px`)
    }

    const defaults = await readTokens()
    expect(defaults).toMatchObject({ body: '14px', ui: '13px', title: '20px', small: '9px', code: '12px' })
    expect(defaults.sidebar).toBe('12.5px')

    await setFontSize(12)
    expect((await readTokens()).sidebar).toBe('10.5px')
    await setFontSize(14)

    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '雨伞铺的第七个夏天' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-center', { timeout: 30_000 })
    if (!(await page.locator('.studio-assistant').isVisible())) await page.locator('[aria-label="切换协作者面板"]').click()
    await page.waitForSelector('.studio-assistant-bubble > p', { timeout: 20_000 })

    await setFontSize(12)
    const small = await readTokens()
    expect(small).toMatchObject({ body: '12px', ui: '11px', title: '18px', small: '8px', code: '12px' })
    expect(small.studioBody).toBe('11.5px')
    await page.screenshot({ path: screenshotPath('font-scale-12.png') })

    await setFontSize(15)
    const large = await readTokens()
    expect(large).toMatchObject({ body: '15px', ui: '14px', title: '21px', small: '10px', code: '12px' })
    expect(large.studioBody).toBe('14.5px')

    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: object) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ codeFontSize: 11 })
    })
    await expect.poll(async () => (await readTokens()).code).toBe('11px')
    await page.screenshot({ path: screenshotPath('font-scale-15.png') })
  } finally {
    await morrow.close()
  }
})

test('@core:accessibility 焦点环统一、读屏播报、焦点陷阱与减少动效', async () => {
  test.setTimeout(150_000)
  const workspace = join(root, 'tmp', `e2e-a11y-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const mock = await startMockLLM({ scripts: [{ text: '收到。', delayMs: 1200 }] })
  const morrow = await launchMorrow({ name: 'a11y', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '无障碍测试' })

    const polite = page.locator('[data-a11y="polite"]')
    await expect(polite).toHaveAttribute('aria-live', 'polite')
    await sendMessageViaStore(page, '你好，简单回答即可。')
    await waitForRunStarted(page, 30_000)
    await expect(polite).toHaveText('Morrow 开始处理任务。', { timeout: 5_000 })
    await expect(page.locator('.transcript-scroll')).toHaveAttribute('aria-busy', 'true')
    await waitForRunFinished(page, 30_000)
    await expect(polite).toHaveText('Morrow 已完成本次处理。', { timeout: 10_000 })
    await expect(page.locator('.transcript-scroll')).not.toHaveAttribute('aria-busy', 'true')

    const focusToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--focus-ring-width').trim()
    )
    expect(focusToken).toBe('2px')

    await page.bringToFront()
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
      store.getState().openSettings()
    })
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible({ timeout: 10_000 })

    await settings.evaluate((panel) => {
      const nodes = Array.from(
        panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ) as HTMLElement[]
      nodes[nodes.length - 1]?.focus()
    })
    await page.keyboard.press('Tab')
    expect(await settings.evaluate((panel) => panel.contains(document.activeElement))).toBe(true)
    for (let index = 0; index < 80; index += 1) {
      const active = await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? '',
        text: document.activeElement?.textContent?.trim() ?? ''
      }))
      if (active.tag === 'BUTTON' && active.text.includes('刷新可用模型')) break
      await page.keyboard.press('Tab')
    }
    const activeElement = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? '',
      className: String((document.activeElement as HTMLElement | null)?.className ?? '')
    }))
    expect(activeElement.tag).toBe('BUTTON')
    expect(activeElement.className).toContain('btn')
    const ring = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement
      const style = getComputedStyle(element)
      return {
        width: style.outlineWidth,
        shadow: style.boxShadow,
        visible: element.matches(':focus-visible')
      }
    })
    expect(ring.visible).toBe(true)
    expect(ring.shadow).toContain('2px')
    expect(ring.shadow).not.toBe('none')
    for (let index = 0; index < 6; index += 1) {
      if ((await page.locator('.toast-close').count()) === 0) break
      await page.locator('.toast-close').first().click().catch(() => undefined)
      await page.waitForTimeout(80)
    }
    await page.screenshot({ path: screenshotPath('a11y-focus-ring.png') })
    await settings.locator('.modal-close').click()

    const probeDuration = (): Promise<string> =>
      page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.animation = 'a11y-probe 1s infinite'
        document.body.appendChild(probe)
        const duration = getComputedStyle(probe).animationDuration
        probe.remove()
        return duration
      })
    expect(await probeDuration()).toBe('1s')
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: object) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ reduceMotion: true })
    })
    await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true')
    expect(await probeDuration()).toBe('0.001s')
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: object) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ reduceMotion: false })
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await probeDuration()).toBe('0.001s')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:accessibility 桌面伙伴状态可被读屏播报', async () => {
  test.setTimeout(90_000)
  const morrow = await launchMorrow({ name: 'a11y-island', timeoutMs: 90_000, env: { MORROW_ISLAND: '1' } })
  try {
    await expect
      .poll(
        () => morrow.app.windows().find((candidate) => !candidate.isClosed() && candidate.url().includes('#island')) ?? null,
        { timeout: 15_000 }
      )
      .not.toBeNull()
    const island = morrow.app.windows().find(
      (candidate) => !candidate.isClosed() && candidate.url().includes('#island')
    )!
    const live = island.locator('[data-a11y="island"]')
    await expect(live).toHaveAttribute('role', 'status', { timeout: 15_000 })
    await expect(live).toHaveAttribute('aria-live', 'polite')
    await expect(live).toContainText('桌面伙伴')
  } finally {
    await morrow.close()
  }
})

test('@core:settings 模型页接入国内与海外云端多媒体，本地模型统一在本地页', async () => {
  test.setTimeout(90_000)
  const morrow = await launchMorrow({ name: 'cloud-media-settings', waitUntil: 'domcontentloaded' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
      store.getState().openSettings()
    })
    const settings = page.getByRole('dialog', { name: '设置' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    const cloud = settings.locator('.st-cloud-media')
    await expect(cloud).toBeVisible()
    await expect(cloud).toContainText('云端多媒体生成')
    for (const capability of ['图片生成', '视频生成', '配音生成', '配乐生成']) {
      await expect(cloud.getByRole('tab', { name: capability })).toBeVisible()
    }

    for (const name of ['Seedream 5.0 Pro', 'Seedream 5.0 Flash', 'Qwen-Image 2.1 Pro', 'Gemini Nano Banana 2.1']) {
      await expect(cloud.locator('.st-cloud-provider', { hasText: name })).toBeVisible()
    }
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'OpenAI Images 2.6' }).first()).toBeVisible()
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'OpenAI Images 2.6 Flare' })).toBeVisible()
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'Seedream 5.0 Pro' }).locator('.st-cloud-provider-region')).toHaveText('国内')
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'OpenAI Images 2.6' }).first().locator('.st-cloud-provider-region')).toHaveText('海外')
    await cloud.getByRole('tab', { name: '视频生成' }).click()
    for (const name of ['Seedance 2.5', 'Seedance 2.0', 'MiniMax H3', 'Google Veo 3.1']) {
      await expect(cloud.locator('.st-cloud-provider', { hasText: name })).toBeVisible()
    }
    await cloud.getByRole('tab', { name: '配音生成' }).click()
    const qwenSpeech = cloud.locator('.st-cloud-provider', { hasText: 'Qwen3-TTS-Flash' })
    await expect(qwenSpeech).toBeVisible()
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'MiniMax Speech 2.8 HD' })).toBeVisible()
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'OpenAI TTS' })).toBeVisible()
    await expect(cloud.locator('.st-cloud-provider', { hasText: 'ElevenLabs TTS' })).toBeVisible()
    await qwenSpeech.getByRole('button', { name: '接入' }).click()
    await expect(qwenSpeech.locator('#st-cloud-voice-qwen3-tts')).toHaveValue('Cherry')
    await expect(qwenSpeech.locator('#st-cloud-voices-qwen3-tts option')).toHaveCount(48)
    const keyField = qwenSpeech.locator('#st-cloud-key-qwen3-tts')
    await keyField.focus()
    await page.waitForTimeout(250)
    const keyStyle = await keyField.evaluate((element) => {
      const style = getComputedStyle(element)
      return { outline: style.outlineStyle, appearance: style.appearance, border: style.borderColor }
    })
    expect(keyStyle.outline).toBe('none')
    expect(keyStyle.appearance).toBe('none')
    expect(keyStyle.border).toContain('200, 174, 125')
    await keyField.fill('sk-e2e-qwen-tts')
    await qwenSpeech.getByRole('button', { name: '保存' }).click()
    await expect(qwenSpeech).toContainText('Key 已保存', { timeout: 10_000 })
    const saved = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      if (!result.ok) throw new Error(result.error.message)
      return result.data.mediaProviders
    })
    expect(saved.some((provider) => provider.id === 'qwen3-tts' && provider.apiKeyStored && provider.voice === 'Cherry')).toBe(true)
    for (let index = 0; index < 6; index += 1) {
      if ((await page.locator('.toast-close').count()) === 0) break
      await page.locator('.toast-close').first().click().catch(() => undefined)
      await page.waitForTimeout(80)
    }
    await cloud.locator('.st-cloud-media-head').evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('settings-cloud-media.png') })

    await settings.getByRole('tab', { name: '本地' }).click()
    await expect(settings.locator('.st-page-title')).toHaveText('本地')
    const localModels = settings.locator('.st-local-models')
    await expect(localModels).toBeVisible({ timeout: 10_000 })
    await localModels.getByRole('button', { name: '选择模型服务' }).click()
    const localOptions = localModels.getByRole('option')
    await expect(localOptions.filter({ hasText: 'Ollama（本地）' })).toHaveCount(1)
    await expect(localOptions.filter({ hasText: 'llama.cpp（本地）' })).toHaveCount(1)
    await expect(localOptions.filter({ hasText: 'LM Studio（本地）' })).toHaveCount(1)
    await localModels.getByRole('button', { name: '选择模型服务' }).click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('settings-local.png') })

    await settings.getByRole('tab', { name: '模型' }).click()
    await settings.getByRole('button', { name: '选择模型服务' }).click()
    await expect(settings.getByRole('option').filter({ hasText: 'Ollama（本地）' })).toHaveCount(0)
  } finally {
    await morrow.close()
  }
})
