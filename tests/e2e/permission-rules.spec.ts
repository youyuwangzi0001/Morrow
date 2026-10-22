/**
 * P1-10 权限规则 E2E：
 * - 设置页添加 run_command 前缀 allow 规则 → 不再弹审批；
 * - deny 规则直接拒绝；
 * - 普通审批记录进入审批日志。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  clickPermissionCard,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  readStore,
  setThemeViaStore,
  waitForPermission,
  waitUntil,
  waitForStoreReady
} from './store'

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function addRuleViaUi(page: Page, pattern: string, decision: 'allow' | 'deny'): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    store.getState().openSettings()
  })
  await page.getByRole('tab', { name: '权限' }).click()
  await page.locator('.st-rule-pattern').fill(pattern)
  await page.locator('.st-rule-form').getByRole('radio', { name: decision === 'allow' ? '允许' : '拒绝' }).click()
  await page.locator('.st-rule-form').getByRole('button', { name: '添加' }).click()
  await expect(page.locator('.st-perm-rules')).toContainText(pattern)
  await page.getByRole('button', { name: '完成' }).click()
}

function toolStatus(page: Page, commandPart: string): Promise<string | null> {
  return page.evaluate((needle) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    const session = store.getState().session
    for (const message of session?.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'run_command' && JSON.stringify(block.input).includes(needle)) {
          return block.status as string
        }
      }
    }
    return null
  }, commandPart)
}

test('工作区权限规则持久化、deny 优先与审批日志', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '执行规则允许的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: "Write-Output 'rule-ok'" } }]
      },
      { text: '规则命令已执行。' },
      {
        text: '尝试被禁止的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: "Write-Output 'rule-blocked'" } }]
      },
      { text: '命令被拒绝。' },
      {
        text: '需要审批的命令。',
        toolCalls: [{ name: 'run_command', arguments: { command: 'Remove-Item out -Recurse -Force' } }]
      },
      { text: '审批命令已执行。' }
    ]
  })
  const workspace = workspaceAt('e2e-permission-rules')
  const morrow = await launchMorrow({ name: 'permission-rules', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '权限规则测试'
    })

    // allow 规则
    await addRuleViaUi(page, "Write-Output 'rule-ok'", 'allow')
    await page.locator('.composer-input').fill('执行规则命令')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('规则命令已执行。')).toBeVisible({ timeout: 45_000 })
    expect(await toolStatus(page, 'rule-ok')).toBe('success')
    expect((await readStore(page)).pendingPermission).toBeNull()

    // deny 规则
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第一条完成')
    await addRuleViaUi(page, "Write-Output 'rule-blocked'", 'deny')
    await page.locator('.composer-input').fill('尝试被禁止的命令')
    await page.locator('.composer-input').press('Enter')
    await expect(page.getByText('命令被拒绝。')).toBeVisible({ timeout: 45_000 })
    expect(await toolStatus(page, 'rule-blocked')).toBe('denied')

    // 普通审批进入日志
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第二条完成')
    await page.locator('.composer-input').fill('执行需要审批的命令')
    await page.locator('.composer-input').press('Enter')
    await waitForPermission(page, 45_000)
    await clickPermissionCard(page, 'once')
    await expect(page.getByText('审批命令已执行。')).toBeVisible({ timeout: 45_000 })
    await waitUntil(async () => (await readStore(page)).run === null, 20_000, '第三条完成')

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().openSettings()
    })
    await page.getByRole('tab', { name: '权限' }).click()
    await expect(page.locator('.st-perm-rules')).toContainText("Write-Output 'rule-ok'")
    await expect(page.locator('.st-perm-rules')).toContainText("Write-Output 'rule-blocked'")
    await expect(page.locator('.st-approval-log')).toContainText('运行命令')
    // 整个工具规则：匹配内容留空也应能保存（此前服务端会拒绝空 pattern）
    const form = page.locator('.st-rule-form')
    await form.getByRole('button', { name: '规则类型', exact: true }).click()
    await page.getByRole('option', { name: '写文件' }).click()
    await form.getByRole('button', { name: '权限规则类型' }).click()
    await page.getByRole('option', { name: '整个工具' }).click()
    await expect(form.locator('.st-rule-pattern')).toBeDisabled()
    await form.getByRole('button', { name: '添加' }).click()
    await expect(page.locator('.st-perm-rules')).toContainText('写文件 · 工具')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    })
    await expect(page.getByText('文件夹权限规则')).toBeVisible()
    await page.mouse.move(4, 4)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('permission-rules-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('permission-rules-light.png') })
  } finally {
    await morrow.close()
    await mock.close()
  }
})
