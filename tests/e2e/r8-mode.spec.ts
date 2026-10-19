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
import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clearEvents,
  dismissOnboarding,
  getEvents,
  installEventCollector,
  readStore,
  sendMessageViaStore,
  waitForRunFinished,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil
} from './store'

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
  test('chat 硬拦截写入（文件不变）→ 切 work 真实写入 → 运行中拒绝切换 → Goal 不可用 → 重启保持', async () => {
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
      await expect(page.locator('.composer-hint')).toContainText(/只讨论/)
      await expect(page.locator('.tb-mode')).toContainText('聊天')
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
      // 泛化断言：聊天模式工具列表里不允许出现任何写入/执行/记忆/目标/计划/子代理类工具
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
      await expect(page.locator('.tb-mode')).toContainText('工作')
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
      await expect(page.locator('.tb-mode')).toContainText('聊天')
      await expect(page.locator('.composer-perm-lock')).toBeVisible()
      await expect(page.locator('.composer-bar-left .icon-btn[aria-label*="目标"]')).toHaveCount(0)
      await page.screenshot({ path: screenshotPath('r8-mode-restart-persist.png') })
    } finally {
      await second.close()
      await mock.close()
    }
  })
})
