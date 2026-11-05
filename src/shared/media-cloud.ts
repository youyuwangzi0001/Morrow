/** 云端多媒体生成：只登记有官方文档、能实际调用的接口。 */

import { MINIMAX_SPEECH_VOICES, OPENAI_TTS_VOICES, QWEN3_TTS_VOICES } from './media-voices'
import type { CloudMediaVoice } from './media-voices'

export type CloudMediaCapability = 'image' | 'video' | 'speech' | 'music'
export type CloudMediaRegion = 'domestic' | 'global'

export type CloudMediaProtocol =
  | 'openai-image'
  | 'google-gemini-image'
  | 'stability-image'
  | 'ark-image'
  | 'dashscope-image'
  | 'google-veo'
  | 'ark-video'
  | 'minimax-video'
  | 'openai-speech'
  | 'elevenlabs-speech'
  | 'dashscope-speech'
  | 'minimax-speech'
  | 'elevenlabs-music'

export interface CloudMediaProvider {
  id: string
  capability: CloudMediaCapability
  protocol: CloudMediaProtocol
  /** 展示名，例如 OpenAI Images */
  name: string
  baseUrl: string
  model: string
  /** 配音声线 / 声音 ID；不同服务商含义不同 */
  voice?: string
  enabled: boolean
  apiKeyStored: boolean
  isBuiltin?: boolean
}

export interface CloudMediaPreset {
  id: string
  capability: CloudMediaCapability
  protocol: CloudMediaProtocol
  region: CloudMediaRegion
  /** 同一类能力下的服务商名，例如 OpenAI */
  providerName: string
  name: string
  description: string
  baseUrl: string
  model: string
  /** 需要用户填 voice ID 时给出提示 */
  voiceRequired?: boolean
  /** 可选的默认声线；用户留空时由协议层使用 */
  defaultVoice?: string
  /** 官方系统音色；没有固定列表的服务（如 ElevenLabs）不填 */
  voices?: CloudMediaVoice[]
  docsUrl: string
}

export const MEDIA_CAPABILITY_LABEL: Record<CloudMediaCapability, string> = {
  image: '图片生成',
  video: '视频生成',
  speech: '配音生成',
  music: '配乐生成'
}

export const MEDIA_CAPABILITY_HINT: Record<CloudMediaCapability, string> = {
  image: '给分镜、封面或插图生成画面。',
  video: '把分镜画面升级成带运动的视频。',
  speech: '把台词合成为可用的配音音轨。',
  music: '生成可商用的背景音乐或配乐。'
}

export const MEDIA_REGION_LABEL: Record<CloudMediaRegion, string> = {
  domestic: '国内',
  global: '海外'
}

/**
 * 截至 2026-11-05 可用的官方接口：
 * - 国内：火山方舟 Seedream 5.0 / Seedance 2.5、阿里云百炼 Qwen-Image / Qwen3-TTS、MiniMax H3
 * - 海外：OpenAI Images 2.6 / TTS、Google Nano Banana 2.1 / Veo 3.1、Stability SD3.5、ElevenLabs v4 / Music v2.5
 *
 * 不接入没有公开官方 API 的平台；不做“占位可选项”。Imagen 4 已于 2026-08-17 停服，
 * 图片改用 Gemini 的 Nano Banana 系列。
 */
export const CLOUD_MEDIA_PRESETS: CloudMediaPreset[] = [
  {
    id: 'seedream-5-pro',
    capability: 'image',
    protocol: 'ark-image',
    region: 'domestic',
    providerName: '字节跳动',
    name: 'Seedream 5.0 Pro',
    description: '火山方舟 Seedream 5.0 Pro，中文文字与写实画面表现强；按官方张数计费。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-pro-260628',
    docsUrl: 'https://www.volcengine.com/docs/82379/1541523'
  },
  {
    id: 'seedream-5-flash',
    capability: 'image',
    protocol: 'ark-image',
    region: 'domestic',
    providerName: '字节跳动',
    name: 'Seedream 5.0 Flash',
    description: 'Seedream 5.0 Flash，速度更快、成本更低，适合批量生成分镜。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-flash-260915',
    docsUrl: 'https://www.volcengine.com/docs/82379/1541523'
  },
  {
    id: 'qwen-image-2-pro',
    capability: 'image',
    protocol: 'dashscope-image',
    region: 'domestic',
    providerName: '阿里云百炼',
    name: 'Qwen-Image 2.1 Pro',
    description: '阿里云百炼 Qwen-Image 2.1 Pro，中文排版与写实质感强；也可在模型 ID 改用 2.1 Turbo。',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-image-2.1-pro',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-api'
  },
  {
    id: 'openai-image',
    capability: 'image',
    protocol: 'openai-image',
    region: 'global',
    providerName: 'OpenAI',
    name: 'OpenAI Images 2.6',
    description: 'OpenAI Images 2.6 Sunburst，注重细节与多轮编辑一致性；按图片 Token 计费。',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2.6-sunburst',
    docsUrl: 'https://platform.openai.com/docs/guides/image-generation'
  },
  {
    id: 'openai-image-flare',
    capability: 'image',
    protocol: 'openai-image',
    region: 'global',
    providerName: 'OpenAI',
    name: 'OpenAI Images 2.6 Flare',
    description: 'Images 2.6 Flare 主打速度，低画质设置下最快约 6 秒出图，适合快速预览。',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-2.6-flare',
    docsUrl: 'https://platform.openai.com/docs/guides/image-generation'
  },
  {
    id: 'google-nano-banana',
    capability: 'image',
    protocol: 'google-gemini-image',
    region: 'global',
    providerName: 'Google',
    name: 'Gemini Nano Banana 2.1',
    description: 'Gemini API 的 Nano Banana 2.1（2026-10 稳定版）；Imagen 4 已停服。',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-nano-banana-2.1',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation'
  },
  {
    id: 'stability-image',
    capability: 'image',
    protocol: 'stability-image',
    region: 'global',
    providerName: 'Stability AI',
    name: 'Stability SD3.5',
    description: 'Stability 官方 Stable Image API，默认 SD3.5 Large。',
    baseUrl: 'https://api.stability.ai',
    model: 'sd3.5-large',
    docsUrl: 'https://platform.stability.ai/docs/api-reference'
  },
  {
    id: 'seedance-2-5',
    capability: 'video',
    protocol: 'ark-video',
    region: 'domestic',
    providerName: '字节跳动',
    name: 'Seedance 2.5',
    description: '火山方舟 Seedance 2.5，支持文生视频与首帧图生视频；按官方秒数计费。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedance-2-5-260628',
    docsUrl: 'https://www.volcengine.com/docs/82379/1393047'
  },
  {
    id: 'seedance-2-0',
    capability: 'video',
    protocol: 'ark-video',
    region: 'domestic',
    providerName: '字节跳动',
    name: 'Seedance 2.0',
    description: 'Seedance 2.0 成熟版本，支持首帧图生视频与 480P–4K 输出。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedance-2-0-260128',
    docsUrl: 'https://www.volcengine.com/docs/82379/1393047'
  },
  {
    id: 'minimax-h3',
    capability: 'video',
    protocol: 'minimax-video',
    region: 'domestic',
    providerName: 'MiniMax',
    name: 'MiniMax H3',
    description: 'MiniMax H3 全模态视频模型，原生音画与首帧控制，支持 768P/2K。',
    baseUrl: 'https://api.minimax.cn',
    model: 'MiniMax-H3',
    docsUrl: 'https://platform.minimax.cn/docs/guides/video-generation'
  },
  {
    id: 'google-veo',
    capability: 'video',
    protocol: 'google-veo',
    region: 'global',
    providerName: 'Google',
    name: 'Google Veo 3.1',
    description: 'Gemini API 的 Veo 3.1 稳定版，支持首帧图生视频与 4/6/8 秒片段。',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'veo-3.1-generate-001',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/veo'
  },
  {
    id: 'qwen3-tts',
    capability: 'speech',
    protocol: 'dashscope-speech',
    region: 'domestic',
    providerName: '阿里云百炼',
    name: 'Qwen3-TTS-Flash',
    description: '阿里云百炼 Qwen3-TTS-Flash，默认 Cherry 音色；支持中文、方言与多语种。',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen3-tts-flash',
    defaultVoice: 'Cherry',
    voices: QWEN3_TTS_VOICES,
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-tts-api'
  },
  {
    id: 'minimax-speech-2-8',
    capability: 'speech',
    protocol: 'minimax-speech',
    region: 'domestic',
    providerName: 'MiniMax',
    name: 'MiniMax Speech 2.8 HD',
    description: 'MiniMax 同步语音合成，默认 speech-2.8-hd；可在声线栏填 MiniMax voice_id。',
    baseUrl: 'https://api.minimax.cn',
    model: 'speech-2.8-hd',
    defaultVoice: 'female-shaonv',
    voices: MINIMAX_SPEECH_VOICES,
    docsUrl: 'https://platform.minimax.cn/docs/guides/models-intro'
  },
  {
    id: 'openai-speech',
    capability: 'speech',
    protocol: 'openai-speech',
    region: 'global',
    providerName: 'OpenAI',
    name: 'OpenAI TTS',
    description: '官方 Audio Speech API，默认 gpt-4o-mini-tts；可填 alloy、nova 等声线。',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    defaultVoice: 'alloy',
    voices: OPENAI_TTS_VOICES,
    docsUrl: 'https://platform.openai.com/docs/guides/text-to-speech'
  },
  {
    id: 'elevenlabs-speech',
    capability: 'speech',
    protocol: 'elevenlabs-speech',
    region: 'global',
    providerName: 'ElevenLabs',
    name: 'ElevenLabs TTS',
    description: '官方 Text to Speech API，默认 Eleven v4；需要填账号里的 Voice ID。',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_v4',
    voiceRequired: true,
    docsUrl: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert'
  },
  {
    id: 'elevenlabs-music',
    capability: 'music',
    protocol: 'elevenlabs-music',
    region: 'global',
    providerName: 'ElevenLabs',
    name: 'ElevenLabs Music',
    description: '官方 Music API，默认 Music v2.5；商业授权取决于账号套餐。',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'music_v2_5',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/music/compose'
  }
]

/** 只迁移上一轮的默认模型；用户自己填过的模型 ID 原样保留。 */
const LEGACY_DEFAULT_MODELS: Record<string, string[]> = {
  'openai-image': ['gpt-image-1', 'gpt-image-2.5-sunburst'],
  'google-veo': ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview'],
  'elevenlabs-speech': ['eleven_multilingual_v2'],
  'elevenlabs-music': ['music_v2']
}

export function cloudMediaPreset(id: string): CloudMediaPreset | null {
  return CLOUD_MEDIA_PRESETS.find((preset) => preset.id === id) ?? null
}

export function cloudMediaPresetsFor(capability: CloudMediaCapability): CloudMediaPreset[] {
  return CLOUD_MEDIA_PRESETS.filter((preset) => preset.capability === capability)
}

export function normalizeCloudMediaProviders(input: unknown): CloudMediaProvider[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const providers: CloudMediaProvider[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const preset = cloudMediaPreset(String(record.id ?? ''))
    if (!preset || seen.has(preset.id)) continue
    const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : preset.baseUrl
    const savedModel = typeof record.model === 'string' ? record.model.trim() : ''
    const model = savedModel && LEGACY_DEFAULT_MODELS[preset.id]?.includes(savedModel) ? preset.model : savedModel || preset.model
    if (!/^https?:\/\//i.test(baseUrl) || !model) continue
    seen.add(preset.id)
    providers.push({
      id: preset.id,
      capability: preset.capability,
      protocol: preset.protocol,
      name: preset.name,
      baseUrl,
      model: model.slice(0, 200),
      ...(typeof record.voice === 'string' && record.voice.trim() ? { voice: record.voice.trim().slice(0, 200) } : {}),
      enabled: record.enabled !== false,
      apiKeyStored: record.apiKeyStored === true,
      isBuiltin: true
    })
  }
  return providers
}

export function normalizeMediaDefaults(input: unknown, providers: CloudMediaProvider[]): Partial<Record<CloudMediaCapability, string>> {
  if (!input || typeof input !== 'object') return {}
  const ids = new Set(providers.map((provider) => provider.id))
  const result: Partial<Record<CloudMediaCapability, string>> = {}
  for (const capability of Object.keys(MEDIA_CAPABILITY_LABEL) as CloudMediaCapability[]) {
    const value = (input as Record<string, unknown>)[capability]
    if (typeof value === 'string' && ids.has(value)) {
      const provider = providers.find((item) => item.id === value)
      if (provider?.capability === capability) result[capability] = value
    }
  }
  return result
}
