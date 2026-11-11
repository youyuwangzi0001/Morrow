import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  clickPermissionCard,
  configureMockProvider,
  createSession,
  dismissOnboarding,
  launchMorrow,
  readStore,
  root,
  sendMessageViaStore,
  setThemeViaStore,
  waitForPermission,
  waitForRunStarted,
  waitForStoreReady,
  waitUntil,
  type MorrowApp
} from '../tests/e2e/helpers'
import { startMockLLM } from '../tests/fixtures/mock-llm.mjs'

const screens = join(root, 'docs', 'screens')
mkdirSync(screens, { recursive: true })

async function shot(page: MorrowApp['page'], name: string): Promise<void> {
  const file = join(screens, name)
  rmSync(file, { force: true })
  await page.waitForTimeout(300)
  await page.screenshot({ path: file })
  const buffer = readFileSync(file)
  expect(buffer.length, `${name} 不应为空`).toBeGreaterThan(10_000)
  expect(buffer.subarray(0, 8).toString('hex'), `${name} 必须是 PNG`).toBe('89504e470d0a1a0a')
  expect(buffer.readUInt32BE(16), `${name} 宽度`).toBe(2100)
  expect(buffer.readUInt32BE(20), `${name} 高度`).toBe(1200)
}

async function shotDesktop(app: MorrowApp['app'], page: MorrowApp['page'], name: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('#island'))
    if (!win) throw new Error('找不到主窗口')
    win.show()
    win.focus()
    win.setPosition(0, 0)
    win.moveTop()
  })
  await page.waitForTimeout(600)
  const file = join(screens, name)
  rmSync(file, { force: true })
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp=New-Object System.Drawing.Bitmap 2100,1200',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen(0,0,0,0,$bmp.Size)',
    `$bmp.Save('docs/screens/${name}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()'
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { cwd: root })
  const buffer = readFileSync(file)
  expect(buffer.subarray(0, 8).toString('hex'), `${name} 必须是 PNG`).toBe('89504e470d0a1a0a')
  expect(buffer.readUInt32BE(16), `${name} 宽度`).toBe(2100)
  expect(buffer.readUInt32BE(20), `${name} 高度`).toBe(1200)
}

async function closeCanvas(page: MorrowApp['page']): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore?: { getState: () => { closeCanvas?: () => void } } }).__morrowStore
    store?.getState().closeCanvas?.()
  })
}

async function newDemoWorkspace(page: MorrowApp['page']): Promise<string> {
  const result = await page.evaluate(async () => {
    const response = await window.morrow.workspace.createDemo()
    if (!response.ok) throw new Error(response.error.message)
    return response.data.path
  })
  return result
}

async function openEditor(page: MorrowApp['page'], workspace: string): Promise<void> {
  await page.evaluate(
    async (arg: { workspace: string; relative: string }) => {
      const absolutePath = `${arg.workspace.replace(/[\\/]+$/, '')}\\${arg.relative.split('/').join('\\')}`
      window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path: arg.relative, absolutePath } }))
    },
    { workspace, relative: 'README-待整理.md' }
  )
  await page.waitForSelector('.editor-pane', { timeout: 20_000 })
  await page.waitForTimeout(700)
}

test.describe.configure({ mode: 'serial' })

test('guide screens', async () => {
  test.setTimeout(240_000)
  const mock = await startMockLLM({
    scripts: [
      {
        text: '我先写一个测试文件。',
        toolCalls: [{ name: 'write_file', arguments: { path: '../permission-test-doc.md', content: 'hello from docs capture' } }]
      },
      { text: '好，那我不写文件了。' }
    ]
  })
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Morrow 内置浏览器</title>
      <style>body{font-family:serif;background:#f5f0e6;color:#20242a;margin:0;padding:42px}h1{font-size:28px}p{line-height:1.8;max-width:760px}
      .tag{display:inline-block;border:1px solid #b99a5b;border-radius:999px;padding:4px 10px;font-size:12px;color:#8a6b32}</style></head>
      <body><span class="tag">Morrow · 内置浏览器</span><h1>网页内容按不可信数据处理</h1>
      <p>这是文档截图使用的本地页面。Agent 可以读取标题和正文、按 ref 点击或输入、等待页面加载，并在底部实时显示操作轨迹。</p></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}/` : ''

  const morrow = await launchMorrow({
    name: 'docs-guide',
    env: { MORROW_DEMO_SPEED: '0.05' },
    timeoutMs: 90_000
  })
  const page = morrow.page
  try {
    await waitForStoreReady(page)
    await page.waitForSelector('.onb', { timeout: 30_000 })
    await page.waitForTimeout(800)
    await shot(page, 'guide-onboarding.png')

    await page.getByRole('button', { name: /先看一场演示/ }).first().click()
    await page.waitForSelector('.onb', { state: 'detached', timeout: 30_000 })
    await waitUntil(async () => {
      const state = await readStore(page)
      return state.run === null && (state.session?.messages.length ?? 0) > 2 ? true : null
    }, 120_000, '演示跑完')
    await closeCanvas(page)
    await page.waitForTimeout(600)
    await shot(page, 'guide-chat.png')

    const workspace = await newDemoWorkspace(page)
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, {
      workspace,
      ...provider,
      permissionMode: 'ask',
      title: '文档截图 · 权限'
    })
    await sendMessageViaStore(page, '请把结果写进 permission-test-doc.md。')
    await waitForRunStarted(page, 30_000)
    await waitForPermission(page, 60_000)
    await page.locator('.permission-card').waitFor({ state: 'visible' })
    await page.waitForTimeout(500)
    await shot(page, 'guide-permission.png')
    await clickPermissionCard(page, 'deny')

    await openEditor(page, workspace)
    await shot(page, 'guide-editor.png')

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
      store.getState().openSettings()
    })
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ state: 'visible' })
    for (const [tab, file] of [
      ['模型', 'guide-settings-models.png'],
      ['订阅', 'guide-settings-subscriptions.png'],
      ['外观', 'guide-settings-appearance.png'],
      ['本地', 'guide-settings-media.png']
    ] as const) {
      await settings.getByRole('tab', { name: tab }).click()
      await page.waitForTimeout(700)
      await shot(page, file)
    }
    await settings.getByRole('tab', { name: '更多功能' }).click()
    await settings.getByRole('button', { name: /^记忆/ }).click()
    await page.waitForTimeout(900)
    await shot(page, 'guide-memory.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    await morrow.app.evaluate(async (_electron, browserUrl) => {
      const service = (globalThis as unknown as {
        __morrowBrowserService?: { automationOpen: (url: string, options: { runId: string }) => Promise<unknown> }
      }).__morrowBrowserService
      if (!service) throw new Error('__morrowBrowserService 未暴露')
      await service.automationOpen(browserUrl, { runId: 'docs-browser' })
    }, url)
    await page.locator('.browser-surface').waitFor({ state: 'visible', timeout: 20_000 })
    await expect
      .poll(async () =>
        morrow.app.evaluate(async () => {
          const service = (globalThis as unknown as {
            __morrowBrowserService?: { automationRead: (options: { runId: string }) => Promise<{ text?: string }> }
          }).__morrowBrowserService
          if (!service) return ''
          const read = await service.automationRead({ runId: 'docs-browser' })
          return read.text ?? ''
        })
      )
      .toContain('网页内容按不可信数据')
    await page.waitForTimeout(900)
    await shotDesktop(morrow.app, page, 'guide-browser.png')
    await morrow.app.evaluate(async () => {
      const service = (globalThis as unknown as { __morrowBrowserService?: { closeAutomation?: () => Promise<void> } }).__morrowBrowserService
      await service?.closeAutomation?.()
    })
    await page.waitForTimeout(400)

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'terminal' } }))
    })
    await page.locator('.terminal-tab').first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('ls -1 && node -v')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1_500)
    await shotDesktop(morrow.app, page, 'guide-terminal.png')
  } finally {
    await morrow.close()
    await mock.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('super-agent screen', async () => {
  test.setTimeout(180_000)
  let mainCalls = 0
  const mock = await startMockLLM({
    respond: (ctx: { body: unknown }) => {
      const raw = JSON.stringify(ctx.body ?? {})
      if (!raw.includes('## 集群成员')) {
        mainCalls += 1
        if (mainCalls === 1) {
          return {
            text: '我把任务拆成两个 Worker：先定位登录入口，再审查风险。',
            toolCalls: [
              {
                name: 'swarm',
                arguments: {
                  goal: '检查登录流程',
                  max_parallel: 2,
                  watchdog_ms: 0,
                  tasks: [
                    { id: 'a', title: '定位登录入口', prompt: '定位登录入口并返回文件路径', deliverable: '登录入口文件与行号', agent: 'explore' },
                    {
                      id: 'b',
                      title: '审查登录风险',
                      prompt: '审查登录流程的风险',
                      deliverable: '风险清单与建议',
                      agent: 'review',
                      depends_on: ['a'],
                      needs: [{ task_id: 'a', result: '登录入口文件与行号' }]
                    }
                  ]
                }
              }
            ]
          }
        }
        return { text: '协作任务完成：入口已定位，未发现高危问题。' }
      }
      if (raw.includes('## 集群成员')) {
        return {
          text: raw.includes('你是代码侦察型集群成员') ? '探索完成：入口在 src/auth/login.ts。' : '审查完成：未发现高危问题，建议补一个锁定测试。',
          delayMs: 2500
        }
      }
      return { text: '收到。' }
    }
  })
  const workspace = join(root, 'tmp', `docs-super-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  const morrow = await launchMorrow({ name: 'docs-super-agent', timeoutMs: 90_000 })
  const page = morrow.page
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    const provider = await configureMockProvider(page, mock.openaiBaseUrl)
    await createSession(page, { workspace, ...provider, permissionMode: 'auto', title: '协作任务文档截图' })
    await page.locator('.composer-input').fill('检查登录流程，先定位入口，再审查风险。')
    await page.keyboard.press('Enter')
    // 截图选在一名成员完成、另一名仍在执行的时刻，能同时展示进度跟盯与单项停止/插话。
    await waitUntil(async () => {
      const state = await readStore(page)
      const tasks = state.session?.superAgent?.tasks ?? []
      return state.session?.superAgent?.status === 'running' &&
        tasks.some((task) => task.status === 'completed') &&
        tasks.some((task) => task.status === 'running')
        ? true
        : null
    }, 120_000, '一名成员完成、另一名执行中')
    await page.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('[aria-label="收起通知"]').forEach((button) => button.click())
    })
    await page.locator('.super-board .super-task.is-running').first().waitFor({ state: 'visible' })
    // 把驾驶舱滚到内容区顶部，文档截图同时展示目标、进度跟盯、成员行与单项动作。
    await page.locator('.super-board').evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
    await page.waitForTimeout(600)
    await shot(page, 'guide-collaboration.png')
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('studio screens', async () => {
  test.setTimeout(240_000)
  const morrow = await launchMorrow({ name: 'docs-studio', timeoutMs: 90_000 })
  const page = morrow.page
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.waitForTimeout(1_000)
    await shot(page, 'studio-home.png')

    await page.locator('.studio-logline-input').fill('一个雨夜，修伞的女孩捡到一把会让时间倒流的伞。')
    await page.locator('.studio-more-toggle').click()
    await page.waitForTimeout(600)
    await shot(page, 'studio-create.png')
    await page.locator('.studio-more-toggle').click()
    await page.waitForTimeout(300)

    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    await shot(page, 'studio-timeline.png')

    await page.locator('.studio-stage-item', { hasText: '蓝图' }).click()
    await page.waitForSelector('.studio-blueprint', { timeout: 20_000 })
    await page.waitForTimeout(600)
    await shot(page, 'studio-blueprint.png')

    await page.locator('.studio-stage-item').nth(2).click()
    await page.waitForSelector('.studio-shot-card', { timeout: 20_000 })
    await page.locator('.studio-shot-card').nth(6).click()
    await page.waitForTimeout(600)
    await shot(page, 'studio-storyboard.png')

    await page.locator('.studio-canvas-link').click()
    await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
    await page.waitForTimeout(1_500)
    await shot(page, 'studio-canvas.png')
    await page.locator('.studio-canvas-action').filter({ hasText: '时间线' }).click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })

    await page.locator('.studio-stage-item', { hasText: '声音' }).click()
    await page.waitForSelector('.studio-sound-tabs', { timeout: 15_000 })
    await page.locator('.studio-sound-tabs').getByRole('tab', { name: '配音' }).click()
    await page.waitForTimeout(700)
    await shot(page, 'studio-voice.png')
    await page.locator('.studio-sound-tabs').getByRole('tab', { name: '音乐' }).click()
    await page.waitForTimeout(700)
    await shot(page, 'studio-music.png')

    await page.locator('.studio-stage-item', { hasText: '检查' }).click()
    await page.waitForSelector('.studio-review', { timeout: 15_000 })
    await page.waitForTimeout(600)
    await shot(page, 'studio-review.png')

    await page.locator('.studio-stage-item', { hasText: '交付' }).click()
    await page.waitForSelector('.studio-delivery', { timeout: 20_000 })
    await page.waitForTimeout(800)
    await shot(page, 'studio-delivery.png')

    await page.locator('.studio-home-link').click()
    await page.waitForSelector('.studio-home', { timeout: 15_000 })
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
    const composer = page.locator('.studio-assistant-composer textarea')
    await composer.fill('镜 01 慢 20%，雨声压低一点，不要改脸。')
    await composer.press('Enter')
    await page.waitForSelector('.studio-plan-card', { timeout: 20_000 })
    await page.waitForTimeout(700)
    await shot(page, 'studio-assistant.png')

    await page.locator('.studio-top-icon[title="创作台设置"]').click()
    await page.waitForSelector('.studio-settings-layout', { timeout: 15_000 })
    await page.waitForTimeout(500)
    await shot(page, 'studio-settings.png')
    await page.getByRole('tab', { name: '回收站' }).click()
    await page.waitForTimeout(500)
    await shot(page, 'studio-trash.png')
    await page.locator('.studio-modal-footer .btn', { hasText: '关闭' }).click()
    await page.waitForTimeout(300)

    await page.locator('.studio-home-link').click()
    await page.waitForSelector('.studio-home', { timeout: 15_000 })
    await page.locator('.studio-project-card', { hasText: '雨伞铺的第七个夏天' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-writing', { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    await shot(page, 'studio-writing.png')

    await page.locator('.studio-home-link').click()
    await page.waitForSelector('.studio-home', { timeout: 15_000 })
    await page.getByRole('button', { name: '切换主题' }).click()
    await page.waitForTimeout(700)
    await shot(page, 'studio-light.png')
  } finally {
    await morrow.close()
  }
})
