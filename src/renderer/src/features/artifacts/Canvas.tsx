import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  Copy,
  ExternalLink,
  FileAudio,
  FileCode2,
  FilePen,
  FileQuestion,
  FileText,
  FileVideo,
  FolderDown,
  FolderOpen,
  History,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Share2,
  X
} from 'lucide-react'
import type { Artifact, ArtifactKind } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button, ErrorNote, IconButton, Modal, ResizeHandle } from '../../ui'
import { languageLabel } from '../../components/editor/languages'
import { previewKindForFileName, type FilePreviewKind } from '@shared/file-types'
import { relativeToWorkspace } from './editor/editor-api'
import { EditorPane } from './editor/EditorPane'
import { HistoryDrawer } from './editor/HistoryDrawer'
import { useEditorDocs, type EditorDocument } from './editor/useEditorDocs'
import { FilePreviewPane } from './preview/FilePreviewPane'
import { Markdown } from '../../components/markdown/Markdown'
import { CodeBlock } from '../../components/markdown/CodeBlock'
import { ArtifactVersionsDialog } from './ArtifactVersionsDialog'
import { ArtifactExportDialog } from './ArtifactExportDialog'
import './Canvas.css'

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
  const closeCanvas = useAppStore((s) => s.closeCanvas)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const revealArtifact = useAppStore((s) => s.revealArtifact)
  const saveArtifactToWorkspace = useAppStore((s) => s.saveArtifactToWorkspace)
  const openArtifactExternal = useAppStore((s) => s.openArtifactExternal)
  const copyText = useAppStore((s) => s.copyText)
  const canvasWidth = useAppStore((s) => s.canvasWidth)
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

  /* 窗口变窄时把画布宽度收回可视范围并持久化，避免内容被挤出屏幕 */
  useEffect(() => {
    if (!canvas.open) return undefined
    const clampToWindow = (): void => {
      const maxVisible = Math.min(960, Math.round(window.innerWidth * 0.68))
      if (useAppStore.getState().canvasWidth > maxVisible) setCanvasWidth(maxVisible, true)
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

  const openExternal = (): void => {
    if (active?.path) void openArtifactExternal(active.path)
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
    else closeCanvas()
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
          value={canvasWidth}
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
        style={!fullscreen && !narrow ? { width: canvasWidth } : undefined}
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
                <IconButton label="在浏览器中打开" size={26} onClick={openExternal} disabled={!canUsePath}>
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
                  文件较大，画布只显示了前 {displayKind === 'html' ? '8' : '2'}MB；完整内容可在系统中打开。
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

/** 演示/报告 HTML 在 iframe 内渲染时，把滚动条也统一成应用的黑金无边框样式。 */
const MORROW_SCROLLBAR_CSS = `<style data-morrow-scrollbar>
html, body, * { scrollbar-width: thin !important; scrollbar-color: #8a6f42 transparent !important; }
*::-webkit-scrollbar { width: 8px !important; height: 8px !important; background: transparent !important; }
*::-webkit-scrollbar-track { background: transparent !important; border: 0 !important; }
*::-webkit-scrollbar-thumb {
  min-height: 36px; border: 0 !important; border-radius: 2px !important;
  background: linear-gradient(180deg, rgba(84,67,40,.55) 0%, #8a6f42 42%, #c8ae7d 52%, #5d492b 100%) !important;
}
*::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(122,96,55,.75) 0%, #b18f58 42%, #e4ce9e 54%, #7a6138 100%) !important;
}
*::-webkit-scrollbar-corner { background: transparent !important; }
</style>`

function withMorrowScrollbar(html: string): string {
  if (!html || html.includes('data-morrow-scrollbar')) return html
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${MORROW_SCROLLBAR_CSS}</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, `$&${MORROW_SCROLLBAR_CSS}`)
  return `${MORROW_SCROLLBAR_CSS}${html}`
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

