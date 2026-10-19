/**
 * R10-E Projects 的 feature IPC 处理（feature:projects:*）。
 *
 * 集成方式（Lead 在 `src/main/features/index.ts` 的 `registerFeatureModules()` 里调用）：
 * ```ts
 * import { registerFeatureHandler } from '../feature-ipc'
 * import { registerProjectsFeature } from './projects'
 * export function registerFeatureModules(): void {
 *   registerProjectsFeature(registerFeatureHandler)
 * }
 * ```
 * 注意：本模块**不在 import 时依赖 feature-ipc / app.getPath**，避免 feature-ipc ⇄ features 循环依赖
 * 以及 app ready 之前的 Electron API 调用；注册时解析一次 dataDir 注入服务。
 *
 * 频道：
 * - feature:projects:list             {} → { projects: ProjectSummary[] }
 * - feature:projects:get              { id } | { workspace } → ProjectRecord | null
 * - feature:projects:create           { workspace, name?, description?, instructions?, knowledgePaths?, pinned?, active? } → ProjectRecord
 * - feature:projects:update           { id, ...同上 } → ProjectRecord
 * - feature:projects:remove           { id } → { removed: true }
 * - feature:projects:set-active       { id, active } → ProjectRecord
 * - feature:projects:set-pinned       { id, pinned } → ProjectRecord
 * - feature:projects:knowledge-validate { workspace, path } → ProjectKnowledgeInfo
 * - feature:projects:knowledge-pick   { workspace } → { files, errors }（系统文件选择器）
 * - feature:projects:context          { workspace, maxTokens?, memoryTokens?, ignoreActive? } → ProjectContext | null
 */
import { dialog } from 'electron'
import { resolveDataDir } from '../services/paths'
import {
  ProjectService,
  configureProjectsRuntime,
  getProjectContext,
  normalizeProjectWorkspace,
  type ProjectContextOptions,
  type ProjectCreateInput,
  type ProjectKnowledgeInfo,
  type ProjectUpdateInput
} from '../services/project-service'
import { log } from '../services/logger'

/** 注册函数签名（与 feature-ipc 的 registerFeatureHandler 兼容；模块不直接依赖 feature-ipc） */
export type RegisterFeatureChannel = (
  channel: string,
  handler: (payload: unknown, event?: unknown) => unknown | Promise<unknown>
) => void

/** 本模块注册的全部频道，便于集成/测试断言 */
export const PROJECTS_FEATURE_CHANNELS = [
  'feature:projects:list',
  'feature:projects:get',
  'feature:projects:create',
  'feature:projects:update',
  'feature:projects:remove',
  'feature:projects:set-active',
  'feature:projects:set-pinned',
  'feature:projects:knowledge-validate',
  'feature:projects:knowledge-pick',
  'feature:projects:context'
] as const

export interface ProjectsFeatureOptions {
  /** 显式数据目录（测试用）；不传时在 app ready 后解析真实 userData */
  dataDir?: string
}

function record(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${key}`)
  return value
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  return value
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  return value
}

function optionalWorkspace(payload: Record<string, unknown>): string | undefined {
  const value = payload.workspace
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error('workspace 必须是非空字符串')
  return normalizeProjectWorkspace(value)
}

function optionalKnowledgePaths(payload: Record<string, unknown>): string[] | undefined {
  const value = payload.knowledgePaths
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('knowledgePaths 必须是字符串数组')
  }
  return value as string[]
}

function projectPatchOf(data: Record<string, unknown>): ProjectUpdateInput {
  const knowledgePaths = optionalKnowledgePaths(data)
  const name = optionalString(data, 'name')
  const description = optionalString(data, 'description')
  const instructions = optionalString(data, 'instructions')
  const pinned = optionalBoolean(data, 'pinned')
  const active = optionalBoolean(data, 'active')
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(knowledgePaths !== undefined ? { knowledgePaths } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(active !== undefined ? { active } : {})
  }
}

function contextOptions(payload: Record<string, unknown>, dataDir: string): ProjectContextOptions {
  return {
    dataDir,
    ...(typeof payload.maxTokens === 'number' ? { maxTokens: payload.maxTokens } : {}),
    ...(typeof payload.memoryTokens === 'number' ? { memoryTokens: payload.memoryTokens } : {}),
    ...(payload.ignoreActive === true ? { ignoreActive: true } : {})
  }
}

/**
 * 注册 Projects 频道。
 * @param register feature-ipc 的 registerFeatureHandler（由 Lead 传入，避免模块直接 import 形成循环）
 */
export function registerProjectsFeature(register: RegisterFeatureChannel, options: ProjectsFeatureOptions = {}): void {
  const dataDir = options.dataDir ?? resolveDataDir()
  const service = (): ProjectService => new ProjectService({ dataDir })
  // 让 Lead 在 agent-service 注入处可直接调用 getProjectContext(workspace) / getProjectPrompt(workspace)
  configureProjectsRuntime(dataDir)
  log.info('projects feature registered', { dataDir })

  register('feature:projects:list', () => ({ projects: service().list() }))

  register('feature:projects:get', (payload) => {
    const data = record(payload)
    if (typeof data.id === 'string' && data.id) return service().getById(data.id)
    const workspace = optionalWorkspace(data)
    if (workspace) return service().getByWorkspace(workspace)
    throw new Error('需要 id 或 workspace')
  })

  register('feature:projects:create', (payload) => {
    const data = record(payload)
    const knowledgePaths = optionalKnowledgePaths(data)
    const pinned = optionalBoolean(data, 'pinned')
    const active = optionalBoolean(data, 'active')
    const input: ProjectCreateInput = {
      workspace: requireString(data, 'workspace'),
      name: optionalString(data, 'name') ?? '',
      description: optionalString(data, 'description') ?? '',
      instructions: optionalString(data, 'instructions') ?? '',
      ...(knowledgePaths !== undefined ? { knowledgePaths } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(active !== undefined ? { active } : {})
    }
    const project = service().create(input)
    log.info('project created', { id: project.id, workspace: project.workspace })
    return project
  })

  register('feature:projects:update', (payload) => {
    const data = record(payload)
    return service().update(requireString(data, 'id'), projectPatchOf(data))
  })

  register('feature:projects:remove', (payload) => {
    service().remove(requireString(record(payload), 'id'))
    return { removed: true }
  })

  register('feature:projects:set-active', (payload) => {
    const data = record(payload)
    return service().setActive(requireString(data, 'id'), optionalBoolean(data, 'active') !== false)
  })

  register('feature:projects:set-pinned', (payload) => {
    const data = record(payload)
    return service().setPinned(requireString(data, 'id'), optionalBoolean(data, 'pinned') === true)
  })

  /** 校验单个知识文件（UI 手动输入相对路径时用） */
  register('feature:projects:knowledge-validate', (payload) => {
    const data = record(payload)
    return service().validateKnowledgePath(requireString(data, 'workspace'), requireString(data, 'path'))
  })

  /** 系统文件选择器 + 校验（UI「选择知识文件」按钮用）；逐个返回校验结果 */
  register('feature:projects:knowledge-pick', async (payload) => {
    const data = record(payload)
    const workspace = normalizeProjectWorkspace(requireString(data, 'workspace'))
    const picked = await dialog.showOpenDialog({
      title: '选择项目知识文件',
      buttonLabel: '加入项目知识',
      defaultPath: workspace,
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { files: [] as ProjectKnowledgeInfo[], errors: [] as Array<{ path: string; error: string }> }
    }
    const files: ProjectKnowledgeInfo[] = []
    const errors: Array<{ path: string; error: string }> = []
    for (const file of picked.filePaths.slice(0, 50)) {
      try {
        files.push(service().validateKnowledgePath(workspace, file))
      } catch (err) {
        errors.push({ path: file, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { files, errors }
  })

  /** 生成项目上下文预览（含记忆中心），UI 展示「会注入什么」；ignoreActive=true 用于编辑预览 */
  register('feature:projects:context', (payload) => {
    const data = record(payload)
    const workspace = normalizeProjectWorkspace(requireString(data, 'workspace'))
    return getProjectContext(workspace, contextOptions(data, dataDir))
  })
}
