/**
 * P1-12 自定义命令与钩子 E2E：
 * - .morrow/commands 命令出现在斜杠菜单，选择后输入参数，发送时展开 $1/$2；
 * - 设置 → 自动化：添加 user_prompt_submit 钩子并保存；
 * - 退出码 2 的钩子阻止消息，界面给出原因；设置持久化可读回。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

test('自定义命令展开参数，钩子可阻断并持久化', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({ scripts: [{ text: '审查完成。' }, { text: '不应该出现。' }] })
  const workspace = workspaceAt('e2e-commands')
  mkdirSync(join(workspace, '.morrow', 'commands'), { recursive: true })
  writeFileSync(
    join(workspace, '.morrow', 'commands', 'review.md'),
    '---\ndescription: 审查代码\nargument-hint: 文件与重点\n---\n请审查 $1，重点 $2。\n',
    'utf8'
  )
  writeFileSync(
    join(workspace, '.morrow', 'commands', 'hello.md'),
    '向用户问好，并总结今天的进展。\n',
    'utf8'
  )
  writeFileSync(
    join(workspace, '.morrow', 'commands', 'swarm.md'),
    '---\ndescription: 不应出现在菜单里的重名命令\n---\n不应执行。\n',
    'utf8'
  )
  const blockScript = join(workspace, 'block-hook.js')
  writeFileSync(blockScript, "process.stdout.write('需要先填写作者')\nprocess.exit(2)\n", 'utf8')
  const hookCommand = `"${process.execPath}" "${blockScript}"`

  const morrow = await launchMorrow({ name: 'custom-commands', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '命令测试'
    })

    // 斜杠菜单中发现项目命令，选择后进入参数输入
    const input = page.locator('.composer-input')
    await input.click()
    await input.fill('/rev')
    const popupItem = page.locator('.composer-pop-item').filter({ hasText: '审查代码' })
    await expect(popupItem).toBeVisible()
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('custom-command-popup-dark.png') })
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('/review ')
    await input.pressSequentially('src/a.ts 性能')
    await page.keyboard.press('Enter')

    await waitUntil(async () => (await readStore(page)).run === null, 60_000, '自定义命令运行结束')
    await expect(page.locator('.message-user')).toContainText('请审查 src/a.ts，重点 性能。')
    expect(mock.requests[0]?.lastUserMessageText).toBe('请审查 src/a.ts，重点 性能。')

    // 未知命令给出提示而不是把 /nope 当普通消息发给模型
    await input.fill('/nope')
    await page.keyboard.press('Enter')
    await expect(page.getByText('没有名为 /nope 的命令')).toBeVisible()
    await expect(input).toHaveValue('/nope')
    expect(mock.requests).toHaveLength(1)
    await input.fill('')

    // 与内置命令重名时，菜单只保留内置项，不出现重复条目
    await input.fill('/swarm')
    await expect(page.locator('.composer-pop-item')).toHaveCount(1)
    await expect(page.locator('.composer-pop-item')).toContainText('集群')
    await input.fill('')

    // 设置 → 自动化：添加并保存钩子
    await page.evaluate(() => {
      void (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } })
        .__morrowStore.getState().openSettings()
    })
    await page.getByRole('tab', { name: '自动化' }).click()
    await expect(page.locator('.st-command-name').filter({ hasText: '/review' })).toBeVisible()
    await expect(page.locator('.st-command-list li').filter({ hasText: '/swarm' })).toContainText('重名')
    await expect(page.getByText(/个命令与内置命令重名/)).toBeVisible()
    await expect(page.getByText('小助手角色')).toBeVisible()
    await expect(page.getByText('探索者', { exact: true })).toBeVisible()
    await expect(page.getByText('审查者', { exact: true })).toBeVisible()

    // 设置面板只保留右侧内容区一条滚动条，模态正文不再套一层滚动
    const settingsOverflow = await page
      .getByRole('dialog', { name: '设置' })
      .evaluate((panel) => {
        const body = panel.querySelector<HTMLElement>('.modal-body')
        return body ? body.scrollHeight - body.clientHeight : null
      })
    expect(settingsOverflow).not.toBeNull()
    expect(settingsOverflow!).toBeLessThanOrEqual(1)

    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('automation-settings-dark.png') })

    await page.getByRole('button', { name: '添加自动动作' }).click()
    await page.getByLabel('要运行的命令').fill(hookCommand)
    await page.getByLabel('启用这个自动动作').check()
    await page.getByRole('button', { name: '保存自动动作' }).click()
    await expect(page.locator('.st-hook-saved')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('automation-settings-light.png') })
    const savedSettings = await page.evaluate(async () => {
      const result = await window.morrow.settings.get()
      return result.ok ? result.data.hooks : []
    })
    expect(savedSettings).toHaveLength(1)
    expect(savedSettings[0]).toMatchObject({ event: 'user_prompt_submit', enabled: true, command: hookCommand })

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '设置' })).toBeHidden()

    // 钩子退出码 2：阻止发送并显示原因，模型不被调用
    await input.fill('这条消息应该被钩子拦住')
    await page.keyboard.press('Enter')
    await expect(page.getByText(/自动动作阻止了这条消息/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('需要先填写作者')).toBeVisible()
    expect(mock.requests).toHaveLength(1)
  } finally {
    await morrow.close()
    await mock.close()
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 })
  }
})
