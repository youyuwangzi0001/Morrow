/**
 * 偏好沉淀：把「这一次不满意」变成「以后不再犯」。
 *
 * 创作台的审核页会产出检查项与人工圈注，但这些意见过去只停留在单次作品里：
 * 下一部作品、下一次重做分镜，同一个毛病会再犯一次。这里定义偏好条的形状、
 * 归一化规则与注入文本，让审核结论可以跨作品、跨阶段复用。
 *
 * 设计上有三条硬约束：
 * 1. **只沉淀可执行的话**：偏好必须能被写进提示词并直接影响产出，
 *    像「感觉不对」这种没有抓手的表述不进入偏好库。
 * 2. **同类合并、次数累加**：同一类问题出现多次代表用户在这件事上很在意，
 *    权重随之上升，而不是产生一堆重复条目。
 * 3. **可撤销**：偏好是用户的东西，必须能单条删除、整体停用。
 */
import type { StudioKind } from './studio'

/** 偏好来自哪里：人工圈注、审核结论、还是助手对话。 */
export type StudioPreferenceSource = 'review' | 'annotation' | 'assistant' | 'manual'

/** 偏好作用于哪个阶段；all 表示从蓝图到成片全程有效。 */
export type StudioPreferenceStage = 'all' | 'writing' | 'storyboard' | 'image' | 'voice' | 'music' | 'edit'

export interface StudioPreference {
  id: string
  /** 归一化后的规则正文，直接写进提示词 */
  text: string
  /** 归一化键：同类问题判定用，保证同一毛病只累加不重复 */
  key: string
  /** 作品形态；both 表示中短篇与漫剧都适用 */
  kind: StudioKind | 'both'
  stage: StudioPreferenceStage
  source: StudioPreferenceSource
  /** 命中次数；权重随次数上升 */
  hits: number
  createdAt: number
  updatedAt: number
  /** 最近一次命中来自哪部作品，便于用户回溯 */
  lastProjectId?: string
  /** 用户停用的条目不参与注入，但仍保留在列表里 */
  enabled?: boolean
}

/** 一次审核/圈注产生的原始意见。 */
export interface StudioPreferenceCandidate {
  text: string
  kind?: StudioKind
  stage?: StudioPreferenceStage
  source?: StudioPreferenceSource
  projectId?: string
}

/** 偏好正文上限：太长会挤占提示词预算，也会让规则失真。 */
export const PREFERENCE_MAX_CHARS = 160

/**
 * 最短偏好正文。
 * 四个字就足够承载一条可执行要求（「雨戏太亮」「不要旁白」），
 * 再短就基本是情绪词，交给 {@link VAGUE_ONLY} 拦。
 */
const PREFERENCE_MIN_CHARS = 4

/**
 * 没有抓手的表述：无法转成可执行指令，沉淀下来只会污染提示词。
 * 这些词出现且整句很短时直接丢弃。
 */
const VAGUE_ONLY = /^(?:感觉|看着|整体|总觉得|有点|不太|好像|感觉上)?\s*(?:不对|不行|不好|怪|别扭|差|一般|凑合)\s*[。！.!]*$/

/**
 * 口语里的客气前缀。只剥真正无信息量的那几个。
 *
 * 「不要 / 别 / 务必」不能剥：它们承载肯定或否定的方向，剥掉会把
 *「不要写的太满」变成「写的太满」，规则直接反过来。
 */
const FILLER = /^(?:请|麻烦|帮我|记得|最好)+/u

/**
 * 把一条原始意见压成可比较的归一化键。
 * 只做机械归一化；语义相近由 {@link findSimilarPreference} 负责。
 */
export function preferenceKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、！？,.!?;:"'“”‘’（）()【】\[\]—\-…]/g, '')
    .slice(0, PREFERENCE_MAX_CHARS)
}

/**
 * 两个偏好键的相似度（0–1）。
 *
 * 用「包含度」而不是 Jaccard：偏好最常见的演化是「短句 → 补上细节的长句」，
 * Jaccard 拿并集做分母，短句被扩写后分数会掉到 0.15 以下，于是同一个毛病
 * 被记成两条。包含度只问「较短那条里的二元组有多少被另一条覆盖」，
 * 正好对应「这是同一件事的详写」。
 *
 * 同时要求较长一条也别太离谱：如果长句只是碰巧包含短句而主题完全不同
 * （短句 5 个字，长句 200 字），包含度会虚高，用长度比例压一下。
 */
export function preferenceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (text: string): Set<string> => {
    const out = new Set<string>()
    for (let index = 0; index + 1 < text.length; index += 1) out.add(text.slice(index, index + 2))
    return out
  }
  const left = grams(a)
  const right = grams(b)
  if (left.size === 0 || right.size === 0) return 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const gram of small) if (large.has(gram)) shared += 1
  const containment = shared / small.size
  // 长度差越大，「包含」越可能只是巧合：用较短/较长做权重，但不低于 0.5，
  // 否则一次正常的补充说明就会被判成两条。
  const lengthRatio = small.size / large.size
  return containment * Math.max(0.5, lengthRatio)
}

/** 判定为「同一件事」的相似度门槛：调低会误并不同要求，调高会漏并同一毛病。 */
export const PREFERENCE_MERGE_THRESHOLD = 0.5

/**
 * 在已有偏好里找与新候选语义最接近的一条。
 * 先比归一化键（完全相同必中），再按相似度挑最高分且过门槛的那条。
 */
export function findSimilarPreference(
  preferences: readonly StudioPreference[],
  key: string
): StudioPreference | undefined {
  let best: StudioPreference | undefined
  let bestScore = 0
  for (const item of preferences) {
    const score = item.key === key ? 1 : preferenceSimilarity(item.key, key)
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return bestScore >= PREFERENCE_MERGE_THRESHOLD ? best : undefined
}

/** 一段意见是否值得沉淀成长期偏好。 */
export function isDurablePreference(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < PREFERENCE_MIN_CHARS) return false
  if (VAGUE_ONLY.test(trimmed)) return false
  return true
}

/** 归一化偏好正文：去空白、循环剥掉客气前缀、截断到上限。 */
export function normalizePreferenceText(text: string): string {
  const compact = text.replace(/[\s\u3000]+/g, ' ').trim()
  // 「麻烦帮我改成短句」这类连续前缀要一路剥到底，只剥一个会留下半句客气话
  let stripped = compact
  for (;;) {
    const next = stripped.replace(FILLER, '').trim()
    if (next === stripped || next.length < PREFERENCE_MIN_CHARS) break
    stripped = next
  }
  const body = stripped.length >= PREFERENCE_MIN_CHARS ? stripped : compact
  return body.length > PREFERENCE_MAX_CHARS ? `${body.slice(0, PREFERENCE_MAX_CHARS - 1)}…` : body
}

/** 从一条候选意见生成偏好条（不含 id/时间，交给调用方补齐）。 */
export function toPreference(
  candidate: StudioPreferenceCandidate,
  now = Date.now()
): Omit<StudioPreference, 'id'> | null {
  const text = normalizePreferenceText(candidate.text)
  if (!isDurablePreference(text)) return null
  return {
    text,
    key: preferenceKey(text),
    kind: candidate.kind ?? 'both',
    stage: candidate.stage ?? 'all',
    source: candidate.source ?? 'review',
    hits: 1,
    createdAt: now,
    updatedAt: now,
    ...(candidate.projectId ? { lastProjectId: candidate.projectId } : {})
  }
}

/**
 * 把新候选合并进已有偏好库。
 *
 * - 命中同 key：次数 +1、更新时间与来源，正文保留更完整的那一条；
 * - 新 key：追加；
 * - 返回是否有变化，便于调用方决定要不要落盘。
 */
export function mergePreferences(
  existing: readonly StudioPreference[],
  candidates: readonly StudioPreferenceCandidate[],
  now = Date.now(),
  idFor: (key: string) => string = (key) => `pref_${key.slice(0, 16)}`
): { preferences: StudioPreference[]; changed: boolean; added: number; reinforced: number } {
  const next = existing.map((item) => ({ ...item }))
  let added = 0
  let reinforced = 0
  for (const candidate of candidates) {
    const fresh = toPreference(candidate, now)
    if (!fresh) continue
    // 语义相近的旧条目要合并：同一个毛病换个说法不该变成两条偏好
    const hit = findSimilarPreference(next, fresh.key)
    if (hit) {
      hit.hits += 1
      hit.updatedAt = now
      if (fresh.lastProjectId) hit.lastProjectId = fresh.lastProjectId
      // 更详细的表述替换掉更简略的那条，避免偏好库随着使用越来越含糊
      if (fresh.text.length > hit.text.length) {
        hit.text = fresh.text
        hit.key = fresh.key
      }
      if (hit.stage === 'all' && fresh.stage !== 'all') hit.stage = fresh.stage
      reinforced += 1
      continue
    }
    const created: StudioPreference = { id: idFor(fresh.key), ...fresh }
    next.push(created)
    added += 1
  }
  return { preferences: next, changed: added + reinforced > 0, added, reinforced }
}

/** 按作品形态与阶段筛选出可注入的偏好，命中次数高的排前面。 */
export function activePreferences(
  preferences: readonly StudioPreference[],
  kind: StudioKind,
  stage: StudioPreferenceStage
): StudioPreference[] {
  return preferences
    .filter((item) => item.enabled !== false)
    .filter((item) => item.kind === 'both' || item.kind === kind)
    .filter((item) => item.stage === 'all' || item.stage === stage)
    .sort((a, b) => (b.hits - a.hits) || (b.updatedAt - a.updatedAt))
}

/** 注入提示词的偏好段落上限：越多越像唠叨，反而降低遵循度。 */
export const PREFERENCE_PROMPT_LIMIT = 8

/**
 * 生成注入提示词的偏好段落。
 * 只列条目本身，不写「以下是用户的偏好」这类元话术，直接把规则交给模型执行。
 */
export function preferencesPromptSection(
  preferences: readonly StudioPreference[],
  kind: StudioKind,
  stage: StudioPreferenceStage,
  limit = PREFERENCE_PROMPT_LIMIT
): string {
  const picked = activePreferences(preferences, kind, stage).slice(0, Math.max(0, limit))
  if (picked.length === 0) return ''
  return ['【长期偏好（历次审核沉淀，必须遵守）】', ...picked.map((item) => `- ${item.text}`)].join('\n')
}

/** 删除一条偏好；找不到时返回原数组，避免无意义写入。 */
export function removePreference(preferences: readonly StudioPreference[], id: string): StudioPreference[] {
  return preferences.filter((item) => item.id !== id)
}

/** 启用/停用一条偏好。 */
export function setPreferenceEnabled(
  preferences: readonly StudioPreference[],
  id: string,
  enabled: boolean
): StudioPreference[] {
  return preferences.map((item) => (item.id === id ? { ...item, enabled } : item))
}

/**
 * 哪些检查项足够稳定，值得沉淀成长期偏好。
 *
 * 判据是「这条意见换个作品还成立吗」：
 * - continuity（连续性）、voice（声线）、subtitle（字幕）这类是做法层面的问题，会重复发生；
 * - missing（缺素材）、price（超预算）是这一次的状态，修完就没了，不沉淀；
 * - visual/audio 只有明确写成规则式要求时才收。
 * 另外只收 error 与 warn：info 级多半是提示，不是用户的不满。
 */
const DURABLE_CHECK_KINDS = new Set<string>([
  'continuity',
  'voice',
  'subtitle',
  'visual',
  'audio',
  'quality'
])

/** 检查项 → 偏好候选。返回空数组表示这一类不该沉淀。 */
export function checkToPreferenceCandidates(
  checks: readonly { kind: string; level: string; title: string; detail: string }[],
  kind: StudioKind,
  projectId?: string
): StudioPreferenceCandidate[] {
  const out: StudioPreferenceCandidate[] = []
  for (const check of checks) {
    if (check.level !== 'error' && check.level !== 'warn') continue
    if (!DURABLE_CHECK_KINDS.has(check.kind)) continue
    // 用标题作为规则主体：它通常已经是「问题是什么」的短句，
    // detail 往往是这一处的具体位置，塞进长期偏好会变得不可复用。
    const text = check.title.trim()
    if (!text) continue
    out.push({ text, kind, source: 'review', ...(projectId ? { projectId } : {}) })
  }
  return out
}
