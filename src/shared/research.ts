/**
 * 深度研究模式的共享规则：
 * - 深度决定轮次上限与独立来源下限；
 * - 从真实 web_search 工具结果统计独立来源；
 * - 根据来源数量 / 报告产物决定「继续检索 / 完成 / 停止」。
 */
import type { Artifact, ChatMessage, ResearchDepth, ResearchState } from './types'

export interface ResearchDepthConfig {
  label: string
  description: string
  maxRounds: number
  minSources: number
}

export const RESEARCH_DEPTHS: Record<ResearchDepth, ResearchDepthConfig> = {
  quick: {
    label: '快速',
    description: '2 轮检索，至少 4 个独立来源；适合快速确认一件事。',
    maxRounds: 2,
    minSources: 4
  },
  standard: {
    label: '标准',
    description: '4 轮检索，至少 10 个独立来源；适合一般调研与对比。',
    maxRounds: 4,
    minSources: 10
  },
  deep: {
    label: '深入',
    description: '6 轮检索，至少 20 个独立来源；适合需要交叉验证的重要判断。',
    maxRounds: 6,
    minSources: 20
  }
}

export function normalizeResearchDepth(value: unknown): ResearchDepth {
  return value === 'quick' || value === 'deep' ? value : 'standard'
}

export function createResearchState(
  topic: string,
  depth: ResearchDepth,
  now: number = Date.now(),
  options: { status?: 'planning' | 'searching'; plan?: string } = {}
): ResearchState {
  const config = RESEARCH_DEPTHS[depth]
  return {
    topic: topic.trim().slice(0, 500) || '未命名研究',
    depth,
    status: options.status ?? 'searching',
    round: 1,
    maxRounds: config.maxRounds,
    minSources: config.minSources,
    sourceCount: 0,
    startedAt: now,
    updatedAt: now,
    ...(options.plan ? { plan: options.plan.slice(0, 20_000) } : {})
  }
}

export interface ResearchSource {
  url: string
  title: string
}

/** 用户确认计划后开始检索的输入。 */
export interface ResearchStartInput {
  plan: string
  depth?: ResearchDepth
}

/** 独立来源的归一化键：忽略 hash、末尾斜杠、UTM 跟踪参数与主机大小写。 */
function sourceKey(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return null
  }
}

/** 从消息中的 web_search / web_fetch 成功结果收集独立来源（按归一化 URL 去重）。 */
export function collectResearchSources(messages: ChatMessage[], since = 0): ResearchSource[] {
  const seen = new Set<string>()
  const sources: ResearchSource[] = []
  const add = (url: unknown, title: unknown): void => {
    if (typeof url !== 'string') return
    const key = sourceKey(url)
    if (!key || seen.has(key)) return
    seen.add(key)
    sources.push({ url, title: typeof title === 'string' && title ? title : url })
  }
  for (const message of messages) {
    if (message.createdAt < since) continue
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.status !== 'success') continue
      const meta = block.result?.meta as Record<string, unknown> | null | undefined
      if (block.name === 'web_search') {
        const raw = meta && Array.isArray(meta.sources) ? meta.sources : []
        for (const item of raw as Array<Record<string, unknown>>) add(item.url, item.title)
      } else if (block.name === 'web_fetch' && meta) {
        add(meta.finalUrl ?? meta.requestedUrl, meta.title)
      }
    }
  }
  return sources
}

function assistantTextSince(messages: ChatMessage[], since: number): string {
  const chunks: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || message.createdAt < since) continue
    for (const block of message.content) {
      if (block.type === 'text') chunks.push(block.text)
    }
  }
  return chunks.join('\n')
}

/** 一条消息/成品是否具备「带来源章节 + 至少两个链接」的报告结构。 */
function hasSourceEvidence(text: string): boolean {
  if (!text) return false
  const links = text.match(/https?:\/\/[^\s)\]>"']+/g)?.length ?? 0
  if (links < 2) return false
  return /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?\s*(?:参考来源|参考資料|参考资料|来源|sources?|references?)\s*(?:\*\*)?\s*[:：]?\s*(?=\n|$)/i.test(
    text
  )
}

/** 最终报告：有研究/报告标题的文本成品，或正文具备来源章节与两个链接的成品/回复。 */
export function hasResearchReport(
  messages: ChatMessage[],
  artifacts: Artifact[],
  startedAt: number
): { present: boolean; artifactId?: string } {
  const artifact = [...artifacts]
    .reverse()
    .find(
      (item) =>
        item.updatedAt >= startedAt &&
        (item.kind === 'markdown' || item.kind === 'html' || item.kind === 'text') &&
        (/研究|报告|research|report/i.test(item.title) || hasSourceEvidence(item.content ?? ''))
    )
  if (artifact) return { present: true, artifactId: artifact.id }
  return { present: hasSourceEvidence(assistantTextSince(messages, startedAt)) }
}

export interface ResearchDecision {
  status: 'searching' | 'completed' | 'stopped'
  sourceCount: number
  gap?: string
  artifactId?: string
  followUpPrompt?: string
}

/**
 * 每轮结束后的判断：
 * - 来源与报告都达标 → completed；
 * - 还有轮次 → searching + 下一轮补查指令；
 * - 到上限 → stopped（如实说明差多少，不伪装成已完成）。
 */
export function decideResearchNextStep(
  state: ResearchState,
  messages: ChatMessage[],
  artifacts: Artifact[]
): ResearchDecision {
  const sources = collectResearchSources(messages, state.startedAt)
  const sourceCount = sources.length
  const report = hasResearchReport(messages, artifacts, state.startedAt)
  if (sourceCount >= state.minSources && report.present) {
    return {
      status: 'completed',
      sourceCount,
      ...(report.artifactId ? { artifactId: report.artifactId } : {})
    }
  }
  const missing: string[] = []
  if (sourceCount < state.minSources) missing.push(`独立来源 ${sourceCount}/${state.minSources}`)
  if (!report.present) missing.push('还缺一份带引用来源的研究报告')
  const gap = missing.join('；')
  if (state.round >= state.maxRounds) {
    return {
      status: 'stopped',
      sourceCount,
      gap: `已到研究轮次上限（${state.round}/${state.maxRounds}）：${gap}。可以继续发送消息再研究一轮。`,
      ...(report.artifactId ? { artifactId: report.artifactId } : {})
    }
  }
  const nextRound = state.round + 1
  return {
    status: 'searching',
    sourceCount,
    gap,
    followUpPrompt: [
      `继续这项深度研究（第 ${nextRound}/${state.maxRounds} 轮）。当前 ${gap}。`,
      state.steer ? `用户补充要求（必须纳入本轮）：${state.steer}` : '',
      '请按要求补查：',
      '1. 换 2-3 组不同角度的关键词再搜索，不要重复已经用过的来源；',
      '2. 用 web_fetch 阅读至少 2 个新来源，核对关键事实与日期；',
      '3. 区分事实、推断和未知，把分歧写清楚；',
      '4. 最后更新一份完整的 Markdown 研究报告，用 open_artifact 打开；每条结论保留 [编号] 和 URL。',
      '不要向用户提问。'
    ]
      .filter((line) => line !== '')
      .join('\n')
  }
}

/** 研究模式系统提示段（运行时状态由主进程注入）。 */
export function buildResearchPromptSection(state: ResearchState): string {
  const config = RESEARCH_DEPTHS[state.depth]
  return [
    '## 深度研究模式',
    `- 研究主题：${state.topic}`,
    `- 深度：${config.label}（最多 ${state.maxRounds} 轮检索，至少 ${state.minSources} 个独立来源）`,
    `- 当前轮次：第 ${state.round}/${state.maxRounds} 轮；已记录的独立来源：${state.sourceCount}/${state.minSources}`,
    state.gap ? `- 上一轮缺口：${state.gap}` : '',
    state.plan ? `\n## 已确认的研究计划\n${state.plan}` : '',
    state.steer ? `\n## 用户补充要求（本轮必须优先处理）\n${state.steer}` : '',
    '',
    '工作方式：',
    '1. 先拆出 3-5 个需要查清的子问题，用 todo_write 记录；',
    '2. 每一轮至少做 2 次不同关键词的 web_search，覆盖不同角度；对关键来源用 web_fetch 读正文；',
    '3. 只引用实际搜索或读取过的 URL；不得编造来源、标题、日期或数字；',
    '4. 交叉核对：同一事实尽量有 2 个独立来源；不一致时把分歧和各自出处写出来；',
    '5. 明确区分「已核实的事实」「基于资料的推断」「仍未知/需要更新」；',
    '6. 最终用 Markdown 写研究报告：标题、摘要、关键结论（每条带 [n]）、证据与分歧、关键数据/时间线、局限、参考来源（[n] 标题 + URL）；',
    '7. 报告用 open_artifact（kind=markdown）放到画布上；',
    '8. 不修改任何文件、不运行命令、不调用 MCP；不需要向用户提问，缺信息就如实写进「局限」。',
    state.plan ? '9. 严格遵守已确认的研究计划；如需偏离，先在报告里说明原因。' : '',
    '',
    '如果本轮结束时来源或报告仍不完整，系统会自动发起下一轮补查；你只需把当前这一轮做扎实。'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** 计划阶段：只生成可审阅的计划，不检索、不写报告。 */
export function buildResearchPlanPrompt(state: ResearchState): string {
  const config = RESEARCH_DEPTHS[state.depth]
  return [
    '## 深度研究：制定计划阶段',
    '你现在的唯一任务是制定研究计划。不要调用任何工具，不要开始搜索，也不要写最终报告。',
    '',
    `用户的研究主题：${state.topic}`,
    `研究深度：${config.label}（最多 ${config.maxRounds} 轮检索，至少 ${config.minSources} 个独立来源）`,
    '',
    '请输出一份简洁、可编辑的 Markdown 研究计划，必须包含：',
    '1. `# 研究计划：<主题>` 标题；',
    '2. `## 研究目标`：一句话说明最终要回答什么；',
    '3. `## 范围与假设`：时间范围、地域、对象、必要的边界；',
    '4. `## 子问题`：4-6 个可检索、可验证的问题；',
    '5. `## 检索策略`：关键词方向、优先来源类型、需要交叉核对的关键事实；',
    '6. `## 报告结构`：摘要、关键结论、证据与分歧、时间线/数据、局限、参考来源；',
    '7. `## 需要确认`：只列出真正影响结论的 0-3 个未知项，供用户修改。',
    '',
    '要求：不要编造事实或来源；用简体中文；控制在一页内。用户会直接编辑这份计划，然后开始研究。'
  ].join('\n')
}
