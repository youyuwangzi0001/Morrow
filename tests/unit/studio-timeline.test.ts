import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { StudioStore } from '../../src/main/studio'
import { tempStore, makeDramaProject } from './studio-fixtures'
import { buildTimelineFromProject, sanitizeTimeline, toAss, toSrt } from '../../src/main/studio'
import { timelineDuration } from '../../src/shared/studio'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP ?? 'C:/Windows/Temp', getVersion: () => '0.2.0', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => Buffer.from(v).toString() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

describe('剪辑表计算', () => {
  let store: StudioStore
  let dir = ''

  beforeEach(() => {
    const created = tempStore()
    store = created.store
    dir = created.dir
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('@core:studio-timeline 按镜头顺序装配画面、对白、音效与字幕', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    expect(timeline.durationSec).toBe(16)
    expect(timelineDuration(timeline)).toBe(16)
    const video = timeline.clips.filter((clip) => clip.kind === 'video')
    const dialogue = timeline.clips.filter((clip) => clip.kind === 'dialogue')
    const subtitles = timeline.clips.filter((clip) => clip.kind === 'subtitle')
    const sfx = timeline.clips.filter((clip) => clip.kind === 'sfx')
    expect(video).toHaveLength(2)
    expect(dialogue).toHaveLength(1)
    expect(subtitles).toHaveLength(1)
    expect(sfx.length).toBeGreaterThan(0)
    expect(video[1].start).toBe(8)
    expect(subtitles[0].text).toContain('还能修好吗')
  })

  it('@core:studio-timeline 重新装配时保留同一镜的逐句字幕', () => {
    const project = makeDramaProject(store)
    project.shots[0].dialogue = '第一句。第二句。'
    const first = buildTimelineFromProject(project)
    const old = first.clips.filter((clip) => clip.kind === 'subtitle' && clip.shotId === project.shots[0].id)
    expect(old).toHaveLength(1)
    first.clips = first.clips.filter((clip) => clip.kind !== 'subtitle')
    first.clips.push(
      { ...old[0], id: 'sub-a', text: '第一句。', start: 0, duration: 2 },
      { ...old[0], id: 'sub-b', text: '第二句。', start: 2, duration: 2 }
    )
    project.timeline = first
    const rebuilt = buildTimelineFromProject(project)
    const subtitles = rebuilt.clips.filter((clip) => clip.kind === 'subtitle' && clip.shotId === project.shots[0].id)
    expect(subtitles.map((clip) => clip.text)).toEqual(['第一句。', '第二句。'])
    expect(subtitles.map((clip) => clip.start)).toEqual([0, 2])
  })

  it('@core:studio-timeline 重新装配时优先使用正式配乐，而不是更早的草稿或样例配乐', () => {
    const project = makeDramaProject(store)
    project.assets = project.assets.filter((asset) => !asset.tags.includes('music'))
    const draft = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt draft'),
      title: '配乐草稿 · 雨',
      mime: 'audio/wav',
      kindHint: 'audio',
      tags: ['music', 'draft'],
      origin: { source: 'local' },
      metadata: { durationSec: 4 }
    })
    const demo = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt demo'),
      title: '样例配乐',
      mime: 'audio/wav',
      kindHint: 'audio',
      tags: ['music', 'demo'],
      origin: { source: 'demo' },
      metadata: { durationSec: 4 }
    })
    const formal = store.addAsset(project, {
      bytes: Buffer.from('RIFF0000WAVEfmt formal'),
      title: 'ACE-Step 正式配乐',
      mime: 'audio/mpeg',
      kindHint: 'audio',
      tags: ['music', 'model'],
      origin: { source: 'comfyui', model: 'ACE-Step 1.5' },
      metadata: { durationSec: 4 }
    })
    const timeline = buildTimelineFromProject(project)
    const clip = timeline.clips.find((item) => item.kind === 'music')
    expect(clip?.assetId).toBe(formal.id)
    expect(clip?.assetId).not.toBe(draft.id)
    expect(clip?.assetId).not.toBe(demo.id)
    project.musicAssetId = draft.id
    expect(buildTimelineFromProject(project).clips.find((item) => item.kind === 'music')?.assetId).toBe(draft.id)
  })

  it('@core:studio-timeline SRT 与 ASS 时间码和文本正确', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    const srt = toSrt(timeline)
    expect(srt).toContain('00:00:00,000 --> 00:00:08,000')
    expect(srt).toContain('还能修好吗？')
    const ass = toAss(timeline)
    expect(ass).toContain('[V4+ Styles]')
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:08.00')
    expect(ass).toContain('还能修好吗？')
  })

  it('@core:studio-timeline ASS 逐条导出字幕字号、颜色与底板', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    const subtitle = timeline.clips.find((clip) => clip.kind === 'subtitle')!
    subtitle.style = { yPercent: 80, size: 60, color: '#ff0000', background: true }
    const boxed = toAss(timeline)
    expect(boxed).toContain('Style: MorrowBox')
    expect(boxed).toContain('\\fs60')
    expect(boxed).toContain('\\c&H000000FF&')
    expect(boxed).toContain(',MorrowBox,,0,0,')

    subtitle.style = { yPercent: 80, size: 42, color: '#00ff00', background: false }
    const plain = toAss(timeline)
    expect(plain).toContain('\\fs42')
    expect(plain).toContain('\\c&H0000FF00&')
    expect(plain).toContain(',Morrow,,0,0,')

    const sanitized = sanitizeTimeline(project, {
      tracks: timeline.tracks.map((track) => ({ ...track })),
      clips: [{ ...subtitle, style: { yPercent: 80, size: 42, color: '#00ff00', background: false } }]
    })
    expect(sanitized.clips[0].style?.background).toBe(false)
  })

  it('@core:studio-timeline 校验时间线：拒绝不存在的轨道和负时长，保留合法片段', () => {
    const project = makeDramaProject(store)
    const raw = {
      tracks: project.timeline.tracks.map((track) => ({ ...track })),
      clips: [
        { id: 'ok', trackId: 'track-video', kind: 'video', label: '合法片段', start: 0, duration: 5, srcIn: 0, speed: 1, volume: 1, transition: 'cut' },
        { id: 'bad-track', trackId: 'track-unknown', kind: 'video', label: '坏轨道', start: 0, duration: 5 },
        { id: 'bad-duration', trackId: 'track-video', kind: 'video', label: '负时长', start: -4, duration: -2 },
        { id: 'bad-volume', trackId: 'track-music', kind: 'music', label: '音量', start: 1, duration: 4, volume: 99, speed: 0.1 }
      ]
    }
    const timeline = sanitizeTimeline(project, raw)
    expect(timeline.clips.some((clip) => clip.id === 'bad-track')).toBe(false)
    expect(timeline.clips.find((clip) => clip.id === 'bad-duration')?.start).toBe(0)
    expect(timeline.clips.find((clip) => clip.id === 'bad-duration')?.duration).toBeGreaterThan(0)
    expect(timeline.clips.find((clip) => clip.id === 'bad-volume')?.volume).toBe(2)
    expect(timeline.clips.find((clip) => clip.id === 'bad-volume')?.speed).toBe(0.25)
    expect(timeline.version).toBeGreaterThan(project.timeline.version)
    expect(timeline.snapshots.length).toBeGreaterThan(0)
  })

  it('@core:studio-timeline 轨道静音与可见片段保持独立', () => {
    const project = makeDramaProject(store)
    const timeline = buildTimelineFromProject(project)
    const muted = {
      tracks: timeline.tracks.map((track) => (track.id === 'track-video' ? { ...track, muted: true } : track)),
      clips: timeline.clips
    }
    const next = sanitizeTimeline({ ...project, timeline }, muted)
    expect(next.tracks.find((track) => track.id === 'track-video')?.muted).toBe(true)
    expect(next.clips.length).toBe(timeline.clips.length)
  })
})
