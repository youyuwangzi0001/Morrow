import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useAppStore, type Toast } from '../../store'
import './Toasts.css'

const AUTO_DISMISS_MS = 4000
const MAX_VISIBLE = 4

const KIND_ICON = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle
} as const

/** 动作按钮：先执行动作，再收起这条通知 */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }): React.JSX.Element {
  const Icon = KIND_ICON[toast.kind]
  return (
    <div className={`toast-item toast-${toast.kind}`}>
      <span className="toast-icon" aria-hidden>
        <Icon size={15} strokeWidth={1.6} />
      </span>
      <p className="toast-msg">{toast.message}</p>
      {toast.action && toast.actionLabel ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            onDismiss()
            toast.action?.()
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="收起通知" onClick={onDismiss}>
        <X size={12} strokeWidth={1.8} aria-hidden />
      </button>
      <span className="toast-progress" aria-hidden />
    </div>
  )
}

/**
 * Toast 堆叠器。
 * store 只保存「最近一条 toast」（单一事实源），这里把每次新出现的 toast 追加为本地堆叠，
 * 4 秒自动消失，行动作执行后收起；全部收起后把 store 的 toast 清空。
 */
export function Toasts(): React.JSX.Element | null {
  const toast = useAppStore((s) => s.toast)
  const dismissToast = useAppStore((s) => s.dismissToast)
  const [items, setItems] = useState<Toast[]>([])
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    if (!toast) return
    setItems((previous) => {
      if (previous.some((item) => item.id === toast.id)) return previous
      return [...previous, toast].slice(-MAX_VISIBLE)
    })
  }, [toast])

  useEffect(() => {
    const live = new Set(items.map((item) => item.id))
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    for (const item of items) {
      if (timers.current.has(item.id)) continue
      const timer = window.setTimeout(() => {
        timers.current.delete(item.id)
        setItems((previous) => previous.filter((entry) => entry.id !== item.id))
      }, AUTO_DISMISS_MS)
      timers.current.set(item.id, timer)
    }
  }, [items])

  useEffect(() => {
    if (items.length > 0) return
    if (useAppStore.getState().toast) dismissToast()
  }, [items.length, dismissToast])

  useEffect(() => {
    return () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
    }
  }, [])

  if (items.length === 0) return null

  return createPortal(
    <div className="toasts" role="region" aria-label="通知" aria-live="polite">
      {items.map((item) => (
        <ToastItem
          key={item.id}
          toast={item}
          onDismiss={() => setItems((previous) => previous.filter((entry) => entry.id !== item.id))}
        />
      ))}
    </div>,
    document.body
  )
}
