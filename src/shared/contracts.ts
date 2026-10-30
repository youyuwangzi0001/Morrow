// 应用级契约：模型、订阅、连接器、研究、定时任务、记忆、命令与 IPC。
import type { ModelInfo, ModelRef, ProviderConfig, ReasoningEffort, Settings, Artifact, ChatMessage, ResearchDepth, ResearchState, ArtifactExportFormat, ArtifactVersionInfo, AskUserAnswer, Attachment, Bootstrap, CloseAction, CreateSessionInput, DemoInfo, FileSearchResult, PermissionDecision, PermissionMode, ProviderTestResult, Result, RuntimeEventListener, SendMessageInput, SendMessageResult, Session, SessionMeta, SessionMode, TokenActivitySummary, WindowState, WorkspaceInfo } from './types'

/**
 * 内置模型预设。
 * 数据截至 2026-10-26，来源与核对结果见 docs/verification/VERIFICATION.md §4.3；
 * 设置页支持「从服务商同步模型列表」在运行时刷新上下文/输出上限等元数据。
 */

const deepseekModels: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    maxOutput: 393_216,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    note: '速度快、性价比高'
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_000_000,
    maxOutput: 393_216,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    reasoningEfforts: ['high', 'max'],
    note: '旗舰推理与复杂任务能力，适合长任务'
  }
]

const kimiModels: ModelInfo[] = [
  {
    id: 'kimi-k3.1-pro',
    label: 'Kimi K3.1 Pro',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: 'K3 系列最新旗舰；适合复杂 Agent 与长任务'
  },
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '支持图片输入'
  },
  {
    id: 'kimi-k2.8-preview',
    label: 'Kimi K2.8 Preview',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '上一代预览模型；新任务优先 K3.1 Pro'
  }
]

const qwenModels: ModelInfo[] = [
  {
    id: 'qwen3.8-max',
    label: 'Qwen3.8 Max',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '通义千问旗舰，适合复杂任务'
  },
  {
    id: 'qwen3.8-flash-next',
    label: 'Qwen3.8 Flash Next',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '最新高性价比版本，速度快，适合日常任务'
  }
]

const anthropicModels: ModelInfo[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '长程编程与复杂任务；自适应思考默认开启',
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 2.5 }
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: 'Anthropic 旗舰，适合长任务与复杂写作'
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '速度与质量平衡'
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    note: '高并发、低成本'
  }
]

const openaiModels: ModelInfo[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: 'OpenAI 当前默认旗舰（2026-10-09 发布）'
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '最复杂推理与编码旗舰（2026-09-04 发布）'
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '低延迟档位'
  }
]

const geminiModels: ModelInfo[] = [
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: 'Google 前沿旗舰（2026-10 上线），适合超长资料'
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '高性价比档位（2026-10 最新 Flash）'
  }
]

const glmModels: ModelInfo[] = [
  {
    id: 'glm-5.3',
    label: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    note: '智谱旗舰（2026-10-15），默认深入思考'
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: '原生多模态、低成本版本（320B 总参 / 18B 激活）'
  }
]

const miniMaxModels: ModelInfo[] = [
  {
    id: 'MiniMax-M3.1-Flash',
    label: 'MiniMax M3.1 Flash',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: 'M3.1 Flash 正式版，速度优先'
  },
  {
    id: 'MiniMax-M3',
    label: 'MiniMax M3',
    contextWindow: 1_000_000,
    maxOutput: 512_000,
    supportsTools: true,
    supportsReasoning: true,
    note: '擅长代码和 Agent 任务'
  }
]

const xiaomiModels: ModelInfo[] = [
  {
    id: 'mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    supportsTools: true,
    supportsReasoning: true,
    note: '小米旗舰，擅长工具调用与复杂推理'
  },
  {
    id: 'mimo-v2.6-flash',
    label: 'MiMo V2.6 Flash',
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    supportsTools: true,
    supportsReasoning: true,
    note: '速度与成本优先'
  }
]

const metaModels: ModelInfo[] = [
  {
    id: 'muse-wonder-1.0',
    label: 'Muse Wonder 1.0',
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    note: 'Meta 2026-10 新旗舰；支持文本、图片与视频输入',
    pricing: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 }
  },
  {
    id: 'muse-spark-1.3',
    label: 'Muse Spark 1.3',
    contextWindow: 1_048_576,
    maxOutput: 131_072,
    supportsTools: true,
    supportsReasoning: true,
    note: 'Meta 的 Agent 与编程模型',
    pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25, cacheReadPerMTok: 0.15 }
  }
]

const xaiModels: ModelInfo[] = [
  {
    id: 'grok-4.7',
    label: 'Grok 4.7',
    contextWindow: 500_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsVision: true,

    supportsReasoning: true,
    note: 'xAI 当前旗舰（2026-09-21），支持图片输入'
  },
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    contextWindow: 500_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '500K 上下文、低延迟，适合日常与长任务'
  }
]

/**
 * 已从内置目录下线的模型：读取旧设置时一并移除，避免升级后设置页仍显示被替换的型号。
 * 只列内置模型 ID；自定义 Provider 自有模型不受影响。
 */
export const RETIRED_MODEL_IDS: Record<string, readonly string[]> = {
  xai: ['grok-4.1', 'grok-4.1-fast', 'grok-4.1-fast-reasoning'],
  kimi: ['kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.7', 'kimi-k2.6-preview'],
  llamacpp: ['Sage-A1.5-Q4_K_M', 'Sage-A1.5', 'local-model', 'Qwen3.8-27B-Coder390']
}

const localModels: ModelInfo[] = [
  {
    id: 'local-model',
    label: '本地模型（请改成实际模型 ID）',
    contextWindow: 131_072,
    maxOutput: 32_768,
    supportsTools: true,
    note: 'Ollama/LM Studio 的模型 ID 以本机加载为准，可在设置里编辑'
  }
]

/** llama.cpp 的 llama-server 默认监听 8000；模型由用户自行添加，不再预置 Coder390。 */
const llamaCppModels: ModelInfo[] = []

export const DEMO_PROVIDER_ID = 'demo'

export const DEMO_MODEL_ID = 'morrow-demo'

/** 参考价（美元 / 百万 tokens），仅用于成本估算；实际以服务商账单为准。 */
const PRICING_TABLE: Array<[RegExp, { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok?: number }]> = [
  [/deepseek.*flash/i, { inputPerMTok: 0.14, outputPerMTok: 0.28, cacheReadPerMTok: 0.014 }],
  [/deepseek/i, { inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.055 }],
  [/kimi/i, { inputPerMTok: 0.6, outputPerMTok: 2.5 }],
  [/claude.*fable/i, { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 2.5 }],
  [/claude.*haiku/i, { inputPerMTok: 0.8, outputPerMTok: 4 }],
  [/claude/i, { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 }],
  [/muse.*wonder/i, { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 }],
  [/muse.*spark/i, { inputPerMTok: 1.25, outputPerMTok: 4.25, cacheReadPerMTok: 0.15 }],
  [/gpt-6|gpt-5/i, { inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25 }],
  [/gemini.*flash/i, { inputPerMTok: 0.3, outputPerMTok: 1.2 }],
  [/gemini/i, { inputPerMTok: 1.25, outputPerMTok: 5 }],
  [/glm/i, { inputPerMTok: 0.6, outputPerMTok: 2.2 }],
  [/grok/i, { inputPerMTok: 2, outputPerMTok: 10 }],
  [/qwen/i, { inputPerMTok: 0.4, outputPerMTok: 1.2 }],
  [/minimax/i, { inputPerMTok: 0.3, outputPerMTok: 1.2 }]
]

export function pricingForModel(modelId: string): ModelInfo['pricing'] {
  const found = PRICING_TABLE.find(([pattern]) => pattern.test(modelId))
  return found ? { ...found[1] } : undefined
}

/**
 * 已知模型族的真实思考档位。只收录有把握的档位；未知家族不猜测，
 * 由 UI 只提供“自动（不指定）”，避免把 medium/xhigh 发给不支持的 API。
 */
const REASONING_EFFORT_PATTERNS: Array<[RegExp, ReasoningEffort[]]> = [
  // DeepSeek V4.1 Flash：官方档位 none/low/high/max，Morrow 用 off 表示 none。
  [/deepseek.*(?:flash|v4\.1)/i, ['off', 'low', 'high', 'max']],
  // V4 Pro / 旧版 V4：官方高力度档位为 high/max。
  [/deepseek/i, ['high', 'max']],
  // GPT-6.1 Sol 等：low/medium/high/xhigh/max（不支持 none/minimal）。
  [/^(gpt-|o\d)/i, ['low', 'medium', 'high', 'xhigh', 'max']],
  // Claude 5.5 家族：低到 max 五档。
  [/claude/i, ['low', 'medium', 'high', 'xhigh', 'max']],
  // Kimi K3/K3.1 Pro/K2.8：low/high/max。
  [/kimi|^k3/i, ['low', 'high', 'max']],
  // GLM-5.3 / 5.3-Flash：low/high/max，默认 max。
  [/glm/i, ['low', 'high', 'max']],
  // MiniMax M3.1 Flash：low 到 max 五档。
  [/minimax/i, ['low', 'medium', 'high', 'xhigh', 'max']],
  // Qwen3.8：官方低/中/xhigh 三档；max/high 会映射到 xhigh。
  [/qwen/i, ['low', 'medium', 'xhigh']],
  // Gemini 4 Argon / 3.8 Flash：LOW/MEDIUM/HIGH。
  [/gemini/i, ['low', 'medium', 'high']],
  // Grok 4.6/4.7：low/medium/high/xhigh，默认 high。
  [/grok/i, ['low', 'medium', 'high', 'xhigh']],
  // Meta Muse Spark：low/medium/high/xhigh。
  [/muse/i, ['low', 'medium', 'high', 'xhigh']]
]

export function reasoningEffortsForModel(modelId: string, supportsReasoning = true): ReasoningEffort[] | undefined {
  if (!supportsReasoning) return undefined
  const found = REASONING_EFFORT_PATTERNS.find(([pattern]) => pattern.test(modelId))
  return found ? [...found[1]] : undefined
}

/** 订阅渠道保存 Provider 前统一补齐真实档位；显式元数据优先。 */
export function enrichModelCapabilities(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => {
    if (!model.supportsReasoning) return model
    const efforts = model.reasoningEfforts ?? reasoningEffortsForModel(model.id, true)
    return efforts ? { ...model, reasoningEfforts: efforts } : model
  })
}

/** 给内置模型补充推理映射与参考价；未知模型不猜测价格。 */
function enrichModels(models: ModelInfo[], providerId: string): ModelInfo[] {
  return models.map((model) => {
    // OpenAI 兼容协议（DeepSeek/Kimi/Qwen/GLM 等）同样使用 reasoning_effort；
    // 只有 Anthropic 走 thinking.budget_tokens。缺失 style 会导致 UI 隐藏推理选项。
    const reasoningStyle =
      model.reasoningStyle ??
      (model.supportsReasoning ? (providerId === 'anthropic' ? 'thinking' : 'effort') : undefined)
    const reasoningEfforts =
      model.reasoningEfforts ?? reasoningEffortsForModel(model.id, model.supportsReasoning === true)
    const pricing = model.pricing ?? pricingForModel(model.id)
    return {
      ...model,
      ...(reasoningStyle ? { reasoningStyle } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(pricing ? { pricing } : {})
    }
  })
}

export function builtinProviders(): ProviderConfig[] {
  return [
    {
      id: 'deepseek',
      kind: 'openai-compat',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: enrichModels(deepseekModels, 'deepseek'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'cn'
    },
    {
      id: 'kimi',
      kind: 'openai-compat',
      name: 'Kimi（月之暗面）',
      baseUrl: 'https://api.moonshot.cn/v1',
      models: enrichModels(kimiModels, 'kimi'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'cn'
    },
    {
      id: 'qwen',
      kind: 'openai-compat',
      name: '通义千问（阿里云）',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: enrichModels(qwenModels, 'qwen'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'cn'
    },
    {
      id: 'glm',
      kind: 'openai-compat',
      name: '智谱 GLM（Z.AI）',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: enrichModels(glmModels, 'glm'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'cn'
    },
    {
      id: 'minimax',
      kind: 'openai-compat',
      name: 'MiniMax',
      baseUrl: 'https://api.minimax.io/v1',
      models: enrichModels(miniMaxModels, 'minimax'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'cn'
    },
    {
      id: 'mimo',
      kind: 'openai-compat',
      name: '小米 MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      models: enrichModels(xiaomiModels, 'mimo'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'cn'
    },
    {
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic Claude',
      baseUrl: 'https://api.anthropic.com',
      models: enrichModels(anthropicModels, 'anthropic'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'global'
    },
    {
      id: 'openai',
      kind: 'openai-compat',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: enrichModels(openaiModels, 'openai'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'global'
    },
    {
      id: 'gemini',
      kind: 'openai-compat',
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      models: enrichModels(geminiModels, 'gemini'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'global'
    },
    {
      id: 'xai',
      kind: 'openai-compat',
      name: 'xAI Grok',
      baseUrl: 'https://api.x.ai/v1',
      models: enrichModels(xaiModels, 'xai'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'global'
    },
    {
      id: 'meta',
      kind: 'openai-compat',
      name: 'Meta（Muse）',
      baseUrl: 'https://api.meta.ai/v1',
      models: enrichModels(metaModels, 'meta'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'global'
    },
    {
      id: 'ollama',
      kind: 'openai-compat',
      name: 'Ollama（本地）',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: enrichModels(localModels, 'local').map((m) => ({ ...m, label: 'Ollama 本地模型（改成实际 ID）' })),
      apiKeyStored: false,
      enabled: false,
      isBuiltin: true,
      category: 'local'
    },
    {
      id: 'llamacpp',
      kind: 'openai-compat',
      name: 'llama.cpp（本地）',
      baseUrl: 'http://127.0.0.1:8000/v1',
      models: enrichModels(llamaCppModels, 'local'),
      apiKeyStored: false,
      enabled: false,
      isBuiltin: true,
      category: 'local'
    },
    {
      id: 'lmstudio',
      kind: 'openai-compat',
      name: 'LM Studio（本地）',
      baseUrl: 'http://127.0.0.1:1234/v1',
      models: enrichModels(localModels, 'local').map((m) => ({ ...m, label: 'LM Studio 本地模型（改成实际 ID）' })),
      apiKeyStored: false,
      enabled: false,
      isBuiltin: true,
      category: 'local'
    },
    {
      id: DEMO_PROVIDER_ID,
      kind: 'demo',
      name: '演示引擎',
      baseUrl: 'local://demo',
      models: [
        {
          id: DEMO_MODEL_ID,
          label: 'Morrow Demo',
          contextWindow: 128_000,
          supportsTools: true,
          note: '离线体验，不消耗任何额度'
        }
      ],
      apiKeyStored: true,
      enabled: true,
      isBuiltin: true,
      category: 'local'
    }
  ]
}

export const DEFAULT_MODEL: ModelRef = { providerId: 'deepseek', modelId: 'deepseek-flash' }

export const DEMO_MODEL: ModelRef = { providerId: DEMO_PROVIDER_ID, modelId: DEMO_MODEL_ID }

/**
 * 老版本保存/同步的模型可能只有 supportsReasoning、没有 reasoningStyle。
 * 这里统一补齐：Anthropic 用 thinking budget，其余 OpenAI 兼容协议用 reasoning_effort。
 * demo 模型不推断，避免演示模式意外带出推理参数。
 */
export function normalizeReasoningStyle(model: ModelInfo, kind: ProviderConfig['kind']): ModelInfo {
  if (model.reasoningStyle || model.supportsReasoning !== true || kind === 'demo') return model
  return { ...model, reasoningStyle: kind === 'anthropic' ? 'thinking' : 'effort' }
}

export function findModel(providers: ProviderConfig[], ref: ModelRef): ModelInfo | null {
  const provider = providers.find((p) => p.id === ref.providerId)
  const model = provider?.models.find((m) => m.id === ref.modelId) ?? null
  return model && provider ? normalizeReasoningStyle(model, provider.kind) : null
}

/** 统一本机/局域网服务判定：provider 测试、模型同步与设置页共用同一规则。 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

export function isLoopbackHost(host: string): boolean {
  const value = normalizeHost(host)
  return value === 'localhost' || value === '::1' || /^127\./.test(value)
}

export function isPrivateNetworkHost(host: string): boolean {
  const value = normalizeHost(host)
  if (isLoopbackHost(value) || value.endsWith('.local')) return true
  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)) return true
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map(Number)
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [first, second] = octets as [number, number, number, number]
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  )
}

export function isLocalServiceUrl(value: string, options: { allowPrivate?: boolean } = {}): boolean {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return options.allowPrivate ? isPrivateNetworkHost(url.hostname) : isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    theme: 'dark',
    fontSize: 14,
    codeFontSize: 12,
    codeFont: 'jetbrains',
    reduceMotion: false,
    permissionMode: 'ask',
    sendKey: 'enter',
    runningSendMode: 'queue',
    providers: builtinProviders(),
    defaultModel: DEFAULT_MODEL,
    lastWorkspace: null,
    recentWorkspaces: [],
    onboardingDone: false,
    sidebarCollapsed: false,
    demoSeen: false,
    showTokenMeter: true,
    autoTitle: true,
    evolutionEnabled: true,
    episodeMemoryEnabled: true,
    sidebarWidth: 240,
    autoCompact: true,
    compactThreshold: 0.8,
    canvasWidth: 420,
    composerHeight: 0,
    layoutVersion: 2,
    webSearch: {
      enabled: true,
      provider: 'builtin',
      apiKeyStored: false,
      maxResults: 5
    },
    mediaEngine: {
      enabled: true,
      comfyuiUrl: 'http://127.0.0.1:8188',
      comfyuiDir: null,
      ffmpegPath: null,
      autoStart: true,
      imageTimeoutSec: 600,
      videoTimeoutSec: 3600,
      outputDir: 'media'
    },
    closeAction: 'ask',
    notifyOnFinish: true,
    islandEnabled: true,
    islandPosition: null,
    reasoningEffort: 'auto',
    answerStyle: 'balanced',
    answerStyleCustom: '',
    hooks: [],
    terminalShell: ''
  }
}

/** 推荐给新手的三个建议任务（空状态） */
export const SUGGESTIONS = [
  {
    title: '整理这份文件夹',
    description: '扫描工作区，把散落的文件归类，写一份清单说明改了什么',
    prompt: '帮我整理一下当前工作区：先看看有哪些文件，按类型归类，然后告诉我整理结果，并生成一份清单。'
  },
  {
    title: '做一份数据分析报告',
    description: '读取表格数据，算出关键结论，生成可分享的报告',
    prompt: '帮我分析工作区里的数据文件，找出三条最重要的结论，并生成一份自包含的 HTML 报告。'
  },
  {
    title: '写一个能直接用的小工具',
    description: '说清需求，它会把代码写好、跑通、给你成品',
    prompt: '帮我写一个实用的小工具网页，要求单文件、离线可用、界面简洁。'
  }
] as const

export const REASONING_EFFORTS = ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ReasoningEffort[]

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS)

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_SET.has(value)
}

function normalizeEffortList(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is ReasoningEffort => isReasoningEffort(item)))]
}

/**
 * 模型实际可选的思考强度：auto 表示“不指定、交给服务端”，显式档位只来自模型元数据。
 * 没有元数据时不猜测 low/high 等档位，避免像 DeepSeek medium 这样的上游 400。
 */
export function modelReasoningEfforts(model: ModelInfo | null | undefined): ReasoningEffort[] {
  if (!model?.supportsReasoning || !model.reasoningStyle) return []
  const explicit = normalizeEffortList(model.reasoningEfforts)
  return explicit.length > 0 ? ['auto', ...explicit.filter((effort) => effort !== 'auto')] : ['auto']
}

/** 请求前把历史/默认值收敛到模型真实支持的档位；不合法时退回 auto（不发送参数）。 */
export function normalizeReasoningEffortForModel(
  model: ModelInfo | null | undefined,
  effort: ReasoningEffort | undefined
): ReasoningEffort | undefined {
  if (!model?.supportsReasoning || !model.reasoningStyle) return undefined
  if (!effort || effort === 'auto') return 'auto'
  return modelReasoningEfforts(model).includes(effort) ? effort : 'auto'
}

export function reasoningRequestFor(
  model: ModelInfo | null | undefined,
  effort: ReasoningEffort | undefined
): { effort: ReasoningEffort; style: 'effort' | 'thinking' } | undefined {
  const normalized = normalizeReasoningEffortForModel(model, effort)
  if (!normalized || normalized === 'auto' || !model?.reasoningStyle) return undefined
  return { effort: normalized, style: model.reasoningStyle }
}

export function modelContextOptions(model: ModelInfo | null | undefined): number[] {
  if (!model?.contextOptions?.length) return []
  const max = model.contextWindow
  return [...new Set(model.contextOptions.filter((value) => Number.isInteger(value) && value >= 1_024 && value <= max))]
    .sort((a, b) => a - b)
}

/** 订阅接入页面的公共契约；不把明文 token 暴露给渲染层。 */

export type SubscriptionProtocol = 'openai-compat' | 'anthropic'

export interface SubscriptionQuotaWindow {
  label: string
  usedPercent: number
  /** 窗口长度（秒）；上游未提供时省略 */
  windowSeconds?: number
  /** 重置时间（epoch ms） */
  resetAt?: number
}

export interface CodexSubscriptionAccount {
  email?: string
  plan?: string
  accountId?: string
  /** access token 的过期时间（epoch ms） */
  expiresAt?: number
  source?: 'codex-cli' | 'oauth'
}

export interface CodexSubscriptionQuota {
  plan?: string
  email?: string
  windows: SubscriptionQuotaWindow[]
  credits?: {
    hasCredits: boolean
    unlimited: boolean
    balance?: number
  }
  fetchedAt: number
  message?: string
}

export interface CodexSubscriptionState {
  available: boolean
  connected: boolean
  providerId?: string
  account?: CodexSubscriptionAccount
  quota?: CodexSubscriptionQuota
  models: ModelInfo[]
  enabled: boolean
  sourcePath?: string
  error?: string
}

export interface CustomSubscriptionRecord {
  id: string
  name: string
  protocol: SubscriptionProtocol
  baseUrl: string
  providerId: string
  models: string[]
  createdAt: number
}

export interface CustomSubscriptionState {
  record: CustomSubscriptionRecord
  provider?: ProviderConfig
  connected: boolean
  error?: string
}

export interface QoderQuotaBucket {
  kind: 'personal' | 'add-on' | 'org'
  total?: number
  used?: number
  remaining?: number
  unit?: string
}

export interface QoderSubscriptionAccount {
  email?: string
  name?: string
  uid?: string
  region: 'global' | 'cn'
  expiresAt?: number
  source?: 'pat' | 'device' | 'local'
  sourcePath?: string
}

export interface QoderSubscriptionQuota {
  buckets: QoderQuotaBucket[]
  expiresAt?: number
  fetchedAt: number
  message?: string
}

export interface QoderSubscriptionState {
  available: boolean
  connected: boolean
  providerId?: string
  account?: QoderSubscriptionAccount
  quota?: QoderSubscriptionQuota
  models: ModelInfo[]
  enabled: boolean
  patUrl: string
  localImport?: { available: boolean; path: string }
  error?: string
}

export type AgentSubscriptionId =
  | 'kimi'
  | 'glm'
  | 'minimax'
  | 'step'
  | 'command-code'
  | 'cline'
  | 'antigravity'
  | 'opencode'

export interface AgentQuotaWindow {
  id: string
  label: string
  usedPercent?: number
  used?: number
  total?: number
  remaining?: number
  unit?: string
  resetAt?: number
}

export interface AgentSubscriptionAccount {
  email?: string
  name?: string
  uid?: string
  plan?: string
  region?: string
  expiresAt?: number
  source?: string
  sourcePath?: string
}

export interface AgentSubscriptionQuota {
  windows: AgentQuotaWindow[]
  fetchedAt: number
  message?: string
}

export interface AgentSubscriptionState {
  id: AgentSubscriptionId
  name: string
  connected: boolean
  providerId?: string
  account?: AgentSubscriptionAccount
  quota?: AgentSubscriptionQuota
  models: ModelInfo[]
  enabled: boolean
  login: 'device' | 'oauth' | 'token' | 'local' | 'browser'
  /** 登录页可选的区域；缺省表示该渠道没有区域选择。 */
  regionOptions?: { value: string; label: string }[]
  defaultRegion?: string
  /** 可直接粘贴的长期密钥（API key / PAT）；存在时设置页显示输入框。 */
  tokenLogin?: { label: string; placeholder: string; help?: string }
  localImport?: { available: boolean; path: string }
  error?: string
}

export interface SubscriptionStatus {
  codex: CodexSubscriptionState
  qoder?: QoderSubscriptionState
  agents?: AgentSubscriptionState[]
  custom: CustomSubscriptionState[]
  disclaimer: string
}

export interface CustomSubscriptionInput {
  id?: string
  name: string
  protocol: SubscriptionProtocol
  baseUrl: string
  apiKey: string
  models: string[]
}

export type SubscriptionAction =
  | { action: 'import-codex'; path?: string }
  | { action: 'login-codex' }
  | { action: 'refresh-codex' }
  | { action: 'remove-codex' }
  | { action: 'set-codex-enabled'; enabled: boolean }
  | { action: 'test-codex' }
  | { action: 'login-qoder'; pat: string; region: 'global' | 'cn' }
  | { action: 'login-qoder-device' }
  | { action: 'import-qoder-local' }
  | { action: 'refresh-qoder' }
  | { action: 'remove-qoder' }
  | { action: 'test-qoder' }
  | { action: 'set-qoder-enabled'; enabled: boolean }
  | { action: 'set-qoder-context'; modelId: string; contextWindow: number }
  | { action: 'login-agent'; id: AgentSubscriptionId; region?: string }
  | { action: 'login-agent-token'; id: AgentSubscriptionId; token: string; region?: string }
  | { action: 'import-agent-local'; id: AgentSubscriptionId }
  | { action: 'refresh-agent'; id: AgentSubscriptionId }
  | { action: 'remove-agent'; id: AgentSubscriptionId }
  | { action: 'test-agent'; id: AgentSubscriptionId }
  | { action: 'set-agent-enabled'; id: AgentSubscriptionId; enabled: boolean }
  | { action: 'add-custom'; input: CustomSubscriptionInput }
  | { action: 'update-custom'; input: CustomSubscriptionInput }
  | { action: 'remove-custom'; id: string }
  | { action: 'test-custom'; id: string }
  | { action: 'set-custom-enabled'; id: string; enabled: boolean }

export interface SubscriptionTestResult {
  ok: boolean
  latencyMs: number
  message: string
}
// 连接器目录（A3）：经过核对的官方远程端点 / 官方本机 MCP 服务。

export type ConnectorCatalogCategory = 'remote' | 'local'

export type ConnectorCatalogTransport = 'http' | 'stdio'

export interface ConnectorCatalogEntry {
  id: string
  /** MCP server 名称（只能含字母/数字/下划线/点/短横线） */
  name: string
  /** 界面上显示的名称 */
  label: string
  vendor: string
  description: string
  detail: string
  category: ConnectorCatalogCategory
  transport: ConnectorCatalogTransport
  official: boolean
  /** 远程服务地址（http） */
  url?: string
  /** 需要的请求头（Authorization） */
  headerKey?: string
  /** 本机服务需要的环境变量（如 NOTION_TOKEN） */
  envKey?: string
  /** 需要用户填写密钥 */
  requiresToken: boolean
  tokenLabel?: string
  tokenPlaceholder?: string
  tokenHint?: string
  /** 需要用户选择文件夹（filesystem） */
  requiresFolder?: boolean
  /** 本机服务：npx 包参数（不含 -y），例如 ['@modelcontextprotocol/server-memory'] */
  packageArgs?: string[]
  /** 本机服务需要 npx / Node.js */
  requiresNpx: boolean
  /** 连接测试超时（本机首次运行可能需要下载，给足时间） */
  timeoutMs: number
  docsUrl: string
  docsLabel: string
  notes?: string[]
}

export interface ConnectorRuntimeStatus {
  platform: string
  npx: { available: boolean; version?: string }
  /** 检测失败时给用户的可读提示 */
  note?: string
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: 'github-remote',
    name: 'github',
    label: 'GitHub',
    vendor: 'GitHub 官方',
    description: '搜索仓库、读取 Issue / PR、查看代码与提交。',
    detail: '通过 GitHub 官方在线服务连接。需要 GitHub Token，只保存在本机；Morrow 不会把令牌发给模型。',
    category: 'remote',
    transport: 'http',
    official: true,
    url: 'https://api.githubcopilot.com/mcp/',
    headerKey: 'Authorization',
    requiresToken: true,
    tokenLabel: 'GitHub Token',
    tokenPlaceholder: 'github_pat_… 或 ghp_…',
    tokenHint: '建议只授予需要的仓库和只读权限；令牌会加密保存在本机。',
    requiresNpx: false,
    timeoutMs: 30_000,
    docsUrl: 'https://github.com/github/github-mcp-server',
    docsLabel: 'GitHub MCP 文档',
    notes: ['地址来自 GitHub 官方；如果组织禁用了远程 MCP，请改用 GitHub 官方提供的其他安装方式。']
  },
  {
    id: 'linear-remote',
    name: 'linear',
    label: 'Linear',
    vendor: 'Linear 官方',
    description: '查看与创建 Issue、项目与团队动态。',
    detail: '通过 Linear 官方在线服务连接。使用 API Key，无需在本机安装服务。',
    category: 'remote',
    transport: 'http',
    official: true,
    url: 'https://mcp.linear.app/mcp',
    headerKey: 'Authorization',
    requiresToken: true,
    tokenLabel: 'Linear API Key',
    tokenPlaceholder: 'lin_api_…',
    tokenHint: '在 Linear 的 Settings → API 创建个人 API Key；只保存在本机。',
    requiresNpx: false,
    timeoutMs: 30_000,
    docsUrl: 'https://linear.app/docs/mcp',
    docsLabel: 'Linear MCP 文档'
  },
  {
    id: 'filesystem-local',
    name: 'filesystem',
    label: '文件系统',
    vendor: 'MCP 官方参考服务',
    description: '让 Morrow 通过 MCP 读写你指定的一个文件夹。',
    detail: '官方 filesystem 参考服务。安装时选择一个文件夹，Morrow 只会把该文件夹作为服务参数，不会自动扩大范围。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    requiresFolder: true,
    packageArgs: ['@modelcontextprotocol/server-filesystem'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    docsLabel: 'filesystem 文档',
    notes: ['需要电脑已安装 Node.js。首次安装会下载服务，可能需要一两分钟。']
  },
  {
    id: 'memory-local',
    name: 'memory',
    label: '长期记忆',
    vendor: 'MCP 官方参考服务',
    description: '一份由本地 MCP 服务保存的长期知识图谱。',
    detail: '官方 memory 参考服务，数据只保存在本机。与 Morrow 自带的「记忆中心」不同：这是给 Agent 调用的独立 MCP 工具。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    packageArgs: ['@modelcontextprotocol/server-memory'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    docsLabel: 'memory 文档',
    notes: ['需要电脑已安装 Node.js。']
  },
  {
    id: 'sequential-local',
    name: 'sequential-thinking',
    label: '顺序思考',
    vendor: 'MCP 官方参考服务',
    description: '把复杂问题拆成可检查的思考步骤。',
    detail: '官方 sequential-thinking 参考服务，适合需要显式推理链的任务。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    packageArgs: ['@modelcontextprotocol/server-sequential-thinking'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    docsLabel: 'sequential-thinking 文档',
    notes: ['需要电脑已安装 Node.js。']
  },
  {
    id: 'notion-local',
    name: 'notion',
    label: 'Notion',
    vendor: 'Notion 官方',
    description: '搜索、读取和编辑 Notion 页面与数据库。',
    detail: 'Notion 官方本机 MCP 服务。安装后把你的 Integration Token 填入环境变量；记得在 Notion 中把目标页面共享给这个 Integration。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: true,
    tokenLabel: 'Notion Integration Token',
    tokenPlaceholder: 'secret_… 或 ntn_…',
    tokenHint: '在 Notion 的 Integrations 页面创建内部集成并复制 Token；它只保存在本机。',
    envKey: 'NOTION_TOKEN',
    packageArgs: ['@notionhq/notion-mcp-server'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
    docsLabel: 'Notion MCP 文档',
    notes: ['需要电脑已安装 Node.js。', '安装前请在 Notion 中把相关页面授权给这个 Integration。']
  },
  {
    id: 'playwright-local',
    name: 'playwright',
    label: 'Playwright',
    vendor: 'Microsoft 官方',
    description: '用 Playwright 打开浏览器、截图、点击与读取页面。',
    detail: 'Microsoft 官方 Playwright MCP。与 Morrow 自带浏览器不同：它通过 MCP 工具提供更完整的网页自动化能力。',
    category: 'local',
    transport: 'stdio',
    official: true,
    requiresToken: false,
    packageArgs: ['@playwright/mcp@latest'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    docsLabel: 'Playwright MCP 文档',
    notes: ['需要电脑已安装 Node.js；首次运行可能还需要下载浏览器组件。']
  },
  {
    id: 'context7-local',
    name: 'context7',
    label: 'Context7 文档',
    vendor: 'Upstash 社区',
    description: '查询各类开源库的最新文档与代码示例。',
    detail: 'Context7 的本地 MCP 服务。适合查库文档；安装会运行社区维护的服务，请只在你信任的电脑上使用。',
    category: 'local',
    transport: 'stdio',
    official: false,
    requiresToken: false,
    packageArgs: ['@upstash/context7-mcp'],
    requiresNpx: true,
    timeoutMs: 120_000,
    docsUrl: 'https://github.com/upstash/context7',
    docsLabel: 'Context7 文档',
    notes: ['需要电脑已安装 Node.js。', '这是社区服务，不是 Morrow 官方内置工具。']
  }
] as const

export function findCatalogEntry(id: string): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null
}

/**
 * 目录里本机 MCP 服务的启动命令构造（纯函数，可在单元测试覆盖）。
 * Windows 上 npx 是 .cmd，必须通过 cmd.exe 启动；目录参数带空格时需要加引号。
 */

export interface LocalNpxInvocation {
  command: string
  args: string[]
}

export function quoteCmdToken(value: string): string {
  if (!/[\s"&|<>^()%!]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export function buildLocalNpxInvocation(
  packageArgs: string[],
  folder: string | null | undefined,
  platform: string,
  comspec?: string
): LocalNpxInvocation {
  const fullArgs = ['-y', ...packageArgs, ...(folder ? [folder] : [])]
  if (platform === 'win32') {
    return {
      command: comspec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npx', ...fullArgs].map(quoteCmdToken).join(' ')]
    }
  }
  return { command: 'npx', args: fullArgs }
}

export interface ResearchDepthConfig {
  label: string
  description: string
  maxRounds: number
  minSources: number
}

export const RESEARCH_DEPTHS: Record<ResearchDepth, ResearchDepthConfig> = {
  quick: {
    label: '快速',
    description: '2 轮检索，至少 4 个独立来源；适合快速确认一件事。',
    maxRounds: 2,
    minSources: 4
  },
  standard: {
    label: '标准',
    description: '4 轮检索，至少 10 个独立来源；适合一般调研与对比。',
    maxRounds: 4,
    minSources: 10
  },
  deep: {
    label: '深入',
    description: '6 轮检索，至少 20 个独立来源；适合需要交叉验证的重要判断。',
    maxRounds: 6,
    minSources: 20
  }
}

export function normalizeResearchDepth(value: unknown): ResearchDepth {
  return value === 'quick' || value === 'deep' ? value : 'standard'
}

export function createResearchState(
  topic: string,
  depth: ResearchDepth,
  now: number = Date.now(),
  options: { status?: 'planning' | 'searching'; plan?: string } = {}
): ResearchState {
  const config = RESEARCH_DEPTHS[depth]
  return {
    topic: topic.trim().slice(0, 500) || '未命名研究',
    depth,
    status: options.status ?? 'searching',
    round: 1,
    maxRounds: config.maxRounds,
    minSources: config.minSources,
    sourceCount: 0,
    startedAt: now,
    updatedAt: now,
    ...(options.plan ? { plan: options.plan.slice(0, 20_000) } : {})
  }
}

export interface ResearchSource {
  url: string
  title: string
}

/** 用户确认计划后开始检索的输入。 */
export interface ResearchStartInput {
  plan: string
  depth?: ResearchDepth
}

/** 独立来源的归一化键：忽略 hash、末尾斜杠、UTM 跟踪参数与主机大小写。 */
function sourceKey(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return null
  }
}

/** 从消息中的 web_search / web_fetch 成功结果收集独立来源（按归一化 URL 去重）。 */
export function collectResearchSources(messages: ChatMessage[], since = 0): ResearchSource[] {
  const seen = new Set<string>()
  const sources: ResearchSource[] = []
  const add = (url: unknown, title: unknown): void => {
    if (typeof url !== 'string') return
    const key = sourceKey(url)
    if (!key || seen.has(key)) return
    seen.add(key)
    sources.push({ url, title: typeof title === 'string' && title ? title : url })
  }
  for (const message of messages) {
    if (message.createdAt < since) continue
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.status !== 'success') continue
      const meta = block.result?.meta as Record<string, unknown> | null | undefined
      if (block.name === 'web_search') {
        const raw = meta && Array.isArray(meta.sources) ? meta.sources : []
        for (const item of raw as Array<Record<string, unknown>>) add(item.url, item.title)
      } else if (block.name === 'web_fetch' && meta) {
        add(meta.finalUrl ?? meta.requestedUrl, meta.title)
      }
    }
  }
  return sources
}

function assistantTextSince(messages: ChatMessage[], since: number): string {
  const chunks: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || message.createdAt < since) continue
    for (const block of message.content) {
      if (block.type === 'text') chunks.push(block.text)
    }
  }
  return chunks.join('\n')
}

/** 一条消息/成品是否具备「带来源章节 + 至少两个链接」的报告结构。 */
function hasSourceEvidence(text: string): boolean {
  if (!text) return false
  const links = text.match(/https?:\/\/[^\s)\]>"']+/g)?.length ?? 0
  if (links < 2) return false
  return /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?\s*(?:参考来源|参考資料|参考资料|来源|sources?|references?)\s*(?:\*\*)?\s*[:：]?\s*(?=\n|$)/i.test(
    text
  )
}

/** 最终报告：有研究/报告标题的文本成品，或正文具备来源章节与两个链接的成品/回复。 */
export function hasResearchReport(
  messages: ChatMessage[],
  artifacts: Artifact[],
  startedAt: number
): { present: boolean; artifactId?: string } {
  const artifact = [...artifacts]
    .reverse()
    .find(
      (item) =>
        item.updatedAt >= startedAt &&
        (item.kind === 'markdown' || item.kind === 'html' || item.kind === 'text') &&
        (/研究|报告|research|report/i.test(item.title) || hasSourceEvidence(item.content ?? ''))
    )
  if (artifact) return { present: true, artifactId: artifact.id }
  return { present: hasSourceEvidence(assistantTextSince(messages, startedAt)) }
}

export interface ResearchDecision {
  status: 'searching' | 'completed' | 'stopped'
  sourceCount: number
  gap?: string
  artifactId?: string
  followUpPrompt?: string
}

/**
 * 每轮结束后的判断：
 * - 来源与报告都达标 → completed；
 * - 还有轮次 → searching + 下一轮补查指令；
 * - 到上限 → stopped（如实说明差多少，不伪装成已完成）。
 */
export function decideResearchNextStep(
  state: ResearchState,
  messages: ChatMessage[],
  artifacts: Artifact[]
): ResearchDecision {
  const sources = collectResearchSources(messages, state.startedAt)
  const sourceCount = sources.length
  const report = hasResearchReport(messages, artifacts, state.startedAt)
  if (sourceCount >= state.minSources && report.present) {
    return {
      status: 'completed',
      sourceCount,
      ...(report.artifactId ? { artifactId: report.artifactId } : {})
    }
  }
  const missing: string[] = []
  if (sourceCount < state.minSources) missing.push(`独立来源 ${sourceCount}/${state.minSources}`)
  if (!report.present) missing.push('还缺一份带引用来源的研究报告')
  const gap = missing.join('；')
  if (state.round >= state.maxRounds) {
    return {
      status: 'stopped',
      sourceCount,
      gap: `已到研究轮次上限（${state.round}/${state.maxRounds}）：${gap}。可以继续发送消息再研究一轮。`,
      ...(report.artifactId ? { artifactId: report.artifactId } : {})
    }
  }
  const nextRound = state.round + 1
  return {
    status: 'searching',
    sourceCount,
    gap,
    followUpPrompt: [
      `继续这项深度研究（第 ${nextRound}/${state.maxRounds} 轮）。当前 ${gap}。`,
      state.steer ? `用户补充要求（必须纳入本轮）：${state.steer}` : '',
      '请按要求补查：',
      '1. 换 2-3 组不同角度的关键词再搜索，不要重复已经用过的来源；',
      '2. 用 web_fetch 阅读至少 2 个新来源，核对关键事实与日期；',
      '3. 区分事实、推断和未知，把分歧写清楚；',
      '4. 最后更新一份完整的 Markdown 研究报告，用 open_artifact 打开；每条结论保留 [编号] 和 URL。',
      '不要向用户提问。'
    ]
      .filter((line) => line !== '')
      .join('\n')
  }
}

/** 研究模式系统提示段（运行时状态由主进程注入）。 */
export function buildResearchPromptSection(state: ResearchState): string {
  const config = RESEARCH_DEPTHS[state.depth]
  return [
    '## 深度研究模式',
    `- 研究主题：${state.topic}`,
    `- 深度：${config.label}（最多 ${state.maxRounds} 轮检索，至少 ${state.minSources} 个独立来源）`,
    `- 当前轮次：第 ${state.round}/${state.maxRounds} 轮；已记录的独立来源：${state.sourceCount}/${state.minSources}`,
    state.gap ? `- 上一轮缺口：${state.gap}` : '',
    state.plan ? `\n## 已确认的研究计划\n${state.plan}` : '',
    state.steer ? `\n## 用户补充要求（本轮必须优先处理）\n${state.steer}` : '',
    '',
    '工作方式：',
    '1. 先拆出 3-5 个需要查清的子问题，用 todo_write 记录；',
    '2. 每一轮至少做 2 次不同关键词的 web_search，覆盖不同角度；对关键来源用 web_fetch 读正文；',
    '3. 只引用实际搜索或读取过的 URL；不得编造来源、标题、日期或数字；',
    '4. 交叉核对：同一事实尽量有 2 个独立来源；不一致时把分歧和各自出处写出来；',
    '5. 明确区分「已核实的事实」「基于资料的推断」「仍未知/需要更新」；',
    '6. 最终用 Markdown 写研究报告：标题、摘要、关键结论（每条带 [n]）、证据与分歧、关键数据/时间线、局限、参考来源（[n] 标题 + URL）；',
    '7. 报告用 open_artifact（kind=markdown）放到画布上；',
    '8. 不修改任何文件、不运行命令、不调用 MCP；不需要向用户提问，缺信息就如实写进「局限」。',
    state.plan ? '9. 严格遵守已确认的研究计划；如需偏离，先在报告里说明原因。' : '',
    '',
    '如果本轮结束时来源或报告仍不完整，系统会自动发起下一轮补查；你只需把当前这一轮做扎实。'
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** 计划阶段：只生成可审阅的计划，不检索、不写报告。 */
export function buildResearchPlanPrompt(state: ResearchState): string {
  const config = RESEARCH_DEPTHS[state.depth]
  return [
    '## 深度研究：制定计划阶段',
    '你现在的唯一任务是制定研究计划。不要调用任何工具，不要开始搜索，也不要写最终报告。',
    '',
    `用户的研究主题：${state.topic}`,
    `研究深度：${config.label}（最多 ${config.maxRounds} 轮检索，至少 ${config.minSources} 个独立来源）`,
    '',
    '请输出一份简洁、可编辑的 Markdown 研究计划，必须包含：',
    '1. `# 研究计划：<主题>` 标题；',
    '2. `## 研究目标`：一句话说明最终要回答什么；',
    '3. `## 范围与假设`：时间范围、地域、对象、必要的边界；',
    '4. `## 子问题`：4-6 个可检索、可验证的问题；',
    '5. `## 检索策略`：关键词方向、优先来源类型、需要交叉核对的关键事实；',
    '6. `## 报告结构`：摘要、关键结论、证据与分歧、时间线/数据、局限、参考来源；',
    '7. `## 需要确认`：只列出真正影响结论的 0-3 个未知项，供用户修改。',
    '',
    '要求：不要编造事实或来源；用简体中文；控制在一页内。用户会直接编辑这份计划，然后开始研究。'
  ].join('\n')
}
// 定时任务：共享的调度规则、校验与展示文案。

export type ScheduleKind = 'once' | 'daily' | 'weekly'

export type ScheduledPermission = 'read-only' | 'auto'

export type ScheduledTaskStatus = 'never' | 'running' | 'success' | 'error' | 'stopped' | 'missed'

export interface ScheduleSpec {
  kind: ScheduleKind
  /** 本地时间 HH:mm（24 小时制） */
  time: string
  /** once：本地日期 YYYY-MM-DD */
  date?: string
  /** weekly：0=周日 … 6=周六 */
  weekday?: number
}

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  schedule: ScheduleSpec
  /** 绑定的工作区；null = 不绑定文件夹 */
  workspace: string | null
  permissionMode: ScheduledPermission
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 下一次自动执行时间；暂停/一次性已执行后为 null */
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: ScheduledTaskStatus
  lastError?: string
  lastSessionId?: string
}

export interface ScheduledTaskInput {
  title: string
  prompt: string
  schedule: ScheduleSpec
  workspace: string | null
  permissionMode: ScheduledPermission
  enabled: boolean
}

export const SCHEDULE_MAX_TASKS = 50

export const SCHEDULE_MAX_TITLE_CHARS = 80

export const SCHEDULE_MAX_PROMPT_CHARS = 20_000

/** 应用重启后，错过不超过这个时间的任务会补跑一次。 */
export const SCHEDULE_CATCHUP_MS = 60 * 60 * 1000

/** 单次自动运行的最长等待（防止提问/挂起占住队列）。 */
export const SCHEDULE_RUN_TIMEOUT_MS = 30 * 60 * 1000

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === 'once' || value === 'daily' || value === 'weekly'
}

export function isScheduledPermission(value: unknown): value is ScheduledPermission {
  return value === 'read-only' || value === 'auto'
}

function parseTime(value: string): { hours: number; minutes: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(year, month - 1, day)
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null
  return { year, month, day }
}

function atTime(base: Date, hours: number, minutes: number): Date {
  const next = new Date(base.getTime())
  next.setHours(hours, minutes, 0, 0)
  return next
}

/**
 * 计算下一次执行时间（本地时区）。
 * - once：日期+时间必须存在；返回时间可能早于 from，调用方据此给出「已过去」错误。
 * - daily：今天该时刻已过则明天。
 * - weekly：本周该星期几已过则下周。
 * 返回 null 表示规则本身无效。
 */
export function computeNextRun(spec: ScheduleSpec, from: number = Date.now()): number | null {
  const time = parseTime(spec.time)
  if (!time) return null
  const base = new Date(from)
  if (spec.kind === 'once') {
    if (!spec.date) return null
    const date = parseDate(spec.date)
    if (!date) return null
    const target = new Date(date.year, date.month - 1, date.day, time.hours, time.minutes, 0, 0)
    return target.getTime()
  }
  if (spec.kind === 'daily') {
    const target = atTime(base, time.hours, time.minutes)
    if (target.getTime() <= from) target.setDate(target.getDate() + 1)
    return target.getTime()
  }
  if (spec.kind === 'weekly') {
    if (typeof spec.weekday !== 'number' || !Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6) {
      return null
    }
    const target = atTime(base, time.hours, time.minutes)
    let delta = (spec.weekday - target.getDay() + 7) % 7
    if (delta === 0 && target.getTime() <= from) delta = 7
    target.setDate(target.getDate() + delta)
    return target.getTime()
  }
  return null
}

/** 校验并规范化调度规则；不合法时抛出可直接展示给用户的中文错误。 */
export function validateScheduleSpec(spec: ScheduleSpec, from: number = Date.now()): {
  spec: ScheduleSpec
  nextRunAt: number
} {
  if (!spec || !isScheduleKind(spec.kind)) throw new Error('请选择执行频率。')
  if (!parseTime(spec.time)) throw new Error('时间格式不对，应为 HH:mm。')
  const normalized: ScheduleSpec = { kind: spec.kind, time: spec.time.trim() }
  if (spec.kind === 'once') {
    if (!spec.date || !parseDate(spec.date)) throw new Error('请选择一个有效日期。')
    normalized.date = spec.date
    const next = computeNextRun(normalized, from)
    if (next === null) throw new Error('执行时间不合法。')
    if (next <= from + 5_000) throw new Error('一次性任务的时间需要晚于现在。')
    return { spec: normalized, nextRunAt: next }
  }
  if (spec.kind === 'weekly') {
    if (typeof spec.weekday !== 'number' || !Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6) {
      throw new Error('请选择星期几。')
    }
    normalized.weekday = spec.weekday
  }
  const next = computeNextRun(normalized, from)
  if (next === null) throw new Error('执行时间不合法。')
  return { spec: normalized, nextRunAt: next }
}

/** 「每天 09:00」「每周一 09:00」「10月22日 09:00 · 一次」 */
export function describeSchedule(spec: ScheduleSpec, options: { withOnceSuffix?: boolean } = {}): string {
  const time = spec.time
  if (spec.kind === 'daily') return `每天 ${time}`
  if (spec.kind === 'weekly') {
    const weekday = typeof spec.weekday === 'number' ? WEEKDAY_LABELS[spec.weekday] ?? '' : ''
    return weekday ? `每${weekday} ${time}` : `每周 ${time}`
  }
  const date = spec.date ? parseDate(spec.date) : null
  const label = date ? `${date.month}月${date.day}日 ${time}` : `一次 ${time}`
  return options.withOnceSuffix === false ? label : `${label} · 一次`
}

/** 下一次执行的简短中文描述；用于列表与状态条。 */
export function describeNextRun(nextRunAt: number | null, now: number = Date.now()): string {
  if (nextRunAt === null) return '未安排'
  const date = new Date(nextRunAt)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfTarget - startOfToday) / 86_400_000)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const time = `${hh}:${mm}`
  if (nextRunAt <= now) return '即将执行'
  const diff = nextRunAt - now
  if (diff < 60_000) return '不到 1 分钟后'
  if (dayDiff === 0) return `今天 ${time}`
  if (dayDiff === 1) return `明天 ${time}`
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff} 天后 ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export function describeLastStatus(status: ScheduledTaskStatus): string {
  switch (status) {
    case 'never':
      return '还没运行'
    case 'running':
      return '正在运行'
    case 'success':
      return '上次成功'
    case 'error':
      return '上次失败'
    case 'stopped':
      return '上次已停止'
    case 'missed':
      return '上次错过'
  }
}
/** 任务经验（自动记忆）与记忆中心事件的共享契约。 */
export type EpisodeOutcome = 'completed' | 'failed'

export interface TaskEpisode {
  id: string
  scope: 'project' | 'global'
  workspace: string | null
  title: string
  /** 当时用户想完成什么 */
  intent: string
  /** 任务结果摘要（不是完整对话） */
  summary: string
  outcome: EpisodeOutcome
  /** 成员/工具名称（去重，最多 12 个） */
  tools: string[]
  /** 改动或产出文件（相对工作区，最多 12 个） */
  files: string[]
  tags: string[]
  sourceSessionId: string
  sourceSessionTitle: string
  sourceMessageId: string
  createdAt: number
  updatedAt: number
  enabled: boolean
}

export interface EpisodeStats {
  scope: 'project' | 'global'
  workspace: string | null
  total: number
  enabled: number
  limit: number
}

export interface EpisodeListResult {
  entries: TaskEpisode[]
  stats: EpisodeStats
}

export interface EpisodeInjection {
  text: string
  usedTokens: number
  limitTokens: number
  totalEnabled: number
  included: number
}

export const EPISODE_CHANGED_EVENT = 'feature:memory:episodes-changed'

export const MEMORY_CHANGED_EVENT = 'feature:memory:changed'

/**
 * 自进化建议（记忆中心）：任务后复盘产出的可采纳改进。
 *
 * 设计取舍：
 * - 建议只是候选，用户点「采纳」后才写入记忆或技能库；
 * - 每条建议都带来源会话、置信度和过期时间，方便复盘与清理；
 * - 一次只保留少量待处理建议，避免把记忆中心变成通知中心。
 */
export type EvolutionMemoryScope = 'project' | 'global'

export type EvolutionKind = 'memory' | 'skill'

export type EvolutionAction = 'create' | 'update'

export type EvolutionStatus = 'pending' | 'applied' | 'ignored'

export interface EvolutionSuggestion {
  id: string
  kind: EvolutionKind
  action: EvolutionAction
  /** 列表中的短标题；记忆为一句概括，技能为 kebab-case 技能名 */
  title: string
  /** 一句话说明这条建议会改变什么 */
  summary: string
  /** 为什么值得保留（来自对话里的纠正、失败重试或可复用流程） */
  rationale: string
  /** 0–1；低于阈值的建议不会入库 */
  confidence: number
  status: EvolutionStatus
  /** 记忆目标范围；技能建议为 null */
  scope: EvolutionMemoryScope | null
  /** 项目记忆的目标工作区；全局记忆/技能为 null */
  workspace: string | null
  /** 来源会话的工作区，用于展示上下文 */
  sourceWorkspace: string | null
  /** 记忆正文，或完整 SKILL.md（含 frontmatter） */
  content: string
  /** 记忆标签 */
  tags: string[]
  /** update 时的目标记忆 id 或技能 id */
  targetId: string | null
  sourceSessionId: string
  sourceSessionTitle: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  appliedAt?: number
  appliedTarget?: string
}

export interface EvolutionListResult {
  suggestions: EvolutionSuggestion[]
  pending: number
  lastReviewedAt: number | null
}

export type EvolutionSkipReason =
  | 'disabled'
  | 'temporary'
  | 'demo'
  | 'research'
  | 'unattended'
  | 'no-session'
  | 'no-model'
  | 'running'
  | 'no-signal'
  | 'cooldown'
  | 'pending-limit'
  | 'empty'
  | 'timeout'

export interface EvolutionReviewResult {
  suggestions: EvolutionSuggestion[]
  /** 本次新写入的候选数量（更新已有候选不计入） */
  created: number
  reviewedAt: number | null
  skipped?: EvolutionSkipReason
  message?: string
}

export interface EvolutionAppliedTarget {
  kind: EvolutionKind
  id: string
  /** 给用户看的名称（记忆摘要 / 技能名） */
  label: string
}

export interface EvolutionApplyResult {
  suggestion: EvolutionSuggestion
  target: EvolutionAppliedTarget
}

export const EVOLUTION_MIN_CONFIDENCE = 0.7

export const EVOLUTION_MAX_SUGGESTIONS_PER_REVIEW = 3

export const EVOLUTION_MAX_PENDING = 6

export const EVOLUTION_EXPIRES_MS = 14 * 24 * 60 * 60 * 1000

export const EVOLUTION_REVIEW_COOLDOWN_MS = 10 * 60 * 1000

export const EVOLUTION_MAX_CONTENT_CHARS = 20_000

export const EVOLUTION_MAX_SUMMARY_CHARS = 300

export const EVOLUTION_MAX_TITLE_CHARS = 80

export const EVOLUTION_MAX_RATIONALE_CHARS = 600

export const EVOLUTION_MAX_STORE_BYTES = 2 * 1024 * 1024

export const EVOLUTION_CHANGED_EVENT = 'feature:evolution:changed'

export const EVOLUTION_SKIP_LABEL: Record<EvolutionSkipReason, string> = {
  disabled: '自动检查已关闭',
  temporary: '临时对话不参与检查',
  demo: '演示对话不参与检查',
  research: '研究任务暂不生成建议',
  unattended: '无人值守任务不生成建议',
  'no-session': '还没有可以检查的对话',
  'no-model': '还没有连接可用的模型',
  running: '任务结束后再检查',
  'no-signal': '这次没有发现值得长期保留的内容',
  cooldown: '本轮刚刚检查过，稍后再试',
  'pending-limit': '待处理建议已满，先处理已有建议',
  empty: '对话内容太少，暂时无法检查',
  timeout: '检查超时，稍后再试'
}
/** 内置斜杠命令名。自定义命令与它们重名时不会出现在菜单，避免静默覆盖内置行为。 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'new',
  'temp',
  'demo',
  'plan',
  'settings',
  'btw',
  'swarm',
  'goal',
  'init',
  'clear',
  'rewind',
  'export',
  'export-json',
  'usage',
  'compact',
  'git',
  'research'
])

/** `/init` 模板：渲染层与主进程共用的提示词，避免两处文案漂移。 */
export const INIT_RULES_PROMPT = [
  '请先只读分析当前工作区，然后创建或更新项目规则文件 AGENTS.md。',
  '',
  '分析内容：目录结构、README/文档、package.json 或构建脚本、已有测试与代码约定。',
  'AGENTS.md 使用简体中文，包含：',
  '1. 项目概述（这是什么、给谁用）',
  '2. 目录结构与关键文件',
  '3. 常用命令（安装依赖、开发、构建、测试、lint）',
  '4. 代码风格与协作约定',
  '5. 注意事项（不要改哪些文件、环境要求）',
  '',
  '如果工作区已有规则文件（AGENTS.md / CLAUDE.md / MORROW.md，含 .morrow/ 下的），先读取并在现有文件上补充更新，不要新建重复文件、不要删除已有约定。',
  '只修改规则文件，不要改动其他文件；写文件会按当前权限模式请求我批准。完成后用几句话说明你写了什么。'
].join('\n')

/** 自定义斜杠命令模板展开：支持 $ARGUMENTS 与 $1..$9；没有占位符时把参数附在末尾。 */
export function expandCustomCommand(template: string, rawArgs: string): string {
  const args = rawArgs.trim()
  const positional = args ? args.split(/\s+/) : []
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9](?!\d)/.test(template)
  const expanded = template.replace(/\$ARGUMENTS|\$([1-9])(?!\d)/g, (match, digit?: string) => {
    if (match === '$ARGUMENTS') return args
    return positional[Number(digit) - 1] ?? ''
  })
  if (!hasPlaceholder && args) return `${expanded.trimEnd()}\n\n${args}`.trim()
  return expanded.trim()
}

/**
 * Morrow 实际支持的键盘快捷键清单。
 * 设置 → 快捷键直接渲染这里；新增快捷键时同时更新真实处理器，避免 UI 展示不可用的键。
 */
export interface ShortcutEntry {
  id: string
  keys: string
  label: string
  hint?: string
  /** 仅在对应功能开启时可用 */
  requires?: 'islandEnabled'
  /** 发送键跟随设置动态显示 */
  dynamic?: 'sendKey'
}

export interface ShortcutGroup {
  id: string
  label: string
  description?: string
  entries: ShortcutEntry[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'global',
    label: '全局',
    description: '在 Morrow 窗口里生效；桌面伙伴快捷键在 Morrow 后台也有效。',
    entries: [
      { id: 'palette', keys: 'Ctrl+K', label: '打开命令面板' },
      { id: 'sidebar', keys: 'Ctrl+B', label: '收起或展开侧栏' },
      { id: 'new-session', keys: 'Ctrl+N', label: '新建对话' },
      { id: 'settings', keys: 'Ctrl+,', label: '打开设置' },
      { id: 'terminal', keys: 'Ctrl+`', label: '打开或收起终端' },
      {
        id: 'island',
        keys: 'Ctrl+Shift+M',
        label: '显示或隐藏桌面伙伴',
        hint: '需在设置中开启桌面伙伴',
        requires: 'islandEnabled'
      },
      { id: 'escape', keys: 'Esc', label: '停止生成或关闭弹窗' }
    ]
  },
  {
    id: 'chat',
    label: '对话输入',
    description: '在输入框中生效；发送键跟随「设置 → 回答」。',
    entries: [
      {
        id: 'send',
        keys: 'Enter',
        label: '发送消息',
        hint: '可在设置 → 回答切换为 Ctrl+Enter',
        dynamic: 'sendKey'
      },
      { id: 'newline', keys: 'Shift+Enter', label: '在消息中换行' },
      { id: 'command', keys: '/', label: '打开命令菜单' },
      { id: 'mention', keys: '@', label: '引用文件夹里的文件' }
    ]
  },
  {
    id: 'editor',
    label: '编辑器',
    description: '在画布或文件编辑器聚焦时生效。',
    entries: [
      { id: 'save', keys: 'Ctrl+S', label: '保存当前文件' },
      { id: 'find', keys: 'Ctrl+F', label: '查找' },
      { id: 'undo', keys: 'Ctrl+Z', label: '撤销' },
      { id: 'redo', keys: 'Ctrl+Y', label: '重做' }
    ]
  },
  {
    id: 'files',
    label: '文件树',
    description: '在文件树获得焦点时生效。',
    entries: [
      { id: 'open', keys: 'Enter', label: '打开文件或展开文件夹' },
      { id: 'rename', keys: 'F2', label: '重命名' },
      { id: 'delete', keys: 'Delete', label: '删除' },
      { id: 'navigate', keys: '方向键', label: '在文件之间移动' },
      { id: 'menu', keys: 'Shift+F10', label: '打开右键菜单' }
    ]
  },
  {
    id: 'browser',
    label: '内置浏览器',
    description: '内置浏览器面板显示时生效。',
    entries: [
      { id: 'new-tab', keys: 'Ctrl+T', label: '新建标签页' },
      { id: 'address', keys: 'Ctrl+L', label: '聚焦地址栏' },
      { id: 'close-tab', keys: 'Ctrl+W', label: '关闭当前标签页' },
      { id: 'next-tab', keys: 'Ctrl+Tab', label: '切换到下一个标签页' },
      { id: 'prev-tab', keys: 'Ctrl+Shift+Tab', label: '切换到上一个标签页' }
    ]
  }
]
/** 发送给模型的单张图片上限（压缩/缩放后）；主流视觉接口都按此量级限制。 */
export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** 单条用户消息里所有图片的合计上限，避免一次请求塞入几十 MB 视觉输入 */
export const ATTACHMENT_TOTAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** 允许读取并交给渲染层缩放的原始图片上限；超过则只保留元数据。 */
export const ATTACHMENT_IMAGE_SOURCE_MAX_BYTES = 24 * 1024 * 1024

export const ATTACHMENT_TEXT_MAX_BYTES = 512 * 1024

export const ATTACHMENT_TEXT_MAX_CHARS = 120_000

/** 单条用户消息里所有文本附件的合计上限（含多个附件时从前往后分配） */
export const ATTACHMENT_TOTAL_TEXT_MAX_CHARS = 80_000

export const ATTACHMENT_MAX_COUNT = 8

/** 文本编辑器/预览单次最多读入的字节数；超过时只读展示开头并标记截断。 */
export const TEXT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

export const PDF_PREVIEW_MAX_BYTES = 200 * 1024 * 1024

export const DOCX_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

/** XLSX/PPTX/ODF/EPUB/RTF 内联转换上限 */
export const OFFICE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024

/** ZIP/JAR 列表上限（不解压，仅读中央目录） */
export const ARCHIVE_PREVIEW_MAX_BYTES = 100 * 1024 * 1024

export type FilePreviewKind =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'unsupported'

export interface FilePreviewMeta {
  path: string
  absolutePath: string
  kind: FilePreviewKind
  mime: string | null
  size: number
  mtimeMs: number
  /** 媒体/PDF 的带权限令牌地址；Office/文档/压缩包没有 */
  url?: string
  note?: string
}

export interface XlsxSheetPreview {
  name: string
  rows: string[][]
  truncated: boolean
}

export interface XlsxPreviewResult {
  sheets: XlsxSheetPreview[]
  warnings: string[]
  size: number
  mtimeMs: number
}

export interface PptxSlidePreview {
  index: number
  title: string
  lines: string[]
}

export interface PptxPreviewResult {
  slides: PptxSlidePreview[]
  warnings: string[]
  size: number
  mtimeMs: number
}

export interface DocumentPreviewResult {
  html: string
  format: string
  warnings: string[]
  size: number
  mtimeMs: number
}

export interface ArchiveEntryPreview {
  name: string
  dir: boolean
  size: number
  compressedSize: number
  date: string | null
}

export interface ArchivePreviewResult {
  entries: ArchiveEntryPreview[]
  total: number
  truncated: boolean
  size: number
  mtimeMs: number
}

/** 可作为聊天图片附件（视觉模型 + Canvas 可稳定解码）的格式 */
const ATTACHMENT_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])

/** 文件预览可尝试渲染的图片格式；解码失败时 UI 会降级为系统应用打开 */
const PREVIEW_IMAGE_EXTENSIONS = new Set([
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  'jfif', 'apng', 'svg', 'ico', 'avif', 'tif', 'tiff', 'heic', 'heif'
])

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'm4b', 'aac', 'flac', 'opus',
  'aif', 'aiff', 'aifc', 'amr', 'wma'
])

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi',
  'mpg', 'mpeg', '3gp', '3g2', 'wmv', 'flv', 'ts', 'm2ts'
])

const XLSX_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xltx', 'xltm'])

const PPTX_EXTENSIONS = new Set(['pptx', 'pptm', 'ppsx', 'potx'])

const DOCUMENT_EXTENSIONS = new Set(['rtf', 'odt', 'ods', 'odp', 'epub'])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'jar', 'whl', 'vsix'])

const TABLE_EXTENSIONS = new Set(['csv', 'tsv'])

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  jar: 'application/java-archive',
  whl: 'application/zip',
  vsix: 'application/zip',
  jfif: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  ico: 'image/x-icon',
  apng: 'image/apng',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  m4b: 'audio/mp4',
  amr: 'audio/amr',
  wma: 'audio/x-ms-wma',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  srt: 'text/plain',
  vtt: 'text/vtt',
  ass: 'text/plain',
  ics: 'text/calendar',
  diff: 'text/x-diff',
  patch: 'text/x-diff'
}

const EXTENSIONLESS_TEXT_NAMES = new Set([
  'readme', 'license', 'licence', 'notice', 'copying', 'authors', 'changelog',
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'justfile', 'todo'
])

const DOTFILE_TEXT_NAMES = new Set([
  '.env', '.gitignore', '.npmrc', '.editorconfig', '.dockerignore', '.prettierignore', '.eslintignore'
])

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'sql', 'sh', 'ps1',
  'bat', 'cmd', 'toml', 'ini', 'conf', 'properties', 'log', 'svg', 'env', 'r', 'lua', 'pl', 'ex', 'exs',
  'tex', 'srt', 'vtt', 'ass', 'ssa', 'ics', 'diff', 'patch', 'graphql', 'gql', 'proto', 'dart', 'scala',
  'groovy', 'gradle', 'cmake', 'mk', 'lock', 'editorconfig'
])

function baseName(nameOrPath: string): string {
  return nameOrPath.replace(/\\/g, '/').split('/').pop() ?? ''
}

export function fileExtension(nameOrPath: string): string {
  const name = baseName(nameOrPath)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 聊天附件可用的图片格式（raster） */
export function isImageFileName(nameOrPath: string): boolean {
  return ATTACHMENT_IMAGE_EXTENSIONS.has(fileExtension(nameOrPath))
}

/** 文件预览可尝试的图片格式（包含 SVG/TIFF/HEIC 等） */
export function isPreviewImageFileName(nameOrPath: string): boolean {
  return PREVIEW_IMAGE_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isTextFileName(nameOrPath: string): boolean {
  const name = baseName(nameOrPath).toLowerCase()
  if (name.startsWith('.env')) return true
  if (DOTFILE_TEXT_NAMES.has(name)) return true
  if (!name.includes('.') && EXTENSIONLESS_TEXT_NAMES.has(name)) return true
  return TEXT_EXTENSIONS.has(fileExtension(name))
}

export function imageMediaTypeFor(nameOrPath: string): string | null {
  const ext = fileExtension(nameOrPath)
  if (!ATTACHMENT_IMAGE_EXTENSIONS.has(ext)) return null
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return `image/${ext}`
}

export function isPdfFileName(nameOrPath: string): boolean {
  return fileExtension(nameOrPath) === 'pdf'
}

export function isDocxFileName(nameOrPath: string): boolean {
  return fileExtension(nameOrPath) === 'docx'
}

export function isAudioFileName(nameOrPath: string): boolean {
  return AUDIO_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isVideoFileName(nameOrPath: string): boolean {
  const ext = fileExtension(nameOrPath)
  // .ts 默认视为 TypeScript 文本；只有 .m2ts 走视频
  if (ext === 'ts') return false
  return VIDEO_EXTENSIONS.has(ext)
}

export function isXlsxFileName(nameOrPath: string): boolean {
  return XLSX_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isPptxFileName(nameOrPath: string): boolean {
  return PPTX_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isDocumentFileName(nameOrPath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isArchiveFileName(nameOrPath: string): boolean {
  return ARCHIVE_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isTableFileName(nameOrPath: string): boolean {
  return TABLE_EXTENSIONS.has(fileExtension(nameOrPath))
}

export function isLegacyOfficeFileName(nameOrPath: string): boolean {
  return /^(?:doc|xls|ppt)$/i.test(fileExtension(nameOrPath))
}

export function mimeTypeForFileName(nameOrPath: string): string | null {
  return imageMediaTypeFor(nameOrPath) ?? MIME_BY_EXTENSION[fileExtension(nameOrPath)] ?? null
}

/** 非文本文档的预览类型；文本文件由调用方先判断，不走这里。 */
export function binaryPreviewKindForFileName(nameOrPath: string): FilePreviewKind | null {
  // 文本优先：SVG/CSV/TS 等即使也能被浏览器当图片/视频，仍走可编辑文本路径
  if (isTextFileName(nameOrPath)) return null
  if (isPdfFileName(nameOrPath)) return 'pdf'
  if (isXlsxFileName(nameOrPath)) return 'xlsx'
  if (isPptxFileName(nameOrPath)) return 'pptx'
  if (isDocxFileName(nameOrPath)) return 'docx'
  if (isDocumentFileName(nameOrPath)) return 'document'
  if (isArchiveFileName(nameOrPath)) return 'archive'
  if (isPreviewImageFileName(nameOrPath)) return 'image'
  if (isAudioFileName(nameOrPath)) return 'audio'
  if (isVideoFileName(nameOrPath)) return 'video'
  return null
}

export function previewKindForFileName(nameOrPath: string): FilePreviewKind | 'text' {
  if (isTextFileName(nameOrPath)) return 'text'
  return binaryPreviewKindForFileName(nameOrPath) ?? 'unsupported'
}

/** 所有 invoke 通道唯一来源，主进程与 preload 都必须引用这里 */
export const IPC = {
  bootstrap: 'app:bootstrap',
  appInfo: 'app:info',
  openExternal: 'app:open-external',
  openDataDir: 'app:open-data-dir',
  openLogs: 'app:open-logs',
  appTheme: 'app:theme',
  changeDataDir: 'app:change-data-dir',
  resetDataDir: 'app:reset-data-dir',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowResolveClose: 'window:resolve-close',
  windowState: 'window:state',

  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionLoad: 'session:load',
  sessionRename: 'session:rename',
  sessionDelete: 'session:delete',
  sessionSetModel: 'session:set-model',
  sessionSetPermissionMode: 'session:set-permission-mode',
  sessionSetMode: 'session:set-mode',
  sessionSetReasoning: 'session:set-reasoning',
  sessionSetPinned: 'session:set-pinned',
  sessionSetArchived: 'session:set-archived',
  sessionBranch: 'session:branch',
  sessionExport: 'session:export',
  sessionClearAll: 'session:clear-all',
  chatRegenerate: 'chat:regenerate',
  chatEditResend: 'chat:edit-resend',
  chatDeleteAfter: 'chat:delete-after',

  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatCompact: 'chat:compact',
  researchStart: 'research:start',
  researchSteer: 'research:steer',

  queueList: 'queue:list',
  queueAdd: 'queue:add',
  queueUpdate: 'queue:update',
  queueRemove: 'queue:remove',

  permissionRespond: 'permission:respond',
  questionRespond: 'question:respond',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChanged: 'settings:changed',
  settingsSaveProvider: 'settings:save-provider',
  settingsRemoveProvider: 'settings:remove-provider',
  settingsTestProvider: 'settings:test-provider',
  settingsCompleteOnboarding: 'settings:complete-onboarding',
  settingsSyncModels: 'settings:sync-models',
  settingsSaveWebSearch: 'settings:save-web-search',
  settingsTestWebSearch: 'settings:test-web-search',
  goalStart: 'goal:start',
  goalPause: 'goal:pause',
  goalResume: 'goal:resume',
  goalStop: 'goal:stop',
  goalClear: 'goal:clear',

  planSetMode: 'plan:set-mode',
  planApprove: 'plan:approve',
  planRevise: 'plan:revise',
  planReject: 'plan:reject',

  checkpointList: 'checkpoint:list',
  checkpointPreview: 'checkpoint:preview',
  checkpointRewind: 'checkpoint:rewind',

  workspacePick: 'workspace:pick',
  workspaceValidate: 'workspace:validate',
  workspaceRecent: 'workspace:recent',
  workspaceCreateDemo: 'workspace:create-demo',
  demoInfo: 'demo:info',

  fileSearch: 'file:search',
  fileAttach: 'file:attach',
  artifactRead: 'artifact:read',
  artifactPreviewHtml: 'artifact:preview-html',
  artifactOpenExternal: 'artifact:open-external',
  artifactReveal: 'artifact:reveal',
  artifactSaveToWorkspace: 'artifact:save-to-workspace',
  artifactVersions: 'artifact:versions',
  artifactVersionRead: 'artifact:version-read',
  artifactVersionRestore: 'artifact:version-restore',
  artifactExport: 'artifact:export',
  artifactExportText: 'artifact:export-text',
  tokenActivityGet: 'token-activity:get',
  islandState: 'island:state',
  islandSetExpanded: 'island:set-expanded',
  islandHide: 'island:hide',
  islandOpenMain: 'island:open-main',
  islandQuickSend: 'island:quick-send',
  islandSyncSession: 'island:sync-session',
  islandSyncStudio: 'island:sync-studio',
  fileRestoreSnapshot: 'file:restore-snapshot'
} as const

export const EVENT_CHANNEL = 'morrow:event'

export const WINDOW_STATE_CHANNEL = 'morrow:window-state'

/** 主进程请求渲染层弹出关闭询问（最小化到任务栏 / 完全退出） */
export const WINDOW_CLOSE_REQUEST_CHANNEL = 'morrow:window-close-requested'

/** 系统通知点击后聚焦某个会话（主 → 渲染） */
export const FOCUS_SESSION_CHANNEL = 'morrow:focus-session'

/** 灵动岛状态推送（主进程 → 灵动岛窗口） */
export const ISLAND_UPDATE_CHANNEL = 'island:update'

/** 灵动岛把一句话交给主窗口发送（主进程 → 主窗口） */
export const ISLAND_QUICK_SEND_CHANNEL = 'morrow:island:quick-send'

/** 灵动岛请求主窗口切到某会话或新建会话（主进程 → 主窗口） */
export const ISLAND_OPEN_CHANNEL = 'morrow:island:open'

export interface IslandQuickSendInput {
  text: string
  /** 指定会话；缺省 = 主窗口当前会话 */
  sessionId?: string | null
}

export interface IslandOpenMainInput {
  sessionId?: string | null
  /** 打开后新建一个空对话 */
  newSession?: boolean
  /** 打开主窗口并切到创作台 */
  studio?: boolean
}

export interface IslandStudioSyncInput {
  active: boolean
  projectId?: string | null
  projectTitle?: string
  kind?: 'short' | 'novel' | 'drama'
  stage?: string
  jobLabel?: string
  jobProgress?: number | null
  jobStatus?: 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'
  startedAt?: number | null
  jobs?: number
}

export interface CompactResult {
  compacted: boolean
  savedTokens: number
  messageCount: number
  reason?: string
}

export interface ProviderTestInput {
  providerId: string
  config?: Partial<ProviderConfig>
  apiKey?: string
  modelId?: string
}

export interface SaveProviderInput {
  config: ProviderConfig
  apiKey?: string
}

export interface GoalStartInput {
  sessionId: string
  objective: string
  maxRounds?: number
  /** 可选的预算参数（不传用产品默认：200 次工具调用 / 20 分钟 / 3 轮无进展） */
  maxToolCalls?: number
  maxActiveMs?: number
  maxNoProgressRounds?: number
}

export interface GoalActionResult {
  goal: import('./types').Goal | null
  /** 若启动了新一轮运行，返回 runId */
  runId?: string
}

export interface PlanActionResult {
  plan: import('./types').SessionPlan | null
  /** 批准或修订后若自动启动了运行，返回 runId */
  runId?: string
  meta?: import('./types').SessionMeta
}

export interface SyncModelsResult {
  providerId: string
  providerName: string
  added: number
  updated: number
  total: number
  message: string
  models: ModelInfo[]
  truncated?: boolean
  skipped?: number
  settings?: import('./types').Settings
}

export interface SaveWebSearchInput {
  enabled: boolean
  provider: import('./types').WebSearchProvider
  baseUrl?: string
  maxResults: number
  apiKey?: string
}

export interface WebSearchTestResult {
  ok: boolean
  provider: string
  sourceCount: number
  latencyMs: number
  message: string
  sources?: import('./types').WebSearchSource[]
}

export interface CompleteOnboardingInput {
  providerId?: string
  apiKey?: string
  model?: ModelRef
  workspace?: string | null
  demo?: boolean
}

export interface UpdateSettingsInput extends Partial<Settings> {}

/**
 * preload 通过 contextBridge 暴露给渲染层的窄接口。
 * 渲染层只能看到这个对象，拿不到 ipcRenderer / node。
 */
export interface MorrowApi {
  platform: string
  isTest: boolean
  versions: { electron: string; chrome: string; node: string }
  bootstrap(): Promise<Result<Bootstrap>>
  onEvent(listener: RuntimeEventListener): () => void
  island: {
    /** 当前桌面小伙伴状态（重开灵动岛时恢复） */
    snapshot(): Promise<Result<import('./types').IslandSnapshot>>
    /** 展开/收起；主进程负责改变窗口尺寸并保持贴边 */
    setExpanded(expanded: boolean): Promise<Result<void>>
    /** 完全隐藏灵动岛（不关闭功能，仍可从托盘/快捷键唤回） */
    hide(): Promise<Result<void>>
    /** 打开主窗口，可顺带切到指定会话或新建对话 */
    openMain(input?: IslandOpenMainInput): Promise<Result<void>>
    /** 把一句话交给主窗口发送；主窗口会显示并开始运行 */
    quickSend(input: IslandQuickSendInput): Promise<Result<void>>
    /** 主窗口切到哪个会话，灵动岛就跟随哪个会话（含计划、进度与运行耗时） */
    syncSession(sessionId: string | null): Promise<Result<void>>
    /** 主窗口切到创作台时，灵动岛显示作品与任务进度 */
    syncStudio(input: IslandStudioSyncInput): Promise<Result<void>>
    onState(listener: (snapshot: import('./types').IslandSnapshot) => void): () => void
    /** 仅主窗口使用：接收灵动岛转来的消息 */
    onQuickSend(listener: (input: IslandQuickSendInput) => void): () => void
    /** 仅主窗口使用：响应灵动岛的「打开/新对话」 */
    onOpen(listener: (input: IslandOpenMainInput) => void): () => void
  }
  window: {
    minimize(): Promise<Result<void>>
    toggleMaximize(): Promise<Result<boolean>>
    close(): Promise<Result<void>>
    /** 在关闭询问弹窗里做出选择：记住并立即执行 */
    resolveClose(action: Exclude<CloseAction, 'ask'>): Promise<Result<void>>
    getState(): Promise<Result<WindowState>>
    onStateChange(listener: (state: WindowState) => void): () => void
    /** 主进程请求显示关闭询问弹窗 */
    onCloseRequested(listener: () => void): () => void
  }
  chat: {
    send(input: SendMessageInput): Promise<Result<SendMessageResult>>
    /** 用户确认深度研究计划后开始检索 */
    startResearch(input: { sessionId: string; plan: string; depth?: import('./types').ResearchDepth }): Promise<Result<SendMessageResult>>
    /** 检索中追加研究要求（下一轮优先纳入） */
    steerResearch(input: { sessionId: string; text: string }): Promise<Result<import('./types').ResearchState>>
    cancel(runId: string): Promise<Result<void>>
    compact(sessionId: string): Promise<Result<CompactResult>>
    /** 重新生成最后一条用户消息的回复 */
    regenerate(sessionId: string): Promise<Result<SendMessageResult>>
    /** 编辑一条用户消息并从这里重新发送 */
    editResend(sessionId: string, messageId: string, text: string): Promise<Result<SendMessageResult>>
    /** 删除某条消息之后的所有消息（保留该条） */
    deleteAfter(sessionId: string, messageId: string): Promise<Result<Session>>
    respondPermission(requestId: string, decision: PermissionDecision): Promise<Result<void>>
    respondQuestion(requestId: string, answer: AskUserAnswer): Promise<Result<void>>
  }
  session: {
    list(): Promise<Result<SessionMeta[]>>
    create(input: CreateSessionInput): Promise<Result<Session>>
    load(sessionId: string): Promise<Result<Session>>
    rename(sessionId: string, title: string): Promise<Result<SessionMeta>>
    remove(sessionId: string): Promise<Result<void>>
    setModel(sessionId: string, model: ModelRef): Promise<Result<SessionMeta>>
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<Result<SessionMeta>>
    /** 切换显式「聊天 / 工作」模式（运行中会被拒绝；持久化到会话文件并广播 session_updated） */
    setMode(sessionId: string, mode: SessionMode): Promise<Result<SessionMeta>>
    /** 切换当前会话推理强度 */
    setReasoningEffort(
      sessionId: string,
      effort: import('./types').ReasoningEffort
    ): Promise<Result<SessionMeta>>
    setPinned(sessionId: string, pinned: boolean): Promise<Result<SessionMeta>>
    setArchived(sessionId: string, archived: boolean): Promise<Result<SessionMeta>>
    /** 从某条消息分叉出一个新会话 */
    branch(sessionId: string, messageId: string, title?: string): Promise<Result<Session>>
    /** 导出为 Markdown / JSON；返回保存路径，取消返回 null */
    exportSession(sessionId: string, format: 'markdown' | 'json'): Promise<Result<string | null>>
    /** 清除全部对话及其派生数据（快照/检查点/成品版本/用量/审批日志），不删除工作区文件 */
    clearAll(): Promise<Result<{ deleted: number }>>
  }
  settings: {
    get(): Promise<Result<Settings>>
    update(patch: UpdateSettingsInput): Promise<Result<Settings>>
    onChanged(listener: (settings: Settings) => void): () => void
    saveProvider(input: SaveProviderInput): Promise<Result<Settings>>
    removeProvider(providerId: string): Promise<Result<Settings>>
    testProvider(input: ProviderTestInput): Promise<Result<ProviderTestResult>>
    completeOnboarding(input: CompleteOnboardingInput): Promise<Result<Bootstrap>>
    syncModels(providerId: string): Promise<Result<SyncModelsResult>>
    saveWebSearch(input: SaveWebSearchInput): Promise<Result<Settings>>
    testWebSearch(): Promise<Result<WebSearchTestResult>>
  }
  goal: {
    start(input: GoalStartInput): Promise<Result<GoalActionResult>>
    pause(sessionId: string): Promise<Result<GoalActionResult>>
    resume(sessionId: string): Promise<Result<GoalActionResult>>
    stop(sessionId: string): Promise<Result<GoalActionResult>>
    clear(sessionId: string): Promise<Result<GoalActionResult>>
  },
  plan: {
    /** 开启/关闭计划模式（仅工作模式可用；运行中拒绝） */
    setMode(sessionId: string, enabled: boolean): Promise<Result<import('./types').SessionMeta>>
    /** 批准当前待审计划，自动切到执行并启动一轮运行 */
    approve(sessionId: string): Promise<Result<PlanActionResult>>
    /** 带着修改意见重新生成计划（自动启动计划模式运行） */
    revise(sessionId: string, feedback: string): Promise<Result<PlanActionResult>>
    /** 拒绝当前计划（保留在会话里，可重新规划） */
    reject(sessionId: string, feedback?: string): Promise<Result<PlanActionResult>>
  },
  checkpoints: {
    list(sessionId: string): Promise<Result<import('./types').TurnCheckpoint[]>>
    preview(sessionId: string, checkpointId: string): Promise<Result<import('./types').RewindPreview>>
    rewind(
      sessionId: string,
      checkpointId: string,
      scope: import('./types').RewindScope
    ): Promise<Result<import('./types').RewindResult>>
  },
  queue: {
    list(sessionId: string): Promise<Result<import('./types').QueuedMessage[]>>
    add(input: { sessionId: string; text: string; attachments?: import('./types').Attachment[] }): Promise<
      Result<import('./types').QueuedMessage[]>
    >
    update(input: { sessionId: string; queueId: string; text: string }): Promise<
      Result<import('./types').QueuedMessage[]>
    >
    remove(input: { sessionId: string; queueId: string }): Promise<Result<import('./types').QueuedMessage[]>>
  },
  workspace: {
    pick(): Promise<Result<WorkspaceInfo | null>>
    validate(path: string): Promise<Result<WorkspaceInfo>>
    recent(): Promise<Result<WorkspaceInfo[]>>
    createDemo(): Promise<Result<WorkspaceInfo>>
  }
  demo: {
    info(): Promise<Result<DemoInfo>>
  }
  files: {
    search(root: string, query: string, limit?: number): Promise<Result<FileSearchResult[]>>
    attach(): Promise<Result<Attachment[]>>
    /** Electron 38 起 File.path 已移除，拖拽文件需要走 webUtils 拿到真实路径 */
    getPathForFile(file: File): string
    /** 从写前快照恢复文件（撤销一次文件修改） */
    restoreSnapshot(input: { sessionId: string; snapshotPath: string; targetPath: string }): Promise<Result<void>>
  }
  artifacts: {
    read(path: string): Promise<Result<{ content: string; size: number; kind: string; truncated: boolean }>>
    /** 为 HTML 产物登记一份沙箱预览文档，返回可放进 iframe 的 morrow-artifact:// URL */
    previewHtml(html: string): Promise<Result<{ url: string }>>
    openExternal(path: string): Promise<Result<void>>
    reveal(path: string): Promise<Result<void>>
    /** 把成品保存到工作区 artifacts/ 并回写 artifact.path */
    saveToWorkspace(sessionId: string, artifactId: string): Promise<Result<{ path: string; artifact: Artifact }>>
    /** 文本成品的历史版本（最新在前）；打开时会先把当前内容同步为基线。 */
    versions(sessionId: string, artifactId: string): Promise<Result<ArtifactVersionInfo[]>>
    readVersion(
      sessionId: string,
      artifactId: string,
      versionId: string
    ): Promise<Result<{ version: ArtifactVersionInfo; content: string }>>
    /** 恢复到历史版本，并记录一个 restore 版本 */
    restoreVersion(sessionId: string, artifactId: string, versionId: string): Promise<Result<Artifact>>
    /** 导出为不同格式，弹出系统保存框；取消返回 null */
    exportFile(
      sessionId: string,
      artifactId: string,
      format: ArtifactExportFormat
    ): Promise<Result<string | null>>
    /** 生成导出文本用于复制，不落盘（PDF 除外） */
    exportText(
      sessionId: string,
      artifactId: string,
      format: Exclude<ArtifactExportFormat, 'pdf' | 'original'>
    ): Promise<Result<string>>
  }
  tokenActivity: {
    get(): Promise<Result<TokenActivitySummary>>
  }
  features: {
    /** 扩展功能统一入口；仅接受已注册的 feature:<name>:<action> 频道 */
    invoke<T = unknown>(channel: string, payload?: unknown): Promise<Result<T>>
    /** 扩展功能事件（仅接受 feature: 前缀）；返回取消订阅函数 */
    on(channel: string, listener: (payload: unknown) => void): () => void
  }
  app: {
    openExternal(url: string): Promise<Result<void>>
    /** 主题变化时同步窗口/托盘图标（深色/浅色两套品牌资产） */
    setTheme(theme: 'dark' | 'light'): Promise<Result<void>>
    openDataDir(): Promise<Result<void>>
    openLogs(): Promise<Result<void>>
    /** 选择并应用新的数据目录；迁移现有数据后重启 */
    changeDataDir(): Promise<Result<{ restarted: boolean; path?: string; canceled?: boolean; files?: number }>>
    /** 移除自定义目录并重启回默认目录（当前自定义目录不删除） */
    resetDataDir(): Promise<Result<{ restarted: boolean; canceled?: boolean }>>
    /** 系统通知点击：聚焦并切换到指定会话 */
    onFocusSession(listener: (sessionId: string) => void): () => void
  }
}
