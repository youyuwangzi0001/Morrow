/**
 * Token 活动：真实 usage 落账 → 马赛克热力图 → 日/周/累计切换与悬浮详情。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchMorrow, root, screenshotPath, type MorrowApp } from './launch'
import { startMockLLM } from '../fixtures/mock-llm.mjs'
import {
  configureMockProvider,
  createSession,
  dismissOnboarding,
  installEventCollector,
  sendMessageViaStore,
  waitForRunFinished,
  waitForStoreReady,
  waitUntil
} from './store'

function makeDir(prefix: string): string {
  return join(root, 'tmp', `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
}

function nextDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

test.describe('Token 活动', () => {
  let morrow: MorrowApp

  test.afterEach(async () => {
    await morrow?.close()
  })

  test('真实 usage 入账，马赛克视图可切换并显示悬浮详情', async () => {
    test.setTimeout(120_000)
    const workspace = makeDir('token-activity-ws')
    mkdirSync(workspace, { recursive: true })
    const mock = await startMockLLM({ scripts: [{ text: '收到了，这是 Token 统计测试回复。' }] })
    morrow = await launchMorrow({ name: 'token-activity', timeoutMs: 90_000 })
    try {
      const { page } = morrow
      await waitForStoreReady(page)
      await dismissOnboarding(page)
      const provider = await configureMockProvider(page, mock.openaiBaseUrl)
      await createSession(page, {
        workspace,
        ...provider,
        permissionMode: 'auto',
        title: 'Token 活动测试'
      })
      await installEventCollector(page)
      await sendMessageViaStore(page, '请回复一句用于 Token 统计的话。')
      await waitForRunFinished(page, 60_000)

      const ledger = join(morrow.dataDir, 'usage', 'token-activity.json')
      await waitUntil(async () => existsSync(ledger), 10_000, 'Token 账本落盘')
      const summary = await waitUntil(
        async () => {
          const result = await page.evaluate(async () => window.morrow.tokenActivity.get())
          return result.ok && result.data.total > 0 ? result.data : null
        },
        10_000,
        'Token 活动有真实记录'
      )
      expect(summary.total).toBeGreaterThan(0)
      expect(summary.today).toBeGreaterThan(0)

      await page.keyboard.press('Control+,')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ state: 'visible' })
      await settings.getByRole('tab', { name: '用量' }).click()
      await expect(page.locator('.token-activity-title')).toHaveText('Token 活动')

      const mosaic = page.locator('.token-mosaic')
      const dailyCells = page.locator('.token-mosaic .token-cell')
      await expect(page.locator('.token-mosaic .token-cell:not(.is-outside)').first()).toBeVisible({ timeout: 10_000 })
      await expect(mosaic).toHaveAttribute('data-mode', 'day')
      expect(await dailyCells.count()).toBeGreaterThanOrEqual(365)
      // 每列一周：同一列从上到下必须是连续日期，且方块行号与星期几严格对应
      await expect(page.locator('.token-weekday')).toHaveText(['一', '二', '三', '四', '五', '六', '日'])
      const layout = await page.$$eval('.token-mosaic .token-cell:not(.is-outside)', (cells) =>
        cells.map((cell) => {
          const element = cell as HTMLElement
          return {
            date: element.dataset.date ?? '',
            weekday: Number(element.dataset.weekday),
            column: Number(element.style.gridColumn),
            row: Number(element.style.gridRow)
          }
        })
      )
      expect(layout.length).toBe(summary.days.length)
      expect(layout.length).toBe(365)
      const byColumn = new Map<number, typeof layout>()
      for (const cell of layout) {
        byColumn.set(cell.column, [...(byColumn.get(cell.column) ?? []), cell])
      }
      const columnKeys = [...byColumn.keys()].sort((a, b) => a - b)
      expect(columnKeys[0]).toBe(2)
      for (let index = 1; index < columnKeys.length; index += 1) {
        expect(columnKeys[index]).toBe(columnKeys[index - 1] + 1)
      }
      for (const items of byColumn.values()) {
        const sorted = [...items].sort((a, b) => a.row - b.row)
        for (let index = 0; index < sorted.length; index += 1) {
          const cell = sorted[index]
          const jsDay = new Date(`${cell.date}T00:00:00`).getDay()
          const expectedWeekday = jsDay === 0 ? 7 : jsDay
          expect(cell.weekday).toBe(expectedWeekday)
          expect(cell.row).toBe(expectedWeekday)
          if (index > 0) {
            expect(cell.row).toBe(sorted[index - 1].row + 1)
            expect(cell.date).toBe(nextDay(sorted[index - 1].date))
          }
        }
      }
      expect(new Date(`${layout[0].date}T00:00:00`).getTime()).toBeLessThan(
        new Date(`${layout[layout.length - 1].date}T00:00:00`).getTime()
      )

      // 月份标签：钉在「该月 1 日所在的那一列」，文字不重叠，且至少间隔 3 列
      const labels = await page.$$eval('.token-month-label', (nodes) =>
        nodes.map((node) => {
          const element = node as HTMLElement
          const column = Number(element.style.gridColumn)
          const rect = element.getBoundingClientRect()
          const cell = [...document.querySelectorAll('.token-mosaic .token-cell')].find(
            (candidate) => Number((candidate as HTMLElement).style.gridColumn) === column
          ) as HTMLElement | undefined
          return {
            text: element.textContent ?? '',
            column,
            left: rect.left,
            right: rect.right,
            columnLeft: cell?.getBoundingClientRect().left ?? null
          }
        })
      )
      expect(labels.length).toBeGreaterThanOrEqual(11)
      const firstDay = new Date(`${layout[0].date}T00:00:00`)
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index]
        const month = Number(label.text.replace('月', ''))
        const isStartLabel = index === 0 && label.column === 2 && month === firstDay.getMonth() + 1
        if (!isStartLabel) {
          const week = layout.filter((cell) => cell.column === label.column)
          const anchored = week.some((cell) => {
            const date = new Date(`${cell.date}T00:00:00`)
            return date.getDate() === 1 && date.getMonth() + 1 === month
          })
          expect(anchored, `${label.text} 应锚定在包含该月 1 日的那一列`).toBe(true)
        }
        if (index > 0) {
          expect(label.column).toBeGreaterThanOrEqual(labels[index - 1].column + 3)
          expect(label.left).toBeGreaterThan(labels[index - 1].right + 2)
        }
        if (label.column !== columnKeys[columnKeys.length - 1]) {
          expect(label.columnLeft).not.toBeNull()
          expect(Math.abs(label.left - (label.columnLeft ?? 0))).toBeLessThanOrEqual(1)
        }
      }
      await expect(page.locator('.token-activity-stats')).toContainText('今天')
      await expect(page.locator('.token-mode-note')).toContainText('每列一周（周一→周日）')
      await page.mouse.move(0, 0)
      await page.waitForTimeout(120)
      await page.locator('.token-activity').screenshot({ path: screenshotPath('token-activity-heatmap-dark.png') })

      const dailyCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').first()
      await expect(dailyCell).toBeVisible()
      await dailyCell.hover()
      await page.waitForTimeout(120)
      await dailyCell.hover()
      await expect(page.locator('.token-tooltip')).toBeVisible()
      await expect(page.locator('.token-tooltip')).toContainText('tokens')
      await page.screenshot({ path: screenshotPath('token-activity-daily.png') })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __morrowStore: { getState: () => { setTheme: (value: string) => void } }
        }).__morrowStore
        store.getState().setTheme('light')
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await page.waitForTimeout(260)
      await page.screenshot({ path: screenshotPath('token-activity-daily-light.png') })
      await page.evaluate(() => {
        const store = (window as unknown as {
          __morrowStore: { getState: () => { setTheme: (value: string) => void } }
        }).__morrowStore
        store.getState().setTheme('dark')
      })

      // 每周：仍然是 365 个日格，格子与悬浮显示所在周合计
      await settings.getByRole('tab', { name: '每周' }).click()
      await expect(mosaic).toHaveAttribute('data-mode', 'week')
      expect(await page.locator('.token-mosaic .token-cell').count()).toBeGreaterThanOrEqual(365)
      await expect(page.locator('.token-month-label').first()).toBeVisible()
      await expect(page.locator('.token-mode-note')).toContainText('所在自然周的合计')
      const weekCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').first()
      await expect(weekCell).toBeVisible()
      await weekCell.hover()
      await expect(page.locator('.token-tooltip')).toContainText('该周合计')
      await page.screenshot({ path: screenshotPath('token-activity-weekly.png') })

      // 累计：仍然是 365 个日格，格子与悬浮显示截至当天的历史累计
      await settings.getByRole('tab', { name: '累计总量' }).click()
      await expect(mosaic).toHaveAttribute('data-mode', 'total')
      expect(await page.locator('.token-mosaic .token-cell').count()).toBeGreaterThanOrEqual(365)
      await expect(page.locator('.token-mode-note')).toContainText('截至当天的历史累计')
      const totalCell = page.locator('.token-mosaic .token-cell:not(.is-outside):not(.level-0)').last()
      await expect(totalCell).toBeVisible()
      await totalCell.hover()
      await expect(page.locator('.token-tooltip')).toContainText('累计用量')
      await page.screenshot({ path: screenshotPath('token-activity-total.png') })
    } finally {
      await morrow.close()
      await mock.close()
    }
  })
})
