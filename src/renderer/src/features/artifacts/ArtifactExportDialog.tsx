import { useEffect, useState } from 'react'
import { AlignLeft, Check, Copy, FileDown, FileText, Globe, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { Artifact, ArtifactExportFormat } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button, Modal } from '../../ui'
import './ArtifactDialogs.css'

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
