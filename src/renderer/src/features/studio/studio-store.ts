import { create } from 'zustand'
import type {
  StudioActionResult,
  StudioCreateInput,
  StudioEditPlan,
  StudioEngineStatus,
  StudioEvent,
  StudioExportInput,
  StudioJob,
  StudioProject,
  StudioProjectSummary,
  StudioRenderInput,
  StudioStageId
} from '@shared/studio'
import { studioStages } from '@shared/studio'
import { studioApi } from './api'

export type StudioView = 'home' | 'blueprint' | 'writing' | 'storyboard' | 'canvas' | 'timeline' | 'review' | 'delivery'
export type StudioLibraryFilter = 'all' | 'recent' | 'short' | 'novel' | 'drama' | 'templates'
export type StoryboardTab = 'script' | 'board'
export type TimelineFocus = 'video' | 'dialogue' | 'music' | 'sfx' | 'subtitle'

interface StudioNotice {
  kind: 'info' | 'success' | 'error'
  text: string
  at: number
}

interface StudioState {
  open: boolean
  booted: boolean
  loading: boolean
  busy: boolean
  assistantBusy: boolean
  guideOpen: boolean
  demoOpen: boolean
  projects: StudioProjectSummary[]
  engine: StudioEngineStatus | null
  active: StudioProject | null
  view: StudioView
  libraryFilter: StudioLibraryFilter
  search: string
  assistantOpen: boolean
  leftWidth: number
  rightWidth: number
  settingsOpen: boolean
  timelineInspectorOpen: boolean
  outlineOpen: boolean
  factsOpen: boolean
  focusMode: boolean
  storyboardTab: StoryboardTab
  timelineFocus: TimelineFocus
  focusedStage: StudioStageId | null
  selectedChapterId: string | null
  selectedShotId: string | null
  selectedClipId: string | null
  editorDirty: boolean
  saveState: 'saved' | 'saving' | 'error'
  notice: StudioNotice | null
  lastEventAt: number

  openStudio: () => Promise<void>
  closeStudio: () => void
  openGuide: () => void
  closeGuide: () => void
  openDemo: () => void
  closeDemo: () => void
  bootstrap: (force?: boolean) => Promise<void>
  refreshLibrary: () => Promise<void>
  refreshEngine: () => Promise<void>
  openProject: (id: string, view?: StudioView) => Promise<void>
  refreshActive: (silent?: boolean) => Promise<void>
  createProject: (input: StudioCreateInput) => Promise<StudioProject>
  deleteProject: (id: string) => Promise<void>
  duplicateProject: (id: string) => Promise<void>
  updateProject: (patch: { title?: string; logline?: string; brief?: Record<string, unknown>; runtime?: Record<string, unknown>; stage?: StudioStageId }) => Promise<void>
  run: <T = StudioActionResult>(type: string, payload?: Record<string, unknown>) => Promise<T>
  sendAssistant: (text: string) => Promise<void>
  applyPlan: (planId: string) => Promise<void>
  cancelPlan: (planId: string) => Promise<void>
  cancelJob: (jobId: string) => Promise<void>
  importAssets: (kind: 'image' | 'video' | 'audio', shotId?: string) => Promise<void>
  render: (input: Omit<StudioRenderInput, 'projectId'>) => Promise<void>
  exportProject: (format: StudioExportInput['format']) => Promise<void>
  setView: (view: StudioView) => void
  navigateStage: (stage: StudioStageId) => void
  setLibraryFilter: (filter: StudioLibraryFilter) => void
  setSearch: (search: string) => void
  setAssistantOpen: (open: boolean) => void
  setLeftWidth: (width: number, persist?: boolean) => void
  setRightWidth: (width: number, persist?: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setTimelineInspectorOpen: (open: boolean) => void
  setOutlineOpen: (open: boolean) => void
  setFactsOpen: (open: boolean) => void
  setFocusMode: (on: boolean) => void
  setStoryboardTab: (tab: StoryboardTab) => void
  setTimelineFocus: (focus: TimelineFocus) => void
  selectChapter: (id: string) => void
  selectShot: (id: string | null) => void
  selectClip: (id: string | null) => void
  setEditorDirty: (dirty: boolean) => void
  setSaveState: (state: 'saved' | 'saving' | 'error') => void
  notify: (kind: StudioNotice['kind'], text: string) => void
  clearNotice: () => void
  handleEvent: (event: StudioEvent) => void
}

function viewForStage(kind: StudioProject['kind'], stage: StudioStageId): StudioView {
  if (stage === 'blueprint') return 'blueprint'
  if (stage === 'writing' || stage === 'outline') return kind === 'drama' ? 'storyboard' : 'writing'
  if (stage === 'storyboard' || stage === 'visuals' || stage === 'voice') return 'storyboard'
  if (stage === 'music' || stage === 'timeline') return 'timeline'
  if (stage === 'review') return 'review'
  if (stage === 'delivery') return 'delivery'
  return 'home'
}

function pickChapter(project: StudioProject, preferred?: string | null): string | null {
  if (preferred && project.chapters.some((chapter) => chapter.id === preferred)) {
    const current = project.chapters.find((chapter) => chapter.id === preferred)
    if (current && (current.content.trim() || current.candidates.length)) return preferred
  }
  const pending = project.chapters.find((chapter) => chapter.candidates.length > 0)
  if (pending) return pending.id
  const written = [...project.chapters].filter((chapter) => chapter.content.trim()).sort((a, b) => b.number - a.number)[0]
  if (written) return written.id
  return project.chapters[0]?.id ?? null
}

function pickShot(project: StudioProject, preferred?: string | null): string | null {
  if (preferred && project.shots.some((shot) => shot.id === preferred)) return preferred
  const missing = project.shots.find((shot) => !shot.imageAssetId && !shot.videoAssetId)
  return (missing ?? project.shots[0])?.id ?? null
}

function mergeSummary(list: StudioProjectSummary[], summary: StudioProjectSummary): StudioProjectSummary[] {
  const index = list.findIndex((item) => item.id === summary.id)
  if (index < 0) return [summary, ...list]
  const next = [...list]
  next[index] = { ...next[index], ...summary }
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let lastLoadedProject = ''
try {
  lastLoadedProject = localStorage.getItem('morrow.studio.project') ?? ''
} catch {
  lastLoadedProject = ''
}

function studioGuideSeen(): boolean {
  try {
    return localStorage.getItem('morrow.studio.guideSeen') === '1'
  } catch {
    return true
  }
}

function markStudioGuideSeen(): void {
  try {
    localStorage.setItem('morrow.studio.guideSeen', '1')
  } catch {
    // 本地存储不可用时只在本次会话内记住
  }
}

export const STUDIO_LEFT_MIN = 200
export const STUDIO_LEFT_MAX = 360
export const STUDIO_RIGHT_MIN = 340
export const STUDIO_RIGHT_MAX = 640

function studioWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const stored = Number(localStorage.getItem(key))
    if (Number.isFinite(stored) && stored > 0) return Math.min(max, Math.max(min, Math.round(stored)))
  } catch {
    // 本地存储不可用时使用默认宽度
  }
  return fallback
}

function saveStudioWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(width))
  } catch {
    // 本地存储不可用时只在本次会话内生效
  }
}

export const useStudioStore = create<StudioState>()((set, get) => ({
  open: false,
  booted: false,
  loading: false,
  busy: false,
  assistantBusy: false,
  guideOpen: false,
  demoOpen: false,
  projects: [],
  engine: null,
  active: null,
  view: 'home',
  libraryFilter: 'all',
  search: '',
  assistantOpen: true,
  leftWidth: studioWidth('morrow.studio.leftWidth', 240, STUDIO_LEFT_MIN, STUDIO_LEFT_MAX),
  rightWidth: studioWidth('morrow.studio.rightWidth', 420, STUDIO_RIGHT_MIN, STUDIO_RIGHT_MAX),
  settingsOpen: false,
  timelineInspectorOpen: false,
  outlineOpen: true,
  factsOpen: false,
  focusMode: false,
  storyboardTab: 'board',
  timelineFocus: 'video',
  focusedStage: null,
  selectedChapterId: null,
  selectedShotId: null,
  selectedClipId: null,
  editorDirty: false,
  saveState: 'saved',
  notice: null,
  lastEventAt: 0,

  async openStudio() {
    set({ open: true, guideOpen: !studioGuideSeen() })
    if (!get().booted) {
      await get().bootstrap()
    } else if (!get().active) {
      const wanted = lastLoadedProject
      if (wanted && get().projects.some((project) => project.id === wanted)) {
        try {
          await get().openProject(wanted)
        } catch {
          set({ view: 'home' })
        }
      } else {
        set({ view: 'home' })
      }
    } else {
      void get().refreshActive(true)
    }
  },

  closeStudio() {
    set({ open: false, focusMode: false, factsOpen: false, demoOpen: false })
  },

  openGuide() {
    set({ guideOpen: true, demoOpen: false })
  },

  closeGuide() {
    markStudioGuideSeen()
    set({ guideOpen: false })
  },

  openDemo() {
    markStudioGuideSeen()
    set({ demoOpen: true, guideOpen: false })
  },

  closeDemo() {
    set({ demoOpen: false })
  },

  async bootstrap(force = false) {
    if (get().loading) return
    if (get().booted && !force) return
    set({ loading: true })
    try {
      const result = await studioApi.list()
      set({ projects: result.projects, engine: result.engine, booted: true })
      const current = get().active
      if (current) {
        const exists = result.projects.some((project) => project.id === current.id)
        if (!exists) set({ active: null, view: 'home' })
        else await get().refreshActive(true)
      } else {
        const wanted = lastLoadedProject
        if (wanted && result.projects.some((project) => project.id === wanted)) {
          try {
            await get().openProject(wanted)
          } catch {
            set({ view: 'home' })
          }
        } else {
          set({ view: 'home' })
        }
      }
    } catch (err) {
      get().notify('error', errorMessage(err))
    } finally {
      set({ loading: false })
    }
  },

  async refreshLibrary() {
    try {
      const result = await studioApi.list()
      set({ projects: result.projects, engine: result.engine, booted: true })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async refreshEngine() {
    try {
      const engine = await studioApi.status()
      set({ engine })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async openProject(id, view) {
    set({ loading: true })
    try {
      const result = await studioApi.get(id)
      const project = result.project
      const stageView = view ?? viewForStage(project.kind, project.stage)
      const selectedChapterId = pickChapter(project, get().selectedChapterId)
      set({
        active: project,
        view: stageView,
        selectedChapterId,
        selectedShotId: null,
        selectedClipId: null,
        timelineInspectorOpen: false,
        editorDirty: false,
        saveState: 'saved',
        storyboardTab: project.kind === 'drama' && project.shots.every((shot) => shot.imageAssetId || shot.videoAssetId) ? 'board' : project.kind === 'drama' ? 'script' : 'board',
        focusedStage: project.stage
      })
      try {
        localStorage.setItem('morrow.studio.project', project.id)
      } catch {
      }
    } catch (err) {
      get().notify('error', errorMessage(err))
      set({ view: 'home' })
      throw err
    } finally {
      set({ loading: false })
    }
  },

  async refreshActive(silent = false) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.get(active.id)
      const project = result.project
      set((state) => ({
        active: project,
        projects: mergeSummary(state.projects, {
          id: project.id,
          kind: project.kind,
          title: project.title,
          logline: project.logline,
          updatedAt: project.updatedAt,
          createdAt: project.createdAt,
          stage: project.stage,
          progress: state.projects.find((item) => item.id === project.id)?.progress ?? 0,
          words: state.projects.find((item) => item.id === project.id)?.words ?? 0,
          chapters: project.chapters.length,
          shots: project.shots.length,
          assets: project.assets.length,
          budget: project.runtime.budget,
          ...(project.coverAssetId ? { coverUrl: project.assets.find((asset) => asset.id === project.coverAssetId)?.thumbUrl ?? project.assets.find((asset) => asset.id === project.coverAssetId)?.url } : {}),
          demo: project.demo,
          missingVisuals: project.shots.filter((shot) => !shot.imageAssetId && !shot.videoAssetId).length
        }),
        selectedChapterId: pickChapter(project, state.selectedChapterId),
        selectedShotId: state.selectedShotId && project.shots.some((shot) => shot.id === state.selectedShotId)
          ? state.selectedShotId
          : null,
        selectedClipId: state.selectedClipId && project.timeline.clips.some((clip) => clip.id === state.selectedClipId)
          ? state.selectedClipId
          : null
      }))
    } catch (err) {
      if (!silent) get().notify('error', errorMessage(err))
    }
  },

  async createProject(input) {
    set({ busy: true })
    try {
      const result = await studioApi.create(input)
      const project = result.project
      set({
        active: project,
        view: 'blueprint',
        selectedChapterId: null,
        selectedShotId: null,
        selectedClipId: null,
        storyboardTab: 'script'
      })
      try {
        localStorage.setItem('morrow.studio.project', project.id)
      } catch {
      }
      await get().refreshLibrary()
      return project
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ busy: false })
    }
  },

  async deleteProject(id) {
    set({ busy: true })
    try {
      await studioApi.action('delete', { projectId: id })
      const projects = get().projects.filter((project) => project.id !== id)
      const active = get().active
      set({ projects, ...(active?.id === id ? { active: null, view: 'home' as StudioView } : {}) })
      get().notify('success', '作品已移入回收目录，可手动恢复。')
      await get().refreshLibrary()
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ busy: false })
    }
  },

  async duplicateProject(id) {
    set({ busy: true })
    try {
      const result = await studioApi.action('duplicate', { projectId: id })
      await get().refreshLibrary()
      await get().openProject(result.project.id)
      get().notify('success', '已复制一个作品。')
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ busy: false })
    }
  },

  async updateProject(patch) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.action('update-meta', { projectId: active.id, ...patch })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  async run<T = StudioActionResult>(type: string, payload: Record<string, unknown> = {}) {
    const active = get().active
    try {
      const result = await studioApi.action<T>(type, { ...payload, ...(active ? { projectId: active.id } : {}) })
      const typed = result as unknown as StudioActionResult
      if (typed?.project) {
        set((state) => ({
          active: typed.project,
          selectedChapterId: pickChapter(typed.project, state.selectedChapterId),
          selectedShotId: pickShot(typed.project, state.selectedShotId),
          selectedClipId: state.selectedClipId && typed.project.timeline.clips.some((clip) => clip.id === state.selectedClipId)
            ? state.selectedClipId
            : typed.project.timeline.clips[0]?.id ?? null
        }))
      }
      return result
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  async sendAssistant(text) {
    const active = get().active
    if (!active) return
    const selection = (() => {
      const state = get()
      if (state.selectedClipId) return { kind: 'clip' as const, id: state.selectedClipId }
      if (state.view === 'writing' && state.selectedChapterId) return { kind: 'chapter' as const, id: state.selectedChapterId }
      if (state.selectedShotId) return { kind: 'shot' as const, id: state.selectedShotId }
      return undefined
    })()
    set({ assistantBusy: true })
    try {
      const result = await studioApi.assistant({ projectId: active.id, text, ...(selection ? { selection } : {}) })
      set({ active: result.project })
      if (result.message) get().notify('info', result.message)
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ assistantBusy: false })
    }
  },

  async applyPlan(planId) {
    const active = get().active
    if (!active) return
    set({ assistantBusy: true })
    try {
      const result = await studioApi.action('apply-plan', { projectId: active.id, planId })
      set({ active: result.project })
      if (result.job) get().notify('info', '计划已应用，重做任务已排队。')
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    } finally {
      set({ assistantBusy: false })
    }
  },

  async cancelPlan(planId) {
    const active = get().active
    if (!active) return
    try {
      await studioApi.action('cancel-plan', { projectId: active.id, planId })
      await get().refreshActive(true)
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async cancelJob(jobId) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.action('cancel-job', { projectId: active.id, jobId })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async importAssets(kind, shotId) {
    const active = get().active
    if (!active) return
    try {
      const paths = await studioApi.pickImport(kind, { title: kind === 'image' ? '导入画面' : kind === 'video' ? '导入视频' : '导入音频' })
      for (const path of paths) {
        const result = await studioApi.action('import-asset', {
          projectId: active.id,
          path,
          ...(shotId ? { shotId } : {})
        })
        set({ active: result.project })
      }
      if (paths.length) get().notify('success', `已导入 ${paths.length} 个素材。`)
    } catch (err) {
      get().notify('error', errorMessage(err))
    }
  },

  async render(input) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.render({ ...input, projectId: active.id })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  async exportProject(format) {
    const active = get().active
    if (!active) return
    try {
      const result = await studioApi.exportProject({ projectId: active.id, format })
      set({ active: result.project })
    } catch (err) {
      get().notify('error', errorMessage(err))
      throw err
    }
  },

  setView(view) {
    const stage: StudioStageId | null = view === 'home' ? null : view === 'blueprint' ? 'blueprint' : view === 'writing' ? 'writing' : view === 'storyboard' ? 'storyboard' : view === 'timeline' ? 'timeline' : view === 'review' ? 'review' : view === 'delivery' ? 'delivery' : null
    set({ view, focusMode: false, ...(stage ? { focusedStage: stage } : {}) })
  },

  navigateStage(stage) {
    const active = get().active
    if (!active) return
    const stageView = viewForStage(active.kind, stage)
    set({
      view: stageView,
      focusedStage: stage,
      focusMode: false,
      ...(stage !== 'storyboard' && stage !== 'visuals' && stage !== 'voice' ? { selectedShotId: null } : {}),
      ...(stage !== 'timeline' && stage !== 'music' ? { timelineInspectorOpen: false } : {}),
      ...(stage === 'outline' && active.kind === 'drama' ? { storyboardTab: 'script' as StoryboardTab } : {}),
      ...(stage === 'music' ? { timelineFocus: 'music' as TimelineFocus } : {}),
      ...(stage === 'voice' ? { timelineFocus: 'dialogue' as TimelineFocus } : {})
    })
  },

  setLibraryFilter(filter) {
    set({ libraryFilter: filter })
  },
  setSearch(search) {
    set({ search })
  },
  setAssistantOpen(open) {
    set({ assistantOpen: open })
  },

  setLeftWidth(width, persist = false) {
    const next = Math.min(STUDIO_LEFT_MAX, Math.max(STUDIO_LEFT_MIN, Math.round(width)))
    set({ leftWidth: next })
    if (persist) saveStudioWidth('morrow.studio.leftWidth', next)
  },

  setRightWidth(width, persist = false) {
    const next = Math.min(STUDIO_RIGHT_MAX, Math.max(STUDIO_RIGHT_MIN, Math.round(width)))
    set({ rightWidth: next })
    if (persist) saveStudioWidth('morrow.studio.rightWidth', next)
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open })
  },
  setTimelineInspectorOpen(open) {
    set({ timelineInspectorOpen: open })
  },
  setOutlineOpen(open) {
    set({ outlineOpen: open })
  },
  setFactsOpen(open) {
    set({ factsOpen: open })
  },
  setFocusMode(on) {
    set({ focusMode: on })
  },
  setStoryboardTab(tab) {
    set({ storyboardTab: tab })
  },
  setTimelineFocus(focus) {
    set({ timelineFocus: focus })
  },
  selectChapter(id) {
    set({ selectedChapterId: id, view: 'writing', outlineOpen: true })
    try {
      localStorage.setItem('morrow.studio.chapter', id)
    } catch {
    }
  },
  selectShot(id) {
    set({ selectedShotId: id })
  },
  selectClip(id) {
    set({ selectedClipId: id })
  },
  setEditorDirty(dirty) {
    set({ editorDirty: dirty })
  },
  setSaveState(state) {
    set({ saveState: state })
  },

  notify(kind, text) {
    set({ notice: { kind, text, at: Date.now() } })
  },
  clearNotice() {
    set({ notice: null })
  },

  handleEvent(event) {
    set({ lastEventAt: Date.now() })
    if (event.type === 'project') {
      set((state) => ({ projects: mergeSummary(state.projects, event.summary) }))
      return
    }
    const job = event.job
    set((state) => {
      if (!state.active || state.active.id !== job.projectId) return state
      const jobs = state.active.jobs.some((item) => item.id === job.id)
        ? state.active.jobs.map((item) => (item.id === job.id ? job : item))
        : [...state.active.jobs, job]
      return { active: { ...state.active, jobs } }
    })
    if (job.status !== 'queued' && job.status !== 'running') {
      if (!get().editorDirty) {
        window.setTimeout(() => {
          void get().refreshActive(true)
          void get().refreshEngine()
        }, 180)
      }
      if (job.status === 'failed') get().notify('error', job.error || job.message)
      else if (job.status === 'review') get().notify('info', job.message)
    }
  }
}))

export function useActiveProject(): StudioProject | null {
  return useStudioStore((state) => state.active)
}

export function useActiveJobs(): StudioJob[] {
  return useStudioStore((state) => state.active?.jobs ?? [])
}

export function useStageDefs(project: StudioProject | null) {
  return project ? studioStages(project.kind) : []
}

export function activeJob(project: StudioProject | null): StudioJob | null {
  if (!project) return null
  return [...project.jobs].reverse().find((job) => job.status === 'running') ?? [...project.jobs].reverse().find((job) => job.status === 'queued') ?? null
}
