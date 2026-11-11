import { useEffect, useRef, useState, type CSSProperties } from 'react'
import brandMarkUrl from './assets/brand-mark-dark.png'
import { useAppStore } from './store'
import { TitleBar } from './features/shell'
import { Sidebar } from './features/shell'
import { Welcome } from './features/shell'
import { Toasts } from './features/shell'
import { Composer } from './features/composer'
import { QueueTray } from './features/composer'
import { SettingsModal } from './features/settings'
import { Onboarding } from './features/onboarding'
import { CommandPalette } from './features/palette'
import { Transcript } from './features/chat'
import { PlanTray } from './features/activity'
import { PlanCard } from './features/activity'
import { SourcesTray } from './features/activity'
import { RunCenter } from './features/activity'
import { MemoryCaptureBar } from './features/activity'
import { GoalBar } from './features/goal'
import { ResearchBar } from './features/research'
import { Canvas } from './features/artifacts'
import { DemoOverlay } from './features/demo'
import { BrowserDock, WorkbenchHost } from './features/workbench'
import { SideChat } from './features/sidechat'
import { RewindConfirm } from './features/checkpoints'
import { CloseConfirm } from './features/shell'
import { StudioApp } from './features/studio'
import { useStudioStore } from './features/studio-core'
import { matchesShortcut } from '@shared/shortcuts'
import { Button, HorizonLoader, ResizeHandle, hasOpenModal } from './components'

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
  const sideChatOpen = useAppStore((s) => s.sideChatOpen)
  const run = useAppStore((s) => s.run)
  const shortcuts = useAppStore((s) => s.settings.shortcuts)
  const platform = useAppStore((s) => s.appInfo?.platform)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 首次引导是模态层：不让全局快捷键与 Esc 穿透到下面的应用
      if (useAppStore.getState().onboardingOpen) return
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      // 终端开关即使在终端聚焦时也应可用；其余全局键让给 shell。
      if (matchesShortcut(event, shortcuts.terminal, platform)) {
        event.preventDefault()
        useAppStore.getState().toggleTerminal()
        return
      }
      // 终端内的按键归终端：Ctrl+K/B/N 等不能抢 shell 的快捷键
      if (target?.closest('.terminal-dock')) return
      if (matchesShortcut(event, shortcuts.palette, platform)) {
        event.preventDefault()
        const state = useAppStore.getState()
        if (state.paletteOpen) state.closePalette()
        else state.openPalette()
      } else if (matchesShortcut(event, shortcuts.sidebar, platform)) {
        event.preventDefault()
        useAppStore.getState().toggleSidebar()
      } else if (matchesShortcut(event, shortcuts['new-session'], platform)) {
        event.preventDefault()
        void useAppStore.getState().newSession()
      } else if (matchesShortcut(event, shortcuts.settings, platform)) {
        event.preventDefault()
        useAppStore.getState().openSettings()
      } else if (event.key === 'Escape' && !typing) {
        // 局部先消费（弹窗/搜索/画布全屏等）时不抢键；全局 Esc 只用于停止当前运行
        if (event.defaultPrevented || hasOpenModal()) return
        const state = useAppStore.getState()
        // 审批/提问卡片自己消费 Esc（拒绝/取消），全局不再抢键
        if (state.pendingPermission || state.pendingQuestion) return
        // 只在当前对话运行中时响应 Esc；不要在 B 里误停后台 A。
        if (state.run && state.run.sessionId === state.session?.id) void state.stopRun()
      }
    }
    // 用冒泡阶段：让输入框/弹窗/面板先处理 Esc 并 preventDefault，再决定是否停止运行
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [shortcuts, platform])

  useEffect(() => {
    const offQuickSend = window.morrow.island.onQuickSend(({ text, sessionId }) => {
      void (async () => {
        const state = useAppStore.getState()
        if (sessionId) {
          if (state.session?.id !== sessionId) await state.selectSession(sessionId)
          const loaded = useAppStore.getState().session
          if (loaded?.id !== sessionId) {
            useAppStore.getState().notify('error', '原来的对话不存在了，这条消息没有发送。')
            return
          }
        }
        await useAppStore.getState().sendMessage(text)
      })()
    })
    const offOpen = window.morrow.island.onOpen(({ sessionId, newSession, studio }) => {
      if (studio) {
        void useStudioStore.getState().openStudio()
        return
      }
      // 灵动岛的“回到 Agent”需要先退出创作台，否则主窗口仍停在创作台。
      useStudioStore.getState().closeStudio()
      void (async () => {
        const state = useAppStore.getState()
        if (newSession) await state.newSession()
        else if (sessionId && state.session?.id !== sessionId) await state.selectSession(sessionId)
      })()
    })
    return () => {
      offQuickSend()
      offOpen()
    }
  }, [])

  if (!ready) {
    return (
      <div className="app-boot">
        <div className="app-glow" />
        <div className="grain-overlay" />
        <img className="app-boot-mark" src={brandMarkUrl} alt="" width={96} height={96} draggable={false} />
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
      style={{ '--app-sidebar-width': sidebarCollapsed ? '0px' : `${sidebarWidth + 3}px` } as CSSProperties}
      className={[
        'app',
        sidebarCollapsed ? 'is-sidebar-collapsed' : '',
        canvasOpen ? 'is-canvas-open' : '',
        sideChatOpen ? 'is-sidechat-open' : '',
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
              <ResearchBar />
              <GoalBar />
              <RunCenter />
              <QueueTray />
              {!loadingSession ? (
                <>
                  <PlanCard key={`${session?.id ?? 'none'}:${session?.plan?.id ?? 'none'}`} />
                  <PlanTray />
                  <SourcesTray key={session?.id ?? 'none'} />
                </>
              ) : null}
              <MemoryCaptureBar />
              <Composer />
            </div>
          </section>
          <Canvas />
          <BrowserDock />
          <SideChat />
        </main>
      </div>
      <SettingsModal />
      <WorkbenchHost />
      <Onboarding />
      <CommandPalette />
      <RewindConfirm />
      <CloseConfirm />
      <DemoOverlay />
      <StudioApp />
      <Toasts />
      <LiveAnnouncer />
    </div>
  )
}

// 无障碍播报：由 features/a11y 并入应用组装层。
/**
 * 读屏播报：只播报阶段变化，不播报流式增量，避免每个 token 都打断。
 * assertive 仅用于审批与提问；运行开始/结束走 polite。
 */
export function LiveAnnouncer(): React.JSX.Element {
  const runId = useAppStore((state) => state.run?.runId ?? null)
  const permissionId = useAppStore((state) => state.pendingPermission?.id ?? null)
  const permissionTool = useAppStore((state) => state.pendingPermission?.toolName ?? '')
  const questionId = useAppStore((state) => state.pendingQuestion?.id ?? null)
  const questionText = useAppStore((state) => state.pendingQuestion?.question ?? '')
  const compacting = useAppStore((state) => state.compacting)
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')
  const previousRun = useRef<string | null>(null)
  const previousCompacting = useRef(false)

  useEffect(() => {
    if (runId && runId !== previousRun.current) {
      setPolite('Morrow 开始处理任务。')
    } else if (!runId && previousRun.current) {
      setPolite('Morrow 已完成本次处理。')
    }
    previousRun.current = runId
  }, [runId])

  useEffect(() => {
    if (!compacting) {
      if (previousCompacting.current) setPolite('上下文压缩完成。')
      previousCompacting.current = false
      return
    }
    setPolite('正在压缩较早的上下文。')
    previousCompacting.current = true
  }, [compacting])

  useEffect(() => {
    if (!permissionId) {
      setAssertive('')
      return
    }
    setAssertive(`需要你确认工具操作：${permissionTool || '未知工具'}。`)
  }, [permissionId, permissionTool])

  useEffect(() => {
    if (!questionId) {
      setAssertive('')
      return
    }
    setAssertive(`Morrow 有一个问题需要你回答：${questionText.slice(0, 160)}`)
  }, [questionId, questionText])

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-a11y="polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" data-a11y="assertive">
        {assertive}
      </div>
    </>
  )
}
