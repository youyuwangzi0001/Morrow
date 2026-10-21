/**
 * 工作区文件搜索边界：
 * - 正常返回工作区内匹配文件；
 * - 不跟随工作区内的符号链接 / junction，避免把外部目录的文件名与路径暴露给渲染层。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => 'unused-test-dir' },
  dialog: {},
  shell: {}
}))

import { searchWorkspaceFiles } from '../../../src/main/services/workspace'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeSandbox(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'morrow-search-test-'))
  tempDirs.push(base)
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { root, outside }
}

describe('searchWorkspaceFiles', () => {
  it('返回工作区内匹配文件，忽略隐藏目录与 node_modules', () => {
    const { root } = makeSandbox()
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'docs', 'inside-report.md'), 'x', 'utf8')
    writeFileSync(join(root, 'node_modules', 'pkg', 'inside-ignored.md'), 'x', 'utf8')
    writeFileSync(join(root, '.git', 'inside-hidden.md'), 'x', 'utf8')

    const results = searchWorkspaceFiles(root, 'inside')
    expect(results.map((item) => item.name)).toEqual(['inside-report.md'])
  })

  it('不跟随 junction / 符号链接目录，不泄漏外部文件', () => {
    const { root, outside } = makeSandbox()
    writeFileSync(join(root, 'visible.txt'), 'x', 'utf8')
    writeFileSync(join(outside, 'outside-secret.txt'), 'x', 'utf8')
    let linked = false
    try {
      symlinkSync(outside, join(root, 'linked-outside'), 'junction')
      linked = true
    } catch {
      linked = false
    }
    if (!linked) return // Windows 受限环境建不了目录链接时跳过

    const results = searchWorkspaceFiles(root, 'outside')
    expect(results).toHaveLength(0)
    expect(results.some((item) => item.path.includes('outside-secret'))).toBe(false)
  })
})
