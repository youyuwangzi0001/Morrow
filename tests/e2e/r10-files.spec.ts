/**
 * R10-A 文件树与文件操作 E2E（真实 Electron + 真实主进程 feature:files:* handlers）。
 *
 * 依赖：Lead 在 src/main/features/index.ts 顶层 import './files'，并已构建 out/。
 * 覆盖：懒加载/隐藏文件/过滤入口、点击派发 morrow:open-file、新建/重命名/删除二次确认、
 * 只读模式禁用与主进程拒绝、越界/二进制/超大/mtime 冲突的可读错误、明暗主题截图。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, waitForStoreReady, waitUntil } from './store'

let app: ElectronApplication
let page: Page
let workspace = ''

interface FeatureResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

async function invoke<T = unknown>(channel: string, payload: Record<string, unknown>): Promise<FeatureResult<T>> {
  return page.evaluate(
    async ({ channel: channelName, payload: requestPayload }) =>
      window.morrow.features.invoke(channelName, requestPayload) as Promise<FeatureResult<T>>,
    { channel, payload }
  )
}

async function createSessionForWorkspace(target: string): Promise<void> {
  await page.evaluate(async (ws) => {
    const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
    await store.getState().newSession({ workspace: ws })
  }, target)
  await page.waitForTimeout(600)
}

test.describe('R10-A 文件树与文件操作', () => {
  test.beforeAll(async () => {
    workspace = join(root, 'tmp', `r10-files-ws-${Date.now()}`)
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'hello.md'), '# hello\n', 'utf8')
    writeFileSync(join(workspace, 'docs', 'a.txt'), 'A', 'utf8')
    writeFileSync(join(workspace, '.env'), 'SECRET=1\n', 'utf8')
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const launched = await launchMorrow({ name: 'r10-files', timeoutMs: 90_000 })
    app = launched.app
    page = launched.page
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createSessionForWorkspace(workspace)
  })

  test.afterAll(async () => {
    try {
      await app?.close()
    } catch {
      // ignore
    }
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test('文件树懒加载、隐藏文件开关、过滤入口与当前文件高亮', async () => {
    const tree = page.locator('.file-tree')
    await expect(tree).toBeVisible()
    await expect(tree.locator('.ft-row', { hasText: 'hello.md' })).toBeVisible()
    await expect(tree.locator('.ft-row', { hasText: '.env' })).toHaveCount(0)

    // 隐藏文件开关
    await page.getByRole('button', { name: '显示隐藏文件' }).click()
    await expect(tree.locator('.ft-row', { hasText: '.env' })).toBeVisible()
    await page.getByRole('button', { name: '隐藏隐藏文件' }).click()
    await expect(tree.locator('.ft-row', { hasText: '.env' })).toHaveCount(0)

    // 目录懒加载
    await tree.locator('.ft-row', { hasText: 'docs' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toBeVisible()
    await tree.locator('.ft-row.is-dir', { hasText: 'docs' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toHaveCount(0)

    // 过滤
    await page.getByRole('button', { name: '显示过滤框' }).click()
    await page.getByRole('textbox', { name: '过滤文件' }).fill('hel')
    await expect(tree.locator('.ft-row', { hasText: 'hello.md' })).toBeVisible()
    await expect(tree.locator('.ft-row', { hasText: 'docs' })).toHaveCount(0)
    await page.getByRole('textbox', { name: '过滤文件' }).fill('')
    await page.getByRole('button', { name: '隐藏过滤框' }).click()

    // 点击文件 → 派发 morrow:open-file，并高亮当前文件
    await page.evaluate(() => {
      const scope = window as unknown as { __opened: Array<{ path: string; absolutePath: string }> }
      scope.__opened = []
      window.addEventListener('morrow:open-file', (event) => {
        scope.__opened.push((event as CustomEvent<{ path: string; absolutePath: string }>).detail)
      })
    })
    await tree.locator('.ft-row', { hasText: 'hello.md' }).click()
    await waitUntil(
      async () => (await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened.length)) > 0,
      5_000,
      'morrow:open-file 事件'
    )
    const detail = await page.evaluate(
      () => (window as unknown as { __opened: Array<{ path: string; absolutePath: string }> }).__opened[0]
    )
    expect(detail.path).toBe('hello.md')
    expect(detail.absolutePath.endsWith('hello.md')).toBe(true)
    await expect(tree.locator('.ft-row.is-active', { hasText: 'hello.md' })).toBeVisible()

    await page.screenshot({ path: screenshotPath('r10-files-tree-dark.png') })
  })

  test('右键菜单：新建文件、重命名、删除（二次确认）真实落盘', async () => {
    const tree = page.locator('.file-tree')
    // 新建文件（工具栏）
    await page.getByRole('button', { name: '新建文件', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('note.md')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'note.md' })).toBeVisible()
    expect(existsSync(join(workspace, 'note.md'))).toBe(true)

    // 右键菜单截图
    await tree.locator('.ft-row', { hasText: 'note.md' }).click({ button: 'right' })
    await expect(page.getByRole('menu', { name: '文件操作' })).toBeVisible()
    await page.screenshot({ path: screenshotPath('r10-files-context-menu-dark.png') })

    // 重命名
    await page.getByRole('menuitem', { name: '重命名' }).click()
    await page.getByLabel('新名字', { exact: true }).fill('renamed.md')
    await page.locator('.modal-foot').getByRole('button', { name: '重命名' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'renamed.md' })).toBeVisible()
    expect(existsSync(join(workspace, 'renamed.md'))).toBe(true)
    expect(existsSync(join(workspace, 'note.md'))).toBe(false)

    // 删除（二次确认）
    await tree.locator('.ft-row', { hasText: 'renamed.md' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除' }).click()
    await expect(page.getByRole('dialog')).toContainText('无法恢复')
    await page.screenshot({ path: screenshotPath('r10-files-delete-confirm-dark.png') })
    await page.locator('.modal-foot').getByRole('button', { name: '删除' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'renamed.md' })).toHaveCount(0)
    expect(existsSync(join(workspace, 'renamed.md'))).toBe(false)

    // 子目录内新建（右键目录 → 新建文件）
    await tree.locator('.ft-row', { hasText: 'docs' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('inner.md')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(tree.locator('.ft-row', { hasText: 'inner.md' })).toBeVisible()
    expect(readFileSync(join(workspace, 'docs', 'inner.md'), 'utf8')).toBe('')
  })

  test('只读模式：UI 禁用写操作 + 主进程拒绝写', async () => {
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().setPermissionMode('read-only')
    })
    await expect(page.getByRole('button', { name: '新建文件', exact: true })).toBeDisabled()
    await page.locator('.file-tree').screenshot({ path: screenshotPath('r10-files-readonly-dark.png') })

    const write = await invoke('feature:files:write', {
      workspace,
      path: 'blocked.txt',
      content: 'should not write'
    })
    expect(write.ok).toBe(false)
    expect(write.error?.message).toContain('只读')
    expect(existsSync(join(workspace, 'blocked.txt'))).toBe(false)

    // 右键菜单中的写操作也应 disabled
    await page.locator('.file-tree .ft-row', { hasText: 'hello.md' }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '重命名' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: '删除' })).toBeDisabled()
    await page.keyboard.press('Escape')

    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      await store.getState().setPermissionMode('ask')
    })
  })

  test('文件夹重命名/删除后保持展开状态，旧路径不产生多余错误', async () => {
    const tree = page.locator('.file-tree')
    await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('pack')
    await page.getByRole('button', { name: '创建' }).click()
    const pack = tree.locator('.ft-row', { hasText: 'pack' })
    await expect(pack).toBeVisible()

    await pack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
    await page.getByLabel('名字', { exact: true }).fill('inner.md')
    await page.getByRole('button', { name: '创建' }).click()
    await expect(tree.locator('.ft-row[title="pack/inner.md"]')).toBeVisible()

    await pack.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '重命名' }).click()
    await page.getByLabel('新名字', { exact: true }).fill('pack2')
    await page.locator('.modal-foot').getByRole('button', { name: '重命名' }).click()
    const renamed = tree.locator('.ft-row', { hasText: 'pack2' })
    await expect(renamed).toBeVisible()
    await expect(renamed).toHaveAttribute('aria-expanded', 'true')
    await expect(tree.locator('.ft-row[title="pack2/inner.md"]')).toBeVisible()
    await expect(page.locator('.toast-item.toast-error')).toHaveCount(0)

    await renamed.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除' }).click()
    await page.locator('.modal-foot').getByRole('button', { name: '删除' }).click()
    await expect(renamed).toHaveCount(0)
    await expect(tree.locator('.ft-row[title="pack2/inner.md"]')).toHaveCount(0)
    await page.waitForTimeout(400)
    await expect(page.locator('.toast-item.toast-error')).toHaveCount(0)
  })

  test('键盘：无行焦点时不误删首行，方向键从首行开始且操作只作用于焦点行', async () => {
    const tree = page.locator('.file-tree')
    const body = tree.locator('.ft-body')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await body.focus()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.keyboard.press('F2')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.keyboard.press('ArrowDown')
    await expect(tree.locator('.ft-row').first()).toBeFocused()
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('外部打开文件时自动展开祖先目录并高亮', async () => {
    const tree = page.locator('.file-tree')
    const docs = tree.locator('.ft-row', { hasText: 'docs' })
    if ((await docs.getAttribute('aria-expanded')) === 'true') await docs.click()
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toHaveCount(0)

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('morrow:open-file', { detail: { path: 'docs/a.txt', absolutePath: '' } })
      )
    })
    await expect(tree.locator('.ft-row', { hasText: 'a.txt' })).toBeVisible()
    await expect(tree.locator('.ft-row.is-active', { hasText: 'a.txt' })).toBeVisible()
    await expect(docs).toHaveAttribute('aria-expanded', 'true')
  })

  test('边界 / 二进制 / mtime 冲突返回可读错误', async () => {
    const outside = await invoke('feature:files:read', { workspace, path: '../outside-secret.txt' })
    expect(outside.ok).toBe(false)
    expect(outside.error?.message).toContain('工作区之外')

    const binary = await invoke('feature:files:read', { workspace, path: 'binary.bin' })
    expect(binary.ok).toBe(false)
    expect(binary.error?.message).toContain('二进制')

    const created = await invoke<{ mtimeMs: number }>('feature:files:write', {
      workspace,
      path: 'conflict.txt',
      content: 'v1'
    })
    expect(created.ok).toBe(true)
    const stale = (created.data as { mtimeMs: number }).mtimeMs - 5000
    const conflict = await invoke('feature:files:write', {
      workspace,
      path: 'conflict.txt',
      content: 'v2',
      expectedMtimeMs: stale
    })
    expect(conflict.ok).toBe(false)
    expect(conflict.error?.message).toContain('外部修改')
    expect(readFileSync(join(workspace, 'conflict.txt'), 'utf8')).toBe('v1')

    // 删除必须显式 confirm
    const noConfirm = await invoke('feature:files:delete', { workspace, path: 'conflict.txt' })
    expect(noConfirm.ok).toBe(false)
    expect(noConfirm.error?.message).toContain('确认')
  })

  test('明暗主题截图（文件树）', async () => {
    // 等前面操作的成功提示自动消失，截图只保留应用界面
    await expect(page.locator('.toast-item')).toHaveCount(0, { timeout: 7_000 })
    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().setTheme('light')
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: screenshotPath('r10-files-tree-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      store.getState().setTheme('dark')
    })
  })
})
