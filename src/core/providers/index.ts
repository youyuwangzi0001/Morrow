/**
 * Provider 工厂与连接测试。
 * 主进程只依赖 createProvider / testProviderConnection，不关心具体协议实现。
 */
import type { ChatMessage, ProviderConfig, ProviderTestResult } from '../../shared/types'
import type { ConnectionTestOptions, Provider } from '../types'
import { newId } from '../util'
import { AnthropicProvider } from './anthropic'
import { DemoProvider } from './demo'
import { OpenAICompatProvider } from './openai-compat'
import { ToolProtocolProvider } from './protocol'
import { toProviderError } from './types'

export { DemoProvider, collectDemoMetrics, renderDemoReportHtml, type DemoMetrics } from './demo'
export { AnthropicProvider, buildAnthropicRequestBody, toAnthropicMessages, toAnthropicTool } from './anthropic'
export {
  OpenAICompatProvider,
  buildOpenAIRequestBody,
  toOpenAIMessages,
  toOpenAITool
} from './openai-compat'
export { ToolProtocolProvider } from './protocol'
export {
  DEFAULT_RETRY,
  ProviderError,
  joinUrl,
  normalizeHttpError,
  resolveAnthropicMessagesUrl,
  resolveChatCompletionsUrl,
  toProviderError,
  type RetryPolicy
} from './types'
export { SSEParser, iterateSSEData, iterateSSE, type SSEFrame } from './sse'

/**
 * 按 ProviderConfig.kind 选择实现。
 * demo 走离线剧本引擎（忽略 apiKey/modelId；模型 id 只用于 UI 展示）。
 */
export function createProvider(config: ProviderConfig, apiKey: string | null, modelId?: string): Provider {
  if (config.kind === 'demo' || config.id === 'demo') return new DemoProvider()
  const provider =
    config.kind === 'anthropic'
      ? new AnthropicProvider(config, apiKey, modelId)
      : new OpenAICompatProvider(config, apiKey, modelId)
  // 所有真实 provider 统一经过文本工具协议归一化：兼容各厂商的兼容层差异。
  return new ToolProtocolProvider(provider)
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(url)
}

/**
 * 测试模型连接：发一个极短的流式请求（最多 16 token），返回首字延迟与人话结论。
 * - 本地地址（127.0.0.1 / localhost）允许不填 Key，方便本地 Mock/ Ollama 网关；
 * - demo 直接返回就绪；
 * - 超时默认 15s，成功/失败都返回结构化结果而不是抛错。
 */
export async function testProviderConnection(
  config: ProviderConfig,
  apiKey: string | null,
  modelId?: string,
  options: ConnectionTestOptions = {}
): Promise<ProviderTestResult> {
  const startedAt = Date.now()
  const modelCount = config.models.length

  if (config.kind === 'demo' || config.id === 'demo') {
    return {
      ok: true,
      latencyMs: 0,
      modelCount,
      message: '演示引擎已就绪（离线运行，不消耗任何额度）。'
    }
  }
  if (!config.baseUrl || !config.baseUrl.trim()) {
    return { ok: false, latencyMs: 0, modelCount, message: '还没有填写接口地址（Base URL）。' }
  }
  const hasKey = Boolean(apiKey && apiKey.trim())
  if (!hasKey && !isLocalUrl(config.baseUrl)) {
    return {
      ok: false,
      latencyMs: 0,
      modelCount,
      message: '还没有填写 API Key。请先到提供商官网创建密钥，再粘贴到设置里。'
    }
  }

  const model = modelId || config.models[0]?.id || 'unknown'
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const provider = createProvider(config, hasKey ? apiKey : 'local-test', model)
  const testMessage: ChatMessage = {
    id: newId('test'),
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    createdAt: Date.now()
  }
  try {
    let received = false
    for await (const event of provider.stream({
      system: '你是连接测试助手，请只回复两个字：你好。',
      messages: [testMessage],
      tools: [],
      signal: controller.signal,
      maxTokens: 16
    })) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        received = true
        break
      }
    }
    const latencyMs = Date.now() - startedAt
    return {
      ok: true,
      latencyMs,
      modelCount,
      message: received
        ? `连接成功，首字延迟约 ${latencyMs} 毫秒。`
        : `连接成功（服务可达），耗时 ${latencyMs} 毫秒。`
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const providerError = toProviderError(err, config.id)
    const message = controller.signal.aborted
      ? `连接超时（超过 ${(timeoutMs / 1000).toFixed(0)} 秒）。请检查网络、代理或 Base URL 是否正确。`
      : providerError.message
    return { ok: false, latencyMs, modelCount, message }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
