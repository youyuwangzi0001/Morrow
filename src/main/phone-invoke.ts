/**
 * 手机 → 桌面的上行指令白名单与参数校验。
 *
 * ## 为什么单独一层
 *
 * `DirectChannel` 只负责解密与回帧，**不应该知道** `approval.decide` 的参数
 * 长什么样。把「协议」和「动作」分开后，这一层可以脱离 Electron / AgentService
 * 单测：未知方法、缺参数、手机端禁止的 `always`、处理器抛错，全都在这里判定。
 *
 * ## 安全边界（与产品约束一致）
 *
 * - 只接受 [PHONE_METHODS] 里的方法，未知方法回 `unsupported`，**不断开连接**
 *   （断开会让用户以为是网络问题；实际是版本不匹配）。
 * - `approval.decide` 只允许 `once` / `deny`。**手机不能回 `always`** ——
 *   这是蓝图 SEC3 的硬规则，即使桌面支持 `always`，也不能让一个锁屏设备
 *   顺手给出永久授权。
 * - 参数必须是对象；字符串长度设上限，避免日志/内存被超长串拖垮。
 * - 处理器抛错一律变成 `ok:false` 的 result 帧，绝不让异常冒到 socket 层。
 */
export interface PhoneInvokeRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

export interface PhoneInvokeError {
  code: string
  message: string
}

export interface PhoneInvokeResult {
  ok: boolean
  result?: unknown
  error?: PhoneInvokeError
}

export type PhoneInvokeHandler = (request: PhoneInvokeRequest) => PhoneInvokeResult | Promise<PhoneInvokeResult>

/** 白名单：每一项都在 ipc.ts 有对应实现，新增方法必须同时改两端与测试。 */
export const PHONE_METHODS = ['approval.decide', 'run.stop', 'snapshot.get', 'ping'] as const

const MAX_ID = 120
const MAX_METHOD = 80
const MAX_REQUEST_ID = 200

let handler: PhoneInvokeHandler | null = null
let handled = 0
let rejected = 0

/** 注册/清空处理器。由 ipc 层在拿到 AgentService 后调用。 */
export function setPhoneInvokeHandler(next: PhoneInvokeHandler | null): void {
  handler = next
}

export function phoneInvokeStats(): { hasHandler: boolean; handled: number; rejected: number } {
  return { hasHandler: handler !== null, handled, rejected }
}

const fail = (code: string, message: string): PhoneInvokeResult => ({ ok: false, error: { code, message } })

/**
 * 校验并执行一条 invoke。**永不抛错**：调用方（DirectChannel）拿到结果后回帧。
 */
export async function dispatchPhoneInvoke(raw: unknown): Promise<PhoneInvokeResult> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    rejected++
    return fail('bad_request', 'invoke 必须是对象')
  }
  const frame = raw as Record<string, unknown>
  const id = typeof frame.id === 'string' ? frame.id : ''
  const method = typeof frame.method === 'string' ? frame.method : ''
  if (!id || id.length > MAX_ID) {
    rejected++
    return fail('bad_request', '缺 id 或 id 过长')
  }
  if (!method || method.length > MAX_METHOD) {
    rejected++
    return fail('bad_request', '缺 method 或 method 过长')
  }
  if (!(PHONE_METHODS as readonly string[]).includes(method)) {
    rejected++
    return fail('unsupported', `不支持的方法：${method}`)
  }

  const rawParams = frame.params
  const params =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {}
  if (rawParams !== undefined && (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams))) {
    rejected++
    return fail('bad_request', 'params 必须是对象')
  }

  if (method === 'approval.decide') {
    const requestId = params.requestId
    if (typeof requestId !== 'string' || !requestId || requestId.length > MAX_REQUEST_ID) {
      rejected++
      return fail('bad_request', '缺 requestId')
    }
    // 手机端不允许 always。这里不把 always 映射成 once —— 静默降级
    // 会让用户以为「始终允许」生效了，实际只授权一次，后果更难解释。
    if (params.decision !== 'once' && params.decision !== 'deny') {
      rejected++
      return fail('forbidden', '手机端只允许 once / deny')
    }
  }

  if (method === 'run.stop') {
    if (typeof params.runId !== 'string' || !params.runId || params.runId.length > MAX_ID) {
      rejected++
      return fail('bad_request', '缺 runId')
    }
  }

  if (!handler) {
    rejected++
    return fail('unavailable', '桌面尚未注册上行处理器')
  }

  handled++
  try {
    const result = await handler({ id, method, params })
    // 处理器返回 undefined/非对象属于实现错误：按失败回帧，不把
    // `undefined` 塞进 JSON（序列化后会变成缺字段，手机无法判断结果）。
    if (!result || typeof result !== 'object') return fail('bad_response', '处理器返回了非法结果')
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail('failed', message)
  }
}