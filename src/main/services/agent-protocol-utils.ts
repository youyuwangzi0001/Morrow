/** 订阅协议层的纯函数；不依赖 Electron，可在单元测试里直接加载。 */
import type { AgentQuotaWindow } from '../../shared/subscriptions'

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 解码 JWT 载荷；只用于读取 uid/email/exp，不做签名校验。 */
export function jwtClaims(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 把 Unix 秒 / 毫秒 / ISO 字符串统一成毫秒。 */
export function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return timestampMs(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function clampPercent(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(100, value))
}

export function percentWindow(
  id: string,
  label: string,
  usedPercent: number | undefined,
  resetAt?: number
): AgentQuotaWindow {
  const percent = clampPercent(usedPercent)
  return {
    id,
    label,
    ...(percent !== undefined ? { usedPercent: percent } : {}),
    ...(resetAt !== undefined ? { resetAt } : {})
  }
}
