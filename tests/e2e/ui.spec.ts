// ui 领域 E2E：由 5 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import type { MorrowApp } from './launch'
import { launchMorrow, root, screenshotPath } from './launch'
import { configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil, clearEvents, openToolPanel } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import type { Server, IncomingMessage } from 'node:http'
import { createServer } from 'node:http'
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

  test('@core:settings 设置：模型服务选择 / 上下文 Tab / 自动压缩开关', async () => {
    morrow = await launchMorrow({ name: 'r5-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore.getState().openSettings()
    })
    const dialog = page.locator('[role="dialog"]').first()
    await expect(dialog).toBeVisible()

    // 服务选择器包含所有服务；当前默认模型与 DeepSeek 模型可见
    await dialog.getByRole('button', { name: '选择模型服务' }).click()
    const providerOptions = dialog.getByRole('option')
    expect(await providerOptions.count()).toBeGreaterThanOrEqual(14)
    for (const provider of ['DeepSeek', 'Kimi（月之暗面）', '通义千问（阿里云）', '智谱 GLM（Z.AI）', 'MiniMax', '小米 MiMo', 'Anthropic Claude', 'OpenAI', 'Google Gemini', 'xAI Grok', 'Meta（Muse）', 'llama.cpp（本地）', 'Ollama（本地）', 'LM Studio（本地）']) {
      await expect(dialog.getByText(provider, { exact: true }).first()).toBeVisible()
    }
    // OpenRouter 是中转聚合，不是官方或本地模型，不再出现在服务列表
    await expect(providerOptions.filter({ hasText: 'OpenRouter' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '选择模型服务' }).click()
    await expect(dialog.getByText(/填上 API Key 就能用/)).toBeVisible()
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
    await expect(dialog.getByText('自动压缩').first()).toBeVisible()
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
 * 1. 从设置 → 功能与工具打开连接器面板；
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
    .getByRole('dialog', { name: '外部工具（MCP）' })
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
    const swarmRow = page.locator('.spine-row').filter({ hasText: '集群' }).first()
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
    await expect(swarmRow.getByText('集群成员', { exact: true })).toBeVisible()
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

})
})
