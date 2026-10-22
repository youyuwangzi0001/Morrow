import type { ModelInfo, ModelRef, ProviderConfig, Settings } from './types'

/**
 * 内置模型预设。
 * 数据截至 2026-10-19，来源与核对方式见 docs/MODELS-RESEARCH.md；
 * 设置页支持「从服务商同步模型列表」在运行时刷新上下文/输出上限等元数据。
 */

const deepseekModels: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    contextWindow: 1_048_576,
    maxOutput: 393_216,
    supportsTools: true,
    supportsReasoning: true,
    note: '速度快、性价比高'
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
    maxOutput: 393_216,
    supportsTools: true,
    supportsReasoning: true,
    note: '旗舰推理与复杂任务能力，适合长任务'
  }
]

const kimiModels: ModelInfo[] = [
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '支持图片输入'
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    contextWindow: 262_144,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '面向代码与 Agent 任务'
  },
  {
    id: 'kimi-k2.6',
    label: 'Kimi K2.6',
    contextWindow: 262_144,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true
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
    supportsReasoning: true,
    note: 'Anthropic 旗舰，适合长任务与复杂写作'
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    note: '速度与质量平衡'
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
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
    supportsReasoning: true,
    note: 'OpenAI 当前默认旗舰（2026-10-09 发布）'
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    note: '最复杂推理与编码旗舰（2026-09-04 发布）'
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
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
    supportsReasoning: true,
    note: 'Google 前沿旗舰（2026-10 上线），适合超长资料'
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
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
    supportsReasoning: true,
    note: '原生多模态、低成本版本（320B 总参 / 18B 激活）'
  }
]

const miniMaxModels: ModelInfo[] = [
  {
    id: 'MiniMax-M3',
    label: 'MiniMax M3',
    contextWindow: 1_000_000,
    maxOutput: 512_000,
    supportsTools: true,
    supportsReasoning: true,
    note: '擅长代码和 Agent 任务'
  },
  {
    id: 'MiniMax-M3.1-Flash',
    label: 'MiniMax M3.1 Flash',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '最新轻量版，速度优先'
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
    supportsReasoning: true,
    note: 'xAI 当前旗舰（2026-09-21），支持图片输入'
  },
  {
    id: 'grok-4.1-fast',
    label: 'Grok 4.1 Fast',
    contextWindow: 2_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '长上下文、低延迟上一代'
  }
]

const openRouterModels: ModelInfo[] = [
  {
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol（OpenRouter）',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true
  },
  {
    id: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5（OpenRouter）',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true
  },
  {
    id: 'google/gemini-4-argon',
    label: 'Gemini 4 Argon（OpenRouter）',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true
  },
  {
    id: 'x-ai/grok-4.7',
    label: 'Grok 4.7（OpenRouter）',
    contextWindow: 500_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4.1 Flash（OpenRouter）',
    contextWindow: 1_048_576,
    maxOutput: 393_216,
    supportsTools: true,
    supportsReasoning: true
  }
]

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

/** 给内置模型补充推理映射与参考价；未知模型不猜测价格。 */
function enrichModels(models: ModelInfo[], providerId: string): ModelInfo[] {
  return models.map((model) => {
    // OpenAI 兼容协议（DeepSeek/Kimi/Qwen/GLM 等）同样使用 reasoning_effort；
    // 只有 Anthropic 走 thinking.budget_tokens。缺失 style 会导致 UI 隐藏推理选项。
    const reasoningStyle =
      model.reasoningStyle ??
      (model.supportsReasoning ? (providerId === 'anthropic' ? 'thinking' : 'effort') : undefined)
    const pricing = model.pricing ?? pricingForModel(model.id)
    return {
      ...model,
      ...(reasoningStyle ? { reasoningStyle } : {}),
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
      id: 'openrouter',
      kind: 'openai-compat',
      name: 'OpenRouter（模型聚合）',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: enrichModels(openRouterModels, 'openrouter'),
      apiKeyStored: false,
      enabled: true,
      isBuiltin: true,
      category: 'aggregator'
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

export function defaultSettings(): Settings {
  return {
    version: 1,
    theme: 'dark',
    fontSize: 14,
    reduceMotion: false,
    permissionMode: 'ask',
    sendKey: 'enter',
    providers: builtinProviders(),
    defaultModel: DEFAULT_MODEL,
    lastWorkspace: null,
    recentWorkspaces: [],
    onboardingDone: false,
    sidebarCollapsed: false,
    demoSeen: false,
    showTokenMeter: true,
    autoTitle: true,
    sidebarWidth: 240,
    autoCompact: true,
    compactThreshold: 0.8,
    canvasWidth: 420,
    layoutVersion: 2,
    webSearch: {
      enabled: false,
      provider: 'tavily',
      apiKeyStored: false,
      maxResults: 5
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
