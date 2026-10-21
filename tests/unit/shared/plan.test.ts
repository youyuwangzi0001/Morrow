import { describe, expect, it } from 'vitest'
import {
  planStepKey,
  planStepsCompleted,
  todoMatchesPlanStep,
  todosFromPlan
} from '../../../src/shared/plan'
import type { SessionPlan, TodoItem } from '../../../src/shared/types'

function makePlan(steps: string[]): SessionPlan {
  const now = Date.now()
  return {
    id: 'plan_test',
    title: '测试计划',
    summary: '测试',
    steps: steps.map((text, index) => ({ id: `step_${index}`, text })),
    status: 'executing',
    createdAt: now,
    updatedAt: now
  }
}

function todo(text: string, status: TodoItem['status']): TodoItem {
  return { id: `todo_${text}`, text, status }
}

describe('plan progress helpers', () => {
  it('requires every plan step to have a completed todo', () => {
    const plan = makePlan(['读取数据', '生成报告', '校验结果'])
    expect(planStepsCompleted(plan, [todo('读取数据', 'completed')])).toBe(false)
    expect(
      planStepsCompleted(plan, [
        todo('读取数据', 'completed'),
        todo('生成报告', 'in_progress'),
        todo('校验结果', 'completed')
      ])
    ).toBe(false)
    expect(
      planStepsCompleted(plan, [
        todo('读取数据', 'completed'),
        todo('生成报告', 'completed'),
        todo('校验结果', 'completed')
      ])
    ).toBe(true)
  })

  it('ignores unrelated completed todos and whitespace differences', () => {
    const plan = makePlan(['读取数据', '生成报告'])
    expect(
      planStepsCompleted(plan, [
        todo('读取数据', 'completed'),
        todo('生成报告', 'completed'),
        todo('与计划无关的额外事项', 'completed')
      ])
    ).toBe(true)
    const spaced = makePlan(['读取  数据', '生成报告'])
    expect(
      planStepsCompleted(spaced, [todo('读取 数据', 'completed'), todo('生成报告', 'completed')])
    ).toBe(true)
  })

  it('matches long step text using the todo_write 200-character limit', () => {
    const longStep = `${'很长的步骤说明'.repeat(40)}结尾甲`
    const truncated = longStep.slice(0, 200)
    expect(planStepKey(longStep)).toBe(truncated)
    expect(todoMatchesPlanStep(todo(truncated, 'completed'), longStep)).toBe(true)
  })

  it('builds a fresh pending todo list from plan steps', () => {
    const plan = makePlan(['读取数据', '生成报告'])
    const todos = todosFromPlan(plan)
    expect(todos).toEqual([
      { id: 'todo_step_0', text: '读取数据', status: 'pending' },
      { id: 'todo_step_1', text: '生成报告', status: 'pending' }
    ])
  })
})
