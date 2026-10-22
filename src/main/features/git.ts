/**
 * Git 工作台 feature IPC（P1-8）。
 * 工作区路径先经过统一边界校验，仓库根必须仍在该工作区内。
 */
import { registerFeatureHandler } from '../feature-ipc'
import { gitService } from '../services/git-service'
import { resolveWorkspaceDir } from './workspace-roots'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function workspaceOf(payload: unknown): string {
  const input = payloadOf(payload)
  return resolveWorkspaceDir(input.workspace ?? input.cwd, 'Git 操作只能在工作区内执行。')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

registerFeatureHandler('feature:git:status', (payload) => gitService.status(workspaceOf(payload)))

registerFeatureHandler('feature:git:init', (payload) => gitService.init(workspaceOf(payload)))

registerFeatureHandler('feature:git:diff', (payload) => {
  const input = payloadOf(payload)
  return gitService.diff(workspaceOf(payload), input.path, input.staged === true)
})

/** 只有完全省略 path 才表示「全部」；传了非法值必须报错而不是退化成全部。 */
function pathOf(payload: unknown): unknown {
  const input = payloadOf(payload)
  return Object.prototype.hasOwnProperty.call(input, 'path') ? input.path : undefined
}

registerFeatureHandler('feature:git:stage', (payload) => gitService.stage(workspaceOf(payload), pathOf(payload)))

registerFeatureHandler('feature:git:unstage', (payload) => gitService.unstage(workspaceOf(payload), pathOf(payload)))

registerFeatureHandler('feature:git:discard', (payload) => {
  const input = payloadOf(payload)
  return gitService.discard(workspaceOf(payload), input.path)
})

registerFeatureHandler('feature:git:commit', (payload) => {
  const input = payloadOf(payload)
  return gitService.commit(workspaceOf(payload), text(input.message), input.stageAll === true)
})

registerFeatureHandler('feature:git:set-identity', (payload) => {
  const input = payloadOf(payload)
  return gitService.setIdentity(workspaceOf(payload), input.name, input.email)
})

registerFeatureHandler('feature:git:branches', (payload) => gitService.branches(workspaceOf(payload)))

registerFeatureHandler('feature:git:checkout', (payload) => {
  const input = payloadOf(payload)
  return gitService.switchBranch(workspaceOf(payload), input.branch)
})

registerFeatureHandler('feature:git:create-branch', (payload) => {
  const input = payloadOf(payload)
  return gitService.createBranch(workspaceOf(payload), input.name)
})

registerFeatureHandler('feature:git:log', (payload) => gitService.log(workspaceOf(payload)))

registerFeatureHandler('feature:git:show', (payload) => {
  const input = payloadOf(payload)
  return gitService.show(workspaceOf(payload), input.hash)
})
