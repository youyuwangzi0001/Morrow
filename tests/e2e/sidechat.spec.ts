/**
 * 侧边聊天 E2E：/btw 打开右侧抽屉 → 只读回答 → 主对话消息不变 → 关闭。
 * mock LLM 按系统提示区分主对话与侧边聊天。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  readStore,
  setThemeViaStore,
  waitUntil,
  waitForStoreReady,
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('侧边聊天：只读回答，不写入主对话', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('侧边聊天')) {
        return { text: '侧边回答：入口在 `src/auth/login.ts`，主对话没有受到影响。', chunkDelayMs: 4 }
      }
      return { text: '主对话回答。' }
    }
  })
  const workspace = workspaceAt('e2e-sidechat')
  const morrow = await launchMorrow({ name: 'sidechat', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '侧边聊天测试'
    })

    await page.evaluate(() => {
      return (window as unknown as { __morrowStore: { getState: () => { sendMessage: (text: string) => Promise<void> } } })
        .__morrowStore.getState().sendMessage('主对话：登录逻辑在哪？')
    })
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '主对话结束')
    const before = await readStore(page)
    expect(before.session?.messages).toHaveLength(2)

    const input = page.locator('.composer-input')
    await input.fill('/btw 侧边问题：入口文件是哪个？')
    await page.keyboard.press('Enter')

    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('侧边回答：入口在')).toBeVisible({ timeout: 30_000 })
    await expect(drawer.getByText('主对话没有受到影响')).toBeVisible()

    // 主对话没有新增消息；侧边聊天请求带上主对话上下文且没有工具
    const after = await readStore(page)
    expect(after.session?.messages).toHaveLength(2)
    const sideBodies = mock.requests
      .map((request: { body?: unknown }) => JSON.stringify(request.body ?? {}))
      .filter((body: string) => body.includes('侧边聊天'))
    expect(sideBodies.length).toBeGreaterThanOrEqual(1)
    expect(sideBodies[0]).toContain('主对话：登录逻辑在哪？')

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('sidechat-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('sidechat-light.png') })

    await drawer.getByRole('button', { name: '关闭侧边聊天' }).click()
    await expect(drawer).toBeHidden()

    // 输入框旁的按钮可重新打开；关闭不清空本次侧边对话
    await page.getByRole('button', { name: '侧边聊天（/btw）' }).click()
    await expect(page.getByRole('complementary', { name: '侧边聊天' })).toBeVisible()
    await expect(page.getByText('侧边回答：入口在')).toBeVisible()
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('侧边聊天：停止后保留部分回答并标记已停止，不写入主对话', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('侧边聊天')) {
        return { text: '这是一段用于测试停止的较长回答。'.repeat(20), chunkDelayMs: 80, textChunkSize: 4 }
      }
      return { text: '主对话回答。' }
    }
  })
  const workspace = workspaceAt('e2e-sidechat-stop')
  const morrow = await launchMorrow({ name: 'sidechat-stop', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '侧边聊天停止测试'
    })

    const input = page.locator('.composer-input')
    await input.fill('/btw 请写一段长回答')
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    const answer = drawer.locator('.sidechat-msg.is-assistant .sidechat-text')
    await expect(answer).toContainText('这是一段', { timeout: 30_000 })
    await drawer.getByRole('button', { name: '停止' }).click()
    await expect(drawer.locator('.sidechat-stopped')).toBeVisible({ timeout: 10_000 })

    const stoppedText = await answer.innerText()
    await page.waitForTimeout(600)
    expect(await answer.innerText()).toBe(stoppedText)
    expect((await readStore(page)).session?.messages).toHaveLength(0)

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('sidechat-stopped-dark.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('侧边聊天：输出被截断时显示服务商提示', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (raw.includes('侧边聊天')) {
        return { text: '被截断的回答。', stopReason: 'max_tokens' }
      }
      return { text: '主对话回答。' }
    }
  })
  const workspace = workspaceAt('e2e-sidechat-notice')
  const morrow = await launchMorrow({ name: 'sidechat-notice', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '侧边聊天截断测试'
    })

    const input = page.locator('.composer-input')
    await input.fill('/btw 给我一段长回答')
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer.getByText('被截断的回答。')).toBeVisible({ timeout: 30_000 })
    await expect(drawer.locator('.sidechat-notice')).toContainText('输出长度上限')
    expect((await readStore(page)).session?.messages).toHaveLength(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
