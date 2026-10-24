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
  /** 额外保留在摘要之后的原始消息条数（首条用户消息 + 被截断段的当前用户请求） */
  preserveCount?: number
  /** 压缩后估算 token（含摘要本身） */
  afterTokens?: number
  /** 期望压缩到的 token 目标 */
  targetTokens?: number
  /** 压缩后仍高于目标（需要调用方做更激进的裁剪） */
  overTarget?: boolean
  /** 被裁掉段里已有的旧摘要，调用方应把它合并进新摘要 */
  existingSummary?: string
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
  // 第一次压缩后，消息 0 是摘要；真正的用户任务锚点可能在更后面，必须继续保留
  const firstUser = messages.find((message) => message.role === 'user')
  if (firstUser) preserved.push(firstUser)
  if (kept[0]?.role !== 'user') {
    for (let index = cutIndex - 1; index >= 0; index -= 1) {
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
  options: { keepRecent?: number; threshold?: number; force?: boolean; targetRatio?: number } = {}
): CompactionPlan {
  const keepRecent = Math.max(1, Math.floor(options.keepRecent ?? DEFAULT_KEEP_RECENT))
  const threshold = options.threshold ?? COMPACTION_THRESHOLD
  const force = options.force === true
  const targetRatio = Math.min(0.8, Math.max(0.25, options.targetRatio ?? 0.45))
  const estimatedTokens = estimateMessagesTokens(messages, system)
  const thresholdTokens = Math.max(1000, Math.floor(contextLimit * threshold))
  const targetTokens = Math.max(1200, Math.floor(contextLimit * targetRatio))
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

  // 只在完整消息边界切；至少保留切点之后的内容，避免把当前任务全部折掉。
  const candidates: number[] = []
  const pushCandidates = (from: number): void => {
    for (let index = from; index <= messages.length - 2; index += 1) {
      const role = messages[index]?.role
      if (role !== 'user' && role !== 'assistant') continue
      if (hasDanglingToolUse(messages.slice(index))) continue
      candidates.push(index)
    }
  }
  pushCandidates(Math.max(1, messages.length - keepRecent))
  // 历史很短或保留段本身过大时，允许从更早处切（仍然不能切到 0）
  if (candidates.length === 0) pushCandidates(1)
  if (candidates.length === 0) return { ...base, reason: 'no-safe-cut' }

  const summaryTokens = Math.min(
    4000,
    Math.max(320, Math.floor(Math.min(contextLimit * 0.05, estimatedTokens * 0.25)))
  )
  const preservedMemo = new Map<number, ChatMessage[]>()
  const preservedFor = (cutIndex: number): ChatMessage[] => {
    const cached = preservedMemo.get(cutIndex)
    if (cached) return cached
    const next = messagesToPreserve(messages, cutIndex).map((message) => trimMessageForPreserve(message))
    preservedMemo.set(cutIndex, next)
    return next
  }

  let fittingCut = -1
  let fallbackCut = -1
  let fallbackAfter = 0
  for (const cutIndex of candidates) {
    const removed = messages.slice(0, cutIndex)
    // 只有旧摘要、没有新增真实消息时，再压一次没有价值
    if (!removed.some((message) => message.role !== 'system')) continue
    const preserved = preservedFor(cutIndex)
    const kept = messages.slice(cutIndex)
    const removedTokens = estimateMessagesTokens(removed, '')
    const preservedTokens = preserved.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    if (removedTokens - preservedTokens <= 0) continue
    const after = estimateMessagesTokens(kept, '') + preservedTokens + summaryTokens + SUMMARY_OVERHEAD_TOKENS
    if (fallbackCut < 0 || cutIndex > fallbackCut) {
      fallbackCut = cutIndex
      fallbackAfter = after
    }
    if (after <= targetTokens) {
      fittingCut = cutIndex
      break
    }
  }
  const cutIndex = fittingCut >= 0 ? fittingCut : fallbackCut
  if (cutIndex <= 0) return { ...base, reason: 'no-safe-cut' }
  const preserved = preservedFor(cutIndex)
  const removed = messages.slice(0, cutIndex)
  const kept = messages.slice(cutIndex)
  const removedTokens = estimateMessagesTokens(removed, '')
  const preservedTokens = preserved.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const afterTokens =
    estimateMessagesTokens(kept, '') + preservedTokens + summaryTokens + SUMMARY_OVERHEAD_TOKENS
  const savedTokens = Math.max(0, removedTokens - preservedTokens - summaryTokens - SUMMARY_OVERHEAD_TOKENS)
  // 手动 /compact 允许「摘要成本接近历史本身」的短对话；自动压缩不做无收益的摘要摘要
  if (savedTokens <= 0 && !force) return { ...base, reason: 'no-safe-cut' }
  const existingSummary = removed
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.replace(/^\[历史对话摘要[^\]]*\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n\n')
  return {
    shouldCompact: true,
    cutIndex,
    keepCount: messages.length - cutIndex + preserved.length,
    estimatedTokens,
    contextLimit,
    thresholdTokens,
    savedTokens,
    cutKind: messages[cutIndex]?.role === 'user' ? 'user' : 'tool-pair',
    preserveCount: preserved.length,
    afterTokens,
    targetTokens,
    overTarget: afterTokens > targetTokens,
    ...(existingSummary ? { existingSummary } : {})
  }
}

/** 压缩时额外保留的消息也做长度上限，避免「保留最近」又把上下文撑满。 */
function trimMessageForPreserve(message: ChatMessage, maxChars = 6000): ChatMessage {
  let remaining = maxChars
  const content = message.content.map((block) => {
    if (block.type === 'text') {
      const text = truncateText(block.text, Math.max(0, remaining))
      remaining = Math.max(0, remaining - text.length)
      return { ...block, text }
    }
    if (block.type === 'tool_use') {
      return {
        ...block,
        ...(block.result
          ? {
              result: {
                ...block.result,
                output: truncateText(block.result.output ?? '', 1200),
                error: truncateText(block.result.error ?? '', 1200)
              }
            }
          : {})
      }
    }
    return block
  })
  return { ...message, content }
}

/**
 * 只折叠过大的工具输出/文本，不删除任何消息。
 * 用于「没有可摘要切点」的短历史：宁可少省一点，也不能在没有摘要的情况下丢对话。
 */
export function shrinkToolOutputs(
  messages: ChatMessage[],
  resultChars = 2400,
  textChars = 8000
): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'system') return message
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'tool_use' && block.result) {
          return {
            ...block,
            result: {
              ...block.result,
              output: truncateText(block.result.output ?? '', resultChars),
              error: truncateText(block.result.error ?? '', resultChars)
            }
          }
        }
        if (block.type === 'text') {
          return { ...block, text: truncateText(block.text, textChars) }
        }
        return block
      })
    }
  })
}

/** 极端情况下再折一刀：压缩工具输出、丢弃过老消息，直到接近上限或只剩必要消息。 */
export function aggressiveTrim(
  messages: ChatMessage[],
  system: string,
  contextLimit: number,
  keepRecent = 4
): ChatMessage[] {
  const budget = Math.max(1200, Math.floor(contextLimit * 0.72))
  const shrink = (list: ChatMessage[], resultChars: number): ChatMessage[] =>
    shrinkToolOutputs(list, resultChars, Math.max(3000, resultChars * 2))
  let next = shrink(messages, 2400)
  let keep = keepRecent
  let lastTokens = estimateMessagesTokens(next, system)
  while (lastTokens > budget) {
    const summary = next.find((message) => message.role === 'system') ?? null
    const rest = next.filter((message) => message !== summary)
    if (rest.length <= 2) break
    const firstUser = rest.find((message) => message.role === 'user')
    const recent = rest.slice(-keep)
    const head = firstUser && !recent.includes(firstUser) ? [firstUser] : []
    const tail = [...recent]
    // 保留用户锚点，只丢弃最旧的非用户消息；避免把唯一的 user 消息裁掉
    if (tail.length > 2) {
      if (firstUser && tail[0] === firstUser) tail.splice(1, 1)
      else tail.shift()
    }
    next = shrink([...(summary ? [summary] : []), ...head, ...tail], 1200)
    keep = Math.max(2, keep - 1)
    const tokens = estimateMessagesTokens(next, system)
    // 已经只剩必要消息/输出已无法再缩：明确结束，避免原地打转
    if (tokens >= lastTokens) break
    lastTokens = tokens
  }
  return next
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
      if (block.type === 'text' && block.text.trim()) {
        chunks.push(truncateText(block.text.trim(), message.role === 'user' ? 6000 : 2000))
      } else if (block.type === 'thinking' && block.text.trim()) {
        chunks.push(`（思考）${truncateText(block.text.trim(), 240)}`)
      } else if (block.type === 'tool_use') {
        const resultText = block.result
          ? block.result.ok
            ? truncateText(block.result.output ?? '', 1600)
            : `失败：${truncateText(block.result.error ?? '未知错误', 1200)}`
          : '（无结果）'
        let inputText = ''
        try {
          inputText = block.input ? truncateText(JSON.stringify(block.input), 700) : ''
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
  if (joined.length <= maxChars) return joined
  // 保头保尾：开头通常是用户目标/约束，结尾是最近动作；中段只留标记
  const head = Math.floor(maxChars * 0.38)
  const tail = maxChars - head - 32
  return `${joined.slice(0, head)}\n\n…（中段省略 ${joined.length - head - tail} 字符）…\n\n${joined.slice(-tail)}`
}

/**
 * 本地兜底摘要：摘要模型不可用时不至于丢光上下文。
 * 除了按时间保留要点，还从整段历史里抽取带约束/决策关键词的句子，
 * 避免“密钥、端口、预算、禁止项”这类关键事实只在被裁掉的第 30 轮出现时丢失。
 */
const SUMMARY_KEY_PATTERN = /(必须|禁止|不要|不得|唯一|约束|定稿|决定|采用|选用|记住|预算|上限|端口|路径|密钥|token|url|api|截止)/i

export function localExtractSummary(messages: ChatMessage[]): string {
  const points: string[] = []
  const keyPoints: string[] = []
  const seenKeys = new Set<string>()
  for (const message of messages) {
    const texts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        texts.push(block.text)
        // 只抽取用户约束/决定与已有摘要；助手复述（“我会…/已记录…”）不占用关键槽位。
        if (message.role !== 'assistant') {
          for (const rawLine of block.text.split(/\n|(?<=[。；;])/)) {
            const line = rawLine.trim().replace(/^[-•]\s*/, '')
            if (line.length < 4 || !SUMMARY_KEY_PATTERN.test(line)) continue
            if (/历史对话摘要|关键约束与决策|本地摘要|较早对话/.test(line)) continue
            if (/^(我会|已记录|已切换|已保留|收到)/.test(line)) continue
            const normalized = line.replace(/\s+/g, ' ')
            if (seenKeys.has(normalized) || keyPoints.length >= 12) continue
            seenKeys.add(normalized)
            keyPoints.push(truncateText(normalized, 180, '…'))
          }
        }
      } else if (block.type === 'tool_use') {
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
    if (!joined || points.length >= 20) continue
    points.push(`${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'Morrow' : '系统'}：${truncateText(joined, 240, '…')}`)
  }
  const sections: string[] = []
  if (keyPoints.length > 0) sections.push(`（关键约束与决策）\n${keyPoints.map((line) => `- ${line}`).join('\n')}`)
  sections.push(`（本地摘要，较早对话的要点）\n${points.join('\n')}`)
  return sections.join('\n')
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
  const preserved = messagesToPreserve(messages, safeCut).map((message) => trimMessageForPreserve(message))
  const before = estimateMessagesTokens(messages, '')
  const summary: ChatMessage = {
    id: newId('summary'),
    role: 'system',
    content: [
      {
        type: 'text',
        text: `[历史对话摘要 · 已压缩]\n${summaryText}`
      }
    ],
    createdAt: Date.now()
  }
  const result = [summary, ...preserved, ...kept]
  // Anthropic 要求对话以 user 开始；极端情况下（旧摘要被再次压缩且无用户锚点）补一个明确的继续指令
  if (!result.some((message) => message.role === 'user')) {
    result.splice(1, 0, {
      id: newId('msg'),
      role: 'user',
      content: [{ type: 'text', text: '继续完成之前尚未完成的任务；以摘要中的目标、约束和下一步为准。' }],
      createdAt: Date.now()
    })
  }
  const after = estimateMessagesTokens(result, '')
  const saved = Math.max(0, before - after)
  const header = summary.content[0]
  if (header && header.type === 'text') {
    header.text = `[历史对话摘要 · 已压缩 ${saved} tokens，任务继续]\n${summaryText}`
  }
  return result
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
