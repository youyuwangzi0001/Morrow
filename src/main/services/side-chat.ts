// 侧边聊天（/btw）：基于当前主对话上下文的只读问答。
import { createProvider } from '../../core/providers'
import { messagePlainText } from '../../shared/message'
import type { ChatMessage, ReasoningEffort, Usage } from '../../shared/types'
import type { ProviderStreamRequest } from '../../core/types'
import { newId } from '../../core/util'
import { getSettingsStore } from './settings-store'
import { getSessionStore } from './session-store'
import { buildAnswerStyleSection } from '../../shared/answer-style'

const MAX_CONTEXT_MESSAGES = 12
const MAX_CONTEXT_CHARS = 12_000
const MAX_ANSWER_TOKENS = 4096

export interface SideChatHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

export interface SideChatInput {
  sessionId: string
  question: string
  useContext: boolean
  history: SideChatHistoryItem[]
}

export interface SideChatResult {
  text: string
  usage: Usage
}

export async function runSideChat(
  input: SideChatInput,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  onNotice?: (message: string) => void
): Promise<SideChatResult> {
  const session = getSessionStore().get(input.sessionId)
  if (!session) throw new Error('这个对话不存在了。')
  const settings = getSettingsStore().get()
  const config = settings.providers.find((provider) => provider.id === session.model.providerId)
  if (!config) throw new Error('找不到这个模型提供方，请到设置里重新连接。')
  const model = config.models.find((item) => item.id === session.model.modelId)
  if (!model) throw new Error('当前对话使用的模型已不可用，请先在主对话里重新选择模型。')
  if (config.kind === 'demo') throw new Error('演示模式不支持侧边聊天，请先连接自己的模型。')
  let apiKey = getSettingsStore().getApiKey(config.id)
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(config.baseUrl)
  if (!apiKey && isLocal) apiKey = 'morrow-local'
  if (!apiKey) throw new Error('还没有连接模型。请打开设置 → 模型连接，填入 API Key 后再试。')
  const provider = createProvider(config, apiKey, model.id)

  const contextMessages = input.useContext
    ? session.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-MAX_CONTEXT_MESSAGES)
        .map((message) => {
          const text = messagePlainText(message).trim()
          return text ? `${message.role === 'user' ? '用户' : '助手'}：${text.slice(0, 2000)}` : ''
        })
        .filter(Boolean)
    : []
  let context = contextMessages.join('\n\n')
  if (context.length > MAX_CONTEXT_CHARS) context = `${context.slice(0, MAX_CONTEXT_CHARS)}\n…（上下文已截断）`

  const system = [
    '你是 Morrow 的「侧边聊天」助手：用户在主对话旁边临时问一个问题。',
    '- 只回答这个问题；不要调用工具、不要修改文件、不要声称执行了任何操作，也不要继续推进主任务。',
    '- 如果给出了主对话上下文，只把它当作参考资料；与问题无关就忽略。',
    '- 不确定时明确说明。',
    buildAnswerStyleSection(settings.answerStyle, settings.answerStyleCustom),
    context ? `\n【主对话最近上下文（只读）】\n${context}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const messages: ChatMessage[] = input.history.slice(-12).map((item) => ({
    id: newId('msg'),
    role: item.role,
    content: [{ type: 'text', text: item.content.slice(0, 8000) }],
    createdAt: Date.now()
  }))
  messages.push({
    id: newId('msg'),
    role: 'user',
    content: [{ type: 'text', text: input.question }],
    createdAt: Date.now()
  })

  const effort: ReasoningEffort = session.reasoningEffort ?? settings.reasoningEffort
  const reasoning =
    model.supportsReasoning && model.reasoningStyle && effort !== 'auto'
      ? { effort, style: model.reasoningStyle }
      : undefined
  const request: ProviderStreamRequest = {
    system,
    messages,
    tools: [],
    signal,
    maxTokens: Math.min(model.maxOutput ?? MAX_ANSWER_TOKENS, MAX_ANSWER_TOKENS),
    ...(reasoning ? { reasoning } : {})
  }

  let text = ''
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  for await (const event of provider.stream(request)) {
    if (signal.aborted) break
    if (event.type === 'text_delta') {
      text += event.text
      onDelta(event.text)
    } else if (event.type === 'usage') {
      usage = event.usage
    } else if (event.type === 'notice' && event.level !== 'info') {
      onNotice?.(event.message)
    }
  }
  // 停止请求不能被当作正常完成返回，否则渲染层会收到 done 而不是 cancelled
  if (signal.aborted) throw new Error('侧边聊天已停止。')
  if (!text.trim()) throw new Error('模型没有返回内容。')
  return { text: text.trim(), usage }
}
