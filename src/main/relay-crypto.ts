import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ───── src/relay/net/envelope.ts ─────
/**
 * 传输信封（Envelope）。
 *
 * 蓝图 §5 原文：
 *
 * ```
 * { v: 1, kind: "event" | "invoke" | "result" | "ack",
 *   seq: 128,              // 单调递增，断线重连靠它补漏
 *   runId: "run_...", sessionId: "ses_...",
 *   at: 1763456789012,     // 服务端时间，手机不信任本地时钟
 *   body: { ... }          // 直接是 RuntimeEvent 或 IPC 响应
 * }
 * ```
 *
 * 三条不显然的约束，都在这里用类型/校验表达而不是靠注释：
 *
 * **一、`at` 是服务端时间。** 手机时钟不可信（用户手动改时间、时区错乱、
 * 设备休眠后漂移）。所有时间判断（排序、超时、去重）都用服务端的 `at`，
 * 客户端的本地时间不参与。
 *
 * **二、`seq` 由服务端分配，客户端只读。** 如果让客户端定 seq，
 * 重连补漏就失去意义 —— 客户端可以随便报一个 lastSeq 把服务端带偏。
 *
 * **三、`v` 必须严格校验。** 协议版本不对时应该明确失败，
 * 而不是「尽力解析」——那会让新旧版本混跑时出现难以复现的错乱。
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
export const SEQ_OUT_OF_ORDER = 'SEQ_OUT_OF_ORDER'

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
 *
 * 只做一件事：从 1 开始单调递增。看起来简单，但它是「不重不漏」的基础 ——
 * 一旦这里出现重复或跳号，补漏逻辑就会误判。
 *
 * **不做持久化**：seq 在连接生命周期内有效，重连后由服务端继续递增
 * （手机靠 lastSeq 告诉服务端「我收到哪了」）。进程重启后从 1 重新开始，
 * 手机通过握手阶段拿到的 snapshot 重新对齐 —— 这是刻意的，
 * 因为跨进程持久化 seq 会让「旧连接的迟到包」与新连接混淆。
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
 *
 * 返回：
 * - `{ ok: true }` 连续，可以处理
 * - `{ ok: false, gap: n }` 跳号，缺了 n 条（n = 期望值 - 实际值）
 * - `{ ok: false, duplicate: true }` 重复（同一条又收到一次）
 *
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
 *
 * ## 为什么 TLS 还不够
 *
 * 蓝图在 Tier 2 上写了一句很硬的话：
 *
 * > 中继只转发密文，无法解密内容——这一点必须在设置页明确写给用户看，
 * > 否则「把工作区推给第三方服务器」会直接劝退。
 *
 * TLS 只保证「到中继那一段是加密的」。中继是 TLS 的**终点**，
 * 它在明文状态下拿到全部内容再转发 —— 它当然能解密。
 * 要兑现「中继也无法解密」，必须在 TLS 里面再套一层端到端加密，
 * 密钥只有手机与桌面知道（`sessionKey`，B2 用 ECDH 协商）。
 *
 * 在此之前 `requireCiphertext()` 只是一个**守门员**：它检查「你发的东西看起来
 * 像不像密文」，而不是「你有没有真的加密」。守门员能被 base64 绕过（已修），
 * 但根本上它不产生加密 —— 这个文件才产生。
 *
 * ## 四个安全决定（每个都有对应的攻击场景）
 *
 * **一、双向密钥分离。** phone→desktop 与 desktop→phone 用不同密钥。
 * 若共用一把钥匙，攻击者可以把手机发来的帧**原样反射**回去，
 * 桌面会把它当成一条合法指令执行 —— 这是经典的反射攻击。
 *
 * **二、每连接一个 salt。** 重连时 `SecureChannel` 是新实例、计数器从 0 开始。
 * 若密钥不变，新连接的 counter=0 会与旧连接的 counter=0 撞上同一个 nonce ——
 * GCM 下**重用 nonce 会直接泄露明文异或值**，是密码学级别的灾难。
 * 所以服务端在 welcome 里下发 16 字节随机 salt，参与密钥派生。
 *
 * **三、AAD 绑定方向 + deviceId + salt + 计数。** GCM 认证 AAD 但不加密它。
 * 把这些放进 AAD：篡改方向（把手机帧当桌面帧）、跨设备挪用（A 设备的密文
 * 挂到 B 设备名下）、改计数（重排），都会导致认证失败。
 *
 * **四、计数器严格单调 + 12 字节 nonce。** nonce 由计数器唯一确定，
 * 不存在随机碰撞可能。接收侧记录「已见最大计数」，小于等于它的一律拒绝 ——
 * 这就是防重放。WebSocket 保证顺序与不重发，所以严格单调不会误伤正常流量。
 *
 * ## 帧格式
 *
 * ```json
 * { "n": "<counter>", "c": "<base64url 密文+tag>" }
 * ```
 *
 * nonce 与 AAD 都由 counter 可重建，所以线上不必传 nonce 本体 ——
 * 少一个字段，也少一处「发送方与接收方对 nonce 理解不一致」的可能。
 */

export const FRAME_TAMPERED = 'FRAME_TAMPERED'
export const FRAME_REPLAYED = 'FRAME_REPLAYED'
export const FRAME_MALFORMED = 'FRAME_MALFORMED'
export const FRAME_WRONG_DIRECTION = 'FRAME_WRONG_DIRECTION'

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
  private readonly deviceId: string
  private readonly salt: Buffer

  constructor(options: SecureChannelOptions) {
    const ikm = Buffer.from(options.sessionKey, 'base64')
    if (ikm.length === 0) throw new FrameError(FRAME_MALFORMED, 'sessionKey 不能为空')

    this.deviceId = options.deviceId
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
 *
 * 为什么需要它：`DirectChannel` 要起一个 `wss://` 服务，就必须有证书。
 * 如果不提供生成/持久化的入口，调用方只能自己造一个 —— 那就等于
 * 「DirectChannel 只能在测试里用」，是半成品。
 *
 * 三个设计约束：
 *
 * **一、证书必须持久化，不能每次启动重新生成。**
 * 手机在配对时记住桌面证书的指纹（见 `certFingerprint()`），
 * 每次重启换一张新证书 = 每台手机都要重新确认指纹 = 回到「天天重新配对」。
 *
 * **二、私钥加密落盘，证书本身明文。**
 * 证书是公开信息（握手时明文发给对方），加密它没有意义；
 * 私钥必须保护 —— 拿到私钥就能冒充桌面服务端，把手机的请求全部收走。
 * 用与 keystore 同一套 `safeStorage`。
 *
 * **三、`safeStorage` 不可用时不生成落盘证书。**
 * 无法保护私钥时，宁可用「本次运行内有效」的临时证书（手机需要重新确认指纹），
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
