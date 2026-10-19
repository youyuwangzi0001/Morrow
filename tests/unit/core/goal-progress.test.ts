/**
 * R9 / R2-D、R2-F、R2-G：Goal 用量合并（不重复记账）与真实进展追踪。
 * 直接测试 main/services/goal-budget.ts 的纯函数（不 import electron）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GoalProgressTracker, mergeGoalUsage } from '../../../src/main/services/goal-budget'
import { makeTempWorkspace } from './helpers/workspace'

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('R2-D：单轮用量合并（assignment，不是累加）', () => {
  it('base + 本轮只记一次；重复合并不翻倍', () => {
    const base = { toolCalls: 5, activeMs: 10_000 }
    const round = { toolCalls: 2, activeMs: 3_000 }
    expect(mergeGoalUsage(base, round)).toEqual({ toolCalls: 7, activeMs: 13_000 })
    // 模拟 flushIncremental 与 afterRun 都执行一次：结果必须仍是 7，而不是 9
    expect(mergeGoalUsage(base, round)).toEqual({ toolCalls: 7, activeMs: 13_000 })
    // R2-D 场景：max=3，第一次调用两次 → 计数 2，不提前停
    expect(mergeGoalUsage({ toolCalls: 0 }, { toolCalls: 2, activeMs: 10 })).toMatchObject({ toolCalls: 2 })
  })

  it('非法/负数计数被 clamp，不会污染预算', () => {
    expect(mergeGoalUsage({ toolCalls: -3, activeMs: -1 }, { toolCalls: 2, activeMs: 5 })).toEqual({
      toolCalls: 2,
      activeMs: 5
    })
  })
})

describe('R2-F：空操作 / 重复写入 / 旧文件不算真实进展', () => {
  it('同一路径重复写相同内容只算一次进展；换内容才算新进展', () => {
    const ws = makeTempWorkspace()
    try {
      const goalCreatedAt = Date.now()
      const file = join(ws.root, 'checkpoint.txt')
      const tracker = new GoalProgressTracker({ existingKeys: [] })
      writeFileSync(file, 'step-1')
      expect(
        tracker.observe({
          toolName: 'write_file',
          input: { path: 'checkpoint.txt' },
          ok: true,
          resultMeta: { absolutePath: file, afterHash: sha('step-1') },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(true)
      // 重复写相同 checkpoint → 不算进展
      writeFileSync(file, 'step-1')
      expect(
        tracker.observe({
          toolName: 'write_file',
          input: { path: 'checkpoint.txt' },
          ok: true,
          resultMeta: { absolutePath: file, afterHash: sha('step-1') },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(false)
      // 真新内容 → 进展
      writeFileSync(file, 'step-2')
      expect(
        tracker.observe({
          toolName: 'write_file',
          input: { path: 'checkpoint.txt' },
          ok: true,
          resultMeta: { absolutePath: file, afterHash: sha('step-2') },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(true)
    } finally {
      ws.cleanup()
    }
  })

  it('引用旧输入文件、空 run_command、失败调用都不算进展', () => {
    const ws = makeTempWorkspace({ 'in/old.txt': 'old input' })
    try {
      const goalCreatedAt = Date.now()
      const oldPath = join(ws.root, 'in/old.txt')
      const oldDate = new Date(Date.now() - 120_000)
      utimesSync(oldPath, oldDate, oldDate)
      const tracker = new GoalProgressTracker()
      const stale = tracker.observe({
        toolName: 'open_artifact',
        input: { path: 'in/old.txt' },
        ok: true,
        resultMeta: { absolutePath: oldPath },
        workspace: ws.root,
        goalCreatedAt
      })
      expect(stale.progress).toBe(false)
      expect(stale.reason).toBe('stale-file')

      expect(
        tracker.observe({ toolName: 'run_command', input: { command: '' }, ok: true, workspace: ws.root, goalCreatedAt }).progress
      ).toBe(false)
      expect(
        tracker.observe({
          toolName: 'write_file',
          input: { path: 'x.txt' },
          ok: false,
          resultMeta: {},
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('目录 / 不存在路径不算进展', () => {
    const ws = makeTempWorkspace({ 'dir/a.txt': 'a' })
    try {
      const goalCreatedAt = Date.now()
      const tracker = new GoalProgressTracker()
      expect(
        tracker.observe({
          toolName: 'write_file',
          input: { path: 'dir' },
          ok: true,
          resultMeta: { absolutePath: join(ws.root, 'dir') },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(false)
      expect(
        tracker.observe({
          toolName: 'write_file',
          input: { path: 'missing.txt' },
          ok: true,
          resultMeta: {},
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(false)
    } finally {
      ws.cleanup()
    }
  })
})

describe('R2-G：新 XLSX/DOCX 与本地 MCP 成果必须被计为进展', () => {
  it('两份不同 XLSX/DOCX 各算一次；重复同一份不算', () => {
    const ws = makeTempWorkspace()
    try {
      const goalCreatedAt = Date.now()
      mkdirSync(join(ws.root, 'out'), { recursive: true })
      const tracker = new GoalProgressTracker()
      const xlsxA = join(ws.root, 'out/a.xlsx')
      const xlsxB = join(ws.root, 'out/b.xlsx')
      const docx = join(ws.root, 'out/letter.docx')
      writeFileSync(xlsxA, 'xlsx-A')
      writeFileSync(xlsxB, 'xlsx-B')
      writeFileSync(docx, 'docx-v1')
      const observe = (toolName: string, path: string) =>
        tracker.observe({
          toolName,
          input: { path },
          ok: true,
          resultMeta: { absolutePath: path },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      expect(observe('write_xlsx', xlsxA)).toBe(true)
      expect(observe('write_xlsx', xlsxB)).toBe(true)
      expect(observe('edit_docx', docx)).toBe(true)
      expect(observe('write_xlsx', xlsxB)).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('MCP/web 外部调用：首次成功算进展，重复/失败/普通读取不算', () => {
    const ws = makeTempWorkspace()
    try {
      const goalCreatedAt = Date.now()
      const tracker = new GoalProgressTracker()
      const mcpCall = (input: Record<string, unknown>, ok = true) =>
        tracker.observe({ toolName: 'mcp_call', input, ok, workspace: ws.root, goalCreatedAt }).progress
      expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'A', key: 'case47-A' } })).toBe(true)
      // 重复相同调用 → 不算
      expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'A', key: 'case47-A' } })).toBe(false)
      // 不同参数 → 新成果
      expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'B', key: 'case47-B' } })).toBe(true)
      // MCP 读取/失败 → 不算
      expect(mcpCall({ server: 'local', tool: 'child47_get', arguments: {} })).toBe(false)
      expect(mcpCall({ server: 'local', tool: 'child47_register', arguments: { id: 'C' } }, false)).toBe(false)
      // web_fetch 同一 URL 只算一次
      const web = (url: string) => tracker.observe({ toolName: 'web_fetch', input: { url }, ok: true, workspace: ws.root, goalCreatedAt }).progress
      expect(web('http://127.0.0.1:1/a')).toBe(true)
      expect(web('http://127.0.0.1:1/a')).toBe(false)
    } finally {
      ws.cleanup()
    }
  })

  it('持久化恢复后不会重复计数（重启/暂停/续跑）', () => {
    const ws = makeTempWorkspace()
    try {
      const goalCreatedAt = Date.now()
      const file = join(ws.root, 'out/report.html')
      mkdirSync(join(ws.root, 'out'), { recursive: true })
      writeFileSync(file, '<html>done</html>')
      const first = new GoalProgressTracker()
      expect(
        first.observe({
          toolName: 'write_file',
          input: {},
          ok: true,
          resultMeta: { absolutePath: file },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(true)
      const restored = new GoalProgressTracker({ existingKeys: first.toKeys() })
      expect(
        restored.observe({
          toolName: 'write_file',
          input: {},
          ok: true,
          resultMeta: { absolutePath: file },
          workspace: ws.root,
          goalCreatedAt
        }).progress
      ).toBe(false)
    } finally {
      ws.cleanup()
    }
  })
})
