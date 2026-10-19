/**
 * R10-C 内置浏览器面板（受控组件，Lead 在 App 中挂载）。
 *
 * 用法：
 *   import { BrowserSurface } from './features/browser'
 *   <BrowserSurface open={browserOpen} onClose={() => setBrowserOpen(false)} initialUrl={url} />
 *
 * 渲染层只画浏览器 chrome（地址栏/导航/状态/错误/下载确认），真实网页由主进程
 * WebContentsView 渲染；组件测量 `.browser-viewport` 的窗口内坐标并通过
 * `feature:browser:set-bounds` 同步给主进程，窗口缩放/全屏时持续同步。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Loader2, RotateCw, ShieldAlert, X } from 'lucide-react'
import './browser.css'

export interface BrowserSurfaceProps {
  /** 面板是否打开（受控） */
  open: boolean
  /** 用户关闭面板/浏览器时回调（由 Lead 更新挂载状态） */
  onClose: () => void
  /** 可选：打开时自动导航到的网址 */
  initialUrl?: string
}

interface BrowserState {
  open: boolean
  visible: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: { code: string; message: string } | null
}

interface DownloadRequest {
  id: string
  filename: string
  url: string
  suggestedPath: string
  totalBytes: number
  createdAt: number
}

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; hint?: string } }

const EMPTY_STATE: BrowserState = {
  open: false,
  visible: false,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null
}

const featureApi = () => window.morrow?.features

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const api = featureApi()
  if (!api?.invoke) throw new Error('feature IPC 不可用（浏览器功能未集成）。')
  const result = (await api.invoke<T>(channel, payload)) as Result<T>
  if (!result || typeof result !== 'object') throw new Error('浏览器功能返回无效结果。')
  if (!result.ok) throw new Error(result.error?.message || '浏览器操作失败。')
  return result.data
}

function displayHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function BrowserSurface({ open, onClose, initialUrl }: BrowserSurfaceProps): React.JSX.Element | null {
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [address, setAddress] = useState('')
  const [bootError, setBootError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadRequest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const lastBounds = useRef<string>('')
  const initialUrlSent = useRef(false)

  const applyResult = useCallback((next: BrowserState, error: unknown = null) => {
    setState(next)
    if (!next.error) setActionError(null)
    if (error) setActionError(error instanceof Error ? error.message : String(error))
  }, [])

  /* ── 订阅主进程状态/下载事件 ─────────────────────────────────── */
  useEffect(() => {
    const api = featureApi()
    if (!api?.on) return
    const offState = api.on('feature:browser:state', (payload) => {
      if (payload && typeof payload === 'object') setState(payload as BrowserState)
    })
    const offDownload = api.on('feature:browser:download', (payload) => {
      if (payload && typeof payload === 'object') setDownload(payload as DownloadRequest)
    })
    const offResolved = api.on('feature:browser:download-resolved', () => setDownload(null))
    return () => {
      offState?.()
      offDownload?.()
      offResolved?.()
    }
  }, [])

  /* ── open/initialUrl 驱动 ───────────────────────────────────── */
  useEffect(() => {
    if (!open) {
      const api = featureApi()
      if (api?.invoke) void api.invoke('feature:browser:set-visible', { visible: false }).catch(() => undefined)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const current = await invoke<BrowserState>('feature:browser:get-state')
        if (cancelled) return
        setState(current)
        setAddress(current.url || '')
        if (!current.open && initialUrl && !initialUrlSent.current) {
          initialUrlSent.current = true
          const next = await invoke<BrowserState>('feature:browser:open', { url: initialUrl })
          if (!cancelled) {
            setState(next)
            setAddress(next.url)
          }
        }
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, initialUrl])

  /* ── viewport bounds 持续同步（含窗口缩放/全屏） ─────────────── */
  const syncBounds = useCallback(() => {
    const element = viewportRef.current
    const api = featureApi()
    if (!element || !api?.invoke) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
    if (key === lastBounds.current) return
    lastBounds.current = key
    void api.invoke('feature:browser:set-bounds', bounds).catch(() => undefined)
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      lastBounds.current = ''
      return
    }
    syncBounds()
    const element = viewportRef.current
    if (!element) return
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncBounds()) : null
    observer?.observe(element)
    const onResize = (): void => {
      requestAnimationFrame(syncBounds)
    }
    window.addEventListener('resize', onResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [open, syncBounds])

  /* ── 面板卸载时关闭浏览器视图，避免留下孤儿 WebContentsView ─── */
  useEffect(
    () => () => {
      const api = featureApi()
      void api?.invoke?.('feature:browser:close').catch(() => undefined)
    },
    []
  )

  const navigateTo = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      setActionError(null)
      try {
        const current = await invoke<BrowserState>('feature:browser:get-state')
        const next = current.open
          ? await invoke<BrowserState>('feature:browser:navigate', { url: trimmed })
          : await invoke<BrowserState>('feature:browser:open', { url: trimmed })
        applyResult(next)
        setAddress(next.url || trimmed)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyResult]
  )

  const runAction = useCallback(
    async (action: 'back' | 'forward' | 'reload' | 'stop' | 'close') => {
      setActionError(null)
      try {
        if (action === 'close') {
          await invoke<BrowserState>('feature:browser:close')
          setState(EMPTY_STATE)
          onClose()
          return
        }
        const next = await invoke<BrowserState>(`feature:browser:${action}`)
        applyResult(next)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyResult, onClose]
  )

  const decideDownload = useCallback(
    async (id: string, allow: boolean) => {
      try {
        await invoke<{ decided: boolean }>('feature:browser:decide-download', { id, allow })
        setDownload(null)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    []
  )

  if (!open) return null

  const ready = state.open
  const title = state.title?.trim() || (state.url ? displayHost(state.url) : '新浏览页')
  const error = state.error ?? (bootError ? { code: 'FEATURE', message: bootError } : null)

  return (
    <section className="browser-surface" aria-label="内置浏览器">
      <header className="browser-toolbar">
        <div className="browser-nav">
          <button
            type="button"
            className="browser-btn"
            aria-label="后退"
            title="后退"
            disabled={!ready || !state.canGoBack}
            onClick={() => void runAction('back')}
          >
            <ArrowLeft size={15} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="browser-btn"
            aria-label="前进"
            title="前进"
            disabled={!ready || !state.canGoForward}
            onClick={() => void runAction('forward')}
          >
            <ArrowRight size={15} strokeWidth={1.5} />
          </button>
          {state.loading ? (
            <button type="button" className="browser-btn" aria-label="停止加载" title="停止加载" onClick={() => void runAction('stop')}>
              <X size={15} strokeWidth={1.5} />
            </button>
          ) : (
            <button
              type="button"
              className="browser-btn"
              aria-label="刷新"
              title="刷新"
              disabled={!ready}
              onClick={() => void runAction('reload')}
            >
              <RotateCw size={15} strokeWidth={1.5} />
            </button>
          )}
        </div>

        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            void navigateTo(address)
          }}
        >
          <Globe size={14} strokeWidth={1.5} className="browser-address-icon" aria-hidden />
          <input
            ref={addressRef}
            className="browser-address-input mono"
            value={address}
            spellCheck={false}
            placeholder="输入网址，例如 example.com 或 http://localhost:3000"
            aria-label="浏览器地址栏"
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
          {state.loading ? <Loader2 size={14} strokeWidth={1.5} className="browser-spinner" aria-hidden /> : null}
          <span className="browser-address-enter mono" aria-hidden>
            Enter
          </span>
        </form>

        <div className="browser-meta">
          <span className="browser-title truncate" title={title}>
            {title}
          </span>
          <button type="button" className="browser-btn browser-close" aria-label="关闭浏览器" title="关闭浏览器" onClick={() => void runAction('close')}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="browser-error-panel" role="alert">
          <ShieldAlert size={22} strokeWidth={1.5} className="browser-error-icon" aria-hidden />
          <div className="browser-error-body">
            <p className="browser-error-title">这个页面没能打开</p>
            <p className="browser-error-message">{error.message}</p>
            <p className="browser-error-code mono">{error.code}</p>
            {state.url ? (
              <div className="browser-error-actions">
                <button type="button" className="browser-error-retry" onClick={() => void runAction('reload')}>
                  重新加载
                </button>
                <span className="browser-error-url mono truncate">{state.url}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="browser-viewport" ref={viewportRef}>
        {!state.url && !state.loading ? (
          <div className="browser-empty">
            <p className="browser-empty-title serif">在 Morrow 里打开一个网页</p>
            <p className="browser-empty-hint">在地址栏输入网址，或让 Morrow 在任务里打开网页并操作它。</p>
            <p className="browser-empty-note mono">只打开网页链接；网页与本机隔离；摄像头、麦克风、定位、通知默认关闭。</p>
          </div>
        ) : null}
        {state.loading && !state.url ? <div className="browser-loading-hint mono">正在打开…</div> : null}
      </div>

      {download ? (
        <div className="browser-download" role="dialog" aria-label="下载确认">
          <div className="browser-download-body">
            <p className="browser-download-title">
              网页请求下载 <span className="mono truncate">{download.filename}</span>
            </p>
            <p className="browser-download-meta mono truncate">
              {displayHost(download.url)} · {formatBytes(download.totalBytes)}
            </p>
            <p className="browser-download-path mono truncate">保存到：{download.suggestedPath}</p>
          </div>
          <div className="browser-download-actions">
            <button type="button" className="browser-download-deny" onClick={() => void decideDownload(download.id, false)}>
              拒绝
            </button>
            <button type="button" className="browser-download-allow" onClick={() => void decideDownload(download.id, true)}>
              允许下载
            </button>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <div className="browser-toast" role="status">
          <span>{actionError}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setActionError(null)}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}
    </section>
  )
}

export default BrowserSurface
