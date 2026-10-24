/**
 * 全局搜索 feature 模块（feature:search:*）。
 *
 * 渲染层通过 window.morrow.features.invoke('feature:search:query', { q, workspace?, limit? }) 调用。
 *
 * 索引更新策略：
 * - 模块加载后后台构建一次；
 * - 每次查询前按会话 updatedAt/messageCount 与文件 mtime/size 自动增量刷新
 *   （会话保存/工具完成后无需主进程显式通知）；
 * - 也提供 feature:search:refresh / feature:search:session-updated，供保存后主动触发。
 */
import { existsSync } from 'node:fs'
import type { Session, SessionMeta } from '../../shared/types'
import { registerFeatureHandler } from '../feature-ipc'
import { log } from '../services/logger'
import { dataPath, ensureDataDirs } from '../services/paths'
import { WorkspaceSearchService, type SearchQueryInput } from '../services/workspace-search-service'
import { getSessionStore } from '../services/session-store'
import { getSettingsStore } from '../services/settings-store'
import { setSearchClearHandler, setSearchInvalidationHandler } from '../services/runtime'
import { resolveWorkspaceDir } from './workspace-roots'

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
/** 全局搜索不再受侧栏 300 条上限影响；仍设一个上限避免启动索引无限膨胀 */
const MAX_SEARCH_SESSIONS = 1000

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

function searchSessionMetas(store: ReturnType<typeof getSessionStore>): SessionMeta[] {
  try {
    const all = store.listAll()
    return all.length > MAX_SEARCH_SESSIONS ? all.slice(0, MAX_SEARCH_SESSIONS) : all
  } catch (err) {
    log.warn('search: listSessions failed', String(err))
    return []
  }
}

function createService(): WorkspaceSearchService {
  ensureDataDirs()
  const sessionStore = getSessionStore()
  return new WorkspaceSearchService({
    listSessions: () => searchSessionMetas(sessionStore),
    getSession: (id): Session | null => {
      try {
        return sessionStore.get(id)
      } catch {
        return null
      }
    },
    getSessionRevision: () => sessionStore.getRevision(),
    listWorkspaces: () => knownWorkspaces(searchSessionMetas(sessionStore)),
    dataDir: dataPath(),
    now: Date.now
  })
}

let service: WorkspaceSearchService | null = null
let started: Promise<void> | null = null

function getService(): WorkspaceSearchService {
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

/**
 * 搜索请求里的 workspace 必须是已登记工作区；否则索引器会扫描任意目录。
 * 返回原始路径（索引键与会话 workspace 保持同一形式，链接别名交给 realpath 校验）。
 */
function validateSearchWorkspace(raw: string): string {
  resolveWorkspaceDir(raw, '搜索只能访问已登记的工作区。')
  return raw
}

setSearchInvalidationHandler(async (sessionId) => {
  // 搜索从未打开过（service 未创建）时没有需要清理的索引
  if (!service) return
  await ensureStarted()
  await service.refreshSession(sessionId)
})

setSearchClearHandler(async () => {
  if (!service) return
  await service.rebuild()
})

registerFeatureHandler('feature:search:query', async (payload) => {
  const input = (payload ?? {}) as QueryPayload
  const q = asString(input.q) ?? ''
  if (q.length > MAX_QUERY_CHARS) {
    throw new Error(`搜索词过长（最多 ${MAX_QUERY_CHARS} 字符）。`)
  }
  // 不传 workspace = 全局搜索；显式传字符串才限定文件夹
  const rawWorkspace = asString(input.workspace)
  const workspace = rawWorkspace ? validateSearchWorkspace(rawWorkspace) : null
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
  const rawWorkspace = asString(input.workspace)
  const workspace = rawWorkspace ? validateSearchWorkspace(rawWorkspace) : null
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
  const rawWorkspace = asString(input.workspace)
  if (!rawWorkspace) throw new Error('缺少 workspace 路径。')
  const workspace = validateSearchWorkspace(rawWorkspace)
  await ensureStarted()
  await getService().refreshWorkspace(workspace)
  return getService().status()
})

