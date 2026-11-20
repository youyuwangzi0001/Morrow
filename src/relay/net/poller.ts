import type { ChannelSelector } from './channel'

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
