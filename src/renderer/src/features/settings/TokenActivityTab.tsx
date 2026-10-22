/**
 * Token 活动：Codex 风格马赛克热力图。
 * 数据来自主进程真实 usage 账本（服务商返回值优先，缺失部分单独标记为本地估算）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { TokenActivitySummary } from '@shared/types'
import { Segmented } from '../../ui'
import { formatExactTokens, formatUsageTokens } from './context-format'
import { addDays, buildMonthLabels, dayKey, dayLabel, diffDays, parseDay, startOfWeek } from '@shared/usage'
import './TokenActivity.css'

type ViewMode = 'day' | 'week' | 'total'

interface Tile {
  key: string
  label: string
  title: string
  tokens: number
  input: number
  output: number
  cache: number
  estimated: number
  level: number
  /** 自网格起点算起的周列（0 = 第一列） */
  weekColumn: number
  /** 0=周一 … 6=周日 */
  weekday: number
  requests?: number
  outside?: boolean
}

const MODE_LABEL: Record<ViewMode, string> = { day: '每天', week: '每周', total: '累计总量' }
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

function levelFor(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (max <= 0) return 1
  const ratio = Math.sqrt(Math.min(1, value / max))
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.78) return 3
  return 4
}

function buildDailyTiles(summary: TokenActivitySummary): { tiles: Tile[]; columns: number; labels: Array<{ column: number; label: string }> } {
  const byDate = new Map(summary.days.map((day) => [day.date, day]))
  if (summary.days.length === 0) return { tiles: [], columns: 0, labels: [] }
  const end = parseDay(summary.days[summary.days.length - 1].date)
  const rangeStart = parseDay(summary.days[0].date)
  const mondayOffset = (rangeStart.getDay() + 6) % 7
  const gridStart = addDays(rangeStart, -mondayOffset)
  const columns = Math.ceil((diffDays(gridStart, end) + 1) / 7)
  const max = Math.max(0, ...summary.days.map((day) => day.totalTokens))
  const tiles: Tile[] = []
  const labels = buildMonthLabels(rangeStart, end)
  for (let column = 0; column < columns; column += 1) {
    const monday = addDays(gridStart, column * 7)
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(monday, row)
      const key = dayKey(date)
      const day = byDate.get(key)
      const outside = date < rangeStart || date > end
      tiles.push({
        key,
        label: dayLabel(date),
        title: day ? `${formatExactTokens(day.totalTokens)} tokens` : '0 tokens',
        tokens: day?.totalTokens ?? 0,
        input: day?.inputTokens ?? 0,
        output: day?.outputTokens ?? 0,
        cache: day?.cacheReadTokens ?? 0,
        estimated: day?.estimatedTokens ?? 0,
        level: levelFor(day?.totalTokens ?? 0, max),
        weekColumn: column,
        weekday: row,
        ...(outside ? { outside: true } : {})
      })
    }
  }
  return { tiles, columns, labels }
}

interface WeekAggregate {
  start: Date
  end: Date
  tokens: number
  input: number
  output: number
  cache: number
  estimated: number
  requests: number
}

interface WeekMetrics {
  weeks: Map<string, WeekAggregate>
  max: number
  rangeStart: Date
}

function buildWeekMetrics(summary: TokenActivitySummary): WeekMetrics {
  const weeks = new Map<string, WeekAggregate>()
  const rangeStart = summary.days.length > 0 ? parseDay(summary.days[0].date) : new Date()
  for (const day of summary.days) {
    const start = startOfWeek(parseDay(day.date))
    const key = dayKey(start)
    const current =
      weeks.get(key) ??
      ({ start, end: addDays(start, 6), tokens: 0, input: 0, output: 0, cache: 0, estimated: 0, requests: 0 } as WeekAggregate)
    current.tokens += day.totalTokens
    current.input += day.inputTokens
    current.output += day.outputTokens
    current.cache += day.cacheReadTokens
    current.estimated += day.estimatedTokens
    current.requests += day.requests
    weeks.set(key, current)
  }
  return { weeks, max: Math.max(0, ...[...weeks.values()].map((week) => week.tokens)), rangeStart }
}

interface CumulativeMetrics {
  byDate: Map<string, number>
  max: number
}

function buildCumulativeMetrics(summary: TokenActivitySummary): CumulativeMetrics {
  const rangeTotal = summary.days.reduce((sum, day) => sum + day.totalTokens, 0)
  // 账本里是最近 365 天；更早的历史只保留在 total 里，作为累计曲线的起点。
  let running = Math.max(0, summary.total - rangeTotal)
  const byDate = new Map<string, number>()
  for (const day of summary.days) {
    running += day.totalTokens
    byDate.set(day.date, running)
  }
  return { byDate, max: Math.max(running, summary.total, 1) }
}

function Tooltip({
  tooltip
}: {
  tooltip: { x: number; y: number; title: string; value: string; detail?: string } | null
}): React.JSX.Element | null {
  if (!tooltip) return null
  return (
    <div className="token-tooltip" style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }} role="status">
      <strong>{tooltip.title}</strong>
      <span className="mono">{tooltip.value}</span>
      {tooltip.detail ? <small>{tooltip.detail}</small> : null}
    </div>
  )
}

export function TokenActivityTab(): React.JSX.Element {
  const [summary, setSummary] = useState<TokenActivitySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('day')
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; value: string; detail?: string } | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.morrow.tokenActivity.get()
      if (!result.ok) throw new Error(result.error.message)
      setSummary(result.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取 Token 活动失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const daily = useMemo(() => (summary ? buildDailyTiles(summary) : { tiles: [], columns: 0, labels: [] }), [summary])
  const weekMetrics = useMemo(
    () => (summary ? buildWeekMetrics(summary) : { weeks: new Map(), max: 0, rangeStart: new Date() }),
    [summary]
  )
  const cumulativeMetrics = useMemo(
    () => (summary ? buildCumulativeMetrics(summary) : { byDate: new Map(), max: 1 }),
    [summary]
  )

  /**
   * 三种统计方式共用同一张「一天一格」的热力图：
   * - 每天：格子值 = 当天用量；
   * - 每周：格子值 = 所在自然周的合计（同一周同色）；
   * - 累计总量：格子值 = 截至当天的历史累计。
   */
  const activeTiles = useMemo(() => {
    if (mode === 'day') return daily.tiles
    return daily.tiles.map((tile) => {
      if (tile.outside) return tile
      const date = parseDay(tile.key)
      if (mode === 'week') {
        const week = weekMetrics.weeks.get(dayKey(startOfWeek(date)))
        if (!week) return tile
        const partial = week.start < weekMetrics.rangeStart
        return {
          ...tile,
          label: `${dayLabel(week.start)}–${dayLabel(week.end)}`,
          title: `${formatExactTokens(week.tokens)} tokens · 该周合计${week.requests ? ` · ${week.requests} 次请求` : ''}${partial ? '（显示范围内）' : ''}`,
          tokens: week.tokens,
          input: week.input,
          output: week.output,
          cache: week.cache,
          estimated: week.estimated,
          requests: week.requests,
          level: levelFor(week.tokens, weekMetrics.max)
        }
      }
      const cumulative = cumulativeMetrics.byDate.get(tile.key) ?? 0
      return {
        ...tile,
        label: `截至 ${dayLabel(date)}`,
        title: `${formatExactTokens(cumulative)} tokens · 累计用量`,
        tokens: cumulative,
        input: 0,
        output: 0,
        cache: 0,
        estimated: 0,
        level: levelFor(cumulative, cumulativeMetrics.max)
      }
    })
  }, [mode, daily.tiles, weekMetrics, cumulativeMetrics])

  const showTooltip = (tile: Tile, currentTarget: HTMLElement): void => {
    const container = gridRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const target = currentTarget.getBoundingClientRect()
    const center = target.left - rect.left + target.width / 2
    // 提示卡最宽 280px；靠近网格边缘时向内收，避免被裁切。
    const x = Math.min(Math.max(center, 144), Math.max(144, rect.width - 144))
    setTooltip({
      x,
      y: target.top - rect.top - 6,
      title: tile.label,
      value: tile.title,
      detail:
        tile.input > 0 || tile.output > 0 || tile.cache > 0 || tile.estimated > 0
          ? [
              tile.input > 0 || tile.output > 0
                ? `输入 ${formatExactTokens(tile.input)} · 输出 ${formatExactTokens(tile.output)}`
                : '',
              tile.cache > 0 ? `其中缓存读取 ${formatExactTokens(tile.cache)}（已含在输入内）` : '',
              tile.estimated > 0 ? `含约 ${formatExactTokens(tile.estimated)} 个估算` : ''
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
    })
  }

  const modeHint =
    mode === 'day'
      ? '鼠标停在格子上，查看当天用量'
      : mode === 'week'
        ? '鼠标停在格子上，查看所在自然周的合计'
        : '鼠标停在格子上，查看截至当天的历史累计'
  const gridHint = `一天一格 · 每列一周（周一→周日）· ${modeHint}`

  return (
    <div className="token-activity">
      <header className="token-activity-head">
        <div>
          <h3 className="token-activity-title">Token 活动</h3>
          <p className="token-activity-sub">按天统计真实 token 用量；服务商没有返回时会标成估算。</p>
        </div>
        <div className="token-activity-head-actions">
          <Segmented
            value={mode}
            options={(Object.keys(MODE_LABEL) as ViewMode[]).map((key) => ({ value: key, label: MODE_LABEL[key] }))}
            onChange={(next) => {
              setMode(next)
              setTooltip(null)
            }}
            ariaLabel="Token 活动视图"
          />
          <button type="button" className="token-refresh" aria-label="刷新 Token 活动" title="刷新" onClick={() => void load()}>
            <RefreshCw size={13} strokeWidth={1.5} className={loading ? 'is-spinning' : ''} aria-hidden />
          </button>
        </div>
      </header>

      {summary ? (
        <div className="token-activity-stats">
          <span>今天 <strong>{formatUsageTokens(summary.today)}</strong></span>
          <span>近 7 天 <strong>{formatUsageTokens(summary.week)}</strong></span>
          <span>近一年 <strong>{formatUsageTokens(summary.yearTotal)}</strong></span>
          <span>累计 <strong>{formatUsageTokens(summary.total)}</strong></span>
          <span>近一年活跃 <strong>{summary.activeDays}</strong> 天</span>
        </div>
      ) : null}

      {summary && summary.total > 0 ? <p className="token-mode-note mono">{gridHint}</p> : null}

      {error ? (
        <div className="token-activity-state is-error" role="alert">
          <strong>Token 活动暂时读不到</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>重试</button>
        </div>
      ) : loading && !summary ? (
        <div className="token-activity-state">正在读取用量账本…</div>
      ) : summary && summary.total === 0 ? (
        <div className="token-activity-state">
          <strong>还没有 Token 记录</strong>
          <span>完成一次真实对话后，这里会按天显示输入、输出与缓存 token。</span>
        </div>
      ) : (
        <>
          <div
            ref={gridRef}
            className="token-mosaic"
            data-mode={mode}
            style={{ '--token-columns': daily.columns } as React.CSSProperties}
            aria-label={
              mode === 'day'
                ? '每天 Token 活动热力图（每列一周，周一到周日，一天一格）'
                : mode === 'week'
                  ? '每周 Token 活动热力图（每列一周，周一到周日，显示周合计）'
                  : '累计 Token 活动热力图（每列一周，周一到周日，显示截至当天累计）'
            }
          >
            {WEEKDAYS.map((label, index) => (
              <span
                key={label}
                className="token-weekday"
                style={{ gridColumn: 1, gridRow: index + 1 }}
                aria-hidden
              >
                {label}
              </span>
            ))}
            {activeTiles.map((tile) => (
              <button
                key={tile.key}
                type="button"
                tabIndex={-1}
                data-date={tile.key}
                data-weekday={tile.weekday + 1}
                style={{ gridColumn: tile.weekColumn + 2, gridRow: tile.weekday + 1 }}
                className={[
                  'token-cell',
                  `level-${tile.level}`,
                  tile.outside ? 'is-outside' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label={`${tile.label}：${tile.title}`}
                onMouseEnter={(event) => showTooltip(tile, event.currentTarget)}
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => showTooltip(tile, event.currentTarget)}
                onBlur={() => setTooltip(null)}
              />
            ))}
            {daily.labels.map((label) => (
              <span
                key={`${label.column}-${label.label}`}
                className={['token-month-label', label.column >= daily.columns - 1 ? 'is-end' : ''].filter(Boolean).join(' ')}
                style={{ gridColumn: label.column + 2, gridRow: 8 }}
                aria-hidden
              >
                {label.label}
              </span>
            ))}
            <Tooltip tooltip={tooltip} />
          </div>

          <footer className="token-activity-foot">
            <div className="token-legend" aria-label="颜色越亮 Token 越多">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <i key={level} className={`token-cell level-${level}`} aria-hidden />
              ))}
              <span>多</span>
            </div>
            {(summary?.estimatedTokens ?? 0) > 0 ? (
              <span className="token-estimated-note">
                近一年有 {formatExactTokens(summary?.estimatedTokens ?? 0)} 个 token 是本地估算（服务商没有返回用量）
              </span>
            ) : (
              <span className="token-estimated-note is-exact">全部来自服务商返回的精确用量</span>
            )}
          </footer>
        </>
      )}
    </div>
  )
}
