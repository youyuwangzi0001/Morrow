/**
 * P1-13 回归：默认内置 DeepSeek 模型必须暴露推理强度选项。
 * 之前的元数据只给 openai/anthropic 推断 reasoningStyle，DeepSeek 等
 * OpenAI 兼容内置模型被标记 supportsReasoning 却没有 style，导致选择器被隐藏。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { defaultSettings } from '../../src/shared/models'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore, waitForStoreReady } from './store'

test('默认 DeepSeek 模型可选择推理强度', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({
    name: 'reasoning-default',
    waitForSelector: '.composer',
    timeoutMs: 90_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)

    const trigger = page.getByRole('button', { name: '推理强度' })
    await expect(trigger).toBeVisible()
    await expect(trigger).toContainText('auto')
    await trigger.click()
    await expect(page.getByRole('option', { name: /^low/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^medium/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^high/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^xhigh/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /^max/ })).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: screenshotPath('reasoning-menu-dark.png') })

    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(300)
    await trigger.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('reasoning-menu-light.png') })
  } finally {
    await morrow.close()
  }
})

/**
 * 旧版本同步过模型元数据、但没有 reasoningStyle 的真实升级路径：
 * 设置合并不能让模型「支持推理」却隐藏思考强度选择。
 */
test('旧版同步模型缺少 reasoningStyle 时仍显示思考强度', async () => {
  test.setTimeout(120_000)
  const dataDir = join(root, 'tmp', `reasoning-legacy-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = defaultSettings()
  settings.onboardingDone = true
  settings.providers = settings.providers.map((provider) =>
    provider.id === 'deepseek'
      ? {
          ...provider,
          modelsSyncedAt: 1_700_000_000_000,
          models: [
            {
              id: 'deepseek-flash',
              label: 'DeepSeek V4.1 Flash',
              contextWindow: 1_048_576,
              maxOutput: 393_216,
              supportsTools: true,
              supportsReasoning: true
            }
          ]
        }
      : provider
  )
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings), 'utf8')

  const morrow = await launchMorrow({
    name: 'reasoning-legacy',
    dataDir,
    waitForSelector: '.composer',
    timeoutMs: 90_000
  })
  try {
    const { page } = morrow
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    const model = await page.evaluate(() => {
      const state = (window as unknown as { __morrowStore: { getState: () => { settings: { providers: Array<{ id: string; models: Array<{ id: string; reasoningStyle?: string }> }> } } } }).__morrowStore.getState()
      return state.settings.providers.find((provider) => provider.id === 'deepseek')?.models[0]
    })
    expect(model?.reasoningStyle).toBe('effort')
    const trigger = page.getByRole('button', { name: '推理强度' })
    await expect(trigger).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('reasoning-legacy-model-dark.png') })
    await trigger.click()
    await expect(page.getByRole('option', { name: /^high/ })).toBeVisible()
    await page.getByRole('option', { name: /^high/ }).click()
    await expect(trigger).toContainText('high')
  } finally {
    await morrow.close()
  }
})
