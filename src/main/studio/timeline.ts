// 剪辑表：只做纯计算，不接触媒体文件。
import type { StudioClip, StudioProject, StudioTimeline, StudioTrack } from '../../shared/studio'
import { emptyTimeline, timelineDuration } from '../../shared/studio'
import { studioId, nowMs } from './store'

export function buildTimelineFromProject(project: StudioProject): StudioTimeline {
  const timeline = emptyTimeline(project.brief.aspect, nowMs())
  timeline.fps = 30
  timeline.width = project.brief.aspect === '9:16' ? 1080 : project.brief.aspect === '1:1' ? 1080 : 1920
  timeline.height = project.brief.aspect === '9:16' ? 1920 : 1080
  const shots = [...project.shots].sort((a, b) => a.number - b.number)
  let cursor = 0
  const visualClips: StudioClip[] = []
  const dialogueClips: StudioClip[] = []
  const subtitleClips: StudioClip[] = []
  for (const shot of shots) {
    const duration = Math.max(1, shot.durationSec || 8)
    const assetId = shot.videoAssetId ?? shot.imageAssetId
    if (assetId) {
      visualClips.push({
        id: studioId('clip'),
        trackId: 'track-video',
        kind: 'video',
        label: `${String(shot.number).padStart(2, '0')} · ${shot.title}`,
        assetId,
        shotId: shot.id,
        start: cursor,
        duration,
        srcIn: 0,
        speed: 1,
        volume: 1,
        transition: shot.number === 1 || shot.number === shots.length ? 'fade-both' : 'cut'
      })
    }
    if (shot.voiceAssetId) {
      const voice = project.assets.find((asset) => asset.id === shot.voiceAssetId)
      const voiceDuration = voice?.durationSec ?? duration
      const clipDuration = Math.min(duration, Math.max(0.5, voiceDuration))
      dialogueClips.push({
        id: studioId('clip'),
        trackId: 'track-dialogue',
        kind: 'dialogue',
        label: `${shot.speaker || '对白'} · ${String(shot.number).padStart(2, '0')}`,
        assetId: shot.voiceAssetId,
        shotId: shot.id,
        start: cursor,
        duration: clipDuration,
        srcIn: 0,
        speed: 1,
        volume: 1,
        transition: 'cut'
      })
    }
    if (shot.dialogue.trim()) {
      subtitleClips.push({
        id: studioId('clip'),
        trackId: 'track-subtitle',
        kind: 'subtitle',
        label: `字幕 · ${String(shot.number).padStart(2, '0')}`,
        shotId: shot.id,
        start: cursor,
        duration,
        srcIn: 0,
        speed: 1,
        volume: 1,
        transition: 'cut',
        text: shot.dialogue,
        style: { yPercent: 86, size: 34, color: '#ede7da', background: true }
      })
    }
    cursor += duration
  }
  timeline.clips.push(...visualClips, ...dialogueClips)
  const music = project.assets.find((asset) => asset.kind === 'audio' && asset.tags.includes('music'))
  if (music && cursor > 0) {
    timeline.clips.push({
      id: studioId('clip'),
      trackId: 'track-music',
      kind: 'music',
      label: music.title,
      assetId: music.id,
      start: 0,
      duration: cursor,
      srcIn: 0,
      speed: 1,
      volume: 0.55,
      transition: 'fade-both',
      loop: true
    })
  }
  const sfx = project.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('sfx'))
  for (const [index, asset] of sfx.entries()) {
    const start = index === 0 ? 0 : index === 1 ? Math.min(cursor * 0.62, Math.max(0, cursor - (asset.durationSec ?? 4))) : Math.min(cursor * 0.82, Math.max(0, cursor - (asset.durationSec ?? 4)))
    timeline.clips.push({
      id: studioId('clip'),
      trackId: 'track-sfx',
      kind: 'sfx',
      label: asset.title,
      assetId: asset.id,
      start,
      duration: Math.min(cursor - start, asset.durationSec ?? 4),
      srcIn: 0,
      speed: 1,
      volume: 0.55,
      transition: 'fade-both',
      loop: (asset.durationSec ?? 4) < cursor - start
    })
  }
  timeline.clips.push(...subtitleClips)
  timeline.clips.sort((a, b) => a.start - b.start)
  timeline.durationSec = cursor
  timeline.version = (project.timeline?.version ?? 0) + 1
  timeline.updatedAt = nowMs()
  timeline.snapshots = [...(project.timeline?.snapshots ?? [])].slice(-19)
  if (project.timeline?.clips.length) {
    timeline.snapshots.push({
      id: studioId('tl'),
      createdAt: nowMs(),
      reason: '重新装配前',
      tracks: project.timeline.tracks,
      clips: project.timeline.clips
    })
  }
  return timeline
}

export function sanitizeTimeline(project: StudioProject, raw: { tracks?: unknown; clips?: unknown; aspect?: unknown; fps?: unknown }): StudioTimeline {
  const base = project.timeline?.tracks?.length ? project.timeline : emptyTimeline(project.brief.aspect)
  const allowedTracks = new Map<string, StudioTrack>(base.tracks.map((track) => [track.id, track]))
  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks
        .filter((track): track is StudioTrack => Boolean(track) && typeof track === 'object')
        .map((track) => {
          const existing = allowedTracks.get(String(track.id))
          return existing
            ? {
                ...existing,
                muted: track.muted === true,
                locked: track.locked === true,
                volume: clampNumber(track.volume, 0, 2, existing.volume)
              }
            : null
        })
        .filter((track): track is StudioTrack => Boolean(track))
    : base.tracks
  const trackIds = new Set(tracks.map((track) => track.id))
  const clips = Array.isArray(raw.clips)
    ? raw.clips
        .filter((clip): clip is Record<string, unknown> => Boolean(clip) && typeof clip === 'object')
        .map((clip) => sanitizeClip(clip, trackIds))
        .filter((clip): clip is StudioClip => Boolean(clip))
    : base.clips
  const aspect = raw.aspect === '9:16' || raw.aspect === '1:1' || raw.aspect === '16:9' ? raw.aspect : base.aspect
  const fps = clampNumber(raw.fps, 24, 60, base.fps)
  const timeline: StudioTimeline = {
    fps,
    width: base.width,
    height: base.height,
    aspect,
    durationSec: timelineDuration({ clips, durationSec: 0 }),
    tracks: tracks.length ? tracks : base.tracks,
    clips: clips.sort((a, b) => a.start - b.start),
    version: base.version + 1,
    updatedAt: nowMs(),
    snapshots: [
      ...base.snapshots.slice(-19),
      { id: studioId('tl'), createdAt: nowMs(), reason: '保存前', tracks: base.tracks, clips: base.clips }
    ].slice(-20)
  }
  return timeline
}

function sanitizeClip(raw: Record<string, unknown>, trackIds: Set<string>): StudioClip | null {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : studioId('clip')
  const trackId = typeof raw.trackId === 'string' ? raw.trackId : ''
  if (!trackIds.has(trackId)) return null
  const kind = raw.kind
  if (!['video', 'dialogue', 'music', 'sfx', 'subtitle'].includes(String(kind))) return null
  const start = clampNumber(raw.start, 0, 24 * 3600, 0)
  const duration = clampNumber(raw.duration, 0.1, 24 * 3600, 1)
  return {
    id,
    trackId,
    kind: kind as StudioClip['kind'],
    label: typeof raw.label === 'string' ? raw.label.slice(0, 120) : '片段',
    ...(typeof raw.assetId === 'string' ? { assetId: raw.assetId } : {}),
    ...(typeof raw.shotId === 'string' ? { shotId: raw.shotId } : {}),
    start,
    duration,
    srcIn: clampNumber(raw.srcIn, 0, 24 * 3600, 0),
    speed: clampNumber(raw.speed, 0.25, 4, 1),
    volume: clampNumber(raw.volume, 0, 2, 1),
    transition: raw.transition === 'fade-in' || raw.transition === 'fade-out' || raw.transition === 'fade-both' ? raw.transition : 'cut',
    ...(raw.loop === true ? { loop: true } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text.slice(0, 2000) } : {}),
    ...(raw.style && typeof raw.style === 'object'
      ? {
          style: {
            ...(Number.isFinite((raw.style as Record<string, unknown>).yPercent)
              ? { yPercent: clampNumber((raw.style as Record<string, unknown>).yPercent, 2, 96, 86) }
              : {}),
            ...(Number.isFinite((raw.style as Record<string, unknown>).size)
              ? { size: clampNumber((raw.style as Record<string, unknown>).size, 18, 96, 34) }
              : {}),
            ...(typeof (raw.style as Record<string, unknown>).color === 'string'
              ? { color: String((raw.style as Record<string, unknown>).color).slice(0, 24) }
              : {}),
            background: (raw.style as Record<string, unknown>).background !== false
          }
        }
      : {}),
    ...(raw.locked === true ? { locked: true } : {})
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

export function subtitleClips(timeline: StudioTimeline): StudioClip[] {
  return timeline.clips
    .filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim())
    .sort((a, b) => a.start - b.start)
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const rest = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(2, '0')}`
}

export function toSrt(timeline: StudioTimeline): string {
  return subtitleClips(timeline)
    .map((clip, index) => `${index + 1}\n${srtTime(clip.start)} --> ${srtTime(clip.start + clip.duration)}\n${clip.text ?? ''}\n`)
    .join('\n')
}

const DEFAULT_SUBTITLE_COLOR = '#ede7da'

/** ASS 颜色是 &HAABBGGRR；把界面里的 #RRGGBB 转成正确的 BGR 顺序。 */
function assColor(value: unknown): string {
  const hex = typeof value === 'string' ? value.trim().replace(/^#/, '') : ''
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '&H00DAE7ED'
  return `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase()
}

export function toAss(timeline: StudioTimeline): string {
  const baseColor = assColor(DEFAULT_SUBTITLE_COLOR)
  const header = `[Script Info]
Title: Morrow Studio
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: ${timeline.width}
PlayResY: ${timeline.height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Morrow,Microsoft YaHei,34,${baseColor},&H000000FF,&H99101418,&H99000000,0,0,0,0,100,100,0.5,0,1,2,1,2,64,64,72,1
Style: MorrowBox,Microsoft YaHei,34,${baseColor},&H000000FF,&H99101418,&H80000000,0,0,0,0,100,100,0.5,0,3,1,0,2,64,64,72,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events = subtitleClips(timeline)
    .map((clip) => {
      const style = clip.style ?? {}
      const marginV = Math.round(((100 - (style.yPercent ?? 86)) / 100) * timeline.height)
      const size = Math.max(18, Math.min(96, Math.round(style.size ?? 34)))
      const styleName = style.background === false ? 'Morrow' : 'MorrowBox'
      const text = (clip.text ?? '').replace(/\r?\n/g, '\\N').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      return `Dialogue: 0,${assTime(clip.start)},${assTime(clip.start + clip.duration)},${styleName},,0,0,${Math.max(0, marginV)},,{\\fs${size}\\c${assColor(style.color)}&}${text}`
    })
    .join('\n')
  return `${header}${events}\n`
}

export function timelineSnapshotForUndo(timeline: StudioTimeline): { tracks: StudioTrack[]; clips: StudioClip[] } {
  return {
    tracks: timeline.tracks.map((track) => ({ ...track })),
    clips: timeline.clips.map((clip) => ({ ...clip, style: clip.style ? { ...clip.style } : undefined }))
  }
}
