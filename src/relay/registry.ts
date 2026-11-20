/**
 * Relay 通道分发表。
 *
 * 桌面侧的 IPC handler 都是直接在 `registerIpcHandlers()` 里挂到 `ipcMain` 上的，
 * 没有留下「按通道名调用」的入口。relay 需要这样一个入口，但**不能**为了它把
 * 现有 100 多个 handler 全部重构成注册表 —— 那是在改一整套稳定代码的架构，
 * 风险远大于收益，而且违背最小改动原则。
 *
 * 所以这里的做法是：relay 自己持有一张「通道 → 处理函数」表，
 * 由应用启动时**显式注入**那些需要远程可达的能力。
 * 没被注入的通道，即使写进白名单也会返回 NOT_BOUND —— 白名单与实现双重约束。
 *
 * 这两层是刻意的：
 * - 白名单管「允许哪些通道」；
 * - 绑定表管「这次运行里哪些能力真的可用」。
 * 少任何一层，都会出现「以为禁用了、实际还能调」的情况。
 */

export type RelayHandler = (payload: unknown) => Promise<unknown>

/** 统一结果形状，与桌面 IPC 的 Result 保持一致，手机端不用区分两套协议 */
export interface RelayResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; hint?: string }
}

const bound = new Map<string, RelayHandler>()

/** 绑定一个通道的实现。重复绑定直接抛错，避免后绑的悄悄覆盖前一个。 */
export function bindChannel(channel: string, handler: RelayHandler): void {
  if (bound.has(channel)) throw new Error(`relay 通道重复绑定：${channel}`)
  bound.set(channel, handler)
}

/** 测试用：清空绑定 */
export function resetBindings(): void {
  bound.clear()
}

/** 当前已绑定的通道（供启动自检：白名单里哪些还没接实现） */
export function boundChannels(): readonly string[] {
  return [...bound.keys()]
}

/**
 * 白名单里有、但当前运行没绑定实现的通道。
 * 启动时打一条日志，避免「白名单写了 18 条、实际只通 3 条」这种沉默的缺口。
 */
export function unboundAllowed(allowed: readonly string[]): readonly string[] {
  return allowed.filter((c) => !bound.has(c))
}

/**
 * 把请求路由到已绑定的处理函数。
 *
 * 约定：处理函数抛错即视为失败，由调用方（server）统一翻译成 RelayResult，
 * 这样审计日志能拿到错误码，而手机端只会看到结构化错误，不会看到堆栈。
 */
export async function dispatch(channel: string, payload: unknown): Promise<RelayResult> {
  const handler = bound.get(channel)
  if (!handler) {
    return {
      ok: false,
      error: { code: 'NOT_BOUND', message: `通道未绑定实现：${channel}` }
    }
  }
  try {
    const data = await handler(payload)
    return { ok: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string })?.code ?? 'RELAY_ERROR'
    return { ok: false, error: { code, message } }
  }
}