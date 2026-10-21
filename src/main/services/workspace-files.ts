/**
 * R10-A 工作区文件服务（纯 Node，不 import electron，便于单测）。
 *
 * 安全模型（最高标准）：
 * - 所有路径先经 @core/tools/paths 的 inspectWorkspacePath：绝对化 + realpath 后必须落在工作区内；
 *   新建路径对最近的存在祖先 realpath 再拼回尾巴；symlink / junction 指向工作区外一律拒绝。
 * - 操作对象用 absolute 路径（删除 symlink 时删链接本身而不是目标），但「是否允许」以 realpath 判定。
 * - 读取：≤2MB 文本上限，检测 NUL 字节/大量替换符判定二进制，超限与二进制都抛可读错误。
 * - 写入：同目录临时文件 + rename 原子替换；写前快照（原文件 + manifest 含前后 hash）；
 *   expectedMtimeMs 与磁盘不一致时拒绝保存（外部修改冲突）。
 * - 创建/重命名/移动：拒绝已存在目标（不覆盖）；父目录必须存在且在工作区内。
 * - 删除：必须显式 confirm:true；工作区根不可删；非空目录必须 recursive:true。
 */
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { sha256 } from '@core/util'
import { inspectWorkspacePath, isPathInsideWorkspace, normalizeWorkspace } from '@core/tools/paths'
import { TEXT_PREVIEW_MAX_BYTES } from '../../shared/file-types'
import { formatBytes } from '../../shared/format'
import { isProbablyBinary } from './file-probe'

export const MAX_READ_BYTES = TEXT_PREVIEW_MAX_BYTES
export const MAX_WRITE_BYTES = 8 * 1024 * 1024
export const MAX_LIST_ENTRIES = 2000

export type WorkspaceEntryKind = 'file' | 'dir' | 'symlink'

export interface WorkspaceFileEntry {
  name: string
  /** 工作区相对路径（posix 分隔） */
  path: string
  kind: WorkspaceEntryKind
  size: number
  mtimeMs: number
  isSymlink: boolean
  /** symlink 解析后超出工作区 / 无法解析：UI 不允许展开与操作 */
  restricted?: boolean
}

export class WorkspaceFileError extends Error {
  code: string
  hint?: string
  mtimeMs?: number

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = 'WorkspaceFileError'
    this.code = code
    if (hint) this.hint = hint
  }
}

/* ── 路径工具 ─────────────────────────────────────────────────── */

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

/** 工作区相对路径；根目录返回 '' */
export function toWorkspaceRelative(workspace: string, absolute: string): string {
  const rel = relative(normalizeWorkspace(workspace), absolute)
  if (!rel) return ''
  return toPosix(rel)
}

function requireWorkspace(workspace: string): string {
  const raw = typeof workspace === 'string' ? workspace.trim() : ''
  if (!raw) throw new WorkspaceFileError('NO_WORKSPACE', '还没有选择工作文件夹，不能操作文件。', '请先选择一个工作文件夹。')
  return normalizeWorkspace(raw)
}

function resolveInside(workspace: string, inputPath: string): ReturnType<typeof inspectWorkspacePath> {
  const ws = requireWorkspace(workspace)
  let resolved
  try {
    resolved = inspectWorkspacePath(inputPath, ws)
  } catch (err) {
    throw new WorkspaceFileError('INVALID_PATH', err instanceof Error ? err.message : '路径不合法。')
  }
  if (!resolved.inside) {
    throw new WorkspaceFileError(
      'OUTSIDE_WORKSPACE',
      '这个路径在工作区之外，已被拦下。',
      'Morrow 只能操作你选择的工作文件夹里的文件。'
    )
  }
  return resolved
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFileLike(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile()
  } catch {
    return false
  }
}

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function entryFor(resolvedAbsolute: string, workspaceReal: string): WorkspaceFileEntry {
  const first = lstatSafe(resolvedAbsolute)
  if (!first) throw new WorkspaceFileError('NOT_FOUND', '这个文件或文件夹已经不存在了。', '可以刷新文件树后重试。')
  const isSymlink = first.isSymbolicLink()
  const target = isSymlink ? statSyncSafe(resolvedAbsolute) : first
  const shape = target ?? first
  let restricted = false
  if (isSymlink) {
    try {
      const probe = inspectWorkspacePath(resolvedAbsolute, workspaceReal)
      restricted = !probe.inside || !probe.exists
    } catch {
      restricted = true
    }
  }
  const kind: WorkspaceEntryKind = isSymlink ? 'symlink' : first.isDirectory() ? 'dir' : 'file'
  return {
    name: basename(resolvedAbsolute),
    path: toWorkspaceRelative(workspaceReal, resolvedAbsolute),
    kind,
    size: shape.isDirectory() ? 0 : shape.size,
    mtimeMs: shape.mtimeMs,
    isSymlink,
    ...(restricted ? { restricted: true } : {})
  }
}

function statSyncSafe(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** 在工作区内查找某个路径所属的工作区（供编辑器只传 {path} 时回退使用） */
export function findWorkspaceContaining(inputPath: string, candidates: string[]): string | null {
  const raw = (inputPath ?? '').trim()
  if (!raw) return null
  for (const candidate of candidates) {
    const ws = normalizeWorkspace(candidate)
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(ws, raw)
    if (isPathInsideWorkspace(absolute, ws)) return ws
  }
  return null
}

/* ── list ─────────────────────────────────────────────────────── */

export interface ListWorkspaceInput {
  dir?: string
  showHidden?: boolean
  limit?: number
}

export function listWorkspaceEntries(workspace: string, options: ListWorkspaceInput = {}): {
  workspace: string
  dir: string
  entries: WorkspaceFileEntry[]
  limited: boolean
} {
  const ws = requireWorkspace(workspace)
  const requested = options.dir && options.dir.trim() ? options.dir.trim() : '.'
  const resolved = resolveInside(ws, requested)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '这个文件夹已经不存在了。', '刷新文件树后重试。')
  if (!resolved.isDirectory) throw new WorkspaceFileError('NOT_A_DIR', '这不是一个文件夹。')
  const showHidden = options.showHidden === true
  const limit = Math.max(1, Math.min(MAX_LIST_ENTRIES, options.limit ?? MAX_LIST_ENTRIES))
  let names: string[]
  try {
    names = readdirSync(resolved.absolute)
  } catch (err) {
    throw new WorkspaceFileError('LIST_FAILED', `读取文件夹失败：${err instanceof Error ? err.message : String(err)}`)
  }
  const entries: WorkspaceFileEntry[] = []
  let limited = false
  for (const name of names) {
    if (entries.length >= limit) {
      limited = true
      break
    }
    if (!showHidden && name.startsWith('.')) continue
    const full = join(resolved.absolute, name)
    try {
      entries.push(entryFor(full, ws))
    } catch {
      // 单个坏链接/权限问题不影响整棵树
      const info = lstatSafe(full)
      if (!info) continue
      entries.push({
        name,
        path: toWorkspaceRelative(ws, full),
        kind: info.isDirectory() ? 'dir' : 'file',
        size: info.isDirectory() ? 0 : info.size,
        mtimeMs: info.mtimeMs,
        isSymlink: false,
        restricted: true
      })
    }
  }
  entries.sort((a, b) => {
    const aIsDir = a.kind !== 'file'
    const bIsDir = b.kind !== 'file'
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })
  return { workspace: ws, dir: toWorkspaceRelative(ws, resolved.absolute), entries, limited }
}

/* ── read ─────────────────────────────────────────────────────── */

export interface ReadWorkspaceResult {
  path: string
  absolutePath: string
  content: string
  size: number
  mtimeMs: number
  encoding: 'utf8'
  truncated: boolean
}

export function readWorkspaceFile(
  workspace: string,
  inputPath: string,
  options: { maxBytes?: number } = {}
): ReadWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '这个文件已经不存在了。', '可以刷新文件树后重试。')
  if (resolved.isDirectory) throw new WorkspaceFileError('NOT_A_FILE', '这是一个文件夹，不能作为文本文件打开。')
  const stat = statSync(resolved.absolute)
  const maxBytes = Math.max(1024, Math.min(MAX_READ_BYTES, options.maxBytes ?? MAX_READ_BYTES))
  const truncated = stat.size > maxBytes
  let buffer: Buffer
  try {
    if (!truncated) {
      buffer = readFileSync(resolved.absolute)
    } else {
      const fd = openSync(resolved.absolute, 'r')
      try {
        const prefix = Buffer.alloc(maxBytes)
        let offset = 0
        while (offset < maxBytes) {
          const read = readSync(fd, prefix, offset, maxBytes - offset, offset)
          if (read <= 0) break
          offset += read
        }
        buffer = prefix.subarray(0, offset)
      } finally {
        closeSync(fd)
      }
    }
  } catch (err) {
    throw new WorkspaceFileError('READ_FAILED', `读取文件失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (isProbablyBinary(buffer)) {
    throw new WorkspaceFileError(
      'BINARY',
      '这是一个二进制文件，编辑器不能以文本方式打开。',
      '图片/文档等二进制文件可以交给 Morrow 预览，但不能直接编辑源码。'
    )
  }
  return {
    path: toWorkspaceRelative(ws, resolved.absolute),
    absolutePath: resolved.absolute,
    content: buffer.toString('utf8'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    encoding: 'utf8',
    truncated
  }
}

/* ── stat ─────────────────────────────────────────────────────── */

export interface WorkspaceFileStat {
  path: string
  absolutePath: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
}

export function statWorkspaceFile(workspace: string, inputPath: string): WorkspaceFileStat {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '文件或文件夹已经不存在了。')
  const stat = statSync(resolved.absolute)
  return {
    path: toWorkspaceRelative(ws, resolved.absolute),
    absolutePath: resolved.absolute,
    kind: stat.isDirectory() ? 'dir' : 'file',
    size: stat.isDirectory() ? 0 : stat.size,
    mtimeMs: stat.mtimeMs
  }
}

/* ── 快照 + 原子写 ───────────────────────────────────────────── */

export interface SnapshotRecord {
  snapshotPath: string
  targetPath: string
  beforeHash: string | null
  afterHash: string
  at: number
  source: string
}

function snapshotPathFor(snapshotRoot: string, target: string, stamp: string): string {
  const date = new Date()
  const folder = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const safeName = basename(target).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 80) || 'file'
  return join(snapshotRoot, 'files', folder, `${stamp}-${randomBytes(3).toString('hex')}-${safeName}`)
}

function takeSnapshot(input: {
  snapshotRoot: string
  target: string
  afterHash: string
  source: string
}): SnapshotRecord | null {
  const before = statSyncSafe(input.target)
  if (!before || before.isDirectory()) return null
  const stamp = `${Date.now()}`
  const snapshotPath = snapshotPathFor(input.snapshotRoot, input.target, stamp)
  try {
    const data = readFileSync(input.target)
    mkdirSync(dirname(snapshotPath), { recursive: true })
    writeFileSync(snapshotPath, data)
    const beforeHash = sha256(data)
    const record: SnapshotRecord = {
      snapshotPath,
      targetPath: input.target,
      beforeHash,
      afterHash: input.afterHash,
      at: Date.now(),
      source: input.source
    }
    writeFileSync(
      join(dirname(snapshotPath), `${stamp}-${randomBytes(2).toString('hex')}.restore.json`),
      JSON.stringify({ ...record, version: 1 }, null, 2),
      'utf8'
    )
    return record
  } catch {
    return null
  }
}

export interface WriteWorkspaceResult {
  path: string
  absolutePath: string
  size: number
  mtimeMs: number
  created: boolean
  snapshot?: string
}

export function writeWorkspaceFile(
  workspace: string,
  inputPath: string,
  content: string,
  options: { snapshotRoot: string; expectedMtimeMs?: number | null; source?: string; maxBytes?: number }
): WriteWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  if (resolved.exists && resolved.isDirectory) {
    throw new WorkspaceFileError('NOT_A_FILE', '这是一个文件夹，不能写入文本。')
  }
  const maxBytes = Math.max(1024, Math.min(MAX_WRITE_BYTES, options.maxBytes ?? MAX_WRITE_BYTES))
  const buffer = Buffer.from(typeof content === 'string' ? content : '', 'utf8')
  if (buffer.length > maxBytes) {
    throw new WorkspaceFileError('TOO_LARGE', `内容超过 ${formatBytes(maxBytes)}，已取消保存。`)
  }
  const existed = resolved.exists
  const before = existed ? statSyncSafe(resolved.absolute) : null
  if (options.expectedMtimeMs !== undefined && options.expectedMtimeMs !== null) {
    if (!before) {
      throw conflictError(null)
    }
    if (Math.abs(before.mtimeMs - options.expectedMtimeMs) > 1) {
      throw conflictError(before.mtimeMs)
    }
  }
  const target = resolved.absolute
  const dir = dirname(target)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new WorkspaceFileError('WRITE_FAILED', `创建上级文件夹失败：${err instanceof Error ? err.message : String(err)}`)
  }
  // 双重校验：目录创建之后再 realpath 一次，防止中途被替换成指向外部的链接
  const recheck = resolveInside(ws, target)
  if (!recheck.inside) {
    throw new WorkspaceFileError('OUTSIDE_WORKSPACE', '写入目标落在工作区之外，已取消保存。')
  }
  const afterHash = sha256(buffer)
  const snapshot =
    existed && before && !before.isDirectory()
      ? takeSnapshot({
          snapshotRoot: options.snapshotRoot,
          target,
          afterHash,
          source: options.source ?? 'files-ui'
        })
      : null
  const temp = join(dir, `.morrow-tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(temp, buffer, { encoding: 'utf8' })
    renameWithRetry(temp, target)
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // ignore
    }
    throw new WorkspaceFileError('WRITE_FAILED', `保存失败：${err instanceof Error ? err.message : String(err)}`)
  }
  const after = statSync(target)
  return {
    path: toWorkspaceRelative(ws, target),
    absolutePath: target,
    size: after.size,
    mtimeMs: after.mtimeMs,
    created: !existed,
    ...(snapshot ? { snapshot: snapshot.snapshotPath } : {})
  }
}

/** Windows 上杀毒/索引服务可能短暂占用目标文件，rename 会报 EPERM/EBUSY。 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      if (attempt === 3) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
}

function conflictError(currentMtimeMs: number | null): WorkspaceFileError {  const error = new WorkspaceFileError(
    'MTIME_CONFLICT',
    '文件在编辑器打开后被外部修改了，已停止保存。请重新加载文件后再试。',
    '如果确认要用当前内容覆盖，请先重新加载文件，再保存一次。'
  )
  if (currentMtimeMs !== null) error.mtimeMs = currentMtimeMs
  return error
}

/* ── create / rename / move / delete ─────────────────────────── */

export function createWorkspaceEntry(
  workspace: string,
  inputPath: string,
  kind: 'file' | 'dir'
): WorkspaceFileEntry {
  const ws = requireWorkspace(workspace)
  const raw = (inputPath ?? '').trim()
  if (!raw || raw === '.' || raw === './') {
    throw new WorkspaceFileError('INVALID_PATH', '请给新文件或文件夹起一个名字。')
  }
  const resolved = resolveInside(ws, raw)
  if (resolved.exists) {
    throw new WorkspaceFileError('EXISTS', `「${basename(resolved.absolute)}」已经存在了，换一个名字。`)
  }
  const parent = dirname(resolved.absolute)
  if (!isDirectoryPath(parent)) {
    throw new WorkspaceFileError('PARENT_MISSING', '上级文件夹不存在，请先创建上级文件夹。')
  }
  if (kind === 'dir') {
    try {
      mkdirSync(resolved.absolute)
    } catch (err) {
      throw new WorkspaceFileError('CREATE_FAILED', `创建文件夹失败：${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    const temp = join(parent, `.morrow-tmp-${process.pid}-${randomBytes(3).toString('hex')}`)
    try {
      writeFileSync(temp, '', 'utf8')
      renameWithRetry(temp, resolved.absolute)
    } catch (err) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // ignore
      }
      throw new WorkspaceFileError('CREATE_FAILED', `创建文件失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return entryFor(resolved.absolute, ws)
}

export interface RenameWorkspaceResult {
  from: string
  to: string
  kind: 'file' | 'dir'
}

export function renameWorkspaceEntry(workspace: string, fromPath: string, toPath: string): RenameWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const from = resolveInside(ws, fromPath)
  const to = resolveInside(ws, toPath)
  if (!from.exists) throw new WorkspaceFileError('NOT_FOUND', '要重命名的文件或文件夹已经不存在了。')
  if (from.absolute === ws) throw new WorkspaceFileError('INVALID_PATH', '不能重命名工作区根目录。')
  if (to.exists) throw new WorkspaceFileError('EXISTS', '目标名称已经存在，未覆盖任何文件。')
  const parent = dirname(to.absolute)
  if (!isDirectoryPath(parent)) throw new WorkspaceFileError('PARENT_MISSING', '目标位置的上级文件夹不存在。')
  const isDir = from.isDirectory
  try {
    renameWithRetry(from.absolute, to.absolute)
  } catch (err) {
    throw new WorkspaceFileError('RENAME_FAILED', `重命名失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return { from: toWorkspaceRelative(ws, from.absolute), to: toWorkspaceRelative(ws, to.absolute), kind: isDir ? 'dir' : 'file' }
}

export function moveWorkspaceEntry(workspace: string, fromPath: string, toDirPath: string): RenameWorkspaceResult {
  const ws = requireWorkspace(workspace)
  const from = resolveInside(ws, fromPath)
  const dirInput = toDirPath && toDirPath.trim() ? toDirPath.trim() : '.'
  const toDir = resolveInside(ws, dirInput)
  if (!from.exists) throw new WorkspaceFileError('NOT_FOUND', '要移动的文件或文件夹已经不存在了。')
  if (!toDir.exists || !toDir.isDirectory) throw new WorkspaceFileError('NOT_A_DIR', '目标位置不是文件夹。')
  if (from.absolute === ws) throw new WorkspaceFileError('INVALID_PATH', '不能移动工作区根目录。')
  const target = join(toDir.absolute, basename(from.absolute))
  if (isPathInsideWorkspace(target, from.absolute)) {
    throw new WorkspaceFileError('INVALID_PATH', '不能把文件夹移动到它自己的子目录里。')
  }
  return renameWorkspaceEntry(ws, from.absolute, target)
}

export interface DeleteWorkspaceOptions {
  recursive?: boolean
  confirm?: boolean
}

export function deleteWorkspaceEntry(
  workspace: string,
  inputPath: string,
  options: DeleteWorkspaceOptions = {}
): { deleted: true; path: string; kind: 'file' | 'dir' } {
  const ws = requireWorkspace(workspace)
  const raw = (inputPath ?? '').trim()
  if (!raw || raw === '.' || raw === './') {
    throw new WorkspaceFileError('INVALID_PATH', '不能删除工作区根目录。')
  }
  if (options.confirm !== true) {
    throw new WorkspaceFileError('CONFIRM_REQUIRED', '删除文件需要二次确认。', '这是一个破坏性操作，请在确认后再调用。')
  }
  const resolved = resolveInside(ws, raw)
  if (!resolved.exists) throw new WorkspaceFileError('NOT_FOUND', '要删除的文件或文件夹已经不存在了。')
  const info = lstatSafe(resolved.absolute)
  const isDir = Boolean(info?.isDirectory())
  if (isDir && options.recursive !== true) {
    const children = readdirSync(resolved.absolute)
    if (children.length > 0) {
      throw new WorkspaceFileError(
        'DIR_NOT_EMPTY',
        `文件夹里还有 ${children.length} 项内容，确认后再递归删除。`,
        '请确认删除文件夹及其全部内容。'
      )
    }
  }
  try {
    rmSync(resolved.absolute, { recursive: isDir && options.recursive === true, force: false, maxRetries: 2, retryDelay: 40 })
  } catch (err) {
    throw new WorkspaceFileError('DELETE_FAILED', `删除失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return { deleted: true, path: toWorkspaceRelative(ws, resolved.absolute), kind: isDir ? 'dir' : 'file' }
}

/** 删除前预览（UI 二次确认展示内容数量） */
export function inspectWorkspaceEntry(workspace: string, inputPath: string): WorkspaceFileEntry & { childCount?: number } {
  const ws = requireWorkspace(workspace)
  const resolved = resolveInside(ws, inputPath)
  const entry = entryFor(resolved.absolute, ws)
  if (entry.kind === 'dir') {
    try {
      return { ...entry, childCount: readdirSync(resolved.absolute).length }
    } catch {
      return entry
    }
  }
  return entry
}
