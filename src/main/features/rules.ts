/** P1-9 规则文件可见性：feature:rules:list。 */
import { registerFeatureHandler } from '../feature-ipc'
import { discoverAgentRules } from '../services/agent-rules'
import { resolveWorkspaceDir } from './workspace-roots'

registerFeatureHandler('feature:rules:list', (payload) => {
  const input = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const raw = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  // 只允许读取已登记工作区内的项目规则；不传工作区时仅返回用户级规则
  const workspace = raw
    ? resolveWorkspaceDir(raw, '规则文件只能读取已登记工作区内的项目规则。')
    : null
  const discovery = discoverAgentRules(workspace)
  return {
    files: discovery.files,
    usedTokens: discovery.usedTokens,
    limitTokens: discovery.limitTokens,
    truncated: discovery.truncated
  }
})
