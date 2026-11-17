// memory 功能域逻辑：由 1 个 TS 文件扁平合并。
import type { EpisodeInjection, EpisodeListResult, EpisodeStats, EvolutionApplyResult, EvolutionListResult, EvolutionReviewResult, TaskEpisode } from '@shared/contracts'
import { EVOLUTION_CHANGED_EVENT } from '@shared/contracts'
import type { MemoryEntry, MemoryExportResult, MemoryInjection, MemoryListResult, MemoryScope, MemorySource } from '@shared/feature-types'

export type { EpisodeInjection, EpisodeListResult, EpisodeStats, TaskEpisode }

export type { MemoryImportance } from '@shared/contracts'
export type { MemoryEntry, MemoryExportResult, MemoryInjection, MemoryListResult, MemoryScope, MemorySource, MemoryStats } from '@shared/feature-types'

export interface MemoryListInput {
  scope: MemoryScope
  workspace?: string | null
  query?: string
  includeDisabled?: boolean
}

const CHANNEL_PREFIX = 'feature:memory:'

async function invoke<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.morrow.features.invoke<T>(`${CHANNEL_PREFIX}${action}`, payload)
  if (!result.ok) throw new Error(result.error.message || '记忆操作失败')
  return result.data
}

export const memoryApi = {
  list: (input: MemoryListInput): Promise<MemoryListResult> => invoke('list', input),
  add: (input: { scope: MemoryScope; workspace?: string | null; text: string; tags?: string[] }): Promise<{ entry: MemoryEntry }> =>
    invoke('add', input),
  update: (input: {
    scope: MemoryScope
    workspace?: string | null
    id: string
    text?: string
    tags?: string[]
    enabled?: boolean
    importance?: number
  }): Promise<{ entry: MemoryEntry }> => invoke('update', input),
  toggle: (input: {
    scope: MemoryScope
    workspace?: string | null
    id: string
    enabled?: boolean
  }): Promise<{ entry: MemoryEntry }> => invoke('toggle', input),
  remove: (input: { scope: MemoryScope; workspace?: string | null; id: string }): Promise<{ removed: boolean }> =>
    invoke('remove', input),
  clear: (input: { scope: MemoryScope; workspace?: string | null }): Promise<{ removed: number }> =>
    invoke('clear', input),
  exportMemory: (input: { scope: MemoryScope; workspace?: string | null }): Promise<MemoryExportResult> =>
    invoke('export', input),
  injection: (input: { workspace?: string | null; maxTokens?: number }): Promise<MemoryInjection> =>
    invoke('injection', input),
  listEpisodes: (input: {
    scope: MemoryScope
    workspace?: string | null
    query?: string
    sort?: 'relevance' | 'recent'
    includeDisabled?: boolean
  }): Promise<EpisodeListResult> => invoke('episodes', input),
  updateEpisode: (input: {
    scope: MemoryScope
    workspace?: string | null
    id: string
    importance: number
  }): Promise<{ entry: TaskEpisode }> => invoke('episodeUpdate', input),
  toggleEpisode: (input: {
    scope: MemoryScope
    workspace?: string | null
    id: string
    enabled?: boolean
  }): Promise<{ entry: TaskEpisode }> => invoke('episodeToggle', input),
  removeEpisode: (input: {
    scope: MemoryScope
    workspace?: string | null
    id: string
  }): Promise<{ removed: boolean }> => invoke('episodeRemove', input),
  clearEpisodes: (input: { scope: MemoryScope; workspace?: string | null }): Promise<{ removed: number }> =>
    invoke('episodeClear', input),
  episodeInjection: (input: {
    workspace?: string | null
    query?: string
    maxTokens?: number
  }): Promise<EpisodeInjection> => invoke('episodeInjection', input)
}

export const MEMORY_SOURCE_LABEL: Record<MemorySource, string> = {
  agent: 'Agent 记录',
  user: '我添加',
  migration: '旧记忆迁移'
}

export function formatMemoryTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** 触发浏览器下载（记忆导出用；不写主进程文件系统） */
export function downloadTextFile(fileName: string, content: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const EVOLUTION_CHANNEL_PREFIX = 'feature:evolution:'

async function invokeEvolution<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.morrow.features.invoke<T>(`${EVOLUTION_CHANNEL_PREFIX}${action}`, payload)
  if (!result.ok) throw new Error(result.error.message || '建议操作失败')
  return result.data
}

export const evolutionApi = {
  list: (workspace?: string | null): Promise<EvolutionListResult> =>
    invokeEvolution('list', { workspace: workspace ?? null }),
  review: (sessionId: string): Promise<EvolutionReviewResult> => invokeEvolution('review', { sessionId }),
  apply: (id: string): Promise<EvolutionApplyResult> => invokeEvolution('apply', { id }),
  ignore: (id: string): Promise<{ ignored: boolean; pending: number }> => invokeEvolution('ignore', { id })
}

export function formatEvolutionTime(timestamp: number | null): string {
  if (!timestamp) return '还没有检查'
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

export { EVOLUTION_CHANGED_EVENT }
