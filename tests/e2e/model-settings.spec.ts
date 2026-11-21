import { expect, test } from '@playwright/test'
import { dismissOnboarding, launchMorrow, screenshotPath, type MorrowApp } from './helpers'

/**
 * 自定义服务的完整模型设置：上下文 / 输出 / 思考强度 / 多模态，以及服务级的 API 协议与重试策略。
 *
 * 验收口径来自真实反馈：第三方网关自动识别出的 deepseek-v4.1-flash-1017
 * 被当成 128K / 32K，实际应能按 1M / 384K 使用，并且思考强度、协议、重试、多模态都要可配。
 */
let morrow: MorrowApp | undefined

test.afterEach(async () => {
  await morrow?.close()
  morrow = undefined
})

interface SavedProviderView {
  kind: string
  baseUrl: string
  retry?: { maxRetries: number; delays: number[] }
  models: Array<{
    id: string
    contextWindow: number
    maxOutput?: number
    supportsVision?: boolean
    supportsReasoning?: boolean
    reasoningStyle?: string
    reasoningEfforts?: string[]
  }>
}

async function readProvider(page: MorrowApp['page']): Promise<SavedProviderView | null> {
  return page.evaluate(async () => {
    const invoke = (window as unknown as {
      morrow: { settings: { get: () => Promise<{ ok: boolean; data: { providers: SavedProviderView[] } }> } }
    }).morrow
    const result = await invoke.settings.get()
    return result.data.providers.find((provider) => (provider as { id?: string }).id === 'custom-gateway') ?? null
  })
}

test('@core:settings 自定义服务可把 128K/32K 改成 1M/384K，并配置思考、协议与重试', async () => {
  morrow = await launchMorrow({ name: 'model-settings', waitForSelector: '.sidebar' })
  const { page } = morrow
  await dismissOnboarding(page)

  // 复现截图里的状态：网关只被识别成 128K / 32K
  await page.evaluate(async () => {
    const store = (window as unknown as {
      __morrowStore: { getState: () => { saveProvider: (input: unknown) => Promise<void> } }
    }).__morrowStore
    await store.getState().saveProvider({
      config: {
        id: 'custom-gateway',
        kind: 'openai-compat',
        name: '蛋王中转',
        baseUrl: 'https://z1rry.cyou/v1/chat/completions',
        category: 'custom',
        models: [
          {
            id: 'deepseek-v4.1-flash-1017',
            label: 'deepseek-v4.1-flash-1017',
            contextWindow: 131_072,
            maxOutput: 32_768,
            supportsTools: true
          }
        ],
        apiKeyStored: false,
        enabled: true,
        isBuiltin: false
      }
    })
  })

  await page.evaluate(() => {
    ;(window as unknown as { __morrowStore: { getState: () => { openSettings: () => void } } }).__morrowStore
      .getState()
      .openSettings()
  })
  const dialog = page.locator('[role="dialog"]').first()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: '模型' }).click()

  // 建 Provider 时弹出的 toast 会挡住面板，先清掉再截图
  for (let index = 0; index < 6; index += 1) {
    if ((await page.locator('.toast-close').count()) === 0) break
    await page.locator('.toast-close').first().click().catch(() => undefined)
    await page.waitForTimeout(80)
  }

  await dialog.getByRole('button', { name: '选择模型服务' }).click()
  await dialog.getByRole('option').filter({ hasText: '蛋王中转' }).click()

  const row = dialog.locator('.st-model-row').first()
  await expect(row).toContainText('128K')
  await expect(row).toContainText('32K')

  // 打开齿轮：模型设置面板
  await row.getByRole('button', { name: /的模型设置$/ }).click()
  const editor = dialog.locator('.st-model-editor')
  await expect(editor).toBeVisible()

  // 上下文 1M、输出 384K
  await editor.getByRole('button', { name: '1M', exact: true }).click()
  await editor.getByRole('button', { name: '384K', exact: true }).click()
  // 思考强度：打开开关，并在六档里挑四个（默认按 DeepSeek 推断已有 off/low/high/max）
  await editor.getByRole('switch', { name: '支持思考' }).click()
  await expect(editor.getByRole('button', { name: '最高', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await editor.getByRole('button', { name: '中', exact: true }).click()
  // 关闭/低/高/最高 来自 DeepSeek 家族推断，加上刚选的中共 5 档
  await expect(editor.locator('.st-chip[aria-pressed="true"]')).toHaveCount(5)
  // 多模态：允许图片输入
  await editor.getByRole('switch', { name: '图片输入' }).click()
  await editor.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(250)
  await page.screenshot({ path: screenshotPath('settings-model-editor.png') })
  // 面板比可视区高：再截一张下半屏，覆盖思考档位、多模态与保存按钮
  await editor.evaluate((element) => element.scrollIntoView({ block: 'end' }))
  await page.waitForTimeout(250)
  await page.screenshot({ path: screenshotPath('settings-model-editor-bottom.png') })
  await editor.getByRole('button', { name: '保存模型设置' }).click()
  await expect(dialog.locator('.st-model-editor')).toHaveCount(0)
  await expect(row).toContainText('1M')
  await expect(row).toContainText('384K')
  await expect(row).toContainText('可看图')

  const afterModel = await readProvider(page)
  expect(afterModel?.models[0]).toMatchObject({
    id: 'deepseek-v4.1-flash-1017',
    contextWindow: 1_000_000,
    maxOutput: 393_216,
    supportsVision: true,
    supportsReasoning: true,
    reasoningStyle: 'effort'
  })
  expect(afterModel?.models[0].reasoningEfforts?.length).toBeGreaterThanOrEqual(4)
  expect(afterModel?.models[0].reasoningEfforts).toContain('medium')

  // 服务级：API 协议 + 重试策略
  const advanced = dialog.locator('.st-advanced')
  await expect(advanced).toBeVisible()
  await advanced.getByRole('button', { name: 'API 协议' }).click()
  await dialog.getByRole('option').filter({ hasText: 'Anthropic Messages' }).click()
  await advanced.getByLabel('最多重试次数').fill('5')
  await advanced.getByLabel('重试退避（毫秒，逗号分隔）').fill('500, 1500')
  await advanced.getByRole('button', { name: '保存连接设置' }).click()

  const afterConnection = await readProvider(page)
  expect(afterConnection).toMatchObject({
    kind: 'anthropic',
    retry: { maxRetries: 5, delays: [500, 1500] }
  })
  // 换协议后完整路径被收成根地址，避免 /chat/completions 被拼到 Messages 端点后面
  expect(afterConnection?.baseUrl).toBe('https://z1rry.cyou')
  await expect(dialog.getByText('连接设置已保存')).toBeVisible()

  // 新协议下模型设置仍可再次打开（表单没有因为重渲染丢状态）
  await row.getByRole('button', { name: /的模型设置$/ }).click()
  await expect(dialog.locator('.st-model-editor')).toBeVisible()
  await dialog.locator('.st-model-editor').getByRole('button', { name: '取消' }).click()

  // 关掉保存时叠起来的 toast，再滚回服务卡片顶部截一张总览
  for (let index = 0; index < 6; index += 1) {
    if ((await page.locator('.toast-close').count()) === 0) break
    await page.locator('.toast-close').first().click().catch(() => undefined)
    await page.waitForTimeout(80)
  }
  await dialog.locator('.st-advanced').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: screenshotPath('settings-model-detail.png') })
})