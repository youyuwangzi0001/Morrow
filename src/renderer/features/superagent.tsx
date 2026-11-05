import './superagent.css'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  GitBranch,
  GitMerge,
  History,
  Loader2,
  Network,
  OctagonX,
  Package,
  Play,
  RotateCcw,
  Square,
  Undo2,
  X
} from 'lucide-react'
import type {
  CollaborationMessageStatus,
  CollaborationTraceEntry,
  CollaborationTraceLink,
  CollaborationTraceQuery,
  CollaborationTraceResult,
  SuperTask
} from '@shared/types'
import { ResizeHandle } from '../components'
import { maxCanvasWidthForViewport, useAppStore } from '../store'

const MIN_WIDTH = 340

const MESSAGE_STATUS_TEXT: Record<CollaborationMessageStatus, string> = {
  pending: '待投递',
  delivered: '已送达',
  read: '已读',
  adopted: '已采用',
  cancelled: '已取消关注',
  failed: '投递失败'
}

const STATUS_TEXT: Record<SuperTask['status'], string> = {
  queued: '等待',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  stalled: '停滞',
  blocked: '被依赖阻塞'
}

const CONFLICT_REASON: Record<import('@shared/types').CollaborationConflictReason, string> = {
  content: '同一处内容冲突',
  delete: '一边删除、一边修改',
  create: '双方新建了不同内容',
  binary: '二进制文件冲突',
  'path-alias': '不同路径写法指向同一文件'
}

const VERIFICATION_TEXT: Record<import('@shared/types').CollaborationVerificationStatus, string> = {
  pending: '待验收',
  passed: '验收通过',
  failed: '验收失败',
  stale: '验收已失效',
  review: '待负责人'
}

const TRACE_KIND_TEXT: Record<CollaborationTraceEntry['kind'], string> = {
  artifact: '成果',
  verification: '验收',
  failure: '失败',
  conflict: '冲突',
  task: '任务'
}

function statusIcon(status: SuperTask['status']): ReactNode {
  if (status === 'running') return <Loader2 size={13} className="super-spin" aria-hidden />
  if (status === 'completed') return <CheckCircle2 size={13} aria-hidden />
  if (status === 'queued') return <CircleDashed size={13} aria-hidden />
  if (status === 'stalled') return <AlertTriangle size={13} aria-hidden />
  if (status === 'blocked' || status === 'failed') return <OctagonX size={13} aria-hidden />
  return <CircleDashed size={13} aria-hidden />
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function elapsed(task: SuperTask, now: number): string {
  if (!task.startedAt) return ''
  const end = task.finishedAt ?? now
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function agoText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时前`
}

export function SuperAgentDock(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const panelOpen = useAppStore((s) => s.superPanelOpen)
  const canvasOpen = useAppStore((s) => s.canvas.open)
  const canvasWidth = useAppStore((s) => s.canvasWidth)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const setCanvasWidth = useAppStore((s) => s.setCanvasWidth)
  const closeSuperPanel = useAppStore((s) => s.closeSuperPanel)
  const setSuperMode = useAppStore((s) => s.setSuperMode)
  const stopRun = useAppStore((s) => s.stopRun)
  const stopCollaborationTask = useAppStore((s) => s.stopCollaborationTask)
  const dismissCollaborationStuck = useAppStore((s) => s.dismissCollaborationStuck)
  const retryCollaborationTask = useAppStore((s) => s.retryCollaborationTask)
  const reactivateCollaborationTask = useAppStore((s) => s.reactivateCollaborationTask)
  const confirmCollaborationAction = useAppStore((s) => s.confirmCollaborationAction)
  const sendCollaborationMessage = useAppStore((s) => s.sendCollaborationMessage)
  const cancelCollaborationMessage = useAppStore((s) => s.cancelCollaborationMessage)
  const refreshCollaborationProjection = useAppStore((s) => s.refreshCollaborationProjection)
  const resolveWorkspaceConflict = useAppStore((s) => s.resolveWorkspaceConflict)
  const revokeArtifact = useAppStore((s) => s.revokeArtifact)
  const queryTrace = useAppStore((s) => s.queryTrace)
  const openTraceSnapshot = useAppStore((s) => s.openTraceSnapshot)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const maxWorkersSetting = useAppStore((s) => s.settings.collaborationMaxWorkers)
  const tokenBudgetSetting = useAppStore((s) => s.settings.collaborationTokenBudget)
  const stuckAlertsSetting = useAppStore((s) => s.settings.collaborationStuckAlerts)
  const sharedResources = useAppStore((s) => s.sharedResources)
  const refreshSharedResources = useAppStore((s) => s.refreshSharedResources)
  const run = useAppStore((s) => s.run)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [supplementFor, setSupplementFor] = useState<string | null>(null)
  const [supplementText, setSupplementText] = useState('')
  const [supplementBroadcast, setSupplementBroadcast] = useState(false)
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [reactivateFor, setReactivateFor] = useState<string | null>(null)
  const [reactivateText, setReactivateText] = useState('')
  const [sending, setSending] = useState(false)
  const [actionFeedback, setActionFeedback] = useState<
    Record<string, { state: 'pending' | 'success' | 'uncertain'; text: string }>
  >({})
  const [budgetDraft, setBudgetDraft] = useState(() => String(tokenBudgetSetting))
  useEffect(() => {
    setBudgetDraft(String(tokenBudgetSetting))
  }, [tokenBudgetSetting])
  const [traceOpen, setTraceOpen] = useState(false)
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceError, setTraceError] = useState<string | null>(null)
  const [traceResult, setTraceResult] = useState<CollaborationTraceResult | null>(null)
  const [traceQueryState, setTraceQueryState] = useState<CollaborationTraceQuery | null>(null)

  const visible = Boolean(session?.superMode === true && panelOpen && !canvasOpen)
  const state = session?.superAgent ?? null
  const collaboration = session?.collaboration ?? null
  const active = state?.status === 'running'

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    document.body.classList.toggle('is-super-dock-open', visible)
    return () => document.body.classList.remove('is-super-dock-open')
  }, [visible])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  const messagesInFlight = Boolean(
    collaboration?.messages?.some(
      (message) => message.status === 'pending' || message.status === 'delivered' || message.status === 'read'
    )
  )
  useEffect(() => {
    if (!messagesInFlight) return
    // 补充要求的状态由 Worker 安全步推进；轻量轮询只到所有消息落定为止。
    const timer = window.setInterval(() => void refreshCollaborationProjection(), 600)
    return () => window.clearInterval(timer)
  }, [messagesInFlight, refreshCollaborationProjection])

  useEffect(() => {
    if (!visible) return
    void refreshSharedResources()
    // 共享资源租约由主进程持有；轻量轮询让“谁在用桌面/端口”保持可见。
    const timer = window.setInterval(() => void refreshSharedResources(), 2500)
    return () => window.clearInterval(timer)
  }, [visible, refreshSharedResources])

  const runTaskAction = async (
    key: string,
    verb: string,
    action: () => Promise<boolean>
  ): Promise<void> => {
    setActionFeedback((previous) => ({ ...previous, [key]: { state: 'pending', text: `${verb}中…` } }))
    const ok = await action()
    setActionFeedback((previous) => ({
      ...previous,
      [key]: { state: ok ? 'success' : 'uncertain', text: ok ? `${verb}已提交` : `${verb}待确认` }
    }))
    window.setTimeout(() => {
      setActionFeedback((previous) => {
        if (!previous[key]) return previous
        const next = { ...previous }
        delete next[key]
        return next
      })
    }, 2600)
  }

  const runTraceQuery = async (query: CollaborationTraceQuery, append = false): Promise<void> => {
    setTraceLoading(true)
    setTraceError(null)
    const result = await queryTrace(query)
    setTraceLoading(false)
    if (!result) {
      setTraceError('读取记录失败；请检查项目记录是否仍在本机。')
      return
    }
    setTraceResult((previous) => {
      if (append && previous?.detail && result.detail) {
        return {
          ...result,
          detail: {
            ...result.detail,
            offset: previous.detail.offset,
            content: previous.detail.content + result.detail.content
          }
        }
      }
      return result
    })
  }

  const openTrace = (query: CollaborationTraceQuery): void => {
    setTraceOpen(true)
    setTraceQueryState(query)
    setTraceResult(null)
    void runTraceQuery(query)
  }

  const openTraceEntry = (entry: CollaborationTraceEntry): void => {
    if (entry.kind === 'artifact') {
      openTrace({
        action: 'artifact',
        name: entry.name ?? entry.title.replace(/\s+v\d+$/, ''),
        ...(entry.version !== undefined ? { version: entry.version } : {})
      })
      return
    }
    if (entry.kind === 'task' || entry.kind === 'conflict') {
      if (entry.taskId) openTrace({ action: 'task', taskId: entry.taskId })
      return
    }
    openTrace({
      action: 'verification',
      ...(entry.candidateVersion ? { candidateVersion: entry.candidateVersion } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {})
    })
  }

  const openTraceLink = (link: CollaborationTraceLink): void => {
    if (link.kind === 'snapshot' && link.path) {
      void openTraceSnapshot(link.path)
      return
    }
    if (link.kind === 'artifact') {
      const entry = traceResult?.entries.find((item) => item.id === `artifact:${link.id}`)
      if (entry) {
        openTraceEntry(entry)
        return
      }
      if (link.name) {
        openTrace({ action: 'artifact', name: link.name, ...(link.version !== undefined ? { version: link.version } : {}) })
      }
      return
    }
    if (link.kind === 'verification') {
      const entry = traceResult?.entries.find((item) => item.id === link.id)
      if (entry) {
        openTraceEntry(entry)
        return
      }
      if (link.taskId) openTrace({ action: 'verification', taskId: link.taskId })
      return
    }
    if (link.taskId) openTrace({ action: 'task', taskId: link.taskId })
  }

  const loadMoreTrace = (): void => {
    if (!traceQueryState || !traceResult?.detail?.nextOffset) return
    void runTraceQuery({ ...traceQueryState, offset: traceResult.detail.nextOffset }, true)
  }

  const submitSupplement = async (taskId: string): Promise<void> => {
    if (!supplementText.trim() || sending) return
    setSending(true)
    const targets = supplementBroadcast
      ? [
          taskId,
          ...(state?.tasks ?? [])
            .filter((task) => task.status === 'running' && (task.taskId ?? task.id) !== taskId)
            .map((task) => task.taskId ?? task.id)
        ]
      : [taskId]
    let allOk = true
    for (const target of [...new Set(targets)]) {
      const ok = await sendCollaborationMessage(target, supplementText)
      if (!ok) allOk = false
    }
    setSending(false)
    setActionFeedback((previous) => ({
      ...previous,
      [`${taskId}:supplement`]: {
        state: allOk ? 'success' : 'uncertain',
        text: allOk ? '补充要求已投递' : '补充要求待确认'
      }
    }))
    if (allOk) {
      setSupplementFor(null)
      setSupplementText('')
      setSupplementBroadcast(false)
    }
    window.setTimeout(() => {
      setActionFeedback((previous) => {
        const key = `${taskId}:supplement`
        if (!previous[key]) return previous
        const next = { ...previous }
        delete next[key]
        return next
      })
    }, 2600)
  }

  const submitReply = async (taskId: string, questionId: string): Promise<void> => {
    if (!replyText.trim() || sending) return
    setSending(true)
    const ok = await sendCollaborationMessage(taskId, replyText, undefined, questionId)
    setSending(false)
    if (ok) {
      setReplyFor(null)
      setReplyText('')
    }
  }

  const submitReactivate = async (taskId: string): Promise<void> => {
    if (!reactivateText.trim() || sending) return
    setSending(true)
    const ok = await reactivateCollaborationTask(taskId, reactivateText)
    setSending(false)
    if (ok) {
      setReactivateFor(null)
      setReactivateText('')
    }
  }

  if (!session || !visible) return null

  const maxWidth = Math.max(
    MIN_WIDTH,
    Math.min(maxCanvasWidthForViewport(sidebarWidth, sidebarCollapsed), Math.round(viewportWidth * 0.68))
  )
  const width = Math.max(MIN_WIDTH, Math.min(canvasWidth, maxWidth))
  const allTasks = state?.tasks ?? []
  const activeTasks = allTasks.filter((task) => task.planRemoved !== true)
  const removedTaskCount = allTasks.length - activeTasks.length
  const completed = activeTasks.filter(
    (task) =>
      task.status === 'completed' &&
      !task.needsRetest &&
      (!task.verify || task.verification?.status === 'passed')
  ).length
  const total = activeTasks.length
  const running = activeTasks.filter((task) => task.status === 'running').length
  const retest = activeTasks.filter((task) => task.needsRetest).length
  const verificationReview =
    activeTasks.filter((task) => task.verify && task.verification?.status === 'review').length
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0
  const openConflicts = (state?.conflicts ?? []).filter((conflict) => conflict.status === 'open')
  const artifacts = state?.artifacts ?? []
  const artifactNames = [...new Set(artifacts.map((artifact) => artifact.name))]
  const taskTitle = (taskId?: string): string =>
    state?.tasks.find((task) => (task.taskId ?? task.id) === taskId)?.title ?? '协调者'
  const usageRows = (name: string): Array<{ id: string; task: string; version: number; readAt: number; status: string }> =>
    (state?.tasks ?? []).flatMap((task) =>
      (task.artifactUsage ?? [])
        .filter((usage) => usage.name === name)
        .map((usage) => ({
          id: usage.id,
          task: task.title,
          version: usage.version,
          readAt: usage.readAt,
          status: usage.status
        }))
    )
  const doingTasks = activeTasks.filter((task) => task.status === 'running' && !task.waitingForApproval)
  const waitingTasks = activeTasks.filter(
    (task) => task.waitingForApproval || task.status === 'queued' || task.status === 'blocked'
  )
  const retestTasks = activeTasks.filter((task) => task.needsRetest)
  const reviewTasks = activeTasks.filter((task) => task.verify && task.verification?.status === 'review')
  const failedTasks = activeTasks.filter(
    (task) =>
      ['failed', 'stalled', 'blocked'].includes(task.status) &&
      !(task.verify && task.verification?.status === 'review')
  )
  const stuckTasks = stuckAlertsSetting
    ? activeTasks.filter((task) => task.stuck && task.stuck.status !== 'resolved')
    : []
  const helpItems = [
    stuckTasks.length > 0 ? `处理 ${stuckTasks.length} 个可能卡住的任务（停止或继续等待）` : '',
    activeTasks.some((task) => task.waitingForApproval) ? '批准或拒绝等待中的成员' : '',
    openConflicts.length > 0 ? `选择 ${openConflicts.length} 个文件冲突` : '',
    retestTasks.length > 0 ? `重测 ${retestTasks.length} 个使用旧版成果的任务` : '',
    reviewTasks.length > 0 ? `处理 ${reviewTasks.length} 个待负责人验收` : '',
    failedTasks.length > 0 ? `重试 ${failedTasks.length} 个失败/阻塞任务` : ''
  ].filter(Boolean)
  const shortText = (value: string | undefined, fallback: string): string => {
    const text = (value ?? '').replace(/\s+/g, ' ').trim() || fallback
    return text.length > 90 ? `${text.slice(0, 87)}…` : text
  }
  const doingText =
    doingTasks.length > 0 ? doingTasks.map((task) => task.title).slice(0, 3).join('、') : '暂无成员在执行'
  const waitingText =
    waitingTasks.length > 0
      ? waitingTasks
          .slice(0, 3)
          .map((task) => {
            if (task.waitingForApproval) return `${task.title}：等你批准`
            if (task.status === 'blocked') return `${task.title}：${shortText(task.error, '被阻塞')}`
            return `${task.title}：${shortText(task.waitReason, task.dependsOn.length > 0 ? '等前置任务' : '等并行名额')}`
          })
          .join('；')
      : '没有等待中的任务'
  const helpText = helpItems.length > 0 ? helpItems.join('；') : '暂时不用处理，等成员推进'
  const readOnlyHistory = !active && !run && (state?.status === 'completed' || state?.status === 'cancelled')
  const usage = state?.usage
  const applyBudget = (): void => {
    const value = Math.max(0, Math.min(100_000_000, Math.round(Number(budgetDraft) || 0)))
    setBudgetDraft(String(value))
    if (value !== tokenBudgetSetting) void updateSettings({ collaborationTokenBudget: value })
  }

  return (
    <>
      <ResizeHandle
        value={width}
        min={MIN_WIDTH}
        max={maxWidth}
        edge="left"
        className="super-dock-resizer"
        label="拖动调整 Super-Agent 面板宽度（方向键微调，双击恢复默认）"
        onChange={setCanvasWidth}
        onCommit={(next) => setCanvasWidth(next, true)}
        onReset={() => setCanvasWidth(420, true)}
      />
      <aside
        className="canvas-root super-dock"
        style={{ width }}
        aria-label="Super-Agent 任务面板"
      >
        <header className="super-head">
        <div className="super-head-main">
          <span className="super-head-icon" aria-hidden><Network size={15} strokeWidth={1.6} /></span>
          <div>
            <strong>Super-Agent</strong>
            <span className="super-head-sub">Morrow 负责分工和汇总，成员并行处理</span>
          </div>
        </div>
        <div className="super-head-actions">
          <button
            type="button"
            className="super-icon-btn"
            aria-label="项目记录"
            title="查看成果、失败原因、修复过程和验收结果"
            onClick={() => openTrace({ action: 'list' })}
          >
            <History size={13} aria-hidden />
          </button>
          {active || run ? (
            <button
              type="button"
              className="super-icon-btn is-stop"
              aria-label="停止本次协作（会中断全部成员）"
              title="停止本次协作（会中断全部成员）"
              onClick={() => void stopRun()}
            >
              <Square size={12} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="super-icon-btn"
            title="收起面板（Super-Agent 模式保留，可从输入框旁的 Super 重新打开）"
            onClick={closeSuperPanel}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </header>

      <div className="super-summary">
        <div className="super-goal">
          <span className="super-kicker">目标</span>
          <p>{state?.goal || '在对话里描述目标，Morrow 会拆分任务，成员并行推进。'}</p>
        </div>
        <div className="super-stats">
          <span className="super-stat"><b>{completed}</b>/{total || '—'} 完成</span>
          <span className={['super-stat', running > 0 ? 'is-running' : ''].filter(Boolean).join(' ')}>
            <b>{running}</b> 执行中
          </span>
          {retest > 0 ? <span className="super-stat is-retest"><b>{retest}</b> 需重测</span> : null}
          {verificationReview > 0 ? (
            <span className="super-stat is-retest"><b>{verificationReview}</b> 待验收</span>
          ) : null}
          {usage ? <span className="super-stat">成员用量 {formatTokens(usage.totalTokens)}</span> : null}
          {state ? <span className="super-stat">第 {state.planRevision ?? 1} 版计划</span> : null}
          <span className={['super-state', state ? `is-${state.status}` : 'is-idle'].filter(Boolean).join(' ')}>
            {state ? (state.status === 'running' ? '运行中' : state.status === 'completed' ? '已完成' : state.status === 'partial' ? '部分完成' : state.status === 'cancelled' ? '已取消' : '未完成') : '待命'}
          </span>
        </div>
        {total > 0 ? (
          <div className="super-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </div>

      {total > 0 ? (
        <section className="super-overview" aria-label="协作进度总览">
          <div className="super-overview-head">
            <Network size={13} aria-hidden />
            <strong>协作进度</strong>
            <span>谁在做 · 谁在等 · 你能帮什么</span>
          </div>
          <div className="super-overview-grid">
            <div className="super-overview-item is-doing">
              <span className="super-kicker">谁在做</span>
              <p>{doingText}</p>
            </div>
            <div className="super-overview-item is-waiting">
              <span className="super-kicker">谁在等</span>
              <p>{waitingText}</p>
            </div>
            <div className="super-overview-item is-help">
              <span className="super-kicker">你能帮什么</span>
              <p aria-live="polite">{helpText}</p>
            </div>
          </div>
        </section>
      ) : null}

      {stuckTasks.length > 0 ? (
        <section className="super-collab-banner is-stuck" aria-label="可能卡住的任务">
          <div className="super-collab-head">
            <AlertTriangle size={14} aria-hidden />
            <strong>可能卡住</strong>
            <span className="mono">{stuckTasks.length} 项 · 只提醒，不自动停止</span>
          </div>
          <ul className="super-stuck-list">
            {stuckTasks.map((task) => {
              const alert = task.stuck
              if (!alert) return null
              const taskId = task.taskId ?? task.id
              const feedback = actionFeedback[`${taskId}:stuck`]
              return (
                <li key={alert.id}>
                  <div className="super-stuck-copy">
                    <div className="super-stuck-title">
                      <b>{task.title}</b>
                      <span>{task.status === 'running' ? '仍在执行' : STATUS_TEXT[task.status]}</span>
                    </div>
                    <p>{alert.reason}</p>
                    <em>
                      最后一次有效进展：
                      {alert.lastEffectiveAt > 0 ? agoText(now - alert.lastEffectiveAt) : '本次执行还没有新成果'}
                      {alert.lastOperation ? ` · 最近操作：${shortText(alert.lastOperation, '')}` : ''}
                    </em>
                    {alert.evidence && alert.evidence.length > 0 ? (
                      <details className="super-stuck-evidence">
                        <summary>查看判断依据（{alert.evidence.length} 步）</summary>
                        <ul>
                          {alert.evidence.map((operation) => (
                            <li key={operation.id}>
                              <span className={operation.effective ? 'is-effective' : ''}>
                                {operation.effective
                                  ? '有成果'
                                  : operation.status === 'error' || operation.status === 'denied'
                                    ? '未完成'
                                    : operation.status === 'running'
                                      ? '执行中'
                                      : '完成'}
                              </span>
                              <code>{operation.title}</code>
                              {operation.target ? <em>{operation.target}</em> : null}
                              {operation.error ? <small>{operation.error}</small> : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  <div className="super-stuck-actions">
                    <button
                      type="button"
                      onClick={() =>
                        void runTaskAction(`${taskId}:stuck`, '关闭提醒', () =>
                          dismissCollaborationStuck(taskId)
                        )
                      }
                    >
                      继续等待
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() =>
                        void runTaskAction(`${taskId}:stuck`, '停止', () => stopCollaborationTask(taskId))
                      }
                    >
                      停止这项（释放名额）
                    </button>
                  </div>
                  {feedback ? (
                    <span className={`super-stuck-feedback is-${feedback.state}`} role="status">
                      {feedback.text}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <p className="super-stuck-note">
            停止只影响这一项，其他成员和已交付文件保留；本机检查只读取任务记录，不写入原文件或独立副本。
          </p>
        </section>
      ) : null}

      {usage?.overBudget ? (
        <div className="super-collab-banner is-warning" role="status">
          <AlertTriangle size={14} aria-hidden />
          <div>
            <strong>成员用量已达上限</strong>
            <p>
              已用 {formatTokens(usage.totalTokens)} / 上限 {formatTokens(usage.budgetTokens)}；只会暂停新任务，不会删除已开始的记录。
              可在下方“运行设置”调高上限后重试。
            </p>
          </div>
        </div>
      ) : null}

      <details className="super-limits">
        <summary>
          <span className="super-kicker">运行设置</span>
          <span>
            {maxWorkersSetting > 0 ? `最多 ${maxWorkersSetting} 人同时运行` : '自动并发（按 CPU 留一核）'}
            {' · '}
            成员用量 {formatTokens(usage?.totalTokens ?? 0)} /{' '}
            {usage?.budgetTokens ? formatTokens(usage.budgetTokens) : '不限'}
            {' · '}
            {stuckAlertsSetting ? '卡住提醒开' : '卡住提醒关'}
          </span>
        </summary>
        <div className="super-limits-grid">
          <label>
            <span>同时运行</span>
            <select
              value={maxWorkersSetting}
              aria-label="同时运行的成员上限"
              onChange={(event) =>
                void updateSettings({ collaborationMaxWorkers: Number(event.target.value) })
              }
            >
              <option value={0}>自动（留一核给界面/路由）</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => (
                <option key={value} value={value}>
                  {value} 人
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>成员用量上限</span>
            <input
              type="number"
              min={0}
              max={100_000_000}
              step={1_000}
              value={budgetDraft}
              aria-label="成员用量上限（0 为不限）"
              onChange={(event) => setBudgetDraft(event.target.value)}
              onBlur={applyBudget}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyBudget()
                }
              }}
            />
          </label>
          <label className="super-limits-switch">
            <span>卡住提醒</span>
            <span className="super-switch">
              <input
                type="checkbox"
                checked={stuckAlertsSetting}
                aria-label="成员可能卡住时提醒负责人"
                onChange={(event) => void updateSettings({ collaborationStuckAlerts: event.target.checked })}
              />
              <i aria-hidden />
            </span>
            <em>只在有依据时提醒，绝不自动停止</em>
          </label>
        </div>
        <p>重试也会计入用量；达到上限只会暂停新任务，不会删除记录。</p>
      </details>

      {readOnlyHistory ? (
        <div className="super-collab-banner is-readonly" role="status">
          <CheckCircle2 size={14} aria-hidden />
          <div>
            <strong>本次已完成（只读）</strong>
            <p>本次协作已结束：已完成项不再提供停止/重试；需要继续时可用「重新激活」带原线程执行。打开旧会话只查看记录，不会自动触发执行。</p>
          </div>
        </div>
      ) : null}

      {collaboration?.readOnly ? (
        <div className="super-collab-banner is-readonly" role="status">
          <AlertTriangle size={14} aria-hidden />
          <div>
            <strong>协作记录只读</strong>
            <p>{collaboration.readOnlyReason ?? '本地进度记录暂时无法写入；原记录已保留。'}</p>
          </div>
        </div>
      ) : null}

      {collaboration && collaboration.uncertain.length > 0 ? (
        <section className="super-collab-banner is-review" aria-label="待核对动作">
          <div className="super-collab-head">
            <AlertTriangle size={14} aria-hidden />
            <strong>待核对</strong>
            <span className="mono">{collaboration.uncertain.length} 项</span>
          </div>
          <ul className="super-collab-list">
            {collaboration.uncertain.slice(0, 4).map((action) => (
              <li key={action.id}>
                <div>
                  <span>{action.label}</span>
                  <em>{action.error ?? '执行结果不明确，请先核对文件。'}</em>
                </div>
                <button
                  type="button"
                  onClick={() => void confirmCollaborationAction(action.id)}
                  title="确认已核对这条动作；不会再次执行"
                >
                  标记已核对
                </button>
              </li>
            ))}
          </ul>
          {collaboration.uncertain.length > 4 ? (
            <p className="super-collab-more">还有 {collaboration.uncertain.length - 4} 项待核对，请先处理当前项。</p>
          ) : null}
        </section>
      ) : null}

      {openConflicts.length > 0 ? (
        <section className="super-collab-banner is-conflict" aria-label="文件冲突待选择">
          <div className="super-collab-head">
            <GitMerge size={14} aria-hidden />
            <strong>文件冲突</strong>
            <span className="mono">{openConflicts.length} 项待选择</span>
          </div>
          <p className="super-conflict-intro">主文件没有被覆盖，两个版本都保留。选择后再继续下游任务。</p>
          <ul className="super-conflict-list">
            {openConflicts.slice(0, 4).map((conflict) => (
              <li key={conflict.id}>
                <div className="super-conflict-copy">
                  <span className="super-conflict-path" title={conflict.path}>{conflict.path}</span>
                  <em>{CONFLICT_REASON[conflict.reason]} · 两份改动均已保留</em>
                  {conflict.currentPreview || conflict.incomingPreview ? (
                    <details className="super-conflict-details">
                      <summary>查看两份改动</summary>
                      <div className="super-conflict-preview">
                        <div>
                          <b>当前主文件</b>
                          <pre>{conflict.currentPreview ?? '（文件不存在或为空）'}</pre>
                        </div>
                        <div>
                          <b>成员版本</b>
                          <pre>{conflict.incomingPreview ?? '（删除、空文件或二进制）'}</pre>
                        </div>
                      </div>
                    </details>
                  ) : null}
                </div>
                <div className="super-conflict-actions">
                  {!readOnlyHistory ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void runTaskAction(conflict.id, '处理冲突', () =>
                            resolveWorkspaceConflict(conflict.id, 'current')
                          )
                        }
                        title="保留主文件当前内容，丢弃成员版本"
                      >
                        保留主版本
                      </button>
                      <button
                        type="button"
                        className="is-primary"
                        onClick={() =>
                          void runTaskAction(conflict.id, '处理冲突', () =>
                            resolveWorkspaceConflict(conflict.id, 'incoming')
                          )
                        }
                        title="用成员版本覆盖主文件；冲突后主文件再次变化时会拒绝"
                      >
                        采用成员版本
                      </button>
                    </>
                  ) : null}
                  {actionFeedback[conflict.id] ? (
                    <span className={`super-task-action is-${actionFeedback[conflict.id].state}`} role="status">
                      {actionFeedback[conflict.id].text}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {openConflicts.length > 4 ? (
            <p className="super-collab-more">还有 {openConflicts.length - 4} 个冲突，请先处理当前项。</p>
          ) : null}
        </section>
      ) : null}

      {artifactNames.length > 0 ? (
        <section className="super-artifacts" aria-label="成果版本">
          <div className="super-artifact-head">
            <Package size={13} aria-hidden />
            <strong>成果版本</strong>
            <span className="mono">{artifactNames.length} 项</span>
          </div>
          <ul className="super-artifact-list">
            {artifactNames.slice(0, 6).map((name) => {
              const versions = artifacts
                .filter((artifact) => artifact.name === name)
                .slice()
                .sort((a, b) => b.version - a.version)
              const latest = versions[0]
              const latestReady = versions.find((artifact) => artifact.status === 'ready')
              const rows = usageRows(name)
              const statusText = latest.status === 'ready' ? '可用' : latest.status === 'draft' ? '草稿' : '已撤回'
              return (
                <li key={name} className={`super-artifact is-${latest.status}`}>
                  <div className="super-artifact-copy">
                    <span className="super-artifact-name">
                      {name}
                      <b className="mono">v{latest.version}</b>
                      <em className={`is-${latest.status}`}>{statusText}</em>
                    </span>
                    <span className="super-artifact-meta">
                      {taskTitle(latest.taskId)} · {versions.length} 版
                      {latestReady && latestReady.version !== latest.version
                        ? ` · 当前可用 v${latestReady.version}`
                        : ''}
                      {rows.length > 0 ? ` · ${rows.length} 次使用` : ' · 暂无使用记录'}
                    </span>
                    {rows.length > 0 ? (
                      <details className="super-artifact-usage">
                        <summary>查看谁用了哪一版</summary>
                        <ul>
                          {rows.slice(-6).map((row) => (
                            <li key={row.id}>
                              <span>{row.task}</span>
                              <em className={row.status === 'outdated' ? 'is-outdated' : ''}>
                                v{row.version} · {new Date(row.readAt).toLocaleTimeString('zh-CN', { hour12: false })}
                                {row.status === 'outdated' ? ' · 旧版' : ''}
                              </em>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="super-artifact-trace"
                    title="查看这个成果的版本、使用记录与关联验收"
                    onClick={() =>
                      openTrace({ action: 'artifact', name: latest.name, version: latest.version })
                    }
                  >
                    <History size={10} aria-hidden /> 记录
                  </button>
                  {latest.status === 'ready' ? (
                    <button
                      type="button"
                      className="super-artifact-revoke"
                      title="撤回这一版的可用标记；旧版本与使用记录保留，需要重测的任务会恢复"
                      onClick={() =>
                        void runTaskAction(`${name}:revoke`, '撤回', () => revokeArtifact(latest.name, latest.version))
                      }
                    >
                      <Undo2 size={10} aria-hidden /> 撤回
                    </button>
                  ) : null}
                  {actionFeedback[`${name}:revoke`] ? (
                    <span className={`super-task-action is-${actionFeedback[`${name}:revoke`].state}`} role="status">
                      {actionFeedback[`${name}:revoke`].text}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {artifactNames.length > 6 ? (
            <p className="super-collab-more">还有 {artifactNames.length - 6} 项成果，请先处理当前项。</p>
          ) : null}
        </section>
      ) : null}

      {collaboration?.nextAction ? (
        <p className="super-next-action">
          <Clock3 size={12} aria-hidden />
          <span>下一项：{collaboration.nextAction.label}</span>
        </p>
      ) : null}

      <div className="super-body">
        {state && state.tasks.length > 0 ? (
        <>
          <ol className="super-tasks">
            {activeTasks.map((task) => {
              const isOpen = expanded === task.id
              const operations = task.operations ?? []
              const anyRunning = activeTasks.some((item) => item.status === 'running')
              const taskId = task.taskId ?? task.id
              const taskMessages = (collaboration?.messages ?? []).filter((message) => message.taskId === taskId)
              const currentUsage = (task.artifactUsage ?? []).filter(
                (usage) => usage.attemptId === task.currentAttemptId
              )
              const canRetry =
                !active &&
                !run &&
                !readOnlyHistory &&
                task.planRemoved !== true &&
                task.status !== 'running' &&
                (task.status !== 'completed' || task.needsRetest === true)
              const feedback = actionFeedback[taskId]
              const retryLabel = task.verify ? '重试验收' : task.needsRetest ? '重测' : '重试'
              const canReactivate =
                !anyRunning && ['completed', 'failed', 'cancelled', 'blocked', 'stalled'].includes(task.status)
              const showTrace = Boolean(task.error) && ['failed', 'stalled', 'blocked'].includes(task.status)
              const hasActions =
                (task.status === 'running' && !readOnlyHistory) || canRetry || canReactivate || showTrace
              return (
                <li key={task.id} className={`super-task is-${task.status}`}>
                  <div className="super-task-top">
                  <button
                    type="button"
                    className="super-task-main"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : task.id)}
                  >
                    <span className="super-task-index mono">{String(task.index + 1).padStart(2, '0')}</span>
                    <span className="super-task-status" title={STATUS_TEXT[task.status]}>{statusIcon(task.status)}</span>
                    <span className="super-task-copy">
                      <span className="super-task-title">{task.title}</span>
                      <span className="super-task-meta">
                        <span>负责人：{task.roleTitle ?? task.role}</span>
                        {task.dependsOn.length > 0 ? (
                          <span className="super-dep">
                            <GitBranch size={10} aria-hidden /> {task.dependsOn.join(' / ')}
                          </span>
                        ) : null}
                        {task.stepCount ? <span>{task.stepCount} 步</span> : null}
                        {task.startedAt ? (
                          <span className="mono"><Clock3 size={10} aria-hidden /> {elapsed(task, now)}</span>
                        ) : null}
                        {task.attempts > 1 ? <span>第 {task.attempts} 次尝试</span> : null}
                        {task.usage ? <span>用量 {formatTokens(task.usage.totalTokens)}</span> : null}
                        {task.needsRetest ? <span className="super-task-retest">需重测</span> : null}
                        {task.verify ? (
                          <span className={`super-task-verify is-${task.verification?.status ?? 'pending'}`}>
                            {VERIFICATION_TEXT[task.verification?.status ?? 'pending']}
                          </span>
                        ) : null}
                        {task.earlyStartedBy?.length ? <span className="super-task-early">提前开工</span> : null}
                        {currentUsage.length > 0 ? (
                          <span className="super-task-artifact">
                            成果 {currentUsage.map((usage) => `${usage.name} v${usage.version}`).join('、')}
                          </span>
                        ) : null}
                        {task.conflictCount ? <span className="super-task-conflict">{task.conflictCount} 个冲突</span> : null}
                        {task.waitingForApproval ? (
                          <span className="super-task-waiting">
                            <Clock3 size={10} aria-hidden /> 等待批准
                          </span>
                        ) : null}
                        {task.stuck && task.stuck.status !== 'resolved' && stuckAlertsSetting ? (
                          <span className="super-task-stuck" title={task.stuck.reason}>
                            <AlertTriangle size={10} aria-hidden /> 可能卡住
                          </span>
                        ) : null}
                        {task.planRemoved ? <span className="super-task-removed">已从计划移除</span> : null}
                        {task.taskId ? (
                          <span className="super-task-id mono" title={task.taskId}>
                            #{task.taskId.slice(-6)}
                          </span>
                        ) : null}
                        {taskMessages.length > 0 ? <span>{taskMessages.length} 条补充</span> : null}
                      </span>
                      {task.note && task.status === 'running' && !task.waitingForApproval ? (
                        <span className="super-task-note">{task.note}</span>
                      ) : null}
                      {task.waitingForApproval ? (
                        <span className="super-task-wait">等你批准；批准或拒绝后继续，看门狗暂停计时</span>
                      ) : null}
                      {task.status === 'queued' && task.waitReason ? (
                        <span className="super-task-wait">
                          {task.waitReason.startsWith('等待') ? task.waitReason : `等待：${task.waitReason}`}
                        </span>
                      ) : null}
                      {task.status === 'completed' && task.summary ? (
                        <span className="super-task-handoff" title={task.summary}>
                          最近交接：{shortText(task.summary, '')}
                        </span>
                      ) : null}
                      {task.error ? <span className="super-task-error">{task.error}</span> : null}
                    </span>
                    {operations.length > 0 ? (
                      <ChevronDown size={13} className={['super-task-chevron', isOpen ? 'is-open' : ''].filter(Boolean).join(' ')} aria-hidden />
                    ) : null}
                  </button>
                  {hasActions ? (
                    <div className="super-task-actions">
                  {task.status === 'running' && !readOnlyHistory ? (
                    <button
                      type="button"
                      className="super-task-stop"
                      aria-label={`停止任务：${task.title}`}
                      title={task.waitingForApproval ? '取消等待并停止这项任务，其他任务继续' : '只停止这项任务，其他任务继续'}
                      onClick={() =>
                        void runTaskAction(taskId, '停止', () => stopCollaborationTask(task.taskId ?? task.id))
                      }
                    >
                      <Square size={10} aria-hidden />
                    </button>
                  ) : null}
                  {canRetry ? (
                    <button
                      type="button"
                      className="super-task-retry"
                      aria-label={
                        task.verify ? `重试验收：${task.title}` : `${task.needsRetest ? '重测' : '重试'}任务：${task.title}`
                      }
                      title={
                        task.verify
                          ? '在最新交付文件上重新验收；失败会自动退回作者返工'
                          : task.needsRetest
                            ? '按最新成果重测这一项；未受影响的完成项不会重跑'
                            : '只重试这一项；已完成的任务不会重跑'
                      }
                      onClick={() => void runTaskAction(taskId, retryLabel, () => retryCollaborationTask(taskId))}
                    >
                      <RotateCcw size={10} aria-hidden />
                    </button>
                  ) : null}
                  {canReactivate ? (
                    <button
                      type="button"
                      className="super-task-reactivate"
                      aria-label={`重新激活任务：${task.title}`}
                      title="带原线程、原待办继续；可以发新指令，不会删掉已有结果"
                      onClick={() => {
                        setReactivateFor(taskId)
                        setReactivateText('')
                      }}
                    >
                      <Play size={10} aria-hidden />
                    </button>
                  ) : null}
                  {showTrace ? (
                    <button
                      type="button"
                      className="super-task-trace"
                      aria-label={`失败记录：${task.title}`}
                      title="查看失败对应的成果版本、修复过程和验收记录"
                      onClick={() => openTrace({ action: 'task', taskId })}
                    >
                      <History size={10} aria-hidden />
                    </button>
                  ) : null}
                    </div>
                  ) : null}
                  </div>
                  {feedback ? (
                    <span className={`super-task-action is-${feedback.state}`} role="status">
                      {feedback.text}
                    </span>
                  ) : null}
                  {isOpen ? (
                    <div className="super-task-detail">
                      {task.deliverable || (task.needs?.length ?? 0) > 0 || task.waitReason || (task.files?.length ?? 0) > 0 ? (
                        <div className="super-detail-block super-plan-block">
                          <span className="super-kicker">计划</span>
                          {task.deliverable ? (
                            <p className="super-deliverable">交付：{task.deliverable}</p>
                          ) : null}
                          {(task.needs?.length ?? 0) > 0 ? (
                            <>
                              <p className="super-needs-label">需要</p>
                              <ul className="super-needs">
                                {task.needs!.map((need) => {
                                  const source = state.tasks.find((item) => (item.planKey ?? item.id) === need.taskId)
                                  return (
                                    <li key={`${need.taskId}:${need.result}`}>
                                      <b>{source?.title ?? need.taskId}</b>
                                      <span>
                                        {need.result}
                                        {need.artifact
                                          ? ` · 成果 ${need.artifact}${need.artifactVersion ? ` v${need.artifactVersion}+` : ''}`
                                          : ''}
                                      </span>
                                    </li>
                                  )
                                })}
                              </ul>
                            </>
                          ) : null}
                          {task.waitReason ? (
                            <p className="super-wait-reason">等待理由：{task.waitReason}</p>
                          ) : null}
                          {(task.files?.length ?? 0) > 0 ? (
                            <p className="super-files">文件：{task.files!.join('、')}</p>
                          ) : null}
                        </div>
                      ) : null}
                      {task.verify ? (
                        <div className="super-detail-block super-verify-block">
                          <div className="super-verify-head">
                            <span className="super-kicker">独立验收</span>
                            <button
                              type="button"
                              className="super-task-trace"
                              title="从这条验收追到候选版本、原始文件和完整输出"
                              onClick={() =>
                                openTrace({
                                  action: 'verification',
                                  taskId: task.taskId ?? task.id,
                                  ...(task.verification?.candidateVersion
                                    ? { candidateVersion: task.verification.candidateVersion }
                                    : {})
                                })
                              }
                            >
                              <History size={10} aria-hidden /> 记录
                            </button>
                          </div>
                          <p className="super-verify-line">
                            候选 <span className="mono">{task.verification?.candidateVersion || '待计算'}</span> ·{' '}
                            {VERIFICATION_TEXT[task.verification?.status ?? 'pending']}
                            {task.verification
                              ? ` · 自动返工 ${task.verification.reworkCount}/${task.verification.maxReworks}`
                              : ''}
                          </p>
                          {task.verification?.command ? (
                            <>
                              <p className="super-verify-command">
                                命令：<code>{task.verification.command.command}</code> · 退出码{' '}
                                {task.verification.command.exitCode ?? 'null'}
                                {task.verification.command.timedOut ? '（超时）' : ''}
                              </p>
                              {task.verification.command.output?.trim() ? (
                                <details className="super-verify-output">
                                  <summary>查看命令输出</summary>
                                  <pre>{task.verification.command.output}</pre>
                                </details>
                              ) : null}
                            </>
                          ) : null}
                          {task.verification && task.verification.files.length > 0 ? (
                            <ul className="super-verify-files">
                              {task.verification.files.map((file) => (
                                <li key={file.path}>
                                  <span>
                                    {file.path}
                                    {file.required ? '（必需）' : ''}
                                  </span>
                                  <em className={file.exists ? '' : 'is-missing'}>
                                    {file.exists ? '存在' : '缺失'}
                                    {file.hash ? ` · ${file.hash.slice(0, 8)}` : ''}
                                  </em>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {task.verification?.error ? (
                            <p className="super-verify-error">{task.verification.error}</p>
                          ) : null}
                          {(task.verificationHistory?.length ?? 0) > 0 ? (
                            <details className="super-verify-history">
                              <summary>失败 / 通过记录</summary>
                              <ul>
                                {task.verificationHistory!.map((record) => (
                                  <li key={record.id}>
                                    <span className="mono">{record.candidateVersion || '未计算'}</span>
                                    <em className={`is-${record.status}`}>
                                      {VERIFICATION_TEXT[record.status]} · 第 {record.attempt} 次
                                    </em>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                      {task.needsRetest || (task.artifactUsage?.length ?? 0) > 0 ? (
                        <div className="super-detail-block">
                          <span className="super-kicker">成果使用</span>
                          {task.needsRetest ? (
                            <p className="super-retest-note">
                              使用了旧版成果：{(task.staleArtifacts ?? []).join('；') || '最新版本已更新'}。旧版结果不能给新版签字，请按最新成果重测或确认不受影响。
                            </p>
                          ) : null}
                          <ul className="super-artifact-usage-list">
                            {(task.artifactUsage ?? []).slice(-6).map((usage) => (
                              <li key={usage.id}>
                                <span>
                                  {usage.name} v{usage.version}
                                </span>
                                <em className={usage.status === 'outdated' ? 'is-outdated' : ''}>
                                  {usage.status === 'outdated' ? '旧版，需重测' : '当前版本'} ·{' '}
                                  {new Date(usage.readAt).toLocaleTimeString('zh-CN', { hour12: false })} · 尝试{' '}
                                  {usage.attemptId.slice(-4)}
                                </em>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {task.workspaceCopy ? (
                        <div className="super-detail-block">
                          <span className="super-kicker">独立副本</span>
                          <p className="super-workspace-copy">
                            {task.workspaceCopy.mode === 'git-worktree' ? 'Git worktree' : '文件夹复制'}
                            {' · 起始 '}
                            {task.workspaceCopy.baseVersion}
                            <br />
                            <span title={task.workspaceCopy.path}>{task.workspaceCopy.path}</span>
                          </p>
                        </div>
                      ) : null}
                      {task.conflictCount ? (
                        <p className="super-conflict-note">
                          有 {task.conflictCount} 个文件冲突待选择；主文件未被覆盖，两版都在上方的“文件冲突”里。
                        </p>
                      ) : null}
                      {task.summary ? (
                        <div className="super-detail-block">
                          <span className="super-kicker">成员结论</span>
                          <p>{task.summary}</p>
                        </div>
                      ) : null}
                      <div className="super-detail-block">
                        <div className="super-supplement-head">
                          <span className="super-kicker">补充要求</span>
                          {!readOnlyHistory && (task.status === 'running' || task.status === 'queued') ? (
                            <button
                              type="button"
                              className="super-supplement-toggle"
                              onClick={() => {
                                setSupplementFor(supplementFor === taskId ? null : taskId)
                                setSupplementText('')
                              }}
                            >
                              {supplementFor === taskId ? '收起' : '补充'}
                            </button>
                          ) : null}
                        </div>
                        {actionFeedback[`${taskId}:supplement`] ? (
                          <span
                            className={`super-task-action is-${actionFeedback[`${taskId}:supplement`].state}`}
                            role="status"
                          >
                            {actionFeedback[`${taskId}:supplement`].text}
                          </span>
                        ) : null}
                        {taskMessages.length > 0 ? (
                          <ul className="super-msg-list">
                            {taskMessages.slice(-8).map((message) => (
                              <li key={message.id} data-status={message.status} className={`is-${message.direction} is-${message.kind}`}>
                                <div>
                                  <span className="super-msg-author">
                                    {message.direction === 'worker'
                                      ? `${message.author ?? '成员'}${message.kind === 'question' ? ' · 提问' : ' · 汇报'}`
                                      : message.kind === 'answer'
                                        ? '你 · 答复'
                                        : '你 · 补充'}
                                  </span>
                                  <span>{message.text}</span>
                                  <em>
                                    {MESSAGE_STATUS_TEXT[message.status]}
                                    {message.error ? ` · ${message.error}` : ''}
                                  </em>
                                </div>
                                {message.direction === 'worker' &&
                                message.kind === 'question' &&
                                !readOnlyHistory &&
                                (message.status === 'pending' || message.status === 'delivered') ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setReplyFor(message.id)
                                      setReplyText('')
                                    }}
                                  >
                                    答复
                                  </button>
                                ) : null}
                                {message.direction === 'main' &&
                                (message.status === 'pending' ||
                                  message.status === 'delivered' ||
                                  message.status === 'read') ? (
                                  <button
                                    type="button"
                                    onClick={() => void cancelCollaborationMessage(message.id)}
                                  >
                                    不再关注
                                  </button>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {replyFor && taskMessages.some((message) => message.id === replyFor) ? (
                          <div className="super-msg-form">
                            <textarea
                              value={replyText}
                              rows={2}
                              maxLength={8_000}
                              placeholder="回复成员的提问；会立即送达正在等待的成员。"
                              aria-label={`回复「${task.title}」的成员`}
                              onChange={(event) => setReplyText(event.target.value)}
                            />
                            <div className="super-msg-form-foot">
                              <span>回复只补充信息，不改变成员的工具或目录权限</span>
                              <button type="button" onClick={() => setReplyFor(null)}>
                                取消
                              </button>
                              <button
                                type="button"
                                className="is-primary"
                                disabled={!replyText.trim() || sending}
                                onClick={() => void submitReply(taskId, replyFor)}
                              >
                                {sending ? '发送中…' : '发送答复'}
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {supplementFor === taskId ? (
                          <div className="super-msg-form">
                            <textarea
                              value={supplementText}
                              rows={2}
                              maxLength={8_000}
                              placeholder="只补充这项任务；成员会在下一步读取，不会扩大权限。"
                              aria-label={`给「${task.title}」的补充要求`}
                              onChange={(event) => setSupplementText(event.target.value)}
                            />
                            <label className="super-msg-broadcast">
                              <input
                                type="checkbox"
                                checked={supplementBroadcast}
                                onChange={(event) => setSupplementBroadcast(event.target.checked)}
                              />
                              同时发给其他运行中的任务
                            </label>
                            <div className="super-msg-form-foot">
                              <span>只作信息补充，不改变权限；没指定成员的要求请在输入框发给协调助手</span>
                              <button
                                type="button"
                                className="is-primary"
                                disabled={!supplementText.trim() || sending}
                                onClick={() => void submitSupplement(taskId)}
                              >
                                {sending ? '保存中…' : '保存并投递'}
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {reactivateFor === taskId ? (
                          <div className="super-msg-form">
                            <textarea
                              value={reactivateText}
                              rows={2}
                              maxLength={8_000}
                              placeholder="告诉这位成员接下来做什么；原有线程、待办和成果都会保留。"
                              aria-label={`重新激活「${task.title}」`}
                              onChange={(event) => setReactivateText(event.target.value)}
                            />
                            <div className="super-msg-form-foot">
                              <span>带原线程继续；不会重跑其他已完成任务</span>
                              <button type="button" onClick={() => setReactivateFor(null)}>
                                取消
                              </button>
                              <button
                                type="button"
                                className="is-primary"
                                disabled={!reactivateText.trim() || sending}
                                onClick={() => void submitReactivate(taskId)}
                              >
                                {sending ? '启动中…' : '重新激活'}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {task.workerTodos && task.workerTodos.length > 0 ? (
                        <div className="super-detail-block">
                          <span className="super-kicker">成员待办</span>
                          <ul className="super-worker-todos">
                            {task.workerTodos.map((todo) => (
                              <li key={todo.id} className={`is-${todo.status}`}>
                                <CheckCircle2 size={11} aria-hidden />
                                <span>{todo.text}</span>
                                <em>{todo.status === 'completed' ? '完成' : todo.status === 'in_progress' ? '进行中' : '待办'}</em>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {operations.length > 0 ? (
                        <div className="super-detail-block">
                          <span className="super-kicker">执行记录</span>
                          <ul className="super-ops">
                            {operations.map((operation) => (
                              <li key={operation.id} className={`is-${operation.status}`}>
                                <span>{operation.title || operation.name}</span>
                                <em>{operation.error || operation.output || operation.status}</em>
                                {operation.diffPreview ? (
                                  <details className="super-op-diff">
                                    <summary>查看这次改动</summary>
                                    <pre>{operation.diffPreview}</pre>
                                  </details>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="super-detail-empty">成员还没有返回操作记录。</p>
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
          {removedTaskCount > 0 ? (
            <p className="super-removed-note">
              已从当前计划移除 {removedTaskCount} 个旧任务；记录和成果仍保留。
            </p>
          ) : null}
        </>
      ) : (
          <div className="super-empty">
            <span className="super-empty-mark" aria-hidden><Network size={22} strokeWidth={1.3} /></span>
            <h3>把目标交给 Morrow</h3>
            <p>Morrow 会拆分任务、复核结果；写入、命令和外部操作交给并行成员。</p>
            <ol>
              <li>在对话里说清要交付什么、验收标准和不能碰的范围。</li>
              <li>Morrow 会按依赖顺序安排成员任务。</li>
              <li>成员的步骤与结论只进这里，不刷屏。</li>
            </ol>
            <span className="super-empty-hint">失败或停滞的成员会被标记；依赖未完成的任务会自动阻塞。</span>
          </div>
        )}
      </div>

      {traceOpen ? (
        <section className="super-trace" role="dialog" aria-label="项目记录">
          <header className="super-trace-head">
            <div>
              <History size={13} aria-hidden />
              <strong>项目记录</strong>
              <span>默认短摘要，需要时打开原文件或继续读</span>
            </div>
            <button type="button" className="super-trace-close" onClick={() => setTraceOpen(false)}>
              <X size={12} aria-hidden />
            </button>
          </header>
          {traceLoading ? <p className="super-trace-status">读取记录…</p> : null}
          {traceError ? <p className="super-trace-error">{traceError}</p> : null}
          {traceResult ? (
            <>
              <p className="super-trace-usage">
                短引用 {traceResult.usage.summaryChars} 字符 · 完整内容约 {traceResult.usage.fullChars} 字符
              </p>
              <ul className="super-trace-list">
                {traceResult.entries.slice(0, 20).map((entry) => (
                  <li key={entry.id}>
                    <button type="button" className="super-trace-entry" onClick={() => openTraceEntry(entry)}>
                      <span className={`super-trace-kind is-${entry.kind}`}>{TRACE_KIND_TEXT[entry.kind]}</span>
                      <span className="super-trace-title">{entry.title}</span>
                      <em>{entry.summary}</em>
                      <span className="super-trace-meta">
                        {entry.applicableVersions.length > 0 ? `适用：${entry.applicableVersions.join('、')}` : ''}
                        {entry.staleForCurrent ? ' · 历史依据' : ''}
                        {entry.missing ? ' · 快照缺失' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {traceResult.detail ? (
                <div className="super-trace-detail">
                  <div className="super-trace-detail-head">
                    <strong>{traceResult.detail.entry.title}</strong>
                    {traceResult.detail.missing ? <span className="is-missing">原始快照缺失</span> : null}
                    {traceResult.detail.snapshotPath && !traceResult.detail.missing ? (
                      <button
                        type="button"
                        onClick={() => {
                          const path = traceResult.detail?.snapshotPath
                          if (path) void openTraceSnapshot(path)
                        }}
                      >
                        打开原文件
                      </button>
                    ) : null}
                  </div>
                  {traceResult.detail.missing ? (
                    <p className="super-trace-missing">原始文件缺失，不能用其他版本代替。</p>
                  ) : (
                    <pre>{traceResult.detail.content}</pre>
                  )}
                  <div className="super-trace-detail-foot">
                    <span>
                      {traceResult.detail.offset}–
                      {traceResult.detail.offset + traceResult.detail.content.length} /{' '}
                      {traceResult.detail.totalChars}
                    </span>
                    {traceResult.detail.nextOffset !== undefined ? (
                      <button type="button" onClick={loadMoreTrace}>
                        继续读取
                      </button>
                    ) : (
                      <span>已读到末尾</span>
                    )}
                  </div>
                  {traceResult.detail.entry.links.length > 0 ? (
                    <div className="super-trace-links">
                      <span className="super-kicker">关联</span>
                      {traceResult.detail.entry.links.map((link) => (
                        <button
                          type="button"
                          key={`${link.kind}:${link.id}:${link.label}`}
                          onClick={() => openTraceLink(link)}
                        >
                          {link.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {sharedResources.length > 0 ? (
        <div className="super-resource-line" title="同一桌面或端口一次只允许一个任务独占">
          <span className="super-kicker">共享资源</span>
          {sharedResources.map((resource) => (
            <span key={resource.id} className="super-resource-item">
              {resource.kind === 'desktop' ? '桌面' : `端口 ${resource.resource.replace(/^port:/, '')}`}
              {' · '}
              {resource.ownerLabel}
            </span>
          ))}
        </div>
      ) : null}

      <footer className="super-foot">
        <span
          className="super-foot-hint"
          title="Morrow 不直接执行写操作；15 分钟没有进展会暂停，等你批准时继续。"
        >
          Morrow 负责分工和汇总；15 分钟没有进展会暂停；需要你确认时会暂停
        </span>
        <span className="super-foot-actions">
          <button type="button" onClick={closeSuperPanel} title="收起面板，但保留 Super-Agent 模式">
            收起
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => void setSuperMode(false)}
            title="退出试点：停止新派工，在途成员继续完成；记录和文件保留"
          >
            退出
          </button>
        </span>
      </footer>
      </aside>
    </>
  )
}
