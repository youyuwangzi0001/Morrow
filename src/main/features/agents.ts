/** 子代理角色列表（设置页展示；内置 + 自定义）。 */
import { registerFeatureHandler } from '../feature-ipc'
import { loadAgentRoles, summarizeAgentRoles } from '../services/custom-agents'
import { resolveWorkspaceDir } from './workspace-roots'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

registerFeatureHandler('feature:agents:list', (payload) => {
  const input = payloadOf(payload)
  const requested = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  const workspace = requested
    ? resolveWorkspaceDir(requested, '子代理角色只能读取已登记工作区内的配置。')
    : null
  return summarizeAgentRoles(loadAgentRoles(workspace))
})
