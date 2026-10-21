/**
 * Token 活动账本：按本地日期聚合真实 provider usage。
 *
 * - 每次 Agent 运行 / 上下文压缩 / 侧边聊天结束后记录增量；
 * - 历史会话首次升级时按会话累计 usage 回填一次，避免旧数据丢失；
 * - 只存每日聚合，不存逐条请求，文件小且可长期保留；
 * - 纯 Node，便于单测。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TokenActivityDay, TokenActivitySummary } from '../../shared/types'

export type { TokenActivityDay, TokenActivitySummary } from '../../shared/types'

export interface TokenUsageRecord {
  at?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  /** 服务商未返回 usage 时由本地计数器补齐的估算值 */
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
  sessionId?: string
}

export interface LegacySessionUsage {
  id: string
  updatedAt: number
  model: { providerId: string }
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
}

interface DayBucket {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  requests: number
}

interface ActivityStore {
  version: 1
  createdAt: number
  updatedAt: number
  days: Record<string, DayBucket>
  /** 已完成历史回填的会话 id，避免重复累计 */
  legacySessions: string[]
}

const MAX_LEGACY_MARKERS = 50_000

function finiteInt(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
  return Math.max(0, number)
}

/** 本地日期键：用户在哪个时区，就按哪一天归档。 */
export function activityDayKey(at: number | Date): string {
  const date = at instanceof Date ? at : new Date(at)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfLocalDay(at: number | Date): Date {
  const date = at instanceof Date ? new Date(at) : new Date(at)
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function emptyBucket(): DayBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, requests: 0 }
}

function emptyStore(now: number): ActivityStore {
  return { version: 1, createdAt: now, updatedAt: now, days: {}, legacySessions: [] }
}

export class TokenActivityService {
  private readonly file: string
  private readonly now: () => number
  private store: ActivityStore

  constructor(dataDir: string, options: { now?: () => number } = {}) {
    this.file = join(dataDir, 'usage', 'token-activity.json')
    this.now = options.now ?? Date.now
    this.store = this.load()
  }

  private load(): ActivityStore {
    if (!existsSync(this.file)) return emptyStore(this.now())
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ActivityStore>
      const days: Record<string, DayBucket> = {}
      for (const [key, value] of Object.entries(parsed.days ?? {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue
        const bucket = value as Partial<DayBucket>
        days[key] = {
          inputTokens: finiteInt(bucket.inputTokens),
          outputTokens: finiteInt(bucket.outputTokens),
          cacheReadTokens: finiteInt(bucket.cacheReadTokens),
          estimatedInputTokens: finiteInt(bucket.estimatedInputTokens),
          estimatedOutputTokens: finiteInt(bucket.estimatedOutputTokens),
          requests: finiteInt(bucket.requests)
        }
      }
      return {
        version: 1,
        createdAt: finiteInt(parsed.createdAt) || this.now(),
        updatedAt: finiteInt(parsed.updatedAt) || this.now(),
        days,
        legacySessions: Array.isArray(parsed.legacySessions)
          ? parsed.legacySessions.filter((item): item is string => typeof item === 'string').slice(0, MAX_LEGACY_MARKERS)
          : []
      }
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}.bak`)
      } catch {
        // 备份失败不阻断启动
      }
      return emptyStore(this.now())
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const content = JSON.stringify(this.store)
    try {
      writeFileSync(tmp, content, 'utf8')
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // ignore
      }
      throw err
    }
    // Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        renameSync(tmp, this.file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
          try {
            rmSync(tmp, { force: true })
          } catch {
            // ignore
          }
          throw err
        }
        if (attempt === 3) {
          try {
            writeFileSync(this.file, content, 'utf8')
            rmSync(tmp, { force: true })
            return
          } catch (writeErr) {
            try {
              rmSync(tmp, { force: true })
            } catch {
              // ignore
            }
            throw writeErr
          }
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
      }
    }
  }

  private addDay(
    at: number,
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      estimatedInputTokens?: number
      estimatedOutputTokens?: number
    },
    requests: number
  ): void {
    const key = activityDayKey(at)
    const bucket = this.store.days[key] ?? emptyBucket()
    bucket.inputTokens += usage.inputTokens
    bucket.outputTokens += usage.outputTokens
    bucket.cacheReadTokens += usage.cacheReadTokens
    bucket.estimatedInputTokens += finiteInt(usage.estimatedInputTokens)
    bucket.estimatedOutputTokens += finiteInt(usage.estimatedOutputTokens)
    bucket.requests += Math.max(0, requests)
    this.store.days[key] = bucket
  }

  /** 清除全部对话时一并清空用量账本。 */
  reset(): void {
    this.store = emptyStore(this.now())
    this.persist()
  }

  /** 记录一次真实请求增量；同一会话会被标记，后续历史回填不会再加一次。 */
  record(input: TokenUsageRecord): void {
    const inputTokens = finiteInt(input.inputTokens)
    const outputTokens = finiteInt(input.outputTokens)
    const cacheReadTokens = finiteInt(input.cacheReadTokens)
    const estimatedInputTokens = finiteInt(input.estimatedInputTokens)
    const estimatedOutputTokens = finiteInt(input.estimatedOutputTokens)
    if (input.sessionId && !this.store.legacySessions.includes(input.sessionId)) {
      this.store.legacySessions.push(input.sessionId)
      if (this.store.legacySessions.length > MAX_LEGACY_MARKERS) {
        this.store.legacySessions = this.store.legacySessions.slice(-MAX_LEGACY_MARKERS)
      }
    }
    if (inputTokens + outputTokens + cacheReadTokens + estimatedInputTokens + estimatedOutputTokens <= 0) return
    this.addDay(
      input.at ?? this.now(),
      { inputTokens, outputTokens, cacheReadTokens, estimatedInputTokens, estimatedOutputTokens },
      1
    )
    this.store.updatedAt = this.now()
    this.persist()
  }

  /**
   * 升级迁移：旧会话只有累计 usage，没有逐日记录。
   * 每个会话只回填一次，归到该会话最后更新时间；演示会话/演示引擎不计数。
   */
  syncLegacy(sessions: readonly LegacySessionUsage[]): void {
    let changed = false
    const seen = new Set(this.store.legacySessions)
    for (const session of sessions) {
      if (!session || typeof session.id !== 'string' || seen.has(session.id)) continue
      seen.add(session.id)
      this.store.legacySessions.push(session.id)
      changed = true
      if (session.model?.providerId === 'demo') continue
      const inputTokens = finiteInt(session.usage?.inputTokens)
      const outputTokens = finiteInt(session.usage?.outputTokens)
      const cacheReadTokens = finiteInt(session.usage?.cacheReadTokens)
      if (inputTokens + outputTokens + cacheReadTokens <= 0) continue
      this.addDay(session.updatedAt || this.now(), { inputTokens, outputTokens, cacheReadTokens }, 1)
    }
    if (this.store.legacySessions.length > MAX_LEGACY_MARKERS) {
      this.store.legacySessions = this.store.legacySessions.slice(-MAX_LEGACY_MARKERS)
    }
    if (changed) {
      this.store.updatedAt = this.now()
      this.persist()
    }
  }

  summary(at: number = this.now()): TokenActivitySummary {
    const today = startOfLocalDay(at)
    const days: TokenActivityDay[] = []
    let yearTotal = 0
    let week = 0
    let activeDays = 0
    let estimatedTokens = 0
    for (let offset = 364; offset >= 0; offset -= 1) {
      const key = activityDayKey(addDays(today, -offset))
      const bucket = this.store.days[key] ?? emptyBucket()
      const estimated = bucket.estimatedInputTokens + bucket.estimatedOutputTokens
      const totalTokens = bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + estimated
      days.push({
        date: key,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        estimatedTokens: estimated,
        totalTokens,
        requests: bucket.requests
      })
      yearTotal += totalTokens
      estimatedTokens += estimated
      if (offset <= 6) week += totalTokens
      if (totalTokens > 0) activeDays += 1
    }
    const todayKey = activityDayKey(today)
    const todayBucket = this.store.days[todayKey] ?? emptyBucket()
    const todayTotal =
      todayBucket.inputTokens +
      todayBucket.outputTokens +
      todayBucket.cacheReadTokens +
      todayBucket.estimatedInputTokens +
      todayBucket.estimatedOutputTokens
    let total = 0
    for (const bucket of Object.values(this.store.days)) {
      total +=
        bucket.inputTokens +
        bucket.outputTokens +
        bucket.cacheReadTokens +
        bucket.estimatedInputTokens +
        bucket.estimatedOutputTokens
    }
    return {
      days,
      today: todayTotal,
      week,
      yearTotal,
      total,
      activeDays,
      estimatedTokens,
      generatedAt: at
    }
  }

  /** 测试/诊断：账本文件路径。 */
  get filePath(): string {
    return this.file
  }
}
