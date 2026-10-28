// studio 功能域组件：由 18 个 TSX 文件扁平合并。
import './studio.css'
import type { ReactNode, CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AudioLines, BookOpen, Check, CheckCircle2, Clapperboard, Film, Image as ImageIcon, Loader2, Mic2, Music2, Package, PenLine, Sparkles, Volume2, ArrowUp, Settings2, WandSparkles, X, ArrowRight, ChevronDown, Pencil, PencilLine, SquarePen, RefreshCw, SlidersHorizontal, Users, ArrowDownToLine, ArrowUpToLine, Boxes, Copy, Download, ExternalLink, GitBranch, ImagePlus, LayoutGrid, Maximize2, Plus, Redo2, Search, Trash2, Type, Undo2, Ungroup, Video, ZoomIn, ZoomOut, AlertTriangle, FileArchive, FileCode2, FileSearch, FileText, FileType, FolderOpen, Play, ShieldCheck, Subtitles, ArrowUpRight, BookMarked, Library, CircleAlert, Clock3, Info, Wrench, ArrowDown, Captions, ChevronRight, GalleryHorizontalEnd, Images, Lock, LockOpen, Mic, Upload, Wand2, Eye, Flag, FileClock, Globe2, FolderPlus, Layers, Network, PackagePlus, PlusCircle, Minimize2, FileDown, Hash, ScrollText, AudioWaveform, Disc3, Pause, Save, Scissors, Shuffle, SkipBack, SkipForward, Square, VolumeX, RotateCcw, ArchiveRestore, FolderCog, FilePlus2, Minus, PanelRight, Sun, Moon } from 'lucide-react'
import type { StudioAsset, StudioJob, StudioKind, StudioProject, StudioStageId, StudioStatus, StudioChatMessage, StudioEditPlan, StudioMessageSource, StudioCharacter, StudioCanvasConnection, StudioCanvasGroup, StudioCanvasNode, StudioCanvasNodeKind, StudioCanvasViewport, StudioShot, StudioDelivery, StudioExportPreflight, StudioProjectSummary, StudioChapter, StudioCandidate, StudioChapterVersion, StudioFact, StudioFaction, StudioProp, StudioRule, StudioVolume, StudioClip, StudioTimeline, StudioTrack, StudioTrashItem, StudioDataDirInfo, StudioEngineStatus } from '@shared/studio'
import { formatDuration, studioKindLabel, studioStages, studioStatusLabel, formatWordCount, isStudioVideoDelivery, studioKindScale, studioJobStatusLabel, formatTimecode, countWords, STUDIO_AUDIO_DRAFT_LICENSE, STUDIO_AUDIO_LIBRARY, STUDIO_AUDIO_LICENSE, emptyTimeline, timelineDuration } from '@shared/studio'
import { useStudioStore, STUDIO_LEFT_MAX, STUDIO_LEFT_MIN, STUDIO_RIGHT_MAX, STUDIO_RIGHT_MIN } from './studio-core'
import { useAppStore } from '../store'
import dark32 from '../../../build/studio-icon-dark-32.png'
import dark48 from '../../../build/studio-icon-dark-48.png'
import dark96 from '../../../build/studio-icon-dark-96.png'
import dark256 from '../../../build/studio-icon-dark-256.png'
import light32 from '../../../build/studio-icon-light-32.png'
import light48 from '../../../build/studio-icon-light-48.png'
import light96 from '../../../build/studio-icon-light-96.png'
import light256 from '../../../build/studio-icon-light-256.png'
import { Button, Modal, Select, Segmented, TextInput, useClickOutside, ResizeHandle } from '../components'
import { renderCanvasSnapshot } from './studio-core'
import { formatBytes } from '@shared/types'
import { studioApi } from './studio-core'
import { previewBrief } from '@shared/types'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands'
import { candidateDiff } from '@shared/types'

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
      {src ? <img src={src} alt="" loading={size === 'lg' ? 'eager' : 'lazy'} /> : <span className="studio-cover-glyph"><StageIcon stage={kind} size={size === 'lg' ? 34 : 22} /></span>}
      <span className="studio-cover-grain" aria-hidden />
    </div>
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

const SOURCES = {
  dark: [
    { size: 32, src: dark32 },
    { size: 48, src: dark48 },
    { size: 96, src: dark96 },
    { size: 256, src: dark256 }
  ],
  light: [
    { size: 32, src: light32 },
    { size: 48, src: light48 },
    { size: 96, src: light96 },
    { size: 256, src: light256 }
  ]
}

/** 创作台品牌徽记：按当前主题与显示尺寸选择最接近的 2× 切片。 */
export function StudioMark({ size = 16, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  const theme = useAppStore((state) => state.theme)
  const sources = SOURCES[theme === 'light' ? 'light' : 'dark']
  const target = size * 2
  const source = sources.find((item) => item.size >= target) ?? sources[sources.length - 1]
  return (
    <img
      className={['studio-mark', className].filter(Boolean).join(' ')}
      src={source.src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      aria-hidden
    />
  )
}

function PlanCard({ plan }: { plan: StudioEditPlan }): React.JSX.Element {
  const applyPlan = useStudioStore((state) => state.applyPlan)
  const cancelPlan = useStudioStore((state) => state.cancelPlan)
  const run = useStudioStore((state) => state.run)
  const assistantBusy = useStudioStore((state) => state.assistantBusy)
  const status = plan.status
  return (
    <div className={`studio-plan-card is-${status}`}>
      <header>
        <span className="studio-plan-icon"><WandSparkles size={13} /></span>
        <div><b>{plan.title}</b><span>{plan.actions.length} 步修改 · 先预览，确认后执行</span></div>
        <span className={`studio-plan-status is-${status}`}>{status === 'pending' ? '待确认' : status === 'applied' ? '已应用' : status === 'undone' ? '已撤销' : '已取消'}</span>
      </header>
      <div className="studio-plan-body">
        {plan.effects.map((effect) => <p key={effect}><Check size={10} /> {effect}</p>)}
        <div className="studio-plan-foot">
          <span>预计 {plan.estimate.seconds ? `${plan.estimate.seconds} 秒` : '即时'} · <Money value={plan.estimate.cost} /></span>
          {plan.estimate.note ? <em>{plan.estimate.note}</em> : null}
        </div>
      </div>
      {status === 'pending' ? (
        <footer>
          <button type="button" className="studio-plan-cancel" onClick={() => void cancelPlan(plan.id)} disabled={assistantBusy}>取消</button>
          <button type="button" className="studio-plan-apply" onClick={() => void applyPlan(plan.id)} disabled={assistantBusy}>
            {assistantBusy ? <Loader2 size={12} className="studio-spin" /> : <Check size={12} />} 用这套方案
          </button>
        </footer>
      ) : null}
      {status === 'applied' && plan.undoVersion ? (
        <footer>
          <span className="studio-plan-undo-note">用完后没再改，可以一次撤销</span>
          <button type="button" className="studio-plan-undo" onClick={() => void run('undo-plan', { planId: plan.id })}>撤销这次修改</button>
        </footer>
      ) : null}
    </div>
  )
}

function AssistantPanelContextLabel(value?: number): string {
  if (!value) return ''
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M 上下文`
  if (value >= 1000) return `${Math.round(value / 1000)}k 上下文`
  return `${value} 上下文`
}

function sourceAlive(active: StudioProject, source: StudioMessageSource): boolean {
  if (source.kind === 'facts') return active.facts.length > 0
  if (source.kind === 'chapter') return active.chapters.some((chapter) => chapter.id === source.id)
  if (source.kind === 'shot') return active.shots.some((shot) => shot.id === source.id)
  return active.timeline.clips.some((clip) => clip.id === source.id)
}

function Message({ message }: { message: StudioChatMessage }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const selectShot = useStudioStore((state) => state.selectShot)
  const selectClip = useStudioStore((state) => state.selectClip)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  if (message.role === 'system') return <div className="studio-assistant-system">{message.text}</div>
  const isUser = message.role === 'user'
  const openSource = (source: StudioMessageSource): void => {
    if (source.kind === 'chapter') selectChapter(source.id)
    else if (source.kind === 'shot') {
      selectShot(source.id)
      navigateStage('storyboard')
    } else if (source.kind === 'clip') {
      selectClip(source.id)
      navigateStage('timeline')
    } else setFactsOpen(true)
  }
  return (
    <div className={`studio-assistant-message ${isUser ? 'is-user' : 'is-assistant'}`}>
      {!isUser ? <span className="studio-assistant-avatar"><StudioMark size={22} /></span> : null}
      <div className="studio-assistant-bubble">
        <p>{message.text}</p>
        {message.plan ? <PlanCard plan={message.plan} /> : null}
        {!isUser && message.sources?.length && active ? (
          <div className="studio-assistant-sources">
            <span>这次参考了</span>
            {message.sources.map((source) => {
              const alive = sourceAlive(active, source)
              return (
                <button
                  key={`${source.kind}:${source.id}`}
                  type="button"
                  className={alive ? '' : 'is-dangling'}
                  title={alive ? '打开来源' : '来源已被删除或替换'}
                  onClick={() => openSource(source)}
                >
                  {source.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AssistantPanel(): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const view = useStudioStore((state) => state.view)
  const selectedChapterId = useStudioStore((state) => state.selectedChapterId)
  const selectedShotId = useStudioStore((state) => state.selectedShotId)
  const selectedClipId = useStudioStore((state) => state.selectedClipId)
  const assistantBusy = useStudioStore((state) => state.assistantBusy)
  const sendAssistant = useStudioStore((state) => state.sendAssistant)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen)
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messages = active?.messages ?? []
  const stageLabel = active ? studioStages(active.kind).find((stage) => stage.id === active.stage)?.label ?? active.stage : ''
  const scrollKey = messages.length + ':' + messages[messages.length - 1]?.text?.length
  useEffect(() => {
    const host = scrollRef.current
    if (!host) return
    host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' })
  }, [scrollKey])
  if (!active) return null
  const chapter = active.chapters.find((item) => item.id === selectedChapterId)
  const shot = active.shots.find((item) => item.id === selectedShotId)
  const clip = active.timeline.clips.find((item) => item.id === selectedClipId)
  const selectionLabel = view === 'writing' && chapter
    ? `第 ${chapter.number} 章 · ${chapter.title}`
    : shot
      ? `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`
      : clip
        ? `片段 · ${clip.label}`
        : ''
  const suggestions = useMemo(() => {
    if (active.kind === 'drama') {
      return [
        shot ? `把镜 ${String(shot.number).padStart(2, '0')} 慢 20%，雨声压低一点，不要改脸。` : '把雨丝方向统一，不要改脸。',
        '配乐压低一点，让雨声更近。',
        '字幕往上挪一点，别挡住伞。',
        '检查一遍连续性，特别是角色外观、服装和道具。'
      ]
    }
    if (chapter) {
      return [
        `把第 ${chapter.number} 章的结尾收得更克制。`,
        '精简这一章的对话，保留动作。',
        '检查人物与事实，看看有没有前后矛盾。',
        '给这一章补一个具体的细节，不要解释。'
      ]
    }
    return ['检查人物与事实，看看有没有前后矛盾。', '把最近一章的结尾改得更克制。']
  }, [active.kind, shot, chapter])
  const send = async (value?: string): Promise<void> => {
    const content = (value ?? text).trim()
    if (!content || assistantBusy) return
    setText('')
    await sendAssistant(content).catch(() => undefined)
  }
  const modelLabel = engine?.text.configured ? engine.text.modelLabel ?? '文本模型' : '未连接模型'
  const currentRoute = engine?.text.routes?.find((route) => route.providerId === engine.text.providerId && route.modelId === engine.text.modelId)
  const capabilities = engine?.text.configured
    ? [
        AssistantPanelContextLabel(engine.text.contextWindow),
        engine.text.supportsVision ? '可看图' : '纯文本',
        engine.text.supportsTools ? '会用工具' : ''
      ].filter(Boolean)
    : []
  const capabilityTitle = engine?.text.configured
    ? [
        engine.text.providerLabel,
        engine.text.modelLabel,
        engine.text.contextWindow ? `上下文 ${engine.text.contextWindow.toLocaleString('zh-CN')}` : '',
        engine.text.maxOutput ? `最大输出 ${engine.text.maxOutput.toLocaleString('zh-CN')}` : '',
        engine.text.supportsVision ? '支持图片' : '不支持图片',
        engine.text.supportsTools ? '会用工具' : '不会用工具',
        engine.text.supportsReasoning ? '支持思考' : ''
      ].filter(Boolean).join(' · ')
    : engine?.text.message
  return (
    <aside className="studio-assistant" aria-label="协作者">
      <header className="studio-assistant-head">
        <span className="studio-assistant-mark"><StudioMark size={30} /></span>
        <div>
          <b>协作者</b>
          <span title={capabilityTitle}><i className={engine?.text.configured ? 'is-on' : ''} /> {modelLabel} · 知道当前作品与预算</span>
        </div>
        <div className="studio-assistant-head-actions">
          <button type="button" onClick={() => setSettingsOpen(true)} title="模型与预算"><Settings2 size={13} /></button>
          <button type="button" onClick={() => setAssistantOpen(false)} title="收起协作者"><X size={13} /></button>
        </div>
      </header>

      <div className="studio-assistant-context">
        <span className="studio-assistant-context-label">这次会参考</span>
        {selectionLabel ? <span className="studio-assistant-context-chip">{selectionLabel}</span> : null}
        <span className="studio-assistant-context-chip is-quiet">{stageLabel}</span>
        <span className="studio-assistant-context-chip is-quiet">{active.kind === 'drama' ? `${active.shots.length} 镜` : `${active.chapters.length} 章`}</span>
        <span className="studio-assistant-context-chip is-quiet">预算 ¥{active.runtime.budget.spent.toFixed(2)} / {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</span>
        {currentRoute ? <span className="studio-assistant-context-chip is-quiet">{currentRoute.local ? '本机' : '云端'}</span> : null}
        {capabilities.map((label) => <span key={label} className="studio-assistant-context-chip is-quiet" title={capabilityTitle}>{label}</span>)}
      </div>

      <div className="studio-assistant-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="studio-assistant-intro">
            <span className="studio-assistant-intro-mark"><Sparkles size={18} strokeWidth={1.3} /></span>
            <h2>先看，再决定。</h2>
            <p>我会先给方案，再改作品。候选稿不会自动覆盖你写的正文，花钱前会先停一下确认。</p>
            <div className="studio-assistant-rules">
              <span><i /> 点到哪一段都能回到原处</span>
              <span><i /> 先说清楚会改哪些地方</span>
              <span><i /> 用错了还能撤销</span>
            </div>
          </div>
        ) : null}
        {messages.map((message) => <Message key={message.id} message={message} />)}
        {assistantBusy ? (
          <div className="studio-assistant-thinking">
            <span className="studio-thinking-dots"><i /><i /><i /></span>
            正在整理可执行的动作…
          </div>
        ) : null}
      </div>

      <div className="studio-assistant-suggestions">
        {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => void send(suggestion)} disabled={assistantBusy}>{suggestion}</button>)}
      </div>

      <div className="studio-assistant-composer chat-gold-frame">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={active.kind === 'drama' ? '说人话改片，例如：镜 03 慢 20%，雨声压低…' : '说说想怎么改，例如：第 3 章更克制一点…'}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          aria-label="给协作者的消息"
        />
        <div className="studio-assistant-composer-foot">
          <span>{selectionLabel ? `引用 ${selectionLabel}` : 'Enter 发送 · Shift+Enter 换行'}</span>
          <button type="button" onClick={() => void send()} disabled={!text.trim() || assistantBusy} aria-label="发送">
            {assistantBusy ? <Loader2 size={14} className="studio-spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </aside>
  )
}

function activeJobOf(jobs: StudioJob[], stage: StudioJob['stage']): StudioJob | undefined {
  return [...jobs].reverse().find((job) => job.stage === stage && (job.status === 'running' || job.status === 'queued'))
}

function BriefDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const updateProject = useStudioStore((state) => state.updateProject)
  const [title, setTitle] = useState(active?.title ?? '')
  const [logline, setLogline] = useState(active?.logline ?? '')
  const [tone, setTone] = useState(active?.brief.tone ?? '')
  const [audience, setAudience] = useState(active?.brief.audience ?? '')
  const [style, setStyle] = useState(active?.brief.style ?? '')
  const [saving, setSaving] = useState(false)
  if (!active) return null
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await updateProject({
        title,
        logline,
        brief: { ...active.brief, tone, audience, style }
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="修改作品信息"
      description="这里改的是作品名、一句话和风格。改动不会删掉已写内容，只会提醒你后面需要重新核对。"
      width={620}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>作品名</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="studio-field is-wide"><span>一句话简介</span><textarea rows={4} value={logline} onChange={(event) => setLogline(event.target.value)} /></label>
        <label className="studio-field"><span>整体语气</span><input value={tone} onChange={(event) => setTone(event.target.value)} placeholder="克制、潮湿、温柔" /></label>
        <label className="studio-field"><span>给谁看</span><input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="谁会读 / 看这部作品" /></label>
        <label className="studio-field is-wide"><span>风格</span><input value={style} onChange={(event) => setStyle(event.target.value)} placeholder="文字与画面风格" /></label>
      </div>
    </Modal>
  )
}

function BlueprintDialog({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const blueprint = active?.blueprint
  const [storyCore, setStoryCore] = useState(blueprint?.storyCore ?? '')
  const [pitch, setPitch] = useState(blueprint?.pitch ?? '')
  const [emotion, setEmotion] = useState(blueprint?.emotion ?? '')
  const [audience, setAudience] = useState(blueprint?.audience ?? '')
  const [structure, setStructure] = useState(blueprint?.structure ?? '')
  const [units, setUnits] = useState(blueprint?.units.map((unit) => ({ ...unit })) ?? [])
  const [saving, setSaving] = useState(false)
  if (!blueprint) return null
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('save-blueprint', {
        blueprint: {
          storyCore,
          pitch,
          emotion,
          audience,
          structure,
          units: units.map((unit) => ({
            index: unit.index,
            title: unit.title,
            summary: unit.summary,
            ...(typeof unit.seconds === 'number' ? { seconds: unit.seconds } : {}),
            ...(typeof unit.wordTarget === 'number' ? { wordTarget: unit.wordTarget } : {})
          }))
        }
      })
      notify('success', blueprint.approved ? '蓝图已更新；下游内容已标记为需要重新核对。' : '蓝图已保存。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="修改故事蓝图"
      description={blueprint.approved ? '这份蓝图已经确认。修改故事主线或章节/镜头会保留已有正文，只提醒你后面需要重新核对。' : '确认前可以逐项修改；确认后才会开始写正文或做画面，并产生费用。'}
      width={780}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存蓝图</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>故事主线</span><textarea rows={3} value={storyCore} onChange={(event) => setStoryCore(event.target.value)} /></label>
        <label className="studio-field is-wide"><span>看点</span><textarea rows={3} value={pitch} onChange={(event) => setPitch(event.target.value)} /></label>
        <label className="studio-field"><span>情绪基调</span><input value={emotion} onChange={(event) => setEmotion(event.target.value)} /></label>
        <label className="studio-field"><span>给谁看</span><input value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
        <label className="studio-field is-wide"><span>故事结构</span><input value={structure} onChange={(event) => setStructure(event.target.value)} /></label>
      </div>
      <div className="studio-blueprint-edit-units">
        <span className="studio-eyebrow">{active.kind === 'drama' ? '逐项修改镜头' : '逐项修改章节'}</span>
        <div className="studio-blueprint-edit-head" aria-hidden>
          <span />
          <span>名称</span>
          <span>这段讲什么</span>
          <span>{active.kind === 'drama' ? '秒数' : '字数'}</span>
        </div>
        {units.map((unit, index) => (
          <div key={unit.index} className="studio-blueprint-edit-unit">
            <span className="mono">{String(unit.index).padStart(2, '0')}</span>
            <input
              value={unit.title}
              aria-label={`第 ${unit.index} 项标题`}
              onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))}
            />
            <input
              value={unit.summary}
              aria-label={`第 ${unit.index} 项梗概`}
              onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, summary: event.target.value } : item))}
            />
            {typeof unit.seconds === 'number' ? (
              <input
                value={unit.seconds}
                inputMode="numeric"
                aria-label={`第 ${unit.index} 项秒数`}
                onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, seconds: Math.max(1, Number(event.target.value) || 1) } : item))}
              />
            ) : (
              <input
                value={unit.wordTarget ?? ''}
                inputMode="numeric"
                aria-label={`第 ${unit.index} 项目标字数`}
                onChange={(event) => setUnits((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, wordTarget: Math.max(100, Number(event.target.value) || 100) } : item))}
              />
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

export function CharacterDialog({ character, onClose }: { character: StudioCharacter | null; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const [draft, setDraft] = useState<StudioCharacter | null>(character)
  const [saving, setSaving] = useState(false)
  if (!active || !character || !draft) return null
  const voiceOptions = [
    { value: '', label: '跟随系统默认' },
    ...(engine?.voices ?? []).map((voice) => ({ value: voice.name, label: `${voice.name}${voice.culture ? ` · ${voice.culture}` : ''}` }))
  ]
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('upsert-character', {
        character: {
          ...draft,
          relationships: draft.relationships.filter((relationship) => relationship.target.trim() && relationship.label.trim())
        }
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`修改人物 · ${character.name}`}
      description="这些设定会带进写作和画面；每个人物的事实都能回到具体章节。"
      width={680}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存人物</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field"><span>名字</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="studio-field"><span>身份</span><input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /></label>
        <label className="studio-field"><span>年龄</span><input value={draft.age ?? ''} onChange={(event) => setDraft({ ...draft, age: event.target.value })} /></label>
        <label className="studio-field"><span>声线</span>
          <Select value={draft.voiceId ?? ''} options={voiceOptions} onChange={(value) => setDraft({ ...draft, voiceId: value })} ariaLabel="人物声线" />
        </label>
        <label className="studio-field is-wide"><span>外观</span><textarea rows={3} value={draft.look} onChange={(event) => setDraft({ ...draft, look: event.target.value })} /></label>
        <label className="studio-field"><span>想要</span><textarea rows={2} value={draft.desire ?? ''} onChange={(event) => setDraft({ ...draft, desire: event.target.value })} /></label>
        <label className="studio-field"><span>害怕</span><textarea rows={2} value={draft.fear ?? ''} onChange={(event) => setDraft({ ...draft, fear: event.target.value })} /></label>
        <label className="studio-field is-wide"><span>秘密</span><textarea rows={2} value={draft.secret ?? ''} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></label>
        <label className="studio-field is-wide"><span>人物变化</span><textarea rows={2} value={draft.arc ?? ''} onChange={(event) => setDraft({ ...draft, arc: event.target.value })} /></label>
        <div className="studio-field is-wide">
          <span>人物关系</span>
          <div className="studio-relationship-editor">
            {draft.relationships.map((relationship, index) => (
              <div key={index} className="studio-relationship-row">
                <input
                  value={relationship.target}
                  placeholder="对方名字"
                  aria-label="关系对象"
                  onChange={(event) => setDraft({
                    ...draft,
                    relationships: draft.relationships.map((item, itemIndex) => itemIndex === index ? { ...item, target: event.target.value } : item)
                  })}
                />
                <input
                  value={relationship.label}
                  placeholder="关系：母亲 / 债主 / 旧友"
                  aria-label="关系说明"
                  onChange={(event) => setDraft({
                    ...draft,
                    relationships: draft.relationships.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item)
                  })}
                />
                <button type="button" aria-label="删除关系" onClick={() => setDraft({ ...draft, relationships: draft.relationships.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
              </div>
            ))}
            <button type="button" className="studio-relationship-add" onClick={() => setDraft({ ...draft, relationships: [...draft.relationships, { target: '', label: '' }] })}>+ 添加一条关系</button>
          </div>
        </div>
      </div>
      {draft.refAssetIds.length ? (
        <div className="studio-character-refs">
          <span>已固定的参考图</span>
          {draft.refAssetIds.map((id) => {
            const asset = active.assets.find((item) => item.id === id)
            return asset ? <img key={id} src={asset.thumbUrl ?? asset.url} alt="" /> : null
          })}
        </div>
      ) : (
        <p className="studio-hint">还没有人物参考图。去画面页导入后，就能在分镜里固定人物长相。</p>
      )}
    </Modal>
  )
}

export function BlueprintView({ onOpenBudget }: { onOpenBudget: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const setView = useStudioStore((state) => state.setView)
  const notify = useStudioStore((state) => state.notify)
  const autoProduce = useStudioStore((state) => state.autoProduce)
  const autoProducing = useStudioStore((state) => state.autoProducing)
  const [approving, setApproving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [showAllUnits, setShowAllUnits] = useState(false)
  const [editBrief, setEditBrief] = useState(false)
  const [editBlueprint, setEditBlueprint] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<StudioCharacter | null>(null)
  if (!active) return <div />
  const blueprint = active.blueprint
  const job = activeJobOf(active.jobs, 'blueprint')
  const approved = Boolean(blueprint?.approved)
  const unitCount = blueprint?.units.length ?? (active.kind === 'drama' ? 12 : 12)
  const goal = active.kind === 'drama' ? `${unitCount} 镜 · ${formatDuration(blueprint?.units.reduce((sum, unit) => sum + (unit.seconds ?? 8), 0) ?? active.brief.targetSeconds ?? 96)}` : `${unitCount} 章 · 约 ${((active.brief.targetWords ?? 18000) / 10000).toFixed(1)} 万字`
  const estimate = blueprint?.estimate
  const costText = estimate
    ? estimate.costMin === null || estimate.costMax === null
      ? '未知'
      : estimate.costMin === estimate.costMax
        ? `¥${estimate.costMin}`
        : `¥${estimate.costMin}–${estimate.costMax}`
    : '—'
  const warnings = blueprint?.warnings ?? []
  const units = blueprint ? (showAllUnits ? blueprint.units : blueprint.units.slice(0, 8)) : []
  const hasWrittenContent = active.chapters.some((chapter) => chapter.content.trim())
  const hasShotAssets = active.shots.some((shot) => shot.imageAssetId || shot.videoAssetId || shot.voiceAssetId)
  const canRegenerate = !approved || (!hasWrittenContent && !hasShotAssets)

  const generate = async (): Promise<void> => {
    if (regenerating) return
    if (!engine?.text.configured) {
      notify('error', '还没有可用的文本模型。请先在右上角设置 → 模型里连接模型，再生成蓝图。')
      return
    }
    if (approved && (hasWrittenContent || hasShotAssets)) {
      notify('error', hasWrittenContent ? '这部作品已经有正文。重新生成不会改动手稿；如果要保留现在这版，请先复制一份作品。' : '这部作品已经有画面或配音。重新生成蓝图会重建镜头并清空素材关联；请先复制一份作品或确认不再需要现有素材。')
      return
    }
    setRegenerating(true)
    try {
      await run('generate-blueprint', { useModel: true, requestId: `bp-${Date.now()}` })
      notify('info', '正在用当前模型重新生成蓝图。')
    } finally {
      setRegenerating(false)
    }
  }

  const approve = async (): Promise<void> => {
    if (!blueprint || approving) return
    if (hasShotAssets) {
      notify('error', '已有画面或配音，确认新蓝图会重建镜头并清空素材关联；请先复制作品或移除素材。')
      return
    }
    setApproving(true)
    try {
      await run('approve-blueprint')
      notify('success', active.kind === 'drama' ? '蓝图已确认，下一步用模型细化大纲与分镜。' : '蓝图已确认，下一步用模型细化章纲。')
      useStudioStore.getState().navigateStage('outline')
    } finally {
      setApproving(false)
    }
  }

  if (!blueprint) {
    return (
      <div className="studio-blueprint">
        <div className="studio-blueprint-head">
          <div>
            <span className="studio-eyebrow">故事蓝图 · 01</span>
            <h1>{active.title}</h1>
            <p>{active.logline}</p>
          </div>
          <div className="studio-blueprint-actions">
            <Button variant="ghost" icon={<PencilLine size={13} />} onClick={() => setEditBrief(true)}>修改资料</Button>
            <Button variant="gold" icon={<Sparkles size={14} />} onClick={() => void generate()} loading={Boolean(job) || regenerating}>
              {job ? '正在生成蓝图' : engine?.text.configured ? '用模型生成故事蓝图' : '连接模型后生成'}
            </Button>
          </div>
        </div>
        <div className="studio-blueprint-generating">
          <div className="studio-generating-mark"><FeatherPulse /></div>
          <h2>{job ? job.message : '还没有故事蓝图'}</h2>
          <p>{job ? '正在根据你的灵感整理故事主线、人物和结构，再请你确认。' : engine?.text.configured ? '会用当前已配置的模型，从你的灵感生成故事主线、人物、结构、风格和预算；确认前不会开始写正文或做画面。' : '还没有可用的文本模型。请先在右上角设置 → 模型里连接模型；蓝图只由真实模型生成。'}</p>
          {job ? <StudioProgress value={job.progress} /> : null}
          {!job ? (
            <div className="studio-generating-hints">
              <span><i /> 不用先想章节名</span>
              <span><i /> {engine?.text.configured ? '蓝图会调用当前模型，费用按实际 token 计入预算' : '生成蓝图必须连接文本模型'}</span>
              <span><i /> 每个字段都可以再改</span>
            </div>
          ) : null}
        </div>
        {editBrief ? <BriefDialog open onClose={() => setEditBrief(false)} /> : null}
      </div>
    )
  }

  return (
    <div className="studio-blueprint">
      <header className="studio-blueprint-head">
        <div className="studio-blueprint-title-block">
          <span className="studio-eyebrow">故事蓝图 · 01 {approved ? '· 已确认' : '· 待确认'}</span>
          <div className="studio-blueprint-title-row">
            <h1>{active.title}</h1>
            <button type="button" className="studio-blueprint-edit-link" onClick={() => setEditBrief(true)} title="修改作品名与一句话">
              <PencilLine size={12} /> 修改资料
            </button>
          </div>
          <p>{active.logline}</p>
          <div className="studio-blueprint-meta">
            <KindBadge kind={active.kind} />
            <span>{goal}</span>
            <span>{blueprint.source === 'model' ? `模型生成 · ${blueprint.model ?? '当前模型'}` : blueprint.source === 'import' ? '示例蓝图' : '本机结构改编'}</span>
            <span>{timeAgo(blueprint.createdAt)}</span>
          </div>
        </div>
        <div className="studio-blueprint-actions">
          {canRegenerate ? (
            <div className="studio-dropdown-group">
              <Button variant="ghost" icon={<RefreshCw size={13} />} loading={regenerating || Boolean(job)} onClick={() => void generate()} title="用当前模型重新生成">重新生成</Button>
            </div>
          ) : null}
          {approved ? (
            <>
              <Button variant="ghost" iconRight={<ArrowRight size={13} />} onClick={() => setView(active.kind === 'drama' ? 'storyboard' : 'writing')}>
                {active.kind === 'drama' ? '去分镜页' : '去写作页'}
              </Button>
              <Button variant="gold" icon={autoProducing ? <Loader2 size={13} className="studio-spin" /> : <Sparkles size={13} />} onClick={() => void autoProduce()} disabled={autoProducing || Boolean(job)} title={active.kind === 'drama' ? '按当前蓝图补齐分镜、画面、配音、配乐，并合成草稿' : '按当前章纲写完全部空章，并运行检查'}>
                {autoProducing ? '正在一键试做' : active.kind === 'drama' ? '一键做到草稿' : '一键写完'}
              </Button>
            </>
          ) : (
            <Button variant="gold" icon={<Check size={14} />} onClick={() => void approve()} loading={approving} disabled={Boolean(job)}>
              确认并开始
            </Button>
          )}
        </div>
      </header>

      {job ? (
        <div className="studio-inline-job">
          <Loader2 size={14} className="studio-spin" />
          <span>{job.label}</span>
          <StudioProgress value={job.progress} />
          <em className="mono">{job.progress}%</em>
          <span className="studio-inline-job-message">{job.message}</span>
        </div>
      ) : null}

      {warnings.length ? (
        <div className="studio-blueprint-warning">
          <span>需要注意</span>
          <div>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
        </div>
      ) : null}

      <div className="studio-blueprint-grid">
        <section className="studio-bp-core">
          <div className="studio-bp-index mono">
            01 / 故事主线
            <button type="button" className="studio-bp-edit" onClick={() => setEditBlueprint(true)}>
              <SquarePen size={11} /> 修改
            </button>
          </div>
          <h2>{blueprint.storyCore}</h2>
          <div className="studio-bp-pillars">
            <div><span>情绪基调</span><b>{blueprint.emotion}</b></div>
            <div><span>给谁看</span><b>{blueprint.audience}</b></div>
            <div><span>故事结构</span><b>{blueprint.structure}</b></div>
          </div>
          <p className="studio-bp-pitch">{blueprint.pitch}</p>
        </section>

        <section className="studio-bp-estimate">
          <div className="studio-bp-index mono">02 / 费用与时间</div>
          <div className="studio-estimate-total">
            <div><b>{costText}</b><span>预计费用</span></div>
            <div><b>{estimate ? `${estimate.minutesMin}–${estimate.minutesMax}` : '—'}<em>分钟</em></b><span>预计时长</span></div>
          </div>
          <div className="studio-estimate-lines">
            {estimate?.lines.map((line) => (
              <div key={line.label}>
                <span>{line.label}</span>
                <b>{line.costMin === null || line.costMax === null ? '未知' : line.costMin === line.costMax ? (line.costMin === 0 ? '免费' : `¥${line.costMin}`) : `¥${line.costMin}–${line.costMax}`}</b>
                {line.note ? <em>{line.note}</em> : null}
              </div>
            ))}
          </div>
          <div className="studio-budget-line">
            <span>项目预算</span>
            <b className="mono">¥{active.runtime.budget.spent.toFixed(2)} / {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</b>
            <button type="button" onClick={onOpenBudget}><SlidersHorizontal size={12} /> 调整预算</button>
          </div>
          <p className="studio-estimate-note">{estimate?.note ?? '费用按实际账单记录；不知道单价时会写“未知”，不会乱估。'}</p>
        </section>
      </div>

      <section className="studio-bp-section">
        <SectionTitle eyebrow="03 / 人物" title="人物：想要什么，害怕什么" aside={<span className="studio-section-side">{blueprint.characters.length} 人物 · 点击卡片修改</span>}>
          人物的想要、害怕和秘密，会带进之后的写作和画面。
        </SectionTitle>
        <div className="studio-character-grid">
          {blueprint.characters.map((character, index) => {
            const current = active.characters.find((item) => item.id === character.id) ?? character
            return (
              <button key={character.id} type="button" className="studio-character-card" onClick={() => setEditingCharacter(current)}>
                <span className="studio-character-index mono">{String(index + 1).padStart(2, '0')}</span>
                <span className="studio-character-avatar">
                  {current.refAssetIds[0] && active.assets.find((asset) => asset.id === current.refAssetIds[0]) ? (
                    <img src={active.assets.find((asset) => asset.id === current.refAssetIds[0])?.thumbUrl ?? active.assets.find((asset) => asset.id === current.refAssetIds[0])?.url} alt="" />
                  ) : (
                    <Users size={20} strokeWidth={1.3} />
                  )}
                </span>
                <span className="studio-character-copy">
                  <b>{current.name}<em>{current.role}</em></b>
                  <span>{current.age ?? ''}{current.look ? ` · ${current.look.length > 42 ? `${current.look.slice(0, 42)}…` : current.look}` : ''}</span>
                  {current.desire ? <i>想要：{current.desire}</i> : null}
                  {current.fear ? <i>害怕：{current.fear}</i> : null}
                </span>
                <Pencil size={12} className="studio-character-edit" />
              </button>
            )
          })}
        </div>
      </section>

      <section className="studio-bp-section is-split">
        <div className="studio-bp-units">
          <SectionTitle eyebrow={active.kind === 'drama' ? '04 / 镜头安排' : '04 / 章节安排'} title={active.kind === 'drama' ? '镜头安排' : '章节安排'} aside={<button type="button" className="studio-link-btn" onClick={() => setShowAllUnits((value) => !value)}>{showAllUnits ? '收起' : `展开全部 ${blueprint.units.length} 项`} <ChevronDown size={12} /></button>}>
            {active.kind === 'drama' ? '每一镜都会写清台词、运镜和前后衔接；确认后可以逐镜生成、逐镜重做。' : '章名和梗概先定下来；正文仍然一章一章写，随时可以停。'}
          </SectionTitle>
          <div className="studio-unit-list">
            {units.map((unit) => (
              <div key={unit.index} className="studio-unit-row">
                <span className="studio-unit-number mono">{String(unit.index).padStart(2, '0')}</span>
                <div className="studio-unit-copy">
                  <b>{unit.title}</b>
                  <p>{unit.summary}</p>
                  {unit.dialogue ? <em>“{unit.dialogue}” · {unit.speaker}</em> : null}
                </div>
                <span className="studio-unit-meta mono">{unit.seconds ? `${unit.seconds}s` : unit.wordTarget ? `${unit.wordTarget} 字` : ''}</span>
              </div>
            ))}
          </div>
        </div>
        <aside className="studio-bp-side">
          <div className="studio-bp-side-block">
            <span className="studio-bp-index mono">05 / 地点</span>
            <h3>地点</h3>
            {blueprint.places.map((place) => (
              <div key={place.id} className="studio-place-row"><b>{place.name}</b><p>{place.description}</p></div>
            ))}
          </div>
          <div className="studio-bp-side-block">
            <span className="studio-bp-index mono">06 / 风格</span>
            <h3>风格</h3>
            <p>{blueprint.styleBible.look}</p>
            <div className="studio-palette">
              {blueprint.styleBible.palette.map((color) => <span key={color} style={{ background: color }} title={color} />)}
            </div>
            <dl className="studio-style-list">
              <dt>镜头</dt><dd>{blueprint.styleBible.camera}</dd>
              <dt>声音</dt><dd>{blueprint.styleBible.sound}</dd>
              <dt>不要出现</dt><dd>{blueprint.styleBible.negative.join(' · ')}</dd>
            </dl>
          </div>
          <div className="studio-bp-side-block is-quiet">
            <span className="studio-bp-index mono">07 / 要求</span>
            <h3>这次的要求</h3>
            {active.brief.constraints.length ? active.brief.constraints.map((item) => <p key={item} className="studio-constraint"><Check size={11} /> {item}</p>) : <p className="studio-hint">没有额外要求。</p>}
          </div>
        </aside>
      </section>

      <footer className="studio-blueprint-foot">
        <div>
          <Stat value={active.kind === 'drama' ? unitCount : blueprint.units.length} label={active.kind === 'drama' ? '镜头' : '章节'} />
          <Stat value={blueprint.characters.length} label="人物" />
          <Stat value={blueprint.places.length} label="地点" />
          <Stat value={costText} label="预计费用" tone="gold" />
        </div>
        <p>确认蓝图后，才会开始写章节或做镜头；每一步的费用都会单独记录。</p>
        {!approved ? <Button variant="gold" size="lg" icon={<Check size={15} />} onClick={() => void approve()} loading={approving}>确认并开始</Button> : <Button variant="secondary" size="lg" onClick={() => setView(active.kind === 'drama' ? 'storyboard' : 'writing')}>继续做 <ArrowRight size={14} /></Button>}
      </footer>

      {editBrief ? <BriefDialog open onClose={() => setEditBrief(false)} /> : null}
      {editBlueprint ? <BlueprintDialog onClose={() => setEditBlueprint(false)} /> : null}
      {editingCharacter ? <CharacterDialog character={editingCharacter} onClose={() => setEditingCharacter(null)} /> : null}
    </div>
  )
}

function FeatherPulse(): React.JSX.Element {
  return (
    <span className="studio-feather-pulse">
      <span /><span /><span />
      <StageIcon stage="blueprint" size={26} />
    </span>
  )
}

interface CanvasSnapshot {
  nodes: StudioCanvasNode[]
  connections: StudioCanvasConnection[]
  groups: StudioCanvasGroup[]
  viewport: StudioCanvasViewport
}

interface DragState {
  mode: 'node' | 'resize' | 'pan' | 'link' | 'marquee' | 'group'
  nodeId?: string
  groupId?: string
  startClientX: number
  startClientY: number
  originX?: number
  originY?: number
  originWidth?: number
  originHeight?: number
  originViewport?: StudioCanvasViewport
  origins?: Record<string, { x: number; y: number }>
  startWorldX?: number
  startWorldY?: number
  additive?: boolean
}

const MIN_ZOOM = 0.2

const MAX_ZOOM = 2.5

const GRID_SIZE = 26

function nodeId(kind: StudioCanvasNodeKind): string {
  return `canvas_${kind}_${crypto.randomUUID()}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function assetUrl(asset: StudioAsset | undefined): string | undefined {
  return asset?.thumbUrl ?? asset?.url
}

function shotImage(project: NonNullable<ReturnType<typeof useStudioStore.getState>['active']>, shot: StudioShot): StudioAsset | undefined {
  return project.assets.find((asset) => asset.id === (shot.imageAssetId ?? shot.videoAssetId))
}

function CanvasAudio({ asset, peaks }: { asset: StudioAsset; peaks?: number[] }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => () => {
    audioRef.current?.pause()
  }, [])
  const toggle = (): void => {
    if (!audioRef.current) audioRef.current = new Audio(asset.url ?? '')
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
      return
    }
    void audioRef.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }
  return (
    <div className="studio-canvas-audio" data-canvas-interactive>
      <button type="button" onClick={toggle} aria-label={playing ? '暂停音频' : '播放音频'}>
        {playing ? <span className="studio-canvas-audio-pause" /> : <span className="studio-canvas-audio-play" />}
      </button>
      <div className="studio-canvas-wave" aria-hidden>
        {peaks?.length ? peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(4, Math.round(peak * 100))}%` }} />) : <span className="studio-canvas-wave-empty">波形分析中</span>}
      </div>
      <span className="mono">{asset.durationSec ? `${asset.durationSec.toFixed(1)}s` : '音频'}</span>
    </div>
  )
}

export function CanvasView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const setView = useStudioStore((state) => state.setView)
  const selectShot = useStudioStore((state) => state.selectShot)
  const notify = useStudioStore((state) => state.notify)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const historyRef = useRef<CanvasSnapshot[]>([])
  const futureRef = useRef<CanvasSnapshot[]>([])
  const changeRef = useRef(0)
  const savingRef = useRef(false)
  const seededRef = useRef('')
  const syncedAtRef = useRef(0)
  const [nodes, setNodes] = useState<StudioCanvasNode[]>([])
  const [connections, setConnections] = useState<StudioCanvasConnection[]>([])
  const [groups, setGroups] = useState<StudioCanvasGroup[]>([])
  const [viewport, setViewport] = useState<StudioCanvasViewport>({ x: 96, y: 72, zoom: 0.8 })
  const [initialized, setInitialized] = useState(active?.canvas.initialized === true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [linking, setLinking] = useState<{ fromNodeId: string; x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; additive: boolean } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [paletteTab, setPaletteTab] = useState<'shots' | 'images' | 'audio'>('shots')
  const [query, setQuery] = useState('')
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({})
  const [shotJobs, setShotJobs] = useState<Record<string, string>>({})
  const [generating, setGenerating] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const nodesRef = useRef(nodes)
  const connectionsRef = useRef(connections)
  const groupsRef = useRef(groups)
  const viewportRef = useRef(viewport)
  const pendingSaveRef = useRef(false)
  const spaceRef = useRef(false)
  const waveformPendingRef = useRef(new Set<string>())
  nodesRef.current = nodes
  connectionsRef.current = connections
  groupsRef.current = groups
  viewportRef.current = viewport

  useEffect(() => {
    if (!active) return
    setNodes(active.canvas.nodes.map((node) => ({ ...node })))
    setConnections(active.canvas.connections.map((edge) => ({ ...edge })))
    setGroups((active.canvas.groups ?? []).map((group) => ({ ...group, nodeIds: [...group.nodeIds] })))
    setViewport({ ...active.canvas.viewport })
    setInitialized(active.canvas.initialized === true)
    syncedAtRef.current = active.canvas.updatedAt
    setSelectedId(null)
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setDirty(false)
    setSaveState('saved')
    setShotJobs({})
    historyRef.current = []
    futureRef.current = []
    seededRef.current = ''
    // 只跟随作品切换；画布本地编辑不被后台项目刷新覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  useEffect(() => {
    if (!active || active.kind !== 'drama' || initialized || active.canvas.initialized === true || active.canvas.nodes.length > 0 || seededRef.current === active.id) return
    seededRef.current = active.id
    const shotNodes: StudioCanvasNode[] = active.shots.map((shot, index) => ({
      id: nodeId('shot'),
      kind: 'shot',
      title: `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`,
      x: 120 + (index % 4) * 280,
      y: 120 + Math.floor(index / 4) * 220,
      width: 246,
      height: 186,
      z: index + 1,
      shotId: shot.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }))
    const audioAssets = active.assets.filter((asset) => asset.kind === 'audio' && (asset.tags.includes('music') || asset.tags.includes('voice'))).slice(0, 3)
    const audioNodes: StudioCanvasNode[] = audioAssets.map((asset, index) => ({
      id: nodeId('audio'),
      kind: 'audio',
      title: asset.title,
      x: 120 + index * 320,
      y: 120 + Math.ceil(active.shots.length / 4) * 220 + 12,
      width: 300,
      height: 122,
      z: 100 + index,
      assetId: asset.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }))
    const noteNode: StudioCanvasNode = {
      id: nodeId('text'),
      kind: 'text',
      title: '画布说明',
      x: 1100,
      y: 90,
      width: 280,
      height: 154,
      z: 200,
      text: '把镜头、画面、配音和音乐拖到一起；从节点右侧拉线，记录参考与生成关系。\n\n画布只保存工作流，不替代时间线。',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const seeded = [...shotNodes, ...audioNodes, noteNode]
    setNodes(seeded)
    setConnections([])
    setGroups([])
    setInitialized(true)
    setDirty(true)
    setSelectedId(shotNodes[0]?.id ?? null)
    setSelectedIds(shotNodes[0] ? [shotNodes[0].id] : [])
  }, [active, initialized])

  const persist = async (): Promise<void> => {
    if (!active) return
    if (savingRef.current) {
      pendingSaveRef.current = true
      return
    }
    savingRef.current = true
    setSaveState('saving')
    const version = changeRef.current
    try {
      await run('save-canvas', {
        canvas: {
          version: 1,
          initialized: true,
          nodes: nodesRef.current,
          connections: connectionsRef.current,
          groups: groupsRef.current,
          viewport: viewportRef.current
        }
      })
      if (changeRef.current === version) {
        setDirty(false)
        setSaveState('saved')
      }
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
    }
    if (pendingSaveRef.current || changeRef.current !== version) {
      pendingSaveRef.current = false
      void persist()
    }
  }

  useEffect(() => {
    if (!active || dirty) return
    if (active.canvas.updatedAt <= syncedAtRef.current) return
    syncedAtRef.current = active.canvas.updatedAt
    setNodes(active.canvas.nodes.map((node) => ({ ...node })))
    setConnections(active.canvas.connections.map((edge) => ({ ...edge })))
    setGroups((active.canvas.groups ?? []).map((group) => ({ ...group, nodeIds: [...group.nodeIds] })))
    setViewport({ ...active.canvas.viewport })
    setInitialized(active.canvas.initialized === true)
  }, [active?.canvas.updatedAt, dirty])

  useEffect(() => {
    if (!dirty || !active) return
    const timer = window.setTimeout(() => {
      void persist()
    }, 700)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, active?.id, nodes, connections, groups, viewport])

  useEffect(() => {
    if (!active) return
    for (const node of nodes) {
      if (node.kind !== 'audio' || !node.assetId || waveforms[node.assetId] || waveformPendingRef.current.has(node.assetId)) continue
      waveformPendingRef.current.add(node.assetId)
      void run<{ peaks: number[] }>('asset-waveform', { assetId: node.assetId })
        .then((result) => {
          if (result?.peaks?.length) setWaveforms((current) => ({ ...current, [node.assetId!]: result.peaks }))
        })
        .catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, nodes.length, active?.assets.length])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.code === 'Space') {
        spaceRef.current = event.type === 'keydown'
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelected()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAll()
        return
      }
      if (event.key.toLowerCase() === 'g' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        if (selectedIds.length >= 2) groupSelection()
        else if (selectedGroupId) ungroupSelection()
        return
      }
      if (event.key === 'Escape') {
        setSelectedId(null)
        setSelectedIds([])
        setSelectedGroupId(null)
        setSelectedEdgeId(null)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, connections, groups, selectedIds, selectedGroupId, selectedEdgeId])

  if (!active) return <div className="studio-canvas-empty">先打开一部漫剧作品。</div>
  if (active.kind !== 'drama') {
    return (
      <div className="studio-canvas-empty">
        <Clapperboard size={26} strokeWidth={1.2} />
        <h2>画布属于漫剧时间线</h2>
        <p>小说改编为漫剧后，可以在画布里组织镜头、画面、配音和音乐。</p>
        <Button variant="gold" onClick={() => setView('writing')}>回到写作台</Button>
      </div>
    )
  }

  const snapshot = (): CanvasSnapshot => ({
    nodes: nodes.map((node) => ({ ...node })),
    connections: connections.map((edge) => ({ ...edge })),
    groups: groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
    viewport: { ...viewport }
  })
  const pushHistory = (): void => {
    historyRef.current.push(snapshot())
    if (historyRef.current.length > 60) historyRef.current.shift()
    futureRef.current = []
  }
  const applySnapshot = (next: CanvasSnapshot): void => {
    setNodes(next.nodes.map((node) => ({ ...node })))
    setConnections(next.connections.map((edge) => ({ ...edge })))
    setGroups(next.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })))
    setViewport({ ...next.viewport })
    setSelectedId(null)
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    setDirty(true)
    changeRef.current += 1
  }
  const undo = (): void => {
    const previous = historyRef.current.pop()
    if (!previous) return
    futureRef.current.push(snapshot())
    applySnapshot(previous)
    notify('info', '已撤销画布操作。')
  }
  const redo = (): void => {
    const next = futureRef.current.pop()
    if (!next) return
    historyRef.current.push(snapshot())
    applySnapshot(next)
  }
  const markChanged = (): void => {
    setDirty(true)
    setSaveState('saving')
    changeRef.current += 1
  }
  const updateNode = (id: string, patch: Partial<StudioCanvasNode>, history = false): void => {
    if (history) pushHistory()
    setNodes((list) => list.map((node) => node.id === id ? { ...node, ...patch, updatedAt: Date.now() } : node))
    markChanged()
  }
  const updateEdge = (id: string, patch: Partial<StudioCanvasConnection>, history = false): void => {
    if (history) pushHistory()
    setConnections((list) => list.map((edge) => edge.id === id ? { ...edge, ...patch } : edge))
    markChanged()
  }
  const selectOnly = (id: string | null): void => {
    setSelectedId(id)
    setSelectedIds(id ? [id] : [])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
  }
  const toggleSelection = (id: string): void => {
    setSelectedIds((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      setSelectedId(next[next.length - 1] ?? null)
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
      return next
    })
  }
  const selectAll = (): void => {
    setSelectedIds(nodes.map((node) => node.id))
    setSelectedId(nodes[nodes.length - 1]?.id ?? null)
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
  }
  const selectedNode = selectedIds.length === 1 ? nodes.find((node) => node.id === selectedIds[0]) ?? null : null
  const selectedEdge = connections.find((edge) => edge.id === selectedEdgeId) ?? null
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null
  const selectedSet = new Set(selectedIds)
  const stagePoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - viewport.x) / viewport.zoom, y: (clientY - rect.top - viewport.y) / viewport.zoom }
  }
  const viewportCenter = (): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 500, y: 300 }
    return stagePoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }
  const zoomAt = (nextZoom: number, clientX?: number, clientY?: number): void => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
    const x = clientX ?? rect.left + rect.width / 2
    const y = clientY ?? rect.top + rect.height / 2
    const world = stagePoint(x, y)
    setViewport({ x: x - rect.left - world.x * zoom, y: y - rect.top - world.y * zoom, zoom })
  }
  const fit = (): void => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || !nodes.length) return
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...nodes.map((node) => node.y + node.height))
    const zoom = clamp(Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY)), MIN_ZOOM, 1.3)
    setViewport({ x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom })
  }
  const addNode = (node: StudioCanvasNode): void => {
    pushHistory()
    setNodes((list) => [...list, node])
    setSelectedId(node.id)
    setSelectedIds([node.id])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    markChanged()
  }
  const addShotNode = (shot: StudioShot): void => {
    const existing = nodes.find((node) => node.kind === 'shot' && node.shotId === shot.id)
    if (existing) {
      selectOnly(existing.id)
      return
    }
    const center = viewportCenter()
    addNode({
      id: nodeId('shot'),
      kind: 'shot',
      title: `镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`,
      x: center.x - 123,
      y: center.y - 93,
      width: 246,
      height: 186,
      z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1,
      shotId: shot.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  const addAssetNode = (asset: StudioAsset): void => {
    const existing = nodes.find((node) => node.assetId === asset.id)
    if (existing) {
      selectOnly(existing.id)
      return
    }
    const kind: StudioCanvasNodeKind = asset.kind === 'audio' ? 'audio' : asset.kind === 'video' ? 'video' : 'image'
    const center = viewportCenter()
    const width = kind === 'audio' ? 300 : kind === 'video' ? 320 : 260
    const height = kind === 'audio' ? 122 : kind === 'video' ? 210 : 200
    addNode({
      id: nodeId(kind),
      kind,
      title: asset.title,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1,
      assetId: asset.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  const addTextNode = (): void => {
    const center = viewportCenter()
    addNode({
      id: nodeId('text'),
      kind: 'text',
      title: '文本节点',
      x: center.x - 120,
      y: center.y - 70,
      width: 240,
      height: 140,
      z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1,
      text: '写一个意图、参考或制作备注……',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  const autoLayout = (): void => {
    const shotNodes = nodes.filter((node) => node.kind === 'shot').sort((a, b) => {
      const shotA = active.shots.find((shot) => shot.id === a.shotId)?.number ?? 0
      const shotB = active.shots.find((shot) => shot.id === b.shotId)?.number ?? 0
      return shotA - shotB
    })
    if (!shotNodes.length) return
    pushHistory()
    const positions = new Map(shotNodes.map((node, index) => [node.id, { x: 120 + (index % 4) * 280, y: 120 + Math.floor(index / 4) * 220 }]))
    setNodes((list) => list.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)!, updatedAt: Date.now() } : node))
    markChanged()
    notify('info', '镜头节点已按镜号排布。')
  }
  const autoConnect = (): void => {
    const shotNodes = nodes.filter((node) => node.kind === 'shot').sort((a, b) => {
      const shotA = active.shots.find((shot) => shot.id === a.shotId)?.number ?? 0
      const shotB = active.shots.find((shot) => shot.id === b.shotId)?.number ?? 0
      return shotA - shotB
    })
    if (shotNodes.length < 2) return
    pushHistory()
    const existing = new Set(connections.map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`))
    const next = [...connections]
    for (let index = 0; index < shotNodes.length - 1; index += 1) {
      const key = `${shotNodes[index].id}->${shotNodes[index + 1].id}`
      if (existing.has(key)) continue
      next.push({ id: `canvas_edge_${crypto.randomUUID()}`, fromNodeId: shotNodes[index].id, toNodeId: shotNodes[index + 1].id, label: '顺序' })
    }
    setConnections(next)
    markChanged()
    notify('info', '已按镜号自动连线。')
  }
  const duplicateSelected = (): void => {
    const sources = nodes.filter((node) => selectedSet.has(node.id))
    if (!sources.length) return
    pushHistory()
    let z = nodes.reduce((max, node) => Math.max(max, node.z), 0)
    const copies = sources.map((source) => {
      z += 1
      return {
        ...source,
        id: nodeId(source.kind),
        x: source.x + 32,
        y: source.y + 32,
        z,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
    setNodes((list) => [...list, ...copies])
    setSelectedId(copies[copies.length - 1]?.id ?? null)
    setSelectedIds(copies.map((node) => node.id))
    setSelectedGroupId(null)
    markChanged()
  }
  const deleteSelected = (): void => {
    if (selectedEdgeId) {
      pushHistory()
      setConnections((list) => list.filter((edge) => edge.id !== selectedEdgeId))
      setSelectedEdgeId(null)
      markChanged()
      return
    }
    if (!selectedIds.length) return
    const removed = new Set(selectedIds)
    pushHistory()
    setNodes((list) => list.filter((node) => !removed.has(node.id)))
    setConnections((list) => list.filter((edge) => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)))
    setGroups((list) => list
      .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !removed.has(id)) }))
      .filter((group) => group.nodeIds.length >= 2))
    setSelectedId(null)
    setSelectedIds([])
    setSelectedGroupId(null)
    markChanged()
  }
  const groupSelection = (): void => {
    if (selectedIds.length < 2) return
    pushHistory()
    const group: StudioCanvasGroup = {
      id: `canvas_group_${crypto.randomUUID()}`,
      title: `分组 ${groups.length + 1}`,
      nodeIds: [...selectedIds],
      createdAt: Date.now()
    }
    setGroups((list) => [...list, group])
    setSelectedGroupId(group.id)
    markChanged()
    notify('info', '已编组；拖动组标题可整体移动，G 解组。')
  }
  const ungroupSelection = (): void => {
    const targets = groups.filter((group) => group.id === selectedGroupId || group.nodeIds.some((id) => selectedSet.has(id)))
    if (!targets.length) return
    pushHistory()
    const removed = new Set(targets.map((group) => group.id))
    setGroups((list) => list.filter((group) => !removed.has(group.id)))
    setSelectedGroupId(null)
    markChanged()
    notify('info', '已解组，节点保留在原位。')
  }
  const alignSelection = (mode: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'): void => {
    const members = nodes.filter((node) => selectedSet.has(node.id))
    if (members.length < 2) return
    pushHistory()
    const left = Math.min(...members.map((node) => node.x))
    const right = Math.max(...members.map((node) => node.x + node.width))
    const top = Math.min(...members.map((node) => node.y))
    const bottom = Math.max(...members.map((node) => node.y + node.height))
    setNodes((list) => list.map((node) => {
      if (!selectedSet.has(node.id)) return node
      if (mode === 'left') return { ...node, x: left }
      if (mode === 'right') return { ...node, x: right - node.width }
      if (mode === 'top') return { ...node, y: top }
      if (mode === 'bottom') return { ...node, y: bottom - node.height }
      if (mode === 'hcenter') return { ...node, x: (left + right) / 2 - node.width / 2 }
      return { ...node, y: (top + bottom) / 2 - node.height / 2 }
    }))
    markChanged()
  }
  const beginGroupDrag = (event: React.PointerEvent<HTMLDivElement>, group: StudioCanvasGroup): void => {    if (event.button !== 0) return
    event.stopPropagation()
    const members = nodes.filter((node) => group.nodeIds.includes(node.id))
    if (!members.length) return
    pushHistory()
    setSelectedIds(group.nodeIds)
    setSelectedId(group.nodeIds[group.nodeIds.length - 1] ?? null)
    setSelectedGroupId(group.id)
    setSelectedEdgeId(null)
    dragRef.current = {
      mode: 'group',
      groupId: group.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origins: Object.fromEntries(members.map((node) => [node.id, { x: node.x, y: node.y }]))
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const generateForShot = async (shotId: string, kind: 'image' | 'video' | 'voice'): Promise<void> => {
    const key = `${shotId}:${kind}`
    if (generating) return
    setGenerating(key)
    try {
      const action = kind === 'image' ? 'generate-shot-image' : kind === 'video' ? 'generate-shot-video' : 'generate-voice'
      const result = await run(action, { shotId, useModel: true })
      if (result.job) setShotJobs((current) => ({ ...current, [shotId]: result.job!.id }))
      notify('info', result.message ?? '任务已排队；进度会显示在节点和顶部任务条。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(null)
    }
  }
  const loadWaveform = async (assetId: string): Promise<void> => {
    if (waveforms[assetId]) return
    try {
      const result = await run<{ peaks: number[] }>('asset-waveform', { assetId })
      if (result?.peaks?.length) setWaveforms((current) => ({ ...current, [assetId]: result.peaks }))
    } catch {
      // 波形失败不阻断画布
    }
  }
  const exportSnapshot = async (): Promise<void> => {
    if (exporting || !active) return
    setExporting(true)
    try {
      const audioIds = [...new Set(nodes.filter((node) => node.kind === 'audio' && node.assetId).map((node) => node.assetId!))]
      const peaks: Record<string, number[]> = { ...waveforms }
      for (const assetId of audioIds) {
        if (peaks[assetId]) continue
        try {
          const result = await run<{ peaks: number[] }>('asset-waveform', { assetId })
          if (result?.peaks?.length) peaks[assetId] = result.peaks
        } catch {
          // 没有波形的节点在快照里显示为音频块
        }
      }
      setWaveforms(peaks)
      const image = await renderCanvasSnapshot({
        title: active.title,
        nodes,
        connections,
        groups,
        assets: active.assets,
        shots: active.shots,
        waveforms: peaks
      })
      const result = await run('save-canvas-snapshot', { dataUrl: image.dataUrl })
      notify('success', result.message ?? '画布快照已导出到交付记录。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }
  const openShot = (shotId: string | undefined): void => {
    if (!shotId) return
    selectShot(shotId)
    setView('storyboard')
  }
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, node: StudioCanvasNode): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-interactive]')) {
      event.stopPropagation()
      if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelection(node.id)
      else if (!selectedSet.has(node.id)) selectOnly(node.id)
      return
    }
    event.stopPropagation()
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault()
      toggleSelection(node.id)
      return
    }
    const members = selectedSet.has(node.id) && selectedIds.length > 1
      ? nodes.filter((item) => selectedSet.has(item.id))
      : [node]
    if (!selectedSet.has(node.id)) selectOnly(node.id)
    pushHistory()
    dragRef.current = {
      mode: 'node',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: node.x,
      originY: node.y,
      origins: Object.fromEntries(members.map((item) => [item.id, { x: item.x, y: item.y }]))
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const beginResize = (event: React.PointerEvent<HTMLButtonElement>, node: StudioCanvasNode): void => {
    event.stopPropagation()
    event.preventDefault()
    pushHistory()
    selectOnly(node.id)
    dragRef.current = {
      mode: 'resize',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originWidth: node.width,
      originHeight: node.height
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const beginLink = (event: React.PointerEvent<HTMLButtonElement>, node: StudioCanvasNode): void => {
    event.stopPropagation()
    event.preventDefault()
    const world = stagePoint(event.clientX, event.clientY)
    setLinking({ fromNodeId: node.id, x: world.x, y: world.y })
    dragRef.current = {
      mode: 'link',
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'pan' && drag.originViewport) {
      setViewport({
        ...drag.originViewport,
        x: drag.originViewport.x + (event.clientX - drag.startClientX),
        y: drag.originViewport.y + (event.clientY - drag.startClientY)
      })
      return
    }
    if (drag.mode === 'node' && drag.nodeId) {
      const dx = (event.clientX - drag.startClientX) / viewport.zoom
      const dy = (event.clientY - drag.startClientY) / viewport.zoom
      const origins = drag.origins ?? { [drag.nodeId]: { x: drag.originX ?? 0, y: drag.originY ?? 0 } }
      setNodes((list) => list.map((node) => origins[node.id] ? { ...node, x: origins[node.id].x + dx, y: origins[node.id].y + dy } : node))
      return
    }
    if (drag.mode === 'group' && drag.origins) {
      const dx = (event.clientX - drag.startClientX) / viewport.zoom
      const dy = (event.clientY - drag.startClientY) / viewport.zoom
      setNodes((list) => list.map((node) => drag.origins?.[node.id] ? { ...node, x: drag.origins[node.id].x + dx, y: drag.origins[node.id].y + dy } : node))
      return
    }
    if (drag.mode === 'marquee') {
      const world = stagePoint(event.clientX, event.clientY)
      setMarquee((current) => current ? { ...current, x: world.x, y: world.y } : current)
      return
    }
    if (drag.mode === 'resize' && drag.nodeId) {
      const dx = (event.clientX - drag.startClientX) / viewport.zoom
      const dy = (event.clientY - drag.startClientY) / viewport.zoom
      setNodes((list) => list.map((node) => node.id === drag.nodeId ? { ...node, width: clamp((drag.originWidth ?? 240) + dx, 80, 1200), height: clamp((drag.originHeight ?? 160) + dy, 60, 900) } : node))
      return
    }
    if (drag.mode === 'link') {
      const world = stagePoint(event.clientX, event.clientY)
      setLinking((current) => current ? { ...current, x: world.x, y: world.y } : current)
    }
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag?.mode === 'marquee' && marquee) {
      const left = Math.min(marquee.startX, marquee.x)
      const right = Math.max(marquee.startX, marquee.x)
      const top = Math.min(marquee.startY, marquee.y)
      const bottom = Math.max(marquee.startY, marquee.y)
      const hit = nodes.filter((node) => node.x < right && node.x + node.width > left && node.y < bottom && node.y + node.height > top).map((node) => node.id)
      const next = marquee.additive ? [...new Set([...selectedIds, ...hit])] : hit
      setSelectedIds(next)
      setSelectedId(next[next.length - 1] ?? null)
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
      setMarquee(null)
      dragRef.current = null
      stageRef.current?.releasePointerCapture(event.pointerId)
      return
    }
    if (drag?.mode === 'link' && drag.nodeId) {
      const world = stagePoint(event.clientX, event.clientY)
      const target = [...nodes].reverse().find((node) => node.id !== drag.nodeId && world.x >= node.x && world.x <= node.x + node.width && world.y >= node.y && world.y <= node.y + node.height)
      if (target) {
        pushHistory()
        setConnections((list) => list.some((edge) => edge.fromNodeId === drag.nodeId && edge.toNodeId === target.id)
          ? list
          : [...list, { id: `canvas_edge_${crypto.randomUUID()}`, fromNodeId: drag.nodeId!, toNodeId: target.id }])
        markChanged()
      }
    }
    if (drag && drag.mode !== 'pan' && drag.mode !== 'marquee') markChanged()
    dragRef.current = null
    setLinking(null)
    stageRef.current?.releasePointerCapture(event.pointerId)
  }
  const onStagePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button === 1 || spaceRef.current || event.altKey) {
      event.preventDefault()
      dragRef.current = {
        mode: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        originViewport: { ...viewport }
      }
      stageRef.current?.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0) return
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (!additive) {
      setSelectedId(null)
      setSelectedIds([])
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
    }
    const world = stagePoint(event.clientX, event.clientY)
    setMarquee({ startX: world.x, startY: world.y, x: world.x, y: world.y, additive })
    dragRef.current = {
      mode: 'marquee',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWorldX: world.x,
      startWorldY: world.y,
      additive
    }
    stageRef.current?.setPointerCapture(event.pointerId)
  }
  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    zoomAt(viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX, event.clientY)
  }
  const shotAssets = active.shots.map((shot) => ({ shot, asset: shotImage(active, shot) }))
  const filteredShots = shotAssets.filter(({ shot }) => !query.trim() || `${shot.number} ${shot.title} ${shot.action}`.toLowerCase().includes(query.trim().toLowerCase()))
  const images = active.assets.filter((asset) => asset.kind === 'image')
  const audioAssets = active.assets.filter((asset) => asset.kind === 'audio')
  const filteredAssets = (paletteTab === 'images' ? images : audioAssets).filter((asset) => !query.trim() || asset.title.toLowerCase().includes(query.trim().toLowerCase()))
  const edgePath = (from: StudioCanvasNode, to: StudioCanvasNode): string => {
    const sx = from.x + from.width
    const sy = from.y + from.height / 2
    const tx = to.x
    const ty = to.y + to.height / 2
    const curve = Math.max(60, Math.abs(tx - sx) * 0.45)
    return `M ${sx} ${sy} C ${sx + curve} ${sy}, ${tx - curve} ${ty}, ${tx} ${ty}`
  }
  const linkSource = linking ? nodes.find((node) => node.id === linking.fromNodeId) : null
  const selectedShot = selectedNode?.shotId ? active.shots.find((shot) => shot.id === selectedNode.shotId) : null
  const selectedAsset = selectedNode?.assetId ? active.assets.find((asset) => asset.id === selectedNode.assetId) : null
  const groupFrames = groups.map((group) => {
    const members = nodes.filter((node) => group.nodeIds.includes(node.id))
    if (members.length < 2) return null
    const minX = Math.min(...members.map((node) => node.x)) - 18
    const minY = Math.min(...members.map((node) => node.y)) - 42
    const maxX = Math.max(...members.map((node) => node.x + node.width)) + 18
    const maxY = Math.max(...members.map((node) => node.y + node.height)) + 18
    return { group, x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  }).filter((item): item is { group: StudioCanvasGroup; x: number; y: number; width: number; height: number } => Boolean(item))
  const jobForShot = (shotId: string): { progress: number; status: string; message: string } | null => {
    const jobId = shotJobs[shotId]
    if (!jobId) return null
    const job = active.jobs.find((item) => item.id === jobId)
    return job ? { progress: job.progress, status: job.status, message: job.message } : null
  }

  return (
    <div className="studio-canvas-view">
      <header className="studio-canvas-bar">
        <div className="studio-canvas-heading">
          <span className="studio-eyebrow">漫剧画布</span>
          <h1>{active.title}<em>画布</em></h1>
          <p>{nodes.length} 个节点 · {connections.length} 条连线 · {groups.length} 个分组{selectedIds.length > 1 ? ` · 已选 ${selectedIds.length}` : ''} · 拖拽排布，右侧拉线</p>
        </div>
        <div className="studio-canvas-actions">
          <span className={`studio-canvas-save is-${saveState}`}>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}</span>
          <button type="button" className="studio-canvas-icon" onClick={undo} disabled={!historyRef.current.length} title="撤销" aria-label="撤销"><Undo2 size={14} /></button>
          <button type="button" className="studio-canvas-icon" onClick={redo} disabled={!futureRef.current.length} title="重做" aria-label="重做"><Redo2 size={14} /></button>
          <button type="button" className="studio-canvas-action" onClick={addTextNode}><Type size={13} /> 文本</button>
          <button type="button" className="studio-canvas-action" onClick={groupSelection} disabled={selectedIds.length < 2} title="把选中的节点编为一组（G）"><Boxes size={13} /> 编组</button>
          <button type="button" className="studio-canvas-action" onClick={ungroupSelection} disabled={!selectedGroupId && !groups.some((group) => group.nodeIds.some((id) => selectedSet.has(id)))} title="解散分组"><Ungroup size={13} /> 解组</button>
          <button type="button" className="studio-canvas-action" onClick={autoLayout}><LayoutGrid size={13} /> 自动排布</button>
          <button type="button" className="studio-canvas-action" onClick={autoConnect}><GitBranch size={13} /> 自动连线</button>
          <button type="button" className="studio-canvas-action" onClick={fit}><Maximize2 size={13} /> 适应窗口</button>
          <button type="button" className="studio-canvas-action" onClick={() => void exportSnapshot()} disabled={exporting}>{exporting ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />} 导出快照</button>
          <button type="button" className="studio-canvas-action" onClick={() => setView('storyboard')}><Clapperboard size={13} /> 分镜</button>
          <button type="button" className="studio-canvas-action" onClick={() => setView('timeline')}><Film size={13} /> 时间线</button>
        </div>
      </header>

      <div className={`studio-canvas-workspace ${paletteOpen ? '' : 'is-palette-closed'}`}>
        {paletteOpen ? (
          <aside className="studio-canvas-palette" aria-label="画布素材">
            <header>
              <div><span className="studio-eyebrow">素材</span><b>素材与镜头</b></div>
              <button type="button" onClick={() => setPaletteOpen(false)} aria-label="收起素材"><X size={14} /></button>
            </header>
            <div className="studio-canvas-tabs" role="tablist" aria-label="画布素材类型">
              <button type="button" className={paletteTab === 'shots' ? 'is-active' : ''} onClick={() => setPaletteTab('shots')}>镜头 <em>{active.shots.length}</em></button>
              <button type="button" className={paletteTab === 'images' ? 'is-active' : ''} onClick={() => setPaletteTab('images')}>画面 <em>{images.length}</em></button>
              <button type="button" className={paletteTab === 'audio' ? 'is-active' : ''} onClick={() => setPaletteTab('audio')}>声音 <em>{audioAssets.length}</em></button>
            </div>
            <label className="studio-canvas-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="找镜头或素材" aria-label="搜索画布素材" /></label>
            <div className="studio-canvas-palette-list">
              {paletteTab === 'shots' ? filteredShots.map(({ shot, asset }) => (
                <button key={shot.id} type="button" className="studio-canvas-palette-card" onClick={() => addShotNode(shot)}>
                  <span className="studio-canvas-palette-thumb">{asset ? <img src={assetUrl(asset)} alt="" loading="lazy" /> : <span className="mono">{String(shot.number).padStart(2, '0')}</span>}</span>
                  <span><b>镜 {String(shot.number).padStart(2, '0')} · {shot.title}</b><em>{shot.shotSize} · {shot.camera} · {shot.durationSec}s</em></span>
                  <Plus size={12} />
                </button>
              )) : filteredAssets.map((asset) => (
                <button key={asset.id} type="button" className="studio-canvas-palette-card" onClick={() => addAssetNode(asset)}>
                  <span className="studio-canvas-palette-thumb">
                    {asset.kind === 'image' ? <img src={assetUrl(asset)} alt="" loading="lazy" /> : asset.kind === 'video' ? <Video size={16} /> : <Music2 size={16} />}
                  </span>
                  <span><b>{asset.title}</b><em>{asset.kind === 'image' ? '画面' : asset.kind === 'video' ? '视频' : '音频'} · {asset.durationSec ? `${asset.durationSec.toFixed(1)}s` : '可拖入'}</em></span>
                  <Plus size={12} />
                </button>
              ))}
              {((paletteTab === 'shots' && !filteredShots.length) || (paletteTab !== 'shots' && !filteredAssets.length)) ? <p className="studio-canvas-palette-empty">没有匹配的素材。</p> : null}
            </div>
            <div className="studio-canvas-palette-foot">
              <button type="button" onClick={addTextNode}><Type size={12} /> 新建文本节点</button>
              <span>素材来自当前作品，不复制文件</span>
            </div>
          </aside>
        ) : null}

        <div
          ref={stageRef}
          className={`studio-canvas-stage ${paletteOpen ? '' : 'is-wide'}`}
          style={{
            backgroundSize: `${GRID_SIZE * viewport.zoom}px ${GRID_SIZE * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`
          }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
        >
          {!paletteOpen ? <button type="button" className="studio-canvas-palette-open" onClick={() => setPaletteOpen(true)}><ImageIcon size={13} /> 素材</button> : null}
          <div className="studio-canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
            {groupFrames.map(({ group, x, y, width, height }) => (
              <div
                key={group.id}
                className={`studio-canvas-group ${selectedGroupId === group.id ? 'is-selected' : ''}`}
                style={{ left: x, top: y, width, height, zIndex: 1 }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) {
                    event.stopPropagation()
                    setSelectedIds(group.nodeIds)
                    setSelectedId(group.nodeIds[group.nodeIds.length - 1] ?? null)
                    setSelectedGroupId(group.id)
                    setSelectedEdgeId(null)
                  }
                }}
              >
                <div className="studio-canvas-group-head" onPointerDown={(event) => beginGroupDrag(event, group)}>
                  <Boxes size={11} />
                  <input
                    value={group.title}
                    aria-label="分组名称"
                    onChange={(event) => {
                      const title = event.target.value
                      setGroups((list) => list.map((item) => item.id === group.id ? { ...item, title } : item))
                      markChanged()
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                  <span>{group.nodeIds.length} 个节点</span>
                </div>
              </div>
            ))}
            <svg className="studio-canvas-wires" width="1" height="1" aria-hidden>
              {connections.map((edge) => {
                const from = nodes.find((node) => node.id === edge.fromNodeId)
                const to = nodes.find((node) => node.id === edge.toNodeId)
                if (!from || !to) return null
                return (
                  <g key={edge.id}>
                    <path className="studio-canvas-wire-hit" d={edgePath(from, to)} onPointerDown={(event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); setSelectedId(null); setSelectedIds([]); setSelectedGroupId(null) }} />
                    <path className={`studio-canvas-wire ${selectedEdgeId === edge.id ? 'is-selected' : ''}`} d={edgePath(from, to)} />
                  </g>
                )
              })}
              {linking && linkSource ? (
                <path className="studio-canvas-wire is-linking" d={`M ${linkSource.x + linkSource.width} ${linkSource.y + linkSource.height / 2} C ${linkSource.x + linkSource.width + 70} ${linkSource.y + linkSource.height / 2}, ${linking.x - 70} ${linking.y}, ${linking.x} ${linking.y}`} />
              ) : null}
            </svg>
            {marquee ? (
              <div
                className="studio-canvas-marquee"
                style={{
                  left: Math.min(marquee.startX, marquee.x),
                  top: Math.min(marquee.startY, marquee.y),
                  width: Math.abs(marquee.x - marquee.startX),
                  height: Math.abs(marquee.y - marquee.startY)
                }}
              />
            ) : null}
            {nodes.map((node) => {
              const asset = node.assetId ? active.assets.find((item) => item.id === node.assetId) : undefined
              const shot = node.shotId ? active.shots.find((item) => item.id === node.shotId) : undefined
              const image = shot ? shotImage(active, shot) : undefined
              const shotJob = shot ? jobForShot(shot.id) : null
              return (
                <div
                  key={node.id}
                  className={`studio-canvas-node is-${node.kind} ${selectedSet.has(node.id) ? 'is-selected' : ''}`}
                  style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: node.z + 2 }}
                  data-canvas-node={node.id}
                  onPointerDown={(event) => beginDrag(event, node)}
                  onClick={(event) => {
                    if (event.shiftKey || event.ctrlKey || event.metaKey) return
                    selectOnly(node.id)
                  }}
                >
                  <div className="studio-canvas-node-head">
                    <span className="studio-canvas-node-kind">{node.kind === 'shot' ? <Clapperboard size={11} /> : node.kind === 'image' ? <ImageIcon size={11} /> : node.kind === 'video' ? <Video size={11} /> : node.kind === 'audio' ? <Music2 size={11} /> : <Type size={11} />}</span>
                    <b title={node.title}>{node.title}</b>
                    <button type="button" className="studio-canvas-link-handle" onPointerDown={(event) => beginLink(event, node)} title="从这里拉线到另一个节点" aria-label="创建连线" />
                  </div>
                  <div className="studio-canvas-node-body">
                    {node.kind === 'text' ? (
                      <textarea
                        value={node.text ?? ''}
                        data-canvas-interactive
                        onFocus={pushHistory}
                        onChange={(event) => updateNode(node.id, { text: event.target.value })}
                        aria-label={`${node.title}内容`}
                      />
                    ) : node.kind === 'audio' && asset ? (
                      <CanvasAudio asset={asset} peaks={node.assetId ? waveforms[node.assetId] : undefined} />
                    ) : (
                      <>
                        {(asset?.kind === 'video' || node.kind === 'video') && asset?.url ? (
                          <video src={asset.url} muted playsInline preload="metadata" controls data-canvas-interactive />
                        ) : (image ? assetUrl(image) : assetUrl(asset)) ? (
                          <img src={image ? assetUrl(image) : assetUrl(asset)} alt="" loading="lazy" draggable={false} />
                        ) : (
                          <div className="studio-canvas-node-placeholder">{shot ? <span className="mono">{String(shot.number).padStart(2, '0')}</span> : <ImageIcon size={18} />}</div>
                        )}
                        {shot ? (
                          <div className="studio-canvas-shot-copy">
                            <span>{shot.shotSize} · {shot.camera} · {shot.durationSec}s</span>
                            <p>{shot.action || shot.dialogue || '还没有动作描述'}</p>
                          </div>
                        ) : null}
                        {asset && node.kind !== 'shot' ? <span className="studio-canvas-asset-tag">{asset.kind === 'image' ? '画面素材' : '视频素材'}</span> : null}
                      </>
                    )}
                  </div>
                  {shotJob ? (
                    <div className={`studio-canvas-node-job is-${shotJob.status}`} data-canvas-interactive>
                      <span>{shotJob.status === 'running' ? shotJob.message : shotJob.status === 'queued' ? '任务排队中' : shotJob.status === 'done' ? '已生成' : shotJob.message}</span>
                      <i><b style={{ width: `${shotJob.progress}%` }} /></i>
                    </div>
                  ) : null}
                  <button type="button" className="studio-canvas-resize" aria-label="调整节点大小" onPointerDown={(event) => beginResize(event, node)} />
                </div>
              )
            })}
          </div>
          <div
            className="studio-canvas-zoom"
            data-canvas-interactive
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={() => zoomAt(viewport.zoom * 0.9)} title="缩小" aria-label="缩小"><ZoomOut size={13} /></button>
            <button type="button" className="studio-canvas-zoom-label mono" onClick={() => zoomAt(1)} title="恢复 100%">{Math.round(viewport.zoom * 100)}%</button>
            <button type="button" onClick={() => zoomAt(viewport.zoom * 1.1)} title="放大" aria-label="放大"><ZoomIn size={13} /></button>
            <button type="button" onClick={fit} title="适应画布" aria-label="适应画布"><Maximize2 size={13} /></button>
          </div>
        </div>

        <aside className="studio-canvas-inspector" aria-label="画布节点详情">
          <header>
            <span className="studio-eyebrow">{selectedEdge ? '连线' : selectedIds.length > 1 ? '已选' : selectedGroup ? '分组' : selectedNode ? '节点' : '画布'}</span>
            <b>{selectedEdge ? '连线' : selectedIds.length > 1 ? `${selectedIds.length} 个节点` : selectedGroup ? selectedGroup.title : selectedNode?.kind === 'shot' ? '镜头节点' : selectedNode ? '节点详情' : '画布'}</b>
            {selectedNode || selectedEdge || selectedIds.length || selectedGroup ? <button type="button" onClick={() => { setSelectedId(null); setSelectedIds([]); setSelectedGroupId(null); setSelectedEdgeId(null) }} aria-label="取消选择"><X size={13} /></button> : null}
          </header>
          {selectedEdge ? (
            <div className="studio-canvas-inspector-body">
              <label><span>连线说明</span><input value={selectedEdge.label ?? ''} placeholder="例如：参考 / 配音 / 生成" onFocus={pushHistory} onChange={(event) => updateEdge(selectedEdge.id, { label: event.target.value })} /></label>
              <Button variant="danger" size="sm" icon={<Trash2 size={12} />} onClick={deleteSelected}>删除连线</Button>
            </div>
          ) : selectedGroup ? (
            <div className="studio-canvas-inspector-body">
              <label><span>分组名称</span><input value={selectedGroup.title} onChange={(event) => { const title = event.target.value; setGroups((list) => list.map((group) => group.id === selectedGroup.id ? { ...group, title } : group)); markChanged() }} /></label>
              <p className="studio-canvas-inspector-note">{selectedGroup.nodeIds.length} 个节点 · 拖动组标题整体移动</p>
              <div className="studio-canvas-inspector-actions">
                <button type="button" onClick={ungroupSelection}><Ungroup size={12} /> 解组</button>
                <button type="button" onClick={duplicateSelected}><Copy size={12} /> 复制节点</button>
                <button type="button" className="is-danger" onClick={deleteSelected}><Trash2 size={12} /> 删除节点</button>
              </div>
            </div>
          ) : selectedIds.length > 1 ? (
            <div className="studio-canvas-inspector-body">
              <p className="studio-canvas-inspector-note">已选 {selectedIds.length} 个节点。拖动任一节点会一起移动；可编组后统一移动。</p>
              <div className="studio-canvas-align">
                <button type="button" onClick={() => alignSelection('left')}>左对齐</button>
                <button type="button" onClick={() => alignSelection('right')}>右对齐</button>
                <button type="button" onClick={() => alignSelection('top')}>顶对齐</button>
                <button type="button" onClick={() => alignSelection('bottom')}>底对齐</button>
                <button type="button" onClick={() => alignSelection('hcenter')}>水平居中</button>
                <button type="button" onClick={() => alignSelection('vcenter')}>垂直居中</button>
              </div>
              <div className="studio-canvas-inspector-actions">
                <button type="button" onClick={groupSelection}><Boxes size={12} /> 编组</button>
                <button type="button" onClick={duplicateSelected}><Copy size={12} /> 副本</button>
                <button type="button" className="is-danger" onClick={deleteSelected}><Trash2 size={12} /> 删除</button>
              </div>
            </div>
          ) : selectedNode ? (
            <div className="studio-canvas-inspector-body">
              <label><span>标题</span><input value={selectedNode.title} onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { title: event.target.value })} /></label>
              {selectedNode.kind === 'text' ? (
                <label><span>内容</span><textarea rows={7} value={selectedNode.text ?? ''} onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { text: event.target.value })} /></label>
              ) : null}
              <div className="studio-canvas-node-fields">
                <label><span>宽度</span><input value={Math.round(selectedNode.width)} inputMode="numeric" onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { width: clamp(Number(event.target.value) || 80, 80, 1200) })} /></label>
                <label><span>高度</span><input value={Math.round(selectedNode.height)} inputMode="numeric" onFocus={pushHistory} onChange={(event) => updateNode(selectedNode.id, { height: clamp(Number(event.target.value) || 60, 60, 900) })} /></label>
              </div>
              {selectedShot ? (
                <div className="studio-canvas-inspector-shot">
                  <span>镜 {selectedShot.number} · {selectedShot.shotSize} · {selectedShot.durationSec}s</span>
                  <p>{selectedShot.action}</p>
                  <button type="button" onClick={() => openShot(selectedShot.id)}><ExternalLink size={12} /> 打开分镜</button>
                  <div className="studio-canvas-generate">
                    <span>在画布内生成</span>
                    <div>
                      <button type="button" disabled={Boolean(generating)} onClick={() => void generateForShot(selectedShot.id, 'image')}>
                        {generating === `${selectedShot.id}:image` ? <Loader2 size={12} className="studio-spin" /> : <ImagePlus size={12} />} 画面
                      </button>
                      <button type="button" disabled={Boolean(generating)} onClick={() => void generateForShot(selectedShot.id, 'video')}>
                        {generating === `${selectedShot.id}:video` ? <Loader2 size={12} className="studio-spin" /> : <Video size={12} />} 视频
                      </button>
                      <button type="button" disabled={Boolean(generating) || !selectedShot.dialogue.trim()} onClick={() => void generateForShot(selectedShot.id, 'voice')}>
                        {generating === `${selectedShot.id}:voice` ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} 配音
                      </button>
                    </div>
                    {jobForShot(selectedShot.id) ? <em>{jobForShot(selectedShot.id)!.message}</em> : null}
                  </div>
                </div>
              ) : null}
              {selectedAsset ? <p className="studio-canvas-inspector-note">{selectedAsset.title} · {selectedAsset.kind} · 素材仍在作品里</p> : null}
              <div className="studio-canvas-inspector-actions">
                <button type="button" onClick={duplicateSelected}><Copy size={12} /> 副本</button>
                <button type="button" onClick={() => updateNode(selectedNode.id, { z: nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1 }, true)}><ArrowUpToLine size={12} /> 置顶</button>
                <button type="button" onClick={() => updateNode(selectedNode.id, { z: Math.min(...nodes.map((node) => node.z), 1) - 1 }, true)}><ArrowDownToLine size={12} /> 置底</button>
                <button type="button" className="is-danger" onClick={deleteSelected}><Trash2 size={12} /> 删除</button>
              </div>
            </div>
          ) : (
            <div className="studio-canvas-inspector-empty">
              <p>从左侧添加镜头、画面或声音。拖拽节点排布，从节点右侧的圆点拉线，建立“参考 → 生成 → 配音 → 合成”的工作流。</p>
              <p className="studio-canvas-inspector-tip">框选或 Shift 点选多个节点；按 G 编组，拖动组标题整体移动。</p>
              <dl>
                <div><dt>节点</dt><dd>{nodes.length}</dd></div>
                <div><dt>连线</dt><dd>{connections.length}</dd></div>
                <div><dt>分组</dt><dd>{groups.length}</dd></div>
                <div><dt>已保存</dt><dd>{saveState === 'saved' ? '是' : '…'}</dd></div>
              </dl>
              <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)} disabled={paletteOpen}>打开素材栏</Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function deliveryIcon(kind: StudioDelivery['kind']): React.JSX.Element {
  switch (kind) {
    case 'mp4':
      return <Film size={15} />
    case 'epub':
      return <BookOpen size={15} />
    case 'pdf':
      return <FileType size={15} />
    case 'docx':
      return <FileText size={15} />
    case 'txt':
    case 'md':
      return <FileCode2 size={15} />
    case 'srt':
    case 'ass':
      return <Subtitles size={15} />
    case 'wav':
    case 'mp3':
    case 'm4a':
    case 'flac':
      return <Music2 size={15} />
    case 'cover':
    case 'comic':
      return <ImageIcon size={15} />
    case 'folder':
    case 'package':
      return <FileArchive size={15} />
    default:
      return <FileText size={15} />
  }
}

const FORMAT_HINTS: Record<'mp4' | 'mov' | 'mkv' | 'webm', string> = {
  mp4: 'MP4 最通用：视频网站、微信和手机都能直接播放。',
  mov: 'MOV 适合苹果设备和剪辑软件，文件会更大。',
  mkv: 'MKV 适合保留多轨；少数播放器要额外解码。',
  webm: 'WebM 适合放进网页；部分剪辑软件不认。'
}

const AUDIO_LABELS: Record<'wav' | 'mp3' | 'm4a' | 'flac', string> = {
  wav: 'WAV',
  mp3: 'MP3',
  m4a: 'AAC',
  flac: 'FLAC'
}

const AUDIO_TITLES: Record<'wav' | 'mp3' | 'm4a' | 'flac', string> = {
  wav: '无损音质，文件最大',
  mp3: '最通用，文件小',
  m4a: '苹果设备常用',
  flac: '无损压缩，比 WAV 小'
}

export function DeliveryView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const setView = useStudioStore((state) => state.setView)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const [quality, setQuality] = useState<'draft' | 'final'>('draft')
  const [audioExporting, setAudioExporting] = useState<string | null>(null)
  const [comicExporting, setComicExporting] = useState(false)
  const [aspect, setAspect] = useState<'16:9' | '9:16' | '1:1'>(active?.timeline.aspect ?? active?.brief.aspect ?? '16:9')
  const [subtitleMode, setSubtitleMode] = useState<'burn' | 'soft'>('burn')
  const [format, setFormat] = useState<'mp4' | 'mov' | 'mkv' | 'webm'>('mp4')
  const [resolution, setResolution] = useState<'1080p' | '2160p'>('1080p')
  const [exporting, setExporting] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [preflightOpen, setPreflightOpen] = useState(false)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [preflight, setPreflight] = useState<StudioExportPreflight | null>(null)
  const projectAspect = active?.timeline.aspect ?? active?.brief.aspect ?? '16:9'
  useEffect(() => {
    setAspect(projectAspect)
  }, [active?.id, projectAspect])
  if (!active) return <div />
  const deliveries = [...active.deliveries].sort((a, b) => b.createdAt - a.createdAt)
  const latestVideo = deliveries.find((delivery) => isStudioVideoDelivery(delivery.kind))
  const coverDelivery = deliveries.find((delivery) => delivery.kind === 'cover')
  const words = active.chapters.reduce((sum, chapter) => sum + chapter.content.replace(/\s+/g, '').length, 0)
  const shots = active.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length
  const voicesNeeded = active.shots.filter((shot) => shot.dialogue.trim())
  const voices = voicesNeeded.filter((shot) => shot.voiceAssetId).length
  const subtitles = active.timeline.clips.filter((clip) => clip.kind === 'subtitle').length
  const unresolved = active.checks.filter((check) => check.level === 'error').length
  const activeRenderJob = [...active.jobs].reverse().find((job) => job.kind === 'render' && (job.status === 'running' || job.status === 'queued'))
  const canVideo = engine?.ffmpeg.available
  const checks = useMemo(() => active.kind === 'drama'
    ? [
        { label: `画面齐了（${shots}/${active.shots.length} 镜）`, ok: active.shots.length > 0 && shots === active.shots.length },
        { label: `配音齐了（${voices}/${voicesNeeded.length} 段）`, ok: voices === voicesNeeded.length },
        { label: `字幕 ${subtitles} 条`, ok: subtitles > 0 },
        { label: '时间线已排好', ok: active.timeline.clips.length > 0 },
        { label: active.stages.delivery.status === 'stale' ? '成片已过期，需重新合成' : '成片与时间线一致', ok: active.stages.delivery.status !== 'stale' },
        { label: '视频合成工具可用', ok: Boolean(engine?.ffmpeg.available) },
        { label: active.stages.review.status === 'stale' ? '检查已过期，需重新检查' : '没有必须修的问题', ok: unresolved === 0 && active.stages.review.status !== 'stale' }
      ]
    : [
        { label: `正文齐了（${active.chapters.filter((chapter) => chapter.content.trim()).length}/${active.chapters.length} 章）`, ok: active.chapters.length > 0 && active.chapters.every((chapter) => chapter.content.trim()) },
        { label: `共 ${formatWordCount(words)} 字`, ok: words > 0 },
        { label: '人物与设定能对回原文', ok: active.facts.length > 0 },
        { label: active.stages.review.status === 'stale' ? '检查已过期，需重新检查' : '没有必须修的问题', ok: unresolved === 0 && active.stages.review.status !== 'stale' }
      ], [active, shots, voices, voicesNeeded.length, subtitles, unresolved, engine, words])
  const readyCount = checks.filter((check) => check.ok).length
  const renderHint = `${quality === 'draft' ? '草稿用 540p 快速合成，先看节奏。' : `成片按 ${resolution === '2160p' ? '4K' : '1080p'} 输出。`} ${FORMAT_HINTS[format]}${subtitleMode === 'burn' ? '字幕会压在画面里。' : '字幕会单独给一份文件。'}`

  const useRecommended = (): void => {
    setQuality('final')
    setFormat('mp4')
    setSubtitleMode('burn')
    setResolution('1080p')
    setAspect(active.timeline.aspect)
  }

  const exportFormat = async (format: 'txt' | 'md' | 'epub' | 'pdf' | 'docx' | 'srt' | 'ass' | 'package' | 'cover' | 'folder'): Promise<void> => {
    if (exporting) return
    setExporting(format)
    try {
      await run('export', { format, requestId: `export-${format}-${Date.now()}` })
      notify('info', '导出任务已开始；完成后会出现在下方交付记录。')
    } finally {
      setExporting(null)
    }
  }
  const exportAudio = async (format: 'wav' | 'mp3' | 'm4a' | 'flac'): Promise<void> => {
    if (audioExporting) return
    setAudioExporting(format)
    try {
      await run('export-audio', { format, requestId: `export-audio-${format}-${Date.now()}` })
      notify('info', '音频提取已开始；完成后会出现在下方交付记录。')
    } finally {
      setAudioExporting(null)
    }
  }
  const exportComic = async (): Promise<void> => {
    if (comicExporting) return
    setComicExporting(true)
    try {
      await run('export-comic', { requestId: `export-comic-${Date.now()}` })
      notify('info', '四格漫画排版已开始；完成后会出现在下方交付记录。')
    } finally {
      setComicExporting(false)
    }
  }

  const openProjectFolder = async (): Promise<void> => {
    try {
      await studioApi.openProjectDir(active.id)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const openPreflight = async (): Promise<void> => {
    if (preflightBusy) return
    setPreflightOpen(true)
    setPreflightBusy(true)
    try {
      const result = await run<StudioExportPreflight>('export-preflight', { projectId: active.id })
      setPreflight(result)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
      setPreflightOpen(false)
    } finally {
      setPreflightBusy(false)
    }
  }

  const render = async (): Promise<void> => {
    if (rendering || activeRenderJob) return
    setRendering(true)
    try {
      await run('render', { quality, subtitleMode, aspect, format, resolution })
      notify('info', quality === 'draft' ? '动态分镜草稿已排队合成。' : `成片已排队合成（${resolution === '2160p' ? '4K' : '1080p'} · ${format.toUpperCase()}）。`)
    } finally {
      setRendering(false)
    }
  }

  const open = async (delivery: StudioDelivery): Promise<void> => {
    try {
      await studioApi.openPath(active.id, delivery.path)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }
  const reveal = async (delivery: StudioDelivery): Promise<void> => {
    try {
      await studioApi.reveal(active.id, delivery.path)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const bookFormats = [
    { format: 'epub' as const, title: 'EPUB', desc: '电子书 · 手机和阅读器打开，带目录', icon: <BookOpen size={16} /> },
    { format: 'pdf' as const, title: 'PDF', desc: 'A4 排版稿 · 适合打印或发给编辑', icon: <FileType size={16} /> },
    { format: 'docx' as const, title: 'Word', desc: 'DOCX · 可以继续改字', icon: <FileText size={16} /> },
    { format: 'txt' as const, title: 'TXT', desc: '纯文本 · 哪里都能打开', icon: <FileCode2 size={16} /> },
    { format: 'md' as const, title: 'Markdown', desc: '方便逐行比较和版本管理', icon: <FileCode2 size={16} /> },
    { format: 'package' as const, title: '工程包', desc: '可继续编辑 · 素材都在', icon: <Package size={16} /> }
  ]

  return (
    <div className="studio-delivery">
      <header className="studio-delivery-head">
        <div className="studio-delivery-title">
          <span className="studio-eyebrow">交付 · {active.kind === 'drama' ? '影片' : '书稿'}</span>
          <h1>{active.title}</h1>
          <p>{active.logline}</p>
          <div className="studio-delivery-meta">
            <span>{studioKindLabel(active.kind)}</span>
            <i />
            <span>{active.kind === 'drama' ? `${active.timeline.durationSec ? formatDuration(active.timeline.durationSec) : '未排好'} · ${active.shots.length} 镜` : `${active.chapters.length} 章 · ${formatWordCount(words)} 字`}</span>
            <i />
            <span>{deliveries.length} 个文件</span>
            <i />
            <span>{readyCount}/{checks.length} 项已就绪</span>
          </div>
        </div>
        <div className="studio-delivery-actions">
          <Button variant="ghost" icon={<FileSearch size={13} />} onClick={() => void openPreflight()} title="检查字体、FFmpeg 与各格式是否就绪；不会生成文件">导出预检</Button>
          <Button variant="ghost" icon={<ShieldCheck size={13} />} onClick={() => navigateStage('review')}>检查</Button>
          <Button variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void openProjectFolder()}>打开作品文件夹</Button>
        </div>
      </header>

      <div className="studio-delivery-grid">
        <section className="studio-delivery-hero">
          <div className="studio-delivery-poster" style={{ aspectRatio: active.timeline.aspect === '9:16' ? '9 / 16' : active.timeline.aspect === '1:1' ? '1 / 1' : '16 / 9' }}>
            {latestVideo?.url ? (
              <video src={latestVideo.url} controls playsInline poster={coverDelivery?.url} />
            ) : coverDelivery?.url ? (
              <img src={coverDelivery.url} alt="" />
            ) : (
              <CoverThumb project={active} size="lg" />
            )}
            <div className="studio-delivery-poster-overlay">
              <span className="studio-eyebrow">{active.stages.delivery.status === 'stale' ? '旧成片 · 时间线已改' : latestVideo ? '最新成片' : '作品封面'}</span>
              <h2>{active.title}</h2>
              <p>{active.kind === 'drama' ? `${active.timeline.durationSec ? formatDuration(active.timeline.durationSec) : '待合成'} · ${active.timeline.aspect} · 本地创作` : `${formatWordCount(words)} 字 · ${active.chapters.length} 章`}</p>
            </div>
          </div>
          <div className="studio-delivery-readiness">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">导出预检</span>
              <b className="mono">{readyCount}/{checks.length}</b>
            </div>
            <StudioProgress value={(readyCount / checks.length) * 100} tone={readyCount === checks.length ? 'patina' : 'gold'} />
            <div className="studio-readiness-list">
              {checks.map((check) => <span key={check.label} className={check.ok ? 'is-ok' : ''}>{check.ok ? <Check size={11} /> : <span className="studio-dot" />} {check.label}</span>)}
            </div>
            {!canVideo && active.kind === 'drama' ? <p className="studio-hint">视频合成工具还没就绪：仍可导出工程、字幕和封面；到「设置 → 声音与工具」选择 ffmpeg.exe 后就能合成。</p> : null}
          </div>
        </section>

        <section className="studio-delivery-panel">
          {active.kind === 'drama' ? (
            <>
              <SectionTitle eyebrow="合成" title={latestVideo ? '重新合成或导出新版本' : '合成第一版草稿'} aside={<span className="studio-section-side">{activeRenderJob ? <Loader2 size={12} className="studio-spin" /> : <Sparkles size={12} />} {canVideo ? '本机合成' : '缺合成工具'}</span>}>
                草稿用 540p 快速预览；成片可选 1080p / 4K 与 MP4、MOV、MKV、WebM。合成不会改动素材和时间线。
              </SectionTitle>
              <div className="studio-render-recommend">
                <button type="button" onClick={useRecommended}>不知道怎么选？用推荐设置</button>
                <span>成片 · 1080p · MP4 · 画面内字幕</span>
              </div>
              <div className="studio-render-options">
                <div className="studio-render-option"><span>质量</span>
                  <Segmented value={quality} options={[{ value: 'draft', label: '草稿', description: '540p 快速预览，只看节奏' }, { value: 'final', label: '成片', description: '按你选的清晰度导出' }]} onChange={(value) => { setQuality(value); if (value === 'draft') setSubtitleMode('burn') }} ariaLabel="合成档位" />
                </div>
                <div className="studio-render-option"><span>画面比例</span>
                  <Segmented value={aspect} options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }]} onChange={setAspect} ariaLabel="成片画幅" />
                </div>
                <div className="studio-render-option"><span>字幕</span>
                  <Segmented value={subtitleMode} options={[{ value: 'burn', label: '画面内字幕', description: '观众不用另找字幕文件' }, { value: 'soft', label: '单独字幕', description: '播放器里可以开关' }]} onChange={setSubtitleMode} ariaLabel="字幕方式" />
                </div>
                <div className="studio-render-option"><span>格式</span>
                  <Segmented value={format} options={[{ value: 'mp4', label: 'MP4' }, { value: 'mov', label: 'MOV' }, { value: 'mkv', label: 'MKV' }, { value: 'webm', label: 'WebM' }]} onChange={(value) => setFormat(value as typeof format)} ariaLabel="成片格式" />
                </div>
                {quality === 'final' ? (
                  <div className="studio-render-option"><span>清晰度</span>
                    <Segmented value={resolution} options={[{ value: '1080p', label: '1080p' }, { value: '2160p', label: '4K' }]} onChange={(value) => setResolution(value as typeof resolution)} ariaLabel="成片清晰度" />
                  </div>
                ) : null}
              </div>
              <p className="studio-render-hint">{renderHint}</p>
              <div className="studio-render-action">
                <Button variant="gold" size="lg" icon={rendering || activeRenderJob ? <Loader2 size={15} className="studio-spin" /> : <Clapperboard size={15} />} onClick={() => void render()} disabled={rendering || Boolean(activeRenderJob)}>
                  {activeRenderJob ? '正在合成' : quality === 'draft' ? '合成草稿' : `导出成片 · ${resolution === '2160p' ? '4K' : '1080p'} ${format.toUpperCase()}`}
                </Button>
                {latestVideo ? <Button variant="ghost" size="lg" icon={<Play size={14} />} onClick={() => void open(latestVideo)}>用电脑播放器打开</Button> : null}
                <span className="studio-render-note">合成不会改动素材和时间线；失败的镜头会留在检查页。</span>
              </div>
              {latestVideo ? (
                <div className="studio-delivery-audio">
                  <span>成片音轨</span>
                  {(['wav', 'mp3', 'm4a', 'flac'] as const).map((audio) => (
                    <button key={audio} type="button" title={AUDIO_TITLES[audio]} onClick={() => void exportAudio(audio)} disabled={Boolean(audioExporting)}>
                      <Music2 size={12} /> {AUDIO_LABELS[audio]}
                      {audioExporting === audio ? <Loader2 size={11} className="studio-spin" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="studio-delivery-subformats">
                {active.shots.filter((shot) => shot.imageAssetId).length >= 4 ? (
                  <button type="button" onClick={() => void exportComic()} disabled={comicExporting}><ImageIcon size={14} /><span><b>四格漫画</b><em>2×2 拼图</em></span>{comicExporting ? <Loader2 size={11} className="studio-spin" /> : null}</button>
                ) : null}
                <button type="button" onClick={() => void exportFormat('srt')} disabled={Boolean(exporting)}><Subtitles size={14} /><span><b>SRT 字幕</b><em>逐条可改</em></span></button>
                <button type="button" onClick={() => void exportFormat('ass')} disabled={Boolean(exporting)}><Subtitles size={14} /><span><b>ASS 字幕</b><em>保留样式</em></span></button>
                <button type="button" onClick={() => void exportFormat('cover')} disabled={Boolean(exporting)}><ImageIcon size={14} /><span><b>封面</b><em>沿用当前封面图</em></span></button>
                <button type="button" onClick={() => void exportFormat('package')} disabled={Boolean(exporting)}><Package size={14} /><span><b>工程包</b><em>可继续编辑</em></span></button>
                <button type="button" onClick={() => void exportFormat('folder')} disabled={Boolean(exporting)}><FileArchive size={14} /><span><b>发布文件包</b><em>成片 + 封面 + 字幕</em></span></button>
              </div>
            </>
          ) : (
            <>
              <SectionTitle eyebrow="导出" title="电子书、排版稿与可继续修改的工程包" aside={<span className="studio-section-side"><Sparkles size={12} /> 本机导出</span>}>
                正文、目录与中文字体会一起带进文件；工程包保留全部章节、人物与任务记录，便于继续修改。
              </SectionTitle>
              <div className="studio-book-formats">
                {bookFormats.map((item) => (
                  <button key={item.format} type="button" onClick={() => void exportFormat(item.format)} disabled={Boolean(exporting)}>
                    <span className="studio-format-icon">{item.icon}</span>
                    <span><b>{item.title}</b><em>{item.desc}</em></span>
                    {exporting === item.format ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />}
                  </button>
                ))}
                <button type="button" onClick={() => void exportFormat('cover')} disabled={Boolean(exporting)}>
                  <span className="studio-format-icon"><ImageIcon size={16} /></span>
                  <span><b>封面</b><em>从封面素材或标题生成</em></span>
                  {exporting === 'cover' ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />}
                </button>
                <button type="button" onClick={() => void exportFormat('folder')} disabled={Boolean(exporting)}>
                  <span className="studio-format-icon"><FileArchive size={16} /></span>
                  <span><b>发布文件包</b><em>成书 + 封面 + 工程包</em></span>
                  {exporting === 'folder' ? <Loader2 size={13} className="studio-spin" /> : <Download size={13} />}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="studio-delivery-list">
        <SectionTitle eyebrow="文件" title="导出过的文件" aside={<span className="studio-section-side">{deliveries.length} 个文件 · 可核对</span>}>
          每个文件都有校验码和生成时间；换电脑或重装前，建议先把可编辑工程另存一份。
        </SectionTitle>
        {deliveries.length ? (
          <div className="studio-delivery-rows">
            {deliveries.map((delivery) => (
              <div key={delivery.id} className="studio-delivery-row" title={`校验码 ${delivery.sha256}`}>
                <span className={`studio-delivery-icon is-${delivery.kind}`}>{deliveryIcon(delivery.kind)}</span>
                <div className="studio-delivery-copy">
                  <b>{delivery.label}</b>
                  <span className="mono">{delivery.path} · {formatBytes(delivery.bytes)} · {timeAgo(delivery.createdAt)}</span>
                </div>
                <div className="studio-delivery-row-actions">
                  <button type="button" onClick={() => void open(delivery)}><ExternalLink size={12} /> 打开</button>
                  <button type="button" title="在文件夹中显示" onClick={() => void reveal(delivery)}><FolderOpen size={12} /> 找文件</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="studio-delivery-empty">
            <Package size={24} strokeWidth={1.2} />
            <h3>还没有导出文件</h3>
            <p>{active.kind === 'drama' ? '合成草稿后，成片与字幕会出现在这里。' : '选一个格式导出，第一个文件会出现在这里。'}</p>
          </div>
        )}
      </section>

      <footer className="studio-delivery-foot">
        <span><ShieldCheck size={12} /> 密钥不会跟着文件导出</span>
        <span><RefreshCw size={12} /> 导出错了可以重新合成</span>
        <span><Money value={active.runtime.budget.spent} /> 已记录费用</span>
        <button type="button" onClick={() => setSettingsOpen(true)}>模型与预算 <ArrowRight size={11} /></button>
      </footer>

      <Modal
        open={preflightOpen}
        onClose={() => setPreflightOpen(false)}
        title="导出预检"
        description="看看字体、视频工具和每种格式是否就绪；不会生成文件，也不会修改作品。"
        width={640}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setPreflightOpen(false)}>关闭</Button>
          </div>
        }
      >
        {preflightBusy && !preflight ? (
          <div className="studio-version-loading"><Loader2 size={15} className="studio-spin" /> 正在检查字体与工具…</div>
        ) : preflight ? (
          <div className="studio-preflight">
            <div className="studio-preflight-summary">
              <div>
                <span>中文字体</span>
                <b>{preflight.fonts.serif ? '衬线可用' : '衬线缺失'}{preflight.fonts.sans ? ' · 黑体可用' : ' · 黑体缺失'}</b>
                <em>
                  {preflight.fonts.bundledSerif
                    ? '随包 Noto Serif SC Variable'
                    : preflight.fonts.detected.slice(0, 5).join(' · ') || '未检测到中文字体文件'}
                </em>
              </div>
              <div>
                <span>FFmpeg</span>
                <b>{preflight.ffmpeg.available ? (preflight.ffmpeg.profile === 'enhanced' ? '已安装 · 增强包' : '已安装 · 默认包') : '未安装'}</b>
                <em>{preflight.ffmpeg.message}</em>
              </div>
            </div>
            <p className="studio-settings-hint">{preflight.fonts.detail}</p>
            <div className="studio-preflight-grid">
              {preflight.formats.map((item) => (
                <div key={item.format} className={item.ready ? 'is-ready' : ''}>
                  <span>{item.ready ? <Check size={11} /> : <X size={11} />}</span>
                  <div><b>{item.label}</b><em>{item.note}</em></div>
                </div>
              ))}
            </div>
            {preflight.warnings.length ? (
              <div className="studio-preflight-warnings">
                {preflight.warnings.map((warning) => <p key={warning}><AlertTriangle size={12} /> {warning}</p>)}
              </div>
            ) : <p className="studio-settings-hint">这台电脑已经满足主要导出条件；换电脑打开时，仍建议检查字体与播放器兼容性。</p>}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

interface Template {
  id: string
  title: string
  subtitle: string
  kind: StudioKind
  logline: string
  genre: string
  form: '速成草稿' | '精制' | '电影级'
  targetWords?: number
  targetSeconds?: number
  tags: string[]
}

const TEMPLATES: Template[] = [
  {
    id: 'rain-short',
    title: '雨夜短篇',
    subtitle: '12 章 · 情绪起伏 · 克制收尾',
    kind: 'short',
    logline: '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。她每修好一把伞，就会失去一段记忆。',
    genre: '都市奇幻',
    form: '速成草稿',
    targetWords: 18_000,
    tags: ['短篇', '雨夜', '记忆']
  },
  {
    id: 'long-serial',
    title: '长篇连载',
    subtitle: '三卷 · 按目标字数分章',
    kind: 'novel',
    logline: '一个修伞的女孩继承外婆的伞铺，每周三都会有一个失忆的少年，来修同一把黑伞。',
    genre: '都市奇幻',
    form: '精制',
    targetWords: 300_000,
    tags: ['长篇', '连载', '伞铺']
  },
  {
    id: 'drama-96',
    title: '96 秒漫剧',
    subtitle: '12 镜 · 配音 · 音乐 · 字幕',
    kind: 'drama',
    logline: '一个雨夜，修伞的女孩捡到一把会让时间倒流的伞。她每修好一把伞，就会失去一段记忆。',
    genre: '都市奇幻',
    form: '速成草稿',
    targetSeconds: 96,
    tags: ['漫剧', '分镜', '草稿']
  }
]

const INSPIRATIONS = [
  '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。',
  '凌晨书店只卖一本书，每本书里都夹着读者的未来。',
  '一档停播十年的深夜电台，突然收到来自明天的电话。',
  '租来的情感可以按小时计费，但副作用会留在身体里。'
]

const FILTERS: Array<{ id: 'all' | 'recent' | 'drama' | 'short' | 'novel' | 'templates'; label: string }> = [
  { id: 'all', label: '全部作品' },
  { id: 'recent', label: '最近打开' },
  { id: 'drama', label: '漫剧' },
  { id: 'short', label: '中短篇' },
  { id: 'novel', label: '长篇' },
  { id: 'templates', label: '模板' }
]

const KIND_OPTIONS: Array<{ value: StudioKind; title: string; desc: string; icon: React.ReactNode }> = [
  { value: 'drama', title: '漫剧', desc: '30–180 秒 · 分镜 · 配音 · 成片', icon: <Clapperboard size={16} strokeWidth={1.5} /> },
  { value: 'short', title: '中短篇', desc: '3–8 万字 · 章节 · 情绪起伏', icon: <BookMarked size={16} strokeWidth={1.5} /> },
  { value: 'novel', title: '长篇', desc: '20–100 万字 · 分卷分章 · 人物与设定', icon: <Library size={18} strokeWidth={1.5} /> }
]

function ProjectCard({ project, onDelete, onDuplicate }: { project: StudioProjectSummary; onDelete: () => void; onDuplicate: () => void }): React.JSX.Element {
  const openProject = useStudioStore((state) => state.openProject)
  return (
    <article className="studio-project-card">
      <button type="button" className="studio-project-cover" onClick={() => void openProject(project.id)} aria-label={`继续创作 ${project.title}`}>
        <CoverThumb summary={project} size="lg" />
        <span className="studio-project-type"><KindBadge kind={project.kind} /></span>
        {project.demo ? <span className="studio-demo-badge">示例</span> : null}
        <span className="studio-project-progress"><i style={{ width: `${Math.max(4, project.progress)}%` }} /></span>
      </button>
      <div className="studio-project-body">
        <div className="studio-project-title-row">
          <h3>{project.title}</h3>
          <span className="mono">{Math.max(0, project.progress)}%</span>
        </div>
        <p className="studio-project-logline">{project.logline || '还没有一句话介绍。'}</p>
        <div className="studio-project-meta">
          <span>{project.kind === 'drama' ? `${project.shots} 镜 · ${project.progress >= 90 ? '草稿就绪' : '制作中'}` : `${project.chapters} 章 · ${(project.words / 10000).toFixed(1)} 万字`}</span>
          <span>{timeAgo(project.updatedAt)}</span>
        </div>
        <div className="studio-project-actions">
          <button type="button" className="studio-link-btn" onClick={() => void openProject(project.id)}>
            继续创作 <ArrowUpRight size={12} />
          </button>
          <div className="studio-project-icon-actions">
            <button type="button" title="复制作品" aria-label="复制作品" onClick={onDuplicate}><Copy size={13} /></button>
            <button type="button" title="删除作品" aria-label="删除作品" onClick={onDelete}><Trash2 size={13} /></button>
          </div>
        </div>
      </div>
    </article>
  )
}

export function HomeView(): React.JSX.Element {
  const projects = useStudioStore((state) => state.projects)
  const engine = useStudioStore((state) => state.engine)
  const filter = useStudioStore((state) => state.libraryFilter)
  const search = useStudioStore((state) => state.search)
  const setSearch = useStudioStore((state) => state.setSearch)
  const setFilter = useStudioStore((state) => state.setLibraryFilter)
  const createProject = useStudioStore((state) => state.createProject)
  const run = useStudioStore((state) => state.run)
  const openProject = useStudioStore((state) => state.openProject)
  const duplicateProject = useStudioStore((state) => state.duplicateProject)
  const deleteProject = useStudioStore((state) => state.deleteProject)
  const busy = useStudioStore((state) => state.busy)
  const openGuide = useStudioStore((state) => state.openGuide)
  const openDemo = useStudioStore((state) => state.openDemo)
  const notify = useStudioStore((state) => state.notify)
  const [kind, setKind] = useState<StudioKind>('drama')
  const [logline, setLogline] = useState('')
  const [form, setForm] = useState<'速成草稿' | '精制' | '电影级'>('速成草稿')
  const [aspect, setAspect] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [advanced, setAdvanced] = useState(false)
  const [genre, setGenre] = useState('')
  const [audience, setAudience] = useState('')
  const [tone, setTone] = useState('')
  const [targetWords, setTargetWords] = useState(30_000)
  const [targetSeconds, setTargetSeconds] = useState(96)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [confirmDelete, setConfirmDelete] = useState<StudioProjectSummary | null>(null)
  const [creating, setCreating] = useState(false)

  const visibleProjects = useMemo(() => {
    let list = [...projects]
    if (filter === 'drama' || filter === 'short' || filter === 'novel') list = list.filter((project) => project.kind === filter)
    if (filter === 'recent') list = list.slice(0, 3)
    if (filter === 'templates') return []
    const query = search.trim().toLowerCase()
    if (query) list = list.filter((project) => `${project.title} ${project.logline}`.toLowerCase().includes(query))
    return list
  }, [projects, filter, search])

  const preview = useMemo(() => previewBrief(logline, kind), [logline, kind])

  const chooseKind = (value: StudioKind): void => {
    setKind(value)
    setTargetWords(value === 'short' ? 30_000 : value === 'novel' ? 300_000 : 0)
    setTargetSeconds(value === 'drama' ? 96 : 0)
  }

  const applyTemplate = (template: Template): void => {
    setKind(template.kind)
    setTargetWords(template.targetWords ?? (template.kind === 'short' ? 30_000 : template.kind === 'novel' ? 300_000 : 0))
    setTargetSeconds(template.targetSeconds ?? (template.kind === 'drama' ? 96 : 0))
    setLogline(template.logline)
    setGenre(template.genre)
    setForm(template.form)
    setAdvanced(false)
    inputRef.current?.focus()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const start = async (): Promise<void> => {
    if (!logline.trim() || creating) return
    if (!engine?.text.configured) {
      notify('error', '还没有可用的文本模型。请先在右上角设置 → 模型里连接模型；蓝图只由真实模型生成。')
      return
    }
    setCreating(true)
    try {
      const project = await createProject({
        kind,
        logline: logline.trim(),
        form,
        genre,
        audience,
        tone,
        aspect,
        targetWords: kind === 'short' || kind === 'novel' ? targetWords : undefined,
        targetSeconds: kind === 'drama' ? targetSeconds : undefined,
        constraints: kind === 'drama' ? ['角色外观保持一致', aspect] : []
      })
      await run('generate-blueprint', { useModel: true, requestId: `blueprint-${project.id}` })
      notify('info', '蓝图正在调用当前模型；标题、人物与结构都由模型按你的灵感生成。')
    } catch {
      // store 已提示错误
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="studio-home">
      <section className="studio-hero">
        <div className="studio-hero-glow" aria-hidden />
        <div className="studio-hero-top">
          <span className="studio-eyebrow">
            {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
          </span>
          <div className="studio-hero-actions">
            <span>一句话先出蓝图，再决定花多少。</span>
            <button type="button" className="studio-home-utility" onClick={openGuide}>使用指引</button>
            <button type="button" className="studio-home-utility is-gold" onClick={openDemo}>看演示</button>
          </div>
        </div>
        <h1 className="studio-hero-title">今天，想把哪句话变成作品？</h1>
        <p className="studio-hero-sub">
          先说一句。这里会给出故事主线、人物、结构与大概花费，再由你决定是否开始。
        </p>

        <div className="studio-brief-sheet">
          <div className="studio-brief-rule" aria-hidden />
          <div className="studio-kind-row" role="radiogroup" aria-label="作品形态">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                className={kind === option.value ? 'is-active' : ''}
                onClick={() => chooseKind(option.value)}
              >
                <span className="studio-kind-icon">{option.icon}</span>
                <span>
                  <b>{option.title}</b>
                  <em>{option.desc}</em>
                </span>
              </button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            className="studio-logline-input"
            value={logline}
            onChange={(event) => setLogline(event.target.value)}
            placeholder="例如：历史博士生穿越回南宋末年，力挽狂澜再造盛世。"
            maxLength={2000}
            rows={3}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void start()
              }
            }}
          />
          {logline.trim() ? (
            <div className={`studio-brief-preview is-${preview.confidence}`}>
              <span className="studio-brief-preview-state">
                <i /> {preview.confidence === 'high' ? '信息够用了' : preview.confidence === 'medium' ? '还差一点' : '先补主角'}
              </span>
              {preview.subject ? <span className="studio-brief-preview-chip">主角 · {preview.subject}</span> : null}
              {preview.goal ? <span className="studio-brief-preview-chip">想要 · {preview.goal}</span> : null}
              {preview.obstacle ? <span className="studio-brief-preview-chip">阻力 · {preview.obstacle}</span> : null}
              {preview.turn ? <span className="studio-brief-preview-chip">转折 · {preview.turn}</span> : null}
              {preview.questions.length ? <span className="studio-brief-preview-question">可以再补：{preview.questions[0]}</span> : null}
            </div>
          ) : null}
          <div className="studio-brief-controls">
            <Segmented
              value={form}
              options={[
                { value: '速成草稿', label: '速成草稿' },
                { value: '精制', label: '精制' },
                { value: '电影级', label: '电影级' }
              ]}
              onChange={(value) => setForm(value)}
              ariaLabel="制作精细度"
            />
            <Segmented
              value={aspect}
              options={[
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16' },
                { value: '1:1', label: '1:1' }
              ]}
              onChange={(value) => setAspect(value)}
              ariaLabel="画面比例"
            />
            <button type="button" className="studio-more-toggle" onClick={() => setAdvanced((value) => !value)}>
              {advanced ? '收起要求' : '补充要求'}
            </button>
            <div className="studio-brief-spacer" />
            <Button variant="gold" onClick={() => void start()} loading={creating} disabled={!logline.trim()} icon={<Sparkles size={14} />} iconRight={<ArrowRight size={13} />}>
              生成故事蓝图
            </Button>
          </div>
          {advanced ? (
            <div className="studio-advanced-fields">
              <label>
                <span>故事类型</span>
                <input value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="留空则由灵感判断，如：历史穿越 / 悬疑 / 现实" />
              </label>
              <label>
                <span>给谁看</span>
                <input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="例如：18–35 岁、喜欢短片" />
              </label>
              <label>
                <span>整体语气</span>
                <input value={tone} onChange={(event) => setTone(event.target.value)} placeholder="例如：克制、潮湿、温柔" />
              </label>
              <div className="studio-target-note">
                <span>目标</span>
                <Segmented
                  value={kind === 'drama' ? String(targetSeconds) : String(targetWords)}
                  options={kind === 'drama'
                    ? [{ value: '60', label: '60 秒' }, { value: '96', label: '96 秒' }, { value: '120', label: '120 秒' }]
                    : kind === 'short'
                      ? [{ value: '30000', label: '3 万字' }, { value: '50000', label: '5 万字' }, { value: '80000', label: '8 万字' }]
                      :  [{ value: '200000', label: '20 万字' }, { value: '300000', label: '30 万字' }, { value: '500000', label: '50 万字' }, { value: '1000000', label: '100 万字' }]}
                  onChange={(value) => kind === 'drama' ? setTargetSeconds(Number(value)) : setTargetWords(Number(value))}
                  ariaLabel="目标篇幅"
                />
              </div>
            </div>
          ) : null}
          <div className="studio-brief-foot">
            <span><i className="is-gold" /> {engine?.text.configured ? '生成蓝图会调用当前模型，费用按实际 token 计入预算' : '先连接文本模型才能生成蓝图；不提供本地模板'}</span>
            <span><i /> AI 改写不会覆盖你手动改的内容</span>
            <span className={`studio-brief-engine ${engine?.text.configured ? 'is-online' : ''}`}>
              <i /> {engine?.text.configured ? engine.text.modelLabel : '未连接文本模型'}
            </span>
          </div>
        </div>

        <div className="studio-inspirations">
          <span className="studio-inspiration-label">试试</span>
          {INSPIRATIONS.slice(0, 3).map((idea) => (
            <button key={idea} type="button" onClick={() => { setLogline(idea); inputRef.current?.focus() }}>
              {idea.length > 26 ? `${idea.slice(0, 24)}…` : idea}
            </button>
          ))}
        </div>
      </section>

      <section className="studio-library">
        <div className="studio-home-filter-row" role="tablist" aria-label="筛选作品">
          {FILTERS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? 'is-active' : ''} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <SectionTitle
          title={filter === 'templates' ? '从模板开始' : filter === 'recent' ? '最近打开' : '继续创作'}
          aside={
            <div className="studio-library-tools">
              <label className="studio-search">
                <Search size={13} strokeWidth={1.6} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索作品" aria-label="搜索作品" />
              </label>
            </div>
          }
        >
          {filter === 'templates' ? '模板只帮你搭好结构；故事、风格和花费仍由你决定。' : '打开就能接着写：章节、候选、镜头和时间线都在原处。'}
        </SectionTitle>

        {filter === 'templates' ? (
          <div className="studio-template-grid">
            {TEMPLATES.map((template) => (
              <button key={template.id} type="button" className={`studio-template-card is-${template.kind}`} onClick={() => applyTemplate(template)}>
                <span className="studio-template-glyph"><StageIcon stage={template.kind} size={22} /></span>
                <span className="studio-template-copy">
                  <b>{template.title}</b>
                  <em>{template.subtitle}</em>
                  <span>{template.logline}</span>
                </span>
                <span className="studio-template-tags">{template.tags.map((tag) => <i key={tag}>{tag}</i>)}</span>
                <span className="studio-template-use">用这个开始 <ArrowUpRight size={12} /></span>
              </button>
            ))}
          </div>
        ) : visibleProjects.length ? (
          <div className="studio-project-grid">
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onDelete={() => setConfirmDelete(project)}
                onDuplicate={() => void duplicateProject(project.id)}
              />
            ))}
            <button type="button" className="studio-project-new" onClick={() => { setFilter('all'); inputRef.current?.focus() }}>
              <span><Plus size={18} /></span>
              <b>新建作品</b>
              <em>从一句话开始</em>
            </button>
          </div>
        ) : (
          <div className="studio-library-empty">
            <StudioMark size={44} />
            <h3>{search ? '没有找到这个作品' : '还没有作品'}</h3>
            <p>{search ? '换一个关键词，或清空搜索。' : '先在上面写一句话，Morrow 会给你一份可修改的故事蓝图。'}</p>
            {search ? <button type="button" onClick={() => setSearch('')}>清空搜索</button> : null}
          </div>
        )}
      </section>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="删除这个作品？"
        description="作品会移入回收目录，不会立刻永久删除；但它会从作品库消失。"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>保留作品</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDelete) void deleteProject(confirmDelete.id)
                setConfirmDelete(null)
              }}
            >
              移入回收目录
            </Button>
          </div>
        }
        width={480}
      >
        {confirmDelete ? <p className="studio-confirm-text"><b>{confirmDelete.title}</b><br />{confirmDelete.logline}</p> : null}
      </Modal>
    </div>
  )
}

export function IllustrationDialog({ chapter, onClose }: { chapter: StudioChapter; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [generating, setGenerating] = useState(false)
  const [positions, setPositions] = useState<Record<string, number>>({})
  const [attaching, setAttaching] = useState<string | null>(null)
  if (!active) return null
  const current = active.chapters.find((item) => item.id === chapter.id) ?? chapter
  const candidates = active.assets.filter((asset) => asset.kind === 'image' && asset.tags.includes(`chapter:${chapter.id}`))
  const attachedIds = new Set(current.illustrations.map((item) => item.assetId))
  const otherImages = active.assets.filter((asset) => asset.kind === 'image' && !candidates.some((item) => item.id === asset.id))
  const generate = async (): Promise<void> => {
    if (generating) return
    setGenerating(true)
    try {
      const result = await run('generate-chapter-illustration', { chapterId: chapter.id, count: 2 })
      notify('info', result.message ?? '配图草稿已排队；用之前不会插进正文。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }
  const attach = async (assetId: string): Promise<void> => {
    setAttaching(assetId)
    try {
      await run('attach-chapter-illustration', {
        chapterId: chapter.id,
        assetId,
        afterParagraph: positions[assetId] ?? 0
      })
      notify('success', '配图已插入；可以继续调整位置或移除。')
    } finally {
      setAttaching(null)
    }
  }
  const remove = async (illustrationId: string): Promise<void> => {
    await run('remove-chapter-illustration', { chapterId: chapter.id, illustrationId })
  }
  const card = (asset: (typeof active.assets)[number], attached: boolean): React.JSX.Element => (
    <div key={asset.id} className="studio-illustration-card">
      <img src={asset.thumbUrl ?? asset.url} alt={asset.title} />
      <div className="studio-illustration-copy">
        <b>{asset.title}</b>
        <span>{attached ? '已插入' : '草稿'}</span>
      </div>
      {!attached ? (
        <div className="studio-illustration-actions">
          <label>
            第
            <input
              type="number"
              min={0}
              max={Math.max(0, chapterParagraphCount(current.content))}
              value={positions[asset.id] ?? 0}
              onChange={(event) => setPositions((state) => ({ ...state, [asset.id]: Math.max(0, Number(event.target.value) || 0) }))}
              aria-label="插入到第几段之后"
            />
            段后
          </label>
          <Button variant="ghost" size="sm" loading={attaching === asset.id} onClick={() => void attach(asset.id)}>用这张</Button>
        </div>
      ) : null}
    </div>
  )
  return (
    <Modal
      open
      onClose={onClose}
      title={`章节配图 · ${current.title}`}
      description="配图只影响这一章的排版，不会改正文；先生成一版草稿，点“用这张”才插入。"
      width={760}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>完成</Button>
        </div>
      }
    >
      <div className="studio-illustration-panel">
        <div className="studio-illustration-toolbar">
          <div>
            <b>当前配图 {current.illustrations.length} 张</b>
            <span>{engine?.media.imageReady ? '本机画面引擎就绪' : '画面引擎未就绪，仍可采用作品里已有的图片'}</span>
          </div>
          <Button variant="gold" size="sm" icon={generating ? <Loader2 size={13} className="studio-spin" /> : <ImagePlus size={13} />} onClick={() => void generate()} disabled={generating}>
            先生成 2 张
          </Button>
        </div>
        {current.illustrations.length ? (
          <div className="studio-illustration-grid">
            {current.illustrations.map((item) => {
              const asset = active.assets.find((entry) => entry.id === item.assetId)
              if (!asset) return null
              return (
                <div key={item.id} className="studio-illustration-card is-attached">
                  <img src={asset.thumbUrl ?? asset.url} alt={item.caption ?? asset.title} />
                  <div className="studio-illustration-copy">
                    <b>{item.caption ?? asset.title}</b>
                    <span>第 {item.afterParagraph} 段后</span>
                  </div>
                  <button type="button" className="studio-illustration-remove" onClick={() => void remove(item.id)} title="移除配图" aria-label="移除配图"><Trash2 size={12} /></button>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="studio-hint">还没有插入配图。先生成一版，或从作品已有图片里挑一张。</p>
        )}
        {candidates.filter((asset) => !attachedIds.has(asset.id)).length ? (
          <section className="studio-illustration-section">
            <b>本章草稿</b>
            <div className="studio-illustration-grid">{candidates.filter((asset) => !attachedIds.has(asset.id)).map((asset) => card(asset, false))}</div>
          </section>
        ) : null}
        {otherImages.length ? (
          <section className="studio-illustration-section">
            <b>作品已有图片</b>
            <div className="studio-illustration-grid">{otherImages.slice(0, 12).map((asset) => card(asset, attachedIds.has(asset.id)))}</div>
          </section>
        ) : null}
      </div>
    </Modal>
  )
}

function chapterParagraphCount(content: string): number {
  return content.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).length
}

function levelIcon(level: 'info' | 'warn' | 'error'): React.JSX.Element {
  if (level === 'error') return <CircleAlert size={14} />
  if (level === 'warn') return <AlertTriangle size={14} />
  return <Info size={14} />
}

export function ReviewView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const setView = useStudioStore((state) => state.setView)
  const selectShot = useStudioStore((state) => state.selectShot)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const cancelJob = useStudioStore((state) => state.cancelJob)
  const [visualBusy, setVisualBusy] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoConfirm, setAutoConfirm] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [reconciling, setReconciling] = useState<string | null>(null)
  if (!active) return <div />
  const checks = active.checks
  const errors = checks.filter((check) => check.level === 'error')
  const warns = checks.filter((check) => check.level === 'warn')
  const infos = checks.filter((check) => check.level === 'info')
  const jobs = [...active.jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 14)
  const visuals = active.shots.filter((shot) => shot.imageAssetId || shot.videoAssetId).length
  const voicesNeeded = active.shots.filter((shot) => shot.dialogue.trim())
  const voices = voicesNeeded.filter((shot) => shot.voiceAssetId).length
  const subtitles = active.timeline.clips.filter((clip) => clip.kind === 'subtitle').length
  const words = active.chapters.reduce((sum, chapter) => sum + chapter.content.replace(/\s+/g, '').length, 0)
  const missingImages = active.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId).length
  const missingVoices = active.shots.filter((shot) => shot.dialogue.trim() && !shot.voiceAssetId).length
  const hasMusic = active.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music') && !asset.tags.includes('draft'))
  const emptyChapters = active.chapters.filter((chapter) => !chapter.content.trim()).length
  const autoSteps = active.kind === 'drama'
    ? [
        missingImages ? `补齐 ${missingImages} 镜缺失画面` : '',
        missingVoices ? `补齐 ${missingVoices} 段台词配音` : '',
        hasMusic ? '' : '生成一段配乐',
        active.timeline.clips.length ? '沿用已保存的时间线' : '自动排好时间线',
        '合成一版可审看的草稿'
      ].filter(Boolean)
    : [emptyChapters ? `连续续写最多 ${Math.min(3, emptyChapters)} 个空章` : '没有空章需要续写']
  const candidates = active.chapters.reduce((sum, chapter) => sum + chapter.candidates.length, 0)
  const retryJob = async (jobId: string): Promise<void> => {
    try {
      await run('retry-job', { jobId })
      notify('info', '已按任务输入快照重新排队；旧记录保留以便核对。')
    } catch {
      // store 已提示错误
    }
  }
  const reconcileJob = async (jobId: string): Promise<void> => {
    if (reconciling) return
    setReconciling(jobId)
    try {
      const result = await run('reconcile-external', { jobId })
      notify('info', result.message ?? '已开始核对并取回外部任务结果。')
      setExpandedJobId(jobId)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setReconciling(null)
    }
  }
  const jobCost = jobs.reduce((sum, job) => sum + (typeof job.cost === 'number' ? job.cost : 0), 0)
  const unknownCost = jobs.some((job) => job.cost === null)
  const reviewRan = active.stages.review.status === 'done' || active.stages.review.status === 'review'
  const readiness = useMemo(() => {
    const rows = active.kind === 'drama'
      ? [
          { label: `${visuals}/${active.shots.length} 镜有画面`, ok: visuals === active.shots.length && active.shots.length > 0 },
          { label: `${voices}/${voicesNeeded.length} 段台词有配音`, ok: voices === voicesNeeded.length },
          { label: `${subtitles} 条字幕`, ok: subtitles > 0 },
          { label: '配乐已就位', ok: active.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music') && !asset.tags.includes('draft')) },
          { label: '时间线已排好', ok: active.timeline.clips.length > 0 },
          { label: '已合成成片', ok: active.deliveries.some((delivery) => isStudioVideoDelivery(delivery.kind)) },
          { label: reviewRan ? '检查已运行' : '尚未运行检查', ok: reviewRan }
        ]
      : [
          { label: `${active.chapters.filter((chapter) => chapter.content.trim()).length}/${active.chapters.length} 章有正文`, ok: active.chapters.length > 0 && active.chapters.every((chapter) => chapter.content.trim()) },
          { label: `${candidates} 个候选待采用`, ok: candidates === 0 },
          { label: '人物与事实可追溯', ok: active.facts.length > 0 },
          { label: '已导出交付物', ok: active.deliveries.length > 0 },
          { label: reviewRan ? '检查已运行' : '尚未运行检查', ok: reviewRan }
        ]
    return rows
  }, [active, visuals, voices, voicesNeeded.length, subtitles, candidates, reviewRan])
  const readyCount = readiness.filter((row) => row.ok).length
  const rerun = async (): Promise<void> => {
    await run('review')
    notify('info', '检查完成，结果已写进作品。')
  }
  const fixMissing = async (): Promise<void> => {
    const missing = active.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId)
    if (!missing.length) return
    await run('batch-shot-images', { shotIds: missing.map((shot) => shot.id), requestId: `review-fix-${Date.now()}` })
    notify('info', `已排队补齐 ${missing.length} 镜画面。`)
  }
  const modelReview = async (): Promise<void> => {
    if (modelBusy) return
    setModelBusy(true)
    try {
      const result = await run('model-review', { requestId: `model-review-${Date.now()}` })
      notify('info', result.message ?? '模型审稿已排队。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setModelBusy(false)
    }
  }
  const visualCheck = async (): Promise<void> => {
    if (visualBusy) return
    setVisualBusy(true)
    try {
      const result = await run('visual-check')
      notify('info', result.message ?? '视觉检查已排队。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setVisualBusy(false)
    }
  }
  const voiceAudit = async (): Promise<void> => {
    if (voiceBusy) return
    setVoiceBusy(true)
    try {
      await run('voice-audit')
      notify('success', '人物语气审稿完成，结果已写入检查项。')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setVoiceBusy(false)
    }
  }
  const autoAdvance = async (): Promise<void> => {
    if (autoBusy) return
    setAutoBusy(true)
    try {
      const result = await run('auto-advance', { useModel: true, renderDraft: active.kind === 'drama' })
      notify('info', result.message ?? '已排队补齐缺失内容。')
      setAutoConfirm(false)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setAutoBusy(false)
    }
  }
  const jump = (targetId?: string): void => {
    if (!targetId) return
    const shot = active.shots.find((item) => item.id === targetId)
    if (shot) {
      selectShot(shot.id)
      setView('storyboard')
      return
    }
    const chapter = active.chapters.find((item) => item.id === targetId)
    if (chapter) {
      selectChapter(chapter.id)
      setView('writing')
      return
    }
    const fact = active.facts.find((item) => item.id === targetId)
    if (fact) {
      if (fact.chapterId) {
        selectChapter(fact.chapterId)
        setView('writing')
        return
      }
      if (fact.sceneId) {
        const shot = active.shots.find((item) => item.sceneId === fact.sceneId)
        if (shot) {
          selectShot(shot.id)
          setView('storyboard')
          return
        }
      }
    }
    const clip = active.timeline.clips.find((item) => item.id === targetId)
    if (clip) {
      navigateStage('timeline')
    }
  }

  return (
    <div className="studio-review">
      <header className="studio-review-head">
        <div>
          <span className="studio-eyebrow">检查与记录 · {active.kind === 'drama' ? '08' : active.kind === 'novel' ? '05' : '04'}</span>
          <h1>制作检查</h1>
          <p>每一项都能核对、能重做、能说明原因。</p>
          <div className="studio-review-meta">
            <span>{checks.length ? `${errors.length} 个错误` : '尚未检查'}</span>
            <i />
            <span>{checks.length ? `${warns.length} 条提醒` : '运行后写入记录'}</span>
            <i />
            <span>{readyCount}/{readiness.length} 项就绪</span>
            <i />
            <span>已花费用 ¥{active.runtime.budget.spent.toFixed(2)}</span>
          </div>
        </div>
        <div className="studio-review-actions">
          <Button variant="ghost" icon={autoBusy ? <Loader2 size={13} className="studio-spin" /> : <Sparkles size={13} />} onClick={() => setAutoConfirm(true)} disabled={autoBusy}>
            {active.kind === 'drama' ? '自动补齐并合成草稿' : '自动续写空章'}
          </Button>
          {active.kind === 'drama' && visuals > 0 ? (
            <Button variant="ghost" icon={visualBusy ? <Loader2 size={13} className="studio-spin" /> : <ImageIcon size={13} />} onClick={() => void visualCheck()} disabled={visualBusy}>
              逐镜检查画面
            </Button>
          ) : null}
          {active.kind !== 'drama' && active.chapters.some((chapter) => chapter.content.trim()) ? (
            <Button variant="secondary" icon={modelBusy ? <Loader2 size={13} className="studio-spin" /> : <Sparkles size={13} />} onClick={() => void modelReview()} disabled={modelBusy}>
              模型审稿
            </Button>
          ) : null}
          {checks.length ? <Button variant="gold" icon={<RefreshCw size={13} />} onClick={() => void rerun()}>重新检查</Button> : null}
        </div>
      </header>

      <div className="studio-review-grid">
        <section className="studio-review-checks">
          <SectionTitle eyebrow="发现的问题" title={errors.length ? `${errors.length} 个问题需要处理` : warns.length ? `${warns.length} 条提醒需要你判断` : checks.length ? '检查通过，没有发现问题' : '还没有检查记录'}>
            {checks.length ? '错误会阻止导出；提醒不一定错，但需要你确认；信息项只是当前状态。' : '会检查缺失素材、配音时长、时间线引用、设定冲突和预算。'}
          </SectionTitle>
          {checks.length === 0 ? (
            <div className="studio-review-empty">
              <ShieldCheck size={26} strokeWidth={1.2} />
              <h3>先跑一次检查</h3>
              <p>检查只读作品，不会改动正文或镜头。</p>
              <Button variant="gold" onClick={() => void rerun()} icon={<RefreshCw size={13} />}>运行检查</Button>
            </div>
          ) : (
            <div className="studio-finding-list">
              {[...errors, ...warns, ...infos].map((check, index) => (
                <div key={check.id} className={`studio-finding is-${check.level}`}>
                  <span className="studio-finding-index mono">{String(index + 1).padStart(2, '0')}</span>
                  <span className="studio-finding-icon">{levelIcon(check.level)}</span>
                  <div className="studio-finding-copy">
                    <b>{check.title}</b>
                    <p>{check.detail}</p>
                  </div>
                  {check.targetId ? <button type="button" className="studio-finding-jump" onClick={() => jump(check.targetId)}>定位 <ArrowRight size={11} /></button> : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="studio-review-side">
          <section className="studio-readiness">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">就绪情况</span>
              <b className="mono">{readyCount}/{readiness.length}</b>
            </div>
            <StudioProgress value={(readyCount / readiness.length) * 100} tone={readyCount === readiness.length ? 'patina' : 'gold'} />
            <div className="studio-readiness-list">
              {readiness.map((row) => (
                <span key={row.label} className={row.ok ? 'is-ok' : ''}>
                  {row.ok ? <Check size={11} /> : <X size={11} />} {row.label}
                </span>
              ))}
            </div>
            {active.kind === 'drama' && visuals < active.shots.length ? (
              <Button variant="ghost" size="sm" icon={<ImageIcon size={12} />} onClick={() => void fixMissing()}>补齐缺失画面</Button>
            ) : null}
            {active.kind === 'drama' ? (
              <Button variant="ghost" size="sm" icon={<Film size={12} />} onClick={() => navigateStage('timeline')}>打开时间线</Button>
            ) : (
              <Button variant="ghost" size="sm" icon={<Package size={12} />} onClick={() => navigateStage('delivery')}>去交付页</Button>
            )}
          </section>

          <section className="studio-review-engine">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">使用的引擎</span>
              <button type="button" onClick={() => setSettingsOpen(true)}>管理 <ExternalLink size={10} /></button>
            </div>
            <div className={`studio-engine-row ${engine?.text.configured ? 'is-on' : ''}`}>
              <Sparkles size={13} />
              <div><b>文本模型</b><span title={engine?.text.message ?? undefined}>{engine?.text.configured ? `${engine.text.providerLabel} · ${engine.text.modelLabel}` : '还没有可用的文字模型，去设置连接一个。'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.media.imageReady ? 'is-on' : ''}`}>
              <ImageIcon size={13} />
              <div><b>画面引擎</b><span title={engine?.media.message ?? undefined}>{engine?.media.imageReady ? '已就绪' : engine?.media.message ?? '未检查'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.media.videoReady ? 'is-on' : ''}`}>
              <Film size={13} />
              <div><b>视频引擎</b><span>{engine?.media.videoReady ? '已就绪 · 图片可以变成视频' : '未就绪 · 草稿不需要视频'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.ffmpeg.available ? 'is-on' : ''}`}>
              <Wrench size={13} />
              <div><b>FFmpeg</b><span title={engine?.ffmpeg.available ? engine.ffmpeg.version?.slice(0, 48) : engine?.ffmpeg.message ?? undefined}>{engine?.ffmpeg.available ? '已就绪' : engine?.ffmpeg.message ?? '未检查'}</span></div>
              <i />
            </div>
            <div className={`studio-engine-row ${engine?.voices.length ? 'is-on' : ''}`}>
              <Mic2 size={13} />
              <div><b>系统声线</b><span>{engine?.voices.length ? `${engine.voices.length} 个可用` : engine?.voiceError ?? '未检测到'}</span></div>
              <i />
            </div>
          </section>

          <section className="studio-review-budget">
            <div className="studio-readiness-head">
              <span className="studio-eyebrow">费用</span>
              <b className="mono">¥{active.runtime.budget.spent.toFixed(2)} / {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</b>
            </div>
            {active.runtime.budget.limit ? <StudioProgress value={(active.runtime.budget.spent / active.runtime.budget.limit) * 100} tone={active.runtime.budget.spent > active.runtime.budget.limit ? 'rust' : 'gold'} /> : <p className="studio-hint">没有设置上限；花费仍会逐项记录。</p>}
            <p>任务合计 <Money value={jobCost} />{unknownCost ? ' + 未知项' : ''}；按实际用量和外部账单记录，不知道单价就写未知。</p>
            <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>调整预算与策略</Button>
          </section>
        </aside>
      </div>

      <section className="studio-voice-audit">
        <SectionTitle
          eyebrow="人物语气"
          title="人物语气审稿"
          aside={(
            <button type="button" className="studio-link-btn" onClick={() => void voiceAudit()} disabled={voiceBusy}>
              {voiceBusy ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} {active.voiceAudit ? '重新审稿' : '运行人物语气审稿'}
            </button>
          )}
        >
          从正文与分镜台词里提取有明确说话人的句子，核对句长、问句比例、口头习惯与称谓；只报可核对的差异，不猜人物心理。
        </SectionTitle>
        {active.voiceAudit ? (
          <>
            <div className="studio-voice-summary">
              <span>{active.voiceAudit.profiles.filter((profile) => profile.lineCount > 0).length} 个角色有台词</span>
              <i />
              <span>{active.voiceAudit.profiles.reduce((sum, profile) => sum + profile.lineCount, 0)} 句可归属台词</span>
              <i />
              <span>{active.voiceAudit.unresolved} 句无法归属</span>
              <i />
              <span>{active.voiceAudit.warnings.length} 条提醒</span>
              <i />
              <span>{timeAgo(active.voiceAudit.createdAt)}</span>
            </div>
            {active.voiceAudit.profiles.filter((profile) => profile.lineCount > 0).length ? (
              <div className="studio-voice-profiles">
                {active.voiceAudit.profiles.filter((profile) => profile.lineCount > 0).map((profile) => (
                  <article key={profile.characterId} className="studio-voice-profile">
                    <header>
                      <b>{profile.name}</b>
                      <span>{profile.lineCount} 句 · {profile.words} 字</span>
                    </header>
                    <p>{profile.summary}</p>
                    <div className="studio-voice-metrics">
                      <span>平均 {profile.avgLine} 字</span>
                      <span>问句 {Math.round(profile.questionRatio * 100)}%</span>
                      <span>感叹 {Math.round(profile.exclaimRatio * 100)}%</span>
                    </div>
                    {profile.topPhrases.length ? <em>高频用语：{profile.topPhrases.join('、')}</em> : null}
                    {profile.addressTerms.length ? <em>称谓：{profile.addressTerms.join('、')}</em> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="studio-hint">还没有可归属的台词。正文里写“张三说：‘……’”或分镜台词用“角色名：台词”，下一轮审稿就能读到。</p>
            )}
            {active.voiceAudit.warnings.length ? (
              <div className="studio-voice-warnings">
                {active.voiceAudit.warnings.map((warning, index) => (
                  <div key={`${warning.title}-${index}`} className={`studio-voice-warning is-${warning.level}`}>
                    <AlertTriangle size={13} />
                    <div><b>{warning.title}</b><p>{warning.detail}</p></div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="studio-voice-empty">
            <Mic2 size={22} strokeWidth={1.2} />
            <p>运行一次审稿，看看每个角色说话是否像同一个人。</p>
            <Button variant="ghost" size="sm" onClick={() => void voiceAudit()} disabled={voiceBusy}>开始审稿</Button>
          </div>
        )}
      </section>

      <section className="studio-receipts">
        <SectionTitle eyebrow="任务记录" title="每次花钱都有记录" aside={<span className="studio-section-side">{active.runtime.queuePaused ? '队列已暂停' : `${jobs.length} 条最近任务`} <button type="button" className="studio-link-btn" onClick={() => void run(active.runtime.queuePaused ? 'resume-queue' : 'pause-queue')}>{active.runtime.queuePaused ? '恢复队列' : '暂停队列'}</button></span>}>
          任务先写盘再提交；重复点击只算一个任务；结果不确定时进入“需核对”，不自动重试。
        </SectionTitle>
        <div className="studio-receipt-table">
          <div className="studio-receipt-row is-head">
            <span>任务</span><span>状态</span><span>进度</span><span>费用</span><span>时间</span><span />
          </div>
          {jobs.map((job) => (
            <div key={job.id} className="studio-receipt-row">
              <div className="studio-receipt-task">
                <StageIcon stage={job.stage === 'asset' ? 'visuals' : job.stage} size={13} />
                <div>
                  <b>{job.label}</b><span>{job.message}</span>
                  <button
                    type="button"
                    className="studio-receipt-events-toggle"
                    aria-expanded={expandedJobId === job.id}
                    onClick={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                  >
                    消息流 {job.events?.length ?? 1}
                  </button>
                  {expandedJobId === job.id ? (
                    <div className="studio-receipt-events">
                      {(job.events?.length ? job.events : [{ at: job.createdAt, status: job.status, message: job.message, progress: job.progress }]).map((event, index) => (
                        <div key={`${event.at}-${index}`} className={`studio-receipt-event is-${event.status}`}>
                          <time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                          <span>{studioJobStatusLabel(event.status)}</span>
                          <p>{event.message}</p>
                          <em className="mono">{event.progress}%</em>
                        </div>
                      ))}
                      {job.outputs.length ? (
                        <div className="studio-receipt-outputs">
                          {job.outputs.map((output) => <span key={`${output.label}-${output.path ?? output.assetId ?? ''}`}>{output.label}{output.path ? ` · ${output.path}` : ''}</span>)}
                        </div>
                      ) : null}
                      {job.remoteId ? <p className="studio-receipt-remote mono">外部任务号 {job.remoteId}</p> : null}
                      {job.remoteId && (job.kind === 'image' || job.kind === 'video') ? (
                        <button type="button" className="studio-receipt-reconcile" onClick={() => void reconcileJob(job.id)} disabled={reconciling === job.id}>
                          {reconciling === job.id ? <Loader2 size={11} className="studio-spin" /> : <RefreshCw size={11} />} 取回外部结果
                        </button>
                      ) : null}
                      {job.retry ? <p className="studio-receipt-remote">可用输入快照重试：{job.retry.action}</p> : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <JobStatus job={job} />
              <span className="mono">{job.progress}%</span>
              <Money value={job.cost} />
              <span>{timeAgo(job.createdAt)}</span>
              <span>
                {job.status === 'running' || job.status === 'queued' ? (
                  <button type="button" className="studio-receipt-cancel" onClick={() => void cancelJob(job.id)}>取消</button>
                ) : job.status === 'failed' || job.status === 'review' ? (
                  <span className="studio-receipt-note">需核对{job.retry ? <button type="button" className="studio-receipt-retry" onClick={() => void retryJob(job.id)}>重试</button> : null}</span>
                ) : null}
              </span>
            </div>
          ))}
          {!jobs.length ? <p className="studio-hint">还没有任务记录。生成蓝图、画面、配音或成片后会出现在这里。</p> : null}
        </div>
      </section>

      <footer className="studio-review-foot">
        <span><FolderOpen size={12} /> 作品与任务记录在本地数据目录</span>
        <span><Clock3 size={12} /> 本页只检查，不改正文、镜头或时间线</span>
        <span><CheckCircle2 size={12} /> 发布前还会再跑一遍完整流程</span>
      </footer>

      <Modal
        open={autoConfirm}
        onClose={() => setAutoConfirm(false)}
        title={active.kind === 'drama' ? '自动推进到草稿' : '自动续写空章'}
        description="只补还没有的内容，不覆盖手改；每个付费步骤仍会单独经过预算闸门。"
        width={520}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setAutoConfirm(false)} disabled={autoBusy}>取消</Button>
            <Button variant="gold" onClick={() => void autoAdvance()} loading={autoBusy}>
              {active.kind === 'drama' ? '开始补齐并合成' : '开始续写'}
            </Button>
          </div>
        }
      >
        <ol className="studio-auto-steps">
          {autoSteps.map((step) => <li key={step}><Check size={12} /> {step}</li>)}
        </ol>
        <p className="studio-settings-hint">
          预算：已记录 ¥{active.runtime.budget.spent.toFixed(2)} / 上限 {active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}。
          超预算的任务会停下并说明原因，不会悄悄继续。{active.kind === 'drama' ? '草稿合成使用本机 FFmpeg，不计模型费用。' : '续写会按当前模型路由计费；没有可用模型时不会生成正文。'}
        </p>
      </Modal>
    </div>
  )
}

interface ShotDraft {
  title: string
  action: string
  camera: string
  shotSize: string
  durationSec: number
  dialogue: string
  speaker: string
  prompt: string
  negative: string
  continuity: string
}

function draftOf(shot: StudioShot): ShotDraft {
  return {
    title: shot.title,
    action: shot.action,
    camera: shot.camera,
    shotSize: shot.shotSize,
    durationSec: shot.durationSec,
    dialogue: shot.dialogue,
    speaker: shot.speaker,
    prompt: shot.prompt,
    negative: shot.negative,
    continuity: shot.continuity
  }
}

function SceneScript({ sceneIndex }: { sceneIndex: number }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const scene = active?.scenes[sceneIndex]
  const [synopsis, setSynopsis] = useState(scene?.synopsis ?? '')
  const shots = active && scene ? active.shots.filter((shot) => shot.sceneId === scene.id).sort((a, b) => a.number - b.number) : []
  useEffect(() => {
    setSynopsis(scene?.synopsis ?? '')
  }, [scene?.id])
  if (!active || !scene) return null
  const save = async (): Promise<void> => {
    if (synopsis !== scene.synopsis) await run('save-scene', { sceneId: scene.id, synopsis })
  }
  return (
    <article className="studio-script-scene">
      <header>
        <span className="studio-script-number mono">SCENE {String(sceneIndex + 1).padStart(2, '0')}</span>
        <div>
          <h3>{scene.title}</h3>
          <p>{scene.location} · {scene.timeOfDay} · {scene.beat}</p>
        </div>
        <span className="studio-script-count mono">{shots.length} 镜</span>
      </header>
      <textarea
        className="studio-script-synopsis"
        value={synopsis}
        onChange={(event) => setSynopsis(event.target.value)}
        onBlur={() => void save()}
        rows={2}
        aria-label={`场景 ${sceneIndex + 1} 梗概`}
      />
      <div className="studio-script-cast">
        {scene.characters.map((name) => <span key={name}>{name}</span>)}
      </div>
      <div className="studio-script-shots">
        {shots.map((shot) => (
          <button key={shot.id} type="button" onClick={() => { useStudioStore.getState().setStoryboardTab('board'); useStudioStore.getState().selectShot(shot.id) }}>
            <span className="mono">{String(shot.number).padStart(2, '0')}</span>
            <div>
              <b>{shot.title}</b>
              <p>{shot.action}</p>
              {shot.dialogue ? <em>{shot.speaker}：“{shot.dialogue}”</em> : null}
            </div>
            <span className="mono">{shot.durationSec}s</span>
            <ChevronRight size={12} />
          </button>
        ))}
      </div>
    </article>
  )
}

function ShotInspector({ shot, onClose }: { shot: StudioShot; onClose: () => void }): React.JSX.Element | null {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const selectShot = useStudioStore((state) => state.selectShot)
  const [draft, setDraft] = useState<ShotDraft>(draftOf(shot))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [referenceOpen, setReferenceOpen] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)
  useEffect(() => {
    setDraft(draftOf(shot))
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot.id])
  if (!active) return null
  const cloudTts = active.runtime.tts?.mode === 'cloud'
  const scene = active.scenes.find((item) => item.id === shot.sceneId)
  const sourceChapter = scene?.sourceChapterId ? active.chapters.find((chapter) => chapter.id === scene.sourceChapterId) : undefined
  const image = active.assets.find((asset) => asset.id === shot.imageAssetId)
  const video = active.assets.find((asset) => asset.id === shot.videoAssetId)
  const voice = active.assets.find((asset) => asset.id === shot.voiceAssetId)
  const character = active.characters.find((item) => shot.referenceCharacterIds.includes(item.id))
  const place = active.places.find((item) => shot.referencePlaceIds.includes(item.id))
  const activeJob = [...active.jobs].reverse().find((job) => (job.stage === 'visuals' || job.stage === 'voice') && (job.status === 'running' || job.status === 'queued'))
  const update = <K extends keyof ShotDraft,>(key: K, value: ShotDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setDirty(true)
  }
  const save = async (): Promise<void> => {
    if (!dirty) return
    await run('save-shot', { shotId: shot.id, ...draft })
    setDirty(false)
  }
  const generateImage = async (): Promise<void> => {
    if (dirty) await save()
    setBusy('image')
    try {
      await run('generate-shot-image', { shotId: shot.id, requestId: `shot-image-${shot.id}-${Date.now()}` })
      notify('info', `第 ${shot.number} 镜已排队生成画面。`)
    } finally {
      setBusy(null)
    }
  }
  const generateVideo = async (): Promise<void> => {
    if (!shot.imageAssetId) return
    if (dirty) await save()
    setBusy('video')
    try {
      await run('generate-shot-video', { shotId: shot.id, requestId: `shot-video-${shot.id}-${Date.now()}` })
      notify('info', `第 ${shot.number} 镜已排队升级为视频。`)
    } finally {
      setBusy(null)
    }
  }
  const generateVoice = async (): Promise<void> => {
    if (dirty) await save()
    setBusy('voice')
    try {
      await run('generate-voice', { shotId: shot.id, requestId: `shot-voice-${shot.id}-${Date.now()}` })
      notify('info', `第 ${shot.number} 镜已排队配音。`)
    } finally {
      setBusy(null)
    }
  }
  const checkShot = async (): Promise<void> => {
    setCheckBusy(true)
    try {
      await run('visual-check', { shotIds: [shot.id] })
      notify('info', `第 ${shot.number} 镜已排队逐帧检查；结果会出现在检查页和这里。`)
    } finally {
      setCheckBusy(false)
    }
  }
  const adopt = async (candidateId: string): Promise<void> => {
    await run('adopt-shot-asset', { shotId: shot.id, candidateId })
    notify('success', '已用这一张。')
  }
  return (
    <aside className="studio-shot-inspector" aria-label={`第 ${shot.number} 镜详情`}>
      <header className="studio-inspector-head">
        <div>
          <span className="studio-eyebrow">镜 {String(shot.number).padStart(2, '0')}</span>
          <h2>{shot.title}</h2>
          <p>{scene?.title ?? '场景'} · {shot.shotSize} · {shot.camera}</p>
          {sourceChapter ? <p className="studio-shot-source">来源：第 {sourceChapter.number} 章《{sourceChapter.title}》</p> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭镜头详情"><X size={14} /></button>
      </header>
      <div className="studio-inspector-scroll">
        <div className="studio-shot-preview">
          {video?.url ? (
            <video src={video.url} controls playsInline poster={image?.thumbUrl ?? image?.url} />
          ) : (
            <AssetImage project={active} assetId={shot.imageAssetId} alt={shot.title} fit="cover" />
          )}
          <div className="studio-shot-preview-meta">
            <span className="mono">{formatTimecode(shot.durationSec, 30).slice(3)}</span>
            <StatusDot status={shot.status} />
            <button type="button" title="设为封面" onClick={() => shot.imageAssetId && void run('set-cover', { assetId: shot.imageAssetId })} disabled={!shot.imageAssetId}>
              <ImageIcon size={12} /> 封面
            </button>
            <button type="button" title="上移镜头" onClick={() => void run('move-shot', { shotId: shot.id, offset: -1 })}><ArrowUp size={12} /> 上移</button>
            <button type="button" title="下移镜头" onClick={() => void run('move-shot', { shotId: shot.id, offset: 1 })}><ArrowDown size={12} /> 下移</button>
          </div>
        </div>

        <div className="studio-inspector-actions">
          <Button variant="gold" size="sm" icon={busy === 'image' ? <Loader2 size={12} className="studio-spin" /> : <WandSparkles size={12} />} onClick={() => void generateImage()} disabled={Boolean(activeJob) || (!active.blueprint?.storyboardModel && !image)} title={!active.blueprint?.storyboardModel && !image ? '先在分镜页生成分镜' : undefined}>
            {image ? '重做画面' : '生成画面'}
          </Button>
          <Button variant="ghost" size="sm" icon={busy === 'video' ? <Loader2 size={12} className="studio-spin" /> : <Video size={12} />} onClick={() => void generateVideo()} disabled={!image || Boolean(activeJob)}>
            {video ? '重新生成视频' : '升级为视频'}
          </Button>
          <Button variant="ghost" size="sm" icon={<Upload size={12} />} onClick={() => void useStudioStore.getState().importAssets('image', shot.id)}>导入</Button>
        </div>
        {activeJob ? (
          <div className="studio-inspector-job">
            <JobStatus job={activeJob} />
            <span className="truncate">{activeJob.message}</span>
            <StudioProgress value={activeJob.progress} />
          </div>
        ) : null}

        {(shot.imageCandidates.length || shot.videoCandidates.length) ? (
          <section className="studio-inspector-section">
            <div className="studio-inspector-section-head">
              <h3>候选画面</h3>
              <span>{shot.imageCandidates.length + shot.videoCandidates.length} 个</span>
            </div>
            <div className="studio-candidate-grid">
              {shot.imageCandidates.map((candidate) => {
                const asset = active.assets.find((item) => item.id === candidate.assetId)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={['studio-candidate-thumb', shot.imageAssetId === candidate.assetId ? 'is-adopted' : ''].filter(Boolean).join(' ')}
                    onClick={() => void adopt(candidate.id)}
                    title={candidate.adopted ? '已选用' : '用这一张'}
                  >
                    {asset ? <img src={asset.thumbUrl ?? asset.url} alt="" loading="lazy" /> : null}
                    <span>{candidate.label}</span>
                    {shot.imageAssetId === candidate.assetId ? <i><Check size={10} /></i> : null}
                  </button>
                )
              })}
              {shot.videoCandidates.map((candidate) => {
                const asset = active.assets.find((item) => item.id === candidate.assetId)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={['studio-candidate-thumb', 'is-video', shot.videoAssetId === candidate.assetId ? 'is-adopted' : ''].filter(Boolean).join(' ')}
                    onClick={() => void adopt(candidate.id)}
                  >
                    {asset ? <img src={asset.thumbUrl ?? asset.url} alt="" loading="lazy" /> : null}
                    <span>{candidate.label}</span>
                    <em><Play size={9} /> 视频</em>
                    {shot.videoAssetId === candidate.assetId ? <i><Check size={10} /></i> : null}
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>镜头</h3><button type="button" className={dirty ? 'is-dirty' : ''} onClick={() => void save()} disabled={!dirty}>{dirty ? '保存镜头' : '已保存'}</button></div>
          <div className="studio-form-grid is-compact">
            <label className="studio-field is-wide"><span>标题</span><input value={draft.title} onChange={(event) => update('title', event.target.value)} /></label>
            <label className="studio-field is-wide"><span>这一镜发生什么</span><textarea rows={3} value={draft.action} onChange={(event) => update('action', event.target.value)} /></label>
            <label className="studio-field"><span>镜头远近</span><input value={draft.shotSize} onChange={(event) => update('shotSize', event.target.value)} /></label>
            <label className="studio-field"><span>镜头怎么动</span><input value={draft.camera} onChange={(event) => update('camera', event.target.value)} /></label>
            <label className="studio-field"><span>时长（秒）</span><input value={draft.durationSec} onChange={(event) => update('durationSec', Math.max(1, Number(event.target.value.replace(/[^\d.]/g, '')) || 1))} inputMode="decimal" /></label>
            <label className="studio-field"><span>前后衔接</span><input value={draft.continuity} onChange={(event) => update('continuity', event.target.value)} /></label>
          </div>
        </section>

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>台词与声音</h3><AudioPill asset={voice} /></div>
          <div className="studio-form-grid is-compact">
            <label className="studio-field"><span>说话人</span><input value={draft.speaker} onChange={(event) => update('speaker', event.target.value)} /></label>
            <label className="studio-field"><span>声线</span>
              <select value={shot.voiceId} onChange={(event) => void run('save-shot', { shotId: shot.id, voiceId: event.target.value })}>
                <option value="">{cloudTts ? '跟随设置里的云端声线' : '跟随人物 / 默认'}</option>
                {cloudTts ? null : (engine?.voices ?? []).map((item) => <option key={item.name} value={item.name}>{item.name} · {item.culture}</option>)}
              </select>
            </label>
            <label className="studio-field is-wide"><span>台词</span><textarea rows={3} value={draft.dialogue} onChange={(event) => update('dialogue', event.target.value)} placeholder="这一镜说什么？" /></label>
          </div>
          <div className="studio-inspector-inline">
            <Button variant="ghost" size="sm" icon={busy === 'voice' ? <Loader2 size={12} className="studio-spin" /> : <Mic2 size={12} />} onClick={() => void generateVoice()} disabled={!draft.dialogue.trim() || Boolean(activeJob)}>
              {voice ? '重新配音' : '生成配音'}
            </Button>
            <Button variant="ghost" size="sm" icon={<Upload size={12} />} onClick={() => void useStudioStore.getState().importAssets('audio', shot.id)}>导入配音</Button>
            <span className="mono">{cloudTts ? '云端配音 · 声线在设置里' : engine?.voices.length ? `${engine.voices.length} 个系统声线` : engine?.voiceError ?? '读取声线中…'}</span>
          </div>
        </section>

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>这一镜的检查</h3><button type="button" className={checkBusy ? 'is-dirty' : ''} onClick={() => void checkShot()} disabled={checkBusy || !shot.imageAssetId}>{checkBusy ? '检查中…' : '检查这一镜'}</button></div>
          {active.checks.filter((check) => check.targetId === shot.id).slice(0, 3).map((check) => (
            <div key={check.id} className={`studio-check-row is-${check.level}`}><b>{check.title}</b><p>{check.detail}</p></div>
          ))}
          {!active.checks.some((check) => check.targetId === shot.id) ? <p className="studio-hint">还没有这一镜的画面检查记录。</p> : null}
        </section>

        <section className="studio-inspector-section">
          <div className="studio-inspector-section-head"><h3>人物与场景参考</h3><span>{shot.lockedReference ? '已固定' : '未固定'}</span></div>
          <div className="studio-reference-row">
            {character ? <span className="studio-ref-chip is-character"><i>{character.name.slice(0, 1)}</i>{character.name}</span> : <span className="studio-ref-chip is-empty">没有人物参考</span>}
            {place ? <span className="studio-ref-chip is-place">{place.name}</span> : null}
            <button type="button" className="studio-ref-library-btn" onClick={() => setReferenceOpen(true)}><GalleryHorizontalEnd size={11} /> 参考图库</button>
            <button type="button" className={['studio-lock-btn', shot.lockedReference ? 'is-on' : ''].filter(Boolean).join(' ')} onClick={() => void run('save-shot', { shotId: shot.id, lockedReference: !shot.lockedReference })}>
              {shot.lockedReference ? <Lock size={11} /> : <LockOpen size={11} />}
              {shot.lockedReference ? '取消固定' : '固定参考'}
            </button>
          </div>
          {character?.refAssetIds.length ? (
            <div className="studio-ref-thumbs">
              {character.refAssetIds.map((id) => {
                const asset = active.assets.find((item) => item.id === id)
                return asset ? <img key={id} src={asset.thumbUrl ?? asset.url} alt={character.name} /> : null
              })}
            </div>
          ) : <p className="studio-hint">人物还没有参考图。可在人物卡里关联素材；演示作品已内置参考。</p>}
          <label className="studio-field is-wide"><span>画面描述</span><textarea rows={5} value={draft.prompt} onChange={(event) => update('prompt', event.target.value)} /></label>
        </section>
      </div>
      {referenceOpen ? <ReferenceLibraryDialog shot={shot} onClose={() => setReferenceOpen(false)} /> : null}
    </aside>
  )
}

function ReferenceLibraryDialog({ shot, onClose }: { shot: StudioShot; onClose: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const character = active?.characters.find((item) => shot.referenceCharacterIds.includes(item.id))
  const place = active?.places.find((item) => shot.referencePlaceIds.includes(item.id))
  const [characterRefs, setCharacterRefs] = useState<string[]>(character?.refAssetIds ?? [])
  const [placeRefs, setPlaceRefs] = useState<string[]>(place?.refAssetIds ?? [])
  const [saving, setSaving] = useState(false)
  if (!active) return <span />
  const images = active.assets.filter((asset) => asset.kind === 'image')
  const toggle = (current: string[], id: string): string[] => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      if (character) await run('upsert-character', { character: { ...character, refAssetIds: characterRefs } })
      if (place) await run('upsert-place', { place: { ...place, refAssetIds: placeRefs } })
      notify('success', '参考已更新；固定参考后，后面的画面会提示需要重新核对。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`参考图库 · 第 ${shot.number} 镜`}
      description="从作品素材里挑人物和地点参考；它们会带进后面的画面生成。"
      width={760}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={() => void useStudioStore.getState().importAssets('image')}>导入参考图</Button>
          <div><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="gold" onClick={() => void save()} loading={saving}>保存参考</Button></div>
        </div>
      }
    >
      <div className="studio-reference-library">
        {character ? (
          <section>
            <header><b>人物 · {character.name}</b><span>{characterRefs.length} 张已选</span></header>
            <div className="studio-reference-grid">
              {images.map((asset) => (
                <button key={asset.id} type="button" className={characterRefs.includes(asset.id) ? 'is-selected' : ''} onClick={() => setCharacterRefs((current) => toggle(current, asset.id))}>
                  <img src={asset.thumbUrl ?? asset.url} alt={asset.title} loading="lazy" />
                  <span>{asset.title}</span>
                  {characterRefs.includes(asset.id) ? <i><Check size={10} /></i> : null}
                </button>
              ))}
            </div>
          </section>
        ) : <p className="studio-hint">这一镜还没有选人物参考；先在镜头详情里选一张。</p>}
        {place ? (
          <section>
            <header><b>地点 · {place.name}</b><span>{placeRefs.length} 张已选</span></header>
            <div className="studio-reference-grid">
              {images.map((asset) => (
                <button key={asset.id} type="button" className={placeRefs.includes(asset.id) ? 'is-selected' : ''} onClick={() => setPlaceRefs((current) => toggle(current, asset.id))}>
                  <img src={asset.thumbUrl ?? asset.url} alt={asset.title} loading="lazy" />
                  <span>{asset.title}</span>
                  {placeRefs.includes(asset.id) ? <i><Check size={10} /></i> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {!images.length ? <p className="studio-hint">作品里还没有画面素材，先导入或生成一张参考图。</p> : null}
      </div>
    </Modal>
  )
}

function BulkShotDialog({ sceneId, onClose }: { sceneId: string | null; onClose: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [scope, setScope] = useState<'all' | 'scene'>('all')
  const [duration, setDuration] = useState(String(active?.shots[0]?.durationSec ?? 8))
  const [shotSize, setShotSize] = useState(active?.shots[0]?.shotSize ?? '中景')
  const [camera, setCamera] = useState(active?.shots[0]?.camera ?? '固定镜头')
  const [saving, setSaving] = useState(false)
  if (!active) return <span />
  const scene = active.scenes.find((item) => item.id === sceneId)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('update-shots', {
        ...(scope === 'scene' && sceneId ? { sceneId } : {}),
        durationSec: Number(duration) || 8,
        shotSize,
        camera
      })
      notify('success', scope === 'scene' ? `已调整「${scene?.title ?? '当前场景'}」的镜头。` : '已调整全部镜头。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="批量调整镜头"
      description="把同一场或全片的时长、镜头远近和镜头运动调成一致；画面与配音会标记为需要重新核对。"
      width={560}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>应用到镜头</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>范围</span>
          <Segmented value={scope} options={[{ value: 'all', label: `全部 ${active.shots.length} 镜` }, ...(sceneId ? [{ value: 'scene', label: `当前场景 ${scene?.title ?? ''}` }] : [])]} onChange={(value) => setScope(value as 'all' | 'scene')} ariaLabel="批量调整范围" />
        </label>
        <label className="studio-field"><span>时长（秒）</span><input value={duration} onChange={(event) => setDuration(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" /></label>
        <label className="studio-field"><span>镜头远近</span><input value={shotSize} onChange={(event) => setShotSize(event.target.value)} placeholder="中景 / 全景 / 特写" /></label>
        <label className="studio-field is-wide"><span>镜头怎么动</span><input value={camera} onChange={(event) => setCamera(event.target.value)} placeholder="固定镜头 / 缓慢推近 / 跟拍" /></label>
      </div>
    </Modal>
  )
}

export function StoryboardView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const selectedShotId = useStudioStore((state) => state.selectedShotId)
  const selectShot = useStudioStore((state) => state.selectShot)
  const storyboardTab = useStudioStore((state) => state.storyboardTab)
  const setStoryboardTab = useStudioStore((state) => state.setStoryboardTab)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const [batchBusy, setBatchBusy] = useState(false)
  const [assembling, setAssembling] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [musicBusy, setMusicBusy] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [subtitleBusy, setSubtitleBusy] = useState(false)
  const [storyboardBusy, setStoryboardBusy] = useState(false)
  const [outlineBusy, setOutlineBusy] = useState(false)
  if (!active) return <div />
  const shot = active.shots.find((item) => item.id === selectedShotId) ?? null
  const shots = [...active.shots].sort((a, b) => a.number - b.number)
  const visuals = shots.filter((item) => item.imageAssetId || item.videoAssetId).length
  const missing = shots.filter((item) => !item.imageAssetId && !item.videoAssetId)
  const voicesNeeded = shots.filter((item) => item.dialogue.trim())
  const voicesDone = voicesNeeded.filter((item) => item.voiceAssetId).length
  const music = active.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('music') && !asset.tags.includes('draft'))
  const musicDraft = active.assets.some((asset) => asset.kind === 'audio' && asset.tags.includes('music') && asset.tags.includes('draft'))
  const sfx = active.assets.filter((asset) => asset.kind === 'audio' && asset.tags.includes('sfx'))
  const total = shots.reduce((sum, item) => sum + item.durationSec, 0)
  const job = [...active.jobs].reverse().find((item) => (item.stage === 'visuals' || item.stage === 'voice') && (item.status === 'running' || item.status === 'queued'))
  const storyboardJob = [...active.jobs].reverse().find((item) => item.stage === 'storyboard' && (item.status === 'running' || item.status === 'queued'))
  const outlineJob = [...active.jobs].reverse().find((item) => item.stage === 'outline' && (item.status === 'running' || item.status === 'queued'))
  const sceneGroups = active.scenes.map((scene) => ({ scene, shots: shots.filter((item) => item.sceneId === scene.id) }))

  const batchImages = async (): Promise<void> => {
    const targets = missing.length ? missing : shots
    if (!targets.length) return
    setBatchBusy(true)
    try {
      await run('batch-shot-images', { shotIds: targets.map((item) => item.id), requestId: `batch-images-${Date.now()}` })
      notify('info', missing.length ? `已排队补齐 ${targets.length} 镜画面。` : '已排队重新生成全部画面。')
    } finally {
      setBatchBusy(false)
    }
  }
  const assemble = async (): Promise<void> => {
    setAssembling(true)
    try {
      await run('build-timeline')
      notify('success', '时间线已自动装配；可以进入剪辑台播放。')
    } finally {
      setAssembling(false)
    }
  }
  const voices = async (): Promise<void> => {
    const targets = voicesNeeded.filter((item) => !item.voiceAssetId)
    if (!targets.length) {
      notify('info', '所有有台词的镜头都已经有配音。')
      return
    }
    setVoiceBusy(true)
    try {
      await run('generate-voice', { shotIds: targets.map((item) => item.id), requestId: `voice-batch-${Date.now()}` })
      notify('info', `已排队补齐 ${targets.length} 段配音。`)
    } finally {
      setVoiceBusy(false)
    }
  }
  const alignSubtitles = async (): Promise<void> => {
    setSubtitleBusy(true)
    try {
      await run('build-subtitles', {})
      notify('success', '已按台词拆成逐句字幕；时间码按字数估算，可到时间线微调。')
    } finally {
      setSubtitleBusy(false)
    }
  }
  const generateOutline = async (): Promise<void> => {
    if (outlineBusy || outlineJob) return
    setOutlineBusy(true)
    try {
      await run('generate-outline', { useModel: true, requestId: `outline-${Date.now()}` })
      notify('info', '已排队细化大纲；完成后会更新镜头动作、景别、运镜与台词。')
    } finally {
      setOutlineBusy(false)
    }
  }
  const generateStoryboard = async (): Promise<void> => {
    setStoryboardBusy(true)
    try {
      await run('generate-storyboard', { requestId: `storyboard-${Date.now()}` })
      notify('info', active.blueprint?.storyboardModel
        ? '已排队重排分镜；完成后会按模型结果更新镜头，已有素材不会被打乱。'
        : '已排队生成分镜；完成后会按模型结果建立场景、镜头与台词。')
    } finally {
      setStoryboardBusy(false)
    }
  }
  const makeMusic = async (kind: 'music' | 'rain' | 'umbrella' | 'heartbeat' = 'music'): Promise<void> => {
    setMusicBusy(true)
    try {
      await run('generate-music', { kind, mood: active.brief.tone, seconds: kind === 'music' ? Math.max(20, Math.round(total || 54)) : 8, requestId: `music-${kind}-${Date.now()}` })
      notify('info', kind === 'music' ? '已排队生成配乐。' : '已排队生成音效。')
    } finally {
      setMusicBusy(false)
    }
  }
  const makeLocalMusic = async (): Promise<void> => {
    setMusicBusy(true)
    try {
      await run('generate-music', { kind: 'music', engine: 'local', mood: active.brief.tone, seconds: Math.max(20, Math.round(total || 54)), requestId: `music-local-${Date.now()}` })
      notify('info', '已排队生成可试听的本地器乐草稿；草稿不计入正式配乐。')
    } finally {
      setMusicBusy(false)
    }
  }

  return (
    <div className={`studio-storyboard ${shot && storyboardTab === 'board' ? 'has-inspector' : ''}`}>
      <header className="studio-storyboard-head">
        <div className="studio-storyboard-title">
          <span className="studio-eyebrow">分镜板 · 共 {active.scenes.length} 场</span>
          <h1>{active.title}</h1>
          <div className="studio-storyboard-meta">
            <KindBadge kind={active.kind} />
            <span>{shots.length} 镜</span>
            <i />
            <span>{formatDuration(total)}</span>
            <i />
            <span>{visuals}/{shots.length} 画面</span>
            <i />
            <span>{voicesDone}/{voicesNeeded.length} 配音</span>
            <i />
            <span>{music.length ? '配乐就绪' : musicDraft ? '配乐草稿' : '还没有配乐'}</span>
          </div>
        </div>
        <div className="studio-storyboard-actions">
          <div className="studio-tab-switch">
            <button type="button" className={storyboardTab === 'script' ? 'is-active' : ''} onClick={() => setStoryboardTab('script')}><Film size={12} /> 剧本</button>
            <button type="button" className={storyboardTab === 'board' ? 'is-active' : ''} onClick={() => setStoryboardTab('board')}><Images size={12} /> 分镜板</button>
          </div>
          {!active.blueprint?.storyboardModel ? (
            <Button variant="gold" size="sm" icon={storyboardBusy || storyboardJob ? <Loader2 size={12} className="studio-spin" /> : <Clapperboard size={12} />} onClick={() => void generateStoryboard()} disabled={storyboardBusy || Boolean(job) || Boolean(storyboardJob)}>
              {storyboardJob ? '正在生成分镜' : '生成分镜'}
            </Button>
          ) : null}
          {active.blueprint?.storyboardModel || visuals > 0 ? (
            <Button variant="gold" size="sm" icon={batchBusy ? <Loader2 size={12} className="studio-spin" /> : <Wand2 size={12} />} onClick={() => void batchImages()} disabled={Boolean(job)}>
              {missing.length ? `补齐 ${missing.length} 镜画面` : '重新生成全部画面'}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => setBulkOpen(true)} title="批量调整镜头" aria-label="批量调整">批量调整</Button>
          <Button variant="ghost" size="sm" icon={subtitleBusy ? <Loader2 size={12} className="studio-spin" /> : <Captions size={12} />} onClick={() => void alignSubtitles()} disabled={subtitleBusy || !voicesNeeded.length} title="按台词逐句生成字幕" aria-label="逐句字幕">逐句字幕</Button>
          {!active.timeline.clips.length || active.stages.timeline.status === 'stale' ? (
            <Button variant="gold" size="sm" icon={assembling ? <Loader2 size={12} className="studio-spin" /> : <Clapperboard size={12} />} onClick={() => void assemble()} disabled={assembling} title={active.timeline.clips.length ? '有新素材，按最新镜头重新装配' : '排好时间线'} aria-label={active.timeline.clips.length ? '重新装配时间线' : '排好时间线'}>
              {active.timeline.clips.length ? '重新装配时间线' : '排好时间线'}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" icon={<Play size={12} />} onClick={() => navigateStage('timeline')} title="去时间线" aria-label="去时间线">
            去时间线
          </Button>
        </div>
      </header>

      {storyboardJob ? (
        <div className="studio-inline-job">
          <Loader2 size={14} className="studio-spin" />
          <span>{storyboardJob.label}</span>
          <StudioProgress value={storyboardJob.progress} />
          <em className="mono">{storyboardJob.progress}%</em>
          <span className="studio-inline-job-message">{storyboardJob.message}</span>
        </div>
      ) : null}
      {job ? (
        <div className="studio-inline-job">
          <Loader2 size={14} className="studio-spin" />
          <span>{job.label}</span>
          <StudioProgress value={job.progress} />
          <em className="mono">{job.progress}%</em>
          <span className="studio-inline-job-message">{job.message}</span>
        </div>
      ) : null}

      {storyboardTab === 'script' ? (
        <div className="studio-script">
          <div className="studio-script-head">
            <SectionTitle eyebrow="剧本" title="先有剧本，再有分镜" aside={<span className="studio-section-side">{active.scenes.length} 场 · {shots.length} 镜</span>}>
              每一场都能回到原文。改场景简介会提醒相关镜头重新核对，但不会自动改写镜头动作，也不会删掉已生成的画面；改完简介，点到别处就会保存。
            </SectionTitle>
            <div className="studio-script-tools">
              <Button variant={active.blueprint?.outlineModel ? 'ghost' : 'gold'} size="sm" icon={outlineBusy || outlineJob ? <Loader2 size={12} className="studio-spin" /> : <Clapperboard size={12} />} onClick={() => void generateOutline()} disabled={outlineBusy || Boolean(job) || Boolean(outlineJob)}>
                {outlineJob ? '正在生成大纲' : active.blueprint?.outlineModel ? '重新生成大纲' : '生成大纲'}
              </Button>
              <Button variant="ghost" size="sm" icon={storyboardBusy ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} onClick={() => void generateStoryboard()} disabled={storyboardBusy || Boolean(job)}>用模型重排</Button>
              <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={() => void run('sync-storyboard').then(() => notify('info', '已按蓝图同步镜头字段；已有画面不受影响。'))}>按蓝图同步</Button>
              <Button variant="ghost" size="sm" icon={voiceBusy ? <Loader2 size={12} className="studio-spin" /> : <AudioLines size={12} />} onClick={() => void voices()} disabled={voiceBusy || Boolean(job)}>补齐配音</Button>
            </div>
          </div>
          <div className="studio-script-grid">
            {sceneGroups.map(({ scene }, index) => <SceneScript key={scene.id} sceneIndex={index} />)}
          </div>
          <div className="studio-script-foot">
            <span><Info size={12} /> 台词与动作已经进入镜头计划</span>
            <span className="mono">TOTAL {formatTimecode(total, 30)}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="studio-board-toolbar">
            <div className="studio-board-toolbar-left">
              <span className="studio-board-count"><b>{visuals}</b> / {shots.length} 镜有画面</span>
              <span className="studio-board-missing">{missing.length ? `${missing.length} 镜待生成` : '画面齐全'}</span>
              <Button variant="ghost" size="sm" icon={voiceBusy ? <Loader2 size={12} className="studio-spin" /> : <AudioLines size={12} />} onClick={() => void voices()} disabled={voiceBusy || Boolean(job)}>补齐配音</Button>
              <Button variant="ghost" size="sm" icon={musicBusy ? <Loader2 size={12} className="studio-spin" /> : <Music2 size={12} />} onClick={() => void makeMusic('music')} disabled={musicBusy || Boolean(job)}>生成配乐</Button>
              <Button variant="ghost" size="sm" icon={<Music2 size={12} />} onClick={() => void makeLocalMusic()} disabled={musicBusy || Boolean(job)} title="没有配乐模型时，可先生成可试听的本地器乐草稿">本地草稿</Button>
            </div>
            <div className="studio-board-toolbar-right">
              {music[0] ? <AudioPill asset={music[0]} compact /> : <span className="studio-audio is-missing"><Music2 size={12} /> 暂无配乐</span>}
              <span className="mono">{formatTimecode(total, 30)}</span>
            </div>
          </div>

          <div className="studio-board-scroll">
            {sceneGroups.map(({ scene, shots: sceneShots }, sceneIndex) => (
              <section key={scene.id} className="studio-board-scene">
                <div className="studio-board-scene-head">
                  <span className="mono">场 {String(sceneIndex + 1).padStart(2, '0')}</span>
                  <h2>{scene.title}</h2>
                  <span>{scene.location} · {scene.timeOfDay}</span>
                  <i />
                  <span>{sceneShots.length} 镜 · {formatDuration(sceneShots.reduce((sum, shot) => sum + shot.durationSec, 0))}</span>
                </div>
                <div className="studio-shot-grid">
                  {sceneShots.map((item) => {
                    const asset = active.assets.find((entry) => entry.id === (item.videoAssetId ?? item.imageAssetId))
                    const hasVoice = Boolean(item.voiceAssetId)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={['studio-shot-card', selectedShotId === item.id ? 'is-selected' : '', !asset ? 'is-empty' : '', item.videoAssetId ? 'is-video' : ''].filter(Boolean).join(' ')}
                        onClick={() => selectShot(item.id)}
                      >
                        <div className="studio-shot-image">
                          {asset ? (
                            item.videoAssetId ? <video src={asset.url} muted playsInline preload="metadata" poster={asset.thumbUrl} /> : <img src={asset.thumbUrl ?? asset.url} alt={item.title} loading="lazy" />
                          ) : (
                            <span className="studio-shot-missing"><ImageIcon size={18} strokeWidth={1.2} />待生成</span>
                          )}
                          <span className="studio-shot-number mono">{String(item.number).padStart(2, '0')}</span>
                          <span className="studio-shot-duration mono">{item.durationSec}s</span>
                          {item.videoAssetId ? <span className="studio-shot-video-tag"><Video size={10} /> VIDEO</span> : null}
                          {item.dialogue ? <span className={['studio-shot-voice', hasVoice ? 'is-on' : ''].filter(Boolean).join(' ')}><Mic size={10} /></span> : null}
                          {item.imageCandidates.length + item.videoCandidates.length > 1 ? <span className="studio-shot-candidates mono">{item.imageCandidates.length + item.videoCandidates.length} 张候选</span> : null}
                        </div>
                        <div className="studio-shot-info">
                          <b>{item.title}</b>
                          <span>{item.shotSize} · {item.camera}</span>
                          <em><StatusDot status={item.status} label={false} /> {studioStatusLabel(item.status)}</em>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
          <footer className="studio-board-foot">
            <span><Clock3 size={12} /> 时长合计 {formatDuration(total)} · 30fps</span>
            <span><Lock size={12} /> 参考锁定后角色更稳定</span>
            <span><Info size={12} /> 单镜重做会保留旧画面</span>
          </footer>
        </>
      )}
      {shot && storyboardTab === 'board' ? <ShotInspector shot={shot} onClose={() => selectShot(null)} /> : null}
      {bulkOpen ? <BulkShotDialog sceneId={shot?.sceneId ?? null} onClose={() => setBulkOpen(false)} /> : null}
    </div>
  )
}

type FactTab = 'people' | 'facts' | 'world' | 'story' | 'checks'

type PaperSize = 'sm' | 'md' | 'lg'

type PaperLine = 'tight' | 'normal' | 'loose'

type PaperWidth = 'narrow' | 'normal' | 'wide'

const PAPER_SIZES: readonly PaperSize[] = ['sm', 'md', 'lg']

const PAPER_LINES: readonly PaperLine[] = ['tight', 'normal', 'loose']

const PAPER_WIDTHS: readonly PaperWidth[] = ['narrow', 'normal', 'wide']

function storedChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key)
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

function CandidateDiff({
  chapter,
  candidate,
  onClose,
  onBefore
}: {
  chapter: StudioChapter
  candidate: StudioCandidate
  onClose: () => void
  onBefore?: () => Promise<void>
}): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [adopting, setAdopting] = useState(false)
  const [activeId, setActiveId] = useState(candidate.id)
  const [mode, setMode] = useState<'chars' | 'paragraphs'>('chars')
  const candidates = chapter.candidates
  const active = candidates.find((item) => item.id === activeId) ?? candidates[0] ?? candidate
  const diff = useMemo(() => candidateDiff(chapter.content, active.content, mode), [chapter.content, active.content, mode])
  const effectiveMode = diff.degraded ? 'paragraphs' : mode
  const adopt = async (): Promise<void> => {
    setAdopting(true)
    try {
      await onBefore?.()
      await run('adopt-candidate', { chapterId: chapter.id, candidateId: active.id, expectedRevision: chapter.revision })
      notify('success', '已用这一版替换；上一版自动留档，可随时恢复。')
      onClose()
    } finally {
      setAdopting(false)
    }
  }
  const discard = async (): Promise<void> => {
    await run('discard-candidate', { chapterId: chapter.id, candidateId: active.id })
    const rest = candidates.filter((item) => item.id !== active.id)
    if (rest[0]) setActiveId(rest[0].id)
    else onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`对照候选稿 · ${active.label}`}
      description={`${active.wordCount} 字 · ${active.source === 'model' ? active.model ?? '模型' : active.source === 'import' ? '导入稿' : '本机结构改编'} · ${timeAgo(active.createdAt)}。用候选前不会改动正文。`}
      width={1080}
      layer="overlay"
      footer={
        <div className="studio-modal-footer studio-diff-footer">
          <span>左边是现在的正文，右边是候选稿；红色是删去，绿色是新增。</span>
          <div>
            <Button variant="ghost" onClick={() => void discard()}>不用这一版</Button>
            <Button variant="gold" icon={<Check size={14} />} loading={adopting} onClick={() => void adopt()}>
              用这一版替换
            </Button>
          </div>
        </div>
      }
    >
      {candidates.length > 1 ? (
        <div className="studio-candidate-switch" role="tablist" aria-label="候选稿">
          {candidates.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={item.id === active.id} className={item.id === active.id ? 'is-active' : ''} onClick={() => setActiveId(item.id)}>
              <b>{item.label}</b>
              <span className="mono">{item.wordCount} 字 · {item.source === 'model' ? '模型' : '本地'}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="studio-diff-modes">
        <span>{candidates.length} 版候选稿</span>
        <button type="button" className={mode === 'chars' ? 'is-active' : ''} onClick={() => setMode('chars')}>逐字对照</button>
        <button type="button" className={mode === 'paragraphs' ? 'is-active' : ''} onClick={() => setMode('paragraphs')}>段落对照</button>
      </div>
      {diff.truncated ? <p className="studio-hint">正文超过 6 万字，对照只显示前 6 万字；用候选时会使用完整内容。</p> : null}
      {diff.degraded ? <p className="studio-hint">正文超过 2 万字，已自动改用段落级对照，避免逐字比对卡住界面；用候选时会使用完整内容。</p> : null}
      <div className="studio-diff-grid">
        <section>
          <header><span>现在的正文</span><b className="mono">{countWords(chapter.content)} 字</b></header>
          <div className="studio-diff-text">
            {effectiveMode === 'chars'
              ? diff.parts.map((part, index) => {
                  if (part.added) return null
                  return <span key={index} className={part.removed ? 'is-removed' : ''}>{part.value}</span>
                })
              : diff.paragraphs.map((part, index) => {
                  if (part.added) return null
                  return part.value.map((paragraph, paragraphIndex) => (
                    <p key={`${index}-${paragraphIndex}`} className={part.removed ? 'is-removed' : ''}>{paragraph}</p>
                  ))
                })}
          </div>
        </section>
        <section>
          <header><span>候选稿</span><b className="mono">{active.wordCount} 字</b></header>
          <div className="studio-diff-text">
            {effectiveMode === 'chars'
              ? diff.parts.map((part, index) => {
                  if (part.removed) return null
                  return <span key={index} className={part.added ? 'is-added' : ''}>{part.value}</span>
                })
              : diff.paragraphs.map((part, index) => {
                  if (part.removed) return null
                  return part.value.map((paragraph, paragraphIndex) => (
                    <p key={`${index}-${paragraphIndex}`} className={part.added ? 'is-added' : ''}>{paragraph}</p>
                  ))
                })}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function VersionDialog({
  chapter,
  onClose,
  onBefore
}: {
  chapter: StudioChapter
  onClose: () => void
  onBefore?: () => Promise<void>
}): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [restoring, setRestoring] = useState<string | null>(null)
  const restore = async (version: StudioChapterVersion): Promise<void> => {
    setRestoring(version.id)
    try {
      await onBefore?.()
      await run('restore-chapter-version', { chapterId: chapter.id, versionId: version.id, expectedRevision: chapter.revision })
      notify('success', '已恢复到这个版本；恢复前的正文也留档了。')
      onClose()
    } finally {
      setRestoring(null)
    }
  }
  return (
    <Modal open onClose={onClose} title={`历史版本 · 第 ${chapter.number} 章`} description="每次手动修改或用候选前都会留一份；恢复前也会先留档。" width={720} layer="overlay">
      <div className="studio-version-list">
        {chapter.versions.length === 0 ? <p className="studio-hint">还没有历史版本。第一次手动修改或用候选后会自动出现。</p> : null}
        {chapter.versions.map((version) => (
          <div key={version.id} className="studio-version-row">
            <span className="studio-version-time mono">{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <div>
              <b>{version.reason}</b>
              <p>{version.content.replace(/\s+/g, ' ').slice(0, 120) || '（空）'}</p>
            </div>
            <span className="mono">{version.wordCount} 字</span>
            <Button variant="ghost" size="sm" loading={restoring === version.id} onClick={() => void restore(version)}>恢复</Button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function VolumeDialog({ volume, onClose }: { volume: StudioVolume | null; onClose: () => void }): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [title, setTitle] = useState(volume?.title ?? '')
  const [summary, setSummary] = useState(volume?.summary ?? '')
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await run('upsert-volume', { volume: { ...(volume ? { id: volume.id } : {}), title, summary } })
      notify('success', volume ? '分卷已更新。' : '分卷已建立。')
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={volume ? '修改分卷' : '新建分卷'}
      description="分卷只调整目录；正文、候选和版本都会保留。"
      width={520}
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void save()} loading={saving}>保存分卷</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>卷名</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：第一卷 · 纸伞" autoFocus /></label>
        <label className="studio-field is-wide"><span>卷简介</span><textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="这一卷把主角带到哪里？" /></label>
      </div>
    </Modal>
  )
}

function AddChapterDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (chapterId: string) => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const [title, setTitle] = useState('')
  const [synopsis, setSynopsis] = useState('')
  const [target, setTarget] = useState(String(active?.chapters[0]?.wordTarget ?? 2500))
  const [volumeId, setVolumeId] = useState(active?.volumes[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await run('add-chapter', { title: title || undefined, synopsis, wordTarget: Number(target) || 2500, volumeId: volumeId || null })
      const chapters = [...result.project.chapters].sort((a, b) => b.number - a.number)
      if (chapters[0]) onCreated(chapters[0].id)
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建一章"
      description="先写章名和一句简介就够了；正文可以自己写，也可以让助手先给一版。"
      width={560}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="gold" onClick={() => void create()} loading={busy}>建立章节</Button>
        </div>
      }
    >
      <div className="studio-form-grid">
        <label className="studio-field is-wide"><span>章名</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：纸伞与铁骨" autoFocus /></label>
        <label className="studio-field is-wide"><span>本章简介</span><textarea rows={3} value={synopsis} onChange={(event) => setSynopsis(event.target.value)} placeholder="简单说，这一章发生了什么？" /></label>
        <label className="studio-field"><span>目标字数</span><input value={target} onChange={(event) => setTarget(event.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" /></label>
        <label className="studio-field"><span>放入分卷</span>
          <Select
            value={volumeId}
            options={[{ value: '', label: '未分卷' }, ...(active?.volumes ?? []).map((volume) => ({ value: volume.id, label: volume.title }))]}
            onChange={setVolumeId}
            ariaLabel="放入分卷"
          />
        </label>
      </div>
    </Modal>
  )
}

type WorldKind = 'faction' | 'rule' | 'prop'

function WorldItemDialog({ kind, item, onClose }: { kind: WorldKind; item: StudioFaction | StudioRule | StudioProp | null; onClose: () => void }): React.JSX.Element {
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [name, setName] = useState(kind === 'rule' ? '' : (item as StudioFaction | StudioProp | null)?.name ?? '')
  const [description, setDescription] = useState(kind === 'rule' ? '' : (item as StudioFaction | StudioProp | null)?.description ?? '')
  const [title, setTitle] = useState(kind === 'rule' ? (item as StudioRule | null)?.title ?? '' : '')
  const [content, setContent] = useState(kind === 'rule' ? (item as StudioRule | null)?.content ?? '' : '')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const label = kind === 'faction' ? '势力' : kind === 'rule' ? '规则' : '道具'
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const base = kind === 'faction'
        ? { id: item?.id, name, description }
        : kind === 'rule'
          ? { id: item?.id, title, content }
          : { id: item?.id, name, description, refAssetIds: (item as StudioProp | null)?.refAssetIds ?? [] }
      await run(`upsert-${kind}`, { item: base })
      notify('success', `${label}已保存。`)
      onClose()
    } finally {
      setSaving(false)
    }
  }
  const remove = async (): Promise<void> => {
    if (!item) return
    await run(`delete-${kind}`, { itemId: item.id })
    notify('info', `${label}已删除；已有正文不受影响。`)
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${item ? '编辑' : '新增'}${label}`}
      description="这些设定会带进写作和分镜；改动只提醒后面需要重新核对，不会删掉已有内容。"
      width={560}
      footer={
        <div className="studio-modal-footer">
          {item ? <Button variant="danger" onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>{confirmDelete ? '确认删除' : '删除'}</Button> : <span />}
          <div>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="gold" onClick={() => void save()} loading={saving}>保存{label}</Button>
          </div>
        </div>
      }
    >
      <div className="studio-form-grid">
        {kind === 'rule' ? (
          <>
            <label className="studio-field is-wide"><span>规则名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：雨伞不能倒着打开" autoFocus /></label>
            <label className="studio-field is-wide"><span>规则内容</span><textarea rows={5} value={content} onChange={(event) => setContent(event.target.value)} placeholder="它的代价、例外与读者会记住的细节。" /></label>
          </>
        ) : (
          <>
            <label className="studio-field is-wide"><span>{label}名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === 'faction' ? '例如：伞街公所' : '例如：外婆的黑伞'} autoFocus /></label>
            <label className="studio-field is-wide"><span>说明</span><textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="它和主角、主线以及画面有什么关系？" /></label>
          </>
        )}
      </div>
    </Modal>
  )
}

function RelationshipGraph({ characters, onPick }: { characters: StudioCharacter[]; onPick: (character: StudioCharacter) => void }): React.JSX.Element {
  const nodes = characters.slice(0, 10).map((character, index, list) => {
    const angle = list.length === 1 ? 0 : (Math.PI * 2 * index) / list.length - Math.PI / 2
    const radius = list.length === 1 ? 0 : 100
    return { character, x: 180 + Math.cos(angle) * radius, y: 130 + Math.sin(angle) * radius }
  })
  const byName = new Map(nodes.map((node) => [node.character.name, node]))
  const edges = characters.flatMap((character) =>
    character.relationships
      .map((relationship) => {
        const source = byName.get(character.name)
        const target = byName.get(relationship.target)
        return source && target ? { source, target, label: relationship.label, key: `${character.id}:${target.character.id}:${relationship.label}` } : null
      })
      .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
  ).slice(0, 32)
  return (
    <div className="studio-relationship-graph">
      {nodes.length ? (
        <svg viewBox="0 0 360 280" role="img" aria-label="人物关系图">
          {edges.map((edge) => (
            <g key={edge.key} className="studio-relationship-edge">
              <line x1={edge.source.x} y1={edge.source.y} x2={edge.target.x} y2={edge.target.y} />
              <text x={(edge.source.x + edge.target.x) / 2} y={(edge.source.y + edge.target.y) / 2 - 4}>{edge.label}</text>
            </g>
          ))}
          {nodes.map((node) => (
            <g
              key={node.character.id}
              className="studio-relationship-node"
              role="button"
              tabIndex={0}
              onClick={() => onPick(node.character)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onPick(node.character)
              }}
            >
              <circle cx={node.x} cy={node.y} r={19} />
              <text className="is-initial" x={node.x} y={node.y + 4}>{node.character.name.slice(0, 1)}</text>
              <text className="is-name" x={node.x} y={node.y + 33}>{node.character.name.slice(0, 6)}</text>
            </g>
          ))}
        </svg>
      ) : <p className="studio-hint">还没有人物，先在蓝图里建立人物。</p>}
      <p className="studio-relationship-hint"><Network size={11} /> {edges.length} 条关系 · 点击人物继续编辑</p>
    </div>
  )
}

function FactPanel({ onEditCharacter }: { onEditCharacter: (character: StudioCharacter) => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  const selectedChapterId = useStudioStore((state) => state.selectedChapterId)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const selectShot = useStudioStore((state) => state.selectShot)
  const setView = useStudioStore((state) => state.setView)
  const [tab, setTab] = useState<FactTab>('people')
  const [subject, setSubject] = useState('')
  const [predicate, setPredicate] = useState('')
  const [object, setObject] = useState('')
  const [quote, setQuote] = useState('')
  const [checking, setChecking] = useState(false)
  const [worldEditor, setWorldEditor] = useState<{ kind: WorldKind; item: StudioFaction | StudioRule | StudioProp | null } | null>(null)
  if (!active) return <span />
  const chapter = active.chapters.find((item) => item.id === selectedChapterId)
  const jumpToFact = (factId: string): void => {
    const fact = active.facts.find((item) => item.id === factId)
    if (!fact) return
    if (fact.chapterId) {
      selectChapter(fact.chapterId)
      setView('writing')
      return
    }
    if (fact.sceneId) {
      const shot = active.shots.find((item) => item.sceneId === fact.sceneId)
      if (shot) {
        selectShot(shot.id)
        setView('storyboard')
      }
    }
  }
  const addFact = async (): Promise<void> => {
    if (!subject.trim() || !predicate.trim() || !object.trim()) return
    const selected = window.getSelection()?.toString().trim().slice(0, 1000) ?? ''
    await run('upsert-fact', {
      fact: {
        subject: subject.trim(),
        predicate: predicate.trim(),
        object: object.trim(),
        ...(chapter ? { chapterId: chapter.id } : {}),
        ...(quote.trim() || selected ? { quote: (quote.trim() || selected).slice(0, 1000) } : {}),
        confidence: 0.9
      }
    })
    setSubject('')
    setPredicate('')
    setObject('')
    setQuote('')
  }
  const review = async (): Promise<void> => {
    setChecking(true)
    try {
      await run('review')
      setTab('checks')
    } finally {
      setChecking(false)
    }
  }
  return (
    <aside className="studio-fact-drawer" aria-label="人物与设定">
      <header>
        <div>
          <span className="studio-eyebrow">设定</span>
          <h2>人物与设定</h2>
        </div>
        <button type="button" onClick={() => setFactsOpen(false)} aria-label="关闭"><X size={14} /></button>
      </header>
      <div className="studio-fact-tabs">
        <button type="button" className={tab === 'people' ? 'is-active' : ''} onClick={() => setTab('people')}><Users size={12} /> 人物</button>
        <button type="button" className={tab === 'facts' ? 'is-active' : ''} onClick={() => setTab('facts')}><BookMarked size={12} /> 设定</button>
        <button type="button" className={tab === 'world' ? 'is-active' : ''} onClick={() => setTab('world')}><Globe2 size={12} /> 世界</button>
        <button type="button" className={tab === 'story' ? 'is-active' : ''} onClick={() => setTab('story')}><BookOpen size={12} /> 章节</button>
        <button type="button" className={tab === 'checks' ? 'is-active' : ''} onClick={() => setTab('checks')}><Eye size={12} /> 检查</button>
      </div>
      <div className="studio-fact-scroll">
        {tab === 'people' ? (
          <>
            {active.characters.map((character) => (
              <button key={character.id} type="button" className="studio-fact-person" onClick={() => onEditCharacter(character)}>
                <span>{character.name.slice(0, 1)}</span>
                <div>
                  <b>{character.name}<em>{character.role}</em></b>
                  <p>{character.desire || character.look}</p>
                  {character.relationships.length ? <small>{character.relationships.map((rel) => `${rel.target}：${rel.label}`).join(' · ')}</small> : null}
                </div>
              </button>
            ))}
            <p className="studio-hint">点击人物可以改外观、想要的、害怕的和声线。</p>
          </>
        ) : null}
        {tab === 'facts' ? (
          <>
            <div className="studio-fact-form">
              <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="说的是谁：林晚" aria-label="设定主体" />
              <input value={predicate} onChange={(event) => setPredicate(event.target.value)} placeholder="哪方面：想要" aria-label="设定关系" />
              <textarea value={object} onChange={(event) => setObject(event.target.value)} placeholder="内容：把外婆的伞铺继续开下去" rows={2} aria-label="设定内容" />
              <input value={quote} onChange={(event) => setQuote(event.target.value)} placeholder="原文摘录（可选；编辑器里有选中文字时会优先用它）" aria-label="设定原文摘录" />
              <Button variant="ghost" size="sm" onClick={() => void addFact()} disabled={!subject || !predicate || !object}>保存这条设定</Button>
            </div>
            {active.facts.map((fact) => (
              <div key={fact.id} className="studio-fact-row">
                <div>
                  <b>{fact.subject}<i>{fact.predicate}</i>{fact.object}</b>
                  <button type="button" className="studio-fact-source" onClick={() => jumpToFact(fact.id)} title="定位到事实来源">
                    {fact.chapterId ? `第 ${active.chapters.find((item) => item.id === fact.chapterId)?.number ?? '?'} 章` : fact.sceneId ? '镜头设定' : '全局设定'} · {fact.source === 'local' ? '本机整理' : fact.source === 'ai' ? '模型整理' : fact.source === 'import' ? '导入' : '手写'}
                  </button>
                  {fact.quote ? <small className="studio-fact-quote">“{fact.quote}”</small> : null}
                </div>
                <button type="button" title="删除设定" aria-label="删除设定" onClick={() => void run('delete-fact', { factId: fact.id })}><Trash2 size={12} /></button>
              </div>
            ))}
          </>
        ) : null}
        {tab === 'world' ? (
          <div className="studio-world-panel">
            <section>
              <header><b>势力</b><em>{active.factions.length}</em><button type="button" onClick={() => setWorldEditor({ kind: 'faction', item: null })}><PlusCircle size={11} /> 新增</button></header>
              {active.factions.length ? active.factions.map((item) => (
                <button key={item.id} type="button" className="studio-world-row" onClick={() => setWorldEditor({ kind: 'faction', item })}>
                  <Flag size={13} />
                  <span><b>{item.name}</b><p>{item.description || '还没有说明。'}</p></span>
                  <Pencil size={11} />
                </button>
              )) : <p className="studio-hint">还没有势力。先写下谁在主角周围施加压力。</p>}
            </section>
            <section>
              <header><b>规则</b><em>{active.rules.length}</em><button type="button" onClick={() => setWorldEditor({ kind: 'rule', item: null })}><Plus size={11} /> 新增</button></header>
              {active.rules.length ? active.rules.map((item) => (
                <button key={item.id} type="button" className="studio-world-row" onClick={() => setWorldEditor({ kind: 'rule', item })}>
                  <ScrollText size={13} />
                  <span><b>{item.title}</b><p>{item.content || '还没有正文。'}</p></span>
                  <Pencil size={11} />
                </button>
              )) : <p className="studio-hint">还没有规则。世界的代价越具体，选择就越有重量。</p>}
            </section>
            <section>
              <header><b>道具</b><em>{active.props.length}</em><button type="button" onClick={() => setWorldEditor({ kind: 'prop', item: null })}><PackagePlus size={11} /> 新增</button></header>
              {active.props.length ? active.props.map((item) => (
                <button key={item.id} type="button" className="studio-world-row" onClick={() => setWorldEditor({ kind: 'prop', item })}>
                  <Layers size={13} />
                  <span><b>{item.name}</b><p>{item.description || '还没有说明。'}</p></span>
                  <Pencil size={11} />
                </button>
              )) : <p className="studio-hint">还没有关键道具。能反复出现、能改变选择的物件最值得记下。</p>}
            </section>
            <section className="studio-relationship-block">
              <header><b>人物关系</b><em>{active.characters.reduce((sum, character) => sum + character.relationships.length, 0)} 条</em></header>
              <RelationshipGraph characters={active.characters} onPick={onEditCharacter} />
            </section>
          </div>
        ) : null}
        {tab === 'story' ? (
          <div className="studio-story-index">
            <p className="studio-hint">按章节号浏览简介和状态；点击进入正文。</p>
            {[...active.chapters].sort((a, b) => a.number - b.number).map((item) => (
              <button
                key={item.id}
                type="button"
                className="studio-story-index-row"
                onClick={() => {
                  selectChapter(item.id)
                  setView('writing')
                  setFactsOpen(false)
                }}
              >
                <span className="mono">{String(item.number).padStart(2, '0')}</span>
                <span>
                  <b>{item.title}</b>
                  <em>{item.synopsis || '还没有简介。'}</em>
                </span>
                <i>{countWords(item.content) ? chapterWordLabel(countWords(item.content)) : '待写'}</i>
              </button>
            ))}
          </div>
        ) : null}
        {tab === 'checks' ? (
          <>
            <Button variant="ghost" size="sm" icon={checking ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} onClick={() => void review()} disabled={checking}>重新检查</Button>
            {active.checks.length === 0 ? <p className="studio-hint">还没有检查记录。运行一次检查，看看人物、设定和章节有没有矛盾。</p> : null}
            {active.checks.filter((check) => check.kind === 'continuity').map((check) => (
              <div key={check.id} className={`studio-check-row is-${check.level}`}>
                <b>{check.title}</b>
                <p>{check.detail}</p>
              </div>
            ))}
            {active.checks.filter((check) => check.kind !== 'continuity').slice(0, 6).map((check) => (
              <div key={check.id} className={`studio-check-row is-${check.level}`}>
                <b>{check.title}</b>
                <p>{check.detail}</p>
              </div>
            ))}
          </>
        ) : null}
      </div>
      {worldEditor ? <WorldItemDialog kind={worldEditor.kind} item={worldEditor.item} onClose={() => setWorldEditor(null)} /> : null}
    </aside>
  )
}

function chapterWordLabel(words: number): string {
  if (words <= 0) return '—'
  if (words <= 99_999) return words.toLocaleString('zh-CN')
  return `${(words / 10_000).toFixed(1)} 万`
}

export function WritingView(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const selectedChapterId = useStudioStore((state) => state.selectedChapterId)
  const selectChapter = useStudioStore((state) => state.selectChapter)
  const outlineOpen = useStudioStore((state) => state.outlineOpen)
  const setOutlineOpen = useStudioStore((state) => state.setOutlineOpen)
  const factsOpen = useStudioStore((state) => state.factsOpen)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  const focusMode = useStudioStore((state) => state.focusMode)
  const setFocusMode = useStudioStore((state) => state.setFocusMode)
  const saveState = useStudioStore((state) => state.saveState)
  const setSaveState = useStudioStore((state) => state.setSaveState)
  const setEditorDirty = useStudioStore((state) => state.setEditorDirty)
  const navigateStage = useStudioStore((state) => state.navigateStage)
  const setView = useStudioStore((state) => state.setView)
  const focusedStage = useStudioStore((state) => state.focusedStage)
  const [stageMenuOpen, setStageMenuOpen] = useState(false)
  const stageMenuRef = useClickOutside(() => setStageMenuOpen(false), stageMenuOpen)

  const chapter = active?.chapters.find((item) => item.id === selectedChapterId) ?? null
  const [content, setContent] = useState(chapter?.content ?? '')
  const [title, setTitle] = useState(chapter?.title ?? '')
  const [synopsis, setSynopsis] = useState(chapter?.synopsis ?? '')
  const [dirty, setDirty] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [batchWriting, setBatchWriting] = useState(false)
  const [outlineGenerating, setOutlineGenerating] = useState(false)
  const [paperSize, setPaperSize] = useState<PaperSize>(() => storedChoice('morrow.studio.paper.size', 'md', PAPER_SIZES))
  const [paperLine, setPaperLine] = useState<PaperLine>(() => storedChoice('morrow.studio.paper.line', 'normal', PAPER_LINES))
  const [paperWidth, setPaperWidth] = useState<PaperWidth>(() => storedChoice('morrow.studio.paper.width', 'normal', PAPER_WIDTHS))
  const [docMenu, setDocMenu] = useState<'type' | 'count' | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [exportingWord, setExportingWord] = useState(false)
  const [illustrationsOpen, setIllustrationsOpen] = useState(false)
  const [diffCandidate, setDiffCandidate] = useState<StudioCandidate | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [addChapterOpen, setAddChapterOpen] = useState(false)
  const [editingCharacter, setEditingCharacter] = useState<StudioCharacter | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<StudioChapter | null>(null)
  const [volumeEditor, setVolumeEditor] = useState<{ volume: StudioVolume | null } | null>(null)
  const [confirmVolume, setConfirmVolume] = useState<StudioVolume | null>(null)
  const [dragChapterId, setDragChapterId] = useState<string | null>(null)
  const [dropVolumeId, setDropVolumeId] = useState<string | null>(null)
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<string>>(new Set())
  const [factTab, setFactTab] = useState<FactTab>('people')
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorView | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const contentRef = useRef(content)
  const dirtyRef = useRef(false)
  const titleRef = useRef(title)
  const synopsisRef = useRef(synopsis)
  const chapterRef = useRef<StudioChapter | null>(chapter)
  const savingRef = useRef(false)
  const queuedSaveRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const activeRef = useRef(active)

  contentRef.current = content
  dirtyRef.current = dirty
  titleRef.current = title
  synopsisRef.current = synopsis
  chapterRef.current = chapter
  activeRef.current = active

  useEffect(() => {
    if (focusedStage === 'visuals' && chapter && !illustrationsOpen) setIllustrationsOpen(true)
    // 只在进入“画面”阶段时自动打开当前章配图；用户手动关闭后不反复弹。
  }, [focusedStage, chapter?.id])

  const docMenuRef = useClickOutside(() => setDocMenu(null), Boolean(docMenu))

  useEffect(() => {
    try {
      localStorage.setItem('morrow.studio.paper.size', paperSize)
      localStorage.setItem('morrow.studio.paper.line', paperLine)
      localStorage.setItem('morrow.studio.paper.width', paperWidth)
    } catch {
      // 本地存储不可用时只在本次会话内生效
    }
  }, [paperSize, paperLine, paperWidth])

  useEffect(() => {
    if (!findOpen) return
    const timer = window.setTimeout(() => findInputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [findOpen])

  const findMatches = useMemo(() => {
    if (!findText) return [] as Array<{ from: number; to: number }>
    const haystack = content.toLocaleLowerCase()
    const needle = findText.toLocaleLowerCase()
    const matches: Array<{ from: number; to: number }> = []
    let cursor = 0
    while (cursor <= haystack.length - needle.length) {
      const at = haystack.indexOf(needle, cursor)
      if (at < 0) break
      matches.push({ from: at, to: at + needle.length })
      cursor = at + Math.max(1, needle.length)
    }
    return matches
  }, [content, findText])

  useEffect(() => {
    setMatchIndex(0)
  }, [findText])

  const words = countWords(content)
  const candidates = chapter?.candidates ?? []
  const generatingJob = active?.jobs.find((job) => job.stage === 'writing' && (job.status === 'running' || job.status === 'queued'))
  const outlineJob = active?.jobs.find((job) => job.stage === 'outline' && (job.status === 'running' || job.status === 'queued'))

  const saveNow = useCallback(async (): Promise<void> => {
    const currentChapter = chapterRef.current
    const project = activeRef.current
    if (!currentChapter || !project) return
    if (savingRef.current) {
      queuedSaveRef.current = true
      return
    }
    savingRef.current = true
    setSaveState('saving')
    const snapshot = contentRef.current
    try {
      const result = await run('save-chapter', {
        chapterId: currentChapter.id,
        content: snapshot,
        title: titleRef.current,
        synopsis: synopsisRef.current,
        wordTarget: currentChapter.wordTarget
      })
      void result
      if (contentRef.current === snapshot) {
        setDirty(false)
        setEditorDirty(false)
        setSaveState('saved')
      } else {
        queuedSaveRef.current = true
      }
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
      if (queuedSaveRef.current) {
        queuedSaveRef.current = false
        window.setTimeout(() => void saveNow(), 240)
      }
    }
  }, [run, setEditorDirty, setSaveState])
  const saveRef = useRef(saveNow)
  saveRef.current = saveNow

  // 章节切换：载入当前章到编辑器和本地状态。
  useEffect(() => {
    if (!chapter) {
      setContent('')
      setTitle('')
      setSynopsis('')
      setDirty(false)
      setEditorDirty(false)
      return
    }
    if (chapterRef.current?.id === chapter.id && dirtyRef.current) return
    setContent(chapter.content)
    setTitle(chapter.title)
    setSynopsis(chapter.synopsis)
    setDirty(false)
    setEditorDirty(false)
    setSaveState('saved')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.id])

  // 外部内容变化（AI 初稿、采用候选、恢复版本）在未手改时同步到编辑器。
  useEffect(() => {
    if (!chapter) return
    if (dirtyRef.current) return
    if (chapter.content !== contentRef.current) {
      setContent(chapter.content)
      const view = editorRef.current
      if (view && view.state.doc.toString() !== chapter.content) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: chapter.content } })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.content, chapter?.revision])

  // CodeMirror 只创建一次；章节切换时替换文档，保持撤销历史按章隔离。
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: contentRef.current,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          placeholder('从这里开始写。也可以先让助手出一版草稿。'),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            contentRef.current = next
            setContent(next)
            setDirty(true)
            setEditorDirty(true)
          }),
          EditorView.theme({
            '&': { height: 'auto' },
            '.cm-scroller': { overflow: 'visible' },
            '.cm-content': { caretColor: 'var(--text)' }
          })
        ]
      }),
      parent: hostRef.current
    })
    editorRef.current = view
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void saveRef.current()
      } else if (key === 'f' || key === 'h') {
        event.preventDefault()
        setDocMenu(null)
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      view.destroy()
      editorRef.current = null
      if (dirtyRef.current) void saveRef.current()
    }
  }, [setEditorDirty])

  // 自动保存：停笔约 900ms。
  useEffect(() => {
    if (!dirty || !chapter) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void saveNow()
    }, 900)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [content, dirty, chapter?.id, saveNow])

  const grouped = useMemo(() => {
    if (!active) return []
    const volumes = [...active.volumes].sort((a, b) => a.number - b.number)
    const result = volumes.map((volume) => ({
      id: volume.id,
      title: volume.title,
      chapters: active.chapters.filter((item) => item.volumeId === volume.id).sort((a, b) => a.number - b.number)
    }))
    const orphan = active.chapters.filter((item) => !item.volumeId || !volumes.some((volume) => volume.id === item.volumeId)).sort((a, b) => a.number - b.number)
    if (orphan.length) result.push({ id: 'orphan', title: active.volumes.length ? '未分卷' : '章节', chapters: orphan })
    return result
  }, [active])

  if (!active) return <div />

  const switchChapter = async (id: string): Promise<void> => {
    if (id === selectedChapterId) return
    if (dirty) await saveNow()
    selectChapter(id)
  }

  const generate = async (): Promise<void> => {
    if (!chapter || generating) return
    setGenerating(true)
    try {
      await run('generate-chapter', {
        chapterId: chapter.id,
        useModel: true,
        requestId: `chapter-${chapter.id}-${Date.now()}`
      })
      notify('info', chapter.content.trim() ? '正在生成候选稿；采用前不会改动正文。' : '正在写这一章；完成后可直接继续手改。')
      if (dirty) await saveNow()
    } finally {
      setGenerating(false)
    }
  }

  const polish = async (): Promise<void> => {
    if (!chapter || polishing) return
    setPolishing(true)
    try {
      await run('polish-chapter', { chapterId: chapter.id, requestId: `polish-${chapter.id}-${Date.now()}` })
      notify('info', '润色任务已排队；完成后会以候选稿出现，不覆盖正文。')
    } finally {
      setPolishing(false)
    }
  }

  const generateOutline = async (): Promise<void> => {
    if (outlineGenerating || outlineJob) return
    if (dirty) await saveNow()
    setOutlineGenerating(true)
    try {
      await run('generate-outline', { useModel: true, requestId: `outline-${Date.now()}` })
      notify('info', '正在用模型细化章纲；已有正文不会被改写。')
    } finally {
      setOutlineGenerating(false)
    }
  }

  const addChapter = (): void => setAddChapterOpen(true)

  const batchWrite = async (): Promise<void> => {
    if (batchWriting) return
    if (dirty) await saveNow()
    setBatchWriting(true)
    try {
      const result = await run<{ project: typeof active; job?: { label: string }; message?: string }>('batch-write', {
        count: 3,
        useModel: true
      })
      notify('info', result.message ?? '已排队连续写作。')
    } finally {
      setBatchWriting(false)
    }
  }

  const deleteChapter = async (): Promise<void> => {
    if (!confirmDelete) return
    await run('delete-chapter', { chapterId: confirmDelete.id, confirmed: true })
    setConfirmDelete(null)
    const next = active.chapters.filter((item) => item.id !== confirmDelete.id).sort((a, b) => a.number - b.number)[0]
    if (next) selectChapter(next.id)
  }

  const focusEditor = (): EditorView | null => {
    const view = editorRef.current
    if (view) view.focus()
    return view
  }

  const undoEdit = (): void => {
    const view = focusEditor()
    if (view) undo(view)
  }

  const redoEdit = (): void => {
    const view = focusEditor()
    if (view) redo(view)
  }

  const selectMatch = (index: number): void => {
    const view = editorRef.current
    const match = findMatches[index]
    if (!view || !match) return
    view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true })
    setMatchIndex(index)
  }

  const findNext = (direction: 1 | -1): void => {
    if (!findMatches.length) return
    const next = (matchIndex + direction + findMatches.length) % findMatches.length
    selectMatch(next)
  }

  const replaceOne = (): void => {
    const view = editorRef.current
    const match = findMatches[Math.min(matchIndex, Math.max(0, findMatches.length - 1))]
    if (!view || !match) return
    view.dispatch({ changes: { from: match.from, to: match.to, insert: replaceText } })
    findNext(1)
  }

  const replaceAll = (): void => {
    const view = editorRef.current
    if (!view || !findMatches.length) return
    let next = content
    for (let index = findMatches.length - 1; index >= 0; index -= 1) {
      const match = findMatches[index]
      next = `${next.slice(0, match.from)}${replaceText}${next.slice(match.to)}`
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    setFindOpen(false)
    notify('success', `已替换 ${findMatches.length} 处。`)
  }

  const exportWord = async (): Promise<void> => {
    if (exportingWord) return
    setExportingWord(true)
    try {
      if (dirty) await saveNow()
      await run('export', { format: 'docx', requestId: `export-docx-${Date.now()}` })
      notify('info', 'Word 文档已排队导出；完成后可在交付页下载。')
    } finally {
      setExportingWord(false)
    }
  }

  const charCount = content.replace(/\s+/g, '').length
  const paragraphCount = content.split(/\n{2,}/).filter((paragraph) => paragraph.trim()).length
  const readingMinutes = Math.max(1, Math.ceil(words / 300))

  return (
    <div className={`studio-writing ${focusMode ? 'is-focus' : ''} ${factsOpen ? 'is-facts' : ''}`} data-paper-size={paperSize} data-paper-line={paperLine} data-paper-width={paperWidth}>
      <div className="studio-writing-main">
        <header className="studio-writing-bar">
          <div className="studio-writing-bar-left">
            {!focusMode ? (
              <div className="studio-writing-stage" ref={stageMenuRef}>
                <button type="button" className={['studio-writing-stage-btn', stageMenuOpen ? 'is-open' : ''].filter(Boolean).join(' ')} onClick={() => setStageMenuOpen((open) => !open)} aria-expanded={stageMenuOpen} aria-haspopup="menu">
                  <Layers size={14} strokeWidth={1.5} />
                  切换阶段
                  <ChevronDown size={11} strokeWidth={1.6} />
                </button>
                {stageMenuOpen ? (
                  <div className="studio-writing-stage-pop" role="menu">
                    <span className="studio-menu-label">切换阶段</span>
                    {studioStages(active.kind).map((stage) => {
                      const current = (focusedStage ?? active.stage) === stage.id
                      return (
                        <button key={stage.id} type="button" role="menuitem" className={current ? 'is-current' : ''} onClick={() => { setStageMenuOpen(false); navigateStage(stage.id) }}>
                          <StageIcon stage={stage.id} size={13} />
                          <span>{stage.label}</span>
                          {current ? <em>当前</em> : null}
                        </button>
                      )
                    })}
                    <div className="studio-writing-stage-divider" />
                    <button type="button" role="menuitem" onClick={() => { setStageMenuOpen(false); setView('home') }}>
                      <BookOpen size={13} />
                      <span>作品库</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {!focusMode ? (
              <button type="button" className={['studio-bar-icon', outlineOpen ? 'is-active' : ''].filter(Boolean).join(' ')} title={outlineOpen ? '收起目录' : '展开目录'} onClick={() => setOutlineOpen(!outlineOpen)}>
                <BookOpen size={15} />
              </button>
            ) : null}
            <div className="studio-writing-breadcrumb">
              <span>{active.title}</span>
              <i>/</i>
              <b>第 {chapter?.number ?? '—'} 章</b>
            </div>
            <span className={`studio-save-state is-${saveState}`}>
              {saveState === 'saving' ? <Loader2 size={11} className="studio-spin" /> : saveState === 'error' ? '!' : <Check size={11} />}
              {saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : '已保存'}
            </span>
          </div>
          <div className="studio-writing-bar-right">
            <button type="button" className={['studio-bar-icon', factsOpen ? 'is-active' : ''].filter(Boolean).join(' ')} title="人物、设定与检查" onClick={() => setFactsOpen(!factsOpen)}>
              <Users size={15} />
            </button>
            <button type="button" className="studio-bar-icon" title="历史版本" onClick={() => setHistoryOpen(true)} disabled={!chapter}>
              <FileClock size={15} />
            </button>
            <button type="button" className={['studio-bar-icon', focusMode ? 'is-active' : ''].filter(Boolean).join(' ')} title={focusMode ? '退出专注模式' : '专注模式'} onClick={() => setFocusMode(!focusMode)}>
              {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <Button variant="gold" size="sm" icon={generating ? <Loader2 size={13} className="studio-spin" /> : <WandSparkles size={13} />} onClick={() => void generate()} disabled={!chapter || Boolean(generatingJob)}>
              {generatingJob ? '写作中' : chapter?.content.trim() ? '生成候选稿' : 'AI 写这一章'}
            </Button>
            {engine?.text.configured && chapter?.content.trim() ? (
              <Button variant="ghost" size="sm" icon={polishing ? <Loader2 size={13} className="studio-spin" /> : <WandSparkles size={13} />} onClick={() => void polish()} disabled={polishing || Boolean(generatingJob)} title="生成润色候选稿" aria-label="润色">润色</Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon={batchWriting ? <Loader2 size={13} className="studio-spin" /> : <Layers size={13} />}
              onClick={() => void batchWrite()}
              disabled={batchWriting || generating || !active.chapters.some((item) => !item.content.trim())}
              title="只续写还没有正文的章节；每章单独生成一版候选稿，已有正文不会被覆盖"
              aria-label="连续写 3 章"
            >
              连续写 3 章
            </Button>
            {focusMode ? (
              <Button variant="ghost" size="sm" onClick={addChapter} icon={<Plus size={13} />} title="新建章节" aria-label="新章">新建一章</Button>
            ) : null}
          </div>
        </header>

        <div className="studio-doc-toolbar" aria-label="文档工具">
          <div className="studio-doc-group">
            <button type="button" className="studio-doc-btn" title="撤销（Ctrl+Z）" aria-label="撤销" onClick={undoEdit} disabled={!chapter}><Undo2 size={14} /></button>
            <button type="button" className="studio-doc-btn" title="重做（Ctrl+Shift+Z）" aria-label="重做" onClick={redoEdit} disabled={!chapter}><Redo2 size={14} /></button>
          </div>
          <span className="studio-doc-sep" />
          <button type="button" className={['studio-doc-btn', findOpen ? 'is-active' : ''].filter(Boolean).join(' ')} title="查找与替换（Ctrl+F）" aria-label="查找与替换" onClick={() => setFindOpen((open) => !open)} disabled={!chapter}><Search size={14} /><span>查找</span></button>
          <span className="studio-doc-sep" />
          <div className="studio-doc-menu-wrap" ref={docMenuRef}>
            <div className="studio-doc-group">
              <button type="button" className={['studio-doc-btn', docMenu === 'type' ? 'is-active' : ''].filter(Boolean).join(' ')} title="排版：字号、行距与页宽" aria-label="排版" onClick={() => setDocMenu((menu) => (menu === 'type' ? null : 'type'))} disabled={!chapter}><Type size={14} /><span>排版</span></button>
              <button type="button" className={['studio-doc-btn', docMenu === 'count' ? 'is-active' : ''].filter(Boolean).join(' ')} title="字数与阅读时间" aria-label="字数统计" onClick={() => setDocMenu((menu) => (menu === 'count' ? null : 'count'))} disabled={!chapter}><Hash size={14} /><span>字数</span></button>
            </div>
            {docMenu === 'type' ? (
              <div className="studio-doc-popover is-type" role="dialog" aria-label="排版设置">
                <label><span>正文字号</span><Segmented value={paperSize} options={[{ value: 'sm', label: '小' }, { value: 'md', label: '标准' }, { value: 'lg', label: '大' }]} onChange={(value) => setPaperSize(value as PaperSize)} ariaLabel="正文字号" /></label>
                <label><span>行距</span><Segmented value={paperLine} options={[{ value: 'tight', label: '紧凑' }, { value: 'normal', label: '标准' }, { value: 'loose', label: '宽松' }]} onChange={(value) => setPaperLine(value as PaperLine)} ariaLabel="行距" /></label>
                <label><span>页宽</span><Segmented value={paperWidth} options={[{ value: 'narrow', label: '窄' }, { value: 'normal', label: '标准' }, { value: 'wide', label: '宽' }]} onChange={(value) => setPaperWidth(value as PaperWidth)} ariaLabel="页宽" /></label>
                <p>只改变阅读与书写视图，不改正文内容，也不影响导出。</p>
              </div>
            ) : null}
            {docMenu === 'count' ? (
              <div className="studio-doc-popover is-count" role="dialog" aria-label="字数统计">
                <div><span>正文</span><b className="mono">{words.toLocaleString('zh-CN')} 字</b></div>
                <div><span>不含空格</span><b className="mono">{charCount.toLocaleString('zh-CN')} 字</b></div>
                <div><span>段落</span><b className="mono">{paragraphCount}</b></div>
                <div><span>大约阅读</span><b className="mono">{readingMinutes} 分钟</b></div>
                <p>目标 {chapter?.wordTarget.toLocaleString('zh-CN') ?? 0} 字 · 当前完成 {Math.round((words / Math.max(1, chapter?.wordTarget ?? 1)) * 100)}%</p>
              </div>
            ) : null}
          </div>
          <span className="studio-doc-spacer" />
          <button type="button" className="studio-doc-btn is-export" title="导出 Word 文档，可继续修改" aria-label="导出 Word" onClick={() => void exportWord()} disabled={!chapter || exportingWord || !content.trim()}>{exportingWord ? <Loader2 size={14} className="studio-spin" /> : <FileDown size={14} />}<span>导出 Word</span></button>
        </div>

        {findOpen ? (
          <div className="studio-findbar" role="search" aria-label="查找与替换">
            <input ref={findInputRef} value={findText} onChange={(event) => setFindText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey ? -1 : 1) } else if (event.key === 'Escape') setFindOpen(false) }} placeholder="查找正文" aria-label="查找正文" />
            <span className="studio-find-count mono">{findText ? `${findMatches.length ? Math.min(matchIndex + 1, findMatches.length) : 0}/${findMatches.length}` : '—'}</span>
            <button type="button" title="上一个（Shift+Enter）" aria-label="上一个" onClick={() => findNext(-1)} disabled={!findMatches.length}><ArrowUp size={12} /></button>
            <button type="button" title="下一个（Enter）" aria-label="下一个" onClick={() => findNext(1)} disabled={!findMatches.length}><ArrowDown size={12} /></button>
            <span className="studio-doc-sep" />
            <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="替换为" aria-label="替换为" />
            <button type="button" onClick={replaceOne} disabled={!findMatches.length}>替换</button>
            <button type="button" onClick={replaceAll} disabled={!findMatches.length}>全部替换</button>
            <button type="button" className="studio-find-close" title="关闭查找" aria-label="关闭查找" onClick={() => setFindOpen(false)}><X size={13} /></button>
          </div>
        ) : null}

        {!chapter ? (
          <div className="studio-writing-empty">
            <span className="studio-empty-mark"><Library size={24} strokeWidth={1.2} /></span>
            <h2>这本书还没有章节</h2>
            <p>先建立第一章，或者回到蓝图确认章节安排。</p>
            <Button variant="gold" icon={<Plus size={14} />} onClick={addChapter}>新建第一章</Button>
          </div>
        ) : (
          <div className="studio-writing-body">
            {!focusMode && outlineOpen ? (
              <aside className="studio-outline">
                <div className="studio-outline-head">
                  <span className="studio-eyebrow">目录</span>
                  <button
                    type="button"
                    className="studio-outline-generate"
                    onClick={() => void generateOutline()}
                    disabled={outlineGenerating || Boolean(outlineJob)}
                    title={active.blueprint?.outlineModel ? '用当前模型重新细化章纲；已有正文保持不变' : '用当前模型细化章名、梗概与节拍'}
                  >
                    {outlineJob ? '正在生成章纲' : active.blueprint?.outlineModel ? '重新细化章纲' : '生成章纲'}
                  </button>
                  <em className="mono">{active.chapters.reduce((sum, item) => sum + countWords(item.content), 0).toLocaleString('zh-CN')} 字</em>
                </div>
                <div className="studio-outline-scroll">
                  {grouped.map((group) => {
                    const collapsed = collapsedVolumes.has(group.id)
                    const volume = active.volumes.find((item) => item.id === group.id) ?? null
                    return (
                      <div
                        key={group.id}
                        className={`studio-outline-volume ${dropVolumeId === group.id ? 'is-drop-target' : ''}`}
                        onDragOver={(event) => {
                          if (!dragChapterId) return
                          event.preventDefault()
                          setDropVolumeId(group.id)
                        }}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropVolumeId(null)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          const chapterId = dragChapterId || event.dataTransfer.getData('text/plain')
                          if (chapterId) void run('move-chapter', { chapterId, volumeId: group.id === 'orphan' ? null : group.id })
                          setDragChapterId(null)
                          setDropVolumeId(null)
                        }}
                      >
                        <div className="studio-outline-volume-head">
                          <button
                            type="button"
                            className="studio-outline-volume-toggle"
                            onClick={() => {
                              setCollapsedVolumes((state) => {
                                const next = new Set(state)
                                if (next.has(group.id)) next.delete(group.id)
                                else next.add(group.id)
                                return next
                              })
                            }}
                          >
                            <ChevronDown size={11} className={collapsed ? 'is-collapsed' : ''} />
                            <span>{group.title}</span>
                            <em>{group.chapters.length}</em>
                          </button>
                          {volume ? (
                            <span className="studio-outline-volume-actions">
                              <button type="button" title="编辑分卷" aria-label="编辑分卷" onClick={() => setVolumeEditor({ volume })}><Pencil size={10} /></button>
                              <button type="button" title="上移分卷" aria-label="上移分卷" onClick={() => void run('move-volume', { volumeId: volume.id, offset: -1 })}><ArrowUp size={10} /></button>
                              <button type="button" title="下移分卷" aria-label="下移分卷" onClick={() => void run('move-volume', { volumeId: volume.id, offset: 1 })}><ArrowDown size={10} /></button>
                              <button type="button" title="删除分卷" aria-label="删除分卷" onClick={() => setConfirmVolume(volume)}><Trash2 size={10} /></button>
                            </span>
                          ) : null}
                        </div>
                        {!collapsed
                          ? group.chapters.map((item) => (
                              <div
                                key={item.id}
                                draggable
                                onDragStart={(event) => {
                                  setDragChapterId(item.id)
                                  event.dataTransfer.effectAllowed = 'move'
                                  event.dataTransfer.setData('text/plain', item.id)
                                }}
                                onDragEnd={() => {
                                  setDragChapterId(null)
                                  setDropVolumeId(null)
                                }}
                                onDragOver={(event) => {
                                  if (!dragChapterId) return
                                  event.preventDefault()
                                  setDropVolumeId(group.id)
                                }}
                                onDrop={(event) => {
                                  event.stopPropagation()
                                  event.preventDefault()
                                  const chapterId = dragChapterId || event.dataTransfer.getData('text/plain')
                                  if (chapterId && chapterId !== item.id) {
                                    void run('move-chapter', {
                                      chapterId,
                                      volumeId: group.id === 'orphan' ? null : group.id,
                                      beforeChapterId: item.id
                                    })
                                  }
                                  setDragChapterId(null)
                                  setDropVolumeId(null)
                                }}
                                className={['studio-outline-row', item.id === chapter.id ? 'is-current' : '', dragChapterId === item.id ? 'is-dragging' : ''].filter(Boolean).join(' ')}
                              >
                                <button type="button" className="studio-outline-chapter" onClick={() => void switchChapter(item.id)}>
                                  <span className={`studio-outline-dot is-${item.status}`} />
                                  <span className="studio-outline-number mono">{String(item.number).padStart(2, '0')}</span>
                                  <span className="studio-outline-title">{item.title}</span>
                                  <span className="studio-outline-words mono">{chapterWordLabel(countWords(item.content))}</span>
                                  {item.candidates.length ? <i className="studio-outline-candidate">{item.candidates.length}</i> : null}
                                </button>
                                <span className="studio-outline-actions">
                                  <button type="button" title="上移" aria-label="上移一章" onClick={() => void run('move-chapter', { chapterId: item.id, offset: -1 })}><ArrowUp size={11} /></button>
                                  <button type="button" title="下移" aria-label="下移一章" onClick={() => void run('move-chapter', { chapterId: item.id, offset: 1 })}><ArrowDown size={11} /></button>
                                  <button type="button" title="删除" aria-label="删除一章" onClick={() => setConfirmDelete(item)}><Trash2 size={11} /></button>
                                </span>
                              </div>
                            ))
                          : null}
                      </div>
                    )
                  })}
                </div>
                <div className="studio-outline-add-row">
                  <button type="button" className="studio-outline-add" onClick={addChapter}><Plus size={12} /> 新建一章</button>
                  <button type="button" className="studio-outline-add" onClick={() => setVolumeEditor({ volume: null })}><FolderPlus size={12} /> 新建分卷</button>
                </div>
                <div className="studio-outline-foot">
                  <span>已写 {active.chapters.filter((item) => item.content.trim()).length}/{active.chapters.length} 章</span>
                  <button type="button" onClick={() => setFocusMode(true)}><Maximize2 size={11} /> 专注</button>
                </div>
              </aside>
            ) : null}

            <div className="studio-paper-scroll">
              <article className="studio-paper">
                <header className="studio-paper-head">
                  <span className="studio-paper-chapter mono">第 {chapter.number} 章</span>
                  <input
                    className="studio-paper-title"
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value)
                      setDirty(true)
                      setEditorDirty(true)
                    }}
                    onBlur={() => void saveNow()}
                    aria-label="章节标题"
                  />
                  <div className="studio-paper-meta">
                    <span>{words.toLocaleString('zh-CN')} / {chapter.wordTarget.toLocaleString('zh-CN')} 字</span>
                    <i />
                    <span className={`is-${chapter.status}`}>{studioStatusLabel(chapter.status)}</span>
                    <i />
                    <span>{candidates.length ? `${candidates.length} 版候选稿等你决定` : '候选不会覆盖你写的正文'}</span>
                    {generatingJob ? <span className="studio-paper-live"><Loader2 size={10} className="studio-spin" /> 正在写</span> : null}
                    <button type="button" className="studio-paper-illustration-btn" onClick={() => setIllustrationsOpen(true)}>
                      <ImagePlus size={11} /> 配图{chapter.illustrations.length ? ` ${chapter.illustrations.length}` : ''}
                    </button>
                  </div>
                  <div className="studio-paper-synopsis">
                    <span>本章简介</span>
                    <input
                      value={synopsis}
                      onChange={(event) => {
                        setSynopsis(event.target.value)
                        setDirty(true)
                        setEditorDirty(true)
                      }}
                      onBlur={() => void saveNow()}
                      placeholder="简单说，这一章发生了什么？"
                      aria-label="本章简介"
                    />
                  </div>
                </header>

                {candidates.length ? (
                  <div className="studio-candidate-banner">
                    <span><Layers size={12} /> {candidates.length} 版候选稿等你决定，正文没有变。</span>
                    <div>
                      {candidates.slice(0, 2).map((candidate) => (
                        <button key={candidate.id} type="button" onClick={() => setDiffCandidate(candidate)}>{candidate.label}</button>
                      ))}
                      {candidates.length > 2 ? <button type="button" onClick={() => setDiffCandidate(candidates[0])}>查看全部候选</button> : null}
                    </div>
                  </div>
                ) : null}

                <div className="studio-manuscript" ref={hostRef} aria-label="正文编辑器" />
                {chapter.illustrations.length ? (
                  <div className="studio-paper-illustrations" aria-label="章节配图">
                    {chapter.illustrations.map((item) => {
                      const asset = active.assets.find((entry) => entry.id === item.assetId)
                      if (!asset) return null
                      return (
                        <figure key={item.id}>
                          <img src={asset.thumbUrl ?? asset.url} alt={item.caption ?? asset.title} />
                          <figcaption>{item.caption ?? asset.title}<span>第 {item.afterParagraph} 段后</span></figcaption>
                        </figure>
                      )
                    })}
                  </div>
                ) : null}
                {!content.trim() ? (
                  <div className="studio-paper-empty">
                    <Sparkles size={18} strokeWidth={1.3} />
                    <p>这一章还是空白。可以直接开始写，或者让助手先给一版草稿。</p>
                    <Button variant="ghost" size="sm" icon={<WandSparkles size={13} />} onClick={() => void generate()} disabled={Boolean(generatingJob)}>
                      {generatingJob ? '正在生成…' : '先生成一版草稿'}
                    </Button>
                  </div>
                ) : null}
                <footer className="studio-paper-foot">
                  <span>手改自动保存 · 用候选前自动留档</span>
                </footer>
              </article>
            </div>

            {!focusMode && factsOpen ? <FactPanel onEditCharacter={setEditingCharacter} /> : null}
          </div>
        )}
        {focusMode ? (
          <button type="button" className="studio-focus-exit" onClick={() => setFocusMode(false)}><Minimize2 size={13} /> 退出专注</button>
        ) : null}
      </div>

      {diffCandidate && chapter ? <CandidateDiff chapter={chapter} candidate={diffCandidate} onClose={() => setDiffCandidate(null)} onBefore={saveNow} /> : null}
      {historyOpen && chapter ? <VersionDialog chapter={chapter} onClose={() => setHistoryOpen(false)} onBefore={saveNow} /> : null}
      {illustrationsOpen && chapter ? <IllustrationDialog chapter={chapter} onClose={() => setIllustrationsOpen(false)} /> : null}
      <AddChapterDialog
        open={addChapterOpen}
        onClose={() => setAddChapterOpen(false)}
        onCreated={(id) => {
          selectChapter(id)
          setAddChapterOpen(false)
        }}
      />
      {editingCharacter ? <CharacterDialog character={editingCharacter} onClose={() => setEditingCharacter(null)} /> : null}
      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={`删除第 ${confirmDelete?.number ?? ''} 章？`}
        description="这一章和它的候选稿会被移除；作品会保留其他章节。删除前建议先导出作品。"
        width={460}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>保留</Button>
            <Button variant="danger" onClick={() => void deleteChapter()}>删除这一章</Button>
          </div>
        }
      >
        <p className="studio-confirm-text"><b>{confirmDelete?.title}</b><br />{confirmDelete ? `${countWords(confirmDelete.content)} 字 · ${confirmDelete.candidates.length} 个候选` : null}</p>
      </Modal>
      {volumeEditor ? <VolumeDialog volume={volumeEditor.volume} onClose={() => setVolumeEditor(null)} /> : null}
      <Modal
        open={Boolean(confirmVolume)}
        onClose={() => setConfirmVolume(null)}
        title={`删除分卷「${confirmVolume?.title ?? ''}」？`}
        description="分卷里的章节会保留并移到「未分卷」，正文、候选与版本都不会删除。"
        width={460}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setConfirmVolume(null)}>保留分卷</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmVolume) void run('delete-volume', { volumeId: confirmVolume.id })
                setConfirmVolume(null)
              }}
            >
              删除分卷
            </Button>
          </div>
        }
      >
        <p className="studio-confirm-text"><b>{confirmVolume?.title}</b><br />{confirmVolume ? `${confirmVolume.chapterIds.length} 章会保留并移动到未分卷。` : null}</p>
      </Modal>
    </div>
  )
}

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

function TimelineViewAssetOf(project: StudioProject, clip: StudioClip): StudioAsset | undefined {
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
  const visualAsset = visualClip ? TimelineViewAssetOf(project, visualClip) : undefined
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
      const asset = TimelineViewAssetOf(project, clip)
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
    if (asset.tags.includes('draft')) return STUDIO_AUDIO_DRAFT_LICENSE
    if (asset.origin?.source === 'local') return STUDIO_AUDIO_LICENSE
    if (asset.origin?.source === 'comfyui' && asset.tags.includes('music')) return STUDIO_AUDIO_LICENSE
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
            <span>{(() => { const asset = active?.assets.find((item) => item.id === clip.assetId); if (!asset) return '未选择音频'; if (asset.origin?.source === 'sapi') return '本机配音 · 仅用于本项目'; if (asset.origin?.source === 'cloud-tts') return '云端配音 · 按服务商条款'; if (asset.tags.includes('draft')) return STUDIO_AUDIO_DRAFT_LICENSE; if (asset.origin?.source === 'local' || (asset.origin?.source === 'comfyui' && asset.tags.includes('music'))) return STUDIO_AUDIO_LICENSE; return '用户导入 · 需自行确认授权' })()}</span>
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
      <Modal open={audioOpen} onClose={() => setAudioOpen(false)} title="音频库" description="项目音频与快速生成；每个素材都标注来源和授权。" width={680}>
        <div className="studio-audio-library">
          <div className="studio-audio-library-section">
            <span className="studio-audio-library-label">快速生成 · {STUDIO_AUDIO_LICENSE}</span>
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
            {!active?.assets.some((asset) => asset.kind === 'audio') ? <p className="studio-hint">作品里还没有音频素材。可以快速生成配乐/音效，或在分镜页生成配音/音乐。</p> : null}
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
          <button type="button" className={subtitleOn ? 'is-active' : ''} onClick={() => setSubtitleOn((value) => !value)} title="显示 / 隐藏字幕" aria-label="显示字幕" aria-pressed={subtitleOn}><Captions size={14} /> <span className="studio-toolbar-label">显示字幕</span></button>
          <button type="button" className={muted ? 'is-active' : ''} onClick={() => setMuted((value) => !value)} title="静音预览" aria-label="静音预览" aria-pressed={muted}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
          <button type="button" onClick={addSubtitle} title="在播放头添加一条字幕" aria-label="添加字幕"><Captions size={13} /> <span className="studio-toolbar-label">添加字幕</span></button>
          <button type="button" className={assetsOpen ? 'is-active' : ''} onClick={() => setAssetsOpen((value) => !value)} title="素材" aria-label="素材" aria-pressed={assetsOpen}><Layers size={13} /> <span className="studio-toolbar-label">素材</span></button>
          <button type="button" className={timelineInspectorOpen ? 'is-active' : ''} onClick={() => { setTimelineInspectorOpen(!timelineInspectorOpen); if (!timelineInspectorOpen && !selectedClipId) selectClip(draft.clips[0]?.id ?? null) }} title="片段属性" aria-label="片段" aria-pressed={timelineInspectorOpen}><SlidersHorizontal size={13} /> <span className="studio-toolbar-label">片段</span></button>
        </div>
        <div className="studio-timeline-tools-right">
          <span className="studio-zoom-label mono" title="时间线缩放">{Math.round(pxPerSec)} 像素/秒</span>
          <button type="button" onClick={() => setPxPerSec((value) => Math.max(16, Math.round(value * 0.8)))} title="缩小" aria-label="缩小时间线"><ZoomOut size={14} /></button>
          <input type="range" min={16} max={200} value={pxPerSec} onChange={(event) => setPxPerSec(Number(event.target.value))} aria-label="时间线缩放" />
          <button type="button" onClick={() => setPxPerSec((value) => Math.min(200, Math.round(value * 1.25)))} title="放大" aria-label="放大时间线"><ZoomIn size={14} /></button>
          <Button variant="ghost" size="sm" className="studio-toolbar-delivery" onClick={() => navigateStage('delivery')}>交付页</Button>
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
              const asset = TimelineViewAssetOf(active, clip)
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

interface VersionRow {
  id: string
  createdAt: number
  reason: string
  revision: number
}

export function VersionHistoryPanel({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    studioApi.action<{ versions: VersionRow[] }>('list-versions', { projectId: active.id })
      .then((result) => {
        if (!cancelled) setVersions(result.versions)
      })
      .catch((err) => {
        if (!cancelled) notify('error', err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, notify])

  if (!active) return <p className="studio-hint">打开一部作品后可以查看历史版本。</p>

  const restore = async (version: VersionRow): Promise<void> => {
    setRestoring(version.id)
    try {
      await run('restore-version', { versionId: version.id })
      notify('success', '已经回到这一版；回来前的状态也留了一份。')
      onClose?.()
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div className="studio-version-dialog">
      <div className="studio-version-dialog-head">
        <span><FileClock size={13} /> {active.title}</span>
        <b className="mono">现在是第 {active.revision} 版</b>
      </div>
      {loading ? (
        <div className="studio-version-loading"><Loader2 size={15} className="studio-spin" /> 正在读取历史版本…</div>
      ) : versions.length === 0 ? (
        <p className="studio-hint">还没有历史版本。确认蓝图、用候选或合成之后会自动出现。</p>
      ) : (
        <div className="studio-version-list">
          {versions.map((version) => (
            <div key={version.id} className="studio-version-row">
              <span className="studio-version-time mono">{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <div>
                <b>{version.reason}</b>
                              </div>
              <span className="mono">第 {version.revision} 版</span>
              <Button variant="ghost" size="sm" icon={restoring === version.id ? <Loader2 size={11} className="studio-spin" /> : <RotateCcw size={11} />} loading={restoring === version.id} onClick={() => void restore(version)}>
                回到这一版
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="studio-hint">历史版本存在这部作品里；回到旧版不会删除素材或任务记录。</p>
    </div>
  )
}

export function StudioTrashPanel({
  notify
}: {
  notify: (kind: 'success' | 'info' | 'error', text: string) => void
}): React.JSX.Element {
  const [items, setItems] = useState<StudioTrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [pendingPurge, setPendingPurge] = useState<StudioTrashItem | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await studioApi.action<{ items: StudioTrashItem[] }>('list-trash')
      setItems(result.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const restore = async (item: StudioTrashItem): Promise<void> => {
    if (busy) return
    setBusy(item.entry)
    try {
      await studioApi.action('restore-trash', { entry: item.entry })
      await useStudioStore.getState().refreshLibrary()
      notify('success', `《${item.title}》已恢复到作品库。`)
      await load()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const purge = async (): Promise<void> => {
    if (!pendingPurge || busy) return
    setBusy(pendingPurge.entry)
    try {
      await studioApi.action('purge-trash', { entry: pendingPurge.entry })
      notify('success', `《${pendingPurge.title}》已彻底删除。`)
      setPendingPurge(null)
      await load()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="studio-trash">
      <div className="studio-trash-summary">
        <span className="mono">回收站里 {items.length} 部作品</span>
        {loading ? <Loader2 size={13} className="studio-spin" /> : null}
      </div>

      {error ? <p className="studio-trash-error">{error}</p> : null}

      {!loading && !items.length ? (
        <div className="studio-trash-empty">
          <Trash2 size={22} strokeWidth={1.4} aria-hidden />
          <b>回收站是空的</b>
          <p>在作品库删除作品后，它会出现在这里。</p>
        </div>
      ) : (
        <ul className="studio-trash-list" aria-label="回收站作品">
          {items.map((item) => (
            <li key={item.entry} className="studio-trash-row">
              <span className="studio-trash-icon"><Trash2 size={14} strokeWidth={1.5} /></span>
              <div className="studio-trash-main">
                <p className="studio-trash-title" title={item.title}>{item.title}</p>
                <p className="studio-trash-meta">
                  {studioKindLabel(item.kind)}
                  {item.chapters ? ` · ${item.chapters} 章` : item.shots ? ` · ${item.shots} 镜` : ''}
                  {item.words ? ` · ${formatWordCount(item.words)} 字` : ''}
                  {` · 删除于 ${timeAgo(item.deletedAt)}`}
                </p>
              </div>
              <div className="studio-trash-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={busy === item.entry ? <Loader2 size={12} className="studio-spin" /> : <ArchiveRestore size={12} />}
                  onClick={() => void restore(item)}
                  disabled={Boolean(busy)}
                >
                  恢复
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={12} />}
                  onClick={() => setPendingPurge(item)}
                  disabled={Boolean(busy)}
                >
                  彻底删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={Boolean(pendingPurge)}
        onClose={() => setPendingPurge(null)}
        title="彻底删除这部作品？"
        description="作品的章节、素材、历史版本和交付记录会从本机删除，无法再恢复。"
        width={460}
        layer="overlay"
        footer={
          <div className="studio-modal-footer">
            <Button variant="ghost" onClick={() => setPendingPurge(null)}>保留</Button>
            <Button variant="danger" onClick={() => void purge()} loading={Boolean(busy)}>彻底删除</Button>
          </div>
        }
      >
        <p className="studio-confirm-text"><b>{pendingPurge?.title}</b><br />删除后不会再出现在作品库或回收站。</p>
      </Modal>
    </div>
  )
}

export type StudioSettingsTab = 'models' | 'voice-engines' | 'versions' | 'trash' | 'data'

const TABS: Array<{ id: StudioSettingsTab; label: string; icon: LucideIcon }> = [
  { id: 'models', label: '模型与预算', icon: Sparkles },
  { id: 'voice-engines', label: '配音与引擎', icon: Wrench },
  { id: 'versions', label: '历史版本', icon: FileClock },
  { id: 'trash', label: '回收站', icon: Trash2 },
  { id: 'data', label: '数据与安全', icon: ShieldCheck }
]

const PAGE_META: Record<StudioSettingsTab, { title: string; description: string }> = {
  models: { title: '模型与预算', description: '选择先用本机还是云端模型，并为当前作品设定预算上限；密钥仍在 Agent 设置里。' },
  'voice-engines': { title: '配音与引擎', description: '决定草稿配音方式，并查看本机 ComfyUI、FFmpeg 与系统声线是否就绪。' },
  versions: { title: '历史版本', description: '作品自动留档的关键节点都在这里；恢复前会先备份当前版本。' },
  trash: { title: '回收站', description: '删除的作品先放在这里；可以恢复到作品库，也可以彻底删除。' },
  data: { title: '数据与安全', description: '作品、素材和任务记录都只存在本机；密钥由 Agent 设置保管。' }
}

function StudioSettingsDialogContextLabel(value?: number): string {
  if (!value) return ''
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M 上下文`
  if (value >= 1000) return `${Math.round(value / 1000)}k 上下文`
  return `${value} 上下文`
}

export function StudioSettingsDialog({
  open,
  onClose,
  initialTab = 'models',
  initialFocus
}: {
  open: boolean
  onClose: () => void
  initialTab?: StudioSettingsTab
  initialFocus?: 'budget'
}): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const engine = useStudioStore((state) => state.engine)
  const run = useStudioStore((state) => state.run)
  const refreshEngine = useStudioStore((state) => state.refreshEngine)
  const notify = useStudioStore((state) => state.notify)
  const openAppSettings = useAppStore((state) => state.openSettings)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [tab, setTab] = useState<StudioSettingsTab>(initialTab)
  const [limit, setLimit] = useState(String(active?.runtime.budget.limit ?? 30))
  const [noLimit, setNoLimit] = useState((active?.runtime.budget.limit ?? 30) === 0)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [strategy, setStrategy] = useState(active?.runtime.strategy ?? 'local-first')
  const [routes, setRoutes] = useState<NonNullable<StudioEngineStatus['text']['routes']>>([])
  const [ttsMode, setTtsMode] = useState<'system' | 'cloud'>(active?.runtime.tts?.mode ?? 'system')
  const [ttsModel, setTtsModel] = useState(active?.runtime.tts?.model ?? 'tts-1')
  const [ttsVoice, setTtsVoice] = useState(active?.runtime.tts?.voice ?? '')
  const [dataInfo, setDataInfo] = useState<StudioDataDirInfo | null>(null)
  const [dataBusy, setDataBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    void studioApi.dataDirInfo().then(setDataInfo).catch(() => undefined)
  }, [open, initialTab])

  useEffect(() => {
    if (!open || initialFocus !== 'budget' || tab !== 'models') return
    const timer = window.setTimeout(() => {
      paneRef.current?.querySelector<HTMLElement>('[data-settings-section="budget"]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [open, initialFocus, tab])

  useEffect(() => {
    if (!open) return
    setLimit(String(active?.runtime.budget.limit ?? 30))
    setNoLimit((active?.runtime.budget.limit ?? 30) === 0)
    setStrategy(active?.runtime.strategy ?? 'local-first')
    setTtsMode(active?.runtime.tts?.mode ?? 'system')
    setTtsModel(active?.runtime.tts?.model ?? 'tts-1')
    setTtsVoice(active?.runtime.tts?.voice ?? '')
  }, [open, active?.id, active?.runtime.budget.limit, active?.runtime.strategy, active?.runtime.tts?.mode, active?.runtime.tts?.model, active?.runtime.tts?.voice])

  useEffect(() => {
    if (!open || !active) return
    let cancelled = false
    void run<{ routes: NonNullable<StudioEngineStatus['text']['routes']> }>('text-routes', { strategy })
      .then((result) => {
        if (!cancelled) setRoutes(result.routes)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, active?.id, strategy, run])

  const budgetInvalid = Boolean(active) && !noLimit && !(Number(limit) > 0)

  const save = async (): Promise<void> => {
    if (!active) return
    setSaving(true)
    try {
      await run('update-runtime', {
        strategy,
        budget: { limit: noLimit ? 0 : Math.max(0, Number(limit) || 0), spent: active.runtime.budget.spent },
        tts: { mode: ttsMode, model: ttsModel, voice: ttsVoice }
      })
      notify('success', '创作台设置已保存。')
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      await studioApi.openDataDir()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }

  const changeStudioDataDir = async (): Promise<void> => {
    if (dataBusy) return
    setDataBusy(true)
    try {
      const result = await studioApi.changeDataDir()
      if (result.canceled) return
      setDataInfo(await studioApi.dataDirInfo())
      notify('info', result.restarted ? '创作台数据目录已更换，应用正在重启。' : `已切换到 ${result.path ?? '新目录'}。`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setDataBusy(false)
    }
  }

  const resetStudioDataDir = async (): Promise<void> => {
    if (dataBusy) return
    setDataBusy(true)
    try {
      const result = await studioApi.resetDataDir()
      if (result.canceled) return
      setDataInfo(await studioApi.dataDirInfo())
      notify('info', result.restarted ? '正在恢复默认创作台目录并重启。' : `已恢复默认目录：${result.path ?? ''}`)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setDataBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshEngine()
      notify('info', '已重新检测这台电脑。')
    } finally {
      setRefreshing(false)
    }
  }

  const engineCards = (
    <div className="studio-engine-grid">
      <div className={`studio-engine-card ${engine?.media.imageReady ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><ImageIcon size={16} /></span>
        <div><b>画面引擎</b><span>{engine?.media.imageReady ? `已就绪${engine.media.gpu ? ` · ${engine.media.gpu}` : ''}` : engine?.media.message ?? '未检查'}</span></div>
        <i />
      </div>
      <div className={`studio-engine-card ${engine?.media.videoReady ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><Film size={16} /></span>
        <div><b>视频引擎</b><span>{engine?.media.videoReady ? '已就绪 · 图片可以变成视频' : '未就绪 · 草稿不需要视频'}</span></div>
        <i />
      </div>
      <div className={`studio-engine-card ${engine?.ffmpeg.available ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><Wrench size={16} /></span>
        <div><b>FFmpeg</b><span title={engine?.ffmpeg.available ? `FFmpeg ${engine.ffmpeg.profile === 'enhanced' ? '增强包' : '默认包'}` : engine?.ffmpeg.message ?? undefined}>{engine?.ffmpeg.available ? '已就绪' : engine?.ffmpeg.message ?? '未检查'}</span></div>
        <i />
      </div>
      <div className={`studio-engine-card ${engine?.voices.length ? 'is-on' : ''}`}>
        <span className="studio-engine-icon"><Mic2 size={16} /></span>
        <div><b>系统声线</b><span>{engine?.voices.length ? `${engine.voices.length} 个可用 · 可以做草稿配音` : engine?.voiceError ?? '未检测到'}</span></div>
        <i />
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创作台设置"
      width={880}
      layer="overlay"
      footer={
        <div className="studio-modal-footer">
          <span className="studio-settings-foot-hint">模型、配音和预算要点“保存设置”；历史版本、回收站和数据会即时读取。</span>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {active ? <Button variant="gold" onClick={() => void save()} loading={saving} disabled={budgetInvalid}>保存设置</Button> : null}
        </div>
      }
    >
      <div className="studio-settings-layout">
        <nav className="studio-settings-nav" role="tablist" aria-label="创作台设置">
          {TABS.map((item) => {
            const Icon = item.icon
            const disabled = !active && item.id === 'versions'
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={tab === item.id ? 'is-active' : ''}
                onClick={() => setTab(item.id)}
                disabled={disabled}
              >
                <span className="studio-settings-nav-icon" aria-hidden><Icon size={15} /></span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="studio-settings-pane" ref={paneRef}>
          <header className="studio-settings-head">
            <h2>{PAGE_META[tab].title}</h2>
            <p>{PAGE_META[tab].description}</p>
          </header>
          {tab === 'models' ? (
            <div className="studio-settings">
              <section className="studio-settings-section">
                <header><span className="studio-settings-title">文本模型</span><button type="button" onClick={() => void refresh()}>{refreshing ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} 刷新</button></header>
                <div className={`studio-engine-card ${engine?.text.configured ? 'is-on' : ''}`}>
                  <span className="studio-engine-icon"><Sparkles size={16} /></span>
                  <div><b>当前使用</b><span title={engine?.text.message ?? undefined}>{engine?.text.configured ? `${engine.text.providerLabel} · ${engine.text.modelLabel}` : '还没有可用的文字模型，去 Agent 设置连接一个。'}</span></div>
                  <i />
                </div>
                <div className="studio-settings-actions">
                  <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => { openAppSettings(); onClose() }}>去连接模型</Button>
                  <span>连接方式、密钥和订阅由 Agent 设置管理。</span>
                </div>
              </section>

              <section className="studio-settings-section" data-settings-section="budget">
                <header><span className="studio-settings-title">预算保护</span><span className="studio-settings-note">{noLimit ? '已关闭上限' : '花到上限会先停一下问你'}</span></header>
                {active ? (
                  <>
                    <div className="studio-budget-editor">
                      <label><span>项目预算上限</span><div><em>¥</em><input value={noLimit ? '' : limit} placeholder="不限" disabled={noLimit} onChange={(event) => setLimit(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" /><em>元</em></div></label>
                      <button
                        type="button"
                        className={['studio-budget-unlimited', noLimit ? 'is-on' : ''].filter(Boolean).join(' ')}
                        aria-pressed={noLimit}
                        onClick={() => {
                          if (noLimit) {
                            setNoLimit(false)
                            if (!(Number(limit) > 0)) setLimit('30')
                          } else {
                            setNoLimit(true)
                          }
                        }}
                      >
                        {noLimit ? '已不限' : '不设上限'}
                      </button>
                      <div className="studio-budget-stats">
                        <div><span>已花</span><b className="mono">¥{active.runtime.budget.spent.toFixed(2)}</b></div>
                        <div><span>最多</span><b className="mono">{noLimit ? '不限' : `¥${limit || '0'}`}</b></div>
                      </div>
                    </div>
                    {noLimit ? (
                      <p className="studio-settings-hint">没有上限：花费仍会逐项记录，付费动作开始前仍会先问你。</p>
                    ) : (
                      <>
                        <StudioProgress value={Number(limit) > 0 ? (active.runtime.budget.spent / Number(limit)) * 100 : 0} tone={active.runtime.budget.spent > Number(limit) ? 'rust' : 'gold'} />
                        {budgetInvalid ? <p className="studio-settings-hint">上限要大于 0；不想设上限就选「不设上限」。</p> : null}
                      </>
                    )}
                    <p className="studio-settings-hint">本机模型不额外收费；云端模型按服务商账单记录。不知道单价时会写“未知”，不会挡住任务。</p>
                  </>
                ) : (
                  <p className="studio-settings-hint">打开一部作品后可以设置花费上限。</p>
                )}
              </section>

              <section className="studio-settings-section">
                <header><span className="studio-settings-title">先用哪个模型</span><span className="studio-settings-note">保存后生效</span></header>
                <Segmented
                  value={strategy}
                  options={[
                    { value: 'local-first', label: '本机优先' },
                    { value: 'cloud-first', label: '云端优先' },
                    { value: 'local-only', label: '只本机' },
                    { value: 'cloud-only', label: '只云端' }
                  ]}
                  onChange={(value) => setStrategy(value as typeof strategy)}
                  ariaLabel="模型策略"
                />
                <p className="studio-settings-hint">
                  {strategy === 'local-first'
                    ? '先试这台电脑；做不到或会超预算时先问你，再换云端。'
                    : strategy === 'cloud-first'
                      ? '先试已经连好的云端模型；价格不明时会标“未知”，不猜账单。'
                      : strategy === 'local-only'
                        ? '只用这台电脑；本机做不到就直接说失败，不会偷偷联网。'
                        : '只用云端模型；合成和预览仍在这台电脑完成。'}
                </p>
              </section>

              <section className="studio-settings-section">
                <header><span className="studio-settings-title">实际会按这个顺序试</span><span className="studio-settings-note">按上面的选择排序</span></header>
                <div className="studio-route-table">
                  {routes.map((route) => (
                    <div key={`${route.providerId}:${route.modelId}`} className={`studio-route-row ${route.configured ? 'is-ready' : ''}`}>
                      <span className="studio-route-kind">{route.local ? '本机' : '云端'}</span>
                      <div><b>{route.providerLabel}</b><em>{route.modelLabel}{route.contextWindow ? ` · ${StudioSettingsDialogContextLabel(route.contextWindow)}` : ''}{route.supportsVision ? ' · 会看图' : ''}{route.supportsTools ? ' · 会用工具' : ''}</em></div>
                      <span className="mono" title="每百万 token 的输入 / 输出参考价">{route.inputPerMTok !== undefined && route.outputPerMTok !== undefined ? `参考价 $${route.inputPerMTok} / $${route.outputPerMTok}` : '价格未知'}</span>
                      <i>{route.configured ? '已连接' : '未连接'}</i>
                    </div>
                  ))}
                  {!routes.length ? <p className="studio-hint">当前没有可用的文本模型。到 Agent 设置里连接，或换成另一边再试。</p> : null}
                </div>
                <p className="studio-settings-hint">越靠前越先用；写作和预算估算用的是同一个模型。价格只作参考，以服务商账单为准。</p>
              </section>

            </div>
          ) : null}

          {tab === 'voice-engines' ? (
            <div className="studio-settings">
              <section className="studio-settings-section">
                <header><span className="studio-settings-title">配音方式</span><span className="studio-settings-note">{ttsMode === 'cloud' ? '用当前云端服务商' : 'Windows 自带'}</span></header>
                <Segmented
                  value={ttsMode}
                  options={[
                    { value: 'system', label: '系统声线' },
                    { value: 'cloud', label: '云端配音' }
                  ]}
                  onChange={(value) => setTtsMode(value === 'cloud' ? 'cloud' : 'system')}
                  ariaLabel="配音方式"
                />
                {ttsMode === 'cloud' ? (
                  <div className="studio-settings-inline">
                    <label><span>模型</span><input value={ttsModel} onChange={(event) => setTtsModel(event.target.value)} placeholder="例如 tts-1" /></label>
                    <label><span>声线</span><input value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)} placeholder="例如 alloy / 角色声" /></label>
                  </div>
                ) : null}
                <p className="studio-settings-hint">
                  {ttsMode === 'cloud'
                    ? '用当前云端服务商生成配音；不支持时会直接说明，不会偷偷换回系统声线。费用按账单记录，不知道就写未知。'
                    : '用 Windows 自带声线在本机生成，不额外收费；失败时可以去分镜页导入录音。'}
                </p>
                <div className={`studio-engine-card ${engine?.voices.length ? 'is-on' : ''}`}>
                  <span className="studio-engine-icon"><Mic2 size={16} /></span>
                  <div><b>系统声线</b><span>{engine?.voices.length ? `${engine.voices.length} 个可用` : engine?.voiceError ?? '未检测到系统声线'}</span></div>
                  <i />
                </div>
              </section>

              <section className="studio-settings-section">
                <header><span className="studio-settings-title">本机能力</span><button type="button" onClick={() => void refresh()}>{refreshing ? <Loader2 size={12} className="studio-spin" /> : <RefreshCw size={12} />} 刷新</button></header>
                {engineCards}
                <div className="studio-settings-actions">
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={12} />} onClick={() => void openFolder()}>打开作品总文件夹</Button>
                  <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => { openAppSettings(); onClose() }}>打开 Agent 设置</Button>
                </div>
                <p className="studio-settings-hint">画面生成需要本机 ComfyUI，视频合成需要 FFmpeg；它们不随 Morrow 一起安装。上方会显示实际检测结果。</p>
              </section>
            </div>
          ) : null}

          {tab === 'versions' ? (
            <VersionHistoryPanel onClose={onClose} />
          ) : null}

          {tab === 'trash' ? <StudioTrashPanel notify={notify} /> : null}

          {tab === 'data' ? (
            <div className="studio-settings">
              <section className="studio-settings-section">
                <header><span className="studio-settings-title">本机数据</span><span className="studio-settings-note">{dataInfo?.source === 'custom' ? '自定义创作台目录' : '全部在本机'}</span></header>
                <div className="studio-engine-grid">
                  <div className="studio-engine-card">
                    <span className="studio-engine-icon"><FolderOpen size={16} /></span>
                    <div><b>创作台数据</b><span title={dataInfo?.root ?? engine?.studioDataDir}>{dataInfo?.root ?? engine?.studioDataDir ?? '本地数据目录'}</span></div>
                    <button type="button" title="打开创作台数据文件夹" onClick={() => void openFolder()}><ExternalLink size={11} /></button>
                  </div>
                  <div className="studio-engine-card">
                    <span className="studio-engine-icon"><FileClock size={16} /></span>
                    <div><b>作品数量</b><span>{engine?.projectCount ?? 0} 部 · 自动留档，删除会先放进回收站</span></div>
                    <i />
                  </div>
                </div>
                <div className="studio-settings-actions">
                  <Button variant="gold" size="sm" icon={<FolderCog size={12} />} onClick={() => void changeStudioDataDir()} loading={dataBusy}>更换目录…</Button>
                  {dataInfo?.source === 'custom' ? <Button variant="ghost" size="sm" onClick={() => void resetStudioDataDir()} disabled={dataBusy}>恢复默认目录</Button> : null}
                  <Button variant="secondary" size="sm" icon={<FolderOpen size={12} />} onClick={() => void openFolder()}>打开创作台文件夹</Button>
                  <Button variant="secondary" size="sm" icon={<SlidersHorizontal size={12} />} onClick={() => { openAppSettings(); onClose() }}>打开 Agent 设置</Button>
                </div>
                <p className="studio-settings-hint">只迁移创作台作品、素材、历史版本与任务记录；Agent 对话、设置和密钥不移动。更换后应用会自动重启。</p>
              </section>
              <section className="studio-settings-security">
                <ShieldCheck size={16} />
                <div>
                  <b>密钥只保存在本机</b>
                  <p>作品、素材与任务记录都在本地；导出的文件不包含密钥、账号或旧应用数据。删除作品会先放进回收站。</p>
                </div>
                <span className="mono">只在本机</span>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}

const STEPS = [
  { title: '先写一句', caption: '一句话就是入口' },
  { title: '查看蓝图', caption: '确认前不花钱' },
  { title: '开始制作', caption: '纸页、分镜与成片' }
]

const STAGE_NOTES = ['一句话', '蓝图', '章节 / 分镜', '配音 / 音乐', '交付']

export function StudioGuide(): React.JSX.Element | null {
  const guideOpen = useStudioStore((state) => state.guideOpen)
  const closeGuide = useStudioStore((state) => state.closeGuide)
  const openDemo = useStudioStore((state) => state.openDemo)
  const version = useAppStore((state) => state.appInfo?.version)
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!guideOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeGuide()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [guideOpen, closeGuide])
  if (!guideOpen) return null
  return (
    <div className="studio-guide" role="dialog" aria-modal="true" aria-label="创作台使用指引">
      <div className="studio-guide-glow" aria-hidden />
      <header className="studio-guide-top">
        <div className="studio-guide-brand">
          <StudioMark size={32} />
          <span className="studio-guide-word serif">创作台</span>
          <span className="studio-guide-caption mono">第一次使用，先看三件事</span>
        </div>
        <button type="button" className="studio-guide-skip" onClick={closeGuide}>跳过指引</button>
      </header>

      <main className="studio-guide-body">
        <nav className="studio-guide-nav" aria-label="指引步骤">
          {STEPS.map((item, index) => {
            const state = index < step ? 'done' : index === step ? 'current' : 'todo'
            return (
              <button
                key={item.title}
                type="button"
                className={`is-${state}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span className="studio-guide-node" aria-hidden>
                  {state === 'done' ? <Check size={9} strokeWidth={2.4} /> : null}
                </span>
                <span className="studio-guide-step-copy">
                  <span className="studio-guide-step-label">{item.title}</span>
                  <span className="studio-guide-step-caption">{item.caption}</span>
                </span>
              </button>
            )
          })}
        </nav>

        <section className="studio-guide-panel">
          {step === 0 ? (
            <div className="studio-guide-content" key="one-sentence">
              <span className="studio-eyebrow">01 / 一句话</span>
              <h1 className="studio-guide-title">先写一句，<br />剩下交给创作台。</h1>
              <p className="studio-guide-lead">中短篇、长篇和漫剧共用同一套创作流程。你只需要说清想做什么，不必先想章节名或镜头号。</p>
              <ul className="studio-guide-features">
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>中短篇</b><em>3–8 万字，12 章起；按章节写、改、导出。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>长篇</b><em>20–100 万字；分卷、设定与前后衔接检查。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>漫剧</b><em>30–180 秒；分镜、配音、音乐与成片。</em></span>
                </li>
              </ul>
              <p className="studio-guide-fine">第一份蓝图必须使用你已配置的文本模型；没有模型时请先在设置里连接。</p>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="studio-guide-content" key="blueprint">
              <span className="studio-eyebrow">02 / 先看蓝图</span>
              <h1 className="studio-guide-title">先看蓝图，<br />再决定花多少。</h1>
              <p className="studio-guide-lead">蓝图画清故事主线、人物、结构、风格与费用区间。你点“确认并开始”之后，才会产生正文或媒体费用。</p>
              <ul className="studio-guide-features">
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>先看蓝图</b><em>故事主线、人物、结构与费用区间一次看清。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>不确认不扣费</b><em>正文、画面与配音都从确认之后才开始。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>手改优先</b><em>候选稿只放在候选区，不会覆盖你改过的段落。</em></span>
                </li>
              </ul>
              <p className="studio-guide-budget-line"><span>默认预算上限</span><b className="mono">¥30.00</b><em>可随时在“模型与预算”里调整</em></p>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="studio-guide-content" key="make">
              <span className="studio-eyebrow">03 / 开始制作</span>
              <h1 className="studio-guide-title">从纸页到成片，<br />每个决定都看得见。</h1>
              <p className="studio-guide-lead">小说走大纲、纸页、候选稿与导出；漫剧走分镜、画面、配音、音乐、时间线与成片。随时回到 Agent，现场不会丢。</p>
              <ul className="studio-guide-features">
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>纸页与分镜</b><em>小说按章节写作，漫剧按镜头推进；两者共用人物与设定。</em></span>
                </li>
                <li>
                  <span className="studio-guide-feature-node" aria-hidden />
                  <span><b>交付可验证</b><em>字幕、成片与工程包都能在本机打开，不依赖云端。</em></span>
                </li>
              </ul>
              <div className="studio-guide-pipeline" aria-label="制作流程">
                {STAGE_NOTES.map((note, index) => (
                  <span key={note}>
                    <em>{note}</em>
                    {index < STAGE_NOTES.length - 1 ? <ChevronRight size={11} aria-hidden /> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="studio-guide-actions">
            {step < STEPS.length - 1 ? (
              <Button variant="gold" iconRight={<ArrowRight size={13} />} onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>下一步</Button>
            ) : (
              <Button variant="gold" iconRight={<ArrowRight size={13} />} onClick={closeGuide}>开始创作</Button>
            )}
            <button type="button" className="studio-guide-text-action" onClick={openDemo}>
              看演示
            </button>
          </div>
          <p className="studio-guide-hint">随时可以从作品库右上角再看；演示不联网，也不会花额度。</p>
        </section>
      </main>

      <footer className="studio-guide-foot">
        <span className="mono">{version ? `v${version}` : ''}</span>
        <i />
        <span>一句话开始，确认后才花钱</span>
        <i />
        <span>随时可以跳过</span>
      </footer>
    </div>
  )
}

interface Act {
  id: string
  label: string
  kicker: string
  caption: string
  duration: number
}

const ACTS: Act[] = [
  {
    id: 'brief',
    label: '一句话',
    kicker: '先写下最想拍的那一句',
    caption: '一句话就能开工。蓝图负责把它拆成能拍的故事，而不是直接堆画面。',
    duration: 6_500
  },
  {
    id: 'blueprint',
    label: '蓝图',
    kicker: '先看清，再动手',
    caption: '故事主线、人物、结构与预算一次看清。确认之后才开始生成，费用有数。',
    duration: 6_500
  },
  {
    id: 'storyboard',
    label: '分镜',
    kicker: '12 个镜头，逐格落下',
    caption: '景别、运镜、对白和角色参考都写进每一镜，脸和雨向不会飘。',
    duration: 7_000
  },
  {
    id: 'sound',
    label: '声音',
    kicker: '让画面先有呼吸',
    caption: '对白按角色声线合成，雨声与钢琴铺底；字幕逐句贴合镜头。',
    duration: 6_500
  },
  {
    id: 'edit',
    label: '剪辑',
    kicker: '五条轨道，对齐到同一秒',
    caption: '画面、配音、音乐、音效、字幕在同一条时间线上；改动只影响被选中的那一句。',
    duration: 7_000
  },
  {
    id: 'delivery',
    label: '交付',
    kicker: '成片、字幕、工程包',
    caption: '交付不是终点。成片旁边永远留着可以继续改的工程，素材与时间线都在。',
    duration: 6_500
  }
]

const ACT_STARTS = ACTS.reduce<number[]>((acc, act, index) => {
  acc.push(index === 0 ? 0 : acc[index - 1] + ACTS[index - 1].duration)
  return acc
}, [])

const TOTAL_MS = ACTS.reduce((sum, act) => sum + act.duration, 0)

const DEMO_SPEED_KEY = 'morrow.studio-demo.speed'

const FALLBACK_LOG = '一个雨夜，修伞的女孩捡到一把会让时间倒流的伞。她每修好一把伞，就会失去一段记忆。'

const FALLBACK_SHOTS: Array<[string, string, string, number, string, string]> = [
  ['雨夜捡伞', '固定全景，雨丝斜切画面', '全景', 8, '', ''],
  ['伞骨倒转', '特写，手部与物件', '特写', 8, '', ''],
  ['少年出现', '中景，门框构图，缓慢推近', '中景', 8, '还能修好吗？', '少年'],
  ['第一次修伞', '近景，俯拍工作台', '近景', 7, '你每周三都来，是为了它，还是为了别的？', '林晚'],
  ['红线', '微距特写，红线入画', '特写', 8, '', ''],
  ['外婆的声音', '中景，蒸汽与光', '中景', 8, '修不好也没关系。', '外婆'],
  ['雨中的纸鹤', '中景推近，雨向反转', '中景', 9, '这把伞，能把时间倒着走。', '林晚'],
  ['每周三的秘密', '双人近景，侧光', '近景', 8, '你认识她，对吗？', '少年'],
  ['记忆变暗', '特写，眼神失焦', '特写', 7, '我好像，正在忘记她。', '林晚'],
  ['时间退回一步', '全景，雨停的静止', '全景', 9, '', ''],
  ['放手', '中景，隔着柜台', '中景', 8, '这次，别再弄丢了。', '林晚'],
  ['雨停之后', '全景，门外的光慢慢进来', '全景', 8, '', '']
]

interface ReelShot {
  id: string
  number: number
  title: string
  camera: string
  size: string
  seconds: number
  dialogue: string
  speaker: string
  action: string
  continuity: string
  image?: string
}

interface ReelCharacter {
  id: string
  name: string
  role: string
  look: string
  image?: string
}

interface ReelVoice {
  speaker: string
  line: string
  image?: string
}

interface ReelClip {
  start: number
  duration: number
  label: string
}

interface ReelTrack {
  kind: StudioTrackKind
  name: string
  clips: ReelClip[]
}

type StudioTrackKind = 'video' | 'dialogue' | 'music' | 'sfx' | 'subtitle'

interface ReelDelivery {
  label: string
  kind: string
  bytes?: number
}

interface Reel {
  title: string
  logline: string
  genre: string
  audience: string
  core: string
  structure: string
  emotion: string
  seconds: number
  minutesMin?: number
  minutesMax?: number
  costMin?: number | null
  costMax?: number | null
  palette: string[]
  look: string
  camera: string
  sound: string
  width: number
  height: number
  fps: number
  characters: ReelCharacter[]
  shots: ReelShot[]
  voices: ReelVoice[]
  sfxCount: number
  musicLabel?: string
  tracks: ReelTrack[]
  deliveries: ReelDelivery[]
  cover?: string
}

function formatTime(seconds: number): string {
  const value = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function musicTitle(title: string): string {
  return title.replace(/^配乐\s*[·:：-]\s*/, '')
}

function StudioDemoAssetOf(project: StudioProject, id: string | null | undefined): StudioAsset | undefined {
  return id ? project.assets.find((asset) => asset.id === id) : undefined
}

function imageOf(project: StudioProject, id: string | null | undefined): string | undefined {
  const asset = StudioDemoAssetOf(project, id)
  return asset?.thumbUrl ?? asset?.url
}

function buildReel(project: StudioProject): Reel {
  const shots = [...project.shots].sort((a, b) => a.number - b.number).slice(0, 12)
  const characters = project.characters.slice(0, 3).map((character) => ({
    id: character.id,
    name: character.name,
    role: character.role,
    look: character.look,
    image: imageOf(project, character.refAssetIds[0])
  }))
  const portrait = new Map(characters.map((character) => [character.name, character.image]))
  const voices = shots
    .filter((shot) => shot.dialogue.trim())
    .slice(0, 3)
    .map((shot) => ({
      speaker: shot.speaker || '旁白',
      line: shot.dialogue.trim(),
      image: portrait.get(shot.speaker)
    }))
  const timeline = project.timeline
  const tracks = timeline.tracks
    .map((track) => ({
      kind: track.kind,
      name: track.name,
      clips: timeline.clips
        .filter((clip) => clip.trackId === track.id)
        .sort((a, b) => a.start - b.start)
        .map((clip) => ({ start: clip.start, duration: clip.duration, label: clip.label }))
    }))
    .filter((track) => track.clips.length > 0)
  const blueprint = project.blueprint
  const estimate = blueprint?.estimate
  const style = blueprint?.styleBible ?? project.styleBible
  const seconds = Math.round(timeline.durationSec || shots.reduce((sum, shot) => sum + shot.durationSec, 0) || 96)
  return {
    title: project.title,
    logline: project.logline,
    genre: project.brief.genre || '都市奇幻',
    audience: project.brief.audience || '喜欢短片的观众',
    core: blueprint?.storyCore || project.logline,
    structure: blueprint?.structure || '三幕 · 12 镜 / 96 秒',
    emotion: blueprint?.emotion || project.brief.tone,
    seconds,
    minutesMin: estimate?.minutesMin,
    minutesMax: estimate?.minutesMax,
    costMin: estimate?.costMin ?? null,
    costMax: estimate?.costMax ?? null,
    palette: style?.palette?.length ? style.palette : ['#c8ae7d', '#7fa292', '#c2795f', '#101820'],
    look: style?.look || '低饱和雨夜、暖色灯、轻微胶片颗粒',
    camera: style?.camera || '固定镜头与缓慢推近为主',
    sound: style?.sound || '雨声先行，钢琴只在高点出现',
    width: timeline.width || 1920,
    height: timeline.height || 1080,
    fps: timeline.fps || 24,
    characters,
    shots: shots.map((shot) => ({
      id: shot.id,
      number: shot.number,
      title: shot.title,
      camera: shot.camera,
      size: shot.shotSize,
      seconds: shot.durationSec,
      dialogue: shot.dialogue,
      speaker: shot.speaker,
      action: shot.action || shot.title,
      continuity: shot.continuity,
      image: imageOf(project, shot.imageAssetId)
    })),
    voices,
    sfxCount: project.assets.filter((asset) => asset.tags.includes('sfx')).length || 3,
    musicLabel: musicTitle(project.assets.find((asset) => asset.tags.includes('music'))?.title || '雨幕下的钢琴'),
    tracks,
    deliveries: project.deliveries
      .filter((delivery) => delivery.kind !== 'cover')
      .map((delivery) => ({
        label: delivery.label,
        kind: delivery.kind,
        bytes: delivery.bytes
      })),
    cover: imageOf(project, project.coverAssetId)
  }
}

function fallbackReel(): Reel {
  let cursor = 0
  const clips: ReelClip[] = FALLBACK_SHOTS.map(([title, , , seconds], index) => {
    const clip = { start: cursor, duration: seconds, label: String(index + 1).padStart(2, '0') }
    cursor += seconds
    return clip
  })
  const voices: ReelVoice[] = FALLBACK_SHOTS.filter((row) => row[4])
    .slice(0, 3)
    .map((row) => ({ speaker: row[5], line: row[4] }))
  return {
    title: '逆行的伞',
    logline: FALLBACK_LOG,
    genre: '都市奇幻',
    audience: '18–35 岁',
    core: '一个修伞的女孩，在雨夜捡到一把能让时间倒流的伞。她每修好一把伞，就会失去一段记忆。',
    structure: '三幕 · 12 镜 / 96 秒：捡伞 / 修伞 / 放手',
    emotion: '克制的悲伤 → 温柔的释然',
    seconds: 96,
    minutesMin: 11,
    minutesMax: 16,
    costMin: 6,
    costMax: 10,
    palette: ['#c8ae7d', '#7fa292', '#c2795f', '#101820'],
    look: '低饱和雨夜、暖色灯、潮湿反光，轻微胶片颗粒',
    camera: '固定镜头与缓慢推近为主，关键处一次手持跟随',
    sound: '雨声先行，钢琴只在高点出现；伞骨与心跳是两件重要的声音',
    width: 1920,
    height: 1080,
    fps: 24,
    characters: [
      { id: 'linwan', name: '林晚', role: '主角 · 修伞匠', look: '短发，深色围裙，雨夜里穿一件旧呢外套' },
      { id: 'boy', name: '少年', role: '失忆者 · 引线', look: '瘦，黑发被雨打湿，手里总捧着一把黑伞' },
      { id: 'grandma', name: '外婆', role: '记忆 · 规则', look: '旧毛衣、药箱、针线篮；只存在于倒流的雨里' }
    ],
    shots: FALLBACK_SHOTS.map((row, index) => ({
      id: `fallback-${index + 1}`,
      number: index + 1,
      title: row[0],
      camera: row[1],
      size: row[2],
      seconds: row[3],
      dialogue: row[4],
      speaker: row[5],
      action: row[0],
      continuity: index === 5 ? '延续第 5 镜的雨向与暖光；外婆只出现声音，不给正脸。' : ''
    })),
    voices,
    sfxCount: 3,
    musicLabel: '雨幕下的钢琴',
    tracks: [
      { kind: 'video', name: '画面', clips },
      {
        kind: 'dialogue',
        name: '对白',
        clips: voices.map((voice) => ({
          start: FALLBACK_SHOTS.findIndex((row) => row[4] === voice.line) * 8,
          duration: 3,
          label: voice.speaker
        }))
      },
      { kind: 'music', name: '音乐', clips: [{ start: 0, duration: 96, label: '雨幕下的钢琴' }] },
      {
        kind: 'sfx',
        name: '音效',
        clips: [
          { start: 0, duration: 18, label: '雨声' },
          { start: 24, duration: 6, label: '伞骨' },
          { start: 62, duration: 7, label: '心跳' }
        ]
      },
      {
        kind: 'subtitle',
        name: '字幕',
        clips: voices.map((voice) => ({
          start: FALLBACK_SHOTS.findIndex((row) => row[4] === voice.line) * 8 + 1,
          duration: 4,
          label: voice.line.slice(0, 8)
        }))
      }
    ],
    deliveries: [
      { label: '样例成片 · 96 秒', kind: 'mp4' },
      { label: '字幕 · SRT', kind: 'srt' },
      { label: '工程包', kind: 'package' }
    ]
  }
}

function preloadReel(reel: Reel): Promise<void> {
  const urls = [
    reel.cover,
    ...reel.characters.map((character) => character.image),
    ...reel.shots.map((shot) => shot.image)
  ].filter((url): url is string => Boolean(url))
  if (urls.length === 0) return Promise.resolve()
  const load = (url: string): Promise<void> =>
    new Promise((resolve) => {
      const image = new Image()
      image.decoding = 'async'
      image.onload = () => resolve()
      image.onerror = () => resolve()
      image.src = url
    })
  return Promise.race([
    Promise.all(urls.map(load)).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 4_000))
  ])
}

function useDemoSpeed(open: boolean): number {
  const [speed, setSpeed] = useState(1)
  useEffect(() => {
    if (!open) return
    const raw = Number(window.localStorage.getItem(DEMO_SPEED_KEY))
    setSpeed(Number.isFinite(raw) && raw >= 0.5 ? Math.min(16, raw) : 1)
  }, [open])
  return speed
}

function DemoClock({
  act,
  playing,
  speed,
  ended
}: {
  act: number
  playing: boolean
  speed: number
  ended: boolean
}): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
  }, [act])
  useEffect(() => {
    if (!playing || ended) return undefined
    const timer = window.setInterval(() => {
      setSeconds((value) => Math.min(ACTS[act].duration / 1000, value + 0.5 * speed))
    }, 500)
    return () => window.clearInterval(timer)
  }, [playing, ended, act, speed])
  const current = ended ? TOTAL_MS / 1000 : ACT_STARTS[act] / 1000 + seconds
  return <span>{formatTime(current)}</span>
}

function Waveform({ bars, className = '' }: { bars: number[]; className?: string }): React.JSX.Element {
  return (
    <span className={`sd-wave ${className}`.trim()} aria-hidden>
      {bars.map((height, index) => (
        <i
          key={index}
          style={{
            height: `${height}%`,
            animationDelay: `${(index % 9) * 90}ms`,
            animationDuration: `${900 + (index % 5) * 140}ms`
          }}
        />
      ))}
    </span>
  )
}

function BriefAct({ reel, playing }: { reel: Reel; playing: boolean }): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const indexRef = useRef(0)
  useEffect(() => {
    indexRef.current = 0
    setTyped('')
  }, [reel.logline])
  useEffect(() => {
    if (!playing) return undefined
    let interval = 0
    const start = window.setTimeout(() => {
      interval = window.setInterval(() => {
        if (indexRef.current >= reel.logline.length) {
          window.clearInterval(interval)
          return
        }
        indexRef.current += 1
        setTyped(reel.logline.slice(0, indexRef.current))
      }, 28)
    }, 240)
    return () => {
      window.clearTimeout(start)
      window.clearInterval(interval)
    }
  }, [playing, reel.logline])
  return (
    <div className="sd-brief">
      <div className="sd-brief-main">
        <div className="sd-paper">
          <div className="sd-paper-head">
            <span className="sd-eyebrow">项目起点 · 一句话</span>
            <span className="sd-paper-meta mono">{reel.genre}</span>
          </div>
          <p className="sd-logline">
            <span>{typed}</span>
            <i className="sd-caret-mark" aria-hidden />
          </p>
          <div className="sd-brief-chips">
            <span>漫剧短片</span>
            <span>16:9</span>
            <span>{reel.seconds} 秒</span>
            <span>{reel.audience}</span>
          </div>
          <div className="sd-paper-foot">
            <i className="sd-cursor" />
            <span className="mono">正在把这句画面拆成可拍摄的结构…</span>
          </div>
        </div>
      </div>
      <aside className="sd-breakdown">
        <span className="sd-eyebrow">蓝图拆解</span>
        <p className="sd-breakdown-core">
          <span><Sparkles size={11} strokeWidth={1.6} aria-hidden /> 故事核心</span>
          {reel.core}
        </p>
        <div className="sd-breakdown-row">
          <span className="sd-breakdown-index mono">01</span>
          <div>
            <b>结构</b>
            <span>{reel.structure}</span>
          </div>
        </div>
        <div className="sd-breakdown-row">
          <span className="sd-breakdown-index mono">02</span>
          <div>
            <b>情绪</b>
            <span>{reel.emotion}</span>
          </div>
        </div>
        <div className="sd-breakdown-row">
          <span className="sd-breakdown-index mono">03</span>
          <div>
            <b>人物</b>
            <span>{reel.characters.map((character) => character.name).join(' · ') || '林晚 · 少年 · 外婆'}</span>
          </div>
        </div>
        <div className="sd-breakdown-hint">
          <Layers size={13} strokeWidth={1.6} aria-hidden />
          <span>下一步：把结构变成 12 个可执行的镜头</span>
        </div>
      </aside>
    </div>
  )
}

function BlueprintAct({ reel }: { reel: Reel }): React.JSX.Element {
  const groups = [0, 1, 2].map((index) => {
    const slice = reel.shots.slice(index * 4, index * 4 + 4)
    return {
      index,
      name: ['捡伞', '修伞', '放手'][index],
      seconds: slice.reduce((sum, shot) => sum + shot.seconds, 0),
      shots: slice
    }
  })
  const budget = reel.costMin != null && reel.costMax != null ? `¥${reel.costMin}–${reel.costMax}` : '随包样例'
  return (
    <div className="sd-blueprint">
      <div className="sd-blueprint-head">
        <span className="sd-eyebrow">故事蓝图 · 确认后才开始生成</span>
        <p>{reel.core}</p>
      </div>
      <div className="sd-blueprint-grid">
        <section className="sd-structure">
          <header>
            <b>三幕 · 12 镜</b>
            <span className="mono">{reel.seconds} 秒</span>
          </header>
          <div className="sd-structure-lines">
            {groups.map((group) => (
              <div key={group.index} className="sd-structure-row">
                <span className="sd-structure-name">{group.name}</span>
                <span className="sd-structure-track">
                  <i style={{ width: `${Math.max(18, (group.seconds / Math.max(1, reel.seconds)) * 100)}%` }} />
                </span>
                <span className="mono">{group.seconds}s</span>
              </div>
            ))}
          </div>
          <div className="sd-structure-shots">
            {reel.shots.map((shot, index) => (
              <i
                key={shot.id}
                className={index === 5 ? 'is-key' : ''}
                style={{ animationDelay: `${480 + index * 70}ms` }}
                title={`镜 ${String(shot.number).padStart(2, '0')} · ${shot.title}`}
              />
            ))}
          </div>
          <div className="sd-structure-note">
            <Clock3 size={12} strokeWidth={1.6} aria-hidden />
            <span>{reel.minutesMin ? `${reel.minutesMin}–${reel.minutesMax} 分钟可完成` : '随包样例可直接播放'}</span>
          </div>
        </section>
        <section className="sd-cast">
          <header>
            <b>人物与参考</b>
            <span className="mono">{reel.characters.length} 位</span>
          </header>
          {reel.characters.map((character) => (
            <div key={character.id} className="sd-cast-row">
              <span className="sd-avatar">
                {character.image ? <img src={character.image} alt={character.name} draggable={false} /> : character.name.slice(0, 1)}
              </span>
              <div>
                <b>{character.name}</b>
                <span>{character.role}</span>
                <em>{character.look}</em>
              </div>
            </div>
          ))}
          <div className="sd-look">
            <div className="sd-palette" aria-label="视觉色板">
              {reel.palette.map((color) => (
                <i key={color} style={{ background: color }} title={color} />
              ))}
            </div>
            <p>{reel.look}</p>
            <span>{reel.camera}</span>
          </div>
        </section>
        <section className="sd-budget">
          <header>
            <b>预算与时长</b>
            <span className="sd-budget-total">{budget}</span>
          </header>
          <div className="sd-budget-row">
            <span>文字与分镜</span>
            <b>本机样例</b>
          </div>
          <div className="sd-budget-row">
            <span>画面 · {reel.shots.length} 镜</span>
            <b>随包就绪</b>
          </div>
          <div className="sd-budget-row">
            <span>配音 · {reel.voices.length} 段</span>
            <b>系统声线</b>
          </div>
          <div className="sd-budget-row">
            <span>配乐 · {reel.musicLabel}</span>
            <b>本地器乐</b>
          </div>
          <div className="sd-budget-note">确认蓝图后才进入生成；超出预算会再次确认。</div>
          <div className="sd-approve">
            <Check size={13} strokeWidth={2} aria-hidden />
            蓝图已确认
          </div>
        </section>
      </div>
    </div>
  )
}

function StoryboardAct({ reel }: { reel: Reel }): React.JSX.Element {
  const focus = reel.shots[5] ?? reel.shots[0]
  return (
    <div className="sd-storyboard">
      <div className="sd-board">
        {reel.shots.map((shot, index) => (
          <article
            key={shot.id}
            className={`sd-frame ${focus && shot.id === focus.id ? 'is-focus' : ''}`}
            style={{ animationDelay: `${120 + index * 85}ms` }}
          >
            <div className="sd-frame-media">
              {shot.image ? (
                <img src={shot.image} alt={`镜 ${shot.number} · ${shot.title}`} draggable={false} />
              ) : (
                <span className="sd-frame-empty mono">{String(shot.number).padStart(2, '0')}</span>
              )}
              <span className="sd-frame-number mono">{String(shot.number).padStart(2, '0')}</span>
              {shot.dialogue ? <span className="sd-frame-line">{shot.dialogue}</span> : null}
            </div>
            <div className="sd-frame-meta">
              <b>{shot.title}</b>
              <span className="mono">{shot.size} · {shot.seconds}s</span>
            </div>
          </article>
        ))}
        <span className="sd-board-scan" aria-hidden />
      </div>
      {focus ? (
        <aside className="sd-inspector">
          <span className="sd-eyebrow">镜 {String(focus.number).padStart(2, '0')} · 检查</span>
          <b>{focus.title}</b>
          <p>{focus.action}</p>
          <div className="sd-inspector-row">
            <span>运镜</span>
            <em>{focus.camera}</em>
          </div>
          <div className="sd-inspector-row">
            <span>对白</span>
            <em>{focus.dialogue ? `${focus.speaker}：${focus.dialogue}` : '无对白，保留雨声'}</em>
          </div>
          <div className="sd-inspector-row">
            <span>连续性</span>
            <em>{focus.continuity || '沿用上一镜的雨向、服装与光线'}</em>
          </div>
          <div className="sd-inspector-foot">
            <Check size={12} strokeWidth={2} aria-hidden />
            参考已锁定 · 不会换脸
          </div>
        </aside>
      ) : null}
    </div>
  )
}

function SoundAct({ reel }: { reel: Reel }): React.JSX.Element {
  const voices = reel.voices.length
    ? reel.voices
    : [
        { speaker: '少年', line: '还能修好吗？' },
        { speaker: '林晚', line: '你每周三都来，是为了它，还是为了别的？' },
        { speaker: '外婆', line: '修不好也没关系。' }
      ]
  const bars = useMemo(() => Array.from({ length: 26 }, (_, index) => 24 + ((index * 37) % 64)), [])
  const musicBars = useMemo(() => Array.from({ length: 64 }, (_, index) => 16 + ((index * 29) % 72)), [])
  return (
    <div className="sd-sound">
      <div className="sd-voice-grid">
        {voices.map((voice, index) => (
          <article key={`${voice.speaker}-${index}`} className="sd-voice" style={{ animationDelay: `${140 + index * 160}ms` }}>
            <span className="sd-voice-avatar">
              {voice.image ? <img src={voice.image} alt={voice.speaker} draggable={false} /> : voice.speaker.slice(0, 1)}
            </span>
            <div className="sd-voice-copy">
              <header>
                <b>{voice.speaker}</b>
                <span className="mono">已配音</span>
              </header>
              <p>{voice.line}</p>
              <Waveform bars={bars.slice(0, 20)} />
            </div>
          </article>
        ))}
        <div className="sd-mix">
          <header>
            <span className="sd-eyebrow">混音 · 对白优先</span>
            <span className="mono">-16 LUFS</span>
          </header>
          {[
            ['对白', 78, '0 dB'],
            ['音乐', 44, '-8 dB'],
            ['雨声', 62, '-5 dB']
          ].map(([name, level, db], index) => (
            <div key={name} className="sd-mix-row" style={{ animationDelay: `${700 + index * 170}ms` }}>
              <span>{name}</span>
              <i><b style={{ width: `${level}%` }} /></i>
              <em className="mono">{db}</em>
            </div>
          ))}
          <p>对白出现时音乐自动让路；字幕不压住雨声。</p>
        </div>
      </div>
      <aside className="sd-music">
        <header>
          <div>
            <span className="sd-eyebrow">配乐与音效</span>
            <b>{reel.musicLabel}</b>
          </div>
          <Music2 size={16} strokeWidth={1.5} aria-hidden />
        </header>
        <Waveform bars={musicBars} className="is-music" />
        <div className="sd-sfx">
          {['雨声', '伞骨', '心跳'].slice(0, Math.max(1, Math.min(3, reel.sfxCount))).map((name, index) => (
            <span key={name} style={{ animationDelay: `${500 + index * 180}ms` }}>
              <Volume2 size={11} strokeWidth={1.7} aria-hidden />
              {name}
            </span>
          ))}
        </div>
        <div className="sd-subtitle">
          <Captions size={13} strokeWidth={1.6} aria-hidden />
          <span>{voices[0]?.line ?? '雨声先起，钢琴只在高点出现。'}</span>
          <em className="mono">00:0{voices.length + 2}</em>
        </div>
        <div className="sd-music-note">对白、音乐、音效分别占轨；字幕逐句贴合镜头，不盖住雨声。</div>
      </aside>
    </div>
  )
}

const TRACK_COLORS: Record<StudioTrackKind, string> = {
  video: '#c8ae7d',
  dialogue: '#7fa292',
  music: '#8f9fc4',
  sfx: '#c2795f',
  subtitle: '#9c8fbc'
}

function FilmClock({
  playing,
  speed,
  total,
  durationMs
}: {
  playing: boolean
  speed: number
  total: number
  durationMs: number
}): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!playing) return undefined
    const step = (total / (durationMs / 250)) * speed
    const timer = window.setInterval(() => {
      setSeconds((value) => Math.min(total, value + step))
    }, 250)
    return () => window.clearInterval(timer)
  }, [playing, speed, total, durationMs])
  return <span>{formatTime(seconds)} / {formatTime(total)}</span>
}

function EditAct({ reel, playing, speed }: { reel: Reel; playing: boolean; speed: number }): React.JSX.Element {
  const previews = reel.shots.filter((shot) => shot.image)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    setIndex(0)
  }, [reel])
  useEffect(() => {
    if (!playing || previews.length <= 1) return undefined
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % previews.length)
    }, 2_200 / speed)
    return () => window.clearInterval(timer)
  }, [playing, speed, previews.length])
  const current = previews[index] ?? reel.shots[0]
  const px = (seconds: number): number => Math.min(100, Math.max(0, (seconds / Math.max(1, reel.seconds)) * 100))
  return (
    <div className="sd-edit">
      <div className="sd-edit-top">
        <div className="sd-monitor">
          {current?.image ? (
            <img key={current.image} src={current.image} alt={`镜 ${current.number}`} draggable={false} />
          ) : (
            <span className="sd-monitor-empty mono">{String(current?.number ?? 1).padStart(2, '0')}</span>
          )}
          <div className="sd-monitor-overlay">
            <span className="mono">镜 {String(current?.number ?? 1).padStart(2, '0')} / {reel.shots.length}</span>
            <b>{current?.title ?? '逆行的伞'}</b>
          </div>
          <span className="sd-monitor-timecode mono">
            <FilmClock playing={playing} speed={speed} total={reel.seconds} durationMs={ACTS[4].duration} />
          </span>
        </div>
        <aside className="sd-edit-checks">
          <span className="sd-eyebrow">时间线 v4 · 自动对齐</span>
          {[
            ['画面', `${reel.shots.length} 镜已就位`],
            ['对白', `${reel.voices.length} 段已贴到镜头`],
            ['音乐', reel.musicLabel ?? '已铺底'],
            ['音效', `${reel.sfxCount} 条已标记`],
            ['字幕', '逐句对齐，不压对白']
          ].map(([name, note], itemIndex) => (
            <div key={name} className="sd-edit-check" style={{ animationDelay: `${800 + itemIndex * 260}ms` }}>
              <Check size={11} strokeWidth={2.2} aria-hidden />
              <b>{name}</b>
              <span>{note}</span>
            </div>
          ))}
          <div className="sd-edit-note">改一句台词，只重排这一句；其它镜头不动。</div>
          {current ? (
            <div className="sd-current-clip">
              <span className="sd-eyebrow">当前片段</span>
              <b>镜 {String(current.number).padStart(2, '0')} · {current.title}</b>
              <span>{current.camera}</span>
              <span className="mono">{current.size} · {current.seconds}s · 无变速</span>
            </div>
          ) : null}
        </aside>
      </div>
      <div className="sd-timeline">
        <div className="sd-timeline-ruler">
          {Array.from({ length: 9 }, (_, tick) => (
            <span key={tick} className="mono" style={{ left: `${(tick / 8) * 100}%` }}>
              {formatTime((reel.seconds / 8) * tick)}
            </span>
          ))}
        </div>
        <div className="sd-timeline-body">
          {reel.tracks.map((track) => (
            <div key={`${track.kind}-${track.name}`} className="sd-track">
              <span className="sd-track-name">
                <i style={{ background: TRACK_COLORS[track.kind] }} />
                {track.name}
              </span>
              <div className="sd-track-lane">
                {track.clips.map((clip, clipIndex) => (
                  <span
                    key={`${clip.start}-${clipIndex}`}
                    className="sd-clip"
                    style={{
                      left: `${px(clip.start)}%`,
                      width: `${Math.max(1.1, px(clip.duration))}%`,
                      background: `color-mix(in srgb, ${TRACK_COLORS[track.kind]} 30%, transparent)`,
                      borderColor: `color-mix(in srgb, ${TRACK_COLORS[track.kind]} 60%, transparent)`,
                      animationDelay: `${300 + clipIndex * 55}ms`
                    }}
                    title={clip.label}
                  >
                    <em>{clip.label}</em>
                  </span>
                ))}
                <span className="sd-playhead" style={{ animationDuration: `${10_000 / speed}ms`, animationPlayState: playing ? 'running' : 'paused' }} />
              </div>
            </div>
          ))}
          {reel.tracks.length === 0 ? <div className="sd-timeline-empty">时间线正在搭建</div> : null}
        </div>
      </div>
    </div>
  )
}

function DeliveryAct({ reel }: { reel: Reel }): React.JSX.Element {
  const files = reel.deliveries.slice(0, 4)
  const hasSubtitles = files.some((file) => file.kind === 'srt' || file.kind === 'ass')
  const hasPackage = files.some((file) => file.kind === 'package' || file.kind === 'folder')
  return (
    <div className="sd-delivery">
      <div className="sd-poster">
        {reel.cover ? <img src={reel.cover} alt={`${reel.title} 封面`} draggable={false} /> : <span className="sd-poster-empty">{reel.title}</span>}
        <div className="sd-poster-scrim" />
        <div className="sd-poster-copy">
          <span className="sd-eyebrow">漫剧短片 · 成片草稿</span>
          <b>{reel.title}</b>
          <span>{reel.shots.length} 镜 · {reel.seconds} 秒 · 16:9</span>
        </div>
        <span className="sd-poster-play"><Play size={15} fill="currentColor" aria-hidden /></span>
        <span className="sd-stamp">样例交付</span>
      </div>
      <section className="sd-deliverables">
        <div className="sd-deliverables-head">
          <span className="sd-eyebrow">交付清单</span>
          <div className="sd-render">
            <span className="sd-render-ring" aria-hidden><i /></span>
            <div>
              <b>成片草稿已合成</b>
              <span className="mono">{formatTime(reel.seconds)} · 16:9</span>
            </div>
          </div>
        </div>
        <div className="sd-checks">
          {[
            `画面 ${reel.shots.length} 镜齐备`,
            `对白 ${reel.voices.length} 段已配音`,
            '音乐与音效已混音',
            '字幕逐句对齐',
            '时间线可继续修改'
          ].map((item, index) => (
            <span key={item} style={{ animationDelay: `${320 + index * 130}ms` }}>
              <Check size={11} strokeWidth={2.2} aria-hidden />
              {item}
            </span>
          ))}
        </div>
        <div className="sd-files">
          {files.map((file, index) => (
            <div key={`${file.label}-${index}`} className="sd-file" style={{ animationDelay: `${520 + index * 140}ms` }}>
              <span className="sd-file-icon">
                {file.kind.includes('srt') || file.kind.includes('ass') ? <Captions size={15} /> : file.kind === 'package' || file.kind === 'folder' ? <Package size={15} /> : <Film size={15} />}
              </span>
              <div>
                <b>{file.label}</b>
                <span className="mono">{formatBytes(file.bytes ?? 0) || '随作品导出'}</span>
              </div>
              <em className="sd-file-tag">已就绪</em>
              <ArrowRight size={13} strokeWidth={1.6} aria-hidden />
            </div>
          ))}
          {hasSubtitles ? null : (
            <div className="sd-file is-ghost" style={{ animationDelay: `${520 + files.length * 140}ms` }}>
              <span className="sd-file-icon"><Captions size={15} /></span>
              <div>
                <b>字幕 · SRT</b>
                <span>与时间线同步，逐句对齐</span>
              </div>
              <em className="sd-file-tag is-ghost">可导出</em>
            </div>
          )}
          {hasPackage ? null : (
            <div className="sd-file is-ghost" style={{ animationDelay: `${660 + files.length * 140}ms` }}>
              <span className="sd-file-icon"><Package size={15} /></span>
              <div>
                <b>工程包</b>
                <span>素材、时间线与检查记录</span>
              </div>
              <em className="sd-file-tag is-ghost">可导出</em>
            </div>
          )}
        </div>
        <div className="sd-export-specs">
          <div><span>分辨率</span><b className="mono">{reel.width}×{reel.height}</b></div>
          <div><span>帧率</span><b className="mono">{reel.fps} fps</b></div>
          <div><span>字幕</span><b>中文 · SRT</b></div>
          <div><span>画幅</span><b className="mono">16:9</b></div>
        </div>
        <div className="sd-archive-note">
          <Layers size={13} strokeWidth={1.6} aria-hidden />
          <span>工程包保留素材、时间线与检查记录；交付后仍可回到时间线修改。</span>
        </div>
      </section>
      <div className="sd-final">
        <span className="sd-final-kicker">从一句话到可交付的 {reel.seconds} 秒</span>
        <b>{reel.title}</b>
        <span>蓝图、分镜、声音、时间线与交付，都在这一个作品里。</span>
      </div>
    </div>
  )
}

function LoadingAct({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="sd-loading">
      <span className="sd-loading-mark"><Loader2 size={22} className="sd-spin" aria-hidden /></span>
      <b>{label}</b>
      <span>正在准备 12 个镜头、角色参考与时间线…</span>
      <i className="sd-loading-bar" aria-hidden />
    </div>
  )
}

export function StudioDemo(): React.JSX.Element | null {
  const demoOpen = useStudioStore((state) => state.demoOpen)
  const closeDemo = useStudioStore((state) => state.closeDemo)
  const [reel, setReel] = useState<Reel | null>(null)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready'>('idle')
  const [act, setAct] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [ended, setEnded] = useState(false)
  const [runId, setRunId] = useState(0)
  const remainingRef = useRef(0)
  const speed = useDemoSpeed(demoOpen)

  useEffect(() => {
    if (!demoOpen) return undefined
    let cancelled = false
    remainingRef.current = 0
    setAct(0)
    setPlaying(true)
    setEnded(false)
    setRunId((value) => value + 1)
    setStatus('loading')
    setReel(null)
    setProjectId(null)
    setLive(false)
    void (async () => {
      try {
        const list = await studioApi.list()
        const target =
          list.projects.find((item) => item.demo && item.kind === 'drama' && item.title === '逆行的伞') ??
          list.projects.find((item) => item.demo && item.kind === 'drama') ??
          list.projects.find((item) => item.kind === 'drama')
        if (!target) throw new Error('没有可用的漫剧样例。')
        const result = await studioApi.get(target.id)
        if (cancelled) return
        const next = buildReel(result.project)
        await preloadReel(next)
        if (cancelled) return
        setReel(next)
        setProjectId(target.id)
        setLive(true)
        setStatus('ready')
      } catch {
        if (cancelled) return
        setReel(fallbackReel())
        setStatus('ready')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [demoOpen])

  useEffect(() => {
    if (!demoOpen || status !== 'ready' || !playing || ended) return undefined
    const full = ACTS[act].duration / speed
    if (remainingRef.current <= 0) remainingRef.current = full
    const startedAt = Date.now()
    const timer = window.setTimeout(() => {
      remainingRef.current = 0
      if (act >= ACTS.length - 1) setEnded(true)
      else setAct((value) => value + 1)
    }, remainingRef.current)
    return () => {
      window.clearTimeout(timer)
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt))
    }
  }, [demoOpen, status, playing, ended, act, speed])

  const restart = (): void => {
    remainingRef.current = 0
    setAct(0)
    setEnded(false)
    setPlaying(true)
    setRunId((value) => value + 1)
  }

  useEffect(() => {
    if (!demoOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeDemo()
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        if (status === 'ready' && !ended) setPlaying((value) => !value)
        return
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        restart()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // restart only uses stable setters; status/ended are read from the latest render via this effect re-bind
  }, [demoOpen, closeDemo, status, ended])

  if (!demoOpen) return null

  const current = ACTS[act]
  const meta = reel ? `${reel.genre} · ${reel.shots.length} 镜 · ${reel.seconds} 秒` : '正在准备随包样例'
  const openSample = (): void => {
    const id = projectId
    closeDemo()
    if (id) void useStudioStore.getState().openProject(id, 'timeline')
  }

  return (
    <div
      className={['studio-demo', 'sd-reel', playing ? 'is-playing' : 'is-paused', ended ? 'is-ended' : ''].filter(Boolean).join(' ')}
      data-act={current.id}
      data-live={live ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
      aria-label="创作台制作演示"
    >
      <div className="sd-atmosphere" aria-hidden>
        <i className="sd-glow-a" />
        <i className="sd-glow-b" />
        <span className="sd-lines" />
      </div>
      <header className="sd-head">
        <div className="sd-brand">
          <StudioMark size={28} className="sd-brand-icon" />
          <div>
            <b className="mono">MORROW STUDIO</b>
            <span>制作流程演示</span>
          </div>
        </div>
        <div className="sd-head-title">
          <b>{reel?.title ?? '《逆行的伞》'}</b>
          <span className="mono">{meta}</span>
        </div>
        <div className="sd-head-actions">
          <button
            type="button"
            className="sd-icon-btn studio-demo-play"
            onClick={() => setPlaying((value) => !value)}
            disabled={status !== 'ready' || ended}
            title={playing ? '暂停演示' : '继续演示'}
            aria-label={playing ? '暂停演示' : '继续演示'}
          >
            {playing ? <Pause size={15} strokeWidth={1.5} /> : <Play size={15} strokeWidth={1.5} />}
          </button>
          <button type="button" className="sd-icon-btn sd-restart" onClick={restart} title="重新播放" aria-label="重新播放">
            <RotateCcw size={15} strokeWidth={1.5} />
          </button>
          <button type="button" className="sd-icon-btn sd-close studio-demo-close" onClick={closeDemo} title="关闭演示" aria-label="关闭演示">
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <nav className="sd-rail" aria-label="制作流程">
        {ACTS.map((item, index) => (
          <div
            key={item.id}
            className={['sd-step', index === act ? 'is-current' : '', index < act ? 'is-done' : '', ended ? 'is-done' : ''].filter(Boolean).join(' ')}
            aria-current={index === act ? 'step' : undefined}
          >
            <span className="sd-step-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="sd-step-label">{item.label}</span>
            <span className="sd-step-line"><i /></span>
          </div>
        ))}
      </nav>

      <main className="sd-stage" aria-live="polite">
        {status !== 'ready' || !reel ? (
          <LoadingAct label={`正在打开《逆行的伞》`} />
        ) : (
          <div className="sd-scene" key={`${runId}-${act}`}>
            {act === 0 ? <BriefAct reel={reel} playing={playing} /> : null}
            {act === 1 ? <BlueprintAct reel={reel} /> : null}
            {act === 2 ? <StoryboardAct reel={reel} /> : null}
            {act === 3 ? <SoundAct reel={reel} /> : null}
            {act === 4 ? <EditAct reel={reel} playing={playing} speed={speed} /> : null}
            {act === 5 ? <DeliveryAct reel={reel} /> : null}
          </div>
        )}
        {ended ? (
          <div className="sd-end">
            <span className="sd-eyebrow">演示结束 · 这不是一段视频</span>
            <b>《{reel?.title ?? '逆行的伞'}》已经躺在创作台里</b>
            <p>可以直接播放、拖片段，或者对助手说“镜 07 重做，雨向统一”。</p>
            <div className="sd-end-actions">
              <button type="button" className="sd-cta sd-open-sample" onClick={openSample} disabled={!projectId}>
                在创作台打开样例 <ArrowRight size={14} aria-hidden />
              </button>
              <button type="button" className="sd-ghost" onClick={restart}>
                再看一遍
              </button>
            </div>
          </div>
        ) : null}
      </main>

      <footer className="sd-foot">
        <div className="sd-narration">
          <span className="sd-eyebrow mono">STEP {String(act + 1).padStart(2, '0')} / 06</span>
          <b>{current.kicker}</b>
          <span>{current.caption}</span>
        </div>
        <div className="sd-progress-wrap">
          <div className="sd-progress">
            <i
              key={`${runId}-${act}`}
              style={{
                animationDuration: `${current.duration / speed}ms`,
                animationPlayState: playing ? 'running' : 'paused'
              }}
            />
          </div>
          <span className="sd-time mono">
            演示 <DemoClock act={act} playing={playing} speed={speed} ended={ended} /> / {formatTime(TOTAL_MS / 1000)}
          </span>
        </div>
        <div className="sd-foot-meta">
          {live ? '随包样例 · 真实数据' : status === 'ready' ? '离线演示脚本' : '准备中'}
        </div>
      </footer>
    </div>
  )
}

function ProjectSwitcher(): React.JSX.Element {
  const view = useStudioStore((state) => state.view)
  const active = useStudioStore((state) => state.active)
  const projects = useStudioStore((state) => state.projects)
  const openProject = useStudioStore((state) => state.openProject)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div className="studio-project-switch" ref={ref}>
      <button
        type="button"
        className="studio-project-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={active && view !== 'home' ? '切换作品' : '打开作品列表'}
      >
        {active && view !== 'home' ? <KindBadge kind={active.kind} /> : null}
        <span className="studio-project-name truncate">{view === 'home' ? '作品库' : active?.title ?? '作品库'}</span>
        <ChevronDown size={12} strokeWidth={1.6} aria-hidden />
      </button>
      {open ? (
        <div className="studio-popover studio-project-menu" role="menu">
          <div className="studio-menu-block">
            <span className="studio-menu-label">最近作品</span>
            {projects.slice(0, 6).map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className={project.id === active?.id ? 'is-current' : ''}
                onClick={() => {
                  setOpen(false)
                  void openProject(project.id)
                }}
              >
                <CoverThumb summary={project} size="sm" />
                <span className="studio-menu-project">
                  <b>{project.title}</b>
                  <em>{project.progress}% · {project.words ? `${(project.words / 10000).toFixed(1)} 万字` : project.shots ? `${project.shots} 镜` : '新作品'}</em>
                </span>
                <i className="studio-menu-progress"><span style={{ width: `${project.progress}%` }} /></i>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LeftPanel(): React.JSX.Element {
  const active = useStudioStore((state) => state.active)
  const setView = useStudioStore((state) => state.setView)
  const engine = useStudioStore((state) => state.engine)
  const notify = useStudioStore((state) => state.notify)
  const openProjectDir = async (): Promise<void> => {
    if (!active) return
    try {
      await studioApi.openProjectDir(active.id)
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
  }
  if (!active) return <aside className="studio-left" />
  const seconds = active.timeline.durationSec
  const words = active.chapters.reduce((sum, chapter) => sum + chapter.content.replace(/\s+/g, '').length, 0)
  const assetPreview = active.assets.filter((asset) => asset.kind === 'image').slice(0, 6)
  return (
    <aside className="studio-left studio-stage-column">
      <div className="studio-left-head">
        <span className="studio-eyebrow">当前作品</span>
        <CoverThumb project={active} size="md" />
        <h2 className="truncate" title={active.title}>{active.title}</h2>
        <div className="studio-left-sub">
          <KindBadge kind={active.kind} />
          <span>{active.kind === 'drama' ? `${active.shots.length} 镜 · ${Math.round(seconds)} 秒` : `${active.chapters.length} 章 · ${(words / 10000).toFixed(1)} 万字`}</span>
        </div>
        <div className="studio-left-progress">
          <span style={{ width: `${Math.min(100, Math.max(4, projectProgress(active)))}%` }} />
        </div>
      </div>
      <StageRail />
      <div className="studio-left-assets">
        <div className="studio-left-assets-head">
          <span className="studio-menu-label">素材</span>
          <em>{active.assets.length}</em>
        </div>
        {assetPreview.length ? (
          <div className="studio-asset-grid">
            {assetPreview.map((asset) => (
              <span key={asset.id} className="studio-asset-cell" title={asset.title}>
                <img src={asset.thumbUrl ?? asset.url} alt="" loading="lazy" />
                {asset.tags.includes('cover') ? <i>封面</i> : null}
              </span>
            ))}
          </div>
        ) : (
          <p className="studio-left-empty">还没有素材。可以在画面或交付页导入。</p>
        )}
        <button type="button" className="studio-left-import" onClick={() => setView(active.kind === 'drama' ? 'storyboard' : 'writing')}>
          <Plus size={12} /> 去添加素材
        </button>
      </div>
      <div className="studio-left-foot">
        <button type="button" onClick={() => void openProjectDir()}><FolderOpen size={13} /> 打开作品文件夹</button>
        <span className="studio-local-note">
          <i className={engine?.ffmpeg.available ? 'is-on' : ''} /> {engine?.ffmpeg.available ? '视频合成可用' : '视频合成未就绪'} ·
          <i className={engine?.media.imageReady ? 'is-on' : ''} /> 画面生成
        </span>
      </div>
    </aside>
  )
}

function projectProgress(project: NonNullable<ReturnType<typeof useStudioStore.getState>['active']>): number {
  const summary = useStudioStore.getState().projects.find((item) => item.id === project.id)
  return summary?.progress ?? (project.kind === 'drama' ? 0 : 0)
}

function WindowControls(): React.JSX.Element {
  const maximized = useAppStore((state) => state.windowState.maximized)
  return (
    <div className="studio-window-controls" role="group" aria-label="窗口控制">
      <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => void window.morrow.window.minimize()}><Minus size={14} strokeWidth={1.4} /></button>
      <button type="button" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => void window.morrow.window.toggleMaximize()}>
        {maximized ? <span className="studio-restore-icon" /> : <Square size={11.5} strokeWidth={1.4} />}
      </button>
      <button type="button" className="is-close" aria-label="关闭窗口" title="关闭" onClick={() => void window.morrow.window.close()}><X size={14} strokeWidth={1.4} /></button>
    </div>
  )
}

export function StudioApp(): React.JSX.Element | null {
  const open = useStudioStore((state) => state.open)
  const booted = useStudioStore((state) => state.booted)
  const loading = useStudioStore((state) => state.loading)
  const view = useStudioStore((state) => state.view)
  const active = useStudioStore((state) => state.active)
  const assistantOpen = useStudioStore((state) => state.assistantOpen)
  const setAssistantOpen = useStudioStore((state) => state.setAssistantOpen)
  const leftWidth = useStudioStore((state) => state.leftWidth)
  const rightWidth = useStudioStore((state) => state.rightWidth)
  const setLeftWidth = useStudioStore((state) => state.setLeftWidth)
  const setRightWidth = useStudioStore((state) => state.setRightWidth)
  const closeStudio = useStudioStore((state) => state.closeStudio)
  const openStudio = useStudioStore((state) => state.openStudio)
  const bootstrap = useStudioStore((state) => state.bootstrap)
  const setView = useStudioStore((state) => state.setView)
  const run = useStudioStore((state) => state.run)
  const notify = useStudioStore((state) => state.notify)
  const handleEvent = useStudioStore((state) => state.handleEvent)
  const refreshActive = useStudioStore((state) => state.refreshActive)
  const focusMode = useStudioStore((state) => state.focusMode)
  const setFocusMode = useStudioStore((state) => state.setFocusMode)
  const demoOpen = useStudioStore((state) => state.demoOpen)
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)
  const settingsOpen = useStudioStore((state) => state.settingsOpen)
  const setSettingsOpen = useStudioStore((state) => state.setSettingsOpen)
  const [settingsTab, setSettingsTab] = useState<StudioSettingsTab>('models')
  const [settingsFocus, setSettingsFocus] = useState<'budget' | undefined>(undefined)
  const selectedShotId = useStudioStore((state) => state.selectedShotId)
  const selectShot = useStudioStore((state) => state.selectShot)
  const timelineInspectorOpen = useStudioStore((state) => state.timelineInspectorOpen)
  const setTimelineInspectorOpen = useStudioStore((state) => state.setTimelineInspectorOpen)
  const factsOpen = useStudioStore((state) => state.factsOpen)
  const setFactsOpen = useStudioStore((state) => state.setFactsOpen)
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 打开时先取作品库；关闭时保留上下文，下一次继续。
  useEffect(() => {
    if (open && !booted) void bootstrap()
  }, [open, booted, bootstrap])

  // 主进程任务事件 -> 本地状态。兜底轮询防止事件因窗口刷新丢失。
  useEffect(() => {
    if (!open) return
    const off = studioApi.onEvent(handleEvent)
    return off
  }, [open, handleEvent])

  // 灵动岛：创作台打开时显示作品与当前任务，关闭后恢复跟随 Agent 会话。
  useEffect(() => {
    if (!open) {
      void window.morrow.island.syncStudio({ active: false })
      return
    }
    const ordered = [...(active?.jobs ?? [])].sort((a, b) => b.createdAt - a.createdAt)
    const activeJob = ordered.find((job) => job.status === 'queued' || job.status === 'running')
    const recentDone = ordered.find((job) => (job.status === 'done' || job.status === 'failed') && Date.now() - (job.finishedAt ?? job.updatedAt) < 10 * 60_000)
    const shown = activeJob ?? recentDone
    void window.morrow.island.syncStudio({
      active: true,
      projectId: active?.id ?? null,
      projectTitle: active?.title ?? '作品库',
      ...(active?.kind ? { kind: active.kind } : {}),
      stage: active?.stage ?? view,
      ...(shown?.label ? { jobLabel: shown.label } : {}),
      jobProgress: shown?.progress ?? null,
      ...(shown?.status ? { jobStatus: shown.status } : {}),
      startedAt: activeJob?.startedAt ?? null,
      jobs: ordered.length
    })
  }, [open, active?.id, active?.title, active?.kind, active?.stage, view, active?.jobs])

  useEffect(() => {
    if (!open || !active) return
    const activeJobs = active.jobs.some((job) => job.status === 'running' || job.status === 'queued')
    if (!activeJobs) return
    const timer = window.setInterval(() => {
      void refreshActive(true)
    }, 2_600)
    return () => window.clearInterval(timer)
  }, [open, active, refreshActive])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const state = useStudioStore.getState()
      if (state.guideOpen || state.demoOpen) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (document.querySelector('.modal-layer, .modal-panel')) return
      if (focusMode) {
        event.preventDefault()
        setFocusMode(false)
        return
      }
      if (useStudioStore.getState().factsOpen) {
        event.preventDefault()
        setFactsOpen(false)
        return
      }
      if (view === 'home') {
        event.preventDefault()
        closeStudio()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, focusMode, setFocusMode, setFactsOpen, view, closeStudio])

  if (!open) return null

  const hasActive = Boolean(active)
  const isHome = view === 'home'
  const openSettingsAt = (next: StudioSettingsTab, focus?: 'budget'): void => {
    setSettingsTab(next)
    setSettingsFocus(focus)
    setSettingsOpen(true)
  }
  const newProject = (): void => {
    setView('home')
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.studio-logline-input')?.focus(), 140)
  }
  const hideLeftForWriting = view === 'writing' && !focusMode
  const hideLeftForHome = view === 'home' && !focusMode
  const hideLeftForCanvas = view === 'canvas'
  const hideLeft = hideLeftForWriting || hideLeftForHome || hideLeftForCanvas
  const storyboardInspecting = view === 'storyboard' && Boolean(selectedShotId)
  const timelineInspecting = view === 'timeline' && timelineInspectorOpen
  const writingFacts = view === 'writing' && factsOpen
  const showAssistant = hasActive && assistantOpen && view !== 'home' && view !== 'canvas' && !focusMode && !storyboardInspecting && !timelineInspecting && !writingFacts
  const mainMinWidth = 560
  const leftMaxWidth = Math.max(
    STUDIO_LEFT_MIN,
    Math.min(STUDIO_LEFT_MAX, viewportWidth - (showAssistant ? rightWidth : 0) - mainMinWidth)
  )
  const rightMaxWidth = Math.max(
    STUDIO_RIGHT_MIN,
    Math.min(STUDIO_RIGHT_MAX, viewportWidth - (hideLeft ? 0 : leftWidth) - mainMinWidth)
  )
  const toggleRightPanel = (): void => {
    if (writingFacts) {
      setFactsOpen(false)
      setAssistantOpen(true)
      return
    }
    if (storyboardInspecting) {
      selectShot(null)
      setAssistantOpen(true)
      return
    }
    if (timelineInspecting) {
      setTimelineInspectorOpen(false)
      setAssistantOpen(true)
      return
    }
    setAssistantOpen(!assistantOpen)
  }

  return (
    <div className={`studio-root ${focusMode ? 'is-focus-mode' : ''} ${demoOpen ? 'is-demo' : ''}`} ref={containerRef}>
      <div className="studio-ambient" aria-hidden>
        <span className="studio-ambient-a" />
        <span className="studio-ambient-b" />
        <span className="studio-ambient-grid" />
      </div>
      <header className="studio-topbar">
        {active && !isHome ? (
          <button type="button" className="studio-home-link" onClick={() => setView('home')} title="回到作品库">作品库</button>
        ) : null}
        <ProjectSwitcher />
        {active && !isHome ? (
          <button type="button" className="studio-new-link" title="新建作品" aria-label="新建作品" onClick={newProject}>
            <FilePlus2 size={12} strokeWidth={1.5} /> 新建作品
          </button>
        ) : null}
        {active?.kind === 'drama' && view !== 'canvas' && !isHome ? (
          <button type="button" className="studio-canvas-link" onClick={() => setView('canvas')} title="打开漫剧工作流画布">画布</button>
        ) : null}
        {active && active.kind !== 'drama' && !isHome ? (
          <button
            type="button"
            className="studio-canvas-link"
            title="把已写正文改编为漫剧镜头计划"
            onClick={() => {
              void (async () => {
                const result = await run<{ message?: string }>('adapt-to-drama', {})
                notify('success', result.message ?? '已改编为漫剧。')
                setView('storyboard')
              })()
            }}
          >
            改成漫剧
          </button>
        ) : null}
        <div className="studio-topbar-spacer" />
        {active && !isHome ? (
          <div className="studio-budget" title="项目预算：已记录 / 上限">
            <span className="mono">¥{active.runtime.budget.spent.toFixed(2)}</span>
            <i>/</i>
            <span className="mono">{active.runtime.budget.limit ? `¥${active.runtime.budget.limit}` : '不限'}</span>
            <button type="button" onClick={() => openSettingsAt('models', 'budget')}>预算</button>
          </div>
        ) : null}
        <button type="button" className="studio-top-icon" title="创作台设置" aria-label="创作台设置" onClick={() => openSettingsAt('models')}>
          <SlidersHorizontal size={15} strokeWidth={1.5} />
        </button>
        <button type="button" className="studio-top-icon" title={theme === 'dark' ? '切换到浅色' : '切换到深色'} aria-label="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={15} strokeWidth={1.5} /> : <Moon size={15} strokeWidth={1.5} />}
        </button>
        {hasActive && view !== 'home' && view !== 'canvas' ? (
          <button type="button" className={['studio-top-icon', showAssistant ? 'is-active' : ''].filter(Boolean).join(' ')} title={showAssistant ? '收起协作者' : '展开协作者'} aria-label="切换协作者面板" onClick={toggleRightPanel}>
            <PanelRight size={15} strokeWidth={1.5} />
          </button>
        ) : null}
        <button type="button" className="studio-exit" onClick={closeStudio} title="退出，回到 Agent">
          回到 Agent
        </button>
        <WindowControls />
      </header>

      <div
        className={`studio-body ${showAssistant ? 'has-assistant' : ''} ${hideLeft ? 'no-left' : ''}`}
        style={{ '--studio-left': `${leftWidth}px`, '--studio-right': `${rightWidth}px` } as CSSProperties}
      >
        {!hideLeft ? <LeftPanel /> : null}
        {!hideLeft ? (
          <ResizeHandle
            value={leftWidth}
            min={STUDIO_LEFT_MIN}
            max={leftMaxWidth}
            edge="right"
            className="studio-left-resizer"
            label="拖动调整左侧栏宽度（方向键微调，双击恢复 240px）"
            onChange={(width) => setLeftWidth(width)}
            onCommit={(width) => setLeftWidth(width, true)}
            onReset={() => setLeftWidth(240, true)}
          />
        ) : null}
        <main className="studio-center">
          <JobProgressBanner />
          {!booted && loading ? (
            <div className="studio-loading">
              <Loader2 size={22} className="studio-spin" />
              <span>正在打开…</span>
            </div>
          ) : view === 'home' ? (
            <HomeView />
          ) : !active ? (
            <div className="studio-loading">
              <span>没有打开的作品。</span>
              <button type="button" onClick={() => setView('home')}>回到作品库</button>
            </div>
          ) : view === 'blueprint' ? (
            <BlueprintView onOpenBudget={() => openSettingsAt('models', 'budget')} />
          ) : view === 'writing' ? (
            <WritingView />
          ) : view === 'storyboard' ? (
            <StoryboardView />
          ) : view === 'canvas' ? (
            <CanvasView />
          ) : view === 'timeline' ? (
            <TimelineView />
          ) : view === 'review' ? (
            <ReviewView />
          ) : (
            <DeliveryView />
          )}
        </main>
        {showAssistant ? (
          <ResizeHandle
            value={rightWidth}
            min={STUDIO_RIGHT_MIN}
            max={rightMaxWidth}
            edge="left"
            className="studio-right-resizer"
            label="拖动调整协作者宽度（方向键微调，双击恢复 420px）"
            onChange={(width) => setRightWidth(width)}
            onCommit={(width) => setRightWidth(width, true)}
            onReset={() => setRightWidth(420, true)}
          />
        ) : null}
        {showAssistant ? <AssistantPanel /> : null}
      </div>
      {demoOpen ? null : <NoticeBar />}
      <StudioSettingsDialog open={settingsOpen} onClose={() => { setSettingsOpen(false); setSettingsFocus(undefined) }} initialTab={settingsTab} initialFocus={settingsFocus} />
      <StudioGuide />
      <StudioDemo />
      {open && loading ? <div className="studio-busy-line" aria-hidden /> : null}
    </div>
  )
}
