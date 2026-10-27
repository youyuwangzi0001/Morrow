import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ChevronDown,
  SlidersHorizontal,
  FilePlus2,
  FolderOpen,
  Loader2,
  Minus,
  PanelRight,
  Plus,
  Square,
  Sun,
  Moon,
  X
} from 'lucide-react'
import { studioApi } from './api'
import { STUDIO_LEFT_MAX, STUDIO_LEFT_MIN, STUDIO_RIGHT_MAX, STUDIO_RIGHT_MIN, useStudioStore } from './studio-store'
import { useAppStore } from '../../store'
import { ResizeHandle } from '../../ui'
import {
  CoverThumb,
  JobProgressBanner,
  KindBadge,
  NoticeBar,
  StageIcon,
  StageRail,
  StudioProgress
} from './components'
import { HomeView } from './HomeView'
import { BlueprintView } from './BlueprintView'
import { WritingView } from './WritingView'
import { StoryboardView } from './StoryboardView'
import { CanvasView } from './CanvasView'
import { TimelineView } from './TimelineView'
import { ReviewView } from './ReviewView'
import { DeliveryView } from './DeliveryView'
import { AssistantPanel } from './AssistantPanel'
import { StudioSettingsDialog, type StudioSettingsTab } from './StudioSettingsDialog'
import { StudioGuide } from './StudioGuide'
import { StudioDemo } from './StudioDemo'
import './studio.css'
import './studio-writing.css'
import './studio-storyboard.css'
import './studio-canvas.css'
import './studio-timeline.css'
import './studio-review-delivery.css'
import './studio-assistant.css'
import './studio-demo.css'

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
