/**
 * R10 功能模块注册清单（Lead 统一维护）。
 *
 * 两类模块：
 * - files / editor-history / connectors / search / terminal / media / sidechat / subscriptions / git / discovery / permissions：
 *   import 即注册（无 app ready 依赖）；
 * - memory / projects / skills / browser / schedules：在 app ready 后调用。
 *
 * 必须由 main/index.ts 在 app.whenReady() 内先 registerFeatureModules() 再 installFeatureIpc()。
 */
import { BrowserWindow, dialog } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerFeatureHandler } from '../feature-ipc'
import { discoverAgentRules } from '../services/agent-rules'
import { discoverCustomCommands } from '../services/command-service'
import { loadAgentRoles, summarizeAgentRoles } from '../services/custom-agents'
import { gitService } from '../services/git-service'
import { getPermissionRulesService } from '../services/permission-rules'
import { scheduledInputFromRecord } from '../services/schedule-store'
import {
  createSchedule,
  listSchedules,
  removeSchedule,
  runScheduleNow,
  setScheduleEnabled,
  updateSchedule
} from '../services/schedule-runtime'
import { getSubscriptionService, runSubscriptionAction } from '../services/subscriptions'
import type { PermissionRuleKind } from '../../shared/types'
import type { SubscriptionAction } from '../../shared/subscriptions'
import { resolveWorkspaceDir } from './workspace-roots'
import './files'
import './editor-history'
import './connectors'
import './search'
import './terminal'
import './media'
import './sidechat'
import { registerEvolutionFeature, registerMemoryFeature } from './memory'
import { registerProjectsFeature } from './projects'
import { registerSkillsFeature } from './skills'
import { registerBrowserFeature } from './browser'
import { warmSearchIndex } from './search'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/* ── 发现类：集群成员、自定义命令、规则文件 ─────────────────── */

function requestedWorkspace(input: Record<string, unknown>): string {
  return typeof input.workspace === 'string' ? input.workspace.trim() : ''
}

registerFeatureHandler('feature:agents:list', (payload) => {
  const requested = requestedWorkspace(payloadOf(payload))
  const workspace = requested
    ? resolveWorkspaceDir(requested, '集群成员角色只能读取已登记工作区内的配置。')
    : null
  return summarizeAgentRoles(loadAgentRoles(workspace))
})

registerFeatureHandler('feature:commands:list', (payload) => {
  const requested = requestedWorkspace(payloadOf(payload))
  const workspace = requested
    ? resolveWorkspaceDir(requested, '自定义命令只能读取已登记工作区内的项目命令。')
    : null
  return discoverCustomCommands(workspace)
})

registerFeatureHandler('feature:rules:list', (payload) => {
  const requested = requestedWorkspace(payloadOf(payload))
  // 只允许读取已登记工作区内的项目规则；不传工作区时仅返回用户级规则
  const workspace = requested
    ? resolveWorkspaceDir(requested, '规则文件只能读取已登记工作区内的项目规则。')
    : null
  const discovery = discoverAgentRules(workspace)
  return {
    files: discovery.files,
    usedTokens: discovery.usedTokens,
    limitTokens: discovery.limitTokens,
    truncated: discovery.truncated
  }
})

/* ── 工作区权限规则与审批日志 ───────────────────────────────── */

function permissionWorkspace(input: Record<string, unknown>): string {
  const raw = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  if (!raw) throw new Error('缺少工作区路径。')
  const real = realpathSync(resolve(raw))
  if (!statSync(real).isDirectory()) throw new Error('工作区不是文件夹。')
  return real
}

registerFeatureHandler('feature:permissions:list-rules', (payload) => {
  return { rules: getPermissionRulesService().list(permissionWorkspace(payloadOf(payload))) }
})

registerFeatureHandler('feature:permissions:add-rule', (payload) => {
  const input = payloadOf(payload)
  const workspace = permissionWorkspace(input)
  const tool = typeof input.tool === 'string' ? input.tool : ''
  const kind = input.kind as PermissionRuleKind
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (input.decision !== 'allow' && input.decision !== 'deny') throw new Error('规则动作不合法。')
  return getPermissionRulesService().add({ workspace, tool, kind, pattern, decision: input.decision })
})

registerFeatureHandler('feature:permissions:remove-rule', (payload) => {
  const input = payloadOf(payload)
  const workspace = permissionWorkspace(input)
  const id = typeof input.id === 'string' ? input.id : ''
  if (!id) throw new Error('缺少规则 id。')
  return { removed: getPermissionRulesService().remove(id, workspace) }
})

registerFeatureHandler('feature:permissions:list-log', (payload) => {
  const input = payloadOf(payload)
  const raw = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  let workspace: string | null = null
  if (raw) {
    try {
      workspace = realpathSync(resolve(raw))
    } catch {
      workspace = null
    }
  }
  return { entries: getPermissionRulesService().listLog(workspace) }
})

/* ── Git 工作台 ─────────────────────────────────────────────── */

function gitWorkspace(payload: unknown): string {
  const input = payloadOf(payload)
  return resolveWorkspaceDir(input.workspace ?? input.cwd, 'Git 操作只能在工作区内执行。')
}

/** 只有完全省略 path 才表示「全部」；传了非法值必须报错而不是退化成全部。 */
function gitPath(payload: unknown): unknown {
  const input = payloadOf(payload)
  return Object.prototype.hasOwnProperty.call(input, 'path') ? input.path : undefined
}

registerFeatureHandler('feature:git:status', (payload) => gitService.status(gitWorkspace(payload)))

registerFeatureHandler('feature:git:init', (payload) => gitService.init(gitWorkspace(payload)))

registerFeatureHandler('feature:git:diff', (payload) => {
  const input = payloadOf(payload)
  return gitService.diff(gitWorkspace(payload), input.path, input.staged === true)
})

registerFeatureHandler('feature:git:stage', (payload) => gitService.stage(gitWorkspace(payload), gitPath(payload)))

registerFeatureHandler('feature:git:unstage', (payload) => gitService.unstage(gitWorkspace(payload), gitPath(payload)))

registerFeatureHandler('feature:git:discard', (payload) => {
  const input = payloadOf(payload)
  return gitService.discard(gitWorkspace(payload), input.path)
})

registerFeatureHandler('feature:git:commit', (payload) => {
  const input = payloadOf(payload)
  return gitService.commit(gitWorkspace(payload), text(input.message), input.stageAll === true)
})

registerFeatureHandler('feature:git:set-identity', (payload) => {
  const input = payloadOf(payload)
  return gitService.setIdentity(gitWorkspace(payload), input.name, input.email)
})

registerFeatureHandler('feature:git:branches', (payload) => gitService.branches(gitWorkspace(payload)))

registerFeatureHandler('feature:git:checkout', (payload) => {
  const input = payloadOf(payload)
  return gitService.switchBranch(gitWorkspace(payload), input.branch)
})

registerFeatureHandler('feature:git:create-branch', (payload) => {
  const input = payloadOf(payload)
  return gitService.createBranch(gitWorkspace(payload), input.name)
})

registerFeatureHandler('feature:git:log', (payload) => gitService.log(gitWorkspace(payload)))

registerFeatureHandler('feature:git:show', (payload) => {
  const input = payloadOf(payload)
  return gitService.show(gitWorkspace(payload), input.hash)
})

/* ── 模型订阅 ───────────────────────────────────────────────── */

registerFeatureHandler('feature:subscriptions:status', async () => {
  return getSubscriptionService().status()
})

registerFeatureHandler('feature:subscriptions:action', async (payload) => {
  const input = payloadOf(payload)
  if (typeof input.action !== 'string') throw new Error('缺少订阅操作。')
  return runSubscriptionAction(input as SubscriptionAction)
})

registerFeatureHandler('feature:subscriptions:pick-codex-auth', async (_payload, event) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const options = {
    title: '选择 Codex CLI 登录文件（auth.json）',
    properties: ['openFile' as const],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
})

/* ── 定时任务 ───────────────────────────────────────────────── */

function scheduleRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('参数格式不正确')
  return payload as Record<string, unknown>
}

function scheduleId(payload: unknown): string {
  const id = scheduleRecord(payload).id
  if (typeof id !== 'string' || !id.trim()) throw new Error('缺少定时任务 id。')
  return id
}

registerFeatureHandler('feature:schedules:list', () => listSchedules())

registerFeatureHandler('feature:schedules:create', (payload) => createSchedule(scheduledInputFromRecord(payload)))

registerFeatureHandler('feature:schedules:update', (payload) => {
  const data = scheduleRecord(payload)
  return updateSchedule(scheduleId(data), scheduledInputFromRecord(data))
})

registerFeatureHandler('feature:schedules:remove', (payload) => removeSchedule(scheduleId(payload)))

registerFeatureHandler('feature:schedules:set-enabled', (payload) => {
  const data = scheduleRecord(payload)
  if (typeof data.enabled !== 'boolean') throw new Error('enabled 必须是布尔值。')
  return setScheduleEnabled(scheduleId(data), data.enabled)
})

registerFeatureHandler('feature:schedules:run-now', (payload) => runScheduleNow(scheduleId(payload)))

/* ── app ready 后注册的模块 ─────────────────────────────────── */

export function registerFeatureModules(): void {
  registerMemoryFeature(registerFeatureHandler)
  registerEvolutionFeature(registerFeatureHandler)
  registerProjectsFeature(registerFeatureHandler)
  registerSkillsFeature(registerFeatureHandler)
  registerBrowserFeature()
  warmSearchIndex()
}
