import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_MODEL, builtinProviders, defaultSettings, findModel } from '../../shared/models'
import type { ProviderConfig, ProviderTestResult, Settings } from '../../shared/types'
import { dataPath, ensureDataDirs } from './paths'
import { log } from './logger'
import {
  LEGACY_FALLBACK_PREFIX,
  decodeSecret,
  encodeSecret,
  secretStorageMode,
  type SecretCrypto
} from './secret-codec'

interface SecretsFile {
  version: 1
  /** providerId -> base64(encrypted)（历史版本可能是 `b64:` 前缀的降级明文，只读兼容） */
  keys: Record<string, string>
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
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
    this.syncKeyFlags()
    if (migrated.changed) this.persist()
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
        providers: parsed.providers?.length ? parsed.providers : fallback.providers
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
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as SecretsFile
      const keys = parsed.keys ?? {}
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

  /** 历史遗留的非加密 key 数量（用于设置页/日志告警） */
  private legacyKeyCount(): number {
    return Object.values(this.secrets.keys).filter((raw) => raw.startsWith(LEGACY_FALLBACK_PREFIX)).length
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
        // 模型清单以代码为准（含上下文/输出上限的最新调研数据）。
        // 例外：本地 provider（Ollama / LM Studio）允许用户添加本机实际模型 ID，合并而不是覆盖。
        models:
          preset.category === 'local'
            ? [...preset.models, ...(existing.models ?? []).filter((m) => !preset.models.some((p) => p.id === m.id))]
            : preset.models,
        baseUrl: existing.baseUrl?.trim() || preset.baseUrl,
        // demo provider 的端点不允许改坏
        ...(preset.kind === 'demo' ? { baseUrl: preset.baseUrl, enabled: true } : {})
      }
    })
    for (const provider of settings.providers) {
      if (!provider.isBuiltin) providers.push({ category: 'custom', ...provider })
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
    return structuredCloneSafe(this.settings)
  }

  update(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.settings, ...patch, version: 1 }
    // providers 不允许通过普通 update 覆盖（走 saveProvider/removeProvider）
    next.providers = this.settings.providers
    this.settings = next
    this.persist()
    return this.get()
  }

  saveProvider(config: ProviderConfig, apiKey?: string): Settings {
    // R7 审计修复：先完成 API Key 加密，加密失败/不可用直接抛错，不产生任何降级写入。
    if (apiKey !== undefined) {
      const trimmed = apiKey.trim()
      if (trimmed === '') {
        delete this.secrets.keys[config.id]
        this.persistSecrets()
      } else {
        this.secrets.keys[config.id] = encodeSecret(trimmed, this.crypto())
        this.persistSecrets()
      }
    }
    const clean: ProviderConfig = {
      ...config,
      apiKeyStored: Boolean(apiKey) || Boolean(this.secrets.keys[config.id]) || config.kind === 'demo'
    }
    const index = this.settings.providers.findIndex((p) => p.id === config.id)
    if (index >= 0) this.settings.providers[index] = { ...this.settings.providers[index], ...clean }
    else this.settings.providers.push(clean)

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
    this.persist()
    return this.get()
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

  /**
   * 密钥存储模式：
   * - safe：系统加密可用且没有历史降级 key；
   * - legacy-insecure：存在历史 b64 降级 key（需用户重新保存）；
   * - unavailable：系统加密不可用（新 key 会被拒绝保存，不会静默降级）。
   */
  get keyStorageMode(): 'safe' | 'legacy-insecure' | 'unavailable' {
    return secretStorageMode(this.crypto(), this.legacyKeyCount() > 0)
  }

  /** 当前是否允许安全保存新 Key（设置页可据此提前提示） */
  get canStoreSecretsSecurely(): boolean {
    return this.encryptionAvailable
  }
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** provider 连通性测试（不依赖 Agent 内核，独立走一次最小请求） */
export async function probeProvider(
  config: ProviderConfig,
  apiKey: string | null,
  modelId?: string
): Promise<ProviderTestResult> {
  const started = Date.now()
  if (config.kind === 'demo') {
    return { ok: true, latencyMs: 0, modelCount: config.models.length, message: '离线演示引擎可用。' }
  }
  if (!apiKey) {
    return { ok: false, latencyMs: 0, message: '还没有填写 API Key。' }
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  try {
    if (config.kind === 'anthropic') {
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...(config.headers ?? {})
        },
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) {
        return { ok: false, latencyMs: Date.now() - started, message: explainHttpStatus(res.status, res.statusText) }
      }
      const data = (await res.json()) as { data?: unknown[] }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        modelCount: Array.isArray(data.data) ? data.data.length : undefined,
        message: `连接成功，延迟 ${Date.now() - started}ms。`
      }
    }
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(config.headers ?? {})
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      return { ok: false, latencyMs: Date.now() - started, message: explainHttpStatus(res.status, res.statusText) }
    }
    const data = (await res.json()) as { data?: unknown[] }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      modelCount: Array.isArray(data.data) ? data.data.length : undefined,
      message: `连接成功，延迟 ${Date.now() - started}ms。`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: /timeout|abort/i.test(message)
        ? '连接超时。请检查网络或服务地址。'
        : `连接失败：${message.slice(0, 200)}`
    }
  }
}

function explainHttpStatus(status: number, text: string): string {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请重新复制粘贴。'
  if (status === 404) return '接口地址可能不对（404）。检查 Base URL 是否需要带 /v1。'
  if (status === 429) return '请求太频繁被限流了，稍后再试。'
  if (status >= 500) return `服务端暂时不可用（${status}），稍后再试。`
  return `连接失败（HTTP ${status}${text ? ' ' + text : ''}）。`
}

/** 应用启动后唯一实例 */
let instance: SettingsStore | null = null
export function getSettingsStore(): SettingsStore {
  if (!instance) instance = new SettingsStore()
  return instance
}

export function settingsFilePath(): string {
  return dataPath('settings.json')
}

export function appDataDir(): string {
  return app.getPath('userData')
}
