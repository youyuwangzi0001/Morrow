import { describe, expect, it } from 'vitest'
import {
  ChannelSelector,
  DEGRADE_WINDOW_MS,
  TIER_LABELS,
  envelopeMeta,
  looksLikeCiphertext,
  requireCiphertext,
  type TierChannel
} from '../../src/relay/net/channel'
import { makeEnvelope, SeqAllocator } from '../../src/relay/net/envelope'

/**
 * B3 第三批验收：三级通道回退。
 *
 * 蓝图验收原文：
 * > 强制关掉 mDNS 后 **5 秒内**降级到中继且 **UI 只变 chip 文案**
 *
 * 拆成两个独立断言：
 * 1. 时间：关掉 mDNS 后 5 秒内必须切到 relay（不是 6 秒、不是永不）
 * 2. UI：切通道**不改变 sessionRevision**（内容版本），只有 chip 变
 *
 * 另加两条蓝图提到但没写进验收的：
 * 3. 宽限期：丢一次包不该立刻切（否则 chip 抖动比降级更烦）
 * 4. 中继只转发密文：明文发往中继时必须被拦下
 */

/** 可编程的假通道 */
function fakeChannel(tier: 'lan' | 'relay' | 'push', initialUp = true) {
  const state = {
    up: initialUp,
    connects: 0,
    disconnects: 0,
    probes: 0,
    throwOnProbe: false,
    throwOnConnect: false
  }
  const ch: TierChannel = {
    tier,
    async probe() {
      state.probes += 1
      if (state.throwOnProbe) throw new Error('probe boom')
      return state.up
    },
    async connect() {
      state.connects += 1
      if (state.throwOnConnect) throw new Error('connect boom')
    },
    async disconnect() {
      state.disconnects += 1
    }
  }
  return { ch, state }
}

let clock = 1_000_000
function advance(ms: number) {
  clock += ms
}

function build(opts: { directUp?: boolean; relayUp?: boolean; graceMs?: number } = {}) {
  clock = 1_000_000
  const direct = fakeChannel('lan', opts.directUp ?? true)
  const relay = fakeChannel('relay', opts.relayUp ?? true)
  const push = fakeChannel('push', true)
  const sel = new ChannelSelector({
    direct: direct.ch,
    relay: relay.ch,
    push: push.ch,
    now: () => clock,
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {})
  })
  return { sel, direct, relay, push }
}

// ───────────────── 蓝图验收 2：5 秒内降级 ─────────────────

describe('验收 2：关掉 mDNS 后 5 秒内降级到中继', () => {
  it('@core:relay 5 秒整时必须已经降级（不是 6 秒）', async () => {
    const { sel, direct } = build()
    await sel.start()
    expect(sel.tier()).toBe('lan')

    // 模拟 mDNS 关闭：直连探测全部失败
    direct.state.up = false

    // 第 1 秒：还在宽限期内，不降级
    advance(1_000)
    await sel.poll()
    expect(sel.tier()).toBe('lan')

    // 第 4.9 秒：仍未到 5 秒
    advance(3_900)
    await sel.poll()
    expect(sel.tier()).toBe('lan')

    // 第 5 秒：到点，必须降级
    advance(100)
    await sel.poll()
    expect(sel.tier()).toBe('relay')
  })

  it('@core:relay 降级后 chip 文案变成「中继」', async () => {
    const { sel, direct } = build()
    await sel.start()
    expect(sel.chip()).toBe(TIER_LABELS.lan)

    direct.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll()

    expect(sel.chip()).toBe(TIER_LABELS.relay)
    expect(sel.chip()).toBe('中继')
  })

  it('@core:relay 降级时连接顺序正确：断开直连、连上中继', async () => {
    const { sel, direct, relay } = build()
    await sel.start()
    expect(direct.state.connects).toBe(1)

    direct.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll()

    expect(direct.state.disconnects).toBe(1)
    expect(relay.state.connects).toBe(1)
  })

  it('@core:relay 直连在中继降级后恢复 → 升回直连', async () => {
    const { sel, direct } = build()
    await sel.start()
    direct.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll()
    expect(sel.tier()).toBe('relay')

    // 直连恢复
    direct.state.up = true
    await sel.poll()
    expect(sel.tier()).toBe('lan')
  })

  it('@core:relay 中继也不可用 → 退到推送（Tier 3 兜底）', async () => {
    const { sel, direct, relay } = build()
    await sel.start()
    direct.state.up = false
    relay.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll()

    expect(sel.tier()).toBe('push')
    expect(sel.chip()).toBe('仅推送')
  })
})

// ───────────────── 蓝图验收 2 的后半句：UI 只变 chip ─────────────────

describe('验收 2 后半句：UI 只变 chip 文案，内容不重载', () => {
  it('@core:relay 切通道不改变 sessionRevision（内容版本）', async () => {
    const { sel, direct } = build()
    await sel.start()
    // 模拟已加载了 3 批会话内容
    sel.bumpSession()
    sel.bumpSession()
    sel.bumpSession()
    const before = sel.view().sessionRevision
    expect(before).toBe(3)

    direct.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll()

    const after = sel.view()
    expect(after.tier).toBe('relay')
    expect(after.chip).toBe('中继')
    // 关键断言：内容版本没变 —— 用户不会看到「聊天记录重新加载」
    expect(after.sessionRevision).toBe(before)
  })

  it('@core:relay 多次切通道（lan→relay→lan→push）sessionRevision 始终不变', async () => {
    const { sel, direct, relay } = build()
    await sel.start()
    sel.bumpSession()
    const rev = sel.view().sessionRevision

    direct.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll() // → relay
    expect(sel.view().sessionRevision).toBe(rev)

    direct.state.up = true
    await sel.poll() // → lan
    expect(sel.view().sessionRevision).toBe(rev)

    direct.state.up = false
    relay.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll() // → push
    expect(sel.view().sessionRevision).toBe(rev)

    expect(sel.tier()).toBe('push')
    expect(sel.view().sessionRevision).toBe(rev)
  })

  it('@core:relay view() 返回的 sessionRevision 与显式 bump 同步（确认它不是恒定的假值）', async () => {
    const { sel } = build()
    await sel.start()
    const r0 = sel.view().sessionRevision
    sel.bumpSession()
    expect(sel.view().sessionRevision).toBe(r0 + 1)
  })
})

// ───────────────── 宽限期：防 chip 抖动 ─────────────────

describe('宽限期（本实现自加，蓝图未要求）', () => {
  it('@core:relay 单次探测失败不降级', async () => {
    const { sel, direct } = build()
    await sel.start()

    direct.state.up = false
    advance(500) // 半秒
    await sel.poll()
    // 仍在直连 —— 一次丢包就切通道的话，chip 会来回闪
    expect(sel.tier()).toBe('lan')

    // 又恢复了：清掉故障计时
    direct.state.up = true
    await sel.poll()
    expect(sel.tier()).toBe('lan')
  })

  it('@core:relay 间歇性失败不会累积到降级（恢复后重新计时）', async () => {
    const { sel, direct } = build()
    await sel.start()

    // 断 4 秒 → 通 → 再断 4 秒：总断 8 秒但从没连续满 5 秒
    direct.state.up = false
    advance(4_000)
    await sel.poll()
    expect(sel.tier()).toBe('lan')

    direct.state.up = true
    await sel.poll()

    direct.state.up = false
    advance(4_000)
    await sel.poll()
    // 关键：没有被「累计」拖下水
    expect(sel.tier()).toBe('lan')
  })

  it('@core:relay graceMs=0 时立即降级（用于证明宽限期真的起作用）', async () => {
    const { sel, direct } = build({ graceMs: 0 })
    await sel.start()
    direct.state.up = false
    await sel.poll()
    // 没有宽限期就立刻切 —— 这正是有宽限期版本要避免的行为
    expect(sel.tier()).toBe('relay')
  })
})

// ───────────────── 启动路径 ─────────────────

describe('启动选择', () => {
  it('@core:relay 直连可用时选直连（不套宽限期）', async () => {
    const { sel } = build()
    expect(await sel.start()).toBe('lan')
  })

  it('@core:relay 直连不可用时启动直接走中继（不等待 5 秒）', async () => {
    const { sel, direct } = build({ directUp: false })
    const t0 = clock
    expect(await sel.start()).toBe('relay')
    // 启动不该消耗时间
    expect(clock - t0).toBe(0)
    expect(direct.state.connects).toBe(0)
  })

  it('@core:relay 都不可用时退到推送，view.offline 仍为 false（push 是有效状态）', async () => {
    const { sel } = build({ directUp: false, relayUp: false })
    expect(await sel.start()).toBe('push')
    expect(sel.view().offline).toBe(false)
  })

  it('@core:relay 未 start 时 offline=true', () => {
    const { sel } = build()
    expect(sel.view().offline).toBe(true)
    expect(sel.chip()).toBe('未连接')
  })

  it('@core:relay 未连接时 view().tier 为 null（不能与「已退到推送」混淆）', () => {
    const { sel } = build()
    const v = sel.view()
    expect(v.tier).toBeNull()
    expect(v.chip).toBe('未连接')
    expect(v.offline).toBe(true)
    // 这条是审查时补的：初版返回 'push'，UI 会把「启动中」渲染成「仅推送」
    expect(v.tier).not.toBe('push')
  })

  it('@core:relay 退到推送后 tier 才是 push（与未连接区分开）', async () => {
    const { sel } = build({ directUp: false, relayUp: false })
    await sel.start()
    const v = sel.view()
    expect(v.tier).toBe('push')
    expect(v.chip).toBe('仅推送')
    expect(v.offline).toBe(false)
  })

  it('@core:relay 探测抛异常视为不可达，不会让整个流程崩溃', async () => {
    const { sel, direct } = build()
    await sel.start()
    direct.state.up = false
    direct.state.throwOnProbe = true
    advance(DEGRADE_WINDOW_MS)
    await sel.poll()
    expect(sel.tier()).toBe('relay')
  })

  it('@core:relay 连接抛异常不会让状态机卡死', async () => {
    const { sel, relay } = build({ directUp: false })
    relay.state.throwOnConnect = true
    await sel.start()
    // 连不上但状态已切到 relay，下一次 poll 会继续尝试
    expect(sel.tier()).toBe('relay')
  })
})

// ───────────────── 切换历史 ─────────────────

describe('切换历史可诊断', () => {
  it('@core:relay 每次切换都记录 from/to/reason/时间', async () => {
    const { sel, direct } = build()
    await sel.start() // null → lan
    direct.state.up = false
    advance(DEGRADE_WINDOW_MS)
    await sel.poll() // lan → relay

    const history = sel.switchHistory()
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ from: null, to: 'lan' })
    expect(history[1].from).toBe('lan')
    expect(history[1].to).toBe('relay')
    expect(history[1].reason).toContain('不可达')
  })

  it('@core:relay 没有切换时不产生冗余历史', async () => {
    const { sel } = build()
    await sel.start()
    await sel.poll()
    await sel.poll()
    expect(sel.switchHistory()).toHaveLength(1)
  })
})

// ───────────────── 中继只转发密文 ─────────────────

describe('中继只转发密文（蓝图原文的安全前提）', () => {
  it('@core:relay 可解析的明文 JSON 被判定为「不是密文」', () => {
    const plain = new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'event', body: { text: 'hello' } }))
    expect(looksLikeCiphertext(plain)).toBe(false)
  })

  it('@core:relay 随机二进制被判定为密文', () => {
    const bytes = new Uint8Array([0x8f, 0x2a, 0xc1, 0x00, 0xff, 0x7e])
    expect(looksLikeCiphertext(bytes)).toBe(true)
  })

  it('@core:relay 明文发往中继时 requireCiphertext 抛错（拦在发送之前）', () => {
    const plain = new TextEncoder().encode(JSON.stringify({ secret: 'user prompt' }))
    expect(() => requireCiphertext(plain)).toThrow(/密文/)
  })

  it('@core:relay 空字节数组不算密文（避免「空=安全」的误判）', () => {
    expect(looksLikeCiphertext(new Uint8Array([]))).toBe(false)
  })

  it('@core:relay base64 编码的明文也被拦下（编码不是加密）', () => {
    // 审查探针实测：把 JSON 套一层 base64，初版判定为「密文」——
    // 于是「中继只转发密文」被一个 base64 绕过。
    const plain = JSON.stringify({ text: '用户机密内容', path: 'C:/secret.docx' })
    const b64 = new TextEncoder().encode(Buffer.from(plain, 'utf8').toString('base64'))
    expect(looksLikeCiphertext(b64)).toBe(false)
    expect(() => requireCiphertext(b64)).toThrow(/密文/)
  })

  it('@core:relay 十六进制编码的明文也被拦下', () => {
    const plain = JSON.stringify({ secret: 'hex-encoded' })
    const hex = new TextEncoder().encode(Buffer.from(plain, 'utf8').toString('hex'))
    expect(looksLikeCiphertext(hex)).toBe(false)
  })

  it('@core:relay 真随机字节仍然判为密文（不能把正常密文也拦了）', () => {
    // 高熵二进制：既不是 UTF-8 文本，也不是 base64/hex 可解码的 JSON
    const random = new Uint8Array(64)
    for (let i = 0; i < random.length; i++) random[i] = (i * 137 + 91) % 256
    random[0] = 0x9f // 保证不是 '{'
    expect(looksLikeCiphertext(random)).toBe(true)
  })

  it('@core:relay envelopeMeta 不含 body（推送/中继不该看到内容）', () => {
    const alloc = new SeqAllocator()
    const e = makeEnvelope(alloc, 'event', { runId: 'run_1', sessionId: 'ses_1', at: 1_700_000_000_000 }, {
      text: '这是用户输入的机密内容',
      filePath: 'C:/Users/me/secret.docx'
    })
    const meta = envelopeMeta(e)
    expect(Object.keys(meta).sort()).toEqual(['at', 'kind', 'seq', 'sessionId', 'v'])
    const serialized = JSON.stringify(meta)
    expect(serialized).not.toContain('机密内容')
    expect(serialized).not.toContain('secret.docx')
  })
})