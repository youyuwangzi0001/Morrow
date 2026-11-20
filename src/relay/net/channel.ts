import type { Envelope } from './envelope'

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