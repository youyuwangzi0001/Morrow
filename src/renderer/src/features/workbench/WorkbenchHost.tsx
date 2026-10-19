import { useEffect, useState } from 'react'
import { SkillsPanel } from '../skills'
import { MemoryCenter } from '../memory'
import { ProjectsPanel } from '../projects'
import { ConnectorsPanel } from '../connectors/ConnectorsPanel'
import { SearchPanel } from '../search'
import { BrowserSurface } from '../browser'
import { useAppStore } from '../../state/store'
import { WORKBENCH_EVENT, parseWorkbenchPanel, type WorkbenchPanel } from './events'
import { WorkbenchMenu } from './WorkbenchMenu'

/**
 * 工作台宿主：所有新功能面板由这里统一挂载，避免各功能改 App/Sidebar/Settings。
 * 各队友组件完成后，Lead 在这里加 import 与对应分支。
 */
export function WorkbenchHost(): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [panel, setPanel] = useState<WorkbenchPanel | null>(null)

  useEffect(() => {
    const onEvent = (event: Event): void => {
      const detail = (event as CustomEvent<{ panel?: unknown }>).detail
      const requested = parseWorkbenchPanel(detail?.panel)
      if (requested) {
        setMenuOpen(false)
        setPanel(requested)
      } else {
        setMenuOpen(true)
      }
    }
    window.addEventListener(WORKBENCH_EVENT, onEvent)
    return () => window.removeEventListener(WORKBENCH_EVENT, onEvent)
  }, [])

  const close = (): void => setPanel(null)

  return (
    <>
      <WorkbenchMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(next) => {
          setMenuOpen(false)
          setPanel(next)
        }}
      />
      <SkillsPanel open={panel === 'skills'} onClose={close} />
      <MemoryCenter open={panel === 'memory'} onClose={close} />
      <ProjectsPanel open={panel === 'projects'} onClose={close} />
      <ConnectorsPanel open={panel === 'connectors'} onClose={close} />
      {panel === 'browser' ? (
        <div className="workbench-browser-overlay">
          <BrowserSurface open onClose={close} />
        </div>
      ) : null}
      <SearchPanel
        open={panel === 'search'}
        onClose={close}
        onNavigate={(hit) => {
          setPanel(null)
          if (hit.kind === 'session' && hit.sessionId) {
            void useAppStore.getState().selectSession(hit.sessionId)
          } else if (hit.kind === 'file' && hit.absolutePath) {
            window.dispatchEvent(new CustomEvent('morrow:open-file', { detail: { path: hit.absolutePath } }))
          } else if (hit.kind === 'artifact' && hit.artifactId) {
            useAppStore.getState().openCanvas(hit.artifactId)
          }
        }}
      />
    </>
  )
}
