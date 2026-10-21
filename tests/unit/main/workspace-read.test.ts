/**
 * 产物文本读取上限：大文件只读取前缀，不整份载入内存；同时返回 truncated 标记供 UI 提示。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => 'unused-test-dir' },
  dialog: {},
  shell: {}
}))

import { readTextSafe } from '../../../src/main/services/workspace'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readTextSafe', () => {
  it('小文件完整读取', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-read-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'small.txt')
    writeFileSync(path, 'hello 世界', 'utf8')
    const result = await readTextSafe(path, 1024)
    expect(result.content).toBe('hello 世界')
    expect(result.truncated).toBe(false)
    expect(result.size).toBe(Buffer.byteLength('hello 世界', 'utf8'))
  })

  it('大文件只读前缀并标记 truncated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'morrow-read-test-'))
    tempDirs.push(dir)
    const path = join(dir, 'large.txt')
    const size = 1.5 * 1024 * 1024
    writeFileSync(path, 'a'.repeat(size), 'utf8')
    const result = await readTextSafe(path, 1024 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(size)
    expect(result.content.length).toBe(1024 * 1024)
  })
})
