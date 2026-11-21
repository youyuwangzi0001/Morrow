/**
 * 远程通道域（`src/main/relay.ts` + `relay-channel.ts`）的用例：
 * 信封与 AES-GCM 帧、配对票据与设备存储、中继白名单与审计、通道选择与真 WSS 直连。
 *
 * 四组共用同一份「桌面端加密原语」：改 AAD 或计数语义会同时影响帧与配对，
 * 放在一个文件里才能一眼看出哪一组先失效。带 electron 替身的两组
 * （`relay-lifecycle`、`relay-settings`）仍单独保留 —— 它们要 mock 掉 Electron
 * 本身，与这里的真实 Node 环境不能共存。
 */
import WebSocket from 'ws'
import { randomBytes, createECDH } from 'node:crypto'
import { describe, expect, it, afterAll, beforeAll, afterEach, beforeEach, vi } from 'vitest'
import { FRAME_MALFORMED, FRAME_REPLAYED, FRAME_TAMPERED, FrameError, SecureChannel, newConnectionSalt, sameBytes, ENVELOPE_VERSION, loadOrCreateTls, type TlsMaterial, PairingService, CODE_ATTEMPTS_EXCEEDED, CODE_MISMATCH, DEVICE_REVOKED, MAX_CODE_ATTEMPTS, PairingError, TICKET_EXPIRED, TICKET_INVALID, TICKET_TTL_MS, TICKET_USED, derivePairingCode, RELAY_DISABLED, PAIR_TTL_SECONDS, isExpired, issuePairTicket, listPairDevices, remainingMs, revokePairDevice, clearDevices, devicesPathIn, loadDevices, saveDevices, type SafeStorageLike, type PairedDevice, deleteKey, keyPathIn, loadOrCreateKey, startRelay, allowedChannels, allowReason, checkChannel, checkPayload, CHANNEL_DENIED, appendAudit, auditPathIn, describeShape, readAudit, bindChannel, dispatch, resetBindings, unboundAllowed, type RelayHandle, makeEnvelope, SeqAllocator, type Envelope, ENVELOPE_INVALID, EnvelopeError, checkSeq, isValidEnvelope, requireEnvelope } from '../../src/main/relay'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOSE_REPLAYED, CLOSE_TAMPERED, DirectChannel, ChannelSelector, DEGRADE_WINDOW_MS, TIER_LABELS, envelopeMeta, looksLikeCiphertext, requireCiphertext, type TierChannel, CLOSE_UNAUTHORIZED, DEFAULT_BUFFER_CAPACITY, ReconnectTracker, ReplayBuffer, SNAPSHOT_REQUIRED, type ChannelView, type Tier, ChannelPoller } from '../../src/main/relay-channel'
import { createServer } from 'node:net'

// ── 原 relay-crypto.test.ts ──

describe('应用层加密帧', () => {
  const SESSION_KEY = Buffer.alloc(32, 0x7f).toString('base64')

  function newChannel(deviceId = 'phone-1', sessionKey = SESSION_KEY, salt = newConnectionSalt()): SecureChannel {
    return new SecureChannel({ sessionKey, connectionSalt: salt, deviceId })
  }

  /** 期望抛出指定 code 的 FrameError */
  function expectCode(fn: () => unknown, code: string): void {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(FrameError)
      expect((err as FrameError).code).toBe(code)
      return
    }
    throw new Error(`应当抛出 ${code}，但没有抛错`)
  }

  // ───────────────── 基本往返 ─────────────────

  describe('基本往返', () => {
    it('@core:relay 同一 salt、同一设备：加解密得到原文', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('phone-1', SESSION_KEY, salt)
      const receiver = newChannel('phone-1', SESSION_KEY, salt)

      const frame = sender.seal('phone-to-desktop', JSON.stringify({ kind: 'hello', n: 1 }))
      expect(receiver.open('phone-to-desktop', frame).toString('utf8')).toBe('{"kind":"hello","n":1}')
    })

    it('@core:relay 中文与二进制都能往返（不受编码影响）', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const text = sender.seal('desktop-to-phone', '会话已开始 · 明日工坊')
      expect(receiver.open('desktop-to-phone', text).toString('utf8')).toBe('会话已开始 · 明日工坊')

      const binary = randomBytes(1024)
      const sealed = sender.seal('desktop-to-phone', binary)
      expect(sameBytes(receiver.open('desktop-to-phone', sealed), binary)).toBe(true)
    })

    it('@core:relay 连续多帧按序解出（计数严格递增）', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      for (let i = 0; i < 50; i++) {
        const f = sender.seal('phone-to-desktop', `msg-${i}`)
        expect(f.n).toBe(String(i))
        expect(receiver.open('phone-to-desktop', f).toString()).toBe(`msg-${i}`)
      }
      expect(receiver.acceptedCount('phone-to-desktop')).toBe(49)
    })

    it('@core:relay 帧里没有明文字段（只有 n 与 c）', () => {
      const ch = newChannel()
      const f = ch.seal('desktop-to-phone', 'SECRET-PAYLOAD')
      expect(Object.keys(f).sort()).toEqual(['c', 'n'])
      expect(JSON.stringify(f)).not.toContain('SECRET')
    })

    it('@core:relay 同一明文两次加密得到不同密文（计数不同 → nonce 不同）', () => {
      const ch = newChannel()
      const a = ch.seal('desktop-to-phone', 'same')
      const b = ch.seal('desktop-to-phone', 'same')
      expect(a.c).not.toBe(b.c)
    })
  })

  // ───────────────── 篡改 ─────────────────

  describe('篡改密文必须被拒', () => {
    it('@core:relay 翻转密文里任意一个字节 → FRAME_TAMPERED', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const f = sender.seal('desktop-to-phone', 'top secret')
      const raw = Buffer.from(f.c, 'base64url')
      raw[0] ^= 0x01
      const tampered = { n: f.n, c: raw.toString('base64url') }

      expectCode(() => receiver.open('desktop-to-phone', tampered), FRAME_TAMPERED)
    })

    it('@core:relay 截断密文尾部：短于 tag 长度是 MALFORMED，保留 tag 长度则是 TAMPERED', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const f = sender.seal('desktop-to-phone', 'x'.repeat(64))
      const raw = Buffer.from(f.c, 'base64url')

      // ① 只剩 12 字节 < 16 字节 tag：结构上就不可能合法，判 MALFORMED
      const tooShort = { n: f.n, c: raw.subarray(0, 12).toString('base64url') }
      expectCode(() => receiver.open('desktop-to-phone', tooShort), FRAME_MALFORMED)

      // ② 截掉最后 4 字节但仍有 16 字节：结构合法、认证必失败，判 TAMPERED
      const badTag = { n: f.n, c: raw.subarray(0, raw.length - 4).toString('base64url') }
      expectCode(() => receiver.open('desktop-to-phone', badTag), FRAME_TAMPERED)
    })

    it('@core:relay 改计数器（不改密文）→ 认证失败', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const f = sender.seal('desktop-to-phone', 'a')
      sender.seal('desktop-to-phone', 'b')
      // 把第 0 帧的密文挂到计数 5 上：counter 在 AAD 里，认证必然失败
      const moved = { n: '5', c: f.c }
      expectCode(() => receiver.open('desktop-to-phone', moved), FRAME_TAMPERED)
    })

    it('@core:relay 畸形帧不会崩：非对象/缺字段/非法计数/过短密文', () => {
      const receiver = newChannel()
      expectCode(() => receiver.open('desktop-to-phone', null), FRAME_MALFORMED)
      expectCode(() => receiver.open('desktop-to-phone', {}), FRAME_MALFORMED)
      expectCode(() => receiver.open('desktop-to-phone', { n: 0, c: 'x' }), FRAME_MALFORMED)
      expectCode(() => receiver.open('desktop-to-phone', { n: 'abc', c: 'x' }), FRAME_MALFORMED)
      expectCode(() => receiver.open('desktop-to-phone', { n: '-1', c: 'x' }), FRAME_MALFORMED)
      expectCode(() => receiver.open('desktop-to-phone', { n: '0', c: '' }), FRAME_MALFORMED)
    })

    it('@core:relay 解密失败不推进计数（否则伪造帧能把真消息挤掉）', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      // 攻击者先发一个「计数 5」的垃圾帧
      expectCode(() => receiver.open('desktop-to-phone', { n: '5', c: 'ＡＡＡＡ' }), FRAME_MALFORMED)
      expect(receiver.acceptedCount('desktop-to-phone')).toBe(-1)

      // 真正的 0..5 帧仍然全部可解
      for (let i = 0; i <= 5; i++) {
        const f = sender.seal('desktop-to-phone', `real-${i}`)
        expect(receiver.open('desktop-to-phone', f).toString()).toBe(`real-${i}`)
      }
    })
  })

  // ───────────────── 重放 ─────────────────

  describe('重放必须被拒', () => {
    it('@core:relay 同一个帧发两次，第二次 FRAME_REPLAYED', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const f = sender.seal('desktop-to-phone', 'once')
      expect(receiver.open('desktop-to-phone', f).toString()).toBe('once')
      expectCode(() => receiver.open('desktop-to-phone', f), FRAME_REPLAYED)
    })

    it('@core:relay 打乱顺序（先收 3 再收 2）→ 2 被拒', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const frames = [0, 1, 2, 3].map((i) => sender.seal('desktop-to-phone', `m${i}`))
      expect(receiver.open('desktop-to-phone', frames[3]).toString()).toBe('m3')
      expectCode(() => receiver.open('desktop-to-phone', frames[2]), FRAME_REPLAYED)
    })

    it('@core:relay 重放旧的 welcome 级帧也不接受（窗口只前进）', () => {
      const salt = newConnectionSalt()
      const sender = newChannel('p', SESSION_KEY, salt)
      const receiver = newChannel('p', SESSION_KEY, salt)

      const first = sender.seal('phone-to-desktop', 'ack-0')
      receiver.open('phone-to-desktop', first)
      for (let i = 0; i < 10; i++) receiver.open('phone-to-desktop', sender.seal('phone-to-desktop', `x${i}`))
      expectCode(() => receiver.open('phone-to-desktop', first), FRAME_REPLAYED)
    })
  })

  // ───────────────── 跨设备 / 反射 / 降级 ─────────────────

  describe('跨设备挪用与反射攻击', () => {
    it('@core:relay A 设备的密文挂到 B 设备名下 → 认证失败', () => {
      const salt = newConnectionSalt()
      const phoneA = newChannel('phone-A', SESSION_KEY, salt)
      const desktopA = newChannel('phone-A', SESSION_KEY, salt)
      const desktopB = newChannel('phone-B', SESSION_KEY, salt)

      const frame = phoneA.seal('phone-to-desktop', 'I am A')
      expect(desktopA.open('phone-to-desktop', frame).toString()).toBe('I am A')
      expectCode(() => desktopB.open('phone-to-desktop', frame), FRAME_TAMPERED)
    })

    it('@core:relay 把手机发来的帧原样反射回手机 → 方向不同，认证失败', () => {
      const salt = newConnectionSalt()
      const ch = newChannel('p', SESSION_KEY, salt)

      // 手机 → 桌面。桌面若把同一帧当作「桌面 → 手机」发回，
      // 方向进入 AAD，密钥也不同 → 必须失败
      const up = ch.seal('phone-to-desktop', 'invoke session:list')
      expectCode(() => ch.open('desktop-to-phone', up), FRAME_TAMPERED)
    })

    it('@core:relay 缺少连接 salt 时无法通信（重连不会 nonce 重用）', () => {
      const sender = newChannel('p', SESSION_KEY, newConnectionSalt())
      const receiver = newChannel('p', SESSION_KEY, newConnectionSalt())

      const f = sender.seal('desktop-to-phone', 'x')
      // 两边 salt 不同 → 密钥不同 → 解不开
      expectCode(() => receiver.open('desktop-to-phone', f), FRAME_TAMPERED)
    })

    it('@core:relay 重连后计数器从 0 开始但密钥不同：旧帧不能解进新连接', () => {
      const phoneKey = SESSION_KEY
      const oldSalt = newConnectionSalt()
      const newSalt = newConnectionSalt()

      const oldDesktop = newChannel('p', phoneKey, oldSalt)
      const newDesktop = newChannel('p', phoneKey, newSalt)

      const oldFrame = oldDesktop.seal('desktop-to-phone', 'old-connection')
      // 新连接的计数也是 0，若密钥相同就会撞 nonce（GCM 灾难）
      const newFrame = newDesktop.seal('desktop-to-phone', 'new-connection')
      expect(oldFrame.n).toBe(newFrame.n) // 计数一样
      expect(oldFrame.c).not.toBe(newFrame.c) // 密文不同（salt 参与派生）

      // 新连接解不开旧连接的帧
      expectCode(() => newDesktop.open('desktop-to-phone', oldFrame), FRAME_TAMPERED)
    })

    it('@core:relay salt 长度不是 16 字节时构造失败（防止误用固定值）', () => {
      expect(
        () => new SecureChannel({ sessionKey: SESSION_KEY, connectionSalt: Buffer.alloc(8).toString('base64'), deviceId: 'p' })
      ).toThrow(/16 字节/)
    })

    it('@core:relay sessionKey 为空时构造失败', () => {
      expect(() => new SecureChannel({ sessionKey: '', connectionSalt: newConnectionSalt(), deviceId: 'p' })).toThrow(
        /sessionKey/
      )
    })
  })

  // ───────────────── 目标：中继看不到内容 ─────────────────

  describe('中继只能看到「密文」这一事实是可验证的', () => {
    it('@core:relay 把线上帧原样交给密文守门员，判定为密文', async () => {
      const { looksLikeCiphertext } = await import('../../src/main/relay-channel')
      const ch = newChannel()
      const frame = ch.seal('desktop-to-phone', JSON.stringify({ body: '工作区路径 C:\\交付成品' }))
      const wire = Buffer.from(JSON.stringify(frame), 'utf8')

      // 帧本身是 JSON（n/c 两个字段），守门员会认为它是明文 JSON —— 这是对的：
      // 外层这一层确实可见，关键是 c 字段里的内容不可解密。
      expect(looksLikeCiphertext(wire)).toBe(false)

      // 真正要保证的是：c 字段解出来是二进制，不含明文
      const cipherPart = Buffer.from(frame.c, 'base64url')
      expect(cipherPart.toString('utf8')).not.toContain('交付成品')
      expect(looksLikeCiphertext(cipherPart)).toBe(true)
    })

    it('@core:relay 密文里搜不到原文关键词（中继看不到内容）', () => {
      const ch = newChannel()
      const secrets = ['C:\\交付成品\\Morrow', 'apiKey=sk-live-xxx', '用户的私有仓库']
      for (const s of secrets) {
        const frame = ch.seal('desktop-to-phone', s)
        const raw = Buffer.from(frame.c, 'base64url')
        expect(raw.toString('utf8')).not.toContain(s)
        expect(raw.toString('base64')).not.toContain(Buffer.from(s).toString('base64'))
      }
    })
  })
})

// ───── 来源：tests/unit/relay-e2e-encrypted.test.ts ─────
/**
 * B3 第六批验收（整合层）：真 socket 上的端到端加密。
 * 三个「只有真 socket 才能验证」的事实：
 */
describe('端到端加密（真 socket）', () => {
  let dataDir = ''
  let tls: TlsMaterial

  const XOR = 0x5a
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (t: string) => Buffer.from([...Buffer.from(t, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((c) => c ^ XOR)).toString('utf8')
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'morrow-e2e-'))
    tls = await loadOrCreateTls({ dataDir, safeStorage })
  }, 30000)

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function pairPhone(pairing: PairingService, deviceId = 'phone-e2e') {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const phonePub = ecdh.getPublicKey().toString('base64')
    const { ticket } = pairing.issueTicket(deviceId, phonePub)
    return pairing.completePairing(ticket.nonce, phonePub)
  }

  function openSocket(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  /** 手机侧：常驻监听 + 帧队列，避免「事件先到、监听器后挂」的丢帧 */
  class PhoneClient {
    private readonly queue: unknown[] = []
    private readonly waiters: Array<(f: unknown) => void> = []
    private closed = false
    /** 收到的全部原始字节，用于「线上有没有明文」检查 */
    readonly raw: Buffer[] = []

    constructor(private readonly ws: WebSocket) {
      ws.on('message', (data: Buffer) => {
        this.raw.push(data)
        let parsed: unknown
        try {
          parsed = JSON.parse(data.toString())
        } catch {
          return
        }
        const waiter = this.waiters.shift()
        if (waiter) waiter(parsed)
        else this.queue.push(parsed)
      })
      ws.on('close', () => {
        this.closed = true
        while (this.waiters.length) this.waiters.shift()?.(null)
      })
    }

    next(timeoutMs = 5000): Promise<unknown> {
      const q = this.queue.shift()
      if (q !== undefined) return Promise.resolve(q)
      if (this.closed) return Promise.reject(new Error('连接已关闭'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('帧超时')), timeoutMs)
        this.waiters.push((f) => {
          clearTimeout(timer)
          if (f === null) reject(new Error('连接已关闭'))
          else resolve(f)
        })
      })
    }
  }

  interface Session {
    welcome: Record<string, unknown>
    channel: SecureChannel
    client: PhoneClient
  }

  async function handshake(ws: WebSocket, device: { deviceId: string; sessionKey: string }, lastSeq = 0): Promise<Session> {
    const client = new PhoneClient(ws)
    const ts = String(Date.now())
    const sig = PairingService.signRequest(device.sessionKey, device.deviceId, 'lan', ts)
    ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'hello', deviceId: device.deviceId, ts, sig, lastSeq }))

    const welcome = (await client.next()) as Record<string, unknown>
    const channel = new SecureChannel({
      sessionKey: device.sessionKey,
      connectionSalt: welcome.salt as string,
      deviceId: device.deviceId
    })
    return { welcome, channel, client }
  }

  async function nextEnvelope(session: Session) {
    const frame = await session.client.next()
    return JSON.parse(session.channel.open('desktop-to-phone', frame).toString('utf8')) as {
      seq: number
      body: unknown
    }
  }

  /** 建立「已连上」的一条通道，返回清理函数 */
  async function setup(deviceId = 'phone-e2e') {
    const pairing = new PairingService({ secret: randomBytes(32) })
    const ch = new DirectChannel({ pairing, tls })
    await ch.connect()
    const device = pairPhone(pairing, deviceId)
    const ws = await openSocket(ch.port() as number)
    const session = await handshake(ws, device)
    const cleanup = async () => {
      try {
        ws.close()
      } catch {
        // 已断
      }
      await ch.disconnect()
    }
    return { pairing, ch, device, ws, session, cleanup }
  }

  // ───────────────── 线上字节 ─────────────────

  describe('线上一律是密文（中继转发时看到的就是这些字节）', () => {
    it('@core:relay 广播事件后，线上字节里搜不到明文关键词', async () => {
      const { ch, session, ws, cleanup } = await setup()

      const secrets = ['C:\\交付成品\\Morrow', 'apiKey=sk-live-should-not-leak', '用户的私有仓库名']
      for (const s of secrets) ch.broadcast('event', { detail: s })
      // 等所有帧到达
      for (let i = 0; i < secrets.length; i++) await nextEnvelope(session)

      const wire = Buffer.concat(session.client.raw).toString('utf8')
      for (const s of secrets) {
        expect(wire).not.toContain(s)
        // base64 里也不该出现（防止「只是换了编码」）
        expect(wire).not.toContain(Buffer.from(s).toString('base64').slice(0, 12))
      }

      ws.close()
      await cleanup()
    })

    it('@core:relay 线上每一条后续帧都只有 {n, c} 两个字段（结构上不可能夹带明文）', async () => {
      const { ch, session, cleanup } = await setup()
      ch.broadcast('event', { any: 'payload' })
      await nextEnvelope(session)

      // 除第一条 welcome 外，全部是加密帧
      const frames = session.client.raw.slice(1).map((b) => JSON.parse(b.toString()) as Record<string, unknown>)
      expect(frames.length).toBeGreaterThan(0)
      for (const f of frames) {
        expect(Object.keys(f).sort()).toEqual(['c', 'n'])
      }
      await cleanup()
    })

    it('@core:relay welcome 本身不含载荷（含 replay 事件就说明明文漏了）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls })
      await ch.connect()
      const device = pairPhone(pairing, 'phone-w')

      // 先断线期间产生两条事件，制造「重连需要补漏」的场景
      const ws1 = await openSocket(ch.port() as number)
      await handshake(ws1, device)
      ws1.close()
      await new Promise((r) => setTimeout(r, 100))
      ch.broadcast('event', { secretBody: 'MUST-NOT-APPEAR-IN-WELCOME' })
      ch.broadcast('event', { secretBody: 'ALSO-NOT' })

      const ws2 = await openSocket(ch.port() as number)
      const session = await handshake(ws2, device, 0)
      const welcomeRaw = session.client.raw[0].toString('utf8')

      expect(welcomeRaw).not.toContain('MUST-NOT-APPEAR-IN-WELCOME')
      expect(welcomeRaw).not.toContain('ALSO-NOT')
      // 只报数量
      expect(session.welcome.replayCount).toBe(2)
      expect(session.welcome.replay).toBeUndefined()

      // 补漏事件随后逐条加密到达
      expect((await nextEnvelope(session)).seq).toBe(1)
      expect((await nextEnvelope(session)).seq).toBe(2)

      ws2.close()
      await ch.disconnect()
    })
  })

  // ───────────────── 攻击：篡改与重放 ─────────────────

  describe('真 socket 上篡改/重放会被断开', () => {
    it('@core:relay 篡改一个加密帧 → 服务端以 4402 断开', async () => {
      const { ch, session, ws, cleanup } = await setup()

      // 先证明连接正常
      ch.broadcast('event', { ok: 1 })
      await nextEnvelope(session)

      // 手机发一个被改过的帧（把密文尾部翻转）
      const legit = session.channel.seal('phone-to-desktop', JSON.stringify({ kind: 'ack', seq: 1 }))
      const raw = Buffer.from(legit.c, 'base64url')
      raw[raw.length - 1] ^= 0xff
      const tampered = { n: legit.n, c: raw.toString('base64url') }

      const closed = new Promise<number>((resolve) => ws.once('close', (code: number) => resolve(code)))
      ws.send(JSON.stringify(tampered))

      expect(await closed).toBe(CLOSE_TAMPERED)
      await cleanup()
    })

    it('@core:relay 重放同一个加密帧 → 服务端以 4403 断开', async () => {
      const { ch, session, ws, cleanup } = await setup()
      ch.broadcast('event', { ok: 1 })
      await nextEnvelope(session)

      const ack = session.channel.seal('phone-to-desktop', JSON.stringify({ kind: 'ack', seq: 1 }))
      ws.send(JSON.stringify(ack))
      // 等它被接受（没有断连）
      await new Promise((r) => setTimeout(r, 120))
      expect(ws.readyState).toBe(WebSocket.OPEN)

      const closed = new Promise<number>((resolve) => ws.once('close', (code: number) => resolve(code)))
      ws.send(JSON.stringify(ack))
      expect(await closed).toBe(CLOSE_REPLAYED)
      await cleanup()
    })

    it('@core:relay 明文 ack（不加密）被拒绝：鉴权后必须全加密', async () => {
      const { ch, session, ws, cleanup } = await setup()
      ch.broadcast('event', { ok: 1 })
      await nextEnvelope(session)

      const closed = new Promise<number>((resolve) => ws.once('close', (code: number) => resolve(code)))
      // 直接发明文 —— 能发明文说明对面根本没在加密
      ws.send(JSON.stringify({ kind: 'ack', seq: 1 }))
      expect(await closed).toBe(4401)
      await cleanup()
    })

    it('@core:relay 合法加密帧不会被误断（加密接上后正常链路仍工作）', async () => {
      const { ch, session, ws, cleanup } = await setup()

      for (let i = 0; i < 5; i++) {
        const pending = nextEnvelope(session)
        ch.broadcast('event', { i })
        expect((await pending).body).toEqual({ i })
      }

      // 手机连发 5 个合法 ack，连接必须保持
      for (let i = 0; i < 5; i++) {
        ws.send(JSON.stringify(session.channel.seal('phone-to-desktop', JSON.stringify({ kind: 'ack', seq: i + 1 }))))
      }
      await new Promise((r) => setTimeout(r, 150))
      expect(ws.readyState).toBe(WebSocket.OPEN)
      expect(ch.linkCount()).toBe(1)

      await cleanup()
    })
  })

  // ───────────────── 多设备 ─────────────────

  describe('多设备：每条连接独立密钥', () => {
    it('@core:relay 两台手机收到同一事件，但密文不同（salt 不同）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls })
      await ch.connect()

      const d1 = pairPhone(pairing, 'phone-1')
      const d2 = pairPhone(pairing, 'phone-2')
      const ws1 = await openSocket(ch.port() as number)
      const ws2 = await openSocket(ch.port() as number)
      const s1 = await handshake(ws1, d1)
      const s2 = await handshake(ws2, d2)

      const p1 = nextEnvelope(s1)
      const p2 = nextEnvelope(s2)
      ch.broadcast('event', { shared: 'same-content' })
      expect((await p1).body).toEqual({ shared: 'same-content' })
      expect((await p2).body).toEqual({ shared: 'same-content' })

      // 同一条事件在两台设备上的密文必须不同
      const f1 = JSON.parse(s1.client.raw[1].toString()) as { c: string }
      const f2 = JSON.parse(s2.client.raw[1].toString()) as { c: string }
      expect(f1.c).not.toBe(f2.c)

      // 交叉解密必须失败：手机 1 的密文手机 2 解不开
      const crossFrame = JSON.parse(s1.client.raw[1].toString()) as unknown
      expect(() => s2.channel.open('desktop-to-phone', crossFrame)).toThrow()

      ws1.close()
      ws2.close()
      await ch.disconnect()
    })

    it('@core:relay 撤销设备后重连被拒（加密通道建立前就挡掉）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls })
      await ch.connect()
      const device = pairPhone(pairing, 'phone-revoked')

      pairing.revokeDevice('phone-revoked')

      const ws = await openSocket(ch.port() as number)
      const ts = String(Date.now())
      const sig = PairingService.signRequest(device.sessionKey, device.deviceId, 'lan', ts)
      const closed = new Promise<number>((resolve) => ws.once('close', (code: number) => resolve(code)))
      ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'hello', deviceId: device.deviceId, ts, sig, lastSeq: 0 }))

      expect(await closed).toBe(4401)
      await ch.disconnect()
    })
  })
})

// ── 原 relay-pairing.test.ts ──

describe('配对与票据', () => {
  /** 造一个手机侧的 ECDH 密钥对，模拟真实客户端 */
  function phoneKeys() {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    return {
      pub: ecdh.getPublicKey().toString('base64'),
      // 手机侧算共享秘密：用自己的私钥 + 桌面公钥
      secretWith: (desktopPub: string) => ecdh.computeSecret(Buffer.from(desktopPub, 'base64'))
    }
  }

  // 每个用例都通过 makeService() 重置为一个固定基准时刻；
  // 不要再用 beforeEach 重置 clock，否则两处初始化互相覆盖，
  // 会出现「票据已经过期但测试以为还没到」这种自伤的假失败。
  let clock = 1_000_000
  function makeService() {
    clock = 1_000_000
    return new PairingService({ secret: randomBytes(32), now: () => clock })
  }

  describe('验收 1：票据过期返回 TICKET_EXPIRED', () => {
    it('@core:relay 90 秒内有效，超过后过期', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)

      // 89 秒：还有效（从签发时刻起算，不是从 clock 初值起算）
      clock += TICKET_TTL_MS - 1_000
      expect(() => svc.verifyEcho(ticket.nonce)).not.toThrow()

      // 再 +2 秒（共 91 秒）：过期。
      // 注意这里只调用一次并直接断言错误码：
      // 过期分支会顺手删除票据（避免内存驻留），所以第二次调用只会拿到
      // TICKET_INVALID —— 那是测试自己在重复调用，不是代码行为。
      clock += 2_000
      try {
        svc.verifyEcho(ticket.nonce)
        throw new Error('应当过期被拒')
      } catch (err) {
        expect((err as PairingError).code).toBe(TICKET_EXPIRED)
      }
    })

    it('@core:relay 过期边界：恰好等于 exp 时仍有效（未超过）', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      clock += TICKET_TTL_MS
      expect(() => svc.verifyEcho(ticket.nonce)).not.toThrow()
    })

    it('@core:relay 过期票据也被清理，不长期驻留内存', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      clock += TICKET_TTL_MS + 1
      expect(() => svc.verifyEcho(ticket.nonce)).toThrow()
      expect(svc.liveTicketCount()).toBe(0)
    })
  })

  describe('验收 2：六位码不符时拒绝且记录尝试', () => {
    it('@core:relay 错误码被拒绝，且是 CODE_MISMATCH', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
      const wrong = code === '000000' ? '111111' : '000000'

      try {
        svc.confirmCode(ticket.nonce, wrong)
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(CODE_MISMATCH)
        // 错误信息里要带第几次，便于审计与用户理解
        expect((err as Error).message).toMatch(/第 1 次/)
      }
    })

    it('@core:relay 错满 5 次后票据作废，之后的正确码也不再接受', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
      const wrong = code === '000000' ? '111111' : '000000'

      for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
        expect(() => svc.confirmCode(ticket.nonce, wrong)).toThrowError(PairingError)
      }
      // 第 MAX 次：达到上限，报 CODE_ATTEMPTS_EXCEEDED
      try {
        svc.confirmCode(ticket.nonce, wrong)
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(CODE_ATTEMPTS_EXCEEDED)
      }

      // 票据已作废：记录仍保留（可取证），但任何码都用不了
      expect(svc.liveTicketCount()).toBe(1)
      try {
        svc.confirmCode(ticket.nonce, code)
        throw new Error('应当拒绝')
      } catch (err) {
        // 因为爆破而作废的票据，报 USED 而不是 INVALID：
        // 保留「这张票被人试过」的事实，审计时能区分于「从未存在的票」
        expect((err as PairingError).code).toBe(TICKET_USED)
      }
    })

    it('@core:relay 正确码可以确认通过', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
      const r = svc.confirmCode(ticket.nonce, code)
      expect(r.deviceId).toBe('dev-1')
    })

    it('@core:relay 错误码不会消耗票据（用户可重试，直到上限）', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
      const wrong = code === '000000' ? '111111' : '000000'

      expect(() => svc.confirmCode(ticket.nonce, wrong)).toThrow()
      expect(svc.liveTicketCount()).toBe(1) // 仍存在
      expect(() => svc.confirmCode(ticket.nonce, code)).not.toThrow()
    })
  })

  describe('验收 3：配对后票据立即作废（重放失败）', () => {
    it('@core:relay 配对成功后再用同一票据 → TICKET_USED', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)

      const dev = svc.completePairing(ticket.nonce, phone.pub)
      expect(dev.deviceId).toBe('dev-1')
      expect(dev.sessionKey).toBeTruthy()

      try {
        svc.completePairing(ticket.nonce, phone.pub)
        throw new Error('应当拒绝重放')
      } catch (err) {
        expect((err as PairingError).code).toBe(TICKET_USED)
      }
    })

    it('@core:relay 重放被报为 TICKET_USED 而不是 EXPIRED（区分攻击与超时）', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      svc.completePairing(ticket.nonce, phone.pub)

      // 即使时间过去很久，也应该是 USED —— 这是攻击特征，不该伪装成超时
      clock += TICKET_TTL_MS * 10
      try {
        svc.verifyEcho(ticket.nonce)
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(TICKET_USED)
      }
    })

    it('@core:relay 票据作废后，另一台设备不能拿它配对', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const attacker = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      svc.completePairing(ticket.nonce, phone.pub)

      expect(() => svc.completePairing(ticket.nonce, attacker.pub)).toThrowError(PairingError)
    })
  })

  describe('验收 4：撤销设备后 1 次请求内收到 DEVICE_REVOKED', () => {
    it('@core:relay 撤销后下一次判定立即失效（不缓存）', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      svc.completePairing(ticket.nonce, phone.pub)

      // 撤销前可用
      expect(() => svc.requirePaired('dev-1')).not.toThrow()
      expect(svc.listDevices()).toHaveLength(1)

      svc.revokeDevice('dev-1')

      // 撤销后**第一次**调用就要失败
      try {
        svc.requirePaired('dev-1')
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(DEVICE_REVOKED)
      }
      expect(svc.listDevices()).toHaveLength(0)
    })

    it('@core:relay 撤销不存在的设备返回 false，不抛异常', () => {
      const svc = makeService()
      expect(svc.revokeDevice('nope')).toBe(false)
    })

    it('@core:relay 撤销只影响目标设备，其他设备照常可用', () => {
      const svc = makeService()
      const a = phoneKeys()
      const b = phoneKeys()
      const ta = svc.issueTicket('dev-a', a.pub)
      const tb = svc.issueTicket('dev-b', b.pub)
      svc.completePairing(ta.ticket.nonce, a.pub)
      svc.completePairing(tb.ticket.nonce, b.pub)

      svc.revokeDevice('dev-a')
      expect(() => svc.requirePaired('dev-a')).toThrow()
      expect(() => svc.requirePaired('dev-b')).not.toThrow()
    })
  })

  describe('协议前提：票据不承载密钥', () => {
    it('@core:relay 票据字段只有蓝图规定的那几个，没有密钥字段', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub, 'wss://relay.example')
      const keys = Object.keys(ticket).sort()
      // desktopPub 是桌面公钥（公钥不是秘密），手机必须拿到它才能算 ECDH。
      expect(keys).toEqual(['desktopPub', 'deviceId', 'exp', 'nonce', 'pubKey', 'relayHint'])
      // 显式断言：没有任何名字里带 secret/session/private 的字段
      // （pubKey / desktopPub 都是公钥，可以进二维码）
      const forbidden = keys.filter((k) => /session|secret|private/i.test(k))
      expect(forbidden).toEqual([])
    })

    it('@core:relay 二维码解析回的票据里没有会话密钥', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { qr } = svc.issueTicket('dev-1', phone.pub)
      const parsed = PairingService.parseTicket(qr)
      expect(JSON.stringify(parsed)).not.toMatch(/session|secret|private/i)
      expect(parsed.deviceId).toBe('dev-1')
    })

    it('@core:relay 非法二维码内容报 TICKET_INVALID', () => {
      expect(() => PairingService.parseTicket('not-a-ticket!!')).toThrowError(PairingError)
      try {
        PairingService.parseTicket('e30') // base64url of "{}"
      } catch (err) {
        expect((err as PairingError).code).toBe(TICKET_INVALID)
      }
    })
  })

  describe('协议前提：手机只靠二维码就能算出 sessionKey', () => {
    it('@core:relay 票据里的 desktopPub 就是桌面长期公钥', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { qr } = svc.issueTicket('dev-1', phone.pub)
      // 只从二维码解析，不碰 svc 对象 —— 模拟「手机扫完码之后没有任何别的信息」
      const parsed = PairingService.parseTicket(qr)
      expect(parsed.desktopPub).toBe(svc.desktopPublicKey())
    })

    it('@core:relay 仅用二维码内容即可算出与桌面一致的 sessionKey', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { qr } = svc.issueTicket('dev-1', phone.pub)

      // 手机侧的全部输入：二维码 + 自己的私钥。没有任何 svc 内部状态。
      const parsed = PairingService.parseTicket(qr)
      const phoneSessionKey = phone.secretWith(parsed.desktopPub).toString('base64')

      // 桌面侧走完整流程，产出它认为的 sessionKey
      const device = svc.completePairing(parsed.nonce, phone.pub)

      // 两端必须完全相同 —— 这是「扫完码即可离线算出密钥」的全部含义
      expect(device.sessionKey).toBe(phoneSessionKey)
    })
  })

  describe('协议前提：六位码能抓出中间人换公钥', () => {
    it('@core:relay 手机与桌面独立算出的六位码一致', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket, code } = svc.issueTicket('dev-1', phone.pub)

      // 手机侧：用自己的私钥 + 桌面公钥，算同一个共享秘密
      const shared = phone.secretWith(svc.desktopPublicKey())
      const phoneCode = derivePairingCode(shared, ticket.nonce)

      expect(phoneCode).toBe(code)
      expect(phoneCode).toMatch(/^\d{6}$/)
    })

    it('@core:relay 公钥被替换后两端六位码不同（这正是六位码的价值）', () => {
      const svc = makeService()
      const realPhone = phoneKeys()
      const mitm = phoneKeys()

      // 桌面以为在和 realPhone 配对
      const { ticket, code } = svc.issueTicket('dev-1', realPhone.pub)

      // 中间人用自己的私钥 + 桌面公钥算，得到不同的码
      const mitmCode = derivePairingCode(mitm.secretWith(svc.desktopPublicKey()), ticket.nonce)
      expect(mitmCode).not.toBe(code)

      // 真正的手机会算出正确码
      const realCode = derivePairingCode(realPhone.secretWith(svc.desktopPublicKey()), ticket.nonce)
      expect(realCode).toBe(code)
    })

    it('@core:relay 六位码是 6 位数字（含前导零情况）', () => {
      const svc = makeService()
      // 跑多次覆盖前导零
      for (let i = 0; i < 20; i++) {
        const phone = phoneKeys()
        const { code } = svc.issueTicket(`dev-${i}`, phone.pub)
        expect(code).toHaveLength(6)
        expect(/^\d{6}$/.test(code)).toBe(true)
      }
    })
  })

  describe('边界与健壮性', () => {
    it('@core:relay 配对时公钥与票据不一致会被拒绝', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const other = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)

      try {
        svc.completePairing(ticket.nonce, other.pub)
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(TICKET_INVALID)
      }
    })

    it('@core:relay 不存在的 nonce 报 TICKET_INVALID', () => {
      const svc = makeService()
      try {
        svc.verifyEcho('deadbeef')
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(TICKET_INVALID)
      }
    })

    it('@core:relay 空 deviceId 或空公钥不能签发票据', () => {
      const svc = makeService()
      const phone = phoneKeys()
      expect(() => svc.issueTicket('', phone.pub)).toThrowError(PairingError)
      expect(() => svc.issueTicket('dev-1', '')).toThrowError(PairingError)
    })

    it('@core:relay HMAC 密钥太短时构造失败（防止弱密钥）', () => {
      expect(() => new PairingService({ secret: Buffer.from('short') })).toThrow(/至少 16 字节/)
    })

    it('@core:relay 每次签发的 nonce 都不同', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const seen = new Set<string>()
      for (let i = 0; i < 50; i++) {
        seen.add(svc.issueTicket('dev-1', phone.pub).ticket.nonce)
      }
      expect(seen.size).toBe(50)
    })

    it('@core:relay 设备列表不返回 sessionKey（设置页只需要展示信息）', () => {
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      svc.completePairing(ticket.nonce, phone.pub, '我的手机')

      const list = svc.listDevices()
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe('我的手机')
      expect(JSON.stringify(list)).not.toMatch(/sessionKey/)
    })
  })

  describe('协议前提：票据携带桌面证书指纹（手机据此做证书固定）', () => {
    /**
     * 为什么这一节必须存在。
     * 而这就要求桌面**必须**在票据里带上它，否则配对在真机上永远走不完。
     */

    it('@core:relay 注入指纹后，签发的票据带上它', () => {
      const phone = phoneKeys()
      const svc = new PairingService({
        secret: randomBytes(32),
        now: () => clock,
        tlsFingerprint: 'jSXRwabmzzyRS0VAS3y7gzGLePV_oq_06sKR1WuFFB8'
      })
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      expect(ticket.fingerprint).toBe('jSXRwabmzzyRS0VAS3y7gzGLePV_oq_06sKR1WuFFB8')
    })

    it('@core:relay 没有指纹时不编造值，字段直接不出现', () => {
      // 「不出现」和「空串」是两件事：空串会被 parseTicket 当成合法字符串，
      // 手机侧拿到空串做比对永远失败，报错是「指纹不匹配」而不是「票据缺指纹」。
      const svc = makeService()
      const phone = phoneKeys()
      const { ticket } = svc.issueTicket('dev-1', phone.pub)
      expect(ticket.fingerprint).toBeUndefined()
      expect('fingerprint' in ticket).toBe(false)
    })

    it('@core:relay setTlsFingerprint 可在运行中补上（证书载入晚于服务构造）', () => {
      // 生产时序：PairingService 先构造，startLanStack 里才 loadOrCreateTls。
      // 所以必须支持后注入，而不是只能在构造时给。
      const svc = makeService()
      const phone = phoneKeys()
      expect(svc.hasTlsFingerprint()).toBe(false)
      expect(svc.issueTicket('dev-1', phone.pub).ticket.fingerprint).toBeUndefined()

      svc.setTlsFingerprint('FINGERPRINT_A')
      expect(svc.hasTlsFingerprint()).toBe(true)
      expect(svc.issueTicket('dev-1', phone.pub).ticket.fingerprint).toBe('FINGERPRINT_A')
    })

    it('@core:relay 传 null 或空串等于清掉（局域网起不来时的降级路径）', () => {
      const svc = makeService()
      svc.setTlsFingerprint('FINGERPRINT_A')
      svc.setTlsFingerprint(null)
      expect(svc.hasTlsFingerprint()).toBe(false)
      expect(svc.issueTicket('dev-1', phoneKeys().pub).ticket.fingerprint).toBeUndefined()

      svc.setTlsFingerprint('FINGERPRINT_B')
      svc.setTlsFingerprint('')
      expect(svc.hasTlsFingerprint()).toBe(false)
    })

    it('@core:relay 指纹进入 qr（手机只拿得到 qr，拿不到 ticket 对象）', () => {
      // 这条最容易被忽略：桌面内部 `ticket.fingerprint` 有值，
      // 但 qr 是由 `JSON.stringify(ticket)` 生成的 —— 如果哪天有人改成
      // 手挑字段拼 qr，内部有值而 qr 里没有，手机永远拿不到。
      const svc = new PairingService({
        secret: randomBytes(32),
        now: () => clock,
        tlsFingerprint: 'QR_FINGERPRINT_TEST'
      })
      const { qr, ticket } = svc.issueTicket('dev-1', phoneKeys().pub)
      const round = PairingService.parseTicket(qr)
      expect(round.fingerprint).toBe('QR_FINGERPRINT_TEST')
      expect(round.fingerprint).toBe(ticket.fingerprint)
    })

    it('@core:relay parseTicket 接受不带指纹的旧票据（向后兼容）', () => {
      const phone = phoneKeys()
      const svc = makeService()
      const { qr } = svc.issueTicket('dev-1', phone.pub)
      expect(() => PairingService.parseTicket(qr)).not.toThrow()
    })

    it('@core:relay fingerprint 存在但类型不对时拒绝（不能当字符串 "123" 塞进去）', () => {
      // 不校验类型的话，手机侧会拿 "123" 去比对，报「指纹不匹配」——
      // 而真实原因是票据畸形。错误码与真实原因不符，排查时会走错方向。
      const bad = Buffer.from(
        JSON.stringify({
          deviceId: 'd',
          pubKey: 'p',
          desktopPub: 'dp',
          nonce: 'n',
          exp: 1,
          fingerprint: 123
        }),
        'utf8'
      ).toString('base64url')
      expect(() => PairingService.parseTicket(bad)).toThrowError(PairingError)
    })

    it('@core:relay 指纹里不带任何私钥材料（它是公开值，但仍要守住这条线）', () => {
      // 证书指纹是 sha256，公开无害。这条防的是「顺手把 certPem 或 key 也塞进票据」。
      const svc = new PairingService({
        secret: randomBytes(32),
        now: () => clock,
        tlsFingerprint: 'PUBLIC_FP'
      })
      const { qr } = svc.issueTicket('dev-1', phoneKeys().pub)
      const raw = Buffer.from(qr, 'base64url').toString('utf8')
      expect(raw).not.toMatch(/PRIVATE KEY|sessionKey|BEGIN CERTIFICATE/)
    })
  })
})

// ───── 来源：tests/unit/relay-pair-api.test.ts ─────
/**
 * 设置页「手机配对」的后端逻辑（E2d）。
 * ## 必须覆盖的三个失败状态
 * 1. 远程通道没开（`pairing === null`）→ `RELAY_DISABLED`，**不能**临时造一个服务；
 */
describe('配对 API', () => {
  let clock = 1_700_000_000_000

  function makeService(opts: { tlsFingerprint?: string } = {}): PairingService {
    clock = 1_700_000_000_000
    return new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {})
    })
  }

  function phoneKeys() {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    return {
      pub: ecdh.getPublicKey().toString('base64'),
      secretWith: (desktopPub: string) => ecdh.computeSecret(Buffer.from(desktopPub, 'base64'))
    }
  }

  describe('远程通道没开时：明确报错，不偷偷造一个服务', () => {
    it('@core:relay issue 返回 RELAY_DISABLED', () => {
      const r = issuePairTicket(null, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.code).toBe(RELAY_DISABLED)
        // 提示要能指导用户下一步，而不是「操作失败」
        expect(r.error.message).toContain('远程通道')
      }
    })

    it('@core:relay list 返回 RELAY_DISABLED', () => {
      const r = listPairDevices(null)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe(RELAY_DISABLED)
    })

    it('@core:relay revoke 返回 RELAY_DISABLED', () => {
      const r = revokePairDevice(null, 'd')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe(RELAY_DISABLED)
    })
  })

  describe('签发票据', () => {
    it('@core:relay 返回 qr / code / expiresAt / nonce 且指纹标记为 true', () => {
      const svc = makeService({ tlsFingerprint: 'FP_TEST_VALUE' })
      const phone = phoneKeys()
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub, relayHint: '192.168.1.5:7788' })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      expect(r.data.qr.length).toBeGreaterThan(30)
      expect(r.data.code).toMatch(/^\d{6}$/)
      expect(r.data.nonce).toHaveLength(32) // randomBytes(16).toString('hex')
      expect(r.data.hasFingerprint).toBe(true)
      // expiresAt 必须是票据自己的 exp，不是「现在 + TTL」重算
      expect(r.data.expiresAt).toBe(clock + TICKET_TTL_MS)
    })

    it('@core:relay qr 能被桌面自己的 parseTicket 解开，且字段齐全', () => {
      // 这条守的是「界面拿到的 qr 与内部票据是同一份数据」。
      // 如果哪天改成手挑字段拼 qr，内部有值而界面拿到的是残的。
      const svc = makeService({ tlsFingerprint: 'FP_TEST_VALUE' })
      const phone = phoneKeys()
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub, relayHint: '192.168.1.5:7788' })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      const ticket = PairingService.parseTicket(r.data.qr)
      expect(ticket.deviceId).toBe('dev-1')
      expect(ticket.pubKey).toBe(phone.pub)
      expect(ticket.nonce).toBe(r.data.nonce)
      expect(ticket.exp).toBe(r.data.expiresAt)
      expect(ticket.fingerprint).toBe('FP_TEST_VALUE')
      expect(ticket.relayHint).toBe('192.168.1.5:7788')
    })

    it('@core:relay 指纹缺失时 hasFingerprint 为 false（界面必须提示，不能让用户白扫）', () => {
      // 生产里这对应「局域网直连没起来」：证书没载入 → 没指纹 →
      // 手机侧会拒绝完成配对。界面若不提示，用户会以为是自己操作错了。
      const svc = makeService() // 不注入指纹
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phoneKeys().pub })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.hasFingerprint).toBe(false)
      // 票据里就不该有该字段（而不是空串）
      expect('fingerprint' in PairingService.parseTicket(r.data.qr)).toBe(false)
    })

    it('@core:relay 空 deviceId 或空公钥被拒绝，且错误码是 TICKET_INVALID', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      for (const input of [
        { deviceId: '', phonePubKey: phoneKeys().pub },
        { deviceId: 'dev-1', phonePubKey: '' }
      ]) {
        const r = issuePairTicket(svc, input)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error.code).toBe('TICKET_INVALID')
      }
    })

    it('@core:relay 公钥格式非法时抛 PairingError 并被翻成 Result，不是抛到 IPC 层', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: 'not-a-key' })
      expect(r.ok).toBe(false)
    })

    it('@core:relay 每次签发都是新 nonce（同一秒内连续点两次不会撞）', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const phone = phoneKeys()
      const seen = new Set<string>()
      for (let i = 0; i < 20; i++) {
        const r = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phone.pub })
        if (r.ok) seen.add(r.data.nonce)
      }
      expect(seen.size).toBe(20)
    })
  })

  describe('设备列表', () => {
    it('@core:relay 已配对设备出现在列表里，且不含 sessionKey', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const phone = phoneKeys()
      const issued = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub })
      expect(issued.ok).toBe(true)
      if (!issued.ok) return

      svc.completePairing(issued.data.nonce, phone.pub, '我的手机')

      const r = listPairDevices(svc)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data).toHaveLength(1)
      expect(r.data[0].deviceId).toBe('dev-1')
      expect(r.data[0].name).toBe('我的手机')
      expect(JSON.stringify(r.data)).not.toContain('sessionKey')
    })

    it('@core:relay 没有设备时返回空数组而不是报错', () => {
      const r = listPairDevices(makeService({ tlsFingerprint: 'FP' }))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual([])
    })
  })

  describe('撤销设备', () => {
    it('@core:relay 撤销后 requirePaired 立即抛 DEVICE_REVOKED（同一请求内生效）', () => {
      // 这是蓝图验收原文第四条。E2c 之前 pairing.ts 已经有这个保证，
      // 但**界面没有入口触发它** —— 用户无法撤销一台手机。
      const svc = makeService({ tlsFingerprint: 'FP' })
      const phone = phoneKeys()
      const issued = issuePairTicket(svc, { deviceId: 'dev-1', phonePubKey: phone.pub })
      expect(issued.ok).toBe(true)
      if (!issued.ok) return
      svc.completePairing(issued.data.nonce, phone.pub)

      // 撤销前可用
      expect(() => svc.requirePaired('dev-1')).not.toThrow()

      const r = revokePairDevice(svc, 'dev-1')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.revoked).toBe(true)

      // 撤销后立刻不可用 —— 不等到下次握手、不等到重启
      try {
        svc.requirePaired('dev-1')
        throw new Error('撤销后仍可用，这是安全漏洞')
      } catch (err) {
        expect(err).toBeInstanceOf(PairingError)
        expect((err as PairingError).code).toBe(DEVICE_REVOKED)
      }
    })

    it('@core:relay 撤销不存在的设备返回 revoked: false（而不是假装成功）', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = revokePairDevice(svc, 'never-paired')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data.revoked).toBe(false)
    })

    it('@core:relay 空 deviceId 被拒绝', () => {
      const r = revokePairDevice(makeService({ tlsFingerprint: 'FP' }), '')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('INVALID_DEVICE_ID')
    })

    it('@core:relay 撤销一台不影响另一台', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const a = phoneKeys()
      const b = phoneKeys()
      const ia = issuePairTicket(svc, { deviceId: 'dev-a', phonePubKey: a.pub })
      const ib = issuePairTicket(svc, { deviceId: 'dev-b', phonePubKey: b.pub })
      if (!ia.ok || !ib.ok) throw new Error('签发失败')
      svc.completePairing(ia.data.nonce, a.pub)
      svc.completePairing(ib.data.nonce, b.pub)

      revokePairDevice(svc, 'dev-a')

      expect(() => svc.requirePaired('dev-a')).toThrow()
      expect(() => svc.requirePaired('dev-b')).not.toThrow()
    })
  })

  describe('过期判定', () => {
    it('@core:relay expiresAt 取自票据，倒计时随 now 递减', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      expect(remainingMs(r.data.expiresAt, clock)).toBe(TICKET_TTL_MS)
      expect(remainingMs(r.data.expiresAt, clock + 30_000)).toBe(TICKET_TTL_MS - 30_000)
      // 过期后不能出现负数（界面显示「-3 秒」会很怪）
      expect(remainingMs(r.data.expiresAt, clock + TICKET_TTL_MS + 5_000)).toBe(0)
    })

    it('@core:relay 到期之后 isExpired 为 true，之前为 false', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const r = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      if (!r.ok) throw new Error('签发失败')

      expect(isExpired(r.data.expiresAt, clock)).toBe(false)
      expect(isExpired(r.data.expiresAt, clock + TICKET_TTL_MS - 1)).toBe(false)
      // 恰好等于 exp 时仍有效（与 pairing.ts 的 `now > exp` 判定一致）
      expect(isExpired(r.data.expiresAt, clock + TICKET_TTL_MS)).toBe(false)
      expect(isExpired(r.data.expiresAt, clock + TICKET_TTL_MS + 1)).toBe(true)
    })

    it('@core:relay PAIR_TTL_SECONDS 与票据 TTL 一致（界面不写死 90）', () => {
      expect(PAIR_TTL_SECONDS).toBe(90)
      expect(PAIR_TTL_SECONDS * 1000).toBe(TICKET_TTL_MS)
    })

    it('@core:relay 过期票据再确认会被 pairing 拒绝（界面过期只是显示，服务端才是裁判）', () => {
      const svc = makeService({ tlsFingerprint: 'FP' })
      const issued = issuePairTicket(svc, { deviceId: 'd', phonePubKey: phoneKeys().pub })
      if (!issued.ok) throw new Error('签发失败')

      // 界面用同一份 expiresAt 判断过期
      expect(isExpired(issued.data.expiresAt, clock + TICKET_TTL_MS + 1)).toBe(true)
      // 服务端也要拒绝 —— 只靠界面判断是可绕过的
      clock += TICKET_TTL_MS + 1
      expect(() => svc.verifyEcho(issued.data.nonce)).toThrow(/过期/)
    })
  })
})

// ───── 来源：tests/unit/relay-device-store.test.ts ─────
/**
 * B3 第四批验收：已配对设备表持久化。
 * 为什么这块必须单独测：B3 第一批只让「桌面公钥」跨重启不变，
 * 1. 重启后设备消失（必须免扫码恢复）
 * 2. **撤销后重启，设备从文件里复活** —— 这是安全漏洞，不是体验问题
 */
describe('设备表持久化', () => {
  const XOR_KEY = 0x5a
  function fakeSafeStorage(available = true): SafeStorageLike {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (t: string) => Buffer.from([...Buffer.from(t, 'utf8')].map((b) => b ^ XOR_KEY)),
      decryptString: (b: Buffer) => Buffer.from([...b].map((c) => c ^ XOR_KEY)).toString('utf8')
    }
  }

  let dataDir = ''
  const dirs: string[] = []
  let clock = 1_700_000_000_000

  function newDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'morrow-devstore-'))
    dirs.push(d)
    return d
  }

  /** 手机密钥对 */
  function phoneKeys() {
    const e = createECDH('prime256v1')
    e.generateKeys()
    return e.getPublicKey().toString('base64')
  }

  /** 造一个 PairingService，模拟「一次应用启动」 */
  function boot(opts: { privateKey?: string; safe?: SafeStorageLike; dir?: string } = {}) {
    const dir = opts.dir ?? dataDir
    const safe = opts.safe ?? fakeSafeStorage()
    const pairing = new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
      devices: {
        load: () => loadDevices({ dataDir: dir, safeStorage: safe }),
        save: (devices: PairedDevice[]) => void saveDevices({ dataDir: dir, safeStorage: safe }, devices)
      }
    })
    return { pairing, dir, safe }
  }

  beforeEach(() => {
    dataDir = newDir()
    clock = 1_700_000_000_000
  })

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  // ───────────────── 核心：重启后设备仍在 ─────────────────

  describe('重启后设备仍在（免扫码恢复）', () => {
    it('@core:relay 配对一台设备 → 重启 → 设备表仍有它', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone, '我的手机')
      expect(first.pairing.listDevices()).toHaveLength(1)

      // 模拟重启：同一 dataDir 新建实例
      const second = boot()
      const devices = second.pairing.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0].deviceId).toBe('phone-1')
      expect(devices[0].name).toBe('我的手机')
    })

    it('@core:relay 重启后 requirePaired 不抛错（手机能直接重连）', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      const second = boot()
      expect(() => second.pairing.requirePaired('phone-1')).not.toThrow()
    })

    it('@core:relay 重启后 sessionKey 不变，老签名仍然有效', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      const device = first.pairing.completePairing(ticket.nonce, phone)

      const ts = String(clock)
      const sig = PairingService.signRequest(device.sessionKey, 'phone-1', 'session:list', ts)

      const second = boot()
      // 用重启前的签名去验证 —— 必须通过
      expect(() => second.pairing.verifyRequest('phone-1', 'session:list', ts, sig)).not.toThrow()
    })

    it('@core:relay 多台设备都能恢复', () => {
      const first = boot()
      for (const id of ['phone-a', 'phone-b', 'phone-c']) {
        const pub = phoneKeys()
        const { ticket } = first.pairing.issueTicket(id, pub)
        first.pairing.completePairing(ticket.nonce, pub)
      }

      const second = boot()
      expect(second.pairing.listDevices()).toHaveLength(3)
      for (const id of ['phone-a', 'phone-b', 'phone-c']) {
        expect(() => second.pairing.requirePaired(id)).not.toThrow()
      }
    })
  })

  // ───────────────── 安全关键：撤销必须持久 ─────────────────

  describe('撤销必须持久（否则重启后设备复活）', () => {
    it('@core:relay 撤销后重启，设备不会回来', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      first.pairing.revokeDevice('phone-1')
      expect(first.pairing.listDevices()).toHaveLength(0)

      const second = boot()
      expect(second.pairing.listDevices()).toHaveLength(0)
      try {
        second.pairing.requirePaired('phone-1')
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as PairingError).code).toBe(DEVICE_REVOKED)
      }
    })

    it('@core:relay 撤销一台不影响其他设备，重启后状态一致', () => {
      const first = boot()
      const pa = phoneKeys()
      const pb = phoneKeys()
      const ta = first.pairing.issueTicket('phone-a', pa)
      const tb = first.pairing.issueTicket('phone-b', pb)
      first.pairing.completePairing(ta.ticket.nonce, pa)
      first.pairing.completePairing(tb.ticket.nonce, pb)

      first.pairing.revokeDevice('phone-a')

      const second = boot()
      const ids = second.pairing.listDevices().map((d) => d.deviceId)
      expect(ids).toEqual(['phone-b'])
    })

    it('@core:relay 撤销不存在的设备不写盘（不产生无谓 IO）', () => {
      const first = boot()
      expect(first.pairing.revokeDevice('nope')).toBe(false)
      // 没有设备时文件不该被创建
      expect(existsSync(devicesPathIn(first.dir))).toBe(false)
    })
  })

  // ───────────────── 文件格式与安全 ─────────────────

  describe('落盘内容与安全', () => {
    it('@core:relay 设备表加密落盘：文件里不含 sessionKey 明文', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      const device = first.pairing.completePairing(ticket.nonce, phone)

      const raw = readFileSync(devicesPathIn(first.dir), 'utf8')
      expect(raw).not.toContain(device.sessionKey)
      expect(raw).not.toContain('phone-1')
    })

    it('@core:relay safeStorage 不可用时不落盘（宁可重配也不明文存 sessionKey）', () => {
      const phone = phoneKeys()
      const unavailable = fakeSafeStorage(false)
      const s = boot({ safe: unavailable })
      const { ticket } = s.pairing.issueTicket('phone-1', phone)
      s.pairing.completePairing(ticket.nonce, phone)

      expect(existsSync(devicesPathIn(s.dir))).toBe(false)
      // 内存里仍然可用，只是重启会丢
      expect(s.pairing.listDevices()).toHaveLength(1)
    })

    it('@core:relay 文件损坏时退化为空表，但不删除损坏文件', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      // 破坏文件
      writeFileSync(devicesPathIn(first.dir), Buffer.from('garbage'))

      const second = boot()
      expect(second.pairing.listDevices()).toHaveLength(0)
      // 文件还在（可能是临时读失败，不该直接丢弃）
      expect(existsSync(devicesPathIn(first.dir))).toBe(true)
    })

    it('@core:relay 不注入 devices 钩子时退化为纯内存（向后兼容）', () => {
      const phone = phoneKeys()
      const svc = new PairingService({ secret: randomBytes(32), now: () => clock })
      const { ticket } = svc.issueTicket('phone-1', phone)
      svc.completePairing(ticket.nonce, phone)
      expect(svc.listDevices()).toHaveLength(1)
      // 没有钩子 → 不写任何文件
      expect(existsSync(devicesPathIn(dataDir))).toBe(false)
    })

    it('@core:relay clearDevices 能清空（用户解除全部设备）', () => {
      const phone = phoneKeys()
      const first = boot()
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)
      expect(existsSync(devicesPathIn(first.dir))).toBe(true)

      expect(clearDevices({ dataDir: first.dir, safeStorage: fakeSafeStorage() })).toBe(true)
      expect(existsSync(devicesPathIn(first.dir))).toBe(false)
    })
  })

  // ───────────────── 绕过防护 ─────────────────

  describe('损坏数据不会让服务崩溃或放行未配对设备', () => {
    it('@core:relay 设备条目缺字段时被丢弃，不影响其他有效条目', () => {
      const safe = fakeSafeStorage()
      const phone = phoneKeys()
      const first = boot({ safe })
      const { ticket } = first.pairing.issueTicket('phone-1', phone)
      first.pairing.completePairing(ticket.nonce, phone)

      // 手工写入一条合法 + 两条非法
      saveDevices(
        { dataDir: first.dir, safeStorage: safe },
        [
          ...loadDevices({ dataDir: first.dir, safeStorage: safe }),
          { deviceId: '' } as PairedDevice,
          { deviceId: 'x', pubKey: 'p' } as PairedDevice
        ]
      )

      const second = boot({ safe })
      const ids = second.pairing.listDevices().map((d) => d.deviceId)
      expect(ids).toEqual(['phone-1'])
    })

    it('@core:relay 空设备表写入后能读回空数组', () => {
      const safe = fakeSafeStorage()
      saveDevices({ dataDir, safeStorage: safe }, [])
      expect(loadDevices({ dataDir, safeStorage: safe })).toEqual([])
    })
  })
})

// ───── 来源：tests/unit/relay-keystore.test.ts ─────
/**
 * B3 第一批：长期密钥持久化 + 强制配对。
 * 2. 桌面密钥只在内存 → 重启后所有已配对设备失效。
 * 两条都是「功能看起来在、实际不可用」的类型，所以测试必须验证**跨进程**的事实：
 */
describe('长期密钥与强制配对', () => {
  let dataDir = ''
  const dirs: string[] = []

  /**
   * 假 safeStorage：XOR 一下当作「加密」，只为验证流程而不依赖 Electron/DPAPI。
   *
   * 注意它与真实 DPAPI 的两个差异，避免误判：
   * - XOR 不改变长度（密文与明文等长 44 字节）；真实 DPAPI 有头部开销。
   * - XOR 对同一明文产生同一密文；DPAPI 每次加密结果不同（含随机 IV）。
   * 所以断言只验证「文件里不含明文私钥」，不验证密文长度或内容特征。
   */
  function fakeSafeStorage(available = true): SafeStorageLike {
    const KEY = 0x5a
    return {
      isEncryptionAvailable: () => available,
      encryptString: (text: string) => Buffer.from([...Buffer.from(text, 'utf8')].map((b) => b ^ KEY)),
      decryptString: (buf: Buffer) => Buffer.from([...buf].map((b) => b ^ KEY)).toString('utf8')
    }
  }

  function newDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'morrow-b3-key-'))
    dirs.push(d)
    return d
  }

  beforeEach(() => {
    dataDir = newDir()
  })

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  // ───────────────── 长期密钥持久化 ─────────────────

  describe('长期密钥持久化', () => {
    it('@core:relay 首次运行生成密钥并落盘', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      expect(key.restored).toBe(false)
      expect(existsSync(keyPathIn(dataDir))).toBe(true)
    })

    it('@core:relay 再次载入时复用同一密钥（模拟应用重启）', () => {
      const first = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const second = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })

      expect(second.restored).toBe(true)
      expect(second.privateKey).toBe(first.privateKey)
      expect(second.publicKey).toBe(first.publicKey)
    })

    it('@core:relay 落盘的私钥是密文，不是明文', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const raw = readFileSync(keyPathIn(dataDir), 'utf8')
      expect(raw).not.toContain(key.privateKey)
      // 明文私钥是 base64 的 P-256 标量（约 43 字符），不应出现在文件里
      expect(raw.includes(key.privateKey.slice(0, 16))).toBe(false)
    })

    it('@core:relay safeStorage 不可用时不写明文文件（宁可本次临时）', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage(false) })
      expect(key.restored).toBe(false)
      // 关键：文件根本不落盘
      expect(existsSync(keyPathIn(dataDir))).toBe(false)
    })

    it('@core:relay 文件损坏时不阻塞启动，退化为新密钥', () => {
      loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      // 写入垃圾
      const p = keyPathIn(dataDir)
      writeFileSync(p, Buffer.from('garbage-not-decryptable'))

      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      expect(key.restored).toBe(false)
      expect(key.privateKey).toBeTruthy()
    })

    it('@core:relay deleteKey 能清除持久化密钥', () => {
      loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      expect(deleteKey(dataDir)).toBe(true)
      expect(existsSync(keyPathIn(dataDir))).toBe(false)
      expect(deleteKey(dataDir)).toBe(false)
    })
  })

  // ───────────────── 重启后已配对设备仍有效 ─────────────────

  describe('重启后配对仍有效（这是持久化的真正目的）', () => {
    it('@core:relay 用同一长期密钥重建 PairingService，桌面公钥不变', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const a = new PairingService({ secret: randomBytes(32), privateKey: key.privateKey })

      // 模拟重启：重新载入密钥，构造新实例
      const key2 = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const b = new PairingService({ secret: randomBytes(32), privateKey: key2.privateKey })

      expect(b.desktopPublicKey()).toBe(a.desktopPublicKey())
    })

    it('@core:relay 重启前手机算出的共享秘密，重启后仍可用（设备无需重配）', () => {
      const key = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })

      // 手机侧密钥对
      const phone = createECDH('prime256v1')
      phone.generateKeys()
      const phonePub = phone.getPublicKey().toString('base64')

      // 重启前：桌面签发票据，手机算出共享秘密
      const before = new PairingService({ secret: randomBytes(32), privateKey: key.privateKey })
      const { ticket } = before.issueTicket('phone-1', phonePub)
      const sharedBefore = phone.computeSecret(Buffer.from(before.desktopPublicKey(), 'base64'))
      const device = before.completePairing(ticket.nonce, phonePub)

      // 重启后：新实例，同一长期密钥
      const key2 = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const after = new PairingService({ secret: randomBytes(32), privateKey: key2.privateKey })
      const sharedAfter = phone.computeSecret(Buffer.from(after.desktopPublicKey(), 'base64'))

      // 共享秘密一致 → 手机不需要重新配对
      expect(sharedAfter.equals(sharedBefore)).toBe(true)
      expect(device.sessionKey).toBe(sharedBefore.toString('base64'))
    })

    it('@core:relay 不注入私钥时每次都是新密钥（反证持久化确实起作用）', () => {
      const a = new PairingService({ secret: randomBytes(32) })
      const b = new PairingService({ secret: randomBytes(32) })
      expect(a.desktopPublicKey()).not.toBe(b.desktopPublicKey())
    })
  })

  // ───────────────── 强制配对 ─────────────────

  describe('强制配对：不传 pairing 必须拒绝启动', () => {
    it('@core:relay 不带 pairing、不带 allowUnauthenticated → 抛 PAIRING_REQUIRED', async () => {
      await expect(startRelay({ enabled: true, dataDir })).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
    })

    it('@core:relay 即使 enabled=false 也先检查配对（避免「关一次再开」绕过）', async () => {
      // 语义选择：配置错误应当在启动配置阶段就暴露，而不是等到真正开监听时。
      await expect(startRelay({ enabled: false, dataDir })).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
    })

    it('@core:relay 显式 allowUnauthenticated=true 才允许无鉴权', async () => {
      const h = await startRelay({ enabled: true, dataDir, allowUnauthenticated: true })
      expect(h.listening).toBe(true)
      await h.stop()
    })

    it('@core:relay 传了 pairing 就正常启动', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const h = await startRelay({ enabled: true, dataDir, pairing })
      expect(h.listening).toBe(true)
      await h.stop()
    })
  })

  // ───────────────── 密钥与票据的边界 ─────────────────

  describe('密钥与票据边界', () => {
    it('@core:relay 注入损坏的私钥时退化为新密钥，不崩溃', () => {
      const svc = new PairingService({ secret: randomBytes(32), privateKey: 'not-a-valid-key' })
      expect(svc.desktopPublicKey()).toBeTruthy()
    })

    it('@core:relay 不同长期私钥签发的票据互不通用', () => {
      const k1 = loadOrCreateKey({ dataDir, safeStorage: fakeSafeStorage() })
      const k2 = loadOrCreateKey({ dataDir: newDir(), safeStorage: fakeSafeStorage() })

      const s1 = new PairingService({ secret: randomBytes(32), privateKey: k1.privateKey })
      const s2 = new PairingService({ secret: randomBytes(32), privateKey: k2.privateKey })

      const phone = createECDH('prime256v1')
      phone.generateKeys()
      const { ticket } = s1.issueTicket('p', phone.getPublicKey().toString('base64'))

      // s2 没见过这张票据
      expect(() => s2.verifyEcho(ticket.nonce)).toMatchObject
      try {
        s2.verifyEcho(ticket.nonce)
        throw new Error('应当拒绝')
      } catch (err) {
        expect((err as { code?: string }).code).toBe(TICKET_INVALID)
      }
    })
  })
})

// ── 原 relay-server.test.ts ──

describe('HTTP 服务与白名单', () => {
  let dataDir = ''
  let relay: RelayHandle | null = null

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'morrow-relay-'))
    resetBindings()
  })

  afterEach(async () => {
    if (relay) {
      await relay.stop()
      relay = null
    }
    rmSync(dataDir, { recursive: true, force: true })
  })

  /** 探测某端口是否真的可以建立 TCP 连接 —— 这是「端口在监听」的直接证据 */
  function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createServer()
      const conn = socket.listen(0, host, () => {
        const client = new (require('node:net').Socket)()
        client.setTimeout(300)
        client.once('connect', () => {
          client.destroy()
          socket.close(() => resolve(true))
        })
        client.once('error', () => {
          client.destroy()
          socket.close(() => resolve(false))
        })
        client.once('timeout', () => {
          client.destroy()
          socket.close(() => resolve(false))
        })
        client.connect(port, host)
      })
    })
  }

  async function post(port: number, channel: string, payload?: unknown) {
    const res = await fetch(`http://127.0.0.1:${port}/relay/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? '' : JSON.stringify(payload)
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  // ───────────────────────── 验收 4：默认关闭 ─────────────────────────

  describe('默认关闭', () => {
    it('@core:relay 未传 enabled 或 enabled=false 时不监听、不占端口', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: false, dataDir })
      expect(relay.listening).toBe(false)
      expect(relay.port).toBeNull()
    })

    it('@core:relay 关闭状态下 stop() 可安全调用（幂等）', async () => {
      const h = await startRelay({ allowUnauthenticated: true, enabled: false, dataDir })
      await h.stop()
      await h.stop()
      expect(h.listening).toBe(false)
    })
  })

  // ───────────────────── 验收 1：端口不监听（netstat 等价） ─────────────────────

  describe('端口监听状态', () => {
    it('@core:relay 关闭时任意固定端口都不会被占用', async () => {
      // 先占一个临时端口号，再让 relay 用同一端口但保持关闭
      const probe = createServer()
      const port = await new Promise<number>((resolve) => {
        probe.listen(0, '127.0.0.1', () => {
          const p = (probe.address() as { port: number }).port
          probe.close(() => resolve(p))
        })
      })

      relay = await startRelay({ allowUnauthenticated: true, enabled: false, dataDir, port })
      // 关闭时端口号是外界给的，但服务没起来 —— 这里的关键断言是 listening=false，
      // 且该端口仍可被别的进程占用（说明 relay 没占着它）
      expect(relay.listening).toBe(false)

      const probe2 = createServer()
      const reusable = await new Promise<boolean>((resolve) => {
        probe2.once('error', () => resolve(false))
        probe2.listen(port, '127.0.0.1', () => probe2.close(() => resolve(true)))
      })
      expect(reusable).toBe(true)
    })

    it('@core:relay 开启后端口真的可以建立 TCP 连接', async () => {
      bindChannel('app:bootstrap', async () => ({ ready: true }))
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      expect(relay.listening).toBe(true)
      expect(relay.port).toBeGreaterThan(0)
      expect(await canConnect(relay.port as number)).toBe(true)
    })

    it('@core:relay 默认只监听回环地址，不对局域网开放', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      // 回环可连
      expect(await canConnect(relay.port as number, '127.0.0.1')).toBe(true)
      // 只要不是回环，就不应连上（CI/沙箱里通常没有非回环地址，退化为跳过）
      const ifaces = require('node:os').networkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }>>
      const external = Object.values(ifaces)
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal)
      if (external) {
        expect(await canConnect(relay.port as number, external.address)).toBe(false)
      }
    })
  })

  // ───────────────────── 验收 2：白名单 ─────────────────────

  describe('白名单', () => {
    it('@core:relay 白名单内的通道放行，并给出理由', () => {
      expect(checkChannel('chat:send').allowed).toBe(true)
      expect(checkChannel('permission:respond').allowed).toBe(true)
      expect(allowReason('chat:send')).toBeTruthy()
    })

    it('@core:relay 非白名单返回 CHANNEL_DENIED', () => {
      const d = checkChannel('app:change-data-dir')
      expect(d.allowed).toBe(false)
      if (!d.allowed) {
        expect(d.result.error.code).toBe(CHANNEL_DENIED)
      }
    })

    it('@core:relay 危险的写操作与凭据类通道都不在白名单里', () => {
      const dangerous = [
        'app:change-data-dir',
        'app:reset-data-dir',
        'session:delete',
        'session:clear-all',
        'settings:update',
        'settings:save-provider',
        'terminal:start-task',
        'file:search'
      ]
      for (const ch of dangerous) {
        expect(checkChannel(ch).allowed, `${ch} 不应被放行`).toBe(false)
      }
    })

    it('@core:relay app:open-external 暂不放行（桌面实现只开浏览器，与蓝图要求冲突）', () => {
      // 蓝图要「限深链、只能唤起桌面」，但 desktop 的 IPC.openExternal
      // 只接受 http(s) 并用系统浏览器打开，且全仓无 morrow: 深链处理器。
      // 放行它就等于给手机一个「让桌面开浏览器」的通道 —— 蓝图明令禁止。
      expect(checkChannel('app:open-external').allowed).toBe(false)

      // 深链校验逻辑已备好，等桌面实现深链后可直接启用（现在也不该放行任意 URL）
      expect(checkPayload('app:open-external', { url: 'morrow://session/ses_1' }).ok).toBe(true)
      expect(checkPayload('app:open-external', { url: 'https://evil.com' }).ok).toBe(false)
    })

    it('@core:relay app:open-external 拒绝换行与 null 注入（审查实测的绕过手法）', () => {
      // 这两个输入的前缀都是合法的 morrow:，但后半截藏了恶意地址。
      // 只校验 scheme 前缀时它们会被放行 —— 审查探针实测确认过。
      expect(checkPayload('app:open-external', { url: 'morrow://x\nhttps://evil.com' }).ok).toBe(false)
      expect(checkPayload('app:open-external', { url: 'morrow://x\u0000https://evil.com' }).ok).toBe(false)
      expect(checkPayload('app:open-external', { url: 'morrow://x\rhttps://evil.com' }).ok).toBe(false)
      expect(checkPayload('app:open-external', { url: 'morrow://x\thttps://evil.com' }).ok).toBe(false)
    })

    it('@core:relay app:open-external 的 scheme 大小写不敏感（不该误拒正常输入）', () => {
      expect(checkPayload('app:open-external', { url: 'MORROW://session/1' }).ok).toBe(true)
      expect(checkPayload('app:open-external', { url: 'Morrow://x' }).ok).toBe(true)
    })

    it('@core:relay app:open-external 拒绝无 scheme、协议相对、超长输入', () => {
      for (const url of ['morrow//x', '//evil.com', '../morrow://x', 'morrowx://x', 'morrow-://x']) {
        expect(checkPayload('app:open-external', { url }).ok, `${url} 应被拒`).toBe(false)
      }
      expect(checkPayload('app:open-external', { url: 'morrow://' + 'a'.repeat(3000) }).ok).toBe(false)
    })

    it('@core:relay feature:studio:action 只允许 read / preview（蓝图原文子集）', () => {
      expect(checkChannel('feature:studio:action').allowed).toBe(true)

      expect(checkPayload('feature:studio:action', { type: 'read' }).ok).toBe(true)
      expect(checkPayload('feature:studio:action', { type: 'preview' }).ok).toBe(true)

      // 写操作必须被拒
      for (const type of ['write', 'delete', 'export', '', undefined]) {
        expect(checkPayload('feature:studio:action', { type }).ok, `${String(type)} 应被拒`).toBe(false)
      }
    })

    it('@core:relay 白名单不做前缀通配：session: 只放具体那几条', () => {
      // 前缀匹配是最常见的漏洞写法；这里显式验证「新增通道不会自动获得授权」
      expect(checkChannel('session:list').allowed).toBe(true)
      expect(checkChannel('session:delete').allowed).toBe(false)
      expect(checkChannel('session:clear-all').allowed).toBe(false)
    })

    it('@core:relay 空/非字符串通道一律拒绝', () => {
      for (const bad of ['', null, undefined, 123, {}, []]) {
        expect(checkChannel(bad).allowed, `${String(bad)} 应被拒绝`).toBe(false)
      }
    })

    it('@core:relay 白名单每条都有非空理由（防止加了通道却不说明为什么）', () => {
      for (const ch of allowedChannels()) {
        expect(allowReason(ch)?.length ?? 0, `${ch} 缺理由`).toBeGreaterThan(4)
      }
    })
  })

  // ───────────────────── 验收 3：审计不含参数原文 ─────────────────────

  describe('审计日志', () => {
    it('@core:relay 记录通道、结果、耗时与参数结构，但不含参数值', async () => {
      bindChannel('chat:send', async () => ({ accepted: true }))
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })

      const secret = '这是用户输入的机密提示词-super-secret-token-abc123'
      await post(relay.port as number, 'chat:send', { sessionId: 's-1', prompt: secret })

      const log = readAudit(auditPathIn(dataDir))
      const entry = log[log.length - 1]
      expect(entry.channel).toBe('chat:send')
      expect(entry.outcome).toBe('ok')
      expect(entry.ms).toBeGreaterThanOrEqual(0)

      // 结构指纹在
      expect(entry.shape?.sessionId).toBe('string(3)')
      expect(entry.shape?.prompt).toBe(`string(${secret.length})`)

      // 参数原文绝不在日志里 —— 这是蓝图明确要求
      const raw = readFileSync(auditPathIn(dataDir), 'utf8')
      expect(raw).not.toContain(secret)
      expect(raw).not.toContain('s-1')
    })

    it('@core:relay 被拒绝的请求也留审计（否则看不到谁在试探）', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const r = await post(relay.port as number, 'app:change-data-dir', { dir: 'C:/secret' })
      expect(r.status).toBe(403)

      const log = readAudit(auditPathIn(dataDir))
      const denied = log.find((e) => e.outcome === 'denied')
      expect(denied?.channel).toBe('app:change-data-dir')
      expect(denied?.code).toBe(CHANNEL_DENIED)
    })

    it('@core:relay describeShape 不泄露嵌套对象内部的值', () => {
      const shape = describeShape({ config: { apiKey: 'sk-live-abcdef' }, n: 3 })
      expect(shape?.config).toBe('object')
      expect(shape?.n).toBe('number')
      expect(JSON.stringify(shape)).not.toContain('sk-live')
    })
  })

  // ───────────────────── 端到端：白名单 + 分发 ─────────────────────

  describe('端到端', () => {
    it('@core:relay 白名单内且已绑定的通道返回处理结果', async () => {
      bindChannel('session:list', async () => [{ id: 's-1' }])
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })

      const r = await post(relay.port as number, 'session:list', {})
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.data).toEqual([{ id: 's-1' }])
    })

    it('@core:relay 白名单内但未绑定的通道返回 NOT_BOUND（白名单与实现双重约束）', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const r = await post(relay.port as number, 'chat:send', { prompt: 'hi' })
      expect(r.status).toBe(500)
      const err = r.body.error as { code: string }
      expect(err.code).toBe('NOT_BOUND')
    })

    it('@core:relay 处理函数抛错时返回结构化错误，不把堆栈交给手机端', async () => {
      bindChannel('chat:send', async () => {
        throw Object.assign(new Error('模型额度不足'), { code: 'QUOTA' })
      })
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const r = await post(relay.port as number, 'chat:send', { prompt: 'hi' })
      const err = r.body.error as { code: string; message: string }
      expect(err.code).toBe('QUOTA')
      expect(err.message).toBe('模型额度不足')
      expect(JSON.stringify(r.body)).not.toContain('at ')
    })

    it('@core:relay 未知路由返回 404，不进入分发', async () => {
      relay = await startRelay({ allowUnauthenticated: true, enabled: true, dataDir })
      const res = await fetch(`http://127.0.0.1:${relay.port}/nope`, { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('@core:relay 未绑定通道能被启动自检发现（避免白名单写了但没实现）', () => {
      bindChannel('session:list', async () => [])
      const missing = unboundAllowed(allowedChannels())
      expect(missing).toContain('chat:send')
      expect(missing).not.toContain('session:list')
    })
  })

  // ───────────────────── 纯函数边界 ─────────────────────

  describe('边界', () => {
    it('@core:relay appendAudit 会创建缺失的目录', () => {
      const deep = join(dataDir, 'a', 'b', 'c', 'audit.jsonl')
      appendAudit(deep, { at: '2026-01-01T00:00:00.000Z', channel: 'x', outcome: 'ok', ms: 1 })
      expect(readAudit(deep)).toHaveLength(1)
    })

    it('@core:relay 重复绑定同一通道会抛错，不会静默覆盖', () => {
      bindChannel('chat:send', async () => 1)
      expect(() => bindChannel('chat:send', async () => 2)).toThrow(/重复绑定/)
    })

    it('@core:relay dispatch 对未绑定通道返回 NOT_BOUND 而不是抛异常', async () => {
      const r = await dispatch('session:load', {})
      expect(r.ok).toBe(false)
      expect(r.error?.code).toBe('NOT_BOUND')
    })
  })
})

// ───── 来源：tests/unit/relay-pair-gate.test.ts ─────
/**
 * B2 接入验收：配对与请求签名真的接在 HTTP 请求路径上。
 * 等于**没有鉴权**。审查探针跑出来的结果是「只有 deviceId 也能拿到全部数据」。
 */
describe('配对门禁', () => {
  let dataDir = ''
  let relay: RelayHandle | null = null
  let pairing: PairingService
  let clock = 1_700_000_000_000

  /** 一台「手机」：持有自己的私钥与配对后拿到的 sessionKey */
  interface Phone {
    id: string
    sessionKey: string
  }

  function phoneKeys() {
    const e = createECDH('prime256v1')
    e.generateKeys()
    return { pub: e.getPublicKey().toString('base64'), ecdh: e }
  }

  beforeEach(() => {
    clock = 1_700_000_000_000
    dataDir = mkdtempSync(join(tmpdir(), 'morrow-relay-pair-'))
    resetBindings()
    pairing = new PairingService({ secret: randomBytes(32), now: () => clock })
    bindChannel('session:list', async () => [{ id: 's-1' }])
  })

  afterEach(async () => {
    if (relay) {
      await relay.stop()
      relay = null
    }
    rmSync(dataDir, { recursive: true, force: true })
  })

  /** 完成一次完整配对，返回可用的手机凭据 */
  function pairDevice(id = 'phone-1'): Phone {
    const { pub } = phoneKeys()
    const { ticket } = pairing.issueTicket(id, pub)
    const device = pairing.completePairing(ticket.nonce, pub, '测试手机')
    return { id, sessionKey: device.sessionKey }
  }

  /** 带真实签名发一次请求 */
  async function call(channel: string, phone: Phone | null, payload: unknown = {}, opts: { tamper?: 'sig' | 'ts' | 'channel'; noSig?: boolean } = {}) {
    const ts = String(clock)
    const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' }

    if (phone) {
      headers['x-morrow-device'] = phone.id
      headers['x-morrow-timestamp'] = ts
      if (!opts.noSig) {
        const signChannel = opts.tamper === 'channel' ? 'other:channel' : channel
        let sig = PairingService.signRequest(phone.sessionKey, phone.id, signChannel, ts)
        if (opts.tamper === 'sig') sig = sig.slice(0, -4) + 'AAAA'
        headers['x-morrow-signature'] = sig
        if (opts.tamper === 'ts') headers['x-morrow-timestamp'] = String(clock + 120_000)
      }
    }

    const res = await fetch(`http://127.0.0.1:${relay!.port}/relay/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  describe('第四道判定：配对接在请求路径上', () => {
    it('@core:relay 未配对设备被拒绝（403 DEVICE_REVOKED）', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('session:list', { id: 'unknown-device', sessionKey: 'anything' })
      expect(r.status).toBe(403)
      expect((r.body.error as { code: string }).code).toBe(DEVICE_REVOKED)
    })

    it('@core:relay 不带任何设备头也被拒绝', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('session:list', null)
      expect(r.status).toBe(403)
    })

    it('@core:relay 配对成功 + 正确签名可以调用', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('session:list', phone)
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
      expect(r.body.data).toEqual([{ id: 's-1' }])
    })

    it('@core:relay 撤销后下一次请求立即 403（不等重连）', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })

      expect((await call('session:list', phone)).status).toBe(200)

      pairing.revokeDevice(phone.id)

      const after = await call('session:list', phone)
      expect(after.status).toBe(403)
      expect((after.body.error as { code: string }).code).toBe(DEVICE_REVOKED)
    })

    it('@core:relay 判定顺序：未配对时先报设备未配对，不泄露通道是否在白名单', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })

      // 白名单外的通道：先撞白名单
      const denied = await call('app:change-data-dir', null)
      expect((denied.body.error as { code: string }).code).toBe('CHANNEL_DENIED')

      // 白名单内 + 未配对：报 DEVICE_REVOKED
      const unpaired = await call('session:list', { id: 'unknown', sessionKey: 'x' })
      expect((unpaired.body.error as { code: string }).code).toBe(DEVICE_REVOKED)
    })

    it('@core:relay 不传 pairing 且未声明 allowUnauthenticated 时拒绝启动（PAIRING_REQUIRED）', async () => {
      // 这是 B3 堵住的漏洞：初版 applyRelaySettings 忘了传 pairing，
      // 而 startRelay 会静默退化为「无鉴权」。现在必须显式声明才允许裸奔。
      await expect(startRelay({ enabled: true, dataDir })).rejects.toMatchObject({ code: 'PAIRING_REQUIRED' })
    })

    it('@core:relay 显式声明 allowUnauthenticated 后允许无鉴权（仅测试用）', async () => {
      relay = await startRelay({ enabled: true, dataDir, allowUnauthenticated: true })
      const r = await call('session:list', null)
      expect(r.status).toBe(200)
    })
  })

  describe('伪装与重放必须被挡住（初版真的漏了）', () => {
    it('@core:relay 只知道 deviceId、没有 sessionKey 的冒充会被拒', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })

      // 真机可用
      expect((await call('session:list', phone)).status).toBe(200)

      // 攻击者知道 deviceId，但拿不到 sessionKey → 自己编一个签名
      const forged = { id: phone.id, sessionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
      const attack = await call('session:list', forged)
      expect(attack.status).toBe(403)
    })

    it('@core:relay 只带 deviceId 头、不带签名 → 拒绝', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('session:list', phone, {}, { noSig: true })
      expect(r.status).toBe(403)
    })

    it('@core:relay 签名被篡改 → 拒绝', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('session:list', phone, {}, { tamper: 'sig' })
      expect(r.status).toBe(403)
    })

    it('@core:relay 签名绑定通道：拿 A 通道的签名去调 B 通道 → 拒绝', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      // 用 'other:channel' 签的名，实际请求 'session:list'
      const r = await call('session:list', phone, {}, { tamper: 'channel' })
      expect(r.status).toBe(403)
    })

    it('@core:relay 时间戳超出窗口（重放旧请求）→ 拒绝', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('session:list', phone, {}, { tamper: 'ts' })
      expect(r.status).toBe(403)
    })

    it('@core:relay 时钟窗口内的时间戳可用（允许几秒漂移）', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      clock += 30_000 // 30 秒后，仍在 60 秒窗口内
      const r = await call('session:list', phone)
      expect(r.status).toBe(200)
    })
  })

  describe('配对拒绝要留审计', () => {
    it('@core:relay 未配对请求写入 denied 审计，含错误码', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      await call('session:list', { id: 'intruder', sessionKey: 'x' })

      const log = readAudit(auditPathIn(dataDir))
      const denied = log.find((e) => e.outcome === 'denied' && e.code === DEVICE_REVOKED)
      expect(denied).toBeTruthy()
      expect(denied?.channel).toBe('session:list')
    })

    it('@core:relay 被撤销设备的请求也留痕', async () => {
      const phone = pairDevice()
      relay = await startRelay({ enabled: true, dataDir, pairing })
      await call('session:list', phone)
      pairing.revokeDevice(phone.id)
      await call('session:list', phone)

      const log = readAudit(auditPathIn(dataDir))
      expect(log.filter((e) => e.code === DEVICE_REVOKED).length).toBeGreaterThanOrEqual(1)
    })

    it('@core:relay 未配对拒绝时审计不含参数原文，也不含签名', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      await call('session:list', { id: 'intruder', sessionKey: 'x' }, { prompt: 'SECRET-PAYLOAD-XYZ' })

      const raw = readFileSync(auditPathIn(dataDir), 'utf8')
      expect(raw).not.toContain('SECRET-PAYLOAD-XYZ')
      expect(raw).not.toContain('x-morrow-signature')
    })
  })
})

// ───── 来源：tests/unit/relay-payload-gate.test.ts ─────
/**
 * 通道级参数校验接入验收。
 *
 * 为什么单独测：`checkPayload()` 在 allowlist.ts 里单测全绿，
 * 但如果 server.ts 没调它，那就是一段没人用的死代码 ——
 * 「open-external 只允许 morrow: 深链」这个安全保证就只存在于文档里。
 *
 * 所以这里发真实 HTTP 请求，断言危险 payload 被 403 挡在分发之前。
 */
describe('参数校验门禁', () => {
  let dataDir = ''
  let relay: RelayHandle | null = null
  let pairing: PairingService
  let clock = 1_700_000_000_000
  let phone: { id: string; sessionKey: string }

  function setupPhone() {
    // 用 PairingService 走一遍完整配对，拿到可用的 sessionKey
    const { createECDH } = require('node:crypto') as typeof import('node:crypto')
    const e = createECDH('prime256v1')
    e.generateKeys()
    const pub = e.getPublicKey().toString('base64')
    const { ticket } = pairing.issueTicket('phone-x', pub)
    const dev = pairing.completePairing(ticket.nonce, pub)
    return { id: 'phone-x', sessionKey: dev.sessionKey }
  }

  beforeEach(() => {
    clock = 1_700_000_000_000
    dataDir = mkdtempSync(join(tmpdir(), 'morrow-payload-'))
    resetBindings()
    pairing = new PairingService({ secret: randomBytes(32), now: () => clock })
    // 绑定两个受限制的通道，用于确认「参数合法时会真的走到 handler」
    bindChannel('app:open-external', async () => ({ opened: true }))
    bindChannel('feature:studio:action', async (p) => ({ handled: (p as { type?: string })?.type }))
    phone = setupPhone()
  })

  afterEach(async () => {
    if (relay) {
      await relay.stop()
      relay = null
    }
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function call(channel: string, payload: unknown) {
    const ts = String(clock)
    const sig = PairingService.signRequest(phone.sessionKey, phone.id, channel, ts)

    // 本地套接字在高并发测试下有极小概率出现瞬时连接拒绝：
    // 前一个用例的 relay 刚 close()，端口处于回收态。重试一次即可，
    // 不影响断言的有效性（断言看的是业务响应码，不是连接次数）。
    const send = () =>
      fetch(`http://127.0.0.1:${relay!.port}/relay/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
          'x-morrow-device': phone.id,
          'x-morrow-timestamp': ts,
          'x-morrow-signature': sig
        },
        body: JSON.stringify(payload)
      })

    let res: Response
    try {
      res = await send()
    } catch {
      await new Promise((r) => setTimeout(r, 50))
      res = await send()
    }
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  describe('参数校验真的接在请求路径上', () => {
    it('@core:relay studio:action 的写操作 type → 403 PAYLOAD_DENIED', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      const r = await call('feature:studio:action', { type: 'write' })
      expect(r.status).toBe(403)
      expect((r.body.error as { code: string }).code).toBe('PAYLOAD_DENIED')
    })

    it('@core:relay studio:action 的 read / preview → 放行', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      for (const type of ['read', 'preview']) {
        const r = await call('feature:studio:action', { type })
        expect(r.status).toBe(200)
        expect(r.body.data).toEqual({ handled: type })
      }
    })

    it('@core:relay open-external 连通道本身都不放行（桌面实现只开浏览器）', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      // 即使 payload 是合法的 morrow: 深链，也在白名单这一层就被挡住
      const r = await call('app:open-external', { url: 'morrow://session/ses_1' })
      expect(r.status).toBe(403)
      expect((r.body.error as { code: string }).code).toBe('CHANNEL_DENIED')
    })

    it('@core:relay 被参数校验拒绝的请求留审计，码为 PAYLOAD_DENIED', async () => {
      relay = await startRelay({ enabled: true, dataDir, pairing })
      await call('feature:studio:action', { type: 'delete', secret: 'AUDIT-SECRET-XYZ' })

      const log = readAudit(auditPathIn(dataDir))
      const denied = log.find((e) => e.code === 'PAYLOAD_DENIED')
      expect(denied).toBeTruthy()
      expect(denied?.channel).toBe('feature:studio:action')
      // 审计里不该出现 payload 内容
      expect(JSON.stringify(log)).not.toContain('AUDIT-SECRET-XYZ')
    })
  })
})

// ── 原 relay-channel.test.ts ──

describe('通道选择与降级', () => {
  /** 可编程的假通道 */
  function fakeChannel(tier: 'lan' | 'relay' | 'push', initialUp = true) {
    const state = {
      up: initialUp,
      connects: 0,
      disconnects: 0,
      probes: 0,
      throwOnProbe: false,
      throwOnConnect: false
    }
    const ch: TierChannel = {
      tier,
      async probe() {
        state.probes += 1
        if (state.throwOnProbe) throw new Error('probe boom')
        return state.up
      },
      async connect() {
        state.connects += 1
        if (state.throwOnConnect) throw new Error('connect boom')
      },
      async disconnect() {
        state.disconnects += 1
      }
    }
    return { ch, state }
  }

  let clock = 1_000_000
  function advance(ms: number) {
    clock += ms
  }

  function build(opts: { directUp?: boolean; relayUp?: boolean; graceMs?: number } = {}) {
    clock = 1_000_000
    const direct = fakeChannel('lan', opts.directUp ?? true)
    const relay = fakeChannel('relay', opts.relayUp ?? true)
    const push = fakeChannel('push', true)
    const sel = new ChannelSelector({
      direct: direct.ch,
      relay: relay.ch,
      push: push.ch,
      now: () => clock,
      ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {})
    })
    return { sel, direct, relay, push }
  }

  // ───────────────── 蓝图验收 2：5 秒内降级 ─────────────────

  describe('验收 2：关掉 mDNS 后 5 秒内降级到中继', () => {
    it('@core:relay 5 秒整时必须已经降级（不是 6 秒）', async () => {
      const { sel, direct } = build()
      await sel.start()
      expect(sel.tier()).toBe('lan')

      // 模拟 mDNS 关闭：直连探测全部失败
      direct.state.up = false

      // 第 1 秒：还在宽限期内，不降级
      advance(1_000)
      await sel.poll()
      expect(sel.tier()).toBe('lan')

      // 第 4.9 秒：仍未到 5 秒
      advance(3_900)
      await sel.poll()
      expect(sel.tier()).toBe('lan')

      // 第 5 秒：到点，必须降级
      advance(100)
      await sel.poll()
      expect(sel.tier()).toBe('relay')
    })

    it('@core:relay 降级后 chip 文案变成「中继」', async () => {
      const { sel, direct } = build()
      await sel.start()
      expect(sel.chip()).toBe(TIER_LABELS.lan)

      direct.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll()

      expect(sel.chip()).toBe(TIER_LABELS.relay)
      expect(sel.chip()).toBe('中继')
    })

    it('@core:relay 降级时连接顺序正确：断开直连、连上中继', async () => {
      const { sel, direct, relay } = build()
      await sel.start()
      expect(direct.state.connects).toBe(1)

      direct.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll()

      expect(direct.state.disconnects).toBe(1)
      expect(relay.state.connects).toBe(1)
    })

    it('@core:relay 直连在中继降级后恢复 → 升回直连', async () => {
      const { sel, direct } = build()
      await sel.start()
      direct.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll()
      expect(sel.tier()).toBe('relay')

      // 直连恢复
      direct.state.up = true
      await sel.poll()
      expect(sel.tier()).toBe('lan')
    })

    it('@core:relay 中继也不可用 → 退到推送（Tier 3 兜底）', async () => {
      const { sel, direct, relay } = build()
      await sel.start()
      direct.state.up = false
      relay.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll()

      expect(sel.tier()).toBe('push')
      expect(sel.chip()).toBe('仅推送')
    })
  })

  // ───────────────── 蓝图验收 2 的后半句：UI 只变 chip ─────────────────

  describe('验收 2 后半句：UI 只变 chip 文案，内容不重载', () => {
    it('@core:relay 切通道不改变 sessionRevision（内容版本）', async () => {
      const { sel, direct } = build()
      await sel.start()
      // 模拟已加载了 3 批会话内容
      sel.bumpSession()
      sel.bumpSession()
      sel.bumpSession()
      const before = sel.view().sessionRevision
      expect(before).toBe(3)

      direct.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll()

      const after = sel.view()
      expect(after.tier).toBe('relay')
      expect(after.chip).toBe('中继')
      // 关键断言：内容版本没变 —— 用户不会看到「聊天记录重新加载」
      expect(after.sessionRevision).toBe(before)
    })

    it('@core:relay 多次切通道（lan→relay→lan→push）sessionRevision 始终不变', async () => {
      const { sel, direct, relay } = build()
      await sel.start()
      sel.bumpSession()
      const rev = sel.view().sessionRevision

      direct.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll() // → relay
      expect(sel.view().sessionRevision).toBe(rev)

      direct.state.up = true
      await sel.poll() // → lan
      expect(sel.view().sessionRevision).toBe(rev)

      direct.state.up = false
      relay.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll() // → push
      expect(sel.view().sessionRevision).toBe(rev)

      expect(sel.tier()).toBe('push')
      expect(sel.view().sessionRevision).toBe(rev)
    })

    it('@core:relay view() 返回的 sessionRevision 与显式 bump 同步（确认它不是恒定的假值）', async () => {
      const { sel } = build()
      await sel.start()
      const r0 = sel.view().sessionRevision
      sel.bumpSession()
      expect(sel.view().sessionRevision).toBe(r0 + 1)
    })
  })

  // ───────────────── 宽限期：防 chip 抖动 ─────────────────

  describe('宽限期（本实现自加，蓝图未要求）', () => {
    it('@core:relay 单次探测失败不降级', async () => {
      const { sel, direct } = build()
      await sel.start()

      direct.state.up = false
      advance(500) // 半秒
      await sel.poll()
      // 仍在直连 —— 一次丢包就切通道的话，chip 会来回闪
      expect(sel.tier()).toBe('lan')

      // 又恢复了：清掉故障计时
      direct.state.up = true
      await sel.poll()
      expect(sel.tier()).toBe('lan')
    })

    it('@core:relay 间歇性失败不会累积到降级（恢复后重新计时）', async () => {
      const { sel, direct } = build()
      await sel.start()

      // 断 4 秒 → 通 → 再断 4 秒：总断 8 秒但从没连续满 5 秒
      direct.state.up = false
      advance(4_000)
      await sel.poll()
      expect(sel.tier()).toBe('lan')

      direct.state.up = true
      await sel.poll()

      direct.state.up = false
      advance(4_000)
      await sel.poll()
      // 关键：没有被「累计」拖下水
      expect(sel.tier()).toBe('lan')
    })

    it('@core:relay graceMs=0 时立即降级（用于证明宽限期真的起作用）', async () => {
      const { sel, direct } = build({ graceMs: 0 })
      await sel.start()
      direct.state.up = false
      await sel.poll()
      // 没有宽限期就立刻切 —— 这正是有宽限期版本要避免的行为
      expect(sel.tier()).toBe('relay')
    })
  })

  // ───────────────── 启动路径 ─────────────────

  describe('启动选择', () => {
    it('@core:relay 直连可用时选直连（不套宽限期）', async () => {
      const { sel } = build()
      expect(await sel.start()).toBe('lan')
    })

    it('@core:relay 直连不可用时启动直接走中继（不等待 5 秒）', async () => {
      const { sel, direct } = build({ directUp: false })
      const t0 = clock
      expect(await sel.start()).toBe('relay')
      // 启动不该消耗时间
      expect(clock - t0).toBe(0)
      expect(direct.state.connects).toBe(0)
    })

    it('@core:relay 都不可用时退到推送，view.offline 仍为 false（push 是有效状态）', async () => {
      const { sel } = build({ directUp: false, relayUp: false })
      expect(await sel.start()).toBe('push')
      expect(sel.view().offline).toBe(false)
    })

    it('@core:relay 未 start 时 offline=true', () => {
      const { sel } = build()
      expect(sel.view().offline).toBe(true)
      expect(sel.chip()).toBe('未连接')
    })

    it('@core:relay 未连接时 view().tier 为 null（不能与「已退到推送」混淆）', () => {
      const { sel } = build()
      const v = sel.view()
      expect(v.tier).toBeNull()
      expect(v.chip).toBe('未连接')
      expect(v.offline).toBe(true)
      // 这条是审查时补的：初版返回 'push'，UI 会把「启动中」渲染成「仅推送」
      expect(v.tier).not.toBe('push')
    })

    it('@core:relay 退到推送后 tier 才是 push（与未连接区分开）', async () => {
      const { sel } = build({ directUp: false, relayUp: false })
      await sel.start()
      const v = sel.view()
      expect(v.tier).toBe('push')
      expect(v.chip).toBe('仅推送')
      expect(v.offline).toBe(false)
    })

    it('@core:relay 探测抛异常视为不可达，不会让整个流程崩溃', async () => {
      const { sel, direct } = build()
      await sel.start()
      direct.state.up = false
      direct.state.throwOnProbe = true
      advance(DEGRADE_WINDOW_MS)
      await sel.poll()
      expect(sel.tier()).toBe('relay')
    })

    it('@core:relay 连接抛异常不会让状态机卡死', async () => {
      const { sel, relay } = build({ directUp: false })
      relay.state.throwOnConnect = true
      await sel.start()
      // 连不上但状态已切到 relay，下一次 poll 会继续尝试
      expect(sel.tier()).toBe('relay')
    })
  })

  // ───────────────── 切换历史 ─────────────────

  describe('切换历史可诊断', () => {
    it('@core:relay 每次切换都记录 from/to/reason/时间', async () => {
      const { sel, direct } = build()
      await sel.start() // null → lan
      direct.state.up = false
      advance(DEGRADE_WINDOW_MS)
      await sel.poll() // lan → relay

      const history = sel.switchHistory()
      expect(history).toHaveLength(2)
      expect(history[0]).toMatchObject({ from: null, to: 'lan' })
      expect(history[1].from).toBe('lan')
      expect(history[1].to).toBe('relay')
      expect(history[1].reason).toContain('不可达')
    })

    it('@core:relay 没有切换时不产生冗余历史', async () => {
      const { sel } = build()
      await sel.start()
      await sel.poll()
      await sel.poll()
      expect(sel.switchHistory()).toHaveLength(1)
    })
  })

  // ───────────────── 中继只转发密文 ─────────────────

  describe('中继只转发密文（蓝图原文的安全前提）', () => {
    it('@core:relay 可解析的明文 JSON 被判定为「不是密文」', () => {
      const plain = new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'event', body: { text: 'hello' } }))
      expect(looksLikeCiphertext(plain)).toBe(false)
    })

    it('@core:relay 随机二进制被判定为密文', () => {
      const bytes = new Uint8Array([0x8f, 0x2a, 0xc1, 0x00, 0xff, 0x7e])
      expect(looksLikeCiphertext(bytes)).toBe(true)
    })

    it('@core:relay 明文发往中继时 requireCiphertext 抛错（拦在发送之前）', () => {
      const plain = new TextEncoder().encode(JSON.stringify({ secret: 'user prompt' }))
      expect(() => requireCiphertext(plain)).toThrow(/密文/)
    })

    it('@core:relay 空字节数组不算密文（避免「空=安全」的误判）', () => {
      expect(looksLikeCiphertext(new Uint8Array([]))).toBe(false)
    })

    it('@core:relay base64 编码的明文也被拦下（编码不是加密）', () => {
      // 审查探针实测：把 JSON 套一层 base64，初版判定为「密文」——
      // 于是「中继只转发密文」被一个 base64 绕过。
      const plain = JSON.stringify({ text: '用户机密内容', path: 'C:/secret.docx' })
      const b64 = new TextEncoder().encode(Buffer.from(plain, 'utf8').toString('base64'))
      expect(looksLikeCiphertext(b64)).toBe(false)
      expect(() => requireCiphertext(b64)).toThrow(/密文/)
    })

    it('@core:relay 十六进制编码的明文也被拦下', () => {
      const plain = JSON.stringify({ secret: 'hex-encoded' })
      const hex = new TextEncoder().encode(Buffer.from(plain, 'utf8').toString('hex'))
      expect(looksLikeCiphertext(hex)).toBe(false)
    })

    it('@core:relay 真随机字节仍然判为密文（不能把正常密文也拦了）', () => {
      // 高熵二进制：既不是 UTF-8 文本，也不是 base64/hex 可解码的 JSON
      const random = new Uint8Array(64)
      for (let i = 0; i < random.length; i++) random[i] = (i * 137 + 91) % 256
      random[0] = 0x9f // 保证不是 '{'
      expect(looksLikeCiphertext(random)).toBe(true)
    })

    it('@core:relay envelopeMeta 不含 body（推送/中继不该看到内容）', () => {
      const alloc = new SeqAllocator()
      const e = makeEnvelope(alloc, 'event', { runId: 'run_1', sessionId: 'ses_1', at: 1_700_000_000_000 }, {
        text: '这是用户输入的机密内容',
        filePath: 'C:/Users/me/secret.docx'
      })
      const meta = envelopeMeta(e)
      expect(Object.keys(meta).sort()).toEqual(['at', 'kind', 'seq', 'sessionId', 'v'])
      const serialized = JSON.stringify(meta)
      expect(serialized).not.toContain('机密内容')
      expect(serialized).not.toContain('secret.docx')
    })
  })
})

// ───── 来源：tests/unit/relay-direct-channel.test.ts ─────
/**
 * B3 第五批验收：DirectChannel 真实现。
 * 1. 未鉴权连接被拒（同网段任何人不能偷看）
 */
describe('局域网直连（真 WSS）', () => {
  const XOR = 0x5a
  function fakeSafeStorage(available = true): SafeStorageLike {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (t: string) => Buffer.from([...Buffer.from(t, 'utf8')].map((b) => b ^ XOR)),
      decryptString: (b: Buffer) => Buffer.from([...b].map((c) => c ^ XOR)).toString('utf8')
    }
  }

  let dataDir = ''
  const dirs: string[] = []

  function newDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'morrow-direct-'))
    dirs.push(d)
    return d
  }

  /** 生成一次证书，多个用例共用（生成要 ~25ms，不必每次重来） */
  let cachedTls: TlsMaterial | null = null

  async function tlsMaterial(): Promise<TlsMaterial> {
    if (cachedTls) return cachedTls
    cachedTls = await loadOrCreateTls({ dataDir: newDir(), safeStorage: fakeSafeStorage() })
    return cachedTls
  }

  /** 已配对的一台手机：返回 deviceId 与它的 sessionKey */
  function pairPhone(pairing: PairingService, deviceId = 'phone-test') {
    const ecdh = require('node:crypto').createECDH('prime256v1')
    ecdh.generateKeys()
    const phonePub = ecdh.getPublicKey().toString('base64')
    const { ticket } = pairing.issueTicket(deviceId, phonePub)
    const device = pairing.completePairing(ticket.nonce, phonePub)
    return { deviceId, sessionKey: device.sessionKey }
  }

  /** 手机侧开一条真 WSS 连接 */
  function openSocket(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  /**
   * 手机侧的收帧队列。
   * 把帧推进队列，再由上层按需消费。测试必须模拟同样的结构，
   * 否则测试比产品脆弱，一旦实现改成「连续发多帧」就红。
   */
  class PhoneClient {
    private readonly queue: unknown[] = []
    private readonly waiters: Array<(frame: unknown) => void> = []
    private closed = false

    constructor(private readonly ws: WebSocket) {
      ws.on('message', (raw: Buffer) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw.toString())
        } catch {
          return
        }
        const waiter = this.waiters.shift()
        if (waiter) waiter(parsed)
        else this.queue.push(parsed)
      })
      ws.on('close', () => {
        this.closed = true
        // 唤醒所有等待者，避免超时才失败（错误信息更准确）
        while (this.waiters.length) this.waiters.shift()?.(null)
      })
    }

    /** 取下一帧（已有则立即返回，否则等待） */
    next(timeoutMs = 5000): Promise<unknown> {
      const queued = this.queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      if (this.closed) return Promise.reject(new Error('连接已关闭，没有更多帧'))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('帧超时')), timeoutMs)
        this.waiters.push((frame) => {
          clearTimeout(timer)
          if (frame === null) reject(new Error('连接已关闭，没有更多帧'))
          else resolve(frame)
        })
      })
    }
  }

  /**
   * 手机侧：一次 hello + welcome 的结果。
   *
   * 服务端在 welcome 里下发 `salt`，之后的每一帧都用它派生密钥加密。
   * 测试必须像真手机一样建立 `SecureChannel`，否则收到的是密文而不是信封。
   */
  interface PhoneSession {
    welcome: Record<string, unknown>
    /** 手机侧的解密器（与服务端那条连接用的是同一套密钥） */
    channel: SecureChannel
    /** 后续帧的读取入口 */
    client: PhoneClient
  }

  async function handshake(
    ws: WebSocket,
    pairing: PairingService,
    device: { deviceId: string; sessionKey: string },
    lastSeq = 0
  ): Promise<PhoneSession> {
    // 先挂队列再发 hello：否则 welcome 也可能在手挂监听前到达
    const client = new PhoneClient(ws)
    const ts = String(Date.now())
    const sig = PairingService.signRequest(device.sessionKey, device.deviceId, 'lan', ts)
    ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'hello', deviceId: device.deviceId, ts, sig, lastSeq }))

    const welcome = (await client.next()) as Record<string, unknown>
    if (welcome === null) throw new Error('welcome 之前连接就断了')

    const salt = typeof welcome.salt === 'string' ? welcome.salt : ''
    const channel = new SecureChannel({
      sessionKey: device.sessionKey,
      connectionSalt: salt,
      deviceId: device.deviceId
    })
    return { welcome, channel, client }
  }

  /** 收下一条帧并解密成信封 */
  async function nextEnvelope(session: PhoneSession): Promise<Envelope> {
    const frame = await session.client.next()
    return JSON.parse(session.channel.open('desktop-to-phone', frame).toString('utf8')) as Envelope
  }

  /**
   * 等到条件成立，最多等 timeout 毫秒。
   *
   * 参数必须允许 Promise：真实 socket 的关闭是异步的，
   * `!(await ch.probe())` 这种异步判断写成同步签名会得到「Promise 恒为真值 →
   * 立即返回 true」，等于**根本没等**。这里两种都支持，await 后再判。
   */
  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return true
      await new Promise((r) => setTimeout(r, 20))
    }
    return await predicate()
  }

  beforeEach(() => {
    dataDir = newDir()
  })

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  // ───────────────────────── 真握手与鉴权 ─────────────────────────

  describe('真 WSS：握手与鉴权', () => {
    it('@core:relay 已配对手机能完成 hello → welcome，服务端 linkCount 变 1', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()
      expect(ch.port()).toBeGreaterThan(0)

      const device = pairPhone(pairing)
      const ws = await openSocket(ch.port() as number)
      const session = await handshake(ws, pairing, device)
      const { welcome } = session

      expect(welcome.kind).toBe('welcome')
      expect(welcome.deviceId).toBe('phone-test')
      // 证书指纹交给手机固定：手机下次连的是同一个桌面
      expect(typeof welcome.fingerprint).toBe('string')
      // welcome 必须下发 salt：手机没有它就无法派生密钥
      expect(typeof welcome.salt).toBe('string')
      expect(Buffer.from(welcome.salt as string, 'base64').length).toBe(16)
      // welcome 本身不含任何载荷（明文下发，绝不能带内容）
      expect(welcome.replay).toBeUndefined()
      expect(ch.linkCount()).toBe(1)

      // 桌面广播一条事件，手机能用同一套密钥解开
      const first = nextEnvelope(session)
      ch.broadcast('event', { hello: 'world' })
      expect((await first).body).toEqual({ hello: 'world' })

      ws.close()
      await ch.disconnect()
    })

    it('@core:relay 未配对设备发 hello 被拒（关闭码 4401）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const ws = await openSocket(ch.port() as number)
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c))
        ws.send(
          JSON.stringify({
            v: ENVELOPE_VERSION,
            kind: 'hello',
            deviceId: 'not-paired',
            ts: String(Date.now()),
            sig: 'fake',
            lastSeq: 0
          })
        )
      })

      expect(code).toBe(CLOSE_UNAUTHORIZED)
      expect(ch.linkCount()).toBe(0)
      await ch.disconnect()
    })

    it('@core:relay 伪造签名被拒：知道 deviceId 不等于配对过', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const real = pairPhone(pairing)
      const ws = await openSocket(ch.port() as number)
      const ts = String(Date.now())
      // 用「另一个设备的 sessionKey」签自己 —— 签名校验必须失败
      const other = pairPhone(pairing, 'other-phone')
      const sig = PairingService.signRequest(other.sessionKey, real.deviceId, 'lan', ts)

      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c))
        ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'hello', deviceId: real.deviceId, ts, sig, lastSeq: 0 }))
      })

      expect(code).toBe(CLOSE_UNAUTHORIZED)
      await ch.disconnect()
    })

    it('@core:relay 不发 hello 的连接在超时后被关掉（防占位）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const ws = await openSocket(ch.port() as number)
      // 什么都不发
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8000)
        ws.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })

      expect(closed).toBe(true)
      await ch.disconnect()
    }, 12000)

    it('@core:relay 第一帧不是 hello 时立即拒绝', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const ws = await openSocket(ch.port() as number)
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c))
        ws.send(JSON.stringify({ kind: 'event', seq: 1 }))
      })

      expect(code).toBe(CLOSE_UNAUTHORIZED)
      await ch.disconnect()
    })
  })

  // ───────────────────────── probe 语义 ─────────────────────────

  describe('probe() 的语义：不是「端口在听」而是「真的在通信」', () => {
    it('@core:relay 没有手机连接时 probe 为 false（否则界面会把启动中显示成直连）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      expect(ch.port()).toBeGreaterThan(0)
      // 端口在监听，但没有已鉴权连接
      expect(await ch.probe()).toBe(false)
      await ch.disconnect()
    })

    it('@core:relay 手机连上后 probe 为 true', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const device = pairPhone(pairing)
      const ws = await openSocket(ch.port() as number)
      await handshake(ws, pairing, device)

      expect(await ch.probe()).toBe(true)
      ws.close()
      await ch.disconnect()
    })

    it('@core:relay 手机断开后 probe 变回 false（不是永久 true）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const device = pairPhone(pairing)
      const ws = await openSocket(ch.port() as number)
      await handshake(ws, pairing, device)
      expect(await ch.probe()).toBe(true)

      ws.close()
      const dropped = await waitFor(async () => !(await ch.probe()), 3000)
      expect(dropped).toBe(true)

      await ch.disconnect()
    })

    it('@core:relay disconnect 后 probe 为 false，端口不再监听', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()
      const port = ch.port() as number

      const device = pairPhone(pairing)
      const ws = await openSocket(port)
      await handshake(ws, pairing, device)

      await ch.disconnect()
      expect(await ch.probe()).toBe(false)
      expect(ch.port()).toBeNull()

      // 端口真的关了：再连应该失败
      await expect(openSocket(port)).rejects.toBeTruthy()
    })

    it('@core:relay 手机反复连断后 connectionCount 归零（不是只靠 readyState 掩盖泄漏）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()
      const device = pairPhone(pairing)

      for (let i = 0; i < 5; i++) {
        const ws = await openSocket(ch.port() as number)
        await handshake(ws, pairing, device)
        expect(ch.connectionCount()).toBe(1)
        ws.close()
        const cleaned = await waitFor(() => ch.connectionCount() === 0, 3000)
        expect(cleaned).toBe(true)
      }

      await ch.disconnect()
    })
  })

  // ─────────────────── 配对确认（手机 → 桌面的最后一环） ───────────────────

  /**
   * 这一组测的是「手机把 nonce 报回桌面」这条路径。
   *
   * 没有它的时候，`completePairing()` 在整个仓库里没有任何生产调用点：
   * 用户手机上看到「配对成功」，桌面的「已配对的手机」却永远是空的。
   * 而且下一次手机拿新 sessionKey 来 hello 时会被 4401 拒掉 ——
   * 因为桌面设备表里根本没有这台设备。
   */
  describe('配对确认：握手前的 pair-confirm 帧', () => {
    /** 造一张真票据，返回 (nonce, 手机侧密钥对) —— 模拟手机上那份配对码 */
    function issueFor(pairing: PairingService, deviceId = 'phone-confirm') {
      const ecdh = require('node:crypto').createECDH('prime256v1')
      ecdh.generateKeys()
      const phonePub = ecdh.getPublicKey().toString('base64')
      const { ticket } = pairing.issueTicket(deviceId, phonePub)
      return { nonce: ticket.nonce, phonePub, deviceId }
    }

    it('@core:relay 已知缺口：六位码当前不参与鉴权（P1-04）', async () => {
      // 这条测试**记录一个已知缺口**，而不是守护一个正确行为。
      //
      // `PairingService.confirmCode()` 有限流（MAX_CODE_ATTEMPTS）与
      // `safeEqual` 比较，单测覆盖充分 —— 但 `handlePairConfirm` 走的是
      // `completePairingByNonce(nonce)`，**从不调用它**。
      //
      // 后果：能拿到票据 nonce 的人可以直接完成配对，六位码形同虚设。
      // 「配对需要六位码确认」这个安全假设当前**不成立**。
      //
      // 为什么先写成测试而不是直接修：修它要同时改手（加发 code）、
      // 桌面（改调 confirmCode）、以及旧版兼容，两端版本不一致会让
      // 配对直接失败 —— 那是用户可感知的回归，必须同步发版。
      //
      // 这条测试的作用是：任何人想「确认一下这个安全属性」时，
      // 会在这里读到真相，而不是去读 confirmCode 的单测然后误以为已经生效。
      //
      // 修好之后，这条应该改成「错误 code 必须配不上」并搬进正常用例。
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const phone = issueFor(pairing)
      const ws = await openSocket(ch.port() as number)
      const client = new PhoneClient(ws)

      // 只发 nonce，**不发 code** —— 与手机端 pairConfirmFrame 一致
      ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: phone.nonce }))
      const ack = (await client.next()) as Record<string, unknown>

      // 当前行为：配上了。把这件事显式断言下来，缺口就不会被忘掉。
      expect(ack.kind).toBe('pair-confirm-ok')
      expect(pairing.listDevices()).toHaveLength(1)
    })

    it('@core:relay 手机报出票据 nonce 后，桌面设备表真的写入（这是设置页列表的唯一来源）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const phone = issueFor(pairing)
      // 前提：报之前桌面不认识这台手机
      expect(pairing.listDevices()).toHaveLength(0)

      const ws = await openSocket(ch.port() as number)
      const client = new PhoneClient(ws)
      ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: phone.nonce }))

      const ack = (await client.next()) as Record<string, unknown>
      expect(ack.kind).toBe('pair-confirm-ok')
      expect(ack.deviceId).toBe(phone.deviceId)

      // 核心断言：设备进了表。设置页读的就是这份。
      const devices = pairing.listDevices()
      expect(devices).toHaveLength(1)
      expect(devices[0].deviceId).toBe(phone.deviceId)

      ws.close()
      await ch.disconnect()
    })

    it('@core:relay 确认之后手机能用新 sessionKey 走 hello（配完就能连）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const phone = issueFor(pairing)
      const ws = await openSocket(ch.port() as number)
      const client = new PhoneClient(ws)
      ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: phone.nonce }))
      const ok = (await client.next()) as Record<string, unknown>
      expect(ok.kind).toBe('pair-confirm-ok')

      // 用设备表里的 sessionKey 签 hello：能通过就说明确认写对了
      const device = pairing.requirePaired(phone.deviceId)
      const ts = String(Date.now())
      const sig = PairingService.signRequest(device.sessionKey, phone.deviceId, 'lan', ts)
      ws.send(
        JSON.stringify({
          v: ENVELOPE_VERSION,
          kind: 'hello',
          deviceId: phone.deviceId,
          ts,
          sig,
          lastSeq: 0
        })
      )
      const welcome = (await client.next()) as Record<string, unknown>
      expect(welcome.kind).toBe('welcome')
      expect(ch.linkCount()).toBe(1)

      ws.close()
      await ch.disconnect()
    })

    it('@core:relay 不存在的 nonce 被拒并断开（不泄露票据是否存在）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const ws = await openSocket(ch.port() as number)
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (c: number) => resolve(c))
        ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: 'deadbeef' }))
      })

      expect(code).toBe(CLOSE_UNAUTHORIZED)
      expect(pairing.listDevices()).toHaveLength(0)
      await ch.disconnect()
    })

    it('@core:relay 同一张票据只能确认一次（重放被拒）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const phone = issueFor(pairing)

      // 第一次：成功
      const ws1 = await openSocket(ch.port() as number)
      const c1 = new PhoneClient(ws1)
      ws1.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: phone.nonce }))
      const ack = (await c1.next()) as Record<string, unknown>
      expect(ack.kind).toBe('pair-confirm-ok')
      ws1.close()

      // 第二次：同一个 nonce 必须被拒（票据一次性）
      const ws2 = await openSocket(ch.port() as number)
      const code = await new Promise<number>((resolve) => {
        ws2.once('close', (c: number) => resolve(c))
        ws2.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: phone.nonce }))
      })
      expect(code).toBe(CLOSE_UNAUTHORIZED)
      // 设备表里仍然只有一台（重放没把它加成两台）
      expect(pairing.listDevices()).toHaveLength(1)

      await ch.disconnect()
    })

    it('@core:relay 设备表变更会通知订阅方（设置页靠它在配对完成那一刻刷新）', async () => {
      const seen: string[][] = []
      const pairing = new PairingService({
        secret: randomBytes(32),
        onDevicesChanged: (devices) => seen.push(devices.map((d) => d.deviceId))
      })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      const phone = issueFor(pairing)
      const ws = await openSocket(ch.port() as number)
      const client = new PhoneClient(ws)
      ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce: phone.nonce }))
      await client.next()

      expect(seen).toEqual([[phone.deviceId]])

      // 撤销也要通知：只通知配对不通知撤销，列表会留着一条已经消失的设备
      pairing.revokeDevice(phone.deviceId)
      expect(seen).toEqual([[phone.deviceId], []])

      ws.close()
      await ch.disconnect()
    })

    it('@core:relay nonce 为空或超长时直接断开，不给探测入口', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()

      for (const nonce of ['', 'x'.repeat(200)]) {
        const ws = await openSocket(ch.port() as number)
        const code = await new Promise<number>((resolve) => {
          ws.once('close', (c: number) => resolve(c))
          ws.send(JSON.stringify({ v: ENVELOPE_VERSION, kind: 'pair-confirm', nonce }))
        })
        expect(code).toBe(CLOSE_UNAUTHORIZED)
      }
      expect(pairing.listDevices()).toHaveLength(0)
      await ch.disconnect()
    })
  })

  // ───────────────────────── 真实降级（本轮核心） ─────────────────────────

  describe('close 时 ChannelSelector 真的降级（用真 socket，不是 stub）', () => {
    /** 造一个只会「中继可用」的假中继，直连用真的 */
    function fakeRelay(mode: { up: boolean }): TierChannel & { connected: number; disconnected: number } {
      const state = {
        tier: 'relay' as const,
        connected: 0,
        disconnected: 0,
        async probe() {
          return mode.up
        },
        async connect() {
          state.connected++
        },
        async disconnect() {
          state.disconnected++
        }
      }
      return state as unknown as TierChannel & { connected: number; disconnected: number }
    }

    it('@core:relay 手机断开 → 宽限期满 → 选择器切到 relay，且 chip 变化、sessionRevision 不变', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const direct = new DirectChannel({ pairing, tls: await tlsMaterial() })
      const relay = fakeRelay({ up: true })

      let clock = 1_000_000
      const selector = new ChannelSelector({
        direct,
        relay,
        now: () => clock,
        graceMs: 5_000
      })

      // 手机先连上，直连才算「可用」
      await direct.connect()
      const device = pairPhone(pairing)
      const ws = await openSocket(direct.port() as number)
      await handshake(ws, pairing, device)

      // 现在启动选择器：probe 为 true，应当选 lan
      expect(await selector.start()).toBe('lan')
      const before = selector.view()
      expect(before.tier).toBe('lan')
      expect(before.chip).toBe('直连')

      // 手机掉线（真实 close，不是改标志位）
      ws.close()
      await waitFor(async () => !(await direct.probe()), 3000)

      // 宽限期内：不降级
      clock += 1_000
      await selector.poll()
      expect(selector.view().tier).toBe('lan')

      // 宽限期满：降级到 relay
      clock += 4_000
      await selector.poll()
      const after = selector.view()
      expect(after.tier).toBe('relay')
      expect(after.chip).toBe('中继')
      // 切通道只改 chip，不改会话内容版本
      expect(after.sessionRevision).toBe(before.sessionRevision)
      // 真的调用了 relay.connect()，不是只改状态
      expect(relay.connected).toBe(1)

      await direct.disconnect()
    })

    it('@core:relay 手机重连 → 直连恢复 → 升回 lan（升级不套宽限期）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const direct = new DirectChannel({ pairing, tls: await tlsMaterial() })
      const relay = fakeRelay({ up: true })

      let clock = 1_000_000
      const selector = new ChannelSelector({ direct, relay, now: () => clock, graceMs: 5_000 })
      await direct.connect()
      const device = pairPhone(pairing)

      // 先让选择器认为直连不可用 → 落到 relay
      expect(await selector.start()).toBe('relay')
      expect(selector.view().tier).toBe('relay')

      // 手机连上来
      const ws = await openSocket(direct.port() as number)
      await handshake(ws, pairing, device)

      clock += 1_000
      await selector.poll()
      expect(selector.view().tier).toBe('lan')
      expect(selector.view().chip).toBe('直连')

      ws.close()
      await direct.disconnect()
    })
  })

  // ───────────────────────── 重连补漏（本轮核心） ─────────────────────────

  describe('重连后 seq 补漏接得上（真 socket）', () => {
    it('@core:relay 断线期间的事件在重连后补齐，不重不漏', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()
      const device = pairPhone(pairing)

      const ws1 = await openSocket(ch.port() as number)
      await handshake(ws1, pairing, device)

      // 手机收到 seq 1、2
      ch.broadcast('event', { n: 1 })
      ch.broadcast('event', { n: 2 })
      await new Promise((r) => setTimeout(r, 100))

      // 手机断开
      ws1.close()
      await waitFor(() => ch.linkCount() === 0, 3000)

      // 断线期间服务端继续发事件
      ch.broadcast('event', { n: 3 })
      ch.broadcast('event', { n: 4 })

      // 手机带 lastSeq=2 重连
      const ws2 = await openSocket(ch.port() as number)
      const session2 = await handshake(ws2, pairing, device, 2)
      const { welcome } = session2

      // welcome 只报数量，事件本身随后逐条加密送达
      expect(welcome.replayCount).toBe(2)
      expect(welcome.snapshotRequired).toBeUndefined()
      expect(welcome.replay).toBeUndefined()

      const e3 = await nextEnvelope(session2)
      const e4 = await nextEnvelope(session2)
      expect([e3.seq, e4.seq]).toEqual([3, 4])
      expect(e3.body).toEqual({ n: 3 })

      ws2.close()
      await ch.disconnect()
    })

    it('@core:relay lastSeq 已是最新时补漏为 0 条（不是重复发一遍）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()
      const device = pairPhone(pairing)

      const ws1 = await openSocket(ch.port() as number)
      await handshake(ws1, pairing, device)
      ch.broadcast('event', { n: 1 })
      ch.broadcast('event', { n: 2 })
      ws1.close()
      await waitFor(() => ch.linkCount() === 0, 3000)

      const ws2 = await openSocket(ch.port() as number)
      const { welcome } = await handshake(ws2, pairing, device, 2)
      expect(welcome.replayCount).toBe(0)

      ws2.close()
      await ch.disconnect()
    })

    it('@core:relay lastSeq 太旧（超出缓冲）时返回 snapshot_required，而不是只发还留着的', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      // 缓冲只有 3 条，制造「挤出」场景
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial(), replayCapacity: 3 })
      await ch.connect()
      const device = pairPhone(pairing)

      const ws1 = await openSocket(ch.port() as number)
      await handshake(ws1, pairing, device)
      for (let i = 1; i <= 6; i++) ch.broadcast('event', { n: i })
      expect(ch.bufferLength()).toBe(3)

      ws1.close()
      await waitFor(() => ch.linkCount() === 0, 3000)

      // 手机只收到 1，2..6 里前面的已被挤出
      const ws2 = await openSocket(ch.port() as number)
      const { welcome } = await handshake(ws2, pairing, device, 1)

      expect(welcome.snapshotRequired).toBe('snapshot_required')
      expect(welcome.replayCount).toBeUndefined()
      expect(welcome.newestSeq).toBe(6)

      ws2.close()
      await ch.disconnect()
    })

    it('@core:relay 断线补齐后继续广播，seq 继续递增（不重号）', async () => {
      const pairing = new PairingService({ secret: randomBytes(32) })
      const ch = new DirectChannel({ pairing, tls: await tlsMaterial() })
      await ch.connect()
      const device = pairPhone(pairing)

      const ws1 = await openSocket(ch.port() as number)
      await handshake(ws1, pairing, device)
      ch.broadcast('event', { n: 1 })
      ws1.close()
      await waitFor(() => ch.linkCount() === 0, 3000)

      ch.broadcast('event', { n: 2 })

      const ws2 = await openSocket(ch.port() as number)
      const session3 = await handshake(ws2, pairing, device, 1)
      expect(session3.welcome.replayCount).toBe(1)
      expect((await nextEnvelope(session3)).seq).toBe(2)

      // 再广播一条，seq 必须是 3（且手机能解开）
      const third = nextEnvelope(session3)
      const sent = ch.broadcast('event', { n: 3 })
      expect(sent.seq).toBe(3)
      expect((await third).seq).toBe(3)

      ws2.close()
      await ch.disconnect()
    })
  })

  // ───────────────────────── 证书 ─────────────────────────

  describe('TLS 证书持久化', () => {
    it('@core:relay 同一 dataDir 两次载入得到同一张证书（重启不换证书）', async () => {
      const dir = newDir()
      const safe = fakeSafeStorage()
      const a = await loadOrCreateTls({ dataDir: dir, safeStorage: safe })
      const b = await loadOrCreateTls({ dataDir: dir, safeStorage: safe })
      expect(a.fingerprint).toBe(b.fingerprint)
      expect(a.cert).toBe(b.cert)
    })

    it('@core:relay 私钥加密落盘：文件里不含 PRIVATE KEY 明文', async () => {
      const dir = newDir()
      const safe = fakeSafeStorage()
      const material = await loadOrCreateTls({ dataDir: dir, safeStorage: safe })
      const { readFileSync } = require('node:fs')
      const raw = readFileSync(join(dir, 'relay', 'tls-key.bin'), 'utf8')
      expect(raw).not.toContain('PRIVATE KEY')
      expect(material.key).toContain('PRIVATE KEY')
    })

    it('@core:relay safeStorage 不可用时不落盘私钥（宁可用临时证书）', async () => {
      const dir = newDir()
      const safe = fakeSafeStorage(false)
      await loadOrCreateTls({ dataDir: dir, safeStorage: safe })
      const { existsSync } = require('node:fs')
      expect(existsSync(join(dir, 'relay', 'tls-key.bin'))).toBe(false)
    })

    it('@core:relay 证书含 127.0.0.1 与 morrow.local 两个 SAN（否则手机主机名校验失败）', async () => {
      const material = await tlsMaterial()
      const { X509Certificate } = require('node:crypto')
      const cert = new X509Certificate(material.cert)
      expect(cert.subjectAltName).toContain('127.0.0.1')
      expect(cert.subjectAltName).toContain('morrow.local')
    })
  })
})

// ───── 来源：tests/unit/relay-net-replay.test.ts ─────
/**
 * B3 第二批验收：Envelope + ReplayBuffer。
 */
describe('信封与断线重连', () => {
  const at = 1_700_000_000_000

  /** 造一个事件信封 */
  function ev(alloc: SeqAllocator, body: unknown, sessionId = 'ses_1'): Envelope {
    return makeEnvelope(alloc, 'event', { runId: 'run_1', sessionId, at }, body)
  }

  describe('信封结构（对齐蓝图 §5）', () => {
    it('@core:relay 字段与蓝图一致：v / kind / seq / runId / sessionId / at / body', () => {
      const alloc = new SeqAllocator()
      const e = ev(alloc, { text: 'hi' })
      expect(Object.keys(e).sort()).toEqual(['at', 'body', 'kind', 'runId', 'seq', 'sessionId', 'v'])
      expect(e.v).toBe(ENVELOPE_VERSION)
      expect(e.seq).toBe(1)
      expect(e.kind).toBe('event')
      expect(e.at).toBe(at)
    })

    it('@core:relay seq 从 1 开始单调递增，不跳号', () => {
      const alloc = new SeqAllocator()
      const seqs = Array.from({ length: 10 }, () => alloc.take())
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    it('@core:relay 四种 kind 都合法', () => {
      for (const kind of ['event', 'invoke', 'result', 'ack'] as const) {
        const e = makeEnvelope(new SeqAllocator(), kind, { at }, {})
        expect(isValidEnvelope(e)).toBe(true)
      }
    })

    it('@core:relay 非法信封被拒绝：版本错 / kind 错 / seq 非正整数 / at 非有限数', () => {
      const good = ev(new SeqAllocator(), {})

      expect(isValidEnvelope({ ...good, v: 2 })).toBe(false)
      expect(isValidEnvelope({ ...good, kind: 'unknown' })).toBe(false)
      expect(isValidEnvelope({ ...good, seq: 0 })).toBe(false)
      expect(isValidEnvelope({ ...good, seq: -1 })).toBe(false)
      expect(isValidEnvelope({ ...good, seq: 1.5 })).toBe(false)
      expect(isValidEnvelope({ ...good, at: NaN })).toBe(false)
      expect(isValidEnvelope({ ...good, at: Infinity })).toBe(false)
      expect(isValidEnvelope(null)).toBe(false)
      expect(isValidEnvelope('x')).toBe(false)
    })

    it('@core:relay 缺 body 字段也算不合法（不是「当空对象处理」）', () => {
      const alloc = new SeqAllocator()
      const e = ev(alloc, {})
      const { body, ...withoutBody } = e
      expect(isValidEnvelope(withoutBody)).toBe(false)
    })

    it('@core:relay requireEnvelope 抛 EnvelopeError 且带错误码', () => {
      try {
        requireEnvelope({ v: 99 })
        throw new Error('应当抛错')
      } catch (err) {
        expect(err).toBeInstanceOf(EnvelopeError)
        expect((err as EnvelopeError).code).toBe(ENVELOPE_INVALID)
      }
    })
  })

  describe('seq 连续性判定', () => {
    it('@core:relay 连续 / 重复 / 跳号三种结果', () => {
      expect(checkSeq(5, 5)).toEqual({ ok: true })
      expect(checkSeq(5, 4)).toEqual({ ok: false, duplicate: true })
      expect(checkSeq(5, 8)).toEqual({ ok: false, gap: 3 })
    })
  })

  // ───────────────── 蓝图验收 1：断网 30 秒重连，不重不漏 ─────────────────

  describe('验收 1：断网 30 秒后重连，事件不重不漏', () => {
    it('@core:relay 断线期间产生 42 条事件，重连后全部补齐且顺序正确', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer()

      // 断线前：服务端发了 10 条，客户端都收到了
      const before: Envelope[] = []
      for (let i = 0; i < 10; i++) {
        const e = ev(alloc, { n: i })
        buf.push(e)
        before.push(e)
      }
      const client = new ReconnectTracker(10) // 客户端收到 seq=10

      // 断网 30 秒：服务端继续产生 42 条，客户端一条没收到
      const during: Envelope[] = []
      for (let i = 0; i < 42; i++) {
        const e = ev(alloc, { n: 10 + i })
        buf.push(e)
        during.push(e)
      }

      // 重连：客户端带 lastSeq=10 请求补漏
      const result = buf.replay(client.current())
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('应当可以补齐')

      // 不漏：42 条一条不少
      expect(result.events).toHaveLength(42)
      expect(result.events.map((e) => e.seq)).toEqual(during.map((e) => e.seq))

      // 不重：不与已收到的 10 条重叠
      const beforeSeqs = new Set(before.map((e) => e.seq))
      expect(result.events.every((e) => !beforeSeqs.has(e.seq))).toBe(true)

      // 客户端应用补漏后，lastSeq 推进到最新
      client.applyReplay(result.events)
      expect(client.current()).toBe(52)
    })

    it('@core:relay 按 seq 顺序逐条投递，全程无重复无跳号', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer()

      // 服务端连续发 100 条
      for (let i = 0; i < 100; i++) buf.push(ev(alloc, { i }))

      // 客户端从头开始接收，中途「断线」在第 40 条之后
      const client = new ReconnectTracker(0)
      const received: number[] = []

      // 在线阶段：收 1..40
      for (let seq = 1; seq <= 40; seq++) {
        const r = client.receive(seq)
        expect(r.accept).toBe(true)
        received.push(seq)
      }

      // 断线：41..100 没收到
      // 重连补漏
      const rep = buf.replay(client.current())
      expect(rep.ok).toBe(true)
      if (!rep.ok) throw new Error('应当可以补齐')
      client.applyReplay(rep.events)
      for (const e of rep.events) received.push(e.seq)

      // 不重不漏：1..100 各出现一次
      expect(received).toHaveLength(100)
      expect(new Set(received).size).toBe(100)
      expect(received).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    })

    it('@core:relay 重复投递被识别并丢弃（不重）', () => {
      const client = new ReconnectTracker(10)
      // 同一条又来一次
      expect(client.receive(10)).toEqual({ accept: false, duplicate: true })
      // 老的更早的
      expect(client.receive(3)).toEqual({ accept: false, duplicate: true })
      expect(client.current()).toBe(10)
    })

    it('@core:relay 跳号时 lastSeq 不推进（否则会永久丢事件）', () => {
      const client = new ReconnectTracker(10)
      const r = client.receive(15) // 缺了 11..14
      expect(r).toEqual({ accept: false, gap: 4 })
      // 关键：没有推进
      expect(client.current()).toBe(10)
    })

    it('@core:relay lastSeq 等于最新序号时返回空数组（已同步，不是错误）', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer()
      for (let i = 0; i < 5; i++) buf.push(ev(alloc, { i }))

      const r = buf.replay(5)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.events).toEqual([])
    })
  })

  // ───────────────── 蓝图验收 3：ring buffer 溢出 → snapshot_required ─────────────────

  describe('验收 3：ring buffer 溢出返回 snapshot_required', () => {
    it('@core:relay 容量默认 2000（蓝图原文）', () => {
      expect(DEFAULT_BUFFER_CAPACITY).toBe(2000)
      expect(new ReplayBuffer().limit()).toBe(2000)
    })

    it('@core:relay 写入 2000 条后仍在容量内', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer()
      for (let i = 0; i < 2000; i++) buf.push(ev(alloc, { i }))
      expect(buf.length()).toBe(2000)
      expect(buf.oldestSeq()).toBe(1)
      expect(buf.newestSeq()).toBe(2000)
    })

    it('@core:relay 超出容量后最旧的被挤出，内存不增长', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer({ capacity: 5 })
      for (let i = 0; i < 8; i++) buf.push(ev(alloc, { i }))

      expect(buf.length()).toBe(5) // 恒定
      expect(buf.oldestSeq()).toBe(4) // 1,2,3 被挤出
      expect(buf.newestSeq()).toBe(8)
    })

    it('@core:relay lastSeq 太旧（已被挤出）→ snapshot_required，而不是静默丢弃', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer({ capacity: 5 })
      for (let i = 0; i < 8; i++) buf.push(ev(alloc, { i }))

      // 客户端只收到 seq=2，但缓冲从 4 开始 → 3 永远找不回来
      const r = buf.replay(2)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe(SNAPSHOT_REQUIRED)
        expect(r.message).toContain('快照')
      }
    })

    it('@core:relay 边界：lastSeq 恰好等于 oldest-1 时可以补齐（不该误报降级）', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer({ capacity: 5 })
      for (let i = 0; i < 8; i++) buf.push(ev(alloc, { i }))
      // oldest = 4，客户端收到 3 → 缓冲里 4..8 正好接上
      const r = buf.replay(3)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.events.map((e) => e.seq)).toEqual([4, 5, 6, 7, 8])
    })

    it('@core:relay 缓冲为空时也返回 snapshot_required（没东西可补）', () => {
      const buf = new ReplayBuffer()
      const r = buf.replay(0)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe(SNAPSHOT_REQUIRED)
    })

    it('@core:relay 大容量下环形缓冲仍然正确（跨越回绕点多次）', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer({ capacity: 10 })
      // 写 35 条，回绕 3 次多
      for (let i = 0; i < 35; i++) buf.push(ev(alloc, { i }))

      expect(buf.length()).toBe(10)
      expect(buf.oldestSeq()).toBe(26)
      expect(buf.newestSeq()).toBe(35)

      // 按序取出验证
      expect(buf.toArray().map((e) => e.seq)).toEqual([26, 27, 28, 29, 30, 31, 32, 33, 34, 35])
    })

    it('@core:relay lastSeq 非法（负数/非整数）拒绝', () => {
      const buf = new ReplayBuffer()
      expect(buf.replay(-1).ok).toBe(false)
      expect(buf.replay(1.5).ok).toBe(false)
    })
  })

  // ───────────────── 组合场景 ─────────────────

  describe('组合：溢出场景下的完整恢复流程', () => {
    it('@core:relay 断线太久导致溢出 → 客户端收到降级信号 → 快照重置后继续增量', () => {
      const alloc = new SeqAllocator()
      const buf = new ReplayBuffer({ capacity: 5 })
      const client = new ReconnectTracker(2)

      // 服务端发 10 条，客户端只收到 2
      for (let i = 0; i < 10; i++) buf.push(ev(alloc, { i }))

      // 重连带 lastSeq=2 → 补不齐
      const r = buf.replay(client.current())
      expect(r.ok).toBe(false)

      // 客户端走快照：快照带最新 seq
      const snapshotSeq = buf.newestSeq() as number
      client.resetTo(snapshotSeq)
      expect(client.current()).toBe(10)

      // 之后继续增量，正常接收
      buf.push(ev(alloc, { i: 10 })) // seq=11
      const next = client.receive(11)
      expect(next.accept).toBe(true)
    })
  })
})

// ───── 来源：tests/unit/relay-poller.test.ts ─────
/**
 * B3 第五批（续）：自动轮询调度器。
 * 四个必须守住的点：
 */
describe('通道轮询调度器', () => {
  /** 只实现 poll/tier 的最小 selector 替身；poller 只用这两个 */
  function fakeSelector(options: { delayMs?: number; failWith?: Error } = {}) {
    const state = {
      calls: 0,
      inFlight: 0,
      maxInFlight: 0,
      tier: null as Tier | null,
      async poll() {
        state.calls++
        state.inFlight++
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        try {
          if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
          if (options.failWith) throw options.failWith
        } finally {
          state.inFlight--
        }
      },
      tier_() {
        return state.tier
      }
    }
    // poller 用 selector.poll() 与 selector.tier()
    const proxy = {
      poll: state.poll,
      tier: (): Tier | null => state.tier,
      view: (): ChannelView => ({ tier: state.tier, chip: '', sessionRevision: 0, offline: state.tier === null })
    }
    return { proxy: proxy as unknown as ChannelSelector, state }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('到点真的调用 poll', () => {
    it('@core:relay 1 秒后第一次 poll，2 秒后第二次', async () => {
      vi.useFakeTimers()
      const { proxy, state } = fakeSelector()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()
      expect(state.calls).toBe(0)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.calls).toBe(1)
      expect(poller.ticks()).toBe(1)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.calls).toBe(2)

      poller.stop()
    })

    it('@core:relay stop 后不再 poll', async () => {
      vi.useFakeTimers()
      const { proxy, state } = fakeSelector()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.calls).toBe(1)

      poller.stop()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(state.calls).toBe(1)
    })

    it('@core:relay tickNow 立即执行一次，不等定时器', async () => {
      const { proxy, state } = fakeSelector()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 60_000 })
      await poller.tickNow()
      expect(state.calls).toBe(1)
    })
  })

  describe('幂等与不重叠', () => {
    it('@core:relay 重复 start 不产生第二个定时器', async () => {
      vi.useFakeTimers()
      const { proxy, state } = fakeSelector()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()
      poller.start()
      poller.start()

      await vi.advanceTimersByTimeAsync(1_000)
      // 若产生多个定时器，这里会是 3
      expect(state.calls).toBe(1)
      poller.stop()
    })

    it('@core:relay 慢 poll（超过间隔）不堆积：任意时刻最多一个在途', async () => {
      vi.useFakeTimers()
      // 每次 poll 花 2.5 秒，而间隔只有 1 秒
      const { proxy, state } = fakeSelector({ delayMs: 2_500 })
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()

      // 推进 10 秒（若用 setInterval 会产生约 10 个并发 poll）
      await vi.advanceTimersByTimeAsync(10_000)

      expect(state.maxInFlight).toBe(1)
      expect(state.calls).toBeLessThanOrEqual(4)
      poller.stop()
    })

    it('@core:relay poll 抛错不会让轮询停摆，错误被记录下来', async () => {
      vi.useFakeTimers()
      const { proxy, state } = fakeSelector({ failWith: new Error('探测炸了') })
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(poller.error()).toBe('探测炸了')
      expect(state.calls).toBe(1)

      // 下一轮仍会执行 —— 一次失败不该让整个通道检查停掉
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.calls).toBe(2)
      poller.stop()
    })
  })

  describe('不泄漏定时器（最关键）', () => {
    it('@core:relay start → stop 后没有待执行定时器', () => {
      const { proxy } = fakeSelector()

      vi.useFakeTimers()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()
      expect(poller.pending()).toBe(true)
      poller.stop()
      expect(poller.pending()).toBe(false)
      expect(poller.isRunning()).toBe(false)
    })

    it('@core:relay 反复 start/stop 20 次后只剩 0 个定时器', () => {
      vi.useFakeTimers()
      const { proxy } = fakeSelector()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })

      for (let i = 0; i < 20; i++) {
        poller.start()
        expect(poller.pending()).toBe(true)
        poller.stop()
        expect(poller.pending()).toBe(false)
      }
      expect(vi.getTimerCount()).toBe(0)
    })

    it('@core:relay stop 时正在执行的 poll 完成后不再排下一轮（不会「停了还在跑」）', async () => {
      vi.useFakeTimers()
      const { proxy, state } = fakeSelector({ delayMs: 2_000 })
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
      poller.start()

      // 推进 1 秒：poll 开始（会跑 2 秒）
      await vi.advanceTimersByTimeAsync(1_000)
      expect(state.calls).toBe(1)

      // 在它还没跑完时 stop
      poller.stop()
      // 再推进很久：在途 poll 结束，但不该排下一轮
      await vi.advanceTimersByTimeAsync(20_000)

      expect(state.calls).toBe(1)
      expect(poller.pending()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('@core:relay 不 pin 住进程：定时器已 unref', async () => {
      // 直接检查真实定时器的 hasRef 状态（不借助假时钟）
      const { proxy } = fakeSelector()
      const poller = new ChannelPoller({ selector: proxy, intervalMs: 60_000 })
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
      poller.start()
      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
      // unref 后不该出现在 "active" 列表里
      expect(after).toBe(before)
      poller.stop()
    })
  })

  describe('参数校验', () => {
    it('@core:relay 间隔 <= 0 时构造失败（避免忙等）', () => {
      const { proxy } = fakeSelector()
      expect(() => new ChannelPoller({ selector: proxy, intervalMs: 0 })).toThrow(/正数/)
      expect(() => new ChannelPoller({ selector: proxy, intervalMs: -1 })).toThrow(/正数/)
    })
  })
})
