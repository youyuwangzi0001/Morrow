/**
 * 回答设置：回答风格 + 发送方式 + 自动命名 + 完成通知。
 * 选择会写入设置，主进程在下一轮运行时把回答风格拼进 system prompt。
 */
import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { ANSWER_STYLES, ANSWER_STYLE_MAX_CUSTOM } from '@shared/answer-style'
import type { AnswerStyleId } from '@shared/types'
import { useAppStore } from '../../state/store'
import { Button, Segmented, Switch } from '../../ui'
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

  const patch = async (value: Parameters<typeof updateSettings>[0]): Promise<void> => {
    setError(null)
    try {
      await updateSettings(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    }
  }

  const choose = (id: AnswerStyleId): void => {
    if (id !== settings.answerStyle) void patch({ answerStyle: id })
  }

  const saveCustom = async (): Promise<void> => {
    if (saving || resettingRef.current) return
    setSaving(true)
    setError(null)
    try {
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

  const selected = ANSWER_STYLES.find((style) => style.id === settings.answerStyle) ?? ANSWER_STYLES[0]
  const customDirty = custom !== settings.answerStyleCustom

  return (
    <div className="st-style">
      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">回答风格</span>
          <span className="st-setting-desc">{selected.summary} 对之后所有对话生效。</span>
        </div>
        <Segmented
          ariaLabel="全局回答风格"
          value={settings.answerStyle}
          options={ANSWER_STYLES.map((style) => ({ value: style.id, label: style.label, description: style.summary }))}
          onChange={choose}
        />
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
            rows={3}
            placeholder="例如：像给同事讲方案一样，先说结论；涉及数字时给出处；不要用客套话。"
            onChange={(event) => setCustom(event.target.value)}
            onBlur={() => {
              if (customDirty) void saveCustom()
            }}
          />
          <div className="st-style-custom-foot">
            <p className="st-hint">留空时按「平衡」风格回答。</p>
            <Button size="sm" variant="primary" onClick={() => void saveCustom()} disabled={!customDirty || saving}>
              {saving ? '保存中…' : '保存偏好'}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">发送键</span>
          <span className="st-setting-desc">选择 Enter 还是 Ctrl+Enter 发送消息。</span>
        </div>
        <Segmented
          ariaLabel="发送键"
          value={settings.sendKey}
          options={[
            { value: 'enter', label: 'Enter' },
            { value: 'ctrl+enter', label: 'Ctrl+Enter' }
          ]}
          onChange={(next) => void patch({ sendKey: next })}
        />
      </div>

      <div className="st-setting-row">
        <div className="st-setting-copy">
          <span className="st-setting-label">运行中发送</span>
          <span className="st-setting-desc">插话会停止当前任务并立即按新内容继续；排队会在本轮结束后发送。闪电按钮始终插话，箭头按钮始终排队。</span>
        </div>
        <Segmented
          ariaLabel="运行中发送方式"
          value={settings.runningSendMode}
          options={[
            { value: 'steer', label: '插话' },
            { value: 'queue', label: '排队' }
          ]}
          onChange={(next) => void patch({ runningSendMode: next })}
        />
      </div>

      <Switch
        checked={settings.autoTitle}
        onChange={(next) => void patch({ autoTitle: next })}
        label="自动命名对话"
        description="用第一条消息给对话起一个短标题"
      />
      <Switch
        checked={settings.notifyOnFinish}
        onChange={(next) => void patch({ notifyOnFinish: next })}
        label="任务完成时通知我"
        description="窗口不在前台时，完成/失败/需要审批会发系统通知。"
      />

      <div className="st-style-foot">
        <span className="mono">当前：{selected.label}</span>
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
