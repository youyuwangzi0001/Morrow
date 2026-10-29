// real 领域 E2E：由 9 个原 spec 合并；每个原文件保留独立 describe 作用域。
import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launchMorrow, root } from './launch'
import { waitUntil } from './store'

test.describe("91-comfy-port", () => {
test.skip(process.env.MORROW_COMFY_PORT_TEST !== '1', 'ComfyUI 端口回退：设置 MORROW_COMFY_PORT_TEST=1 后运行')
test('ComfyUI 端口被系统保留时自动换端口并写回设置', async () => {
  test.setTimeout(240_000)
  const dataDir = join(root, 'tmp', `comfy-port-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = JSON.parse(readFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), 'utf8'))
  settings.mediaEngine = { ...(settings.mediaEngine ?? {}), comfyuiUrl: 'http://127.0.0.1:8188', comfyuiDir: null, autoStart: true }
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  const morrow = await launchMorrow({ name: 'comfy-port', dataDir, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const result = await page.evaluate(async () => {
      return await window.morrow.features.invoke('feature:media:start')
    })
    console.log('PORT_START', JSON.stringify(result).slice(0, 1200))
    expect(result.ok).toBe(true)
    expect(result.data.engine.online).toBe(true)
    expect(result.data.engine.url).not.toContain(':8188')
    const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    console.log('PORT_SAVED', saved.mediaEngine.comfyuiUrl)
    expect(saved.mediaEngine.comfyuiUrl).toBe(result.data.engine.url)
    await page.evaluate(async () => {
      await window.morrow.features.invoke('feature:media:catalog-action', { action: 'stop-engine', id: 'comfyui' })
    })
  } finally {
    await morrow.close()
  }
})
})

test.describe("92-real-export", () => {
test.skip(process.env.MORROW_REAL_EXPORT !== '1', '真实导出：设置 MORROW_REAL_EXPORT=1 后运行')
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
test('真实导出：长篇项目重新导出 EPUB 并写入交付记录', async () => {
  test.setTimeout(300_000)
  const dataDir = process.env.MORROW_REAL_EXPORT_DATA ?? join(root, 'tmp', 'real-long-1793178048071')
  const morrow = await launchMorrow({ name: 'real-export', dataDir, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const list = await action<{ projects: Array<{ id: string; title: string }> }>(page, 'list')
    const target = list.projects.find((item) => item.title === '逆钟')
    expect(target).toBeTruthy()
    await action(page, 'export', { projectId: target!.id, format: 'epub', requestId: `real-export-${Date.now()}` })
    const deadline = Date.now() + 180_000
    let delivery: any = null
    while (Date.now() < deadline) {
      const jobs = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId: target!.id })
      const job = [...(jobs.jobs ?? [])].reverse().find((item) => item.retry?.action === 'export')
      if (job?.status === 'failed') throw new Error(`导出失败：${job.message}`)
      if (job?.status === 'done') {
        const data = await action<{ project: any }>(page, 'get', { projectId: target!.id })
        delivery = data.project.deliveries.find((item: any) => item.kind === 'epub')
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    console.log('REAL_EXPORT', JSON.stringify({ label: delivery?.label, bytes: delivery?.bytes, path: delivery?.path }))
    expect(delivery).toBeTruthy()
    expect(delivery.bytes).toBeGreaterThan(3000)
  } finally {
    await morrow.close()
  }
})
})

test.describe("93-real-long", () => {
test.skip(process.env.MORROW_REAL_MODEL !== '1', '真实长篇链路：设置 MORROW_REAL_MODEL=1 后运行')
const LOGLINE = '一位失聪的钟表修复师，在旧城拆迁前修复一座会倒走的钟'
const COMFYUI_URL = process.env.MORROW_TEST_COMFYUI_URL || 'http://127.0.0.1:8288'
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
async function waitJob(page: import('@playwright/test').Page, projectId: string, actionType: string, timeoutMs = 1_200_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let lastLog = 0
  while (Date.now() < deadline) {
    const data = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId })
    const job = [...(data.jobs ?? [])].reverse().find((item: any) => item.retry?.action === actionType)
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now()
      console.log('JOB_POLL', JSON.stringify((data.jobs ?? []).slice(-3).map((item: any) => ({ label: item.label, status: item.status, progress: item.progress, message: item.message }))))
    }
    if (job?.status === 'failed') throw new Error(`任务失败：${job.message}`)
    if (job?.status === 'done') return (await action<{ project: any }>(page, 'get', { projectId })).project
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error(`任务超时：${actionType}`)
}
test('真实长篇六步：蓝图→大纲→写作→画面→检查→交付', async () => {
  test.setTimeout(2_400_000)
  const dataDir = join(root, 'tmp', `real-long-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = JSON.parse(readFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), 'utf8'))
  settings.mediaEngine = { ...(settings.mediaEngine ?? {}), comfyuiUrl: COMFYUI_URL, autoStart: false }
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  copyFileSync(join(root, 'deliver', 'Morrow Data', 'secrets.json'), join(dataDir, 'secrets.json'))
  const localState = join(root, 'deliver', 'Morrow Data', 'Local State')
  if (existsSync(localState)) copyFileSync(localState, join(dataDir, 'Local State'))
  const morrow = await launchMorrow({ name: 'real-long', dataDir, env: { MORROW_TEST: '1' }, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const created = await action<{ project: any }>(page, 'create', {
      kind: 'novel',
      logline: LOGLINE,
      form: '速成草稿',
      genre: '',
      audience: '',
      tone: '',
      aspect: '16:9',
      targetWords: 30_000,
      constraints: ['主角失聪，靠读唇与震动感知世界', '不解释钟为什么会倒走']
    })
    const projectId = created.project.id

    await action(page, 'generate-blueprint', { projectId, useModel: true, requestId: `long-bp-${Date.now()}` })
    let project = await waitJob(page, projectId, 'generate-blueprint')
    console.log('LONG1_BLUEPRINT', JSON.stringify({ title: project.title, source: project.blueprint.source, units: project.blueprint.units.length, volumes: project.blueprint.volumes?.length, first: project.blueprint.units[0]?.title }))
    expect(project.blueprint.source).toBe('model')
    expect(project.blueprint.units.length).toBeGreaterThanOrEqual(30)
    expect(project.blueprint.volumes.length).toBe(3)
    await action(page, 'approve-blueprint', { projectId })

    await action(page, 'generate-outline', { projectId, useModel: true, requestId: `long-outline-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-outline')
    console.log('LONG2_OUTLINE', JSON.stringify({ model: project.blueprint.outlineModel, chapters: project.chapters.length, first: project.chapters[0]?.title }))
    expect(project.blueprint.outlineModel).toBeTruthy()
    expect(project.chapters.length).toBeGreaterThanOrEqual(30)

    const chapter = project.chapters[0]
    await action(page, 'generate-chapter', { projectId, chapterId: chapter.id, useModel: true, requestId: `long-chapter-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-chapter')
    const written = project.chapters.find((item: any) => item.id === chapter.id)
    console.log('LONG3_WRITING', JSON.stringify({ title: written.title, words: written.content.length, candidate: written.candidates[0]?.label }))
    expect(written.content.length).toBeGreaterThan(500)

    await action(page, 'generate-chapter-illustration', { projectId, chapterId: chapter.id, count: 1, requestId: `long-illustration-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-chapter-illustration', 900_000)
    const illustration = project.assets.find((asset: any) => asset.tags.includes('illustration'))
    console.log('LONG4_VISUALS', JSON.stringify({ asset: illustration?.title, origin: illustration?.origin, bytes: illustration?.bytes }))
    expect(illustration?.origin?.source).toBe('comfyui')

    await action(page, 'review', { projectId })
    project = (await action<{ project: any }>(page, 'get', { projectId })).project
    console.log('LONG5_REVIEW', JSON.stringify({ status: project.stages.review.status, checks: project.checks.slice(0, 6).map((check: any) => `${check.level}:${check.title}`) }))
    expect(project.checks.length).toBeGreaterThan(0)

    await action(page, 'export', { projectId, format: 'epub', requestId: `long-export-${Date.now()}` })
    project = await waitJob(page, projectId, 'export', 300_000)
    const epub = project.deliveries.find((item: any) => item.kind === 'epub')
    console.log('LONG6_DELIVERY', JSON.stringify({ epub: epub?.label, bytes: epub?.bytes }))
    expect(epub).toBeTruthy()
    expect(epub.bytes).toBeGreaterThan(3000)
  } finally {
    await morrow.close()
  }
})
})

test.describe("94-real-short", () => {
test.skip(process.env.MORROW_REAL_MODEL !== '1', '真实中短篇链路：设置 MORROW_REAL_MODEL=1 后运行')
const LOGLINE = '旧城最后一班夜班公交司机，在末班车上捡到一封写给十年前自己的信'
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
async function waitJob(page: import('@playwright/test').Page, projectId: string, actionType: string, timeoutMs = 900_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId })
    const job = [...(data.jobs ?? [])].reverse().find((item: any) => item.retry?.action === actionType)
    if (job?.status === 'failed') throw new Error(`任务失败：${job.message}`)
    if (job?.status === 'done') return (await action<{ project: any }>(page, 'get', { projectId })).project
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  throw new Error(`任务超时：${actionType}`)
}
test('真实中短篇五步：蓝图→大纲→写作→检查→交付', async () => {
  test.setTimeout(1_500_000)
  const dataDir = join(root, 'tmp', `real-short-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = JSON.parse(readFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), 'utf8'))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  copyFileSync(join(root, 'deliver', 'Morrow Data', 'secrets.json'), join(dataDir, 'secrets.json'))
  const localState = join(root, 'deliver', 'Morrow Data', 'Local State')
  if (existsSync(localState)) copyFileSync(localState, join(dataDir, 'Local State'))
  const morrow = await launchMorrow({ name: 'real-short', dataDir, env: { MORROW_TEST: '1' }, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const created = await action<{ project: any }>(page, 'create', {
      kind: 'short',
      logline: LOGLINE,
      form: '速成草稿',
      genre: '',
      audience: '',
      tone: '',
      aspect: '16:9',
      targetWords: 18_000,
      constraints: ['第一人称限知', '不解释超自然规则']
    })
    const projectId = created.project.id

    await action(page, 'generate-blueprint', { projectId, useModel: true, requestId: `short-bp-${Date.now()}` })
    let project = await waitJob(page, projectId, 'generate-blueprint')
    console.log('SHORT1_BLUEPRINT', JSON.stringify({ title: project.title, source: project.blueprint.source, model: project.blueprint.model, units: project.blueprint.units.length }))
    expect(project.blueprint.source).toBe('model')
    expect(project.blueprint.units.length).toBeGreaterThanOrEqual(6)
    await action(page, 'approve-blueprint', { projectId })

    await action(page, 'generate-outline', { projectId, useModel: true, requestId: `short-outline-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-outline')
    console.log('SHORT2_OUTLINE', JSON.stringify({ model: project.blueprint.outlineModel, chapters: project.chapters.length, first: project.chapters[0]?.title }))
    expect(project.blueprint.outlineModel).toBeTruthy()
    expect(project.chapters.length).toBeGreaterThanOrEqual(6)

    const chapter = project.chapters[0]
    await action(page, 'generate-chapter', { projectId, chapterId: chapter.id, useModel: true, requestId: `short-chapter-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-chapter')
    const written = project.chapters.find((item: any) => item.id === chapter.id)
    console.log('SHORT3_WRITING', JSON.stringify({ title: written.title, words: written.content.length, candidate: written.candidates[0]?.label }))
    expect(written.content.length).toBeGreaterThan(500)
    expect(written.candidates.length).toBeGreaterThan(0)
    expect(written.content).not.toContain('修伞')

    await action(page, 'polish-chapter', { projectId, chapterId: chapter.id, instruction: '减少形容词，保留物件细节', requestId: `short-polish-${Date.now()}` })
    project = await waitJob(page, projectId, 'polish-chapter')
    const polished = project.chapters.find((item: any) => item.id === chapter.id)
    console.log('SHORT3B_POLISH', JSON.stringify({ candidates: polished.candidates.length, first: polished.candidates[0]?.label }))
    expect(polished.candidates.length).toBeGreaterThan(0)

    await action(page, 'review', { projectId })
    project = (await action<{ project: any }>(page, 'get', { projectId })).project
    console.log('SHORT4_REVIEW', JSON.stringify({ status: project.stages.review.status, checks: project.checks.slice(0, 6).map((check: any) => `${check.level}:${check.title}`) }))
    expect(project.checks.length).toBeGreaterThan(0)

    await action(page, 'export', { projectId, format: 'txt', requestId: `short-export-${Date.now()}` })
    project = (await action<{ project: any }>(page, 'get', { projectId })).project
    const txt = project.deliveries.find((item: any) => item.kind === 'txt')
    console.log('SHORT5_DELIVERY', JSON.stringify({ txt: txt?.label, bytes: txt?.bytes }))
    expect(txt).toBeTruthy()
    expect(txt.bytes).toBeGreaterThan(1000)
  } finally {
    await morrow.close()
  }
})
})

test.describe("95-real-adapt", () => {
test.skip(process.env.MORROW_REAL_ADAPT !== '1', '真实小说改编：设置 MORROW_REAL_ADAPT=1 后运行')
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
test('真实小说改编：模型把已写章节拆成漫剧分镜并保留来源', async () => {
  test.setTimeout(900_000)
  const dataDir = join(root, 'tmp', `real-adapt-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = JSON.parse(readFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), 'utf8'))
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  copyFileSync(join(root, 'deliver', 'Morrow Data', 'secrets.json'), join(dataDir, 'secrets.json'))
  const localState = join(root, 'deliver', 'Morrow Data', 'Local State')
  if (existsSync(localState)) copyFileSync(localState, join(dataDir, 'Local State'))
  const morrow = await launchMorrow({ name: 'real-adapt', dataDir, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const list = await action<{ projects: Array<{ id: string; title: string; kind: string }> }>(page, 'list')
    const source = list.projects.find((item) => item.title === '雨停之前')
    expect(source).toBeTruthy()
    const result = await action<{ project: any; job?: any; message?: string }>(page, 'adapt-to-drama', {
      projectId: source!.id,
      requestId: `real-adapt-${Date.now()}`
    })
    console.log('ADAPT_START', JSON.stringify({ target: result.project?.id, message: result.message, job: result.job?.status }))
    expect(result.project?.kind).toBe('drama')
    expect(result.job?.status === 'queued' || result.job?.status === 'running').toBe(true)
    const projectId = result.project.id
    const deadline = Date.now() + 600_000
    let project: any = null
    let job: any = null
    while (Date.now() < deadline) {
      const jobs = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId })
      job = [...(jobs.jobs ?? [])].reverse().find((item) => item.retry?.action === 'generate-storyboard')
      if (job?.status === 'failed') throw new Error(`改编失败：${job.message}`)
      if (job?.status === 'done') {
        project = (await action<{ project: any }>(page, 'get', { projectId })).project
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
    expect(job?.status).toBe('done')
    console.log('ADAPT_RESULT', JSON.stringify({
      title: project.title,
      adaptedFrom: project.blueprint?.adaptedFrom,
      source: project.blueprint?.source,
      storyboardModel: project.blueprint?.storyboardModel,
      scenes: project.scenes.length,
      shots: project.shots.length,
      sourceChapters: project.scenes.map((scene: any) => scene.sourceChapterId).filter(Boolean).length,
      first: project.shots[0] && { title: project.shots[0].title, action: project.shots[0].action, prompt: project.shots[0].prompt?.slice(0, 80) }
    }))
    expect(project.blueprint?.adaptedFrom?.title).toBe('雨停之前')
    expect(project.blueprint?.source).toBe('model')
    expect(project.blueprint?.storyboardModel).toBeTruthy()
    expect(project.shots.length).toBeGreaterThanOrEqual(6)
    expect(project.scenes.some((scene: any) => scene.sourceChapterId)).toBe(true)
    expect(project.shots.every((shot: any) => shot.prompt.length > 20)).toBe(true)
  } finally {
    await morrow.close()
  }
})
})

test.describe("96-real-music", () => {
test.skip(process.env.MORROW_REAL_MUSIC !== '1', '真实配乐：设置 MORROW_REAL_MUSIC=1 后运行')
const COMFYUI_URL = process.env.MORROW_TEST_COMFYUI_URL || 'http://127.0.0.1:8288'
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
test('真实配乐：ACE-Step 生成正式配乐并入库', async () => {
  test.setTimeout(600_000)
  const dataDir = join(root, 'tmp', `real-music-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = JSON.parse(readFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), 'utf8'))
  settings.mediaEngine = { ...(settings.mediaEngine ?? {}), comfyuiUrl: COMFYUI_URL, autoStart: false }
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  const morrow = await launchMorrow({ name: 'real-music', dataDir, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const list = await action<{ projects: Array<{ id: string; title: string; kind: string }> }>(page, 'list')
    const target = list.projects.find((item) => item.title === '逆行的伞')
    expect(target).toBeTruthy()
    await action(page, 'generate-music', { projectId: target!.id, kind: 'music', seconds: 8, requestId: `real-music-${Date.now()}` })
    const deadline = Date.now() + 300_000
    let job: any = null
    while (Date.now() < deadline) {
      const jobs = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId: target!.id })
      job = [...(jobs.jobs ?? [])].reverse().find((item) => item.retry?.action === 'generate-music')
      if (job?.status === 'failed') throw new Error(`配乐失败：${job.message}`)
      if (job?.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
    expect(job?.status).toBe('done')
    const data = await action<{ project: any }>(page, 'get', { projectId: target!.id })
    const musicAssets = data.project.assets.filter((asset: any) => asset.kind === 'audio' && asset.tags.includes('music'))
    console.log('REAL_MUSIC_ALL', JSON.stringify(musicAssets.map((asset: any) => ({ title: asset.title, origin: asset.origin, tags: asset.tags, duration: asset.durationSec, bytes: asset.bytes }))))
    const music = musicAssets.find((asset: any) => asset.tags.includes('model') || asset.origin?.source === 'comfyui')
    console.log('REAL_MUSIC', JSON.stringify({ title: music?.title, origin: music?.origin, tags: music?.tags, duration: music?.durationSec, bytes: music?.bytes }))
    expect(music?.origin?.source).toBe('comfyui')
    expect(music?.tags).toContain('model')
    expect(music?.durationSec ?? 0).toBeGreaterThan(1)
    expect(data.project.stages.music.status).toBe('done')
  } finally {
    await morrow.close()
  }
})
})

test.describe("97-real-voice", () => {
test.skip(process.env.MORROW_REAL_VOICE !== '1', '真实本机配音：设置 MORROW_REAL_VOICE=1 后运行')
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
test('真实本机配音：样例台词重新生成语音文件', async () => {
  test.setTimeout(180_000)
  const morrow = await launchMorrow({ name: 'real-voice', extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const list = await action<{ projects: Array<{ id: string; title: string; kind: string }> }>(page, 'list')
    const target = list.projects.find((item) => item.title === '逆行的伞')
    expect(target).toBeTruthy()
    const data = await action<{ project: any }>(page, 'get', { projectId: target!.id })
    const shot = data.project.shots.find((item: any) => item.dialogue.trim())
    expect(shot).toBeTruthy()
    await action(page, 'generate-voice', { projectId: target!.id, shotId: shot.id, requestId: `real-voice-${Date.now()}` })
    const deadline = Date.now() + 120_000
    let project: any = null
    while (Date.now() < deadline) {
      project = (await action<{ project: any }>(page, 'get', { projectId: target!.id })).project
      const job = [...project.jobs].reverse().find((item: any) => item.retry?.action === 'generate-voice')
      if (job?.status === 'failed') throw new Error(`配音失败：${job.message}`)
      if (job?.status === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    const updated = project.shots.find((item: any) => item.id === shot.id)
    const voice = project.assets.find((item: any) => item.id === updated?.voiceAssetId)
    console.log('REAL_VOICE', JSON.stringify({ title: voice?.title, origin: voice?.origin, duration: voice?.durationSec, bytes: voice?.bytes }))
    expect(voice?.origin?.source === 'sapi' || voice?.origin?.source === 'cloud-tts').toBe(true)
    expect(voice?.durationSec ?? 0).toBeGreaterThan(0.2)
  } finally {
    await morrow.close()
  }
})
})

test.describe("98-real-drama", () => {
test.skip(process.env.MORROW_REAL_MODEL !== '1', '真实漫剧链路：设置 MORROW_REAL_MODEL=1 后运行')
const LOGLINE = '海底邮局的最后一班投递员，在沉船里发现一封寄给未来自己的信'
const COMFYUI_URL = process.env.MORROW_TEST_COMFYUI_URL || 'http://127.0.0.1:8288'
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
async function waitJob(page: import('@playwright/test').Page, projectId: string, actionType: string, timeoutMs = 900_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let lastLog = 0
  while (Date.now() < deadline) {
    const data = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId })
    const job = [...(data.jobs ?? [])].reverse().find((item: any) => item.retry?.action === actionType)
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now()
      console.log('JOB_POLL', JSON.stringify({
        jobs: (data.jobs ?? []).slice(-4).map((item: any) => ({ label: item.label, status: item.status, progress: item.progress, message: item.message, retry: item.retry?.action, error: item.error }))
      }))
    }
    if (job?.status === 'failed') throw new Error(`任务失败：${job.message}`)
    if (job?.status === 'done') {
      const project = (await action<{ project: any }>(page, 'get', { projectId })).project
      return project
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  const data = await action<{ jobs: any[] }>(page, 'list-jobs', { projectId })
  throw new Error(`任务超时；jobs=${JSON.stringify((data.jobs ?? []).map((item: any) => ({ label: item.label, status: item.status, message: item.message })))}`)
}
test('真实漫剧九步：蓝图→大纲→分镜→画面→配音→配乐→时间线→检查→草稿成片', async () => {
  test.setTimeout(1_800_000)
  const dataDir = join(root, 'tmp', `real-drama-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  const settings = JSON.parse(readFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), 'utf8'))
  settings.mediaEngine = { ...(settings.mediaEngine ?? {}), comfyuiUrl: COMFYUI_URL, autoStart: false }
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  copyFileSync(join(root, 'deliver', 'Morrow Data', 'secrets.json'), join(dataDir, 'secrets.json'))
  const localState = join(root, 'deliver', 'Morrow Data', 'Local State')
  if (existsSync(localState)) copyFileSync(localState, join(dataDir, 'Local State'))
  const morrow = await launchMorrow({ name: 'real-drama', dataDir, env: { MORROW_TEST: '1' }, extraArgs: ['--disable-gpu'] })
  const page = morrow.page
  try {
    const created = await action<{ project: any }>(page, 'create', {
      kind: 'drama',
      logline: LOGLINE,
      form: '速成草稿',
      genre: '',
      audience: '',
      tone: '',
      aspect: '16:9',
      targetSeconds: 48,
      constraints: ['角色外观保持一致', '16:9']
    })
    const projectId = created.project.id

    await action(page, 'generate-blueprint', { projectId, useModel: true, requestId: `real-bp-${Date.now()}` })
    let project = await waitJob(page, projectId, 'generate-blueprint')
    console.log('STEP1_BLUEPRINT', JSON.stringify({
      title: project.title,
      source: project.blueprint.source,
      model: project.blueprint.model,
      scenes: project.blueprint.scenes?.length,
      units: project.blueprint.units?.length,
      unitSample: project.blueprint.units?.slice(0, 3).map((unit: any) => unit.title)
    }))
    expect(project.blueprint.source).toBe('model')
    expect(project.blueprint.scenes.length).toBeGreaterThan(0)

    await action(page, 'approve-blueprint', { projectId })
    project = (await action<{ project: any }>(page, 'get', { projectId })).project
    expect(project.shots.length).toBeGreaterThanOrEqual(6)
    const shotCount = project.shots.length

    await action(page, 'generate-outline', { projectId, useModel: true, requestId: `real-outline-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-outline')
    console.log('STEP2_OUTLINE', JSON.stringify({
      model: project.blueprint.outlineModel,
      units: project.blueprint.units?.length,
      first: project.blueprint.units?.[0]
    }))
    expect(project.blueprint.outlineModel).toBeTruthy()

    await action(page, 'generate-storyboard', { projectId, useModel: true, requestId: `real-storyboard-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-storyboard')
    console.log('STEP3_STORYBOARD', JSON.stringify({
      model: project.blueprint.storyboardModel,
      scenes: project.scenes.length,
      shots: project.shots.length,
      first: project.shots[0],
      withDialogue: project.shots.filter((shot: any) => shot.dialogue.trim()).length
    }))
    expect(project.blueprint.storyboardModel).toBeTruthy()
    expect(project.shots.length).toBeGreaterThanOrEqual(6)
    expect(project.shots.every((shot: any) => shot.prompt.length > 20)).toBe(true)
    expect(project.shots.some((shot: any) => shot.dialogue.trim())).toBe(true)

    const firstShot = project.shots[0]
    await action(page, 'generate-shot-image', { projectId, shotId: firstShot.id, requestId: `real-image-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-shot-image', 1_200_000)
    const image = project.assets.find((asset: any) => asset.id === project.shots[0].imageAssetId)
    console.log('STEP4_IMAGE', JSON.stringify({ asset: image?.title, origin: image?.origin, bytes: image?.bytes }))
    expect(image?.origin?.source).toBe('comfyui')

    const voicedShot = project.shots.find((shot: any) => shot.dialogue.trim())
    let voiceNote = ''
    try {
      await action(page, 'generate-voice', { projectId, shotId: voicedShot.id, requestId: `real-voice-${Date.now()}` })
      project = await waitJob(page, projectId, 'generate-voice', 300_000)
      const voice = project.assets.find((asset: any) => asset.id === project.shots.find((shot: any) => shot.id === voicedShot.id)?.voiceAssetId)
      console.log('STEP5_VOICE', JSON.stringify({ asset: voice?.title, origin: voice?.origin, duration: voice?.durationSec }))
      expect(voice).toBeTruthy()
    } catch (err) {
      voiceNote = err instanceof Error ? err.message : String(err)
      console.log('STEP5_VOICE_SKIPPED', voiceNote)
      // 自动化测试进程的系统语音令牌受限；用随包真实录音继续验证下游时间线与成片。
      await action(page, 'import-asset', { projectId, path: join(root, 'resources', 'studio-demo', 'voice-03.wav'), shotId: voicedShot.id })
      project = (await action<{ project: any }>(page, 'get', { projectId })).project
      const voice = project.assets.find((asset: any) => asset.id === project.shots.find((shot: any) => shot.id === voicedShot.id)?.voiceAssetId)
      console.log('STEP5_VOICE_IMPORTED', JSON.stringify({ asset: voice?.title, origin: voice?.origin, duration: voice?.durationSec }))
      expect(voice).toBeTruthy()
    }

    await action(page, 'generate-music', { projectId, kind: 'music', seconds: 12, requestId: `real-music-${Date.now()}` })
    project = await waitJob(page, projectId, 'generate-music', 900_000)
    const music = project.assets.find((asset: any) => asset.kind === 'audio' && asset.tags.includes('music'))
    console.log('STEP6_MUSIC', JSON.stringify({ asset: music?.title, origin: music?.origin, tags: music?.tags, duration: music?.durationSec }))
    expect(music?.origin?.source).toBe('comfyui')
    expect(music?.tags).not.toContain('draft')

    await action(page, 'build-timeline', { projectId, force: true })
    project = (await action<{ project: any }>(page, 'get', { projectId })).project
    console.log('STEP7_TIMELINE', JSON.stringify({
      duration: project.timeline.durationSec,
      clips: project.timeline.clips.length,
      kinds: project.timeline.clips.map((clip: any) => clip.kind)
    }))
    expect(project.timeline.clips.some((clip: any) => clip.kind === 'video')).toBe(true)
    expect(project.timeline.clips.some((clip: any) => clip.kind === 'music')).toBe(true)

    await action(page, 'review', { projectId })
    project = (await action<{ project: any }>(page, 'get', { projectId })).project
    console.log('STEP8_REVIEW', JSON.stringify({
      status: project.stages.review.status,
      checks: project.checks.slice(0, 8).map((check: any) => `${check.level}:${check.title}`)
    }))
    expect(project.checks.length).toBeGreaterThan(0)

    await action(page, 'render', {
      projectId,
      quality: 'draft',
      subtitleMode: 'burn',
      format: 'mp4',
      resolution: '1080p',
      allowMissing: true,
      requestId: `real-render-${Date.now()}`
    })
    project = await waitJob(page, projectId, 'render', 1_200_000)
    const delivery = project.deliveries.find((item: any) => item.kind === 'mp4')
    console.log('STEP9_RENDER', JSON.stringify({ delivery: delivery?.label, bytes: delivery?.bytes, meta: delivery?.meta }))
    expect(delivery).toBeTruthy()
    expect(delivery.bytes).toBeGreaterThan(100_000)
    expect(shotCount).toBeGreaterThanOrEqual(6)
  } finally {
    await morrow.close()
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
})

test.describe("99-real-blueprint", () => {
test.skip(process.env.MORROW_REAL_MODEL !== '1', '真实模型联调：设置 MORROW_REAL_MODEL=1 后运行')
const LOGLINE = '历史博士生穿越回南宋末年，力挽狂澜再造盛世'
async function action<T>(page: import('@playwright/test').Page, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await page.evaluate(
    async (arg) => window.morrow.features.invoke('feature:studio:action', { type: arg.type, ...arg.payload }),
    { type, payload }
  )
  if (!response.ok) throw new Error(response.error?.message || `${type} 失败`)
  return response.data as T
}
async function waitJob(page: import('@playwright/test').Page, projectId: string, actionType: string): Promise<any> {
  const deadline = Date.now() + 300_000
  let lastLog = 0
  while (Date.now() < deadline) {
    const data = await action<{ project: any }>(page, 'get', { projectId })
    const project = data.project
    const job = [...project.jobs].reverse().find((item) => item.retry?.action === actionType)
    if (Date.now() - lastLog > 5_000) {
      lastLog = Date.now()
      console.log('JOB_POLL', JSON.stringify({
        stage: project.stage,
        queuePaused: project.runtime?.queuePaused,
        jobs: project.jobs?.map((item: any) => ({ label: item.label, status: item.status, progress: item.progress, message: item.message, retry: item.retry?.action, error: item.error }))
      }))
    }
    if (job?.status === 'failed') throw new Error(`任务失败：${job.message}`)
    if (job?.status === 'done') return project
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  const data = await action<{ project: any }>(page, 'get', { projectId })
  throw new Error(`任务超时；jobs=${JSON.stringify(data.project.jobs?.map((item: any) => ({ label: item.label, status: item.status, message: item.message })))}`)
}
test('真实模型：南宋灵感生成蓝图为模型内容', async () => {
  test.setTimeout(600_000)
  const dataDir = join(root, 'tmp', `real-blueprint-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  copyFileSync(join(root, 'deliver', 'Morrow Data', 'settings.json'), join(dataDir, 'settings.json'))
  copyFileSync(join(root, 'deliver', 'Morrow Data', 'secrets.json'), join(dataDir, 'secrets.json'))
  // Windows 的 safeStorage 密钥绑定在 Local State，缺了它已保存的 API Key 无法解密
  const localState = join(root, 'deliver', 'Morrow Data', 'Local State')
  if (existsSync(localState)) copyFileSync(localState, join(dataDir, 'Local State'))
  const morrow = await launchMorrow({ name: 'real-blueprint', dataDir, env: { MORROW_TEST: '1' } })
  const page = morrow.page
  try {
    const engineStatus = await action<{ engine: any }>(page, 'status')
    console.log('ENGINE_STATUS', JSON.stringify(engineStatus.engine?.text))
    const created = await action<{ project: any }>(page, 'create', {
      kind: 'drama',
      logline: LOGLINE,
      form: '速成草稿',
      genre: '',
      audience: '',
      tone: '',
      aspect: '16:9',
      targetSeconds: 96,
      constraints: ['角色外观保持一致', '16:9']
    })
    const projectId = created.project.id
    await action(page, 'generate-blueprint', { projectId, useModel: true, requestId: `real-bp-${Date.now()}` })
    const project = await waitJob(page, projectId, 'generate-blueprint')
    const blueprint = project.blueprint
    console.log('REAL_BLUEPRINT', JSON.stringify({
      title: project.title,
      genre: project.brief.genre,
      source: blueprint?.source,
      model: blueprint?.model,
      storyCore: blueprint?.storyCore,
      pitch: blueprint?.pitch,
      characters: blueprint?.characters?.map((item: any) => `${item.name}·${item.role}`),
      places: blueprint?.places?.map((item: any) => item.name),
      units: blueprint?.units?.slice(0, 4)?.map((item: any) => item.title),
      warnings: blueprint?.warnings,
      jobs: project.jobs?.map((item: any) => ({ label: item.label, status: item.status, message: item.message }))
    }, null, 2))
    expect(blueprint?.source, '蓝图必须来自模型').toBe('model')
    expect(JSON.stringify(blueprint)).not.toContain('修伞')
    expect(JSON.stringify(blueprint)).not.toContain('都市奇幻')
    expect(`${project.title} ${blueprint.storyCore} ${blueprint.pitch}`).toMatch(/南宋|临安|宋|历史|盛世/)
    expect(blueprint.characters.length).toBeGreaterThanOrEqual(2)
    expect(blueprint.units.length).toBeGreaterThanOrEqual(6)

    await action(page, 'approve-blueprint', { projectId })
    const approved = await action<{ project: any }>(page, 'get', { projectId })
    const shots = approved.project.shots
    console.log('REAL_SHOTS', JSON.stringify(shots.slice(0, 4).map((shot: any) => ({
      title: shot.title,
      action: shot.action,
      scene: approved.project.scenes.find((scene: any) => scene.id === shot.sceneId)?.location,
      prompt: shot.prompt
    })), null, 2))
    expect(shots.length).toBeGreaterThanOrEqual(6)
    expect(JSON.stringify(shots)).not.toContain('修伞')
    expect(JSON.stringify(shots)).not.toContain('伞骨')
    expect(shots.every((shot: any) => shot.prompt.length > 20)).toBe(true)
  } finally {
    await morrow.close()
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
})
