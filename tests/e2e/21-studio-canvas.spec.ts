import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

test('漫剧画布：镜头、音频、文本节点与连线可编辑并持久化', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'canvas' })
  const page = morrow.page
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('pageerror', (error) => errors.push(String(error)))
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    const list = await page.evaluate(async () => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'list' })
      return response.ok ? response.data : null
    })
    const target = list.projects.find((item: any) => item.title === '0.12秒')
    await page.locator('.studio-project-card', { hasText: '0.12秒' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-canvas-link').click()
    await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
    await page.waitForTimeout(1800)
    await expect(page.locator('.studio-canvas-node')).toHaveCount(16)
    await expect(page.locator('.studio-canvas-save')).toContainText('已保存', { timeout: 15_000 })
    await page.screenshot({ path: screenshotPath('studio-canvas-dark.png') })

    // 右下角缩放控件必须能被真实指针命中，并独立于画布拖拽/框选事件。
    const beforeZoom = await page.locator('.studio-canvas-world').getAttribute('style')
    const zoomIn = page.locator('.studio-canvas-zoom button[aria-label="放大"]')
    const zoomBox = await zoomIn.boundingBox()
    expect(zoomBox).toBeTruthy()
    const zoomHit = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return { inside: Boolean(hit?.closest('.studio-canvas-zoom')), label: hit?.closest('button')?.getAttribute('aria-label') ?? null }
    }, { x: zoomBox!.x + zoomBox!.width / 2, y: zoomBox!.y + zoomBox!.height / 2 })
    expect(zoomHit.inside).toBe(true)
    expect(zoomHit.label).toBe('放大')
    await page.mouse.click(zoomBox!.x + zoomBox!.width / 2, zoomBox!.y + zoomBox!.height / 2)
    await page.waitForTimeout(250)
    const afterZoom = await page.locator('.studio-canvas-world').getAttribute('style')
    expect(afterZoom).not.toBe(beforeZoom)
    const fit = page.locator('.studio-canvas-zoom button[aria-label="适应画布"]')
    const fitBox = await fit.boundingBox()
    expect(fitBox).toBeTruthy()
    await page.mouse.click(fitBox!.x + fitBox!.width / 2, fitBox!.y + fitBox!.height / 2)
    await page.waitForTimeout(250)
    const afterFit = await page.locator('.studio-canvas-world').getAttribute('style')
    expect(afterFit).not.toBe(afterZoom)

    await page.locator('.studio-canvas-action', { hasText: '文本' }).click()
    await expect(page.locator('.studio-canvas-node')).toHaveCount(17)
    await page.getByRole('button', { name: /连线/ }).first().click()
    await page.waitForTimeout(500)
    expect(await page.locator('.studio-canvas-wire').count()).toBeGreaterThan(0)

    const first = page.locator('.studio-canvas-node').first()
    const box = await first.boundingBox()
    if (box) {
      await page.mouse.move(box.x + 30, box.y + 12)
      await page.mouse.down()
      await page.mouse.move(box.x + 90, box.y + 52, { steps: 5 })
      await page.mouse.up()
    }
    await page.waitForTimeout(1400)
    const saved = await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.canvas : null
    }, target.id)
    expect(saved?.initialized).toBe(true)
    expect(saved?.nodes.length).toBe(17)
    expect(saved?.connections.length).toBeGreaterThan(0)

    // 多选与编组：选中最上层两个文本节点，分组后拖动组标题整体移动。
    const canvasNodes = page.locator('.studio-canvas-node')
    await canvasNodes.nth(16).click()
    await canvasNodes.nth(15).click({ modifiers: ['Shift'] })
    await expect(page.locator('.studio-canvas-inspector')).toContainText('2 个节点')
    await page.locator('.studio-canvas-action', { hasText: '编组' }).click()
    await expect(page.locator('.studio-canvas-group')).toHaveCount(1)
    await expect.poll(async () => page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.canvas.groups?.length ?? 0 : 0
    }, target.id), { timeout: 15_000 }).toBe(1)
    const beforeGroup = await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      if (!response.ok) return []
      const canvas = response.data.project.canvas
      const ids = new Set(canvas.groups[0].nodeIds)
      return canvas.nodes.filter((node: any) => ids.has(node.id)).map((node: any) => ({ id: node.id, x: node.x, y: node.y }))
    }, target.id)
    const groupHead = page.locator('.studio-canvas-group-head')
    const headBox = await groupHead.boundingBox()
    if (headBox) {
      await page.mouse.move(headBox.x + headBox.width - 24, headBox.y + 10)
      await page.mouse.down()
      await page.mouse.move(headBox.x + headBox.width + 36, headBox.y + 50, { steps: 5 })
      await page.mouse.up()
    }
    await page.waitForTimeout(1400)
    const afterGroup = await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      if (!response.ok) return null
      const canvas = response.data.project.canvas
      const ids = new Set(canvas.groups[0].nodeIds)
      return { groups: canvas.groups, nodes: canvas.nodes.filter((node: any) => ids.has(node.id)).map((node: any) => ({ id: node.id, x: node.x, y: node.y })) }
    }, target.id)
    expect(afterGroup?.groups?.length).toBe(1)
    expect(afterGroup?.groups?.[0]?.nodeIds.length).toBe(2)
    expect(afterGroup?.nodes).not.toEqual(beforeGroup)

    // 画布快照导出为真实 PNG，并进入交付记录。
    await page.locator('.studio-canvas-action', { hasText: '快照' }).click()
    await expect.poll(async () => page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.deliveries.filter((item: any) => item.kind === 'png').length : 0
    }, target.id), { timeout: 30_000 }).toBeGreaterThan(0)
    const png = await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.deliveries.find((item: any) => item.kind === 'png' && item.meta?.width > 100) : null
    }, target.id)
    expect(png?.bytes ?? 0).toBeGreaterThan(10_000)

    await page.getByRole('button', { name: /分镜/ }).last().click()
    await page.waitForSelector('.studio-storyboard', { timeout: 20_000 })
    await page.locator('.studio-canvas-link').click()
    await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
    await expect(page.locator('.studio-canvas-node')).toHaveCount(17)
    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await morrow.close()
  }
})
