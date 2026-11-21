import { launchMorrow, dismissOnboarding, setThemeViaStore, screensDir } from './helpers'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * C-01 帧数契约的界面层验收。
 * 数据链路（实测帧数写入、时间线重算、检查告警）由 tests/unit/frame-contract*.test.ts 与
 * scripts/verify-frame-contract.mjs 覆盖；这里只验证界面把实测/计划如实摊开，且在双主题下可读。
 * 随包样例《逆行的伞》12 镜计划各 8s，其中 video-07 / video-10 实测 209 帧 = 8.71s，
 * 正好用来验证「超额只用计划时长」这一分支，不依赖任何导入或刷新时序。
 */
test('@core:studio-timeline 帧数契约在镜头详情如实显示实测与计划的差异', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'frame-contract' })
  const page = morrow.page
  try {
    await dismissOnboarding(page)
    await setThemeViaStore(page, 'dark')
    await page.locator('.tb-create').click()
    // 上次打开过作品时，入口会直接回到那个作品而不是首页；两种落点都要能继续。
    await Promise.race([
      page.waitForSelector('.studio-timeline-view', { timeout: 30_000 }),
      page.waitForSelector('.studio-home', { timeout: 30_000 })
    ])
    if (await page.locator('.studio-home').count()) {
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    }
    await expect(page.locator('.studio-timeline-view')).toBeVisible({ timeout: 30_000 })
    // 直接落点必须是样例《逆行的伞》，否则 12 镜的前提不成立。
    await expect(page.locator('.studio-root')).toContainText('逆行的伞')

    await page.locator('.studio-stage-item', { hasText: '分镜' }).click()
    await page.waitForSelector('.studio-shot-card', { timeout: 20_000 })
    await expect(page.locator('.studio-shot-card')).toHaveCount(12)

    // 逐镜点开，把每镜的契约条文字收齐：样例 12 镜都有真实视频，应全部显示出帧数与实测时长。
    const cards = page.locator('.studio-shot-card')
    const total = await cards.count()
    expect(total).toBe(12)
    const rows: Array<{ number: string; text: string }> = []
    for (let index = 0; index < total; index += 1) {
      const card = cards.nth(index)
      const number = (await card.locator('.studio-shot-number').innerText()).trim()
      await card.click()
      await expect(page.locator('.studio-shot-inspector')).toBeVisible()
      // 选中态确认后再读契约条，避免读到上一镜的残留节点。
      await expect(card).toHaveClass(/is-selected/)
      const panel = page.locator('.studio-frame-contract')
      await expect(panel).toBeVisible()
      await expect(panel).toContainText('帧 @')
      await expect(panel).toContainText('实测')
      await expect(panel).toContainText('计划')
      rows.push({ number, text: (await panel.innerText()).replace(/\s+/g, ' ').trim() })
    }

    // 12 镜全部来自随包真实视频，实测值必须与帧数自洽：帧数 / 24fps = 实测秒数。
    for (const row of rows) {
      const frames = Number(row.text.match(/(\d+) 帧/)?.[1])
      const measured = Number(row.text.match(/实测 ([\d.]+)s/)?.[1])
      const planned = Number(row.text.match(/计划 ([\d.]+)s/)?.[1])
      expect(Number.isFinite(frames), `镜 ${row.number} 应显示帧数：${row.text}`).toBe(true)
      expect(Number.isFinite(measured)).toBe(true)
      expect(measured).toBeCloseTo(frames / 24, 1)
      // 计划时长由分镜决定，不强制统一；这里只要求它是正常镜头时长。
      expect(planned).toBeGreaterThanOrEqual(3)
    }
    // 至少有 4 镜的实测与计划不一致（158 帧 6.58s、209 帧 8.71s 等），界面不能把它们显示成一样。
    const mismatched = rows.filter((row) => {
      const measured = Number(row.text.match(/实测 ([\d.]+)s/)?.[1])
      const planned = Number(row.text.match(/计划 ([\d.]+)s/)?.[1])
      return Math.abs(measured - planned) > 0.02
    })
    expect(mismatched.length).toBeGreaterThanOrEqual(4)

    // 真实分布：4 镜不足（158 帧 6.58s、209 帧 8.71s），8 镜一致；随包样例没有「多出」分支。
    const shortRows = rows.filter((row) => row.text.includes('不补帧'))
    const exactRows = rows.filter((row) => row.text.includes('时长与实测一致'))
    expect(shortRows).toHaveLength(4)
    expect(exactRows).toHaveLength(8)
    for (const row of shortRows) expect(row.text).toMatch(/差 −0\.\d+s/)
    expect(shortRows.every((row) => row.text.includes('已按实测缩短'))).toBe(true)

    mkdirSync(screensDir, { recursive: true })
    await page.locator('.studio-shot-card', { hasText: shortRows[0].number }).first().click()
    await expect(page.locator('.studio-frame-contract.is-short')).toBeVisible()
    await page.locator('.studio-frame-contract').screenshot({ path: join(screensDir, 'studio-frame-contract-bar-dark.png') })
    await page.screenshot({ path: join(screensDir, 'studio-frame-contract-dark.png') })

    // 浅色主题：契约条文字与边框都不能变成透明。
    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const panel = page.locator('.studio-frame-contract')
    await expect(panel).toBeVisible()
    const lightStyle = await panel.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.color, border: style.borderLeftColor }
    })
    expect(lightStyle.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(lightStyle.border).not.toBe('rgba(0, 0, 0, 0)')
    await page.locator('.studio-frame-contract').screenshot({ path: join(screensDir, 'studio-frame-contract-bar-light.png') })
    await page.screenshot({ path: join(screensDir, 'studio-frame-contract-light.png') })
  } finally {
    await morrow.close()
  }
})