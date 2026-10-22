/**
 * P0-3 检查点与回退 —— 服务层验收：
 * - 文件回退恢复写前内容、删除本轮新建文件；
 * - 冲突检测拒绝覆盖外部修改；
 * - 对话回退截断消息并恢复 todos/artifacts/plan；
 * - 只回退代码保留对话且幂等；
 * - 保留策略最多 30 轮；子代理 changedFiles 批量登记。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, SessionPlan } from '../../../src/shared/types'
import { CheckpointService } from '../../../src/main/services/checkpoint-service'
import { SessionStore } from '../../../src/main/services/session-store'
import { makeTempDir, makeTempWorkspace, type TempWorkspace } from '../core/helpers/workspace'

const MODEL = { providerId: 'mock', modelId: 'mock' }
const PERMISSION = 'ask' as const

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function message(id: string, role: 'user' | 'assistant', text: string): ChatMessage {
  return { id, role, content: [{ type: 'text', text }], createdAt: Date.now() }
}

function plan(title: string, status: SessionPlan['status']): SessionPlan {
  const now = Date.now()
  return {
    id: `plan_${title}`,
    title,
    summary: '测试计划',
    steps: [{ id: 'step_1', text: '第一步' }],
    status,
    createdAt: now,
    updatedAt: now
  }
}

interface Harness {
  store: SessionStore
  checkpoints: CheckpointService
  dataDir: string
  ws: TempWorkspace
  sessionId: string
  cleanup: () => void
}

function setup(): Harness {
  const dataDir = makeTempDir('morrow-cp-')
  const ws = makeTempWorkspace({ 'notes.md': 'v1\n' })
  const store = new SessionStore(dataDir)
  const session = store.create({
    workspace: ws.root,
    model: MODEL,
    permissionMode: PERMISSION,
    defaultModel: MODEL,
    defaultPermission: PERMISSION,
    title: '检查点测试'
  })
  return {
    store,
    checkpoints: new CheckpointService(store, dataDir),
    dataDir,
    ws,
    sessionId: session.id,
    cleanup: () => {
      ws.cleanup()
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言
      }
    }
  }
}

function snapshotOf(h: Harness, toolId: string, absolutePath: string): string {
  const dir = join(h.dataDir, 'snapshots', h.sessionId, toolId)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, absolutePath.split(/[\\/]/).pop() ?? 'file')
  copyFileSync(absolutePath, target)
  return target
}

function metaFor(path: string, before: string | null, after: string, snapshotPath?: string) {
  return {
    absolutePath: path,
    created: before === null,
    beforeHash: before === null ? null : hash(before),
    afterHash: hash(after),
    ...(snapshotPath ? { snapshotPath } : {})
  }
}

beforeEach(() => {
  // 每个用例独立临时目录
})

describe('checkpoint rewind', () => {
  it('restores modified files and deletes files created in the turn', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const user = message('u1', 'user', '请改一下文件')
      session.messages = [user]
      h.store.save(session)
      const cp = h.checkpoints.create(session, user, 0)!

      const notes = join(h.ws.root, 'notes.md')
      const before = readFileSync(notes, 'utf8')
      const snapshot = snapshotOf(h, 'call_1', notes)
      writeFileSync(notes, 'v2\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp.id, metaFor(notes, before, 'v2\n', snapshot))

      const created = join(h.ws.root, 'new.md')
      writeFileSync(created, 'new\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp.id, metaFor(created, null, 'new\n'))

      const preview = h.checkpoints.preview(session, cp.id)
      expect(preview.conflicts).toEqual([])
      expect(preview.fileCount).toBe(2)
      expect(preview.files).toEqual(
        expect.arrayContaining([
          { path: notes, existed: true, conflict: false },
          { path: created, existed: false, conflict: false }
        ])
      )

      const result = h.checkpoints.rewind(session, cp.id, 'code')
      expect(result.restoredFiles).toBe(1)
      expect(result.removedFiles).toBe(1)
      expect(readFileSync(notes, 'utf8')).toBe('v1\n')
      expect(existsSync(created)).toBe(false)
      // 代码回退保留对话
      expect(h.store.get(h.sessionId)!.messages).toHaveLength(1)

      // 同一检查点再次回退应幂等（afterHash 已更新为恢复后的状态）
      const again = h.checkpoints.preview(h.store.get(h.sessionId)!, cp.id)
      expect(again.conflicts).toEqual([])
      const second = h.checkpoints.rewind(h.store.get(h.sessionId)!, cp.id, 'code')
      expect(second.restoredFiles).toBe(1)
      expect(readFileSync(notes, 'utf8')).toBe('v1\n')
    } finally {
      h.cleanup()
    }
  })

  it('refuses rewind when the saved snapshot was tampered with', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const user = message('u1', 'user', '改文件')
      session.messages = [user]
      h.store.save(session)
      const cp = h.checkpoints.create(session, user, 0)!
      const notes = join(h.ws.root, 'notes.md')
      const snapshot = snapshotOf(h, 'call_1', notes)
      writeFileSync(notes, 'v2\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp.id, metaFor(notes, 'v1\n', 'v2\n', snapshot))
      // 快照被替换，但文件名/路径仍在
      writeFileSync(snapshot, 'tampered\n', 'utf8')

      const preview = h.checkpoints.preview(session, cp.id)
      expect(preview.conflicts).toHaveLength(1)
      expect(preview.conflicts[0].reason).toContain('快照已损坏')
      expect(preview.files[0]).toMatchObject({ path: notes, conflict: true })
      expect(() => h.checkpoints.rewind(session, cp.id, 'code')).toThrow(/冲突/)
      expect(readFileSync(notes, 'utf8')).toBe('v2\n')
    } finally {
      h.cleanup()
    }
  })

  it('refuses rewind when a tracked file was changed externally', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const user = message('u1', 'user', '改文件')
      session.messages = [user]
      h.store.save(session)
      const cp = h.checkpoints.create(session, user, 0)!
      const notes = join(h.ws.root, 'notes.md')
      const snapshot = snapshotOf(h, 'call_1', notes)
      writeFileSync(notes, 'v2\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp.id, metaFor(notes, 'v1\n', 'v2\n', snapshot))
      // 用户在应用外又改了文件
      writeFileSync(notes, 'external\n', 'utf8')

      const preview = h.checkpoints.preview(session, cp.id)
      expect(preview.conflicts).toHaveLength(1)
      expect(preview.conflicts[0].reason).toContain('外部修改')
      expect(() => h.checkpoints.rewind(session, cp.id, 'code')).toThrow(/冲突/)
      expect(readFileSync(notes, 'utf8')).toBe('external\n')
    } finally {
      h.cleanup()
    }
  })

  it('rewinds conversation, todos and artifacts but keeps files for conversation-only scope', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const u1 = message('u1', 'user', '第一轮')
      const a1 = message('a1', 'assistant', '完成')
      session.messages = [u1, a1]
      session.todos = [{ id: 'todo_1', text: '第一步', status: 'completed' }]
      session.plan = plan('旧计划', 'pending')
      session.planMode = true
      h.store.save(session)
      const cp1 = h.checkpoints.create(session, u1, 0)!

      const u2 = message('u2', 'user', '第二轮')
      const a2 = message('a2', 'assistant', '完成')
      session.messages = [u1, a1, u2, a2]
      session.todos = [
        { id: 'todo_1', text: '第一步', status: 'completed' },
        { id: 'todo_2', text: '第二步', status: 'completed' }
      ]
      session.plan = plan('新计划', 'executing')
      session.planMode = false
      h.store.save(session)
      h.checkpoints.create(session, u2, 2)

      const notes = join(h.ws.root, 'notes.md')
      const snapshot = snapshotOf(h, 'call_1', notes)
      writeFileSync(notes, 'v2\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp1.id, metaFor(notes, 'v1\n', 'v2\n', snapshot))

      const result = h.checkpoints.rewind(h.store.get(h.sessionId)!, cp1.id, 'conversation')
      expect(result.removedMessages).toBe(4)
      const latest = h.store.get(h.sessionId)!
      expect(latest.messages).toHaveLength(0)
      expect(latest.todos).toEqual([{ id: 'todo_1', text: '第一步', status: 'completed' }])
      expect(latest.plan?.title).toBe('旧计划')
      expect(latest.planMode).toBe(true)
      expect(readFileSync(notes, 'utf8')).toBe('v2\n')
      expect(h.checkpoints.list(h.sessionId)).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  it('records subagent changedFiles and restores both files and messages', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const u1 = message('u1', 'user', '交给子代理')
      const a1 = message('a1', 'assistant', '完成')
      session.messages = [u1, a1]
      h.store.save(session)
      const cp1 = h.checkpoints.create(session, u1, 0)!

      const notes = join(h.ws.root, 'notes.md')
      const created = join(h.ws.root, 'sub.md')
      const snapshot = snapshotOf(h, 'call_sub', notes)
      writeFileSync(notes, 'sub\n', 'utf8')
      writeFileSync(created, 'sub-new\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp1.id, {
        changedFiles: [
          metaFor(notes, 'v1\n', 'sub\n', snapshot),
          metaFor(created, null, 'sub-new\n')
        ]
      })
      const stored = h.checkpoints.get(h.sessionId, cp1.id)!
      expect(stored.files).toHaveLength(2)

      const result = h.checkpoints.rewind(h.store.get(h.sessionId)!, cp1.id, 'both')
      expect(result.restoredFiles).toBe(1)
      expect(result.removedFiles).toBe(1)
      expect(result.removedMessages).toBe(2)
      expect(readFileSync(notes, 'utf8')).toBe('v1\n')
      expect(existsSync(created)).toBe(false)
      expect(h.store.get(h.sessionId)!.messages).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  it('stage checkpoint keeps its boundary message and only undoes later work', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const u1 = message('u1', 'user', '按计划执行')
      session.messages = [u1]
      h.store.save(session)
      const turn = h.checkpoints.create(session, u1, 0)!

      const a1 = message('a1', 'assistant', '第一步完成')
      session.messages = [u1, a1]
      h.store.save(session)
      const stage1 = h.checkpoints.createStage({
        sessionId: h.sessionId,
        messageId: 'a1',
        messageIndex: 1,
        label: '完成：第一步',
        todos: [{ id: 'todo_1', text: '第一步', status: 'completed' }],
        artifactIds: [],
        plan: null,
        planMode: false
      })!

      const notes = join(h.ws.root, 'notes.md')
      const v2 = 'v2\n'
      const snap2 = snapshotOf(h, 'call_2', notes)
      writeFileSync(notes, v2, 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, stage1.id, metaFor(notes, 'v1\n', v2, snap2))

      const a2 = message('a2', 'assistant', '第二步完成')
      session.messages = [u1, a1, a2]
      h.store.save(session)
      const stage2 = h.checkpoints.createStage({
        sessionId: h.sessionId,
        messageId: 'a2',
        messageIndex: 2,
        label: '完成：第二步',
        todos: [
          { id: 'todo_1', text: '第一步', status: 'completed' },
          { id: 'todo_2', text: '第二步', status: 'completed' }
        ],
        artifactIds: [],
        plan: null,
        planMode: false
      })!
      const v3 = 'v3\n'
      const snap3 = snapshotOf(h, 'call_3', notes)
      writeFileSync(notes, v3, 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, stage2.id, metaFor(notes, v2, v3, snap3))

      expect(turn.files).toHaveLength(0)
      const preview = h.checkpoints.preview(session, stage1.id)
      expect(preview.messageFound).toBe(true)
      expect(preview.removableMessages).toBe(1)

      const result = h.checkpoints.rewind(session, stage1.id, 'both')
      expect(result.removedMessages).toBe(1)
      expect(readFileSync(notes, 'utf8')).toBe('v1\n')
      const latest = h.store.get(h.sessionId)!
      expect(latest.messages.map((item) => item.id)).toEqual(['u1', 'a1'])
      expect(latest.todos).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  it('删除文件登记到检查点并可恢复；本轮新建后删除视为净零', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const user = message('u1', 'user', '清理文件')
      session.messages = [user]
      h.store.save(session)
      const cp = h.checkpoints.create(session, user, 0)!

      const notes = join(h.ws.root, 'notes.md')
      const snapshot = snapshotOf(h, 'call_del', notes)
      rmSync(notes)
      h.checkpoints.recordToolResult(h.sessionId, cp.id, {
        absolutePath: notes,
        created: false,
        deleted: true,
        beforeHash: hash('v1\n'),
        afterHash: null,
        diffAdded: 0,
        diffRemoved: 1,
        snapshotPath: snapshot
      })

      const created = join(h.ws.root, 'tmp.md')
      writeFileSync(created, 'temp\n', 'utf8')
      h.checkpoints.recordToolResult(h.sessionId, cp.id, {
        absolutePath: created,
        created: true,
        afterHash: hash('temp\n'),
        diffAdded: 1,
        diffRemoved: 0
      })
      rmSync(created)
      h.checkpoints.recordToolResult(h.sessionId, cp.id, {
        absolutePath: created,
        created: false,
        deleted: true,
        beforeHash: hash('temp\n'),
        afterHash: null,
        diffAdded: 0,
        diffRemoved: 1
      })

      const stored = h.checkpoints.get(h.sessionId, cp.id)!
      expect(stored.files.map((file) => file.path)).toEqual([notes])
      const result = h.checkpoints.rewind(h.store.get(h.sessionId)!, cp.id, 'code')
      expect(result.restoredFiles).toBe(1)
      expect(readFileSync(notes, 'utf8')).toBe('v1\n')
      expect(existsSync(created)).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('keeps at most 100 checkpoints per session', () => {
    const h = setup()
    try {
      const session = h.store.get(h.sessionId)!
      const user = message('u1', 'user', '重复轮次')
      session.messages = [user]
      h.store.save(session)
      for (let index = 0; index < 101; index += 1) {
        h.checkpoints.create(session, user, 0)
      }
      expect(h.checkpoints.list(h.sessionId)).toHaveLength(100)
    } finally {
      h.cleanup()
    }
  })
})
