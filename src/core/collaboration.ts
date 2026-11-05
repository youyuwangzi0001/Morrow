import { errResult, getNumber, getString, okResult, type ToolImpl } from './tool-kit'
import { truncateText } from './util'
import { CollaborationArtifact, CollaborationArtifactUsage, PlanNeed, SuperAgentState, SuperTask, PlanRevisionSnapshot, PlanVerification, CollaborationTraceEntry, CollaborationTraceLink, CollaborationTraceQuery, CollaborationTraceUsage, CollaborationVerification, CollaborationVerificationFile, SwarmOperation } from '../shared/types'
import { collaborationTaskId, recordCollaborationStatus, stableCollaborationHash, superTaskCollaborationStatus } from '../shared/contracts'
export const ARTIFACT_NAME_MAX = 80
export const ARTIFACT_SUMMARY_MAX = 600
export const ARTIFACT_CONTENT_MAX = 6_000
/** Worker 上下文只放短预览；完整快照按需 trace，避免每个成员重复整段阅读。 */
export const ARTIFACT_HANDOFF_PREVIEW = 1_200

function taskKey(task: SuperTask): string {
  return task.taskId ?? task.id
}

function currentUsages(task: SuperTask): CollaborationArtifactUsage[] {
  if (!task.currentAttemptId) return []
  return (task.artifactUsage ?? []).filter((usage) => usage.attemptId === task.currentAttemptId)
}

export function latestReadyArtifact(
  artifacts: readonly CollaborationArtifact[] | undefined,
  name: string
): CollaborationArtifact | undefined {
  const target = name.trim()
  let latest: CollaborationArtifact | undefined
  for (const artifact of artifacts ?? []) {
    if (artifact.name !== target || artifact.status !== 'ready') continue
    if (!latest || artifact.version > latest.version) latest = artifact
  }
  return latest
}

/** 依赖的成果已经可用时，允许成员先开工，不必等发布者整个任务结束。 */
export function artifactDependencyReady(
  task: SuperTask,
  dep: SuperTask,
  artifacts: readonly CollaborationArtifact[] | undefined
): { ready: boolean; artifacts: CollaborationArtifact[] } {
  const depKey = dep.planKey ?? dep.id
  const depStableId = taskKey(dep)
  const needs = (task.needs ?? []).filter(
    (need) => need.taskId === dep.id || need.taskId === depKey || need.taskId === depStableId
  )
  if (needs.length === 0) return { ready: false, artifacts: [] }
  if (needs.some((need) => !need.artifact)) return { ready: false, artifacts: [] }
  const found: CollaborationArtifact[] = []
  for (const need of needs) {
    const artifact = latestReadyArtifact(artifacts, need.artifact!)
    if (!artifact) return { ready: false, artifacts: [] }
    if (artifact.taskId && artifact.taskId !== depStableId) return { ready: false, artifacts: [] }
    if (artifact.version < (need.artifactVersion ?? 1)) return { ready: false, artifacts: [] }
    found.push(artifact)
  }
  return { ready: true, artifacts: found }
}

function latestReadyVersion(state: SuperAgentState, name: string): number | undefined {
  return latestReadyArtifact(state.artifacts, name)?.version
}

/**
 * 根据当前可用版本重算“谁用了旧版、需要重测”。
 * 只看当前尝试的使用记录；已撤回的新版本会自动把旧版恢复为最新可用。
 */
export function recomputeArtifactStaleness(state: SuperAgentState): {
  state: SuperAgentState
  staleTaskIds: string[]
  restoredTaskIds: string[]
  changed: boolean
} {
  const staleTaskIds: string[] = []
  const restoredTaskIds: string[] = []
  let changed = false
  const usedArtifact = (usage: CollaborationArtifactUsage): CollaborationArtifact | undefined =>
    (state.artifacts ?? []).find((artifact) => artifact.name === usage.name && artifact.version === usage.version)
  const tasks = state.tasks.map((task) => {
    const usages = (task.artifactUsage ?? []).map((usage) => {
      const latest = latestReadyVersion(state, usage.name)
      const used = usedArtifact(usage)
      const invalid = used !== undefined && used.status !== 'ready'
      const status =
        invalid || (latest !== undefined && latest > usage.version) ? ('outdated' as const) : ('current' as const)
      return usage.status === status ? usage : { ...usage, status }
    })
    const stale = currentUsages({ ...task, artifactUsage: usages }).filter((usage) => usage.status === 'outdated')
    const shouldRetest = stale.length > 0 && task.status !== 'queued' && task.status !== 'cancelled'
    const staleArtifacts = stale.map((usage) => {
      const latest = latestReadyVersion(state, usage.name)
      const used = usedArtifact(usage)
      return used && used.status !== 'ready'
        ? `${usage.name} v${usage.version}（${used.status === 'revoked' ? '已撤回' : '非可用版本'}）→ 最新可用 v${latest ?? '无'}`
        : `${usage.name} v${usage.version} → 最新 v${latest ?? usage.version}`
    })
    if (shouldRetest) staleTaskIds.push(taskKey(task))
    else if (task.needsRetest) restoredTaskIds.push(taskKey(task))
    const usageChanged = usages.some((usage, index) => usage.status !== (task.artifactUsage?.[index]?.status ?? 'current'))
    const flagChanged =
      Boolean(task.needsRetest) !== shouldRetest ||
      JSON.stringify(task.staleArtifacts ?? []) !== JSON.stringify(staleArtifacts)
    if (usageChanged || flagChanged) changed = true
    return {
      ...task,
      artifactUsage: usages,
      needsRetest: shouldRetest ? true : undefined,
      staleArtifacts: staleArtifacts.length > 0 ? staleArtifacts : undefined
    }
  })
  return {
    state: changed ? { ...state, tasks, updatedAt: Date.now() } : state,
    staleTaskIds,
    restoredTaskIds,
    changed
  }
}

export function publishArtifactVersion(
  state: SuperAgentState,
  artifact: CollaborationArtifact
): { state: SuperAgentState; artifact: CollaborationArtifact; staleTaskIds: string[]; restoredTaskIds: string[] } {
  const artifacts = state.artifacts ?? []
  if (artifact.status === 'ready') {
    const existing = latestReadyArtifact(artifacts, artifact.name)
    if (existing && artifact.version <= existing.version) {
      throw new Error(`「${artifact.name}」已有 v${existing.version}；新版本号必须更大。`)
    }
  }
  if (artifacts.some((entry) => entry.name === artifact.name && entry.version === artifact.version)) {
    throw new Error(`「${artifact.name}」v${artifact.version} 已经发布过了。`)
  }
  const next = recomputeArtifactStaleness({
    ...state,
    artifacts: [...artifacts, artifact],
    updatedAt: artifact.publishedAt
  })
  return {
    state: next.state,
    artifact,
    staleTaskIds: next.staleTaskIds,
    restoredTaskIds: next.restoredTaskIds
  }
}

export function recordArtifactUsage(
  state: SuperAgentState,
  input: { artifactId: string; name: string; version: number; taskId: string; attemptId: string; at?: number }
): { state: SuperAgentState; usage: CollaborationArtifactUsage } {
  const at = input.at ?? Date.now()
  const task = state.tasks.find((entry) => taskKey(entry) === input.taskId)
  if (!task) throw new Error('没有找到使用成果的任务。')
  const usages = [...(task.artifactUsage ?? [])]
  const index = usages.findIndex(
    (usage) =>
      usage.name === input.name && usage.taskId === input.taskId && usage.attemptId === input.attemptId
  )
  const usage: CollaborationArtifactUsage = {
    id: index >= 0 ? usages[index].id : `usage_${input.artifactId}_${input.attemptId}`,
    artifactId: input.artifactId,
    name: input.name,
    version: input.version,
    taskId: input.taskId,
    attemptId: input.attemptId,
    readAt: at,
    status: 'current'
  }
  if (index >= 0) usages[index] = usage
  else usages.push(usage)
  const tasks = state.tasks.map((entry) =>
    taskKey(entry) === input.taskId ? { ...entry, artifactUsage: usages } : entry
  )
  const next = recomputeArtifactStaleness({ ...state, tasks, updatedAt: at })
  return { state: next.state, usage }
}

export function revokeArtifactVersion(
  state: SuperAgentState,
  input: { name: string; version: number; reason?: string; at?: number }
): {
  state: SuperAgentState
  artifact: CollaborationArtifact
  staleTaskIds: string[]
  restoredTaskIds: string[]
} {
  const at = input.at ?? Date.now()
  const target = (state.artifacts ?? []).find(
    (artifact) => artifact.name === input.name && artifact.version === input.version
  )
  if (!target) throw new Error(`没有找到「${input.name}」v${input.version}。`)
  if (target.status === 'revoked') throw new Error(`「${input.name}」v${input.version} 已经撤回过了。`)
  const artifact: CollaborationArtifact = {
    ...target,
    status: 'revoked',
    revokedAt: at,
    ...(input.reason?.trim() ? { revokeReason: input.reason.trim().slice(0, 300) } : {})
  }
  const artifacts = (state.artifacts ?? []).map((entry) => (entry === target ? artifact : entry))
  const next = recomputeArtifactStaleness({ ...state, artifacts, updatedAt: at })
  return {
    state: next.state,
    artifact,
    staleTaskIds: next.staleTaskIds,
    restoredTaskIds: next.restoredTaskIds
  }
}

/** 为 Worker 注入依赖成果的交接说明；内容来自只读快照，不受成员副本限制。 */
export function formatArtifactHandoff(input: {
  artifact: CollaborationArtifact
  content: string
  need: PlanNeed
  publisherTitle?: string
}): string {
  const { artifact, content, need } = input
  return [
    `【可用成果】${artifact.name} v${artifact.version}（已可使用${input.publisherTitle ? `，发布者：${input.publisherTitle}` : ''}）`,
    `满足需要：${need.result}`,
    `文件：${artifact.path} · 哈希 ${artifact.hash.slice(0, 12)}`,
    ...(artifact.summary ? [`摘要：${artifact.summary}`] : []),
    '内容预览（只读快照，截断）：',
    truncateText(content, ARTIFACT_HANDOFF_PREVIEW),
    `完整内容按需追溯：trace(action="artifact", name="${artifact.name}", version=${artifact.version})；不要重复整段读取。`
  ].join('\n')
}

/** Router 提示词里的成果版本摘要：谁发布了什么、哪些任务需要重测。 */
export function collaborationArtifactPromptSection(state: SuperAgentState | null | undefined): string {
  const artifacts = state?.artifacts ?? []
  const tasks = state?.tasks.filter((task) => task.planRemoved !== true) ?? []
  const retest = tasks.filter((task) => task.needsRetest)
  if (artifacts.length === 0 && retest.length === 0) return ''
  const titleById = new Map(tasks.map((task) => [taskKey(task), task.title]))
  const names = [...new Set(artifacts.map((artifact) => artifact.name))]
  const lines = [
    '## 成果版本与交接',
    '依赖项声明使用成果后，只要对应版本标记为“可用”，下游即可提前开工，不必等发布者整个任务结束。',
    ...names.map((name) => {
      const versions = artifacts.filter((artifact) => artifact.name === name).sort((a, b) => b.version - a.version)
      const latestReady = latestReadyArtifact(artifacts, name)
      const current = versions[0]
      const status = current.status === 'ready' ? '可用' : current.status === 'draft' ? '草稿' : '已撤回'
      const users = tasks
        .filter((task) =>
          currentUsages(task).some((usage) => usage.name === name && usage.version === current.version)
        )
        .map((task) => task.title)
      return `- ${name} v${current.version}（${status}，文件 ${current.path}${latestReady && latestReady.version !== current.version ? `；当前可用 v${latestReady.version}` : ''}${users.length > 0 ? `；使用者：${users.join('、')}` : ''}）`
    }),
    ...(retest.length > 0
      ? [
          `需要重测/更新：${retest
            .map((task) => `${task.title}${task.staleArtifacts?.length ? `（${task.staleArtifacts.join('；')}）` : ''}`)
            .join('、')}。旧版结果不能给新版签字；可对受影响任务单项重试，未受影响的项不要重跑。`
        ]
      : []),
    ...(artifacts.length > 0
      ? [`查看使用者：${[...titleById.values()].length > 0 ? '面板的“成果版本”区显示各版本、发布者与使用记录。' : ''}`]
      : [])
  ]
  return lines.filter((line) => line !== '').join('\n')
}

function formatArtifactLine(artifact: CollaborationArtifact): string {
  const status = artifact.status === 'ready' ? '可用' : artifact.status === 'draft' ? '草稿' : '已撤回'
  return `- ${artifact.name} v${artifact.version} · ${status} · ${artifact.path}${artifact.summary ? ` · ${artifact.summary}` : ''}`
}

export const artifactTool: ToolImpl = {
  definition: {
    name: 'artifact',
    description:
      '版本化成果交接：publish 把文件发布为带版本和可用状态的成果（ready 后依赖成员可提前开工，draft 只登记不可用）；read 读取最新或指定版本的可用成果，并记录你实际使用的版本；list 查看项目成果；revoke 仅供协调者撤回有误版本的可用标记。' +
      '发布时写清名称、文件位置和摘要；第 2 版会标记使用旧版且需要重测的任务，旧版结果不能给新版签字。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['publish', 'read', 'list', 'revoke'], description: '操作类型' },
        name: { type: 'string', description: '成果名称，例如“登录接口说明”' },
        path: { type: 'string', description: 'publish 时的文件路径（相对当前工作区）' },
        status: { type: 'string', enum: ['draft', 'ready'], description: 'publish：草稿或已可使用' },
        version: { type: 'number', description: 'publish 可省略（自动递增）；read/revoke 可指定版本' },
        summary: { type: 'string', description: '一句话说明这版改了什么、谁该使用' },
        reason: { type: 'string', description: 'revoke 时的撤回原因' }
      },
      required: ['action'],
      additionalProperties: false
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `成果${typeof input.name === 'string' && input.name.trim() ? ` · ${input.name}` : ''}`
  },
  async execute(input, ctx): Promise<ReturnType<typeof okResult>> {
    const port = ctx.collaborationArtifacts
    const projectId = ctx.projectId ?? ctx.superAgentState?.projectId
    if (!port || !projectId || ctx.superMode !== true) {
      return errResult(
        '成果版本只在 Super-Agent 项目里可用。',
        '开启 Super-Agent 并先派发任务后，再由成员发布或读取成果。'
      )
    }
    const action = typeof input.action === 'string' ? input.action : ''
    if (action === 'list') {
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined
      const artifacts = port.list(projectId, name)
      if (artifacts.length === 0) return okResult('项目里还没有发布过成果。', { artifacts: [] })
      return okResult(`项目成果：\n${artifacts.map(formatArtifactLine).join('\n')}`, {
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          name: artifact.name,
          version: artifact.version,
          status: artifact.status,
          path: artifact.path
        }))
      })
    }
    if (action === 'publish') {
      let name: string
      let path: string
      let status: 'draft' | 'ready'
      try {
        name = getString(input, 'name', { required: true, maxLength: ARTIFACT_NAME_MAX })
        path = getString(input, 'path', { required: true, maxLength: 400 })
        const rawStatus = getString(input, 'status', { required: true, maxLength: 20 })
        if (rawStatus !== 'draft' && rawStatus !== 'ready') {
          return errResult('status 只能是 draft（草稿）或 ready（已可使用）。', '发布前确认这版能不能交给别人使用。')
        }
        status = rawStatus
      } catch (error) {
        if (error instanceof Error) return errResult(error.message, '写清成果名称、文件路径和可用状态。')
        throw error
      }
      if (!ctx.workspace) {
        return errResult('当前没有工作区，无法发布成果。', '先在带文件夹的工作会话里运行任务。')
      }
      const summary =
        typeof input.summary === 'string' && input.summary.trim()
          ? truncateText(input.summary.trim(), ARTIFACT_SUMMARY_MAX)
          : undefined
      const version = input.version === undefined ? undefined : getNumber(input, 'version', { min: 1, max: 9999 })
      const result = await port.publish({
        projectId,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        ...(ctx.attemptId ? { attemptId: ctx.attemptId } : {}),
        name,
        path,
        workspace: ctx.workspace,
        ...(version !== undefined ? { version } : {}),
        status,
        ...(summary ? { summary } : {})
      })
      ctx.emit({ type: 'super_updated', state: result.state })
      const lines = [
        `已发布「${name}」v${result.artifact.version}（${status === 'ready' ? '已可使用' : '草稿，依赖成员不会提前开工'}）。`,
        `文件：${result.artifact.path} · 哈希 ${result.artifact.hash.slice(0, 12)}`,
        result.staleTaskIds.length > 0
          ? `使用旧版、需要更新或重测的任务：${result.staleTaskIds.length} 个；旧版结果不能给新版签字。`
          : '',
        result.restoredTaskIds.length > 0 ? `撤回后恢复为无需重测的任务：${result.restoredTaskIds.length} 个。` : ''
      ].filter(Boolean)
      return okResult(lines.join('\n'), {
        artifactId: result.artifact.id,
        name: result.artifact.name,
        version: result.artifact.version,
        status: result.artifact.status,
        path: result.artifact.path,
        staleTaskIds: result.staleTaskIds,
        restoredTaskIds: result.restoredTaskIds
      })
    }
    if (action === 'read') {
      let name: string
      try {
        name = getString(input, 'name', { required: true, maxLength: ARTIFACT_NAME_MAX })
      } catch (error) {
        if (error instanceof Error) return errResult(error.message, '写明要读取的成果名称。')
        throw error
      }
      const version = input.version === undefined ? undefined : getNumber(input, 'version', { min: 1, max: 9999 })
      const result = await port.read({
        projectId,
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        ...(ctx.attemptId ? { attemptId: ctx.attemptId } : {}),
        name,
        ...(version !== undefined ? { version } : {})
      })
      if (result.usage) ctx.emit({ type: 'super_updated', state: result.state })
      return okResult(
        [
          `已读取「${result.artifact.name}」v${result.artifact.version}（可用）。`,
          `文件：${result.artifact.path}`,
          result.artifact.summary ? `摘要：${result.artifact.summary}` : '',
          '内容：',
          truncateText(result.content, ARTIFACT_CONTENT_MAX)
        ]
          .filter(Boolean)
          .join('\n'),
        {
          name: result.artifact.name,
          version: result.artifact.version,
          status: result.artifact.status,
          path: result.artifact.path,
          usageRecorded: Boolean(result.usage)
        }
      )
    }
    if (action === 'revoke') {
      if (ctx.taskId) {
        return errResult(
          'Worker 不能撤回成果版本。',
          '请把问题写在结论里，由 Router 或用户在面板撤回这一版；旧成果和使用记录会保留。'
        )
      }
      let name: string
      let version: number
      try {
        name = getString(input, 'name', { required: true, maxLength: ARTIFACT_NAME_MAX })
        version = Math.round(getNumber(input, 'version', { required: true, min: 1, max: 9999 }))
      } catch (error) {
        if (error instanceof Error) return errResult(error.message, '写明要撤回的成果名称和版本。')
        throw error
      }
      const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : undefined
      const result = await port.revoke({ projectId, name, version, ...(reason ? { reason } : {}) })
      ctx.emit({ type: 'super_updated', state: result.state })
      return okResult(
        `已撤回「${name}」v${version} 的可用标记；旧成果与使用记录保留。${result.restoredTaskIds.length > 0 ? ` ${result.restoredTaskIds.length} 个任务不再需要因这一版重测。` : ''}`,
        {
          name,
          version,
          status: result.artifact.status,
          staleTaskIds: result.staleTaskIds,
          restoredTaskIds: result.restoredTaskIds
        }
      )
    }
    return errResult('未知的成果操作。', 'action 只能是 publish、read、list 或 revoke。')
  }
}

/** 计划输入的规范化结果；工具层已完成基础类型/长度校验。 */
export interface PlanTaskInput {
  id: string
  index: number
  title: string
  prompt: string
  promptFull: string
  deliverable: string
  files: string[]
  needs: PlanNeed[]
  dependsOn: string[]
  waitReason?: string
  role: string
  roleTitle?: string
  context?: string
  /** 独立验收任务：检查候选版本的文件与验收命令 */
  verify?: PlanVerification
  /** 被验收的任务 key；缺省等于 dependsOn */
  verifies?: string[]
}

export interface CompilePlanRequest {
  projectId: string
  runId: string
  goal: string
  tasks: PlanTaskInput[]
  /** 局部修订时提供当前项目状态；首次计划为空 */
  current?: SuperAgentState | null
  /** 只有扩展现有计划时才允许复用任务 id */
  revisionOf?: 'current'
}

export interface CompiledPlan {
  state: SuperAgentState
  /** 本次需要执行的任务（新任务或受影响任务） */
  affectedKeys: string[]
  /** 原样复用的任务（已完成/未受影响，不重跑） */
  reusedKeys: string[]
  /** 原计划中已移除的任务 */
  removedKeys: string[]
  /** 修订前仍在运行、必须先停止的受影响/移除任务 */
  stopKeys: string[]
  /** 计划内容是否变化；false 时调用方不应发布新计划 */
  changed: boolean
  hasWork: boolean
  planRevision: number
}

export class PlanCompileError extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = 'PlanCompileError'
    this.hint = hint
  }
}

const MAX_PLAN_TASKS = 10
const MAX_HISTORY = 5

function normalizedNeeds(input: PlanTaskInput): PlanNeed[] {
  const seen = new Set<string>()
  const artifacts = new Set<string>()
  const needs: PlanNeed[] = []
  for (const need of input.needs) {
    const taskId = need.taskId.trim()
    const result = need.result.trim()
    if (!taskId || !result) continue
    if (seen.has(taskId)) continue
    seen.add(taskId)
    const artifact = need.artifact?.trim()
    if (artifact) {
      if (artifacts.has(artifact)) continue
      artifacts.add(artifact)
    }
    needs.push({
      taskId,
      result,
      ...(artifact ? { artifact } : {}),
      ...(artifact && need.artifactVersion && need.artifactVersion > 1
        ? { artifactVersion: Math.round(need.artifactVersion) }
        : {})
    })
  }
  return needs
}

export function planWaitReason(input: PlanTaskInput, titleById?: Map<string, string>): string | undefined {
  const explicit = input.waitReason?.trim()
  if (explicit) return explicit
  if (input.dependsOn.length === 0) return undefined
  if (input.verify) {
    return `等待 ${input.dependsOn
      .map((id) => titleById?.get(id) ?? id)
      .join('、')} 完成后，在合并出的候选版本上运行验收`
  }
  const needs = normalizedNeeds(input)
  if (needs.length === 0) return undefined
  return `等待 ${needs
    .map((need) =>
      `${titleById?.get(need.taskId) ?? need.taskId} 的「${need.result}」${
        need.artifact ? `（${need.artifact} v${need.artifactVersion ?? 1} 发布为可用后即可先开工）` : ''
      }`
    )
    .join('；')}`
}

function taskSpecFingerprint(input: {
  prompt: string
  deliverable: string
  files: string[]
  needs: PlanNeed[]
  dependsOn: string[]
  role: string
  verify?: PlanVerification
  verifies?: string[]
}): string {
  return stableCollaborationHash(
    JSON.stringify({
      prompt: input.prompt.trim(),
      deliverable: input.deliverable.trim(),
      files: [...input.files].map((file) => file.trim()).filter(Boolean).sort(),
      needs: [...input.needs]
        .map(
          (need) =>
            `${need.taskId.trim()}:${need.result.trim()}:${need.artifact?.trim() ?? ''}:${need.artifactVersion ?? 1}`
        )
        .sort(),
      dependsOn: [...input.dependsOn].sort(),
      role: input.role,
      verify: input.verify
        ? {
            files: [...input.verify.files].sort(),
            command: input.verify.command ?? '',
            maxReworks: input.verify.maxReworks ?? 2,
            timeoutMs: input.verify.timeoutMs ?? 120_000
          }
        : null,
      verifies: [...(input.verifies ?? [])].sort()
    })
  )
}

function inputFingerprint(input: PlanTaskInput): string {
  return taskSpecFingerprint({
    prompt: input.promptFull || input.prompt,
    deliverable: input.deliverable,
    files: input.files,
    needs: normalizedNeeds(input),
    dependsOn: input.dependsOn,
    role: input.role,
    ...(input.verify ? { verify: input.verify } : {}),
    ...(input.verifies ? { verifies: input.verifies } : {})
  })
}

function taskFingerprint(task: SuperTask): string {
  return taskSpecFingerprint({
    prompt: task.promptFull ?? task.prompt,
    deliverable: task.deliverable ?? '',
    files: task.files ?? [],
    needs: task.needs ?? [],
    dependsOn: task.dependsOn,
    role: task.role,
    ...(task.verify ? { verify: task.verify } : {}),
    ...(task.verifies ? { verifies: task.verifies } : {})
  })
}

/** 拒绝缺交付物、缺前置结果、重复 id 与环；所有校验在写盘/停止任务之前完成。 */
export function validatePlanInput(tasks: PlanTaskInput[], revision: boolean): void {
  if (tasks.length < 1 || tasks.length > MAX_PLAN_TASKS) {
    throw new PlanCompileError(`计划需要 1–${MAX_PLAN_TASKS} 个任务。`, '把目标拆成可独立验收的任务。')
  }
  const ids = new Set<string>()
  const verifyIds = new Set(tasks.filter((task) => task.verify).map((task) => task.id))
  for (const task of tasks) {
    if (revision && !task.id.trim()) {
      throw new PlanCompileError('修订计划时每一项都必须保留稳定 id。', '复用原任务 id；新增任务使用新的小写 id。')
    }
    if (!task.deliverable.trim()) {
      throw new PlanCompileError(`任务「${task.title}」没有写清要交什么。`, '为每项任务填写 deliverable（可验收的具体成果）。')
    }
    if (ids.has(task.id)) {
      throw new PlanCompileError(`任务 id「${task.id}」重复。`, '每个任务使用唯一 id。')
    }
    ids.add(task.id)
    const depSet = new Set(task.dependsOn)
    if (depSet.size !== task.dependsOn.length) {
      throw new PlanCompileError(`任务「${task.title}」重复声明了同一个依赖。`, 'depends_on 每项只写一次。')
    }
    if (depSet.has(task.id)) {
      throw new PlanCompileError(`任务「${task.title}」不能依赖自己。`, '检查 depends_on，拆掉自依赖。')
    }
    if (task.verify) {
      if (task.dependsOn.length === 0) {
        throw new PlanCompileError(
          `验收任务「${task.title}」没有要验收的对象。`,
          '为验收任务写 depends_on，指向被验收的任务。'
        )
      }
      if (task.verify.files.length === 0 || task.verify.files.length > 20) {
        throw new PlanCompileError(`验收任务「${task.title}」需要 1–20 个必需文件。`, '把真正要交付的文件写进 verify.files。')
      }
      for (const file of task.verify.files) {
        if (!file.trim() || /^([A-Za-z]:|\\\\|\/)/.test(file) || file.split(/[\\/]/).includes('..')) {
          throw new PlanCompileError(`验收文件「${file}」必须是工作区内的相对路径。`, '使用 docs/result.md 这样的相对路径。')
        }
      }
      if (task.verify.command !== undefined && (!task.verify.command.trim() || task.verify.command.length > 2000)) {
        throw new PlanCompileError(`验收任务「${task.title}」的命令为空或过长。`, '写一条能在候选版本上真实运行的验收命令。')
      }
      if (task.verify.command && !isSafeVerificationCommand(task.verify.command)) {
        throw new PlanCompileError(
          `验收任务「${task.title}」的命令不在安全测试命令范围内。`,
          '验收命令只允许 node --test、npm test、pytest、cargo test、go test 等测试运行器；可以写 cd <项目目录> && node --test，或追加 2>&1；不要用验收绕过 Worker 的命令权限。'
        )
      }
      const maxReworks = task.verify.maxReworks ?? 2
      if (!Number.isInteger(maxReworks) || maxReworks < 0 || maxReworks > 5) {
        throw new PlanCompileError(`验收任务「${task.title}」的自动返工次数必须是 0–5。`, '默认 2 次；超过后交给负责人决定。')
      }
      const timeoutMs = task.verify.timeoutMs ?? 120_000
      if (timeoutMs < 5_000 || timeoutMs > 10 * 60_000) {
        throw new PlanCompileError(`验收任务「${task.title}」的命令超时应在 5 秒到 10 分钟之间。`, '调整 verify.timeout_ms。')
      }
      const verifies = task.verifies?.length ? task.verifies : task.dependsOn
      if (new Set(verifies).size !== verifies.length) {
        throw new PlanCompileError(`验收任务「${task.title}」重复声明了同一个验收对象。`, 'verifies 每项只写一次。')
      }
      for (const key of verifies) {
        if (!depSet.has(key)) {
          throw new PlanCompileError(
            `验收任务「${task.title}」要验收的「${key}」不在 depends_on 里。`,
            '验收对象必须同时是前置依赖。'
          )
        }
        if (verifyIds.has(key)) {
          throw new PlanCompileError(`验收任务「${task.title}」不能再验收另一个验收任务。`, '只验收真正产出交付物的任务。')
        }
      }
    }
    const needs = normalizedNeeds(task)
    const needIds = new Set(needs.map((need) => need.taskId))
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        // 后面的任务可能还没入集合，这里只检查跨项引用是否存在
        if (!tasks.some((entry) => entry.id === dep)) {
          throw new PlanCompileError(`任务「${task.title}」依赖了不存在的任务「${dep}」。`, 'depends_on 只能引用同一计划里的 id。')
        }
      }
      if (!task.verify && !needIds.has(dep)) {
        throw new PlanCompileError(
          `任务「${task.title}」没有写清需要「${dep}」的什么结果。`,
          '为每个依赖在 needs 里写 { task_id, result }，说明需要对方交付的具体内容。'
        )
      }
    }
    for (const need of needs) {
      if (!depSet.has(need.taskId)) {
        throw new PlanCompileError(
          `任务「${task.title}」的 needs 引用了未在 depends_on 声明的「${need.taskId}」。`,
          'needs 与 depends_on 必须一一对应。'
        )
      }
      if (need.artifact && need.artifact.length > 80) {
        throw new PlanCompileError(`任务「${task.title}」的成果名过长。`, '成果名控制在 80 个字符以内。')
      }
    }
    if (depSet.size > 0 && !planWaitReason(task)) {
      throw new PlanCompileError(`任务「${task.title}」缺少等待理由。`, '有依赖的任务必须写清为什么必须等。')
    }
  }

  // Kahn 拓扑：环意味着两个任务互相等待，必须拒绝而不是运行一半。
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]))
  const queue = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const task of tasks) {
      if (!task.dependsOn.includes(id)) continue
      const next = (indegree.get(task.id) ?? 0) - 1
      indegree.set(task.id, next)
      if (next === 0) queue.push(task.id)
    }
  }
  if (visited !== tasks.length) {
    const stuck = tasks.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((task) => task.id)
    throw new PlanCompileError(
      `计划里存在互相等待：${stuck.join('、')}。`,
      '拆掉循环依赖；本次更改不会生效，上一版计划保持不变。'
    )
  }
}

function snapshotOf(revision: number, goal: string, tasks: PlanTaskInput[], at: number): PlanRevisionSnapshot {
  const titleById = new Map(tasks.map((task) => [task.id, task.title]))
  return {
    revision,
    at,
    goal,
    tasks: tasks.map((task) => ({
      key: task.id,
      title: task.title,
      deliverable: task.deliverable,
      files: [...task.files],
      dependsOn: [...task.dependsOn],
      needs: normalizedNeeds(task).map((need) => ({ ...need })),
      ...(planWaitReason(task, titleById) ? { waitReason: planWaitReason(task, titleById)! } : {}),
      ...(task.verify ? { verify: { ...task.verify, files: [...task.verify.files] } } : {}),
      ...(task.verifies ? { verifies: [...task.verifies] } : {})
    }))
  }
}

function planOnlyTasks(tasks: SuperTask[]): SuperTask[] {
  return tasks.filter((task) => task.planRemoved !== true)
}

function statusForPlan(tasks: SuperTask[]): SuperAgentState['status'] {
  const active = planOnlyTasks(tasks)
  if (active.some((task) => task.status === 'running' || task.status === 'queued')) return 'running'
  if (active.length > 0 && active.every((task) => task.status === 'completed')) {
    return active.some((task) => task.needsRetest) ||
      active.some((task) => task.verify && task.verification?.status !== 'passed')
      ? 'partial'
      : 'completed'
  }
  const completed = active.filter((task) => task.status === 'completed' && !task.needsRetest).length
  const cancelled = active.filter((task) => task.status === 'cancelled').length
  if (completed > 0) return 'partial'
  if (active.length > 0 && cancelled === active.length) return 'cancelled'
  return 'failed'
}

/**
 * 把一份新计划编译成项目状态。
 * - 首次计划：全部 queued。
 * - revision_of=current：按稳定 id 复用未受影响任务；改动任务追加新 attempt；
 *   受影响任务的下游一起失效；脱离计划的运行中任务会被标记为待停止。
 * - 校验失败抛 PlanCompileError，不产生任何状态变更。
 */
export function compilePlan(request: CompilePlanRequest): CompiledPlan {
  const revisionMode = request.revisionOf === 'current'
  validatePlanInput(request.tasks, revisionMode)
  const current = revisionMode ? request.current ?? null : null
  if (revisionMode && !current) {
    throw new PlanCompileError('没有找到可以修订的当前计划。', '首次派工不要传 revision_of；先创建计划。')
  }
  if (revisionMode && current?.projectId && current.projectId !== request.projectId) {
    throw new PlanCompileError('当前计划属于另一个项目。', '只能在同一个项目内修订计划。')
  }
  const titleById = new Map(request.tasks.map((task) => [task.id, task.title]))

  const currentByKey = new Map<string, SuperTask>()
  for (const task of current?.tasks ?? []) {
    currentByKey.set(task.planKey ?? task.id, task)
  }
  const affected = new Set<string>()
  const matchedByKey = new Map<string, SuperTask>()
  for (const input of request.tasks) {
    const matched = currentByKey.get(input.id)
    if (!matched) {
      affected.add(input.id)
      continue
    }
    matchedByKey.set(input.id, matched)
    if (matched.planRemoved || taskFingerprint(matched) !== inputFingerprint(input)) {
      affected.add(input.id)
    }
  }

  // 依赖结果变了，下游完成结论也失效；只沿真实依赖边传播，不碰无关任务。
  let propagated = true
  while (propagated) {
    propagated = false
    for (const input of request.tasks) {
      if (affected.has(input.id)) continue
      if (input.dependsOn.some((dep) => affected.has(dep))) {
        affected.add(input.id)
        propagated = true
      }
    }
  }

  const removed = (current?.tasks ?? []).filter(
    (task) => !task.planRemoved && !request.tasks.some((input) => input.id === (task.planKey ?? task.id))
  )
  const stopKeys: string[] = []
  for (const input of request.tasks) {
    const matched = matchedByKey.get(input.id)
    if (affected.has(input.id) && matched?.status === 'running') stopKeys.push(input.id)
  }
  for (const task of removed) {
    if (task.status === 'running') stopKeys.push(task.planKey ?? task.id)
  }

  const now = Date.now()
  const metadataChanged =
    request.tasks.some((input) => {
      const matched = matchedByKey.get(input.id)
      if (!matched) return true
      return (
        matched.title !== input.title ||
        matched.deliverable !== input.deliverable ||
        JSON.stringify(matched.files ?? []) !== JSON.stringify(input.files) ||
        (matched.waitReason ?? '') !== (planWaitReason(input, titleById) ?? '') ||
        (matched.needs ?? []).length !== normalizedNeeds(input).length
      )
    }) || removed.length > 0
  const contentChanged = affected.size > 0 || removed.length > 0 || metadataChanged
  const planRevision = current
    ? Math.max(1, current.planRevision ?? 1) + (contentChanged ? 1 : 0)
    : 1
  const changed = revisionMode ? contentChanged : true

  const tasks: SuperTask[] = request.tasks.map((input) => {
    const matched = matchedByKey.get(input.id)
    const needs = normalizedNeeds(input)
    const waitReason = planWaitReason(input, titleById)
    const taskId = matched?.taskId ?? collaborationTaskId(request.projectId, request.runId, input.id)
    const base: SuperTask = {
      ...(matched ?? {}),
      id: input.id,
      taskId,
      planKey: input.id,
      index: input.index,
      title: input.title,
      prompt: input.prompt,
      promptFull: input.promptFull,
      deliverable: input.deliverable,
      files: [...input.files],
      needs: needs.map((need) => ({ ...need })),
      ...(waitReason ? { waitReason } : {}),
      ...(input.verify
        ? {
            verify: {
              files: [...input.verify.files],
              ...(input.verify.command ? { command: input.verify.command } : {}),
              ...(input.verify.maxReworks !== undefined ? { maxReworks: input.verify.maxReworks } : {}),
              ...(input.verify.timeoutMs !== undefined ? { timeoutMs: input.verify.timeoutMs } : {})
            }
          }
        : { verify: undefined }),
      ...(input.verify
        ? { verifies: [...(input.verifies?.length ? input.verifies : input.dependsOn)] }
        : { verifies: undefined }),
      planRemoved: undefined,
      role: input.role,
      ...(input.roleTitle ? { roleTitle: input.roleTitle } : {}),
      status: matched?.status ?? 'queued',
      dependsOn: [...input.dependsOn],
      attempts: matched?.attempts ?? 0,
      attemptHistory: [...(matched?.attemptHistory ?? [])],
      statusHistory: [...(matched?.statusHistory ?? [])],
      ...(matched?.currentAttemptId ? { currentAttemptId: matched.currentAttemptId } : {}),
      ...(matched?.startedAt ? { startedAt: matched.startedAt } : {}),
      ...(matched?.lastActivityAt ? { lastActivityAt: matched.lastActivityAt } : {}),
      ...(matched?.stepCount !== undefined ? { stepCount: matched.stepCount } : {}),
      ...(matched?.operations ? { operations: matched.operations.map((operation) => ({ ...operation })) } : {})
    }
    if (!matched) {
      base.statusHistory = [
        {
          id: `${taskId}:plan:${planRevision}:waiting`,
          taskId,
          to: 'waiting',
          at: now,
          source: 'router',
          reason: '新计划任务，等待依赖或并行名额'
        }
      ]
      return base
    }
    if (!affected.has(input.id)) {
      // 未受影响：保留状态和成果，只更新计划元数据。
      return base
    }
    // 受影响：保留身份和尝试历史，重新排队并追加新 attempt。
    const from = superTaskCollaborationStatus(matched.status)
    base.status = 'queued'
    base.summary = undefined
    base.error = undefined
    base.stepCount = undefined
    base.finishedAt = undefined
    base.operations = []
    base.waitingForApproval = undefined
    base.waitingApprovalSince = undefined
    base.verification = undefined
    base.reworkFeedback = undefined
    base.reworkCount = undefined
    base.note = '需求变更，等待重新执行'
    recordCollaborationStatus(base, {
      id: `${taskId}:replan:${planRevision}:${input.id}`,
      taskId,
      from,
      to: 'waiting',
      at: now,
      source: 'user',
      reason: '需求变更，重新排队；下一轮用新简报执行'
    })
    return base
  })

  for (const task of removed) {
    const clone: SuperTask = {
      ...task,
      planRemoved: true,
      note: '已从最新计划移除',
      ...(task.status === 'running' || task.status === 'queued'
        ? {
            status: 'cancelled' as const,
            error: '需求变更，这项任务已从计划移除。',
            finishedAt: now
          }
        : {})
    }
    if (clone.status === 'cancelled' && task.status !== 'cancelled') {
      recordCollaborationStatus(clone, {
        id: `${task.taskId ?? task.id}:replan-removed:${planRevision}`,
        taskId: task.taskId ?? task.id,
        from: superTaskCollaborationStatus(task.status),
        to: 'cancelled',
        at: now,
        source: 'user',
        reason: '需求变更，这项任务已从计划移除'
      })
    }
    tasks.push(clone)
  }

  const history = [
    ...(current?.planHistory ?? []),
    ...(changed ? [snapshotOf(planRevision, request.goal, request.tasks, now)] : [])
  ].slice(-MAX_HISTORY)
  const state: SuperAgentState = {
    runId: request.runId,
    projectId: request.projectId,
    revision: (current?.revision ?? 0) + 1,
    planRevision,
    planHistory: history,
    goal: request.goal,
    status: statusForPlan(tasks),
    tasks,
    ...(current?.usage ? { usage: { ...current.usage } } : {}),
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  }
  const hasWork = tasks.some((task) => task.status === 'queued' && task.planRemoved !== true)
  return {
    state,
    affectedKeys: [...affected],
    reusedKeys: request.tasks.filter((input) => !affected.has(input.id)).map((input) => input.id),
    removedKeys: removed.map((task) => task.planKey ?? task.id),
    stopKeys,
    changed,
    hasWork,
    planRevision: changed ? planRevision : current?.planRevision ?? 1
  }
}

export const TRACE_DEFAULT_CHARS = 4_000
export const TRACE_MAX_CHARS = 12_000

function taskTitle(state: SuperAgentState, id: string | undefined): string | undefined {
  if (!id) return undefined
  return state.tasks.find((task) => taskKey(task) === id || task.id === id || task.planKey === id)?.title
}

function latestVersion(artifacts: readonly CollaborationArtifact[], name: string): number | undefined {
  return latestReadyArtifact(artifacts, name)?.version
}

function artifactsForVerification(
  artifacts: readonly CollaborationArtifact[],
  record: CollaborationVerification
): CollaborationArtifact[] {
  const found = new Map<string, CollaborationArtifact>()
  for (const file of record.files) {
    if (!file.hash) continue
    for (const artifact of artifacts) {
      if (artifact.path === file.path && artifact.hash === file.hash) found.set(artifact.id, artifact)
    }
  }
  return [...found.values()]
}

function applicableLabels(artifacts: readonly CollaborationArtifact[]): string[] {
  return artifacts.map((artifact) => `${artifact.name} v${artifact.version}`)
}

function isVersionCurrent(artifacts: readonly CollaborationArtifact[], artifact: CollaborationArtifact): boolean {
  return artifact.status === 'ready' && latestVersion(artifacts, artifact.name) === artifact.version
}

function verificationStale(
  artifacts: readonly CollaborationArtifact[],
  record: CollaborationVerification,
  matched: CollaborationArtifact[]
): boolean {
  if (record.status === 'stale' || record.status === 'review') return true
  return matched.some((artifact) => (latestVersion(artifacts, artifact.name) ?? artifact.version) > artifact.version)
}

function entryLinkArtifact(artifact: CollaborationArtifact): CollaborationTraceLink {
  return {
    kind: 'artifact',
    id: artifact.id,
    label: `${artifact.name} v${artifact.version}`,
    version: artifact.version,
    name: artifact.name,
    ...(artifact.taskId ? { taskId: artifact.taskId } : {}),
    path: artifact.path
  }
}

/** 从当前项目状态生成可追溯记录；默认只有短摘要，完整内容由服务按需读取。 */
export function buildTraceEntries(state: SuperAgentState): CollaborationTraceEntry[] {
  const artifacts = state.artifacts ?? []
  const tasks = state.tasks.filter((task) => task.planRemoved !== true)
  const entries: CollaborationTraceEntry[] = []
  const verificationLinksByArtifact = new Map<string, CollaborationTraceLink[]>()

  const verificationRecords: Array<{ task: SuperTask; record: CollaborationVerification }> = []
  for (const task of tasks) {
    const seen = new Set<string>()
    for (const record of [
      ...(task.verificationHistory ?? []),
      ...(task.verification ? [task.verification] : [])
    ]) {
      if (seen.has(record.id)) continue
      seen.add(record.id)
      verificationRecords.push({ task, record })
    }
  }

  for (const { task, record } of verificationRecords) {
    const matched = artifactsForVerification(artifacts, record)
    const stale = verificationStale(artifacts, record, matched)
    const labels = applicableLabels(matched)
    const authorLinks: CollaborationTraceLink[] = record.verifies.flatMap((key) => {
      const author = state.tasks.find((entry) => entry.id === key || entry.planKey === key || taskKey(entry) === key)
      if (!author) return []
      return [
        {
          kind: 'task' as const,
          id: taskKey(author),
          label: `任务「${author.title}」`,
          taskId: taskKey(author)
        }
      ]
    })
    const links: CollaborationTraceLink[] = [
      { kind: 'task', id: taskKey(task), label: `验收任务「${task.title}」`, taskId: taskKey(task) },
      ...authorLinks,
      ...matched.map(entryLinkArtifact)
    ]
    const id = `verification:${record.id}`
    for (const artifact of matched) {
      const list = verificationLinksByArtifact.get(artifact.id) ?? []
      list.push({ kind: 'verification', id, label: `验收 ${record.status} · ${record.candidateVersion}`, taskId: taskKey(task) })
      verificationLinksByArtifact.set(artifact.id, list)
    }
    entries.push({
      id,
      kind: record.status === 'passed' ? 'verification' : 'failure',
      title: `验收「${task.title}」${record.candidateVersion ? ` · ${record.candidateVersion}` : ''}`,
      summary: [
        record.status === 'passed'
          ? '验收通过'
          : record.status === 'review'
            ? '验收待负责人'
            : record.status === 'stale'
              ? '验收已失效'
              : '验收失败',
        record.command ? `命令退出码 ${record.command.exitCode ?? 'null'}` : '',
        labels.length > 0 ? `适用 ${labels.join('、')}` : record.candidateVersion ? `候选 ${record.candidateVersion}` : '',
        stale ? '当前已有更新版本，旧结论只作历史依据' : ''
      ]
        .filter(Boolean)
        .join(' · '),
      status: record.status,
      ...(record.candidateVersion ? { candidateVersion: record.candidateVersion } : {}),
      taskId: taskKey(task),
      taskTitle: task.title,
      createdAt: record.checkedAt,
      applicableVersions: labels,
      staleForCurrent: stale,
      links
    })
  }

  // Worker 自身失败（还没有验收记录）也保留成失败记录，便于从错误追到任务与成果。
  for (const task of tasks) {
    if (task.verification) continue
    if (!task.error || !['failed', 'stalled', 'blocked', 'cancelled'].includes(task.status)) continue
    const currentUsages = (task.artifactUsage ?? []).filter((usage) => usage.attemptId === task.currentAttemptId)
    const links: CollaborationTraceLink[] = [
      { kind: 'task', id: taskKey(task), label: `任务「${task.title}」`, taskId: taskKey(task) },
      ...currentUsages.map((usage) => ({
        kind: 'artifact' as const,
        id: usage.artifactId,
        label: `${usage.name} v${usage.version}`,
        version: usage.version,
        taskId: taskKey(task)
      }))
    ]
    entries.push({
      id: `failure:${taskKey(task)}`,
      kind: 'failure',
      title: `失败「${task.title}」`,
      summary: truncateText(task.error.replace(/\s+/g, ' '), 300),
      status: task.status,
      taskId: taskKey(task),
      taskTitle: task.title,
      createdAt: task.finishedAt ?? task.lastActivityAt ?? task.startedAt ?? 0,
      applicableVersions: currentUsages.map((usage) => `${usage.name} v${usage.version}`),
      staleForCurrent: false,
      links
    })
  }

  for (const artifact of artifacts) {
    const current = isVersionCurrent(artifacts, artifact)
    entries.push({
      id: `artifact:${artifact.id}`,
      kind: 'artifact',
      title: `${artifact.name} v${artifact.version}`,
      name: artifact.name,
      summary: [
        artifact.status === 'ready' ? '可用' : artifact.status === 'draft' ? '草稿' : '已撤回',
        artifact.path,
        artifact.summary ?? '',
        `${artifact.size} 字节`,
        current ? '当前版本' : '历史版本'
      ]
        .filter(Boolean)
        .join(' · '),
      status: artifact.status,
      version: artifact.version,
      ...(artifact.taskId ? { taskId: artifact.taskId } : {}),
      ...(taskTitle(state, artifact.taskId) ? { taskTitle: taskTitle(state, artifact.taskId)! } : {}),
      createdAt: artifact.publishedAt,
      applicableVersions: [`${artifact.name} v${artifact.version}`],
      staleForCurrent: !current,
      links: [
        ...(artifact.taskId
          ? [{ kind: 'task' as const, id: artifact.taskId, label: '发布任务', taskId: artifact.taskId }]
          : []),
        { kind: 'snapshot', id: artifact.id, label: '原始快照', path: artifact.snapshotPath },
        ...(verificationLinksByArtifact.get(artifact.id) ?? [])
      ]
    })
  }

  return entries.sort((a, b) => b.createdAt - a.createdAt)
}

/** 简短引用 vs 完整内容：用于衡量减少重复阅读的效果。 */
export function traceUsageOf(state: SuperAgentState, entries: CollaborationTraceEntry[]): CollaborationTraceUsage {
  const summaryChars = entries.reduce((sum, entry) => sum + entry.title.length + entry.summary.length, 0)
  const artifactChars = (state.artifacts ?? []).reduce((sum, artifact) => sum + Math.max(0, artifact.size), 0)
  const verificationChars = state.tasks.reduce(
    (sum, task) =>
      sum +
      (task.verificationHistory ?? []).reduce((inner, record) => inner + (record.command?.output.length ?? 0), 0) +
      (task.verification?.command?.output.length ?? 0),
    0
  )
  const feedbackChars = state.tasks.reduce((sum, task) => sum + (task.reworkFeedback?.length ?? 0), 0)
  const fullChars = artifactChars + verificationChars + feedbackChars
  return {
    summaryChars,
    fullChars,
    savedChars: Math.max(0, fullChars - summaryChars)
  }
}

export function formatTraceEntry(entry: CollaborationTraceEntry): string {
  const stale = entry.staleForCurrent ? '（历史依据）' : ''
  return `- [${entry.kind}] ${entry.title}${stale}\n  ${entry.summary}${entry.applicableVersions.length > 0 ? `\n  适用：${entry.applicableVersions.join('、')}` : ''}`
}

export function formatTaskTraceContent(task: SuperTask, state: SuperAgentState): string {
  const lines = [
    `任务：${task.title}`,
    `状态：${task.status} · 尝试 ${task.attempts} 次`,
    ...(task.summary ? [`结论：${task.summary}`] : []),
    ...(task.error ? [`错误：${task.error}`] : []),
    ...(task.reworkFeedback ? [`修复反馈：\n${task.reworkFeedback}`] : [])
  ]
  if (task.attemptHistory?.length) {
    lines.push('尝试记录：')
    for (const attempt of task.attemptHistory) {
      lines.push(
        `- 第 ${attempt.attempt} 次（${attempt.id}）：${attempt.status}${attempt.summary ? ` · ${attempt.summary}` : ''}${attempt.error ? ` · ${attempt.error}` : ''}`
      )
    }
  }
  if (task.artifactUsage?.length) {
    lines.push('成果使用：')
    for (const usage of task.artifactUsage) {
      lines.push(
        `- ${usage.name} v${usage.version} · ${usage.status} · 尝试 ${usage.attemptId} · ${new Date(usage.readAt).toISOString()}`
      )
    }
  }
  if (task.verificationHistory?.length) {
    lines.push('验收记录：')
    for (const record of task.verificationHistory) {
      lines.push(
        `- ${record.candidateVersion}：${record.status}${record.command ? ` · 退出码 ${record.command.exitCode ?? 'null'}` : ''}${record.error ? ` · ${record.error}` : ''}`
      )
    }
  }
  const relatedArtifacts = (state.artifacts ?? []).filter((artifact) => artifact.taskId === taskKey(task))
  if (relatedArtifacts.length > 0) {
    lines.push(`发布成果：${relatedArtifacts.map((artifact) => `${artifact.name} v${artifact.version}`).join('、')}`)
  }
  return lines.join('\n')
}

export const traceTool: ToolImpl = {
  definition: {
    name: 'trace',
    description:
      '追溯项目里的成果版本、失败记录、修复过程和验收结果：list 列出最近记录；artifact 按成果名/版本读取原始快照；verification 按候选版本或任务读取完整验收输出；task 读取尝试/修复/使用/验收记录。' +
      '默认只返回短摘要，完整内容按 offset/max_chars 分页读取；不能跨项目读取，原始文件缺失时会明确提示，不会用其他版本代替。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'artifact', 'verification', 'task'], description: '追溯类型' },
        project_id: { type: 'string', description: '可选；只能是当前项目，其他项目会被拒绝并记录' },
        name: { type: 'string', description: 'artifact：成果名称' },
        version: { type: 'number', description: 'artifact：成果版本' },
        task_id: { type: 'string', description: 'verification/task：任务编号或 plan key' },
        candidate_version: { type: 'string', description: 'verification：候选版本编号' },
        offset: { type: 'number', description: '完整内容起始字符（默认 0）' },
        max_chars: { type: 'number', description: '本次最多读取字符（默认 4000，最大 12000）' }
      },
      required: ['action'],
      additionalProperties: false
    },
    category: 'meta',
    risk: 'low',
    titleFor: (input) => `追溯${typeof input.name === 'string' ? ` · ${input.name}` : ''}`
  },
  async execute(input, ctx): Promise<ReturnType<typeof okResult>> {
    if (ctx.superMode !== true || !ctx.trace || !ctx.projectId) {
      return errResult('追溯只在 Super-Agent 项目里可用。', '开启 Super-Agent 并先派发任务后再查询。')
    }
    const action = typeof input.action === 'string' ? input.action : ''
    if (!['list', 'artifact', 'verification', 'task'].includes(action)) {
      return errResult('未知的追溯操作。', 'action 只能是 list、artifact、verification 或 task。')
    }
    const requestedProject = typeof input.project_id === 'string' && input.project_id.trim() ? input.project_id.trim() : ctx.projectId
    let query: CollaborationTraceQuery
    try {
      query = {
        action: action as CollaborationTraceQuery['action'],
        ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
        ...(input.version !== undefined ? { version: Math.round(getNumber(input, 'version', { min: 1, max: 9999 })) } : {}),
        ...(typeof input.task_id === 'string' && input.task_id.trim() ? { taskId: input.task_id.trim() } : {}),
        ...(typeof input.candidate_version === 'string' && input.candidate_version.trim()
          ? { candidateVersion: input.candidate_version.trim() }
          : {}),
        ...(input.offset !== undefined ? { offset: Math.max(0, Math.round(getNumber(input, 'offset', { min: 0, max: 10_000_000 }))) } : {}),
        ...(input.max_chars !== undefined
          ? { maxChars: Math.min(TRACE_MAX_CHARS, Math.max(200, Math.round(getNumber(input, 'max_chars', { min: 200, max: TRACE_MAX_CHARS })))) }
          : {})
      }
      if (action === 'artifact' && !query.name) {
        return errResult('追溯成果需要写明成果名称。', '例如 trace(action="artifact", name="登录接口说明", version=1)。')
      }
      if (action === 'task' && !query.taskId) {
        return errResult('追溯任务需要 task_id。', '使用面板里的任务编号。')
      }
      if (action === 'verification' && !query.candidateVersion && !query.taskId) {
        return errResult('追溯验收需要候选版本或 task_id。', '例如 trace(action="verification", candidate_version="cand_...")。')
      }
      const result = await ctx.trace.query({
        authorizedProjectId: ctx.projectId,
        requestedProjectId: requestedProject,
        query
      })
      if (!result.detail) {
        if (result.entries.length === 0) {
          return okResult('没有可追溯的记录。', { entries: [], usage: result.usage })
        }
        return okResult(
          [
            `项目追溯（最近 ${result.entries.length} 条）：`,
            ...result.entries.slice(0, 20).map(formatTraceEntry),
            `简短引用 ${result.usage.summaryChars} 字符，完整内容约 ${result.usage.fullChars} 字符。`
          ].join('\n'),
          { entries: result.entries, usage: result.usage }
        )
      }
      const detail = result.detail
      const header = `【追溯】${detail.entry.title}${detail.missing ? ' · 原始快照缺失' : ''}`
      const lines = [
        header,
        detail.entry.summary,
        ...(detail.entry.applicableVersions.length > 0 ? [`适用：${detail.entry.applicableVersions.join('、')}`] : []),
        ...(detail.entry.staleForCurrent ? ['这条记录是历史依据；当前版本已更新。'] : []),
        detail.missing
          ? '原始文件缺失，不能用其他版本代替。请让负责人重新发布或从独立副本核对。'
          : `内容（${detail.offset + 1}–${detail.offset + detail.content.length} / ${detail.totalChars} 字符）：\n${detail.content}`,
        ...(detail.nextOffset !== undefined
          ? [`还有后续内容；继续读取：trace(action="${query.action}", offset=${detail.nextOffset}${query.name ? `, name="${query.name}"` : ''}${query.version !== undefined ? `, version=${query.version}` : ''})`]
          : [])
      ]
      return okResult(lines.join('\n'), {
        entries: result.entries,
        detail,
        usage: result.usage
      })
    } catch (err) {
      return errResult(
        err instanceof Error ? err.message : '追溯失败。',
        '只能读取当前项目；请确认项目编号和权限。'
      )
    }
  }
}

export const DEFAULT_MAX_REWORKS = 2

const SAFE_VERIFICATION_COMMANDS = [
  /^node(?:\.exe)?\s+--test(\s|$)/i,
  /^npm\s+(run\s+)?test(\s|$)/i,
  /^npm\s+run\s+[\w:.-]*test[\w:.-]*(\s|$)/i,
  /^npx\s+(vitest|playwright|jest)(\s|$)/i,
  /^pnpm\s+(run\s+)?test(\s|$)/i,
  /^pnpm\s+run\s+[\w:.-]*test[\w:.-]*(\s|$)/i,
  /^yarn\s+(run\s+)?test(\s|$)/i,
  /^bun\s+test(\s|$)/i,
  /^pytest(\s|$)/i,
  /^python3?\s+-m\s+pytest(\s|$)/i,
  /^cargo\s+test(\s|$)/i,
  /^go\s+test(\s|$)/i,
  /^dotnet\s+test(\s|$)/i,
  /^mvn\s+(-q\s+)?test(\s|$)/i,
  /^(\.\/)?gradlew?\s+test(\s|$)/i
]
const UNSAFE_VERIFICATION_SHELL = /[;&|<>`$(){}]|(^|\s)(rm|del|erase|format|shutdown|curl|wget|powershell|pwsh|cmd|bash|sh|node\s+-e)\b/i
const SAFE_CD_PREFIX = /^cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|<>`$(){}]+)\s*(?:&&|;)\s*/i
const SAFE_REDIRECT_SUFFIX = /\s+2>&1\s*$|\s+2>(?:nul|\/dev\/null)\s*$/i

function normalizeVerificationCommand(command: string): string {
  let value = command.trim()
  for (let index = 0; index < 4; index += 1) {
    const match = value.match(SAFE_CD_PREFIX)
    if (!match) break
    value = value.slice(match[0].length).trim()
  }
  while (SAFE_REDIRECT_SUFFIX.test(value)) value = value.replace(SAFE_REDIRECT_SUFFIX, '').trim()
  return value
}

/** 验收命令只允许常见测试运行器；允许 cd 子目录和常见输出重定向，不允许借机执行其他命令。 */
export function isSafeVerificationCommand(command: string): boolean {
  const value = normalizeVerificationCommand(command)
  return SAFE_VERIFICATION_COMMANDS.some((pattern) => pattern.test(value)) && !UNSAFE_VERIFICATION_SHELL.test(value)
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '')
}

/** 候选版本包含：验收必需文件 + 被验收任务声明的交付文件。 */
export function verificationCandidateFiles(verifier: SuperTask, tasks: readonly SuperTask[]): {
  files: string[]
  required: string[]
} {
  const required = [...new Set((verifier.verify?.files ?? []).map(normalizePath).filter(Boolean))]
  const keys = verifier.verifies && verifier.verifies.length > 0 ? verifier.verifies : verifier.dependsOn
  const delivered = tasks
    .filter((task) => keys.includes(task.planKey ?? task.id))
    .flatMap((task) => task.files ?? [])
    .map(normalizePath)
    .filter(Boolean)
  return { files: [...new Set([...required, ...delivered])], required }
}

export function missingVerificationFiles(files: readonly CollaborationVerificationFile[]): string[] {
  return files.filter((file) => file.required && !file.exists).map((file) => file.path)
}

export function verificationFailureText(record: CollaborationVerification): string {
  const missing = missingVerificationFiles(record.files)
  const lines = [
    `候选版本 ${record.candidateVersion} 验收未通过。`,
    ...(missing.length > 0 ? [`缺少必需文件：${missing.join('、')}。`] : []),
    ...(record.command
      ? [
          `验收命令：${record.command.command}`,
          `退出码：${record.command.exitCode ?? 'null'}${record.command.timedOut ? '（超时）' : ''}`,
          record.command.output.trim() ? `输出预览：\n${truncateText(record.command.output.trim(), 600)}` : ''
        ]
      : []),
    ...(record.error ? [record.error] : []),
    `完整输出按需追溯：trace(action="verification", candidate_version="${record.candidateVersion}")；不要重复整段读取。`
  ]
  return lines.filter(Boolean).join('\n')
}

export function verificationReworkNote(record: CollaborationVerification): string {
  return [
    '上一次独立验收失败，请按下面的真实结果修复交付文件；修复后会重新合并并在新候选版本上复测。',
    verificationFailureText(record)
  ].join('\n\n')
}

/** 验收通过后文件又变了：旧结论必须失效。 */
export function verificationStaleReason(task: SuperTask, currentVersion: string): string | undefined {
  const verification = task.verification
  if (!task.verify || verification?.status !== 'passed') return undefined
  if (verification.candidateVersion === currentVersion) return undefined
  return `验收后交付文件已变化（原候选 ${verification.candidateVersion}，当前 ${currentVersion}）；旧验收结论已失效，需要重新验收。`
}

/**
 * 从命令里识别会被占用的本地端口。
 * 只认明确的端口写法，避免把时间、比例、版本号误判成端口。
 */
const PORT_PATTERNS: RegExp[] = [
  /(?:^|\s)--port(?:=|\s+)(\d{2,5})\b/gi,
  /(?:^|\s)-p\s+(\d{4,5})\b/g,
  /(?:^|\s)PORT(?:=|\s+)(\d{2,5})\b/gi,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/gi,
  /(?:^|\s):(\d{4,5})\b/g
]

export function detectCommandPorts(command: string): number[] {
  if (!command) return []
  const ports = new Set<number>()
  for (const pattern of PORT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      const port = Number(match[1])
      if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

export function portResource(port: number): string {
  return `port:${port}`
}

export interface StuckPolicy {
  enabled: boolean
  idleMs: number
  repeats: number
  steps: number
}

export type StuckDecisionKind = 'idle' | 'waiting' | 'progress' | 'stuck'

export interface StuckDecision {
  kind: StuckDecisionKind
  reason?: string
  lastEffectiveAt: number
  stepsSinceProgress: number
  repeatedCount: number
  lastOperation?: string
}

/**
 * 只读的卡住判断：重复相同操作或长时间没有“有效成果”时才提示。
 * 等用户批准会暂停判断（这段时间不算停滞）；一旦出现新写入/成果，立即清除重复计数。
 */
export class StuckTracker {
  private readonly seen = new Set<string>()
  private lastEffectiveAt: number
  private effectiveStep = 0
  private signature = ''
  private repeated = 0
  private stepsSinceProgress = 0
  private lastOperation: string | undefined
  private waitingSince: number | null = null

  constructor(
    readonly policy: StuckPolicy,
    startedAt: number
  ) {
    this.lastEffectiveAt = startedAt
  }

  /** 用户选择继续等待后重新计时：不立刻再次弹出同一条提醒。 */
  rearm(now: number, stepCount = 0): void {
    this.lastEffectiveAt = now
    this.effectiveStep = Math.max(0, Math.round(stepCount))
    this.stepsSinceProgress = 0
    this.repeated = 0
    this.signature = ''
  }

  observe(input: {
    now: number
    stepCount?: number
    waitingApproval: boolean
    operations?: SwarmOperation[]
  }): StuckDecision {
    const stepCount = Math.max(0, Math.round(input.stepCount ?? 0))
    if (input.waitingApproval) {
      // 审批等待期间暂停“没有有效进展”的计时，避免把正常等人误报成卡住。
      if (this.waitingSince === null) this.waitingSince = input.now
      return {
        kind: 'waiting',
        lastEffectiveAt: this.lastEffectiveAt,
        stepsSinceProgress: this.stepsSinceProgress,
        repeatedCount: this.repeated,
        ...(this.lastOperation ? { lastOperation: this.lastOperation } : {})
      }
    }
    if (this.waitingSince !== null) {
      // 审批等待不算“没有进展”：恢复后从当前步数重新累计，避免刚批准就误报。
      this.lastEffectiveAt += Math.max(0, input.now - this.waitingSince)
      this.effectiveStep = stepCount
      this.stepsSinceProgress = 0
      this.repeated = 0
      this.signature = ''
      this.waitingSince = null
    }
    let progressed = false
    for (const operation of input.operations ?? []) {
      if (this.seen.has(operation.id)) continue
      this.seen.add(operation.id)
      const label = operation.input ? `${operation.title}（${operation.input}）` : operation.title
      this.lastOperation = label
      if (operation.effective === true || operation.afterHash) {
        progressed = true
        this.lastEffectiveAt = input.now
        this.effectiveStep = stepCount
        this.signature = ''
        this.repeated = 0
        continue
      }
      const signature = `${operation.name}|${operation.input ?? ''}`
      if (signature === this.signature) this.repeated += 1
      else {
        this.signature = signature
        this.repeated = 1
      }
    }
    this.stepsSinceProgress = Math.max(0, stepCount - this.effectiveStep)
    if (progressed) {
      return {
        kind: 'progress',
        lastEffectiveAt: this.lastEffectiveAt,
        stepsSinceProgress: this.stepsSinceProgress,
        repeatedCount: this.repeated,
        ...(this.lastOperation ? { lastOperation: this.lastOperation } : {})
      }
    }
    if (!this.policy.enabled) {
      return {
        kind: 'idle',
        lastEffectiveAt: this.lastEffectiveAt,
        stepsSinceProgress: this.stepsSinceProgress,
        repeatedCount: this.repeated,
        ...(this.lastOperation ? { lastOperation: this.lastOperation } : {})
      }
    }
    const idleFor = input.now - this.lastEffectiveAt
    const repeatedEnough = this.repeated >= this.policy.repeats
    const stepsEnough = this.stepsSinceProgress >= this.policy.steps
    if (idleFor >= this.policy.idleMs && (repeatedEnough || stepsEnough)) {
      const idleText =
        idleFor >= 60_000
          ? `约 ${Math.max(1, Math.round(idleFor / 60_000))} 分钟`
          : `约 ${Math.max(1, Math.round(idleFor / 1000))} 秒`
      const reason = repeatedEnough
        ? `连续 ${this.repeated} 次执行相同操作，${this.stepsSinceProgress} 步没有产生新成果。`
        : `${idleText}没有新成果，累计 ${this.stepsSinceProgress} 步。`
      return {
        kind: 'stuck',
        reason,
        lastEffectiveAt: this.lastEffectiveAt,
        stepsSinceProgress: this.stepsSinceProgress,
        repeatedCount: this.repeated,
        ...(this.lastOperation ? { lastOperation: this.lastOperation } : {})
      }
    }
    return {
      kind: 'idle',
      lastEffectiveAt: this.lastEffectiveAt,
      stepsSinceProgress: this.stepsSinceProgress,
      repeatedCount: this.repeated,
      ...(this.lastOperation ? { lastOperation: this.lastOperation } : {})
    }
  }
}
