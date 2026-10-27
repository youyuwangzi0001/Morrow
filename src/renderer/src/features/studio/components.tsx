import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AudioLines,
  BookOpen,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock3,
  Film,
  Image as ImageIcon,
  Loader2,
  Mic2,
  Music2,
  Package,
  PenLine,
  Sparkles,
  Volume2
} from 'lucide-react'
import type {
  StudioAsset,
  StudioJob,
  StudioKind,
  StudioProject,
  StudioStageId,
  StudioStatus
} from '@shared/studio'
import { formatDuration, studioKindLabel, studioStages, studioStatusLabel } from '@shared/studio'
import { useStudioStore } from './studio-store'

export function StageIcon({ stage, size = 15 }: { stage: StudioStageId | StudioKind; size?: number }): React.JSX.Element {
  const props = { size, strokeWidth: 1.5, 'aria-hidden': true as const }
  switch (stage) {
    case 'blueprint':
      return <Sparkles {...props} />
    case 'outline':
      return <BookOpen {...props} />
    case 'writing':
      return <PenLine {...props} />
    case 'storyboard':
      return <Clapperboard {...props} />
    case 'visuals':
      return <ImageIcon {...props} />
    case 'voice':
      return <Mic2 {...props} />
    case 'music':
      return <Music2 {...props} />
    case 'timeline':
      return <Film {...props} />
    case 'review':
      return <CheckCircle2 {...props} />
    case 'delivery':
      return <Package {...props} />
    case 'short':
    case 'novel':
      return <BookOpen {...props} />
    case 'drama':
      return <Clapperboard {...props} />
    default:
      return <Sparkles {...props} />
  }
}

export function KindBadge({ kind }: { kind: StudioKind }): React.JSX.Element {
  return (
    <span className={`studio-kind is-${kind}`}>
      <StageIcon stage={kind} size={11} />
      {studioKindLabel(kind)}
    </span>
  )
}

export function StatusDot({ status, label = true }: { status: StudioStatus; label?: boolean }): React.JSX.Element {
  return (
    <span className={`studio-status is-${status}`} title={studioStatusLabel(status)}>
      <i aria-hidden />
      {label ? studioStatusLabel(status) : null}
    </span>
  )
}

export function JobStatus({ job }: { job: StudioJob }): React.JSX.Element {
  const active = job.status === 'running' || job.status === 'queued'
  return (
    <span className={`studio-status is-${job.status}`} title={job.message}>
      {active ? <Loader2 size={10} className="studio-spin" aria-hidden /> : <i aria-hidden />}
      {job.status === 'queued' ? '排队' : job.status === 'running' ? `${job.progress}%` : job.status === 'done' ? '完成' : job.status === 'review' ? '需核对' : job.status === 'failed' ? '失败' : '已取消'}
    </span>
  )
}

export function StudioProgress({ value, tone = 'gold', label }: { value: number; tone?: 'gold' | 'patina' | 'rust'; label?: string }): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className={`studio-progress is-${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label ?? '进度'}>
      <span style={{ width: `${percent}%` }} />
    </div>
  )
}

export function SectionTitle({
  eyebrow,
  title,
  aside,
  children
}: {
  eyebrow?: string
  title: ReactNode
  aside?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="studio-section-head">
      <div className="studio-section-copy">
        {eyebrow ? <span className="studio-eyebrow">{eyebrow}</span> : null}
        <h2 className="studio-section-title">{title}</h2>
        {children ? <div className="studio-section-desc">{children}</div> : null}
      </div>
      {aside ? <div className="studio-section-aside">{aside}</div> : null}
    </div>
  )
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: 'gold' | 'patina' | 'rust' }): React.JSX.Element {
  return (
    <div className={`studio-stat ${tone ? `is-${tone}` : ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="studio-empty">
      <div className="studio-empty-mark">{icon ?? <Sparkles size={20} strokeWidth={1.4} />}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="studio-empty-action">{action}</div> : null}
    </div>
  )
}

export function AssetImage({
  project,
  assetId,
  alt,
  className,
  preferThumb = true,
  fit = 'cover'
}: {
  project: StudioProject
  assetId: string | null | undefined
  alt?: string
  className?: string
  preferThumb?: boolean
  fit?: 'cover' | 'contain'
}): React.JSX.Element {
  const asset = assetId ? project.assets.find((item) => item.id === assetId) : undefined
  const src = preferThumb ? asset?.thumbUrl ?? asset?.url : asset?.url
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])
  if (!asset || !src || failed) {
    return (
      <div className={`studio-asset-fallback ${className ?? ''}`} style={{ objectFit: fit }}>
        <ImageIcon size={22} strokeWidth={1.2} aria-hidden />
        <span>{asset ? '预览不可用' : '待生成'}</span>
      </div>
    )
  }
  if (asset.kind === 'video') {
    return <video className={className} src={src} muted playsInline preload="metadata" onError={() => setFailed(true)} aria-label={alt} />
  }
  return <img className={className} src={src} alt={alt ?? asset.title} loading="lazy" decoding="async" style={{ objectFit: fit }} onError={() => setFailed(true)} />
}

export function AudioPill({ asset, compact = false }: { asset?: StudioAsset; compact?: boolean }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  if (!asset?.url) {
    return <span className="studio-audio is-missing"><AudioLines size={12} />未生成</span>
  }
  const duration = asset.durationSec ?? 0
  const toggle = (): void => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
  }
  return (
    <span className={`studio-audio ${compact ? 'is-compact' : ''}`}>
      <button type="button" onClick={toggle} aria-label={playing ? '暂停试听' : '试听'} title={playing ? '暂停' : '试听'}>
        {playing ? <Volume2 size={12} /> : <AudioLines size={12} />}
      </button>
      <span className="studio-audio-wave" aria-hidden>
        {Array.from({ length: 14 }).map((_, index) => (
          <i key={index} style={{ height: `${3 + ((index * 5 + asset.id.length) % 9)}px`, opacity: playing ? 0.85 : 0.4 }} />
        ))}
      </span>
      <span className="studio-audio-time mono">{duration ? formatDuration(duration) : playing ? `${time.toFixed(1)}s` : '音频'}</span>
      <audio
        ref={audioRef}
        src={asset.url}
        preload="metadata"
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
      />
    </span>
  )
}

export function Money({ value, unknown = '未知' }: { value: number | null | undefined; unknown?: string }): React.JSX.Element {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="studio-money is-unknown">{unknown}</span>
  return <span className="studio-money">{value === 0 ? '免费' : `¥${value.toFixed(2)}`}</span>
}

export function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export function StageRail(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const focusedStage = useStudioStore((state) => state.focusedStage)
  const stageDefs = useMemo(() => (active ? studioStages(active.kind) : []), [active])
  if (!active) return <div className="studio-stage-rail" />
  return (
    <nav className="studio-stage-rail" aria-label="创作阶段">
      {stageDefs.map((stage, index) => {
        const state = active.stages[stage.id]
        const current = focusedStage === stage.id
        return (
          <button
            key={stage.id}
            type="button"
            className={['studio-stage-item', current ? 'is-current' : '', `is-${state.status}`].join(' ')}
            onClick={() => navigateStage(stage.id)}
            title={stage.label}
          >
            <span className="studio-stage-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="studio-stage-icon"><StageIcon stage={stage.id} size={14} /></span>
            <span className="studio-stage-label">{stage.short}</span>
            <span className="studio-stage-state">
              {state.status === 'done' ? <Check size={11} strokeWidth={2} /> : state.status === 'running' ? <Loader2 size={11} className="studio-spin" /> : state.status === 'failed' ? '!' : null}
            </span>
            {typeof state.progress === 'number' && state.progress > 0 && state.progress < 100 ? (
              <span className="studio-stage-mini"><i style={{ width: `${state.progress}%` }} /></span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}

export function CoverThumb({ project, summary, size = 'md' }: { project?: StudioProject | null; summary?: { coverUrl?: string; kind: StudioKind; title: string }; size?: 'sm' | 'md' | 'lg' }): React.JSX.Element {
  const kind = project?.kind ?? summary?.kind ?? 'short'
  const cover = project?.coverAssetId ? project.assets.find((asset) => asset.id === project.coverAssetId) : undefined
  const src = cover?.thumbUrl ?? cover?.url ?? summary?.coverUrl
  return (
    <div className={`studio-cover is-${kind} is-${size}`}>
      {src ? <img src={src} alt="" loading="lazy" /> : <span className="studio-cover-glyph"><StageIcon stage={kind} size={size === 'lg' ? 34 : 22} /></span>}
      <span className="studio-cover-grain" aria-hidden />
    </div>
  )
}

export function InlineMeta({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="studio-inline-meta">{children}</span>
}

export function ClockMeta({ seconds }: { seconds: number }): React.JSX.Element {
  return (
    <span className="studio-clock mono">
      <Clock3 size={11} strokeWidth={1.5} aria-hidden />
      {formatDuration(seconds)}
    </span>
  )
}

export function useNoticeAutoClear(): void {
  const notice = useStudioStore((state) => state.notice)
  const clear = useStudioStore((state) => state.clearNotice)
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => clear(), notice.kind === 'error' ? 6500 : 3600)
    return () => window.clearTimeout(timer)
  }, [notice, clear])
}

export function JobProgressBanner(): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const cancelJob = useStudioStore((state) => state.cancelJob)
  const setView = useStudioStore((state) => state.setView)
  const job = active ? [...active.jobs].reverse().find((item) => item.status === 'running') ?? [...active.jobs].reverse().find((item) => item.status === 'queued') : undefined
  if (!active || !job) return null
  return (
    <div className="studio-job-banner" role="status">
      <span className="studio-job-pulse" aria-hidden />
      <Loader2 size={13} className="studio-spin" aria-hidden />
      <span className="studio-job-label">{job.label}</span>
      <StudioProgress value={job.progress} label={job.label} />
      <span className="studio-job-message truncate">{job.message}</span>
      <span className="studio-job-percent mono">{job.status === 'queued' ? '排队' : `${job.progress}%`}</span>
      <button type="button" className="studio-job-message-link" onClick={() => setView('review')} title="查看任务消息流">消息流</button>
      <button type="button" className="studio-job-cancel" onClick={() => void cancelJob(job.id)} title="取消任务">取消</button>
    </div>
  )
}

export function NoticeBar(): React.JSX.Element | null {
  useNoticeAutoClear()
  const notice = useStudioStore((state) => state.notice)
  const clear = useStudioStore((state) => state.clearNotice)
  if (!notice) return null
  return (
    <div className={`studio-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button type="button" aria-label="关闭提示" onClick={clear}>×</button>
    </div>
  )
}
