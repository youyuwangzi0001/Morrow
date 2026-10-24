import { useCallback, useEffect, useState } from 'react'
import { findModel } from '@shared/models'
import { useAppStore } from '../../store'
import { useClickOutside } from '../../ui'
import {
  contextSnapshot,
  contextSourceLabel,
  formatExactTokens
} from '../settings/context-format'

/** 输入框内的上下文入口：圆环 + 点击弹出实时 token 详情。 */
export function ContextMeter(): React.JSX.Element | null {
  const showTokenMeter = useAppStore((s) => s.settings.showTokenMeter)
  const usage = useAppStore((s) => s.session?.usage)
  const session = useAppStore((s) => s.session)
  const settings = useAppStore((s) => s.settings)
  const model = findModel(settings.providers, session?.model ?? settings.defaultModel)
  const snapshot = contextSnapshot(usage, model?.contextWindow)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const wrapRef = useClickOutside(close, open)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    setOpen(false)
  }, [session?.id])

  if (!showTokenMeter || snapshot.limit <= 0 || snapshot.used <= 0) return null

  const radius = 6.2
  const circumference = 2 * Math.PI * radius
  const tone = snapshot.ratio >= 0.9 ? 'is-danger' : snapshot.ratio >= 0.75 ? 'is-warning' : ''
  const detail = `上下文：${formatExactTokens(snapshot.used)} / ${formatExactTokens(snapshot.limit)} tokens（${snapshot.percent}%）· ${contextSourceLabel(snapshot.source)}`
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  const cache = usage?.cacheReadTokens ?? 0
  const hitRate = input > 0 ? Math.min(100, Math.round((cache / input) * 1000) / 10) : 0
  const cost = typeof usage?.costUsd === 'number' ? `$${usage.costUsd.toFixed(4)}` : '—'

  return (
    <div className="composer-ctx" ref={wrapRef}>
      <button
        type="button"
        className={['composer-ctx-ring', tone, open ? 'is-open' : ''].filter(Boolean).join(' ')}
        aria-label={`${detail}，打开上下文详情`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={detail}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(1, circumference * snapshot.ratio)} ${circumference}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open ? (
        <div className="composer-ctx-pop" role="dialog" aria-label="上下文与 Token 使用">
          <div className="composer-ctx-pop-head">
            <span>上下文</span>
            <span className="composer-ctx-pop-percent">{snapshot.percent}%</span>
          </div>
          <div className="composer-ctx-pop-bar" aria-hidden>
            <span style={{ width: `${Math.min(100, Math.round(snapshot.ratio * 100))}%` }} />
          </div>
          <div className="composer-ctx-pop-sub">
            {formatExactTokens(snapshot.used)} / {formatExactTokens(snapshot.limit)} tokens · {contextSourceLabel(snapshot.source)}
          </div>
          <dl className="composer-ctx-pop-grid">
            <div>
              <dt>输入</dt>
              <dd>{formatExactTokens(input)}</dd>
            </div>
            <div>
              <dt>其中缓存</dt>
              <dd>{formatExactTokens(cache)}</dd>
            </div>
            <div>
              <dt>缓存命中率</dt>
              <dd>{hitRate}%</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{formatExactTokens(output)}</dd>
            </div>
            <div>
              <dt>累计费用</dt>
              <dd>{cost}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{model?.label ?? '—'}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  )
}
