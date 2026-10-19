/**
 * R10-E Projects：渲染层 API 客户端（只通过 window.morrow.features.invoke 访问主进程）。
 *
 * 类型与 `src/main/services/project-service.ts` 的公开类型一一对应（wire contract）。
 */

import type { MemoryInjection } from '../memory/memory-api'

export interface ProjectRecord {
  id: string
  workspace: string
  name: string
  description: string
  instructions: string
  knowledgePaths: string[]
  pinned: boolean
  active: boolean
  createdAt: number
  updatedAt: number
}

export interface ProjectSummary extends ProjectRecord {
  workspaceExists: boolean
  knowledgeCount: number
}

export interface ProjectKnowledgeInfo {
  path: string
  name: string
  size: number
  mtime: number
  excerpt?: string
  truncated?: boolean
  error?: string
}

export interface ProjectContext {
  project: ProjectRecord
  instructions: string
  knowledge: ProjectKnowledgeInfo[]
  staleKnowledge: Array<{ path: string; error: string }>
  memory: MemoryInjection | null
  projectText: string
  memoryText: string
  text: string
  usedTokens: number
  limitTokens: number
  truncated: boolean
}

export interface ProjectCreateInput {
  workspace: string
  name?: string
  description?: string
  instructions?: string
  knowledgePaths?: string[]
  pinned?: boolean
  active?: boolean
}

export interface ProjectUpdateInput {
  name?: string
  description?: string
  instructions?: string
  knowledgePaths?: string[]
  pinned?: boolean
  active?: boolean
}

const CHANNEL_PREFIX = 'feature:projects:'

async function invoke<T>(action: string, payload?: unknown): Promise<T> {
  const result = await window.morrow.features.invoke<T>(`${CHANNEL_PREFIX}${action}`, payload)
  if (!result.ok) throw new Error(result.error.message || '项目操作失败')
  return result.data
}

export const projectsApi = {
  list: (): Promise<{ projects: ProjectSummary[] }> => invoke('list'),
  get: (input: { id?: string; workspace?: string }): Promise<ProjectRecord | null> => invoke('get', input),
  create: (input: ProjectCreateInput): Promise<ProjectRecord> => invoke('create', input),
  update: (input: { id: string } & ProjectUpdateInput): Promise<ProjectRecord> => invoke('update', input),
  remove: (input: { id: string }): Promise<{ removed: boolean }> => invoke('remove', input),
  setActive: (input: { id: string; active: boolean }): Promise<ProjectRecord> => invoke('set-active', input),
  setPinned: (input: { id: string; pinned: boolean }): Promise<ProjectRecord> => invoke('set-pinned', input),
  validateKnowledge: (input: { workspace: string; path: string }): Promise<ProjectKnowledgeInfo> =>
    invoke('knowledge-validate', input),
  pickKnowledge: (input: { workspace: string }): Promise<{
    files: ProjectKnowledgeInfo[]
    errors: Array<{ path: string; error: string }>
  }> => invoke('knowledge-pick', input),
  context: (input: {
    workspace: string
    maxTokens?: number
    memoryTokens?: number
    ignoreActive?: boolean
  }): Promise<ProjectContext | null> => invoke('context', input)
}

export function workspaceName(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? workspace
}

export function formatProjectTime(timestamp: number): string {
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

export function formatFileSize(bytes: number): string {
  if (!bytes) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
