// demo 功能域组件：由 1 个 TSX 文件扁平合并。
import './demo.css'
import { useEffect, useState } from 'react'
import type { DemoStepState } from '../store'
import { useAppStore } from '../store'

const LEAVE_DURATION = 420

interface Anchor {
  top: number
  right: number
}

/**
 * 演示模式呈现：对话列右上方的一枚小胶囊（金线 + 等宽进度 + 当前字幕一行）。
 * 演示结束（demoStep 变 null）后淡出，不遮挡正文。
 */
export function DemoOverlay(): React.JSX.Element | null {
  const demoStep = useAppStore((s) => s.demoStep)
  const [shown, setShown] = useState<DemoStepState | null>(demoStep)
  const [leaving, setLeaving] = useState(false)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  useEffect(() => {
    if (demoStep) {
      setShown(demoStep)
      setLeaving(false)
      return undefined
    }
    if (!shown) return undefined
    setLeaving(true)
    const timer = window.setTimeout(() => {
      setShown(null)
      setLeaving(false)
    }, LEAVE_DURATION)
    return () => window.clearTimeout(timer)
  }, [demoStep, shown])

  const visible = shown !== null

  /* 定位到对话列右上角（画布开合/侧栏折叠时跟随） */
  useEffect(() => {
    if (!visible) return undefined
    const target = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('.transcript-scroll') ?? document.querySelector<HTMLElement>('.app-scroll')
    const measure = (): void => {
      const element = target()
      const rect = element?.getBoundingClientRect()
      if (!rect) {
        setAnchor(null)
        return
      }
      setAnchor({
        top: Math.round(rect.top + 12),
        right: Math.max(16, Math.round(window.innerWidth - rect.right + 18))
      })
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    const element = target()
    if (observer && element) observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [visible])

  if (!shown) return null

  const total = Math.max(1, shown.total)
  const step = Math.min(shown.index + 1, total)
  const fraction = Math.min(1, Math.max(0, step / total))

  return (
    <div
      className={['demo-pill', leaving ? 'is-leaving' : ''].filter(Boolean).join(' ')}
      style={anchor ? { top: anchor.top, right: anchor.right } : undefined}
      role="status"
      aria-live="polite"
      title={`演示 · 第 ${step} / ${total} 步`}
    >
      <span className="demo-pill-dot" aria-hidden />
      <span className="demo-pill-label mono">
        演示 · {step}/{total}
      </span>
      <span className="demo-pill-sep" aria-hidden />
      <span className="demo-pill-caption">{shown.caption}</span>
      <span className="demo-pill-bar" aria-hidden>
        <i style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
    </div>
  )
}
