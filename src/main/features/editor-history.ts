/**
 * 版本历史 feature IPC（R10-F）。
 *
 * 频道：
 * - feature:history:record   { path, content, source?, mtimeMs?, label?, force? }
 * - feature:history:list     { path }                     → { path, versions }
 * - feature:history:read     { path, versionId }          → { version, content }
 * - feature:history:diff     { path, versionId, targetContent? } → { patch, added, removed, truncated, version, targetLabel }
 * - feature:history:restore  { path, versionId, expectedMtimeMs? } → { path, versionId, mtimeMs, size, newVersionId }
 * - feature:history:clear    { path }
 *
 * 用法：Lead 在 src/main/features/index.ts 里 `import './editor-history'`（副作用注册）。
 * 安全：所有 path 必须是已登记工作区内（realpath 后）的文件；restore 只写回有历史版本的路径。
 * 约束：不 import electron 之外的重模块；服务本体不依赖 electron，便于单测。
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { dataPath } from '../services/paths'
import { EditorHistoryStore, type HistorySource } from '../services/editor-history'
import { registerFeatureHandler } from '../feature-ipc'
import { isPathInside, knownWorkspaceRoots } from './workspace-roots'

let store: EditorHistoryStore | null = null

function history(): EditorHistoryStore {
  if (!store) store = new EditorHistoryStore(dataPath('editor-history'))
  return store
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('请求参数格式不对，缺少文件路径')
  }
  return payload as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`缺少参数：${field}`)
  return value
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

const SOURCES: HistorySource[] = ['user', 'agent', 'baseline', 'restore']

function normalizeSource(value: unknown): HistorySource {
  return typeof value === 'string' && (SOURCES as string[]).includes(value) ? (value as HistorySource) : 'user'
}

/**
 * 版本历史 IPC 的写盘边界：路径必须落在已登记工作区内（解析 symlink 后判断）。
 * record + restore 组合等价于一次文件写入，不能只做「必须先有历史」的弱校验。
 */
function workspaceOnlyPath(rawPath: string): string {
  const target = resolve(rawPath)
  let real = target
  try {
    real = realpathSync(target)
  } catch {
    try {
      real = join(realpathSync(dirname(target)), basename(target))
    } catch {
      throw new Error('文件所在文件夹不存在或不可访问。')
    }
  }
  const roots = knownWorkspaceRoots().map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return resolve(root)
    }
  })
  if (!roots.some((root) => isPathInside(root, real))) {
    throw new Error('版本历史只允许操作工作区内的文件。')
  }
  return target
}

registerFeatureHandler('feature:history:record', async (payload) => {
  const input = asRecord(payload)
  const filePath = workspaceOnlyPath(requireString(input.path, 'path'))
  const content = typeof input.content === 'string' ? input.content : ''
  return history().record({
    path: filePath,
    content,
    source: normalizeSource(input.source),
    mtimeMs: optionalNumber(input.mtimeMs),
    label: typeof input.label === 'string' ? input.label : undefined,
    force: input.force === true
  })
})

registerFeatureHandler('feature:history:list', async (payload) => {
  const input = asRecord(payload)
  return history().list(workspaceOnlyPath(requireString(input.path, 'path')))
})

registerFeatureHandler('feature:history:read', async (payload) => {
  const input = asRecord(payload)
  const filePath = workspaceOnlyPath(requireString(input.path, 'path'))
  const versionId = requireString(input.versionId, 'versionId')
  const result = history().read(filePath, versionId)
  if (!result) throw new Error('找不到这个历史版本，可能已经被清理')
  return result
})

registerFeatureHandler('feature:history:diff', async (payload) => {
  const input = asRecord(payload)
  const filePath = workspaceOnlyPath(requireString(input.path, 'path'))
  const versionId = requireString(input.versionId, 'versionId')
  const targetContent = typeof input.targetContent === 'string' ? input.targetContent : undefined
  const result = history().diff(filePath, versionId, targetContent)
  if (!result) throw new Error('找不到这个历史版本，可能已经被清理')
  return result
})

registerFeatureHandler('feature:history:restore', async (payload) => {
  const input = asRecord(payload)
  const filePath = workspaceOnlyPath(requireString(input.path, 'path'))
  const versionId = requireString(input.versionId, 'versionId')
  return history().restore(filePath, versionId, { expectedMtimeMs: optionalNumber(input.expectedMtimeMs) })
})

registerFeatureHandler('feature:history:clear', async (payload) => {
  const input = asRecord(payload)
  history().clear(workspaceOnlyPath(requireString(input.path, 'path')))
  return { cleared: true }
})
