// memory 功能域组件：由 3 个 TSX 文件扁平合并。
import './memory.css'
import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { Brain, Check, ChevronDown, RefreshCw, Sparkles, Wrench, ArrowUpRight, History, Trash2, Download, Eye, Folder, Globe, Pencil, Plus, Search } from 'lucide-react'
import type { EvolutionAppliedTarget, EvolutionListResult, EvolutionSuggestion } from '@shared/contracts'
import { EVOLUTION_SKIP_LABEL, EPISODE_CHANGED_EVENT } from '@shared/contracts'
import { useAppStore } from '../store'
import { Badge, Button, Spinner, EmptyHint, ErrorNote, IconButton, Modal, Segmented, TextArea, TextInput } from '../components'
import { openWorkbench } from './workbench-core'
import type { MemoryScope, TaskEpisode, MemoryEntry, EpisodeInjection, MemoryInjection, MemoryListResult } from './memory-core'
import { evolutionApi, formatEvolutionTime, EVOLUTION_CHANGED_EVENT, memoryApi, formatMemoryTime, MEMORY_SOURCE_LABEL, downloadTextFile } from './memory-core'
import { errorText } from '../components'
import { userMessageDisplayText } from '@shared/types'

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

interface MemoryEpisodesProps {
  open: boolean
  scope: MemoryScope
  workspace: string | null
  query: string
  onPromote: (episode: TaskEpisode) => void
  onNotice: (message: string) => void
}

export function MemoryEpisodes({
  open,
  scope,
  workspace,
  query,
  onPromote,
  onNotice
}: MemoryEpisodesProps): React.JSX.Element {
  const autoCapture = useAppStore((state) => state.settings.episodeMemoryEnabled)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [data, setData] = useState<{ entries: TaskEpisode[]; stats: { total: number; enabled: number; limit: number } } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'delete' | 'clear'; id?: string } | null>(null)
  const requestToken = useRef(0)

  const canUse = scope === 'global' || Boolean(workspace)

  const load = useCallback(async (): Promise<void> => {
    if (!open || !canUse) {
      setData(null)
      setLoading(false)
      return
    }
    const token = ++requestToken.current
    setLoading(true)
    try {
      const result = await memoryApi.listEpisodes({
        scope,
        workspace: scope === 'project' ? workspace : null,
        includeDisabled: true
      })
      if (token !== requestToken.current) return
      setData(result)
      setError(null)
    } catch (err) {
      if (token !== requestToken.current) return
      setError(errorText(err, '读取任务经验失败'))
    } finally {
      if (token === requestToken.current) setLoading(false)
    }
  }, [open, canUse, scope, workspace])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setConfirm(null)
    setExpandedId(null)
    setNotice(null)
    setError(null)
  }, [scope, workspace])

  useEffect(() => {
    if (!open) return undefined
    const api = window.morrow?.features
    if (!api?.on) return undefined
    return api.on(EPISODE_CHANGED_EVENT, () => void load())
  }, [open, load])

  const entries = useMemo(() => {
    const all = data?.entries ?? []
    const keyword = query.trim().toLowerCase()
    if (!keyword) return all
    return all.filter((entry) =>
      [entry.title, entry.intent, entry.summary, ...entry.tags, ...entry.files, ...entry.tools].some((value) =>
        value.toLowerCase().includes(keyword)
      )
    )
  }, [data, query])

  const stats = data?.stats ?? null

  const toggleAutoCapture = async (): Promise<void> => {
    setError(null)
    try {
      await updateSettings({ episodeMemoryEnabled: !autoCapture })
      setNotice(!autoCapture ? '已开启：完成任务后会自动记录一条任务经验。' : '已暂停自动记录；已有经验仍可用于相关任务。')
    } catch (err) {
      setError(errorText(err, '设置保存失败'))
    }
  }

  const toggle = async (episode: TaskEpisode): Promise<void> => {
    setBusyId(episode.id)
    setError(null)
    try {
      await memoryApi.toggleEpisode({
        scope,
        workspace: scope === 'project' ? workspace : null,
        id: episode.id,
        enabled: !episode.enabled
      })
      await load()
    } catch (err) {
      setError(errorText(err, '切换任务经验失败'))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusyId(id)
    setError(null)
    try {
      await memoryApi.removeEpisode({ scope, workspace: scope === 'project' ? workspace : null, id })
      setConfirm(null)
      if (expandedId === id) setExpandedId(null)
      setNotice('已删除这条任务经验')
      await load()
    } catch (err) {
      setError(errorText(err, '删除任务经验失败'))
    } finally {
      setBusyId(null)
    }
  }

  const clear = async (): Promise<void> => {
    setBusyId('__clear__')
    setError(null)
    try {
      const result = await memoryApi.clearEpisodes({
        scope,
        workspace: scope === 'project' ? workspace : null
      })
      setConfirm(null)
      setNotice(`已清空 ${result.removed} 条任务经验`)
      await load()
    } catch (err) {
      setError(errorText(err, '清空任务经验失败'))
    } finally {
      setBusyId(null)
    }
  }

  const promote = (episode: TaskEpisode): void => {
    onPromote(episode)
    onNotice('已填入长期记忆；保存后会一直参考。')
  }

  if (!canUse) {
    return (
      <ErrorNote
        title="还没有选择文件夹"
        detail="任务经验跟随文件夹保存。先在左侧选择一个文件夹，或切到「全局记忆」。"
      />
    )
  }

  return (
    <div className="mc-episodes">
      <div className="mc-episodes-head">
        <span className="mc-episodes-icon" aria-hidden>
          <History size={13} strokeWidth={1.6} />
        </span>
        <span className="mc-episodes-title">任务经验</span>
        <span className="mc-episodes-desc">任务完成后自动记录；只在相关任务中查找。</span>
        <span className="mc-top-spacer" />
        <span className="mc-episodes-auto-label">自动记录</span>
        <button
          type="button"
          role="switch"
          aria-checked={autoCapture}
          aria-label="任务完成后自动记录任务经验"
          className={['mc-toggle', autoCapture ? 'is-on' : ''].filter(Boolean).join(' ')}
          onClick={() => void toggleAutoCapture()}
        >
          <span className="mc-toggle-thumb" />
        </button>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={13} strokeWidth={1.6} aria-hidden />}
          onClick={() => void load()}
        >
          刷新
        </Button>
      </div>

      {stats ? (
        <div className="mc-stats" role="status" aria-label="任务经验统计">
          <Badge tone="neutral">共 {stats.total} 条</Badge>
          <Badge tone="success">会被参考 {stats.enabled}</Badge>
          <span className="mc-episodes-hint">最多保留 {stats.limit} 条 · 只把最相关的几条带进对话</span>
        </div>
      ) : null}

      {notice ? (
        <p className="mc-notice" role="status">
          <Check size={12} strokeWidth={2} aria-hidden /> {notice}
        </p>
      ) : null}
      {error ? (
        <ErrorNote
          title="操作失败"
          detail={error}
          action={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : null}

      {confirm ? (
        <div className="mc-confirm" role="alertdialog" aria-label="确认操作">
          <span>
            {confirm.kind === 'clear'
              ? `确定清空全部任务经验吗？长期记忆、项目规则和技能不会受影响。`
              : '确定删除这条任务经验吗？删除后它不会再用于相关任务。'}
          </span>
          <div className="mc-confirm-actions">
            <Button variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={busyId !== null}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busyId !== null}
              onClick={() => (confirm.kind === 'clear' ? void clear() : void remove(confirm.id ?? ''))}
            >
              确认{confirm.kind === 'clear' ? '清空' : '删除'}
            </Button>
          </div>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="mc-loading">
          <Spinner label="读取任务经验" /> 读取中…
        </div>
      ) : entries.length === 0 ? (
        <EmptyHint>
          {query.trim()
            ? `没有匹配「${query.trim()}」的任务经验。`
            : autoCapture
              ? '还没有任务经验。完成一轮有实际产出的任务后，会自动记录在这里。'
              : '自动记录已暂停。完成任务后不会新增经验；已有经验仍可用于相关任务。'}
        </EmptyHint>
      ) : (
        <>
          <ul className="mc-episode-list" aria-label="任务经验列表">
            {entries.map((episode) => {
              const expanded = expandedId === episode.id
              const busy = busyId === episode.id
              return (
                <li key={episode.id} className={['mc-episode', expanded ? 'is-open' : '', episode.enabled ? '' : 'is-disabled'].filter(Boolean).join(' ')}>
                  <button
                    type="button"
                    className="mc-episode-head"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? '收起' : '查看'} ${episode.title} 的任务经验详情`}
                    onClick={() => setExpandedId(expanded ? null : episode.id)}
                  >
                    <span className="mc-episode-title truncate">{episode.title}</span>
                    <span className={`mc-episode-outcome is-${episode.outcome}`}>
                      {episode.outcome === 'failed' ? '未完成' : '已完成'}
                    </span>
                    {!episode.enabled ? <span className="mc-episode-off">不会参考</span> : null}
                    <time className="mc-episode-time mono" dateTime={new Date(episode.createdAt).toISOString()}>
                      {formatMemoryTime(episode.createdAt)}
                    </time>
                    <ChevronDown size={12} strokeWidth={1.6} className="mc-episode-chevron" aria-hidden />
                  </button>
                  <p className="mc-episode-summary">{episode.summary}</p>
                  {expanded ? (
                    <div className="mc-episode-detail">
                      {episode.intent ? (
                        <div className="mc-episode-block">
                          <span>当时目标</span>
                          <p>{episode.intent}</p>
                        </div>
                      ) : null}
                      <div className="mc-episode-block">
                        <span>结果</span>
                        <p>{episode.summary}</p>
                      </div>
                      {episode.files.length > 0 ? (
                        <div className="mc-episode-block">
                          <span>文件</span>
                          <p className="mono">{episode.files.join(' · ')}</p>
                        </div>
                      ) : null}
                      {episode.tools.length > 0 ? (
                        <div className="mc-episode-block">
                          <span>工具</span>
                          <p className="mono">{episode.tools.join(' · ')}</p>
                        </div>
                      ) : null}
                      <p className="mc-episode-source">
                        来自《{episode.sourceSessionTitle || '最近的任务'}》 · {formatMemoryTime(episode.createdAt)}
                        {episode.tags.length > 0 ? ` · ${episode.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
                      </p>
                    </div>
                  ) : null}
                  <div className="mc-episode-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<ArrowUpRight size={12} strokeWidth={1.6} aria-hidden />}
                      onClick={() => promote(episode)}
                    >
                      保存为长期记忆
                    </Button>
                    <span className="mc-top-spacer" />
                    <button
                      type="button"
                      role="switch"
                      aria-checked={episode.enabled}
                      aria-label={episode.enabled ? '停用这条任务经验' : '启用这条任务经验'}
                      title={episode.enabled ? '用于相关任务；关闭后不再参考' : '重新用于相关任务'}
                      className={['mc-toggle', episode.enabled ? 'is-on' : ''].filter(Boolean).join(' ')}
                      disabled={busy}
                      onClick={() => void toggle(episode)}
                    >
                      <span className="mc-toggle-thumb" />
                    </button>
                    <IconButton
                      label="删除这条任务经验"
                      size={26}
                      tone="danger"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: 'delete', id: episode.id })}
                    >
                      <Trash2 size={12} strokeWidth={1.6} aria-hidden />
                    </IconButton>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="mc-episode-foot">
            <span className="mc-episodes-hint">任务经验是“做过什么”的记录，不会覆盖长期记忆或项目规则。</span>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 size={13} strokeWidth={1.6} aria-hidden />}
              disabled={!stats || stats.total === 0 || busyId !== null}
              onClick={() => setConfirm({ kind: 'clear' })}
            >
              清空任务经验
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export interface MemoryCenterProps {
  open: boolean
  onClose: () => void
  /** 可选：覆盖当前文件夹；不传时自动取当前对话文件夹 / 最近文件夹 */
  workspace?: string | null
}

const SCOPE_OPTIONS: { value: MemoryScope; label: string; description: string }[] = [
  { value: 'project', label: '项目记忆', description: '跟随当前文件夹，只在当前项目里生效' },
  { value: 'global', label: '全局记忆', description: '跨项目生效，例如「始终用简体中文回答」' }
]

type MemoryLayer = 'long' | 'episodes'

const LAYER_OPTIONS: { value: MemoryLayer; label: string; description: string }[] = [
  { value: 'long', label: '长期记忆', description: '始终参考的偏好、约束和项目事实' },
  { value: 'episodes', label: '任务经验', description: '任务完成后自动记录，只在相关任务中查找' }
]

function parseTags(input: string): string[] {
  return input
    .split(/[,，\s#]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
}

function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

export function MemoryCenter({ open, onClose, workspace: workspaceProp }: MemoryCenterProps): React.JSX.Element {
  const storeWorkspace = useAppStore((s) => s.session?.workspace ?? s.settings.lastWorkspace)
  const workspace = workspaceProp !== undefined ? workspaceProp : storeWorkspace
  const lastUserQuery = useAppStore((s) => {
    const messages = s.session?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === 'user' && !message.hidden) return userMessageDisplayText(message).trim()
    }
    return ''
  })

  const [layer, setLayer] = useState<MemoryLayer>('long')
  const [scope, setScope] = useState<MemoryScope>('project')
  const [data, setData] = useState<MemoryListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editTags, setEditTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    kind: 'delete' | 'clear'
    id?: string
    scope: MemoryScope
    workspace: string | null
  } | null>(null)
  const [injection, setInjection] = useState<MemoryInjection | null>(null)
  const [episodeInjection, setEpisodeInjection] = useState<EpisodeInjection | null>(null)
  const [showInjection, setShowInjection] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // 防止范围/工作区切换后，旧请求的晚到结果覆盖新范围的数据
  const scopeRef = useRef(scope)
  const workspaceRef = useRef(workspace)
  scopeRef.current = scope
  workspaceRef.current = workspace
  const listToken = useRef(0)
  const injectionToken = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    if (!open || layer !== 'long') return
    // 旧的 load 闭包（例如变更后的跟随刷新）在当前范围已切换时直接放弃
    if (scope !== scopeRef.current || workspace !== workspaceRef.current) return
    if (scope === 'project' && !workspace) {
      listToken.current += 1
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const token = ++listToken.current
    setData(null)
    setLoading(true)
    setError(null)
    try {
      const result = await memoryApi.list({
        scope,
        workspace: scope === 'project' ? workspace : null,
        includeDisabled: true
      })
      if (token !== listToken.current || scope !== scopeRef.current || workspace !== workspaceRef.current) return
      setData(result)
    } catch (err) {
      if (token !== listToken.current || scope !== scopeRef.current || workspace !== workspaceRef.current) return
      setError(errorText(err, '读取记忆失败'))
    } finally {
      if (token === listToken.current) setLoading(false)
    }
  }, [open, layer, scope, workspace])

  const loadInjection = useCallback(async (): Promise<void> => {
    const token = ++injectionToken.current
    try {
      const [memory, episodes] = await Promise.all([
        memoryApi.injection({ workspace: workspace ?? null, maxTokens: 600 }),
        memoryApi.episodeInjection({ workspace: workspace ?? null, query: lastUserQuery, maxTokens: 320 })
      ])
      if (token !== injectionToken.current || workspace !== workspaceRef.current) return
      setInjection(memory)
      setEpisodeInjection(episodes)
    } catch {
      if (token === injectionToken.current && workspace === workspaceRef.current) {
        setInjection(null)
        setEpisodeInjection(null)
      }
    }
  }, [workspace, lastUserQuery])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!open) return
    void loadInjection()
  }, [open, loadInjection, data])

  const resetTransient = (): void => {
    setConfirm(null)
    setEditingId(null)
    setAdding(false)
    setDraftText('')
    setDraftTags('')
    setEditText('')
    setEditTags('')
    setNotice(null)
    setError(null)
  }

  const changeScope = (next: MemoryScope): void => {
    if (next === scope) return
    // 确认框/编辑态属于旧范围，必须同步清掉，避免把「清空项目记忆」作用到全局范围
    setScope(next)
    resetTransient()
    setQuery('')
  }

  const changeLayer = (next: MemoryLayer): void => {
    if (next === layer) return
    resetTransient()
    setQuery('')
    setShowInjection(false)
    setLayer(next)
  }

  const promoteEpisode = (episode: TaskEpisode): void => {
    setLayer('long')
    setScope(episode.scope)
    setAdding(true)
    setEditingId(null)
    setDraftText(
      [episode.title, episode.intent, episode.summary].filter(Boolean).join('\n\n').slice(0, 4000)
    )
    setDraftTags(episode.tags.join('，'))
    setNotice('已填入任务经验；保存后会成为长期记忆。')
    setError(null)
  }

  useEffect(() => {
    setConfirm(null)
    setEditingId(null)
    setAdding(false)
    setNotice(null)
    setError(null)
  }, [workspace])

  const entries = useMemo(() => {
    const all = data?.entries ?? []
    const keyword = query.trim().toLowerCase()
    if (!keyword) return all
    return all.filter(
      (entry) =>
        entry.text.toLowerCase().includes(keyword) || entry.tags.some((tag) => tag.toLowerCase().includes(keyword))
    )
  }, [data, query])

  const scopeLabel = scope === 'project' ? '项目记忆' : '全局记忆'
  const stats = data?.stats ?? null
  const canWrite = scope === 'global' || !!workspace

  const resetDraft = (): void => {
    setAdding(false)
    setDraftText('')
    setDraftTags('')
    setNotice(null)
  }

  const submitAdd = async (): Promise<void> => {
    if (!canWrite) return
    const text = draftText.trim()
    if (!text) {
      setError('先写点什么再保存。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await memoryApi.add({
        scope,
        workspace: scope === 'project' ? workspace : null,
        text,
        tags: parseTags(draftTags)
      })
      resetDraft()
      setNotice('已保存这条记忆')
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '保存记忆失败'))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (entry: MemoryEntry): void => {
    setAdding(false)
    setEditingId(entry.id)
    setEditText(entry.text)
    setEditTags(entry.tags.join('，'))
    setError(null)
  }

  const submitEdit = async (entry: MemoryEntry): Promise<void> => {
    setBusyId(entry.id)
    setError(null)
    try {
      await memoryApi.update({
        scope,
        workspace: scope === 'project' ? workspace : null,
        id: entry.id,
        text: editText,
        tags: parseTags(editTags)
      })
      setEditingId(null)
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '保存修改失败'))
    } finally {
      setBusyId(null)
    }
  }

  const toggleEntry = async (entry: MemoryEntry): Promise<void> => {
    setBusyId(entry.id)
    setError(null)
    try {
      await memoryApi.toggle({
        scope,
        workspace: scope === 'project' ? workspace : null,
        id: entry.id,
        enabled: !entry.enabled
      })
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '切换启用状态失败'))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!confirm) return
    // 使用打开确认框时捕获的范围，避免用户在请求期间切范围导致清错数据
    const targetScope = confirm.scope
    const targetWorkspace = confirm.workspace
    const targetLabel = targetScope === 'project' ? '项目记忆' : '全局记忆'
    setBusy(true)
    setError(null)
    try {
      if (confirm.kind === 'delete' && confirm.id) {
        await memoryApi.remove({ scope: targetScope, workspace: targetWorkspace, id: confirm.id })
        setNotice('已删除这条记忆')
      } else if (confirm.kind === 'clear') {
        const result = await memoryApi.clear({ scope: targetScope, workspace: targetWorkspace })
        setNotice(`已清空 ${result.removed} 条${targetLabel}`)
      }
      setConfirm(null)
      await load()
      await loadInjection()
    } catch (err) {
      setError(errorText(err, '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  const exportMemory = async (format: 'markdown' | 'json'): Promise<void> => {
    setError(null)
    try {
      const result = await memoryApi.exportMemory({ scope, workspace: scope === 'project' ? workspace : null })
      if (format === 'markdown') {
        downloadTextFile(result.fileName, result.markdown)
      } else {
        downloadTextFile(result.fileName.replace(/\.md$/, '.json'), result.json, 'application/json;charset=utf-8')
      }
      setNotice(`已导出 ${result.count} 条${scopeLabel}`)
    } catch (err) {
      setError(errorText(err, '导出失败'))
    }
  }

  const togglePreview = async (): Promise<void> => {
    const next = !showInjection
    setShowInjection(next)
    if (next) await loadInjection()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记忆"
      description="长期记忆会一直参考；任务经验会自动记录，只在相关任务中查找；Morrow 的建议只有你采纳后才会写入。它们都不会被当作指令或授权。"
      width={900}
      ariaLabel="记忆"
      footer={
        <footer className="mc-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      }
    >
      <div className="mc-root">
        <div className="mc-top">
          <Segmented ariaLabel="记忆类型" value={layer} options={LAYER_OPTIONS} onChange={changeLayer} />
          <Segmented ariaLabel="记忆范围" value={scope} options={SCOPE_OPTIONS} onChange={changeScope} />
          {scope === 'project' ? (
            <span className="mc-workspace mono" title={workspace ?? '未选择文件夹'}>
              <Folder size={12} strokeWidth={1.5} aria-hidden />
              {workspace ? shortenPath(workspace) : '未选择文件夹'}
            </span>
          ) : (
            <span className="mc-workspace mono">
              <Globe size={12} strokeWidth={1.5} aria-hidden />
              跨项目
            </span>
          )}
          <div className="mc-top-spacer" />
          <div className="mc-search">
            <Search size={13} strokeWidth={1.5} aria-hidden />
            <TextInput
              aria-label={layer === 'long' ? '搜索长期记忆' : '搜索任务经验'}
              placeholder={layer === 'long' ? '搜索记忆内容或标签…' : '搜索任务标题、结果或文件…'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {layer === 'long' ? (
            <Button
              variant="gold"
              size="sm"
              icon={<Plus size={13} strokeWidth={1.8} aria-hidden />}
              disabled={!canWrite}
              onClick={() => (adding ? resetDraft() : setAdding(true))}
            >
              {adding ? '收起' : '添加记忆'}
            </Button>
          ) : null}
        </div>

        <EvolutionSuggestions open={open} workspace={workspace} onMemoryApplied={() => void load()} />

        {layer === 'episodes' ? (
          <MemoryEpisodes
            open={open}
            scope={scope}
            workspace={workspace}
            query={query}
            onPromote={promoteEpisode}
            onNotice={setNotice}
          />
        ) : (
          <>
        {!canWrite ? (
          <ErrorNote
            title="还没有选择文件夹"
            detail="项目记忆跟随文件夹。先在左侧选择一个文件夹，或切到「全局记忆」。"
            action={
              <Button variant="ghost" size="sm" onClick={() => changeScope('global')}>
                去全局记忆
              </Button>
            }
          />
        ) : null}

        {stats ? (
          <div className="mc-stats" role="status" aria-label="记忆统计">
            <Badge tone="neutral">共 {stats.total} 条</Badge>
            <Badge tone="success">启用 {stats.enabled}</Badge>
            {stats.disabled > 0 ? <Badge tone="neutral">停用 {stats.disabled}</Badge> : null}
            <span title="仅统计当前范围；实际会带进对话的内容见「会参考的内容」">
              <Badge tone="gold">启用条目约 {stats.enabledTokens} tokens</Badge>
            </span>
            {stats.migratedTotal > 0 ? (
              <span className="mc-legacy-hint">旧记忆已迁移 {stats.migratedTotal} 条</span>
            ) : null}
          </div>
        ) : null}

        <div className="mc-actions">
          <Button
            variant="ghost"
            size="sm"
            icon={<Eye size={13} strokeWidth={1.6} aria-hidden />}
            aria-label="Morrow 会参考的内容"
            aria-pressed={showInjection}
            onClick={() => void togglePreview()}
          >
            {showInjection ? '收起会用到哪些记忆' : '查看会用到哪些记忆'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Download size={13} strokeWidth={1.6} aria-hidden />}
            onClick={() => void exportMemory('markdown')}
          >
            导出 Markdown
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void exportMemory('json')}>
            导出 JSON
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={13} strokeWidth={1.6} aria-hidden />}
            onClick={() => void load()}
          >
            刷新
          </Button>
          <div className="mc-actions-spacer" />
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={13} strokeWidth={1.6} aria-hidden />}
            disabled={!stats || stats.total === 0}
            onClick={() => setConfirm({ kind: 'clear', scope, workspace: scope === 'project' ? workspace : null })}
          >
            清空{scopeLabel}
          </Button>
        </div>

        {notice ? (
          <p className="mc-notice" role="status">
            <Check size={12} strokeWidth={2} aria-hidden /> {notice}
          </p>
        ) : null}
        {error ? <ErrorNote title="操作失败" detail={error} action={<Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>} /> : null}

        {showInjection && injection ? (
          <section className="mc-injection" aria-label="Morrow 会参考的内容">
            <header className="mc-injection-head">
              <Brain size={13} strokeWidth={1.6} aria-hidden />
              <span>会参考的内容</span>
              <span className="mono">
                长期记忆 {injection.included}/{injection.totalEnabled} · {injection.usedTokens} tokens · 任务经验{' '}
                {episodeInjection?.included ?? 0} 条
                {injection.omitted > 0 ? ` · ${injection.omitted} 条记忆因篇幅未使用` : ''}
              </span>
            </header>
            <p className="mc-injection-label">长期记忆</p>
            <pre className="mc-injection-text">
              {injection.text || '（当前没有已启用的长期记忆）'}
            </pre>
            {episodeInjection?.text ? (
              <>
                <p className="mc-injection-label">相关任务经验</p>
                <pre className="mc-injection-text">{episodeInjection.text}</pre>
              </>
            ) : (
              <p className="mc-injection-empty-note">这次没有找到可参考的任务经验。</p>
            )}
          </section>
        ) : null}

        {adding ? (
          <form
            className="mc-add"
            onSubmit={(event) => {
              event.preventDefault()
              void submitAdd()
            }}
          >
            <TextArea
              label={scope === 'project' ? '新的项目记忆' : '新的全局记忆'}
              placeholder="例：周报按季度口径汇总；数字保留两位小数。"
              rows={3}
              value={draftText}
              maxLength={4000}
              onChange={(event) => setDraftText(event.target.value)}
              autoFocus
            />
            <div className="mc-add-row">
              <TextInput
                label="标签（可选，逗号分隔，最多 8 个）"
                placeholder="报表, 口径"
                value={draftTags}
                onChange={(event) => setDraftTags(event.target.value)}
              />
              <div className="mc-add-actions">
                <Button variant="ghost" type="button" onClick={resetDraft}>
                  取消
                </Button>
                <Button variant="gold" type="submit" loading={busy} disabled={!draftText.trim()}>
                  保存记忆
                </Button>
              </div>
            </div>
          </form>
        ) : null}

        {confirm ? (
          <div className="mc-confirm" role="alertdialog" aria-label="确认操作">
            <span>
              {confirm.kind === 'clear'
                ? `确定清空全部${confirm.scope === 'project' ? '项目记忆' : '全局记忆'}吗？清空后旧版本迁移过来的内容不会自动恢复。`
                : '确定删除这条记忆吗？'}
            </span>
            <div className="mc-confirm-actions">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button variant="danger" size="sm" loading={busy} onClick={() => void confirmDelete()}>
                {confirm.kind === 'clear' ? '确认清空' : '确认删除'}
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="mc-loading">
            <Spinner label="读取记忆" /> 读取中…
          </div>
        ) : entries.length === 0 ? (
          <EmptyHint>
            {query.trim()
              ? `没有匹配「${query.trim()}」的记忆。`
              : scope === 'project'
                ? '这个项目还没有记忆。Morrow 记录的内容，或你自己添加的内容，都会出现在这里。'
                : '还没有全局记忆。可以记录跨项目都适用的偏好，例如输出语言、格式要求。'}
          </EmptyHint>
        ) : (
          <ul className="mc-list" aria-label={`${scopeLabel}列表`}>
            {entries.map((entry) => (
              <li key={entry.id} className={['mc-entry', entry.enabled ? '' : 'is-disabled'].filter(Boolean).join(' ')}>
                <div className="mc-entry-main">
                  {editingId === entry.id ? (
                    <div className="mc-entry-editor">
                      <TextArea
                        label="记忆内容"
                        rows={3}
                        value={editText}
                        maxLength={4000}
                        onChange={(event) => setEditText(event.target.value)}
                        autoFocus
                      />
                      <TextInput
                        label="标签（逗号分隔）"
                        value={editTags}
                        onChange={(event) => setEditTags(event.target.value)}
                      />
                      <div className="mc-entry-editor-actions">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          取消
                        </Button>
                        <Button
                          variant="gold"
                          size="sm"
                          loading={busyId === entry.id}
                          disabled={!editText.trim()}
                          onClick={() => void submitEdit(entry)}
                        >
                          保存修改
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mc-entry-text">{entry.text}</p>
                      <div className="mc-entry-meta">
                        <span className={`mc-source is-${entry.source}`}>{MEMORY_SOURCE_LABEL[entry.source]}</span>
                        <span className="mc-dot" aria-hidden>
                          ·
                        </span>
                        <time dateTime={new Date(entry.createdAt).toISOString()}>{formatMemoryTime(entry.createdAt)}</time>
                        {entry.tags.map((tag) => (
                          <span key={tag} className="mc-tag">
                            #{tag}
                          </span>
                        ))}
                        {!entry.enabled ? <span className="mc-disabled-note">已停用，不会参考</span> : null}
                      </div>
                    </>
                  )}
                </div>
                <div className="mc-entry-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={entry.enabled}
                    aria-label={entry.enabled ? '停用这条记忆' : '启用这条记忆'}
                    title={entry.enabled ? '停用后不会参考' : '启用后会在相关任务中参考'}
                    className={['mc-toggle', entry.enabled ? 'is-on' : ''].filter(Boolean).join(' ')}
                    disabled={busyId === entry.id}
                    onClick={() => void toggleEntry(entry)}
                  >
                    <span className="mc-toggle-thumb" />
                  </button>
                  <IconButton label="编辑这条记忆" size={26} onClick={() => startEdit(entry)}>
                    <Pencil size={12} strokeWidth={1.6} aria-hidden />
                  </IconButton>
                  <IconButton
                    label="删除这条记忆"
                    size={26}
                    tone="danger"
                    onClick={() =>
                      setConfirm({
                        kind: 'delete',
                        id: entry.id,
                        scope,
                        workspace: scope === 'project' ? workspace : null
                      })
                    }
                  >
                    <Trash2 size={12} strokeWidth={1.6} aria-hidden />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
          </>
        )}
      </div>
    </Modal>
  )
}
