/**
 * R9 阶段 B：真实 DeepSeek 跑 M40/M41/M42/M48/M49（一遍，≤300 请求）。
 * 命令：
 *   MORROW_R9_LIVE=1 MORROW_R9_LIVE_CONFIRM=ONE_PASS_M40_M49 \
 *   npx vitest run --config tests/audit/vitest.config.ts tests/audit/r9/live.test.ts
 */
import { describe, expect, it } from 'vitest'
import { runR9LiveSuite } from './live-runner'

const ENABLED = process.env.MORROW_R9_LIVE === '1' && process.env.MORROW_R9_LIVE_CONFIRM === 'ONE_PASS_M40_M49'

describe.skipIf(!ENABLED)('R9 真实能力题 M40–M49（一遍）', () => {
  it('运行支持题并产出 r9-results.json', async () => {
    const { results, budget } = await runR9LiveSuite()
    expect(budget.used).toBeLessThanOrEqual(budget.cap)
    const requestedIds = (process.env.MORROW_R9_IDS ?? '').split(',').filter(Boolean)
    expect(results.length).toBe(requestedIds.length > 0 ? requestedIds.length : 10)
    const supported = results.filter((item) => item.declaredSupport === 'supported')
    expect(supported).toHaveLength(requestedIds.length > 0 ? requestedIds.length : 5)
    expect(results.filter((item) => item.status === 'NOT_RUN')).toHaveLength(0)
  }, 2_400_000)
})
