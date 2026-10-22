import { useMemo, useState } from 'react'
import {
  ExternalLink,
  FileAudio,
  FileImage,
  FileQuestion,
  FileText,
  FileVideo,
  FolderOpen,
  Minus,
  Plus,
  RotateCcw,
  ScanLine
} from 'lucide-react'
import { formatBytes } from '@shared/format'
import { withMorrowScrollbar } from '@shared/scrollbar'
import { IconButton } from '../../ui'
import type { EditorDocument } from './useEditorDocs'
import { PdfPreview } from './PdfPreview'
import { ArchivePreview, DocumentPreview, PptxPreview, XlsxPreview } from './OfficePreviews'
import './preview.css'

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

function docxDocument(html: string, title: string, theme: 'dark' | 'light'): string {
  const pageBackground = theme === 'dark' ? '#0d1117' : '#e9e2d4'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base target="_blank">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: ${pageBackground}; color: #26231e; }
  body { padding: 24px 18px 40px; font-family: "Newsreader", "Noto Serif SC", "Songti SC", Georgia, serif; }
  .docx-page { box-sizing: border-box; max-width: 820px; margin: 0 auto; padding: clamp(22px, 5vw, 54px); background: #f8f4eb; border: 1px solid rgba(38, 35, 30, .1); box-shadow: 0 18px 50px rgba(0, 0, 0, .12); font-size: 14.5px; line-height: 1.78; overflow-wrap: anywhere; }
  .docx-page p { margin: 0 0 .8em; }
  .docx-page p:last-child { margin-bottom: 0; }
  h1, h2, h3, h4 { margin: 1.1em 0 .55em; line-height: 1.35; font-weight: 600; }
  h1 { font-size: 1.75em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
  table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: .92em; }
  td, th { padding: 6px 9px; border: 1px solid #d8d0c2; vertical-align: top; }
  th { background: #efe8db; text-align: left; }
  img { max-width: 100%; height: auto; }
  a { color: #8a6a3c; text-decoration: underline; text-underline-offset: 2px; }
  ul, ol { margin: .6em 0 .9em; padding-left: 1.5em; }
  blockquote { margin: 1em 0; padding: .3em 0 .3em 1em; border-left: 3px solid #c8ae7d; color: #5e574b; }
  hr { border: 0; border-top: 1px solid #d8d0c2; margin: 1.5em 0; }
  .docx-empty { color: #8c867a; font-style: italic; }
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
