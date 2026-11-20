/**
 * 传输信封（Envelope）。
 *
 * 蓝图 §5 原文：
 *
 * ```
 * { v: 1, kind: "event" | "invoke" | "result" | "ack",
 *   seq: 128,              // 单调递增，断线重连靠它补漏
 *   runId: "run_...", sessionId: "ses_...",
 *   at: 1763456789012,     // 服务端时间，手机不信任本地时钟
 *   body: { ... }          // 直接是 RuntimeEvent 或 IPC 响应
 * }
 * ```
 *
 * 三条不显然的约束，都在这里用类型/校验表达而不是靠注释：
 *
 * **一、`at` 是服务端时间。** 手机时钟不可信（用户手动改时间、时区错乱、
 * 设备休眠后漂移）。所有时间判断（排序、超时、去重）都用服务端的 `at`，
 * 客户端的本地时间不参与。
 *
 * **二、`seq` 由服务端分配，客户端只读。** 如果让客户端定 seq，
 * 重连补漏就失去意义 —— 客户端可以随便报一个 lastSeq 把服务端带偏。
 *
 * **三、`v` 必须严格校验。** 协议版本不对时应该明确失败，
 * 而不是「尽力解析」——那会让新旧版本混跑时出现难以复现的错乱。
 */

/** 协议版本。加到信封字段里，便于后续平滑升级。 */
export const ENVELOPE_VERSION = 1

export type EnvelopeKind = 'event' | 'invoke' | 'result' | 'ack'

/** 协议允许的全部 kind，用于运行时校验（不从类型推导，避免 as 断言绕过） */
const KINDS: readonly EnvelopeKind[] = ['event', 'invoke', 'result', 'ack']

export interface Envelope<T = unknown> {
  /** 协议版本，当前固定 1 */
  v: typeof ENVELOPE_VERSION
  kind: EnvelopeKind
  /** 单调递增序号，由服务端分配，从 1 开始 */
  seq: number
  /** 运行 id；非运行期事件可为空串 */
  runId: string
  /** 会话 id；系统级事件可为空串 */
  sessionId: string
  /** 服务端时间戳（毫秒） */
  at: number
  /** 载荷 */
  body: T
}

export const ENVELOPE_INVALID = 'ENVELOPE_INVALID'
export const SEQ_OUT_OF_ORDER = 'SEQ_OUT_OF_ORDER'

export class EnvelopeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'EnvelopeError'
  }
}

/**
 * 校验一个值是否是合法信封。
 *
 * 这里刻意做**严格**校验（而不是宽松兼容）：
 * - 多余字段忽略，但必需字段缺一个就失败；
 * - `seq` 必须是正整数（0 与负数说明分配逻辑坏了）；
 * - `at` 必须是有限数（NaN/Infinity 会让所有时间比较失效）。
 */
export function isValidEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  if (e.v !== ENVELOPE_VERSION) return false
  if (typeof e.kind !== 'string' || !KINDS.includes(e.kind as EnvelopeKind)) return false
  if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 1) return false
  if (typeof e.runId !== 'string') return false
  if (typeof e.sessionId !== 'string') return false
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) return false
  if (!('body' in e)) return false
  return true
}

/** 校验并返回信封；失败抛 EnvelopeError */
export function requireEnvelope(value: unknown): Envelope {
  if (!isValidEnvelope(value)) {
    throw new EnvelopeError(ENVELOPE_INVALID, '信封结构不合法')
  }
  return value
}

/**
 * 序号分配器。
 *
 * 只做一件事：从 1 开始单调递增。看起来简单，但它是「不重不漏」的基础 ——
 * 一旦这里出现重复或跳号，补漏逻辑就会误判。
 *
 * **不做持久化**：seq 在连接生命周期内有效，重连后由服务端继续递增
 * （手机靠 lastSeq 告诉服务端「我收到哪了」）。进程重启后从 1 重新开始，
 * 手机通过握手阶段拿到的 snapshot 重新对齐 —— 这是刻意的，
 * 因为跨进程持久化 seq 会让「旧连接的迟到包」与新连接混淆。
 */
export class SeqAllocator {
  private next = 1

  /** 取下一个序号 */
  take(): number {
    return this.next++
  }

  /** 当前将要分配的序号（只读，测试与调试用） */
  peek(): number {
    return this.next
  }

  /** 重置到 1（仅测试用） */
  reset(): void {
    this.next = 1
  }
}

/** 构造一个信封（服务端发事件时用） */
export function makeEnvelope<T>(alloc: SeqAllocator, kind: EnvelopeKind, init: { runId?: string; sessionId?: string; at: number }, body: T): Envelope<T> {
  return {
    v: ENVELOPE_VERSION,
    kind,
    seq: alloc.take(),
    runId: init.runId ?? '',
    sessionId: init.sessionId ?? '',
    at: init.at,
    body
  }
}

/**
 * 校验收到的信封序号是否连续（客户端侧用）。
 *
 * 返回：
 * - `{ ok: true }` 连续，可以处理
 * - `{ ok: false, gap: n }` 跳号，缺了 n 条（n = 期望值 - 实际值）
 * - `{ ok: false, duplicate: true }` 重复（同一条又收到一次）
 *
 * 客户端**不能**靠「丢弃重复、接受跳号」蒙混 —— 跳号意味着丢事件，
 * 必须走补漏流程（见 ReplayBuffer），否则用户看到的就是「少了一条消息」。
 */
export function checkSeq(expected: number, received: number): { ok: true } | { ok: false; duplicate: true } | { ok: false; gap: number } {
  if (received === expected) return { ok: true }
  if (received < expected) return { ok: false, duplicate: true }
  return { ok: false, gap: received - expected }
}