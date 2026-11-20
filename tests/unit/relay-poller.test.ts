import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelSelector, ChannelView, Tier } from '../../src/relay/net/channel'
import { ChannelPoller } from '../../src/relay/net/poller'

/**
 * B3 第五批（续）：自动轮询调度器。
 *
 * 为什么单独测它：`ChannelSelector.poll()` 是「检查一次」，节奏由外部决定。
 * 没有调度器，宽限期永远不会被评估 —— 用户把手机 Wi-Fi 关掉，
 * chip 会一直停在「直连」，因为没人去 poll。
 *
 * 这类「缺一根线」的缺陷最容易被忽略：选择器逻辑全对、测试全绿，
 * 但功能在真实应用里不工作。B3 第一批就踩过一模一样的坑
 * （index.ts 调 startRelay 忘了传 pairing，整套配对一次没执行过）。
 *
 * 四个必须守住的点：
 * 1. 到点真的调用 poll
 * 2. start 幂等（不会产生第二个定时器）
 * 3. 慢 poll 不堆积（不重叠执行）
 * 4. 多次 start/stop 不泄漏定时器
 */

/** 只实现 poll/tier 的最小 selector 替身；poller 只用这两个 */
function fakeSelector(options: { delayMs?: number; failWith?: Error } = {}) {
  const state = {
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    tier: null as Tier | null,
    async poll() {
      state.calls++
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs))
        if (options.failWith) throw options.failWith
      } finally {
        state.inFlight--
      }
    },
    tier_() {
      return state.tier
    }
  }
  // poller 用 selector.poll() 与 selector.tier()
  const proxy = {
    poll: state.poll,
    tier: (): Tier | null => state.tier,
    view: (): ChannelView => ({ tier: state.tier, chip: '', sessionRevision: 0, offline: state.tier === null })
  }
  return { proxy: proxy as unknown as ChannelSelector, state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('到点真的调用 poll', () => {
  it('@core:relay 1 秒后第一次 poll，2 秒后第二次', async () => {
    vi.useFakeTimers()
    const { proxy, state } = fakeSelector()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()
    expect(state.calls).toBe(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.calls).toBe(1)
    expect(poller.ticks()).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.calls).toBe(2)

    poller.stop()
  })

  it('@core:relay stop 后不再 poll', async () => {
    vi.useFakeTimers()
    const { proxy, state } = fakeSelector()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.calls).toBe(1)

    poller.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.calls).toBe(1)
  })

  it('@core:relay tickNow 立即执行一次，不等定时器', async () => {
    const { proxy, state } = fakeSelector()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 60_000 })
    await poller.tickNow()
    expect(state.calls).toBe(1)
  })
})

describe('幂等与不重叠', () => {
  it('@core:relay 重复 start 不产生第二个定时器', async () => {
    vi.useFakeTimers()
    const { proxy, state } = fakeSelector()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()
    poller.start()
    poller.start()

    await vi.advanceTimersByTimeAsync(1_000)
    // 若产生多个定时器，这里会是 3
    expect(state.calls).toBe(1)
    poller.stop()
  })

  it('@core:relay 慢 poll（超过间隔）不堆积：任意时刻最多一个在途', async () => {
    vi.useFakeTimers()
    // 每次 poll 花 2.5 秒，而间隔只有 1 秒
    const { proxy, state } = fakeSelector({ delayMs: 2_500 })
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()

    // 推进 10 秒（若用 setInterval 会产生约 10 个并发 poll）
    await vi.advanceTimersByTimeAsync(10_000)

    expect(state.maxInFlight).toBe(1)
    expect(state.calls).toBeLessThanOrEqual(4)
    poller.stop()
  })

  it('@core:relay poll 抛错不会让轮询停摆，错误被记录下来', async () => {
    vi.useFakeTimers()
    const { proxy, state } = fakeSelector({ failWith: new Error('探测炸了') })
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(poller.error()).toBe('探测炸了')
    expect(state.calls).toBe(1)

    // 下一轮仍会执行 —— 一次失败不该让整个通道检查停掉
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.calls).toBe(2)
    poller.stop()
  })
})

describe('不泄漏定时器（最关键）', () => {
  it('@core:relay start → stop 后没有待执行定时器', () => {
    const { proxy } = fakeSelector()

    vi.useFakeTimers()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()
    expect(poller.pending()).toBe(true)
    poller.stop()
    expect(poller.pending()).toBe(false)
    expect(poller.isRunning()).toBe(false)
  })

  it('@core:relay 反复 start/stop 20 次后只剩 0 个定时器', () => {
    vi.useFakeTimers()
    const { proxy } = fakeSelector()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })

    for (let i = 0; i < 20; i++) {
      poller.start()
      expect(poller.pending()).toBe(true)
      poller.stop()
      expect(poller.pending()).toBe(false)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('@core:relay stop 时正在执行的 poll 完成后不再排下一轮（不会「停了还在跑」）', async () => {
    vi.useFakeTimers()
    const { proxy, state } = fakeSelector({ delayMs: 2_000 })
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 1_000 })
    poller.start()

    // 推进 1 秒：poll 开始（会跑 2 秒）
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.calls).toBe(1)

    // 在它还没跑完时 stop
    poller.stop()
    // 再推进很久：在途 poll 结束，但不该排下一轮
    await vi.advanceTimersByTimeAsync(20_000)

    expect(state.calls).toBe(1)
    expect(poller.pending()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('@core:relay 不 pin 住进程：定时器已 unref', async () => {
    // 直接检查真实定时器的 hasRef 状态（不借助假时钟）
    const { proxy } = fakeSelector()
    const poller = new ChannelPoller({ selector: proxy, intervalMs: 60_000 })
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    poller.start()
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    // unref 后不该出现在 "active" 列表里
    expect(after).toBe(before)
    poller.stop()
  })
})

describe('参数校验', () => {
  it('@core:relay 间隔 <= 0 时构造失败（避免忙等）', () => {
    const { proxy } = fakeSelector()
    expect(() => new ChannelPoller({ selector: proxy, intervalMs: 0 })).toThrow(/正数/)
    expect(() => new ChannelPoller({ selector: proxy, intervalMs: -1 })).toThrow(/正数/)
  })
})
