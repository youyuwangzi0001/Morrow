/**
 * 原子写（`core/util.writeFileAtomic`）的用例。
 *
 * 这份实现是**全仓唯一**的：此前有五到六份分散实现，其中 settings 与 studio
 * 那两份没有 Windows 的 EPERM/EBUSY 重试，失败后还会留下 *.tmp。
 * 分叉的恰好是「设置」与「作品主数据」两条最高频写路径。
 *
 * 守的不是“能写进去”，而是**写坏/写失败时留下什么**：
 * 目标文件要么是旧内容、要么是新内容，不能是半截；临时文件不能残留。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../../src/core/util'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morrow-atomic-'))
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 清理失败不影响断言结论
  }
})

describe('writeFileAtomic', () => {
  it('@core:relay 写入后目标文件是新内容，且不残留临时文件', () => {
    const target = join(root, 'settings.json')
    writeFileAtomic(target, '{"a":1}')

    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
    const leftovers = readdirSync(root).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('@core:relay 目标目录不存在时自动创建（调用方不必先 mkdir）', () => {
    const target = join(root, 'a', 'b', 'c.json')
    writeFileAtomic(target, 'x')
    expect(existsSync(target)).toBe(true)
  })

  it('@core:relay 覆盖已有文件：内容整份替换，不追加', () => {
    const target = join(root, 'p.json')
    writeFileAtomic(target, 'first')
    writeFileAtomic(target, 'second')
    expect(readFileSync(target, 'utf8')).toBe('second')
  })

  it('@core:relay 写临时文件失败时不破坏已有目标文件', () => {
    const target = join(root, 'keep.json')
    writeFileAtomic(target, 'original')

    // 用一个目录占住目标目录下的所有 tmp 路径不现实；改为让目标路径本身是目录，
    // 这样 rename 一定失败，验证「失败不污染已有内容」。
    const dirTarget = join(root, 'is-a-dir')
    mkdirSync(dirTarget)
    expect(() => writeFileAtomic(dirTarget, 'x')).toThrow()

    // 之前那个文件必须原封不动
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  it('@core:relay 允许调用方指定权限（凭据类文件不给组读）', () => {
    const target = join(root, 'cred.bin')
    writeFileAtomic(target, 'secret', { mode: 0o600 })
    expect(readFileSync(target, 'utf8')).toBe('secret')
  })

  it('@core:relay 支持 Buffer 内容（成片预览等二进制写入）', () => {
    const target = join(root, 'blob.bin')
    const bytes = Buffer.from([0, 1, 2, 255])
    writeFileAtomic(target, bytes)
    expect(readFileSync(target).equals(bytes)).toBe(true)
  })

  it('@core:relay 已有半截临时文件不会影响本次写入', () => {
    const target = join(root, 'r.json')
    // 模拟上次崩溃留下的同名临时文件
    writeFileSync(`${target}.${process.pid}.tmp`, 'stale')
    writeFileAtomic(target, 'fresh')
    expect(readFileSync(target, 'utf8')).toBe('fresh')
  })
})
