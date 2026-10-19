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
 * 约束：不 import electron 之外的重模块；服务本体不依赖 electron，便于单测。
 */
import { dataPath } from '../services/paths'
import { EditorHistoryStore, type HistorySource } from '../services/editor-history'
import { registerFeatureHandler } from '../feature-ipc'

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

registerFeatureHandler('feature:history:record', async (payload) => {
  const input = asRecord(payload)
  const filePath = requireString(input.path, 'path')
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
  return history().list(requireString(input.path, 'path'))
})

registerFeatureHandler('feature:history:read', async (payload) => {
  const input = asRecord(payload)
  const filePath = requireString(input.path, 'path')
  const versionId = requireString(input.versionId, 'versionId')
  const result = history().read(filePath, versionId)
  if (!result) throw new Error('找不到这个历史版本，可能已经被清理')
  return result
})

registerFeatureHandler('feature:history:diff', async (payload) => {
  const input = asRecord(payload)
  const filePath = requireString(input.path, 'path')
  const versionId = requireString(input.versionId, 'versionId')
  const targetContent = typeof input.targetContent === 'string' ? input.targetContent : undefined
  const result = history().diff(filePath, versionId, targetContent)
  if (!result) throw new Error('找不到这个历史版本，可能已经被清理')
  return result
})

registerFeatureHandler('feature:history:restore', async (payload) => {
  const input = asRecord(payload)
  const filePath = requireString(input.path, 'path')
  const versionId = requireString(input.versionId, 'versionId')
  return history().restore(filePath, versionId, { expectedMtimeMs: optionalNumber(input.expectedMtimeMs) })
})

registerFeatureHandler('feature:history:clear', async (payload) => {
  const input = asRecord(payload)
  history().clear(requireString(input.path, 'path'))
  return { cleared: true }
})
