/**
 * R9 / R2-E、M49：Goal 完成证据必须有真实、新鲜的产物文件。
 * 目录、工作区根/「.」、Goal 创建前的旧文件、空文件、缺失文件都必须拒绝。
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Goal } from '../../../src/shared/types'
import { updateGoalTool, validateGoalEvidence } from '../../../src/core/tools/meta-tools'
import { makeToolContext } from './helpers/tool-context'
import { makeTempWorkspace } from './helpers/workspace'

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: 'goal_evidence',
    objective: '生成 out/report.txt',
    status: 'active',
    round: 1,
    maxRounds: 5,
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    ...overrides
  }
}

describe('validateGoalEvidence（R2-E/M49）', () => {
  it('目录、工作区根、「.」一律拒绝', () => {
    const ws = makeTempWorkspace({ 'out/keep.txt': 'x' })
    try {
      const goal = makeGoal()
      const dir = validateGoalEvidence(['out'], ws.root, goal.createdAt)
      expect(dir.ok).toBe(false)
      if (!dir.ok) expect(dir.error).toContain('目录')

      const dot = validateGoalEvidence(['.'], ws.root, goal.createdAt)
      expect(dot.ok).toBe(false)
      const root = validateGoalEvidence([ws.root], ws.root, goal.createdAt)
      expect(root.ok).toBe(false)
      const absoluteDir = validateGoalEvidence([join(ws.root, 'out')], ws.root, goal.createdAt)
      expect(absoluteDir.ok).toBe(false)
      if (!absoluteDir.ok) expect(absoluteDir.error).toContain('目录')
    } finally {
      ws.cleanup()
    }
  })

  it('Goal 创建前就存在的旧文件拒绝（mtime 早于 createdAt）', () => {
    const ws = makeTempWorkspace({ 'out/result.json': '{"old":true}' })
    try {
      const goal = makeGoal()
      const oldPath = join(ws.root, 'out/result.json')
      const oldDate = new Date(goal.createdAt - 120_000)
      utimesSync(oldPath, oldDate, oldDate)
      const checked = validateGoalEvidence(['out/result.json'], ws.root, goal.createdAt)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.error).toContain('旧文件')
    } finally {
      ws.cleanup()
    }
  })

  it('本 Goal 期间被覆盖更新的旧路径可以算证据（mtime 已更新）', () => {
    const ws = makeTempWorkspace({ 'out/result.json': '{"old":true}' })
    try {
      const goal = makeGoal()
      const target = join(ws.root, 'out/result.json')
      const oldDate = new Date(goal.createdAt - 120_000)
      utimesSync(target, oldDate, oldDate)
      writeFileSync(target, '{"new":true}')
      const checked = validateGoalEvidence(['out/result.json'], ws.root, goal.createdAt)
      expect(checked.ok).toBe(true)
      if (checked.ok) expect(checked.paths).toEqual(['out/result.json'])
    } finally {
      ws.cleanup()
    }
  })

  it('空文件、缺失文件、goalCreatedAt 缺失时的行为', () => {
    const ws = makeTempWorkspace()
    try {
      mkdirSync(join(ws.root, 'out'), { recursive: true })
      writeFileSync(join(ws.root, 'out/empty.txt'), '')
      const goal = makeGoal()
      const empty = validateGoalEvidence(['out/empty.txt'], ws.root, goal.createdAt)
      expect(empty.ok).toBe(false)
      if (!empty.ok) expect(empty.error).toContain('空文件')
      expect(validateGoalEvidence(['out/none.txt'], ws.root, goal.createdAt).ok).toBe(false)
      // 不传 createdAt 时只做存在性/类型校验（向后兼容）
      writeFileSync(join(ws.root, 'out/new.txt'), 'ok')
      const noCreatedAt = validateGoalEvidence(['out/new.txt'], ws.root)
      expect(noCreatedAt.ok).toBe(true)
    } finally {
      ws.cleanup()
    }
  })
})

describe('update_goal(completed) 通过工具层也拒绝不合格证据', () => {
  it('evidence=["."] → 返回 ok=false，不更新目标', async () => {
    const ws = makeTempWorkspace({ 'out/result.txt': 'verified report 53' })
    try {
      const goal = makeGoal()
      let current: Goal | null = goal
      const updated: Goal[] = []
      const ctx = makeToolContext(ws, {
        goal,
        updateGoal: (patch) => {
          current = { ...goal, ...patch, updatedAt: Date.now() }
          updated.push(current)
          return current
        }
      })
      const rejected = await updateGoalTool.execute({ status: 'completed', evidence: ['.'] }, ctx)
      expect(rejected.ok).toBe(false)
      expect(String(rejected.error)).toContain('目录')
      expect(updated).toHaveLength(0)

      // 旧文件（Goal 创建前 mtime）也拒绝
      const oldPath = join(ws.root, 'out/result.txt')
      const oldDate = new Date(goal.createdAt - 120_000)
      utimesSync(oldPath, oldDate, oldDate)
      const stale = await updateGoalTool.execute({ status: 'completed', evidence: ['out/result.txt'] }, ctx)
      expect(stale.ok).toBe(false)
      expect(String(stale.error)).toContain('旧文件')

      // 新产出的非空文件 → 允许完成
      writeFileSync(join(ws.root, 'out/report.txt'), 'verified report 53')
      const accepted = await updateGoalTool.execute(
        { status: 'completed', summary: '完成报告', evidence: ['out/report.txt'] },
        ctx
      )
      expect(accepted.ok).toBe(true)
      expect(updated).toHaveLength(1)
      expect(updated[0].status).toBe('completed')
      expect(updated[0].evidence).toEqual(['out/report.txt'])
      expect(String(accepted.output)).toContain('完成')
    } finally {
      ws.cleanup()
    }
  })
})
