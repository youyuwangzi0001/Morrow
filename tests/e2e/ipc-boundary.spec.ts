/**
 * IPC/preload 边界回归：
 * - 核心通道异常统一归一化为 Result，不再向渲染层抛 Electron 原始拒绝；
 * - 产物读取/打开/另存与文件搜索只接受已登记工作区内的真实路径；
 * - 生产 CSP 下 connect-src 不再允许任意 https 外联；
 * - 主窗口不能被导航到任意 file:// 页面；
 * - 沙箱化 preload 仍能提供完整 API。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root } from './launch'
import { createUiSession, dismissOnboarding, waitForStoreReady } from './store'

interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

test('IPC 路径边界、错误归一化、CSP 与导航限制', async () => {
  test.setTimeout(120_000)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const workspace = join(root, 'tmp', `ipc-boundary-ws-${stamp}`)
  const outsideDir = join(root, 'tmp', `ipc-boundary-outside-${stamp}`)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  const insidePath = join(workspace, 'inside.txt')
  const outsidePath = join(outsideDir, 'secret.txt')
  writeFileSync(insidePath, 'inside-workspace-content', 'utf8')
  writeFileSync(outsidePath, 'outside-secret-content', 'utf8')

  const morrow = await launchMorrow({ name: 'ipc-boundary', env: { MORROW_TEST_CSP: '1' } })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await createUiSession(page, {
      workspace,
      permissionMode: 'auto',
      title: 'IPC 边界测试'
    })

    const readInside = await page.evaluate(
      (path) => (window as unknown as { morrow: { artifacts: { read: (p: string) => Promise<IpcResult<{ content: string }>> } } }).morrow.artifacts.read(path),
      insidePath
    )
    expect(readInside.ok, JSON.stringify(readInside.error)).toBe(true)
    expect(readInside.data?.content).toBe('inside-workspace-content')

    const readOutside = await page.evaluate(
      (path) => (window as unknown as { morrow: { artifacts: { read: (p: string) => Promise<IpcResult> } } }).morrow.artifacts.read(path),
      outsidePath
    )
    expect(readOutside.ok).toBe(false)
    expect(readOutside.error?.code).toBe('FILE_UNAVAILABLE')
    expect(JSON.stringify(readOutside)).not.toContain('outside-secret-content')

    const searchOutside = await page.evaluate(
      (dir) => (window as unknown as { morrow: { files: { search: (root: string, q: string) => Promise<IpcResult> } } }).morrow.files.search(dir, 'secret'),
      outsideDir
    )
    expect(searchOutside.ok).toBe(false)
    expect(searchOutside.error?.code).toBe('FILE_ROOT_DENIED')

    const searchInside = await page.evaluate(
      (dir) => (window as unknown as { morrow: { files: { search: (root: string, q: string) => Promise<IpcResult> } } }).morrow.files.search(dir, 'inside'),
      workspace
    )
    expect(searchInside.ok, JSON.stringify(searchInside.error)).toBe(true)
    expect(JSON.stringify(searchInside.data)).toContain('inside.txt')

    // 文件功能显式传入 workspace 时也必须属于已登记工作区
    const filesOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:list', { workspace: dir }),
      outsideDir
    )
    expect(filesOutside.ok).toBe(false)
    const fileReadOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:read', { workspace: dir, path: 'secret.txt' }),
      outsideDir
    )
    expect(fileReadOutside.ok).toBe(false)
    const filePreviewOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:preview', { workspace: dir, path: 'secret.txt' }),
      outsideDir
    )
    expect(filePreviewOutside.ok).toBe(false)
    const filesInside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:files:list', { workspace: dir }),
      workspace
    )
    expect(filesInside.ok, JSON.stringify(filesInside.error)).toBe(true)

    // 规则文件发现同样只接受已登记工作区
    const rulesOutside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult> } } })
          .morrow.features.invoke('feature:rules:list', { workspace: dir }),
      outsideDir
    )
    expect(rulesOutside.ok).toBe(false)
    expect(rulesOutside.error?.message ?? '').toContain('已登记工作区')
    const rulesInside = await page.evaluate(
      (dir) =>
        (window as unknown as { morrow: { features: { invoke: (channel: string, payload: unknown) => Promise<IpcResult<{ files: unknown[] }>> } } })
          .morrow.features.invoke('feature:rules:list', { workspace: dir }),
      workspace
    )
    expect(rulesInside.ok, JSON.stringify(rulesInside.error)).toBe(true)

    const sessionId = await page.evaluate(
      () => (window as unknown as { __morrowStore: { getState: () => { activeSessionId: string } } }).__morrowStore.getState().activeSessionId
    )
    // 核心通道异常归一化为 Result（主进程 handler 抛错时不再向渲染层抛 Electron 原始拒绝）
    const malformed = await page.evaluate(
      (id) =>
        (window as unknown as { morrow: { session: { rename: (id: string, title: unknown) => Promise<IpcResult> } } })
          .morrow.session.rename(id, 123),
      sessionId
    )
    expect(malformed.ok).toBe(false)
    expect(malformed.error?.code).toBe('IPC_FAILED')
    expect(malformed.error?.message ?? '').not.toContain('Error invoking remote method')

    const invalidMode = await page.evaluate(
      (id) =>
        (window as unknown as { morrow: { session: { setPermissionMode: (id: string, mode: string) => Promise<IpcResult> } } })
          .morrow.session.setPermissionMode(id, 'yolo'),
      sessionId
    )
    expect(invalidMode.ok).toBe(false)
    expect(invalidMode.error?.code).toBe('INVALID_PERMISSION_MODE')

    const unknownFeature = await page.evaluate(() =>
      (window as unknown as { morrow: { features: { invoke: (channel: string) => Promise<IpcResult> } } })
        .morrow.features.invoke('feature:not-registered')
    )
    expect(unknownFeature.ok).toBe(false)
    expect(unknownFeature.error?.code).toBe('FEATURE_CHANNEL')

    // 生产 CSP：渲染层不应能任意 https 外联
    const cspBlocked = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/', { mode: 'no-cors' })
        return false
      } catch {
        return true
      }
    })
    expect(cspBlocked).toBe(true)

    // 主窗口不能被导航到任意本地文件
    const beforeUrl = page.url()
    await page
      .evaluate(() => {
        window.location.href = 'file:///C:/Windows/win.ini'
      })
      .catch(() => undefined)
    await page.waitForTimeout(600)
    expect(page.url()).toBe(beforeUrl)
    // 用 evaluate 而不是 locator：被拦截的导航会让 Playwright 一直等 "navigation to finish"
    const rootAlive = await page.evaluate(() => Boolean(document.querySelector('#root')))
    expect(rootAlive).toBe(true)
  } finally {
    await morrow.close()
  }
})
