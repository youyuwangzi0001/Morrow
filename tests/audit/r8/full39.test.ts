/**
 * R8 全量 39 题 harness 入口。
 *
 * 默认（零真实费用）：
 *   npx vitest run --config tests/audit/vitest.config.ts tests/audit/r8/full39.test.ts
 *
 * live（等 Lead「新功能已集成」信号；仅一遍 39 题，≤400 次真实请求）：
 *   MORROW_R8_LIVE=1 npx vitest run --config tests/audit/vitest.config.ts tests/audit/r8/full39.test.ts
 */
import { describe, expect, it } from 'vitest'
import { runPhaseA } from './runner'
import { runLiveFullSuite } from './live-runner'

describe('R8 全量 39 题审计 harness', () => {
  it(
    '阶段 A：夹具/mock MCP/spec/checker 自检 + 支持声明（零真实费用）',
    async () => {
      const report = await runPhaseA()
      console.log(
        `[r8-phase-a] ok=${report.ok} specs=${report.specs.total} supported=${report.specs.supported} partial=${report.specs.partial} unsupported=${report.specs.unsupported} fixtures=${report.fixtures.checks.filter((c) => c.ok).length}/${report.fixtures.checks.length} mock=${report.mock.checks.filter((c) => c.ok).length}/${report.mock.checks.length} checkers=${report.checkers.length} declaration=${report.declaration}`
      )
      const failed = [...report.fixtures.checks, ...report.mock.checks].filter((check) => !check.ok)
      const failedCheckers = report.checkers.filter((checker) => !checker.emptyOutputRejected || checker.referencePassed === false)
      expect(failed, JSON.stringify(failed.slice(0, 5))).toHaveLength(0)
      expect(failedCheckers).toHaveLength(0)
      expect(report.ok).toBe(true)
    },
    480_000
  )

  it.skipIf(process.env.MORROW_R8_LIVE !== '1')(
    '阶段 B：真实模型一次性跑完整 39 题（需 Lead 信号 + MORROW_R8_LIVE=1）',
    async () => {
      await runLiveFullSuite()
    },
    3_600_000
  )
})
