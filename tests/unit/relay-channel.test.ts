/**
 * relay 通道域单测：三级通道选择与降级、局域网直连（真 WSS）、信封与断线重连、轮询调度器。
 * 
 * 由 relay-channel / relay-direct-channel / relay-net-replay / relay-poller 四个文件合并；
 * 每个 it 的标题与断言原样保留，各来源的文件级说明保留在对应段前。
 * 每段各自包一层 describe，使原文件级的 beforeEach/afterEach 只作用于本域用例。
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { ChannelSelector, DEGRADE_WINDOW_MS, TIER_LABELS, envelopeMeta, looksLikeCiphertext, requireCiphertext, type TierChannel, CLOSE_UNAUTHORIZED, DirectChannel, DEFAULT_BUFFER_CAPACITY, ReconnectTracker, ReplayBuffer, SNAPSHOT_REQUIRED, type ChannelView, type Tier, ChannelPoller } from '../../src/main/relay-channel'
import { makeEnvelope, SeqAllocator, ENVELOPE_VERSION, type Envelope, loadOrCreateTls, type TlsMaterial, SecureChannel, ENVELOPE_INVALID, EnvelopeError, checkSeq, isValidEnvelope, requireEnvelope } from '../../src/main/relay-crypto'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { PairingService, type SafeStorageLike } from '../../src/main/relay-pairing'

// ───── 来源：tests/unit/relay-channel.test.ts ─────
/**
 * B3 第三批验收：三级通道回退。
 *
 * 蓝图验收原文：
 * > 强制关掉 mDNS 后 **5 秒内**降级到中继且 **UI 只变 chip 文案**
 *
 * 拆成两个独立断言：
 * 1. 时间：关掉 mDNS 后 5 秒内必须切到 relay（不是 6 秒、不是永不）
 * 2. UI：切通道**不改变 sessionRevision**（内容版本），只有 chip 变
 *
 * 另加两条蓝图提到但没写进验收的：
 * 3. 宽限期：丢一次包不该立刻切（否则 chip 抖动比降级更烦）
 * 4. 中继只转发密文：明文发往中继时必须被拦下
 */
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
 *
 * 与前四批的根本区别：**这里不再有假通道**。
 * 前几批的 `ChannelSelector` 测的是注入的 stub，逻辑对但没接过真网 ——
 * 「close 时降级」这件事从来没在真实 socket 上验证过。
 *
 * 本文件用本地回环起一个真 HTTPS/WSS 服务、真 TLS 握手、真 JSON 帧，
 * 验证三件事：
 * 1. 未鉴权连接被拒（同网段任何人不能偷看）
 * 2. 已鉴权连接断开时，`probe()` 真的变 false，选择器真的降级
 * 3. 重连后 lastSeq 补漏接得上，且超出缓冲时明确要 snapshot
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
   *
   * 为什么需要：服务端在 welcome 之后会**紧接着**把补漏事件逐条加密发出。
   * 如果等到「读完 welcome 才挂 message 监听」，那几条事件已经在没有监听器时
   * 触发过 `message`、被丢弃了 —— 表现为「帧超时」。
   *
   * 真实手机端也不会这么写：它一定是连接建立后就挂上常驻监听、
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
 *
 * 蓝图两条验收原文：
 * 1. 断网 30 秒后重连，事件不重不漏（用 seq 连续性脚本验证）
 * 3. ring buffer 溢出时正确返回 snapshot_required
 *
 * 验收 1 的「不重不漏」不是一句口号，它要同时满足三件事：
 * - 断线期间产生的事件，重连后一条不少地补上（不漏）；
 * - 补上过程中不重复投递（不重）；
 * - 客户端侧的 lastSeq 在补漏后正确推进，不会二次补同一条。
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
 *
 * 为什么单独测它：`ChannelSelector.poll()` 是「检查一次」，节奏由外部决定。
 * 没有调度器，宽限期永远不会被评估 —— 用户把手机 Wi-Fi 关掉，
 * chip 会一直停在「直连」，因为没人去 poll。
 *
 * 这类「缺一根线」的缺陷最容易被忽略：选择器逻辑全对、测试全绿，
 * 但功能在真实应用里不工作。B3 第一批就踩过一模一样的坑
 * （index.ts 调 startRelay 忘了传 pairing，整套配对一次没执行过）。
 *
 * 四个必须守住的点：
 * 1. 到点真的调用 poll
 * 2. start 幂等（不会产生第二个定时器）
 * 3. 慢 poll 不堆积（不重叠执行）
 * 4. 多次 start/stop 不泄漏定时器
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
