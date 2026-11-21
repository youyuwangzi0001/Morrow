/**
 * 出包门禁的**覆盖面**用例。
 *
 * 桌面审计的 D-02/D-03 指出：GATE_CHECKS 登记 14 项，renderProject 其实只判定
 * 5 类，另一头 still-frame 又判了没登记 —— 两个方向都错。
 *
 * 现状（本轮之后）：登记 16 项、实际产出 15 项，仅 `long-silence` 待渲染后接入。
 * 这份文件守的不是「判定逻辑对不对」（那在 gate.test.ts），而是
 * **登记表与实际判定的集合是否一致**。
 */
import { describe, expect, it } from 'vitest'
import { GATE_CHECKS } from '../../src/shared/gate'
import { findAdjacentSameShotSize } from '../../src/main/studio'

/** renderProject 实际会产出的 code 集合（与本文件同步维护）。 */
const ACTUALLY_PRODUCED = [
  'hardsub',
  'seam-repeat',
  'still-frame',
  'music-vocal',
  'uniform-duration',
  // 导演层的 auditDurationPlan 接线后新增的两条（C-07）
  'adjacent-same-duration',
  'overlong-line',
  'weak-opening',
  'no-visual',
  'adjacent-same-size',
  'no-reaction-shot',
  'subtitle-missing',
  'silent-film',
  // 本轮补齐（桌面 D-02）：这两项此前进 KNOWN_GAPS，现在真的有生产者了
  'frame-shortfall',
  'music-declaration'
]

describe('出包门禁覆盖面', () => {
  /**
   * 登记了但出包路径目前判不到的项。
   *
   * 这里**显式列出**而不是让断言放水：让「未覆盖」成为一条可见的事实，
   * 而不是散落在没人读的注释里。每接上一项就从这里删掉一行。
   */
  const KNOWN_GAPS = new Set([
    // 只剩这一项。它需要**成片文件**（ffmpeg silencedetect 读真实电平），
    // 而门禁跑在渲染之前 —— 那时成片还不存在，project 上也没有 outputPath
    // （路径在 RenderResult 里）。静态替代也做不到：时间线 clip 只有轨道 id
    // 与素材 id，没有时长/起始字段，算不出「哪一段时间没有任何声音」。
    //
    // 这不是「还没接」，是**结构上属于渲染后**。将来若把门禁拆成
    // 「渲染前」+「渲染后」两段，它归后一段。
    'long-silence'
  ])

  it('@core:studio-media 实际判定的每一项都已在登记表里', () => {
    // missingGateChecks(present) 返回「登记表里有、present 里没有」的项，
    // 所以「判定了却没登记」要反过来说：把**登记表全集**喂进去，结果必须为空；
    // 再检查 present 是否为登记表的子集。
    const registry = new Set(GATE_CHECKS.map((spec) => spec.code))
    const unregistered = ACTUALLY_PRODUCED.filter((code) => !registry.has(code))
    expect(
      unregistered,
      '判定了却没登记 → 任何「按登记表核对覆盖」的检查都会漏掉它'
    ).toEqual([])
  })

  it('@core:studio-media still-frame 必须单独登记（它曾被漏掉）', () => {
    const codes = GATE_CHECKS.map((spec) => spec.code)
    expect(codes).toContain('still-frame')
    // 与接缝重复是两个概念，不能合并成一个 code
    expect(codes).toContain('seam-repeat')
  })

  it('@core:studio-media 未判定的项必须全部在已知缺口清单里', () => {
    const produced = new Set(ACTUALLY_PRODUCED)
    const orphans = GATE_CHECKS.map((spec) => spec.code).filter(
      (code) => !produced.has(code) && !KNOWN_GAPS.has(code)
    )
    expect(
      orphans,
      '出现新的「登记了但判不到」的项 → 要么接进 gateItems，要么加进 KNOWN_GAPS 并写明原因'
    ).toEqual([])
  })

  it('@core:studio-media 已知缺口不能悄悄消失（接上了就删清单）', () => {
    const produced = new Set(ACTUALLY_PRODUCED)
    const stale = [...KNOWN_GAPS].filter((code) => produced.has(code))
    expect(stale, '这些项已经接上了，请从 KNOWN_GAPS 里删掉').toEqual([])
  })

  it('@core:studio-media 相邻同景别：连续两镜才报，空景别不参与', () => {
    expect(findAdjacentSameShotSize([{ shotSize: '中景' }, { shotSize: '中景' }])).toEqual([
      { size: '中景', count: 2 }
    ])
    // 三连只报一次，不刷屏
    expect(
      findAdjacentSameShotSize([{ shotSize: '中景' }, { shotSize: '中景' }, { shotSize: '中景' }])
    ).toHaveLength(1)
    // 交替不报
    expect(
      findAdjacentSameShotSize([{ shotSize: '中景' }, { shotSize: '特写' }, { shotSize: '中景' }])
    ).toEqual([])
    // 空景别断开连续段（老项目没填景别，不该被判成「连续相同」）
    expect(
      findAdjacentSameShotSize([{ shotSize: '中景' }, { shotSize: '' }, { shotSize: '中景' }])
    ).toEqual([])
  })

  it('@core:studio-media 导演层审核已接线：出彩镜太少只报 warn，不进错的门禁位', () => {
    // 导演层的 issue code 与门禁登记 code 并不是一一对应。
    // 这条用例守的是「映射表不会把认不出的 code 塞进门禁统计」。
    const mapped = ['weak-opening', 'adjacent-same-size', 'no-reaction-shot']
    const registry = new Set(GATE_CHECKS.map((spec) => spec.code))
    // 三个被映射的目标必须都是登记过的 code
    for (const code of mapped) expect(registry.has(code), code).toBe(true)
    // 而导演层自己的名字不能出现在登记表里（它们不是门禁 code）
    expect(registry.has('few-showy-shots')).toBe(false)
    expect(registry.has('too-many-showy-shots')).toBe(false)
    expect(registry.has('empty-table')).toBe(false)
  })
})
