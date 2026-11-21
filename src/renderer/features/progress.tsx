// progress 功能域组件：右上角「进展更新」浮窗。
// 数据来自真实的 RuntimeEvent 与主进程 IslandSnapshot，不另造进度状态。
// 浮窗不参与主布局，收起后变成右上角胶囊，不保留任何侧栏/竖轨结构。
import './progress.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe2,
  ListChecks,
  Loader2,
  Minus,
  ShieldAlert,
  Sparkles,
  Users
} from 'lucide-react'
import type { IslandSnapshot, IslandStatus, SessionPlan, SuperAgentState, TodoItem } from '@shared/types'
import { IconButton } from '../components'
import { useAppStore } from '../store'
import { useStudioStore } from './studio'
import { collectOutputFiles, collectSourceGroups, hostnameOf, type OutputFile } from '@shared/progress'

const COLLAPSED_KEY = 'morrow.progressFloat.collapsed'
const EMPTY_TODOS: TodoItem[] = []
const MAX_ITEMS = 60
const MAX_SOURCES = 3
const MAX_OUTPUTS = 3

type ProgressTone = 'active' | 'done' | 'error' | 'waiting' | 'info'

interface ProgressItem {
  id: string
  title: string
  detail?: string
  tone: ProgressTone
  at: number
  percent?: number
  tag?: string
}

const TOOL_LABELS: Record<string, string> = {
  run_command: '运行命令',
  terminal: '终端',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  list_files: '浏览文件',
  glob: '查找文件',
  grep: '搜索内容',
  web_search: '联网搜索',
  fetch_url: '读取网页',
  browser_open: '打开网页',
  browser_read: '读取网页',
  browser_act: '操作网页',
  super_agent: '协作成员',
  update_todos: '更新待办',
  artifact_create: '生成成果',
  artifact_update: '更新成果',
  publish_artifact: '发布成果',
  memory_add: '写入记忆',
  memory_search: '查找记忆',
  ask_user: '询问你',
  request_permission: '请求确认'
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

function shortText(value: string, limit = 120): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function toneFromToolStatus(status: string | undefined): ProgressTone {
  if (status === 'error') return 'error'
  if (status === 'denied') return 'info'
  if (status === 'interrupted') return 'info'
  if (status === 'success') return 'done'
  if (status === 'waiting') return 'waiting'
  return 'active'
}

function toneIcon(tone: ProgressTone): React.JSX.Element {
  if (tone === 'done') return <CheckCircle2 size={13} aria-hidden />
  if (tone === 'error') return <AlertCircle size={13} aria-hidden />
  if (tone === 'waiting') return <ShieldAlert size={13} aria-hidden />
  if (tone === 'active') return <Loader2 size={13} className="progress-spin" aria-hidden />
  return <Circle size={13} aria-hidden />
}

function statusText(status: IslandStatus): string {
  if (status === 'running') return '进行中'
  if (status === 'waiting') return '等待你'
  if (status === 'done') return '已完成'
  if (status === 'error') return '出错'
  return '待命'
}

function seedItems(): ProgressItem[] {
  const session = useAppStore.getState().session
  if (!session) return []
  const items: ProgressItem[] = []
  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'assistant') continue
    for (const block of [...message.content].reverse()) {
      if (block.type !== 'tool_use') continue
      const at = block.finishedAt ?? block.startedAt ?? message.createdAt
      items.push({
        id: block.id,
        title: block.title || toolLabel(block.name),
        detail: toolLabel(block.name),
        tone: toneFromToolStatus(block.status),
        at,
        tag: '工具',
        ...(typeof block.progressPercent === 'number' ? { percent: block.progressPercent } : {})
      })
      if (items.length >= 12) break
    }
    if (items.length > 0) break
  }
  if (session.plan?.status === 'executing') {
    items.unshift({
      id: `plan-${session.plan.id}`,
      title: `计划 · ${session.plan.title}`,
      detail: `${session.plan.steps.length} 个步骤`,
      tone: 'active',
      at: session.plan.updatedAt,
      tag: '计划'
    })
  }
  return items.slice(0, MAX_ITEMS)
}

function planItem(plan: SessionPlan): ProgressItem {
  const done = plan.status === 'completed'
  return {
    id: `plan-${plan.id}`,
    title: `计划 · ${plan.title}`,
    detail: `${plan.steps.length} 个步骤${plan.status === 'executing' ? ' · 执行中' : ''}`,
    tone: done ? 'done' : plan.status === 'rejected' ? 'info' : 'active',
    at: plan.updatedAt,
    tag: '计划'
  }
}

function superItem(state: SuperAgentState): ProgressItem {
  const total = state.tasks.length
  const running = state.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length
  const done = state.tasks.filter((task) => task.status === 'completed').length
  const failed = state.tasks.filter((task) => task.status === 'failed' || task.status === 'blocked').length
  const tone: ProgressTone =
    state.status === 'running' ? 'active' : failed > 0 ? 'error' : state.status === 'completed' ? 'done' : 'info'
  return {
    id: `super-${state.runId}`,
    title: `协作成员 · ${running} 进行 / ${done} 完成${failed ? ` / ${failed} 异常` : ''}`,
    detail: shortText(state.goal, 100),
    tone,
    at: state.updatedAt,
    tag: '协作'
  }
}

/** 产出文件的次级说明：保留目录，帮助区分同名文件。 */
function pathHint(file: OutputFile): string {
  const path = file.path ?? ''
  if (!path || path === file.title) return ''
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index > 0 ? normalized.slice(0, index) : ''
}

export function ProgressDock(): React.JSX.Element | null {
  const session = useAppStore((s) => s.session)
  const sessionId = session?.id ?? null
  const sessionTitle = session?.title ?? ''
  const todos = session?.todos ?? EMPTY_TODOS
  const plan = session?.plan ?? null
  const superAgent = session?.superAgent ?? null
  const canvasOpen = useAppStore((s) => s.canvas.open)
  const sideChatOpen = useAppStore((s) => s.sideChatOpen)
  const studioOpen = useStudioStore((s) => s.open)
  const openExternal = useAppStore((s) => s.openExternal)
  const revealArtifact = useAppStore((s) => s.revealArtifact)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [items, setItems] = useState<ProgressItem[]>([])
  const [island, setIsland] = useState<IslandSnapshot | null>(null)
  const [localStartedAt, setLocalStartedAt] = useState<number | null>(null)
  const [lastRunState, setLastRunState] = useState<'running' | 'done' | 'error' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lastSuperKey = useRef('')
  const permissionTools = useRef(new Map<string, string>())

  const upsert = (item: ProgressItem): void => {
    setItems((prev) => {
      const index = prev.findIndex((entry) => entry.id === item.id)
      if (index < 0) return [item, ...prev].slice(0, MAX_ITEMS)
      const next = [...prev]
      next[index] = { ...next[index], ...item }
      return next
    })
  }

  useEffect(() => {
    setItems(seedItems())
    setLocalStartedAt(null)
    setLastRunState(null)
    setNow(Date.now())
    lastSuperKey.current = ''
    permissionTools.current.clear()
  }, [sessionId])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      // localStorage 不可用时只保留本次会话内的展开状态
    }
  }, [collapsed])

  useEffect(() => {
    let active = true
    void window.morrow.island.snapshot().then((result) => {
      if (active && result.ok) setIsland(result.data)
    })
    const off = window.morrow.island.onState((next) => {
      if (active) setIsland(next)
    })
    return () => {
      active = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!sessionId) return undefined
    const off = window.morrow.onEvent((event) => {
      if (event.sessionId !== sessionId) return
      if (event.type === 'run_started') {
        setLocalStartedAt(event.at)
        setLastRunState('running')
        upsert({
          id: `run-start-${event.runId}`,
          title: '开始执行任务',
          tone: 'active',
          at: event.at,
          tag: '本轮'
        })
        return
      }
      if (event.type === 'run_finished') {
        setLocalStartedAt(null)
        setLastRunState(event.reason === 'complete' ? 'done' : event.reason === 'error' ? 'error' : 'done')
        upsert({
          id: `run-start-${event.runId}`,
          title: '开始执行任务',
          tone: event.reason === 'complete' ? 'done' : event.reason === 'error' ? 'error' : 'info',
          at: event.at,
          tag: '本轮'
        })
        const label =
          event.reason === 'complete'
            ? '本轮完成'
            : event.reason === 'cancelled'
              ? '本轮已取消'
              : event.reason === 'error'
                ? '本轮出错'
                : '达到步数上限'
        upsert({
          id: `run-end-${event.runId}`,
          title: label,
          tone: event.reason === 'complete' ? 'done' : event.reason === 'error' ? 'error' : 'info',
          at: event.at,
          tag: '本轮'
        })
        return
      }
      if (event.type === 'tool_started') {
        const label = toolLabel(event.block.name)
        const title = event.block.title || label
        upsert({
          id: event.block.id,
          title,
          detail: title.includes(label) ? undefined : label,
          tone: 'active',
          at: event.at,
          tag: '工具'
        })
        return
      }
      if (event.type === 'tool_progress') {
        setItems((prev) => {
          const existing = prev.find((entry) => entry.id === event.toolUseId)
          const item: ProgressItem = {
            id: event.toolUseId,
            title: event.title || existing?.title || '正在执行工具',
            detail: event.note || existing?.detail,
            tone: toneFromToolStatus(event.status),
            at: event.at,
            tag: existing?.tag ?? '工具',
            ...(typeof event.percent === 'number' ? { percent: event.percent } : {})
          }
          if (!existing) return [item, ...prev].slice(0, MAX_ITEMS)
          const next = [...prev]
          next[next.indexOf(existing)] = { ...existing, ...item }
          return next
        })
        return
      }
      if (event.type === 'tool_finished') {
        const state: ProgressTone = event.denied
          ? 'info'
          : event.interrupted
            ? 'info'
            : event.result.ok
              ? 'done'
              : 'error'
        setItems((prev) => {
          const existing = prev.find((entry) => entry.id === event.toolUseId)
          const detail = event.denied
            ? '已拒绝这次操作'
            : event.interrupted
              ? '已中断'
              : event.result.ok
                ? event.result.output
                  ? shortText(event.result.output, 120)
                  : '完成'
                : event.result.error || '执行失败'
          const item: ProgressItem = {
            id: event.toolUseId,
            title: existing?.title ?? '工具执行结束',
            detail,
            tone: state,
            at: event.at,
            tag: existing?.tag ?? '工具'
          }
          if (!existing) return [item, ...prev].slice(0, MAX_ITEMS)
          const next = [...prev]
          next[next.indexOf(existing)] = { ...existing, ...item }
          return next
        })
        return
      }
      if (event.type === 'todos_updated') {
        const done = event.todos.filter((todo) => todo.status === 'completed').length
        const current = event.todos.find((todo) => todo.status === 'in_progress')
        upsert({
          id: 'todos-latest',
          title: `待办更新 · ${done}/${event.todos.length}`,
          detail: current ? current.text : event.todos.length === 0 ? '待办已清空' : '已更新执行清单',
          tone: done === event.todos.length && event.todos.length > 0 ? 'done' : 'active',
          at: event.at,
          tag: '待办'
        })
        return
      }
      if (event.type === 'artifacts_updated') {
        upsert({
          id: `artifacts-${event.seq}`,
          title: `成果更新 · ${event.artifacts.length} 个`,
          detail: '可在右侧画布查看最新版本',
          tone: 'done',
          at: event.at,
          tag: '成果'
        })
        return
      }
      if (event.type === 'plan_updated' && event.plan) {
        upsert(planItem(event.plan))
        return
      }
      if (event.type === 'super_updated' && event.state) {
        const key = `${event.state.runId}:${event.state.status}:${event.state.tasks.length}`
        if (key !== lastSuperKey.current) {
          lastSuperKey.current = key
          upsert(superItem(event.state))
        }
        return
      }
      if (event.type === 'permission_requested') {
        permissionTools.current.set(event.request.id, event.request.toolUseId)
        setItems((prev) =>
          prev.map((item) => (item.id === event.request.toolUseId ? { ...item, tone: 'waiting' as const } : item))
        )
        upsert({
          id: `permission-${event.request.id}`,
          title: '等待你确认',
          detail: shortText(event.request.summary || event.request.toolName || '需要你的授权', 100),
          tone: 'waiting',
          at: event.at,
          tag: '确认'
        })
        return
      }
      if (event.type === 'permission_resolved') {
        const toolUseId = permissionTools.current.get(event.requestId)
        permissionTools.current.delete(event.requestId)
        const decision =
          event.decision === 'deny' ? '已拒绝' : event.decision === 'always' ? '已允许并记住' : '已允许一次'
        setItems((prev) =>
          prev.map((item) => {
            if (item.id === `permission-${event.requestId}`) {
              return { ...item, title: '确认完成', detail: decision, tone: 'done' as const, at: event.at }
            }
            if (toolUseId && item.id === toolUseId) {
              return { ...item, tone: 'active' as const }
            }
            return item
          })
        )
        return
      }
      if (event.type === 'question_asked') {
        upsert({
          id: `question-${event.request.id}`,
          title: '等你回答',
          detail: shortText(event.request.question, 100),
          tone: 'waiting',
          at: event.at,
          tag: '提问'
        })
        return
      }
      if (event.type === 'question_answered') {
        setItems((prev) =>
          prev.map((item) =>
            item.id === `question-${event.requestId}`
              ? {
                  ...item,
                  title: '已回答',
                  detail: shortText(event.answer.label || event.answer.value, 100),
                  tone: 'done' as const,
                  at: event.at
                }
              : item
          )
        )
        return
      }
      if (event.type === 'notice') {
        upsert({
          id: `notice-${event.seq}`,
          title: event.message,
          tone: event.level === 'success' ? 'done' : 'info',
          at: event.at,
          tag: '提示'
        })
        return
      }
      if (event.type === 'error') {
        upsert({
          id: `error-${event.seq}`,
          title: '执行出错',
          detail: shortText(event.error.message, 120),
          tone: 'error',
          at: event.at,
          tag: '错误'
        })
        return
      }
      if (event.type === 'compaction') {
        upsert({
          id: `compaction-${event.seq}`,
          title: event.phase === 'started' ? '正在整理上下文' : '上下文已整理',
          detail:
            event.savedTokens !== undefined
              ? `节省约 ${event.savedTokens.toLocaleString('zh-CN')} tokens`
              : undefined,
          tone: event.phase === 'finished' ? 'done' : 'active',
          at: event.at,
          tag: '上下文'
        })
      }
    })
    return off
  }, [sessionId])

  const islandForSession = island && island.sessionId === sessionId ? island : null
  const visibleTodos = todos.length > 0 ? todos : islandForSession?.todos ?? EMPTY_TODOS
  const todoDone = visibleTodos.filter((todo) => todo.status === 'completed').length
  const todoPercent = visibleTodos.length > 0 ? Math.round((todoDone / visibleTodos.length) * 100) : 0
  const todosRemain = visibleTodos.some((todo) => todo.status !== 'completed')
  const planRemain = plan?.status === 'executing'
  const explicitWaiting =
    items.some((item) => item.tone === 'waiting') ||
    (islandForSession?.status === 'waiting' && lastRunState !== 'done' && lastRunState !== 'error')
  const observedStatus = lastRunState ?? islandForSession?.status ?? null
  const status: IslandStatus = explicitWaiting
    ? 'waiting'
    : localStartedAt
      ? 'running'
      : lastRunState === 'error'
        ? 'error'
        : observedStatus === 'done' && (todosRemain || planRemain)
          ? 'waiting'
          : observedStatus === 'done'
            ? 'done'
            : todosRemain || planRemain
              ? 'waiting'
              : observedStatus ?? 'idle'
  const startedAt = localStartedAt ?? islandForSession?.startedAt ?? null
  const agentActive = Boolean(localStartedAt) || explicitWaiting || islandForSession?.status === 'running'
  const elapsed = startedAt && agentActive ? formatElapsed(now - startedAt) : null
  const activeItem = items.find((item) => item.tone === 'active' || item.tone === 'waiting')
  const outcomeItem = items.find((item) => item.id.startsWith('run-end-'))
  const nextTodo =
    visibleTodos.find((todo) => todo.status === 'in_progress') ??
    visibleTodos.find((todo) => todo.status === 'pending')
  const detail =
    status === 'running' || explicitWaiting
      ? islandForSession?.detail || activeItem?.title || items[0]?.title || '等待任务开始'
      : status === 'waiting' && (todosRemain || planRemain)
        ? nextTodo
          ? `待继续 · ${nextTodo.text}`
          : planRemain
            ? `待继续 · ${plan.title}`
            : '等待下一步'
        : status === 'done'
          ? '本轮已完成'
          : outcomeItem?.title || items[0]?.title || islandForSession?.detail || '等待任务开始'
  const superRunning =
    superAgent?.tasks.filter((task) => task.status === 'running' || task.status === 'queued').length ?? 0

  const sources = useMemo(() => {
    const groups = collectSourceGroups(session)
    // 最近一次搜索排在最前；组内仍保持排名顺序。
    return [...groups].reverse().flatMap((group) => group.sources)
  }, [session])
  const outputFiles = useMemo(() => collectOutputFiles(session), [session])

  useEffect(() => {
    if (status !== 'running' && status !== 'waiting') return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const planSummary = useMemo(() => {
    if (!plan || plan.status === 'completed' || plan.status === 'rejected') return null
    return `${plan.title} · ${plan.steps.length} 步`
  }, [plan])

  if (!sessionId) return null
  if (canvasOpen || sideChatOpen || studioOpen) return null

  if (collapsed) {
    return (
      <button
        type="button"
        className="progress-chip"
        aria-label="展开进展更新"
        title="展开进展更新"
        onClick={() => setCollapsed(false)}
      >
        <span className="progress-chip-mark" data-status={status} aria-hidden>
          <Activity size={13} strokeWidth={1.7} />
        </span>
        <span className="progress-chip-title">进展</span>
        <span className="progress-chip-status" data-status={status}>
          {statusText(status)}
        </span>
        {elapsed ? <span className="progress-chip-elapsed mono">{elapsed}</span> : null}
        <ChevronDown size={12} strokeWidth={1.7} className="progress-chip-chevron" aria-hidden />
      </button>
    )
  }

  return (
    <aside className="progress-float" aria-label="进展更新">
      <header className="progress-head">
        <div className="progress-head-title">
          <span className="progress-mark" data-status={status} aria-hidden>
            <Activity size={14} strokeWidth={1.7} />
          </span>
          <div className="progress-head-copy">
            <div className="progress-head-line">
              <h2>进展更新</h2>
              <span className="progress-status" data-status={status}>
                {statusText(status)}
              </span>
            </div>
            <p className="progress-session" title={sessionTitle}>
              {sessionTitle || '当前对话'}
            </p>
          </div>
        </div>
        <IconButton label="收起进展更新" size={26} onClick={() => setCollapsed(true)}>
          <Minus size={14} strokeWidth={1.7} />
        </IconButton>
      </header>

      <div className="progress-scroll">
        <div className="progress-summary">
          <div className="progress-now">
            <span className="progress-now-dot" data-status={status} aria-hidden />
            <span className="progress-now-text" title={detail}>
              {detail}
            </span>
            {elapsed ? <span className="progress-elapsed mono">{elapsed}</span> : null}
          </div>
          {visibleTodos.length > 0 ? (
            <>
              <div className="progress-todo-meta">
                <span>
                  <ListChecks size={12} strokeWidth={1.7} aria-hidden /> 待办 {todoDone}/{visibleTodos.length}
                </span>
                <span className="mono">{todoPercent}%</span>
              </div>
              <div
                className="progress-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={visibleTodos.length}
                aria-valuenow={todoDone}
                aria-label="待办完成进度"
              >
                <span style={{ width: `${todoPercent}%` }} />
              </div>
              <ul className="progress-todos">
                {visibleTodos.slice(0, 4).map((todo) => (
                  <li key={todo.id} className="progress-todo" data-status={todo.status}>
                    <span className="progress-todo-icon" aria-hidden>
                      {todo.status === 'completed' ? (
                        <CheckCircle2 size={12} />
                      ) : todo.status === 'in_progress' ? (
                        <Loader2 size={12} className="progress-spin" />
                      ) : (
                        <Circle size={12} />
                      )}
                    </span>
                    <span className="progress-todo-text" title={todo.text}>
                      {todo.text}
                    </span>
                  </li>
                ))}
                {visibleTodos.length > 4 ? (
                  <li className="progress-todo-more">还有 {visibleTodos.length - 4} 项</li>
                ) : null}
              </ul>
            </>
          ) : null}
          {planSummary ? (
            <div className="progress-plan">
              <FileText size={12} strokeWidth={1.7} aria-hidden />
              <span className="truncate">{planSummary}</span>
            </div>
          ) : null}
          {superAgent && superAgent.tasks.length > 0 ? (
            <div className="progress-plan">
              <Users size={12} strokeWidth={1.7} aria-hidden />
              <span className="truncate">
                协作成员 {superRunning} 进行 / {superAgent.tasks.length} 项
              </span>
            </div>
          ) : null}
        </div>

        <div className="progress-feed-head">
          <span>实时动态</span>
          <span className="mono">{items.length}</span>
        </div>
        <div className="progress-feed" role="log" aria-label="实时进展">
          {items.length === 0 ? (
            <div className="progress-empty">
              <Sparkles size={16} strokeWidth={1.5} aria-hidden />
              <p>任务开始后，这里会实时显示工具调用、待办和成果更新。</p>
            </div>
          ) : (
            <ol>
              {items.map((item) => (
                <li key={item.id} className="progress-item" data-tone={item.tone}>
                  <span className="progress-item-icon" aria-hidden>
                    {toneIcon(item.tone)}
                  </span>
                  <div className="progress-item-body">
                    <div className="progress-item-title">
                      <span className="truncate">{item.title}</span>
                      {item.tag ? <span className="progress-item-tag mono">{item.tag}</span> : null}
                    </div>
                    {item.detail ? (
                      <p className="progress-item-detail" title={item.detail}>
                        {item.detail}
                      </p>
                    ) : null}
                    {typeof item.percent === 'number' ? (
                      <div className="progress-item-bar" aria-hidden>
                        <span style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }} />
                      </div>
                    ) : null}
                  </div>
                  <time className="progress-item-time mono" dateTime={new Date(item.at).toISOString()}>
                    {formatClock(item.at)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>

      {sources.length > 0 || outputFiles.length > 0 ? (
        <section className="progress-outs" aria-label="来源与产出">
          {sources.length > 0 ? (
            <section className="progress-out-group" aria-label="来源">
              <div className="progress-out-head">
                <Globe2 size={11} strokeWidth={1.7} aria-hidden />
                <span>来源</span>
                <span className="progress-out-count mono">{sources.length}</span>
              </div>
              <ul className="progress-out-list">
                {sources.slice(0, MAX_SOURCES).map((source) => (
                  <li key={source.url}>
                    <button
                      type="button"
                      className="progress-source"
                      title={`${source.title || source.url}\n${source.url}`}
                      onClick={() => void openExternal(source.url)}
                    >
                      <span className="progress-source-host mono">{hostnameOf(source.url)}</span>
                      <span className="progress-source-title truncate">{source.title || source.url}</span>
                      <ExternalLink size={10} strokeWidth={1.6} aria-hidden />
                    </button>
                  </li>
                ))}
                {sources.length > MAX_SOURCES ? (
                  <li className="progress-out-more">还有 {sources.length - MAX_SOURCES} 条来源</li>
                ) : null}
              </ul>
            </section>
          ) : null}
          {outputFiles.length > 0 ? (
            <section className="progress-out-group" aria-label="产出文件">
              <div className="progress-out-head">
                <FileText size={11} strokeWidth={1.7} aria-hidden />
                <span>产出文件</span>
                <span className="progress-out-count mono">{outputFiles.length}</span>
              </div>
              <ul className="progress-out-list">
                {outputFiles.slice(0, MAX_OUTPUTS).map((file) => (
                  <li key={file.key}>
                    <button
                      type="button"
                      className="progress-output"
                      title={file.path ?? file.title}
                      onClick={() => {
                        if (file.kind === 'artifact' && file.artifactId) openCanvas(file.artifactId)
                        else if (file.absolutePath) void revealArtifact(file.absolutePath)
                      }}
                    >
                      <span className="progress-output-name truncate">{file.title}</span>
                      {pathHint(file) ? (
                        <span className="progress-output-path truncate mono">{pathHint(file)}</span>
                      ) : null}
                      <FolderOpen size={10} strokeWidth={1.6} aria-hidden />
                    </button>
                  </li>
                ))}
                {outputFiles.length > MAX_OUTPUTS ? (
                  <li className="progress-out-more">还有 {outputFiles.length - MAX_OUTPUTS} 个产出</li>
                ) : null}
              </ul>
            </section>
          ) : null}
        </section>
      ) : null}
      </div>
    </aside>
  )
}