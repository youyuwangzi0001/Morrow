import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Eraser,
  File as FileIcon,
  FileImage,
  FileText,
  ClipboardList,
  Lock,
  MessageSquare,
  Minimize2,
  Paperclip,
  PlusCircle,
  RotateCcw,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Target,
  Telescope,
  X,
  Zap
} from 'lucide-react'
import {
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_IMAGE_SOURCE_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_TEXT_MAX_BYTES,
  ATTACHMENT_TEXT_MAX_CHARS,
  imageMediaTypeFor,
  isImageFileName,
  isTextFileName
} from '@shared/file-types'
import { expandCustomCommand, INIT_RULES_PROMPT, RESERVED_COMMAND_NAMES } from '@shared/commands'
import { formatBytes } from '@shared/usage'
import { findModel } from '@shared/models'
import { decodeTextBytes } from '@shared/text-decode'
import type {
  Attachment,
  CustomCommandInfo,
  FileSearchResult,
  PermissionMode,
  ReasoningEffort,
  ResearchDepth,
  SessionMode
} from '@shared/types'
import { isReasoningEffort, REASONING_EFFORTS } from '@shared/models'
import { RESEARCH_DEPTHS } from '@shared/research'
import { useAppStore } from '../../store'
import { IconButton, Segmented, Select } from '../../ui'
import { requestSettingsTab } from '../settings/settings-tab'
import { openWorkbench } from '../workbench/events'
import { ContextMeter } from './ContextMeter'
import './Composer.css'

/** 输入区最小高度（与图 3 的默认高度一致）；最大高度为窗口的三分之一 */
const MIN_INPUT_HEIGHT = 80

function maxInputHeightForViewport(): number {
  return Math.max(MIN_INPUT_HEIGHT, Math.floor(window.innerHeight / 3))
}

const REASONING_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  auto: '由模型自己决定',
  low: '更快、更省，适合简单任务',
  medium: '速度与深度平衡',
  high: '复杂分析，耗时更长',
  xhigh: '更深入的推理，适合难题',
  max: '尽可能深入，最慢、最贵'
}
const REASONING_OPTIONS = REASONING_EFFORTS.map((value) => ({
  value,
  label: value,
  description: REASONING_DESCRIPTIONS[value]
}))

/* ── 权限模式文案 ─────────────────────────────────────────────── */

const PERMISSION_OPTIONS: { value: PermissionMode; label: string; description: string }[] = [
  {
    value: 'read-only',
    label: '只读',
    description: '只能读文件；写入、删除与命令执行会被直接拒绝'
  },
  {
    value: 'ask',
    label: '询问',
    description: '当前文件夹内的写入和命令自动执行；危险命令、外部操作或访问文件夹外时先问你'
  },
  {
    value: 'auto',
    label: '完全访问',
    description: '不再询问：写入、命令、危险操作和访问文件夹外都直接执行'
  }
]

/* ── 对话模式（聊天 / 工作）文案 ──────────────────────────────── */

type ComposerMode = 'chat' | 'work'

const SESSION_MODE_OPTIONS: { value: ComposerMode; label: string; description: string }[] = [
  {
    value: 'chat',
    label: '聊天',
    description: '聊天模式：只讨论、只读分析；不改文件、不跑命令，固定只读'
  },
  {
    value: 'work',
    label: '工作',
    description: '工作模式：可以读写文件、执行命令与推进目标；深度研究用 /research 调取'
  }
]

const MODE_DESCRIPTION: Record<ComposerMode, string> = {
  chat: '聊天模式：Morrow 只讨论和只读分析，不会改文件、跑命令；需要动手时切到工作模式。',
  work: '工作模式：可以读写文件、执行命令、推进目标；深度研究用 /research 调取（按权限档位）。'
}

/* ── 斜杠命令（可执行子集） ───────────────────────────────────── */

interface CommandDef {
  name: string
  label: string
  description: string
  disabled?: boolean
  disabledReason?: string
  custom?: boolean
  run?: () => void
}

/* ── 工具函数 ─────────────────────────────────────────────────── */

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

interface TriggerState {
  kind: 'file' | 'command'
  query: string
  /** 触发符号（@ 或 /）在文本中的下标 */
  start: number
}

/** 找到光标前的 @文件 或 /命令 触发片段 */
function findTrigger(value: string, caret: number): TriggerState | null {
  if (caret < 0) return null
  const before = value.slice(0, caret)
  const command = /(?:^|\n)\/([a-z0-9-]*)$/i.exec(before)
  if (command) {
    return { kind: 'command', query: command[1], start: before.length - command[1].length - 1 }
  }
  const file = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (file) {
    return { kind: 'file', query: file[1], start: before.length - file[1].length - 1 }
  }
  return null
}

function isTextLike(file: File): boolean {
  return file.type.startsWith('text/') || isTextFileName(file.name)
}

async function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** 拖入文件的真实路径：Electron 38 起 File.path 已移除，走 preload 的 webUtils 封装 */
function resolveDroppedPath(file: File): string {
  try {
    // 只有真实磁盘路径才有意义；拿不到时不要伪造 file.name，否则会被当成文件夹路径
    return window.morrow.files.getPathForFile(file) || ''
  } catch {
    return ''
  }
}

const PROVIDER_IMAGE_TYPE = /^image\/(png|jpe?g|webp|gif)$/i
const ATTACHMENT_IMAGE_MAX_EDGE = 1568

function attachmentKey(attachment: Attachment): string {
  // 有真实路径时按路径去重；剪贴板图片通常都叫 image.png，需用 id 区分同名同尺寸的不同图片
  return attachment.path
    ? `${attachment.path}\u0000${attachment.size}`
    : `${attachment.name}\u0000${attachment.size}\u0000${attachment.id}`
}

function mergeAttachmentList(previous: Attachment[], incoming: Attachment[]): Attachment[] {
  const merged = [...previous]
  const seen = new Set(merged.map(attachmentKey))
  for (const file of incoming) {
    const key = attachmentKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(file)
  }
  return merged.slice(0, ATTACHMENT_MAX_COUNT)
}

function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return Number.POSITIVE_INFINITY
  const base64 = dataUrl.slice(comma + 1)
  if (base64.length % 4 !== 0) return Number.POSITIVE_INFINITY
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = src
  })
}

/**
 * 视觉接口只稳定支持 PNG/JPEG/WebP/GIF。BMP 与超大图先在本地缩放/转码，
 * 避免把 image/bmp 或超过 5MB 的图片发给模型后被整轮拒绝。
 */
async function normalizeImageAttachment(attachment: Attachment): Promise<Attachment> {
  if (attachment.kind !== 'image' || typeof attachment.content !== 'string') return attachment
  const mediaType = (attachment.mediaType ?? '').toLowerCase()
  const providerSafe = PROVIDER_IMAGE_TYPE.test(mediaType)
  if (providerSafe && dataUrlByteLength(attachment.content) <= ATTACHMENT_IMAGE_MAX_BYTES) return attachment

  try {
    const image = await loadImageElement(attachment.content)
    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    if (!sourceWidth || !sourceHeight) throw new Error('图片尺寸无效')
    const scale = Math.min(1, ATTACHMENT_IMAGE_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('画布不可用')
    // 透明图铺白底，避免转成 JPEG 后发黑
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, width, height)

    let output = mediaType === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.88) : canvas.toDataURL('image/png')
    if (dataUrlByteLength(output) > ATTACHMENT_IMAGE_MAX_BYTES) {
      output = canvas.toDataURL('image/jpeg', 0.82)
    }
    for (const quality of [0.74, 0.65]) {
      if (dataUrlByteLength(output) <= ATTACHMENT_IMAGE_MAX_BYTES) break
      output = canvas.toDataURL('image/jpeg', quality)
    }
    if (dataUrlByteLength(output) > ATTACHMENT_IMAGE_MAX_BYTES) throw new Error('图片压缩后仍然过大')
    return {
      ...attachment,
      mediaType: output.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
      content: output,
      ...(mediaType === 'image/gif' ? { note: '动图已转为静态首帧，避免超出大小限制' } : {})
    }
  } catch {
    if (providerSafe && dataUrlByteLength(attachment.content) <= ATTACHMENT_IMAGE_MAX_BYTES) return attachment
    return { ...attachment, content: null, mediaType, note: '图片格式无法转换，未发送给模型' }
  }
}

async function normalizeImageAttachments(items: Attachment[]): Promise<Attachment[]> {
  // 逐张处理：手机照片解码后可达数十 MB，并发 8 张容易把渲染进程顶到 OOM
  const ready: Attachment[] = []
  for (const item of items) ready.push(await normalizeImageAttachment(item))
  return ready
}

/** 把拖入的文件转成 Attachment（拿不到真实路径时退回文件名） */
async function attachmentFromFile(file: File): Promise<Attachment> {
  const base: Attachment = {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    path: resolveDroppedPath(file),
    size: file.size,
    kind: 'file',
    content: null
  }
  const declaredImage = file.type.startsWith('image/') || isImageFileName(file.name)
  const mediaType = imageMediaTypeFor(file.name) ?? (file.type.startsWith('image/') ? file.type.toLowerCase() : null)
  const svg = mediaType === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
  if (declaredImage && !svg) {
    if (!mediaType || !/^image\/(png|jpe?g|webp|gif|bmp)$/i.test(mediaType)) {
      return {
        ...base,
        kind: 'image',
        ...(mediaType ? { mediaType } : {}),
        note: '这个图片格式暂不支持视觉输入，未发送给模型'
      }
    }
    if (file.size > ATTACHMENT_IMAGE_SOURCE_MAX_BYTES) {
      return {
        ...base,
        kind: 'image',
        mediaType,
        note: `图片超过 ${formatBytes(ATTACHMENT_IMAGE_SOURCE_MAX_BYTES)}，未发送给模型`
      }
    }
    const dataUrl = await readFileAsDataUrl(file)
    return {
      ...base,
      kind: 'image',
      mediaType,
      content: dataUrl,
      ...(dataUrl ? {} : { note: '图片读取失败，未发送给模型' })
    }
  }
  if (isTextLike(file)) {
    if (file.size > ATTACHMENT_TEXT_MAX_BYTES) {
      return {
        ...base,
        note: `文本文件超过 ${formatBytes(ATTACHMENT_TEXT_MAX_BYTES)}，未内联`
      }
    }
    try {
      const decoded = decodeTextBytes(new Uint8Array(await file.arrayBuffer()))
      if (!decoded) return { ...base, note: '内容像二进制文件，未内联' }
      const raw = decoded.text
      const truncated = raw.length > ATTACHMENT_TEXT_MAX_CHARS
      return {
        ...base,
        kind: 'text',
        content: truncated ? raw.slice(0, ATTACHMENT_TEXT_MAX_CHARS) : raw,
        ...(truncated
          ? { truncated: true, note: `内容过长，仅发送前 ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString('en-US')} 字符` }
          : {})
      }
    } catch {
      return { ...base, note: '文件读取失败，未内联' }
    }
  }
  return base.path
    ? base
    : { ...base, note: '没有拿到这个文件的磁盘路径，无法读取内容；请用回形针重新选择这个文件。' }
}

/* ── Composer ────────────────────────────────────────────────── */

export function Composer(): React.JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const run = useAppStore((s) => s.run)
  const sessions = useAppStore((s) => s.sessions)
  const pendingPermissions = useAppStore((s) => s.pendingPermissions)
  const pendingQuestions = useAppStore((s) => s.pendingQuestions)
  const selectSession = useAppStore((s) => s.selectSession)
  const settings = useAppStore((s) => s.settings)
  const session = useAppStore((s) => s.session)
  const compacting = useAppStore(
    (s) => s.compacting && (!s.compactingSessionId || s.compactingSessionId === s.session?.id)
  )
  const sendMessage = useAppStore((s) => s.sendMessage)
  const stopRun = useAppStore((s) => s.stopRun)
  const stopRunById = useAppStore((s) => s.stopRunById)
  const interruptAndSend = useAppStore((s) => s.interruptAndSend)
  const interrupting = useAppStore((s) => s.interrupting)
  const queueCount = useAppStore((s) => (s.session ? (s.queues[s.session.id]?.length ?? 0) : 0))
  const attachFiles = useAppStore((s) => s.attachFiles)
  const searchFiles = useAppStore((s) => s.searchFiles)
  const setModel = useAppStore((s) => s.setModel)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const setReasoningEffort = useAppStore((s) => s.setReasoningEffort)
  const setSessionMode = useAppStore((s) => s.setSessionMode)
  const setPlanMode = useAppStore((s) => s.setPlanMode)
  const openRewind = useAppStore((s) => s.openRewind)
  const exportCurrentSession = useAppStore((s) => s.exportCurrentSession)
  const newSession = useAppStore((s) => s.newSession)
  const openSettings = useAppStore((s) => s.openSettings)
  const openSideChat = useAppStore((s) => s.openSideChat)
  const startDemo = useAppStore((s) => s.startDemo)
  const startGoal = useAppStore((s) => s.startGoal)
  const clearGoal = useAppStore((s) => s.clearGoal)
  const compactSession = useAppStore((s) => s.compactSession)
  const notify = useAppStore((s) => s.notify)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const onboardingOpen = useAppStore((s) => s.onboardingOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const goal = useAppStore((s) => s.session?.goal ?? null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const suppressRef = useRef(false)
  const dragDepthRef = useRef(0)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [popup, setPopup] = useState<TriggerState | null>(null)
  const [customCommands, setCustomCommands] = useState<CustomCommandInfo[]>([])
  const customCommandsRequestRef = useRef(0)
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [dragCount, setDragCount] = useState(0)
  const [sweep, setSweep] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [manualHeight, setManualHeight] = useState(settings.composerHeight || 0)
  const [maxInputHeight, setMaxInputHeight] = useState(maxInputHeightForViewport)
  const goalBusyRef = useRef(false)

  useEffect(() => {
    setManualHeight(settings.composerHeight || 0)
  }, [settings.composerHeight])

  useEffect(() => {
    const onResize = (): void => setMaxInputHeight(maxInputHeightForViewport())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const beginComposerResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>): void => {
      event.preventDefault()
      const startY = event.clientY
      const startHeight = manualHeight > 0 ? manualHeight : Math.max(MIN_INPUT_HEIGHT, textareaRef.current?.clientHeight ?? MIN_INPUT_HEIGHT)
      let latest = startHeight
      let moved = false
      const onMove = (moveEvent: PointerEvent): void => {
        moved = true
        latest = Math.max(MIN_INPUT_HEIGHT, Math.min(maxInputHeight, Math.round(startHeight + startY - moveEvent.clientY)))
        setManualHeight(latest)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('is-resizing-composer')
        if (moved) void updateSettings({ composerHeight: latest })
      }
      document.body.classList.add('is-resizing-composer')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [manualHeight, maxInputHeight, updateSettings]
  )

  const onComposerResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const current = manualHeight || Math.max(MIN_INPUT_HEIGHT, textareaRef.current?.clientHeight ?? MIN_INPUT_HEIGHT)
      const next = Math.max(MIN_INPUT_HEIGHT, Math.min(maxInputHeight, current + (event.key === 'ArrowUp' ? 16 : -16)))
      setManualHeight(next)
      void updateSettings({ composerHeight: next })
    },
    [manualHeight, maxInputHeight, updateSettings]
  )

  const modelRef = session?.model ?? settings.defaultModel
  const modelInfo = findModel(settings.providers, modelRef)
  const permissionMode = session?.permissionMode ?? settings.permissionMode
  const permission = PERMISSION_OPTIONS.find((item) => item.value === permissionMode) ?? PERMISSION_OPTIONS[1]
  const reasoningEffort = session?.reasoningEffort ?? settings.reasoningEffort
  const reasoningAvailable = Boolean(modelInfo?.supportsReasoning && modelInfo.reasoningStyle)
  const sessionMode: SessionMode =
    session?.mode === 'chat' ? 'chat' : session?.mode === 'research' ? 'research' : 'work'
  const uiSessionMode: ComposerMode = sessionMode === 'chat' ? 'chat' : 'work'
  const chatMode = sessionMode === 'chat'
  const researchMode = sessionMode === 'research'
  const researchLocked =
    researchMode &&
    (session?.research?.status === 'searching' ||
      session?.research?.status === 'planning' ||
      session?.research?.status === 'ready')
  const planMode = !chatMode && !researchMode && session?.planMode === true
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>(session?.research?.depth ?? 'standard')
  useEffect(() => {
    setResearchDepth(session?.research?.depth ?? 'standard')
  }, [session?.id, session?.research?.depth])
  const sendResearchOptions = researchMode ? { researchDepth } : undefined
  const workspace = session?.workspace ?? settings.lastWorkspace
  const activeRuns = useAppStore((s) => s.runs)
  const running = !!run
  const runningCurrent = !!run && run.sessionId === session?.id
  const backgroundRuns = Object.values(activeRuns).filter((item) => item.sessionId !== session?.id)
  const backgroundRun = backgroundRuns[0] ?? null
  const backgroundPending = backgroundRun
    ? pendingPermissions[backgroundRun.sessionId] ?? pendingQuestions[backgroundRun.sessionId] ?? null
    : null
  const backgroundTitle = backgroundRun
    ? sessions.find((item) => item.id === backgroundRun.sessionId)?.title ?? '另一个对话'
    : ''
  const goalActive = goal?.status === 'active'
  const isEnterSend = settings.sendKey === 'enter'
  const canSend =
    ready &&
    !compacting &&
    !goalActive &&
    !interrupting &&
    (text.trim().length > 0 || attachments.length > 0)

  /* ── 目标入口：输入框 /goal 前缀或目标按钮，不再使用独立弹窗 ── */
  const goalUnavailable = useCallback((): boolean => {
    if ((useAppStore.getState().session?.mode ?? 'work') === 'chat') {
      notify('warning', '聊天模式下不能建立目标：先切到工作模式，再建立多轮目标。')
      return true
    }
    if (useAppStore.getState().session?.mode === 'research') {
      notify('warning', '深度研究模式由研究轮次自动推进，不需要再建立目标。')
      return true
    }
    const state = useAppStore.getState()
    if (state.compacting && (!state.compactingSessionId || state.compactingSessionId === state.session?.id)) {
      notify('info', '正在压缩上下文，完成后再建立目标。')
      return true
    }
    const current = state.session?.goal
    if (current && (current.status === 'active' || current.status === 'paused' || current.status === 'blocked')) {
      document.querySelector('.goal-bar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      notify('info', '当前对话已有目标，可在上方目标条暂停、继续或结束。')
      return true
    }
    if (state.run) {
      notify('warning', '当前还有任务在运行，先停止或等它完成后再建立目标。')
      return true
    }
    return false
  }, [notify])

  const armGoalPrefix = useCallback((): void => {
    if (goalUnavailable()) return
    setText('/goal ')
    setPopup(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    notify('info', '在 /goal 后面写下目标，按 Enter 建立；Morrow 会自动多轮推进。')
  }, [goalUnavailable, notify])

  const armPlanPrefix = useCallback((): void => {
    const state = useAppStore.getState()
    if ((state.session?.mode ?? 'work') === 'chat') {
      notify('warning', '聊天模式不能进入计划模式：先切到工作模式。')
      return
    }
    if (state.session?.mode === 'research') {
      notify('warning', '深度研究模式不需要计划模式：研究轮次会自动推进。')
      return
    }
    if (state.run) {
      notify('warning', '当前还有任务在运行，先停止或等它完成后再进入计划模式。')
      return
    }
    setText('/plan ')
    setPopup(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    notify('info', '在 /plan 后面写下任务，按 Enter 进入计划模式并发送；也可以点计划图标直接切换。')
  }, [notify])

  const openGoalEntry = useCallback(
    (objectiveArg?: string): void => {
      if (goalUnavailable()) return
      const raw = (objectiveArg ?? text).trim().replace(/^\/goal\s+/i, '').trim()
      if (!raw) {
        armGoalPrefix()
        return
      }
      if (attachments.length > 0) {
        notify('warning', '目标模式只接受文字目标；附件请先移除，或随普通消息发送。')
        return
      }
      if (goalBusyRef.current) return
      goalBusyRef.current = true
      void (async () => {
        try {
          const current = useAppStore.getState().session?.goal
          if (current) await clearGoal()
          await startGoal(raw)
          setText('')
          setAttachments([])
          setPopup(null)
          requestAnimationFrame(() => textareaRef.current?.focus())
        } catch {
          // store 已提示具体原因；保留输入，修好后可重试
        } finally {
          goalBusyRef.current = false
        }
      })()
    },
    [armGoalPrefix, attachments.length, clearGoal, goalUnavailable, notify, startGoal, text]
  )

  const initProjectRules = useCallback((): void => {
    const state = useAppStore.getState()
    const current = state.session
    if (!current) {
      notify('warning', '先打开一个对话，再生成 AGENTS.md。')
      return
    }
    if (!current.workspace) {
      notify('warning', '当前对话没有文件夹，无法生成 AGENTS.md。')
      return
    }
    if (state.run) {
      notify('warning', '当前还有任务在运行，先停止或等它完成。')
      return
    }
    if ((current.mode ?? 'work') === 'chat') {
      notify('warning', '聊天模式只讨论、不写文件：先把「聊天 / 工作」切到工作。')
      return
    }
    if (current.planMode) {
      notify('warning', '计划模式只出方案：批准执行后再生成 AGENTS.md。')
      return
    }
    if ((current.permissionMode ?? state.settings.permissionMode) === 'read-only') {
      notify('warning', '只读模式不能写文件：先把权限模式切到询问或完全访问。')
      return
    }
    const workspace = current.workspace
    void (async () => {
      let existing: string[] = []
      try {
        const result = await window.morrow.features.invoke<{
          files: Array<{ path: string; scope: 'project' | 'parent' | 'user' }>
        }>('feature:rules:list', { workspace })
        if (result.ok) {
          existing = result.data.files.filter((file) => file.scope === 'project').map((file) => file.path)
        }
      } catch {
        // 规则发现失败不阻塞初始化
      }
      const latest = useAppStore.getState()
      if (latest.session?.id !== current.id || latest.session.workspace !== workspace || latest.run) {
        notify('info', '对话已切换或开始运行，本次 /init 已取消。')
        return
      }
      const context = existing.length
        ? `当前文件夹已有的项目规则文件：\n${existing.map((path) => `- ${path}`).join('\n')}\n请先读取这些文件，在现有文件上补充更新，不要新建重复文件。`
        : '当前文件夹还没有项目规则文件，请在文件夹根目录创建 AGENTS.md。'
      void latest.sendMessage(`${INIT_RULES_PROMPT}\n\n${context}`)
    })()
  }, [notify])

  /* 自定义命令（.morrow/commands） */
  const loadCustomCommands = useCallback(async (): Promise<void> => {
    const request = customCommandsRequestRef.current + 1
    customCommandsRequestRef.current = request
    try {
      const result = await window.morrow.features.invoke<CustomCommandInfo[]>('feature:commands:list', {
        ...(workspace ? { workspace } : {})
      })
      if (result.ok && customCommandsRequestRef.current === request) setCustomCommands(result.data)
    } catch {
      // 命令发现失败不影响正常输入
    }
  }, [workspace])

  useEffect(() => {
    void loadCustomCommands()
  }, [loadCustomCommands])

  const armCustomCommand = useCallback((command: CustomCommandInfo): void => {
    setText(`/${command.name} `)
    setPopup(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [])

  /* 斜杠命令表（闭包内可用 store actions） */
  const commands = useMemo<CommandDef[]>(() => {
    const compactBlockedReason = compacting
      ? '正在压缩，稍等一下。'
      : running
        ? '生成过程中不能压缩，先停下再试。'
        : !session
          ? '先发一条消息，有一个对话之后再压缩。'
          : null
    const initBlockedReason = !session
      ? '先打开一个对话。'
      : !session.workspace
        ? '当前对话没有文件夹。'
        : running
          ? '生成过程中不能初始化项目规则，先停止再试。'
          : chatMode
            ? '聊天模式不写文件：先切到工作模式。'
            : planMode
              ? '计划模式只出方案：执行计划后再生成规则文件。'
              : permissionMode === 'read-only'
                ? '只读模式不能写文件：先切换到询问或完全访问。'
                : null
    return [
      { name: 'new', label: '新建对话', description: '把当前对话收起来，开一个新对话', run: () => void newSession() },
      {
        name: 'temp',
        label: '临时对话',
        description: '开一个不保存的对话：不进入历史与搜索，关闭应用后消失',
        run: () => void newSession({ temporary: true })
      },
      { name: 'demo', label: '看一场演示', description: '离线跑完一个真实任务，约 40 秒', run: () => void startDemo() },
      {
        name: 'plan',
        label: planMode ? '退出计划模式' : '计划模式',
        description: chatMode
          ? '聊天模式不能使用计划模式；先切换到工作模式'
          : planMode
            ? '退出计划模式，恢复直接执行'
            : '先只读探索并给出计划，等你批准后再执行',
        disabled: chatMode || running,
        disabledReason: chatMode ? '聊天模式不能使用计划模式：先切到工作模式。' : '生成过程中不能切换计划模式，先停止再试。',
        run: () => (planMode ? void setPlanMode(false) : armPlanPrefix())
      },
      {
        name: 'research',
        label: researchMode ? '退出深度研究' : '深度研究',
        description: chatMode
          ? '聊天模式不能研究；先切到工作模式，再用 /research 问题'
          : researchMode
            ? '退出研究子流程，回到普通工作；已完成的研究报告仍保留'
            : '在当前工作对话中启动多轮检索、来源核对与带引用报告；可写 /research quick 问题',
        disabled: chatMode || running,
        disabledReason: chatMode
          ? '聊天模式不能研究：先切到工作模式。'
          : running
            ? '当前正在运行，等本轮结束或先停止，再启动/退出研究。'
            : undefined,
        run: () => {
          if (researchMode) {
            void setSessionMode('work')
            return
          }
          setText('/research ')
          setPopup(null)
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
          notify('info', '在 /research 后面写研究问题；可先写 quick / standard / deep 指定深度。')
        }
      },
      { name: 'settings', label: '打开设置', description: '模型、权限、外观、功能与工具', run: openSettings },
      {
        name: 'btw',
        label: '侧边聊天',
        description: '在右侧栏问一句，不影响主对话（只回答，不改文件）',
        disabled: !session,
        disabledReason: '先打开一个对话。',
        run: () => openSideChat()
      },
      {
        name: 'swarm',
        label: '集群',
        description: chatMode
          ? '聊天模式不能启动集群；先切换到工作模式'
          : planMode
            ? '计划模式只读探索；批准后再用集群'
            : '把目标拆成 1–10 个独立部分，交给集群成员并行完成',
        disabled: chatMode || planMode || running || !session,
        disabledReason: chatMode
          ? '聊天模式不能启动集群：先切到工作模式。'
          : planMode
            ? '计划模式只读探索；批准执行后再用集群。'
            : running
              ? '当前正在运行，等本轮结束或先停止。'
              : '先打开一个对话。',
        run: () => {
          setText('/swarm ')
          setPopup(null)
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
          notify('info', '在 /swarm 后面写下目标；Morrow 会拆成 1–10 个独立部分，交给集群成员并行完成。')
        }
      },
      chatMode
        ? {
            name: 'goal',
            label: '建立目标（工作模式可用）',
            description: '聊天模式只讨论，不执行多轮目标；切到工作模式后再用',
            disabled: true,
            disabledReason: '聊天模式下不能建立目标：先把输入框旁的「聊天 / 工作」切到「工作」。',
            run: armGoalPrefix
          }
        : {
            name: 'goal',
            label: '建立目标',
            description: '在 /goal 后写下目标，回车后自动多轮推进',
            run: armGoalPrefix
          },
      {
        name: 'init',
        label: '生成 AGENTS.md',
        description: session?.workspace ? '分析文件夹并生成或更新项目规则文件' : '先选择文件夹',
        disabled: initBlockedReason !== null,
        disabledReason: initBlockedReason ?? undefined,
        run: initProjectRules
      },
      { name: 'clear', label: '清空输入', description: '只清空输入框里的内容，不发出去', run: () => setText('') },
      {
        name: 'rewind',
        label: '回到某一轮之前',
        description: session?.temporary
          ? '临时对话不保存整轮回退记录；文件改动仍可在执行过程里逐个撤销'
          : running
            ? '生成过程中不能回到之前，先停止再试'
            : '文件和对话一起回到某一轮开始前',
        disabled: running || !session || session.temporary === true,
        disabledReason: session?.temporary
          ? '临时对话不保存整轮回退记录。'
          : running
            ? '生成过程中不能回到之前：先停止本轮运行。'
            : '先发一条消息，有可回到的轮次之后才能使用。',
        run: () => openRewind()
      },
      {
        name: 'export',
        label: '导出对话（Markdown）',
        description: '把当前对话导出为 Markdown 文件',
        disabled: !session,
        disabledReason: '先打开一个对话。',
        run: () => void exportCurrentSession('markdown')
      },
      {
        name: 'export-json',
        label: '导出对话（JSON）',
        description: '把当前对话的完整结构导出为 JSON',
        disabled: !session,
        disabledReason: '先打开一个对话。',
        run: () => void exportCurrentSession('json')
      },
      {
        name: 'git',
        label: '打开版本历史',
        description: workspace ? '查看改动、保存版本记录与历史' : '先选择文件夹',
        disabled: !workspace,
        disabledReason: '先选择文件夹。',
        run: () => openWorkbench('git')
      },
      {
        name: 'usage',
        label: '用量与费用',
        description: '查看当前对话的 token 用量、上下文占用与估算费用',
        run: () => {
          requestSettingsTab('context')
          openSettings()
        }
      },
      {
        name: 'compact',
        label: '压缩上下文',
        description: compactBlockedReason ?? '把较早的对话压成摘要，腾出上下文空间',
        disabled: compactBlockedReason !== null,
        disabledReason: compactBlockedReason ?? undefined,
        run: () => void compactSession()
      },
      ...customCommands
        .filter((command) => !RESERVED_COMMAND_NAMES.has(command.name))
        .map((command) => ({
          name: command.name,
          label: command.description,
          description: `${command.scope === 'project' ? '项目' : '用户'}命令 · ${command.argumentHint ?? '输入 /' + command.name + ' 调用'}`,
          custom: true,
          run: () => armCustomCommand(command)
        }))
    ]
  }, [newSession, startDemo, openSettings, armGoalPrefix, armPlanPrefix, compactSession, compacting, running, session, chatMode, researchMode, planMode, permissionMode, setPlanMode, setSessionMode, notify, openRewind, initProjectRules, workspace, exportCurrentSession, customCommands, armCustomCommand])

  /* 自动增高（到窗口 1/3 才出现内部滚动条）；手动拖动过高度时以手动值为下限 */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = maxInputHeight
    const min = manualHeight > 0 ? Math.min(manualHeight, max) : MIN_INPUT_HEIGHT
    const next = Math.min(max, Math.max(min, el.scrollHeight))
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text, manualHeight, maxInputHeight])

  /* 运行计时 */
  const runId = run?.runId
  const startedAt = run?.startedAt
  useEffect(() => {
    if (!runId || !startedAt) {
      setElapsed(0)
      return
    }
    const tick = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [runId, startedAt])

  /* 就绪后自动聚焦（有覆盖层或当前对话运行时不抢焦点；后台运行仍可先准备消息） */
  useEffect(() => {
    if (!ready || onboardingOpen || settingsOpen || paletteOpen || runningCurrent) return
    textareaRef.current?.focus()
  }, [ready, onboardingOpen, settingsOpen, paletteOpen, runningCurrent])

  /* @ 文件搜索（160ms 防抖） */
  useEffect(() => {
    if (!popup || popup.kind !== 'file' || !popup.query.trim()) {
      setFileResults([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void searchFiles(popup.query).then((results) => {
        if (!cancelled) setFileResults(results)
      })
    }, 160)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [popup, searchFiles])

  useEffect(() => {
    setActiveIndex(0)
  }, [popup?.kind, popup?.query])

  useEffect(() => {
    if (popup?.kind === 'command') void loadCustomCommands()
  }, [popup?.kind, loadCustomCommands])

  const syncPopup = useCallback((value: string, caret: number | null): void => {
    if (suppressRef.current) return
    setPopup(caret === null ? null : findTrigger(value, caret))
  }, [])

  /* 候选项：命令 / 文件 */
  const popupItems = useMemo(() => {
    if (!popup) return []
    if (popup.kind === 'command') {
      return commands
        .filter((command) => command.name.startsWith(popup.query.toLowerCase()))
        .map((command) => ({ key: `cmd:${command.name}`, label: command.label, description: command.description, command }))
    }
    return fileResults.map((file) => ({
      key: `file:${file.path}`,
      label: file.name,
      description: file.dir ? `文件夹 / ${file.dir}` : '文件夹根目录',
      file
    }))
  }, [popup, commands, fileResults])

  const closePopup = (): void => {
    setPopup(null)
    suppressRef.current = true
  }

  const choosePopupItem = (index: number): void => {
    if (!popup) return
    const item = popupItems[index]
    if (!item) return
    if ('command' in item && item.command) {
      setText('')
      setPopup(null)
      if (item.command.disabled) {
        notify('warning', item.command.disabledReason ?? '这个命令现在不可用。')
        return
      }
      item.command.run?.()
      return
    }
    if ('file' in item && item.file) {
      const textarea = textareaRef.current
      const value = textarea?.value ?? text
      const caret = textarea?.selectionStart ?? value.length
      const insert = `@${item.file.dir ? `${item.file.dir}/` : ''}${item.file.name}`
      const next = `${value.slice(0, popup.start)}${insert} ${value.slice(caret)}`
      const nextCaret = popup.start + insert.length + 1
      setText(next)
      setPopup(null)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(nextCaret, nextCaret)
      })
    }
  }

  const executeExactCommand = (value: string): boolean => {
    const match = /^\/([a-z-]+)$/i.exec(value)
    if (!match) return false
    const command = commands.find((item) => item.name === match[1].toLowerCase())
    if (!command) return false
    setText('')
    if (command.disabled) {
      notify('warning', command.disabledReason ?? '这个命令现在不可用。')
      return true
    }
    command.run?.()
    return true
  }

  /** 发送失败时把内容放回输入框；用户已经开始输入新内容时不覆盖。 */
  const restoreDraft = (draft: string, files: Attachment[]): void => {
    setText((current) => (current.trim() ? current : draft))
    setAttachments((current) => (current.length > 0 ? current : files))
    if (draft.trim()) requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const submit = (intent?: 'steer' | 'queue'): void => {
    const value = text.trim()
    if (!ready || interrupting) return
    if (compacting) {
      notify('info', '正在压缩上下文，完成后再发送。')
      return
    }
    // 只有附件、没有文字也可以发送（对标常见聊天应用）
    if (!value && attachments.length === 0) return
    // /btw [问题]：打开侧边聊天（可选直接带上问题）
    const btwCommand = /^\/btw(?:\s+([\s\S]*))?$/i.exec(value)
    if (btwCommand) {
      setText('')
      setPopup(null)
      openSideChat((btwCommand[1] ?? '').trim() || undefined)
      return
    }
    // /research [quick|standard|deep] [问题]：工作模式内启动深度研究子流程
    const researchCommand = /^\/research(?:\s+(quick|standard|deep|快速|标准|深入))?(?:\s+([\s\S]*))?$/i.exec(value)
    if (researchCommand) {
      const rawDepth = (researchCommand[1] ?? '').toLowerCase()
      const topic = (researchCommand[2] ?? '').trim()
      const depthMap: Record<string, ResearchDepth> = { quick: 'quick', standard: 'standard', deep: 'deep', 快速: 'quick', 标准: 'standard', 深入: 'deep' }
      const requestedDepth = depthMap[rawDepth] ?? researchDepth
      setPopup(null)
      if (!topic) {
        setText(rawDepth ? `/research ${researchCommand[1]} ` : '/research ')
        requestAnimationFrame(() => textareaRef.current?.focus())
        notify('info', '在 /research 后面写研究问题；可先写 quick / standard / deep 指定深度。')
        return
      }
      if (chatMode) {
        notify('warning', '聊天模式不能启动深度研究：先切到工作模式。')
        return
      }
      if (running) {
        notify('warning', '当前正在运行，等本轮结束或先停止，再启动新的研究。')
        return
      }
      if (researchMode) {
        notify('info', '当前已有研究子流程；先完成或退出研究，再开始新的研究。')
        return
      }
      if (planMode) {
        notify('warning', '计划模式只读探索；先退出计划模式，再启动深度研究。')
        return
      }
      if (goalActive) {
        notify('warning', '目标进行中，先暂停或结束目标，再启动深度研究。')
        return
      }
      const outgoing = attachments
      setText('')
      setAttachments([])
      setSweep(true)
      window.setTimeout(() => setSweep(false), 480)
      setResearchDepth(requestedDepth)
      void (async () => {
        await setSessionMode('research')
        if (useAppStore.getState().session?.mode !== 'research') return
        const ok = await sendMessage(topic, outgoing.length ? outgoing : undefined, { researchDepth: requestedDepth })
        if (!ok) await setSessionMode('work')
      })()
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    // /plan [任务]：给出提示并保留输入；带任务发送时自动进入计划模式
    const planCommand = /^\/plan(?:\s+([\s\S]*))?$/i.exec(value)
    if (planCommand) {
      const request = (planCommand[1] ?? '').trim()
      if (!request) {
        armPlanPrefix()
        return
      }
      setText('')
      setPopup(null)
      if (chatMode) {
        notify('warning', '聊天模式不能进入计划模式：先切到工作模式。')
        return
      }
      if (researchMode) {
        notify('warning', '深度研究模式不需要计划模式：研究轮次会自动推进。')
        return
      }
      const outgoing = attachments
      setAttachments([])
      setSweep(true)
      window.setTimeout(() => setSweep(false), 480)
      void (async () => {
        if (!planMode) await setPlanMode(true)
        if (!useAppStore.getState().session?.planMode) return
        await sendMessage(request, outgoing.length ? outgoing : undefined)
      })()
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    // /swarm + 目标：让模型拆成集群任务（真正的编排仍由模型决定）
    const swarmCommand = /^\/swarm(?:\s+([\s\S]*))?$/i.exec(value)
    if (swarmCommand) {
      const objective = (swarmCommand[1] ?? '').trim()
      setText('')
      setPopup(null)
      if (!objective) {
        notify('info', '在 /swarm 后面写下总目标，例如 /swarm 分别检查前端、后端与测试。')
        return
      }
      if (chatMode) {
        notify('warning', '聊天模式不能启动集群：先切到工作模式。')
        return
      }
      if (researchMode) {
        notify('warning', '深度研究模式不启用集群：先切到工作模式。')
        return
      }
      if (planMode) {
        notify('warning', '计划模式只读探索；批准执行后再用集群。')
        return
      }
      const outgoing = attachments
      setAttachments([])
      setSweep(true)
      window.setTimeout(() => setSweep(false), 480)
      void sendMessage(
        [
          '请把下面的总目标拆成 1–10 个相互独立的子任务，并用 swarm 工具（集群）并行交给合适的成员类型（explore/plan/review/test/docs/general）；成员与主代理拥有相同的工作区权限，类型只改变工作重点。每个子任务写清背景、输入/输出与验证方式。',
          '等所有子任务返回后，汇总结果、检查是否有失败或冲突，再给出真实可验证的最终结果；不要把未完成的子任务当作完成。',
          '',
          `总目标：${objective}`
        ].join('\n'),
        outgoing.length ? outgoing : undefined
      )
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    // /goal + 目标：直接在输入框建立目标（不再弹独立对话框）
    const goalCommand = /^\/goal(?:\s+([\s\S]*))?$/i.exec(value)
    if (goalCommand) {
      const objective = (goalCommand[1] ?? '').trim()
      if (objective) openGoalEntry(objective)
      else armGoalPrefix()
      return
    }
    if (executeExactCommand(value)) return
    const customCommand = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(value)
    const customName = customCommand ? customCommand[1].toLowerCase() : ''
    const customDef =
      customName && !RESERVED_COMMAND_NAMES.has(customName)
        ? customCommands.find((command) => command.name === customName)
        : undefined
    if (customCommand && customDef) {
      if (goalActive) {
        notify('warning', '目标进行中，先在目标条暂停或结束，再调用自定义命令。')
        return
      }
      const expanded = expandCustomCommand(customDef.body, customCommand[2] ?? '')
      const outgoing = attachments
      setText('')
      setAttachments([])
      setPopup(null)
      setSweep(true)
      window.setTimeout(() => setSweep(false), 480)
      void sendMessage(expanded, outgoing.length ? outgoing : undefined, sendResearchOptions).then((ok) => {
        if (!ok) restoreDraft(value, outgoing)
      })
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    if (customCommand && !customDef) {
      notify(
        'warning',
        RESERVED_COMMAND_NAMES.has(customName)
          ? `/${customName} 是内置命令，不能这样传入参数。`
          : `没有名为 /${customName} 的命令。请检查命令名，或删除开头的斜杠后再发送。`
      )
      return
    }
    if (goalActive) {
      notify('warning', '目标进行中，先在目标条暂停或结束，再发送普通消息。')
      return
    }
    if (runningCurrent && (intent ?? settings.runningSendMode) === 'steer') {
      interruptCurrent()
      return
    }
    const outgoing = attachments
    setText('')
    setAttachments([])
    setPopup(null)
    setSweep(true)
    window.setTimeout(() => setSweep(false), 480)
    void sendMessage(value, outgoing.length ? outgoing : undefined, sendResearchOptions).then((ok) => {
      if (!ok) restoreDraft(value, outgoing)
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const interruptCurrent = (): void => {
    const value = text.trim()
    if (!canSend || (!value && attachments.length === 0)) return
    const outgoing = attachments
    setText('')
    setAttachments([])
    setPopup(null)
    setSweep(true)
    window.setTimeout(() => setSweep(false), 480)
    void interruptAndSend(value, outgoing.length ? outgoing : undefined).then((ok) => {
      if (!ok) restoreDraft(value, outgoing)
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const announceAttachmentWarnings = (items: Attachment[]): void => {
    const warned = items.find((item) => item.note || item.truncated)
    if (warned) notify('warning', `${warned.name}：${warned.note ?? '内容过长，已截断'}`)
  }

  const addDroppedFiles = async (files: File[]): Promise<void> => {
    if (files.length > ATTACHMENT_MAX_COUNT) {
      notify('warning', `最多添加 ${ATTACHMENT_MAX_COUNT} 个附件，已保留前 ${ATTACHMENT_MAX_COUNT} 个。`)
    }
    const accepted = files.slice(0, ATTACHMENT_MAX_COUNT)
    const built: Attachment[] = []
    for (const file of accepted) {
      built.push(await normalizeImageAttachment(await attachmentFromFile(file)))
    }
    announceAttachmentWarnings(built)
    const existing = new Set(attachments.map(attachmentKey))
    if (attachments.length + built.filter((file) => !existing.has(attachmentKey(file))).length > ATTACHMENT_MAX_COUNT) {
      notify('warning', `最多添加 ${ATTACHMENT_MAX_COUNT} 个附件，超出的已忽略。`)
    }
    setAttachments((previous) => mergeAttachmentList(previous, built))
  }

  const onDragEnter = (event: React.DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
    setDragCount(event.dataTransfer.items.length)
  }

  const onDragLeave = (): void => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0) return
    // 粘贴图片/文件时不要让文件名文本落进输入框
    event.preventDefault()
    void addDroppedFiles(files)
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) void addDroppedFiles(files)
  }

  const removeAttachment = (id: string): void => {
    setAttachments((previous) => previous.filter((item) => item.id !== id))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const composing = event.nativeEvent.isComposing

    if (popup && popupItems.length > 0 && !composing) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % popupItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + popupItems.length) % popupItems.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choosePopupItem(activeIndex)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closePopup()
        return
      }
    }

    if (event.key === 'Escape') {
      if (runningCurrent) {
        event.preventDefault()
        void stopRun()
      }
      return
    }

    if (event.key === 'Enter' && !composing) {
      const withModifier = event.ctrlKey || event.metaKey
      const shouldSend = isEnterSend ? !event.shiftKey || withModifier : withModifier
      if (shouldSend) {
        event.preventDefault()
        submit()
      }
    }
  }

  const placeholder = planMode
      ? runningCurrent
        ? '计划模式生成中…输入内容会加入队列，本轮结束后自动发送。'
        : '计划模式：先只读探索，Morrow 会给出计划；你批准后才开始执行。'
      : goalActive
        ? '目标模式进行中。Morrow 会自动继续下一轮，暂停目标后可以自由输入。'
        : runningCurrent
          ? settings.runningSendMode === 'steer'
            ? 'Morrow 正在处理…按 Enter 会停止当前任务并立即插话；也可点箭头排队。'
            : 'Morrow 正在处理…按 Enter 加入队列，本轮结束后自动发送；也可点闪电插话。'
          : chatMode
            ? '聊天模式：只讨论与分析，不会改文件、不跑命令。需要动手时切到「工作」。'
            : '说清想要的结果，Morrow 会自己想办法完成。'

  const modelOptions = useMemo(
    () =>
      settings.providers
        .filter(
          (provider) =>
            provider.enabled &&
            (provider.kind !== 'demo' || session?.demo === true) &&
            (provider.kind === 'demo' || provider.apiKeyStored || provider.id === modelRef.providerId)
        )
        .flatMap((provider) =>
          provider.models.map((info) => ({
            value: `${provider.id}:${info.id}`,
            label: info.label,
            description:
              provider.kind === 'demo'
                ? '离线演示 · 不消耗额度'
                : `${provider.name} · 上下文 ${Math.round(info.contextWindow / 1000)}k`
          }))
        ),
    [settings.providers, modelRef.providerId]
  )

  return (
    <div className="composer">
      <button
        type="button"
        className="composer-resize"
        aria-label="拖动调整输入框高度"
        title="拖动调整输入框高度"
        onPointerDown={beginComposerResize}
        onKeyDown={onComposerResizeKey}
      >
        <span className="composer-resize-grip" aria-hidden />
      </button>
      <div
        className={[
          'composer-shell',
          dragging ? 'is-dragging' : '',
          running ? 'is-running' : '',
          backgroundRun ? 'is-background-run' : '',
          chatMode ? 'is-chat' : '',
          planMode ? 'is-plan' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onDragEnter={onDragEnter}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="composer-horizon" aria-hidden />
        {sweep ? <span className="composer-sweep" aria-hidden /> : null}

        {backgroundRun ? (
          <div className={['composer-background', backgroundPending ? 'is-attention' : ''].filter(Boolean).join(' ')} role="status">
            <span className="composer-background-dot" aria-hidden />
            <span className="composer-background-copy">
              <span className="composer-background-title truncate">「{backgroundTitle}」</span>
              <span className="composer-background-sub">
                {backgroundPending ? '等待你的确认' : backgroundRuns.length > 1 ? `${backgroundRuns.length} 个后台任务运行中` : '正在运行'}
              </span>
            </span>
            <div className="composer-background-actions">
              <button type="button" onClick={() => void selectSession(backgroundRun.sessionId)}>
                返回处理
              </button>
              <button type="button" className="is-danger" onClick={() => void stopRunById(backgroundRun.runId)}>
                停止
              </button>
            </div>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="composer-files" aria-label="附件">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className={['composer-file', attachment.note || attachment.truncated ? 'is-warn' : ''].filter(Boolean).join(' ')}
                title={attachment.note ?? attachment.path}
              >
                {attachment.kind === 'image' ? (
                  <FileImage size={12} strokeWidth={1.5} aria-hidden />
                ) : attachment.kind === 'text' ? (
                  <FileText size={12} strokeWidth={1.5} aria-hidden />
                ) : (
                  <FileIcon size={12} strokeWidth={1.5} aria-hidden />
                )}
                <span className="composer-file-name truncate">{attachment.name}</span>
                <span className="composer-file-size mono">{formatBytes(attachment.size)}</span>
                {attachment.note || attachment.truncated ? (
                  <span
                    className="composer-file-warn"
                    role="img"
                    title={attachment.note ?? '内容过长，已截断'}
                    aria-label={attachment.note ?? '内容过长，已截断'}
                  >
                    <AlertTriangle size={11} strokeWidth={1.6} aria-hidden />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="composer-file-remove"
                  aria-label={`移除附件 ${attachment.name}`}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <X size={11} strokeWidth={1.8} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          className="composer-input input"
          value={text}
          rows={1}
          placeholder={placeholder}
          disabled={!ready}
          aria-label="输入消息"
          aria-autocomplete="list"
          aria-expanded={!!popup}
          onChange={(event) => {
            suppressRef.current = false
            setText(event.target.value)
            syncPopup(event.target.value, event.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onKeyUp={(event) => {
            const el = event.currentTarget
            if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return
            syncPopup(el.value, el.selectionStart)
          }}
          onClick={(event) => syncPopup(event.currentTarget.value, event.currentTarget.selectionStart)}
          onSelect={(event) => syncPopup(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => setPopup(null)}
        />

        {popup ? (
          <div
            className="composer-pop"
            role="listbox"
            aria-label={popup.kind === 'command' ? '命令' : '引用文件夹里的文件'}
          >
            <div className="composer-pop-head mono">
              {popup.kind === 'command' ? '命令' : '引用文件'}
              <span className="composer-pop-hint">
                {popup.kind === 'command' ? '↑↓ 选择 · Enter 运行' : '↑↓ 选择 · Enter 引用'}
              </span>
            </div>
            {popupItems.length === 0 ? (
              <p className="composer-pop-empty">
                {popup.kind === 'command'
                  ? '没有匹配的命令。输入 / 查看全部命令。'
                  : !workspace
                    ? '还没有选择文件夹。先在顶栏选择一个文件夹，再引用文件。'
                    : popup.query
                      ? `没有找到「${popup.query}」相关文件。`
                      : '输入文件名开始搜索。'}
              </p>
            ) : (
              popupItems.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={'command' in item && item.command?.disabled ? true : undefined}
                  className={[
                    'composer-pop-item',
                    index === activeIndex ? 'is-active' : '',
                    'command' in item && item.command?.disabled ? 'is-disabled' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choosePopupItem(index)
                  }}
                >
                  <span className="composer-pop-icon" aria-hidden>
                    {'command' in item ? (
                      item.command?.name === 'new' ? (
                        <PlusCircle size={14} strokeWidth={1.5} />
                      ) : item.command?.name === 'demo' ? (
                        <Sparkles size={14} strokeWidth={1.5} />
                      ) : item.command?.name === 'settings' ? (
                        <SettingsIcon size={14} strokeWidth={1.5} />
                      ) : item.command?.name === 'clear' ? (
                        <Eraser size={14} strokeWidth={1.5} />
                      ) : item.command?.name === 'plan' ? (
                        <ClipboardList size={14} strokeWidth={1.5} />
                      ) : item.command?.name === 'rewind' ? (
                        <RotateCcw size={14} strokeWidth={1.5} />
                      ) : item.command?.name === 'init' ? (
                        <Sparkles size={14} strokeWidth={1.5} />
                      ) : item.command?.custom ? (
                        <Zap size={14} strokeWidth={1.5} />
                      ) : (
                        <Minimize2 size={14} strokeWidth={1.5} />
                      )
                    ) : (
                      <FileText size={14} strokeWidth={1.5} />
                    )}
                  </span>
                  <span className="composer-pop-main">
                    <span className="composer-pop-title truncate">{item.label}</span>
                    <span className="composer-pop-desc truncate">{item.description}</span>
                  </span>
                  {'command' in item ? (
                    <span className="composer-pop-key mono">/{item.command?.name}</span>
                  ) : (
                    <span className="composer-pop-key mono">{item.file?.name.split('.').pop()?.toUpperCase()}</span>
                  )}
                </button>
              ))
            )}
          </div>
        ) : null}

        <div className="composer-bar">
          <div className="composer-bar-left">
            <IconButton label="添加文件（也可直接粘贴或拖入）" size={28} onClick={() => void attachFiles().then(async (files) => {
              if (files.length === 0) return
              const ready = await normalizeImageAttachments(files)
              announceAttachmentWarnings(ready)
              const existing = new Set(attachments.map(attachmentKey))
              if (attachments.length + ready.filter((file) => !existing.has(attachmentKey(file))).length > ATTACHMENT_MAX_COUNT) {
                notify('warning', `最多添加 ${ATTACHMENT_MAX_COUNT} 个附件，超出的已忽略。`)
              }
              setAttachments((previous) => mergeAttachmentList(previous, ready))
            })}>
              <Paperclip size={15} strokeWidth={1.5} aria-hidden />
            </IconButton>
            {chatMode || researchMode || planMode ? null : (
              <IconButton
                label={goal ? '查看当前目标' : '把输入框内容设为目标（多轮自动推进）'}
                size={28}
                active={!!goal && ['active', 'paused', 'blocked'].includes(goal.status)}
                onClick={() => openGoalEntry()}
              >
                <Target size={15} strokeWidth={1.5} aria-hidden />
              </IconButton>
            )}
            {chatMode || researchMode ? null : (
              <IconButton
                label={planMode ? '退出计划模式' : '进入计划模式：先探索并给出计划，批准后执行'}
                size={28}
                active={planMode}
                onClick={() => void setPlanMode(!planMode)}
              >
                <ClipboardList size={15} strokeWidth={1.5} aria-hidden />
              </IconButton>
            )}
            <IconButton label="侧边聊天（/btw）" size={28} onClick={() => openSideChat()}>
              <MessageSquare size={15} strokeWidth={1.5} aria-hidden />
            </IconButton>
            <ContextMeter />
          </div>

          <div className="composer-bar-right">
            {runningCurrent ? <span className="composer-elapsed mono">{formatElapsed(elapsed)}</span> : null}
            {reasoningAvailable ? (
              <div className="composer-picker composer-picker-reasoning" title="思考强度：越高越适合复杂任务，但更慢、更贵">
                <Select
                  ariaLabel="推理强度"
                  value={reasoningEffort}
                  options={REASONING_OPTIONS}
                  onChange={(next) => {
                    if (isReasoningEffort(next)) void setReasoningEffort(next)
                  }}
                />
              </div>
            ) : null}
            <div className="composer-picker composer-picker-model">
              <Select
                ariaLabel="选择模型"
                value={`${modelRef.providerId}:${modelRef.modelId}`}
                options={modelOptions}
                onChange={(next) => {
                  const [providerId, modelId] = next.split(':')
                  void setModel(modelId, providerId)
                }}
              />
            </div>
            {researchMode ? (
              <div
                className="composer-picker composer-picker-research"
                title={
                  researchLocked
                    ? '研究计划已生成或研究进行中，深度已锁定；请先完成/开始当前研究'
                    : `研究深度：${RESEARCH_DEPTHS[researchDepth].description}`
                }
              >
                <Select
                  ariaLabel="研究深度"
                  value={researchDepth}
                  options={(Object.keys(RESEARCH_DEPTHS) as ResearchDepth[]).map((depth) => ({
                    value: depth,
                    label: `研究·${RESEARCH_DEPTHS[depth].label}`,
                    description: RESEARCH_DEPTHS[depth].description,
                    disabled: researchLocked
                  }))}
                  onChange={(next) => setResearchDepth(next as ResearchDepth)}
                />
              </div>
            ) : null}
            <div className="composer-picker composer-picker-mode" title={MODE_DESCRIPTION[uiSessionMode]}>
              <Segmented
                ariaLabel={`对话模式：${MODE_DESCRIPTION[uiSessionMode]}`}
                value={uiSessionMode}
                options={SESSION_MODE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: item.label,
                  description: item.description
                }))}
                onChange={(next) => {
                  if (next === uiSessionMode) return
                  void setSessionMode(next)
                }}
              />
            </div>
            {chatMode ? (
              <span
                className="composer-perm-lock"
                title="聊天模式固定只读：不改文件、不跑命令。切到工作模式后可选择权限档位。"
                aria-label="聊天模式固定只读"
              >
                <Lock size={11} strokeWidth={1.6} aria-hidden />
                只读
              </span>
            ) : researchMode ? (
              <span
                className="composer-perm-lock is-research"
                title="深度研究只读资料与联网查证：不修改文件、不运行命令。"
                aria-label="深度研究只读并联网查证"
              >
                <Telescope size={11} strokeWidth={1.6} aria-hidden />
                只读 · 联网查证
              </span>
            ) : (
              <div className="composer-picker composer-picker-perm" title={`${permission.label}：${permission.description}`}>
                <Select
                  ariaLabel={`权限模式：${permission.label}。${permission.description}`}
                  value={permissionMode}
                  options={PERMISSION_OPTIONS.map((item) => ({
                    value: item.value,
                    label: item.label,
                    description: item.description
                  }))}
                  onChange={(next) => void setPermissionMode(next)}
                />
              </div>
            )}
            {runningCurrent ? (
              <>
                <button
                  type="button"
                  className={['composer-send is-interrupt', canSend ? 'is-ready' : ''].filter(Boolean).join(' ')}
                  aria-label={canSend ? '打断当前任务并立即发送' : '输入内容后可插话'}
                  title={
                    canSend
                      ? `插话发送：停止当前运行，立即发送这条消息${settings.runningSendMode === 'steer' ? '（当前 Enter 默认）' : ''}`
                      : '输入内容后可插话'
                  }
                  disabled={!canSend}
                  onClick={interruptCurrent}
                >
                  <Zap size={14} strokeWidth={1.8} aria-hidden />
                </button>
                <button
                  type="button"
                  className={['composer-send is-queue', canSend ? 'is-ready' : ''].filter(Boolean).join(' ')}
                  aria-label={canSend ? '加入队列，本轮结束后发送' : '输入内容后可加入队列'}
                  title={
                    canSend
                      ? `排队发送：本轮结束后自动发送${settings.runningSendMode === 'queue' ? '（当前 Enter 默认）' : ''}`
                      : '输入内容后可加入队列'
                  }
                  disabled={!canSend}
                  onClick={() => submit('queue')}
                >
                  <ArrowUp size={16} strokeWidth={2} aria-hidden />
                </button>
                <button
                  type="button"
                  className="composer-send is-stop"
                  aria-label="停止生成"
                  title={interrupting ? '正在打断…' : '停止生成 (Esc)'}
                  disabled={interrupting}
                  onClick={() => void stopRun()}
                >
                  <Square size={11} strokeWidth={2} fill="currentColor" aria-hidden />
                </button>
              </>
            ) : (
              <button
                type="button"
                className={['composer-send', canSend ? 'is-ready' : ''] .filter(Boolean).join(' ')}
                aria-label={goalActive ? '目标进行中，暂时不能发送' : '发送消息'}
                title={
                  goalActive
                    ? '目标进行中：在目标条暂停目标后即可发送'
                    : canSend
                      ? `发送 (${isEnterSend ? 'Enter' : 'Ctrl+Enter'})`
                      : '输入内容后发送'
                }
                disabled={!canSend}
                onClick={() => submit()}
              >
                <ArrowUp size={16} strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>
        </div>

        {dragging ? (
          <div className="composer-drop" aria-hidden>
            <Paperclip size={15} strokeWidth={1.5} />
            松开以添加 {dragCount > 0 ? `${dragCount} 个文件` : '文件'}
          </div>
        ) : null}
      </div>

    </div>
  )
}
