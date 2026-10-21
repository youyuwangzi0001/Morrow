import { describe, expect, it } from 'vitest'
import { isReasoningEffort, REASONING_EFFORTS } from '../../../src/shared/reasoning'

describe('推理强度白名单', () => {
  it('包含 UI 提供的全部六档', () => {
    expect(REASONING_EFFORTS).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    for (const effort of REASONING_EFFORTS) expect(isReasoningEffort(effort)).toBe(true)
  })

  it('拒绝大小写变体、空值与旧档位', () => {
    for (const value of ['HIGH', 'XHIGH', '', 'minimal', null, undefined, 1, {}, []]) {
      expect(isReasoningEffort(value)).toBe(false)
    }
  })
})
