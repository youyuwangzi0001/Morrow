// 任务经验：任务完成后自动记录的可检索经历，和长期记忆（始终参考）分工不同。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, History, RefreshCw, Trash2 } from 'lucide-react'
import type { MemoryScope, TaskEpisode } from './memory-api'
import { EPISODE_CHANGED_EVENT } from '@shared/memory'
import { memoryApi, formatMemoryTime } from './memory-api'
import { useAppStore } from '../../store'
import { Badge, Button, EmptyHint, ErrorNote, IconButton, Spinner } from '../../ui'
import { errorText } from '../../lib'

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
