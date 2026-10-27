// R10-C 内置浏览器面板（受控组件，Lead 在 App 中挂载）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, House, Loader2, Plus, RotateCw, ShieldAlert, Sparkles, X } from 'lucide-react'
import { formatBytes } from '@shared/usage'
import './browser.css'

export interface BrowserSurfaceProps {
  /** 面板是否打开（受控） */
  open: boolean
  /** 原生网页视图是否可见；隐藏时浏览器保持打开，可再次切回 */
  visible?: boolean
  /** 返回主页面：隐藏浏览器但保留当前页面与状态 */
  onHide: () => void
  /** 用户关闭面板/浏览器时回调（由 Lead 更新挂载状态） */
  onClose: () => void
  /** 可选：打开时自动导航到的网址 */
  initialUrl?: string
}

interface BrowserTabInfo {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: { code: string; message: string } | null
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
  automationActive: boolean
  tabs?: BrowserTabInfo[]
  activeTabId?: string | null
}

interface DownloadRequest {
  id: string
  filename: string
  url: string
  suggestedPath: string
  totalBytes: number
  createdAt: number
}

interface DownloadResolved {
  id: string
  filename?: string
  allow: boolean
  path?: string
  error?: string
  pending?: boolean
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
  error: null,
  automationActive: false,
  tabs: [],
  activeTabId: null
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

function tabLabel(tab: { title: string; url: string }): string {
  const title = tab.title.trim()
  if (title && title !== 'about:blank') return title
  return tab.url ? displayHost(tab.url) : '新标签页'
}

export function BrowserSurface({ open, visible = true, onHide, onClose, initialUrl }: BrowserSurfaceProps): React.JSX.Element | null {
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [address, setAddress] = useState('')
  const [bootError, setBootError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadRequest | null>(null)
  const [savedDownload, setSavedDownload] = useState<{ filename: string; path: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const lastBounds = useRef<string>('')
  const initialUrlSent = useRef(false)
  // WebContentsView 是原生层，永远盖在渲染层之上；有底部浮层时给原生视图让出空间
  const overlayReserve = download ? 150 : savedDownload ? 64 : actionError ? 96 : 0
  const overlayReserveRef = useRef(overlayReserve)
  overlayReserveRef.current = overlayReserve

  const applyResult = useCallback((next: BrowserState, error: unknown = null) => {
    setState(next)
    if (!next.error) setActionError(null)
    if (error) {
      setSavedDownload(null)
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    const api = featureApi()
    if (!api?.on) return
    const offState = api.on('feature:browser:state', (payload) => {
      if (payload && typeof payload === 'object') setState(payload as BrowserState)
    })
    const offDownload = api.on('feature:browser:download', (payload) => {
      if (!payload || typeof payload !== 'object') return
      setSavedDownload(null)
      setActionError(null)
      setDownload(payload as DownloadRequest)
    })
    const offResolved = api.on('feature:browser:download-resolved', (payload) => {
      setDownload(null)
      if (!payload || typeof payload !== 'object') return
      const resolved = payload as DownloadResolved
      if (resolved.pending) return
      if (resolved.allow && resolved.path) {
        setActionError(null)
        setSavedDownload({ filename: resolved.filename || '文件', path: resolved.path })
        return
      }
      if (resolved.error) {
        setSavedDownload(null)
        setActionError(resolved.error)
      }
    })
    return () => {
      offState?.()
      offDownload?.()
      offResolved?.()
    }
  }, [])

  const measureBounds = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const element = viewportRef.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const height = Math.round(rect.height) - overlayReserveRef.current
    if (rect.width < 1 || height < 1) return null
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height
    }
  }, [])

  const syncBounds = useCallback(
    (force = false) => {
      const bounds = measureBounds()
      const api = featureApi()
      if (!bounds || !api?.invoke) return
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      if (!force && key === lastBounds.current) return
      lastBounds.current = key
      void api.invoke('feature:browser:set-bounds', bounds).catch(() => undefined)
    },
    [measureBounds]
  )

  useLayoutEffect(() => {
    if (!open || !visible) {
      lastBounds.current = ''
      return
    }
    // 重新展开时强制重报一次边界：原生视图可能还保留隐藏前的旧位置。
    syncBounds(true)
    const element = viewportRef.current
    if (!element) return
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncBounds()) : null
    observer?.observe(element)
    const onResize = (): void => {
      requestAnimationFrame(() => syncBounds(true))
    }
    window.addEventListener('resize', onResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [open, visible, syncBounds])

  /* 原生视图创建后强制补一次 bounds：首次同步可能早于 surface 创建而被丢弃 */
  useEffect(() => {
    if (!open || !state.open) return
    lastBounds.current = ''
    const frame = requestAnimationFrame(() => syncBounds(true))
    return () => cancelAnimationFrame(frame)
  }, [open, state.open, syncBounds])

  /* 下载确认/提示出现或消失时重新让位，避免原生网页盖住浮层 */
  useEffect(() => {
    if (!open || !state.open) return
    lastBounds.current = ''
    const frame = requestAnimationFrame(() => syncBounds(true))
    return () => cancelAnimationFrame(frame)
  }, [download, savedDownload, actionError, open, state.open, syncBounds])

  // 切换标签/Agent 导航时地址栏跟随活动页面；用户正在输入时不覆盖
  useEffect(() => {
    if (document.activeElement === addressRef.current) return
    setAddress(state.url || '')
  }, [state.url, state.activeTabId])

  useEffect(() => {
    if (!open || !visible) {
      const api = featureApi()
      if (api?.invoke) void api.invoke('feature:browser:set-visible', { visible: false }).catch(() => undefined)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const current = await invoke<BrowserState>('feature:browser:get-state')
        if (cancelled) return
        if (current.open) {
          // 面板可能只是被隐藏过（surface 还活着）：先重报当前边界，再恢复原生视图，
          // 避免旧视图以隐藏前的尺寸盖住地址栏。
          const bounds = measureBounds()
          if (bounds) {
            lastBounds.current = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
            await invoke('feature:browser:set-bounds', bounds)
          }
          const shown = await invoke<BrowserState>('feature:browser:set-visible', { visible: true })
          if (!cancelled) {
            setState(shown)
            setAddress(shown.url || '')
          }
          return
        }
        setState(current)
        setAddress(current.url || '')
        if (!current.open && initialUrl && !initialUrlSent.current) {
          initialUrlSent.current = true
          // 创建原生视图时一并传 bounds，避免 view 以 0×0/隐藏状态存在
          const bounds = measureBounds()
          const next = await invoke<BrowserState>('feature:browser:open', {
            url: initialUrl,
            ...(bounds ? { bounds } : {})
          })
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
  }, [open, visible, initialUrl, measureBounds])

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
        const bounds = measureBounds()
        const next = current.open
          ? await invoke<BrowserState>('feature:browser:navigate', { url: trimmed })
          : await invoke<BrowserState>('feature:browser:open', {
              url: trimmed,
              ...(bounds ? { bounds } : {})
            })
        applyResult(next)
        setAddress(next.url || trimmed)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyResult, measureBounds]
  )

  const openNewTab = useCallback(async (): Promise<void> => {
    setActionError(null)
    try {
      const bounds = measureBounds()
      const next = await invoke<BrowserState>('feature:browser:tab-new', {
        ...(bounds ? { bounds } : {})
      })
      applyResult(next)
      setAddress('')
      requestAnimationFrame(() => addressRef.current?.focus())
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [applyResult, measureBounds])

  const activateTab = useCallback(
    async (id: string): Promise<void> => {
      setActionError(null)
      try {
        const next = await invoke<BrowserState>('feature:browser:tab-activate', { id })
        applyResult(next)
        setAddress(next.url || '')
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyResult]
  )

  const closeTab = useCallback(
    async (id: string): Promise<void> => {
      setActionError(null)
      try {
        const next = await invoke<BrowserState>('feature:browser:tab-close', { id })
        applyResult(next)
        setAddress(next.url || '')
        if (!next.open) onClose()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [applyResult, onClose]
  )

  useEffect(() => {
    if (!open || !visible) return
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 't') {
        event.preventDefault()
        void openNewTab()
      } else if (key === 'l') {
        event.preventDefault()
        addressRef.current?.focus()
        addressRef.current?.select()
      } else if (key === 'w' && !event.shiftKey && state.activeTabId) {
        event.preventDefault()
        void closeTab(state.activeTabId)
      } else if (event.key === 'Tab') {
        const tabs = state.tabs ?? []
        if (tabs.length < 2) return
        event.preventDefault()
        const current = tabs.findIndex((tab) => tab.id === state.activeTabId)
        const delta = event.shiftKey ? -1 : 1
        const next = (current + delta + tabs.length) % tabs.length
        if (tabs[next]) void activateTab(tabs[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, visible, openNewTab, closeTab, activateTab, state.activeTabId, state.tabs])

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

  const revealSavedDownload = useCallback(async () => {
    if (!savedDownload) return
    try {
      await invoke('feature:browser:reveal-download', { path: savedDownload.path })
    } catch (err) {
      setSavedDownload(null)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [savedDownload])

  const hideToApp = useCallback(async () => {
    try {
      await invoke('feature:browser:set-visible', { visible: false })
    } catch {
      // 即使隐藏失败也先回到主页面；原生视图由后续 onHide 状态兜底
    }
    onHide()
  }, [onHide])

  if (!open) return null

  const ready = state.open
  const title = state.title?.trim() || (state.url ? displayHost(state.url) : '空白页')
  const error = state.error ?? (bootError ? { code: 'FEATURE', message: bootError } : null)

  const tabs = state.tabs ?? []

  return (
    <section className="browser-surface" aria-label="内置浏览器">
      <div className="browser-tabs" role="tablist" aria-label="浏览器标签">
        {tabs.map((tab) => {
          const active = tab.id === state.activeTabId
          const label = tabLabel(tab)
          return (
            <div
              key={tab.id}
              className={['browser-tab', active ? 'is-active' : '', tab.loading ? 'is-loading' : '', tab.error ? 'is-error' : '']
                .filter(Boolean)
                .join(' ')}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              title={tab.url || label}
              onClick={() => {
                if (!active) void activateTab(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (!active) void activateTab(tab.id)
                }
              }}
            >
              {tab.loading ? (
                <Loader2 size={11} strokeWidth={1.6} className="browser-tab-spinner" aria-hidden />
              ) : (
                <Globe size={11} strokeWidth={1.5} className="browser-tab-icon" aria-hidden />
              )}
              <span className="browser-tab-title truncate">{label}</span>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`关闭标签 ${label}`}
                title="关闭标签（Ctrl+W）"
                onClick={(event) => {
                  event.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                <X size={11} strokeWidth={1.7} aria-hidden />
              </button>
            </div>
          )
        })}
        <button type="button" className="browser-tab-new" aria-label="新建标签页" title="新建标签页（Ctrl+T）" onClick={() => void openNewTab()}>
          <Plus size={14} strokeWidth={1.7} aria-hidden />
        </button>
      </div>

      <header className="browser-toolbar">
        <button
          type="button"
          className="browser-btn browser-home"
          aria-label="返回主页面"
          title="返回主页面（浏览器保持打开，可随时切回）"
          onClick={() => void hideToApp()}
        >
          <House size={15} strokeWidth={1.5} />
        </button>
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
            placeholder="输入网址，例如 example.com"
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
          {state.automationActive ? (
            <span className="browser-agent-chip" role="status" title="Morrow 正在操作这个页面">
              <Sparkles size={11} strokeWidth={1.6} aria-hidden />
              Morrow 操作中
            </span>
          ) : null}
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
            <p className="browser-empty-note mono">网页只在这里打开；摄像头、麦克风、定位和通知默认关闭。</p>
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

      {savedDownload ? (
        <div className="browser-toast is-success" role="status">
          <span className="browser-toast-message truncate">已保存「{savedDownload.filename}」</span>
          <button type="button" className="browser-toast-action" onClick={() => void revealSavedDownload()}>
            打开文件夹
          </button>
          <button type="button" aria-label="关闭提示" onClick={() => setSavedDownload(null)}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="browser-toast" role="status">
          <span className="browser-toast-message">{actionError}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setActionError(null)}>
            <X size={13} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}
    </section>
  )
}

export default BrowserSurface
