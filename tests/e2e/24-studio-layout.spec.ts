import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

test('协作侧栏不挤压主区，菜单层级、字幕与演示控制条对齐', async () => {
  test.setTimeout(240_000)
  const morrow = await launchMorrow({ name: 'layout', env: { MORROW_SEED_CORPUS: '1' } })
  const page = morrow.page
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await morrow.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
      win?.setContentSize(1400, 800)
      win?.center()
    })
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '0.12秒' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.waitForTimeout(700)

    // 左右栏与 Agent 一致：默认 240 / 420，协作面板打开时不挤掉主区。
    const timelineLayout = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return { width: Math.round(rect.width), height: Math.round(rect.height) }
      }
      return {
        body: box('.studio-body'),
        center: box('.studio-center'),
        left: box('.studio-left'),
        assistant: box('.studio-assistant'),
        actions: box('.studio-timeline-actions')
      }
    })
    expect(timelineLayout.assistant).not.toBeNull()
    expect(timelineLayout.center?.width ?? 0).toBeGreaterThanOrEqual(560)
    expect(timelineLayout.left?.width).toBe(240)
    expect(timelineLayout.assistant?.width).toBe(420)
    expect(timelineLayout.actions?.height ?? 99).toBeLessThanOrEqual(32)

    // 拖动左右栏：只高亮面板自己的 1px 边框；不再叠加第二条线，双击恢复默认。
    const dragPanel = async (selector: string, deltaX: number, shotName?: string): Promise<{ lineWidth: number; lineBackground: string; borderBefore: string; borderDuring: string; value: string }> => {
      const handle = page.locator(selector)
      const panelSelector = selector.includes('left') ? '.studio-left' : '.studio-assistant'
      const borderProp = selector.includes('left') ? 'border-right-color' : 'border-left-color'
      const borderBefore = await page.locator(panelSelector).evaluate((element, prop) => getComputedStyle(element).getPropertyValue(prop), borderProp)
      const box = await handle.boundingBox()
      if (!box) throw new Error(`找不到拖拽手柄：${selector}`)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2, { steps: 6 })
      await page.waitForTimeout(120)
      const line = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.resize-line')
        const label = el?.querySelector('span')?.textContent ?? ''
        return {
          width: el ? Number(getComputedStyle(el).width.replace('px', '')) : -1,
          background: el ? getComputedStyle(el).backgroundColor : '',
          label
        }
      })
      const borderDuring = await page.locator(panelSelector).evaluate((element, prop) => getComputedStyle(element).getPropertyValue(prop), borderProp)
      if (shotName) await page.screenshot({ path: screenshotPath(shotName) })
      await page.mouse.up()
      await page.waitForTimeout(160)
      return { lineWidth: line.width, lineBackground: line.background, borderBefore, borderDuring, value: line.label }
    }
    const leftDrag = await dragPanel('.studio-left-resizer', 36, 'studio-resize-line-dark.png')
    expect(leftDrag.lineWidth).toBe(1)
    expect(leftDrag.lineBackground).toBe('rgba(0, 0, 0, 0)')
    expect(leftDrag.borderBefore).not.toBe(leftDrag.borderDuring)
    expect(leftDrag.value).toBe('276px')
    expect(await page.evaluate(() => Math.round(document.querySelector<HTMLElement>('.studio-left')?.getBoundingClientRect().width ?? 0))).toBe(276)
    await page.locator('.studio-left-resizer').dblclick()
    await page.waitForTimeout(160)
    expect(await page.evaluate(() => localStorage.getItem('morrow.studio.leftWidth'))).toBe('240')

    const rightDrag = await dragPanel('.studio-right-resizer', -48)
    expect(rightDrag.lineWidth).toBe(1)
    expect(rightDrag.lineBackground).toBe('rgba(0, 0, 0, 0)')
    expect(rightDrag.borderBefore).not.toBe(rightDrag.borderDuring)
    expect(rightDrag.value).toBe('468px')
    expect(await page.evaluate(() => Math.round(document.querySelector<HTMLElement>('.studio-assistant')?.getBoundingClientRect().width ?? 0))).toBe(468)
    await page.locator('.studio-right-resizer').dblclick()
    await page.waitForTimeout(160)
    expect(await page.evaluate(() => localStorage.getItem('morrow.studio.rightWidth'))).toBe('420')

    // 浅色主题使用同一套栏宽与流金边框。
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(360)
    const lightLayout = await page.evaluate(() => {
      const width = (selector: string): number =>
        Math.round(document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0)
      const frame = document.querySelector<HTMLElement>('.studio-assistant-composer')
      return {
        left: width('.studio-left'),
        right: width('.studio-assistant'),
        frame: frame ? { radius: getComputedStyle(frame).borderRadius, border: Number.parseFloat(getComputedStyle(frame).borderTopWidth) } : null
      }
    })
    expect(lightLayout.left).toBe(240)
    expect(lightLayout.right).toBe(420)
    expect(lightLayout.frame?.radius).toBe('9px')
    expect(lightLayout.frame?.border ?? 0).toBeGreaterThan(0.5)
    await page.screenshot({ path: screenshotPath('studio-resizable-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)

    // 字幕片段只显示一次台词：标签是“字幕 · 镜号”，正文在字幕层。
    const subtitle = await page.evaluate(() => {
      const clip = document.querySelector<HTMLElement>('.studio-clip.is-subtitle')
      if (!clip) return null
      const label = clip.querySelector<HTMLElement>('.studio-clip-label')?.getBoundingClientRect()
      const body = clip.querySelector<HTMLElement>('.studio-clip-subtitle')?.getBoundingClientRect()
      const rect = clip.getBoundingClientRect()
      return {
        label: clip.querySelector('.studio-clip-label')?.textContent?.trim() ?? '',
        textNodes: clip.querySelectorAll('.studio-clip-subtitle').length,
        subtitle: clip.querySelector('.studio-clip-subtitle')?.textContent?.trim() ?? '',
        clipHeight: Math.round(rect.height),
        gap: label && body ? Math.round(body.top - label.bottom) : -99
      }
    })
    expect(subtitle?.label).toContain('字幕')
    expect(subtitle?.textNodes).toBe(1)
    expect(subtitle?.label).not.toBe(subtitle?.subtitle)
    expect(subtitle?.clipHeight ?? 0).toBeGreaterThanOrEqual(38)
    expect(subtitle?.gap ?? -1).toBeGreaterThanOrEqual(3)

    // 顶栏菜单只保留作品列表；设置项进入独立设置子页。
    expect(await page.locator('.studio-engine-dots').count()).toBe(0)
    await expect(page.getByRole('button', { name: '新建作品' })).toBeVisible()
    await expect(page.getByRole('button', { name: '创作台设置' })).toBeVisible()
    await page.locator('.studio-project-button').click()
    await page.waitForTimeout(250)
    const menuLayer = await page.evaluate(() => {
      const menu = document.querySelector('.studio-project-menu')
      const topbar = document.querySelector('.studio-topbar')
      if (!menu) return null
      const rect = menu.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + 20, rect.bottom - 12)
      return {
        inside: Boolean(hit && menu.contains(hit)),
        topbarZ: topbar ? Number(getComputedStyle(topbar).zIndex) : 0,
        text: menu.textContent ?? ''
      }
    })
    expect(menuLayer?.inside).toBe(true)
    expect(menuLayer?.topbarZ ?? 0).toBeGreaterThanOrEqual(40)
    expect(menuLayer?.text).not.toContain('模型、引擎与预算')
    expect(menuLayer?.text).not.toContain('历史版本')
    await page.locator('.studio-project-button').click()
    await page.screenshot({ path: screenshotPath('studio-topbar-dark.png') })

    // 设置入口：独立弹窗 + 四个整合后的子页。
    await page.getByRole('button', { name: '创作台设置' }).click()
    const settings = page.getByRole('dialog', { name: '创作台设置' })
    await expect(settings).toBeVisible({ timeout: 15_000 })
    await expect(settings.getByRole('tab')).toHaveCount(4)
    await expect(settings.getByRole('tab', { name: '模型与预算' })).toBeVisible()
    await expect(settings.getByRole('tab', { name: '配音与引擎' })).toBeVisible()
    await settings.getByRole('tab', { name: '配音与引擎' }).click()
    await expect(settings).toContainText('配音方式')
    await expect(settings).toContainText('本机能力')
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath('studio-settings-tools-dark.png') })
    await setThemeViaStore(page, 'light')
    await page.waitForTimeout(320)
    await page.screenshot({ path: screenshotPath('studio-settings-tools-light.png') })
    await setThemeViaStore(page, 'dark')
    await page.waitForTimeout(300)
    await settings.getByRole('tab', { name: '数据与安全' }).click()
    await expect(settings).toContainText('创作台数据')
    await expect(settings.getByRole('button', { name: /更换目录/ })).toBeVisible()
    await expect(settings).toContainText('只迁移创作台作品')
    const dataDirInfo = await page.evaluate(async () => {
      const result = await (window as unknown as { morrow: { features: { invoke: (channel: string, payload: Record<string, unknown>) => Promise<any> } } }).morrow.features.invoke('feature:studio:data-dir-info', {})
      return result
    })
    expect(dataDirInfo.ok).toBe(true)
    expect(String(dataDirInfo.data.root)).toContain('studio')
    await page.screenshot({ path: screenshotPath('studio-settings-data-dark.png') })
    await settings.getByRole('tab', { name: '历史版本' }).click()
    await expect(settings).toContainText('现在是第')
    await settings.locator('.studio-modal-footer .btn', { hasText: '关闭' }).click()
    await expect(settings).toHaveCount(0)
    // 顶栏预算快捷入口落在整合后的“模型与预算”页，并滚动到预算区。
    await page.locator('.studio-budget').getByRole('button', { name: '预算' }).click()
    const budgetSettings = page.getByRole('dialog', { name: '创作台设置' })
    await expect(budgetSettings).toContainText('项目预算上限')
    await expect(budgetSettings.getByRole('button', { name: '不设上限' })).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath('studio-settings-dark.png') })
    // 「不设上限」与后端 0 值语义一致：保存后重开仍显示“已不限”，再切回 ¥30。
    await budgetSettings.getByRole('button', { name: '不设上限' }).click()
    await expect(budgetSettings.getByRole('button', { name: '已不限' })).toHaveAttribute('aria-pressed', 'true')
    await expect(budgetSettings).toContainText('没有上限')
    await budgetSettings.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('dialog', { name: '创作台设置' })).toHaveCount(0)
    await expect(page.locator('.studio-budget')).toContainText('不限')
    await page.locator('.studio-budget').getByRole('button', { name: '预算' }).click()
    const reopenedBudget = page.getByRole('dialog', { name: '创作台设置' })
    await expect(reopenedBudget.getByRole('button', { name: '已不限' })).toBeVisible()
    await reopenedBudget.getByRole('button', { name: '已不限' }).click()
    await expect(reopenedBudget.getByRole('button', { name: '不设上限' })).toBeVisible()
    await reopenedBudget.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByRole('dialog', { name: '创作台设置' })).toHaveCount(0)
    await expect(page.locator('.studio-budget')).toContainText('¥30')

    // 分镜页同样不换行。
    await page.locator('.studio-stage-item', { hasText: '分镜' }).click()
    await page.waitForSelector('.studio-storyboard', { timeout: 20_000 })
    await page.waitForTimeout(400)
    const boardLayout = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>('.studio-storyboard-actions')
      const center = document.querySelector<HTMLElement>('.studio-center')
      return {
        actionsHeight: actions ? Math.round(actions.getBoundingClientRect().height) : 999,
        centerWidth: center ? Math.round(center.getBoundingClientRect().width) : 0
      }
    })
    expect(boardLayout.centerWidth).toBeGreaterThanOrEqual(560)
    expect(boardLayout.actionsHeight).toBeLessThanOrEqual(34)

    // 打开镜头详情后，头部按钮仍保持单行。
    await page.locator('.studio-shot-card').first().click()
    await page.waitForSelector('.studio-shot-inspector', { timeout: 20_000 })
    const inspectorLayout = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>('.studio-storyboard-actions')
      return { actionsHeight: actions ? Math.round(actions.getBoundingClientRect().height) : 999 }
    })
    expect(inspectorLayout.actionsHeight).toBeLessThanOrEqual(34)
    await page.locator('.studio-shot-inspector button[aria-label="关闭镜头详情"]').click().catch(() => undefined)
    await page.waitForTimeout(300)

    // 写作页右侧栏打开时，正文纸页仍有足够宽度。
    await page.locator('.studio-project-button').click()
    await page.locator('.studio-project-menu button', { hasText: '雨停之前' }).click()
    await page.waitForTimeout(1000)
    await page.locator('.studio-stage-item', { hasText: '写作' }).click()
    await page.waitForTimeout(600)
    const writingWidth = await page.evaluate(() => {
      const writing = document.querySelector<HTMLElement>('.studio-writing')
      return writing ? Math.round(writing.getBoundingClientRect().width) : 0
    })
    expect(writingWidth).toBeGreaterThanOrEqual(900)

    // 人物/事实抽屉打开时不遮住纸页。
    await page.getByTitle('人物、设定与检查').click()
    await page.waitForSelector('.studio-fact-drawer', { timeout: 20_000 })
    const factsLayout = await page.evaluate(() => {
      const paper = document.querySelector<HTMLElement>('.studio-paper')?.getBoundingClientRect()
      const drawer = document.querySelector<HTMLElement>('.studio-fact-drawer')?.getBoundingClientRect()
      return paper && drawer ? { paperRight: Math.round(paper.right), drawerLeft: Math.round(drawer.left) } : null
    })
    expect(factsLayout?.paperRight ?? 9999).toBeLessThanOrEqual((factsLayout?.drawerLeft ?? 0) + 1)
    await page.getByTitle('人物、设定与检查').click()
    await page.waitForTimeout(300)

    // 1280 仍停靠右侧栏，不改成遮挡正文的浮层。
    await morrow.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
      win?.setContentSize(1280, 800)
      win?.center()
    })
    await page.waitForTimeout(500)
    const compact = await page.evaluate(() => {
      const center = document.querySelector<HTMLElement>('.studio-center')
      const assistant = document.querySelector<HTMLElement>('.studio-assistant')
      return {
        centerWidth: center ? Math.round(center.getBoundingClientRect().width) : 0,
        assistantPosition: assistant ? getComputedStyle(assistant).position : '',
        assistantWidth: assistant ? Math.round(assistant.getBoundingClientRect().width) : 0
      }
    })
    expect(compact.centerWidth).toBeGreaterThanOrEqual(800)
    expect(compact.assistantPosition).not.toBe('fixed')
    expect(compact.assistantWidth).toBe(420)
    await morrow.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
      win?.setContentSize(1400, 800)
      win?.center()
    })
    await page.waitForTimeout(400)

    // 演示控制条各列垂直居中对齐且不横向溢出。
    await page.locator('.studio-home-link').click()
    await page.waitForSelector('.studio-home', { timeout: 20_000 })
    await page.locator('.studio-home-utility', { hasText: '看演示' }).click()
    await page.waitForSelector('.studio-demo-dock', { timeout: 20_000 })
    await page.waitForTimeout(1600)
    const dock = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return { centerY: Math.round(rect.y + rect.height / 2), width: Math.round(rect.width) }
      }
      const dockEl = document.querySelector<HTMLElement>('.studio-demo-dock')
      return {
        live: box('.studio-demo-live'),
        dots: box('.studio-demo-dots'),
        actions: box('.studio-demo-actions'),
        overflow: dockEl ? dockEl.scrollWidth - dockEl.clientWidth : 999
      }
    })
    expect(dock.overflow).toBeLessThanOrEqual(1)
    expect(Math.abs((dock.live?.centerY ?? 0) - (dock.dots?.centerY ?? 99))).toBeLessThanOrEqual(2)
    expect(Math.abs((dock.dots?.centerY ?? 0) - (dock.actions?.centerY ?? 99))).toBeLessThanOrEqual(2)
    await page.screenshot({ path: screenshotPath('studio-demo-aligned-dark.png') })

    // 指引文案与图标：创作台、无重复 Lucide 图标、图标已加载。
    await page.locator('.studio-demo-close').click()
    await page.waitForTimeout(400)
    await page.locator('.studio-home-utility', { hasText: '使用指引' }).click()
    await page.waitForSelector('.studio-guide', { timeout: 20_000 })
    await page.waitForTimeout(700)
    await expect(page.locator('.studio-guide-title').first()).toContainText('创作台')
    expect(await page.locator('.studio-guide').innerText()).not.toContain('工作台')
    expect(await page.locator('.studio-guide-fine .lucide').count()).toBe(0)
    expect(await page.locator('.studio-guide-text-action .lucide').count()).toBe(0)
    const icon = await page.evaluate(async () => {
      const image = document.querySelector<HTMLImageElement>('.studio-guide-brand img')
      if (!image) return null
      const bytes = await fetch(image.src).then((response) => response.arrayBuffer()).then((buffer) => buffer.byteLength).catch(() => -1)
      return { complete: image.complete, naturalWidth: image.naturalWidth, bytes }
    })
    expect(icon?.complete).toBe(true)
    expect(icon?.naturalWidth ?? 0).toBeGreaterThan(0)
    expect(icon?.bytes ?? 999999).toBeLessThan(20_000)
    await page.screenshot({ path: screenshotPath('studio-guide-refined-dark.png') })

    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await morrow.close()
  }
})
