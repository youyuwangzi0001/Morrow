import { useEffect, useRef, useState } from 'react'
import { CornerDownLeft, MessageCircleQuestion } from 'lucide-react'
import type { AskUserRequest } from '@shared/types'
import { useAppStore } from '../../store'
import { Kbd } from '../../ui'
import './activity.css'

/**
 * 提问卡：Agent 需要用户做一个选择时出现。
 * 有预设选项时点选即可；允许自定义输入时给一个单行输入框。
 */
export function QuestionCard({ request }: { request: AskUserRequest }): React.JSX.Element {
  const respondQuestion = useAppStore((s) => s.respondQuestion)
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  /* 提问卡出现时聚焦：有自定义输入就聚焦输入框，否则聚焦第一个选项 */
  useEffect(() => {
    const root = cardRef.current
    if (!root) return
    const target = root.querySelector<HTMLElement>('.question-input') ?? root.querySelector<HTMLElement>('.question-option')
    target?.focus({ preventScroll: true })
  }, [])

  const answer = (value: string, label: string, isCustom = false): void => {
    if (submitting) return
    setSubmitting(true)
    void respondQuestion({ value, label, custom: isCustom }).finally(() => setSubmitting(false))
  }

  const submitCustom = (): void => {
    const text = custom.trim()
    if (!text) return
    answer(text, text, true)
  }

  return (
    <div className="question-card" role="alertdialog" aria-modal="false" aria-labelledby="question-title" ref={cardRef}>
      <div className="question-head">
        <MessageCircleQuestion size={15} strokeWidth={1.5} aria-hidden className="question-icon" />
        <h3 className="question-title" id="question-title">
          {request.question}
        </h3>
      </div>

      {request.options.length > 0 ? (
        <div className="question-options">
          {request.options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className="question-option"
              onClick={() => answer(option.value, option.label)}
              disabled={submitting}
            >
              <span className="question-option-index mono" aria-hidden>
                {index + 1}
              </span>
              <span className="question-option-body">
                <span className="question-option-label">{option.label}</span>
                {option.description ? <span className="question-option-desc">{option.description}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {request.allowCustom ? (
        <div className="question-custom">
          <input
            className="question-input"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submitCustom()
              }
            }}
            placeholder="或者直接写下你的回答"
            aria-label="自定义回答"
            disabled={submitting}
          />
          <button type="button" className="question-submit" onClick={submitCustom} disabled={!custom.trim() || submitting}>
            <CornerDownLeft size={13} strokeWidth={1.6} aria-hidden />
            <span>提交</span>
          </button>
        </div>
      ) : null}

      <p className="question-foot">
        {request.allowCustom ? (
          <>
            按 <Kbd>Enter</Kbd> 提交回答。写清楚一点，Morrow 就能少猜一步。
          </>
        ) : (
          '选一个就好，Morrow 会根据你的选择继续。'
        )}
      </p>
    </div>
  )
}
