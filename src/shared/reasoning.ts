import type { ReasoningEffort } from './types'

export const REASONING_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ReasoningEffort[]

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS)

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_SET.has(value)
}
