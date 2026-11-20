import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_INVALID,
  ENVELOPE_VERSION,
  EnvelopeError,
  SeqAllocator,
  checkSeq,
  isValidEnvelope,
  makeEnvelope,
  requireEnvelope,
  type Envelope
} from '../../src/relay/net/envelope'
import {
  DEFAULT_BUFFER_CAPACITY,
  ReconnectTracker,
  ReplayBuffer,
  SNAPSHOT_REQUIRED
} from '../../src/relay/net/replay-buffer'

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