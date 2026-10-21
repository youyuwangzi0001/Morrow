/**
 * 上下文管理：token 估算、压缩决策、历史序列化、摘要接入。
 *
 * 内部消息模型把 tool_result 内嵌在 assistant 的 tool_use.result 里，因此「按整条消息切割」
 * 不会把一次工具调用切成两半；真正的安全切点是**模型动作（assistant 消息）与工具结果的完整边界**。
 *
 * R9 修正：过去只在 user 消息边界切割，当「单条用户消息 + 多轮工具调用/结果」时找不到切点
 * （cutIndex 会一路退到 0），M37 / R2-H 无法触发压缩。现在：
 * - 允许在完整工具对之后（assistant 消息起始处）切；
 * - 压缩时额外保留原始用户消息（约束/禁止外发/预算）以及被裁掉段的「当前用户请求」；
 * - 存在未回填结果的 tool_use（进行中的动作）时拒绝压缩，避免产生不合法请求；
 * - Anthropic 要求首条是 user：保留首条 user 消息 + provider 侧规范化，两边都满足。
 */
import type { ChatMessage, Usage } from '../shared/types'
import { newId, truncateText } from './util'

/** CJK 字符 ≈ 1 token，其它字符 ≈ 1/4 token（与架构文档口径一致） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 视觉接口按尺寸计费，单图大致 85–1600 tokens；历史估算取保守中位值。 */
const IMAGE_SIZE_ESTIMATE_TOKENS = 1100

export function estimateMessageTokens(message: ChatMessage): number {
  let total = 4 // role/message 结构开销
  total += (message.images?.length ?? 0) * IMAGE_SIZE_ESTIMATE_TOKENS
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'thinking') total += estimateTokens(block.text)
    else if (block.type === 'tool_use') {
      total += estimateTokens(block.name) + 8
      try {
        total += estimateTokens(JSON.stringify(block.input ?? {}))
      } catch {
        total += 16
      }
      if (block.result) total += estimateTokens(block.result.output) + estimateTokens(block.result.error ?? '')
    }
  }
  return total
}

export function estimateMessagesTokens(messages: ChatMessage[], system = ''): number {
  let total = estimateTokens(system) + 8
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/** 默认阈值：上下文窗口的 80% */
export const COMPACTION_THRESHOLD = 0.8
export const DEFAULT_KEEP_RECENT = 8
/** 摘要消息本身的开销（估算时从节省量里扣掉） */
const SUMMARY_OVERHEAD_TOKENS = 120

/** 压缩切点类型：user = 传统用户消息边界；tool-pair = 完整模型动作+工具结果之后 */
export type CompactionCutKind = 'user' | 'tool-pair'

export interface CompactionPlan {
  shouldCompact: boolean
  /** 从 messages[cutIndex] 开始保留；之前的部分被摘要替代 */
  cutIndex: number
  /** 压缩后保留的条数（含被额外保留的原始用户消息） */
  keepCount: number
  estimatedTokens: number
  contextLimit: number
  thresholdTokens: number
  savedTokens: number
  reason?: 'below-threshold' | 'no-safe-cut'
  /** 切点语义：user 边界 / 完整工具对之后的 assistant 边界 */
  cutKind?: CompactionCutKind
  /** 额外保留在摘要之后的原始消息条数（当前实现最多 2 条：首条用户消息 + 被截断段的当前用户请求） */
  preserveCount?: number
}

/**
 * 计算需要保留在摘要之后的消息：
 * 1. 原始用户消息（messages[0]）：任务约束、禁止外发、预算等不应被压缩掉；
 * 2. 若切点落在某个工具回合中途（保留段以 assistant 开头），把该回合被裁掉的
 *    「当前用户请求」也保留，保证压缩后模型仍知道正在做什么。
 * 返回按原数组顺序排列的消息（最多 2 条）。
 */
function messagesToPreserve(messages: ChatMessage[], cutIndex: number): ChatMessage[] {
  if (cutIndex <= 0) return []
  const kept = messages.slice(cutIndex)
  const preserved: ChatMessage[] = []
  const first = messages[0]
  if (first?.role === 'user') preserved.push(first)
  if (kept[0]?.role !== 'user') {
    for (let index = cutIndex - 1; index > 0; index -= 1) {
      const candidate = messages[index]
      if (candidate?.role !== 'user') continue
      if (!preserved.includes(candidate)) preserved.push(candidate)
      break
    }
  }
  if (preserved.length > 1) {
    const order = new Map(messages.map((message, index) => [message, index]))
    preserved.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }
  return preserved
}

/**
 * 计算是否需要压缩，以及从哪里切。
 *
 * 切点规则（R9）：
 * - 只切在**整条消息之间**：内部模型的 tool_result 内嵌在 assistant.tool_use.result 里，
 *   因此任何整消息边界都不会切出孤立的 tool_use / tool_result；
 * - 优先/允许 user 边界与 assistant（完整工具对之后）边界；单用户长工具链因此可压缩；
 * - 存在未回填结果的 tool_use（动作进行中）时拒绝压缩；
 * - 被裁掉段里的原始用户消息会被额外保留（preserveCount），不计入摘要省略。
 */
export function planCompaction(
  messages: ChatMessage[],
  system: string,
  contextLimit: number,
  options: { keepRecent?: number; threshold?: number; force?: boolean } = {}
): CompactionPlan {
  const keepRecent = Math.max(1, Math.floor(options.keepRecent ?? DEFAULT_KEEP_RECENT))
  const threshold = options.threshold ?? COMPACTION_THRESHOLD
  const force = options.force === true
  const estimatedTokens = estimateMessagesTokens(messages, system)
  const thresholdTokens = Math.max(1000, Math.floor(contextLimit * threshold))
  const base: CompactionPlan = {
    shouldCompact: false,
    cutIndex: 0,
    keepCount: messages.length,
    estimatedTokens,
    contextLimit,
    thresholdTokens,
    savedTokens: 0
  }
  if (!force && estimatedTokens <= thresholdTokens) return { ...base, reason: 'below-threshold' }
  // 进行中的工具动作（tool_use 还没有 result）不能压缩：裁剪后可能产生非法请求
  if (hasDanglingToolUse(messages)) return { ...base, reason: 'no-safe-cut' }
  // 目标切点：保留最近 keepRecent 条消息之后的位置
  const target = messages.length - keepRecent
  if (target <= 0) return { ...base, reason: 'no-safe-cut' }
  // 从目标位置向前找最近的整消息边界（assistant/user 都安全，system 摘要消息不作为切点）
  let cutIndex = -1
  for (let index = target; index >= 1; index -= 1) {
    const role = messages[index]?.role
    if (role === 'user' || role === 'assistant') {
      cutIndex = index
      break
    }
  }
  if (cutIndex <= 0) return { ...base, reason: 'no-safe-cut' }
  // 二次防御：保留段里不能有未回填结果的工具调用
  if (hasDanglingToolUse(messages.slice(cutIndex))) return { ...base, reason: 'no-safe-cut' }

  const preserved = messagesToPreserve(messages, cutIndex)
  const removed = messages.slice(0, cutIndex)
  // 若被裁掉的全是之前的摘要（没有新增真实消息），再压一次只是「摘要摘要」，没有价值
  if (removed.every((message) => message.role === 'system')) return { ...base, reason: 'no-safe-cut' }
  const removedTokens = estimateMessagesTokens(removed, '')
  const preservedTokens = preserved.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const savedTokens = Math.max(0, removedTokens - preservedTokens - SUMMARY_OVERHEAD_TOKENS)
  // 省不下 token 就不值得压缩（例如强制压缩但历史很短）
  if (savedTokens <= 0) return { ...base, reason: 'no-safe-cut' }

  return {
    shouldCompact: true,
    cutIndex,
    keepCount: messages.length - cutIndex + preserved.length,
    estimatedTokens,
    contextLimit,
    thresholdTokens,
    savedTokens,
    cutKind: messages[cutIndex]?.role === 'user' ? 'user' : 'tool-pair',
    preserveCount: preserved.length
  }
}

/** 把较早的消息压成给「摘要模型」看的纯文本（有长度上限，避免压缩本身超限） */
export function serializeMessagesForSummary(messages: ChatMessage[], maxChars = 24_000): string {
  const parts: string[] = []
  for (const message of messages) {
    const roleLabel = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'
    const chunks: string[] = []
    if (message.images?.length) {
      const names = message.images.map((image) => image.name).filter(Boolean).slice(0, 8).join('、')
      chunks.push(`（附带 ${message.images.length} 张图片${names ? `：${names}` : ''}）`)
    }
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) chunks.push(block.text.trim())
      else if (block.type === 'thinking' && block.text.trim()) chunks.push(`（思考）${truncateText(block.text.trim(), 300)}`)
      else if (block.type === 'tool_use') {
        const resultText = block.result
          ? block.result.ok
            ? truncateText(block.result.output, 400)
            : `失败：${block.result.error ?? '未知错误'}`
          : '（无结果）'
        // 参数里通常有文件路径/命令，摘要必须保留这些可核对信息
        let inputText = ''
        try {
          inputText = block.input ? truncateText(JSON.stringify(block.input), 320) : ''
        } catch {
          inputText = ''
        }
        chunks.push(`（调用工具 ${block.name}${inputText ? `，参数：${inputText}` : ''}，结果：${resultText}）`)
      }
    }
    if (chunks.length === 0) continue
    parts.push(`【${roleLabel}】${chunks.join(' ')}`)
  }
  const joined = parts.join('\n\n')
  return truncateText(joined, maxChars, '摘要输入已截断')
}

/** 本地兜底摘要：摘要模型不可用时不至于丢光上下文 */
export function localExtractSummary(messages: ChatMessage[]): string {
  const points: string[] = []
  for (const message of messages) {
    const texts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'tool_use') {
        let input = ''
        try {
          input = block.input ? truncateText(JSON.stringify(block.input), 100) : ''
        } catch {
          input = ''
        }
        texts.push(`[${block.name}${input ? ` ${input}` : ''}${block.result?.ok ? '' : ' 失败'}]`)
      }
    }
    const joined = texts.join(' ').replace(/\s+/g, ' ').trim()
    if (!joined) continue
    points.push(`${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'Morrow' : '系统'}：${truncateText(joined, 240, '…')}`)
    if (points.length >= 20) break
  }
  return `（本地摘要，较早对话的要点）\n${points.join('\n')}`
}

/**
 * 用摘要替换被裁剪的历史，返回新的消息数组。
 *
 * 除 system 摘要消息外，会把「原始用户消息」和（切点落在工具回合中途时的）当前用户请求
 * 放在摘要之后、保留段之前，确保压缩后约束与当前任务不丢失；顺序仍为时间顺序。
 */
export function applyCompaction(messages: ChatMessage[], cutIndex: number, summaryText: string): ChatMessage[] {
  const safeCut = Math.max(0, Math.min(cutIndex, messages.length))
  const kept = messages.slice(safeCut)
  const preserved = messagesToPreserve(messages, safeCut)
  const summary: ChatMessage = {
    id: newId('summary'),
    role: 'system',
    content: [
      {
        type: 'text',
        text: `[历史对话摘要 — 更早的内容已压缩，后续回答可依赖以下要点]\n${summaryText}`
      }
    ],
    createdAt: Date.now()
  }
  return [summary, ...preserved, ...kept]
}

/** 防御性检查：assistant 的每个 tool_use 都必须有 result（内部模型下正常不会缺） */
export function hasDanglingToolUse(messages: ChatMessage[]): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === 'tool_use' && !block.result)
  )
}

/** 合并 usage（多段请求累计） */
export function addUsage(target: Usage, delta: Partial<Usage>): Usage {
  return {
    inputTokens: target.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: target.outputTokens + (delta.outputTokens ?? 0),
    ...(typeof delta.cacheReadTokens === 'number'
      ? { cacheReadTokens: (target.cacheReadTokens ?? 0) + delta.cacheReadTokens }
      : target.cacheReadTokens !== undefined
        ? { cacheReadTokens: target.cacheReadTokens }
        : {}),
    ...(delta.contextUsed !== undefined ? { contextUsed: delta.contextUsed } : target.contextUsed !== undefined ? { contextUsed: target.contextUsed } : {}),
    ...(delta.contextLimit !== undefined ? { contextLimit: delta.contextLimit } : target.contextLimit !== undefined ? { contextLimit: target.contextLimit } : {})
  }
}
