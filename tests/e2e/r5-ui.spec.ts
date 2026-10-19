/**
 * R5 UI 验收：侧栏拖拽/完全收起、画布开关、设置最新模型分组、上下文 Tab、真实同步模型列表。
 * 运行：npx playwright test tests/e2e/r5-ui.spec.ts
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchMorrow, screenshotPath, type MorrowApp } from './launch'

function readDeepSeekKey(): string {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return (raw.match(/DEEPSEEK_API_KEY:\s*['"]?([A-Za-z0-9_\-]+)/) ?? [])[1] ?? ''
  } catch {
    return ''
  }
}

async function dismissOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __morrowStore: { setState: (patch: Record<string, unknown>) => void } }).__morrowStore
    store.setState({ onboardingOpen: false })
  })
  await page.waitForTimeout(150)
}

async function storeState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as unknown as { __morrowStore: { getState: () => Record<string, unknown> } }).__morrowStore.getState())
}

test.describe('R5 UI 交互', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('侧栏可拖动调宽（金色提示线）、双击复位、收起后完全隐藏', async () => {
    morrow = await launchMorrow({ name: 'r5-sidebar', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.screenshot({ path: screenshotPath('r5-final-welcome.png') })

    const shell = page.locator('.app-sidebar-shell')
    await expect(shell).toHaveCount(1)
    await page.waitForTimeout(500)
    const before = await shell.evaluate((el) => el.clientWidth)
    expect(before).toBeGreaterThan(200)
    const box = await page.locator('.sidebar-resizer').boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + 200

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 96, startY, { steps: 6 })
    await expect(page.locator('.resize-line')).toBeVisible()
    const during = await shell.evaluate((el) => el.clientWidth)
    expect(during).toBeGreaterThan(before + 60)
    await page.screenshot({ path: screenshotPath('r5-final-sidebar-resizing.png') })
    await page.mouse.up()
    await page.waitForTimeout(400)
    const state = await storeState(page)
    expect(Number((state.settings as { sidebarWidth: number }).sidebarWidth)).toBeGreaterThan(before + 60)
    const after = await shell.evaluate((el) => el.clientWidth)
    expect(after).toBeGreaterThan(before + 60)

    // 双击恢复默认 240
    await page.locator('.sidebar-resizer').dblclick()
    await page.waitForTimeout(300)
    expect(await shell.evaluate((el) => el.clientWidth)).toBe(240)

    // 收起：侧栏 DOM 完全消失
    await page.locator('[aria-label="收起侧栏 (Ctrl+B)"]').click()
    await expect(page.locator('.app-sidebar-shell')).toHaveCount(0)
    await expect(page.locator('.sidebar-resizer')).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('r5-final-sidebar-collapsed.png') })
    await page.locator('[aria-label="收起侧栏 (Ctrl+B)"]').click()
    await expect(page.locator('.app-sidebar-shell')).toHaveCount(1)
  })

  test('标题栏画布按钮：无产物时展开空态、再次收起', async () => {
    morrow = await launchMorrow({ name: 'r5-canvas', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    // R9：无内容时不显示“画布”字样，头部只保留关闭按钮
    await expect(page.locator('.canvas-head-title')).toHaveCount(0)
    await expect(page.locator('.canvas-root')).not.toContainText('画布')
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('r5-final-canvas-empty.png') })
    await page.locator('[aria-label="收起画布"]').click()
    await expect(page.locator('.canvas-root')).toHaveCount(0)
    // 打开设置后再关闭，确认画布不会误开
    await page.locator('[aria-label="展开画布"]').click()
    await expect(page.locator('.canvas-root')).toBeVisible()
    await page.locator('[aria-label="收起画布"]').click()
    await expect(page.locator('.canvas-root')).toHaveCount(0)
  })

  test('设置：最新模型分组 / 上下文 Tab / 自动压缩开关', async () => {
    morrow = await launchMorrow({ name: 'r5-settings', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    await page.evaluate(() => {
      ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore.getState().openSettings()
    })
    const dialog = page.locator('[role="dialog"]').first()
    await expect(dialog).toBeVisible()

    // 分组、provider 名称与当前默认模型
    for (const group of ['国内', '国际', '聚合平台', '本地']) {
      await expect(dialog.getByText(group, { exact: true }).first()).toBeVisible()
    }
    for (const provider of ['DeepSeek', 'Kimi（月之暗面）', '通义千问（阿里云）', '智谱 GLM（Z.AI）', 'MiniMax', 'Anthropic Claude', 'OpenAI', 'Google Gemini', 'xAI Grok', 'OpenRouter（模型聚合）', 'Ollama（本地）', 'LM Studio（本地）']) {
      await expect(dialog.getByText(provider, { exact: true }).first()).toBeVisible()
    }
    await expect(dialog.getByText(/可用模型会随服务商更新/)).toBeVisible()
    await expect(dialog.getByText('DeepSeek V4.1 Flash').first()).toBeVisible()
    const providerCount = await dialog.locator('.st-provider').count()
    expect(providerCount).toBeGreaterThanOrEqual(12)
    await page.waitForTimeout(450)
    await page.screenshot({ path: screenshotPath('r5-final-settings-models.png') })

    // 逐个 provider 检查最新模型
    const latestByProvider: Array<[string, string[]]> = [
      ['OpenAI', ['GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna']],
      ['智谱 GLM（Z.AI）', ['GLM-5.3', 'GLM-5.3 Flash']],
      ['xAI Grok', ['Grok 4.7']],
      ['Google Gemini', ['Gemini 4 Argon', 'Gemini 3.8 Flash']],
      ['DeepSeek', ['DeepSeek V4.1 Flash', 'DeepSeek V4 Pro']],
      ['Anthropic Claude', ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']]
    ]
    for (const [provider, models] of latestByProvider) {
      await dialog.getByRole('radio', { name: new RegExp(provider) }).click()
      for (const model of models) {
        await expect(dialog.getByText(new RegExp(model)).first()).toBeVisible()
      }
      if (provider === 'OpenAI') {
        await page.waitForTimeout(300)
        await page.screenshot({ path: screenshotPath('r5-final-settings-models-openai.png') })
      }
    }
    // 回到默认 provider，保持默认模型卡片与顶部一致
    await dialog.getByRole('radio', { name: /DeepSeek/ }).click()

    // 上下文 Tab
    await dialog.locator('#st-tab-context').click()
    await expect(dialog.getByText('自动压缩').first()).toBeVisible()
    const compactSwitch = dialog.locator('[role="switch"]').first()
    await expect(compactSwitch).toBeVisible()
    const before = (await storeState(page)).settings as { autoCompact: boolean }
    await compactSwitch.click()
    await page.waitForTimeout(400)
    const after = (await storeState(page)).settings as { autoCompact: boolean }
    expect(after.autoCompact).toBe(!before.autoCompact)
    await page.waitForTimeout(350)
    await page.screenshot({ path: screenshotPath('r5-final-settings-context.png') })
  })

  test('真实 DeepSeek 对话：上下文用量 = 最近一次请求 input+output', async () => {
    const key = readDeepSeekKey()
    test.skip(!key, '本机没有 DeepSeek Key，跳过真实对话用例')
    morrow = await launchMorrow({ name: 'r5-live', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    const saved = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { settings: { providers: Array<Record<string, unknown>> } } }
      }).__morrowStore.getState()
      const provider = store.settings.providers.find((p) => p.id === 'deepseek')!
      return window.morrow.settings.saveProvider({ config: provider as never, apiKey })
    }, key)
    expect(saved.ok).toBe(true)
    const demo = await page.evaluate(() => window.morrow.workspace.createDemo())
    expect(demo.ok).toBe(true)
    if (demo.ok) {
      await page.evaluate(async (wsPath) => {
        const store = (window as unknown as { __morrowStore: { getState: () => { newSession: (o: { workspace: string }) => Promise<unknown> } } }).__morrowStore.getState()
        await store.newSession({ workspace: wsPath })
      }, demo.data.path)
    }
    await page.waitForTimeout(300)

    const composer = page.locator('.composer textarea, textarea.composer-input').first()
    await composer.fill('只回复两个字：你好。不要调用任何工具。')
    await composer.press('Enter')

    await page.waitForFunction(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return !s.run && (s.session?.usage?.inputTokens ?? 0) > 0
    }, { timeout: 90_000 })

    const usage = await page.evaluate(() => {
      const s = (window as unknown as { __morrowStore: { getState: () => Record<string, any> } }).__morrowStore.getState()
      return {
        usage: s.session.usage,
        model: s.session.model,
        label: s.settings.providers
          .find((p: any) => p.id === s.session.model.providerId)?.models
          .find((m: any) => m.id === s.session.model.modelId)?.label,
        contextLimit: s.settings.providers
          .find((p: any) => p.id === s.session.model.providerId)?.models
          .find((m: any) => m.id === s.session.model.modelId)?.contextWindow
      }
    })
    console.log('LIVE_USAGE', JSON.stringify(usage))
    expect(usage.model.providerId).toBe('deepseek')
    expect(usage.label).toContain('DeepSeek V4.1 Flash')
    expect(usage.contextLimit).toBe(1048576)
    expect(usage.usage.contextUsed).toBeGreaterThan(0)
    // 单轮无工具：最近一次请求 = prompt + completion，正好等于累计 input + output
    expect(usage.usage.contextUsed).toBe(usage.usage.inputTokens + usage.usage.outputTokens)
    await page.screenshot({ path: screenshotPath('r5-final-live-context.png') })
  })

  test('真实同步 DeepSeek 模型列表（/models 精确元数据）', async () => {
    const key = readDeepSeekKey()
    test.skip(!key, '本机没有 DeepSeek Key，跳过真实同步用例')
    morrow = await launchMorrow({ name: 'r5-sync', waitForSelector: '.sidebar' })
    const { page } = morrow
    await dismissOnboarding(page)
    const result = await page.evaluate(async (apiKey) => {
      const store = (window as unknown as {
        __morrowStore: { getState: () => { settings: { providers: Array<Record<string, unknown>> } } }
      }).__morrowStore.getState()
      const provider = store.settings.providers.find((p) => p.id === 'deepseek')!
      const saved = await window.morrow.settings.saveProvider({ config: provider as never, apiKey })
      if (!saved.ok) throw new Error(`保存 Key 失败：${saved.error.message}`)
      const synced = await window.morrow.settings.syncModels('deepseek')
      if (!synced.ok) throw new Error(`同步失败：${synced.error.message}`)
      return {
        ok: true,
        total: synced.data.total,
        models: synced.data.models.map((m) => ({ id: m.id, contextWindow: m.contextWindow, maxOutput: m.maxOutput }))
      }
    }, key)
    expect(result.total).toBeGreaterThanOrEqual(2)
    const flash = result.models.find((m) => m.id === 'deepseek-flash')
    expect(flash?.contextWindow).toBe(1048576)
    expect(flash?.maxOutput).toBeGreaterThanOrEqual(393216)
  })
})
