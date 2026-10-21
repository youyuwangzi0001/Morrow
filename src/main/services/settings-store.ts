import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DEFAULT_MODEL, builtinProviders, defaultSettings, findModel, normalizeReasoningStyle } from '../../shared/models'
import type {
  HookConfig,
  HookEvent,
  ModelInfo,
  ProviderCategory,
  ProviderConfig,
  ProviderKind,
  Settings,
  WebSearchProvider,
  WebSearchSettings
} from '../../shared/types'
import { dataPath, ensureDataDirs } from './paths'
import { log } from './logger'
import { LEGACY_FALLBACK_PREFIX, decodeSecret, encodeSecret, type SecretCrypto } from './secret-codec'
import { isHookEvent, MAX_ENABLED_HOOKS_PER_EVENT, MAX_HOOKS } from '../../shared/hooks'
import { isReasoningEffort } from '../../shared/reasoning'
import {
  ANSWER_STYLE_MAX_CUSTOM,
  isAnswerStyleId,
  normalizeAnswerStyle,
  normalizeAnswerStyleCustom
} from '../../shared/answer-style'

interface SecretsFile {
  version: 1
  /** providerId -> base64(encrypted)（历史版本可能是 `b64:` 前缀的降级明文，只读兼容） */
  keys: Record<string, string>
}

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const PROVIDER_KINDS: ReadonlySet<ProviderKind> = new Set(['openai-compat', 'anthropic', 'demo'])
const PROVIDER_CATEGORIES: ReadonlySet<ProviderCategory> = new Set(['cn', 'global', 'aggregator', 'local', 'custom'])
const MAX_MODELS = 200
const MAX_HEADERS = 32
const WEB_SEARCH_PROVIDERS: ReadonlySet<WebSearchProvider> = new Set(['tavily', 'brave', 'serper', 'searxng'])

/** 从磁盘/设置页读入的钩子做宽松归一化；执行前仍由 HookService 过滤。 */
export function normalizeHooks(raw: unknown): HookConfig[] {
  if (!Array.isArray(raw)) return []
  const hooks: HookConfig[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_HOOKS)) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 64) : ''
    const event = isHookEvent(item.event) ? item.event : null
    const command = typeof item.command === 'string' ? item.command.trim().slice(0, 2000) : ''
    if (!id || !event || !command || seen.has(id)) continue
    seen.add(id)
    hooks.push({ id, event, command, enabled: item.enabled === true })
  }
  return hooks
}

export function webSearchKeyId(provider: WebSearchProvider): string {
  return `websearch:${provider}`
}

function normalizeWebSearch(raw: unknown, fallback: WebSearchSettings): WebSearchSettings {
  if (!isRecord(raw)) return fallback
  const provider = WEB_SEARCH_PROVIDERS.has(raw.provider as WebSearchProvider)
    ? (raw.provider as WebSearchProvider)
    : fallback.provider
  const maxResults = typeof raw.maxResults === 'number' && Number.isFinite(raw.maxResults)
    ? Math.min(10, Math.max(1, Math.round(raw.maxResults)))
    : fallback.maxResults
  return {
    enabled: raw.enabled === true,
    provider,
    ...(typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? { baseUrl: raw.baseUrl.trim().slice(0, 2048) } : {}),
    apiKeyStored: raw.apiKeyStored === true,
    maxResults
  }
}

function failValidation(message: string): never {
  throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 原子写并清理临时文件；设置/密钥文件只允许当前用户读写（Windows 上忽略 mode） */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响原始错误
    }
    throw err
  }
}

function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) failValidation('模型列表格式不正确。')
  if (raw.length > MAX_MODELS) failValidation(`模型数量过多（上限 ${MAX_MODELS} 个）。`)
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) failValidation('模型条目格式不正确。')
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || id.length > 160) failValidation('模型 ID 不能为空且不能超过 160 字符。')
    if (seen.has(id)) continue
    seen.add(id)
    const contextRaw = Number(item.contextWindow)
    if (!Number.isFinite(contextRaw) || contextRaw < 1_024 || contextRaw > 10_000_000) {
      failValidation(`模型「${id}」的上下文窗口不合法（1024–10000000）。`)
    }
    let maxOutput: number | undefined
    if (item.maxOutput !== undefined && item.maxOutput !== null) {
      const outputRaw = Number(item.maxOutput)
      if (!Number.isFinite(outputRaw) || outputRaw < 1 || outputRaw > 2_000_000) {
        failValidation(`模型「${id}」的最大输出不合法（1–2000000）。`)
      }
      maxOutput = Math.round(outputRaw)
    }
    const labelRaw = typeof item.label === 'string' ? item.label.trim() : ''
    const reasoningStyle =
      item.reasoningStyle === 'effort' || item.reasoningStyle === 'thinking' ? item.reasoningStyle : undefined
    let pricing: ModelInfo['pricing']
    if (isRecord(item.pricing)) {
      const input = Number(item.pricing.inputPerMTok)
      const output = Number(item.pricing.outputPerMTok)
      const cache = item.pricing.cacheReadPerMTok === undefined ? undefined : Number(item.pricing.cacheReadPerMTok)
      if (
        Number.isFinite(input) && input >= 0 && input <= 100_000 &&
        Number.isFinite(output) && output >= 0 && output <= 100_000 &&
        (cache === undefined || (Number.isFinite(cache) && cache >= 0 && cache <= 100_000))
      ) {
        pricing = {
          inputPerMTok: input,
          outputPerMTok: output,
          ...(cache !== undefined ? { cacheReadPerMTok: cache } : {})
        }
      }
    }
    models.push({
      id,
      label: (labelRaw || id).slice(0, 120),
      contextWindow: Math.round(contextRaw),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      supportsTools: item.supportsTools !== false,
      ...(typeof item.supportsReasoning === 'boolean' ? { supportsReasoning: item.supportsReasoning } : {}),
      ...(reasoningStyle ? { reasoningStyle } : {}),
      ...(pricing ? { pricing } : {}),
      ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim().slice(0, 200) } : {})
    })
  }
  if (models.length === 0) failValidation('至少保留一个模型。')
  return models
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) failValidation('请求头格式不正确。')
  const entries = Object.entries(raw)
  if (entries.length > MAX_HEADERS) failValidation(`请求头过多（上限 ${MAX_HEADERS} 个）。`)
  const headers: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim()
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || RESERVED_KEYS.has(key)) {
      failValidation(`请求头名称不合法：${rawKey.slice(0, 40)}`)
    }
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue) || rawValue.length > 8_192) {
      failValidation(`请求头「${key}」的值不合法。`)
    }
    headers[key] = rawValue
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function validateBaseUrl(kind: ProviderKind, raw: string): string {
  const baseUrl = raw.trim()
  if (kind === 'demo') return baseUrl
  if (!baseUrl || baseUrl.length > 2_048) failValidation('接口地址不能为空且不能超过 2048 字符。')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    failValidation('接口地址不是合法的 URL。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    failValidation('接口地址只允许 http:// 或 https://。')
  }
  if (parsed.username || parsed.password) failValidation('接口地址不能包含用户名/密码，请改用请求头。')
  return baseUrl
}

function validateDefaultModel(providers: ProviderConfig[], raw: unknown): Settings['defaultModel'] {
  if (!isRecord(raw)) failValidation('默认模型格式不正确。')
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : ''
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!providerId || !modelId) failValidation('默认模型格式不正确。')
  const ref = { providerId, modelId }
  if (!findModel(providers, ref)) failValidation('默认模型不可用，请先保存模型提供方。')
  if (providers.find((provider) => provider.id === providerId)?.kind === 'demo') {
    failValidation('演示模型不能设为默认模型。')
  }
  return ref
}

function fallbackDefaultModel(providers: ProviderConfig[]): Settings['defaultModel'] {
  const realProviders = providers.filter((provider) => provider.kind !== 'demo')
  if (findModel(realProviders, DEFAULT_MODEL)) return DEFAULT_MODEL
  for (const provider of realProviders) {
    const model = provider.models[0]
    if (model) return { providerId: provider.id, modelId: model.id }
  }
  return DEFAULT_MODEL
}

/**
 * 设置与 API Key 存储。
 * - 非敏感设置：userData/settings.json
 * - API Key：safeStorage（Windows DPAPI）加密后写 userData/secrets.json
 *   若系统加密不可用，降级为 base64 并在设置里标记 `keyStorage: 'insecure'`，同时日志告警。
 */
export class SettingsStore {
  private settings: Settings
  private secrets: SecretsFile
  private encryptionAvailable = false

  constructor() {
    ensureDataDirs()
    this.encryptionAvailable = this.checkEncryption()
    this.settings = this.loadSettings()
    this.secrets = this.loadSecrets()
    const migrated = this.migrateLayout(this.settings)
    this.settings = this.mergeBuiltinProviders(migrated.settings)
    const defaultRepaired = this.ensureDefaultModel()
    this.syncKeyFlags()
    if (migrated.changed || defaultRepaired) this.persist()
    log.info('settings loaded', { encryptionAvailable: this.encryptionAvailable })
  }

  private checkEncryption(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch (err) {
      log.warn('safeStorage unavailable', String(err))
      return false
    }
  }

  private loadSettings(): Settings {
    const fallback = defaultSettings()
    const file = dataPath('settings.json')
    if (!existsSync(file)) return fallback
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>
      return {
        ...fallback,
        ...parsed,
        // 显式保留旧配置的 layoutVersion（缺失视为第 1 版），供构造器做一次性布局迁移
        layoutVersion: parsed.layoutVersion ?? 1,
        // provider 列表始终以代码内预设为基准做合并，避免旧版本缺失新 provider
        providers: parsed.providers?.length ? parsed.providers : fallback.providers,
        webSearch: normalizeWebSearch(parsed.webSearch, fallback.webSearch),
        answerStyle: normalizeAnswerStyle(parsed.answerStyle),
        answerStyleCustom: normalizeAnswerStyleCustom(parsed.answerStyleCustom),
        hooks: normalizeHooks(parsed.hooks)
      }
    } catch (err) {
      log.warn('settings parse failed, using defaults', String(err))
      return fallback
    }
  }

  /**
   * R7 布局默认值迁移：旧版本的默认 264/560 一次性迁移到新默认 240/420；
   * 用户手动拖动过的其他宽度保持不变。layoutVersion 防止每次启动重复覆盖。
   */
  private migrateLayout(settings: Settings): { settings: Settings; changed: boolean } {
    if ((settings.layoutVersion ?? 1) >= 2) return { settings, changed: false }
    return {
      settings: {
        ...settings,
        sidebarWidth: settings.sidebarWidth === 264 ? 240 : settings.sidebarWidth,
        canvasWidth: settings.canvasWidth === 560 ? 420 : settings.canvasWidth,
        layoutVersion: 2
      },
      changed: true
    }
  }

  private loadSecrets(): SecretsFile {
    const file = dataPath('secrets.json')
    if (!existsSync(file)) return { version: 1, keys: {} }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Pick<SecretsFile, 'keys'>
      const keys: Record<string, string> = {}
      for (const [id, value] of Object.entries(parsed?.keys ?? {})) {
        if (typeof value === 'string') keys[id] = value
      }
      const legacy = Object.keys(keys).filter((id) => keys[id].startsWith(LEGACY_FALLBACK_PREFIX))
      if (legacy.length > 0) {
        log.warn('legacy insecure key storage detected (b64); keys must be re-saved', { providers: legacy })
      }
      return { version: 1, keys }
    } catch {
      return { version: 1, keys: {} }
    }
  }

  /** safeStorage 适配层（不在这里做任何降级：加密不可用时 encodeSecret 会抛错） */
  private crypto(): SecretCrypto {
    return {
      available: this.encryptionAvailable,
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    }
  }

  /**
   * 内置 provider 随版本升级：模型清单/上下文元数据始终以代码内最新预设为准，
   * 只保留用户可自定义的 baseUrl、enabled、headers 等；否则老用户会一直看到过时的
   * 模型列表与上下文窗口。自定义 provider 原样保留。
   */
  private mergeBuiltinProviders(settings: Settings): Settings {
    const builtins = builtinProviders()
    const providers: ProviderConfig[] = builtins.map((preset) => {
      const existing = settings.providers.find((p) => p.id === preset.id)
      if (!existing) return preset
      return {
        ...preset,
        ...existing,
        name: existing.name || preset.name,
        isBuiltin: true,
        category: preset.category,
        // 模型清单默认以代码内最新预设为准；保留用户手动添加/同步得到的额外模型。
        // 用户同步过（modelsSyncedAt）时，同 ID 模型保留服务商返回的上下文/能力元数据。
        models: (() => {
          const savedModels = existing.models ?? []
          const savedById = new Map(savedModels.map((model) => [model.id, model]))
          const presetIds = new Set(preset.models.map((model) => model.id))
          const merged = preset.models.map((model) => {
            if (!existing.modelsSyncedAt) return model
            const saved = savedById.get(model.id)
            if (!saved) return model
            return normalizeReasoningStyle(
              {
                ...model,
                ...saved,
                ...(saved.pricing ? {} : model.pricing ? { pricing: model.pricing } : {}),
                ...(saved.note ? {} : model.note ? { note: model.note } : {})
              },
              preset.kind
            )
          })
          return [...merged, ...savedModels.filter((model) => !presetIds.has(model.id))]
        })(),
        baseUrl: existing.baseUrl?.trim() || preset.baseUrl,
        // demo provider 的端点不允许改坏
        ...(preset.kind === 'demo' ? { baseUrl: preset.baseUrl, enabled: true } : {})
      }
    })
    for (const provider of settings.providers) {
      if (!provider.isBuiltin) {
        providers.push({
          category: 'custom',
          ...provider,
          models: provider.models.map((model) => normalizeReasoningStyle(model, provider.kind))
        })
      }
    }
    // 老设置里的默认模型可能已被服务商下线：回退到当前默认模型
    const defaultModel = findModel(providers, settings.defaultModel) ? settings.defaultModel : DEFAULT_MODEL
    return { ...settings, providers, defaultModel }
  }

  private syncKeyFlags(): void {
    this.settings.providers = this.settings.providers.map((provider) => ({
      ...provider,
      apiKeyStored: provider.kind === 'demo' ? true : Boolean(this.secrets.keys[provider.id])
    }))
    this.settings.webSearch = {
      ...this.settings.webSearch,
      apiKeyStored: Boolean(this.secrets.keys[webSearchKeyId(this.settings.webSearch.provider)])
    }
  }

  private persist(): void {
    const { providers, ...rest } = this.settings
    const sanitized: Settings = {
      ...rest,
      providers: providers.map((p) => ({ ...p, apiKeyStored: Boolean(this.secrets.keys[p.id]) || p.kind === 'demo' }))
    }
    atomicWrite(dataPath('settings.json'), JSON.stringify(sanitized, null, 2))
    this.settings = sanitized
  }

  private persistSecrets(): void {
    atomicWrite(dataPath('secrets.json'), JSON.stringify(this.secrets, null, 2))
  }

  get(): Settings {
    this.syncKeyFlags()
    const settings = structuredCloneSafe(this.settings)
    // 兼容旧版本同步/保存的模型元数据：supportsReasoning 但没有 style 时不让推理入口消失。
    settings.providers = settings.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => normalizeReasoningStyle(model, provider.kind))
    }))
    return settings
  }

  private normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
    if (!isRecord(config)) failValidation('模型提供方配置格式不正确。')
    const id = typeof config.id === 'string' ? config.id.trim() : ''
    if (!PROVIDER_ID_RE.test(id) || RESERVED_KEYS.has(id)) {
      failValidation('模型提供方 ID 不合法。')
    }
    const existing = this.settings.providers.find((provider) => provider.id === id)
    const isBuiltin = existing?.isBuiltin === true
    const requestedKind = config.kind
    if (!PROVIDER_KINDS.has(requestedKind)) failValidation('模型提供方类型不合法。')
    // 内置提供方的协议类型不可被改成另一套实现；自定义提供方不允许伪装成 demo
    if (isBuiltin && existing && requestedKind !== existing.kind) {
      failValidation('内置模型提供方的协议类型不能修改。')
    }
    const kind: ProviderKind = isBuiltin ? existing!.kind : requestedKind
    if (!isBuiltin && kind === 'demo') failValidation('自定义模型提供方不能使用演示引擎。')

    const name = typeof config.name === 'string' ? config.name.trim() : ''
    if (!name || name.length > 80) failValidation('模型提供方名称不能为空且不能超过 80 字符。')
    if (typeof config.baseUrl !== 'string') failValidation('接口地址格式不正确。')
    const baseUrl = validateBaseUrl(kind, config.baseUrl || (isBuiltin ? existing!.baseUrl : ''))
    const models = normalizeModels(config.models).map((model) => normalizeReasoningStyle(model, kind))
    const headers = normalizeHeaders(config.headers)
    const category: ProviderCategory = isBuiltin
      ? (existing?.category ?? 'custom')
      : 'custom'
    const modelsSyncedAt =
      typeof config.modelsSyncedAt === 'number' && Number.isFinite(config.modelsSyncedAt) && config.modelsSyncedAt > 0
        ? Math.round(config.modelsSyncedAt)
        : existing?.modelsSyncedAt
    return {
      id,
      kind,
      name,
      baseUrl,
      models,
      apiKeyStored: false,
      enabled: config.enabled !== false,
      ...(headers ? { headers } : {}),
      isBuiltin,
      category,
      ...(modelsSyncedAt ? { modelsSyncedAt } : {})
    }
  }

  /** 默认模型必须存在且不是演示模型；返回是否发生了修复。 */
  private ensureDefaultModel(): boolean {
    const provider = this.settings.providers.find((item) => item.id === this.settings.defaultModel.providerId)
    if (findModel(this.settings.providers, this.settings.defaultModel) && provider?.kind !== 'demo') return false
    this.settings.defaultModel = fallbackDefaultModel(this.settings.providers)
    return true
  }

  update(patch: Partial<Settings>): Settings {
    if (!isRecord(patch)) failValidation('设置格式不正确。')
    const allowed = new Set([
      'theme',
      'fontSize',
      'reduceMotion',
      'permissionMode',
      'sendKey',
      'defaultModel',
      'lastWorkspace',
      'recentWorkspaces',
      'onboardingDone',
      'sidebarCollapsed',
      'demoSeen',
      'showTokenMeter',
      'sidebarWidth',
      'autoCompact',
      'compactThreshold',
      'canvasWidth',
      'autoTitle',
      'closeToTray',
      'notifyOnFinish',
      'islandEnabled',
      'islandPosition',
      'reasoningEffort',
      'answerStyle',
      'answerStyleCustom',
      'hooks',
      'terminalShell'
    ])
    for (const key of Object.keys(patch)) {
      if (key === 'providers' || key === 'version') continue
      if (!allowed.has(key)) failValidation(`不支持的设置项：${key}`)
    }
    const next: Settings = { ...this.settings }
    const bool = (key: 'reduceMotion' | 'onboardingDone' | 'sidebarCollapsed' | 'demoSeen' | 'showTokenMeter' | 'autoCompact' | 'autoTitle' | 'closeToTray' | 'notifyOnFinish' | 'islandEnabled'): void => {
      const value = patch[key]
      if (typeof value !== 'boolean') failValidation(`设置项 ${key} 必须是布尔值。`)
      next[key] = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'theme')) {
      if (patch.theme !== 'dark' && patch.theme !== 'light') failValidation('主题设置不合法。')
      next.theme = patch.theme
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'fontSize')) {
      const value = patch.fontSize
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 13 || value > 16) {
        failValidation('字号需在 13–16 之间。')
      }
      next.fontSize = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'permissionMode')) {
      if (patch.permissionMode !== 'read-only' && patch.permissionMode !== 'ask' && patch.permissionMode !== 'auto') {
        failValidation('权限模式不合法。')
      }
      next.permissionMode = patch.permissionMode
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sendKey')) {
      if (patch.sendKey !== 'enter' && patch.sendKey !== 'ctrl+enter') failValidation('发送键设置不合法。')
      next.sendKey = patch.sendKey
    }
    for (const key of ['reduceMotion', 'onboardingDone', 'sidebarCollapsed', 'demoSeen', 'showTokenMeter', 'autoCompact', 'autoTitle', 'closeToTray', 'notifyOnFinish', 'islandEnabled'] as const) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) bool(key)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'islandPosition')) {
      const value = patch.islandPosition
      if (value !== null) {
        if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
          failValidation('灵动岛位置不合法。')
        }
        const x = Number(value.x)
        const y = Number(value.y)
        if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000) failValidation('灵动岛位置超出范围。')
        next.islandPosition = { x: Math.round(x), y: Math.round(y) }
      } else {
        next.islandPosition = null
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sidebarWidth')) {
      const value = patch.sidebarWidth
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 200 || value > 400) {
        failValidation('侧栏宽度需在 200–400 之间。')
      }
      next.sidebarWidth = Math.round(value)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'canvasWidth')) {
      const value = patch.canvasWidth
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 320 || value > 960) {
        failValidation('画布宽度需在 320–960 之间。')
      }
      next.canvasWidth = Math.round(value)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'compactThreshold')) {
      const value = patch.compactThreshold
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 0.95) {
        failValidation('压缩阈值需在 50%–95% 之间。')
      }
      next.compactThreshold = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'terminalShell')) {
      const value = patch.terminalShell
      if (typeof value !== 'string' || value.length > 40 || !/^[a-z0-9_-]*$/.test(value)) {
        failValidation('终端类型设置不合法。')
      }
      next.terminalShell = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'answerStyle')) {
      if (!isAnswerStyleId(patch.answerStyle)) failValidation('回答风格设置不合法。')
      next.answerStyle = patch.answerStyle
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'answerStyleCustom')) {
      const value = patch.answerStyleCustom
      if (typeof value !== 'string') failValidation('自定义回答风格必须是文本。')
      if (value.length > ANSWER_STYLE_MAX_CUSTOM) {
        failValidation(`自定义回答风格最多 ${ANSWER_STYLE_MAX_CUSTOM} 个字符。`)
      }
      next.answerStyleCustom = normalizeAnswerStyleCustom(value)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')) {
      const value = patch.reasoningEffort
      if (!isReasoningEffort(value)) failValidation('推理强度不合法。')
      next.reasoningEffort = value
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'hooks')) {
      const value = patch.hooks
      if (!Array.isArray(value) || value.length > MAX_HOOKS) failValidation('钩子数量不合法（最多 20 个）。')
      const ids = new Set<string>()
      const enabledPerEvent = new Map<HookEvent, number>()
      const hooks: HookConfig[] = []
      for (const item of value) {
        if (!isRecord(item)) failValidation('钩子配置格式不正确。')
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) failValidation('钩子 id 不合法或重复。')
        if (!isHookEvent(item.event)) failValidation('钩子事件不合法。')
        const event = item.event
        const command = typeof item.command === 'string' ? item.command.trim() : ''
        if (!command || command.length > 2000 || command.includes('\0')) failValidation('钩子命令为空或过长（上限 2000 字）。')
        const enabled = item.enabled === true
        if (enabled) {
          const count = (enabledPerEvent.get(event) ?? 0) + 1
          if (count > MAX_ENABLED_HOOKS_PER_EVENT) {
            failValidation(`每个事件最多启用 ${MAX_ENABLED_HOOKS_PER_EVENT} 个钩子。`)
          }
          enabledPerEvent.set(event, count)
        }
        ids.add(id)
        hooks.push({ id, event, command, enabled })
      }
      next.hooks = hooks
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastWorkspace')) {
      const value = patch.lastWorkspace
      if (value !== null && typeof value !== 'string') failValidation('工作区路径格式不正确。')
      if (typeof value === 'string' && value.trim().length > 4096) failValidation('工作区路径过长。')
      next.lastWorkspace = typeof value === 'string' ? value.trim() || null : null
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'recentWorkspaces')) {
      const value = patch.recentWorkspaces
      if (!Array.isArray(value) || value.length > 10 || value.some((item) => typeof item !== 'string' || item.length > 4096)) {
        failValidation('最近工作区列表格式不正确。')
      }
      next.recentWorkspaces = [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, 6)
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultModel')) {
      next.defaultModel = validateDefaultModel(next.providers, patch.defaultModel)
    }
    next.version = 1
    next.providers = this.settings.providers
    this.settings = next
    this.ensureDefaultModel()
    this.persist()
    return this.get()
  }

  saveProvider(config: ProviderConfig, apiKey?: string): Settings {
    // 先校验配置，再碰密钥：非法配置不会写入任何东西
    const normalized = this.normalizeProviderConfig(config)
    const providerId = normalized.id
    // R7 审计修复：先完成 API Key 加密，加密失败/不可用直接抛错，不产生任何降级写入。
    if (apiKey !== undefined) {
      const trimmed = apiKey.trim()
      if (trimmed === '') {
        delete this.secrets.keys[providerId]
        this.persistSecrets()
      } else {
        this.secrets.keys[providerId] = encodeSecret(trimmed, this.crypto())
        this.persistSecrets()
      }
    }
    const clean: ProviderConfig = {
      ...normalized,
      apiKeyStored: Boolean(this.secrets.keys[providerId]) || normalized.kind === 'demo'
    }
    const index = this.settings.providers.findIndex((p) => p.id === providerId)
    if (index >= 0) this.settings.providers[index] = clean
    else this.settings.providers.push(clean)

    this.ensureDefaultModel()
    this.syncKeyFlags()
    this.persist()
    return this.get()
  }

  removeProvider(providerId: string): Settings {
    const provider = this.settings.providers.find((p) => p.id === providerId)
    if (!provider || provider.isBuiltin) {
      throw new Error('内置模型提供方不能删除，可以停用或清空 Key。')
    }
    this.settings.providers = this.settings.providers.filter((p) => p.id !== providerId)
    delete this.secrets.keys[providerId]
    this.persistSecrets()
    this.syncKeyFlags()
    this.ensureDefaultModel()
    this.persist()
    return this.get()
  }

  /** 保存联网搜索配置；apiKey 只在渲染层提交时传入，主进程加密存储。 */
  saveWebSearch(input: {
    enabled: boolean
    provider: WebSearchProvider
    baseUrl?: string
    maxResults: number
    apiKey?: string
  }): Settings {
    if (!WEB_SEARCH_PROVIDERS.has(input.provider)) failValidation('搜索服务商不合法。')
    if (typeof input.enabled !== 'boolean') failValidation('搜索开关值不合法。')
    if (input.apiKey !== undefined && input.apiKey.length > 4096) failValidation('API Key 过长。')
    const maxResults = Number(input.maxResults)
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
      failValidation('搜索结果数需在 1–10 之间。')
    }
    let baseUrl: string | undefined
    if (input.provider === 'searxng') {
      const raw = (input.baseUrl ?? '').trim()
      if (!raw) failValidation('SearXNG 需要填写实例地址。')
      if (raw.length > 2048) failValidation('SearXNG 地址过长。')
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        failValidation('SearXNG 地址不是合法 URL。')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        failValidation('SearXNG 地址只允许 http:// 或 https://。')
      }
      if (parsed.username || parsed.password) failValidation('SearXNG 地址不能包含账号密码。')
      // 查询串/片段会让拼接的 /search 落到错误路径；令牌应放在 API Key 字段
      if (parsed.search || parsed.hash) failValidation('SearXNG 地址不能包含查询参数或片段。')
      baseUrl = raw.replace(/\/+$/, '')
    }
    const keyId = webSearchKeyId(input.provider)
    if (input.apiKey !== undefined) {
      const trimmed = input.apiKey.trim()
      if (trimmed === '') {
        delete this.secrets.keys[keyId]
        this.persistSecrets()
      } else {
        this.secrets.keys[keyId] = encodeSecret(trimmed, this.crypto())
        this.persistSecrets()
      }
    }
    const keyStored = Boolean(this.secrets.keys[keyId])
    if (input.provider !== 'searxng' && input.enabled && !keyStored) {
      failValidation('启用联网搜索前，请先填写搜索服务的 API Key。')
    }
    this.settings.webSearch = {
      enabled: input.enabled,
      provider: input.provider,
      ...(baseUrl ? { baseUrl } : {}),
      apiKeyStored: keyStored,
      maxResults
    }
    this.persist()
    return this.get()
  }

  getWebSearchKey(): string | null {
    return this.getApiKey(webSearchKeyId(this.settings.webSearch.provider))
  }

  getApiKey(providerId: string): string | null {
    const raw = this.secrets.keys[providerId]
    if (!raw) return null
    const decoded = decodeSecret(raw, this.crypto())
    if (!decoded) {
      log.error('decrypt provider key failed', { providerId })
      return null
    }
    if (decoded.legacyInsecure) {
      log.warn('provider key uses legacy insecure storage; please re-save it', { providerId })
    }
    return decoded.value
  }

  hasAnyApiKey(): boolean {
    return this.settings.providers.some((p) => p.kind !== 'demo' && Boolean(this.secrets.keys[p.id]))
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 应用启动后唯一实例 */
let instance: SettingsStore | null = null
export function getSettingsStore(): SettingsStore {
  if (!instance) instance = new SettingsStore()
  return instance
}
