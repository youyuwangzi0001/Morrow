// chat 领域 E2E：由 3 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { clearEvents, clickPermissionCard, configureMockProvider, createSession, dismissOnboarding, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForPermission, waitForRunFinished, waitForRunStarted, waitForStoreReady, waitUntil } from './store'

test.describe("02-chat", () => {
// ── 原文件：chat-attachments.spec.ts ──────────────────────────────────────────────
test.describe('chat-attachments.spec.ts', () => {
/**
 * 对话附件链路回归：图片进入模型多模态输入、对话内可见；
 * 附件正文只进入模型上下文，不出现在用户气泡；附件元数据持久化。
 */

const imagePath = join(root, 'build', 'icon.png')
const imageBase64 = readFileSync(imagePath).toString('base64')
const imageSize = statSync(imagePath).size

test.describe('对话附件链路', () => {
  test('@core:attachments 图片可见、附件元数据可见、内部正文不进入气泡', async () => {
    test.setTimeout(180_000)
    const workspace = join(root, 'tmp', `e2e-attachments-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({ scripts: [{ text: '我已收到并查看了附件。' }] })
    const morrow = await launchMorrow({ name: 'chat-attachments', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '附件测试' })
      await installEventCollector(page)

      await page.evaluate(
        async (arg: { imageBase64: string; imagePath: string; imageSize: number }) => {
          const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          await store.getState().sendMessage('请看附件里的资料', [
            {
              id: 'att_image',
              name: 'quarterly-chart.png',
              path: arg.imagePath,
              size: arg.imageSize,
              kind: 'image',
              mediaType: 'image/png',
              content: `data:image/png;base64,${arg.imageBase64}`
            },
            {
              id: 'att_text',
              name: 'internal-notes.md',
              path: 'C:\\tmp\\internal-notes.md',
              size: 42,
              kind: 'text',
              content: '内部资料正文-不应出现在气泡',
              truncated: true,
              note: '内容过长，仅发送前 120,000 字符'
            }
          ])
        },
        { imageBase64, imagePath, imageSize }
      )
      await waitForRunFinished(page, 90_000)

      const bubble = page.locator('.message-user-bubble').last()
      await expect(bubble).toContainText('请看附件里的资料')
      await expect(bubble).not.toContainText('[附件]')
      await expect(bubble).not.toContainText('内部资料正文')
      await expect(bubble).not.toContainText('图片已作为视觉输入')
      await expect(page.locator('.message-user-image').last()).toBeVisible()
      await expect(page.locator('.message-user-attachment')).toHaveCount(1)
      await expect(page.locator('.message-user-attachment').last()).toContainText('internal-notes.md')
      await expect(page.locator('.message-user-attachment.is-warn')).toHaveCount(1)

      const persisted = await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const current = store.getState().session
        const loaded = await window.morrow.session.load(current.id)
        if (!loaded.ok) throw new Error(loaded.error.message)
        const user = [...loaded.data.messages].reverse().find((message) => message.role === 'user')
        return {
          displayText: user?.displayText,
          imageCount: user?.images?.length ?? 0,
          imageName: user?.images?.[0]?.name,
          attachmentNames: (user?.attachments ?? []).map((attachment) => attachment.name)
        }
      })
      expect(persisted.displayText).toBe('请看附件里的资料')
      expect(persisted.imageCount).toBe(1)
      expect(persisted.imageName).toBe('quarterly-chart.png')
      expect(persisted.attachmentNames).toEqual(['quarterly-chart.png', 'internal-notes.md'])

      const first = mock.requests[0] as { body?: { messages?: Array<{ role: string; content: unknown }> } }
      const modelUser = first?.body?.messages?.find((message) => message.role === 'user')
      expect(JSON.stringify(modelUser?.content)).toContain('image_url')
      expect(JSON.stringify(modelUser?.content)).toContain('内部资料正文')
      expect(JSON.stringify(modelUser?.content)).toContain('图片已作为视觉输入')

      const state = await readStore(page)
      expect(state.run).toBeNull()
      await expect(page.getByText('我已收到并查看了附件。')).toBeVisible()
      await page.locator('[aria-label="收起通知"]').last().click().catch(() => undefined)
      await page.evaluate(() => {
        const scroller = document.querySelector('.transcript-scroll') as HTMLElement | null
        if (scroller) scroller.scrollTop = scroller.scrollHeight
      })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(700)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(700)
      await page.screenshot({ path: screenshotPath('quality-chat-attachments-dark.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
// ── 原文件：message-queue.spec.ts ──────────────────────────────────────────────
test.describe('message-queue.spec.ts', () => {
/**
 * P0-5 运行中排队与引导：
 * - 运行中输入 Enter 进入队列；
 * - 队列可编辑/删除；
 * - 本轮正常结束后自动发送队首消息；
 * - 「打断并发送」立即停止当前运行并发新消息。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

function userTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { session: { messages: Array<Record<string, any>> } | null } }
    }).__morrowStore
    const session = store.getState().session
    return (session?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => String(message.displayText ?? message.content?.find((block: any) => block.type === 'text')?.text ?? ''))
  })
}

test('@core:agent 运行中排队：编辑、删除、本轮结束后自动发送', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '第一轮完成。', delayMs: 12_000 },
      { text: '排队消息已处理。' },
      { text: '队列清空。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'message-queue', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: workspaceAt('e2e-queue'),
      ...provider,
      permissionMode: 'auto',
      title: '排队测试'
    })

    await page.locator('.composer-input').fill('第一条任务')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /正在处理/)
    await expect(page.locator('.composer-send.is-stop')).toBeVisible()
    // 空输入时闪电仍在原位（禁用），与「点闪电插话」引导一致
    const zap = page.locator('.composer-send.is-interrupt')
    await expect(zap).toBeVisible()
    await expect(zap).toBeDisabled()
    await expect(page.locator('.composer-input')).toHaveAttribute('placeholder', /点闪电插话/)

    await page.locator('.composer-input').fill('第二条消息')
    await expect(zap).toBeEnabled()
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.queue-tray')).toBeVisible()
    await expect(page.locator('.queue-tray')).toContainText('第二条消息')

    await page.locator('.composer-input').fill('第三条消息')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.queue-item')).toHaveCount(2)

    // 编辑第二条
    await page.locator('.queue-item').nth(1).getByLabel('编辑这条排队消息').click()
    await page.locator('.queue-input').fill('第三条消息（已修改）')
    await page.locator('.queue-edit-actions').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.queue-tray')).toContainText('第三条消息（已修改）')

    // 删除第一条
    await page.locator('.queue-item').first().getByLabel('删除这条排队消息').click()
    await expect(page.locator('.queue-item')).toHaveCount(1)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('queue-tray-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('queue-tray-light.png') })
    await setThemeViaStore(page, 'dark')

    // 第一轮完成 → 自动发送剩下的排队消息
    await expect(page.getByText('排队消息已处理。')).toBeVisible({ timeout: 60_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '排队消息运行结束')
    await expect(page.locator('.queue-tray')).toHaveCount(0)
    const texts = await userTexts(page)
    expect(texts).toContain('第一条任务')
    expect(texts).toContain('第三条消息（已修改）')
    expect(texts).not.toContain('第二条消息')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：cross-session-run.spec.ts ──────────────────────────────────────────────
test.describe('cross-session-run.spec.ts', () => {
/**
 * 跨会话运行态回归：A 在等待审批时切到 B，审批不丢；
 * B 显示后台运行/待确认提示与会话行标记，返回 A 后可继续批准并完成。
 */

test.describe('跨会话运行态', () => {
  test('@core:permissions A 等待审批时切到 B：提示保留、返回可批准、完成后后台状态清理', async () => {
    test.setTimeout(90_000)
    const workspace = join(root, 'tmp', `e2e-cross-session-ws-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [
        {
          text: '我先写一个文件。',
          toolCalls: [{ name: 'write_file', arguments: { path: '../cross.md', content: 'from session A' } }]
        },
        { text: '写好了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'cross-session-run', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      await installEventCollector(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      const sessionA = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '跨会话 A'
      })
      const sessionB = await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'ask',
        title: '跨会话 B'
      })
      await page.evaluate(async (id: string) => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().selectSession(id)
      }, sessionA)

      await sendMessageViaStore(page, '请在 A 会话里写 cross.md。')
      await waitForRunStarted(page, 30_000)
      const permission = await waitForPermission(page, 30_000)
      expect(permission.toolName).toBe('write_file')

      // 通过真实侧栏切到 B（A 仍在等待审批）
      const rowB = page.locator('.sb-session').filter({ hasText: '跨会话 B' }).locator('.sb-session-main')
      await rowB.click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切换到会话 B')

      const background = page.locator('.composer-background')
      await expect(background).toBeVisible({ timeout: 10_000 })
      await expect(background).toContainText('跨会话 A')
      await expect(background).toContainText('等待你的确认')
      await expect(page.locator('.sb-session').filter({ hasText: '跨会话 A' }).locator('.sb-session-flag.is-attention')).toBeVisible()
      await expect(page.locator('.permission-card')).toHaveCount(0)
      await expect(background.getByRole('button', { name: '返回处理' })).toBeVisible()
      await expect(background.getByRole('button', { name: '停止' })).toBeVisible()
      await page.locator('[aria-label="收起通知"]').last().click().catch(() => undefined)
      await page.waitForTimeout(250)

      await page.screenshot({ path: screenshotPath('cross-session-waiting-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(350)
      await page.screenshot({ path: screenshotPath('cross-session-waiting-light.png') })
      await setThemeViaStore(page, 'dark')

      await background.getByRole('button', { name: '返回处理' }).click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionA, 10_000, '返回会话 A')
      await expect(page.locator('.permission-card')).toBeVisible({ timeout: 10_000 })
      await clickPermissionCard(page, 'once')
      await waitForRunFinished(page, 30_000)

      expect(existsSync(join(workspace, '..', 'cross.md'))).toBe(true)
      const pending = await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        const state = store.getState()
        return {
          permissions: Object.keys(state.pendingPermissions ?? {}),
          questions: Object.keys(state.pendingQuestions ?? {}),
          run: state.run
        }
      })
      expect(pending.permissions).toEqual([])
      expect(pending.questions).toEqual([])
      expect(pending.run).toBeNull()

      // 回到 B：后台提示与运行标记应消失
      const rowBAfter = page.locator('.sb-session').filter({ hasText: '跨会话 B' }).locator('.sb-session-main')
      await rowBAfter.click()
      await waitUntil(async () => (await readStore(page)).activeSessionId === sessionB, 10_000, '切回会话 B')
      await expect(page.locator('.composer-background')).toHaveCount(0)
      await expect(page.locator('.sb-session').filter({ hasText: '跨会话 A' }).locator('.sb-session-flag')).toHaveCount(0)
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

})
})

test.describe("03-context", () => {
// ── 原文件：context-compaction.spec.ts ──────────────────────────────────────────────
test.describe('context-compaction.spec.ts', () => {
/**
 * 手动上下文压缩：
 * - 压缩期间禁止发送/再次压缩（主进程 + 渲染层双重拦截），不会丢新消息；
 * - 摘要收敛为「上下文已压缩」系统标记，按需展开，不再伪装成助手长回复；
 * - 压缩后旧消息按安全切点折叠，原始用户约束保留。
 */

test('@core:context 手动压缩：锁住发送、摘要折叠展示、旧消息安全折叠', async () => {
  test.setTimeout(240_000)
  const normalScripts = Array.from({ length: 6 }, (_, index) => ({
    text: `第 ${index + 1} 轮核对完成。${'资料内容与结论'.repeat(60)}`
  }))
  const summaryText = '摘要：用户连续进行了六轮资料核对，前四轮已完成；保留目标、文件路径与未完成事项。'
  const mock = await startMockLLM({
    scripts: [...normalScripts, { text: summaryText, delayMs: 2_500 }]
  })
  const workspace = join(root, 'tmp', `e2e-compaction-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'context-compaction', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '压缩测试'
    })
    await installEventCollector(page)

    for (let round = 1; round <= 6; round += 1) {
      await clearEvents(page)
      await sendMessageViaStore(page, `第 ${round} 轮：请核对这一批资料并给出结论。${'补充说明'.repeat(12)}`)
      await waitForRunFinished(page, 60_000)
    }
    expect(mock.requests.length).toBe(6)
    await expect(page.locator('.message-user-bubble')).toHaveCount(6)
    await expect(page.locator('.message-assistant')).toHaveCount(6)

    // 输入 /compact 走真实命令面板；摘要请求会故意慢 2.5s，留出并发检查窗口
    await page.locator('.composer-input').fill('/compact')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.transcript-compacting')).toBeVisible({ timeout: 10_000 })

    const directSend = await page.evaluate(
      async (id) =>
        (window as unknown as {
          morrow: { chat: { send: (input: unknown) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.chat.send({ sessionId: id, text: '压缩期间直接发送' }),
      sessionId
    )
    expect(directSend.ok).toBe(false)
    expect(directSend.error?.message ?? '').toContain('正在压缩上下文')

    const directCompact = await page.evaluate(
      async (id) =>
        (window as unknown as {
          morrow: { chat: { compact: (id: string) => Promise<{ ok: boolean; error?: { message: string } }> } }
        }).morrow.chat.compact(id),
      sessionId
    )
    expect(directCompact.ok).toBe(false)
    expect(directCompact.error?.message ?? '').toContain('正在压缩上下文')

    await page.locator('.composer-input').fill('压缩结束前不要丢这条')
    await page.locator('.composer-input').press('Enter')
    await expect(page.locator('.composer-input')).toHaveValue('压缩结束前不要丢这条')
    await expect(page.getByText('正在压缩上下文，完成后再发送。')).toBeVisible()
    // 6 次正常请求 + 1 次摘要请求；被拦下的发送不应产生第 8 次请求
    expect(mock.requests.length).toBe(7)

    await expect(page.locator('.message-compaction')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.message-compaction .compaction-head')).toContainText('上下文已压缩')
    await expect(page.locator('.message-compaction .compaction-head')).toContainText('任务继续')
    await expect(page.locator('.compaction-body')).toHaveCount(0)
    await expect(page.locator('.message-user-bubble')).toHaveCount(5)
    await expect(page.locator('.message-assistant')).toHaveCount(4)
    expect(mock.requests.length).toBe(7)

    await page.locator('.composer-input').fill('')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(500)
    await page.locator('.message-compaction').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('context-compaction-collapsed-light.png') })

    await page.locator('.message-compaction .compaction-head').click()
    await expect(page.locator('.compaction-body')).toBeVisible()
    await expect(page.locator('.compaction-body')).toContainText('六轮资料核对')
    await page.screenshot({ path: screenshotPath('context-compaction-expanded-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('context-compaction-expanded-dark.png') })

    // 摘要已落盘：重新加载仍是折叠的系统标记
    const persisted = await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const current = store.getState().session
      const loaded = await window.morrow.session.load(current.id)
      if (!loaded.ok) throw new Error(loaded.error.message)
      return loaded.data.messages.map((message) => message.role)
    })
    expect(persisted[0]).toBe('system')
    expect(persisted.filter((role: string) => role === 'assistant')).toHaveLength(4)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
// ── 原文件：checkpoint-rewind.spec.ts ──────────────────────────────────────────────
test.describe('checkpoint-rewind.spec.ts', () => {
/**
 * P0-3 检查点回退 E2E：
 * - 两轮真实写文件 → 自动生成检查点；
 * - 消息「回退」按钮 + /rewind 命令打开面板；
 * - 外部修改触发冲突并禁用确认；
 * - 恢复预期内容后回退 both：notes 回到 v1、新建文件删除、对话清空。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('@core:sessions 检查点回退：冲突检测 → 恢复文件与对话', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我来修改文件。',
        toolCalls: [
          { name: 'write_file', arguments: { path: 'notes.md', content: 'v2\n' } },
          { name: 'write_file', arguments: { path: 'new.md', content: 'new\n' } }
        ]
      },
      { text: '第一轮完成。' },
      { text: '继续修改。', toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: 'v3\n' } }] },
      { text: '第二轮完成。' }
    ]
  })
  const workspace = workspaceAt('e2e-checkpoint')
  writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8')
  const morrow = await launchMorrow({ name: 'checkpoint', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    const sessionId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '检查点测试'
    })

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('把 notes.md 改成 v2，并新建 new.md。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第一轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v2\n')

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('再把 notes.md 改成 v3。')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '第二轮完成')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v3\n')

    // 主进程检查点已落盘（两轮）
    await waitUntil(
      async () =>
        page.evaluate(async (id) => {
          const result = await window.morrow.checkpoints.list(id)
          return result.ok && result.data.length === 2 ? result.data.length : null
        }, sessionId),
      20_000,
      '两个检查点'
    )

    // 外部修改一个已登记文件 → 从回答末尾「回退」打开唯一的确认弹窗
    writeFileSync(join(workspace, 'notes.md'), 'external\n', 'utf8')
    await page.getByRole('button', { name: '回退这一轮' }).first().click()
    await expect(page.getByRole('dialog', { name: '确认回退' })).toBeVisible()
    await expect(page.locator('.rewind-confirm-list')).toHaveCount(0)
    await expect(page.getByText(/有 1 个文件被改过/)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files li.is-conflict')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '确认回退' })).toBeDisabled()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-conflict-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('rewind-conflict-light.png') })
    await setThemeViaStore(page, 'dark')

    // 修好文件后，在同一个确认弹窗里「重新检查」即可解除冲突
    writeFileSync(join(workspace, 'notes.md'), 'v3\n', 'utf8')
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(page.getByText(/有 1 个文件被改过/)).toHaveCount(0)
    await expect(page.locator('.rewind-confirm-files')).toContainText('notes.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('new.md')
    await expect(page.locator('.rewind-confirm-files')).toContainText('删除新文件')
    await expect(page.getByRole('button', { name: '确认回退' })).toBeEnabled()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('rewind-ready-dark.png') })

    await page.getByRole('button', { name: '确认回退' }).click()
    await expect(page.getByText(/已回到这一轮之前/)).toBeVisible({ timeout: 10_000 })
    await waitUntil(async () => (await readStore(page)).session?.messages.length === 0, 20_000, '对话已回退')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('v1\n')
    expect(() => readFileSync(join(workspace, 'new.md'), 'utf8')).toThrow()

    const loaded = await page.evaluate(async (id) => {
      const result = await window.morrow.session.load(id)
      return result.ok ? result.data : null
    }, sessionId)
    expect(loaded?.messages).toHaveLength(0)
    const remaining = await page.evaluate(async (id) => {
      const result = await window.morrow.checkpoints.list(id)
      return result.ok ? result.data.length : -1
    }, sessionId)
    expect(remaining).toBe(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})
})
