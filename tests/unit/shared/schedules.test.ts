import { describe, expect, it } from 'vitest'
import {
  computeNextRun,
  describeNextRun,
  describeSchedule,
  validateScheduleSpec,
  type ScheduleSpec
} from '../../../src/shared/schedules'

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

describe('定时规则', () => {
  const base = at(2026, 10, 20, 10, 30) // 周二 10:30

  it('每天：今天已过则排到明天，未到则排今天', () => {
    const later = computeNextRun({ kind: 'daily', time: '18:00' }, base)
    expect(later).toBe(at(2026, 10, 20, 18))
    const earlier = computeNextRun({ kind: 'daily', time: '09:00' }, base)
    expect(earlier).toBe(at(2026, 10, 21, 9))
  })

  it('每周：按星期几排到下一次；同一天已过则顺延一周', () => {
    const Tuesday = new Date(base).getDay()
    const sameFuture = computeNextRun({ kind: 'weekly', time: '18:00', weekday: Tuesday }, base)
    expect(sameFuture).toBe(at(2026, 10, 20, 18))
    const samePast = computeNextRun({ kind: 'weekly', time: '09:00', weekday: Tuesday }, base)
    expect(samePast).toBe(at(2026, 10, 27, 9))
    const twoDays = computeNextRun({ kind: 'weekly', time: '08:15', weekday: (Tuesday + 2) % 7 }, base)
    expect(twoDays).toBe(at(2026, 10, 22, 8, 15))
  })

  it('一次：使用本地日期+时间，过去时间由校验拒绝', () => {
    const future: ScheduleSpec = { kind: 'once', time: '08:00', date: '2026-10-22' }
    expect(computeNextRun(future, base)).toBe(at(2026, 10, 22, 8))
    expect(() => validateScheduleSpec(future, base)).not.toThrow()
    expect(() => validateScheduleSpec({ kind: 'once', time: '08:00', date: '2026-10-19' }, base)).toThrow(
      '晚于现在'
    )
    expect(() => validateScheduleSpec({ kind: 'once', time: '08:00', date: '2026-02-30' }, base)).toThrow('有效日期')
  })

  it('时间/星期校验与中文描述', () => {
    expect(() => validateScheduleSpec({ kind: 'daily', time: '25:00' }, base)).toThrow('时间格式')
    expect(() => validateScheduleSpec({ kind: 'weekly', time: '09:00', weekday: 9 }, base)).toThrow('星期')
    expect(describeSchedule({ kind: 'daily', time: '09:00' })).toBe('每天 09:00')
    expect(describeSchedule({ kind: 'weekly', time: '09:00', weekday: 1 })).toBe('每周一 09:00')
    expect(describeSchedule({ kind: 'once', time: '09:00', date: '2026-12-01' })).toBe('12月1日 09:00 · 一次')
  })

  it('下一次执行的中文提示', () => {
    expect(describeNextRun(null, base)).toBe('未安排')
    expect(describeNextRun(base - 1000, base)).toBe('即将执行')
    expect(describeNextRun(at(2026, 10, 20, 18), base)).toBe('今天 18:00')
    expect(describeNextRun(at(2026, 10, 21, 9), base)).toBe('明天 09:00')
    expect(describeNextRun(at(2026, 10, 25, 9), base)).toBe('5 天后 09:00')
    expect(describeNextRun(at(2026, 11, 2, 9), base)).toBe('11月2日 09:00')
  })

  it('每周日文案不重复“周”', () => {
    expect(describeSchedule({ kind: 'weekly', time: '09:00', weekday: 0 })).toBe('每周日 09:00')
  })
})
