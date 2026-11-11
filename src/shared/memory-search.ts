/**
 * 记忆检索的本地向量与词面打分。主进程的注入排序和渲染层的搜索共用同一套实现，
 * 保证「界面上看到的顺序」与「真正带进对话的经验」一致。
 */

const HASH_DIMENSIONS = 256

const STOPWORDS = new Set([
  '的', '了', '和', '与', '在', '是', '把', '将', '为', '我', '你', '他', '她', '它', '们',
  '中', '上', '下', '一个', '这个', '那个', '这', '那', '有', '就', '也', '都', '而', '及',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are'
])

/** 词面向量维度：足够区分经验条目，又不会把 JSON 索引撑大。 */
export const MEMORY_VECTOR_DIMENSIONS = HASH_DIMENSIONS

export function normalizeSearchText(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function tokenizeMemoryText(input: string): string[] {
  const text = normalizeSearchText(input)
  if (!text) return []
  const tokens: string[] = []
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._-]{0,}/g)) {
    const token = match[0]
    if (token.length >= 2 && !STOPWORDS.has(token)) tokens.push(token)
  }
  for (const match of text.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) tokens.push(run)
      continue
    }
    if (run.length <= 8 && !STOPWORDS.has(run)) tokens.push(run)
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!STOPWORDS.has(bigram)) tokens.push(bigram)
    }
  }
  return tokens
}

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 特征哈希向量：离线可用、确定性、不依赖模型文件。 */
export function hashMemoryVector(input: string, dimensions = HASH_DIMENSIONS): Float32Array {
  const vector = new Float32Array(dimensions)
  const counts = new Map<string, number>()
  for (const token of tokenizeMemoryText(input)) counts.set(token, (counts.get(token) ?? 0) + 1)
  for (const [token, count] of counts) {
    const index = fnv1a(token, 0x811c9dc5) % dimensions
    const sign = (fnv1a(token, 0x9e3779b9) & 1) === 0 ? 1 : -1
    vector[index] += sign * (1 + Math.log(count))
  }
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return 0
  return Math.max(0, Math.min(1, dot / Math.sqrt(normA * normB)))
}

/** 精确词面重合度：给模型向量补上文件名、命令、专有名词的硬命中。 */
export function tokenOverlapScore(query: string, text: string): number {
  const queryTokens = tokenizeMemoryText(query)
  if (queryTokens.length === 0) return 0
  const textTokens = new Set(tokenizeMemoryText(text))
  let hit = 0
  let total = 0
  for (const token of new Set(queryTokens)) {
    const weight = Math.min(8, Math.max(1, token.length))
    total += weight
    if (textTokens.has(token)) hit += weight
  }
  return total > 0 ? Math.min(1, hit / total) : 0
}

export function memoryTextRelevance(query: string, text: string, dimensions = HASH_DIMENSIONS): number {
  if (!normalizeSearchText(query)) return 0
  const semantic = cosineSimilarity(hashMemoryVector(query, dimensions), hashMemoryVector(text, dimensions))
  const lexical = tokenOverlapScore(query, text)
  return Math.min(1, semantic * 0.55 + lexical * 0.45)
}

export interface MemorySearchEntryLike {
  text: string
  tags: string[]
  importance: number
}

export function rankMemoryEntries<T extends MemorySearchEntryLike>(
  entries: T[],
  query: string,
  sort: 'relevance' | 'recent',
  createdAt: (entry: T) => number
): T[] {
  if (sort === 'recent') return [...entries].sort((a, b) => createdAt(b) - createdAt(a))
  const text = normalizeSearchText(query)
  if (!text) {
    return [...entries].sort((a, b) => b.importance - a.importance || createdAt(b) - createdAt(a))
  }
  const scored = entries.map((entry) => ({
    entry,
    score:
      memoryTextRelevance(query, `${entry.text} ${entry.tags.join(' ')}`) +
      (entry.importance - 1) * 0.015
  }))
  return scored
    .filter((item) => item.score > 0.015)
    .sort((a, b) => b.score - a.score || createdAt(b.entry) - createdAt(a.entry))
    .map((item) => item.entry)
}
