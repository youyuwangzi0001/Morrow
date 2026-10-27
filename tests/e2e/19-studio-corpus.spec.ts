import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import JSZip from 'jszip'
import { join } from 'node:path'
import { launchMorrow, screenshotPath } from './launch'
import { dismissOnboarding, setThemeViaStore, waitUntil } from './store'

type StudioPayload = { projectId?: string; [key: string]: unknown }

async function studioAction<T = any>(page: import('@playwright/test').Page, type: string, payload: StudioPayload = {}): Promise<T> {
  return page.evaluate(
    async (arg: { type: string; payload: StudioPayload }) => {
      const response = await window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload })
      if (!response.ok) throw new Error(response.error?.message || 'studio action failed')
      return response.data
    },
    { type, payload }
  ) as Promise<T>
}

async function openLibrary(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.tb-create').click()
  await page.waitForSelector('.studio-home', { timeout: 30_000 })
  if (await page.locator('.studio-guide').count()) {
    await page.locator('.studio-guide-skip').click()
  }
  await expect(page.locator('.studio-guide')).toHaveCount(0)
  await page.waitForTimeout(700)
}

async function openCorpus(page: import('@playwright/test').Page, title: string): Promise<string> {
  const list = await studioAction<{ projects: Array<{ id: string; title: string }> }>(page, 'list')
  const target = list.projects.find((project) => project.title === title)
  if (!target) throw new Error(`找不到作品：${title}`)
  await page.locator('.studio-project-card', { hasText: title }).first().locator('.studio-project-cover').click()
  await page.waitForTimeout(1000)
  return target.id
}

test.describe('创作台 · 真实语料协同', () => {
  test('长篇语料：章节、事实、配图、候选锁稿与真实导出', async () => {
    test.setTimeout(240_000)
    const morrow = await launchMorrow({ name: 'studio-corpus-novel', env: { MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await openLibrary(page)
      await expect(page.locator('.studio-project-card')).toHaveCount(7)
      const projectId = await openCorpus(page, '极速曙光')
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      let project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      expect(project.title).toBe('极速曙光')
      expect(project.chapters).toHaveLength(12)
      expect(project.chapters[0].title).toBe('神迹与巫术')
      expect(project.chapters.filter((chapter: any) => chapter.content.trim()).length).toBeGreaterThanOrEqual(3)
      expect(project.chapters[0].illustrations.length).toBeGreaterThan(0)
      expect(project.facts.length).toBeGreaterThanOrEqual(4)

      // 事实可回到章节：打开事实抽屉并定位
      await page.getByTitle('人物、设定与检查').click()
      await page.locator('.studio-fact-tabs').getByRole('button', { name: /^设定$/ }).click()
      await expect(page.locator('.studio-fact-row')).toHaveCount(project.facts.length)
      await expect(page.locator('.studio-fact-drawer')).toContainText('人物与设定')
      await page.screenshot({ path: screenshotPath('studio-writing-settings-dark.png') })
      await page.locator('.studio-fact-row').first().locator('.studio-fact-source').click()
      await page.waitForTimeout(300)

      // 第 4 章有候选；采用后手改，再生成候选，手改不能被覆盖
      const fourth = project.chapters[3]
      expect(fourth.candidates.length).toBeGreaterThan(0)
      await studioAction(page, 'adopt-candidate', { projectId, chapterId: fourth.id, candidateId: fourth.candidates[0].id })
      await studioAction(page, 'save-chapter', { projectId, chapterId: fourth.id, content: '手改后的第4章。\n\n这是作者亲手写下的段落，任何候选都不得覆盖。' })
      const generated = await studioAction<{ job: { id: string } }>(page, 'generate-chapter', { projectId, chapterId: fourth.id, useModel: false })
      expect(generated.job.id).toBeTruthy()
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          const job = latest.jobs.find((item: any) => item.id === generated.job.id)
          return job?.status === 'done' || job?.status === 'failed'
        },
        60_000,
        '本地候选生成完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      expect(project.chapters[3].content).toContain('手改后的第4章')
      expect(project.chapters[3].candidates.length).toBeGreaterThan(0)

      // 额外配图采用，位置与来源可读
      const imageAsset = project.assets.find((asset: any) => asset.kind === 'image' && asset.id !== project.chapters[0].illustrations[0]?.assetId)
      expect(imageAsset).toBeTruthy()
      await studioAction(page, 'attach-chapter-illustration', { projectId, chapterId: project.chapters[0].id, assetId: imageAsset.id, afterParagraph: 2, caption: '真实语料配图' })
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      expect(project.chapters[0].illustrations.length).toBeGreaterThanOrEqual(2)
      await expect(page.locator('.studio-paper-illustrations figure')).toHaveCount(project.chapters[0].illustrations.length)

      // 真实导出 EPUB，并写入交付记录
      const exported = await studioAction<{ job: { id: string } }>(page, 'export', { projectId, format: 'epub' })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          return latest.deliveries.some((item: any) => item.kind === 'epub')
        },
        90_000,
        'EPUB 导出完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const epub = project.deliveries.find((item: any) => item.kind === 'epub')
      expect(epub.bytes).toBeGreaterThan(1024)
      expect(existsSync(join(morrow.dataDir, 'studio', 'projects', projectId, epub.path))).toBe(true)
      expect(statSync(join(morrow.dataDir, 'studio', 'projects', projectId, epub.path)).size).toBe(epub.bytes)
      const epubZip = await JSZip.loadAsync(readFileSync(join(morrow.dataDir, 'studio', 'projects', projectId, epub.path)))
      const epubImages = Object.keys(epubZip.files).filter((name) => name.startsWith('OEBPS/images/') && !name.endsWith('/'))
      expect(epubImages.length).toBeGreaterThan(0)
      const epubStyle = await epubZip.file('OEBPS/style.css')!.async('string')
      expect(epubStyle).toContain('font-family')
      expect(epubStyle).toMatch(/Noto Serif SC|Songti SC|SimSun/)
      const epubChapterFiles = Object.keys(epubZip.files).filter((name) => /^OEBPS\/chapter-\d+\.xhtml$/.test(name))
      let epubHasFigure = false
      for (const name of epubChapterFiles) {
        const html = await epubZip.file(name)!.async('string')
        if (html.includes('<figure') && html.includes('images/')) epubHasFigure = true
      }
      expect(epubHasFigure).toBe(true)

      // Word 目录与配图、PDF 配图
      await studioAction(page, 'export', { projectId, format: 'docx' })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          return latest.deliveries.some((item: any) => item.kind === 'docx')
        },
        90_000,
        'Word 导出完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const docx = project.deliveries.find((item: any) => item.kind === 'docx')
      const docxZip = await JSZip.loadAsync(readFileSync(join(morrow.dataDir, 'studio', 'projects', projectId, docx.path)))
      expect(Object.keys(docxZip.files).some((name) => name.startsWith('word/media/'))).toBe(true)
      const docxStyles = await docxZip.file('word/styles.xml')!.async('string')
      expect(docxStyles).toContain('w:eastAsia="宋体"')
      const docxXml = await docxZip.file('word/document.xml')!.async('string')
      expect(docxXml).toContain('<w:drawing>')
      expect(docxXml).toContain('目录')

      await studioAction(page, 'export', { projectId, format: 'pdf' })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          return latest.deliveries.some((item: any) => item.kind === 'pdf')
        },
        90_000,
        'PDF 导出完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const pdf = project.deliveries.find((item: any) => item.kind === 'pdf')
      const pdfBytes = readFileSync(join(morrow.dataDir, 'studio', 'projects', projectId, pdf.path))
      expect(pdfBytes.includes(Buffer.from('/Subtype /Image'))).toBe(true)
      expect(pdfBytes.includes(Buffer.from('/Subtype /Type3'))).toBe(true)

      // 工程包可重新导入为可编辑作品（K07）
      await studioAction(page, 'export', { projectId, format: 'package' })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          return latest.deliveries.some((item: any) => item.kind === 'package')
        },
        90_000,
        '工程包导出完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const bundle = project.deliveries.find((item: any) => item.kind === 'package')
      const bundlePath = join(morrow.dataDir, 'studio', 'projects', projectId, bundle.path)
      expect(existsSync(bundlePath)).toBe(true)
      const imported = await studioAction<{ project: any; message?: string }>(page, 'import-package', { path: bundlePath })
      expect(imported.project.title).toContain('· 导入')
      expect(imported.project.chapters).toHaveLength(12)
      expect(imported.project.assets.length).toBeGreaterThan(0)
      await page.screenshot({ path: screenshotPath('studio-corpus-novel.png') })
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      await morrow.close()
    }
  })

  test('第二部长篇：连续写作只推进空章，真实事实来源可读', async () => {
    test.setTimeout(240_000)
    const morrow = await launchMorrow({ name: 'studio-corpus-batch', env: { MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await openLibrary(page)
      const projectId = await openCorpus(page, '再造华夏')
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      let project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      expect(project.title).toBe('再造华夏')
      const before = project.chapters.filter((chapter: any) => chapter.content.trim()).length
      const batch = await studioAction<{ job?: { id: string }; message?: string }>(page, 'batch-write', { projectId, count: 2, useModel: false })
      expect(batch.job?.id).toBeTruthy()
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          const empty = latest.chapters.filter((chapter: any) => !chapter.content.trim()).length
          const active = latest.jobs.some((job: any) => job.status === 'running' || job.status === 'queued')
          return !active && empty < project.chapters.length - before
        },
        90_000,
        '连续写作完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const after = project.chapters.filter((chapter: any) => chapter.content.trim()).length
      expect(after).toBeGreaterThan(before)
      // 手写一条带原文来源的事实，并确认能按章节定位
      const chapterId = project.chapters.find((chapter: any) => chapter.content.trim())?.id
      await studioAction(page, 'upsert-fact', {
        projectId,
        fact: { subject: '周哲', predicate: '原文依据', object: '用现代卫生常识救人', chapterId, quote: '他让人烧水、挖坑掩埋污物、把病患隔开。' }
      })
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const fact = project.facts.find((item: any) => item.predicate === '原文依据')
      expect(fact?.quote).toContain('烧水')
      await page.getByTitle('人物、设定与检查').click()
      await page.locator('.studio-fact-tabs').getByRole('button', { name: /^设定$/ }).click()
      await expect(page.locator('.studio-fact-quote').last()).toContainText('烧水')
    } finally {
      await morrow.close()
    }
  })

  test('真实语料漫剧：12 镜、配音、五轨时间线与真实草稿合成', async () => {
    test.setTimeout(300_000)
    const morrow = await launchMorrow({ name: 'studio-corpus-drama', env: { MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await openLibrary(page)
      const projectId = await openCorpus(page, '0.12秒')
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
      let project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      expect(project.title).toBe('0.12秒')
      expect(project.shots).toHaveLength(12)
      expect(project.assets.filter((asset: any) => asset.kind === 'image').length).toBeGreaterThanOrEqual(6)
      expect(project.assets.filter((asset: any) => asset.kind === 'audio' && asset.tags.includes('voice')).length).toBeGreaterThanOrEqual(4)
      expect(project.timeline.tracks).toHaveLength(5)
      expect(project.timeline.clips.length).toBeGreaterThanOrEqual(12)
      await expect(page.locator('.studio-monitor img')).toHaveCount(1)
      await expect(page.locator('.studio-clip').first()).toBeVisible()
      const render = await studioAction<{ job: { id: string } }>(page, 'render', { projectId, quality: 'draft', subtitleMode: 'burn', aspect: '16:9' })
      expect(render.job.id).toBeTruthy()
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          const job = latest.jobs.find((item: any) => item.id === render.job.id)
          return job?.status === 'done' || job?.status === 'failed'
        },
        180_000,
        '真实草稿合成完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const delivery = project.deliveries.find((item: any) => item.kind === 'mp4')
      expect(delivery, JSON.stringify(project.jobs.find((job: any) => job.id === render.job.id))).toBeTruthy()
      expect(delivery.bytes).toBeGreaterThan(50_000)
      expect(existsSync(join(morrow.dataDir, 'studio', 'projects', projectId, delivery.path))).toBe(true)

      // 成片音轨提取与四格漫画排版
      const audioJob = await studioAction<{ job: { id: string } }>(page, 'export-audio', { projectId, format: 'wav' })
      const comicJob = await studioAction<{ job: { id: string } }>(page, 'export-comic', { projectId })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          return latest.deliveries.some((item: any) => item.kind === 'wav') && latest.deliveries.some((item: any) => item.kind === 'comic')
        },
        120_000,
        '音频与四格漫画导出完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const audio = project.deliveries.find((item: any) => item.kind === 'wav')
      const comic = project.deliveries.find((item: any) => item.kind === 'comic')
      expect(audio.bytes).toBeGreaterThan(1024)
      expect(comic.bytes).toBeGreaterThan(10_000)
      expect(readFileSync(join(morrow.dataDir, 'studio', 'projects', projectId, comic.path)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(project.jobs.find((job: any) => job.id === audioJob.job.id)?.status).toBe('done')
      expect(project.jobs.find((job: any) => job.id === comicJob.job.id)?.status).toBe('done')
      await page.locator('.studio-stage-item', { hasText: '交付' }).first().click()
      await page.waitForSelector('.studio-delivery', { timeout: 20_000 })
      await expect(page.locator('.studio-delivery-audio button')).toHaveCount(4)
      await expect(page.getByRole('button', { name: /四格漫画/ })).toBeVisible()
      await page.screenshot({ path: screenshotPath('studio-corpus-drama.png') })
    } finally {
      await morrow.close()
    }
  })
  test('长篇结构、世界设定、候选对照与任务重试', async () => {
    test.setTimeout(240_000)
    const morrow = await launchMorrow({ name: 'studio-structure', env: { MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await openLibrary(page)
      const projectId = await openCorpus(page, '极速曙光')
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      await page.waitForTimeout(600)
      let project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const chapter = project.chapters[3]

      // 分卷 CRUD + 跨卷拖拽
      await page.getByRole('button', { name: /新建分卷/ }).click()
      await page.locator('.modal-panel input').first().fill('结构测试卷 · 纸伞')
      await page.locator('.modal-panel textarea').first().fill('验证跨卷移动与章节保留。')
      await page.getByRole('button', { name: '保存分卷' }).click()
      await expect(page.locator('.studio-outline-volume-toggle', { hasText: '结构测试卷' })).toBeVisible({ timeout: 15_000 })
      const volume = page.locator('.studio-outline-volume', { hasText: '结构测试卷' })
      await page.locator('.studio-outline-row', { hasText: chapter.title }).first().dragTo(volume.locator('.studio-outline-volume-toggle'))
      await page.waitForTimeout(1000)
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const targetVolume = project.volumes.find((item: any) => item.title.includes('结构测试卷'))
      expect(project.chapters.find((item: any) => item.id === chapter.id)?.volumeId).toBe(targetVolume.id)

      // 世界设定与人物关系
      await page.getByTitle('人物、设定与检查').click()
      await page.locator('.studio-fact-tabs').getByRole('button', { name: /世界/ }).click()
      await expect(page.locator('.studio-world-panel')).toBeVisible()
      await page.locator('.studio-world-panel section').first().getByRole('button', { name: /新增/ }).click()
      await page.locator('.modal-panel input').first().fill('伞街公所')
      await page.locator('.modal-panel textarea').first().fill('管着雨夜街面秩序的旧组织。')
      await page.getByRole('button', { name: '保存势力' }).click()
      await expect(page.locator('.studio-world-row', { hasText: '伞街公所' })).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('.studio-relationship-graph > svg')).toBeVisible()
      await page.screenshot({ path: screenshotPath('studio-world-dark.png') })
      await page.locator('.studio-fact-drawer > header button').click()

      // 第二份候选后重新打开作品，验证全部候选与段落对照
      const generated = await studioAction<{ job: { id: string } }>(page, 'generate-chapter', { projectId, chapterId: chapter.id, useModel: false })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          const job = latest.jobs.find((item: any) => item.id === generated.job.id)
          return job?.status === 'done' || job?.status === 'failed'
        },
        60_000,
        '候选生成完成'
      )
      await page.locator('.studio-home-link').click()
      await page.waitForSelector('.studio-home', { timeout: 10_000 })
      await page.locator('.studio-project-card', { hasText: '极速曙光' }).first().locator('.studio-project-cover').click()
      await page.waitForSelector('.studio-writing', { timeout: 20_000 })
      await page.locator('.studio-outline-row', { hasText: chapter.title }).first().locator('.studio-outline-chapter').click()
      await page.waitForTimeout(800)
      await expect(page.locator('.studio-candidate-banner')).toBeVisible()
      await page.locator('.studio-candidate-banner button').first().click()
      await expect(page.locator('.studio-candidate-switch button')).toHaveCount(2, { timeout: 15_000 })
      await page.getByRole('button', { name: '段落对照' }).click()
      await expect(page.locator('.studio-diff-text p').first()).toBeVisible()
      await page.screenshot({ path: screenshotPath('studio-candidate-world.png') })
      await page.keyboard.press('Escape')

      // 蓝图逐项编辑
      await page.locator('.studio-writing-stage-btn').click()
      await page.getByRole('menuitem', { name: /故事蓝图/ }).click()
      await page.waitForSelector('.studio-blueprint', { timeout: 20_000 })
      await page.locator('.studio-bp-core .studio-bp-edit').click()
      await page.locator('.modal-panel textarea').first().fill('一个修伞女孩在雨夜里反复修补同一把会倒流的伞。')
      await page.getByRole('button', { name: '保存蓝图' }).click()
      await page.waitForTimeout(800)
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      expect(project.blueprint.storyCore).toContain('反复修补')

      // 任务输入快照与重试
      await studioAction(page, 'export', { projectId, format: 'txt' })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          return latest.deliveries.some((item: any) => item.kind === 'txt')
        },
        60_000,
        '文本导出完成'
      )
      project = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
      const exportJob = [...project.jobs].reverse().find((job: any) => job.kind === 'export' && job.retry)
      expect(exportJob?.retry).toBeTruthy()
      const retried = await studioAction<{ job: { id: string } }>(page, 'retry-job', { projectId, jobId: exportJob.id })
      await waitUntil(
        async () => {
          const latest = (await studioAction<{ project: any }>(page, 'get', { projectId })).project
          const job = latest.jobs.find((item: any) => item.id === retried.job.id)
          return job?.status === 'done' || job?.status === 'failed'
        },
        60_000,
        '重试任务完成'
      )
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      await morrow.close()
    }
  })

  test('小说改编、参考库、批量镜头与逐句字幕', async () => {
    test.setTimeout(240_000)
    const morrow = await launchMorrow({ name: 'studio-flow', env: { MORROW_SEED_CORPUS: '1' } })
    const page = morrow.page
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    try {
      await dismissOnboarding(page)
      await setThemeViaStore(page, 'dark')
      await openLibrary(page)
      const sourceId = await openCorpus(page, '极速曙光')
      await page.waitForSelector('.studio-writing', { timeout: 30_000 })
      const source = (await studioAction<{ project: any }>(page, 'get', { projectId: sourceId })).project
      const written = source.chapters.filter((chapter: any) => chapter.content.trim()).length
      await page.getByRole('button', { name: '改成漫剧' }).click()
      await page.waitForSelector('.studio-storyboard', { timeout: 30_000 })
      const list = await studioAction<{ projects: Array<{ id: string; title: string }> }>(page, 'list')
      const adapted = list.projects.find((item) => item.title === '极速曙光 · 漫剧')
      expect(adapted?.id).toBeTruthy()
      const drama = (await studioAction<{ project: any }>(page, 'get', { projectId: adapted!.id })).project
      expect(drama.kind).toBe('drama')
      expect(drama.shots).toHaveLength(written)
      expect(drama.scenes.every((scene: any) => Boolean(scene.sourceChapterId))).toBe(true)
      expect(drama.blueprint.storyCore).toContain('雨')

      await page.locator('.studio-home-link').click()
      await page.waitForSelector('.studio-home', { timeout: 10_000 })
      await openCorpus(page, '逆行的伞')
      await page.waitForSelector('.studio-timeline-view', { timeout: 30_000 })
      await page.locator('.studio-stage-item', { hasText: '分镜' }).first().click()
      await page.waitForSelector('.studio-shot-card', { timeout: 20_000 })
      await page.locator('.studio-shot-card').nth(5).click()
      await expect(page.locator('.studio-shot-inspector')).toBeVisible({ timeout: 10_000 })
      await page.locator('.studio-ref-library-btn').click()
      await page.waitForSelector('.studio-reference-library', { timeout: 10_000 })
      await page.locator('.studio-reference-grid button').first().click()
      await page.getByRole('button', { name: '保存参考' }).click()
      await page.waitForTimeout(800)

      await page.getByRole('button', { name: '批量调整' }).click()
      await page.waitForSelector('.modal-panel', { timeout: 10_000 })
      await page.locator('.modal-panel input').nth(0).fill('9')
      await page.getByRole('button', { name: '应用到镜头' }).click()
      await page.waitForTimeout(900)

      await page.getByRole('button', { name: '逐句字幕' }).click()
      await page.waitForTimeout(900)
      const currentList = await studioAction<{ projects: Array<{ id: string; title: string }> }>(page, 'list')
      const dramaId = currentList.projects.find((item) => item.title === '逆行的伞')!.id
      const after = (await studioAction<{ project: any }>(page, 'get', { projectId: dramaId })).project
      expect(after.shots.every((shot: any) => shot.durationSec === 9)).toBe(true)
      const subtitleClips = after.timeline.clips.filter((clip: any) => clip.kind === 'subtitle').sort((a: any, b: any) => a.start - b.start)
      expect(subtitleClips.length).toBeGreaterThanOrEqual(after.shots.filter((shot: any) => shot.dialogue.trim()).length)
      expect(subtitleClips.every((clip: any) => Boolean(clip.shotId))).toBe(true)
      for (let index = 1; index < subtitleClips.length; index += 1) {
        const previous = subtitleClips[index - 1]
        const current = subtitleClips[index]
        expect(previous.start + previous.duration).toBeLessThanOrEqual(current.start + 0.02)
      }
      expect(Array.from(new Set(after.characters.flatMap((character: any) => character.refAssetIds))).length).toBeGreaterThan(0)
      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      await morrow.close()
    }
  })

})
