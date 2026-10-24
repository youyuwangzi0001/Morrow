import { BrowserWindow, Menu, screen } from 'electron'
import { join } from 'node:path'
import type { IslandSnapshot, RuntimeEvent, TodoItem } from '../../shared/types'
import {
  ISLAND_OPEN_CHANNEL,
  ISLAND_QUICK_SEND_CHANNEL,
  ISLAND_UPDATE_CHANNEL,
  type IslandOpenMainInput,
  type IslandQuickSendInput
} from '../../shared/ipc'
import { getSessionStore } from './session-store'
import { getSettingsStore } from './settings-store'
import { log } from './logger'

/** 收起态窗口（含 8px 透明留白给阴影）。 */
const COLLAPSED = { width: 356, height: 84 }
/** 展开态窗口：顶部小伙伴 + 任务进度 + 快速输入。 */
const EXPANDED = { width: 396, height: 520 }
const EDGE = 8

const TOOL_LABELS: Record<string, string> = {
  run_command: '运行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  apply_patch: '修改代码',
  list_files: '浏览文件',
  search_files: '搜索文件',
  web_search: '联网搜索',
  browser: '浏览网页',
  read_pdf: '阅读 PDF',
  read_docx: '阅读文档',
  read_pptx: '阅读演示文稿',
  read_xlsx: '阅读表格',
  swarm: '集群协作',
  todo_write: '更新计划',
  generate_image: '生成图片',
  generate_video: '生成视频',
  generate_film: '制作短片',
  render_animation: '渲染代码动画',
  edit_media: '剪辑媒体',
  inspect_media: '查看媒体',
  describe_media: '审看媒体',
  media_status: '检查多媒体',
  memory: '整理记忆'
}

let islandWindow: BrowserWindow | null = null
let expanded = false
let basePosition: { x: number; y: number } | null = null
let applyingBounds = false
let moveTimer: NodeJS.Timeout | null = null
let openMainHandler: (() => void) | null = null
let requestCloseHandler: (() => void) | null = null

function idleSnapshot(): IslandSnapshot {
  return {
    status: 'idle',
    sessionId: null,
    sessionTitle: '',
    detail: '在桌面陪你待命',
    todos: [],
    startedAt: null,
    updatedAt: Date.now(),
    unread: false
  }
}

let snapshot: IslandSnapshot = idleSnapshot()
/** 灵动岛跟随的主窗口会话；null = 尚未选择会话。 */
let followedSessionId: string | null = null

export function configureIsland(options: { openMain: () => void; requestClose?: () => void }): void {
  openMainHandler = options.openMain
  requestCloseHandler = options.requestClose ?? null
}

function isEnabled(): boolean {
  try {
    return getSettingsStore().get().islandEnabled
  } catch {
    return true
  }
}

function clampPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const display = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width, height })
  const area = display.workArea
  return {
    x: Math.round(Math.min(Math.max(x, area.x + EDGE), area.x + area.width - width - EDGE)),
    y: Math.round(Math.min(Math.max(y, area.y + EDGE), area.y + area.height - height - EDGE))
  }
}

function defaultPosition(width: number, height: number): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - width - 28,
    y: area.y + area.height - height - 28
  }
}

function readSavedPosition(width: number, height: number): { x: number; y: number } {
  let saved: { x: number; y: number } | null = null
  try {
    saved = getSettingsStore().get().islandPosition
  } catch {
    saved = null
  }
  const raw = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : defaultPosition(width, height)
  return clampPosition(raw.x, raw.y, width, height)
}

function rendererUrl(): { url?: string; file?: string } {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(devUrl)
    url.hash = 'island'
    return { url: url.toString() }
  }
  return { file: join(__dirname, '../renderer/index.html') }
}

function createWindow(): BrowserWindow {
  if (islandWindow && !islandWindow.isDestroyed()) return islandWindow
  expanded = false
  basePosition = readSavedPosition(COLLAPSED.width, COLLAPSED.height)
  const target = rendererUrl()
  const win = new BrowserWindow({
    ...basePosition,
    width: COLLAPSED.width,
    height: COLLAPSED.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Morrow 小伙伴',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false
    }
  })
  islandWindow = win
  win.setAlwaysOnTop(true, 'floating')
  win.webContents.on('context-menu', () => {
    if (win.isDestroyed()) return
    Menu.buildFromTemplate([
      { label: '打开 Morrow', click: () => openMainHandler?.() },
      { label: '隐藏小伙伴', click: () => hideIsland() },
      { type: 'separator' },
      { label: '关闭 Morrow…', click: () => requestCloseHandler?.() }
    ]).popup({ window: win })
  })
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch {
    // 个别平台不支持
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  win.on('move', () => {
    if (applyingBounds) return
    const bounds = win.getBounds()
    basePosition = { x: bounds.x, y: bounds.y }
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      try {
        getSettingsStore().update({ islandPosition: basePosition })
      } catch (err) {
        log.warn('island position save failed', String(err))
      }
    }, 400)
  })
  win.on('closed', () => {
    islandWindow = null
  })

  if (target.url) void win.loadURL(target.url)
  else if (target.file) void win.loadFile(target.file, { hash: 'island' })

  return win
}

export function createIsland(): void {
  if (!isEnabled()) return
  const isTest = process.env.MORROW_TEST === '1' || process.argv.includes('--test-mode')
  // E2E 默认不创建第二窗口，避免改变已有用例的窗口假设；灵动岛用例显式开启。
  if (isTest && process.env.MORROW_ISLAND !== '1') return
  createWindow()
}

export function showIsland(): void {
  if (!isEnabled()) return
  const win = createWindow()
  if (win.isMinimized()) win.restore()
  win.showInactive()
}

export function hideIsland(destroy = false): void {
  const win = islandWindow
  if (!win || win.isDestroyed()) return
  if (!destroy && expanded) setIslandExpanded(false)
  if (destroy) expanded = false
  win.hide()
  if (destroy) win.destroy()
}

export function toggleIsland(): void {
  if (!isEnabled()) return
  const win = islandWindow
  if (win && !win.isDestroyed() && win.isVisible()) {
    hideIsland()
    return
  }
  showIsland()
}

export function syncIslandVisibility(): void {
  if (isEnabled()) createIsland()
  else hideIsland(true)
}

export function isIslandWindow(win: BrowserWindow | null): boolean {
  return !!win && win === islandWindow
}

export function getIslandWindow(): BrowserWindow | null {
  return islandWindow && !islandWindow.isDestroyed() ? islandWindow : null
}

export function setIslandExpanded(next: boolean): void {
  const win = islandWindow
  if (!win || win.isDestroyed()) return
  expanded = next
  const width = next ? EXPANDED.width : COLLAPSED.width
  const height = next ? EXPANDED.height : COLLAPSED.height
  const current = win.getBounds()
  let x = current.x
  let y = current.y
  if (next) {
    const area = screen.getDisplayMatching(current).workArea
    // 靠近屏幕底部时向上展开，避免面板被任务栏截断。
    if (y + height > area.y + area.height - EDGE) y = area.y + area.height - height - EDGE
    y = Math.max(area.y + EDGE, y)
    x = Math.min(Math.max(x, area.x + EDGE), area.x + area.width - width - EDGE)
  } else if (basePosition) {
    const clamped = clampPosition(basePosition.x, basePosition.y, width, height)
    x = clamped.x
    y = clamped.y
  }
  applyingBounds = true
  win.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
  setTimeout(() => {
    applyingBounds = false
  }, 120)
  if (next) {
    win.show()
    win.focus()
  }
}

export function getIslandSnapshot(): IslandSnapshot {
  return snapshot
}

/** 清除全部对话后把桌面小伙伴恢复为空闲，避免它继续指向已删除的会话。 */
export function resetIslandAfterClear(): void {
  followedSessionId = null
  snapshot = idleSnapshot()
  sendSnapshot()
}

/** 单个会话被删除时，只在它正是岛上显示的会话时复位，避免快速发送落到别的会话。 */
export function clearIslandSession(sessionId: string): void {
  if (snapshot.sessionId !== sessionId) return
  followedSessionId = null
  snapshot = idleSnapshot()
  sendSnapshot()
}

/**
 * 主窗口切换会话：灵动岛实时跟随当前会话。
 * 当前会话有运行中的任务时显示运行态/耗时/计划；没有运行时也保留该会话的计划进度。
 */
export function syncIslandSession(
  sessionId: string | null,
  active?: { startedAt: number; status: 'running' | 'waiting' } | null
): void {
  followedSessionId = sessionId
  if (!sessionId) {
    snapshot = idleSnapshot()
    sendSnapshot()
    return
  }
  const session = getSessionStore().get(sessionId)
  const todos = session?.todos ?? []
  const completed = todos.filter((todo) => todo.status === 'completed').length
  const progress = todos.length > 0 ? `计划 ${completed}/${todos.length}` : ''
  const inProgress = inProgressDetail(todos)
  const detail = active
    ? inProgress ?? (active.status === 'waiting' ? '等待你的确认…' : '正在推进计划…')
    : progress || '在桌面陪你待命'
  snapshot = {
    status: active?.status ?? 'idle',
    sessionId,
    sessionTitle: session?.title?.trim() || '新的对话',
    detail,
    todos,
    startedAt: active?.startedAt ?? null,
    unread: false,
    updatedAt: Date.now()
  }
  sendSnapshot()
}

function sendSnapshot(): void {
  const win = getIslandWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(ISLAND_UPDATE_CHANNEL, snapshot)
}

function broadcast(): void {
  snapshot = { ...snapshot, updatedAt: Date.now() }
  sendSnapshot()
}

function publish(next: Partial<IslandSnapshot>): void {
  snapshot = { ...snapshot, ...next, updatedAt: Date.now() }
  sendSnapshot()
}

function sessionTitle(sessionId: string): string {
  try {
    return getSessionStore().get(sessionId)?.title?.trim() || '新的对话'
  } catch {
    return '新的对话'
  }
}

function sessionTodos(sessionId: string): TodoItem[] {
  try {
    return getSessionStore().get(sessionId)?.todos ?? []
  } catch {
    return []
  }
}

function isMainFocused(): boolean {
  const wins = BrowserWindow.getAllWindows().filter((win) => !isIslandWindow(win) && win.isVisible())
  return wins.some((win) => win.isFocused())
}

/** 只把消息交给可见的主窗口；隐藏的 PDF 打印窗口/后台窗口不能抢走快速发送。 */
function findVisibleMainWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && candidate !== islandWindow && candidate.isVisible()
    ) ?? null
  )
}

function inProgressDetail(todos: TodoItem[]): string | null {
  const current = todos.find((todo) => todo.status === 'in_progress')
  return current ? `正在做：${current.text}` : null
}

/**
 * 把主进程运行事件翻译成小伙伴的一句话状态。
 * 只关心「当前这一轮」：新的 run_started 会替换上一个会话的状态；
 * 其他会话的事件不会抢走显示（后台任务仍可点击主窗口查看）。
 */
export function ingestIslandRuntimeEvent(event: RuntimeEvent): void {
  // 灵动岛显示主窗口当前会话；其它会话的后台事件不能抢走显示。
  if (followedSessionId === null) {
    if (event.type !== 'run_started') return
    followedSessionId = event.sessionId
  }
  if (event.sessionId !== followedSessionId) return
  if (event.type === 'run_started') {
    publish({
      status: 'running',
      sessionId: event.sessionId,
      sessionTitle: sessionTitle(event.sessionId),
      detail: '正在理解你的问题…',
      todos: sessionTodos(event.sessionId),
      startedAt: event.at,
      unread: false
    })
    return
  }
  if (snapshot.sessionId !== event.sessionId) {
    if (event.type === 'session_updated' && snapshot.status === 'idle' && snapshot.sessionId === null) {
      // 空闲态下顺便更新最近会话名，方便展开时显示。
      publish({ sessionTitle: event.meta.title })
    }
    return
  }
  switch (event.type) {
    case 'message_started':
      if (event.role === 'assistant') publish({ status: 'running', detail: '正在回答…' })
      break
    case 'tool_started':
      publish({
        status: 'running',
        detail: `正在${TOOL_LABELS[event.block.name] ?? '执行任务'}…`
      })
      break
    case 'tool_progress':
      if (event.title) publish({ status: 'running', detail: event.title })
      else if (event.note) publish({ status: 'running', detail: event.note })
      break
    case 'permission_requested':
      publish({
        status: 'waiting',
        detail: `等待你确认：${TOOL_LABELS[event.request.toolName] ?? '一个操作'}`,
        unread: !isMainFocused()
      })
      break
    case 'question_asked':
      publish({ status: 'waiting', detail: '有一个问题等你回答', unread: !isMainFocused() })
      break
    case 'permission_resolved':
    case 'question_answered':
      publish({ status: 'running', detail: '继续执行…' })
      break
    case 'todos_updated': {
      const detail = inProgressDetail(event.todos)
      publish({
        todos: event.todos,
        detail: detail ?? (snapshot.status === 'running' ? '正在推进计划…' : snapshot.detail)
      })
      break
    }
    case 'compaction':
      publish({ detail: event.phase === 'started' ? '正在整理上下文…' : '上下文整理完成' })
      break
    case 'demo_step':
      publish({ status: 'running', detail: event.caption })
      break
    case 'session_updated':
      publish({ sessionTitle: event.meta.title || snapshot.sessionTitle })
      break
    case 'run_finished': {
      const reason = event.reason
      const status = reason === 'complete' ? 'done' : reason === 'cancelled' ? 'idle' : 'error'
      const detail =
        reason === 'complete'
          ? '这件事做好了'
          : reason === 'cancelled'
            ? '已停下，随时可以继续'
            : reason === 'max-steps'
              ? '到达本轮上限，可以接着让它做'
              : '这次没做成，打开看看原因'
      publish({ status, detail, startedAt: null, unread: reason !== 'cancelled' && !isMainFocused() })
      break
    }
    case 'error':
      publish({ status: 'error', detail: '这次出错了，打开 Morrow 查看原因', unread: !isMainFocused() })
      break
    default:
      break
  }
}

/** 主窗口获得焦点后，小伙伴的“未读”提示消除。 */
export function markIslandRead(): void {
  if (!snapshot.unread && snapshot.status !== 'done') return
  const next: IslandSnapshot = { ...snapshot, unread: false, updatedAt: Date.now() }
  if (snapshot.status === 'done') {
    next.status = 'idle'
    next.detail = '在桌面陪你待命'
  }
  snapshot = next
  sendSnapshot()
}

export function quickSendToMain(input: IslandQuickSendInput): boolean {
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  if (!text) return false
  openMainHandler?.()
  const target = findVisibleMainWindow()
  if (!target) return false
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  target.webContents.send(ISLAND_QUICK_SEND_CHANNEL, {
    ...input,
    text: text.slice(0, 8000)
  })
  hideIsland()
  return true
}

export function openMainFromIsland(input: IslandOpenMainInput): boolean {
  openMainHandler?.()
  const target = findVisibleMainWindow()
  if (!target) return false
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  target.webContents.send(ISLAND_OPEN_CHANNEL, input ?? {})
  markIslandRead()
  return true
}
