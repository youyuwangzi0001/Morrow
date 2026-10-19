import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Eraser,
  File as FileIcon,
  FileImage,
  FileText,
  Lock,
  Minimize2,
  Paperclip,
  PlusCircle,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Target,
  X
} from 'lucide-react'
import { findModel } from '@shared/models'
import type { Attachment, FileSearchResult, PermissionMode, SessionMode } from '@shared/types'
import { useAppStore } from '../../state/store'
import { IconButton, Segmented, Select } from '../../ui'
import {
  contextSnapshot,
  contextSourceLabel,
  formatExactTokens,
  formatUsageTokens
} from '../settings/context-format'
import { requestSettingsTab } from '../settings/settings-tab'
import { GoalDialog } from '../goal/GoalDialog'
import './Composer.css'

const MAX_INPUT_HEIGHT = 220

/* ── 权限模式文案 ─────────────────────────────────────────────── */

const PERMISSION_OPTIONS: { value: PermissionMode; label: string; description: string }[] = [
  {
    value: 'read-only',
    label: '只读',
    description: '只能读文件；任何写入、删除、命令执行都先问你'
  },
  {
    value: 'ask',
    label: '询问',
    description: '读文件自动放行；写文件、跑命令前先问你'
  },
  {
    value: 'auto',
    label: '自动',
    description: '不再询问，写入与命令直接执行；只建议在你信任的任务里用'
  }
]

/* ── 会话模式（聊天 / 工作）文案 ──────────────────────────────── */

const SESSION_MODE_OPTIONS: { value: SessionMode; label: string; description: string }[] = [
  {
    value: 'chat',
    label: '聊天',
    description: '聊天模式：只讨论、只读分析；不改文件、不跑命令，固定只读'
  },
  {
    value: 'work',
    label: '工作',
    description: '工作模式：可以读写文件、执行命令与推进目标，受右侧权限档位约束'
  }
]

const CHAT_MODE_HINT = '聊天模式 · 只讨论，不执行'

const MODE_DESCRIPTION: Record<SessionMode, string> = {
  chat: '聊天模式：Morrow 只讨论和只读分析，不会改文件、跑命令；需要动手时切到工作模式。',
  work: '工作模式：Morrow 可以读写文件、执行命令、推进目标（按权限档位）。'
}

/* ── 斜杠命令（可执行子集） ───────────────────────────────────── */

interface CommandDef {
  name: string
  label: string
  description: string
  disabled?: boolean
  disabledReason?: string
  run?: () => void
}

/* ── 工具函数 ─────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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
  const command = /(?:^|\n)\/([a-z-]*)$/i.exec(before)
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
  if (file.type.startsWith('text/')) return true
  return /\.(md|txt|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|sh|ps1|log|env|sql|ini)$/i.test(
    file.name
  )
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
    return window.morrow.files.getPathForFile(file) || file.name
  } catch {
    return file.name
  }
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
  if (file.type.startsWith('image/')) {
    const dataUrl = file.size <= 3 * 1024 * 1024 ? await readFileAsDataUrl(file) : null
    return { ...base, kind: 'image', content: dataUrl }
  }
  if (isTextLike(file) && file.size <= 512 * 1024) {
    const raw = await file.text()
    const truncated = raw.length > 120_000
    return { ...base, kind: 'text', content: truncated ? raw.slice(0, 120_000) : raw, truncated }
  }
  return base
}

/* ── Composer ────────────────────────────────────────────────── */

export function Composer(): React.JSX.Element {
  const ready = useAppStore((s) => s.ready)
  const run = useAppStore((s) => s.run)
  const settings = useAppStore((s) => s.settings)
  const session = useAppStore((s) => s.session)
  const compacting = useAppStore((s) => s.compacting)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const stopRun = useAppStore((s) => s.stopRun)
  const attachFiles = useAppStore((s) => s.attachFiles)
  const searchFiles = useAppStore((s) => s.searchFiles)
  const setModel = useAppStore((s) => s.setModel)
  const setPermissionMode = useAppStore((s) => s.setPermissionMode)
  const setSessionMode = useAppStore((s) => s.setSessionMode)
  const newSession = useAppStore((s) => s.newSession)
  const openSettings = useAppStore((s) => s.openSettings)
  const startDemo = useAppStore((s) => s.startDemo)
  const compactSession = useAppStore((s) => s.compactSession)
  const notify = useAppStore((s) => s.notify)
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
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [dragCount, setDragCount] = useState(0)
  const [sweep, setSweep] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [goalDialogOpen, setGoalDialogOpen] = useState(false)

  const modelRef = session?.model ?? settings.defaultModel
  const modelInfo = findModel(settings.providers, modelRef)
  const context = contextSnapshot(session?.usage, modelInfo?.contextWindow)
  const permissionMode = session?.permissionMode ?? settings.permissionMode
  const permission = PERMISSION_OPTIONS.find((item) => item.value === permissionMode) ?? PERMISSION_OPTIONS[1]
  const sessionMode: SessionMode = session?.mode === 'chat' ? 'chat' : 'work'
  const chatMode = sessionMode === 'chat'
  const workspace = session?.workspace ?? settings.lastWorkspace
  const running = !!run
  const goalActive = goal?.status === 'active'
  const isEnterSend = settings.sendKey === 'enter'
  const canSend = ready && !running && !goalActive && text.trim().length > 0

  /* 目标入口：无目标→建立；进行中/已暂停→定位到目标条。聊天模式下 Goal 不可用（工作模式能力） */
  const openGoalEntry = useCallback((): void => {
    if ((useAppStore.getState().session?.mode ?? 'work') === 'chat') {
      notify('warning', '聊天模式下不能建立目标：先切到工作模式，再建立多轮目标。')
      return
    }
    const current = useAppStore.getState().session?.goal
    if (current && (current.status === 'active' || current.status === 'paused')) {
      document.querySelector('.goal-bar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      notify('info', '当前对话已有目标，可在上方目标条暂停、继续或结束。')
      return
    }
    setGoalDialogOpen(true)
  }, [notify])

  /* 斜杠命令表（闭包内可用 store actions） */
  const commands = useMemo<CommandDef[]>(() => {
    const compactBlockedReason = compacting
      ? '正在压缩，稍等一下。'
      : running
        ? '生成过程中不能压缩，先停下再试。'
        : !session
          ? '先发一条消息，有一个对话之后再压缩。'
          : null
    return [
      { name: 'new', label: '新建对话', description: '把当前对话收起来，开一个新会话', run: () => void newSession() },
      { name: 'demo', label: '看一场演示', description: '离线跑完一个真实任务，约 40 秒', run: () => void startDemo() },
      { name: 'settings', label: '打开设置', description: '模型连接、权限、外观与关于', run: openSettings },
      chatMode
        ? {
            name: 'goal',
            label: '建立目标（工作模式可用）',
            description: '聊天模式只讨论，不执行多轮目标；切到工作模式后再用',
            disabled: true,
            disabledReason: '聊天模式下不能建立目标：先把输入框旁的「聊天 / 工作」切到「工作」。',
            run: openGoalEntry
          }
        : { name: 'goal', label: '建立目标', description: '让 Morrow 多轮自动推进一个目标', run: openGoalEntry },
      { name: 'clear', label: '清空输入', description: '只清空输入框里的内容，不发出去', run: () => setText('') },
      {
        name: 'compact',
        label: '压缩上下文',
        description: compactBlockedReason ?? '把较早的对话压成摘要，腾出上下文空间',
        disabled: compactBlockedReason !== null,
        disabledReason: compactBlockedReason ?? undefined,
        run: () => void compactSession()
      }
    ]
  }, [newSession, startDemo, openSettings, openGoalEntry, compactSession, compacting, running, session, chatMode])

  /* 自动增高（到 220px 才出现内部滚动条） */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(MAX_INPUT_HEIGHT, Math.max(26, el.scrollHeight))
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden'
  }, [text])

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

  /* 就绪后自动聚焦（有覆盖层时不抢焦点） */
  useEffect(() => {
    if (!ready || onboardingOpen || settingsOpen || paletteOpen || running) return
    textareaRef.current?.focus()
  }, [ready, onboardingOpen, settingsOpen, paletteOpen])

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
      description: file.dir ? `工作区 / ${file.dir}` : '工作区根目录',
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

  const submit = (): void => {
    const value = text.trim()
    if (!value || !ready || running) return
    if (executeExactCommand(value)) return
    const outgoing = attachments
    setText('')
    setAttachments([])
    setPopup(null)
    setSweep(true)
    window.setTimeout(() => setSweep(false), 480)
    void sendMessage(value, outgoing.length ? outgoing : undefined)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const addDroppedFiles = async (files: File[]): Promise<void> => {
    const accepted = files.slice(0, 8)
    const built = await Promise.all(accepted.map((file) => attachmentFromFile(file)))
    setAttachments((previous) => {
      const merged = [...previous]
      for (const attachment of built) {
        if (!merged.some((item) => item.name === attachment.name && item.size === attachment.size)) {
          merged.push(attachment)
        }
      }
      return merged.slice(0, 8)
    })
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
      if (running) {
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

  const sendHint = isEnterSend ? 'Enter 发送 · Shift+Enter 换行' : 'Ctrl+Enter 发送 · Enter 换行'
  const hintText = compacting
    ? '正在压缩上下文…'
    : goalActive
      ? running
        ? `目标进行中 · 第 ${goal?.round ?? 1}/${goal?.maxRounds ?? 1} 轮推进中`
        : '目标进行中 · 在目标条暂停后可输入'
      : running
        ? '生成中 · Esc 停止'
        : chatMode
          ? text.trim()
            ? `${text.trim().length} 字 · ${CHAT_MODE_HINT}`
            : CHAT_MODE_HINT
          : text.trim()
            ? `${text.trim().length} 字 · ${isEnterSend ? 'Enter 发送' : 'Ctrl+Enter 发送'}`
            : sendHint
  const placeholder = goalActive
    ? '目标模式进行中。Morrow 会自动继续下一轮，暂停目标后可以自由输入。'
    : running
      ? 'Morrow 正在处理…你可以先想下一个问题。'
      : chatMode
        ? '聊天模式：只讨论与分析，不会改文件、不跑命令。需要动手时切到「工作」。'
        : '说清想要的结果，Morrow 会自己想办法完成。'

  const modelOptions = useMemo(
    () =>
      settings.providers
        .filter(
          (provider) =>
            provider.enabled &&
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
      <div
        className={[
          'composer-shell',
          dragging ? 'is-dragging' : '',
          running ? 'is-running' : '',
          chatMode ? 'is-chat' : ''
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

        {attachments.length > 0 ? (
          <div className="composer-files" aria-label="附件">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="composer-file">
                {attachment.kind === 'image' ? (
                  <FileImage size={12} strokeWidth={1.5} aria-hidden />
                ) : attachment.kind === 'text' ? (
                  <FileText size={12} strokeWidth={1.5} aria-hidden />
                ) : (
                  <FileIcon size={12} strokeWidth={1.5} aria-hidden />
                )}
                <span className="composer-file-name truncate">{attachment.name}</span>
                <span className="composer-file-size mono">{formatBytes(attachment.size)}</span>
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
            aria-label={popup.kind === 'command' ? '命令' : '引用工作区文件'}
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
                  ? '没有匹配的命令。可用：/new /demo /settings /clear'
                  : !workspace
                    ? '当前没有工作区。先在顶栏选择一个文件夹，再引用文件。'
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
            <IconButton label="添加文件" size={28} onClick={() => void attachFiles().then((files) => {
              if (files.length === 0) return
              setAttachments((previous) => {
                const merged = [...previous]
                for (const file of files) {
                  if (!merged.some((item) => item.path === file.path && item.size === file.size)) merged.push(file)
                }
                return merged.slice(0, 8)
              })
            })}>
              <Paperclip size={15} strokeWidth={1.5} aria-hidden />
            </IconButton>
            {chatMode ? null : (
              <IconButton
                label={goal ? '查看当前目标' : '建立目标（多轮自动推进）'}
                size={28}
                active={!!goal && (goal.status === 'active' || goal.status === 'paused')}
                onClick={openGoalEntry}
              >
                <Target size={15} strokeWidth={1.5} aria-hidden />
              </IconButton>
            )}
          </div>

          <div className="composer-bar-right">
            {running ? <span className="composer-elapsed mono">{formatElapsed(elapsed)}</span> : null}
            {settings.showTokenMeter && context.used > 0 ? (
              <button
                type="button"
                className="composer-ctx"
                title={`上下文 ${formatExactTokens(context.used)} / ${formatExactTokens(context.limit)} tokens · ${contextSourceLabel(context.source)}（点击打开「设置 → 上下文」）`}
                aria-label={`上下文 ${formatUsageTokens(context.used)} / ${formatUsageTokens(context.limit)}，打开上下文设置`}
                onClick={() => {
                  requestSettingsTab('context')
                  openSettings()
                }}
              >
                <span className="mono">
                  {formatUsageTokens(context.used)}/{formatUsageTokens(context.limit)}
                </span>
              </button>
            ) : null}
            <span className="composer-hint mono">{hintText}</span>
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
            <div className="composer-picker composer-picker-mode" title={MODE_DESCRIPTION[sessionMode]}>
              <Segmented
                ariaLabel={`会话模式：${chatMode ? '聊天（只讨论，不执行）' : '工作（可读写与执行）'}`}
                value={sessionMode}
                options={SESSION_MODE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: item.label,
                  description: item.description
                }))}
                onChange={(next) => void setSessionMode(next)}
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
            {running ? (
              <button
                type="button"
                className="composer-send is-stop"
                aria-label="停止生成"
                title="停止生成 (Esc)"
                onClick={() => void stopRun()}
              >
                <Square size={11} strokeWidth={2} fill="currentColor" aria-hidden />
              </button>
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
                onClick={submit}
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

      <GoalDialog
        open={goalDialogOpen}
        onClose={() => setGoalDialogOpen(false)}
        initialObjective={text}
        onStarted={() => setText('')}
      />
    </div>
  )
}
