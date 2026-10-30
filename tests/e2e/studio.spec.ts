// studio 领域 E2E：由 7 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, screensDir } from './launch'
import { dismissOnboarding, setThemeViaStore, configureMockProvider, waitForStoreReady } from './store'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import type { StudioActionResult, StudioProject } from '../../src/shared/studio'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

test.describe("18-studio", () => {
test.describe('Morrow 创作台', () => {
  test('@core:studio-timeline 入口、作品库、写作、分镜、时间线与交付的真实走查', async () => {
    const morrow = await launchMorrow({ name: 'studio' })
    const page = morrow.page
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    try {
      await page.waitForSelector('.titlebar', { timeout: 30_000 })
      await dismissOnboarding(page)
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => { setTheme: (value: string) => void } } })
          .__morrowStore
        store.getState().setTheme('dark')
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.waitForTimeout(400)

      // 标题栏唯一新增入口
      const entry = page.locator('.tb-create')
      await expect(entry).toBeVisible()
      await entry.click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      await expect(page.locator('.studio-guide')).toBeVisible({ timeout: 15_000 })
      await page.locator('.studio-guide-skip').click()
      await expect(page.locator('.studio-guide')).toHaveCount(0)
      await page.waitForTimeout(1200)

      // 首页：三份内置样例；创作台内不再出现产品标题或品牌图标
      await expect(page.locator('.studio-hero-title')).toContainText('变成作品')
      await expect(page.locator('.studio-project-card')).toHaveCount(3)
      for (const title of ['雨停之前', '雨伞铺的第七个夏天', '逆行的伞']) {
        await expect(page.locator('.studio-project-card h3').filter({ hasText: title })).toHaveCount(1)
      }
      await expect(page.locator('.studio-logline-input')).toBeVisible()
      await expect(page.locator('.studio-more-toggle')).toHaveCSS('white-space', 'nowrap')
      await expect(page.locator('.studio-brand')).toHaveCount(1)
      await expect(page.locator('.studio-brand')).toHaveCSS('font-size', '18px')
      await expect(page.locator('.studio-brand')).toHaveCSS('font-weight', '400')
      await expect(page.locator('.studio-topbar img.studio-mark')).toHaveCount(0)
      await expect(page.locator('.studio-root')).not.toContainText('创作台')
      await page.screenshot({ path: screenshotPath('studio-home-dark.png') })

      // 打开漫剧样例：时间线、监视器与镜头轨
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
      await page.waitForTimeout(1000)
      await expect(page.locator('.studio-topbar img.studio-mark')).toHaveCount(0)
      await expect(page.locator('.studio-assistant-mark img.studio-mark')).toHaveCount(1)
      const assistantFonts = await page.evaluate(() => ({
        title: getComputedStyle(document.querySelector('.studio-assistant-head b') as HTMLElement).fontSize,
        meta: getComputedStyle(document.querySelector('.studio-assistant-head span') as HTMLElement).fontSize,
        body: getComputedStyle(document.querySelector('.studio-assistant-bubble > p') as HTMLElement).fontSize
      }))
      expect(assistantFonts).toEqual({ title: '15px', meta: '11.5px', body: '13.5px' })

      // 协作者输入框与 Agent 主聊天框共用流金边框：1px 边框、9px 圆角、聚焦时金线展开。
      const assistantFrame = page.locator('.studio-assistant-composer')
      await expect(assistantFrame).toHaveClass(/chat-gold-frame/)
      const assistantFrameBase = await assistantFrame.evaluate((element) => ({
        radius: getComputedStyle(element).borderRadius,
        border: Number.parseFloat(getComputedStyle(element).borderTopWidth),
        color: getComputedStyle(element).borderTopColor
      }))
      expect(assistantFrameBase.radius).toBe('9px')
      expect(assistantFrameBase.border).toBeGreaterThan(0.5)
      expect(assistantFrameBase.border).toBeLessThanOrEqual(1.01)
      await assistantFrame.locator('textarea').focus()
      await page.waitForTimeout(520)
      const assistantFrameFocus = await assistantFrame.evaluate((element) => ({
        color: getComputedStyle(element).borderTopColor,
        horizon: Number(getComputedStyle(element, '::before').opacity)
      }))
      expect(assistantFrameFocus.color).not.toBe(assistantFrameBase.color)
      expect(assistantFrameFocus.horizon).toBeGreaterThan(0.8)
      await page.locator('.studio-assistant-head b').click()
      await page.waitForTimeout(320)

      // 蓝图页：故事主线、人物、章节/镜头安排与费用预估都可见。
      await page.locator('.studio-stage-item', { hasText: '蓝图' }).click()
      await page.waitForSelector('.studio-blueprint', { timeout: 15_000 })
      await page.waitForTimeout(500)
      await expect(page.locator('.studio-blueprint')).not.toContainText('STORY CORE')
      await expect(page.locator('.studio-blueprint')).not.toContainText('COST & TIME')
      await expect(page.locator('.studio-blueprint')).not.toContainText('CHARACTERS')
      await expect(page.locator('.studio-bp-core')).toContainText('故事主线')
      await page.screenshot({ path: screenshotPath('studio-blueprint-dark.png') })
      await page.locator('.studio-bp-core .studio-bp-edit').click()
      const blueprintDialog = page.getByRole('dialog', { name: '修改故事蓝图' })
      await expect(blueprintDialog).toBeVisible()
      await expect(blueprintDialog).toContainText('故事主线')
      await page.waitForTimeout(600)
      await page.screenshot({ path: screenshotPath('studio-blueprint-edit-dark.png') })
      await blueprintDialog.getByRole('button', { name: '取消' }).click()
      await page.locator('.studio-bp-estimate').getByRole('button', { name: '调整预算' }).click()
      const budgetDialog = page.getByRole('dialog', { name: '创作台设置' })
      await expect(budgetDialog).toBeVisible({ timeout: 15_000 })
      await expect(budgetDialog).toContainText('项目预算上限')
      await budgetDialog.locator('.studio-modal-footer .btn', { hasText: '关闭' }).click()
      await page.locator('.studio-stage-item', { hasText: '时间线' }).click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
      await page.waitForTimeout(500)
      await expect(page.locator('.studio-monitor img, .studio-monitor video')).toHaveCount(1)
      await expect(page.locator('.studio-clip').first()).toBeVisible()
      const scrub = page.locator('.studio-scrub')
      const scrubBox = await scrub.boundingBox()
      expect(scrubBox).toBeTruthy()
      await page.mouse.click(scrubBox!.x + scrubBox!.width * 0.5, scrubBox!.y + scrubBox!.height / 2)
      await expect.poll(async () => {
        const text = await page.locator('.studio-playhead-time').innerText()
        const [minutes, seconds] = text.split(':').map(Number)
        return (minutes || 0) * 60 + (seconds || 0)
      }).toBeGreaterThan(30)
      await expect(page.locator('.studio-stage-item')).toHaveCount(8)
      const timelineText = await page.locator('.studio-timeline-view').innerText()
      expect(timelineText).toContain('字幕')
      expect(timelineText).toContain('fps')
      expect(timelineText).toContain('拖中间改位置')
      // 点击进度条会定位到对应时间，而不是只能按秒前进后退。
      // 已有片段时，自动排好必须确认，不能静默覆盖手工剪辑
      await page.getByRole('button', { name: '自动排好', exact: true }).click()
      const rebuildDialog = page.getByRole('dialog', { name: '自动排好会重建时间线' })
      await expect(rebuildDialog).toBeVisible()
      await expect(rebuildDialog).toContainText('裁剪')
      await rebuildDialog.getByRole('button', { name: '取消' }).click()
      await expect(rebuildDialog).not.toBeVisible()
      await page.locator('.studio-timeline-tools-left').getByRole('button', { name: '片段' }).click()
      const inspector = page.locator('.studio-clip-inspector')
      await expect(inspector).toContainText('片段详情')
      await expect(inspector).toContainText('起点')
      await expect(inspector).toContainText('入点')
      await expect(inspector).toContainText('转场/淡入淡出')
      await page.waitForTimeout(300)
      await page.screenshot({ path: screenshotPath('studio-timeline-dark.png') })
      await inspector.getByRole('button', { name: '关闭片段详情' }).click()

      // 分镜板与单镜详情
      await page.locator('.studio-stage-item').nth(2).click()
      await page.waitForSelector('.studio-shot-card', { timeout: 15_000 })
      await expect(page.locator('.studio-shot-card')).toHaveCount(12)
      await page.locator('.studio-shot-card').nth(6).click()
      await expect(page.locator('.studio-shot-inspector')).toBeVisible()
      await page.locator('.studio-storyboard').evaluate((element) => { element.scrollTop = 0 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: screenshotPath('studio-storyboard-dark.png') })

      // 已有镜头时，重新生成分镜先选范围：当前镜 / 指定章节 / 全书分批。
      await page.locator('.studio-tab-switch').getByRole('button', { name: '剧本' }).click()
      await page.getByRole('button', { name: '用模型重排…' }).click()
      const scopeDialog = page.getByRole('dialog', { name: '重新生成分镜' })
      await expect(scopeDialog).toBeVisible()
      await expect(scopeDialog).toContainText('当前镜头')
      await expect(scopeDialog).toContainText('指定章节')
      await expect(scopeDialog).toContainText('全书分批')
      await expect(scopeDialog).toContainText('允许模型增删本范围的镜头')
      await page.waitForTimeout(400)
      await page.screenshot({ path: screenshotPath('studio-storyboard-scope-dark.png') })
      await scopeDialog.getByRole('button', { name: '取消' }).click()

      // 交付页：真实样例草稿可播放
      await page.locator('.studio-stage-item').nth(7).click()
      await page.waitForSelector('.studio-delivery', { timeout: 15_000 })
      const deliveryVideo = page.locator('.studio-delivery-poster video')
      await expect(deliveryVideo).toBeVisible()
      const videoInfo = await deliveryVideo.evaluate(async (element) => {
        const video = element as HTMLVideoElement
        if (video.readyState < 1) await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }))
        return { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
      })
      expect(videoInfo.duration).toBeCloseTo(96, 0)
      expect(videoInfo.width).toBe(1920)
      expect(videoInfo.height).toBe(1080)
      await deliveryVideo.evaluate((element) => (element as HTMLVideoElement).play())
      await expect.poll(() => deliveryVideo.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3)
      await deliveryVideo.evaluate((element) => (element as HTMLVideoElement).pause())
      await expect(page.locator('.studio-delivery-rows .studio-delivery-row').first()).toBeVisible()
      // 交付页保留常用格式术语，同时给出可见用途说明和推荐设置。
      await expect(page.getByRole('radio', { name: '草稿' })).toBeVisible()
      await expect(page.getByRole('radio', { name: '成片' })).toBeVisible()
      await expect(page.getByText('外挂 SRT · 自动随成片生成')).toBeVisible()
      await expect(page.getByRole('radio', { name: '画面内字幕' })).toHaveCount(0)
      await expect(page.getByText('逐条可改')).toBeVisible()
      await expect(page.locator('.studio-delivery-subformats em').first()).toBeVisible()
      await expect(page.locator('.studio-delivery-panel')).not.toContainText('可 diff')
      await page.getByRole('button', { name: '不知道怎么选？用推荐设置' }).click()
      await expect(page.getByRole('radio', { name: '成片' })).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByRole('radio', { name: '4K' })).toBeVisible()
      await page.waitForTimeout(300)
      await page.locator('.studio-delivery-panel').screenshot({ path: screenshotPath('studio-delivery-panel-dark.png') })
      await setThemeViaStore(page, 'light')
      await page.waitForTimeout(320)
      await expect(page.locator('.studio-delivery-panel')).toBeVisible()
      await page.locator('.studio-delivery-panel').screenshot({ path: screenshotPath('studio-delivery-panel-light.png') })
      await setThemeViaStore(page, 'dark')
      await page.waitForTimeout(300)
      await page.getByRole('button', { name: '导出预检' }).click()
      const preflight = page.getByRole('dialog', { name: '导出预检' })
      await expect(preflight).toBeVisible()
      await expect(preflight).toContainText('中文字体')
      await expect(preflight).toContainText('衬线可用')
      await expect(preflight).toContainText('随包 Noto Serif SC Variable')
      await expect(preflight).toContainText('PDF')
      await expect(preflight).toContainText('FFmpeg')
      await preflight.locator('.studio-modal-footer .btn', { hasText: '关闭' }).click()
      await page.screenshot({ path: screenshotPath('studio-delivery-dark.png') })

      // 自动推进：先确认范围，再排队补齐与草稿合成。
      await page.locator('.studio-stage-item', { hasText: '检查' }).click()
      await page.waitForSelector('.studio-review', { timeout: 15_000 })
      await expect(page.getByRole('button', { name: '生成检查报告' })).toHaveCount(0)
      const reviewTools = page.locator('.studio-review-engine')
      await expect(reviewTools).toContainText('使用的引擎')
      await expect(reviewTools).toContainText('FFmpeg')
      await expect(reviewTools).toContainText(/本地 AI 声线|系统声线/)
      await page.screenshot({ path: screenshotPath('studio-review-dark.png') })
      await page.getByRole('button', { name: '自动补齐并合成草稿' }).click()
      const pipeline = page.getByRole('dialog', { name: '自动推进到草稿' })
      await expect(pipeline).toBeVisible()
      await expect(pipeline).toContainText('合成一版可审看的草稿')
      await expect(pipeline).toContainText('预算')
      await pipeline.getByRole('button', { name: '取消' }).click()

      // 作品库 → 长篇写作台：候选不覆盖手改，编辑后自动保存
      await page.locator('.studio-home-link').click()
      await page.waitForSelector('.studio-home', { timeout: 10_000 })
      await page.locator('.studio-project-card', { hasText: '雨伞铺的第七个夏天' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-writing', { timeout: 20_000 })
      await page.waitForTimeout(800)
      await expect(page.locator('.studio-paper-title')).toHaveValue('纸伞与铁骨')
      await expect(page.locator('.studio-candidate-banner')).toBeVisible()
      const editor = page.locator('.studio-manuscript .cm-content')
      await editor.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('她把灯关了。')
      await page.waitForTimeout(1800)
      await expect(page.locator('.studio-save-state')).toContainText('已保存')
      await page.screenshot({ path: screenshotPath('studio-writing-dark.png') })

      // 小说交付页：格式用用途命名，说明可见。
      await page.getByRole('button', { name: '切换阶段' }).click()
      await page.getByRole('menuitem', { name: '交付' }).click()
      await page.waitForSelector('.studio-delivery', { timeout: 15_000 })
      await expect(page.locator('.studio-delivery-panel')).toContainText('电子书、排版稿与可继续修改的工程包')
      await expect(page.getByRole('button', { name: /电子书/ })).toBeVisible()
      await expect(page.getByText('A4 排版稿 · 适合打印或发给编辑')).toBeVisible()
      await expect(page.getByText('DOCX · 可以继续改字')).toBeVisible()
      await expect(page.getByText('方便逐行比较和版本管理')).toBeVisible()
      await page.locator('.studio-delivery-panel').screenshot({ path: screenshotPath('studio-delivery-book-dark.png') })

      // 大白话修改计划：先预览，应用后写回时间线
      await page.locator('.studio-home-link').click()
      await page.waitForSelector('.studio-home', { timeout: 10_000 })
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 15_000 })
      const composer = page.locator('.studio-assistant-composer textarea')
      await composer.fill('镜 01 慢 20%，雨声压低一点，不要改脸。')
      await composer.press('Enter')
      await page.waitForSelector('.studio-plan-card', { timeout: 15_000 })
      await expect(page.locator('.studio-plan-card')).toContainText('时间线修改计划')
      const sourceChips = page.locator('.studio-assistant-sources button')
      expect(await sourceChips.count()).toBeGreaterThan(0)
      await expect(sourceChips.first()).not.toHaveClass(/is-dangling/)
      await page.locator('.studio-plan-apply').click()
      await page.waitForTimeout(600)
      await expect(page.locator('.studio-plan-card').first()).toContainText('已应用')
      await page.screenshot({ path: screenshotPath('studio-assistant-dark.png') })

      // 修改计划可整体撤销；撤销后计划卡标记为已撤销
      await page.getByRole('button', { name: '撤销这次修改' }).click()
      await expect(page.locator('.studio-plan-card').first()).toContainText('已撤销', { timeout: 15_000 })

      // 历史版本：已并入创作台设置子页
      await page.locator('.studio-top-icon[title="创作台设置"]').click()
      await page.waitForSelector('.studio-settings-layout', { timeout: 10_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: screenshotPath('studio-settings-dark.png') })
      await page.getByRole('tab', { name: '历史版本' }).click()
      await page.waitForSelector('.studio-version-row', { timeout: 10_000 })
      await expect(page.locator('.studio-version-row').first()).toBeVisible()
      await page.locator('.studio-modal-footer .btn', { hasText: '关闭' }).click()

      // 素纸主题：创作台不新增第三套主题
      await page.locator('.studio-home-link').click()
      await page.waitForSelector('.studio-home', { timeout: 10_000 })
      // 首页顶栏只保留作品库、设置、主题与退出；不残留上一个作品的操作。
      await expect(page.locator('.studio-project-button')).toContainText('作品库')
      await expect(page.locator('.studio-topbar').getByRole('button', { name: '新建作品' })).toHaveCount(0)
      await expect(page.locator('.studio-topbar .studio-budget')).toHaveCount(0)
      await expect(page.locator('.studio-refresh')).toHaveCount(0)
      await page.getByRole('button', { name: '切换主题' }).click()
      await page.waitForTimeout(400)
      await expect(page.locator('.studio-root')).toBeVisible()
      await page.screenshot({ path: screenshotPath('studio-home-light.png') })

      // 退出回到原对话现场，标题栏与输入框仍在
      await page.locator('.studio-exit').click()
      await expect(page.locator('.studio-root')).toHaveCount(0)
      await expect(page.locator('.titlebar')).toBeVisible()

      // 创作台图标和说明已移出关于页，只保留 Morrow 主应用信息
      await page.evaluate(() => {
        const store = (window as unknown as { __morrowStore: { getState: () => { setTheme: (value: string) => void; openSettings: () => void } } })
          .__morrowStore
        store.getState().setTheme('dark')
        store.getState().openSettings()
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible', timeout: 15_000 })
      await settings.getByRole('tab', { name: '关于' }).click()
      await expect(settings.locator('.st-about-studio')).toHaveCount(0)
      await expect(settings.locator('.st-about-brand')).toBeVisible()
      await expect(settings).not.toContainText('把一句话做成一部作品')
      await page.screenshot({ path: screenshotPath('studio-about-dark.png') })

      expect(errors, `渲染层异常：\n${errors.join('\n')}`).toEqual([])
    } finally {
      await morrow.close()
    }
  })
})
})

test.describe("20-studio-workspace", () => {
test('@core:studio-storage 漫剧画布：镜头、音频、文本节点与连线可编辑并持久化', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'canvas' })
  const page = morrow.page
  const errors: string[] = []
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
    const target = list.projects.find((item: any) => item.title === '逆行的伞')
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-canvas-link').click()
    await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
    await page.waitForTimeout(1800)
    await expect(page.locator('.studio-canvas-node')).toHaveCount(16)
    await expect(page.locator('.studio-canvas-heading h1 em')).toHaveCount(0)
    await expect(page.locator('.studio-canvas-palette .studio-eyebrow')).toHaveCount(0)
    await expect(page.locator('.studio-canvas-inspector .studio-eyebrow')).toHaveCount(0)
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

    // 刚新增节点就离开画布：离开前必须补存，回来后修改不能消失。
    await page.locator('.studio-canvas-action', { hasText: '文本' }).click()
    await expect(page.locator('.studio-canvas-node')).toHaveCount(18)
    await page.getByRole('button', { name: /分镜/ }).last().click()
    await page.waitForSelector('.studio-storyboard', { timeout: 20_000 })
    await page.locator('.studio-canvas-link').click()
    await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
    await expect(page.locator('.studio-canvas-node')).toHaveCount(18)
    expect(await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.canvas.nodes.length : 0
    }, target.id)).toBe(18)
    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await morrow.close()
  }
})
test('@core:studio-storage 从 A 画布切到 B 时，补存只写 A 的画布，不污染 B', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'canvas-switch' })
  const page = morrow.page
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    const b = await page.evaluate(async () => {
      const response = await window.morrow.features.invoke('feature:studio:action', {
        type: 'create',
        kind: 'drama',
        title: `画布切换 B ${Date.now()}`,
        logline: '另一部作品，用来确认 A 的画布不会写进来。',
        form: '速成草稿',
        genre: '都市',
        audience: '测试',
        tone: '克制',
        aspect: '16:9'
      })
      return response.ok ? response.data.project : null
    })
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    const list = await page.evaluate(async () => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'list' })
      return response.ok ? response.data.projects : []
    })
    const a = list.find((project: any) => project.title === '逆行的伞')
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-canvas-link').click()
    await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
    await expect(page.locator('.studio-canvas-node')).toHaveCount(16)
    await expect(page.locator('.studio-canvas-heading h1 em')).toHaveCount(0)
    await expect(page.locator('.studio-canvas-palette .studio-eyebrow')).toHaveCount(0)
    await expect(page.locator('.studio-canvas-inspector .studio-eyebrow')).toHaveCount(0)
    await expect(page.locator('.studio-canvas-save')).toContainText('已保存', { timeout: 15_000 })

    await page.locator('.studio-canvas-action', { hasText: '文本' }).click()
    await expect(page.locator('.studio-canvas-node')).toHaveCount(17)
    await page.locator('.studio-project-button').click()
    await page.getByRole('menuitem', { name: new RegExp(b.title) }).click()
    await expect(page.locator('.studio-project-name')).toContainText(b.title, { timeout: 15_000 })

    await expect.poll(async () => page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.canvas.nodes.length : -1
    }, a.id), { timeout: 20_000 }).toBe(17)
    expect(await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? response.data.project.canvas.nodes.length : -1
    }, b.id)).toBe(0)
    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await morrow.close()
  }
})
})

test.describe("29-writing-desk", () => {
test('@core:studio-writing 写作台具备查找替换、撤销、排版、字数与 Word 导出', async () => {
  test.setTimeout(180_000)
  const outDir = join(screensDir, 'matrix')
  mkdirSync(outDir, { recursive: true })
  const morrow = await launchMorrow({ name: 'writing-desk' })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await dismissOnboarding(page)
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '雨停之前' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-center', { timeout: 30_000 })
    if (!(await page.locator('.studio-writing').count())) {
      await page.locator('.studio-stage-item', { hasText: '写作' }).click()
    }
    await page.waitForSelector('.studio-manuscript .cm-content', { timeout: 20_000 })
    await expect(page.locator('.studio-doc-toolbar')).toBeVisible()
    await expect(page.locator('.studio-manuscript .cm-content')).toContainText('修到一半')

    await page.getByRole('button', { name: '文本替换' }).click()
    await expect(page.getByLabel('替换为')).toBeFocused()
    await page.getByLabel('查找正文').fill('雨')
    await expect(page.locator('.studio-find-count')).not.toHaveText('—')
    await page.getByLabel('替换为').fill('春雨')
    await page.screenshot({ path: join(outDir, 'studio-writing-replace.png') })
    await page.getByRole('button', { name: '全部替换', exact: true }).click()
    await page.waitForTimeout(300)
    const replaced = await page.locator('.studio-manuscript .cm-content').innerText()
    expect(replaced).toContain('春雨')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.waitForTimeout(400)
    const afterUndo = await page.locator('.studio-manuscript .cm-content').innerText()
    expect(afterUndo).not.toContain('春雨')
    expect(afterUndo).toContain('修到一半')

    // Office 习惯：Ctrl+H 直接聚焦“替换为”，不必先点“查找”。
    await page.locator('.studio-manuscript .cm-content').click()
    await page.keyboard.press('Control+H')
    await expect(page.getByLabel('替换为')).toBeFocused()
    await page.getByRole('button', { name: '关闭查找' }).click()

    await page.getByRole('button', { name: '排版', exact: true }).click()
    const typeDialog = page.getByRole('dialog', { name: '排版设置' })
    await expect(typeDialog).toBeVisible()
    await typeDialog.getByRole('radio', { name: '大', exact: true }).click()
    await typeDialog.getByRole('radio', { name: '宽松', exact: true }).click()
    await typeDialog.getByRole('radio', { name: '宽', exact: true }).click()
    const typography = await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('.studio-manuscript .cm-editor')
      const paper = document.querySelector<HTMLElement>('.studio-paper')
      return {
        fontSize: editor ? parseFloat(getComputedStyle(editor).fontSize) : 0,
        lineHeight: editor ? parseFloat(getComputedStyle(editor).lineHeight) : 0,
        paperMaxWidth: paper ? getComputedStyle(paper).maxWidth : ''
      }
    })
    expect(typography.fontSize).toBeGreaterThanOrEqual(20)
    expect(typography.lineHeight).toBeGreaterThanOrEqual(40)
    expect(typography.paperMaxWidth).toBe('980px')
    await page.screenshot({ path: join(outDir, 'studio-writing-desk.png') })

    await page.getByRole('button', { name: '字数统计' }).click()
    const countDialog = page.getByRole('dialog', { name: '字数统计' })
    await expect(countDialog).toBeVisible()
    await expect(countDialog).toContainText('字')
    await expect(countDialog).toContainText('分钟')

    await page.getByRole('button', { name: '导出 Word' }).click()
    const library = await action<{ projects: Array<{ id: string; title: string }> }>('list')
    const projectId = library.projects.find((item) => item.title === '雨停之前')!.id
    await expect.poll(async () => {
      const jobs = await action<{ jobs: any[] }>('list-jobs', { projectId })
      return jobs.jobs.find((job) => job.retry?.action === 'export')?.status ?? ''
    }, { timeout: 30_000 }).toBe('done')
  } finally {
    await morrow.close()
  }
})
})

test.describe('32-studio-sync', () => {
  const openSample = async (morrow: Awaited<ReturnType<typeof launchMorrow>>) => {
    const page = morrow.page
    await dismissOnboarding(page)
    await page.locator('.tb-create').click()
    await expect(page.locator('.studio-home')).toBeVisible({ timeout: 30_000 })
    if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
    return page
  }
  const pid = async (page: import('@playwright/test').Page): Promise<string> => {
    return page.evaluate(async () => {
      const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'list' })
      return response.data.projects.find((project: any) => project.title === '逆行的伞').id as string
    })
  }
  const projectOf = async (page: import('@playwright/test').Page, projectId: string): Promise<any> =>
    page.evaluate(async (id) => {
      const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'get', projectId: id })
      return response.data.project
    }, projectId)

  test('@core:studio-drama 协作者补全分镜会展示完整方案并在应用后同步蓝图、大纲与分镜', async () => {
    test.setTimeout(150_000)
    const shots = [13, 14, 15, 16].map((number) => ({
      number,
      title: `补全镜${number}`,
      action: `第 ${number} 镜补全动作`,
      camera: '缓慢推近',
      shotSize: '中景',
      seconds: 8,
      dialogue: `第 ${number} 镜台词`,
      speaker: '林晚',
      continuity: `承接第 ${number - 1} 镜`,
      prompt: `第 ${number} 镜画面`,
      negative: '文字'
    }))
    const mock = await startMockLLM({ scripts: [{ text: JSON.stringify({ shots }) }] })
    const morrow = await launchMorrow({ name: 'assistant-extend', timeoutMs: 90_000 })
    try {
      const page = await openSample(morrow)
      await configureMockProvider(page, mock.openaiBaseUrl)
      const projectId = await pid(page)
      if (!(await page.locator('.studio-assistant').isVisible())) {
        await page.locator('[aria-label="切换协作者面板"]').click()
      }
      const composer = page.locator('.studio-assistant-composer textarea')
      await composer.fill('请补全第 13-16 镜分镜')
      await composer.press('Enter')
      const card = page.locator('.studio-plan-card')
      await expect(card).toContainText('补全分镜计划', { timeout: 30_000 })
      for (const number of [13, 14, 15, 16]) {
        await expect(page.locator('.studio-assistant')).toContainText(`第 ${number} 镜`)
        await expect(card).toContainText(`第 ${number} 镜`)
      }
      await card.locator('.studio-plan-apply').click()
      await expect.poll(async () => (await projectOf(page, projectId)).shots.length, { timeout: 30_000 }).toBe(16)
      const project = await projectOf(page, projectId)
      expect(project.blueprint.units.length).toBe(16)
      expect(project.scenes.flatMap((scene: any) => scene.id)).toContain(project.shots.find((shot: any) => shot.number === 13).sceneId)
      await expect(page.locator('.studio-shot-card')).toHaveCount(16, { timeout: 20_000 })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

test.describe('35-studio-collaborator', () => {
  const openProject = async (morrow: Awaited<ReturnType<typeof launchMorrow>>, title: string) => {
    const page = morrow.page
    await dismissOnboarding(page)
    await page.locator('.tb-create').click()
    await expect(page.locator('.studio-home')).toBeVisible({ timeout: 30_000 })
    if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: title }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-center', { timeout: 30_000 })
    return page
  }
  const projectIdOf = async (page: import('@playwright/test').Page, title: string): Promise<string> =>
    page.evaluate(async (wanted) => {
      const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'list' })
      return response.data.projects.find((project: any) => project.title === wanted).id as string
    }, title)
  const projectOf = async (page: import('@playwright/test').Page, projectId: string): Promise<any> =>
    page.evaluate(async (id) => {
      const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'get', projectId: id })
      return response.data.project
    }, projectId)

  test('@core:studio-assistant 中短篇写作页的改写请求会排队真实模型并替换正文', async () => {
    test.setTimeout(180_000)
    const mock = await startMockLLM({
      scripts: [
        {
          text: JSON.stringify({
            reply: '我会重写第 1 章的结尾，保留人物、事实和前面的段落。',
            actions: [{
              type: 'rewrite-chapter',
              chapter: { number: 1 },
              instruction: '只改第 1 章结尾，让它更克制；保留人物、事实和前面的段落。'
            }]
          })
        },
        { text: '雨停之后，她把伞收进柜台。\n\n少年没有再来，门口的水痕慢慢干了。' }
      ]
    })
    const morrow = await launchMorrow({ name: 'collab-short', timeoutMs: 90_000 })
    try {
      const page = await openProject(morrow, '雨停之前')
      await configureMockProvider(page, mock.openaiBaseUrl)
      const projectId = await projectIdOf(page, '雨停之前')
      await page.locator('.studio-stage-item', { hasText: '写作' }).click()
      await page.waitForSelector('.studio-writing', { timeout: 20_000 })
      if (!(await page.locator('.studio-assistant').isVisible())) {
        await page.locator('[aria-label="切换协作者面板"]').click()
      }
      const composer = page.locator('.studio-assistant-composer textarea')
      await composer.fill('把第 1 章的结尾改得更克制，保留人物和事实。')
      await composer.press('Enter')
      const card = page.locator('.studio-plan-card')
      await expect(card).toContainText('协作者修改计划', { timeout: 40_000 })
      await expect(card).toContainText('按计划重写第 1 章正文')
      await card.locator('.studio-plan-apply').click()
      await expect.poll(async () => (await projectOf(page, projectId)).chapters[0].content, { timeout: 90_000 }).toContain('少年没有再来')
      const project = await projectOf(page, projectId)
      expect(project.chapters[0].versions.some((version: any) => version.reason.includes('协作者重写'))).toBe(true)
      expect(project.stages.writing.status).toBe('done')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

test.describe('33-studio-vision', () => {
  test('@core:studio-media 视觉检查真实调用支持图片的模型，而不是只显示未连接提示', async () => {
    test.setTimeout(120_000)
    const mock = await startMockLLM({ scripts: [{ text: '画面通过，未发现问题。' }] })
    const morrow = await launchMorrow({ name: 'vision-check', timeoutMs: 90_000 })
    try {
      const page = morrow.page
      await dismissOnboarding(page)
      await page.locator('.tb-create').click()
      await expect(page.locator('.studio-home')).toBeVisible({ timeout: 30_000 })
      if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
      const provider = await configureMockProvider(page, mock.openaiBaseUrl, 'mock-vision', 32_000, true)
      const projectId = await page.evaluate(async () => {
        const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'list' })
        return response.data.projects.find((project: any) => project.title === '逆行的伞').id as string
      })
      const project = await page.evaluate(async (id) => {
        const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'get', projectId: id })
        return response.data.project
      }, projectId)
      const shot = project.shots.find((item: any) => item.imageAssetId)
      expect(shot).toBeTruthy()
      const result = await page.evaluate(async (arg) => {
        const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'visual-check', projectId: arg.projectId, shotIds: [arg.shotId] })
        return response
      }, { projectId, shotId: shot.id })
      expect(result.ok).toBe(true)
      const jobId = result.data.job.id
      await expect.poll(async () => {
        const response = await page.evaluate(async (arg) => {
          const r = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'list-jobs', projectId: arg.projectId })
          return r.data.jobs.find((job: any) => job.id === arg.jobId)?.status
        }, { projectId, jobId })
        return response
      }, { timeout: 60_000 }).toBe('done')
      const latest = await page.evaluate(async (id) => {
        const response = await (window as any).morrow.features.invoke('feature:studio:action', { type: 'get', projectId: id })
        return response.data.project
      }, projectId)
      const visual = latest.checks.find((check: any) => check.kind === 'visual')
      expect(visual?.detail).toContain('画面通过')
      expect(visual?.detail).not.toContain('没有可用的本地视觉模型')
      expect(provider.providerId).toBe('mock-vision')
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})

// ── 成片链路套组（原 studio-pipeline.spec.ts） ──────────────────────────────
// ── tests/e2e/adaptation-all-chapters.spec.ts ──────────────────────────────────────────────
{
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZz3GQAAAABJRU5ErkJggg==',
  'base64'
)

test('@core:studio-drama 小说改编漫剧不再截断 12 章，全部章节分批进入分镜', async () => {
  test.setTimeout(180_000)
  const batch = (startChapter: number): string =>
    JSON.stringify({
      scenes: [
        {
          title: `第 ${startChapter} 章场景`,
          synopsis: `第 ${startChapter} 章改编场景`,
          location: '旧街',
          timeOfDay: '夜',
          characters: [],
          unitStart: 1,
          unitEnd: 6,
          sourceChapter: startChapter
        }
      ],
      shots: Array.from({ length: 6 }, (_, index) => ({
        number: index + 1,
        sceneIndex: 1,
        title: `第 ${startChapter} 章镜 ${index + 1}`,
        action: `第 ${startChapter} 章第 ${index + 1} 镜动作`,
        camera: '固定镜头',
        shotSize: '中景',
        seconds: 8,
        dialogue: '',
        speaker: '',
        continuity: index === 0 ? '本批开场' : `承接第 ${index} 镜`,
        prompt: `第 ${startChapter} 章第 ${index + 1} 镜画面`,
        negative: ''
      }))
    })
  const mock = await startMockLLM({ scripts: [{ text: batch(1) }, { text: batch(9) }] })
  const morrow = await launchMorrow({ name: 'adapt-all-chapters', timeoutMs: 90_000 })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    const created = await action<{ project: { id: string } }>('create', {
      kind: 'short',
      title: `全量改编测试 ${Date.now()}`,
      logline: '一个修伞人走遍十五个雨夜，寻找失落的伞骨。',
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '测试读者',
      tone: '克制',
      aspect: '16:9'
    })
    const sourceId = created.project.id
    const chapterContent = (number: number): string =>
      `第 ${number} 章正文。${'雨落在旧街上，修伞人继续寻找下一根伞骨。'.repeat(48)}第 ${number} 章结尾锚点。`
    for (let number = 1; number <= 15; number += 1) {
      await action('add-chapter', {
        projectId: sourceId,
        title: `第 ${number} 章`,
        content: chapterContent(number)
      })
    }
    const source = await action<{ project: { chapters: unknown[] } }>('get', { projectId: sourceId })
    expect(source.project.chapters).toHaveLength(15)

    await action('adapt-to-drama', { projectId: sourceId })
    let targetId = ''
    await expect.poll(async () => {
      const listed = await action<{ projects: Array<{ id: string; title: string; kind: string }> }>('list')
      targetId = listed.projects.find((project) => project.kind === 'drama' && project.title.includes('全量改编测试'))?.id ?? ''
      return targetId
    }, { timeout: 30_000 }).not.toBe('')
    let target: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { stages: { storyboard: { status: string } } } }>('get', { projectId: targetId })
      target = current.project
      return current.project.stages.storyboard.status
    }, { timeout: 120_000 }).toBe('done')
    expect(target.chapters).toHaveLength(15)
    expect(target.shots).toHaveLength(12)
    expect(target.blueprint.adaptedFrom?.chapters).toBe(15)
    expect(mock.requests.length).toBe(2)
    // 核对实际发给模型的正文，不能只凭复制了 15 章就认定全部参与改编。
    for (let number = 1; number <= 15; number += 1) {
      const prompt = mock.requests[number <= 8 ? 0 : 1].lastUserMessageText
      expect(prompt, `第 ${number} 章应进入对应分镜批次`).toContain(`第 ${number} 章正文。`)
      expect(prompt, `第 ${number} 章结尾（500 字之后）也必须送入模型`).toContain(`第 ${number} 章结尾锚点。`)
    }
    expect(mock.requests[0].lastUserMessageText).not.toContain('第 9 章正文。')
    expect(mock.requests[1].lastUserMessageText).not.toContain('第 8 章正文。')

    // 已有镜头后只重做某一章：仍按章节分批，保留其他镜头与素材。
    const chapter9 = target.chapters.find((chapter: any) => chapter.number === 9)
    const firstBatchIds = target.shots.slice(0, 6).map((shot: any) => shot.id)
    const secondBatchIds = target.shots.slice(6).map((shot: any) => shot.id)
    const pngPath = join(tmpdir(), `morrow-scoped-shot-${Date.now()}.png`)
    writeFileSync(pngPath, TINY_PNG)
    const imported = await action<{ project: { shots: Array<{ id: string; imageAssetId: string | null }> } }>('import-asset', {
      projectId: targetId,
      path: pngPath,
      shotId: secondBatchIds[0]
    })
    const attachedImage = imported.project.shots.find((shot) => shot.id === secondBatchIds[0])?.imageAssetId
    expect(attachedImage).toBeTruthy()
    mock.reset([{
      text: JSON.stringify({
        shots: Array.from({ length: 6 }, (_, index) => ({
          number: 7 + index,
          sceneIndex: 1,
          title: `重做第 ${7 + index} 镜`,
          action: `第 9 章新动作 ${index + 1}`,
          camera: '缓慢推近',
          shotSize: '近景',
          seconds: 7,
          dialogue: '',
          speaker: '',
          continuity: index === 0 ? '承接第 6 镜' : `承接第 ${6 + index} 镜`,
          prompt: `第 9 章新画面 ${index + 1}`,
          negative: ''
        }))
      })
    }])
    await action('generate-storyboard', { projectId: targetId, scope: 'chapter', chapterId: chapter9.id })
    await expect.poll(async () => {
      const current = await action<{ project: { shots: Array<{ id: string; title: string; imageAssetId: string | null }> } }>('get', { projectId: targetId })
      target = current.project
      return current.project.shots[6]?.title ?? ''
    }, { timeout: 60_000 }).toContain('重做第 7 镜')
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0].lastUserMessageText).toContain('第 9 章正文。')
    expect(mock.requests[0].lastUserMessageText).not.toContain('第 15 章正文。')
    expect(target.shots).toHaveLength(12)
    expect(target.shots.slice(0, 6).map((shot: any) => shot.id)).toEqual(firstBatchIds)
    expect(target.shots.slice(6).map((shot: any) => shot.id)).toEqual(secondBatchIds)
    expect(target.shots[6].imageAssetId).toBe(attachedImage)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
}

// ── tests/e2e/blueprint-resume.spec.ts ──────────────────────────────────────────────
{
test('@core:studio-writing 长篇蓝图分批失败后保存已完成章节，重试只补剩余批次', async () => {
  test.setTimeout(180_000)
  const top = {
    storyCore: '失忆的少年在雨夜伞铺里寻找自己的名字。',
    emotion: '克制',
    audience: '成年读者',
    pitch: '一把会倒着走时间的伞。',
    structure: '六章推进',
    genre: '都市奇幻',
    tone: '克制',
    styleBible: { look: '雨夜写实', palette: [], camera: '固定', sound: '雨声', negative: [] },
    volumes: [{ title: '第一卷', summary: '雨夜与旧伞', unitStart: 1, unitEnd: 6 }],
    characters: [],
    places: [],
    units: []
  }
  const cast = {
    characters: [
      { name: '林晚', role: '修伞人', look: '短黑发' },
      { name: '少年', role: '失忆者', look: '湿透的外套' }
    ],
    places: [{ name: '老街伞铺', description: '雨棚下的旧木柜台' }]
  }
  const units = (start: number, count: number): string =>
    JSON.stringify({
      units: Array.from({ length: count }, (_, index) => ({
        index: start + index,
        title: `第 ${start + index} 章`,
        summary: `第 ${start + index} 章：林晚在雨夜继续追查少年的名字。`,
        beats: ['雨夜', '旧伞', '线索'],
        wordTarget: 3000
      }))
    })
  const mock = await startMockLLM({ scripts: [
    { text: JSON.stringify(top) },
    { text: JSON.stringify(cast) },
    { text: units(1, 4) },
    { text: '{"units": [' }
  ] })
  const morrow = await launchMorrow({ name: 'blueprint-resume', timeoutMs: 90_000 })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    const created = await action<{ project: { id: string } }>('create', {
      kind: 'novel',
      title: `长篇蓝图续作 ${Date.now()}`,
      logline: top.storyCore,
      targetWords: 24000,
      form: '长篇连载'
    })
    const projectId = created.project.id
    await action('generate-blueprint', { projectId, useModel: true })
    let failedJob: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { stages: { blueprint: { status: string } }; jobs: any[] } }>('get', { projectId })
      failedJob = [...current.project.jobs].reverse().find((job) => job.stage === 'blueprint')
      return current.project.stages.blueprint.status
    }, { timeout: 90_000 }).toBe('failed')
    expect(String(failedJob?.error ?? '')).toContain('已完成 1 批章节')

    mock.reset([{ text: units(5, 2) }])
    const retried = await action<{ project: { id: string }; job: { id: string } }>('generate-blueprint', { projectId, useModel: true })
    let target: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { jobs: any[] } }>('get', { projectId })
      target = current.project
      return current.project.jobs.find((job) => job.id === retried.job.id)?.status
    }, { timeout: 90_000 }).toBe('done')
    target = (await action<{ project: any }>('get', { projectId })).project
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0].lastUserMessageText).toContain('第 5–6 章')
    expect(target.blueprint.units).toHaveLength(6)
    expect(target.blueprint.units.map((unit: any) => unit.title)).toEqual(
      Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 章`)
    )
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:studio-writing 长篇蓝图人物步骤失败后，重试先补人物再继续章节', async () => {
  test.setTimeout(180_000)
  const top = {
    storyCore: '失忆的少年在雨夜伞铺里寻找自己的名字。',
    emotion: '克制',
    audience: '成年读者',
    pitch: '一把会倒着走时间的伞。',
    structure: '六章推进',
    genre: '都市奇幻',
    tone: '克制',
    styleBible: { look: '雨夜写实', palette: [], camera: '固定', sound: '雨声', negative: [] },
    volumes: [{ title: '第一卷', summary: '雨夜与旧伞', unitStart: 1, unitEnd: 6 }],
    characters: [],
    places: [],
    units: []
  }
  const cast = {
    characters: [
      { name: '林晚', role: '修伞人', look: '短黑发' },
      { name: '少年', role: '失忆者', look: '湿透的外套' }
    ],
    places: [{ name: '老街伞铺', description: '雨棚下的旧木柜台' }]
  }
  const units = (start: number, count: number): string =>
    JSON.stringify({
      units: Array.from({ length: count }, (_, index) => ({
        index: start + index,
        title: `第 ${start + index} 章`,
        summary: `第 ${start + index} 章：林晚在雨夜继续追查少年的名字。`,
        beats: ['雨夜', '旧伞', '线索'],
        wordTarget: 3000
      }))
    })
  const mock = await startMockLLM({ scripts: [{ text: JSON.stringify(top) }, { text: '人物不是 JSON' }] })
  const morrow = await launchMorrow({ name: 'blueprint-cast-resume', timeoutMs: 90_000 })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    const created = await action<{ project: { id: string } }>('create', {
      kind: 'novel',
      title: `蓝图人物续作 ${Date.now()}`,
      logline: top.storyCore,
      targetWords: 24000,
      form: '长篇连载'
    })
    const projectId = created.project.id
    await action('generate-blueprint', { projectId, useModel: true })
    await expect.poll(async () => {
      const current = await action<{ project: { stages: { blueprint: { status: string } } } }>('get', { projectId })
      return current.project.stages.blueprint.status
    }, { timeout: 90_000 }).toBe('failed')

    mock.reset([{ text: JSON.stringify(cast) }, { text: units(1, 4) }, { text: units(5, 2) }])
    const retried = await action<{ job: { id: string } }>('generate-blueprint', { projectId, useModel: true })
    let target: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { jobs: any[] } }>('get', { projectId })
      target = current.project
      return current.project.jobs.find((job) => job.id === retried.job.id)?.status
    }, { timeout: 90_000 }).toBe('done')
    target = (await action<{ project: any }>('get', { projectId })).project
    expect(mock.requests).toHaveLength(3)
    expect(mock.requests[0].lastUserMessageText).toContain('写能支撑这条主线的 3–6 个具体人物与 3–6 个地点')
    expect(target.blueprint.characters.length).toBeGreaterThanOrEqual(2)
    expect(target.blueprint.units).toHaveLength(6)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
}

// ── tests/e2e/review-coverage.spec.ts ──────────────────────────────────────────────
{
test('@core:studio-writing 全书分批审稿保存覆盖范围与版本，界面列出已审和未审部分', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [
      { text: JSON.stringify({ summary: '前四章通过。', issues: [] }) },
      { text: JSON.stringify({ summary: '后两章通过。', issues: [] }) }
    ]
  })
  const morrow = await launchMorrow({ name: 'review-coverage', timeoutMs: 90_000 })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    const created = await action<{ project: { id: string; title: string } }>('create', {
      kind: 'short',
      title: `覆盖范围测试 ${Date.now()}`,
      logline: '六章篇幅里，修伞人每周三都会遇见同一个失忆少年。',
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '测试读者',
      tone: '克制',
      aspect: '16:9'
    })
    const projectId = created.project.id
    const longChapter = `${'第 5 章正文。林晚在雨里修伞，少年又忘了自己的名字。'.repeat(320)}第 5 章结尾唯一标记。`
    for (let number = 1; number <= 6; number += 1) {
      await action('add-chapter', {
        projectId,
        title: `第 ${number} 章`,
        content: number === 5 ? longChapter : `第 ${number} 章正文。林晚在雨里修伞，少年又忘了自己的名字。`
      })
    }
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: created.project.title }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-writing', { timeout: 30_000 })
    await page.getByRole('button', { name: '切换阶段' }).click()
    await page.getByRole('menuitem', { name: '检查' }).click()
    await page.waitForSelector('.studio-review', { timeout: 20_000 })
    await page.locator('select[aria-label="审稿范围"]').selectOption('all')
    await page.getByRole('button', { name: '模型审稿' }).click()
    await expect.poll(async () => {
      const current = await action<{ project: { stages: { review: { status: string } }; reviewCoverage?: any[] } }>('get', { projectId })
      return current.project.stages.review.status
    }, { timeout: 90_000, intervals: [100, 200, 500] }).toBe('done')
    const saved = await action<{ project: { reviewCoverage: any[]; chapters: any[] } }>('get', { projectId })
    expect(saved.project.reviewCoverage).toHaveLength(2)
    expect(saved.project.reviewCoverage.map((entry) => entry.label)).toEqual(['第 1–4 章', '第 5–6 章'])
    const longCoverage = saved.project.reviewCoverage.find((entry) => entry.label === '第 5–6 章')
    const chapter5 = saved.project.chapters.find((chapter) => chapter.number === 5)
    const longSegments = (longCoverage?.segments ?? []).filter((segment: any) => segment.id === chapter5.id)
    expect(longSegments.length).toBe(2)
    expect(longSegments.at(-1)?.end).toBe(longChapter.length)
    expect(mock.requests[1].lastUserMessageText).toContain('第 5 章结尾唯一标记。')
    expect(mock.requests[1].lastUserMessageText).toContain('第 5 章（第 8001–')
    await expect(page.locator('.studio-review-coverage')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.studio-review-coverage')).toContainText('第 1–4 章')
    await expect(page.locator('.studio-review-coverage')).toContainText('第 5–6 章')
    await expect(page.locator('.studio-review-coverage')).toContainText('6/6 章')
    await page.screenshot({ path: join(screensDir, 'matrix', 'studio-review-coverage.png'), fullPage: false })
  } finally {
    await morrow.close()
    await mock.close()
  }
})

test('@core:studio-writing 当前章审稿失败后重试仍只审原来那一章', async () => {
  test.setTimeout(120_000)
  const mock = await startMockLLM({
    scripts: [
      { text: '这不是可解析的 JSON' },
      { text: JSON.stringify({ summary: '当前章通过。', issues: [] }) }
    ]
  })
  const morrow = await launchMorrow({ name: 'review-retry', timeoutMs: 90_000 })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    const created = await action<{ project: { id: string } }>('create', {
      kind: 'short',
      title: `审稿重试测试 ${Date.now()}`,
      logline: '两章篇幅里，修伞人分别在雨夜与清晨遇见同一个人。',
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '测试读者',
      tone: '克制',
      aspect: '16:9'
    })
    const projectId = created.project.id
    for (let number = 1; number <= 2; number += 1) {
      await action('add-chapter', {
        projectId,
        title: `第 ${number} 章`,
        content: `第 ${number} 章正文。第 ${number} 章独家标记，林晚在雨里修伞。`
      })
    }
    const before = await action<{ project: { chapters: any[] } }>('get', { projectId })
    const chapter2 = before.project.chapters.find((chapter) => chapter.number === 2)
    const queued = await action<{ project: { jobs: any[] }; job: { id: string } }>('model-review', {
      projectId,
      scope: 'current',
      chapterId: chapter2.id
    })
    let failed: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { jobs: any[] } }>('get', { projectId })
      failed = current.project.jobs.find((job) => job.id === queued.job.id)
      return failed?.status
    }, { timeout: 30_000, intervals: [100, 200, 500] }).toBe('failed')
    expect(failed.retry?.payload).toMatchObject({ scope: 'current', chapterId: chapter2.id })

    mock.reset([{ text: JSON.stringify({ summary: '当前章通过。', issues: [] }) }])
    const retried = await action<{ job: { id: string } }>('retry-job', { projectId, jobId: queued.job.id })
    await expect.poll(async () => {
      const current = await action<{ project: { jobs: any[]; stages: { review: { status: string } } } }>('get', { projectId })
      const job = current.project.jobs.find((item) => item.id === retried.job.id)
      return job?.status === 'done' ? current.project.stages.review.status : job?.status
    }, { timeout: 30_000, intervals: [100, 200, 500] }).toBe('review')
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0].lastUserMessageText).toContain('第 2 章独家标记')
    expect(mock.requests[0].lastUserMessageText).not.toContain('第 1 章独家标记')
    const after = await action<{ project: { reviewCoverage: any[] } }>('get', { projectId })
    expect(after.project.reviewCoverage).toHaveLength(1)
    expect(after.project.reviewCoverage[0].units.map((unit: any) => unit.id)).toContain(chapter2.id)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
}

// ── tests/e2e/storyboard-conflict.spec.ts ──────────────────────────────────────────────
{
test('@core:studio-drama 分镜生成期间手改同一镜，AI 新稿只进入待比较候选', async () => {
  test.setTimeout(180_000)
  const mock = await startMockLLM({
    scripts: [{
      delayMs: 4_000,
      text: JSON.stringify({
        shots: [{
          number: 7,
          sceneIndex: 1,
          title: 'AI 重做标题',
          action: 'AI 生成的新动作',
          camera: '缓慢推近',
          shotSize: '近景',
          seconds: 7,
          dialogue: 'AI 新台词',
          speaker: '林晚',
          continuity: '承接第 6 镜',
          prompt: 'AI 画面提示',
          negative: ''
        }]
      })
    }]
  })
  const morrow = await launchMorrow({ name: 'storyboard-conflict', timeoutMs: 90_000 })
  const page = morrow.page
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await configureMockProvider(page, mock.openaiBaseUrl)
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-stage-item', { hasText: '分镜' }).click()
    await page.waitForSelector('.studio-storyboard', { timeout: 30_000 })
    const project = await page.evaluate(async () => {
      const list = await window.morrow.features.invoke('feature:studio:action', { type: 'list' })
      const target = list.ok ? list.data.projects.find((item: any) => item.title === '逆行的伞') : null
      const response = target ? await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId: target.id }) : null
      return response?.ok ? response.data.project : null
    })
    const shot = project.shots.find((item: any) => item.number === 7)
    const queued = await page.evaluate(async (payload) => {
      const response = await window.morrow.features.invoke('feature:studio:action', payload)
      return response.ok ? response.data : { error: response.error?.message }
    }, { type: 'generate-storyboard', projectId: project.id, scope: 'shot', shotId: shot.id })
    expect(queued.job?.id).toBeTruthy()
    await page.evaluate(async (payload) => {
      await window.morrow.features.invoke('feature:studio:action', payload)
    }, { type: 'save-shot', projectId: project.id, shotId: shot.id, action: '人工改过的动作', dialogue: '人工台词' })
    await expect.poll(async () => {
      const response = await page.evaluate(async (projectId: string) => {
        const result = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
        return result.ok ? result.data.project : null
      }, project.id)
      return response.jobs.find((item: any) => item.id === queued.job.id)?.status
    }, { timeout: 60_000, intervals: [100, 200, 500] }).toBe('done')
    const after = await page.evaluate(async (projectId: string) => {
      const result = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return result.ok ? result.data.project : null
    }, project.id)
    const afterShot = after.shots.find((item: any) => item.id === shot.id)
    expect(afterShot.action).toBe('人工改过的动作')
    expect(afterShot.rewriteCandidate?.action).toBe('AI 生成的新动作')

    await page.locator('.studio-shot-card').nth(6).click()
    await expect(page.locator('.studio-rewrite-compare')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.studio-rewrite-compare')).toContainText('AI 生成的新动作')
    await page.locator('.studio-rewrite-compare').getByRole('button', { name: '采用 AI 新稿' }).click()
    await expect.poll(async () => {
      const response = await page.evaluate(async (projectId: string) => {
        const result = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
        return result.ok ? result.data.project : null
      }, project.id)
      return response.shots.find((item: any) => item.id === shot.id)?.action
    }, { timeout: 20_000 }).toBe('AI 生成的新动作')
    await expect(page.locator('.studio-rewrite-compare')).toHaveCount(0)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
}

// ── tests/e2e/storyboard-resume.spec.ts ──────────────────────────────────────────────
{
test('@core:studio-drama 分批分镜失败后保存已完成批次，重试只补未完成部分', async () => {
  test.setTimeout(180_000)
  const batch = (startChapter: number): string =>
    JSON.stringify({
      scenes: [{
        title: `第 ${startChapter} 章场景`,
        synopsis: `第 ${startChapter} 章改编场景`,
        location: '旧街',
        timeOfDay: '夜',
        characters: [],
        unitStart: 1,
        unitEnd: 6,
        sourceChapter: startChapter
      }],
      shots: Array.from({ length: 6 }, (_, index) => ({
        number: index + 1,
        sceneIndex: 1,
        title: `第 ${startChapter} 章镜 ${index + 1}`,
        action: `第 ${startChapter} 章第 ${index + 1} 镜动作`,
        camera: '固定镜头',
        shotSize: '中景',
        seconds: 8,
        dialogue: '',
        speaker: '',
        continuity: index === 0 ? '本批开场' : `承接第 ${index} 镜`,
        prompt: `第 ${startChapter} 章第 ${index + 1} 镜画面`,
        negative: ''
      }))
    })
  const mock = await startMockLLM({ scripts: [{ text: batch(1) }, { text: '{"shots": [' }] })
  const morrow = await launchMorrow({ name: 'storyboard-resume', timeoutMs: 90_000 })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    const created = await action<{ project: { id: string } }>('create', {
      kind: 'short',
      title: `分镜续作测试 ${Date.now()}`,
      logline: '一个修伞人走遍十五个雨夜，寻找失落的伞骨。',
      form: '速成草稿',
      genre: '都市奇幻',
      audience: '测试读者',
      tone: '克制',
      aspect: '16:9'
    })
    const sourceId = created.project.id
    for (let number = 1; number <= 15; number += 1) {
      await action('add-chapter', {
        projectId: sourceId,
        title: `第 ${number} 章`,
        content: `第 ${number} 章正文。雨落在旧街上，修伞人继续寻找下一根伞骨。`
      })
    }
    await action('adapt-to-drama', { projectId: sourceId })
    let targetId = ''
    await expect.poll(async () => {
      const listed = await action<{ projects: Array<{ id: string; title: string; kind: string }> }>('list')
      targetId = listed.projects.find((project) => project.kind === 'drama' && project.title.includes('分镜续作测试'))?.id ?? ''
      return targetId
    }, { timeout: 30_000 }).not.toBe('')
    let failedJob: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { stages: { storyboard: { status: string } }; jobs: any[] } }>('get', { projectId: targetId })
      failedJob = [...current.project.jobs].reverse().find((job) => job.stage === 'storyboard')
      return current.project.stages.storyboard.status
    }, { timeout: 90_000 }).toBe('failed')
    expect(String(failedJob?.error ?? '')).toContain('已完成 1/2 批')
    const partialShots = (await action<{ project: { shots: unknown[] } }>('get', { projectId: targetId })).project.shots
    expect(partialShots).toHaveLength(0)

    mock.reset([{ text: batch(9) }])
    await action('generate-storyboard', { projectId: targetId })
    let target: any = null
    await expect.poll(async () => {
      const current = await action<{ project: { stages: { storyboard: { status: string } }; shots: any[] } }>('get', { projectId: targetId })
      target = current.project
      return current.project.stages.storyboard.status
    }, { timeout: 90_000 }).toBe('done')
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0].lastUserMessageText).toContain('第 9 章正文。')
    expect(mock.requests[0].lastUserMessageText).not.toContain('第 8 章正文。')
    expect(target.shots).toHaveLength(12)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
}

// ── tests/e2e/studio-novel-core.spec.ts ──────────────────────────────────────────────
{
test('@core:studio-writing 新建小说：蓝图、六章正文、审稿、EPUB 与工程包往返', async () => {
  const units = Array.from({ length: 6 }, (_, index) => ({
    index: index + 1, title: `夜车第${index + 1}站`, summary: `司机在第${index + 1}站核对旧信与乘客的记忆。`, wordTarget: 2000
  }))
  const chapters = units.map((unit, index) => `正文锚点${index + 1}。\n\n` + Array.from({ length: 40 }, (_, paragraph) =>
    `第${paragraph + 1}张车票压在掌心。司机关掉广播，沿着第${index + 1}站的站台寻找信封上的地址。路灯照出纸张背面的折痕，他把号码抄进本子，等乘客说完才合上车门。`
  ).join('\n\n'))
  const blueprint = {
    storyCore: '夜班司机按旧信寻找失散的家人。', pitch: '最后一班夜车上的六次停靠。', structure: '六章推进',
    characters: [{ name: '程林', role: '司机', look: '蓝色制服' }, { name: '余舟', role: '乘客', look: '灰色大衣' }],
    places: [{ name: '总站', description: '雨后的夜班公交总站' }],
    styleBible: { look: '朴素写实', palette: [], camera: '固定', sound: '车站环境声', negative: [] }, units
  }
  const mock = await startMockLLM({ scripts: [
    { text: JSON.stringify(blueprint) },
    { text: JSON.stringify({ units: units.map((unit) => ({ ...unit, summary: `${unit.summary}保留这一站的独立线索。` })) }) },
    ...chapters.map((text) => ({ text })),
    { text: JSON.stringify({ summary: '前四章材料均已收到。', issues: [] }) },
    { text: JSON.stringify({ summary: '后两章材料均已收到。', issues: [] }) }
  ] })
  const morrow = await launchMorrow({ name: 'novel-core' })
  const { page } = morrow
  const action = async (type: string, payload: Record<string, unknown> = {}): Promise<StudioActionResult> => {
    const result = await page.evaluate(
      (input) => window.morrow.features.invoke('feature:studio:action', input), { type, ...payload }
    )
    if (!result.ok) throw new Error(`${type}: ${result.error?.message}`)
    return result.data as StudioActionResult
  }
  try {
    await waitForStoreReady(page)
    await dismissOnboarding(page)
    await configureMockProvider(page, mock.openaiBaseUrl)
    let project = (await action('create', {
      kind: 'short', title: '离线整书流程', logline: blueprint.storyCore, targetWords: 12000, form: '速成草稿'
    })).project
    const projectId = project.id
    const run = async (type: string, payload: Record<string, unknown> = {}): Promise<StudioProject> => {
      const queued = await action(type, { projectId, ...payload })
      expect(queued.job?.id, `${type} 应建立真实任务`).toBeTruthy()
      let current = queued.project
      await expect.poll(async () => {
        current = (await action('get', { projectId })).project
        const job = current.jobs.find((item) => item.id === queued.job!.id)
        if (job?.status === 'failed') throw new Error(`${type}: ${job.message}`)
        return job?.status
      }, { timeout: 20000, intervals: [50, 100, 200] }).toBe('done')
      return current
    }

    project = await run('generate-blueprint', { useModel: true })
    expect(project.blueprint?.source).toBe('model')
    expect(project.blueprint?.units).toHaveLength(6)
    await action('approve-blueprint', { projectId })
    project = await run('generate-outline', { useModel: true })
    expect(project.chapters).toHaveLength(6)
    expect(project.chapters.every((chapter) => chapter.synopsis.includes('独立线索'))).toBe(true)
    const ids = project.chapters.map((chapter) => chapter.id)
    for (let index = 0; index < ids.length; index += 1) {
      project = await run('generate-chapter', { chapterId: ids[index], useModel: true })
      const written = project.chapters.find((chapter) => chapter.id === ids[index])!
      expect(written.content).toBe(chapters[index])
      expect(written.candidates.some((candidate) => candidate.content === chapters[index])).toBe(true)
    }
    project = (await action('review', { projectId })).project
    expect(project.checks.filter((check) => check.level === 'error')).toEqual([])
    project = await run('model-review')
    expect(project.stages.review.status).toBe('done')
    expect(mock.requests).toHaveLength(10)
    for (let number = 1; number <= 4; number += 1) {
      expect(mock.requests[8].lastUserMessageText).toContain(`正文锚点${number}`)
    }
    for (let number = 5; number <= 6; number += 1) {
      expect(mock.requests[9].lastUserMessageText).toContain(`正文锚点${number}`)
    }

    project = await run('export', { format: 'epub' })
    const book = project.deliveries.find((delivery) => delivery.kind === 'epub')!
    const projectDir = join(morrow.dataDir, 'studio', 'projects', projectId)
    const epub = await JSZip.loadAsync(readFileSync(join(projectDir, book.path)))
    expect(await epub.file('mimetype')!.async('string')).toBe('application/epub+zip')
    const pages = await Promise.all(Object.values(epub.files).filter((entry) => /\.xhtml$/.test(entry.name)).map((entry) => entry.async('string')))
    for (let number = 1; number <= 6; number += 1) expect(pages.join('\n')).toContain(`正文锚点${number}`)

    project = await run('export', { format: 'package' })
    const bundle = project.deliveries.find((delivery) => delivery.kind === 'package')!
    const imported = (await action('import-package', { path: join(projectDir, bundle.path) })).project
    expect(imported.id).not.toBe(projectId)
    expect(imported.chapters.map((chapter) => chapter.content)).toEqual(chapters)
    expect((await action('get', { projectId: imported.id })).project.chapters.map((chapter) => chapter.content)).toEqual(chapters)
  } finally {
    await morrow.close()
    await mock.close()
  }
})
}

// ── tests/e2e/demo-film.spec.ts ──────────────────────────────────────────────
{
test('@core:studio-drama 内置漫剧是 12 镜可编辑动态镜头与 1080p 成片，而不是 12 张静图', async () => {
  test.setTimeout(120_000)
  const morrow = await launchMorrow({ name: 'demo-film' })
  const page = morrow.page
  const action = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.evaluate(
      async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
      { type, payload }
    )
    if (!response.ok) throw new Error(response.error?.message || type)
    return response.data as T
  }
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    const listed = await action<{ projects: Array<{ id: string; title: string }> }>('list')
    const sample = listed.projects.find((project) => project.title === '逆行的伞')!
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })

    const project = (await action<{ project: any }>('get', { projectId: sample.id })).project
    expect(project.episodes[0]?.title).toContain('第一集')
    expect(project.shots).toHaveLength(12)
    expect(project.shots.every((shot: any) => shot.videoAssetId)).toBe(true)
    expect(new Set(project.shots.map((shot: any) => shot.videoAssetId)).size).toBe(12)
    const videoAssets = new Set(project.assets.filter((asset: any) => asset.kind === 'video').map((asset: any) => asset.id))
    expect(project.shots.every((shot: any) => videoAssets.has(shot.videoAssetId))).toBe(true)
    const videoClips = project.timeline.clips.filter((clip: any) => clip.kind === 'video')
    expect(videoClips).toHaveLength(12)
    expect(videoClips.every((clip: any) => videoAssets.has(clip.assetId) && Boolean(clip.shotId))).toBe(true)
    expect(project.timeline.durationSec).toBe(96)
    const dialogueClips = project.timeline.clips.filter((clip: any) => clip.kind === 'dialogue')
    const subtitleClips = project.timeline.clips.filter((clip: any) => clip.kind === 'subtitle')
    expect(dialogueClips).toHaveLength(7)
    expect(subtitleClips).toHaveLength(7)
    const final = project.deliveries.find((delivery: any) => delivery.kind === 'mp4')
    expect(final?.label).toContain('1080p')
    expect(final?.meta?.quality).toBe('final')
    expect(final?.meta?.resolution).toBe('1080p')
    expect(final?.meta?.timelineVersion).toBe(project.timeline.version)
    expect(project.stages.delivery.status).toBe('done')

    const monitor = page.locator('.studio-monitor-video')
    await expect(monitor).toHaveCount(1)
    const monitorMeta = await monitor.evaluate(async (element) => {
      const player = element as HTMLVideoElement
      if (player.readyState < 1) await new Promise<void>((resolve) => player.addEventListener('loadedmetadata', () => resolve(), { once: true }))
      return { width: player.videoWidth, height: player.videoHeight }
    })
    // 镜头源片由 16G 本机 H3 以 960×544 生成；交付成片再统一放大到 1920×1080。
    expect(monitorMeta.width).toBeGreaterThanOrEqual(960)
    expect(monitorMeta.height).toBeGreaterThanOrEqual(544)
    await page.locator('.studio-transport .is-play').click()
    await expect.poll(() => monitor.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(0.3)
    await page.locator('.studio-transport .is-play').click()

    await page.locator('.studio-stage-item', { hasText: '交付' }).click()
    await page.waitForSelector('.studio-delivery', { timeout: 20_000 })
    const video = page.locator('.studio-delivery-poster video')
    await expect(video).toBeVisible()
    const metadata = await video.evaluate(async (element) => {
      const player = element as HTMLVideoElement
      if (player.readyState < 1) await new Promise<void>((resolve) => player.addEventListener('loadedmetadata', () => resolve(), { once: true }))
      return { duration: player.duration, width: player.videoWidth, height: player.videoHeight }
    })
    expect(metadata.duration).toBeCloseTo(96, 0)
    expect(metadata.width).toBe(1920)
    expect(metadata.height).toBe(1080)

    // 改一处时间线参数后，旧成片必须立即过期；镜头与视频素材仍可继续编辑。
    const edited = {
      tracks: project.timeline.tracks,
      clips: project.timeline.clips.map((clip: any, index: number) => index === 0 ? { ...clip, speed: 1.2 } : clip),
      aspect: project.timeline.aspect,
      fps: project.timeline.fps
    }
    await action('save-timeline', { projectId: sample.id, timeline: edited })
    const after = (await action<{ project: any }>('get', { projectId: sample.id })).project
    expect(after.shots.every((shot: any) => shot.videoAssetId)).toBe(true)
    expect(after.timeline.clips.filter((clip: any) => clip.kind === 'video')).toHaveLength(12)
    expect(after.stages.delivery.status).toBe('stale')
  } finally {
    await morrow.close()
  }
})
}
