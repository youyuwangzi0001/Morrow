// workbench 功能域组件：由 1 个 TSX 文件扁平合并。
import './workbench.css'
import { useEffect, useState } from 'react'
import { SkillsPanel } from './skills'
import { MemoryCenter } from './memory'
import { ProjectsPanel } from './projects'
import { ScheduledTasksPanel } from './schedules'
import { ConnectorsPanel } from './connectors'
import SearchPanel from './search'
import BrowserSurface from './browser'
import { TerminalPanel } from './terminal'
import { GitPanel } from './git'
import { useAppStore } from '../store'
import type { WorkbenchPanel } from './workbench-core'
import { WORKBENCH_EVENT, parseWorkbenchPanel } from './workbench-core'

/**
 * 功能面板宿主：设置页和命令面板通过事件打开同一个真实面板。
 * 不再有独立的「工作台」入口或菜单页。
 */
export function WorkbenchHost(): React.JSX.Element {
  const [panel, setPanel] = useState<WorkbenchPanel | null>(null)
  const [panelWorkspace, setPanelWorkspace] = useState<string | null>(null)
  const [projectView, setProjectView] = useState<'home' | 'settings'>('home')
  const [browserHidden, setBrowserHidden] = useState(false)
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
      if (requested === 'browser') setBrowserHidden(false)
      setPanel(requested)
      setPanelWorkspace(typeof detail?.workspace === 'string' && detail.workspace ? detail.workspace : null)
      if (detail?.view === 'home' || detail?.view === 'settings') setProjectView(detail.view)
      else setProjectView('home')
    }
    window.addEventListener(WORKBENCH_EVENT, onEvent)
    return () => window.removeEventListener(WORKBENCH_EVENT, onEvent)
  }, [openTerminal])

  // 浏览器全屏面板需要独占窗口顶部：标题栏的原生拖动区分块会截获地址栏点击。
  useEffect(() => {
    const active = panel === 'browser' && !browserHidden
    document.body.classList.toggle('is-browser-surface-open', active)
    return () => document.body.classList.remove('is-browser-surface-open')
  }, [panel, browserHidden])

  // Agent 打开/关闭网页时，面板跟随展示同一个可见浏览器实例
  useEffect(() => {
    const api = window.morrow?.features
    if (!api?.on) return undefined
    const offPresent = api.on('feature:browser:present', () => {
      setBrowserHidden(false)
      setPanel('browser')
    })
    const offClosed = api.on('feature:browser:closed', () => {
      setBrowserHidden(false)
      setPanel((current) => (current === 'browser' ? null : current))
    })
    return () => {
      offPresent?.()
      offClosed?.()
    }
  }, [])

  const close = (): void => {
    setPanel(null)
    setPanelWorkspace(null)
    setBrowserHidden(false)
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
      {panel === 'browser' ? (
        <div className={['workbench-browser-overlay', browserHidden ? 'is-hidden' : ''].filter(Boolean).join(' ')}>
          <BrowserSurface
            open
            visible={!browserHidden}
            onHide={() => setBrowserHidden(true)}
            onClose={close}
          />
        </div>
      ) : null}
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
