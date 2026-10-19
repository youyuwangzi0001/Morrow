import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { PermissionDecision, PermissionRequest } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Kbd } from '../../ui'
import { CodeBlock } from '../../components/markdown/CodeBlock'
import { DiffView } from '../../components/diff/DiffView'
import { permissionExplanation } from './tool-meta'
import './activity.css'

const RISK_META: Record<PermissionRequest['risk'], { label: string; description: string }> = {
  low: { label: '低风险', description: '只读或可撤销的操作' },
  medium: { label: '中风险', description: '会修改工作区里的内容' },
  high: { label: '高风险', description: '可能影响工作区外或删除数据' }
}

const RISK_ICON: Record<PermissionRequest['risk'], React.JSX.Element> = {
  low: <ShieldCheck size={14} strokeWidth={1.5} aria-hidden />,
  medium: <ShieldQuestion size={14} strokeWidth={1.5} aria-hidden />,
  high: <ShieldAlert size={14} strokeWidth={1.5} aria-hidden />
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable
}

/**
 * 权限卡：出现在对话流末尾，明确告诉用户「Morrow 想做什么、会发生什么」。
 * Enter = 允许一次，Esc = 拒绝（仅在没有输入框焦点时响应）。
 */
export function PermissionCard({ request }: { request: PermissionRequest }): React.JSX.Element {
  const respondPermission = useAppStore((s) => s.respondPermission)
  const cardRef = useRef<HTMLDivElement>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [submitting, setSubmitting] = useState<PermissionDecision | null>(null)

  /* 审批卡出现时把焦点移到主按钮：Enter 即可允许，且不会误触输入框的发送快捷键 */
  useEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>('.perm-btn-primary')?.focus({ preventScroll: true })
  }, [])

  const risk = RISK_META[request.risk]
  const explanation = permissionExplanation(request)
  const preview = request.preview
  const isDiff = preview?.kind === 'diff'
  const previewLines = preview ? preview.content.split('\n').length : 0
  const collapsible = isDiff && previewLines > 14

  const respond = (decision: PermissionDecision): void => {
    if (submitting) return
    setSubmitting(decision)
    void respondPermission(decision).finally(() => setSubmitting(null))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
      const active = document.activeElement as HTMLElement | null
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        // 焦点在卡片内的按钮上时交给浏览器原生行为，避免一次按键触发两次
        if (active && cardRef.current?.contains(active) && active.tagName === 'BUTTON') return
        event.preventDefault()
        respond('once')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        respond('deny')
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
    // respond 依赖 submitting/respondPermission，这里只需要注册一次事件；用 ref 保持最新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting])

  return (
    <div
      className="permission-card"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="permission-title"
      aria-describedby="permission-desc"
      ref={cardRef}
      data-risk={request.risk}
    >
      <div className="permission-head">
        <span className="permission-risk-icon" aria-hidden>
          {RISK_ICON[request.risk]}
        </span>
        <h3 className="permission-title" id="permission-title">
          {request.title || 'Morrow 需要你的确认'}
        </h3>
        <span className={`permission-risk mono is-${request.risk}`} title={risk.description}>
          {risk.label}
        </span>
      </div>

      <p className="permission-desc" id="permission-desc">
        {explanation}
      </p>
      {request.summary && request.summary !== explanation ? (
        <p className="permission-summary">{request.summary}</p>
      ) : null}

      {preview ? (
        <div className="permission-preview">
          {isDiff ? (
            <>
              <button
                type="button"
                className="permission-preview-toggle"
                aria-expanded={!collapsible || previewOpen}
                onClick={() => setPreviewOpen((value) => !value)}
                disabled={!collapsible}
              >
                <ChevronDown size={13} strokeWidth={1.6} aria-hidden />
                <span>{collapsible ? (previewOpen ? '收起改动预览' : `查看改动预览（${previewLines} 行）`) : '改动预览'}</span>
              </button>
              {!collapsible || previewOpen ? (
                <DiffView patch={preview.content} contextLines={2} maxHeight={260} />
              ) : null}
            </>
          ) : preview.kind === 'command' ? (
            <div className="permission-command">
              <span className="permission-prompt mono" aria-hidden>
                $
              </span>
              <code className="permission-command-text mono">{preview.content}</code>
            </div>
          ) : preview.kind === 'json' ? (
            <CodeBlock code={preview.content} language="json" bare foldAfter={10} />
          ) : (
            <pre className="permission-text mono">{preview.content}</pre>
          )}
        </div>
      ) : null}

      <div className="permission-actions">
        <button
          type="button"
          className="perm-btn perm-btn-primary"
          onClick={() => respond('once')}
          disabled={submitting !== null}
        >
          <span>允许一次</span>
          <Kbd>Enter</Kbd>
        </button>
        <button
          type="button"
          className="perm-btn"
          onClick={() => respond('always')}
          disabled={submitting !== null}
        >
          本次会话都允许
        </button>
        <button
          type="button"
          className="perm-btn perm-btn-deny"
          onClick={() => respond('deny')}
          disabled={submitting !== null}
        >
          <span>拒绝</span>
          <Kbd>Esc</Kbd>
        </button>
      </div>
      <p className="permission-foot">
        拒绝后 Morrow 会换一种做法继续；你也可以随时在输入框里告诉它该怎么做。
      </p>
    </div>
  )
}
