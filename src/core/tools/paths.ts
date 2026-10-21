/**
 * 工作区沙箱：所有路径工具的唯一入口。
 *
 * 安全模型：
 * - 绝对化 + realpath（解析 symlink / junction）后必须落在工作区根内；
 * - 目标尚不存在时（写新文件）对最近的存在祖先做 realpath，再拼回剩余路径；
 * - Windows 大小写不敏感，比较时统一小写；
 * - 越界不在这里抛「普通错误」而是 WorkspaceEscapeError，让权限层触发审批。
 */
import { existsSync, lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolInputError, WorkspaceEscapeError } from './errors'

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
