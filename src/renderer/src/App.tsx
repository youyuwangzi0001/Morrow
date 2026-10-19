import { useEffect } from 'react'
import './App.css'
import { useAppStore } from './state/store'
import { TitleBar } from './features/shell/TitleBar'
import { Sidebar } from './features/shell/Sidebar'
import { Welcome } from './features/shell/Welcome'
import { Toasts } from './features/shell/Toasts'
import { Composer } from './features/composer/Composer'
import { SettingsModal } from './features/settings/SettingsModal'
import { Onboarding } from './features/onboarding/Onboarding'
import { CommandPalette } from './features/palette/CommandPalette'
import { Transcript } from './features/chat/Transcript'
import { PlanTray } from './features/activity/PlanTray'
import { GoalBar } from './features/goal/GoalBar'
import { Canvas } from './features/artifacts/Canvas'
import { DemoOverlay } from './features/demo/DemoOverlay'
import { WorkbenchHost } from './features/workbench/WorkbenchHost'
import { openWorkbench } from './features/workbench/events'
import { Button, HorizonLoader, ResizeHandle } from './ui'

/**
 * 应用组装层（Lead 拥有）：
 * - 只负责布局、全局快捷键、首次启动、覆盖层挂载
 * - 业务 UI 由 features/* 组件直连 store
 */
export default function App(): React.JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const bootError = useAppStore((s) => s.bootError)
  const init = useAppStore((s) => s.init)
  const session = useAppStore((s) => s.session)
  const loadingSession = useAppStore((s) => s.loadingSession)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)
  const canvasOpen = useAppStore((s) => s.canvas.open)
  const run = useAppStore((s) => s.run)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        useAppStore.getState().openPalette()
      } else if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        useAppStore.getState().toggleSidebar()
      } else if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void useAppStore.getState().newSession()
      } else if (mod && event.key === ',') {
        event.preventDefault()
        useAppStore.getState().openSettings()
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        openWorkbench()
      } else if (event.key === 'Escape' && !typing) {
        const state = useAppStore.getState()
        // 审批/提问卡片自己消费 Esc（拒绝/取消），全局不再抢键
        if (state.pendingPermission || state.pendingQuestion) return
        if (state.run) void state.stopRun()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  if (!ready) {
    return (
      <div className="app-boot">
        <div className="app-glow" />
        <div className="grain-overlay" />
        <div className="app-boot-mark serif">M</div>
        <div className="app-boot-horizon" />
        <p className="app-boot-text mono">MORROW · 正在打开工坊</p>
        <div className="app-boot-loader">
          <HorizonLoader active />
        </div>
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="app-boot">
        <div className="app-glow" />
        <div className="grain-overlay" />
        <div className="app-boot-error">
          <h1 className="serif">启动时遇到问题</h1>
          <p>{bootError}</p>
          <Button
            variant="gold"
            onClick={() => {
              window.location.reload()
            }}
          >
            重新打开
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={[
        'app',
        sidebarCollapsed ? 'is-sidebar-collapsed' : '',
        canvasOpen ? 'is-canvas-open' : '',
        run ? 'is-running' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="app-glow" aria-hidden />
      <div className="grain-overlay" aria-hidden />
      <TitleBar />
      <div className="app-body">
        {!sidebarCollapsed ? (
          <>
            <div className="app-sidebar-shell" style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
            <ResizeHandle
              value={sidebarWidth}
              min={200}
              max={400}
              edge="right"
              className="sidebar-resizer"
              label="拖动调整侧栏宽度（方向键微调，双击恢复默认）"
              onChange={(width) => setSidebarWidth(width)}
              onCommit={(width) => setSidebarWidth(width, true)}
              onReset={() => setSidebarWidth(240, true)}
            />
          </>
        ) : null}
        <main className="app-main">
          <section className="app-conversation" aria-label="对话">
            <div className="app-scroll">
              {loadingSession ? (
                <div className="app-session-loading">
                  <HorizonLoader active />
                </div>
              ) : session ? (
                <Transcript />
              ) : (
                <Welcome />
              )}
            </div>
            <div className="app-dock">
              <GoalBar />
              <PlanTray />
              <Composer />
            </div>
          </section>
          <Canvas />
        </main>
      </div>
      <SettingsModal />
      <WorkbenchHost />
      <Onboarding />
      <CommandPalette />
      <DemoOverlay />
      <Toasts />
    </div>
  )
}
