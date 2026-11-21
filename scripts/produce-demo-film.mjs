// 用 Morrow 创作台真实链路制作内置漫剧：MiniMax-H3 逐镜生成画面与纯器乐配乐（无人声、无字幕），本地 Qwen3-TTS 配音，外挂 SRT，时间线检查与 1080p 成片。
// 用法：node scripts/produce-demo-film.mjs [--limit=1] [--no-voice] [--no-music] [--no-render]
import { _electron as electron } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const value = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}
const dataDir = resolve(root, value('data-dir', 'tmp/production-data'))
const chromiumDir = resolve(root, value('chromium-dir', 'tmp/production-chromium'))
const limit = Math.max(1, Math.min(12, Number(value('limit', '12')) || 12))
const doVoice = !has('--no-voice')
const doMusic = !has('--no-music')
const doRender = !has('--no-render')
const force = has('--force')
const videoInstruction = value('instruction', '')
const videoMode = value('mode', 'reference')
const onlyShot = Number(value('shot', '0')) || 0
const runtimeTemp = join(chromiumDir, 'runtime-temp')
mkdirSync(dataDir, { recursive: true })
mkdirSync(chromiumDir, { recursive: true })
mkdirSync(runtimeTemp, { recursive: true })

const env = { ...process.env, MORROW_TEST: '1', TEMP: runtimeTemp, TMP: runtimeTemp }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${chromiumDir}`, `--data-dir=${dataDir}`, '--test-mode'],
  cwd: root,
  env,
  timeout: 120_000
})
let page
const log = (message) => console.log(`[produce] ${new Date().toISOString().slice(11, 19)} ${message}`)

async function action(type, payload = {}) {
  const result = await page.evaluate(async (input) => {
    return window.morrow.features.invoke('feature:studio:action', input)
  }, { type, ...payload })
  if (!result.ok) throw new Error(`${type}: ${result.error?.message || 'action failed'}`)
  return result.data
}

async function current(projectId) {
  return (await action('get', { projectId })).project
}

async function waitJob(projectId, jobId, label) {
  let last = -1
  for (;;) {
    const project = await current(projectId)
    const job = project.jobs.find((item) => item.id === jobId)
    if (!job) throw new Error(`${label}: job missing`)
    if (job.status === 'done' || job.status === 'review') {
      log(`${label} 完成 · ${job.message || job.status}`)
      return job
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`${label} ${job.status}: ${job.error || job.message}`)
    }
    const bucket = Math.floor((job.progress || 0) / 10)
    if (bucket !== last) {
      last = bucket
      log(`${label} ${job.status} ${job.progress || 0}% · ${job.message || ''}`)
    }
    await delay(3_000)
  }
}

const report = { startedAt: new Date().toISOString(), dataDir, shots: [], voice: null, music: null, timeline: null, review: null, render: null }
try {
  page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForSelector('.titlebar', { timeout: 60_000 })
  const media = await page.evaluate(async () => window.morrow.features.invoke('feature:media:status'))
  if (!media.ok) throw new Error(media.error?.message || 'media status failed')
  const video = media.data.models.find((model) => model.id === 'video')
  const audio = media.data.models.find((model) => model.id === 'audio')
  log(`ComfyUI ${media.data.engine.online ? 'online' : 'offline'} · video ${video?.ready ? 'ready' : 'not-ready'} · modes ${JSON.stringify(video?.modes || {})} · music ${audio?.ready ? 'ready' : 'not-ready'}`)
  if (!media.data.engine.online || !video?.ready) throw new Error('本地视频模型未就绪，停止真实制作')
  report.media = { engine: media.data.engine, video, audio, nodes: media.data.nodes }

  const listed = await action('list')
  const demo = listed.projects.find((project) => project.kind === 'drama' && project.title === '逆行的伞')
  if (!demo) throw new Error('内置《逆行的伞》不存在')
  let project = await current(demo.id)
  const shots = [...project.shots].sort((a, b) => a.number - b.number)
  log(`项目 ${project.id} · ${shots.length} 镜 · timeline v${project.timeline.version}`)

  const targets = onlyShot ? shots.filter((shot) => shot.number === onlyShot) : shots.slice(0, limit)
  for (const shot of targets) {
    const before = await current(demo.id)
    const currentShot = before.shots.find((item) => item.id === shot.id)
    const currentVideo = before.assets.find((asset) => asset.id === currentShot?.videoAssetId)
    if (currentVideo?.origin?.source === 'comfyui' && !force) {
      log(`第 ${shot.number} 镜已是 ComfyUI 真实视频，跳过`)
      report.shots.push({ number: shot.number, status: 'existing', assetId: currentVideo.id })
      continue
    }
    log(`第 ${shot.number} 镜开始生成真实视频：${shot.title}`)
    const queued = await action('generate-shot-video', {
      projectId: demo.id,
      shotId: shot.id,
      ...(videoInstruction ? { instruction: videoInstruction } : {}),
      ...(videoMode === 'first-only' ? { mode: 'first-only' } : {}),
      requestId: `real-video-${shot.number}-${Date.now()}`
    })
    const job = await waitJob(demo.id, queued.job.id, `第 ${shot.number} 镜视频`)
    const after = await current(demo.id)
    const updated = after.shots.find((item) => item.id === shot.id)
    const asset = after.assets.find((item) => item.id === updated?.videoAssetId)
    report.shots.push({ number: shot.number, status: job.status, assetId: asset?.id, title: asset?.title, model: asset?.origin?.model })
    log(`第 ${shot.number} 镜视频已入库 ${asset?.title || ''}`)
  }

  if (doVoice) {
    project = await current(demo.id)
    const targetsVoice = project.shots.filter((shot) => shot.dialogue.trim()).map((shot) => shot.id)
    if (targetsVoice.length) {
      log(`重新生成 ${targetsVoice.length} 段本地配音`)
      const queued = await action('generate-voice', { projectId: demo.id, shotIds: targetsVoice, requestId: `real-voice-${Date.now()}` })
      const job = await waitJob(demo.id, queued.job.id, '配音')
      report.voice = { status: job.status, message: job.message }
    }
  }

  if (doMusic) {
    project = await current(demo.id)
    log('用本地 ACE-Step 生成新配乐')
    const queued = await action('generate-music', {
      projectId: demo.id,
      kind: 'music',
      engine: 'model',
      seconds: Math.max(20, Math.round(project.timeline.durationSec || 96)),
      requestId: `real-music-${Date.now()}`
    })
    const job = await waitJob(demo.id, queued.job.id, '配乐')
    report.music = { status: job.status, message: job.message }
  }

  project = await current(demo.id)
  if (targets.length === shots.length) {
    log('按最新视频/配音/配乐重新装配时间线')
    const built = await action('build-timeline', { projectId: demo.id, force: true })
    report.timeline = { version: built.project?.timeline?.version, duration: built.project?.timeline?.durationSec }
    const reviewed = await action('review', { projectId: demo.id })
    if (reviewed.job?.id) {
      const reviewJob = await waitJob(demo.id, reviewed.job.id, '发布检查')
      report.review = { status: reviewJob.status, message: reviewJob.message }
    } else {
      report.review = { status: reviewed.project?.stages?.review?.status, message: reviewed.project?.stages?.review?.message }
      log(`发布检查：${report.review.message || report.review.status || '完成'}`)
    }
    if (doRender) {
      log('合成 1080p 成片')
      const queued = await action('render', {
        projectId: demo.id,
        quality: 'final',
        resolution: '1080p',
        format: 'mp4',
        aspect: '16:9',
        requestId: `real-render-${Date.now()}`
      })
      const job = await waitJob(demo.id, queued.job.id, '1080p 合成')
      const srtQueued = await action('export', { projectId: demo.id, format: 'srt', requestId: `real-srt-${Date.now()}` })
      const srtJob = await waitJob(demo.id, srtQueued.job.id, '外挂字幕')
      const finalProject = await current(demo.id)
      const delivery = [...finalProject.deliveries].filter((item) => item.kind === 'mp4').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
      const subtitle = [...finalProject.deliveries].filter((item) => item.kind === 'srt').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
      report.render = { status: job.status, delivery: delivery?.label, path: delivery?.path, meta: delivery?.meta }
      report.subtitle = { status: srtJob.status, delivery: subtitle?.label, path: subtitle?.path }
      log(`成片交付：${delivery?.label || job.message} · 外挂字幕 ${subtitle?.label || ''}`)
    }
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(root, 'tmp', 'production-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  log('生产报告已写入 tmp/production-report.json')
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  writeFileSync(join(root, 'tmp', 'production-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.error(`[produce] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (page) await page.screenshot({ path: join(root, 'tmp', 'production-last.png') }).catch(() => {})
  await app.close().catch(() => {})
}
