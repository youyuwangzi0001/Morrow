/**
 * 搜索类工具：glob / grep。
 * 刻意用纯 JS 实现，不依赖 rg / fd —— 用户机器上不需要额外二进制，行为可控。
 * 跳过 node_modules/.git/.morrow、二进制文件、超大文件；有数量上限。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { formatBytes, truncateText } from '../util'
import { getBoolean, getString } from './args'
import { ToolInputError } from './types'
import { displayPath, resolveWorkspacePath } from './paths'
import { okResult, oneLineInput, type ToolImpl } from './types'
import { decodeTextBuffer } from './fs-tools'

const SKIP_DIRS = new Set(['node_modules', '.git', '.morrow', '.svn', '.hg', 'dist', 'out', 'release'])
const MAX_SCAN_ENTRIES = 30_000
const MAX_GLOB_RESULTS = 200
const MAX_GREP_MATCHES = 100
const MAX_GREP_FILE_BYTES = 1024 * 1024
const MAX_GREP_LINE_CHARS = 400
const MAX_GREP_FILES = 2000

interface WalkEntry {
  absolute: string
  /** 相对搜索根目录，posix 分隔符 */
  relative: string
  name: string
  size: number
}

/** 递归收集文件（不返回目录）；早停由上限控制 */
async function walkFiles(
  root: string,
  opts: { maxEntries?: number; signal?: AbortSignal } = {}
): Promise<{ files: WalkEntry[]; scanned: number; truncated: boolean }> {
  const files: WalkEntry[] = []
  const maxEntries = opts.maxEntries ?? MAX_SCAN_ENTRIES
  let scanned = 0
  let truncated = false

  const visit = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (truncated) return
    if (opts.signal?.aborted) throw Object.assign(new Error('操作已中断'), { name: 'AbortError' })
    let children: Dirent[]
    try {
      children = readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
    for (const child of children) {
      scanned += 1
      if (scanned > maxEntries) {
        truncated = true
        return
      }
      if (child.isDirectory()) {
        if (SKIP_DIRS.has(child.name)) continue
        await visit(join(dirAbs, child.name), dirRel ? `${dirRel}/${child.name}` : child.name)
        if (truncated) return
        continue
      }
      if (!child.isFile()) continue // symlink 一律跳过：避免跳出工作区/循环
      const absolute = join(dirAbs, child.name)
      let size = 0
      try {
        size = statSync(absolute).size
      } catch {
        continue
      }
      files.push({ absolute, relative: dirRel ? `${dirRel}/${child.name}` : child.name, name: child.name, size })
    }
  }
  await visit(root, '')
  return { files, scanned, truncated }
}

/* ── glob ─────────────────────────────────────────────────────── */

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/** 极简 glob → RegExp：支持 **、*、?、[abc]、{a,b} */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let source = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1
        if (normalized[i + 1] === '/') {
          i += 1
          source += '(?:[^/]+/)*' // **/ 匹配 0 到多级目录
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = normalized.indexOf(']', i + 1)
      if (end > i + 1) {
        source += normalized.slice(i, end + 1)
        i = end
        continue
      }
    }
    if (char === '{') {
      const end = normalized.indexOf('}', i + 1)
      if (end > i + 1) {
        const alternatives = normalized
          .slice(i + 1, end)
          .split(',')
          .map((part) => [...part].map(escapeRegexChar).join(''))
        source += `(?:${alternatives.join('|')})`
        i = end
        continue
      }
    }
    source += escapeRegexChar(char)
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '')
}

function matchGlob(entry: WalkEntry, regExp: RegExp, mode: 'path' | 'basename'): boolean {
  if (regExp.test(entry.relative)) return true
  return mode === 'basename' && regExp.test(entry.name)
}

/* ── grep ─────────────────────────────────────────────────────── */

function compileInclude(include: string): RegExp {
  return globToRegExp(include)
}

/**
 * 在文件中搜索文本。返回的 matches 用于报告/调试，output 给模型。
 */
export const grepTool: ToolImpl = {
  definition: {
    name: 'grep',
    description:
      '在工作区文件内容里搜索正则表达式（JS 正则语法），返回「文件:行号: 内容」。' +
      'path 可以是目录，也可以直接是单个文件。可配合 include 限定文件类型（如 "*.md"）。' +
      '自动跳过二进制与大于 1MB 的文件，最多返回 100 条匹配。' +
      '找文件名用 glob，找文件内容用 grep。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式，例如 "异常|退款" 或 "ORDER-\\\\d+"' },
        path: { type: 'string', description: '搜索目录或单个文件，相对工作区根目录（默认 "."）' },
        include: { type: 'string', description: '只搜索匹配该 glob 的文件，例如 "*.md" 或 "**/*.csv"' },
        ignore_case: { type: 'boolean', description: '是否忽略大小写（默认 false）' }
      },
      required: ['pattern']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `搜索内容 ${oneLineInput(input, 'pattern')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = getString(input, 'pattern', { required: true })
    const searchPath = getString(input, 'path', { defaultValue: '.' }) || '.'
    const include = getString(input, 'include', { defaultValue: '' })
    const ignoreCase = getBoolean(input, 'ignore_case', false)
    let regExp: RegExp
    try {
      regExp = new RegExp(pattern, ignoreCase ? 'i' : '')
    } catch (err) {
      throw new ToolInputError(
        `正则表达式不合法：${err instanceof Error ? err.message : String(err)}`,
        '请检查括号、方括号是否配对；如果要搜普通文本，可以先用简单字面量。'
      )
    }
    const includeRegExp = include ? compileInclude(include) : null
    const resolved = resolveWorkspacePath(searchPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true
    })
    const singleFile = !resolved.isDirectory
    let files: WalkEntry[]
    let scanned: number
    let truncated: boolean
    if (singleFile) {
      let size = 0
      try {
        size = statSync(resolved.real).size
      } catch {
        // 读不到大小时仍尝试读取，后续 readFileSync 失败会跳过
      }
      files = [{ absolute: resolved.real, relative: basename(resolved.real), name: basename(resolved.real), size }]
      scanned = 1
      truncated = false
    } else {
      const walked = await walkFiles(resolved.real, { signal: ctx.signal })
      files = walked.files
      scanned = walked.scanned
      truncated = walked.truncated
    }
    const matches: string[] = []
    let filesSearched = 0
    let skippedBinary = 0
    let skippedLarge = 0
    let hitFiles = 0

    for (const file of files) {
      if (matches.length >= MAX_GREP_MATCHES || filesSearched >= MAX_GREP_FILES) break
      if (!singleFile && includeRegExp && !includeRegExp.test(file.relative) && !includeRegExp.test(file.name)) continue
      if (file.size > MAX_GREP_FILE_BYTES) {
        skippedLarge += 1
        continue
      }
      let buffer: Buffer
      try {
        buffer = readFileSync(file.absolute)
      } catch {
        continue
      }
      const decoded = decodeTextBuffer(buffer)
      filesSearched += 1
      if (decoded.binary) {
        skippedBinary += 1
        continue
      }
      const lines = decoded.text.replace(/\r\n/g, '\n').split('\n')
      let fileHit = false
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= MAX_GREP_MATCHES) break
        if (!regExp.test(lines[i])) continue
        fileHit = true
        const shown = lines[i].trim().slice(0, MAX_GREP_LINE_CHARS)
        matches.push(`${displayPath(file.absolute, ctx.workspace)}:${i + 1}: ${shown}`)
      }
      if (fileHit) hitFiles += 1
    }

    const header = `在「${displayPath(resolved.absolute, ctx.workspace)}」中搜索 ${JSON.stringify(pattern)}：找到 ${matches.length} 处匹配（${hitFiles} 个文件）` +
      `${truncated ? `；已扫描 ${scanned} 项后达到上限` : `；共扫描 ${filesSearched} 个文本文件`}` +
      `${skippedBinary ? `，跳过 ${skippedBinary} 个二进制文件` : ''}${skippedLarge ? `，跳过 ${skippedLarge} 个大于 1MB 的文件` : ''}`
    const output = matches.length > 0 ? `${header}\n${truncateText(matches.join('\n'), 48 * 1024)}` : `${header}\n没有找到匹配内容。`
    return okResult(output, {
      pattern,
      path: displayPath(resolved.absolute, ctx.workspace),
      matches: matches.length,
      hitFiles,
      filesSearched,
      skippedBinary,
      skippedLarge,
      truncated,
      capped: matches.length >= MAX_GREP_MATCHES
    })
  }
}

export const globTool: ToolImpl = {
  definition: {
    name: 'glob',
    description:
      '按文件名模式查找工作区内的文件，返回相对路径（最多 200 条）。支持 **、*、?、{a,b}；' +
      '模式不含 "/" 时会在任意层级匹配同名文件（例如 "*.csv" 找所有 CSV）。知道路径后可用 read_file 读取。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，例如 "**/*.csv" 或 "*.md"' },
        path: { type: 'string', description: '搜索起始目录，相对工作区根目录（默认 "."）' }
      },
      required: ['pattern']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `查找文件 ${oneLineInput(input, 'pattern')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = getString(input, 'pattern', { required: true })
    const searchPath = getString(input, 'path', { defaultValue: '.' }) || '.'
    const regExp = globToRegExp(pattern)
    const mode: 'path' | 'basename' = pattern.includes('/') ? 'path' : 'basename'
    const resolved = resolveWorkspacePath(searchPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      requireDirectory: true
    })
    const { files, scanned, truncated } = await walkFiles(resolved.real, { signal: ctx.signal })
    const matched = files.filter((file) => matchGlob(file, regExp, mode))
    const shown = matched.slice(0, MAX_GLOB_RESULTS)
    const lines = shown.map((file) => `${displayPath(file.absolute, ctx.workspace)}  (${formatBytes(file.size)})`)
    const header =
      `匹配到 ${matched.length} 个文件（搜索根：${displayPath(resolved.absolute, ctx.workspace)}）` +
      `${matched.length > MAX_GLOB_RESULTS ? `，仅显示前 ${MAX_GLOB_RESULTS} 个` : ''}` +
      `${truncated ? `；已扫描 ${scanned} 项后达到上限` : ''}`
    const output = shown.length > 0 ? `${header}\n${lines.join('\n')}` : `${header}\n没有匹配的文件。可以换一个更宽的模式（例如把 "*.csv" 换成 "**/*"）再试。`
    return okResult(output, {
      pattern,
      root: displayPath(resolved.absolute, ctx.workspace),
      count: matched.length,
      truncated: truncated || matched.length > MAX_GLOB_RESULTS,
      scanned
    })
  }
}

export const searchTools: ToolImpl[] = [globTool, grepTool]
