// workbench 功能域组件：由 1 个 TSX 文件扁平合并。
import './workbench.css'
import { useEffect, useState } from 'react'
import { ResizeHandle } from '../components'
import { SkillsPanel } from './skills'
import { MemoryCenter } from './memory'
import { ProjectsPanel } from './projects'
import { ScheduledTasksPanel } from './schedules'
import { ConnectorsPanel } from './connectors'
import SearchPanel from './search'
import BrowserSurface from './browser'
import { TerminalPanel } from './terminal'
import { GitPanel } from './git'
import { maxCanvasWidthForViewport, useAppStore } from '../store'
import type { WorkbenchPanel } from './workbench-core'
import { WORKBENCH_EVENT, CLOSE_BROWSER_EVENT, parseWorkbenchPanel } from './workbench-core'

const BROWSER_MIN_WIDTH = 320

/**
 * 浏览器/电脑操作面：和成品画布共用右侧栏与宽度，默认 420px。
 * 不再用大分屏覆盖主界面；对话、审批和输入框保持可见。
 */
export function BrowserDock(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const canvasWidth = useAppStore((s) => s.canvasWidth)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const setCanvasWidth = useAppStore((s) => s.setCanvasWidth)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440))
  const maxWidth = Math.max(
    BROWSER_MIN_WIDTH,
    Math.min(maxCanvasWidthForViewport(sidebarWidth, sidebarCollapsed), Math.round(viewportWidth * 0.68))
  )
  const width = Math.max(BROWSER_MIN_WIDTH, Math.min(canvasWidth, maxWidth))

  useEffect(() => {
    const onWorkbench = (event: Event): void => {
      const detail = (event as CustomEvent<{ panel?: unknown }>).detail
      if (parseWorkbenchPanel(detail?.panel) !== 'browser') return
      setOpen(true)
      setHidden(false)
    }
    const api = window.morrow?.features
    const offPresent = api?.on?.('feature:browser:present', () => {
      setOpen(true)
      setHidden(false)
    })
    const offClosed = api?.on?.('feature:browser:closed', () => {
      setOpen(false)
      setHidden(false)
    })
    const onCloseBrowser = (): void => {
      setOpen(false)
      setHidden(false)
    }
    window.addEventListener(WORKBENCH_EVENT, onWorkbench)
    window.addEventListener(CLOSE_BROWSER_EVENT, onCloseBrowser)
    return () => {
      window.removeEventListener(WORKBENCH_EVENT, onWorkbench)
      window.removeEventListener(CLOSE_BROWSER_EVENT, onCloseBrowser)
      offPresent?.()
      offClosed?.()
    }
  }, [])

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const active = open && !hidden
    document.body.classList.toggle('is-browser-dock-open', active)
    return () => document.body.classList.remove('is-browser-dock-open')
  }, [open, hidden])

  if (!open) return null

  return (
    <>
      <ResizeHandle
        value={width}
        min={BROWSER_MIN_WIDTH}
        max={maxWidth}
        edge="left"
        className="browser-dock-resizer"
        label="拖动调整电脑操作栏宽度（方向键微调，双击恢复默认）"
        onChange={setCanvasWidth}
        onCommit={(width) => setCanvasWidth(width, true)}
        onReset={() => setCanvasWidth(420, true)}
      />
      <aside
        className={['canvas-root', 'browser-dock', hidden ? 'is-hidden' : ''].filter(Boolean).join(' ')}
        style={{ width }}
        aria-label="电脑操作"
      >
        <BrowserSurface
          open
          visible={!hidden}
          onHide={() => setHidden(true)}
          onClose={() => {
            setOpen(false)
            setHidden(false)
          }}
        />
      </aside>
    </>
  )
}

/**
 * 功能面板宿主：设置页和命令面板通过事件打开同一个真实面板。
 * 不再有独立的「工作台」入口或菜单页。浏览器由 BrowserDock 单独处理。
 */
export function WorkbenchHost(): React.JSX.Element {
  const [panel, setPanel] = useState<WorkbenchPanel | null>(null)
  const [panelWorkspace, setPanelWorkspace] = useState<string | null>(null)
  const [projectView, setProjectView] = useState<'home' | 'settings'>('home')
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace ?? null)
  const terminalOpen = useAppStore((s) => s.terminalOpen)
  const openTerminal = useAppStore((s) => s.openTerminal)
  const closeTerminal = useAppStore((s) => s.closeTerminal)

  useEffect(() => {
    const onEvent = (event: Event): void => {
      const detail = (event as CustomEvent<{ panel?: unknown; workspace?: unknown; view?: unknown }>).detail
      const requested = parseWorkbenchPanel(detail?.panel)
      if (!requested) return
      if (requested === 'terminal') {
        openTerminal()
        return
      }
      // 浏览器/电脑操作面由 BrowserDock 监听同一事件并接管；先收起其它面板。
      if (requested === 'browser') {
        setPanel(null)
        setPanelWorkspace(null)
        return
      }
      setPanel(requested)
      setPanelWorkspace(typeof detail?.workspace === 'string' && detail.workspace ? detail.workspace : null)
      if (detail?.view === 'home' || detail?.view === 'settings') setProjectView(detail.view)
      else setProjectView('home')
    }
    window.addEventListener(WORKBENCH_EVENT, onEvent)
    return () => window.removeEventListener(WORKBENCH_EVENT, onEvent)
  }, [openTerminal])

  const close = (): void => {
    setPanel(null)
    setPanelWorkspace(null)
  }

  return (
    <>
      <SkillsPanel open={panel === 'skills'} onClose={close} />
      <MemoryCenter open={panel === 'memory'} onClose={close} />
      <ProjectsPanel
        open={panel === 'projects'}
        onClose={close}
        initialView={projectView}
        {...(panelWorkspace ? { workspace: panelWorkspace } : {})}
      />
      <ScheduledTasksPanel open={panel === 'schedules'} onClose={close} />
      <ConnectorsPanel open={panel === 'connectors'} onClose={close} />
      <TerminalPanel open={terminalOpen} onClose={closeTerminal} workspace={workspace} />
      <GitPanel open={panel === 'git'} onClose={close} workspace={workspace} />
      <SearchPanel
        open={panel === 'search'}
        workspace={workspace}
        onClose={close}
        onNavigate={(hit) => {
          setPanel(null)
          if (hit.kind === 'session' && hit.sessionId) {
            const sessionId = hit.sessionId
            const messageId = hit.messageId
            void useAppStore
              .getState()
              .selectSession(sessionId)
              .then(() => {
                if (messageId) useAppStore.getState().focusMessage(messageId)
              })
            return
          }
          if (hit.kind === 'file' && hit.absolutePath) {
            window.dispatchEvent(
              new CustomEvent('morrow:open-file', {
                detail: {
                  path: hit.path ?? hit.absolutePath,
                  absolutePath: hit.absolutePath
                }
              })
            )
            return
          }
          if (hit.kind === 'artifact' && hit.artifactId) {
            void (async () => {
              const store = useAppStore.getState()
              if (hit.sessionId && store.activeSessionId !== hit.sessionId) {
                await store.selectSession(hit.sessionId)
              }
              useAppStore.getState().openCanvas(hit.artifactId)
            })()
          }
        }}
      />
    </>
  )
}
