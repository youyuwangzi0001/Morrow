import { diffArrays, diffChars } from 'diff'

export const LARGE_DIFF_CHARS = 20_000
export const DIFF_DISPLAY_LIMIT = 60_000

export interface DiffChange {
  value: string
  added?: boolean
  removed?: boolean
  count?: number
}

export interface DiffParagraphChange {
  value: string[]
  added?: boolean
  removed?: boolean
  count?: number
}

export interface CandidateDiffResult {
  parts: DiffChange[]
  paragraphs: DiffParagraphChange[]
  truncated: boolean
  /** 超长正文自动退到段落级，避免逐字 diff 卡住界面。 */
  degraded: boolean
}

export function candidateDiff(original: string, next: string, mode: 'chars' | 'paragraphs'): CandidateDiffResult {
  const truncated = original.length > DIFF_DISPLAY_LIMIT || next.length > DIFF_DISPLAY_LIMIT
  const left = original.slice(0, DIFF_DISPLAY_LIMIT)
  const right = next.slice(0, DIFF_DISPLAY_LIMIT)
  const large = original.length > LARGE_DIFF_CHARS || next.length > LARGE_DIFF_CHARS
  const leftParagraphs = left.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  const rightParagraphs = right.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  const paragraphs = diffArrays(leftParagraphs, rightParagraphs) as unknown as DiffParagraphChange[]
  const degraded = large && mode === 'chars'
  const parts = mode === 'chars' && !large ? diffChars(left, right) as DiffChange[] : []
  return { parts, paragraphs, truncated, degraded }
}
