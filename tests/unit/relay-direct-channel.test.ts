import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ChannelSelector, type TierChannel } from '../../src/relay/net/channel'
import { CLOSE_UNAUTHORIZED, DirectChannel } from '../../src/relay/net/direct-channel'
import { ENVELOPE_VERSION, type Envelope } from '../../src/relay/net/envelope'
import { loadOrCreateTls, type TlsMaterial } from '../../src/relay/net/tls'
import { SecureChannel } from '../../src/relay/net/secure-frame'
import { PairingService } from '../../src/relay/pairing'
import type { SafeStorageLike } from '../../src/relay/keystore'

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
