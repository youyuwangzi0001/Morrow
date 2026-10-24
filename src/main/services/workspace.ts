import { app, dialog } from 'electron'
import { revealInFileManager } from './reveal'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { isPathInside } from './paths'
import type { FileSearchResult, WorkspaceInfo } from '../../shared/types'
import { dataPath, ensureDataDirs } from './paths'
import { log } from './logger'

const IGNORE_DIRS = new Set(['node_modules', '.git', '.morrow', 'dist', 'out', 'release', 'tmp', '.cache'])

export async function pickWorkspace(): Promise<WorkspaceInfo | null> {
  const result = await dialog.showOpenDialog({
    title: '选择工作文件夹',
    buttonLabel: '让 Morrow 在这里工作',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return describeWorkspace(result.filePaths[0])
}

export function describeWorkspace(path: string): WorkspaceInfo {
  const resolved = resolve(path)
  const exists = existsSync(resolved) && statSync(resolved).isDirectory()
  let fileCount = 0
  if (exists) {
    try {
      const count = countFiles(resolved, 0)
      fileCount = count
    } catch {
      fileCount = 0
    }
  }
  return {
    path: resolved,
    name: basename(resolved),
    exists,
    fileCount,
    git: exists && existsSync(join(resolved, '.git'))
  }
}

function countFiles(dir: string, depth: number): number {
  if (depth > 4) return 0
  let total = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of entries) {
    if (total > 2000) break
    if (name.startsWith('.') && name !== '.morrow') continue
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue
      total += countFiles(full, depth + 1)
    } else {
      total += 1
    }
  }
  return total
}

/** 演示工作区固定位置；演示模型只允许在这里运行。 */
export function demoWorkspacePath(): string {
  return dataPath('demo-workspace')
}

/** 判断路径是否就是 Morrow 的演示工作区（不跟随前缀，避免把真实文件夹误认成演示区）。 */
export function isDemoWorkspace(path: string | null | undefined): boolean {
  if (!path) return false
  const canonical = (value: string): string => {
    const resolved = resolve(value)
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }
  try {
    const actual = canonical(path)
    const target = canonical(demoWorkspacePath())
    return process.platform === 'win32' ? actual.toLowerCase() === target.toLowerCase() : actual === target
  } catch {
    return false
  }
}

/** 把内置演示工作区复制到 userData/demo-workspace（只读源 assets/demo-workspace） */
export function createDemoWorkspace(): WorkspaceInfo {
  ensureDataDirs()
  const target = demoWorkspacePath()
  const source = join(app.getAppPath(), 'assets', 'demo-workspace')
  if (!existsSync(source)) {
    throw new Error('演示工作区资源缺失，请重新安装 Morrow。')
  }
  if (existsSync(target)) {
    removeTree(target)
  }
  mkdirSync(target, { recursive: true })
  copyTree(source, target)
  log.info('demo workspace prepared', { target })
  return describeWorkspace(target)
}

/** 在工作区内按文件名/路径模糊搜索（@ 引用） */
export function searchWorkspaceFiles(root: string, query: string, limit = 12): FileSearchResult[] {
  const base = resolve(root)
  if (!existsSync(base) || !statSync(base).isDirectory()) return []
  let baseReal: string
  try {
    baseReal = realpathSync(base)
  } catch {
    return []
  }
  const q = query.toLowerCase()
  const results: FileSearchResult[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || results.length > 400) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (results.length > 400) break
      if (name.startsWith('.') && name !== '.morrow') continue
      const full = join(dir, name)
      let stat
      try {
        // lstat + realpath：不跟随工作区内的符号链接/junction 逃逸到外部目录
        stat = lstatSync(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue
        try {
          if (!isPathInside(baseReal, realpathSync(full))) continue
        } catch {
          continue
        }
        walk(full, depth + 1)
        continue
      }
      const rel = full.slice(base.length + 1).replace(/\\/g, '/')
      const haystack = `${name.toLowerCase()} ${rel.toLowerCase()}`
      const score = scoreMatch(haystack, q)
      if (score > 0) {
        results.push({
          path: full,
          name,
          dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
          score
        })
      }
    }
  }
  walk(base, 0)
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

function scoreMatch(haystack: string, query: string): number {
  const index = haystack.indexOf(query)
  if (index === -1) {
    // 子序列匹配（fuzzy）
    let qi = 0
    for (let i = 0; i < haystack.length && qi < query.length; i++) {
      if (haystack[i] === query[qi]) qi += 1
    }
    return qi === query.length ? 1 : 0
  }
  return 100 - Math.min(50, index)
}

export async function readTextSafe(path: string, maxBytes = 512 * 1024): Promise<{ content: string; size: number; truncated: boolean }> {
  const stat = statSync(path)
  const size = stat.size
  if (size <= maxBytes) {
    return { content: readFileSync(path, 'utf8'), size, truncated: false }
  }
  // 只读取前 maxBytes，不把超大文件整份读进内存
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, 0)
    return { content: buffer.subarray(0, read).toString('utf8'), size, truncated: true }
  } finally {
    closeSync(fd)
  }
}

export function revealPath(path: string): void {
  void revealInFileManager(path)
}


/** 手写目录复制/删除：避免 Windows 上 fs.cpSync / rmSync 在特殊路径下的 EPERM */
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const stat = statSync(from)
    if (stat.isDirectory()) copyTree(from, to)
    else writeFileSync(to, readFileSync(from))
  }
}

function removeTree(target: string): void {
  for (const name of readdirSync(target)) {
    const full = join(target, name)
    const stat = statSync(full)
    if (stat.isDirectory()) removeTree(full)
    else {
      const { unlinkSync } = require('node:fs') as typeof import('node:fs')
      unlinkSync(full)
    }
  }
  const { rmdirSync } = require('node:fs') as typeof import('node:fs')
  rmdirSync(target)
}
