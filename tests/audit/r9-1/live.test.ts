/** R9.1 真实 M40–M49（仅一遍）；解锁：MORROW_R9_1_LIVE=1 + CONFIRM。 */
import { describe, expect, it } from 'vitest'
import { runR91LiveSuite } from './live-runner'

const ENABLED = process.env.MORROW_R9_1_LIVE === '1' && process.env.MORROW_R9_1_LIVE_CONFIRM === 'ONE_PASS_M40_M49'

describe.skipIf(!ENABLED)('R9.1 子代理全权限 + 并行（M40–M49 一遍）', () => {
  it('运行 M40–M49 并产出 r9-1-results.json', async () => {
    const { results, budget } = await runR91LiveSuite()
    expect(results.length).toBe(10)
    expect(results.every((item) => item.status !== 'NOT_RUN')).toBe(true)
    expect(budget.used).toBeLessThanOrEqual(budget.cap)
  }, 2_400_000)
})
