import { describe, expect, it } from 'vitest'
import { previewBrief } from '../../../src/shared/brief-preview'

describe('brief preview', () => {
  it('从完整一句话里提取主角、欲望、阻力与转折', () => {
    const preview = previewBrief('一个雨夜，修伞的女孩捡到一把会倒着走时间的伞，她想找回失去的记忆，却发现每次修伞都会让外婆忘记她。', 'novel')
    expect(preview.subject).toContain('女孩')
    expect(preview.goal).toContain('找回')
    expect(preview.obstacle ?? preview.turn).toBeTruthy()
    expect(preview.confidence).toBe('high')
  })

  it('信息不足时给出最多两个追问', () => {
    const preview = previewBrief('一个女孩捡到一把伞。', 'drama')
    expect(preview.confidence).not.toBe('high')
    expect(preview.questions.length).toBeGreaterThan(0)
    expect(preview.questions.length).toBeLessThanOrEqual(2)
  })
})
