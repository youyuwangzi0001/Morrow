/** 自定义命令发现（P1-12）。用户级命令始终可用，项目级命令只在工作区内读取。 */
import { registerFeatureHandler } from '../feature-ipc'
import { discoverCustomCommands } from '../services/command-service'
import { resolveWorkspaceDir } from './workspace-roots'

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

registerFeatureHandler('feature:commands:list', (payload) => {
  const input = payloadOf(payload)
  const requested = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  const workspace = requested
    ? resolveWorkspaceDir(requested, '自定义命令只能读取已登记工作区内的项目命令。')
    : null
  return discoverCustomCommands(workspace)
})
