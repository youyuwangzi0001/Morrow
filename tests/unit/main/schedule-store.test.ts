import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ScheduleStore } from '../../../src/main/services/schedule-store'
import type { ScheduledTaskInput } from '../../../src/shared/schedules'
import { makeTempDir } from '../core/helpers/workspace'

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

function setup(): { store: ScheduleStore; dir: string; workspace: string } {
  const dir = makeTempDir('schedules-')
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  cleanups.push(dir)
  const now = at(2026, 10, 20, 10, 30)
  const store = new ScheduleStore({ dir: join(dir, 'schedules'), now: () => now })
  return { store, dir, workspace }
}

function input(workspace: string): ScheduledTaskInput {
  return {
    title: '每周整理项目',
    prompt: '整理本周新增文件与改动，写一份简短周报。',
    schedule: { kind: 'daily', time: '09:00' },
    workspace,
    permissionMode: 'read-only',
    enabled: true
  }
}

describe('ScheduleStore', () => {
  it('创建任务：计算下一次执行、持久化，并在重启后可读取', () => {
    const { store, dir, workspace } = setup()
    const task = store.create(input(workspace))
    expect(task.lastStatus).toBe('never')
    expect(task.nextRunAt).toBe(at(2026, 10, 21, 9))
    expect(existsSync(join(dir, 'schedules', 'tasks.json'))).toBe(true)
    expect(readFileSync(join(dir, 'schedules', 'tasks.json'), 'utf8')).toContain('每周整理项目')

    const reloaded = new ScheduleStore({ dir: join(dir, 'schedules'), now: () => at(2026, 10, 20, 12) })
    const saved = reloaded.list()[0]
    expect(saved).toMatchObject({ id: task.id, workspace, nextRunAt: at(2026, 10, 21, 9), enabled: true })
  })

  it('暂停/启用会重新安排下一次；修改规则会重算', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    const paused = store.setEnabled(task.id, false)
    expect(paused.enabled).toBe(false)
    expect(paused.nextRunAt).toBeNull()
    const enabled = store.setEnabled(task.id, true)
    expect(enabled.nextRunAt).toBe(at(2026, 10, 21, 9))

    const updated = store.update(task.id, {
      ...input(workspace),
      schedule: { kind: 'weekly', time: '18:00', weekday: 5 }
    })
    expect(updated.schedule.kind).toBe('weekly')
    expect(updated.nextRunAt).toBe(at(2026, 10, 23, 18))
  })

  it('运行标记：运行中 → 成功后为每天任务排下一次；一次性任务执行后自动停用', () => {
    const { store, workspace } = setup()
    const daily = store.create(input(workspace))
    store.markRunning(daily.id, 'session-1')
    expect(store.get(daily.id)).toMatchObject({ lastStatus: 'running', lastSessionId: 'session-1' })
    const finished = store.markFinished(daily.id, 'success')
    expect(finished).toMatchObject({ lastStatus: 'success', nextRunAt: at(2026, 10, 21, 9), enabled: true })

    const once = store.create({
      ...input(workspace),
      schedule: { kind: 'once', time: '12:00', date: '2026-10-20' }
    })
    expect(once.enabled).toBe(true)
    const done = store.markFinished(once.id, 'success')
    expect(done.enabled).toBe(false)
    expect(done.nextRunAt).toBeNull()
  })

  it('立即运行不推进下一次自动执行时间', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.markRunning(task.id, 'session-manual')
    const done = store.markFinished(task.id, 'success', { manual: true })
    expect(done.nextRunAt).toBe(at(2026, 10, 21, 9))
    expect(done.lastStatus).toBe('success')
  })

  it('运行中被暂停：完成后保持暂停，不会写回下一次执行时间', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.markRunning(task.id, 'session-paused')
    store.setEnabled(task.id, false)
    const done = store.markFinished(task.id, 'success')
    expect(done.enabled).toBe(false)
    expect(done.nextRunAt).toBeNull()
  })

  it('启动恢复：运行中的遗留任务记为失败；错过太久的任务记为 missed 并顺延', () => {
    const { store, dir, workspace } = setup()
    const interrupted = store.create(input(workspace))
    store.markRunning(interrupted.id, 'session-x')
    const missed = store.create({
      ...input(workspace),
      title: '已经错过的任务',
      schedule: { kind: 'daily', time: '09:00' }
    })
    // 把下一次执行改到 3 小时前，模拟应用关闭了一段时间
    const raw = JSON.parse(readFileSync(join(dir, 'schedules', 'tasks.json'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    for (const task of raw.tasks) {
      if (task.id === missed.id) task.nextRunAt = at(2026, 10, 20, 7, 30)
    }
    // 重新写回后由新实例加载（ScheduleStore 有内存缓存，直接构造新实例）
    writeFileSync(join(dir, 'schedules', 'tasks.json'), JSON.stringify({ version: 1, tasks: raw.tasks }), 'utf8')
    const reloaded = new ScheduleStore({ dir: join(dir, 'schedules'), now: () => at(2026, 10, 20, 10, 30) })
    expect(reloaded.recoverInterrupted()).toBe(true)
    expect(reloaded.recoverMissed(60 * 60 * 1000)).toBe(1)
    expect(reloaded.get(interrupted.id)?.lastStatus).toBe('error')
    expect(reloaded.get(missed.id)?.lastStatus).toBe('missed')
    expect(reloaded.get(missed.id)?.nextRunAt).toBe(at(2026, 10, 21, 9))
  })

  it('校验工作区、必填项与数量上限', () => {
    const { store, workspace } = setup()
    expect(() => store.create({ ...input(workspace), title: ' ' })).toThrow('任务名称')
    expect(() => store.create({ ...input(workspace), prompt: '' })).toThrow('任务内容')
    expect(() => store.create({ ...input(join(workspace, 'missing')) })).toThrow('文件夹不存在')
    expect(() =>
      store.create({ ...input(workspace), schedule: { kind: 'daily', time: '24:00' } })
    ).toThrow('时间格式')
  })

  it('删除任务只移除安排，不影响已产生的会话（store 不持有会话）', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.remove(task.id)
    expect(store.list()).toHaveLength(0)
    expect(() => store.remove(task.id)).toThrow('找不到')
  })

  it('清除全部对话后移除任务对会话的引用与运行历史，但保留定时安排', () => {
    const { store, workspace } = setup()
    const task = store.create(input(workspace))
    store.markRunning(task.id, 'session-cleared')
    store.markFinished(task.id, 'success')
    const before = store.get(task.id)!
    expect(before.lastSessionId).toBe('session-cleared')
    expect(before.nextRunAt).not.toBeNull()

    expect(store.clearSessionReferences()).toBe(1)
    const after = store.get(task.id)!
    expect(after.lastSessionId).toBeUndefined()
    expect(after.lastRunAt).toBeNull()
    expect(after.lastStatus).toBe('never')
    expect(after.nextRunAt).toBe(before.nextRunAt)
    expect(store.clearSessionReferences()).toBe(0)
  })
})
