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
 */
import { resolveDataDir } from '../services/paths'
import {
  MemoryService,
  configureMemoryRuntime,
  getMemoryInjection,
  type MemoryScope
} from '../services/memory-service'
import { log } from '../services/logger'

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
  'feature:memory:injection'
] as const

export interface MemoryFeatureOptions {
  /** 显式数据目录（测试用）；不传时在 app ready 后解析真实 userData */
  dataDir?: string
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
    const workspace = workspaceOf(data)
    const query = typeof data.query === 'string' ? data.query : undefined
    const result = service().list(scope, workspace, { query, includeDisabled: data.includeDisabled === true })
    return result
  })

  register('feature:memory:add', (payload) => {
    const data = record(payload)
    const entry = service().add({
      scope: parseScope(data),
      workspace: workspaceOf(data),
      text: requireString(data, 'text'),
      tags: stringTags(data.tags),
      enabled: data.enabled !== false,
      source: 'user'
    })
    log.info('memory added', { scope: entry.scope, id: entry.id })
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
    const entry = service().update(scope, workspaceOf(data), requireString(data, 'id'), patch)
    return { entry }
  })

  register('feature:memory:toggle', (payload) => {
    const data = record(payload)
    const id = requireString(data, 'id')
    const enabled = typeof data.enabled === 'boolean' ? data.enabled : undefined
    const entry = service().toggle(parseScope(data), workspaceOf(data), id, enabled)
    return { entry }
  })

  register('feature:memory:remove', (payload) => {
    const data = record(payload)
    service().remove(parseScope(data), workspaceOf(data), requireString(data, 'id'))
    return { removed: true }
  })

  register('feature:memory:clear', (payload) => {
    const data = record(payload)
    const result = service().clear(parseScope(data), workspaceOf(data))
    log.info('memory cleared', { scope: data.scope, removed: result.removed })
    return result
  })

  register('feature:memory:export', (payload) => {
    const data = record(payload)
    return service().exportMemory(parseScope(data), workspaceOf(data))
  })

  /** 注入预览：UI 展示「哪些记忆会被送进系统提示 / 用多少 token」，也是验收证据 */
  register('feature:memory:injection', (payload) => {
    const data = record(payload)
    return getMemoryInjection(workspaceOf(data), {
      dataDir,
      maxTokens: typeof data.maxTokens === 'number' ? data.maxTokens : undefined
    })
  })
}
