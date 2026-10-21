import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  FileText,
  Ghost,
  MessageSquare,
  Moon,
  PanelLeft,
  PlusCircle,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Sun
} from 'lucide-react'
import type { FileSearchResult, SessionMeta } from '@shared/types'
import { useAppStore } from '../../state/store'
import { dispatchOpenFile } from '../files/files-client'
import { relativeToWorkspace } from '../artifacts/editor/editor-api'
import { Kbd, Modal } from '../../ui'
import './CommandPalette.css'

type ItemGroup = 'action' | 'session' | 'file'

interface PaletteItem {
  id: string
  group: ItemGroup
  label: string
  description?: string
  icon: React.ReactNode
  shortcut?: string
  run: () => void
}

const GROUP_LABEL: Record<ItemGroup, string> = {
  action: '操作',
  session: '对话',
  file: '文件'
}

export function CommandPalette(): React.JSX.Element | null {
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const closePalette = useAppStore((s) => s.closePalette)
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const theme = useAppStore((s) => s.theme)
  const newSession = useAppStore((s) => s.newSession)
  const selectSession = useAppStore((s) => s.selectSession)
  const openSettings = useAppStore((s) => s.openSettings)
  const openSideChat = useAppStore((s) => s.openSideChat)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const startDemo = useAppStore((s) => s.startDemo)
  const setTheme = useAppStore((s) => s.setTheme)
  const searchFiles = useAppStore((s) => s.searchFiles)
  // 与 store.searchFiles / 编辑器保持一致：优先当前对话的文件夹
  const workspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace ?? null)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /* 打开时重置并聚焦 */
  useEffect(() => {
    if (!paletteOpen) return
    setQuery('')
    setActiveIndex(0)
    setFileResults([])
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [paletteOpen])

  /* 文件夹文件搜索（防抖） */
  useEffect(() => {
    if (!paletteOpen || !query.trim()) {
      setFileResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      void searchFiles(query).then((results) => {
        if (cancelled) return
        setFileResults(results)
        setSearching(false)
      })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [paletteOpen, query, searchFiles])

  const actions = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      {
        id: 'action:new',
        group: 'action',
        label: '新建对话',
        icon: <PlusCircle size={15} strokeWidth={1.5} />,
        shortcut: 'Ctrl N',
        run: () => void newSession()
      },
      {
        id: 'action:temp',
        group: 'action',
        label: '新建临时对话',
        description: '不保存、不进入历史与搜索，关闭应用后消失',
        icon: <Ghost size={15} strokeWidth={1.5} />,
        run: () => void newSession({ temporary: true })
      },
      {
        id: 'action:settings',
        group: 'action',
        label: '打开设置',
        description: '模型、外观、权限、功能与工具',
        icon: <SettingsIcon size={15} strokeWidth={1.5} />,
        shortcut: 'Ctrl ,',
        run: openSettings
      },
      {
        id: 'action:sidechat',
        group: 'action',
        label: '侧边聊天',
        description: '在右侧栏问一句，不影响主对话',
        icon: <MessageSquare size={15} strokeWidth={1.5} />,
        run: () => openSideChat()
      },
      {
        id: 'action:theme',
        group: 'action',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        description: theme === 'dark' ? '白天的米色界面' : '深夜的石墨黑界面',
        icon: theme === 'dark' ? <Sun size={15} strokeWidth={1.5} /> : <Moon size={15} strokeWidth={1.5} />,
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark')
      },
      {
        id: 'action:sidebar',
        group: 'action',
        label: '收起或展开侧栏',
        icon: <PanelLeft size={15} strokeWidth={1.5} />,
        shortcut: 'Ctrl B',
        run: toggleSidebar
      },
      {
        id: 'action:demo',
        group: 'action',
        label: '看一场演示',
        description: '离线跑完一个真实任务，约 40 秒',
        icon: <Sparkles size={15} strokeWidth={1.5} />,
        run: () => void startDemo()
      }
    ]
    const keyword = query.trim().toLowerCase()
    return keyword
      ? list.filter((item) => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(keyword))
      : list
  }, [newSession, openSettings, openSideChat, setTheme, theme, toggleSidebar, startDemo, query])

  const sessionItems = useMemo<PaletteItem[]>(() => {
    const keyword = query.trim().toLowerCase()
    const saved = sessions.filter((session) => !session.temporary)
    const matched: SessionMeta[] = keyword
      ? saved.filter(
          (session) =>
            session.title.toLowerCase().includes(keyword) ||
            (session.preview ?? '').toLowerCase().includes(keyword)
        )
      : saved
    return matched.slice(0, 8).map((session) => ({
      id: `session:${session.id}`,
      group: 'session' as const,
      label: session.title,
      description: session.preview ? session.preview.slice(0, 48) : undefined,
      icon: <MessageSquare size={15} strokeWidth={1.5} />,
      shortcut: session.id === activeSessionId ? '当前' : undefined,
      run: () => void selectSession(session.id)
    }))
  }, [sessions, query, activeSessionId, selectSession])

  const fileItems = useMemo<PaletteItem[]>(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return []
    return fileResults.slice(0, 6).map((file) => ({
      id: `file:${file.path}`,
      group: 'file' as const,
      label: file.name,
      description: file.dir ? `文件夹 / ${file.dir} · 打开编辑` : '文件夹根目录 · 打开编辑',
      icon: <FileText size={15} strokeWidth={1.5} />,
      run: () => {
        if (!workspace) {
          useAppStore.getState().notify('warning', '还没有选择文件夹，无法打开文件。')
          return
        }
        // files.search 返回绝对路径；编辑器需要「文件夹相对路径 + 绝对路径」
        dispatchOpenFile({
          path: relativeToWorkspace(workspace, file.path) ?? file.path,
          absolutePath: file.path
        })
      }
    }))
  }, [fileResults, query, workspace])

  const groups = useMemo(() => {
    const result: { group: ItemGroup; items: PaletteItem[] }[] = []
    if (actions.length) result.push({ group: 'action', items: actions })
    if (sessionItems.length) result.push({ group: 'session', items: sessionItems })
    if (fileItems.length) result.push({ group: 'file', items: fileItems })
    return result
  }, [actions, sessionItems, fileItems])

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  // 异步文件结果可能让列表变短：索引始终夹在有效范围内，避免「高亮消失但 Enter 仍有动作」
  const currentIndex = flat.length === 0 ? 0 : Math.min(activeIndex, flat.length - 1)
  const activeItem = flat[currentIndex] ?? null

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex])

  const runItem = (item: PaletteItem | null): void => {
    if (!item) return
    closePalette()
    window.setTimeout(() => item.run(), 0)
  }

  if (!paletteOpen) return null

  const showEmpty = flat.length === 0 && !searching

  return (
    <Modal
      open={paletteOpen}
      onClose={closePalette}
      width={620}
      layer="palette"
      ariaLabel="命令面板"
    >
      <div className="palette">
        <div className="palette-search">
          <Search size={16} strokeWidth={1.5} className="palette-search-icon" aria-hidden />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? `palette-item-${activeItem.id.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined}
            aria-label="搜索命令、对话或文件"
            placeholder="输入命令，或搜索对话与文件…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex(flat.length === 0 ? 0 : (currentIndex + 1) % flat.length)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex(flat.length === 0 ? 0 : (currentIndex - 1 + flat.length) % flat.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runItem(activeItem)
              } else if (event.key === 'Home' && !query) {
                event.preventDefault()
                setActiveIndex(0)
              } else if (event.key === 'End' && !query) {
                event.preventDefault()
                setActiveIndex(Math.max(0, flat.length - 1))
              }
            }}
          />
          {query ? (
            <button type="button" className="palette-clear" aria-label="清空搜索" onClick={() => setQuery('')}>
              <span aria-hidden>×</span>
            </button>
          ) : null}
          <span className="palette-esc" aria-hidden>
            <Kbd>Esc</Kbd>
          </span>
        </div>

        <div className="palette-list" id="palette-list" role="listbox" aria-label="搜索结果" ref={listRef}>
          {groups.map((group) => (
            <div key={group.group} className="palette-group" role="group" aria-label={GROUP_LABEL[group.group]}>
              <p className="palette-group-label mono">{GROUP_LABEL[group.group]}</p>
              {group.items.map((item) => {
                const index = flat.indexOf(item)
                const active = index === currentIndex
                return (
                  <button
                    key={item.id}
                    id={`palette-item-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={active}
                    data-index={index}
                    className={['palette-item', active ? 'is-active' : ''].filter(Boolean).join(' ')}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => runItem(item)}
                  >
                    <span className="palette-item-icon" aria-hidden>
                      {item.icon}
                    </span>
                    <span className="palette-item-main">
                      <span className="palette-item-label truncate">{item.label}</span>
                      {item.description ? (
                        <span className="palette-item-desc truncate">{item.description}</span>
                      ) : null}
                    </span>
                    {item.shortcut ? <span className="palette-item-shortcut mono">{item.shortcut}</span> : null}
                  </button>
                )
              })}
            </div>
          ))}

          {searching && flat.length === 0 ? <p className="palette-empty">正在搜索…</p> : null}
          {showEmpty ? (
            <div className="palette-empty">
              <p>没有找到匹配的内容。</p>
              <p className="palette-empty-hint">试试对话标题、文件名，或者「设置」「演示」这样的操作名。</p>
            </div>
          ) : null}
        </div>

        <div className="palette-foot">
          <span className="palette-foot-keys mono">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span className="palette-foot-workspace mono truncate">
            {workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : '未选择文件夹'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
