/** P1-10 工作区权限规则与审批日志 feature IPC。 */
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerFeatureHandler } from '../feature-ipc'
import { getPermissionRulesService } from '../services/permission-rules'
import type { PermissionRuleKind } from '../../shared/types'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function workspaceOf(input: Record<string, unknown>): string {
  const raw = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  if (!raw) throw new Error('缺少工作区路径。')
  const real = realpathSync(resolve(raw))
  if (!statSync(real).isDirectory()) throw new Error('工作区不是文件夹。')
  return real
}

registerFeatureHandler('feature:permissions:list-rules', (payload) => {
  const input = payloadOf(payload)
  return { rules: getPermissionRulesService().list(workspaceOf(input)) }
})

registerFeatureHandler('feature:permissions:add-rule', (payload) => {
  const input = payloadOf(payload)
  const workspace = workspaceOf(input)
  const tool = typeof input.tool === 'string' ? input.tool : ''
  const kind = input.kind as PermissionRuleKind
  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (input.decision !== 'allow' && input.decision !== 'deny') throw new Error('规则动作不合法。')
  return getPermissionRulesService().add({ workspace, tool, kind, pattern, decision: input.decision })
})

registerFeatureHandler('feature:permissions:remove-rule', (payload) => {
  const input = payloadOf(payload)
  const workspace = workspaceOf(input)
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
