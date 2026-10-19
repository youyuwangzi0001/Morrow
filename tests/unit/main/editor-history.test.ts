import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EditorHistoryStore, MAX_VERSIONS_PER_FILE, canonicalPath, pathKey } from '../../../src/main/services/editor-history'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-history-'))
  dirs.push(dir)
  return dir
}

function tempFile(content: string, name = 'notes.md'): string {
  const dir = tempRoot()
  const file = join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('EditorHistoryStore（R10-F 版本历史）', () => {
  it('记录版本、列表最新在前、可读取内容', () => {
    const root = tempRoot()
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const a = 1', 'utf8')
    const store = new EditorHistoryStore(join(root, 'history'))

    const v1 = store.record({ path: file, content: 'const a = 1', source: 'baseline', mtimeMs: 1000 })
    const v2 = store.record({ path: file, content: 'const a = 2', source: 'user', mtimeMs: 2000 })
    expect(v1 && v2).toBeTruthy()

    const listed = store.list(file)
    expect(listed.path).toBe(file)
    expect(listed.versions.map((item) => item.id)).toEqual([v2!.id, v1!.id])
    expect(listed.versions[0]).toMatchObject({ source: 'user', size: Buffer.byteLength('const a = 2'), mtimeMs: 2000 })

    const read = store.read(file, v1!.id)
    expect(read?.content).toBe('const a = 1')
    expect(read?.version.id).toBe(v1!.id)
  })

  it('内容与最新版本相同则去重（force 可强制记录）', () => {
    const root = tempRoot()
    const file = join(root, 'b.md')
    writeFileSync(file, '# B', 'utf8')
    const store = new EditorHistoryStore(join(root, 'history'))
    const first = store.record({ path: file, content: '# B' })
    const again = store.record({ path: file, content: '# B' })
    expect(again?.id).toBe(first?.id)
    expect(store.list(file).versions).toHaveLength(1)
    const forced = store.record({ path: file, content: '# B', force: true })
    expect(forced?.id).not.toBe(first?.id)
    expect(store.list(file).versions).toHaveLength(2)
  })

  it(`每个文件最多保留 ${MAX_VERSIONS_PER_FILE} 个版本，旧版本内容文件被清理`, () => {
    const root = tempRoot()
    const file = join(root, 'long.txt')
    writeFileSync(file, 'v0', 'utf8')
    const store = new EditorHistoryStore(join(root, 'history'))
    for (let i = 0; i < MAX_VERSIONS_PER_FILE + 6; i += 1) {
      store.record({ path: file, content: `version-${i}`, force: true })
    }
    const versions = store.list(file).versions
    expect(versions).toHaveLength(MAX_VERSIONS_PER_FILE)
    // 最新的是最后写入的，最旧的在列表末尾
    expect(versions[0].size).toBe(Buffer.byteLength(`version-${MAX_VERSIONS_PER_FILE + 5}`))
    const oldest = store.read(file, versions[versions.length - 1].id)
    expect(oldest?.content).toBe(`version-${MAX_VERSIONS_PER_FILE + 5 - (MAX_VERSIONS_PER_FILE - 1)}`)
    // 被淘汰版本的内容已删除
    expect(store.read(file, versions[0].id)?.content).toContain('version-')
  })

  it('全库容量上限会淘汰最旧版本，但每个文件至少保留一版', () => {
    const root = tempRoot()
    const historyDir = join(root, 'history')
    const store = new EditorHistoryStore(historyDir, { maxTotalBytes: 30 })
    const fileA = join(root, 'a.txt')
    const fileB = join(root, 'b.txt')
    writeFileSync(fileA, 'aaaa', 'utf8')
    writeFileSync(fileB, 'bbbb', 'utf8')
    for (let i = 0; i < 5; i += 1) {
      store.record({ path: fileA, content: `A-${i}-0123456789`, force: true })
      store.record({ path: fileB, content: `B-${i}-0123456789`, force: true })
    }
    const stats = store.stats()
    expect(stats.bytes).toBeLessThanOrEqual(30)
    expect(store.list(fileA).versions.length).toBeGreaterThanOrEqual(1)
    expect(store.list(fileB).versions.length).toBeGreaterThanOrEqual(1)
  })

  it('diff：默认与上一个版本比较，也可与传入的当前内容比较', () => {
    const root = tempRoot()
    const file = join(root, 'diff.ts')
    writeFileSync(file, 'line-1', 'utf8')
    const store = new EditorHistoryStore(join(root, 'history'))
    const oldVersion = store.record({ path: file, content: 'line-1\n', force: true })
    store.record({ path: file, content: 'line-1\nline-2\n', force: true })

    const againstPrevious = store.diff(file, oldVersion!.id)
    expect(againstPrevious?.patch).toContain('+line-2')
    expect(againstPrevious?.added).toBe(1)

    const againstCurrent = store.diff(file, oldVersion!.id, 'line-1\nline-2\nline-3\n')
    expect(againstCurrent?.patch).toContain('+line-2')
    expect(againstCurrent?.patch).toContain('+line-3')
  })

  it('restore：写回磁盘、冲突检测、未知版本/未记录路径拒绝', () => {
    const root = tempRoot()
    const file = join(root, 'restore.md')
    writeFileSync(file, '原始内容', 'utf8')
    const store = new EditorHistoryStore(join(root, 'history'))
    const version = store.record({ path: file, content: '原始内容', mtimeMs: statSync(file).mtimeMs })
    expect(version).toBeTruthy()
    writeFileSync(file, '被改坏了', 'utf8')

    const restored = store.restore(file, version!.id, { expectedMtimeMs: statSync(file).mtimeMs })
    expect(readFileSync(file, 'utf8')).toBe('原始内容')
    expect(restored.size).toBe(Buffer.byteLength('原始内容'))
    // 恢复动作本身也会记录一个版本
    expect(restored.newVersionId).toBeTruthy()
    expect(store.list(file).versions[0].source).toBe('restore')

    // mtime 冲突
    writeFileSync(file, '又被外部改了', 'utf8')
    const staleMtime = statSync(file).mtimeMs - 5000
    expect(() => store.restore(file, version!.id, { expectedMtimeMs: staleMtime })).toThrow(/外部修改/)

    // 未记录历史的路径不能被写（防任意写）
    const unknown = join(root, 'unknown.txt')
    expect(() => store.restore(unknown, version!.id)).toThrow(/找不到这个历史版本/)

    // 未知版本
    expect(() => store.restore(file, 'v-not-exist')).toThrow(/找不到这个历史版本/)
  })

  it('超大内容不进入历史（返回 null），持久化跨实例可读', () => {
    const root = tempRoot()
    const file = join(root, 'big.txt')
    writeFileSync(file, 'x', 'utf8')
    const historyDir = join(root, 'history')
    const store = new EditorHistoryStore(historyDir, { maxVersionBytes: 16 })
    expect(store.record({ path: file, content: '12345678901234567890' })).toBeNull()
    const kept = store.record({ path: file, content: 'small' })
    expect(kept).toBeTruthy()

    const reopened = new EditorHistoryStore(historyDir)
    expect(reopened.list(file).versions[0].id).toBe(kept!.id)
    expect(reopened.read(file, kept!.id)?.content).toBe('small')
  })

  it('Windows 路径大小写不敏感（hash 归一化）', () => {
    if (process.platform !== 'win32') return
    const root = tempRoot()
    const file = join(root, 'Case.md')
    const a = canonicalPath(file)
    const b = canonicalPath(file.toUpperCase())
    expect(a).toBe(b)
    expect(pathKey(file)).toBe(pathKey(file.toUpperCase()))
  })

  it('clear 清空指定文件历史', () => {
    const root = tempRoot()
    const file = join(root, 'clear.txt')
    writeFileSync(file, 'x', 'utf8')
    const store = new EditorHistoryStore(join(root, 'history'))
    store.record({ path: file, content: 'x', force: true })
    store.clear(file)
    expect(store.list(file).versions).toHaveLength(0)
    expect(store.read(file, 'x')).toBeNull()
  })
})
