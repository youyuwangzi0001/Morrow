import { type Envelope, makeEnvelope, SeqAllocator, ENVELOPE_VERSION, FRAME_REPLAYED, FRAME_TAMPERED, SecureChannel, newConnectionSalt, type TlsMaterial } from './relay-crypto'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { PairingService } from './relay-pairing'

// ───── src/relay/net/channel.ts ─────
/**
 * 三级通道选择器。
 *
 * 蓝图 §5「三级回退」原文：
 *
 * | Tier | 用途 | 技术 | 延迟 |
 * |---|---|---|---|
 * | 1 首选 | 局域网直连 | mDNS 自动发现 WSS over LAN | <15ms |
 * | 2 回退 | 公网中继 | 端到端加密，同 NAT / 穿透失败时 | 200–800ms |
 * | 3 兜底 | 推送 + 拉取 | FCM 通知打开时补拉事件 | 不实时 |
 *
 * 验收原文（蓝图 B3 第 2 条）：
 *
 * > 强制关掉 mDNS 后 **5 秒内**降级到中继且 **UI 只变 chip 文案**
 *
 * 这句话里有两个独立要求，容易被只做前半：
 *
 * **一、5 秒内降级。** 时间上界。降级太慢，用户在断网后要卡十秒才看到提示。
 *
 * **二、UI 只变 chip 文案。** 降级是**传输层**的事，不该影响**内容层**。
 * 最容易做假的地方：降级时把整个连接对象丢掉、重新初始化，于是已加载的消息、
 * 滚动位置、正在输入的草稿全没了 —— 用户看到的是「界面闪了一下，聊天记录空了」。
 * 所以这里把「传输状态」与「视图状态」分开：切通道只在 chip 上体现，
 * `sessionRevision` 只在会话真的变了才递增。
 *
 * 还有一条蓝图没写但必须做的：**宽限期**。
 * 如果探测失败一次就立刻降级，一个丢包就会让 chip 在 lan/relay 之间抖动，
 * 反而比降级更烦。所以要求连续失败满宽限期才降级 —— 这比蓝图更严，
 * 单测里明确标注这是本实现自加的约束。
 *
 * 为什么不用定时器：宽限期判定依赖注入的时钟，由调用方按自己的节奏调 `poll()`。
 * 这样单测里推进时间不需要真等 5 秒，也不会有定时器泄漏。
 * 生产环境由应用启动一个 1 秒的轮询调用它。
 */

export type Tier = 'lan' | 'relay' | 'push'

/** 蓝图要求的降级上界：5 秒 */
export const DEGRADE_WINDOW_MS = 5_000

/** 默认宽限期：与蓝图上界一致（判定用 >=，所以恰好 5 秒时降级） */
export const DEFAULT_GRACE_MS = DEGRADE_WINDOW_MS

/** chip 文案：UI 只读这一个字段决定显示什么 */
export const TIER_LABELS: Record<Tier, string> = {
  lan: '直连',
  relay: '中继',
  push: '仅推送'
}

export interface TierChannel {
  readonly tier: Tier
  /** 探测是否可达。返回 false 表示这条通道当前不可用。 */
  probe(): Promise<boolean>
  /** 建立连接 */
  connect(): Promise<void>
  /** 断开 */
  disconnect(): Promise<void>
}

export interface ChannelSelectorOptions {
  /** Tier 1：局域网直连（依赖 mDNS 发现） */
  direct: TierChannel
  /** Tier 2：公网中继 */
  relay: TierChannel
  /** Tier 3：推送 + 拉取。它是被动通道，不做探测；前两层都不可用时才用 */
  push?: TierChannel
  /** 注入时钟，默认 Date.now。单测推进时间不真等 */
  now?: () => number
  /**
   * 宽限期：直连连续不可达满这么久才降级。
   * 默认等于蓝图要求的 5 秒；设为 0 会立即降级（单测用它做反向验证）。
   */
  graceMs?: number
}

/** 对外暴露的只读视图 —— UI 只需要这些 */
export interface ChannelView {
  /**
   * 当前通道。**未连接时为 `null`**（不是 'push'）。
   *
   * 这里修过一个会误导 UI 的缺陷：初版在未连接时返回 `'push'`，
   * 于是 `tier === 'push'` 同时表示「已经退到推送兜底」和「还没开始连接」两件事。
   * 调用方只看 tier 会把「启动中」渲染成「仅推送」。现在用 `null` 表示未连接，
   * 让这两种状态在类型上就分得开。
   */
  tier: Tier | null
  /** chip 上的文字，例如「直连」「中继」「未连接」 */
  chip: string
  /**
   * 会话内容版本号。**只有会话本身变化时才递增**，
   * 切通道绝不改动它 —— 这是「UI 只变 chip」的机器可验证形式。
   */
  sessionRevision: number
  /** 从未成功连上过任何通道 */
  offline: boolean
}

export class ChannelSelector {
  private readonly direct: TierChannel
  private readonly relay: TierChannel
  private readonly push?: TierChannel
  private readonly now: () => number
  private readonly graceMs: number

  private current: Tier | null = null
  private sessionRevision = 0
  /**
   * 直连最后一次探测成功的时刻。
   *
   * 宽限期从「最后一次成功」算，不是从「第一次失败」算 —— 这是本批调试出来的：
   * mDNS 在两次轮询之间被关掉，若从首次失败起算，实际降级时间会晚于
   * 「关掉后 5 秒」，违反蓝图的时间上界。从最后成功起算，
   * 无论轮询间隔多大，「最后一次确定可达 + 5 秒」都有确定的上界。
   */
  private directUpAt: number | null = null
  /** 每次切换的记录，测试用它验证「切了几次、为什么切」 */
  private readonly history: Array<{ at: number; from: Tier | null; to: Tier; reason: string }> = []

  constructor(options: ChannelSelectorOptions) {
    this.direct = options.direct
    this.relay = options.relay
    this.push = options.push
    this.now = options.now ?? Date.now
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  }

  /** 当前 tier（未启动时为 null） */
  tier(): Tier | null {
    return this.current
  }

  /** 当前 chip 文案 */
  chip(): string {
    return this.current ? TIER_LABELS[this.current] : '未连接'
  }

  /** 当前视图。UI 每帧读这个。 */
  view(): ChannelView {
    return {
      // 未连接时给 null，而不是 'push' —— 见 ChannelView.tier 的说明
      tier: this.current,
      chip: this.chip(),
      sessionRevision: this.sessionRevision,
      offline: this.current === null
    }
  }

  /** 切换历史（测试与诊断用） */
  switchHistory(): ReadonlyArray<{ at: number; from: Tier | null; to: Tier; reason: string }> {
    return this.history
  }

  /** 应用主动改变会话内容时调用，递增内容版本号 */
  bumpSession(): void {
    this.sessionRevision += 1
  }

  /**
   * 启动：按 1 → 2 → 3 的顺序挑第一条可用的通道。
   *
   * 启动时**不套用宽限期**：应用刚打开，还没有「当前连接」可言，
   * 等 5 秒才连上的体验不可接受。宽限期只用于「已连上之后掉线」的场景。
   */
  async start(): Promise<Tier> {
    if (await this.safeProbe(this.direct)) {
      await this.safeConnect(this.direct)
      this.current = 'lan'
      this.directUpAt = this.now()
      this.history.push({ at: this.now(), from: null, to: 'lan', reason: '启动时直连可用' })
      return 'lan'
    }

    if (await this.safeProbe(this.relay)) {
      await this.safeConnect(this.relay)
      this.current = 'relay'
      this.history.push({ at: this.now(), from: null, to: 'relay', reason: '直连不可用，启动时走中继' })
      return 'relay'
    }

    this.current = 'push'
    this.history.push({ at: this.now(), from: null, to: 'push', reason: '直连与中继都不可用，退到推送' })
    return 'push'
  }

  /**
   * 轮询：由应用每秒调用一次。
   *
   * 行为分支：
   * - 当前是 lan：探测直连。失败则记下起点并**等待宽限期**；成功则清除起点。
   *   若无 push 之外的可回退层，且直连挂了满宽限期 → 降到 relay。
   * - 当前是 relay：探测直连是否恢复（恢复了就升回去，不用宽限期 ——
   *   升级是「变好」，没有抖动风险）；中继本身挂了 → 降到 push。
   * - 当前是 push：探测直连/中继是否恢复。
   */
  async poll(): Promise<void> {
    if (this.current === null) return

    if (this.current === 'lan') {
      if (await this.safeProbe(this.direct)) {
        // 直连健康：把「最后一次可用时刻」推到当下
        this.directUpAt = this.now()
        return
      }

      // 直连失败：从最后一次成功算起已经过去多久
      // directUpAt 为 null 说明进 lan 之后从没探测成功过，此时按 0 计（等满宽限期）
      const downFor = this.directUpAt === null ? 0 : this.now() - this.directUpAt
      if (downFor < this.graceMs) {
        // 还在宽限期内：**不降级**，chip 保持不变。
        // 这段是「防抖动」的关键，删掉它单测里「一丢包就切」的用例会失败。
        return
      }

      // 宽限期已满：降级
      if (await this.safeProbe(this.relay)) {
        await this.safeDisconnect(this.direct)
        await this.safeConnect(this.relay)
        this.moveTo('relay', `直连持续不可达 ${downFor}ms（≥${this.graceMs}ms），降级到中继`)
      } else if (this.push) {
        await this.safeDisconnect(this.direct)
        await this.safeConnect(this.push)
        this.moveTo('push', `直连不可达 ${downFor}ms 且中继不可用，退到推送`)
      }
      return
    }

    if (this.current === 'relay') {
      // 先看直连是否恢复（升级不需要宽限期）
      if (await this.safeProbe(this.direct)) {
        await this.safeDisconnect(this.relay)
        await this.safeConnect(this.direct)
        this.directUpAt = this.now()
        this.moveTo('lan', '直连恢复，升回直连')
        return
      }
      // 直连仍不可用；再看中继
      if (!(await this.safeProbe(this.relay)) && this.push) {
        await this.safeDisconnect(this.relay)
        await this.safeConnect(this.push)
        this.moveTo('push', '中继也不可达，退到推送')
      }
      return
    }

    // current === 'push'：尝试恢复
    if (await this.safeProbe(this.direct)) {
      await this.safeConnect(this.direct)
      this.directUpAt = this.now()
      this.moveTo('lan', '直连恢复，从推送升回直连')
      return
    }
    if (await this.safeProbe(this.relay)) {
      await this.safeConnect(this.relay)
      this.moveTo('relay', '中继恢复，从推送升到中继')
    }
  }

  /**
   * 切换当前 tier。
   *
   * **绝不触碰 sessionRevision** —— 这是「UI 只变 chip」的实现点。
   * 如果哪天有人在这里加一句 `this.sessionRevision += 1`，
   * 单测 `切通道不重置会话内容版本` 会立刻失败。
   */
  private moveTo(next: Tier, reason: string): void {
    const from = this.current
    if (from === next) return
    this.current = next
    this.history.push({ at: this.now(), from, to: next, reason })
  }

  private async safeProbe(ch: TierChannel): Promise<boolean> {
    try {
      return await ch.probe()
    } catch {
      // 探测抛错等同于不可达。吞掉异常是刻意的：
      // 一次探测失败不该让整个轮询崩掉，进而让所有通道都停止被检查。
      return false
    }
  }

  private async safeConnect(ch: TierChannel): Promise<void> {
    try {
      await ch.connect()
    } catch {
      // 连接失败：下一次 poll 会重新探测并选别的通道
    }
  }

  private async safeDisconnect(ch: TierChannel): Promise<void> {
    try {
      await ch.disconnect()
    } catch {
      // 断开失败不影响状态机：旧通道反正已经不可达
    }
  }
}

/**
 * 密文检查工具：中继只转发密文，无法解密内容。
 *
 * 蓝图原文：
 * > 中继只转发密文，无法解密内容——这一点必须在设置页明确写给用户看，
 * > 否则「把工作区推给第三方服务器」会直接劝退。
 *
 * 这句话的技术前提是「中继上跑的确实是密文」。如果哪天某个字段
 * 以明文（尚未加密的 Envelope、或者 base64 但不加密）发到中继，
 * 「无法解密」就成了空话。所以这里提供一个可复用的检查：
 * 把要发往中继的字节喂进来，确认它**不是**可解析的明文 JSON。
 */
export function looksLikeCiphertext(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false

  // 直接以 '{' 开头：明文 JSON 信封
  if (bytes[0] === 0x7b || bytes[0] === 0x5b) return false // '{' 或 '['

  // 关键补充：**base64 编码的明文也必须拦下**。
  // 审查探针实测过：把 JSON 套一层 base64 截图发出去，初版判定为「密文」，
  // 于是「中继只转发密文」的承诺被一个 base64 绕过 —— 而开发者很容易
  // 误以为「我看不懂 = 加密了」。base64 只是编码，不是加密。
  const asText = tryDecodeUtf8(bytes)
  if (asText !== null) {
    const trimmed = asText.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // UTF-8 明文 JSON
      return false
    }
    // 看起来像 base64/hex 的纯文本：尝试解码后再判一次
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length >= 8) {
      const inner = tryDecodeBase64(trimmed)
      if (inner !== null && looksLikePlainJson(inner)) return false
    }
    // 十六进制
    if (/^[0-9a-fA-F\r\n]+$/.test(trimmed) && trimmed.length >= 16) {
      const inner = tryDecodeHex(trimmed)
      if (inner !== null && looksLikePlainJson(inner)) return false
    }
  }

  return true
}

/** 严格的 UTF-8 解码；含非法字节时返回 null（说明是二进制，更像密文） */
function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function tryDecodeBase64(text: string): Uint8Array | null {
  try {
    const cleaned = text.replace(/\s+/g, '')
    // Buffer 对非法 base64 很宽容，先用长度与字符集粗筛（上面已做），
    // 这里只保证往返一致，避免把任意文本误当 base64。
    const buf = Buffer.from(cleaned, 'base64')
    if (buf.length === 0) return null
    if (buf.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) return null
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

function tryDecodeHex(text: string): Uint8Array | null {
  const cleaned = text.replace(/\s+/g, '')
  if (cleaned.length % 2 !== 0) return null
  try {
    const buf = Buffer.from(cleaned, 'hex')
    if (buf.length === 0) return null
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

function looksLikePlainJson(bytes: Uint8Array): boolean {
  const text = tryDecodeUtf8(bytes)
  if (text === null) return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * 给中继发事件前的守门：明文直接抛错，不发出去。
 *
 * 这是「中继只转发密文」从口号变成断言的地方。
 */
export function requireCiphertext(bytes: Uint8Array, context = '中继负载'): void {
  if (!looksLikeCiphertext(bytes)) {
    throw new Error(`${context}必须是密文：检测到可解析的明文内容，拒绝发送到中继`)
  }
}

/**
 * 把事件转成「发往中继的最小可见信息」。
 *
 * 蓝图要求推送/中继只暴露「会话标题 + 动作类型 + 目标摘要」，
 * 不含文件内容、不含参数原文。这里只取信封的元数据，不带 body ——
 * body 可能是代码、路径或用户输入。
 */
export function envelopeMeta(envelope: Envelope): { v: number; kind: string; seq: number; sessionId: string; at: number } {
  return {
    v: envelope.v,
    kind: envelope.kind,
    seq: envelope.seq,
    // sessionId 本身是随机标识，不是内容
    sessionId: envelope.sessionId,
    at: envelope.at
  }
}

// ───── src/relay/net/replay-buffer.ts ─────
/**
 * 断线重连补漏用的环形缓冲。
 *
 * 蓝图 §5 原文：
 *
 * > 断线恢复：手机带 lastSeq 重连，服务端从 ring buffer 补齐；
 * > 超出 buffer（默认 2000 条）则返回 snapshot_required，改走全量快照
 *
 * 这个文件的核心是**一个判断**：当手机说「我收到 seq=100」，服务端能不能补齐？
 *
 * 两种失败必须区分清楚，因为客户端的反应完全不同：
 *
 * | 情况 | 返回 | 客户端该做什么 |
 * |---|---|---|
 * | 缓冲里有 lastSeq+1 起的所有事件 | 补齐的数组 | 直接渲染，用户无感 |
 * | lastSeq 太旧（已被挤出缓冲） | `snapshot_required` | 重新拉全量快照 |
 *
 * 最容易做假的地方是**第二种情况静默丢弃** —— 服务端只把还留着的发过去，
 * 客户端以为补齐了，实际上中间少了一截。用户看到的是「对话记录里少了几条」，
 * 而且永远不会自愈。所以这里宁可让客户端重拉全量，也不发不完整的数据。
 */

/** 缓冲容量：蓝图原文 2000 条 */
export const DEFAULT_BUFFER_CAPACITY = 2000

/** 降级信号：客户端必须改走全量快照 */
export const SNAPSHOT_REQUIRED = 'snapshot_required'

export type ReplayResult =
  | { ok: true; events: Envelope[] }
  | { ok: false; reason: typeof SNAPSHOT_REQUIRED; message: string }

export interface ReplayBufferOptions {
  /** 容量，默认 2000 */
  capacity?: number
}

/**
 * 定容环形缓冲。
 *
 * 为什么用环形而不是「数组 + shift()」：shift 在大数组上是 O(n)，
 * 每来一条事件就搬移 2000 个元素，高频事件流下会明显卡顿。
 * 环形缓冲写入是 O(1)，且内存占用恒定 —— 不会因为长时间运行而膨胀。
 */
export class ReplayBuffer {
  private readonly capacity: number
  /** 存储槽位；null 表示空 */
  private readonly slots: Array<Envelope | null>
  /** 下一个写入位置 */
  private head = 0
  /** 当前已存条数 */
  private size = 0

  constructor(options: ReplayBufferOptions = {}) {
    const cap = options.capacity ?? DEFAULT_BUFFER_CAPACITY
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error('ReplayBuffer 容量必须是正整数')
    }
    this.capacity = cap
    this.slots = new Array<Envelope | null>(cap).fill(null)
  }

  /** 当前条数 */
  length(): number {
    return this.size
  }

  /** 容量 */
  limit(): number {
    return this.capacity
  }

  /**
   * 追加一条。超出容量时最旧的一条被挤出。
   *
   * 这里**不做 seq 校验**：缓冲只负责存，连续性判断在 replay 里做。
   * 混在一起会让「存」与「取」的失败语义纠缠，难以测试。
   */
  push(envelope: Envelope): void {
    this.slots[this.head] = envelope
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
    // 满了时新写入覆盖的正是最旧那条，oldestSeq() 会自动反映新的起点。
    // 不需要单独记录「挤出到哪」——replay() 用 oldestSeq() 判断即可，
    // 多存一份状态反而容易与实际情况不一致。
  }

  /** 当前缓冲中最小 / 最大序号（空时返回 null） */
  oldestSeq(): number | null {
    if (this.size === 0) return null
    if (this.size < this.capacity) return this.slots[0]?.seq ?? null
    // 满的时候 head 指向最旧的槽位（下一次写入会覆盖它）
    return this.slots[this.head]?.seq ?? null
  }

  newestSeq(): number | null {
    if (this.size === 0) return null
    const idx = (this.head - 1 + this.capacity) % this.capacity
    return this.slots[idx]?.seq ?? null
  }

  /** 取出全部事件（按 seq 升序），测试与调试用 */
  toArray(): Envelope[] {
    if (this.size === 0) return []
    const out: Envelope[] = []
    const start = this.size < this.capacity ? 0 : this.head
    for (let i = 0; i < this.size; i++) {
      const slot = this.slots[(start + i) % this.capacity]
      if (slot) out.push(slot)
    }
    return out
  }

  /**
   * 补齐：客户端说「我收到 lastSeq 了」，返回它缺的那些。
   *
   * 判定逻辑（按顺序，每一步都有理由）：
   *
   * 1. **缓冲为空** → snapshot_required。没东西可补，客户端必须重新对齐。
   * 2. **lastSeq >= 最新序号** → 返回空数组（ok）。客户端已是最新，
   *    多发的 ack 不需要重发任何事件。这不是错误。
   * 3. **lastSeq < 被挤出的最早序号** → snapshot_required。
   *    中间那一截已经永远找不回来了 —— 这正是「不能静默丢弃」的地方。
   * 4. 否则 → 从缓冲里筛出 seq > lastSeq 的全部事件。
   *
   * 第 3 步的边界容易写错：条件是 `lastSeq < oldest - 1` 还是 `lastSeq < oldest`？
   * 正确是 `lastSeq < oldest - 1`：如果 lastSeq 恰好等于 oldest - 1，
   * 说明客户端收完了挤出前的那条，缓冲里从 oldest 开始正好接得上，可以补齐。
   */
  replay(lastSeq: number): ReplayResult {
    if (!Number.isInteger(lastSeq) || lastSeq < 0) {
      return { ok: false, reason: SNAPSHOT_REQUIRED, message: 'lastSeq 必须是非负整数' }
    }

    if (this.size === 0) {
      return { ok: false, reason: SNAPSHOT_REQUIRED, message: '缓冲为空，无法补齐' }
    }

    const newest = this.newestSeq() as number
    if (lastSeq >= newest) {
      // 已是最新（或客户端报了未来的序号）—— 没有要补的。
      // 注意这里不把「报未来序号」当错误：可能是上一轮的 ack 延迟到达。
      return { ok: true, events: [] }
    }

    const oldest = this.oldestSeq() as number
    if (lastSeq < oldest - 1) {
      // 客户端落后的部分已被挤出缓冲，补不完整
      return {
        ok: false,
        reason: SNAPSHOT_REQUIRED,
        message: `lastSeq=${lastSeq} 早于缓冲起点 ${oldest}，需重新拉取快照`
      }
    }

    const events = this.toArray().filter((e) => e.seq > lastSeq)
    return { ok: true, events }
  }

  /** 清空（测试用） */
  clear(): void {
    this.slots.fill(null)
    this.head = 0
    this.size = 0
  }

}

/**
 * 客户端侧的重连状态机。
 *
 * 服务端返回 `snapshot_required` 时，客户端必须：
 * 1. 拉全量快照；
 * 2. 用快照里的 seq 重置 lastSeq；
 * 3. 之后继续按增量接收。
 *
 * 这个类把「期望序号」的状态收在一处，避免调用方各自维护一个 lastSeq
 * —— 那样最容易出现「一处更新了另一处没更新」的丢事件 bug。
 */
export class ReconnectTracker {
  private lastSeq: number

  constructor(initialSeq = 0) {
    this.lastSeq = initialSeq
  }

  /** 当前已确认收到的最大序号 */
  current(): number {
    return this.lastSeq
  }

  /**
   * 接收一条信封。返回是否需要补漏。
   *
   * - 连续：推进 lastSeq，返回 `{ accept: true }`
   * - 重复：丢弃，返回 `{ accept: false, duplicate: true }`
   * - 跳号：**不推进** lastSeq，返回缺口信息，调用方应触发 replay
   */
  receive(seq: number): { accept: true } | { accept: false; duplicate: true } | { accept: false; gap: number } {
    const expected = this.lastSeq + 1
    if (seq === expected) {
      this.lastSeq = seq
      return { accept: true }
    }
    if (seq < expected) return { accept: false, duplicate: true }
    return { accept: false, gap: seq - expected }
  }

  /** 应用补漏结果：把 lastSeq 推进到补齐的最后一条 */
  applyReplay(events: Array<{ seq: number }>): void {
    for (const e of events) {
      if (e.seq > this.lastSeq) this.lastSeq = e.seq
    }
  }

  /** 快照重置：用快照的 seq 对齐 */
  resetTo(seq: number): void {
    this.lastSeq = seq
  }
}

// ───── src/relay/net/poller.ts ─────
/**
 * 通道轮询调度器。
 *
 * `ChannelSelector.poll()` 是纯函数式的「检查一次」，节奏由外部决定 ——
 * 这是 B3 第三批刻意的设计（逻辑测试不需要真等 5 秒）。但生产环境必须有
 * 一个东西真的每秒调它，否则宽限期永远不会被评估，降级永远不会发生。
 *
 * ## 三个必须做对的地方
 *
 * **一、不重叠执行。** `poll()` 是 async 的，一次可能超过 1 秒（真实探测要发网络请求）。
 * 如果每 1 秒无脑调一次，慢的时候会堆积多个并发 poll，它们各自读改写
 * `directUpAt` / `current`，宽限期计算就乱了。所以用「上一次完成才排下一次」
 * （setTimeout 链），而不是 setInterval。
 *
 * **二、stop 之后不再执行。** 一次正在跑的 poll 可能在 stop 期间完成，
 * 若结束回调里又排了下一个定时器，就会「stop 了还在跑」—— 用户关掉开关后
 * 后台仍在探测网络，既费电又让日志出现幽灵切换。
 *
 * **三、多次 start/stop 不能泄漏定时器。** 每次 start 都建 timer、每次 stop 都清。
 * 少清一个，这个 timer 就会永远活着并把整个 selector 钉在内存里。
 * 单测直接数 `pending()` 与 `process.getActiveResourcesInfo()`。
 */

export interface ChannelPollerOptions {
  selector: ChannelSelector
  /** 轮询间隔，默认 1000ms（蓝图要求「每秒探测」） */
  intervalMs?: number
  /** 单次 poll 的日志钩子（诊断用） */
  onPoll?: (info: { at: number; tier: string | null; ms: number; error?: string }) => void
  /** 注入定时器，测试可用假时钟 */
  now?: () => number
}

export class ChannelPoller {
  private readonly selector: ChannelSelector
  private readonly intervalMs: number
  private readonly onPoll?: (info: { at: number; tier: string | null; ms: number; error?: string }) => void
  private readonly now: () => number

  private timer: NodeJS.Timeout | null = null
  private running = false
  /** 递增代号：stop 时 +1，使「在途 poll」的结束回调认出自己已过期 */
  private generation = 0
  private pollCount = 0
  private lastError: string | null = null

  constructor(options: ChannelPollerOptions) {
    this.selector = options.selector
    this.intervalMs = options.intervalMs ?? 1_000
    this.onPoll = options.onPoll
    this.now = options.now ?? Date.now
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('轮询间隔必须是正数')
    }
  }

  /** 是否在轮询 */
  isRunning(): boolean {
    return this.running
  }

  /** 是否有一个待执行的定时器（测试用来检测泄漏） */
  pending(): boolean {
    return this.timer !== null
  }

  /** 已完成多少次 poll */
  ticks(): number {
    return this.pollCount
  }

  /** 上次 poll 的错误（诊断用） */
  error(): string | null {
    return this.lastError
  }

  /**
   * 启动轮询。**幂等** —— 重复调用不会产生第二个定时器。
   *
   * 不做「先 stop 再 start」的内部重置：那样在并发调用时（两个地方同时 start）
   * 会出现「前一个刚建好就被后一个清掉、后一个以为已启动而不建」的空转。
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.generation += 1
    this.schedule(this.generation)
  }

  /** 停止轮询。幂等。 */
  stop(): void {
    if (!this.running && this.timer === null) return
    this.running = false
    // 代号自增：在途 poll 结束时会发现自己的代号过期，不再排下一轮
    this.generation += 1
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * 立刻执行一次 poll（不等下一个 tick）。用于 select 后立即刷新。
   *
   * **不受 start/stop 影响**：调用方可能想在启动轮询前先探一次
   * （例如界面打开时立刻显示正确的 chip，而不是空白 1 秒）。
   * 内部用 `force` 绕过「未 running 就返回」的门槛，但仍计入 ticks。
   */
  async tickNow(): Promise<void> {
    await this.runOnce(this.generation, true)
  }

  private schedule(gen: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runOnce(gen)
    }, this.intervalMs)
    // unref：桌面应用退出时不该被这个定时器拖住。
    // Electron 里主进程的定时器若 ref 着，用户关窗口进程会挂着不退。
    this.timer.unref?.()
  }

  private async runOnce(gen: number, force = false): Promise<void> {
    // 代号不符 = 已被 stop（或重启过），不再执行
    if (gen !== this.generation) return
    // 非强制调用要求正在运行。强制调用（tickNow）允许在 stopped 状态跑一次。
    if (!force && !this.running) return

    const startedAt = this.now()
    try {
      await this.selector.poll()
      this.lastError = null
    } catch (err) {
      // poll 内部已吞掉探测异常，这里兜的是逻辑层异常（不该发生）
      this.lastError = (err as Error).message
    }
    this.pollCount += 1

    // 强制调用不排下一轮：只有「正在运行的轮询」才继续调度
    if (!force && gen === this.generation && this.running) {
      this.onPoll?.({
        at: startedAt,
        tier: this.selector.tier(),
        ms: this.now() - startedAt,
        ...(this.lastError ? { error: this.lastError } : {})
      })
      // 用 setTimeout 链而不是 setInterval：本次完成后才排下一次，
      // 慢 poll 不会堆积（见文件头「一、不重叠执行」）
      this.schedule(gen)
    }
  }
}

// ───── src/relay/net/direct-channel.ts ─────
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
  /**
   * 全量快照提供器。
   *
   * 手机首次连接（lastSeq=0）或补漏缓冲不足时调用。返回 null = 桌面侧没有
   * 可提供的状态（例如尚未注册 provider），此时不下发快照，手机保持
   * 「正在同步」而不是收到一份空状态被误认为「桌面什么都没有」。
   */
  snapshot?: () => unknown
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
  private readonly snapshot?: () => unknown

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
    this.snapshot = options.snapshot
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
    } else {
      // 缓冲里没有可补的历史（首连 / 桌面刚重启 / 手机落后太多）：
      // 主动下发全量快照，让手机一次对齐，而不是停在空白页。
      this.sendSnapshot(state, this.now())
    }
  }

  /**
   * 发送一份加密快照（只发给刚完成握手的这一条连接）。
   *
   * 快照不写 replay 缓冲：它是「连接时刻的状态」而不是可重放的历史事件。
   * 因此它会消耗一个 seq 但不进缓冲 —— 手机侧只取 max(lastSeq)，
   * 后续事件序号继续递增，补漏判断不会被这个空号影响。
   */
  private sendSnapshot(state: ClientState, at: number): void {
    if (!this.snapshot || !state.channel) return
    let snapshot: unknown
    try {
      snapshot = this.snapshot()
    } catch {
      // 快照构造失败不能让握手失败：手机可以靠后续增量事件慢慢补齐，
      // 而握手失败会让它一直重连。
      return
    }
    if (!snapshot) return
    const envelope = makeEnvelope(
      this.seq,
      'event',
      { runId: 'snapshot', sessionId: '', at },
      { type: 'snapshot', at, snapshot }
    )
    const sealed = state.channel.seal('desktop-to-phone', JSON.stringify(envelope))
    state.socket.send(JSON.stringify(sealed))
    this.onFrame?.('out', `seq=${envelope.seq} snapshot -> ${state.deviceId ?? '?'}`)
  }
}
