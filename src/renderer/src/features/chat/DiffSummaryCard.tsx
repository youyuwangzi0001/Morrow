import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, File as FileIcon, FileDiff } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useAppStore } from '../../state/store'
import { DiffView } from '../../components/DiffView'
import { extractDiff } from '../activity/tool-meta'

interface DiffDetail {
  patch?: string
  before?: string
  after?: string
  added: number
  removed: number
}

interface DiffEntry {
  key: string
  path: string
  added: number
  removed: number
  details: DiffDetail[]
}

interface DiffData {
  added: number
  removed: number
  files: string[]
  entries: DiffEntry[]
}

export interface DiffSummarySource {
  message: ChatMessage
  suppressed?: ReadonlySet<string> | null
}

/** 从一个或一组消息里汇总本轮文件改动；同一文件多次修改时保留每一次的可展示差异。 */
function collectDiffData(sources: DiffSummarySource[]): DiffData {
  const perFile = new Map<string, { display: string; added: number; removed: number }>()
  const entries = new Map<string, DiffEntry>()
  let anonymousAdded = 0
  let anonymousRemoved = 0
  let anonymousSeq = 0
  const addSummary = (key: string, display: string, plus: number, minus: number): void => {
    if (!key) {
      anonymousAdded += plus
      anonymousRemoved += minus
      return
    }
    const entry = perFile.get(key) ?? { display, added: 0, removed: 0 }
    entry.added += plus
    entry.removed += minus
    if (!entry.display && display) entry.display = display
    perFile.set(key, entry)
  }

  for (const { message, suppressed } of sources) {
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !block.result) continue
      const meta = block.result.meta as Record<string, unknown> | undefined
      const changed = Array.isArray(meta?.changedFiles) ? meta.changedFiles : null
      if (changed) {
        let counted = false
        for (const raw of changed) {
          if (!raw || typeof raw !== 'object') continue
          const file = raw as Record<string, unknown>
          const plus = typeof file.diffAdded === 'number' ? file.diffAdded : 0
          const minus = typeof file.diffRemoved === 'number' ? file.diffRemoved : 0
          if (plus > 0 || minus > 0) counted = true
          const key = typeof file.absolutePath === 'string' ? file.absolutePath : ''
          if (key && suppressed?.has(key)) continue
          addSummary(key, key, plus, minus)
          if (key && (plus > 0 || minus > 0) && !entries.has(key)) {
            entries.set(key, { key, path: key, added: plus, removed: minus, details: [] })
          }
        }
        if (counted) continue
      }
      const diff = extractDiff(block.result, block)
      if (!diff) continue
      const plus = diff.added ?? 0
      const minus = diff.removed ?? 0
      if (plus === 0 && minus === 0) continue
      const key =
        typeof meta?.absolutePath === 'string'
          ? meta.absolutePath
          : typeof block.input?.path === 'string'
            ? block.input.path
            : typeof block.input?.file_path === 'string'
              ? block.input.file_path
              : ''
      if (key && suppressed?.has(key)) continue
      const display =
        diff.filePath || (typeof meta?.path === 'string' ? meta.path : '') || key
      addSummary(key, display, plus, minus)
      const entryKey = key || `__anonymous_${anonymousSeq++}`
      const entry = entries.get(entryKey) ?? {
        key: entryKey,
        path: display || entryKey,
        added: 0,
        removed: 0,
        details: []
      }
      if (!entry.path || entry.path === entryKey) entry.path = display || entryKey
      entry.added += plus
      entry.removed += minus
      entry.details.push({
        added: plus,
        removed: minus,
        ...(diff.patch ? { patch: diff.patch } : {}),
        ...(diff.before !== undefined ? { before: diff.before } : {}),
        ...(diff.after !== undefined ? { after: diff.after } : {})
      })
      entries.set(entryKey, entry)
    }
  }

  let added = anonymousAdded
  let removed = anonymousRemoved
  const files = new Set<string>()
  for (const [key, entry] of perFile) {
    added += entry.added
    removed += entry.removed
    if (entry.display) files.add(entry.display)
    const detail = entries.get(key)
    if (detail) {
      // 同一文件多次改动时，文件行与卡片总计都使用整轮累计值。
      detail.added = entry.added
      detail.removed = entry.removed
    } else if (entry.added > 0 || entry.removed > 0) {
      // 没有逐行 patch 的子任务汇总也保留在详情里，避免只看到数字。
      entries.set(key, {
        key,
        path: entry.display || key,
        added: entry.added,
        removed: entry.removed,
        details: []
      })
    }
  }
  return { added, removed, files: [...files], entries: [...entries.values()] }
}

/**
 * 本轮改动卡：整轮只保留这一张。结束前只显示统计；结束后展开先看改动文件，
 * 再点开单个文件查看逐行差异，避免一次性渲染全部 diff。
 */
export function DiffSummaryCard({
  sources,
  className
}: {
  sources: DiffSummarySource[]
  className?: string
}): React.JSX.Element | null {
  const run = useAppStore((state) =>
    state.run && state.session && state.run.sessionId === state.session.id ? state.run : null
  )
  const data = useMemo(() => collectDiffData(sources), [sources])
  const [open, setOpen] = useState(false)
  const [openFiles, setOpenFiles] = useState<ReadonlySet<string>>(() => new Set())
  const latestAt = useMemo(
    () => sources.reduce((latest, source) => Math.max(latest, source.message.createdAt), 0),
    [sources]
  )
  const isCurrentRun = Boolean(run && latestAt >= run.startedAt)
  const canExpand = !isCurrentRun && data.entries.length > 0

  useEffect(() => {
    if (isCurrentRun) {
      setOpen(false)
      setOpenFiles(new Set())
    }
  }, [isCurrentRun])

  useEffect(() => {
    if (!open) setOpenFiles(new Set())
  }, [open])

  if (data.added + data.removed <= 0) return null

  const fileCount = data.entries.length
  const label = `本轮改动 ${fileCount} 个文件，增加 ${data.added} 行，减少 ${data.removed} 行`
  const summaryClass = ['message-diff-summary', className].filter(Boolean).join(' ')
  const toggleFile = (key: string): void => {
    setOpenFiles((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const content = (
    <>
      <FileDiff size={12} strokeWidth={1.5} aria-hidden />
      <span className="message-diff-label">
        本轮改动{fileCount > 0 ? ` ${fileCount} 个文件` : ''}
      </span>
      <span className="message-diff-add mono">+{data.added}</span>
      <span className="message-diff-del mono">−{data.removed}</span>
      {!open && data.files.length > 0 ? (
        <span className="message-diff-paths truncate" title={data.files.join('\n')}>
          {data.files.slice(0, 3).join(' · ')}
          {data.files.length > 3 ? ` 等 ${data.files.length} 个` : ''}
        </span>
      ) : null}
    </>
  )

  if (!canExpand) {
    return (
      <div className={summaryClass} role="note" aria-label={label}>
        {content}
      </div>
    )
  }

  return (
    <div className={['message-diff-card', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className={[summaryClass, 'is-expandable', open ? 'is-open' : ''].filter(Boolean).join(' ')}
        aria-expanded={open}
        aria-label={`${label}，${open ? '收起详细差异' : '展开查看详细差异'}`}
        onClick={() => setOpen((value) => !value)}
      >
        {content}
        <ChevronRight size={12} strokeWidth={1.6} className="message-diff-chevron" aria-hidden />
      </button>
      {open ? (
        <div className="message-diff-detail" role="region" aria-label="本轮修改的文件">
          <div className="message-diff-detail-head">
            <span>修改的文件</span>
            <span className="message-diff-detail-hint mono">点开文件查看逐行差异</span>
          </div>
          <div className="message-diff-files">
            {data.entries.map((entry) => {
              const hasDetail = entry.details.length > 0
              const fileOpen = hasDetail && openFiles.has(entry.key)
              const head = (
                <>
                  <ChevronRight
                    size={12}
                    strokeWidth={1.6}
                    className={['message-diff-file-caret', hasDetail ? '' : 'is-quiet'].filter(Boolean).join(' ')}
                    aria-hidden
                  />
                  <FileIcon size={12} strokeWidth={1.5} aria-hidden />
                  <span className="message-diff-file-path truncate" title={entry.path}>
                    {entry.path}
                  </span>
                  <span className="message-diff-add mono">+{entry.added}</span>
                  <span className="message-diff-del mono">−{entry.removed}</span>
                  {hasDetail ? null : <span className="message-diff-file-note">仅统计</span>}
                </>
              )
              return (
                <section
                  key={entry.key}
                  className={['message-diff-file', fileOpen ? 'is-open' : ''].filter(Boolean).join(' ')}
                >
                  {hasDetail ? (
                    <button
                      type="button"
                      className="message-diff-file-head"
                      aria-expanded={fileOpen}
                      aria-label={`${fileOpen ? '收起' : '查看'} ${entry.path} 的逐行差异`}
                      onClick={() => toggleFile(entry.key)}
                    >
                      {head}
                    </button>
                  ) : (
                    <div className="message-diff-file-head">{head}</div>
                  )}
                  {fileOpen ? (
                    <div className="message-diff-changes">
                      {entry.details.length > 1 ? (
                        <p className="message-diff-change-note">
                          本轮修改了 {entry.details.length} 次，按执行顺序显示
                        </p>
                      ) : null}
                      {entry.details.map((detail, index) => (
                        <div className="message-diff-change" key={`${entry.key}-${index}`}>
                          {entry.details.length > 1 ? (
                            <div className="message-diff-change-head mono">
                              <span>第 {index + 1} 次</span>
                              <span className="message-diff-add">+{detail.added}</span>
                              <span className="message-diff-del">−{detail.removed}</span>
                            </div>
                          ) : null}
                          <DiffView
                            patch={detail.patch}
                            before={detail.before}
                            after={detail.after}
                            filePath={entry.path}
                            hideHeader
                            contextLines={3}
                            maxHeight={360}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
