/**
 * 编辑器与主进程的桥：文件读写（feature:files:*，A 队友实现）与版本历史（feature:history:*）。
 *
 * 契约（与 shell/Lead 对齐）：
 * - read  { workspace, path(相对), maxBytes? } → { path, content, size, mtimeMs, binary, truncated, encoding, readOnly? }
 * - write { workspace, path(相对), content, expectedMtimeMs? } → { path, size, mtimeMs, snapshot?, created }
 * - stat  { workspace, path } → { path, size, mtimeMs, kind }
 * - create{ workspace, path, kind:'file'|'dir' } → FileEntry
 * 所有 invoke 返回 Result<T>；错误抛出 EditorApiError（code FEATURE_ERROR，message 为中文可读原因）。
 */
import type { Result } from '@shared/types'

export interface ReadFileResult {
  path: string
  content: string
  size: number
  mtimeMs: number
  binary: boolean
  truncated: boolean
  encoding: string
  readOnly?: boolean
}

export interface WriteFileResult {
  path: string
  size: number
  mtimeMs: number
  snapshot?: string
  created: boolean
}

export interface StatFileResult {
  path: string
  size: number
  mtimeMs: number
  kind: string
}

export interface FileEntryResult {
  name: string
  path: string
  kind: 'file' | 'dir' | 'symlink'
  size: number
  mtimeMs: number
}

export type HistorySource = 'user' | 'agent' | 'baseline' | 'restore'

export interface HistoryVersion {
  id: string
  path: string
  name: string
  createdAt: number
  source: HistorySource
  size: number
  contentHash: string
  mtimeMs?: number
  label?: string
}

export interface HistoryListResult {
  path: string
  versions: HistoryVersion[]
}

export interface HistoryDiffResult {
  patch: string
  added: number
  removed: number
  truncated: boolean
  version: HistoryVersion
  targetLabel: string
}

export interface HistoryRestoreResult {
  path: string
  versionId: string
  mtimeMs: number
  size: number
  newVersionId: string | null
}

export class EditorApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'EditorApiError'
    this.code = code
  }
}

type FeatureTestHook = (channel: string, payload: unknown) => Promise<Result<unknown>> | undefined

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  if (!window.morrow?.features?.invoke) {
    throw new EditorApiError('FEATURE_UNAVAILABLE', '当前版本缺少扩展接口，无法读写文件。')
  }
  // 仅测试模式：允许 E2E/截图注入 feature 桩（生产环境不存在该字段）
  const hook = (window as unknown as { __morrowFeatureTestHooks?: FeatureTestHook }).__morrowFeatureTestHooks
  if (window.morrow.isTest && typeof hook === 'function') {
    const hooked = hook(channel, payload)
    if (hooked) {
      const result = (await hooked) as Result<T>
      if (!result.ok) throw new EditorApiError(result.error?.code ?? 'FEATURE_ERROR', result.error?.message ?? '操作失败')
      return result.data
    }
  }
  const result = (await window.morrow.features.invoke(channel, payload)) as Result<T>
  if (!result || typeof result !== 'object') {
    throw new EditorApiError('FEATURE_BAD_RESPONSE', '文件服务返回了无法识别的结果。')
  }
  if (!result.ok) throw new EditorApiError(result.error?.code ?? 'FEATURE_ERROR', result.error?.message ?? '操作失败')
  return result.data
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 是否是 mtime 冲突类错误（主进程用中文错误文案提示重新加载） */
export function isConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /外部修改|已被修改|冲突|已停止保存/.test(error.message)
}

/** 是否处于只读模式（session 优先级高于全局设置） */
export function isReadOnlyMode(permissionMode: string | null | undefined): boolean {
  return permissionMode === 'read-only'
}

export async function readFile(
  workspace: string,
  path: string,
  maxBytes = 2 * 1024 * 1024
): Promise<ReadFileResult> {
  const data = await invoke<Record<string, unknown>>('feature:files:read', { workspace, path, maxBytes })
  return {
    path: typeof data.path === 'string' ? data.path : path,
    content: typeof data.content === 'string' ? data.content : '',
    size: toNumber(data.size),
    mtimeMs: toNumber((data.mtimeMs ?? data.mtime) as unknown),
    binary: data.binary === true,
    truncated: data.truncated === true,
    encoding: typeof data.encoding === 'string' ? data.encoding : 'utf8',
    readOnly: data.readOnly === true
  }
}

export async function writeFile(
  workspace: string,
  path: string,
  content: string,
  expectedMtimeMs?: number | null
): Promise<WriteFileResult> {
  const payload: Record<string, unknown> = { workspace, path, content }
  if (typeof expectedMtimeMs === 'number') payload.expectedMtimeMs = expectedMtimeMs
  const data = await invoke<Record<string, unknown>>('feature:files:write', payload)
  return {
    path: typeof data.path === 'string' ? data.path : path,
    size: toNumber(data.size, content.length),
    mtimeMs: toNumber((data.mtimeMs ?? data.mtime) as unknown, Date.now()),
    snapshot: typeof data.snapshot === 'string' ? data.snapshot : undefined,
    created: data.created === true
  }
}

export async function statFile(workspace: string, path: string): Promise<StatFileResult> {
  const data = await invoke<Record<string, unknown>>('feature:files:stat', { workspace, path })
  return {
    path: typeof data.path === 'string' ? data.path : path,
    size: toNumber(data.size),
    mtimeMs: toNumber((data.mtimeMs ?? data.mtime) as unknown),
    kind: typeof data.kind === 'string' ? data.kind : 'file'
  }
}

export async function createFile(workspace: string, path: string, kind: 'file' | 'dir' = 'file'): Promise<FileEntryResult> {
  const data = await invoke<Record<string, unknown>>('feature:files:create', { workspace, path, kind })
  return {
    name: typeof data.name === 'string' ? data.name : path,
    path: typeof data.path === 'string' ? data.path : path,
    kind: (data.kind as FileEntryResult['kind']) ?? 'file',
    size: toNumber(data.size),
    mtimeMs: toNumber((data.mtimeMs ?? data.mtime) as unknown)
  }
}

/* ── 版本历史 ─────────────────────────────────────────────────── */

export async function recordHistory(input: {
  path: string
  content: string
  source: HistorySource
  mtimeMs?: number
  label?: string
  force?: boolean
}): Promise<HistoryVersion | null> {
  return invoke<HistoryVersion | null>('feature:history:record', input)
}

export async function listHistory(path: string): Promise<HistoryListResult> {
  return invoke<HistoryListResult>('feature:history:list', { path })
}

export async function readHistoryVersion(path: string, versionId: string): Promise<{ version: HistoryVersion; content: string }> {
  return invoke('feature:history:read', { path, versionId })
}

export async function diffHistory(path: string, versionId: string, targetContent?: string): Promise<HistoryDiffResult> {
  return invoke<HistoryDiffResult>('feature:history:diff', {
    path,
    versionId,
    ...(typeof targetContent === 'string' ? { targetContent } : {})
  })
}

export async function restoreHistory(
  path: string,
  versionId: string,
  expectedMtimeMs?: number | null
): Promise<HistoryRestoreResult> {
  return invoke<HistoryRestoreResult>('feature:history:restore', {
    path,
    versionId,
    ...(typeof expectedMtimeMs === 'number' ? { expectedMtimeMs } : {})
  })
}

/* ── 路径工具 ─────────────────────────────────────────────────── */

/** 统一成 posix 风格的工作区相对路径（files API 使用） */
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/** 工作区相对 → 绝对（Windows 盘符/分隔符都兼容） */
export function joinWorkspacePath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, '')
  const rel = normalizeRelativePath(relative)
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${rel.replace(/\//g, sep)}`
}

/** 绝对 → 工作区相对；不在工作区内返回 null */
export function relativeToWorkspace(workspace: string | null | undefined, absolutePath: string): string | null {
  if (!workspace) return null
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const base = norm(workspace)
  const target = norm(absolutePath)
  if (target === base) return ''
  if (!target.startsWith(`${base}/`)) return null
  const relative = absolutePath.replace(/\\/g, '/').slice(workspace.replace(/\\/g, '/').replace(/\/+$/, '').length + 1)
  return normalizeRelativePath(relative)
}

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
