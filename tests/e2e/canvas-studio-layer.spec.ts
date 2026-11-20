import { test, expect } from '@playwright/test'
import { launchMorrow, dismissOnboarding, configureMockProvider, createSession, setThemeViaStore } from './helpers'

/**
 * 模式切换的画布/原生层回归：
 * - 画布全屏状态下进入创作台，画布必须被挂起，不能以满屏层压在创作台上；
 * - 退出创作台后画布回到抽屉态（全屏状态不跨模式保留），且可以直接收起；
 * - 内置浏览器是原生 WebContentsView，进入创作台时必须显式隐藏，退出后恢复。
 */
test('@core:studio-storage 模式切换收起画布与内置浏览器原生层', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'studio-layer' })
  const page = morrow.page
  const canvas = page.locator('.app-main > aside[aria-label="画布"]')
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    const provider = await configureMockProvider(page, 'http://127.0.0.1:9/v1')
    await createSession(page, {
      workspace: process.cwd(),
      providerId: provider.providerId,
      modelId: provider.modelId,
      permissionMode: 'ask',
      title: '模式切换回归'
    })

    await page.evaluate(() => {
      const store = (window as unknown as { __morrowStore: { getState: () => Record<string, any>; setState: (s: any) => void } }).__morrowStore
      const session = store.getState().session
      if (!session) throw new Error('会话未就绪')
      store.setState({
        session: {
          ...session,
          artifacts: [
            {
              id: 'layer-probe',
              title: '层级探针',
              kind: 'markdown',
              content: '# 层级探针\n\n用于验证模式切换。',
              updatedAt: Date.now()
            }
          ]
        }
      })
      store.getState().openCanvas('layer-probe')
    })
    await page.waitForSelector('.canvas-root')
    await page.getByRole('button', { name: '全屏查看' }).click()
    await expect(canvas).toHaveClass(/is-fullscreen/)

    // 进入创作台：画布立即挂起
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-root', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await expect(canvas).toBeHidden()
    await expect(page.locator('.app-body')).toHaveAttribute('inert', '')

    // 内置浏览器即使已在创作台打开，也必须保持原生层隐藏
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('morrow:workbench', { detail: { panel: 'browser' } }))
    })
    await page.waitForSelector('.browser-dock', { state: 'attached', timeout: 20_000 })
    const opened = await page.evaluate(async () => {
      const result = await window.morrow.features.invoke<{ open: boolean; visible: boolean }>('feature:browser:open', {
        url: 'https://example.com/'
      })
      return result.ok ? result.data : null
    })
    expect(opened?.open).toBe(true)
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const result = await window.morrow.features.invoke<{ visible: boolean }>('feature:browser:get-state')
          return result.ok ? result.data.visible : true
        })
      )
      .toBe(false)

    // 退出创作台：画布回到抽屉态而不是全屏，浏览器原生层恢复
    await page.locator('.studio-exit').click()
    await expect(page.locator('.studio-root')).toHaveCount(0)
    await expect(page.locator('.app-body')).not.toHaveAttribute('inert', '')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const result = await window.morrow.features.invoke<{ visible: boolean }>('feature:browser:get-state')
          return result.ok ? result.data.visible : false
        })
      )
      .toBe(true)

    // 浏览器与画布共用右侧栏：先关浏览器，再验证画布恢复为可收起的抽屉
    await page.getByRole('button', { name: '关闭浏览器' }).click()
    await expect(canvas).toBeVisible()
    await expect(canvas).not.toHaveClass(/is-fullscreen/)

    // 画布现在能正常收起
    await canvas.getByRole('button', { name: '关闭画布' }).click()
    await expect(canvas).toHaveCount(0)
  } finally {
    await morrow.close()
  }
})