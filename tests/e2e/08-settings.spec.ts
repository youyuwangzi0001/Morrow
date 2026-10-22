/**
 * 合并自 6 个 E2E spec：b6-settings.spec.ts、settings-archive.spec.ts、settings-onboarding.spec.ts、data-dir-settings.spec.ts、a7-answer-style.spec.ts、r13-answer-settings.spec.ts
 * 每个原 spec 整体包在独立 test.describe 中，hooks 与局部变量互不污染。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screensDir, screenshotPath } from './launch'
import type { MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { configureMockProvider, createSession, dismissOnboarding, getEvents, installEventCollector, readStore, sendMessageViaStore, setThemeViaStore, waitForRunFinished, waitForStoreReady, waitUntil } from './store'

// ── 原文件：b6-settings.spec.ts ──────────────────────────────────────────────
test.describe('b6-settings.spec.ts', () => {
/**
 * B6 设置与状态：自动命名开关、模型 Key 状态、提供方链接、打开目录错误。
 */

test.describe('B6 设置与状态', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('自动命名开关真正生效：关闭时保持新对话，开启后按首条消息命名', async () => {
    test.setTimeout(120_000)
    const workspace = join(root, 'tmp', `b6-autoname-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({
      scripts: [{ text: '好的。' }, { text: '整理好了。' }]
    })
    morrow = await launchMorrow({ name: 'b6-autoname', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await installEventCollector(page)

      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ autoTitle: false })
      })
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '新对话' })
      await sendMessageViaStore(page, '关闭自动命名时的第一条消息')
      await waitForRunFinished(page, 60_000)
      await waitUntil(async () => (await readStore(page)).session?.title === '新对话', 10_000, '关闭时保持新对话')

      await page.evaluate(async () => {
        const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        await store.getState().updateSettings({ autoTitle: true })
      })
      await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '新对话' })
      await sendMessageViaStore(page, '帮我整理季度销售数据')
      await waitForRunFinished(page, 60_000)
      const title = await waitUntil(
        async () => {
          const value = (await readStore(page)).session?.title ?? ''
          return value !== '新对话' ? value : null
        },
        10_000,
        '开启后自动命名'
      )
      expect(title).toContain('帮我整理季度销售数据')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })

  test('模型状态显示 Key 已保存；关于页链接跟随提供方；打开目录失败会报错', async () => {
    test.setTimeout(90_000)
    morrow = await launchMorrow({ name: 'b6-provider', timeoutMs: 90_000 })
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    await page.evaluate(async () => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
      const saved = await window.morrow.settings.saveProvider({
        config: {
          id: 'b6-provider',
          kind: 'openai-compat',
          name: 'B6 测试服务',
          baseUrl: 'https://api.example.com/v1',
          models: [{ id: 'b6-model', label: 'B6 Model', contextWindow: 128_000, supportsTools: true }],
          apiKeyStored: false,
          enabled: true,
          isBuiltin: false,
          category: 'custom'
        },
        apiKey: 'sk-b6-test-key'
      })
      if (!saved.ok) throw new Error(saved.error.message)
      await store.getState().updateSettings({
        defaultModel: { providerId: 'b6-provider', modelId: 'b6-model' }
      })
    })

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '模型' }).click()
    await expect(settings.locator('.st-provider-state').filter({ hasText: 'Key 已保存' })).toBeVisible()

    await settings.getByRole('tab', { name: '关于' }).click()
    // R12：无交互的「隐私」区块已删除，关于页直接进入快捷键
    await expect(settings.locator('.st-about-privacy')).toHaveCount(0)
    await expect(settings.getByText('键盘快捷键')).toBeVisible()
    await expect(settings.getByRole('button', { name: '更改目录' })).toBeVisible()
    await expect(settings.getByRole('button', { name: '更改目录' })).toBeDisabled()
    await expect(settings).toContainText('当前数据目录由启动参数指定')
    await settings.screenshot({ path: screenshotPath('settings-about-data-dir.png') })

    await app.evaluate(async ({ shell }) => {
      ;(shell as unknown as { openPath: (path: string) => Promise<string> }).openPath = async () => '拒绝访问（测试）'
    })
    const dataDir = await page.evaluate(() => window.morrow.app.openDataDir())
    expect(dataDir.ok).toBe(false)
    if (!dataDir.ok) expect(dataDir.error.message).toContain('拒绝访问（测试）')
    const logs = await page.evaluate(() => window.morrow.app.openLogs())
    expect(logs.ok).toBe(false)
    if (!logs.ok) expect(logs.error.message).toContain('拒绝访问（测试）')
  })
})

})

// ── 原文件：settings-archive.spec.ts ──────────────────────────────────────────────
test.describe('settings-archive.spec.ts', () => {
/**
 * 对话归档管理：归档后只在 设置 → 归档 中出现，可恢复、可永久删除；
 * 关于页不再承载「清除全部对话」。
 */

function workspaceAt(name: string): string {
  const path = join(root, 'tmp', `${name}-${Date.now()}`)
  mkdirSync(path, { recursive: true })
  return path
}

test('设置中的对话归档：归档、恢复与永久删除', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [{ text: '甲的归档前回答。' }, { text: '乙的归档前回答。' }]
  })
  const workspace = workspaceAt('e2e-settings-archive')
  const morrow = await launchMorrow({ name: 'settings-archive', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await installEventCollector(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)

    const finishedRuns = async (): Promise<number> =>
      (await getEvents(page)).filter((event) => event.type === 'run_finished').length
    const waitForNextFinish = async (before: number, label: string): Promise<void> =>
      waitUntil(async () => (await finishedRuns()) > before, 30_000, label)

    let finished = await finishedRuns()
    const firstId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '归档测试甲'
    })
    await sendMessageViaStore(page, '甲的问题')
    await waitForNextFinish(finished, '甲回答完成')

    finished = await finishedRuns()
    const secondId = await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '归档测试乙'
    })
    await sendMessageViaStore(page, '乙的问题')
    await waitForNextFinish(finished, '乙回答完成')

    await page.evaluate(async (ids: string[]) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setSessionArchived: (id: string, value: boolean) => Promise<void> } }
      }).__morrowStore
      for (const id of ids) await store.getState().setSessionArchived(id, true)
    }, [firstId, secondId])
    await waitUntil(async () => {
      const state = await readStore(page)
      return [firstId, secondId].every(
        (id) => state.sessions.find((session) => session.id === id)?.archived === true
      )
    }, 15_000, '两个对话已归档')
    await expect(page.getByText('归档测试甲', { exact: true })).toHaveCount(0)
    await expect(page.getByText('归档测试乙', { exact: true })).toHaveCount(0)
    await expect(page.locator('.sb-group.is-archived')).toHaveCount(0)

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-archive').click()
    const archive = page.locator('.st-archive')
    await expect(archive).toContainText('已归档 2 个对话')
    const firstRow = archive.locator('.st-archive-row').filter({ hasText: '归档测试甲' })
    const secondRow = archive.locator('.st-archive-row').filter({ hasText: '归档测试乙' })
    await expect(firstRow).toBeVisible()
    await expect(secondRow).toBeVisible()
    await expect(firstRow).toContainText('2 条消息')
    await expect(secondRow).toContainText('2 条消息')
    await expect(page.locator('#st-tab-archive')).toHaveAttribute('aria-selected', 'true')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-archive-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('settings-archive-light.png') })
    await setThemeViaStore(page, 'dark')

    await firstRow.getByRole('button', { name: '恢复' }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.sessions.find((session) => session.id === firstId)?.archived === false
    }, 15_000, '甲已恢复')
    await expect(firstRow).toHaveCount(0)
    await expect(archive).toContainText('已归档 1 个对话')

    await secondRow.getByRole('button', { name: '删除归档对话「归档测试乙」' }).click()
    const dialog = page.getByRole('dialog', { name: '删除归档对话？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('归档测试乙')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-archive-delete.png') })
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await waitUntil(async () => {
      const state = await readStore(page)
      return !state.sessions.some((session) => session.id === secondId)
    }, 20_000, '乙已删除')
    expect(existsSync(join(morrow.dataDir, 'sessions', `${secondId}.json`))).toBe(false)
    await expect(archive).toContainText('还没有归档的对话')

    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.getByText('归档测试甲', { exact: true })).toBeVisible()
    await expect(page.getByText('归档测试乙', { exact: true })).toHaveCount(0)

    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
        .getState()
        .openSettings()
    })
    await page.locator('#st-tab-about').click()
    await expect(page.locator('.st-about')).not.toContainText('清除全部对话')
    await page.locator('#st-tab-archive').click()
    await expect(page.locator('.st-archive .st-danger-zone')).toContainText('清除全部对话')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

})

// ── 原文件：settings-onboarding.spec.ts ──────────────────────────────────────────────
test.describe('settings-onboarding.spec.ts', () => {
/**
 * 设置与首次引导回归：
 * - 引导是真正的模态层：焦点陷阱、全局快捷键不穿透；
 * - 切换服务商清空上一家输入的 Key；
 * - 最近工作区失效时明确报错，不假装已选中；
 * - 设置页检测到未保存的 Base URL 时，先提示保存再同步。
 */

let localSyncServer: Server | null = null
test.afterEach(async () => {
  if (!localSyncServer) return
  const server = localSyncServer
  localSyncServer = null
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('首次引导：焦点陷阱、快捷键隔离、切换服务商清 Key、失效工作区提示', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'onboarding-audit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await expect(page.locator('.onb')).toBeVisible()
    await page.waitForTimeout(300)

    const focusInside = async (): Promise<boolean> =>
      page.evaluate(() => Boolean(document.activeElement?.closest('.onb')))
    expect(await focusInside()).toBe(true)
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press('Tab')
      expect(await focusInside()).toBe(true)
    }

    // 引导打开时 Ctrl+K 不应穿透打开命令面板
    await page.keyboard.press('Control+K')
    await page.waitForTimeout(250)
    await expect(page.locator('.palette')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => { paletteOpen: boolean } } }).__morrowStore.getState().paletteOpen)).toBe(false)

    await page.getByRole('button', { name: '开始设置' }).click()
    await page.locator('#onb-api-key').fill('sk-should-not-leak')
    await expect(page.locator('#onb-api-key')).toHaveValue('sk-should-not-leak')
    await page.getByRole('radio', { name: /Anthropic/ }).click()
    await expect(page.locator('#onb-api-key')).toHaveValue('')

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('onboarding-provider-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('onboarding-provider-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(250)

    // 失效的最近工作区：不能假装选中
    const missing = join(root, 'tmp', `missing-workspace-${Date.now()}`)
    await page.evaluate(async (path) => {
      const store = (window as unknown as { __morrowStore: { getState: () => { updateSettings: (patch: unknown) => Promise<void> } } }).__morrowStore
      await store.getState().updateSettings({ recentWorkspaces: [path] })
    }, missing)
    await page.getByRole('button', { name: '下一步' }).click()
    const recent = page.locator('.onb-recent-item').first()
    await expect(recent).toBeVisible()
    await recent.click()
    await expect(page.locator('.onb-error')).toContainText('已经不可用')
    await expect(page.locator('.onb-workspace.is-chosen')).toHaveCount(0)
  } finally {
    await morrow.close()
  }
})

test('设置页：未保存 Base URL 时先提示保存；切换服务商清空 Key', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'settings-audit', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.keyboard.press('Control+,')
    await expect(page.locator('#st-base-url')).toBeVisible({ timeout: 10_000 })

    // 记住上次分类：关闭再打开时焦点与可见分类一致
    await page.locator('#st-tab-appearance').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#st-tab-appearance')).toHaveCount(0)
    await page.keyboard.press('Control+,')
    await expect(page.locator('#st-tab-appearance')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#st-tab-appearance')).toBeFocused()
    await page.locator('#st-tab-models').click()
    await expect(page.locator('#st-base-url')).toBeVisible()

    await page.locator('#st-base-url').fill('https://example.invalid/v1')
    await page.getByRole('button', { name: '刷新可用模型' }).click()
    await expect(page.getByText('还没保存的 Base URL')).toBeVisible()

    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('settings-unsaved-baseurl-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('settings-unsaved-baseurl-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(250)

    await page.locator('#st-api-key').fill('sk-settings-provider-switch')
    const pickProvider = async (label: string): Promise<void> => {
      await page.getByRole('button', { name: '选择模型服务' }).click()
      await page.getByRole('option').filter({ hasText: label }).click()
    }
    await pickProvider('Kimi（月之暗面）')
    await expect(page.locator('#st-api-key')).toHaveValue('')

    // 本地服务不需要 Key 也能同步模型
    localSyncServer = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'local-e2e-model', context_length: 8192, max_output_tokens: 2048 }] }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    await new Promise<void>((resolve) => localSyncServer!.listen(0, '127.0.0.1', resolve))
    const address = localSyncServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await pickProvider('Ollama（本地）')
    // 完整推理地址也应能正确归一到 /v1/models
    await page.locator('#st-base-url').fill(`http://127.0.0.1:${port}/v1/chat/completions`)
    await page.getByRole('button', { name: '保存连接' }).click()
    await expect(page.getByText('已保存并生效')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '刷新可用模型' }).click()
    await expect(page.getByText(/同步完成：1 个模型/)).toBeVisible({ timeout: 20_000 })
    const ollamaModels = await page.evaluate(() => {
      const settings = (window as unknown as { __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string }> }> } } } }).__morrowStore.getState().settings
      return settings.providers.find((provider) => provider.id === 'ollama')?.models.map((model) => model.id) ?? []
    })
    expect(ollamaModels).toContain('local-e2e-model')
    const dismissToasts = async (): Promise<void> => {
      // 直接触发 DOM click，避免 toast 消失后 Playwright 继续等待已卸载的按钮
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
      })
      await page.waitForTimeout(220)
    }
    await dismissToasts()
    await page.evaluate(() => {
      const note = Array.from(document.querySelectorAll('p')).find((element) => element.textContent?.includes('同步完成'))
      note?.scrollIntoView({ block: 'center' })
    })
    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('settings-local-sync-dark.png') })

    // 关于页品牌标识使用重绘 icon，而不是字母 M
    await page.locator('#st-tab-about').click()
    await expect(page.locator('img.st-about-mark')).toHaveAttribute('src', /brand-mark/)
    await dismissToasts()
    await page.locator('img.st-about-mark').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('settings-about-dark.png') })

    // 关闭设置后回到主界面
    await page.keyboard.press('Escape')
    await expect(page.locator('#st-base-url')).toHaveCount(0)
    expect((await readStore(page)).settingsOpen).toBe(false)
  } finally {
    await morrow.close()
  }
})

})

// ── 原文件：data-dir-settings.spec.ts ──────────────────────────────────────────────
test.describe('data-dir-settings.spec.ts', () => {
/**
 * 数据目录自定义：真实走主进程选目录 → 迁移 → 写指针 → 恢复默认。
 * 测试用 MORROW_DATA_LOCATION_FILE 把指针放到项目 tmp/，避免碰真实用户配置；
 * 测试模式不重启应用，因此可以直接断言指针与迁移结果。
 */

test.describe('数据目录设置', () => {
  let morrow: MorrowApp | null = null
  let target = ''
  let pointer = ''

  test.afterEach(async () => {
    await morrow?.close()
    morrow = null
    if (target) rmSync(target, { recursive: true, force: true })
    if (pointer) rmSync(pointer, { force: true })
  })

  test('更改目录会迁移数据并写入指针；恢复默认会移除指针', async () => {
    test.setTimeout(120_000)
    mkdirSync(join(root, 'tmp'), { recursive: true })
    target = mkdtempSync(join(root, 'tmp', 'data-dir-target-'))
    pointer = join(root, 'tmp', `data-location-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)

    morrow = await launchMorrow({
      name: 'data-dir-settings',
      timeoutMs: 90_000,
      env: {
        MORROW_ALLOW_DATA_DIR_CHANGE: '1',
        MORROW_DATA_LOCATION_FILE: pointer
      }
    })
    const { page, app } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)

    // 主进程原生对话框在测试中替换为固定返回值：选择 target，并选择「迁移并重启」
    await app.evaluate(async ({ dialog }, selected) => {
      const patched = dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>
        showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>
      }
      patched.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      patched.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }, target)

    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '关于' }).click()
    const change = settings.getByRole('button', { name: '更改目录' })
    await expect(change).toBeEnabled({ timeout: 10_000 })
    await change.click()
    await expect(page.getByText(/数据目录已保存，重启后生效/)).toBeVisible({ timeout: 20_000 })

    expect(existsSync(pointer)).toBe(true)
    const saved = JSON.parse(readFileSync(pointer, 'utf8')) as { dataDir: string }
    expect(saved.dataDir).toBe(resolve(target))
    expect(existsSync(join(target, 'settings.json'))).toBe(true)
    expect(existsSync(join(target, 'sessions'))).toBe(true)
    expect(existsSync(join(target, 'Cache'))).toBe(false)

    const reset = await page.evaluate(() => window.morrow.app.resetDataDir())
    expect(reset.ok).toBe(true)
    expect(existsSync(pointer)).toBe(false)
  })
})

})

// ── 原文件：a7-answer-style.spec.ts ──────────────────────────────────────────────
test.describe('a7-answer-style.spec.ts', () => {
/**
 * A7：全局回答风格。
 * - 设置里的选择写入真实设置，并进入所有新回答的 system prompt；
 * - 侧边聊天同样遵守；
 * - 自定义偏好可保存、重置。
 */

function systemText(body: Record<string, any> | undefined): string {
  if (!body) return ''
  if (typeof body.system === 'string') return body.system
  return (Array.isArray(body.messages) ? body.messages : [])
    .filter((message: { role?: string }) => message.role === 'system')
    .map((message: { content?: unknown }) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
}

test.describe('全局回答风格', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('预设与自定义风格进入主对话和侧边聊天，并可恢复默认', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      respond: (ctx: { body?: unknown }) => {
        const raw = JSON.stringify(ctx.body ?? {})
        if (raw.includes('侧边聊天')) return { text: '侧边风格答复。', chunkDelayMs: 3 }
        return { text: '主对话风格答复。', chunkDelayMs: 3 }
      }
    })
    const workspace = join(root, 'tmp', `e2e-a7-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    morrow = await launchMorrow({ name: 'a7-answer-style', timeoutMs: 90_000 })
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'auto',
      title: '回答风格测试'
    })

    const openStyleTab = async (): Promise<void> => {
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .openSettings()
      })
      await page.locator('#st-tab-style').click()
      await expect(page.getByRole('radiogroup', { name: '全局回答风格' }).getByRole('radio')).toHaveCount(5)
    }
    const closeSettings = async (): Promise<void> => {
      await page.evaluate(() => {
        ;(window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore
          .getState()
          .closeSettings()
      })
      await expect(page.locator('.st-style')).toBeHidden()
    }
    const sendAndWait = async (text: string, expectedMessages: number): Promise<void> => {
      await page.locator('.composer-input').fill(text)
      await page.locator('.composer-input').press('Enter')
      await waitUntil(
        async () => (await readStore(page)).run === null && (await readStore(page)).session?.messages.length === expectedMessages,
        60_000,
        `第 ${expectedMessages / 2} 轮回答完成`
      )
    }

    // 1. 选择「简洁」
    await openStyleTab()
    const styleGroup = page.getByRole('radiogroup', { name: '全局回答风格' })
    await styleGroup.getByRole('radio', { name: '简洁', exact: true }).click()
    await expect(styleGroup.getByRole('radio', { name: '简洁', exact: true })).toHaveAttribute('aria-checked', 'true')
    const conciseSettings = await page.evaluate(async () => window.morrow.settings.get())
    expect(conciseSettings.ok).toBe(true)
    if (conciseSettings.ok) expect(conciseSettings.data.answerStyle).toBe('concise')
    await closeSettings()
    await sendAndWait('第一问：先给结论。', 2)

    // 2. 选择自定义并保存偏好
    await openStyleTab()
    await styleGroup.getByRole('radio', { name: '自定义', exact: true }).click()
    const customText = '像给同事讲方案：先给结论，再列两条依据；不要客套话。'
    await page.locator('#st-answer-style-custom').fill(customText)
    await page.getByRole('button', { name: '保存偏好' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'custom' && result.data.answerStyleCustom === customText
    }, 15_000, '自定义风格保存')
    await page.locator('.st-panel').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a7-answer-style.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('light')
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(260)
    await page.screenshot({ path: join(screensDir, 'a7-answer-style-light.png') })
    await page.evaluate(() => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { setTheme: (value: string) => void } }
      }).__morrowStore
      store.getState().setTheme('dark')
    })
    await closeSettings()
    await sendAndWait('第二问：按自定义风格回答。', 4)

    // 3. 侧边聊天也使用自定义风格
    await page.locator('.composer-input').fill('/btw 用一句话总结这个项目')
    await page.locator('.composer-input').press('Enter')
    const drawer = page.getByRole('complementary', { name: '侧边聊天' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('侧边风格答复。')).toBeVisible({ timeout: 30_000 })

    const requestFor = (needle: string): Record<string, any> | undefined =>
      mock.requests.find((request: { body?: unknown }) => JSON.stringify(request.body ?? {}).includes(needle))?.body
    const firstMain = systemText(requestFor('第一问：先给结论。'))
    const secondMain = systemText(requestFor('第二问：按自定义风格回答。'))
    const side = systemText(requestFor('侧边聊天'))
    expect(firstMain).toContain('当前风格：简洁')
    expect(firstMain).toContain('1–3 句')
    expect(secondMain).toContain('当前风格：自定义')
    expect(secondMain).toContain(customText)
    expect(side).toContain('当前风格：自定义')
    expect(side).toContain(customText)

    // 4. 清空自定义偏好仍可保存：留空时回落到平衡规则
    await drawer.getByRole('button', { name: '关闭侧边聊天' }).click()
    await openStyleTab()
    const customField = page.locator('#st-answer-style-custom')
    await expect(customField).toHaveValue(customText)
    await customField.fill('')
    await page.getByRole('button', { name: '保存偏好' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'custom' && result.data.answerStyleCustom === ''
    }, 15_000, '清空自定义偏好')

    // 5. 恢复默认
    await page.getByRole('button', { name: '恢复默认' }).click()
    await waitUntil(async () => {
      const result = await page.evaluate(async () => window.morrow.settings.get())
      return result.ok && result.data.answerStyle === 'balanced' && result.data.answerStyleCustom === ''
    }, 15_000, '恢复默认风格')
    await expect(page.getByRole('radiogroup', { name: '全局回答风格' }).getByRole('radio', { name: '平衡', exact: true })).toHaveAttribute('aria-checked', 'true')
  })
})

})

// ── 原文件：r13-answer-settings.spec.ts ──────────────────────────────────────────────
test.describe('r13-answer-settings.spec.ts', () => {
/**
 * R13 回答设置：回答风格紧凑化，发送/命名/通知集中到「回答」页。
 */

test('回答页使用紧凑风格选择，并集中运行中发送、发送键、自动命名与完成通知', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'r13-answer-settings', timeoutMs: 90_000 })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('tab', { name: '回答' }).click()

    const style = settings.getByRole('radiogroup', { name: '全局回答风格' })
    await expect(style).toBeVisible()
    await expect(style.getByRole('radio')).toHaveCount(5)
    await expect(settings.locator('.st-style-card')).toHaveCount(0)

    await settings.getByRole('radiogroup', { name: '运行中发送方式' }).getByRole('radio', { name: '插话' }).click()
    await expect(
      settings.getByRole('radiogroup', { name: '运行中发送方式' }).getByRole('radio', { name: '插话' })
    ).toHaveAttribute('aria-checked', 'true')
    await expect(settings.getByRole('radiogroup', { name: '发送键' })).toBeVisible()
    await expect(settings.getByRole('switch', { name: '自动命名对话' })).toBeVisible()
    await expect(settings.getByRole('switch', { name: '任务完成时通知我' })).toBeVisible()

    await page.waitForTimeout(200)
    await page.screenshot({ path: screenshotPath('r13-answer-settings-dark.png') })
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('r13-answer-settings-light.png') })
  } finally {
    await morrow.close()
  }
})

})

test('设置分页直接展示选项，不重复分页标题', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'settings-headings' })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })

    const redundant = [
      { tab: '模型', heading: '模型服务' },
      { tab: '联网搜索', heading: '联网搜索' },
      { tab: '归档', heading: '对话归档' },
      { tab: '功能与工具', heading: '功能与工具' },
      { tab: '终端', heading: '终端' },
      { tab: '外观', heading: '外观' }
    ]
    for (const item of redundant) {
      await settings.getByRole('tab', { name: item.tab, exact: true }).click()
      const panel = settings.getByRole('tabpanel')
      await expect(panel.locator('.st-section-title').filter({ hasText: item.heading })).toHaveCount(0)
    }

    await settings.getByRole('tab', { name: '联网搜索', exact: true }).click()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('settings-search-no-duplicate-title.png') })
  } finally {
    await morrow.close()
  }
})
