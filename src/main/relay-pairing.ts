import { createECDH, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PairDeviceView, PairIssueResult, Result } from '../shared/types'
import type { SafeStorageLike } from './relay-crypto'

export type { SafeStorageLike }

// ───── src/relay/pairing.ts ─────
/**
 * 配对与密钥协商。
 *
 * 蓝图 §5 的协议原文：
 *
 * ```
 * desktop: nonce = random(16)
 *          ticket = { deviceId, pubKey, nonce, exp: now+90s, relayHint }
 *          qr     = base32(ticket)   ← 只承载票据，不承载密钥
 * phone  : verify(qr) → 建立 WSS → 发送 { phonePubKey, nonceEcho }
 * desktop: 校验 nonceEcho === nonce 且未过期 → 显示六位码供人工比对
 * phone  : 用户比对六位码一致 → 确认
 * desktop: 生成 sessionKey = ECDH(pubKeys) → 写入配对设备表
 *          // 之后所有信道用 sessionKey 加密，票据立即作废
 * ```
 *
 * 这段协议里有两个容易被做假的点，本文件刻意用**结构**而不是注释来防止：
 *
 * **一、票据不能可重放。** 只在 `exp` 上做文章是不够的：攻击者偷到票据后，
 * 90 秒内可以反复使用。所以每个票据带一个**单调计数**（`usedTickets`），
 * 用过一次立即作废 —— 无论有没有过期、无论 nonce 对不对。
 *
 * **二、六位码必须是「桌面生成、人工比对」。** 如果六位码是手机算的再发给桌面，
 * 那它只是又一个可被中间人转发的值，挡不住肩窥二维码。这里的做法是：
 * 六位码由桌面从**双方的公钥**派生（HMAC），手机本地独立算出同一个值显示给用户比对。
 * 中间人换了公钥，两端的六位码就会不同 —— 这才是它起作用的原因。
 *
 * 另外三条硬约束：
 * - 票据里**绝不**放密钥（蓝图原文）。放进去就等于把二维码当密钥传输通道。
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
const NONCE_BYTES = 16

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
   *
   * 手机必须拿到它才能算 ECDH：`ECDH(手机私钥, 桌面公钥)`。
   * 缺了它，手机会算出 `ECDH(手机私钥, 手机公钥)` 这种无意义的值，
   * 或者只能等桌面在某个后续帧里补发 —— 但那会让「扫码即可离线算出
   * sessionKey」变成「必须先连上中继」，与蓝图「两端现场协商」不符。
   *
   * 公钥不是密钥，可以进二维码（与 pubKey 同理）。
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
   *
   * 手机连桌面时走 WSS，而桌面用的是自签证书 —— 自签证书没有可信链，
   * 链验证必然失败。唯一正确的机制是**证书固定**：手机记住这一张证书的
   * 指纹，每次握手比对。指纹从哪来？只能从配对时拿。
   *
   * 所以它是票据的一部分：配对即「把这台电脑的公钥和证书都记下来」。
   * 格式与 `tls.ts` 的 `certFingerprint()` 一致：`base64url(sha256(DER))`，无填充。
   *
   * 为什么是可选：手机侧先把解析做出来，桌面侧补字段时不至于两端同时改、
   * 同时坏。但**手机侧缺它时必须拒绝完成配对**，不能存一份没有指纹的凭据
   * （那份凭据 `load()` 会判 CORRUPT，用户看到的是「配对失效」而不是原因）。
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
  private readonly secret: Buffer
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

  constructor(options: PairingStoreOptions) {
    if (!Buffer.isBuffer(options.secret) || options.secret.length < 16) {
      throw new Error('配对 HMAC 密钥至少 16 字节')
    }
    this.secret = options.secret
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
   *
   * 由 `startLanStack` 在 `loadOrCreateTls()` 之后调用。为什么不是构造参数：
   * 证书载入是异步的（要读文件 + 可能生成），而 PairingService 在它之前就构造了；
   * 而且局域网起不来时根本没有指纹 —— 那就该让票据不带指纹、让手机明确拒绝，
   * 而不是拿一个编出来的值。
   *
   * 传空串等于清掉：`loadOrCreateTls` 失败时的降级路径会走到这里。
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

    const nonce = randomBytes(NONCE_BYTES).toString('hex')
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
   *
   * 为什么需要它：已用票据为了可取证而被保留（见 completePairing），
   * 如果不清理，长时间运行会无限堆积。这里按过期时间清扫，
   * 保留窗口与票据 TTL 一致 —— 超过 TTL 的票据已经不可能再产生有用的判定结果。
   *
   * 只在成功路径上调用（而不是每次查询前）：如果在判定之前清扫，
   * 过期票据会先被删掉，随后报 TICKET_INVALID，就丢掉了 EXPIRED 这个有用信号。
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
    return device
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
   *
   * 为什么必须有这个：只用 `x-morrow-device: phone-1` 这样的明文头是**没有鉴权**的，
   * 任何人知道 deviceId 就能冒充 —— 而这条通道能发指令、批权限。
   * 初版实现就犯了这个错，探针一跑就露了出来（见 B2 报告 §11）。
   *
   * 方案：手机用 ECDH 协商出的 sessionKey 对 (deviceId, 时间戳, 通道名) 做 HMAC-SHA256，
   * 服务端用同一把 key 复算比对。要点：
   *
   * - **把通道名纳入签名**：否则攻击者可以拿「读会话列表」的签名去调「批权限」。
   * - **把时间戳纳入签名并限制时窗**：否则签名可被无限期重放。
   *   时窗取 60 秒 —— 比票据 TTL 短，允许客户端时钟有几秒漂移。
   * - **常量时间比较**：避免通过响应时间逐字节猜签名。
   *
   * 注意这是「传输层之前的最小鉴权」：B3 的 WSS 会用 sessionKey 加密整个信道，
   * 那时签名仍然保留，作为应用层的二次校验（纵深防御）。
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
    if (existed) this.persist()
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
 *
 * 为什么必须有：B2 的 `PairingService` 每次构造都 `generateKeys()`，
 * 密钥只活在进程内存里。Morrow 重启后桌面公钥变了，
 * 之前所有手机算出的 ECDH 共享秘密全部失效 —— 用户每次开电脑都要重新扫码配对。
 * 这不是「体验不佳」，是功能不可用：手机端会一直连不上。
 *
 * 设计上的三个约束：
 *
 * **一、私钥落盘必须加密。** 用 Electron 的 `safeStorage`（Windows 走 DPAPI，
 * 绑定当前用户账户）。拿到文件也解不开 —— 明文私钥落盘等于把「曾配对过的所有手机」
 * 的会话密钥交给任何能读文件的进程。
 *
 * **二、safeStorage 不可用时不能明文降级。** 有些 Linux 环境没有 keyring。
 * 这时正确的做法是**拒绝持久化**（返回 null，让上层退化为「本次运行内有效」），
 * 而不是偷偷写明文 —— 那会在用户不知情的情况下降低安全性。
 *
 * **三、写入用临时文件 + 重命名。** 直接写目标文件时若进程中途崩溃，
 * 会留下半个文件，下次启动解析失败 → 又回到「重启要重配」。
 * rename 在同一分区上是原子的。
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
 *
 * 为什么必须有：B3 第一批只让**桌面公钥**跨重启不变，设备表仍在内存里。
 * 探针实测：配对 1 台 → 重启 → `listDevices()` 返回 0 台，`requirePaired()` 抛
 * `DEVICE_REVOKED`。用户的观感就是「每天开电脑都要重新扫码」——
 * 这不是体验问题，是功能不可用。
 *
 * 三个安全约束：
 *
 * **一、必须加密，不能明文落盘。** 设备表里存着每台手机的 `sessionKey`，
 * 它足以伪造该设备的全部请求签名（见 pairing.ts 的 verifyRequest）。
 * 明文落盘等于把「冒充任意已配对手机」的能力交给任何能读文件的进程。
 * 用 safeStorage（Windows DPAPI，绑定当前用户账户）。
 *
 * **二、`safeStorage` 不可用时不降级为明文。** 读不出就当作空表，
 * 让用户重新配对 —— 宁可麻烦，也不能悄悄降低安全性。
 *
 * **三、撤销必须立即落盘。** 这是本文件里最容易漏、后果最严重的一条：
 * 如果 `revokeDevice()` 只删内存不写盘，应用重启后那台被撤销的设备
 * 会从文件里「复活」，等于撤销从来没发生过。用户的直觉是「我踢掉它了」，
 * 而系统在下次启动时又把它请回来 —— 这是真实的安全漏洞，不是体验瑕疵。
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
 * ## 为什么单独一层，而不是直接写在 IPC handler 里
 *
 * `ipcMain.handle` 的回调必须拿 `electron` 的环境，单元测试里既起不来也断言不了。
 * 把逻辑抽到这里之后，测试可以对着**真实的 PairingService** 跑，
 * IPC 那层只剩「转发 + 把异常翻成 Result」，不再承载任何判断。
 *
 * ## 为什么每个函数都接受 `PairingService | null`
 *
 * 远程通道默认关闭（`relayEnabled: false`）。关着的时候，配对服务**不存在** ——
 * 这时候「生成配对码」必须明确报错，而不是：
 * - 临时 new 一个（会生成新的桌面密钥，所有已配对手机立即失效）；
 * - 返回一个空票据（用户扫了必然失败，且提示指向别处）。
 *
 * 所以错误码单列一个 `RELAY_DISABLED`，界面据此提示「先打开远程通道」。
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
 *
 * 调用方要给 `phonePubKey` —— 票据里的 `pubKey` 必须**是手机自己的公钥**
 * （手机侧会校验归属，见 `EcdhPairing` 的 §4.5）。所以桌面不能凭空生成一张票，
 * 必须先拿到手机侧的配对请求。
 *
 * 这也是当前「手动粘贴」方案的真实代价：没有相机扫码时，
 * 手机侧要把 deviceId + 公钥给到桌面一次。报告里如实记着这一点。
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
        hasFingerprint: typeof ticket.fingerprint === 'string' && ticket.fingerprint.length > 0
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
