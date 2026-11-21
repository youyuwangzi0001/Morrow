import type { PairDeviceView, PairIssueResult } from './types'

/**
 * 「手机配对」面板的视图状态。
 * - 90 秒后必须变成「已过期」，而不是继续显示旧码；
 * - 点「重新生成」之后，倒计时必须从新的 `expiresAt` 重新算。
 */

/** 票据剩余 15 秒起提示（含） */
export const PAIR_WARN_SECONDS = 15

/**
 * 票据总时长（毫秒）。
 *
 * 与桌面 `PairingService` 的 `TICKET_TTL_MS` 是同一个协议常量。
 * 这里独立声明而不是 import：渲染进程不该把主进程的模块拉进 bundle。
 * `pair-panel.test.ts` 有一条断言把它与 90 对齐，改漏一边会红。
 */
export const PAIR_TTL_MS = 90_000

export type PairPanelPhase =
  /** 还没生成过票据 */
  | 'idle'
  /** 有票据且未过期 */
  | 'live'
  /** 有票据但已过期 —— 必须换掉文本，不能继续显示旧码 */
  | 'expired'

export interface PairPanelView {
  phase: PairPanelPhase
  /** 剩余秒数（已钳到 0） */
  remainingSeconds: number
  /** 剩余比例 0–1，用于进度条 */
  remainingRatio: number
  /** 是否进入「快没时间了」的提示态 */
  urgent: boolean
  /**
   * 是否该显示「指纹缺失」警告。
   *
   * 为 true 时手机侧会**拒绝完成配对**（没有指纹无法做证书固定）。
   * 界面必须当场说清，而不是让用户扫完才发现连不上。
   */
  fingerprintMissing: boolean
  /** 给用户的下一步提示。空串表示不需要提示。 */
  hint: string
}

/**
 * 由「票据 + 当前时间」推出面板状态。
 *
 * `ticket` 为 null 时返回 idle —— 此时**不能**显示「已过期」：
 * 从没生成过和生成过又过期了，用户的下一步不同（前者是「生成」，
 * 后者是「重新生成」）。
 */
export function pairPanelView(ticket: PairIssueResult | null, now: number): PairPanelView {
  if (!ticket) {
    return {
      phase: 'idle',
      remainingSeconds: 0,
      remainingRatio: 0,
      urgent: false,
      fingerprintMissing: false,
      hint: ''
    }
  }

  const remainingMs = Math.max(0, ticket.expiresAt - now)
  const remainingSeconds = Math.ceil(remainingMs / 1000)
  // 比率按固定 90 秒口径算（与 `PairingService.TICKET_TTL_MS` 一致）：
  // 结果里没有「生成时刻」，用 exp 反推总时长不可靠 ——
  // 而 TTL 是协议常量，界面按常量画进度条不会漂。
  const remainingRatio = Math.min(1, Math.max(0, remainingMs / PAIR_TTL_MS))
  const expired = remainingMs <= 0

  return {
    phase: expired ? 'expired' : 'live',
    remainingSeconds: expired ? 0 : remainingSeconds,
    remainingRatio: expired ? 0 : remainingRatio,
    urgent: !expired && remainingSeconds <= PAIR_WARN_SECONDS,
    fingerprintMissing: !ticket.hasFingerprint,
    hint: expired
      ? '这张配对码已经失效。在下面重新生成一张，手机上用新的那张。'
      : ticket.hasFingerprint
        ? ''
        : '局域网直连没有起来，配对码里缺证书指纹。手机侧会拒绝完成配对 —— 先检查网络与端口占用，再重新生成。'
  }
}

/**
 * 设备列表的展示状态。
 *
 * `loading` 与「空列表」必须分开：在读取过程中显示「还没有配对的手机」
 * 会让用户以为设备被清掉了（C1 那条教训：0 和「不知道」含义不同）。
 */
export type DeviceListPhase = 'loading' | 'error' | 'empty' | 'ready'

export function deviceListPhase(input: {
  loading: boolean
  error: string | null
  devices: PairDeviceView[]
}): DeviceListPhase {
  if (input.loading) return 'loading'
  if (input.error) return 'error'
  if (input.devices.length === 0) return 'empty'
  return 'ready'
}

/** 设备名兜底：没起名字时显示一串可辨识的前缀，而不是空白 */
export function deviceLabel(device: PairDeviceView): string {
  if (device.name && device.name.trim().length > 0) return device.name.trim()
  return device.deviceId
}

/** 配对时间格式化。失败时返回占位符，不抛。 */
export function formatPairedAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 撤销前的确认文案。
 *
 * 不写成「确定撤销吗」：用户需要知道**撤销之后会发生什么**。
 * 撤销是立即生效的（同一请求内 `requirePaired` 就抛 DEVICE_REVOKED），
 * 说清楚这一点，用户才不会以为「点了还得等一会儿」。
 */
export function revokeConfirmText(device: PairDeviceView): string {
  const label = deviceLabel(device)
  return `撤销「${label}」？\n这台手机下一次请求会立刻被拒绝，需要重新配对才能再用。`
}

/**
 * 手机侧「配对请求」文本的前缀。
 *
 * 桌面与手机用同一个前缀做格式识别：用户粘错东西（比如把配对码粘进请求框）
 * 时能当场说「这看起来是配对码，方向反了」，而不是报一个笼统的解析失败。
 */
export const PAIR_REQUEST_PREFIX = 'MORROWPAIR1.'

/**
 * 从粘贴内容里提取手机公钥。
 *
 * 支持的输入：
 * - `MORROWPAIR1.<base64url(JSON{deviceId?, pubKey})>`（手机复制出来的原文）
 * - 直接一段 base64 公钥（65 字节未压缩点）
 *
 * 返回 `{ ok: false, reason }` 时 reason 要能指导用户，不能只说「格式错误」。
 */
export function parsePairRequest(
  raw: string
): { ok: true; pubKey: string; deviceId: string | null } | { ok: false; reason: string } {
  const text = raw.trim()
  if (text.length === 0) return { ok: false, reason: '先粘贴手机上的配对请求。' }

  if (!text.startsWith(PAIR_REQUEST_PREFIX)) {
    // 最常见的两种粘错：粘了配对码、粘了半截
    if (text.startsWith('eyJ')) {
      return { ok: false, reason: '这是一张配对码，不是配对请求。配对码要粘到手机上，方向反了。' }
    }
    // 裸公钥：65 字节 → base64 后 88 字符（含填充）
    const decoded = tryDecodeBase64(text)
    if (decoded && decoded.length === 65 && decoded[0] === 0x04) {
      return { ok: true, pubKey: text, deviceId: null }
    }
    return { ok: false, reason: `配对请求应以 ${PAIR_REQUEST_PREFIX} 开头（或直接粘贴手机公钥）。` }
  }

  const payload = text.slice(PAIR_REQUEST_PREFIX.length)
  const json = tryDecodeUtf8(payload)
  if (!json) return { ok: false, reason: '配对请求的内容解不开（可能复制不完整）。' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: '配对请求的内容不是合法格式（可能复制时漏了一段）。' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '配对请求的内容不是合法格式。' }
  }
  const obj = parsed as Record<string, unknown>
  const pubKey = obj.pubKey
  if (typeof pubKey !== 'string' || pubKey.length === 0) {
    return { ok: false, reason: '配对请求里没有公钥。让手机重新复制一次。' }
  }
  const bytes = tryDecodeBase64(pubKey)
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) {
    return { ok: false, reason: '公钥格式不对（应为 65 字节未压缩点）。让手机重新生成后复制。' }
  }
  // 长度与前缀都对，但**点位可能根本不在曲线上**。
  // 这一步不做的话，请求会一路走到桌面 Node 的 `computeSecret`，
  // 抛出英文 `Public key is not valid for specified curve` —— 界面上就是一句
  // 用户看不懂的话，而且他已经点过「生成配对码」了。
  // （真渲染截图时抓到的：人工造的公钥长度对、前缀对，但不是 P-256 上的点。）
  if (!isP256Point(bytes)) {
    return { ok: false, reason: '这个公钥不在 P-256 曲线上（可能复制时缺了一段）。让手机重新复制一次。' }
  }
  const deviceId = typeof obj.deviceId === 'string' && obj.deviceId.length > 0 ? obj.deviceId : null
  return { ok: true, pubKey, deviceId }
}

/**
 * P-256 曲线点校验：`y² ≡ x³ − 3x + b (mod p)`。
 * 数量级不可行。而曲线方程只有四个常量，用 `BigInt` 算是**精确**的
 */
export function isP256Point(raw: Uint8Array): boolean {
  if (raw.length !== 65 || raw[0] !== 0x04) return false
  const x = bytesToBigInt(raw.subarray(1, 33))
  const y = bytesToBigInt(raw.subarray(33, 65))
  const p = P256_P
  if (x >= p || y >= p) return false
  const left = (y * y) % p
  // x³ − 3x + b，用 mod 处理负数
  const right = mod(x * x * x - 3n * x + P256_B, p)
  return left === right
}

/** P-256 素域模数 */
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
/** P-256 曲线方程常数 b */
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n
  for (const b of bytes) out = (out << 8n) | BigInt(b)
  return out
}

function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}

/**
 * base64 / base64url 解码。
 */
function tryDecodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) return null
  const std = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4)
  try {
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function tryDecodeUtf8(base64url: string): string | null {
  const bytes = tryDecodeBase64(base64url)
  if (!bytes) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

