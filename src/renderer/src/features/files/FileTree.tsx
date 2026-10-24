import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileIcon,
  FileAudio,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  Trash2
} from 'lucide-react'
import {
  isAudioFileName,
  isDocxFileName,
  isPdfFileName,
  isPreviewImageFileName,
  isVideoFileName
} from '@shared/file-types'
import { useAppStore } from '../../store'
import { Button, IconButton, Modal, TextInput } from '../../ui'
import {
  FileApiError,
  dispatchFileDeleted,
  dispatchFileRenamed,
  dispatchFilesChanged,
  dispatchOpenFile,
  filesApi,
  toAbsolutePath,
  type FileEntry
} from './files-client'
import { errorText } from '../../lib'
import './FileTree.css'

/* ── 工具 ─────────────────────────────────────────────────────── */

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'css', 'scss', 'less', 'html', 'htm', 'vue',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'xml', 'svg'
])
const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'log', 'pdf', 'docx', 'xlsx', 'pptx'])

function extOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

function fileIcon(name: string): React.ReactNode {
  const ext = extOf(name)
  if (isPreviewImageFileName(name)) return <FileImage size={13} strokeWidth={1.5} aria-hidden />
  if (isAudioFileName(name)) return <FileAudio size={13} strokeWidth={1.5} aria-hidden />
  if (isVideoFileName(name)) return <FileVideo size={13} strokeWidth={1.5} aria-hidden />
  if (isPdfFileName(name) || isDocxFileName(name)) return <FileText size={13} strokeWidth={1.5} aria-hidden />
  if (CODE_EXTS.has(ext)) return <FileCode2 size={13} strokeWidth={1.5} aria-hidden />
  if (DOC_EXTS.has(ext)) return <FileText size={13} strokeWidth={1.5} aria-hidden />
  return <FileIcon size={13} strokeWidth={1.5} aria-hidden />
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** 文件的所有祖先目录（'a/b/file' → ['a', 'a/b']；根目录不列出） */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/')
  const dirs: string[] = []
  for (let index = 1; index < parts.length; index += 1) dirs.push(parts.slice(0, index).join('/'))
  return dirs
}



function validName(name: string): string | null {
  const value = name.trim()
  if (!value) return '名字不能为空。'
  if (value === '.' || value === '..') return '这个名字不能用。'
  if (/[\\/]/.test(value)) return '名字里不能包含 / 或 \\。'
  if (/[<>:"|?*\u0000-\u001f]/.test(value)) return '名字里包含 Windows 不允许的字符。'
  if (/[. ]$/.test(value)) return '名字不能以空格或句点结尾。'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return '这是 Windows 保留名称，请换一个名字。'
  if (value.length > 120) return '名字太长了（最多 120 个字符）。'
  return null
}

interface FlatRow {
  entry: FileEntry
  depth: number
  /** 过滤模式下附带所在目录，便于辨认 */
  hint?: string
}

type DialogState =
  | { kind: 'create'; entryKind: 'file' | 'dir'; parent: string }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'delete'; entry: FileEntry; childCount: number }

interface ContextMenuState {
  x: number
  y: number
  entry: FileEntry
}

/* ── 文件树 ───────────────────────────────────────────────────── */

/** 路径属性安全编码：btoa 不能编码中文（会抛 InvalidCharacterError），改用 encodeURIComponent。 */
function pathKey(path: string): string {
  return encodeURIComponent(path)
}

export function FileTree(): React.JSX.Element {
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace ?? null)
  const permissionMode = useAppStore((s) => s.session?.permissionMode ?? s.settings.permissionMode)
  const notify = useAppStore((s) => s.notify)
  const pickWorkspace = useAppStore((s) => s.pickWorkspace)

  const readOnly = permissionMode === 'read-only'
  const [collapsed, setCollapsed] = useState(false)
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return window.localStorage.getItem('morrow.files.showHidden') === '1'
    } catch {
      return false
    }
  })
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({})
  const [limited, setLimited] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  const [activePath, setActivePath] = useState<string | null>(null)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [pendingReveal, setPendingReveal] = useState<string | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogInput, setDialogInput] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastFocusRefresh = useRef(0)
  const treeGeneration = useRef(0)

  /* 加载一个目录（dir 为文件夹相对路径，根目录是 ''） */
  const loadDir = useCallback(
    async (dir: string, force = false): Promise<boolean> => {
      if (!workspace) return false
      if (!force && entries[dir]) return true
      const generation = treeGeneration.current
      setLoading((previous) => new Set(previous).add(dir))
      try {
        const result = await filesApi.list(workspace, dir, showHidden)
        // 文件夹/隐藏文件切换后，旧文件夹的晚到响应必须丢弃
        if (generation !== treeGeneration.current) return false
        setEntries((previous) => ({ ...previous, [dir]: result.entries }))
        setLimited((previous) => ({ ...previous, [dir]: result.limited }))
        if (dir === '') setTreeError(null)
        return true
      } catch (err) {
        if (generation !== treeGeneration.current) return false
        const message = errorText(err)
        if (dir === '') setTreeError(message)
        else notify('error', message)
        return false
      } finally {
        if (generation === treeGeneration.current) {
          setLoading((previous) => {
            const next = new Set(previous)
            next.delete(dir)
            return next
          })
        }
      }
    },
    [workspace, showHidden, entries, notify]
  )

  /* 文件夹/隐藏文件变化时重建文件树 */
  useEffect(() => {
    treeGeneration.current += 1
    setEntries({})
    setLimited({})
    setExpanded(new Set())
    setLoading(new Set())
    setActivePath(null)
    setFocusedPath(null)
    setPendingReveal(null)
    setTreeError(null)
    if (workspace) void loadDir('', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, showHidden])

  /* 记住隐藏文件开关 */
  useEffect(() => {
    try {
      window.localStorage.setItem('morrow.files.showHidden', showHidden ? '1' : '0')
    } catch {
      // ignore
    }
  }, [showHidden])

  /* 监听编辑器打开文件事件 → 高亮并展开祖先目录，让高亮行真正可见 */
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ path?: string }>).detail
      if (!detail?.path) return
      setActivePath(detail.path)
      setPendingReveal(detail.path)
    }
    window.addEventListener('morrow:open-file', onOpen as EventListener)
    return () => window.removeEventListener('morrow:open-file', onOpen as EventListener)
  }, [])

  useEffect(() => {
    if (!pendingReveal || !workspace) return undefined
    let cancelled = false
    void (async () => {
      for (const dir of ancestorDirs(pendingReveal)) {
        if (entries[dir]) continue
        const loaded = await loadDir(dir)
        if (cancelled) return
        if (!loaded) {
          setPendingReveal(null)
          return
        }
      }
      if (cancelled) return
      setExpanded((previous) => {
        const next = new Set(previous)
        for (const dir of ancestorDirs(pendingReveal)) next.add(dir)
        return next
      })
      setPendingReveal(null)
      requestAnimationFrame(() => {
        bodyRef.current
          ?.querySelector<HTMLElement>(`[data-path-key="${pathKey(pendingReveal)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      })
    })()
    return () => {
      cancelled = true
    }
    // 仅在新的打开事件到来时执行；内部按当时的 entries 快照顺序加载缺失的祖先目录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal])

  /* 窗口重新获得焦点时静默刷新（外部改动后文件树不过期） */
  useEffect(() => {
    const onFocus = (): void => {
      if (!workspace || collapsed) return
      const now = Date.now()
      if (now - lastFocusRefresh.current < 1500) return
      lastFocusRefresh.current = now
      void loadDir('', true)
      for (const dir of expanded) void loadDir(dir, true)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [workspace, collapsed, expanded, loadDir])

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspace || refreshing) return
    setRefreshing(true)
    try {
      await loadDir('', true)
      for (const dir of expanded) await loadDir(dir, true)
    } finally {
      setRefreshing(false)
    }
  }, [workspace, refreshing, expanded, loadDir])

  /* 编辑器保存/另存为后刷新文件树，新增文件不需要等窗口失焦再出现 */
  useEffect(() => {
    const onChange = (): void => void refresh()
    window.addEventListener('morrow:files-changed', onChange)
    return () => window.removeEventListener('morrow:files-changed', onChange)
  }, [refresh])

  const toggleDir = (dir: string): void => {
    if (expanded.has(dir)) {
      setExpanded((previous) => {
        const next = new Set(previous)
        next.delete(dir)
        return next
      })
      return
    }
    setExpanded((previous) => new Set(previous).add(dir))
    if (!entries[dir]) void loadDir(dir)
  }

  const rows = useMemo<FlatRow[]>(() => {
    const keyword = filter.trim().toLowerCase()
    const result: FlatRow[] = []
    if (keyword) {
      for (const [dir, list] of Object.entries(entries)) {
        for (const entry of list) {
          if (entry.name.toLowerCase().includes(keyword)) {
            result.push({ entry, depth: 0, hint: dir ? `${dir}/` : '' })
          }
        }
      }
      return result.slice(0, 300)
    }
    const walk = (dir: string, depth: number): void => {
      const list = entries[dir] ?? []
      for (const entry of list) {
        result.push({ entry, depth })
        if (entry.kind === 'dir' && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return result
  }, [entries, expanded, filter])

  const rowPaths = useMemo(() => rows.map((row) => row.entry.path), [rows])
  const focusedIndex = focusedPath ? rowPaths.indexOf(focusedPath) : -1

  const focusRow = (path: string | null): void => {
    setFocusedPath(path)
    if (!path) return
    requestAnimationFrame(() => {
      bodyRef.current?.querySelector<HTMLElement>(`[data-path-key="${pathKey(path)}"]`)?.focus()
    })
  }

  /* 打开文件：派发 morrow:open-file 给编辑器；目录则展开/收起 */
  const openEntry = (entry: FileEntry): void => {
    setFocusedPath(entry.path)
    if (entry.kind === 'dir') {
      toggleDir(entry.path)
      return
    }
    if (entry.restricted) {
      notify('warning', '这个链接指向文件夹之外，已阻止打开。')
      return
    }
    setActivePath(entry.path)
    if (workspace) dispatchOpenFile({ path: entry.path, absolutePath: toAbsolutePath(workspace, entry.path) })
  }

  /* 右键菜单 */
  const openMenu = (event: React.MouseEvent, entry: FileEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setFocusedPath(entry.path)
    const width = 190
    const height = 250
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
      entry
    })
  }

  useEffect(() => {
    if (!menu) return
    const onDocumentDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', onDocumentDown)
    document.addEventListener('keydown', onKey)
    const timer = window.setTimeout(() => menuRef.current?.querySelector<HTMLElement>('button')?.focus(), 20)
    return () => {
      document.removeEventListener('mousedown', onDocumentDown)
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [menu])

  /* 对话框打开 */
  const beginCreate = (entryKind: 'file' | 'dir', parent: string): void => {
    if (readOnly) return
    setMenu(null)
    setDialog({ kind: 'create', entryKind, parent })
    setDialogInput('')
    setDialogError(null)
  }

  const beginRename = (entry: FileEntry): void => {
    if (readOnly) return
    setMenu(null)
    setDialog({ kind: 'rename', entry })
    setDialogInput(entry.name)
    setDialogError(null)
  }

  const beginDelete = async (entry: FileEntry): Promise<void> => {
    if (readOnly) return
    setMenu(null)
    let childCount = 0
    if (entry.kind === 'dir') {
      try {
        const inspected = await filesApi.inspect(entry.path, workspace)
        childCount = inspected.childCount ?? 0
      } catch {
        childCount = 0
      }
    }
    setDialog({ kind: 'delete', entry, childCount })
    setDialogError(null)
  }

  const closeDialog = (): void => {
    if (dialogBusy) return
    setDialog(null)
    setDialogError(null)
  }

  /** 删除/改名后清掉旧路径的缓存与展开状态，避免继续请求已不存在的目录 */
  const forgetPath = useCallback((path: string): void => {
    const under = (candidate: string): boolean => candidate === path || candidate.startsWith(`${path}/`)
    setEntries((previous) => {
      const next: Record<string, FileEntry[]> = {}
      for (const [dir, list] of Object.entries(previous)) {
        if (under(dir)) continue
        next[dir] = list.filter((entry) => !under(entry.path))
      }
      return next
    })
    setLimited((previous) => {
      const next: Record<string, boolean> = {}
      for (const [dir, value] of Object.entries(previous)) if (!under(dir)) next[dir] = value
      return next
    })
    setExpanded((previous) => new Set([...previous].filter((dir) => !under(dir))))
    setFocusedPath((current) => (current && under(current) ? null : current))
  }, [])

  const submitDialog = async (): Promise<void> => {
    if (!dialog || dialogBusy || !workspace) return
    setDialogBusy(true)
    setDialogError(null)
    try {
      if (dialog.kind === 'delete') {
        const removed = dialog.entry
        await filesApi.remove(removed.path, {
          recursive: removed.kind === 'dir' && dialog.childCount > 0,
          workspace
        })
        dispatchFileDeleted({ path: removed.path, isDir: removed.kind === 'dir' })
        notify('success', `已删除「${removed.name}」`)
        setActivePath((current) =>
          current && (current === removed.path || current.startsWith(`${removed.path}/`)) ? null : current
        )
        forgetPath(removed.path)
        setDialog(null)
        await loadDir(parentOf(removed.path), true)
      } else if (dialog.kind === 'rename') {
        const name = dialogInput.trim()
        const invalid = validName(name)
        if (invalid) {
          setDialogError(invalid)
          return
        }
        if (name === dialog.entry.name) {
          setDialog(null)
          return
        }
        const renamed = dialog.entry
        const target = joinPath(parentOf(renamed.path), name)
        const wasExpanded = renamed.kind === 'dir' && expanded.has(renamed.path)
        await filesApi.rename(renamed.path, target, workspace)
        dispatchFileRenamed({ from: renamed.path, to: target, isDir: renamed.kind === 'dir' })
        notify('success', `已重命名为「${name}」`)
        setActivePath((current) => {
          if (!current) return current
          if (current === renamed.path) return target
          if (current.startsWith(`${renamed.path}/`)) return `${target}${current.slice(renamed.path.length)}`
          return current
        })
        forgetPath(renamed.path)
        setDialog(null)
        await loadDir(parentOf(renamed.path), true)
        if (wasExpanded) {
          setExpanded((previous) => new Set(previous).add(target))
          await loadDir(target, true)
        }
      } else {
        const name = dialogInput.trim()
        const invalid = validName(name)
        if (invalid) {
          setDialogError(invalid)
          return
        }
        const target = joinPath(dialog.parent, name)
        await filesApi.create(target, dialog.entryKind, workspace)
        notify('success', dialog.entryKind === 'file' ? `已新建文件「${name}」` : `已新建文件夹「${name}」`)
        setDialog(null)
        await loadDir(dialog.parent, true)
        if (dialog.parent) setExpanded((previous) => new Set(previous).add(dialog.parent))
        if (dialog.entryKind === 'file' && dialog.parent === parentOf(activePath ?? '')) setActivePath(target)
      }
    } catch (err) {
      setDialogError(errorText(err))
    } finally {
      setDialogBusy(false)
    }
  }

  /* 键盘操作（tree 语义） */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return
    // 树容器本身有焦点但尚未选中任何行时：方向键先落到首/末行，破坏性操作不落到第一行
    if (focusedIndex < 0) {
      if (event.key === 'ArrowDown' || event.key === 'Home') {
        focusRow(rows[0].entry.path)
        event.preventDefault()
      } else if (event.key === 'ArrowUp' || event.key === 'End') {
        focusRow(rows[rows.length - 1].entry.path)
        event.preventDefault()
      }
      return
    }
    const current = focusedIndex
    const currentRow = rows[current]
    const move = (next: number): void => {
      const clamped = Math.max(0, Math.min(rows.length - 1, next))
      focusRow(rows[clamped].entry.path)
      event.preventDefault()
    }
    if (event.key === 'ArrowDown') {
      move(current + 1)
    } else if (event.key === 'ArrowUp') {
      move(current - 1)
    } else if (event.key === 'Home') {
      move(0)
    } else if (event.key === 'End') {
      move(rows.length - 1)
    } else if (event.key === 'ArrowRight') {
      if (!currentRow) return
      const entry = currentRow.entry
      if (entry.kind === 'dir') {
        if (!expanded.has(entry.path)) {
          toggleDir(entry.path)
          event.preventDefault()
        } else if (rows[current + 1] && rows[current + 1].depth > currentRow.depth) {
          move(current + 1)
        }
      }
    } else if (event.key === 'ArrowLeft') {
      if (!currentRow) return
      const entry = currentRow.entry
      if (entry.kind === 'dir' && expanded.has(entry.path)) {
        toggleDir(entry.path)
        event.preventDefault()
      } else {
        const parent = parentOf(entry.path)
        const parentIndex = rows.findIndex((row) => row.entry.path === parent)
        if (parent && parentIndex >= 0) move(parentIndex)
      }
    } else if (event.key === 'Enter') {
      if (currentRow) {
        openEntry(currentRow.entry)
        event.preventDefault()
      }
    } else if (event.key === 'F2') {
      if (currentRow && !readOnly) {
        beginRename(currentRow.entry)
        event.preventDefault()
      }
    } else if (event.key === 'Delete') {
      if (currentRow && !readOnly) {
        void beginDelete(currentRow.entry)
        event.preventDefault()
      }
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      if (currentRow && bodyRef.current) {
        const node = bodyRef.current.querySelector<HTMLElement>(`[data-path-key="${pathKey(currentRow.entry.path)}"]`)
        const rect = node?.getBoundingClientRect()
        if (rect) {
          setMenu({
            x: Math.min(rect.left + 24, window.innerWidth - 200),
            y: Math.min(rect.bottom, window.innerHeight - 260),
            entry: currentRow.entry
          })
        }
        event.preventDefault()
      }
    } else if (event.key === 'Escape' && menu) {
      setMenu(null)
      event.preventDefault()
    }
  }

  const startDrag = (event: React.DragEvent, entry: FileEntry): void => {
    if (entry.kind === 'dir') {
      event.preventDefault()
      return
    }
    // 原生拖拽：Composer 现有 dataTransfer.files 处理逻辑可直接接收附件
    event.preventDefault()
    void filesApi.startDrag(entry.path, workspace).catch((err) => notify('error', errorText(err)))
  }

  const copyAbsolutePath = async (entry: FileEntry): Promise<void> => {
    setMenu(null)
    if (!workspace) return
    try {
      await navigator.clipboard.writeText(toAbsolutePath(workspace, entry.path))
      notify('success', '已复制文件路径')
    } catch {
      notify('error', '复制失败，请检查剪贴板权限。')
    }
  }

  const revealEntry = async (entry: FileEntry): Promise<void> => {
    setMenu(null)
    try {
      await filesApi.reveal(entry.path, workspace)
    } catch (err) {
      notify('error', errorText(err))
    }
  }

  const workspaceName = workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : null
  const rootLimited = limited[''] === true

  return (
    <section className={['file-tree', collapsed ? 'is-collapsed' : ''].filter(Boolean).join(' ')} aria-label="文件夹文件树">
      <div className="ft-head">
        <button
          type="button"
          className="ft-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? '展开文件树' : '收起文件树'}
        >
          <Folder size={13} strokeWidth={1.5} aria-hidden />
          <span className="ft-title">文件</span>
          {workspaceName ? <span className="ft-workspace mono truncate">{workspaceName}</span> : null}
          <ChevronDown size={12} strokeWidth={1.5} className={['ft-caret', collapsed ? 'is-collapsed' : ''].filter(Boolean).join(' ')} aria-hidden />
        </button>
        <div className="ft-actions">
          <IconButton
            label="新建文件"
            size={22}
            disabled={readOnly || !workspace}
            onClick={() => beginCreate('file', '')}
          >
            <FilePlus2 size={13} strokeWidth={1.5} aria-hidden />
          </IconButton>
          <IconButton
            label="新建文件夹"
            size={22}
            disabled={readOnly || !workspace}
            onClick={() => beginCreate('dir', '')}
          >
            <FolderPlus size={13} strokeWidth={1.5} aria-hidden />
          </IconButton>
          <IconButton
            label={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
            size={22}
            active={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? <Eye size={13} strokeWidth={1.5} aria-hidden /> : <EyeOff size={13} strokeWidth={1.5} aria-hidden />}
          </IconButton>
          <IconButton
            label={filterOpen ? '隐藏过滤框' : '显示过滤框'}
            size={22}
            active={filterOpen}
            onClick={() => setFilterOpen((value) => !value)}
          >
            <Search size={13} strokeWidth={1.5} aria-hidden />
          </IconButton>
          <IconButton label="刷新文件树" size={22} onClick={() => void refresh()} disabled={!workspace}>
            <RefreshCw size={13} strokeWidth={1.5} className={refreshing ? 'ft-spin' : undefined} aria-hidden />
          </IconButton>
        </div>
      </div>

      {collapsed ? null : (
        <>
          {filterOpen ? (
            <div className="ft-filter">
              <Search size={12} strokeWidth={1.5} aria-hidden />
              <input
                className="ft-filter-input"
                value={filter}
                placeholder="过滤已加载的文件…"
                aria-label="过滤文件"
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter ? (
                <button type="button" className="ft-filter-clear" onClick={() => setFilter('')} aria-label="清空过滤">
                  ×
                </button>
              ) : null}
            </div>
          ) : null}

          {!workspace ? (
            <div className="ft-empty">
              <p>还没有文件夹。</p>
              <p className="ft-empty-hint">选一个文件夹后，这里会显示它的文件树。</p>
              <Button size="sm" variant="secondary" onClick={() => void pickWorkspace()}>
                选择文件夹
              </Button>
            </div>
          ) : readOnly ? (
            <div className="ft-readonly" role="status">
              <Lock size={11} strokeWidth={1.5} aria-hidden />
              只读模式 · 不能新建、重命名或删除文件
            </div>
          ) : null}

          <div
            className="ft-body"
            role="tree"
            aria-label="文件夹文件"
            tabIndex={0}
            ref={bodyRef}
            onKeyDown={handleKeyDown}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocusedPath(null)
            }}
          >
            {treeError ? (
              <div className="ft-error" role="alert">
                <AlertTriangle size={12} strokeWidth={1.5} aria-hidden />
                <span>{treeError}</span>
                <button type="button" className="ft-retry" onClick={() => void loadDir('', true)}>
                  重试
                </button>
              </div>
            ) : null}

            {loading.has('') && !entries[''] ? <p className="ft-loading">正在读取文件…</p> : null}

            {entries[''] && entries[''].length === 0 && !treeError ? (
              <div className="ft-empty ft-empty-inline">
                <p>这个文件夹是空的。</p>
                {!readOnly ? (
                  <button type="button" className="ft-link" onClick={() => beginCreate('file', '')}>
                    新建一个文件
                  </button>
                ) : null}
              </div>
            ) : null}

            {rows.map(({ entry, depth, hint }) => {
              const isDir = entry.kind === 'dir'
              const isExpanded = isDir && expanded.has(entry.path)
              const isActive = activePath === entry.path
              const isFocused = focusedPath === entry.path
              const base64 = pathKey(entry.path)
              return (
                <div
                  key={entry.path}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={isDir ? isExpanded : undefined}
                  aria-selected={isActive}
                  tabIndex={isFocused ? 0 : -1}
                  data-path-key={base64}
                  draggable={!isDir}
                  className={[
                    'ft-row',
                    isDir ? 'is-dir' : 'is-file',
                    isActive ? 'is-active' : '',
                    entry.restricted ? 'is-restricted' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ paddingLeft: 5 + depth * 12 }}
                  title={entry.path}
                  onClick={() => openEntry(entry)}
                  onContextMenu={(event) => openMenu(event, entry)}
                  onDragStart={(event) => startDrag(event, entry)}
                  onFocus={() => setFocusedPath(entry.path)}
                >
                  <span className="ft-chevron" aria-hidden>
                    {isDir ? (
                      isExpanded ? (
                        <ChevronDown size={11} strokeWidth={1.8} />
                      ) : (
                        <ChevronRight size={11} strokeWidth={1.8} />
                      )
                    ) : null}
                  </span>
                  <span className={['ft-icon', isDir ? 'is-dir' : ''].filter(Boolean).join(' ')} aria-hidden>
                    {isDir ? isExpanded ? <FolderOpen size={13} strokeWidth={1.5} /> : <Folder size={13} strokeWidth={1.5} /> : fileIcon(entry.name)}
                  </span>
                  <span className="ft-name truncate">{entry.name}</span>
                  {hint ? <span className="ft-hint mono truncate">{hint}</span> : null}
                  {entry.isSymlink ? <Link2 size={10} strokeWidth={1.5} className="ft-badge" aria-label="符号链接" /> : null}
                  {entry.restricted ? (
                    <AlertTriangle size={10} strokeWidth={1.5} className="ft-badge is-warn" aria-label="指向文件夹外，已限制" />
                  ) : null}
                  {isDir && limited[entry.path] ? (
                    <span className="ft-limit-badge mono" title="文件过多，只显示前 2000 项">2000+</span>
                  ) : null}
                  {isDir && entries[entry.path]?.length ? (
                    <span className="ft-count mono" aria-hidden>
                      {entries[entry.path].length}
                    </span>
                  ) : null}
                </div>
              )
            })}

            {rows.some((row) => row.entry.kind === 'dir' && expanded.has(row.entry.path) && loading.has(row.entry.path)) ? (
              <p className="ft-loading is-inline">读取中…</p>
            ) : null}
            {rootLimited ? <p className="ft-limited mono">文件过多，只显示前 2000 项</p> : null}
            {filter.trim() && rows.length === 0 && Object.keys(entries).length > 0 ? (
              <p className="ft-empty-hint ft-filter-empty">没有匹配「{filter.trim()}」的文件（只过滤已加载的目录）。</p>
            ) : null}
          </div>
        </>
      )}

      {/* 右键菜单 */}
      {menu
        ? createPortal(
            <div
              ref={menuRef}
              className="ft-menu"
              role="menu"
              aria-label="文件操作"
              style={{ top: menu.y, left: menu.x }}
            >
              {menu.entry.kind === 'dir' && !readOnly ? (
                <>
                  <button type="button" role="menuitem" className="ft-menu-item" onClick={() => beginCreate('file', menu.entry.path)}>
                    <FilePlus2 size={13} strokeWidth={1.5} aria-hidden /> 新建文件
                  </button>
                  <button type="button" role="menuitem" className="ft-menu-item" onClick={() => beginCreate('dir', menu.entry.path)}>
                    <FolderPlus size={13} strokeWidth={1.5} aria-hidden /> 新建文件夹
                  </button>
                  <div className="ft-menu-sep" role="separator" />
                </>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="ft-menu-item"
                onClick={() => {
                  setMenu(null)
                  openEntry(menu.entry)
                }}
              >
                <ExternalLink size={13} strokeWidth={1.5} aria-hidden /> {menu.entry.kind === 'dir' ? '展开/收起' : '打开'}
              </button>
              <button type="button" role="menuitem" className="ft-menu-item" onClick={() => void copyAbsolutePath(menu.entry)}>
                <Copy size={13} strokeWidth={1.5} aria-hidden /> 复制路径
              </button>
              <button type="button" role="menuitem" className="ft-menu-item" onClick={() => void revealEntry(menu.entry)}>
                <FolderOpen size={13} strokeWidth={1.5} aria-hidden /> 在资源管理器中显示
              </button>
              <div className="ft-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="ft-menu-item"
                disabled={readOnly}
                onClick={() => beginRename(menu.entry)}
              >
                <Pencil size={13} strokeWidth={1.5} aria-hidden /> 重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className="ft-menu-item is-danger"
                disabled={readOnly}
                onClick={() => void beginDelete(menu.entry)}
              >
                <Trash2 size={13} strokeWidth={1.5} aria-hidden /> 删除
              </button>
            </div>,
            document.body
          )
        : null}

      {/* 新建 / 重命名 / 删除确认 */}
      <Modal
        open={dialog !== null}
        onClose={closeDialog}
        title={
          dialog?.kind === 'delete'
            ? dialog.entry.kind === 'dir'
              ? '删除文件夹？'
              : '删除文件？'
            : dialog?.kind === 'rename'
              ? '重命名'
              : dialog?.entryKind === 'dir'
                ? '新建文件夹'
                : '新建文件'
        }
        width={430}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              取消
            </Button>
            <Button
              variant={dialog?.kind === 'delete' ? 'danger' : 'gold'}
              loading={dialogBusy}
              onClick={() => void submitDialog()}
            >
              {dialog?.kind === 'delete' ? '删除' : dialog?.kind === 'rename' ? '重命名' : '创建'}
            </Button>
          </>
        }
      >
        {dialog?.kind === 'delete' ? (
          <div className="ft-confirm">
            <p className="ft-confirm-text">
              「{dialog.entry.name}」{dialog.entry.kind === 'dir' ? '和它的全部内容' : ''}会被永久删除，无法恢复。
            </p>
            {dialog.entry.kind === 'dir' && dialog.childCount > 0 ? (
              <p className="ft-confirm-detail mono">这个文件夹里还有 {dialog.childCount} 项内容。</p>
            ) : null}
            <p className="ft-confirm-hint">文件夹之外的其它文件不受影响。</p>
          </div>
        ) : (
          <div className="ft-dialog-form">
            <TextInput
              label={dialog?.kind === 'rename' ? '新名字' : '名字'}
              value={dialogInput}
              autoFocus
              maxLength={120}
              placeholder={dialog?.kind === 'create' && dialog.entryKind === 'dir' ? '例如 参考资料' : '例如 说明.md'}
              onChange={(event) => {
                setDialogInput(event.target.value)
                if (dialogError) setDialogError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitDialog()
                }
              }}
            />
            {dialog?.kind === 'create' && dialog.parent ? (
              <p className="ft-dialog-location mono">创建在：{dialog.parent}/</p>
            ) : null}
            {readOnly ? <p className="ft-dialog-error">当前是只读模式，不能修改文件。</p> : null}
            {dialogError ? (
              <p className="ft-dialog-error" role="alert">
                {dialogError}
              </p>
            ) : null}
          </div>
        )}
      </Modal>
    </section>
  )
}
