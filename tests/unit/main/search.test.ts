/**
 * R10-I 全局搜索服务单测（不依赖 Electron）：
 * 中文/标题/正文/artifact、忽略目录/二进制/超大文件、工作区隔离、增量更新、ranking/片段/limit/状态。
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Artifact, ChatMessage, Session, SessionMeta } from '../../../src/shared/types'
import { SearchService } from '../../../src/main/services/search-service'
import { makeTempDir } from '../core/helpers/workspace'

function textMessage(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return { id, role, content: [{ type: 'text', text }], createdAt: 1 }
}

function artifact(id: string, title: string, content: string): Artifact {
  return { id, title, kind: 'markdown', content, createdAt: 1, updatedAt: 1 }
}

function makeSession(input: {
  id: string
  title: string
  workspace: string | null
  messages?: ChatMessage[]
  artifacts?: Artifact[]
}): Session {
  return {
    id: input.id,
    title: input.title,
    workspace: input.workspace,
    model: { providerId: 'mock', modelId: 'mock' },
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 10,
    messageCount: input.messages?.length ?? 0,
    messages: input.messages ?? [],
    todos: [],
    artifacts: input.artifacts ?? [],
    usage: { inputTokens: 0, outputTokens: 0 }
  }
}

function metaOf(session: Session): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    model: session.model,
    permissionMode: session.permissionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length
  }
}

function makeHarness() {
  const sessions = new Map<string, Session>()
  const workspaces: string[] = []
  let now = 10_000
  const service = new SearchService(
    {
      listSessions: () => [...sessions.values()].map(metaOf),
      getSession: (id) => sessions.get(id) ?? null,
      listWorkspaces: () => workspaces,
      now: () => now
    },
    { autoRefreshMs: 1500 }
  )
  return {
    sessions,
    workspaces,
    service,
    advance: (ms: number) => {
      now += ms
    }
  }
}

function write(root: string, relative: string, content: string | Buffer): string {
  const absolute = join(root, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

describe('全局搜索：索引与查询', () => {
  it('中文查询命中会话标题/消息正文、文件路径/内容、artifact，并带片段高亮', async () => {
    const root = makeTempDir('search-ws-')
    try {
      write(root, 'docs/预算说明.md', '这是 2026 年 Q3 的预算说明，金额上限 5 万元。')
      write(root, 'notes.txt', '普通内容')
      const session = makeSession({
        id: 's1',
        title: 'Q3 预算复盘',
        workspace: root,
        messages: [textMessage('m1', 'user', '帮我检查预算是否超限'), textMessage('m2', 'assistant', '预算没有超限。')],
        artifacts: [artifact('a1', '预算报告', '总预算 48000 元，未超过上限。')]
      })
      const harness = makeHarness()
      harness.sessions.set(session.id, session)
      harness.workspaces.push(root)
      await harness.service.start()

      const result = await harness.service.search({ q: '预算', workspace: root, limit: 20 })
      expect(result.total).toBeGreaterThanOrEqual(3)
      expect(result.groups.sessions[0]?.title).toContain('预算')
      expect(result.groups.sessions[0]?.highlights.length).toBeGreaterThan(0)
      expect(result.groups.files.some((hit) => hit.path === 'docs/预算说明.md')).toBe(true)
      expect(result.groups.artifacts[0]?.title).toBe('预算报告')
      expect(result.tookMs).toBeGreaterThanOrEqual(0)
      expect(result.index.ready).toBe(true)
      expect(result.index.sessions).toBe(1)
      expect(result.index.files).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('文件内容命中给出行号；文件名命中优先于内容命中', async () => {
    const root = makeTempDir('search-rank-')
    try {
      write(root, '预算-报告.md', '这里只提到一次预算。')
      write(root, 'other.md', '预算 预算 预算 预算，但文件名不相关。')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      const result = await harness.service.search({ q: '预算', workspace: root, limit: 10 })
      const files = result.groups.files
      expect(files.length).toBeGreaterThanOrEqual(2)
      expect(files[0].path).toContain('预算-报告.md')
      const contentHit = files.find((hit) => hit.path === 'other.md')
      expect(contentHit?.line).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('忽略 node_modules/.git/Morrow Data/二进制/超大文件', async () => {
    const root = makeTempDir('search-ignore-')
    try {
      write(root, 'src/app.ts', 'const 预算 = 1')
      write(root, 'node_modules/pkg/index.js', '预算 不应该被索引')
      write(root, '.git/config', '预算 不应该被索引')
      write(root, 'Morrow Data/secret.txt', '预算 不应该被索引')
      write(root, 'binary.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]))
      write(root, 'huge.txt', `${'预算 '.repeat(200_000)}`)
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      const result = await harness.service.search({ q: '预算', workspace: root, limit: 20 })
      const paths = result.groups.files.map((hit) => hit.path)
      expect(paths).toContain('src/app.ts')
      expect(paths?.some((path) => path?.includes('node_modules'))).toBe(false)
      expect(paths?.some((path) => path?.startsWith('.git/'))).toBe(false)
      expect(paths?.some((path) => path?.includes('Morrow Data'))).toBe(false)
      expect(paths?.some((path) => path?.includes('binary.bin'))).toBe(false)
      expect(paths?.some((path) => path?.includes('huge.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('工作区隔离：限定工作区不返回其它工作区的文件/会话/artifact', async () => {
    const rootA = makeTempDir('search-a-')
    const rootB = makeTempDir('search-b-')
    try {
      write(rootA, 'a.md', '预算 A 工作区')
      write(rootB, 'b.md', '预算 B 工作区（不应出现在 A 查询）')
      const sessionA = makeSession({ id: 'sa', title: '预算 A 会话', workspace: rootA, messages: [textMessage('ma', 'user', '预算 A')] })
      const sessionB = makeSession({
        id: 'sb',
        title: '预算 B 会话',
        workspace: rootB,
        messages: [textMessage('mb', 'user', '预算 B')],
        artifacts: [artifact('ab', '预算 B 报告', '预算 B')]
      })
      const harness = makeHarness()
      harness.sessions.set('sa', sessionA)
      harness.sessions.set('sb', sessionB)
      harness.workspaces.push(rootA, rootB)
      await harness.service.start()

      const resultA = await harness.service.search({ q: '预算', workspace: rootA, limit: 20 })
      expect(resultA.groups.files.every((hit) => hit.absolutePath?.startsWith(rootA))).toBe(true)
      expect(resultA.groups.sessions.every((hit) => hit.sessionId === 'sa')).toBe(true)
      expect(resultA.groups.artifacts.every((hit) => hit.sessionId === 'sa')).toBe(true)

      // 不带工作区：只返回会话/artifact，不返回任何文件内容
      const global = await harness.service.search({ q: '预算', limit: 20 })
      expect(global.groups.files).toHaveLength(0)
      expect(global.groups.sessions.length).toBe(2)
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('增量更新：新增/修改/删除文件与会话刷新后可搜到/移除；limit 生效', async () => {
    const root = makeTempDir('search-inc-')
    try {
      write(root, 'old.md', '旧内容 预算')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      expect((await harness.service.search({ q: '新增', workspace: root })).total).toBe(0)

      // 新增文件 + 刷新
      write(root, 'new.md', '新增内容 预算')
      await harness.service.refreshWorkspace(root)
      expect((await harness.service.search({ q: '新增', workspace: root })).groups.files).toHaveLength(1)

      // 修改文件内容 + 推进时间（避免 mtime 同毫秒）+ 刷新
      await new Promise((resolve) => setTimeout(resolve, 20))
      write(root, 'new.md', '替换后的内容')
      await harness.service.refreshWorkspace(root)
      expect((await harness.service.search({ q: '替换', workspace: root })).total).toBe(1)
      expect((await harness.service.search({ q: '新增', workspace: root })).total).toBe(0)

      // 删除文件 + 刷新
      rmSync(join(root, 'old.md'))
      await harness.service.refreshWorkspace(root)
      expect((await harness.service.search({ q: '旧内容', workspace: root })).total).toBe(0)

      // 会话增量：新增消息后刷新
      const session = makeSession({ id: 'sx', title: '普通会话', workspace: root, messages: [textMessage('m1', 'user', '第一句')] })
      harness.sessions.set('sx', session)
      await harness.service.refreshSession('sx')
      expect((await harness.service.search({ q: '第一句', workspace: root })).groups.sessions).toHaveLength(1)
      session.messages.push(textMessage('m2', 'user', '新增关键句'))
      session.updatedAt = 20
      await harness.service.refreshSession('sx')
      expect((await harness.service.search({ q: '新增关键句', workspace: root })).groups.sessions).toHaveLength(1)

      // limit 每组上限
      for (let i = 0; i < 12; i += 1) write(root, `many-${i}.md`, `批量 预算 ${i}`)
      await harness.service.refreshWorkspace(root)
      const limited = await harness.service.search({ q: '预算', workspace: root, limit: 3 })
      expect(limited.groups.files.length).toBeLessThanOrEqual(1)
      expect(limited.total).toBeLessThanOrEqual(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('查询前自动增量刷新（保存/工具完成无需显式通知）', async () => {
    const root = makeTempDir('search-auto-')
    try {
      write(root, 'a.md', '初始')
      const harness = makeHarness()
      harness.workspaces.push(root)
      await harness.service.start()
      write(root, 'b.md', '新保存的文件 自动可见')
      harness.advance(2000)
      const result = await harness.service.search({ q: '自动可见', workspace: root })
      expect(result.groups.files).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('状态与空查询', async () => {
    const harness = makeHarness()
    const empty = await harness.service.search({ q: '   ' })
    expect(empty.total).toBe(0)
    expect(empty.index.ready).toBe(true)
    expect(empty.index.workspaces).toEqual([])
    const status = harness.service.status()
    expect(status.building).toBe(false)
  })
})
