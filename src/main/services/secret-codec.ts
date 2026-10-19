/**
 * API Key 加密存储编解码（R7 审计修复）。
 *
 * 旧实现：safeStorage 不可用或加密抛错时，静默降级成 `b64:` 明文（base64 可秒还原）。
 * 新规则：**加密不可用时不保存**，直接抛错让设置页明确提示；只有历史遗留的 `b64:`
 * 数据仍可读取（只读兼容），并在加载/读取时记录告警。
 *
 * 本模块不 import electron，便于在 Node 单测/审计脚本中直接验证降级行为。
 */

export const ENCRYPT_PREFIX = 'enc:'
/** 历史降级格式（仅用于读取兼容，绝不新写） */
export const LEGACY_FALLBACK_PREFIX = 'b64:'

export interface SecretCrypto {
  /** 系统加密（Windows DPAPI / macOS Keychain 等）是否可用 */
  available: boolean
  /** 加密并返回 base64；失败时抛错 */
  encrypt(value: string): string
  /** 解密 base64；失败时抛错 */
  decrypt(encoded: string): string
}

export class SecretStorageUnavailableError extends Error {
  readonly code = 'SECRET_STORAGE_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'SecretStorageUnavailableError'
  }
}

/**
 * 加密保存 API Key。
 * 加密不可用 / 加密失败 → 抛 SecretStorageUnavailableError，不产生任何可逆的降级存储。
 */
export function encodeSecret(value: string, crypto: SecretCrypto): string {
  if (!value) throw new SecretStorageUnavailableError('不能保存空的 API Key。')
  if (!crypto.available) {
    throw new SecretStorageUnavailableError(
      '系统加密服务不可用，Morrow 不会用可还原的方式保存 API Key。请修复系统凭据服务（Windows 凭据管理器 / safeStorage）后重试。'
    )
  }
  try {
    return ENCRYPT_PREFIX + crypto.encrypt(value)
  } catch (err) {
    throw new SecretStorageUnavailableError(
      `API Key 加密失败，已拒绝保存（不会降级为明文/base64）：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export interface DecodedSecret {
  value: string
  /** true = 历史遗留的非加密存储（b64:），需要提示用户重新保存 */
  legacyInsecure: boolean
}

/** 读取 API Key。支持当前加密格式 + 只读兼容历史 b64 格式；损坏返回 null。 */
export function decodeSecret(raw: string | null | undefined, crypto: SecretCrypto): DecodedSecret | null {
  if (!raw) return null
  try {
    if (raw.startsWith(ENCRYPT_PREFIX)) {
      if (!crypto.available) return null
      return { value: crypto.decrypt(raw.slice(ENCRYPT_PREFIX.length)), legacyInsecure: false }
    }
    if (raw.startsWith(LEGACY_FALLBACK_PREFIX)) {
      return {
        value: Buffer.from(raw.slice(LEGACY_FALLBACK_PREFIX.length), 'base64').toString('utf8'),
        legacyInsecure: true
      }
    }
    return null
  } catch {
    return null
  }
}

/** 存储模式：safe=全部经过系统加密；legacy-insecure=存在历史降级项；unavailable=系统加密不可用 */
export function secretStorageMode(crypto: SecretCrypto, hasLegacyKeys: boolean): 'safe' | 'legacy-insecure' | 'unavailable' {
  if (!crypto.available) return 'unavailable'
  return hasLegacyKeys ? 'legacy-insecure' : 'safe'
}
