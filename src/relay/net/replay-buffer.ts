import type { Envelope } from './envelope'

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