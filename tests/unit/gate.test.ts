import { describe, expect, it } from 'vitest'
import {
  GATE_CHECKS,
  assertGatePassed,
  evaluateGate,
  groupGateItems,
  missingGateChecks
} from '../../src/shared/gate'
import type { GateItem } from '../../src/shared/gate'

describe('BATCH 3 门禁', () => {
  it('@core:studio-media 核心判定：ERROR > 0 阻断出包，只有 warn 时放行', () => {
    const clean = evaluateGate([{ code: 'frame-shortfall', level: 'warn', message: '镜 3 帧数不足' }])
    expect(clean.passed).toBe(true)
    expect(clean.summary).toContain('0 error')

    const blocked = evaluateGate([
      { code: 'hardsub', level: 'error', message: '镜 2 画面里有内嵌字幕' },
      { code: 'frame-shortfall', level: 'warn', message: '镜 3 帧数不足' }
    ])
    expect(blocked.passed).toBe(false)
    expect(blocked.errors).toBe(1)
    expect(blocked.warns).toBe(1)
    expect(blocked.blockers.some((item) => /内嵌字幕/.test(item))).toBe(true)

    // 同类 error 计数如实，展示只列一次（避免 20 镜同一问题刷屏）
    const manySame = evaluateGate([
      { code: 'hardsub', level: 'error', message: '镜 1 有内嵌字幕' },
      { code: 'hardsub', level: 'error', message: '镜 2 有内嵌字幕' },
      { code: 'hardsub', level: 'error', message: '镜 3 有内嵌字幕' }
    ])
    expect(manySame.errors).toBe(3)
    expect(manySame.blockers).toHaveLength(1)
  })

  it('@core:studio-media 出包断言：放行不抛，阻断抛出可行动的异常', () => {
    const clean = evaluateGate([])
    expect(() => assertGatePassed(clean)).not.toThrow()

    const blocked = evaluateGate([{ code: 'hardsub', level: 'error', message: '镜 2 画面里有内嵌字幕' }])
    let thrown: Error | null = null
    try {
      assertGatePassed(blocked)
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).not.toBeNull()
    // 消息必须能直接指导行动：有数字、有具体问题、有下一步
    expect(thrown?.message).toContain('还有 1 个 error')
    expect(thrown?.message).toContain('内嵌字幕')
    expect(thrown?.message).toContain('修掉上面每一项')
  })

  it('@core:studio-media 门禁清单：14 项逐项登记来源，漏登记能被发现', () => {
    // 方案要求把 14 项 ERROR/WARN 做成自动检查
    expect(GATE_CHECKS).toHaveLength(14)
    const codes = GATE_CHECKS.map((spec) => spec.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(GATE_CHECKS.every((spec) => spec.source && spec.label)).toBe(true)

    // 分级不是摆设：既有 error 也有 warn
    expect(GATE_CHECKS.filter((spec) => spec.level === 'error').length).toBeGreaterThan(0)
    expect(GATE_CHECKS.filter((spec) => spec.level === 'warn').length).toBeGreaterThan(0)

    // 覆盖前面各张卡的成果
    for (const source of ['C-01', 'C-04', 'C-06', 'C-07', 'C-08', 'HR-01', 'BATCH 2']) {
      expect(GATE_CHECKS.some((spec) => spec.source === source), source).toBe(true)
    }

    expect(missingGateChecks(codes)).toHaveLength(0)
    expect(missingGateChecks(['hardsub']).length).toBe(13)

    // 分组
    const items: GateItem[] = [
      { code: 'a', level: 'error', message: 'a' },
      { code: 'b', level: 'warn', message: 'b' },
      { code: 'c', level: 'info', message: 'c' }
    ]
    const grouped = groupGateItems(items)
    expect(grouped.errors).toHaveLength(1)
    expect(grouped.warns).toHaveLength(1)
    expect(grouped.infos).toHaveLength(1)
  })
})
