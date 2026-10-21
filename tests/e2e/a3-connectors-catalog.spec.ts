/**
 * A3 连接器目录与一键安装：
 * 目录展示真实、可核对的连接器；安装真实写 mcp.json，密钥加密且不回显；
 * 本机服务在缺少 Node.js 时明确提示，不伪造成功。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { dismissOnboarding, openToolPanel, waitForStoreReady } from './store'

function makeDir(prefix: string): string {
  const dir = join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test.describe('A3 连接器目录', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('目录搜索/分类，远程连接器一键安装并加密保存，本机服务显示运行时要求', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('a3-connectors-ws')
    morrow = await launchMorrow({ name: 'a3-connectors', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.evaluate(async (path: string) => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().updateSettings({ lastWorkspace: path })
    }, workspace)

    await openToolPanel(page, '连接器')
    await expect(page.locator('.conn')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '工具目录' }).click()
    await expect(page.locator('.cd-root')).toBeVisible()
    await expect(page.getByLabel('搜索外部工具目录')).toBeVisible()

    // 目录有官方/本机条目，且本机条目明确标注 Node.js 要求
    await expect(page.locator('.cd-item').first()).toBeVisible({ timeout: 15_000 })
    expect(await page.locator('.cd-item').count()).toBeGreaterThanOrEqual(6)
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toBeVisible()
    await expect(page.locator('.cd-item').filter({ hasText: 'Linear' })).toBeVisible()
    await expect(page.locator('.cd-item').filter({ hasText: '文件系统' })).toContainText('需 Node.js')
    await expect(page.locator('.cd-top')).toContainText('Node.js')

    // 搜索与分类过滤
    await page.getByRole('radio', { name: '本机服务' }).click()
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toHaveCount(0)
    await expect(page.locator('.cd-item').filter({ hasText: '文件系统' })).toBeVisible()
    await page.getByRole('radio', { name: '全部' }).click()
    await page.getByLabel('搜索外部工具目录').fill('Linear')
    await expect(page.locator('.cd-item')).toHaveCount(1)
    await expect(page.locator('.cd-item').filter({ hasText: 'Linear' })).toBeVisible()
    await page.getByLabel('搜索外部工具目录').fill('')

    // GitHub：需要 Token；只安装不改网络
    await page.locator('.cd-item').filter({ hasText: 'GitHub' }).click()
    await expect(page.getByLabel('GitHub Token')).toBeVisible()
    await expect(page.locator('.cd-actions').getByRole('button', { name: '仅安装' })).toBeDisabled()
    const fakeToken = 'ghp_e2e_catalog_token_1234567890'
    await page.getByLabel('GitHub Token').fill(fakeToken)
    await expect(page.locator('.cd-top')).not.toContainText('检测中', { timeout: 15_000 })
    await page.locator('.modal-panel').filter({ has: page.locator('.cd-root') }).screenshot({
      path: screenshotPath('a3-connector-directory.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.locator('.modal-panel').filter({ has: page.locator('.cd-root') }).screenshot({
      path: screenshotPath('a3-connector-directory-light.png')
    })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await page.locator('.cd-actions').getByRole('button', { name: '仅安装' }).click()

    // 安装成功 → 回到已安装详情，真实写盘且密钥不明文
    await expect(page.locator('.cd-root')).toHaveCount(0)
    await expect(page.locator('.conn-item[data-name="github"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.conn-notice')).toContainText('已安装')
    const mcpFile = join(morrow.dataDir, 'mcp.json')
    const secretsFile = join(morrow.dataDir, 'mcp-secrets.json')
    expect(existsSync(mcpFile)).toBe(true)
    const configText = readFileSync(mcpFile, 'utf8')
    expect(configText).toContain('github')
    expect(configText).toContain('MORROW_SECRET')
    expect(configText).not.toContain(fakeToken)
    expect(readFileSync(secretsFile, 'utf8')).not.toContain(fakeToken)

    // 已安装项在目录里可识别，且本机条目有文件夹选择
    await page.getByRole('button', { name: '工具目录' }).click()
    await expect(page.locator('.cd-item').filter({ hasText: 'GitHub' })).toContainText('已安装')
    await page.locator('.cd-item').filter({ hasText: '文件系统' }).click()
    await expect(page.getByText('允许访问的文件夹')).toBeVisible()
    await expect(page.getByRole('button', { name: '选择文件夹' })).toBeVisible()
    await page.getByRole('button', { name: '返回已安装' }).click()

    // 删除安装项，密钥一并清理
    await page.locator('.conn-item[data-name="github"] .conn-item-main').click()
    await page.locator('.conn-actions').getByRole('button', { name: '删除', exact: true }).click()
    await page.locator('.conn-actions').getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.conn-item[data-name="github"]')).toHaveCount(0, { timeout: 15_000 })
    expect(readFileSync(mcpFile, 'utf8')).not.toContain('github')
  })
})
