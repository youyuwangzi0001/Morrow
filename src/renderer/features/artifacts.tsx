// artifacts 功能域组件：由 8 个 TSX 文件扁平合并。
import './artifacts.css'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AlignLeft, Check, Copy, FileDown, FileText, Globe, ShieldCheck, TriangleAlert, Clock, RotateCcw, Archive, Search, Eye, FileWarning, Pencil, RefreshCw, Save, SaveAll, X, History, ChevronLeft, ChevronRight, Minus, Plus, ScanLine, ExternalLink, FileAudio, FileImage, FileQuestion, FileVideo, FolderOpen, FileCode2, FilePen, FolderDown, Image as ImageIcon, Maximize2, Minimize2, Share2 } from 'lucide-react'
import type { Artifact, ArtifactExportFormat, ArtifactVersionInfo, ArtifactKind } from '@shared/types'
import { useAppStore, maxCanvasWidthForViewport, responsiveCanvasWidth } from '../store'
import { Button, Modal, Spinner, IconButton, ErrorNote, ResizeHandle } from '../components'
import { formatBytes } from '@shared/types'
import { formatArtifactTime, errorText } from '../components'
import { withMorrowScrollbar } from '@shared/types'
import type { ArchiveEntryPreview, ArchivePreviewResult, PptxPreviewResult, XlsxPreviewResult, FilePreviewKind } from '@shared/contracts'
import { isTableFileName, previewKindForFileName } from '@shared/contracts'
import type { EditorDocument, EditorHistorySelection } from './artifacts-core'
import { useEditorDocs } from './artifacts-core'
import { documentPageTheme } from './artifacts-core'
import { Markdown } from '../components'
import type { CodeEditorHandle } from '../components'
import { CodeEditor } from '../components'
import { languageLabel } from '../components'
import { DiffView } from '../components'
import type { HistoryVersion } from './artifacts-core'
import { relativeToWorkspace } from './artifacts-core'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { CodeBlock } from '../components'

type CopyFormat = Exclude<ArtifactExportFormat, 'pdf' | 'original'>

interface FormatOption {
  id: ArtifactExportFormat
  label: string
  hint: string
  copy: boolean
}

function formatsFor(artifact: Artifact): FormatOption[] {
  if (artifact.kind === 'file') {
    return [{ id: 'original', label: '原文件', hint: '保持文件原始格式，不做任何转换', copy: false }]
  }
  const markdown: FormatOption = {
    id: 'markdown',
    label: artifact.kind === 'markdown' ? 'Markdown 原文' : 'Markdown',
    hint: artifact.kind === 'markdown' ? '保留原始 Markdown 语法' : '保留标题、列表、表格与链接',
    copy: true
  }
  const html: FormatOption = {
    id: 'html',
    label: '网页',
    hint: artifact.kind === 'html' ? '保留原有排版与交互' : '带排版样式的独立 HTML，可直接用浏览器打开',
    copy: true
  }
  const text: FormatOption = { id: 'text', label: '纯文本', hint: '去掉样式，只保留可读文字', copy: true }
  const pdf: FormatOption = { id: 'pdf', label: 'PDF', hint: 'A4 排版，适合打印、归档与发送', copy: false }
  if (artifact.kind === 'html') return [html, markdown, text, pdf]
  return [markdown, html, text, pdf]
}

const FORMAT_ICON: Record<ArtifactExportFormat, React.JSX.Element> = {
  original: <FileDown size={16} strokeWidth={1.5} aria-hidden />,
  markdown: <FileText size={16} strokeWidth={1.5} aria-hidden />,
  html: <Globe size={16} strokeWidth={1.5} aria-hidden />,
  text: <AlignLeft size={16} strokeWidth={1.5} aria-hidden />,
  pdf: <FileText size={16} strokeWidth={1.5} aria-hidden />
}

export function ArtifactExportDialog({
  open,
  onClose,
  sessionId,
  artifact
}: {
  open: boolean
  onClose: () => void
  sessionId: string
  artifact: Artifact
}): React.JSX.Element {
  const exportArtifact = useAppStore((s) => s.exportArtifact)
  const copyArtifactExport = useAppStore((s) => s.copyArtifactExport)
  const notify = useAppStore((s) => s.notify)
  const options = formatsFor(artifact)
  const [format, setFormat] = useState<ArtifactExportFormat>(options[0]?.id ?? 'original')
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const next = formatsFor(artifact)
    setFormat(next.find((item) => item.id === 'pdf')?.id ?? next[0]?.id ?? 'original')
    setExportedPath(null)
    setError(null)
    setExporting(false)
  }, [artifact, open])

  const selected = options.find((item) => item.id === format) ?? options[0]

  const runExport = async (): Promise<void> => {
    if (!selected || exporting) return
    setExporting(true)
    setError(null)
    try {
      const saved = await exportArtifact(sessionId, artifact.id, selected.id)
      if (saved) setExportedPath(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const copyExport = async (): Promise<void> => {
    if (!selected?.copy) return
    try {
      await copyArtifactExport(sessionId, artifact.id, selected.id as CopyFormat)
    } catch (err) {
      setError(err instanceof Error ? err.message : '复制失败')
    }
  }

  const copyPath = (): void => {
    if (!exportedPath) return
    void navigator.clipboard
      .writeText(exportedPath)
      .then(() => notify('success', '已复制导出路径'))
      .catch(() => notify('error', '复制路径失败'))
  }

  const footer = (
    <div className="artifact-dialog-foot">
      <span className="artifact-dialog-note mono">
        <ShieldCheck size={12} strokeWidth={1.6} aria-hidden /> 只写入你选择的本地位置，不会上传
      </span>
      <div className="artifact-dialog-actions">
        <Button variant="ghost" onClick={onClose} disabled={exporting}>
          关闭
        </Button>
        <Button variant="primary" onClick={() => void runExport()} disabled={exporting || !selected}>
          {exporting ? '正在导出…' : exportedPath ? '再次导出' : `导出 ${selected?.label ?? '文件'}`}
        </Button>
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="导出成品"
      description={`${artifact.title} · 生成一份独立的本地文件，用浏览器、阅读器或打印带走。`}
      width={620}
      footer={footer}
      closeOnBackdrop={!exporting}
    >
      <div className="artifact-export-body">
        <div className="artifact-format-grid" role="radiogroup" aria-label="导出格式">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === format}
              className={['artifact-format', option.id === format ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => {
                setFormat(option.id)
                setExportedPath(null)
                setError(null)
              }}
              disabled={exporting}
            >
              <span className="artifact-format-icon" aria-hidden>
                {FORMAT_ICON[option.id]}
              </span>
              <span className="artifact-format-copy">
                <span className="artifact-format-label">{option.label}</span>
                <span className="artifact-format-hint">{option.hint}</span>
              </span>
              {option.id === format ? (
                <span className="artifact-format-check" aria-hidden>
                  <Check size={12} strokeWidth={2} />
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {selected?.copy ? (
          <div className="artifact-export-copy-row">
            <span className="artifact-export-copy-hint">不生成文件，直接把当前内容放进剪贴板。</span>
            <button type="button" className="artifact-text-btn" onClick={() => void copyExport()}>
              <Copy size={12} strokeWidth={1.7} aria-hidden />
              复制{selected.label}内容
            </button>
          </div>
        ) : null}

        {exportedPath ? (
          <div className="artifact-export-result" role="status">
            <span className="artifact-export-result-icon" aria-hidden>
              <Check size={13} strokeWidth={2} />
            </span>
            <div className="artifact-export-result-main">
              <span>已导出到本机</span>
              <code className="mono selectable">{exportedPath}</code>
            </div>
            <button type="button" className="artifact-text-btn" onClick={copyPath} title="复制导出路径">
              <Copy size={12} strokeWidth={1.7} aria-hidden />
              复制路径
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="artifact-export-error" role="alert">
            <TriangleAlert size={14} strokeWidth={1.6} aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

const ArtifactVersionsDialogSOURCE_LABEL: Record<ArtifactVersionInfo['source'], string> = {
  baseline: '初始版本',
  agent: 'Morrow 修改',
  restore: '恢复记录',
  manual: '手动保存'
}

export function ArtifactVersionsDialog({
  open,
  onClose,
  sessionId,
  artifactId,
  artifactTitle
}: {
  open: boolean
  onClose: () => void
  sessionId: string
  artifactId: string
  artifactTitle: string
}): React.JSX.Element {
  const loadArtifactVersions = useAppStore((s) => s.loadArtifactVersions)
  const readArtifactVersion = useAppStore((s) => s.readArtifactVersion)
  const restoreArtifactVersion = useAppStore((s) => s.restoreArtifactVersion)
  const [versions, setVersions] = useState<ArtifactVersionInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await loadArtifactVersions(sessionId, artifactId)
      setVersions(list)
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取版本历史失败')
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [artifactId, loadArtifactVersions, sessionId])

  useEffect(() => {
    if (!open) return
    setSelectedId(null)
    setPreview(null)
    setConfirming(false)
    void load()
  }, [open, artifactId, load])

  useEffect(() => {
    if (!open || !selectedId) {
      setPreview(null)
      return undefined
    }
    let cancelled = false
    setPreviewLoading(true)
    setConfirming(false)
    readArtifactVersion(sessionId, artifactId, selectedId)
      .then((result) => {
        if (!cancelled) setPreview(result.content)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取版本内容失败')
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [artifactId, open, readArtifactVersion, selectedId, sessionId])

  const selected = versions.find((item) => item.id === selectedId) ?? null
  const isCurrent = Boolean(selected && versions[0] && selected.id === versions[0].id)

  const restore = async (): Promise<void> => {
    if (!selected || restoring) return
    setRestoring(true)
    setError(null)
    try {
      await restoreArtifactVersion(sessionId, artifactId, selected.id)
      setConfirming(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复版本失败')
    } finally {
      setRestoring(false)
    }
  }

  const footer = (
    <div className="artifact-dialog-foot">
      <span className="artifact-dialog-note mono">
        {versions.length > 0
          ? `${versions.length} 个版本 · 最多保留 30 个${isCurrent ? ' · 当前是最新版本' : ''}`
          : '版本只保存在本机'}
      </span>
      <div className="artifact-dialog-actions">
        {confirming ? (
          <>
            <span className="artifact-restore-ask">恢复会覆盖当前内容，但当前版本会保留。</span>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={restoring}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void restore()} disabled={restoring}>
              {restoring ? '恢复中…' : '确认恢复'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {!isCurrent ? (
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={!selected || loading || previewLoading}
              >
                <RotateCcw size={13} strokeWidth={1.7} aria-hidden />
                恢复此版本
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="版本历史"
      description={`${artifactTitle} · 每次内容变化都会留下一份快照；恢复会覆盖当前内容，也会记录成新版本。`}
      width={780}
      footer={footer}
    >
      <div className="artifact-versions-body">
        {loading ? (
          <div className="artifact-versions-status">
            <Spinner size={14} label="正在读取版本历史" />
            <span className="mono">正在读取版本…</span>
          </div>
        ) : error && versions.length === 0 ? (
          <div className="artifact-versions-status is-error">
            <TriangleAlert size={16} strokeWidth={1.6} aria-hidden />
            <p>{error}</p>
            <button type="button" className="artifact-text-btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : versions.length === 0 ? (
          <div className="artifact-versions-status">
            <Clock size={17} strokeWidth={1.5} aria-hidden />
            <p>还没有版本记录。</p>
            <p className="artifact-versions-hint">二进制文件不做版本快照；让 Morrow 修改成品或重新打开历史后，这里会出现记录。</p>
          </div>
        ) : (
          <>
            <div className="artifact-versions-list" role="listbox" aria-label="成品版本列表">
              <div className="artifact-versions-list-head mono">
                <span>版本</span>
                <span>{versions.length} 个</span>
              </div>
              {versions.map((version, index) => (
                <button
                  key={version.id}
                  type="button"
                  role="option"
                  aria-selected={version.id === selectedId}
                  className={['artifact-version-item', version.id === selectedId ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => setSelectedId(version.id)}
                >
                  <span className="artifact-version-main">
                    <span className="artifact-version-time mono">{formatArtifactTime(version.createdAt)}</span>
                    {index === 0 ? <span className="artifact-version-current mono">当前</span> : null}
                  </span>
                  <span className="artifact-version-meta">
                    <span className={`artifact-version-source mono is-${version.source}`}>
                      {ArtifactVersionsDialogSOURCE_LABEL[version.source] ?? version.source}
                    </span>
                    <span className="artifact-version-size mono">{formatBytes(version.size)}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="artifact-version-detail">
              <div className="artifact-version-detail-head mono">
                <span>{selected ? `${formatArtifactTime(selected.createdAt)} · ${ArtifactVersionsDialogSOURCE_LABEL[selected.source]}` : ''}</span>
                <span>{isCurrent ? '当前内容' : '历史快照'}</span>
              </div>
              <div className="artifact-version-preview">
                {previewLoading ? (
                  <div className="artifact-versions-status">
                    <Spinner size={13} label="正在读取版本内容" />
                    <span className="mono">正在读取…</span>
                  </div>
                ) : (
                  <pre className="artifact-version-pre mono selectable">
                    {preview !== null && preview.length > 0 ? preview.slice(0, 500_000) : '这个版本没有可预览的文本。'}
                  </pre>
                )}
              </div>
              {error ? <p className="artifact-version-error">{error}</p> : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

function parseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function OfficePreviewsEscapeHtml(value: string): string {
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

function documentShell(html: string, title: string, theme: 'dark' | 'light'): string {
  const t = documentPageTheme()
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base target="_blank">
<title>${OfficePreviewsEscapeHtml(title)}</title>
<style>
  :root { color-scheme: ${theme}; }
  html, body { margin: 0; padding: 0; background: ${t.shell}; color: ${t.ink}; }
  body { padding: 24px 18px 40px; font-family: "Newsreader", "Noto Serif SC", "Songti SC", Georgia, serif; }
  .doc-page { box-sizing: border-box; max-width: 820px; margin: 0 auto; padding: clamp(22px, 5vw, 54px); background: ${t.page}; border: 1px solid ${t.border}; box-shadow: 0 18px 50px rgba(0, 0, 0, .18); font-size: 14.5px; line-height: 1.78; overflow-wrap: anywhere; }
  .doc-page p { margin: 0 0 .8em; }
  h1, h2, h3 { margin: 1.1em 0 .55em; line-height: 1.35; font-weight: 600; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.3em; }
  table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: .92em; }
  td, th { padding: 6px 9px; border: 1px solid ${t.table}; vertical-align: top; }
  th { background: ${t.tableHead}; text-align: left; }
  hr { border: 0; border-top: 1px solid ${t.border}; margin: 1.5em 0; }
  ul, ol { margin: .6em 0 .9em; padding-left: 1.5em; }
</style></head>
<body><main class="doc-page">${html || `<p style="color:${t.muted};font-style: normal;">这个文档没有可显示的正文。</p>`}</main></body></html>`
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

export interface EditorPaneProps {
  doc: EditorDocument
  theme: 'dark' | 'light'
  /** 当前会话/全局处于只读模式（动态变化，不写进 doc.readOnly） */
  readOnlyMode: boolean
  onContentChange: (value: string) => void
  onSave: () => void
  onForceSave: () => void
  onReload: () => void
  onTogglePreview: () => void
  onShowHistory: () => void
  onRequestSaveAs: () => void
  onRequestClose: () => void
  onCopyPath: () => void
}

/**
 * 单个可编辑文档：CodeMirror 编辑器 + 工具栏 + Markdown/HTML 预览 + 冲突提示。
 * 编辑器本体在 components/editor；这里只做文档级 UI 与状态呈现。
 */
export function EditorPane({
  doc,
  theme,
  readOnlyMode,
  onContentChange,
  onSave,
  onForceSave,
  onReload,
  onTogglePreview,
  onShowHistory,
  onRequestSaveAs,
  onRequestClose,
  onCopyPath
}: EditorPaneProps): React.JSX.Element {
  const editorRef = useRef<CodeEditorHandle>(null)
  const [cursor, setCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 })
  const tablePreview = isTableFileName(doc.relPath || doc.title)
  const svgPreview = /\.svg$/i.test(doc.relPath || doc.title)
  const previewAvailable = doc.language === 'markdown' || doc.language === 'html' || tablePreview || svgPreview
  const showPreview = doc.preview && previewAvailable
  const previewLabel = tablePreview ? '预览表格' : svgPreview ? '预览图形' : doc.language === 'markdown' ? '预览 Markdown' : '预览网页'
  const readOnly = readOnlyMode || doc.readOnly || doc.binary || doc.truncated

  const status = useMemo(() => {
    if (doc.loading) return { tone: 'muted', label: '读取中' }
    if (doc.error) return { tone: 'danger', label: '读取失败' }
    if (doc.binary) return { tone: 'muted', label: '二进制文件' }
    if (doc.truncated) return { tone: 'warning', label: '仅预览开头' }
    if (readOnlyMode) return { tone: 'muted', label: '只读模式' }
    if (doc.readOnly) return { tone: 'muted', label: '只读' }
    if (doc.dirty) return { tone: 'warning', label: '未保存' }
    return { tone: 'success', label: '已保存' }
  }, [doc.binary, doc.dirty, doc.error, doc.loading, doc.readOnly, doc.truncated, readOnlyMode])

  const saveLabel = doc.conflict ? '覆盖保存 (Ctrl+S)' : '保存 (Ctrl+S)'

  return (
    <div className="editor-pane" data-language={doc.language}>
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          <span className="editor-path mono" title={doc.relPath || doc.absPath}>
            {doc.relPath || doc.title}
          </span>
          <span className="editor-toolbar-sep" aria-hidden />
          <span className="editor-lang mono">{languageLabel(doc.language)}</span>
          <span className={`editor-status mono is-${status.tone}`}>{status.label}</span>
        </div>
        <div className="editor-toolbar-right">
          {showPreview ? null : (
            <span className="editor-cursor mono" aria-label={`光标位置：第 ${cursor.line} 行，第 ${cursor.column} 列`}>
              行 {cursor.line} · 列 {cursor.column}
            </span>
          )}
          {doc.conflict ? (
            <button
              type="button"
              className="editor-text-btn is-danger"
              onClick={onForceSave}
              disabled={readOnly}
              title={readOnly ? '当前是只读模式，不能覆盖保存' : '用编辑器里的内容覆盖磁盘文件'}
            >
              <TriangleAlert size={12} strokeWidth={1.7} aria-hidden />
              覆盖保存
            </button>
          ) : (
            <button
              type="button"
              className={['editor-text-btn', doc.dirty ? 'is-primary' : ''].filter(Boolean).join(' ')}
              onClick={onSave}
              disabled={!doc.dirty || readOnly}
              title={saveLabel}
            >
              <Save size={12} strokeWidth={1.7} aria-hidden />
              保存
            </button>
          )}
          {doc.workspace ? (
            <button type="button" className="editor-text-btn" onClick={onShowHistory} title="查看这个文件的版本历史">
              <Clock size={12} strokeWidth={1.7} aria-hidden />
              历史
            </button>
          ) : null}
          {previewAvailable ? (
            <button
              type="button"
              className={['editor-text-btn', showPreview ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={onTogglePreview}
              aria-pressed={showPreview}
              title={showPreview ? '回到编辑' : previewLabel}
            >
              {showPreview ? <Pencil size={12} strokeWidth={1.7} aria-hidden /> : <Eye size={12} strokeWidth={1.7} aria-hidden />}
              {showPreview ? '编辑' : '预览'}
            </button>
          ) : null}
          <button
            type="button"
            className="editor-text-btn"
            onClick={onRequestSaveAs}
            disabled={readOnlyMode}
            title={readOnlyMode ? '当前是只读模式，不能另存文件' : '另存为文件夹内的新文件'}
          >
            <SaveAll size={12} strokeWidth={1.7} aria-hidden />
            另存为
          </button>
          {doc.conflict || doc.error ? (
            <button type="button" className="editor-text-btn" onClick={onReload} title="从磁盘重新加载，放弃未保存修改">
              <RefreshCw size={12} strokeWidth={1.7} aria-hidden />
              重新加载
            </button>
          ) : null}
          <span className="editor-toolbar-sep" aria-hidden />
          <IconButton label="复制相对路径" size={24} onClick={onCopyPath}>
            <Copy size={12} strokeWidth={1.6} />
          </IconButton>
          <IconButton label="关闭这个文件" size={24} onClick={onRequestClose}>
            <X size={13} strokeWidth={1.6} />
          </IconButton>
        </div>
      </div>

      {doc.conflict ? (
        <div className="editor-banner is-warning" role="alert">
          <TriangleAlert size={13} strokeWidth={1.7} aria-hidden />
          <span>{doc.conflict}</span>
          <div className="editor-banner-actions">
            <button type="button" onClick={onReload}>
              重新加载
            </button>
            <button type="button" onClick={onForceSave} disabled={readOnly}>
              覆盖保存
            </button>
          </div>
        </div>
      ) : null}

      {doc.previewNote && !doc.binary && !doc.truncated && !doc.error ? (
        <div className="editor-banner is-info" role="status">
          <FileWarning size={13} strokeWidth={1.7} aria-hidden />
          <span>{doc.previewNote}</span>
        </div>
      ) : null}

      {doc.truncated ? (
        <div className="editor-banner is-danger" role="alert">
          <FileWarning size={13} strokeWidth={1.7} aria-hidden />
          <span>文件较大，只显示了前一部分内容。为避免损坏原文件，这里只读；需要完整编辑请用其它工具打开。</span>
        </div>
      ) : null}

      {doc.error && !doc.content ? (
        <div className="editor-error">
          <FileWarning size={20} strokeWidth={1.4} aria-hidden />
          <p className="editor-error-title">这个文件打不开</p>
          <p className="editor-error-detail">{doc.error}</p>
          <button type="button" className="editor-text-btn is-primary" onClick={onReload}>
            重试
          </button>
        </div>
      ) : showPreview ? (
        <div className="editor-preview">
          {doc.language === 'markdown' ? (
            <div className="editor-preview-paper selectable">
              <Markdown text={doc.content} />
            </div>
          ) : tablePreview ? (
            <TablePreview content={doc.content} relPath={doc.relPath} />
          ) : svgPreview ? (
            <div className="editor-preview-svg">
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc.content)}`} alt={doc.title} />
            </div>
          ) : (
            <iframe
              className="editor-preview-frame"
              title={`${doc.title} 预览`}
              // 本地 HTML 预览不需要脚本/表单；可交互 HTML 走画布成品的独立沙箱
              sandbox=""
              srcDoc={withMorrowScrollbar(doc.content)}
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      ) : (
        <div className="editor-canvas">
          <CodeEditor
            ref={editorRef}
            value={doc.content}
            documentKey={doc.relPath || doc.title}
            language={doc.language}
            readOnly={readOnly}
            theme={theme}
            ariaLabel={`${doc.title} 编辑器`}
            onChange={onContentChange}
            onSave={onSave}
            onCursor={(line, column) => setCursor({ line, column })}
          />
        </div>
      )}
    </div>
  )
}

export interface HistoryDrawerProps {
  doc: EditorDocument
  /** 当前会话/全局只读模式：查看历史可以，恢复写盘必须禁用 */
  readOnly?: boolean
  onClose: () => void
  loadVersions: (doc: EditorDocument) => Promise<HistoryVersion[]>
  loadDiff: (doc: EditorDocument, versionId: string) => Promise<EditorHistorySelection>
  onRestore: (doc: EditorDocument, versionId: string) => Promise<boolean>
}

const HistoryDrawerSOURCE_LABEL: Record<HistoryVersion['source'], string> = {
  user: '手动保存',
  agent: 'Morrow 修改',
  baseline: '打开时基线',
  restore: '版本恢复'
}

/**
 * 版本历史抽屉：右侧浮层，列出文件历史版本、与当前编辑器内容的 diff、恢复确认。
 * 数据全部来自主进程 feature:history:*；历史服务不可用时给出可读错误与重试。
 */
export function HistoryDrawer({
  doc,
  readOnly = false,
  onClose,
  loadVersions,
  loadDiff,
  onRestore
}: HistoryDrawerProps): React.JSX.Element {
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selection, setSelection] = useState<EditorHistorySelection | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await loadVersions(doc)
      setVersions(list)
      setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setVersions([])
    } finally {
      setLoading(false)
    }
  }, [doc, loadVersions])

  useEffect(() => {
    void load()
    // 保存后 mtime 变化 → 自动刷新版本列表（抽屉打开时也能看到新版本）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.absPath, doc.mtimeMs])

  useEffect(() => {
    if (!selectedId) {
      setSelection(null)
      return undefined
    }
    let cancelled = false
    setDiffLoading(true)
    setConfirming(false)
    loadDiff(doc, selectedId)
      .then((result) => {
        if (!cancelled) setSelection(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [doc, loadDiff, selectedId])

  const restore = async (): Promise<void> => {
    if (!selectedId || restoring) return
    setRestoring(true)
    try {
      const ok = await onRestore(doc, selectedId)
      if (ok) {
        setConfirming(false)
        await load()
      }
    } finally {
      setRestoring(false)
    }
  }

  return (
    <aside className="editor-history" aria-label="版本历史">
      <header className="editor-history-head">
        <span className="editor-history-icon" aria-hidden>
          <History size={14} strokeWidth={1.6} />
        </span>
        <div className="editor-history-copy">
          <span className="editor-history-title">版本历史</span>
          <span className="editor-history-sub mono" title={doc.relPath || doc.title}>
            {doc.relPath || doc.title}
          </span>
        </div>
        <IconButton label="刷新版本列表" size={24} onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} strokeWidth={1.6} />
        </IconButton>
        <IconButton label="关闭版本历史" size={24} onClick={onClose}>
          <X size={13} strokeWidth={1.6} />
        </IconButton>
      </header>

      <div className="editor-history-body">
        {loading ? (
          <div className="editor-history-status">
            <Spinner size={14} label="正在读取版本历史" />
            <span className="mono">正在读取版本…</span>
          </div>
        ) : error ? (
          <div className="editor-history-status is-error">
            <TriangleAlert size={15} strokeWidth={1.6} aria-hidden />
            <p>{error}</p>
            <button type="button" className="editor-text-btn" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : versions.length === 0 ? (
          <div className="editor-history-status">
            <Clock size={16} strokeWidth={1.5} aria-hidden />
            <p>还没有版本记录。</p>
            <p className="editor-history-hint">保存一次或让 Morrow 修改这个文件后，历史会出现在这里。</p>
          </div>
        ) : (
          <>
            <div className="editor-history-list" role="listbox" aria-label="历史版本列表">
              <div className="editor-history-list-head mono">
                <span>版本</span>
                <span>{versions.length} 个</span>
              </div>
              {versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  role="option"
                  aria-selected={version.id === selectedId}
                  className={['editor-history-item', version.id === selectedId ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onClick={() => setSelectedId(version.id)}
                >
                  <span className="editor-history-item-main">
                    <span className="editor-history-item-time mono">{formatArtifactTime(version.createdAt)}</span>
                    <span className={`editor-history-item-source mono is-${version.source}`}>
                      {HistoryDrawerSOURCE_LABEL[version.source] ?? version.source}
                    </span>
                  </span>
                  <span className="editor-history-item-meta mono">{formatBytes(version.size)}</span>
                </button>
              ))}
            </div>

            <div className="editor-history-detail">
              {diffLoading ? (
                <div className="editor-history-status">
                  <Spinner size={13} label="正在计算差异" />
                  <span className="mono">正在对比差异…</span>
                </div>
              ) : selection && selectedId ? (
                <>
                  <div className="editor-history-diff-head">
                    <span className="mono">
                      对比：{formatArtifactTime(selection.version.createdAt)} → {selection.targetLabel}
                    </span>
                    <span className="mono editor-history-diff-stats">
                      <span className="diff-add-count">+{selection.added}</span>
                      <span className="diff-del-count">-{selection.removed}</span>
                    </span>
                  </div>
                  <div className="editor-history-diff">
                    {selection.patch.trim() ? (
                      <DiffView patch={selection.patch} contextLines={2} maxHeight={340} />
                    ) : (
                      <p className="editor-history-hint">这个版本与当前内容没有差异。</p>
                    )}
                  </div>
                  <div className="editor-history-restore">
                    {confirming ? (
                      <div className="editor-history-confirm" role="alertdialog" aria-label="确认恢复版本">
                        <span>恢复后当前内容会被覆盖，并记录为一个新版本。</span>
                        {doc.dirty ? (
                          <span className="editor-history-dirty-warning">编辑器里还有未保存的修改，恢复后这些修改会丢失。</span>
                        ) : null}
                        <div className="editor-history-confirm-actions">
                          <button type="button" className="editor-text-btn" onClick={() => setConfirming(false)} disabled={restoring}>
                            取消
                          </button>
                          <button type="button" className="editor-text-btn is-danger" onClick={() => void restore()} disabled={restoring}>
                            {restoring ? '恢复中…' : '确认恢复'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="editor-text-btn"
                        onClick={() => setConfirming(true)}
                        disabled={readOnly || doc.readOnly}
                        title={readOnly ? '当前是只读模式，不能恢复版本' : undefined}
                      >
                        <RotateCcw size={12} strokeWidth={1.7} aria-hidden />
                        恢复到这个版本
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className="editor-history-hint">选择一个版本查看差异。</p>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}


pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl


interface PdfPreviewProps {
  url: string
  title: string
}


export function PdfPreview({ url, title }: PdfPreviewProps): React.JSX.Element {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageDraft, setPageDraft] = useState('1')
  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [containerWidth, setContainerWidth] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [pageImage, setPageImage] = useState<string | null>(null)
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = document.documentElement
    const update = (): void => setTheme(root.dataset.theme === 'light' ? 'light' : 'dark')
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const update = (): void => setContainerWidth(element.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    let task: pdfjsLib.PDFDocumentLoadingTask | null = null
    setLoading(true)
    setError(null)
    setPdf(null)
    setNumPages(0)
    setPageNumber(1)
    try {
      task = pdfjsLib.getDocument({ url, useSystemFonts: true })
      task.promise
        .then((document) => {
          if (cancelled) return
          setPdf(document)
          setNumPages(document.numPages)
          setLoading(false)
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          setError(errorText(reason))
          setLoading(false)
        })
    } catch (reason) {
      setError(errorText(reason))
      setLoading(false)
    }
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [url, reloadKey])

  useEffect(() => {
    if (!pdf || !canvasRef.current || containerWidth <= 0) return undefined
    let cancelled = false
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy['render']> | null = null

    setPageImage(null)
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled || !canvasRef.current) return
        const base = page.getViewport({ scale: 1 })
        // 页面两侧 padding 24×2 + 1px 边框，预留 52px 避免出现 1px 横向滚动条。
        const fitScale = Math.max(0.2, (containerWidth - 52) / base.width)
        const viewport = page.getViewport({ scale: fitScale * zoom })
        const canvas = canvasRef.current
        const outputScale = window.devicePixelRatio || 1
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        setPageSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) })
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建 PDF 画布。')
        renderTask = page.render({
          canvasContext: context,
          canvas,
          viewport,
          ...(outputScale !== 1 ? { transform: [outputScale, 0, 0, outputScale, 0, 0] } : {})
        })
        await renderTask.promise
        if (!cancelled && theme === 'dark') {
          // 深色主题下直接反相画布像素；CSS filter 在部分合成层截图中不生效。
          context.save()
          context.globalCompositeOperation = 'difference'
          context.fillStyle = '#fff'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.restore()
        }
        if (!cancelled) setPageImage(canvas.toDataURL('image/png'))
      } catch (reason) {
        if (cancelled) return
        const name = (reason as { name?: string } | null)?.name
        if (name === 'RenderingCancelledException') return
        setError(errorText(reason))
      }
    })()

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pdf, pageNumber, zoom, containerWidth, theme])

  useEffect(() => {
    setPageDraft(String(pageNumber))
  }, [pageNumber])

  const clampPage = (next: number): number => Math.min(Math.max(1, next), Math.max(1, numPages))
  const setPage = (next: number): void => {
    setPageNumber(clampPage(next))
  }
  const commitPageDraft = (): void => {
    const next = Number(pageDraft)
    if (Number.isFinite(next)) setPage(next)
    else setPageDraft(String(pageNumber))
  }

  return (
    <div className="preview-pdf" data-testid="pdf-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">PDF</span>
          {loading ? (
            <span className="preview-meta mono" data-testid="pdf-page-count">正在读取…</span>
          ) : error ? (
            <span className="preview-meta mono" data-testid="pdf-page-count">读取失败</span>
          ) : (
            <span className="preview-pdf-pagenav">
              <span className="preview-meta mono">第</span>
              <input
                className="preview-pdf-pageinput mono"
                type="number"
                min={1}
                max={Math.max(1, numPages)}
                value={pageDraft}
                aria-label="跳到页码"
                onChange={(event) => {
                  if (/^\d*$/.test(event.target.value)) setPageDraft(event.target.value)
                }}
                onBlur={commitPageDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitPageDraft()
                  } else if (event.key === 'Escape') {
                    setPageDraft(String(pageNumber))
                  }
                }}
              />
              <span className="preview-meta mono" data-testid="pdf-total-pages">/ {numPages} 页</span>
            </span>
          )}
        </div>
        <div className="preview-toolbar-right">
          <IconButton label="上一页" size={26} disabled={loading || !!error || pageNumber <= 1} onClick={() => setPage(pageNumber - 1)}>
            <ChevronLeft size={14} strokeWidth={1.7} />
          </IconButton>
          <IconButton
            label="下一页"
            size={26}
            disabled={loading || !!error || pageNumber >= numPages}
            onClick={() => setPage(pageNumber + 1)}
          >
            <ChevronRight size={14} strokeWidth={1.7} />
          </IconButton>
          <span className="preview-toolbar-sep" aria-hidden />
          <IconButton label="缩小" size={26} disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}>
            <Minus size={13} strokeWidth={1.7} />
          </IconButton>
          <span className="preview-zoom mono">{Math.round(zoom * 100)}%</span>
          <IconButton label="放大" size={26} disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))}>
            <Plus size={13} strokeWidth={1.7} />
          </IconButton>
          <IconButton label="适应宽度" size={26} active={zoom === 1} onClick={() => setZoom(1)}>
            <ScanLine size={13} strokeWidth={1.7} />
          </IconButton>
          <IconButton label="重新加载 PDF" size={26} onClick={() => setReloadKey((value) => value + 1)}>
            <RotateCcw size={13} strokeWidth={1.7} />
          </IconButton>
        </div>
      </div>

      <div className="preview-pdf-stage" ref={containerRef} aria-label={`${title} PDF 预览`}>
        {loading ? (
          <div className="preview-state" role="status">
            <span className="preview-skeleton-line" aria-hidden />
            <span className="mono">正在渲染 PDF…</span>
          </div>
        ) : error ? (
          <div className="preview-state preview-state-error" role="alert">
            <p className="preview-state-title">这个 PDF 打不开</p>
            <p className="preview-state-detail">{error}</p>
            <button type="button" className="preview-retry" onClick={() => setReloadKey((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : (
          <div className="preview-pdf-page" data-testid="pdf-canvas-wrap">
            <canvas ref={canvasRef} className="preview-pdf-canvas" aria-hidden style={{ display: 'none' }} />
            {pageImage ? (
              <img
                className="preview-pdf-image"
                src={pageImage}
                alt={`${title} 第 ${pageNumber} 页`}
                width={pageSize.width || undefined}
                height={pageSize.height || undefined}
                draggable={false}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

function KindIcon({ kind, size = 16 }: { kind: EditorDocument['previewKind']; size?: number }): React.JSX.Element {
  if (kind === 'image') return <FileImage size={size} strokeWidth={1.5} aria-hidden />
  if (kind === 'audio') return <FileAudio size={size} strokeWidth={1.5} aria-hidden />
  if (kind === 'video') return <FileVideo size={size} strokeWidth={1.5} aria-hidden />
  if (kind === 'docx' || kind === 'pdf' || kind === 'xlsx' || kind === 'pptx' || kind === 'document' || kind === 'archive') {
    return <FileText size={size} strokeWidth={1.5} aria-hidden />
  }
  return <FileQuestion size={size} strokeWidth={1.5} aria-hidden />
}

export interface FilePreviewPaneProps {
  doc: EditorDocument
  theme: 'dark' | 'light'
  onOpenExternal: () => void
  onReveal: () => void
  onRetry: () => void
}

function StateShell({
  title,
  detail,
  onRetry,
  onOpenExternal
}: {
  title: string
  detail?: string
  onRetry: () => void
  onOpenExternal: () => void
}): React.JSX.Element {
  return (
    <div className="preview-state preview-state-error" role="alert">
      <p className="preview-state-title">{title}</p>
      {detail ? <p className="preview-state-detail">{detail}</p> : null}
      <div className="preview-state-actions">
        <button type="button" className="preview-action is-primary" onClick={onRetry}>
          <RotateCcw size={12} strokeWidth={1.7} aria-hidden />
          重新加载
        </button>
        <button type="button" className="preview-action" onClick={onOpenExternal}>
          <ExternalLink size={12} strokeWidth={1.7} aria-hidden />
          用系统应用打开
        </button>
      </div>
    </div>
  )
}

function fileTypeLabel(doc: EditorDocument): string {
  const ext = (doc.relPath || doc.title).split('.').pop()?.toUpperCase() ?? ''
  if (doc.previewKind === 'docx') return 'DOCX'
  if (doc.previewKind === 'xlsx') return 'Excel'
  if (doc.previewKind === 'pptx') return 'PowerPoint'
  if (doc.previewKind === 'document') return ext || '文档'
  if (doc.previewKind === 'archive') return ext ? `${ext} 压缩包` : '压缩包'
  if (doc.previewKind === 'pdf') return 'PDF'
  if (doc.previewKind === 'image') return ext || '图片'
  if (doc.previewKind === 'audio') return ext ? `${ext} 音频` : '音频'
  if (doc.previewKind === 'video') return ext ? `${ext} 视频` : '视频'
  return ext ? `${ext} 文件` : '文件'
}

function MetaLine({ doc }: { doc: EditorDocument }): React.JSX.Element {
  const meta = [fileTypeLabel(doc), typeof doc.size === 'number' ? formatBytes(doc.size) : ''].filter(Boolean).join(' · ')
  return <span className="preview-meta mono">{meta}</span>
}

function ImagePreview({ doc, onOpenExternal, onRetry }: Omit<FilePreviewPaneProps, 'theme' | 'onReveal'>): React.JSX.Element {
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  if (!doc.previewUrl) {
    return <StateShell title="图片地址不可用" detail="预览链接已失效，请重新加载。" onRetry={onRetry} onOpenExternal={onOpenExternal} />
  }

  return (
    <div className="preview-media-pane" data-testid="image-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">图片</span>
          <MetaLine doc={doc} />
          {dimensions ? (
            <span className="preview-meta mono">
              {dimensions.width} × {dimensions.height}
            </span>
          ) : null}
        </div>
        <div className="preview-toolbar-right">
          <IconButton label="缩小图片" size={26} disabled={zoom <= 0.5} onClick={() => {
            setFit(false)
            setZoom((value) => Math.max(0.5, value - 0.1))
          }}>
            <Minus size={13} strokeWidth={1.7} />
          </IconButton>
          <span className="preview-zoom mono">{fit ? '适应' : `${Math.round(zoom * 100)}%`}</span>
          <IconButton label="放大图片" size={26} disabled={zoom >= 3} onClick={() => {
            setFit(false)
            setZoom((value) => Math.min(3, value + 0.1))
          }}>
            <Plus size={13} strokeWidth={1.7} />
          </IconButton>
          <IconButton label="适应窗口" size={26} active={fit} onClick={() => setFit(true)}>
            <ScanLine size={13} strokeWidth={1.7} />
          </IconButton>
        </div>
      </div>
      <div className={['preview-image-stage', fit ? 'is-fit' : 'is-zoomed'].join(' ')}>
        {failed ? (
          <StateShell title="这张图片打不开" detail="文件可能已损坏，或格式不受支持。" onRetry={onRetry} onOpenExternal={onOpenExternal} />
        ) : (
          <img
            className="preview-image"
            src={doc.previewUrl}
            alt={doc.title}
            title={doc.title}
            style={fit ? undefined : { width: `${zoom * 100}%` }}
            onLoad={(event) => {
              const image = event.currentTarget
              setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  )
}

function AudioPreview({ doc, onOpenExternal, onRetry }: Omit<FilePreviewPaneProps, 'theme' | 'onReveal'>): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!doc.previewUrl) {
    return <StateShell title="音频地址不可用" detail="预览链接已失效，请重新加载。" onRetry={onRetry} onOpenExternal={onOpenExternal} />
  }
  return (
    <div className="preview-media-pane" data-testid="audio-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">音频</span>
          <MetaLine doc={doc} />
        </div>
      </div>
      <div className="preview-audio-stage">
        <div className="preview-audio-card">
          <span className="preview-audio-icon" aria-hidden>
            <FileAudio size={26} strokeWidth={1.3} />
          </span>
          <p className="preview-audio-title">{doc.title}</p>
          <audio
            className="preview-audio"
            controls
            preload="metadata"
            src={doc.previewUrl}
            onError={() => setFailed(true)}
          />
          {failed ? (
            <p className="preview-media-error" role="alert">
              当前系统无法播放这个音频编码，可以
              <button type="button" onClick={onRetry}>重新加载</button>
              或
              <button type="button" onClick={onOpenExternal}>用系统应用打开</button>
              。
            </p>
          ) : (
            <p className="preview-media-hint mono">支持拖动进度、调节音量；大文件按需加载。</p>
          )}
        </div>
      </div>
    </div>
  )
}

function VideoPreview({ doc, onOpenExternal, onRetry }: Omit<FilePreviewPaneProps, 'theme' | 'onReveal'>): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!doc.previewUrl) {
    return <StateShell title="视频地址不可用" detail="预览链接已失效，请重新加载。" onRetry={onRetry} onOpenExternal={onOpenExternal} />
  }
  return (
    <div className="preview-media-pane" data-testid="video-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">视频</span>
          <MetaLine doc={doc} />
        </div>
      </div>
      <div className="preview-video-stage">
        {failed ? (
          <div className="preview-video-fallback" role="alert">
            <FileVideo size={28} strokeWidth={1.3} aria-hidden />
            <p>当前系统无法播放这个视频编码。</p>
            <div className="preview-state-actions">
              <button type="button" className="preview-action" onClick={onRetry}>
                <RotateCcw size={12} strokeWidth={1.7} aria-hidden />
                重新加载
              </button>
              <button type="button" className="preview-action" onClick={onOpenExternal}>
                <ExternalLink size={12} strokeWidth={1.7} aria-hidden />
                用系统应用打开
              </button>
            </div>
          </div>
        ) : (
          <video
            className="preview-video"
            controls
            playsInline
            preload="metadata"
            src={doc.previewUrl}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  )
}

function FilePreviewPaneEscapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function docxDocument(html: string, title: string, theme: 'dark' | 'light'): string {
  const t = documentPageTheme()
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base target="_blank">
<title>${FilePreviewPaneEscapeHtml(title)}</title>
<style>
  :root { color-scheme: ${theme}; }
  html, body { margin: 0; padding: 0; background: ${t.shell}; color: ${t.ink}; }
  body { padding: 24px 18px 40px; font-family: "Newsreader", "Noto Serif SC", "Songti SC", Georgia, serif; }
  .docx-page { box-sizing: border-box; max-width: 820px; margin: 0 auto; padding: clamp(22px, 5vw, 54px); background: ${t.page}; border: 1px solid ${t.border}; box-shadow: 0 18px 50px rgba(0, 0, 0, .18); font-size: 14.5px; line-height: 1.78; overflow-wrap: anywhere; }
  .docx-page p { margin: 0 0 .8em; }
  .docx-page p:last-child { margin-bottom: 0; }
  h1, h2, h3, h4 { margin: 1.1em 0 .55em; line-height: 1.35; font-weight: 600; }
  h1 { font-size: 1.75em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
  table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: .92em; }
  td, th { padding: 6px 9px; border: 1px solid ${t.table}; vertical-align: top; }
  th { background: ${t.tableHead}; text-align: left; }
  img { max-width: 100%; height: auto; }
  a { color: ${t.accent}; text-decoration: underline; text-underline-offset: 2px; }
  ul, ol { margin: .6em 0 .9em; padding-left: 1.5em; }
  blockquote { margin: 1em 0; padding: .3em 0 .3em 1em; border-left: 3px solid ${t.accent}; color: ${t.quote}; }
  hr { border: 0; border-top: 1px solid ${t.border}; margin: 1.5em 0; }
  .docx-empty { color: ${t.muted}; font-style: normal; }
</style></head>
<body><main class="docx-page">${html || '<p class="docx-empty">这个文档没有可显示的正文。</p>'}</main></body></html>`
}

function DocxPreview({ doc, theme }: { doc: EditorDocument; theme: 'dark' | 'light' }): React.JSX.Element {
  const documentHtml = useMemo(() => docxDocument(doc.content, doc.title, theme), [doc.content, doc.title, theme])
  return (
    <div className="preview-docx-pane" data-testid="docx-preview">
      <div className="preview-toolbar">
        <div className="preview-toolbar-left">
          <span className="preview-kind mono">Word</span>
          <MetaLine doc={doc} />
          <span className="preview-readonly mono">只读预览</span>
        </div>
      </div>
      {doc.previewNote ? <p className="preview-note">{doc.previewNote}</p> : null}
      <div className="preview-docx-stage">
        <iframe
          className="preview-docx-frame"
          title={`${doc.title} 预览`}
          sandbox="allow-popups"
          srcDoc={withMorrowScrollbar(documentHtml)}
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  )
}

function UnsupportedPreview({
  doc,
  onOpenExternal,
  onReveal,
  onRetry
}: Omit<FilePreviewPaneProps, 'theme'>): React.JSX.Element {
  return (
    <div className="preview-unsupported" data-testid="unsupported-preview">
      <div className="preview-unsupported-card">
        <span className="preview-unsupported-icon" aria-hidden>
          <KindIcon kind={doc.previewKind} size={26} />
        </span>
        <p className="preview-unsupported-title">{doc.title}</p>
        <MetaLine doc={doc} />
        <p className="preview-unsupported-detail">
          {doc.previewNote ?? '这种文件格式暂不支持在 Morrow 内预览。'}
        </p>
        <div className="preview-state-actions">
          <button type="button" className="preview-action is-primary" onClick={onOpenExternal}>
            <ExternalLink size={12} strokeWidth={1.7} aria-hidden />
            用系统应用打开
          </button>
          <button type="button" className="preview-action" onClick={onReveal}>
            <FolderOpen size={12} strokeWidth={1.7} aria-hidden />
            在文件夹中显示
          </button>
          <button type="button" className="preview-action" onClick={onRetry}>
            <RotateCcw size={12} strokeWidth={1.7} aria-hidden />
            重新加载
          </button>
        </div>
      </div>
    </div>
  )
}

export function FilePreviewPane({ doc, theme, onOpenExternal, onReveal, onRetry }: FilePreviewPaneProps): React.JSX.Element {
  if (doc.loading) {
    return (
      <div className="preview-media-pane">
        <div className="preview-state" role="status">
          <span className="preview-skeleton-line" aria-hidden />
          <span className="mono">正在准备预览…</span>
        </div>
      </div>
    )
  }
  if (doc.error) {
    return (
      <div className="preview-media-pane">
        <StateShell title="这个文件打不开" detail={doc.error} onRetry={onRetry} onOpenExternal={onOpenExternal} />
      </div>
    )
  }
  switch (doc.previewKind) {
    case 'image':
      return <ImagePreview doc={doc} onOpenExternal={onOpenExternal} onRetry={onRetry} />
    case 'pdf':
      return doc.previewUrl ? (
        <PdfPreview url={doc.previewUrl} title={doc.title} />
      ) : (
        <div className="preview-media-pane">
          <StateShell title="PDF 地址不可用" detail="预览链接已失效，请重新加载。" onRetry={onRetry} onOpenExternal={onOpenExternal} />
        </div>
      )
    case 'docx':
      return <DocxPreview doc={doc} theme={theme} />
    case 'xlsx':
      return <XlsxPreview doc={doc} />
    case 'pptx':
      return <PptxPreview doc={doc} />
    case 'document':
      return <DocumentPreview doc={doc} theme={theme} />
    case 'archive':
      return <ArchivePreview doc={doc} />
    case 'audio':
      return <AudioPreview doc={doc} onOpenExternal={onOpenExternal} onRetry={onRetry} />
    case 'video':
      return <VideoPreview doc={doc} onOpenExternal={onOpenExternal} onRetry={onRetry} />
    default:
      return <UnsupportedPreview doc={doc} onOpenExternal={onOpenExternal} onReveal={onReveal} onRetry={onRetry} />
  }
}

const EMPTY_ARTIFACTS: Artifact[] = []

const KIND_LABEL: Record<ArtifactKind, string> = {
  html: '网页',
  markdown: '文档',
  code: '代码',
  svg: '图形',
  text: '文本',
  file: '文件'
}

const EXT_KIND: Record<string, ArtifactKind> = {
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  svg: 'svg',
  txt: 'text',
  log: 'text',
  csv: 'text',
  json: 'code',
  js: 'code',
  mjs: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  css: 'code',
  sh: 'code',
  yml: 'code',
  yaml: 'code'
}

const EXT_LANG: Record<string, string> = {
  json: 'json',
  js: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  css: 'css',
  sh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  md: 'markdown'
}

function extensionOf(path: string | undefined): string | null {
  if (!path) return null
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return base.slice(dot + 1).toLowerCase()
}

function resolveKind(artifact: Artifact): ArtifactKind {
  if (artifact.kind !== 'file') return artifact.kind
  const ext = extensionOf(artifact.path)
  return (ext && EXT_KIND[ext]) || 'text'
}

/**
 * 二进制截图/PDF/Office/音视频成品应走只读文件预览，而不是按 UTF-8 文本读进画布。
 * HTML/Markdown/SVG/代码成品的声明类型优先。
 */
function previewableArtifactKind(artifact: Artifact): Exclude<FilePreviewKind, 'text'> | null {
  if (!artifact.path) return null
  if (artifact.kind === 'html' || artifact.kind === 'markdown' || artifact.kind === 'svg' || artifact.kind === 'code') {
    return null
  }
  const kind = previewKindForFileName(artifact.path)
  return kind === 'text' ? null : kind
}

function FileGlyph({ kind, size = 13 }: { kind: ArtifactKind; size?: number }): React.JSX.Element {
  if (kind === 'svg') return <ImageIcon size={size} strokeWidth={1.5} aria-hidden />
  if (kind === 'markdown' || kind === 'text') return <FileText size={size} strokeWidth={1.5} aria-hidden />
  return <FileCode2 size={size} strokeWidth={1.5} aria-hidden />
}

const PREVIEW_KIND_LABEL: Record<Exclude<EditorDocument['previewKind'], 'text'>, string> = {
  image: '图片',
  pdf: 'PDF',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PowerPoint',
  document: '文档',
  archive: '压缩包',
  audio: '音频',
  video: '视频',
  unsupported: '文件'
}

function previewGlyph(doc: EditorDocument, size = 13): React.JSX.Element {
  switch (doc.previewKind) {
    case 'image':
      return <ImageIcon size={size} strokeWidth={1.5} aria-hidden />
    case 'audio':
      return <FileAudio size={size} strokeWidth={1.5} aria-hidden />
    case 'video':
      return <FileVideo size={size} strokeWidth={1.5} aria-hidden />
    case 'unsupported':
      return <FileQuestion size={size} strokeWidth={1.5} aria-hidden />
    default:
      return <FileText size={size} strokeWidth={1.5} aria-hidden />
  }
}

function documentKicker(doc: EditorDocument): string {
  const kind = doc.previewKind === 'text' ? languageLabel(doc.language) : PREVIEW_KIND_LABEL[doc.previewKind]
  const parts = [kind]
  if (doc.relPath) parts.push(doc.relPath)
  if (doc.previewKind !== 'text') parts.push('只读预览')
  if (doc.conflict) parts.push('外部修改冲突')
  return parts.join(' · ')
}

function formatClock(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

/** 窄窗口（<1200px）画布切换为覆盖式抽屉，此时隐藏拖拽手柄 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 1200px)').matches
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia('(max-width: 1200px)')
    const onChange = (): void => setNarrow(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * 画布：右侧抽屉，预览 HTML / Markdown / 代码 / SVG / 文本成品。
 * HTML 一律走 `sandbox="allow-scripts allow-forms"` 的无同源 iframe，报告可交互但拿不到宿主数据。
 */
export function Canvas(): React.JSX.Element | null {
  const canvas = useAppStore((s) => s.canvas)
  const session = useAppStore((s) => s.session)
  const artifacts = useAppStore((s) => s.session?.artifacts ?? EMPTY_ARTIFACTS)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const revealArtifact = useAppStore((s) => s.revealArtifact)
  const saveArtifactToWorkspace = useAppStore((s) => s.saveArtifactToWorkspace)
  const openArtifactExternal = useAppStore((s) => s.openArtifactExternal)
  const copyText = useAppStore((s) => s.copyText)
  const canvasWidth = useAppStore((s) => s.canvasWidth)
  const viewportWidth = useViewportWidth()
  const displayCanvasWidth = responsiveCanvasWidth(canvasWidth, viewportWidth)
  const setCanvasWidth = useAppStore((s) => s.setCanvasWidth)
  const narrow = useNarrowViewport()
  const editor = useEditorDocs()

  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  /**
   * iframe 挂载时机：Chromium 在抽屉 transform 动画期间、或成品切换的同一帧里创建的沙箱 iframe
   * 可能不绘制首帧。统一延迟 360ms（动画 320ms 后）再挂载，宁可见一瞬占位也不见空白。
   */
  const [drawerSettled, setDrawerSettled] = useState(false)
  const [htmlReady, setHtmlReady] = useState(false)
  const rootRef = useRef<HTMLElement>(null)
  const [closedArtifacts, setClosedArtifacts] = useState<Set<string>>(new Set())
  const [artifactOrder, setArtifactOrder] = useState<string[]>([])
  const [docOrder, setDocOrder] = useState<string[]>([])
  const [dragKey, setDragKey] = useState<string | null>(null)

  const sessionId = session?.id ?? null
  useEffect(() => {
    setClosedArtifacts(new Set())
    setArtifactOrder([])
    setDocOrder([])
    setDragKey(null)
  }, [sessionId])

  useEffect(() => {
    setArtifactOrder((prev) => {
      const ids = artifacts.map((artifact) => artifact.id)
      const kept = prev.filter((id) => ids.includes(id))
      return [...kept, ...ids.filter((id) => !kept.includes(id))]
    })
    // 从对话或空态重新打开一个已关闭的成品时，重新显示页签。
    if (canvas.artifactId) {
      setClosedArtifacts((prev) => {
        if (!prev.has(canvas.artifactId!)) return prev
        const next = new Set(prev)
        next.delete(canvas.artifactId!)
        return next
      })
    }
  }, [artifacts, canvas.artifactId])

  useEffect(() => {
    const ids = editor.docs.map((doc) => doc.id)
    setDocOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id))
      return [...kept, ...ids.filter((id) => !kept.includes(id))]
    })
  }, [editor.docs])

  useEffect(() => {
    if (!canvas.open) {
      setDrawerSettled(false)
      return undefined
    }
    setDrawerSettled(false)
    const timer = window.setTimeout(() => setDrawerSettled(true), 360)
    return () => window.clearTimeout(timer)
  }, [canvas.open])

  /**
   * 选中规则：canvas.artifactId 为 null 表示「画布打开但没有选中成品」→ 展示空态与最近成品列表；
   * 仅当 id 指向已被移除的成品时才回退到最后一个成品，避免空白。
   */
  const active = canvas.artifactId
    ? artifacts.find((artifact) => artifact.id === canvas.artifactId) ?? artifacts[artifacts.length - 1] ?? null
    : null
  const activeId = active?.id ?? null

  /* 切换成品或关闭画布时收起弹窗，避免下次打开画布时残留上一个成品的弹窗 */
  useEffect(() => {
    setVersionsOpen(false)
    setExportOpen(false)
  }, [canvas.open, activeId])
  const versionable = Boolean(active && active.kind !== 'file' && !session?.temporary)
  const activePath = active?.path ?? null
  const inlineContent = active?.content ?? null
  const activeUpdatedAt = active?.updatedAt ?? 0
  const previewKind = active ? previewableArtifactKind(active) : null

  const openPreviewableArtifact = useCallback(
    (artifact: Artifact): void => {
      if (!previewableArtifactKind(artifact)) return
      const path = artifact.path
      if (!path) return
      const rel = editor.workspace ? relativeToWorkspace(editor.workspace, path) : null
      if (rel === null) return
      void editor.openPath(rel, path)
    },
    [editor.openPath, editor.workspace]
  )

  useEffect(() => {
    setHtmlReady(false)
    if (!canvas.open || !activeId) return undefined
    // 抽屉刚滑入时等动画结束（360ms）；同一次打开内切换成品只需一帧左右的缓冲
    const delay = drawerSettled ? 90 : 360
    const timer = window.setTimeout(() => setHtmlReady(true), delay)
    return () => window.clearTimeout(timer)
  }, [canvas.open, activeId, activeUpdatedAt, drawerSettled])

  /* 读取内容：内联直接可用；文件型走 IPC，成品更新时重新读取 */
  useEffect(() => {
    let cancelled = false
    setError(null)
    setTruncated(false)
    if (!active) {
      setContent(null)
      setLoading(false)
      return
    }
    // 图片/PDF/Office/音视频走只读文件预览，不能按文本读取
    if (previewableArtifactKind(active)) {
      setContent(null)
      setLoading(false)
      return
    }
    if (inlineContent !== null) {
      setContent(inlineContent)
      setLoading(false)
      return
    }
    if (activePath) {
      setLoading(true)
      setContent(null)
      window.morrow.artifacts
        .read(activePath)
        .then((result) => {
          if (cancelled) return
          if (result.ok) {
            setContent(result.data.content)
            setTruncated(result.data.truncated === true)
            setError(null)
          } else {
            setError(result.error.message)
          }
          setLoading(false)
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          setError(reason instanceof Error ? reason.message : '读取成品失败')
          setLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    setContent(null)
    setLoading(false)
    return () => {
      cancelled = true
    }
    // active 的引用每次渲染都会变，依赖用原始字段
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activePath, inlineContent, activeUpdatedAt, reloadKey])

  /* 选中二进制成品时自动打开只读预览（图片截图/PDF/Office/音视频） */
  useEffect(() => {
    if (!active) return
    openPreviewableArtifact(active)
  }, [activeId, activePath, activeUpdatedAt, openPreviewableArtifact])

  /* 全屏时 Esc 退出 */
  useEffect(() => {
    if (!fullscreen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!rootRef.current?.contains(document.activeElement)) return
      event.preventDefault()
      setFullscreen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [fullscreen])

  /* 窗口变窄时把画布宽度收回可视范围并持久化，避免对话列被挤到无法输入 */
  useEffect(() => {
    if (!canvas.open) return undefined
    const clampToWindow = (): void => {
      const state = useAppStore.getState()
      const maxVisible =
        window.innerWidth <= 1200
          ? Math.min(960, Math.round(window.innerWidth * 0.68))
          : maxCanvasWidthForViewport(state.sidebarWidth, state.sidebarCollapsed)
      if (state.canvasWidth > maxVisible) setCanvasWidth(maxVisible, true)
    }
    clampToWindow()
    window.addEventListener('resize', clampToWindow)
    return () => window.removeEventListener('resize', clampToWindow)
  }, [canvas.open, setCanvasWidth])

  if (!canvas.open) return null

  const kind = active ? resolveKind(active) : null
  const language = active ? active.language ?? (extensionOf(active.path) ? EXT_LANG[extensionOf(active.path)!] : null) : null
  const canUsePath = Boolean(active?.path)
  const ext = extensionOf(active?.path)
  const displayKind = kind ?? 'code'

  const openExternal = async (): Promise<void> => {
    if (!active) return
    try {
      // HTML 成品走内置浏览器：外部 Edge 在应用以管理员权限运行时可能弹「现有实例正在以提升的权限运行」。
      if (displayKind === 'html' && content !== null && !truncated) {
        const registered = await window.morrow.artifacts.previewHtml(content)
        if (!registered.ok) {
          useAppStore.getState().notify('error', registered.error.message)
          return
        }
        const opened = await window.morrow.features.invoke('feature:browser:open-preview', {
          url: registered.data.url
        })
        if (!opened.ok) useAppStore.getState().notify('error', opened.error.message)
        return
      }
      if (active.path) await openArtifactExternal(active.path)
    } catch (err) {
      useAppStore.getState().notify('error', err instanceof Error ? err.message : '打开成品失败')
    }
  }
  const reveal = (): void => {
    if (active?.path) void revealArtifact(active.path)
  }
  const saveToWorkspace = (): void => {
    if (active && session?.id) void saveArtifactToWorkspace(session.id, active.id)
  }
  const copyContent = (): void => {
    if (content) void copyText(content)
  }

  const activeDoc = editor.activeDoc
  const dirtyCount = editor.docs.filter((doc) => doc.dirty).length
  const closeDialogDocId = editor.dialog?.kind === 'close-doc' ? editor.dialog.docId : null
  const closeDocTarget = closeDialogDocId ? editor.docs.find((doc) => doc.id === closeDialogDocId) ?? null : null
  const canEditArtifact =
    Boolean(active?.path) &&
    content !== null &&
    !loading &&
    !error &&
    Boolean(active && ['code', 'markdown', 'html', 'text'].includes(displayKind))
  const visibleArtifacts = artifacts.filter((artifact) => !closedArtifacts.has(artifact.id))
  const artifactRank = new Map(artifactOrder.map((id, index) => [id, index]))
  const orderedArtifacts = [...visibleArtifacts].sort(
    (a, b) => (artifactRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (artifactRank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  )
  const docRank = new Map(docOrder.map((id, index) => [id, index]))
  const orderedDocs = [...editor.docs].sort(
    (a, b) => (docRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (docRank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  )
  const tabsVisible = visibleArtifacts.length > 0 || editor.docs.length > 0

  const moveTab = (from: string, to: string, ids: string[], setIds: (next: string[]) => void): void => {
    if (from === to) return
    const current = [...ids]
    const fromIndex = current.indexOf(from)
    const toIndex = current.indexOf(to)
    if (fromIndex < 0 || toIndex < 0) return
    current.splice(fromIndex, 1)
    current.splice(toIndex, 0, from)
    setIds(current)
  }

  const closeArtifactTab = (id: string): void => {
    const index = orderedArtifacts.findIndex((artifact) => artifact.id === id)
    const next = orderedArtifacts[index + 1] ?? orderedArtifacts[index - 1] ?? null
    setClosedArtifacts((prev) => new Set(prev).add(id))
    if (canvas.artifactId !== id) return
    if (next) openCanvas(next.id)
    else if (orderedDocs[0]) editor.selectDoc(orderedDocs[0].id)
    // 关闭最后一个页签时保留画布，只清空选中；否则画布会整体收起，重新打开时页签又“复活”。
    else useAppStore.setState({ canvas: { open: true, artifactId: null } })
  }

  const dialogTitle = !editor.dialog
    ? ''
    : editor.dialog.kind === 'close-doc'
      ? '关闭未保存的文件？'
      : editor.dialog.kind === 'close-canvas'
        ? '有未保存的修改'
        : '另存为'
  const dialogFooter = (
    <div className="editor-dialog-actions">
      {editor.dialog?.kind === 'save-as' ? (
        <>
          <Button variant="ghost" onClick={editor.closeDialog} disabled={editor.dialogBusy}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void editor.submitSaveAs()}
            disabled={editor.dialogBusy || !editor.saveAsDraft.trim()}
          >
            {editor.dialogBusy ? '正在保存…' : '保存副本'}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={editor.closeDialog} disabled={editor.dialogBusy}>
            取消
          </Button>
          <Button variant="danger" onClick={editor.dialogDiscardAndContinue} disabled={editor.dialogBusy}>
            不保存
          </Button>
          <Button variant="primary" onClick={() => void editor.dialogSaveAndContinue()} disabled={editor.dialogBusy}>
            {editor.dialogBusy ? '正在保存…' : editor.dialog?.kind === 'close-canvas' ? '保存全部并关闭' : '保存并关闭'}
          </Button>
        </>
      )}
    </div>
  )

  return (
    <>
      {!fullscreen && !narrow ? (
        <ResizeHandle
          edge="left"
          value={displayCanvasWidth}
          min={320}
          max={960}
          label="拖动调整画布宽度（方向键微调，双击恢复默认）"
          onChange={(width) => setCanvasWidth(width)}
          onCommit={(width) => setCanvasWidth(width, true)}
          onReset={() => setCanvasWidth(420, true)}
          className="canvas-resizer"
        />
      ) : null}
      <aside
        className={[
          'canvas-root',
          !active && !activeDoc ? 'is-empty' : '',
          activeDoc ? 'has-editor' : '',
          fullscreen ? 'is-fullscreen' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label="画布"
        ref={rootRef}
        style={!fullscreen && !narrow ? { width: displayCanvasWidth } : undefined}
      >
        <header
          className={['canvas-head', !active && !activeDoc ? 'is-empty' : ''].filter(Boolean).join(' ')}
        >
          {activeDoc ? (
            <div className="canvas-head-main">
              <span className="canvas-head-icon" aria-hidden>
                {previewGlyph(activeDoc, 15)}
              </span>
              <div className="canvas-head-copy">
                <span className="canvas-head-title" title={activeDoc.relPath || activeDoc.title}>
                  {activeDoc.title}
                  {activeDoc.dirty ? <span className="canvas-head-dirty" aria-label="有未保存的修改" /> : null}
                </span>
                <span className="canvas-head-kicker mono">{documentKicker(activeDoc)}</span>
              </div>
            </div>
          ) : active ? (
            <div className="canvas-head-main">
              <span className="canvas-head-icon" aria-hidden>
                <FileGlyph kind={displayKind} size={15} />
              </span>
              <div className="canvas-head-copy">
                <span className="canvas-head-title" title={active.title}>
                  {active.title}
                </span>
                <span className="canvas-head-kicker mono">
                  {KIND_LABEL[displayKind]}
                  {active.updatedAt ? ` · ${formatClock(active.updatedAt)} 更新` : ''}
                </span>
              </div>
            </div>
          ) : null}

          <div className="canvas-actions" aria-label="画布操作">
            {activeDoc ? (
              <>
                {activeDoc.previewKind !== 'text' ? (
                  <>
                    <IconButton
                      label="用系统应用打开"
                      size={26}
                      onClick={() => void openArtifactExternal(activeDoc.absPath)}
                    >
                      <ExternalLink size={13} strokeWidth={1.5} />
                    </IconButton>
                    <IconButton
                      label="在文件夹中显示"
                      size={26}
                      onClick={() => void revealArtifact(activeDoc.absPath)}
                    >
                      <FolderOpen size={13} strokeWidth={1.5} />
                    </IconButton>
                    <span className="canvas-actions-divider" aria-hidden />
                  </>
                ) : null}
                <IconButton
                  label={fullscreen ? '退出全屏' : '全屏查看'}
                  size={26}
                  onClick={() => setFullscreen((value) => !value)}
                  active={fullscreen}
                >
                  {fullscreen ? <Minimize2 size={13} strokeWidth={1.5} /> : <Maximize2 size={13} strokeWidth={1.5} />}
                </IconButton>
              </>
            ) : active ? (
              <>
                {canEditArtifact ? (
                  <>
                    <IconButton
                      label="在编辑器中打开"
                      size={26}
                      onClick={() => {
                        if (active) editor.openArtifact(active, content ?? '')
                      }}
                    >
                      <FilePen size={13} strokeWidth={1.5} />
                    </IconButton>
                    <span className="canvas-actions-divider" aria-hidden />
                  </>
                ) : null}
                <IconButton label="复制内容" size={26} onClick={copyContent} disabled={!content}>
                  <Copy size={13} strokeWidth={1.5} />
                </IconButton>
                {versionable ? (
                  <IconButton label="版本历史" size={26} onClick={() => setVersionsOpen(true)}>
                    <History size={13} strokeWidth={1.5} />
                  </IconButton>
                ) : null}
                <span className="canvas-actions-divider" aria-hidden />
                <IconButton label="导出成品" size={26} onClick={() => setExportOpen(true)}>
                  <Share2 size={13} strokeWidth={1.5} />
                </IconButton>
                <IconButton
                  label={displayKind === 'html' ? '在内置浏览器中预览' : '在浏览器中打开'}
                  size={26}
                  onClick={() => void openExternal()}
                  disabled={displayKind === 'html' ? !canUsePath && !content : !canUsePath}
                >
                  <ExternalLink size={13} strokeWidth={1.5} />
                </IconButton>
                <IconButton label="在文件夹中显示" size={26} onClick={reveal} disabled={!canUsePath}>
                  <FolderOpen size={13} strokeWidth={1.5} />
                </IconButton>
                {!active.path && content && session?.workspace ? (
                  <IconButton label="保存到文件夹" size={26} onClick={saveToWorkspace}>
                    <FolderDown size={13} strokeWidth={1.5} />
                  </IconButton>
                ) : null}
                <span className="canvas-actions-divider" aria-hidden />
                <IconButton
                  label={fullscreen ? '退出全屏' : '全屏查看'}
                  size={26}
                  onClick={() => setFullscreen((value) => !value)}
                  active={fullscreen}
                >
                  {fullscreen ? <Minimize2 size={13} strokeWidth={1.5} /> : <Maximize2 size={13} strokeWidth={1.5} />}
                </IconButton>
              </>
            ) : null}
            {active || activeDoc ? <span className="canvas-actions-divider" aria-hidden /> : null}
            <IconButton label="关闭画布" size={26} onClick={editor.requestCloseCanvas}>
              <X size={14} strokeWidth={1.5} />
            </IconButton>
          </div>
        </header>

        {tabsVisible ? (
          <div className="canvas-tabs" role="tablist" aria-label="打开的成品与文件">
            {orderedArtifacts.map((artifact) => {
              const tabKind = resolveKind(artifact)
              const preview = previewableArtifactKind(artifact)
              const selected = !activeDoc && artifact.id === active?.id
              const key = `a:${artifact.id}`
              return (
                <div
                  key={artifact.id}
                  className={[
                    'canvas-doc-tab',
                    selected ? 'is-active' : '',
                    dragKey === key ? 'is-dragging' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable
                  onDragStart={() => setDragKey(key)}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragKey?.startsWith('a:')) {
                      moveTab(
                        dragKey.slice(2),
                        artifact.id,
                        orderedArtifacts.map((item) => item.id),
                        setArtifactOrder
                      )
                    }
                    setDragKey(null)
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={['canvas-tab', 'canvas-tab-inner', selected ? 'is-active' : ''].join(' ')}
                    onClick={() => {
                      editor.selectDoc(null)
                      openCanvas(artifact.id)
                      openPreviewableArtifact(artifact)
                    }}
                    title={`${preview ? PREVIEW_KIND_LABEL[preview] : KIND_LABEL[tabKind]} · ${artifact.title}`}
                  >
                    <FileGlyph kind={tabKind} />
                    <span className="canvas-tab-title mono">{artifact.title}</span>
                  </button>
                  <button
                    type="button"
                    className="canvas-tab-close"
                    aria-label={`关闭 ${artifact.title}`}
                    title={`关闭 ${artifact.title}`}
                    onClick={() => closeArtifactTab(artifact.id)}
                  >
                    <X size={10} strokeWidth={1.8} aria-hidden />
                  </button>
                </div>
              )
            })}
            {orderedDocs.map((doc) => {
              const key = `d:${doc.id}`
              return (
                <div
                  key={doc.id}
                  className={[
                    'canvas-doc-tab',
                    activeDoc?.id === doc.id ? 'is-active' : '',
                    dragKey === key ? 'is-dragging' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable
                  onDragStart={() => setDragKey(key)}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragKey?.startsWith('d:')) {
                      moveTab(
                        dragKey.slice(2),
                        doc.id,
                        orderedDocs.map((item) => item.id),
                        setDocOrder
                      )
                    }
                    setDragKey(null)
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeDoc?.id === doc.id}
                    className={['canvas-tab', 'canvas-tab-inner', activeDoc?.id === doc.id ? 'is-active' : ''].join(' ')}
                    onClick={() => editor.selectDoc(doc.id)}
                    title={doc.relPath || doc.title}
                  >
                    {previewGlyph(doc)}
                    <span className="canvas-tab-title mono">{doc.title}</span>
                    {doc.dirty ? <span className="canvas-tab-dirty" aria-hidden /> : null}
                    {doc.readOnly ? <span className="canvas-tab-readonly mono">只读</span> : null}
                  </button>
                  <button
                    type="button"
                    className="canvas-tab-close"
                    aria-label={`关闭 ${doc.title}`}
                    title={`关闭 ${doc.title}`}
                    onClick={() => editor.requestCloseDoc(doc.id)}
                  >
                    <X size={10} strokeWidth={1.8} aria-hidden />
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}

        <div className="canvas-body">
          {activeDoc ? (
            activeDoc.previewKind === 'text' ? (
              <EditorPane
                key={activeDoc.id}
                doc={activeDoc}
                theme={editor.theme}
                readOnlyMode={editor.readOnlyMode}
                onContentChange={(value) => editor.updateContent(activeDoc.id, value)}
                onSave={() => void editor.saveDoc(activeDoc.id)}
                onForceSave={() => void editor.forceSave(activeDoc.id)}
                onReload={() => void editor.reloadDoc(activeDoc.id)}
                onTogglePreview={() => editor.togglePreview(activeDoc.id)}
                onShowHistory={() => editor.openHistory(activeDoc.id)}
                onRequestSaveAs={() => editor.requestSaveAs(activeDoc.id)}
                onRequestClose={() => editor.requestCloseDoc(activeDoc.id)}
                onCopyPath={() => void copyText(activeDoc.relPath || activeDoc.title)}
              />
            ) : (
              <FilePreviewPane
                key={activeDoc.id}
                doc={activeDoc}
                theme={editor.theme}
                onOpenExternal={() => void openArtifactExternal(activeDoc.absPath)}
                onReveal={() => void revealArtifact(activeDoc.absPath)}
                onRetry={() => void editor.reloadDoc(activeDoc.id)}
              />
            )
          ) : !active ? (
            <CanvasEmpty artifacts={artifacts} onOpen={(id) => openCanvas(id)} />
          ) : loading ? (
            <div className="canvas-status">
              <span className="canvas-status-icon" aria-hidden>
                <FileGlyph kind={displayKind} size={18} />
              </span>
              <span className="canvas-status-line" aria-hidden />
              <span className="mono">正在读取 {active?.title ?? '成品'}…</span>
            </div>
          ) : error ? (
            <div className="canvas-status canvas-status-error">
              <ErrorNote
                title="这个成品打不开了"
                detail={`${error}。文件可能被移动或删除，可以让 Morrow 重新生成一份。`}
                action={
                  <button type="button" className="canvas-retry" onClick={() => setReloadKey((key) => key + 1)}>
                    重新读取
                  </button>
                }
              />
            </div>
          ) : previewKind ? (
            <div className="canvas-status">
              <span className="canvas-status-icon" aria-hidden>
                <FileQuestion size={18} strokeWidth={1.5} />
              </span>
              <span className="mono">这个文件可以只读预览。</span>
              <button type="button" className="canvas-retry" onClick={() => openPreviewableArtifact(active)}>
                打开预览
              </button>
            </div>
          ) : (
            <>
              {truncated ? (
                <div className="canvas-truncated-note" role="status">
                  文件较大，画布只显示了前 8MB；完整内容可在系统中打开。
                </div>
              ) : null}
              <CanvasContent
                key={`${active.id}-${activeUpdatedAt}`}
                artifact={active}
                kind={displayKind}
                language={language}
                content={content ?? ''}
                ext={ext}
                ready={htmlReady}
              />
            </>
          )}

          {editor.historyDoc ? (
            <HistoryDrawer
              doc={editor.historyDoc}
              readOnly={editor.readOnlyMode}
              onClose={editor.closeHistory}
              loadVersions={editor.loadHistoryVersions}
              loadDiff={editor.loadHistoryDiff}
              onRestore={editor.restoreVersion}
            />
          ) : null}
        </div>
      </aside>

      {active && session?.id ? (
        <>
          <ArtifactVersionsDialog
            open={versionsOpen && versionable}
            onClose={() => setVersionsOpen(false)}
            sessionId={session.id}
            artifactId={active.id}
            artifactTitle={active.title}
          />
          <ArtifactExportDialog
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            sessionId={session.id}
            artifact={active}
          />
        </>
      ) : null}

      <Modal
        open={editor.dialog !== null}
        onClose={editor.closeDialog}
        title={dialogTitle}
        width={460}
        footer={dialogFooter}
        closeOnBackdrop={!editor.dialogBusy}
      >
        {editor.dialog?.kind === 'close-doc' && closeDocTarget ? (
          <p className="editor-dialog-text">
            <span className="editor-dialog-strong">{closeDocTarget.title}</span> 有未保存的修改。关闭后这些修改会丢失。
          </p>
        ) : editor.dialog?.kind === 'close-canvas' ? (
          <p className="editor-dialog-text">
            还有 <span className="editor-dialog-strong">{dirtyCount}</span> 个文件没有保存。你可以先保存全部，或放弃这些修改。
          </p>
        ) : editor.dialog?.kind === 'save-as' ? (
          <div>
            <p className="editor-dialog-text">把当前内容另存为文件夹内的新文件，原文件不会被修改。</p>
            <input
              className="editor-dialog-input"
              value={editor.saveAsDraft}
              onChange={(event) => editor.setSaveAsDraft(event.target.value)}
              placeholder="例如 docs/report-copy.md"
              aria-label="另存为相对路径"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void editor.submitSaveAs()
              }}
            />
            <p className="editor-dialog-hint">相对文件夹的路径，用 / 分隔目录；已存在的文件不能被覆盖。</p>
          </div>
        ) : null}
      </Modal>
    </>
  )
}

/** 成品 iframe 里的外链交给宿主用系统浏览器打开（沙箱内无法直接打开外部窗口） */
const MORROW_LINK_BRIDGE = `<script data-morrow-link-bridge>(function () {
  function post(url) {
    try { parent.postMessage({ type: 'morrow:open-external', url: url }, '*') } catch (error) {}
  }
  function nearestAnchor(node) {
    while (node && node !== document) {
      if (node.tagName === 'A' && node.href) return node
      node = node.parentNode
    }
    return null
  }
  function onClick(event) {
    var anchor = nearestAnchor(event.target)
    if (!anchor || !/^https?:\\/\\//i.test(anchor.href)) return
    event.preventDefault()
    post(anchor.href)
  }
  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onClick, true)
  var nativeOpen = window.open
  window.open = function (url) {
    if (typeof url === 'string' && /^https?:\\/\\//i.test(url)) {
      post(url)
      return null
    }
    return nativeOpen ? nativeOpen.apply(window, arguments) : null
  }
})();</script>`

function prepareArtifactHtml(html: string): string {
  const next = withMorrowScrollbar(html)
  if (next.includes('data-morrow-link-bridge')) return next
  if (/<\/body>/i.test(next)) return next.replace(/<\/body>/i, `${MORROW_LINK_BRIDGE}</body>`)
  return `${next}${MORROW_LINK_BRIDGE}`
}

/**
 * HTML 成品：通过 morrow-artifact:// 提供带独立 CSP 的沙箱文档。
 * 不能再用 srcDoc：srcdoc 继承主窗口 CSP，生产包里会拦掉报告的内联脚本。
 */
function HtmlArtifact({
  artifact,
  content,
  ready
}: {
  artifact: Artifact
  content: string
  ready: boolean
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const lastExternalAt = useRef(0)

  useEffect(() => {
    setUrl(null)
    setError(null)
    if (!ready) return undefined
    let cancelled = false
    window.morrow.artifacts
      .previewHtml(prepareArtifactHtml(content))
      .then((result) => {
        if (cancelled) return
        if (result.ok) setUrl(result.data.url)
        else setError(result.error.message)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '网页预览准备失败')
      })
    return () => {
      cancelled = true
    }
  }, [content, ready])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data as { type?: unknown; url?: unknown } | null
      if (!data || data.type !== 'morrow:open-external' || typeof data.url !== 'string') return
      if (!/^https?:\/\//i.test(data.url)) return
      const now = Date.now()
      if (now - lastExternalAt.current < 800) return
      lastExternalAt.current = now
      void useAppStore.getState().openExternal(data.url)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (!ready || (!url && !error)) {
    return (
      <div className="canvas-frame-placeholder" aria-hidden>
        <span className="canvas-status-line" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="canvas-preview-failure" role="alert">
        <p className="canvas-preview-failure-title">网页预览没能打开</p>
        <p className="canvas-preview-failure-detail mono">{error}</p>
      </div>
    )
  }
  return (
    <iframe
      ref={frameRef}
      className="canvas-frame"
      title={artifact.title}
      sandbox="allow-scripts allow-forms"
      src={url ?? undefined}
      referrerPolicy="no-referrer"
    />
  )
}

function CanvasContent({
  artifact,
  kind,
  language,
  content,
  ext,
  ready
}: {
  artifact: Artifact
  kind: ArtifactKind
  language: string | null
  content: string
  ext: string | null
  ready: boolean
}): React.JSX.Element {
  if (kind === 'html') {
    return <HtmlArtifact artifact={artifact} content={content} ready={ready} />
  }
  if (kind === 'markdown') {
    return (
      <div className="canvas-paper canvas-md selectable">
        <Markdown text={content} />
      </div>
    )
  }
  if (kind === 'svg') {
    return (
      <div className="canvas-svg">
        <img className="canvas-svg-image" src={toSvgDataUrl(content)} alt={artifact.title} />
      </div>
    )
  }
  if (kind === 'text') {
    return <pre className="canvas-text mono selectable">{content}</pre>
  }
  return (
    <div className="canvas-code">
      <CodeBlock code={content} language={language ?? ext ?? null} lineNumbers foldAfter={Number.MAX_SAFE_INTEGER} />
    </div>
  )
}

/**
 * 画布空态：没有成品时不是一块空白面板。
 * 有关闭按钮（在头部）、一句引导、最近 3 个成品入口或三步上手提示。
 */
function CanvasEmpty({ artifacts, onOpen }: { artifacts: Artifact[]; onOpen: (id: string) => void }): React.JSX.Element {
  const recent = artifacts.slice(-3).reverse()
  return (
    <div className="canvas-empty">
      <div className="canvas-empty-hero">
        <span className="canvas-empty-mark" aria-hidden>
          <FileCode2 size={22} strokeWidth={1.3} />
        </span>
        <div className="canvas-empty-copy">
          <p className="canvas-empty-lead">让 Morrow 生成网页、报告或图表，成品会出现在这里。</p>
        </div>
      </div>

      {recent.length > 0 ? (
        <div className="canvas-recent">
          <p className="canvas-recent-label mono">最近的成品</p>
          <ul className="canvas-recent-list">
            {recent.map((artifact) => {
              const kind = resolveKind(artifact)
              return (
                <li key={artifact.id}>
                  <button type="button" className="canvas-recent-item" onClick={() => onOpen(artifact.id)}>
                    <span className="canvas-recent-icon" aria-hidden>
                      <FileGlyph kind={kind} />
                    </span>
                    <span className="canvas-recent-copy">
                      <span className="canvas-recent-title">{artifact.title}</span>
                      <span className="canvas-recent-meta mono">
                        {KIND_LABEL[kind]}
                        {artifact.updatedAt ? ` · ${formatClock(artifact.updatedAt)}` : ''}
                      </span>
                    </span>
                    <ChevronRight size={13} strokeWidth={1.6} className="canvas-recent-arrow" aria-hidden />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <div className="canvas-empty-guide">
          <p>
            <span className="canvas-empty-step mono">01</span>
            <span>说清想要的结果，比如「把这份数据整理成 HTML 报告」</span>
          </p>
          <p>
            <span className="canvas-empty-step mono">02</span>
            <span>Morrow 会自己读文件、跑命令，过程写在执行过程里</span>
          </p>
          <p>
            <span className="canvas-empty-step mono">03</span>
            <span>成品出现在这里：网页、Markdown 文档、代码或 SVG</span>
          </p>
        </div>
      )}

      <p className="canvas-empty-foot mono">右上角的按钮可以随时收起这里</p>
    </div>
  )
}
