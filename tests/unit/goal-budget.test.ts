// 目标模式预算：取消工具调用上限、轮次/时间用尽时自动续段、只在连续无进展时停止。
// 这些行为决定长任务会不会在中途被静态预算截断，属于用户可感知的核心契约。
import { describe, expect, it } from 'vitest'
import type { Goal } from '../../src/shared/types'
import {
  GOAL_MAX_ROUNDS,
  GOAL_ROUND_HARD_LIMIT,
  decideGoalBudget,
  inferGoalBudgets,
  inferGoalRounds
} from '../../src/main/agent'

function makeGoal(patch: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: 'goal_test',
    objective: '把调研结果整理成一份可交付报告',
    status: 'active',
    round: 1,
    maxRounds: 12,
    toolCalls: 0,
    activeMs: 0,
    noProgressRounds: 0,
    createdAt: now,
    updatedAt: now,
    ...patch
  }
}

describe('goal budget: 工具调用不设上限', () => {
  it('@core:goals 累计上千次工具调用也不会因此停止（这是本次修复的原始故障）', () => {
    const goal = makeGoal({ round: 3, toolCalls: 2000 })
    const decision = decideGoalBudget(goal)
    expect(decision.stop).toBeNull()
    expect(decision.extended).toBe(false)
    expect(goal.maxRounds).toBe(12)
  })

  it('@core:goals 预算对象里不再有工具调用上限字段', () => {
    const budgets = inferGoalBudgets(12)
    expect(Object.keys(budgets).sort()).toEqual(['maxActiveMs', 'maxNoProgressRounds'])
    expect(budgets.maxActiveMs).toBeGreaterThan(0)
  })
})

describe('goal budget: 轮次用尽但仍在推进 → 自动续段', () => {
  it('@core:goals round 达到 maxRounds 时不停止，而是往后续一段', () => {
    const goal = makeGoal({ round: 12, maxRounds: 12, toolCalls: 340 })
    const decision = decideGoalBudget(goal)
    expect(decision.stop).toBeNull()
    expect(decision.extended).toBe(true)
    expect(goal.maxRounds).toBeGreaterThan(12)
    // 续段后才能继续跑下一轮，否则 afterRun 会立刻再次撞墙
    expect(goal.maxRounds).toBeGreaterThan(goal.round)
  })

  it('@core:goals 连续续段最终停在超长目标上限，不会无限增长', () => {
    const goal = makeGoal({ round: GOAL_ROUND_HARD_LIMIT - 1, maxRounds: GOAL_ROUND_HARD_LIMIT - 1 })
    const extended = decideGoalBudget(goal)
    expect(extended.stop).toBeNull()
    expect(goal.maxRounds).toBe(GOAL_ROUND_HARD_LIMIT)

    goal.round = GOAL_ROUND_HARD_LIMIT
    const stopped = decideGoalBudget(goal)
    expect(stopped.stop?.reason).toBe('budget_rounds')
  })
})

describe('goal budget: 有效运行时间用尽 → 自动续段', () => {
  it('@core:goals 时间超预算但仍在推进时续上，不打断长任务', () => {
    const goal = makeGoal({ round: 4, maxRounds: 40, activeMs: 90 * 60_000, maxActiveMs: 60 * 60_000 })
    const decision = decideGoalBudget(goal)
    expect(decision.stop).toBeNull()
    expect(decision.extended).toBe(true)
    expect(goal.maxActiveMs!).toBeGreaterThan(goal.activeMs!)
  })
})

describe('goal budget: 连续无进展是唯一硬刹车', () => {
  it('@core:goals 连续无进展轮数达到上限时停止，并说明原因', () => {
    const goal = makeGoal({ round: 5, noProgressRounds: 3, maxNoProgressRounds: 3 })
    const decision = decideGoalBudget(goal)
    expect(decision.stop?.reason).toBe('no_progress')
    expect(decision.stop?.summary).toContain('没有实际进展')
    // 无进展停止不应顺手改动预算，避免「停下来的同时还扩了额度」
    expect(goal.maxRounds).toBe(12)
  })

  it('@core:goals 无进展优先于轮次续段：即使轮次也用尽，也直接停', () => {
    const goal = makeGoal({ round: 12, maxRounds: 12, noProgressRounds: 3, maxNoProgressRounds: 3 })
    const decision = decideGoalBudget(goal)
    expect(decision.stop?.reason).toBe('no_progress')
    expect(goal.maxRounds).toBe(12)
  })
})

describe('goal rounds: 按目标复杂度估算', () => {
  it('@core:goals 空目标给出可用的最小预算', () => {
    expect(inferGoalRounds('')).toBeGreaterThanOrEqual(2)
  })

  it('@core:goals 复杂长目标拿到更多轮次，便于拆成更小切片', () => {
    const simple = inferGoalRounds('整理一下下载文件夹')
    const complex = inferGoalRounds(
      '在工作区下新建 research 文件夹，全网深度调研 UE5.8、Godot 4.5、Unity 6 三个引擎的源码实现，' +
        '逐章写出 9 章报告，每章都要有引言、证据索引和交叉验证，最后整理成 HTML 与 PDF 两种交付物，' +
        '过程中持续核对引用行号与证据等级。'
    )
    expect(complex).toBeGreaterThan(simple)
    expect(complex).toBeLessThanOrEqual(GOAL_MAX_ROUNDS)
  })

  it('@core:goals 轮次估算始终落在合法区间内', () => {
    for (const text of ['一句话', '做 3 份报告', '长期跟踪 12 个来源并每日更新']) {
      const rounds = inferGoalRounds(text)
      expect(rounds).toBeGreaterThanOrEqual(2)
      expect(rounds).toBeLessThanOrEqual(GOAL_MAX_ROUNDS)
    }
  })
})