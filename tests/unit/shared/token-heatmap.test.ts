import { describe, expect, it } from 'vitest'
import { buildMonthLabels } from '../../../src/shared/token-heatmap'

function columns(labels: ReturnType<typeof buildMonthLabels>): number[] {
  return labels.map((label) => label.column)
}

describe('buildMonthLabels', () => {
  it('起始月剩余不足 3 周时不标起始月，月份标签不重叠', () => {
    const labels = buildMonthLabels(new Date(2025, 9, 22), new Date(2026, 9, 21))
    expect(labels.map((label) => label.label)).toEqual([
      '11月',
      '12月',
      '1月',
      '2月',
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
      '8月',
      '9月',
      '10月'
    ])
    expect(columns(labels)).toEqual([1, 6, 10, 14, 18, 23, 27, 32, 36, 40, 45, 49])
    for (let index = 1; index < labels.length; index += 1) {
      expect(labels[index].column - labels[index - 1].column).toBeGreaterThanOrEqual(3)
    }
  })

  it('起始月剩余满 3 周时保留起始月标签', () => {
    const labels = buildMonthLabels(new Date(2025, 9, 11), new Date(2025, 11, 31))
    expect(labels.map((label) => label.label)).toEqual(['10月', '11月', '12月'])
    expect(columns(labels)).toEqual([0, 3, 8])
  })

  it('起始月只剩 20 天时不标起始月，避免和紧邻的下月标签挤在一起', () => {
    const labels = buildMonthLabels(new Date(2025, 9, 12), new Date(2025, 11, 31))
    expect(labels.map((label) => label.label)).toEqual(['11月', '12月'])
    expect(columns(labels)).toEqual([3, 8])
  })

  it('标签列严格递增且间距不小于 3 列', () => {
    const ranges: Array<[Date, Date]> = [
      [new Date(2024, 1, 1), new Date(2025, 0, 31)],
      [new Date(2025, 0, 30), new Date(2025, 11, 31)],
      [new Date(2026, 1, 27), new Date(2027, 2, 5)]
    ]
    for (const [start, end] of ranges) {
      const labels = buildMonthLabels(start, end)
      expect(labels.length).toBeGreaterThan(1)
      for (let index = 1; index < labels.length; index += 1) {
        expect(labels[index].column).toBeGreaterThanOrEqual(labels[index - 1].column + 3)
      }
    }
  })
})
