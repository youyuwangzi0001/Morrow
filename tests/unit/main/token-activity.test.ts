/**
 * Token 活动账本：真实 usage 记录、按日本地聚合、估算标记、历史回填幂等。
 */
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TokenActivityService } from '../../../src/main/services/token-activity'
import { makeTempDir } from '../core/helpers/workspace'

function at(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime()
}

describe('TokenActivityService', () => {
  it('按本地日期聚合精确/估算 token，并正确计算今天、近7天与累计', () => {
    const dir = makeTempDir('token-activity-')
    try {
      const now = at(2026, 10, 20)
      const service = new TokenActivityService(dir, { now: () => now })
      service.record({ at: at(2026, 10, 14), inputTokens: 100, outputTokens: 50, sessionId: 's1' })
      service.record({
        at: at(2026, 10, 20),
        inputTokens: 20,
        outputTokens: 10,
        estimatedInputTokens: 30,
        estimatedOutputTokens: 5,
        sessionId: 's2'
      })
      const summary = service.summary(now)
      expect(summary.days).toHaveLength(365)
      const today = summary.days[summary.days.length - 1]
      expect(today).toMatchObject({
        date: '2026-10-20',
        inputTokens: 20,
        outputTokens: 10,
        estimatedTokens: 35,
        totalTokens: 65,
        requests: 1
      })
      expect(summary.today).toBe(65)
      expect(summary.week).toBe(215)
      expect(summary.yearTotal).toBe(215)
      expect(summary.total).toBe(215)
      expect(summary.activeDays).toBe(2)
      expect(summary.estimatedTokens).toBe(35)

      const reloaded = new TokenActivityService(dir, { now: () => now })
      expect(reloaded.summary(now)).toMatchObject({ total: 215, today: 65, estimatedTokens: 35 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缓存读取只是输入明细，总量不重复累加', () => {
    const dir = makeTempDir('token-activity-cache-')
    try {
      const now = at(2026, 10, 20)
      const service = new TokenActivityService(dir, { now: () => now })
      service.record({ at: now, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, sessionId: 's1' })
      const summary = service.summary(now)
      const today = summary.days[summary.days.length - 1]
      expect(today).toMatchObject({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 800,
        totalTokens: 1200
      })
      expect(summary.today).toBe(1200)
      expect(summary.total).toBe(1200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('历史会话只回填一次，演示会话不计数', () => {
    const dir = makeTempDir('token-activity-legacy-')
    try {
      const now = at(2026, 10, 20)
      const service = new TokenActivityService(dir, { now: () => now })
      const sessions = [
        {
          id: 'legacy-real',
          updatedAt: at(2026, 10, 18),
          model: { providerId: 'deepseek' },
          usage: { inputTokens: 1000, outputTokens: 200 }
        },
        {
          id: 'legacy-demo',
          updatedAt: at(2026, 10, 18),
          model: { providerId: 'demo' },
          usage: { inputTokens: 9999, outputTokens: 9999 }
        }
      ]
      service.syncLegacy(sessions)
      expect(service.summary(now).total).toBe(1200)
      service.syncLegacy(sessions)
      expect(service.summary(now).total).toBe(1200)

      // 回填过的会话后续真实运行只记录增量，不再重复累计
      service.record({ at: now, inputTokens: 100, outputTokens: 20, sessionId: 'legacy-real' })
      expect(service.summary(now).total).toBe(1320)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('损坏账本不会阻断启动，重新记录后恢复', () => {
    const dir = makeTempDir('token-activity-corrupt-')
    try {
      const service = new TokenActivityService(dir, { now: () => at(2026, 10, 20) })
      service.record({ at: at(2026, 10, 20), inputTokens: 10, outputTokens: 5, sessionId: 's1' })
      const file = join(dir, 'usage', 'token-activity.json')
      writeFileSync(file, '{bad json', 'utf8')
      const recovered = new TokenActivityService(dir, { now: () => at(2026, 10, 20) })
      expect(recovered.summary().total).toBe(0)
      recovered.record({ at: at(2026, 10, 20), inputTokens: 7, outputTokens: 3, sessionId: 's2' })
      expect(recovered.summary().total).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
