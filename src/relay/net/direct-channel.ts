import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { makeEnvelope, SeqAllocator, type Envelope, ENVELOPE_VERSION } from './envelope'
import { ReplayBuffer, SNAPSHOT_REQUIRED } from './replay-buffer'
import type { Tier, TierChannel } from './channel'
import { FRAME_REPLAYED, FRAME_TAMPERED, SecureChannel, newConnectionSalt } from './secure-frame'
import { type TlsMaterial } from './tls'
import type { PairingService } from '../pairing'

/**
 * Tier 1：局域网直连（WSS over LAN）。
 *
 * 这是三级回退里最快的一级，也是**唯一真实存在的网络通道** ——
 * 在此之前 `ChannelSelector` 测的都是注入的假实现，通道切换逻辑正确但没接过真网。
 *
 * ## probe() 的语义（必须写清楚，否则会被误用）
 *
 * `probe()` 回答的是：**「此刻能否通过局域网这条路径通信」**，
 * 判定为 `监听正常 && 至少有一台已鉴权的手机连着`。
 *
 * 为什么把「有手机连着」算进来，而不是只看监听端口：
 *
 * - 桌面刚启动、手机还没连上时，局域网路径**确实没有在承载任何通信**。
 *   此时 `probe()` 返回 true 会让选择器停在「直连」并显示「直连」chip，
 *   而用户的手机其实是从中继过来的 —— 那是**界面说谎**。
 * - 反过来，端口在监听但手机掉了，如果仍报 true，就会一直显示「直连」，
 *   用户看着一个早已断开的通道。这正是 B3 第三批宽限期机制要处理的场景。
 *
 * 代价是：冷启动时选择器会先落在 relay/push，等手机真连上再升级到 lan。
 * 这是**正确的**顺序 —— 升级不套宽限期（见 channel.ts 的 poll），所以用户几乎无感，
 * 而绝不会看到「明明没连上却显示直连」。
 *
 * ## 与配对的关系
 *
 * 每条连接的第一帧必须是 `hello`，带 `deviceId + ts + sig`，
 * 用 B2 的 `verifyRequest()` 校验。**没有通过 hello 的连接不收任何事件** ——
 * 否则同网段的任何人都能连上来看桌面的活动流。
 *
 * ## 断线补漏
 *
 * 服务端把发出去的信封写进 `ReplayBuffer`。手机重连时在 hello 里带上 `lastSeq`，
 * 服务端把缺的补上；如果 gap 已超出缓冲，回 `snapshot_required` 让手机拉全量 ——
 * 绝不「只发还留着的」假装补齐（那会让手机永久少一段，且不会自愈）。
 */

/** 未鉴权的连接最多活这么久，防止占着连接不发 hello */
const HELLO_TIMEOUT_MS = 5_000

/** 关闭码：鉴权失败。手机据此区分「密码错」和「网络断」 */
export const CLOSE_UNAUTHORIZED = 4401
/** 关闭码：加密帧认证失败（密文被改过） */
export const CLOSE_TAMPERED = 4402
/** 关闭码：检测到重放（旧帧或乱序帧） */
export const CLOSE_REPLAYED = 4403

export interface DirectChannelOptions {
  /** 配对服务，用于校验 hello 里的签名 */
  pairing: PairingService
  /** TLS 材料（证书 + 加密私钥，见 tls.ts） */
  tls: TlsMaterial
  /** 监听端口，0 或省略 = 由系统分配 */
  port?: number
  /** 监听地址。**默认 0.0.0.0** —— 这是要接受局域网内手机连接的，
   * 与 B1 的 relay HTTP（只监听回环）性质不同，不能混淆。 */
  host?: string
  /** 环形缓冲容量，默认 2000（蓝图原文） */
  replayCapacity?: number
  /** 注入时钟 */
  now?: () => number
  /** 每条帧的日志钩子（测试与诊断用；生产不传） */
  onFrame?: (dir: 'in' | 'out', summary: string) => void
}

interface ClientState {
  socket: WebSocket
  deviceId: string | null
  /** hello 超时计时器，鉴权成功后清除 */
  helloTimer: NodeJS.Timeout | null
  /**
   * 应用层加密通道。**每条连接一份**（salt 不同 → 密钥不同）。
   *
   * 为 null 表示还没完成 hello。鉴权成功后立即建，此后所有帧都走它。
   */
  channel: SecureChannel | null
  /** 本连接下发的随机 salt（base64）。手机用它 + sessionKey 派生同一套密钥 */
  salt: string | null
}

export class DirectChannel implements TierChannel {
  readonly tier: Tier = 'lan'

  private readonly pairing: PairingService
  private readonly tls: TlsMaterial
  private readonly wantPort: number
  private readonly host: string
  private readonly now: () => number
  private readonly onFrame?: (dir: 'in' | 'out', summary: string) => void

  private readonly replay: ReplayBuffer
  private readonly seq = new SeqAllocator()
  private readonly clients = new Set<ClientState>()

  private server: HttpsServer | null = null
  private wss: WebSocketServer | null = null
  private actualPort: number | null = null
  /** 监听本身出错（端口被占、证书无效…）。为 true 时 probe 必为 false */
  private broken = false
  private lastError: string | null = null

  constructor(options: DirectChannelOptions) {
    this.pairing = options.pairing
    this.tls = options.tls
    this.wantPort = options.port ?? 0
    this.host = options.host ?? '0.0.0.0'
    this.now = options.now ?? Date.now
    this.onFrame = options.onFrame
    this.replay = new ReplayBuffer({ capacity: options.replayCapacity })
  }

  // ───────────────────────── TierChannel ─────────────────────────

  /**
   * 是否可以走局域网。
   *
   * 见文件头注释：监听正常 + 至少一条已鉴权连接。
   */
  async probe(): Promise<boolean> {
    if (this.broken) return false
    if (!this.server?.listening) return false
    for (const c of this.clients) {
      if (c.deviceId !== null && c.socket.readyState === c.socket.OPEN) return true
    }
    return false
  }

  /** 启动监听。已启动则幂等返回。 */
  async connect(): Promise<void> {
    if (this.server?.listening) return
    if (this.broken) {
      // 上一次失败过：允许重试一次（端口可能已被释放）
      this.broken = false
      this.lastError = null
    }
    await this.listen()
  }

  /** 停止监听并断开所有连接 */
  async disconnect(): Promise<void> {
    for (const c of this.clients) {
      if (c.helloTimer) clearTimeout(c.helloTimer)
      try {
        c.socket.close(1001, 'server shutting down')
      } catch {
        // 已断开的 socket 再 close 会抛，忽略
      }
    }
    this.clients.clear()

    const wss = this.wss
    const server = this.server
    this.wss = null
    this.server = null
    this.actualPort = null

    await new Promise<void>((resolve) => {
      if (wss) {
        wss.close(() => {
          if (server) server.close(() => resolve())
          else resolve()
        })
      } else if (server) {
        server.close(() => resolve())
      } else resolve()
    })
  }

  // ───────────────────────── 对外读取 ─────────────────────────

  /** 实际监听端口（未启动时为 null） */
  port(): number | null {
    return this.actualPort
  }

  /** 当前已鉴权的连接数 */
  linkCount(): number {
    let n = 0
    for (const c of this.clients) if (c.deviceId !== null) n++
    return n
  }

  /**
   * 当前持有的连接对象总数（含未鉴权）。
   *
   * 为什么需要暴露它：`linkCount()` 只数已鉴权的，而「断开后有没有把对象丢掉」
   * 是另一件事。如果 `close` 事件里忘了 `clients.delete(state)`，
   * `probe()` 仍然正确（它检查 `readyState`，死 socket 不算），
   * 但集合会随每次连接无限增长 —— 用户一天开关手机几十次，
   * 每个死连接都持有 socket 与缓冲区，长期运行就是内存泄漏，
   * 且 `broadcast()` 每次都要遍历一遍死对象。
   *
   * 这类缺陷不会让任何功能报错，只会让应用越用越慢 ——
   * 所以必须有测试直接数这个数字。
   */
  connectionCount(): number {
    return this.clients.size
  }

  /** 证书指纹（配对时交给手机固定） */
  fingerprint(): string {
    return this.tls.fingerprint
  }

  /** 上次监听错误（诊断用） */
  error(): string | null {
    return this.lastError
  }

  /** 缓冲里当前存了多少条（测试用） */
  bufferLength(): number {
    return this.replay.length()
  }

  // ───────────────────────── 发送 ─────────────────────────

  /**
   * 广播一条事件给所有已鉴权连接，同时写入补漏缓冲。
   *
   * 顺序很重要：**先写缓冲再发送**。反过来的话，如果发送过程中手机断线，
   * 重连时它报的 lastSeq 会大于缓冲里的最新序号，补漏直接判「已是最新」，
   * 那条事件就永久丢了。
   */
  broadcast(kind: 'event' | 'result' | 'ack', body: unknown, meta: { runId?: string; sessionId?: string } = {}): Envelope {
    const envelope = makeEnvelope(this.seq, kind, { at: this.now(), ...meta }, body)
    this.replay.push(envelope)
    for (const c of this.clients) {
      if (c.deviceId === null || !c.channel) continue
      if (c.socket.readyState !== c.socket.OPEN) continue
      // 逐连接加密：salt 不同 → 每条连接的密文都不同。
      // 这既满足「中继只转发密文」，也让「抓一条帧重放给另一台设备」失效。
      const frame = c.channel.seal('desktop-to-phone', JSON.stringify(envelope))
      this.onFrame?.('out', `seq=${envelope.seq} kind=${kind}`)
      c.socket.send(JSON.stringify(frame))
    }
    return envelope
  }

  // ───────────────────────── 内部：起服务 ─────────────────────────

  private async listen(): Promise<void> {
    const server = createHttpsServer({ key: this.tls.key, cert: this.tls.cert })
    const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 })

    server.on('error', (err: Error) => {
      this.broken = true
      this.lastError = err.message
    })

    wss.on('connection', (socket: WebSocket) => this.accept(socket))

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.broken = true
        this.lastError = err.message
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.wantPort, this.host)
    })

    const address = server.address() as AddressInfo | null
    this.actualPort = address?.port ?? null
    this.server = server
    this.wss = wss
  }

  // ───────────────────────── 内部：单条连接 ─────────────────────────

  private accept(socket: WebSocket): void {
    const state: ClientState = { socket, deviceId: null, helloTimer: null, channel: null, salt: null }

    // 未在时限内发 hello 的连接直接关闭。
    // 没有这个的话，同网段任何人都能连上来占着连接池（占位攻击）。
    state.helloTimer = setTimeout(() => {
      if (state.deviceId === null) {
        try {
          socket.close(CLOSE_UNAUTHORIZED, 'hello timeout')
        } catch {
          // 已断开
        }
      }
    }, HELLO_TIMEOUT_MS)
    state.helloTimer.unref()

    this.clients.add(state)

    socket.on('message', (raw: Buffer | string) => {
      try {
        this.handle(state, raw.toString())
      } catch (err) {
        this.onFrame?.('in', `handle failed: ${(err as Error).message}`)
      }
    })

    const drop = (): void => {
      if (state.helloTimer) clearTimeout(state.helloTimer)
      this.clients.delete(state)
    }
    socket.on('close', drop)
    socket.on('error', () => {
      drop()
      // 单条连接出错不影响监听本身：probe() 会因为 linkCount 变化而返回 false，
      // 由 ChannelSelector 的宽限期决定何时降级。
    })
  }

  private handle(state: ClientState, text: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      state.socket.close(CLOSE_UNAUTHORIZED, 'malformed frame')
      return
    }

    if (state.deviceId === null) {
      this.handleHello(state, frame)
      return
    }

    // ── 已鉴权：此后的每一帧都必须是加密帧 ──
    // 明文帧（哪怕是 {kind:'ack'}）一律视为攻击：能发明文说明对面没在加密，
    // 而「中继只转发密文」的承诺要求这条信道上的内容是密文。
    const channel = state.channel
    if (!channel) {
      state.socket.close(CLOSE_UNAUTHORIZED, 'channel not ready')
      return
    }

    let plain: Buffer
    try {
      plain = channel.open('phone-to-desktop', frame)
    } catch (err) {
      const code = (err as { code?: string }).code
      // 篡改与重放都是明确的攻击信号或协议违例：断开，不静默丢弃。
      // 静默丢弃会让攻击者能无限次试探而不被察觉。
      if (code === FRAME_TAMPERED || code === FRAME_REPLAYED) {
        this.onFrame?.('in', `frame rejected: ${code}`)
        state.socket.close(code === FRAME_REPLAYED ? CLOSE_REPLAYED : CLOSE_TAMPERED, code.toLowerCase())
        return
      }
      state.socket.close(CLOSE_UNAUTHORIZED, 'malformed secure frame')
      return
    }

    let inner: Record<string, unknown>
    try {
      inner = JSON.parse(plain.toString('utf8')) as Record<string, unknown>
    } catch {
      state.socket.close(CLOSE_UNAUTHORIZED, 'malformed payload')
      return
    }

    // 已鉴权连接只接受 ack（推进已确认序号），其他帧忽略。
    // 手机不向桌面推事件（桌面是权威源），所以这里没有上行分支。
    if (inner.kind === 'ack') {
      this.onFrame?.('in', `ack seq=${String(inner.seq)}`)
    }
  }

  private handleHello(state: ClientState, frame: Record<string, unknown>): void {
    if (frame.kind !== 'hello') {
      state.socket.close(CLOSE_UNAUTHORIZED, 'expect hello first')
      return
    }
    if (frame.v !== ENVELOPE_VERSION) {
      state.socket.close(CLOSE_UNAUTHORIZED, 'bad protocol version')
      return
    }

    const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId : ''
    const ts = typeof frame.ts === 'string' ? frame.ts : ''
    const sig = typeof frame.sig === 'string' ? frame.sig : ''

    try {
      // 复用 B2 的签名校验：绑定 deviceId + channel + timestamp
      this.pairing.verifyRequest(deviceId, 'lan', ts, sig)
    } catch (err) {
      this.onFrame?.('in', `hello rejected: ${(err as Error).message}`)
      state.socket.close(CLOSE_UNAUTHORIZED, 'unauthorized')
      return
    }

    // 必须先清计时器再置 deviceId，否则可能刚好在两者之间被 timeout 关掉
    if (state.helloTimer) {
      clearTimeout(state.helloTimer)
      state.helloTimer = null
    }
    state.deviceId = deviceId

    // ── 建立应用层加密通道 ──
    // salt 每条连接新生成：重连时计数器从 0 开始，若密钥不变会与旧连接
    // 撞上同一个 GCM nonce（重用 nonce 直接泄露明文异或值）。
    const salt = newConnectionSalt()
    const device = this.pairing.requirePaired(deviceId)
    state.salt = salt
    state.channel = new SecureChannel({
      sessionKey: device.sessionKey,
      connectionSalt: salt,
      deviceId
    })

    const lastSeq = typeof frame.lastSeq === 'number' ? frame.lastSeq : 0
    const result = this.replay.replay(lastSeq)

    /**
     * welcome 必须**不含任何载荷**。
     *
     * 初版把 `replay: result.events` 直接放进了 welcome —— 那是个真实漏洞：
     * welcome 是明文下发的（手机此时还没有 salt，无法解密），
     * 于是补漏事件的全部内容（代码、路径、对话）会以明文经过中继。
     * 「中继只转发密文」当场破功。
     *
     * 改成：welcome 只带元数据 + `replayCount`，事件本身随后用加密帧逐条发。
     */
    const welcome = {
      v: ENVELOPE_VERSION,
      kind: 'welcome',
      deviceId,
      fingerprint: this.tls.fingerprint,
      salt,
      newestSeq: this.replay.newestSeq() ?? 0,
      ...(result.ok ? { replayCount: result.events.length } : { snapshotRequired: SNAPSHOT_REQUIRED })
    }

    state.socket.send(JSON.stringify(welcome))
    this.onFrame?.(
      'out',
      result.ok ? `welcome ${deviceId} replay=${result.events.length}` : `welcome ${deviceId} snapshot_required`
    )

    // 补漏事件逐条加密下发（顺序与 seq 一致）
    if (result.ok) {
      for (const event of result.events) {
        const sealed = state.channel.seal('desktop-to-phone', JSON.stringify(event))
        state.socket.send(JSON.stringify(sealed))
      }
    }
  }
}
