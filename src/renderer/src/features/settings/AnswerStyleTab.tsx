/**
 * 全局回答风格：预设卡片 + 自定义偏好。
 * 选择会写入设置，主进程在下一轮运行时把它拼进 system prompt。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { ANSWER_STYLES, ANSWER_STYLE_MAX_CUSTOM, answerStyleLabel } from '@shared/answer-style'
import type { AnswerStyleId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button } from '../../ui'
import './AnswerStyle.css'

export function AnswerStyleTab(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [custom, setCustom] = useState(settings.answerStyleCustom)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resettingRef = useRef(false)

  useEffect(() => {
    setCustom(settings.answerStyleCustom)
  }, [settings.answerStyleCustom])

  const choose = async (id: AnswerStyleId): Promise<void> => {
    if (id === settings.answerStyle) return
    setError(null)
    try {
      await updateSettings({ answerStyle: id })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存回答风格失败')
    }
  }

  const saveCustom = async (): Promise<void> => {
    if (saving || resettingRef.current) return
    setSaving(true)
    setError(null)
    try {
      // 只保存文本：风格卡片点击与输入框失焦可能相邻发生，避免互相覆盖。
      // 允许保存空文本：表示回到「平衡」式的默认措辞，但仍保留自定义风格选择。
      await updateSettings({ answerStyleCustom: custom })
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存自定义风格失败')
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    setError(null)
    resettingRef.current = true
    try {
      await updateSettings({ answerStyle: 'balanced', answerStyleCustom: '' })
      setCustom('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复默认失败')
    } finally {
      resettingRef.current = false
    }
  }

  const customDirty = custom !== settings.answerStyleCustom

  return (
    <div className="st-style">
      <div className="st-style-intro">
        <p className="st-section-title">回答风格</p>
        <p className="st-hint">
          对之后所有对话生效（包括侧边聊天和定时任务）；只改变说话方式，不影响权限、安全规则和引用要求。
          报告、计划等固定格式仍按任务要求。
        </p>
      </div>

      <div className="st-style-grid" role="radiogroup" aria-label="全局回答风格">
        {ANSWER_STYLES.map((style) => {
          const selected = settings.answerStyle === style.id
          return (
            <button
              key={style.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={['st-style-card', selected ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => void choose(style.id)}
            >
              <span className="st-style-card-head">
                <span className="st-style-card-label">{style.label}</span>
                {selected ? (
                  <span className="st-style-check" aria-hidden>
                    <Check size={11} strokeWidth={2.2} />
                  </span>
                ) : null}
              </span>
              <span className="st-style-card-desc">
                {style.id === 'custom' && settings.answerStyleCustom.trim()
                  ? settings.answerStyleCustom.trim().slice(0, 72)
                  : style.summary}
              </span>
              {style.id === 'custom' ? (
                <span className="st-style-card-meta mono">
                  {settings.answerStyleCustom.trim() ? '已填写' : '待填写'}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {settings.answerStyle === 'custom' ? (
        <div className="st-style-custom">
          <div className="st-style-custom-head">
            <label className="st-field-label" htmlFor="st-answer-style-custom">
              你的偏好
            </label>
            <span className={['st-style-custom-count mono', customDirty ? 'is-dirty' : ''].join(' ')}>
              {custom.length}/{ANSWER_STYLE_MAX_CUSTOM}
              {customDirty ? ' · 未保存' : ''}
            </span>
          </div>
          <textarea
            id="st-answer-style-custom"
            className="st-style-textarea"
            value={custom}
            maxLength={ANSWER_STYLE_MAX_CUSTOM}
            rows={5}
            placeholder="例如：像给同事讲方案一样，先说结论；涉及数字时给出处；不要用客套话；每段不超过三句。"
            onChange={(event) => setCustom(event.target.value)}
            onBlur={() => {
              if (customDirty) void saveCustom()
            }}
          />
          <div className="st-style-custom-foot">
            <p className="st-hint">
              写清语气、长度和格式偏好即可。留空时按「平衡」风格回答。
            </p>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void saveCustom()}
              disabled={!customDirty || saving}
            >
              {saving ? '保存中…' : '保存偏好'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="st-style-foot">
        <span className="mono">当前：{answerStyleLabel(settings.answerStyle)}</span>
        <button
          type="button"
          className="st-style-reset"
          onClick={() => void reset()}
          disabled={settings.answerStyle === 'balanced' && !settings.answerStyleCustom}
        >
          <RotateCcw size={11} strokeWidth={1.7} aria-hidden />
          恢复默认
        </button>
      </div>

      {error ? <p className="st-error" role="alert">{error}</p> : null}
    </div>
  )
}
