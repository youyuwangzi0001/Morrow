import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactVersionStore } from '../../../src/main/services/artifact-versions'
import type { Artifact } from '../../../src/shared/types'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-artifact-versions-'))
  dirs.push(dir)
  return dir
}

function htmlArtifact(content: string, id = 'art-1'): Artifact {
  return {
    id,
    title: '季度报告',
    kind: 'html',
    content,
    createdAt: 1,
    updatedAt: 1
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ArtifactVersionStore', () => {
  it('首个版本标记为 baseline，内容未变化时按哈希去重', () => {
    let now = 1_000
    const store = new ArtifactVersionStore({ dir: tempDir(), now: () => now++ })
    const first = store.record('s1', htmlArtifact('<h1>一版</h1>'))
    expect(first?.source).toBe('baseline')
    expect(first?.size).toBe(Buffer.byteLength('<h1>一版</h1>'))
    expect(first?.hash).toMatch(/^[a-f0-9]{64}$/)

    const duplicate = store.record('s1', htmlArtifact('<h1>一版</h1>'))
    expect(duplicate?.id).toBe(first?.id)
    expect(store.list('s1', 'art-1')).toHaveLength(1)
  })

  it('内容变化生成新版本，列表最新在前，可读取快照内容', () => {
    let now = 1_000
    const store = new ArtifactVersionStore({ dir: tempDir(), now: () => now++ })
    store.record('s1', htmlArtifact('<h1>一版</h1>'))
    now += 10
    const second = store.record('s1', htmlArtifact('<h1>二版</h1>'), 'agent')
    now += 10
    const third = store.record('s1', htmlArtifact('<h1>三版</h1>'), 'restore')

    const list = store.list('s1', 'art-1')
    expect(list.map((item) => item.id)).toEqual([third?.id, second?.id, list[2].id])
    expect(list.map((item) => item.source)).toEqual(['restore', 'agent', 'baseline'])
    expect(list[0].createdAt).toBeGreaterThan(list[1].createdAt)

    const snapshot = store.read('s1', 'art-1', second!.id)
    expect(snapshot?.content).toBe('<h1>二版</h1>')
    expect(snapshot?.version.id).toBe(second?.id)
    expect(store.read('s1', 'art-1', 'missing')).toBeNull()
  })

  it('每个成品最多保留 30 个版本，并清理被淘汰的快照文件', () => {
    const store = new ArtifactVersionStore({ dir: tempDir(), now: () => Date.now() })
    const oldest = store.record('s1', htmlArtifact('<p>第 0 版</p>'))
    for (let index = 1; index < 35; index += 1) {
      store.record('s1', htmlArtifact(`<p>第 ${index} 版</p>`))
    }
    const list = store.list('s1', 'art-1')
    expect(list).toHaveLength(30)
    expect(list.some((item) => item.id === oldest?.id)).toBe(false)
    expect(store.read('s1', 'art-1', oldest!.id)).toBeNull()
    expect(store.read('s1', 'art-1', list[0].id)).not.toBeNull()
    expect(existsSync(store.directoryFor('s1', 'art-1'))).toBe(true)
  })

  it('文件型成品从磁盘读取文本；二进制成品不记录快照', () => {
    const dir = tempDir()
    const store = new ArtifactVersionStore({ dir, now: () => Date.now() })
    const source = join(dir, 'report.md')
    writeFileSync(source, '# 文件版', 'utf8')
    const version = store.record('s1', {
      id: 'file-art',
      title: 'report.md',
      kind: 'markdown',
      path: source,
      createdAt: 1,
      updatedAt: 1
    })
    expect(version?.size).toBe(Buffer.byteLength('# 文件版'))
    expect(store.read('s1', 'file-art', version!.id)?.content).toBe('# 文件版')

    const binary = store.record('s1', {
      id: 'bin-art',
      title: '截图.png',
      kind: 'file',
      path: source,
      createdAt: 1,
      updatedAt: 1
    })
    expect(binary).toBeNull()
    expect(store.list('s1', 'bin-art')).toEqual([])
  })

  it('syncArtifacts 跳过不可快照的成品，单条失败不影响其他成品', () => {
    const store = new ArtifactVersionStore({ dir: tempDir(), now: () => Date.now() })
    store.syncArtifacts('s1', [
      htmlArtifact('<h1>A</h1>', 'a'),
      { id: 'binary', title: 'x.pdf', kind: 'file', content: 'not text', createdAt: 1, updatedAt: 1 },
      htmlArtifact('<h1>B</h1>', 'b')
    ])
    expect(store.list('s1', 'a')).toHaveLength(1)
    expect(store.list('s1', 'binary')).toEqual([])
    expect(store.list('s1', 'b')).toHaveLength(1)
  })

  it('内联内容超过 8MB 不记录快照，避免撑爆数据目录', () => {
    const store = new ArtifactVersionStore({ dir: tempDir(), now: () => Date.now() })
    const huge = 'x'.repeat(8 * 1024 * 1024 + 1)
    expect(store.record('s1', htmlArtifact(huge, 'huge'))).toBeNull()
    expect(store.list('s1', 'huge')).toEqual([])
  })

  it('索引里的快照文件名不能越出成品版本目录', () => {
    const dir = tempDir()
    const store = new ArtifactVersionStore({ dir, now: () => Date.now() })
    const version = store.record('s1', htmlArtifact('<h1>安全</h1>'))
    const indexFile = join(store.directoryFor('s1', 'art-1'), 'versions.json')
    const index = JSON.parse(readFileSync(indexFile, 'utf8'))
    index.versions[0].file = '../../outside.txt'
    writeFileSync(indexFile, JSON.stringify(index), 'utf8')
    expect(store.list('s1', 'art-1')).toEqual([])
    expect(store.read('s1', 'art-1', version!.id)).toBeNull()
  })

  it('删除会话时移除这个会话的全部版本数据', () => {
    const store = new ArtifactVersionStore({ dir: tempDir(), now: () => Date.now() })
    store.record('s1', htmlArtifact('<h1>A</h1>'))
    const file = join(store.directoryFor('s1', 'art-1'), 'versions.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).versions).toHaveLength(1)
    store.removeSession('s1')
    expect(existsSync(store.directoryFor('s1', 'art-1'))).toBe(false)
  })
})
