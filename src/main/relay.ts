/**
 * 远程通道域：信封与帧加密、配对票据与设备、中继白名单，以及设置开关到真实服务的接线。
 *
 * 这个域有四块，每块都有「看起来做完了、其实是假实现」的陷阱：
 *
 * 1. **信封与加密**：信封是两端唯一契约，所以要**严格**校验
 *    （`v` 必须等于当前版本、`kind` 必须在四类内、`seq` 必须正整数、
 *    `at` 必须有限数）——宽松解析会让字段语义在新旧版本间悄悄错位。
 * 2. **配对**：票据不能可重放（只用 `exp` 不够，还要一次性消费 `nonce`），
 *    六位码必须桌面生成、人工比对，不能让手机算完再发过去。
 * 3. **设备表**：`sessionKey` 必须加密落盘，撤销必须**立即**持久化。
 * 4. **生命周期**：把设置里的开关接到真实服务上。开关关闭时端口必须不存在，
 *    开启后白名单通道必须真的能通，运行中改开关要立即生效——这三件事缺一件都算假实现。
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { PairDeviceView, PairIssueResult, Result } from '../shared/types'
import { log } from './logger'
import { getSettingsStore } from './settings'
import { ChannelSelector, type ChannelView, type TierChannel, DirectChannel, ChannelPoller } from './relay-channel'
import {
  buildPhoneSnapshot,
  dispatchPhoneInvoke,
  publishPhoneEvent,
  setPhonePublisher,
  STUDIO_JOB_EVENT,
  type StudioJobPhoneEvent
} from './relay-phone'

// ① 信封与加密

// ───── src/relay/net/envelope.ts ─────
/**
 * 传输信封（Envelope）。
 *
 * 信封是两端唯一的公共契约，所以校验必须**三条都严格**，一条松都不行：
 *
 * **一、必需字段缺一个就失败。** `kind` / `seq` / `runId` / `sessionId` / `at` / `body`
 * 六项少任何一个都判非法 —— 缺字段在运行时表现为 `undefined` 悄悄流进业务代码，
 * 比直接拒绝难查得多。多余字段则忽略，便于将来加字段时旧端仍能解析。
 *
 * **二、`kind` 必须在四类之内。** 未知 kind 不是「将来可能支持」，
 * 而是「这条不该被分发」；放行会让它掉进 else 分支被静默忽略，
 * 或者更糟——被当成某类事件处理。
 *
 * **三、`v` 必须严格校验。** 协议版本不对时应该明确失败，
 * 而不是尽力解析：新旧版本混跑时，宽松解析会让字段语义悄悄错位
 * （同名不同义），排错成本远高于直接报错。
 *
 * 另有一条容易漏的：`seq` 必须是正整数、`at` 必须是有限数。
 * 0/负数的 seq 说明分配逻辑坏了；NaN 的 `at` 会让所有时间比较失效。
 */

/** 协议版本。加到信封字段里，便于后续平滑升级。 */
export const ENVELOPE_VERSION = 1

export type EnvelopeKind = 'event' | 'invoke' | 'result' | 'ack'

/** 协议允许的全部 kind，用于运行时校验（不从类型推导，避免 as 断言绕过） */
const KINDS: readonly EnvelopeKind[] = ['event', 'invoke', 'result', 'ack']

export interface Envelope<T = unknown> {
  /** 协议版本，当前固定 1 */
  v: typeof ENVELOPE_VERSION
  kind: EnvelopeKind
  /** 单调递增序号，由服务端分配，从 1 开始 */
  seq: number
  /** 运行 id；非运行期事件可为空串 */
  runId: string
  /** 会话 id；系统级事件可为空串 */
  sessionId: string
  /** 服务端时间戳（毫秒） */
  at: number
  /** 载荷 */
  body: T
}

export const ENVELOPE_INVALID = 'ENVELOPE_INVALID'
// SEQ_OUT_OF_ORDER 曾在这里定义，但全仓零使用（不像同组的 ENVELOPE_INVALID
// 有 2 处真实抛出点、FRAME_TAMPERED 有 4 处）。一个从不出现的错误码
// 只会让人以为「这种情况被处理了」。等真的需要区分「序号乱序」时再加回来。


export class EnvelopeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'EnvelopeError'
  }
}

/**
 * 校验一个值是否是合法信封。
 *
 * 这里刻意做**严格**校验（而不是宽松兼容）：
 * - 多余字段忽略，但必需字段缺一个就失败；
 * - `seq` 必须是正整数（0 与负数说明分配逻辑坏了）；
 * - `at` 必须是有限数（NaN/Infinity 会让所有时间比较失效）。
 */
export function isValidEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  if (e.v !== ENVELOPE_VERSION) return false
  if (typeof e.kind !== 'string' || !KINDS.includes(e.kind as EnvelopeKind)) return false
  if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 1) return false
  if (typeof e.runId !== 'string') return false
  if (typeof e.sessionId !== 'string') return false
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return false
  if (!('body' in e)) return false
  return true
}

/** 校验并返回信封；失败抛 EnvelopeError */
export function requireEnvelope(value: unknown): Envelope {
  if (!isValidEnvelope(value)) {
    throw new EnvelopeError(ENVELOPE_INVALID, '信封结构不合法')
  }
  return value
}

/**
 * 序号分配器。
 */
export class SeqAllocator {
  private next = 1

  /** 取下一个序号 */
  take(): number {
    return this.next++
  }

  /** 当前将要分配的序号（只读，测试与调试用） */
  peek(): number {
    return this.next
  }

  /** 重置到 1（仅测试用） */
  reset(): void {
    this.next = 1
  }
}

/** 构造一个信封（服务端发事件时用） */
export function makeEnvelope<T>(alloc: SeqAllocator, kind: EnvelopeKind, init: { runId?: string; sessionId?: string; at: number }, body: T): Envelope<T> {
  return {
    v: ENVELOPE_VERSION,
    kind,
    seq: alloc.take(),
    runId: init.runId ?? '',
    sessionId: init.sessionId ?? '',
    at: init.at,
    body
  }
}

/**
 * 校验收到的信封序号是否连续（客户端侧用）。
 * 客户端**不能**靠「丢弃重复、接受跳号」蒙混 —— 跳号意味着丢事件，
 * 必须走补漏流程（见 ReplayBuffer），否则用户看到的就是「少了一条消息」。
 */
export function checkSeq(expected: number, received: number): { ok: true } | { ok: false; duplicate: true } | { ok: false; gap: number } {
  if (received === expected) return { ok: true }
  if (received < expected) return { ok: false, duplicate: true }
  return { ok: false, gap: received - expected }
}

// ───── src/relay/net/secure-frame.ts ─────
/**
 * 应用层加密帧（sessionKey → AES-256-GCM）。
 * > 中继只转发密文，无法解密内容——这一点必须在设置页明确写给用户看，
 * > 否则「把工作区推给第三方服务器」会直接劝退。
 * 要兑现「中继也无法解密」，必须在 TLS 里面再套一层端到端加密，
 * 密钥只有手机与桌面知道（`sessionKey`，B2 用 ECDH 协商）。
 * ## 四个安全决定（每个都有对应的攻击场景）
 */

export const FRAME_TAMPERED = 'FRAME_TAMPERED'
export const FRAME_REPLAYED = 'FRAME_REPLAYED'
export const FRAME_MALFORMED = 'FRAME_MALFORMED'
// FRAME_WRONG_DIRECTION 曾在这里定义但全仓零使用 —— 见上方 SEQ_OUT_OF_ORDER 的说明。
// 方向上确实有校验（relay-channel 里「明文帧一律视为攻击」那条），
// 但它用的是既有错误码，没有用到这个常量。


export class FrameError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'FrameError'
  }
}

export type Direction = 'phone-to-desktop' | 'desktop-to-phone'

/** 线上帧：只有计数与密文 */
export interface SealedFrame {
  /** 计数器（字符串，避免 JSON 大整数问题） */
  n: string
  /** base64url(密文 || 16 字节 GCM tag) */
  c: string
}

export interface SecureChannelOptions {
  /** ECDH 协商出的原始共享秘密（base64），即配对时的 sessionKey */
  sessionKey: string
  /** 每条连接唯一的随机 salt（base64），由服务端在 welcome 里下发 */
  connectionSalt: string
  /** 设备 id：绑定到密钥派生，A 设备的帧不能用在 B 设备上 */
  deviceId: string
}

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * 一条连接上的加解密器。
 *
 * 只做「加密一个字节串」与「解密一个字节串」，不关心上层是信封还是心跳 ——
 * 耦合到 Envelope 会让它没法单独测，也没法复用到中继通道。
 */
export class SecureChannel {
  private readonly keys: Record<Direction, Buffer>
  private readonly aadPrefix: Record<Direction, Buffer>
  /** 每个方向已发出的最大计数（发送侧） */
  private readonly sendCounter: Record<Direction, number> = { 'phone-to-desktop': 0, 'desktop-to-phone': 0 }
  /**
   * 每个方向已接受的最大计数（接收侧）。**初值是 -1**，不是 0。
   *
   * 这里踩过一个真实的 off-by-one：初值为 0 时，对端发的第一帧
   * （计数 0）会被判成「不新于已见 0」→ `FRAME_REPLAYED`，
   * 一条合法连接从第一帧起就永远解不开。用 -1 表示「还没接受过任何帧」。
   */
  private readonly recvCounter: Record<Direction, number> = { 'phone-to-desktop': -1, 'desktop-to-phone': -1 }
  private readonly salt: Buffer

  constructor(options: SecureChannelOptions) {
    const ikm = Buffer.from(options.sessionKey, 'base64')
    if (ikm.length === 0) throw new FrameError(FRAME_MALFORMED, 'sessionKey 不能为空')

    this.salt = Buffer.from(options.connectionSalt, 'base64')
    if (this.salt.length !== 16) {
      throw new FrameError(FRAME_MALFORMED, 'connectionSalt 必须是 16 字节（防止 nonce 重用）')
    }

    // HKDF：即使 sessionKey 均匀，也用 HKDF 做一次域分离，
    // 避免与 B2 的 HMAC 签名密钥同源复用（同一把钥匙干两件事是常见错误）
    const derive = (direction: Direction): Buffer =>
      Buffer.from(
        hkdfSync('sha256', ikm, this.salt, Buffer.from(`morrow-frame:v1:${direction}:${options.deviceId}`), KEY_BYTES)
      )

    this.keys = {
      'phone-to-desktop': derive('phone-to-desktop'),
      'desktop-to-phone': derive('desktop-to-phone')
    }
    // AAD 参与认证，但不传输：改方向/改设备会认证失败
    this.aadPrefix = {
      'phone-to-desktop': Buffer.from(`morrow-frame:v1|${options.deviceId}|${direction2tag('phone-to-desktop')}|`, 'utf8'),
      'desktop-to-phone': Buffer.from(`morrow-frame:v1|${options.deviceId}|${direction2tag('desktop-to-phone')}|`, 'utf8')
    }
  }

  /** 加密一条消息，返回可直接 JSON 序列化的帧 */
  seal(direction: Direction, plaintext: Uint8Array | string): SealedFrame {
    const counter = this.sendCounter[direction]
    this.sendCounter[direction] = counter + 1

    const nonce = nonceFor(counter)
    const key = this.keys[direction]
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aadFor(this.aadPrefix[direction], counter))

    const body = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext)
    const ct = Buffer.concat([cipher.update(body), cipher.final()])
    const tag = cipher.getAuthTag()

    return {
      n: String(counter),
      c: Buffer.concat([ct, tag]).toString('base64url')
    }
  }

  /**
   * 解密一条帧。任何异常都转成带 code 的 `FrameError`，
   * 让调用方能区分「被篡改」与「被重放」—— 前者可能是攻击，后者通常只是网络重发。
   */
  open(direction: Direction, frame: unknown): Buffer {
    if (frame === null || typeof frame !== 'object') {
      throw new FrameError(FRAME_MALFORMED, '帧不是对象')
    }
    const f = frame as Record<string, unknown>
    if (typeof f.n !== 'string' || typeof f.c !== 'string') {
      throw new FrameError(FRAME_MALFORMED, '帧缺少 n 或 c')
    }
    if (!/^\d+$/.test(f.n)) throw new FrameError(FRAME_MALFORMED, '计数不是非负整数')

    const counter = Number(f.n)
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new FrameError(FRAME_MALFORMED, '计数超出安全范围')
    }

    // 防重放：必须严格大于已见最大计数
    if (counter <= this.recvCounter[direction]) {
      throw new FrameError(FRAME_REPLAYED, `计数 ${counter} 不新于已见 ${this.recvCounter[direction]}，拒绝重放`)
    }

    let payload: Buffer
    try {
      payload = Buffer.from(f.c, 'base64url')
    } catch {
      throw new FrameError(FRAME_MALFORMED, '密文不是合法 base64url')
    }
    if (payload.length < TAG_BYTES) {
      throw new FrameError(FRAME_MALFORMED, '密文短于 GCM tag 长度')
    }

    const ct = payload.subarray(0, payload.length - TAG_BYTES)
    const tag = payload.subarray(payload.length - TAG_BYTES)

    const decipher = createDecipheriv('aes-256-gcm', this.keys[direction], nonceFor(counter))
    decipher.setAAD(aadFor(this.aadPrefix[direction], counter))
    decipher.setAuthTag(tag)

    let plain: Buffer
    try {
      plain = Buffer.concat([decipher.update(ct), decipher.final()])
    } catch {
      // 走到这里说明 GCM 认证失败：密钥不对（换了设备/方向）或密文被改动
      throw new FrameError(FRAME_TAMPERED, 'GCM 认证失败：密文、AAD 或密钥不匹配')
    }

    // 只有解密成功才推进计数 —— 否则攻击者用一个伪造帧就能把合法帧全部挤掉
    // （「先污染窗口再拒绝真消息」的拒绝服务）
    this.recvCounter[direction] = counter
    return plain
  }

  /** 当前发送计数（诊断用） */
  sentCount(direction: Direction): number {
    return this.sendCounter[direction]
  }

  /** 当前已接受的最大计数（诊断用） */
  acceptedCount(direction: Direction): number {
    return this.recvCounter[direction]
  }
}

/** 生成一条连接用的随机 salt（服务端在 welcome 里下发） */
export function newConnectionSalt(): string {
  return randomBytes(16).toString('base64')
}

function direction2tag(direction: Direction): string {
  return direction === 'phone-to-desktop' ? 'p2d' : 'd2p'
}

/**
 * 12 字节 nonce：4 字节零 + 8 字节大端计数。
 *
 * 前面补零而不是随机前缀：随机前缀需要额外同步，而计数在
 * 「每连接独立 salt」的前提下已经全局唯一（同一把钥匙下不会重复）。
 */
function nonceFor(counter: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES)
  nonce.writeUInt32BE(0, 0)
  // 用 BigInt 写 8 字节：Number 超过 2^53 会丢精度，而这里要保持严格可逆
  nonce.writeBigUInt64BE(BigInt(counter), 4)
  return nonce
}

function aadFor(prefix: Buffer, counter: number): Buffer {
  const suffix = Buffer.alloc(8)
  suffix.writeBigUInt64BE(BigInt(counter), 0)
  return Buffer.concat([prefix, suffix])
}

/**
 * 常量时间比较（供调用方做额外校验时使用，例如比对 welcome 里的 salt）。
 *
 * 直接 `===` 比较会产生时序差异，泄露「前几个字节对了」的信息。
 */
export function sameBytes(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

// ───── src/relay/net/tls.ts ─────
/**
 * LAN WSS 的 TLS 证书管理。
 * 为什么需要它：`DirectChannel` 要起一个 `wss://` 服务，就必须有证书。
 * **一、证书必须持久化，不能每次启动重新生成。**
 * 私钥必须保护 —— 拿到私钥就能冒充桌面服务端，把手机的请求全部收走。
 * 也不能把明文私钥写进文件。
 */

export interface TlsMaterial {
  /** PEM 私钥 */
  key: string
  /** PEM 证书链（自签名时就是一张） */
  cert: string
  /** 证书 SHA-256 指纹（base64url），配对时交给手机做固定 */
  fingerprint: string
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface TlsStoreOptions {
  dataDir: string
  safeStorage: SafeStorageLike
  /** 证书有效期（天）。默认 3650（10 年）—— 这是本机自用证书，不该频繁过期 */
  days?: number
  /** 生成器，测试可注入固定证书 */
  generate?: () => Promise<{ private: string; cert: string }>
}

/** 证书文件路径：<dataDir>/relay/tls.crt（公开） */
export function certPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'tls.crt')
}

/** 私钥文件路径：<dataDir>/relay/tls-key.bin（加密） */
export function tlsKeyPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'tls-key.bin')
}

/** 计算证书指纹。用 DER 而不是 PEM：PEM 的换行/首尾空格会随生成器变化 */
export function certFingerprint(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
  const der = Buffer.from(body, 'base64')
  return createHash('sha256').update(der).digest('base64url')
}

/**
 * 载入或生成 TLS 材料。
 *
 * 与 `loadOrCreateKey` 的判断顺序一致：先复用，复用不了才生成，
 * 生成后只有在能安全持久化时才落盘。
 */
export async function loadOrCreateTls(options: TlsStoreOptions): Promise<TlsMaterial> {
  const certPath = certPathIn(options.dataDir)
  const keyPath = tlsKeyPathIn(options.dataDir)

  // ── 先尝试复用 ──
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      if (!options.safeStorage.isEncryptionAvailable()) {
        // 文件在但解不开（换用户账户等）：本次用临时证书，不覆盖旧文件
        return generateEphemeral(options)
      }
      const cert = readFileSync(certPath, 'utf8')
      const key = options.safeStorage.decryptString(readFileSync(keyPath))
      if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('PRIVATE KEY')) {
        return generateEphemeral(options)
      }
      return { key, cert, fingerprint: certFingerprint(cert) }
    } catch {
      return generateEphemeral(options)
    }
  }

  // ── 没有文件：生成并尝试持久化 ──
  const fresh = await runGenerator(options)
  const material: TlsMaterial = {
    key: fresh.private,
    cert: fresh.cert,
    fingerprint: certFingerprint(fresh.cert)
  }

  if (!options.safeStorage.isEncryptionAvailable()) return material

  try {
    const dir = dirname(certPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // 证书明文（公开信息）
    writeFileSync(certPath, material.cert, 'utf8')
    // 私钥加密，原子写
    const tmp = `${keyPath}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, options.safeStorage.encryptString(material.key), { mode: 0o600 })
    renameSync(tmp, keyPath)
  } catch {
    // 落盘失败不影响本次运行，只是下次启动会换证书、手机要重新确认指纹
  }
  return material
}

async function generateEphemeral(options: TlsStoreOptions): Promise<TlsMaterial> {
  const fresh = await runGenerator(options)
  return { key: fresh.private, cert: fresh.cert, fingerprint: certFingerprint(fresh.cert) }
}

async function runGenerator(options: TlsStoreOptions): Promise<{ private: string; cert: string }> {
  if (options.generate) return options.generate()
  // 动态 import：selfsigned 只在需要生成证书时加载，
  // 已有多数场景（启动时复用证书）不必付这个代价
  const mod = (await import('selfsigned')) as unknown as {
    generate: (
      attrs: Array<{ name: string; value: string }>,
      opts: Record<string, unknown>
    ) => Promise<{ private: string; cert: string }>
  }
  return mod.generate([{ name: 'commonName', value: 'morrow-lan' }], {
    days: options.days ?? 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          // mDNS 主机名：手机通过 _morrow._tcp.local 找到桌面后，
          // 用它作为 Host 建立 TLS，证书里必须含这个名字，否则主机名校验失败
          { type: 2, value: 'morrow.local' }
        ]
      }
    ]
  })
}

// ----------------------------------------------------------------

// ───── src/relay/pairing.ts ─────
/**
 * 配对与密钥协商。
 * **一、票据不能可重放。** 只在 `exp` 上做文章是不够的：攻击者偷到票据后，
 * **二、六位码必须是「桌面生成、人工比对」。** 如果六位码是手机算的再发给桌面，
 * - 六位码错误次数有上限（默认 3 次），超过直接作废票据，防在线爆破（6 位数只有 100 万种）。
 * - 撤销设备后**同一请求内**必须失效，不能等下次握手。
 */

/** 蓝图原文要求的四个错误码 */
export const TICKET_EXPIRED = 'TICKET_EXPIRED'
export const TICKET_USED = 'TICKET_USED'
export const CODE_MISMATCH = 'CODE_MISMATCH'
export const DEVICE_REVOKED = 'DEVICE_REVOKED'
/** 票据不存在 / 格式错误 */
export const TICKET_INVALID = 'TICKET_INVALID'
/** 六位码尝试次数用尽 */
export const CODE_ATTEMPTS_EXCEEDED = 'CODE_ATTEMPTS_EXCEEDED'

/** 票据有效期：蓝图原文 90 秒 */
export const TICKET_TTL_MS = 90_000
/** 六位码允许的错误次数 */
export const MAX_CODE_ATTEMPTS = 3
/** nonce 长度：蓝图 random(16) */
const PAIRING_NONCE_BYTES = 16

export type PairingErrorCode =
  | typeof TICKET_EXPIRED
  | typeof TICKET_USED
  | typeof TICKET_INVALID
  | typeof CODE_MISMATCH
  | typeof CODE_ATTEMPTS_EXCEEDED
  | typeof DEVICE_REVOKED

export class PairingError extends Error {
  readonly code: PairingErrorCode
  constructor(code: PairingErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'PairingError'
  }
}

/** 票据载荷。字段名与蓝图原文一致；**不含任何密钥**。 */
export interface PairTicket {
  /** 设备标识（手机侧的稳定 id） */
  deviceId: string
  /** 手机的长公钥（P-256 未压缩点，base64）。公钥不是秘密，可以进二维码。 */
  pubKey: string
  /**
   * 桌面的长期公钥（P-256 未压缩点，base64）。
   * 手机必须拿到它才能算 ECDH：`ECDH(手机私钥, 桌面公钥)`。
   * sessionKey」变成「必须先连上中继」，与蓝图「两端现场协商」不符。
   */
  desktopPub: string
  /** 一次性随机数，十六进制 */
  nonce: string
  /** 过期时间戳（毫秒） */
  exp: number
  /** 中继提示（可选）：手机据此选择连接地址 */
  relayHint?: string
  /**
   * 桌面的 TLS 证书指纹（可选，缺失时手机拒绝完成配对）。
   * 同时坏。但**手机侧缺它时必须拒绝完成配对**，不能存一份没有指纹的凭据
   */
  fingerprint?: string
}

/** 已配对设备记录 */
export interface PairedDevice {
  deviceId: string
  /** 手机长期公钥（base64） */
  pubKey: string
  /** 会话密钥（base64）；撤销时立即删除 */
  sessionKey: string
  /** 配对时间 */
  pairedAt: number
  /** 设备展示名（可选） */
  name?: string
}

export interface PairingStoreOptions {
  /** HMAC 密钥。桌面首次运行生成并持久化；不写进票据。 */
  secret: Buffer
  /** 注入时钟，便于测试过期；默认 Date.now */
  now?: () => number
  /**
   * 桌面 TLS 证书指纹（`base64url(sha256(DER))`，无填充）。
   *
   * 由 `loadOrCreateTls()` 产出，在启动时注入 —— 不在这里现算，
   * 因为证书是 `startLanStack` 才载入的，而 PairingService 先于它构造。
   * 注入之后每一张票据都会带上它，手机据此做证书固定。
   *
   * 不传 = 票据不带指纹 = 手机拒绝完成配对（明确的失败，不是静默降级）。
   */
  tlsFingerprint?: string
  /**
   * 长期 ECDH 私钥（base64）。由 keystore 从磁盘还原。
   * 不传则本次运行生成 —— 重启后桌面公钥会变，已配对设备失效。
   */
  privateKey?: string
  /**
   * 设备表持久化钩子。传了才落盘；不传则设备表只在内存里（重启丢失）。
   *
   * 为什么不在这里直接依赖 device-store：那会让 pairing.ts 依赖文件系统，
   * 单测就得起临时目录。用钩子注入，测试可以给内存实现，
   * 生产环境传真实的 load/save。
   */
  devices?: {
    load: () => PairedDevice[]
    save: (devices: PairedDevice[]) => void
  }
  /**
   * 设备表发生变化时的通知（配对完成 / 撤销）。
   *
   * 存在的理由：设置页是**被动**打开的。用户盯着页面时手机刚好配完，
   * 不通知的话那块列表会一直显示「还没有配对的手机」，
   * 直到用户关掉设置再打开——而用户刚在手机上看到「配对成功」。
   * 参数是**最新的设备列表**（不含 sessionKey），可直接推给界面。
   */
  onDevicesChanged?: (devices: Array<{ deviceId: string; pairedAt: number; name?: string }>) => void
}

interface LiveTicket extends PairTicket {
  /** 是否已被使用（一次性） */
  used: boolean
  /** 六位码错误次数 */
  failedAttempts: number
  /** 桌面侧派生的六位码，供人工比对 */
  code: string
}

/**
 * 六位码派生。
 *
 * 用「桌面私钥上下文 + 双方公钥」派生，两端能独立算出同一个值：
 * 桌面知道自己的私钥和手机的公钥，手机知道自己的私钥和桌面的公钥，
 * ECDH 的共享秘密相同 → HMAC 输入相同 → 六位码相同。
 *
 * 中间人替换公钥后共享秘密不同 → 两端六位码不同 → 用户比对时能看出来。
 */
export function derivePairingCode(sharedSecret: Buffer, nonce: string): string {
  const mac = createHmac('sha256', sharedSecret).update(`pair-code:${nonce}`).digest()
  // 取前 4 字节转成 0..999999，补足六位。用无符号读避免负数。
  const n = mac.readUInt32BE(0) % 1_000_000
  return n.toString().padStart(6, '0')
}

function toBase64(buf: Buffer): string {
  return buf.toString('base64')
}

function fromBase64(text: string): Buffer {
  return Buffer.from(text, 'base64')
}

/** 常量时间比较，避免通过响应时间侧信道猜 nonce */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 校验一条设备记录是否完整。
 *
 * 导出供 device-store 复用：两处各写一份的话，将来加字段只改一边，
 * 就会出现「内存接受、磁盘拒收」这类难以定位的错配。
 * 依赖方向是单向的（device-store → pairing），不会形成循环。
 */
export function isWellFormedDevice(d: unknown): d is PairedDevice {
  if (d === null || typeof d !== 'object') return false
  const r = d as Record<string, unknown>
  return (
    typeof r.deviceId === 'string' &&
    r.deviceId.length > 0 &&
    typeof r.pubKey === 'string' &&
    typeof r.sessionKey === 'string' &&
    typeof r.pairedAt === 'number' &&
    Number.isFinite(r.pairedAt)
  )
}

export class PairingService {
  private readonly now: () => number
  /** 票据表：nonce → 票据。用 nonce 作键，天然一一对应。 */
  private readonly tickets = new Map<string, LiveTicket>()
  /** 配对设备表：deviceId → 设备 */
  private readonly devices = new Map<string, PairedDevice>()
  /** 桌面长期 ECDH 密钥对。由 keystore 从磁盘还原，重启后保持不变。 */
  private readonly ecdh = createECDH('prime256v1')
  private readonly publicKey: string
  /**
   * 桌面 TLS 证书指纹。启动时由 `loadOrCreateTls()` 注入。
   *
   * 可变而不是 readonly：`startLanStack` 里证书载入晚于 PairingService 构造，
   * 而且失败时会退回「临时证书」（每次启动都变）。用 setter 而不是
   * 重新构造 PairingService —— 后者会丢掉已载入的设备表与在途票据。
   */
  private tlsFingerprint: string | null
  /** 设备表持久化钩子；未注入时设备表仅在内存 */
  private readonly store?: { load: () => PairedDevice[]; save: (devices: PairedDevice[]) => void }
  /** 设备表变更通知（见 PairingStoreOptions.onDevicesChanged） */
  private readonly onDevicesChanged?: (
    devices: Array<{ deviceId: string; pairedAt: number; name?: string }>
  ) => void

  constructor(options: PairingStoreOptions) {
    if (!Buffer.isBuffer(options.secret) || options.secret.length < 16) {
      throw new Error('配对 HMAC 密钥至少 16 字节')
    }
    this.now = options.now ?? Date.now
    if (options.privateKey) {
      // 复用磁盘上的长期私钥：重启后桌面公钥不变，
      // 已配对手机算出的 ECDH 共享秘密仍然有效。
      try {
        this.ecdh.setPrivateKey(Buffer.from(options.privateKey, 'base64'))
      } catch {
        // 私钥损坏：退化为新密钥。调用方可通过 desktopKeyRestored() 感知。
        this.ecdh.generateKeys()
      }
    } else {
      this.ecdh.generateKeys()
    }
    this.publicKey = toBase64(this.ecdh.getPublicKey())
    this.tlsFingerprint = options.tlsFingerprint ?? null
    this.store = options.devices
    this.onDevicesChanged = options.onDevicesChanged

    // 载入已配对设备表（如果注入了持久化）。
    // 这里必须是**构造期**载入：如果等第一次请求才载入，
    // 重启后第一台手机的请求会因为「表还是空的」被拒成 DEVICE_REVOKED，
    // 用户看到的就是「重启后第一次连不上，再试一次才行」。
    if (this.store) {
      try {
        for (const d of this.store.load()) {
          if (isWellFormedDevice(d)) this.devices.set(d.deviceId, d)
        }
      } catch {
        // 载入失败当作空表：用户重新配对，不影响服务启动
      }
    }
  }

  /** 桌面公钥（进二维码，供手机做 ECDH） */
  desktopPublicKey(): string {
    return this.publicKey
  }

  /**
   * 注入 / 更新桌面 TLS 证书指纹。
   */
  setTlsFingerprint(fingerprint: string | null): void {
    this.tlsFingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : null
  }

  /** 当前是否已知道证书指纹（诊断用） */
  hasTlsFingerprint(): boolean {
    return this.tlsFingerprint !== null
  }

  /**
   * 签发票据（桌面 → 二维码）。
   *
   * @param deviceId 手机设备标识
   * @param phonePubKey 手机长期公钥
   * @param relayHint 中继地址提示
   */
  issueTicket(deviceId: string, phonePubKey: string, relayHint?: string): { ticket: PairTicket; code: string; qr: string } {
    if (!deviceId) throw new PairingError(TICKET_INVALID, 'deviceId 不能为空')
    if (!phonePubKey) throw new PairingError(TICKET_INVALID, '手机公钥不能为空')

    const nonce = randomBytes(PAIRING_NONCE_BYTES).toString('hex')
    const exp = this.now() + TICKET_TTL_MS
    const ticket: PairTicket = {
      deviceId,
      pubKey: phonePubKey,
      desktopPub: this.publicKey,
      nonce,
      exp,
      ...(relayHint ? { relayHint } : {}),
      // 证书指纹：有就带上（手机据此做证书固定）。
      // 没有就不带 —— 手机侧会明确拒绝完成配对，好过让它存一份无指纹的凭据。
      ...(this.tlsFingerprint ? { fingerprint: this.tlsFingerprint } : {})
    }

    // 六位码：用桌面私钥 + 手机公钥算共享秘密，再 HMAC 派生。
    // 手机侧用自己的私钥 + 桌面公钥算出同一个值。
    const shared = this.ecdh.computeSecret(fromBase64(phonePubKey))
    const code = derivePairingCode(shared, nonce)

    this.tickets.set(nonce, { ...ticket, used: false, failedAttempts: 0, code })

    // qr 是票据的 base64（蓝图用 base32，但 Node 无内置 base32；
    // 这里用 base64url 保证可在 URL 中传递且无歧义，信息量一致）
    const qr = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')
    return { ticket, code, qr }
  }

  /** 解析二维码内容（手机侧或桌面侧校验用） */
  static parseTicket(qr: string): PairTicket {
    try {
      const json = Buffer.from(qr, 'base64url').toString('utf8')
      const obj = JSON.parse(json) as Partial<PairTicket>
      if (
        !obj ||
        typeof obj.deviceId !== 'string' ||
        typeof obj.pubKey !== 'string' ||
        typeof obj.desktopPub !== 'string' ||
        typeof obj.nonce !== 'string' ||
        typeof obj.exp !== 'number'
      ) {
        throw new Error('字段缺失')
      }
      // fingerprint 是可选字段，但**存在时必须是 string**。
      // 不校验的话，`{"fingerprint": 123}` 会被当成合法票据解析出来，
      // 手机侧做指纹比对时会拿到 "123" 这种永远不会匹配的值 ——
      // 用户看到的是「指纹不匹配」，而真实原因是票据畸形。
      if (obj.fingerprint !== undefined && typeof obj.fingerprint !== 'string') {
        throw new Error('fingerprint 必须是字符串')
      }
      return obj as PairTicket
    } catch {
      throw new PairingError(TICKET_INVALID, '二维码内容不是合法票据')
    }
  }

  /**
   * 校验票据（桌面收到手机 nonceEcho 后调用）。
   *
   * 判定顺序是刻意的：**先用后过期**。理由：已用过的票据再拿来，
   * 无论是否过期都应报「已使用」—— 这是重放攻击的特征，
   * 报 EXPIRED 会让攻击者误以为「只是慢了一点点」，掩盖了攻击事实。
   */
  private requireUsable(nonce: string): LiveTicket {
    const t = this.tickets.get(nonce)
    if (!t) throw new PairingError(TICKET_INVALID, '票据不存在')

    // 顺序：先判「已用」，再判「过期」。
    // 已用优先是为了让重放暴露成 TICKET_USED —— 那是攻击特征，
    // 报 EXPIRED 会让人误以为只是慢了一步。
    if (t.used) throw new PairingError(TICKET_USED, '票据已使用，重放被拒绝')
    if (this.now() > t.exp) {
      // 过期即清理，避免长期驻留内存
      this.tickets.delete(nonce)
      throw new PairingError(TICKET_EXPIRED, '票据已过期')
    }
    this.sweepExpired()
    return t
  }

  /**
   * 清理过期票据。
   * 只在成功路径上调用（而不是每次查询前）：如果在判定之前清扫，
   * 一个刚过期 1 毫秒的票据会被静默删掉，用户看到的是「配对码不存在」，
   * 而真实原因是「刚好过期」—— 两种提示对用户的意义完全不同。
   * 先判定、后清理，才能把「过期」如实告诉用户。
   */
  private sweepExpired(): void {
    const now = this.now()
    for (const [nonce, t] of this.tickets) {
      if (now > t.exp) this.tickets.delete(nonce)
    }
  }

  /** 校验 nonceEcho 是否与票据一致，并返回桌面侧的六位码供展示 */
  verifyEcho(nonceEcho: string): { deviceId: string; code: string } {
    const t = this.requireUsable(nonceEcho)
    // nonce 本身就是键，能取到就说明一致；这里额外做常量时间比较，
    // 防止将来改成别的索引方式时退化。
    if (!safeEqual(t.nonce, nonceEcho)) throw new PairingError(TICKET_INVALID, 'nonce 不匹配')
    return { deviceId: t.deviceId, code: t.code }
  }

  /**
   * 用户输入六位码确认（桌面侧）。
   *
   * 六位码只有 100 万种可能，必须限制尝试次数。超过上限直接作废票据，
   * 让攻击者失去继续试的机会 —— 这比「只报错不作废」更安全。
   *
   * ---
   *
   * ## ⚠ 生产路径目前**不调用**这个方法（P1-04）
   *
   * 配对走的是 `handlePairConfirm` → `completePairingByNonce(nonce)`，
   * 只校验票据存在就写设备表，**六位码从未参与鉴权**。
   * 手机端 `RelayProtocol.pairConfirmFrame(nonce)` 也只发 nonce、不发 code。
   *
   * 这意味着：
   *  · 这个方法的限流（`MAX_CODE_ATTEMPTS`）与 `safeEqual` 在产线**从不执行**；
   *  · 「配对需要六位码确认」这个安全假设**当前不成立** ——
   *    能拿到票据 nonce 的人可以直接完成配对。
   *
   * 为什么没顺手修：修它要同时改三处并**同步发版**——
   * 手机加发 `code`、`handlePairConfirm` 改调 `confirmCode` + 校验，
   * 以及一处兜底（旧版手机不带 code 时怎么处理）。两端版本不一致时
   * 配对会直接失败，而配对失败意味着用户要重新扫码，属于可感知的回归。
   *
   * 所以这里只做标注，不动行为。接的时候按上面三处一起改，
   * 并补一条端到端测试（错误 code 必须配不上）。
   */
  confirmCode(nonce: string, input: string): { deviceId: string } {
    const t = this.requireUsable(nonce)

    if (!safeEqual(t.code, input)) {
      t.failedAttempts += 1
      if (t.failedAttempts >= MAX_CODE_ATTEMPTS) {
        // 同样保留记录：这张票是「因为爆破而作废」，与自然过期是两件事，
        // 审计时要能区分。标 used 后 requireUsable 会报 TICKET_USED。
        t.used = true
        throw new PairingError(CODE_ATTEMPTS_EXCEEDED, `六位码错误 ${MAX_CODE_ATTEMPTS} 次，票据已作废`)
      }
      throw new PairingError(CODE_MISMATCH, `六位码不匹配（第 ${t.failedAttempts} 次）`)
    }

    return { deviceId: t.deviceId }
  }

  /**
   * 完成配对：生成会话密钥、写入设备表、**立即作废票据**。
   *
   * 顺序很重要：先算 sessionKey，再作废票据，最后写设备表。
   * 如果先作废后算密钥，一旦 ECDH 抛错，用户就得到「票据没了但也没配上」，
   * 必须重新扫码 —— 体验上像是随机失败。
   */
  completePairing(nonce: string, phonePubKey: string, name?: string): PairedDevice {
    const t = this.requireUsable(nonce)
    if (!safeEqual(t.pubKey, phonePubKey)) {
      throw new PairingError(TICKET_INVALID, '手机公钥与票据不一致')
    }

    let sessionKey: string
    try {
      sessionKey = toBase64(this.ecdh.computeSecret(fromBase64(phonePubKey)))
    } catch {
      throw new PairingError(TICKET_INVALID, '公钥格式不合法')
    }

    // 票据一次性：配对成功立即作废。
    // 注意这里**保留记录**只标记 used，而不是删除 —— 删除会让重放变成
    // TICKET_INVALID（看起来像「没这张票」），掩盖了「有人拿用过的票重放」这个事实。
    t.used = true

    const device: PairedDevice = {
      deviceId: t.deviceId,
      pubKey: t.pubKey,
      sessionKey,
      pairedAt: this.now(),
      ...(name ? { name } : {})
    }
    this.devices.set(t.deviceId, device)
    // 配对成功立即落盘。不写盘的话，用户刚配好、重启就没了。
    this.persist()
    // 落盘之后再通知界面：界面读到的一定是已经持久化的那一份。
    this.notifyChanged()
    return device
  }

  /**
   * 完成配对的入口：只给 nonce，公钥从在途票据里取。
   *
   * 手机侧只有 nonce（它从票据里读到的），没有单独的「把公钥再发一遍」的
   * 必要——票据里的 `pubKey` 就是它自己的公钥，且 `completePairing` 会校验
   * 传入公钥与票据一致。让手机再发一次公钥只会多一个可被替换的字段。
   */
  completePairingByNonce(nonce: string, name?: string): PairedDevice {
    const t = this.requireUsable(nonce)
    return this.completePairing(nonce, t.pubKey, name)
  }

  /**
   * 把当前设备表写盘。任何一处改动设备表后都必须调用。
   *
   * 集中在一个方法里，是为了避免「配对写了、撤销忘了写」这种遗漏 ——
   * 后者会让被撤销的设备在重启后复活，是真实的安全漏洞。
   */
  private persist(): void {
    if (!this.store) return
    try {
      this.store.save([...this.devices.values()])
    } catch {
      // 落盘失败不影响本次运行（内存里是对的），只是重启会丢。
      // 静默是刻意的：不能因为磁盘满就让「撤销」这个操作失败，
      // 那会让用户以为设备已被移除，实际仍在内存里可用。
    }
  }

  /**
   * 通知界面设备表变了。
   *
   * 回调里抛错**不能**让配对/撤销失败：那只影响界面刷新，
   * 而设备表已经正确写入内存与磁盘。吞掉错误并让主流程继续。
   */
  private notifyChanged(): void {
    try {
      this.onDevicesChanged?.(this.listDevices())
    } catch {
      // 界面通知失败不影响配对结果
    }
  }

  /**
   * 判定某设备当前是否可用（server.ts 的第四道判定）。
   *
   * 撤销后必须**立即**失效：这里每次都查内存表，不缓存，
   * 所以 revoke 之后的下一次调用就会拿到 DEVICE_REVOKED。
   */
  requirePaired(deviceId: string): PairedDevice {
    const d = this.devices.get(deviceId)
    if (!d) throw new PairingError(DEVICE_REVOKED, '设备未配对或已被撤销')
    return d
  }

  /**
   * 验证一次请求的签名。
   * 为什么必须有这个：只用 `x-morrow-device: phone-1` 这样的明文头是**没有鉴权**的，
   * 任何知道设备 id 的人都能冒充。签名把「知道一个标识」变成「持有会话密钥」。
   * 签名内容必须覆盖三样东西，少一样都能被利用：
   * - **把通道名纳入签名**：否则攻击者可以拿「读会话列表」的签名去调「批权限」。
   * - **把时间戳纳入签名并限制时窗**：否则签名可被无限期重放。
   * - **把 deviceId 纳入签名**：否则同一台已撤销设备的签名可被贴到另一台设备上。
   * 注意这是「传输层之前的最小鉴权」：B3 的 WSS 会用 sessionKey 加密整个信道，
   * 但明文 HTTP 那一段同样必须验，不能让「先连上再鉴权」留下一个窗口。
   */
  verifyRequest(deviceId: string, channel: string, timestamp: string, signature: string, toleranceMs = 60_000): PairedDevice {
    const device = this.requirePaired(deviceId)

    const ts = Number(timestamp)
    if (!Number.isFinite(ts)) throw new PairingError(DEVICE_REVOKED, '请求缺少有效时间戳')
    if (Math.abs(this.now() - ts) > toleranceMs) {
      throw new PairingError(DEVICE_REVOKED, '请求时间戳超出允许窗口')
    }

    const expected = createHmac('sha256', fromBase64(device.sessionKey))
      .update(`${deviceId}\n${channel}\n${timestamp}`)
      .digest('base64url')

    if (!safeEqual(expected, signature)) {
      throw new PairingError(DEVICE_REVOKED, '请求签名不匹配')
    }
    return device
  }

  /** 供客户端侧使用（手机端实现同样逻辑）；返回签名串 */
  static signRequest(sessionKeyBase64: string, deviceId: string, channel: string, timestamp: string): string {
    return createHmac('sha256', Buffer.from(sessionKeyBase64, 'base64'))
      .update(`${deviceId}\n${channel}\n${timestamp}`)
      .digest('base64url')
  }

  /** 撤销设备（桌面设置页一键踢掉） */
  revokeDevice(deviceId: string): boolean {
    const existed = this.devices.delete(deviceId)
    // 关键：撤销必须落盘。
    // 只删内存不写盘的话，重启后这台设备会从文件里「复活」，
    // 用户以为踢掉了，系统下次启动又把它请回来。
    if (existed) {
      this.persist()
      this.notifyChanged()
    }
    return existed
  }

  /** 已配对设备列表（不含 sessionKey，供设置页展示） */
  listDevices(): Array<{ deviceId: string; pairedAt: number; name?: string }> {
    return [...this.devices.values()].map((d) => ({
      deviceId: d.deviceId,
      pairedAt: d.pairedAt,
      ...(d.name ? { name: d.name } : {})
    }))
  }

  /** 测试与清理用：作废全部票据 */
  clearTickets(): void {
    this.tickets.clear()
  }

  /** 当前有效票据数（测试断言用） */
  liveTicketCount(): number {
    return this.tickets.size
  }
}

// ───── src/relay/keystore.ts ─────
/**
 * 桌面长期密钥持久化。
 * 为什么必须有：B2 的 `PairingService` 每次构造都 `generateKeys()`，
 * **一、私钥落盘必须加密。** 用 Electron 的 `safeStorage`（Windows 走 DPAPI，
 * **二、safeStorage 不可用时不能明文降级。** 有些 Linux 环境没有 keyring。
 * 而不是偷偷写明文 —— 那会在用户不知情的情况下降低安全性。
 */

export interface KeyStoreOptions {
  /** 用户数据目录 */
  dataDir: string
  /** Electron safeStorage；测试可注入假实现 */
  safeStorage: SafeStorageLike
}

export interface LoadedKey {
  /** P-256 私钥（未压缩点，base64） */
  privateKey: string
  /** 对应的公钥（base64） */
  publicKey: string
  /** 是否来自磁盘（false = 本次新生成） */
  restored: boolean
}

/** 密钥文件路径：<dataDir>/relay/desktop-key.bin */
export function keyPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'desktop-key.bin')
}

/**
 * 从私钥推导公钥。
 *
 * ECDH 的私钥是标量，公钥 = 标量 × 基点。Node 的 createECDH 支持
 * `setPrivateKey(buf)` 后再 `getPublicKey()`，用它来校验与还原。
 */
function publicFromPrivate(privateKeyBase64: string): string {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(privateKeyBase64, 'base64'))
  return ecdh.getPublicKey().toString('base64')
}

/**
 * 载入或生成长期密钥。
 *
 * 返回 `restored: true` 表示成功复用磁盘上的密钥（重启后设备仍有效）；
 * `restored: false` 表示新生成（首次运行，或无法安全持久化）。
 */
export function loadOrCreateKey(options: KeyStoreOptions): LoadedKey {
  const path = keyPathIn(options.dataDir)

  // ── 先尝试复用 ──
  if (existsSync(path)) {
    try {
      const encrypted = readFileSync(path)
      if (!options.safeStorage.isEncryptionAvailable()) {
        // 文件存在但当前环境无法解密：不覆盖它（可能是换了用户账户），
        // 本次退化为临时密钥。直接删掉会让用户在换回原账户时永久丢失配对。
        return generateTemporary()
      }
      const privateKey = options.safeStorage.decryptString(encrypted)
      // 校验：能被 setPrivateKey 接受，且能导出公钥
      if (!/^[A-Za-z0-9+/=]+$/.test(privateKey)) return generateTemporary()
      const publicKey = publicFromPrivate(privateKey)
      return { privateKey, publicKey, restored: true }
    } catch {
      // 文件损坏：不阻塞启动，退化为新密钥（旧配对失效，但没有更安全的选项）
      return generateTemporary()
    }
  }

  // ── 没有文件：生成并尝试持久化 ──
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const privateKey = ecdh.getPrivateKey().toString('base64')
  const publicKey = ecdh.getPublicKey().toString('base64')
  const created: LoadedKey = { privateKey, publicKey, restored: false }

  // safeStorage 不可用：**不写明文**，直接返回临时密钥
  if (!options.safeStorage.isEncryptionAvailable()) return created

  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const encrypted = options.safeStorage.encryptString(privateKey)
    // 原子写：临时文件 + rename
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, encrypted, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // 落盘失败不影响本次运行，只是下次要重新配对
    return created
  }
  return created
}

function generateTemporary(): LoadedKey {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    privateKey: ecdh.getPrivateKey().toString('base64'),
    publicKey: ecdh.getPublicKey().toString('base64'),
    restored: false
  }
}

/** 删除持久化密钥（用户主动「解除全部设备」时使用） */
export function deleteKey(dataDir: string): boolean {
  const path = keyPathIn(dataDir)
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

// ───── src/relay/device-store.ts ─────
/**
 * 已配对设备表持久化。
 * 为什么必须有：B3 第一批只让**桌面公钥**跨重启不变，设备表仍在内存里。
 * 三个安全约束：
 * **一、必须加密，不能明文落盘。** 设备表里存着每台手机的 `sessionKey`，
 * 拿到它就能冒充桌面解密整条信道；明文落盘等于把密钥交给任何能读磁盘的人。
 * **二、损坏时退化为空表，但不能覆盖原文件。** 空表让 relay 能启动
 * （用户重新配对即可），覆盖则会让「还有机会恢复」变成「永久丢失」。
 * **三、撤销必须立即落盘。** 这是本文件里最容易漏、后果最严重的一条：
 * 只把设备从内存里删掉，下次重启又从磁盘读回来 —— 用户以为已经踢掉的手机，
 * 重启后又能连上来。
 */

/** 文件格式版本，便于以后迁移 */
const STORE_VERSION = 1

interface StoreFile {
  v: number
  devices: PairedDevice[]
}

/** 设备表文件路径：<dataDir>/relay/devices.bin */
export function devicesPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'devices.bin')
}

export interface DeviceStoreOptions {
  dataDir: string
  safeStorage: SafeStorageLike
}

/**
 * 读取设备表。
 *
 * 任何异常都退化为空表 —— 设备表损坏不该让整个 relay 启动失败，
 * 用户重新配对即可恢复。但**不覆盖**损坏的文件：
 * 万一只是临时读失败（比如换回原用户账户），旧数据还有救。
 */
export function loadDevices(options: DeviceStoreOptions): PairedDevice[] {
  const path = devicesPathIn(options.dataDir)
  if (!existsSync(path)) return []

  if (!options.safeStorage.isEncryptionAvailable()) return []

  try {
    const encrypted = readFileSync(path)
    const json = options.safeStorage.decryptString(encrypted)
    const parsed = JSON.parse(json) as Partial<StoreFile>
    if (parsed?.v !== STORE_VERSION || !Array.isArray(parsed.devices)) return []
    // 逐条校验形状：损坏的条目直接丢弃，而不是让整个表失效
    return parsed.devices.filter(isWellFormedDevice)
  } catch {
    return []
  }
}

/**
 * 写入设备表（全量覆盖）。
 *
 * 用临时文件 + rename 保证原子性：直接写目标文件时若进程崩在中间，
 * 会留下半个文件，下次启动解析失败 → 回到「每次都要重配」。
 *
 * @returns 是否成功落盘（false 表示只存在内存里，重启会丢）
 */
export function saveDevices(options: DeviceStoreOptions, devices: PairedDevice[]): boolean {
  if (!options.safeStorage.isEncryptionAvailable()) return false

  const path = devicesPathIn(options.dataDir)
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const payload: StoreFile = { v: STORE_VERSION, devices }
    const encrypted = options.safeStorage.encryptString(JSON.stringify(payload))

    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, encrypted, { mode: 0o600 })
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/** 清空设备表（用户「解除全部设备」） */
export function clearDevices(options: DeviceStoreOptions): boolean {
  const path = devicesPathIn(options.dataDir)
  if (!existsSync(path)) return true
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

// ───── src/relay/pair-api.ts ─────
/**
 * 设置页「手机配对」的后端逻辑。
 *
 * 这一层存在的理由：`ipcMain.handle` 的回调必须拿 `electron` 的环境，
 * 单元测试里既起不来也断言不了。所以把逻辑抽成不依赖 electron 的纯函数，
 * 由 ipc 层薄薄地包一层。
 *
 * 这时候「生成配对码」必须明确报错，而不是：返回一张能显示但连不上的票、
 * 或者悄悄自己把 relay 打开。前者会让用户拿着废票在手机上反复试，
 * 后者等于绕过用户的开关去监听端口 —— 那是更严重的事。
 * 统一的答复是 [RELAY_DISABLED]：「先在远程通道里打开它」。
 */

export const RELAY_DISABLED = 'RELAY_DISABLED'

/** 把内部异常翻成界面上能用的错误码，不把栈信息丢给渲染进程 */
function toResultError(err: unknown): { code: string; message: string } {
  if (err instanceof PairingError) {
    return { code: err.code, message: err.message }
  }
  return { code: 'PAIR_FAILED', message: err instanceof Error ? err.message : '配对操作失败' }
}

/**
 * 签发票据。
 * 调用方要给 `phonePubKey` —— 票据里的 `pubKey` 必须**是手机自己的公钥**
 * （手机侧会校验归属，见 `EcdhPairing` 的 §4.5）。所以桌面不能凭空生成一张票，
 * 必须先拿到手机侧的配对请求。
 */
export function issuePairTicket(
  pairing: PairingService | null,
  input: { deviceId: string; phonePubKey: string; relayHint?: string }
): Result<PairIssueResult> {
  if (!pairing) {
    return {
      ok: false,
      error: { code: RELAY_DISABLED, message: '远程通道没有开启。先在「远程通道」里打开它，再生成配对码。' }
    }
  }
  try {
    const { ticket, code, qr } = pairing.issueTicket(input.deviceId, input.phonePubKey, input.relayHint)
    return {
      ok: true,
      data: {
        qr,
        code,
        // 用票据里的 exp，不是「现在 + TTL」—— 那样界面倒计时会与票据真实寿命差几毫秒
        expiresAt: ticket.exp,
        nonce: ticket.nonce,
        // 指纹缺失时手机侧会拒绝完成配对，界面必须当场提示而不是让用户白扫
        hasFingerprint: typeof ticket.fingerprint === 'string' && ticket.fingerprint.length > 0,
        // 连接地址同样由手机强校验；回带给界面，配对面板可以直接显示
        // 「手机要连的地址」，出问题时不用再去翻日志。
        ...(typeof ticket.relayHint === 'string' && ticket.relayHint.length > 0
          ? { relayHint: ticket.relayHint }
          : {})
      }
    }
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/** 已配对设备。不返回 sessionKey（界面上不需要，泄露了也没用，但没必要送出去）。 */
export function listPairDevices(pairing: PairingService | null): Result<PairDeviceView[]> {
  if (!pairing) {
    return {
      ok: false,
      error: { code: RELAY_DISABLED, message: '远程通道没有开启。' }
    }
  }
  try {
    return { ok: true, data: pairing.listDevices() }
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/**
 * 撤销设备。
 *
 * `PairingService.revokeDevice` 每次都查内存表、且撤销后立即落盘，
 * 所以撤销之后**下一次** `requirePaired` 就会抛 `DEVICE_REVOKED` —— 同一请求内生效。
 * 这里把「不存在的设备」与「撤销成功」区分开：前者返回 `revoked: false`，
 * 让界面能提示「这台设备已经不在了」而不是假装成功。
 */
export function revokePairDevice(
  pairing: PairingService | null,
  deviceId: string
): Result<{ revoked: boolean }> {
  if (!pairing) {
    return {
      ok: false,
      error: { code: RELAY_DISABLED, message: '远程通道没有开启。' }
    }
  }
  if (!deviceId || typeof deviceId !== 'string') {
    return { ok: false, error: { code: 'INVALID_DEVICE_ID', message: '设备标识为空' } }
  }
  try {
    return { ok: true, data: { revoked: pairing.revokeDevice(deviceId) } }
  } catch (err) {
    return { ok: false, error: toResultError(err) }
  }
}

/**
 * 票据剩余毫秒数。界面倒计时用它，**不用自己减** ——
 * 渲染进程与主进程的时钟可能有偏差，而 `exp` 是主进程算的。
 */
export function remainingMs(expiresAt: number, now = Date.now()): number {
  return Math.max(0, expiresAt - now)
}

/** 票据是否已过期。界面据此把「扫这里」换成「已过期，重新生成」。 */
export function isExpired(expiresAt: number, now = Date.now()): boolean {
  return now > expiresAt
}

/** 供界面显示的票据 TTL（秒），避免渲染进程里写死 90 */
export const PAIR_TTL_SECONDS = Math.round(TICKET_TTL_MS / 1000)

// ----------------------------------------------------------------

// ───── src/relay/registry.ts ─────
/**
 * Relay 通道分发表。
 * 没有留下「按通道名调用」的入口。relay 需要这样一个入口，但**不能**为了它把
 */

export type RelayHandler = (payload: unknown) => Promise<unknown>

/** 统一结果形状，与桌面 IPC 的 Result 保持一致，手机端不用区分两套协议 */
export interface RelayResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; hint?: string }
}

const bound = new Map<string, RelayHandler>()

/** 绑定一个通道的实现。重复绑定直接抛错，避免后绑的悄悄覆盖前一个。 */
export function bindChannel(channel: string, handler: RelayHandler): void {
  if (bound.has(channel)) throw new Error(`relay 通道重复绑定：${channel}`)
  bound.set(channel, handler)
}

/** 测试用：清空绑定 */
export function resetBindings(): void {
  bound.clear()
}

/** 当前已绑定的通道（供启动自检：白名单里哪些还没接实现） */
export function boundChannels(): readonly string[] {
  return [...bound.keys()]
}

/**
 * 白名单里有、但当前运行没绑定实现的通道。
 * 启动时打一条日志，避免「白名单写了 18 条、实际只通 3 条」这种沉默的缺口。
 */
export function unboundAllowed(allowed: readonly string[]): readonly string[] {
  return allowed.filter((c) => !bound.has(c))
}

/**
 * 把请求路由到已绑定的处理函数。
 *
 * 约定：处理函数抛错即视为失败，由调用方（server）统一翻译成 RelayResult，
 * 这样审计日志能拿到错误码，而手机端只会看到结构化错误，不会看到堆栈。
 */
export async function dispatch(channel: string, payload: unknown): Promise<RelayResult> {
  const handler = bound.get(channel)
  if (!handler) {
    return {
      ok: false,
      error: { code: 'NOT_BOUND', message: `通道未绑定实现：${channel}` }
    }
  }
  try {
    const data = await handler(payload)
    return { ok: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code ?? 'RELAY_ERROR'
    return { ok: false, error: { code, message } }
  }
}

// ───── src/relay/allowlist.ts ─────
/**
 * Relay 通道白名单。
 *
 * 手机能发指令、能审批、能停止，但不能改模型 Key、不能改数据目录、不能开外部程序。
 * 白名单是这条边界的**唯一**执行点，所以它的三条约束必须同时成立：
 *
 * 1. **默认拒绝。** 不在表里的通道一律 `CHANNEL_DENIED`，而不是「先放行再补」。
 *    新增通道必须显式登记并写明理由 —— 漏登记的表现是功能不可用，
 *    而不是悄悄形成一条没人审过的远程执行入口。
 * 2. **每条都要写清「为什么它可以被手机调用」。** 这个理由会进审计日志，
 *    事后能回答「当时凭什么放它进来」；只写通道名的白名单等于没有评审记录。
 * 3. **只放只读或幂等的通道，写操作必须是「用户意图明确」的那几个**。
 *    改模型配置、改数据目录、开外部程序这类操作必须回到桌面上做：
 *    它们在手机上误触的代价不可逆，而手机又不是一个适合做配置决策的界面。
 */

/** 白名单条目：通道 + 放行理由（理由不是注释摆设，会进审计日志的静态元数据） */
interface AllowEntry {
  readonly channel: string
  readonly why: string
}

/**
 * 逐条白名单。按用途分五组，与蓝图「五个页面」的职责一一对应：
 * 工位（看状态）、对话（发指令）、成员（干预）、审批（决策）、作品（审阅）。
 */
const ENTRIES: readonly AllowEntry[] = [
  // ── 启动与状态：手机冷启动后第一件事就是取全量快照 ──
  { channel: 'app:bootstrap', why: '冷启动取全量状态，工位页首屏依赖它' },

  // ── 会话：只放「读 + 发消息 + 停止」，不放删除/清空/改模型 ──
  { channel: 'session:list', why: '工位页会话列表（只读）' },
  { channel: 'session:load', why: '对话页加载单个会话（只读）' },
  { channel: 'session:rename', why: '会话重命名：可从标题识别，误操作可改回' },

  // ── 对话：发指令与打断，是手机端存在的理由 ──
  { channel: 'chat:send', why: '手机发新指令（核心能力）' },
  { channel: 'chat:cancel', why: '停止正在运行的回合，避免失控消耗' },
  { channel: 'chat:regenerate', why: '重新生成上一条回答（蓝图白名单原文）' },

  // ── 审批与提问：手机端最重要的决策入口 ──
  { channel: 'permission:respond', why: '审批通过/拒绝（蓝图称手机端最重要功能）' },
  { channel: 'question:respond', why: '回答 Agent 的提问，否则任务会一直等' },

  // ── 成员协作：跟盯协作任务，可干预但不重配 ──
  { channel: 'collaboration:projection', why: '成员卡与总目标卡的数据来源（只读）' },
  { channel: 'collaboration:send-message', why: '给某个成员补充要求，继续跑' },
  { channel: 'collaboration:stop-task', why: '停掉某个跑偏的任务' },
  { channel: 'collaboration:retry-task', why: '重试失败任务' },
  { channel: 'collaboration:reactivate', why: '重新激活已结束的成员（蓝图白名单中风险写）' },

  // ── 作品：只读与导出，不做剪辑 ──
  { channel: 'artifact:read', why: '作品页读成品内容（只读）' },
  { channel: 'artifact:versions', why: '版本列表（只读）' },
  { channel: 'artifact:export', why: '导出工程包：蓝图 J3 旅程明确要求' },

  // ── 计划：手机上可以批准/打回计划，但不能改执行模式 ──
  { channel: 'plan:approve', why: '批准执行计划：手机上可做这个决策' },
  { channel: 'plan:reject', why: '打回计划并说明原因，避免桌面空等' },
  { channel: 'plan:revise', why: '要求修改计划（蓝图白名单低风险写）' },
  { channel: 'goal:pause', why: '暂停长任务，避免无人看管时持续消耗' },
  { channel: 'goal:resume', why: '恢复被暂停的任务' },
  { channel: 'goal:stop', why: '终止长任务，停止消耗' },
  { channel: 'session:create', why: '手机上新建会话（蓝图低风险写，无需审批）' },
  { channel: 'session:set-mode', why: '切换会话模式（蓝图低风险写）' },
  { channel: 'session:set-permission-mode', why: '切换权限档位（蓝图列低风险写；每次执行仍需桌面审批）' },
  { channel: 'feature:studio:action', why: '创作台只读子集：payload.type 仅允许 read / preview（蓝图原文限制）' },
  // ── 桌面跳转：暂不放行（见下方说明） ──
  // 蓝图要求 app:open-external「限深链 scheme，只能唤起桌面，不能唤起浏览器」。
  // 但核对了桌面真实实现（src/main/ipc.ts:413）：它只接受 http(s) 并用系统浏览器打开，
  // 全仓也没有 morrow: 深链处理器。
  //
  // 也就是说，现在放行它 = 给手机一个「让桌面开浏览器」的通道，正是蓝图明令禁止的。
  // 所以先不放行，等桌面侧实现 morrow: 深链后再启用；
  // checkPayload() 里的深链校验已经写好了（见 ALLOWED_EXTERNAL_SCHEMES），届时直接生效。
]

/** 允许远程调用的深链 scheme（蓝图：「只能唤起桌面，不能唤起浏览器」） */
const ALLOWED_EXTERNAL_SCHEMES = ['morrow:']

/**
 * 通道级参数校验：部分通道「放行」不等于「参数随便传」。
 */
export function checkPayload(channel: string, payload: unknown): { ok: true } | { ok: false; message: string } {
  const p = (payload ?? {}) as Record<string, unknown>

  if (channel === 'app:open-external') {
    const url = typeof p.url === 'string' ? p.url : ''
    if (!url) return { ok: false, message: 'app:open-external 需要 url' }

    // 控制字符必须先拒绝。
    // 只校验 scheme 前缀会被换行/null 注入绕过：
    //   "morrow://x\nhttps://evil.com"、"morrow://x\0https://evil.com"
    // 这两种输入的前缀都是合法的 morrow:，但下游若按行或按 null 截断解析，
    // 就可能打开后半截那个恶意地址。审查探针实测这两种都被放行过。
    if (/[\u0000-\u001f\u007f]/.test(url)) {
      return { ok: false, message: 'app:open-external 的 url 不允许包含控制字符' }
    }

    const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
    if (!ALLOWED_EXTERNAL_SCHEMES.includes(scheme)) {
      return { ok: false, message: `app:open-external 只允许 ${ALLOWED_EXTERNAL_SCHEMES.join('/')} 深链` }
    }
    // 长度上限：深链带参数也不会超过这个数，超长输入更像攻击而非正常使用
    if (url.length > 2048) {
      return { ok: false, message: 'app:open-external 的 url 过长' }
    }
    return { ok: true }
  }

  if (channel === 'feature:studio:action') {
    const type = typeof p.type === 'string' ? p.type : ''
    if (type !== 'read' && type !== 'preview') {
      return { ok: false, message: '创作台只允许 read / preview 两种 type' }
    }
    return { ok: true }
  }

  return { ok: true }
}

/** 白名单集合，供 O(1) 判定 */
const ALLOWED = new Map<string, string>(ENTRIES.map((e) => [e.channel, e.why]))

/** 非白名单通道统一返回的错误码（蓝图原文要求） */
export const CHANNEL_DENIED = 'CHANNEL_DENIED'

export interface DeniedResult {
  ok: false
  error: { code: typeof CHANNEL_DENIED; message: string }
}

export type AllowDecision = { allowed: true; why: string } | { allowed: false; result: DeniedResult }

/**
 * 判定一个通道是否放行。
 *
 * 注意判定的严格性：
 * - 只做**精确匹配**，不做前缀匹配。`session:*` 这种通配会让新增通道自动获得授权，
 *   等于白名单失效 —— 这正是这类设计最常见的漏洞。
 * - 空/非字符串一律拒绝，不给「undefined 恰好能通过」留缝隙。
 */
export function checkChannel(channel: unknown): AllowDecision {
  if (typeof channel !== 'string' || channel.length === 0) {
    return {
      allowed: false,
      result: {
        ok: false,
        error: { code: CHANNEL_DENIED, message: '通道名必须是非空字符串' }
      }
    }
  }
  const why = ALLOWED.get(channel)
  if (why === undefined) {
    return {
      allowed: false,
      result: {
        ok: false,
        error: { code: CHANNEL_DENIED, message: `非白名单通道：${channel}` }
      }
    }
  }
  return { allowed: true, why }
}

/** 列出全部白名单通道（供设置页展示与测试比对） */
export function allowedChannels(): readonly string[] {
  return ENTRIES.map((e) => e.channel)
}

/** 供测试断言「白名单里没有危险通道」 */
export function allowReason(channel: string): string | undefined {
  return ALLOWED.get(channel)
}

// ───── src/relay/audit.ts ─────
/**
 * Relay 审计日志。
 * - 通道名（白名单内的固定字符串，安全）
 */

export interface AuditEntry {
  /** ISO 时间戳 */
  at: string
  /** IPC 通道名 */
  channel: string
  /** 结果分类 */
  outcome: 'ok' | 'denied' | 'error'
  /** 错误码（outcome 非 ok 时存在） */
  code?: string
  /** 耗时（毫秒） */
  ms: number
  /** 参数结构指纹：键名 → 类型/长度，不含值 */
  shape?: Record<string, string>
}

/**
 * 提取参数的结构指纹，绝不包含值本身。
 *
 * 例：`{ sessionId: 'abc-123', limit: 20 }`
 * → `{ sessionId: 'string(7)', limit: 'number' }`
 */
export function describeShape(payload: unknown, maxKeys = 12): Record<string, string> | undefined {
  if (payload === null || payload === undefined) return undefined
  if (typeof payload !== 'object') return { $self: typeof payload }
  if (Array.isArray(payload)) return { $self: `array(${payload.length})` }

  const out: Record<string, string> = {}
  const keys = Object.keys(payload as Record<string, unknown>)
  for (const key of keys.slice(0, maxKeys)) {
    const v = (payload as Record<string, unknown>)[key]
    if (v === null) out[key] = 'null'
    else if (Array.isArray(v)) out[key] = `array(${v.length})`
    else if (typeof v === 'string') out[key] = `string(${v.length})`
    else if (typeof v === 'object') out[key] = 'object'
    else out[key] = typeof v
  }
  // 键太多时留个计数，说明被截断了（不记多余键名，避免把用户自定义键写进日志）
  if (keys.length > maxKeys) out.$more = `${keys.length - maxKeys}`
  return out
}

/**
 * 追加一条审计记录。
 *
 * 用 `appendFileSync` 而不是异步写：审计的价值在于「即使进程随后崩了，这条记录也在」。
 * 异步写在崩溃场景下会丢，正是最需要它的时候没有。
 */
export function appendAudit(auditPath: string, entry: AuditEntry): void {
  const dir = dirname(auditPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8')
}

/** 读取审计日志（供测试与设置页「查看审计」使用） */
export function readAudit(auditPath: string): AuditEntry[] {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry)
}

/** 默认审计文件位置：<dataDir>/relay/audit.jsonl */
export function auditPathIn(dataDir: string): string {
  return join(dataDir, 'relay', 'audit.jsonl')
}

// ───── src/relay/server.ts ─────
/**
 * Relay 本机 HTTP 服务。
 *
 * 这个服务只跑在回环上、且必须显式开启。把鉴权塞进这里会造成两套并存的鉴权逻辑，
 * 而并存的两套逻辑迟早会有一处先被改、另一处忘了改 —— 于是出现「看起来验了、
 * 其实没验」的路径。所以鉴权只有一处：配对服务（[PairingService]）。
 * 服务本身只负责路由分发、白名单校验与审计留痕。
 */

export interface RelayConfig {
  /** 用户是否在设置里显式开启（默认 false） */
  enabled: boolean
  /** 数据目录，审计日志写在其下的 relay/audit.jsonl */
  dataDir: string
  /** 监听端口，0 = 由系统分配 */
  port?: number
  /** 监听地址，默认回环 */
  host?: string
  /**
   * 配对服务。**生产环境必须传** —— 不传即拒绝启动（见 startRelay 里的
   * PAIRING_REQUIRED 检查），除非显式设 allowUnauthenticated。
   */
  pairing?: PairingService
  /**
   * 是否允许无鉴权模式。默认 false。
   *
   * 只给测试用（B1 的 netstat 验收需要验证「白名单/审计」本身，而不涉及配对）。
   * 做成显式开关而不是「不传 pairing 就自动降级」：
   * 后者会让生产代码忘记传 pairing 时静默裸奔，这正是 B2 初版的真实缺陷。
   */
  allowUnauthenticated?: boolean
}

export interface RelayHandle {
  /** 实际监听端口；未启动时为 null */
  port: number | null
  /** 是否正在监听 */
  listening: boolean
  /** 停止服务 */
  stop: () => Promise<void>
}

/** 请求体上限：白名单通道的 payload 都是小对象，2MB 足够且能挡住误发大文件 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体超过 2MB 上限'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 明确禁止缓存：这些响应里可能含会话内容
    'cache-control': 'no-store'
  })
  res.end(text)
}

/**
 * 启动 relay。**enabled=false 时直接返回未启动的句柄，连 socket 都不会创建。**
 *
 * 这是「开关关闭时端口不监听」的实现方式：不是先启动再拒绝请求，
 * 而是根本不创建服务器。后者能通过 netstat 检查，前者不能 —— 端口仍然在。
 */
export async function startRelay(config: RelayConfig): Promise<RelayHandle> {
  const auditPath = auditPathIn(config.dataDir)
  // 解构出来供请求处理闭包使用
  const pairing = config.pairing

  // ── 强制配对：不传 pairing 就拒绝启动 ──
  // 这是 B2 报告 §7 第 1 条限制的修复。初版让 pairing 可选、不传就退化为
  // 「仅回环无鉴权」，而 applyRelaySettings 恰好没传 —— 生产环境等于没有鉴权。
  //
  // 修法不是简单地 throw（B1 的 netstat 验收需要无鉴权模式），而是要求
  // **显式声明** allowUnauthenticated: true。默认必须传 pairing，
  // 想让通道裸奔必须写出来，写出来就会在 review 时被看到。
  if (!pairing && config.allowUnauthenticated !== true) {
    throw Object.assign(
      new Error('relay 拒绝启动：未提供 pairing。若确实需要无鉴权模式（仅测试），请显式传 allowUnauthenticated: true'),
      { code: 'PAIRING_REQUIRED' }
    )
  }

  if (!config.enabled) {
    return { port: null, listening: false, stop: async () => undefined }
  }

  const unbound = unboundAllowed(allowedChannels())
  if (unbound.length > 0) {
    // 不阻断启动：白名单里允许但暂未接实现的通道会在调用时返回 NOT_BOUND。
    // 但必须留下痕迹，避免「以为通了其实没通」。
    appendAudit(auditPath, {
      at: new Date().toISOString(),
      channel: '$startup',
      outcome: 'ok',
      ms: 0,
      shape: { unbound: `array(${unbound.length})`, bound: `array(${boundChannels().length})` }
    })
  }

  const server: Server = createServer(async (req, res) => {
    const started = Date.now()
    // 路由约定：POST /relay/<通道名>
    const match = /^\/relay\/([^/?]+)$/.exec(req.url ?? '')
    if (!match) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未知路由' } })
      return
    }
    const channel = decodeURIComponent(match[1])

    // ── 第一道：白名单 ──
    const decision = checkChannel(channel)
    if (!decision.allowed) {
      appendAudit(auditPath, {
        at: new Date().toISOString(),
        channel,
        outcome: 'denied',
        code: 'CHANNEL_DENIED',
        ms: Date.now() - started
      })
      sendJson(res, 403, decision.result)
      return
    }

    // ── 第二道：配对与请求签名 ──
    // 顺序刻意放在「读参数」之前：未配对设备不该有机会提交 payload，
    // 也不该通过错误信息差异探测通道行为。
    //
    // 必须验证签名，不能只看设备头：明文头等于没有鉴权，
    // 知道 deviceId 就能冒充（初版实现就是这个问题）。
    if (pairing) {
      const header = (name: string): string => {
        const raw = req.headers[name]
        return typeof raw === 'string' ? raw : ''
      }
      const id = header('x-morrow-device')
      const ts = header('x-morrow-timestamp')
      const sig = header('x-morrow-signature')
      try {
        pairing.verifyRequest(id, channel, ts, sig)
      } catch (err) {
        const code = (err as { code?: string })?.code ?? DEVICE_REVOKED
        appendAudit(auditPath, {
          at: new Date().toISOString(),
          channel,
          outcome: 'denied',
          code,
          ms: Date.now() - started,
          // 记录拒绝原因（不含签名本身），便于排查「是没配对还是签名错」
          shape: { reason: `string(${String((err as Error).message).length})` }
        })
        sendJson(res, 403, { ok: false, error: { code, message: (err as Error).message } })
        return
      }
    }

    // ── 第三道：读取参数（大小与 JSON 合法性） ──
    let payload: unknown
    try {
      payload = await readBody(req)
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'BAD_REQUEST'
      appendAudit(auditPath, {
        at: new Date().toISOString(),
        channel,
        outcome: 'error',
        code,
        ms: Date.now() - started
      })
      sendJson(res, 400, { ok: false, error: { code, message: (err as Error).message } })
      return
    }

    // ── 第四道：通道级参数校验 ──
    // 「放行通道」不等于「参数随便传」：open-external 限 scheme、
    // 创作台限 read/preview。这一步在分发之前，避免把危险参数传进 handler。
    const payloadCheck = checkPayload(channel, payload)
    if (!payloadCheck.ok) {
      appendAudit(auditPath, {
        at: new Date().toISOString(),
        channel,
        outcome: 'denied',
        code: 'PAYLOAD_DENIED',
        ms: Date.now() - started
      })
      sendJson(res, 403, { ok: false, error: { code: 'PAYLOAD_DENIED', message: payloadCheck.message } })
      return
    }

    // ── 第五道：分发 ──
    const result = await dispatch(channel, payload)
    appendAudit(auditPath, {
      at: new Date().toISOString(),
      channel,
      outcome: result.ok ? 'ok' : 'error',
      ...(result.error ? { code: result.error.code } : {}),
      ms: Date.now() - started,
      shape: describeShape(payload)
    })
    sendJson(res, result.ok ? 200 : 500, result)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  return {
    port: address.port,
    listening: true,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

// ----------------------------------------------------------------

/**
 * Relay 生命周期：把「设置里的开关」接到「真实运行的服务」上。
 * 三件事必须一起成立，少一件就是假实现：
 * 1. **关掉开关，端口必须真的消失。** 只改设置不改服务，用户看到「已关闭」
 *    而端口还开着 —— 那是最危险的假象：他以为自己安全了。
 * 2. **打开开关，白名单通道必须真的能通。** 只起端口不接线，界面显示已开启
 *    但每个请求都失败，用户会去怀疑网络/手机，而不是这个开关。
 * 3. **运行中改开关立即生效，不需要重启应用。** 需要重启才生效的开关，
 *    在用户心里等于「这个开关是坏的」，他会去找别的方式绕过它。
 */

let handle: RelayHandle | null = null
/** LAN 直连通道（Tier 1）。未启用时为 null —— 关掉开关就不该有监听端口 */
let directChannel: DirectChannel | null = null
let channelSelector: ChannelSelector | null = null
let channelPoller: ChannelPoller | null = null
/**
 * 当前运行的配对服务。
 * relay 关闭时置 null。此时调用方必须报「远程通道没开」，
 * 而不是报「配对失败」—— 前者是用户还没打开开关，后者会让人以为配对码坏了。
 */
let pairing: PairingService | null = null

/**
 * 桌面运行时事件 → 当前 LAN 通道。
 *
 * 注册在模块级一次性完成：`directChannel` 什么时候起来都行，事件在
 * 没有通道时静默丢弃（用户没开远程通道，本来就不该有手机连接）。
 * 用函数而不是值，避免启动顺序把 publisher 固定成 null。
 */
setPhonePublisher((event) => {
  directChannel?.broadcast('event', event, { runId: event.runId, sessionId: event.sessionId })
})

/**
 * 创作台任务事件 → 当前 LAN 通道。
 *
 * 与上面的运行时事件**分开注册**，因为两者的归属语义不同：
 * 运行时事件挂在 `runId/sessionId` 上，创作台任务挂在 `projectId` 上。
 * 硬塞进同一个信封会让手机侧分不清「这是会话的事件」还是「这是作品的事件」，
 * 而 Android 的状态机正是按 sessionId 索引的。
 *
 * 信封约定：`runId` 留空、`sessionId` 承载 **projectId** —— 手机据此把任务
 * 归到对应作品；`type` 固定为 `studio_job`，与 28 类 RuntimeEvent 并列而不冲突。
 */
export function publishStudioJobEvent(payload: StudioJobPhoneEvent): void {
  publishPhoneEvent({
    type: STUDIO_JOB_EVENT,
    runId: '',
    sessionId: payload.projectId,
    at: payload.at,
    job: payload
  })
}

/**
 * 取当前配对服务。未启用时返回 null。
 *
 * 为什么不在这里自动启动：`relayEnabled` 是用户的开关，
 * 「点一下生成配对码」不该悄悄打开它 —— 那等于绕过用户意图去开一个监听端口。
 */
export function currentPairing(): PairingService | null {
  return pairing
}

/**
 * 订阅设备表变更（配对完成 / 撤销）。返回取消订阅函数。
 *
 * 回调**带着最新的设备列表**：ipc 层拿到就能直接推给渲染进程，
 * 不必再回查一次 pairing —— 回查会拿到「此刻」的表，而用户要看的是
 * 「刚刚那一次变更之后」的表（两次之间可能又撤销了一台）。
 */
let pairDevicesListener: ((devices: PairDeviceView[]) => void) | null = null

export function onPairDevicesChanged(listener: ((devices: PairDeviceView[]) => void) | null): void {
  pairDevicesListener = listener
}

/** 由 PairingService 在设备表变更（且已落盘）后调用 */
function emitPairDevicesChanged(devices: PairDeviceView[]): void {
  const listener = pairDevicesListener
  if (!listener) return
  try {
    listener(devices)
  } catch (err) {
    // 界面刷新失败不影响配对结果：设备表已经写入内存与磁盘。
    log.warn('pair devices listener failed', { error: (err as Error).message })
  }
}

/** 绑定本机能力。由 index.ts 在 ready 后调用，注入真实的桌面 handler。 */
export function bindDesktopChannel(channel: string, handler: (payload: unknown) => Promise<unknown>): void {
  const decision = checkChannel(channel)
  if (!decision.allowed) {
    // 不允许把不在白名单里的通道接进来：否则「白名单」就成了摆设，
    // 接入方绕过 allowlist 直接调用即可。
    throw new Error(`relay 拒绝绑定非白名单通道：${channel}`)
  }
  bindChannel(channel, handler)
}

/** 当前 relay 状态（设置页展示用） */
export function relayStatus(): { listening: boolean; port: number | null; channels: readonly string[] } {
  return {
    listening: handle?.listening ?? false,
    port: handle?.port ?? null,
    channels: allowedChannels()
  }
}

/**
 * 按当前设置启动/停止 relay。可重复调用（改设置后重新应用）。
 *
 * 这里刻意**不做**「如果已启动就跳过」的优化：用户可能改了端口，
 * 直接重启一遍比 diff 判断更不容易出错，代价只是几毫秒。
 */
export async function applyRelaySettings(): Promise<{ listening: boolean; port: number | null }> {
  // 先全停：端口、通道、轮询器一起收，避免旧轮询器还在探测已停止的通道
  await stopLanStack()
  if (handle) {
    await handle.stop()
    handle = null
  }
  // 配对服务也一起清掉：开关关掉之后，设置页「生成配对码」必须报「没开启」，
  // 而不是对着一个已经停止的服务签发票据。
  pairing = null

  const settings = getSettingsStore().get()
  if (!settings.relayEnabled) {
    log.info('relay disabled by settings')
    return { listening: false, port: null }
  }

  const dataDir = app.getPath('userData')

  // 长期密钥：从磁盘还原（safeStorage 加密），重启后桌面公钥不变，
  // 已配对设备的会话密钥继续有效。
  const key = loadOrCreateKey({ dataDir, safeStorage })
  if (!key.restored) {
    log.info('relay desktop key created (devices will need pairing)', { available: safeStorage.isEncryptionAvailable() })
  }

  // 配对服务：本轮起**必须**传入，否则 startRelay 会拒绝启动。
  // 这堵住了 B2 初版「忘了传就静默无鉴权」的缺陷。
  //
  // 设备表持久化：让重启后的手机免扫码直接重连。
  // 只持久化桌面密钥是不够的 —— 设备表在内存里的话，
  // 重启后 requirePaired() 会抛 DEVICE_REVOKED，用户每天都要重配。
  const deviceStore = {
    load: () => loadDevices({ dataDir, safeStorage }),
    save: (devices: Parameters<typeof saveDevices>[1]) => void saveDevices({ dataDir, safeStorage }, devices)
  }
  const service = new PairingService({
    secret: pairingSecret(key),
    privateKey: key.privateKey,
    devices: deviceStore,
    // 手机配对完成 / 设备被撤销 → 立刻通知界面刷新列表。
    // 注意这里是模块级的转发函数，而不是 ipc 的监听器本身：
    // ipc 在应用启动时注册一次，而 PairingService 会随开关反复重建。
    onDevicesChanged: emitPairDevicesChanged
  })
  // 发布到模块级：IPC 的「生成配对码 / 列出设备 / 撤销」要用**这个**实例。
  pairing = service
  const restored = service.listDevices().length
  if (restored > 0) log.info('relay devices restored', { count: restored })

  // 启动自检（白名单 vs 已绑定实现的缺口）由 startRelay 内部统一记录，
  // 这里不重复写审计，否则每次开关键切换都会多出一条重复记录。
  handle = await startRelay({
    enabled: true,
    dataDir,
    port: settings.relayPort,
    pairing: service
  })
  log.info('relay listening', { port: handle.port, loopbackOnly: true })

  // ── 局域网直连（Tier 1）──
  // 开关打开才起监听：与 relay 同一个原则，关掉时端口必须不存在。
  // 失败不阻断启动 —— 证书生成失败或端口被占时，手机仍可走中继，
  // 只是 chip 显示「中继」。这比「整条 relay 起不来」好得多。
  await startLanStack(service, dataDir)

  return { listening: handle.listening, port: handle.port }
}

/**
 * 起局域网直连 + 通道选择器 + 轮询器。
 */
async function startLanStack(service: PairingService, dataDir: string): Promise<void> {
  try {
    const tls = await loadOrCreateTls({ dataDir, safeStorage })
    // 把证书指纹交给配对服务：之后签发的每一张票据都会带上它。
    // 手机拿它做证书固定 —— 自签证书没有可信链，这是唯一正确的机制。
    service.setTlsFingerprint(tls.fingerprint)
    const direct = new DirectChannel({
      pairing: service,
      tls,
      // 首连或补漏缓冲不够时，服务端主动下发一份加密快照。
      // 手机按 `snapshot` 事件一次性对齐状态，不必再发一次请求。
      snapshot: () => buildPhoneSnapshot(),
      // 所有上行都过白名单与参数校验（phone-invoke.ts），再转给 ipc 注册的动作。
      invoke: (request) => dispatchPhoneInvoke(request)
    })
    await direct.connect()
    log.info('lan direct listening', { port: direct.port(), fingerprint: tls.fingerprint.slice(0, 12) })

    // 中继层：本轮只有本机 HTTP 服务（127.0.0.1），还不能真正承载手机流量。
    // probe 如实反映「中继服务是否在跑」，不做「永远可用」的假承诺。
    const relayTier: TierChannel = {
      tier: 'relay',
      probe: async () => handle?.listening === true,
      connect: async () => {},
      disconnect: async () => {}
    }

    const selector = new ChannelSelector({ direct, relay: relayTier })
    // 立刻探测一次，让界面打开时就有正确的 chip（而不是空白 1 秒）
    await selector.start()

    const poller = new ChannelPoller({
      selector,
      intervalMs: 1_000,
      onPoll: (info) => {
        if (info.error) log.warn('channel poll failed', { error: info.error })
      }
    })
    poller.start()

    directChannel = direct
    channelSelector = selector
    channelPoller = poller
  } catch (err) {
    // 局域网起不来不阻断 relay：用户仍可通过中继访问
    log.warn('lan direct failed to start; falling back to relay only', { error: (err as Error).message })
    // 清掉指纹：证书都没起来，票据带上一个「上一轮的指纹」会让手机
    // 记下一个连不上的值。宁可明确没有（手机拒绝配对并说明原因）。
    service.setTlsFingerprint(null)
    directChannel = null
    channelSelector = null
    channelPoller = null
  }
}

/** 停掉局域网这一套（轮询器 → 选择器 → 通道，顺序不能反） */
async function stopLanStack(): Promise<void> {
  // 先停轮询：否则它会在通道已经关闭之后继续 probe，日志出现幽灵失败
  if (channelPoller) {
    channelPoller.stop()
    channelPoller = null
  }
  if (channelSelector) {
    channelSelector = null
  }
  if (directChannel) {
    await directChannel.disconnect()
    directChannel = null
  }
}

/** 当前通道视图（设置页 / 状态栏展示用）。未启用时为 null */
export function channelView(): ChannelView | null {
  return channelSelector ? channelSelector.view() : null
}

/** 局域网直连端口（诊断用）。未启用时为 null */
export function lanPort(): number | null {
  return directChannel?.port() ?? null
}

/**
 * 虚拟网卡名（Hyper-V / VirtualBox / VMware / WSL / VPN / 抓包）。
 *
 * 这些网卡通常也有 `192.168.*` 地址，但手机根本路由不到 ——
 * 本机实测：`vEthernet (Default Switch)` 是 192.168.48.1，
 * 真正的 WLAN 是 192.168.1.5。只按网段排序会选中前者，
 * 结果就是「配对成功、连接超时」。
 */
const VIRTUAL_ADAPTER = /vEthernet|Virtual|VMware|VirtualBox|Hyper-?V|WSL|Docker|Tailscale|ZeroTier|Bluetooth|Npcap|VPN/i

/** 物理接入网卡名（中英文系统都覆盖），优先级高于未知网卡 */
const PHYSICAL_ADAPTER = /Wi-?Fi|WLAN|Wireless|Ethernet|以太网|无线|本地连接/i

/**
 * 本机可被同一局域网访问的 IPv4。
 *
 * 评分顺序：非虚拟网卡 > 明确是物理网卡 > 私网网段更常见
 * （`192.168.*` → `10.*` → `172.16–31.*` → 其它）。
 * 回环与 169.254.*（DHCP 失败）一律排除 —— 它们不可能被手机访问到。
 * 只剩虚拟网卡时仍然返回它：有地址总比让用户对着一张没有地址的票强，
 * 但评分保证在有两块网卡时优先物理那块。
 */
export function firstLanIpv4(): string | null {
  const candidates: { ip: string; score: number }[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (net.address.startsWith('169.254.')) continue
      const rank = net.address.startsWith('192.168.')
        ? 0
        : net.address.startsWith('10.')
          ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(net.address)
            ? 2
            : 3
      const virtual = VIRTUAL_ADAPTER.test(name) ? 1 : 0
      const unnamed = PHYSICAL_ADAPTER.test(name) ? 0 : 1
      candidates.push({ ip: net.address, score: virtual * 100 + unnamed * 10 + rank })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return candidates[0]?.ip ?? null
}

/**
 * 配对票据里的连接地址（`host:port`）。
 * 所以桌面**必须**在签发时自己补，而不是指望界面记得传 ——
 */
export function lanHint(): string | null {
  const port = lanPort()
  if (!port) return null
  const host = firstLanIpv4()
  return host ? `${host}:${port}` : null
}

/**
 * 配对 HMAC 密钥：从长期密钥派生，不单独落盘。
 *
 * 为什么不另存一份：多一个需要保护的秘密，就多一个泄露面。
 * 用长期私钥做 HKDF 派生，随密钥一起被 safeStorage 保护，
 * 而且重启后派生结果不变 —— 已有的配对会话签名仍然可用。
 */
function pairingSecret(key: LoadedKey): Buffer {
  return Buffer.from(
    createHash('sha256').update(`morrow-relay-pairing:${key.privateKey}`).digest()
  )
}

/** 关闭并清空（应用退出时调用） */
export async function shutdownRelay(): Promise<void> {
  await stopLanStack()
  if (handle) {
    await handle.stop()
    handle = null
  }
  pairing = null
  resetBindings()
}

/** 测试用：重置模块状态 */
export async function resetRelayForTests(): Promise<void> {
  await shutdownRelay()
}

