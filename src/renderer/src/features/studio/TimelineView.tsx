import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  AudioWaveform,
  Captions,
  Clapperboard,
  Copy,
  Disc3,
  Film,
  Image as ImageIcon,
  Layers,
  Loader2,
  Music2,
  Pause,
  Play,
  Redo2,
  Save,
  Scissors,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { StudioAsset, StudioClip, StudioProject, StudioTimeline, StudioTrack } from '@shared/studio'
import { STUDIO_AUDIO_LIBRARY, STUDIO_AUDIO_LICENSE, emptyTimeline, formatDuration, formatTimecode, timelineDuration } from '@shared/studio'
import { Button, Modal } from '../../ui'
import { useStudioStore } from './studio-store'
import { AssetImage } from './components'

const TRACK_HEIGHT: Record<StudioTrack['kind'], number> = { video: 78, dialogue: 46, music: 44, sfx: 40, subtitle: 52 }
const RULER_HEIGHT = 26
const TRACK_LABELS: Record<string, string> = {
  'track-video': '画面',
  'track-dialogue': '对白',
  'track-music': '音乐',
  'track-sfx': '音效',
  'track-subtitle': '字幕'
}
const trackLabel = (track: StudioTrack): string => TRACK_LABELS[track.id] ?? track.name.replace(/^[VAS]\d+\s*/, '')

const HEADER_WIDTH = 96

function newId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${value.replace(/-/g, '').slice(0, 16)}`
}

function clock(seconds: number): string {
  const whole = Math.max(0, seconds)
  const mm = Math.floor(whole / 60)
  const ss = Math.floor(whole % 60)
  const cs = Math.floor((whole - Math.floor(whole)) * 100)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function ticksFor(duration: number, pxPerSec: number): Array<{ time: number; major: boolean }> {
  const targetPx = 76
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = candidates.find((item) => item * pxPerSec >= targetPx) ?? 600
  const ticks: Array<{ time: number; major: boolean }> = []
  for (let time = 0; time <= Math.max(duration, step); time += step) {
    ticks.push({ time, major: Math.round(time / step) % 2 === 0 })
  }
  return ticks
}

function trackTop(timeline: StudioTimeline, trackId: string): number {
  let top = RULER_HEIGHT
  for (const track of timeline.tracks) {
    if (track.id === trackId) return top
    top += TRACK_HEIGHT[track.kind]
  }
  return top
}

function clipTrackKind(timeline: StudioTimeline, clip: StudioClip): StudioTrack['kind'] {
  return timeline.tracks.find((track) => track.id === clip.trackId)?.kind ?? clip.kind
}

function assetOf(project: StudioProject, clip: StudioClip): StudioAsset | undefined {
  return clip.assetId ? project.assets.find((asset) => asset.id === clip.assetId) : undefined
}

function splitText(text: string, ratio: number): [string, string] {
  if (!text) return ['', '']
  const point = Math.max(1, Math.min(text.length - 1, Math.round(text.length * ratio)))
  return [text.slice(0, point), text.slice(point)]
}

function Monitor({
  project,
  timeline,
  time,
  playing,
  seekNonce,
  muted,
  subtitleOn,
  onToggle,
  onSeek,
  masterVolume
}: {
  project: StudioProject
  timeline: StudioTimeline
  time: number
  playing: boolean
  seekNonce: number
  muted: boolean
  subtitleOn: boolean
  onToggle: () => void
  onSeek: (time: number) => void
  masterVolume: number
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [proxyOn, setProxyOn] = useState(false)
  const [proxyBusy, setProxyBusy] = useState(false)
  const [proxyUrl, setProxyUrl] = useState<string | undefined>()
  const [proxyAssetId, setProxyAssetId] = useState<string | undefined>()
  const timeRef = useRef(time)
  timeRef.current = time
  const tracks = useMemo(() => new Map(timeline.tracks.map((track) => [track.id, track])), [timeline.tracks])
  const visualClip = useMemo(
    () => timeline.clips.filter((clip) => clip.kind === 'video').find((clip) => time >= clip.start - 0.001 && time < clip.start + clip.duration) ?? null,
    [timeline.clips, time]
  )
  const subtitleClip = useMemo(
    () => timeline.clips.filter((clip) => clip.kind === 'subtitle' && (clip.text ?? '').trim()).find((clip) => time >= clip.start && time < clip.start + clip.duration) ?? null,
    [timeline.clips, time]
  )
  const visualAsset = visualClip ? assetOf(project, visualClip) : undefined
  const monitorVideoUrl = proxyOn && proxyAssetId === visualAsset?.id && proxyUrl ? proxyUrl : visualAsset?.url

  useEffect(() => {
    if (!proxyOn || visualAsset?.kind !== 'video') return
    if (proxyAssetId === visualAsset.id && proxyUrl) return
    let cancelled = false
    setProxyBusy(true)
    void run<{ url?: string; ready: boolean }>('asset-proxy', { assetId: visualAsset.id })
      .then((result) => {
        if (cancelled) return
        if (result?.ready && result.url) {
          setProxyUrl(result.url)
          setProxyAssetId(visualAsset.id)
        } else {
          notify('error', '低清代理生成失败；请确认 FFmpeg 可用。')
          setProxyOn(false)
        }
      })
      .catch((err) => {
        if (cancelled) return
        notify('error', err instanceof Error ? err.message : String(err))
        setProxyOn(false)
      })
      .finally(() => {
        if (!cancelled) setProxyBusy(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyOn, visualAsset?.id, proxyAssetId, proxyUrl])
  const localProgress = visualClip ? Math.max(0, Math.min(1, (time - visualClip.start) / Math.max(0.1, visualClip.duration))) : 0
  const fade = visualClip && visualClip.transition !== 'cut'
    ? Math.min(1, Math.min(localProgress / 0.04, (1 - localProgress) / 0.04))
    : 1

  const audioKey = timeline.clips
    .filter((clip) => clip.kind === 'dialogue' || clip.kind === 'music' || clip.kind === 'sfx')
    .map((clip) => `${clip.id}:${clip.assetId ?? ''}:${clip.start}:${clip.duration}:${clip.loop ? 1 : 0}`)
    .join('|')

  useEffect(() => {
    const map = audioRefs.current
    const nextIds = new Set<string>()
    for (const clip of timeline.clips) {
      if (clip.kind !== 'dialogue' && clip.kind !== 'music' && clip.kind !== 'sfx') continue
      const asset = assetOf(project, clip)
      if (!asset?.url) continue
      nextIds.add(clip.id)
      let element = map.get(clip.id)
      if (!element) {
        element = new Audio(asset.url)
        element.preload = 'auto'
        element.loop = clip.loop === true
        map.set(clip.id, element)
      }
      if (element.src !== asset.url) element.src = asset.url
    }
    for (const [id, element] of map) {
      if (nextIds.has(id)) continue
      element.pause()
      element.src = ''
      map.delete(id)
    }
  }, [audioKey, project.assets, timeline.clips])

  const syncAudio = useCallback(
    (force: boolean) => {
      const now = timeRef.current
      for (const clip of timeline.clips) {
        if (clip.kind !== 'dialogue' && clip.kind !== 'music' && clip.kind !== 'sfx') continue
        const element = audioRefs.current.get(clip.id)
        const track = tracks.get(clip.trackId)
        if (!element) continue
        const active = now >= clip.start - 0.05 && now < clip.start + clip.duration
        if (!active || track?.muted || muted) {
          element.pause()
          element.volume = 0
          continue
        }
        const target = clip.srcIn + (now - clip.start) * (clip.speed || 1)
        const drift = Math.abs(element.currentTime - target)
        element.volume = Math.max(0, Math.min(1, clip.volume * (track?.volume ?? 1) * masterVolume))
        if (force || drift > 0.45) element.currentTime = Math.max(0, target)
        if (playing && element.paused) {
          void element.play().catch(() => undefined)
        }
        if (!playing && !element.paused) element.pause()
      }
    },
    [masterVolume, muted, playing, timeline.clips, tracks]
  )

  useEffect(() => {
    if (playing) syncAudio(true)
    else {
      for (const element of audioRefs.current.values()) element.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, seekNonce, muted, masterVolume])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => syncAudio(false), 320)
    return () => window.clearInterval(timer)
  }, [playing, syncAudio])

  useEffect(() => {
    return () => {
      for (const element of audioRefs.current.values()) {
        element.pause()
        element.src = ''
      }
      audioRefs.current.clear()
    }
  }, [])

  // 视频素材：拖动时按时间对齐。画面自带的音轨不播放，声音统一由音频轨混音。
  useEffect(() => {
    const video = videoRef.current
    if (!video || !visualAsset || visualAsset.kind !== 'video') return
    if (video.src !== monitorVideoUrl) {
      video.src = monitorVideoUrl ?? ''
      video.load()
    }
    const target = (visualClip?.srcIn ?? 0) + (time - (visualClip?.start ?? 0)) * (visualClip?.speed ?? 1)
    if (Math.abs(video.currentTime - target) > 0.25) {
      try {
        video.currentTime = Math.max(0, target)
      } catch {
        // 元数据尚未就绪
      }
    }
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [visualAsset, visualClip, time, playing, monitorVideoUrl])

  const aspect = timeline.aspect
  return (
    <section className="studio-monitor">
      <header className="studio-monitor-head">
        <span className="studio-monitor-live"><i /> 预览</span>
        <span>{visualClip?.label ?? (subtitleClip?.label ?? '空白')}</span>
        {visualAsset?.kind === 'video' ? (
          <button
            type="button"
            className={`studio-monitor-proxy ${proxyOn ? 'is-on' : ''}`}
            onClick={() => setProxyOn((value) => !value)}
            disabled={proxyBusy}
            title="用 540p 低清代理预览，减轻本机解码压力"
          >
            {proxyBusy ? <Loader2 size={10} className="studio-spin" /> : <ImageIcon size={10} />} {proxyOn ? '低清预览' : '原片'}
          </button>
        ) : null}
        <span className="mono">{formatTimecode(time, timeline.fps)}</span>
      </header>
      <div className={`studio-monitor-frame is-${aspect.replace(':', '-')}`} ref={frameRef}>
        {visualAsset ? (
          <div
            className="studio-monitor-ambient"
            aria-hidden
            style={{ backgroundImage: `url("${visualAsset.thumbUrl ?? visualAsset.url}")` }}
          />
        ) : null}
        <div className="studio-monitor-screen">
          {visualAsset ? (
            visualAsset.kind === 'video' ? (
              <video ref={videoRef} className="studio-monitor-video" muted playsInline preload="auto" />
            ) : (
              <img
                className="studio-monitor-image"
                src={visualAsset.url}
                alt={visualClip?.label ?? ''}
                style={{
                  transform: `scale(${1.02 + localProgress * 0.07}) translate(${(localProgress - 0.5) * 1.2}%, ${(localProgress - 0.5) * -0.8}%)`,
                  opacity: playing ? fade : 1
                }}
              />
            )
          ) : (
            <div className="studio-monitor-empty">
              <Film size={24} strokeWidth={1.1} />
              <span>此处没有画面</span>
            </div>
          )}
          {subtitleOn && subtitleClip ? (
            <div
              className="studio-monitor-subtitle"
              style={{
                bottom: `${Math.max(5, 100 - (subtitleClip.style?.yPercent ?? 86))}%`,
                fontSize: `${Math.max(13, (subtitleClip.style?.size ?? 34) * 0.46)}px`,
                color: subtitleClip.style?.color ?? '#ede7da',
                ...(subtitleClip.style?.background !== false ? { background: 'rgba(10,12,16,.62)' } : {})
              }}
            >
              {subtitleClip.text}
            </div>
          ) : null}
          {visualClip ? (
            <span className="studio-monitor-shot-mark mono">
              {String(project.shots.find((shot) => shot.id === visualClip.shotId)?.number ?? '').padStart(2, '0') || '—'} / {String(project.shots.length).padStart(2, '0')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="studio-transport">
        <button type="button" onClick={() => onSeek(Math.max(0, time - 1))} title="后退 1 秒" aria-label="后退 1 秒"><SkipBack size={15} /></button>
        <button type="button" className="is-play" onClick={onToggle} title={playing ? '暂停' : '播放'} aria-label={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <button type="button" onClick={() => onSeek(Math.min(timelineDuration(timeline), time + 1))} title="前进 1 秒" aria-label="前进 1 秒"><SkipForward size={15} /></button>
        <span className="studio-transport-time mono">{clock(time)} <i>/</i> {clock(timelineDuration(timeline))}</span>
        <span className="studio-transport-spacer" />
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        <span className="studio-transport-meta">{timeline.width}×{timeline.height} · {timeline.fps}fps</span>
      </div>
    </section>
  )
}

function ClipInspector({
  timeline,
  clip,
  onChange,
  onDelete,
  onSplit,
  onDuplicate,
  onUndoClip,
  canUndoClip,
  onClose
}: {
  timeline: StudioTimeline
  clip: StudioClip | null
  onChange: (patch: Partial<StudioClip>) => void
  onDelete: () => void
  onSplit: () => void
  onDuplicate: () => void
  onUndoClip: () => void
  canUndoClip: boolean
  onClose: () => void
}): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [audioOpen, setAudioOpen] = useState(false)
  const [libraryBusy, setLibraryBusy] = useState<string | null>(null)
  const licenseFor = (asset: StudioAsset): string => {
    if (asset.origin?.source === 'sapi') return '本机配音 · 仅用于本项目'
    if (asset.origin?.source === 'cloud-tts') return '云端配音 · 按服务商条款'
    if (asset.origin?.source === 'local') return STUDIO_AUDIO_LICENSE
    return '用户导入 · 需自行确认授权'
  }
  if (!clip) {
    return (
      <aside className="studio-clip-inspector is-empty">
        <div className="studio-clip-inspector-head"><span className="studio-eyebrow">片段详情</span><button type="button" onClick={onClose} title="关闭片段详情" aria-label="关闭片段详情"><X size={13} /></button></div>
        <h3>没有选中片段</h3>
        <p>点击时间线上的片段查看入点、时长、音量与转场；拖中间改位置，拖两端改长短。</p>
        <div className="studio-shortcut-list">
          <span><kbd>Space</kbd> 播放 / 暂停</span>
          <span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> 变速</span>
          <span><kbd>←</kbd><kbd>→</kbd> 逐帧</span>
          <span><kbd>S</kbd> 在播放头分割</span>
          <span><kbd>Del</kbd> 删除片段</span>
          <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销</span>
        </div>
      </aside>
    )
  }
  const track = timeline.tracks.find((item) => item.id === clip.trackId)
  return (
    <aside className="studio-clip-inspector">
      <div className="studio-clip-inspector-head"><span className="studio-eyebrow">片段详情 · {track ? trackLabel(track) : clip.kind}</span><button type="button" onClick={onClose} title="关闭片段详情" aria-label="关闭片段详情"><X size={13} /></button></div>
      <h3>{clip.label}</h3>
      <div className="studio-clip-fields">
        <label><span>起点</span><input value={clip.start} onChange={(event) => onChange({ start: Math.max(0, Number(event.target.value) || 0) })} inputMode="decimal" /><em>秒</em></label>
        <label><span>时长</span><input value={clip.duration} onChange={(event) => onChange({ duration: Math.max(0.1, Number(event.target.value) || 0.1) })} inputMode="decimal" /><em>秒</em></label>
        <label><span>入点</span><input value={clip.srcIn} onChange={(event) => onChange({ srcIn: Math.max(0, Number(event.target.value) || 0) })} inputMode="decimal" /><em>秒</em></label>
        <label><span>速度</span><input value={clip.speed} onChange={(event) => onChange({ speed: Math.max(0.25, Math.min(4, Number(event.target.value) || 1)) })} inputMode="decimal" /><em>×</em></label>
      </div>
      <label className="studio-range-field">
        <span>音量 <b className="mono">{Math.round(clip.volume * 100)}%</b></span>
        <input type="range" min={0} max={2} step={0.01} value={clip.volume} onChange={(event) => onChange({ volume: Number(event.target.value) })} />
      </label>
      <label className="studio-select-field">
        <span>转场/淡入淡出</span>
        <select value={clip.transition} onChange={(event) => onChange({ transition: event.target.value as StudioClip['transition'] })}>
          <option value="cut">硬切</option>
          <option value="fade-in">淡入</option>
          <option value="fade-out">淡出</option>
          <option value="fade-both">淡入淡出</option>
        </select>
      </label>
      {clip.kind !== 'subtitle' && clip.kind !== 'video' ? (
        <>
          <label className="studio-toggle-field">
            <span title="素材比这一段短时，循环播放填满">循环铺满</span>
            <input type="checkbox" checked={Boolean(clip.loop)} onChange={(event) => onChange({ loop: event.target.checked })} />
          </label>
          <div className="studio-audio-library-line">
            <Button variant="ghost" size="sm" icon={<AudioLines size={12} />} onClick={() => setAudioOpen(true)}>从音频库替换</Button>
            <span>{(() => { const asset = active?.assets.find((item) => item.id === clip.assetId); if (!asset) return '未选择音频'; if (asset.origin?.source === 'sapi') return '本机配音 · 仅用于本项目'; if (asset.origin?.source === 'cloud-tts') return '云端配音 · 按服务商条款'; if (asset.origin?.source === 'local') return STUDIO_AUDIO_LICENSE; return '用户导入 · 需自行确认授权' })()}</span>
          </div>
        </>
      ) : null}
      {clip.kind === 'subtitle' ? (
        <>
          <label className="studio-field is-wide"><span>字幕文本</span><textarea rows={3} value={clip.text ?? ''} onChange={(event) => onChange({ text: event.target.value })} /></label>
          <label className="studio-range-field">
            <span>纵向位置 <b className="mono">{clip.style?.yPercent ?? 86}%</b></span>
            <input type="range" min={10} max={94} step={1} value={clip.style?.yPercent ?? 86} onChange={(event) => onChange({ style: { ...(clip.style ?? {}), yPercent: Number(event.target.value) } })} />
          </label>
          <label className="studio-range-field">
            <span>字号 <b className="mono">{clip.style?.size ?? 34}px</b></span>
            <input type="range" min={18} max={96} step={1} value={clip.style?.size ?? 34} onChange={(event) => onChange({ style: { ...(clip.style ?? {}), size: Number(event.target.value) } })} />
          </label>
          <label className="studio-color-field">
            <span>字幕颜色</span>
            <input type="color" value={clip.style?.color ?? '#ede7da'} onChange={(event) => onChange({ style: { ...(clip.style ?? {}), color: event.target.value } })} />
          </label>
          <label className="studio-toggle-field">
            <span title="给字幕加一层半透明底板，亮背景下更清楚">字幕底板</span>
            <input type="checkbox" checked={clip.style?.background !== false} onChange={(event) => onChange({ style: { ...(clip.style ?? {}), background: event.target.checked } })} />
          </label>
        </>
      ) : null}
      <div className="studio-clip-actions">
        <Button variant="ghost" size="sm" icon={<Undo2 size={12} />} onClick={onUndoClip} disabled={!canUndoClip}>撤销此片段</Button>
        <Button variant="ghost" size="sm" icon={<Scissors size={12} />} onClick={onSplit}>分割</Button>
        <Button variant="ghost" size="sm" icon={<Copy size={12} />} onClick={onDuplicate}>复制片段</Button>
        <Button variant="danger" size="sm" icon={<Trash2 size={12} />} onClick={onDelete}>删除</Button>
      </div>
      <Modal open={audioOpen} onClose={() => setAudioOpen(false)} title="音频库" description="项目音频与内置素材；每个素材都标注来源和授权。" width={680}>
        <div className="studio-audio-library">
          <div className="studio-audio-library-section">
            <span className="studio-audio-library-label">内置素材 · {STUDIO_AUDIO_LICENSE}</span>
            <div className="studio-audio-library-builtin">
              {STUDIO_AUDIO_LIBRARY.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={libraryBusy !== null}
                  onClick={async () => {
                    setLibraryBusy(item.id)
                    try {
                      await run('generate-music', {
                        kind: item.kind === 'sfx' ? item.sfx : 'music',
                        mood: item.mood,
                        seconds: item.seconds
                      })
                      notify('info', `${item.label} 已排队生成；完成后会出现在下方项目音频里。`)
                    } catch {
                      // store 已提示错误
                    } finally {
                      setLibraryBusy(null)
                    }
                  }}
                >
                  {libraryBusy === item.id ? <Loader2 size={15} className="studio-spin" /> : item.kind === 'music' ? <Disc3 size={15} /> : <AudioLines size={15} />}
                  <span><b>{item.label}</b><em>{item.description}</em></span>
                  <i>{item.kind === 'music' ? `${item.seconds}s 配乐` : `${item.seconds}s 音效`}</i>
                </button>
              ))}
            </div>
          </div>
          <div className="studio-audio-library-section">
            <span className="studio-audio-library-label">当前作品音频</span>
            {active?.assets.filter((asset) => asset.kind === 'audio').map((asset) => (
              <button
                key={asset.id}
                type="button"
                className={clip.assetId === asset.id ? 'is-current' : ''}
                onClick={() => {
                  onChange({ assetId: asset.id, label: asset.title, duration: Math.min(clip.duration, asset.durationSec ?? clip.duration), srcIn: 0 })
                  setAudioOpen(false)
                }}
              >
                <Music2 size={15} />
                <span><b>{asset.title}</b><em>{asset.tags.includes('voice') ? '配音' : asset.tags.includes('music') ? '配乐' : '音效'} · {asset.durationSec ? `${asset.durationSec.toFixed(1)}s` : '未知时长'}</em></span>
                <i>{licenseFor(asset)}</i>
              </button>
            ))}
            {!active?.assets.some((asset) => asset.kind === 'audio') ? <p className="studio-hint">作品里还没有音频素材。可以生成内置素材，或在分镜页生成配音/音乐。</p> : null}
          </div>
        </div>
      </Modal>
    </aside>
  )
}

export function TimelineView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const setView = useStudioStore((state) => state.setView)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const selectedClipId = useStudioStore((state) => state.selectedClipId)
  const selectClip = useStudioStore((state) => state.selectClip)
  const [draft, setDraft] = useState<StudioTimeline>(active?.timeline ?? emptyTimeline())
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [pxPerSec, setPxPerSec] = useState(42)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [transportRate, setTransportRate] = useState(1)
  const [seekNonce, setSeekNonce] = useState(0)
  const [muted, setMuted] = useState(false)
  const [masterVolume, setMasterVolume] = useState(1)
  const [subtitleOn, setSubtitleOn] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [building, setBuilding] = useState(false)
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({})
  const waveformPending = useRef(new Set<string>())
  const [drag, setDrag] = useState<{ clipId: string; mode: 'move' | 'trim-left' | 'trim-right'; startX: number; originalStart: number; originalDuration: number; originalSrcIn: number } | null>(null)
  const [dragPreview, setDragPreview] = useState(false)
  const timelineInspectorOpen = useStudioStore((state) => state.timelineInspectorOpen)
  const setTimelineInspectorOpen = useStudioStore((state) => state.setTimelineInspectorOpen)
  const snake = useRef<{ undo: Array<{ tracks: StudioTrack[]; clips: StudioClip[] }>; redo: Array<{ tracks: StudioTrack[]; clips: StudioClip[] }> }>({ undo: [], redo: [] })
  const clipHistoryRef = useRef<Map<string, StudioClip[]>>(new Map())
  const [clipHistoryTick, setClipHistoryTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | null>(null)
  const savingRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const draftDirtyRef = useRef(dirty)
  draftDirtyRef.current = dirty
  const lastProjectRef = useRef(active?.id ?? '')

  const duration = Math.max(5, timelineDuration(draft))
  const contentWidth = Math.max(720, Math.ceil((duration + 2) * pxPerSec))
  const ticks = useMemo(() => ticksFor(duration, pxPerSec), [duration, pxPerSec])
  const selectedClip = draft.clips.find((clip) => clip.id === selectedClipId) ?? null
  const canUndoSelectedClip = clipHistoryTick >= 0 && Boolean(selectedClip && (clipHistoryRef.current.get(selectedClip.id)?.length ?? 0) > 0)
  const canvasHeight = RULER_HEIGHT + draft.tracks.reduce((sum, track) => sum + TRACK_HEIGHT[track.kind], 0)

  const pushHistory = useCallback((snapshot = draftRef.current) => {
    snake.current.undo.push({ tracks: JSON.parse(JSON.stringify(snapshot.tracks)), clips: JSON.parse(JSON.stringify(snapshot.clips)) })
    if (snake.current.undo.length > 40) snake.current.undo.shift()
    snake.current.redo = []
  }, [])

  const commitDraft = useCallback((next: StudioTimeline, history = false) => {
    if (history) pushHistory()
    const normalized = { ...next, durationSec: timelineDuration(next), updatedAt: Date.now() }
    draftRef.current = normalized
    setDraft(normalized)
    setDirty(true)
    const selected = normalized.clips.find((clip) => clip.id === useStudioStore.getState().selectedClipId)
    if (!selected) selectClip(normalized.clips[0]?.id ?? null)
  }, [pushHistory, selectClip])

  const updateClip = useCallback((clipId: string, patch: Partial<StudioClip>, history = false) => {
    const current = draftRef.current
    const previous = current.clips.find((clip) => clip.id === clipId)
    if (previous) {
      const stack = clipHistoryRef.current.get(clipId) ?? []
      stack.push(JSON.parse(JSON.stringify(previous)) as StudioClip)
      if (stack.length > 30) stack.shift()
      clipHistoryRef.current.set(clipId, stack)
      setClipHistoryTick((value) => value + 1)
    }
    commitDraft({ ...current, clips: current.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch, style: patch.style ?? clip.style } : clip)) }, history)
  }, [commitDraft])

  const undoClipChange = useCallback((clipId: string) => {
    const stack = clipHistoryRef.current.get(clipId)
    const previous = stack?.pop()
    if (!previous) return
    setClipHistoryTick((value) => value + 1)
    commitDraft({ ...draftRef.current, clips: draftRef.current.clips.map((clip) => clip.id === clipId ? previous : clip) }, true)
    notify('info', '已撤销这个片段的上一次修改；其他片段不受影响。')
  }, [commitDraft, notify])

  const saveTimeline = useCallback(async (): Promise<boolean> => {
    const project = activeRef.current
    if (!project) return false
    if (savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    try {
      const result = await run('save-timeline', {
        timeline: {
          tracks: draftRef.current.tracks,
          clips: draftRef.current.clips,
          aspect: draftRef.current.aspect,
          fps: draftRef.current.fps
        }
      })
      if (result.project.timeline) setDraft(result.project.timeline)
      setDirty(false)
      setSaving(false)
      savingRef.current = false
      return true
    } catch {
      setSaving(false)
      savingRef.current = false
      return false
    }
  }, [run])
  const saveRef = useRef(saveTimeline)
  saveRef.current = saveTimeline

  // 作品切换 / 自动装配 / 保存回来时同步；用户正在拖动或手改时不覆盖。
  useEffect(() => {
    if (!active) return
    if (lastProjectRef.current !== active.id) {
      lastProjectRef.current = active.id
      setDraft(active.timeline)
      setTime(0)
      setDirty(false)
      return
    }
    if (drag || dragPreview || dirty) return
    setDraft(active.timeline)
    setTime((value) => Math.min(value, timelineDuration(active.timeline)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.timeline.version, active?.id, dirty, drag, dragPreview])

  useEffect(() => {
    setTime((value) => Math.min(value, timelineDuration(draft)))
  }, [draft.clips.length, draft.durationSec])

  useEffect(() => {
    if (!active) return
    const ids = [...new Set(draft.clips.filter((clip) => clip.kind === 'dialogue' || clip.kind === 'music' || clip.kind === 'sfx').map((clip) => clip.assetId).filter((id): id is string => Boolean(id)))]
    for (const assetId of ids) {
      if (waveforms[assetId] || waveformPending.current.has(assetId)) continue
      waveformPending.current.add(assetId)
      void run<{ peaks: number[] }>('asset-waveform', { assetId })
        .then((result) => {
          if (result?.peaks?.length) setWaveforms((current) => ({ ...current, [assetId]: result.peaks }))
        })
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, draft.clips.length, active?.assets.length])

  const peaksFor = (asset: StudioAsset | undefined, clip: StudioClip, width: number): number[] => {
    const peaks = asset ? waveforms[asset.id] : undefined
    if (!peaks?.length) return []
    const total = asset?.durationSec ?? 0
    const begin = total > 0 ? Math.max(0, Math.min(peaks.length - 1, Math.floor((clip.srcIn / total) * peaks.length))) : 0
    const finish = total > 0
      ? Math.max(begin + 1, Math.min(peaks.length, Math.ceil(((clip.srcIn + clip.duration * (clip.speed || 1)) / total) * peaks.length)))
      : peaks.length
    const slice = peaks.slice(begin, finish)
    const count = Math.max(3, Math.min(48, Math.round(width / 6)))
    return Array.from({ length: count }, (_, index) => slice[Math.min(slice.length - 1, Math.floor((index / count) * slice.length))] ?? 0)
  }

  useEffect(() => {
    if (!dirty) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void saveTimeline(), 1_400)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [draft, dirty, saveTimeline])

  useEffect(() => {
    return () => {
      if (draftDirtyRef.current) void saveRef.current()
    }
  }, [])

  // 播放时钟
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const delta = ((now - last) / 1000) * transportRate
      last = now
      setTime((previous) => {
        const next = previous + delta
        if (next >= duration) {
          setPlaying(false)
          return duration
        }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, transportRate, duration])

  const seek = useCallback((next: number) => {
    setTime(Math.max(0, Math.min(timelineDuration(draftRef.current), next)))
    setSeekNonce((value) => value + 1)
  }, [])

  const togglePlay = useCallback(() => {
    setPlaying((value) => {
      if (!value && time >= timelineDuration(draftRef.current) - 0.01) {
        setTime(0)
        setSeekNonce((nonce) => nonce + 1)
      }
      return !value
    })
  }, [time])

  const selectedOrAtPlayhead = useCallback((): StudioClip | null => {
    const selected = draftRef.current.clips.find((clip) => clip.id === useStudioStore.getState().selectedClipId)
    if (selected && time >= selected.start && time < selected.start + selected.duration) return selected
    return draftRef.current.clips.find((clip) => clip.kind === 'video' && time >= clip.start && time < clip.start + clip.duration)
      ?? draftRef.current.clips.find((clip) => clip.kind === 'subtitle' && time >= clip.start && time < clip.start + clip.duration)
      ?? null
  }, [time])

  const splitClip = useCallback((clip: StudioClip | null) => {
    if (!clip) return
    if (time <= clip.start + 0.05 || time >= clip.start + clip.duration - 0.05) {
      notify('info', '把播放头放到片段中间再分割。')
      return
    }
    const leftDuration = time - clip.start
    const rightDuration = clip.duration - leftDuration
    const right: StudioClip = {
      ...clip,
      id: newId('clip'),
      start: time,
      duration: rightDuration,
      srcIn: clip.srcIn + leftDuration * (clip.speed || 1),
      ...(clip.kind === 'subtitle' && clip.text ? { text: splitText(clip.text, leftDuration / clip.duration)[1] } : {})
    }
    const left = {
      ...clip,
      duration: leftDuration,
      ...(clip.kind === 'subtitle' && clip.text ? { text: splitText(clip.text, leftDuration / clip.duration)[0] } : {})
    }
    commitDraft({ ...draftRef.current, clips: draftRef.current.clips.flatMap((item) => (item.id === clip.id ? [left, right] : [item])) }, true)
    selectClip(right.id)
    notify('success', '已在播放头分割片段。')
  }, [commitDraft, notify, selectClip, time])

  const deleteClip = useCallback((clip: StudioClip | null) => {
    if (!clip) return
    commitDraft({ ...draftRef.current, clips: draftRef.current.clips.filter((item) => item.id !== clip.id) }, true)
    selectClip(null)
  }, [commitDraft, selectClip])

  const duplicateClip = useCallback((clip: StudioClip | null) => {
    if (!clip) return
    const copy = { ...clip, id: newId('clip'), start: clip.start + clip.duration }
    commitDraft({ ...draftRef.current, clips: [...draftRef.current.clips, copy] }, true)
    selectClip(copy.id)
  }, [commitDraft, selectClip])

  const undo = useCallback(() => {
    const snapshot = snake.current.undo.pop()
    if (!snapshot) return
    snake.current.redo.push({ tracks: JSON.parse(JSON.stringify(draftRef.current.tracks)), clips: JSON.parse(JSON.stringify(draftRef.current.clips)) })
    commitDraft({ ...draftRef.current, ...snapshot })
  }, [commitDraft])

  const redo = useCallback(() => {
    const snapshot = snake.current.redo.pop()
    if (!snapshot) return
    snake.current.undo.push({ tracks: JSON.parse(JSON.stringify(draftRef.current.tracks)), clips: JSON.parse(JSON.stringify(draftRef.current.clips)) })
    commitDraft({ ...draftRef.current, ...snapshot })
  }, [commitDraft])

  const addSubtitle = useCallback(() => {
    const clip: StudioClip = {
      id: newId('clip'),
      trackId: 'track-subtitle',
      kind: 'subtitle',
      label: '新字幕',
      start: time,
      duration: 3,
      srcIn: 0,
      speed: 1,
      volume: 1,
      transition: 'cut',
      text: '在这里输入字幕',
      style: { yPercent: 86, size: 34, color: '#ede7da', background: true }
    }
    commitDraft({ ...draftRef.current, clips: [...draftRef.current.clips, clip] }, true)
    selectClip(clip.id)
  }, [commitDraft, selectClip, time])

  const addAsset = useCallback((asset: StudioAsset) => {
    const kind: StudioTrack['kind'] = asset.kind === 'image' || asset.kind === 'video'
      ? 'video'
      : asset.tags.includes('voice') ? 'dialogue' : asset.tags.includes('sfx') ? 'sfx' : 'music'
    const trackId = `track-${kind}`
    const clip: StudioClip = {
      id: newId('clip'),
      trackId,
      kind,
      label: asset.title,
      assetId: asset.id,
      start: time,
      duration: Math.max(0.5, asset.durationSec ?? (asset.kind === 'image' ? 5 : 4)),
      srcIn: 0,
      speed: 1,
      volume: kind === 'music' ? 0.55 : 1,
      transition: 'cut',
      ...(kind === 'music' ? { loop: true } : {})
    }
    commitDraft({ ...draftRef.current, clips: [...draftRef.current.clips, clip] }, true)
    selectClip(clip.id)
    setAssetsOpen(false)
  }, [commitDraft, selectClip, time])

  const rebuild = async (): Promise<void> => {
    if (dirty && !(await saveTimeline())) return
    setBuilding(true)
    try {
      await run('build-timeline', { force: true })
      notify('success', '时间线已按镜头重新装配。')
      setPlaying(false)
      setTime(0)
    } finally {
      setBuilding(false)
      setRebuildOpen(false)
    }
  }

  const build = async (): Promise<void> => {
    if (draftRef.current.clips.length) {
      setRebuildOpen(true)
      return
    }
    if (dirty && !(await saveTimeline())) return
    setBuilding(true)
    try {
      await run('build-timeline')
      notify('success', '时间线已自动装配。')
      setPlaying(false)
      setTime(0)
    } finally {
      setBuilding(false)
    }
  }

  const render = async (quality: 'draft' | 'final'): Promise<void> => {
    if (dirty && !(await saveTimeline())) return
    try {
      await run('render', { quality, subtitleMode: quality === 'draft' ? 'burn' : 'soft', aspect: draft.aspect })
      notify('info', quality === 'draft' ? '动态分镜草稿已排队合成；进度可在交付页查看。' : '成片已排队合成。')
      setView('delivery')
    } catch {
      // store 已提示
    }
  }

  // 键盘
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveRef.current()
        return
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        togglePlay()
      } else if (event.key.toLowerCase() === 'j') {
        setTransportRate((value) => Math.max(0.25, value / 2))
      } else if (event.key.toLowerCase() === 'k') {
        setPlaying(false)
      } else if (event.key.toLowerCase() === 'l') {
        setTransportRate((value) => Math.min(4, value * 2))
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seek(time - 1 / draft.fps)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        seek(time + 1 / draft.fps)
      } else if (event.key.toLowerCase() === 's') {
        splitClip(selectedOrAtPlayhead())
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        const clip = draftRef.current.clips.find((item) => item.id === useStudioStore.getState().selectedClipId)
        if (clip) {
          event.preventDefault()
          deleteClip(clip)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteClip, draft.fps, redo, seek, selectedOrAtPlayhead, splitClip, time, togglePlay, undo])

  // 拖动片段
  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent): void => {
      const delta = (event.clientX - drag.startX) / pxPerSec
      const snapCandidates = draftRef.current.clips
        .filter((clip) => clip.id !== drag.clipId)
        .flatMap((clip) => [clip.start, clip.start + clip.duration])
      snapCandidates.push(0, time)
      let value = 0
      if (drag.mode === 'move') {
        value = Math.max(0, drag.originalStart + delta)
        value = nearest(value, snapCandidates, 10 / pxPerSec)
        setDraft((current) => ({
          ...current,
          clips: current.clips.map((clip) => (clip.id === drag.clipId ? { ...clip, start: value } : clip))
        }))
      } else if (drag.mode === 'trim-left') {
        value = Math.max(0, Math.min(drag.originalStart + drag.originalDuration - 0.2, drag.originalStart + delta))
        value = nearest(value, snapCandidates, 10 / pxPerSec)
        const shift = value - drag.originalStart
        setDraft((current) => ({
          ...current,
          clips: current.clips.map((clip) =>
            clip.id === drag.clipId
              ? {
                  ...clip,
                  start: value,
                  duration: Math.max(0.2, drag.originalDuration - shift),
                  srcIn: Math.max(0, drag.originalSrcIn + shift * (clip.speed || 1))
                }
              : clip
          )
        }))
      } else {
        const end = drag.originalStart + drag.originalDuration + delta
        const snapped = nearest(end, snapCandidates, 10 / pxPerSec)
        setDraft((current) => ({
          ...current,
          clips: current.clips.map((clip) =>
            clip.id === drag.clipId ? { ...clip, duration: Math.max(0.2, snapped - clip.start) } : clip
          )
        }))
      }
      setDragPreview(true)
    }
    const onUp = (): void => {
      setDrag(null)
      setDragPreview(false)
      setDirty(true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, pxPerSec, time])

  if (!active) return <div />
  if (active.kind !== 'drama') {
    return (
      <div className="studio-timeline-empty">
        <Film size={26} strokeWidth={1.2} />
        <h2>时间线属于漫剧</h2>
        <p>小说在写作页按章节创作；想剪片，可以先在顶栏把作品改成漫剧。</p>
      </div>
    )
  }

  const clipRect = (clip: StudioClip): { left: number; width: number; top: number } => ({
    left: clip.start * pxPerSec,
    width: Math.max(6, clip.duration * pxPerSec),
    top: trackTop(draft, clip.trackId) + 4
  })
  const activeDuration = timelineDuration(draft)

  return (
    <div className="studio-timeline-view">
      <header className="studio-timeline-head">
        <div>
          <span className="studio-eyebrow">时间线 · 第 {draft.version} 版 {dirty ? '· 未保存' : '· 已保存'}</span>
          <h1>{active.title}</h1>
          <div className="studio-timeline-meta">
            <span>{formatDuration(activeDuration)} · {draft.width}×{draft.height} · {draft.fps}fps</span>
            <span>{draft.clips.length} 片段 · {subtitles(draft).length} 字幕</span>
            <span className={active.stages.delivery.status === 'stale' ? 'is-stale' : ''}>{active.stages.delivery.status === 'stale' ? '时间线已改，旧成片过期' : '时间线编辑'}</span>
          </div>
        </div>
        <div className="studio-timeline-actions">
          <button type="button" className="studio-top-icon" title="撤销 (Ctrl+Z)" onClick={undo} disabled={!snake.current.undo.length}><Undo2 size={14} /></button>
          <button type="button" className="studio-top-icon" title="重做 (Ctrl+Shift+Z)" onClick={redo} disabled={!snake.current.redo.length}><Redo2 size={14} /></button>
          <Button variant="ghost" size="sm" icon={saving ? <Loader2 size={12} className="studio-spin" /> : <Save size={12} />} onClick={() => void saveTimeline()} disabled={saving} title="保存时间线" aria-label="保存">保存</Button>
          <Button variant="ghost" size="sm" icon={building ? <Loader2 size={12} className="studio-spin" /> : <Wand2 size={12} />} onClick={() => void build()} disabled={building} title="自动排好时间线" aria-label="自动排好">自动排好</Button>
          <Button variant="gold" size="sm" icon={<Clapperboard size={12} />} onClick={() => void render('draft')}>合成草稿</Button>
          <Button variant="secondary" size="sm" icon={<Film size={12} />} onClick={() => void render('final')}>导出成片</Button>
        </div>
      </header>

      <div className={`studio-timeline-top ${timelineInspectorOpen ? '' : 'is-single'}`}>
        <Monitor
          project={active}
          timeline={draft}
          time={time}
          playing={playing}
          seekNonce={seekNonce}
          muted={muted}
          subtitleOn={subtitleOn}
          onToggle={togglePlay}
          onSeek={seek}
          masterVolume={masterVolume}
        />
        {timelineInspectorOpen ? (
          <ClipInspector
            timeline={draft}
            clip={selectedClip}
            onChange={(patch) => selectedClip && updateClip(selectedClip.id, patch, false)}
            onDelete={() => selectedClip && deleteClip(selectedClip)}
            onSplit={() => splitClip(selectedClip ?? selectedOrAtPlayhead())}
            onDuplicate={() => selectedClip && duplicateClip(selectedClip)}
            onUndoClip={() => selectedClip && undoClipChange(selectedClip.id)}
            canUndoClip={canUndoSelectedClip}
            onClose={() => setTimelineInspectorOpen(false)}
          />
        ) : null}
      </div>

      <div className="studio-timeline-toolbar">
        <div className="studio-timeline-tools-left">
          <span className="mono studio-playhead-time">{clock(time)}</span>
          <span className="studio-toolbar-sep" />
          <button type="button" className={subtitleOn ? 'is-active' : ''} onClick={() => setSubtitleOn((value) => !value)} title="显示 / 隐藏字幕"><Captions size={14} /> 字幕</button>
          <button type="button" className={muted ? 'is-active' : ''} onClick={() => setMuted((value) => !value)} title="静音预览">{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
          <button type="button" onClick={addSubtitle} title="在播放头添加字幕"><Captions size={13} /> 字幕</button>
          <button type="button" className={assetsOpen ? 'is-active' : ''} onClick={() => setAssetsOpen((value) => !value)} title="素材"><Layers size={13} /> 素材</button>
          <button type="button" className={timelineInspectorOpen ? 'is-active' : ''} onClick={() => { setTimelineInspectorOpen(!timelineInspectorOpen); if (!timelineInspectorOpen && !selectedClipId) selectClip(draft.clips[0]?.id ?? null) }} title="片段属性"><SlidersHorizontal size={13} /> 片段</button>
        </div>
        <div className="studio-timeline-tools-right">
          <span className="studio-zoom-label mono" title="时间线缩放">{Math.round(pxPerSec)} 像素/秒</span>
          <button type="button" onClick={() => setPxPerSec((value) => Math.max(16, Math.round(value * 0.8)))} title="缩小"><ZoomOut size={14} /></button>
          <input type="range" min={16} max={200} value={pxPerSec} onChange={(event) => setPxPerSec(Number(event.target.value))} aria-label="时间线缩放" />
          <button type="button" onClick={() => setPxPerSec((value) => Math.min(200, Math.round(value * 1.25)))} title="放大"><ZoomIn size={14} /></button>
          <Button variant="ghost" size="sm" onClick={() => navigateStage('delivery')}>交付页</Button>
        </div>
      </div>

      <div className="studio-timeline-editor">
        <div className="studio-track-headers" style={{ width: HEADER_WIDTH }}>
          <div className="studio-track-ruler-pad" />
          {draft.tracks.map((track) => (
            <div key={track.id} className="studio-track-header" style={{ height: TRACK_HEIGHT[track.kind] }}>
              <span className={`studio-track-mark is-${track.kind}`} />
              <span>{trackLabel(track)}</span>
              <div>
                <button type="button" className={track.muted ? 'is-on' : ''} title={track.muted ? '取消静音' : '静音轨道'} onClick={() => commitDraft({ ...draftRef.current, tracks: draftRef.current.tracks.map((item) => (item.id === track.id ? { ...item, muted: !item.muted } : item)) }, true)}>
                  {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                </button>
                <button type="button" className={track.locked ? 'is-on' : ''} title={track.locked ? '解锁轨道' : '锁定轨道'} onClick={() => commitDraft({ ...draftRef.current, tracks: draftRef.current.tracks.map((item) => (item.id === track.id ? { ...item, locked: !item.locked } : item)) }, true)}>
                  <Square size={9} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="studio-timeline-scroll" ref={scrollRef} onWheel={(event) => {
          if (event.deltaY !== 0 && !event.ctrlKey) {
            event.currentTarget.scrollLeft += event.deltaY
          }
        }}>
          <div className="studio-timeline-canvas" style={{ width: contentWidth, height: canvasHeight }}>
            <div
              className="studio-ruler"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                seek((event.clientX - rect.left) / pxPerSec)
              }}
              onPointerMove={(event) => {
                if (event.buttons !== 1) return
                const rect = event.currentTarget.getBoundingClientRect()
                seek((event.clientX - rect.left) / pxPerSec)
              }}
            >
              {ticks.map((tick) => (
                <span key={tick.time} className={tick.major ? 'is-major' : ''} style={{ left: tick.time * pxPerSec }}>
                  <i />
                  {tick.major ? <em className="mono">{clock(tick.time).slice(0, 5)}</em> : null}
                </span>
              ))}
            </div>
            {draft.tracks.map((track) => (
              <div
                key={track.id}
                className={`studio-track-row is-${track.kind} ${track.muted ? 'is-muted' : ''}`}
                style={{ top: trackTop(draft, track.id), height: TRACK_HEIGHT[track.kind] }}
              />
            ))}
            {draft.clips.map((clip) => {
              const rect = clipRect(clip)
              const track = draft.tracks.find((item) => item.id === clip.trackId)
              const asset = assetOf(active, clip)
              const isSelected = clip.id === selectedClipId
              return (
                <div
                  key={clip.id}
                  className={['studio-clip', `is-${clip.kind}`, isSelected ? 'is-selected' : '', track?.muted ? 'is-muted' : '', clip.locked ? 'is-locked' : ''].filter(Boolean).join(' ')}
                  style={{ left: rect.left, width: rect.width, top: rect.top, height: TRACK_HEIGHT[clip.kind] - 8 }}
                  onPointerDown={(event) => {
                    if (track?.locked) return
                    event.stopPropagation()
                    selectClip(clip.id)
                    pushHistory()
                    setDrag({ clipId: clip.id, mode: 'move', startX: event.clientX, originalStart: clip.start, originalDuration: clip.duration, originalSrcIn: clip.srcIn })
                  }}
                  title={`${clip.label} · ${clip.start.toFixed(2)}s → ${(clip.start + clip.duration).toFixed(2)}s`}
                >
                  {clip.kind === 'video' && asset ? (
                    asset.kind === 'video' ? (
                      <video src={asset.url} muted playsInline preload="metadata" className="studio-clip-bg" />
                    ) : (
                      <img src={asset.thumbUrl ?? asset.url} alt="" className="studio-clip-bg" loading="lazy" />
                    )
                  ) : null}
                  <span className="studio-clip-edge is-left" onPointerDown={(event) => {
                    if (track?.locked) return
                    event.stopPropagation()
                    selectClip(clip.id)
                    pushHistory()
                    setDrag({ clipId: clip.id, mode: 'trim-left', startX: event.clientX, originalStart: clip.start, originalDuration: clip.duration, originalSrcIn: clip.srcIn })
                  }} />
                  <span className="studio-clip-label">
                    {clip.kind === 'video' ? <ImageIcon size={9} /> : clip.kind === 'dialogue' ? <Volume2 size={9} /> : clip.kind === 'music' ? <Music2 size={9} /> : clip.kind === 'subtitle' ? <Captions size={9} /> : <AudioWaveform size={9} />}
                    <span className="truncate">{clip.kind === 'subtitle' ? clip.label : (clip.text || clip.label)}</span>
                  </span>
                  {clip.kind !== 'subtitle' && clip.kind !== 'video' ? (
                    <span className="studio-waveform" aria-hidden>
                      {peaksFor(asset, clip, rect.width).map((peak, index) => (
                        <i key={index} style={{ height: `${Math.max(4, Math.round(peak * 100))}%` }} />
                      ))}
                    </span>
                  ) : null}
                  {clip.kind === 'subtitle' ? <span className="studio-clip-subtitle">{clip.text}</span> : null}
                  {clip.transition !== 'cut' ? <span className="studio-clip-transition"><Shuffle size={8} /></span> : null}
                  <span className="studio-clip-edge is-right" onPointerDown={(event) => {
                    if (track?.locked) return
                    event.stopPropagation()
                    selectClip(clip.id)
                    pushHistory()
                    setDrag({ clipId: clip.id, mode: 'trim-right', startX: event.clientX, originalStart: clip.start, originalDuration: clip.duration, originalSrcIn: clip.srcIn })
                  }} />
                </div>
              )
            })}
            <div className="studio-playhead" style={{ left: time * pxPerSec, height: canvasHeight }}>
              <span className="mono">{clock(time)}</span>
              <i />
            </div>
          </div>
        </div>
      </div>

      {assetsOpen ? (
        <div className="studio-asset-drawer">
          <header><span>素材库</span><button type="button" onClick={() => setAssetsOpen(false)}>×</button></header>
          <div>
            {active.assets.filter((asset) => asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio').map((asset) => (
              <button key={asset.id} type="button" onClick={() => addAsset(asset)} title="添加到时间线">
                {asset.kind === 'image' ? <img src={asset.thumbUrl ?? asset.url} alt="" /> : asset.kind === 'video' ? <video src={asset.url} muted aria-hidden /> : <span className="studio-asset-audio"><AudioLines size={16} /></span>}
                <span>{asset.title}</span>
                <em>{asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : '音频'}</em>
              </button>
            ))}
            <button type="button" className="studio-asset-import" onClick={() => void useStudioStore.getState().importAssets('audio')}>
              <Upload size={14} /><span>导入音频</span><em>文件</em>
            </button>
            <button type="button" className="studio-asset-import" onClick={() => void useStudioStore.getState().importAssets('video')}>
              <Upload size={14} /><span>导入视频</span><em>文件</em>
            </button>
          </div>
        </div>
      ) : null}

      <Modal
        open={rebuildOpen}
        onClose={() => setRebuildOpen(false)}
        title="自动排好会重建时间线"
        description="当前时间线已有片段。继续会按镜头重新装配，并替换现有的裁剪、音量、转场与手动添加的片段。"
        width={560}
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setRebuildOpen(false)}>取消</Button>
            <Button variant="gold" loading={building} onClick={() => void rebuild()}>仍然自动排好</Button>
          </div>
        }
      >
        <p className="studio-hint">想保留现在的剪辑，请先取消，再导出工程包或复制一份作品。</p>
      </Modal>

      <footer className="studio-timeline-foot">
        <span className="studio-timeline-tip">拖中间改位置，拖两端改长短</span>
        <span><kbd>Space</kbd> 播放 · <kbd>J/K/L</kbd> 变速 · <kbd>←/→</kbd> 逐帧 · <kbd>S</kbd> 分割 · <kbd>Del</kbd> 删除</span>
        <span className="mono">{transportRate}× 预览 · {draft.clips.length} 片段</span>
      </footer>
    </div>
  )
}

function nearest(value: number, candidates: number[], threshold: number): number {
  let result = value
  let distance = threshold
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - value)
    if (delta < distance) {
      distance = delta
      result = candidate
    }
  }
  return result
}

function subtitles(timeline: StudioTimeline): StudioClip[] {
  return timeline.clips.filter((clip) => clip.kind === 'subtitle')
}
