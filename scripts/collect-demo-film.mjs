// 从真实生产数据目录收集内置漫剧资产：12 镜真实视频、配音、配乐、1080p 成片与海报。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDir = resolve(root, process.argv.find((arg) => arg.startsWith('--data-dir='))?.slice(11) ?? 'tmp/production-data')
const projectsDir = join(dataDir, 'studio', 'projects')
const target = join(root, 'tests', 'fixtures', 'studio-demo')
mkdirSync(target, { recursive: true })
const projectDir = readdirSync(projectsDir).map((id) => join(projectsDir, id)).find((dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).title === '逆行的伞' } catch { return false }
})
if (!projectDir) throw new Error('找不到生产项目')
const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
const shots = [...project.shots].sort((a, b) => a.number - b.number)
if (shots.length !== 12) throw new Error(`镜头数 ${shots.length}`)
function streams(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`无法读取媒体流：${file}`)
  return JSON.parse(result.stdout).streams.map((stream) => stream.codec_type)
}
function assertPictureAndScore(file, label) {
  const types = streams(file)
  if (!types.includes('video')) throw new Error(`${label} 缺少画面`)
  if (!types.includes('audio')) throw new Error(`${label} 缺少配乐音轨`)
  if (types.includes('subtitle')) throw new Error(`${label} 内含字幕轨，违反外挂字幕规则`)
  return types
}
const videos = []
for (const shot of shots) {
  const asset = project.assets.find((item) => item.id === shot.videoAssetId)
  const source = asset ? join(projectDir, asset.path) : ''
  if (!asset || !existsSync(source)) throw new Error(`第 ${shot.number} 镜没有真实视频`)
  if (asset.origin?.source !== 'comfyui') throw new Error(`第 ${shot.number} 镜视频不是 ComfyUI 生成：${asset.origin?.source}`)
  const dest = join(target, `video-${String(shot.number).padStart(2, '0')}.mp4`)
  copyFileSync(source, dest)
  const types = assertPictureAndScore(dest, `第 ${shot.number} 镜视频`)
  videos.push({ number: shot.number, title: shot.title, path: dest, bytes: statSync(dest).size, model: asset.origin?.model, duration: asset.durationSec, streams: types })
}
const voices = []
for (const shot of shots) {
  if (!shot.dialogue.trim()) continue
  const asset = project.assets.find((item) => item.id === shot.voiceAssetId)
  if (!asset) continue
  const source = join(projectDir, asset.path)
  if (!existsSync(source)) continue
  const dest = join(target, `voice-${String(shot.number).padStart(2, '0')}.wav`)
  if (asset.mime === 'audio/wav') copyFileSync(source, dest)
  else {
    const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', source, '-c:a', 'pcm_s16le', '-ar', '48000', dest], { windowsHide: true })
    if (result.status !== 0) throw new Error(`第 ${shot.number} 镜配音转换失败`)
  }
  voices.push({ number: shot.number, path: dest, bytes: statSync(dest).size })
}
const music = [...project.assets].reverse().find((asset) => asset.kind === 'audio' && asset.tags?.includes('music') && asset.origin?.source === 'comfyui')
let musicFile = ''
if (music) {
  const ext = music.mime === 'audio/mpeg' ? 'mp3' : music.mime === 'audio/wav' ? 'wav' : 'mp3'
  musicFile = `music-rain.${ext}`
  copyFileSync(join(projectDir, music.path), join(target, musicFile))
}
const final = [...project.deliveries].filter((delivery) => delivery.kind === 'mp4').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
if (!final) throw new Error('没有成片交付')
if (final.meta?.timelineVersion !== project.timeline.version) throw new Error(`成片时间线版本 ${final.meta?.timelineVersion} 与当前 ${project.timeline.version} 不一致`)
const finalSource = join(projectDir, final.path)
if (!existsSync(finalSource)) throw new Error('成片文件不存在')
const finalDest = join(target, 'demo-final.mp4')
copyFileSync(finalSource, finalDest)
const finalStreams = assertPictureAndScore(finalDest, '成片')
const subtitle = [...project.deliveries].filter((delivery) => delivery.kind === 'srt').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
if (!subtitle) throw new Error('没有外挂字幕交付')
copyFileSync(join(projectDir, subtitle.path), join(target, 'demo-final.srt'))
const poster = join(target, 'drama-final-poster.jpg')
spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', '4', '-i', finalDest, '-frames:v', '1', '-q:v', '2', poster], { windowsHide: true })
for (const old of ['demo-draft.mp4', 'demo-draft-poster.jpg']) {
  try { rmSync(join(target, old), { force: true }) } catch {}
}
if (!musicFile) {
  for (const old of ['music-rain.wav', 'music-rain.mp3']) {
    try { rmSync(join(target, old), { force: true }) } catch {}
  }
} else if (musicFile.endsWith('.mp3')) {
  try { rmSync(join(target, 'music-rain.wav'), { force: true }) } catch {}
}
const manifest = {
  generatedAt: new Date().toISOString(),
  project: { id: project.id, title: project.title, timelineVersion: project.timeline.version, durationSec: project.timeline.durationSec },
  final: { path: finalDest, bytes: statSync(finalDest).size, label: final.label, meta: final.meta, streams: finalStreams }, subtitle: { path: join(target, 'demo-final.srt'), bytes: statSync(join(target, 'demo-final.srt')).size, label: subtitle.label },
  videos, voices, music: musicFile,
  source: { engine: 'ComfyUI', videoModel: videos[0]?.model, note: 'MiniMax-H3 real video generated via Morrow Studio' }
}
writeFileSync(join(target, 'real-film-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(manifest, null, 2))
