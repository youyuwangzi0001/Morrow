/**
 * R10-I 全局搜索 feature 模块（feature:search:*）。
 *
 * Lead 集成：在 src/main/features/index.ts 里加一行 `import './search'` 即可。
 * 渲染层：window.morrow.features.invoke('feature:search:query', { q, workspace?, limit? })
 *
 * 索引更新策略：
 * - 模块加载后后台构建一次；
 * - 每次查询前按会话 updatedAt/messageCount 与文件 mtime/size 自动增量刷新
 *   （会话保存/工具完成后无需主进程显式通知）；
 * - 也提供 feature:search:refresh / feature:search:session-updated 供 Lead 在保存后主动触发。
 */
import { existsSync } from 'node:fs'
import type { Session, SessionMeta } from '../../shared/types'
import { registerFeatureHandler } from '../feature-ipc'
import { log } from '../services/logger'
import { dataPath, ensureDataDirs } from '../services/paths'
import { SearchService, type SearchQueryInput } from '../services/search-service'
import { getSessionStore } from '../services/session-store'
import { getSettingsStore } from '../services/settings-store'

interface QueryPayload {
  q?: unknown
  workspace?: unknown
  limit?: unknown
}

interface RefreshPayload {
  workspace?: unknown
  sessionId?: unknown
  full?: unknown
}

const MAX_QUERY_CHARS = 200

function currentWorkspace(): string | null {
  try {
    const settings = getSettingsStore().get()
    const last = settings.lastWorkspace
    if (typeof last === 'string' && last && existsSync(last)) return last
    const recent = settings.recentWorkspaces.find((workspace) => typeof workspace === 'string' && existsSync(workspace))
    return recent ?? null
  } catch {
    return null
  }
}

function knownWorkspaces(meta: SessionMeta[]): string[] {
  const workspaces = new Set<string>()
  try {
    const settings = getSettingsStore().get()
    if (settings.lastWorkspace && existsSync(settings.lastWorkspace)) workspaces.add(settings.lastWorkspace)
    for (const workspace of settings.recentWorkspaces) {
      if (workspace && existsSync(workspace)) workspaces.add(workspace)
    }
  } catch {
    // 设置不可用时只依赖会话工作区
  }
  for (const session of meta) {
    if (session.workspace && existsSync(session.workspace)) workspaces.add(session.workspace)
  }
  return [...workspaces]
}

function createService(): SearchService {
  ensureDataDirs()
  const sessionStore = getSessionStore()
  return new SearchService({
    listSessions: () => {
      try {
        return sessionStore.list()
      } catch (err) {
        log.warn('search: listSessions failed', String(err))
        return []
      }
    },
    getSession: (id): Session | null => {
      try {
        return sessionStore.get(id)
      } catch {
        return null
      }
    },
    listWorkspaces: () => knownWorkspaces(safeListSessions(sessionStore)),
    dataDir: dataPath(),
    now: Date.now
  })
}

function safeListSessions(store: ReturnType<typeof getSessionStore>): SessionMeta[] {
  try {
    return store.list()
  } catch {
    return []
  }
}

let service: SearchService | null = null
let started: Promise<void> | null = null

function getService(): SearchService {
  if (!service) service = createService()
  return service
}

function ensureStarted(): Promise<void> {
  if (!started) {
    started = getService().start().catch((err) => {
      log.warn('search: initial index failed', String(err))
      started = null
    })
  }
  return started
}

/** 由 Lead 在 app ready 后调用；避免 feature import 时提前初始化 settings/搜索结果 */
export function warmSearchIndex(): void {
  void ensureStarted()
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

registerFeatureHandler('feature:search:query', async (payload) => {
  const input = (payload ?? {}) as QueryPayload
  const q = asString(input.q) ?? ''
  if (q.length > MAX_QUERY_CHARS) {
    throw new Error(`搜索词过长（最多 ${MAX_QUERY_CHARS} 字符）。`)
  }
  const workspace = asString(input.workspace) ?? currentWorkspace()
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : 20
  await ensureStarted()
  const query: SearchQueryInput = { q, workspace, limit }
  return getService().search(query)
})

registerFeatureHandler('feature:search:status', async () => {
  await ensureStarted()
  return getService().status()
})

registerFeatureHandler('feature:search:refresh', async (payload) => {
  const input = (payload ?? {}) as RefreshPayload
  const workspace = asString(input.workspace)
  const sessionId = asString(input.sessionId)
  await ensureStarted()
  if (input.full === true) {
    await getService().rebuild()
  } else {
    if (sessionId) await getService().refreshSession(sessionId)
    if (workspace) await getService().refreshWorkspace(workspace)
    if (!sessionId && !workspace) await getService().start()
  }
  return getService().status()
})

// Lead 在保存会话/工具完成后可精确通知（也可完全依赖查询前自动刷新）
registerFeatureHandler('feature:search:session-updated', async (payload) => {
  const input = (payload ?? {}) as RefreshPayload
  const sessionId = asString(input.sessionId)
  if (!sessionId) throw new Error('缺少 sessionId。')
  await ensureStarted()
  const indexed = await getService().refreshSession(sessionId)
  return { indexed }
})

registerFeatureHandler('feature:search:workspace-updated', async (payload) => {
  const input = (payload ?? {}) as RefreshPayload
  const workspace = asString(input.workspace)
  if (!workspace) throw new Error('缺少 workspace 路径。')
  await ensureStarted()
  await getService().refreshWorkspace(workspace)
  return getService().status()
})

export const SEARCH_FEATURE_CHANNELS = [
  'feature:search:query',
  'feature:search:status',
  'feature:search:refresh',
  'feature:search:session-updated',
  'feature:search:workspace-updated'
] as const
