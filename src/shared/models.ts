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
    note: '官方实测：可处理约 1M 内容 / 回复最多 384K，速度快、性价比高'
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
    note: '可处理约 1M 内容，支持图片'
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    contextWindow: 262_144,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '面向代码与 Agent 的 256K 模型'
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
    note: '通义千问旗舰，可处理约 1M 内容'
  },
  {
    id: 'qwen-plus',
    label: 'Qwen Plus',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '成本更低的通用选择'
  }
]

const anthropicModels: ModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    note: 'Anthropic 旗舰，可处理约 1M 内容 / 回复最多 128K'
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
    note: 'OpenAI 当前默认旗舰（2026-10-09 发布），1.05M 上下文 / 128K 输出'
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    supportsTools: true,
    supportsReasoning: true,
    note: '最复杂推理与编码旗舰（2026-09-04 发布），1.05M 上下文 / 128K 输出'
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
    note: 'Google 前沿旗舰（2026-10 上线）：可处理约 1M 内容；单次回复默认 65K，长内容可更长'
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '高性价比档位（2026-10 最新 Flash），1M 输入 / 65K 输出'
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
    note: '智谱旗舰（2026-10-15），可处理约 1M 内容 / 回复最多 128K，默认深入思考'
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
    id: 'MiniMax-M3.1-Flash-Preview',
    label: 'MiniMax M3.1 Flash Preview',
    contextWindow: 524_288,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true,
    note: '官方 Codex 文档标注 512K 上下文'
  },
  {
    id: 'MiniMax-M2.5',
    label: 'MiniMax M2.5',
    contextWindow: 204_800,
    maxOutput: 65_536,
    supportsTools: true,
    supportsReasoning: true
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
    note: 'xAI 当前旗舰（2026-09-21），500K 上下文，文本+图片输入'
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

export function builtinProviders(): ProviderConfig[] {
  return [
    {
      id: 'deepseek',
      kind: 'openai-compat',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: deepseekModels,
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
      models: kimiModels,
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
      models: qwenModels,
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
      models: glmModels,
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
      models: miniMaxModels,
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
      models: anthropicModels,
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
      models: openaiModels,
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
      models: geminiModels,
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
      models: xaiModels,
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
      models: openRouterModels,
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
      models: localModels.map((m) => ({ ...m, label: 'Ollama 本地模型（改成实际 ID）' })),
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
      models: localModels.map((m) => ({ ...m, label: 'LM Studio 本地模型（改成实际 ID）' })),
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

export function findModel(providers: ProviderConfig[], ref: ModelRef): ModelInfo | null {
  const provider = providers.find((p) => p.id === ref.providerId)
  return provider?.models.find((m) => m.id === ref.modelId) ?? null
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
    layoutVersion: 2
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
