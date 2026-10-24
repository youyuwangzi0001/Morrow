/**
 * R10-D 记忆中心的 feature IPC 处理（feature:memory:*）。
 *
 * 集成方式（Lead 在 `src/main/features/index.ts` 的 `registerFeatureModules()` 里调用）：
 * ```ts
 * import { registerFeatureHandler } from '../feature-ipc'
 * import { registerMemoryFeature } from './memory'
 * export function registerFeatureModules(): void {
 *   registerMemoryFeature(registerFeatureHandler)
 * }
 * ```
 * 注意：本模块**不在 import 时依赖 feature-ipc / app.getPath**，避免 feature-ipc ⇄ features 循环依赖
 * 以及 app ready 之前的 Electron API 调用；注册时把 dataDir 解析一次并注入服务。
 *
 * 频道（全部返回普通 JSON 数据，错误 throw，由 feature-ipc 统一包成 Result）：
 * - feature:memory:list               { scope, workspace?, query?, includeDisabled? } → { entries, stats }
 * - feature:memory:add                { scope, workspace?, text, tags? } → { entry }
 * - feature:memory:update             { scope, workspace?, id, text?, tags?, enabled? } → { entry }
 * - feature:memory:toggle             { scope, workspace?, id, enabled? } → { entry }
 * - feature:memory:remove             { scope, workspace?, id } → { removed: true }
 * - feature:memory:clear              { scope, workspace? } → { removed }
 * - feature:memory:export             { scope, workspace? } → { fileName, markdown, json, count, exportedAt }
 * - feature:memory:injection          { workspace?, maxTokens? } → MemoryInjection（注入预览）
 * - feature:memory:episodes / episodeToggle / episodeRemove / episodeClear / episodeInjection
 *
 * 自进化建议（feature:evolution:list / review / apply / ignore）与记忆同属一个 feature 域，
 * 故在本模块一并注册；自动复盘由 AgentService 在任务结束后触发，不经过渲染层。
 */
import { resolveDataDir } from '../services/paths'
import {
  MemoryService,
  configureMemoryRuntime,
  getMemoryInjection,
  type MemoryScope
} from '../services/memory-service'
import { log } from '../services/logger'
import { sendFeatureEvent } from '../feature-ipc'
import {
  EPISODE_CHANGED_EVENT,
  EVOLUTION_CHANGED_EVENT,
  MEMORY_CHANGED_EVENT
} from '../../shared/memory'
import { configureEvolutionRuntime, getEvolutionService } from '../services/evolution-service'
import { getAgentService } from '../services/agent-service'
import { getSettingsStore } from '../services/settings-store'
import { getSessionStore } from '../services/session-store'
import { resolveWorkspaceDir } from './workspace-roots'

/** 注册函数签名（与 feature-ipc 的 registerFeatureHandler 兼容；模块不直接依赖 feature-ipc） */
export type RegisterFeatureChannel = (
  channel: string,
  handler: (payload: unknown, event?: unknown) => unknown | Promise<unknown>
) => void

/** 本模块注册的全部频道，便于集成/测试断言 */
export const MEMORY_FEATURE_CHANNELS = [
  'feature:memory:list',
  'feature:memory:add',
  'feature:memory:update',
  'feature:memory:toggle',
  'feature:memory:remove',
  'feature:memory:clear',
  'feature:memory:export',
  'feature:memory:injection',
  'feature:memory:episodes',
  'feature:memory:episodeToggle',
  'feature:memory:episodeRemove',
  'feature:memory:episodeClear',
  'feature:memory:episodeInjection'
] as const

export interface MemoryFeatureOptions {
  /** 显式数据目录（测试用）；不传时在 app ready 后解析真实 userData */
  dataDir?: string
  /** 测试用：覆盖已登记工作区校验；生产环境始终走 resolveWorkspaceDir */
  isWorkspaceAllowed?: (workspace: string) => boolean
}

function record(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}

function parseScope(payload: Record<string, unknown>): MemoryScope {
  const scope = payload.scope
  if (scope !== 'project' && scope !== 'global') throw new Error('scope 必须是 project 或 global')
  return scope
}

function workspaceOf(payload: Record<string, unknown>): string | null {
  const workspace = payload.workspace
  if (workspace === undefined || workspace === null || workspace === '') return null
  if (typeof workspace !== 'string') throw new Error('workspace 必须是字符串')
  return workspace
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string') throw new Error(`缺少 ${key}`)
  return value
}

/** 记忆 IPC 的工作区边界：只接受已登记的、真实存在的工作区目录。 */
function resolveProjectWorkspace(data: Record<string, unknown>, options: MemoryFeatureOptions): string {
  const raw = workspaceOf(data)
  if (!raw) throw new Error('项目记忆需要指定工作区')
  if (options.isWorkspaceAllowed) {
    if (!options.isWorkspaceAllowed(raw)) throw new Error('记忆只能读写已登记的工作区。')
    return raw
  }
  return resolveWorkspaceDir(raw, '记忆只能读写已登记的工作区。')
}

function targetWorkspace(
  data: Record<string, unknown>,
  scope: MemoryScope,
  options: MemoryFeatureOptions
): string | null {
  return scope === 'global' ? null : resolveProjectWorkspace(data, options)
}

function stringTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('tags 必须是字符串数组')
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 注册记忆中心频道。
 * @param register feature-ipc 的 registerFeatureHandler（由 Lead 传入，避免模块直接 import 形成循环）
 */
export function registerMemoryFeature(register: RegisterFeatureChannel, options: MemoryFeatureOptions = {}): void {
  const dataDir = options.dataDir ?? resolveDataDir()
  const service = (): MemoryService => new MemoryService({ dataDir })
  // 让 Lead 在 agent-service 注入处可直接调用 getMemoryPrompt(workspace)（不传 dataDir）
  configureMemoryRuntime(dataDir)
  log.info('memory feature registered', { dataDir })

  register('feature:memory:list', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const query = typeof data.query === 'string' ? data.query : undefined
    return service().list(scope, workspace, { query, includeDisabled: data.includeDisabled === true })
  })

  register('feature:memory:add', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const entry = service().add({
      scope,
      workspace,
      text: requireString(data, 'text'),
      tags: stringTags(data.tags),
      enabled: data.enabled !== false,
      source: 'user'
    })
    log.info('memory added', { scope: entry.scope, id: entry.id })
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:update', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const patch: { text?: string; tags?: string[]; enabled?: boolean } = {}
    if (data.text !== undefined) patch.text = requireString(data, 'text')
    const tags = stringTags(data.tags)
    if (tags !== undefined) patch.tags = tags
    if (data.enabled !== undefined) patch.enabled = data.enabled === true
    const workspace = targetWorkspace(data, scope, options)
    const entry = service().update(scope, workspace, requireString(data, 'id'), patch)
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:toggle', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const id = requireString(data, 'id')
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : undefined
    const workspace = targetWorkspace(data, scope, options)
    const entry = service().toggle(scope, workspace, id, enabled)
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:remove', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    service().remove(scope, workspace, requireString(data, 'id'))
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return { removed: true }
  })

  register('feature:memory:clear', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const result = service().clear(scope, workspace)
    log.info('memory cleared', { scope, removed: result.removed })
    sendFeatureEvent(MEMORY_CHANGED_EVENT, { scope, workspace })
    return result
  })

  register('feature:memory:export', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    return service().exportMemory(scope, targetWorkspace(data, scope, options))
  })

  /** 注入预览：UI 展示「哪些记忆会被送进系统提示 / 用多少 token」，也是验收证据 */
  register('feature:memory:injection', (payload) => {
    const data = record(payload)
    const rawWorkspace = workspaceOf(data)
    let workspace: string | null = null
    if (rawWorkspace) {
      if (options.isWorkspaceAllowed) {
        if (!options.isWorkspaceAllowed(rawWorkspace)) throw new Error('记忆只能读写已登记的工作区。')
        workspace = rawWorkspace
      } else {
        workspace = resolveWorkspaceDir(rawWorkspace, '记忆只能读写已登记的工作区。')
      }
    }
    return getMemoryInjection(workspace, {
      dataDir,
      maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined
    })
  })

  /* ── 任务经验（自动记忆） ─────────────────────────────────── */

  register('feature:memory:episodes', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const query = typeof data.query === 'string' ? data.query : undefined
    return service().listEpisodes(scope, workspace, {
      query,
      includeDisabled: data.includeDisabled === true
    })
  })

  register('feature:memory:episodeToggle', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : undefined
    const entry = service().toggleEpisode(scope, workspace, requireString(data, 'id'), enabled)
    sendFeatureEvent(EPISODE_CHANGED_EVENT, { scope, workspace })
    return { entry }
  })

  register('feature:memory:episodeRemove', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    service().removeEpisode(scope, workspace, requireString(data, 'id'))
    sendFeatureEvent(EPISODE_CHANGED_EVENT, { scope, workspace })
    return { removed: true }
  })

  register('feature:memory:episodeClear', (payload) => {
    const data = record(payload)
    const scope = parseScope(data)
    const workspace = targetWorkspace(data, scope, options)
    const result = service().clearEpisodes(scope, workspace)
    log.info('task episodes cleared', { scope, removed: result.removed })
    sendFeatureEvent(EPISODE_CHANGED_EVENT, { scope, workspace })
    return result
  })

  register('feature:memory:episodeInjection', (payload) => {
    const data = record(payload)
    const rawWorkspace = workspaceOf(data)
    let workspace: string | null = null
    if (rawWorkspace) {
      if (options.isWorkspaceAllowed) {
        if (!options.isWorkspaceAllowed(rawWorkspace)) throw new Error('记忆只能读写已登记的工作区。')
        workspace = rawWorkspace
      } else {
        workspace = resolveWorkspaceDir(rawWorkspace, '记忆只能读写已登记的工作区。')
      }
    }
    return service().episodeInjection(
      workspace,
      typeof data.query === 'string' ? data.query : '',
      { maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined }
    )
  })
}

function suggestionId(data: Record<string, unknown>): string {
  const id = requireString(data, 'id').trim()
  if (!id) throw new Error('缺少建议 id')
  return id
}

/** 注册自进化建议频道；复盘写回记忆/技能库，仍以用户采纳为前提。 */
export function registerEvolutionFeature(
  register: RegisterFeatureChannel,
  options: { dataDir?: string } = {}
): void {
  const dataDir = options.dataDir ?? resolveDataDir()
  configureEvolutionRuntime(dataDir)
  log.info('evolution feature registered', { dataDir })

  const service = () => {
    const instance = getEvolutionService()
    if (!instance) throw new Error('建议服务尚未初始化')
    return instance
  }

  register('feature:evolution:list', (payload) => {
    const data = payload === undefined || payload === null ? {} : record(payload)
    const workspace = typeof data.workspace === 'string' && data.workspace.trim() ? data.workspace.trim() : null
    return service().list(workspace)
  })

  register('feature:evolution:review', async (payload) => {
    const data = record(payload)
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : ''
    if (!sessionId) throw new Error('缺少 sessionId')
    return getAgentService(getSettingsStore(), getSessionStore()).reviewEvolution(sessionId, true)
  })

  register('feature:evolution:apply', (payload) => {
    const result = service().apply(suggestionId(record(payload)))
    const pending = service().pendingCount()
    sendFeatureEvent(EVOLUTION_CHANGED_EVENT, { reason: 'applied', pending })
    return result
  })

  register('feature:evolution:ignore', (payload) => {
    service().ignore(suggestionId(record(payload)))
    const pending = service().pendingCount()
    sendFeatureEvent(EVOLUTION_CHANGED_EVENT, { reason: 'ignored', pending })
    return { ignored: true, pending }
  })
}
