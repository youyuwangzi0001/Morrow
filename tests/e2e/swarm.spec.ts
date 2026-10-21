/**
 * 集群 E2E：/swarm 触发模型拆解 → swarm 工具并行派发 8 个子代理 → 汇总。
 * 离线 mock LLM 按系统提示区分主代理与探索/审查子代理。
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
