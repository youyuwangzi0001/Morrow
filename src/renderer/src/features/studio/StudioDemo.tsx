import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  X
} from 'lucide-react'
import type { StudioProject } from '@shared/studio'
import { Button } from '../../ui'
import { studioApi } from './api'
import { useStudioStore, type StoryboardTab, type StudioView } from './studio-store'

const SCENES = [
  { key: 'home', label: '一句话', caption: '写下脑子里那句画面，蓝图负责把它说清楚。', target: '.studio-logline-input' },
  { key: 'blueprint', label: '蓝图', caption: '故事主线、人物、结构与费用区间，先看再确认。', target: '.studio-blueprint-title-block' },
  { key: 'storyboard', label: '分镜', caption: '12 镜的真实画面、人物参考和每镜检查。', target: '.studio-shot-inspector' },
  { key: 'timeline', label: '时间线', caption: '五条轨道、声音和画面对齐、字幕和真实草稿预览。', target: '.studio-monitor' },
  { key: 'delivery', label: '交付', caption: '成片、字幕与工程包，都在同一份作品里。', target: '.studio-delivery-poster' }
]

const FALLBACK_TEXT = '一个雨夜，修伞的女孩捡到一把会倒着走时间的伞。她每修好一把伞，就会失去一段记忆。'

interface DemoSaved {
  view: StudioView
  activeId: string | null
  selectedChapterId: string | null
  selectedShotId: string | null
  selectedClipId: string | null
  assistantOpen: boolean
  timelineInspectorOpen: boolean
  factsOpen: boolean
  focusMode: boolean
  storyboardTab: StoryboardTab
  homeDraft: string
}

function snapshot(): DemoSaved {
  const state = useStudioStore.getState()
  const textarea = document.querySelector<HTMLTextAreaElement>('.studio-logline-input')
  return {
    view: state.view,
    activeId: state.active?.id ?? null,
    selectedChapterId: state.selectedChapterId,
    selectedShotId: state.selectedShotId,
    selectedClipId: state.selectedClipId,
    assistantOpen: state.assistantOpen,
    timelineInspectorOpen: state.timelineInspectorOpen,
    factsOpen: state.factsOpen,
    focusMode: state.focusMode,
    storyboardTab: state.storyboardTab,
    homeDraft: textarea?.value ?? ''
  }
}

async function restore(saved: DemoSaved | null): Promise<void> {
  if (!saved || !useStudioStore.getState().open) return
  const state = useStudioStore.getState()
  state.selectShot(null)
  state.selectClip(null)
  useStudioStore.setState({
    assistantOpen: saved.assistantOpen,
    timelineInspectorOpen: saved.timelineInspectorOpen,
    factsOpen: saved.factsOpen,
    focusMode: saved.focusMode
  })
  if (saved.activeId) {
    await state.openProject(saved.activeId, saved.view)
    useStudioStore.setState({
      selectedChapterId: saved.selectedChapterId,
      selectedShotId: saved.selectedShotId,
      selectedClipId: saved.selectedClipId,
      storyboardTab: saved.storyboardTab
    })
  } else {
    useStudioStore.setState({
      active: null,
      view: 'home',
      selectedChapterId: null,
      selectedShotId: null,
      selectedClipId: null
    })
  }
  if (saved.view === 'home') {
    window.setTimeout(() => writeComposer(saved.homeDraft), 120)
  }
}

function writeComposer(value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>('.studio-logline-input')
  if (!textarea) return
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function markFocus(selector: string): void {
  document.querySelectorAll('.studio-demo-focus').forEach((element) => element.classList.remove('studio-demo-focus'))
  document.querySelector(selector)?.classList.add('studio-demo-focus')
}

function clearFocus(): void {
  document.querySelectorAll('.studio-demo-focus').forEach((element) => element.classList.remove('studio-demo-focus'))
}

export function StudioDemo(): React.JSX.Element | null {
  const demoOpen = useStudioStore((state) => state.demoOpen)
  const closeDemo = useStudioStore((state) => state.closeDemo)
  const [project, setProject] = useState<StudioProject | null>(null)
  const [targetId, setTargetId] = useState('')
  const [scene, setScene] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const savedRef = useRef<DemoSaved | null>(null)
  const keepRef = useRef(false)

  useEffect(() => {
    if (!demoOpen) return
    savedRef.current = snapshot()
    keepRef.current = false
    setScene(0)
    setPlaying(true)
    setReady(false)
    setError('')
    setProject(null)
    setTargetId('')
    useStudioStore.setState({
      view: 'home',
      active: null,
      assistantOpen: false,
      focusMode: false,
      factsOpen: false,
      selectedShotId: null,
      selectedClipId: null,
      timelineInspectorOpen: false
    })
    let cancelled = false
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
        setProject(result.project)
        setTargetId(target.id)
        setReady(true)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      clearFocus()
      if (!useStudioStore.getState().open) return
      if (keepRef.current) {
        keepRef.current = false
        return
      }
      void restore(savedRef.current)
    }
  }, [demoOpen])

  useEffect(() => {
    if (!demoOpen || !ready || scene !== 0) return
    const text = project?.logline || FALLBACK_TEXT
    let index = 0
    let timer = 0
    const start = window.setTimeout(() => {
      writeComposer('')
      timer = window.setInterval(() => {
        index += 1
        writeComposer(text.slice(0, index))
        if (index >= text.length) window.clearInterval(timer)
      }, 32)
    }, 520)
    return () => {
      window.clearTimeout(start)
      if (timer) window.clearInterval(timer)
    }
  }, [demoOpen, ready, scene, project?.logline])

  useEffect(() => {
    if (!demoOpen || !ready || !targetId) return
    let cancelled = false
    const timers: number[] = []
    clearFocus()
    const later = (fn: () => void, delay: number): void => {
      timers.push(window.setTimeout(() => {
        if (!cancelled) fn()
      }, delay))
    }
    const state = useStudioStore.getState()
    if (scene === 0) {
      useStudioStore.setState({ view: 'home', active: null, selectedShotId: null, selectedClipId: null })
      later(() => markFocus(SCENES[0].target), 1300)
    } else if (scene === 1) {
      state.setAssistantOpen(false)
      void state.openProject(targetId, 'blueprint').then(() => {
        if (!cancelled) later(() => markFocus(SCENES[1].target), 420)
      })
    } else if (scene === 2) {
      state.setView('storyboard')
      state.setStoryboardTab('board')
      state.selectShot(null)
      const shot = project?.shots[5] ?? project?.shots[0]
      later(() => {
        if (shot) state.selectShot(shot.id)
      }, 1700)
      later(() => markFocus(SCENES[2].target), 2100)
    } else if (scene === 3) {
      state.setView('timeline')
      state.setTimelineInspectorOpen(false)
      later(() => {
        const play = document.querySelector<HTMLButtonElement>('.studio-transport .is-play')
        if (play?.getAttribute('aria-label') === '播放') play.click()
      }, 900)
      later(() => markFocus(SCENES[3].target), 1100)
    } else if (scene === 4) {
      state.setView('delivery')
      state.setAssistantOpen(false)
      later(() => markFocus(SCENES[4].target), 500)
    }
    return () => {
      cancelled = true
      timers.forEach((timer) => window.clearTimeout(timer))
      clearFocus()
      if (scene === 2) useStudioStore.getState().selectShot(null)
    }
  }, [demoOpen, ready, targetId, scene, project?.shots])

  useEffect(() => {
    if (!demoOpen || !playing || !ready || error) return
    if (scene >= SCENES.length - 1) {
      setPlaying(false)
      return
    }
    const delay = scene === 0 ? 6400 : scene === 2 ? 7600 : 7000
    const timer = window.setTimeout(() => setScene((value) => Math.min(SCENES.length - 1, value + 1)), delay)
    return () => window.clearTimeout(timer)
  }, [demoOpen, playing, ready, error, scene])

  useEffect(() => {
    if (!demoOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        keepRef.current = false
        closeDemo()
        return
      }
      if (typing) return
      if (event.key === 'ArrowRight') {
        setPlaying(false)
        setScene((value) => Math.min(SCENES.length - 1, value + 1))
      }
      if (event.key === 'ArrowLeft') {
        setPlaying(false)
        setScene((value) => Math.max(0, value - 1))
      }
      if (event.code === 'Space') {
        event.preventDefault()
        setPlaying((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [demoOpen, closeDemo])

  if (!demoOpen) return null

  const go = (direction: number): void => {
    setPlaying(false)
    setScene((value) => Math.max(0, Math.min(SCENES.length - 1, value + direction)))
  }
  const finish = (keep: boolean): void => {
    keepRef.current = keep
    closeDemo()
  }
  const meta = project ? `${project.shots.length} 镜 · ${Math.round(project.timeline.durationSec)} 秒` : '真实样例'

  return (
    <div className="studio-demo" role="dialog" aria-modal="false" aria-label="创作台演示">
      <div className="studio-demo-dock">
        <span className="studio-demo-live"><i /> 演示 <em>真实界面</em></span>
        <div className="studio-demo-copy">
          <b><span className="mono">{String(scene + 1).padStart(2, '0')} / 0{SCENES.length}</span> {SCENES[scene].label}</b>
          <span>{error || (ready ? (scene === SCENES.length - 1 ? '演示结束，界面仍然可以继续操作。' : SCENES[scene].caption) : '正在打开真实样例…')}</span>
        </div>
        <div className="studio-demo-dots" aria-hidden>
          {SCENES.map((item, index) => (
            <i key={item.key} className={index === scene ? 'is-current' : index < scene ? 'is-done' : ''} />
          ))}
        </div>
        <div className="studio-demo-actions">
          <button type="button" className="studio-demo-icon-btn studio-demo-prev" onClick={() => go(-1)} disabled={scene === 0} title="上一幕" aria-label="上一幕">
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="studio-demo-icon-btn is-play studio-demo-play"
            onClick={() => setPlaying((value) => !value)}
            disabled={!ready || Boolean(error) || scene === SCENES.length - 1}
            title={playing ? '暂停' : '继续'}
            aria-label={playing ? '暂停' : '继续'}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button type="button" className="studio-demo-icon-btn studio-demo-next" onClick={() => go(1)} disabled={scene === SCENES.length - 1} title="下一幕" aria-label="下一幕">
            <ChevronRight size={15} />
          </button>
          {scene === SCENES.length - 1 ? (
            <Button variant="gold" size="sm" onClick={() => finish(true)} iconRight={<ArrowRight size={12} />}>留在样例里</Button>
          ) : null}
          <button type="button" className="studio-demo-icon-btn is-close studio-demo-close" onClick={() => finish(false)} title="关闭演示" aria-label="关闭演示">
            <X size={15} />
          </button>
        </div>
        <span className="studio-demo-meta mono">{error ? '样例未就绪' : ready ? meta : <Loader2 size={12} className="studio-spin" />}</span>
      </div>
    </div>
  )
}
