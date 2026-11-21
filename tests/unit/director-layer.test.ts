import { describe, expect, it } from 'vitest'
import {
  SHOT_SIZE_CHAIN,
  SHOT_SIZE_LABELS,
  SHOT_SIZE_ORDER,
  auditShotSizeChain,
  auditStoryboard,
  buildShotSizeChain,
  cameraMovesForBeat,
  directorShotSize,
  isShowyMove,
  markReactionShots,
  shotSizeDistance,
  shotSizeLabel
} from '../../src/shared/director-layer'
import type { ShotSize, StoryboardTable } from '../../src/shared/director-layer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASELINE_AVG_CHARS,
  BEAT_PACING,
  LINES_PER_SEGMENT,
  MAX_LINE_CHARS,
  averageLineChars,
  auditDurationPlan,
  countDialogueSentences,
  durationPlanFromShots,
  normalizeBeats,
  planDurations,
  splitDialogueSentences
} from '../../src/shared/director-layer'
import type { Beat, DurationPlan } from '../../src/shared/director-layer'

describe('BATCH 2 导演层', () => {
  it('@core:studio-media 景别双向映射：中文标签与枚举严格互逆，认不出返回 null', () => {
    // 这是「唯一来源」的前提：正反两向必须对得上，否则界面写大远景、审核按全景判。
    for (const size of SHOT_SIZE_ORDER) {
      expect(directorShotSize(shotSizeLabel(size)), size).toBe(size)
      expect(SHOT_SIZE_LABELS[size]).toBe(shotSizeLabel(size))
    }

    // 子串包含的判定顺序不能乱：中近景不能落成中景，大远景不能落成全景。
    expect(directorShotSize('中近景')).toBe('MCU')
    expect(directorShotSize('中景')).toBe('MS')
    expect(directorShotSize('大远景')).toBe('EWS')
    expect(directorShotSize('远景')).toBe('WS')
    expect(directorShotSize('全景')).toBe('WS')
    expect(directorShotSize('大特写')).toBe('ECU')
    expect(directorShotSize('特写')).toBe('CU')

    // 带修饰的长句也认得（作品里 shotSize 是用户可编辑的人话）
    expect(directorShotSize('第 3 镜的中近景')).toBe('MCU')
    // 认不出来不能猜：猜错会让审计给出假结论
    expect(directorShotSize('')).toBeNull()
    expect(directorShotSize('   ')).toBeNull()
    expect(directorShotSize('不知道')).toBeNull()
  })

  it('@core:studio-media 景别链：方案模板 WS→CU→MS→MCU，禁连续同景别，反应镜更近', () => {
    expect(SHOT_SIZE_CHAIN).toEqual(['WS', 'CU', 'MS', 'MCU'])
    expect(buildShotSizeChain(4)).toEqual(['WS', 'CU', 'MS', 'MCU'])
    expect(SHOT_SIZE_ORDER.join('>')).toBe('EWS>WS>MS>MCU>CU>ECU')
    // WS(1) → CU(4) 跨 3 级
    expect(shotSizeDistance('WS', 'CU')).toBe(3)
    expect(shotSizeDistance('MS', 'MCU')).toBe(1)

    // 反应镜至少中近景：全景看不清表情
    const chain = buildShotSizeChain(4, { reactionIndices: [0] })
    expect(chain[0]).not.toBe('WS')
    expect(chain[0]).not.toBe('EWS')

    // 1–6 镜都不能出现相邻同景别
    for (let count = 1; count <= 6; count += 1) {
      const built = buildShotSizeChain(count)
      expect(built.every((value, index) => index === 0 || value !== built[index - 1]), `${count} 镜`).toBe(true)
    }

    // 反向：人为相邻同景别必须报出
    const issues = auditShotSizeChain([
      { number: 1, shotSize: 'CU', cameraMove: 'slow push in', action: 'a', reaction: false },
      { number: 2, shotSize: 'CU', cameraMove: 'slow pull back', action: 'b', reaction: false }
    ])
    expect(issues.some((issue) => issue.code === 'adjacent-same-size')).toBe(true)
    expect(issues[0].message).toContain('第 1 镜')
    expect(issues[0].message).toContain('像 PPT')
  })

  it('@core:studio-media 分镜表审核：首镜空镜报 error、无反应镜报 warn、出彩镜占比越界报 warn', () => {
    // 首镜是远景空镜 → error（前 5 秒定生死）
    for (const size of ['EWS', 'WS'] as const) {
      const table: StoryboardTable = {
        segments: [{ index: 1, beat: 'bun', shots: [
          { number: 1, shotSize: size, cameraMove: 'slow push in', action: '空荡的走廊', reaction: false },
          { number: 2, shotSize: 'CU', cameraMove: 'slow push in', action: '抬头', reaction: true }
        ] }]
      }
      expect(auditStoryboard(table).some((issue) => issue.code === 'weak-opening' && issue.level === 'error'), size).toBe(true)
    }

    // 无反应镜 → warn
    const noReaction: StoryboardTable = {
      segments: [{ index: 1, beat: 'bun', shots: [
        { number: 1, shotSize: 'CU', cameraMove: 'slow push in', action: 'a', reaction: false },
        { number: 2, shotSize: 'MS', cameraMove: 'slow pull back', action: 'b', reaction: false }
      ] }]
    }
    expect(auditStoryboard(noReaction).some((issue) => issue.code === 'no-reaction-shot')).toBe(true)

    // 出彩镜占比：全普通报偏少，全出彩报太多
    const makeTable = (moves: string[]): StoryboardTable => ({
      segments: [{ index: 1, beat: 'bun', shots: moves.map((cameraMove, index) => ({
        number: index + 1,
        shotSize: (['CU', 'MS', 'MCU', 'ECU'] as const)[index],
        cameraMove,
        action: 'a',
        reaction: index === 3
      })) }]
    })
    expect(auditStoryboard(makeTable(['slow push in', 'gentle lateral track', 'slow pull back', 'steady hold with slight drift'])).some((issue) => issue.code === 'few-showy-shots')).toBe(true)
    expect(auditStoryboard(makeTable(['whip pan', 'crash zoom', 'dolly zoom', 'slow orbit'])).some((issue) => issue.code === 'too-many-showy-shots')).toBe(true)
    // 4 镜 1 出彩 = 25%，正好在下界，不报
    expect(auditStoryboard(makeTable(['whip pan', 'slow push in', 'slow pull back', 'steady lateral track'])).some((issue) => /出彩镜/.test(issue.message))).toBe(false)

    expect(isShowyMove('whip pan')).toBe(true)
    expect(isShowyMove('slow push in')).toBe(false)
  })

  it('@core:studio-media 反应镜配对：台词之后那一镜为反应，无台词段落用尾镜落点', () => {
    const marked = markReactionShots({
      index: 1,
      beat: 'bun',
      shots: [
        { shotSize: 'WS', cameraMove: 'slow push in', action: '她在门口停下', dialogue: '' },
        { shotSize: 'CU', cameraMove: 'slow push in', action: '她说出那句话', dialogue: '还能修好吗？' },
        { shotSize: 'MS', cameraMove: 'steady lateral track', action: '他沉默', dialogue: '' },
        { shotSize: 'MCU', cameraMove: 'slow pull back', action: '她看向远处', dialogue: '' }
      ]
    }, '修伞的老人')
    // 台词在第 2 镜，所以第 3 镜是反应
    expect(marked.shots.map((shot) => shot.reaction)).toEqual([false, false, true, false])

    // 无台词时尾镜作情绪落点
    const noDialogue = markReactionShots({ index: 2, beat: 'fan', shots: [
      { shotSize: 'MS', cameraMove: 'slow push in', action: '雨落在伞面上', dialogue: '' },
      { shotSize: 'CU', cameraMove: 'slow pull back', action: '伞骨颤动', dialogue: '' }
    ] }, '老人')
    expect(noDialogue.shots[noDialogue.shots.length - 1].reaction).toBe(true)

    // 运镜池按节拍分开（文戏 / 动作）
    expect(cameraMovesForBeat('bao').showy.length).toBeGreaterThan(0)
    expect(cameraMovesForBeat('bun').standard.length).toBeGreaterThan(0)
    expect(cameraMovesForBeat('bao').showy).not.toEqual(cameraMovesForBeat('bun').showy)
  })
})

// ==========================================================================
// 原 tests/unit/duration-planner.test.ts
// ==========================================================================

/** 读随包真实台词（demo-final.srt）。 */
function realLines(): Array<{ speaker: string; text: string }> {
  const srt = readFileSync(join(process.cwd(), 'tests/fixtures/studio-demo/demo-final.srt'), 'utf8')
  return srt
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const rows = block.split(/\r?\n/).filter(Boolean)
      const text = rows.filter((row) => !/^\d+$/.test(row) && !row.includes('-->')).join('')
      return { speaker: '角色', text }
    })
    .filter((line) => line.text.trim().length > 0)
}

describe('C-07 时长规划器', () => {
  it('@core:studio-media 切句：中文句读、连续句读、引号内句号都处理正确', () => {
    expect(splitDialogueSentences('还能修好吗？')).toEqual(['还能修好吗？'])
    expect(splitDialogueSentences('还能修好吗？修不好也没关系。')).toHaveLength(2)
    // 连续句读不能切出只有一个标点的空句
    expect(splitDialogueSentences('真的？！')).toEqual(['真的？！'])
    expect(splitDialogueSentences('走吧……')).toEqual(['走吧……'])
    // 引语整体是一句
    expect(splitDialogueSentences('他说：「走吧。」然后转身。')).toHaveLength(1)
    expect(splitDialogueSentences('   ')).toEqual([])
    // 统计入口
    expect(countDialogueSentences([{ speaker: 'A', text: '走吧。好。' }])).toBe(2)
    expect(averageLineChars([{ speaker: 'A', text: '还能修好吗' }])).toBe(5)
  })

  it('@core:studio-media 段数 = ceil(句数 ÷ 3)，这是方案的硬公式', () => {
    expect(LINES_PER_SEGMENT).toBe(3)
    const cases: Array<[number, number]> = [[3, 1], [4, 2], [6, 2], [7, 3], [9, 3], [10, 4]]
    for (const [lines, segments] of cases) {
      const plan = planDurations(Array.from({ length: lines }, () => ({ speaker: 'A', text: '走吧。' })))
      expect(plan.segments.length, `${lines} 句应为 ${segments} 段`).toBe(segments)
    }
  })

  it('@core:studio-media 核心验收：随包真实台词产出非等长时间表，且段内也不等长', () => {
    const lines = realLines()
    expect(lines.length, '随包样例应能读出真实台词').toBeGreaterThan(0)

    const plan = planDurations(lines)
    // 非等长：这是本卡存在的理由（全等长＝催眠效应）
    const durations = plan.segments.map((segment) => segment.durationSec)
    expect(new Set(durations.map((value) => value.toFixed(2))).size).toBeGreaterThan(1)
    expect(plan.varied).toBe(true)

    // 段内也不能全等长，否则段内仍是 PPT
    for (const segment of plan.segments) {
      expect(segment.shotDurations.length).toBeGreaterThanOrEqual(2)
      expect(segment.shotDurations.length).toBeLessThanOrEqual(4)
      expect(new Set(segment.shotDurations.map((value) => value.toFixed(2))).size).toBeGreaterThan(1)
      for (const seconds of segment.shotDurations) {
        expect(seconds).toBeGreaterThanOrEqual(2.5)
        expect(seconds).toBeLessThanOrEqual(12)
      }
    }

    expect(auditDurationPlan(plan)).toHaveLength(0)
  })

  it('@core:studio-media 多个不同剧本都必须非等长，不能只在某个样本上成立', () => {
    const scripts: Record<string, Array<{ speaker: string; text: string }>> = {
      短三句: [{ speaker: 'A', text: '还能修好吗？' }, { speaker: 'B', text: '修不好也没关系。' }, { speaker: 'A', text: '你认识她，对吗？' }],
      长十句: Array.from({ length: 10 }, (_, index) => ({ speaker: 'A', text: `第${index + 1}句台词在这里。` })),
      混长句: [
        { speaker: 'A', text: '还能修好吗？' },
        { speaker: 'B', text: '这把伞，能把时间倒着走。' },
        { speaker: 'A', text: '你认识她，对吗？' },
        { speaker: 'B', text: '我好像，正在忘记她。' },
        { speaker: 'A', text: '这次，别再弄丢了。' }
      ]
    }
    for (const [label, lines] of Object.entries(scripts)) {
      const plan = planDurations(lines)
      const durations = plan.segments.map((segment) => segment.durationSec)
      // 单段剧本不存在段间等长问题
      if (plan.segments.length > 1) {
        expect(new Set(durations.map((value) => value.toFixed(2))).size, `${label} 应为非等长`).toBeGreaterThan(1)
      }
      // 无论几段，段内都不能全等长
      for (const segment of plan.segments) {
        if (segment.shotDurations.length > 1) {
          expect(new Set(segment.shotDurations.map((value) => value.toFixed(2))).size, `${label} 段 ${segment.index} 段内应非等长`).toBeGreaterThan(1)
        }
      }
    }
  })

  it('@core:studio-media 反向验收：全等长必须报 error 且说明是催眠效应，不能静默通过', () => {
    const forcedEqual: DurationPlan = {
      segments: [
        { index: 1, lines: 3, beat: 'bun', durationSec: 10, shotDurations: [2.5, 2.5, 2.5, 2.5] },
        { index: 2, lines: 3, beat: 'fan', durationSec: 10, shotDurations: [2.5, 2.5, 2.5, 2.5] },
        { index: 3, lines: 3, beat: 'bao', durationSec: 10, shotDurations: [2.5, 2.5, 2.5, 2.5] }
      ],
      totalSec: 30,
      varied: false,
      averageChars: 9,
      overlongLines: 0,
      reason: '构造的全等长'
    }
    const issues = auditDurationPlan(forcedEqual)
    const error = issues.find((issue) => issue.level === 'error')
    expect(error, '全等长必须是 error').toBeDefined()
    expect(error?.message).toContain('催眠')
    // code 必须是门禁登记的那个，否则 renderProject 的映射会静默漏掉这一项
    expect(error?.code).toBe('uniform-duration')

    // 超长句与均长越界都要提示
    const overlong = planDurations([{ speaker: 'A', text: '这是一句明显超过二十个字上限的台词它塞不进两秒五的镜头里去吧。' }])
    expect(overlong.overlongLines).toBeGreaterThan(0)
    expect(auditDurationPlan(overlong).some((issue) => /超过 20 字/.test(issue.message))).toBe(true)
    expect(MAX_LINE_CHARS).toBe(20)
    expect(BASELINE_AVG_CHARS).toBe(8.7)
  })

  it('@core:studio-media 成片时长按场景聚段：全片等长要报，段内不齐但段间有差就不报', () => {
    // 成片门禁审的是**实际时长**，不是重新规划一份：durationPlanFromShots 拿
    // shot.durationSec 当依据，所以必须在这里锁住它的聚段口径。
    // 三场各 16s → 全等长 → 报 uniform-duration（两段时按既有口径不报，
    // 段数门槛与 planDurations 那条判定一致，不能在这里另立一套）
    const sameScene = durationPlanFromShots([
      { sceneId: 'scene-1', durationSec: 8 },
      { sceneId: 'scene-1', durationSec: 8 },
      { sceneId: 'scene-2', durationSec: 8 },
      { sceneId: 'scene-2', durationSec: 8 },
      { sceneId: 'scene-3', durationSec: 8 },
      { sceneId: 'scene-3', durationSec: 8 }
    ])
    expect(sameScene.segments.map((segment) => segment.durationSec)).toEqual([16, 16, 16])
    expect(auditDurationPlan(sameScene).some((issue) => issue.code === 'uniform-duration')).toBe(true)

    // 段内差异不影响「全等长」判定：判的是段与段之间
    const mixed = durationPlanFromShots([
      { sceneId: 'scene-1', durationSec: 5 },
      { sceneId: 'scene-1', durationSec: 7 },
      { sceneId: 'scene-2', durationSec: 4 },
      { sceneId: 'scene-2', durationSec: 13 }
    ])
    expect(mixed.segments.map((segment) => segment.durationSec)).toEqual([12, 17])
    expect(auditDurationPlan(mixed)).toHaveLength(0)

    // 缺时长 / 时长为 0 的镜头不参与，否则「没填」会被误判成「等长」
    const partial = durationPlanFromShots([
      { sceneId: 'scene-1', durationSec: 0 },
      { sceneId: 'scene-1', durationSec: 6 },
      { durationSec: 9 }
    ])
    expect(partial.segments).toHaveLength(2)
    expect(partial.segments[0].shotDurations).toEqual([6])

    // 单段不存在段间等长，与 planDurations 的口径一致
    expect(durationPlanFromShots([{ sceneId: 's', durationSec: 5 }, { sceneId: 's', durationSec: 9 }]).varied).toBe(true)
    expect(durationPlanFromShots([]).segments).toHaveLength(0)
  })

  it('@core:studio-media 节拍补全：前两段是憋、顺序不倒退、憋长于爆发', () => {
    // 默认节拍补全：前两段必须是「憋」，满足爆发前 ≥2 次憋，且相邻段不重复
    const beats = normalizeBeats([], 4)
    expect(beats.slice(0, 2)).toEqual(['bun', 'bun'])
    expect(beats[2]).toBe('fan')
    expect(beats[3]).toBe('bao')
    // 节拍系数：憋最长、爆发最短（这是时长的真实来源，不是随机抖动）
    expect(BEAT_PACING.bun).toBeGreaterThan(BEAT_PACING.bao)

    // 指定节拍时按指定走
    const custom: Beat[] = ['bun', 'bao']
    expect(normalizeBeats(custom, 2)).toEqual(['bun', 'bao'])

    // 补全出的节拍拿去规划，不能自己撞上「全等长」
    const planned = planDurations(Array.from({ length: 9 }, () => ({ speaker: 'A', text: '走吧。' })))
    expect(planned.segments.length).toBe(3)
    expect(planned.varied).toBe(true)
  })
})

// 景别类型必须仍然可被外部按字面量使用（映射的返回类型依赖它）
const _typecheck: ShotSize = 'MCU'
void _typecheck
