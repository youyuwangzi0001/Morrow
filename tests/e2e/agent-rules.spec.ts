/**
 * P1-9 项目规则文件 E2E：
 * - AGENTS.md 注入系统提示；
 * - /init 生成 AGENTS.md；
 * - 设置 → 上下文 可见发现的规则文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  waitForStoreReady
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('规则文件注入、/init 生成与设置页可见', async () => {
  test.setTimeout(180_000)
  const rulesWorkspace = workspaceAt('e2e-rules-inject')
  writeFileSync(join(rulesWorkspace, 'AGENTS.md'), 'RULE-MARKER-7788：所有回答都要提到猕猴桃。\n', 'utf8')
  const initWorkspace = workspaceAt('e2e-rules-init')
  mkdirSync(join(initWorkspace, '.morrow'), { recursive: true })
  writeFileSync(join(initWorkspace, '.morrow', 'AGENTS.md'), 'EXISTING-DOT-RULE\n', 'utf8')

  const mock = await startMockLLM({
    scripts: [
      { text: '收到规则。' },
      {
        text: '工作区很简单，我来写 AGENTS.md。',
        toolCalls: [
          {
            name: 'write_file',
            arguments: {
              path: 'AGENTS.md',
              content: '# AGENTS.md\n\n## 项目概述\nMorrow E2E 测试工作区。\n\n## 常用命令\n- 测试：npm test\n'
            }
          }
        ]
      },
      { text: '已生成 AGENTS.md。' }
    ]
  })
  const morrow = await launchMorrow({ name: 'agent-rules', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace: rulesWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '规则注入测试'
    })
    await page.locator('.composer-input').fill('你好')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('收到规则。')).toBeVisible({ timeout: 30_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 30_000, '规则运行结束')
    const firstBody = mock.requests[0]?.body as { messages?: Array<{ role: string; content: unknown }> } | undefined
    const systemMessage = firstBody?.messages?.find((message) => message.role === 'system')
    expect(JSON.stringify(systemMessage)).toContain('RULE-MARKER-7788')
    expect(JSON.stringify(firstBody)).toContain('项目规则文件')
    expect(JSON.stringify(firstBody?.messages?.find((message) => message.role === 'user'))).not.toContain('RULE-MARKER-7788')

    // /init 生成 AGENTS.md
    await createSession(page, {
      workspace: initWorkspace,
      ...provider,
      permissionMode: 'auto',
      title: '初始化规则测试'
    })
    await page.locator('.composer-input').fill('/init')
    await page.locator('.composer-input').press('Enter')
    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '/init 运行结束')
    await waitUntil(async () => existsSync(join(initWorkspace, 'AGENTS.md')), 30_000, 'AGENTS.md 生成')
    expect(readFileSync(join(initWorkspace, 'AGENTS.md'), 'utf8')).toContain('项目概述')
    // /init 会先发现已有规则文件（含 .morrow），并要求模型在现有文件上更新
    const initBodies = mock.requests.slice(2).map((request) => JSON.stringify(request.body))
    expect(initBodies.some((body) => body.includes('先读取这些文件') && body.includes('.morrow'))).toBe(true)
    expect(initBodies.some((body) => body.includes('EXISTING-DOT-RULE'))).toBe(true)

    // 设置 → 上下文：规则可见
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '上下文' }).click()
    await expect(page.locator('.st-rules-list')).toContainText('AGENTS.md')
    await expect(page.locator('.st-rules-list')).toContainText('.morrow')
    await expect(page.locator('.st-rules-budget')).toContainText('已使用')
    await page.locator('.st-rules-head').getByRole('button', { name: '刷新' }).click()
    await expect(page.locator('.st-rules-list')).toContainText('AGENTS.md')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.getByText('项目规则文件', { exact: true }).scrollIntoViewIfNeeded()
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('agent-rules-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('agent-rules-settings-light.png') })
    await page.getByRole('button', { name: '完成' }).click()

    // 只读模式下 /init 应直接拦下，不发送请求
    const guardWorkspace = workspaceAt('e2e-rules-guard')
    await createSession(page, {
      workspace: guardWorkspace,
      ...provider,
      permissionMode: 'read-only',
      title: '只读规则测试'
    })
    const requestsBefore = mock.requests.length
    await page.locator('.composer-input').fill('/init')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText(/只读模式不能写文件/)).toBeVisible()
    await page.waitForTimeout(400)
    expect(mock.requests.length).toBe(requestsBefore)
    expect(existsSync(join(guardWorkspace, 'AGENTS.md'))).toBe(false)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
