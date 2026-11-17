// 分镜板滚动：滚动条落在主区域右缘（详情面板左侧），只滚分镜内容；
// 头部工具条与右侧镜头详情留在原位，滚到底部时详情面板不出现空白。
//
// 出现过的缺陷：整个 .studio-storyboard 当滚动容器，滚到下面时头部被滚出视口，
// 绝对定位的镜头详情也跟着内容上移，面板底部露出大片空白。
import { launchMorrow, dismissOnboarding, screenshotPath } from './helpers'
import { expect, test } from '@playwright/test'

test.describe('分镜板滚动', () => {
  test('@core:studio-timeline 只有主区域滚动，头部与右侧镜头详情保持原位', async () => {
    const morrow = await launchMorrow({ name: 'board-scroll' })
    const page = morrow.page
    try {
      await page.waitForSelector('.titlebar', { timeout: 30_000 })
      await dismissOnboarding(page)
      await page.locator('.tb-create').click()
      await page.waitForSelector('.studio-home', { timeout: 30_000 })
      await page.locator('.studio-guide-skip').click()
      await page.waitForTimeout(800)
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 20_000 })

      // 进分镜板并选中一镜，打开右侧镜头详情
      await page.locator('.studio-stage-item').nth(2).click()
      await page.waitForSelector('.studio-shot-card', { timeout: 15_000 })
      await page.locator('.studio-shot-card').first().click()
      await expect(page.locator('.studio-shot-inspector')).toBeVisible()
      await page.waitForTimeout(300)

      const snapshot = () =>
        page.evaluate(() => {
          const board = document.querySelector('.studio-storyboard') as HTMLElement
          const head = document.querySelector('.studio-storyboard-head') as HTMLElement
          const panel = document.querySelector('.studio-shot-inspector') as HTMLElement
          const scroller = document.querySelector('.studio-board-scroll') as HTMLElement
          const panelInner = document.querySelector('.studio-inspector-scroll') as HTMLElement
          const firstField = panel.querySelector('.studio-field') as HTMLElement
          const b = board.getBoundingClientRect()
          const s = scroller.getBoundingClientRect()
          const p = panel.getBoundingClientRect()
          return {
            boardOverflow: getComputedStyle(board).overflowY,
            boardScrollable: board.scrollHeight > board.clientHeight + 1,
            scrollerOverflow: getComputedStyle(scroller).overflowY,
            scrollerGutter: scroller.offsetWidth - scroller.clientWidth,
            scrollerScrollable: scroller.scrollHeight > scroller.clientHeight,
            scrollerRight: Math.round(s.right),
            panelLeft: Math.round(p.left),
            panelInnerScrollable: panelInner.scrollHeight > panelInner.clientHeight,
            boardTop: Math.round(b.top),
            boardBottom: Math.round(b.bottom),
            boardHeight: Math.round(b.height),
            headTop: Math.round(head.getBoundingClientRect().top),
            panelTop: Math.round(p.top),
            panelBottomGap: Math.round(b.bottom - p.bottom),
            firstFieldTop: Math.round(firstField.getBoundingClientRect().top),
          }
        })

      const before = await snapshot()
      // 主区域才是滚动容器：整块分镜板不滚，否则头部与详情面板会跟着走
      expect(before.boardOverflow).toBe('hidden')
      expect(before.boardScrollable).toBe(false)
      expect(before.scrollerOverflow).toBe('auto')
      expect(before.scrollerScrollable).toBe(true)
      // 滚动条槽位紧贴详情面板左缘：条落在主区域右缘，而不是被面板盖住或跑到窗口最右
      expect(before.scrollerGutter).toBeGreaterThan(0)
      expect(Math.abs(before.scrollerRight - before.panelLeft)).toBeLessThanOrEqual(1)

      // 滚到底：只有分镜内容移动，头部与详情面板原地不动
      const scrolled = await page.locator('.studio-board-scroll').evaluate((element) => {
        element.scrollTop = element.scrollHeight
        return element.scrollTop
      })
      expect(scrolled).toBeGreaterThan(200)
      await page.waitForTimeout(300)

      const after = await snapshot()
      expect(after.headTop).toBe(before.headTop)
      expect(after.panelTop).toBe(before.panelTop)
      expect(after.firstFieldTop).toBe(before.firstFieldTop)
      expect(after.boardTop).toBe(before.boardTop)
      // 详情面板始终与主区域等高、底边齐平：滚到底部也不留空白
      expect(after.boardHeight).toBe(before.boardHeight)
      expect(Math.abs(after.panelBottomGap)).toBeLessThanOrEqual(1)
      // 右侧详情面板自己的滚动条照旧可用
      expect(after.panelInnerScrollable).toBe(true)

      await page.screenshot({ path: screenshotPath('studio-board-scroll-bottom-dark.png') })

      // 剧本页同样只滚主区域（剧本内容自己滚，整块分镜板不跟着滚）
      await page.locator('.studio-tab-switch').getByRole('button', { name: '剧本' }).click()
      await page.waitForSelector('.studio-script', { timeout: 10_000 })
      const script = await page.evaluate(() => {
        const board = document.querySelector('.studio-storyboard') as HTMLElement
        const scriptArea = document.querySelector('.studio-script') as HTMLElement
        return {
          boardOverflow: getComputedStyle(board).overflowY,
          scriptOverflow: getComputedStyle(scriptArea).overflowY,
          scriptScrollable: scriptArea.scrollHeight > scriptArea.clientHeight,
        }
      })
      expect(script.boardOverflow).toBe('hidden')
      expect(script.scriptOverflow).toBe('auto')
      expect(script.scriptScrollable).toBe(true)
    } finally {
      await morrow.close()
    }
  })
})