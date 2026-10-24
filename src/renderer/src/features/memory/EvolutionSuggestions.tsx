/**
 * 记忆中心顶部的自进化建议区。
 * 自动复盘只在有强信号时运行；建议必须由用户采纳才会写入记忆/技能库。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronDown, RefreshCw, Sparkles, Wrench } from 'lucide-react'
import type {
  EvolutionAppliedTarget,
  EvolutionListResult,
  EvolutionSuggestion
} from '@shared/memory'
import { EVOLUTION_SKIP_LABEL } from '@shared/memory'
import { useAppStore } from '../../store'
import { Badge, Button, Spinner } from '../../ui'
import { openWorkbench } from '../workbench/events'
import { evolutionApi, formatEvolutionTime, EVOLUTION_CHANGED_EVENT } from './memory-api'
import { errorText } from '../../lib'
import './EvolutionSuggestions.css'

interface EvolutionSuggestionsProps {
  open: boolean
  workspace: string | null
  /** 采纳记忆后通知父级刷新当前 scope 列表 */
  onMemoryApplied?: () => void
}



function kindLabel(suggestion: EvolutionSuggestion): string {
  if (suggestion.kind === 'skill') return '技能'
  return suggestion.scope === 'project' ? '项目记忆' : '全局记忆'
}

function actionLabel(suggestion: EvolutionSuggestion): string {
  if (suggestion.kind === 'skill') return suggestion.action === 'update' ? '更新技能' : '新技能'
  return suggestion.action === 'update' ? '更新记忆' : '新记忆'
}

function targetLabel(suggestion: EvolutionSuggestion): string {
  if (suggestion.kind === 'skill') return suggestion.targetId ? '更新已有技能' : '保存为新技能'
  return suggestion.scope === 'project' ? `保存到项目记忆 · ${suggestion.workspace ?? ''}` : '保存到全局记忆'
}

function applyNotice(target: EvolutionAppliedTarget): string {
  return target.kind === 'memory' ? `已保存到记忆：${target.label}` : `已保存为技能：${target.label}`
}

export function EvolutionSuggestions({
  open,
  workspace,
  onMemoryApplied
}: EvolutionSuggestionsProps): React.JSX.Element {
  const session = useAppStore((state) => state.session)
  const running = useAppStore((state) => Boolean(state.run && state.session && state.run.sessionId === state.session.id))
  const enabled = useAppStore((state) => state.settings.evolutionEnabled)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [data, setData] = useState<EvolutionListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [appliedSkill, setAppliedSkill] = useState<EvolutionAppliedTarget | null>(null)
  const tokenRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!open) return
    const token = ++tokenRef.current
    setLoading(true)
    try {
      const result = await evolutionApi.list(workspace)
      if (token !== tokenRef.current) return
      setData(result)
      setError(null)
    } catch (err) {
      if (token !== tokenRef.current) return
      setError(errorText(err, '读取建议失败'))
    } finally {
      if (token === tokenRef.current) setLoading(false)
    }
  }, [open, workspace])

  useEffect(() => {
    if (!open) return
    void load()
    setExpandedId(null)
    setNotice(null)
    setAppliedSkill(null)
  }, [open, load])

  useEffect(() => {
    if (!open) return undefined
    const api = window.morrow?.features
    if (!api?.on) return undefined
    const off = api.on(EVOLUTION_CHANGED_EVENT, () => {
      void load()
    })
    return () => off()
  }, [open, load])

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setError(null)
    setAppliedSkill(null)
    try {
      await updateSettings({ evolutionEnabled: next })
      setNotice(next ? '已开启：完成任务后会自动检查并整理建议。' : '已关闭自动检查，仍可随时点「检查最近对话」。')
    } catch (err) {
      setError(errorText(err, '设置保存失败'))
    }
  }

  const review = async (): Promise<void> => {
    if (!session?.id || reviewing) return
    setReviewing(true)
    setError(null)
    setNotice(null)
    setAppliedSkill(null)
    try {
      const result = await evolutionApi.review(session.id)
      if (result.suggestions.length > 0) {
        setNotice(`发现 ${result.suggestions.length} 条新建议，采纳后才会写入。`)
      } else {
        setNotice(
          result.message ??
            (result.skipped
              ? EVOLUTION_SKIP_LABEL[result.skipped]
              : '这次没有发现值得长期保留的内容。')
        )
      }
      await load()
    } catch (err) {
      setError(errorText(err, '检查失败'))
    } finally {
      setReviewing(false)
    }
  }

  const apply = async (suggestion: EvolutionSuggestion): Promise<void> => {
    if (busyId) return
    setBusyId(suggestion.id)
    setError(null)
    setNotice(null)
    setAppliedSkill(null)
    try {
      const result = await evolutionApi.apply(suggestion.id)
      setNotice(applyNotice(result.target))
      setAppliedSkill(result.target.kind === 'skill' ? result.target : null)
      if (result.target.kind === 'memory') onMemoryApplied?.()
      await load()
    } catch (err) {
      setError(errorText(err, '采纳失败'))
    } finally {
      setBusyId(null)
    }
  }

  const ignore = async (suggestion: EvolutionSuggestion): Promise<void> => {
    if (busyId) return
    setBusyId(suggestion.id)
    setError(null)
    setNotice(null)
    setAppliedSkill(null)
    try {
      await evolutionApi.ignore(suggestion.id)
      setNotice('已忽略这条建议。')
      if (expandedId === suggestion.id) setExpandedId(null)
      await load()
    } catch (err) {
      setError(errorText(err, '忽略失败'))
    } finally {
      setBusyId(null)
    }
  }

  const suggestions = data?.suggestions ?? []
  const canReview = Boolean(session?.id) && !running && !session?.temporary && !reviewing
  const reviewTitle = !session?.id
    ? '先打开一个对话，再检查最近的任务'
    : running
      ? '任务结束后再检查'
      : session?.temporary
        ? '临时对话不参与检查'
        : '用当前对话的模型检查最近的任务'

  return (
    <section className="evo-root" aria-label="Morrow 的建议">
      <div className="evo-head">
        <span className="evo-head-icon" aria-hidden>
          <Sparkles size={13} strokeWidth={1.6} />
        </span>
        <span className="evo-head-title">Morrow 的建议</span>
        {suggestions.length > 0 ? <Badge tone="gold">{suggestions.length} 条待处理</Badge> : null}
        <span className="evo-head-spacer" />
        <span className={`evo-toggle-label ${enabled ? '' : 'is-off'}`}>任务后自动检查</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="任务完成后自动检查对话"
          className={['evo-toggle', enabled ? 'is-on' : ''].filter(Boolean).join(' ')}
          onClick={() => void toggleEnabled(!enabled)}
        >
          <span className="evo-toggle-thumb" />
        </button>
        <Button
          variant="ghost"
          size="sm"
          icon={reviewing ? <Spinner size={12} /> : <RefreshCw size={12} strokeWidth={1.7} aria-hidden />}
          disabled={!canReview}
          title={reviewTitle}
          aria-label="检查最近对话并整理建议"
          onClick={() => void review()}
        >
          {reviewing ? '检查中…' : '检查最近对话'}
        </Button>
      </div>
      <p className="evo-sub">
        {enabled
          ? '完成任务后，Morrow 会回看最近对话，把值得长期保留的偏好、事实和做法放在这里；你采纳后才会写入。'
          : '自动检查已关闭。你可以随时手动检查；建议采纳后才会写入。'}
      </p>

      {error ? (
        <div className="evo-message is-error" role="alert">
          {error}
          <button type="button" className="evo-inline-link" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="evo-message is-ok" role="status">
          <Check size={12} strokeWidth={2} aria-hidden />
          <span>{notice}</span>
          {appliedSkill ? (
            <button
              type="button"
              className="evo-inline-link"
              onClick={() => openWorkbench('skills', workspace ? { workspace } : {})}
            >
              打开技能库
            </button>
          ) : null}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="evo-loading">
          <Spinner size={12} /> 读取中…
        </div>
      ) : suggestions.length === 0 ? (
        <p className="evo-empty">
          {enabled
            ? '还没有待处理建议。完成一趟较长的任务后，Morrow 会自动检查一次。'
            : '自动检查关闭时不会主动出现建议，可点「检查最近对话」。'}
        </p>
      ) : (
        <ul className="evo-list" aria-label="Morrow 的建议列表">
          {suggestions.map((suggestion) => {
            const expanded = expandedId === suggestion.id
            const busy = busyId === suggestion.id
            return (
              <li key={suggestion.id} className={['evo-card', expanded ? 'is-open' : ''].filter(Boolean).join(' ')}>
                <button
                  type="button"
                  className="evo-card-head"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? '收起' : '查看'} ${suggestion.title} 的完整内容`}
                  onClick={() => setExpandedId(expanded ? null : suggestion.id)}
                >
                  <span className={`evo-kind is-${suggestion.kind}`} aria-hidden>
                    {suggestion.kind === 'memory' ? (
                      <Brain size={12} strokeWidth={1.6} />
                    ) : (
                      <Wrench size={12} strokeWidth={1.6} />
                    )}
                  </span>
                  <span className="evo-title truncate">{suggestion.title}</span>
                  <span className={`evo-action is-${suggestion.action}`}>{actionLabel(suggestion)}</span>
                  <span className="evo-scope">{kindLabel(suggestion)}</span>
                  <ChevronDown size={12} strokeWidth={1.6} className="evo-chevron" aria-hidden />
                </button>
                <p className="evo-summary">{suggestion.summary}</p>
                {expanded ? (
                  <div className="evo-detail">
                    <div className="evo-rationale">
                      <span>为什么建议</span>
                      <p>{suggestion.rationale}</p>
                    </div>
                    <pre className="evo-content">{suggestion.content}</pre>
                    <p className="evo-target">
                      {targetLabel(suggestion)} · 可信度 {Math.round(suggestion.confidence * 100)}%
                    </p>
                  </div>
                ) : null}
                <div className="evo-foot">
                  <span className="evo-source truncate" title={suggestion.sourceSessionTitle}>
                    来自《{suggestion.sourceSessionTitle}》 · {formatEvolutionTime(suggestion.createdAt)}
                  </span>
                  <span className="evo-foot-spacer" />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void ignore(suggestion)}
                  >
                    忽略
                  </Button>
                  <Button
                    variant="gold"
                    size="sm"
                    loading={busy}
                    onClick={() => void apply(suggestion)}
                  >
                    采纳
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {data?.lastReviewedAt ? (
        <p className="evo-last">上次检查：{formatEvolutionTime(data.lastReviewedAt)}</p>
      ) : null}
    </section>
  )
}
