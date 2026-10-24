import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, ScanLine } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { IconButton } from '../../ui'
import { errorText } from '../../lib'

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
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

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
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建 PDF 画布。')
        renderTask = page.render({
          canvasContext: context,
          canvas,
          viewport,
          ...(outputScale !== 1 ? { transform: [outputScale, 0, 0, outputScale, 0, 0] } : {})
        })
        await renderTask.promise
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
  }, [pdf, pageNumber, zoom, containerWidth])

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
            <canvas ref={canvasRef} className="preview-pdf-canvas" aria-label={`${title} 第 ${pageNumber} 页`} />
          </div>
        )}
      </div>
    </div>
  )
}
