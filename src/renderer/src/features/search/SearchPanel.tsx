// R10-I 全局搜索面板（受控组件，Lead 挂载到命令面板/App）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { FileText, Loader2, MessageSquare, Palette, Search, X } from 'lucide-react'
import { hasOpenModal } from '../../ui'
import './SearchPanel.css'

export type SearchHitKind = 'session' | 'file' | 'artifact'

export interface SearchHighlight {
  start: number
  end: number
}

export interface SearchHit {
  kind: SearchHitKind
  id: string
  title: string
  snippet: string
  highlights: SearchHighlight[]
  score: number
  sessionId?: string
  messageId?: string
  role?: string
  path?: string
  absolutePath?: string
  line?: number
  artifactId?: string
  artifactKind?: string
  updatedAt?: number
}

export interface SearchResponse {
  query: string
  groups: { sessions: SearchHit[]; files: SearchHit[]; artifacts: SearchHit[] }
  total: number
  tookMs: number
  index: {
    ready: boolean
    building: boolean
    sessions: number
    files: number
    artifacts: number
    workspaces: string[]
    lastBuiltAt?: number
  }
}

export interface SearchPanelProps {
  open: boolean
  onClose: () => void
  onNavigate: (hit: SearchHit) => void
  /** 当前文件夹；不传则由主进程使用最近文件夹（文件结果按文件夹隔离） */
  workspace?: string | null
  initialQuery?: string
}

const EMPTY_RESULT: SearchResponse = {
  query: '',
  groups: { sessions: [], files: [], artifacts: [] },
  total: 0,
  tookMs: 0,
  index: { ready: false, building: false, sessions: 0, files: 0, artifacts: 0, workspaces: [] }
}
const SEARCH_LIMIT = 20

function flatten(groups: SearchResponse['groups']): SearchHit[] {
  return [...groups.sessions, ...groups.files, ...groups.artifacts]
}

function Highlighted({ hit }: { hit: SearchHit }): JSX.Element {
  const parts: Array<{ text: string; hit: boolean }> = []
  let cursor = 0
  for (const range of hit.highlights ?? []) {
    if (range.start < cursor || range.end <= range.start) continue
    if (range.start > cursor) parts.push({ text: hit.snippet.slice(cursor, range.start), hit: false })
    parts.push({ text: hit.snippet.slice(range.start, range.end), hit: true })
    cursor = range.end
  }
  if (cursor < hit.snippet.length) parts.push({ text: hit.snippet.slice(cursor), hit: false })
  return (
    <span className="search-snippet">
      {parts.map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </span>
  )
}

function KindIcon({ kind }: { kind: SearchHitKind }): JSX.Element {
  if (kind === 'file') return <FileText size={14} aria-hidden />
  if (kind === 'artifact') return <Palette size={14} aria-hidden />
  return <MessageSquare size={14} aria-hidden />
}

function groupTitle(kind: SearchHitKind): string {
  if (kind === 'file') return '文件'
  if (kind === 'artifact') return '成品'
  return '对话'
}

export default function SearchPanel({
  open,
  onClose,
  onNavigate,
  workspace = null,
  initialQuery = ''
}: SearchPanelProps): JSX.Element | null {
  const [query, setQuery] = useState(initialQuery)
  const [scope, setScope] = useState<'all' | 'workspace'>('all')
  const [result, setResult] = useState<SearchResponse>(EMPTY_RESULT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestSeq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const hits = useMemo(() => flatten(result.groups), [result])

  const search = useCallback(
    async (value: string) => {
      const seq = ++requestSeq.current
      const trimmed = value.trim()
      if (!trimmed) {
        setResult(EMPTY_RESULT)
        setLoading(false)
        setError(null)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const response = await window.morrow.features.invoke<SearchResponse>('feature:search:query', {
          q: trimmed,
          ...(scope === 'workspace' && workspace ? { workspace } : {}),
          limit: SEARCH_LIMIT
        })
        if (seq !== requestSeq.current) return
        if (!response.ok) {
          setError(response.error.message)
          setResult(EMPTY_RESULT)
        } else {
          setResult(response.data)
          setActiveIndex(0)
        }
      } catch (err) {
        if (seq !== requestSeq.current) return
        setError(err instanceof Error ? err.message : '搜索失败')
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [workspace, scope]
  )

  useEffect(() => {
    if (!workspace && scope === 'workspace') setScope('all')
  }, [workspace, scope])

  // 打开时聚焦；关闭时取消未完成请求
  useEffect(() => {
    if (!open) {
      requestSeq.current += 1
      return
    }
    setActiveIndex(0)
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open])

  // 防抖查询
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => void search(query), 160)
    return () => clearTimeout(timer)
  }, [open, query, search])

  // 结果变化后保证 activeIndex 合法
  useEffect(() => {
    setActiveIndex((index) => (hits.length === 0 ? 0 : Math.min(index, hits.length - 1)))
  }, [hits.length])

  // 键盘导航（面板打开时接管方向键/Enter/Escape）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      // 更上层弹窗打开时，键盘归弹窗处理，面板不抢 Esc/方向键
      if (hasOpenModal()) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (hits.length === 0) return
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((index) => (index + delta + hits.length) % hits.length)
        return
      }
      if (event.key === 'Enter' && hits.length > 0) {
        event.preventDefault()
        const hit = hits[activeIndex]
        if (hit) onNavigate(hit)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, hits, activeIndex, onClose, onNavigate])

  // 选中项滚入视野
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-hit-index="${activeIndex}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const renderGroup = (kind: SearchHitKind, items: SearchHit[]): JSX.Element | null => {
    if (items.length === 0) return null
    const baseIndex = kind === 'session' ? 0 : kind === 'file' ? result.groups.sessions.length : result.groups.sessions.length + result.groups.files.length
    return (
      <section className="search-group" aria-label={groupTitle(kind)} key={kind}>
        <h3 className="search-group-title">
          <KindIcon kind={kind} />
          <span>{groupTitle(kind)}</span>
          <span className="search-group-count">{items.length}</span>
        </h3>
        <div className="search-group-items">
          {items.map((hit, index) => {
            const flatIndex = baseIndex + index
            return (
              <button
                key={`${hit.kind}:${hit.id}`}
                type="button"
                data-hit-index={flatIndex}
                className={`search-hit ${flatIndex === activeIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(flatIndex)}
                onClick={() => onNavigate(hit)}
              >
                <div className="search-hit-head">
                  <span className="search-hit-title">{hit.title}</span>
                  {hit.path ? <span className="search-hit-path">{hit.line ? `${hit.path}:${hit.line}` : hit.path}</span> : null}
                </div>
                {hit.snippet ? (
                  <div className="search-hit-snippet">
                    <Highlighted hit={hit} />
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <div className="search-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="全局搜索">
        <div className="search-input-row">
          <Search size={16} className="search-input-icon" aria-hidden />
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            placeholder="搜索对话、文件和成品…"
            aria-label="全局搜索"
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {loading ? <Loader2 size={15} className="search-spinner" aria-label="搜索中" /> : null}
          <button type="button" className="search-close" onClick={onClose} title="关闭（Esc）" aria-label="关闭搜索">
            <X size={15} aria-hidden />
          </button>
        </div>

        <div className="search-scope-row" role="group" aria-label="搜索范围">
          <button
            type="button"
            className={['search-scope-btn', scope === 'all' ? 'is-active' : ''].filter(Boolean).join(' ')}
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            全部
          </button>
          <button
            type="button"
            className={['search-scope-btn', scope === 'workspace' ? 'is-active' : ''].filter(Boolean).join(' ')}
            aria-pressed={scope === 'workspace'}
            disabled={!workspace}
            title={workspace ? '只搜索当前对话的文件夹' : '先选择一个文件夹'}
            onClick={() => setScope('workspace')}
          >
            当前文件夹
          </button>
        </div>

        <div className="search-body" ref={listRef}>
          {!query.trim() ? (
            <div className="search-empty">
              <p className="search-empty-title">{scope === 'workspace' ? '搜索当前文件夹' : '搜索整个 Morrow'}</p>
              <p className="search-empty-hint">
                {scope === 'workspace'
                  ? '输入关键词，搜索这个文件夹里的文件和成品。'
                  : '输入关键词，搜索所有对话、文件和成品。'}
              </p>
            </div>
          ) : error ? (
            <div className="search-empty search-error">
              <p className="search-empty-title">搜索失败</p>
              <p className="search-empty-hint">{error}</p>
            </div>
          ) : !loading && result.total === 0 ? (
            <div className="search-empty">
              <p className="search-empty-title">没有找到「{query.trim()}」</p>
              <p className="search-empty-hint">试试更短的关键词，或换一个说法。</p>
            </div>
          ) : (
            <>
              {renderGroup('session', result.groups.sessions)}
              {renderGroup('file', result.groups.files)}
              {renderGroup('artifact', result.groups.artifacts)}
            </>
          )}
        </div>

        <div className="search-footer">
          <span className="search-hints">
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 关闭
          </span>
          <span className="search-meta">
            {result.index.building
              ? '正在更新本地索引…'
              : result.query
                ? `显示 ${result.total} 条结果${result.total >= SEARCH_LIMIT ? `（最多 ${SEARCH_LIMIT} 条）` : ''} · 本地搜索`
                : '本地搜索 · 不联网'}
          </span>
        </div>
      </div>
    </div>
  )
}

export { SearchPanel }
