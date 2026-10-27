import { describe, expect, it } from 'vitest'
import { STUDIO_STATUS_TRANSITIONS, canTransitionStudioStatus, type StudioStatus } from '../../../src/shared/studio'

const STATUSES: StudioStatus[] = ['waiting', 'ready', 'running', 'review', 'done', 'failed', 'stale', 'skipped']

describe('创作阶段状态转移', () => {
  it('每种状态都有显式转移表', () => {
    for (const status of STATUSES) {
      expect(STUDIO_STATUS_TRANSITIONS[status]).toBeDefined()
      expect(canTransitionStudioStatus(status, status)).toBe(true)
    }
  })

  it('拒绝不合理的回退', () => {
    expect(canTransitionStudioStatus('waiting', 'running')).toBe(true)
    expect(canTransitionStudioStatus('running', 'done')).toBe(true)
    expect(canTransitionStudioStatus('done', 'stale')).toBe(true)
    expect(canTransitionStudioStatus('running', 'waiting')).toBe(false)
    expect(canTransitionStudioStatus('done', 'failed')).toBe(false)
    expect(canTransitionStudioStatus('stale', 'skipped')).toBe(false)
  })
})
