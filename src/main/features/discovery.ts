/** 用户级/工作区级发现类 feature IPC：子代理角色、自定义命令、规则文件。 */
import { registerFeatureHandler } from '../feature-ipc'
import { discoverAgentRules } from '../services/agent-rules'
import { discoverCustomCommands } from '../services/command-service'
import { loadAgentRoles, summarizeAgentRoles } from '../services/custom-agents'
import { resolveWorkspaceDir } from './workspace-roots'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function requestedWorkspace(input: Record<string, unknown>): string {
  return typeof input.workspace === 'string' ? input.workspace.trim() : ''
}

registerFeatureHandler('feature:agents:list', (payload) => {
  const requested = requestedWorkspace(payloadOf(payload))
  const workspace = requested
    ? resolveWorkspaceDir(requested, '子代理角色只能读取已登记工作区内的配置。')
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
