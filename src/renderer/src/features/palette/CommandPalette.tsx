import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  Brain,
  FileText,
  FolderKanban,
  Globe2,
  LayoutGrid,
  MessageSquare,
  Moon,
  PanelLeft,
  Plug,
  PlusCircle,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Sun
} from 'lucide-react'
import type { FileSearchResult, SessionMeta } from '@shared/types'
import { useAppStore } from '../../state/store'
import { openWorkbench, type WorkbenchPanel } from '../workbench/events'
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
  session: '会话',
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
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const startDemo = useAppStore((s) => s.startDemo)
  const setTheme = useAppStore((s) => s.setTheme)
  const searchFiles = useAppStore((s) => s.searchFiles)
  const workspace = useAppStore((s) => s.settings.lastWorkspace ?? s.session?.workspace ?? null)

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

  /* 工作区文件搜索（防抖） */
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
        id: 'action:settings',
        group: 'action',
        label: '打开设置',
        description: '模型连接、权限、外观与关于',
        icon: <SettingsIcon size={15} strokeWidth={1.5} />,
        shortcut: 'Ctrl ,',
        run: openSettings
      },
      ...([
        ['overview', '工作台', '文件、编辑器、记忆、项目与连接器', LayoutGrid],
        ['memory', '记忆中心', '查看、编辑和清理 Morrow 记住的事', Brain],
        ['projects', '项目', '项目指令、知识文件与长期背景', FolderKanban],
        ['connectors', '连接器', '管理 MCP 服务与外部工具', Plug],
        ['skills', '技能库', '发现、启用或安装工作流技能', Sparkles],
        ['search', '全局搜索', '搜索对话、文件与产物内容', Search],
        ['browser', '内置浏览器', '在同一工作台里打开网页', Globe2]
      ] as [WorkbenchPanel | 'overview', string, string, React.ComponentType<{ size?: number; strokeWidth?: number }>][]).map(([id, label, description, Icon]) => ({
        id: `action:workbench:${id}`,
        group: 'action' as const,
        label,
        description,
        icon: <Icon size={15} strokeWidth={1.5} />,
        run: () => (id === 'overview' ? openWorkbench() : openWorkbench(id))
      })),
      {
        id: 'action:theme',
        group: 'action',
        label: theme === 'dark' ? '切换到素纸主题' : '切换到墨夜主题',
        description: theme === 'dark' ? '白天的纸色工作台' : '深夜书房的安静底色',
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
    return keyword ? list.filter((item) => item.label.toLowerCase().includes(keyword)) : list
  }, [newSession, openSettings, setTheme, theme, toggleSidebar, startDemo, query])

  const sessionItems = useMemo<PaletteItem[]>(() => {
    const keyword = query.trim().toLowerCase()
    const matched: SessionMeta[] = keyword
      ? sessions.filter(
          (session) =>
            session.title.toLowerCase().includes(keyword) ||
            (session.preview ?? '').toLowerCase().includes(keyword)
        )
      : sessions
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
      description: file.dir ? `工作区 / ${file.dir}` : '工作区根目录',
      icon: <FileText size={15} strokeWidth={1.5} />,
      run: () => {
        void navigator.clipboard.writeText(file.path).catch(() => undefined)
        useAppStore.getState().notify('info', `已复制路径：${file.path}`)
      }
    }))
  }, [fileResults, query])

  const groups = useMemo(() => {
    const result: { group: ItemGroup; items: PaletteItem[] }[] = []
    if (actions.length) result.push({ group: 'action', items: actions })
    if (sessionItems.length) result.push({ group: 'session', items: sessionItems })
    if (fileItems.length) result.push({ group: 'file', items: fileItems })
    return result
  }, [actions, sessionItems, fileItems])

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const activeItem = flat[Math.min(activeIndex, Math.max(0, flat.length - 1))] ?? null

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

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
            aria-activedescendant={activeItem ? `palette-item-${activeItem.id.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined}
            aria-label="搜索命令、会话或文件"
            placeholder="输入命令，或搜索对话与文件…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((index) => (flat.length === 0 ? 0 : (index + 1) % flat.length))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((index) => (flat.length === 0 ? 0 : (index - 1 + flat.length) % flat.length))
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
                const active = index === activeIndex
                return (
                  <button
                    key={item.id}
                    id={`palette-item-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                    type="button"
                    role="option"
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
            {workspace ? (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace) : '未选择工作区'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
