/**
 * 订阅渠道共用的本机凭据、Provider 注册与测活工具。
 *
 * 这里只放与具体协议无关的部分：加密落盘、回环 Provider 的注册/移除/启停、
 * 通过本地回环 Provider 做一次真实连接测试。登录、刷新与额度解析仍由各渠道自己实现。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { ModelInfo, ProviderConfig } from '../../shared/types'
import type { SubscriptionTestResult } from '../../shared/subscriptions'
import { dataPath } from './paths'
import { getSettingsStore } from './settings-store'
import { testProviderConnection } from '../../core/providers'
import { asRecord, asString } from './agent-protocol-utils'
import { openExternalUrl } from './external-open'

export {
  asRecord,
  asString,
  asNumber,
  sleep,
  jwtClaims,
  timestampMs,
  clampPercent,
  percentWindow
} from './agent-protocol-utils'

/** 读取本机 JSON 文件；不存在或格式不对时返回 null，不抛错。 */
export function readLocalJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    return asRecord(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function homePath(...segments: string[]): string {
  return join(homedir(), ...segments)
}

/** 用系统浏览器打开授权页。 */
export function openExternal(url: string): void {
  void openExternalUrl(url).catch(() => undefined)
}

export function getProvider(id: string): ProviderConfig | undefined {
  return getSettingsStore().get().providers.find((item) => item.id === id)
}

/** 注册或更新回环 Provider，保留用户此前设置的启停状态。 */
export function saveLoopbackProvider(input: {
  id: string
  name: string
  kind: 'openai-compat' | 'anthropic'
  port: number
  models: ModelInfo[]
  localToken: string
}): ProviderConfig {
  const existing = getProvider(input.id)
  const config: ProviderConfig = {
    id: input.id,
    kind: input.kind,
    name: input.name,
    baseUrl: `http://127.0.0.1:${input.port}/v1`,
    models: input.models,
    category: 'custom',
    apiKeyStored: true,
    enabled: existing?.enabled ?? true
  }
  getSettingsStore().saveProvider(config, input.localToken)
  return config
}

export function removeProvider(id: string): void {
  try {
    getSettingsStore().removeProvider(id)
  } catch {
    // Provider 已经被手动删除
  }
}

export function setProviderEnabled(id: string, enabled: boolean): void {
  const provider = getProvider(id)
  if (!provider) throw new Error('订阅 Provider 尚未创建。')
  getSettingsStore().saveProvider(
    { ...provider, enabled },
    getSettingsStore().getApiKey(id) ?? undefined
  )
}

export async function testSubscriptionProvider(id: string, modelId?: string): Promise<SubscriptionTestResult> {
  const started = Date.now()
  try {
    const provider = getProvider(id)
    if (!provider) throw new Error('订阅 Provider 不存在，请先完成登录。')
    const result = await testProviderConnection(provider, getSettingsStore().getApiKey(id), modelId)
    return { ...result, latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) }
  }
}

/** safeStorage 加密的本机 JSON 凭据文件。 */
export class SecureJsonStore<T> {
  constructor(private readonly fileName: string) {}

  filePath(): string {
    return dataPath(this.fileName)
  }

  load(): T | null {
    try {
      if (!existsSync(this.filePath())) return null
      const parsed = asRecord(JSON.parse(readFileSync(this.filePath(), 'utf8')))
      const encrypted = asString(parsed?.encrypted)
      if (!encrypted) return null
      if (!safeStorage.isEncryptionAvailable()) return null
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as T
    } catch {
      return null
    }
  }

  save(value: T): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统凭据加密不可用，无法保存登录态。')
    }
    mkdirSync(dataPath(), { recursive: true })
    const payload = {
      version: 1,
      encrypted: safeStorage.encryptString(JSON.stringify(value)).toString('base64'),
      updatedAt: Date.now()
    }
    writeFileSync(this.filePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  clear(): void {
    try {
      if (existsSync(this.filePath())) writeFileSync(this.filePath(), '', 'utf8')
    } catch {
      // 文件不可写时保留现状，下一次保存会覆盖
    }
  }
}

export function randomLocalToken(seed?: string | null): string {
  return seed && seed.length >= 16 ? seed : randomBytes(32).toString('base64url')
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

