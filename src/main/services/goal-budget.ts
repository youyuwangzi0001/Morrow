/**
 * Goal 轮次预算智能估算 + 真实进展追踪（R7/R9 审计后补充）。
 *
 * 用户不需要手动选「最多跑几轮」：根据目标描述里的实际工作量信号估算，
 * 上限 256 轮；显式传入 maxRounds 的调用方（高级用法/审计测试）仍然优先。
 *
 * 估算只影响「授权预算」，不代表任务一定要跑满：完成/阻塞/无进展/用户停止都会提前结束。
 * 本模块不 import electron，可在单测/审计脚本中直接验证。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export const GOAL_MIN_ROUNDS = 2
export const GOAL_MAX_ROUNDS = 256

function clampRounds(value: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 5)
  return Math.max(GOAL_MIN_ROUNDS, Math.min(GOAL_MAX_ROUNDS, rounded))
}

/**
 * 根据目标描述估算轮次预算。
 * 信号：
 * - 显式数量（"12 批"、"16 轮"、"8 份报告"、"5 个阶段"）→ 数量 + 2 轮缓冲；
 * - 枚举步骤标记（第一步/然后/最后…）与「分批/长期/迭代」等长周期词；
 * - 文本长度与交付物数量（报告/网页/表格/分析…）。
 */
export function inferGoalRounds(objective: string): number {
  const text = (objective ?? '').trim()
  if (!text) return 5
  let score = 4
  if (text.length > 60) score += 1
  if (text.length > 120) score += 2
  if (text.length > 260) score += 2
  if (text.length > 500) score += 2

  // 显式数量：12 批 / 16 轮 / 8 份 / 6 个阶段 / 4 个步骤
  for (const match of text.matchAll(/(\d{1,3})\s*(轮|批|份|个阶段|个步骤|个阶段)/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > 0) score = Math.max(score, value + 2)
  }
  // 中文数字数量：十二批 / 三轮 / 五个阶段
  const cnNumber: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  for (const match of text.matchAll(/([一二两三四五六七八九十]{1,3})\s*(轮|批|份|个阶段|个步骤)/g)) {
    const raw = match[1]
    const value = raw.length === 1 ? cnNumber[raw] : raw === '十一' ? 11 : raw === '十二' ? 12 : raw.includes('十') ? 10 + (cnNumber[raw.replace('十', '')] ?? 0) : NaN
    if (Number.isFinite(value) && value > 0) score = Math.max(score, value + 2)
  }

  // 枚举步骤标记
  const markers =
    text.match(
      /(?:第[一二三四五六七八九十0-9]+[步轮阶段批]|首先|然后|接着|随后|最后|再(?:接着)?|之后)/g
    )?.length ?? 0
  score += Math.min(10, markers)

  // 交付物/工作类型数量
  const workKinds = ['报告', '网页', '文档', '表格', '图表', '调研', '分析', '清单', '脚本', '测试', '演示', '数据']
  score += Math.min(6, workKinds.filter((kind) => text.includes(kind)).length)

  // 长周期信号
  if (/长期|持续|多轮|陆续|分批|迭代|直到|反复|跟踪|每日|每周/.test(text)) score += 4

  return clampRounds(score)
}

export interface GoalBudgets {
  maxToolCalls: number
  maxActiveMs: number
  maxNoProgressRounds: number
}

/** 轮次预算确定后，配套的工具调用/时间预算（随轮次规模缩放，有下限避免正常目标太小） */
export function inferGoalBudgets(maxRounds: number, override: Partial<GoalBudgets> = {}): GoalBudgets {
  const rounds = clampRounds(maxRounds)
  const base: GoalBudgets = {
    maxToolCalls: Math.max(200, rounds * 20),
    maxActiveMs: Math.max(20 * 60_000, rounds * 3 * 60_000),
    maxNoProgressRounds: 3
  }
  return {
    maxToolCalls: Number.isFinite(override.maxToolCalls) ? Math.max(1, Math.round(override.maxToolCalls as number)) : base.maxToolCalls,
    maxActiveMs: Number.isFinite(override.maxActiveMs) ? Math.max(1000, Math.round(override.maxActiveMs as number)) : base.maxActiveMs,
    maxNoProgressRounds: Number.isFinite(override.maxNoProgressRounds)
      ? Math.max(1, Math.round(override.maxNoProgressRounds as number))
      : base.maxNoProgressRounds
  }
}

export { clampRounds }


/* ── R9 / R2-D：单轮用量合并（assignment，绝不重复累加） ─────── */

export interface GoalUsageSnapshot {
  toolCalls?: number
  activeMs?: number
}

export interface GoalRoundUsage {
  toolCalls: number
  activeMs: number
}

function safeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * 把「轮前已持久化基数 + 本轮实时值」合并成最终累计值。
 *
 * R2-D 的根因是 flushIncremental 已经写成 base+round，afterRun 又 `+= round`，导致 2 记成 4。
 * 这里统一用 assignment 语义；同一 base/round 调用多少次结果都相同。
 */
export function mergeGoalUsage(base: GoalUsageSnapshot, round: GoalRoundUsage): { toolCalls: number; activeMs: number } {
  return {
    toolCalls: safeCount(base.toolCalls) + safeCount(round.toolCalls),
    activeMs: safeCount(base.activeMs) + Math.max(0, Math.round(Number.isFinite(round.activeMs) ? round.activeMs : 0))
  }
}

/* ── R9 / R2-F / R2-G：真实进展追踪 ─────────────────────────── */

/** 会产出/修改文件的工具：成功且内容确实变化才算进展 */
export const FILE_PRODUCING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'write_xlsx',
  'edit_docx',
  'open_artifact'
])

/** 外部工具：第一次成功调用（server+tool+参数签名）才算进展 */
export const EXTERNAL_PROGRESS_TOOLS: ReadonlySet<string> = new Set(['mcp_call', 'web_fetch'])

/** MCP 只读类工具（读取/查询/等待）不算业务成果；写/登记类动作才算 */
const MCP_READ_ONLY_TOOL_PATTERN = /(?:^|[_-])(get|read|list|status|wait|query|search|check|describe|info|fetch)$/i

export interface GoalProgressObservation {
  toolName: string
  input?: Record<string, unknown>
  ok: boolean
  resultMeta?: Record<string, unknown>
  workspace: string | null
  /** Goal 创建时间：早于它的文件属于旧输入，不能算本轮进展 */
  goalCreatedAt?: number
  now?: number
}

export interface GoalProgressResult {
  progress: boolean
  key?: string
  reason?: 'failed' | 'not-productive' | 'stale-file' | 'duplicate' | 'no-path' | 'unreadable'
}

export interface GoalProgressTrackerOptions {
  /** 从 Goal 持久化字段恢复（重启/暂停/续跑后不重复计数） */
  existingKeys?: string[]
  maxKeys?: number
}

const MAX_PROGRESS_KEYS = 300
const MTIME_TOLERANCE_MS = 1000
const MAX_HASH_BYTES = 32 * 1024 * 1024

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function resolveRelative(path: string, workspace: string | null): string | null {
  if (!path) return null
  if (isAbsolute(path)) return path
  if (!workspace) return null
  return resolve(workspace, path)
}

/**
 * 跨轮进展去重器。
 * - 文件类：key = 路径 + 内容哈希（写相同内容=不进展；新路径/新内容=进展）；
 * - MCP/web：key = server+tool+参数签名 或 URL（成功才记；重复调用不进展）；
 * - 失败调用、只读工具、run_command（空操作无法判定）一律不计；
 * - 早于 Goal 创建时间的旧文件不计（引用旧产物不能刷新无进展计数）。
 * 状态可序列化为 string[] 持久化到 Goal.progressKeys，重启后恢复。
 */
export class GoalProgressTracker {
  private readonly keys = new Set<string>()
  private readonly order: string[] = []
  private readonly maxKeys: number

  constructor(options: GoalProgressTrackerOptions = {}) {
    this.maxKeys = Math.max(10, Math.min(1000, Math.round(options.maxKeys ?? MAX_PROGRESS_KEYS)))
    for (const key of options.existingKeys ?? []) {
      if (typeof key === 'string' && key && !this.keys.has(key)) this.addKey(key)
    }
  }

  get size(): number {
    return this.keys.size
  }

  /** 供持久化使用（保持插入顺序，末尾是最新） */
  toKeys(): string[] {
    return [...this.order]
  }

  observe(observation: GoalProgressObservation): GoalProgressResult {
    if (!observation.ok) return { progress: false, reason: 'failed' }
    const toolName = observation.toolName
    if (FILE_PRODUCING_TOOLS.has(toolName)) return this.observeFile(observation)
    if (EXTERNAL_PROGRESS_TOOLS.has(toolName)) return this.observeExternal(observation)
    // run_command：无法可靠区分空操作与真实文件变化，不作为进展（审计报告明确空命令不能续命）
    return { progress: false, reason: 'not-productive' }
  }

  private observeFile(observation: GoalProgressObservation): GoalProgressResult {
    const meta = observation.resultMeta ?? {}
    const input = observation.input ?? {}
    const candidate =
      (typeof meta.absolutePath === 'string' && meta.absolutePath) ||
      (typeof meta.path === 'string' && resolveRelative(meta.path, observation.workspace)) ||
      (typeof input.path === 'string' && resolveRelative(input.path, observation.workspace)) ||
      (typeof input.output_path === 'string' && resolveRelative(input.output_path, observation.workspace)) ||
      null
    if (!candidate) return { progress: false, reason: 'no-path' }
    let stat
    try {
      stat = statSync(candidate)
    } catch {
      return { progress: false, reason: 'unreadable' }
    }
    if (!stat.isFile()) return { progress: false, reason: 'unreadable' }
    if (
      typeof observation.goalCreatedAt === 'number' &&
      Number.isFinite(observation.goalCreatedAt) &&
      stat.mtimeMs < observation.goalCreatedAt - MTIME_TOLERANCE_MS
    ) {
      // 旧输入/上一轮遗留文件：引用它不算本目标期间的新进展
      return { progress: false, reason: 'stale-file' }
    }
    let fingerprint: string
    if (typeof meta.afterHash === 'string' && /^[0-9a-f]{16,}$/i.test(meta.afterHash)) {
      fingerprint = meta.afterHash.toLowerCase()
    } else if (stat.size <= MAX_HASH_BYTES) {
      try {
        fingerprint = sha256(readFileSync(candidate))
      } catch {
        fingerprint = `${Math.round(stat.mtimeMs)}:${stat.size}`
      }
    } else {
      fingerprint = `${Math.round(stat.mtimeMs)}:${stat.size}`
    }
    const key = `file:${candidate.toLowerCase()}:${fingerprint}`
    return this.commit(key)
  }

  private observeExternal(observation: GoalProgressObservation): GoalProgressResult {
    const input = observation.input ?? {}
    if (observation.toolName === 'mcp_call') {
      const tool = typeof input.tool === 'string' ? input.tool.trim() : ''
      // R2-G：普通 MCP 读取/查询不算进展；只有真实写入/登记类动作（首次成功）才算成果
      if (!tool || MCP_READ_ONLY_TOOL_PATTERN.test(tool)) {
        return { progress: false, reason: 'not-productive' }
      }
      const signature = sha256(stableStringify(input)).slice(0, 32)
      return this.commit(`mcp:${signature}`)
    }
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    if (!url) return { progress: false, reason: 'no-path' }
    return this.commit(`web:${url}`)
  }

  private commit(key: string): GoalProgressResult {
    if (this.keys.has(key)) return { progress: false, reason: 'duplicate', key }
    this.addKey(key)
    return { progress: true, key }
  }

  private addKey(key: string): void {
    this.keys.add(key)
    this.order.push(key)
    if (this.order.length > this.maxKeys) {
      const removed = this.order.shift()
      if (removed) this.keys.delete(removed)
    }
  }
}
