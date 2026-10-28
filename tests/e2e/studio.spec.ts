// studio 领域 E2E：由 7 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath, root, screensDir } from './launch'
import { dismissOnboarding, setThemeViaStore, waitUntil, createDemoSession, waitForStoreReady } from './store'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'



test.describe("18-studio", () => {
test.describe('Morrow 创作台', () => {
  test('入口、作品库、写作、分镜、时间线与交付的真实走查', async () => {
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
      await expect(page.locator('.studio-brand')).toHaveCount(0)
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
      await expect(page.locator('.studio-monitor img')).toHaveCount(1)
      await expect(page.locator('.studio-clip').first()).toBeVisible()
      await expect(page.locator('.studio-stage-item')).toHaveCount(9)
      const timelineText = await page.locator('.studio-timeline-view').innerText()
      expect(timelineText).toContain('字幕')
      expect(timelineText).toContain('fps')
      expect(timelineText).toContain('拖中间改位置')
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

      // 交付页：真实样例草稿可播放
      await page.locator('.studio-stage-item').nth(8).click()
      await page.waitForSelector('.studio-delivery', { timeout: 15_000 })
      await expect(page.locator('.studio-delivery-poster video')).toBeVisible()
      await expect(page.locator('.studio-delivery-rows .studio-delivery-row').first()).toBeVisible()
      // 交付页保留常用格式术语，同时给出可见用途说明和推荐设置。
      await expect(page.getByRole('radio', { name: '草稿' })).toBeVisible()
      await expect(page.getByRole('radio', { name: '成片' })).toBeVisible()
      await expect(page.getByRole('radio', { name: '画面内字幕' })).toBeVisible()
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
      await expect(reviewTools).toContainText('系统声线')
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
test('自动推进在确认后排入补齐与草稿合成任务', async () => {
  test.setTimeout(240_000)
  const morrow = await launchMorrow({ name: 'studio-pipeline' })
  const page = morrow.page
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
    await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await page.locator('.studio-stage-item', { hasText: '检查' }).click()
    await page.waitForSelector('.studio-review', { timeout: 20_000 })

    await page.getByRole('button', { name: '自动补齐并合成草稿' }).click()
    const dialog = page.getByRole('dialog', { name: '自动推进到草稿' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('合成一版可审看的草稿')
    await dialog.getByRole('button', { name: '开始补齐并合成' }).click()

    const pipelineRow = page.locator('.studio-receipt-row', { hasText: '自动推进 · 装配并合成草稿' }).first()
    await expect(pipelineRow).toBeVisible({ timeout: 30_000 })
    const renderRow = page.locator('.studio-receipt-row', { hasText: '合成动态分镜草稿' }).first()
    await expect(renderRow).toBeVisible({ timeout: 60_000 })
    await page.screenshot({ path: screenshotPath('studio-auto-pipeline-dark.png') })
  } finally {
    await morrow.close()
  }
})
})


test.describe("19-studio-ux", () => {
test.describe('创作台 · 首次指引、演示与灵动岛', () => {
  test('首次进入指引、随时观看的演示、无斜体、关于页与灵动岛真实状态', async () => {
    test.setTimeout(180_000)
    const morrow = await launchMorrow({ name: 'studio-ux', env: { MORROW_ISLAND: '1' } })
    const page = morrow.page
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await expect(page.locator('.welcome-studio')).toHaveCount(0)
      await expect(page.locator('.tb-create')).toBeVisible()
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      const guide = page.locator('.studio-guide')
      await expect(guide).toBeVisible({ timeout: 15_000 })
      await expect(guide.locator('.studio-guide-brand img')).toHaveJSProperty('complete', true)
      expect(await guide.locator('.studio-guide-brand img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
      await expect(guide).toContainText('创作台')
      await page.screenshot({ path: screenshotPath('studio-guide-dark.png') })
      await guide.getByRole('button', { name: '下一步' }).click()
      await guide.getByRole('button', { name: '下一步' }).click()
      await page.evaluate(() => localStorage.setItem('morrow.studio-demo.speed', '1'))
      await guide.getByRole('button', { name: '看演示' }).click()
      const demo = page.locator('.studio-demo')
      await expect(demo).toBeVisible({ timeout: 15_000 })
      await expect(demo).toContainText('制作流程演示')
      await expect(demo).toContainText('一句话')
      await expect(demo).toContainText('00:40')
      await expect(demo).toHaveAttribute('data-act', 'brief')
      // 线性播放：没有上一步/下一步，只能暂停、重播或关闭
      await expect(demo.locator('.studio-demo-next')).toHaveCount(0)
      await expect(demo.locator('.studio-demo-prev')).toHaveCount(0)
      // 第一幕的整句文案必须完整出现（不能只显示第一行），等拆解与选项动画完成后再截图
      await expect(page.locator('.sd-logline')).toContainText('就会失去一段记忆', { timeout: 10_000 })
      await page.waitForTimeout(3000)
      await page.locator('.studio-demo-play').click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: screenshotPath('studio-demo-dark.png') })

      // 暂停后时间与步骤都不再前进
      await page.waitForTimeout(400)
      const pausedClock = await page.locator('.sd-time').innerText()
      await page.waitForTimeout(1200)
      await expect(demo).toHaveAttribute('data-act', 'brief')
      expect(await page.locator('.sd-time').innerText()).toBe(pausedClock)
      await page.locator('.studio-demo-play').click()
      await page.keyboard.press('Escape')
      await expect(demo).toHaveCount(0)
      await expect(page.locator('.studio-home')).toBeVisible()
      await expect(page.locator('.studio-home-utility')).toHaveCount(2)
      await page.screenshot({ path: screenshotPath('studio-home-dark.png') })

      // 加速走完整段影片，确认六幕连续播完；关闭后回到作品库
      await page.evaluate(() => localStorage.setItem('morrow.studio-demo.speed', '10'))
      await page.locator('.studio-home-utility', { hasText: '看演示' }).click()
      await expect(page.locator('.sd-end')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.sd-end')).toContainText('《逆行的伞》已经躺在创作台里')
      await page.keyboard.press('Escape')
      await expect(page.locator('.studio-demo')).toHaveCount(0)
      await expect(page.locator('.studio-home')).toBeVisible()
      await page.locator('.studio-home-utility', { hasText: '看演示' }).click()
      await expect(page.locator('.studio-demo')).toBeVisible()
      await page.locator('.studio-demo-close').click()
      await expect(page.locator('.studio-demo')).toHaveCount(0)

      // 第一次进入的指引可以再次打开
      await page.locator('.studio-home-utility', { hasText: '使用指引' }).click()
      await expect(page.locator('.studio-guide')).toBeVisible()
      await page.locator('.studio-guide-skip').click()
      await expect(page.locator('.studio-guide')).toHaveCount(0)

      // 创作台内没有产品标题/图标；全应用不使用斜体
      await expect(page.locator('.studio-brand')).toHaveCount(0)
      await expect(page.locator('.studio-topbar img.studio-mark')).toHaveCount(0)
      await expect(page.locator('.studio-root')).not.toContainText('创作台')
      const italics = await page.evaluate(() =>
        Array.from(document.querySelectorAll('em, i, cite, dfn, var'))
          .map((element) => getComputedStyle(element).fontStyle)
          .filter((style) => style !== 'normal')
      )
      expect(italics).toEqual([])

      // 灵动岛跟随创作台，而不是空的 Agent 会话
      const island = await page.evaluate(async () => {
        const response = await window.morrow.island.snapshot()
        return response.ok ? response.data : null
      })
      expect(island?.mode).toBe('studio')
      expect(island?.studioProjectTitle).toBe('作品库')

      // 灵动岛创作台主按钮：真实点击 + 统一的微圆角实心矩形。
      const islandPage = morrow.app.windows().find((candidate) => candidate.url().includes('#island'))
      expect(islandPage).toBeTruthy()
      if (!(await islandPage!.locator('.island-panel').count())) {
        const chevron = islandPage!.locator('.island-chevron')
        if (await chevron.isVisible().catch(() => false)) await chevron.click()
      }
      await expect(islandPage!.locator('.island-panel')).toBeVisible({ timeout: 15_000 })
      const openStudio = islandPage!.locator('.island-panel-foot').getByRole('button', { name: '打开创作台' })
      await expect(openStudio).toBeVisible()
      const studioButton = await openStudio.evaluate((element) => {
        const style = getComputedStyle(element)
        return { radius: style.borderRadius, background: style.backgroundColor, border: style.borderStyle }
      })
      expect(parseFloat(studioButton.radius)).toBeLessThanOrEqual(6)
      expect(studioButton.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(studioButton.border).toBe('solid')
      await islandPage!.screenshot({ path: screenshotPath('studio-island-studio-dark.png') })

      // 灵动岛“回到 Agent”必须点击真实按钮退出创作台，而不只是聚焦主窗口。
      await islandPage!.locator('.island-panel-foot').getByRole('button', { name: '回到 Agent' }).click()
      await expect(page.locator('.studio-root')).toHaveCount(0, { timeout: 15_000 })
      await expect(page.locator('.sidebar')).toBeVisible()
      const afterReturn = await page.evaluate(async () => {
        const response = await window.morrow.island.snapshot()
        return response.ok ? response.data : null
      })
      expect(afterReturn?.mode).not.toBe('studio')

      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      await morrow.close()
    }
  })

  test('导出任务会在灵动岛显示真实进度与完成状态', async () => {
    test.setTimeout(120_000)
    const morrow = await launchMorrow({ name: 'studio-island-job' })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
      await page.waitForTimeout(600)
      const list = await page.evaluate(async () => {
        const response = await window.morrow.features.invoke('feature:studio:action', { type: 'list' })
        return response.ok ? response.data : null
      })
      const project = list?.projects?.find((item: { title: string }) => item.title === '雨伞铺的第七个夏天')
      expect(project?.id).toBeTruthy()
      await page.locator('.studio-project-card', { hasText: '雨伞铺的第七个夏天' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      await page.evaluate(async (projectId: string) => {
        const response = await window.morrow.features.invoke('feature:studio:action', { type: 'export', projectId, format: 'txt' })
        if (!response.ok) throw new Error(response.error?.message)
      }, project.id)
      await waitUntil(
        async () => {
          const response = await page.evaluate(async () => {
            const snapshot = await window.morrow.island.snapshot()
            return snapshot.ok ? snapshot.data : null
          })
          return response?.mode === 'studio' && Boolean(response.studioJobLabel)
        },
        20_000,
        '灵动岛显示创作台任务'
      )
      const island = await page.evaluate(async () => {
        const response = await window.morrow.island.snapshot()
        return response.ok ? response.data : null
      })
      expect(island?.studioProjectTitle).toBe('雨伞铺的第七个夏天')
      expect(island?.studioJobActive || island?.status === 'done').toBe(true)
    } finally {
      await morrow.close()
    }
  })
})
})


test.describe("20-studio-workspace", () => {
test('漫剧画布：镜头、音频、文本节点与连线可编辑并持久化', async () => {
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
test('人物语气审稿、完整任务消息流与真实波形', async () => {
  test.setTimeout(240_000)
  const morrow = await launchMorrow({ name: 'insights' })
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

    await page.locator('.studio-stage-item', { hasText: '检查' }).click()
    await page.waitForSelector('.studio-review', { timeout: 20_000 })
    await page.getByRole('button', { name: /运行人物语气审稿|开始审稿/ }).first().click()
    await expect(page.locator('.studio-voice-profile').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.studio-voice-summary')).toContainText('句可归属台词')
    const audit = await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      return response.ok ? { profiles: response.data.project.voiceAudit.profiles.length, checks: response.data.project.checks.filter((item: any) => item.kind === 'voice').length } : null
    }, target.id)
    expect(audit?.profiles ?? 0).toBeGreaterThan(0)
    expect(audit?.checks ?? 0).toBeGreaterThan(0)
    await page.screenshot({ path: screenshotPath('studio-voice-audit-dark.png') })

    const queued = await page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', {
        type: 'generate-music',
        projectId,
        kind: 'music',
        engine: 'local',
        mood: 'rain',
        seconds: 8
      })
      return response.ok ? response.data.job.id : null
    }, target.id)
    expect(queued).toBeTruthy()
    await expect.poll(async () => page.evaluate(async (projectId: string) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      const job = response.ok ? response.data.project.jobs.find((item: any) => item.kind === 'music') : null
      return job?.status ?? ''
    }, target.id), { timeout: 90_000 }).toBe('done')

    expect(await page.locator('.studio-receipt-row').count()).toBeGreaterThan(0)
    const musicRow = page.locator('.studio-receipt-row', { hasText: '配乐' }).first()
    await musicRow.locator('.studio-receipt-events-toggle').click()
    await expect(musicRow.locator('.studio-receipt-events')).toBeVisible()
    await expect(musicRow.locator('.studio-receipt-events')).toContainText('开始执行')
    await expect(musicRow.locator('.studio-receipt-events')).toContainText('完成')

    await page.locator('.studio-stage-item', { hasText: '时间线' }).click()
    await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    await expect.poll(async () => page.locator('.studio-waveform i').count(), { timeout: 30_000 }).toBeGreaterThan(0)
    await page.screenshot({ path: screenshotPath('studio-timeline-waveform-dark.png') })

    // 导入真实视频并生成 540p 代理，验证预览链路。
    const proxy = await page.evaluate(async ({ projectId, videoPath }) => {
      const imported = await window.morrow.features.invoke('feature:studio:action', {
        type: 'import-asset',
        projectId,
        path: videoPath
      })
      if (!imported.ok) return { error: imported.error }
      const video = imported.data.project.assets.find((item: any) => item.kind === 'video')
      if (!video) return { error: 'no video asset' }
      const result = await window.morrow.features.invoke('feature:studio:action', { type: 'asset-proxy', projectId, assetId: video.id })
      return result.ok ? { ready: result.data.ready, url: result.data.url } : { error: result.error }
    }, { projectId: target.id as string, videoPath: join(root, 'resources', 'studio-demo', 'demo-draft.mp4') })
    expect(proxy.error ?? '').toBe('')
    expect(proxy.ready).toBe(true)
    expect(proxy.url).toContain('morrow-file://preview/')

    expect(errors, errors.join('\n')).toEqual([])
  } finally {
    await morrow.close()
  }
})
})


test.describe("21-studio-responsive", () => {
})


test.describe("27-studio-samples", () => {
test('三份内置样例都可继续创作，短篇手改能保存', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'studio-samples' })
  const page = morrow.page
  try {
    await dismissOnboarding(page)
    await page.locator('.tb-create').click()
    await page.waitForSelector('.studio-home', { timeout: 30_000 })
    if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()

    const data = await page.evaluate(async () => {
      const call = async (type: string, payload: Record<string, unknown> = {}) => {
        const response = await window.morrow.features.invoke('feature:studio:action', { type, ...payload })
        if (!response.ok) throw new Error(response.error?.message || type)
        return response.data
      }
      const list = await call('list') as { projects: Array<{ id: string; title: string; kind: string }> }
      const details: Array<Record<string, unknown>> = []
      for (const summary of list.projects.filter((item) => item.title === '雨停之前' || item.title === '雨伞铺的第七个夏天' || item.title === '逆行的伞')) {
        const result = await call('get', { projectId: summary.id }) as { project: any }
        details.push({
          id: result.project.id,
          title: result.project.title,
          kind: result.project.kind,
          source: result.project.blueprint?.source,
          chapters: result.project.chapters.length,
          written: result.project.chapters.filter((chapter: any) => chapter.content.trim()).length,
          shots: result.project.shots.length,
          firstChapter: result.project.chapters[0]?.content?.slice(0, 40) ?? '',
          firstPrompt: result.project.shots[0]?.prompt?.slice(0, 40) ?? ''
        })
      }
      return { count: list.projects.filter((item) => item.title === '雨停之前' || item.title === '雨伞铺的第七个夏天' || item.title === '逆行的伞').length, details }
    })
    expect(data.count).toBe(3)
    const short = data.details.find((item) => item.title === '雨停之前') as any
    const novel = data.details.find((item) => item.title === '雨伞铺的第七个夏天') as any
    const drama = data.details.find((item) => item.title === '逆行的伞') as any
    expect(short).toMatchObject({ kind: 'short', source: 'import', chapters: 12, written: 12 })
    expect(short.firstChapter.length).toBeGreaterThan(10)
    expect(novel).toMatchObject({ kind: 'novel', source: 'import', chapters: 36, written: 7 })
    expect(drama).toMatchObject({ kind: 'drama', source: 'import', shots: 12 })
    expect(drama.firstPrompt.length).toBeGreaterThan(10)

    await page.locator('.studio-project-card', { hasText: '雨停之前' }).first().locator('.studio-project-cover').click()
    await page.waitForSelector('.studio-center', { timeout: 30_000 })
    if (!(await page.locator('.studio-writing').count())) {
      await page.locator('.studio-stage-item', { hasText: '写作' }).click()
    }
    await page.waitForSelector('.studio-writing', { timeout: 20_000 })
    const editor = page.locator('.studio-manuscript .cm-content')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('样例还能继续写。')
    await page.waitForTimeout(1800)
    await expect(page.locator('.studio-save-state')).toContainText('已保存', { timeout: 15_000 })

    const saved = await page.evaluate(async (projectId) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: 'get', projectId })
      if (!response.ok) return false
      return (response.data as { project: { chapters: Array<{ content: string }> } }).project.chapters.some((chapter) => chapter.content.includes('样例还能继续写。'))
    }, short.id)
    expect(saved).toBe(true)
  } finally {
    await morrow.close()
  }
})
})


test.describe("28-studio-trash", () => {
test('删除作品后在创作台设置回收站可恢复与彻底删除', async () => {
  test.setTimeout(180_000)
  const outDir = join(screensDir, 'matrix')
  mkdirSync(outDir, { recursive: true })
  const morrow = await launchMorrow({ name: 'studio-trash' })
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
    const title = `回收站测试 ${Date.now()}`
    const created = await action<{ project: { id: string } }>('create', {
      kind: 'short',
      title,
      logline: '一部只用来验证回收站的作品',
      form: '速成草稿',
      genre: '',
      audience: '',
      tone: '',
      aspect: '16:9'
    })
    const projectId = created.project.id
    await action('delete', { projectId })
    const afterDelete = await action<{ projects: Array<{ id: string }> }>('list')
    expect(afterDelete.projects.some((project) => project.id === projectId)).toBe(false)

    await page.locator('button[aria-label="创作台设置"]').click()
    await expect(page.getByRole('dialog', { name: '创作台设置' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('tab', { name: '回收站' }).click()
    await page.waitForSelector('.studio-trash', { timeout: 10_000 })
    await expect(page.locator('.studio-trash')).toContainText(title)
    await expect(page.locator('.studio-settings-head p')).toHaveCount(1)
    expect(await page.locator('.studio-trash .studio-settings-hint').count(), '回收站说明只保留页头一行').toBe(0)
    await page.screenshot({ path: join(outDir, 'studio-trash-settings.png') })
    await page.getByRole('button', { name: '恢复', exact: true }).first().click()
    await expect(page.locator('.studio-trash')).not.toContainText(title)
    await page.getByRole('dialog', { name: '创作台设置' }).locator('.studio-modal-footer').getByRole('button', { name: '关闭' }).click()
    await page.waitForTimeout(600)
    await expect(page.locator('.studio-project-card', { hasText: title })).toHaveCount(1)

    await action('delete', { projectId })
    await page.locator('button[aria-label="创作台设置"]').click()
    await page.getByRole('tab', { name: '回收站' }).click()
    await page.waitForSelector('.studio-trash', { timeout: 10_000 })
    await expect(page.locator('.studio-trash')).toContainText(title)
    await page.getByRole('button', { name: '彻底删除', exact: true }).first().click()
    await expect(page.getByRole('dialog', { name: '彻底删除这部作品？' })).toBeVisible()
    await page.getByRole('button', { name: '彻底删除', exact: true }).last().click()
    await expect(page.locator('.studio-trash')).not.toContainText(title)
    const list = await action<{ projects: Array<{ id: string }> }>('list')
    expect(list.projects.some((project) => project.id === projectId)).toBe(false)
  } finally {
    await morrow.close()
  }
})
})


test.describe("29-writing-desk", () => {
test('写作台具备查找替换、撤销、排版、字数与 Word 导出', async () => {
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

    await page.getByRole('button', { name: '查找与替换' }).click()
    await page.getByLabel('查找正文').fill('雨')
    await expect(page.locator('.studio-find-count')).not.toHaveText('—')
    await page.getByLabel('替换为').fill('春雨')
    await page.getByRole('button', { name: '全部替换', exact: true }).click()
    await page.waitForTimeout(300)
    const replaced = await page.locator('.studio-manuscript .cm-content').innerText()
    expect(replaced).toContain('春雨')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await page.waitForTimeout(400)
    const afterUndo = await page.locator('.studio-manuscript .cm-content').innerText()
    expect(afterUndo).not.toContain('春雨')
    expect(afterUndo).toContain('修到一半')

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

test.describe('demo-enter-sample', () => {
  test('演示结束后可以在创作台打开样例', async () => {
    test.setTimeout(120_000)
    const morrow = await launchMorrow({ name: 'studio-demo-cta', timeoutMs: 90_000 })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
      await page.evaluate(() => localStorage.setItem('morrow.studio-demo.speed', '10'))
      await page.locator('.studio-home-utility', { hasText: '看演示' }).click()
      await expect(page.locator('.sd-end')).toBeVisible({ timeout: 20_000 })
      await page.locator('.sd-open-sample').click()
      await expect(page.locator('.studio-timeline-view')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.studio-demo')).toHaveCount(0)
    } finally {
      await morrow.close()
    }
  })
})

test.describe('31-studio-layout', () => {
  test('时间线工具栏在窄中栏折叠为图标，不换行也不压住标尺', async () => {
    test.setTimeout(120_000)
    const morrow = await launchMorrow({ name: 'timeline-compact', timeoutMs: 90_000 })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await page.locator('.tb-create').click()
      await expect(page.locator('.studio-home')).toBeVisible({ timeout: 30_000 })
      if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
      await morrow.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
        win?.setContentSize(1280, 800)
      })
      await page.waitForTimeout(500)
      if (!(await page.locator('.studio-body').getAttribute('class'))?.includes('has-assistant')) {
        await page.locator('[aria-label="切换协作者面板"]').click()
        await page.waitForTimeout(400)
      }
      const metrics = await page.evaluate(() => {
        const view = document.querySelector<HTMLElement>('.studio-timeline-view')!
        const toolbar = document.querySelector<HTMLElement>('.studio-timeline-toolbar')!
        const editor = document.querySelector<HTMLElement>('.studio-timeline-editor')!
        const labels = Array.from(toolbar.querySelectorAll<HTMLElement>('.studio-toolbar-label'))
        const buttons = Array.from(toolbar.querySelectorAll<HTMLElement>('button'))
        return {
          centerWidth: view.getBoundingClientRect().width,
          toolbarHeight: toolbar.getBoundingClientRect().height,
          toolbarBottom: toolbar.getBoundingClientRect().bottom,
          editorTop: editor.getBoundingClientRect().top,
          labelsVisible: labels.filter((label) => getComputedStyle(label).display !== 'none').length,
          wrapped: buttons
            .filter((button) => button.scrollHeight > button.clientHeight + 1 || button.scrollWidth > button.clientWidth + 1)
            .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
        }
      })
      expect(metrics.centerWidth).toBeLessThan(760)
      expect(metrics.toolbarHeight).toBe(34)
      expect(metrics.toolbarBottom).toBeLessThanOrEqual(metrics.editorTop + 1)
      expect(metrics.labelsVisible).toBe(0)
      expect(metrics.wrapped).toEqual([])
      await page.screenshot({ path: screenshotPath('studio-timeline-compact.png') })
    } finally {
      await morrow.close()
    }
  })

  test('画布、交付与检查页在窄窗口不转行、不遮挡播放控件', async () => {
    test.setTimeout(150_000)
    const morrow = await launchMorrow({ name: 'studio-layout-pages', timeoutMs: 90_000 })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await page.locator('.tb-create').click()
      await expect(page.locator('.studio-home')).toBeVisible({ timeout: 30_000 })
      if (await page.locator('.studio-guide').isVisible()) await page.locator('.studio-guide-skip').click()
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })
      await morrow.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#island'))
        win?.setContentSize(1360, 960)
      })
      await page.waitForTimeout(500)

      await page.getByRole('button', { name: '画布', exact: true }).click()
      await page.waitForSelector('.studio-canvas-view', { timeout: 20_000 })
      const canvas = await page.evaluate(() => {
        const actions = document.querySelector<HTMLElement>('.studio-canvas-actions')!
        const buttons = Array.from(actions.querySelectorAll<HTMLElement>('button'))
        return {
          rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
          wrapped: buttons.filter((button) => button.scrollHeight > button.clientHeight + 1).length
        }
      })
      expect(canvas).toEqual({ rows: 1, wrapped: 0 })
      await page.screenshot({ path: screenshotPath('studio-canvas-compact.png') })
      await page.locator('.studio-canvas-action', { hasText: '时间线' }).click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })

      await page.locator('.studio-stage-item', { hasText: '交付' }).click()
      await page.waitForSelector('.studio-delivery-poster video', { timeout: 20_000 })
      const player = await page.evaluate(() => {
        const poster = document.querySelector<HTMLElement>('.studio-delivery-poster')!
        const video = poster.querySelector<HTMLElement>('video')!
        const overlay = poster.querySelector<HTMLElement>('.studio-delivery-poster-overlay')!
        return {
          posterBottom: poster.getBoundingClientRect().bottom,
          posterHeight: poster.getBoundingClientRect().height,
          videoBottom: video.getBoundingClientRect().bottom,
          videoHeight: video.getBoundingClientRect().height,
          overlayBottom: overlay.getBoundingClientRect().bottom
        }
      })
      expect(player.videoBottom).toBeLessThanOrEqual(player.posterBottom + 1)
      expect(player.videoHeight).toBeGreaterThanOrEqual(player.posterHeight - 2)
      expect(player.overlayBottom).toBeLessThan(player.videoBottom - 40)
      await page.screenshot({ path: screenshotPath('studio-delivery-player.png') })

      await page.locator('.studio-stage-item', { hasText: '检查' }).click()
      await page.waitForSelector('.studio-review-foot', { timeout: 20_000 })
      const footer = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll<HTMLElement>('.studio-review-foot span'))
        return spans.map((span) => ({
          height: Math.round(span.getBoundingClientRect().height),
          whiteSpace: getComputedStyle(span).whiteSpace
        }))
      })
      expect(footer).toHaveLength(3)
      for (const item of footer) {
        expect(item.height).toBeLessThanOrEqual(30)
        expect(item.whiteSpace).toBe('nowrap')
      }
    } finally {
      await morrow.close()
    }
  })
})
