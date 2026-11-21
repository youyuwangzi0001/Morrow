import { describe, expect, it } from 'vitest'
import {
  actualClipSeconds,
  checkAttribution,
  pickMatchingTarget,
  resolveFrameContract,
  safeClipSeconds
} from '../../src/shared/scene-integrity'
import type { AttributionActual, AttributionExpectation } from '../../src/shared/scene-integrity'

// ==========================================================================
// 原 tests/unit/frame-contract.test.ts
// ==========================================================================

describe('C-01 帧数契约', () => {
  it('@core:studio-timeline 实测帧数优先：不足按实测缩短，超额按计划截断，都不补帧', () => {
    // 请求 124 帧实出 90 帧：实测 3.75s < 计划 5.17s，判为截断并给出差值。
    const short = resolveFrameContract({ plannedSec: 5.17, frames: 90, fps: 24, requestedFrames: 124 })
    expect(short.actualSec).toBeCloseTo(3.75, 3)
    expect(short.usedSec).toBeCloseTo(3.75, 3)
    expect(short.shortfallSec).toBeCloseTo(1.42, 2)
    expect(short.truncated).toBe(true)

    // 实测 141 帧（5.875s）> 计划 5s：只用计划时长，不越用多出的 0.875s。
    const long = resolveFrameContract({ plannedSec: 5, frames: 141, fps: 24 })
    expect(long.usedSec).toBe(5)
    expect(long.surplusSec).toBeCloseTo(0.875, 3)
    expect(long.truncated).toBe(false)

    // 124 帧 = 5.1667s，比计划 5.17s 只少 3ms：低于阈值不误报截断。
    const exact = resolveFrameContract({ plannedSec: 5.17, frames: 124, fps: 24 })
    expect(exact.truncated).toBe(false)
    expect(exact.shortfallSec).toBeLessThan(0.02)
  })

  it('@core:studio-timeline 缺实测数据时回退计划时长，不凭空报警；安全时长保留三位小数且不低于 0.1s', () => {
    const none = resolveFrameContract({ plannedSec: 8 })
    expect(none.usedSec).toBe(8)
    expect(none.truncated).toBe(false)
    expect(none.actualSec).toBeUndefined()

    expect(actualClipSeconds(90, undefined)).toBeUndefined()
    expect(actualClipSeconds(90, 0)).toBeUndefined()
    expect(actualClipSeconds(0, 24)).toBeUndefined()
    expect(resolveFrameContract({ plannedSec: 5, frames: 90 }).truncated).toBe(false)

    expect(safeClipSeconds(3.7499999)).toBe(3.75)
    expect(safeClipSeconds(0)).toBe(0.1)
    expect(safeClipSeconds(Number.NaN)).toBe(0.1)
    expect(safeClipSeconds(-3)).toBe(0.1)
  })
})

// ==========================================================================
// 原 tests/unit/shot-attribution.test.ts
// ==========================================================================

const shotExpectation: AttributionExpectation = { shotNumber: 8, kind: 'video', width: 960, height: 544, seconds: 5 }
const goodActual: AttributionActual = { kind: 'video', width: 960, height: 544, durationSec: 4.6, frames: 110, fps: 24 }

describe('C-09 任务归属核对', () => {
  it('@core:studio-media 注入错配样本必须报出镜号与差异，不能静默挂载', () => {
    // 复现 D-11：v_00009_ 被取回为 V08。取回的内容是竖屏，而第 8 镜请求的是横屏。
    const portrait: AttributionActual = { kind: 'video', width: 544, height: 960, durationSec: 4.9, frames: 118, fps: 24 }
    const result = checkAttribution(shotExpectation, portrait)

    expect(result.trusted, '尺寸不符必须判为归属存疑').toBe(false)
    expect(result.issues.map((issue) => issue.field)).toContain('width')
    expect(result.issues.map((issue) => issue.field)).toContain('height')
    // 报错必须指认到具体镜号，否则用户不知道该核对哪一镜
    expect(result.message).toContain('第 8 镜')
    expect(result.message).toContain('归属存疑')
    // 必须给出可判断的差异，不能只说「不对」
    expect(result.message).toContain('544')
    expect(result.message).toContain('960')
    // 明确告知没有自动挂载
    expect(result.message).toContain('暂停挂载')

    // 时长明显短于请求：取回来的可能是别的镜头的短片段
    const shortClip: AttributionActual = { kind: 'video', width: 960, height: 544, durationSec: 2.1, frames: 50, fps: 24 }
    const shortResult = checkAttribution(shotExpectation, shortClip)
    expect(shortResult.trusted).toBe(false)
    expect(shortResult.issues[0].field).toBe('duration')
    expect(shortResult.message).toContain('第 8 镜')

    // 类型不符：要视频却取回图片
    const wrongKind = checkAttribution(shotExpectation, { kind: 'image', width: 960, height: 544 })
    expect(wrongKind.trusted).toBe(false)
    expect(wrongKind.issues[0].field).toBe('kind')
  })

  it('@core:studio-media 正常的模型抖动不算错配：帧数不足导致的时长偏差要放行', () => {
    // 请求 5s，实际 3.7s（D-05 记录的真实情况：请求 124 帧实际 90 帧）——这是模型常态，不是错配
    const shortButValid: AttributionActual = { kind: 'video', width: 960, height: 544, durationSec: 3.75, frames: 90, fps: 24 }
    expect(checkAttribution(shotExpectation, shortButValid).trusted, '帧数不足不该被判错配').toBe(true)

    // 32px 对齐微调要放行
    expect(checkAttribution(shotExpectation, { ...goodActual, width: 928 }).trusted, '32px 内偏差应放行').toBe(true)

    // 完全正常
    expect(checkAttribution(shotExpectation, goodActual).trusted).toBe(true)
    // 没有可测特征时不做判断（不能凭缺失信息判错配）
    expect(checkAttribution(shotExpectation, { kind: 'video' }).trusted).toBe(true)
  })

  it('@core:studio-media 多候选时按内容选唯一匹配；无法区分时交人确认而不是猜', () => {
    const candidates: AttributionExpectation[] = [
      { shotNumber: 7, kind: 'video', width: 960, height: 544, seconds: 5 },
      { shotNumber: 8, kind: 'video', width: 544, height: 960, seconds: 5 }
    ]

    // 实测是竖屏 → 唯一匹配第 8 镜
    const portrait: AttributionActual = { kind: 'video', width: 544, height: 960, durationSec: 4.8 }
    const picked = pickMatchingTarget(candidates, portrait)
    expect(picked.pick?.shotNumber).toBe(8)
    expect(picked.reason).toBe('unique')

    // 实测是横屏 → 唯一匹配第 7 镜
    const landscape: AttributionActual = { kind: 'video', width: 960, height: 544, durationSec: 4.8 }
    expect(pickMatchingTarget(candidates, landscape).pick?.shotNumber).toBe(7)

    // 两个候选都无法区分（同尺寸同长）→ 不猜，交人确认
    const sameSize: AttributionActual = { kind: 'video', width: 960, height: 544, durationSec: 5 }
    const ambiguous = pickMatchingTarget(
      [
        { shotNumber: 1, kind: 'video', width: 960, height: 544, seconds: 5 },
        { shotNumber: 2, kind: 'video', width: 960, height: 544, seconds: 5 }
      ],
      sameSize
    )
    expect(ambiguous.pick, '无法区分时不能猜').toBeNull()
    expect(ambiguous.reason).toBe('ambiguous')

    // 全都对不上 → 不猜
    const none = pickMatchingTarget(candidates, { kind: 'video', width: 1920, height: 1080, durationSec: 5 })
    expect(none.pick).toBeNull()
    expect(none.reason).toBe('none')

    // 单候选：归属本来就确定，但仍返回它（由 checkAttribution 判可信度）
    expect(pickMatchingTarget([candidates[0]], portrait).reason).toBe('single')
  })
})
