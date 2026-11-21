import { describe, expect, it } from 'vitest'
import { phoneProducts, phoneWorks } from '../../src/main/phone-works'
import type { StudioDelivery, StudioProjectSummary } from '../../src/shared/studio'

/**
 * 作品摘要的映射。
 *
 * 这一层只做「字段改名 + 排序 + 截断」，但它决定手机作品页看到的是不是
 * 桌面真实进度：阶段名靠 id 查手机内置表，进度必须是 0–100 的整数。
 */

function project(overrides: Partial<StudioProjectSummary> = {}): StudioProjectSummary {
  return {
    id: 'w1',
    kind: 'short',
    title: '末日咖啡馆',
    logline: '末日后唯一还开着的咖啡馆',
    updatedAt: 1_700_000_000_000,
    createdAt: 1_600_000_000_000,
    stage: 'writing',
    progress: 42.6,
    words: 1200,
    chapters: 3,
    shots: 0,
    assets: 2,
    budget: { spent: 0, limit: 0 } as StudioProjectSummary['budget'],
    demo: false,
    ...overrides
  }
}

describe('phoneWorks', () => {
  it('@core:relay 字段改名并取整进度', () => {
    const [work] = phoneWorks([project()])
    expect(work).toMatchObject({
      id: 'w1',
      title: '末日咖啡馆',
      kind: 'short',
      logline: '末日后唯一还开着的咖啡馆',
      updatedAtMillis: 1_700_000_000_000,
      stage: 'writing',
      progress: 43,
      chapters: 3,
      shots: 0,
      assets: 2,
      words: 1200
    })
  })

  it('@core:relay 按更新时间倒序且最多 40 个', () => {
    const list = Array.from({ length: 45 }, (_, i) =>
      project({ id: `w${i}`, title: `作品 ${i}`, updatedAt: 1_000 + i })
    )
    const works = phoneWorks(list)
    expect(works).toHaveLength(40)
    expect(works[0].id).toBe('w44')
    expect(works[39].id).toBe('w5')
  })

  it('@core:relay 进度越界被夹到 0–100', () => {
    const works = phoneWorks([
      project({ id: 'a', progress: -5 }),
      project({ id: 'b', progress: 140 }),
      project({ id: 'c', progress: Number.NaN })
    ])
    expect(works.map((w) => w.progress)).toEqual([0, 100, 0])
  })

  it('@core:relay 产物清单按创建时间倒序并映射字段', () => {
    const deliveries = [
      { id: 'd1', kind: 'pdf', label: '成书.pdf', path: 'exports/a.pdf', bytes: 100, sha256: '', createdAt: 2 },
      { id: 'd2', kind: 'mp4', label: '成片', path: 'exports/a.mp4', bytes: 200, sha256: '', createdAt: 3 }
    ] as StudioDelivery[]
    const [work] = phoneWorks([project()], () => phoneProducts(deliveries))
    expect(work.products.map((p) => p.id)).toEqual(['d2', 'd1'])
    expect(work.products[0]).toMatchObject({ kind: 'mp4', label: '成片', bytes: 200, createdAtMillis: 3 })
  })

  it('@core:relay 没有产物时作品本身不丢', () => {
    const [work] = phoneWorks([project()])
    expect(work.id).toBe('w1')
    expect(work.products).toEqual([])
  })
})