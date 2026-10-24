/** 所有 Agent 订阅渠道的统一入口；主进程按 id 取单例，UI 动作也只认 id。 */
import type {
  AgentSubscriptionId,
  AgentSubscriptionState,
  SubscriptionTestResult
} from '../../shared/subscriptions'
import { getKimiSubscriptionService } from './kimi-subscription'
import { getGlmSubscriptionService } from './glm-subscription'
import { getMinimaxSubscriptionService } from './minimax-subscription'
import { getStepSubscriptionService } from './step-subscription'
import { getCommandCodeSubscriptionService } from './command-code-subscription'
import { getClineSubscriptionService } from './cline-subscription'
import { getAntigravitySubscriptionService } from './antigravity-subscription'
import { getOpencodeSubscriptionService } from './opencode-subscription'

export interface AgentSubscriptionService {
  restore(): Promise<void>
  dispose(): Promise<void>
  status(): Promise<AgentSubscriptionState>
  login(region?: string): Promise<AgentSubscriptionState>
  loginToken?(token: string, region?: string): Promise<AgentSubscriptionState>
  importLocal?(): Promise<AgentSubscriptionState>
  refreshQuota(): Promise<unknown>
  test(): Promise<SubscriptionTestResult>
  remove(): Promise<AgentSubscriptionState>
  setEnabled(enabled: boolean): Promise<AgentSubscriptionState>
}

export const AGENT_ORDER: AgentSubscriptionId[] = [
  'kimi',
  'glm',
  'minimax',
  'step',
  'command-code',
  'cline',
  'antigravity',
  'opencode'
]

function kimiAdapter(): AgentSubscriptionService {
  const service = getKimiSubscriptionService()
  return {
    restore: () => service.restore(),
    dispose: () => service.dispose(),
    status: () => service.status(),
    login: (region) => service.loginDevice(region === 'global' ? 'global' : 'cn'),
    refreshQuota: () => service.refreshQuota(),
    test: () => service.test(),
    remove: () => service.remove(),
    setEnabled: (enabled) => service.setEnabled(enabled)
  }
}

export function getAgentService(id: AgentSubscriptionId): AgentSubscriptionService {
  switch (id) {
    case 'kimi':
      return kimiAdapter()
    case 'glm': {
      const service = getGlmSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: (region) => service.login(region),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'minimax': {
      const service = getMinimaxSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: (region) => service.login(region),
        importLocal: () => service.importLocal(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'step': {
      const service = getStepSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: (region) => service.login(region),
        loginToken: (token, region) => service.loginToken(token, region),
        importLocal: () => service.importLocal(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'command-code': {
      const service = getCommandCodeSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: () => service.login(),
        loginToken: (token) => service.loginToken(token),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'cline': {
      const service = getClineSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: () => service.login(),
        loginToken: (token) => service.loginToken(token),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'antigravity': {
      const service = getAntigravitySubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: () => service.login(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    case 'opencode': {
      const service = getOpencodeSubscriptionService()
      return {
        restore: () => service.restore(),
        dispose: () => service.dispose(),
        status: () => service.status(),
        login: async () => service.importLocal(),
        loginToken: (token) => service.loginToken(token),
        importLocal: () => service.importLocal(),
        refreshQuota: () => service.refreshQuota(),
        test: () => service.test(),
        remove: () => service.remove(),
        setEnabled: (enabled) => service.setEnabled(enabled)
      }
    }
    default:
      throw new Error('未知的订阅渠道。')
  }
}

export function allAgentServices(): AgentSubscriptionService[] {
  return AGENT_ORDER.map((id) => getAgentService(id))
}
