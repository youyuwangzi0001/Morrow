/** 任务经验（自动记忆）与记忆中心事件的共享契约。 */
export type EpisodeOutcome = 'completed' | 'failed'

export interface TaskEpisode {
  id: string
  scope: 'project' | 'global'
  workspace: string | null
  title: string
  /** 当时用户想完成什么 */
  intent: string
  /** 任务结果摘要（不是完整对话） */
  summary: string
  outcome: EpisodeOutcome
  /** 成员/工具名称（去重，最多 12 个） */
  tools: string[]
  /** 改动或产出文件（相对工作区，最多 12 个） */
  files: string[]
  tags: string[]
  sourceSessionId: string
  sourceSessionTitle: string
  sourceMessageId: string
  createdAt: number
  updatedAt: number
  enabled: boolean
}

export interface EpisodeStats {
  scope: 'project' | 'global'
  workspace: string | null
  total: number
  enabled: number
  limit: number
}

export interface EpisodeListResult {
  entries: TaskEpisode[]
  stats: EpisodeStats
}

export interface EpisodeInjection {
  text: string
  usedTokens: number
  limitTokens: number
  totalEnabled: number
  included: number
}

export const EPISODE_CHANGED_EVENT = 'feature:memory:episodes-changed'
export const MEMORY_CHANGED_EVENT = 'feature:memory:changed'

/* ── 自进化建议（与任务经验同属记忆系统） ─────────────────────── */

/**
 * 自进化建议（记忆中心）：任务后复盘产出的可采纳改进。
 *
 * 设计取舍：
 * - 建议只是候选，用户点「采纳」后才写入记忆或技能库；
 * - 每条建议都带来源会话、置信度和过期时间，方便复盘与清理；
 * - 一次只保留少量待处理建议，避免把记忆中心变成通知中心。
 */
export type EvolutionMemoryScope = 'project' | 'global'
export type EvolutionKind = 'memory' | 'skill'
export type EvolutionAction = 'create' | 'update'
export type EvolutionStatus = 'pending' | 'applied' | 'ignored'

export interface EvolutionSuggestion {
  id: string
  kind: EvolutionKind
  action: EvolutionAction
  /** 列表中的短标题；记忆为一句概括，技能为 kebab-case 技能名 */
  title: string
  /** 一句话说明这条建议会改变什么 */
  summary: string
  /** 为什么值得保留（来自对话里的纠正、失败重试或可复用流程） */
  rationale: string
  /** 0–1；低于阈值的建议不会入库 */
  confidence: number
  status: EvolutionStatus
  /** 记忆目标范围；技能建议为 null */
  scope: EvolutionMemoryScope | null
  /** 项目记忆的目标工作区；全局记忆/技能为 null */
  workspace: string | null
  /** 来源会话的工作区，用于展示上下文 */
  sourceWorkspace: string | null
  /** 记忆正文，或完整 SKILL.md（含 frontmatter） */
  content: string
  /** 记忆标签 */
  tags: string[]
  /** update 时的目标记忆 id 或技能 id */
  targetId: string | null
  sourceSessionId: string
  sourceSessionTitle: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  appliedAt?: number
  appliedTarget?: string
}

export interface EvolutionListResult {
  suggestions: EvolutionSuggestion[]
  pending: number
  lastReviewedAt: number | null
}

export type EvolutionSkipReason =
  | 'disabled'
  | 'temporary'
  | 'demo'
  | 'research'
  | 'unattended'
  | 'no-session'
  | 'no-model'
  | 'running'
  | 'no-signal'
  | 'cooldown'
  | 'pending-limit'
  | 'empty'
  | 'timeout'

export interface EvolutionReviewResult {
  suggestions: EvolutionSuggestion[]
  /** 本次新写入的候选数量（更新已有候选不计入） */
  created: number
  reviewedAt: number | null
  skipped?: EvolutionSkipReason
  message?: string
}

export interface EvolutionAppliedTarget {
  kind: EvolutionKind
  id: string
  /** 给用户看的名称（记忆摘要 / 技能名） */
  label: string
}

export interface EvolutionApplyResult {
  suggestion: EvolutionSuggestion
  target: EvolutionAppliedTarget
}

export const EVOLUTION_MIN_CONFIDENCE = 0.7
export const EVOLUTION_MAX_SUGGESTIONS_PER_REVIEW = 3
export const EVOLUTION_MAX_PENDING = 6
export const EVOLUTION_EXPIRES_MS = 14 * 24 * 60 * 60 * 1000
export const EVOLUTION_REVIEW_COOLDOWN_MS = 10 * 60 * 1000
export const EVOLUTION_MAX_CONTENT_CHARS = 20_000
export const EVOLUTION_MAX_SUMMARY_CHARS = 300
export const EVOLUTION_MAX_TITLE_CHARS = 80
export const EVOLUTION_MAX_RATIONALE_CHARS = 600
export const EVOLUTION_MAX_STORE_BYTES = 2 * 1024 * 1024
export const EVOLUTION_CHANGED_EVENT = 'feature:evolution:changed'

export const EVOLUTION_SKIP_LABEL: Record<EvolutionSkipReason, string> = {
  disabled: '自动检查已关闭',
  temporary: '临时对话不参与检查',
  demo: '演示对话不参与检查',
  research: '研究任务暂不生成建议',
  unattended: '无人值守任务不生成建议',
  'no-session': '还没有可以检查的对话',
  'no-model': '还没有连接可用的模型',
  running: '任务结束后再检查',
  'no-signal': '这次没有发现值得长期保留的内容',
  cooldown: '本轮刚刚检查过，稍后再试',
  'pending-limit': '待处理建议已满，先处理已有建议',
  empty: '对话内容太少，暂时无法检查',
  timeout: '检查超时，稍后再试'
}
