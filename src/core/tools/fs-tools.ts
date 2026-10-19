/**
 * 文件类工具：read_file / write_file / edit_file / list_dir。
 *
 * 共同安全约束：
 * - 所有路径经 resolveWorkspacePath（realpath 沙箱）；
 * - 写/编辑前把旧内容备份到 <snapshotDir>/<toolUseId>/<filename>，meta 里带 snapshotId；
 * - 文本读写统一 UTF-8（兼容 BOM/UTF-16LE），二进制文件拒绝按文本处理。
 */
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ToolResult } from '../../shared/types'
import type { ToolContext } from '../types'
import { clampInt, formatBytes, sha256, truncateText } from '../util'
import { getBoolean, getNumber, getString } from './args'
import { createUnifiedDiff, diffSummary } from './diff'
import { ToolInputError } from './errors'
import { displayPath, resolveWorkspacePath } from './paths'
import { errResult, okResult, oneLineInput, type ToolImpl } from './types'

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_CHARS = 2 * 1024 * 1024
const DEFAULT_READ_LINES = 2000
const MAX_READ_LINES = 20_000
const MAX_LIST_ENTRIES = 400
const SKIP_DIRS = new Set(['node_modules', '.git', '.morrow', '.svn', '.hg'])
const MAX_OUTPUT_CHARS = 64 * 1024

/* ── 内部工具函数 ─────────────────────────────────────────────── */

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 解码文本；识别 UTF-16LE/BE BOM；前 8KB 含 NUL 判定为二进制 */
export function decodeTextBuffer(buffer: Buffer): { text: string; binary: boolean } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: stripBom(buffer.subarray(2).toString('utf16le')), binary: false }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = tmp
    }
    return { text: stripBom(swapped.toString('utf16le')), binary: false }
  }
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (probe.includes(0)) return { text: '', binary: true }
  return { text: stripBom(buffer.toString('utf8')), binary: false }
}

/** 只读取文件头，避免把超大文件整个读进内存 */
function readFileHead(absolutePath: string, maxBytes: number): { buffer: Buffer; fileSize: number; truncated: boolean } {
  const stat = statSync(absolutePath)
  const fileSize = stat.size
  if (fileSize <= maxBytes) {
    const buffer = readFileSync(absolutePath)
    return { buffer, fileSize, truncated: false }
  }
  const fd = openSync(absolutePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return { buffer: buffer.subarray(0, bytesRead), fileSize, truncated: true }
  } finally {
    closeSync(fd)
  }
}

export interface SnapshotInfo {
  snapshotId: string
  snapshotPath: string
  beforeHash: string
  beforeText: string | null
  beforeBinary: boolean
}

/**
 * 记录「这次写入后的文件哈希」。撤销（restoreSnapshot）用它判断文件在写入之后
 * 是否被用户手工改过：当前哈希 ≠ afterHash 且 ≠ beforeHash → 冲突，拒绝覆盖。
 * R7 审计修复：旧实现只有 before 快照，撤销会静默覆盖用户后来的修改。
 */
export function recordRestoreManifest(
  ctx: ToolContext,
  absolutePath: string,
  beforeHash: string | null,
  afterHash: string
): void {
  try {
    const dir = join(ctx.snapshotDir, ctx.toolUseId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.restore.json'),
      JSON.stringify({ targetPath: absolutePath, beforeHash, afterHash, at: Date.now() }),
      'utf8'
    )
  } catch {
    // 快照清单写失败不应影响主流程；撤销时会走「缺少清单」的保守分支
  }
}

export const RESTORE_MANIFEST_FILE = '.restore.json'

/**
 * 写/编辑前备份旧文件：<snapshotDir>/<toolUseId>/<filename>。
 * 这是「撤销本轮文件改动」的数据源，主进程只需按 toolUseId 还原。
 */
export function snapshotFile(absolutePath: string, ctx: ToolContext): SnapshotInfo | null {
  if (!existsSync(absolutePath)) return null
  const stat = statSync(absolutePath)
  if (!stat.isFile()) return null
  const snapshotDir = join(ctx.snapshotDir, ctx.toolUseId)
  mkdirSync(snapshotDir, { recursive: true })
  const snapshotPath = join(snapshotDir, basename(absolutePath))
  copyFileSync(absolutePath, snapshotPath)
  const buffer = readFileSync(absolutePath)
  const decoded = decodeTextBuffer(buffer)
  return {
    snapshotId: ctx.toolUseId,
    snapshotPath,
    beforeHash: sha256(buffer),
    beforeText: decoded.binary ? null : decoded.text,
    beforeBinary: decoded.binary
  }
}

function toLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function countLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

function relativeOrAbsolute(absolute: string, ctx: ToolContext): string {
  return displayPath(absolute, ctx.workspace)
}

/* ── read_file ────────────────────────────────────────────────── */

export const readFileTool: ToolImpl = {
  definition: {
    name: 'read_file',
    description:
      '读取工作区内的文本文件，返回带行号的内容。支持 offset/limit 分页读取大文件；文件超过 256KB 只读取开头。' +
      '读取前可先用 list_dir 或 glob 确认路径。二进制文件会报错，需用 run_command 处理。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录（如 "报告/数据.csv"）' },
        offset: { type: 'number', description: '起始行号（从 1 开始，默认 1）' },
        limit: { type: 'number', description: '最多读取行数（默认 2000，上限 20000）' }
      },
      required: ['path']
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `读取 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true
    })
    if (resolved.isDirectory) {
      throw new ToolInputError(`「${rawPath}」是一个文件夹，不是文件。`, '可以改用 list_dir 查看文件夹内容。')
    }
    const { buffer, fileSize, truncated: fileTruncated } = readFileHead(resolved.real, MAX_READ_BYTES)
    const decoded = decodeTextBuffer(buffer)
    if (decoded.binary) {
      throw new ToolInputError(
        `「${rawPath}」看起来是二进制文件（可能是图片、压缩包或 Office 文档），不能按文本读取。`,
        '如果确实需要处理它，可以运行命令（例如 Python/Node 脚本）来解析，或改用 open_artifact 作为文件产物打开。'
      )
    }
    const lines = toLines(decoded.text)
    const totalLines = fileTruncated ? lines.length : Math.max(lines.length, countLines(decoded.text))
    const offset = clampInt(getNumber(input, 'offset', { defaultValue: 1, min: 1 }), 1, Math.max(1, totalLines + 1))
    const limit = clampInt(getNumber(input, 'limit', { defaultValue: DEFAULT_READ_LINES, min: 1, max: MAX_READ_LINES }), 1, MAX_READ_LINES)
    const startIndex = offset - 1
    const selected = lines.slice(startIndex, startIndex + limit)
    const endLine = selected.length > 0 ? startIndex + selected.length : startIndex
    const numbered = selected.map((line, i) => `${String(startIndex + i + 1).padStart(5)}│${line}`).join('\n')
    const headerParts = [
      `${relativeOrAbsolute(resolved.absolute, ctx)}（共 ${totalLines} 行`,
      selected.length > 0 ? `显示第 ${offset}-${endLine} 行` : '没有更多内容',
      fileSize > MAX_READ_BYTES ? `文件 ${formatBytes(fileSize)}，仅读取开头 256KB` : `${formatBytes(fileSize)}`,
      '）'
    ]
    const output = `${headerParts.join('，')}\n${truncateText(numbered, MAX_OUTPUT_CHARS)}`
    const hasMore = endLine < totalLines
    return okResult(output, {
      path: relativeOrAbsolute(resolved.absolute, ctx),
      absolutePath: resolved.absolute,
      size: fileSize,
      lines: totalLines,
      startLine: offset,
      endLine,
      hasMore,
      truncated: fileTruncated
    })
  }
}

/* ── write_file ───────────────────────────────────────────────── */

export const writeFileTool: ToolImpl = {
  definition: {
    name: 'write_file',
    description:
      '把文本内容写入工作区内的文件（会创建缺失的父目录；已存在的文件默认被覆盖）。' +
      'append=true 时追加到文件末尾（文件不存在则创建）。写入前会自动备份旧内容用于撤销。' +
      '内容较长（>约 4KB / 100 行）时建议分次写：先写骨架，再用 append=true 分段追加，避免单次输出被长度上限截断。' +
      '生成 HTML/Markdown 等成品时，内容要完整、可直接使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录' },
        content: { type: 'string', description: '要写入的文本内容（UTF-8）' },
        append: { type: 'boolean', description: '是否追加到文件末尾（默认 false = 覆盖；文件不存在则创建）' }
      },
      required: ['path', 'content']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `${input.append === true ? '追加写入' : '写入'} ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    if (!('content' in input)) {
      throw new ToolInputError('缺少必填参数「content」。', '请提供要写入的完整文本内容。')
    }
    const rawContent = input.content
    if (typeof rawContent !== 'string') {
      throw new ToolInputError('参数「content」应该是字符串。', '请把文件内容作为字符串传入。')
    }
    if (rawContent.length > MAX_WRITE_CHARS) {
      throw new ToolInputError(
        `内容过大（${formatBytes(rawContent.length)}，上限 ${formatBytes(MAX_WRITE_CHARS)}）。`,
        '请拆分成多个较小的文件，或改用 run_command 生成大文件。'
      )
    }
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved })
    if (resolved.isDirectory) {
      throw new ToolInputError(`「${rawPath}」是一个文件夹，不能当文件写入。`, '请换一个文件路径。')
    }
    const append = getBoolean(input, 'append', false)
    const existed = existsSync(resolved.absolute) && statSync(resolved.absolute).isFile()
    // append 同样要备份旧内容（撤销/差异视图依赖快照 + beforeHash/diff）
    const snapshot = snapshotFile(resolved.absolute, ctx)
    mkdirSync(dirname(resolved.absolute), { recursive: true })
    if (append) appendFileSync(resolved.absolute, rawContent, 'utf8')
    else writeFileSync(resolved.absolute, rawContent, 'utf8')

    const displayPath = relativeOrAbsolute(resolved.absolute, ctx)
    const writtenBytes = Buffer.byteLength(rawContent, 'utf8')
    const writtenLines = countLines(rawContent)
    let afterText: string | null = rawContent
    let afterHash = sha256(rawContent)
    let afterLines = writtenLines
    if (append) {
      const afterBuffer = readFileSync(resolved.absolute)
      const afterDecoded = decodeTextBuffer(afterBuffer)
      afterText = afterDecoded.binary ? null : afterDecoded.text
      afterHash = sha256(afterBuffer)
      afterLines = afterText !== null ? countLines(afterText) : 0
    }
    const diff =
      snapshot && snapshot.beforeText !== null && afterText !== null
        ? createUnifiedDiff(snapshot.beforeText, afterText, displayPath)
        : null
    recordRestoreManifest(ctx, resolved.absolute, snapshot?.beforeHash ?? null, afterHash)
    const lines = [
      `${append ? (existed ? '已追加写入' : '已创建并写入') : existed ? '已覆盖' : '已创建'} ${displayPath}`,
      append
        ? `新增 ${writtenLines} 行 / ${formatBytes(writtenBytes)} · 现共 ${afterLines} 行`
        : `${afterLines} 行 · ${formatBytes(writtenBytes)}`,
      diff ? `改动 ${diffSummary(diff)}` : '',
      snapshot ? '旧内容已备份，可撤销。' : ''
    ].filter(Boolean)
    const meta: Record<string, unknown> = {
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      path: displayPath,
      absolutePath: resolved.absolute,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash,
      bytes: writtenBytes,
      lines: afterLines,
      writtenLines,
      appended: append,
      diff: diff?.patch ?? '',
      created: !existed
    }
    return okResult(lines.join('\n'), meta)
  }
}

/* ── edit_file ────────────────────────────────────────────────── */

/** 在 old_string 直接匹配失败时尝试适配文件的行尾风格（Windows CRLF 是常见坑） */
function findMatchVariant(text: string, oldString: string): { needle: string; count: number } {
  const candidates: string[] = [oldString]
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (oldString.includes('\n')) {
    candidates.push(oldString.replace(/\r\n/g, '\n').replace(/\n/g, eol))
  }
  if (oldString.includes('\r\n')) {
    candidates.push(oldString.replace(/\r\n/g, '\n'))
  }
  for (const needle of candidates) {
    if (!needle) continue
    const count = text.split(needle).length - 1
    if (count > 0) return { needle, count }
  }
  return { needle: oldString, count: 0 }
}

export const editFileTool: ToolImpl = {
  definition: {
    name: 'edit_file',
    description:
      '对工作区内的文本文件做精确替换。old_string 必须在文件中唯一出现（或设置 replace_all=true 全部替换）。' +
      '匹配失败时会返回可自修复的提示：先 read_file 确认原文（注意空格、缩进、换行）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对工作区根目录' },
        old_string: { type: 'string', description: '要被替换的原文（必须与文件内容完全一致）' },
        new_string: { type: 'string', description: '替换后的新内容' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配（默认 false，只允许唯一匹配）' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    category: 'write',
    risk: 'medium',
    titleFor: (input) => `修改 ${oneLineInput(input, 'path')}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { required: true })
    const oldString = getString(input, 'old_string', { required: true, trim: false })
    const newString = getString(input, 'new_string', { trim: false })
    const replaceAll = input.replace_all === true
    const resolved = resolveWorkspacePath(rawPath, ctx.workspace, { escapeApproved: ctx.escapeApproved, requireExist: true })
    if (resolved.isDirectory) throw new ToolInputError(`「${rawPath}」是一个文件夹，不是文件。`, '请指定具体文件。')
    const stat = statSync(resolved.real)
    if (stat.size > 2 * 1024 * 1024) {
      throw new ToolInputError(`文件过大（${formatBytes(stat.size)}），edit_file 只支持 2MB 以内的文本。`, '可以改用 write_file 重写，或用 run_command 处理。')
    }
    const decoded = decodeTextBuffer(readFileSync(resolved.real))
    if (decoded.binary) {
      throw new ToolInputError(`「${rawPath}」是二进制文件，不能用 edit_file 修改。`, '请改用 run_command 或 open_artifact。')
    }
    const text = decoded.text
    const { needle, count } = findMatchVariant(text, oldString)
    if (count === 0) {
      return errResult(
        `没有在「${rawPath}」中找到 old_string。`,
        '请先 read_file 查看当前内容，按实际文本（包含空格/缩进/换行）重试；也可以扩大或缩小 old_string 的上下文。',
        { matchCount: 0 }
      )
    }
    if (count > 1 && !replaceAll) {
      return errResult(
        `old_string 在「${rawPath}」中出现了 ${count} 次，无法确定要改哪一处。`,
        '请提供更长、更独特的 old_string（包含上下文），或设置 replace_all=true 全部替换。',
        { matchCount: count }
      )
    }
    const snapshot = snapshotFile(resolved.absolute, ctx)
    const nextText = replaceAll ? text.split(needle).join(newString) : text.replace(needle, () => newString)
    writeFileSync(resolved.absolute, nextText, 'utf8')
    const afterHashEdit = sha256(nextText)
    recordRestoreManifest(ctx, resolved.absolute, snapshot?.beforeHash ?? null, afterHashEdit)
    const diff = createUnifiedDiff(text, nextText, relativeOrAbsolute(resolved.absolute, ctx))
    const meta: Record<string, unknown> = {
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotPath: snapshot?.snapshotPath ?? null,
      path: relativeOrAbsolute(resolved.absolute, ctx),
      absolutePath: resolved.absolute,
      beforeHash: snapshot?.beforeHash ?? null,
      afterHash: afterHashEdit,
      matchCount: count,
      replaced: replaceAll ? count : 1,
      diff: diff.patch
    }
    return okResult(
      `已修改 ${relativeOrAbsolute(resolved.absolute, ctx)}（替换 ${replaceAll ? count : 1} 处，${diffSummary(diff)}）\n旧内容已备份，可撤销。`,
      meta
    )
  }
}

/* ── list_dir ─────────────────────────────────────────────────── */

interface TreeEntry {
  name: string
  relative: string
  isDirectory: boolean
  size: number
}

export const listDirTool: ToolImpl = {
  definition: {
    name: 'list_dir',
    description:
      '以树形列出工作区内的目录内容（默认只看 1 层，可指定 depth 最多 3 层）。' +
      '会自动跳过 node_modules/.git 等噪音目录。开始任务时建议先列一遍了解结构。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对工作区根目录（默认 "."）' },
        depth: { type: 'number', description: '递归层数，默认 1，最大 3' }
      }
    },
    category: 'read',
    risk: 'low',
    titleFor: (input) => `查看目录 ${oneLineInput(input, 'path') || '.'}`
  },
  async execute(input, ctx): Promise<ToolResult> {
    const rawPath = getString(input, 'path', { defaultValue: '.' })
    const depth = clampInt(getNumber(input, 'depth', { defaultValue: 1, min: 1, max: 3 }), 1, 3)
    const resolved = resolveWorkspacePath(rawPath || '.', ctx.workspace, {
      escapeApproved: ctx.escapeApproved,
      requireExist: true,
      requireDirectory: true
    })
    const displayRoot = relativeOrAbsolute(resolved.absolute, ctx)
    const lines: string[] = [`${displayRoot}/`]
    const entries: TreeEntry[] = []
    let truncated = false

    const walk = (dirAbs: string, level: number, prefix: string): void => {
      if (level > depth || truncated) return
      let children: Dirent[]
      try {
        children = readdirSync(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      const visible = children
        .filter((child) => {
          if (child.isDirectory() && SKIP_DIRS.has(child.name)) return false
          if (child.name === '.DS_Store' || child.name === 'Thumbs.db') return false
          return child.isDirectory() || child.isFile()
        })
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
      for (let i = 0; i < visible.length; i += 1) {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
        const child = visible[i]
        const last = i === visible.length - 1
        const childAbs = join(dirAbs, child.name)
        const childRel = prefix === '' ? child.name : ''
        const connector = last ? '└─ ' : '├─ '
        if (child.isDirectory()) {
          entries.push({ name: child.name, relative: child.name, isDirectory: true, size: 0 })
          lines.push(`${prefix}${connector}${child.name}/`)
          walk(childAbs, level + 1, `${prefix}${last ? '   ' : '│  '}`)
        } else if (child.isFile()) {
          let size = 0
          try {
            size = statSync(childAbs).size
          } catch {
            // 忽略统计失败
          }
          entries.push({ name: child.name, relative: childRel, isDirectory: false, size })
          lines.push(`${prefix}${connector}${child.name}  (${formatBytes(size)})`)
        }
      }
    }
    walk(resolved.real, 1, '')

    if (entries.length === 0) lines.push('（空目录）')
    if (truncated) lines.push(`…（条目过多，仅显示前 ${MAX_LIST_ENTRIES} 条）`)
    const dirCount = entries.filter((e) => e.isDirectory).length
    lines.push(`\n共 ${entries.length} 项（${dirCount} 个文件夹，${entries.length - dirCount} 个文件）${truncated ? '，已截断' : ''}`)
    return okResult(truncateText(lines.join('\n'), MAX_OUTPUT_CHARS), {
      path: displayRoot,
      absolutePath: resolved.absolute,
      entries: entries.length,
      dirs: dirCount,
      files: entries.length - dirCount,
      truncated,
      depth
    })
  }
}

export const fsTools: ToolImpl[] = [readFileTool, writeFileTool, editFileTool, listDirTool]
