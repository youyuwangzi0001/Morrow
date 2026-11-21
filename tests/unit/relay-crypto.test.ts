/**
 * relay 加密域单测：应用层加密帧（HKDF + AES-256-GCM + 防重放）与真 socket 上的端到端加密。
 * 
 * 由 relay-secure-frame / relay-e2e-encrypted 两个文件合并；
 * 每个 it 的标题与断言原样保留，各来源的文件级说明保留在对应段前。
 */
import { randomBytes, createECDH } from 'node:crypto'
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { FRAME_MALFORMED, FRAME_REPLAYED, FRAME_TAMPERED, FrameError, SecureChannel, newConnectionSalt, sameBytes, ENVELOPE_VERSION, loadOrCreateTls, type TlsMaterial } from '../../src/main/relay-crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { CLOSE_REPLAYED, CLOSE_TAMPERED, DirectChannel } from '../../src/main/relay-channel'
import { PairingService } from '../../src/main/relay-pairing'

// ───── 来源：tests/unit/relay-secure-frame.test.ts ─────
/**
 * B3 第六批验收：应用层加密帧。
 *
 * 这批要兑现的技术承诺（蓝图 Tier 2 原文）：
 *
 * > 中继只转发密文，无法解密内容
 *
 * TLS 做不到这件事 —— 中继是 TLS 的终点，明文在它手上。
 * 必须再套一层只有手机与桌面知道密钥的加密。
 *
 * 测试的重点不是「加密能解开」（那只证明 API 接对了），
 * 而是**攻击者能做的一切都必须失败**：
 * - 篡改密文一个字节
 * - 重放旧帧
 * - 把 A 设备的密文挂到 B 设备名下
 * - 把手机发来的帧反射回手机
 * - 丢掉 salt 让重连后计数器归零（GCM nonce 重用 = 泄露明文异或值）
 */
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
 *
 * `secure-frame.test.ts` 证明「密码学原语是对的」，
 * 这里证明「它真的接在线上了」—— 两件事完全不同。
 * 本批之前有过教训：组件全绿但生产入口没调用。
 *
 * 三个「只有真 socket 才能验证」的事实：
 * 1. **线上字节里搜不到明文**（中继转发时看到的就是这些字节）
 * 2. 篡改帧 → 服务端断开（4402），不是静默丢弃
 * 3. 重放旧帧 → 服务端断开（4403）
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
