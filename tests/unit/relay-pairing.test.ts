import { createECDH, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CODE_ATTEMPTS_EXCEEDED,
  CODE_MISMATCH,
  DEVICE_REVOKED,
  MAX_CODE_ATTEMPTS,
  PairingError,
  PairingService,
  TICKET_EXPIRED,
  TICKET_INVALID,
  TICKET_TTL_MS,
  TICKET_USED,
  derivePairingCode
} from '../../src/relay/pairing'

/**
 * B2 卡验收：配对与密钥协商。
 *
 * 蓝图验收原文四条：
 * 1. 票据过期后扫码返回 TICKET_EXPIRED；
 * 2. 六位码不符时拒绝且记录尝试；
 * 3. 配对后票据立即作废（重放失败）；
 * 4. 桌面撤销设备后手机在 1 次请求内收到 DEVICE_REVOKED。
 *
 * 另加两条蓝图 §5 协议隐含但必须验证的：
 * 5. 票据里不含任何密钥（只承载 deviceId / pubKey / nonce / exp / relayHint）；
 * 6. 中间人换公钥会被六位码比对抓出来（这才是六位码存在的理由）。
 */

/** 造一个手机侧的 ECDH 密钥对，模拟真实客户端 */
function phoneKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    pub: ecdh.getPublicKey().toString('base64'),
    // 手机侧算共享秘密：用自己的私钥 + 桌面公钥
    secretWith: (desktopPub: string) => ecdh.computeSecret(Buffer.from(desktopPub, 'base64'))
  }
}

// 每个用例都通过 makeService() 重置为一个固定基准时刻；
// 不要再用 beforeEach 重置 clock，否则两处初始化互相覆盖，
// 会出现「票据已经过期但测试以为还没到」这种自伤的假失败。
let clock = 1_000_000
function makeService() {
  clock = 1_000_000
  return new PairingService({ secret: randomBytes(32), now: () => clock })
}

describe('验收 1：票据过期返回 TICKET_EXPIRED', () => {
  it('@core:relay 90 秒内有效，超过后过期', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)

    // 89 秒：还有效（从签发时刻起算，不是从 clock 初值起算）
    clock += TICKET_TTL_MS - 1_000
    expect(() => svc.verifyEcho(ticket.nonce)).not.toThrow()

    // 再 +2 秒（共 91 秒）：过期。
    // 注意这里只调用一次并直接断言错误码：
    // 过期分支会顺手删除票据（避免内存驻留），所以第二次调用只会拿到
    // TICKET_INVALID —— 那是测试自己在重复调用，不是代码行为。
    clock += 2_000
    try {
      svc.verifyEcho(ticket.nonce)
      throw new Error('应当过期被拒')
    } catch (err) {
      expect((err as PairingError).code).toBe(TICKET_EXPIRED)
    }
  })

  it('@core:relay 过期边界：恰好等于 exp 时仍有效（未超过）', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    clock += TICKET_TTL_MS
    expect(() => svc.verifyEcho(ticket.nonce)).not.toThrow()
  })

  it('@core:relay 过期票据也被清理，不长期驻留内存', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    clock += TICKET_TTL_MS + 1
    expect(() => svc.verifyEcho(ticket.nonce)).toThrow()
    expect(svc.liveTicketCount()).toBe(0)
  })
})

describe('验收 2：六位码不符时拒绝且记录尝试', () => {
  it('@core:relay 错误码被拒绝，且是 CODE_MISMATCH', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
    const wrong = code === '000000' ? '111111' : '000000'

    try {
      svc.confirmCode(ticket.nonce, wrong)
      throw new Error('应当拒绝')
    } catch (err) {
      expect((err as PairingError).code).toBe(CODE_MISMATCH)
      // 错误信息里要带第几次，便于审计与用户理解
      expect((err as Error).message).toMatch(/第 1 次/)
    }
  })

  it('@core:relay 错满 5 次后票据作废，之后的正确码也不再接受', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
    const wrong = code === '000000' ? '111111' : '000000'

    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      expect(() => svc.confirmCode(ticket.nonce, wrong)).toThrowError(PairingError)
    }
    // 第 MAX 次：达到上限，报 CODE_ATTEMPTS_EXCEEDED
    try {
      svc.confirmCode(ticket.nonce, wrong)
      throw new Error('应当拒绝')
    } catch (err) {
      expect((err as PairingError).code).toBe(CODE_ATTEMPTS_EXCEEDED)
    }

    // 票据已作废：记录仍保留（可取证），但任何码都用不了
    expect(svc.liveTicketCount()).toBe(1)
    try {
      svc.confirmCode(ticket.nonce, code)
      throw new Error('应当拒绝')
    } catch (err) {
      // 因为爆破而作废的票据，报 USED 而不是 INVALID：
      // 保留「这张票被人试过」的事实，审计时能区分于「从未存在的票」
      expect((err as PairingError).code).toBe(TICKET_USED)
    }
  })

  it('@core:relay 正确码可以确认通过', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
    const r = svc.confirmCode(ticket.nonce, code)
    expect(r.deviceId).toBe('dev-1')
  })

  it('@core:relay 错误码不会消耗票据（用户可重试，直到上限）', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket, code } = svc.issueTicket('dev-1', phone.pub)
    const wrong = code === '000000' ? '111111' : '000000'

    expect(() => svc.confirmCode(ticket.nonce, wrong)).toThrow()
    expect(svc.liveTicketCount()).toBe(1) // 仍存在
    expect(() => svc.confirmCode(ticket.nonce, code)).not.toThrow()
  })
})

describe('验收 3：配对后票据立即作废（重放失败）', () => {
  it('@core:relay 配对成功后再用同一票据 → TICKET_USED', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)

    const dev = svc.completePairing(ticket.nonce, phone.pub)
    expect(dev.deviceId).toBe('dev-1')
    expect(dev.sessionKey).toBeTruthy()

    try {
      svc.completePairing(ticket.nonce, phone.pub)
      throw new Error('应当拒绝重放')
    } catch (err) {
      expect((err as PairingError).code).toBe(TICKET_USED)
    }
  })

  it('@core:relay 重放被报为 TICKET_USED 而不是 EXPIRED（区分攻击与超时）', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    svc.completePairing(ticket.nonce, phone.pub)

    // 即使时间过去很久，也应该是 USED —— 这是攻击特征，不该伪装成超时
    clock += TICKET_TTL_MS * 10
    try {
      svc.verifyEcho(ticket.nonce)
      throw new Error('应当拒绝')
    } catch (err) {
      expect((err as PairingError).code).toBe(TICKET_USED)
    }
  })

  it('@core:relay 票据作废后，另一台设备不能拿它配对', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const attacker = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    svc.completePairing(ticket.nonce, phone.pub)

    expect(() => svc.completePairing(ticket.nonce, attacker.pub)).toThrowError(PairingError)
  })
})

describe('验收 4：撤销设备后 1 次请求内收到 DEVICE_REVOKED', () => {
  it('@core:relay 撤销后下一次判定立即失效（不缓存）', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    svc.completePairing(ticket.nonce, phone.pub)

    // 撤销前可用
    expect(() => svc.requirePaired('dev-1')).not.toThrow()
    expect(svc.listDevices()).toHaveLength(1)

    svc.revokeDevice('dev-1')

    // 撤销后**第一次**调用就要失败
    try {
      svc.requirePaired('dev-1')
      throw new Error('应当拒绝')
    } catch (err) {
      expect((err as PairingError).code).toBe(DEVICE_REVOKED)
    }
    expect(svc.listDevices()).toHaveLength(0)
  })

  it('@core:relay 撤销不存在的设备返回 false，不抛异常', () => {
    const svc = makeService()
    expect(svc.revokeDevice('nope')).toBe(false)
  })

  it('@core:relay 撤销只影响目标设备，其他设备照常可用', () => {
    const svc = makeService()
    const a = phoneKeys()
    const b = phoneKeys()
    const ta = svc.issueTicket('dev-a', a.pub)
    const tb = svc.issueTicket('dev-b', b.pub)
    svc.completePairing(ta.ticket.nonce, a.pub)
    svc.completePairing(tb.ticket.nonce, b.pub)

    svc.revokeDevice('dev-a')
    expect(() => svc.requirePaired('dev-a')).toThrow()
    expect(() => svc.requirePaired('dev-b')).not.toThrow()
  })
})

describe('协议前提：票据不承载密钥', () => {
  it('@core:relay 票据字段只有蓝图规定的那几个，没有密钥字段', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub, 'wss://relay.example')
    const keys = Object.keys(ticket).sort()
    // desktopPub 是桌面公钥（公钥不是秘密），手机必须拿到它才能算 ECDH。
    expect(keys).toEqual(['desktopPub', 'deviceId', 'exp', 'nonce', 'pubKey', 'relayHint'])
    // 显式断言：没有任何名字里带 secret/session/private 的字段
    // （pubKey / desktopPub 都是公钥，可以进二维码）
    const forbidden = keys.filter((k) => /session|secret|private/i.test(k))
    expect(forbidden).toEqual([])
  })

  it('@core:relay 二维码解析回的票据里没有会话密钥', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { qr } = svc.issueTicket('dev-1', phone.pub)
    const parsed = PairingService.parseTicket(qr)
    expect(JSON.stringify(parsed)).not.toMatch(/session|secret|private/i)
    expect(parsed.deviceId).toBe('dev-1')
  })

  it('@core:relay 非法二维码内容报 TICKET_INVALID', () => {
    expect(() => PairingService.parseTicket('not-a-ticket!!')).toThrowError(PairingError)
    try {
      PairingService.parseTicket('e30') // base64url of "{}"
    } catch (err) {
      expect((err as PairingError).code).toBe(TICKET_INVALID)
    }
  })
})

describe('协议前提：手机只靠二维码就能算出 sessionKey', () => {
  it('@core:relay 票据里的 desktopPub 就是桌面长期公钥', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { qr } = svc.issueTicket('dev-1', phone.pub)
    // 只从二维码解析，不碰 svc 对象 —— 模拟「手机扫完码之后没有任何别的信息」
    const parsed = PairingService.parseTicket(qr)
    expect(parsed.desktopPub).toBe(svc.desktopPublicKey())
  })

  it('@core:relay 仅用二维码内容即可算出与桌面一致的 sessionKey', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { qr } = svc.issueTicket('dev-1', phone.pub)

    // 手机侧的全部输入：二维码 + 自己的私钥。没有任何 svc 内部状态。
    const parsed = PairingService.parseTicket(qr)
    const phoneSessionKey = phone.secretWith(parsed.desktopPub).toString('base64')

    // 桌面侧走完整流程，产出它认为的 sessionKey
    const device = svc.completePairing(parsed.nonce, phone.pub)

    // 两端必须完全相同 —— 这是「扫完码即可离线算出密钥」的全部含义
    expect(device.sessionKey).toBe(phoneSessionKey)
  })
})

describe('协议前提：六位码能抓出中间人换公钥', () => {
  it('@core:relay 手机与桌面独立算出的六位码一致', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket, code } = svc.issueTicket('dev-1', phone.pub)

    // 手机侧：用自己的私钥 + 桌面公钥，算同一个共享秘密
    const shared = phone.secretWith(svc.desktopPublicKey())
    const phoneCode = derivePairingCode(shared, ticket.nonce)

    expect(phoneCode).toBe(code)
    expect(phoneCode).toMatch(/^\d{6}$/)
  })

  it('@core:relay 公钥被替换后两端六位码不同（这正是六位码的价值）', () => {
    const svc = makeService()
    const realPhone = phoneKeys()
    const mitm = phoneKeys()

    // 桌面以为在和 realPhone 配对
    const { ticket, code } = svc.issueTicket('dev-1', realPhone.pub)

    // 中间人用自己的私钥 + 桌面公钥算，得到不同的码
    const mitmCode = derivePairingCode(mitm.secretWith(svc.desktopPublicKey()), ticket.nonce)
    expect(mitmCode).not.toBe(code)

    // 真正的手机会算出正确码
    const realCode = derivePairingCode(realPhone.secretWith(svc.desktopPublicKey()), ticket.nonce)
    expect(realCode).toBe(code)
  })

  it('@core:relay 六位码是 6 位数字（含前导零情况）', () => {
    const svc = makeService()
    // 跑多次覆盖前导零
    for (let i = 0; i < 20; i++) {
      const phone = phoneKeys()
      const { code } = svc.issueTicket(`dev-${i}`, phone.pub)
      expect(code).toHaveLength(6)
      expect(/^\d{6}$/.test(code)).toBe(true)
    }
  })
})

describe('边界与健壮性', () => {
  it('@core:relay 配对时公钥与票据不一致会被拒绝', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const other = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)

    try {
      svc.completePairing(ticket.nonce, other.pub)
      throw new Error('应当拒绝')
    } catch (err) {
      expect((err as PairingError).code).toBe(TICKET_INVALID)
    }
  })

  it('@core:relay 不存在的 nonce 报 TICKET_INVALID', () => {
    const svc = makeService()
    try {
      svc.verifyEcho('deadbeef')
      throw new Error('应当拒绝')
    } catch (err) {
      expect((err as PairingError).code).toBe(TICKET_INVALID)
    }
  })

  it('@core:relay 空 deviceId 或空公钥不能签发票据', () => {
    const svc = makeService()
    const phone = phoneKeys()
    expect(() => svc.issueTicket('', phone.pub)).toThrowError(PairingError)
    expect(() => svc.issueTicket('dev-1', '')).toThrowError(PairingError)
  })

  it('@core:relay HMAC 密钥太短时构造失败（防止弱密钥）', () => {
    expect(() => new PairingService({ secret: Buffer.from('short') })).toThrow(/至少 16 字节/)
  })

  it('@core:relay 每次签发的 nonce 都不同', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      seen.add(svc.issueTicket('dev-1', phone.pub).ticket.nonce)
    }
    expect(seen.size).toBe(50)
  })

  it('@core:relay 设备列表不返回 sessionKey（设置页只需要展示信息）', () => {
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    svc.completePairing(ticket.nonce, phone.pub, '我的手机')

    const list = svc.listDevices()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('我的手机')
    expect(JSON.stringify(list)).not.toMatch(/sessionKey/)
  })
})

describe('协议前提：票据携带桌面证书指纹（手机据此做证书固定）', () => {
  /**
   * 为什么这一节必须存在。
   *
   * 手机会用 WSS 连桌面，而桌面用的是自签证书 —— 自签没有可信链，
   * 链验证必然失败，唯一正确的机制是**证书固定**（比对 sha256 指纹）。
   * 指纹从哪来？只能从配对票据里拿。
   *
   * 票据不带指纹时，手机侧只能二选一：存一份没指纹的凭据（重启后读不回来，
   * 或者更坏 —— 关掉证书校验），或者明确拒绝完成配对。我们选了后者，
   * 而这就要求桌面**必须**在票据里带上它，否则配对在真机上永远走不完。
   */

  it('@core:relay 注入指纹后，签发的票据带上它', () => {
    const phone = phoneKeys()
    const svc = new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      tlsFingerprint: 'jSXRwabmzzyRS0VAS3y7gzGLePV_oq_06sKR1WuFFB8'
    })
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    expect(ticket.fingerprint).toBe('jSXRwabmzzyRS0VAS3y7gzGLePV_oq_06sKR1WuFFB8')
  })

  it('@core:relay 没有指纹时不编造值，字段直接不出现', () => {
    // 「不出现」和「空串」是两件事：空串会被 parseTicket 当成合法字符串，
    // 手机侧拿到空串做比对永远失败，报错是「指纹不匹配」而不是「票据缺指纹」。
    const svc = makeService()
    const phone = phoneKeys()
    const { ticket } = svc.issueTicket('dev-1', phone.pub)
    expect(ticket.fingerprint).toBeUndefined()
    expect('fingerprint' in ticket).toBe(false)
  })

  it('@core:relay setTlsFingerprint 可在运行中补上（证书载入晚于服务构造）', () => {
    // 生产时序：PairingService 先构造，startLanStack 里才 loadOrCreateTls。
    // 所以必须支持后注入，而不是只能在构造时给。
    const svc = makeService()
    const phone = phoneKeys()
    expect(svc.hasTlsFingerprint()).toBe(false)
    expect(svc.issueTicket('dev-1', phone.pub).ticket.fingerprint).toBeUndefined()

    svc.setTlsFingerprint('FINGERPRINT_A')
    expect(svc.hasTlsFingerprint()).toBe(true)
    expect(svc.issueTicket('dev-1', phone.pub).ticket.fingerprint).toBe('FINGERPRINT_A')
  })

  it('@core:relay 传 null 或空串等于清掉（局域网起不来时的降级路径）', () => {
    const svc = makeService()
    svc.setTlsFingerprint('FINGERPRINT_A')
    svc.setTlsFingerprint(null)
    expect(svc.hasTlsFingerprint()).toBe(false)
    expect(svc.issueTicket('dev-1', phoneKeys().pub).ticket.fingerprint).toBeUndefined()

    svc.setTlsFingerprint('FINGERPRINT_B')
    svc.setTlsFingerprint('')
    expect(svc.hasTlsFingerprint()).toBe(false)
  })

  it('@core:relay 指纹进入 qr（手机只拿得到 qr，拿不到 ticket 对象）', () => {
    // 这条最容易被忽略：桌面内部 `ticket.fingerprint` 有值，
    // 但 qr 是由 `JSON.stringify(ticket)` 生成的 —— 如果哪天有人改成
    // 手挑字段拼 qr，内部有值而 qr 里没有，手机永远拿不到。
    const svc = new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      tlsFingerprint: 'QR_FINGERPRINT_TEST'
    })
    const { qr, ticket } = svc.issueTicket('dev-1', phoneKeys().pub)
    const round = PairingService.parseTicket(qr)
    expect(round.fingerprint).toBe('QR_FINGERPRINT_TEST')
    expect(round.fingerprint).toBe(ticket.fingerprint)
  })

  it('@core:relay parseTicket 接受不带指纹的旧票据（向后兼容）', () => {
    const phone = phoneKeys()
    const svc = makeService()
    const { qr } = svc.issueTicket('dev-1', phone.pub)
    expect(() => PairingService.parseTicket(qr)).not.toThrow()
  })

  it('@core:relay fingerprint 存在但类型不对时拒绝（不能当字符串 "123" 塞进去）', () => {
    // 不校验类型的话，手机侧会拿 "123" 去比对，报「指纹不匹配」——
    // 而真实原因是票据畸形。错误码与真实原因不符，排查时会走错方向。
    const bad = Buffer.from(
      JSON.stringify({
        deviceId: 'd',
        pubKey: 'p',
        desktopPub: 'dp',
        nonce: 'n',
        exp: 1,
        fingerprint: 123
      }),
      'utf8'
    ).toString('base64url')
    expect(() => PairingService.parseTicket(bad)).toThrowError(PairingError)
  })

  it('@core:relay 指纹里不带任何私钥材料（它是公开值，但仍要守住这条线）', () => {
    // 证书指纹是 sha256，公开无害。这条防的是「顺手把 certPem 或 key 也塞进票据」。
    const svc = new PairingService({
      secret: randomBytes(32),
      now: () => clock,
      tlsFingerprint: 'PUBLIC_FP'
    })
    const { qr } = svc.issueTicket('dev-1', phoneKeys().pub)
    const raw = Buffer.from(qr, 'base64url').toString('utf8')
    expect(raw).not.toMatch(/PRIVATE KEY|sessionKey|BEGIN CERTIFICATE/)
  })
})
