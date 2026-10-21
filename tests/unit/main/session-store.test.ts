import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { SessionStore } from '../../../src/main/services/session-store'
import type { ChatMessage, ResearchState } from '../../../src/shared/types'

const MODEL = { providerId: 'demo', modelId: 'demo-model' }
let root = ''
let store: SessionStore

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-session-store-test-'))
  store = new SessionStore(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function createSession(mode: 'chat' | 'work' | 'research' = 'work') {
  return store.create({
    workspace: 'C:\\workspace',
    mode,
    defaultModel: MODEL,
    defaultPermission: 'ask'
  })
}

describe('SessionStore 持久化', () => {
  it('创建时持久化显式模式，元数据也带回 mode', () => {
    const session = createSession('chat')
    expect(session.mode).toBe('chat')
    const loaded = store.get(session.id)
    expect(loaded?.mode).toBe('chat')
    expect(loaded?.workspace).toBe('C:\\workspace')

    const meta = store.list().find((item) => item.id === session.id)
    expect(meta?.mode).toBe('chat')
    expect(meta?.messageCount).toBe(0)
  })

  it('重命名与 UI 一致，最多 80 个字符', () => {
    const session = createSession()
    const meta = store.rename(session.id, 'x'.repeat(100))
    expect(meta?.title.length).toBe(80)
    expect(store.get(session.id)?.title.length).toBe(80)
  })

  it('归档状态写入会话文件，重启后仍可恢复', () => {
    const session = createSession()
    expect(store.setArchived(session.id, true)?.archived).toBe(true)

    const restarted = new SessionStore(root)
    expect(restarted.list().find((item) => item.id === session.id)?.archived).toBe(true)
    expect(restarted.setArchived(session.id, false)?.archived).toBeFalsy()
    expect(new SessionStore(root).list().find((item) => item.id === session.id)?.archived).toBeFalsy()
  })

  it('深度研究计划状态（planning/ready + plan）可持久化，不会被读盘过滤', () => {
    const session = createSession('research')
    const research: ResearchState = {
      topic: '研究计划持久化',
      depth: 'quick',
      status: 'ready',
      round: 1,
      maxRounds: 2,
      minSources: 4,
      sourceCount: 0,
      startedAt: 1,
      updatedAt: 2,
      plan: '# 研究计划\n## 子问题\n1. 持久化',
      steer: '只看官方来源'
    }
    session.research = research
    store.save(session)
    expect(store.get(session.id)?.research).toMatchObject({
      status: 'ready',
      plan: '# 研究计划\n## 子问题\n1. 持久化',
      steer: '只看官方来源'
    })
    const planning = { ...research, status: 'planning' as const }
    session.research = planning
    store.save(session)
    expect(store.get(session.id)?.research?.status).toBe('planning')
  })

  it('半损坏会话补齐数组/默认值，仍可加载', () => {
    const id = 's_partial1'
    writeFileSync(
      join(root, 'sessions', `${id}.json`),
      JSON.stringify({ id, title: 123, messages: 'bad', usage: 'bad', permissionMode: 'invalid' })
    )
    const session = store.get(id)
    expect(session).not.toBeNull()
    expect(session?.title).toBe('新对话')
    expect(session?.messages).toEqual([])
    expect(session?.todos).toEqual([])
    expect(session?.artifacts).toEqual([])
    expect(session?.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(session?.permissionMode).toBe('ask')
    expect(session?.mode).toBeUndefined()
    expect(session?.messageCount).toBe(0)
  })

  it('损坏 JSON 与文件名/id 不匹配时跳过，不误加载其他会话', () => {
    writeFileSync(join(root, 'sessions', 's_broken1.json'), '{not-json')
    writeFileSync(join(root, 'sessions', 's_mismatch1.json'), JSON.stringify({ id: 's_other1', messages: [] }))
    expect(store.get('s_broken1')).toBeNull()
    expect(store.get('s_mismatch1')).toBeNull()
    expect(store.list().some((meta) => meta.id === 's_broken1' || meta.id === 's_mismatch1')).toBe(false)
  })

  it('list 保留 300 条侧栏上限，listAll 供历史回填读取全部', () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-session-bulk-'))
    const local = new SessionStore(dir)
    try {
      for (let index = 0; index < 305; index += 1) {
        const id = `s_bulk${index}`
        writeFileSync(
          join(dir, 'sessions', `${id}.json`),
          JSON.stringify({ id, updatedAt: 1_000 + index, messages: [] }),
          'utf8'
        )
      }
      expect(local.list()).toHaveLength(300)
      expect(local.listAll()).toHaveLength(305)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applyRunResult 按消息 id 更新而不是重复追加', () => {
    const session = createSession()
    const first: ChatMessage = {
      id: 'msg_first',
      role: 'user',
      content: [{ type: 'text', text: '旧内容' }],
      createdAt: 1
    }
    session.messages = [first]
    store.save(session)
    const updated: ChatMessage = { ...first, content: [{ type: 'text', text: '新内容' }] }
    const second: ChatMessage = {
      id: 'msg_second',
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
      createdAt: 2
    }
    const saved = store.applyRunResult(store.get(session.id)!, { messages: [updated, second] })
    expect(saved.messages.map((message) => message.id)).toEqual(['msg_first', 'msg_second'])
    expect(saved.messages[0].content).toEqual([{ type: 'text', text: '新内容' }])
    expect(saved.messageCount).toBe(2)
  })

  it('branch 复制目标消息之前的历史并重置 goal/固定/归档/usage', () => {
    const source = createSession()
    source.messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一问' }], createdAt: 1 },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '第一答' }], createdAt: 2 },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: '第二问' }], createdAt: 3 },
      { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '第二答' }], createdAt: 4 }
    ]
    source.todos = [{ id: 't1', text: '步骤', status: 'completed' }]
    source.usage = { inputTokens: 100, outputTokens: 50, contextUsed: 120, contextLimit: 1000, costUsd: 1 }
    source.goal = { id: 'g1', objective: '目标', status: 'active', round: 1, maxRounds: 2 } as typeof source.goal
    source.plan = {
      id: 'plan_1',
      title: '旧计划',
      summary: '测试',
      steps: [{ id: 'step_1', text: '步骤' }],
      status: 'pending',
      createdAt: 1,
      updatedAt: 1
    }
    source.planMode = true
    source.pinned = true
    source.archived = true
    store.save(source)

    const branch = store.branch(source.id, 'm2', '分支标题')!
    expect(branch.title).toBe('分支标题')
    expect(branch.messages.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(branch.messages[0]).not.toBe(source.messages[0])
    expect(branch.goal).toBeNull()
    expect(branch.plan).toBeNull()
    expect(branch.planMode).toBe(false)
    expect(branch.pinned).toBe(false)
    expect(branch.archived).toBe(false)
    expect(branch.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, contextLimit: 1000 })
    expect(branch.usage.costUsd).toBeUndefined()
    expect(branch.messageCount).toBe(2)
    expect(source.messages).toHaveLength(4)
    expect(store.get(source.id)?.pinned).toBe(true)
  })

  it('remove 物理删除会话文件，并推进会话版本供搜索索引感知', () => {
    const session = createSession()
    const file = join(root, 'sessions', `${session.id}.json`)
    expect(existsSync(file)).toBe(true)
    const before = store.getRevision()
    store.save(session)
    expect(store.getRevision()).toBeGreaterThan(before)
    store.remove(session.id)
    expect(existsSync(file)).toBe(false)
    expect(store.get(session.id)).toBeNull()
    expect(store.getRevision()).toBeGreaterThan(before + 1)
  })
})

describe('临时对话与全量清除', () => {
  function isolatedStore(): { store: SessionStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-session-temp-'))
    return { store: new SessionStore(dir), dir }
  }

  it('临时对话只在内存中，不写会话文件，重启语义下 list 不包含它', () => {
    const { store: local, dir } = isolatedStore()
    try {
      const session = local.create({
        workspace: 'C:\\workspace',
        temporary: true,
        defaultModel: MODEL,
        defaultPermission: 'ask'
      })
      expect(session.temporary).toBe(true)
      expect(session.title).toBe('临时对话')
      expect(session.id.startsWith('tmp_')).toBe(true)
      expect(existsSync(join(dir, 'sessions', `${session.id}.json`))).toBe(false)
      expect(local.list()).toEqual([])
      expect(local.listTemporaryIds()).toEqual([session.id])

      local.applyRunResult(session, {
        messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }]
      })
      local.rename(session.id, '临时标题')
      expect(local.get(session.id)?.messages).toHaveLength(1)
      expect(local.get(session.id)?.title).toBe('临时标题')
      expect(local.get(session.id)?.temporary).toBe(true)
      expect(existsSync(join(dir, 'sessions', `${session.id}.json`))).toBe(false)

      local.remove(session.id)
      expect(local.get(session.id)).toBeNull()
      expect(local.listTemporaryIds()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('分支临时对话仍是临时对话，不会落盘', () => {
    const { store: local, dir } = isolatedStore()
    try {
      const session = local.create({ temporary: true, defaultModel: MODEL, defaultPermission: 'ask' })
      const withMessage = local.applyRunResult(session, {
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '分支' }], createdAt: 1 }]
      })
      const branch = local.branch(withMessage.id, 'm1')
      expect(branch?.temporary).toBe(true)
      expect(branch?.id.startsWith('tmp_')).toBe(true)
      expect(existsSync(join(dir, 'sessions', `${branch!.id}.json`))).toBe(false)
      expect(local.list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clearAll 删除所有会话文件（含损坏文件）和临时对话，并推进版本', () => {
    const { store: local, dir } = isolatedStore()
    try {
      local.create({ defaultModel: MODEL, defaultPermission: 'ask' })
      local.create({ temporary: true, defaultModel: MODEL, defaultPermission: 'ask' })
      writeFileSync(join(dir, 'sessions', 's_corrupt1.json'), '{bad')
      const before = local.getRevision()
      const removed = local.clearAll()
      expect(removed).toBe(3)
      expect(local.list()).toEqual([])
      expect(local.listTemporaryIds()).toEqual([])
      const sessionsDir = join(dir, 'sessions')
      expect(readdirSync(sessionsDir)).toEqual([])
      expect(local.getRevision()).toBeGreaterThan(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
