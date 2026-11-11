import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryService } from '../../src/main/memory'
import type { EmbeddingBackend } from '../../src/main/memory'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'morrow-semantic-test') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (buffer: Buffer) => buffer.toString()
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined }
}))

let dataDir = ''
let workspace = ''
let clock = 1_700_000_000_000

function capture(memory: MemoryService, title: string, summary: string, importance?: number) {
  clock += 1_000
  return memory.captureEpisode({
    scope: 'project',
    workspace,
    title,
    intent: summary,
    summary,
    tags: ['任务'],
    sourceSessionId: 's1',
    sourceSessionTitle: '语义检索测试',
    sourceMessageId: `m-${title}`,
    ...(importance !== undefined ? { importance } : {})
  })
}

function fakeEmbeddingBackend(): EmbeddingBackend {
  return {
    info: { mode: 'model', label: '测试嵌入', model: 'mock-embed-2d', dimensions: 2 },
    embed: async (texts) =>
      texts.map((text) => {
        if (text.includes('报表') || text.includes('销售') || text.includes('数据表')) return [1, 0.05]
        if (text.includes('配色') || text.includes('界面')) return [0.05, 1]
        return [0.7, 0.7]
      })
  }
}

function fakeEmbeddingService() {
  return {
    resolve: async () => fakeEmbeddingBackend(),
    invalidate: () => undefined
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'morrow-memory-data-'))
  workspace = mkdtempSync(join(tmpdir(), 'morrow-memory-ws-'))
  mkdirSync(join(workspace, '.morrow'), { recursive: true })
  clock = 1_700_000_000_000
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

describe('memory-semantic.test.ts', () => {
  it('@core:memory 离线词面向量按相关度召回长尾经验，并落盘轻量向量索引', async () => {
    const memory = new MemoryService({ dataDir, now: () => clock })
    const report = capture(memory, '整理季度销售报表', '按季度汇总销售额，保留两位小数。')
    capture(memory, '调整界面配色', '把设置页的强调色从蓝色换成墨绿。')

    const result = await memory.searchEpisodes('project', workspace, {
      query: '销售额按季度汇总',
      sort: 'relevance'
    })
    expect(result.embedding?.mode).toBe('vector')
    expect(result.entries[0]?.id).toBe(report.id)
    expect(result.relevance?.[report.id]).toBeGreaterThan(0)
    const index = readFileSync(join(workspace, '.morrow', 'episode-vectors-hash.json'), 'utf8')
    expect(index).toContain(report.id)
    expect(index).toContain('morrow-hash')
  })

  it('@core:memory 时间排序仍可用，且不相关查询返回空结果', async () => {
    const memory = new MemoryService({ dataDir, now: () => clock })
    capture(memory, '整理季度销售报表', '按季度汇总销售额。')
    capture(memory, '调整界面配色', '换成墨绿配色。')

    const recent = await memory.searchEpisodes('project', workspace, { query: '配色', sort: 'recent' })
    expect(recent.entries.map((entry) => entry.title)).toEqual(['调整界面配色'])

    const none = await memory.searchEpisodes('project', workspace, {
      query: '火箭发射窗口',
      sort: 'relevance'
    })
    expect(none.entries).toHaveLength(0)
  })

  it('@core:memory 相关度排序优先高重要性，注入只带相关经验且记一次使用', () => {
    const memory = new MemoryService({ dataDir, now: () => clock })
    const low = capture(memory, '旧报表流程', '使用旧的销售报表模板。', 1)
    const high = capture(memory, '新报表流程', '销售报表按季度口径汇总。', 1)
    memory.updateEpisode('project', workspace, high.id, { importance: 3 })

    const ranked = memory.listEpisodes('project', workspace, { includeDisabled: true }).entries
    expect(ranked).toHaveLength(2)

    const injection = memory.episodeInjection(workspace, '销售报表季度汇总', { maxTokens: 320, now: clock + 10_000 })
    expect(injection.included).toBe(2)
    expect(injection.text.indexOf('新报表流程')).toBeLessThan(injection.text.indexOf('旧报表流程'))

    const none = memory.episodeInjection(workspace, '火箭发射窗口', { maxTokens: 320, now: clock + 20_000 })
    expect(none.included).toBe(0)
    expect(none.text).toBe('')

    const used = memory.listEpisodes('project', workspace, { includeDisabled: true }).entries.find((entry) => entry.id === high.id)
    expect(used?.useCount).toBe(1)
    expect(used?.lastUsedAt).toBe(clock + 10_000)
    expect(low.id).not.toBe(high.id)
  })

  it('@core:memory 有本机嵌入模型时使用模型向量，并返回相关度与索引状态', async () => {
    const memory = new MemoryService({ dataDir, now: () => clock, embedding: fakeEmbeddingService() })
    const report = capture(memory, '销售报表', '整理数据。')
    capture(memory, '界面配色', '换成墨绿。')

    const result = await memory.searchEpisodes('project', workspace, { query: '数据表', sort: 'relevance' })
    expect(result.embedding?.mode).toBe('model')
    expect(result.embedding?.model).toBe('mock-embed-2d')
    expect(result.entries[0]?.id).toBe(report.id)
    expect(result.relevance?.[report.id]).toBeGreaterThan(0)
    const index = readFileSync(join(workspace, '.morrow', 'episode-vectors.json'), 'utf8')
    expect(index).toContain(report.id)
    expect(index).toContain('mock-embed-2d')
  })

  it('@core:memory 超出上限时按重要性和新鲜度自动淘汰，并把遗忘计数持久化', () => {
    const memory = new MemoryService({ dataDir, now: () => clock, episodeLimit: 3 })
    const low = capture(memory, '一次性旧经验', '很久没再用过的低价值记录。', 1)
    const high = capture(memory, '关键发布流程', '发布前必须跑完整回归。', 1)
    const mid = capture(memory, '普通配色记录', '设置页用墨绿。', 2)
    memory.updateEpisode('project', workspace, high.id, { importance: 3 })
    capture(memory, '新的任务经验', '刚完成的一次任务。', 1)

    const list = memory.listEpisodes('project', workspace, { includeDisabled: true })
    expect(list.entries).toHaveLength(3)
    expect(list.entries.some((entry) => entry.id === low.id)).toBe(false)
    expect(list.entries.some((entry) => entry.id === high.id)).toBe(true)
    expect(list.entries.some((entry) => entry.id === mid.id)).toBe(true)
    expect(list.stats.forgotten).toBe(1)
    expect(list.stats.limit).toBe(3)

    const reloaded = new MemoryService({ dataDir, now: () => clock, episodeLimit: 3 })
    expect(reloaded.listEpisodes('project', workspace, { includeDisabled: true }).stats.forgotten).toBe(1)
  })

  it('@core:memory 长期记忆支持 1–3 星重要性并裁剪越界值', () => {
    const memory = new MemoryService({ dataDir, now: () => clock })
    const entry = memory.add({ scope: 'project', workspace, text: '始终使用简体中文。' })
    expect(entry.importance).toBe(2)
    expect(memory.update('project', workspace, entry.id, { importance: 9 }).importance).toBe(3)
    expect(memory.update('project', workspace, entry.id, { importance: 0 }).importance).toBe(1)
    expect(memory.list('project', workspace).entries[0]?.importance).toBe(1)
  })
})
