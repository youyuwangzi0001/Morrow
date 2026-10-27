import { describe, expect, it } from 'vitest'
import { LARGE_DIFF_CHARS, candidateDiff } from '../../../src/shared/text-diff'

describe('大文本候选对照', () => {
  it('短文本逐字对照可用', () => {
    const result = candidateDiff('雨从傍晚开始下。', '雨从深夜开始下。', 'chars')
    expect(result.degraded).toBe(false)
    expect(result.parts.some((part) => part.removed)).toBe(true)
    expect(result.parts.some((part) => part.added)).toBe(true)
  })

  it('超过 2 万字自动退到段落级，不生成逐字 diff', () => {
    const paragraph = '她把伞撑开，雨水沿着伞骨落下来。'
    const original = Array.from({ length: 1200 }, () => paragraph).join('\n\n')
    const next = `${original}\n\n她把灯关了。`
    expect(original.length).toBeGreaterThan(LARGE_DIFF_CHARS)
    const result = candidateDiff(original, next, 'chars')
    expect(result.degraded).toBe(true)
    expect(result.parts).toHaveLength(0)
    expect(result.paragraphs.length).toBeGreaterThan(0)
    expect(result.paragraphs.some((part) => part.added)).toBe(true)
  })

  it('超过 6 万字时标记截断', () => {
    const text = '雨'.repeat(70_000)
    const result = candidateDiff(text, `${text}灯`, 'paragraphs')
    expect(result.truncated).toBe(true)
  })
})
