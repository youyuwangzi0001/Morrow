import { describe, expect, it } from 'vitest'
import {
  PAIR_REQUEST_PREFIX,
  PAIR_TTL_MS,
  PAIR_WARN_SECONDS,
  deviceLabel,
  deviceListPhase,
  formatPairedAt,
  isP256Point,
  pairPanelView,
  parsePairRequest,
  revokeConfirmText
} from '../../src/shared/pair-panel'
import type { PairDeviceView, PairIssueResult } from '../../src/shared/types'

/**
 * 「手机配对」面板的视图逻辑（E2d）。
 *
 * ## 为什么要单独测这一段
 *
 * 三条最重要的行为都跟**时间**有关，而时间在组件里只能靠「等 90 秒、肉眼看」：
 * 1. 过期后必须换掉文本（继续显示旧码 = 用户拿一张废票去扫）；
 * 2. 剩 15 秒要变红（用户还在打字）；
 * 3. 重新生成后倒计时从新的 exp 重算。
 *
 * 抽成纯函数后，这些都能用固定 `now` 断言。
 *
 * ## 渲染组件本身没有自动化测试
 *
 * 仓库没有 jsdom / @testing-library（`vitest.config.ts` 的 environment 是 node），
 * 加它们会引入一批新依赖。所以本卡的覆盖边界是：
 * **视图状态 100% 有断言，DOM 渲染靠类型检查 + 手工核对**。
 * 这个边界在报告里如实写着，不拿这 24 项去声称「界面已验证」。
 */

const NOW = 1_700_000_000_000

function ticket(overrides: Partial<PairIssueResult> = {}): PairIssueResult {
  return {
    qr: 'eyJkZXZpY2VJZCI6ImQifQ',
    code: '123456',
    expiresAt: NOW + PAIR_TTL_MS,
    nonce: 'abc',
    hasFingerprint: true,
    ...overrides
  }
}

describe('票据面板：三种阶段', () => {
  it('@core:relay 没有票据时是 idle，不是 expired（两者用户的下一步不同）', () => {
    const v = pairPanelView(null, NOW)
    expect(v.phase).toBe('idle')
    expect(v.remainingSeconds).toBe(0)
    expect(v.remainingRatio).toBe(0)
    expect(v.urgent).toBe(false)
    // idle 不该弹「已过期」的提示
    expect(v.hint).toBe('')
  })

  it('@core:relay 刚签发的票据是 live，剩余 90 秒', () => {
    const v = pairPanelView(ticket(), NOW)
    expect(v.phase).toBe('live')
    expect(v.remainingSeconds).toBe(90)
    expect(v.remainingRatio).toBeCloseTo(1, 5)
    expect(v.urgent).toBe(false)
  })

  it('@core:relay 90 秒后变成 expired，且倒计时为 0（不能出现负数）', () => {
    const v = pairPanelView(ticket(), NOW + PAIR_TTL_MS)
    expect(v.phase).toBe('expired')
    expect(v.remainingSeconds).toBe(0)
    expect(v.remainingRatio).toBe(0)
    expect(v.urgent).toBe(false) // 已过期就不该再催「快没时间了」
    // 过期文案要说清下一步：重新生成
    expect(v.hint).toContain('重新生成')
  })

  it('@core:relay 超出 10 秒也仍然钳在 0（不是 -10）', () => {
    const v = pairPanelView(ticket(), NOW + PAIR_TTL_MS + 10_000)
    expect(v.remainingSeconds).toBe(0)
    expect(v.remainingRatio).toBe(0)
  })

  it('@core:relay 剩 15 秒进入 urgent，16 秒还不进（边界取哪一边都要有理由）', () => {
    // 取「含 15」：用户看到 15 这个数字时就已经在警戒范围内，
    // 若取「小于 15」则 15 会显示成普通色，与 16 没有区别。
    expect(pairPanelView(ticket(), NOW + PAIR_TTL_MS - PAIR_WARN_SECONDS * 1000).urgent).toBe(true)
    expect(pairPanelView(ticket(), NOW + PAIR_TTL_MS - (PAIR_WARN_SECONDS + 1) * 1000).urgent).toBe(false)
  })

  it('@core:relay 剩余秒数向上取整（剩 0.4 秒时显示 1 而不是 0）', () => {
    // 显示 0 秒但票据仍可用，会让用户以为已经过期而放弃
    const v = pairPanelView(ticket(), NOW + PAIR_TTL_MS - 400)
    expect(v.phase).toBe('live')
    expect(v.remainingSeconds).toBe(1)
  })
})

describe('票据面板：指纹缺失', () => {
  it('@core:relay 有指纹时不提示', () => {
    const v = pairPanelView(ticket({ hasFingerprint: true }), NOW)
    expect(v.fingerprintMissing).toBe(false)
    expect(v.hint).toBe('')
  })

  it('@core:relay 缺指纹时给出原因与下一步，而不是只说「出错了」', () => {
    const v = pairPanelView(ticket({ hasFingerprint: false }), NOW)
    expect(v.fingerprintMissing).toBe(true)
    // 必须说清后果（手机会拒绝）+ 下一步（重新生成）
    expect(v.hint).toContain('拒绝')
    expect(v.hint).toContain('重新生成')
  })

  it('@core:relay 缺指纹且已过期时，优先说过期（此时「重新生成」已经是唯一动作）', () => {
    const v = pairPanelView(ticket({ hasFingerprint: false }), NOW + PAIR_TTL_MS)
    expect(v.phase).toBe('expired')
    expect(v.hint).toContain('重新生成')
    // 过期文案不重复指纹缺失的原因：两个问题同时报会让用户不知道先做什么
    expect(v.hint).not.toContain('证书指纹')
  })

  it('@core:relay PAIR_TTL_MS 与桌面协议常量一致（界面不写死 90）', () => {
    expect(PAIR_TTL_MS).toBe(90_000)
  })
})

describe('设备列表：四种状态必须分开', () => {
  const devices: PairDeviceView[] = [{ deviceId: 'd1', pairedAt: NOW, name: '我的手机' }]

  it('@core:relay 读取中显示 loading，不能显示「还没有配对的手机」', () => {
    // 读的过程中说「空」会让用户以为设备被清掉了 —— C1 那条教训：
    // 0 和「不知道」含义不同。
    expect(deviceListPhase({ loading: true, error: null, devices: [] })).toBe('loading')
  })

  it('@core:relay 出错时显示 error，优先于空列表', () => {
    expect(deviceListPhase({ loading: false, error: '读不到', devices: [] })).toBe('error')
  })

  it('@core:relay 读到空数组才是 empty', () => {
    expect(deviceListPhase({ loading: false, error: null, devices: [] })).toBe('empty')
  })

  it('@core:relay 有设备时是 ready', () => {
    expect(deviceListPhase({ loading: false, error: null, devices })).toBe('ready')
  })

  it('@core:relay loading 优先于已有数据（重新读取时不该突然变空）', () => {
    expect(deviceListPhase({ loading: true, error: null, devices })).toBe('loading')
  })
})

describe('设备展示', () => {
  it('@core:relay 有名字用名字，没名字用 deviceId（不留空白）', () => {
    expect(deviceLabel({ deviceId: 'd1', pairedAt: NOW, name: '工作台' })).toBe('工作台')
    expect(deviceLabel({ deviceId: 'd1', pairedAt: NOW })).toBe('d1')
    // 纯空格的名字等于没名字
    expect(deviceLabel({ deviceId: 'd1', pairedAt: NOW, name: '   ' })).toBe('d1')
  })

  it('@core:relay 配对时间格式化：补零到两位', () => {
    // 用本地时区构造，避免测试机时区不同导致断言漂移
    const t = new Date(2026, 2, 5, 9, 7, 0).getTime() // 2026-03-05 09:07
    expect(formatPairedAt(t)).toBe('2026-03-05 09:07')
  })

  it('@core:relay 时间异常时给占位符而不是抛异常', () => {
    expect(formatPairedAt(0)).toBe('时间未知')
    expect(formatPairedAt(Number.NaN)).toBe('时间未知')
    expect(formatPairedAt(-1)).toBe('时间未知')
  })

  it('@core:relay 撤销确认要说清「立刻生效」，不能只问「确定吗」', () => {
    const text = revokeConfirmText({ deviceId: 'd1', pairedAt: NOW, name: '我的手机' })
    expect(text).toContain('我的手机')
    expect(text).toContain('立刻')
    expect(text).toContain('重新配对')
  })
})

describe('配对请求解析', () => {
  // 必须是**真实在曲线上的** P-256 公钥：加了曲线校验后，
  // 「长度对、前缀对但点位不在曲线上」会被正确拒绝（见下面那条测试）。
  const makeRealPub = (): string => {
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    return ecdh.getPublicKey().toString('base64')
  }
  const validPub = makeRealPub()
  const requestFor = (obj: Record<string, unknown>) =>
    PAIR_REQUEST_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')

  it('@core:relay 解析手机复制出来的标准请求', () => {
    const r = parsePairRequest(requestFor({ deviceId: 'phone-1', pubKey: validPub }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.pubKey).toBe(validPub)
      expect(r.deviceId).toBe('phone-1')
    }
  })

  it('@core:relay 请求里没有 deviceId 时返回 null（由桌面生成一个）', () => {
    const r = parsePairRequest(requestFor({ pubKey: validPub }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.deviceId).toBeNull()
  })

  it('@core:relay 也接受裸公钥（用户只复制了公钥）', () => {
    const r = parsePairRequest(validPub)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.pubKey).toBe(validPub)
      expect(r.deviceId).toBeNull()
    }
  })

  it('@core:relay 粘了配对码 → 明确指出方向反了（这是最常见的误操作）', () => {
    // 配对码也以 eyJ 开头（base64url 的 {"），两者看起来很像
    const r = parsePairRequest('eyJkZXZpY2VJZCI6ImQifQ')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('配对码')
      expect(r.reason).toContain('方向反了')
    }
  })

  it('@core:relay 空输入给出可执行提示', () => {
    const r = parsePairRequest('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('粘贴')
  })

  it('@core:relay 前缀对但内容不是 base64 → 报「复制不完整」而不是「格式错误」', () => {
    const r = parsePairRequest(PAIR_REQUEST_PREFIX + '!!!not-base64!!!')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('复制')
  })

  it('@core:relay 前缀对但 JSON 坏了 → 同样指向复制问题', () => {
    const r = parsePairRequest(PAIR_REQUEST_PREFIX + Buffer.from('{oops', 'utf8').toString('base64url'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('复制')
  })

  it('@core:relay JSON 是数组或标量 → 拒绝，不把奇怪结构当请求', () => {
    for (const bad of ['[]', '123', '"str"', 'null']) {
      const r = parsePairRequest(PAIR_REQUEST_PREFIX + Buffer.from(bad, 'utf8').toString('base64url'))
      expect(r.ok).toBe(false)
    }
  })

  it('@core:relay 公钥长度不对（64 或 66 字节）→ 拒绝', () => {
    for (const len of [64, 66]) {
      const pub = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(len - 1, 0x22)]).toString('base64')
      const r = parsePairRequest(requestFor({ pubKey: pub }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('公钥')
    }
  })

  it('@core:relay 公钥首字节不是 0x04（压缩点或垃圾） → 拒绝', () => {
    const pub = Buffer.alloc(65, 0x33).toString('base64')
    const r = parsePairRequest(requestFor({ pubKey: pub }))
    expect(r.ok).toBe(false)
  })

  it('@core:relay 长度与前缀都对、但点位不在 P-256 曲线上 → 拒绝并说清原因', () => {
    // 这条是**真渲染截图抓到的**：人工造的「65 字节、04 开头」公钥
    // 一路走到桌面 `computeSecret`，抛出英文
    // `Public key is not valid for specified curve` —— 用户看到一句
    // 看不懂的话，而且他已经点过「生成配对码」了。
    const notOnCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]).toString('base64')
    const r = parsePairRequest(requestFor({ pubKey: notOnCurve }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('P-256')
      expect(r.reason).toContain('重新')
      // 不能把英文原文漏给用户
      expect(r.reason).not.toContain('curve')
    }
  })

  it('@core:relay 真实 P-256 公钥能通过曲线校验', () => {
    // 反向确认校验不是「一律拒绝」：拿一把真钥匙的公钥。
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const pub = ecdh.getPublicKey().toString('base64')
    const r = parsePairRequest(requestFor({ pubKey: pub }))
    expect(r.ok).toBe(true)
  })

  it('@core:relay 曲线点校验：x/y 超出模数、以及仅差一位的坐标都必须被拒', () => {
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const good = ecdh.getPublicKey() // 65 字节
    expect(isP256Point(good)).toBe(true)

    // 改最后一位 → 几乎必然不在曲线上（y 变了，y² 随之变）
    const tweaked = Buffer.from(good)
    tweaked[64] = tweaked[64]! ^ 0x01
    expect(isP256Point(tweaked)).toBe(false)

    // 全 0xff 的坐标必然 >= p
    const tooBig = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xff)])
    expect(isP256Point(tooBig)).toBe(false)

    // 长度不对直接拒（不是抛）
    expect(isP256Point(Buffer.alloc(64, 0x04))).toBe(false)
    expect(isP256Point(Buffer.alloc(0))).toBe(false)
  })

  it('@core:relay pubKey 不是字符串 → 拒绝（不是「转成字符串再用」）', () => {
    const r = parsePairRequest(requestFor({ pubKey: 12345 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('公钥')
  })

  it('@core:relay URL-safe 与标准 base64 的公钥都能解（手机可能与桌面用不同字母表）', () => {
    // 用真实公钥，并**反复生成直到 base64 里出现 + 或 /**，
    // 这样才真的测到「两种字母表都能解」——手造字节的话点位不在曲线上，
    // 会被曲线校验正确拒绝，测不到字母表分支。
    const crypto = require('node:crypto') as typeof import('node:crypto')
    let std = ''
    for (let i = 0; i < 200; i++) {
      const ecdh = crypto.createECDH('prime256v1')
      ecdh.generateKeys()
      const candidate = ecdh.getPublicKey().toString('base64')
      if (/[+/]/.test(candidate)) {
        std = candidate
        break
      }
    }
    expect(std, '200 次都没抽到含 +/ 的公钥，样本异常').not.toBe('')
    const urlsafe = std.replace(/\+/g, '-').replace(/\//g, '_')
    for (const pub of [std, urlsafe]) {
      const r = parsePairRequest(requestFor({ pubKey: pub }))
      expect(r.ok, `应接受 ${pub.slice(0, 12)}…`).toBe(true)
    }
  })
})
