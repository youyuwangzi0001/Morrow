// 工具公共层：类型、参数读取、工作区路径与 diff。工具实现只依赖本文件，避免与注册表循环。
import type { ToolResult } from '../shared/types'
import type { ToolContext, ToolDefinition } from './types'
import type { Stats } from 'node:fs'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'



export interface ToolImpl {
  definition: ToolDefinition
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}


export function okResult(output: string, meta?: Record<string, unknown>, durationMs?: number): ToolResult {
  return { ok: true, output, ...(meta ? { meta } : {}), ...(typeof durationMs === 'number' ? { durationMs } : {}) }
}


export function errResult(error: string, hint?: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: false, output: '', error, ...(hint ? { hint } : {}), ...(meta ? { meta } : {}) }
}


/** 标题/摘要里安全地展示用户输入（压成一行、限长） */
export function oneLineInput(input: Record<string, unknown>, key: string, max = 80): string {
  const raw = input[key]
  const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}


/**
 * 工具层错误类型：区分「用户可自修复的参数错误」与「越界访问」（需要审批）。
 */

/** 参数不合法 / 前置条件不满足：给模型自修复用，hint 是给模型的具体建议 */
export class ToolInputError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ToolInputError'
    this.hint = hint
  }
}


/** 目标路径 realpath 后不在工作区内：交给权限层审批，不直接当普通错误吞掉 */
export class WorkspaceEscapeError extends Error {
  readonly attemptedPath: string
  readonly workspace: string

  constructor(attemptedPath: string, workspace: string) {
    super(`路径超出了工作区范围：${attemptedPath}`)
    this.name = 'WorkspaceEscapeError'
    this.attemptedPath = attemptedPath
    this.workspace = workspace
  }
}


/** 工具内部可预期的失败（例如文件不存在），信息直接回灌给模型 */
export class ToolExecutionError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ToolExecutionError'
    this.hint = hint
  }
}


export function getString(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; defaultValue?: string; trim?: boolean; maxLength?: number } = {}
): string {
  const raw = input[key]
  if (raw === undefined || raw === null) {
    if (opts.required) throw new ToolInputError(`缺少必填参数「${key}」。`, `请补上参数 ${key} 后重试。`)
    return opts.defaultValue ?? ''
  }
  if (typeof raw !== 'string') {
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    throw new ToolInputError(`参数「${key}」应该是字符串。`, `请以字符串形式提供 ${key}。`)
  }
  let value = opts.trim === false ? raw : raw.trim()
  const maxLength = opts.maxLength
  if (maxLength && value.length > maxLength) {
    throw new ToolInputError(`参数「${key}」过长（${value.length} 字符，上限 ${maxLength}）。`, '请缩短后重试，或拆分成多次调用。')
  }
  if (!value && opts.required) {
    throw new ToolInputError(`参数「${key}」不能为空。`, `请补上参数 ${key} 后重试。`)
  }
  return value
}


export function getNumber(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; defaultValue?: number; min?: number; max?: number } = {}
): number {
  const raw = input[key]
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw new ToolInputError(`缺少必填参数「${key}」。`, `请补上数字参数 ${key}。`)
    return opts.defaultValue ?? 0
  }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`参数「${key}」应该是数字。`, `请以数字形式提供 ${key}。`)
  }
  const min = opts.min ?? Number.NEGATIVE_INFINITY
  const max = opts.max ?? Number.POSITIVE_INFINITY
  if (value < min || value > max) {
    throw new ToolInputError(`参数「${key}」超出范围（${value}，允许 ${min}~${max}）。`, '请调整后重试。')
  }
  return value
}


export function getBoolean(input: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const raw = input[key]
  if (raw === undefined || raw === null) return defaultValue
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', '是'].includes(lower)) return true
    if (['false', '0', 'no', 'n', '否'].includes(lower)) return false
  }
  if (typeof raw === 'number') return raw !== 0
  return defaultValue
}


/** 字符串数组（用于 options/todos 等）；也接受 [{label}] / [{text}] 这类对象数组 */
export function getStringArray(
  input: Record<string, unknown>,
  key: string,
  opts: { maxItems?: number } = {}
): string[] {
  const raw = input[key]
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ToolInputError(`参数「${key}」应该是数组。`, `请提供字符串数组，例如 ${key}: ["a", "b"]。`)
  }
  const max = opts.maxItems ?? 100
  if (raw.length > max) {
    throw new ToolInputError(`参数「${key}」元素过多（${raw.length}，上限 ${max}）。`, '请减少数量后重试。')
  }
  return raw.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const value = obj.label ?? obj.text ?? obj.value ?? obj.name
      if (typeof value === 'string') return value
    }
    return String(item)
  })
}


/** 对象数组，过滤掉非对象项 */
export function getObjectArray(input: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const raw = input[key]
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ToolInputError(`参数「${key}」应该是数组。`, `请提供对象数组后重试。`)
  }
  return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}


export interface ResolvedPath {
  /** 用户/模型给出的路径解析出的绝对路径（未 realpath） */
  absolute: string
  /** realpath 后的路径（新建文件时为「存在祖先的 realpath + 剩余段」） */
  real: string
  /** 是否在工作区内（2026-10 R7 审计修复：以 realpath 为唯一依据，链接不可解析时按越界处理） */
  inside: boolean
  exists: boolean
  isDirectory: boolean
  /** 路径是悬空链接 / 无法解析的目录联接（保守视为越界） */
  linkUnresolvable?: boolean
}


export function normalizeWorkspace(workspace: string): string {
  const absolute = resolve(workspace)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}


export function isPathInsideWorkspace(target: string, workspaceReal: string): boolean {
  const ws = workspaceReal.replace(/[\\/]+$/, '')
  const lower = process.platform === 'win32' ? (value: string): string => value.toLowerCase() : (value: string): string => value
  const t = lower(target.replace(/[\\/]+$/, ''))
  const w = lower(ws)
  return t === w || t.startsWith(`${w}${sep}`)
}


function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}


/**
 * 解析并检查路径，不抛越界错误（权限层用它判断是否需要审批）。
 * 会在未绑定工作区 / 路径非法时抛 ToolInputError。
 */
export function inspectWorkspacePath(inputPath: string, workspace: string | null): ResolvedPath {
  if (!workspace) {
    throw new ToolInputError(
      '当前会话还没有绑定工作文件夹，不能操作文件。',
      '请让用户在输入框附近选择一个工作文件夹，再重新执行这个操作。'
    )
  }
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  if (!raw) throw new ToolInputError('路径不能为空。', '请提供相对工作区的路径，例如 "data/report.csv"。')
  if (raw.includes('\0')) throw new ToolInputError('路径包含非法字符。', '请检查路径后重试。')
  const wsReal = normalizeWorkspace(workspace)
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(wsReal, raw)

  // 找到最近的存在祖先做 realpath，再拼回不存在的尾巴。
  // 注意用 lstat 判断「词法上是否存在」：悬空符号链接 existsSync=false 但确实存在，
  // 若沿父目录拼回去会漏掉链接本身，进而把「链接指向库外」误判为库内。
  let probe = absolute
  const tail: string[] = []
  for (let i = 0; i < 64; i += 1) {
    if (lstatSafe(probe) !== null) break
    const parent = dirname(probe)
    if (parent === probe) break
    tail.unshift(basename(probe))
    probe = parent
  }
  const probeStat = lstatSafe(probe)
  const probeReal = realpathOrNull(probe)
  if (probeReal === null && probeStat !== null && probeStat.isSymbolicLink()) {
    // 悬空链接 / 不可解析的目录联接：无法证明目标在工作区内 → 保守按越界处理
    return { absolute, real: absolute, inside: false, exists: false, isDirectory: false, linkUnresolvable: true }
  }
  const realBase = probeReal ?? probe
  const real = tail.length > 0 ? join(realBase, ...tail) : realBase
  const stat = statSafe(absolute)
  return {
    absolute,
    real,
    // R7 审计修复：只以 realpath 结果判断是否在库内。
    // 旧实现是 `realInside || absoluteInside`，工作区内指向库外的符号链接/目录联接会被误放行。
    inside: isPathInsideWorkspace(real, wsReal),
    exists: stat !== null,
    isDirectory: stat?.isDirectory() ?? false
  }
}


function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}


function statSafe(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}


/** 附件路径比较：绝对路径与 realpath 任一匹配即视为同一文件（Windows 忽略大小写）。 */
export function isExplicitlyAttachedPath(
  resolved: Pick<ResolvedPath, 'absolute' | 'real'>,
  allowedFiles: readonly string[] | undefined
): boolean {
  if (!allowedFiles || allowedFiles.length === 0) return false
  const canonical = (value: string): string => {
    const absolute = resolve(value)
    try {
      return realpathSync.native(absolute)
    } catch {
      return absolute
    }
  }
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const candidates = new Set([fold(canonical(resolved.absolute)), fold(canonical(resolved.real))])
  return allowedFiles.some((file) => candidates.has(fold(canonical(file))))
}


/** 无工作区时解析消息里显式附加的文件：只允许完整路径，且必须命中附件白名单。 */
function inspectAttachedFilePath(inputPath: string, allowedFiles: readonly string[] | undefined): ResolvedPath {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : ''
  if (!raw) throw new ToolInputError('路径不能为空。', '请使用附件信息里的完整路径。')
  if (raw.includes('\0')) throw new ToolInputError('路径包含非法字符。', '请检查路径后重试。')
  if (!isAbsolute(raw)) {
    throw new ToolInputError('当前对话没有工作文件夹，只能读取消息里显式附加的文件。', '请使用附件信息里的完整路径。')
  }
  const absolute = resolve(raw)
  const stat = statSafe(absolute)
  const real = realpathOrNull(absolute) ?? absolute
  const resolved: ResolvedPath = {
    absolute,
    real,
    inside: false,
    exists: stat !== null,
    isDirectory: stat?.isDirectory() ?? false
  }
  if (!isExplicitlyAttachedPath(resolved, allowedFiles)) {
    throw new ToolInputError('这个文件不在本条消息的附件里，不能读取。', '请先在输入框附加该文件，再让我读取。')
  }
  return resolved
}


/** 工具内部使用：越界且未获审批 → 抛 WorkspaceEscapeError（由 registry/agent 转成错误结果） */
export function resolveWorkspacePath(
  inputPath: string,
  workspace: string | null,
  opts: {
    escapeApproved?: boolean
    requireExist?: boolean
    requireDirectory?: boolean
    /** 用户在本会话用户消息里显式附加的文件；只给只读工具使用 */
    allowedExternalFiles?: readonly string[]
  } = {}
): ResolvedPath {
  const resolved = workspace
    ? inspectWorkspacePath(inputPath, workspace)
    : inspectAttachedFilePath(inputPath, opts.allowedExternalFiles)
  if (!workspace) {
    if (opts.requireExist && !resolved.exists) {
      throw new ToolInputError(`附件不存在或已被移动：${resolved.absolute}`, '请重新附加这个文件后再试。')
    }
    if (opts.requireDirectory && (!resolved.exists || !resolved.isDirectory)) {
      throw new ToolInputError(`目录不存在：${resolved.absolute}`, '只能读取消息里显式附加的文件。')
    }
    return resolved
  }
  const attached = !resolved.inside && isExplicitlyAttachedPath(resolved, opts.allowedExternalFiles)
  if (!resolved.inside && !opts.escapeApproved && !attached) {
    throw new WorkspaceEscapeError(resolved.absolute, normalizeWorkspace(workspace as string))
  }
  if (opts.requireExist && !resolved.exists) {
    throw new ToolInputError(`路径不存在：${resolved.absolute}`, '可以先用 list_dir 查看当前目录结构，确认文件名。')
  }
  if (opts.requireDirectory && (!resolved.exists || !resolved.isDirectory)) {
    throw new ToolInputError(`目录不存在：${resolved.absolute}`, '可以先用 list_dir 查看当前目录结构，确认目录名。')
  }
  return resolved
}


/** 展示给用户/模型的相对路径（工作区外则返回绝对路径） */
export function displayPath(absolute: string, workspace: string | null): string {
  if (!workspace) return absolute
  const rel = relative(normalizeWorkspace(workspace), absolute)
  if (!rel || rel.startsWith('..')) return absolute
  return rel.split(sep).join('/')
}


export function getWorkspaceOrThrow(workspace: string | null): string {
  if (!workspace) {
    throw new ToolInputError(
      '当前会话还没有绑定工作文件夹，不能执行这个操作。',
      '请让用户先选择一个工作文件夹。'
    )
  }
  return normalizeWorkspace(workspace)
}
// 行级 diff（不引入第三方依赖）。
export interface DiffResult {
  patch: string
  added: number
  removed: number
  /** 文件过大/差异过多被省略 */
  truncated: boolean
}


const MAX_LINES_FOR_LCS = 1200

const MAX_PATCH_LINES = 1000


function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}


function summarize(before: string[], after: string[]): DiffResult {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1)
    return map
  }
  const oldCount = count(before)
  const newCount = count(after)
  let removed = 0
  let added = 0
  for (const [line, countValue] of oldCount) {
    removed += Math.max(0, countValue - (newCount.get(line) ?? 0))
  }
  for (const [line, countValue] of newCount) {
    added += Math.max(0, countValue - (oldCount.get(line) ?? 0))
  }
  return {
    patch: `（内容较大，省略逐行 diff：约 +${added} / -${removed} 行；旧文件 ${before.length} 行 → 新文件 ${after.length} 行）`,
    added,
    removed,
    truncated: true
  }
}


/** 最长公共子序列 → 编辑操作序列 */
function diffOps(a: string[], b: string[]): Array<{ type: 'eq' | 'add' | 'del'; line: string; aIndex: number; bIndex: number }> {
  const n = a.length
  const m = b.length
  const width = m + 1
  // dp[i][j] = LCS(a[i:], b[j:])
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops: Array<{ type: 'eq' | 'add' | 'del'; line: string; aIndex: number; bIndex: number }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i], aIndex: i, bIndex: j })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', line: a[i], aIndex: i, bIndex: j })
      i += 1
    } else {
      ops.push({ type: 'add', line: b[j], aIndex: i, bIndex: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i], aIndex: i, bIndex: j })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j], aIndex: i, bIndex: j })
    j += 1
  }
  return ops
}


function renderPatch(ops: Array<{ type: 'eq' | 'add' | 'del'; line: string; aIndex: number; bIndex: number }>, filePath: string): DiffResult {
  const added = ops.filter((op) => op.type === 'add').length
  const removed = ops.filter((op) => op.type === 'del').length
  if (added === 0 && removed === 0) return { patch: '', added: 0, removed: 0, truncated: false }

  const hunks: string[] = []
  let patchLines = 0
  let truncated = false
  const context = 2
  let index = 0
  while (index < ops.length) {
    if (ops[index].type === 'eq') {
      index += 1
      continue
    }
    const start = Math.max(0, index - context)
    let end = index
    while (end < ops.length) {
      if (ops[end].type !== 'eq') {
        end += 1
        continue
      }
      let lookahead = end
      while (lookahead < ops.length && ops[lookahead].type === 'eq') lookahead += 1
      if (lookahead < ops.length && lookahead - end <= context * 2) {
        end = lookahead
        continue
      }
      break
    }
    const slice = ops.slice(start, Math.min(ops.length, end + context))
    const firstA = slice.find((op) => op.type !== 'add')?.aIndex ?? slice[0]?.aIndex ?? 0
    const firstB = slice.find((op) => op.type !== 'del')?.bIndex ?? slice[0]?.bIndex ?? 0
    const oldCount = slice.filter((op) => op.type !== 'add').length
    const newCount = slice.filter((op) => op.type !== 'del').length
    hunks.push(`--- a/${filePath}`, `+++ b/${filePath}`)
    hunks.push(`@@ -${firstA + 1},${oldCount} +${firstB + 1},${newCount} @@`)
    patchLines += 3
    for (const op of slice) {
      const prefix = op.type === 'eq' ? ' ' : op.type === 'add' ? '+' : '-'
      hunks.push(`${prefix}${op.line}`)
      patchLines += 1
      if (patchLines > MAX_PATCH_LINES) {
        truncated = true
        break
      }
    }
    if (truncated) {
      hunks.push(`…（diff 超过 ${MAX_PATCH_LINES} 行，仅显示前 ${MAX_PATCH_LINES} 行；完整内容可在文件中查看）`)
      break
    }
    index = end
  }
  return { patch: hunks.join('\n'), added, removed, truncated }
}


/**
 * 生成 unified diff 风格文本。
 * @param filePath 展示用路径（放 @@ 头）
 */
export function createUnifiedDiff(before: string, after: string, filePath = 'file'): DiffResult {
  if (before === after) return { patch: '', added: 0, removed: 0, truncated: false }
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  // 只有换行符/行尾格式变化：内容行完全相同，给一个明确说明，不能误报成「内容没有变化」。
  if (
    oldLines.length === newLines.length &&
    oldLines.every((line, index) => line === newLines[index])
  ) {
    return {
      patch: `--- a/${filePath}
+++ b/${filePath}
（仅换行符/行尾格式变化）`,
      added: 0,
      removed: 0,
      truncated: false
    }
  }

  // 大文件先裁掉公共前缀/后缀，再只对变化附近做 LCS；否则长文件会被整段降级成 +0/-0。
  let oldStart = 0
  let newStart = 0
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  if (oldLines.length > MAX_LINES_FOR_LCS || newLines.length > MAX_LINES_FOR_LCS) {
    let prefix = 0
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    ) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1
    }
    const contextLines = 16
    oldStart = Math.max(0, prefix - contextLines)
    newStart = Math.max(0, prefix - contextLines)
    oldEnd = Math.min(oldLines.length, oldLines.length - suffix + contextLines)
    newEnd = Math.min(newLines.length, newLines.length - suffix + contextLines)
    if (oldEnd - oldStart > MAX_LINES_FOR_LCS || newEnd - newStart > MAX_LINES_FOR_LCS) {
      return summarize(oldLines, newLines)
    }
  }

  const oldSlice = oldLines.slice(oldStart, oldEnd)
  const newSlice = newLines.slice(newStart, newEnd)
  const ops = diffOps(oldSlice, newSlice).map((op) => ({
    ...op,
    aIndex: op.aIndex + oldStart,
    bIndex: op.bIndex + newStart
  }))
  return renderPatch(ops, filePath)
}


/** 给审批卡/工具结果用的一句话统计 */
export function diffSummary(result: DiffResult): string {
  if (!result.patch) return '内容没有变化'
  return `+${result.added} / -${result.removed} 行`
}
