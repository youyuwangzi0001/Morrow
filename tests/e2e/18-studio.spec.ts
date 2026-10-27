import { expect, test } from '@playwright/test'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

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
