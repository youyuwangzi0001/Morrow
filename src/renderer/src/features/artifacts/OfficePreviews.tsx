import { useMemo, useState } from 'react'
import { Archive, FileText, Search } from 'lucide-react'
import { formatBytes } from '@shared/usage'
import { withMorrowScrollbar } from '@shared/scrollbar'
import type {
  ArchiveEntryPreview,
  ArchivePreviewResult,
  PptxPreviewResult,
  XlsxPreviewResult
} from '@shared/file-types'
import type { EditorDocument } from './useEditorDocs'

/* ── 通用工具 ─────────────────────────────────────────────────── */

function parseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function Meta({ doc, extra }: { doc: EditorDocument; extra?: string }): React.JSX.Element {
  const ext = (doc.relPath || doc.title).split('.').pop()?.toUpperCase() ?? ''
  return (
    <span className="preview-meta mono">
      {[extra ?? ext, typeof doc.size === 'number' ? formatBytes(doc.size) : ''].filter(Boolean).join(' · ')}
    </span>
  )
}

function EmptyState({ title, detail }: { title: string; detail?: string }): React.JSX.Element {
  return (
    <div className="preview-state">
      <FileText size={22} strokeWidth={1.4} aria-hidden />
      <p className="preview-state-title">{title}</p>
      {detail ? <p className="preview-state-detail">{detail}</p> : null}
    </div>
  )
}

/* ── CSV / TSV 表格（编辑器内预览） ──────────────────────────── */

function parseDelimited(text: string, delimiter: string, maxRows = 500, maxCols = 60): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"' && cell.length === 0) {
      quoted = true
      continue
    }
    if (char === delimiter) {
      if (row.length < maxCols) row.push(cell)
      cell = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      if (row.length < maxCols) row.push(cell)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      cell = ''
      if (rows.length >= maxRows) return rows
      continue
    }
    cell += char
  }
  if (cell.length > 0 || row.length > 0) {
    if (row.length < maxCols) row.push(cell)
    if (row.some((value) => value.length > 0)) rows.push(row)
  }
  return rows
}

export function TablePreview({ content, relPath }: { content: string; relPath: string }): React.JSX.Element {
  const [header, setHeader] = useState(true)
  const delimiter = relPath.toLowerCase().endsWith('.tsv') ? '\t' : ','
  const rows = useMemo(() => parseDelimited(content.replace(/^\uFEFF/, ''), delimiter), [content, delimiter])
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const head = header ? rows[0] ?? [] : []
  const body = header ? rows.slice(1) : rows

  return (
    <div className="preview-table-pane" data-testid="table-preview">
      <div className="preview-table-bar">
        <span className="preview-kind mono">表格</span>
        <span className="preview-meta mono">
          {rows.length} 行 · {columns} 列{rows.length >= 500 ? ' · 仅显示前 500 行' : ''}
        </span>
        <label className="preview-table-toggle">
          <input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} />
          首行为表头
        </label>
      </div>
      <div className="office-table-wrap">
        <table className="office-table">
          {header && head.length > 0 ? (
            <thead>
              <tr>
                {Array.from({ length: columns }, (_, index) => (
                  <th key={index}>{head[index] ?? ''}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: columns }, (_, index) => (
                  <td key={index}>{row[index] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── XLSX ─────────────────────────────────────────────────────── */

export function XlsxPreview({ doc }: { doc: EditorDocument }): React.JSX.Element {
  const data = parseJson<XlsxPreviewResult>(doc.content)
  const [active, setActive] = useState(0)
  const [header, setHeader] = useState(true)
  if (!data || data.sheets.length === 0) return <EmptyState title="工作簿没有可显示的内容" detail={doc.previewNote ?? undefined} />
  const sheet = data.sheets[Math.min(active, data.sheets.length - 1)]
  const rows = sheet.rows
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const head = header ? rows[0] ?? [] : []
  const body = header ? rows.slice(1) : rows

  return (
    <div className="preview-office-pane" data-testid="xlsx-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">Excel</span>
          <Meta doc={doc} extra="工作表" />
          <span className="preview-readonly mono">只读预览</span>
        </div>
        <label className="preview-table-toggle">
          <input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} />
          首行为表头
        </label>
      </div>
      {data.sheets.length > 1 ? (
        <div className="office-sheet-tabs" role="tablist" aria-label="工作表">
          {data.sheets.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={['office-sheet-tab', index === active ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => setActive(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      ) : null}
      {doc.previewNote ? <p className="preview-note">{doc.previewNote}</p> : null}
      <div className="office-table-wrap">
        <table className="office-table">
          {header && head.length > 0 ? (
            <thead>
              <tr>
                {Array.from({ length: columns }, (_, index) => (
                  <th key={index}>{head[index] ?? ''}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: columns }, (_, index) => (
                  <td key={index}>{row[index] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="preview-office-foot mono">
        工作表 {active + 1}/{data.sheets.length} · {rows.length} 行 · {columns} 列
        {sheet.truncated ? ' · 内容已截断' : ''}
      </p>
    </div>
  )
}

/* ── PPTX ─────────────────────────────────────────────────────── */

export function PptxPreview({ doc }: { doc: EditorDocument }): React.JSX.Element {
  const data = parseJson<PptxPreviewResult>(doc.content)
  if (!data || data.slides.length === 0) return <EmptyState title="演示文稿没有可显示的文本" detail={doc.previewNote ?? undefined} />
  return (
    <div className="preview-office-pane preview-slides-pane" data-testid="pptx-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">演示文稿</span>
          <Meta doc={doc} extra={`${data.slides.length} 页`} />
          <span className="preview-readonly mono">只读预览</span>
        </div>
      </div>
      {doc.previewNote ? <p className="preview-note">{doc.previewNote}</p> : null}
      <div className="preview-slides">
        {data.slides.map((slide) => (
          <article className="preview-slide-card" key={slide.index}>
            <span className="preview-slide-index mono">{String(slide.index).padStart(2, '0')}</span>
            <div className="preview-slide-body">
              <h3 className="preview-slide-title">{slide.title}</h3>
              {slide.lines.length > 0 ? (
                <ul className="preview-slide-lines">
                  {slide.lines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p className="preview-office-foot mono">仅提取幻灯片文本；图片、图表与动画请用系统应用打开查看。</p>
    </div>
  )
}

/* ── RTF / ODF / EPUB ─────────────────────────────────────────── */

function documentShell(html: string, title: string, theme: 'dark' | 'light'): string {
  const pageBackground = theme === 'dark' ? '#0d1117' : '#e9e2d4'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base target="_blank">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: ${pageBackground}; color: #26231e; }
  body { padding: 24px 18px 40px; font-family: "Newsreader", "Noto Serif SC", "Songti SC", Georgia, serif; }
  .doc-page { box-sizing: border-box; max-width: 820px; margin: 0 auto; padding: clamp(22px, 5vw, 54px); background: #f8f4eb; border: 1px solid rgba(38, 35, 30, .1); box-shadow: 0 18px 50px rgba(0, 0, 0, .12); font-size: 14.5px; line-height: 1.78; overflow-wrap: anywhere; }
  .doc-page p { margin: 0 0 .8em; }
  h1, h2, h3 { margin: 1.1em 0 .55em; line-height: 1.35; font-weight: 600; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.3em; }
  table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: .92em; }
  td, th { padding: 6px 9px; border: 1px solid #d8d0c2; vertical-align: top; }
  th { background: #efe8db; text-align: left; }
  hr { border: 0; border-top: 1px solid #d8d0c2; margin: 1.5em 0; }
  ul, ol { margin: .6em 0 .9em; padding-left: 1.5em; }
</style></head>
<body><main class="doc-page">${html || '<p style="color:#8c867a;font-style:italic">这个文档没有可显示的正文。</p>'}</main></body></html>`
}

export function DocumentPreview({ doc, theme }: { doc: EditorDocument; theme: 'dark' | 'light' }): React.JSX.Element {
  const html = doc.content
  const shell = useMemo(() => documentShell(html, doc.title, theme), [html, doc.title, theme])
  return (
    <div className="preview-docx-pane" data-testid="document-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">{doc.relPath.split('.').pop()?.toUpperCase() ?? '文档'}</span>
          <Meta doc={doc} />
          <span className="preview-readonly mono">只读预览</span>
        </div>
      </div>
      {doc.previewNote ? <p className="preview-note">{doc.previewNote}</p> : null}
      <div className="preview-docx-stage">
        <iframe
          className="preview-docx-frame"
          title={`${doc.title} 预览`}
          sandbox="allow-popups"
          srcDoc={withMorrowScrollbar(shell)}
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  )
}

/* ── ZIP/JAR ──────────────────────────────────────────────────── */

export function ArchivePreview({ doc }: { doc: EditorDocument }): React.JSX.Element {
  const data = parseJson<ArchivePreviewResult>(doc.content)
  const [query, setQuery] = useState('')
  if (!data) return <EmptyState title="压缩包列表不可用" />
  const entries = data.entries
    .filter((entry) => !query.trim() || entry.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 800)
  const totalSize = data.entries.reduce((sum, entry) => sum + entry.size, 0)

  return (
    <div className="preview-office-pane" data-testid="archive-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">压缩包</span>
          <Meta doc={doc} extra={`${data.total} 项 · 解压后 ${formatBytes(totalSize)}`} />
          <span className="preview-readonly mono">只读预览</span>
        </div>
        <label className="preview-archive-search">
          <Search size={12} strokeWidth={1.6} aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选文件名"
            aria-label="筛选压缩包文件名"
          />
        </label>
      </div>
      {doc.previewNote ? <p className="preview-note">{doc.previewNote}</p> : null}
      <div className="preview-archive-list" role="list">
        {entries.length === 0 ? <p className="preview-note">没有匹配的文件。</p> : null}
        {entries.map((entry) => (
          <ArchiveRow key={entry.name} entry={entry} />
        ))}
      </div>
      <p className="preview-office-foot mono">
        仅读取压缩包目录，不解压写入磁盘；双击/解压请用系统应用打开。
        {data.entries.length > 800
          ? ` 共 ${data.total} 项，列表最多显示 800 项。`
          : data.truncated
            ? ` 共 ${data.total} 项，仅读取前 2000 项。`
            : ''}
      </p>
    </div>
  )
}

function ArchiveRow({ entry }: { entry: ArchiveEntryPreview }): React.JSX.Element {
  const depth = Math.min(6, entry.name.split('/').filter(Boolean).length - 1)
  return (
    <div className={['preview-archive-row', entry.dir ? 'is-dir' : ''].filter(Boolean).join(' ')} role="listitem">
      <span className="preview-archive-indent" style={{ width: depth * 14 }} aria-hidden />
      {entry.dir ? <Archive size={13} strokeWidth={1.5} aria-hidden /> : <FileText size={13} strokeWidth={1.5} aria-hidden />}
      <span className="preview-archive-name truncate" title={entry.name}>
        {entry.name.replace(/\/$/, '')}
      </span>
      {!entry.dir ? <span className="preview-archive-size mono">{formatBytes(entry.size)}</span> : null}
      {!entry.dir && entry.compressedSize > 0 ? (
        <span className="preview-archive-ratio mono">{Math.max(1, Math.round((entry.compressedSize / Math.max(1, entry.size)) * 100))}%</span>
      ) : null}
    </div>
  )
}

