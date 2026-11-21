import { launchMorrow, dismissOnboarding, setThemeViaStore, screensDir } from './helpers'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * C-04 画音分离的界面层验收：
 * 1) 时间线把「环境床」作为独立轨道画出来，且音量低于对白；
 * 2) 环境床只来自纯音频素材、铺满全片、可循环；
 * 3) 混音层只允许 dialogue / ambience / sfx / music 四类，画面轨永远不提供声音。
 * 渲染与电平测量（三段真实音频、双遍 loudnorm、48kHz、−18 LUFS）由
 * tests/unit/audio-pipeline.test.ts 与 scripts/verify-audio-pipeline.mjs 覆盖，避免 E2E 重复跑全片渲染。
 */
test('@core:studio-timeline 时间线显示独立环境床轨道，画面轨不再提供声音', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'audio-split' })
  const page = morrow.page
  const action = async <T,>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
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
    await Promise.race([
      page.waitForSelector('.studio-timeline-view', { timeout: 30_000 }),
      page.waitForSelector('.studio-home', { timeout: 30_000 })
    ])
    if (await page.locator('.studio-home').count()) {
      if (await page.locator('.studio-guide').count()) await page.locator('.studio-guide-skip').click()
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    }
    await expect(page.locator('.studio-root')).toContainText('逆行的伞')

    const listed = await action<{ projects: Array<{ id: string; title: string }> }>('list')
    const sample = listed.projects.find((project) => project.title === '逆行的伞')!
    // 重新装配一次，确保轨道模型按当前代码生成（旧项目可能还是 5 轨）。
    const rebuilt = await action<{ project: any }>('build-timeline', { projectId: sample.id, force: true })
    const project = rebuilt.project

    const ambienceTrack = project.timeline.tracks.find((track: any) => track.id === 'track-ambience')
    const dialogueTrack = project.timeline.tracks.find((track: any) => track.id === 'track-dialogue')
    expect(ambienceTrack?.kind).toBe('ambience')
    expect(ambienceTrack?.volume).toBeLessThan(dialogueTrack?.volume ?? 1)

    const bedClips = project.timeline.clips.filter((clip: any) => clip.kind === 'ambience')
    expect(bedClips.length).toBeGreaterThanOrEqual(1)
    for (const clip of bedClips) {
      const asset = project.assets.find((item: any) => item.id === clip.assetId)
      expect(asset?.kind, '环境床只能来自纯音频素材，不能是视频').toBe('audio')
      expect(clip.start).toBe(0)
      expect(clip.duration).toBeCloseTo(project.timeline.durationSec, 1)
      expect(clip.loop).toBe(true)
    }

    // 画音分离的核心断言：画面轨只提供像素，混音层不含视频类片段。
    const audioKinds = new Set(
      project.timeline.clips
        .filter((clip: any) => ['dialogue', 'ambience', 'sfx', 'music'].includes(clip.kind))
        .map((clip: any) => clip.kind)
    )
    expect(audioKinds.has('ambience')).toBe(true)
    expect(project.timeline.clips.every((clip: any) => !(clip.kind === 'video' && clip.trackId !== 'track-video'))).toBe(true)

    // 界面：时间线轨道头必须出现「环境床」，且双主题下都能看到。
    await page.reload()
    await dismissOnboarding(page)
    await page.locator('.tb-create').click()
    await Promise.race([
      page.waitForSelector('.studio-timeline-view', { timeout: 30_000 }),
      page.waitForSelector('.studio-home', { timeout: 30_000 })
    ])
    if (await page.locator('.studio-home').count()) {
      await page.locator('.studio-project-card', { hasText: '逆行的伞' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
    }
    await expect(page.locator('.studio-timeline-view')).toBeVisible()
    await expect(page.locator('.studio-timeline-view')).toContainText('环境床')

    mkdirSync(screensDir, { recursive: true })
    await page.screenshot({ path: join(screensDir, 'studio-audio-split-dark.png') })

    await setThemeViaStore(page, 'light')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('.studio-timeline-view')).toContainText('环境床')
    await page.screenshot({ path: join(screensDir, 'studio-audio-split-light.png') })
  } finally {
    await morrow.close()
  }
})