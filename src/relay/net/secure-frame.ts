import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

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
