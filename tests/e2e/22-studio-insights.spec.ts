import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launchMorrow, root, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore } from './store'

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
    const target = list.projects.find((item: any) => item.title === '0.12秒')
    await page.locator('.studio-project-card', { hasText: '0.12秒' }).first().locator('.studio-project-cover').click()
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
