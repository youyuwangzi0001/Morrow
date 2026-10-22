import { useMemo, useState } from 'react'
import { ChevronRight, FileDiff } from 'lucide-react'
import { structuredPatch } from 'diff'
import './DiffView.css'

/* ── 数据模型 ─────────────────────────────────────────────────── */

type RowKind = 'add' | 'del' | 'ctx' | 'note'

interface DiffRow {
  kind: RowKind
  text: string
  oldNo: number | null
  newNo: number | null
  /** 在 hunk 内的下标 */
  index: number
}

interface DiffHunk {
  header: string
  oldStart: number
  newStart: number
  rows: DiffRow[]
}

interface ParsedDiffModel {
  hunks: DiffHunk[]
  added: number
  removed: number
  filePath: string | null
  /** 无法逐行展示时的说明（文件过大等） */
  note: string | null
}

export interface DiffViewProps {
  /** unified diff 文本（引擎 createUnifiedDiff 的 patch） */
  patch?: string
  /** 或直接给修改前/后文本，内部用 diff 包计算 */
  before?: string
  after?: string
  filePath?: string
  /** 折叠未改动上下文，默认 3 行 */
  contextLines?: number
  /** 隐藏文件头（嵌在工具卡里时由外层标题承担） */
  hideHeader?: boolean
  /** 最大高度，超出滚动 */
  maxHeight?: number | string
  className?: string
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

/* ── 解析 ─────────────────────────────────────────────────────── */

function parseUnified(patch: string): ParsedDiffModel {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  let filePath: string | null = null
  let note: string | null = null
  let rowIndex = 0

  const push = (kind: RowKind, text: string, withNumbers = true): void => {
    if (!current) return
    current.rows.push({
      kind,
      text,
      oldNo: withNumbers && kind !== 'add' ? oldNo : null,
      newNo: withNumbers && kind !== 'del' ? newNo : null,
      index: rowIndex
    })
    rowIndex += 1
    if (kind === 'ctx') {
      oldNo += 1
      newNo += 1
    } else if (kind === 'del') {
      oldNo += 1
    } else if (kind === 'add') {
      newNo += 1
    }
  }

  for (const raw of lines) {
    const match = HUNK_HEADER.exec(raw)
    if (match) {
      oldNo = Number(match[1])
      newNo = Number(match[3])
      rowIndex = 0
      current = {
        header: raw,
        oldStart: oldNo,
        newStart: newNo,
        rows: []
      }
      hunks.push(current)
      continue
    }
    if (raw.startsWith('--- ')) {
      filePath = filePath ?? raw.slice(4).replace(/^[ab]\//, '')
      continue
    }
    if (raw.startsWith('+++ ')) {
      filePath = filePath ?? raw.slice(4).replace(/^[ab]\//, '')
      continue
    }
    if (raw.startsWith('\\ ')) continue
    if (raw.startsWith('…') || raw.startsWith('(内容较大')) {
      note = raw.replace(/^…/, '').trim()
      continue
    }
    if (!current) continue
    if (raw.startsWith('+')) {
      added += 1
      push('add', raw.slice(1))
    } else if (raw.startsWith('-')) {
      removed += 1
      push('del', raw.slice(1))
    } else if (raw.startsWith(' ')) {
      push('ctx', raw.slice(1))
    } else if (raw.length === 0) {
      push('ctx', '')
    } else {
      push('ctx', raw)
    }
  }

  return { hunks, added, removed, filePath, note }
}

function buildFromText(before: string, after: string, filePath: string, context: number): ParsedDiffModel {
  const parsed = structuredPatch(`a/${filePath}`, `b/${filePath}`, before, after, '', '', { context })
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  for (const hunk of parsed.hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    const rows: DiffRow[] = hunk.lines.map((line, index) => {
      const marker = line.slice(0, 1)
      const text = line.slice(1)
      if (marker === '+') {
        added += 1
        const row: DiffRow = { kind: 'add', text, oldNo: null, newNo, index }
        newNo += 1
        return row
      }
      if (marker === '-') {
        removed += 1
        const row: DiffRow = { kind: 'del', text, oldNo, newNo: null, index }
        oldNo += 1
        return row
      }
      const row: DiffRow = { kind: 'ctx', text, oldNo, newNo, index }
      oldNo += 1
      newNo += 1
      return row
    })
    hunks.push({
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows
    })
  }
  return { hunks, added, removed, filePath, note: null }
}

/* ── 渲染 ─────────────────────────────────────────────────────── */

interface RenderBlock {
  kind: 'rows' | 'collapsed'
  rows: DiffRow[]
  hiddenCount: number
  start: number
}

/** 把 hunk 拆成「显示行」「折叠的未改动块」 */
function splitContext(rows: DiffRow[], contextLines: number): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let buffer: DiffRow[] = []
  const flushBuffer = (): void => {
    if (buffer.length) {
      blocks.push({ kind: 'rows', rows: buffer, hiddenCount: 0, start: 0 })
      buffer = []
    }
  }
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row.kind !== 'ctx') {
      buffer.push(row)
      index += 1
      continue
    }
    let end = index
    while (end < rows.length && rows[end].kind === 'ctx') end += 1
    const runLength = end - index
    const atStart = index === 0
    const atEnd = end === rows.length
    // 上下文块保留首尾 contextLines 行，中间折叠（文件开头/结尾的块直接折叠）
    const keepHead = atStart ? 0 : contextLines
    const keepTail = atEnd ? 0 : contextLines
    if (runLength > keepHead + keepTail) {
      flushBuffer()
      for (let i = 0; i < keepHead; i += 1) buffer.push(rows[index + i])
      flushBuffer()
      blocks.push({ kind: 'collapsed', rows: rows.slice(index + keepHead, end - keepTail), hiddenCount: runLength - keepHead - keepTail, start: index + keepHead })
      buffer = []
      for (let i = runLength - keepTail; i < runLength; i += 1) buffer.push(rows[index + i])
      flushBuffer()
    } else {
      for (let i = index; i < end; i += 1) buffer.push(rows[i])
    }
    index = end
  }
  flushBuffer()
  return blocks
}

function HunkView({
  hunk,
  contextLines,
  collapseContext
}: {
  hunk: DiffHunk
  contextLines: number
  collapseContext: boolean
}): React.JSX.Element {
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(() => new Set())
  const blocks = useMemo(
    () => (collapseContext ? splitContext(hunk.rows, contextLines) : [{ kind: 'rows' as const, rows: hunk.rows, hiddenCount: 0, start: 0 }]),
    [hunk.rows, contextLines, collapseContext]
  )

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head mono">{hunk.header}</div>
      {blocks.map((block, blockIndex) => {
        if (block.kind === 'collapsed' && !expandedRuns.has(block.start)) {
          return (
            <button
              key={`c-${blockIndex}`}
              type="button"
              className="diff-collapse mono"
              onClick={() =>
                setExpandedRuns((prev) => {
                  const next = new Set(prev)
                  next.add(block.start)
                  return next
                })
              }
              aria-label={`展开 ${block.hiddenCount} 行未改动内容`}
            >
              <ChevronRight size={12} strokeWidth={1.6} aria-hidden />
              <span>展开 {block.hiddenCount} 行未改动内容</span>
            </button>
          )
        }
        return (
          <div key={`r-${blockIndex}`} className="diff-rows">
            {block.rows.map((row) => (
              <div key={`${row.index}-${row.kind}`} className={`diff-line is-${row.kind}`}>
                <span className="diff-gutter mono" aria-hidden>
                  {row.oldNo ?? ''}
                </span>
                <span className="diff-gutter mono" aria-hidden>
                  {row.newNo ?? ''}
                </span>
                <span className="diff-sign mono" aria-hidden>
                  {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                </span>
                <span className="diff-code">{row.text}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 差异视图：红绿低饱和、行号、上下文折叠。
 * 数据来源兼容两种：unified diff 文本（工具结果/审批预览）或修改前后文本。
 */
export function DiffView({
  patch,
  before,
  after,
  filePath,
  contextLines = 3,
  hideHeader = false,
  maxHeight,
  className
}: DiffViewProps): React.JSX.Element {
  const model = useMemo<ParsedDiffModel | null>(() => {
    if (typeof before === 'string' && typeof after === 'string') {
      if (before === after) return { hunks: [], added: 0, removed: 0, filePath: filePath ?? null, note: null }
      return buildFromText(before, after, filePath ?? 'file', contextLines)
    }
    if (patch && patch.trim()) return parseUnified(patch)
    return null
  }, [patch, before, after, filePath, contextLines])

  if (!model) {
    return <div className={['diff-view', 'is-empty', className].filter(Boolean).join(' ')}>没有可显示的改动</div>
  }

  if (model.hunks.length === 0) {
    return (
      <div className={['diff-view', 'is-empty', className].filter(Boolean).join(' ')}>
        {model.note ?? '内容没有变化'}
      </div>
    )
  }

  return (
    <div className={['diff-view', className].filter(Boolean).join(' ')}>
      {hideHeader ? null : (
        <div className="diff-head">
          <span className="diff-file mono">
            <FileDiff size={12} strokeWidth={1.6} aria-hidden />
            {filePath ?? model.filePath ?? '改动'}
          </span>
          <span className="diff-stats mono">
            <span className="diff-add-count">+{model.added}</span>
            <span className="diff-del-count">-{model.removed}</span>
          </span>
        </div>
      )}
      <div className="diff-body" style={maxHeight ? { maxHeight } : undefined}>
        {model.hunks.map((hunk, index) => (
          <HunkView key={`${hunk.header}-${index}`} hunk={hunk} contextLines={contextLines} collapseContext={model.hunks.length > 0} />
        ))}
        {model.note ? <div className="diff-note mono">{model.note}</div> : null}
      </div>
    </div>
  )
}
