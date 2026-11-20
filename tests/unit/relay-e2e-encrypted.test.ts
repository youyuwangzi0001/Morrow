import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  CLOSE_REPLAYED,
  CLOSE_TAMPERED,
  DirectChannel
} from '../../src/relay/net/direct-channel'
import { ENVELOPE_VERSION } from '../../src/relay/net/envelope'
import { SecureChannel } from '../../src/relay/net/secure-frame'
import { loadOrCreateTls, type TlsMaterial } from '../../src/relay/net/tls'
import { PairingService } from '../../src/relay/pairing'

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
